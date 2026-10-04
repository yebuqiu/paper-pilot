"use strict";

const { test, assert, run } = require("./_harness");
const E = require("../src/exporters");

const ENTRIES = [
  {
    arxivId: "2501.00001", version: 2, title: 'Sparse Autoencoders, "Interpretability" & More',
    authors: ["Ada Lovelace", "Alan Turing"], primaryCategory: "cs.LG", categories: ["cs.LG", "cs.CL"],
    published: "2025-01-01T10:00:00Z", updated: "2025-03-11T09:30:00Z",
    doi: "10.1234/x", journalRef: "JMI 3 (2025) 100-121", comment: "Accepted at ICLR",
    absUrl: "https://arxiv.org/abs/2501.00001v2", pdfUrl: "https://arxiv.org/pdf/2501.00001v2",
    summary: "Line one.\nLine two with, comma and \"quotes\".",
  },
  {
    arxivId: "2502.00002", version: 1, title: "Plain Paper", authors: ["Grace Hopper"],
    primaryCategory: "cs.CL", categories: ["cs.CL"], published: "2025-02-01T00:00:00Z", updated: "2025-02-01T00:00:00Z",
    doi: "", journalRef: "", comment: "", absUrl: "https://arxiv.org/abs/2502.00002v1", pdfUrl: "", summary: "Short.",
  },
];

test("toJSON：默认缩进，pretty:false 压缩", () => {
  const pretty = E.toJSON({ a: 1 });
  assert.ok(pretty.indexOf("\n") > 0);
  assert.strictEqual(E.toJSON({ a: 1 }, { pretty: false }), '{"a":1}');
});

test("toJSON：可接受 {entries} 包装", () => {
  assert.ok(JSON.parse(E.toJSON({ entries: ENTRIES })).entries.length === 2);
});

test("toJSONL：每行一条，行数正确且每行可解析", () => {
  const s = E.toJSONL({ entries: ENTRIES });
  const lines = s.trim().split("\n");
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(JSON.parse(lines[1]).arxivId, "2502.00002");
});

test("toCSV：表头正确且含 BOM（Excel 中文不乱码）", () => {
  const csv = E.toCSV(ENTRIES);
  assert.strictEqual(csv.charCodeAt(0), 0xFEFF, "首字符应为 BOM");
  const first = csv.slice(1).split("\n")[0];
  assert.ok(first.indexOf("arxiv_id,version,title") === 0, "实际：" + first);
});

test("toCSV：含逗号/引号/换行的字段被正确转义（RFC 4180）", () => {
  const csv = E.toCSV([ENTRIES[0]]);
  assert.ok(csv.indexOf('"Sparse Autoencoders, ""Interpretability"" & More"') > 0, "标题应加引号且内部引号翻倍");
  assert.ok(csv.indexOf('"Line one.\nLine two with, comma and ""quotes""."') > 0, "摘要中的换行必须保留在引号内");
});

test("toCSV：多值字段用分隔符连接，可自定义", () => {
  assert.ok(E.toCSV([ENTRIES[0]], { bom: false }).indexOf("Ada Lovelace; Alan Turing") > 0);
  assert.ok(E.toCSV([ENTRIES[0]], { bom: false, arraySeparator: "|" }).indexOf("Ada Lovelace|Alan Turing") > 0);
});

test("toCSV：bom:false 与 crlf:true 选项", () => {
  const csv = E.toCSV([ENTRIES[0]], { bom: false, crlf: true });
  assert.notStrictEqual(csv.charCodeAt(0), 0xFEFF);
  assert.ok(csv.indexOf("\r\n") > 0);
});

test("toCSV：可指定列子集", () => {
  const csv = E.toCSV(ENTRIES, { bom: false, columns: ["arxivId", "title"] });
  const lines = csv.trim().split("\n");
  assert.strictEqual(lines[0], "arxiv_id,title");
  assert.strictEqual(lines[1].split(",")[0], "2501.00001");
});

test("csvCell：仅在必要时加引号", () => {
  assert.strictEqual(E.csvCell("plain"), "plain");
  assert.strictEqual(E.csvCell("a,b"), '"a,b"');
  assert.strictEqual(E.csvCell('a"b'), '"a""b"');
  assert.strictEqual(E.csvCell(" padded "), '" padded "');
});

test("toBibTeX：有 journal_ref 用 @article，否则 @misc；eprint/archivePrefix 必备", () => {
  const bib = E.toBibTeX(ENTRIES);
  assert.ok(bib.indexOf("@article{arxiv250100001,") === 0, "实际开头：" + bib.slice(0, 40));
  assert.ok(bib.indexOf("@misc{arxiv250200002,") > 0);
  assert.ok(bib.indexOf("eprint = {2501.00001}") > 0);
  assert.ok(bib.indexOf("archivePrefix = {arXiv}") > 0);
  assert.ok(bib.indexOf("primaryClass = {cs.LG}") > 0);
});

test("toBibTeX：LaTeX 特殊字符被转义，作者以 and 连接", () => {
  const bib = E.toBibTeX([{ arxivId: "1", title: "A & B_C 100%", authors: ["X", "Y"], published: "2025-01-01" }]);
  assert.ok(bib.indexOf("A \\& B\\_C 100\\%") > 0, "实际：" + bib);
  assert.ok(bib.indexOf("author = {X and Y}") > 0);
});

test("toBibTeX：includeAbstract 可选", () => {
  assert.strictEqual(E.toBibTeX([ENTRIES[0]]).indexOf("abstract ="), -1);
  assert.ok(E.toBibTeX([ENTRIES[0]], { includeAbstract: true }).indexOf("abstract =") > 0);
});

test("toEntries：数组、包装对象、空值都安全", () => {
  assert.strictEqual(E.toEntries(ENTRIES).length, 2);
  assert.strictEqual(E.toEntries({ entries: ENTRIES }).length, 2);
  assert.strictEqual(E.toEntries(null).length, 0);
  assert.strictEqual(E.toEntries({}).length, 0);
});

test("toCSV / toJSONL 对空输入不崩", () => {
  assert.ok(E.toCSV([]).length > 0, "空输入也应输出表头");
  assert.strictEqual(E.toJSONL([]), "");
});

run("exporter");
