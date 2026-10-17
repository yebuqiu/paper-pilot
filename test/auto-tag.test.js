#!/usr/bin/env node
/* AI 自动打标签 v2（0.46.0）· 纯函数层 + 编排层测试
 *
 * 为什么要有它：v2 把打标从「一句 prompt + 正则抓 #」升级为
 *   结构化解析 → 归一化 → 词表对齐 → 规则校验 → 缓存
 * 五段流水线，任何一段出错都会直接污染用户库里的标签（写脏容易洗脏难）。
 * 本套件把每一段真跑一遍：
 *   ① 归一化/形状键（全角、＃、分段空白、尾随标点）；
 *   ② 结构化解析（纯 JSON / 围栏 / 前后杂文 / {tags:[]} 包装 / 干扰括号 / 越界置信度）；
 *   ③ 旧版 #token / 按行解析回归（降级链不能坏）；
 *   ④ 规则校验（类别白名单 / 宽泛词黑名单 / 中英文）与词表对齐（复用库内写法）；
 *   ⑤ 全流水线 _processReply（对齐+校验+去重+截断一起验证）；
 *   ⑥ 指纹与缓存（指纹稳定性 / LRU 上限 / 损坏恢复 / 开关）；
 *   ⑦ buildContext（元数据抽取、截断、NO_META）与 buildPrompt（中英双语、词表注入）；
 *   ⑧ suggestDetailed 端到端（stub AIClient：对齐生效、已有标签过滤、
 *      缓存命中不再调 AI、缓存关闭、suggest() 兼容层截断）；
 *   ⑨ _collectVocabulary（高频优先 + TTL 内存缓存，扫描只跑一次）；
 *   ⑩ 勾选对话框迷你 DOM 真渲染（0.45.99 真机「弹窗无标签」回归锁：
 *      脚本先于 DOM 执行的时序 + 新旧 io 形态 + 按钮/异常路径）。
 *
 * 运行：node test/auto-tag.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FILE = 'chrome/content/scripts/ai/auto-tag.js';

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  <- ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

/* ---------- 沙箱 ----------
 * 注意：真机 Prefs 会加 extensions.zotero.paperpilot. 前缀，本桩直存裸键，
 * 所以 PrefStore 的键一律不带前缀（与 Prefs.get 的调用参数一致）。 */
const PrefStore = new Map();

let searchRuns = 0;
const libItems = {
  1: { deleted: false, getTags: () => [{ tag: '#方法/深度学习' }, { tag: '#领域/医学' }] },
  2: { deleted: false, getTags: () => [{ tag: '#方法/深度学习' }] },
  3: { deleted: false, getTags: () => [{ tag: '#方法/深度学习' }] },
  4: { deleted: false, getTags: () => [] },
};

let chatCalls = 0;
let chatReply = '';

const sandbox = {
  console,
  Services: {},
  I18n: { isZh: true },
  ItemSel: {},
  Prefs: {
    get: (k, d) => (PrefStore.has(k) ? PrefStore.get(k) : d),
    set: (k, v) => PrefStore.set(k, v),
  },
  AIClient: {
    hasKey: () => true,
    async chat() { chatCalls++; return chatReply; },
  },
  Zotero: {
    debug() {}, logError() {},
    locale: 'zh-CN',
    Libraries: { userLibraryID: 1 },
    ItemTypes: { getName: () => 'journalArticle' },
    Search: function () {
      this.libraryID = 0;
      this.addCondition = () => {};
      this.search = async () => { searchRuns++; return Object.keys(libItems); };
    },
    Items: { getAsync: async (id) => libItems[id] || null },
  },
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, FILE), 'utf8'), sandbox, { filename: FILE });
const AT = sandbox.AutoTag;

/** 每个用例组之间的复位：词表内存缓存 + pref 存储 + AI stub */
function reset(seedVocab) {
  AT._vocab = null;
  AT._vocabAt = 0;
  PrefStore.clear();
  chatCalls = 0;
  chatReply = '';
  if (seedVocab) { AT._vocab = seedVocab; AT._vocabAt = Date.now(); }
}

/* ---------- ① 归一化与形状键 ---------- */
eq(AT._normalizeTag('方法/深度学习'), '#方法/深度学习', 'norm: 补 # 前缀');
eq(AT._normalizeTag('#领域／心血管'), '#领域/心血管', 'norm: 全角斜杠 → 半角');
eq(AT._normalizeTag(' #主题/meta learning 。'), '#主题/meta learning', 'norm: 去首尾空白与尾随标点，保留内部空格');
eq(AT._normalizeTag('#状态 / 预印本'), '#状态/预印本', 'norm: 分段 trim');
eq(AT._normalizeTag('＃方法／ＤＮＮ'), '#方法/DNN', 'norm: 全角字符链（＃／ＤＮＮ）');
eq(AT._normalizeTag(''), '', 'norm: 空串');
eq(AT._normalizeTag(null), '', 'norm: null');
eq(AT._normalizeTag('#'), '', 'norm: 只有 #');
eq(AT._normalizeTag('#/X/'), '#X', 'norm: 空段丢弃');

eq(AT._shapeKey('#方法/Deep-Learning'), AT._shapeKey('#方法/deep learning'), 'shape: 大小写/连字符/空格视为同概念');
eq(AT._shapeKey('方法/deeplearning'), AT._shapeKey('#方法/Deep-Learning'), 'shape: 无 # 与分隔符差异');
ok(AT._shapeKey('#方法/深度学习') !== AT._shapeKey('#方法/deep learning'), 'shape: 中英不同概念不同键');

/* ---------- ② 结构化解析 ---------- */
{
  const pure = '[{"tag":"#方法/X","reason":"r1","confidence":0.9},{"tag":"#领域/Y","reason":"r2","confidence":0.4}]';
  const r1 = AT._parseStructured(pure);
  ok(Array.isArray(r1) && r1.length === 2, 'json: 纯数组解析', r1);
  eq(r1[0].tag, '#方法/X', 'json: tag');
  eq(r1[0].reason, 'r1', 'json: reason');
  eq(r1[0].confidence, 0.9, 'json: confidence');

  const fenced = '好的，以下是建议：\n```json\n' + pure + '\n```\n希望有帮助';
  const r2 = AT._parseStructured(fenced);
  ok(Array.isArray(r2) && r2.length === 2, 'json: 前后杂文 + 代码围栏', r2);
  eq(r2[1].tag, '#领域/Y', 'json: 围栏内第二个元素');

  const wrapper = '{"tags":[{"tag":"#主题/Z","reason":"","confidence":0.7}],"note":"x"}';
  const r3 = AT._parseStructured('结果 ' + wrapper + ' 完毕');
  ok(Array.isArray(r3) && r3.length === 1 && r3[0].tag === '#主题/Z', 'json: {tags:[]} 对象包装 + 前后杂文', r3);

  const distractor = '见 [备注] 部分。[' + pure.slice(1) + ']';
  const r4 = AT._parseStructured(distractor);
  ok(Array.isArray(r4) && r4.length === 2, 'json: 干扰括号 [备注] 被跳过', r4);

  const strings = '["#方法/A","#方法/B"]';
  const r5 = AT._parseStructured(strings);
  ok(Array.isArray(r5) && r5.length === 2 && r5[0].confidence === 0.5, 'json: 字符串元素 → confidence 缺省 0.5', r5);

  const clamped = '[{"tag":"#方法/A","confidence":1.5},{"tag":"#方法/B","confidence":-0.2},{"tag":"#方法/C"}]';
  const r6 = AT._parseStructured(clamped);
  eq(r6[0].confidence, 1, 'json: confidence 钳上限');
  eq(r6[1].confidence, 0, 'json: confidence 钳下限');
  eq(r6[2].confidence, 0.5, 'json: confidence 缺省');

  eq(AT._parseStructured('这不是 JSON'), null, 'json: 非法输入 → null（走降级链）');
  eq(AT._parseStructured('[]'), null, 'json: 空数组 → null');
  eq(AT._parseStructured('[1,2,3]'), null, 'json: 元素无 tag 字段 → null');
  eq(AT._parseStructured(''), null, 'json: 空串 → null');

  eq(AT._extractBalanced('["x[y]", "z"]', '[', ']', 0), '["x[y]", "z"]', 'extract: 字符串内括号不计数');
  eq(AT._extractBalanced('["a\\"]b", 1]', '[', ']', 0), '["a\\"]b", 1]', 'extract: 转义引号');
  eq(AT._extractBalanced('[1,2', '[', ']', 0), null, 'extract: 不平衡 → null');
}

/* ---------- ③ 旧版解析回归（降级链不能坏） ---------- */
{
  const t1 = AT._parseTags('#方法/A #方法/B。');
  eq(JSON.stringify(t1), JSON.stringify(['#方法/A', '#方法/B']), 'legacy: #token + 尾随标点');
  eq(AT._parseTags('#方法/A #方法/A').length, 1, 'legacy: 去重');
  eq(AT._parseTags('#a').length, 0, 'legacy: 总长 <3 拒绝');
  const t2 = AT._parseTags('1. 方法/X\n- 领域/Y');
  eq(JSON.stringify(t2), JSON.stringify(['#方法/X', '#领域/Y']), 'legacy: 按行兜底（去编号/符号）');

  // v2 降级链第二级：只认显式 #token（散文拒答不产标签）
  eq(JSON.stringify(AT._parseHashTokens('#方法/A #方法/A。')), JSON.stringify(['#方法/A']), 'hash: 去重+尾随标点');
  eq(AT._parseHashTokens('抱歉，我无法处理').length, 0, 'hash: 无 # 的散文 → 空');
  eq(AT._parseTagsAsDetail('抱歉，我无法处理').length, 0, 'hash: 降级包装不为散文生成 detail');
  const asDetail = AT._parseTagsAsDetail('#方法/A');
  eq(asDetail[0].tag, '#方法/A', 'legacy: 包装 detail');
  eq(asDetail[0].confidence, 0.5, 'legacy: 包装 confidence 0.5');
}

/* ---------- ④ 规则校验与词表对齐 ---------- */
{
  eq(AT._tagPassesRules('#领域/图神经网络', 'zh'), true, 'rules: 合法类别+具体名');
  eq(AT._tagPassesRules('#方法/机器学习', 'zh'), true, 'rules: 具体名通过');
  eq(AT._tagPassesRules('#研究', 'zh'), false, 'rules: 宽泛词拒绝');
  eq(AT._tagPassesRules('#方法', 'zh'), false, 'rules: 裸类别拒绝');
  eq(AT._tagPassesRules('#领域', 'zh'), false, 'rules: 裸类别（领域）拒绝');
  eq(AT._tagPassesRules('#状态/预印本', 'zh'), false, 'rules: 未知类别的新标签拒绝');
  eq(AT._tagPassesRules('#Domain/graph learning', 'en'), true, 'rules(en): 合法');
  eq(AT._tagPassesRules('#Topic', 'en'), false, 'rules(en): 裸类别拒绝');
  eq(AT._tagPassesRules('#Domain/research', 'en'), false, 'rules(en): 宽泛词拒绝');

  const vocab = ['#方法/deep learning', '#状态/预印本'];
  const aligned = AT._alignToVocabulary([
    { tag: '#方法/Deep-Learning', reason: 'r', confidence: 0.9 },
    { tag: '#主题/新话题', reason: '', confidence: 0.5 },
  ], vocab);
  eq(aligned[0].tag, '#方法/deep learning', 'align: shape 命中 → 复用库内写法');
  eq(aligned[0].reason, 'r', 'align: reason 保留');
  eq(aligned[1].tag, '#主题/新话题', 'align: 未命中原样保留');
  eq(AT._alignToVocabulary([{ tag: '#a/B', reason: '', confidence: 1 }], []).length, 1, 'align: 空词表原样返回');
}

/* ---------- ⑤ 全流水线 _processReply ---------- */
{
  const ctx = { vocab: ['#方法/deep learning', '#状态/预印本'], lang: 'zh', max: 6 };
  const reply = JSON.stringify([
    { tag: '#方法/Deep-Learning', reason: '摘要提及', confidence: 0.9 },  // → 对齐到库内写法
    { tag: '#领域/医学影像', reason: '', confidence: 0.7 },               // 新标签合法
    { tag: '#研究', reason: '', confidence: 0.8 },                        // 宽泛词 → invalid
    { tag: '#状态/预印本', reason: '', confidence: 0.6 },                 // 词表命中 → 类别白名单豁免
    { tag: '#方法/机器学习', reason: '', confidence: 0.5 },               // 合法
    { tag: '#方法/机器学习', reason: '', confidence: 0.5 },               // shape 重复 → invalid
    { tag: '#方法/' + '超'.repeat(50), reason: '', confidence: 0.5 },     // 超长 → invalid
  ]);
  const r = AT._processReply(reply, ctx);
  eq(r.items.length, 4, 'pipeline: 有效建议数');
  eq(r.items[0].tag, '#方法/deep learning', 'pipeline: 词表对齐生效');
  eq(r.items[1].tag, '#领域/医学影像', 'pipeline: 新标签通过');
  eq(r.items[2].tag, '#状态/预印本', 'pipeline: 词表命中豁免类别白名单');
  eq(r.items[3].tag, '#方法/机器学习', 'pipeline: shape 去重保留首个');
  eq(r.invalid.length, 3, 'pipeline: 无效建议进 invalid（宽泛/重复/超长）');

  // 截断：15 个合法建议、max=6 → 最多 6+4=10 个
  const many = JSON.stringify(Array.from({ length: 15 }, (_, i) =>
    ({ tag: '#领域/主题' + i, reason: '', confidence: 0.9 })));
  eq(AT._processReply(many, ctx).items.length, 10, 'pipeline: 候选上限 max+4');

  // 降级链：非 JSON 文本回复也能出标（confidence 0.5）
  const legacy = AT._processReply('#方法/深度学习\n#领域/医学', ctx);
  eq(legacy.items.length, 2, 'pipeline: 非 JSON 走旧解析');
  eq(legacy.items[0].confidence, 0.5, 'pipeline: 降级建议 confidence 0.5');
}

/* ---------- ⑥ 指纹与缓存 ---------- */
{
  const base = { title: 'T', abstract: 'A', max: 6, lang: 'zh', vocab: ['#a', '#b'] };
  eq(AT._fingerprint(base), AT._fingerprint(Object.assign({}, base)), 'fp: 相同输入同指纹');
  ok(AT._fingerprint(base) !== AT._fingerprint(Object.assign({}, base, { abstract: 'A2' })), 'fp: 摘要变化指纹变');
  ok(AT._fingerprint(base) !== AT._fingerprint(Object.assign({}, base, { max: 8 })), 'fp: 个数变化指纹变');
  ok(AT._fingerprint(base) !== AT._fingerprint(Object.assign({}, base, { lang: 'en' })), 'fp: 语言变化指纹变');
  ok(AT._fingerprint(base) !== AT._fingerprint(Object.assign({}, base, { vocab: ['#a', '#b', '#c'] })), 'fp: 词表规模变化指纹变');
  eq(AT._hash(''), '811c9dc5', 'hash: FNV-1a 空串基准（offset basis）');
  ok(AT._hash('abc') !== AT._hash('abd'), 'hash: 输入敏感');

  reset();
  AT._cachePut('fp1', [{ tag: '#方法/X', reason: '', confidence: 1 }]);
  ok(Array.isArray(AT._cacheGet('fp1')) && AT._cacheGet('fp1').length === 1, 'cache: 读写往返');
  eq(AT._cacheGet('fp-none'), null, 'cache: 未命中 → null');

  PrefStore.set('autoTagCacheData', '{not-json');
  eq(AT._cacheGet('fp1'), null, 'cache: 损坏数据静默视为空');

  reset();
  PrefStore.set('autoTagCache', false);
  AT._cachePut('fp1', [{ tag: '#方法/X', reason: '', confidence: 1 }]);
  eq(AT._cacheGet('fp1'), null, 'cache: 开关关闭时不读不写');

  reset();
  for (let i = 0; i < 105; i++) AT._cachePut('fp' + i, [{ tag: '#方法/X' + i, reason: '', confidence: 1 }]);
  const keys = Object.keys(AT._cacheAll());
  ok(keys.length <= AT.CACHE_MAX, 'cache: LRU 上限', keys.length);
  ok(!('fp0' in AT._cacheAll()) && ('fp104' in AT._cacheAll()), 'cache: 最旧的先淘汰');
}

/* ---------- ⑦ buildContext / buildPrompt / _effectiveLang ---------- */
async function testCtxPrompt() {
  reset(['#方法/深度学习']);
  const item = {
    itemTypeID: 7,
    getField: (f) => ({
      title: 'A Long Title',
      abstractNote: '摘'.repeat(2000),
      publicationTitle: 'Nature',
      date: '2024-05-01',
      language: 'en',
    }[f] || ''),
    getCreators: () => [
      { firstName: 'A', lastName: 'One' }, { firstName: 'B', lastName: 'Two' },
      { firstName: 'C', lastName: 'Three' }, { firstName: 'D', lastName: 'Four' },
    ],
    getTags: () => [{ tag: '#已有/标签' }],
  };
  const c = await AT.buildContext(item);
  eq(c.title, 'A Long Title', 'ctx: 标题');
  eq(c.abstract.length, AT.ABSTRACT_MAX, 'ctx: 摘要截断到 1200');
  eq(c.creators, 'A One, B Two, C Three', 'ctx: 作者取前 3');
  eq(c.year, '2024', 'ctx: 年份');
  eq(c.itemType, 'journalArticle', 'ctx: 条目类型');
  eq(c.language, 'en', 'ctx: 语言字段');
  eq(JSON.stringify(c.existingTags), JSON.stringify(['#已有/标签']), 'ctx: 已有标签');
  eq(c.lang, 'zh', 'ctx: autoTagLang=auto + 中文界面 → zh');
  eq(c.max, 6, 'ctx: 默认个数');
  eq(JSON.stringify(c.vocab), JSON.stringify(['#方法/深度学习']), 'ctx: 词表（内存缓存）');

  // 词表开关
  PrefStore.set('autoTagUseVocab', false);
  AT._vocab = null; AT._vocabAt = 0;
  const c2 = await AT.buildContext(item);
  eq(JSON.stringify(c2.vocab), '[]', 'ctx: 关闭词表 → 空');
  PrefStore.delete('autoTagUseVocab');

  // NO_META
  const empty = { itemTypeID: 7, getField: () => '', getCreators: () => [], getTags: () => [] };
  let metaErr = null;
  try { await AT.buildContext(empty); } catch (e) { metaErr = e; }
  ok(!!metaErr, 'ctx: 无元数据抛错');
  eq(metaErr && metaErr.code, 'NO_META', 'ctx: 错误码 NO_META');

  // 语言 pref
  reset();
  PrefStore.set('autoTagLang', 'en');
  eq(AT._effectiveLang(), 'en', 'lang: pref=en');
  PrefStore.set('autoTagLang', 'zh');
  eq(AT._effectiveLang(), 'zh', 'lang: pref=zh');
  PrefStore.set('autoTagLang', 'auto');
  eq(AT._effectiveLang(), 'zh', 'lang: auto + zh 界面 → zh');

  // 提示词
  const zhCtx = {
    title: '标题X', abstract: '摘要Y', publication: '期刊Z', creators: '作者W',
    year: '2024', itemType: 'journalArticle', language: 'en',
    existingTags: ['#已有/A'], vocab: ['#方法/深度学习'], max: 6, lang: 'zh',
  };
  const p1 = AT.buildPrompt(zhCtx);
  ok(p1.includes('JSON 数组') && p1.includes('"confidence"'), 'prompt(zh): 结构化输出指令');
  ok(p1.includes('库内已有标签') && p1.includes('#方法/深度学习'), 'prompt(zh): 词表注入');
  ok(p1.includes('该条目已有的标签') && p1.includes('#已有/A'), 'prompt(zh): 已有标签提示');
  ok(p1.includes('标题：标题X') && p1.includes('摘要：摘要Y'), 'prompt(zh): 元数据');
  ok(p1.includes('期刊：期刊Z') && p1.includes('作者：作者W'), 'prompt(zh): 期刊/作者');
  const enCtx = Object.assign({}, zhCtx, { lang: 'en', vocab: [], existingTags: [] });
  const p2 = AT.buildPrompt(enCtx);
  ok(p2.includes('Output ONLY a JSON array'), 'prompt(en): 结构化输出指令');
  ok(p2.includes('Title: 标题X'), 'prompt(en): 元数据');
  ok(!p2.includes('Existing tags in this library'), 'prompt(en): 无词表不出现该节');
}

/* ---------- ⑧ suggestDetailed / suggest 端到端 ---------- */
async function testE2E() {
  // 正常流：对齐 + 过滤 + 缓存
  reset(['#方法/deep learning']);
  chatReply = JSON.stringify([
    { tag: '#方法/Deep-Learning', reason: '摘要提及深度学习', confidence: 0.9 },
    { tag: '#领域/医学影像', reason: '应用场景', confidence: 0.6 },
    { tag: '#研究', reason: '', confidence: 0.8 },
  ]);
  const item = {
    itemTypeID: 7,
    getField: (f) => ({ title: 'T1', abstractNote: 'A1' }[f] || ''),
    getCreators: () => [], getTags: () => [],
  };
  const r1 = await AT.suggestDetailed(item);
  eq(r1.suggestions.length, 2, 'e2e: 宽泛词被过滤');
  eq(r1.suggestions[0].tag, '#方法/deep learning', 'e2e: 建议对齐到库内写法');
  eq(r1.suggestions[0].reason, '摘要提及深度学习', 'e2e: 理由随建议返回');
  eq(r1.cached, false, 'e2e: 首次调用非缓存');
  eq(chatCalls, 1, 'e2e: 调了一次 AI');

  const r2 = await AT.suggestDetailed(item);
  eq(r2.cached, true, 'e2e: 二次调用命中缓存');
  eq(chatCalls, 1, 'e2e: 缓存命中不再调 AI');
  eq(JSON.stringify(r2.suggestions.map((s) => s.tag)), JSON.stringify(r1.suggestions.map((s) => s.tag)),
    'e2e: 缓存结果一致');

  // 元数据变化 → 指纹失效 → 重新调 AI
  const item2 = { itemTypeID: 7, getField: (f) => ({ title: 'T1', abstractNote: 'A2' }[f] || ''),
    getCreators: () => [], getTags: () => [] };
  const r3 = await AT.suggestDetailed(item2);
  eq(r3.cached, false, 'e2e: 摘要变化指纹失效');
  eq(chatCalls, 2, 'e2e: 指纹失效后重新调 AI');

  // 条目已有标签：缓存命中后也会被运行期过滤
  const tagged = { itemTypeID: 7, getField: (f) => ({ title: 'T1', abstractNote: 'A1' }[f] || ''),
    getCreators: () => [], getTags: () => [{ tag: '#方法/deep learning' }] };
  const r4 = await AT.suggestDetailed(tagged);
  eq(r4.cached, true, 'e2e: 已有标签的条目仍命中缓存');
  ok(r4.suggestions.every((s) => s.tag !== '#方法/deep learning'), 'e2e: 已有标签从建议中剔除');
  eq(JSON.stringify(r4.dropped.existing), JSON.stringify(['#方法/deep learning']), 'e2e: dropped.existing 记录被剔除项');

  // suggest() 兼容层：string[] + autoTagMax 截断
  reset(['#方法/deep learning']);
  chatReply = JSON.stringify(Array.from({ length: 8 }, (_, i) =>
    ({ tag: '#领域/主题' + i, reason: '', confidence: 0.9 })));
  const list = await AT.suggest(item);
  ok(Array.isArray(list) && list.every((t) => typeof t === 'string'), 'suggest: 返回 string[]');
  eq(list.length, 6, 'suggest: 截断到 autoTagMax');
  PrefStore.set('autoTagMax', 3);
  eq((await AT.suggest(item)).length, 3, 'suggest: 尊重自定义 autoTagMax');
  PrefStore.delete('autoTagMax');

  // 缓存关闭：每次都调 AI
  reset(['#方法/deep learning']);
  PrefStore.set('autoTagCache', false);
  chatReply = '[{"tag":"#领域/X","reason":"","confidence":0.9}]';
  await AT.suggestDetailed(item);
  await AT.suggestDetailed(item);
  eq(chatCalls, 2, 'e2e: 缓存关闭每次都调 AI');

  // AI 返回完全无法解析的内容 → 抛可读错误
  reset([]);
  chatReply = 'OK';
  let threw = null;
  try { await AT.suggestDetailed(item); } catch (e) { threw = e; }
  ok(threw && /未返回有效标签/.test(threw.message), 'e2e: 无效回复抛可读错误', threw && threw.message);

  // NO_META 透传
  reset([]);
  const empty = { itemTypeID: 7, getField: () => '', getCreators: () => [], getTags: () => [] };
  threw = null;
  try { await AT.suggestDetailed(empty); } catch (e) { threw = e; }
  eq(threw && threw.code, 'NO_META', 'e2e: NO_META 透传');
  eq(chatCalls, 0, 'e2e: 无元数据不调 AI');
}

/* ---------- ⑨ _collectVocabulary ---------- */
async function testVocab() {
  reset();
  searchRuns = 0;
  const v1 = await AT._collectVocabulary();
  // 词表统计：#方法/深度学习 x3、#领域/医学 x1 → 高频在前
  eq(JSON.stringify(v1), JSON.stringify(['#方法/深度学习', '#领域/医学']), 'vocab: 高频优先');
  eq(searchRuns, 1, 'vocab: 首次采集跑一次全库搜索');
  await AT._collectVocabulary();
  eq(searchRuns, 1, 'vocab: TTL 内复用内存缓存（不重复扫描）');
  AT._vocabAt = 0; // 强制过期
  await AT._collectVocabulary();
  eq(searchRuns, 2, 'vocab: 过期后重新扫描');
}

/* ---------- ⑩ 勾选对话框迷你 DOM 真渲染（0.45.99 真机「弹窗无标签」回归锁） ----------
 * 根因：XUL 窗口的 <script src> 可能先于 DOM 解析执行 → getElementById 全 null
 * → appendChild 抛异常 → 弹窗只剩空列表死按钮。这里用迷你 DOM 真跑
 * tag-preview.js，覆盖两种时序（先于 DOM / DOM 已就绪）+ 新旧两种 io 形态。 */
const TP_SRC = fs.readFileSync(path.join(ROOT, 'chrome/content/tag-preview.js'), 'utf8');

function makeDialogDom(withElements) {
  const els = {};
  const mk = (tag) => ({
    tag, children: [], handlers: {}, style: {}, id: '',
    type: '', checked: false, textContent: '', value: '',
    setAttribute(k, v) { if (k === 'value') this.value = String(v); this['attr_' + k] = String(v); },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); },
    fire(ev) { for (const fn of (this.handlers[ev] || []).slice()) fn({}); },
    click() { this.fire('click'); },
  });
  const addIds = () => {
    for (const id of ['pp-tag-list', 'pp-tag-title', 'pp-tag-existing',
      'pp-tag-all', 'pp-tag-none', 'pp-tag-ok', 'pp-tag-cancel']) {
      els[id] = mk(id === 'pp-tag-list' ? 'vbox' : 'button');
      els[id].id = id;
    }
  };
  if (withElements) addIds();
  const domReady = [];
  const win = {
    arguments: null,
    addEventListener(ev, fn) { if (ev === 'DOMContentLoaded') domReady.push(fn); },
    close() { this.closed = (this.closed || 0) + 1; },
    closed: 0,
  };
  const doc = {
    readyState: withElements ? 'complete' : 'loading',
    getElementById: (id) => els[id] || null,
    createElementNS: (ns, tag) => mk(tag),
  };
  return {
    els, win, doc, domReady,
    // 模拟「文档解析完成」：元素就位 + 触发 DOMContentLoaded 回调
    finishParse() { addIds(); doc.readyState = 'interactive'; for (const fn of domReady.splice(0)) fn(); },
  };
}

function runDialogScript(d) {
  const sb = { window: d.win, document: d.doc, console };
  vm.createContext(sb);
  vm.runInContext(TP_SRC, sb, { filename: 'tag-preview.js' });
}

function testDialog() {
  // ① 复现真机 bug 的时序：脚本先于 DOM 执行（readyState=loading、元素不存在）
  //    → 修复后行为：注册 DOMContentLoaded 等待，不抛异常；解析完成后再渲染
  {
    const d = makeDialogDom(false);
    d.win.arguments = [{
      tags: ['#方法/A', '#领域/B'],
      detail: [
        { tag: '#方法/A', reason: '摘要提及', confidence: 0.9 },
        { tag: '#领域/B', reason: '', confidence: 0.5 },
      ],
      paperTitle: '论文X', existing: ['#主题/C'], threshold: 0.7, selected: null,
    }];
    runDialogScript(d);
    eq(d.domReady.length, 1, 'dialog: 脚本先于 DOM → 等 DOMContentLoaded（不直接渲染）');
    eq(d.els['pp-tag-list'], undefined, 'dialog: DOM 未就绪前不渲染');
    d.finishParse(); // DOM 解析完成
    const list = d.els['pp-tag-list'];
    eq(list.children.length, 2, 'dialog: ★ DOM 就绪后两行标签渲染出来（真机空列表回归）');
    eq(d.els['pp-tag-title'].value, '论文X', 'dialog: 标题回填');
    // 预选：0.9 ≥ 0.7 勾选；0.5 < 0.7 不勾
    eq(list.children[0].children[0].checked, true, 'dialog: 高置信度预勾选');
    eq(list.children[1].children[0].checked, false, 'dialog: 低置信度不预勾选');
    // 行结构：checkbox + 名称 + 置信度徽标 + 理由
    eq(list.children[0].children[1].textContent, ' #方法/A', 'dialog: 标签名');
    ok(list.children[0].children[2].textContent.indexOf('90%') >= 0, 'dialog: 置信度徽标');
    eq(list.children[0].children[3].textContent, '  · 摘要提及', 'dialog: 依据文案');
    // 已有标签页脚
    ok(String(d.els['pp-tag-existing'].value).indexOf('#主题/C') >= 0
      && String(d.els['pp-tag-existing'].value).indexOf('已从建议中排除') >= 0,
      'dialog: 页脚提示已排除的已有标签');
    // 按钮：确定 → 只带走勾选的；取消 → null
    d.els['pp-tag-ok'].click();
    eq(JSON.stringify(d.win.arguments[0].selected), JSON.stringify(['#方法/A']), 'dialog: 确定只带走勾选项');
    eq(d.win.closed, 1, 'dialog: 确定后关窗');
  }

  // ② 全低置信度：至少预选最高的一条（不出现全空勾选）
  {
    const d = makeDialogDom(false);
    d.win.arguments = [{
      tags: ['#方法/A', '#领域/B'],
      detail: [
        { tag: '#方法/A', reason: '', confidence: 0.3 },
        { tag: '#领域/B', reason: '', confidence: 0.6 },
      ],
      paperTitle: '', threshold: 0.7, selected: null,
    }];
    runDialogScript(d);
    d.finishParse();
    const list = d.els['pp-tag-list'];
    eq(list.children[0].children[0].checked, false, 'dialog: 0.3 不预选');
    eq(list.children[1].children[0].checked, true, 'dialog: 全不达标时预选最高置信度');
    // 全选/清空按钮
    d.els['pp-tag-all'].click();
    eq(list.children[0].children[0].checked, true, 'dialog: 全选生效');
    d.els['pp-tag-none'].click();
    eq(list.children[1].children[0].checked, false, 'dialog: 清空生效');
    d.els['pp-tag-ok'].click();
    eq(JSON.stringify(d.win.arguments[0].selected), JSON.stringify([]), 'dialog: 清空后确定 → 空数组（不写标签）');
  }

  // ③ DOM 已就绪（readyState=complete）→ 立即渲染（不等事件）
  {
    const d = makeDialogDom(true);
    d.win.arguments = [{
      tags: ['#方法/A'], paperTitle: 'P', threshold: 0.7, selected: null,
    }];
    runDialogScript(d);
    eq(d.domReady.length, 0, 'dialog: DOM 已就绪不等事件');
    eq(d.els['pp-tag-list'].children.length, 1, 'dialog: 立即渲染一行');
    // 旧调用（只有 tags、无 detail）→ 全选（历史行为）
    eq(d.els['pp-tag-list'].children[0].children[0].checked, true, 'dialog: 旧调用默认全选');
    d.els['pp-tag-cancel'].click();
    eq(d.win.arguments[0].selected, null, 'dialog: 取消 → null');
  }

  // ④ DOM 就绪但容器缺失（文档异常）→ 按「取消」语义优雅收场，不抛异常
  {
    const d = makeDialogDom(false);
    d.doc.readyState = 'complete'; // 就绪但没有任何元素
    d.win.arguments = [{ tags: ['#方法/A'], paperTitle: 'P', selected: null }];
    runDialogScript(d);
    eq(d.win.arguments[0].selected, null, 'dialog: 容器缺失 → selected=null（视为取消）');
    eq(d.win.closed, 1, 'dialog: 容器缺失 → 关窗');
  }

  // ⑤ 无 window.arguments → 直接关窗
  {
    const d = makeDialogDom(true);
    runDialogScript(d);
    eq(d.win.closed, 1, 'dialog: 无 io → 关窗');
  }
}

/* ---------- 汇总 ---------- */
(async () => {
  await testCtxPrompt();
  await testE2E();
  await testVocab();
  testDialog();

  console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
  if (fails.length) {
    for (const f of fails) console.log('  ✗ ' + f);
    process.exit(1);
  }
  console.log('auto-tag v2 全部通过 ✓');
})();
