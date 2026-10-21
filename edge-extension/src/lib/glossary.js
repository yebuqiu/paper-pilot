// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 术语表：把用户维护的「原文 = 译名」注入提示词，保证同一篇文章前后译法一致。 */

const MAX_TERMS = 60;

function splitPair(line) {
  const raw = String(line || "").trim();
  if (!raw || raw.startsWith("#")) return null;
  const m = raw.match(/^(.+?)\s*(?:=>|=|→|\t|:|\|)\s*(.+)$/);
  if (!m) return null;
  const term = m[1].trim();
  const translation = m[2].trim();
  if (!term || !translation) return null;
  if (term.length > 80 || translation.length > 80) return null;
  return { term, translation };
}

/** 解析文本术语表；同词（忽略大小写）后出现的覆盖先出现的。 */
export function parseGlossary(text) {
  const seen = new Map();
  for (const line of String(text || "").split(/\r?\n/)) {
    const pair = splitPair(line);
    if (!pair) continue;
    seen.set(pair.term.toLowerCase(), pair);
  }
  return Array.from(seen.values()).slice(0, MAX_TERMS);
}

/** 渲染为提示词片段；空表返回空串，调用方据此决定是否插入该段。 */
export function renderGlossary(terms) {
  const list = Array.isArray(terms) ? terms.slice(0, MAX_TERMS) : [];
  if (!list.length) return "";
  return list.map((t) => t.term + " = " + t.translation).join("\n");
}

/** 在译文里统计术语是否按表使用，用于「术语一致 n/m」提示（MVP 仅做轻量校验）。 */
export function checkGlossary(terms, output) {
  const list = Array.isArray(terms) ? terms : [];
  const text = String(output || "");
  if (!list.length || !text) return { hit: 0, total: 0, missing: [] };
  const missing = [];
  let hit = 0;
  for (const t of list) {
    if (text.includes(t.translation)) hit++;
    else if (text.toLowerCase().includes(t.term.toLowerCase())) missing.push(t.term);
  }
  return { hit, total: list.length, missing: missing.slice(0, 5) };
}
