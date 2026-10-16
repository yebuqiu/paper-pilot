/* PaperPilot 可编辑 #命令标签体系（参考 zotero-gpt Command Tags）
 *
 * 数据模型：标签 = {id, label, prompt, color, trigger}
 *   · id      稳定标识（内置默认沿用 Prompts 内置条目 id）
 *   · label   标签区显示名
 *   · prompt  点击标签时填入并发送的提示词；含 "{input}" 时替换为用户原输入
 *   · color   标签描边/文字色（CSS 颜色，可空）
 *   · trigger 触发正则（可空）：用户输入命中该正则 → 自动套用该标签 prompt
 *
 * 存储：pref extensions.paperpilot.chatTags（JSON 数组，全量）。
 *   启动时与内置默认标签（从 chat-float 原硬编码 Prompt 标签迁移，即 Prompts
 *   内置前 8 条）合并：pref 中同 id 条目覆盖默认；pref 缺失的内置默认补齐
 *   （升级新增内置标签能自动出现）；删除内置默认打 {id, deleted:true} 墓碑，
 *   防止重启后被「补齐」复活。
 *
 * 消费方：chat-float.js Prompt 标签区 / workbench.js Prompt 技能库与「/」命令。
 * 生命周期：无 register——首次访问惰性加载；任何 mutation 即写回 pref。
 */
/* global Zotero, Prompts */

var CommandTags = {
  PREF_KEY: "extensions.paperpilot.chatTags",

  _tags: null,        // 合并后的生效视图 [{id,label,prompt,color,trigger}]
  _tombstones: null,  // Set<string> 已删除的内置默认 id

  /* ==================== 内置默认（迁移自 chat-float 硬编码 Prompt 标签） ==================== */

  _PALETTE: ["#2563eb", "#0d9488", "#c2410c", "#7c3aed", "#be185d", "#4d7c0f", "#0369a1", "#a16207"],

  defaults() {
    try {
      if (typeof Prompts !== "undefined" && Prompts && Prompts.all) {
        return Prompts.all().slice(0, 8).map((p, i) => ({
          id: String(p.id || ("tag-" + i)),
          label: String(p.name || ""),
          prompt: String(p.text || ""),
          color: this._PALETTE[i % this._PALETTE.length],
          trigger: "",
        })).filter((t) => t.label && t.prompt);
      }
    } catch (e) { /* Prompts 不可用时无默认 */ }
    return [];
  },

  /* ==================== pref 读写 ==================== */

  _readPref() {
    try {
      const raw = Zotero.Prefs.get(this.PREF_KEY, true);
      if (!raw) return null;
      const v = JSON.parse(String(raw));
      return Array.isArray(v) ? v : null;
    } catch (e) {
      return null;
    }
  },

  _writePref(arr) {
    try {
      Zotero.Prefs.set(this.PREF_KEY, JSON.stringify(arr), true);
    } catch (e) { /* 超限时静默 */ }
  },

  _norm(t) {
    return {
      id: String(t && t.id || "").trim(),
      label: String(t && t.label || "").trim(),
      prompt: String(t && t.prompt != null ? t.prompt : ""),
      color: String(t && t.color || "").trim(),
      trigger: String(t && t.trigger || "").trim(),
    };
  },

  _valid(t) { return !!(t && t.id && (t.label || t.prompt)); },

  /** 加载：pref 全量为准，同 id 覆盖内置默认；缺失默认补齐；墓碑跳过 */
  _load() {
    this._tombstones = new Set();
    const raw = this._readPref();
    if (!raw) {
      // 首次启动：播种内置默认并落 pref
      this._tags = this.defaults();
      this._save();
      return;
    }
    const out = [];
    for (const t of raw) {
      if (!t || typeof t !== "object") continue;
      if (t.deleted) { this._tombstones.add(String(t.id)); continue; }
      const n = this._norm(t);
      if (this._valid(n)) out.push(n);
    }
    for (const d of this.defaults()) {
      if (this._tombstones.has(d.id)) continue;
      if (!out.some((t) => t.id === d.id)) out.push(d);
    }
    this._tags = out;
  },

  _save() {
    const arr = this._tags.concat(
      [...this._tombstones].map((id) => ({ id, deleted: true }))
    );
    this._writePref(arr);
  },

  _ensure() {
    if (!this._tags) this._load();
  },

  /* ==================== 查询 ==================== */

  /** 全部生效标签（副本，改动请走 upsert/remove） */
  all() {
    this._ensure();
    return this._tags.slice();
  },

  get(id) {
    this._ensure();
    return this._tags.find((t) => t.id === id) || null;
  },

  newId() {
    return "tag-" + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
  },

  /* ==================== 增删改 ==================== */

  /** 新建/更新（同 id 覆盖）；返回规范化后的标签，非法入参返回 null */
  upsert(tag) {
    this._ensure();
    const n = this._norm(tag);
    if (!n.id) n.id = this.newId();
    if (!this._valid(n)) return null;
    this._tombstones.delete(n.id); // 重建同名内置 = 撤销删除
    const i = this._tags.findIndex((t) => t.id === n.id);
    if (i >= 0) this._tags[i] = n;
    else this._tags.push(n);
    this._save();
    return n;
  },

  /** 删除；内置默认打墓碑（重启不复活）。返回是否确有删除 */
  remove(id) {
    this._ensure();
    const before = this._tags.length;
    this._tags = this._tags.filter((t) => t.id !== id);
    if (this._tags.length === before) return false;
    if (this.defaults().some((d) => d.id === id)) this._tombstones.add(id);
    this._save();
    return true;
  },

  /* ==================== trigger 正则 ==================== */

  /**
   * 输入命中某标签 trigger 正则 → 返回 {tag, match}；否则 null。
   * 非法正则静默跳过（用户在编辑层填了坏正则不拖垮发送）。
   */
  matchTrigger(text) {
    this._ensure();
    const s = String(text || "");
    if (!s) return null;
    for (const t of this._tags) {
      if (!t.trigger) continue;
      let re = null;
      try { re = new RegExp(t.trigger); } catch (e) { continue; }
      const m = re.exec(s);
      if (m) return { tag: t, match: m };
    }
    return null;
  },

  /** 套用结果：prompt 含 "{input}" 时替换为用户原输入，否则整体替换 */
  applyTrigger(text) {
    const hit = this.matchTrigger(text);
    if (!hit) return String(text || "");
    const p = hit.tag.prompt || "";
    return p.indexOf("{input}") >= 0 ? p.split("{input}").join(String(text || "")) : p;
  },

  /* ==================== 导入 / 导出（剪贴板 JSON 全量） ==================== */

  exportJSON() {
    this._ensure();
    return JSON.stringify(this._tags, null, 2);
  },

  /**
   * 全量导入（替换当前标签集）。接受裸数组 [{id,label,prompt,color,trigger}]。
   * 被导入集省略的内置默认打墓碑（否则重启后复活）。返回 {ok, count|error}。
   */
  importJSON(json) {
    let v;
    try { v = JSON.parse(String(json || "")); }
    catch (e) { return { ok: false, error: "invalid-json" }; }
    if (!Array.isArray(v)) return { ok: false, error: "not-array" };
    const out = [];
    for (const t of v) {
      if (!t || typeof t !== "object" || t.deleted) continue;
      const n = this._norm(t);
      if (!n.id) n.id = this.newId();
      if (this._valid(n)) out.push(n);
    }
    this._ensure();
    this._tags = out;
    this._tombstones = new Set();
    for (const d of this.defaults()) {
      if (!out.some((t) => t.id === d.id)) this._tombstones.add(d.id);
    }
    this._save();
    return { ok: true, count: out.length };
  },
};
