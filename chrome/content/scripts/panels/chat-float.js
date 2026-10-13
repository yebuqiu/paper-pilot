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
/* global Zotero, Services, Prefs, AIClient, AIChat, I18n, Prompts, MdLite, Notes */

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
    if (!s.item) {
      const it = this._resolveItem();
      if (it) {
        const r = this.setSessionItem(it);
        if (ui.onItemChanged) ui.onItemChanged(this._itemTitle(), r === "switched");
      }
    }
    if (!s.item) {
      if (ui.onError) ui.onError(I18n.t("chatNoItem"));
      return;
    }

    s.busy = true;
    if (ui.onBusy) ui.onBusy(true);
    if (ui.onUser) ui.onUser(question);
    try {
      if (ui.onStatus) ui.onStatus(I18n.t("chatReading"));
      const fullText = await AIChat.getFullText(s.item);
      const messages = await AIChat.buildMessages(s.item, question, s.history, fullText || undefined);

      let acc = "";
      const useStream = Prefs.get("readerPopupStream", true) && AIClient.chatStream;
      if (useStream) {
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
      if (ui.onDone) ui.onDone(acc);
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

  /** 停止当前生成（流式 abort；非流式在 runSend 侧无句柄，忽略） */
  stop() {
    const s = this.session;
    if (s.handle) {
      try { s.handle.abort(); } catch (e) { /* ignore */ }
    }
  },

  /** 把当前会话保存为笔记（悬浮窗 / 独立窗口共用；成功返回 true） */
  async saveHistoryAsNote(ui) {
    const s = this.session;
    if (!s.item || !s.history.length) {
      if (ui && ui.onError) ui.onError(I18n.t("chatEmptyHistory"));
      return false;
    }
    try {
      const md = s.history
        .map(h => (h.role === "user" ? "**问：** " : "**答：** ") + h.content)
        .join("\n\n");
      await Notes.createFromMarkdown(
        s.item,
        `${I18n.t("noteChatTitle")}｜${s.item.getDisplayTitle() || ""}`,
        md
      );
      return true;
    } catch (e) {
      this._err(e);
      if (ui && ui.onError) ui.onError(I18n.t("errPrefix") + ((e && e.message) || e));
      return false;
    }
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

    // ---- Prompt 快捷标签（zotero-gpt Command Tag / PapersGPT 内置 prompts 思路）----
    const chips = this._h(doc, "div", {
      style: "display:flex;flex-wrap:wrap;gap:4px;padding:0 8px 6px;",
    });
    try {
      const list = (Prompts.all() || []).slice(0, 8);
      for (const p of list) {
        const chip = this._h(doc, "button", {
          type: "button", title: p.text,
          style: "max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" +
            "padding:1px 8px;font-size:11px;border-radius:10px;cursor:pointer;" +
            "border:1px solid var(--color-border,rgba(128,128,128,.4));" +
            "background:var(--fill-quinary,rgba(128,128,128,.08));color:var(--fill-secondary,#666);",
        }, p.name);
        chip.addEventListener("click", () => {
          entry.refs.input.value = p.text;
          this._doSend(entry);
        });
        chips.appendChild(chip);
      }
    } catch (e) { /* Prompts 不可用则无标签行 */ }

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
    root.appendChild(inputRow);
    root.appendChild(grip);
    doc.documentElement.appendChild(root);

    const entry = {
      win, root, grip,
      refs: { head, titleEl, undockBtn, dockLBtn, dockRBtn, opBtn, popBtn, closeBtn,
        msgs, chips, input, sendBtn, saveBtn, clearBtn },
      geo: this._restoreGeo(),
    };
    this._wins.set(win, entry);

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
      self.session.history = [];
      self.session.inputHistory = [];
      self.session.histIdx = -1;
      self._renderHistory(entry);
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
    return entry;
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
        "border:1px solid var(--color-border,rgba(128,128,128,.4));padding:2px 6px;}\n";
      doc.documentElement.appendChild(style);
    } catch (e) { this._err(e); }
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
      try { bubble.innerHTML = MdLite.toHtml(text); }
      catch (e) { bubble.textContent = text; }
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
    this.runSend(q, {
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
        try { streamBubble.innerHTML = MdLite.toHtml(acc); }
        catch (e) { streamBubble.textContent = acc; }
        entry.refs.msgs.scrollTop = entry.refs.msgs.scrollHeight;
      },
      onDone(text) {
        if (statusBubble) { statusBubble.remove(); statusBubble = null; }
        if (streamBubble) {
          try { streamBubble.innerHTML = MdLite.toHtml(text); }
          catch (e) { streamBubble.textContent = text; }
        } else {
          self._appendBubble(entry, "assistant", text);
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

    // ② 主窗口快捷键 Ctrl/Cmd+Shift+K（keyset；现有窗口 + 之后新开的主窗口）
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

      // Ctrl/Cmd+Enter（PapersGPT 同款）：reader 文档上捕获一次
      if (!doc.__ppChatFloatKey) {
        doc.__ppChatFloatKey = true;
        doc.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey) && !ev.shiftKey && !ev.altKey) {
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
      inputHistory: [], histIdx: -1,
    };
  },
};
