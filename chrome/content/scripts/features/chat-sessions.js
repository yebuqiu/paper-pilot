/* PaperPilot 浮窗会话持久化（chat-sessions.js）
 *
 * 目的：浮窗会话（history + 上下文 chip）跨窗口关闭 / 插件重载不丢。
 * 存储：pref `extensions.zotero.paperpilot.chatSessions`，JSON 数组，最新在前。
 *   · LRU 上限 50 条（超出裁掉最旧）
 *   · 单条只留最近 40 条消息（长会话不无限膨胀 pref）
 *   · 空 history 不落盘（清空后不该留下空壳会话）
 *   · 任何读操作对坏 JSON / 坏条目容错，坏值一律按 [] 处理
 *
 * 条目形状：
 *   { id, itemID, title, ts, count, history:[{role,content}], chips:[itemID] }
 *
 * 消费方：panels/chat-float.js（runSend 成功后 save；_ensure 时自动恢复；
 *   /clear 时 remove）。无 register——纯数据域，首次访问惰性读写 pref。
 */
/* global Zotero, Prefs */

var ChatSessions = {
  PREF_KEY: "chatSessions",
  MAX_SESSIONS: 50,
  MAX_MESSAGES: 40,
  TITLE_MAX: 30,

  /* ==================== pref 读写 ==================== */

  /** 读全量（坏值 → []）；只做「是数组」这一层筛选，字段校验留给各 API */
  _read() {
    let raw = "";
    try { raw = Prefs.get(this.PREF_KEY, ""); }
    catch (e) { return []; }
    if (!raw) return [];
    let v = raw;
    if (typeof raw === "string") {
      try { v = JSON.parse(raw); }
      catch (e) { return []; }
    }
    return Array.isArray(v) ? v : [];
  },

  /** 写全量（pref 超限等异常静默——会话持久化不得影响问答本身） */
  _write(arr) {
    try {
      Prefs.set(this.PREF_KEY, JSON.stringify(Array.isArray(arr) ? arr : []));
      return true;
    } catch (e) { return false; }
  },

  _newId() {
    return "cs-" + Date.now().toString(36) + "-" +
      Math.random().toString(36).slice(2, 8);
  },

  /** 消息规范化（丢掉无法渲染的项；content 一律转字符串） */
  _normHistory(history) {
    const out = [];
    for (const h of (Array.isArray(history) ? history : [])) {
      if (!h || typeof h !== "object") continue;
      if (h.role !== "user" && h.role !== "assistant" && h.role !== "system") continue;
      if (h.content == null) continue;
      out.push({ role: h.role, content: String(h.content) });
    }
    return out;
  },

  /** 缺省标题：首条 user 消息压平空白后截 30 字 */
  _titleFrom(history) {
    for (const h of history) {
      if (h.role !== "user") continue;
      const flat = String(h.content || "").replace(/\s+/g, " ").trim();
      if (!flat) continue;
      return flat.slice(0, this.TITLE_MAX) +
        (flat.length > this.TITLE_MAX ? "…" : "");
    }
    return "";
  },

  _num(v) {
    const n = Number(v);
    return isFinite(n) && n > 0 ? Math.floor(n) : 0;
  },

  /** 条目是否可用于展示/恢复（至少要有 id 和非空 history） */
  _ok(e) {
    return !!(e && typeof e === "object" && e.id &&
      Array.isArray(e.history) && e.history.length);
  },

  /* ==================== 写 ==================== */

  /**
   * 保存会话。sess = {id?, itemID?, title?, history[], chips[]?}
   *   · history 为空 → 不保存，返回 null（清空即不落盘）
   *   · 同 id 覆盖并移到最前；缺省 id 自动生成
   *   · history 只留最近 40 条；title 缺省取首条 user 消息前 30 字
   * @returns {object|null} 规范化后的保存条目
   */
  save(sess) {
    if (!sess || typeof sess !== "object") return null;
    let history = this._normHistory(sess.history);
    if (!history.length) return null;
    if (history.length > this.MAX_MESSAGES) {
      history = history.slice(history.length - this.MAX_MESSAGES);
    }

    const itemID = this._num(sess.itemID);
    const id = String(sess.id || "").trim() || this._newId();
    let title = String(sess.title || "").replace(/\s+/g, " ").trim();
    if (!title) title = this._titleFrom(history);
    if (!title) title = itemID ? ("#" + itemID) : "会话";

    const chips = [];
    for (const c of (Array.isArray(sess.chips) ? sess.chips : [])) {
      const n = this._num(c);
      if (n && chips.indexOf(n) < 0) chips.push(n);
    }

    const entry = {
      id, itemID, title,
      ts: Date.now(),
      count: history.length,
      history,
      chips,
    };

    const arr = this._read().filter((e) => e && e.id !== id);
    arr.unshift(entry);
    this._write(arr.slice(0, this.MAX_SESSIONS));
    return entry;
  },

  /* ==================== 读 ==================== */

  /**
   * 会话摘要列表（不含 history 全文），供展示截断用。
   * @param {number=} limit 最多返回条数（缺省全部最多 50 条）
   * @returns {Array<{id,itemID,title,ts,count}>}
   */
  list(limit) {
    const out = [];
    for (const e of this._read()) {
      if (!this._ok(e)) continue;
      out.push({
        id: String(e.id),
        itemID: this._num(e.itemID),
        title: String(e.title || "(无标题)"),
        ts: Number(e.ts) || 0,
        count: Array.isArray(e.history) ? e.history.length : (Number(e.count) || 0),
      });
    }
    const n = Number(limit);
    if (isFinite(n) && n >= 0) return out.slice(0, Math.floor(n));
    return out;
  },

  /** 按 id 取完整条目；不存在 / 坏条目 → null */
  load(id) {
    const key = String(id || "").trim();
    if (!key) return null;
    for (const e of this._read()) {
      if (e && String(e.id) === key && this._ok(e)) return e;
    }
    return null;
  },

  /** 删除一条；返回是否确有删除 */
  remove(id) {
    const key = String(id || "").trim();
    if (!key) return false;
    const arr = this._read();
    const out = arr.filter((e) => !(e && String(e.id) === key));
    if (out.length === arr.length) return false;
    this._write(out);
    return true;
  },

  /** 同一文献最近一条完整会话（itemID 无效 / 无匹配 → null） */
  latestForItem(itemID) {
    const id = this._num(itemID);
    if (!id) return null;
    for (const e of this._read()) {
      if (this._ok(e) && this._num(e.itemID) === id) return e;
    }
    return null;
  },

  /** 全局最近一条完整会话 */
  latest() {
    for (const e of this._read()) {
      if (this._ok(e)) return e;
    }
    return null;
  },
};
