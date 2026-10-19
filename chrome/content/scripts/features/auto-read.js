// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 入库自动精读（0.23.0，路线图阶段 2）
 * 把「手动点 AI 总结」变成「文献入库即自动精读」：新条目入库 → 延迟落定 →
 * 串行生成结构化总结笔记 → 打上 #AI精读 标记。
 *
 * 三道闸门（缺一不可，这是自动化最容易被骂的地方）：
 *  1. **默认关闭**：`autoReadEnabled` 默认 false，且提供「仅限指定分类」白名单；
 *  2. **每日上限**：`autoReadDailyCap`（默认 10），超限后本轮直接跳过并明确告知，
 *     不会偷偷继续烧用户的 token；
 *  3. **幂等**：已有 #AI精读 标记或已存在 AI 总结笔记的条目不再重复精读。
 *
 * AI 未就绪时不做静默失败：记录原因，并在首条被跳过时给一次明确提示
 * （与 0.21.0「AI 未就绪不得静默」的纪律一致）。
 */
/* global Zotero, Services, Prefs, I18n, ItemSel, AIClient, AIChat */

var AutoRead = {
  queue: [],
  _running: false,
  _notifierID: null,
  _pending: new Set(),
  _timer: null,
  _warned: false,

  /* ================== 闸门（纯逻辑，可单测） ================== */

  today() { return new Date().toISOString().slice(0, 10); },

  todayCount() {
    const raw = String(Prefs.get("autoReadDailyCount", "") || "");
    const [d, n] = raw.split(":");
    return d === this.today() ? Number(n) || 0 : 0;
  },

  bump() {
    Prefs.set("autoReadDailyCount", this.today() + ":" + (this.todayCount() + 1));
  },

  dailyCap() {
    const n = Number(Prefs.get("autoReadDailyCap", 10));
    return isNaN(n) || n <= 0 ? 10 : n;
  },

  /** 剩余额度 */
  remaining() { return Math.max(0, this.dailyCap() - this.todayCount()); },

  /** 是否允许处理：{ok, reason} */
  canRun() {
    const zh = I18n.isZh;
    if (!Prefs.get("autoReadEnabled", false)) {
      return { ok: false, reason: zh ? "入库自动精读未开启（设置 → Papilot）" : "Auto-read is off" };
    }
    if (typeof AIClient === "undefined" || !AIClient.hasKey()) {
      const why = (AIClient && AIClient.guidance) ? AIClient.guidance() : "";
      return { ok: false, reason: (zh ? "AI 不可用：" : "AI unavailable: ") + why };
    }
    if (this.remaining() <= 0) {
      return { ok: false, reason: (zh ? "今日自动精读已达上限 " : "Daily cap reached ") + this.dailyCap() };
    }
    return { ok: true, reason: "" };
  },

  /** 分类白名单：未设置则全库 */
  inScope(item) {
    const cid = String(Prefs.get("autoReadCollection", "") || "");
    if (!cid) return true;
    try { return (item.getCollections() || []).map(String).includes(String(cid)); } catch (e) { return false; }
  },

  /** 是否已有精读产物（幂等判断） */
  async alreadyRead(item) {
    try {
      const tag = String(Prefs.get("autoReadTag", "#AI精读") || "");
      if (tag && (item.getTags() || []).some((t) => t.tag === tag)) return true;
      const wanted = I18n.t("noteSummaryTitle");
      for (const nid of (item.getNotes && item.getNotes()) || []) {
        const n = Zotero.Items.get(nid);
        const title = n && n.getNoteTitle ? n.getNoteTitle() : "";
        if (title && wanted && title.includes(wanted)) return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  },

  async hasPdf(item) {
    try {
      const best = await item.getBestAttachment();
      return !!(best && best.attachmentContentType === "application/pdf");
    } catch (e) { return false; }
  },

  /** 是否可以处理该条目（不含额度判断） */
  async eligible(item) {
    try {
      if (!item || !item.isRegularItem || !item.isRegularItem() || item.deleted) return false;
      if (!this.inScope(item)) return false;
      if (!(await this.hasPdf(item))) return false;
      if (await this.alreadyRead(item)) return false;
      return true;
    } catch (e) { return false; }
  },

  /* ================== 队列 ================== */

  /** 入队（去重 + 去已处理 + 超额度裁剪），返回实际入队数 */
  async enqueue(ids) {
    let added = 0;
    for (const id of ids || []) {
      if (this.queue.includes(id)) continue;
      this.queue.push(id);
      added++;
    }
    return added;
  },

  async _drain() {
    if (this._running) return;
    this._running = true;
    const zh = I18n.isZh;
    let pw = null, progress = null;
    try {
      while (this.queue.length) {
        const gate = this.canRun();
        if (!gate.ok) {
          if (!this._warned && this.queue.length) {
            this._warned = true;
            Zotero.debug("Papilot autoRead 停止：" + gate.reason);
          }
          this.queue = [];
          break;
        }
        const id = this.queue.shift();
        let item = null;
        try { item = await Zotero.Items.getAsync(id); } catch (e) { item = null; }
        if (!item || !(await this.eligible(item))) continue;
        if (!pw) {
          pw = new Zotero.ProgressWindow({ closeOnClick: true });
          pw.changeHeadline("Papilot · " + (zh ? "入库自动精读" : "Auto read"));
          pw.show();
        }
        let title = "";
        try { title = item.getDisplayTitle() || ""; } catch (e) { /* ignore */ }
        progress = new pw.ItemProgress("chrome://papilot/content/icons/chat.svg",
          (zh ? "AI 精读中：" : "Reading: ") + title.slice(0, 60));
        try {
          await AIChat.summarize(item);
          this.bump();
          const tag = String(Prefs.get("autoReadTag", "#AI精读") || "");
          if (tag && !(item.getTags() || []).some((t) => t.tag === tag)) {
            item.addTag(tag);
            await item.saveTx();
          }
          progress.setText((zh ? "已生成精读笔记 ｜ 今日 " : "Done | today ") + this.todayCount() + "/" + this.dailyCap());
          progress.setProgress(100);
        } catch (e) {
          progress.setError();
          Zotero.logError(e);
        }
      }
    } catch (e) {
      Zotero.logError(e);
    } finally {
      this._running = false;
      if (pw) pw.startCloseTimer(2500);
    }
  },

  /* ================== 入口 ================== */

  /** 手动：对选中条目立即精读（忽略每日上限？不——仍然遵守，但会明确告知） */
  async runForSelected() {
    const zh = I18n.isZh;
    const zp = Zotero.getActiveZoteroPane();
    if (!zp) return;
    const items = ItemSel.regularOnly(zp.getSelectedItems() || []);
    if (!items.length) { ItemSel.alertEmpty(); return; }
    const gate = this.canRun();
    if (!gate.ok) {
      Services.prompt.alert(Zotero.getMainWindow(), "Papilot", gate.reason);
      return;
    }
    const ok = [];
    for (const it of items) if (await this.eligible(it)) ok.push(it.id);
    if (!ok.length) {
      Services.prompt.alert(Zotero.getMainWindow(), "Papilot",
        zh ? "这些条目都不满足条件：需要「有 PDF」「未精读过」，并且在你设定的分类白名单内。"
           : "No eligible items (need a PDF, not already read, and inside the whitelist).");
      return;
    }
    const n = Math.min(ok.length, this.remaining());
    await this.enqueue(ok.slice(0, n));
    if (ok.length > n) {
      Services.prompt.alert(Zotero.getMainWindow(), "Papilot",
        zh ? `今日剩余额度只够 ${n} 篇，其余 ${ok.length - n} 篇本次跳过（明日额度重置）。`
           : `Daily quota allows ${n} of ${ok.length}; the rest were skipped.`);
    }
    this._drain().catch((e) => Zotero.logError(e));
  },

  /** 状态摘要（供功能中心/对话框显示） */
  status() {
    const zh = I18n.isZh;
    const gate = this.canRun();
    return {
      enabled: !!Prefs.get("autoReadEnabled", false),
      used: this.todayCount(),
      cap: this.dailyCap(),
      queue: this.queue.length,
      ok: gate.ok,
      reason: gate.reason,
      text: (zh ? "今日已精读 " : "today ") + this.todayCount() + "/" + this.dailyCap() +
        (this.queue.length ? (zh ? "，队列 " : ", queued ") + this.queue.length : "") +
        (gate.ok ? "" : (zh ? "（暂停：" : " (paused: ") + gate.reason + (zh ? "）" : ")")),
    };
  },

  /* ================== Notifier ================== */

  _onNotify(event, ids) {
    if (event !== "add") return;
    if (!Prefs.get("autoReadEnabled", false)) return;
    for (const id of ids) this._pending.add(id);
    if (this._timer) return;
    // 防抖 6s：批量导入合并；且等 DOI 识别 / PDF 抓取等后续事件落定
    this._timer = setTimeout(() => { this._flush().catch((e) => Zotero.logError(e)); }, 6000);
  },

  async _flush() {
    this._timer = null;
    const ids = [...this._pending];
    this._pending.clear();
    if (!ids.length) return;
    const gate = this.canRun();
    if (!gate.ok) return; // 未开启/无额度：直接不处理（不打扰用户）
    const cap = Math.max(1, Number(Prefs.get("autoReadMaxPerFlush", 5)) || 5);
    let n = 0;
    for (const id of ids) {
      if (n >= cap) break;
      let item = null;
      try { item = await Zotero.Items.getAsync(id); } catch (e) { item = null; }
      if (!item || !(await this.eligible(item))) continue;
      if (this.queue.includes(id)) continue;
      this.queue.push(id);
      n++;
    }
    if (n) this._drain().catch((e) => Zotero.logError(e));
  },

  register() {
    if (this._notifierID) return;
    this._notifierID = Zotero.Notifier.registerObserver({
      notify: (event, type, ids) => {
        try { if (type === "item") this._onNotify(event, ids); } catch (e) { Zotero.logError(e); }
      },
    }, ["item"], "papilot-autoread");
  },

  unregister() {
    if (this._notifierID) {
      try { Zotero.Notifier.unregisterObserver(this._notifierID); } catch (e) { /* ignore */ }
      this._notifierID = null;
    }
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this._pending.clear();
    this.queue = [];
  },
};
