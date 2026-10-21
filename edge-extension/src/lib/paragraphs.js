// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 从页面正文里挑可翻译的段落：过滤页眉页脚式短行、参考文献编号行，去重并限量。 */

export function pickParagraphs(text, opts) {
  const o = opts || {};
  const minLen = Number(o.minLen) || 40;
  const maxItems = Number(o.maxItems) || 20;
  const maxLen = Number(o.maxLen) || 2000;

  const seen = new Set();
  const out = [];
  const blocks = String(text || "").split(/\n{2,}/);
  for (const raw of blocks) {
    const p = raw.replace(/\s+/g, " ").trim();
    if (p.length < minLen) continue;
    if (/^\[\d+\]/.test(p)) continue;
    if (/^(参考文献|references|bibliography)\b/i.test(p)) continue;
    if (/^(doi|https?:\/\/)\S+$/i.test(p)) continue;
    const key = p.slice(0, 80).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p.slice(0, maxLen));
    if (out.length >= maxItems) break;
  }
  return out;
}

export function paragraphsChars(list) {
  return (Array.isArray(list) ? list : []).reduce((n, p) => n + String(p || "").length, 0);
}
