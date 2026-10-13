/* PaperPilot 阅读器右侧栏 · 翻译面板（0.30.0）
 *
 * 为什么要有它：0.28.0 起翻译引擎已经很多（13 个），但入口散在「右键菜单 + 设置面板」
 * 里 —— 想换引擎要开设置、想看译文要在浮窗里看、想做全文对照要另开窗口。用户在
 * PDF 阅读时最需要的三件事（选一段就译 / 换引擎 / 看结果）都不在视线内。
 *
 * 本面板把翻译的「操作 + 选项 + 结果」整体搬进右侧栏（Zotero 官方 ItemPane section，
 * 同时出现在主窗口条目面板与 PDF 阅读器右侧栏；sidenav 给一个独立图标位）。
 * 参考 zotero-pdf-translate 的做法：它同样用 ItemPaneManager.registerSection 把翻译
 * 面板放进侧栏，并且**用官方 renderTextSelectionPopup 事件缓存「最近选中文本」**，
 * 不去碰 reader 私有 API —— 我们沿用同一策略（见 captureSelection()）。
 *
 * 面板内容（自上而下）：
 *   ① 引擎 + 源语言 + 目标语言（即时生效，写同一份 pref / translateCfg）
 *   ② 待译文本框：划词自动填入，也可直接粘贴；「翻译 / 清空」
 *   ③ 结果区：译文 + 引擎徽章（回退时标注实际引擎）+ 复制
 *   ④ 全文对照：进度条 + 逐段对照列表 + 「双栏窗口」「导出双语笔记」
 *   ⑤ 标题与摘要：一键翻译
 *   ⑥ 底部：引擎设置 / 功能中心 快捷入口
 *
 * ⚠️ 两条本项目已踩过的坑（写之前务必遵守）：
 *   ① `onRender` 是 Z10 的**必填** hook —— 缺了 registerSection **不抛错、返回 false**
 *      （见 ai-chat-pane.js 注释与 Z10 itemPaneManager.js schema）。本模块 UI 一律建在
 *      onRender 里，并显式检查返回值。
 *   ② 注销要用 registerSection 的**返回值**（带命名空间的主键），不是注册时的 paneID。
 */
/* global Zotero, Services, Prefs, TranslateSvc, AIChat, BilingualTranslate, Notes, I18n */

var TranslatePane = {
  PANE_ID: "paperpilot-translate",
  ICON: "chrome://paperpilot/content/icons/translate.svg",

  _panes: new Map(),      // paneID -> 状态
  _registered: false,
  _registeredPaneID: null,
  // 最近一次划词（由 ReaderPopup 在 popup 事件里推入；不依赖 reader 私有 API）
  _lastSel: { itemID: 0, text: "" },

  /* ---------------- 基础 ---------------- */

  _h(doc, tag, attrs, text) {
    const el = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
    if (attrs) for (const k in attrs) {
      if (attrs[k] === undefined || attrs[k] === null) continue;
      if (k === "style") el.style.cssText = attrs[k];
      else el.setAttribute(k, attrs[k]);
    }
    if (text != null) el.textContent = text;
    return el;
  },

  _state(paneID) {
    if (!this._panes.has(paneID)) {
      this._panes.set(paneID, {
        item: null,
        refs: null,
        busy: false,
        fullBusy: false,
        pairs: [],       // 全文对照结果 [{src,dst}]
      });
    }
    return this._panes.get(paneID);
  },

  /** 可翻译的条目：常规条目（走标题/摘要/全文）或 PDF 附件 */
  _usable(item) {
    return !!(item && (
      (item.isRegularItem && item.isRegularItem()) ||
      (item.isPDFAttachment && item.isPDFAttachment())
    ));
  },

  /** 划词缓存入口：由 ReaderPopup._onPopup 在**任何开关判断之前**调用 */
  captureSelection(itemID, text) {
    const t = String(text == null ? "" : text).trim();
    if (!t) return;
    this._lastSel = { itemID: Number(itemID) || 0, text: t };
    // 若当前有面板正显示同一条目，同步填入待译框（只填空白框，不覆盖用户已编辑内容）
    for (const [pid, st] of this._panes) {
      if (!st.refs || !st.item) continue;
      if (this._lastSel.itemID && st.item.id !== this._lastSel.itemID) continue;
      const ta = st.refs.input;
      try {
        if (!String(ta.value || "").trim() || ta.dataset.ppAuto === "1") {
          ta.value = t;
          ta.dataset.ppAuto = "1";
          this._updateCount(st);
        }
      } catch (e) { /* ignore */ }
    }
  },

  _updateCount(st) {
    if (!st.refs || !st.refs.count) return;
    const n = String((st.refs.input && st.refs.input.value) || "").length;
    st.refs.count.textContent = n ? (I18n.isZh ? n + " 字" : n + " chars") : "";
  },

  /* ---------------- 注册 ---------------- */

  register(pluginID) {
    if (this._registered) return;
    const self = this;
    const registeredPaneID = Zotero.ItemPaneManager.registerSection({
      paneID: this.PANE_ID,
      pluginID,
      header: {
        l10nID: "paperpilot-translate-section-header",
        icon: this.ICON,
      },
      sidenav: {
        l10nID: "paperpilot-translate-section-sidenav",
        icon: this.ICON,
      },
      // onRender 必填（Z10 schema）：缺了会静默返回 false
      onRender({ paneID, doc, body }) {
        if (body.querySelector("[data-pp-tr-root]")) return;
        self._build(doc, body, paneID);
      },
      onItemChange({ paneID, item, setEnabled }) {
        const ok = self._usable(item);
        setEnabled(ok);
        const st = self._state(paneID);
        const prev = st.item;
        st.item = item || null;
        if (!ok) return true;
        // 换篇：清空结果与待译框；同篇重渲染只刷新状态
        if (!prev || !item || prev.id !== item.id) {
          st.pairs = [];
          self._refresh(paneID, { resetText: true });
        } else {
          self._refresh(paneID);
        }
        return true;
      },
      onDestroy({ paneID }) {
        self._panes.delete(paneID);
      },
    });
    // registerSection 校验失败时静默返回 false（不抛错），必须显式检查
    if (!registeredPaneID) {
      throw new Error("ItemPaneManager.registerSection 校验失败（返回 false），翻译面板未注册");
    }
    this._registeredPaneID = registeredPaneID;
    this._registered = true;
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

  /* ---------------- UI 构建（onRender 调用；测试可直接调） ---------------- */

  _build(doc, body, paneID) {
    const self = this;
    const H = (t, a, x) => self._h(doc, t, a, x);
    const zh = I18n.isZh;
    const st = this._state(paneID);
    st.doc = doc; // 后续刷新/渲染统一用建面板时的 document（测试传桩，实机是真实 doc）

    const root = H("div", {
      "data-pp-tr-root": "1",
      style: "display:flex;flex-direction:column;gap:7px;padding:7px 8px;font-size:12.5px;line-height:1.5;",
    });

    /* ① 引擎 + 语言 */
    const engRow = H("div", { style: "display:flex;align-items:center;gap:6px;" });
    engRow.appendChild(H("span", { style: "color:var(--fill-secondary,#666);flex:none;" }, I18n.t("tpEngine")));
    const engSel = H("select", {
      class: "pp-tr-sel",
      title: zh ? "切换翻译引擎（立即生效，全部翻译功能共用）" : "Switch translation engine (applies everywhere)",
      style: "flex:1;min-width:0;font-size:12px;padding:2px 4px;",
    });
    engRow.appendChild(engSel);
    const engBadge = H("span", { style: "flex:none;font-size:11px;color:var(--fill-secondary,#888);" }, "");
    engRow.appendChild(engBadge);
    root.appendChild(engRow);

    const langRow = H("div", { style: "display:flex;align-items:center;gap:6px;flex-wrap:wrap;" });
    langRow.appendChild(H("span", { style: "color:var(--fill-secondary,#666);flex:none;" }, I18n.t("tpTarget")));
    const toSel = this._langSelect(doc, "to");
    langRow.appendChild(toSel);
    langRow.appendChild(H("span", { style: "color:var(--fill-secondary,#666);flex:none;margin-left:2px;" }, I18n.t("tpSource")));
    const fromSel = this._langSelect(doc, "from");
    langRow.appendChild(fromSel);
    root.appendChild(langRow);

    /* ② 待译文本 */
    const input = H("textarea", {
      class: "pp-tr-input",
      rows: "3",
      placeholder: I18n.t("tpSelectionPh"),
      style: "width:100%;box-sizing:border-box;resize:vertical;font-size:12.5px;line-height:1.5;" +
        "padding:5px 6px;border-radius:5px;border:1px solid #88888844;background:transparent;color:inherit;",
    });
    root.appendChild(input);
    const btnRow = H("div", { style: "display:flex;align-items:center;gap:6px;" });
    const trBtn = H("button", { class: "pp-tr-btn pp-tr-primary", style: this._btnCss(true) },
      I18n.t("tpTranslate"));
    const clrBtn = H("button", { class: "pp-tr-btn", style: this._btnCss(false) }, I18n.t("tpClear"));
    const count = H("span", { style: "font-size:11px;color:var(--fill-secondary,#888);margin-left:auto;" }, "");
    btnRow.appendChild(trBtn);
    btnRow.appendChild(clrBtn);
    btnRow.appendChild(count);
    root.appendChild(btnRow);

    /* ③ 结果 */
    const resLabel = H("div", { style: "display:flex;align-items:center;gap:6px;" });
    resLabel.appendChild(H("span", { style: "font-weight:600;font-size:11.5px;color:var(--fill-secondary,#666);" },
      zh ? "译文" : "Translation"));
    const resMeta = H("span", { style: "font-size:11px;color:var(--fill-secondary,#888);" }, "");
    resLabel.appendChild(resMeta);
    const copyBtn = H("button", { class: "pp-tr-btn", style: this._btnCss(false) + "margin-left:auto;" },
      I18n.t("tpCopy"));
    copyBtn.style.display = "none";
    resLabel.appendChild(copyBtn);
    root.appendChild(resLabel);
    const result = H("div", {
      class: "pp-tr-result",
      style: "min-height:26px;max-height:240px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;" +
        "padding:6px 8px;border-radius:5px;background:#88888812;border:1px solid #88888830;",
    }, I18n.t("tpResultEmpty"));
    root.appendChild(result);

    /* ④ 全文对照 */
    const fullBox = H("div", { style: "border-top:1px solid #88888828;padding-top:7px;display:flex;flex-direction:column;gap:6px;" });
    const fullHead = H("div", { style: "display:flex;align-items:center;gap:6px;" });
    fullHead.appendChild(H("span", { style: "font-weight:600;font-size:11.5px;color:var(--fill-secondary,#666);" },
      I18n.t("tpFullText")));
    const fullBtn = H("button", { class: "pp-tr-btn", style: this._btnCss(false) + "margin-left:auto;" },
      I18n.t("tpStart"));
    fullHead.appendChild(fullBtn);
    fullBox.appendChild(fullHead);
    const bar = H("div", { class: "pp-tr-bar", style: "height:3px;border-radius:2px;background:#88888833;overflow:hidden;" });
    const barFill = H("div", { class: "pp-tr-barfill", style: "height:100%;width:0%;background:var(--color-accent,#2f9e6f);" +
      "transition:width .25s ease;" });
    bar.appendChild(barFill);
    fullBox.appendChild(bar);
    const fullStatus = H("div", { class: "pp-tr-fullstatus", style: "font-size:11px;color:var(--fill-secondary,#888);" }, "");
    fullBox.appendChild(fullStatus);
    const pairList = H("div", {
      class: "pp-tr-pairs",
      style: "max-height:260px;overflow-y:auto;display:flex;flex-direction:column;gap:6px;",
    });
    fullBox.appendChild(pairList);
    const fullActs = H("div", { style: "display:flex;align-items:center;gap:6px;flex-wrap:wrap;" });
    const twoColBtn = H("button", { class: "pp-tr-btn", style: this._btnCss(false), title: zh
      ? "打开左右双栏对照窗口（可在窗口里调字号/布局）" : "Open the side-by-side window" }, I18n.t("tpOpenTwoCol"));
    const noteBtn = H("button", { class: "pp-tr-btn", style: this._btnCss(false) },
      I18n.t("tpExportNote"));
    fullActs.appendChild(twoColBtn);
    fullActs.appendChild(noteBtn);
    fullBox.appendChild(fullActs);
    root.appendChild(fullBox);

    /* ⑤ 标题与摘要 */
    const taRow = H("div", { style: "display:flex;align-items:center;gap:6px;" });
    taRow.appendChild(H("span", { style: "font-weight:600;font-size:11.5px;color:var(--fill-secondary,#666);" },
      I18n.t("tpTitleAbstract")));
    const taBtn = H("button", { class: "pp-tr-btn", style: this._btnCss(false) + "margin-left:auto;" },
      I18n.t("tpTranslate"));
    taRow.appendChild(taBtn);
    root.appendChild(taRow);

    /* ⑥ 底部入口 */
    const foot = H("div", { style: "display:flex;align-items:center;gap:6px;border-top:1px solid #88888828;padding-top:6px;" });
    const setBtn = H("button", { class: "pp-tr-btn", style: this._btnCss(false) }, I18n.t("tpSettings"));
    const hubBtn = H("button", { class: "pp-tr-btn", style: this._btnCss(false) }, I18n.t("tpHub"));
    foot.appendChild(setBtn);
    foot.appendChild(hubBtn);
    root.appendChild(foot);

    body.appendChild(root);
    st.refs = { engSel, engBadge, toSel, fromSel, input, trBtn, clrBtn, count, result, resMeta, copyBtn,
      fullBtn, barFill, fullStatus, pairList, twoColBtn, noteBtn, taBtn };

    /* ---- 事件 ---- */
    engSel.addEventListener("change", () => {
      const r = TranslateSvc.setActive(engSel.value);
      if (!r.ok) { self._toast(paneID, "✗ " + r.error, true); return; }
      TranslateSvc.clearCache();
      self._refresh(paneID);
      self._toast(paneID, (I18n.isZh ? "已切换引擎：" : "Engine: ") + self._engineName(engSel.value));
    });
    toSel.addEventListener("change", () => {
      try { Prefs.set("readerPopupTargetLang", toSel.value); } catch (e) { /* ignore */ }
      TranslateSvc.clearCache();
      self._refresh(paneID);
    });
    fromSel.addEventListener("change", () => {
      try { Prefs.set("translateFromLang", fromSel.value); } catch (e) { /* ignore */ }
    });
    input.addEventListener("input", () => { input.dataset.ppAuto = "0"; self._updateCount(st); });
    clrBtn.addEventListener("click", () => {
      input.value = "";
      input.dataset.ppAuto = "0";
      self._updateCount(st);
      self._setResult(paneID, "", null);
    });
    trBtn.addEventListener("click", () => { if (!st.busy) self._translateSelection(paneID); });
    copyBtn.addEventListener("click", () => {
      const t = st.refs.result.textContent || "";
      try {
        Zotero.Utilities.Internal.copyText(t);
        copyBtn.textContent = I18n.t("tpCopied");
        setTimeout(() => { try { copyBtn.textContent = I18n.t("tpCopy"); } catch (e) { /* ignore */ } }, 1200);
      } catch (e) { /* ignore */ }
    });
    fullBtn.addEventListener("click", () => { if (!st.fullBusy) self._translateFull(paneID); });
    twoColBtn.addEventListener("click", () => self._openTwoCol(paneID));
    noteBtn.addEventListener("click", () => self._exportNote(paneID, noteBtn));
    taBtn.addEventListener("click", () => { if (!st.busy) self._translateTitleAbstract(paneID); });
    setBtn.addEventListener("click", () => self._openSettings());
    hubBtn.addEventListener("click", () => {
      try { Zotero.PaperPilot.openHub(); } catch (e) { /* ignore */ }
    });

    this._refresh(paneID, { resetText: true });
  },

  _btnCss(primary) {
    return "font-size:11.5px;line-height:1.6;padding:3px 10px;border-radius:5px;cursor:pointer;" +
      (primary
        ? "border:1px solid var(--color-accent,#2f9e6f);background:var(--color-accent,#2f9e6f);color:#fff;font-weight:600;"
        : "border:1px solid #88888855;background:transparent;color:inherit;");
  },

  /** 语言下拉：值域 = TranslateSvc.LANGS（与设置面板同一份规范码） */
  _langSelect(doc, which) {
    const H = (t, a, x) => this._h(doc, t, a, x);
    const includeAuto = which === "from";
    const sel = H("select", {
      class: "pp-tr-lang",
      style: "font-size:12px;padding:2px 4px;max-width:132px;",
    });
    for (const l of TranslateSvc.LANGS) {
      if (!includeAuto && l.code === "auto") continue;
      sel.appendChild(H("option", { value: l.code }, l.label));
    }
    sel.value = includeAuto ? TranslateSvc.sourceCode() : TranslateSvc.targetCode();
    return sel;
  },

  /** 刷新下拉/按钮可用性等与 pref 相关的状态 */
  _refresh(paneID, opts) {
    const st = this._state(paneID);
    if (!st.refs) return;
    opts = opts || {};
    const doc = st.doc;
    const { engSel, engBadge, toSel, fromSel, input } = st.refs;

    // 引擎下拉：全部引擎 + 🆓/🔑/🤖 标记
    while (engSel.firstChild) engSel.removeChild(engSel.firstChild);
    for (const s of TranslateSvc.list()) {
      let label = s.name;
      if (s.group === "free" && !s.needsSecret) label += " 🆓";
      if (s.needsSecret) label += " 🔑";
      if (s.llm) label += " 🤖";
      engSel.appendChild(this._h(doc, "option", { value: s.id }, label));
    }
    engSel.value = TranslateSvc.cfg().active;

    const active = TranslateSvc.activeEngine();
    const ready = TranslateSvc.ready();
    engBadge.textContent = ready ? "" : (I18n.isZh ? "⚠ 未就绪" : "⚠ not ready");
    engBadge.style.color = ready ? "" : "var(--color-warning,#b45309)";
    if (active) engBadge.title = active.name;

    // 引擎未就绪 → 翻译按钮禁用并给出指引（不静默）
    const can = TranslateSvc.available();
    st.refs.trBtn.disabled = !can;
    st.refs.trBtn.style.opacity = can ? "1" : "0.55";
    st.refs.taBtn.disabled = !can;
    st.refs.fullBtn.disabled = !can;

    toSel.value = TranslateSvc.targetCode();
    fromSel.value = TranslateSvc.sourceCode();

    if (opts.resetText) {
      const matches = this._lastSel.itemID && st.item && this._lastSel.itemID === st.item.id;
      input.value = matches ? this._lastSel.text : "";
      input.dataset.ppAuto = matches ? "1" : "0";
    }
    this._updateCount(st);

    if (!can) {
      this._setResult(paneID, TranslateSvc.unavailableHint(), { warn: true });
    } else if (opts.resetText) {
      this._setResult(paneID, "", null);
    }
  },

  _engineName(id) {
    const s = TranslateSvc.get(id);
    return s ? s.name : id;
  },

  _setResult(paneID, text, meta) {
    const st = this._state(paneID);
    if (!st.refs) return;
    const { result, resMeta, copyBtn } = st.refs;
    result.textContent = text || I18n.t("tpResultEmpty");
    result.style.color = (meta && meta.warn) ? "var(--color-warning,#b45309)" : "";
    resMeta.textContent = (meta && meta.meta) || "";
    resMeta.style.color = "";
    copyBtn.style.display = (text && !(meta && meta.warn)) ? "" : "none";
    st.lastResult = text || "";
  },

  _toast(paneID, msg, isErr) {
    const st = this._state(paneID);
    if (!st.refs) return;
    st.refs.fullStatus.textContent = msg || "";
    st.refs.fullStatus.style.color = isErr ? "var(--color-warning,#b45309)" : "var(--fill-secondary,#888)";
  },

  /* ---------------- 动作 ---------------- */

  /** ② 翻译待译框内容（划词或粘贴） */
  async _translateSelection(paneID) {
    const st = this._state(paneID);
    if (!st.refs) return;
    const text = String(st.refs.input.value || "").trim();
    if (!text) { this._setResult(paneID, I18n.t("tpNoText"), { warn: true }); return; }
    st.busy = true;
    st.refs.trBtn.disabled = true;
    st.refs.trBtn.textContent = I18n.t("tpTranslating");
    this._setResult(paneID, I18n.t("tpTranslating") + "…", null);
    try {
      const r = await TranslateSvc.translate(text, { to: TranslateSvc.targetCode() });
      if (!r.ok) {
        const detail = (r.tried || []).map((t) => this._engineName(t.engine) + "：" + t.error).join("；");
        this._setResult(paneID, (I18n.isZh ? "翻译失败：" : "Failed: ") + r.error +
          (detail ? "\n" + detail : ""), { warn: true });
        return;
      }
      const meta = "· " + this._engineName(r.engine) +
        ((r.cached ? (I18n.isZh ? " · 缓存" : " · cached") : "")) +
        (r.fallback ? (I18n.isZh ? " · 回退" : " · fallback") : "") +
        ((r.cooled && r.cooled.length)
          ? (I18n.isZh ? " · 跳过冷却中 " + r.cooled.length : " · skipped " + r.cooled.length + " cooling")
          : "");
      this._setResult(paneID, r.text, { meta });
    } catch (e) {
      this._setResult(paneID, (I18n.isZh ? "翻译失败：" : "Failed: ") + ((e && e.message) || e), { warn: true });
    } finally {
      st.busy = false;
      if (st.refs) {
        st.refs.trBtn.disabled = !TranslateSvc.available();
        st.refs.trBtn.textContent = I18n.t("tpTranslate");
      }
    }
  },

  /** ④ 全文对照翻译（分段进度 + 段落对照列表） */
  async _translateFull(paneID) {
    const st = this._state(paneID);
    if (!st.refs || !st.item) return;
    if (!TranslateSvc.available()) { this._toast(paneID, TranslateSvc.unavailableHint(), true); return; }
    st.fullBusy = true;
    st.pairs = [];
    st.refs.fullBtn.disabled = true;
    while (st.refs.pairList.firstChild) st.refs.pairList.removeChild(st.refs.pairList.firstChild);
    this._toast(paneID, I18n.t("tpReading"));
    this._progress(paneID, 2);
    try {
      const fullText = await AIChat.getFullText(st.item);
      if (!fullText) throw new Error(I18n.t("blNoText"));
      // 分段函数复用全文对照翻译的同一份实现（避免两处规则漂移）
      const chunks = BilingualTranslate._chunk(fullText, BilingualTranslate._chunkChars());
      let done = 0;
      for (const chunk of chunks) {
        const r = await TranslateSvc.translate(chunk, { to: TranslateSvc.targetCode() });
        const dst = r.ok ? r.text : "⚠ " + r.error;
        st.pairs.push({ src: chunk.replace(/\n+/g, " ").trim(), dst: String(dst).trim() });
        done++;
        this._progress(paneID, 2 + Math.round(done / chunks.length * 96));
        this._toast(paneID, I18n.t("tpTranslating") + " " + done + "/" + chunks.length);
        this._renderPairs(paneID);
        if (done < chunks.length) await new Promise((res) => setTimeout(res, 250));
      }
      this._progress(paneID, 100);
      this._toast(paneID, I18n.t("tpDone") + "：" + chunks.length);
    } catch (e) {
      this._toast(paneID, (I18n.isZh ? "全文翻译失败：" : "Failed: ") + ((e && e.message) || e), true);
    } finally {
      st.fullBusy = false;
      if (st.refs) st.refs.fullBtn.disabled = !TranslateSvc.available();
    }
  },

  _progress(paneID, pct) {
    const st = this._state(paneID);
    if (st.refs && st.refs.barFill) st.refs.barFill.style.width = Math.max(0, Math.min(100, pct)) + "%";
  },

  _renderPairs(paneID) {
    const st = this._state(paneID);
    if (!st.refs) return;
    const doc = st.doc;
    if (!doc) return;
    const list = st.refs.pairList;
    while (list.firstChild) list.removeChild(list.firstChild);
    for (const p of st.pairs) {
      const row = this._h(doc, "div", {
        style: "display:flex;flex-direction:column;gap:2px;padding:5px 6px;border-radius:5px;" +
          "background:#88888810;border:1px solid #88888828;",
      });
      row.appendChild(this._h(doc, "div", {
        style: "font-size:11.5px;color:var(--fill-secondary,#888);white-space:pre-wrap;word-break:break-word;",
      }, p.src.slice(0, 300) + (p.src.length > 300 ? " …" : "")));
      row.appendChild(this._h(doc, "div", {
        style: "white-space:pre-wrap;word-break:break-word;",
      }, p.dst));
      list.appendChild(row);
    }
  },

  _openTwoCol(paneID) {
    const st = this._state(paneID);
    if (!st.item) return;
    try {
      BilingualTranslate.openViewer(st.item);
    } catch (e) {
      this._toast(paneID, (I18n.isZh ? "打开双栏窗口失败：" : "Failed: ") + ((e && e.message) || e), true);
    }
  },

  async _exportNote(paneID, btn) {
    const st = this._state(paneID);
    if (!st.item) return;
    if (!st.pairs.length) { this._toast(paneID, I18n.t("tpNoPairs"), true); return; }
    btn.disabled = true;
    this._toast(paneID, I18n.t("blNoteBusy"));
    try {
      const title = (() => { try { return st.item.getDisplayTitle() || ""; } catch (e) { return ""; } })();
      await Notes.createFromMarkdown(
        st.item,
        I18n.t("noteBilingualTitle") + "｜" + title,
        BilingualTranslate._noteMd(st.pairs, BilingualTranslate._targetLang())
      );
      this._toast(paneID, I18n.t("blNoteDone"));
    } catch (e) {
      this._toast(paneID, (I18n.isZh ? "生成笔记失败：" : "Note failed: ") + ((e && e.message) || e), true);
    } finally {
      btn.disabled = false;
    }
  },

  /** ⑤ 标题与摘要（结果直接进 ③ 结果区，可复制） */
  async _translateTitleAbstract(paneID) {
    const st = this._state(paneID);
    if (!st.refs || !st.item) return;
    st.busy = true;
    st.refs.taBtn.disabled = true;
    this._setResult(paneID, I18n.t("tpTranslating") + "…", null);
    try {
      const out = await AIChat.translateTitleAbstract(st.item);
      this._setResult(paneID, out, { meta: "· " + this._engineName(TranslateSvc.cfg().active) });
    } catch (e) {
      const msg = (e && e.message) === "NO_PDF" ? I18n.t("chatNoPdf") : ((e && e.message) || e);
      this._setResult(paneID, (I18n.isZh ? "翻译失败：" : "Failed: ") + msg, { warn: true });
    } finally {
      st.busy = false;
      if (st.refs) st.refs.taBtn.disabled = !TranslateSvc.available();
    }
  },

  _openSettings() {
    try {
      const paneID = (Zotero.PaperPilot && Zotero.PaperPilot._paneID) || "paperpilot-prefs";
      Zotero.Utilities.Internal.openPreferences(paneID);
    } catch (e) {
      try { Zotero.logError(e); } catch (_) { /* ignore */ }
    }
  },
};
