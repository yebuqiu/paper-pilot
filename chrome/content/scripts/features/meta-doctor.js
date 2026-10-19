// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 元数据医生（0.52.0）——「检测 → 反查 → 预览 → 确认 → 应用 → 可撤销」
 *
 * 与既有模块的分工（不重复实现检查）：
 *   meta-lint  = 格式规范化（DOI 去前缀 / 日期补零 / 标题去尾点 / URL 去参），命中即静默修；
 *   meta-rules = 语义体检（刊名缩写、作者名归一、DOI 合法性、类型必备字段），勾选后修；
 *   meta-enrich= 走 Semantic Scholar 回写**多字段**（DOI/摘要/卷期页/作者）；
 *   meta-doctor（本文件）= 走 **Crossref 标题反查**，只处理四类「空缺」：
 *     DOI / 期刊名（publicationTitle）/ 年份（date 无 4 位数字）/ 作者（creators 空）。
 *     与 meta-enrich 的差异是本模块严守「预览 → 确认 → 应用 → 可撤销」：
 *     任何一条都要先凑齐 diff 给用户看，确认后才落一行 saveTx，并把旧值写进
 *     AgentTools 审计（undo.kind = restoreFields），/undo 可整条回滚。
 *
 * 铁律：
 *   · **只补空**：DOI/publicationTitle/creators 必须 trim 后为空才算缺；
 *     date 按「没有 4 位年份」判缺（"in press" 这类占位串才会被替换，且旧值进审计）；
 *   · 匹配必须同时满足「标题相似度 ≥ 0.75」与「年份差 ≤ 1」（有年份才校验）；
 *   · 网络失败 / 条目异常一律返回对象，绝不抛；失败条目不中断整批；
 *   · ctx.skipConfirm / 无主窗口 → **不写库**，只回 {ok:false, reason:"confirm_required", preview}。
 *
 * 可测性：_titleSim / gapsOf / _diffsFrom / _pickBest 都是纯函数；网络走 _req 单点，
 * 测试直接替换 MetaDoctor._req 即可完全离线（见 test/meta-doctor.test.js）。
 */
/* global Zotero, Services, Prefs, I18n, AgentTools */

var MetaDoctor = {
  /** 集成方接菜单用的稳定 id（menus.js / hub 里注册时用） */
  MENU_ID: "meta-doctor",

  CROSSREF: "https://api.crossref.org/works",
  ROWS: 3,
  TIMEOUT: 15000,        // 单次请求上限（Promise.race 兜底，防 Zotero.HTTP 卡死）
  REQ_GAP: 400,          // 相邻请求最小间隔（Crossref 礼貌池；测试走桩不触发）
  TITLE_MIN: 0.75,       // 标题相似度门槛
  YEAR_MAX_DIFF: 1,      // 年份允许差
  CREATOR_MAX: 100,      // 单条最多回写作者数（防异常响应写爆条目）

  /** 只有这几种类型有 publicationTitle 字段（其余类型写它会抛） */
  PUB_TITLE_TYPES: ["journalArticle", "magazineArticle", "newspaperArticle"],

  _lastReqAt: 0,

  /* ==================== 文案 / 基础读取 ==================== */

  _zh() {
    try {
      if (typeof I18n !== "undefined" && I18n && typeof I18n.isZh === "boolean") return I18n.isZh;
    } catch (e) { /* ignore */ }
    try { return String(Zotero.locale || "").toLowerCase().indexOf("zh") === 0; }
    catch (e) { return true; }
  },

  _label(field, zh) {
    const z = zh === undefined ? this._zh() : zh;
    if (field === "DOI") return "DOI";
    if (field === "publicationTitle") return z ? "期刊" : "journal";
    if (field === "date") return z ? "年份" : "year";
    if (field === "creators") return z ? "作者" : "authors";
    return String(field || "");
  },

  _get(item, field) {
    try { return String((item && item.getField && item.getField(field)) || ""); }
    catch (e) { return ""; }
  },

  _typeOf(item) {
    try {
      return String((item && (item.itemType || (item.getItemType && item.getItemType()))) || "");
    } catch (e) { return ""; }
  },

  _creatorsOf(item) {
    try { return (item && item.getCreators && item.getCreators()) || []; }
    catch (e) { return []; }
  },

  _titleOf(item) {
    let t = "";
    try { t = String((item && item.getDisplayTitle && item.getDisplayTitle()) || ""); }
    catch (e) { t = ""; }
    if (!t) t = this._get(item, "title").trim();
    return t || (this._zh() ? "（无标题）" : "(untitled)");
  },

  /** 条目年份（date 里第一个 4 位数字；无则 0） */
  _yearOf(item) {
    const m = this._get(item, "date").match(/(\d{4})/);
    const y = m ? parseInt(m[1], 10) : 0;
    return (y >= 1000 && y <= 2999) ? y : 0;
  },

  _normDoi(doi) {
    return String(doi || "")
      .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
      .replace(/^doi\s*[:：]\s*/i, "")
      .trim()
      .replace(/[)。，,；;.]+$/, "")
      .toLowerCase();
  },

  /* ==================== 纯函数：标题相似度 ==================== */

  /** 归一化：小写、撇号去掉（O’Neil=ONeil）、标点/符号 → 空格、折叠空白 */
  _normTitle(s) {
    return String(s == null ? "" : s)
      .toLowerCase()
      .replace(/[’'`´]/g, "")
      .replace(/[^\w\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g, " ")
      .trim()
      .replace(/\s+/g, " ");
  },

  /** 字符 bigram 直方图 */
  _bigrams(s) {
    const map = new Map();
    const t = String(s || "").replace(/\s+/g, "");
    for (let i = 0; i < t.length - 1; i++) {
      const g = t.slice(i, i + 2);
      map.set(g, (map.get(g) || 0) + 1);
    }
    return map;
  },

  /** 字符 bigram Dice 系数（中文等无空格文本的兜底度量，0..1） */
  _diceSim(a, b) {
    const A = this._bigrams(a);
    const B = this._bigrams(b);
    let na = 0, nb = 0, inter = 0;
    A.forEach((n) => { na += n; });
    B.forEach((n) => { nb += n; });
    if (!na && !nb) return a === b ? 1 : 0;
    if (!na || !nb) return 0;
    A.forEach((n, g) => { if (B.has(g)) inter += Math.min(n, B.get(g)); });
    return (2 * inter) / (na + nb);
  },

  /**
   * 标题相似度 0..1（纯函数，便于单测）。
   * 词级 Jaccard 为主：交集/并集，同词表顺序无关，适合拉丁文标题；
   * 任一侧只有 1 个 token（中文标题没有空格）时退化为字符 bigram Dice，
   * 否则中文标题的 Jaccard 恒为 0 → 全部误判为「匹配度不足」。
   */
  _titleSim(a, b) {
    const na = this._normTitle(a);
    const nb = this._normTitle(b);
    if (!na || !nb) return 0;
    if (na === nb) return 1;
    const ta = na.split(" ");
    const tb = nb.split(" ");
    if (ta.length < 2 || tb.length < 2) return this._diceSim(na, nb);
    const sa = new Set(ta);
    const sb = new Set(tb);
    let inter = 0;
    sa.forEach((t) => { if (sb.has(t)) inter++; });
    const union = sa.size + sb.size - inter;
    return union ? inter / union : 0;
  },

  /* ==================== 网络（单点，可整体替换） ==================== */

  /** 礼貌池邮箱（复用 refImportMailto；未配置时不追加参数，保持 URL 与规范一致） */
  _mailto() {
    try { return String(Prefs.get("refImportMailto", "") || "").trim(); }
    catch (e) { return ""; }
  },

  _lookupUrl(title, author, year) {
    const q = [title, author, year].filter(Boolean).join(" ").trim();
    let url = this.CROSSREF + "?query.bibliographic=" + encodeURIComponent(q) +
      "&rows=" + this.ROWS +
      "&select=DOI,title,container-title,issued,author,score";
    const mail = this._mailto();
    if (mail) url += "&mailto=" + encodeURIComponent(mail);
    return url;
  },

  /**
   * 单次 GET。任何失败（超时 / 非 2xx / 坏 JSON / HTTP 层异常）都返回
   * {ok:false, status, json:null, error}，**不抛**。
   */
  async _req(url) {
    const out = { ok: false, status: 0, json: null, error: "" };
    let timer = null;
    try {
      const gap = (Number(this._lastReqAt) || 0) + this.REQ_GAP - Date.now();
      if (gap > 0) await new Promise((r) => setTimeout(r, gap));
      this._lastReqAt = Date.now();

      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ __ppTimeout: true }), this.TIMEOUT);
      });
      let res = null;
      try {
        res = await Promise.race([
          Zotero.HTTP.request("GET", url, {
            headers: {
              "Accept": "application/json",
              "User-Agent": "Papilot MetaDoctor (Zotero)",
            },
            responseType: "json",
            timeout: this.TIMEOUT,
          }),
          timeout,
        ]);
      } catch (e) {
        out.status = (e && e.xmlhttp && e.xmlhttp.status) || 0;
        out.error = String((e && (e.message || e)) || "network error");
        return out;
      }
      if (res && res.__ppTimeout) { out.error = "请求超时（" + this.TIMEOUT + "ms）"; return out; }
      out.status = (res && res.status) || 200;
      if (out.status >= 400) { out.error = "HTTP " + out.status; return out; }
      let json = (res && res.response) || null;
      // 少数 Zotero 版本会把 response 给成字符串（responseType 未生效）→ 自行解析
      if (typeof json === "string") {
        try { json = JSON.parse(json); } catch (e) { json = null; }
      }
      out.json = json;
      if (!out.json) { out.error = "响应不是 JSON"; return out; }
      out.ok = true;
    } catch (e) {
      out.error = String((e && (e.message || e)) || e);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return out;
  },

  /* ==================== 检测：四类缺口 ==================== */

  /**
   * 缺口清单（纯读，不写库）。
   * DOI / publicationTitle / creators：trim 后为空才算缺；
   * date：空或没有 4 位年份（"in press"/"forthcoming" 这类占位串）。
   */
  gapsOf(item) {
    const gaps = [];
    if (!this._get(item, "DOI").trim()) gaps.push("DOI");
    const type = this._typeOf(item);
    if (this.PUB_TITLE_TYPES.indexOf(type) >= 0 && !this._get(item, "publicationTitle").trim()) {
      gaps.push("publicationTitle");
    }
    const date = this._get(item, "date").trim();
    if (!date || !/\d{4}/.test(date)) gaps.push("date");
    if (!this._creatorsOf(item).length) gaps.push("creators");
    return gaps;
  },

  /* ==================== Crossref 解析 / 匹配 ==================== */

  _titleOfMsg(msg) {
    const t = msg && msg.title;
    return String((Array.isArray(t) ? (t[0] || "") : (t || "")) || "").replace(/\s+/g, " ").trim();
  },

  _containerOfMsg(msg) {
    const c = msg && msg["container-title"];
    return String((Array.isArray(c) ? (c[0] || "") : (c || "")) || "").replace(/\s+/g, " ").trim();
  },

  _yearOfIssued(msg) {
    const pick = (block) => {
      const dp = block && block["date-parts"] && block["date-parts"][0];
      const y = dp && dp.length ? parseInt(dp[0], 10) : 0;
      return (y >= 1000 && y <= 2999) ? y : 0;
    };
    return pick(msg && msg.issued) || pick(msg && msg["published-print"]) || 0;
  },

  /** Crossref author[] → Zotero creators（只保留能构成姓名的项） */
  _creatorsFrom(msg) {
    const out = [];
    for (const a of (msg && msg.author) || []) {
      if (!a) continue;
      const family = String(a.family || "").trim();
      const given = String(a.given || "").trim();
      const literal = String(a.name || "").trim();
      if (family) out.push({ creatorType: "author", firstName: given, lastName: family });
      else if (literal) out.push({ creatorType: "author", name: literal });
      if (out.length >= this.CREATOR_MAX) break;
    }
    return out;
  },

  /** 候选里挑最佳：相似度 ≥ 门槛，且（双方都有年份时）年份差 ≤ 1 */
  _pickBest(list, title, year) {
    let best = null;
    for (const m of list || []) {
      if (!m) continue;
      const t = this._titleOfMsg(m);
      if (!t) continue;
      const sim = this._titleSim(title, t);
      if (sim < this.TITLE_MIN) continue;
      const y = this._yearOfIssued(m);
      if (year && y && Math.abs(y - year) > this.YEAR_MAX_DIFF) continue;
      const score = Number(m.score) || 0;
      if (!best || sim > best.sim + 1e-9 ||
          (Math.abs(sim - best.sim) <= 1e-9 && score > best.score)) {
        best = { msg: m, sim: sim, year: y, title: t, score: score };
      }
    }
    return best;
  },

  /**
   * 命中记录 → diff 列表。**只对 gaps 里的字段生成**，因此已有值绝不进 diffs。
   * old 保留原值（撤销时要写回去；date 的空/占位串同样保留）。
   */
  _diffsFrom(item, msg, gaps) {
    const has = (f) => (gaps || []).indexOf(f) >= 0;
    const diffs = [];
    if (has("DOI")) {
      const doi = this._normDoi(msg && msg.DOI);
      if (doi) diffs.push({ field: "DOI", old: this._get(item, "DOI"), new: doi });
    }
    if (has("publicationTitle")) {
      const container = this._containerOfMsg(msg);
      if (container) {
        diffs.push({ field: "publicationTitle", old: this._get(item, "publicationTitle"), new: container });
      }
    }
    if (has("date")) {
      const y = this._yearOfIssued(msg);
      if (y) diffs.push({ field: "date", old: this._get(item, "date"), new: String(y) });
    }
    if (has("creators")) {
      const cs = this._creatorsFrom(msg);
      if (cs.length) diffs.push({ field: "creators", old: this._creatorsOf(item), new: cs });
    }
    return diffs;
  },

  _firstAuthorFamily(item) {
    for (const c of this._creatorsOf(item)) {
      if (!c) continue;
      const fam = String(c.lastName || c.name || "").trim();
      if (fam) return fam;
    }
    return "";
  },

  /* ==================== 单条预览 ==================== */

  /**
   * 单条 → {item, title, gaps, diffs, match} | {item, title, skip}
   * skip ∈ no_gap / no_title / no_match / low_score / request_failed / error
   */
  async _previewFor(item) {
    if (!item) return { item: null, title: "", skip: "error", error: "条目为空" };
    const title = this._titleOf(item);
    let gaps = [];
    try { gaps = this.gapsOf(item); }
    catch (e) { return { item, title, skip: "error", error: String((e && e.message) || e) }; }
    if (!gaps.length) return { item, title, gaps, skip: "no_gap" };

    const rawTitle = this._get(item, "title").trim();
    if (!rawTitle) return { item, title, gaps, skip: "no_title" };

    const year = this._yearOf(item);
    const url = this._lookupUrl(rawTitle, this._firstAuthorFamily(item), year || "");
    const res = await this._req(url);
    if (!res || !res.ok) {
      return { item, title, gaps, skip: "request_failed", error: (res && res.error) || "network error" };
    }
    const list = (res.json && res.json.message && res.json.message.items) || [];
    if (!list.length) return { item, title, gaps, skip: "no_match" };

    const best = this._pickBest(list, rawTitle, year);
    if (!best) return { item, title, gaps, skip: "low_score" };

    const diffs = this._diffsFrom(item, best.msg, gaps);
    if (!diffs.length) return { item, title, gaps, skip: "no_gap" };
    return {
      item, title, gaps, diffs,
      match: {
        doi: this._normDoi(best.msg && best.msg.DOI),
        title: best.title,
        year: best.year,
        sim: Math.round(best.sim * 1000) / 1000,
        score: best.score,
      },
    };
  },

  /* ==================== 应用（写库） ==================== */

  /**
   * 写单条：逐字段 setField / setCreators，最后**一次** saveTx。
   * 返回 {ok, applied:[field], old:{field:旧值}}；失败不抛。
   * saveTx 失败时把内存值回滚成旧值（避免后续 autosave 把半成品落库）。
   */
  async _applyItem(item, diffs) {
    const applied = [];
    const old = {};
    for (const d of diffs || []) {
      if (!d || !d.field) continue;
      try {
        if (d.field === "creators") {
          if (typeof item.setCreators !== "function") continue;
          item.setCreators((d.new || []).map((c) => Object.assign({}, c)));
          old.creators = Array.isArray(d.old) ? d.old.map((c) => Object.assign({}, c)) : [];
        } else {
          item.setField(d.field, String(d.new == null ? "" : d.new));
          old[d.field] = (d.old == null ? "" : String(d.old));
        }
        applied.push(d.field);
      } catch (e) { /* 该条目类型没有这个字段：跳过，不影响其他字段 */ }
    }
    if (!applied.length) return { ok: false, error: "没有可写入的字段" };
    try {
      await item.saveTx();
    } catch (e) {
      try {
        for (const f of applied) {
          if (f === "creators") {
            if (typeof item.setCreators === "function") item.setCreators(old.creators || []);
          } else {
            item.setField(f, old[f] == null ? "" : String(old[f]));
          }
        }
      } catch (e2) { /* 回滚尽力而为 */ }
      return { ok: false, error: "保存失败：" + ((e && e.message) || e) };
    }
    const fields = {};
    for (const f of applied) fields[f] = old[f];
    return { ok: true, applied, old: fields };
  },

  /** 审计（undo.kind = restoreFields；只记实际写入的字段及其旧值） */
  _audit(item, diffs, oldMap) {
    try {
      if (typeof AgentTools === "undefined" || !AgentTools ||
          typeof AgentTools._recordAudit !== "function") return null;
      const zh = this._zh();
      const fields = {};
      for (const d of diffs || []) {
        if (d && oldMap && Object.prototype.hasOwnProperty.call(oldMap, d.field)) {
          fields[d.field] = oldMap[d.field];
        }
      }
      if (!Object.keys(fields).length) return null;
      const labels = (diffs || []).filter((d) => d && Object.prototype.hasOwnProperty.call(fields, d.field))
        .map((d) => this._label(d.field, zh)).join("/");
      const summary = (zh ? "元数据补全：《" : "Metadata fill: ") + this._titleOf(item) +
        (zh ? "》补 " : " — filled ") + labels;
      return AgentTools._recordAudit("meta_doctor", summary, {
        kind: "restoreFields",
        itemID: (item && item.id) || 0,
        fields: fields,
      });
    } catch (e) { return null; }
  },

  /* ==================== 预览文案 / 确认 / 提示 ==================== */

  _diffValue(d, zh) {
    if (d.field === "creators") return ((d.new || []).length) + (zh ? " 位" : " author(s)");
    return String(d.new == null ? "" : d.new);
  },

  _previewText(preview, skippedCount, zh) {
    const MAX = 15;
    const lines = (preview || []).slice(0, MAX).map((p) => {
      const parts = (p.diffs || []).map((d) => this._label(d.field, zh) + ": " + this._diffValue(d, zh));
      return "《" + p.title + "》→ " + (zh ? "补 " : "fill ") + parts.join(" / ");
    });
    if ((preview || []).length > MAX) {
      lines.push(zh ? "……（其余 " + (preview.length - MAX) + " 条略）"
        : "… (" + (preview.length - MAX) + " more)");
    }
    const total = (preview || []).length;
    const skip = skippedCount || 0;
    lines.push("");
    lines.push(zh
      ? "共 " + total + " 条可补全，" + skip + " 条跳过（匹配度不足/无命中）"
      : total + " item(s) to fill, " + skip + " skipped (low score / no match)");
    lines.push(zh ? "只补空缺字段，不覆盖已有值。" : "Only empty fields are filled; existing values are kept.");
    return lines.join("\n");
  },

  /** 有主窗口 + prompt.confirmEx 才认为可确认 */
  _canConfirm() {
    try {
      if (typeof Services === "undefined" || !Services || !Services.prompt) return false;
      if (typeof Services.prompt.confirmEx !== "function") return false;
      const win = Zotero.getMainWindow ? Zotero.getMainWindow() : null;
      return !!win;
    } catch (e) { return false; }
  },

  /** 摘要确认框：0 = 应用补全，1 = 取消 */
  _confirm(preview, skippedCount, zh) {
    const msg = this._previewText(preview, skippedCount, zh);
    try {
      const win = Zotero.getMainWindow();
      const P = Services.prompt;
      let flags = 0;
      try {
        flags = P.BUTTON_POS_0 * P.BUTTON_TITLE_IS_STRING +
          P.BUTTON_POS_1 * P.BUTTON_TITLE_IS_STRING;
      } catch (e) { flags = 0; }
      if (!isFinite(flags)) flags = 0;
      const choice = P.confirmEx(win,
        "Papilot · " + (zh ? "元数据医生" : "Metadata Doctor"),
        msg, flags,
        zh ? "应用补全" : "Apply", zh ? "取消" : "Cancel", null, null, {});
      return choice === 0;
    } catch (e) {
      return false; // 拿不到对话框 = 不写库
    }
  },

  /** ProgressWindow 汇总；无 UI 时只写调试日志并返回同一句文案 */
  _toast(applied, failed, skipped) {
    const zh = this._zh();
    const text = (zh ? "已补全 " : "Filled ") + applied + (zh ? " 条" : "") +
      (failed ? (zh ? " / 失败 " : " / failed ") + failed + (zh ? " 条" : "") : "") +
      (skipped ? (zh ? " / 跳过 " : " / skipped ") + skipped + (zh ? " 条" : "") : "") +
      (applied ? (zh ? " / 可用 /undo 撤销" : " / use /undo to revert") : "");
    try {
      if (typeof Zotero.ProgressWindow === "function") {
        const pw = new Zotero.ProgressWindow({ closeOnClick: true });
        pw.changeHeadline("Papilot · " + (zh ? "元数据医生" : "Metadata Doctor"));
        const row = new pw.ItemProgress("chrome://papilot/content/icons/chat.svg", text);
        if (failed) { try { row.setError(); } catch (e) { /* ignore */ } }
        else row.setProgress(100);
        pw.show();
        pw.startCloseTimer(4000);
        return text;
      }
    } catch (e) { /* 无 UI：静默 */ }
    try { Zotero.debug("Papilot meta-doctor: " + text); } catch (e) { /* ignore */ }
    if (failed) { try { Zotero.logError("Papilot meta-doctor: " + text); } catch (e) { /* ignore */ } }
    return text;
  },

  /* ==================== 预览数据（可 JSON 化，MCP/测试消费） ==================== */

  _previewData(list) {
    const zh = this._zh();
    return (list || []).map((p) => ({
      itemID: (p.item && p.item.id) || 0,
      title: p.title,
      match: p.match || null,
      diffs: (p.diffs || []).map((d) => ({
        field: d.field,
        label: this._label(d.field, zh),
        old: d.old,
        new: d.new,
      })),
    }));
  },

  /* ==================== 选区归一（条目 / id / 附件） ==================== */

  async _resolveOne(x) {
    if (!x) return null;
    if (typeof x === "object") {
      let regular = false;
      try { regular = !!(x.isRegularItem && x.isRegularItem()); } catch (e) { regular = false; }
      if (regular) return x;
      try {
        if (x.parentItemID) {
          const p = Zotero.Items.get(x.parentItemID);
          if (p) return p;
        }
      } catch (e) { /* ignore */ }
      return null;
    }
    const n = parseInt(x, 10);
    if (!isFinite(n) || n <= 0) return null;
    let it = null;
    try { it = Zotero.Items.get(n); } catch (e) { return null; }
    return this._resolveOne(it);
  },

  async _resolveItems(arg) {
    let raw = [];
    if (arg === undefined || arg === null || arg === "") {
      let zp = null;
      try { zp = Zotero.getActiveZoteroPane ? Zotero.getActiveZoteroPane() : null; }
      catch (e) { zp = null; }
      raw = (zp && zp.getSelectedItems && zp.getSelectedItems()) || [];
    } else if (Array.isArray(arg)) {
      raw = arg;
    } else {
      raw = [arg];
    }
    const out = [];
    for (const x of raw) {
      let it = null;
      try { it = await this._resolveOne(x); } catch (e) { it = null; }
      if (it && out.indexOf(it) < 0) out.push(it);
    }
    return out;
  },

  /* ==================== 入口 ==================== */

  /**
   * 元数据医生主流程。
   * @param {Array<Item|number>|Item|number} [itemIDsOrItems] 缺省 = 当前选中条目
   * @param {{skipConfirm?:boolean, source?:string}} [ctx]
   * @returns {{ok:boolean, reason?:string, applied:Array, skipped:Array, errors:Array, preview:Array}}
   *   reason ∈ no_selection / nothing_to_do / confirm_required / cancelled
   */
  async run(itemIDsOrItems, ctx) {
    const opts = ctx || {};
    const zh = this._zh();
    const result = { ok: false, applied: [], skipped: [], errors: [], preview: [] };

    let items = [];
    try { items = await this._resolveItems(itemIDsOrItems); }
    catch (e) { items = []; }
    if (!items.length) {
      result.reason = "no_selection";
      return result;
    }

    /* 1) 逐条检测 + 反查（串行，Crossref 礼貌限速在 _req 内） */
    const ready = [];
    for (const item of items) {
      const itemID = (item && item.id) || 0;
      const title = this._titleOf(item);
      let p = null;
      try { p = await this._previewFor(item); }
      catch (e) {
        result.errors.push({ itemID, title, error: String((e && e.message) || e) });
        continue;
      }
      if (p && p.diffs && p.diffs.length) {
        ready.push(p);
      } else {
        const reason = (p && p.skip) || "no_match";
        const row = { itemID, title, reason };
        if (p && p.error) row.error = p.error;
        result.skipped.push(row);
      }
    }

    result.preview = this._previewData(ready);

    if (!ready.length) {
      result.reason = "nothing_to_do";
      return result;
    }

    /* 2) 预览确认：无 UI / skipConfirm 一律不写库 */
    if (opts.skipConfirm === true || !this._canConfirm()) {
      result.reason = "confirm_required";
      return result;
    }
    if (!this._confirm(ready, result.skipped.length, zh)) {
      result.reason = "cancelled";
      return result;
    }

    /* 3) 应用（逐条：setField… → 一次 saveTx；失败不中断） */
    for (const p of ready) {
      const itemID = (p.item && p.item.id) || 0;
      let r = null;
      try { r = await this._applyItem(p.item, p.diffs); }
      catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
      if (!r || !r.ok) {
        result.errors.push({ itemID, title: p.title, error: (r && r.error) || "写入失败" });
        continue;
      }
      /* 4) 审计（旧值来自 _applyItem，只含实际写入的字段） */
      this._audit(p.item, p.diffs, r.old);
      result.applied.push({ itemID, title: p.title, fields: r.applied });
    }

    result.ok = result.applied.length > 0;
    if (!result.applied.length) result.reason = "apply_failed";
    this._toast(result.applied.length, result.errors.length, result.skipped.length);
    return result;
  },
};
