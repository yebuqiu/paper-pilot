// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 阅读状态管理（0.11.0，Reading List 品类）
 * 三个互斥标签：未读 / 在读 / 已读。
 * ① 右键菜单手动标记（批量）；
 * ② 新条目入库自动打「未读」（Notifier item/add，pref 开关）；
 * ③ 打开 PDF 自动「未读→在读」（Notifier tab 事件，Z10 API 未实证，
 *    全程 try/catch 静默降级——拿不到 tab 事件时该路径自动失效，不影响前两条）。
 */
/* global Zotero, Prefs, I18n, ItemSel */

var ReadingState = {
  STATES: ["未读", "在读", "已读"],
  _notifierID: null,
  _tabNotifierID: null,

  /** 读取当前状态（无标签返回 ""） */
  getState(item) {
    try {
      const tags = item.getTags().map((t) => t.tag);
      for (const s of this.STATES) if (tags.includes(s)) return s;
    } catch (e) { /* ignore */ }
    return "";
  },

  /** 设置状态：清空三个互斥标签后打上新标签（state="" 表示仅清除） */
  async setState(item, state) {
    for (const s of this.STATES) {
      try { item.removeTag(s); } catch (e) { /* ignore */ }
    }
    if (state && this.STATES.includes(state)) {
      try { item.addTag(state); } catch (e) { /* ignore */ }
    }
    await item.saveTx();
  },

  /** 菜单：对选中条目批量标记 */
  async markForSelected(state) {
    const zp = Zotero.getActiveZoteroPane();
    if (!zp) return;
    const items = ItemSel.regularOnly(zp.getSelectedItems() || []);
    if (!items.length) { ItemSel.alertEmpty(); return; }
    let n = 0;
    for (const item of items) {
      try { await this.setState(item, state); n++; } catch (e) { Zotero.logError(e); }
    }
    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("Papilot · " + I18n.t("menuReadingState"));
    const progress = new pw.ItemProgress("chrome://papilot/content/icons/chat.svg",
      (I18n.isZh ? "已标记 " : "Marked ") + n + (I18n.isZh ? " 篇为「" : " as '") + state +
      (I18n.isZh ? "」" : "'"));
    progress.setProgress(100);
    pw.show();
    pw.startCloseTimer(2200);
  },

  /* ---------- 自动化 ---------- */

  _onNewItems(ids) {
    if (!Prefs.get("readingStateAutoUnread", true)) return;
    for (const id of ids) {
      (async () => {
        try {
          const item = await Zotero.Items.getAsync(id);
          if (!item || !item.isRegularItem || !item.isRegularItem() || item.deleted) return;
          if (this.getState(item)) return; // 已有状态不打断
          item.addTag("未读");
          await item.saveTx();
        } catch (e) { /* 条目可能已被删除 */ }
      })();
    }
  },

  _onTab(event, ids) {
    // tab 事件（Z7+ 部分版本提供）：打开 PDF → 未读→在读
    if (event !== "open" && event !== "select") return;
    for (const tabID of ids || []) {
      (async () => {
        try {
          const reader = Zotero.Reader.getByTabID(tabID);
          const itemID = reader && reader.itemID;
          if (!itemID) return;
          let item = Zotero.Items.get(itemID);
          if (item && item.isAttachment && item.isAttachment() && item.parentItemID) {
            item = Zotero.Items.get(item.parentItemID);
          }
          if (!item || !item.isRegularItem || !item.isRegularItem()) return;
          if (this.getState(item) === "未读") await this.setState(item, "在读");
        } catch (e) { /* tab API 不存在时静默 */ }
      })();
    }
  },

  register() {
    if (this._notifierID) return;
    this._notifierID = Zotero.Notifier.registerObserver({
      notify: (event, type, ids) => {
        try {
          if (event === "add") this._onNewItems(ids);
        } catch (e) { Zotero.logError(e); }
      },
    }, ["item"], "papilot-readingstate");
    // tab 事件注册失败不影响主流程
    try {
      this._tabNotifierID = Zotero.Notifier.registerObserver({
        notify: (event, type, ids) => {
          try { this._onTab(event, ids); } catch (e) { /* ignore */ }
        },
      }, ["tab"], "papilot-readingstate-tab");
    } catch (e) {
      this._tabNotifierID = null;
    }
  },

  unregister() {
    for (const key of ["_notifierID", "_tabNotifierID"]) {
      if (this[key]) {
        try { Zotero.Notifier.unregisterObserver(this[key]); } catch (e) { /* ignore */ }
        this[key] = null;
      }
    }
  },
};
