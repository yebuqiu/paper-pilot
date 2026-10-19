// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot AI 问答侧栏（ItemPane section）
 * 注意：Zotero 7 的 section body 是 XUL 元素，HTML 元素必须用 XHTML 命名空间创建
 */
/* global Zotero, AIChat, AIClient, I18n, Notes, Prompts, MdLite */

var AIChatPane = {
  PANE_ID: "papilot-ai-chat",
  _panes: new Map(), // paneID -> 状态
  _registered: false,

  _h(doc, tag, attrs = {}, text) {
    const el = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
    for (const k in attrs) {
      if (k === "style") el.style.cssText = attrs[k];
      else el.setAttribute(k, attrs[k]);
    }
    if (text != null) el.textContent = text;
    return el;
  },

  _state(paneID) {
    if (!this._panes.has(paneID)) {
      this._panes.set(paneID, { item: null, history: [], busy: false });
    }
    return this._panes.get(paneID);
  },

  _usable(item) {
    return !!(item && (
      (item.isRegularItem && item.isRegularItem()) ||
      (item.isPDFAttachment && item.isPDFAttachment())
    ));
  },

  register(pluginID) {
    if (this._registered) return;
    const self = this;

    // ⚠️ onRender 在 Z7/Z10 是必填 hook：Z10 schema 校验（itemPaneManager.js
    // optionTypeDefinition）没有 onRender 时 registerSection **不抛错、静默返回
    // false**，section 永远不会出现在侧栏——这是 0.1.0~0.4.1 "AI 问答侧栏消失"
    // 的根因（活体对照实证：无 onRender 返回 false，有则注册成功）。
    // UI 构建放 onRender（框架保证每个 section 元素只渲染一次），onInit 可省。
    const registeredPaneID = Zotero.ItemPaneManager.registerSection({
      paneID: this.PANE_ID,
      pluginID,
      header: {
        l10nID: "papilot-chat-section-header",
        icon: "chrome://papilot/content/icons/chat.svg",
      },
      sidenav: {
        l10nID: "papilot-chat-section-sidenav",
        icon: "chrome://papilot/content/icons/chat.svg",
      },
      onRender({ paneID, doc, body }) {
        // 防御：同一 body 不重复构建
        if (body.querySelector("[data-pp-chat-root]")) return;
        const H = (t, a, x) => self._h(doc, t, a, x);
        const root = H("div", {
          "data-pp-chat-root": "1",
          style: "display:flex;flex-direction:column;gap:6px;padding:6px;font-size:13px;",
        });

        // 当前文献标题
        const titleEl = H("div", {
          style: "font-weight:600;color:var(--fill-secondary,#666);white-space:nowrap;overflow:hidden;" +
            "text-overflow:ellipsis;",
        }, "—");

        const msgs = H("div", {
          style: "display:flex;flex-direction:column;gap:6px;max-height:340px;overflow-y:auto;",
        });
        const hint = H("div", { style: "color:var(--fill-tertiary,#888);padding:4px 0;" }, I18n.t("chatEmpty"));
        msgs.appendChild(hint);

        // 工具行：Prompt 下拉 + 执行 / 存为笔记 / 清空
        const toolbar = H("div", { style: "display:flex;gap:6px;align-items:center;flex-wrap:wrap;" });
        const promptSel = H("select", { style: "flex:1;min-width:0;font-size:12px;padding:2px;" });
        for (const p of Prompts.all()) {
          const opt = H("option", { value: p.id }, p.name);
          opt.setAttribute("data-prompt", p.text);
          promptSel.appendChild(opt);
        }
        const runBtn = H("button", { style: "padding:2px 8px;font-size:12px;" }, I18n.t("promptRun"));
        const saveBtn = H("button", { style: "padding:2px 8px;font-size:12px;" }, I18n.t("chatSave"));
        const clearBtn = H("button", { style: "padding:2px 8px;font-size:12px;" }, I18n.t("chatClear"));
        toolbar.appendChild(promptSel);
        toolbar.appendChild(runBtn);
        toolbar.appendChild(saveBtn);
        toolbar.appendChild(clearBtn);

        const inputRow = H("div", { style: "display:flex;gap:6px;align-items:flex-end;" });
        const input = H("textarea", {
          rows: "2",
          placeholder: I18n.t("chatPlaceholder"),
          style: "flex:1;resize:vertical;padding:4px;font-size:13px;",
        });
        const sendBtn = H("button", { style: "padding:4px 12px;" }, I18n.t("chatSend"));
        inputRow.appendChild(input);
        inputRow.appendChild(sendBtn);

        root.appendChild(titleEl);
        root.appendChild(msgs);
        root.appendChild(toolbar);
        root.appendChild(inputRow);
        body.appendChild(root);

        const st = self._state(paneID);
        st.refs = { titleEl, msgs, input, sendBtn, saveBtn, clearBtn, hint };

        const doSend = () => self._send(paneID);
        sendBtn.addEventListener("click", doSend);
        // Prompt 下拉：把选中模板填入输入框并走正常发送流程
        runBtn.addEventListener("click", () => {
          const opt = promptSel.options[promptSel.selectedIndex];
          const text = opt && opt.getAttribute("data-prompt");
          if (text) {
            input.value = text;
            doSend();
          }
        });
        saveBtn.addEventListener("click", () => self._saveAsNote(paneID));
        clearBtn.addEventListener("click", () => {
          const s = self._state(paneID);
          s.history = [];
          self._clearMessages(paneID);
        });
        input.addEventListener("keydown", (ev) => {
          // isComposing：中文输入法组词期间的 Enter 是选词，不应触发发送
          if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
            ev.preventDefault();
            doSend();
          }
        });
      },
      onItemChange({ paneID, item, setEnabled }) {
        const ok = self._usable(item);
        setEnabled(ok);
        const st = self._state(paneID);
        if (item && (!st.item || st.item.id !== item.id)) {
          st.item = item;
          st.history = [];
          self._clearMessages(paneID);
          self._updateTitle(paneID);
        } else if (!item) {
          st.item = null;
          st.history = [];
          self._clearMessages(paneID);
          self._updateTitle(paneID);
        }
        return true;
      },
      onDestroy({ paneID }) {
        self._panes.delete(paneID);
      },
    });
    // registerSection 校验失败时静默返回 false（不抛错），必须显式检查
    if (!registeredPaneID) {
      throw new Error("ItemPaneManager.registerSection 校验失败（返回 false），section 未注册");
    }
    // 注销要用返回值（带命名空间的主键），不是注册时的 paneID
    this._registeredPaneID = registeredPaneID;
    this._registered = true;
  },

  _updateTitle(paneID) {
    const st = this._state(paneID);
    if (!st.refs) return;
    let title = "—";
    if (st.item) {
      try { title = st.item.getDisplayTitle() || "—"; } catch (e) { /* ignore */ }
    }
    st.refs.titleEl.textContent = title;
    st.refs.titleEl.setAttribute("title", title);
  },

  _clearMessages(paneID) {
    const st = this._state(paneID);
    if (!st.refs) return;
    st.refs.msgs.textContent = "";
    st.refs.hint = this._h(st.refs.msgs.ownerDocument, "div",
      { style: "color:var(--fill-tertiary,#888);padding:4px 0;" }, I18n.t("chatEmpty"));
    st.refs.msgs.appendChild(st.refs.hint);
  },

  _appendMsg(paneID, role, text, color) {
    const st = this._state(paneID);
    if (!st.refs) return null;
    const doc = st.refs.msgs.ownerDocument;
    if (st.refs.hint && st.refs.hint.parentNode) st.refs.hint.remove();
    const isUser = role === "user";
    const isAssistant = role === "assistant";
    const bubble = this._h(doc, "div", {
      style: `padding:6px 8px;border-radius:6px;word-break:break-word;` +
        // 富文本气泡内部靠块级标签控制间距，不能再 pre-wrap（否则 HTML 源换行变成多余空行）
        (isAssistant ? "" : "white-space:pre-wrap;") +
        (color ? `color:${color};` :
          isUser ? "background:#2d6cdf22;border:1px solid #2d6cdf55;"
                 : "background:#88888818;border:1px solid #88888833;"),
    });
    // 0.10.0：AI 回复按富文本渲染（标题/加粗/列表/表格/引用），其余消息纯文本
    if (isAssistant && !color) {
      try {
        bubble.innerHTML = MdLite.toHtml(text);
      } catch (e) {
        bubble.textContent = text; // 渲染失败降级纯文本
      }
    } else {
      bubble.textContent = text;
    }
    st.refs.msgs.appendChild(bubble);
    st.refs.msgs.scrollTop = st.refs.msgs.scrollHeight;
    return bubble;
  },

  async _send(paneID) {
    const st = this._state(paneID);
    if (!st.refs) return;
    const { input, sendBtn } = st.refs;
    const question = input.value.trim();
    if (!question || st.busy) return;

    if (!AIClient.hasKey()) {
      this._appendMsg(paneID, "sys", I18n.t("chatNoKey"), "#c0392b");
      return;
    }
    if (!this._usable(st.item)) {
      this._appendMsg(paneID, "sys", I18n.t("chatNoItem"), "#c0392b");
      return;
    }

    st.busy = true;
    sendBtn.disabled = true;
    input.value = "";
    this._appendMsg(paneID, "user", question);
    const statusBubble = this._appendMsg(paneID, "sys", I18n.t("chatReading"), "#888");

    try {
      // 先读全文（写入缓存），再更新状态提示后请求 AI
      const fullText = await AIChat.getFullText(st.item);
      if (!fullText) throw new Error("NO_PDF");
      if (statusBubble && statusBubble.parentNode) {
        statusBubble.textContent = I18n.t("chatThinking");
      }
      const answer = await AIChat.ask(st.item, question, st.history);
      if (statusBubble) statusBubble.remove();
      this._appendMsg(paneID, "assistant", answer);
      st.history.push({ role: "user", content: question });
      st.history.push({ role: "assistant", content: answer });
    } catch (e) {
      if (statusBubble) statusBubble.remove();
      const msg = e && e.message === "NO_PDF" ? I18n.t("chatNoPdf")
        : e && e.message === "NO_API_KEY" ? I18n.t("chatNoKey")
        : I18n.t("errPrefix") + (e.message || e);
      this._appendMsg(paneID, "sys", msg, "#c0392b");
    } finally {
      st.busy = false;
      if (st.refs) {
        st.refs.sendBtn.disabled = false;
        st.refs.input.focus();
      }
    }
  },

  /** 把当前问答历史保存为 Zotero 笔记 */
  async _saveAsNote(paneID) {
    const st = this._state(paneID);
    if (!this._usable(st.item) || !st.history.length) {
      this._appendMsg(paneID, "sys", I18n.t("chatEmptyHistory"), "#888");
      return;
    }
    try {
      const paperTitle = (() => {
        try { return st.item.getDisplayTitle() || ""; } catch (e) { return ""; }
      })();
      const md = st.history
        .map(h => (h.role === "user" ? "**问：** " : "**答：** ") + h.content)
        .join("\n\n");
      await Notes.createFromMarkdown(
        st.item,
        `${I18n.t("noteChatTitle")}｜${paperTitle}`,
        md
      );
      this._appendMsg(paneID, "sys", "✓ " + I18n.t("chatSaved"), "#1e7d32");
    } catch (e) {
      Zotero.logError(e);
      this._appendMsg(paneID, "sys", I18n.t("errPrefix") + (e.message || e), "#c0392b");
    }
  },

  /**
   * M2b（0.10.0）：阅读器浮窗「在侧栏继续」入口。
   * 把选区作为引用块预填到已渲染 pane 的输入框并聚焦；pane 未渲染时返回 false，
   * 由调用方提示用户先打开侧栏（聚焦 context pane 的 API 在 Z10 未实证，不做）。
   */
  injectQuote(item, text) {
    for (const [paneID, st] of this._panes) {
      if (!st.refs) continue;
      if (item && this._usable(item) && (!st.item || st.item.id !== item.id)) {
        st.item = item;
        st.history = [];
        this._updateTitle(paneID);
      }
      st.refs.input.value = `【原文摘录】\n${text}\n\n`;
      try { st.refs.input.focus(); } catch (e) { /* ignore */ }
      return true;
    }
    return false;
  },

  unregister() {
    if (this._registered) {
      try {
        Zotero.ItemPaneManager.unregisterSection(this._registeredPaneID || this.PANE_ID);
      } catch (e) { /* 已注销则忽略 */ }
      this._registeredPaneID = null;
      this._registered = false;
    }
    this._panes.clear();
  },
};
