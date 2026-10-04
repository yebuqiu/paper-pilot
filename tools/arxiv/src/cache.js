"use strict";

/**
 * 磁盘缓存 + 增量状态存储。
 *
 * 两个独立对象：
 *   - `Cache`：按 key 存最终结果，带 TTL 与 LRU 容量上限。用于「同一查询一天内不重复打 arXiv」。
 *   - `StateStore`：存「增量更新的游标」——每个查询源已见过的 arXiv ID 集合与上次运行时间。
 *     两者不能混用：缓存可过期丢弃，增量状态必须长期保留（丢了就会重复推送老论文）。
 *
 * 健壮性纪律：缓存属于**纯优化**，任何磁盘异常都不允许打断主流程 —— 所有方法内部捕获并降级，
 * 由 logger 记录 warn。这一点是硬要求：用户磁盘只读 / 目录被占用时，检索仍必须可用。
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { CacheError } = require("./errors");
const { nullLogger } = require("./logger");

function sha1(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex");
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** 原子写：先写临时文件再 rename，避免进程中途被杀留下半截 JSON。 */
function atomicWrite(file, text) {
  const tmp = file + ".tmp" + process.pid;
  fs.writeFileSync(tmp, text, "utf8");
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    throw e;
  }
}

function readJsonSafe(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return null;
  }
}

class Cache {
  /**
   * @param {{dir:string, ttlMs?:number, maxEntries?:number, logger?:object, enabled?:boolean}} opts
   */
  constructor(opts) {
    const o = opts || {};
    this.dir = o.dir;
    this.ttlMs = o.ttlMs == null ? 86400000 : o.ttlMs;
    this.maxEntries = o.maxEntries == null ? 500 : o.maxEntries;
    this.enabled = o.enabled !== false;
    this.log = o.logger || nullLogger();
    this._indexFile = path.join(this.dir, "_index.json");
    this._statsFile = path.join(this.dir, "_stats.json");
    this._index = null;
    this._stats = null;
    this._available = true;
  }

  _keyFile(key) { return path.join(this.dir, sha1(key).slice(0, 32) + ".json"); }

  _loadIndex() {
    if (this._index) return this._index;
    this._index = readJsonSafe(this._indexFile) || { entries: {} };
    if (!this._index.entries) this._index.entries = {};
    return this._index;
  }

  _loadStats() {
    if (this._stats) return this._stats;
    this._stats = readJsonSafe(this._statsFile) || { hits: 0, misses: 0, writes: 0, evictions: 0 };
    return this._stats;
  }

  _saveStats() {
    try { if (this.enabled && this._available) atomicWrite(this._statsFile, JSON.stringify(this._loadStats())); }
    catch (e) { /* 统计失败无所谓 */ }
  }

  _saveIndex() {
    try { atomicWrite(this._indexFile, JSON.stringify(this._loadIndex())); }
    catch (e) { this.log.warn("缓存索引写入失败（已降级为无缓存）", { error: e.message }); this._available = false; }
  }

  /**
   * 读取缓存。
   * @param {string} key
   * @returns {{value:*, fetchedAt:string, ageMs:number, expiresAt:string, key:string}|null}
   */
  get(key) {
    if (!this.enabled || !this._available) return null;
    const stats = this._loadStats();
    try {
      const file = this._keyFile(key);
      if (!fs.existsSync(file)) { stats.misses++; this._saveStats(); return null; }
      const rec = JSON.parse(fs.readFileSync(file, "utf8"));
      const ageMs = Date.now() - Date.parse(rec.fetchedAt);
      const ttl = rec.ttlMs == null ? this.ttlMs : rec.ttlMs;
      if (!isFinite(ageMs) || ageMs > ttl) {
        try { fs.unlinkSync(file); } catch (e) { /* ignore */ }
        const idx = this._loadIndex();
        delete idx.entries[sha1(key).slice(0, 32)];
        this._saveIndex();
        stats.misses++;
        this._saveStats();
        return null;
      }
      const idx = this._loadIndex();
      const h = sha1(key).slice(0, 32);
      if (idx.entries[h]) idx.entries[h].lastAccess = new Date().toISOString();
      this._saveIndex();
      stats.hits++;
      this._saveStats();
      return { value: rec.value, fetchedAt: rec.fetchedAt, ageMs, expiresAt: new Date(Date.parse(rec.fetchedAt) + ttl).toISOString(), key };
    } catch (e) {
      this.log.warn("读缓存失败", { error: e.message, key });
      return null;
    }
  }

  /**
   * 写缓存。
   * @returns {boolean} 是否写入成功
   */
  set(key, value, opts) {
    if (!this.enabled || !this._available) return false;
    const o = opts || {};
    try {
      ensureDir(this.dir);
      const h = sha1(key).slice(0, 32);
      const fetchedAt = new Date().toISOString();
      const ttlMs = o.ttlMs == null ? this.ttlMs : o.ttlMs;
      const rec = { key, fetchedAt, ttlMs, value };
      const text = JSON.stringify(rec);
      atomicWrite(this._keyFile(key), text);
      const idx = this._loadIndex();
      idx.entries[h] = { key, fetchedAt, lastAccess: fetchedAt, bytes: Buffer.byteLength(text) };
      this._saveIndex();
      const stats = this._loadStats();
      stats.writes++;
      this._saveStats();
      if (Object.keys(idx.entries).length > this.maxEntries) this.prune();
      return true;
    } catch (e) {
      this.log.warn("写缓存失败（本次结果不缓存，不影响检索）", { error: e.message });
      return false;
    }
  }

  del(key) {
    try {
      const file = this._keyFile(key);
      if (fs.existsSync(file)) fs.unlinkSync(file);
      const idx = this._loadIndex();
      delete idx.entries[sha1(key).slice(0, 32)];
      this._saveIndex();
      return true;
    } catch (e) { return false; }
  }

  /** 清理过期条目；超出 maxEntries 时按 lastAccess 淘汰最旧的。 */
  prune() {
    const removed = { expired: 0, evicted: 0 };
    if (!this.enabled || !this._available) return removed;
    try {
      const idx = this._loadIndex();
      const now = Date.now();
      for (const h of Object.keys(idx.entries)) {
        const meta = idx.entries[h];
        const file = path.join(this.dir, h + ".json");
        const age = now - Date.parse(meta.fetchedAt || 0);
        if (!fs.existsSync(file) || !isFinite(age) || age > this.ttlMs) {
          try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (e) { /* ignore */ }
          delete idx.entries[h];
          removed.expired++;
        }
      }
      const rest = Object.keys(idx.entries);
      if (rest.length > this.maxEntries) {
        rest.sort((a, b) => String(idx.entries[a].lastAccess || "").localeCompare(String(idx.entries[b].lastAccess || "")));
        for (const h of rest.slice(0, rest.length - this.maxEntries)) {
          try { const f = path.join(this.dir, h + ".json"); if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) { /* ignore */ }
          delete idx.entries[h];
          removed.evicted++;
        }
      }
      this._saveIndex();
      const stats = this._loadStats();
      stats.evictions += removed.evicted + removed.expired;
      this._saveStats();
      return removed;
    } catch (e) {
      this.log.warn("缓存清理失败", { error: e.message });
      return removed;
    }
  }

  stats() {
    const s = Object.assign({}, this._loadStats());
    let entries = 0, bytes = 0, oldest = "", newest = "";
    if (this.enabled && this._available) {
      const idx = this._loadIndex();
      const keys = Object.keys(idx.entries);
      entries = keys.length;
      for (const h of keys) {
        const m = idx.entries[h] || {};
        bytes += m.bytes || 0;
        const at = String(m.fetchedAt || "");
        if (at) {
          if (!oldest || at < oldest) oldest = at;
          if (!newest || at > newest) newest = at;
        }
      }
    }
    return {
      dir: this.dir,
      enabled: this.enabled,
      available: this._available,
      entries,
      bytes,
      bytesHuman: humanBytes(bytes),
      oldestAt: oldest,
      newestAt: newest,
      ttlMs: this.ttlMs,
      maxEntries: this.maxEntries,
      hits: s.hits || 0,
      misses: s.misses || 0,
      writes: s.writes || 0,
      evictions: s.evictions || 0,
      hitRate: (s.hits || 0) + (s.misses || 0) > 0 ? (s.hits || 0) / ((s.hits || 0) + (s.misses || 0)) : 0,
    };
  }

  /** 清空缓存（保留目录）。 */
  clear() {
    const removed = { files: 0 };
    try {
      if (!fs.existsSync(this.dir)) return removed;
      for (const f of fs.readdirSync(this.dir)) {
        if (!/\.json$/.test(f)) continue;
        try { fs.unlinkSync(path.join(this.dir, f)); removed.files++; } catch (e) { /* ignore */ }
      }
      this._index = { entries: {} };
      this._stats = { hits: 0, misses: 0, writes: 0, evictions: 0 };
      this._saveIndex();
      this._saveStats();
      return removed;
    } catch (e) {
      throw new CacheError("清空缓存失败：" + e.message, { cause: e });
    }
  }
}

function humanBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + " B";
  if (v < 1048576) return (v / 1024).toFixed(1) + " KB";
  return (v / 1048576).toFixed(1) + " MB";
}

/**
 * 增量状态存储：记录「每个查询源已经看过的 arXiv ID」与「上次运行时间」。
 * 用于 `arxiv update`：只返回上次之后的新提交/新版本。
 */
class StateStore {
  /**
   * @param {{dir:string, maxSeen?:number, logger?:object}} opts
   */
  constructor(opts) {
    const o = opts || {};
    this.dir = o.dir;
    this.file = path.join(this.dir, "state.json");
    this.maxSeen = o.maxSeen == null ? 5000 : o.maxSeen;
    this.log = o.logger || nullLogger();
    this.data = null;
  }

  load() {
    if (this.data) return this.data;
    const raw = readJsonSafe(this.file);
    this.data = raw && typeof raw === "object" && raw.sources ? raw : { version: 1, updatedAt: "", sources: {} };
    return this.data;
  }

  save() {
    try {
      ensureDir(this.dir);
      this.load().updatedAt = new Date().toISOString();
      atomicWrite(this.file, JSON.stringify(this.data));
      return true;
    } catch (e) {
      this.log.warn("增量状态写入失败（下次运行会重复抓取，但不影响正确性）", { error: e.message });
      return false;
    }
  }

  _source(key) {
    const d = this.load();
    if (!d.sources[key]) d.sources[key] = { lastRunAt: "", seenIds: [], runs: 0 };
    const s = d.sources[key];
    if (!Array.isArray(s.seenIds)) s.seenIds = [];
    return s;
  }

  /** 已见过的 ID 集合。 */
  seenIds(key) { return new Set(this._source(key).seenIds); }
  lastRunAt(key) { return this._source(key).lastRunAt || ""; }
  runs(key) { return this._source(key).runs || 0; }

  /**
   * 记录一批已见 ID。保留最新的 maxSeen 个（数组尾部为新）。
   * @param {string} key
   * @param {string[]} ids
   */
  markSeen(key, ids) {
    const s = this._source(key);
    const set = new Set(s.seenIds);
    for (const id of ids || []) if (id) set.add(String(id));
    // Set 保持插入序 → 旧的在前；截断保留尾部（最新的）
    let arr = Array.from(set);
    if (arr.length > this.maxSeen) arr = arr.slice(arr.length - this.maxSeen);
    s.seenIds = arr;
    return s.seenIds.length;
  }

  touch(key) {
    const s = this._source(key);
    s.lastRunAt = new Date().toISOString();
    s.runs = (s.runs || 0) + 1;
    return s.lastRunAt;
  }

  reset(key) {
    const d = this.load();
    if (key) delete d.sources[key];
    else d.sources = {};
    return this.save();
  }

  summary() {
    const d = this.load();
    const keys = Object.keys(d.sources);
    return {
      file: this.file,
      sources: keys.length,
      updatedAt: d.updatedAt || "",
      detail: keys.map((k) => ({ key: k, seen: (d.sources[k].seenIds || []).length, lastRunAt: d.sources[k].lastRunAt || "", runs: d.sources[k].runs || 0 })),
    };
  }
}

module.exports = { Cache, StateStore, sha1, atomicWrite, ensureDir, humanBytes };
