// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { formatGBT, formatAPA, formatMLA, formatBibtex, formatRIS, formatAll } from "../src/lib/format.js";

// 在 Node 全局上下文里加载插件同源的 RefFormat（经典脚本，var 声明挂到 global）
vm.runInThisContext(fs.readFileSync(new URL("../src/vendor/ref-format.js", import.meta.url), "utf8"));

const JOURNAL = {
  title: "A Study of Things",
  authors: [{ family: "Smith", given: "John" }, { family: "Doe", given: "Jane" }, { family: "Lee", given: "K." }],
  year: "2021",
  date: "2021-04-02",
  container: "Journal of Demos",
  volume: "12",
  issue: "3",
  pages: "45-58",
  doi: "10.1016/j.demo.2021.01.001",
  itemType: "journalArticle",
};

const CONF = {
  title: "Attention Is All You Need",
  authors: [
    { family: "Vaswani", given: "Ashish" },
    { family: "Shazeer", given: "Noam" },
    { family: "Parmar", given: "Niki" },
    { family: "Uszkoreit", given: "Jakob" },
  ],
  year: "2017",
  container: "Advances in Neural Information Processing Systems",
  volume: "30",
  pages: "5998-6008",
  doi: "10.5555/3295222.3295349",
  itemType: "conferencePaper",
};

const CN = {
  title: "抽动障碍的中医证候分布规律研究",
  authors: [{ literal: "张三" }, { literal: "李四" }, { literal: "王五" }, { literal: "赵六" }],
  year: "2020",
  container: "中医杂志",
  volume: "61",
  issue: "3",
  pages: "12-16",
  itemType: "journalArticle",
};

export default function register(test) {
  test("GB/T 7714：期刊三条作者、卷期页、DOI", () => {
    assert.equal(
      formatGBT(JOURNAL),
      "Smith J., Doe J., Lee K. A Study of Things[J]. Journal of Demos, 2021, 12(3): 45-58. DOI:10.1016/j.demo.2021.01.001."
    );
  });

  test("GB/T 7714：四位作者取前三位加 et al.，会议用 [C]//", () => {
    const out = formatGBT(CONF);
    assert.match(out, /^Vaswani A\., Shazeer N\., Parmar N\., et al\. /);
    assert.match(out, /\[C\]\/\/Advances in Neural Information Processing Systems\. 2017: 5998-6008\./);
  });

  test("GB/T 7714：中文作者用「等」，不加空格", () => {
    assert.equal(formatGBT(CN), "张三, 李四, 王五, 等. 抽动障碍的中医证候分布规律研究[J]. 中医杂志, 2020, 61(3): 12-16.");
  });

  test("APA 7：作者、年份、刊名卷期页与 DOI 链接", () => {
    assert.equal(
      formatAPA(JOURNAL),
      "Smith, J., Doe, J., & Lee, K. (2021). A Study of Things. Journal of Demos, 12(3), 45-58. https://doi.org/10.1016/j.demo.2021.01.001."
    );
  });

  test("APA 7：无年份写 n.d.", () => {
    assert.match(formatAPA({ ...JOURNAL, year: "" }), /\(n\.d\.\)/);
  });

  test("MLA 9：题名加引号、vol./no./pp.", () => {
    assert.equal(
      formatMLA(JOURNAL),
      'Smith, John, et al. "A Study of Things." Journal of Demos, vol. 12, no. 3, 2021, pp. 45-58. https://doi.org/10.1016/j.demo.2021.01.001.'
    );
  });

  test("BibTeX 复用 RefFormat，含 journal 与 doi 字段", () => {
    const bib = formatBibtex(JOURNAL);
    assert.match(bib, /^@article\{/);
    assert.match(bib, /title = \{A Study of Things\}/);
    assert.match(bib, /journal = \{Journal of Demos\}/);
    assert.match(bib, /doi = \{10\.1016\/j\.demo\.2021\.01\.001\}/);
  });

  test("RIS 复用 RefFormat，TY/TI/ER 齐全", () => {
    const ris = formatRIS(JOURNAL);
    assert.match(ris, /TY {2}- JOUR/);
    assert.match(ris, /TI {2}- A Study of Things/);
    assert.match(ris, /ER {2}-/);
  });

  test("formatAll 一次产出五种格式", () => {
    const all = formatAll(JOURNAL);
    assert.deepEqual(Object.keys(all).sort(), ["apa", "bibtex", "gbt", "mla", "ris"]);
    for (const key of Object.keys(all)) assert.ok(all[key].length > 20, key);
  });

  test("空记录返回空串而不是抛错", () => {
    assert.equal(formatGBT({}), "");
    assert.equal(formatAPA({}), "");
    assert.equal(formatMLA({}), "");
  });
}
