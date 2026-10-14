/* PaperPilot AI 自动打标签：AI 建议 #类别/名称 层级标签，弹窗勾选后写入 */
/* global Zotero, Services, Prefs, AIClient, I18n, ItemSel */

var AutoTag = {
  /** 从 AI 回复中解析 #标签（容错：直接抓 # 开头的 token；模型不带 # 时按行兜底） */
  _parseTags(text) {
    const seen = new Set();
    const tags = [];
    const push = (t) => {
      t = String(t || "").trim().replace(/[.。,，;；]+$/, "");
      if (!t) return;
      if (t[0] !== "#") t = "#" + t;
      if (t.length < 3 || t.length > 40) return;
      if (!seen.has(t)) { seen.add(t); tags.push(t); }
    };
    const raw = String(text || "");
    // 第一遍：抓 # 开头的 token（兼容行内混排）
    const found = raw.match(/#[^\s，,;；。、"'“”‘’()（）\[\]]+/g) || [];
    for (const t of found) push(t);
    // 第二遍（兜底）：模型没按格式输出 # 时，按行解析（去编号/项目符号/代码围栏）
    if (!tags.length) {
      for (let line of raw.split(/\r?\n/)) {
        line = line.trim();
        if (!line || /^```/.test(line)) continue;
        line = line.replace(/^(?:[-*•·]|\d+[.、)）])\s*/, "").trim();
        line = line.replace(/^(?:标签|tags?)\s*[:：]\s*/i, "").trim();
        // 行内可能有多个标签（顿号/逗号分隔）
        for (const part of line.split(/[、,，;；]/)) push(part);
      }
    }
    const max = Number(Prefs.get("autoTagMax", 6)) || 6;
    return tags.slice(0, Math.max(max, 6)); // 多解析一些供勾选
  },

  /** 为单个条目建议标签 */
  async suggest(item) {
    const get = (f) => { try { return item.getField(f) || ""; } catch (e) { return ""; } };
    const title = get("title");
    const abstract = get("abstractNote");
    const pub = get("publicationTitle");
    if (!title && !abstract) throw new Error("NO_META");
    const max = Number(Prefs.get("autoTagMax", 6)) || 6;
    // 0.38.0：粒度约束（具体到子领域）+ 禁宽泛词 + 同概念唯一——提升检索价值
    const q =
      "请为以下论文建议不超过 " + max + " 个标签，用于文献管理与检索。要求：\n" +
      "1) 每个标签形如 #类别/名称，类别从「领域、方法、主题、数据、理论」中选（不适用的类别不要勉强）；\n" +
      "2) 名称要具体到子领域或具体技术（如 #领域/图神经网络 而不是 #领域/计算机；#方法/双重差分 而不是 #方法/计量）；\n" +
      "3) 禁止过于宽泛的标签（如 #研究、#论文、#科学）；同一概念只给一个标签；\n" +
      "4) 标签用中文，专有名词可保留英文；\n" +
      "5) 每行只输出一个标签，不要编号、不要解释、不要输出任何其他内容。\n\n" +
      `标题：${title}\n期刊：${pub}\n摘要：${abstract || "（无）"}`;
    const reply = await AIClient.chat([
      { role: "system", content: Prefs.get("aiSystemPrompt", "") || "" },
      { role: "user", content: q },
    ]);
    try { Zotero.debug("[PaperPilot] AutoTag AI raw reply: " + String(reply).slice(0, 500)); } catch (e) { /* ignore */ }
    const tags = this._parseTags(reply);
    if (!tags.length) throw new Error("AI 未返回有效标签（原始回复：" + String(reply || "").slice(0, 120) + "…）");
    return tags;
  },

  /** 模态弹窗让用户勾选标签；取消返回 null */
  pickTags(tags, paperTitle) {
    const win = Zotero.getMainWindow();
    if (!win) return null;
    const io = { tags, paperTitle, selected: null };
    win.openDialog(
      "chrome://paperpilot/content/tag-preview.xhtml",
      "paperpilot-tag-preview",
      "chrome,modal,centerscreen,resizable",
      io
    );
    return io.selected;
  },

  /** 菜单入口：为选中条目逐个建议并写入 */
  async runForSelected() {
    const zp = Zotero.getActiveZoteroPane();
    if (!zp) return;
    const items = ItemSel.regularOnly(zp.getSelectedItems() || []);
    if (!items.length) {
      ItemSel.alertEmpty();
      return;
    }
    if (!AIClient.hasKey()) {
      Services.prompt.alert(Zotero.getMainWindow(), "PaperPilot", I18n.t("chatNoKey"));
      return;
    }

    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("PaperPilot");
    pw.show();

    for (const item of items) {
      let title = "";
      try { title = item.getDisplayTitle() || ""; } catch (e) { /* ignore */ }
      const progress = new pw.ItemProgress("chrome://paperpilot/content/icons/chat.svg", title);
      try {
        progress.setProgress(30);
        const tags = await this.suggest(item);
        const selected = this.pickTags(tags, title);
        if (selected === null) {
          progress.setText(I18n.isZh ? "已取消" : "Cancelled");
          progress.setProgress(100);
          continue;
        }
        if (selected.length) {
          for (const t of selected) item.addTag(t);
          await item.saveTx();
        }
        progress.setText(`${I18n.t("tagApplyDone")} ${selected.length} 个`);
        progress.setProgress(100);
      } catch (e) {
        progress.setError();
        try { progress.setText(String((e && e.message) || e).slice(0, 120)); } catch (_) { /* ignore */ }
        Zotero.logError(e);
      }
    }
    pw.startCloseTimer(2500);
  },
};
