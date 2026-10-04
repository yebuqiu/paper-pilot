/* PaperPilot PDF 阅读主题（0.16.0）
 * 借鉴设计来源（详见 docs/0.16.0-theme-credits.md）：
 *  - q77190858/zotero-pdf-background（wangqian06 转移，无 LICENSE 声明——机制思路
 *    借鉴、代码原创重写）：核心洞察是 Zotero 内置 pdf.js 的 .textLayer 覆盖在
 *    canvas 之上且默认透明，给它叠一层半透明背景色即可实现"护眼底色"而完全
 *    不动 canvas；tab 事件经 Zotero.Notifier 监听、经 reader._iframeWindow 找
 *    viewer.html iframe；#secondary-view 挂 MutationObserver 兼容分屏视图。
 *  - tefkah/zotero-night（GPL-3.0，思路借鉴）：夜间模式 = canvas 反色
 *    filter: invert(1) hue-rotate(180deg)——白纸黑字反成黑纸白字、色相经
 *    二次旋转保持，是 pdf.js 社区标准做法；viewer 底色同步加深避免白框刺眼。
 *
 * 0.25.0 起：**阅读器工具栏的切换入口移到 ThemeToggle**（走官方 renderToolbar
 * 扩展位、与主窗口左上角按钮同源）。本模块只负责"页面怎么变"（叠色/反色 + 持久化），
 * 不再自己往工具栏里塞按钮。
 */
/* global Zotero, Prefs */

var PdfTheme = {
  STYLE_ID: "paperpilot-pdf-theme",
  PREF_KEY: "pdfTheme",           // default / careeye / sepia / sakura / mint / night / night-warm / custom
  PREF_CUSTOM_COLOR: "pdfThemeCustomColor",
  PREF_CUSTOM_OPACITY: "pdfThemeCustomOpacity", // 0.05-0.6（int，百分数×100）

  _notifierID: null,
  _observers: [],   // [{browserWindow, observer}]：分屏视图 MutationObserver

  /* ---------- 阅读主题库 ----------
   * 浅色模式 = 叠色（color 以 opacity 混在白底上，文字仍从 canvas 透出）
   * 深色模式 = 反色 filter（canvas 白纸黑字 → 黑纸白字）+ viewer 底色加深 */
  THEMES: [
    { id: "default", name: "默认白纸", dark: false },
    { id: "careeye", name: "护眼绿", dark: false, color: "#578f32", opacity: 0.30 },
    { id: "sepia", name: "羊皮纸", dark: false, color: "#937b25", opacity: 0.28 },
    { id: "sakura", name: "樱花粉", dark: false, color: "#e89bb5", opacity: 0.25 },
    { id: "mint", name: "薄荷青", dark: false, color: "#3aafa0", opacity: 0.22 },
    { id: "night", name: "夜间模式", dark: true },
    { id: "night-warm", name: "夜间暖光", dark: true, warm: true },
    { id: "custom", name: "自定义颜色", dark: false, custom: true },
  ],

  current() {
    const id = String(Prefs.get(this.PREF_KEY, "default") || "default");
    return this.THEMES.find((t) => t.id === id) || this.THEMES[0];
  },

  /** 浅色叠色主题的最终 color/opacity（custom 读 pref） */
  _tint(theme) {
    if (!theme.custom) return { color: theme.color, opacity: theme.opacity };
    let color = String(Prefs.get(this.PREF_CUSTOM_COLOR, "#578f32") || "#578f32");
    if (!/^#[0-9a-f]{6}$/i.test(color)) color = "#578f32";
    let op = Number(Prefs.get(this.PREF_CUSTOM_OPACITY, 30));
    if (!isFinite(op)) op = 30;
    op = Math.min(60, Math.max(5, Math.round(op))) / 100;
    return { color, opacity: op };
  },

  /* ---------- 注入 viewer.html 的 CSS ---------- */

  _css(theme) {
    if (theme.id === "default") return "";
    if (theme.dark) {
      // 夜间：canvas 反色（黑纸白字、色相保持）；夜间暖光再加一层轻微棕化
      const filter = theme.warm
        ? "invert(1) hue-rotate(180deg) sepia(0.12)"
        : "invert(1) hue-rotate(180deg)";
      return (
        "/* PaperPilot PDF 主题 · " + theme.name + " */\n" +
        "body { background-color: #1c1c1e !important; }\n" +
        "#viewerContainer { background-color: #1c1c1e !important; }\n" +
        ".pdfViewer .page canvas { filter: " + filter + " !important; }\n" +
        // 页面阴影边缘在深底上减淡
        ".pdfViewer .page { box-shadow: 0 0 0 1px rgba(255,255,255,.06) !important; }\n"
      );
    }
    const tint = this._tint(theme);
    return (
      "/* PaperPilot PDF 主题 · " + theme.name + " */\n" +
      // 叠色法：textLayer 半透明背景盖在白底 canvas 上，黑字透出
      ".pdfViewer .page > .textLayer { display: block !important; background-color: " +
      tint.color + " !important; opacity: " + tint.opacity + " !important; }\n"
    );
  },

  /** theme id → viewer body class（body 只挂一个状态类，切换零残留） */
  _bodyClass(theme) {
    return theme.id === "default" ? "" : "pp-pdf-" + theme.id;
  },

  /* ---------- 对单个 viewer iframe 应用 ---------- */

  _applyToViewerDoc(doc) {
    if (!doc) return;
    try {
      const theme = this.current();
      const body = doc.body;
      if (!body) return;
      // 只摘自己挂的 pp-pdf-* 类，不动 viewer 原生 class
      for (const cls of Array.from(body.classList)) {
        if (String(cls).indexOf("pp-pdf-") === 0) body.classList.remove(cls);
      }
      let style = doc.getElementById(this.STYLE_ID);
      if (theme.id === "default") {
        if (style) style.remove();
        return;
      }
      if (!style) {
        style = doc.createElement("style");
        style.id = this.STYLE_ID;
        (doc.head || doc.documentElement).appendChild(style);
      }
      const css = this._css(theme);
      if (style.textContent !== css) style.textContent = css;
      body.setAttribute("class", this._bodyClass(theme));
    } catch (e) {
      try { Zotero.logError(e); } catch (_) { /* ignore */ }
    }
  },

  /** 遍历 reader 文档里的全部 viewer iframe（含分屏）并应用 */
  _applyToReaderWindow(readerWin) {
    if (!readerWin || !readerWin.document) return;
    try {
      for (const iframe of readerWin.document.querySelectorAll("iframe")) {
        const src = iframe.getAttribute("src") || "";
        if (src.indexOf("viewer.html") < 0) continue;
        const idoc = iframe.contentDocument;
        if (idoc && idoc.readyState === "complete") {
          this._applyToViewerDoc(idoc);
        }
        // 未 load 完成的：load 后再应用一次（iframe 与父文档跨 browsing context）
        try {
          iframe.contentWindow.addEventListener("load", () => {
            this._applyToViewerDoc(iframe.contentDocument);
          }, { once: true });
        } catch (e) { /* ignore */ }
      }
    } catch (e) {
      try { Zotero.logError(e); } catch (_) { /* ignore */ }
    }
  },

  /** 全量刷新：所有主窗口 × 所有 reader tab × 每个 reader 的全部 viewer iframe。
   *  双路径互补：Zotero.Reader._readers（私有但 Z7-10 存在）+ 遍历主窗口
   *  browser.reader DOM（zotero-pdf-background 的稳妥路径），各自 try/catch。
   *  工具栏按钮由 ThemeToggle 负责，这里不再碰 reader 的 chrome。 */
  refresh() {
    const seen = [];
    try {
      const readers = Zotero.Reader ? (Zotero.Reader._readers || []) : [];
      for (const reader of readers) {
        try {
          if (reader._initialized && reader._iframeWindow) {
            seen.push(reader._iframeWindow);
            this._applyToReaderWindow(reader._iframeWindow);
            this._observeSplitView(reader._iframeWindow);
          }
        } catch (e) { /* 单个 reader 失败不影响其他 */ }
      }
    } catch (e) {
      try { Zotero.logError(e); } catch (_) { /* ignore */ }
    }
    try {
      for (const win of Zotero.getMainWindows()) {
        if (!win.ZoteroPane) continue;
        for (const bro of win.document.querySelectorAll("browser.reader")) {
          const rw = bro.contentWindow;
          if (!rw || !rw.document || seen.indexOf(rw) >= 0) continue;
          try {
            this._applyToReaderWindow(rw);
            this._observeSplitView(rw);
          } catch (e) { /* ignore */ }
        }
      }
    } catch (e) { /* ignore */ }
  },

  /* ---------- 分屏视图（#secondary-view 追加 iframe 时补应用） ---------- */

  _observeSplitView(readerWin) {
    if (!readerWin || !readerWin.document) return;
    if (this._observers.some((o) => o.win === readerWin)) return;
    try {
      const sec = readerWin.document.querySelector("#secondary-view");
      if (!sec) return;
      const MO = readerWin.MutationObserver || MutationObserver;
      const observer = new MO(() => this._applyToReaderWindow(readerWin));
      observer.observe(sec, { childList: true, subtree: true });
      this._observers.push({ win: readerWin, observer });
    } catch (e) { /* ignore */ }
  },

  /* ---------- 生命周期 ---------- */

  setTheme(id) {
    Prefs.set(this.PREF_KEY, id || "default");
    this.refresh();
  },

  register() {
    // 存量 reader：延迟一拍（reader._initialized 未必就绪）
    try {
      this.refresh();
      setTimeout(() => this.refresh(), 1200);
    } catch (e) { /* ignore */ }
    // 新开 tab：Notifier tab 事件 → reader 初始化完成 → 注入
    try {
      const self = this;
      this._notifierID = Zotero.Notifier.registerObserver({
        notify: (event, type, ids) => {
          if (type !== "tab" || (event !== "add" && event !== "load" && event !== "select")) return;
          for (const tabID of ids || []) {
            (async () => {
              try {
                const reader = Zotero.Reader.getByTabID(tabID);
                if (!reader) return;
                await reader._initPromise;
                if (reader._iframeWindow) {
                  self._applyToReaderWindow(reader._iframeWindow);
                  self._observeSplitView(reader._iframeWindow);
                }
              } catch (e) { /* 非 reader tab 或已关闭 */ }
            })();
          }
        },
      }, ["tab"], "paperpilot-pdf-theme");
    } catch (e) {
      try { Zotero.logError(e); } catch (_) { /* ignore */ }
    }
  },

  unregister() {
    try {
      if (this._notifierID) Zotero.Notifier.unregisterObserver(this._notifierID);
    } catch (e) { /* ignore */ }
    this._notifierID = null;
    for (const { observer } of this._observers) {
      try { observer.disconnect(); } catch (e) { /* ignore */ }
    }
    this._observers = [];
    // 清除全部注入（viewer 的 style / body class），页面回到原生状态
    // （工具栏按钮属 ThemeToggle，不在这里清）
    try {
      const readers = Zotero.Reader ? (Zotero.Reader._readers || []) : [];
      for (const reader of readers) {
        const win = reader._iframeWindow;
        if (!win || !win.document) continue;
        for (const iframe of win.document.querySelectorAll("iframe")) {
          const src = iframe.getAttribute("src") || "";
          if (src.indexOf("viewer.html") < 0) continue;
          const doc = iframe.contentDocument;
          if (!doc) continue;
          const s = doc.getElementById(this.STYLE_ID);
          if (s) s.remove();
          if (doc.body) doc.body.removeAttribute("class");
        }
      }
    } catch (e) { /* ignore */ }
  },
};
