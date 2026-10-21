// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 摘录本：选中文字 / AI 回答存为本地摘录，可导出 Markdown。纯函数，便于单测。 */

export const MAX_EXCERPTS = 200;
export const MAX_TEXT = 4000;
export const MAX_NOTE = 8000;

function clean(input, max) {
  return String(input == null ? "" : input)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

export function normalizeExcerpt(input) {
  const data = input || {};
  const text = clean(data.text, MAX_TEXT);
  if (!text) return null;
  return {
    id: String(data.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 6))),
    text,
    note: clean(data.note, MAX_NOTE),
    title: clean(data.title, 300),
    url: clean(data.url, 2000),
    createdAt: Number(data.createdAt) || Date.now(),
  };
}

/** 同一来源的同一段文字只保留一条；新条目排在最前。 */
export function mergeExcerpt(list, item) {
  const next = normalizeExcerpt(item);
  if (!next) return Array.isArray(list) ? list : [];
  const rest = (Array.isArray(list) ? list : []).filter(
    (x) => !(x && x.text === next.text && x.url === next.url)
  );
  return [next, ...rest].slice(0, MAX_EXCERPTS);
}

function dateOf(ts) {
  try {
    return new Date(ts).toLocaleDateString("zh-CN");
  } catch (e) {
    return "";
  }
}

export function excerptToMarkdown(list) {
  const items = Array.isArray(list) ? list : [];
  if (!items.length) return "";
  const out = ["# Papilot 阅读摘录", ""];
  for (const item of items) {
    const title = item.title || "未命名页面";
    out.push("## " + title);
    const quote = String(item.text || "").split("\n").map((l) => "> " + l).join("\n");
    out.push(quote, "");
    if (item.note) out.push(item.note, "");
    const meta = [item.url, dateOf(item.createdAt)].filter(Boolean).join(" · ");
    if (meta) out.push("来源：" + meta, "");
  }
  return out.join("\n").trim() + "\n";
}
