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
 *   ⑧ AIClient._sampleParams 采样参数（top_p 空=不传 / 钳制 / 温度钳制）；
 *   ⑨ 新工具（search_arxiv / get_citation_count / search_notes /
 *      move_to_collection / export_bibliography）与外部能力缺位降级；
 *   ⑩ 写操作审计 + 撤销（净新增标签 / 三种 undo / LRU 100 / 空审计 /
 *      ctx.skipConfirm 绕过确认）。
 *   ⑪ 长期记忆工具（memory_read 空态/清单/搜索；memory_write 确认 / skipConfirm /
 *      空文本 / 非法 kind；审计 removeMemory 与 undoLast 端到端撤销；模块缺位降级）。
 *
 * 运行：node test/agent-tools.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FILES = [
  'chrome/content/scripts/features/agent-memory.js',
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

// 笔记桩仓库（eraseTx 撤销用）
const noteStore = new Map();
let noteSeq = 900;

// 条目：标签/文集都是真实可变数组，便于断言行写结果与撤销
function makeItem(id, fields) {
  return {
    id,
    itemType: 'journalArticle',
    dateAdded: fields._dateAdded || '',
    _fields: fields,
    _collections: [],
    isRegularItem: () => true,
    getField(f) { return this._fields[f] || ''; },
    getCreators() { return this._fields._creators || []; },
    getDisplayTitle() { return this._fields.title || ''; },
    getTags() { return (this._fields._tags || []).map((t) => ({ tag: t })); },
    addTag(t) { (this._fields._tags = this._fields._tags || []).push(t); },
    removeTag(t) {
      if (this._removeTagThrows) throw new Error('removeTag 失败');
      this._fields._tags = (this._fields._tags || []).filter((x) => x !== t);
    },
    addToCollection(cid) { if (this._collections.indexOf(cid) < 0) this._collections.push(cid); },
    removeFromCollection(cid) { this._collections = this._collections.filter((x) => x !== cid); },
    async saveTx() { this._fields._saved = true; },
  };
}

const LIB = [
  makeItem(101, { title: 'Attention Is All You Need', date: '2017-06',
    DOI: '10.1000/xyz', _dateAdded: '2024-01-03',
    _creators: [{ firstName: 'Ashish', lastName: 'Vaswani' }], publicationTitle: 'NeurIPS' }),
  makeItem(102, { title: 'BERT: Pre-training of Deep Bidirectional Transformers', date: '2018-10',
    _dateAdded: '2024-01-02',
    _creators: [{ firstName: 'Jacob', lastName: 'Devlin' }] }),
  makeItem(103, { title: '图神经网络综述', date: '2020-01', _dateAdded: '2024-01-01',
    extra: 'DOI: 10.5555/abc.def.', _creators: [{ firstName: '小明', lastName: '王' }] }),
];

const notesCreated = [];
const Zotero = {
  Prefs,
  logError() {},
  getMainWindow() { return { __win: true }; },
  Libraries: { userLibraryID: 1 },
  Items: {
    get(id) {
      const n = Number(id);
      return LIB.find((i) => i.id === n) || noteStore.get(n) || null;
    },
    async getAsync(id) { return Zotero.Items.get(id); },
    // Zotero 10：idOnly 模式（第 4 参 true）返回 id 列表，其余返回条目对象
    getAll: async (libID, onlyTopLevel, includeDeleted, idOnly) => (
      idOnly ? LIB.map((i) => i.id).concat([...noteStore.keys()]) : LIB.slice()
    ),
  },
  Collections: {
    get(id) {
      const all = [
        { id: 1, name: '深度学习', parentID: 0 },
        { id: 2, name: ' Transformer ', parentID: 1 },
      ];
      return all.find((c) => c.id === Number(id)) || null;
    },
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
  createFromMarkdown: async (item, title, md) => {
    const note = {
      id: ++noteSeq,
      itemType: 'note',
      parentItemID: item && item.id,
      erased: false,
      isNote() { return true; },
      async eraseTx() { this.erased = true; noteStore.delete(this.id); },
    };
    noteStore.set(note.id, note);
    notesCreated.push({ item, title, md, note });
    return note;
  },
};

// 外部能力的可编程桩（普通函数，避免 this 丢失）
const arxivState = { calls: [], entries: [], error: null };
const ArxivFetchStub = {
  search(spec, opts) {
    arxivState.calls.push({ spec, opts });
    if (arxivState.error) return Promise.reject(new Error(arxivState.error));
    return Promise.resolve({ entries: arxivState.entries });
  },
};
const s2State = { calls: [], paper: null, error: null };
const S2ClientStub = {
  paperById(paperId, fields) {
    s2State.calls.push({ paperId, fields });
    if (s2State.error) return Promise.reject(new Error(s2State.error));
    return Promise.resolve(s2State.paper);
  },
};
const refState = { calls: [] };
const RefFormatStub = {
  exportAs(records, format) {
    refState.calls.push({ records, format });
    const r = (records && records[0]) || {};
    return '@' + (format === 'ris' ? 'ris' : 'article') + '{' + (r.authors && r.authors[0] ? r.authors[0].family : 'ref') + ',\n' +
      '  title = {' + (r.title || '') + '},\n' +
      '  year = {' + (r.year || '') + '}\n}';
  },
};

const sandbox = {
  console, Zotero, Services, Prefs, I18n, Notes,
  ArxivFetch: ArxivFetchStub, S2Client: S2ClientStub, RefFormat: RefFormatStub,
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

/** 把白名单设为注册表全量（新工具默认不在 DEFAULT_TOOLS 里） */
function enableAll() {
  PrefStore.set('aiAgentTools', AT.TOOLS.map((t) => t.id).join(','));
}

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
    ok(out.indexOf('（编号 1）') >= 0 && out.indexOf('（编号 2）') >= 0,
      '分类行尾附带编号（move_to_collection 的 collection_id 来源）');
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

  /* ---------------- ⑨ 新工具（external 桩 + 缺位降级） ---------------- */

  enableAll();

  // search_arxiv：格式化 / category 透传 / max 钳制 / 摘要截断
  await (async () => {
    arxivState.entries = [
      { arxivId: '2401.00001', title: 'Sparse   Autoencoders', published: '2024-01-02T00:00:00Z',
        summary: 'y'.repeat(300) },
      { arxivId: '2402.00002', title: 'Second Paper', published: '2024-02-03T00:00:00Z', summary: '短摘要' },
    ];
    arxivState.error = null;
    arxivState.calls.length = 0;
    const out = await AT.execTool('search_arxiv',
      { query: 'sparse autoencoder', category: 'cs.LG', max: 2 }, {});
    ok(out.indexOf('[1] Sparse Autoencoders（2024）') >= 0, 'search_arxiv：序号 + 标题 + 年份（空白已压缩）', out);
    ok(out.indexOf('arXiv:2401.00001') >= 0, 'search_arxiv：含 arXiv ID');
    ok(out.indexOf('y'.repeat(200)) >= 0 && out.indexOf('y'.repeat(201)) < 0,
      'search_arxiv：摘要截断到 200 字');
    eq(arxivState.calls[0].spec.keywords[0], 'sparse autoencoder', 'search_arxiv：关键词透传');
    eq(arxivState.calls[0].spec.categories[0], 'cs.LG', 'search_arxiv：category 透传');
    eq(arxivState.calls[0].opts.limit, 2, 'search_arxiv：max 透传为 limit');

    arxivState.calls.length = 0;
    await AT.execTool('search_arxiv', { query: 'x', max: 50 }, {});
    eq(arxivState.calls[0].opts.limit, 10, 'search_arxiv：max 上限钳制到 10');
    eq('categories' in arxivState.calls[0].spec, false, 'search_arxiv：无 category 时不传该条件');

    const emptyQ = await AT.execTool('search_arxiv', {}, {});
    ok(emptyQ.indexOf('请提供检索关键词') >= 0, 'search_arxiv：空关键词给可行动提示');

    arxivState.error = '请求超时';
    const failed = await AT.execTool('search_arxiv', { query: 'x' }, {});
    ok(failed.indexOf('arXiv 检索失败：请求超时') >= 0 && failed.indexOf('稍后再试') >= 0,
      'search_arxiv：失败不抛，返回原因 + 稍后再试', failed);
    arxivState.error = null;

    arxivState.entries = [];
    const none = await AT.execTool('search_arxiv', { query: 'zzz' }, {});
    ok(none.indexOf('没有找到') >= 0, 'search_arxiv：0 条结果给可行动提示');

    const saved = sandbox.ArxivFetch;
    delete sandbox.ArxivFetch;
    eq(await AT.execTool('search_arxiv', { query: 'x' }, {}), 'arXiv 工具包不可用',
      'search_arxiv：模块缺位降级为「工具包不可用」');
    sandbox.ArxivFetch = saved;
  })().catch((e) => { ok(false, 'search_arxiv 异常: ' + e.message); });

  // get_citation_count：DOI 提取（字段 / extra）/ 直接 doi / 未收录 / 异常
  await (async () => {
    s2State.paper = { citationCount: 42, title: 'Attention Is All You Need' };
    s2State.error = null;
    s2State.calls.length = 0;
    const out = await AT.execTool('get_citation_count', { item_id: 101 }, {});
    ok(out.indexOf('被引：42 次（Semantic Scholar）') === 0, 'get_citation_count：输出被引次数', out);
    ok(out.indexOf('Attention Is All You Need') > 0, 'get_citation_count：附带标题');
    eq(s2State.calls[0].paperId, 'DOI:10.1000/xyz', 'get_citation_count：item_id → DOI 字段');

    await AT.execTool('get_citation_count', { item_id: 103 }, {});
    eq(s2State.calls[1].paperId, 'DOI:10.5555/abc.def', 'get_citation_count：extra 字段 DOI 解析（剥尾部句点）');

    await AT.execTool('get_citation_count', { doi: 'https://doi.org/10.1/ABC' }, {});
    eq(s2State.calls[2].paperId, 'DOI:10.1/ABC', 'get_citation_count：直接 doi 归一（去 doi.org 前缀）');

    const noDoi = await AT.execTool('get_citation_count', { item_id: 102 }, {});
    ok(noDoi.indexOf('没有 DOI') >= 0 && noDoi.indexOf('doi 参数') >= 0,
      'get_citation_count：无 DOI 给明确说明');

    const badItem = await AT.execTool('get_citation_count', { item_id: 999 }, {});
    ok(badItem.indexOf('找不到该条目') >= 0, 'get_citation_count：无效 item_id 报错');

    s2State.paper = null;
    const notFound = await AT.execTool('get_citation_count', { doi: '10.9/none' }, {});
    ok(notFound.indexOf('未收录') >= 0, 'get_citation_count：S2 未收录给说明');

    s2State.error = '限流';
    const failed = await AT.execTool('get_citation_count', { doi: '10.9/x' }, {});
    ok(failed.indexOf('被引量查询失败：限流') >= 0, 'get_citation_count：异常不抛，返回原因');
    s2State.error = null;

    const saved = sandbox.S2Client;
    delete sandbox.S2Client;
    ok((await AT.execTool('get_citation_count', { doi: '10.9/x' }, {})).indexOf('不可用') >= 0,
      'get_citation_count：S2Client 缺位降级');
    sandbox.S2Client = saved;
  })().catch((e) => { ok(false, 'get_citation_count 异常: ' + e.message); });

  // search_notes：async getAll + HTML 去标签 + 大小写不敏感 + 所属条目
  await (async () => {
    noteStore.set(501, {
      id: 501, itemType: 'note', parentItemID: 101, isNote() { return true; },
      getNote() { return '<div><p>Hello <b>World</b> &amp; graph</p></div>'; },
    });
    noteStore.set(502, {
      id: 502, itemType: 'note', parentItemID: 0, isNote() { return true; },
      getNote() { return '<p>无关内容</p>'; },
    });

    const out = await AT.execTool('search_notes', { query: 'world' }, {});
    ok(out.indexOf('[1] Attention Is All You Need') >= 0, 'search_notes：显示所属条目标题');
    ok(out.indexOf('Hello World') >= 0 && out.indexOf('<b>') < 0 && out.indexOf('&amp;') < 0,
      'search_notes：去 HTML 标签并还原实体', out);
    eq(out.split('\n').length, 2, 'search_notes：非命中笔记不返回（仅 1 条命中）');

    const origGetAll = Zotero.Items.getAll;
    let gotArgs = null;
    Zotero.Items.getAll = function (lib, a, b, idOnly) {
      gotArgs = [lib, a, b, idOnly];
      return Promise.resolve([501]); // 异步返回 id 列表
    };
    const asyncOut = await AT.execTool('search_notes', { query: 'hello' }, {});
    ok(asyncOut.indexOf('Hello World') >= 0, 'search_notes：await 异步 getAll 的 id 列表');
    eq(gotArgs[0], 1, 'search_notes：按 userLibraryID 取全库');
    eq(gotArgs[3], true, 'search_notes：使用 idOnly 模式');
    Zotero.Items.getAll = origGetAll;

    const miss = await AT.execTool('search_notes', { query: '不存在的词' }, {});
    ok(miss.indexOf('没有在笔记正文中找到') >= 0 && miss.indexOf('search_library') >= 0,
      'search_notes：无命中给可行动提示');

    // getAll 忽略 idOnly 直接返回对象数组时也能命中（兼容性退路）
    Zotero.Items.getAll = function () { return Promise.resolve([noteStore.get(501)]); };
    const objOut = await AT.execTool('search_notes', { query: 'graph' }, {});
    ok(objOut.indexOf('Hello World') >= 0, 'search_notes：兼容 getAll 返回条目对象');
    Zotero.Items.getAll = origGetAll;

    eq((await AT.execTool('search_notes', {}, {})).indexOf('请提供检索关键词'), 0,
      'search_notes：空关键词提示');
  })().catch((e) => { ok(false, 'search_notes 异常: ' + e.message); });

  // move_to_collection：写入 + ctx 兜底 + 两类错误
  await (async () => {
    PrefStore.set('aiAgentConfirmWrite', true);
    confirmState.returns = true;
    confirmState.calls.length = 0;
    const out = await AT.execTool('move_to_collection', { item_id: 102, collection_id: 2 }, {});
    eq(out, '✓ 已把「BERT: Pre-training of Deep Bidirectional Transformers」加入文集「Transformer」',
      'move_to_collection：成功文案（标题 + 文集名）');
    eq(LIB[1]._collections.join(','), '2', 'move_to_collection：真实加入文集');
    eq(confirmState.calls.length, 1, 'move_to_collection：默认逐次确认');

    const viaCtx = await AT.execTool('move_to_collection', { collection_id: 1 }, { item: LIB[0] });
    ok(viaCtx.indexOf('✓') === 0, 'move_to_collection：item_id 缺省回退 ctx.item');
    eq(LIB[0]._collections.join(','), '1', 'ctx 条目被加入文集');

    const noItem = await AT.execTool('move_to_collection', { item_id: 999, collection_id: 1 }, {});
    ok(noItem.indexOf('找不到该条目') >= 0, 'move_to_collection：无效条目报错');
    const noCol = await AT.execTool('move_to_collection', { item_id: 101, collection_id: 99 }, {});
    ok(noCol.indexOf('找不到该文集') >= 0, 'move_to_collection：无效文集报错');
    const noCid = await AT.execTool('move_to_collection', { item_id: 101 }, {});
    ok(noCid.indexOf('请提供 collection_id') >= 0, 'move_to_collection：缺 collection_id 提示');
  })().catch((e) => { ok(false, 'move_to_collection 异常: ' + e.message); });

  // export_bibliography：RefFormat 调用 / 每条一行 / 样式降级 / 缺位
  await (async () => {
    PrefStore.set('aiAgentConfirmWrite', false);
    refState.calls.length = 0;
    const out = await AT.execTool('export_bibliography', {}, { item: LIB[0] });
    ok(out.indexOf('参考文献（BibTeX）') === 0, 'export_bibliography：默认 BibTeX', out);
    ok(out.indexOf('title = {Attention Is All You Need}') >= 0, 'export_bibliography：题录内容透传');
    eq(out.split('\n').length, 2, 'export_bibliography：每条文献一行（标题行 + 1 条）');
    eq(refState.calls[0].format, 'bibtex', 'export_bibliography：默认格式 bibtex');
    eq(refState.calls[0].records[0].authors[0].family, 'Vaswani', 'export_bibliography：作者映射');
    eq(refState.calls[0].records[0].year, '2017', 'export_bibliography：年份映射');

    refState.calls.length = 0;
    const multi = await AT.execTool('export_bibliography', { item_ids: [101, 102] }, {});
    eq(refState.calls.length, 2, 'export_bibliography：item_ids 每条各导出一次');
    eq(multi.split('\n').length, 3, 'export_bibliography：多条各占一行');

    refState.calls.length = 0;
    await AT.execTool('export_bibliography', { item_ids: [101, 102], limit: 1 }, {});
    eq(refState.calls.length, 1, 'export_bibliography：limit 截断条目数');

    refState.calls.length = 0;
    const apa = await AT.execTool('export_bibliography', { item_ids: [101], style: 'APA' }, {});
    ok(apa.indexOf('不支持 APA 样式') >= 0, 'export_bibliography：不支持的样式给出说明');
    eq(refState.calls[0].format, 'bibtex', 'export_bibliography：不支持时回落默认格式');

    refState.calls.length = 0;
    await AT.execTool('export_bibliography', { item_ids: [101], style: 'ris' }, {});
    eq(refState.calls[0].format, 'ris', 'export_bibliography：显式 ris 样式透传');

    const badIds = await AT.execTool('export_bibliography', { item_ids: [999] }, {});
    ok(badIds.indexOf('没有有效条目') >= 0, 'export_bibliography：item_ids 全无效报错');

    refState.calls.length = 0;
    await AT.execTool('export_bibliography', { limit: 2 }, {});
    eq(refState.calls[0].records[0].title, 'Attention Is All You Need',
      'export_bibliography：无 item_ids/ctx → 当前库最近条目（dateAdded 倒序）');

    const saved = sandbox.RefFormat;
    delete sandbox.RefFormat;
    ok((await AT.execTool('export_bibliography', { item_ids: [101] }, {})).indexOf('格式器不可用') >= 0,
      'export_bibliography：RefFormat 缺位降级');
    sandbox.RefFormat = saved;
    PrefStore.delete('aiAgentConfirmWrite');
  })().catch((e) => { ok(false, 'export_bibliography 异常: ' + e.message); });

  /* ---------------- ⑩ 写操作审计 + 撤销 ---------------- */

  await (async () => {
    PrefStore.delete('agentAuditLog');
    PrefStore.set('aiAgentConfirmWrite', false);
    LIB[0]._fields._tags = ['旧标签'];
    LIB[0]._removeTagThrows = false;

    // add_tags：只记净新增
    await AT.execTool('add_tags', { item_id: 101, tags: '旧标签,新标签1' }, {});
    let list = AT.auditList();
    eq(list.length, 1, '审计：add_tags 成功后记 1 条');
    eq(list[0].tool, 'add_tags', '审计：tool 字段');
    eq(list[0].undo.kind, 'removeTags', '审计：undo.kind = removeTags');
    eq(list[0].undo.itemID, 101, '审计：undo.itemID');
    eq(list[0].undo.tags.join(','), '新标签1', '审计：只记净新增标签（已存在的不记）');
    eq(String(list[0].id).indexOf(String(list[0].ts)), 0, '审计：id = 时间戳 + 序号');
    ok(list[0].summary.indexOf('来源：ui') >= 0, '审计：summary 记上下文来源');

    // 最新在前 + limit
    await AT.execTool('add_tags', { item_id: 102, tags: 'x' }, {});
    list = AT.auditList();
    eq(list.length, 2, '审计：第二条写入');
    ok(list[0].ts >= list[1].ts && list[0].undo.itemID === 102, '审计：最新在前');
    eq(AT.auditList(1).length, 1, '审计：auditList(limit) 生效');
    eq(AT.auditList(0).length, 0, '审计：auditList(0) 返回空');

    // undoLast removeTags 成功
    const u1 = await AT.undoLast();
    ok(u1.ok && u1.done.indexOf('已移除标签') === 0, 'undoLast:removeTags 成功返回 done', u1);
    ok((LIB[1]._fields._tags || []).indexOf('x') < 0, 'undoLast:removeTags 真移除标签');
    eq(AT.auditList().length, 1, 'undoLast：成功后从审计移除该条');

    // undoLast removeTags 失败 → 保留记录
    LIB[0]._removeTagThrows = true;
    const u2 = await AT.undoLast();
    ok(!u2.ok && u2.error.indexOf('撤销失败') >= 0, 'undoLast：失败返回 {ok:false,error}', u2);
    eq(AT.auditList().length, 1, 'undoLast：失败保留记录（可重试）');
    LIB[0]._removeTagThrows = false;
    const u3 = await AT.undoLast();
    ok(u3.ok, 'undoLast：恢复后重试成功');
    eq(AT.auditList().length, 0, 'undoLast：重试成功后清空');

    // add_note → eraseNote
    const notesBefore = notesCreated.length;
    await AT.execTool('add_note', { item_id: 101, text: '# 审计笔记' }, {});
    eq(notesCreated.length, notesBefore + 1, '审计：add_note 真实创建笔记');
    list = AT.auditList();
    eq(list[0].undo.kind, 'eraseNote', '审计：add_note 记 eraseNote');
    const nid = list[0].undo.noteID;
    ok(noteStore.has(nid), '审计：拿到新笔记 id');
    const u4 = await AT.undoLast();
    ok(u4.ok && u4.done.indexOf('已删除笔记') >= 0, 'undoLast:eraseNote 成功', u4);
    ok(!noteStore.has(nid), 'undoLast:eraseNote 真删除笔记');
    eq(AT.auditList().length, 0, 'undoLast:eraseNote 后审计清空');

    // 拿不到笔记 id → manual
    const origCreate = Notes.createFromMarkdown;
    Notes.createFromMarkdown = async function () { return null; };
    await AT.execTool('add_note', { item_id: 101, text: '# 无 id' }, {});
    eq(AT.auditList()[0].undo.kind, 'manual', '审计：note id 缺失 → manual 兜底');
    const manual = await AT.undoLast();
    ok(!manual.ok && manual.error.indexOf('手动删除') >= 0, 'undoLast:manual 返回人工提示');
    Notes.createFromMarkdown = origCreate;
    PrefStore.delete('agentAuditLog');

    // move_to_collection → removeFromCollection；undoEntry 按 id
    await AT.execTool('move_to_collection', { item_id: 102, collection_id: 1 }, {});
    await AT.execTool('add_tags', { item_id: 103, tags: 'k' }, {});
    list = AT.auditList();
    eq(list.length, 2, '审计：move_to_collection 也入账');
    eq(list[1].undo.kind, 'removeFromCollection', '审计：undo.kind = removeFromCollection');
    const u5 = await AT.undoEntry(list[1].id);
    ok(u5.ok && u5.done.indexOf('移出文集') >= 0, 'undoEntry：按 id 撤销成功', u5);
    ok(LIB[1]._collections.indexOf(1) < 0, 'undoEntry:removeFromCollection 真移除');
    eq(AT.auditList().length, 1, 'undoEntry：只删该条记录');
    const u6 = await AT.undoEntry('no-such-id');
    ok(!u6.ok && u6.error.indexOf('找不到该审计记录') >= 0, 'undoEntry：id 无效报错');
    await AT.undoLast(); // 清掉剩余 add_tags 记录

    // LRU 上限 100
    PrefStore.delete('agentAuditLog');
    for (let i = 0; i < 105; i++) {
      AT._recordAudit('t' + i, 's' + i, { kind: 'manual', hint: 'x' });
    }
    list = AT.auditList();
    eq(list.length, 100, '审计：LRU 上限 100');
    eq(list[0].tool, 't104', '审计：最新在前（保留最后 100 条）');
    eq(list[99].tool, 't5', '审计：最旧 5 条被挤出');

    // 空审计 / 脏数据防御
    PrefStore.delete('agentAuditLog');
    const u7 = await AT.undoLast();
    ok(!u7.ok && u7.error === '没有可撤销的操作', 'undoLast：空审计返回明确错误');
    eq(AT.auditList().length, 0, 'auditList：空审计返回空数组');

    PrefStore.set('agentAuditLog', '{bad json');
    eq(AT.auditList().length, 0, 'auditList：坏 JSON 不抛、返回空');
    PrefStore.set('agentAuditLog', JSON.stringify([
      { nope: 1 },
      { id: 'a', ts: 1, tool: 't', summary: 's', undo: { kind: 'manual', hint: 'h' } },
    ]));
    eq(AT.auditList().length, 1, 'auditList：无 id 的脏记录被过滤');
    PrefStore.delete('agentAuditLog');

    // ctx.skipConfirm：跳过弹框（MCP 路径），来源写入 summary
    PrefStore.set('aiAgentConfirmWrite', true);
    confirmState.returns = false;
    confirmState.calls.length = 0;
    const sc = await AT.execTool('add_tags', { item_id: 101, tags: 'mcp' },
      { skipConfirm: true, source: 'mcp' });
    ok(sc.indexOf('✓') === 0, 'skipConfirm：绕过确认直接写成功', sc);
    eq(confirmState.calls.length, 0, 'skipConfirm：confirm 调用次数 = 0');
    ok(AT.auditList()[0].summary.indexOf('来源：mcp') >= 0, 'skipConfirm：MCP 来源写进 summary');
    confirmState.returns = true;
    PrefStore.delete('aiAgentConfirmWrite');
    PrefStore.delete('agentAuditLog');
    PrefStore.delete('aiAgentTools');
  })().catch((e) => { ok(false, '审计/撤销异常: ' + e.message); });

  /* ---------------- ⑪ 长期记忆工具 ---------------- */

  await (async () => {
    const AM = sandbox.AgentMemory;
    ok(!!AM, 'AgentMemory 已随沙箱加载');
    enableAll();
    PrefStore.delete('agentMemory');
    PrefStore.delete('agentAuditLog');
    PrefStore.delete('aiAgentConfirmWrite');

    // 空态
    eq(await AT.execTool('memory_read', {}, {}),
      '暂无记忆（可用 memory_write 保存研究方向、结论、偏好）',
      'memory_read：空态给可行动提示');
    eq(await AT.execTool('memory_read', { query: 'anything' }, {}),
      '暂无记忆（可用 memory_write 保存研究方向、结论、偏好）',
      'memory_read：空库带 query 仍是空态提示');

    // 协议提示词自动派生新工具签名
    ok(AT.protocolPrompt().indexOf('memory_read(query?)') > 0,
      '协议自动派生 memory_read 签名');
    ok(AT.protocolPrompt().indexOf('memory_write(kind?, text)') > 0,
      '协议自动派生 memory_write 签名');

    // memory_write：默认确认开启 → 弹一次
    confirmState.returns = true;
    confirmState.calls.length = 0;
    const w1 = await AT.execTool('memory_write',
      { kind: 'project', text: '研究方向：长文本检索增强' }, {});
    eq(w1, '✓ 已记住（[项目] 研究方向：长文本检索增强）',
      'memory_write：成功文案（kind 中文标签）');
    eq(confirmState.calls.length, 1, 'memory_write：默认逐次确认');
    eq(AM.list().length, 1, 'memory_write：真实写入记忆');
    eq(AM.list()[0].kind, 'project', 'memory_write：kind 透传');
    eq(AM.list()[0].source, 'ui', 'memory_write：来源写入条目');

    const rec = AT.auditList()[0];
    eq(rec.tool, 'memory_write', '审计：tool = memory_write');
    eq(rec.undo.kind, 'removeMemory', '审计：undo.kind = removeMemory');
    eq(rec.undo.memoryId, AM.list()[0].id, '审计：记账 memoryId');
    ok(rec.summary.indexOf('记忆写入：[项目]') === 0,
      '审计：summary 形如「记忆写入：[项目] …」', rec.summary);
    ok(rec.summary.indexOf('来源：ui') > 0, '审计：summary 记上下文来源');

    // memory_read：有数据
    const read1 = await AT.execTool('memory_read', {}, {});
    ok(read1.indexOf('[1] [project] 研究方向：长文本检索增强') > 0,
      'memory_read：清单含 [序号] [kind] text', read1);
    ok(read1.indexOf('记忆清单') === 0, 'memory_read：带标题行');

    // 非法 kind → fact
    const w2 = await AT.execTool('memory_write',
      { kind: 'nonsense', text: 'BERT 是双向编码器' }, {});
    eq(w2, '✓ 已记住（[事实] BERT 是双向编码器）', 'memory_write：非法 kind 回落事实');

    // skipConfirm 路径（MCP）
    PrefStore.set('aiAgentConfirmWrite', true);
    confirmState.returns = false;
    confirmState.calls.length = 0;
    const w3 = await AT.execTool('memory_write',
      { kind: 'prefer', text: '偏好中文回答' }, { skipConfirm: true, source: 'mcp' });
    ok(w3.indexOf('✓') === 0, 'skipConfirm：绕过确认写入成功', w3);
    eq(confirmState.calls.length, 0, 'skipConfirm：confirm 调用次数 = 0');
    ok(AT.auditList()[0].summary.indexOf('来源：mcp') > 0,
      'skipConfirm：来源 mcp 写入审计');
    eq(AM.list()[0].source, 'mcp', 'skipConfirm：条目来源 = mcp');
    confirmState.returns = true;

    // 搜索（大小写不敏感）
    const byQuery = await AT.execTool('memory_read', { query: 'BERT' }, {});
    ok(byQuery.indexOf('BERT 是双向编码器') > 0, 'memory_read：关键词命中');
    ok(byQuery.indexOf('偏好中文回答') < 0, 'memory_read：未命中的条目不返回');
    eq(byQuery.split('\n').length, 2, 'memory_read：仅 1 条命中（标题 + 1 行）');
    const byKind = await AT.execTool('memory_read', { query: 'prefer' }, {});
    ok(byKind.indexOf('[1] [prefer] 偏好中文回答') > 0, 'memory_read：kind 也参与搜索');
    const miss = await AT.execTool('memory_read', { query: 'zzz' }, {});
    ok(miss.indexOf('没有匹配「zzz」的记忆') === 0, 'memory_read：无命中给可行动提示', miss);

    // 空文本：报错且不弹确认、不落库
    const beforeAdd = AM.list().length;
    confirmState.calls.length = 0;
    const bad = await AT.execTool('memory_write', { text: '   ' }, {});
    ok(bad.indexOf('记忆内容为空') === 0, 'memory_write：空文本报错');
    eq(confirmState.calls.length, 0, 'memory_write：空文本不弹确认');
    eq(AM.list().length, beforeAdd, 'memory_write：空文本不落库');

    // 拒绝路径
    confirmState.returns = false;
    confirmState.calls.length = 0;
    const denied = await AT.execTool('memory_write', { text: '不该写' }, {});
    ok(denied.indexOf('用户拒绝') === 0, 'memory_write：拒绝返回拒绝说明');
    eq(confirmState.calls.length, 1, 'memory_write：拒绝前确实弹过一次确认');
    eq(AM.list().length, beforeAdd, 'memory_write：拒绝不落库');
    confirmState.returns = true;

    // 端到端撤销：undoLast → removeMemory
    eq(AT.auditList().length, 3, '审计：三次写入各 1 条');
    const newest = AM.list()[0].id;
    const u1 = await AT.undoLast();
    ok(u1.ok && u1.done.indexOf('已删除记忆') === 0, 'undoLast:removeMemory 成功', u1);
    eq(AM.list().filter((m) => m.id === newest).length, 0, 'undoLast:removeMemory 记忆消失');
    eq(AT.auditList().length, 2, 'undoLast：成功后移除该条审计');

    await AT.undoLast();
    await AT.undoLast();
    eq(AM.list().length, 0, '连续撤销后记忆清空');
    eq(AT.auditList().length, 0, '连续撤销后审计清空');

    // 记忆已被手动删除 → 撤销失败并保留记录
    AT._recordAudit('memory_write', '记忆写入：[事实] 已不存在',
      { kind: 'removeMemory', memoryId: 'mem-gone' });
    const u2 = await AT.undoLast();
    ok(!u2.ok && u2.error.indexOf('记忆不存在') >= 0,
      'undoLast:removeMemory 目标不存在 → {ok:false,error}', u2);
    eq(AT.auditList().length, 1, 'undoLast：失败保留记录（可重试）');
    PrefStore.delete('agentAuditLog');

    // 模块缺位降级（var 全局不可 delete，用置空模拟缺位）
    const savedAM = sandbox.AgentMemory;
    sandbox.AgentMemory = undefined;
    ok((await AT.execTool('memory_read', {}, {})).indexOf('记忆模块不可用') >= 0,
      'AgentMemory 缺位：memory_read 降级');
    ok((await AT.execTool('memory_write', { text: 'x' }, {})).indexOf('记忆模块不可用') >= 0,
      'AgentMemory 缺位：memory_write 降级');
    sandbox.AgentMemory = savedAM;

    PrefStore.delete('agentMemory');
    PrefStore.delete('agentAuditLog');
    PrefStore.delete('aiAgentTools');
  })().catch((e) => { ok(false, '长期记忆工具异常: ' + (e && e.stack || e)); });

  /* ---------------- ⑫ restoreFields 撤销（0.52.0 元数据医生） ---------------- */

  await (async () => {
    PrefStore.delete('agentAuditLog');
    // 元数据医生写入后的条目：三个字段都有新值，审计里存旧值（空串）
    const it = {
      id: 120, itemType: 'journalArticle', _saved: 0,
      _f: { title: 'T', DOI: '10.1/x', publicationTitle: 'Nature', date: '2015' },
      isRegularItem: () => true,
      getField(f) { return this._f[f] || ''; },
      setField(f, v) { this._f[f] = v; },
      getDisplayTitle() { return 'T'; },
      getCreators() { return []; },
      async saveTx() { this._saved++; },
    };
    LIB.push(it);
    AT._recordAudit('meta_doctor', '元数据补全：《T》补 DOI/期刊/年份',
      { kind: 'restoreFields', itemID: 120, fields: { DOI: '', publicationTitle: '', date: '' } });
    const u = await AT.undoLast();
    ok(u.ok && u.done.indexOf('已恢复字段') === 0, 'undoLast:restoreFields 成功返回恢复说明', u);
    ok(it._f.DOI === '' && it._f.publicationTitle === '' && it._f.date === '' && it._saved === 1,
      'undoLast:restoreFields 字段写回旧值（空串）并 saveTx', it._f);

    AT._recordAudit('meta_doctor', '元数据补全：《已删除》',
      { kind: 'restoreFields', itemID: 99911, fields: { DOI: '' } });
    const u2 = await AT.undoLast();
    ok(!u2.ok && u2.error.indexOf('条目不存在') >= 0, 'undoLast:restoreFields 目标条目不存在 → {ok:false,error}', u2);
    PrefStore.delete('agentAuditLog');
  })().catch((e) => { ok(false, 'restoreFields 撤销异常: ' + (e && e.stack || e)); });

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
