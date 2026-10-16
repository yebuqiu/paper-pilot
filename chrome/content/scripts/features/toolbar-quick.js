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
 *   ③ 视图组（0.43.0）：列组合预设的保存/一键切换（参考 zotero-style View Group），
 *      数据模型见下方 ColumnViews；
 *   ④ 设置入口。
 *
 * ⚠️ 0.38.0 教训（主题按钮踩坑）：XUL popup 事件与 menuitem 的 command **都会冒泡**——
 *    子菜单 popupshowing 冒泡会触发整菜单重建、菜单项 command 冒泡会让按钮原地重开。
 *    本模块所有监听一律带 ev.target 守卫（Zotero 自身 menuManager.js 同款防御）。
 *
 * 生命周期：register(pluginID) / unregister() / syncEnabled()（pref quickBarButtonEnabled 开关）。
 */
/* global Zotero, Services, Prefs, I18n, Menus, PdfDual */

/* ==================== 视图组（0.43.0） ====================
 * 条目列表「列组合」预设：保存当前列启用状态为快照，菜单一键切换
 * （参考 zotero-style 的 View Group，但只走 pref，不改 XUL 持久化）。
 *
 * 数据模型：pref `columnViews`（完整 key = extensions.zotero.paperpilot.columnViews）
 *   JSON 数组 [{ id, name, columns: {插件列id: bool}, native: {原生列dataKey: bool(是否隐藏)} }]
 *
 * 插件列（5 个，均有 *ColumnEnabled pref 门控，main.js 的 pref 观察者
 * 会自动注册/注销列，所以「应用视图」= 写 pref，零额外接线）：
 *   rank / citation / titleTranslation / progress / rating
 *
 * ★ 原生列的已知限制（调研结论）：
 *   Zotero 7+ 没有公开 API 读写原生列显隐。其状态在内存里挂在
 *   ZoteroPane.itemsView._columnPrefs（{dataKey: {hidden, ordinal, width}}），
 *   持久化走私有方法 _storeColumnPrefs()：写 Zotero.Prefs「pane.persist」
 *   （JSON，按 tree id 分键），新版本还会节流写 profile 下独立文件
 *   （见 zotero/zotero commit ead4dff "Store column prefs to a dedicated file"）。
 *   这里只能尽力而为：改 _columnPrefs 后优先调 _storeColumnPrefs 持久化，
 *   否则退回 ItemTreeManager.refreshColumns()。Zotero 升级改私有结构时会
 *   静默失效（插件 5 列不受影响，那是我们自己的 pref）。
 */
var ColumnViews = {
  PREF: "columnViews",

  /** 插件列 id → 门控 pref 名（值默认 true，与 main.js 一致） */
  PLUGIN_COLUMNS: {
    rank: "rankColumnEnabled",
    citation: "citationColumnEnabled",
    titleTranslation: "titleTranslationColumnEnabled",
    progress: "progressColumnEnabled",
    rating: "ratingColumnEnabled",
  },

  /** 内置默认预设（首次运行补种；用户可删，删除后不复活） */
  DEFAULTS: [
    {
      id: "view-reading",
      name: "阅读视图",
      columns: { rank: false, citation: false, titleTranslation: true, progress: true, rating: true },
      native: null,
    },
    {
      id: "view-journal",
      name: "选刊视图",
      columns: { rank: true, citation: true, titleTranslation: false, progress: false, rating: false },
      native: null,
    },
  ],

  _read() {
    try {
      const raw = Prefs.get(this.PREF, "");
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter((v) => v && v.id && v.name) : [];
    } catch (e) {
      return [];
    }
  },

  _write(list) {
    Prefs.set(this.PREF, JSON.stringify(list));
  },

  /** 列出全部预设；pref 缺失时先幂等补种内置默认（首次运行） */
  list() {
    let views = this._read();
    if (!Prefs.get(this.PREF, "")) {
      // 无 pref：补种内置默认（仅在「从未有过」时；用户删光后 pref 是 "[]"，不复活）
      views = this.DEFAULTS.map((v) => JSON.parse(JSON.stringify(v)));
      this._write(views);
    }
    return views;
  },

  /** 当前各列启用状态 → 快照（供「保存当前为视图…」） */
  snapshot() {
    const columns = {};
    for (const id in this.PLUGIN_COLUMNS) {
      columns[id] = !!Prefs.get(this.PLUGIN_COLUMNS[id], true);
    }
    return { columns, native: this._readNative() };
  },

  /** 保存快照为预设；同名覆盖。返回预设对象。 */
  save(name) {
    name = String(name || "").trim();
    if (!name) return null;
    const views = this._read();
    const snap = this.snapshot();
    const existing = views.find((v) => v.name === name);
    if (existing) {
      existing.columns = snap.columns;
      existing.native = snap.native;
      this._write(views);
      return existing;
    }
    const view = {
      id: "v" + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36),
      name,
      columns: snap.columns,
      native: snap.native,
    };
    views.push(view);
    this._write(views);
    return view;
  },

  remove(id) {
    const views = this._read().filter((v) => v.id !== id);
    this._write(views);
  },

  /** 应用视图 = 写各 *ColumnEnabled pref（main.js 观察者自动注册/注销列）
   *  + 原生列尽力而为（见文件头注释的限制说明） */
  apply(id) {
    const view = this._read().find((v) => v.id === id);
    if (!view) return false;
    const cols = view.columns || {};
    for (const colId in this.PLUGIN_COLUMNS) {
      if (!(colId in cols)) continue;
      try { Prefs.set(this.PLUGIN_COLUMNS[colId], !!cols[colId]); } catch (e) { /* ignore */ }
    }
    if (view.native) this._applyNative(view.native);
    return true;
  },

  /* ---------- 原生列（尽力而为；私有结构，可能随 Zotero 升级失效） ---------- */

  _itemsViews() {
    const out = [];
    try {
      for (const win of Zotero.getMainWindows() || []) {
        try {
          const zp = win.ZoteroPane;
          if (zp && zp.itemsView && zp.itemsView._columnPrefs) out.push(zp.itemsView);
        } catch (e) { /* ignore */ }
      }
    } catch (e) { /* ignore */ }
    return out;
  },

  /** 读原生列显隐 → {dataKey: bool(是否隐藏)}；读不到返回 null */
  _readNative() {
    try {
      const views = this._itemsViews();
      if (!views.length) return null;
      const prefs = views[0]._columnPrefs;
      const out = {};
      for (const key in prefs) out[key] = !!prefs[key].hidden;
      return Object.keys(out).length ? out : null;
    } catch (e) {
      return null;
    }
  },

  /** 写原生列显隐：改 _columnPrefs 后优先 _storeColumnPrefs 持久化，
   *  否则退回 refreshColumns 触发重载。全部 best-effort。 */
  _applyNative(native) {
    try {
      for (const itemsView of this._itemsViews()) {
        try {
          const prefs = itemsView._columnPrefs;
          let changed = false;
          for (const key in native) {
            if (!prefs[key]) continue;
            const hidden = !!native[key];
            if (!!prefs[key].hidden !== hidden) { prefs[key].hidden = hidden; changed = true; }
          }
          if (!changed) continue;
          if (typeof itemsView._storeColumnPrefs === "function") {
            itemsView._storeColumnPrefs(prefs);
          }
        } catch (e) { /* ignore */ }
      }
      try { Zotero.ItemTreeManager.refreshColumns(); } catch (e) { /* ignore */ }
    } catch (e) { /* ignore */ }
  },
};

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

    // ③ 视图组（0.43.0）：已保存预设（点击=应用）+ 保存当前 + 删除动态项
    popup.appendChild(this._el(doc, "menuseparator"));
    popup.appendChild(this._rawItem(doc, "保存当前为视图…", () => this._saveViewPrompt()));
    const views = ColumnViews.list();
    for (const v of views) {
      popup.appendChild(this._rawItem(doc, v.name, () => this._applyView(v)));
    }
    if (views.length) {
      popup.appendChild(this._el(doc, "menuseparator"));
      for (const v of views) {
        popup.appendChild(this._rawItem(doc, "删除视图 ▸ " + v.name,
          () => { try { ColumnViews.remove(v.id); } catch (e) { this._err(e); } }));
      }
    }

    // ④ 设置入口
    popup.appendChild(this._el(doc, "menuseparator"));
    popup.appendChild(this._menuItem(doc, "menuSettings",
      () => { try { Menus.openSettings(); } catch (e) { this._err(e); } }));
  },

  _applyView(view) {
    try {
      ColumnViews.apply(view.id);
    } catch (e) { this._err(e); }
  },

  /** 「保存当前为视图…」：prompt 输入名字，同名覆盖 */
  _saveViewPrompt() {
    let win = null;
    try { win = Zotero.getMainWindow(); } catch (e) { /* ignore */ }
    const input = { value: "" };
    let ok = false;
    try {
      ok = Services.prompt.prompt(win, "PaperPilot 视图组",
        "为当前列组合取个名字：", input, null, {});
    } catch (e) { this._err(e); return; }
    if (!ok) return;
    const view = ColumnViews.save(input.value);
    if (!view) return;
    try {
      Services.prompt.alert(win, "PaperPilot", "已保存视图「" + view.name + "」");
    } catch (e) { /* ignore */ }
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

  /** 动态文案（视图名等不走 I18n 表） */
  _rawItem(doc, label, run) {
    const mi = this._el(doc, "menuitem");
    mi.setAttribute("label", String(label));
    mi.addEventListener("command", (ev) => {
      ev.stopPropagation();
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
    // 图标：16px 单色 SVG（context-fill + currentColor，同 theme.svg 规格）——
    // 与原生按钮一致；不要用 icon.png（48px 位图会按原始尺寸撑大按钮）
    btn.style.listStyleImage = 'url("chrome://paperpilot/content/icons/quick.svg")';
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
