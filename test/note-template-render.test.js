#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 笔记模板渲染（0.61.0）测试
 *
 * 为什么要有它：模板引擎从「六个占位符正则替换」升级为「条件 + 循环 + 十余字段」，
 * 出错的表现不是报错，而是**笔记里留下一堆 {{…}} 或整段该显示的内容消失**——
 * 用户往往写到一半才发现。这里用纯函数把三类边界钉死：
 *   ① 条件块：#if / #else / !取反 / 空字段；
 *   ② 循环：#each tags 与 {{this}}；
 *   ③ 兼容：内置 7 套模板渲染后不得残留任何 {{ 占位符。
 *
 * 无网络、无 Zotero、无 DOM。运行：node test/note-template-render.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const NT_JS = path.join(ROOT, 'chrome', 'content', 'scripts', 'features', 'note-templates.js');

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }
function has(hay, needle, label) { return ok(String(hay).indexOf(needle) >= 0, label, { want: needle, got: String(hay).slice(0, 240) }); }

const Collections = { 11: { name: '待读' }, 12: { name: '方法' } };
const sandbox = {
  console, JSON, Math, Date, Array, Object, String, Number, Set, Map, Promise, RegExp, Error,
  Zotero: { logError: () => {}, Collections: { get: (id) => Collections[id] } },
  Prefs: { get: (k, d) => d, set: () => {} },
  I18n: { isZh: true, t: (k) => k, isZh: true },
  Annotations: {
    collect: () => [{ list: [{ text: '高亮一', page: 3 }, { text: '高亮二', comment: '我的想法' }] }],
  },
  AIChat: { summarize: async () => 'AI 摘要正文' },
  AIClient: { hasKey: () => true },
  Notes: { createFromMarkdown: async () => {} },
  ItemSel: { regularOnly: (x) => x, alertEmpty: () => {} },
  Services: { prompt: { select: () => false, alert: () => {} } },
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(NT_JS, 'utf8'), sandbox, { filename: 'note-templates.js' });
const NT = sandbox.NoteTemplates;

function mkItem(over) {
  const fields = Object.assign({
    title: '抽动障碍研究', date: '2020-06-01', publicationTitle: '中医杂志',
    journalAbbreviation: '中医杂志', volume: '61', issue: '3', pages: '12-16',
    publisher: '人民卫生出版社', place: '北京', DOI: '10.1/abc',
    url: 'https://example.org/x', abstractNote: '摘要正文',
  }, (over && over.fields) || {});
  return {
    key: 'ABCD1234',
    itemType: (over && over.itemType) || 'journalArticle',
    getField: (f) => fields[f] || '',
    getCreators: () => (over && over.creators) || [
      { firstName: 'Wei', lastName: 'Zhang', fieldMode: 0 },
      { firstName: 'Na', lastName: 'Li', fieldMode: 0 },
    ],
    getTags: () => (over && over.tags) || [{ tag: '中医' }, { tag: '抽动障碍' }],
    getCollections: () => (over && over.collections) || [11, 12],
  };
}

/* ---------------- ① 普通占位符 ---------------- */

{
  const ctx = NT.context(mkItem());
  eq(ctx.title, '抽动障碍研究', 'context.title');
  eq(ctx.year, '2020', 'context.year 从 date 截取');
  eq(ctx.journalAbbr, '中医杂志', 'context.journalAbbr');
  eq(ctx.pages, '12-16', 'context.pages');
  eq(ctx.itemKey, 'ABCD1234', 'context.itemKey');
  eq(ctx.itemType, 'journalArticle', 'context.itemType');
  eq(ctx.creators, 'Wei Zhang, Na Li', 'context.creators 保持原有写法（名 姓）');
  eq(ctx.creatorsShort, 'Wei Zhang 等', 'context.creatorsShort 首位 + 等');
  eq(ctx.tags.join(','), '中医,抽动障碍', 'context.tags');
  eq(ctx.collections.join(','), '待读,方法', 'context.collections 解析出分类名');

  const out = NT.renderText('{{title}}（{{year}}）· {{journalAbbr}} {{volume}}({{issue}}): {{pages}}', ctx);
  eq(out, '抽动障碍研究（2020）· 中医杂志 61(3): 12-16', '字段拼接');

  eq(NT.renderText('A{{nope}}B', ctx), 'AB', '未知占位符渲染为空（不再原样留在笔记里）');
  eq(NT.renderText('{{tags}}', ctx), '中医, 抽动障碍', '数组在普通占位符里逗号连接');
}

/* ---------------- ② 条件块 ---------------- */

{
  const ctx = NT.context(mkItem());
  eq(NT.renderText('{{#if doi}}有DOI{{/if}}', ctx), '有DOI', '#if 真值');
  eq(NT.renderText('{{#if doi}}有DOI{{else}}无DOI{{/if}}', ctx), '有DOI', '#if/else 走真分支');
  eq(NT.renderText('{{#if !doi}}无{{else}}有{{/if}}', ctx), '有', '!取反走 else');
  eq(NT.renderText('{{#if url}}[链接]({{url}}){{/if}}', ctx), '[链接](https://example.org/x)', '条件块内仍解析占位符');

  const empty = NT.context(mkItem({ fields: { DOI: '', url: '' } }));
  eq(NT.renderText('{{#if doi}}有{{else}}无{{/if}}', empty), '无', '空字段走 else');
  eq(NT.renderText('{{#if tags}}有标签{{/if}}', NT.context(mkItem({ tags: [] }))), '', '空数组视为假');
  eq(NT.renderText('{{#if !doi}}缺DOI{{/if}}', empty), '缺DOI', '空字段的取反为真');
}

/* ---------------- ③ 循环 ---------------- */

{
  const ctx = NT.context(mkItem());
  eq(NT.renderText('{{#each tags}}- {{this}}\n{{/each}}', ctx), '- 中医\n- 抽动障碍\n', '#each 遍历标签');
  eq(NT.renderText('{{#each nope}}- {{this}}{{/each}}', ctx), '', '#each 对非数组返回空');
  eq(NT.renderText('{{#each collections}}{{this}};{{/each}}', ctx), '待读;方法;', '#each 遍历分类');
  eq(NT.renderText('{{#each tags}}{{#if this}}X{{/if}}{{/each}}', ctx), 'XX', '循环内条件块可嵌套');
}

/* ---------------- ④ render：按需解析批注与 AI 摘要 ---------------- */

(async () => {
  {
    const tpl = { name: 'T', body: '## {{title}}\n\n{{annotations}}' };
    const out = await NT.render(tpl, mkItem());
    has(out, '## 抽动障碍研究', 'render 替换标题');
    has(out, '- 高亮一', 'render 按需解析批注');
    ok(out.indexOf('{{') < 0, 'render 后不残留占位符', out);
  }
  {
    const tpl = { name: 'T', body: '{{#if aiSummary}}{{aiSummary}}{{/if}}' };
    const out = await NT.render(tpl, mkItem(), { aiSummary: async () => '注入的摘要' });
    eq(out, '注入的摘要', 'aiSummary 可由 hooks 注入');
  }
  {
    const tpl = { name: 'T', body: '{{#if annotations}}{{annotations}}{{/if}}' };
    const out = await NT.render(tpl, mkItem());
    has(out, '高亮二', '批注里的 comment 也进入输出');
  }

  /* ---------------- ⑤ 内置模板兼容：不得残留占位符 ---------------- */

  {
    const item = mkItem();
    for (const tpl of NT.builtin) {
      const out = await NT.render(tpl, item);
      ok(out.indexOf('{{') < 0, '内置模板「' + tpl.name + '」渲染后无残留', String(out).slice(0, 120));
      ok(out.trim().length > 0, '内置模板「' + tpl.name + '」非空');
    }
  }

  /* ---------------- ⑥ 边界：单作者 / 无作者 ---------------- */

  {
    const one = NT.context(mkItem({ creators: [{ firstName: 'Wei', lastName: 'Zhang', fieldMode: 0 }] }));
    eq(one.creatorsShort, 'Wei Zhang', '单作者不加「等」');
    const none = NT.context(mkItem({ creators: [] }));
    eq(none.creatorsShort, '', '无作者返回空串');
    eq(none.creators, '', '无作者 creators 为空');
  }

  console.log('\n笔记模板渲染测试：' + pass + ' 通过，' + fails.length + ' 失败');
  if (fails.length) {
    for (const f of fails) console.log('  ✗ ' + f);
    process.exit(1);
  }
})();
