/* PaperPilot AI 文献综述（0.11.0，文献矩阵的延伸）
 * 选中多篇 → 逐篇取摘要（无摘要回退全文首段）→ 一次性 AI 生成
 * 带引用编号 [1][2] 的综述段落 + 文献清单笔记。
 * 与 Matrix 的区别：矩阵是维度对比表，综述是连贯的学术段落。
 */
/* global Zotero, Services, Prefs, AIChat, AIClient, Notes, I18n, ItemSel */

var ReviewGen = {
  /** 拼综述材料：[编号] 标题（作者, 年份）+ 摘要/首段 */
  async _buildMaterial(items) {
    const blocks = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const get = (f) => { try { return item.getField(f) || ""; } catch (e) { return ""; } };
      let creators = "";
      try {
        creators = (item.getCreators() || []).slice(0, 3)
          .map((c) => c.fieldMode === 1 ? c.lastName : c.lastName || c.firstName).join(", ");
      } catch (e) { /* ignore */ }
      let body = String(get("abstractNote") || "").trim();
      if (!body) {
        try {
          const ft = await AIChat.getFullText(item);
          if (ft) body = ft.slice(0, 1500);
        } catch (e) { /* ignore */ }
      }
      blocks.push({
        n: i + 1,
        cite: `${creators || "Anon"} (${String(get("date")).slice(0, 4) || "n.d."})`,
        title: get("title") || "(untitled)",
        body: body.slice(0, 2000),
      });
    }
    return blocks;
  },

  _prompt(blocks) {
    const list = blocks.map((b) => `[${b.n}] ${b.cite}. ${b.title}\n${b.body}`).join("\n\n");
    // 0.38.0：以观点为单位组织（反流水账）+ 分歧点说清楚 + 冲突如实呈现
    return "以下是若干篇文献的题录与摘要材料。请用中文写一篇 600-900 字的文献综述。要求：\n" +
      "1) 以观点为单位组织，按主题或脉络分 2-4 块；文献引用只作证据（编号如 [1][3]），" +
      "不要写成「某某研究了什么」的逐篇流水账；\n" +
      "2) 结构：研究背景与问题 → 方法与证据的比较（各路的适用条件与差异）→ " +
      "共识与分歧（分歧要指出分歧点具体在哪）→ 研究空白与未来方向；\n" +
      "3) 只基于所给材料，不编造；不同材料结论冲突时如实呈现冲突，不要强行调和。\n\n" + list;
  },

  /** 菜单入口 */
  async forSelected() {
    const zp = Zotero.getActiveZoteroPane();
    if (!zp) return;
    const items = ItemSel.regularOnly(zp.getSelectedItems() || []);
    if (items.length < 2) {
      Services.prompt.alert(Zotero.getMainWindow(), "PaperPilot",
        I18n.isZh ? "请至少选中 2 篇文献" : "Select at least 2 items");
      return;
    }
    const max = Number(Prefs.get("matrixMaxItems", 8)) || 8;
    if (items.length > max) {
      Services.prompt.alert(Zotero.getMainWindow(), "PaperPilot",
        I18n.isZh ? `一次最多处理 ${max} 篇（可在设置中调整）` : `Max ${max} items per run`);
      return;
    }
    if (!AIClient.hasKey()) {
      Services.prompt.alert(Zotero.getMainWindow(), "PaperPilot", I18n.t("chatNoKey"));
      return;
    }

    const zh = I18n.isZh;
    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("PaperPilot · " + I18n.t("noteReviewTitle"));
    const progress = new pw.ItemProgress("chrome://paperpilot/content/icons/chat.svg",
      `${items.length} 篇`);
    pw.show();

    try {
      progress.setText(zh ? "收集文献材料…" : "Collecting material…");
      progress.setProgress(20);
      const blocks = await this._buildMaterial(items);

      progress.setText(zh ? "AI 撰写综述…" : "Writing review…");
      progress.setProgress(50);
      const review = await AIClient.chat([
        { role: "system", content: Prefs.get("aiSystemPrompt", "") || "" },
        { role: "user", content: this._prompt(blocks) },
      ]);

      const refList = blocks.map((b) => `${b.n}. ${b.cite}. ${b.title}`).join("\n");
      const md = review + "\n\n---\n\n## " + (zh ? "参考文献" : "References") + "\n\n" + refList;
      await Notes.createFromMarkdown(items[0],
        `${I18n.t("noteReviewTitle")}｜${items.length} 篇`, md);
      progress.setProgress(100);
    } catch (e) {
      progress.setError();
      progress.setText((zh ? "出错：" : "Error: ") + String(e && e.message || e).slice(0, 80));
      Zotero.logError(e);
    }
    pw.startCloseTimer(3500);
  },
};
