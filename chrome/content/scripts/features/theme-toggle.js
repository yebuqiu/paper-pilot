/* PaperPilot 统一主题切换按钮（0.25.0）
 *
 * 一个主题入口、两处落点，两处读同一份 pref、行为完全同步：
 *   ① PDF 阅读器工具栏 —— 走 Zotero 官方扩展位，不做任何 DOM 手术：
 *      Zotero.Reader.registerEventListener("renderToolbar", handler, pluginID)（Z7+ 官方 API）。
 *      handler 里**同步**调用 event.append(node)，节点落进
 *      `.toolbar .end > .custom-sections > .section`（reader.js 的 CustomSections 组件
 *      专为插件预留的槽位，紧邻原生「阅读器外观」按钮）。React 每次重渲染工具栏都会
 *      重新派发该事件并 replaceChildren，所以按钮必须每次重建、不能做「已存在就跳过」。
 *   ② 主窗口左上角 —— 收藏夹工具栏 #zotero-collections-toolbar 里插一个
 *      toolbarbutton.zotero-tb-button，与相邻的「新建分类」「分类搜索」同排同规格。
 *
 * 规范对齐（两处都照宿主自己的控件规范写，不发明新样式）：
 *   · 阅读器：class="toolbar-button" —— 28×28 / 圆角 5px / color:var(--fill-secondary)，
 *     :hover → --fill-quinary、:active 与 .active → --fill-quarternary、
 *     [disabled] → pointer-events:none；全部由 reader.css 原生提供，零自造样式。
 *   · 主窗口：#zotero-collections-toolbar toolbarbutton{width:28px;height:28px}，
 *     :hover/:active/:disabled/[open] 同样由 zotero.css 原生提供。
 *   · 弹层底色/文字一律走宿主主题变量（--material-* / --fill-* / --color-*），
 *     界面主题一换，弹层随之变色（不与主窗口主题割裂）。
 *
 * 状态：唯一事实来源是 pref（uiTheme / pdfTheme）。本模块只管「按钮 + 弹层」，
 * 真正的应用与持久化仍归 UiTheme.setTheme() / PdfTheme.setTheme()：它们各自写 pref，
 * 再由 main.js 的 pref observer 全网广播。于是天然满足：
 *   · 实时生效——不需要刷新页面或重开文档（PdfTheme.refresh() 遍历所有已打开 reader）；
 *   · 持久化——重启后 UiTheme.register() / PdfTheme.register() 从 pref 恢复；
 *   · 两处同步——同一个模块、同一份 pref，任一处切换后 refresh() 同步标题与展开中的弹层。
 *
 * 生命周期：register(pluginID) / unregister()。
 */
/* global Zotero, Services, Prefs, I18n, UiTheme, PdfTheme, Menus */

var ThemeToggle = {
  MAIN_BTN_ID: "paperpilot-theme-toolbar-button",
  READER_BTN_ID: "paperpilot-theme-reader-button",
  POPUP_ID: "paperpilot-theme-popup",
  STYLE_ID: "paperpilot-theme-style",
  PREF_ENABLED: "themeButtonEnabled",

  XHTML: "http://www.w3.org/1999/xhtml",
  SVG: "http://www.w3.org/2000/svg",
  XUL: "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul",

  /** 界面主题分类展示顺序（与设置面板 renderThemeLibrary 一致） */
  UI_CATS: ["standard", "anime", "scenery", "dynamic", "giant"],
  UI_CAT_KEYS: {
    standard: "themeGroupStandard",
    anime: "themeGroupAnime",
    scenery: "themeGroupScenery",
    dynamic: "themeGroupDynamic",
    giant: "themeGroupGiant",
  },

  _pluginID: null,
  _readerHandler: null,
  _obsObserver: null,
  _readerBtn: null, // 最近一次注入的阅读器按钮（供 refresh 更新提示文字）
  _nodes: [],       // [{doc, node}] 注入过的节点，unregister 时统一移除

  _ui() {
    return (typeof UiTheme !== "undefined" && UiTheme) || null;
  },

  _pdf() {
    return (typeof PdfTheme !== "undefined" && PdfTheme) || null;
  },

  /** 两个主题模块都在才启用按钮；缺一个就置 disabled（可点不可用比隐更好排查） */
  _ready() {
    return !!(this._ui() && this._pdf());
  },

  _track(doc, node) {
    if (node) this._nodes.push({ doc, node });
    return node;
  },

  _el(doc, tag) {
    return doc.createElementNS(this.XHTML, tag);
  },

  _svgEl(doc, tag) {
    return doc.createElementNS(this.SVG, tag);
  },

  _xul(doc, tag) {
    return doc.createXULElement
      ? doc.createXULElement(tag)
      : doc.createElementNS(this.XUL, tag);
  },

  /* ==================== 按钮图标 ==================== */

  /** 阅读器按钮图标：内联 SVG + currentColor。颜色完全继承 .toolbar-button 的
   *  color:var(--fill-secondary)，hover/active 与相邻原生按钮逐帧一致。
   *  （与 icons/theme.svg 同一造型：外环 + 实心右半——「明暗对比」隐喻；
   *    XUL 侧用 context-fill 的文件版，HTML 侧用 currentColor 的内联版。） */
  _readerIcon(doc) {
    const NS = this.SVG;
    const svg = doc.createElementNS(NS, "svg");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    svg.style.pointerEvents = "none";
    const ring = doc.createElementNS(NS, "path");
    ring.setAttribute("fill", "currentColor");
    ring.setAttribute("fill-rule", "evenodd");
    ring.setAttribute("clip-rule", "evenodd");
    ring.setAttribute("d", "M8 0.75a7.25 7.25 0 1 1 0 14.5A7.25 7.25 0 0 1 8 0.75Zm0 1.6a5.65 5.65 0 1 0 0 11.3 5.65 5.65 0 0 0 0-11.3Z");
    const half = doc.createElementNS(NS, "path");
    half.setAttribute("fill", "currentColor");
    half.setAttribute("d", "M8 2.35a5.65 5.65 0 0 1 0 11.3Z");
    svg.appendChild(ring);
    svg.appendChild(half);
    return svg;
  },

  /* ==================== 主题清单（弹层数据源） ==================== */

  /** 当前界面主题显示名（"" → 跟随原生；"custom" → 自定义） */
  uiThemeName() {
    const cur = String(Prefs.get("uiTheme", "") || "");
    if (!cur) return I18n.t("themeFollowNative");
    if (cur === "custom") return I18n.t("themeCustom");
    const ui = this._ui();
    const t = ui ? ui.THEMES.find((x) => x.id === cur) : null;
    return t ? t.name : cur;
  },

  pdfThemeName() {
    const pdf = this._pdf();
    const t = pdf ? pdf.current() : null;
    return t ? t.name : "";
  },

  /** 按钮提示：一眼看到两套主题的当前值（两处按钮共用同一文案） */
  _tip() {
    return I18n.t("themeButtonTip") + " · " +
      I18n.t("menuUiTheme") + "：" + this.uiThemeName() + " · " +
      I18n.t("menuPdfTheme") + "：" + this.pdfThemeName();
  },

  /** 界面主题分组：[{label, items:[{id,name,icon}]}] */
  _uiGroups() {
    const ui = this._ui();
    const groups = [{
      label: "",
      items: [
        { id: "", name: I18n.t("themeFollowNative"), icon: "\u{1F343}" },
      ],
    }];
    if (ui) {
      for (const cat of this.UI_CATS) {
        const items = ui.THEMES.filter((t) => t.cat === cat).map((t) => ({
          id: t.id,
          name: t.name,
          icon: t.wp && t.wp.anim ? "\u26A1" : (t.dark ? "\u{1F319}" : "\u2600\uFE0F"),
        }));
        if (items.length) {
          groups.push({ label: I18n.t(this.UI_CAT_KEYS[cat] || cat), items });
        }
      }
    }
    groups.push({
      label: "",
      items: [{ id: "custom", name: I18n.t("themeCustom"), icon: "\u{1F3A8}" }],
    });
    return groups;
  },

  /** 阅读器侧「阅读页主题」分组 */
  _pdfItems() {
    const pdf = this._pdf();
    if (!pdf) return [];
    return pdf.THEMES.map((t) => ({
      id: t.id,
      name: t.name,
      icon: t.dark ? "\u{1F319}" : "\u{1F4C4}",
    }));
  },

  _applyUi(id) {
    const ui = this._ui();
    if (!ui) return;
    try { ui.setTheme(id); } catch (e) { this._err(e); }
  },

  _applyPdf(id) {
    const pdf = this._pdf();
    if (!pdf) return;
    try { pdf.setTheme(id); } catch (e) { this._err(e); }
  },

  _err(e) {
    try { Zotero.logError(e); } catch (_) { /* ignore */ }
  },

  /* ==================== 阅读器：官方 renderToolbar 扩展位 ==================== */

  _onRenderToolbar(event) {
    try {
      const doc = event && event.doc;
      const append = event && event.append;
      // append 只允许在事件回调里同步调用，所以这里必须全程同步建完
      if (!doc || typeof append !== "function") return;
      // 工具栏每次重渲染都会重新派发事件（CustomSections 会 replaceChildren），
      // 因此不能「已存在就 return」，必须每次重建
      const btn = this._readerButton(doc);
      append(btn);
      this._readerBtn = btn;
    } catch (e) {
      this._err(e);
    }
  },

  _readerButton(doc) {
    const btn = this._el(doc, "button");
    btn.id = this.READER_BTN_ID;
    btn.setAttribute("class", "toolbar-button pp-theme-toggle");
    btn.setAttribute("type", "button");
    btn.setAttribute("tabindex", "-1");
    btn.title = this._tip();
    // 固定 28×28、不参与收缩：窄屏下不会被 .center 挤扁（要求 4）
    btn.style.flex = "none";
    btn.appendChild(this._readerIcon(doc));
    if (!this._ready()) btn.disabled = true;
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (btn.disabled) return;
      this._toggleReaderPopup(doc, btn);
    });
    // 新开的 reader 也要吃到界面主题（阅读器是独立文档，主窗口的注入够不到）
    try {
      const ui = this._ui();
      if (ui && ui.applyToReaderDoc) ui.applyToReaderDoc(doc);
    } catch (e) { /* ignore */ }
    return btn;
  },

  /** 阅读器弹层：常驻 doc.body（React 只重渲染 .custom-sections，够不到 body），
   *  因此工具栏重渲染不会把用户正在看的弹层关掉。 */
  _ensureReaderPopup(doc) {
    let pop = doc.getElementById(this.POPUP_ID);
    if (pop) return pop;
    pop = this._el(doc, "div");
    pop.id = this.POPUP_ID;
    pop.setAttribute("class", "pp-theme-popup");
    pop.setAttribute("role", "menu");
    pop.style.display = "none";
    // 弹层内部点击不触发「点外部关闭」
    pop.addEventListener("click", (ev) => ev.stopPropagation());
    (doc.body || doc.documentElement).appendChild(pop);
    this._track(doc, pop);
    return pop;
  },

  /** 弹层样式：只注入一次，颜色全部走 reader 自身主题变量 */
  _ensureReaderStyle(doc) {
    if (doc.getElementById(this.STYLE_ID)) return;
    const style = this._el(doc, "style");
    style.id = this.STYLE_ID;
    style.textContent =
      "#" + this.POPUP_ID + "{position:fixed;z-index:80;box-sizing:border-box;" +
      "min-width:180px;max-width:min(92vw,280px);max-height:min(70vh,440px);overflow-y:auto;" +
      "padding:6px;border-radius:6px;background:var(--material-toolbar);" +
      "border:1px solid var(--color-border);color:var(--fill-primary);font-size:12px;" +
      "-moz-window-dragging:no-drag;" +
      "box-shadow:0 0 3px 0 rgba(0,0,0,.55),0 8px 40px 0 rgba(0,0,0,.25);}\n" +
      "#" + this.POPUP_ID + " .pp-tp-h{padding:4px 8px 2px;color:var(--fill-secondary);" +
      "font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}\n" +
      "#" + this.POPUP_ID + " .pp-tp-sec+.pp-tp-sec{margin-top:2px;padding-top:4px;" +
      "border-top:1px solid var(--fill-quinary);}\n" +
      "#" + this.POPUP_ID + " .pp-tp-item{display:flex;align-items:center;gap:6px;width:100%;" +
      "padding:4px 8px;border:0;border-radius:5px;background:transparent;color:inherit;" +
      "font:inherit;text-align:start;cursor:pointer;white-space:nowrap;}\n" +
      "#" + this.POPUP_ID + " .pp-tp-item:hover{background:var(--fill-quinary);}\n" +
      "#" + this.POPUP_ID + " .pp-tp-item:active{background:var(--fill-quarternary);}\n" +
      "#" + this.POPUP_ID + " .pp-tp-item[disabled]{color:var(--fill-tertiary);pointer-events:none;}\n" +
      "#" + this.POPUP_ID + " .pp-tp-item.on{color:var(--accent-blue);font-weight:600;}\n" +
      "#" + this.POPUP_ID + " .pp-tp-ico{flex:none;width:16px;text-align:center;}\n" +
      "#" + this.POPUP_ID + " .pp-tp-txt{flex:1;overflow:hidden;text-overflow:ellipsis;}\n";
    (doc.head || doc.documentElement).appendChild(style);
    this._track(doc, style);
  },

  _renderReaderPopup(doc, pop) {
    const keepScroll = pop.scrollTop || 0; // 连续试色时别把用户滚到的位置弹回去
    while (pop.firstChild) pop.removeChild(pop.firstChild);
    const addSection = (title, groups, current, onPick) => {
      const sec = this._el(doc, "div");
      sec.setAttribute("class", "pp-tp-sec");
      if (title) {
        const h = this._el(doc, "div");
        h.setAttribute("class", "pp-tp-h");
        h.textContent = title;
        sec.appendChild(h);
      }
      for (const g of groups) {
        if (g.label) {
          const h = this._el(doc, "div");
          h.setAttribute("class", "pp-tp-h");
          h.textContent = g.label;
          sec.appendChild(h);
        }
        for (const it of g.items) {
          const item = this._el(doc, "button");
          item.setAttribute("class", "pp-tp-item" + (it.id === current ? " on" : ""));
          item.setAttribute("type", "button");
          item.setAttribute("role", "menuitemradio");
          item.setAttribute("aria-checked", it.id === current ? "true" : "false");
          if (!this._ready()) item.disabled = true;
          const ico = this._el(doc, "span");
          ico.setAttribute("class", "pp-tp-ico");
          ico.textContent = it.icon || "";
          const txt = this._el(doc, "span");
          txt.setAttribute("class", "pp-tp-txt");
          txt.textContent = it.name;
          item.appendChild(ico);
          item.appendChild(txt);
          item.addEventListener("click", (ev) => {
            ev.stopPropagation();
            onPick(it.id);
            // pref 变化 → main.js observer → setTheme 已应用并持久化；
            // 这里只刷新弹层选中态（保持打开，方便连续试色）
            this._renderReaderPopup(doc, pop);
          });
          sec.appendChild(item);
        }
      }
      pop.appendChild(sec);
    };

    addSection(I18n.t("menuUiTheme"),
      this._uiGroups(), String(Prefs.get("uiTheme", "") || ""), (id) => this._applyUi(id));

    const pdfGroups = [{ label: "", items: this._pdfItems() }];
    const pdfCur = this._pdf() ? this._pdf().current().id : "";
    addSection(I18n.t("menuPdfTheme"), pdfGroups, pdfCur, (id) => this._applyPdf(id));

    try { pop.scrollTop = keepScroll; } catch (e) { /* ignore */ }
  },

  /** 定位：锚在按钮正下方；下方放不下就翻到上方；右对齐并夹在视口内（窄屏不溢出） */
  _placePopup(doc, pop, btn) {
    const r = btn.getBoundingClientRect();
    const vw = doc.documentElement.clientWidth || 0;
    const vh = doc.documentElement.clientHeight || 0;
    pop.style.top = (r.bottom + 6) + "px";
    pop.style.right = Math.max(8, vw - r.right) + "px";
    const h = pop.offsetHeight;
    if (r.bottom + 6 + h > vh - 8 && r.top - 6 - h > 8) {
      pop.style.top = (r.top - 6 - h) + "px";
    }
  },

  _toggleReaderPopup(doc, btn) {
    try {
      this._ensureReaderStyle(doc);
      const pop = this._ensureReaderPopup(doc);
      this._bindReaderDismiss(doc);
      if (pop.style.display === "block") {
        pop.style.display = "none";
        return;
      }
      this._renderReaderPopup(doc, pop);
      pop.style.display = "block";
      this._placePopup(doc, pop, btn);
    } catch (e) {
      this._err(e);
    }
  },

  /** 点空白 / Esc 关闭。
   *  ⚠️ 必须绑在**捕获阶段**才能盖住 reader 自己的点击处理；但捕获又先于按钮自身的
   *  click 回调执行，所以要显式放行「点在按钮上」和「点在弹层里」两种目标——
   *  否则点按钮会先被这里关掉、再被按钮回调打开，表现为「弹层关不掉」。
   *  只绑一次（文档标记防重复）；禁用插件时保留监听也无害（弹层已摘，查询即空）。 */
  _bindReaderDismiss(doc) {
    if (doc.__ppThemeDismiss) return;
    doc.__ppThemeDismiss = true;
    const inside = (ev, id) => {
      const t = ev.target;
      if (!t || typeof t.closest !== "function") return false;
      try { return !!t.closest("#" + id); } catch (e) { return false; }
    };
    const close = () => {
      const pop = doc.getElementById(this.POPUP_ID);
      if (pop && pop.style.display === "block") pop.style.display = "none";
    };
    doc.addEventListener("click", (ev) => {
      if (inside(ev, this.READER_BTN_ID) || inside(ev, this.POPUP_ID)) return;
      close();
    }, true);
    doc.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") close();
    }, true);
  },

  /* ==================== 主窗口：左上角 toolbarbutton ==================== */

  _mainWindows() {
    const out = [];
    try {
      for (const w of Zotero.getMainWindows() || []) out.push(w);
    } catch (e) { /* ignore */ }
    return out;
  },

  _injectMainWindows() {
    for (const win of this._mainWindows()) {
      try { this._injectMainWindow(win); } catch (e) { this._err(e); }
    }
  },

  _injectMainWindow(win) {
    if (!win || !win.document || !win.ZoteroPane) return;
    const doc = win.document;
    const host = doc.getElementById("zotero-collections-toolbar");
    if (!host) return;
    // 已注入且仍在文档里 → 只刷新状态（窗口 reload 后节点会消失，需重插）
    const exists = doc.getElementById(this.MAIN_BTN_ID);
    if (exists && exists.parentNode) {
      exists.setAttribute("tooltiptext", this._tip());
      if (!this._ready()) exists.setAttribute("disabled", "true");
      return;
    }
    const btn = this._mainButton(doc);
    const anchor = doc.getElementById("zotero-tb-collection-add");
    if (anchor && anchor.parentNode === host) {
      // 紧挨「新建分类」之后：左上角第一排，与相邻控件同规格
      host.insertBefore(btn, anchor.nextSibling);
    } else {
      host.insertBefore(btn, host.firstChild);
    }
    this._track(doc, btn);
  },

  _mainButton(doc) {
    const btn = this._xul(doc, "toolbarbutton");
    btn.id = this.MAIN_BTN_ID;
    btn.setAttribute("class", "zotero-tb-button");
    btn.setAttribute("tabindex", "-1");
    btn.setAttribute("tooltiptext", this._tip());
    // 图标走 XUL 惯例：list-style-image + context-fill 单色图标，
    // 颜色继承 toolbarbutton 的 color:var(--fill-secondary)
    btn.style.listStyleImage = 'url("chrome://paperpilot/content/icons/theme.svg")';
    btn.style.MozContextProperties = "fill"; // eslint-disable-line
    btn.style.fill = "currentColor";
    if (!this._ready()) btn.setAttribute("disabled", "true");

    const popup = this._xul(doc, "menupopup");
    popup.id = "paperpilot-theme-main-popup";
    popup.addEventListener("popupshowing", () => this._fillMainMenu(doc, popup));
    // 手动窗口：不用 type="menu"（那样宽度会变成 40px，与相邻 28px 按钮不齐）；
    // 自己维护 open 属性，让原生 `toolbarbutton[open=true]{--fill-quarternary}` 生效
    popup.addEventListener("popupshown", () => btn.setAttribute("open", "true"));
    popup.addEventListener("popuphidden", () => btn.removeAttribute("open"));
    btn.appendChild(popup);

    btn.addEventListener("command", () => {
      if (btn.hasAttribute("disabled")) return;
      try {
        popup.openPopup(btn, "after_start", 0, 4, false, false);
      } catch (e) { this._err(e); }
    });
    return btn;
  },

  /** 主窗口弹层：原生 menupopup + radio，与「视图 → 外观主题」菜单同构同交互 */
  _fillMainMenu(doc, popup) {
    while (popup.firstChild) popup.removeChild(popup.firstChild);
    const ready = this._ready();

    // ---- 界面主题 ----
    const uiMenu = this._xul(doc, "menu");
    uiMenu.setAttribute("label", I18n.t("menuUiTheme"));
    const uiPopup = this._xul(doc, "menupopup");
    uiMenu.appendChild(uiPopup);
    const curUi = String(Prefs.get("uiTheme", "") || "");
    for (const g of this._uiGroups()) {
      let inner = uiPopup;
      if (g.label) {
        const sub = this._xul(doc, "menu");
        sub.setAttribute("label", g.label);
        const subPopup = this._xul(doc, "menupopup");
        sub.appendChild(subPopup);
        uiPopup.appendChild(sub);
        inner = subPopup;
      }
      for (const it of g.items) {
        const mi = this._xul(doc, "menuitem");
        mi.setAttribute("label", (it.icon ? it.icon + " " : "") + it.name);
        mi.setAttribute("type", "radio");
        mi.setAttribute("checked", it.id === curUi ? "true" : "false");
        mi.setAttribute("disabled", ready ? "false" : "true");
        mi.addEventListener("command", () => this._applyUi(it.id));
        inner.appendChild(mi);
      }
    }
    popup.appendChild(uiMenu);

    // ---- PDF 阅读主题 ----
    const pdfMenu = this._xul(doc, "menu");
    pdfMenu.setAttribute("label", I18n.t("menuPdfTheme"));
    const pdfPopup = this._xul(doc, "menupopup");
    pdfMenu.appendChild(pdfPopup);
    const curPdf = this._pdf() ? this._pdf().current().id : "";
    for (const it of this._pdfItems()) {
      const mi = this._xul(doc, "menuitem");
      mi.setAttribute("label", it.icon + " " + it.name);
      mi.setAttribute("type", "radio");
      mi.setAttribute("checked", it.id === curPdf ? "true" : "false");
      mi.setAttribute("disabled", ready ? "false" : "true");
      mi.addEventListener("command", () => this._applyPdf(it.id));
      pdfPopup.appendChild(mi);
    }
    popup.appendChild(pdfMenu);

    // ---- 入口：打开完整外观主题设置（自定义配色 / 壁纸） ----
    popup.appendChild(this._xul(doc, "menuseparator"));
    const open = this._xul(doc, "menuitem");
    open.setAttribute("label", I18n.t("themeOpenSettings"));
    open.addEventListener("command", () => {
      try {
        if (typeof Menus !== "undefined" && Menus.openSettings) Menus.openSettings();
      } catch (e) { this._err(e); }
    });
    popup.appendChild(open);
  },

  /* ==================== 状态同步 ==================== */

  /** 主题改变后调用：同步两处按钮提示与正在展示的弹层选中态 */
  refresh() {
    const tip = this._tip();
    for (const win of this._mainWindows()) {
      try {
        const btn = win.document.getElementById(this.MAIN_BTN_ID);
        if (btn) btn.setAttribute("tooltiptext", tip);
      } catch (e) { /* ignore */ }
    }
    try {
      const btn = this._readerBtn;
      if (btn && btn.isConnected) btn.title = tip;
    } catch (e) { /* ignore */ }
  },

  /** 按 pref 开关两处按钮（用户可在 about:config 里关掉）。
   *  阅读器按钮由 React 渲染驱动，关掉后需等工具栏下次重渲染才消失——因此这里
   *  对已打开的 reader 主动摘一遍，保证「关掉」即刻可见。 */
  syncEnabled() {
    const on = !!Prefs.get(this.PREF_ENABLED, true);
    if (on) {
      this._injectMainWindows();
      return;
    }
    for (const win of this._mainWindows()) {
      try {
        const btn = win.document.getElementById(this.MAIN_BTN_ID);
        if (btn) btn.remove();
      } catch (e) { /* ignore */ }
    }
    for (const doc of this._readerDocs()) {
      try {
        const b = doc.getElementById(this.READER_BTN_ID);
        if (b) b.remove();
        const s = doc.getElementById(this.STYLE_ID);
        if (s) s.remove();
        const p = doc.getElementById(this.POPUP_ID);
        if (p) p.remove();
      } catch (e) { /* ignore */ }
    }
  },

  /** 已打开的 reader 文档（与 PdfTheme.refresh 同一双路径枚举） */
  _readerDocs() {
    const out = [];
    const push = (win) => {
      if (win && win.document && out.indexOf(win.document) < 0) out.push(win.document);
    };
    try {
      for (const r of (Zotero.Reader && Zotero.Reader._readers) || []) push(r && r._iframeWindow);
    } catch (e) { /* ignore */ }
    try {
      for (const win of this._mainWindows()) {
        for (const bro of win.document.querySelectorAll("browser.reader")) push(bro.contentWindow);
      }
    } catch (e) { /* ignore */ }
    return out;
  },

  /* ==================== 生命周期 ==================== */

  register(pluginID) {
    if (this._readerHandler) return;
    this._pluginID = pluginID || "paperpilot@dev.local";
    if (!Prefs.get(this.PREF_ENABLED, true)) return;

    // ① 阅读器工具栏：官方扩展位
    if (Zotero.Reader && typeof Zotero.Reader.registerEventListener === "function") {
      this._readerHandler = (event) => this._onRenderToolbar(event);
      try {
        // 注：回调用箭头函数包一层，unregisterEventListener 才能用同一个函数引用精确注销
        Zotero.Reader.registerEventListener("renderToolbar", this._readerHandler, this._pluginID);
      } catch (e) {
        this._readerHandler = null;
        this._err(e);
      }
    }

    // ② 主窗口左上角：现在已开的窗口 + 之后新开的窗口
    this._injectMainWindows();
    try {
      this._obsObserver = {
        observe(subject) {
          try {
            const win = subject && subject.defaultView ? subject.defaultView : subject;
            if (win && win.ZoteroPane) ThemeToggle._injectMainWindow(win);
          } catch (e) { /* ignore */ }
        },
      };
      Services.obs.addObserver(this._obsObserver, "domwindowopened", false);
    } catch (e) {
      this._obsObserver = null;
      this._err(e);
    }
  },

  unregister() {
    try {
      if (this._readerHandler && Zotero.Reader && Zotero.Reader.unregisterEventListener) {
        Zotero.Reader.unregisterEventListener("renderToolbar", this._readerHandler);
      }
    } catch (e) { /* ignore */ }
    this._readerHandler = null;
    try {
      if (this._obsObserver) Services.obs.removeObserver(this._obsObserver, "domwindowopened");
    } catch (e) { /* ignore */ }
    this._obsObserver = null;

    // 摘掉全部注入（两处的按钮、阅读器弹层与样式），宿主回到原生状态
    for (const { node } of this._nodes) {
      try {
        if (node && node.parentNode) node.parentNode.removeChild(node);
      } catch (e) { /* ignore */ }
    }
    this._nodes = [];
    this._readerBtn = null;
    // 阅读器按钮落在 React 托管的 .custom-sections 里，逐个文档再补摘一次
    for (const doc of this._readerDocs()) {
      try {
        const b = doc.getElementById(this.READER_BTN_ID);
        if (b) b.remove();
        const s = doc.getElementById(this.STYLE_ID);
        if (s) s.remove();
        const p = doc.getElementById(this.POPUP_ID);
        if (p) p.remove();
      } catch (e) { /* ignore */ }
    }
  },
};
