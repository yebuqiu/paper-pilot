#!/usr/bin/env node
/* Agent 工具层（AgentTools，0.48.0）测试 —— 交互设计参考 Hermes Agent
 *
 * 覆盖：
 *   ① 工具白名单 enabledIds/enabledTools（CSV 过滤 / 幽灵 id 剔除 / 空回退默认）；
 *   ② 协议提示词 protocolPrompt / augmentMessages（system 合并 / zh-en）；
 *   ③ 调用提取 extractCall（单行 / 多行 pretty / 围栏 / 坏 JSON / args 非对象）；
 *   ④ 推理循环 runAgentLoop（依赖注入：两轮工具后收敛 / 无工具直答 /
 *      轮数用尽 limited / 工具异常回喂 / onStep 回调 / 结果截断标记）；
 *   ⑤ execTool 白名单拒绝 + 写确认（协作模式拒绝 / 自主模式放行）；
 *   ⑥ _searchItems 关键词过滤（标题/作者/年份，上限截断）；
 *   ⑦ AIChat.windowHistory 历史滑窗（轮数可配 / assistant 断头丢弃 / 边界钳制）；
 *   ⑧ AIClient._sampleParams 采样参数（top_p 空=不传 / 钳制 / 温度钳制）。
 *
 * 运行：node test/agent-tools.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FILES = [
  'chrome/content/scripts/ai/agent-tools.js',
  'chrome/content/scripts/ai/chat.js',
  'chrome/content/scripts/ai/client.js',
];

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  <- ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

/* ---------------- 桩环境 ---------------- */

const PrefStore = new Map();
const Prefs = {
  get(k, d) { return PrefStore.has(k) ? PrefStore.get(k) : d; },
  set(k, v) { PrefStore.set(k, v); },
};

// 可编程确认框：confirmReturn 控制返回值，confirmCalls 记录调用
const confirmState = { returns: true, calls: [] };

function makeItem(id, fields) {
  return {
    id,
    _fields: fields,
    isRegularItem: () => true,
    getField(f) { return this._fields[f] || ''; },
    getCreators() { return this._fields._creators || []; },
    getDisplayTitle() { return this._fields.title || ''; },
    getTags() { return (this._fields._tags || []).map((t) => ({ tag: t })); },
    addTag(t) { (this._fields._tags = this._fields._tags || []).push(t); },
    async saveTx() { this._fields._saved = true; },
  };
}

const LIB = [
  makeItem(101, { title: 'Attention Is All You Need', date: '2017-06',
    _creators: [{ firstName: 'Ashish', lastName: 'Vaswani' }], publicationTitle: 'NeurIPS' }),
  makeItem(102, { title: 'BERT: Pre-training of Deep Bidirectional Transformers', date: '2018-10',
    _creators: [{ firstName: 'Jacob', lastName: 'Devlin' }] }),
  makeItem(103, { title: '图神经网络综述', date: '2020-01', _creators: [{ firstName: '小明', lastName: '王' }] }),
];

const notesCreated = [];
const Zotero = {
  Prefs,
  logError() {},
  getMainWindow() { return { __win: true }; },
  Libraries: { userLibraryID: 1 },
  Items: {
    get(id) { return LIB.find((i) => i.id === Number(id)) || null; },
    getAll: async () => LIB.slice(),
  },
  Collections: {
    getAll: async () => [
      { id: 1, name: '深度学习', parentID: 0 },
      { id: 2, name: ' Transformer ', parentID: 1 },
    ],
  },
};
const Services = {
  prompt: {
    confirm(win, title, text) {
      confirmState.calls.push({ title, text });
      return confirmState.returns;
    },
  },
};
const I18n = { isZh: true };
const AIChatStub = {}; // chat.js 会真实载入，此桩仅占位（同名 var 后者覆盖前者）
const Notes = {
  createFromMarkdown: async (item, title, md) => { notesCreated.push({ item, title, md }); },
};

const sandbox = {
  console, Zotero, Services, Prefs, I18n, Notes,
  AIChat: AIChatStub, Prompts: { all: () => [] },
  AIClient: {}, TranslateSvc: undefined, TranslateX: undefined,
  JSON, Date, Math, Promise, isFinite, parseInt, String, Number, Array, Set, Map,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of FILES) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
}
const AT = sandbox.AgentTools;
const AIChat = sandbox.AIChat;   // chat.js 载入后覆盖占位桩
const AIClient = sandbox.AIClient;

(async function main() {

/* ---------------- ① 工具白名单 ---------------- */

  // 默认全量
  eq(AT.enabledTools().length, 6, '默认：6 个工具全启用');
  ok(AT.enabledIds().has('add_note'), '默认白名单含写工具 add_note');

  // CSV 过滤 + 幽灵 id 剔除
  PrefStore.set('aiAgentTools', 'search_library,read_item_fulltext,ghost_tool');
  eq(AT.enabledTools().length, 2, 'CSV 过滤：幽灵 id 被剔除，剩 2');
  eq(AT.enabledTools().map((t) => t.id).join(','), 'search_library,read_item_fulltext',
    '过滤后只剩白名单内且注册表内的工具');

  // 全部禁用（空集）→ 回退默认全量（防把自己锁死）
  PrefStore.set('aiAgentTools', 'ghost_only');
  eq(AT.enabledTools().length, 6, '白名单全幽灵 → 回退默认全量');

  PrefStore.delete('aiAgentTools');

  /* ---------------- ② 协议提示词 ---------------- */

  const proto = AT.protocolPrompt();
  ok(proto.indexOf('"tool"') >= 0, '协议含 JSON 调用格式');
  ok(proto.indexOf('search_library') >= 0 && proto.indexOf('add_tags') >= 0,
    '协议列出读/写工具');
  ok(proto.indexOf('先简述计划') >= 0, '协议含任务规划指令（Hermes 式先规划后执行）');
  ok(proto.indexOf('不要编造') >= 0, '协议含反编造纪律');

  PrefStore.set('aiAgentTools', 'search_library');
  ok(AT.protocolPrompt().indexOf('add_note') < 0, '禁用的工具不出现在协议里');
  PrefStore.delete('aiAgentTools');

  // augmentMessages：合并进既有 system；无 system 时插最前
  const base = [{ role: 'system', content: 'BASE' }, { role: 'user', content: 'Q' }];
  const aug = AT.augmentMessages(base);
  eq(aug[0].role, 'system', 'augment 后首条仍是 system');
  ok(aug[0].content.indexOf('BASE') === 0 && aug[0].content.indexOf('"tool"') > 0,
    '协议合并进既有 system（原内容在前）');
  eq(base[0].content, 'BASE', 'augment 不修改入参数组（纯函数）');
  const noSys = AT.augmentMessages([{ role: 'user', content: 'Q' }]);
  eq(noSys[0].role, 'system', '无 system 时协议插到最前');

  /* ---------------- ③ 调用提取 extractCall ---------------- */

  const c1 = AT.extractCall('好的，我先检索：\n{"tool": "search_library", "args": {"query": "transformer"}}');
  ok(c1 && c1.tool === 'search_library' && c1.args.query === 'transformer',
    '提取：单行 JSON');

  const c2 = AT.extractCall('计划：\n1. 先检索\n{\n  "tool": "get_item_details",\n  "args": {\n    "item_id": 101\n  }\n}');
  ok(c2 && c2.tool === 'get_item_details' && c2.args.item_id === 101,
    '提取：多行 pretty-print JSON');

  const c3 = AT.extractCall('```json\n{"tool": "list_collections", "args": {}}\n```');
  ok(c3 && c3.tool === 'list_collections', '提取：代码围栏内 JSON');

  eq(AT.extractCall('这个问题不需要工具，直接回答。'), null, '无调用 → null');
  eq(AT.extractCall('{"tool": "broken", "args": '), null, '坏 JSON（不闭合）→ null');
  const c4 = AT.extractCall('{"tool": "search_library", "args": "不是对象"}');
  ok(c4 && c4.args && typeof c4.args === 'object', 'args 非对象 → 回退空对象');
  eq(AT.extractCall('谈论 "tool" 这个词但不是 JSON'), null, '含 tool 字样但非 JSON → null');

  /* ---------------- ④ 推理循环 runAgentLoop ---------------- */

  await (async () => {
    // 两轮工具调用后收敛
    const script = [
      '计划：\n1. 检索\n2. 总结\n{"tool": "search_library", "args": {"query": "bert"}}',
      '{"tool": "get_item_details", "args": {"item_id": 101}}',
      '这是最终回答：BERT 是双向编码器。',
    ];
    let i = 0;
    const seenMessages = [];
    const toolCalls = [];
    const steps = [];
    const r = await AT.runAgentLoop({
      messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'Q' }],
      maxSteps: 5,
      callLLM: async (msgs) => { seenMessages.push(msgs.map((m) => m.role).join(',')); return script[i++]; },
      runTool: async (id, args) => { toolCalls.push([id, args]); return 'TOOL-RESULT-' + id; },
      onStep: (s) => steps.push(s.tool),
    });
    eq(r.answer, '这是最终回答：BERT 是双向编码器。', '循环：最终回答原样返回');
    ok(r.done && !r.limited, '循环：正常收敛 done=true');
    eq(toolCalls.length, 2, '循环：两次工具调用');
    eq(steps.join(','), 'search_library,get_item_details', 'onStep 每步回调');
    // 第 3 轮消息 = 初始 2 条 + 2 轮（assistant + 工具结果）= 6 条
    eq(seenMessages[2].split(',').length, 6, '工具结果以 user 消息回填（第 3 轮 6 条消息）');
    ok(seenMessages.length === 3, '共 3 次 LLM 调用');

    // 无工具调用直接回答
    const r2 = await AT.runAgentLoop({
      messages: [{ role: 'user', content: 'Q' }],
      callLLM: async () => '直接回答',
      runTool: async () => { throw new Error('不应执行'); },
    });
    eq(r2.answer, '直接回答', '无工具调用：直答');
    ok(r2.done && r2.steps.length === 0, '无工具调用：steps 空');

    // 轮数用尽：limited
    let j = 0;
    const r3 = await AT.runAgentLoop({
      messages: [{ role: 'user', content: 'Q' }],
      maxSteps: 2,
      callLLM: async (msgs) => {
        j++;
        const last = msgs[msgs.length - 1];
        if (j <= 2) return '{"tool": "list_collections", "args": {}}';
        ok(last.role === 'user' && last.content.indexOf('上限') >= 0,
          '收敛轮收到「上限」提示消息');
        return '收敛回答';
      },
      runTool: async () => 'ok',
    });
    eq(r3.answer, '收敛回答', '轮数用尽：收敛轮回答');
    ok(r3.done && r3.limited === false, '收敛成功 done=true（模型服从收敛指令）');
    eq(r3.steps.length, 2, '轮数用尽：正好 2 次工具调用');

    // 模型执意继续调工具（收敛轮仍输出 JSON）→ limited 标记
    let k = 0;
    const r4 = await AT.runAgentLoop({
      messages: [{ role: 'user', content: 'Q' }],
      maxSteps: 1,
      callLLM: async () => { k++; return '{"tool": "list_collections", "args": {}}'; },
      runTool: async () => 'ok',
    });
    ok(!r4.done && r4.limited, '收敛轮仍想调工具：done=false limited=true');
    eq(k, 2, '收敛轮仍发起第二次 LLM 调用');

    // LLM 异常 → 向上抛（runAgentLoop 不吞网络/流式错误，abort 语义保持）
    let threw = null;
    try {
      await AT.runAgentLoop({
        messages: [{ role: 'user', content: 'Q' }],
        callLLM: async () => { throw new Error('LLM 挂了'); },
        runTool: async () => 'ok',
      });
    } catch (e) { threw = e; }
    ok(threw && threw.message === 'LLM 挂了', 'LLM 异常向上抛（runAgentLoop 不吞）');
  })().catch((e) => { ok(false, 'runAgentLoop 异常路径意外抛错: ' + e.message); });

  // 工具抛错 → 结果回喂「工具执行失败」
  await (async () => {
    let first = true;
    const r = await AT.runAgentLoop({
      messages: [{ role: 'user', content: 'Q' }],
      callLLM: async () => first ? (first = false, '{"tool": "boom", "args": {}}') : '最终回答',
      runTool: async () => { throw new Error('爆炸'); },
    });
    eq(r.answer, '最终回答', '工具异常后仍能收敛');
    ok(r.steps[0].result.indexOf('工具执行失败') >= 0 && r.steps[0].result.indexOf('爆炸') >= 0,
      '工具异常转结果文本回喂');
  })().catch((e) => { ok(false, '工具异常路径意外抛错: ' + e.message); });

  /* ---------------- ⑤ execTool：白名单 + 写确认 ---------------- */

  eq(await AT.execTool('no_such_tool', {}, {}),
    '未知工具：no_such_tool（请检查工具名拼写）', '未知工具返回说明文本');

  PrefStore.set('aiAgentTools', 'search_library');
  eq(await AT.execTool('add_tags', { item_id: 101, tags: 'A,B' }, {}),
    '工具 add_tags 已被用户禁用。请基于对话继续。', '禁用工具返回说明文本');
  PrefStore.delete('aiAgentTools');

  // 协作模式：用户拒绝 → 写不落库
  PrefStore.set('aiAgentConfirmWrite', true);
  confirmState.returns = false;
  confirmState.calls.length = 0;
  const denied = await AT.execTool('add_tags', { item_id: 101, tags: 'A, B' }, {});
  ok(denied.indexOf('用户拒绝') >= 0, '协作模式拒绝：返回拒绝说明');
  eq(confirmState.calls.length, 1, '拒绝前确实弹过一次确认');
  eq((LIB[0]._fields._tags || []).length, 0, '拒绝时未写任何标签');

  // 协作模式：用户允许 → 写入
  confirmState.returns = true;
  const allowed = await AT.execTool('add_tags', { item_id: 101, tags: '方法/对比学习' }, {});
  ok(allowed.indexOf('✓') >= 0, '协作模式允许：返回成功说明');
  eq(LIB[0]._fields._tags.join(','), '方法/对比学习', '标签真实写入条目');
  ok(LIB[0]._fields._saved, '条目已 saveTx');

  // 自主模式（关确认）：不弹框直接写
  PrefStore.set('aiAgentConfirmWrite', false);
  confirmState.calls.length = 0;
  await AT.execTool('add_note', { item_id: 101, text: '# 笔记内容' }, {});
  eq(confirmState.calls.length, 0, '自主模式：不再弹确认');
  eq(notesCreated.length, 1, '自主模式：笔记真实创建');
  eq(notesCreated[0].md, '# 笔记内容', '笔记内容透传');
  PrefStore.delete('aiAgentConfirmWrite');

  // item_id 缺省回退 ctx.item
  const ctxItem = LIB[1];
  const viaCtx = await AT.execTool('add_tags', { tags: 'ctx' }, { item: ctxItem });
  ok(viaCtx.indexOf('✓') >= 0, 'item_id 缺省：回退 ctx.item');
  ok(ctxItem._fields._tags.indexOf('ctx') >= 0, 'ctx 条目被写入');

  /* ---------------- ⑥ _searchItems 关键词过滤 ---------------- */

  await (async () => {
    const byTitle = await AT._searchItems('attention', 8);
    eq(byTitle.length, 1, '标题子串命中（大小写不敏感）');
    eq(byTitle[0].id, 101, '命中正确条目');

    const byCreator = await AT._searchItems('devlin', 8);
    eq(byCreator.length, 1, '作者子串命中');

    const byYear = await AT._searchItems('2020', 8);
    eq(byYear.length, 1, '年份命中');

    const byZh = await AT._searchItems('神经网络', 8);
    eq(byZh.length, 1, '中文关键词命中');

    eq((await AT._searchItems('', 8)).length, 0, '空关键词返回空');

    // limit 截断
    const many = await AT._searchItems('e', 1);
    eq(many.length, 1, 'limit 生效（最多 1 条）');
  })().catch((e) => { ok(false, '_searchItems 异常: ' + e.message); });

  // search_library 端到端（真实 run，走 _searchItems + _itemLine）
  await (async () => {
    const out = await AT.execTool('search_library', { query: 'bert' }, {});
    ok(out.indexOf('[102]') >= 0 && out.indexOf('Bidirectional') >= 0,
      'search_library 输出含 [编号] + 标题（供后续工具引用）');
    const miss = await AT.execTool('search_library', { query: '不存在的词' }, {});
    ok(miss.indexOf('没有找到') >= 0, 'search_library 无命中给出可行动提示');
  })().catch((e) => { ok(false, 'search_library 异常: ' + e.message); });

  // list_collections：树形缩进 + 修剪空白
  await (async () => {
    const out = await AT.execTool('list_collections', {}, {});
    ok(out.indexOf('- 深度学习') >= 0, '分类树含顶级分类');
    ok(out.indexOf('- Transformer') >= 0, '分类树含子分类（名称已 trim）');
    ok(out.indexOf('  - Transformer') >= 0, '子分类有缩进');
  })().catch((e) => { ok(false, 'list_collections 异常: ' + e.message); });

  // get_item_details / read_item_fulltext（AIChat 桩：getFullText 返回固定文本）
  AIChat.getFullText = async (it) => it && it.id === 101 ? 'FULLTEXT-' + it.id : '';
  await (async () => {
    const d = await AT.execTool('get_item_details', { item_id: 101 }, {});
    ok(d.indexOf('编号：101') >= 0 && d.indexOf('Attention Is All You Need') >= 0,
      'get_item_details 输出题录');
    const f = await AT.execTool('read_item_fulltext', { item_id: 101 }, {});
    ok(f.indexOf('FULLTEXT-101') >= 0, 'read_item_fulltext 经 AIChat.getFullText');
    const viaCtx2 = await AT.execTool('read_item_fulltext', {}, { item: LIB[0] });
    ok(viaCtx2.indexOf('FULLTEXT-101') >= 0, 'read_item_fulltext：item_id 缺省回退 ctx.item');
  })().catch((e) => { ok(false, 'details/fulltext 异常: ' + e.message); });

  /* ---------------- ⑦ AIChat.windowHistory 历史滑窗 ---------------- */

  const mkHist = (n) => {
    const h = [];
    for (let i = 0; i < n; i++) {
      h.push({ role: 'user', content: 'u' + i });
      h.push({ role: 'assistant', content: 'a' + i });
    }
    return h;
  };
  eq(AIChat.windowHistory(mkHist(3), 6).length, 6, '历史不超窗：原样（6 条）');
  eq(AIChat.windowHistory(mkHist(10), 6).length, 12, '历史超窗：滑到 6 轮 = 12 条');
  eq(AIChat.windowHistory(mkHist(10), 6)[0].content, 'u4', '滑窗保留最近轮次（u4 起，10 轮取最后 6 轮）');
  eq(AIChat.windowHistory(mkHist(10), 2).map((m) => m.content).join(','),
    'u8,a8,u9,a9', '轮数=2：最近 2 轮（按对话顺序）');
  // assistant 断头（截断点落在 assistant）→ 丢弃首个半轮，保证 user 开头
  const oddHist = mkHist(5).concat([{ role: 'assistant', content: 'orphan' }]);
  const w = AIChat.windowHistory(oddHist, 2);
  eq(w[0].role, 'user', '断头 assistant 被丢弃，窗口以 user 开头');
  // 轮数边界钳制
  eq(AIChat.windowHistory(mkHist(3), 0).length, 2, 'rounds=0 → 钳制为 1 轮');
  eq(AIChat.windowHistory(mkHist(3), 999).length, 6, 'rounds=999 → 钳制为 30 轮上限（此处全量 6 条）');
  eq(AIChat.windowHistory('not-array', 6).length, 0, '非数组入参 → 空窗');

  /* ---------------- ⑧ AIClient._sampleParams 采样参数 ---------------- */

  PrefStore.set('aiTemperature', '0.3');
  PrefStore.set('aiMaxTokens', 4096);
  let p = AIClient._sampleParams();
  eq(p.temperature, 0.3, '温度透传');
  eq(p.max_tokens, 4096, 'max_tokens 透传');
  ok(!('top_p' in p), 'top_p 留空 = 不传该字段');

  PrefStore.set('aiTopP', '0.9');
  p = AIClient._sampleParams();
  eq(p.top_p, 0.9, 'top_p 设置后透传');
  PrefStore.set('aiTopP', '1.5');
  p = AIClient._sampleParams();
  eq(p.top_p, 1, 'top_p 超界钳制到 1');
  PrefStore.set('aiTopP', '-1');
  p = AIClient._sampleParams();
  eq(p.top_p, 0, 'top_p 负值钳制到 0');
  PrefStore.set('aiTemperature', '5');
  p = AIClient._sampleParams();
  eq(p.temperature, 2, '温度超界钳制到 2');
  PrefStore.delete('aiTopP');
  PrefStore.delete('aiTemperature');
  PrefStore.delete('aiMaxTokens');

  /* ---------------- 汇总 ---------------- */

  console.log(`\nagent-tools 测试：${pass} 通过，${fails.length} 失败`);
  if (fails.length) {
    fails.forEach((f) => console.log('  ✗ ' + f));
    process.exit(1);
  }
})().catch((e) => {
  console.error('测试运行异常：', e);
  process.exit(1);
});
