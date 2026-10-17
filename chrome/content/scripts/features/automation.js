/* PaperPilot 自动化引擎（0.23.0，路线图阶段 2）
 * 把原来只能「打标签」的规则打标，升级成通用的「触发 → 条件 → 动作」自动化：
 *   触发 trigger：newItem（新条目入库）/ readerOpen（打开 PDF）/ manual（手动对选中条目）
 *   条件 conditions：字段 + 操作 + 值，可多条件（match: "all" 全满足 / "any" 任一满足）
 *   动作 actions：打标签 / 去标签 / 写字段（白名单字段）/ 设阅读状态 /
 *                加入分类 / AI 总结生成笔记 / AI 自动打标签
 *
 * 三条纪律（沿用项目既有约定）：
 *  1. **破坏性操作必须预览**：manual 触发默认先出「命中 N 篇、将发生 M 处变更」的
 *     预览确认，用户点确认才真正执行。
 *  2. **AI 动作要过成本闸门**：调用 AI 前检查 AIClient 就绪 + **本地自动化每日上限**；
 *     不满足时跳过该动作并明确记录原因，绝不静默。（官方模型的费用另由账号余额扣减。）
 *  3. **自动触发有配额**：newItem/readerOpen 每批处理条目数上限（automationMaxPerFlush），
 *     防止一次导入几千条把插件拖死。
 *
 * 规则存储：pref `automationRules`（JSON 数组）。字段操作只允许白名单字段，
 * 避免自动化误改标题/DOI 这类核心标识。
 *
 * 0.39.0 起规则新增两个可选字段（旧规则没有也兼容，load/validate 不炸）：
 *   hotkey     快捷键 combo 串（如 "Ctrl+Shift+T"，空=无），由主线注册进中央快捷键表
 *   showInMenu 是否出现在条目右键菜单（默认 false）
 * 配套只读接口：getMenuRules() / getHotkeyRules()；runRule(ruleId, items) 按 id 手动执行。
 */
/* global Zotero, Services, Prefs, I18n, ItemSel, RuleTag, AIClient, AIChat, AutoTag, ReadingState, MdLite */

var Automation = {
  /* ================== 常量 ================== */

  TRIGGERS: ["newItem", "readerOpen", "manual"],

  /** 可作为条件字段（读取） */
  READ_FIELDS: ["title", "publicationTitle", "journalAbbreviation", "abstractNote", "year", "itemType",
    "DOI", "creators", "language", "extra", "url", "publisher", "volume", "issue", "pages", "tags", "collection"],

  /** 可作为动作写入（白名单：不改标题/DOI 这类识别性字段） */
  WRITE_FIELDS: ["language", "journalAbbreviation", "volume", "issue", "pages", "publisher", "place"],

  OPS: ["contains", "!contains", "regex", "=", "!=", ">", "<", "exists", "!exists"],

  ACTION_TYPES: ["tag", "removeTag", "field", "readingState", "addToCollection", "aiSummarize", "aiAutoTag"],

  /* ================== 存储 ================== */

  load() {
    try {
      const raw = String(Prefs.get("automationRules", "") || "");
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  },

  save(list) {
    try {
      Prefs.set("automationRules", JSON.stringify(Array.isArray(list) ? list : []));
      return true;
    } catch (e) {
      Zotero.logError(e);
      return false;
    }
  },

  /** 内置示例（默认不启用，需用户手动启用） */
  presets() {
    const zh = I18n.isZh;
    return [
      {
        id: "preset-preprint", name: zh ? "预印本自动标记" : "Flag preprints", enabled: false,
        trigger: "newItem", match: "any",
        conditions: [
          { field: "publicationTitle", op: "regex", value: "(?i)arxiv|biorxiv|medrxiv|ssrn|preprint" },
          { field: "extra", op: "regex", value: "(?i)arxiv" },
        ],
        actions: [{ type: "tag", tag: "#状态/预印本" }],
      },
      {
        id: "preset-high-score", name: zh ? "高影响期刊标记 + 自动精读" : "High-impact + auto read", enabled: false,
        trigger: "newItem", match: "all",
        conditions: [{ field: "publicationTitle", op: "regex", value: "(?i)nature|science|cell|lancet|jama|bmj" }],
        actions: [{ type: "tag", tag: "#重要" }, { type: "readingState", state: "未读" }],
      },
      {
        id: "preset-open-pdf", name: zh ? "打开 PDF 即标记在读" : "Mark reading on open", enabled: false,
        trigger: "readerOpen", match: "all", conditions: [],
        actions: [{ type: "readingState", state: "在读" }],
      },
      {
        id: "preset-nodoi", name: zh ? "缺 DOI 的新条目待补" : "Flag items without DOI", enabled: false,
        trigger: "newItem", match: "all",
        conditions: [{ field: "DOI", op: "!exists", value: "" }],
        actions: [{ type: "tag", tag: "#待补/缺DOI" }],
      },
    ];
  },

  /** 从「规则打标」的行式规则导入（一行 → 单条件 + 打标签动作） */
  importFromRuleTag() {
    if (typeof RuleTag === "undefined" || !RuleTag.parseRules) return { imported: 0, list: this.load() };
    const lines = RuleTag.parseRules();
    if (!lines.length) return { imported: 0, list: this.load() };
    const list = this.load();
    let n = 0;
    for (const r of lines) {
      const id = "import-" + r.tag + "-" + r.field + "-" + r.op;
      if (list.some((x) => x.id === id)) continue;
      list.push({
        id, name: (I18n.isZh ? "导入：" : "Imported: ") + r.tag, enabled: true,
        trigger: "manual", match: "all",
        conditions: [{ field: r.field, op: r.op, value: r.value }],
        actions: [{ type: "tag", tag: r.tag }],
      });
      n++;
    }
    this.save(list);
    return { imported: n, list };
  },

  /* ================== 校验（纯函数） ================== */

  /** @returns {string[]} 错误列表，空数组=合法 */
  validate(rule) {
    const zh = I18n.isZh;
    const errs = [];
    if (!rule || typeof rule !== "object") return [zh ? "规则为空" : "Empty rule"];
    if (!String(rule.name || "").trim()) errs.push(zh ? "缺少规则名称" : "Missing name");
    if (!this.TRIGGERS.includes(rule.trigger)) errs.push((zh ? "未知触发方式：" : "Unknown trigger: ") + rule.trigger);
    if (!["all", "any"].includes(rule.match || "all")) errs.push(zh ? "match 只能是 all 或 any" : "match must be all/any");
    const hk = String(rule.hotkey || "").trim();
    if (hk && !this.isValidHotkey(hk)) errs.push((zh ? "快捷键格式不对：" : "Bad hotkey: ") + hk);
    const conds = Array.isArray(rule.conditions) ? rule.conditions : [];
    for (const c of conds) {
      if (!this.READ_FIELDS.includes(c.field)) errs.push((zh ? "条件字段不支持：" : "Bad field: ") + c.field);
      if (!this.OPS.includes(c.op)) errs.push((zh ? "条件操作不支持：" : "Bad op: ") + c.op);
    }
    const acts = Array.isArray(rule.actions) ? rule.actions : [];
    if (!acts.length) errs.push(zh ? "至少要有一个动作" : "At least one action required");
    for (const a of acts) {
      if (!this.ACTION_TYPES.includes(a.type)) { errs.push((zh ? "动作类型不支持：" : "Bad action: ") + a.type); continue; }
      if (a.type === "tag" || a.type === "removeTag") {
        if (!String(a.tag || "").trim()) errs.push(zh ? "打标签/去标签动作缺少标签名" : "Missing tag");
      } else if (a.type === "field") {
        if (!this.WRITE_FIELDS.includes(a.field)) errs.push((zh ? "字段写入被拒绝（仅允许：）：" : "Field not writable: ") + a.field);
        if (a.value === undefined || a.value === null) errs.push(zh ? "字段写入缺少值" : "Missing value");
      } else if (a.type === "readingState") {
        if (!["未读", "在读", "已读"].includes(a.state)) errs.push(zh ? "阅读状态取值非法" : "Bad state");
      } else if (a.type === "addToCollection") {
        if (!a.collectionID) errs.push(zh ? "加入分类缺少目标分类" : "Missing collection");
      }
    }
    return errs;
  },

  /** 只保留启用的合法规则 */
  activeRules() {
    const out = [];
    for (const r of this.load()) {
      if (!r || r.enabled === false) continue;
      if (this.validate(r).length) continue;
      out.push(r);
    }
    return out;
  },

  /* ================== 快捷键 / 菜单（0.39.0） ================== */

  /**
   * combo 串校验：至少一个修饰键 + 一个主键，如 "Ctrl+Shift+T"。
   * 修饰键限定 Ctrl/Alt/Shift/Meta；主键为单字符、F1-F24 或常见命名键。
   */
  isValidHotkey(combo) {
    if (typeof combo !== "string") return false;
    const parts = combo.split("+").map((s) => s.trim());
    if (parts.length < 2 || parts.some((p) => !p)) return false;
    const mods = parts.slice(0, -1);
    if (!mods.every((m) => ["Ctrl", "Alt", "Shift", "Meta"].includes(m))) return false;
    const key = parts[parts.length - 1];
    return /^([A-Za-z0-9]|F([1-9]|1[0-9]|2[0-4])|Enter|Escape|Space|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right)$/.test(key);
  },

  /** 启用且勾选「出现在条目右键菜单」的规则 → [{id, name}]（menus.js 动态菜单数据源） */
  getMenuRules() {
    const out = [];
    for (const r of this.load()) {
      if (!r || r.enabled === false) continue;
      if (r.showInMenu !== true) continue;
      out.push({ id: r.id, name: String(r.name || "") });
    }
    return out;
  },

  /** 启用且配了快捷键的规则 → [{id, name, hotkey}]（主线 Hotkeys.register 数据源） */
  getHotkeyRules() {
    const out = [];
    for (const r of this.load()) {
      if (!r || r.enabled === false) continue;
      const hotkey = String(r.hotkey || "").trim();
      if (!hotkey || !this.isValidHotkey(hotkey)) continue;
      out.push({ id: r.id, name: String(r.name || ""), hotkey });
    }
    return out;
  },

  /* ================== 条件求值 ================== */

  /** 取字段值（与 RuleTag 保持一致，额外支持 tags / collection / language 等） */
  fieldValue(item, field) {
    const get = (f) => { try { return item.getField(f) || ""; } catch (e) { return ""; } };
    switch (field) {
      case "year": {
        const m = String(get("date")).match(/(\d{4})/);
        return m ? Number(m[1]) : "";
      }
      case "itemType":
        try { return Zotero.ItemTypes.getName(item.itemTypeID) || ""; } catch (e) { return ""; }
      case "creators":
        try { return item.getCreators().map((c) => (c.lastName || "") + " " + (c.firstName || "")).join("; "); } catch (e) { return ""; }
      case "tags":
        try { return item.getTags().map((t) => t.tag).join("; "); } catch (e) { return ""; }
      case "collection":
        try {
          const cols = item.getCollections() || [];
          return cols.map((id) => {
            try { const c = Zotero.Collections.get(id); return c ? c.name : ""; } catch (e) { return ""; }
          }).filter(Boolean).join("; ");
        } catch (e) { return ""; }
      default:
        return get(field);
    }
  },

  /**
   * 编译正则。**JS 的 RegExp 不支持 `(?i)` 这类内联标志**（那是 Java/Python 语法），
   * 直接 new RegExp("(?i)x") 会抛异常 → 条件恒不命中、且被 try/catch 吞掉，
   * 表现为「规则明明写了却永远不生效」。故统一：剥掉 `(?i)`/`(?-i)` 前缀，
   * 默认加 i 标志（学术字段匹配大小写不敏感是常态），`(?-i)` 显式要求区分大小写。
   */
  compileRegex(pattern) {
    let p = String(pattern == null ? "" : pattern);
    let flags = "i";
    const m = p.match(/^\(\?([a-z-]*)\)/);
    if (m) {
      if (m[1].includes("-i")) flags = "";
      p = p.slice(m[0].length);
    }
    return new RegExp(p, flags);
  },

  /** 单条件求值 */
  matchCondition(cond, item) {
    if (!cond || !cond.field || !cond.op) return false;
    const v = this.fieldValue(item, cond.field);
    const op = cond.op;
    const value = cond.value == null ? "" : cond.value;
    if (op === "exists") return String(v).trim() !== "";
    if (op === "!exists") return String(v).trim() === "";
    if (op === ">" || op === "<") {
      const n = Number(v);
      if (isNaN(n) || String(v).trim() === "") return false;
      return op === ">" ? n > Number(value) : n < Number(value);
    }
    const s = String(v);
    const sv = s.toLowerCase();
    const vv = String(value).toLowerCase();
    switch (op) {
      case "contains": return sv.includes(vv);
      case "!contains": return !sv.includes(vv);
      case "=": return sv === vv;
      case "!=": return sv !== vv;
      case "regex": try { return this.compileRegex(value).test(s); } catch (e) { return false; }
    }
    return false;
  },

  /** 整条规则的条件求值（无条件 = 恒真） */
  matchRule(rule, item) {
    const conds = Array.isArray(rule.conditions) ? rule.conditions : [];
    if (!conds.length) return true;
    const results = conds.map((c) => {
      try { return this.matchCondition(c, item); } catch (e) { return false; }
    });
    return (rule.match === "any") ? results.some(Boolean) : results.every(Boolean);
  },

  /* ================== 动作规划（纯函数，供预览/执行共用） ================== */

  /**
   * 计算某条目在某规则下会产生哪些变更（不落库，供预览与执行共用同一套判断）
   * @returns {Array<{type:string, desc:string, ...}>}
   */
  planActions(rule, item) {
    const zh = I18n.isZh;
    const plan = [];
    const acts = Array.isArray(rule.actions) ? rule.actions : [];
    for (const a of acts) {
      try {
        if (a.type === "tag") {
          const has = item.getTags().some((t) => t.tag === a.tag);
          if (!has) plan.push({ type: "tag", tag: a.tag, desc: zh ? "打标签 " + a.tag : "tag " + a.tag });
        } else if (a.type === "removeTag") {
          const has = item.getTags().some((t) => t.tag === a.tag);
          if (has) plan.push({ type: "removeTag", tag: a.tag, desc: zh ? "去标签 " + a.tag : "untag " + a.tag });
        } else if (a.type === "field") {
          const cur = String(this.fieldValue(item, a.field) || "");
          const next = String(a.value == null ? "" : a.value);
          if (cur !== next) plan.push({ type: "field", field: a.field, value: next, desc: (zh ? "写字段 " : "set ") + a.field + " → " + next });
        } else if (a.type === "readingState") {
          const cur = (typeof ReadingState !== "undefined" && ReadingState.getState) ? ReadingState.getState(item) : "";
          if (cur !== a.state) plan.push({ type: "readingState", state: a.state, desc: (zh ? "阅读状态 → " : "state → ") + a.state });
        } else if (a.type === "addToCollection") {
          const cols = (() => { try { return item.getCollections() || []; } catch (e) { return []; } })();
          if (!cols.includes(a.collectionID)) {
            plan.push({ type: "addToCollection", collectionID: a.collectionID, desc: (zh ? "加入分类 #" : "add to collection #") + a.collectionID });
          }
        } else if (a.type === "aiSummarize") {
          plan.push({ type: "aiSummarize", desc: zh ? "AI 总结并生成笔记（消耗额度）" : "AI summary note (uses quota)" });
        } else if (a.type === "aiAutoTag") {
          plan.push({ type: "aiAutoTag", desc: zh ? "AI 自动打标签（消耗额度）" : "AI auto-tag (uses quota)" });
        }
      } catch (e) { /* 单动作出错不影响其他 */ }
    }
    return plan;
  },

  /** 对一批条目做整体预览：命中条目 + 计划变更统计 */
  async preview(rules, items) {
    const hits = [];
    let changeCount = 0;
    const byRule = new Map();
    for (const item of items) {
      for (const rule of rules) {
        let ok = false;
        try { ok = this.matchRule(rule, item); } catch (e) { ok = false; }
        if (!ok) continue;
        const plan = this.planActions(rule, item);
        if (!plan.length) continue;
        changeCount += plan.length;
        hits.push({ item, rule, plan });
        byRule.set(rule.id || rule.name, (byRule.get(rule.id || rule.name) || 0) + 1);
      }
    }
    return { hits, changeCount, byRule: [...byRule.entries()] };
  },

  /* ================== 执行 ================== */

  _title(item) {
    try { return item.getDisplayTitle() || ""; } catch (e) { return ""; }
  },

  /** AI 额度闸门：返回 {ok, reason} */
  aiGate() {
    const zh = I18n.isZh;
    if (typeof AIClient === "undefined" || !AIClient.hasKey()) {
      return { ok: false, reason: (zh ? "AI 不可用：" : "AI unavailable: ") + (AIClient && AIClient.guidance ? AIClient.guidance() : "") };
    }
    const cap = Number(Prefs.get("automationDailyAiCap", 20)) || 20;
    const used = this.todayAiCount();
    if (used >= cap) {
      return { ok: false, reason: (zh ? "今日自动化 AI 次数已达上限 " : "Daily automation AI cap reached ") + cap };
    }
    return { ok: true, reason: "" };
  },

  _today() { return new Date().toISOString().slice(0, 10); },

  todayAiCount() {
    const raw = String(Prefs.get("automationDailyAiCount", "") || "");
    const [d, n] = raw.split(":");
    return d === this._today() ? Number(n) || 0 : 0;
  },

  bumpAiCount() {
    Prefs.set("automationDailyAiCount", this._today() + ":" + (this.todayAiCount() + 1));
  },

  /**
   * 执行单个动作
   * @returns {Promise<{done:boolean, note?:string}>}
   */
  async execAction(action, item, ctx) {
    switch (action.type) {
      case "tag":
        item.addTag(action.tag);
        return { done: true };
      case "removeTag":
        try { item.removeTag(action.tag); } catch (e) { /* ignore */ }
        return { done: true };
      case "field":
        item.setField(action.field, action.value);
        return { done: true };
      case "readingState":
        if (typeof ReadingState !== "undefined" && ReadingState.setState) {
          await ReadingState.setState(item, action.state);
          return { done: true };
        }
        return { done: false, note: "ReadingState 不可用" };
      case "addToCollection": {
        try { item.addToCollection(action.collectionID); return { done: true }; } catch (e) { return { done: false, note: String(e && e.message || e) }; }
      }
      case "aiSummarize": {
        const gate = this.aiGate();
        if (!gate.ok) { if (ctx) ctx.skipped.push(gate.reason); return { done: false, note: gate.reason }; }
        try {
          const note = await AIChat.summarize(item);
          this.bumpAiCount();
          return { done: true, note: note ? "已生成笔记" : "已生成笔记" };
        } catch (e) { return { done: false, note: String(e && e.message || e) }; }
      }
      case "aiAutoTag": {
        const gate = this.aiGate();
        if (!gate.ok) { if (ctx) ctx.skipped.push(gate.reason); return { done: false, note: gate.reason }; }
        try {
          // AutoTag 没有批量纯函数入口：用 suggest() 拿建议标签后直接写入
          // （不走 runForSelected 的勾选对话框——自动化场景不该弹窗打断）
          if (typeof AutoTag === "undefined" || !AutoTag.suggest) return { done: false, note: "AutoTag 不可用" };
          const tags = await AutoTag.suggest(item);
          const list = Array.isArray(tags) ? tags : (tags && tags.tags) || [];
          if (!list.length) return { done: false, note: "AI 未给出标签" };
          const existing = new Set(item.getTags().map((t) => t.tag));
          let added = 0;
          for (const t of list) {
            const name = typeof t === "string" ? t : (t && t.tag);
            if (name && !existing.has(name)) { item.addTag(name); existing.add(name); added++; }
          }
          this.bumpAiCount();
          return { done: added > 0, note: added ? "" : "标签已存在" };
        } catch (e) { return { done: false, note: String(e && e.message || e) }; }
      }
    }
    return { done: false, note: "未知动作" };
  },

  /**
   * 对条目批量应用规则
   * @param {boolean} dryRun true=只统计不改动
   */
  async apply(rules, items, dryRun) {
    const ctx = { skipped: [], applied: 0, errors: [] };
    for (const item of items) {
      for (const rule of rules) {
        let ok = false;
        try { ok = this.matchRule(rule, item); } catch (e) { ok = false; }
        if (!ok) continue;
        const plan = this.planActions(rule, item);
        if (!plan.length) continue;
        if (dryRun) { ctx.applied += plan.length; continue; }
        for (const a of plan) {
          try {
            const r = await this.execAction(a, item, ctx);
            if (r.done) ctx.applied++;
            else if (r.note) ctx.skipped.push(r.note);
          } catch (e) {
            ctx.errors.push(String(e && e.message || e));
          }
        }
        try { await item.saveTx(); } catch (e) { /* ignore */ }
      }
    }
    return ctx;
  },

  /* ================== 入口 ================== */

  /** 对话框（规则管理 + 试跑预览） */
  openDialog() {
    const win = Zotero.getMainWindow();
    if (!win) return null;
    return win.openDialog(
      "chrome://paperpilot/content/automation.xhtml",
      "paperpilot-automation",
      "chrome,centerscreen,resizable,dialog=no",
      { Zotero, Services }
    );
  },

  /**
   * 「预览 → 确认 → 执行 → 进度窗」的公共流程（runForSelected 与 runRule 复用）
   * @returns {Promise<boolean>} 是否真正执行了
   */
  async _runWithPreview(rules, items) {
    const zh = I18n.isZh;
    const pv = await this.preview(rules, items);
    if (!pv.hits.length) {
      Services.prompt.alert(Zotero.getMainWindow(), "PaperPilot",
        zh ? `选中 ${items.length} 篇，没有规则命中，未做任何改动。` : `No rule matched among ${items.length} items.`);
      return false;
    }
    const lines = pv.byRule.map(([name, n]) => "  · " + name + " → " + n + (zh ? " 篇" : " items")).join("\n");
    const msg = (zh
      ? `选中 ${items.length} 篇，命中 ${pv.hits.length} 处，预计 ${pv.changeCount} 项变更：\n\n` + lines + "\n\n确认执行？"
      : `${items.length} selected, ${pv.hits.length} matches, ${pv.changeCount} changes:\n\n` + lines + "\n\nProceed?");
    const flags = Services.prompt.BUTTON_POS_0 * Services.prompt.BUTTON_TITLE_IS_STRING +
      Services.prompt.BUTTON_POS_1 * Services.prompt.BUTTON_TITLE_IS_STRING;
    const choice = Services.prompt.confirmEx(Zotero.getMainWindow(), "PaperPilot · " + (zh ? "自动化预览" : "Automation preview"),
      msg, flags, zh ? "执行" : "Run", zh ? "取消" : "Cancel", null, null, {});
    if (choice !== 0) return false;
    const r = await this.apply(rules, items, false);
    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("PaperPilot · " + (zh ? "自动化" : "Automation"));
    const progress = new pw.ItemProgress("chrome://paperpilot/content/icons/chat.svg",
      (zh ? "已执行 " : "Applied ") + r.applied + (zh ? " 项变更" : " changes") +
      (r.skipped.length ? (zh ? "，跳过 " : ", skipped ") + r.skipped.length : ""));
    if (r.errors.length) progress.setError();
    progress.setProgress(100);
    pw.show();
    pw.startCloseTimer(3000);
    return true;
  },

  /** 对选中条目运行 manual 触发的规则（先预览、确认后执行） */
  async runForSelected() {
    const zh = I18n.isZh;
    const zp = Zotero.getActiveZoteroPane();
    if (!zp) return;
    const items = ItemSel.regularOnly(zp.getSelectedItems() || []);
    if (!items.length) { ItemSel.alertEmpty(); return; }
    const rules = this.activeRules().filter((r) => r.trigger === "manual" || r.trigger === "newItem");
    if (!rules.length) {
      Services.prompt.alert(Zotero.getMainWindow(), "PaperPilot",
        zh ? "没有可用的自动化规则。请在「自动化规则」对话框中创建并启用。" : "No enabled automation rules.");
      return;
    }
    await this._runWithPreview(rules, items);
  },

  /**
   * 按 id 手动执行单条规则（右键菜单 / 快捷键的入口）。
   * @param {string} ruleId
   * @param {Array} [items] 不传则取当前选中条目
   * @returns {Promise<boolean>} 是否真正执行了
   */
  async runRule(ruleId, items) {
    const zh = I18n.isZh;
    const rule = this.load().find((r) => r && r.id === ruleId);
    if (!rule) {
      Services.prompt.alert(Zotero.getMainWindow(), "PaperPilot",
        zh ? "这条自动化规则已不存在（可能被删除）。" : "Rule no longer exists.");
      return false;
    }
    const errs = this.validate(rule);
    if (errs.length) {
      Services.prompt.alert(Zotero.getMainWindow(), "PaperPilot",
        (zh ? "规则配置有误，未执行：" : "Rule invalid, not run: ") + errs[0]);
      return false;
    }
    let list = items;
    if (!Array.isArray(list) || !list.length) {
      const zp = Zotero.getActiveZoteroPane();
      if (!zp) return false;
      list = ItemSel.regularOnly(zp.getSelectedItems() || []);
    }
    if (!list.length) { ItemSel.alertEmpty(); return false; }
    return this._runWithPreview([rule], list);
  },

  /* ================== Notifier ================== */

  _notifierID: null,
  _tabNotifierID: null,
  _pending: new Set(),
  _timer: null,

  _onItemNotify(event, ids) {
    if (event !== "add") return;
    if (!Prefs.get("automationOnNewItem", false)) return;
    const rules = this.activeRules().filter((r) => r.trigger === "newItem");
    if (!rules.length) return;
    for (const id of ids) this._pending.add(id);
    if (this._timer) return;
    // 防抖 4s：导入是批量 add，合并成一批；等元数据（DOI 识别等）落定
    this._timer = setTimeout(() => { this._flush().catch((e) => Zotero.logError(e)); }, 4000);
  },

  _onTabNotify(event, ids) {
    if (event !== "open" && event !== "select") return;
    if (!Prefs.get("automationOnReaderOpen", false)) return;
    const rules = this.activeRules().filter((r) => r.trigger === "readerOpen");
    if (!rules.length) return;
    for (const tabID of ids || []) {
      (async () => {
        try {
          const reader = Zotero.Reader.getByTabID(tabID);
          const itemID = reader && reader.itemID;
          if (!itemID) return;
          let item = Zotero.Items.get(itemID);
          if (item && item.isAttachment && item.isAttachment() && item.parentItemID) item = Zotero.Items.get(item.parentItemID);
          if (!item || !item.isRegularItem || !item.isRegularItem() || item.deleted) return;
          await this.apply(rules, [item], false);
        } catch (e) { /* tab API 不存在时静默 */ }
      })();
    }
  },

  async _flush() {
    this._timer = null;
    const cap = Math.max(1, Number(Prefs.get("automationMaxPerFlush", 20)) || 20);
    const ids = [...this._pending].slice(0, cap);
    this._pending.clear();
    const rules = this.activeRules().filter((r) => r.trigger === "newItem");
    if (!rules.length) return;
    const items = [];
    for (const id of ids) {
      try {
        const it = await Zotero.Items.getAsync(id);
        if (it && it.isRegularItem && it.isRegularItem() && !it.deleted) items.push(it);
      } catch (e) { /* 防抖期间可能已删除 */ }
    }
    if (!items.length) return;
    const r = await this.apply(rules, items, false);
    Zotero.debug("PaperPilot automation(newItem): " + items.length + " items, " + r.applied + " changes, " + r.skipped.length + " skipped");
  },

  register() {
    if (this._notifierID) return;
    this._notifierID = Zotero.Notifier.registerObserver({
      notify: (event, type, ids) => {
        try {
          if (type === "item") this._onItemNotify(event, ids);
        } catch (e) { Zotero.logError(e); }
      },
    }, ["item"], "paperpilot-automation");
    try {
      this._tabNotifierID = Zotero.Notifier.registerObserver({
        notify: (event, type, ids) => {
          try { if (type === "tab") this._onTabNotify(event, ids); } catch (e) { /* ignore */ }
        },
      }, ["tab"], "paperpilot-automation-tab");
    } catch (e) { this._tabNotifierID = null; }
  },

  unregister() {
    for (const k of ["_notifierID", "_tabNotifierID"]) {
      if (this[k]) {
        try { Zotero.Notifier.unregisterObserver(this[k]); } catch (e) { /* ignore */ }
        this[k] = null;
      }
    }
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this._pending.clear();
  },
};
