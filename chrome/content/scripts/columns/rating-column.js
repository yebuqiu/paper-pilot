// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 星标评级列
 * 显示 features/rating.js 存储的「★」×n 标签（0-5 星）。
 * 注册/注销/pref 开关与 rank-column.js 同构：
 * main.js 按 pref ratingColumnEnabled 调 register/unregister。
 */
/* global Zotero, Prefs, I18n, Rating */

var RatingColumn = {
  COLUMN_KEY: "papilot-rating",
  _registered: false,

  _enabled() {
    return !!Prefs.get("ratingColumnEnabled", true);
  },

  /** dataProvider：0-5（数字排序）；无评级返回 "" */
  lookup(item) {
    if (!item || !item.isRegularItem || !item.isRegularItem()) return "";
    if (!this._enabled()) return "";
    if (typeof Rating === "undefined" || !Rating) return "";
    const n = Rating.get(item);
    return n > 0 ? n : "";
  },

  async register(pluginID) {
    if (this._registered) return;
    await Zotero.ItemTreeManager.registerColumns({
      pluginID,
      dataKey: this.COLUMN_KEY,
      label: I18n.t("ratingColumnLabel"),
      dataProvider: (item) => this.lookup(item),
      renderCell: (index, data, column, isFirstColumn, doc) => {
        const span = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
        span.className = `cell ${column.className}`;
        if (data !== "" && data !== null && data !== undefined) {
          span.textContent = "★".repeat(Number(data) || 0);
          span.style.cssText = "color:#e6a23c;letter-spacing:1px;";
        }
        return span;
      },
    });
    this._registered = true;
  },

  unregister() {
    if (this._registered) {
      Zotero.ItemTreeManager.unregisterColumns(this.COLUMN_KEY);
      this._registered = false;
    }
  },
};
