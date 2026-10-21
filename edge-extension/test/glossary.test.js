// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

import assert from "node:assert/strict";
import { parseGlossary, renderGlossary, checkGlossary } from "../src/lib/glossary.js";

export default function register(test) {
  test("parseGlossary 支持 = / → / 制表符 / 冒号 / 竖线", () => {
    const text = [
      "embedding = 嵌入",
      "ablation study → 消融实验",
      "transformer\tTransformer",
      "token: 词元",
      "召回率 | recall",
    ].join("\n");
    const terms = parseGlossary(text);
    assert.equal(terms.length, 5);
    assert.equal(terms[0].translation, "嵌入");
    assert.equal(terms[1].translation, "消融实验");
    assert.equal(terms[3].term, "token");
    assert.equal(terms[4].translation, "recall");
  });

  test("parseGlossary 去重（忽略大小写）、跳过注释与坏行", () => {
    const terms = parseGlossary("# 注释\n\nBERT = BERT模型\nbert = BERT 预训练模型\n没有分隔符的行");
    assert.equal(terms.length, 1);
    assert.equal(terms[0].translation, "BERT 预训练模型");
  });

  test("parseGlossary 最多保留 60 条", () => {
    const lines = Array.from({ length: 80 }, (_, i) => "term" + i + " = 术语" + i);
    assert.equal(parseGlossary(lines.join("\n")).length, 60);
  });

  test("renderGlossary 空表返回空串，有表时一行一条", () => {
    assert.equal(renderGlossary([]), "");
    assert.equal(renderGlossary([{ term: "a", translation: "甲" }]), "a = 甲");
    assert.equal(renderGlossary([{ term: "a", translation: "甲" }, { term: "b", translation: "乙" }]), "a = 甲\nb = 乙");
  });

  test("checkGlossary 统计命中与未按表翻译的词", () => {
    const terms = [{ term: "embedding", translation: "嵌入" }, { term: "token", translation: "词元" }];
    const r = checkGlossary(terms, "我们把 token 映射到向量空间。");
    assert.equal(r.hit, 0);
    assert.equal(r.total, 2);
    assert.deepEqual(r.missing, ["token"]);
    const r2 = checkGlossary(terms, "词元经过嵌入层");
    assert.equal(r2.hit, 2);
    assert.equal(r2.missing.length, 0);
  });
}
