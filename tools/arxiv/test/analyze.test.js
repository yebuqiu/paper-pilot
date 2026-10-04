"use strict";

const { test, assert, run } = require("./_harness");
const A = require("../src/analyze");

/* ---------------------------- 分词 / 高亮 ---------------------------- */

test("分词：去停用词、保留连字符、中文二元切分", () => {
  const t = A.tokenize("We propose a retrieval-augmented pipeline 用于医学影像分割");
  assert.ok(t.indexOf("retrieval-augmented") >= 0, "连字符词应保留");
  assert.ok(t.indexOf("propose") < 0, "停用词应被移除");
  assert.ok(t.indexOf("影像") >= 0, "中文应切二元");
});

test("高亮：ASCII 词按词边界匹配，不做子串误伤", () => {
  const r = A.highlight("Attention is all you need. Attentions differ.", ["attention"]);
  assert.strictEqual(r.marks, 1, "不应匹配 attentions");
  assert.strictEqual(r.text, "**Attention** is all you need. Attentions differ.");
});

test("高亮：合并相邻词元保留标点（词边界）", () => {
  const r = A.highlight("Sparse, autoencoder-based models.", ["autoencoder"]);
  assert.ok(r.text.indexOf("**autoencoder**") > 0, "实际：" + r.text);
});

test("高亮：中文按子串匹配（\\b 对 CJK 无效，不能加词边界）", () => {
  const r = A.highlight("本文研究医学影像分割方法", ["医学影像"]);
  assert.strictEqual(r.marks, 1);
  assert.ok(r.text.indexOf("**医学影像**") >= 0);
});

test("高亮：长词优先（避免被短前缀吃掉）", () => {
  const r = A.highlight("attention mechanism", ["attention", "attention mechanism"]);
  assert.ok(r.text.indexOf("**attention mechanism**") >= 0, "实际：" + r.text);
});

test("高亮：统计命中次数并按次数排序", () => {
  const r = A.highlight("rag rag rag retrieval", ["rag", "retrieval"]);
  assert.strictEqual(r.hits[0].term, "rag");
  assert.strictEqual(r.hits[0].count, 3);
  assert.strictEqual(r.marks, 4);
});

test("高亮：maxMarks 限制标注数量", () => {
  const r = A.highlight("a a a a a", ["a"], { maxMarks: 2 });
  assert.strictEqual(r.marks, 2);
});

test("高亮：空词表为恒等操作", () => {
  const r = A.highlight("hello", [], {});
  assert.strictEqual(r.text, "hello");
  assert.strictEqual(r.marks, 0);
});

/* ---------------------------- 结构化摘要 ---------------------------- */

test("结构化摘要：识别 Background/Methods/Results/Conclusions 四段", () => {
  const s = A.splitStructuredAbstract(
    "Background: SAEs are popular. Methods: we train on 7B activations. Results: 84% variance. Conclusions: tune carefully."
  );
  assert.strictEqual(s.structured, true);
  assert.deepStrictEqual(s.sections.map((x) => x.key), ["background", "methods", "results", "conclusions"]);
  assert.strictEqual(s.sections[1].text, "we train on 7B activations.");
});

test("结构化摘要：中文章节名同样识别", () => {
  const s = A.splitStructuredAbstract("背景：心力衰竭常见。方法：回顾性队列研究。结果：共纳入 120 例。结论：疗效确切。");
  assert.strictEqual(s.structured, true);
  assert.strictEqual(s.sections.length, 4);
  assert.strictEqual(s.sections[0].key, "background");
});

test("结构化摘要：只有一个标签时不判定为结构化（避免碎片化）", () => {
  const s = A.splitStructuredAbstract("This paper studies X. Results: we find Y and Z in many settings.");
  assert.strictEqual(s.structured, false);
  assert.strictEqual(s.sections.length, 0);
});

test("结构化摘要：普通摘要原样返回", () => {
  const text = "We present a new method for X that improves Y by 5%.";
  const s = A.splitStructuredAbstract(text);
  assert.strictEqual(s.structured, false);
  assert.strictEqual(s.text, text);
});

test("结构化摘要：接受 summaryParagraphs 数组输入", () => {
  const s = A.splitStructuredAbstract(["Objective: to test.", "Methods: cohort.", "Results: positive."]);
  assert.strictEqual(s.structured, true);
  assert.strictEqual(s.sections.length, 3);
});

/* ---------------------------- 分类统计 ---------------------------- */

const ENTRIES = [
  { arxivId: "1", title: "A", primaryCategory: "cs.LG", categories: ["cs.LG", "cs.CL"], published: "2025-01-05T00:00:00Z", summary: "deep learning attention model" },
  { arxivId: "2", title: "B", primaryCategory: "cs.LG", categories: ["cs.LG"], published: "2025-01-20T00:00:00Z", summary: "deep learning attention transformer" },
  { arxivId: "3", title: "C", primaryCategory: "cs.CL", categories: ["cs.CL", "cs.LG"], published: "2025-02-02T00:00:00Z", summary: "language model attention" },
  { arxivId: "4", title: "D", primaryCategory: "stat.ML", categories: ["stat.ML"], published: "2025-02-15T00:00:00Z", summary: "statistical learning theory bound" },
];

test("分类统计：全量标签分布与占比", () => {
  const s = A.categoryStats(ENTRIES);
  assert.strictEqual(s.total, 4);
  assert.strictEqual(s.distinctCategories, 3);
  const lg = s.byCategory.find((x) => x.name === "cs.LG");
  assert.strictEqual(lg.count, 3);
  assert.strictEqual(lg.share, 0.75);
});

test("分类统计：主分类与大类分布", () => {
  const s = A.categoryStats(ENTRIES);
  assert.strictEqual(s.byPrimary.find((x) => x.name === "cs.LG").count, 2);
  assert.strictEqual(s.byArchive.find((x) => x.name === "cs").count, 3);
});

test("分类统计：共现对", () => {
  const s = A.categoryStats(ENTRIES);
  assert.strictEqual(s.coOccurrence[0].pair, "cs.CL + cs.LG");
  assert.strictEqual(s.coOccurrence[0].count, 2);
});

test("时间分布：按月分桶且按时间升序", () => {
  const h = A.dateHistogram(ENTRIES, { bucket: "month" });
  assert.deepStrictEqual(h, [{ bucket: "2025-01", count: 2 }, { bucket: "2025-02", count: 2 }]);
});

test("关键词抽取：TF-IDF 排序，标题权重高于摘要", () => {
  const k = A.extractKeywords(ENTRIES, { topN: 5 });
  assert.ok(k.length > 0);
  const attention = k.find((x) => x.term === "attention");
  assert.ok(attention, "attention 应出现在关键词中");
  assert.ok(attention.df === 3);
  assert.ok(k[0].score >= k[k.length - 1].score, "应按分值降序");
});

/* ---------------------------- 主题聚类 ---------------------------- */

const CLUSTER_ENTRIES = [
  { arxivId: "s1", title: "Deep learning for medical image segmentation", summary: "image segmentation convolutional network medical imaging dice score", published: "2025-03-01T00:00:00Z" },
  { arxivId: "s2", title: "Transformer based medical image segmentation", summary: "image segmentation vision transformer medical imaging dice", published: "2025-03-02T00:00:00Z" },
  { arxivId: "s3", title: "Semi-supervised medical image segmentation", summary: "image segmentation pseudo labels medical imaging", published: "2025-03-03T00:00:00Z" },
  { arxivId: "p1", title: "Speech recognition with wav2vec", summary: "speech recognition acoustic model phoneme wav2vec", published: "2025-03-04T00:00:00Z" },
  { arxivId: "p2", title: "End-to-end speech recognition", summary: "speech recognition acoustic model transducer phoneme", published: "2025-03-05T00:00:00Z" },
  { arxivId: "p3", title: "Robust speech recognition under noise", summary: "speech recognition acoustic model noise robustness phoneme", published: "2025-03-06T00:00:00Z" },
];

test("聚类：两个主题被分成两簇，且各簇 topTerms 可解释", () => {
  const r = A.clusterTopics(CLUSTER_ENTRIES, { k: 2, seed: 7 });
  assert.strictEqual(r.k, 2);
  assert.strictEqual(r.clusters.length, 2);
  const sizes = r.clusters.map((c) => c.size).sort();
  assert.deepStrictEqual(sizes, [3, 3]);
  const allTerms = r.clusters.map((c) => c.topTerms.join(" ")).join(" | ");
  assert.ok(/segmentation/.test(allTerms), "应有一个簇围绕 segmentation，实际：" + allTerms);
  assert.ok(/speech|phoneme|acoustic|recognition/.test(allTerms), "应有一个簇围绕 speech，实际：" + allTerms);
});

test("聚类：同一 seed 结果完全一致（可复现）", () => {
  const a = A.clusterTopics(CLUSTER_ENTRIES, { k: 2, seed: 42 });
  const b = A.clusterTopics(CLUSTER_ENTRIES, { k: 2, seed: 42 });
  assert.deepStrictEqual(a.clusters.map((c) => c.entryIds.sort()), b.clusters.map((c) => c.entryIds.sort()));
});

test("聚类：n<2 时优雅退化", () => {
  const r = A.clusterTopics([CLUSTER_ENTRIES[0]], { k: 3 });
  assert.strictEqual(r.clusters.length, 1);
  assert.strictEqual(r.clusters[0].size, 1);
});

test("聚类：k 大于样本数时被裁剪", () => {
  const r = A.clusterTopics(CLUSTER_ENTRIES.slice(0, 2), { k: 10 });
  assert.ok(r.k <= 2, "k 不应超过样本数，实际 " + r.k);
});

/* ---------------------------- 汇总入口 ---------------------------- */

test("analyze()：一次产出高亮/结构化/统计/聚类/关键词", () => {
  const out = A.analyze(CLUSTER_ENTRIES, {
    highlight: true,
    highlightTerms: ["segmentation", "speech"],
    structured: true,
    cluster: 2,
    keywords: 5,
    histogram: "month",
  });
  assert.strictEqual(out.total, 6);
  assert.ok(out.entries[0].titleHighlighted.indexOf("**segmentation**") > 0);
  assert.ok(out.categories && out.categories.total === 6);
  assert.ok(out.clusters && out.clusters.k === 2);
  assert.strictEqual(out.keywords.length, 5);
  assert.ok(out.histogram.length >= 1);
  assert.strictEqual(typeof out.structuredCount, "number");
});

run("analyze");
