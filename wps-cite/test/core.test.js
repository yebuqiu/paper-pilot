#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 纯逻辑内核测试：书签编码 / 引文模型 / 两种样式 / 双向链接
 *
 * 这些模块刻意不碰 wps.*，所以能在 Node 里直接跑。旧实现的教训是
 * "排版决策与文档 I/O 搅在一起，只能靠人眼在 WPS 里试"——这里把它切开钉死。
 *
 * 运行：node wps-cite/test/core.test.js
 */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..', 'addon', 'js');

const codes = require(path.join(ROOT, 'codes.js'));
const util = require(path.join(ROOT, 'styles', 'util.js'));
const gb = require(path.join(ROOT, 'styles', 'gb7714.js'));
const apa = require(path.join(ROOT, 'styles', 'apa.js'));
const model = require(path.join(ROOT, 'model.js'));
const links = require(path.join(ROOT, 'links.js'));
const zf = require(path.join(ROOT, 'zfields.js'));

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }
function includes(hay, needle, label) {
  return ok(String(hay).indexOf(needle) >= 0, label, { want: needle, got: String(hay).slice(0, 160) });
}

/* ---------------- 样本条目（贴近 Zotero 本地 API 的 data 结构） ---------------- */
const ITEM = {
  K1: {
    itemType: 'journalArticle', title: '注意力机制在机器翻译中的应用',
    creators: [{ lastName: '张', firstName: '三', creatorType: 'author' }],
    date: '2020-05-01', publicationTitle: '计算机学报', volume: '43', issue: '5',
    pages: '1-12', language: 'zh', DOI: '10.1234/j.2020.001',
  },
  K2: {
    itemType: 'book', title: '深度学习', place: '北京', publisher: '人民邮电出版社',
    creators: [
      { lastName: 'Goodfellow', firstName: 'Ian', creatorType: 'author' },
      { lastName: 'Bengio', firstName: 'Yoshua', creatorType: 'author' },
      { lastName: 'Courville', firstName: 'Aaron', creatorType: 'author' },
      { lastName: 'Li', firstName: 'Ming', creatorType: 'author' },
    ],
    date: '2016',
  },
  K3: {
    itemType: 'thesis', title: '基于图神经网络的推荐算法研究',
    creators: [{ lastName: '李', firstName: '四', creatorType: 'author' }],
    date: '2021', university: '清华大学', place: '北京',
  },
  K4: {
    itemType: 'webpage', title: 'Zotero 官方文档',
    creators: [{ name: 'Zotero Team' }], date: '2024', url: 'https://www.zotero.org/support/',
  },
};

/* ---------------- ① 书签编码 ---------------- */
{
  const n1 = codes.make(() => false, { itemKey: 'K2M9X4TA', page: 7, anno: 'A1B2C3D4' });
  eq(n1, 'PPC0001_K2M9X4TA_p7_aA1B2C3D4', '① make 生成规范名');
  ok(n1.length <= codes.MAXLEN, '① 名字不超过 40 字符', n1.length);

  const p = codes.parse(n1);
  eq(p.itemKey, 'K2M9X4TA', '① 解析 itemKey');
  eq(p.page, 7, '① 解析页码');
  eq(p.anno, 'A1B2C3D4', '① 解析标注');
  eq(p.idx, 0, '① 缺省簇序号为 0');
  eq(p.libId, 1, '① 缺省库为 1');

  const used = new Set([n1]);
  const n2 = codes.make((x) => used.has(x), { itemKey: 'K2M9X4TA', page: 7, anno: 'A1B2C3D4' });
  ok(n2 !== n1 && codes.parse(n2).token !== p.token, '① 冲突时换 token', n2);

  const c1 = codes.makeInCluster(() => false, 'abcd', { itemKey: 'K2M9X4TA' }, 1);
  eq(codes.parse(c1).idx, 1, '① 同簇 idx 递增');
  ok(codes.parse(c1).token === 'abcd', '① 同簇共用 token');

  eq(codes.parse('PPCBIB'), null, '① 文献表锚不被当作引文');
  eq(codes.parse('Hello'), null, '① 非本插件书签返回 null');
  eq(codes.sanitizeLocator('12-15页'), '12-15', '① 页码 locator 只留合法字符');
}

/* ---------------- ② 引文模型 ---------------- */
{
  const scan = [
    { name: 'PPC0002_K2M9X4TB', start: 100 },
    { name: 'PPC0001_K2M9X4TA_p7_aA1B2C3D4', start: 50 },
  ];
  const cl = model.cluster(scan);
  eq(cl.length, 2, '② 两个位置两簇');
  eq(cl[0].token, '0001', '② 按位置排序（不是按书签名）');

  const plan = model.plan(scan, { K2M9X4TA: ITEM.K1, K2M9X4TB: ITEM.K2 }, gb);
  eq(plan.seqOf.K2M9X4TA, 1, '② 先出现的编 1');
  eq(plan.seqOf.K2M9X4TB, 2, '② 后出现的编 2');
  const e1 = plan.edits.find((x) => x.name.indexOf('0001') > 0);
  eq(e1.text, '[1]', '② 单条引文渲染 [1]');
  eq(plan.bib.length, 2, '② 文献表两条');
  eq(plan.bib[0].itemKey, 'K2M9X4TA', '② 文献表按编号顺序');

  // 同簇两篇（idx 0/1）→ 一个 [1,2]，另一条书签被清理
  const multi = [
    { name: 'PPC0003_K2M9X4TA', start: 10 },
    { name: 'PPC0003_K2M9X4TC_i1', start: 10 },
  ];
  const p2 = model.plan(multi, { K2M9X4TA: ITEM.K1, K2M9X4TC: ITEM.K3 }, gb);
  const head = p2.edits.find((x) => x.name === 'PPC0003_K2M9X4TA');
  eq(head.text, '[1,2]', '② 同一处两篇合并渲染');
  const extra = p2.edits.find((x) => x.name.indexOf('_i1') > 0);
  ok(extra && extra.remove, '② 同簇后续书签被清理');

  // 条目丢了 → [?]，不静默删
  const p3 = model.plan([{ name: 'PPC0004_ZZZZ9999', start: 5 }], {}, gb);
  eq(p3.edits[0].text, '[?]', '② 找不到条目时降级为 [?]');
  eq(p3.missing.length, 1, '② 丢失条目被记录');

  // 作者-年制不编号
  const p4 = model.plan(scan, { K2M9X4TA: ITEM.K1, K2M9X4TB: ITEM.K2 }, apa);
  eq(p4.edits[0].text, '(张三, 2020)', '② APA 单条渲染');
  ok(p4.bib.every((b) => b.seq === 0), '② APA 不用编号');
}

/* ---------------- ③ GB/T 7714 ---------------- */
{
  eq(gb.compress([1, 2, 3, 7]), '1-3,7', '③ 连续编号压缩');
  eq(gb.compress([2, 1]), '1,2', '③ 压缩前排序去重');
  eq(gb.cite([{ seq: 1, locator: '' }]), '[1]', '③ 单条引文');
  eq(gb.cite([{ seq: 3, locator: '12' }]), '[3]12', '③ 单条带页码');
  eq(gb.cite([{ seq: 1 }, { seq: 3 }]), '[1,3]', '③ 两条不连续');
  eq(gb.cite([{ seq: 1 }, { seq: 2 }, { seq: 3 }]), '[1-3]', '③ 三条连续压缩');

  const journal = gb.bib([{ seq: 1, item: ITEM.K1 }])[0];
  includes(journal, '[1] ', '③ 文献表带序号');
  includes(journal, '张三. ', '③ 中文作者');
  includes(journal, '[J]', '③ 期刊类型标识');
  includes(journal, '计算机学报', '③ 刊名');
  includes(journal, '2020', '③ 年份');
  includes(journal, '43(5)', '③ 卷期');
  includes(journal, '1–12', '③ 页码短横线规范化');

  const book = gb.bib([{ seq: 2, item: ITEM.K2 }])[0];
  includes(book, '[M]', '③ 专著标识');
  includes(book, ', et al', '③ 西文四位作者只列三位加 et al');
  ok(/COURVILLE/i.test(book), '③ 第三位作者保留');
  ok(!/LI M\./i.test(book), '③ 第四位作者被省略');

  const thesis = gb.bib([{ seq: 3, item: ITEM.K3 }])[0];
  includes(thesis, '[D]', '③ 学位论文标识');
  includes(thesis, '清华大学', '③ 学校名');

  const web = gb.bib([{ seq: 4, item: ITEM.K4 }])[0];
  includes(web, '[EB/OL]', '③ 网页标识');
  includes(web, 'zotero.org', '③ URL 保留');
}

/* ---------------- ④ APA ---------------- */
{
  eq(apa.cite([{ item: ITEM.K1 }]), '(张三, 2020)', '④ 中文单作者');
  includes(apa.cite([{ item: ITEM.K2 }]), 'Goodfellow et al.', '④ 三作者以上只留姓 + et al.');
  includes(apa.cite([{ item: ITEM.K1, locator: '5' }]), 'p. 5', '④ 页码 p.');
  includes(apa.cite([{ item: ITEM.K1, locator: '5-7' }]), 'pp. 5-7', '④ 页码范围 pp.');
  const two = apa.cite([{ item: ITEM.K1 }, { item: ITEM.K3 }]);
  ok(two.indexOf('; ') > 0, '④ 多篇用分号连接');

  const bib = apa.bib([{ item: ITEM.K1 }, { item: ITEM.K3 }]);
  eq(bib.length, 2, '④ 文献表条数');
  includes(bib[0] + bib[1], 'https://doi.org/10.1234', '④ DOI 输出为链接');
  ok(/\(\d{4}\)\./.test(bib[0]), '④ 年带括号');
}

/* ---------------- ⑤ 双向链接 ---------------- */
{
  const u = links.pdfUri('ABCD1234', 7, 'a1b2c3d4');
  eq(u, 'zotero://open-pdf/library/items/ABCD1234?page=7&annotation=A1B2C3D4', '⑤ PDF 深链');
  eq(links.pdfUri('ABCD1234', 0, ''), 'zotero://open-pdf/library/items/ABCD1234', '⑤ 无页码时不给 query');
  eq(links.selectUri('ABCD1234', 1), 'zotero://select/library/items/ABCD1234', '⑤ 个人库选中');
  eq(links.selectUri('ABCD1234', 3), 'zotero://select/groups/3/items/ABCD1234', '⑤ 群组库选中');

  const rec = links.record('C:\\docs\\a.docx', {
    token: '0001', itemKey: 'ABCD1234', page: 7, anno: 'a1b2c3d4', text: '注意力机制', snippet: '这是一段很长的原文，用来验证摘要会被截断处理',
  });
  eq(rec.doc, 'C:\\docs\\a.docx', '⑤ 台账记录带文档');
  ok(rec.snippet.length <= 61, '⑤ 摘要被截断', rec.snippet.length);

  const md = links.sidecarMarkdown({ title: '注意力机制' }, [rec], () => '论文初稿.docx');
  includes(md, '第 7 页', '⑤ 边车按页分组');
  includes(md, '论文初稿.docx', '⑤ 边车带文档名');
  includes(md, 'file:///', '⑤ 边车带可点击链接');
}

/* ---------------- ⑥ dotm 的 Zotero 域解析（双向链接要作用于官方引文） ---------------- */
{
  const code = ' ADDIN ZOTERO_ITEM CSL_CITATION {"citationID":"AbC123","properties":{"formattedCitation":"[1]","style":"http://www.zotero.org/styles/gb-t-7714-2015-numeric"},"citationItems":[{"id":"http://zotero.org/users/8552292/items/MWG8GNMN","locator":"7","label":"page"}],"schema":"https://github.com/citation-style-language/schema/raw/master/csl-citation.json"} ';

  const f = zf.parseField(code);
  ok(f && f.kind === "item", '⑥ 认出 ZOTERO_ITEM 域');
  eq(f.items.length, 1, '⑥ 解析出一条条目');
  eq(f.items[0].key, "MWG8GNMN", '⑥ 从 URI 取出 itemKey');
  eq(f.items[0].libId, 8552292, '⑥ 取出 libraryID');
  eq(f.items[0].locator, "7", '⑥ 保留 locator');
  eq(f.citationID, "AbC123", '⑥ 取出 citationID');
  includes(f.style, "gb-t-7714-2015-numeric", '⑥ 取出样式名');

  const bibl = zf.parseField(' ADDIN ZOTERO_BIBL {"custom":[]} CSL_BIBLIOGRAPHY ');
  ok(bibl && bibl.kind === "bibl", '⑥ 认出文献表域');

  eq(zf.parseField(' ADDIN HYPERLINK "http://x" '), null, '⑥ 非 Zotero 域返回 null');
  eq(zf.parseField(''), null, '⑥ 空域代码返回 null');

  // 坏 JSON 不能抛
  ok(zf.parseField(' ADDIN ZOTERO_ITEM CSL_CITATION {bad json ') !== undefined, '⑥ 坏 JSON 不抛异常');

  const items = zf.collectItems([code, code]);
  eq(items.length, 1, '⑥ 同一文档重复出现只算一次');

  const g = zf.parseField(' ADDIN ZOTERO_ITEM CSL_CITATION {"citationItems":[{"id":"http://zotero.org/groups/42/items/ABCD2345"}]} ');
  eq(g.items[0].libId, 42, '⑥ 群组库 libId 正确');
  eq(g.items[0].libType, "groups", '⑥ 群组库类型正确');
}

/* ---------------- 汇总 ---------------- */
console.log('='.repeat(60));
if (fails.length) {
  for (const f of fails) console.log('  !!  ' + f);
  console.log('='.repeat(60));
  console.log(`核心内核：${pass} 通过 / ${fails.length} 失败`);
  process.exit(1);
}
console.log(`核心内核：${pass} 项断言全部通过`);
