#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 导出到 Obsidian（0.62.0）测试
 *
 * 这类「写文件」功能的失败模式几乎都不可见：文件名带非法字符 → Windows 上写不进去；
 * front-matter 里标题含引号 → YAML 坏掉、Obsidian 打不开；重复导出把旧笔记覆盖 →
 * 用户手写的内容消失。所以这里用内存文件系统把三条都钉死：
 *   ① 文件名清洗（非法字符 / 保留名 / 超长 / 空标题）；
 *   ② front-matter 转义与结构；
 *   ③ 批量导出 + 重名不覆盖（-2 / -3）+ 批注与引用段落。
 *
 * 无网络、无 Zotero、无真实磁盘。运行：node test/obsidian-export.test.js
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
function has(hay, needle, label) { return ok(String(hay).indexOf(needle) >= 0, label, { want: needle, got: String(hay).slice(0, 300) }); }

const FS = new Map();
const PrefStore = new Map();

function mkSandbox() {
  const sb = {
    console, JSON, Math, Date, Array, Object, String, Number, Set, Map, Promise, RegExp, Error,
    Zotero: {
      logError: () => {},
      getMainWindow: () => ({}),
      Collections: { get: (id) => ({ 7: { name: '待读' } }[id]) },
    },
    Services: { prompt: {} },
    Components: { classes: {} },
    PathUtils: { join: (...p) => p.filter(Boolean).join('/').replace(/\/+/g, '/') },
    IOUtils: {
      makeDirectory: async () => {},
      exists: async (p) => FS.has(p),
      writeUTF8: async (p, t) => { FS.set(p, t); },
    },
    Prefs: {
      get: (k, d) => (PrefStore.has(k) ? PrefStore.get(k) : d),
      set: (k, v) => PrefStore.set(k, v),
    },
    I18n: { isZh: true, t: (k) => k },
    Annotations: { collect: () => [{ list: [{ text: '高亮一', page: 3 }, { text: '高亮二', comment: '我的想法' }] }] },
    AIChat: { summarize: async () => 'AI 摘要正文' },
    ItemSel: { regularOnly: (x) => x, alertEmpty: () => {} },
  };
  vm.createContext(sb);
  for (const f of ['features/ref-format.js', 'features/cite-export.js', 'features/obsidian-export.js']) {
    vm.runInContext(fs.readFileSync(S(f), 'utf8'), sb, { filename: f });
  }
  return sb;
}

const sb = mkSandbox();
const OE = sb.ObsidianExport;

function mkItem(over) {
  const o = over || {};
  const fields = Object.assign({
    title: '抽动障碍的中医证候分布规律研究', date: '2020-06-01',
    publicationTitle: '中医杂志', volume: '61', issue: '3', pages: '12-16',
    DOI: '10.1234/abc', abstractNote: '这是摘要。',
  }, o.fields || {});
  return {
    key: o.key || 'ABCD1234',
    itemType: 'journalArticle',
    isRegularItem: () => true,
    getDisplayTitle: () => fields.title,
    getField: (f) => fields[f] || '',
    getCreators: () => o.creators || [{ firstName: 'Wei', lastName: 'Zhang', fieldMode: 0 }],
    getTags: () => o.tags || [{ tag: '中医' }, { tag: '抽动障碍' }],
    getCollections: () => o.collections || [7],
  };
}

/* ---------------- ① 文件名清洗 ---------------- */

{
  eq(OE.sanitizeName('a/b:c*d?e"f<g>h|i'), 'a b c d e f g h i', '非法字符替换为空格');
  eq(OE.sanitizeName('  前后空格  '), '前后空格', '去掉首尾空格');
  eq(OE.sanitizeName('...点...'), '点', '去掉首尾点');
  eq(OE.sanitizeName('', 20), 'untitled', '空名回落 untitled');
  eq(OE.sanitizeName('x'.repeat(120), 40).length, 40, '超长截断到上限');
  eq(OE.sanitizeName('CON'), '_CON', 'Windows 保留名加下划线');
  eq(OE.sanitizeName('LPT1'), '_LPT1', 'LPT 系列也算保留名');

  const rec = { authors: [{ family: 'Zhang', given: 'Wei' }], year: 2020, title: '抽动障碍/研究' };
  eq(OE.buildFileName(rec), 'Zhang2020 抽动障碍 研究.md', '文件名 = 作者+年份+标题');
  eq(OE.buildFileName({ title: 'Only Title' }), 'Only Title.md', '无作者年份时只用标题');
  ok(OE.buildFileName({}).endsWith('.md'), '全空也有 .md 后缀');
}

/* ---------------- ② YAML 与 Markdown ---------------- */

{
  eq(OE.yamlStr('他说"你好"'), '"他说\\"你好\\""', 'YAML 引号转义');
  eq(OE.yamlStr('两行\n内容'), '"两行 内容"', 'YAML 换行压成空格');
  eq(OE.yamlList(['a', '', 'b']), '["a", "b"]', 'YAML 列表过滤空值');

  const payload = {
    rec: {
      title: '含"引号"的标题', authors: [{ family: '张', given: '伟' }], year: 2020,
      container: '中医杂志', doi: '10.1/x', itemType: 'journalArticle', abstract: '摘要正文',
    },
    tags: ['中医'], collections: ['待读'], itemKey: 'ABCD1234', zh: true,
    authorsText: '张伟', annotations: '- 高亮一（p.3）',
    citation: '张伟. 含"引号"的标题[J]. 中医杂志, 2020.',
  };
  const md = OE.buildMarkdown(payload, {});
  ok(md.startsWith('---\n'), '以 front-matter 开头');
  has(md, 'title: "含\\"引号\\"的标题"', '标题在 YAML 中正确转义');
  has(md, 'authors: ["张伟"]', '作者列表');
  has(md, 'tags: ["中医"]', '标签列表');
  has(md, 'zotero: "zotero://select/library/items/ABCD1234"', 'Zotero 反向链接');
  has(md, '# 含"引号"的标题', '正文一级标题');
  has(md, '## 摘要', '摘要段落');
  has(md, '## 批注', '批注段落');
  has(md, '## 引用', '引用段落');
  has(md, '中医杂志, 2020', '国标引用内容');
  ok(md.split('---').length >= 3, 'front-matter 有闭合分隔符');

  const noCite = OE.buildMarkdown(payload, { cite: false });
  ok(noCite.indexOf('## 引用') < 0, 'cite:false 时不写引用段');
}

/* ---------------- ③ 批量导出与重名不覆盖 ---------------- */

(async () => {
  FS.clear();
  const items = [mkItem(), mkItem({ key: 'SECOND01' })];
  const r1 = await OE.exportItems(items, { folder: 'D:/Vault' });
  eq(r1.written, 2, '两篇各写一个文件');
  eq(r1.dir, 'D:/Vault/Papilot', '写入 <vault>/Papilot 子目录');
  ok(FS.has('D:/Vault/Papilot/Zhang2020 抽动障碍的中医证候分布规律研究.md'), '首个文件名符合预期并落盘');

  // 同一批再导一次：不得覆盖
  const r2 = await OE.exportItems(items, { folder: 'D:/Vault' });
  eq(r2.written, 2, '重复导出仍写成功');
  ok(FS.has('D:/Vault/Papilot/Zhang2020 抽动障碍的中医证候分布规律研究-2.md'), '重名自动加 -2 而不是覆盖');
  ok(FS.has('D:/Vault/Papilot/Zhang2020 抽动障碍的中医证候分布规律研究-3.md'), '第三次加 -3');

  const first = FS.get('D:/Vault/Papilot/Zhang2020 抽动障碍的中医证候分布规律研究.md');
  has(first, '高亮二', '批注内容进入文件');
  has(first, '我的想法', '批注评论进入文件');
  ok(first.indexOf('AI 摘要') < 0, '默认不生成 AI 摘要');

  // 带 AI 摘要
  const r3 = await OE.exportItems([mkItem({ key: 'THIRD001' })], { folder: 'D:/Vault', ai: true });
  eq(r3.written, 1, 'AI 模式仍只写一条');
  ok(r3.files.length === 1, '返回实际写入的文件名（供 UI/测试使用）');
  const withAi = FS.get('D:/Vault/Papilot/' + r3.files[0]);
  has(withAi, '## AI 摘要', 'ai:true 时写入 AI 段落');
  has(withAi, 'AI 摘要正文', 'AI 摘要内容来自 summarize');

  // 无目录 → 不写
  const r4 = await OE.exportItems([mkItem()], { folder: '' });
  eq(r4.written, 0, '没有目标目录时不写任何文件');

  /* ---------------- ④ 接线 ---------------- */

  {
    const menus = fs.readFileSync(S('menus.js'), 'utf8');
    has(menus, 'id: "obsidian-export"', '菜单注册表含 obsidian-export');
    const utils = fs.readFileSync(S('core/utils.js'), 'utf8');
    has(utils, 'menuObsidianExport', 'i18n 表含 menuObsidianExport');
    const main = fs.readFileSync(S('main.js'), 'utf8');
    has(main, 'features/obsidian-export.js', 'main.js 加载模块');
    const prefs = fs.readFileSync(path.join(ROOT, 'prefs.js'), 'utf8');
    has(prefs, 'obsidianExportFolder', '偏好键有默认值（否则读写 undefined）');
  }

  console.log('\nObsidian 导出测试：' + pass + ' 通过，' + fails.length + ' 失败');
  if (fails.length) {
    for (const f of fails) console.log('  ✗ ' + f);
    process.exit(1);
  }
})();
