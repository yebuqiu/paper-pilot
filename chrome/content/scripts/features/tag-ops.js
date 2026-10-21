// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 标签管理 · 数据与规则层（0.70.0）
 *
 * 背景：Zotero 左下角 tag selector 的原生右键只有「指派颜色 / 重命名 / 拆分 / 删除」
 * 四条**单标签**操作（#tag-menu，见 zoteroPane.xhtml），删除直接 DELETE itemTags 行，
 * 不可撤销、不能多选、没有规则化能力。标签一旦被 AI 打标 + 手动打标混用，
 * 长尾与变体就会失控，「一条条右键删」实际不可行。
 *
 * 本模块只提供**能力**，不做交互（UI 在 tag-manager.xhtml / tag-manager.js）：
 *   A. 纯函数层：筛选、改名规划、合并规划、层级规划、快照 diff、CSV、共现、统计。
 *      全部不触碰 Zotero，可在 Node vm 里单测。
 *   B. 数据层：扫描（含手动/自动分布与颜色）、受影响条目、批量删除/改名/改色、
 *      快照落盘与撤销、报告笔记。
 *
 * 纪律：
 *  - 破坏性操作**永不隐式执行**：先 plan*() 出清单，UI 确认后才 apply*()。
 *  - 删除前必须 snapshot()（removeFromLibrary 不可撤销，只能靠快照回滚）。
 *  - 群组库：libraryID 一律由调用方传入或 libraryID() 现取，**不写死 userLibraryID**
 *    （TagCurator.collectTagStats 的老毛病，这里不重犯）。
 *  - IOUtils.writeUTF8 **永不传 mode**（传 mode 会截断/权限异常，见项目铁律 4）。
 */
/* global Zotero, IOUtils, PathUtils, MdLite */

var TagOps = {
  /* ==================== 常量 ==================== */

  PREF_PROTECT: "extensions.zotero.papilot.tagProtect",
  PREF_KEEP: "extensions.zotero.papilot.tagSnapshotKeep",
  SNAPSHOT_FILE: "tag-snapshots.json",
  MAX_TAG_LEN: 255,
  MAX_COLORED: 9,
  MAX_KEEP_DEFAULT: 30,

  /** 系统标签默认保护（AI 打标 / 治理自己写的），可在保护名单里改 */
  DEFAULT_PROTECT: ["#状态/*", "#治理/*"],

  _cache: new Map(),
  _cacheMs: 30000,

  /* ==================== 纯函数层 ==================== */

  /** 展示用归一：去首尾空白、合并内部空白、去尾随标点（不做大小写变换） */
  norm(name) {
    let s = String(name == null ? "" : name);
    s = s.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
    s = s.replace(/\u3000/g, " ");
    s = s.replace(/\s+/g, " ").trim();
    s = s.replace(/[.。,，;；:：!！?？·、]+$/g, "").trim();
    return s;
  },

  /** 比对用 key：忽略大小写/全半角/空白/连字符下划线（用于变体聚类与查重） */
  shapeKey(name) {
    return this.norm(name)
      .toLowerCase()
      .replace(/[／\\]/g, "/")
      .replace(/[\s\-_]+/g, "")
      .replace(/[，,、;；]/g, "");
  },

  /** 层级切分：全角斜杠/反斜杠统一为 "/"，各段去空白，空段丢弃 */
  splitPath(name) {
    return String(name == null ? "" : name)
      .replace(/[／\\]+/g, "/")
      .split("/")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  },

  /** 层级深度：单段 = 1 */
  depth(name) {
    return this.splitPath(name).length;
  },

  /** 名称校验（写库前的最后一道闸） */
  isValidName(name) {
    const s = String(name == null ? "" : name);
    const zh = (Zotero && Zotero.locale || "").toLowerCase().startsWith("zh");
    if (!s.trim()) return { ok: false, reason: zh ? "标签名为空" : "Empty tag name" };
    if (s.length > this.MAX_TAG_LEN) {
      return { ok: false, reason: (zh ? "超过 " : "Longer than ") + this.MAX_TAG_LEN + (zh ? " 字符" : " chars") };
    }
    // 换行/制表符会把 tag selector 的布局与 CSV 一起搞坏
    if (/[\r\n\t]/.test(s)) {
      return { ok: false, reason: zh ? "含换行或制表符" : "Contains newline/tab" };
    }
    return { ok: true, reason: "" };
  },

  /** 通配符（* ?）→ 正则；其余字符转义 */
  globToRegExp(pat) {
    const src = String(pat == null ? "" : pat)
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    try { return new RegExp("^" + src + "$", "i"); } catch (e) { return null; }
  },

  /** 保护名单匹配：支持通配符与多层前缀（`#状态/*` 命中 `#状态/待读`） */
  isProtected(name, patterns) {
    // 传了数组但全是空串时仍然回退到默认名单：否则 `['', ' ']` 会让系统标签失去保护
    let list = (Array.isArray(patterns) && patterns.length ? patterns : this.DEFAULT_PROTECT)
      .filter((p) => String(p == null ? "" : p).trim());
    if (!list.length) list = this.DEFAULT_PROTECT;
    for (const p of list) {
      const pat = String(p || "").trim();
      if (!pat) continue;
      const re = this.globToRegExp(pat);
      if (re && re.test(name)) return true;
      // `a/b` 这类前缀写法顺带保护其子树
      if (pat.endsWith("/") && String(name).startsWith(pat)) return true;
    }
    return false;
  },

  /**
   * 单标签是否命中筛选条件
   * @param {{name:string,count:number,manual?:number,auto?:number,color?:string,protected?:boolean}} tag
   * @param {Object} f 条件（全部可选，缺省即不限）：
   *   q 文本 / min,max 使用数 / prefix,suffix 字面 / regex 正则串 / invalidRegex
   *   type: "manual"|"auto"|"both" / depthMin,depthMax / path 子树
   *   color: "any"|"colored"|"uncolored"|具体色值 / protect: "any"|"protected"|"unprotected"
   */
  matchFilter(tag, f) {
    if (!tag || !tag.name) return false;
    const c = f || {};
    const name = tag.name;

    if (c.q) {
      const q = String(c.q).toLowerCase();
      if (!name.toLowerCase().includes(q)) return false;
    }
    if (typeof c.min === "number" && (tag.count || 0) < c.min) return false;
    if (typeof c.max === "number" && (tag.count || 0) > c.max) return false;
    if (c.prefix && !name.startsWith(c.prefix)) return false;
    if (c.suffix && !name.endsWith(c.suffix)) return false;
    if (c.regex) {
      let re = null;
      try { re = new RegExp(c.regex, "i"); } catch (e) { re = null; }
      if (!re) return false; // 非法正则 = 不命中（由 planFilter 单独报告）
      if (!re.test(name)) return false;
    }
    if (c.type === "manual" && !(tag.manual > 0)) return false;
    if (c.type === "auto" && !(tag.auto > 0)) return false;
    // 「仅 X」必须**同时**排除另一类；缺失类型字段（快照/CSV 导入的 {name,count}）视为不命中，
    // 否则 undefined 比较两头都为 false，会让互斥的两个筛选同时放行同一条目。
    if (c.type === "onlyManual" && !((tag.manual || 0) > 0 && !((tag.auto || 0) > 0))) return false;
    if (c.type === "onlyAuto" && !((tag.auto || 0) > 0 && !((tag.manual || 0) > 0))) return false;
    const d = this.depth(name);
    if (typeof c.depthMin === "number" && d < c.depthMin) return false;
    if (typeof c.depthMax === "number" && d > c.depthMax) return false;
    if (c.path) {
      const p = String(c.path).replace(/[／\\]+/g, "/").replace(/\/+$/, "");
      if (p && name !== p && !name.startsWith(p + "/")) return false;
    }
    if (c.color === "colored" && !tag.color) return false;
    if (c.color === "uncolored" && tag.color) return false;
    if (c.color && c.color !== "colored" && c.color !== "uncolored" && c.color !== "any") {
      if (String(tag.color || "").toLowerCase() !== String(c.color).toLowerCase()) return false;
    }
    if (c.protect === "protected" && !tag.protected) return false;
    if (c.protect === "unprotected" && tag.protected) return false;
    return true;
  },

  /** 批量筛选（纯函数；顺序保持输入顺序） */
  filterTags(tags, f) {
    return (tags || []).filter((t) => this.matchFilter(t, f));
  },

  /** 正则是否合法（UI 即时校验用） */
  isValidRegex(src) {
    if (!src) return true;
    try { new RegExp(src); return true; } catch (e) { return false; }
  },

  /**
   * 按改名规则算出新名字（纯函数）
   * @param {string} name
   * @param {Object} r 规则：
   *   find, replace, regex(bool), caseSensitive(bool), wholeName(bool)
   *   prefix, suffix: 追加（在改名之后）
   *   prefixStrip: 先剥掉该前缀（字面）
   *   caseMode: ""|"lower"|"upper"|"capitalize"
   *   trimPunct(bool) 去尾随标点 / halfWidth(bool) 全角转半角 / collapseSpace(bool)
   *   depthCap(number) 层级过深时截断
   * @returns {string}
   */
  applyRenames(name, r) {
    const rule = r || {};
    let s = String(name == null ? "" : name);

    if (rule.prefixStrip) {
      const p = String(rule.prefixStrip);
      if (p && s.startsWith(p)) s = s.slice(p.length);
    }

    if (rule.find) {
      const find = String(rule.find);
      if (rule.regex) {
        let re = null;
        try { re = new RegExp(find, rule.caseSensitive ? "g" : "gi"); } catch (e) { re = null; }
        if (re) s = s.replace(re, rule.replace == null ? "" : String(rule.replace));
      } else if (rule.wholeName) {
        const same = rule.caseSensitive ? s === find : s.toLowerCase() === find.toLowerCase();
        if (same) s = rule.replace == null ? "" : String(rule.replace);
      } else {
        // 字面替换（区分大小写时用 split/join，避免正则元字符）
        if (rule.caseSensitive) {
          s = s.split(find).join(rule.replace == null ? "" : String(rule.replace));
        } else {
          const re = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
          s = s.replace(re, rule.replace == null ? "" : String(rule.replace));
        }
      }
    }

    if (rule.trimPunct) s = this.norm(s);
    if (rule.halfWidth !== false) {
      s = s.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
        .replace(/\u3000/g, " ");
    }
    if (rule.collapseSpace !== false) s = s.replace(/\s+/g, " ").trim();

    if (rule.caseMode === "lower") s = s.toLowerCase();
    else if (rule.caseMode === "upper") s = s.toUpperCase();
    else if (rule.caseMode === "capitalize") {
      s = s.replace(/(^|[\s/\-])(\p{L})/gu, (m, p, ch) => p + ch.toUpperCase());
    }

    if (rule.depthCap && this.depth(s) > rule.depthCap) {
      s = this.splitPath(s).slice(0, rule.depthCap).join("/");
    }

    if (rule.prefix) s = String(rule.prefix) + s;
    if (rule.suffix) s = s + String(rule.suffix);

    return s;
  },

  /**
   * 改名计划（纯函数）
   * @returns {{changes:Array<{from,to,kind}>, conflicts:Array, invalid:Array, unchanged:number}}
   *   kind: "rename"（目标不存在）| "merge"（目标已存在，等价于合并）
   *   conflicts: 同一批里多个旧名映射到同一新名 → 合并后仍可行，但提示用户
   */
  planRename(tags, rules, opts) {
    const o = opts || {};
    const exist = new Set((tags || []).map((t) => t.name));
    const chosen = new Set((o.only || []).map((t) => (typeof t === "string" ? t : t.name)));
    const all = chosen.size ? (tags || []).filter((t) => chosen.has(t.name)) : (tags || []);
    const changes = [];
    const invalid = [];
    const targetOf = new Map();
    let unchanged = 0;

    for (const t of all) {
      const to = this.applyRenames(t.name, rules);
      if (to === t.name) { unchanged++; continue; }
      const v = this.isValidName(to);
      if (!v.ok) { invalid.push({ from: t.name, to, reason: v.reason }); continue; }
      if (targetOf.has(to)) {
        // 同一批两条改到同一个新名：后者的 from 会被前者吞掉，提示
        invalid.push({
          from: t.name, to,
          reason: (o.zh ? "与「" : "Conflicts with \"") + targetOf.get(to) + (o.zh ? "」改后同名" : "\""),
        });
        continue;
      }
      targetOf.set(to, t.name);
      changes.push({ from: t.name, to, kind: exist.has(to) ? "merge" : "rename" });
    }
    return { changes, conflicts: changes.filter((c) => c.kind === "merge"), invalid, unchanged };
  },

  /** 合并计划：把 selected 全部并到 target（排除 target 自身） */
  planMerge(tags, target, opts) {
    const o = opts || {};
    const tgt = String(target || "").trim();
    const v = this.isValidName(tgt);
    if (!v.ok) return { changes: [], conflicts: [], invalid: [{ from: "", to: tgt, reason: v.reason }], unchanged: 0 };
    const exist = new Set((tags || []).map((t) => t.name));
    if (!exist.has(tgt)) {
      return {
        changes: [], conflicts: [], unchanged: 0,
        invalid: [{ from: "", to: tgt, reason: (o.zh ? "目标标签不存在（合并请用重命名表单）" : "Target tag does not exist") }],
      };
    }
    const changes = [];
    const seen = new Set();
    for (const t of (tags || [])) {
      if (!t || !t.name || t.name === tgt) continue;
      if (seen.has(t.name)) continue;
      seen.add(t.name);
      changes.push({ from: t.name, to: tgt, kind: "merge" });
    }
    return { changes, conflicts: [], invalid: [], unchanged: 0 };
  },

  /**
   * 加层级父节点：`a/b` → `父/a/b`（只处理已有该路径的标签）
   * @param {Array} tags
   * @param {string} parent 父段（可含多级 `x/y`）
   * @param {Object} o {zh, only, skipNested:boolean 已是该父级子节点则跳过}
   */
  planAddParent(tags, parent, o) {
    const opt = o || {};
    const par = String(parent || "").replace(/[／\\]+/g, "/").replace(/^\/+|\/+$/g, "").trim();
    if (!par) {
      return { changes: [], conflicts: [], unchanged: 0, invalid: [{ from: "", to: "", reason: opt.zh ? "父级为空" : "Empty parent" }] };
    }
    const chosen = new Set((opt.only || []).map((t) => (typeof t === "string" ? t : t.name)));
    const all = chosen.size ? (tags || []).filter((t) => chosen.has(t.name)) : (tags || []);
    const exist = new Set((tags || []).map((t) => t.name));
    const changes = [];
    const invalid = [];
    const targetOf = new Set();
    let unchanged = 0;
    for (const t of all) {
      if (opt.skipNested !== false && t.name.startsWith(par + "/")) { unchanged++; continue; }
      const to = par + "/" + t.name;
      const v = this.isValidName(to);
      if (!v.ok) { invalid.push({ from: t.name, to, reason: v.reason }); continue; }
      if (exist.has(to) || targetOf.has(to)) { unchanged++; continue; }
      targetOf.add(to);
      changes.push({ from: t.name, to, kind: "rename" });
    }
    return { changes, conflicts: [], unchanged, invalid };
  },

  /**
   * 换父节点：把 `old/x` → `new/x`（含多层 old，只替换**首段**匹配）
   * @param {Object} o {zh, only, anywhere:boolean 匹配任意段而非仅首段}
   */
  planReparent(tags, oldSeg, newSeg, o) {
    const opt = o || {};
    const from = String(oldSeg || "").replace(/[／\\]+/g, "/").replace(/^\/+|\/+$/g, "").trim();
    const to = String(newSeg || "").replace(/[／\\]+/g, "/").replace(/^\/+|\/+$/g, "").trim();
    if (!from || !to) {
      return { changes: [], conflicts: [], unchanged: 0, invalid: [{ from: "", to: "", reason: opt.zh ? "父级为空" : "Empty parent" }] };
    }
    const chosen = new Set((opt.only || []).map((t) => (typeof t === "string" ? t : t.name)));
    const all = chosen.size ? (tags || []).filter((t) => chosen.has(t.name)) : (tags || []);
    const exist = new Set((tags || []).map((t) => t.name));
    const changes = [];
    const invalid = [];
    let unchanged = 0;
    for (const t of all) {
      const segs = this.splitPath(t.name);
      const idx = opt.anywhere ? segs.indexOf(from) : (segs[0] === from ? 0 : -1);
      if (idx < 0) { unchanged++; continue; }
      const next = segs.slice();
      next[idx] = to;
      const toName = next.join("/");
      if (toName === t.name || exist.has(toName)) { unchanged++; continue; }
      const v = this.isValidName(toName);
      if (!v.ok) { invalid.push({ from: t.name, to: toName, reason: v.reason }); continue; }
      changes.push({ from: t.name, to: toName, kind: "rename" });
    }
    return { changes, conflicts: [], unchanged, invalid };
  },

  /** 剥前缀计划（`tmp-abc` → `abc`） */
  planStripPrefix(tags, prefix, o) {
    const opt = o || {};
    const p = String(prefix || "");
    if (!p) return { changes: [], conflicts: [], unchanged: 0, invalid: [] };
    const chosen = new Set((opt.only || []).map((t) => (typeof t === "string" ? t : t.name)));
    const all = chosen.size ? (tags || []).filter((t) => chosen.has(t.name)) : (tags || []);
    const exist = new Set((tags || []).map((t) => t.name));
    const changes = [];
    const invalid = [];
    let unchanged = 0;
    for (const t of all) {
      if (!t.name.startsWith(p)) { unchanged++; continue; }
      const to = t.name.slice(p.length);
      const v = this.isValidName(to);
      if (!v.ok) { invalid.push({ from: t.name, to, reason: v.reason }); continue; }
      if (exist.has(to)) { unchanged++; continue; }
      changes.push({ from: t.name, to, kind: "rename" });
    }
    return { changes, conflicts: [], unchanged, invalid };
  },

  /** 颜色分配：给定已占用 position 集合，为一组新标签找空位（MAX_COLORED=9） */
  planColorSlots(usedPositions, n) {
    const used = new Set((usedPositions || []).map((x) => Number(x)));
    const slots = [];
    for (let i = 0; i < this.MAX_COLORED && slots.length < n; i++) {
      if (!used.has(i)) slots.push(i);
    }
    return slots;
  },

  /* ---------- 分析 ---------- */

  /** 统计概览（纯函数） */
  stats(tags) {
    const list = (tags || []).filter((t) => t && t.name);
    const counts = list.map((t) => t.count || 0).sort((a, b) => a - b);
    const total = counts.reduce((n, c) => n + c, 0);
    const half = total / 2;
    let acc = 0;
    let median = 0;
    for (const c of counts) { acc += c; if (acc >= half) { median = c; break; } }
    const buckets = { zero: 0, one: 0, few: 0, many: 0 };
    for (const c of counts) {
      if (c === 0) buckets.zero++;
      else if (c === 1) buckets.one++;
      else if (c <= 5) buckets.few++;
      else buckets.many++;
    }
    const top = [...list].sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, 20);
    return {
      unique: list.length,
      total,
      avg: list.length ? +(total / list.length).toFixed(2) : 0,
      max: counts.length ? counts[counts.length - 1] : 0,
      median,
      buckets,
      colored: list.filter((t) => t.color).length,
      nested: list.filter((t) => this.depth(t.name) > 1).length,
      protectedCount: list.filter((t) => t.protected).length,
      top,
    };
  },

  /** 标签共现：常一起出现的标签对（用于建议建层级/合并） */
  cooccurrence(byItem, minCount) {
    const min = typeof minCount === "number" ? minCount : 3;
    const pair = new Map();
    for (const tags of (byItem || [])) {
      const uniq = [...new Set((tags || []).filter(Boolean))].sort();
      for (let i = 0; i < uniq.length; i++) {
        for (let j = i + 1; j < uniq.length; j++) {
          const k = uniq[i] + "\u0000" + uniq[j];
          pair.set(k, (pair.get(k) || 0) + 1);
        }
      }
    }
    return [...pair.entries()]
      .map(([k, n]) => { const [a, b] = k.split("\u0000"); return { a, b, n }; })
      .filter((x) => x.n >= min)
      .sort((x, y) => y.n - x.n || x.a.localeCompare(y.a));
  },

  /** 排序（返回新数组） */
  sortBy(tags, key, dir) {
    const k = key || "name";
    const sign = dir === "desc" ? -1 : 1;
    const val = (t) => {
      if (k === "count") return t.count || 0;
      if (k === "depth") return this.depth(t.name);
      if (k === "type") return (t.manual > 0 ? 1 : 0) * 2 + (t.auto > 0 ? 1 : 0);
      return t.name || "";
    };
    return [...(tags || [])].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      if (typeof va === "number" && typeof vb === "number") return sign * (va - vb) || a.name.localeCompare(b.name);
      return sign * String(va).localeCompare(String(vb));
    });
  },

  /* ---------- 导入导出 ---------- */

  /** CSV 导出：name,count,type,color,protected（引号转义） */
  toCSV(tags) {
    const q = (s) => '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"';
    const head = "name,count,manual,auto,color,protected";
    const rows = (tags || []).map((t) => [
      q(t.name), t.count || 0, t.manual || 0, t.auto || 0, q(t.color || ""), t.protected ? 1 : 0,
    ].join(","));
    return head + "\n" + rows.join("\n") + "\n";
  },

  /** CSV 解析（支持引号内逗号/换行；返回 {name,count,color,protected}[]） */
  parseCSV(text) {
    const src = String(text == null ? "" : text).replace(/^\uFEFF/, "");
    const rows = [];
    let field = "";
    let row = [];
    let inQ = false;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (inQ) {
        if (ch === '"') {
          if (src[i + 1] === '"') { field += '"'; i++; }
          else inQ = false;
        } else field += ch;
        continue;
      }
      if (ch === '"') { inQ = true; continue; }
      if (ch === ",") { row.push(field); field = ""; continue; }
      if (ch === "\r") continue;
      if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
      field += ch;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    if (!rows.length) return [];

    const head = rows[0].map((s) => s.trim().toLowerCase());
    const hasHead = head.includes("name");
    const idx = (k) => head.indexOf(k);
    const iName = hasHead ? idx("name") : 0;
    const iCount = hasHead ? idx("count") : 1;
    const iColor = hasHead ? idx("color") : 4;
    const iProt = hasHead ? idx("protected") : 5;

    const out = [];
    for (const r of (hasHead ? rows.slice(1) : rows)) {
      const name = this.norm(r[iName]);
      if (!name) continue;
      const cnt = iCount >= 0 ? Number(r[iCount]) : 0;
      out.push({
        name,
        count: Number.isFinite(cnt) ? cnt : 0,
        color: iColor >= 0 ? String(r[iColor] || "").trim() : "",
        protected: iProt >= 0 ? /^(1|true|yes|y)$/i.test(String(r[iProt] || "").trim()) : false,
      });
    }
    return out;
  },

  /* ==================== 数据层 ==================== */

  /** 当前选中的库（群组库也能取到；取不到才退回用户库） */
  libraryID() {
    try {
      const zp = Zotero.getActiveZoteroPane();
      if (zp && typeof zp.getSelectedLibraryID === "function") {
        const id = zp.getSelectedLibraryID();
        if (id) return id;
      }
      if (zp && zp.selectedLibraryID) return zp.selectedLibraryID;
    } catch (e) { /* ignore */ }
    return Zotero.Libraries.userLibraryID;
  },

  /** 保护名单（pref 里存逗号或换行分隔；为空用默认系统标签） */
  protectList() {
    // 注意：Zotero.Prefs.get(key, true) 的第二个参数是 global 标志**不是默认值**，
    // pref 未设置时可能回 undefined（甚至 true），必须按类型收口 —— 否则 "true" 会
    // 变成一个叫 true 的保护规则，系统标签就失去保护了（0.70.0 真机前发现）。
    let raw = "";
    try {
      const v = Zotero.Prefs.get(this.PREF_PROTECT, true);
      raw = typeof v === "string" ? v : "";
    } catch (e) { raw = ""; }
    const list = String(raw).split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    return list.length ? list : this.DEFAULT_PROTECT.slice();
  },

  setProtectList(list) {
    const clean = [...new Set((list || []).map((s) => String(s).trim()).filter(Boolean))];
    try { Zotero.Prefs.set(this.PREF_PROTECT, clean.join("\n"), true); } catch (e) { /* ignore */ }
    this.invalidate();
    return clean;
  },

  invalidate(libraryID) {
    if (libraryID) this._cache.delete(libraryID);
    else this._cache.clear();
  },

  /**
   * 扫描库内全部标签
   * @param {number} [libID]
   * @param {{force?:boolean, onProgress?:function}} [opts]
   * @returns {Promise<{libraryID:number, tags:Array, items:number, stats:Object}>}
   *   tags: [{name, count, manual, auto, color, protected, depth}]
   */
  async collect(libID, opts) {
    const o = opts || {};
    const libraryID = libID || this.libraryID();
    const hit = this._cache.get(libraryID);
    if (!o.force && hit && Date.now() - hit.at < this._cacheMs) return hit.data;

    const counts = new Map(); // name -> {count, manual, auto}
    const s = new Zotero.Search();
    s.libraryID = libraryID;
    s.addCondition("itemType", "isNot", "attachment");
    const ids = await s.search();
    let done = 0;
    for (const id of ids) {
      const item = await Zotero.Items.getAsync(id);
      if (!item || item.deleted) continue;
      let tags = [];
      try { tags = item.getTags() || []; } catch (e) { tags = []; }
      for (const t of tags) {
        const name = t && t.tag;
        if (!name) continue;
        const rec = counts.get(name) || { count: 0, manual: 0, auto: 0 };
        rec.count++;
        if (Number(t.type) === 1) rec.auto++; else rec.manual++;
        counts.set(name, rec);
      }
      done++;
      if (o.onProgress && done % 50 === 0) {
        try { o.onProgress(done, ids.length); } catch (e) { /* ignore */ }
      }
    }

    // 颜色：一次取全库映射（name -> {color, position}）
    const colors = new Map();
    try {
      if (Zotero.Tags && typeof Zotero.Tags.getColors === "function") {
        const m = Zotero.Tags.getColors(libraryID);
        if (m && typeof m.forEach === "function") m.forEach((v, k) => colors.set(k, v));
      }
    } catch (e) { /* ignore */ }

    const protect = this.protectList();
    const tags = [...counts.entries()].map(([name, rec]) => ({
      name,
      count: rec.count,
      manual: rec.manual,
      auto: rec.auto,
      color: (colors.get(name) || {}).color || "",
      position: (colors.get(name) || {}).position,
      protected: this.isProtected(name, protect),
      depth: this.depth(name),
    }));

    const data = { libraryID, tags, items: ids.length, stats: this.stats(tags), at: Date.now() };
    this._cache.set(libraryID, { at: Date.now(), data });
    return data;
  },

  /**
   * 受影响条目（删除/合并前预览）
   * @param {number} libraryID
   * @param {string[]} names
   * @param {{limit?:number}} [opts] limit 只取前 N 条（默认 200）
   */
  async itemsFor(libraryID, names, opts) {
    const o = opts || {};
    const want = new Set((names || []).filter(Boolean));
    const limit = o.limit || 200;
    const out = [];
    const byTag = {};
    let total = 0;
    if (!want.size) return { total: 0, items: [], byTag, truncated: false };

    // 逐个标签搜索（比遍历全库快，且能拿到每标签命中）
    for (const name of want) {
      let ids = [];
      try {
        const s = new Zotero.Search();
        s.libraryID = libraryID;
        s.addCondition("tag", "is", name);
        ids = await s.search();
      } catch (e) { ids = []; }
      byTag[name] = ids.length;
      total += ids.length;
      for (const id of ids) {
        if (out.length >= limit) continue;
        if (out.some((x) => x.id === id)) continue;
        try {
          const item = await Zotero.Items.getAsync(id);
          if (!item || item.deleted) continue;
          out.push({ id, title: (item.getDisplayTitle && item.getDisplayTitle()) || "", tag: name });
        } catch (e) { /* ignore */ }
      }
    }
    return { total, items: out, byTag, truncated: total > out.length };
  },

  /** 名称 → tagID（不存在返回 false） */
  tagID(name) {
    try {
      if (Zotero.Tags && typeof Zotero.Tags.getID === "function") return Zotero.Tags.getID(name);
    } catch (e) { /* ignore */ }
    return false;
  },

  /** 批量删除（调用方必须先 snapshot） */
  async deleteTags(libraryID, names, onProgress) {
    const ids = [];
    const missing = [];
    for (const n of (names || [])) {
      const id = this.tagID(n);
      if (id) ids.push(id); else missing.push(n);
    }
    if (!ids.length) return { removed: 0, missing };
    await Zotero.Tags.removeFromLibrary(libraryID, ids, onProgress);
    this.invalidate(libraryID);
    return { removed: ids.length, missing };
  },

  /** 批量改名/合并（changes: [{from,to}]） */
  async renameTags(libraryID, changes, onProgress) {
    const list = (changes || []).filter((c) => c && c.from && c.to && c.from !== c.to);
    let done = 0;
    const failed = [];
    for (const c of list) {
      try {
        await Zotero.Tags.rename(libraryID, c.from, c.to);
      } catch (e) {
        // 逐条回退：按标签搜索 → 逐条目重写
        try {
          const s = new Zotero.Search();
          s.libraryID = libraryID;
          s.addCondition("tag", "is", c.from);
          const ids = await s.search();
          for (const id of ids) {
            const item = await Zotero.Items.getAsync(id);
            if (!item) continue;
            const next = [];
            for (const t of item.getTags() || []) {
              next.push({ tag: t.tag === c.from ? c.to : t.tag, type: t.type });
            }
            item.setTags(next);
            await item.saveTx();
          }
        } catch (e2) {
          failed.push({ ...c, error: String(e2 && e2.message || e2) });
        }
      }
      done++;
      if (onProgress) { try { onProgress(done, list.length); } catch (e) { /* ignore */ } }
    }
    this.invalidate(libraryID);
    return { done: list.length - failed.length, failed };
  },

  /** 批量改色（color 传 "" 表示清除；position 自动分配空闲槽） */
  async applyColors(libraryID, names, color) {
    const list = (names || []).filter(Boolean);
    if (!list.length) return { applied: 0 };
    const m = Zotero.Tags.getColors(libraryID);
    const used = [];
    if (m && typeof m.forEach === "function") m.forEach((v) => used.push(v.position));
    let slots = color ? this.planColorSlots(used, list.length) : [];
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const name = list[i];
      try {
        if (!color) {
          await Zotero.Tags.setColor(libraryID, name, false);
        } else {
          // 槽位不够（已有 9 个彩色标签）时复用最后一个槽，颜色仍会被写入
          const pos = slots[i] != null ? slots[i] : this.MAX_COLORED - 1;
          await Zotero.Tags.setColor(libraryID, name, color, pos);
        }
        n++;
      } catch (e) { /* 单条失败不打断整批 */ }
    }
    this.invalidate(libraryID);
    return { applied: n, noSlot: color && list.length > slots.length };
  },

  /* ---------- 快照 / 撤销 ---------- */

  async _snapPath() {
    const base = (Zotero.DataDirectory && Zotero.DataDirectory.dir) || "";
    if (!base) return null;
    const dir = PathUtils.join(base, "papilot");
    try {
      await IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true });
    } catch (e) { /* 已存在 */ }
    return PathUtils.join(dir, this.SNAPSHOT_FILE);
  },

  async listSnapshots() {
    try {
      const p = await this._snapPath();
      if (!p) return [];
      if (!(await IOUtils.exists(p))) return [];
      const txt = await IOUtils.readUTF8(p);
      const arr = JSON.parse(txt);
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  },

  async _writeSnapshots(list) {
    let keep = 0;
    try {
      const v = Zotero.Prefs.get(this.PREF_KEEP, true);
      // 同 protectList：第二参是 global 标志，未设置时可能是 undefined/true，
      // 直接 Number(true) 会得到 1，快照就只剩 5 条（Math.max 下限）
      keep = typeof v === "number" ? v : parseInt(v, 10);
    } catch (e) { keep = 0; }
    if (!Number.isFinite(keep) || keep <= 0) keep = this.MAX_KEEP_DEFAULT;
    const arr = (list || []).slice(0, Math.max(5, keep));
    try {
      const p = await this._snapPath();
      if (!p) return false;
      await IOUtils.writeUTF8(p, JSON.stringify(arr), { tmpPath: p + ".tmp" });
      return true;
    } catch (e) {
      try { Zotero.logError(e); } catch (e2) { /* ignore */ }
      return false;
    }
  },

  /**
   * 记录一次操作前的现场（删除/改名/改色都要先调）
   * @param {number} libraryID
   * @param {string[]} names 受影响标签
   * @param {{op:string}} meta
   * @returns {Promise<Object|null>} 快照对象（写盘失败也返回，供本次撤销用）
   */
  async snapshot(libraryID, names, meta) {
    const list = (names || []).filter(Boolean);
    const items = {};
    const colors = {};
    let m = null;
    try { m = Zotero.Tags.getColors(libraryID); } catch (e) { m = null; }
    for (const name of list) {
      const ids = [];
      try {
        const tagID = this.tagID(name);
        if (tagID) {
          const got = await Zotero.Tags.getTagItems(libraryID, tagID);
          for (const id of (got || [])) ids.push(id);
        }
      } catch (e) { /* ignore */ }
      items[name] = ids;
      const c = m && typeof m.get === "function" ? m.get(name) : null;
      if (c) colors[name] = { color: c.color, position: c.position };
    }
    const snap = {
      id: "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      at: new Date().toISOString(),
      libraryID,
      op: (meta && meta.op) || "delete",
      note: (meta && meta.note) || "",
      names: list,
      items,
      colors,
      changes: (meta && meta.changes) || null,
    };
    const all = await this.listSnapshots();
    all.unshift(snap);
    await this._writeSnapshots(all);
    return snap;
  },

  /**
   * 撤销一个快照（只回滚「加回标签 / 反向改名 / 反向改色」）
   * @param {string} id
   * @param {function} [onProgress]
   * @returns {Promise<{ok:boolean, restored:number, skipped:number, error?:string}>}
   */
  async undo(id, onProgress) {
    const all = await this.listSnapshots();
    const snap = all.find((s) => s.id === id);
    if (!snap) return { ok: false, restored: 0, skipped: 0, error: "snapshot not found" };
    const libraryID = snap.libraryID || this.libraryID();
    let restored = 0;
    let skipped = 0;

    try {
      if (snap.op === "rename" && Array.isArray(snap.changes)) {
        for (const c of snap.changes.slice().reverse()) {
          try {
            await Zotero.Tags.rename(libraryID, c.to, c.from);
            restored++;
          } catch (e) { skipped++; }
        }
      } else if (snap.op === "color") {
        for (const [name, c] of Object.entries(snap.colors || {})) {
          try {
            if (c.color) await Zotero.Tags.setColor(libraryID, name, c.color, c.position);
            else await Zotero.Tags.setColor(libraryID, name, false);
            restored++;
          } catch (e) { skipped++; }
        }
      } else {
        // delete / 其它：按快照把标签加回条目
        const names = snap.names || [];
        let done = 0;
        for (const name of names) {
          const ids = (snap.items || {})[name] || [];
          for (const itemID of ids) {
            try {
              const item = await Zotero.Items.getAsync(itemID);
              if (!item || item.deleted) { skipped++; continue; }
              const has = (item.getTags() || []).some((t) => t.tag === name);
              if (!has) {
                item.addTag(name);
                await item.saveTx();
              }
              restored++;
            } catch (e) { skipped++; }
            done++;
            if (onProgress && done % 20 === 0) {
              try { onProgress(done); } catch (e) { /* ignore */ }
            }
          }
        }
        // 颜色也一并回滚
        for (const [name, c] of Object.entries(snap.colors || {})) {
          try { if (c.color) await Zotero.Tags.setColor(libraryID, name, c.color, c.position); } catch (e) { /* ignore */ }
        }
      }
    } catch (e) {
      return { ok: false, restored, skipped, error: String(e && e.message || e) };
    }

    // 用过即标记（不删，留下审计痕迹）
    snap.undoneAt = new Date().toISOString();
    await this._writeSnapshots(all);
    this.invalidate(libraryID);
    return { ok: true, restored, skipped };
  },

  /** 清空快照（只留最近 1 条用于审计） */
  async clearSnapshots() {
    const all = await this.listSnapshots();
    await this._writeSnapshots(all.slice(0, 1));
    return true;
  },

  /* ---------- 报告 ---------- */

  /** 生成库内笔记报告（沿用 TagCurator 的 MdLite 渲染） */
  async createReport(title, md, libraryID) {
    const note = new Zotero.Item("note");
    note.libraryID = libraryID || this.libraryID();
    const html = (typeof MdLite !== "undefined" && MdLite && MdLite.toNoteHtml)
      ? MdLite.toNoteHtml(title, md)
      : "<h1>" + String(title).replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</h1><pre>" +
        String(md).replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</pre>";
    note.setNote(html);
    await note.saveTx();
    return note;
  },
};
