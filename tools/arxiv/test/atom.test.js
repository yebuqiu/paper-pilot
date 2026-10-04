"use strict";

const fs = require("fs");
const path = require("path");
const { test, assert, run } = require("./_harness");
const atom = require("../src/atom");

const EX = path.join(__dirname, "..", "examples");
const REAL = fs.readFileSync(path.join(EX, "sample-atom.xml"), "utf8");
const MULTI = fs.readFileSync(path.join(EX, "sample-atom-multi.xml"), "utf8");
const ERROR_FEED = fs.readFileSync(path.join(EX, "sample-atom-error.xml"), "utf8");

test("真实响应：解析 feed 元信息与单条 entry", () => {
  const r = atom.parseAtom(REAL);
  assert.strictEqual(r.entries.length, 1);
  assert.ok(r.meta.totalResults > 0, "应解析出 totalResults");
  const e = r.entries[0];
  assert.strictEqual(e.arxivId, "2610.01889");
  assert.strictEqual(e.baseId, "2610.01889");
  assert.strictEqual(e.version, 1);
  assert.strictEqual(e.versionTag, "v1");
  assert.ok(e.title.indexOf("Stochastic Rounding") === 0);
});

test("真实响应：分类、主分类、pdf/abs 链接", () => {
  const e = atom.parseAtom(REAL).entries[0];
  assert.deepStrictEqual(e.categories, ["cs.LG", "cs.CL"]);
  assert.strictEqual(e.primaryCategory, "cs.LG");
  assert.strictEqual(e.archive, "cs");
  assert.strictEqual(e.absUrl, "https://arxiv.org/abs/2610.01889v1");
  assert.strictEqual(e.pdfUrl, "https://arxiv.org/pdf/2610.01889v1");
});

test("真实响应：作者与机构分块解析（机构不跨作者串味）", () => {
  const e = atom.parseAtom(REAL).entries[0];
  assert.strictEqual(e.authors.length, 2);
  assert.strictEqual(e.authors[0], "Yohan Chatelain");
  assert.strictEqual(e.authorsDetailed[0].affiliations[0], "Krembil Centre for Neuroinformatics, CAMH, Toronto, Canada");
  assert.strictEqual(e.authorsDetailed[1].affiliations[0], "Universite Paris-Saclay, UVSQ, LI-PaRAD, Versailles, France");
});

test("真实响应：comment 保留、摘要压平但保留段落", () => {
  const e = atom.parseAtom(REAL).entries[0];
  assert.ok(e.comment.indexOf("fuzzy-llm") > 0);
  assert.strictEqual(e.summary.indexOf("\n"), -1, "summary 应为压平后的单行");
  assert.ok(e.summaryParagraphs.length >= 2, "summaryParagraphs 应保留自然段");
  assert.ok(e.summary.length > 500);
});

test("标题里的 XML 实体被正确解码", () => {
  const entries = atom.parseAtom(MULTI).entries;
  const t = entries[0].title;
  assert.ok(t.indexOf("Sparse Autoencoders & Interpretability") === 0, "&amp; 应解码为 &，实际：" + t.slice(0, 60));
});

test("硬换行的标题被压平成单行", () => {
  const entries = atom.parseAtom(MULTI).entries;
  const e = entries.find((x) => x.arxivId === "2502.12345");
  assert.strictEqual(e.title, "Retrieval-Augmented Generation for Low-Resource Languages: A Survey");
});

test("摘要中的 &lt;10k 被解码为 <10k", () => {
  const e = atom.parseAtom(MULTI).entries.find((x) => x.arxivId === "2502.12345");
  assert.ok(e.summary.indexOf("<10k-pair") > 0, "实际：" + e.summary.slice(0, 120));
});

test("DOI 与期刊引用解析", () => {
  const e = atom.parseAtom(MULTI).entries.find((x) => x.arxivId === "2501.00001" && x.version === 2);
  assert.strictEqual(e.doi, "10.1234/example.2025.001");
  assert.strictEqual(e.journalRef, "Journal of Mechanistic Interpretability 3 (2025) 100-121");
});

test("按 ID 去重：保留版本号更高的一条，并用旧版补齐字段", () => {
  const raw = atom.parseAtom(MULTI).entries;
  assert.strictEqual(raw.length, 4);
  const d = atom.dedupeEntries(raw, { byId: true, byDoi: true, byTitle: false });
  assert.strictEqual(d.entries.length, 3);
  const v2 = d.entries.find((e) => e.arxivId === "2501.00001");
  assert.strictEqual(v2.version, 2);
  assert.deepStrictEqual(v2.categories, ["cs.LG", "cs.CL"]);
});

test("按标题去重：不同 ID 但同名标题会合并", () => {
  const raw = atom.parseAtom(MULTI).entries;
  const d = atom.dedupeEntries(raw, { byId: true, byDoi: true, byTitle: true });
  assert.strictEqual(d.entries.length, 2, "应只剩 2 条（v1/v2 合并、重名标题合并）");
  assert.strictEqual(d.removed, 2);
  const reasons = d.duplicates.map((x) => x.reason).sort();
  assert.deepStrictEqual(reasons, ["arxiv-id", "title"]);
});

test("按 DOI 去重：DOI 相同但 ID 不同的两条会合并", () => {
  const a = { arxivId: "1", baseId: "1", version: 1, title: "A", doi: "10.1/x", categories: [] };
  const b = { arxivId: "2", baseId: "2", version: 1, title: "B", doi: "10.1/X", categories: [] };
  const d = atom.dedupeEntries([a, b], { byId: true, byDoi: true, byTitle: false });
  assert.strictEqual(d.entries.length, 1);
  assert.strictEqual(d.duplicates[0].reason, "doi");
});

test("错误 feed：必须抛 ApiError 而不是静默返回 0 条结果", () => {
  assert.throws(() => atom.parseAtom(ERROR_FEED), (e) => {
    assert.strictEqual(e.name, "ApiError");
    assert.strictEqual(e.code, "API_ERROR");
    assert.ok(/incorrect category format/.test(e.message), "实际：" + e.message);
    return true;
  });
});

test("空响应抛 ParseError", () => {
  assert.throws(() => atom.parseAtom(""), /空响应/);
});

test("合法但 0 结果：返回空数组且不抛错", () => {
  const empty = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">0</opensearch:totalResults><title>t</title></feed>';
  const r = atom.parseAtom(empty);
  assert.strictEqual(r.entries.length, 0);
  assert.strictEqual(r.meta.totalResults, 0);
});

test("XML 实体单遍解码（&amp;lt; 不得被解成 <）", () => {
  assert.strictEqual(atom.decodeEntities("&amp;lt;"), "&lt;");
  assert.strictEqual(atom.decodeEntities("&lt;b&gt;"), "<b>");
  assert.strictEqual(atom.decodeEntities("&#65;&#x42;"), "AB");
});

test("注释中的 <entry> 不会生成伪条目", () => {
  const xml = REAL.replace("<feed", "<!-- <entry><id>http://arxiv.org/abs/1111.11111v1</id></entry> -->\n<feed");
  assert.strictEqual(atom.parseAtom(xml).entries.length, 1);
});

test("parseArxivId 支持新版 / 旧版 / 带版本 / URL", () => {
  assert.deepStrictEqual(atom.parseArxivId("http://arxiv.org/abs/2610.01889v2"), { baseId: "2610.01889", version: 2, versionTag: "v2", raw: "http://arxiv.org/abs/2610.01889v2" });
  assert.strictEqual(atom.parseArxivId("2501.00001").version, 1);
  assert.strictEqual(atom.parseArxivId("math/0501001v3").baseId, "math/0501001");
});

test("normalizeTitle 忽略标点差异（用于跨源去重）", () => {
  assert.strictEqual(atom.normalizeTitle("Sparse Autoencoders & Interpretability: A Guide!"), atom.normalizeTitle("sparse autoencoders  interpretability a guide"));
});

run("atom");
