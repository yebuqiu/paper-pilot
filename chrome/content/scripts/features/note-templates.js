// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 笔记模板系统（0.11.0，Better Notes 品类的轻量路线）
 * 模板 = 带占位符的 Markdown 骨架，对选中条目一键生成结构化笔记。
 *
 * 占位符（0.61.0 扩充）：
 *   基础   {{title}} {{creators}} {{creatorsShort}} {{year}} {{date}} {{pub}}
 *          {{journalAbbr}} {{volume}} {{issue}} {{pages}} {{publisher}} {{place}}
 *          {{doi}} {{url}} {{abstract}} {{itemType}} {{itemKey}}
 *          {{tags}}（逗号分隔） {{collections}}（逗号分隔，分类名）
 *   特殊   {{annotations}}（批注列表）  {{aiSummary}}（AI 300 字总结，失败降级摘要）
 *   条件   {{#if doi}}…{{else}}…{{/if}}     字段非空为真；{{#if !doi}} 取反
 *   循环   {{#each tags}}…{{this}}…{{/each}}  数组遍历，{{this}} 为当前项
 *   未知占位符渲染为空串（旧版会原样留在笔记里，属于静默脏数据）。
 *
 * 内置 7 套模板 + 用户自定义（pref noteTemplatesCustom，
 * 每行：名称=模板正文，正文里用 \n 表示换行）。
 * 0.39.0 起支持导出/导入：exportAll() 把自定义模板序列化成 JSON 写剪贴板，
 * importJSON() 读剪贴板 JSON、校验结构、按冲突策略（跳过/覆盖/重命名）合并入库。
 */
/* global Zotero, Services, Prefs, AIChat, AIClient, Annotations, Notes, I18n, ItemSel, Components */

var NoteTemplates = {
  builtin: [
    {
      id: "reading",
      name: "文献阅读笔记",
      body: "## {{title}}\n\n**作者**：{{creators}}　**期刊**：{{pub}}　**年份**：{{year}}\n\n" +
        "### 研究问题\n\n### 研究方法\n\n### 主要结果\n\n### 结论与启示\n\n### 批注摘录\n\n{{annotations}}\n\n### 我的评价\n",
    },
    {
      id: "card",
      name: "精读卡片",
      body: "# {{title}}\n\n> 一句话总结：\n\n**核心概念**：\n\n**金句**：\n\n{{annotations}}\n\n**可借鉴**：\n\n**待追问**：\n",
    },
    {
      id: "quick",
      name: "速读记录（AI 摘要）",
      body: "## {{title}}（{{year}}）\n\n{{aiSummary}}\n\n---\n\n### 我的备注\n",
    },
    {
      id: "review",
      name: "综述框架",
      body: "# 综述笔记：{{title}}\n\n**作者**：{{creators}}　**期刊**：{{pub}}　**年份**：{{year}}\n\n" +
        "### 1. 研究领域与背景\n\n### 2. 已有工作脉络\n\n#### 2.1 主要流派\n\n#### 2.2 关键文献\n\n" +
        "### 3. 研究空白与争议\n\n### 4. 本文的定位\n\n### 5. 可引用的表述\n\n{{annotations}}\n\n### 6. 与在读其他文献的关联\n",
    },
    {
      id: "groupmeeting",
      name: "组会汇报",
      body: "## 组会汇报：{{title}}\n\n**文献**：{{creators}}，{{pub}}（{{year}}）　DOI：{{doi}}\n\n" +
        "### 一句话讲清这篇论文\n\n### 为什么选它汇报\n\n### 方法亮点（1-2 张图）\n\n### 关键结果\n\n### 局限与质疑点\n\n### 对我们课题的启发\n\n### 讨论问题（抛给大家）\n",
    },
    {
      id: "compare",
      name: "文献对比卡",
      body: "## 对比卡：{{title}}\n\n**出处**：{{creators}}，{{pub}}（{{year}}）\n\n" +
        "| 维度 | 本文 |\n| --- | --- |\n| 研究问题 | |\n| 数据/对象 | |\n| 方法 | |\n| 核心结论 | |\n| 创新点 | |\n| 局限 | |\n\n" +
        "### 与对比文献的异同\n\n### 综合判断\n",
    },
    {
      id: "quickplus",
      name: "速读记录增强版",
      body: "## {{title}}（{{year}}）\n\n**作者**：{{creators}}　**期刊**：{{pub}}\n\n### AI 速读摘要\n\n{{aiSummary}}\n\n" +
        "### 速读判断\n\n**值得精读吗**：（值得 / 存疑 / 跳过）\n\n**理由**：\n\n### 关键词\n\n### 待办\n\n- [ ] \n",
    },
  ],

  /** 自定义模板（pref noteTemplatesCustom，行式 名称=正文）→ [{name, body}] */
  customList() {
    const out = [];
    const raw = Prefs.get("noteTemplatesCustom", "") || "";
    for (const line of String(raw).split(/\r?\n/)) {
      const idx = line.indexOf("=");
      if (idx <= 0) continue;
      const name = line.slice(0, idx).trim();
      const body = line.slice(idx + 1).trim().replace(/\\n/g, "\n");
      if (name && body) out.push({ name, body });
    }
    return out;
  },

  /** 自定义模板写回 pref（名称剥掉 = 与换行，正文换行转义为 \n） */
  saveCustom(list) {
    const lines = [];
    for (const t of Array.isArray(list) ? list : []) {
      const name = String(t && t.name || "").replace(/[=\r\n]/g, " ").trim();
      const body = String(t && t.body || "").replace(/\r\n/g, "\n").trim();
      if (!name || !body) continue;
      lines.push(name + "=" + body.replace(/\n/g, "\\n"));
    }
    Prefs.set("noteTemplatesCustom", lines.join("\n"));
    return lines.length;
  },

  all() {
    const custom = this.customList().map((t, i) => ({ id: "custom-" + i, name: t.name, body: t.body }));
    return this.builtin.concat(custom);
  },

  _annotationsMd(item) {
    try {
      const groups = Annotations.collect(item);
      if (!groups) return I18n.isZh ? "（暂无批注）" : "(no annotations)";
      const lines = [];
      for (const g of groups) {
        for (const a of g.list) {
          const page = a.page ? `（p.${a.page}）` : "";
          if (a.text) lines.push(`- ${a.text.replace(/\n+/g, " ")} ${page}`.trim());
          if (a.comment) lines.push(`  - ${a.comment}`);
        }
      }
      return lines.length ? lines.join("\n") : (I18n.isZh ? "（暂无批注）" : "(no annotations)");
    } catch (e) {
      return I18n.isZh ? "（批注读取失败）" : "(annotations unavailable)";
    }
  },

  /** 条目 → 渲染上下文（同步字段；annotations / aiSummary 由 render 按需异步补） */
  context(item) {
    const get = (f) => { try { return item.getField(f) || ""; } catch (e) { return ""; } };
    let creators = [];
    try { creators = item.getCreators() || []; } catch (e) { creators = []; }
    const names = creators.map((c) => (Number(c && c.fieldMode) === 1
      ? (c.lastName || c.name || "")
      : [c.firstName, c.lastName].filter(Boolean).join(" "))).filter(Boolean);

    let tags = [];
    try { tags = (item.getTags() || []).map((t) => t && t.tag).filter(Boolean); } catch (e) { tags = []; }

    let collections = [];
    try {
      collections = (item.getCollections() || []).map((id) => {
        try { return (Zotero.Collections.get(id) || {}).name || ""; } catch (e) { return ""; }
      }).filter(Boolean);
    } catch (e) { collections = []; }

    const date = get("date");
    return {
      title: get("title"),
      creators: names.join(", "),
      creatorsShort: names.length ? names[0] + (names.length > 1 ? (I18n.isZh ? " 等" : " et al.") : "") : "",
      year: String(date).slice(0, 4),
      date,
      pub: get("publicationTitle"),
      journalAbbr: get("journalAbbreviation"),
      volume: get("volume"),
      issue: get("issue"),
      pages: get("pages"),
      publisher: get("publisher"),
      place: get("place"),
      doi: get("DOI"),
      url: get("url"),
      abstract: get("abstractNote"),
      itemType: item.itemType || "",
      itemKey: item.key || "",
      tags,
      collections,
    };
  },

  /**
   * 纯函数渲染：循环 → 条件 → 占位符。
   * 循环体内再走一次「条件 + 占位符」，这样 {{#each tags}}{{#if this}}…{{/if}}{{/each}}
   * 才拿得到当前项（把 {{this}} 塞进临时上下文，而不是粗暴字符串替换）。
   * @param body 模板正文
   * @param ctx 上下文对象（数组值在普通占位符里按逗号连接）
   */
  renderText(body, ctx) {
    const c = ctx || {};
    let out = String(body == null ? "" : body);

    // ① 循环：{{#each tags}}…{{this}}…{{/each}}
    out = out.replace(/\{\{#each\s+([\w.]+)\s*\}\}([\s\S]*?)\{\{\/each\}\}/g, (m, key, inner) => {
      const arr = c[key];
      if (!Array.isArray(arr)) return "";
      return arr.map((item) => {
        const text = (item && typeof item === "object")
          ? String(item.text || item.name || item.title || "")
          : String(item == null ? "" : item);
        return this._renderInline(inner, Object.assign({}, c, { this: text }));
      }).join("");
    });

    // ② 条件 + ③ 占位符
    return this._renderInline(out, c);
  },

  /** 单层渲染：条件块（支持一层 else 与 ! 取反）+ 普通占位符（未知 → 空串） */
  _renderInline(body, ctx) {
    let out = String(body == null ? "" : body);
    out = out.replace(/\{\{#if\s+(!?)\s*([\w.]+)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g, (m, neg, key, inner) => {
      const parts = inner.split(/\{\{\s*else\s*\}\}/);
      const v = ctx[key];
      const truthy = Array.isArray(v) ? v.length > 0 : !!(v != null && String(v).trim());
      const show = neg ? !truthy : truthy;
      return show ? (parts[0] || "") : (parts[1] || "");
    });
    out = out.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, key) => {
      const v = ctx[key];
      if (Array.isArray(v)) return v.join(", ");
      return v == null ? "" : String(v);
    });
    return out;
  },

  /**
   * 渲染模板：按需解析批注与 AI 摘要，再走纯函数渲染。
   * @param tpl {name, body}
   * @param item Zotero 常规条目
   * @param hooks {aiSummary?: () => Promise<string>} 测试时可注入
   */
  async render(tpl, item, hooks = {}) {
    const ctx = this.context(item);
    const body = String(tpl && tpl.body || "");

    if (/\{\{\s*annotations\s*\}\}/.test(body)) ctx.annotations = this._annotationsMd(item);
    if (/\{\{\s*aiSummary\s*\}\}/.test(body)) {
      if (hooks.aiSummary) ctx.aiSummary = await hooks.aiSummary();
      else {
        try { ctx.aiSummary = await AIChat.summarize(item); }
        catch (e) { ctx.aiSummary = ctx.abstract || (I18n.isZh ? "（AI 摘要不可用）" : "(AI summary unavailable)"); }
      }
    }
    return this.renderText(body, ctx);
  },

  /** 菜单入口：选模板 → 生成笔记 */
  async runForSelected() {
    const zp = Zotero.getActiveZoteroPane();
    if (!zp) return;
    const items = ItemSel.regularOnly(zp.getSelectedItems() || []);
    if (!items.length) { ItemSel.alertEmpty(); return; }

    const tpls = this.all();
    const names = tpls.map((t) => t.name);
    const win = Zotero.getMainWindow();
    const out = { value: 0 };
    if (!Services.prompt.select(win, "Papilot · " + I18n.t("menuNoteTemplate"),
      I18n.isZh ? "选择笔记模板：" : "Pick a template:", names.length, names, out)) return;
    const tpl = tpls[out.value];
    if (!tpl) return;

    // 含 AI 占位符时检查 key
    if (/\{\{\s*aiSummary\s*\}\}/.test(tpl.body) && !AIClient.hasKey()) {
      Services.prompt.alert(win, "Papilot", I18n.t("chatNoKey"));
      return;
    }

    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("Papilot · " + tpl.name);
    pw.show();
    for (const item of items) {
      let title = "";
      try { title = item.getDisplayTitle() || ""; } catch (e) { /* ignore */ }
      const progress = new pw.ItemProgress("chrome://papilot/content/icons/chat.svg", title);
      try {
        progress.setProgress(40);
        const md = await this.render(tpl, item);
        await Notes.createFromMarkdown(item, `${tpl.name}｜${title}`, md);
        progress.setProgress(100);
      } catch (e) {
        progress.setError();
        Zotero.logError(e);
      }
    }
    pw.startCloseTimer(2500);
  },

  /* ================== 导出 / 导入（模板中心） ================== */

  /** 自定义模板 → 可粘贴的 JSON 文本 */
  serializeCustom() {
    return JSON.stringify({
      app: "papilot",
      kind: "noteTemplates",
      version: 1,
      templates: this.customList(),
    }, null, 2);
  },

  /** 写剪贴板（可被测试 hooks.writeClipboard 顶替） */
  async _writeClipboard(text) {
    try {
      const clip = Components.classes["@mozilla.org/widget/clipboardhelper;1"]
        .getService(Components.interfaces.nsIClipboardHelper);
      clip.copyString(String(text || ""));
      return true;
    } catch (e) {
      Zotero.logError(e);
      return false;
    }
  },

  /** 读剪贴板文本（可被测试 hooks.readClipboard 顶替） */
  async _readClipboard() {
    // 优先走主窗口 navigator.clipboard（Zotero 7+ 特权上下文可用）
    try {
      const win = Zotero.getMainWindow();
      if (win && win.navigator && win.navigator.clipboard && win.navigator.clipboard.readText) {
        return String(await win.navigator.clipboard.readText() || "");
      }
    } catch (e) { /* 走 XPCOM 回落 */ }
    try {
      const clip = Components.classes["@mozilla.org/widget/clipboard;1"]
        .getService(Components.interfaces.nsIClipboard);
      const trans = Components.classes["@mozilla.org/widget/transferable;1"]
        .createInstance(Components.interfaces.nsITransferable);
      if (trans.init) trans.init(null);
      for (const flavor of ["text/plain", "text/unicode"]) {
        try {
          trans.addDataFlavor(flavor);
          clip.getData(trans, clip.kGlobalClipboard);
          const data = {};
          const len = {};
          try { trans.getTransferData(flavor, data, len); } catch (e) { data.value = trans.getTransferData(flavor); }
          if (data.value) {
            const str = data.value.QueryInterface(Components.interfaces.nsISupportsString);
            if (str && str.data) return String(str.data);
          }
        } catch (e) { /* 换下一个 flavor */ }
      }
    } catch (e) {
      Zotero.logError(e);
    }
    return "";
  },

  /**
   * 解析导入文本 → {templates:[{name,body}], skipped, error}
   * 接受本插件的包裹格式，也宽容接受裸数组 [{name,body}]。
   */
  parseImport(text) {
    const zh = I18n.isZh;
    let obj;
    try {
      obj = JSON.parse(String(text || "").trim());
    } catch (e) {
      return { templates: [], skipped: 0, error: zh ? "剪贴板内容不是有效的 JSON" : "Clipboard is not valid JSON" };
    }
    const list = Array.isArray(obj) ? obj
      : (obj && Array.isArray(obj.templates)) ? obj.templates : null;
    if (!list) {
      return { templates: [], skipped: 0, error: zh ? "JSON 结构不对：找不到模板数组" : "No template array found" };
    }
    if (obj && !Array.isArray(obj) && obj.kind && obj.kind !== "noteTemplates") {
      return { templates: [], skipped: 0, error: zh ? "这不是笔记模板导出包" : "Not a note-template export" };
    }
    const templates = [];
    let skipped = 0;
    for (const t of list) {
      const name = String(t && t.name || "").trim();
      const body = String(t && t.body || "").trim();
      if (!name || !body) { skipped++; continue; }
      templates.push({ name, body });
    }
    return { templates, skipped, error: "" };
  },

  /**
   * 合并导入（纯函数）
   * @param existing 现有自定义 [{name,body}]
   * @param imported 导入的 [{name,body}]
   * @param strategy 冲突策略："skip" | "overwrite" | "rename"
   * @returns {merged, added, overwritten, skipped, renamed}
   */
  applyImport(existing, imported, strategy) {
    const merged = (Array.isArray(existing) ? existing : []).slice();
    const stat = { added: 0, overwritten: 0, skipped: 0, renamed: 0 };
    const taken = () => new Set(this.builtin.map((b) => b.name).concat(merged.map((t) => t.name)));
    for (const t of Array.isArray(imported) ? imported : []) {
      const idx = merged.findIndex((x) => x.name === t.name);
      if (idx >= 0) {
        if (strategy === "skip") { stat.skipped++; continue; }
        if (strategy === "overwrite") { merged[idx] = { name: t.name, body: t.body }; stat.overwritten++; continue; }
      }
      let name = t.name;
      if (idx >= 0 || taken().has(name)) {
        // 重命名：追加序号直到唯一（含与内置模板撞名的情况）
        let n = 2;
        while (taken().has(name + "（导入 " + n + "）")) n++;
        name = name + "（导入 " + n + "）";
        stat.renamed++;
      }
      merged.push({ name, body: t.body });
      stat.added++;
    }
    return { merged, ...stat };
  },

  /** 导出全部自定义模板到剪贴板 */
  async exportAll(hooks = {}) {
    const zh = I18n.isZh;
    const win = Zotero.getMainWindow();
    const custom = this.customList();
    if (!custom.length) {
      Services.prompt.alert(win, "Papilot", zh
        ? "还没有自定义模板，没有可导出的内容。（内置模板无需导出）"
        : "No custom templates to export.");
      return false;
    }
    const write = hooks.writeClipboard || ((t) => this._writeClipboard(t));
    const ok = await write(this.serializeCustom());
    Services.prompt.alert(win, "Papilot", ok
      ? (zh ? `已导出 ${custom.length} 个自定义模板到剪贴板。` : `Exported ${custom.length} templates to clipboard.`)
      : (zh ? "写剪贴板失败，请重试。" : "Failed to write clipboard."));
    return ok;
  },

  /**
   * 从剪贴板导入模板：校验结构 → 有重名时确认策略（跳过/覆盖/重命名）→ 合并入库。
   * hooks 供测试注入：{readClipboard, confirmStrategy, alert}
   */
  async importJSON(hooks = {}) {
    const zh = I18n.isZh;
    const win = Zotero.getMainWindow();
    const alert = hooks.alert || ((msg) => Services.prompt.alert(win, "Papilot", msg));
    const read = hooks.readClipboard || (() => this._readClipboard());
    const text = await read();
    const parsed = this.parseImport(text);
    if (parsed.error) { alert(parsed.error); return { ok: false, error: parsed.error }; }
    if (!parsed.templates.length) {
      const msg = zh ? "没有可导入的模板。" : "Nothing to import.";
      alert(msg);
      return { ok: false, error: msg };
    }

    const existing = this.customList();
    const hasConflict = parsed.templates.some((t) => existing.some((x) => x.name === t.name));
    let strategy = "skip";
    if (hasConflict) {
      if (hooks.confirmStrategy) {
        strategy = await hooks.confirmStrategy(parsed.templates, existing);
      } else {
        const flags = Services.prompt.BUTTON_POS_0 * Services.prompt.BUTTON_TITLE_IS_STRING +
          Services.prompt.BUTTON_POS_1 * Services.prompt.BUTTON_TITLE_IS_STRING +
          Services.prompt.BUTTON_POS_2 * Services.prompt.BUTTON_TITLE_IS_STRING;
        const choice = Services.prompt.confirmEx(win,
          "Papilot · " + (zh ? "模板重名" : "Name conflict"),
          zh ? "导入的模板里有与现有自定义模板重名的，怎么处理？"
            : "Some imported templates conflict with existing ones.",
          flags,
          zh ? "跳过" : "Skip",
          zh ? "覆盖" : "Overwrite",
          zh ? "重命名" : "Rename",
          null, {});
        if (choice < 0 || choice > 2) return { ok: false, error: zh ? "已取消" : "Cancelled" };
        strategy = ["skip", "overwrite", "rename"][choice];
      }
    }

    const res = this.applyImport(existing, parsed.templates, strategy);
    this.saveCustom(res.merged);
    const parts = zh
      ? [`新增 ${res.added}`]
      : [`added ${res.added}`];
    if (res.overwritten) parts.push(zh ? `覆盖 ${res.overwritten}` : `overwritten ${res.overwritten}`);
    if (res.renamed) parts.push(zh ? `重命名 ${res.renamed}` : `renamed ${res.renamed}`);
    if (res.skipped) parts.push(zh ? `跳过 ${res.skipped}` : `skipped ${res.skipped}`);
    if (parsed.skipped) parts.push(zh ? `无效条目 ${parsed.skipped}` : `invalid ${parsed.skipped}`);
    alert((zh ? "导入完成：" : "Import done: ") + parts.join(zh ? "，" : ", "));
    return { ok: true, ...res };
  },
};
