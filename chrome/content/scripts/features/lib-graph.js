// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 文献统计图谱报告（0.11.0，Chartero/Inciteful 品类的轻量路线）
 * 对当前分类（或整个文库）生成自包含 HTML 报告：年份分布、期刊 Top10、
 * 作者 Top10、标签 Top15、条目类型占比，纯内联 SVG 柱状图，无外部依赖，
 * 深浅主题中性配色。报告写入临时目录并调起系统浏览器。
 */
/* global Zotero, I18n */

var LibGraph = {
  /** 聚合统计 → {years, journals, authors, tags, types, total} */
  _buildStats(items) {
    const years = new Map(), journals = new Map(), authors = new Map(),
      tags = new Map(), types = new Map();
    const bump = (map, key) => { if (key) map.set(key, (map.get(key) || 0) + 1); };
    let total = 0;
    for (const item of items) {
      try {
        if (!item.isRegularItem || !item.isRegularItem()) continue;
        total++;
        const y = String((() => { try { return item.getField("date") || ""; } catch (e) { return ""; } })())
          .match(/(\d{4})/);
        bump(years, y ? y[1] : "n.d.");
        let j = "";
        try { j = item.getField("publicationTitle") || item.getField("journalAbbreviation") || ""; } catch (e) { /* ignore */ }
        bump(journals, j.trim() || "(no journal)");
        try {
          for (const c of (item.getCreators() || []).slice(0, 5)) {
            bump(authors, (c.fieldMode === 1 ? c.lastName : c.lastName || c.firstName) || "");
          }
        } catch (e) { /* ignore */ }
        try {
          for (const t of item.getTags()) bump(tags, t.tag);
        } catch (e) { /* ignore */ }
        let tn = "";
        try { tn = Zotero.ItemTypes.getName(item.itemTypeID) || ""; } catch (e) { /* ignore */ }
        bump(types, tn);
      } catch (e) { /* 单条失败跳过 */ }
    }
    const sortDesc = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]);
    return {
      years: [...years.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1),
      journals: sortDesc(journals).slice(0, 10),
      authors: sortDesc(authors).slice(0, 10),
      tags: sortDesc(tags).slice(0, 15),
      types: sortDesc(types),
      total,
    };
  },

  /** 横向条形图 SVG（自包含，中性配色） */
  _barSvg(entries, opts = {}) {
    const rowH = 22, labelW = opts.labelW || 180, barMax = 320, padTop = 8;
    const max = Math.max(1, ...entries.map((e) => e[1]));
    const h = padTop + entries.length * rowH + 4;
    const w = labelW + barMax + 60;
    const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    let rows = "";
    entries.forEach(([label, count], i) => {
      const y = padTop + i * rowH;
      const bw = Math.max(2, Math.round(count / max * barMax));
      const short = String(label).length > 24 ? String(label).slice(0, 23) + "…" : label;
      rows += `<text x="${labelW - 8}" y="${y + 15}" text-anchor="end" font-size="12" fill="#555">${esc(short)}</text>` +
        `<rect x="${labelW}" y="${y + 4}" width="${bw}" height="14" rx="3" fill="#4a7dbd"/>` +
        `<text x="${labelW + bw + 6}" y="${y + 15}" font-size="12" fill="#555">${count}</text>`;
    });
    return `<svg viewBox="0 0 ${w} ${h}" style="max-width:100%;height:auto">${rows}</svg>`;
  },

  /** 年份分布（竖向柱状，X 轴年份） */
  _yearSvg(entries) {
    const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const w = Math.max(300, entries.length * 34 + 40), h = 180, base = 150;
    const max = Math.max(1, ...entries.map((e) => e[1]));
    let bars = "";
    entries.forEach(([year, count], i) => {
      const x = 20 + i * 34;
      const bh = Math.max(2, Math.round(count / max * 120));
      bars += `<rect x="${x}" y="${base - bh}" width="26" height="${bh}" rx="3" fill="#4a7dbd"/>` +
        `<text x="${x + 13}" y="${base + 14}" text-anchor="middle" font-size="10" fill="#666">${esc(String(year).slice(2))}</text>` +
        `<text x="${x + 13}" y="${base - bh - 4}" text-anchor="middle" font-size="10" fill="#555">${count}</text>`;
    });
    return `<svg viewBox="0 0 ${w} ${h}" style="max-width:100%;height:auto">${bars}</svg>`;
  },

  /** 生成完整 HTML 报告 */
  buildHtml(stats, scopeName) {
    const zh = I18n.isZh;
    const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const section = (title, svg) =>
      `<section><h2>${title}</h2>${svg}</section>`;
    return `<!DOCTYPE html>
<html lang="${zh ? "zh-CN" : "en"}"><head><meta charset="utf-8">
<title>Papilot · ${zh ? "文献统计图谱" : "Library Report"}</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:24px;background:#f7f7f8;color:#222}
h1{font-size:20px;margin:0 0 4px} .sub{color:#777;font-size:13px;margin-bottom:20px}
section{background:#fff;border:1px solid #e3e3e6;border-radius:10px;padding:16px 20px;margin-bottom:16px}
h2{font-size:15px;margin:0 0 10px;color:#333}
@media (prefers-color-scheme: dark){
body{background:#1c1c1f;color:#ddd} section{background:#26262a;border-color:#3a3a40}
h2{color:#ddd} svg text{fill:#bbb}}
</style></head><body>
<h1>Papilot · ${zh ? "文献统计图谱" : "Library Report"}</h1>
<div class="sub">${esc(scopeName)} · ${zh ? "共 " : ""}${stats.total}${zh ? " 篇 · 生成于 " : " items · "}${new Date().toLocaleString()}</div>
${section(zh ? "年份分布" : "By year", this._yearSvg(stats.years))}
${section(zh ? "期刊 Top10" : "Top journals", this._barSvg(stats.journals))}
${section(zh ? "作者 Top10" : "Top authors", this._barSvg(stats.authors))}
${section(zh ? "标签 Top15" : "Top tags", this._barSvg(stats.tags))}
${section(zh ? "条目类型" : "Item types", this._barSvg(stats.types))}
</body></html>`;
  },

  /** 菜单入口（分类右键 / 工具菜单均可用） */
  async run() {
    const zh = I18n.isZh;
    let items = [];
    let scopeName = zh ? "整个文库" : "My Library";
    try {
      const zp = Zotero.getActiveZoteroPane();
      const col = zp && ((zp.getSelectedCollections && (zp.getSelectedCollections() || [])[0]) ||
        (zp.getSelectedCollection && zp.getSelectedCollection()));
      if (col) {
        try { scopeName = col.name || scopeName; } catch (e) { /* ignore */ }
        items = col.getChildItems ? (col.getChildItems() || []) : [];
      } else {
        items = await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, true);
      }
    } catch (e) {
      Zotero.logError(e);
    }
    if (!items.length) {
      try {
        const pw0 = new Zotero.ProgressWindow({ closeOnClick: true });
        pw0.changeHeadline("Papilot");
        const p0 = new pw0.ItemProgress("chrome://papilot/content/icons/chat.svg",
          zh ? "范围内没有条目" : "No items in scope");
        p0.setProgress(100);
        pw0.show();
        pw0.startCloseTimer(2500);
      } catch (e) { /* ignore */ }
      return;
    }

    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("Papilot · " + I18n.t("menuLibGraph"));
    const progress = new pw.ItemProgress("chrome://papilot/content/icons/chat.svg",
      zh ? "生成统计报告…" : "Building report…");
    pw.show();

    try {
      const stats = this._buildStats(items);
      const html = this.buildHtml(stats, scopeName);
      const tmp = Zotero.getTempDirectory();
      tmp.append("papilot-libgraph.html");
      await Zotero.File.putContentsAsync(tmp.path, html);
      progress.setProgress(100);
      try { Zotero.launchFile(tmp.path); } catch (e) {
        // 启动失败兜底：提示路径
        progress.setText(tmp.path);
      }
    } catch (e) {
      progress.setError();
      Zotero.logError(e);
    }
    pw.startCloseTimer(2500);
  },
};
