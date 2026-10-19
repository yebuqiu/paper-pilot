// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 星标评级（0-5 星）
 * 存储：单个「★」×n 标签（如 "★★★" = 3 星），简单可靠且标签页可直接筛选。
 * 与阅读状态的互斥标签同构：设置前先清掉所有纯星标签，n=0 表示仅清除。
 * 右键「评级 1-5 星」子菜单由主线在 menus.js 接入，本模块只提供 helper。
 */
/* global Zotero */

var Rating = {
  STAR: "★",
  MAX: 5,

  /** 纯星标签判定（"★abc" 这类用户自定义标签不算评级） */
  _isStarTag(tag) {
    return /^★+$/.test(String(tag || ""));
  },

  /** 读取评级（无星标签返回 0） */
  get(item) {
    try {
      const tags = item.getTags().map((t) => t.tag);
      for (const t of tags) {
        if (this._isStarTag(t)) return Math.min(t.length, this.MAX);
      }
    } catch (e) { /* ignore */ }
    return 0;
  },

  /**
   * 计算设置 n 星后的标签串数组（纯函数，可单测）。
   * 移除所有既有纯星标签；n>0 时追加 "★"×n；其余标签原样保留。
   */
  applyRating(tags, n) {
    const k = Math.min(this.MAX, Math.max(0, Math.round(Number(n) || 0)));
    const out = (Array.isArray(tags) ? tags : []).filter((t) => !this._isStarTag(t));
    if (k > 0) out.push(this.STAR.repeat(k));
    return out;
  },

  /**
   * 批量设置评级。
   * @param items 常规条目数组
   * @param n 0..5（0 = 清除评级）
   * @returns {Promise<number>} 实际修改的条目数
   */
  async set(items, n) {
    const k = Math.min(this.MAX, Math.max(0, Math.round(Number(n) || 0)));
    let changed = 0;
    for (const item of items || []) {
      try {
        const before = item.getTags().map((t) => t.tag);
        const after = this.applyRating(before, k);
        if (before.length === after.length && before.every((t, i) => t === after[i])) continue;
        for (const t of before) {
          if (this._isStarTag(t)) item.removeTag(t);
        }
        if (k > 0) item.addTag(this.STAR.repeat(k));
        await item.saveTx();
        changed++;
      } catch (e) {
        try { Zotero.logError(e); } catch (e2) { /* ignore */ }
      }
    }
    return changed;
  },
};
