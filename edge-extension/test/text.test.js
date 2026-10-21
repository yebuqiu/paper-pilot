// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

import assert from "node:assert/strict";
import "../src/lib/text.js";

const T = globalThis.PPTextLib;

function node(text, skip) {
  return {
    innerText: text,
    textContent: text,
    closest: () => (skip ? { tagName: "NAV" } : null),
  };
}

function fakeDoc(articleText, nodes, bodyText) {
  const article = {
    innerText: articleText,
    textContent: articleText,
    querySelectorAll: () => nodes,
  };
  const body = {
    innerText: bodyText || "",
    textContent: bodyText || "",
    querySelectorAll: () => nodes,
  };
  return {
    title: "Test Paper",
    location: { href: "https://example.org/paper" },
    querySelector: (sel) => {
      if (sel === "article") return articleText ? article : null;
      if (sel === "body") return body;
      return null;
    },
    body,
  };
}

export default function register(test) {
  test("normalizeText 折叠空白并压缩空行", () => {
    assert.equal(T.normalizeText("  a   b \n\n\n c\t d  "), "a b\n\nc d");
    assert.equal(T.normalizeText(""), "");
  });

  test("paragraphize 按空行切段，长段按句号再切", () => {
    assert.deepEqual(T.paragraphize("一。\n\n二。"), ["一。", "二。"]);
    const long = "句子。".repeat(300);
    const parts = T.paragraphize(long);
    assert.ok(parts.length > 1);
    assert.ok(parts.every((p) => p.length <= 402));
  });

  test("truncateText 在自然边界截断并加省略号", () => {
    assert.equal(T.truncateText("short", 100), "short");
    const out = T.truncateText("第一句。第二句。第三句。", 10);
    assert.ok(out.length <= 11);
    assert.match(out, /…$/);
  });

  test("extractFromDocument 抽取正文、跳过导航、相邻去重", () => {
    const doc = fakeDoc("article text", [
      node("Title of the paper"),
      node("First paragraph."),
      node("First paragraph."),
      node("Second paragraph."),
      node("Navigation junk", true),
    ]);
    const out = T.extractFromDocument(doc);
    assert.equal(out.title, "Test Paper");
    assert.equal(out.url, "https://example.org/paper");
    assert.equal(out.text, "Title of the paper\n\nFirst paragraph.\n\nSecond paragraph.");
    assert.equal(out.paragraphs, 3);
    assert.equal(out.chars, out.text.length);
  });

  test("pickRoot 选择可见文本更长的容器", () => {
    const doc = fakeDoc("short", [], "this body text is much longer than the article");
    assert.equal(T.pickRoot(doc).innerText, "this body text is much longer than the article");
  });

  test("空文档返回空结构而不是抛错", () => {
    const out = T.extractFromDocument(null);
    assert.deepEqual(out, { title: "", url: "", text: "", chars: 0, paragraphs: 0 });
  });
}
