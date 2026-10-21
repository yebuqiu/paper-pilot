// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 左下角标签入口（0.70.0）
 *
 * 为什么不去改 tag selector 的 DOM：Zotero 7+ 的标签列表是 React + react-virtualized
 * 渲染的（chrome/content/zotero/components/tagSelector/tagSelectorList.js），
 * 每个标签是 div.tag-selector-item，只渲染可视区，点击语义是「加/减筛选条件」。
 * 往 chip 里插复选框会被重渲染抹掉，且和筛选语义打架。所以：
 *   - 左下角只做**入口**：在原生 #tag-menu（指派颜色/重命名/拆分/删除）末尾追加一节；
 *   - 批量能力全部落在独立窗口 tag-manager.xhtml。
 *
 * 原生菜单每次右键都会遍历 childNodes 置 disabled（tagSelectorContainer.handleTagContext），
 * 我们的项也会被一起处理；因此每次 popupshowing 先移除旧节点再重建，避免重复堆叠。
 */
/* global Zotero, Services, Prefs, TagOps, I18n */

var TagMenu = {
  PREF_ENABLE: "extensions.zotero.papilot.tagMenuEnabled",
  WINDOW_TYPE: "papilot:tag-manager",
  WINDOW_URL: "chrome://papilot/content/tag-manager.xhtml",
  WINDOW_NAME: "papilot-tag-manager",
  MENU_ROOT_ID: "papilot-tag-menu-root",

  _hook: null,
  _lastCtx: null,

  /** 在 Zotero 主窗口挂上右键注入（幂等） */
  install() {
    try {
      if (Prefs && typeof Prefs.get === "function" && Prefs.get("tagMenuEnabled", true) === false) return;
      const win = Zotero.getMainWindow();
      if (!win || !win.document) return;
      const doc = win.document;
      const popup = doc.getElementById("tag-menu");
      if (!popup) return;
      if (this._hook && this._hook.popup === popup) return;

      this.unregister();

      // 记住最近一次右键命中的标签（原生 contextTag 是首选，这里是兜底：
      // 某些版本 contextTag 在 popupshowing 之后才赋值）
      const onCtx = (ev) => {
        try {
          let el = ev.target;
          while (el && el !== doc) {
            if (el.classList && el.classList.contains("tag-selector-item")) {
              this._lastCtx = { name: el.textContent || "", at: Date.now() };
              return;
            }
            el = el.parentNode;
          }
        } catch (e) { /* ignore */ }
      };
      doc.addEventListener("contextmenu", onCtx, true);

      const onPopup = () => {
        try { this._rebuild(win, popup); } catch (e) { try { Zotero.logError(e); } catch (e2) { /* ignore */ } }
      };
      popup.addEventListener("popupshowing", onPopup);

      this._hook = { win, doc, popup, onCtx, onPopup };
    } catch (e) {
      try { Zotero.logError(e); } catch (e2) { /* ignore */ }
    }
  },

  unregister() {
    const h = this._hook;
    if (!h) return;
    try { h.popup.removeEventListener("popupshowing", h.onPopup); } catch (e) { /* ignore */ }
    try { h.doc.removeEventListener("contextmenu", h.onCtx, true); } catch (e) { /* ignore */ }
    try { this._removeNodes(h.doc); } catch (e) { /* ignore */ }
    this._hook = null;
    this._lastCtx = null;
  },

  _removeNodes(doc) {
    // 优先按引用摘（自己注入的节点自己知道）；再按 id 兜一层，
    // 防止上一次注入的引用在异常路径里丢了导致菜单越堆越多。
    const owned = (this._hook && this._hook.nodes) || [];
    for (const el of owned) {
      try { if (el && el.parentNode) el.parentNode.removeChild(el); } catch (e) { /* ignore */ }
    }
    for (const id of [this.MENU_ROOT_ID, this.MENU_ROOT_ID + "-sep"]) {
      const el = doc.getElementById(id);
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }
  },

  _xul(doc, tag) {
    try { return doc.createXULElement(tag); } catch (e) { return doc.createElement(tag); }
  },

  /** 当前右键的标签名：原生 contextTag 优先，其次最近一次 contextmenu 记录 */
  _currentTag(win) {
    try {
      const ts = win.ZoteroPane && win.ZoteroPane.tagSelector;
      if (ts && ts.contextTag && ts.contextTag.name) return String(ts.contextTag.name);
    } catch (e) { /* ignore */ }
    const last = this._lastCtx;
    if (last && last.name && Date.now() - last.at < 5000) return last.name;
    return "";
  },

  /** 当前库是否可写（Feeds / 虚拟库只读） */
  _readOnly(win) {
    try {
      const ts = win.ZoteroPane && win.ZoteroPane.tagSelector;
      if (ts && ts.state && ts.state.viewOnly) return true;
    } catch (e) { /* ignore */ }
    try {
      const libID = TagOps.libraryID();
      const lib = Zotero.Libraries.get(libID);
      if (lib && lib.libraryType === "feed") return true;
      if (lib && lib.editable === false) return true;
    } catch (e) { /* ignore */ }
    return false;
  },

  _rebuild(win, popup) {
    const doc = win.document;
    this._removeNodes(doc);

    const name = this._currentTag(win);
    const readOnly = this._readOnly(win);
    const zh = (I18n && I18n.isZh) !== false;

    const sep = this._xul(doc, "menuseparator");
    sep.id = this.MENU_ROOT_ID + "-sep";
    popup.appendChild(sep);

    const root = this._xul(doc, "menu");
    root.id = this.MENU_ROOT_ID;
    root.setAttribute("label", zh ? "Papilot 标签工具" : "Papilot Tag Tools");
    const sub = this._xul(doc, "menupopup");
    root.appendChild(sub);
    popup.appendChild(root);

    // 记住本次注入的节点，下一次 popupshowing 直接按引用摘除
    if (this._hook) this._hook.nodes = [sep, root];

    const item = (label, onCommand, opts) => {
      const mi = this._xul(doc, "menuitem");
      mi.setAttribute("label", label);
      if (opts && opts.disabled) mi.setAttribute("disabled", "true");
      mi.addEventListener("command", (ev) => {
        try { ev.stopPropagation(); } catch (e) { /* ignore */ }
        try { onCommand(); } catch (e) { try { Zotero.logError(e); } catch (e2) { /* ignore */ } }
      });
      sub.appendChild(mi);
      return mi;
    };

    item(zh ? "打开标签管理器…" : "Open Tag Manager…", () => this.openManager({ focusTag: name }));

    if (name) {
      item((zh ? "在管理器中定位「" : "Locate \"") + name + (zh ? "」" : "\""),
        () => this.openManager({ focusTag: name }));

      const protect = TagOps.protectList();
      const guarded = TagOps.isProtected(name, protect);

      sub.appendChild(this._xul(doc, "menuseparator"));

      item((zh ? "删除「" : "Delete \"") + name + (zh ? "」…" : "\"…"),
        () => this.deleteOne(win, name),
        { disabled: readOnly });

      item(guarded
        ? (zh ? "移出保护名单" : "Remove from guard list")
        : (zh ? "加入保护名单" : "Add to guard list"),
      () => {
        const list = TagOps.protectList();
        const next = guarded ? list.filter((p) => p !== name) : list.concat([name]);
        TagOps.setProtectList(next);
        this._toast(win, guarded
          ? (zh ? "已移出保护：" + name : "Unguarded: " + name)
          : (zh ? "已加入保护：" + name : "Guarded: " + name));
      });
    }
  },

  _toast(win, text) {
    try {
      const pw = new Zotero.ProgressWindow({ closeOnClick: true });
      pw.changeHeadline("Papilot");
      pw.addDescription(text);
      pw.show();
      pw.startCloseTimer(2200);
    } catch (e) { /* ignore */ }
  },

  /** 单标签删除：先算影响面 → 确认 → 快照 → 删除 */
  async deleteOne(win, name) {
    const zh = (I18n && I18n.isZh) !== false;
    const libID = TagOps.libraryID();
    let total = 0;
    try {
      const items = await TagOps.itemsFor(libID, [name], { limit: 1 });
      total = items.total;
    } catch (e) { total = 0; }

    const msg = zh
      ? "将从 " + total + " 篇条目上移除标签「" + name + "」。\n\n会先保存快照，可在「标签管理器 → 快照与撤销」里回滚。"
      : "Remove tag \"" + name + "\" from " + total + " item(s).\n\nA snapshot is saved first; undo is available in Tag Manager → Snapshots.";
    const flags = Services.prompt.BUTTON_POS_0 * Services.prompt.BUTTON_TITLE_IS_STRING +
      Services.prompt.BUTTON_POS_1 * Services.prompt.BUTTON_TITLE_IS_STRING;
    const choice = Services.prompt.confirmEx(win, "Papilot · " + (zh ? "删除标签" : "Delete tag"), msg, flags,
      zh ? "删除" : "Delete", zh ? "取消" : "Cancel", null, null, {});
    if (choice !== 0) return false;

    try {
      await TagOps.snapshot(libID, [name], { op: "delete", note: "context menu" });
      const r = await TagOps.deleteTags(libID, [name]);
      this._toast(win, zh
        ? "已删除「" + name + "」（" + total + " 篇条目受影响）"
        : "Deleted \"" + name + "\" (" + total + " items)");
      return r.removed > 0;
    } catch (e) {
      try { Zotero.logError(e); } catch (e2) { /* ignore */ }
      Services.prompt.alert(win, "Papilot", zh
        ? "删除失败：" + (e && e.message || e)
        : "Delete failed: " + (e && e.message || e));
      return false;
    }
  },

  /**
   * 打开（或复用）标签管理器窗口
   * @param {{focusTag?:string}} [opts]
   */
  async openManager(opts) {
    const o = opts || {};
    const zh = (I18n && I18n.isZh) !== false;
    const libID = TagOps.libraryID();
    let libraryName = "";
    try {
      const lib = Zotero.Libraries.get(libID);
      libraryName = (lib && lib.name) || "";
    } catch (e) { libraryName = ""; }

    const payload = {
      Zotero,
      TagOps,
      isZh: zh,
      libraryID: libID,
      libraryName,
      focusTag: o.focusTag || "",
      onChanged: () => { /* Zotero 的 notifier 会自动刷新 tag selector */ },
    };

    try {
      const en = Services.wm.getEnumerator(this.WINDOW_TYPE);
      if (en.hasMoreElements()) {
        const win = en.getNext();
        try { win.focus(); } catch (e) { /* ignore */ }
        try {
          if (typeof win.ppTagManagerLoad === "function") win.ppTagManagerLoad(payload);
        } catch (e) { /* ignore */ }
        return win;
      }
    } catch (e) { /* ignore */ }

    const main = Zotero.getMainWindow();
    if (!main) return null;
    try {
      return main.openDialog(this.WINDOW_URL, this.WINDOW_NAME,
        "chrome,centerscreen,resizable,dialog=no", payload);
    } catch (e) {
      try { Zotero.logError(e); } catch (e2) { /* ignore */ }
      return null;
    }
  },
};
