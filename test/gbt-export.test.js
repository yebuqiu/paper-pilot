#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* GB/T 7714 参考文献导出（0.61.0）测试
 *
 * 覆盖三层：
 *   A. RefFormat 纯函数：作者规则（≤3 全列 / >3 用「等 / et al.」）、英文姓名写法、
 *      类型标识（J/M/D/C/EB/EB-OL）、期刊/专著/学位/会议/电子资源各体例、
 *      DOI 开关、去重、著者-出版年制排序。
 *   B. CiteExport.recordsFromItems：按 itemType 精确取字段（用错字段名不会报错，
 *      只会静默丢字段——这是入库/导出类功能最常见的坑，必须逐类型断言）。
 *   C. 接线：窗口脚本不直接引用 Zotero（纪律：一切经 api 注入），
 *      菜单注册表含 cite-export 且 labelKey 在 i18n 表里。
 *
 * 无网络、无 Zotero、无真实 DOM。
 * 运行：node test/gbt-export.test.js
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
  return ok(String(hay).indexOf(needle) >= 0, label, { want: needle, got: String(hay).slice(0, 260) });
}

/* ---------------- 沙箱 ---------------- */

const PrefStore = new Map();
const sandbox = {
  console, JSON, Math, Date, Array, Object, String, Number, Set, Map, Promise, RegExp, Error,
  Zotero: {
    logError: () => {},
    getMainWindow: () => ({}),
    Utilities: { Internal: { copyTextToClipboard: () => {} } },
  },
  Services: { prompt: { alert: () => {} } },
  Components: { classes: {} },
  IOUtils: { writeUTF8: async () => {} },
  Prefs: {
    get: (k, d) => (PrefStore.has(k) ? PrefStore.get(k) : d),
    set: (k, v) => PrefStore.set(k, v),
  },
  I18n: { isZh: true, t: (k) => k },
  ItemSel: { regularOnly: (x) => (x || []).filter((i) => i && i.isRegularItem && i.isRegularItem()), alertEmpty: () => {} },
};
vm.createContext(sandbox);
for (const f of ['features/ref-format.js', 'features/cite-export.js']) {
  vm.runInContext(fs.readFileSync(S(f), 'utf8'), sandbox, { filename: f });
}
const RF = sandbox.RefFormat;
const CE = sandbox.CiteExport;

/* ---------------- 夹具 ---------------- */

const mkRec = (o) => Object.assign(RF.empty(), o);

const zhJournal = mkRec({
  title: '抽动障碍的中医证候分布规律研究',
  authors: [
    { family: '张', given: '伟' }, { family: '李', given: '娜' },
    { family: '王', given: '芳' }, { family: '赵', given: '敏' },
  ],
  year: 2020, container: '中医杂志', volume: '61', issue: '3', pages: '12-16',
  doi: '10.1234/ABC', itemType: 'journalArticle',
});

const enJournal = mkRec({
  title: 'Attention is all you need',
  authors: [
    { family: 'Vaswani', given: 'Ashish' }, { family: 'Shazeer', given: 'Noam' },
    { family: 'Parmar', given: 'Niki' }, { family: 'Uszkoreit', given: 'Jakob' },
  ],
  year: 2017, container: 'NeurIPS', volume: '30', pages: '5998-6008',
  doi: '10.5555/3295222', itemType: 'journalArticle',
});

const book = mkRec({
  title: '中医儿科学', authors: [{ family: '王', given: '五' }], year: 2015,
  place: '北京', publisher: '人民卫生出版社', pages: '88-90', itemType: 'book',
});

const thesis = mkRec({
  title: '抽动障碍中医证候研究', authors: [{ family: '李', given: '四' }], year: 2019,
  place: '北京', publisher: '北京中医药大学', itemType: 'thesis',
});

const conf = mkRec({
  title: 'A study of X', authors: [{ family: 'Chen', given: 'Ming' }], year: 2021,
  container: 'Proceedings of ABC', place: 'New York', publisher: 'ACM', pages: '1-9',
  itemType: 'conferencePaper',
});

const web = mkRec({
  title: 'WHO fact sheet', authors: [{ literal: 'World Health Organization' }], year: 2023,
  url: 'https://www.who.int/x', itemType: 'webpage',
});

/* ---------------- A. 作者规则 ---------------- */

{
  eq(RF.gbtInitials('John Robert'), 'J R', '首字母不带点、多名以空格分隔');
  eq(RF.gbtInitials('Jean-Paul'), 'J P', '连字符名拆成两个首字母');
  eq(RF.gbtAuthorName({ family: '张', given: '伟' }), '张伟', '中文姓名直接拼接');
  eq(RF.gbtAuthorName({ family: 'Smith', given: 'John' }), 'SMITH J', '英文姓全大写 + 名首字母');
  eq(RF.gbtAuthorName({ literal: 'World Health Organization' }), 'World Health Organization', '集体作者按原文');

  has(RF.gbtAuthors(zhJournal, { maxAuthors: 3 }), '张伟, 李娜, 王芳, 等', '中文 >3 位用「等」');
  has(RF.gbtAuthors(enJournal, { maxAuthors: 3 }), 'VASWANI A, SHAZEER N, PARMAR N, et al.', '英文 >3 位用 et al.');
  eq(RF.gbtAuthors(mkRec({ title: 'x', authors: [{ family: '张', given: '伟' }] }), { maxAuthors: 3 }), '张伟', '仅 1 位不加省略语');
  eq(RF.gbtAuthors(mkRec({ title: 'x' }), { maxAuthors: 3 }), '', '无作者返回空串');
}

/* ---------------- A. 类型标识 ---------------- */

{
  eq(RF.gbtTypeCodeOf(zhJournal), 'J', '期刊 → [J]（无 URL 不带 /OL）');
  eq(RF.gbtTypeCodeOf(mkRec({ itemType: 'journalArticle', url: 'https://x' })), 'J/OL', '给了 URL 的期刊 → [J/OL]');
  eq(RF.gbtTypeCodeOf(book), 'M', '专著 → [M]');
  eq(RF.gbtTypeCodeOf(thesis), 'D', '学位论文 → [D]');
  eq(RF.gbtTypeCodeOf(conf), 'C', '会议论文 → [C]');
  eq(RF.gbtTypeCodeOf(web), 'EB/OL', '网页 → [EB/OL]');
}

/* ---------------- A. 各体例 ---------------- */

{
  const j = RF.gbtEntry(zhJournal, { maxAuthors: 3 });
  has(j, '张伟, 李娜, 王芳, 等. 抽动障碍的中医证候分布规律研究[J]. 中医杂志, 2020, 61(3): 12-16.', '中文期刊体例');
  has(j, 'DOI: 10.1234/abc.', 'DOI 归一为小写并附在末尾');
  ok(!/\.\./.test(j), '不出现双句点', j);

  const e = RF.gbtEntry(enJournal, { maxAuthors: 3 });
  has(e, 'VASWANI A, SHAZEER N, PARMAR N, et al. Attention is all you need[J]. NeurIPS, 2017, 30: 5998-6008.', '英文期刊体例与 et al. 句点正确');
  ok(!/et al\.\./.test(e), 'et al. 后不叠句点', e);

  has(RF.gbtEntry(book, {}), '王五. 中医儿科学[M]. 北京: 人民卫生出版社, 2015: 88-90.', '专著体例（出版地: 出版者, 年: 页码）');
  has(RF.gbtEntry(thesis, {}), '李四. 抽动障碍中医证候研究[D]. 北京: 北京中医药大学, 2019.', '学位论文体例');
  has(RF.gbtEntry(conf, {}), 'CHEN M. A study of X[C]//Proceedings of ABC. New York: ACM, 2021: 1-9.', '会议论文用 // 引出论文集');

  const w = RF.gbtEntry(web, { accessDate: '2026-10-19' });
  has(w, 'World Health Organization. WHO fact sheet[EB/OL]. [引用日期 2026-10-19]. https://www.who.int/x.', '电子资源带引用日期与 URL');

  // 类型标识可关
  const noCode = RF.gbtEntry(zhJournal, { typeCode: false, maxAuthors: 3 });
  has(noCode, '抽动障碍的中医证候分布规律研究. 中医杂志', '关闭类型标识后题名直接接出处');
  ok(noCode.indexOf('[J]') < 0, '关闭后不出现 [J]');

  // DOI 可关
  const noDoi = RF.gbtEntry(zhJournal, { doi: false, maxAuthors: 3 });
  ok(noDoi.indexOf('DOI:') < 0, '关闭 DOI 后不输出 DOI');
}

/* ---------------- A. 缺字段不产生脏标点 ---------------- */

{
  const bare = RF.gbtEntry(mkRec({ title: '无出处题名', itemType: 'journalArticle' }), {});
  eq(bare, '无出处题名[J].', '无作者/年/刊名时不留多余标点');

  const noPages = RF.gbtEntry(mkRec({
    title: 'T', authors: [{ family: '张', given: '伟' }], year: 2022, container: '刊', volume: '5', itemType: 'journalArticle',
  }), {});
  has(noPages, '刊, 2022, 5.', '无期号/页码时收尾正常');
}

/* ---------------- A. 列表：编号 / 著者-出版年 / 去重 ---------------- */

{
  const list = RF.toGBT([zhJournal, enJournal], { maxAuthors: 3 });
  const lines = list.split('\n');
  eq(lines.length, 2, '两条记录两行');
  ok(lines[0].startsWith('[1] '), '顺序编码制从 [1] 开始');
  ok(lines[1].startsWith('[2] '), '第二条编号递增');

  const ad = RF.toGBT([enJournal, zhJournal], { style: 'authorDate', maxAuthors: 3, doi: false });
  const adLines = ad.split('\n');
  ok(adLines.every((l) => !/^\[\d+\]/.test(l)), '著者-出版年制不带序号');
  ok(adLines[0].indexOf('VASWANI') === 0, '著者-出版年制按作者排序（英文在前）', adLines[0].slice(0, 30));

  const dup = RF.toGBT([zhJournal, Object.assign({}, zhJournal, { title: '重复项' })], {});
  eq(dup.split('\n').length, 1, '同 DOI 自动去重');

  const keepDup = RF.toGBT([zhJournal, zhJournal], { dedupe: false });
  eq(keepDup.split('\n').length, 2, 'dedupe:false 时保留重复');

  eq(RF.toGBT([], {}), '', '空数组返回空串');
  eq(RF.toGBT([RF.empty()], {}), '', '空记录被跳过');
}

/* ---------------- B. 条目字段映射 ---------------- */

function mkItem(type, fields, creators) {
  return {
    itemType: type,
    isRegularItem: () => true,
    getField: (f) => (fields && fields[f]) || '',
    getCreators: () => creators || [],
  };
}

{
  const items = [
    mkItem('journalArticle', {
      title: 'T1', date: '2021-05-01', publicationTitle: '中华医学杂志', volume: '101',
      issue: '7', pages: '1-9', DOI: '10.1/x', language: 'zh-CN',
    }, [{ firstName: '伟', lastName: '张', fieldMode: 0 }]),
    mkItem('thesis', { title: 'T2', date: '2019', university: '北京大学', place: '北京' }, [{ lastName: '李', firstName: '四' }]),
    mkItem('conferencePaper', { title: 'T3', date: '2021', proceedingsTitle: 'Proc A', publisher: 'ACM', place: 'NY' }, []),
    mkItem('book', { title: 'T4', date: '2015', publisher: '人卫', place: '北京' }, []),
    mkItem('webpage', { title: 'T5', date: '2023', websiteTitle: 'WHO', url: 'https://x' }, [{ lastName: 'WHO', fieldMode: 1 }]),
    { itemType: 'attachment', isRegularItem: () => false, getField: () => '', getCreators: () => [] },
  ];
  const recs = CE.recordsFromItems(items);
  eq(recs.length, 5, '非 regular 条目被跳过');
  eq(recs[0].container, '中华医学杂志', '期刊取 publicationTitle');
  eq(recs[0].year, 2021, '从 date 抽年份');
  eq(recs[0].authors[0].family, '张', '作者姓/名映射');
  eq(recs[1].publisher, '北京大学', '学位论文取 university');
  eq(recs[2].container, 'Proc A', '会议论文取 proceedingsTitle');
  eq(recs[3].publisher, '人卫', '专著取 publisher');
  eq(recs[4].container, 'WHO', '网页取 websiteTitle');
  eq(recs[4].authors[0].literal, 'WHO', 'fieldMode=1 走集体作者');

  const text = CE.render(recs, { maxAuthors: 3, doi: false });
  has(text, '[J]. 中华医学杂志, 2021, 101(7): 1-9.', '映射后渲染出正确期刊体例');
}

/* ---------------- B. 选项持久化 ---------------- */

{
  const o = CE.loadOptions();
  eq(o.style, 'numeric', '默认顺序编码制');
  eq(o.maxAuthors, 3, '默认作者上限 3');
  CE.saveOptions({ style: 'authorDate', typeCode: false, doi: false, maxAuthors: 5 });
  const o2 = CE.loadOptions();
  eq(o2.style, 'authorDate', '选项可持久化');
  eq(o2.typeCode, false, '类型标识开关持久化');
  eq(o2.maxAuthors, 5, '作者上限持久化');
  PrefStore.set('citeExportOpts', '{坏 JSON');
  eq(CE.loadOptions().style, 'numeric', '配置损坏时回落默认而不是抛错');
}

/* ---------------- C. 接线 ---------------- */

{
  const winJs = fs.readFileSync(path.join(ROOT, 'chrome/content/cite-export.js'), 'utf8');
  ok(winJs.indexOf('api.preview') >= 0, '窗口脚本经 api.preview 取数据');
  ok(!/\bZotero\./.test(winJs), '窗口脚本不直接引用 Zotero（纪律）');
  ok(winJs.indexOf('DOMContentLoaded') >= 0, '窗口脚本等 DOMContentLoaded 再绑定（防按钮全死）');

  const xhtml = fs.readFileSync(path.join(ROOT, 'chrome/content/cite-export.xhtml'), 'utf8');
  ok(!/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(xhtml), 'xhtml 无未定义实体（XML 解析硬约束）');
  for (const id of ['ce-out', 'ce-style-numeric', 'ce-typecode', 'ce-doi', 'ce-max', 'ce-copy', 'ce-save']) {
    has(xhtml, 'id="' + id + '"', 'xhtml 含控件 #' + id);
  }

  const menus = fs.readFileSync(S('menus.js'), 'utf8');
  has(menus, 'id: "cite-export"', '菜单注册表含 cite-export');
  const utils = fs.readFileSync(S('core/utils.js'), 'utf8');
  has(utils, 'menuCiteExport', 'i18n 表含 menuCiteExport（否则菜单显示原始 key）');
}

/* ---------------- 汇总 ---------------- */

console.log('\nGB/T 导出测试：' + pass + ' 通过，' + fails.length + ' 失败');
if (fails.length) {
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
