/* PaperPilot 批注收集：把 PDF 高亮/批注聚合为笔记，或交给 AI 解读 */
/* global Zotero, Prefs, AIClient, Notes, I18n */

var Annotations = {
  /**
   * 收集条目所有 PDF 附件的批注
   * @returns {Array<{att: Zotero.Item, list: Array}>|null}
   */
  collect(item) {
    const atts = [];
    try {
      if (item.isRegularItem && item.isRegularItem()) {
        for (const id of item.getAttachments()) {
          const a = Zotero.Items.get(id);
          if (a && a.isPDFAttachment && a.isPDFAttachment()) atts.push(a);
        }
      } else if (item.isPDFAttachment && item.isPDFAttachment()) {
        atts.push(item);
      }
    } catch (e) { /* ignore */ }

    const groups = [];
    for (const att of atts) {
      let ann = [];
      try { ann = att.getAnnotations() || []; } catch (e) { /* ignore */ }
      const list = [];
      for (const a of ann) {
        try {
          const text = a.annotationText || "";
          let comment = a.annotationComment || "";
          // 剥离划词浮窗写入的 pp:tr 标记（保留标记内译文正文；reader-popup.js B2）
          if (typeof ReaderPopup !== "undefined" && ReaderPopup && ReaderPopup._stripMarked) {
            comment = ReaderPopup._stripMarked(comment);
          }
          if (!text.trim() && !comment.trim()) continue;
          list.push({
            type: a.annotationType || "highlight",
            text: text.trim(),
            comment: comment.trim(),
            page: a.annotationPageLabel || "",
            sort: a.annotationSortIndex || "",
          });
        } catch (e) { /* 单条批注读取失败跳过 */ }
      }
      if (list.length) {
        list.sort((x, y) => (x.sort < y.sort ? -1 : x.sort > y.sort ? 1 : 0));
        groups.push({ att, list });
      }
    }
    return groups.length ? groups : null;
  },

  /** 批注 → Markdown */
  toMarkdown(item, groups) {
    let paperTitle = "";
    try { paperTitle = item.getDisplayTitle() || ""; } catch (e) { /* ignore */ }
    let total = 0;
    const parts = [`**${paperTitle}**\n`];
    for (const g of groups) {
      if (groups.length > 1) {
        let attName = "";
        try { attName = g.att.getDisplayTitle() || ""; } catch (e) { /* ignore */ }
        if (attName) parts.push(`\n### 附件：${attName}`);
      }
      for (const a of g.list) {
        total++;
        const pageTag = a.page ? `（第 ${a.page} 页）` : "";
        if (a.text) parts.push(`\n> ${a.text.replace(/\n+/g, " ")} ${pageTag}`);
        if (a.comment) parts.push(`\n备注：${a.comment}`);
      }
    }
    parts.push(`\n\n---\n共 ${total} 条批注`);
    return parts.join("\n");
  },

  /** 菜单：收集批注为笔记 */
  async collectToNote(item) {
    const groups = this.collect(item);
    if (!groups) throw new Error("NO_ANNOTATIONS");
    let paperTitle = "";
    try { paperTitle = item.getDisplayTitle() || ""; } catch (e) { /* ignore */ }
    return Notes.createFromMarkdown(
      item,
      `${I18n.t("noteAnnotTitle")}｜${paperTitle}`,
      this.toMarkdown(item, groups)
    );
  },

  /** 菜单：AI 解读批注（这些重点反映了什么） */
  async aiInterpret(item) {
    const groups = this.collect(item);
    if (!groups) throw new Error("NO_ANNOTATIONS");
    const md = this.toMarkdown(item, groups);
    const meta = (() => {
      const get = (f) => { try { return item.getField(f) || ""; } catch (e) { return ""; } };
      return { title: get("title"), pub: get("publicationTitle"), year: get("date").slice(0, 4) };
    })();
    const system = (Prefs.get("aiSystemPrompt", "") || "") +
      `\n\n用户正在阅读论文《${meta.title}》（${meta.pub} ${meta.year}）。` +
      "下面给出用户在 PDF 中划出的全部高亮与批注。请基于这些内容回答，不要编造论文其他部分的信息。";
    const q =
      "以上是我在读这篇论文时划出的所有重点与批注。请解读：\n" +
      "1) 主线：这些重点合起来勾勒出论文的哪条论证链——从问题到结论是怎么走的；\n" +
      "2) 关注点：我的批注集中在哪些问题上，反映出什么阅读意图或疑问；\n" +
      "3) 下一步：基于这些重点给我 3 条可执行的建议（该精读哪部分、该补哪方面文献、可沿哪个方向深挖）。\n" +
      "只依据这些划线与批注解读，不要推测论文其他部分的内容。\n\n" +
      md;
    return AIClient.chat([
      { role: "system", content: system },
      { role: "user", content: q },
    ]);
  },
};
