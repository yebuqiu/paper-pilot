/* PaperPilot 分类条目统计：递归统计当前分类（含子分类）的条目数
 * 0.46.0 起「与进度联动的统计」：统计同时汇总阅读状态分布（未读/在读/已读标签）
 * 与「有位置进度记录」的条目数（ReadingProgress 快照），一眼看出这个分类读了多少。
 */
/* global Zotero, Services, I18n, ReadingProgress, ReadingState */

var CollectionStats = {
  /** 递归计数，返回 {total, lines:[{depth, name, count}]}；0.46.0 顺路聚合阅读分布 */
  _count(col, depth, lines, reading) {
    let items = [];
    try { items = col.getChildItems() || []; } catch (e) { /* ignore */ }
    let total = items.length;
    // 0.46.0 阅读分布（统计入口是用户显式点击，逐条读标签可接受；不在渲染路径）
    if (reading) {
      for (const item of items) {
        try {
          if (!item || !item.isRegularItem || !item.isRegularItem()) continue;
          const state = (typeof ReadingState !== "undefined" && ReadingState)
            ? ReadingState.getState(item) : "";
          if (state) reading.states[state] = (reading.states[state] || 0) + 1;
          if (typeof ReadingProgress !== "undefined" && ReadingProgress
            && ReadingProgress.entryOf(item.key)) reading.progress++;
        } catch (e) { /* 单条失败不拖垮统计 */ }
      }
    }
    let children = [];
    try { children = col.getChildCollections() || []; } catch (e) { /* ignore */ }
    for (const c of children) {
      total += this._count(c, depth + 1, lines, reading);
    }
    lines.push({ depth, name: col.name || "", own: items.length, total });
    return total;
  },

  /** 取当前选中分类（Z10 单数 getter 已废弃会抛错，用复数 API） */
  _getSelectedCollection(zp) {
    try {
      if (zp.getSelectedCollections) {
        const cols = zp.getSelectedCollections() || [];
        if (cols.length) return cols[0];
      }
    } catch (e) { /* ignore */ }
    try {
      if (zp.getSelectedCollection) return zp.getSelectedCollection();
    } catch (e) { /* Z10 单数 getter 抛错 */ }
    return null;
  },

  /** 0.46.0 阅读分布摘要行（无任何状态标签时返回空串，不加占位噪声） */
  _readingLine(reading, zh) {
    const parts = [];
    for (const s of ["未读", "在读", "已读"]) {
      if (reading.states[s]) parts.push(s + " " + reading.states[s]);
    }
    const prefix = zh ? "阅读情况：" : "Reading: ";
    if (reading.progress) {
      parts.push((zh ? "有阅读进度 " : "with progress ") + reading.progress);
    }
    if (!parts.length) return "";
    return "\n" + prefix + parts.join(" · ");
  },

  /** 菜单入口：对当前选中分类弹窗展示统计 */
  showForSelectedCollection() {
    const win = Zotero.getMainWindow();
    const zp = Zotero.getActiveZoteroPane();
    const col = zp && this._getSelectedCollection(zp);
    if (!col) {
      Services.prompt.alert(win, "PaperPilot",
        I18n.isZh ? "请先在左侧选中一个分类" : "Please select a collection first");
      return;
    }
    const lines = [];
    const reading = { states: {}, progress: 0 };
    this._count(col, 0, lines, reading);
    const text = lines
      .slice(0, 40)
      .map(l => `${"　".repeat(l.depth)}${l.name}：${l.own} 篇（含子分类共 ${l.total} 篇）`)
      .join("\n") + (lines.length > 40 ? `\n……（共 ${lines.length} 个分类，仅显示前 40 行）` : "")
      + this._readingLine(reading, I18n.isZh);
    Services.prompt.alert(win, "PaperPilot · " + (I18n.isZh ? "分类条目统计" : "Collection Stats"), text);
  },
};
