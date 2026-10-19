// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 规则打标（0.6.0 新增）
 * 无 AI 依赖：按用户定义的「标签 | 字段 | 操作 | 值」行规则批量打标签。
 * 行格式（每行一条，# 或 // 开头为注释，空行忽略）：
 *   #方法/面板数据 | abstractNote | contains | panel data
 *   #领域/心血管   | publicationTitle | regex | (?i)heart|cardio
 *   #高分文献      | year | > | 2020
 *   #有全文        | DOI  | exists |
 * 字段：title / publicationTitle / journalAbbreviation / abstractNote /
 *       year（数值比较）/ itemType / DOI / creators
 * 操作：contains | !contains | regex | = | != | > | < | exists（值留空）
 * 应用方式：① 右键菜单对选中条目；② 可选「新条目自动应用」（Notifier add 事件，防抖合并）
 */
/* global Zotero, Services, Prefs, I18n, ItemSel */

var RuleTag = {
  _notifierID: null,
  _pending: new Set(),
  _timer: null,

  /* ================= 规则解析 ================= */

  parseRules() {
    const text = String(Prefs.get("ruleTagRules", "") || "");
    const rules = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      // 规则必含 | 分隔；注释（# 开头）、空行、残缺行自然跳过
      // （标签以 # 开头不算注释，如 "#领域/医学 | publicationTitle | contains | Lancet"）
      if (!line || !line.includes("|") || line.startsWith("//")) continue;
      const parts = line.split("|").map((s) => s.trim());
      if (parts.length < 3) continue;
      const [tag, field, op] = parts;
      const value = parts.slice(3).join("|").trim();
      if (!tag || !field || !op) continue;
      if (!/^(contains|!contains|regex|=|!=|>|<|exists)$/i.test(op)) continue;
      rules.push({ tag, field, op: op.toLowerCase(), value, raw: line });
    }
    return rules;
  },

  _fieldValue(item, field) {
    const get = (f) => { try { return item.getField(f) || ""; } catch (e) { return ""; } };
    switch (field) {
      case "year": {
        const d = get("date");
        const m = String(d).match(/(\d{4})/);
        return m ? Number(m[1]) : "";
      }
      case "itemType":
        try { return Zotero.ItemTypes.getName(item.itemTypeID) || ""; } catch (e) { return ""; }
      case "creators": {
        try {
          return item.getCreators().map((c) => (c.lastName || "") + " " + (c.firstName || "")).join("; ");
        } catch (e) { return ""; }
      }
      default:
        return get(field);
    }
  },

  /**
   * 编译正则。JS 的 RegExp 不支持 `(?i)` 内联标志（Java/Python 语法），
   * 而本文档给出的示例就是 `(?i)heart|cardio` —— 直接 new RegExp 会抛异常
   * 并被 catch 吞掉，规则静默永不命中（0.23.0 发现）。统一剥离前缀 + 默认 i。
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

  match(rule, item) {
    const v = this._fieldValue(item, rule.field);
    const { op, value } = rule;
    if (op === "exists") return String(v).trim() !== "";
    if (op === ">" || op === "<") {
      const n = Number(v);
      if (isNaN(n)) return false;
      return op === ">" ? n > Number(value) : n < Number(value);
    }
    const s = String(v);
    const sv = s.toLowerCase();
    const vv = value.toLowerCase();
    switch (op) {
      case "contains": return sv.includes(vv);
      case "!contains": return !sv.includes(vv);
      case "=": return sv === vv;
      case "!=": return sv !== vv;
      case "regex":
        try { return this.compileRegex(value).test(s); } catch (e) { return false; }
    }
    return false;
  },

  /** 对单条目应用全部规则，返回新增标签数组 */
  async applyTo(item, rules) {
    const added = [];
    const existing = new Set();
    try { for (const t of item.getTags()) existing.add(t.tag); } catch (e) { /* ignore */ }
    for (const rule of rules) {
      if (existing.has(rule.tag)) continue;
      let ok = false;
      try { ok = this.match(rule, item); } catch (e) { /* 单条规则出错不影响其他 */ }
      if (ok) {
        item.addTag(rule.tag);
        existing.add(rule.tag);
        added.push(rule.tag);
      }
    }
    if (added.length) await item.saveTx();
    return added;
  },

  /* ================= 菜单：选中条目批量应用 ================= */

  async runForSelected() {
    const zp = Zotero.getActiveZoteroPane();
    if (!zp) return;
    const items = ItemSel.regularOnly(zp.getSelectedItems() || []);
    if (!items.length) {
      ItemSel.alertEmpty();
      return;
    }
    const rules = this.parseRules();
    const win = Zotero.getMainWindow();
    if (!rules.length) {
      Services.prompt.alert(win, "Papilot",
        I18n.isZh ? "还没有有效规则。请在 设置 → Papilot → 规则打标 中按格式添加。"
                  : "No valid rules. Add rules in Settings → Papilot → Rule Tagging.");
      return;
    }
    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("Papilot");
    pw.show();
    for (const item of items) {
      let title = "";
      try { title = item.getDisplayTitle() || ""; } catch (e) { /* ignore */ }
      const progress = new pw.ItemProgress("chrome://papilot/content/icons/chat.svg", title);
      try {
        const added = await this.applyTo(item, rules);
        progress.setText(
          added.length
            ? (I18n.isZh ? `新增 ${added.length} 个标签：` : `Added ${added.length}: `) + added.join(" ")
            : (I18n.isZh ? "无匹配规则" : "No rule matched")
        );
        progress.setProgress(100);
      } catch (e) {
        progress.setError();
        Zotero.logError(e);
      }
    }
    pw.startCloseTimer(3000);
  },

  /* ================= 新条目自动应用 ================= */

  _onNotify(event, type, ids) {
    if (type !== "item" || event !== "add") return;
    if (!Prefs.get("ruleTagAutoOnNew", false)) return;
    for (const id of ids) this._pending.add(id);
    if (this._timer) return;
    // 防抖：导入常是批量 add，合并成一批；并等元数据（DOI 识别等）落定
    this._timer = setTimeout(() => this._flushPending(), 4000);
  },

  async _flushPending() {
    this._timer = null;
    const ids = [...this._pending];
    this._pending.clear();
    const rules = this.parseRules();
    if (!rules.length) return;
    for (const id of ids) {
      try {
        const item = await Zotero.Items.getAsync(id);
        if (!item || !item.isRegularItem || !item.isRegularItem()) continue;
        if (item.deleted) continue;
        await this.applyTo(item, rules);
      } catch (e) { /* 条目可能在防抖期间被删除，忽略 */ }
    }
  },

  register() {
    if (this._notifierID) return;
    this._notifierID = Zotero.Notifier.registerObserver({
      notify: (event, type, ids) => {
        try { this._onNotify(event, type, ids); } catch (e) { Zotero.logError(e); }
      },
    }, ["item"], "papilot-ruletag");
  },

  unregister() {
    if (this._notifierID) {
      try { Zotero.Notifier.unregisterObserver(this._notifierID); } catch (e) { /* ignore */ }
      this._notifierID = null;
    }
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this._pending.clear();
  },
};
