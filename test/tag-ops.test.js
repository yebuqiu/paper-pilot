#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 标签管理 · 数据与规则层测试（TagOps，0.70.0）
 *
 * 为什么要有它：tag-ops.js 的破坏性操作（删除/改名/合并）全部走「先 plan*() 出清单、
 * UI 确认后才 apply*()」的两段式，plan 层因此是整个标签治理的安全闸 —— 规划错了，
 * 用户点一次「执行」就会把几百个标签改烂，而窗口交互在 Node 里测不到。这里把纯函数层
 * 真跑一遍（模块顶层只定义 var TagOps，函数体里才摸 Zotero，所以 vm 沙箱足够）：
 *   ① 归一/比对：norm、shapeKey 的全半角、空白、连字符与标点处理；
 *   ② 层级：splitPath / depth 与 glob 保护名单；
 *   ③ 校验与筛选：isValidName 的四种拒绝分支、matchFilter 的逐条件语义；
 *   ④ 改名引擎：applyRenames 的替换/大小写/截断顺序；
 *   ⑤ 规划器：planRename / planMerge / planAddParent / planReparent / planStripPrefix
 *      的 changes / conflicts / invalid / unchanged 四路分流（unchanged 与 invalid 分开计数）；
 *   ⑥ 分析：stats、cooccurrence、sortBy；
 *   ⑦ 导入导出：toCSV / parseCSV 往返。
 *
 * ★ 纪律：断言照抄「当前实现」的边界，不为了让测试变绿去改 tag-ops.js。
 *   若某处行为可疑，断言处标「★实现疑似有问题」并在末尾汇报里单列。
 *
 * 运行：node test/tag-ops.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FILE = 'chrome/content/scripts/features/tag-ops.js';

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  <- ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

/* 沙箱加载：Zotero.locale 决定 isValidName 的中英文案（zh-CN → 中文） */
const sandbox = { console, Zotero: { locale: 'zh-CN' }, IOUtils: {}, PathUtils: {}, MdLite: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, FILE), 'utf8'), sandbox, { filename: FILE });
const TO = sandbox.TagOps;

/* ==================== ① norm：展示用归一 ==================== */
eq(TO.norm('  Hello   World  '), 'Hello World', 'norm: trim + collapse inner spaces');
eq(TO.norm('a\u3000b'), 'a b', 'norm: full-width space -> space');
eq(TO.norm('ＡＢＣ１２３'), 'ABC123', 'norm: full-width alnum -> half-width');
eq(TO.norm('名称：'), '名称', 'norm: trailing full-width colon stripped');
eq(TO.norm('末尾...'), '末尾', 'norm: trailing dots stripped');
eq(TO.norm('结尾！'), '结尾', 'norm: trailing full-width bang -> half-width then stripped');
eq(TO.norm('a，b'), 'a,b', 'norm: inner full-width comma -> half-width, kept');
eq(TO.norm('  ...  '), '', 'norm: only punctuation/space -> empty');
eq(TO.norm(''), '', 'norm: empty string');
eq(TO.norm(null), '', 'norm: null -> ""');
eq(TO.norm(undefined), '', 'norm: undefined -> ""');
eq(TO.norm('keep.inside.'), 'keep.inside', 'norm: only trailing punct removed');

/* ==================== ② shapeKey：查重/聚类 key ==================== */
eq(TO.shapeKey('Hello World'), 'helloworld', 'shapeKey: space removed');
eq(TO.shapeKey('hello-world'), 'helloworld', 'shapeKey: hyphen removed');
eq(TO.shapeKey('hello_world'), 'helloworld', 'shapeKey: underscore removed');
eq(TO.shapeKey('  Hello   World  '), 'helloworld', 'shapeKey: leading/trailing space removed');
eq(TO.shapeKey('HELLO WORLD'), 'helloworld', 'shapeKey: case folded');
eq(TO.shapeKey('A/B'), 'a/b', 'shapeKey: ascii slash kept as separator');
eq(TO.shapeKey('A／B'), 'a/b', 'shapeKey: full-width slash -> ascii slash');
eq(TO.shapeKey('A\\B'), 'a/b', 'shapeKey: backslash -> ascii slash');
eq(TO.shapeKey('a，b'), 'ab', 'shapeKey: comma removed');
eq(TO.shapeKey('深度学习'), '深度学习', 'shapeKey: CJK untouched');
ok(TO.shapeKey('Hello-World') === TO.shapeKey('hello world') &&
   TO.shapeKey('hello_world') === TO.shapeKey('Hello World'), 'shapeKey: variants converge to one key');

/* ==================== ③ splitPath / depth：层级切分 ==================== */
eq(JSON.stringify(TO.splitPath('#a/b/c')), JSON.stringify(['#a', 'b', 'c']), 'splitPath: 3 levels');
eq(JSON.stringify(TO.splitPath('机器学习／深度学习')), JSON.stringify(['机器学习', '深度学习']),
  'splitPath: full-width slash normalized');
eq(JSON.stringify(TO.splitPath('a\\b')), JSON.stringify(['a', 'b']), 'splitPath: backslash normalized');
eq(JSON.stringify(TO.splitPath('a／b\\c')), JSON.stringify(['a', 'b', 'c']),
  'splitPath: mixed separators, runs collapsed');
eq(JSON.stringify(TO.splitPath(' a / b / c ')), JSON.stringify(['a', 'b', 'c']),
  'splitPath: segments trimmed');
eq(JSON.stringify(TO.splitPath('a//b')), JSON.stringify(['a', 'b']), 'splitPath: empty segment dropped');
eq(JSON.stringify(TO.splitPath('/a/')), JSON.stringify(['a']), 'splitPath: leading/trailing separators dropped');
eq(JSON.stringify(TO.splitPath('flat')), JSON.stringify(['flat']), 'splitPath: single segment');
eq(JSON.stringify(TO.splitPath('')), JSON.stringify([]), 'splitPath: empty -> []');
eq(JSON.stringify(TO.splitPath(null)), JSON.stringify([]), 'splitPath: null -> []');

eq(TO.depth('#a/b/c'), 3, 'depth: 3 segments');
eq(TO.depth('flat'), 1, 'depth: single segment = 1');
eq(TO.depth('a／b'), 2, 'depth: full-width slash counts');
eq(TO.depth(''), 0, 'depth: empty = 0');
eq(TO.depth(null), 0, 'depth: null = 0');

/* ==================== ④ isValidName：写库前校验 ==================== */
eq(TO.isValidName('').ok, false, 'isValidName: empty rejected');
eq(TO.isValidName('').reason, '标签名为空', 'isValidName: empty reason (zh)');
eq(TO.isValidName('   ').ok, false, 'isValidName: whitespace-only rejected');
eq(TO.isValidName(null).ok, false, 'isValidName: null rejected');
eq(TO.isValidName('a'.repeat(255)).ok, true, 'isValidName: exactly MAX_TAG_LEN accepted');
eq(TO.isValidName('a'.repeat(256)).ok, false, 'isValidName: > MAX_TAG_LEN rejected');
eq(TO.isValidName('a'.repeat(256)).reason, '超过 255 字符', 'isValidName: too-long reason (zh)');
eq(TO.isValidName('a\nb').ok, false, 'isValidName: embedded newline rejected');
eq(TO.isValidName('a\nb').reason, '含换行或制表符', 'isValidName: newline reason (zh)');
eq(TO.isValidName('a\tb').ok, false, 'isValidName: embedded tab rejected');
eq(TO.isValidName('a\rb').ok, false, 'isValidName: embedded CR rejected');
eq(TO.isValidName('正常标签').ok, true, 'isValidName: normal name accepted');
eq(TO.isValidName('正常标签').reason, '', 'isValidName: no reason when ok');
eq(TO.isValidName('  #方法/深度学习  ').ok, true, 'isValidName: padded name accepted (trim only checked)');

/* ==================== ⑤ globToRegExp / isProtected ==================== */
{
  const re = TO.globToRegExp('#状态/*');
  ok(!!re, 'globToRegExp: returns RegExp');
  ok(re.test('#状态/待读'), 'globToRegExp: #状态/* hits child');
  ok(!re.test('#状态栏'), 'globToRegExp: #状态/* misses sibling prefix');
  ok(re.test('#状态/a/b'), 'globToRegExp: * spans multi-level');
  ok(!re.test('#状态'), 'globToRegExp: * requires the slash');

  const q = TO.globToRegExp('t?g');
  ok(q.test('tag'), 'globToRegExp: ? matches exactly one char');
  ok(!q.test('tg'), 'globToRegExp: ? does not match zero chars');
  ok(!q.test('taag'), 'globToRegExp: ? does not match two chars');

  ok(TO.globToRegExp('a.b').test('a.b'), 'globToRegExp: dot escaped (literal match)');
  ok(!TO.globToRegExp('a.b').test('axb'), 'globToRegExp: dot not treated as wildcard');
  ok(TO.globToRegExp(null).test(''), 'globToRegExp: null -> /^$/');
  ok(TO.globToRegExp('#ABC/*').test('#abc/x'), 'globToRegExp: case-insensitive');
}
eq(TO.isProtected('#状态/待读'), true, 'isProtected: empty patterns fall back to DEFAULT_PROTECT');
eq(TO.isProtected('#治理/规则'), true, 'isProtected: second default pattern applies');
eq(TO.isProtected('#状态栏'), false, 'isProtected: default pattern does not over-match');
eq(TO.isProtected('#其他', []), false, 'isProtected: unrelated tag unprotected');
eq(TO.isProtected('#状态/待读', []), true, 'isProtected: [] falls back to defaults');
eq(TO.isProtected('#状态/待读', ['#其他/*']), false, 'isProtected: non-empty list disables defaults');
eq(TO.isProtected('#ABC/x', ['#abc/*']), true, 'isProtected: pattern matching is case-insensitive');
eq(TO.isProtected('x/y', ['x/']), true, 'isProtected: trailing-slash prefix protects subtree');
eq(TO.isProtected('xylophone', ['x/']), false, 'isProtected: prefix needs the slash');
// 全是空串的名单仍回退默认保护（0.70.0 修：曾经只看数组长度，`['', ' ']` 会让系统标签失去保护）
eq(TO.isProtected('#状态/x', ['', '  ']), true,
  'isProtected: blank-only list falls back to defaults');

/* ==================== ⑥ matchFilter：逐条件 ==================== */
const F1 = { name: '#方法/深度学习', count: 5, manual: 3, auto: 2, color: '', protected: false };
const F2 = { name: 'Deep-Learning', count: 1, manual: 0, auto: 1, color: '#FF0000', protected: true };
const F3 = { name: 'manual-only', count: 2, manual: 2, auto: 0 };

eq(TO.matchFilter(F1, null), true, 'matchFilter: null filter = all pass');
eq(TO.matchFilter(null, {}), false, 'matchFilter: null tag rejected');
eq(TO.matchFilter({ count: 3 }, {}), false, 'matchFilter: tag without name rejected');

eq(TO.matchFilter(F2, { q: 'deep' }), true, 'matchFilter q: case-insensitive hit');
eq(TO.matchFilter(F2, { q: 'DEEP' }), true, 'matchFilter q: uppercase query hit');
eq(TO.matchFilter(F2, { q: 'zzz' }), false, 'matchFilter q: miss');
eq(TO.matchFilter(F1, { q: '深度' }), true, 'matchFilter q: CJK substring hit');

eq(TO.matchFilter(F1, { min: 5 }), true, 'matchFilter min: boundary inclusive');
eq(TO.matchFilter(F1, { min: 6 }), false, 'matchFilter min: below threshold');
eq(TO.matchFilter(F1, { max: 5 }), true, 'matchFilter max: boundary inclusive');
eq(TO.matchFilter(F1, { max: 4 }), false, 'matchFilter max: above threshold');
eq(TO.matchFilter(F1, { min: 5, max: 5 }), true, 'matchFilter: min+max exact window');

eq(TO.matchFilter(F1, { prefix: '#方法' }), true, 'matchFilter prefix: hit');
eq(TO.matchFilter(F1, { prefix: '方法' }), false, 'matchFilter prefix: anchored at start');
eq(TO.matchFilter(F1, { suffix: '学习' }), true, 'matchFilter suffix: hit');
eq(TO.matchFilter(F1, { suffix: '深度' }), false, 'matchFilter suffix: anchored at end');

eq(TO.matchFilter(F1, { regex: '深度' }), true, 'matchFilter regex: hit');
eq(TO.matchFilter(F1, { regex: '^#方法/.+$' }), true, 'matchFilter regex: anchored pattern');
ok(TO.matchFilter(F2, { regex: '^deep' }), 'matchFilter regex: case-insensitive');
eq(TO.matchFilter(F1, { regex: '(' }), false, 'matchFilter regex: invalid pattern never matches');

eq(TO.matchFilter(F1, { type: 'manual' }), true, 'matchFilter type manual: manual>0');
eq(TO.matchFilter(F2, { type: 'manual' }), false, 'matchFilter type manual: manual=0');
eq(TO.matchFilter(F1, { type: 'auto' }), true, 'matchFilter type auto: auto>0');
eq(TO.matchFilter(F3, { type: 'auto' }), false, 'matchFilter type auto: auto=0');
eq(TO.matchFilter(F3, { type: 'onlyManual' }), true, 'matchFilter onlyManual: auto=0');
eq(TO.matchFilter(F1, { type: 'onlyManual' }), false, 'matchFilter onlyManual: mixed rejected');
eq(TO.matchFilter(F2, { type: 'onlyAuto' }), true, 'matchFilter onlyAuto: manual=0');
eq(TO.matchFilter(F1, { type: 'onlyAuto' }), false, 'matchFilter onlyAuto: mixed rejected');

eq(TO.matchFilter(F1, { depthMin: 2 }), true, 'matchFilter depthMin: boundary inclusive');
eq(TO.matchFilter(F1, { depthMin: 3 }), false, 'matchFilter depthMin: shallower rejected');
eq(TO.matchFilter(F1, { depthMax: 2 }), true, 'matchFilter depthMax: boundary inclusive');
eq(TO.matchFilter(F1, { depthMax: 1 }), false, 'matchFilter depthMax: deeper rejected');

eq(TO.matchFilter(F1, { path: '#方法' }), true, 'matchFilter path: ancestor hits subtree');
eq(TO.matchFilter(F1, { path: '#方法/' }), true, 'matchFilter path: trailing slash tolerated');
eq(TO.matchFilter(F1, { path: '#方法/深度学习' }), true, 'matchFilter path: exact self');
eq(TO.matchFilter(F1, { path: '#方' }), false, 'matchFilter path: partial segment does not hit');
eq(TO.matchFilter({ name: '#方法栏', count: 1 }, { path: '#方法' }), false,
  'matchFilter path: needs segment boundary');
eq(TO.matchFilter(F1, { path: '#方法／深度学习' }), true, 'matchFilter path: full-width slash normalized');

eq(TO.matchFilter(F2, { color: 'colored' }), true, 'matchFilter color: colored');
eq(TO.matchFilter(F1, { color: 'colored' }), false, 'matchFilter color: uncolored is not colored');
eq(TO.matchFilter(F1, { color: 'uncolored' }), true, 'matchFilter color: uncolored');
eq(TO.matchFilter(F2, { color: 'uncolored' }), false, 'matchFilter color: colored is not uncolored');
eq(TO.matchFilter(F2, { color: '#ff0000' }), true, 'matchFilter color: specific value, case-insensitive');
eq(TO.matchFilter(F2, { color: 'blue' }), false, 'matchFilter color: different value');
eq(TO.matchFilter(F1, { color: 'any' }), true, 'matchFilter color: any is a no-op');

eq(TO.matchFilter(F2, { protect: 'protected' }), true, 'matchFilter protect: protected');
eq(TO.matchFilter(F1, { protect: 'protected' }), false, 'matchFilter protect: unprotected rejected');
eq(TO.matchFilter(F1, { protect: 'unprotected' }), true, 'matchFilter protect: unprotected');
eq(TO.matchFilter(F2, { protect: 'unprotected' }), false, 'matchFilter protect: protected rejected');

eq(TO.matchFilter(F1, { q: '#方法', type: 'manual', depthMin: 2, path: '#方法' }), true,
  'matchFilter: conditions are ANDed');
/* 未采集 manual/auto 的标签（两者皆 undefined）**不得**命中 onlyManual/onlyAuto：
 * 否则两个互斥筛选会同时放行同一条目，快照/CSV 导入的旧数据会被误选。
 * （0.70.0 修：原实现用 `tag.auto > 0` 单边判断，undefined 比较两头都 false） */
eq(TO.matchFilter({ name: 'x', count: 1 }, { type: 'onlyManual' }), false,
  'matchFilter onlyManual: unknown type is not selected');
eq(TO.matchFilter({ name: 'x', count: 1 }, { type: 'onlyAuto' }), false,
  'matchFilter onlyAuto: unknown type is not selected');
eq(TO.matchFilter(F3, { type: 'onlyManual' }), true, 'matchFilter onlyManual: manual-only tag selected');
eq(TO.matchFilter(F2, { type: 'onlyManual' }), false, 'matchFilter onlyManual: auto-only tag rejected');
eq(TO.matchFilter(F2, { type: 'onlyAuto' }), true, 'matchFilter onlyAuto: auto-only tag selected');

/* ==================== ⑦ applyRenames：改名引擎 ==================== */
eq(TO.applyRenames('Hello World', { find: 'world', replace: 'Zotero' }), 'Hello Zotero',
  'applyRenames: literal replace is case-insensitive by default');
eq(TO.applyRenames('aXa', { find: 'a', replace: 'b' }), 'bXb', 'applyRenames: literal replaces all occurrences');
eq(TO.applyRenames('Hello world', { find: 'World', replace: 'X', caseSensitive: true }), 'Hello world',
  'applyRenames: caseSensitive misses different case');
eq(TO.applyRenames('a.b.c', { find: '.', replace: '-' }), 'a-b-c',
  'applyRenames: literal mode escapes regex metachars');
eq(TO.applyRenames('tag-001', { find: 'tag-(\\d+)', replace: 'T$1', regex: true }), 'T001',
  'applyRenames: regex mode supports $1');
eq(TO.applyRenames('abc', { find: '(', replace: 'x', regex: true }), 'abc',
  'applyRenames: invalid regex leaves name untouched');
eq(TO.applyRenames('foo', { find: 'foo', replace: 'bar', wholeName: true }), 'bar',
  'applyRenames wholeName: exact hit replaced');
eq(TO.applyRenames('foobar', { find: 'foo', replace: 'bar', wholeName: true }), 'foobar',
  'applyRenames wholeName: partial name untouched');
eq(TO.applyRenames('FOO', { find: 'foo', replace: 'bar', wholeName: true }), 'bar',
  'applyRenames wholeName: case-insensitive by default');
eq(TO.applyRenames('FOO', { find: 'foo', replace: 'bar', wholeName: true, caseSensitive: true }), 'FOO',
  'applyRenames wholeName: caseSensitive respected');
eq(TO.applyRenames('tmp-abc', { prefixStrip: 'tmp-' }), 'abc', 'applyRenames prefixStrip: strips literal prefix');
eq(TO.applyRenames('Tmp-abc', { prefixStrip: 'tmp-' }), 'Tmp-abc',
  'applyRenames prefixStrip: case-sensitive miss leaves name');
eq(TO.applyRenames('tmp-abc', { prefixStrip: 'tmp-', prefix: '#', suffix: '/x' }), '#abc/x',
  'applyRenames: prefix/suffix appended after stripping');
eq(TO.applyRenames('abc', { prefix: '#', suffix: '!' }), '#abc!', 'applyRenames: prefix/suffix on plain name');
eq(TO.applyRenames('abc', { caseMode: 'lower' }), 'abc', 'applyRenames caseMode lower: no-op on lowercase');
eq(TO.applyRenames('ABC', { caseMode: 'lower' }), 'abc', 'applyRenames caseMode lower: downcases');
eq(TO.applyRenames('abc def', { caseMode: 'upper' }), 'ABC DEF', 'applyRenames caseMode upper: upcases');
eq(TO.applyRenames('hello world/x-y', { caseMode: 'capitalize' }), 'Hello World/X-Y',
  'applyRenames caseMode capitalize: word starts incl. / and -');
eq(TO.applyRenames('abc...', { trimPunct: true }), 'abc', 'applyRenames trimPunct: trailing dots removed');
eq(TO.applyRenames('a   b', { trimPunct: true }), 'a b', 'applyRenames trimPunct: spaces collapsed too');
eq(TO.applyRenames('ＡＢＣ', {}), 'ABC', 'applyRenames: halfWidth defaults to on');
eq(TO.applyRenames('ＡＢＣ', { halfWidth: false }), 'ＡＢＣ', 'applyRenames: halfWidth:false keeps full-width');
eq(TO.applyRenames('  abc  ', {}), 'abc', 'applyRenames: collapseSpace defaults to on (trims)');
eq(TO.applyRenames('a/b/c/d', { depthCap: 2 }), 'a/b', 'applyRenames depthCap: truncates deep path');
eq(TO.applyRenames('a/b', { depthCap: 5 }), 'a/b', 'applyRenames depthCap: shallower path untouched');
eq(TO.applyRenames('a/b/c', { depthCap: 2, prefix: '#', suffix: '!' }), '#a/b!',
  'applyRenames: depthCap runs before prefix/suffix');
eq(TO.applyRenames(null, {}), '', 'applyRenames: null -> empty string');
eq(TO.applyRenames('Foo', { caseMode: 'lower', find: 'foo', replace: 'bar' }), 'bar',
  'applyRenames: replace before caseMode');

/* ==================== ⑧ planRename ==================== */
{
  const tags = [{ name: 'a' }, { name: 'b' }];
  const p = TO.planRename(tags, { prefix: '#' });
  eq(p.changes.length, 2, 'planRename: two renames');
  eq(p.changes[0].from, 'a', 'planRename: keeps input order [0].from');
  eq(p.changes[0].to, '#a', 'planRename: applies prefix [0].to');
  eq(p.changes[0].kind, 'rename', 'planRename: new target -> kind rename');
  eq(p.changes[1].to, '#b', 'planRename: applies prefix [1].to');
  eq(p.unchanged, 0, 'planRename: no unchanged');
  eq(p.invalid.length, 0, 'planRename: no invalid');
  eq(p.conflicts.length, 0, 'planRename: conflicts only holds merges');
}
{
  // 目标已存在 → merge
  const p = TO.planRename([{ name: 'a' }, { name: 'b' }], { find: 'a', replace: 'b' });
  eq(p.changes.length, 1, 'planRename merge: only a -> b changes');
  eq(p.changes[0].to, 'b', 'planRename merge: target name');
  eq(p.changes[0].kind, 'merge', 'planRename merge: existing target -> kind merge');
  eq(p.conflicts.length, 1, 'planRename merge: conflicts mirrors merges');
  eq(p.unchanged, 1, 'planRename merge: b itself counted unchanged');
  eq(p.invalid.length, 0, 'planRename merge: not an error');
}
{
  // 批内两条撞同一新名 → 后一条进 invalid
  const p = TO.planRename([{ name: 'a1' }, { name: 'a2' }], { find: '\\d', replace: '', regex: true });
  eq(p.changes.length, 1, 'planRename collision: first one wins');
  eq(p.changes[0].from, 'a1', 'planRename collision: winner is input order first');
  eq(p.invalid.length, 1, 'planRename collision: loser goes to invalid');
  eq(p.invalid[0].from, 'a2', 'planRename collision: loser recorded');
  eq(p.invalid[0].to, 'a', 'planRename collision: loser target name');
  ok(p.invalid[0].reason.indexOf('a1') >= 0, 'planRename collision: reason names the winner', p.invalid[0].reason);
}
{
  // 改后为空 → invalid（不是 unchanged）
  const p = TO.planRename([{ name: 'abc' }], { find: 'abc', replace: '' });
  eq(p.changes.length, 0, 'planRename empty: no change emitted');
  eq(p.invalid.length, 1, 'planRename empty: invalid');
  eq(p.invalid[0].reason, '标签名为空', 'planRename empty: empty-name reason (zh)');
  eq(p.unchanged, 0, 'planRename empty: invalid is not counted as unchanged');
}
{
  // unchanged 与 invalid 分开计数
  const p = TO.planRename([{ name: 'a' }, { name: 'b' }], { find: 'a', replace: '' });
  eq(p.invalid.length, 1, 'planRename counters: a -> "" is invalid');
  eq(p.unchanged, 1, 'planRename counters: b untouched is unchanged');
  eq(p.changes.length, 0, 'planRename counters: no changes');
}
{
  // opts.only 只处理选中项
  const p1 = TO.planRename([{ name: 'a' }, { name: 'b' }], { prefix: '#' }, { only: ['a'] });
  eq(p1.changes.length, 1, 'planRename only(strings): filters input');
  eq(p1.changes[0].from, 'a', 'planRename only(strings): selected item only');
  eq(p1.unchanged, 0, 'planRename only(strings): unselected not counted');
  const p2 = TO.planRename([{ name: 'a' }, { name: 'b' }], { prefix: '#' }, { only: [{ name: 'b' }] });
  eq(p2.changes.length, 1, 'planRename only(objects): filters input');
  eq(p2.changes[0].to, '#b', 'planRename only(objects): object form accepted');
  // 目标存在性永远按全量判断，而非按选中集
  const p3 = TO.planRename([{ name: 'a' }, { name: 'b' }], { find: 'a', replace: 'b' }, { only: [{ name: 'a' }] });
  eq(p3.changes[0].kind, 'merge', 'planRename only: existence checked against full tag list');
}

/* ==================== ⑨ planMerge ==================== */
{
  const tags = [{ name: 'x' }, { name: 'y' }, { name: 'target' }];
  const p = TO.planMerge(tags, 'target', { zh: true });
  eq(p.changes.length, 2, 'planMerge: all others merged into target');
  eq(p.changes[0].from, 'x', 'planMerge: first source');
  eq(p.changes[0].to, 'target', 'planMerge: points at target');
  eq(p.changes[0].kind, 'merge', 'planMerge: kind merge');
  eq(p.changes[1].kind, 'merge', 'planMerge: kind merge [1]');
  ok(p.changes.every((c) => c.from !== 'target'), 'planMerge: target itself excluded');
  eq(p.invalid.length, 0, 'planMerge: no invalid');
  eq(p.unchanged, 0, 'planMerge: unchanged always 0');
}
{
  const p = TO.planMerge([{ name: 'x' }], 'nope', { zh: true });
  eq(p.changes.length, 0, 'planMerge missing target: no changes');
  eq(p.invalid.length, 1, 'planMerge missing target: invalid');
  eq(p.invalid[0].reason, '目标标签不存在（合并请用重命名表单）', 'planMerge missing target: reason (zh)');
}
{
  const p = TO.planMerge([{ name: 'x' }], '  ', { zh: true });
  eq(p.invalid.length, 1, 'planMerge empty target: invalid');
  eq(p.invalid[0].reason, '标签名为空', 'planMerge empty target: empty-name reason');
  eq(p.changes.length, 0, 'planMerge empty target: no changes');
}
{
  const p = TO.planMerge([{ name: 'x' }, { name: 'x' }, { name: 't' }], 't', { zh: true });
  eq(p.changes.length, 1, 'planMerge: duplicate source names deduped');
  const p2 = TO.planMerge([{ name: 'x' }], 'nope', { zh: false });
  eq(p2.invalid[0].reason, 'Target tag does not exist', 'planMerge: reason switches to English without zh');
}

/* ==================== ⑩ planAddParent ==================== */
{
  const p = TO.planAddParent([{ name: 'a' }, { name: 'b' }], 'p');
  eq(p.changes.length, 2, 'planAddParent: both tags get a parent');
  eq(p.changes[0].to, 'p/a', 'planAddParent: parent joined with /');
  eq(p.changes[0].kind, 'rename', 'planAddParent: kind rename');
  eq(p.unchanged, 0, 'planAddParent: none unchanged');
  eq(p.invalid.length, 0, 'planAddParent: none invalid');
}
{
  // 已在该父级下 → 默认 skipNested 跳过（计入 unchanged）
  const p = TO.planAddParent([{ name: 'p/a' }], 'p');
  eq(p.changes.length, 0, 'planAddParent skipNested: already nested not re-parented');
  eq(p.unchanged, 1, 'planAddParent skipNested: counted as unchanged');
  const p2 = TO.planAddParent([{ name: 'p/a' }], 'p', { skipNested: false });
  eq(p2.changes.length, 1, 'planAddParent skipNested:false allows re-parenting');
  eq(p2.changes[0].to, 'p/p/a', 'planAddParent skipNested:false: parent stacked');
}
{
  // 目标已存在 → unchanged
  const p = TO.planAddParent([{ name: 'a' }, { name: 'p/a' }], 'p', { skipNested: false });
  eq(p.unchanged, 1, 'planAddParent: existing target -> unchanged');
  eq(p.changes.length, 1, 'planAddParent: other tag still planned');
  eq(p.changes[0].to, 'p/p/a', 'planAddParent: planned name');
}
{
  const p = TO.planAddParent([{ name: 'a' }], '', { zh: true });
  eq(p.invalid.length, 1, 'planAddParent: empty parent invalid');
  eq(p.invalid[0].reason, '父级为空', 'planAddParent: empty parent reason (zh)');
  eq(p.changes.length, 0, 'planAddParent: empty parent emits nothing');
}
{
  // 多级父级 + 全角斜杠 + 首尾斜杠
  const p = TO.planAddParent([{ name: 'a' }], '／x／y／');
  eq(p.changes[0].to, 'x/y/a', 'planAddParent: multi-level parent normalized');
  const p2 = TO.planAddParent([{ name: 'a' }, { name: 'b' }], 'p', { only: [{ name: 'b' }] });
  eq(p2.changes.length, 1, 'planAddParent only: filters input');
  eq(p2.changes[0].to, 'p/b', 'planAddParent only: selected item');
}

/* ==================== ⑪ planReparent ==================== */
{
  const p = TO.planReparent([{ name: 'old/a' }, { name: 'old/b' }, { name: 'x/c' }], 'old', 'new');
  eq(p.changes.length, 2, 'planReparent: first-segment matches only');
  eq(p.changes[0].to, 'new/a', 'planReparent: first segment replaced');
  eq(p.changes[0].kind, 'rename', 'planReparent: kind rename');
  eq(p.unchanged, 1, 'planReparent: non-matching counted unchanged');
  eq(p.invalid.length, 0, 'planReparent: no invalid');
}
{
  // 只替换首段：非首段出现 old 不处理
  const p = TO.planReparent([{ name: 'x/old/y' }], 'old', 'new');
  eq(p.changes.length, 0, 'planReparent: non-first segment untouched by default');
  eq(p.unchanged, 1, 'planReparent: non-first segment counted unchanged');
  const p2 = TO.planReparent([{ name: 'x/old/y' }], 'old', 'new', { anywhere: true });
  eq(p2.changes.length, 1, 'planReparent anywhere: matches any segment');
  eq(p2.changes[0].to, 'x/new/y', 'planReparent anywhere: replaced in place');
}
{
  const p = TO.planReparent([{ name: 'old/a' }], '', 'new', { zh: true });
  eq(p.invalid.length, 1, 'planReparent: empty old parent invalid');
  eq(p.invalid[0].reason, '父级为空', 'planReparent: empty old reason');
  const p2 = TO.planReparent([{ name: 'old/a' }], 'old', '  ', { zh: true });
  eq(p2.invalid.length, 1, 'planReparent: empty new parent invalid');
  eq(p2.changes.length, 0, 'planReparent: empty new parent emits nothing');
}
{
  const p = TO.planReparent([{ name: 'old/a' }, { name: 'new/a' }], 'old', 'new');
  eq(p.changes.length, 0, 'planReparent: existing target protected');
  eq(p.unchanged, 2, 'planReparent: both counted unchanged');
  const p2 = TO.planReparent([{ name: 'old/a' }], '／old／', '／new／');
  eq(p2.changes[0].to, 'new/a', 'planReparent: separators around segments normalized');
  const p3 = TO.planReparent([{ name: 'old/a' }], 'old', 'new/sub');
  eq(p3.changes[0].to, 'new/sub/a', 'planReparent: multi-level new parent joined');
}

/* ==================== ⑫ planStripPrefix ==================== */
{
  const p = TO.planStripPrefix([{ name: 'tmp-a' }, { name: 'b' }], 'tmp-');
  eq(p.changes.length, 1, 'planStripPrefix: only prefixed tag changes');
  eq(p.changes[0].to, 'a', 'planStripPrefix: prefix removed');
  eq(p.unchanged, 1, 'planStripPrefix: non-prefixed counted unchanged');
  eq(p.invalid.length, 0, 'planStripPrefix: no invalid');
}
{
  const p = TO.planStripPrefix([{ name: 'tmp-' }], 'tmp-');
  eq(p.changes.length, 0, 'planStripPrefix: stripping to empty emits nothing');
  eq(p.invalid.length, 1, 'planStripPrefix: stripping to empty invalid');
  eq(p.invalid[0].reason, '标签名为空', 'planStripPrefix: empty result reason');
}
{
  const p = TO.planStripPrefix([{ name: 'a' }], '');
  eq(p.changes.length, 0, 'planStripPrefix: empty prefix no-op');
  eq(p.unchanged, 0, 'planStripPrefix: empty prefix does not scan');
  const p2 = TO.planStripPrefix([{ name: 'tmp-a' }, { name: 'a' }], 'tmp-');
  eq(p2.changes.length, 0, 'planStripPrefix: existing target protected');
  eq(p2.unchanged, 2, 'planStripPrefix: both counted unchanged');
  const p3 = TO.planStripPrefix([{ name: 'tmp-a' }, { name: 'tmp-b' }], 'tmp-', { only: ['tmp-b'] });
  eq(p3.changes.length, 1, 'planStripPrefix only: filters input');
  eq(p3.changes[0].to, 'b', 'planStripPrefix only: selected item');
}

/* ==================== ⑬ planColorSlots ==================== */
eq(JSON.stringify(TO.planColorSlots([0, 2], 2)), JSON.stringify([1, 3]),
  'planColorSlots: fills gaps in ascending order');
eq(JSON.stringify(TO.planColorSlots([0, 1, 2, 3, 4, 5, 6, 7, 8], 2)), JSON.stringify([]),
  'planColorSlots: all 9 slots taken -> []');
eq(JSON.stringify(TO.planColorSlots([], 0)), JSON.stringify([]), 'planColorSlots: n=0 -> []');
eq(JSON.stringify(TO.planColorSlots(null, 2)), JSON.stringify([0, 1]),
  'planColorSlots: null usedPositions -> from 0');
eq(JSON.stringify(TO.planColorSlots([0, 1, 2, 3, 4, 5, 6, 7], 3)), JSON.stringify([8]),
  'planColorSlots: never exceeds MAX_COLORED(9)');
eq(JSON.stringify(TO.planColorSlots([1, '2'], 2)), JSON.stringify([0, 3]),
  'planColorSlots: string positions coerced via Number');
eq(JSON.stringify(TO.planColorSlots([5], 3)), JSON.stringify([0, 1, 2]),
  'planColorSlots: starts from lowest free slot');

/* ==================== ⑭ stats ==================== */
{
  const s = TO.stats([
    { name: '#z', count: 0 },
    { name: '#o', count: 1 },
    { name: '#c/1', count: 2, color: 'red' },
    { name: '#f', count: 5 },
    { name: '#m', count: 9, protected: true },
  ]);
  eq(s.unique, 5, 'stats: unique counts non-empty names');
  eq(s.total, 17, 'stats: total sums counts');
  eq(s.avg, 3.4, 'stats: avg rounded to 2 decimals');
  eq(s.max, 9, 'stats: max count');
  // ★ 当前实现是「以 count 为权重的累计中位数」：counts=[0,1,2,5,9]，累计到 9 才越过 total/2=8.5
  eq(s.median, 9, 'stats: median is cumulative/weighted by count (current behaviour)');
  eq(s.buckets.zero, 1, 'stats buckets: zero');
  eq(s.buckets.one, 1, 'stats buckets: one');
  eq(s.buckets.few, 2, 'stats buckets: few (2..5)');
  eq(s.buckets.many, 1, 'stats buckets: many (>5)');
  eq(s.colored, 1, 'stats: colored counts tags with color');
  eq(s.nested, 1, 'stats: nested counts depth>1');
  eq(s.protectedCount, 1, 'stats: protectedCount');
  eq(s.top.length, 5, 'stats: top capped at 20 (here all 5)');
  eq(s.top[0].name, '#m', 'stats: top sorted by count desc');
  eq(s.top[4].name, '#z', 'stats: top tail is smallest count');
}
{
  const s = TO.stats([]);
  eq(s.unique, 0, 'stats empty: unique 0');
  eq(s.total, 0, 'stats empty: total 0');
  eq(s.avg, 0, 'stats empty: avg 0 (no NaN)');
  eq(s.max, 0, 'stats empty: max 0');
  eq(s.median, 0, 'stats empty: median 0');
  eq(s.buckets.zero + s.buckets.one + s.buckets.few + s.buckets.many, 0, 'stats empty: buckets all 0');
  eq(s.top.length, 0, 'stats empty: top []');
  eq(TO.stats(null).unique, 0, 'stats null: safe');
  const junk = TO.stats([{ name: '' }, { count: 3 }, null, { name: 'x', count: 2 }]);
  eq(junk.unique, 1, 'stats: entries without name skipped');
  eq(junk.total, 2, 'stats: skipped entries excluded from total');
  eq(TO.stats([{ name: 'a', count: 0 }, { name: 'b', count: 0 }]).buckets.zero, 2,
    'stats: zero-count tags bucketed as zero');
}

/* ==================== ⑮ cooccurrence ==================== */
{
  const pairs = TO.cooccurrence([['a', 'b'], ['a', 'b'], ['b', 'c']], 1);
  eq(pairs.length, 2, 'cooccurrence: two distinct pairs');
  eq(pairs[0].a, 'a', 'cooccurrence: sorted by count desc [0].a');
  eq(pairs[0].b, 'b', 'cooccurrence: sorted by count desc [0].b');
  eq(pairs[0].n, 2, 'cooccurrence: same-item pair counted twice');
  eq(pairs[1].n, 1, 'cooccurrence: less frequent pair second');
  eq(pairs[1].a, 'b', 'cooccurrence: pair key is alphabetically ordered');
}
{
  eq(TO.cooccurrence([['a', 'b'], ['a', 'b']], 3).length, 0, 'cooccurrence: minCount filters');
  eq(TO.cooccurrence([['a', 'b'], ['a', 'b']], 2).length, 1, 'cooccurrence: minCount boundary inclusive');
  eq(TO.cooccurrence([['a', 'b'], ['a', 'b']]).length, 0, 'cooccurrence: default minCount = 3');
  eq(JSON.stringify(TO.cooccurrence([])), '[]', 'cooccurrence: empty input -> []');
  eq(JSON.stringify(TO.cooccurrence(null)), '[]', 'cooccurrence: null input -> []');
  eq(TO.cooccurrence([null, ['a', 'b']], 1).length, 1, 'cooccurrence: null item skipped');
  eq(TO.cooccurrence([['a', 'a', 'b']], 1)[0].n, 1, 'cooccurrence: duplicate tags in one item deduped');
  const tie = TO.cooccurrence([['b', 'c'], ['a', 'b']], 1);
  eq(tie.length, 2, 'cooccurrence: tie produces two pairs');
  eq(tie[0].a, 'a', 'cooccurrence: tie broken by first tag name');
  eq(tie[1].a, 'b', 'cooccurrence: tie broken by first tag name [1]');
}

/* ==================== ⑯ sortBy ==================== */
{
  const tags = [{ name: 'b', count: 2 }, { name: 'a', count: 5 }, { name: 'c', count: 2 }];
  const byName = TO.sortBy(tags, 'name');
  eq(byName.map((t) => t.name).join(','), 'a,b,c', 'sortBy name: ascending');
  eq(TO.sortBy(tags, 'name', 'desc').map((t) => t.name).join(','), 'c,b,a', 'sortBy name: descending');
  eq(TO.sortBy(tags, 'count').map((t) => t.name).join(','), 'b,c,a',
    'sortBy count: ascending with name tie-break');
  eq(TO.sortBy(tags, 'count', 'desc').map((t) => t.name).join(','), 'a,b,c',
    'sortBy count: descending, tie still name-ascending');
  eq(TO.sortBy(tags).map((t) => t.name).join(','), 'a,b,c', 'sortBy: default key is name');
  eq(tags.map((t) => t.name).join(','), 'b,a,c', 'sortBy: original array not mutated');
  ok(TO.sortBy(tags, 'name') !== tags, 'sortBy: returns a new array');
}
{
  const tags = [{ name: 'a/b', count: 1 }, { name: 'x', count: 9 }, { name: 'a/b/c', count: 3 }];
  eq(TO.sortBy(tags, 'depth').map((t) => t.name).join(','), 'x,a/b,a/b/c', 'sortBy depth: ascending');
  eq(TO.sortBy(tags, 'depth', 'desc').map((t) => t.name).join(','), 'a/b/c,a/b,x',
    'sortBy depth: descending');
  eq(TO.sortBy([], 'name').length, 0, 'sortBy: empty input');
  eq(TO.sortBy(null, 'count').length, 0, 'sortBy: null input');
}

/* ==================== ⑰ toCSV / parseCSV ==================== */
{
  const tags = [
    { name: 'a,b', count: 3, manual: 1, auto: 2, color: '#ff0000', protected: true },
    { name: 'say "hi"', count: 0 },
  ];
  const csv = TO.toCSV(tags);
  ok(csv.startsWith('name,count,manual,auto,color,protected\n'), 'toCSV: header first');
  ok(csv.indexOf('"a,b"') >= 0, 'toCSV: comma-containing name quoted');
  ok(csv.indexOf('"say ""hi"""') >= 0, 'toCSV: inner quotes doubled');
  ok(csv.endsWith('\n'), 'toCSV: trailing newline');
  eq(csv.split('\n').length, 4, 'toCSV: header + 2 rows + trailing empty');

  const back = TO.parseCSV(csv);
  eq(back.length, 2, 'CSV roundtrip: row count');
  eq(back[0].name, 'a,b', 'CSV roundtrip: comma name preserved');
  eq(back[0].count, 3, 'CSV roundtrip: count');
  eq(back[0].color, '#ff0000', 'CSV roundtrip: color');
  eq(back[0].protected, true, 'CSV roundtrip: protected 1 -> true');
  eq(back[1].name, 'say "hi"', 'CSV roundtrip: doubled quotes unescaped');
  eq(back[1].count, 0, 'CSV roundtrip: zero count preserved');
  eq(back[1].color, '', 'CSV roundtrip: empty color');
  eq(back[1].protected, false, 'CSV roundtrip: protected 0 -> false');
  eq(TO.parseCSV(TO.toCSV([])).length, 0, 'CSV roundtrip: empty tag list');
  /* ★实现疑似有问题：toCSV 写出 manual/auto 两列，parseCSV 却不读回，
   * 导出→导入会静默丢失手动/自动分布。 */
  const lossy = TO.parseCSV(TO.toCSV([{ name: 'a', count: 1, manual: 1, auto: 0 }]));
  eq(lossy[0].manual, undefined, '★ CSV roundtrip: manual/auto columns dropped by parseCSV');
}
{
  const noHead = TO.parseCSV('x,4,,,blue,1');
  eq(noHead.length, 1, 'parseCSV no-header: single row');
  eq(noHead[0].name, 'x', 'parseCSV no-header: col0 = name');
  eq(noHead[0].count, 4, 'parseCSV no-header: col1 = count');
  eq(noHead[0].color, 'blue', 'parseCSV no-header: col4 = color');
  eq(noHead[0].protected, true, 'parseCSV no-header: col5 = protected');
  const noHeadMulti = TO.parseCSV('x,4,,,blue,0\ny,5,,,red,1');
  eq(noHeadMulti.length, 2, 'parseCSV no-header: multiple rows');
}
{
  eq(TO.parseCSV('').length, 0, 'parseCSV: empty string -> []');
  eq(TO.parseCSV(null).length, 0, 'parseCSV: null -> []');
  const bom = TO.parseCSV('\uFEFFname,count\na,5');
  eq(bom.length, 1, 'parseCSV: BOM stripped, header still recognized');
  eq(bom[0].name, 'a', 'parseCSV: BOM does not leak into name');
  eq(TO.parseCSV('name,count\na,1\n\n\n').length, 1, 'parseCSV: blank lines skipped');
  eq(TO.parseCSV('name,count\na,abc')[0].count, 0, 'parseCSV: non-numeric count -> 0');
  const miss = TO.parseCSV('name,count\na,3');
  eq(miss[0].color, '', 'parseCSV: absent color column -> ""');
  eq(miss[0].protected, false, 'parseCSV: absent protected column -> false');
  const yes = TO.parseCSV('name,count,color,protected\na,1,,yes');
  eq(yes[0].protected, true, 'parseCSV: "yes" -> true');
  eq(TO.parseCSV('name,count,color,protected\na,1,,no')[0].protected, false,
    'parseCSV: "no" -> false');
  const quotedNL = TO.parseCSV('name,count\n"x\ny",1');
  eq(quotedNL.length, 1, 'parseCSV: newline inside quotes does not split rows');
  eq(quotedNL[0].name, 'x y', 'parseCSV: normalized output (newline collapsed)');
  eq(TO.parseCSV('name,count\n"a。",1')[0].name, 'a', 'parseCSV: name passed through norm()');
  eq(TO.parseCSV('name,count\n   ,1').length, 0, 'parseCSV: row with blank name skipped');
  eq(TO.parseCSV('name,count\na,1\r\nb,2')[0].name, 'a', 'parseCSV: CRLF tolerated');
  eq(TO.parseCSV('name,count\na,1\r\nb,2').length, 2, 'parseCSV: CRLF rows parsed');
}

console.log('');
if (fails.length) {
  console.log('FAIL ' + fails.length + ' / ' + (pass + fails.length));
  for (const f of fails) console.log('  x ' + f);
  process.exit(1);
}
console.log('PASS ' + pass + ' assertions  (tag-ops)');
