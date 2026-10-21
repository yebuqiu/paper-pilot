// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

import assert from "node:assert/strict";
import { normalizeExcerpt, mergeExcerpt, excerptToMarkdown, MAX_EXCERPTS } from "../src/lib/excerpts.js";
import { pickParagraphs, paragraphsChars } from "../src/lib/paragraphs.js";
import { buildParagraphTranslation } from "../src/lib/prompts.js";

export default function register(test) {
  test("normalizeExcerpt 清洗空白并保留来源", () => {
    const e = normalizeExcerpt({ text: "  第一行\n\n\n 第二行  ", title: " T ", url: "https://x", note: " 注 " });
    assert.equal(e.text, "第一行\n\n第二行");
    assert.equal(e.title, "T");
    assert.equal(e.url, "https://x");
    assert.equal(e.note, "注");
    assert.ok(e.id && e.createdAt);
  });

  test("normalizeExcerpt 空文本返回 null", () => {
    assert.equal(normalizeExcerpt({ text: "   " }), null);
    assert.equal(normalizeExcerpt(null), null);
  });

  test("mergeExcerpt 同来源同文本去重且新条目在前", () => {
    const a = normalizeExcerpt({ text: "同一段", url: "https://x", createdAt: 1 });
    const b = normalizeExcerpt({ text: "另一段", url: "https://x", createdAt: 2 });
    const list = mergeExcerpt([a], b);
    assert.equal(list.length, 2);
    assert.equal(list[0].text, "另一段");
    const dup = mergeExcerpt(list, { text: "同一段", url: "https://x", createdAt: 3 });
    assert.equal(dup.length, 2);
    assert.equal(dup[0].createdAt, 3);
  });

  test("mergeExcerpt 上限 200 条", () => {
    let list = [];
    for (let i = 0; i < 220; i++) list = mergeExcerpt(list, { text: "段落" + i, url: "u" });
    assert.equal(list.length, MAX_EXCERPTS);
    assert.equal(list[0].text, "段落219");
  });

  test("excerptToMarkdown 输出引用块与来源", () => {
    const md = excerptToMarkdown([
      normalizeExcerpt({ text: "第一行\n第二行", note: "我的批注", title: "论文 A", url: "https://x", createdAt: Date.parse("2026-10-19") }),
    ]);
    assert.match(md, /# Papilot 阅读摘录/);
    assert.match(md, /> 第一行\n> 第二行/);
    assert.match(md, /我的批注/);
    assert.match(md, /来源：https:\/\/x/);
  });

  test("pickParagraphs 过滤短行、参考文献编号与重复段", () => {
    const text = [
      "短标题",
      "[1] 张三. 某研究[J]. 某刊, 2020.",
      "References",
      "这是第一段足够长的正文，用来验证段落筛选逻辑是否按预期工作。",
      "这是第一段足够长的正文，用来验证段落筛选逻辑是否按预期工作。",
      "这是第二段足够长的正文，包含研究方法和主要结论，长度也超过阈值。",
    ].join("\n\n");
    const list = pickParagraphs(text, { minLen: 30 });
    assert.equal(list.length, 2);
    assert.match(list[0], /第一段/);
    assert.ok(paragraphsChars(list) > 50);
  });

  test("pickParagraphs 数量上限与单段截断", () => {
    const blocks = Array.from({ length: 30 }, (_, i) => "段落" + i + "：" + "内容".repeat(100));
    const list = pickParagraphs(blocks.join("\n\n"), { maxItems: 20, maxLen: 50 });
    assert.equal(list.length, 20);
    assert.ok(list.every((p) => p.length <= 50));
  });

  test("buildParagraphTranslation 只带术语表与当前段落", () => {
    const msgs = buildParagraphTranslation("The ablation study shows a 2.1 point gain.", {
      glossary: [{ term: "ablation study", translation: "消融实验" }],
    });
    assert.equal(msgs.length, 2);
    assert.match(msgs[0].content, /只输出译文/);
    const user = msgs[1].content;
    assert.match(user, /ablation study = 消融实验/);
    assert.match(user, /The ablation study/);
    assert.equal((user.match(/The ablation study/g) || []).length, 1);
  });

  test("buildParagraphTranslation 拒绝空段落", () => {
    assert.throws(() => buildParagraphTranslation("  "), /段落为空/);
  });
}
