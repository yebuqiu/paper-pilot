/* PaperPilot AI 问答分屏窗口（0.31.0）
 * 运行在窗口作用域：经 window.arguments 拿 Zotero 引用（lib-ask 同款），
 * 会话与发送逻辑**单源**在 Zotero.PaperPilot.chatFloat（ChatFloat 模块）——
 * 本窗口只做 UI：读 chatFloat.session 渲染历史，发送走 chatFloat.runSend。
 * 关窗后会话仍保留在模块里（下次唤起悬浮窗/分屏窗口继续）。
 */
/* global window, document */
(function () {
  const XHTML = "http://www.w3.org/1999/xhtml";
  const args = (window.arguments && window.arguments[0]) || {};
  const Z = args.Zotero || (window.opener && window.opener.Zotero);
  const PP = Z && Z.PaperPilot;
  const CF = PP && PP.chatFloat;
  const zh = Z && (Z.locale || "").toLowerCase().startsWith("zh");
  const T = PP && PP.i18n ? PP.i18n.t : (k) => k;

  const $ = (id) => document.getElementById(id);
  const msgsEl = $("pp-cw-msgs");
  const inputEl = $("pp-cw-input");
  const sendBtn = $("pp-cw-send");
  const saveBtn = $("pp-cw-save");
  const clearBtn = $("pp-cw-clear");
  const closeBtn = $("pp-cw-close");
  const titleEl = $("pp-cw-title");

  if (!CF) {
    msgsEl.textContent = zh ? "错误：无法访问 PaperPilot 模块" : "Error: PaperPilot module unavailable";
    return;
  }

  function el(tag, css, text) {
    const n = document.createElementNS(XHTML, tag);
    if (css) n.style.cssText = css;
    if (text != null) n.textContent = text;
    return n;
  }

  function appendBubble(role, text, color) {
    const s = CF.session;
    const isUser = role === "user";
    const isAssistant = role === "assistant";
    const hint = msgsEl.querySelector(":scope > div:not(.pp-cf-msg)");
    if (hint) hint.remove();
    const b = el("div", (isAssistant ? "" : "white-space:pre-wrap;") +
      (color ? `color:${color};background:transparent;border:0;` :
        isUser ? "background:rgba(45,108,223,.13);border:1px solid rgba(45,108,223,.33);"
               : "background:rgba(136,136,136,.09);border:1px solid rgba(136,136,136,.2);"), null);
    b.setAttribute("class", "pp-cf-msg");
    b.style.padding = "6px 8px";
    b.style.borderRadius = "6px";
    b.style.wordBreak = "break-word";
    if (isAssistant && !color) {
      try { b.innerHTML = PP.mdLite.toHtml(text); }
      catch (e) { b.textContent = text; }
    } else {
      b.textContent = text;
    }
    msgsEl.appendChild(b);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    return b;
  }

  function renderHistory() {
    const s = CF.session;
    titleEl.setAttribute("value", s.item ? (s.item.getDisplayTitle() || T("chatFloatTitle"))
      : T("chatFloatTitle"));
    msgsEl.textContent = "";
    if (!s.history.length) {
      const hint = el("div", "color:var(--fill-tertiary,#888);padding:4px 0;font-size:12px;white-space:pre-line;",
        (s.item ? T("chatEmpty") : T("chatNoItem")));
      msgsEl.appendChild(hint);
      return;
    }
    for (const h of s.history) appendBubble(h.role, h.content, null);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  // Prompt 快捷标签：点击即发送（与悬浮窗一致）
  try {
    const chipsBox = $("pp-cw-chips");
    const list = (PP.prompts.all() || []).slice(0, 8);
    for (const p of list) {
      const chip = el("button",
        "max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" +
        "padding:1px 8px;font-size:11px;border-radius:10px;cursor:pointer;" +
        "border:1px solid var(--color-border,rgba(128,128,128,.4));" +
        "background:var(--fill-quinary,rgba(128,128,128,.08));color:var(--fill-secondary,#666);",
        p.name);
      chip.addEventListener("click", () => {
        inputEl.value = p.text;
        doSend();
      });
      chipsBox.appendChild(chip);
    }
  } catch (e) { /* ignore */ }

  let statusBubble = null;
  let streamBubble = null;

  function doSend() {
    const s = CF.session;
    if (s.busy) { CF.stop(); return; } // 生成中点发送 = 停止（与悬浮窗一致）
    const q = inputEl.value.trim();
    if (!q) return;
    inputEl.value = "";
    CF.runSend(q, {
      onUser(text) { appendBubble("user", text); },
      onStatus(text) {
        if (statusBubble && statusBubble.isConnected) statusBubble.textContent = text;
        else statusBubble = appendBubble("sys", text, "#888");
      },
      onDelta(acc) {
        if (!streamBubble) {
          if (statusBubble) { statusBubble.remove(); statusBubble = null; }
          streamBubble = appendBubble("assistant", "");
        }
        try { streamBubble.innerHTML = PP.mdLite.toHtml(acc); }
        catch (e) { streamBubble.textContent = acc; }
        msgsEl.scrollTop = msgsEl.scrollHeight;
      },
      onDone(text) {
        if (statusBubble) { statusBubble.remove(); statusBubble = null; }
        if (streamBubble) {
          try { streamBubble.innerHTML = PP.mdLite.toHtml(text); }
          catch (e) { streamBubble.textContent = text; }
        } else {
          appendBubble("assistant", text);
        }
        msgsEl.scrollTop = msgsEl.scrollHeight;
      },
      onError(msg) {
        if (statusBubble) { statusBubble.remove(); statusBubble = null; }
        if (streamBubble) { streamBubble.remove(); streamBubble = null; }
        appendBubble("sys", msg, "#c0392b");
      },
      onAbort() {
        if (statusBubble) { statusBubble.remove(); statusBubble = null; }
        if (streamBubble) { streamBubble.remove(); streamBubble = null; }
      },
      onBusy(busy) {
        sendBtn.textContent = busy ? (zh ? "停止" : "Stop") : (zh ? "发送" : "Send");
        saveBtn.disabled = busy;
        clearBtn.disabled = busy;
      },
      onItemChanged(title) {
        titleEl.setAttribute("value", title || T("chatFloatTitle"));
      },
    });
  }

  sendBtn.addEventListener("click", doSend);
  inputEl.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      doSend();
    }
  });

  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    const ok = await CF.saveHistoryAsNote({
      onError: (m) => appendBubble("sys", m, "#c0392b"),
    });
    saveBtn.disabled = false;
    if (ok) appendBubble("sys", "✓ " + T("chatSaved"), "#1e7d32");
  });

  clearBtn.addEventListener("click", () => {
    CF.session.history = [];
    CF.session.inputHistory = [];
    CF.session.histIdx = -1;
    renderHistory();
  });

  closeBtn.addEventListener("click", () => window.close());

  renderHistory();
  try { inputEl.focus(); } catch (e) { /* ignore */ }
})();
