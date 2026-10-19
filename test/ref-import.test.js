#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 参考文献一键入库（0.33.0 重写）测试
 *
 * 覆盖四层：
 *   A. RefFormat 纯函数 —— 标识符抽取 / BibTeX 解析与生成 / RIS / EndNote XML / CSL /
 *      合并去重 / 缺失字段判定。这一层是「格式规范」的保证，错了入库就脏。
 *   B. RefSources 解析与联合检索 —— 五源夹具喂进解析函数，验证字段映射与
 *      「多源一致命中」的排序机制（准确率的核心）；网络层用方法替换，不发真请求。
 *   C. RefImport 条目构建 —— 按 itemType 精确映射字段（旧实现不分类型乱 setField
 *      是「入库后字段丢失」的根因）；AI JSON 解析与「只填空」纪律。
 *   D. 对话框渲染 —— 迷你 DOM 真跑 chrome/content/ref-import.js：
 *      来源勾选、结果行、库中已有的默认不勾选、「导入选中」只提交勾中的记录。
 *
 * 无网络、无 Zotero、无 DOM 依赖。
 * 运行：node test/ref-import.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const S = (p) => path.join(ROOT, 'chrome', 'content', 'scripts', p);

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }
function has(hay, needle, label) {
  return ok(String(hay).indexOf(needle) >= 0, label, { want: needle, got: String(hay).slice(0, 220) });
}

/* ---------------- 沙箱：按依赖序加载三个模块 ---------------- */

function deepProxy(name) {
  const fn = function () { return deepProxy(name + '()'); };
  return new Proxy(fn, {
    get(t, k) {
      if (k === Symbol.toPrimitive) return () => '';
      if (k === 'toString') return () => name;
      if (k === 'then') return undefined;
      return deepProxy(name + '.' + String(k));
    },
    apply() { return deepProxy(name + '()'); },
    construct() { return deepProxy('new ' + name); },
  });
}

const PrefStore = new Map();
function makeSandbox(extra) {
  const sandbox = Object.assign({
    console,
    Zotero: deepProxy('Zotero'),
    Services: deepProxy('Services'),
    IOUtils: deepProxy('IOUtils'),
    Components: deepProxy('Components'),
    setTimeout, clearTimeout, setInterval, clearInterval, Promise, Date, Math, JSON,
  }, extra || {});
  // utils.js 的 Prefs 不在加载列表里，这里直接给同名桩（RefSources 读 refImport* 两个键）
  sandbox.Prefs = {
    PREFIX: 'extensions.zotero.papilot.',
    get(k, d) { return PrefStore.has(k) ? PrefStore.get(k) : d; },
    set(k, v) { PrefStore.set(k, v); },
  };
  // I18n 桩：ref-import 里若干处读 I18n.isZh（生产环境必有，测试里要有同名全局）
  sandbox.I18n = { isZh: true, t: (k) => k };
  vm.createContext(sandbox);
  return sandbox;
}

function load(sandbox, rel) {
  vm.runInContext(fs.readFileSync(S(rel), 'utf8'), sandbox, { filename: rel });
}

const sandbox = makeSandbox();
load(sandbox, 'features/ref-format.js');
load(sandbox, 'features/ref-sources.js');
load(sandbox, 'features/ref-import.js');
const RF = sandbox.RefFormat;
const RS = sandbox.RefSources;
const RI = sandbox.RefImport;

/* ---------------- 夹具（真实接口返回结构的精简版） ---------------- */

const FX = {
  crossref: {
    message: {
      DOI: '10.48550/arXiv.1706.03762',
      title: ['Attention is All you Need'],
      author: [{ given: 'Ashish', family: 'Vaswani' }, { given: 'Noam', family: 'Shazeer' }],
      issued: { 'date-parts': [[2017, 6, 12]] },
      'container-title': ['Advances in Neural Information Processing Systems'],
      volume: '30',
      issue: '1',
      page: '5998-6008',
      publisher: 'Curran Associates',
      'publisher-location': 'Red Hook, NY, USA',
      ISSN: ['1049-5258'],
      type: 'proceedings-article',
      abstract: '<jats:p>We propose a new simple network architecture, the Transformer.</jats:p>',
      URL: 'https://doi.org/10.48550/arXiv.1706.03762',
      language: 'en',
      'is-referenced-by-count': 100000,
    },
  },
  openalex: {
    doi: 'https://doi.org/10.48550/arXiv.1706.03762',
    title: 'Attention is All you Need',
    authorships: [{ author: { given_name: 'Ashish', family_name: 'Vaswani', display_name: 'Ashish Vaswani' } }],
    publication_year: 2017,
    publication_date: '2017-06-12',
    primary_location: { source: { display_name: 'arXiv (Cornell University)', issn: ['2331-8422'] } },
    biblio: { volume: '', issue: '', first_page: '', last_page: '' },
    ids: { pmid: '', pmcid: '' },
    cited_by_count: 12345,
    type: 'preprint',
    abstract_inverted_index: { We: [0], propose: [1], a: [2], new: [3], architecture: [4], the: [5], Transformer: [6] },
    language: 'en',
    open_access: { oa_url: 'https://arxiv.org/pdf/1706.03762' },
  },
  pubmed: {
    uid: '32887788',
    pubdate: '2020 Aug 15',
    source: 'Nature',
    authors: [{ name: 'Smith J' }, { name: 'Doe A' }],
    title: 'A landmark study of something.',
    volume: '584',
    issue: '7820',
    pages: '257-261',
    fulljournalname: 'Nature',
    issn: '0028-0836',
    lang: ['eng'],
    pubtype: ['Journal Article'],
    articleids: [
      { idtype: 'pubmed', value: '32887788' },
      { idtype: 'doi', value: '10.1038/s41586-020-2649-2' },
      { idtype: 'pmc', value: 'PMC7477828' },
      { idtype: 'elocationid', value: 'pii: S0140-6736(20)30154-9' },
    ],
  },
  arxiv: {
    arxivId: '1706.03762',
    baseId: '1706.03762',
    title: 'Attention Is All You Need',
    summary: 'The dominant sequence transduction models are based on complex recurrent networks.',
    authors: ['Ashish Vaswani', 'Noam Shazeer'],
    authorsDetailed: [{ name: 'Ashish Vaswani', affiliations: [] }, { name: 'Noam Shazeer', affiliations: [] }],
    published: '2017-06-12T17:57:34Z',
    publishedDay: '2017-06-12',
    categories: ['cs.CL'],
    primaryCategory: 'cs.CL',
    archive: 'cs',
    doi: '',
    journalRef: 'Advances in Neural Information Processing Systems 30 (NIPS 2017)',
    comment: '15 pages, 5 figures',
    absUrl: 'https://arxiv.org/abs/1706.03762',
    pdfUrl: 'https://arxiv.org/pdf/1706.03762',
    links: {},
  },
};

/* ============================================================
 * A. RefFormat 纯函数
 * ============================================================ */

function testFormat() {
  /* A1 标识符抽取：DOI / 网址 / PMID / arXiv 混在一段中文里 */
  const ids = RF.extractIdentifiers('见 10.1038/s41586-020-2649-2. 也可看 https://pubmed.ncbi.nlm.nih.gov/32887788/ '
    + '以及 arXiv:1706.03762v5，另有 PMC7477828。');
  const kinds = ids.map((x) => x.kind);
  ok(kinds.indexOf('doi') >= 0, 'A1.1 抓到 DOI');
  eq(ids.find((x) => x.kind === 'doi').value, '10.1038/s41586-020-2649-2', 'A1.2 DOI 值正确（句末点已剥离）');
  eq((ids.find((x) => x.kind === 'pmid') || {}).value, '32887788', 'A1.3 从 PubMed 网址抓到 PMID');
  eq((ids.find((x) => x.kind === 'arxiv') || {}).value, '1706.03762', 'A1.4 抓到 arXiv 号（去 v5）');
  eq((ids.find((x) => x.kind === 'pmcid') || {}).value, 'PMC7477828', 'A1.5 抓到 PMCID');
  ok(ids.some((x) => x.kind === 'url'), 'A1.6 保留原始网址');

  /* A2 无标识符 → 逐行当标题 */
  const titles = RF.extractIdentifiers('Attention is all you need\nDeep Residual Learning\n');
  eq(titles.length, 2, 'A2.1 两行 → 两个标题候选');
  eq(titles[0].kind, 'title', 'A2.2 kind=title');

  /* A3 序号/项目符号前缀要剥掉 */
  const stripped = RF.extractIdentifiers('1. BERT: Pre-training of Deep Bidirectional Transformers\n- GPT-3');
  eq(stripped[0].value, 'BERT: Pre-training of Deep Bidirectional Transformers', 'A3.1 剥掉 "1. " 前缀');

  /* A4 BibTeX 识别 */
  ok(RF.looksLikeBibtex('@article{x,\n title={y}\n}'), 'A4.1 识别整段 BibTeX');
  eq(RF.extractIdentifiers('@book{a, title={T}}')[0].kind, 'bibtex', 'A4.2 BibTeX 走单独通道');

  /* A5 归一化 */
  eq(RF.normDOI('https://doi.org/10.1038/Nature12373.'), '10.1038/nature12373', 'A5.1 DOI 归一（去前缀+小写+剥标点）');
  eq(RF.normDOI('doi: 10.1/x'), '10.1/x', 'A5.2 去 doi: 前缀');
  eq(RF.normArxiv('arXiv:2101.00001v2'), '2101.00001', 'A5.3 arXiv 归一');
  eq(RF.normTitle('A {DNA} Study of <i>X</i>'), 'adnastudyofx', 'A5.4 标题归一（去标签与符号）');
  eq(RF.normIsbn('978-0-306-40615-7'), '9780306406157', 'A5.5 ISBN 归一');

  /* A6 标题一致判定与相似度 */
  ok(RF.titleMatch('Attention is All you Need', 'attention is all you need'), 'A6.1 大小写无关');
  ok(!RF.titleMatch('Editorial', 'Editorials'), 'A6.2 过短标题不参与模糊匹配');
  ok(RF.titleMatch('Editorial', 'Editorial'), 'A6.2b 完全相等仍判同一条（长度门槛只作用于模糊路径）');
  ok(RF.titleMatch('Deep Residual Learning for Image Recognition',
    'Deep Residual Learning for Image Recognition (CVPR)'), 'A6.3 副标题截断仍判同一条');
  ok(RF.similarity('abc', 'abc') === 1, 'A6.4 相同串相似度 = 1');
  ok(RF.similarity('attention', 'attension') > 0.85, 'A6.5 单个字母错位仍高相似');

  /* A7 BibTeX 解析：嵌套括号保护 / @string / and 作者 / -- 页码 */
  const bib = '@string{nat = {Nature}}\n'
    + '@article{smith2020,\n'
    + '  author = {Smith, John and Doe, Jane A. and 张 三},\n'
    + '  title = {A {DNA} study of \\& beyond},\n'
    + '  journal = nat,\n'
    + '  volume = {10}, number = {2}, pages = {1--10},\n'
    + '  year = {2020}, doi = {10.1/x}\n'
    + '}';
  const parsed = RF.parseBibtex(bib);
  eq(parsed.length, 1, 'A7.1 解析出一条');
  const p0 = parsed[0];
  eq(p0.title, 'A DNA study of & beyond', 'A7.2 标题还原（保护括号 + \\& 反转义）');
  eq(p0.container, 'Nature', 'A7.3 @string 变量展开');
  eq(p0.pages, '1-10', 'A7.4 -- 页码归一为 -');
  eq(p0.authors.length, 3, 'A7.5 三个作者');
  eq(p0.authors[0].family, 'Smith', 'A7.6 "Family, Given" 切分');
  eq(p0.authors[1].given, 'Jane A.', 'A7.7 名字里的缩写点保留');
  eq(p0.authors[2].literal, '张 三', 'A7.8 中文名退化为 literal（不瞎切）');
  eq(p0.itemType, 'journalArticle', 'A7.9 @article → journalArticle');
  eq(p0.doi, '10.1/x', 'A7.10 DOI 保留');

  /* A8 BibTeX 生成：转义 + 类型映射 + 引文键唯一化 */
  const conf = RF.empty();
  Object.assign(conf, { title: 'Test & Trial', container: 'Proc. of X', authors: [{ family: 'Lee', given: 'K', literal: '' }], year: 2021, pages: '1-9', itemType: 'conferencePaper' });
  const bibOut = RF.toBibtex([conf, Object.assign({}, conf)]);
  has(bibOut, '@inproceedings{', 'A8.1 会议论文 → @inproceedings');
  has(bibOut, '\\&', 'A8.2 & 被转义');
  has(bibOut, 'booktitle = {Proc. of X}', 'A8.3 会议名写入 booktitle');
  ok((bibOut.match(/@inproceedings\{/g) || []).length === 2, 'A8.4 两条都输出');
  const keys = bibOut.match(/@inproceedings\{([^,]+),/g) || [];
  ok(keys.length === 2 && keys[0] !== keys[1], 'A8.5 重复条目引文键自动加后缀', keys);

  /* A9 RIS：页码拆 SP/EP + 类型码 */
  const ris = RF.toRISEntry(p0);
  has(ris, 'TY  - JOUR', 'A9.1 journalArticle → TY JOUR');
  has(ris, 'SP  - 1', 'A9.2 SP 起始页');
  has(ris, 'EP  - 10', 'A9.3 EP 结束页');
  has(ris, 'AU  - Smith, John', 'A9.4 AU 姓名格式 "Family, Given"');
  ok(/\nER  - \n/.test(ris), 'A9.5 以 ER  - 收尾');
  const risConf = RF.toRISEntry(conf);
  has(risConf, 'TY  - CPAPER', 'A9.6 会议论文 → TY CPAPER');

  /* A10 EndNote XML：ref-type 码 + 转义 */
  const xml = RF.toEndNoteXML([p0, conf]);
  has(xml, '<ref-type name="Journal Article">17</ref-type>', 'A10.1 期刊论文 ref-type=17');
  has(xml, '<ref-type name="Conference Paper">10</ref-type>', 'A10.2 会议论文 ref-type=10');
  has(xml, '<secondary-title>Nature</secondary-title>', 'A10.3 期刊名写入 secondary-title');
  has(xml, '<electronic-resource-num>10.1/x</electronic-resource-num>', 'A10.4 DOI 写入 electronic-resource-num');
  has(xml, 'A DNA study of &amp; beyond', 'A10.5 XML 转义');

  /* A11 CSL-JSON */
  const csl = JSON.parse(RF.toCSLAll([p0]))[0];
  eq(csl.type, 'article-journal', 'A11.1 CSL type');
  eq(csl.author[0].family, 'Smith', 'A11.2 CSL 作者');
  eq(csl.issued['date-parts'][0][0], 2020, 'A11.3 CSL issued');

  /* A12 exportAs 分发 */
  eq(RF.exportAs([p0], 'ris').slice(0, 7), 'TY  - J', 'A12.1 ris 分发');
  has(RF.exportAs([p0], 'endnote-xml'), '<xml>', 'A12.2 endnote-xml 分发');
  has(RF.exportAs([p0], 'csl'), 'article-journal', 'A12.3 csl 分发');
  has(RF.exportAs([p0], 'bibtex'), '@article{', 'A12.4 默认 bibtex');

  /* A13 mergeRecords：只填空 + preprint 升级为期刊论文（反向不降级） */
  const a = Object.assign(RF.empty(), { title: 'T', doi: '10.1/a', itemType: 'preprint', volume: '' });
  const b = Object.assign(RF.empty(), { title: 'T2', volume: '9', pages: '1-2', itemType: 'journalArticle', container: 'J' });
  const m = RF.mergeRecords(a, b);
  eq(m.volume, '9', 'A13.1 空缺字段被填');
  eq(m.title, 'T', 'A13.2 已有标题不被覆盖');
  eq(m.itemType, 'journalArticle', 'A13.3 preprint → journalArticle 升级');
  eq(RF.mergeRecords(b, a).itemType, 'journalArticle', 'A13.4 反向不降级');
  ok(m.source.length === 0, 'A13.5 source 保持不变（两条都空）');

  /* A14 dedupeRecords：DOI 命中合并；不同标识符但标题一致也合并 */
  const r1 = Object.assign(RF.empty(), { title: 'Attention is All you Need', doi: '10.1/x', source: ['crossref'] });
  const r2 = Object.assign(RF.empty(), { title: 'Attention is all you need', arxivId: '1706.03762', source: ['arxiv'] });
  const r3 = Object.assign(RF.empty(), { title: 'Something entirely different here', doi: '10.2/y' });
  const dd = RF.dedupeRecords([r1, r2, r3]);
  eq(dd.records.length, 2, 'A14.1 三条 → 两条（标题同者合并）');
  eq(dd.merged, 1, 'A14.2 合并计数');
  ok(dd.records[0].source.indexOf('arxiv') >= 0, 'A14.3 合并后来源合并');
  // ★ 短标题（社论/勘误）不得做标题兜底合并，否则不相干的文献会被并成一条
  const s1 = Object.assign(RF.empty(), { title: 'Editorial' });
  const s2 = Object.assign(RF.empty(), { title: 'Erratum', year: 2021 });
  eq(RF.dedupeRecords([s1, s2]).records.length, 2, 'A14.4 短标题不做标题兜底合并');

  /* A15 gapFields */
  const gappy = Object.assign(RF.empty(), { title: 'X', itemType: 'journalArticle' });
  const gaps = RF.gapFields(gappy);
  ok(gaps.indexOf('volume') >= 0 && gaps.indexOf('pages') >= 0, 'A15.1 期刊论文缺卷页被标记', gaps);
  ok(gaps.indexOf('identifier') >= 0, 'A15.2 无任何强标识符被标记');
  ok(RF.gapFields(r1).indexOf('volume') >= 0, 'A15.3 有 DOI 但缺卷仍标记');
}

/* ============================================================
 * A2. 题录（一行式参考文献串）解析 —— 「所有参考文献都能入库」的核心
 *     夹具全部取自真实接口返回（Crossref reference / Europe PMC / PDF 正文）
 * ============================================================ */

function testBibliography() {
  /* 1) 从整条题录里抠标题（真实样例，逐字钉死） */
  const T = [
    ['Abbott, B. P. et al. Observation of gravitational waves from a binary black hole merger. Phys. Rev. Lett. 116, 061102 (2016).',
      'Observation of gravitational waves from a binary black hole merger'],
    ['Chael, A. et al. High-resolution linear polarimetric imaging for the Event Horizon Telescope. Astrophys. J. 286, 11 (2016).',
      'High-resolution linear polarimetric imaging for the Event Horizon Telescope'],
    ['Dubois, P. F., Hinsen, K. & Hugunin, J. Numerical Python. Comput. Phys. 10, 262–267 (1996).',
      'Numerical Python'],
    ['Harris CR, Millman KJ, van der Walt SJ, et al. Array programming with NumPy. Nature 585, 357-362 (2020).',
      'Array programming with NumPy'],
    ['Pettitt J, Muller B, Stansfield I, Connolly B. Spliced leader trans-splicing in the nematode Trichinella spiralis uses highly polymorphic, noncanonical spliced leaders. RNA 14, 760-770 (2008).',
      'Spliced leader trans-splicing in the nematode Trichinella spiralis uses highly polymorphic, noncanonical spliced leaders'],
    ['张伟, 李娜. 抽动障碍的中医证候分布规律研究. 中医杂志, 2020, 61(3): 12-16.',
      '抽动障碍的中医证候分布规律研究'],
    ['张三, 李四, 王五. 小儿抽动障碍的中医辨治思路探讨. 中国针灸, 2019.',
      '小儿抽动障碍的中医辨治思路探讨'],
  ];
  T.forEach(([inp, want], i) => eq(RF.titleFromUnstructured(inp), want, 'A2.1.' + (i + 1) + ' 题录抠标题：' + want.slice(0, 24)));

  /* 2) 年份：不能被卷页里的数字骗了（"061102 (2016)"） */
  eq(RF.yearFromReference('Abbott, B. P. et al. Observation of gravitational waves. Phys. Rev. Lett. 116, 061102 (2016).'), 2016, 'A2.2 年份取括号里的');
  eq(RF.yearFromReference('Smith J. A study. J Test 12, 345-350, 1999.'), 1999, 'A2.3 无括号时取尾部的 4 位数');
  eq(RF.yearFromReference('Smith J. A study. J Test 12, 061102.'), null, 'A2.4 ★ 卷页数字不被误当成年份');

  /* 3) 作者抽取（真实样例） */
  const A = [
    ['Abbott, B. P. et al. Observation of gravitational waves. Phys. Rev. Lett. 116, 061102 (2016).', ['Abbott|B. P.']],
    ['Pettitt J, Muller B, Stansfield I, Connolly B. Spliced leader trans-splicing in the nematode. RNA 14, 760-770 (2008).',
      ['Pettitt|J', 'Muller|B', 'Stansfield|I', 'Connolly|B']],
    ['Dubois, P. F., Hinsen, K. & Hugunin, J. Numerical Python. Comput. Phys. 10, 262–267 (1996).',
      ['Dubois|P. F.', 'Hinsen|K.', 'Hugunin|J.']],
    ['Beta B, Gamma C. The second paper of note. Science 2, 3-4 (2001).', ['Beta|B', 'Gamma|C']],
    ['张伟, 李娜. 抽动障碍的中医证候分布规律研究. 中医杂志, 2020.', ['张伟', '李娜']],
  ];
  A.forEach(([inp, want], i) => {
    const got = RF.authorsFromReferenceString(inp).map((a) => (a.literal ? a.literal : a.family + '|' + a.given));
    eq(JSON.stringify(got), JSON.stringify(want), 'A2.5.' + (i + 1) + ' 题录抽作者');
  });

  /* 4) 中文作者段不得被当成标题（「张三, 李四, 王五」归一化后 8 字，长度门槛挡不住） */
  ok(RF._looksLikeAuthors('张三, 李四, 王五'), 'A2.6 中文姓名列表判为作者段');
  ok(!RF._looksLikeTitle('张三, 李四, 王五'), 'A2.7 中文姓名列表不判为标题');
  ok(!RF._looksLikeAuthors('小儿抽动障碍的中医辨治思路探讨'), 'A2.8 单个长中文词不是作者段');

  /* 5) 紧凑人名两种顺序都要认对 */
  eq(RF.parseAuthorCompact('Pettitt J').family, 'Pettitt', 'A2.9 姓在前');
  eq(RF.parseAuthorCompact('Pettitt J').given, 'J', 'A2.10 缩写在后');
  eq(RF.parseAuthorCompact('BP Abbott').family, 'Abbott', 'A2.11 缩写在前 → 姓仍是 Abbott');
  eq(RF.parseAuthorCompact('van der Walt SJ').family, 'van der Walt', 'A2.12 复姓（含小写冠词）');
  eq(RF.parseAuthorCompact('张伟').literal, '张伟', 'A2.13 中文名走 literal');
  eq(RF.parseAuthorStringList('Pettitt J, Muller B, Stansfield I').length, 3, 'A2.14 逗号分隔作者串');

  /* 6) 参考文献段切分 */
  const doc = 'Abstract\nxxx\n\nReferences\n'
    + '[1] Alpha A. The first paper of note. Nature 1, 1-2 (2000).\n'
    + '[2] Beta B, Gamma C. The second paper of note. Science 2, 3-4 (2001).\n'
    + '[3] 张伟. 第三篇论文题名初探. 中医杂志, 2002.\n\n'
    + 'Appendix\nzzz';
  const sec = RF.splitBibliography(doc);
  ok(!!sec, 'A2.15 找到参考文献段');
  eq(sec.heading, 'References', 'A2.16 段标题');
  const ents = RF.splitBibliographyEntries(sec.text);
  eq(ents.length, 3, 'A2.17 编号式切出 3 条');
  const recs = RF.recordsFromBibliographyEntries(ents);
  eq(recs.length, 3, 'A2.18 三条都能成为记录');
  eq(recs[1].title, 'The second paper of note', 'A2.19 第二条标题');
  eq(recs[2].year, 2002, 'A2.20 第三条年份');
  ok(recs.every((r) => r.source[0] === 'pdf'), 'A2.21 来源标记为 pdf');
  ok(recs.every((r) => r.confidence === 'low'), 'A2.22 标为低可信（需用户自行确认）');
  ok(!/Appendix/.test(sec.text), 'A2.23 切到 Appendix 之前为止');

  /* 7) 中文参考文献段（无编号、一行一条） */
  const doc2 = '正文……\n\n参考文献\n1. 陈明. 小儿抽动障碍辨治经验. 中医杂志, 2018, 59(4): 300-303.\n2. 刘红. 抽动障碍的中医研究进展. 辽宁中医杂志, 2020, 47(1): 1-4.';
  const r2 = RF.recordsFromBibliographyEntries(RF.splitBibliographyEntries(RF.splitBibliography(doc2).text));
  eq(r2.length, 2, 'A2.24 中文编号式切出 2 条');
  eq(r2[0].title, '小儿抽动障碍辨治经验', 'A2.25 中文标题');
  eq(r2[0].year, 2018, 'A2.26 中文年份');

  /* 8) 有条目带 DOI 时优先用标识符 */
  const withDoi = RF.recordsFromBibliographyEntries([
    'Vaswani A, et al. Attention is all you need. NeurIPS 30, 5998-6008 (2017). doi:10.48550/arXiv.1706.03762',
  ]);
  eq(withDoi.length, 1, 'A2.27 带 DOI 的题录成一条');
  eq(withDoi[0].doi, '10.48550/arxiv.1706.03762', 'A2.28 DOI 被抽出来（优先于标题猜测）');

  /* 9) 既无标识符又抽不出标题 → 丢弃（不制造噪声） */
  eq(RF.recordsFromBibliographyEntries(['12', 'x', '...']).length, 0, 'A2.29 垃圾行被丢弃');

  /* 10) GB/T 7714 中文题录 —— 用户从知网复制「参考文献」列表后的形态。
   *     类型码 [J]/[M]/[D]/[S]/[EB/OL] 必须映射成对的 Zotero 类型，
   *     卷(期):页 与出版社/地点也要提出来（否则入库后还得手工补）。 */
  const GBT = [
    ['[1] 张伟, 李娜. 抽动障碍的中医证候分布规律研究[J]. 中医杂志, 2020, 61(3): 12-16.',
      { t: '抽动障碍的中医证候分布规律研究', it: 'journalArticle', c: '中医杂志', v: '61', i: '3', p: '12-16', y: 2020 }],
    ['[2] 陈明. 小儿抽动障碍辨治经验[J/OL]. 中医杂志, 2018, 59(4): 300-303.',
      { t: '小儿抽动障碍辨治经验', it: 'journalArticle', c: '中医杂志', v: '59', i: '4', p: '300-303', y: 2018 }],
    ['[3] 王五. 中医儿科学[M]. 北京: 人民卫生出版社, 2015: 88-90.',
      { t: '中医儿科学', it: 'book', pb: '人民卫生出版社', pl: '北京', p: '88-90', y: 2015 }],
    ['[4] 李四. 抽动障碍中医证候研究[D]. 北京: 北京中医药大学, 2019.',
      { t: '抽动障碍中医证候研究', it: 'thesis', pb: '北京中医药大学', y: 2019 }],
    ['[5] SMITH J, DOE A. Attention is all you need[J]. Nature, 2017, 550(7676): 354-358.',
      { t: 'Attention is all you need', it: 'journalArticle', c: 'Nature', v: '550', i: '7676', p: '354-358', y: 2017 }],
    ['[6] 国家中医药管理局. 中医儿科临床诊疗指南·儿童多动症(修订)[S]. 2020.',
      { t: '中医儿科临床诊疗指南·儿童多动症(修订)', it: 'report', y: 2020 }],
    ['[7] 抽动障碍的中医研究进展[J]. 辽宁中医杂志, 2020(1): 1-4.',
      { t: '抽动障碍的中医研究进展', it: 'journalArticle', c: '辽宁中医杂志', i: '1', p: '1-4', y: 2020 }],
  ];
  GBT.forEach(([inp, want], i) => {
    const r = RF.parseChineseReference(inp);
    ok(!!r, 'A2.30.' + (i + 1) + ' GB/T 题录可解析');
    if (!r) return;
    const got = { t: r.title, it: r.itemType, c: r.container, v: r.volume, i: r.issue, p: r.pages, y: r.year, pb: r.publisher, pl: r.place };
    const mm = Object.keys(want).filter((k) => String(got[k] || '') !== String(want[k] || ''));
    eq(mm.join(','), '', 'A2.30.' + (i + 1) + ' GB/T 字段：' + want.t.slice(0, 16));
  });
  const g1 = RF.parseChineseReference(GBT[0][0]);
  eq(g1.authors.map((a) => a.literal).join(','), '张伟,李娜', 'A2.31 中文作者段 → literal（不切姓）');
  const g5 = RF.parseChineseReference(GBT[4][0]);
  eq(g5.authors.map((a) => a.family + '|' + a.given).join(','), 'SMITH|J,DOE|A',
    'A2.32 ★ 全大写姓氏（SMITH J, DOE A）不被当成缩写吞掉');
  eq(RF.yearFromReference('SMITH J. Attention[J]. Nature, 2017, 550(7676): 354-358.'), 2017,
    'A2.33 ★ 期号 (7676) 不被当年份');
  eq(RF.parseChineseReference('[8] 刘红. 某穴位刺激治疗研究[EB/OL]. https://example.com/x.html, 2021.').url,
    'https://example.com/x.html', 'A2.34 URL 尾部的逗号/句点被剥掉');
  eq(RF.parseChineseReference('[9] 张伟. 抽动障碍研究[J]. 中医杂志, 2019, 60(2): 100-105. DOI:10.1234/abc.').doi,
    '10.1234/abc', 'A2.35 题录里的 DOI 被抽出来');
  ok(RF.parseChineseReference('这就是一句普通的标题') === null, 'A2.36 非 GB/T 文本不误判');
  // 与通用解析衔接：整段中文参考文献走 recordsFromBibliographyEntries 时自动走 GB/T 分支
  const gbtRecs = RF.recordsFromBibliographyEntries([GBT[0][0], GBT[2][0]]);
  eq(gbtRecs[0].itemType, 'journalArticle', 'A2.37 走 GB/T 分支（类型码生效）');
  eq(gbtRecs[1].itemType, 'book', 'A2.38 书籍类型码生效');
  eq(gbtRecs[1].publisher, '人民卫生出版社', 'A2.39 出版社提出来了');
}

/* A3. 参考文献列表四通道（夹具取自真实接口；网络层用 _getJSON 桩替换） */
async function testRefListChannels() {
  const cridx = {
    message: {
      reference: [
        { key: 'k1', DOI: '10.1103/PhysRevLett.116.061102', 'first-page': '061102', volume: '116', author: 'BP Abbott', year: '2016', 'journal-title': 'Phys. Rev. Lett.', unstructured: 'Abbott, B. P. et al. Observation of gravitational waves from a binary black hole merger. Phys. Rev. Lett. 116, 061102 (2016).' },
        { key: 'k2', unstructured: 'Chael, A. et al. High-resolution linear polarimetric imaging for the Event Horizon Telescope. Astrophys. J. 286, 11 (2016).' },
      ],
    },
  };
  const realGet = RS._getJSON;
  RS._getJSON = async (url) => {
    // ★ 注意返回的是**整个响应体**（含 message 包装），不是 message 本身
    if (url.indexOf('/works/') >= 0 && url.indexOf('10.1038') >= 0 && url.indexOf('/works?') < 0) return cridx;
    if (/\/works\/doi:/.test(url) && /referenced_works/.test(url)) {
      return { id: 'https://openalex.org/W1', referenced_works: ['https://openalex.org/W1969761972', 'https://openalex.org/W1983157164'] };
    }
    if (/filter=openalex_id:/.test(url)) {
      return { results: [FX.openalex, { doi: 'https://doi.org/10.1234/second', title: 'A second referenced work', publication_year: 1999, biblio: { volume: '5', first_page: '10', last_page: '20' }, authorships: [], primary_location: { source: { display_name: 'J. Test' } } }] };
    }
    if (/query=DOI%3A/.test(url)) return { resultList: { result: [{ id: '32887788', source: 'MED', pmid: '32887788', pmcid: 'PMC7477828', doi: '10.1038/s41586-020-2649-2' }] } };
    if (/\/references\?format=json/.test(url)) {
      return { referenceList: { reference: [
        { source: 'MED', id: '18256244', citationType: 'JOURNAL ARTICLE', title: 'Spliced leader trans-splicing in the nematode Trichinella spiralis uses highly polymorphic, noncanonical spliced leaders.', authorString: 'Pettitt J, Muller B, Stansfield I, Connolly B.', journalAbbreviation: 'RNA', issue: '4', pubYear: 2008, volume: '14', pageInfo: '760-770' },
        { source: 'MED', id: '20436464', citationType: 'JOURNAL ARTICLE', title: 'Transcript assembly and quantification by RNA-Seq.', authorString: 'Trapnell C, Williams BA.', journalAbbreviation: 'Nat Biotechnol', issue: '5', pubYear: 2010, volume: '28', pageInfo: '511-515' },
      ] } };
    }
    if (/europepmc.*\/search\?query=Attention/.test(url)) {
      return { resultList: { result: [{ id: '1', source: 'MED', pmid: '1', title: 'Attention is All you Need', authorString: 'Vaswani A, Shazeer N.', journalTitle: 'NeurIPS', pubYear: 2017, journalInfo: { volume: '30' }, pageInfo: '5998-6008' }] } };
    }
    return null;
  };
  try {
    /* B11 Crossref 参考文献题录 */
    const cr = await RS.crossrefReferenceList('10.1038/x');
    eq(cr.length, 2, 'B11.1 Crossref 参考文献两条都保留');
    eq(cr[0].doi, '10.1103/physrevlett.116.061102', 'B11.2 DOI 归一');
    eq(cr[0].title, 'Observation of gravitational waves from a binary black hole merger', 'B11.3 标题从 unstructured 抠出');
    eq(cr[0].volume, '116', 'B11.4 卷（出版社 deposit，最准）');
    eq(cr[0].pages, '061102', 'B11.5 首页');
    eq(cr[0].container, 'Phys. Rev. Lett.', 'B11.6 刊名');
    eq(cr[0].year, 2016, 'B11.7 年份');
    eq(cr[0].authors[0].family, 'Abbott', 'B11.8 作者');
    ok(cr[1].doi === '', 'B11.9 无 DOI 的条目照样保留（不再被丢弃）');

    /* B12 OpenAlex referenced_works → 批量取回 */
    const oa = await RS.openalexReferenceList({ doi: '10.1/x' });
    ok(oa.length >= 2, 'B12.1 OpenAlex 参考文献取回', oa.length);
    eq(oa[0].source[0], 'openalex-ref', 'B12.2 来源标记');
    eq(oa[1].volume, '5', 'B12.3 biblio.volume 解析');

    /* B13 Europe PMC 参考文献（带标题） */
    const ep = await RS.europepmcReferenceList({ doi: '10.1038/s41586-020-2649-2' });
    eq(ep.length, 2, 'B13.1 Europe PMC 两条');
    eq(ep[0].pmid, '18256244', 'B13.2 MEDLINE id → PMID');
    eq(ep[0].authors.length, 4, 'B13.3 authorString 拆出 4 位作者');
    eq(ep[0].container, 'RNA', 'B13.4 刊名缩写');
    eq(ep[0].pages, '760-770', 'B13.5 页码');
    eq(ep[0].year, 2008, 'B13.6 年份');
    eq(ep[0].itemType, 'journalArticle', 'B13.7 citationType → 类型');

    /* B14 Europe PMC 检索（并入联合检索） */
    const eps = await RS.europepmcSearch('Attention is All you Need', 5);
    eq(eps.length, 1, 'B14.1 检索命中');
    eq(eps[0].title, 'Attention is All you Need', 'B14.2 标题');
    eq(eps[0].volume, '30', 'B14.3 journalInfo.volume');

    /* B15 S2 参考文献 + DOI 批量补全 */
    const s2stub = {
      paperById: async (id) => (id === 'DOI:10.1/x' ? { paperId: 'P1', title: 'Src' } : null),
      searchByTitle: async () => [],
      references: async () => [{ citedPaper: { title: 'Ref A', year: 2010, externalIds: { DOI: '10.1/a' }, citationCount: 3 } }],
      batch: async (ids) => ids.map((id) => (/10\.1\/b/.test(id) ? { title: 'Resolved B', year: 2011, authors: [{ name: 'Li Si' }], externalIds: { DOI: '10.1/b' } } : null)),
    };
    const sb = sandbox.S2Client;
    sandbox.S2Client = s2stub;
    try {
      const s2l = await RS.s2ReferenceList({ doi: '10.1/x', title: 'Src' }, 100);
      eq(s2l.length, 1, 'B15.1 S2 参考文献');
      eq(s2l[0].source[0], 's2-ref', 'B15.2 来源标记');
      const batch = await RS.s2BatchByDois(['10.1/b', '10.1/notfound']);
      eq(batch.length, 1, 'B15.3 批量补全只返回命中的');
      eq(batch[0].title, 'Resolved B', 'B15.4 补出标题（否则列表里只有一串 DOI）');
      eq(batch[0].authors[0].family, 'Si', 'B15.5 补出作者');
    } finally { sandbox.S2Client = sb; }
  } finally {
    RS._getJSON = realGet;
  }
}

/* A4. 知网参考文献区块抽取（容错解析；页面结构会变，所以只依赖语义边界） */
function testCNKIExtract() {
  const html = '<html><body><div class="abstract"><h6>摘要</h6>本文研究了……</div>'
    + '<div class="references"><h6>参考文献</h6><ul>'
    + '<li>[1] 张伟, 李娜. 抽动障碍的中医证候分布规律研究[J]. 中医杂志, 2020, 61(3): 12-16.</li>'
    + '<li>[2] 陈明. 小儿抽动障碍辨治经验[J]. 中医杂志, 2018, 59(4): 300-303.</li>'
    + '<li>[3] 王五. 中医儿科学[M]. 北京: 人民卫生出版社, 2015: 88-90.</li>'
    + '</ul></div><div class="cited"><h6>引证文献</h6><ul><li>[4] 不应被当成引文条目</li></ul></div>'
    + '</body></html>';
  const ex = RS.extractReferencesFromCNKIHTML(html);
  ok(!!ex.entries, 'A4.1 抽到参考文献区块');
  eq(ex.entries.length, 3, 'A4.2 切出 3 条（<li> 之间正确断行）');
  has(ex.text, '中医杂志', 'A4.3 内容保留');
  ok(!/引证文献|不应被当成/.test(ex.text), 'A4.4 ★ 在「引证文献」处截断（不把别的区块当参考文献）');
  const recs = RF.recordsFromBibliographyEntries(ex.entries, { source: 'cnki', reason: '知网参考文献' });
  eq(recs.length, 3, 'A4.5 三条都成为记录');
  eq(recs[0].title, '抽动障碍的中医证候分布规律研究', 'A4.6 标题');
  eq(recs[2].itemType, 'book', 'A4.7 类型码 [M] → book');
  ok(recs.every((r) => r.source[0] === 'cnki'), 'A4.8 来源标记 cnki');

  /* 风控 / 登录 / 无区块 必须显式区分（否则用户不知道该去验证） */
  eq(RS.extractReferencesFromCNKIHTML(html.replace('<h6>参考文献</h6>', '<h6>安全验证</h6><p>请完成滑动验证</p>')).reason,
    'need_verify', 'A4.9 只看到验证页 → need_verify');
  eq(RS.extractReferencesFromCNKIHTML('<html><title>中国知网-登录</title><form action="https://login.cnki.net/login/"></form></html>').reason,
    'need_login', 'A4.10 登录页 → need_login');
  eq(RS.extractReferencesFromCNKIHTML('<html><body>只有摘要与关键词，没有任何引文列表</body></html>').reason,
    'no_section', 'A4.11 没有引文区块 → no_section');
  eq(RS.extractReferencesFromCNKIHTML('').reason, 'empty', 'A4.12 空响应 → empty');
  // 无编号、一行一条的知网形态
  const flat = RS.extractReferencesFromCNKIHTML('<div>参考文献</div><div>张伟. 抽动障碍研究[J]. 中医杂志, 2019.</div><div>李娜. 儿童多动症研究[J]. 中医杂志, 2018.</div>');
  eq(flat.entries.length, 2, 'A4.13 无编号（<div> 一行一条）也能切');
}

/* A5. 知网通道的失败原因回报（借 CNFetch 的真接口，用桩替换其检索/取页） */
async function testCNKIChannel() {
  const orig = { cnki: sandbox.CNFetch, get: RS._get };
  const mkCnFetch = (search) => ({
    _seedCNKI: async () => {},
    _searchCNKI: search,
    _isTitleMatch: (a, b) => String(a || '').replace(/\s+/g, '') === String(b || '').replace(/\s+/g, ''),
  });
  try {
    /* 缺接口 */
    sandbox.CNFetch = undefined;
    eq((await RS.cnkiReferenceList({ title: 'T' })).reason, 'no_cnki_api', 'A5.1 没有 CNFetch → no_cnki_api');
    /* 风控 */
    sandbox.CNFetch = mkCnFetch(async () => ({ results: [], captcha: 'https://kns.cnki.net/verify' }));
    eq((await RS.cnkiReferenceList({ title: 'T' })).reason, 'need_verify', 'A5.2 403 滑块 → need_verify');
    /* 软拦 */
    sandbox.CNFetch = mkCnFetch(async () => ({ results: [], maybeBlocked: true }));
    eq((await RS.cnkiReferenceList({ title: 'T' })).reason, 'maybe_blocked', 'A5.3 200 软拦 → maybe_blocked');
    /* 没命中 */
    sandbox.CNFetch = mkCnFetch(async () => ({ results: [{ articleTitle: '别的文章', url: 'https://kns.cnki.net/x' }] }));
    eq((await RS.cnkiReferenceList({ title: 'T' })).reason, 'no_hit', 'A5.4 知网没这篇 → no_hit');
    /* 命中但详情页要登录 */
    sandbox.CNFetch = mkCnFetch(async () => ({ results: [{ articleTitle: 'T', url: 'https://kns.cnki.net/kcms/detail/detail.aspx?filename=A' }] }));
    RS._get = async () => ({ status: 200, text: '<html><title>中国知网-登录</title></html>' });
    eq((await RS.cnkiReferenceList({ title: 'T' })).reason, 'need_login', 'A5.5 详情页要登录 → need_login');
    /* 命中且有参考文献 */
    RS._get = async () => ({ status: 200, text: '<div>参考文献</div><ul><li>[1] 张伟. 抽动障碍研究[J]. 中医杂志, 2019, 60(2): 100-105.</li><li>[2] 李娜. 儿童多动症辨治[J]. 中医杂志, 2018, 59(4): 300-303.</li></ul>' });
    const r = await RS.cnkiReferenceList({ title: 'T', creator: '张伟' });
    eq(r.records.length, 2, 'A5.6 拿到 2 条知网参考文献');
    eq(r.records[0].title, '抽动障碍研究', 'A5.7 标题解析');
    /* 详情页有内容但没有参考文献区块 */
    RS._get = async () => ({ status: 200, text: '<div>摘要</div><p>没有参考文献</p>' });
    eq((await RS.cnkiReferenceList({ title: 'T' })).reason, 'no_section', 'A5.8 没有参考文献区块 → no_section');
  } finally {
    sandbox.CNFetch = orig.cnki;
    RS._get = orig.get;
  }
}

/* ============================================================
 * B. RefSources 解析与联合检索
 * ============================================================ */

async function testSources() {
  /* B1 Crossref */
  const cr = RS.fromCrossref(FX.crossref.message);
  eq(cr.title, 'Attention is All you Need', 'B1.1 标题');
  eq(cr.container, 'Advances in Neural Information Processing Systems', 'B1.2 期刊/会议名');
  eq(cr.volume, '30', 'B1.3 卷');
  eq(cr.issue, '1', 'B1.4 期');
  eq(cr.pages, '5998-6008', 'B1.5 页');
  eq(cr.year, 2017, 'B1.6 年');
  eq(cr.date, '2017-06-12', 'B1.7 完整日期');
  eq(cr.doi, '10.48550/arxiv.1706.03762', 'B1.8 DOI 归一');
  eq(cr.itemType, 'conferencePaper', 'B1.9 proceedings-article → conferencePaper');
  eq(cr.authors.length, 2, 'B1.10 作者');
  eq(cr.authors[0].family, 'Vaswani', 'B1.11 作者姓');
  ok(cr.abstract.indexOf('Transformer') > 0 && cr.abstract.indexOf('<jats:p>') < 0, 'B1.12 摘要剥掉 JATS 标签');
  eq(cr.citationCount, 100000, 'B1.13 被引量');
  ok(cr.source.indexOf('crossref') >= 0, 'B1.14 source 标记');

  /* B2 OpenAlex：倒排摘要还原 + pmid 抽取 */
  const oa = RS.fromOpenAlex(FX.openalex);
  eq(RS.abstractFromInvertedIndex(FX.openalex.abstract_inverted_index),
    'We propose a new architecture the Transformer', 'B2.1 倒排索引还原成正常语序');
  eq(oa.doi, '10.48550/arxiv.1706.03762', 'B2.2 DOI 去 URL 前缀');
  eq(oa.itemType, 'preprint', 'B2.3 type=preprint');
  eq(oa.oaUrl, 'https://arxiv.org/pdf/1706.03762', 'B2.4 开放获取直链');
  const oaPmid = RS.fromOpenAlex({ title: 'X', ids: { pmid: 'https://pubmed.ncbi.nlm.nih.gov/12345678/' } });
  eq(oaPmid.pmid, '12345678', 'B2.5 ids.pmid 是 URL → 取出纯数字');

  /* B3 PubMed */
  const pm = RS.fromPubMedSummary('32887788', FX.pubmed);
  eq(pm.title, 'A landmark study of something', 'B3.1 标题去掉句末点');
  eq(pm.container, 'Nature', 'B3.2 fulljournalname 优先');
  eq(pm.volume, '584', 'B3.3 卷');
  eq(pm.issue, '7820', 'B3.4 期');
  eq(pm.pages, '257-261', 'B3.5 页');
  eq(pm.year, 2020, 'B3.6 从 pubdate 取年');
  eq(pm.doi, '10.1038/s41586-020-2649-2', 'B3.7 从 articleids 取 DOI');
  eq(pm.pmcid, 'PMC7477828', 'B3.8 PMCID');
  eq(pm.itemType, 'journalArticle', 'B3.9 pubtype → journalArticle');
  eq(pm.url, 'https://pubmed.ncbi.nlm.nih.gov/32887788/', 'B3.10 PubMed 链接');
  const pmNoDoi = RS.fromPubMedSummary('1', {
    title: 'T', articleids: [{ idtype: 'elocationid', value: 'pii: S0140-6736(20)30154-9' }],
  });
  eq(pmNoDoi.doi, '', 'B3.11 elocationid 里的 pii 不会被误当 DOI（旧实现会写错 DOI）');
  /* B4 arXiv */
  const ax = RS.fromArxivEntry(FX.arxiv);
  eq(ax.arxivId, '1706.03762', 'B4.1 arXiv 号');
  eq(ax.year, 2017, 'B4.2 年');
  eq(ax.authors.length, 2, 'B4.3 作者');
  eq(ax.itemType, 'journalArticle', 'B4.4 有 journalRef → 升为期刊论文');
  const axPre = RS.fromArxivEntry(Object.assign({}, FX.arxiv, { journalRef: '' }));
  eq(axPre.itemType, 'preprint', 'B4.5 无 journalRef → preprint');

  /* B5 S2 */
  const s2 = RS.fromS2({
    title: 'Attention is All you Need', year: 2017, venue: 'NeurIPS', abstract: 'A',
    externalIds: { DOI: '10.48550/arXiv.1706.03762', ArXiv: '1706.03762' },
    authors: [{ name: 'Ashish Vaswani' }], citationCount: 999, url: 'u',
    journal: { name: 'NeurIPS', volume: '30', pages: '5998-6008' },
  });
  eq(s2.volume, '30', 'B5.1 journal.volume');
  eq(s2.arxivId, '1706.03762', 'B5.2 externalIds.ArXiv');
  eq(s2.citationCount, 999, 'B5.3 被引量');

  /* B6 源类型映射 */
  eq(RF.itemTypeFromSource('crossref', 'journal-article'), 'journalArticle', 'B6.1 journal-article');
  eq(RF.itemTypeFromSource('crossref', 'book-chapter'), 'bookSection', 'B6.2 book-chapter');
  eq(RF.itemTypeFromSource('crossref', 'book'), 'book', 'B6.3 book');
  eq(RF.itemTypeFromSource('crossref', 'posted-content'), 'preprint', 'B6.4 posted-content');
  eq(RF.itemTypeFromSource('crossref', 'dissertation'), 'thesis', 'B6.5 dissertation');
  eq(RF.itemTypeFromSource('openalex', 'report'), 'report', 'B6.6 report');
  eq(RF.itemTypeFromSource('s2', 'Conference'), 'conferencePaper', 'B6.7 S2 Conference');

  /* B7 联合检索：多源一致命中应合并为一条且排在前面 */
  RS.crossrefSearch = async () => [RS.fromCrossref(FX.crossref.message)];
  RS.openalexSearch = async () => [RS.fromOpenAlex(FX.openalex)];
  RS.pubmedSearch = async () => [RS.fromPubMedSummary('32887788', FX.pubmed)];
  RS.arxivSearch = async () => [RS.fromArxivEntry(FX.arxiv)];
  RS.s2Search = async () => [RS.fromS2({ title: 'Attention is All you Need', year: 2017, venue: 'NeurIPS', externalIds: { DOI: '10.48550/arXiv.1706.03762' }, citationCount: 5 })];
  const res = await RS.search('Attention is all you need', { limit: 10 });
  eq(res.results.length, 2, 'B7.1 四源返回两条唯一文献（Transformer + Nature 那条）',
    res.results.map((r) => r.title));
  const top = res.results[0];
  eq(top.title, 'Attention is All you Need', 'B7.2 与查询一致的排第一');
  ok(top.source.length >= 3, 'B7.3 多源命中的记录来源被合并', top.source);
  ok(top.reasons.some((x) => /源一致/.test(x)), 'B7.4 打上「多源一致」理由', top.reasons);
  ok(top.score > res.results[1].score, 'B7.5 多源一致者分数更高');
  ok(res.perSource.crossref === 1 && res.perSource.arxiv === 1, 'B7.6 perSource 统计', res.perSource);

  /* B8 单源失败不影响其它源 */
  RS.openalexSearch = async () => { throw new Error('boom'); };
  const res2 = await RS.search('Attention is all you need', { limit: 5 });
  ok(res2.errors.openalex === 'boom', 'B8.1 失败被记录到 errors');
  ok(res2.results.length >= 1, 'B8.2 其它源结果照常返回');

  /* B9 无强标识符的题录也能参与去重（旧实现会丢弃 —— 这是「功能没法用」的根因） */
  const noId = RS.fromS2({ title: 'On the Electrodynamics of Moving Bodies', year: 1905, venue: 'Annalen der Physik', authors: [{ name: 'Albert Einstein' }] });
  ok(!RF.isBlank(noId), 'B9.1 无 DOI 的记录不算空');
  eq(RF.recKey(noId).slice(0, 2), 't:', 'B9.2 退化为标题键');
  ok(RF.recKey(noId).length > 10, 'B9.3 标题够长才会生成键');

  /* B10 未勾选的来源不得发请求（否则「关掉某源」是假的，还白耗限速额度） */
  const hit = { crossref: 0, openalex: 0, pubmed: 0, arxiv: 0, s2: 0 };
  RS.crossrefSearch = async () => { hit.crossref++; return []; };
  RS.openalexSearch = async () => { hit.openalex++; return []; };
  RS.pubmedSearch = async () => { hit.pubmed++; return []; };
  RS.arxivSearch = async () => { hit.arxiv++; return []; };
  RS.s2Search = async () => { hit.s2++; return []; };
  const only = await RS.search('anything', { sources: ['crossref', 'pubmed'], limit: 3 });
  ok(hit.crossref === 1 && hit.pubmed === 1, 'B10.1 勾选的来源被调用', hit);
  ok(hit.openalex === 0 && hit.arxiv === 0 && hit.s2 === 0, 'B10.2 ★ 未勾选的来源一次请求都没发', hit);
  ok(Object.keys(only.perSource).length === 2, 'B10.3 perSource 只统计勾选的来源', only.perSource);
}

/* ============================================================
 * C. RefImport：条目构建 / AI 纪律 / 判重
 * ============================================================ */

function testImportPure() {
  /* C1 journalArticle 字段白名单 */
  const rec = RS.fromCrossref(FX.crossref.message);
  Object.assign(rec, { itemType: 'journalArticle', container: 'Nature', volume: '584', issue: '2', pages: '257-261', issn: '0028-0836', doi: '10.1038/x', pmid: '32887788', arxivId: '1706.03762', ai: true });
  const spec = RI.buildItem(rec);
  eq(spec.itemType, 'journalArticle', 'C1.1 类型');
  eq(spec.fields.publicationTitle, 'Nature', 'C1.2 publicationTitle');
  eq(spec.fields.volume, '584', 'C1.3 volume');
  eq(spec.fields.issue, '2', 'C1.4 issue');
  eq(spec.fields.pages, '257-261', 'C1.5 pages');
  eq(spec.fields.ISSN, '0028-0836', 'C1.6 ISSN');
  eq(spec.fields.DOI, '10.1038/x', 'C1.7 DOI');
  ok(spec.fields.publicationTitle !== undefined && spec.fields.proceedingsTitle === undefined,
    'C1.8 ★ 期刊论文不带 proceedingsTitle（旧实现不分类型乱写字段）');
  has(spec.extra, 'PMID: 32887788', 'C1.9 PMID 写入 extra');
  has(spec.extra, 'arXiv: 1706.03762', 'C1.10 arXiv 写入 extra');
  has(spec.extra, 'AI', 'C1.11 AI 参与时 extra 里留痕提醒核实');

  /* C2 conferencePaper 用 proceedingsTitle，且不重复写 conferenceName */
  const conf = Object.assign({}, rec, { itemType: 'conferencePaper', container: 'Proc. NeurIPS' });
  const specC = RI.buildItem(conf);
  eq(specC.fields.proceedingsTitle, 'Proc. NeurIPS', 'C2.1 proceedingsTitle');
  eq(specC.fields.conferenceName, undefined, 'C2.2 conferenceName 与 proceedingsTitle 同值时不重复写');
  eq(specC.fields.publicationTitle, undefined, 'C2.3 会议论文不写 publicationTitle');

  /* C3 book / thesis / report / webpage 各用各自的字段 */
  const book = RI.buildItem(Object.assign(RF.empty(), { itemType: 'book', title: 'B', publisher: 'OUP', place: 'Oxford', isbn: '9780306406157', year: 1999 }));
  eq(book.fields.publisher, 'OUP', 'C3.1 book.publisher');
  eq(book.fields.ISBN, '9780306406157', 'C3.2 book.ISBN');
  const th = RI.buildItem(Object.assign(RF.empty(), { itemType: 'thesis', title: 'T', publisher: 'MIT', year: 2010 }));
  eq(th.fields.university, 'MIT', 'C3.3 thesis.university ← publisher');
  eq(th.fields.publisher, undefined, 'C3.4 thesis 不写 publisher');
  const rep = RI.buildItem(Object.assign(RF.empty(), { itemType: 'report', title: 'R', publisher: 'WHO', issue: 'TR-1' }));
  eq(rep.fields.institution, 'WHO', 'C3.5 report.institution');
  eq(rep.fields.reportNumber, 'TR-1', 'C3.6 report.reportNumber ← issue');
  const pre = RI.buildItem(Object.assign(RF.empty(), { itemType: 'preprint', title: 'P', arxivId: '2101.00001' }));
  eq(pre.fields.repository, 'arXiv', 'C3.7 preprint.repository');
  eq(pre.fields.archiveID, 'arXiv:2101.00001', 'C3.8 preprint.archiveID');
  ok(!/arXiv: 2101/.test(pre.extra), 'C3.9 preprint 类型不再重复写 extra');

  /* C4 作者：中文 literal 不被硬切 */
  const au = RI.buildItem(Object.assign(RF.empty(), {
    title: 'T', authors: [{ family: 'Vaswani', given: 'Ashish', literal: '' }, { family: '', given: '', literal: '张 三' }],
  }));
  eq(au.creators[0].lastName, 'Vaswani', 'C4.1 西文姓');
  eq(au.creators[0].firstName, 'Ashish', 'C4.2 西文名');
  eq(au.creators[1].name, '张 三', 'C4.3 中文名走单字段 name');
  ok(!au.creators[1].lastName, 'C4.4 中文名不猜姓');

  /* C5 AI JSON 解析：围栏 / 前后闲话 / 数组 */
  eq(RI.parseAIJSON('```json\n{"a":1}\n```').a, 1, 'C5.1 去围栏');
  eq(RI.parseAIJSON('好的，结果如下：{"a":2} 以上。').a, 2, 'C5.2 前后有闲话也能抠出 JSON');
  eq(RI.parseAIJSON('[{"a":3}]')[0].a, 3, 'C5.3 顶层数组');
  ok(RI.parseAIJSON('完全不是 JSON') === null, 'C5.4 非 JSON 返回 null');

  /* C6 AI 合并纪律：只填空；编造的 DOI 一律不采纳 */
  const target = Object.assign(RF.empty(), { title: 'Real Title', doi: '10.1/real', year: 2001, container: '' });
  const filled = RI.applyAIFields(target, {
    title: 'AI 编的标题', doi: '10.9999/fake', year: '1999', container: 'Journal of X',
    authors: ['Zhang San', 'Li Si'], pages: '1-2', itemType: 'journalArticle',
  });
  eq(target.title, 'Real Title', 'C6.1 已有标题不被 AI 覆盖');
  eq(target.doi, '10.1/real', 'C6.2 已有 DOI 不被覆盖');
  eq(target.year, 2001, 'C6.3 已有年份不被覆盖');
  eq(target.container, 'Journal of X', 'C6.4 空缺字段被填');
  eq(target.authors.length, 2, 'C6.5 作者被补');
  ok(target.ai === true, 'C6.6 标记 AI 参与');
  ok(filled >= 3, 'C6.7 统计补上的字段数', filled);
  const blankDoi = Object.assign(RF.empty(), { title: 'X' });
  RI.applyAIFields(blankDoi, { doi: 'not-a-doi' });
  eq(blankDoi.doi, '', 'C6.8 ★ 非法 DOI 不写入（宁可缺，不可错）');

  /* C7 判重：多键 + 标题模糊 */
  const idx = {
    dois: new Set(['10.1/real']), pmids: new Set(['32887788']), arxiv: new Set(['2101.00001']),
    isbns: new Set(), titles: new Map([['attentionisallyouneed', { id: 7 }]]), items: [],
  };
  eq(RI.findDuplicate(Object.assign(RF.empty(), { doi: 'https://doi.org/10.1/REAL' }), idx).by, 'doi', 'C7.1 DOI 判重（带前缀+大写）');
  eq(RI.findDuplicate(Object.assign(RF.empty(), { pmid: '32887788' }), idx).by, 'pmid', 'C7.2 PMID 判重');
  eq(RI.findDuplicate(Object.assign(RF.empty(), { arxivId: 'arXiv:2101.00001v3' }), idx).by, 'arxiv', 'C7.3 arXiv 判重');
  eq(RI.findDuplicate(Object.assign(RF.empty(), { title: 'Attention Is All You Need' }), idx).by, 'title', 'C7.4 标题判重');
  eq(RI.findDuplicate(Object.assign(RF.empty(), { title: 'Attention Is All You Needs' }), idx).by, 'title~', 'C7.4b 标题近似（拼写差一个字母）判重');
  eq(RI.findDuplicate(Object.assign(RF.empty(), { title: 'A totally unrelated new paper' }), idx).dup, false, 'C7.5 无关标题不误判');
  eq(RI.findDuplicate(Object.assign(RF.empty(), { title: 'Editorial' }), { dois: new Set(), pmids: new Set(), arxiv: new Set(), isbns: new Set(), titles: new Map(), items: [] }).dup, false, 'C7.6 过短标题不判重');

  /* C8 导出分发 */
  const jrec = Object.assign({}, rec, { itemType: 'journalArticle' });
  has(RI.exportRecords([jrec], 'bibtex'), '@article{', 'C8.1 bibtex');
  has(RI.exportRecords([jrec], 'ris'), 'TY  - ', 'C8.2 ris');

  /* C9 windowApi 暴露给对话框的能力齐备（漏一个就是「点按钮没反应」） */
  const api = RI.windowApi();
  for (const k of ['sources', 'defaultSources', 'parseInput', 'parseBibtex', 'dedupe', 'search',
    'resolve', 'enrich', 'aiComplete', 'aiInvestigate', 'aiStatus', 'markDuplicates',
    'fetchReferences', 'importRecords', 'exportText', 'copyText', 'saveText', 'invalidateLibrary']) {
    ok(typeof api[k] === 'function', 'C9 对话框 API 提供 ' + k);
  }
}

/* C11~C17 多源参考文献合并（「该文献引用的所有参考文献」都进得来） */
async function testReferenceLists() {
  const mk = (title, doi, src) => Object.assign(RF.empty(), { title, doi, source: [src] });
  const orig = {
    s2: RS.s2ReferenceList, cr: RS.crossrefReferenceList, oa: RS.openalexReferenceList,
    ep: RS.europepmcReferenceList, batch: RS.s2BatchByDois, pdf: RI.pdfReferenceList,
  };
  try {
    RS.s2ReferenceList = async () => [mk('Ref A', '10.1/a', 's2-ref'), mk('Ref Shared', '10.1/s', 's2-ref')];
    RS.crossrefReferenceList = async () => [mk('Ref Shared', '10.1/s', 'crossref-ref'), mk('Ref B', '10.1/b', 'crossref-ref')];
    RS.openalexReferenceList = async () => [mk('Ref C', '10.1/c', 'openalex-ref')];
    RS.europepmcReferenceList = async () => { throw new Error('boom'); };
    RS.s2BatchByDois = async () => [];
    RI.pdfReferenceList = async () => ({ records: [mk('Ref D from PDF', '', 'pdf')], reason: '' });

    const item = {
      getField: (f) => ({ title: 'Src Paper', DOI: '10.1/src' }[f] || ''),
      getDisplayTitle: () => 'Src Paper',
    };
    const r = await RI.fetchReferenceLists([item], { channels: ['s2', 'crossref', 'openalex', 'europepmc', 'pdf'] });

    /* C11 多源并集 */
    eq(r.records.length, 5, 'C11.1 四个通道 + PDF 的并集去重后 5 条',
      r.records.map((x) => x.title));
    eq(r.channels.s2, 2, 'C11.2 S2 命中 2');
    eq(r.channels.crossref, 2, 'C11.3 Crossref 命中 2');
    eq(r.channels.openalex, 1, 'C11.4 OpenAlex 命中 1');
    eq(r.channels.pdf, 1, 'C11.5 PDF 段命中 1');
    eq(r.channels.europepmc, 0, 'C11.6 失败的通道计 0（不静默）');
    ok(r.errors.some((e) => e.channel === 'europepmc'), 'C11.7 失败写入 errors');
    ok(r.merged >= 1, 'C11.8 有合并发生');
    const shared = r.records.find((x) => x.doi === '10.1/s');
    ok(shared && shared.source.length === 2, 'C11.9 ★ 两源同一条 → 合并为一条且来源合并', shared && shared.source);
    ok(r.records.some((x) => x.source.indexOf('pdf') >= 0), 'C11.10 PDF 段条目在结果里');
    ok(r.records[0].doi || r.records[0].title, 'C11.11 首条可读');
    eq(r.perItem.length, 1, 'C11.12 perItem 统计');

    /* C12 通道可关（未勾选的不发请求） */
    let s2Called = false, pdfCalled = false;
    RS.s2ReferenceList = async () => { s2Called = true; return []; };
    RI.pdfReferenceList = async () => { pdfCalled = true; return { records: [], reason: 'no_section' }; };
    const r2 = await RI.fetchReferenceLists([item], { channels: ['crossref'] });
    ok(!s2Called, 'C12.1 未勾选的 S2 不发请求');
    ok(!pdfCalled, 'C12.2 未勾选的 PDF 通道不发请求');
    eq(r2.records.length, 2, 'C12.3 只跑 Crossref');

    /* C13 多篇选中：几篇的参考文献一起并进来（旧实现只取第一篇） */
    RS.s2ReferenceList = async (ids) => (ids.title === 'Src Paper' ? [mk('From 1', '10.1/p1', 's2-ref')] : [mk('From 2', '10.1/p2', 's2-ref')]);
    RI.pdfReferenceList = async () => ({ records: [], reason: 'no_section' });
    const item2 = { getField: (f) => ({ title: 'Second Paper', DOI: '10.2/src' }[f] || ''), getDisplayTitle: () => 'Second Paper' };
    const r3 = await RI.fetchReferenceLists([item, item2], { channels: ['s2'] });
    eq(r3.records.length, 2, 'C13.1 两篇的参考文献都被收集');
    eq(r3.perItem.length, 2, 'C13.2 perItem 两篇');

    /* C14 条目标识符抽取（DOI 在 extra/url 里也要认得） */
    const it3 = {
      getField: (f) => ({
        title: 'T', extra: 'PMID: 32887788  PMCID: PMC7477828  arXiv: 1706.03762',
        url: 'https://doi.org/10.1038/s41586-020-2649-2',
      }[f] || ''),
    };
    const ids = RI.itemIdentifiers(it3);
    eq(ids.doi, '10.1038/s41586-020-2649-2', 'C14.1 从 url 抠出 DOI');
    eq(ids.pmid, '32887788', 'C14.2 PMID');
    eq(ids.pmcid, 'PMC7477828', 'C14.3 PMCID');
    eq(ids.arxivId, '1706.03762', 'C14.4 arXiv');

    /* C15 PDF 通道：必须用 noTruncate 读全文（参考文献段在文末，截断就没了） */
    let sawOpts = null;
    const chatStub = {
      getFullText: async (it, o) => { sawOpts = o; return 'Abstract\nzz\n\n参考文献\n1. 陈明. 小儿抽动障碍辨治经验. 中医杂志, 2018, 59(4): 300-303.\n2. 刘红. 抽动障碍的中医研究进展. 辽宁中医杂志, 2020, 47(1): 1-4.'; },
    };
    const oldChat = sandbox.AIChat;
    sandbox.AIChat = chatStub;
    try {
      const pr = await orig.pdf(item);
      eq(pr.records.length, 2, 'C15.1 PDF 参考文献段解析出 2 条');
      eq(pr.records[0].title, '小儿抽动障碍辨治经验', 'C15.2 中文题录标题');
      ok(sawOpts && sawOpts.noTruncate === true, 'C15.3 ★ 读全文时传了 noTruncate（否则文末的参考文献段被截掉）');
      // 没有参考文献段时给出明确原因，而不是静默空结果
      sandbox.AIChat = { getFullText: async () => 'No bibliography here.\nJust body text.' };
      const pr2 = await orig.pdf(item);
      eq(pr2.reason, 'no_section', 'C15.4 无参考文献段时回报原因');
      sandbox.AIChat = { getFullText: async () => null };
      const pr3 = await orig.pdf(item);
      eq(pr3.reason, 'no_text', 'C15.5 无全文时回报原因');
    } finally { sandbox.AIChat = oldChat; }
    /* C16 条目没记 DOI 时，先用标题把它认出来（否则四条通道都没入口） */
    let sawIds = null;
    RS.openalexSearch = async () => [Object.assign(RF.empty(), { title: 'Src Paper', doi: '10.9/found', source: ['openalex'] })];
    RS.openalexReferenceList = async (ids) => { sawIds = ids; return [mk('Found Ref', '10.1/z', 'openalex-ref')]; };
    const noDoiItem = { getField: (f) => ({ title: 'Src Paper' }[f] || ''), getDisplayTitle: () => 'Src Paper' };
    const r4 = await RI.fetchReferenceLists([noDoiItem], { channels: ['openalex'], resolveByTitle: true });
    eq(r4.records.length, 1, 'C16.1 按标题定位后拿到参考文献');
    ok(sawIds && sawIds.doi === '10.9/found', 'C16.2 ★ 定位到的 DOI 被传下去（否则通道根本没入口）', sawIds);
    ok(r4.matchedByTitle === true, 'C16.3 回报「已按标题定位」');

    /* C17 抓不到时给出可执行诊断（而不是让用户对着空列表猜） */
    RS.openalexSearch = async () => [];          // 标题也匹配不上
    RS.openalexReferenceList = async () => [];   // 通道返回空
    RI.pdfReferenceList = async () => ({ records: [], reason: 'no_text' });
    const d1 = await RI.fetchReferenceLists([noDoiItem], { channels: ['openalex', 'pdf'] });
    eq(d1.diagnosis, 'no_identifier', 'C17.1 无标识符 → no_identifier');
    const doiItem = { getField: (f) => ({ title: 'T', DOI: '10.1/src' }[f] || ''), getDisplayTitle: () => 'T' };
    RS.crossrefReferenceList = async () => [];
    const d2 = await RI.fetchReferenceLists([doiItem], { channels: ['crossref', 'pdf'] });
    eq(d2.diagnosis, 'scanned_pdf', 'C17.2 有标识符 + PDF 无文本层 → scanned_pdf');
    RI.pdfReferenceList = async () => ({ records: [], reason: 'no_section' });
    const d3 = await RI.fetchReferenceLists([doiItem], { channels: ['crossref', 'pdf'] });
    eq(d3.diagnosis, 'no_bib_section', 'C17.3 PDF 有文本但无参考文献段 → no_bib_section');
    RI.pdfReferenceList = async () => ({ records: [], reason: '' });
    const d4 = await RI.fetchReferenceLists([doiItem], { channels: ['crossref', 'pdf'] });
    eq(d4.diagnosis, 'not_indexed', 'C17.4 库确实没收录 → not_indexed');
    const d5 = await RI.fetchReferenceLists([doiItem], { channels: ['crossref'] });
    eq(d5.diagnosis, 'not_indexed', 'C17.5 未开 PDF 通道时也能给出诊断');

    /* C18 勾了知网却被风控 → 诊断必须指路（去「知网验证」过滑块），
     *    而不是笼统说「没收录」——那会让用户以为这条路走不通。 */
    const oldCnFetch2 = sandbox.CNFetch;
    sandbox.CNFetch = { _seedCNKI: async () => {}, _searchCNKI: async () => ({ results: [], captcha: 'u' }), _isTitleMatch: () => true };
    try {
      const d6 = await RI.fetchReferenceLists([doiItem], { channels: ['crossref', 'cnki'] });
      eq(d6.diagnosis, 'cnki_verify', 'C18.1 知网风控 → cnki_verify');
      sandbox.CNFetch = { _seedCNKI: async () => {}, _searchCNKI: async () => ({ results: [{ articleTitle: '别的' }] }), _isTitleMatch: () => false };
      const d7 = await RI.fetchReferenceLists([doiItem], { channels: ['crossref', 'cnki'] });
      eq(d7.diagnosis, 'cnki_no_hit', 'C18.2 知网没这篇 → cnki_no_hit');
    } finally { sandbox.CNFetch = oldCnFetch2; }
  } finally {
    RS.s2ReferenceList = orig.s2; RS.crossrefReferenceList = orig.cr;
    RS.openalexReferenceList = orig.oa; RS.europepmcReferenceList = orig.ep;
    RS.s2BatchByDois = orig.batch; RI.pdfReferenceList = orig.pdf;
  }
}

/* C10~C12 内置解析器通道的兜底（需要 async，单列一个函数） */
async function testTranslatorFallback() {
  // 沙箱里的 Zotero 是深 Proxy：翻译器不会真的产生 itemDone，
  // 所以这条正好验证「0 条落盘 ≠ 成功」这个最危险的静默失败。
  const rec = RS.fromCrossref(FX.crossref.message);
  const tr = await RI._importViaTranslator([rec], 1, null);
  eq(tr, null, 'C10.1 ★ 翻译器没落盘任何条目 → 返回 null（不谎报成功）');

  const res = await RI.importRecords([rec, rec], { viaTranslator: true });
  eq(res.mode, 'direct', 'C10.2 ★ 内置解析器无果时自动回落到直接建条目');
  eq(res.ok, 2, 'C10.3 回落路径把两条都建了');
  eq(res.fail, 0, 'C10.4 无失败项');
}

/* ============================================================
 * D. 对话框渲染（迷你 DOM）
 * ============================================================ */

class El {
  constructor(tag) {
    this.tag = tag; this.children = []; this._attrs = {};
    this.className = ''; this._text = ''; this.value = ''; this.checked = false;
    this.disabled = false; this.id = ''; this.type = ''; this.parentNode = null; this.handlers = {};
  }
  setAttribute(k, v) {
    if (k === 'class') this.className = String(v);
    else if (k === 'id') this.id = String(v);
    else this._attrs[k] = String(v);
  }
  getAttribute(k) {
    if (k === 'class') return this.className;
    if (k === 'id') return this.id;
    return k in this._attrs ? this._attrs[k] : null;
  }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { this.parentNode = null; this.children = this.children.filter((x) => x !== c); return c; }
  addEventListener(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
  removeEventListener(ev, fn) { this.handlers[ev] = (this.handlers[ev] || []).filter((f) => f !== fn); }
  async fire(ev, arg) { for (const f of (this.handlers[ev] || []).slice()) await f(arg || {}); }
  click() { return this.fire('click'); }
  focus() {}
  getElementsByTagName(tag) { return this.all().filter((n) => n.tag === tag); }
  set textContent(v) { this._text = v == null ? '' : String(v); this.children = []; }
  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join('');
    return this._text;
  }
  get childNodes() { return this.children; }
  get firstChild() { return this.children.length ? this.children[0] : null; }
  all() { return this.children.reduce((acc, c) => acc.concat([c], c.all()), []); }
}

function makeDom(xhtml) {
  const ids = new Set();
  const re = /id="([A-Za-z0-9_-]+)"/g;
  let m;
  while ((m = re.exec(xhtml))) ids.add(m[1]);
  const registry = new Map();
  const documentElement = new El('window');
  for (const id of ids) {
    const el = new El('div');
    el.setAttribute('id', id);
    el.parentNode = documentElement;
    documentElement.children.push(el);
    registry.set(id, el);
  }
  // 把标记里的 checked/value 属性同步到元素属性上——真实 DOM 里 `checked="checked"`
  // 就是「默认勾选」，harness 不模拟这一层的话，默认勾选行为会被测成「没勾」。
  const tagRe = /<(?:html:)?([a-zA-Z]+)\b([^>]*)>/g;
  let t;
  while ((t = tagRe.exec(xhtml))) {
    const attrs = t[2];
    const idm = /id="([A-Za-z0-9_-]+)"/.exec(attrs);
    if (!idm) continue;
    const el = registry.get(idm[1]);
    if (!el) continue;
    if (/\bchecked="(checked|true)"/.test(attrs)) el.checked = true;
    const valm = /\bvalue="([^"]*)"/.exec(attrs);
    if (valm) el.value = valm[1];
    const typem = /\btype="([^"]*)"/.exec(attrs);
    if (typem) el.type = typem[1];
  }
  return {
    document: {
      readyState: 'complete',
      documentElement,
      getElementById: (id) => registry.get(id) || null,
      createElementNS: (ns, tag) => new El(tag),
      createElement: (tag) => new El(tag),
    },
    registry,
  };
}

function bootDialog(apiOver) {
  const xhtml = fs.readFileSync(path.join(ROOT, 'chrome', 'content', 'ref-import.xhtml'), 'utf8');
  const { document, registry } = makeDom(xhtml);
  const calls = { imported: [], searched: [], saved: null, copied: null };
  const api = Object.assign({
    sources: () => [{ id: 'crossref', label: 'Crossref', hint: 'h' }, { id: 'openalex', label: 'OpenAlex', hint: 'h' },
      { id: 'pubmed', label: 'PubMed', hint: 'h' }, { id: 'europepmc', label: 'Europe PMC', hint: 'h' },
      { id: 'arxiv', label: 'arXiv', hint: 'h' }, { id: 's2', label: 'Semantic Scholar', hint: 'h' },
      { id: 'pdf', label: 'PDF 参考文献段', hint: 'h' },
      { id: 'cnki', label: '知网 CNKI', hint: 'h' }],
    defaultSources: () => ['crossref', 'openalex', 'pubmed', 'europepmc', 'arxiv', 's2', 'pdf'],
    isZh: () => true,
    parseInput: () => [{ kind: 'doi', value: '10.1/x' }],
    parseBibtex: () => [],
    dedupe: (recs) => ({ records: recs, merged: 0 }),
    search: async (q, o) => { calls.searched.push(q); return { results: [], perSource: {}, errors: {} }; },
    resolve: async () => null,
    enrich: async (recs) => recs,
    aiComplete: async (recs) => ({ ok: true, filled: 0, records: recs }),
    aiInvestigate: async () => ({ ok: false, reason: 'n/a' }),
    aiStatus: () => 'no_key',
    markDuplicates: async (recs) => recs,
    fetchReferences: async () => ({ paper: { title: 'Src' }, records: [] }),
    importRecords: async (recs, o) => { calls.imported.push({ recs, o }); return { ok: recs.length, fail: 0, items: [], errors: [], collection: null, mode: 'direct' }; },
    exportText: (recs, fmt) => 'EXPORT:' + fmt + ':' + recs.length,
    copyText: async (t) => { calls.copied = t; return true; },
    saveText: async (t, n) => { calls.saved = { t, n }; return '/tmp/' + n; },
    invalidateLibrary: () => { calls.invalidated = (calls.invalidated || 0) + 1; },
  }, apiOver || {});
  const win = {
    arguments: [{ api, payload: { mode: 'search' } }],
    handlers: {},
    addEventListener(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); },
    removeEventListener(ev, fn) { this.handlers[ev] = (this.handlers[ev] || []).filter((f) => f !== fn); },
    focus() {},
    _closed: false,
    close() { this._closed = true; },
  };
  const sb = { console, window: win, document, setTimeout, clearTimeout, Promise, Date, Math, JSON };
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'chrome', 'content', 'ref-import.js'), 'utf8'), sb, { filename: 'ref-import.js' });
  return { win, registry, calls, api };
}

async function testDialog() {
  /* D1 初始化：来源复选框按默认勾选 */
  const app = bootDialog();
  const srcBox = app.registry.get('pp-ri-sources');
  const cbs = srcBox.getElementsByTagName('input');
  eq(cbs.length, 8, 'D1.1 八个来源复选框（含 Europe PMC / PDF 段落 / 知网）');
  eq(cbs.filter((c) => c.checked).length, 7, 'D1.1b ★ 知网默认不勾选（会走风控，需用户显式开）');
  eq(cbs.filter((c) => c.checked).length, 7, 'D1.2 默认勾选 7 个（知网除外）');
  eq(app.registry.get('pp-ri-search').textContent, '联合检索 / 解析', 'D1.3 主按钮文案');

  /* D2 空输入 → 给出提示，不发请求 */
  await app.registry.get('pp-ri-search').click();
  has(app.registry.get('pp-ri-status').textContent, '请先粘贴', 'D2.1 空输入提示');

  /* D3 有输入 → DOI 走精确解析 */
  const recA = Object.assign(RF.empty(), { title: 'Paper A', doi: '10.1/a', source: ['crossref'], year: 2020 });
  const recDup = Object.assign(RF.empty(), { title: 'Paper B', doi: '10.1/b', source: ['s2'], year: 2019 });
  const app2 = bootDialog({
    parseInput: () => [{ kind: 'doi', value: '10.1/a' }],
    resolve: async () => recA,
    markDuplicates: async (recs) => {
      for (const r of recs) r.dup = r.doi === '10.1/b' ? { dup: true, by: 'doi', item: null } : { dup: false, by: '', item: null };
      return recs;
    },
  });
  app2.registry.get('pp-ri-input').value = '10.1/a';
  await app2.registry.get('pp-ri-search').click();
  const rows = app2.registry.get('pp-ri-list').children;
  eq(rows.length, 1, 'D3.1 一条结果渲染一行');
  has(app2.registry.get('pp-ri-count').textContent, '已勾选 1', 'D3.2 计数正确');

  /* D4 已在库的默认不勾选，但仍在列表里；「导入选中」只提交勾中的 */
  const app3 = bootDialog({
    parseInput: () => [{ kind: 'doi', value: '10.1/a' }, { kind: 'doi', value: '10.1/b' }],
    resolve: async (ident) => (ident.value === '10.1/a' ? recA : recDup),
    markDuplicates: async (recs) => {
      for (const r of recs) r.dup = r.doi === '10.1/b' ? { dup: true, by: 'doi', item: null } : { dup: false, by: '', item: null };
      return recs;
    },
    dedupe: (recs) => ({ records: recs, merged: 0 }),
  });
  app3.registry.get('pp-ri-input').value = 'x';
  // 「排除库中已有」默认勾选 → 重复条目在检索阶段就被滤掉
  await app3.registry.get('pp-ri-search').click();
  eq(app3.registry.get('pp-ri-list').children.length, 1, 'D4.1 勾选「排除库中已有」时重复条目不进列表');
  await app3.registry.get('pp-ri-import').click();
  const imp = app3.calls.imported[app3.calls.imported.length - 1];
  eq(imp.recs.length, 1, 'D4.2 只提交 1 条');
  eq(imp.recs[0].doi, '10.1/a', 'D4.3 提交的是非重复那条');
  eq(app3.registry.get('pp-ri-opt-translator').checked, false, 'D4.4 默认不走内置解析器');
  ok(app3.calls.invalidated >= 1, 'D4.5 入库后作废库内索引缓存');

  /* D5 不排除时：重复条目保留在列表但默认不勾选 */
  const app4 = bootDialog({
    parseInput: () => [{ kind: 'doi', value: '10.1/a' }, { kind: 'doi', value: '10.1/b' }],
    resolve: async (ident) => (ident.value === '10.1/a' ? recA : recDup),
    markDuplicates: async (recs) => {
      for (const r of recs) r.dup = r.doi === '10.1/b' ? { dup: true, by: 'doi', item: null } : { dup: false, by: '', item: null };
      return recs;
    },
  });
  app4.registry.get('pp-ri-opt-exclude').checked = false;
  app4.registry.get('pp-ri-input').value = 'x';
  await app4.registry.get('pp-ri-search').click();
  eq(app4.registry.get('pp-ri-list').children.length, 2, 'D5.1 不排除时两条都进列表');
  has(app4.registry.get('pp-ri-count').textContent, '已勾选 1', 'D5.2 重复条目默认不勾选');
  await app4.registry.get('pp-ri-import').click();
  eq(app4.calls.imported[app4.calls.imported.length - 1].recs.length, 1, 'D5.3 导入仍只提交勾中的一条');

  /* D6 「去掉已在库的」按钮 */
  await app4.registry.get('pp-ri-dropdup').click();
  eq(app4.registry.get('pp-ri-list').children.length, 1, 'D6.1 清掉重复行');

  /* D7 导出：选中项 + 格式 */
  await app4.registry.get('pp-ri-save').click();
  eq(app4.calls.saved.t, 'EXPORT:bibtex:1', 'D7.1 默认导出 BibTeX 且只含勾选条目');
  eq(app4.calls.saved.n, 'references.bib', 'D7.2 文件名后缀与格式匹配');
  app4.registry.get('pp-ri-format').value = 'ris';
  await app4.registry.get('pp-ri-copy').click();
  eq(app4.calls.copied, 'EXPORT:ris:1', 'D7.3 复制跟随格式下拉');

  /* D8 「从当前文献导入参考文献」复用同一列表，并把勾选的来源作为通道传下去 */
  let sawOpts = null;
  const app5 = bootDialog({
    fetchReferences: async (o) => {
      sawOpts = o;
      return { paper: { title: 'Transformer 综述' }, itemCount: 1, records: [recA], channels: { s2: 2, crossref: 57, openalex: 51, europepmc: 3, pdf: 0 }, merged: 4, truncated: 0 };
    },
  });
  await app5.registry.get('pp-ri-refs-btn').click();
  eq(app5.registry.get('pp-ri-list').children.length, 1, 'D8.1 参考文献进入同一列表');
  has(app5.registry.get('pp-ri-sub').textContent, 'Transformer 综述', 'D8.2 显示来源文献标题');
  ok(sawOpts && Array.isArray(sawOpts.channels) && sawOpts.channels.indexOf('europepmc') >= 0
    && sawOpts.channels.indexOf('pdf') >= 0, 'D8.3 ★ 勾选的来源作为通道参数传入（含 PDF 段）', sawOpts && sawOpts.channels);
  has(app5.registry.get('pp-ri-sub').textContent, 'Crossref 57', 'D8.4 来源命中数写进状态行（用户据此判断为什么少了）');
  has(app5.registry.get('pp-ri-sub').textContent, '去重合并 4', 'D8.5 合并数写进状态行');
  eq(app5.registry.get('pp-ri-status').textContent.indexOf('已抓取 1'), 0, 'D8.6 抓取完成提示');

  /* D8b 「全部导入」＝ 一键把不在库里的全勾上并导入 */
  const appAll = bootDialog({
    fetchReferences: async () => ({
      paper: { title: 'S' }, itemCount: 1, records: [recA, recDup],
      channels: { s2: 2 }, merged: 0, truncated: 0,
    }),
    markDuplicates: async (recs) => {
      for (const r of recs) r.dup = r.doi === '10.1/b' ? { dup: true, by: 'doi', item: null } : { dup: false, by: '', item: null };
      return recs;
    },
  });
  appAll.registry.get('pp-ri-opt-exclude').checked = false;   // 保留重复条目在列表里
  await appAll.registry.get('pp-ri-refs-btn').click();
  eq(appAll.registry.get('pp-ri-list').children.length, 2, 'D8b.1 两条都在列表');
  await appAll.registry.get('pp-ri-import-all').click();
  const impAll = appAll.calls.imported[appAll.calls.imported.length - 1];
  eq(impAll.recs.length, 1, 'D8b.2 ★ 全部导入只提交不在库里的那一条');
  eq(impAll.recs[0].doi, '10.1/a', 'D8b.3 提交的是非重复条目');
  eq(appAll.registry.get('pp-ri-import-all').textContent.indexOf('全部导入'), 0, 'D8b.4 按钮文案');
  // 空列表时给提示而不是静默
  const appEmpty = bootDialog();
  await appEmpty.registry.get('pp-ri-import-all').click();
  has(appEmpty.registry.get('pp-ri-status').textContent, '还没有结果', 'D8b.5 无结果时点全部导入给提示');

  /* D9 来源一个都不勾 → 明确拒绝而不是静默失败 */
  const app6 = bootDialog();
  for (const c of app6.registry.get('pp-ri-sources').getElementsByTagName('input')) c.checked = false;
  app6.registry.get('pp-ri-input').value = '10.1/a';
  await app6.registry.get('pp-ri-search').click();
  has(app6.registry.get('pp-ri-status').textContent, '至少勾选一个', 'D9.1 未选来源时的提示');

  /* D10 窗口脚本不得自己发网络/AI 请求（去掉注释后静态判定） */
  const src = fs.readFileSync(path.join(ROOT, 'chrome', 'content', 'ref-import.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  ok(!/Zotero\.HTTP|AIClient\s*\.|\bAIChat\b|fetch\s*\(/.test(src),
    'D10.1 对话框脚本不直连网络/AI（一律经注入的 api）');
}

/* ---------------- 主流程 ---------------- */

(async function main() {
  testFormat();
  testBibliography();
  testCNKIExtract();
  await testCNKIChannel();
  await testRefListChannels();
  await testSources();
  testImportPure();
  await testReferenceLists();
  await testTranslatorFallback();
  await testDialog();
  console.log('参考文献一键入库：通过 ' + pass + ' 项' + (fails.length ? '，失败 ' + fails.length + ' 项' : ''));
  if (fails.length) {
    for (const f of fails) console.log('  ✗ ' + f);
    process.exit(1);
  }
  console.log('全部通过 ✓');
})().catch((e) => {
  console.log('测试异常：' + (e && (e.stack || e.message)));
  process.exit(1);
});
