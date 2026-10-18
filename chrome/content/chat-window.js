/* PaperPilot AI 问答分屏窗口（0.31.0 → 0.47.0 重构）
 * 运行在窗口作用域：经 window.arguments 拿 Zotero 引用（workbench/lib-ask 同款）。
 * 会话与发送逻辑**单源**在 Zotero.PaperPilot.chatFloat（ChatFloat 模块）：
 *   - 本窗口注册为 ChatFloat 的一个 UI entry（CF._wins），复用其 Prompt 标签
 *     渲染 / 长按编辑 / 上下文 chip 渲染 / 条目拖入（_bindItemDrop）；
 *   - 发送走 CF.runSend + 本窗口自己的 ui 回调（气泡带 hover 操作、流式光标）。
 * 关窗后会话仍保留在模块里（悬浮窗 / 下次唤起继续）。
 *
 * ★ 0.47.0 两个根因修复（真机探针实锤）：
 *   1) 脚本时序：XUL 窗口顶部 <script> 在后续 DOM 解析完成前执行——旧版拿到的
 *      元素全是 null，`sendBtn.addEventListener` 直接 TypeError，所有事件绑定
 *      从未生效（「无法发送」的真正原因；0.45.99 勾选对话框同款坑，§39 纪律）。
 *      现按 ref-import 同款 boot() + DOMContentLoaded/readyState 双保险。
 *   2) 输入框「一片蓝色」：未显式定型的表单控件被平台层皮肤接管（强制
 *      height:26px + 透明底 + :focus 蓝渐变 + ::selection 蓝底）。修复三保险：
 *      no-native="true" + ID 选择器显式配色 + appearance:none（见 xhtml 样式）。
 * 窗口默认尺寸加大 + persist 记忆位置/尺寸/最大化，拖拽边缘自由调节。
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

  // 窗口级错误钩子：未捕获异常写 boot 日志（0.31.0 版脚本曾因时序裸跑静默死亡，
  // 用户侧只表现为「点了没反应」，装了探针才定位到——这类失败必须留下日志）
  try {
    window.addEventListener("error", (ev) => {
      try {
        if (PP && PP._diag) {
          PP._diag("chatwin error: " + ev.message + " @" +
            String(ev.filename || "").split("/").pop() + ":" + ev.lineno);
        }
      } catch (e) { /* ignore */ }
    });
  } catch (e) { /* ignore */ }

  function boot() {
    const $ = (id) => document.getElementById(id);
    const rootEl = $("pp-cw-root");
    const msgsEl = $("pp-cw-msgs");
    const inputEl = $("pp-cw-input");
    const sendBtn = $("pp-cw-send");
    const saveBtn = $("pp-cw-save");
    const clearBtn = $("pp-cw-clear");
    const closeBtn = $("pp-cw-close");
    const titleEl = $("pp-cw-title");
    const subEl = $("pp-cw-sub");
    const chipsEl = $("pp-cw-chips");
    const ctxChipsEl = $("pp-cw-ctx-chips");
    const hintEl = $("pp-cw-hint");

    if (!CF || !rootEl) {
      if (msgsEl) {
        msgsEl.textContent = zh ? "错误：无法访问 PaperPilot 模块" : "Error: PaperPilot module unavailable";
      }
      return;
    }

    /* ---------- 主题（自定义界面主题优先；无则跟随系统深浅色） ---------- */
    try {
      let dark = false;
      const theme = PP.uiTheme && PP.uiTheme.current && PP.uiTheme.current();
      if (theme && theme.dark) dark = true;
      else if (window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: dark)").matches) dark = true;
      rootEl.setAttribute("data-theme", dark ? "dark" : "light");
    } catch (e) {
      rootEl.setAttribute("data-theme", "light");
    }

    /* ---------- 文案（xhtml 里的中文仅作首帧兜底） ---------- */
    document.title = T("chatFloatWindowTitle");
    sendBtn.textContent = T("chatSend");
    saveBtn.textContent = T("chatSave");
    clearBtn.textContent = T("chatClear");
    closeBtn.textContent = zh ? "关闭" : "Close";
    hintEl.textContent = T("chatFloatOpenHint");
    inputEl.setAttribute("placeholder", T("chatPlaceholder"));
    subEl.textContent = T("chatWinSub");
    try {
      const header = document.querySelector(".pp-cw-header");
      const icon = CF._chatIcon(document, 16);
      icon.style.flex = "none";
      header.insertBefore(icon, header.firstChild);
    } catch (e) { /* 图标失败不影响功能 */ }

    function el(tag, cls, text) {
      const n = document.createElementNS(XHTML, tag);
      if (cls) n.setAttribute("class", cls);
      if (text != null) n.textContent = text;
      return n;
    }

    function scrollBottom() { msgsEl.scrollTop = msgsEl.scrollHeight; }

    /* ==================== 气泡 ==================== */

    /** 气泡 hover 操作按钮 */
    function makeActBtn(label, kind, fn) {
      const b = el("button", "pp-cw-act", label);
      b.setAttribute("type", "button");
      b.setAttribute("data-act", kind);
      b.addEventListener("click", fn);
      return b;
    }

    function attachActions(bubble, role) {
      if (role !== "user" && role !== "assistant") return;
      const acts = el("div", "pp-cw-acts");
      acts.appendChild(makeActBtn(T("chatCopy"), "copy", () => {
        const ok = CF._clipboardWrite(bubble.__ppText || "");
        const btn = acts.querySelector('[data-act="copy"]');
        if (btn) {
          const orig = T("chatCopy");
          btn.textContent = ok ? "✓ " + T("chatCopied") : "✗";
          window.setTimeout(() => { btn.textContent = orig; }, 1200);
        }
      }));
      bubble.appendChild(acts);
    }

    /** 「重新生成」只挂在最后一条 assistant 气泡上（busy 中隐藏） */
    function updateRegenButtons() {
      for (const b of msgsEl.querySelectorAll('[data-act="regen"]')) b.remove();
      if (CF.session.busy) return;
      const all = msgsEl.querySelectorAll(".pp-cw-msg.assistant");
      if (!all.length) return;
      const last = all[all.length - 1];
      const acts = last.querySelector(":scope > .pp-cw-acts");
      if (acts) acts.appendChild(makeActBtn(T("chatRegen"), "regen", regenerate));
    }

    function appendBubble(role, text, opts) {
      const isUser = role === "user";
      const isAssistant = role === "assistant";
      const err = opts && opts.err;
      // 空态提示（非 .pp-cw-msg 的第一个子节点）在首条消息出现时移除
      const hint = msgsEl.querySelector(":scope > .pp-cw-empty");
      if (hint) hint.remove();
      const b = el("div", "pp-cw-msg " + role + (err ? " err" : ""));
      b.__ppText = text;
      if (isAssistant && !err) {
        try { b.innerHTML = PP.mdLite.toHtml(text); }
        catch (e) { b.textContent = text; }
      } else {
        b.textContent = text;
      }
      attachActions(b, role);
      msgsEl.appendChild(b);
      scrollBottom();
      return b;
    }

    function sysNote(text, err) {
      appendBubble("sys", text, { err: !!err });
    }

    let lastHistLen = -1;
    let lastTitle = "";

    function renderHistory() {
      const s = CF.session;
      const title = (s.item && s.item.getDisplayTitle()) || T("chatFloatTitle");
      titleEl.textContent = title;
      titleEl.setAttribute("title", title);
      lastHistLen = s.history.length;
      lastTitle = title;
      msgsEl.textContent = "";
      if (!s.history.length) {
        msgsEl.appendChild(el("div", "pp-cw-empty",
          s.item ? T("chatEmpty") + "\n" + T("chatFloatOpenHint") : T("chatNoItem")));
        return;
      }
      for (const h of s.history) appendBubble(h.role, h.content);
      scrollBottom();
      updateRegenButtons();
    }

    /* ==================== 发送 / 停止 / 重新生成 ==================== */

    function autoGrow() {
      inputEl.style.height = "auto";
      const h = Math.min(Math.max(inputEl.scrollHeight, 52), 200);
      inputEl.style.height = h + "px";
    }

    function setBusy(busy) {
      sendBtn.textContent = busy ? T("chatFloatStop") : T("chatSend");
      sendBtn.classList.toggle("busy", busy);
      saveBtn.disabled = busy;
      clearBtn.disabled = busy;
      updateRegenButtons();
    }

    /** 单轮发送（chips / 手动 / 重新生成共用） */
    function sendQuestion(question) {
      const s = CF.session;
      if (s.busy) { CF.stop(); return; }
      let q = String(question || "").trim();
      if (!q) return;
      // 触发正则命中 → 套用标签提示词（与悬浮窗同口径）
      if (CF._applyTrigger) q = CF._applyTrigger(q);
      inputEl.value = "";
      autoGrow();

      let statusBubble = null;
      let streamBubble = null;
      let cursor = null;

      CF.runSend(q, {
        onUser(text) { appendBubble("user", text); },
        onStatus(text) {
          if (statusBubble && statusBubble.isConnected) statusBubble.textContent = text;
          else statusBubble = appendBubble("sys", text);
        },
        onDelta(acc) {
          if (!streamBubble) {
            if (statusBubble) { statusBubble.remove(); statusBubble = null; }
            streamBubble = appendBubble("assistant", "");
            cursor = el("span", "pp-cw-cursor");
          }
          try { streamBubble.innerHTML = PP.mdLite.toHtml(acc); }
          catch (e) { streamBubble.textContent = acc; }
          streamBubble.appendChild(cursor);
          scrollBottom();
        },
        onDone(text) {
          if (statusBubble) { statusBubble.remove(); statusBubble = null; }
          if (cursor) { cursor.remove(); cursor = null; }
          if (streamBubble) {
            streamBubble.__ppText = text;
            try { streamBubble.innerHTML = PP.mdLite.toHtml(text); }
            catch (e) { streamBubble.textContent = text; }
          } else {
            appendBubble("assistant", text);
          }
          scrollBottom();
          updateRegenButtons();
        },
        onCost(info) {
          const line = T("chatCostNote") + " " + info.costText
            + (info.balanceText ? " · " + T("chatCostLeft") + " " + info.balanceText : "");
          sysNote(line);
        },
        onError(msg) {
          if (statusBubble) { statusBubble.remove(); statusBubble = null; }
          if (streamBubble) { streamBubble.remove(); streamBubble = null; }
          if (cursor) { cursor.remove(); cursor = null; }
          sysNote(msg, true);
          updateRegenButtons();
        },
        onAbort() {
          if (statusBubble) { statusBubble.remove(); statusBubble = null; }
          if (streamBubble) { streamBubble.remove(); streamBubble = null; }
          if (cursor) { cursor.remove(); cursor = null; }
          updateRegenButtons();
        },
        onBusy(busy) { setBusy(busy); },
        onItemChanged(title) {
          titleEl.textContent = title || T("chatFloatTitle");
          titleEl.setAttribute("title", title || "");
          lastTitle = title || "";
        },
      });
    }

    function doSend() {
      sendQuestion(inputEl.value);
    }

    /** 重新生成：弹掉末尾的回答与提问，把最后一个问题原样重发 */
    function regenerate() {
      const s = CF.session;
      if (s.busy) return;
      const h = s.history;
      if (!h.length) { sysNote(T("chatRegenNone")); return; }
      let q = null;
      while (h.length) {
        const last = h[h.length - 1];
        h.pop();
        if (last.role === "user") { q = last.content; break; }
      }
      renderHistory();
      if (q != null) sendQuestion(q);
    }

    /* ==================== 注册为 ChatFloat UI entry ====================
     * 复用：Prompt 标签渲染/长按编辑（_renderChips / _openTagEditor）、
     * 上下文 chip（_renderCtxChips）、条目拖入（_bindItemDrop）。
     * entry.send 存在时，ChatFloat 的标签点击走本窗口自己的发送管线。 */
    const entry = {
      win: window,
      root: rootEl,
      refs: {
        chips: chipsEl, ctxChips: ctxChipsEl, input: inputEl,
        msgs: msgsEl, titleEl, sendBtn, saveBtn, clearBtn,
      },
      send: () => doSend(),
    };
    try { CF._wins.set(window, entry); } catch (e) { /* 悬浮窗侧不可用时降级 */ }
    try { CF._renderChips(entry); } catch (e) { /* ignore */ }
    try { CF._renderCtxChips(entry); } catch (e) { /* ignore */ }
    try { CF._bindItemDrop(entry); } catch (e) { /* ignore */ }

    window.addEventListener("unload", () => {
      try { CF._wins.delete(window); } catch (e) { /* ignore */ }
    });

    /* 焦点回到窗口时若会话被别处推进（悬浮窗发送/切换条目），重绘同步 */
    window.addEventListener("focus", () => {
      try {
        const s = CF.session;
        const title = (s.item && s.item.getDisplayTitle()) || T("chatFloatTitle");
        if (s.history.length !== lastHistLen || title !== lastTitle) renderHistory();
      } catch (e) { /* ignore */ }
    });

    /* ==================== 事件 ==================== */

    sendBtn.addEventListener("click", doSend);

    inputEl.addEventListener("input", autoGrow);

    inputEl.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        doSend();
      } else if (ev.key === "ArrowUp" && ev.selectionStart === 0 && ev.selectionEnd === 0) {
        // ↑：回溯输入历史（zotero-gpt 同款，与悬浮窗一致）
        const s = CF.session;
        if (s.inputHistory.length) {
          ev.preventDefault();
          if (s.histIdx === -1) s.histIdx = s.inputHistory.length - 1;
          else if (s.histIdx > 0) s.histIdx--;
          inputEl.value = s.inputHistory[s.histIdx] || "";
          autoGrow();
        }
      } else if (ev.key === "ArrowDown" && ev.selectionStart === inputEl.value.length) {
        const s = CF.session;
        if (s.histIdx !== -1) {
          ev.preventDefault();
          if (s.histIdx < s.inputHistory.length - 1) {
            s.histIdx++;
            inputEl.value = s.inputHistory[s.histIdx] || "";
          } else {
            s.histIdx = -1;
            inputEl.value = "";
          }
          autoGrow();
        }
      } else if (ev.key === "Escape" && !ev.isComposing) {
        // Esc：先关标签编辑层，再关窗口（会话保留在 ChatFloat.session）
        const editor = document.getElementById("paperpilot-tag-editor");
        if (editor) editor.remove();
        else window.close();
      }
    });

    saveBtn.addEventListener("click", async () => {
      if (saveBtn.disabled) return;
      saveBtn.disabled = true;
      const ok = await CF.saveHistoryAsNote({
        onError: (m) => sysNote(m, true),
      });
      saveBtn.disabled = CF.session.busy;
      if (ok) sysNote("✓ " + T("chatSaved"));
    });

    clearBtn.addEventListener("click", () => {
      if (clearBtn.disabled) return;
      CF.session.history = [];
      CF.session.inputHistory = [];
      CF.session.histIdx = -1;
      renderHistory();
    });

    closeBtn.addEventListener("click", () => window.close());

    renderHistory();
    autoGrow();
    try { inputEl.focus(); } catch (e) { /* ignore */ }
  }

  // ★ 时序守卫（§39 纪律）：XUL 顶部脚本先于 DOM 执行，等 DOMContentLoaded 再 boot
  const rs = (typeof document !== "undefined" && document.readyState) || "complete";
  if (rs === "loading" || rs === "uninitialized") {
    window.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
