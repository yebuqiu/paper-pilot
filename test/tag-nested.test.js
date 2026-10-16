#!/usr/bin/env node
/* 嵌套标签视图 · 树构建测试（E3，0.40.0）
 *
 * 为什么要有它：嵌套视图是只读 UI，但「#a/b/c → 树」的解析与计数是全功能的
 * 地基 —— 解析错了，节点归属、条目数（自身 count / 子树 total）全会失真，
 * 而窗口渲染在 Node 里测不到。这里把纯函数层（_splitPath / buildNestedTree）
 * 真跑一遍：
 *   ① 路径切分："/" 层级、全角斜杠、反斜杠、段首尾空白、空段；
 *   ② 树结构：多级嵌套挂到正确父节点，共享前缀合并为一个节点；
 *   ③ 计数：count = 恰好等于该路径的标签自身条目数；total = 子树合计（含自身）；
 *   ④ 排序：子节点按 total 降序，并列按段名字典序；
 *   ⑤ 单段（无层级）标签作为顶层叶子进树；重名标签计数累加；空输入安全。
 *
 * 运行：node test/tag-nested.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FILE = 'chrome/content/scripts/features/tag-curator.js';

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  <- ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

/* 沙箱加载：顶层只定义 var TagCurator，函数体内的 Zotero 等依赖不会被触发 */
const sandbox = { console, Zotero: {}, Services: {}, Prefs: {}, I18n: { isZh: true }, MdLite: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, FILE), 'utf8'), sandbox, { filename: FILE });
const TC = sandbox.TagCurator;

/* ① 路径切分 */
eq(JSON.stringify(TC._splitPath('#a/b/c')), JSON.stringify(['#a', 'b', 'c']), 'split: basic 3-level');
eq(JSON.stringify(TC._splitPath('机器学习／深度学习')), JSON.stringify(['机器学习', '深度学习']),
  'split: full-width slash normalized');
eq(JSON.stringify(TC._splitPath('a\\b')), JSON.stringify(['a', 'b']), 'split: backslash normalized');
eq(JSON.stringify(TC._splitPath(' a / b / c ')), JSON.stringify(['a', 'b', 'c']), 'split: segments trimmed');
eq(JSON.stringify(TC._splitPath('a//b')), JSON.stringify(['a', 'b']), 'split: empty segment dropped');
eq(JSON.stringify(TC._splitPath('flat')), JSON.stringify(['flat']), 'split: single segment');
eq(JSON.stringify(TC._splitPath('')), JSON.stringify([]), 'split: empty -> []');
eq(JSON.stringify(TC._splitPath(null)), JSON.stringify([]), 'split: null -> []');

/* ②③ 树结构与计数 */
{
  const tags = [
    { name: '#方法/深度学习/CNN', count: 5 },
    { name: '#方法/深度学习/RNN', count: 3 },
    { name: '#方法/深度学习', count: 2 },      // 恰好等于中间路径的标签
    { name: '#方法/强化学习', count: 4 },
    { name: '#方法', count: 1 },               // 恰好等于根路径的标签
    { name: '#领域/视觉', count: 6 },
    { name: 'flat-tag', count: 7 },            // 无层级 → 顶层叶子
  ];
  const tree = TC.buildNestedTree(tags);

  eq(tree.length, 3, 'tree: 3 root nodes (#方法 / #领域 / flat-tag)');

  // 排序：#方法 total = 1+2+5+3+4 = 15 应在最前；flat-tag total 7 次席；#领域 6 垫底
  eq(tree[0].name, '#方法', 'sort: root ordered by total desc [0]');
  eq(tree[1].name, 'flat-tag', 'sort: root ordered by total desc [1]');
  eq(tree[2].name, '#领域', 'sort: root ordered by total desc [2]');

  const m = tree[0];
  eq(m.path, '#方法', 'node: root path');
  eq(m.count, 1, 'count: own tag at root path');
  eq(m.total, 15, 'total: subtree sum incl. self');
  eq(m.children.length, 2, 'node: 2 children under #方法');

  // 子节点排序：深度学习 total = 2+5+3 = 10 > 强化学习 4
  eq(m.children[0].name, '深度学习', 'sort: children by total desc');
  eq(m.children[0].count, 2, 'count: own tag at mid path');
  eq(m.children[0].total, 10, 'total: mid subtree');
  eq(m.children[0].path, '#方法/深度学习', 'node: mid path joined with /');
  eq(m.children[0].children.length, 2, 'node: CNN/RNN under 深度学习');
  eq(m.children[1].name, '强化学习', 'sort: smaller subtree second');
  eq(m.children[1].total, 4, 'total: leaf subtree = own count');

  // 叶子：CNN total 5 > RNN 3
  const dl = m.children[0];
  eq(dl.children[0].name, 'CNN', 'sort: leaves by total desc');
  eq(dl.children[0].count, 5, 'count: leaf own count');
  eq(dl.children[0].total, 5, 'total: leaf total = count');
  eq(dl.children[0].children.length, 0, 'node: leaf has no children');
  eq(dl.children[1].name, 'RNN', 'node: second leaf');

  // 顶层叶子：无层级标签
  eq(tree[1].count, 7, 'flat tag: own count');
  eq(tree[1].total, 7, 'flat tag: total = count');
  eq(tree[1].children.length, 0, 'flat tag: leaf');

  // #领域 单支
  eq(tree[2].children[0].path, '#领域/视觉', 'node: single branch path');
  eq(tree[2].total, 6, 'total: single branch');
}

/* ③b 共享前缀只建一个节点（不出现两个「深度学习」） */
{
  const tree = TC.buildNestedTree([
    { name: 'a/b', count: 1 },
    { name: 'a/c', count: 1 },
    { name: 'a/b/d', count: 1 },
  ]);
  eq(tree.length, 1, 'dedupe: single root a');
  eq(tree[0].children.length, 2, 'dedupe: b and c share parent a');
  eq(tree[0].total, 3, 'dedupe: total aggregates all');
  eq(tree[0].children[0].name, 'b', 'dedupe: b (subtree 2) before c (1)');
  eq(tree[0].children[0].total, 2, 'dedupe: b total includes grandchild d');
}

/* ④b 并列按段名字典序 */
{
  const tree = TC.buildNestedTree([
    { name: 'x/beta', count: 2 },
    { name: 'x/alpha', count: 2 },
  ]);
  eq(tree[0].children[0].name, 'alpha', 'sort: tie broken by locale name');
  eq(tree[0].children[1].name, 'beta', 'sort: tie broken by locale name [1]');
}

/* ⑤ 健壮性 */
{
  eq(JSON.stringify(TC.buildNestedTree(null)), JSON.stringify([]), 'robust: null -> []');
  eq(JSON.stringify(TC.buildNestedTree([])), JSON.stringify([]), 'robust: empty -> []');
  const tree = TC.buildNestedTree([{ name: '', count: 3 }, null, { count: 2 }, { name: 'a', count: 0 }]);
  eq(tree.length, 1, 'robust: junk entries skipped');
  eq(tree[0].total, 0, 'robust: zero count preserved');
  // 同名标签重复出现（大小写/空格变体未经归一时也可能同名传入）→ 计数累加
  const t2 = TC.buildNestedTree([{ name: 'a/b', count: 2 }, { name: 'a/b', count: 3 }]);
  eq(t2[0].children[0].count, 5, 'robust: duplicate tag names accumulate');
}

console.log('');
if (fails.length) {
  console.log('FAIL ' + fails.length + ' / ' + (pass + fails.length));
  for (const f of fails) console.log('  x ' + f);
  process.exit(1);
}
console.log('PASS ' + pass + ' assertions  (tag-nested)');
