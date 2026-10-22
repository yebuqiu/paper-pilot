// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 翻译模块 · 术语表域子模块（0.33.0 建立；0.4x 领域化；0.73.0 自 translate.js 拆出）
 *
 * 职责（单一）：术语表的解析 / 域过滤 / 提示词注入 / 指纹 / 一致性统计 / 导入导出。
 * 让专业术语全文一致：用户在设置面板按行维护「原文 = 译文」，翻译时注入
 * AI 大模型的提示词（LLM 才能理解术语约束；专用引擎无法注入，界面已注明）。
 * 纯函数 parseGlossary 支持三种写法：`原文 = 译文` / `原文 => 译文` / TAB 分隔，
 * 另兼容 JSON 数组（[{s,t,d}] 或 [[s,t],[s,t,d]]）；# 与 // 开头的行为注释。
 *
 * 0.4x 领域化（参考 IATE / Terminologue / TBX 的「领域元数据」设计）：
 *   - 行格式新增可选第三段：`原文 = 译文 | 领域`（多标签用 ; 或 , 分隔）。
 *   - pref translateGlossaryDomains（分号分隔的启用域白名单；空 = 全部启用）：
 *     glossary() 据此过滤——无领域标注的通用术语永不被滤；领域术语须命中白名单。
 *     过滤发生在指纹之前 → 缓存键天然随「启用域」变化（改域=改表，不吃旧缓存）。
 *   - glossaryBlock(list, text)：带待译文本时**命中的术语优先注入**（60 条上限下
 *     保证本段出现的术语必进 prompt——借鉴 IATE「按需子集」思路）。
 *   - glossaryStats：译后一致性自检（原文命中术语的译文是否出现），结果挂在
 *     translate() 返回的 glossary 字段，由 UI 汇报「术语一致 n/m」。
 *   - glossaryToCsv / parseGlossaryImport / mergeGlossary：对接开源词库的导入导出
 *     （CSV/TSV/JSON/行式四形态；参考 ECDICT 的 CSV 表头范式与 pyglossary 的
 *     多格式转换理念——全部纯函数，文件 IO 由设置面板薄壳承担）。
 *
 * 依赖：仅 Prefs（读 pref translateGlossary / translateGlossaryDomains）。
 * 装配：main.js files 列表，须在 translate.js（门面）之前。
 * 消费：translate.js（缓存指纹/prompt 注入/一致性挂载）、reader-popup.js（浮窗注入）、
 *       prefs-translate.js（设置面板）、skill-packs.js / glossary-packs.js（词包导入）。
 */
/* global Prefs */

var TranslateGlossary = (function () {
  "use strict";

  /** 读 pref 的统一薄壳（Prefs 不可用时按默认值降级，绝不抛） */
  function _pref(key, dflt) {
    try { return Prefs.get(key, dflt); } catch (e) { return dflt; }
  }

  /** 领域标签是否「长得像领域」（防把正文里的 | 误当域分隔符）：分号/逗号切分后
   *  每段非空、≤20 字符、无空白，整体 ≤48 字符。 */
  function _looksLikeDomain(s) {
    const v = String(s == null ? "" : s).trim();
    if (!v || v.length > 48) return false;
    const parts = v.split(/[;,，；]/);
    for (const p of parts) {
      const t = p.trim();
      if (!t || t.length > 20 || /\s/.test(t)) return false;
    }
    return true;
  }

  /** 领域串归一化：按 ;/,/，/； 切分 → trim → 小写 → 分号连接。空输入 → ""（通用域）。 */
  function _normDomain(s) {
    const v = String(s == null ? "" : s).trim();
    if (!v || !_looksLikeDomain(v)) return "";
    return v.split(/[;,，；]/).map((x) => x.trim().toLowerCase()).filter(Boolean).join(";");
  }

  /** 单行行式解析（parseGlossary 与 mergeGlossary 的唯一行解析真源，0.73.0 合并重复）：
   *  输入已 trim、已排除空行/注释的一行 → {s, t, d}；不含 = / => 分隔符 → null。
   *  s/t 在此**不做有效性过滤**（调用方各自决定：解析时丢弃无效条，合并时保留原文行）。 */
  function _parseGlossaryLine(line) {
    let d = "";
    // 0.4x：竖线后的短标签串 = 领域标注（`原文 = 译文 | 医学` / `… | 医学;计算机`）
    const bar = line.lastIndexOf("|");
    if (bar >= 0) {
      const tail = line.slice(bar + 1).trim();
      if (_looksLikeDomain(tail)) { d = tail; line = line.slice(0, bar); }
    }
    const m = /^(.+?)\s*(?:=>|=)\s*(.+)$/.exec(line.replace(/\t+/g, " => "));
    if (!m) return null;
    return { s: m[1].trim(), t: m[2].trim(), d: _normDomain(d) };
  }

  function parseGlossary(raw) {
    const src = String(raw == null ? "" : raw).trim();
    if (!src) return [];
    // JSON 数组（程序化写入/导入的形态）
    if (src.charAt(0) === "[") {
      try {
        const arr = JSON.parse(src);
        const out = [];
        for (const it of (Array.isArray(arr) ? arr : [])) {
          const s = it && (it.s || it[0]);
          const t = it && (it.t || it[1]);
          const d = it && (it.d !== undefined ? it.d : it[2]); // 三元数组第三位 = 领域
          if (s && t && s !== t) out.push({ s: String(s), t: String(t), d: _normDomain(d) });
        }
        return out;
      } catch (e) { /* 非法 JSON → 按行解析 */ }
    }
    const out = [];
    for (let line of src.split(/\r?\n/)) {
      line = line.trim();
      if (!line || line.charAt(0) === "#" || line.slice(0, 2) === "//") continue;
      const g = _parseGlossaryLine(line);
      if (g && g.s && g.t && g.s !== g.t) out.push(g);
    }
    return out;
  }

  /** 读取用户术语表全文（不过滤；供 UI 统计领域、导入导出）。 */
  function glossaryAll() {
    return parseGlossary(_pref("translateGlossary", "") || "");
  }

  /** 启用域白名单（pref translateGlossaryDomains，归一化形态；空串 = 不过滤）。 */
  function activeDomains() {
    return _normDomain(_pref("translateGlossaryDomains", "") || "");
  }

  /** 读取术语表并按启用域过滤：无领域标注 → 永远启用；有标注 → 至少一个标签命中白名单。 */
  function glossary() {
    const white = activeDomains();
    if (!white) return glossaryAll();
    const set = {};
    for (const d of white.split(";")) set[d] = 1;
    return glossaryAll().filter((g) =>
      !g.d || String(g.d).split(";").some((x) => set[x]));
  }

  /** 当前术语表里出现过的全部领域（去重排序；UI chips 用）。 */
  function glossaryDomains() {
    const set = {};
    for (const g of glossaryAll()) {
      for (const d of String(g.d || "").split(";")) if (d) set[d] = 1;
    }
    return Object.keys(set).sort();
  }

  /** 术语表 → 提示词块（空表返回空串；上限 60 条防爆词）。
   *  0.4x：传入待译文本时，**原文命中的术语优先**——长表被 60 条截断时，
   *  保证本段真正出现的术语必进 prompt（全文一致性保障的关键一环）。 */
  function glossaryBlock(list, text) {
    const l = Array.isArray(list) ? list : glossary();
    if (!l.length) return "";
    let sel = l;
    if (text != null && String(text)) {
      const hay = String(text).toLowerCase();
      const hit = [];
      const rest = [];
      for (const g of l) (hay.indexOf(String(g.s).toLowerCase()) >= 0 ? hit : rest).push(g);
      if (hit.length) sel = hit.concat(rest);
    }
    return sel.slice(0, 60).map((g) => "- " + g.s + " → " + g.t).join("\n");
  }

  /** 术语表指纹（FNV-1a）：术语表变了，缓存键跟着变 —— 否则改完术语表还吃旧缓存。
   *  0.4x：无参调用走 glossary()（已按启用域过滤）→ 领域启停等效于改表，
   *  指纹随之变化、旧缓存自动失效；显式传 list 时保持纯函数语义（测试/程序化用）。 */
  function glossaryFingerprint(list) {
    const l = Array.isArray(list) ? list : glossary();
    if (!l.length) return "";
    const s = l.map((g) => g.s + "=" + g.t + (g.d ? "|" + g.d : "")).join("|");
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return h.toString(36);
  }

  /** 译后一致性自检：只统计「原文里出现」的术语，检查其译法是否出现在译文里。
   *  @returns {{total, hit, miss:string[]}} —— miss 是译法未出现的原文术语（提示用，不阻断）。 */
  function glossaryStats(list, srcText, outText) {
    const l = Array.isArray(list) ? list : glossary();
    const src = String(srcText == null ? "" : srcText).toLowerCase();
    const out = String(outText == null ? "" : outText);
    let total = 0;
    let hit = 0;
    const miss = [];
    for (const g of l) {
      if (!src || src.indexOf(String(g.s).toLowerCase()) < 0) continue;
      total++;
      if (g.t && out.indexOf(g.t) >= 0) hit++;
      else miss.push(g.s);
    }
    return { total, hit, miss };
  }

  /** translate() 内部用：术语一致性统计（未命中任何术语 → null，不占返回体语义）。 */
  function _glossaryCheck(srcText, outText) {
    try {
      const st = glossaryStats(null, srcText, outText);
      return st.total > 0 ? { hit: st.hit, total: st.total } : null;
    } catch (e) { return null; }
  }

  /* ---------- 导入 / 导出（纯函数；文件 IO 在设置面板） ---------- */

  function _csvCell(v) {
    const s = String(v == null ? "" : v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /** CSV 单行切分（容忍引号包裹与转义引号；返回各列 trim 后的值）。 */
  function _splitCsvLine(line, sep) {
    const out = [];
    let cur = "";
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line.charAt(i);
      if (q) {
        if (c === '"') {
          if (line.charAt(i + 1) === '"') { cur += '"'; i++; }
          else q = false;
        } else cur += c;
      } else if (c === '"' && !cur) q = true;
      else if (c === sep) { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur);
    return out.map((x) => x.trim());
  }

  /** 术语表 → CSV 文本（表头 source,target,domain；Excel 友好，BOM 由面板侧加）。 */
  function glossaryToCsv(list) {
    const l = Array.isArray(list) ? list : glossary();
    return ["source,target,domain"].concat(
      l.map((g) => _csvCell(g.s) + "," + _csvCell(g.t) + "," + _csvCell(g.d || ""))
    ).join("\n");
  }

  /** 导入文本 → 术语列表。自动识别四种形态：JSON 数组 / 带表头 CSV·TSV /
   *  裸两三列 CSV·TSV / 行式（=、=>、TAB）。返回 {list, format}。
   *  表头别名：source|src|en*|english|term|原文 → 译文列 target|tgt|zh*|translation|译文，
   *  第三列 domain|field|subject|tag|领域（如 EECS-Terminology 的 en,zh_CN,pos,description
   *  ——pos/description 等多余列自动忽略）。 */
  function parseGlossaryImport(text) {
    const src = String(text == null ? "" : text).replace(/^\uFEFF/, "").trim();
    if (!src) return { list: [], format: "empty" };
    if (src.charAt(0) === "[") {
      try { return { list: parseGlossary(src), format: "json" }; } catch (e) { /* fallthrough */ }
    }
    const lines = src.split(/\r?\n/).filter((x) => x.trim());
    if (!lines.length) return { list: [], format: "empty" };
    const sep = (lines[0].indexOf("\t") >= 0 && lines[0].indexOf(",") < 0) ? "\t" : ",";
    const HDR_S = /^(source|src|en[a-z_-]*|english|term|原文|词语|源语)$/i;
    const HDR_T = /^(target|tgt|dst|zh[a-z_-]*|chinese|translation|译文|译语|目标语)$/i;
    const HDR_D = /^(domain|field|subject|tag|领域|学科|标签)$/i;
    const first = _splitCsvLine(lines[0], sep);
    if (first.length >= 2 && HDR_S.test(first[0]) && HDR_T.test(first[1])) {
      const di = first.length >= 3 && HDR_D.test(first[2]) ? 2 : -1;
      const out = [];
      for (const line of lines.slice(1)) {
        const c = _splitCsvLine(line, sep);
        const s = c[0];
        const t = c[1];
        const d = di >= 2 ? c[di] : "";
        if (s && t && s !== t) out.push({ s, t, d: _normDomain(d) });
      }
      return { list: out, format: sep === "\t" ? "tsv" : "csv" };
    }
    // 含 = / => 分隔符的行占多数 → 行式（本插件原生格式优先，防把带 = 的 CSV 误切）
    const native = lines.filter((ln) => /\s(=>|=)\s|\t/.test(ln)).length;
    if (native >= Math.ceil(lines.length / 2)) {
      return { list: parseGlossary(src), format: "lines" };
    }
    // 裸两三列 CSV/TSV（无表头、无 = 号）
    const colsOk = lines.every((ln) => {
      if (ln.indexOf(sep) < 0) return false;
      const c = _splitCsvLine(ln, sep);
      return c.length >= 2 && c.length <= 3 && c[0] && c[1];
    });
    if (colsOk) {
      const out = lines.map((ln) => {
        const c = _splitCsvLine(ln, sep);
        return { s: c[0], t: c[1], d: _normDomain(c[2] || "") };
      }).filter((g) => g.s && g.t && g.s !== g.t);
      return { list: out, format: sep === "\t" ? "tsv-bare" : "csv-bare" };
    }
    return { list: parseGlossary(src), format: "lines" };
  }

  /** 把导入的术语合并进现有术语表文本。同原文 → 覆盖译法与领域；新条目追加到末尾。
   *  行式输入做**行级 upsert**（# 注释与无法解析的行原样保留）；JSON 形态输入保 JSON。
   *  @returns {{raw, added, updated}} —— raw 是合并后的完整文本（面板直接写回 pref）。 */
  function mergeGlossary(currentRaw, incoming) {
    const cur = parseGlossary(currentRaw);
    const byS = new Map();
    for (const g of cur) byS.set(g.s, g);
    let added = 0;
    let updated = 0;
    for (const g0 of (Array.isArray(incoming) ? incoming : [])) {
      const g = { s: String((g0 && g0.s) || "").trim(), t: String((g0 && g0.t) || "").trim(),
        d: _normDomain(g0 && g0.d) };
      if (!g.s || !g.t || g.s === g.t) continue;
      if (byS.has(g.s)) {
        const old = byS.get(g.s);
        if (old.t === g.t && old.d === g.d) continue; // 完全相同 → 跳过
        byS.set(g.s, g);
        updated++;
      } else {
        byS.set(g.s, g);
        added++;
      }
    }
    const src = String(currentRaw == null ? "" : currentRaw);
    let raw;
    if (src.trim().charAt(0) === "[") {
      raw = JSON.stringify(Array.from(byS.values()).map((g) =>
        g.d ? { s: g.s, t: g.t, d: g.d } : { s: g.s, t: g.t }));
    } else {
      const seen = new Map(byS); // 待落位（最终表）
      const written = new Set(); // 已写出的原文（去重：同 s 旧行只保第一处）
      const outLines = [];
      for (let line of src.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.charAt(0) === "#" || t.slice(0, 2) === "//") { outLines.push(line); continue; }
        const g = _parseGlossaryLine(t);
        if (!g) { outLines.push(line); continue; }
        const s = g.s;
        if (seen.has(s)) {
          const merged = seen.get(s);
          outLines.push(merged.s + " = " + merged.t + (merged.d ? " | " + merged.d : ""));
          seen.delete(s);
          written.add(s);
        } else if (written.has(s)) {
          // 旧文本里同原文的重复行 → 丢弃（以合并结果为准）
        } else outLines.push(line);
      }
      for (const g of seen.values()) outLines.push(g.s + " = " + g.t + (g.d ? " | " + g.d : ""));
      raw = outLines.join("\n");
    }
    return { raw, added, updated };
  }

  return {
    parseGlossary, glossary, glossaryAll, glossaryDomains, activeDomains,
    glossaryBlock, glossaryFingerprint, glossaryStats, _glossaryCheck,
    glossaryToCsv, parseGlossaryImport, mergeGlossary,
  };
})();
