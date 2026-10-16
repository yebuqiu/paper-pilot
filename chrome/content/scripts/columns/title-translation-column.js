/* PaperPilot 标题译文列
 * 数据源：条目 extra 中的「PP Title Translation: <译文>」行
 * （由 ai/translate-writeback.js 在「翻译标题与摘要」成功后写回）。
 * 无该行则留空。注册/注销/pref 开关与 rank-column.js 完全同构：
 * main.js 按 pref titleTranslationColumnEnabled 调 register/unregister。
 */
/* global Zotero, Prefs, I18n, TranslateX */

var TitleTranslationColumn = {
  COLUMN_KEY: "paperpilot-titleTranslation",
  _registered: false,

  _enabled() {
    return !!Prefs.get("titleTranslationColumnEnabled", true);
  },

  /** 读 extra 中的标题译文行；TranslateX 未加载时本地兜底解析（列自给自足） */
  lookup(item) {
    if (!item || !item.isRegularItem || !item.isRegularItem()) return "";
    if (!this._enabled()) return "";
    let extra = "";
    try { extra = item.getField("extra") || ""; } catch (e) { return ""; }
    if (typeof TranslateX !== "undefined" && TranslateX) {
      return TranslateX.readLine(extra, TranslateX.TITLE_PREFIX);
    }
    const prefix = "PP Title Translation:";
    for (const line of extra.split(/\r?\n/)) {
      if (line.slice(0, prefix.length) === prefix) return line.slice(prefix.length).trim();
    }
    return "";
  },

  /** 单元格悬停详情：标题译文 + 摘要译文（若有） */
  lookupDetail(item) {
    if (!item || !item.isRegularItem || !item.isRegularItem()) return "";
    let extra = "";
    try { extra = item.getField("extra") || ""; } catch (e) { return ""; }
    const zh = I18n.isZh;
    let t = "", a = "";
    if (typeof TranslateX !== "undefined" && TranslateX) {
      t = TranslateX.readLine(extra, TranslateX.TITLE_PREFIX);
      a = TranslateX.readLine(extra, TranslateX.ABSTRACT_PREFIX);
    } else {
      t = this.lookup(item);
    }
    const lines = [];
    if (t) lines.push((zh ? "标题译文：" : "Title: ") + t);
    if (a) lines.push((zh ? "摘要译文：" : "Abstract: ") + a);
    return lines.join("\n");
  },

  async register(pluginID) {
    if (this._registered) return;
    await Zotero.ItemTreeManager.registerColumns({
      pluginID,
      dataKey: this.COLUMN_KEY,
      label: I18n.t("titleTranslationColumnLabel"),
      dataProvider: (item) => this.lookup(item),
      renderCell: (index, data, column, isFirstColumn, doc) => {
        const span = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
        span.className = `cell ${column.className}`;
        if (data) {
          span.textContent = String(data);
          // 译文是辅助信息：弱一档颜色与正标题区分
          span.style.cssText = "color:var(--fill-secondary,#666);";
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
