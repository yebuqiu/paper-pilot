/* PaperPilot 顶部快捷按钮（0.38.0 新增）
 *
 * 背景：功能大多埋在右键菜单 / 功能中心里，「方便直接使用」缺一个常驻一键入口。
 * 位置：主窗口**顶部条目工具栏** #zotero-items-toolbar（条目列表正上方），
 *       插在搜索框左侧——与原生按钮同规格（toolbarbutton.zotero-tb-button 28×28）。
 * 为什么是这里：
 *   · 条目级高频动作（AI 总结 / 对照翻译…）的主场就在条目列表上方，视线零转移；
 *   · 左侧收藏夹工具栏已放「界面主题」按钮，再塞功能按钮会挤（左栏只适合库级操作）；
 *   · 右侧栏已有 AI 问答 / PDF 速览 / 翻译三个 section，阅读器工具栏已有
 *     PDF 主题 / AI 悬浮窗按钮——右侧与阅读器不需要重复入口。
 *
 * 菜单内容（单一真源，不维护第二份列表）：
 *   ① 高频直达项 ≤3 —— 直接读 menuQuickItems pref（与右键菜单直达项**同一份配置**，
 *      在「设置 → 菜单定制」里改，两处同步生效）；
 *   ② 固定三件套：AI 问答悬浮窗 / PDF 对照翻译 / 功能中心（与直达项按 id 去重）；
 *   ③ 设置入口。
 *
 * ⚠️ 0.38.0 教训（主题按钮踩坑）：XUL popup 事件与 menuitem 的 command **都会冒泡**——
 *    子菜单 popupshowing 冒泡会触发整菜单重建、菜单项 command 冒泡会让按钮原地重开。
 *    本模块所有监听一律带 ev.target 守卫（Zotero 自身 menuManager.js 同款防御）。
 *
 * 生命周期：register(pluginID) / unregister() / syncEnabled()（pref quickBarButtonEnabled 开关）。
 */
/* global Zotero, Services, Prefs, I18n, Menus, PdfDual */

var ToolbarQuick = {
  BTN_ID: "paperpilot-quick-toolbar-button",
  POPUP_ID: "paperpilot-quick-popup",
  PREF_ENABLED: "quickBarButtonEnabled",

  XUL: "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul",

  _obsObserver: null,
  _nodes: [],       // [{doc, node}] 注入过的节点，unregister 时统一移除

  _el(doc, tag) {
    return doc.createXULElement
      ? doc.createXULElement(tag)
      : doc.createElementNS(this.XUL, tag);
  },

  _track(doc, node) {
    if (node) this._nodes.push({ doc, node });
    return node;
  },

  _mainWindows() {
    const out = [];
    try {
      for (const w of Zotero.getMainWindows() || []) out.push(w);
    } catch (e) { /* ignore */ }
    return out;
  },

  /* ==================== 菜单内容 ==================== */

  /** 固定三件套（id 与 ITEM_REGISTRY 对齐，便于和直达项去重） */
  _fixedItems() {
    return [
      { id: "ai-chat", labelKey: "menuAiChat", run: () => Menus.openChatFloat() },
      { id: "bilingual-view", labelKey: "menuPdfDual", run: () => PdfDual.openForSelected() },
      { id: "hub", labelKey: "menuHub", run: () => Zotero.PaperPilot.openHub() },
    ];
  },

  _err(e) {
    try { Zotero.logError(e); } catch (_) { /* ignore */ }
  },

  _fillQuickMenu(doc, popup) {
    while (popup.firstChild) popup.removeChild(popup.firstChild);

    // ① 高频直达项（与右键菜单同一份 menuQuickItems pref，单一真源）
    const quick = (typeof Menus !== "undefined" && Menus._quickItems) ? Menus._quickItems() : [];
    const usedIds = new Set();
    for (const it of quick) {
      usedIds.add(it.id);
      popup.appendChild(this._menuItem(doc, it.labelKey, it.run));
    }

    // ② 固定三件套（去重：已在直达项里的不重复列）
    const extras = this._fixedItems().filter((it) => !usedIds.has(it.id));
    if (extras.length) {
      if (quick.length) popup.appendChild(this._el(doc, "menuseparator"));
      for (const it of extras) {
        popup.appendChild(this._menuItem(doc, it.labelKey, it.run));
      }
    }

    // ③ 设置入口
    popup.appendChild(this._el(doc, "menuseparator"));
    popup.appendChild(this._menuItem(doc, "menuSettings",
      () => { try { Menus.openSettings(); } catch (e) { this._err(e); } }));
  },

  _menuItem(doc, labelKey, run) {
    const mi = this._el(doc, "menuitem");
    try { mi.setAttribute("label", I18n.t(labelKey)); }
    catch (e) { mi.setAttribute("label", labelKey); }
    mi.addEventListener("command", (ev) => {
      ev.stopPropagation(); // 防冒泡到按钮（0.38.0 主题按钮同款坑）
      try { run(); } catch (e) { this._err(e); }
    });
    return mi;
  },

  /* ==================== 注入 ==================== */

  _injectMainWindow(win) {
    if (!win || !win.document || !win.ZoteroPane) return;
    const doc = win.document;
    const host = doc.getElementById("zotero-items-toolbar");
    if (!host) return;
    const exists = doc.getElementById(this.BTN_ID);
    if (exists && exists.parentNode) return; // 已在（窗口 reload 后节点会消失，需重插）
    const btn = this._quickButton(doc);
    // 锚在搜索加载图标之前 = 搜索框左侧，右对齐区，不与左侧原生动作按钮拥挤
    const anchor = doc.getElementById("zotero-tb-search-spinner")
      || doc.getElementById("zotero-tb-search");
    if (anchor && anchor.parentNode === host) host.insertBefore(btn, anchor);
    else host.insertBefore(btn, host.firstChild);
    this._track(doc, btn);
  },

  _quickButton(doc) {
    const btn = this._el(doc, "toolbarbutton");
    btn.id = this.BTN_ID;
    btn.setAttribute("class", "zotero-tb-button");
    btn.setAttribute("tabindex", "-1");
    btn.setAttribute("tooltiptext", I18n.t("quickBarTip"));
    btn.style.listStyleImage = 'url("chrome://paperpilot/content/icons/icon.png")';
    btn.style.MozContextProperties = "fill"; // eslint-disable-line
    btn.style.fill = "currentColor";

    const popup = this._el(doc, "menupopup");
    popup.id = this.POPUP_ID;
    // ★ 冒泡双守卫（Zotero menuManager.js 同款）：popup 事件只认自己，
    // 按钮的 command 只认按钮本身
    const onlySelf = (fn) => (ev) => { if (ev.target !== popup) return; fn(ev); };
    popup.addEventListener("popupshowing", onlySelf(() => this._fillQuickMenu(doc, popup)));
    popup.addEventListener("popupshown", onlySelf(() => btn.setAttribute("open", "true")));
    popup.addEventListener("popuphidden", onlySelf(() => btn.removeAttribute("open")));
    btn.appendChild(popup);

    btn.addEventListener("command", (ev) => {
      if (ev.target !== btn) return; // 菜单项 command 冒泡上来的不是按钮点击
      try {
        popup.openPopup(btn, "after_start", 0, 4, false, false);
      } catch (e) { this._err(e); }
    });
    return btn;
  },

  /* ==================== 状态同步 / 生命周期 ==================== */

  syncEnabled() {
    const on = !!Prefs.get(this.PREF_ENABLED, true);
    if (on) {
      for (const win of this._mainWindows()) {
        try { this._injectMainWindow(win); } catch (e) { this._err(e); }
      }
      return;
    }
    for (const win of this._mainWindows()) {
      try {
        const btn = win.document.getElementById(this.BTN_ID);
        if (btn) btn.remove();
      } catch (e) { /* ignore */ }
    }
  },

  register() {
    if (this._obsObserver) return;
    if (!Prefs.get(this.PREF_ENABLED, true)) return;
    for (const win of this._mainWindows()) {
      try { this._injectMainWindow(win); } catch (e) { this._err(e); }
    }
    try {
      this._obsObserver = {
        observe(subject) {
          try {
            const win = subject && subject.defaultView ? subject.defaultView : subject;
            if (win && win.ZoteroPane) ToolbarQuick._injectMainWindow(win);
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
      if (this._obsObserver) Services.obs.removeObserver(this._obsObserver, "domwindowopened");
    } catch (e) { /* ignore */ }
    this._obsObserver = null;
    for (const { node } of this._nodes) {
      try {
        if (node && node.parentNode) node.parentNode.removeChild(node);
      } catch (e) { /* ignore */ }
    }
    this._nodes = [];
  },
};
