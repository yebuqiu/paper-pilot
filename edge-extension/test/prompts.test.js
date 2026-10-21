// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

import assert from "node:assert/strict";
import { buildMessages, estimateChars, MAX_SELECTION } from "../src/lib/prompts.js";

const page = {
  title: "Attention Is All You Need",
  url: "https://arxiv.org/abs/1706.03762",
  text: "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.",
};

export default function register(test) {
  test("summarize 输出固定结构并带上页面正文", () => {
    const msgs = buildMessages({ action: "summarize", page, lang: "zh" });
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].role, "system");
    assert.match(msgs[0].content, /只依据/);
    const user = msgs[1].content;
    assert.match(user, /TL;DR/);
    assert.match(user, /研究问题/);
    assert.match(user, /Attention Is All You Need/);
    assert.match(user, /dominant sequence transduction/);
  });

  test("explain / translate 缺少选区时抛错", () => {
    assert.throws(() => buildMessages({ action: "explain", page }), /选中/);
    assert.throws(() => buildMessages({ action: "translate", page }), /选中/);
  });

  test("explain 携带选区与术语表", () => {
    const msgs = buildMessages({
      action: "explain",
      selection: "scaled dot-product attention",
      page,
      glossary: [{ term: "attention", translation: "注意力" }],
    });
    const user = msgs[1].content;
    assert.match(user, /\[选中文本\]\nscaled dot-product attention/);
    assert.match(user, /\[术语表\]\nattention = 注意力/);
  });

  test("选区超长被截断且带省略号", () => {
    const msgs = buildMessages({ action: "explain", selection: "a".repeat(9000), page });
    const user = msgs[1].content;
    const block = user.split("[选中文本]\n")[1].split("\n\n[")[0];
    assert.ok(block.length <= MAX_SELECTION + 1, "选区长度 " + block.length);
    assert.match(block, /…$/);
  });

  test("页面正文按上下文上限截断", () => {
    const long = "段落。".repeat(20000);
    const msgs = buildMessages({ action: "summarize", page: { ...page, text: long }, maxContextChars: 6000 });
    const user = msgs[1].content;
    assert.ok(user.length < 9000, "实际 " + user.length);
    assert.match(user, /…/);
  });

  test("ask 需要问题，且问题进入提示", () => {
    assert.throws(() => buildMessages({ action: "ask", page, question: "  " }), /问题/);
    const msgs = buildMessages({ action: "ask", page, question: "实验的 baseline 是什么？" });
    assert.match(msgs[1].content, /\[问题\]\n实验的 baseline 是什么？/);
  });

  test("英文模式使用英文系统提示", () => {
    const msgs = buildMessages({ action: "summarize", page, lang: "en" });
    assert.match(msgs[0].content, /academic reading assistant/);
    assert.match(msgs[1].content, /TL;DR/);
  });

  test("追问携带最近几轮问答，动作请求忽略历史", () => {
    const history = [
      { role: "user", content: "第一个问题？" },
      { role: "assistant", content: "第一个回答。" },
    ];
    const ask = buildMessages({ action: "ask", page, question: "第二个问题？", history });
    assert.equal(ask.length, 4);
    assert.deepEqual(ask.slice(1, 3), history);
    assert.match(ask[3].content, /第二个问题？/);

    const summary = buildMessages({ action: "summarize", page, history });
    assert.equal(summary.length, 2);
  });

  test("历史总长受限，只保留最近几轮", () => {
    const history = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 ? "assistant" : "user",
      content: "第" + i + "轮：" + "内容".repeat(600),
    }));
    const msgs = buildMessages({ action: "ask", page, question: "继续", history });
    const histChars = msgs.slice(1, -1).reduce((n, m) => n + m.content.length, 0);
    assert.ok(histChars <= 8000, "实际 " + histChars);
    assert.ok(msgs.length <= 8, "实际 " + msgs.length);
    assert.match(msgs[msgs.length - 1].content, /继续/);
  });

  test("estimateChars 统计全部消息", () => {
    const msgs = buildMessages({ action: "summarize", page });
    assert.equal(estimateChars(msgs), msgs[0].content.length + msgs[1].content.length);
  });
}
