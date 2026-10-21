// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 提示词构造：动作模板 + 上下文拼装。纯函数，可在 Node 里直接单测。 */

import { renderGlossary } from "./glossary.js";

export const MAX_SELECTION = 4000;

export const ACTION_META = Object.freeze({
  explain: { label: "解释选中", hint: "概念 / 句子在当前语境中的含义", needsSelection: true },
  translate: { label: "翻译选中", hint: "逐句对照，术语按表", needsSelection: true },
  summarize: { label: "本页摘要", hint: "TL;DR / 方法 / 结论 / 局限", needsSelection: false },
  critique: { label: "创新与局限", hint: "证据强度与可复现性", needsSelection: false },
  ask: { label: "追问", hint: "基于本页正文自由提问", needsSelection: false },
});

const SYSTEM_ZH = [
  "你是 Papilot 学术阅读助手，服务对象是正在精读论文的研究者。",
  "规则：",
  "1. 只依据【页面正文】与【选中文本】作答，不引入未经说明的外部事实；使用外部知识时必须标注「（外部知识）」。",
  "2. 不编造数据、引用、页码或作者观点；文本不足时直接写「文中未提供」。",
  "3. 术语严格遵循【术语表】，同一术语全篇译法一致；术语表未覆盖时，首次出现保留英文原词。",
  "4. 用中文回答，简洁、具体、可直接使用；公式用 LaTeX（$...$）。",
  "5. 不做与文本无关的延伸，不评价作者，不生成论文正文。",
].join("\n");

const SYSTEM_EN = [
  "You are Papilot's academic reading assistant for researchers reading papers closely.",
  "Rules:",
  "1. Answer only from the PAGE TEXT and SELECTION. Mark any outside knowledge explicitly as (outside knowledge).",
  "2. Never invent data, citations, page numbers or author claims. Say \"not stated in the text\" when missing.",
  "3. Follow the GLOSSARY strictly and keep terminology consistent; keep the original term in parentheses on first use.",
  "4. Answer in English, concise and concrete. Use LaTeX for formulas ($...$).",
  "5. Do not generate paper prose, judge authors, or drift off-topic.",
].join("\n");

function taskText(action, lang, question) {
  const zh = lang !== "en";
  switch (action) {
    case "explain":
      return zh
        ? "任务：解释【选中文本】。输出三部分：① 一句话定义；② 在本文语境中的具体含义；③ 为什么重要，或常见的理解偏差。总长不超过 200 字。"
        : "Task: explain the SELECTION. Output: (1) one-sentence definition; (2) what it means in this paper's context; (3) why it matters or a common misconception. Keep under 150 words.";
    case "translate":
      return zh
        ? "任务：把【选中文本】译成中文。要求：逐句对应、保留段落结构、不增删信息、术语按表；关键术语首次出现时在括号内保留英文原词。只输出译文。"
        : "Task: translate the SELECTION into English. Keep sentence-by-sentence correspondence, preserve paragraphs, add nothing, follow the glossary. Output the translation only.";
    case "summarize":
      return zh
        ? "任务：为【页面正文】做结构化摘要。严格使用以下小标题，每项最多 3 条：\nTL;DR（不超过 3 句）\n研究问题\n方法\n主要结论\n局限\n可借鉴点"
        : "Task: summarize PAGE TEXT with these headings, max 3 bullets each:\nTL;DR (max 3 sentences)\nResearch question\nMethod\nKey findings\nLimitations\nTakeaways";
    case "critique":
      return zh
        ? "任务：评估【页面正文】的创新与证据。分四节：创新点、证据强度、可复现性疑问、作者未讨论的替代解释。每条都要标注来源是「文中明示」还是「你的推断」。"
        : "Task: assess novelty and evidence in PAGE TEXT. Sections: novelty, strength of evidence, reproducibility concerns, alternative explanations not discussed. Label each item as stated or inferred.";
    case "ask":
    default:
      return zh
        ? "任务：回答用户问题。先给结论，再给依据（引用原文短句），最后说明不确定性。"
        : "Task: answer the user's question. Lead with the conclusion, then evidence (short quotes), then uncertainty.";
  }
}

function clip(value, max) {
  const text = String(value || "").trim();
  const limit = Number(max) || 0;
  if (!limit || text.length <= limit) return text;
  const head = text.slice(0, limit);
  const cut = Math.max(head.lastIndexOf("\n\n"), head.lastIndexOf("。"), head.lastIndexOf(". "));
  return (cut > limit * 0.6 ? head.slice(0, cut) : head).replace(/[\s,，;；:：]+$/, "") + "…";
}

/** 追问时带最近几轮问答；动作类请求不带历史，避免上一轮的格式污染本轮输出。 */
function normalizeHistory(history) {
  const out = [];
  let total = 0;
  for (const h of (Array.isArray(history) ? history : []).slice().reverse()) {
    const role = h && h.role === "assistant" ? "assistant" : "user";
    const content = clip(h && h.content, 2000);
    if (!content) continue;
    if (total + content.length > 8000) break;
    out.unshift({ role, content });
    total += content.length;
  }
  return out;
}

/**
 * @param {{
 *   action: string, question?: string, selection?: string,
 *   page?: {title?: string, url?: string, text?: string},
 *   glossary?: Array<{term: string, translation: string}>,
 *   lang?: "zh"|"en", maxContextChars?: number,
 *   history?: Array<{role: string, content: string}>
 * }} input
 * @returns {Array<{role: string, content: string}>}
 */
export function buildMessages(input) {
  const action = ACTION_META[input.action] ? input.action : "ask";
  const lang = input.lang === "en" ? "en" : "zh";
  const selection = clip(input.selection, MAX_SELECTION);
  const page = input.page || {};
  const total = Math.max(4000, Math.min(40000, Number(input.maxContextChars) || 18000));
  const glossary = renderGlossary(input.glossary || []);

  const meta = ACTION_META[action];
  if (meta.needsSelection && !selection) {
    throw new Error(lang === "zh" ? "请先在页面上选中一段文字" : "Select some text on the page first");
  }

  const reserved = selection.length + glossary.length + 800;
  const pageText = clip(page.text, Math.max(2000, total - reserved));

  const parts = [];
  parts.push(taskText(action, lang, input.question));
  if (page.title || page.url) {
    parts.push("[页面]\n" + [page.title, page.url].filter(Boolean).join("\n"));
  }
  if (pageText) parts.push("[页面正文]\n" + pageText);
  if (selection) parts.push("[选中文本]\n" + selection);
  if (glossary) parts.push("[术语表]\n" + glossary);
  if (action === "ask") {
    const q = clip(input.question, 1000);
    if (!q) throw new Error(lang === "zh" ? "请输入问题" : "Enter a question");
    parts.push("[问题]\n" + q);
  }

  const messages = [{ role: "system", content: lang === "en" ? SYSTEM_EN : SYSTEM_ZH }];
  if (action === "ask") {
    for (const h of normalizeHistory(input.history)) messages.push(h);
  }
  messages.push({ role: "user", content: parts.join("\n\n") });
  return messages;
}

/** 逐段对照翻译：单段请求，不重复发送整页正文，控制 token 与限流压力。 */
export function buildParagraphTranslation(paragraph, opts) {
  const o = opts || {};
  const lang = o.lang === "en" ? "en" : "zh";
  const text = clip(paragraph, 2400);
  if (!text) throw new Error(lang === "zh" ? "段落为空" : "Empty paragraph");
  const glossary = renderGlossary(o.glossary || []);

  const system = lang === "zh"
    ? [
        "你是学术论文翻译器。",
        "只输出译文，不解释、不加标题、不总结。",
        "逐句对应，不增删信息；公式保留原样；术语严格遵循【术语表】，未覆盖的术语首次出现时在括号里保留英文原词。",
      ].join("\n")
    : [
        "You are an academic translator.",
        "Output the translation only: no explanations, headings or summaries.",
        "Keep sentence-by-sentence correspondence, formulas unchanged, and follow the GLOSSARY strictly.",
      ].join("\n");

  const parts = [];
  if (glossary) parts.push("[术语表]\n" + glossary);
  parts.push("[段落]\n" + text);
  parts.push(lang === "zh" ? "任务：译成中文。" : "Task: translate into English.");

  return [
    { role: "system", content: system },
    { role: "user", content: parts.join("\n\n") },
  ];
}

/** 粗略估算上下文规模，面板用它提示「本次将发送约 N 字」。 */
export function estimateChars(messages) {
  return (messages || []).reduce((sum, m) => sum + String(m.content || "").length, 0);
}
