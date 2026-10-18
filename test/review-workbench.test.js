#!/usr/bin/env node
/* 综述工作台（ReviewWorkbench，0.53.0）测试
 *
 * 覆盖：
 *   ① 纯函数：parseOutline（标准/无编号/缺说明/无 ## 退化/空/围栏/参考文献节）、
 *      buildOutlinePrompt（篇数/标题/格式要求）、buildSectionPrompt（本节目标/
 *      全部编号/已写节标题/证据纪律/摘要截断/越界）、assembleDraft（顺序/参考文献/
 *      缺年份降级）、citeToLink（越界/已链接/「文献 10」/缺 key/「」包裹）、stripFences；
 *   ② 编排：generateOutline 成功与解析失败、no_key；draftSections 进度次数与单节
 *      失败继续；saveAsNote 参数断言与 notes_unavailable / no_item；
 *   ③ 窗口：xhtml 含关键 id（不做 DOM 重测试）。
 *
 * 运行：node test/review-workbench.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'chrome', 'content', 'scripts', 'features', 'review-workbench.js');
const XHTML = path.join(ROOT, 'chrome', 'content', 'review-workbench.xhtml');

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  <- ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }
function has(s, sub, label) { return ok(String(s == null ? '' : s).indexOf(sub) >= 0, label, { missing: sub }); }
function no(s, sub, label) { return ok(String(s == null ? '' : s).indexOf(sub) < 0, label, { unexpected: sub }); }

/* ---------------- 桩环境 ---------------- */

const LONG_ABSTRACT = 'We propose the Transformer, based solely on attention mechanisms. '.repeat(8);

const METAS = [
  {
    key: 'AAAA1111', id: 1, libraryID: 1,
    title: 'Attention Is All You Need', authors: 'Vaswani et al.',
    year: '2017', journal: 'NeurIPS', abstract: LONG_ABSTRACT,
  },
  {
    key: 'BBBB2222', id: 2, libraryID: 1,
    title: 'BERT: Pre-training of Deep Bidirectional Transformers', authors: 'Devlin et al.',
    year: '2019', journal: 'NAACL', abstract: 'Bidirectional pretraining improves downstream tasks.',
  },
  {
    key: 'CCCC3333', id: 3, libraryID: 1,
    title: 'Language Models are Few-Shot Learners', authors: 'Brown et al.',
    year: '', journal: '', abstract: '',
  },
];

const OUTLINE = [
  { n: 1, title: '研究背景与问题', desc: '交代任务背景与本文要回答的问题' },
  { n: 2, title: '方法与证据比较', desc: '比较不同技术路线的适用条件' },
  { n: 3, title: '共识、分歧与空白', desc: '指出分歧点与研究空白' },
];

/** AI 桩：handler(callIndex, messages) → 文本；抛错即模拟失败 */
function mkAI(handler, hasKey) {
  const calls = [];
  return {
    calls,
    hasKey: function () { return hasKey === undefined ? true : !!hasKey; },
    guidance: function () { return 'GUIDE：请先配置模型通道'; },
    chat: async function (messages) {
      calls.push(messages);
      return handler(calls.length - 1, messages);
    },
  };
}

/** Notes 桩（普通函数，非箭头） */
function mkNotes(mode) {
  const calls = [];
  return {
    calls,
    createFromMarkdown: async function (item, title, md, opts) {
      calls.push({ item, title, md, opts, argc: arguments.length });
      if (mode === 'throw') throw new Error('save failed');
      return { id: 777 };
    },
  };
}

function makeSandbox(extra) {
  const sb = Object.assign({
    console, setTimeout, clearTimeout,
    Promise, Date, Math, JSON, String, Object, Array, Number, RegExp,
    Map, Set, isFinite, parseInt, Error,
  }, extra || {});
  sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(FILE, 'utf8'), sb, { filename: FILE });
  return sb;
}

/** 默认环境：AI 可用 + Notes 可用 + Zotero.Items.get 能取到条目 */
function mkEnv(o) {
  const opts = o || {};
  const ai = opts.ai || mkAI(() => '第一节正文');
  const notes = opts.notes || mkNotes();
  const item = { id: 1, libraryID: 1, isRegularItem() { return true; } };
  const Zotero = {
    Items: {
      get(id) { return Number(id) === 1 ? item : null; },
      async getByLibraryAndKey() { return null; },
    },
    logError() {},
  };
  const sb = makeSandbox(Object.assign({ Zotero, AIClient: ai, Notes: notes }, opts.extra || {}));
  return { sb, RW: sb.ReviewWorkbench, ai, notes, item };
}

/* ==================== ① parseOutline ==================== */

{
  const { RW } = mkEnv();
  const o = RW.parseOutline('## 1. 引言\n背景与问题\n\n## 2. 方法比较\n比较各路方法');
  eq(o.length, 2, 'parseOutline 标准两节');
  eq(o[0].n, 1, 'parseOutline 第一节 n=1');
  eq(o[0].title, '引言', 'parseOutline 第一节标题');
  eq(o[0].desc, '背景与问题', 'parseOutline 第一节说明');
  eq(o[1].n, 2, 'parseOutline 第二节 n=2');
  eq(o[1].title, '方法比较', 'parseOutline 第二节标题');
  eq(o[1].desc, '比较各路方法', 'parseOutline 第二节说明');
}

{
  const { RW } = mkEnv();
  const o = RW.parseOutline('## 引言\n背景\n\n## 方法\n比较');
  eq(o.length, 2, 'parseOutline 无编号标题仍解析');
  eq(o[0].n, 1, 'parseOutline 无编号按顺序编号 1');
  eq(o[1].n, 2, 'parseOutline 无编号按顺序编号 2');
}

{
  const { RW } = mkEnv();
  const o = RW.parseOutline('## 1. 第一节\n\n## 2. 第二节\n');
  eq(o.length, 2, 'parseOutline 空行不产生额外节');
  eq(o[0].desc, '', 'parseOutline 说明缺失 → 空串');
  eq(o[1].desc, '', 'parseOutline 第二节说明也空');
}

{
  const { RW } = mkEnv();
  const o = RW.parseOutline('## 1. 研究背景：问题与动机\n说明文字');
  eq(o.length, 1, 'parseOutline 标题内联冒号仍是一节');
  eq(o[0].title, '研究背景', 'parseOutline 内联冒号前为标题');
  eq(o[0].desc, '问题与动机', 'parseOutline 内联冒号后为说明（不覆盖下一行）');
}

{
  const { RW } = mkEnv();
  const o = RW.parseOutline('1. 引言：背景与问题\n2. 方法：比较路线\n3、结论：总结');
  eq(o.length, 3, 'parseOutline 无 ## 退化为按行解析');
  eq(o[0].n, 1, 'parseOutline 行解析 n=1');
  eq(o[0].title, '引言', 'parseOutline 行解析标题');
  eq(o[0].desc, '背景与问题', 'parseOutline 行解析说明');
  eq(o[2].n, 3, 'parseOutline 行解析全角顿号编号');
}

{
  const { RW } = mkEnv();
  eq(RW.parseOutline('').length, 0, 'parseOutline 空输入 → []');
  eq(RW.parseOutline('   \n\n  ').length, 0, 'parseOutline 空白输入 → []');
  eq(RW.parseOutline('抱歉，我无法完成这个请求。').length, 0, 'parseOutline 散文（无序号/无 ##）→ []');
  eq(RW.parseOutline(null).length, 0, 'parseOutline null → []');
}

{
  const { RW } = mkEnv();
  const o = RW.parseOutline('```markdown\n## 1. 引言\n背景\n\n## 2. 方法\n比较\n```');
  eq(o.length, 2, 'parseOutline 自动去 ```markdown 围栏');
}

{
  const { RW } = mkEnv();
  const o = RW.parseOutline('## 1. 引言\n背景\n\n## 2. 参考文献\n[文献 1] …');
  eq(o.length, 1, 'parseOutline 过滤「参考文献」节');
  eq(o[0].title, '引言', 'parseOutline 参考文献节之前的保留');
}

/* ==================== ① buildOutlinePrompt ==================== */

{
  const { RW } = mkEnv();
  const p = RW.buildOutlinePrompt(METAS);
  eq(typeof p, 'object', 'buildOutlinePrompt 返回对象');
  eq(typeof p.system, 'string', 'buildOutlinePrompt system 为字符串');
  has(p.system, '4-7', 'buildOutlinePrompt 要求 4-7 节');
  has(p.system, '## 1.', 'buildOutlinePrompt 规定「## n. 标题」输出格式');
  has(p.user, '3 篇', 'buildOutlinePrompt user 含篇数');
  has(p.user, 'Attention Is All You Need', 'buildOutlinePrompt 含第 1 篇标题');
  has(p.user, 'BERT: Pre-training', 'buildOutlinePrompt 含第 2 篇标题');
  has(p.user, 'Language Models are Few-Shot Learners', 'buildOutlinePrompt 含第 3 篇标题');
  has(p.user, '[文献 1]', 'buildOutlinePrompt 编号从「文献 1」开始');
  has(p.user, '[文献 3]', 'buildOutlinePrompt 覆盖全部编号');
  no(p.user, LONG_ABSTRACT, 'buildOutlinePrompt 摘要截断（不塞全文）');
}

/* ==================== ① buildSectionPrompt ==================== */

{
  const { RW } = mkEnv();
  const p = RW.buildSectionPrompt(METAS, OUTLINE, 1);
  eq(typeof p, 'object', 'buildSectionPrompt 返回对象');
  has(p.system, '文献 n', 'buildSectionPrompt system 含「文献 n」引用约定');
  has(p.system, '禁止', 'buildSectionPrompt system 含「禁止」编造');
  has(p.system, '推断', 'buildSectionPrompt system 含「推断」标注要求');
  has(p.system, '只使用用户给出的文献材料', 'buildSectionPrompt system 限定证据来源');
  has(p.user, '【本节目标】', 'buildSectionPrompt user 含本节目标');
  has(p.user, '第 2 节《方法与证据比较》', 'buildSectionPrompt user 含本节序号与标题');
  has(p.user, '比较不同技术路线的适用条件', 'buildSectionPrompt user 含本节说明');
  has(p.user, '【已完成节标题】', 'buildSectionPrompt user 含已完成节标题');
  has(p.user, '第 1 节《研究背景与问题》', 'buildSectionPrompt 已写节标题含第 1 节');
  no(p.user, '第 3 节《共识、分歧与空白》', 'buildSectionPrompt 不提前泄露后续节');
  has(p.user, '[文献 1]', 'buildSectionPrompt user 含文献 1');
  has(p.user, '[文献 2]', 'buildSectionPrompt user 含文献 2');
  has(p.user, '[文献 3]', 'buildSectionPrompt user 含文献 3');
}

{
  const { RW } = mkEnv();
  const p = RW.buildSectionPrompt(METAS, OUTLINE, 0);
  has(p.user, '本节为首节', 'buildSectionPrompt 首节标注无前序内容');
  no(p.user, '第 1 节《研究背景与问题》（不要重复', 'buildSectionPrompt 首节不把自己的标题列为已完成');
}

{
  const { RW } = mkEnv();
  const p = RW.buildSectionPrompt(METAS, OUTLINE, 2);
  const clipped = LONG_ABSTRACT.slice(0, RW.SECTION_ABSTRACT_CHARS);
  has(p.user, clipped, 'buildSectionPrompt 摘要保留前 200 字');
  no(p.user, LONG_ABSTRACT, 'buildSectionPrompt 摘要超出 200 字被截断');
  eq(RW.buildSectionPrompt(METAS, OUTLINE, 9), null, 'buildSectionPrompt 下标越界 → null');
  eq(RW.buildSectionPrompt(METAS, [], 0), null, 'buildSectionPrompt 空大纲 → null');
}

/* ==================== ① assembleDraft ==================== */

{
  const { RW } = mkEnv();
  const sections = [
    { n: 1, title: '研究背景与问题', text: '第一段正文。' },
    { n: 2, title: '方法与证据比较', text: '第二段正文。' },
    { n: 3, title: '共识、分歧与空白', text: '第三段正文。' },
  ];
  const md = RW.assembleDraft('测试综述', METAS, OUTLINE, sections);
  eq(md.indexOf('# 测试综述'), 0, 'assembleDraft 以「# 标题」开头');
  ok(md.indexOf('## 1. 研究背景与问题') < md.indexOf('## 2. 方法与证据比较'), 'assembleDraft 节序与大纲一致');
  ok(md.indexOf('## 2. 方法与证据比较') < md.indexOf('## 3. 共识、分歧与空白'), 'assembleDraft 第 3 节在最后');
  ok(md.indexOf('第一段正文。') < md.indexOf('第二段正文。'), 'assembleDraft 正文顺序一致');
  has(md, '## 参考文献', 'assembleDraft 末尾附参考文献小节');
  has(md, '[文献 1] Vaswani et al. Attention Is All You Need. NeurIPS, 2017.', 'assembleDraft 参考文献含作者/标题/期刊/年份');
  has(md, '[文献 2] Devlin et al. BERT: Pre-training of Deep Bidirectional Transformers. NAACL, 2019.', 'assembleDraft 第二条参考文献完整');
  has(md, '[文献 3] Brown et al. Language Models are Few-Shot Learners. 年份不详.', 'assembleDraft 缺年份降级为「年份不详」');
  ok(!/et al\.\./.test(md), 'assembleDraft 作者末尾句点不重复');
  ok(md.indexOf('## 参考文献') > md.indexOf('第三段正文。'), 'assembleDraft 参考文献在正文之后');
}

{
  const { RW } = mkEnv();
  // 大纲缺省时按 sections 自身顺序/标题输出（窗口正常路径始终有大纲）
  const md = RW.assembleDraft('', METAS, [], [
    { n: 1, title: 'A', text: '甲' },
    { n: 2, title: 'B', text: '' },
    { n: 3, title: 'C', text: '丙' },
  ]);
  has(md, '# 文献综述', 'assembleDraft 空标题回退默认标题');
  has(md, '## 1. A', 'assembleDraft 正常节保留');
  no(md, '## 2. B', 'assembleDraft 空节不输出标题（避免半截空段）');
  has(md, '## 3. C', 'assembleDraft 失败节之后仍按序输出');
}

/* ==================== ① citeToLink ==================== */

{
  const { RW } = mkEnv();
  const out = RW.citeToLink('已有研究给出结论（文献 2），后续工作延续。', METAS);
  has(out, '[文献 2](zotero://select/library/items/BBBB2222)', 'citeToLink 文献 2 → itemKey 链接');
  has(out, '已有研究给出结论', 'citeToLink 保留正文');

  eq(RW.citeToLink('见文献 9。', METAS), '见文献 9。', 'citeToLink 越界编号保留纯文本');

  const linked = '见[文献 2](https://example.com) 的讨论';
  eq(RW.citeToLink(linked, METAS), linked, 'citeToLink 不重复包裹已在 markdown 链接中的文本');

  const plain = '见[文献 2] 的讨论';
  eq(RW.citeToLink(plain, METAS), '见[文献 2](zotero://select/library/items/BBBB2222) 的讨论',
    'citeToLink 吞掉 AI 的方括号包裹');

  const quoted = '如「文献 3」所述';
  eq(RW.citeToLink(quoted, METAS), '如[文献 3](zotero://select/library/items/CCCC3333)所述',
    'citeToLink 吞掉「」包裹');
}

{
  const { RW } = mkEnv();
  const ten = [];
  for (let i = 1; i <= 10; i++) {
    ten.push({ key: 'KEY' + i + 'XYZ', title: 'Paper ' + i, authors: 'A', year: '2020', journal: 'J' });
  }
  const out = RW.citeToLink('参见文献 10 与文献 1。', ten);
  has(out, '[文献 10](zotero://select/library/items/KEY10XYZ)', 'citeToLink 文献 10 解析为第 10 篇');
  has(out, '[文献 1](zotero://select/library/items/KEY1XYZ)', 'citeToLink 文献 1 仍为第 1 篇');
  no(out, '[文献 1](zotero://select/library/items/KEY10XYZ)', 'citeToLink 不把「文献 10」误伤成「文献 1」+0');
}

{
  const { RW } = mkEnv();
  eq(RW.citeToLink('文献 1 无 key', [{ title: 'X' }]), '文献 1 无 key', 'citeToLink 缺 key → 保留纯文本');
  eq(RW.citeToLink('文献 1', [{ key: 'bad-key!' }]), '文献 1', 'citeToLink key 非法字符 → 保留纯文本');
}

/* ==================== ① stripFences ==================== */

{
  const { RW } = mkEnv();
  eq(RW.stripFences('```markdown\n## 1. 引言\n背景\n```'), '## 1. 引言\n背景', 'stripFences 去 ```markdown 围栏');
  eq(RW.stripFences('```\n纯文本\n```'), '纯文本', 'stripFences 去无语言围栏');
  eq(RW.stripFences('## 1. 引言'), '## 1. 引言', 'stripFences 无围栏原样返回');
  eq(RW.stripFences(''), '', 'stripFences 空输入 → 空串');
}

/* ==================== ② generateOutline ==================== */

(async () => {
  {
    const ai = mkAI(() => '```markdown\n## 1. 引言\n背景\n\n## 2. 方法\n比较\n```');
    const { RW } = mkEnv({ ai });
    const r = await RW.generateOutline(METAS);
    eq(r.ok, true, 'generateOutline 成功 → ok');
    eq(r.outline.length, 2, 'generateOutline 解析出两节');
    eq(r.outline[1].title, '方法', 'generateOutline 第二节标题');
    has(r.raw, '## 1. 引言', 'generateOutline 保留 raw');
    eq(ai.calls.length, 1, 'generateOutline 只调一次 AI');
    eq(ai.calls[0].length, 2, 'generateOutline 传 system+user 两条消息');
    eq(ai.calls[0][0].role, 'system', 'generateOutline 第一条为 system');
    has(ai.calls[0][1].content, '4-7', 'generateOutline user 带格式要求');
  }

  {
    const ai = mkAI(() => '抱歉，我无法完成这个请求。');
    const { RW } = mkEnv({ ai });
    const r = await RW.generateOutline(METAS);
    eq(r.ok, false, 'generateOutline 解析失败 → ok:false');
    eq(r.reason, 'parse_failed', 'generateOutline 解析失败 → reason=parse_failed');
    eq(r.outline, undefined, 'generateOutline 失败不带 outline');
  }

  {
    const ai = mkAI(() => '不该被调用', false);
    const { RW } = mkEnv({ ai });
    const r = await RW.generateOutline(METAS);
    eq(r.ok, false, 'generateOutline 无 Key → ok:false');
    eq(r.reason, 'no_key', 'generateOutline 无 Key → reason=no_key');
    has(r.guidance, 'GUIDE', 'generateOutline 无 Key → 带 guidance');
    eq(ai.calls.length, 0, 'generateOutline 无 Key 不调 AI');
  }

  {
    const ai = mkAI(() => { throw new Error('HTTP 500'); });
    const { RW } = mkEnv({ ai });
    const r = await RW.generateOutline(METAS);
    eq(r.ok, false, 'generateOutline AI 抛错 → ok:false');
    eq(r.reason, 'ai_failed', 'generateOutline AI 抛错 → reason=ai_failed');
    has(r.error, 'HTTP 500', 'generateOutline 保留错误信息');
  }

  {
    const { RW } = mkEnv();
    const r = await RW.generateOutline([]);
    eq(r.reason, 'no_items', 'generateOutline 空题录 → no_items');
  }

  /* ==================== ② draftSections ==================== */

  {
    const ai = mkAI((i) => {
      if (i === 1) throw new Error('第二节失败');
      return '```markdown\n第 ' + (i + 1) + ' 节正文（文献 1）。\n```';
    });
    const { RW } = mkEnv({ ai });
    const progress = [];
    const r = await RW.draftSections(METAS, OUTLINE, function (done, total) {
      progress.push([done, total]);
    });
    eq(r.ok, true, 'draftSections 部分失败 → 整体 ok（有内容）');
    eq(r.sections.length, 2, 'draftSections 跳过失败节，保留其余两节');
    eq(r.sections[0].n, 1, 'draftSections 第一节 n=1');
    eq(r.sections[1].n, 3, 'draftSections 第三节 n=3（不重编号）');
    eq(r.failed.length, 1, 'draftSections failed 记录 1 节');
    eq(r.failed[0], 1, 'draftSections failed 为失败节下标 1');
    eq(progress.length, 3, 'draftSections 每节都回调一次进度（3 次）');
    eq(progress[0][0], 1, 'draftSections 第一次进度 done=1');
    eq(progress[2][1], 3, 'draftSections 进度 total=3');
    eq(ai.calls.length, 3, 'draftSections 失败后继续调用后续节');
    no(r.sections[0].text, '```', 'draftSections 自动去围栏');
  }

  {
    const ai = mkAI(() => { throw new Error('全部失败'); });
    const { RW } = mkEnv({ ai });
    const progress = [];
    const r = await RW.draftSections(METAS, OUTLINE, (d) => progress.push(d));
    eq(r.ok, false, 'draftSections 全部失败 → ok:false');
    eq(r.failed.length, 3, 'draftSections 全部失败 → failed=3');
    eq(progress.length, 3, 'draftSections 全部失败仍逐节回调进度');
  }

  {
    const { RW } = mkEnv();
    let calls = 0;
    const r = await RW.draftSections(METAS, [], () => { calls++; });
    eq(r.ok, false, 'draftSections 空大纲 → ok:false');
    eq(r.reason, 'no_outline', 'draftSections 空大纲 → reason=no_outline');
    eq(calls, 0, 'draftSections 空大纲不回调进度');
  }

  {
    const ai = mkAI(() => '不该被调用', false);
    const { RW } = mkEnv({ ai });
    const r = await RW.draftSections(METAS, OUTLINE, () => {});
    eq(r.reason, 'no_key', 'draftSections 无 Key → no_key');
    eq(ai.calls.length, 0, 'draftSections 无 Key 不调 AI');
  }

  /* ==================== ② saveAsNote ==================== */

  {
    const notes = mkNotes();
    const { RW, item } = mkEnv({ notes });
    const r = await RW.saveAsNote(METAS, '# 标题\n\n正文', '测试综述');
    eq(r.ok, true, 'saveAsNote 成功 → ok');
    eq(r.noteID, 777, 'saveAsNote 返回 noteID');
    eq(notes.calls.length, 1, 'saveAsNote 调一次 createFromMarkdown');
    eq(notes.calls[0].argc, 4, 'saveAsNote 传四参 (item,title,md,opts)');
    ok(notes.calls[0].opts && typeof notes.calls[0].opts.transformHtml === 'function',
      'saveAsNote 传 transformHtml（落盘前一次成型，免二次写盘）');
    eq(notes.calls[0].item, item, 'saveAsNote 第一参为回查到的条目');
    eq(notes.calls[0].title, '测试综述', 'saveAsNote 标题透传');
    eq(notes.calls[0].md, '# 标题\n\n正文', 'saveAsNote 正文透传');
  }

  {
    const { RW } = makeSandboxEnv({ withNotes: false });
    const r = await RW.saveAsNote(METAS, '正文', '测试综述');
    eq(r.ok, false, 'saveAsNote Notes 缺失 → ok:false');
    eq(r.reason, 'notes_unavailable', 'saveAsNote Notes 缺失 → notes_unavailable');
  }

  {
    const Zotero = { Items: { get() { return null; } }, logError() {} };
    const notes = mkNotes();
    const sb = makeSandbox({ Zotero, AIClient: mkAI(() => 'x'), Notes: notes });
    const r = await sb.ReviewWorkbench.saveAsNote(METAS, '正文', '测试综述');
    eq(r.ok, false, 'saveAsNote 找不到条目 → ok:false');
    eq(r.reason, 'no_item', 'saveAsNote 找不到条目 → no_item');
    eq(notes.calls.length, 0, 'saveAsNote 无条目不落笔记');
  }

  {
    const notes = mkNotes();
    const { RW } = mkEnv({ notes });
    const r = await RW.saveAsNote(METAS, '   ', '测试综述');
    eq(r.reason, 'empty_draft', 'saveAsNote 空草稿 → empty_draft');
  }

  {
    // MdLite 不渲染 Markdown 链接 → 保存后应就地把字面引用改成 <a>（笔记内可点击）
    const noteObj = {
      id: 888,
      saves: 0,
      html: '<h2>测试综述</h2><p>[文献 1](zotero://select/library/items/AAAA1111) 给出了结论。</p>',
      getNote() { return this.html; },
      setNote(h) { this.html = h; },
      async saveTx() { this.saves++; },
    };
    const Notes = {
      createFromMarkdown: async function (item, title, md, opts) {
        // 模拟 utils.js：落盘前应用 transformHtml，然后只保存一次
        let html = noteObj.html;
        if (opts && typeof opts.transformHtml === 'function') html = opts.transformHtml(html);
        noteObj.setNote(html);
        await noteObj.saveTx();
        return noteObj;
      },
    };
    const sb = makeSandbox({
      Zotero: { Items: { get() { return { id: 1 }; } }, logError() {} },
      AIClient: mkAI(() => 'x'), Notes,
    });
    const r = await sb.ReviewWorkbench.saveAsNote(METAS, '正文', '测试综述');
    eq(r.ok, true, 'saveAsNote 链接化路径仍 ok');
    has(noteObj.html, '<a href="zotero://select/library/items/AAAA1111">文献 1</a>',
      'saveAsNote 把字面引用改成可点击 <a>');
    eq(noteObj.saves, 1, 'saveAsNote 单次写盘（0.54.0 取消二次 setNote）');
  }

  /* ==================== ③ 窗口资源 ==================== */

  {
    const xhtml = fs.readFileSync(XHTML, 'utf8');
    for (const id of ['pp-rw-root', 'pp-rw-list', 'pp-rw-outline', 'pp-rw-draft',
      'pp-rw-gen-outline', 'pp-rw-gen-draft', 'pp-rw-save', 'pp-rw-export',
      'pp-rw-status', 'pp-rw-hint', 'pp-rw-count', 'pp-rw-doctitle']) {
      has(xhtml, 'id="' + id + '"', 'xhtml 含关键 id：' + id);
    }
    has(xhtml, 'windowtype="paperpilot:review-workbench"', 'xhtml windowtype 与 WINDOW_TYPE 一致');
    has(xhtml, 'no-native="true"', 'xhtml textarea 带 no-native（win 皮肤三保险）');
  }

  /* ==================== 汇总 ==================== */

  if (fails.length) {
    console.error('\n✗ 综述工作台测试失败 ' + fails.length + ' 项（通过 ' + pass + '）：');
    for (const f of fails) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('✓ 综述工作台测试全部通过：' + pass + ' 项断言');
})();

/** 仅提供「无 Notes」的沙箱（用于 notes_unavailable 分支） */
function makeSandboxEnv(o) {
  const opts = o || {};
  const extra = { Zotero: { Items: { get() { return { id: 1 }; } }, logError() {} }, AIClient: mkAI(() => 'x') };
  if (opts.withNotes !== false) extra.Notes = mkNotes();
  const sb = makeSandbox(extra);
  return { sb, RW: sb.ReviewWorkbench };
}
