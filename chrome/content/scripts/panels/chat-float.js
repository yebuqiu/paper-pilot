/* PaperPilot AI 问答悬浮窗（0.31.0）
 *
 * 参考 zotero-gpt（可拖动悬浮窗 + Esc 关闭 + ↑↓ 历史 + 点击标签发模板）
 * 与 papersgpt-for-zotero（阅读器工具栏按钮 + Ctrl/Cmd+Enter 唤起 + 独立窗口分屏）
 * 的交互设计，整合进 PaperPilot 既有 AI 基建（AIChat 全文注入 / AIClient 流式 /
 * Prompts 模板库 / MdLite 富文本 / Notes 存笔记）。
 *
 * 唤起方式（四处入口）：
 *   ① 主窗口快捷键 Ctrl/Cmd+Shift+K（keyset 注入，主窗口场景）
 *   ② 阅读器工具栏 AI 按钮（官方 renderToolbar 扩展位，与主题按钮同模式）
 *   ③ 阅读器内 Ctrl/Cmd+Enter（PapersGPT 同款，reader doc keydown 捕获）
 *   ④ 条目右键菜单「AI 问答」直达（menus.js ITEM_REGISTRY 顶层）
 *   ⑤ 划词浮窗「在浮窗继续」（reader-popup.js 调 injectQuote）
 *
 * 窗口形态（三种）：
 *   · 悬浮窗（默认）：标题栏拖动、右下角缩放、位置/尺寸持久化、Esc 关闭
 *   · 停靠：贴左/贴右全高，拖动标题栏即脱离；停靠侧持久化
 *   · 分屏独立窗口：openWindow() 弹真窗口，可与 Zotero 并排零遮挡；
 *     会话（session）为全局单例，悬浮窗/独立窗口/划词注入共享同一份历史。
 *
 * 发送逻辑单源化：runSend(question, ui) 供悬浮窗与独立窗口（chat-window.js
 * 经 Zotero.PaperPilot.chatFloat 访问本模块）共用；全文缺失时回退摘要
 * （AIChat.buildMessages），比侧栏更宽容。
 *
 * 生命周期：register(pluginID) / unregister()。UI 惰性构建：首次唤起才建 DOM。
 */
/* global Zotero, Services, Prefs, AIClient, AIChat, I18n, Prompts, MdLite, Notes, CommandTags, ChatSessions, AgentTools, Hotkeys, Components */

var ChatFloat = {
  ROOT_ID: "paperpilot-chat-float",
  STYLE_ID: "paperpilot-chat-float-style",
  KEY_ID: "paperpilot-key-chat-float",
  READER_BTN_ID: "paperpilot-chat-reader-button",
  WINDOW_TYPE: "paperpilot:chatwin",
  XHTML: "http://www.w3.org/1999/xhtml",
  XUL: "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul",

  OPACITY_STEPS: ["1", "0.9", "0.75", "0.6"],
  MIN_W: 340, MIN_H: 380,
  DEFAULT_W: 400, DEFAULT_H: 540,

  // 0.44.0 拖拽条目作为上下文 chip：上限与单篇上下文截断
  CHIP_MAX: 5,
  CHIP_TEXT_MAX: 6000,

  _pluginID: null,
  _readerHandler: null,
  _obsObserver: null,
  _nodes: [],       // [{node}] keyset 快捷键节点（unregister 时移除）
  _wins: new Map(), // chromeWin -> {root, refs, geo:{x,y,w,h,dock}, escBound}
  _pendingSwitchNotice: false, // toggle 时条目发生切换 → show 后提示一次

  // ---- 全局会话（单例：悬浮窗 / 独立窗口 / 划词注入共享） ----
  session: {
    item: null,        // 当前锁定的 Zotero 条目
    history: [],       // [{role, content}]（成功轮次才入史，失败可重发）
    busy: false,
    handle: null,      // 进行中的流式句柄
    inputHistory: [],  // 输入历史（↑↓ 导航）
    histIdx: -1,
    contextItems: [],  // 0.44.0 拖入的上下文条目 itemID 列表（chip；存在时优先于 item）
  },

  /* ==================== 工具 ==================== */

  _h(doc, tag, attrs = {}, text) {
    const el = doc.createElementNS(this.XHTML, tag);
    for (const k in attrs) {
      if (k === "style") el.style.cssText = attrs[k];
      else el.setAttribute(k, attrs[k]);
    }
    if (text != null) el.textContent = text;
    return el;
  },

  _xul(doc, tag) {
    return doc.createXULElement
      ? doc.createXULElement(tag)
      : doc.createElementNS(this.XUL, tag);
  },

  _err(e) {
    try { Zotero.logError(e); } catch (_) { /* ignore */ }
  },

  /** "x,y" / "w,h" pref 解析（容错：坏值回退默认） */
  _parsePair(raw, fallback) {
    const m = /^(\d+),(\d+)$/.exec(String(raw || "").trim());
    if (!m) return fallback.slice();
    const v = [parseInt(m[1], 10), parseInt(m[2], 10)];
    if (!isFinite(v[0]) || !isFinite(v[1])) return fallback.slice();
    return v;
  },

  _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); },

  /** 当前该用的条目：优先正在读的 PDF，回退主窗口选中条目 */
  _resolveItem() {
    try {
      const readers = (Zotero.Reader && Zotero.Reader._readers) || [];
      for (let i = readers.length - 1; i >= 0; i--) {
        const r = readers[i];
        if (!r || !r.itemID) continue;
        const it = Zotero.Items.get(r.itemID);
        if (!it) continue;
        if (it.isRegularItem && it.isRegularItem()) return it;
        if (it.parentItemID) {
          const p = Zotero.Items.get(it.parentItemID);
          if (p) return p;
        }
        return it;
      }
    } catch (e) { /* ignore */ }
    try {
      const zp = Zotero.getActiveZoteroPane();
      const sel = (zp && zp.getSelectedItems && zp.getSelectedItems()) || [];
      for (const it of sel) {
        if (it && it.isRegularItem && it.isRegularItem()) return it;
      }
    } catch (e) { /* ignore */ }
    return null;
  },

  /** 设置/切换会话条目；条目变化时清空历史。返回 "switched" 表示发生了切换 */
  setSessionItem(item) {
    const s = this.session;
    if (!item) return "";
    if (!s.item || s.item.id !== item.id) {
      const hadHistory = s.history.length > 0;
      s.item = item;
      s.history = [];
      s.inputHistory = [];
      s.histIdx = -1;
      return hadHistory ? "switched" : "";
    }
    return "";
  },

  /** 会话条目显示名 */
  _itemTitle() {
    const s = this.session;
    if (!s.item) return "";
    try { return s.item.getDisplayTitle() || ""; } catch (e) { return ""; }
  },

  /* ==================== 会话持久化（chat-sessions.js） ====================
   * 口径：只有「成功轮次写进 history 之后」才落盘；空 history 不落盘，
   * 因此清空会话 = 内存清空 + 删除最近一条同条目记录，不会留下空壳。
   * 恢复时机：新建浮窗 entry 时（_ensure → _build 之后）自动续上最近会话。 */

  /** 当前会话 → ChatSessions.save（自带防御：模块缺位 / 空历史都安全） */
  _saveSession() {
    try {
      if (typeof ChatSessions === "undefined" || !ChatSessions || !ChatSessions.save) return null;
      const s = this.session;
      if (!s || !Array.isArray(s.history) || !s.history.length) return null;
      return ChatSessions.save({
        itemID: s.item && s.item.id ? s.item.id : 0,
        history: s.history,
        chips: this._chipItems().map((it) => it.id),
      });
    } catch (e) {
      this._err(e);
      return null;
    }
  },

  /** 把一条存档灌回内存会话并重绘（chips 按 itemID 重新解析，失效的丢弃） */
  _applySession(rec, entry) {
    const s = this.session;
    if (!rec || !Array.isArray(rec.history) || !rec.history.length) return false;
    const history = [];
    for (const h of rec.history) {
      if (!h || (h.role !== "user" && h.role !== "assistant" && h.role !== "system")) continue;
      if (h.content == null) continue;
      history.push({ role: h.role, content: String(h.content) });
    }
    if (!history.length) return false;
    s.history = history;
    const ids = [];
    for (const id of (Array.isArray(rec.chips) ? rec.chips : [])) {
      if (ids.length >= this.CHIP_MAX) break;
      if (this._resolveChipItem(id)) ids.push(Number(id));
    }
    s.contextItems = ids;
    s.histIdx = -1;
    if (entry) {
      try { this._renderHistory(entry); } catch (e) { /* ignore */ }
      try { this._renderCtxChips(entry); } catch (e) { /* ignore */ }
    }
    return true;
  },

  /**
   * 新建 entry 时自动恢复：
   *   已有上下文 chip → 不动（用户本轮显式拖了条目）
   *   已有内存历史 → 不动；否则先取同条目最近一条，再退全局最近一条
   * 输入框内容一概不动（用户可能已先输入）。
   */
  _restoreSession(entry) {
    try {
      if (typeof ChatSessions === "undefined" || !ChatSessions) return false;
      const s = this.session;
      if (this._chipItems().length) return false;
      if (Array.isArray(s.history) && s.history.length) return false;
      const itemID = s.item && s.item.id ? s.item.id : 0;
      let rec = itemID ? ChatSessions.latestForItem(itemID) : null;
      if (!rec) rec = ChatSessions.latest();
      return this._applySession(rec, entry);
    } catch (e) {
      this._err(e);
      return false;
    }
  },

  /** 删除当前条目对应的存档（同一对话可能有多份快照 → 按 item 清干净） */
  _forgetSavedSession() {
    try {
      if (typeof ChatSessions === "undefined" || !ChatSessions || !ChatSessions.remove) return false;
      const s = this.session;
      const itemID = s.item && s.item.id ? s.item.id : 0;
      let removed = false;
      if (itemID) {
        // 每轮成功问答都会留一份快照（save 不传 id），只删最近一条会让旧快照
        // 在下次打开浮窗时「复活」，因此按条目逐条清。
        for (let i = 0; i <= ChatSessions.MAX_SESSIONS; i++) {
          const rec = ChatSessions.latestForItem(itemID);
          if (!rec || !ChatSessions.remove(rec.id)) break;
          removed = true;
        }
        return removed;
      }
      // 无锁定条目（纯 chip 会话）只能清全局最近一条
      const rec = ChatSessions.latest();
      return rec ? ChatSessions.remove(rec.id) : false;
    } catch (e) {
      return false;
    }
  },

  /** 清空会话：内存 + 存档（save 会跳过空 history，故显式 remove 最近一条） */
  _clearHistory(entry) {
    const s = this.session;
    s.history = [];
    s.inputHistory = [];
    s.histIdx = -1;
    this._forgetSavedSession();
    if (entry) {
      try { this._renderHistory(entry); } catch (e) { /* ignore */ }
    }
  },

  /** ts → 相对时间（历史列表展示用） */
  _relTime(ts) {
    const t = Number(ts) || 0;
    if (!t) return "";
    const diff = Math.max(0, Date.now() - t);
    const min = Math.floor(diff / 60000);
    if (min < 1) return I18n.isZh ? "刚刚" : "just now";
    if (min < 60) return (I18n.isZh ? min + " 分钟前" : min + "m ago");
    const hr = Math.floor(min / 60);
    if (hr < 24) return (I18n.isZh ? hr + " 小时前" : hr + "h ago");
    const day = Math.floor(hr / 24);
    if (day < 30) return (I18n.isZh ? day + " 天前" : day + "d ago");
    return new Date(t).toLocaleDateString();
  },

  /** Agent 决策模型（pref：aiAgentDecisionModel；空 = 不路由） */
  _decisionModel() {
    try {
      const v = Prefs.get("aiAgentDecisionModel", "");
      return v == null ? "" : String(v).trim();
    } catch (e) { return ""; }
  },

  /* ==================== 拖拽条目上下文 chip（0.44.0） ====================
   * 主窗口条目列表拖拽 flavor 为 "zotero/item"（逗号分隔 itemID）。
   * 口径：session.contextItems 非空 → 以 chip 条目为上下文（多篇拼接）；
   *       为空 → 维持「锁定当前条目」的既有行为。 */

  /** drop 数据 → itemID 列表（只认 zotero/item flavor；text/plain 是标题不取） */
  _parseItemDrop(dt) {
    if (!dt) return [];
    let raw = "";
    try { raw = dt.getData("zotero/item") || ""; } catch (e) { return []; }
    if (!raw) return [];
    return String(raw).split(/[,\s]+/)
      .map((x) => parseInt(x, 10))
      .filter((n) => isFinite(n) && n > 0);
  },

  /** itemID → 常规条目（附件上溯父条目；取不到返回 null） */
  _resolveChipItem(id) {
    let it = null;
    try { it = Zotero.Items.get(id); } catch (e) { return null; }
    if (!it) return null;
    try {
      if (it.isRegularItem && it.isRegularItem()) return it;
      if (it.parentItemID) {
        const p = Zotero.Items.get(it.parentItemID);
        if (p) return p;
      }
    } catch (e) { /* ignore */ }
    return null;
  },

  /** 当前 chip 条目对象列表（顺带清掉已失效的 itemID） */
  _chipItems() {
    const s = this.session;
    if (!Array.isArray(s.contextItems)) s.contextItems = [];
    const items = [];
    const alive = [];
    for (const id of s.contextItems) {
      const it = this._resolveChipItem(id);
      if (it) { items.push(it); alive.push(it.id); }
    }
    if (alive.length !== s.contextItems.length) s.contextItems = alive;
    return items;
  },

  /**
   * 加入 chip（去重 + CHIP_MAX 上限）。返回
   * { added:[item], dup:n, overflow:n, invalid:n }，调用方据 overflow/dup 提示。
   */
  addChipItems(ids) {
    const s = this.session;
    if (!Array.isArray(s.contextItems)) s.contextItems = [];
    const res = { added: [], dup: 0, overflow: 0, invalid: 0 };
    for (const id of ids || []) {
      const it = this._resolveChipItem(id);
      if (!it) { res.invalid++; continue; }
      if (s.contextItems.indexOf(it.id) >= 0 ||
          res.added.some((a) => a.id === it.id)) { res.dup++; continue; }
      if (s.contextItems.length + res.added.length >= this.CHIP_MAX) { res.overflow++; continue; }
      res.added.push(it);
    }
    for (const it of res.added) s.contextItems.push(it.id);
    if (res.added.length) this._renderAllCtxChips();
    return res;
  },

  removeChipItem(id) {
    const s = this.session;
    if (!Array.isArray(s.contextItems)) s.contextItems = [];
    const i = s.contextItems.indexOf(id);
    if (i >= 0) {
      s.contextItems.splice(i, 1);
      this._renderAllCtxChips();
    }
  },

  /** 单窗口重绘 chip 行（无 chip 时整行隐藏） */
  _renderCtxChips(entry) {
    const box = entry && entry.refs && entry.refs.ctxChips;
    if (!box) return;
    box.textContent = "";
    const items = this._chipItems();
    box.style.display = items.length ? "flex" : "none";
    const doc = entry.win.document;
    const self = this;
    for (const it of items) {
      let title = "";
      try { title = it.getDisplayTitle() || ""; } catch (e) { /* ignore */ }
      const chip = this._h(doc, "span", {
        class: "pp-cf-ctxchip", title,
        style: "display:inline-flex;align-items:center;gap:4px;max-width:180px;" +
          "padding:1px 4px 1px 8px;font-size:11px;border-radius:10px;" +
          "border:1px solid var(--color-accent,#2563eb);" +
          "background:rgba(45,108,223,.10);color:inherit;",
      });
      chip.appendChild(this._h(doc, "span", {
        style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
      }, title || ("#" + it.id)));
      const x = this._h(doc, "button", {
        type: "button", title: I18n.t("chatChipRemove"),
        style: "flex:none;border:none;background:transparent;color:inherit;" +
          "cursor:pointer;font-size:11px;padding:0 2px;line-height:1;",
      }, "✕");
      x.addEventListener("click", () => self.removeChipItem(it.id));
      chip.appendChild(x);
      box.appendChild(chip);
    }
  },

  _renderAllCtxChips() {
    for (const [, en] of this._wins) {
      try { this._renderCtxChips(en); } catch (e) { /* ignore */ }
    }
  },

  /** 悬浮窗根节点接受条目拖入（dragover 仅对 zotero/item flavor 放行） */
  _bindItemDrop(entry) {
    const { root } = entry;
    const self = this;
    const hasItemFlavor = (dt) => {
      try {
        const types = dt && dt.types ? Array.from(dt.types) : [];
        return types.indexOf("zotero/item") >= 0;
      } catch (e) { return false; }
    };
    root.addEventListener("dragover", (ev) => {
      if (!hasItemFlavor(ev.dataTransfer)) return;
      ev.preventDefault();
      try { ev.dataTransfer.dropEffect = "copy"; } catch (e) { /* ignore */ }
    });
    root.addEventListener("drop", (ev) => {
      const ids = self._parseItemDrop(ev.dataTransfer);
      if (!ids.length) return;
      ev.preventDefault();
      const r = self.addChipItems(ids);
      if (r.overflow > 0) {
        self._appendBubble(entry, "sys", I18n.t("chatChipLimit"), "#c0392b");
      } else if (r.added.length === 0 && r.dup > 0) {
        self._appendBubble(entry, "sys", I18n.t("chatChipDup"), "#888");
      }
    });
  },

  /**
   * 多篇上下文消息构造（chip 模式）：每篇「文献 n」标记 + 题录，
   * 全文优先（单篇截断 CHIP_TEXT_MAX）、无全文回退摘要、再退化为仅题录。
   * 比单篇 buildMessages 更宽容：单篇取不到全文/摘要不抛 NO_PDF。
   */
  async _buildChipsMessages(items, question) {
    const zh = I18n.isZh;
    const blocks = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const meta = AIChat.paperMeta(it);
      let body = "";
      let kind = "";
      try { body = (await AIChat.getFullText(it)) || ""; } catch (e) { body = ""; }
      if (body) {
        kind = zh ? "全文" : "full text";
        if (body.length > this.CHIP_TEXT_MAX) {
          body = body.slice(0, this.CHIP_TEXT_MAX) +
            (zh ? "\n[……单篇已截断……]" : "\n[...truncated...]");
        }
      } else {
        try { body = it.getField("abstractNote") || ""; } catch (e) { body = ""; }
        kind = zh ? "摘要" : "abstract";
      }
      let head = `【文献 ${i + 1}】${meta.title}`;
      const byline = [meta.creators, (meta.pub + " " + meta.year).trim()]
        .filter(Boolean).join(" · ");
      if (byline) head += `\n${byline}`;
      blocks.push(body
        ? `${head}\n（${kind}）\n${body}`
        : `${head}\n（${zh ? "仅题录，无全文/摘要" : "metadata only"}）`);
    }
    const sys = (Prefs.get("aiSystemPrompt", "") || "") +
      (() => {
        // 0.49.0 研究者画像：与 ai/chat.js._systemWith 同款注入（多 chip 路径）
        let p = "";
        try { p = String(Prefs.get("researcherProfile", "") || "").trim(); } catch (e) { p = ""; }
        return p ? `\n\n【研究者画像（长期偏好，回答时应遵守）】\n${p}` : "";
      })() +
      (() => {
        // 0.51.0 长期记忆注入（与 ai/chat.js._systemWith 同款）
        let m = "";
        try {
          m = (typeof AgentMemory !== "undefined" && AgentMemory
            && typeof AgentMemory.asPromptBlock === "function")
            ? String(AgentMemory.asPromptBlock(20) || "").trim() : "";
        } catch (e) { m = ""; }
        return m ? `\n\n【长期记忆（此前对话中确认的事实与偏好）】\n${m}` : "";
      })() +
      (zh
        ? `\n\n用户提供了 ${items.length} 篇文献作为上下文（每篇以「文献 n」标记）。` +
          "回答要求：只基于这些文献的内容；文献未提及的信息明确说明；" +
          "引用观点注明出自「文献 n」；你的推断与文献原文分开表述。\n\n"
        : `\n\nThe user provided ${items.length} papers as context (each marked "文献 n"). ` +
          "Answer only from them; state clearly when information is missing; " +
          "cite sources as 文献 n; separate your inference from the source text.\n\n") +
      blocks.join("\n\n----\n\n");
    const messages = [{ role: "system", content: sys }];
    messages.push(...AIChat.windowHistory(this.session.history, Prefs.get("aiHistoryRounds", 6)));
    messages.push({ role: "user", content: question });
    return messages;
  },

  /* ==================== AI 回答内引用可点击（0.51.0） ====================
   * 多 chip 会话里模型按「文献 n」标注来源，这里把气泡里的「文献 n」变成
   * 可点击片段 → 选中对应条目。三条约束决定了实现形态：
   *   · 只处理 assistant 气泡（user/系统气泡保持纯文本）；
   *   · MdLite 会转义正文里的原始 HTML（inline() 先 escape），因此无法靠
   *     在 Markdown 里写 <a>；改为对 toHtml() 结果做「标签外文本」重写：
   *     不碰属性、跳过 <pre>/<code> 内容，渲染与历史重建走同一条路径；
   *   · chip 为空 / n 越界 / pref 关闭 → 原样纯文本，零副作用。 */

  /** pref：AI 回答内引用可点击（默认开；坏值/读不到都按开处理） */
  _citeLinksEnabled() {
    try {
      const v = Prefs.get("citeLinksEnabled", true);
      if (v === false || v === 0 || v === "false" || v === "0") return false;
      return true;
    } catch (e) {
      return true;
    }
  },

  /**
   * 纯函数：正文里所有「文献 n」引用的位置（供渲染层与测试复用）。
   * 规则：`文献` + 可选空白 + 1-9 单个数字；命中后要求下一个字符不是
   * 汉字/字母/数字（排除「文献 10」「文献 2表明」「文献综述」）；
   * 「参考文献 n」是书目用语，不算正文引用。
   * @param {string} text
   * @returns {Array<{n:number,start:number,end:number}>} start 含、end 不含
   */
  _citeRefsOf(text) {
    const s = String(text == null ? "" : text);
    const re = /文献\s*([1-9])/g;
    const out = [];
    let m;
    while ((m = re.exec(s))) {
      const start = m.index;
      const end = start + m[0].length;
      if (start >= 2 && s.slice(start - 2, start) === "参考") continue;
      const next = s.charAt(end);
      if (next && /[A-Za-z0-9\u4e00-\u9fff]/.test(next)) continue;
      out.push({ n: parseInt(m[1], 10), start, end });
    }
    return out;
  },

  /** 属性值转义（MdLite.escape 不管引号，title 里可能有 "） */
  _escAttr(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  },

  /** 单个文本片段 → 带引用 span 的 HTML（越界的 n 保持纯文本） */
  _citeTextToHtml(seg, items) {
    const refs = this._citeRefsOf(seg);
    if (!refs.length) return seg;
    let out = "";
    let last = 0;
    for (const r of refs) {
      const it = items[r.n - 1];
      const id = it && it.id;
      if (!id) continue;
      let title = "";
      try { title = it.getDisplayTitle() || ""; } catch (e) { title = ""; }
      out += seg.slice(last, r.start);
      out += '<span class="pp-cf-cite" data-item-id="' + id +
        '" title="' + this._escAttr(title) + '">' + seg.slice(r.start, r.end) + "</span>";
      last = r.end;
    }
    if (!last) return seg;
    return out + seg.slice(last);
  },

  /**
   * HTML → 引用可点击 HTML：按标签切段，只改写标签外的文本；
   * pre/code 内部（代码块、行内代码）保持原样，避免破坏示例文本。
   */
  _decorateCites(html, items) {
    const src = String(html == null ? "" : html);
    const list = Array.isArray(items) ? items : [];
    if (!src || !list.length) return src;
    const parts = src.split(/(<[^>]*>)/);
    let depth = 0;
    let out = "";
    for (const seg of parts) {
      if (!seg) continue;
      if (seg.charAt(0) === "<" && seg.charAt(seg.length - 1) === ">") {
        if (/^<(pre|code)\b/i.test(seg)) depth++;
        else if (/^<\/(pre|code)>/i.test(seg)) depth = Math.max(0, depth - 1);
        out += seg;
        continue;
      }
      out += depth > 0 ? seg : this._citeTextToHtml(seg, list);
    }
    return out;
  },

  /** assistant 气泡统一渲染入口（历史重建 / 流式增量 / onDone 共用） */
  _renderAssistant(entry, bubble, text) {
    let html = null;
    try { html = MdLite.toHtml(text); } catch (e) { html = null; }
    if (html == null) {
      bubble.textContent = text;
      return bubble;
    }
    let out = html;
    try {
      if (this._citeLinksEnabled()) out = this._decorateCites(html, this._chipItems());
    } catch (e) { out = html; }
    try { bubble.innerHTML = out; } catch (e) { bubble.textContent = text; return bubble; }
    this._bindCiteClicks(entry, bubble);
    return bubble;
  },

  /** 给已渲染的引用片段挂点击（innerHTML 重建后需重新挂） */
  _bindCiteClicks(entry, bubble) {
    let spans = [];
    try {
      spans = (bubble && bubble.querySelectorAll)
        ? Array.prototype.slice.call(bubble.querySelectorAll(".pp-cf-cite"))
        : [];
    } catch (e) { spans = []; }
    const self = this;
    for (const sp of spans) {
      sp.addEventListener("click", (ev) => {
        try { ev.preventDefault(); ev.stopPropagation(); } catch (e) { /* ignore */ }
        let id = 0;
        try { id = parseInt(sp.getAttribute("data-item-id"), 10); } catch (e) { id = 0; }
        self._focusItem(entry, id);
      });
    }
  },

  /**
   * 引用跳转：默认只选中条目（不打断阅读器，PDF 不主动打开）；
   * 条目已被删除 → 系统气泡提示；跳转异常静默 log。
   * @returns {boolean} 是否成功选中
   */
  _focusItem(entry, itemID) {
    const id = parseInt(itemID, 10);
    let item = null;
    try { item = (isFinite(id) && id > 0) ? Zotero.Items.get(id) : null; }
    catch (e) { item = null; }
    if (!item) {
      if (entry) {
        try {
          this._appendBubble(entry, "sys",
            I18n.isZh ? "引用条目已不存在" : "The cited item no longer exists", "#c0392b");
        } catch (e) { /* 无消息区的自定义 entry：静默 */ }
      }
      return false;
    }
    try {
      const pane = Zotero.getActiveZoteroPane();
      if (!pane || typeof pane.selectItem !== "function") throw new Error("no zotero pane");
      pane.selectItem(item.id);
      return true;
    } catch (e) {
      this._err(e);
      return false;
    }
  },

  /* ==================== 发送（单源：悬浮窗 / 独立窗口共用） ==================== */

  /**
   * 执行一轮问答。ui 回调集合：
   * { onUser(q), onStatus(text), onDelta(acc), onDone(text),
   *   onError(msg), onAbort(), onBusy(busy) }
   * 成功才写 session.history（失败轮次可重试，不脏历史）。
   */
  async runSend(question, ui) {
    const s = this.session;
    if (s.busy || !question || !question.trim()) return;
    question = question.trim();

    if (!AIClient.hasKey()) {
      if (ui.onError) ui.onError(I18n.t("chatNoKey"));
      return;
    }
    // 0.44.0：chip 上下文优先于「锁定条目」——有 chip 时不再要求锁定条目
    const chipItems = this._chipItems();
    if (!chipItems.length && !s.item) {
      const it = this._resolveItem();
      if (it) {
        const r = this.setSessionItem(it);
        if (ui.onItemChanged) ui.onItemChanged(this._itemTitle(), r === "switched");
      }
    }
    if (!chipItems.length && !s.item) {
      if (ui.onError) ui.onError(I18n.t("chatNoItem"));
      return;
    }

    s.busy = true;
    if (ui.onBusy) ui.onBusy(true);
    if (ui.onUser) ui.onUser(question);
    try {
      if (ui.onStatus) ui.onStatus(I18n.t("chatReading"));
      let messages;
      if (chipItems.length) {
        messages = await this._buildChipsMessages(chipItems, question);
      } else {
        const fullText = await AIChat.getFullText(s.item);
        messages = await AIChat.buildMessages(s.item, question, s.history, fullText || undefined);
      }

      let acc = "";
      const useStream = Prefs.get("readerPopupStream", true) && AIClient.chatStream;
      // 0.48.0 Agent 模式（交互参考 Hermes Agent）：AI 可多轮调用工具（检索库 /
      // 读全文 / 加笔记 / 打标签），任务先规划后执行，过程在 UI 以系统气泡呈现；
      // 关闭时保持原纯问答路径（零回归）。
      if (this._agentReady()) {
        acc = await this._runAgentTurn(messages, ui);
      } else if (useStream) {
        const handle = AIClient.chatStream(messages, (chunk) => {
          acc += chunk;
          if (ui.onDelta) ui.onDelta(acc);
        });
        s.handle = handle;
        acc = await handle.promise;
      } else {
        acc = await AIClient.chat(messages);
      }
      s.history.push({ role: "user", content: question });
      s.history.push({ role: "assistant", content: acc });
      if (s.inputHistory[s.inputHistory.length - 1] !== question) {
        s.inputHistory.push(question);
        if (s.inputHistory.length > 30) s.inputHistory.shift();
      }
      s.histIdx = -1;
      // 会话持久化：assistant 回答写完 history 后落盘（失败静默，不影响问答）
      this._saveSession();
      if (ui.onDone) ui.onDone(acc);
      // 0.40.0 价值感知：官方通道调用后回报「本次消耗 + 剩余额度」（异步、静默、不阻塞）
      this._reportCost(ui);
    } catch (e) {
      if (e && e.message === "ABORTED") {
        if (ui.onAbort) ui.onAbort();
      } else {
        const msg = e && e.message === "NO_PDF" ? I18n.t("chatNoPdf")
          : I18n.t("errPrefix") + ((e && e.message) || e);
        if (ui.onError) ui.onError(msg);
      }
      this._err(e && e.message === "ABORTED" ? new Error("chat aborted") : e);
    } finally {
      s.busy = false;
      s.handle = null;
      if (ui.onBusy) ui.onBusy(false);
    }
  },

  /**
   * 0.40.0 价值感知：官方通道调用成功后，异步取回「本次消耗 + 剩余额度」回报给 UI。
   * 三条边界（都踩得起，但都必须守住）：
   *   · **仅官方通道** —— 自带 Key 通道不经本站、不计量，给它显示 ¥0 是误导；
   *   · **at 未变则跳过** —— 本次调用可能压根没计费（成本取整为 0 / 上游未返回
   *     usage），此时拿上一次的流水当「本次」是错的，宁可不显示；
   *   · **全程静默** —— 取不到就不显示，绝不影响回答本身。
   * 另：只调 Account.refreshCost（不落盘、不重绘），见 account.js 的说明。
   */
  _reportCost(ui) {
    try {
      if (!ui || !ui.onCost) return;
      if (typeof Account === "undefined" || !Account || !Account.cost) return;
      const cfg = (typeof AIClient !== "undefined" && AIClient._config) ? AIClient._config() : null;
      if (!cfg || cfg.channelId !== "official") return;
      const before = Account.cost();
      const prevAt = before && before.last ? before.last.at : null;
      Promise.resolve()
        .then(() => Account.refreshCost())
        .then(() => {
          const c = Account.cost();
          const last = c && c.last;
          if (!last || !last.text || last.at === prevAt) return;
          const bal = Account.balance ? Account.balance() : null;
          try {
            ui.onCost({ costText: last.text, balanceText: (bal && bal.text) || "" });
          } catch (e) { /* UI 回调不得拖死流程 */ }
        })
        .catch(() => { /* 静默 */ });
    } catch (e) { /* 静默 */ }
  },

  /** 停止当前生成（流式 abort；非流式在 runSend 侧无句柄，忽略） */
  stop() {
    const s = this.session;
    if (s.handle) {
      try { s.handle.abort(); } catch (e) { /* ignore */ }
    }
  },

  /* ==================== Agent 模式（0.48.0，交互参考 Hermes Agent） ==================== */

  /** Agent 模式是否可用：开关开 + AgentTools 就绪 + 至少一个工具启用 */
  _agentReady() {
    try {
      if (Prefs.get("chatAgentMode", false) !== true) return false;
      if (typeof AgentTools === "undefined" || !AgentTools) return false;
      return AgentTools.enabledTools().length > 0;
    } catch (e) { return false; }
  },

  /**
   * 一轮 Agent 问答：注入工具协议 → 推理循环（LLM ↔ 工具）→ 最终回答。
   * 中间轮的原始输出（含工具 JSON）不进消息区，工具过程经 ui.onToolStep /
   * ui.onStatus 以系统气泡呈现（Hermes「围观思考过程」）；最终回答由
   * runSend 统一 onDone 渲染。abort：每轮流式句柄挂 s.handle，stop() 照常生效。
   */
  async _runAgentTurn(messages, ui) {
    const s = this.session;
    let maxSteps = Number(Prefs.get("aiAgentMaxSteps", 5));
    if (!isFinite(maxSteps) || maxSteps < 1) maxSteps = 5;
    const useStream = Prefs.get("readerPopupStream", true) && AIClient.chatStream;
    // 决策模型路由（可选 pref）：工具决策轮走轻量模型，收敛轮仍走主通道模型。
    // 空值 = 全程主通道（与旧行为完全一致）。
    const decisionModel = this._decisionModel();
    let llmCalls = 0;
    const r = await AgentTools.runAgentLoop({
      messages: AgentTools.augmentMessages(messages),
      maxSteps,
      callLLM: async (msgs) => {
        // 第 maxSteps+1 次调用是循环的收敛轮（不再允许工具调用）→ 不路由
        const opts = (decisionModel && llmCalls < maxSteps) ? { model: decisionModel } : null;
        llmCalls++;
        if (useStream) {
          const handle = AIClient.chatStream(msgs, () => {
            /* agent 中间轮含工具 JSON，不流式进 UI；最终回答由 onDone 渲染 */
          }, opts);
          s.handle = handle;
          return await handle.promise;
        }
        return await AIClient.chat(msgs, opts);
      },
      runTool: async (id, args) => {
        if (ui.onStatus) ui.onStatus(I18n.t("agentToolCalling") + " " + id + "…");
        const res = await AgentTools.execTool(id, args, { item: s.item });
        if (ui.onToolStep) { try { ui.onToolStep(id, args, res); } catch (e) { /* ignore */ } }
        return res;
      },
    });
    if (r.limited && ui.onStatus) {
      try { ui.onStatus(I18n.t("agentLimited")); } catch (e) { /* ignore */ }
    }
    // 技能沉淀提示：本次问答确实用了多次工具 → 建议存成命令标签（每轮最多一次）
    if (r.steps && r.steps.length >= 2 && ui && typeof ui.onSys === "function") {
      try {
        ui.onSys("本次任务用了 " + r.steps.length +
          " 次工具调用——输入 /distill（沉淀）可保存为命令标签复用", "#0d9488");
      } catch (e) { /* ignore */ }
    }
    return r.answer;
  },

  /** 把当前会话保存为笔记（悬浮窗 / 独立窗口共用；成功返回 true） */
  async saveHistoryAsNote(ui) {
    const s = this.session;
    // 0.44.0：chip 模式下未锁定条目时，笔记挂到第一篇 chip 条目
    const noteItem = s.item || this._chipItems()[0] || null;
    if (!noteItem || !s.history.length) {
      if (ui && ui.onError) ui.onError(I18n.t("chatEmptyHistory"));
      return false;
    }
    try {
      const md = s.history
        .map(h => (h.role === "user" ? "**问：** " : "**答：** ") + h.content)
        .join("\n\n");
      await Notes.createFromMarkdown(
        noteItem,
        `${I18n.t("noteChatTitle")}｜${noteItem.getDisplayTitle() || ""}`,
        md
      );
      return true;
    } catch (e) {
      this._err(e);
      if (ui && ui.onError) ui.onError(I18n.t("errPrefix") + ((e && e.message) || e));
      return false;
    }
  },

  /**
   * 技能沉淀（任务 → 命令标签）：把最近一条 user 消息存成 CommandTags 标签，
   * 之后可在标签区单击复用或输入「/」选择。label 取压平空白后的前 14 字
   * （截断补「…」），与已有标签重名时追加「 2」「 3」…
   * @returns {object|null} 新建标签；无问答 / CommandTags 不可用时 null
   */
  _distillLastTask(entry) {
    const s = this.session;
    let prompt = "";
    if (Array.isArray(s.history)) {
      for (let i = s.history.length - 1; i >= 0; i--) {
        const h = s.history[i];
        if (h && h.role === "user" && h.content != null && String(h.content).trim()) {
          prompt = String(h.content).trim();
          break;
        }
      }
    }
    if (!prompt) {
      if (entry) this._appendBubble(entry, "sys", "还没有可沉淀的问答", "#888");
      return null;
    }
    if (typeof CommandTags === "undefined" || !CommandTags || !CommandTags.upsert) {
      if (entry) this._appendBubble(entry, "sys", "命令标签不可用，无法沉淀", "#c0392b");
      return null;
    }

    const flat = prompt.replace(/\s+/g, " ").trim();
    let label = flat.slice(0, 14) + (flat.length > 14 ? "…" : "");
    let tags = [];
    try { tags = this._tagList() || []; } catch (e) { tags = []; }
    const base = label;
    let n = 2;
    while (tags.some((t) => t && t.label === label)) label = base + " " + (n++);

    // 颜色：沿用 CommandTags 调色板轮转（无调色板则空）
    let color = "";
    try {
      const pal = CommandTags._PALETTE || [];
      if (pal.length) color = String(pal[tags.length % pal.length] || "");
    } catch (e) { color = ""; }

    const id = "pf:" + Date.now().toString(36);
    let saved = null;
    try {
      saved = CommandTags.upsert({ id, label, prompt, color, trigger: "" });
    } catch (e) { this._err(e); saved = null; }
    if (!saved) {
      if (entry) this._appendBubble(entry, "sys", "沉淀失败：命令标签写入异常", "#c0392b");
      return null;
    }
    try { this._renderAllChips(); } catch (e) { /* ignore */ }
    if (entry) {
      this._appendBubble(entry, "sys",
        "✓ 已沉淀为命令标签「" + label + "」——在输入框输入 / 可直接发送；" +
        "长按标签可编辑或删除", "#1e7d32");
    }
    return saved;
  },

  /* ==================== 悬浮窗：构建与几何 ==================== */

  _entry(win) {
    const existed = this._wins.get(win);
    if (existed && existed.root && this._isAlive(existed.root)) return existed;
    // 窗口已关闭的旧条目顺带清理，防 Map 堆积
    for (const [w, e] of this._wins) {
      if (e !== existed) {
        try { if (!this._isAlive(e.root)) this._wins.delete(w); }
        catch (err) { this._wins.delete(w); }
      }
    }
    return null;
  },

  _isAlive(node) {
    try { return !!(node && node.isConnected); } catch (e) { return false; }
  },

  _ensure(win) {
    let entry = this._entry(win);
    if (!entry) {
      entry = this._build(win);
      // 新建实例：自动续上最近会话（同条目优先，其次全局最近一条）
      this._restoreSession(entry);
    } else {
      // 换过主题/壁纸的窗口：样式表若被清掉则补挂
      this._ensureStyle(win);
    }
    return entry;
  },

  _build(win) {
    const doc = win.document;
    this._ensureStyle(win);

    const root = this._h(doc, "div", {
      id: this.ROOT_ID,
      style: "position:fixed;z-index:99999;display:none;flex-direction:column;" +
        "box-sizing:border-box;border-radius:8px;overflow:hidden;" +
        "background:var(--material-surface,#ffffff);color:var(--fill-primary,#222222);" +
        "border:1px solid var(--color-border,rgba(128,128,128,.4));" +
        "box-shadow:0 10px 40px rgba(0,0,0,.35);font-size:13px;line-height:1.55;" +
        "-moz-window-dragging:no-drag;",
    });

    // ---- 标题栏（拖动手柄）----
    const head = this._h(doc, "div", {
      style: "display:flex;align-items:center;gap:6px;padding:6px 8px;cursor:move;" +
        "background:var(--fill-quinary,rgba(128,128,128,.08));" +
        "border-bottom:1px solid var(--color-border,rgba(128,128,128,.3));user-select:none;",
    });
    const icon = this._chatIcon(doc, 13);
    const titleEl = this._h(doc, "span", {
      style: "font-weight:600;font-size:12.5px;white-space:nowrap;overflow:hidden;" +
        "text-overflow:ellipsis;flex:1;min-width:60px;cursor:default;",
    }, I18n.t("chatFloatTitle"));
    head.appendChild(icon);
    head.appendChild(titleEl);

    const mkHeadBtn = (label, tip, css) => {
      const b = this._h(doc, "button", {
        type: "button", title: tip,
        style: css || "flex:none;width:22px;height:22px;padding:0 4px;border-radius:4px;" +
          "border:1px solid transparent;background:transparent;color:inherit;" +
          "font-size:12px;line-height:1;cursor:pointer;white-space:nowrap;",
      }, label);
      b.addEventListener("mouseover", () => {
        b.style.background = "var(--fill-quinary,rgba(128,128,128,.15))";
      });
      b.addEventListener("mouseout", () => { b.style.background = "transparent"; });
      return b;
    };
    const undockBtn = mkHeadBtn("↔", I18n.t("chatFloatUndock"), null);
    undockBtn.style.display = "none";
    const dockLBtn = mkHeadBtn("«", I18n.t("chatFloatDockLeft"), null);
    const dockRBtn = mkHeadBtn("»", I18n.t("chatFloatDockRight"), null);
    const opBtn = mkHeadBtn("◐", I18n.t("chatFloatOpacity"), null);
    const popBtn = mkHeadBtn("⧉", I18n.t("chatFloatPopout"), null);
    const closeTip = I18n.isZh ? "关闭 (Esc)" : "Close (Esc)";
    const closeBtn = mkHeadBtn("✕", closeTip, null);
    for (const b of [undockBtn, dockLBtn, dockRBtn, opBtn, popBtn, closeBtn]) head.appendChild(b);

    // ---- 消息区 ----
    const msgs = this._h(doc, "div", {
      style: "flex:1;min-height:0;overflow-y:auto;padding:8px;display:flex;" +
        "flex-direction:column;gap:6px;scrollbar-width:thin;",
    });

    // ---- Prompt 快捷标签（zotero-gpt Command Tag 同款：可编辑/触发正则/导入导出）----
    const chips = this._h(doc, "div", {
      style: "display:flex;flex-wrap:wrap;gap:4px;padding:0 8px 6px;",
    });

    // ---- 上下文 chip 行（拖入条目生成；空时隐藏）----
    const ctxChips = this._h(doc, "div", {
      class: "pp-cf-ctx",
      style: "display:none;flex-wrap:wrap;gap:4px;padding:0 8px 6px;",
    });

    // ---- 输入行 ----
    const inputRow = this._h(doc, "div", {
      style: "display:flex;gap:6px;align-items:flex-end;padding:0 8px 8px;",
    });
    const input = this._h(doc, "textarea", {
      rows: "2", placeholder: I18n.t("chatPlaceholder"),
      style: "flex:1;min-width:0;resize:none;padding:4px 6px;font-size:13px;" +
        "font-family:inherit;border-radius:5px;color:inherit;" +
        "border:1px solid var(--color-border,rgba(128,128,128,.4));" +
        "background:var(--fill-quinary,rgba(128,128,128,.05));",
    });
    const sideCol = this._h(doc, "div", { style: "display:flex;flex-direction:column;gap:4px;" });
    const sendBtn = this._h(doc, "button", {
      type: "button",
      style: "padding:4px 14px;font-size:12.5px;border-radius:5px;cursor:pointer;" +
        "border:1px solid var(--color-border,rgba(128,128,128,.4));" +
        "background:var(--color-accent,#2563eb);color:#fff;font-weight:600;white-space:nowrap;",
    }, I18n.t("chatSend"));
    const minorBtn = (label) => this._h(doc, "button", {
      type: "button",
      style: "padding:2px 6px;font-size:11px;border-radius:4px;cursor:pointer;" +
        "border:1px solid var(--color-border,rgba(128,128,128,.4));" +
        "background:transparent;color:var(--fill-secondary,#666);white-space:nowrap;",
    }, label);
    const saveBtn = minorBtn(I18n.t("chatSave"));
    const clearBtn = minorBtn(I18n.t("chatClear"));
    sideCol.appendChild(sendBtn);
    sideCol.appendChild(saveBtn);
    sideCol.appendChild(clearBtn);
    inputRow.appendChild(input);
    inputRow.appendChild(sideCol);

    // ---- 缩放手柄 ----
    const grip = this._h(doc, "div", {
      style: "position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;" +
        "background:linear-gradient(135deg,transparent 50%,var(--fill-tertiary,rgba(128,128,128,.5)) 50%);",
    });

    root.appendChild(head);
    root.appendChild(msgs);
    root.appendChild(chips);
    root.appendChild(ctxChips);
    root.appendChild(inputRow);
    root.appendChild(grip);
    doc.documentElement.appendChild(root);

    const entry = {
      win, root, grip,
      refs: { head, titleEl, undockBtn, dockLBtn, dockRBtn, opBtn, popBtn, closeBtn,
        msgs, chips, ctxChips, input, sendBtn, saveBtn, clearBtn },
      geo: this._restoreGeo(),
    };
    this._wins.set(win, entry);

    // ---- Prompt 标签区填充（单击发送 / 长按编辑 / ＋新建）----
    this._renderChips(entry);
    // ---- 上下文 chip 行（会话里可能已有拖入条目）----
    this._renderCtxChips(entry);
    this._bindItemDrop(entry);

    // ---- 几何与外观应用 ----
    this._applyGeo(entry);
    root.style.opacity = String(Prefs.get("chatFloatOpacity", "1") || "1");

    // ---- 事件 ----
    this._bindHeadDrag(entry);
    this._bindResize(entry);
    this._bindEsc(win);

    const self = this;
    const doSend = () => this._doSend(entry);
    sendBtn.addEventListener("click", doSend);
    input.addEventListener("keydown", (ev) => {
      // 「/」命令面板打开时，Enter/↑↓ 全部让位给面板（SlashCommands 自己的
      // 监听在本监听之后注册，这里直接 return 即可）
      if (entry.slash && entry.slash.isOpen && entry.slash.isOpen()) return;
      if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        doSend();
      } else if (ev.key === "ArrowUp" && ev.selectionStart === 0 && ev.selectionEnd === 0) {
        // ↑：回溯输入历史（zotero-gpt 同款）
        const s = self.session;
        if (s.inputHistory.length) {
          ev.preventDefault();
          if (s.histIdx === -1) s.histIdx = s.inputHistory.length - 1;
          else if (s.histIdx > 0) s.histIdx--;
          input.value = s.inputHistory[s.histIdx] || "";
        }
      } else if (ev.key === "ArrowDown" && ev.selectionStart === input.value.length) {
        const s = self.session;
        if (s.histIdx !== -1) {
          ev.preventDefault();
          if (s.histIdx < s.inputHistory.length - 1) {
            s.histIdx++;
            input.value = s.inputHistory[s.histIdx] || "";
          } else {
            s.histIdx = -1;
            input.value = "";
          }
        }
      }
    });
    saveBtn.addEventListener("click", async () => {
      saveBtn.disabled = true;
      const ok = await self.saveHistoryAsNote({
        onError: (m) => self._appendBubble(entry, "sys", m, "#c0392b"),
      });
      saveBtn.disabled = false;
      if (ok) self._appendBubble(entry, "sys", "✓ " + I18n.t("chatSaved"), "#1e7d32");
    });
    clearBtn.addEventListener("click", () => {
      self._clearHistory(entry);
    });
    dockLBtn.addEventListener("click", () => self._dock(entry, "left"));
    dockRBtn.addEventListener("click", () => self._dock(entry, "right"));
    undockBtn.addEventListener("click", () => self._dock(entry, ""));
    opBtn.addEventListener("click", () => {
      const cur = String(Prefs.get("chatFloatOpacity", "1") || "1");
      let idx = self.OPACITY_STEPS.indexOf(cur);
      idx = (idx + 1) % self.OPACITY_STEPS.length;
      const v = self.OPACITY_STEPS[idx];
      try { Prefs.set("chatFloatOpacity", v); } catch (e) { /* ignore */ }
      for (const [, en] of self._wins) {
        try { en.root.style.opacity = v; } catch (e) { /* ignore */ }
      }
    });
    popBtn.addEventListener("click", () => {
      if (self.session.busy) {
        self._appendBubble(entry, "sys", I18n.t("popupBusyHint"), "#888");
        return;
      }
      self.hide(win);
      self.openWindow();
    });
    closeBtn.addEventListener("click", () => self.hide(win));

    this._renderHistory(entry);

    // ---- 「/」命令面板（0.48.0，Hermes 式快捷指令：会话命令 + Prompt 标签）----
    try {
      if (typeof SlashCommands !== "undefined" && SlashCommands) {
        entry.slash = SlashCommands.attach({
          doc, input, anchor: inputRow,
          getCommands: () => this._slashCommands(entry),
        });
      }
    } catch (e) { this._err(e); }

    return entry;
  },

  /**
   * 「/」命令清单（浮窗输入框）：会话操作 + Agent 开关 + Prompt 标签直达。
   * SlashCommands 执行前会清空输入框；「发送类」命令在 run 里回填输入再 _doSend。
   */
  _slashCommands(entry) {
    const s = this.session;
    const self = this;
    const cmds = [
      { id: "clear", title: I18n.t("chatClear") + " · 清空当前对话", hint: "session",
        run() { self._clearHistory(entry); } },
      { id: "save", title: I18n.t("chatSave") + " · 把对话保存为笔记", hint: "note",
        run() {
          entry.refs.saveBtn.click();
        } },
      { id: "stop", title: I18n.t("popupStop") + " · 停止当前生成", hint: "abort",
        run() { self.stop(); } },
      { id: "agent", title: (self._agentReady() ? "关闭" : "开启") + "智能体模式（AI 可调用工具检索/读写文献库）", hint: "tools",
        run() {
          try {
            Prefs.set("chatAgentMode", !self._agentReady());
            self._appendBubble(entry, "sys",
              self._agentReady() ? I18n.t("agentModeOn") : I18n.t("agentModeOff"), "#0d9488");
          } catch (e) { /* ignore */ }
        } },
      { id: "tools", title: "查看智能体可用工具清单", hint: "agent",
        run() {
          let list = "";
          try {
            list = AgentTools.enabledTools()
              .map((t) => "🔧 " + t.id + " · " + t.label + "（" + t.desc + "）")
              .join("\n");
          } catch (e) { list = ""; }
          self._appendBubble(entry, "sys",
            list || I18n.t("agentNoTools"), "#0d9488");
        } },
      // 会话持久化：/history 直接续上最近一条；/sessions 只读列出定位用
      { id: "history", title: "恢复历史会话（最近一条）", hint: "session",
        run() {
          if (typeof ChatSessions === "undefined" || !ChatSessions) {
            self._appendBubble(entry, "sys", "会话持久化不可用", "#c0392b");
            return;
          }
          const itemID = s.item && s.item.id ? s.item.id : 0;
          const rec = (itemID ? ChatSessions.latestForItem(itemID) : null) || ChatSessions.latest();
          if (!rec) {
            self._appendBubble(entry, "sys", "还没有可恢复的历史会话", "#888");
            return;
          }
          if (!self._applySession(rec, entry)) {
            self._appendBubble(entry, "sys", "该会话没有可恢复的内容", "#888");
            return;
          }
          self._appendBubble(entry, "sys",
            "已恢复最近会话「" + (rec.title || "") + "」；更早的可用 /sessions 查看", "#0d9488");
        } },
      { id: "sessions", title: "查看最近 10 条历史会话", hint: "session",
        run() {
          let rows = [];
          try {
            rows = (typeof ChatSessions !== "undefined" && ChatSessions)
              ? ChatSessions.list(10) : [];
          } catch (e) { rows = []; }
          if (!rows.length) {
            self._appendBubble(entry, "sys", "还没有历史会话", "#888");
            return;
          }
          const lines = rows.map((r, i) =>
            (i + 1) + ". " + (r.title || "(无标题)") +
            " · " + self._relTime(r.ts) +
            " · " + r.count + (I18n.isZh ? " 条" : " msgs") +
            " · " + String(r.id).slice(0, 8)
          );
          self._appendBubble(entry, "sys",
            (I18n.isZh ? "最近会话（最新在前）：\n" : "Recent sessions:\n") +
            lines.join("\n") +
            (I18n.isZh ? "\n\n输入 /history 恢复最近一条。" : "\n\nType /history to restore the latest."),
            "#0d9488");
        } },
      { id: "distill", title: "沉淀为命令标签（把最近一个问题保存为标签）", hint: "tag",
        run() { self._distillLastTask(entry); } },
    ];
    // Prompt 标签直达（CommandTags；点击即按标签提示词发送）
    try {
      for (const t of this._tagList()) {
        if (!t.prompt) continue;
        cmds.push({
          id: t.id,
          title: "发送标签 · " + t.label,
          hint: String(t.prompt || "").replace(/\s+/g, " ").slice(0, 36),
          run({ input }) {
            input.value = t.prompt;
            self._doSend(entry);
          },
        });
      }
    } catch (e) { /* 标签不可用则只有会话命令 */ }
    return cmds;
  },

  _chatIcon(doc, size) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = doc.createElementNS(NS, "svg");
    svg.setAttribute("width", size);
    svg.setAttribute("height", size);
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    svg.style.pointerEvents = "none";
    svg.style.flex = "none";
    const path = doc.createElementNS(NS, "path");
    path.setAttribute("d",
      "M13.5 10.5c0 .8-.7 1.5-1.5 1.5H8.2L5 15v-3H4c-.8 0-1.5-.7-1.5-1.5v-6C2.5 3.7 3.2 3 4 3h8c.8 0 1.5.7 1.5 1.5v6z");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.5");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
    for (let i = 0; i < 3; i++) {
      const c = doc.createElementNS(NS, "circle");
      c.setAttribute("cx", String(5.5 + i * 2.5));
      c.setAttribute("cy", "7.5");
      c.setAttribute("r", "0.9");
      c.setAttribute("fill", "currentColor");
      svg.appendChild(c);
    }
    return svg;
  },

  /** 样式表随 root 挂载（主题/壁纸刷新清掉时可补挂） */
  _ensureStyle(win) {
    try {
      const doc = win.document;
      if (doc.getElementById(this.STYLE_ID) && this._isAlive(doc.getElementById(this.STYLE_ID))) return;
      const style = this._h(doc, "style", { id: this.STYLE_ID });
      style.textContent =
        "#" + this.ROOT_ID + " button{font-family:inherit;}\n" +
        "#" + this.ROOT_ID + " button:disabled{opacity:.5;cursor:default;}\n" +
        "#" + this.ROOT_ID + " .pp-cf-msg{padding:6px 8px;border-radius:6px;word-break:break-word;}\n" +
        "#" + this.ROOT_ID + " .pp-cf-msg pre{background:var(--fill-quinary,rgba(128,128,128,.12));" +
        "padding:4px 6px;border-radius:4px;overflow-x:auto;font-size:12px;}\n" +
        "#" + this.ROOT_ID + " .pp-cf-msg code{background:var(--fill-quinary,rgba(128,128,128,.12));" +
        "padding:0 3px;border-radius:3px;}\n" +
        "#" + this.ROOT_ID + " .pp-cf-msg table{border-collapse:collapse;font-size:12px;margin:4px 0;}\n" +
        "#" + this.ROOT_ID + " .pp-cf-msg th,#" + this.ROOT_ID + " .pp-cf-msg td{" +
        "border:1px solid var(--color-border,rgba(128,128,128,.4));padding:2px 6px;}\n" +
        // 0.51.0 回答内「文献 n」引用：点线底边 + accent 色，点击跳条目
        "#" + this.ROOT_ID + " .pp-cf-cite{cursor:pointer;" +
        "color:var(--color-accent,#2563eb);" +
        "border-bottom:1px dotted var(--color-accent,#2563eb);" +
        "text-decoration:none;white-space:nowrap;}\n" +
        "#" + this.ROOT_ID + " .pp-cf-cite:hover{" +
        "background:rgba(45,108,223,.12);}\n";
      doc.documentElement.appendChild(style);
    } catch (e) { this._err(e); }
  },

  /* ==================== Prompt 命令标签（A1：可编辑 #标签体系） ==================== */

  /** 标签来源：CommandTags（可编辑存储）优先；不可用时回退 Prompts 内置（只读） */
  _tagList() {
    try {
      if (typeof CommandTags !== "undefined" && CommandTags) return CommandTags.all();
    } catch (e) { /* ignore */ }
    try {
      return (Prompts.all() || []).slice(0, 8)
        .map((p) => ({ id: p.id, label: p.name, prompt: p.text, color: "", trigger: "" }));
    } catch (e) { /* Prompts 不可用则无标签 */ }
    return [];
  },

  _tagsEditable() {
    return typeof CommandTags !== "undefined" && !!CommandTags;
  },

  /** 全量重绘标签区（编辑/导入后所有窗口同步调用） */
  _renderChips(entry) {
    const { chips, input } = entry.refs;
    const doc = entry.win.document;
    const win = entry.win;
    chips.textContent = "";
    const self = this;
    const editable = this._tagsEditable();
    for (const tag of this._tagList().slice(0, 12)) {
      const color = tag.color || "";
      const chip = this._h(doc, "button", {
        type: "button", title: tag.prompt,
        style: "max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" +
          "padding:1px 8px;font-size:11px;border-radius:10px;cursor:pointer;" +
          "border:1px solid " + (color || "var(--color-border,rgba(128,128,128,.4))") + ";" +
          "background:var(--fill-quinary,rgba(128,128,128,.08));" +
          "color:" + (color || "var(--fill-secondary,#666)") + ";",
      }, tag.label);
      // 单击 = 填入并发送；长按 ≥500ms = 打开编辑层（zotero-gpt 同款手势）
      let pressTimer = null;
      let longFired = false;
      const cancelPress = () => {
        if (pressTimer) {
          try { win.clearTimeout(pressTimer); } catch (e) { /* ignore */ }
          pressTimer = null;
        }
      };
      if (editable) {
        chip.addEventListener("pointerdown", (ev) => {
          if (ev.button !== 0) return;
          longFired = false;
          cancelPress();
          pressTimer = win.setTimeout(() => {
            pressTimer = null;
            longFired = true;
            self._openTagEditor(entry, tag.id);
          }, 500);
        });
        chip.addEventListener("pointerup", cancelPress);
        chip.addEventListener("pointerleave", cancelPress);
        chip.addEventListener("pointercancel", cancelPress);
      }
      chip.addEventListener("click", () => {
        if (longFired) { longFired = false; return; }
        // 0.48.x：标签 prompt 含 {input} 且输入框已有内容 → 用输入框内容替换
        // （「先输入主题、再点标签」的自然交互；空输入框/无占位符行为不变）
        const typed = String(input.value || "").trim();
        let text = String(tag.prompt || "");
        if (typed && text.indexOf("{input}") >= 0) {
          text = text.split("{input}").join(typed);
        }
        input.value = text;
        // 0.47.0：分屏窗口等自定义 UI entry 可提供 send 钩子走自己的发送管线
        if (typeof entry.send === "function") {
          try { entry.send(); return; } catch (e) { self._err(e); }
        }
        self._doSend(entry);
      });
      chips.appendChild(chip);
    }
    if (editable) {
      const addBtn = this._h(doc, "button", {
        type: "button", title: I18n.isZh ? "新建标签" : "New tag",
        style: "padding:1px 8px;font-size:11px;border-radius:10px;cursor:pointer;" +
          "border:1px dashed var(--color-border,rgba(128,128,128,.4));" +
          "background:transparent;color:var(--fill-secondary,#666);",
      }, "＋");
      addBtn.addEventListener("click", () => self._openTagEditor(entry, null));
      chips.appendChild(addBtn);
    }
  },

  _renderAllChips() {
    for (const [, en] of this._wins) {
      try { this._renderChips(en); } catch (e) { /* ignore */ }
    }
  },

  /** 写剪贴板（nsIClipboardHelper；失败返回 false） */
  _clipboardWrite(text) {
    try {
      const Cc = Components.classes;
      const clip = Cc["@mozilla.org/widget/clipboardhelper;1"]
        .getService(Components.interfaces.nsIClipboardHelper);
      clip.copyString(String(text || ""));
      return true;
    } catch (e) { /* ignore */ }
    try { Zotero.Utilities.Internal.copyText(String(text || "")); return true; }
    catch (e) { return false; }
  },

  /** 读剪贴板文本（优先 navigator.clipboard，回落 XPCOM；note-templates.js 同款） */
  async _clipboardRead(win) {
    try {
      if (win && win.navigator && win.navigator.clipboard && win.navigator.clipboard.readText) {
        return String(await win.navigator.clipboard.readText() || "");
      }
    } catch (e) { /* 走 XPCOM 回落 */ }
    try {
      const clip = Components.classes["@mozilla.org/widget/clipboard;1"]
        .getService(Components.interfaces.nsIClipboard);
      const trans = Components.classes["@mozilla.org/widget/transferable;1"]
        .createInstance(Components.interfaces.nsITransferable);
      if (trans.init) trans.init(null);
      for (const flavor of ["text/plain", "text/unicode"]) {
        try {
          trans.addDataFlavor(flavor);
          clip.getData(trans, clip.kGlobalClipboard);
          const data = {};
          const len = {};
          try { trans.getTransferData(flavor, data, len); }
          catch (e) { data.value = trans.getTransferData(flavor); }
          if (data.value) {
            const str = data.value.QueryInterface(Components.interfaces.nsISupportsString);
            if (str && str.data) return String(str.data);
          }
        } catch (e) { /* 换下一个 flavor */ }
      }
    } catch (e) { this._err(e); }
    return "";
  },

  /**
   * 标签编辑层（长按标签 / 点「＋」打开）：改 label/prompt/color/trigger，
   * 删除、新建，剪贴板 JSON 全量导入/导出。
   */
  _openTagEditor(entry, tagId) {
    if (!this._tagsEditable()) return;
    const doc = entry.win.document;
    const win = entry.win;
    const zh = I18n.isZh;
    const self = this;
    // 已开则先关（幂等）
    const old = entry.root.querySelector("#paperpilot-tag-editor");
    if (old) old.remove();

    const tag = tagId ? (CommandTags.get(tagId) || { id: tagId }) : null;
    const isNew = !tagId;

    const overlay = this._h(doc, "div", {
      id: "paperpilot-tag-editor",
      style: "position:absolute;inset:0;z-index:10;display:flex;flex-direction:column;" +
        "background:var(--material-surface,#ffffff);color:inherit;padding:10px;gap:6px;overflow-y:auto;",
    });
    const headRow = this._h(doc, "div", {
      style: "display:flex;align-items:center;gap:6px;",
    });
    headRow.appendChild(this._h(doc, "span", {
      style: "flex:1;font-weight:600;font-size:12.5px;",
    }, isNew ? (zh ? "新建标签" : "New tag") : (zh ? "编辑标签" : "Edit tag")));
    const closeBtn = this._h(doc, "button", {
      type: "button",
      style: "flex:none;width:22px;height:22px;padding:0;border-radius:4px;cursor:pointer;" +
        "border:1px solid transparent;background:transparent;color:inherit;font-size:12px;",
    }, "✕");
    closeBtn.addEventListener("click", () => overlay.remove());
    headRow.appendChild(closeBtn);
    overlay.appendChild(headRow);

    const fieldLabel = (t) => this._h(doc, "div", {
      style: "font-size:11px;color:var(--fill-secondary,#666);margin-top:2px;",
    }, t);
    const textInput = (v) => {
      const el = this._h(doc, "input", {
        type: "text",
        style: "width:100%;box-sizing:border-box;padding:3px 6px;font-size:12px;border-radius:4px;" +
          "border:1px solid var(--color-border,rgba(128,128,128,.4));background:transparent;color:inherit;",
      });
      el.value = v || "";
      return el;
    };
    overlay.appendChild(fieldLabel(zh ? "名称" : "Label"));
    const labelIn = textInput(tag && tag.label);
    overlay.appendChild(labelIn);
    overlay.appendChild(fieldLabel(zh ? "提示词（{input} 代表用户原输入）" : "Prompt ({input} = user text)"));
    const promptIn = this._h(doc, "textarea", {
      rows: "5",
      style: "width:100%;box-sizing:border-box;resize:vertical;padding:4px 6px;font-size:12px;" +
        "border-radius:4px;border:1px solid var(--color-border,rgba(128,128,128,.4));" +
        "background:transparent;color:inherit;font-family:inherit;",
    });
    promptIn.value = (tag && tag.prompt) || "";
    overlay.appendChild(promptIn);
    overlay.appendChild(fieldLabel(zh ? "颜色（CSS 颜色，可空）" : "Color (CSS, optional)"));
    const colorIn = textInput(tag && tag.color);
    overlay.appendChild(colorIn);
    overlay.appendChild(fieldLabel(zh
      ? "触发正则（可空）：输入命中时自动套用该提示词，如 ^/总结"
      : "Trigger regex (optional), e.g. ^/sum"));
    const triggerIn = textInput(tag && tag.trigger);
    overlay.appendChild(triggerIn);

    const status = this._h(doc, "div", {
      style: "font-size:11px;min-height:14px;color:var(--fill-secondary,#666);",
    });
    overlay.appendChild(status);

    const btnRow = this._h(doc, "div", { style: "display:flex;gap:6px;flex-wrap:wrap;" });
    const mkBtn = (label, primary) => this._h(doc, "button", {
      type: "button",
      style: "padding:3px 12px;font-size:12px;border-radius:5px;cursor:pointer;" +
        "border:1px solid var(--color-border,rgba(128,128,128,.4));" +
        (primary ? "background:var(--color-accent,#2563eb);color:#fff;font-weight:600;"
                 : "background:transparent;color:inherit;"),
    }, label);
    const saveBtn = mkBtn(zh ? "保存" : "Save", true);
    saveBtn.addEventListener("click", () => {
      const label = labelIn.value.trim();
      const prompt = promptIn.value;
      if (!label || !prompt.trim()) {
        status.textContent = zh ? "名称与提示词不能为空" : "Label and prompt are required";
        status.style.color = "#c0392b";
        return;
      }
      CommandTags.upsert({
        id: tagId || "",
        label, prompt,
        color: colorIn.value.trim(),
        trigger: triggerIn.value.trim(),
      });
      self._renderAllChips();
      overlay.remove();
    });
    btnRow.appendChild(saveBtn);
    if (!isNew) {
      const delBtn = mkBtn(zh ? "删除" : "Delete", false);
      delBtn.addEventListener("click", () => {
        CommandTags.remove(tagId);
        self._renderAllChips();
        overlay.remove();
      });
      btnRow.appendChild(delBtn);
    }
    overlay.appendChild(btnRow);

    const ioRow = this._h(doc, "div", { style: "display:flex;gap:6px;margin-top:2px;" });
    const exportBtn = mkBtn(zh ? "导出到剪贴板" : "Export to clipboard", false);
    exportBtn.addEventListener("click", () => {
      const okW = self._clipboardWrite(CommandTags.exportJSON());
      status.style.color = okW ? "#1e7d32" : "#c0392b";
      status.textContent = okW
        ? (zh ? "✓ 已复制全部标签 JSON" : "✓ Tags JSON copied")
        : (zh ? "写剪贴板失败" : "Clipboard write failed");
    });
    const importBtn = mkBtn(zh ? "从剪贴板导入" : "Import from clipboard", false);
    importBtn.addEventListener("click", async () => {
      const text = await self._clipboardRead(win);
      const r = CommandTags.importJSON(text);
      if (r.ok) {
        status.style.color = "#1e7d32";
        status.textContent = (zh ? "✓ 已导入 " : "✓ Imported ") + r.count + (zh ? " 个标签" : " tags");
        self._renderAllChips();
      } else {
        status.style.color = "#c0392b";
        status.textContent = zh ? "导入失败：剪贴板不是有效的标签 JSON" : "Import failed: invalid JSON";
      }
    });
    ioRow.appendChild(exportBtn);
    ioRow.appendChild(importBtn);
    overlay.appendChild(ioRow);

    entry.root.appendChild(overlay);
  },

  /* ---------- 几何（位置/尺寸/停靠持久化） ---------- */

  _restoreGeo() {
    const [w, h] = this._parsePair(Prefs.get("chatFloatSize", ""), [this.DEFAULT_W, this.DEFAULT_H]);
    const [x, y] = this._parsePair(Prefs.get("chatFloatPos", ""), [-1, -1]);
    const dock = String(Prefs.get("chatFloatDock", "") || "");
    return {
      x, y,
      w: this._clamp(w, this.MIN_W, 900),
      h: this._clamp(h, this.MIN_H, 1200),
      dock: (dock === "left" || dock === "right") ? dock : "",
    };
  },

  _applyGeo(entry) {
    const { win, root, geo } = entry;
    const vw = win.innerWidth || 1200;
    const vh = win.innerHeight || 800;
    if (geo.dock === "left" || geo.dock === "right") {
      root.style.top = "0px";
      root.style.bottom = "0px";
      root.style.height = "auto";
      root.style.width = Math.min(geo.w, vw * 0.6) + "px";
      if (geo.dock === "left") { root.style.left = "0px"; root.style.right = "auto"; }
      else { root.style.right = "0px"; root.style.left = "auto"; }
      entry.refs.undockBtn.style.display = "";
    } else {
      // 浮动坐标夹取进视口（窗口缩过后不至于"消失"在屏幕外）
      if (geo.x < 0 || geo.x > vw - 80) geo.x = Math.max(8, vw - geo.w - 16);
      if (geo.y < 0 || geo.y > vh - 40) geo.y = 64;
      root.style.left = this._clamp(geo.x, 0, Math.max(0, vw - 80)) + "px";
      root.style.top = this._clamp(geo.y, 0, Math.max(0, vh - 40)) + "px";
      root.style.right = "auto";
      root.style.bottom = "auto";
      root.style.width = geo.w + "px";
      root.style.height = geo.h + "px";
      entry.refs.undockBtn.style.display = "none";
    }
  },

  _saveGeo(entry) {
    try {
      const g = entry.geo;
      Prefs.set("chatFloatPos", `${Math.round(g.x)},${Math.round(g.y)}`);
      Prefs.set("chatFloatSize", `${Math.round(g.w)},${Math.round(g.h)}`);
      Prefs.set("chatFloatDock", g.dock || "");
    } catch (e) { /* ignore */ }
  },

  _dock(entry, side) {
    entry.geo.dock = side;
    this._applyGeo(entry);
    this._saveGeo(entry);
  },

  /* ---------- 标题栏拖动（停靠中拖动即脱离） ---------- */

  _bindHeadDrag(entry) {
    const { win, root, refs, geo } = entry;
    const head = refs.head;
    head.addEventListener("pointerdown", (ev) => {
      // 点在按钮上不拖动
      if (ev.target && typeof ev.target.closest === "function" &&
          ev.target.closest("button")) return;
      if (ev.button !== 0) return;
      const startRect = root.getBoundingClientRect();
      // 停靠中：先脱离为浮动坐标，再继续拖
      if (geo.dock) {
        geo.dock = "";
        geo.x = startRect.left;
        geo.y = startRect.top;
        geo.w = startRect.width;
        geo.h = startRect.height;
        this._applyGeo(entry);
      }
      const startX = ev.clientX;
      const startY = ev.clientY;
      const origX = startRect.left;
      const origY = startRect.top;
      try { head.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
      const onMove = (e2) => {
        geo.x = origX + (e2.clientX - startX);
        geo.y = origY + (e2.clientY - startY);
        root.style.left = geo.x + "px";
        root.style.top = geo.y + "px";
        root.style.right = "auto";
        root.style.bottom = "auto";
      };
      const onUp = (e3) => {
        head.removeEventListener("pointermove", onMove);
        head.removeEventListener("pointerup", onUp);
        // 视口边界软约束（允许略微出界，但主体必须在视口内）
        const vw = win.innerWidth || 1200;
        const vh = win.innerHeight || 800;
        geo.x = this._clamp(geo.x, 8 - geo.w + 80, vw - 80);
        geo.y = this._clamp(geo.y, 0, vh - 40);
        root.style.left = geo.x + "px";
        root.style.top = geo.y + "px";
        this._saveGeo(entry);
      };
      head.addEventListener("pointermove", onMove);
      head.addEventListener("pointerup", onUp);
    });
  },

  /* ---------- 右下角缩放 ---------- */

  _bindResize(entry) {
    const { win, root, grip, geo } = entry;
    grip.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      const startX = ev.clientX;
      const startY = ev.clientY;
      const startW = root.getBoundingClientRect().width;
      const startH = root.getBoundingClientRect().height;
      const vw = win.innerWidth || 1200;
      const vh = win.innerHeight || 800;
      try { grip.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
      const onMove = (e2) => {
        geo.w = this._clamp(startW + (e2.clientX - startX), this.MIN_W, vw - 16);
        geo.h = this._clamp(startH + (e2.clientY - startY), this.MIN_H, vh - 16);
        root.style.width = geo.w + "px";
        if (geo.dock) {
          // 停靠中只有宽度有意义（高度贴边撑满）
          root.style.width = Math.min(geo.w, vw * 0.6) + "px";
        } else {
          root.style.height = geo.h + "px";
        }
      };
      const onUp = () => {
        grip.removeEventListener("pointermove", onMove);
        grip.removeEventListener("pointerup", onUp);
        this._saveGeo(entry);
      };
      grip.addEventListener("pointermove", onMove);
      grip.addEventListener("pointerup", onUp);
    });
  },

  /* ---------- Esc 关闭（焦点在悬浮窗内时；zotero-gpt 同款收尾） ---------- */

  _bindEsc(win) {
    const self = this;
    const doc = win.document;
    if (doc.__ppChatFloatEsc) return;
    doc.__ppChatFloatEsc = true;
    doc.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      let entry = null;
      try { entry = self._wins.get(win); } catch (e) { return; }
      if (!entry || entry.root.style.display === "none") return;
      const t = ev.target;
      const inside = t && typeof t.closest === "function" &&
        (t === entry.root || t.closest("#" + self.ROOT_ID));
      if (inside) {
        ev.preventDefault();
        ev.stopPropagation();
        self.hide(win);
      }
    }, true);
  },

  /* ==================== 悬浮窗：显示 / 隐藏 / 渲染 ==================== */

  /** 便捷入口（Hub/菜单等窗口脚本经 PP.chatFloat 调用，免去传 win） */
  openMain() {
    const win = Zotero.getMainWindow();
    if (!win) return;
    this.show(win);
  },

  /** 唤起入口统一 API：跟随当前阅读/选中条目 → 切显示态。
   *  显式锁定条目的调用方（右键菜单/划词注入）直接 setSessionItem + show，
   *  不走这里（show 不做条目解析，避免覆盖显式锁定）。 */
  toggle(win) {
    if (!win) return;
    const entry = this._entry(win);
    if (entry && entry.root.style.display !== "none") {
      this.hide(win);
      return;
    }
    const it = this._resolveItem();
    if (it) {
      const r = this.setSessionItem(it);
      this._pendingSwitchNotice = (r === "switched");
    }
    this.show(win);
  },

  show(win) {
    try {
      const entry = this._ensure(win);
      const s = this.session;
      entry.refs.titleEl.textContent = this._itemTitle() || I18n.t("chatFloatTitle");
      entry.refs.titleEl.setAttribute("title",
        s.item ? this._itemTitle() : I18n.t("chatFloatNoItem"));
      this._renderHistory(entry);
      this._renderCtxChips(entry);
      entry.root.style.display = "flex";
      // 弹回视口（窗口尺寸可能变了）
      this._applyGeo(entry);
      if (this._pendingSwitchNotice) {
        this._appendBubble(entry, "sys", I18n.t("chatFloatSwitched"), "#888");
        this._pendingSwitchNotice = false;
      }
      try { entry.refs.input.focus(); } catch (e) { /* ignore */ }
    } catch (e) {
      this._err(new Error("PaperPilot: AI 悬浮窗打开失败"));
      this._err(e);
    }
  },

  hide(win) {
    try {
      const entry = this._entry(win);
      if (entry) entry.root.style.display = "none";
    } catch (e) { /* ignore */ }
  },

  isVisible(win) {
    try {
      const entry = this._entry(win);
      return !!(entry && entry.root.style.display !== "none");
    } catch (e) { return false; }
  },

  /** 从 session.history 全量重建气泡（跨窗口同步 / 清空 / 切换后调用） */
  _renderHistory(entry) {
    const st = this.session;
    const { msgs } = entry.refs;
    msgs.textContent = "";
    if (!st.history.length) {
      const hint = this._h(entry.win.document, "div",
        { style: "color:var(--fill-tertiary,#888);padding:4px 0;font-size:12px;" },
        st.item ? I18n.t("chatEmpty") + "\n" + I18n.t("chatFloatOpenHint")
                : I18n.t("chatNoItem") + " " + I18n.t("chatFloatNoItem"));
      hint.style.whiteSpace = "pre-line";
      msgs.appendChild(hint);
      return;
    }
    for (const h of st.history) {
      this._appendBubble(entry, h.role, h.content, null, true);
    }
    msgs.scrollTop = msgs.scrollHeight;
  },

  _appendBubble(entry, role, text, color, skipScroll) {
    const { msgs } = entry.refs;
    const doc = msgs.ownerDocument;
    // 空态提示（非 .pp-cf-msg 的第一个子节点）在首条消息出现时移除
    const hint = msgs.querySelector(":scope > div:not(.pp-cf-msg)");
    if (hint) hint.remove();
    const isUser = role === "user";
    const isAssistant = role === "assistant";
    const bubble = this._h(doc, "div", {
      class: "pp-cf-msg",
      style: (isAssistant ? "" : "white-space:pre-wrap;") +
        (color ? `color:${color};background:transparent;border:0;` :
          isUser ? "background:rgba(45,108,223,.13);border:1px solid rgba(45,108,223,.33);"
                 : "background:rgba(136,136,136,.09);border:1px solid rgba(136,136,136,.2);"),
    });
    if (isAssistant && !color) {
      this._renderAssistant(entry, bubble, text);
    } else {
      bubble.textContent = text;
    }
    msgs.appendChild(bubble);
    if (!skipScroll) msgs.scrollTop = msgs.scrollHeight;
    return bubble;
  },

  /** 悬浮窗侧发送：流式增量渲染 + 状态气泡 */
  _doSend(entry) {
    const s = this.session;
    if (s.busy) {
      // 生成中点「发送」= 停止（与划词浮窗一致的防呆）
      this.stop();
      return;
    }
    const q = entry.refs.input.value.trim();
    if (!q) return;
    entry.refs.input.value = "";

    let statusBubble = null;
    let streamBubble = null;
    const self = this;
    this.runSend(this._applyTrigger(q), {
      onUser(text) {
        self._appendBubble(entry, "user", text);
      },
      onStatus(text) {
        if (statusBubble && statusBubble.isConnected) statusBubble.textContent = text;
        else statusBubble = self._appendBubble(entry, "sys", text, "#888");
      },
      onDelta(acc) {
        if (!streamBubble) {
          if (statusBubble) { statusBubble.remove(); statusBubble = null; }
          streamBubble = self._appendBubble(entry, "assistant", "");
        }
        self._renderAssistant(entry, streamBubble, acc);
        entry.refs.msgs.scrollTop = entry.refs.msgs.scrollHeight;
      },
      onDone(text) {
        if (statusBubble) { statusBubble.remove(); statusBubble = null; }
        if (streamBubble) {
          self._renderAssistant(entry, streamBubble, text);
        } else {
          self._appendBubble(entry, "assistant", text);
        }
        entry.refs.msgs.scrollTop = entry.refs.msgs.scrollHeight;
      },
      onCost(info) {
        const line = I18n.t("chatCostNote") + " " + info.costText
          + (info.balanceText ? " · " + I18n.t("chatCostLeft") + " " + info.balanceText : "");
        self._appendBubble(entry, "sys", line, "#888");
      },
      onToolStep(tool, args, result) {
        // Agent 模式工具过程（Hermes 式围观）：调用行 + 结果摘要（各一条系统气泡）
        let argsPreview = "";
        try { argsPreview = JSON.stringify(args) || ""; } catch (e) { argsPreview = ""; }
        self._appendBubble(entry, "sys",
          "🔧 " + tool + (argsPreview ? " " + argsPreview.slice(0, 120) : ""), "#0d9488", true);
        const res = String(result || "");
        if (res) {
          self._appendBubble(entry, "sys",
            "→ " + res.replace(/\s+/g, " ").slice(0, 200) + (res.length > 200 ? " …" : ""),
            "#888", true);
        }
        entry.refs.msgs.scrollTop = entry.refs.msgs.scrollHeight;
      },
      onError(msg) {
        if (statusBubble) { statusBubble.remove(); statusBubble = null; }
        if (streamBubble) { streamBubble.remove(); streamBubble = null; }
        self._appendBubble(entry, "sys", msg, "#c0392b");
      },
      onAbort() {
        if (statusBubble) { statusBubble.remove(); statusBubble = null; }
        if (streamBubble) { streamBubble.remove(); streamBubble = null; }
      },
      // Agent 轮次的「常驻」系统气泡（与 onStatus 的临时状态气泡不同，不会被 onDone 清掉）
      onSys(text, color) {
        self._appendBubble(entry, "sys", text, color || "#888");
      },
      onBusy(busy) {
        entry.refs.sendBtn.textContent = busy ? I18n.t("chatFloatStop") : I18n.t("chatSend");
        entry.refs.saveBtn.disabled = busy;
        entry.refs.clearBtn.disabled = busy;
      },
      onItemChanged(title) {
        entry.refs.titleEl.textContent = title || I18n.t("chatFloatTitle");
        entry.refs.titleEl.setAttribute("title", title || "");
      },
    });
  },

  /** trigger 命中 → 套用标签 prompt（{input} 替换为原输入）；无命中原样返回 */
  _applyTrigger(q) {
    try {
      if (typeof CommandTags === "undefined" || !CommandTags) return q;
      return CommandTags.applyTrigger(q);
    } catch (e) { return q; }
  },

  /**
   * 划词浮窗「在浮窗继续」：把选区作为引用块预填悬浮窗输入框。
   * 没有可见实例时唤起主窗口实例。返回 true（调用方只报告成功）。
   */
  injectQuote(item, text) {
    try {
      this.setSessionItem(item);
      const q = `【原文摘录】\n${text}\n\n`;
      // 找可见实例预填；否则开主窗口的
      let target = null;
      for (const [win, entry] of this._wins) {
        if (entry.root.style.display !== "none" && this._isAlive(entry.root)) {
          target = entry;
          break;
        }
      }
      if (!target) {
        const win = Zotero.getMainWindow();
        if (!win) return false;
        target = this._ensure(win);
        this.show(win);
      }
      target.refs.titleEl.textContent = this._itemTitle() || I18n.t("chatFloatTitle");
      target.refs.titleEl.setAttribute("title", this._itemTitle() || "");
      this._renderHistory(target);
      target.refs.input.value = q;
      try { target.refs.input.focus(); } catch (e) { /* ignore */ }
      return true;
    } catch (e) {
      this._err(e);
      return false;
    }
  },

  /* ==================== 分屏独立窗口（PapersGPT 式真分屏） ==================== */

  openWindow() {
    try {
      const en = Services.wm.getEnumerator(this.WINDOW_TYPE);
      if (en.hasMoreElements()) { const w = en.getNext(); w.focus(); return w; }
    } catch (e) { /* ignore */ }
    const win = Zotero.getMainWindow();
    if (!win) return null;
    try {
      return win.openDialog(
        "chrome://paperpilot/content/chat-window.xhtml",
        "paperpilot-chat-window",
        "chrome,centerscreen,resizable,dialog=no",
        { Zotero, Services }
      );
    } catch (e) {
      this._err(e);
      return null;
    }
  },

  /* ==================== 唤起注册 ==================== */

  register(pluginID) {
    this._pluginID = pluginID || "paperpilot@dev.local";

    // ① 阅读器工具栏按钮 + Ctrl/Cmd+Enter（renderToolbar 官方扩展位）
    if (Zotero.Reader && typeof Zotero.Reader.registerEventListener === "function") {
      this._readerHandler = (event) => this._onRenderToolbar(event);
      try {
        Zotero.Reader.registerEventListener("renderToolbar", this._readerHandler, this._pluginID);
      } catch (e) {
        this._readerHandler = null;
        this._err(e);
      }
    }

    // ② 主窗口快捷键 Ctrl/Cmd+Shift+K：优先走 Hotkeys 中央注册表（设置面板可改键）；
    //    Hotkeys 未加载时回退自注入 keyset（现有窗口 + 之后新开的主窗口）
    if (typeof Hotkeys !== "undefined" && Hotkeys) {
      try {
        Hotkeys.register({
          id: "chat-float-toggle",
          label: I18n.isZh ? "AI 问答悬浮窗（主窗口唤起）" : "AI Chat float (main window)",
          combo: "Ctrl+Shift+K",
          scope: "main",
          handler: (w) => this.toggle(w),
        });
        Hotkeys.register({
          id: "chat-float-reader",
          label: I18n.isZh ? "AI 问答悬浮窗（阅读器唤起）" : "AI Chat float (reader)",
          combo: "Ctrl+Enter",
          scope: "reader",
          handler: null, // reader 文档 keydown 由 _onRenderToolbar 捕获 + matches 判定
        });
      } catch (e) {
        this._err(e);
      }
    } else {
      this._injectKeysets();
      try {
        this._obsObserver = {
          observe(subject) {
            try {
              const win = subject && subject.defaultView ? subject.defaultView : subject;
              // 只给 Zotero 主窗口装快捷键（reader 独立窗口不装，避免双份）
              if (win && win.ZoteroPane) ChatFloat._injectKeysets();
            } catch (e) { /* ignore */ }
          },
        };
        Services.obs.addObserver(this._obsObserver, "domwindowopened", false);
      } catch (e) {
        this._obsObserver = null;
        this._err(e);
      }
    }
  },

  _injectKeysets() {
    let wins = [];
    try { wins = Zotero.getMainWindows() || []; } catch (e) { /* ignore */ }
    for (const win of wins) {
      try { this._injectKeyset(win); } catch (e) { this._err(e); }
    }
  },

  _injectKeyset(win) {
    const doc = win.document;
    if (!doc || doc.getElementById(this.KEY_ID)) return;
    let keyset = doc.getElementById("mainKeyset");
    if (!keyset) {
      keyset = this._xul(doc, "keyset");
      keyset.id = "paperpilot-chat-keyset";
      doc.documentElement.appendChild(keyset);
    }
    const key = this._xul(doc, "key");
    key.id = this.KEY_ID;
    key.setAttribute("modifiers", "accel shift");
    key.setAttribute("key", "K");
    key.setAttribute("oncommand", "//");
    key.addEventListener("command", () => this.toggle(win));
    keyset.appendChild(key);
    this._nodes.push({ node: key });
  },

  /** reader 工具栏：AI 按钮（每次重渲染重建）+ Ctrl/Cmd+Enter 一次性绑定 */
  _onRenderToolbar(event) {
    try {
      const doc = event && event.doc;
      const append = event && event.append;
      if (!doc || typeof append !== "function") return;

      const btn = doc.createElementNS(this.XHTML, "button");
      btn.id = this.READER_BTN_ID;
      btn.setAttribute("class", "toolbar-button");
      btn.setAttribute("type", "button");
      btn.setAttribute("tabindex", "-1");
      btn.title = I18n.t("chatFloatReaderBtnTip");
      btn.style.flex = "none";
      btn.appendChild(this._chatIcon(doc, 16));
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.toggle(this._readerChromeWin(doc));
      });
      append(btn);

      // Ctrl/Cmd+Enter（PapersGPT 同款）：reader 文档上捕获一次；combo 读 Hotkeys 生效值
      if (!doc.__ppChatFloatKey) {
        doc.__ppChatFloatKey = true;
        doc.addEventListener("keydown", (ev) => {
          if (this._readerComboMatch(ev)) {
            ev.preventDefault();
            ev.stopPropagation();
            this.toggle(this._readerChromeWin(doc));
          }
        }, true);
      }
    } catch (e) {
      this._err(e);
    }
  },

  /** reader 唤起键判定：Hotkeys 生效值（含禁用/改键）优先，回退硬编码 Ctrl/Cmd+Enter */
  _readerComboMatch(ev) {
    try {
      if (typeof Hotkeys !== "undefined" && Hotkeys) {
        if (!Hotkeys.isEnabled("chat-float-reader")) return false;
        return Hotkeys.matches(ev, Hotkeys.combo("chat-float-reader"));
      }
    } catch (e) { /* 回退硬编码 */ }
    return ev.key === "Enter" && (ev.ctrlKey || ev.metaKey) && !ev.shiftKey && !ev.altKey;
  },

  /** reader iframe doc → 所属 chrome window（tab 模式=主窗口；独立窗口=reader 窗口） */
  _readerChromeWin(doc) {
    try {
      let w = doc.defaultView;
      while (w && w.parent && w.parent !== w) w = w.parent;
      if (w && w.document) return w;
    } catch (e) { /* ignore */ }
    return Zotero.getMainWindow();
  },

  unregister() {
    // reader 事件
    try {
      if (this._readerHandler && Zotero.Reader && Zotero.Reader.unregisterEventListener) {
        Zotero.Reader.unregisterEventListener("renderToolbar", this._readerHandler);
      }
    } catch (e) { /* ignore */ }
    this._readerHandler = null;

    // 窗口观察者
    try {
      if (this._obsObserver) Services.obs.removeObserver(this._obsObserver, "domwindowopened");
    } catch (e) { /* ignore */ }
    this._obsObserver = null;

    // 快捷键节点
    for (const { node } of this._nodes) {
      try { if (node && node.parentNode) node.parentNode.removeChild(node); }
      catch (e) { /* ignore */ }
    }
    this._nodes = [];

    // 全部悬浮窗 DOM
    for (const [win, entry] of this._wins) {
      try {
        if (entry.root && entry.root.parentNode) entry.root.parentNode.removeChild(entry.root);
        const doc = win.document;
        const style = doc.getElementById(this.STYLE_ID);
        if (style) style.remove();
      } catch (e) { /* ignore */ }
    }
    this._wins.clear();

    // 阅读器按钮挂在 React 托管的 custom-sections 里，逐个文档补摘
    try {
      for (const r of (Zotero.Reader && Zotero.Reader._readers) || []) {
        const d = r && r._iframeWindow && r._iframeWindow.document;
        if (d) {
          const b = d.getElementById(this.READER_BTN_ID);
          if (b) b.remove();
        }
      }
    } catch (e) { /* ignore */ }

    this.session = {
      item: null, history: [], busy: false, handle: null,
      inputHistory: [], histIdx: -1, contextItems: [],
    };
  },
};
