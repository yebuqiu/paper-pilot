// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 元数据规范清洗（0.11.0，Linter for Zotero 品类的轻量路线）
 * 安全规则（只规范化格式，不改语义，不产生信息丢失）：
 *   1. DOI：去 https://doi.org/、doi: 前缀，转小写
 *   2. 日期：2024/3/5、2024.3.5 → 2024-03-05；仅年份保持不变
 *   3. 标题：去除末尾多余句点（. 。）
 *   4. URL：去除 utm_* 等跟踪参数
 * 每条规则报告命中数，全部可逆（原始值在日志中可查）。
 */
/* global Zotero, I18n, ItemSel */

var MetaLint = {
  RULES: [
    {
      id: "doi",
      label: "DOI 规范化",
      field: "DOI",
      fix(v) {
        const nv = String(v || "").trim()
          .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
          .replace(/^doi:\s*/i, "")
          .toLowerCase();
        return nv !== String(v).trim() ? nv : null;
      },
    },
    {
      id: "date",
      label: "日期格式统一",
      field: "date",
      fix(v) {
        const s = String(v || "").trim();
        const m = s.match(/^(\d{4})[/.\s](\d{1,2})(?:[/.\s](\d{1,2}))?/);
        if (!m) return null;
        const y = m[1], mo = String(m[2]).padStart(2, "0");
        if (Number(mo) < 1 || Number(mo) > 12) return null;
        let nv = y + "-" + mo;
        if (m[3]) {
          const d = String(m[3]).padStart(2, "0");
          if (Number(d) < 1 || Number(d) > 31) return null;
          nv += "-" + d;
        }
        return nv !== s ? nv : null;
      },
    },
    {
      id: "title",
      label: "标题末尾句点",
      field: "title",
      fix(v) {
        const nv = String(v || "").replace(/[.。．\s]+$/, "");
        return nv && nv !== v ? nv : null;
      },
    },
    {
      id: "url",
      label: "URL 跟踪参数",
      field: "url",
      fix(v) {
        const s = String(v || "").trim();
        if (!/[?&]utm_|&fbclid=|[?&]fbclid=|&gclid=|[?&]gclid=/.test(s)) return null;
        try {
          const u = new URL(s);
          for (const k of [...u.searchParams.keys()]) {
            if (/^(utm_|fbclid|gclid)/.test(k)) u.searchParams.delete(k);
          }
          const nv = u.toString();
          return nv !== s ? nv : null;
        } catch (e) {
          return null;
        }
      },
    },
  ],

  /** 扫描单条目 → [{rule, field, from, to}]（不写入） */
  scan(item) {
    const hits = [];
    for (const rule of this.RULES) {
      let from;
      try { from = item.getField(rule.field) || ""; } catch (e) { continue; }
      if (!from) continue;
      const to = rule.fix(from);
      if (to != null) hits.push({ rule: rule.id, field: rule.field, from, to });
    }
    return hits;
  },

  /** 应用单条修复 */
  async applyHit(item, hit) {
    item.setField(hit.field, hit.to);
    await item.saveTx();
  },

  /** 菜单入口：扫描 + 直接修复（规则均为格式规范化，无信息丢失） */
  async runForSelected() {
    const zp = Zotero.getActiveZoteroPane();
    if (!zp) return;
    const items = ItemSel.regularOnly(zp.getSelectedItems() || []);
    if (!items.length) { ItemSel.alertEmpty(); return; }

    const zh = I18n.isZh;
    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("Papilot · " + I18n.t("menuMetaLint"));
    pw.show();
    const counts = {};
    let nItems = 0;

    for (const item of items) {
      let title = "";
      try { title = item.getDisplayTitle() || ""; } catch (e) { /* ignore */ }
      const progress = new pw.ItemProgress("chrome://papilot/content/icons/chat.svg", title);
      try {
        progress.setProgress(50);
        const hits = this.scan(item);
        if (!hits.length) {
          progress.setText(zh ? "规范，无需处理" : "Clean");
        } else {
          for (const hit of hits) {
            await this.applyHit(item, hit);
            counts[hit.rule] = (counts[hit.rule] || 0) + 1;
            Zotero.debug(`Papilot lint [${hit.rule}] ${hit.from} -> ${hit.to}`);
          }
          nItems++;
          progress.setText((zh ? "已修复 " : "Fixed ") + hits.length +
            (zh ? " 处" : " field(s)"));
        }
        progress.setProgress(100);
      } catch (e) {
        progress.setError();
        Zotero.logError(e);
      }
    }
    const detail = this.RULES.filter((r) => counts[r.id])
      .map((r) => `${r.label}×${counts[r.id]}`).join("、");
    const summary = new pw.ItemProgress("chrome://papilot/content/icons/chat.svg",
      (zh ? "完成：" : "Done: ") + (detail || (zh ? "全部规范" : "all clean")));
    summary.setProgress(100);
    pw.startCloseTimer(4000);
  },
};
