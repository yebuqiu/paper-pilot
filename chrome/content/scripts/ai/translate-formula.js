// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 翻译模块 · 行内公式保护子模块（0.33.0 建立；0.73.0 自 translate.js 拆出）
 *
 * 职责（单一）：非 LLM 引擎的行内公式掩码与还原。
 * 专用引擎（Google/DeepL/百度…）没有"保持公式原样"的指令通道，正文的行内公式
 * 常被改写得面目全非（下标被吞、希腊字母被音译）。做法：翻译前把高置信的
 * 数学片段换成占位符 ⟦PPF:n⟧，引擎一般会原样保留；译后再换回原文。
 *   - 高置信 = ① $...$ 定界（LaTeX 习惯）；② 连续 ≥6 个「数学 token」
 *     （数字 / 单字母变量 / 数学与希腊符号 / LaTeX 命令）以运算符或空白胶合的串。
 *   - 宁缺毋滥：正常英文句子的 token 大多是多字母实词，不会被误伤。
 *   - LLM 引擎不掩码：提示词里直接要求公式保持原样（掩码反而浪费一次复原）。
 *
 * 开关：pref translateFormulaProtect（默认开；_formulaProtect 由门面调用）。
 * 依赖：仅 Prefs。装配：main.js files 列表，须在 translate.js（门面）之前。
 *
 * ★ 掩码器第一版实坑：空白跳过分支（j+=2 吞空白+下个 token）**必须 mathy++ 计数**，
 *   否则 mathy 恒为 1、永远不到 6 → 静默不掩码，测试全绿也发现不了（单测已专门钉死）。
 */
/* global Prefs */

var TranslateFormula = (function () {
  "use strict";

  function _mathyToken(w) {
    if (!w) return false;
    if (/^\$[^$]{1,120}\$$/.test(w)) return true;
    if (/^\\[A-Za-z]{2,}/.test(w)) return true;               // \frac 等
    if (/^[0-9]+(\.[0-9]+)?$/.test(w)) return true;            // 数字（含小数）
    if (/^[0-9]+(\.[0-9]+)?[a-zA-Z]{1,2}$/.test(w)) return true; // 10ms、3D 这类也按数字算
    if (/^[A-Za-z]$/.test(w)) return true;                      // 单字母变量
    if (/^[α-ωΑ-Ω∑∫∂∇√∞≈≠≤≥±×÷→↔⇒∈∀∃∪∩⊂⊃⊕⊗∝°′″]+$/.test(w)) return true; // 符号/希腊
    return false;
  }
  /** 去掉两端的标点胶水（", x_2," 分类时按 x_2 算，原文保留标点） */
  function _stripGlue(w) {
    return String(w || "").replace(/^[\s,.;:()\[\]{}]+|[\s,.;:()\[\]{}]+$/g, "");
  }

  /** 掩码行内公式。@returns {{text, map: string[], count}} */
  function maskInlineFormulas(text) {
    const s = String(text == null ? "" : text);
    const map = [];
    if (!s) return { text: s, map, count: 0 };
    const ph = (orig) => {
      map.push(orig);
      return "⟦PPF" + (map.length - 1) + "⟧";
    };
    // ① $...$ 定界
    let t = s.replace(/\$\$?[^$]{2,160}?\$\$?/g, (m) => ph(m));
    // ② 连续数学 token 串
    const parts = t.match(/\S+|\s+/g) || [];
    const out = [];
    let i = 0;
    while (i < parts.length) {
      const p = parts[i];
      if (!p || /^\s+$/.test(p)) { out.push(p || ""); i++; continue; }
      if (!_mathyToken(_stripGlue(p))) {
        // 纯运算符 token（= + - ≥ …）可与左侧串合并，但不能起头
        if (out.length && /^[+\-*/^_=<>≤≥≈×÷→]+$/.test(p) && i + 1 < parts.length &&
            _mathyToken(_stripGlue(parts[i + 1] || ""))) {
          // 交给下一轮与右串合并，这里先落位
          out.push(p); i++; continue;
        }
        out.push(p); i++; continue;
      }
      // 收集一段连续数学串（中间允许空白；串长有上限，防误吞整段）
      let j = i + 1;
      let mathy = 1;
      const MAXRUN = 48;
      while (j < parts.length && mathy < MAXRUN) {
        const q = parts[j];
        if (/^\s+$/.test(q)) {
          const nxt = parts[j + 1];
          if (nxt && (_mathyToken(_stripGlue(nxt)) || /^[+\-*/^_=<>≤≥≈×÷→]+$/.test(nxt))) {
            j += 2; mathy++; continue; // 跳过空白并吞掉下一个 token
          }
          break;
        }
        if (/^[+\-*/^_=<>≤≥≈×÷→]+$/.test(q) || _mathyToken(_stripGlue(q))) {
          j++; mathy++; continue;
        }
        break;
      }
      if (mathy >= 6) {
        out.push(ph(parts.slice(i, j).join("")));
        i = j;
      } else {
        out.push(p);
        i++;
      }
    }
    t = out.join("");
    return { text: t, map, count: map.length };
  }

  /** 掩码还原（占位符不在译文里则什么都不做，不会拼错内容） */
  function unmaskFormulas(text, map) {
    const m = Array.isArray(map) ? map : [];
    return String(text == null ? "" : text).replace(/⟦\s*PPF\s*:?\s*(\d+)\s*⟧/g,
      (whole, idx) => {
        const v = m[Number(idx)];
        return v !== undefined ? v : whole;
      });
  }

  /** 开关读取（pref translateFormulaProtect，默认开；Prefs 不可用按开处理） */
  function _formulaProtect() {
    try { return Prefs.get("translateFormulaProtect", true) !== false; } catch (e) { return true; }
  }

  return { maskInlineFormulas, unmaskFormulas, formulaProtect: _formulaProtect };
})();
