/* PaperPilot 阅读器划词浮窗 2.0（0.10.0 重构；0.15.0 交互升级）
 * 官方 API：Zotero.Reader.registerEventListener("renderTextSelectionPopup", handler, pluginID)
 *
 * 能力：翻译 / 解读 / 追问（浮窗内多轮）；流式渲染（readerPopupStream 开关，
 * 网关不透传 SSE 时 AIClient 自动降级）；结果复制 / 重试 / 写入高亮批注；
 * 划词即自动翻译（readerPopupAutoTranslate，带去重+限流+长度护栏）；
 * 会话级结果缓存（重复划词零请求）；每日请求计数（readerPopupDailyCount）。
 *
 * 0.15.0 交互升级（针对"窗口太小、不支持缩放、整体粗糙"的全面整改）：
 * - 窗口加宽 420→560px（小屏自动 min(560px,92vw)），结果区加高 260→300px
 * - 字号缩放 A−/A+（五档 0.85–1.5，pref readerPopupFontScale 持久化）
 * - 结果区一键展开/收起（展开至 60vh，会话内记忆展开状态）
 * - 流式/非流式生成中均可「停止」（流式 abort，非流式本地丢弃）
 * - 按钮统一样式（边框/圆角/hover/disabled），结果区细滚动条
 * - <style> 随 box 挂载、随浮窗销毁，不残留 reader 文档
 */
/* global Zotero, Prefs, AIClient, AIChat, AIChatPane, ChatFloat, I18n, TranslateSvc, TranslatePane */

var ReaderPopup = {
  _handler: null,
  _pluginID: null,

  // 会话级结果缓存：mode|lang|text -> result（FIFO，仅缓存翻译/解读）
  _resultCache: new Map(),
  _CACHE_LIMIT: 100,
  // 进行中的流式请求句柄（unregister 时统一 abort）
  _active: new Set(),
  // 浮窗内追问历史：readerItemID -> [{role, content}]（最近 12 条）
  _chats: new Map(),
  _CHAT_LIMIT: 30,
  // 自动翻译去重/限流
  _lastAutoKey: "",
  _lastAutoTime: 0,
  // 0.15.0：结果区展开状态（会话内记忆，跨浮窗共享）
  _expanded: false,

  register(pluginID) {
    if (this._handler) return;
    this._pluginID = pluginID;
    this._handler = (event) => this._onPopup(event);
    try {
      Zotero.Reader.registerEventListener("renderTextSelectionPopup", this._handler, pluginID);
    } catch (e) {
      Zotero.logError(new Error("PaperPilot: 划词浮窗注册失败"));
      Zotero.logError(e);
      this._handler = null;
    }
  },

  unregister() {
    for (const h of this._active) {
      try { h.abort(); } catch (e) { /* ignore */ }
    }
    this._active.clear();
    if (!this._handler) return;
    try {
      Zotero.Reader.unregisterEventListener("renderTextSelectionPopup", this._handler);
    } catch (e) { /* ignore */ }
    this._handler = null;
  },

  /* ---------- 每日请求计数（pref: YYYY-MM-DD:n） ---------- */
  _bumpDaily() {
    try {
      const d = new Date();
      const today = d.getFullYear() + "-" +
        String(d.getMonth() + 1).padStart(2, "0") + "-" +
        String(d.getDate()).padStart(2, "0");
      const raw = Prefs.get("readerPopupDailyCount", "") || "";
      const parts = String(raw).split(":");
      const count = parts[0] === today ? (parseInt(parts[1], 10) || 0) + 1 : 1;
      Prefs.set("readerPopupDailyCount", today + ":" + count);
      return count;
    } catch (e) {
      return 0;
    }
  },

  _cacheGet(key) {
    return this._resultCache.has(key) ? this._resultCache.get(key) : undefined;
  },

  _cacheSet(key, value) {
    if (this._resultCache.size >= this._CACHE_LIMIT) {
      this._resultCache.delete(this._resultCache.keys().next().value);
    }
    this._resultCache.set(key, value);
  },

  /** 当前 reader 打开的文献（常规条目优先，用于 paperMeta / 侧栏联动） */
  _currentItem(event) {
    try {
      const reader = event && event.reader;
      const id = reader && reader.itemID;
      if (!id) return null;
      const att = Zotero.Items.get(id);
      if (!att) return null;
      if (att.isRegularItem && att.isRegularItem()) return att;
      if (att.parentItemID) {
        const p = Zotero.Items.get(att.parentItemID);
        if (p) return p;
      }
      return att;
    } catch (e) {
      return null;
    }
  },

  /** 翻译/解读 prompt 构造（浮窗是纯文本渲染，必须显式禁止 Markdown，
   *  否则会受 aiSystemPrompt 里「使用 Markdown 格式输出」影响带出 **、# 等标记） */
  _buildPrompt(mode, text) {
    // 目标语言统一走 TranslateSvc（值域为规范码，prompt 里用可读名）
    const lang = (typeof TranslateSvc !== "undefined" && TranslateSvc)
      ? TranslateSvc.targetName()
      : (Prefs.get("readerPopupTargetLang", "中文") || "中文");
    if (mode === "translate") {
      return (I18n.isZh
        ? `请将以下内容翻译成${lang}，忠实原文，专业术语保留英文并用括号标注，只输出译文：\n\n`
        : `Translate the following into ${lang}, keep English terms in parentheses, output translation only:\n\n`) + text +
        (I18n.isZh
          ? "\n\n要求：纯文本输出，禁止使用任何 Markdown 标记（如 **、#、- 列表、表格），直接给译文正文。"
          : "\n\nPlain text only — no Markdown formatting (no **, #, bullets or tables).");
    }
    return (I18n.isZh
      ? "请用中文简要解读以下摘自论文的内容（含义、在论文语境中的作用），100-200 字，纯文本分段输出，禁止使用任何 Markdown 标记：\n\n"
      : "Briefly explain the following excerpt from a paper in Chinese (100-200 chars), plain text only, no Markdown:\n\n") + text;
  },

  /** 打开 PaperPilot 设置面板（浮窗里「未就绪」提示的一键入口） */
  _openSettings() {
    try {
      const paneID = (Zotero.PaperPilot && Zotero.PaperPilot._paneID) || "paperpilot-prefs";
      Zotero.Utilities.Internal.openPreferences(paneID);
    } catch (e) {
      try { Zotero.logError(e); } catch (_) { /* ignore */ }
    }
  },

  _onPopup(event) {
    try {
      const { doc, params, append } = event;
      const text =
        (params && params.annotation && params.annotation.text) ||
        (params && params.text) || "";
      const cleanText = text.trim();
      if (!cleanText || cleanText.length < 2) return;
      // 0.30.0：把划词推给右侧栏「翻译」面板。放在 readerPopupEnabled 判断**之前**——
      // 面板是独立入口，用户即使关掉浮窗也应能在侧栏里看到/翻译刚选中的内容；
      // 用官方弹窗事件缓存选中文本，避免去碰 reader 私有 API（同 zotero-pdf-translate 策略）。
      try {
        const rid = event && event.reader && event.reader.itemID;
        if (rid && typeof TranslatePane !== "undefined" && TranslatePane) {
          TranslatePane.captureSelection(rid, cleanText);
        }
      } catch (e) { /* 捕获失败不得影响浮窗 */ }
      if (!Prefs.get("readerPopupEnabled", true)) return;
      // 0.21.0：AI 未就绪不再静默 return。
      // 旧行为是 `if (!AIClient.hasKey()) return;`——浮窗什么都不渲染，
      // 用户划词后看到的只有「没反应」，完全不知道是没登录/没配 Key。
      // 现在照常渲染浮窗，只是按钮禁用 + 顶部给出精确指引与一键去设置。
      const aiReady = AIClient.hasKey();
      // 0.28.0：翻译与「解读/追问」解耦——只要有可用翻译引擎（免费引擎开箱即用，
      // 或已配置的专用引擎；引擎为 AI 大模型时仍要求 AI 就绪），划词翻译即可用。
      const trReady = (typeof TranslateSvc !== "undefined" && TranslateSvc)
        ? TranslateSvc.available() : aiReady;

      const item = this._currentItem(event);
      const annotation = (params && params.annotation && params.annotation.id)
        ? params.annotation : null;
      const NS = "http://www.w3.org/1999/xhtml";
      const mk = (tag, css, label) => {
        const el = doc.createElementNS(NS, tag);
        if (css) el.style.cssText = css;
        if (label != null) el.textContent = label;
        return el;
      };

      const mkClass = (tag, cls, label, css) => {
        const el = mk(tag, css, label);
        el.className = cls;
        return el;
      };

      // ---- 0.15.0 浮窗样式表（挂在 box 内，随浮窗一起销毁，不残留 reader 文档）----
      const style = mk("style");
      style.textContent =
        ".pp-pop-btn{padding:2px 11px;font-size:12px;line-height:1.5;border-radius:4px;" +
        "cursor:pointer;border:1px solid rgba(128,128,128,.45);background:transparent;" +
        "color:inherit;white-space:nowrap;}" +
        ".pp-pop-btn:hover:not(:disabled){background:rgba(128,128,128,.15);}" +
        ".pp-pop-btn:disabled{opacity:.5;cursor:default;}" +
        ".pp-pop-icon{padding:1px 7px;font-size:12px;border-radius:4px;cursor:pointer;" +
        "border:1px solid transparent;background:transparent;color:inherit;" +
        "line-height:1.5;white-space:nowrap;}" +
        ".pp-pop-icon:hover:not(:disabled){border-color:rgba(128,128,128,.45);" +
        "background:rgba(128,128,128,.12);}" +
        ".pp-pop-icon:disabled{opacity:.45;cursor:default;}" +
        ".pp-pop-result{white-space:pre-wrap;word-break:break-word;overflow-y:auto;" +
        "border-top:1px solid rgba(128,128,128,.35);padding-top:6px;margin-top:2px;" +
        "scrollbar-width:thin;}";

      // ---- 字号缩放（五档 0.85–1.5，pref readerPopupFontScale 持久化）----
      const SCALES = [0.85, 1, 1.15, 1.3, 1.5];
      let scaleIdx = SCALES.indexOf(Number(Prefs.get("readerPopupFontScale", "1")) || 1);
      if (scaleIdx < 0) scaleIdx = 1;

      // 窗口：420→560px（小屏 min(560px,92vw) 自适应；结果区 260→300px，可展开至 60vh）
      const box = mk("div",
        "max-width:min(560px,92vw);padding:3px 4px 5px;display:flex;flex-direction:column;gap:5px;" +
        "font-size:12.5px;line-height:1.55;text-align:left;");
      box.appendChild(style);

      // 按钮行：翻译 / 解读 / 追问 + 选区预览 + 工具（字号缩放 / 展开）
      const row = mk("div", "display:flex;gap:6px;align-items:center;flex-wrap:wrap;");
      const mkBtn = (label) => mkClass("button", "pp-pop-btn", label);
      const trBtn = mkBtn(I18n.t("popupTranslate"));
      const aiBtn = mkBtn(I18n.t("popupExplain"));
      const askBtn = mkBtn(I18n.t("popupAsk"));
      // 翻译只看翻译引擎是否可用；解读/追问仍需 AI
      if (!trReady) trBtn.disabled = true;
      if (!aiReady) for (const b of [aiBtn, askBtn]) b.disabled = true;
      const src = mk("span",
        "color:#888;flex:1;min-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" +
        "font-size:11.5px;",
        cleanText.slice(0, 50) + (cleanText.length > 50 ? "…" : ""));
      const tools = mk("div", "display:flex;gap:2px;align-items:center;margin-left:auto;");
      const zoomMinus = mkClass("button", "pp-pop-icon", "A−");
      zoomMinus.title = I18n.t("popupZoomOut");
      const zoomPlus = mkClass("button", "pp-pop-icon", "A+");
      zoomPlus.title = I18n.t("popupZoomIn");
      const expandBtn = mkClass("button", "pp-pop-icon", I18n.t("popupExpand"));
      expandBtn.title = I18n.t("popupExpand");
      tools.appendChild(zoomMinus);
      tools.appendChild(zoomPlus);
      tools.appendChild(expandBtn);
      row.appendChild(trBtn);
      row.appendChild(aiBtn);
      row.appendChild(askBtn);
      row.appendChild(src);
      row.appendChild(tools);

      // 追问输入行（默认隐藏）
      const askRow = mk("div", "display:none;gap:6px;align-items:flex-end;");
      const askInput = mk("textarea",
        "flex:1;min-width:0;resize:vertical;padding:3px 5px;font-size:12.5px;", null);
      askInput.setAttribute("rows", "2");
      askInput.setAttribute("placeholder", I18n.t("popupAskPlaceholder"));
      const askSend = mkBtn(I18n.t("popupSend"));
      askRow.appendChild(askInput);
      askRow.appendChild(askSend);

      // 结果区（字号缩放 / 展开均作用于这里）
      const result = mkClass("div", "pp-pop-result", null, "display:none;max-height:300px;");

      // 停止行：仅生成中可见（流式 abort；非流式本地丢弃）
      const stopRow = mk("div", "display:none;gap:8px;align-items:center;");
      const stopBtn = mkBtn(I18n.t("popupStop"));
      const stopHint = mk("span", "color:#888;font-size:11px;", I18n.t("popupBusyHint"));
      stopRow.appendChild(stopBtn);
      stopRow.appendChild(stopHint);

      // 结果操作行
      const actions = mk("div", "display:none;gap:6px;align-items:center;flex-wrap:wrap;");
      const copyBtn = mkBtn(I18n.t("popupCopy"));
      const retryBtn = mkBtn(I18n.t("popupRetry"));
      const wbBtn = mkBtn(I18n.t("popupWriteBack"));
      const paneBtn = mkBtn(I18n.t("popupContinuePane"));
      // 0.31.0 在浮窗继续：与「在侧栏继续」并列的第二出口（悬浮窗总能唤起，
      // 不依赖右侧栏是否已渲染，体验比侧栏入口更稳）
      const floatBtn = mkBtn(I18n.t("popupContinueFloat"));
      const status = mk("span",
        "color:#888;font-size:11.5px;flex:1;min-width:0;overflow:hidden;" +
        "text-overflow:ellipsis;white-space:nowrap;");
      actions.appendChild(copyBtn);
      actions.appendChild(retryBtn);
      if (annotation && Prefs.get("readerPopupWriteBack", true)) {
        actions.appendChild(wbBtn);
      }
      if (item) actions.appendChild(paneBtn);
      if (item) actions.appendChild(floatBtn);
      actions.appendChild(status);

      // 未就绪提示行（0.21.0 起为「不再静默」而加；0.28.0 拆成「无 AI」与「无翻译引擎」两种）
      let noticeRow = null;
      if (!aiReady || !trReady) {
        noticeRow = mk("div",
          "display:flex;gap:6px;align-items:center;flex-wrap:wrap;" +
          "font-size:11.5px;color:#c0392b;line-height:1.5;");
        noticeRow.appendChild(mk("span", "flex:1;min-width:120px;",
          trReady ? I18n.t("popupNoAi") : I18n.t("popupNoEngine")));
        const goBtn = mkBtn(I18n.t("popupGoLogin"));
        goBtn.addEventListener("click", () => this._openSettings());
        noticeRow.appendChild(goBtn);
        const hintText = trReady
          ? AIClient.guidance()
          : ((typeof TranslateSvc !== "undefined" && TranslateSvc)
              ? TranslateSvc.unavailableHint() : (AIClient.guidance() || ""));
        const hint = mk("div",
          "font-size:11px;color:#888;line-height:1.5;width:100%;", hintText);
        noticeRow.appendChild(hint);
      }

      box.appendChild(row);
      if (noticeRow) box.appendChild(noticeRow);
      box.appendChild(askRow);
      box.appendChild(result);
      box.appendChild(stopRow);
      box.appendChild(actions);

      /* ----- 缩放 / 展开应用与事件 ----- */
      const applyScale = () => {
        result.style.fontSize = (12.5 * SCALES[scaleIdx]).toFixed(2) + "px";
        result.style.lineHeight = SCALES[scaleIdx] >= 1.3 ? "1.55" : "1.65";
        zoomMinus.disabled = scaleIdx <= 0;
        zoomPlus.disabled = scaleIdx >= SCALES.length - 1;
      };
      const saveScale = () => {
        applyScale();
        try { Prefs.set("readerPopupFontScale", String(SCALES[scaleIdx])); } catch (e) { /* ignore */ }
      };
      const applyExpand = () => {
        result.style.maxHeight = this._expanded ? "min(60vh,540px)" : "300px";
        expandBtn.textContent = this._expanded ? I18n.t("popupCollapse") : I18n.t("popupExpand");
        expandBtn.title = this._expanded ? I18n.t("popupCollapse") : I18n.t("popupExpand");
      };
      applyScale();
      applyExpand();
      zoomMinus.addEventListener("click", () => { if (scaleIdx > 0) { scaleIdx--; saveScale(); } });
      zoomPlus.addEventListener("click", () => { if (scaleIdx < SCALES.length - 1) { scaleIdx++; saveScale(); } });
      expandBtn.addEventListener("click", () => { this._expanded = !this._expanded; applyExpand(); });

      /* ----- 运行状态 ----- */
      let lastRun = null; // {kind:"translate"|"explain"|"ask", question?}
      let lastAnswer = "";
      let currentHandle = null;
      let busy = false;
      let stopped = false; // 非流式停止：应答到达后丢弃不渲染

      const setBusy = (b) => {
        busy = b;
        for (const btn of [trBtn, aiBtn, askBtn, askSend, retryBtn]) btn.disabled = b;
      };

      const showError = (e) => {
        stopRow.style.display = "none";
        if (!result.isConnected) return;
        if (e && e.message === "ABORTED") { result.style.display = "none"; return; }
        result.style.display = "block";
        result.textContent = I18n.t("errPrefix") + ((e && e.message) || e);
      };

      /** 统一执行：流式优先，结果就绪后显示操作行；返回最终答案（失败为 null）
       *  opts.svc = true 时改走 TranslateSvc（专用翻译引擎，一次性结果无流式） */
      const execute = async (messages, cacheKey, opts) => {
        if (currentHandle) { try { currentHandle.abort(); } catch (e) { /* ignore */ } }
        stopped = false;
        setBusy(true);
        result.style.display = "block";
        stopRow.style.display = "flex";
        actions.style.display = "none";
        status.textContent = "";

        // 缓存命中：零请求直接渲染
        if (cacheKey) {
          const hit = this._cacheGet(cacheKey);
          if (hit !== undefined) {
            lastAnswer = hit;
            result.textContent = hit;
            stopRow.style.display = "none";
            actions.style.display = "flex";
            status.textContent = "⚡cache";
            setBusy(false);
            return hit;
          }
        }

        result.textContent = I18n.t("chatThinking");
        const count = this._bumpDaily();
        if (count === 500) status.textContent = I18n.t("popupDailyNotice");

        let acc = "";
        const onDelta = (chunk) => {
          if (!result.isConnected || stopped) return;
          if (!acc) result.textContent = "";
          acc += chunk;
          result.textContent = acc;
          result.scrollTop = result.scrollHeight;
        };

        try {
          let answer;
          let note = "";
          if (opts && opts.svc) {
            // 专用翻译引擎（Google/DeepL/百度…）：一次性结果，无流式
            const rr = await TranslateSvc.translate(cleanText, { to: TranslateSvc.targetCode() });
            if (!result.isConnected) return null;
            if (stopped) { result.style.display = "none"; stopRow.style.display = "none"; return null; }
            if (!rr.ok) throw new Error(rr.error);
            answer = rr.text;
            result.textContent = answer;
            if (rr.fallback && rr.engineName) note = "↩ " + rr.engineName;
          } else if (Prefs.get("readerPopupStream", true) && AIClient.chatStream) {
            currentHandle = AIClient.chatStream(messages, onDelta);
            this._active.add(currentHandle);
            answer = await currentHandle.promise;
          } else {
            answer = await AIClient.chat(messages);
            if (!result.isConnected) return null;
            if (stopped) { result.style.display = "none"; stopRow.style.display = "none"; return null; }
            result.textContent = answer;
          }
          if (stopped) { result.style.display = "none"; stopRow.style.display = "none"; return null; }
          lastAnswer = answer;
          if (cacheKey && answer) this._cacheSet(cacheKey, answer);
          if (result.isConnected) {
            stopRow.style.display = "none";
            actions.style.display = "flex";
            status.textContent = count === 500 ? I18n.t("popupDailyNotice") : note;
          }
          return answer;
        } catch (e) {
          showError(e);
          return null;
        } finally {
          if (currentHandle) this._active.delete(currentHandle);
          currentHandle = null;
          setBusy(false);
        }
      };

      // 停止：流式直接 abort（promise 以 ABORTED 拒绝→静默收起）；
      // 非流式请求无 abort 能力，标记后应答到达即丢弃
      stopBtn.addEventListener("click", () => {
        stopped = true;
        if (currentHandle) {
          try { currentHandle.abort(); } catch (e) { /* ignore */ }
        } else {
          result.style.display = "none";
          stopRow.style.display = "none";
          setBusy(false);
        }
      });

      const runTask = (mode) => {
        lastRun = { kind: mode };
        const tv = (typeof TranslateSvc !== "undefined" && TranslateSvc) ? TranslateSvc : null;
        const lang = tv ? tv.targetCode()
          : (Prefs.get("readerPopupTargetLang", "zh-CN") || "zh-CN");
        // 翻译：活动引擎为 AI 大模型且 AI 就绪 → 走流式（与旧版一致，体验最好）；
        // 否则交给 TranslateSvc（免费/专用引擎；大模型不可用时自动回退到备用引擎）
        const useSvc = mode === "translate" && !!tv && !(aiReady && tv.isLLM());
        const cacheKey = mode + "|" +
          (useSvc ? "svc:" + tv.cfg().active + "|" : "") +
          lang + "|" + cleanText;
        execute([
          { role: "system", content: Prefs.get("aiSystemPrompt", "") || "" },
          { role: "user", content: this._buildPrompt(mode, cleanText) },
        ], cacheKey, { svc: useSvc });
      };

      const runAsk = async (question) => {
        lastRun = { kind: "ask", question };
        // 浮窗内多轮：历史按 reader 条目隔离
        const key = item ? String(item.id) : "_";
        if (!this._chats.has(key)) this._chats.set(key, []);
        if (this._chats.size > this._CHAT_LIMIT) {
          this._chats.delete(this._chats.keys().next().value);
        }
        const history = this._chats.get(key);

        let system = Prefs.get("aiSystemPrompt", "") || "";
        if (item) {
          try {
            const meta = AIChat.paperMeta(item);
            system += `\n\n当前用户正在阅读以下论文：\n标题：${meta.title}\n作者：${meta.creators}\n发表：${meta.pub} ${meta.year}`;
          } catch (e) { /* ignore */ }
        }
        const userMsg = `【原文摘录】\n${cleanText}\n\n【问题】\n${question}` +
          (I18n.isZh
            ? "\n\n要求：纯文本回答，禁止使用任何 Markdown 标记（如 **、#、- 列表、表格）。"
            : "\n\nAnswer in plain text — no Markdown formatting.");
        const messages = [{ role: "system", content: system }];
        messages.push(...history.slice(-12));
        messages.push({ role: "user", content: userMsg });

        const answer = await execute(messages, null);
        if (answer) {
          history.push({ role: "user", content: userMsg });
          history.push({ role: "assistant", content: answer });
          this._chats.set(key, history.slice(-12));
        }
      };

      /* ----- 事件绑定 ----- */
      trBtn.addEventListener("click", () => { if (!busy) runTask("translate"); });
      aiBtn.addEventListener("click", () => { if (!busy) runTask("explain"); });
      askBtn.addEventListener("click", () => {
        askRow.style.display = askRow.style.display === "none" ? "flex" : "none";
        if (askRow.style.display === "flex") askInput.focus();
      });
      const doAsk = () => {
        const q = askInput.value.trim();
        if (!q || busy) return;
        askInput.value = "";
        runAsk(q);
      };
      askSend.addEventListener("click", doAsk);
      askInput.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
          ev.preventDefault();
          doAsk();
        }
      });

      copyBtn.addEventListener("click", () => {
        if (!lastAnswer) return;
        try {
          Zotero.Utilities.Internal.copyText(lastAnswer);
          copyBtn.textContent = I18n.t("popupCopied");
          setTimeout(() => { copyBtn.textContent = I18n.t("popupCopy"); }, 1500);
        } catch (e) { /* ignore */ }
      });

      retryBtn.addEventListener("click", () => {
        if (busy || !lastRun) return;
        if (lastRun.kind === "ask") runAsk(lastRun.question);
        else runTask(lastRun.kind);
      });

      // M3：写入高亮批注 comment（仅在高亮批注上划词时出现该按钮）
      wbBtn.addEventListener("click", async () => {
        if (!lastAnswer || !annotation) return;
        wbBtn.disabled = true;
        try {
          const reader = event && event.reader;
          const att = reader && reader.itemID ? Zotero.Items.get(reader.itemID) : null;
          const libraryID = att ? att.libraryID : (item ? item.libraryID : null);
          const anno = libraryID
            ? Zotero.Items.getByLibraryAndKey(libraryID, annotation.id) : null;
          if (!anno) throw new Error("annotation not found");
          const prev = anno.annotationComment || "";
          anno.annotationComment = prev ? prev + "\n\n" + lastAnswer : lastAnswer;
          await anno.saveTx();
          status.textContent = I18n.t("popupWriteBackDone");
        } catch (e) {
          status.textContent = I18n.t("popupWriteBackFail") + ((e && e.message) || e);
        } finally {
          wbBtn.disabled = false;
        }
      });

      // M2b：送入侧栏继续（pane 未渲染则提示先打开）
      paneBtn.addEventListener("click", () => {
        try {
          const ok = AIChatPane.injectQuote(item, cleanText);
          status.textContent = ok ? "" : I18n.t("popupPaneUnavailable");
        } catch (e) {
          status.textContent = I18n.t("popupPaneUnavailable");
        }
      });

      // 0.31.0：送入 AI 问答悬浮窗继续（悬浮窗总能唤起，无「先打开面板」前置条件）
      floatBtn.addEventListener("click", () => {
        try {
          ChatFloat.injectQuote(item, cleanText);
        } catch (e) {
          Zotero.logError(e);
        }
      });

      append(box);

      // 划词即自动翻译：去重 + 800ms 限流 + 长度护栏
      try {
        if (trReady && Prefs.get("readerPopupAutoTranslate", false) &&
            cleanText.length >= 2 && cleanText.length <= 2000) {
          const now = Date.now();
          const autoKey = "translate|" + cleanText;
          if (autoKey !== this._lastAutoKey && now - this._lastAutoTime >= 800) {
            this._lastAutoKey = autoKey;
            this._lastAutoTime = now;
            runTask("translate");
          }
        }
      } catch (e) { /* 自动模式失败不影响手动按钮 */ }
    } catch (e) {
      Zotero.logError(e);
    }
  },
};
