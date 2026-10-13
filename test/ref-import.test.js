#!/usr/bin/env node
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
    PREFIX: 'extensions.zotero.paperpilot.',
    get(k, d) { return PrefStore.has(k) ? PrefStore.get(k) : d; },
    set(k, v) { PrefStore.set(k, v); },
  };
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
      { id: 'pubmed', label: 'PubMed', hint: 'h' }, { id: 'arxiv', label: 'arXiv', hint: 'h' }, { id: 's2', label: 'Semantic Scholar', hint: 'h' }],
    defaultSources: () => ['crossref', 'openalex', 'pubmed', 'arxiv', 's2'],
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
  eq(cbs.length, 5, 'D1.1 五个来源复选框');
  ok(cbs.every((c) => c.checked), 'D1.2 默认全部勾选');
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

  /* D8 「从当前文献导入参考文献」复用同一列表 */
  const app5 = bootDialog({
    fetchReferences: async () => ({ paper: { title: 'Transformer 综述' }, records: [recA] }),
  });
  await app5.registry.get('pp-ri-refs-btn').click();
  eq(app5.registry.get('pp-ri-list').children.length, 1, 'D8.1 参考文献进入同一列表');
  has(app5.registry.get('pp-ri-sub').textContent, 'Transformer 综述', 'D8.2 显示来源文献标题');

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
  await testSources();
  testImportPure();
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
