// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

import assert from "node:assert/strict";
import { normalizeRecord, applyCrossref, parseAuthorName, normalizeDoi, initials } from "../src/lib/record.js";

const RAW = {
  url: "https://www.sciencedirect.com/science/article/pii/S0000000000000000",
  pageTitle: "A Study of Things - ScienceDirect",
  lang: "en",
  arxivId: "",
  doiFromText: "10.1016/j.demo.2021.01.001.",
  meta: {
    title: "A Study of Things",
    authors: ["Smith, John", "Doe, Jane", "Lee, K."],
    journal: "Journal of Demos",
    conference: "",
    volume: "12",
    issue: "3",
    firstpage: "45",
    lastpage: "58",
    date: "2021-04-02",
    year: "",
    doi: "",
    issn: "1234-5678",
    isbn: "",
    publisher: "Elsevier",
    place: "",
    type: "journal",
    abstract: "",
    pmid: "",
    language: "",
  },
  jsonld: [],
};

export default function register(test) {
  test("作者解析：Family, Given / Given Family / 缩写 / 中文", () => {
    assert.deepEqual(parseAuthorName("Smith, John"), { family: "Smith", given: "John" });
    assert.deepEqual(parseAuthorName("John Smith"), { family: "Smith", given: "John" });
    assert.deepEqual(parseAuthorName("Smith J"), { family: "Smith", given: "J" });
    assert.deepEqual(parseAuthorName("张三"), { literal: "张三" });
    assert.equal(parseAuthorName("  "), null);
    assert.equal(initials("John Robert"), "J. R.");
  });

  test("normalizeDoi 去掉前缀与尾部标点", () => {
    assert.equal(normalizeDoi("https://doi.org/10.1/ABC."), "10.1/ABC");
    assert.equal(normalizeDoi("doi: 10.1/xyz"), "10.1/xyz");
    assert.equal(normalizeDoi("10.1016/j.demo.2021.01.001."), "10.1016/j.demo.2021.01.001");
  });

  test("citation_* 元数据归一", () => {
    const rec = normalizeRecord(RAW);
    assert.equal(rec.title, "A Study of Things");
    assert.equal(rec.container, "Journal of Demos");
    assert.equal(rec.year, "2021");
    assert.equal(rec.volume, "12");
    assert.equal(rec.issue, "3");
    assert.equal(rec.pages, "45-58");
    assert.equal(rec.doi, "10.1016/j.demo.2021.01.001");
    assert.equal(rec.authors.length, 3);
    assert.deepEqual(rec.authors[0], { family: "Smith", given: "John" });
    assert.equal(rec.itemType, "journalArticle");
    assert.equal(rec.hasCoreFields, true);
  });

  test("缺 title 时回退页面标题并去掉站点后缀", () => {
    const raw = { ...RAW, meta: { ...RAW.meta, title: "" }, pageTitle: "A Study of Things - ScienceDirect" };
    assert.equal(normalizeRecord(raw).title, "A Study of Things");
  });

  test("JSON-LD 作为作者与期刊的回退来源", () => {
    const raw = {
      url: "https://example.org/a",
      pageTitle: "Fallback",
      meta: { title: "", authors: [], journal: "" },
      jsonld: [{
        "@type": "ScholarlyArticle",
        name: "JSON Title",
        author: [{ givenName: "Ada", familyName: "Lovelace" }, { name: "Alan Turing" }],
        datePublished: "1950-10",
        isPartOf: { name: "Mind", volumeNumber: "59", issueNumber: "236" },
        pageStart: "433",
        pageEnd: "460",
      }],
    };
    const rec = normalizeRecord(raw);
    assert.equal(rec.title, "JSON Title");
    assert.equal(rec.container, "Mind");
    assert.equal(rec.year, "1950");
    assert.equal(rec.volume, "59");
    assert.equal(rec.pages, "433-460");
    assert.equal(rec.authors[0].family, "Lovelace");
    assert.equal(rec.authors[1].family, "Turing");
    assert.equal(rec.authors[1].given, "Alan");
  });

  test("arXiv 链接识别为 preprint", () => {
    const rec = normalizeRecord({
      url: "https://arxiv.org/abs/1706.03762v5",
      pageTitle: "Attention Is All You Need",
      arxivId: "1706.03762",
      meta: { title: "Attention Is All You Need" },
      jsonld: [],
    });
    assert.equal(rec.arxivId, "1706.03762");
    assert.equal(rec.container, "arXiv");
    assert.equal(rec.itemType, "preprint");
  });

  test("Crossref 只补空缺，不覆盖页面已有值", () => {
    const rec = normalizeRecord({ ...RAW, meta: { ...RAW.meta, authors: [], journal: "" } });
    applyCrossref(rec, {
      title: ["Crossref Title"],
      author: [{ family: "Ng", given: "Andrew" }],
      "container-title": ["Nature"],
      volume: "99",
      issue: "1",
      page: "1-9",
      issued: { "date-parts": [[2022, 5, 1]] },
      DOI: "10.1038/x",
      type: "journal-article",
    });
    assert.equal(rec.title, "A Study of Things");
    assert.equal(rec.container, "Nature");
    assert.equal(rec.volume, "12");
    assert.equal(rec.pages, "45-58");
    assert.equal(rec.year, "2021");
    assert.equal(rec.authors[0].family, "Ng");
    assert.equal(rec.doi, "10.1016/j.demo.2021.01.001");
    assert.ok(rec.source.includes("crossref"));
  });
}
