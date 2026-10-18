#!/usr/bin/env node
/* Agent 长期记忆（AgentMemory，0.51.0）测试
 *
 * 覆盖：
 *   ① add：基本写入 / 空文本 / 空白文本 / 超 500 字截断 / 非法 kind 回落 / null 入参；
 *   ② list / search：最新在前、limit、大小写不敏感（text 与 kind）、空 query = list；
 *   ③ remove / clear / trim；
 *   ④ LRU 上限 200（塞 205 条留最新 200）；
 *   ⑤ 坏 JSON / 非数组 / 坏条目容错；
 *   ⑥ asPromptBlock 格式（中文 kind 标签）与空态。
 *
 * 运行：node test/agent-memory.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FILES = [
  'chrome/content/scripts/core/utils.js',
  'chrome/content/scripts/features/agent-memory.js',
];

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

/* ---------------- 桩环境 ---------------- */

const store = new Map();
const PREF = (k) => 'extensions.zotero.paperpilot.' + k;

const Zotero = {
  locale: 'zh-CN',
  Prefs: {
    get(k /*, global */) { return store.has(k) ? store.get(k) : undefined; },
    set(k, v /*, global */) { store.set(k, v); },
  },
  logError() {},
};

const sandbox = {
  console, Zotero, Services: {}, JSON, Date, Math, String, Number,
  Array, Object, Set, Map, isFinite, parseInt,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of FILES) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
}

const AM = sandbox.AgentMemory;
const KEY = PREF('agentMemory');
const reset = () => store.delete(KEY);
const raw = () => {
  const v = store.get(KEY);
  return v ? JSON.parse(v) : [];
};

(function main() {

  /* ==================== ⓪ 基础 ==================== */

  ok(!!AM && typeof AM.add === 'function', 'AgentMemory 已加载');
  eq(AM.PREF_KEY, 'agentMemory', 'pref 名为 agentMemory');
  eq(AM.MAX_ITEMS, 200, 'LRU 上限常量 200');
  eq(AM.TEXT_MAX, 500, '单条文本上限 500');

  reset();
  eq(AM.list().length, 0, '空存储 → list []');
  eq(AM.search('x').length, 0, '空存储 → search []');
  eq(AM.asPromptBlock(), '', '空存储 → asPromptBlock ""');
  eq(AM.remove('nope'), false, 'remove 不存在的 id → false');
  eq(AM.clear(), 0, '空存储 clear → 0');

  /* ==================== ① add ==================== */

  eq(AM.add(null), null, 'null 入参 → null');
  eq(AM.add({ text: '' }), null, '空文本 → null');
  eq(AM.add({ text: '   \n\t ' }), null, '纯空白文本 → null');
  eq(AM.add({ text: 'x' }).kind, 'fact', '缺省 kind → fact');
  reset();

  const e1 = AM.add({ kind: 'project', text: '研究方向：长文本检索增强' });
  ok(!!e1, 'add 返回条目');
  ok(/^mem-/.test(e1.id), 'id 形如 mem-<ts36>-<rand>', e1.id);
  eq(e1.kind, 'project', 'kind 透传');
  eq(e1.text, '研究方向：长文本检索增强', 'text 透传');
  ok(typeof e1.at === 'number' && e1.at > 0, 'at 为时间戳');
  eq('source' in e1, false, '无 source 时不写该字段');

  const e2 = AM.add({ kind: 'prefer', text: '偏好中文回答', source: 'memory_write' });
  eq(e2.source, 'memory_write', 'source 透传');
  eq(AM.add({ kind: 'PREFER', text: '大小写容错' }).kind, 'prefer', 'kind 大小写容错');
  eq(AM.add({ kind: 'nonsense', text: '非法 kind' }).kind, 'fact', '非法 kind 回落 fact');
  eq(AM.add({ kind: '', text: '空 kind' }).kind, 'fact', '空 kind 回落 fact');

  // 空白压平
  const flat = AM.add({ kind: 'fact', text: '  多行\n文本\t带   空白  ' });
  eq(flat.text, '多行 文本 带 空白', '文本压平空白并 trim');

  // 超长截断
  const long = 'A'.repeat(600);
  const clipped = AM.add({ kind: 'fact', text: long });
  eq(clipped.text.length, AM.TEXT_MAX, '超 500 字截断到 500');
  eq(clipped.text, 'A'.repeat(500), '截断保留前 500 字');

  /* ==================== ② list / search ==================== */

  reset();
  AM.add({ kind: 'project', text: 'Transformer 架构改造' });
  AM.add({ kind: 'fact', text: 'BERT 是双向编码器' });
  AM.add({ kind: 'prefer', text: '偏好中文回答' });

  const all = AM.list();
  eq(all.length, 3, 'list 返回全部');
  eq(all[0].text, '偏好中文回答', '最新在前（list[0] 是最后写入的）');
  eq(all[2].text, 'Transformer 架构改造', '最旧在最后');
  eq(AM.list(2).length, 2, 'list(limit) 生效');
  eq(AM.list(2)[0].text, '偏好中文回答', 'list(limit) 仍最新在前');
  eq(AM.list(0).length, 0, 'list(0) → []');
  eq(AM.list('bad').length, 3, 'list 坏 limit → 全部');

  eq(AM.search('bert').length, 1, 'search：小写命中大写文本');
  eq(AM.search('BERT')[0].text, 'BERT 是双向编码器', 'search：大写命中');
  eq(AM.search('bErT').length, 1, 'search：大小写混合命中');
  eq(AM.search('PROJECT').length, 1, 'search：kind 也参与匹配（大小写不敏感）');
  eq(AM.search('prefer')[0].kind, 'prefer', 'search：按 kind 命中');
  eq(AM.search('').length, 3, 'search 空 query = list()');
  eq(AM.search('   ').length, 3, 'search 空白 query = list()');
  eq(AM.search('zzz').length, 0, 'search 无命中 → []');
  eq(AM.search('中文').length, 1, 'search：中文关键词');

  /* ==================== ③ remove / clear / trim ==================== */

  const target = AM.list()[1].id;
  eq(AM.remove(target), true, 'remove 命中 → true');
  eq(AM.list().length, 2, 'remove 后少一条');
  eq(AM.list().filter((m) => m.id === target).length, 0, 'remove 的条目已消失');
  eq(AM.remove(target), false, '重复 remove → false');
  eq(AM.remove(''), false, '空 id → false');

  eq(AM.clear(), 2, 'clear 返回清掉的条数');
  eq(AM.list().length, 0, 'clear 后为空');
  eq(raw().length, 0, 'pref 里也清空');

  // trim(keep)
  for (let i = 0; i < 5; i++) AM.add({ text: 'm' + i });
  eq(AM.trim(3), 3, 'trim(keep) 返回保留条数');
  eq(AM.list().length, 3, 'trim 后只剩 keep 条');
  eq(AM.list()[0].text, 'm4', 'trim 保留最新的');
  eq(AM.trim(0), 3, 'trim(0) 回退上限（不误删）');
  AM.clear();

  /* ==================== ④ LRU 200 ==================== */

  AM.clear();
  for (let i = 1; i <= 205; i++) AM.add({ kind: 'fact', text: 'm' + i });
  const lru = AM.list();
  eq(lru.length, 200, 'LRU 上限 200');
  eq(lru[0].text, 'm205', '最新一条保留在最前');
  eq(lru[199].text, 'm6', '最旧的 5 条被挤出（m1-m5）');
  eq(raw().length, 200, 'pref 里也只存 200 条');
  eq(AM.list().filter((m) => m.text === 'm1').length, 0, '被裁条目不可读');

  /* ==================== ⑤ 坏值容错 ==================== */

  store.set(KEY, '{not-json');
  eq(AM.list().length, 0, '坏 JSON → list []');
  eq(AM.search('x').length, 0, '坏 JSON → search []');
  eq(AM.asPromptBlock(), '', '坏 JSON → asPromptBlock ""');
  eq(AM.remove('mem-x'), false, '坏 JSON → remove false（不抛）');
  eq(AM.clear(), 0, '坏 JSON → clear 0');

  store.set(KEY, JSON.stringify({ not: 'array' }));
  eq(AM.list().length, 0, '非数组 JSON → []');

  store.set(KEY, JSON.stringify([
    null, 42, 'str', { text: '没有 id' },
    { id: 'bad-empty', text: '   ' },
    { id: 'ok', kind: 'weird', text: '健康条目', at: 123 },
  ]));
  const survivors = AM.list();
  eq(survivors.length, 1, '坏条目被过滤只剩健康条目');
  eq(survivors[0].id, 'ok', '健康条目 id 可读');
  eq(survivors[0].kind, 'fact', '手改 pref 的非法 kind 读取时回落 fact');
  eq(survivors[0].at, 123, 'at 透传');

  /* ==================== ⑥ asPromptBlock ==================== */

  reset();
  eq(AM.asPromptBlock(), '', '空记忆 → ""');

  AM.add({ kind: 'project', text: '研究大模型检索增强' });
  AM.add({ kind: 'prefer', text: '回答用中文、先给结论' });
  AM.add({ kind: 'fact', text: '该组 baseline 是 BM25' });
  const block = AM.asPromptBlock();
  eq(block, '- [事实] 该组 baseline 是 BM25\n' +
    '- [偏好] 回答用中文、先给结论\n' +
    '- [项目] 研究大模型检索增强', 'asPromptBlock：中文标签 + 最新在前 + 一行一条');
  eq(AM.asPromptBlock(1), '- [事实] 该组 baseline 是 BM25', 'asPromptBlock(limit) 生效');
  eq(AM.asPromptBlock(0), '', 'asPromptBlock(0) → ""');

  // 21 条默认只注入 20 条
  AM.clear();
  for (let i = 0; i < 21; i++) AM.add({ kind: 'fact', text: 'f' + i });
  eq(AM.asPromptBlock().split('\n').length, AM.PROMPT_LIMIT, 'asPromptBlock 默认注入 20 条');

  reset();

  /* ---------------- 汇总 ---------------- */

  console.log(`\nagent-memory 测试：${pass} 通过，${fails.length} 失败`);
  if (fails.length) {
    fails.forEach((f) => console.log('  ✗ ' + f));
    process.exit(1);
  }
})();
