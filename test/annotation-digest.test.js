#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 标注 → 论点速记（AnnotationDigest，0.52.0）测试
 *
 * 覆盖：
 *   ① collect：PDF 附件定位（无 PDF → no_pdf）、字段映射与空标注过滤、
 *      pageLabel 保留、70 条截断到 60 且 total=70、getAnnotations 抛错 → 空数组 + reason；
 *   ② buildPrompt：题录（标题/作者/年份）与逐条编号 + 页码、证据纪律文案、
 *      标注 <3 条时走「要点清单」分支（≥3 条不走）；
 *   ③ run：dryRun 不落盘、正常路径 Notes 三参 + 去围栏、AI 抛错 → ai_failed、
 *      Notes 缺位 → notes_unavailable 兜底 markdown、无标注不调 AI。
 *
 * 运行：node test/annotation-digest.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'chrome', 'content', 'scripts', 'features', 'annotation-digest.js');

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  <- ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }
function has(s, sub, label) { return ok(String(s || '').indexOf(sub) >= 0, label, { missing: sub }); }
function no(s, sub, label) { return ok(String(s || '').indexOf(sub) < 0, label, { unexpected: sub }); }

/* ---------------- 桩环境 ---------------- */

/** 附件桩：anns 为原始注解对象数组，throwAnn 模拟 getAnnotations 失败 */
function mkAtt(id, anns, o) {
  const opts = o || {};
  return {
    id: id,
    parentID: 100,
    attachmentContentType: opts.contentType === undefined ? 'application/pdf' : opts.contentType,
    isPDFAttachment() { return this.attachmentContentType === 'application/pdf'; },
    getAnnotations() {
      if (opts.throwAnn) throw new Error('annotation store broken');
      return anns || [];
    },
  };
}

/** 常规条目桩；atts 为附件数组 */
function mkItem(atts, meta) {
  const m = meta || {};
  return {
    id: 100,
    libraryID: 1,
    isRegularItem() { return true; },
    getAttachments() { return (atts || []).map((a) => a.id); },
    getField(f) { return m[f] || ''; },
    getCreators() { return m.creators || [{ firstName: 'Ada', lastName: 'Lovelace' }]; },
    getDisplayTitle() { return m.title || ''; },
  };
}

function mkAnn(text, comment, page, color) {
  return {
    annotationText: text,
    annotationComment: comment,
    annotationPageLabel: page === undefined ? '' : page,
    annotationColor: color === undefined ? '' : color,
  };
}

/** 记录型 AIClient 桩（返回固定带围栏的 Markdown；或抛错/返回空） */
function mkAIClient(mode) {
  const calls = [];
  return {
    calls,
    chat: async function (messages, opts2) {
      calls.push({ messages, opts: opts2, argc: arguments.length });
      if (mode === 'throw') throw new Error('HTTP 500');
      if (mode === 'empty') return '   \n';
      return '```markdown\n## 论文速记：测试论文\n### 核心论点\n- 论点 1（标注 1 支持）\n```';
    },
  };
}

/** 记录型 Notes 桩（普通函数，非箭头） */
function mkNotes(mode) {
  const calls = [];
  return {
    calls,
    createFromMarkdown: async function (item, title, md) {
      calls.push({ item, title, md, argc: arguments.length });
      if (mode === 'throw') throw new Error('save failed');
      return { id: 777 };
    },
  };
}

const FIXED_MD = '## 论文速记：测试论文\n### 核心论点\n- 论点 1（标注 1 支持）';

function makeSandbox(extra) {
  const sb = Object.assign({
    console,
    setTimeout, clearTimeout,
    Promise, Date, Math, JSON, String, Object, Array, Number, RegExp,
  }, extra || {});
  sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(FILE, 'utf8'), sb, { filename: FILE });
  return sb;
}

/** 带 3 条有效标注的常规标准环境 */
function mkEnv(o) {
  const opts = o || {};
  const att = mkAtt(11, opts.anns === undefined
    ? [mkAnn('Attention is all you need.', '核心假设', '3', '#ffd400'),
       mkAnn('   ', '   ', '4', '#ff6666'),
       mkAnn('', '只有批注没有原文', '5', '#ff6666'),
       mkAnn('Scaling laws hold.', '', '7', '#2ea8e5')]
    : opts.anns, opts.attOpts);
  const item = mkItem(opts.atts === undefined ? [att] : opts.atts,
    { title: 'Test Paper', date: '2021-05-01', publicationTitle: 'Journal of Tests' });
  const ai = mkAIClient(opts.aiMode);
  const notes = mkNotes(opts.notesMode);
  const byId = new Map();
  for (const a of (opts.atts === undefined ? [att] : opts.atts)) byId.set(a.id, a);
  const Zotero = { Items: { get: (id) => byId.get(id) || null }, debug() {}, logError() {} };
  const Chat = { paperMeta: () => ({ title: 'Test Paper', creators: 'Ada Lovelace', year: '2021', pub: 'Journal of Tests' }) };
  const sb = makeSandbox({ Zotero, AIClient: ai, Notes: notes, Chat });
  return { sb, AD: sb.AnnotationDigest, item, att, ai, notes };
}

/* ==================== ① collect ==================== */

(async () => {
  {
    const { AD, item } = mkEnv();
    const r = await AD.collect(item);
    eq(r.ok, true, '① 有 PDF → ok');
    eq(r.annotations.length, 3, '① 空标注（原文+批注全空）被过滤：4 条 → 3 条');
    eq(r.total, 3, '① total 等于过滤后的条数');
    const a0 = r.annotations[0];
    eq(a0.text, 'Attention is all you need.', '① text 映射');
    eq(a0.comment, '核心假设', '① comment 映射');
    eq(a0.pageLabel, '3', '① pageLabel 原样保留（字符串）');
    eq(a0.color, '#ffd400', '① color 映射');
    const a1 = r.annotations[1];
    eq(a1.text, '', '① 仅批注的标注 text 为空串');
    eq(a1.comment, '只有批注没有原文', '① 仅批注的标注保留 comment');
    eq(a1.pageLabel, '5', '① 仅批注标注的 pageLabel 保留');
    const a2 = r.annotations[2];
    eq(a2.text, 'Scaling laws hold.', '① 仅原文的标注 text 映射');
    eq(a2.comment, '', '① 仅原文的标注 comment 为空串');
    eq(a2.pageLabel, '7', '① 第三条 pageLabel 保留');
  }

  {
    const { AD, item } = mkEnv({ atts: [] });
    const r = await AD.collect(item);
    eq(r.ok, false, '① 无附件 → ok:false');
    eq(r.reason, 'no_pdf', '① 无附件 → reason=no_pdf');
    eq(r.annotations.length, 0, '① 无附件 → 空数组');
    eq(r.total, 0, '① 无附件 → total=0');
  }

  {
    // 有附件但不是 PDF → 同样 no_pdf
    const txt = mkAtt(12, [], { contentType: 'text/html' });
    const { AD, item } = mkEnv({ atts: [txt] });
    const r = await AD.collect(item);
    eq(r.reason, 'no_pdf', '① 非 PDF 附件不算数 → no_pdf');
  }

  {
    const anns = [];
    for (let i = 0; i < 70; i++) anns.push(mkAnn('quote ' + i, '', String(i + 1), '#ffd400'));
    const { AD, item } = mkEnv({ anns });
    const r = await AD.collect(item);
    eq(r.annotations.length, 60, '① 70 条截断到 MAX_NOTES=60');
    eq(r.total, 70, '① total 保留截断前原始条数 70');
    eq(r.annotations[59].text, 'quote 59', '① 保留前 60 条（顺序不变）');
  }

  {
    const { AD, item } = mkEnv({ attOpts: { throwAnn: true } });
    const r = await AD.collect(item);
    eq(r.ok, true, '① getAnnotations 抛错不冒泡 → ok:true（PDF 存在）');
    eq(r.annotations.length, 0, '① getAnnotations 抛错 → 空数组');
    eq(r.reason, 'annotations_error', '① getAnnotations 抛错 → reason=annotations_error');
    has(r.error, 'annotation store broken', '① 抛错信息保留在 error');
  }

  {
    // 多附件：第一个是 PDF 就用它；非 PDF 排在前面要跳过
    const html = mkAtt(21, [], { contentType: 'text/html' });
    const pdf = mkAtt(22, [mkAnn('from second att', '', '9', '')]);
    const { AD, item } = mkEnv({ atts: [html, pdf] });
    const r = await AD.collect(item);
    eq(r.annotations.length, 1, '① 跳过非 PDF 附件，取第一个 PDF');
    eq(r.annotations[0].text, 'from second att', '① 取到 PDF 附件的标注');
  }

  /* ==================== ② buildPrompt ==================== */

  {
    const { AD } = mkEnv();
    const meta = { title: 'Test Paper', creators: 'Ada Lovelace', year: '2021', pub: 'Journal of Tests' };
    const anns = [
      { text: 'Quote A', comment: 'note A', pageLabel: '3', color: '#ffd400' },
      { text: 'Quote B', comment: '', pageLabel: '12', color: '' },
      { text: 'Quote C', comment: 'note C', pageLabel: '', color: '' },
      { text: 'Quote D', comment: '', pageLabel: '20', color: '' },
    ];
    const p = AD.buildPrompt(meta, anns);
    eq(typeof p, 'object', '② 返回对象');
    eq(typeof p.system, 'string', '② system 为字符串');
    eq(typeof p.user, 'string', '② user 为字符串');
    has(p.user, 'Test Paper', '② 题录：标题');
    has(p.user, 'Ada Lovelace', '② 题录：作者');
    has(p.user, '2021', '② 题录：年份');
    has(p.user, 'Journal of Tests', '② 题录：来源');
    has(p.user, '[1] (p.3)', '② 标注 1 编号 + 页码');
    has(p.user, '[2] (p.12)', '② 标注 2 编号 + 页码');
    has(p.user, '[3] (页码未标注)', '② 无页码 → 「页码未标注」');
    has(p.user, '[4] (p.20)', '② 标注 4 编号 + 页码');
    has(p.user, 'Quote A', '② 含标注原文');
    has(p.user, '批注：note A', '② 含用户批注');
    has(p.system, '禁止引入标注外的内容', '② 证据纪律：禁止引入标注外内容');
    has(p.system, '页码必须原样引用', '② 证据纪律：页码原样引用');
    has(p.system, '推断', '② 证据纪律：要求区分推断');
    has(p.user, '### 核心论点', '② 输出契约：核心论点段');
    has(p.user, '### 证据与出处', '② 输出契约：证据与出片段');
    has(p.user, '### 我的批注要点', '② 输出契约：批注要点段');
    has(p.user, '### 待追问', '② 输出契约：待追问段');
    has(p.user, '2-5', '② 要求论点 2-5 条');
    has(p.user, '（标注 1、3 支持）', '② 论点挂标注编号的写法');
    no(p.user, '### 要点清单', '② 4 条标注 → 不走「要点清单」分支');
    ok(p.user.indexOf('## 论文速记：Test Paper') >= 0, '② 标题原样进输出契约');
  }

  {
    const { AD } = mkEnv();
    const p = AD.buildPrompt({ title: 'T', creators: 'A', year: '2020' }, [
      { text: 'Q1', comment: '', pageLabel: '1', color: '' },
      { text: 'Q2', comment: '', pageLabel: '2', color: '' },
    ]);
    has(p.user, '### 要点清单', '② 2 条标注 → 出现「要点清单」分支');
    has(p.user, '不要硬造论点', '② 2 条标注 → 明确禁止硬造论点');
    has(p.user, '少于 3 条', '② 2 条标注 → 说明少于 3 条的处理方式');
    no(p.user, '论点写 2-5 条', '② 2 条标注不要求 2-5 条论点');
  }

  {
    const { AD } = mkEnv();
    const p = AD.buildPrompt({}, []);
    eq(typeof p.system, 'string', '② 空入参也不抛错');
    has(p.user, '（未命名文献）', '② 无标题 → 占位「（未命名文献）」');
    has(p.user, '（无）', '② 无标注 → 标注清单占位');
  }

  /* ==================== ③ run ==================== */

  {
    const { AD, item, ai, notes } = mkEnv();
    const r = await AD.run(item, { dryRun: true });
    eq(r.ok, true, '③ dryRun → ok');
    eq(r.dryRun, true, '③ dryRun 标记');
    eq(r.markdown, FIXED_MD, '③ dryRun 返回去围栏后的 markdown');
    eq(r.noteID, null, '③ dryRun 无 noteID');
    eq(notes.calls.length, 0, '③ dryRun 不落盘（Notes 调用数 = 0）');
    eq(ai.calls.length, 1, '③ dryRun 仍调用 AI 一次');
    eq(r.title, '论文速记（AI 整理）', '③ 返回笔记标题');
    eq(r.total, 3, '③ 返回标注总数');
  }

  {
    const { AD, item, ai, notes } = mkEnv();
    const r = await AD.run(item);
    eq(r.ok, true, '③ 正常路径 → ok');
    eq(r.noteID, 777, '③ 返回 noteID');
    eq(notes.calls.length, 1, '③ Notes 被调用一次');
    const c = notes.calls[0];
    eq(c.argc, 3, '③ Notes 收到三个参数');
    eq(c.item, item, '③ 第一参 = parentItem（条目本身，由 Notes 决定挂载）');
    eq(c.title, '论文速记（AI 整理）', '③ 第二参 = 固定标题');
    eq(c.md, FIXED_MD, '③ 第三参 = 去围栏 markdown');
    no(c.md, '```', '③ 落盘 markdown 不含围栏');
    has(c.md, '## 论文速记：测试论文', '③ 落盘 markdown 保留正文');
    eq(ai.calls[0].argc, 1, '③ AIClient.chat 以 messages 单参调用');
    const msgs = ai.calls[0].messages;
    eq(msgs.length, 2, '③ 消息两条');
    eq(msgs[0].role, 'system', '③ 第一条为 system');
    eq(msgs[1].role, 'user', '③ 第二条为 user');
    has(msgs[1].content, 'Test Paper', '③ user 消息含题录标题');
    has(msgs[1].content, '[1] (p.3)', '③ user 消息含标注编号与页码');
  }

  {
    const { AD, item, notes } = mkEnv({ aiMode: 'throw' });
    const r = await AD.run(item);
    eq(r.ok, false, '③ AI 抛错 → ok:false');
    eq(r.reason, 'ai_failed', '③ AI 抛错 → reason=ai_failed');
    has(r.error, 'HTTP 500', '③ AI 错误信息透传');
    eq(notes.calls.length, 0, '③ AI 失败不落盘');
  }

  {
    const { AD, item } = mkEnv({ aiMode: 'empty' });
    const r = await AD.run(item);
    eq(r.reason, 'ai_failed', '③ AI 返回空白 → ai_failed');
  }

  {
    // 独立沙箱：故意不注入 Notes，验证兜底返回 markdown
    const att = mkAtt(11, [mkAnn('x', '', '1', '')]);
    const sb2 = makeSandbox({
      Zotero: { Items: { get: () => att }, debug() {}, logError() {} },
      AIClient: mkAIClient(),
      Chat: { paperMeta: () => ({ title: 'T', creators: 'A', year: '2021', pub: '' }) },
    });
    const r = await sb2.AnnotationDigest.run(mkItem([att]));
    eq(r.ok, false, '③ Notes 缺位 → ok:false');
    eq(r.reason, 'notes_unavailable', '③ Notes 缺位 → reason=notes_unavailable');
    eq(r.markdown, FIXED_MD, '③ Notes 缺位 → 仍返回 markdown 供调用方兜底');
    eq(r.title, '论文速记（AI 整理）', '③ Notes 缺位仍返回标题');
  }

  {
    const env = mkEnv({ anns: [] });
    const r = await env.AD.run(env.item);
    eq(r.ok, false, '③ 无标注 → ok:false');
    eq(r.reason, 'no_annotations', '③ 无标注 → reason=no_annotations');
    eq(r.message, '无标注：请先在 PDF 里高亮或加批注', '③ 无标注 → 明确文案');
    eq(env.ai.calls.length, 0, '③ 无标注不调用 AI');
    eq(env.notes.calls.length, 0, '③ 无标注不落盘');
  }

  {
    const env = mkEnv({ atts: [] });
    const r = await env.AD.run(env.item);
    eq(r.ok, false, '③ 无 PDF → ok:false');
    eq(r.reason, 'no_pdf', '③ 无 PDF → reason=no_pdf');
    has(r.message, '未找到 PDF', '③ 无 PDF → 明确文案');
    eq(env.ai.calls.length, 0, '③ 无 PDF 不调用 AI');
  }

  {
    const env = mkEnv({ aiMode: 'throw' });
    env.sb.Zotero.Items.get = () => null; // 模拟 Zotero.Items.get 异常返回
    const r = await env.AD.run(env.item);
    eq(r.reason, 'no_pdf', '③ 附件查不到 → no_pdf（不抛错）');
  }

  {
    // cleanMarkdown 边界：无围栏原样、只有首行围栏、空输入
    const { AD } = mkEnv();
    eq(AD.cleanMarkdown('## A\n- b'), '## A\n- b', '③ 无围栏原样返回');
    eq(AD.cleanMarkdown('```\n## A\n```'), '## A', '③ 无语言标记围栏也能去掉');
    eq(AD.cleanMarkdown(''), '', '③ 空输入 → 空串');
    eq(AD.cleanMarkdown(null), '', '③ null → 空串');
    eq(AD.cleanMarkdown('```markdown\n## A\n- b'), '## A\n- b', '③ 半截围栏（模型截断）去掉起始行');
    eq(AD.MENU_ID, 'annotation-digest', '③ MENU_ID 稳定');
    eq(AD.MAX_NOTES, 60, '③ MAX_NOTES=60');
  }

  /* ---------------- 输出 ---------------- */
  console.log('='.repeat(60));
  if (fails.length) {
    for (const f of fails) console.log('  x ' + f);
    console.log('-'.repeat(60));
  }
  console.log('标注→论点速记测试：' + pass + ' 通过 / ' + fails.length + ' 失败');
  console.log('='.repeat(60));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.error('测试执行异常：', e);
  process.exit(1);
});
