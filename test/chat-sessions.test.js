#!/usr/bin/env node
/* 浮窗会话持久化（ChatSessions）+ Agent 决策模型路由 测试
 *
 * 覆盖三层：
 *   ① ChatSessions 数据域：save / list / load / remove / latestForItem / latest，
 *      空历史不落盘、40 条截断、50 条 LRU、同 id 覆盖前置、坏 JSON 容错、标题截断。
 *   ② AIClient opts.model：mock Zotero.HTTP.request 与 fetch，捕获 payload，
 *      断言 chat / chatStream 两路覆盖生效、不传时回退 cfg.model（含流式降级路径）。
 *   ③ ChatFloat 接线：_distillLastTask（label 截断 / 重名 / 无问答 / 无 CommandTags）、
 *      _saveSession / _restoreSession / _clearHistory、_decisionModel 读取。
 *
 * 运行：node test/chat-sessions.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FILES = [
  'chrome/content/scripts/core/utils.js',
  'chrome/content/scripts/features/chat-sessions.js',
  'chrome/content/scripts/ai/client.js',
  'chrome/content/scripts/panels/chat-float.js',
];

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }
function has(hay, needle, label) {
  return ok(String(hay).indexOf(needle) >= 0, label,
    { want: needle, got: String(hay).slice(0, 220) });
}

/* ---------------- 桩环境 ---------------- */

const store = new Map();
const PREF = (k) => 'extensions.zotero.paperpilot.' + k;

const itemA = { id: 101, isRegularItem: () => true, getDisplayTitle: () => '论文A' };
const itemB = { id: 202, isRegularItem: () => true, getDisplayTitle: () => '论文B' };
const ITEMS = { 101: itemA, 202: itemB };

const httpLog = [];
const fetchLog = [];
let httpReply = 'http-ok';
let fetchReply = 'stream-ok';

function mkJsonResp(content) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    body: null,
    async json() { return { choices: [{ message: { content } }] }; },
    async text() { return JSON.stringify({ choices: [{ message: { content } }] }); },
  };
}

const Zotero = {
  locale: 'zh-CN',
  Prefs: {
    get: (k /*, global */) => (store.has(k) ? store.get(k) : undefined),
    set: (k, v /*, global */) => { store.set(k, v); },
  },
  Items: { get: (id) => ITEMS[id] || null },
  logError() {},
  HTTP: {
    async request(method, url, opts) {
      httpLog.push({ method, url, headers: opts.headers, payload: JSON.parse(opts.body) });
      return { response: { choices: [{ message: { content: httpReply } }] } };
    },
  },
};

const Channels = {
  getActiveConfig: () => ({
    ok: true, channelId: 'custom',
    baseUrl: 'https://example.test/v1', apiKey: 'test-key',
    model: 'main-model', extraBody: {},
  }),
};

const sandbox = {
  console, Zotero, Channels, Services: {}, IOUtils: {}, PathUtils: {},
  fetch: async (url, init) => {
    fetchLog.push({ url, payload: JSON.parse(init.body) });
    return mkJsonResp(fetchReply);
  },
  AbortController,
  TextDecoder,
  setTimeout, clearTimeout,
  Promise, Date, Math, JSON, Map,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of FILES) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
}

const CS = sandbox.ChatSessions;
const AI = sandbox.AIClient;
const CF = sandbox.ChatFloat;

function resetSessions() { store.delete(PREF('chatSessions')); }
function rawSessions() {
  const raw = store.get(PREF('chatSessions'));
  return raw ? JSON.parse(raw) : [];
}
function msg(i, role) {
  return { role: role || (i % 2 ? 'assistant' : 'user'), content: 'm' + i };
}

(async function main() {

  /* ==================== ① ChatSessions 数据域 ==================== */

  ok(!!CS && typeof CS.save === 'function', 'ChatSessions 已加载');
  eq(CS.PREF_KEY, 'chatSessions', 'pref 名为 chatSessions');
  resetSessions();
  eq(CS.list().length, 0, '空存储 → list []');
  eq(CS.latest(), null, '空存储 → latest null');
  eq(CS.load('nope'), null, 'load 不存在的 id → null');
  eq(CS.remove('nope'), false, 'remove 不存在的 id → false');
  eq(CS.latestForItem(101), null, '空存储 → latestForItem null');

  // 空 history 不保存（清空后不该留下空会话）
  eq(CS.save({ itemID: 101, history: [] }), null, '空 history → save 返回 null');
  eq(CS.save({ itemID: 101 }), null, '缺 history → save 返回 null');
  eq(CS.save(null), null, 'null 入参 → save 返回 null');
  eq(CS.list().length, 0, '空会话没有落盘');
  eq(store.has(PREF('chatSessions')), false, '空会话连 pref 都没写');

  // 正常保存
  const userText = '这篇论文的核心贡献是什么？请分三点回答';
  let e1 = CS.save({
    itemID: 101,
    history: [{ role: 'user', content: userText }, { role: 'assistant', content: '答1' }],
    chips: [101, '101', 0, 'x', 202],
  });
  ok(!!e1, 'save 返回条目');
  ok(/^cs-/.test(e1.id), 'id 缺省生成 cs- 前缀', e1.id);
  eq(e1.itemID, 101, 'itemID 规范化');
  eq(e1.count, 2, 'count = 消息数');
  eq(e1.title, userText, 'title 缺省取首条 user 消息（未超 30 字不加省略号）');
  ok(Array.isArray(e1.chips) && e1.chips.length === 2, 'chips 去重 + 丢弃非法值', e1.chips);
  eq(e1.chips[0], 101, 'chips 保留 101');
  eq(e1.chips[1], 202, 'chips 保留 202');
  ok(typeof e1.ts === 'number' && e1.ts > 0, 'ts 为时间戳');
  eq(CS.list().length, 1, '落盘一条');
  const summary = CS.list()[0];
  eq(summary.id, e1.id, 'list 返回 id');
  eq(summary.count, 2, 'list 返回 count');
  ok(!('history' in summary), 'list 摘要不含 history 全文');

  // 第二条（不同条目）→ 最新在前
  const e2 = CS.save({ itemID: 202, history: [{ role: 'user', content: '第二个问题' }] });
  eq(CS.list().length, 2, '两条会话');
  eq(CS.list()[0].id, e2.id, '最新一条在最前');
  eq(CS.latest().id, e2.id, 'latest 返回最新');
  eq(CS.latestForItem(101).id, e1.id, 'latestForItem 返回同条目最近一条');
  eq(CS.latestForItem('101').id, e1.id, 'latestForItem 接受字符串 itemID');
  eq(CS.latestForItem(999), null, 'latestForItem 无匹配 → null');
  eq(CS.latestForItem(null), null, 'latestForItem 无效 id → null');
  eq(CS.list(1).length, 1, 'list(limit) 生效');
  eq(CS.list(0).length, 0, 'list(0) → []');

  // load 完整条目
  const loaded = CS.load(e1.id);
  ok(!!loaded, 'load 命中');
  eq(loaded.history.length, 2, 'load 带 history 全文');
  eq(loaded.history[0].content, userText, 'load 内容完整');
  eq(CS.load(e1.id.slice(0, 4)), null, 'load 只认完整 id（不做前缀匹配）');

  // 同 id 覆盖并移到最前
  const before = CS.list().length;
  const e1b = CS.save({ id: e1.id, itemID: 101, history: [msg(1), msg(2), msg(3)] });
  eq(CS.list().length, before, '同 id 覆盖不新增');
  eq(CS.list()[0].id, e1.id, '覆盖后移到最前');
  eq(e1b.count, 3, '覆盖后 count 更新');
  eq(CS.load(e1.id).history.length, 3, '覆盖后内容更新');
  // 用空 history 覆盖同一 id → 跳过，原条目仍在
  eq(CS.save({ id: e1.id, itemID: 101, history: [] }), null, '空 history 覆盖请求被跳过');
  eq(CS.load(e1.id).history.length, 3, '原条目未被空历史破坏');

  // 40 条截断（保留最近 40 条）
  const longHistory = [];
  for (let i = 0; i < 50; i++) longHistory.push(msg(i));
  const eLong = CS.save({ id: 'long', itemID: 101, history: longHistory });
  eq(eLong.count, 40, '长会话只留 40 条');
  eq(eLong.history[0].content, 'm10', '截断保留最近 40 条（丢掉最早 10 条）');
  eq(eLong.history[39].content, 'm49', '最后一条保留');
  CS.remove('long');

  // 标题截断（30 字 + …）
  const forty = 'abcdefghijklmnopqrstuvwxyz0123456789ABCD';
  const eTitle = CS.save({ id: 'title', itemID: 101, history: [{ role: 'user', content: forty }] });
  eq(eTitle.title.length, CS.TITLE_MAX + 1, '超长标题 = 30 字 + 省略号');
  eq(eTitle.title.slice(0, CS.TITLE_MAX), forty.slice(0, CS.TITLE_MAX), '标题前 30 字一致');
  ok(eTitle.title.slice(-1) === '…', '标题以省略号结尾');
  // 短标题不加省略号；换行压平
  const eShort = CS.save({ id: 'short', itemID: 101, history: [{ role: 'user', content: '  第一行\n第二行  ' }] });
  eq(eShort.title, '第一行 第二行', '短标题压平换行且不加省略号');
  CS.remove('title'); CS.remove('short');

  // 坏 JSON / 坏条目容错
  store.set(PREF('chatSessions'), '{not-json');
  eq(CS.list().length, 0, '坏 JSON → list []');
  eq(CS.latest(), null, '坏 JSON → latest null');
  eq(CS.load(e1.id), null, '坏 JSON → load null');
  eq(CS.latestForItem(101), null, '坏 JSON → latestForItem null');
  eq(CS.remove(e1.id), false, '坏 JSON → remove false（不抛）');
  store.set(PREF('chatSessions'), JSON.stringify({ not: 'array' }));
  eq(CS.list().length, 0, '非数组 JSON → list []');
  store.set(PREF('chatSessions'), JSON.stringify([
    null, 42, { id: 'bad-no-history' }, { id: 'bad-empty', history: [] },
    { id: 'ok', itemID: 101, title: 'ok', history: [{ role: 'user', content: 'hi' }] },
  ]));
  eq(CS.list().length, 1, '坏条目被过滤只剩健康条目');
  eq(CS.list()[0].id, 'ok', '健康条目可读');
  eq(CS.latest().id, 'ok', 'latest 跳过坏条目');
  eq(CS.load('bad-no-history'), null, '坏条目 load → null');
  eq(CS.load('bad-empty'), null, '空 history 条目 load → null');

  // 50 条 LRU 上限
  resetSessions();
  for (let i = 1; i <= 55; i++) {
    CS.save({ id: 's' + i, itemID: 101, history: [{ role: 'user', content: 'q' + i }] });
  }
  const lru = CS.list();
  eq(lru.length, 50, 'LRU 上限 50 条');
  eq(lru[0].id, 's55', '最新一条保留在最前');
  eq(lru[49].id, 's6', '最旧的 5 条被裁掉（s1-s5）');
  eq(CS.load('s1'), null, '被裁条目不可读');
  eq(rawSessions().length, 50, 'pref 里也只存 50 条');
  eq(CS.remove('s55'), true, 'remove 命中返回 true');
  eq(CS.load('s55'), null, 'remove 后 load → null');

  /* ==================== ② AIClient opts.model ==================== */

  httpLog.length = 0;
  const c1 = await AI.chat([{ role: 'user', content: 'hi' }]);
  eq(c1, 'http-ok', 'chat：返回助手文本');
  eq(httpLog.length, 1, 'chat：发了一次 HTTP');
  eq(httpLog[0].payload.model, 'main-model', 'chat：不传 opts 用 cfg.model');
  eq(httpLog[0].url, 'https://example.test/v1/chat/completions', 'chat：endpoint 正确');
  eq(httpLog[0].headers.Authorization, 'Bearer test-key', 'chat：鉴权头正确');

  httpLog.length = 0;
  await AI.chat([{ role: 'user', content: 'hi' }], { model: 'decision-x' });
  eq(httpLog[0].payload.model, 'decision-x', 'chat：opts.model 覆盖生效');

  httpLog.length = 0;
  await AI.chat([{ role: 'user', content: 'hi' }], { model: '' });
  eq(httpLog[0].payload.model, 'main-model', 'chat：空 opts.model 回退 cfg.model');

  httpLog.length = 0;
  await AI.chat([{ role: 'user', content: 'hi' }], { other: 1 });
  eq(httpLog[0].payload.model, 'main-model', 'chat：opts 无 model 不影响行为');

  // chatStream（fetch 返回 JSON → 走降级一次性读取路径）
  fetchLog.length = 0;
  const s1 = AI.chatStream([{ role: 'user', content: 'hi' }], () => {});
  const s1r = await s1.promise;
  eq(s1r, 'stream-ok', 'chatStream：返回完整回复');
  eq(fetchLog.length, 1, 'chatStream：走了一次 fetch');
  eq(fetchLog[0].payload.model, 'main-model', 'chatStream：不传 opts 用 cfg.model');
  eq(fetchLog[0].payload.stream, true, 'chatStream：payload.stream 仍为 true');

  fetchLog.length = 0;
  const s2 = AI.chatStream([{ role: 'user', content: 'hi' }], () => {}, { model: 'decision-y' });
  await s2.promise;
  eq(fetchLog[0].payload.model, 'decision-y', 'chatStream：opts.model 覆盖生效');

  // 两参调用兼容（旧调用方）
  fetchLog.length = 0;
  await AI.chatStream([{ role: 'user', content: 'hi' }], () => {}).promise;
  eq(fetchLog[0].payload.model, 'main-model', 'chatStream 两参调用继续工作');

  // fetch 不可用 → 降级到 chat(messages, opts)，model 覆盖仍生效
  const savedFetch = sandbox.fetch;
  sandbox.fetch = undefined;
  httpLog.length = 0;
  const s3 = AI.chatStream([{ role: 'user', content: 'hi' }], () => {}, { model: 'decision-z' });
  const s3r = await s3.promise;
  eq(s3r, 'http-ok', 'chatStream 降级：返回 HTTP 结果');
  eq(httpLog[0].payload.model, 'decision-z', 'chatStream 降级：opts.model 仍覆盖');
  eq(httpLog[0].payload.stream, undefined, 'chatStream 降级：走非流式 chat（无 stream 字段）');
  sandbox.fetch = savedFetch;

  /* ==================== ③ ChatFloat 接线 ==================== */

  ok(typeof CF._distillLastTask === 'function', 'ChatFloat._distillLastTask 存在');
  ok(typeof CF._saveSession === 'function', 'ChatFloat._saveSession 存在');
  ok(typeof CF._restoreSession === 'function', 'ChatFloat._restoreSession 存在');
  ok(typeof CF._clearHistory === 'function', 'ChatFloat._clearHistory 存在');
  ok(typeof CF._decisionModel === 'function', 'ChatFloat._decisionModel 存在');

  // 决策模型读取
  store.set(PREF('aiAgentDecisionModel'), '  glm-fast  ');
  eq(CF._decisionModel(), 'glm-fast', '_decisionModel 读取并 trim');
  store.set(PREF('aiAgentDecisionModel'), '   ');
  eq(CF._decisionModel(), '', '_decisionModel 空白 → 不路由');
  store.delete(PREF('aiAgentDecisionModel'));
  eq(CF._decisionModel(), '', '_decisionModel 缺省 → 不路由');

  // _distillLastTask：无问答
  const bubbles = [];
  CF._appendBubble = (entry, role, text) => { bubbles.push({ role, text }); return {}; };
  CF.session.history = [];
  eq(CF._distillLastTask({}), null, '无问答 → 沉淀返回 null');
  has(bubbles[bubbles.length - 1].text, '还没有可沉淀的问答', '无问答给系统气泡提示');

  // _distillLastTask：正常沉淀
  const upserts = [];
  let tagStubList = [];
  sandbox.CommandTags = {
    _PALETTE: ['#111111', '#222222'],
    all: () => tagStubList,
    upsert(t) { upserts.push(t); tagStubList = tagStubList.concat([t]); return t; },
  };
  const longQ = '请总结这篇论文的核心贡献，并给出三点局限';
  CF.session.history = [
    { role: 'user', content: '更早的问题' },
    { role: 'assistant', content: '更早的回答' },
    { role: 'user', content: longQ },
    { role: 'assistant', content: '最新回答' },
  ];
  const tag1 = CF._distillLastTask({});
  ok(!!tag1, '正常沉淀返回标签');
  eq(upserts.length, 1, 'CommandTags.upsert 被调用一次');
  eq(upserts[0].prompt, longQ, 'prompt = 最后一条 user 消息');
  eq(upserts[0].label, longQ.slice(0, 14) + '…', 'label = 前 14 字 + …');
  ok(/^pf:/.test(upserts[0].id), 'id 以 pf: 开头', upserts[0].id);
  eq(upserts[0].color, '#111111', 'color 取调色板轮转（首条）');
  eq(upserts[0].trigger, '', 'trigger 为空');
  has(bubbles[bubbles.length - 1].text, '✓ 已沉淀为命令标签', '沉淀成功给系统气泡');
  has(bubbles[bubbles.length - 1].text, upserts[0].label, '气泡带标签名');
  has(bubbles[bubbles.length - 1].text, '长按标签可编辑或删除', '气泡说明长按编辑');

  // 重名 → 追加「 2」
  const tag2 = CF._distillLastTask({});
  eq(upserts.length, 2, '第二次沉淀再次 upsert');
  eq(upserts[1].label, upserts[0].label + ' 2', '重名标签追加「 2」');
  eq(upserts[1].color, '#222222', 'color 轮转到第二个颜色');
  eq(tag2.label, upserts[1].label, '返回标签 label 与 upsert 一致');

  // 短 prompt 不补省略号
  CF.session.history = [{ role: 'user', content: '短问题' }];
  CF._distillLastTask({});
  eq(upserts[2].label, '短问题', '短 prompt 不补省略号');

  // CommandTags 不可用 → 安全失败
  sandbox.CommandTags = undefined;
  const nBefore = bubbles.length;
  eq(CF._distillLastTask({}), null, 'CommandTags 不可用 → 返回 null');
  ok(bubbles.length === nBefore + 1, 'CommandTags 不可用给系统气泡');
  has(bubbles[bubbles.length - 1].text, '无法沉淀', 'CommandTags 不可用文案');

  // _saveSession：成功轮次后落盘（用真实 _chipItems，contextItems 为空）
  resetSessions();
  CF.session.item = itemA;
  CF.session.contextItems = [];
  CF.session.history = [{ role: 'user', content: '浮窗问题' }, { role: 'assistant', content: '浮窗回答' }];
  const savedRec = CF._saveSession();
  ok(!!savedRec, '_saveSession 返回保存条目');
  eq(savedRec.itemID, 101, '_saveSession 记录 itemID');
  eq(savedRec.count, 2, '_saveSession 记录消息数');
  eq(CS.latestForItem(101).id, savedRec.id, '_saveSession 已写入 ChatSessions');
  eq(savedRec.chips.length, 0, '无 chip 时 chips 为空');

  // _saveSession：空历史不落盘
  resetSessions();
  CF.session.history = [];
  eq(CF._saveSession(), null, '空历史 _saveSession → null');
  eq(CS.list().length, 0, '空历史没有落盘');

  // _restoreSession：同条目优先，恢复 history + chips
  resetSessions();
  CS.save({
    id: 'restore-1', itemID: 101,
    history: [{ role: 'user', content: '恢复的问题' }, { role: 'assistant', content: '恢复的回答' }],
    chips: [101, 999], // 999 不存在 → 恢复时丢弃
  });
  CF.session.item = itemA;
  CF.session.history = [];
  CF.session.contextItems = [];
  eq(CF._restoreSession(null), true, '_restoreSession 恢复成功');
  eq(CF.session.history.length, 2, '恢复 history');
  eq(CF.session.history[0].content, '恢复的问题', '恢复内容正确');
  eq(CF.session.contextItems.length, 1, '失效 chip 被丢弃');
  eq(CF.session.contextItems[0], 101, '有效 chip 恢复');

  // 已有内存历史 → 不覆盖
  CF.session.history = [{ role: 'user', content: '内存里的' }];
  eq(CF._restoreSession(null), false, '已有内存历史 → 不自动恢复');
  eq(CF.session.history[0].content, '内存里的', '内存历史未被覆盖');

  // 已有 chip → 不自动恢复
  CF.session.history = [];
  CF.session.contextItems = [101];
  eq(CF._restoreSession(null), false, '已有上下文 chip → 不自动恢复');
  CF.session.contextItems = [];

  // _clearHistory：清内存 + 删存档（不留空壳）
  resetSessions();
  CF.session.item = itemA;
  CF.session.history = [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }];
  CF.session.inputHistory = ['q'];
  CF.session.histIdx = 0;
  const rec = CF._saveSession();
  ok(!!rec && CS.list().length === 1, '清空前有一条存档');
  CF._clearHistory(null);
  eq(CF.session.history.length, 0, '_clearHistory 清空内存历史');
  eq(CF.session.inputHistory.length, 0, '_clearHistory 清空输入历史');
  eq(CF.session.histIdx, -1, '_clearHistory 重置输入索引');
  eq(CS.list().length, 0, '_clearHistory 同时删除存档（不留空会话）');

  // 同一对话多份快照（每轮成功问答都会 save）→ 按条目全部清掉，旧快照不复活
  resetSessions();
  CF.session.item = itemA;
  for (let i = 0; i < 3; i++) {
    CF.session.history = [{ role: 'user', content: 'q' + i }, { role: 'assistant', content: 'a' + i }];
    CF._saveSession();
  }
  CS.save({ id: 'other-item', itemID: 202, history: [{ role: 'user', content: 'other' }] });
  eq(CS.list().length, 4, '多份快照 + 其他条目存档');
  CF._clearHistory(null);
  eq(CS.list().length, 1, '清空按条目清掉全部快照');
  eq(CS.list()[0].id, 'other-item', '其他条目的存档不受影响');

  // 斜杠命令清单包含新命令
  const cmds = CF._slashCommands({ refs: {}, win: {} });
  const ids = cmds.map((c) => c.id);
  ok(ids.indexOf('history') >= 0, '/history 已注册');
  ok(ids.indexOf('sessions') >= 0, '/sessions 已注册');
  ok(ids.indexOf('distill') >= 0, '/distill 已注册');
  ok(ids.indexOf('clear') >= 0, '/clear 仍在');
  const clearCmd = cmds.find((c) => c.id === 'clear');
  eq(typeof clearCmd.run, 'function', '/clear run 可执行');

  /* ---------------- 汇总 ---------------- */

  console.log(`\nchat-sessions: ${pass} passed, ${fails.length} failed`);
  if (fails.length) {
    for (const f of fails) console.log('  ✗ ' + f);
    process.exit(1);
  }
  console.log('ALL OK');
})().catch((e) => { console.error(e); process.exit(1); });
