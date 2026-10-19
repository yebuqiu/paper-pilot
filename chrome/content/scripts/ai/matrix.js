// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot AI 文献矩阵：多篇文献按维度抽取 → 对比表格 + 比较分析笔记 */
/* global Zotero, Services, Prefs, AIChat, AIClient, Notes, I18n, ItemSel */

var Matrix = {
  DIMS: ["研究问题", "研究方法", "数据/材料", "主要结论", "局限与展望"],

  _extractPrompt() {
    // 0.38.0：要求用论文原文的关键词与数字，避免各篇行文风格不一致影响横向对比
    return "请基于这篇论文，严格按以下五行格式输出（每行一个维度，维度名加中文冒号开头，" +
      "每行不超过 60 字，用论文原文的关键词与数字，不要输出任何其他内容）：\n" +
      this.DIMS.map(d => `${d}：…`).join("\n");
  },

  /** 从单行式回复中解析五个维度 */
  _parseDims(text) {
    const out = {};
    const lines = String(text || "").split(/\r?\n/);
    for (const dim of this.DIMS) {
      out[dim] = "-";
      const re = new RegExp("^\\s*[*#>\\-\\s]*" + dim.replace("/", "\\/") + "\\s*[:：]\\s*(.+)$");
      for (const line of lines) {
        const m = line.match(re);
        if (m) { out[dim] = m[1].trim().replace(/\|/g, "¦").slice(0, 120); break; }
      }
    }
    return out;
  },

  _cell(s) {
    return String(s || "-").replace(/\|/g, "¦").replace(/\s*\n+\s*/g, " ").trim() || "-";
  },

  /** 菜单入口 */
  async forSelected() {
    const zp = Zotero.getActiveZoteroPane();
    if (!zp) return;
    const items = ItemSel.regularOnly(zp.getSelectedItems() || []);
    if (items.length < 2) {
      Services.prompt.alert(Zotero.getMainWindow(), "Papilot",
        I18n.isZh ? "请至少选中 2 篇文献" : "Select at least 2 items");
      return;
    }
    const max = Number(Prefs.get("matrixMaxItems", 8)) || 8;
    if (items.length > max) {
      Services.prompt.alert(Zotero.getMainWindow(), "Papilot",
        I18n.isZh ? `一次最多处理 ${max} 篇（可在设置中调整）` : `Max ${max} items per run`);
      return;
    }
    if (!AIClient.hasKey()) {
      Services.prompt.alert(Zotero.getMainWindow(), "Papilot", I18n.t("chatNoKey"));
      return;
    }

    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("Papilot · " + I18n.t("noteMatrixTitle"));
    const progress = new pw.ItemProgress(
      "chrome://papilot/content/icons/chat.svg",
      `${items.length} 篇 · ${I18n.t("matrixBusy")}`
    );
    pw.show();

    try {
      // 1. 逐篇抽取维度（全文优先，无全文回退摘要）
      const rows = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        let title = "";
        try { title = item.getDisplayTitle() || ""; } catch (e) { /* ignore */ }
        try {
          const reply = await AIChat.askTask(item, this._extractPrompt());
          rows.push({ title, dims: this._parseDims(reply) });
        } catch (e) {
          Zotero.logError(e);
          const dims = {};
          for (const d of this.DIMS) dims[d] = "(抽取失败)";
          rows.push({ title, dims });
        }
        progress.setProgress(Math.round((i + 1) / (items.length + 1) * 100));
      }

      // 2. 拼对比表
      const header = "| 维度 | " + rows.map((r, i) => this._cell(`${i + 1}. ${r.title}`.slice(0, 24))).join(" | ") + " |";
      const sep = "|" + " --- |".repeat(rows.length + 1);
      const body = this.DIMS.map(d =>
        "| **" + d + "** | " + rows.map(r => this._cell(r.dims[d])).join(" | ") + " |"
      );
      let md = [header, sep, ...body].join("\n");

      // 3. 比较分析（最后一次 AI 调用）
      try {
        const synthesis = await AIClient.chat([
          { role: "system", content: Prefs.get("aiSystemPrompt", "") || "" },
          { role: "user", content:
            "以下是多篇文献的维度对比表（Markdown）。请用中文写 200-300 字的比较分析：" +
            "研究问题与脉络如何演进；方法与数据上的共识与分歧（分歧点说清楚在哪）；" +
            "结论之间有无冲突；综合来看还留有哪些空白。以观点组织，表格行作证据，不要逐篇复述。\n\n" + md },
        ]);
        md += "\n\n## 比较分析\n\n" + synthesis;
      } catch (e) {
        Zotero.logError(e);
      }

      // 4. 写笔记（挂在第一篇下）
      const firstTitle = rows[0] ? rows[0].title : "";
      await Notes.createFromMarkdown(
        items[0],
        `${I18n.t("noteMatrixTitle")}｜${items.length} 篇（起自 ${firstTitle.slice(0, 20)}）`,
        md
      );
      progress.setProgress(100);
    } catch (e) {
      progress.setError();
      Zotero.logError(e);
    }
    pw.startCloseTimer(3000);
  },
};
