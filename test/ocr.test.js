#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* OCR（PDF 无头渲染 + 视觉转写 + 文本回退，0.63.0）独立验收测试
 *
 * 覆盖四段：
 *   ① 静态纪律：侧车写入不得传 mode（IOUtils.writeUTF8 只传 2 参）、只发一页图、
 *      渲染引擎加载失败不阻断启动（main.js）、vendor/pdfjs 三个文件与 Apache-2.0 许可头；
 *   ② 纯函数：clampScale / mergePages / joinPages / sidecarName —— 含 0、负数、超界、
 *      字符串、NaN、非字符串值、乱序页号、非法页号、路径穿越字符；
 *   ③ 侧车 IO：坏 JSON / 空文件 / 缺字段 / 非法页号 → 空结构且**不抛错**；
 *      writeUTF8 的实参个数（不传 mode）与载荷形状（version/updatedAt/engine/pages）；
 *   ④ AIChat.getFullText 回退契约：索引为空才回退、OCR 文本不进 _textCache、
 *      索引非空绝不混 OCR（用计数桩证明 textFor 未被调用）；外加一次
 *      「真 OcrService 写侧车 → getFullText 读到」的集成链路。
 *
 * 约束：不联网、不启动 Zotero、不改生产代码。运行：node test/ocr.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const P = (rel) => path.join(ROOT, rel);
const OCR_SRC = P('chrome/content/scripts/features/ocr.js');
const CHAT_SRC = P('chrome/content/scripts/ai/chat.js');
const MAIN_SRC = P('chrome/content/scripts/main.js');

let pass = 0;
const fails = [];
function ok(cond, label, extra) {
  if (cond) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  <- ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) {
  return ok(a === b, label, { got: a, want: b });
}
function has(hay, needle, label) {
  return ok(String(hay).indexOf(needle) >= 0, label,
    { want: needle, got: String(hay).slice(0, 240) });
}
function eqJson(a, b, label) {
  return eq(JSON.stringify(a), JSON.stringify(b), label);
}

const read = (f) => fs.readFileSync(f, 'utf8');

/* ==================== ① 静态纪律 ==================== */

function testStatic() {
  const ocr = read(OCR_SRC);

  // 侧车写入：必须 IOUtils.writeUTF8(path, json)，**不得**传第三个 mode 参数
  has(ocr, 'IOUtils.writeUTF8(path, JSON.stringify(payload))',
    '① writeSidecar 走 IOUtils.writeUTF8(path, json)');
  ok(!/writeUTF8\([^)\n]*,[^)\n]*,/.test(ocr),
    '① writeUTF8 调用不得出现第三个实参（mode 传数字会「报告成功但没产出文件」）');
  ok(!/mode\s*:/.test(ocr.slice(ocr.indexOf('writeSidecar'), ocr.indexOf('async textFor'))),
    '① writeSidecar 内不得出现 mode 选项');

  // 隐私口径：只发当前页一张图
  const ask = ocr.slice(ocr.indexOf('async askVision'), ocr.indexOf('/* ==================== 运行时：侧车读写'));
  eq((ask.match(/type:\s*"image_url"/g) || []).length, 1, '① askVision 只放一张图（当前页）');
  ok(!/base64/.test(ask.split('data:image/jpeg;base64,')[0].replace(/base64Jpeg|b64/g, '')),
    '① askVision 除当前页图片外不携带其它 base64');
  has(ocr, '只发送**当前页的 JPEG base64**', '① 隐私口径写在文件头（可审计）');

  // 渲染失败必须可读降级，不能静默
  has(ocr, 'OCR_RENDER_UNAVAILABLE', '① 渲染不可用有明确错误码');
  has(ocr, '"direct", "blob", "inline"', '① worker 三种加载方式逐级降级');

  // main.js：pdf.js 加载必须在模块循环之前，且 try/catch 包裹（失败不阻断启动）
  const main = read(MAIN_SRC);
  const idxPdf = main.indexOf('vendor/pdfjs/pdf.min.js');
  const idxLoop = main.indexOf('for (const f of files)');
  ok(idxPdf > 0, '① main.js 引用了 vendor/pdfjs/pdf.min.js');
  ok(idxPdf < idxLoop, '① pdf.js 在模块循环之前加载');
  const beforeLoop = main.slice(0, idxLoop);
  ok(/try\s*\{[\s\S]*vendor\/pdfjs\/pdf\.min\.js[\s\S]*\}\s*catch/.test(beforeLoop),
    '① pdf.js 加载被 try/catch 包裹（失败不阻断启动）');
  has(main, 'this.ocr = (typeof OcrService !== "undefined") ? OcrService : null',
    '① OcrService 暴露为 Zotero.Papilot.ocr（加载失败置 null 防崩）');
  has(main, '"features/ocr.js"', '① features/ocr.js 在模块清单中');

  // vendor：三个文件 + Apache-2.0
  for (const f of ['pdf.min.js', 'pdf.worker.min.js', 'LICENSE']) {
    ok(fs.existsSync(P('chrome/content/vendor/pdfjs/' + f)), '① vendor/pdfjs/' + f + ' 存在');
  }
  has(read(P('chrome/content/vendor/pdfjs/LICENSE')), 'Apache License', '① pdfjs LICENSE 为 Apache-2.0');
  has(read(P('THIRD-PARTY-NOTICES.md')), 'pdf.js', '① THIRD-PARTY-NOTICES 记录了 pdf.js');
}

/* ==================== 沙箱：真 OcrService ==================== */

function makeOcrSandbox() {
  /** 虚拟文件系统：path → 文本内容 */
  const files = new Map();
  const writeCalls = [];
  const readCalls = [];
  const io = {
    exists: async (p) => files.has(p),
    readUTF8: async (p) => {
      readCalls.push(p);
      if (!files.has(p)) throw new Error('ENOENT ' + p);
      return files.get(p);
    },
    writeUTF8: async (...args) => {
      writeCalls.push(args);
      files.set(args[0], args[1]);
    },
    makeDirectory: async () => {},
    read: async () => new Uint8Array([1, 2, 3]),
  };
  const sandbox = {
    console, Promise, Number, String, Object, Math, JSON, Set, Map, Date, RegExp,
    Array, isFinite, parseInt, parseFloat,
    IOUtils: io,
    PathUtils: { join: (a, b) => String(a).replace(/\/+$/, '') + '/' + String(b) },
    Zotero: {
      DataDirectory: { dir: '/data' },
      Items: { get: (id) => (id === 5 ? { key: 'ITEM1' } : null) },
      debug: () => {},
      logError: () => {},
      getMainWindow: () => null,
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read(OCR_SRC), sandbox, { filename: 'ocr.js' });
  return { O: sandbox.OcrService, files, writeCalls, readCalls, sandbox };
}

const S = makeOcrSandbox();
const O = S.O;

const attStub = { id: 7, key: 'ATT1', parentItemID: 5 };

/* ==================== ② 纯函数 ==================== */

function testClampScale() {
  eq(O.DEFAULT_SCALE, 2, '② DEFAULT_SCALE = 2.0');
  eq(O.clampScale(0), 2, '② clampScale(0) → 回落 2.0');
  eq(O.clampScale(-1), 2, '② clampScale(-1) → 回落 2.0');
  eq(O.clampScale(-0.5), 2, '② clampScale(-0.5) → 回落 2.0');
  eq(O.clampScale(99), 3, '② clampScale(99) → 收到 MAX 3.0');
  eq(O.clampScale(0.1), 0.8, '② clampScale(0.1) → 收到 MIN 0.8');
  eq(O.clampScale(3), 3, '② clampScale(3) 边界值保持');
  eq(O.clampScale(0.8), 0.8, '② clampScale(0.8) 边界值保持');
  eq(O.clampScale('2.5'), 2.5, '② clampScale("2.5") → 2.5（pref 是字符串）');
  eq(O.clampScale('0'), 2, '② clampScale("0") → 2（字符串零也算非法）');
  eq(O.clampScale(''), 2, '② clampScale("") → 2');
  eq(O.clampScale('abc'), 2, '② clampScale("abc") → 2（NaN 回落）');
  eq(O.clampScale(NaN), 2, '② clampScale(NaN) → 2');
  eq(O.clampScale(undefined), 2, '② clampScale(undefined) → 2');
  eq(O.clampScale(null), 2, '② clampScale(null) → 2');
  eq(O.clampScale(Infinity), 2, '② clampScale(Infinity) → 2（非有限值回落）');
  eq(O.clampScale({}), 2, '② clampScale({}) → 2（对象 NaN 回落）');
  // 布尔不是 pref 的合法类型，但必须落在合法区间内而不是 NaN/越界
  const b = O.clampScale(true);
  ok(b >= O.MIN_SCALE && b <= O.MAX_SCALE, '② clampScale(true) 落在 [0.8,3] 内（实测 ' + b + '）');
}

/* 设置面板与识别流程共用的两个钳制函数（0.63.0）：
 * 面板若放行 0 页 / 非法倍率，用户会看到「点了没反应」——所以判定放在 OcrService 上、
 * 由 test 覆盖，面板只是调用方。 */
function testPanelClamps() {
  eq(O.DEFAULT_MAX_PAGES, 30, '② DEFAULT_MAX_PAGES = 30');
  eq(O.clampMaxPages(0), 30, '② clampMaxPages(0) → 回落 30');
  eq(O.clampMaxPages('0'), 30, '② clampMaxPages("0") → 回落 30（字符串零同样非法）');
  eq(O.clampMaxPages(-5), 30, '② clampMaxPages(-5) → 回落 30');
  eq(O.clampMaxPages(''), 30, '② clampMaxPages("") → 回落 30');
  eq(O.clampMaxPages('abc'), 30, '② clampMaxPages("abc") → 回落 30');
  eq(O.clampMaxPages(NaN), 30, '② clampMaxPages(NaN) → 回落 30');
  eq(O.clampMaxPages(undefined), 30, '② clampMaxPages(undefined) → 回落 30');
  eq(O.clampMaxPages(1), 1, '② clampMaxPages(1) 下界保持');
  eq(O.clampMaxPages(500), 500, '② clampMaxPages(500) 上界保持');
  eq(O.clampMaxPages(9999), 500, '② clampMaxPages(9999) → 收到 500');
  eq(O.clampMaxPages('12'), 12, '② clampMaxPages("12") → 12（pref 是字符串）');
  eq(O.clampMaxPages(12.6), 13, '② clampMaxPages(12.6) → 四舍五入 13');

  eq(O.pickScale('1.5'), '1.5', '② pickScale("1.5") 合法');
  eq(O.pickScale('2'), '2', '② pickScale("2") 合法');
  eq(O.pickScale('3'), '3', '② pickScale("3") 合法');
  eq(O.pickScale(2), '2', '② pickScale(2) → "2"（数字也接受，返回字符串 pref 值）');
  eq(O.pickScale('2.5'), '2', '② pickScale("2.5") 非三档 → 回落 "2"');
  eq(O.pickScale('abc'), '2', '② pickScale("abc") → "2"');
  eq(O.pickScale(''), '2', '② pickScale("") → "2"');
  eq(O.pickScale(null), '2', '② pickScale(null) → "2"');
}

function testMergePages() {
  const r1 = O.mergePages({ 3: 'c', 1: 'a' }, { 2: 'b' });
  eqJson(Object.keys(r1.pages), ['1', '2', '3'], '② mergePages 乱序页号 → 升序');
  eq(r1.count, 3, '② mergePages count = 3');
  eq(r1.pages['2'], 'b', '② mergePages 值落位');

  const r2 = O.mergePages({ 1: 'old' }, { 1: 'new' });
  eq(r2.pages['1'], 'new', '② mergePages incoming 覆盖同页');
  eq(r2.count, 1, '② mergePages 覆盖后 count 不变');

  const r3 = O.mergePages({ 0: 'z', '-2': 'n', abc: 'x', 1: 'a' }, null);
  eqJson(Object.keys(r3.pages), ['1'], '② mergePages 丢弃非法页号（0 / 负数 / 非数字）');
  eq(r3.count, 1, '② mergePages 非法页号不计入 count');

  const r4 = O.mergePages({ 1: 123, 2: null, 3: {}, 4: ['x'], 5: 'ok' }, null);
  eqJson(Object.keys(r4.pages), ['5'], '② mergePages 丢弃非字符串值');
  eq(r4.pages['5'], 'ok', '② mergePages 保留字符串值');

  eqJson(O.mergePages(null, null), { pages: {}, count: 0 }, '② mergePages(null,null) → 空结构');
  eqJson(O.mergePages(undefined), { pages: {}, count: 0 }, '② mergePages(undefined) → 空结构');
  eqJson(O.mergePages('abc'), { pages: {}, count: 0 }, '② mergePages("abc") → 空结构（非对象输入）');
  eqJson(O.mergePages([{ 1: 'a' }]), { pages: {}, count: 0 }, '② mergePages(数组) → 空结构');

  // 页号归一：JSON 键是字符串，"1" 与 1 视为同一页
  const r5 = O.mergePages({ '1': 'a' }, { 1: 'b' });
  eq(r5.count, 1, '② mergePages 数字键与字符串键归一为同一页');
  eq(r5.pages['1'], 'b', '② mergePages 归一后取 incoming');

  // 已知边角：parseInt("1.5") === 1，非整数页号会被截成整数页（调用方传的键永远是整数，风险低）
  const r6 = O.mergePages({ '1.5': 'x' }, null);
  eqJson(Object.keys(r6.pages), ['1'], '② [边角] 非整数页号 "1.5" 被截断成 1（记入缺陷清单-低）');
}

function testJoinPages() {
  eq(O.joinPages({ 2: 'b', 1: 'a' }), 'a\n\nb', '② joinPages 按页号升序拼接');
  eq(O.joinPages({ 1: 'a', 2: '   ', 3: 'c' }), 'a\n\nc', '② joinPages 跳过空页');
  eq(O.joinPages({ 1: '  a  ', 2: 'b' }), 'a\n\nb', '② joinPages 逐页 trim');
  eq(O.joinPages({}), '', '② joinPages({}) → ""');
  eq(O.joinPages(null), '', '② joinPages(null) → ""（不抛错）');
  eq(O.joinPages(undefined), '', '② joinPages(undefined) → ""');
  eq(O.joinPages('abc'), '', '② joinPages("abc") → ""（非对象输入）');
  eq(O.joinPages({ 1: 42, 2: 'b' }), 'b', '② joinPages 跳过非字符串值');
  eq(O.joinPages({ 0: 'x', abc: 'y', 1: 'a' }), 'a', '② joinPages 跳过非法页号');
  eq(O.joinPages({ 5: 'only' }), 'only', '② joinPages 单页无分隔符');
}

function testSidecarName() {
  const traversals = ['../etc/passwd', '..\\..\\win.ini', 'a:b', '/abs/path', 'C:\\x', '../../..'];
  for (const t of traversals) {
    const name = O.sidecarName(t, t);
    ok(!/[\/\\:]/.test(name), '② sidecarName 清掉路径穿越字符：' + JSON.stringify(t) + ' → ' + name);
    ok(name.indexOf('..') < 0, '② sidecarName 结果不含 ".."：' + name);
    ok(/\.json$/.test(name), '② sidecarName 结果以 .json 结尾：' + name);
    ok(name.split('-').length >= 2, '② sidecarName 保留两段：' + name);
  }
  eq(O.sidecarName(null, undefined), 'item-att.json', '② sidecarName(null,undefined) → 兜底 item-att.json');
  eq(O.sidecarName('', ''), 'item-att.json', '② sidecarName("","") → 兜底');
  eq(O.sidecarName('ABC12345', 'DEF67890'), 'ABC12345-DEF67890.json', '② sidecarName 正常 key 原样');
  const long = 'K'.repeat(80);
  const n = O.sidecarName(long, long);
  eq(n, 'K'.repeat(40) + '-' + 'K'.repeat(40) + '.json', '② sidecarName 每段截断到 40 字符');
  ok(O.sidecarName('../..', '..').indexOf('item') === 0, '② sidecarName 全清空 → item 兜底');
}

/* ==================== ③ 侧车 IO ==================== */

async function testSidecarIo() {
  const p = O.sidecarPath(attStub);
  has(p, '/data/papilot-ocr/', '③ sidecarPath 落在 <DataDirectory>/papilot-ocr/');
  eq(p, '/data/papilot-ocr/ITEM1-ATT1.json', '③ sidecarPath = <itemKey>-<attKey>.json');

  // 文件不存在 → 空结构
  const empty = await O.readSidecar(attStub);
  eqJson(empty, { version: 1, updatedAt: 0, engine: 'vision', pages: {} },
    '③ readSidecar 文件不存在 → 空结构');

  // 空文件
  S.files.set(p, '');
  eqJson(await O.readSidecar(attStub), { version: 1, updatedAt: 0, engine: 'vision', pages: {} },
    '③ readSidecar 空文件 → 空结构且不抛错');

  // 坏 JSON
  S.files.set(p, '{"pages": {"1": "a"');
  eqJson(await O.readSidecar(attStub), { version: 1, updatedAt: 0, engine: 'vision', pages: {} },
    '③ readSidecar 坏 JSON → 空结构且不抛错');

  // 非对象 JSON（null / 数字 / 数组）
  for (const bad of ['null', '0', '"str"', '[]', '{"pages":null}']) {
    S.files.set(p, bad);
    const r = await O.readSidecar(attStub);
    eqJson(r.pages, {}, '③ readSidecar ' + bad + ' → pages 归一为空');
    eq(r.version, 1, '③ readSidecar ' + bad + ' → version 兜底 1');
  }

  // 缺字段 → 默认值
  S.files.set(p, JSON.stringify({ pages: { 2: 'b' } }));
  eqJson(await O.readSidecar(attStub),
    { version: 1, updatedAt: 0, engine: 'vision', pages: { 2: 'b' } },
    '③ readSidecar 缺 updatedAt/engine/version → 默认值');

  // 字段类型脏
  S.files.set(p, JSON.stringify({ version: 'x', updatedAt: 'nope', engine: 5, pages: { 0: 'z', 1: 42, 2: 'ok' } }));
  const dirty = await O.readSidecar(attStub);
  eq(dirty.updatedAt, 0, '③ readSidecar updatedAt 非数字 → 0');
  eq(dirty.engine, 5, '③ readSidecar engine 原样透传（非空即取）');
  eqJson(dirty.pages, { 2: 'ok' }, '③ readSidecar 过滤非法页号与非字符串页文本');

  // 写入：实参个数（不传 mode）+ 载荷形状
  S.files.clear();
  S.writeCalls.length = 0;
  const payload = await O.writeSidecar(attStub, { pages: { 1: 'a', bad: 'x', 3: 42 } });
  eq(S.writeCalls.length, 1, '③ writeSidecar 只写一次');
  eq(S.writeCalls[0].length, 2, '③ writeUTF8 只传 2 个实参（不传 mode）');
  eq(S.writeCalls[0][0], p, '③ writeUTF8 第一个实参是侧车路径');
  eq(typeof S.writeCalls[0][1], 'string', '③ writeUTF8 第二个实参是 JSON 字符串');
  eqJson(payload, { version: 1, updatedAt: payload.updatedAt, engine: 'vision', pages: { 1: 'a' } },
    '③ writeSidecar 返回载荷（过滤非法页）');
  ok(payload.updatedAt > 0, '③ writeSidecar 写入 updatedAt');
  eqJson(JSON.parse(S.files.get(p)), payload, '③ 落盘内容与返回值一致');

  // 读回一致
  const back = await O.readSidecar(attStub);
  eqJson(back.pages, { 1: 'a' }, '③ 写入后读回 pages 一致');

  // textFor：无侧车 → ""；有侧车 → joinPages
  S.files.clear();
  eq(await O.textFor(attStub), '', '③ textFor 无侧车 → ""');
  eq(await O.textFor(null), '', '③ textFor(null) → ""（不抛错）');
  await O.writeSidecar(attStub, { pages: { 2: 'p2', 1: 'p1' } });
  eq(await O.textFor(attStub), 'p1\n\np2', '③ textFor 按页序返回整篇文本');

  // 写入失败必须抛出（由 ocrAttachment 的逐页 try/catch 兜住，不静默吞掉）
  const orig = S.sandbox.IOUtils.writeUTF8;
  S.sandbox.IOUtils.writeUTF8 = async () => { throw new Error('EACCES'); };
  let threw = false;
  try { await O.writeSidecar(attStub, { pages: { 1: 'x' } }); } catch (e) { threw = true; }
  ok(threw, '③ writeSidecar 磁盘写入失败会抛出（不静默）');
  S.sandbox.IOUtils.writeUTF8 = orig;
}

/* ==================== ④ AIChat.getFullText 回退契约 ==================== */

function makeChatSandbox() {
  const state = {
    indexed: '',
    indexedCalls: 0,
    ocrText: '',
    ocrCalls: 0,
    ocrThrow: false,
    autoFallback: true,
    maxChars: 16000,
  };
  const OcrStub = {
    textFor: async () => {
      state.ocrCalls++;
      if (state.ocrThrow) throw new Error('sidecar read failed');
      return state.ocrText;
    },
  };
  const sandbox = {
    console, Promise, Number, String, Object, Math, JSON, Set, Map, Date, RegExp,
    Array, isFinite, parseInt,
    OcrService: OcrStub,
    Prefs: {
      get(k, d) {
        if (k === 'aiFullTextMaxChars') return state.maxChars;
        if (k === 'ocrAutoFallback') return state.autoFallback;
        if (k === 'aiHistoryRounds') return 6;
        return d;
      },
    },
    Zotero: {
      FullText: {
        indexItems: async () => {},
        getItemContent: async () => { state.indexedCalls++; return state.indexed; },
      },
      Items: { get: () => null },
      File: { getContentsAsync: async () => '' },
      debug: () => {},
      logError: () => {},
    },
    IOUtils: { exists: async () => false, readUTF8: async () => '' },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read(CHAT_SRC), sandbox, { filename: 'chat.js' });
  return { C: sandbox.AIChat, state, sandbox };
}

const mkAtt = (id) => ({
  id, key: 'ATT' + id, parentItemID: 0, attachmentContentType: 'application/pdf',
  isPDFAttachment: () => true, isRegularItem: () => false,
});

async function testChatFallback() {
  const { C, state } = makeChatSandbox();
  const att = mkAtt(11);

  // (1) 索引为空 + 有 OCR 文本 → 用 OCR 文本
  state.indexed = '';
  state.ocrText = 'OCR文本';
  eq(await C.getFullText(att), 'OCR文本', '④ 索引为空 → 回退 OCR 文本');
  eq(state.ocrCalls, 1, '④ 索引为空时调用了 OcrService.textFor');
  eq(C._textCache.has(att.id), false, '④ OCR 文本不进 _textCache');

  // (2) 再问一次仍会重新读侧车（不缓存 → 重跑 OCR 后立刻生效）
  await C.getFullText(att);
  eq(state.ocrCalls, 2, '④ OCR 回退结果不缓存，下次提问重新读取');

  // (3) 索引非空 → 绝不调用 textFor，也绝不混入 OCR
  state.indexed = '正文正文';
  state.ocrText = 'OCR不该出现';
  const att2 = mkAtt(12);
  const t2 = await C.getFullText(att2);
  eq(t2, '正文正文', '④ 索引非空 → 返回索引正文');
  eq(state.ocrCalls, 2, '④ 索引非空时**没有**调用 OcrService.textFor');
  ok(String(t2).indexOf('OCR不该出现') < 0, '④ 索引非空 → 结果不含 OCR 文本');
  eq(C._textCache.get(att2.id), '正文正文', '④ 索引正文进 _textCache');

  // (4) 索引正文命中缓存 → 不再走索引读取
  const callsBefore = state.indexedCalls;
  eq(await C.getFullText(att2), '正文正文', '④ 第二次命中缓存返回同值');
  eq(state.indexedCalls, callsBefore, '④ 命中缓存不再读索引');

  // (5) ocrAutoFallback=false → 不回退，返回 null
  const { C: C2, state: s2 } = makeChatSandbox();
  s2.indexed = '';
  s2.ocrText = 'OCR文本';
  s2.autoFallback = false;
  eq(await C2.getFullText(mkAtt(21)), null, '④ ocrAutoFallback=false → getFullText 返回 null');
  eq(s2.ocrCalls, 0, '④ ocrAutoFallback=false → 不调用 textFor');

  // (6) textFor 抛错 → 返回 null（不把问答带崩）
  const { C: C3, state: s3 } = makeChatSandbox();
  s3.indexed = '';
  s3.ocrThrow = true;
  eq(await C3.getFullText(mkAtt(31)), null, '④ textFor 抛错 → getFullText 返回 null（不抛错）');
  eq(C3._textCache.has(31), false, '④ textFor 抛错 → 不写缓存');

  // (7) OCR 文本也做空白归一
  const { C: C4, state: s4 } = makeChatSandbox();
  s4.indexed = '';
  s4.ocrText = '  OCR\n\n  ';
  eq(await C4.getFullText(mkAtt(41)), 'OCR', '④ OCR 文本做空白归一（\\s+\\n → \\n 后 trim）');

  // (8) 截断：头 2/3 + 尾 1/3；noTruncate 不截断
  const { C: C5, state: s5 } = makeChatSandbox();
  s5.maxChars = 30;
  s5.indexed = 'A'.repeat(20) + 'B'.repeat(20);
  const cut = await C5.getFullText(mkAtt(51));
  has(cut, '……中间内容已截断……', '④ 超出 aiFullTextMaxChars → 中间截断');
  eq(cut.length, 30 + '\n\n[……中间内容已截断……]\n\n'.length, '④ 截断后保留 maxChars 正文（头 2/3 + 尾 1/3）');
  ok(cut.indexOf('A'.repeat(20)) === 0, '④ 截断保留开头（摘要）');
  ok(cut.lastIndexOf('B') === cut.length - 1, '④ 截断保留结尾（结论）');
  eq((await C5.getFullText(mkAtt(51), { noTruncate: true })), 'A'.repeat(20) + 'B'.repeat(20),
    '④ noTruncate 返回完整原文');

  // (9) 没有 PDF 附件 → null（不碰 OCR）
  const { C: C6, state: s6 } = makeChatSandbox();
  eq(await C6.getFullText({ id: 99, isPDFAttachment: () => false, isRegularItem: () => false }), null,
    '④ 无 PDF 附件 → null');
  eq(s6.ocrCalls, 0, '④ 无 PDF 附件 → 不调用 textFor');

  // (10) 缺 OcrService 模块 → 仍返回 null，不抛错
  const { C: C7, state: s7, sandbox: sb7 } = makeChatSandbox();
  s7.indexed = '';
  delete sb7.OcrService;
  eq(await C7.getFullText(mkAtt(61)), null, '④ OcrService 缺失 → 返回 null（不抛错）');

  // (11) D4 的修法是**定向**的：索引正文那条路径仍是 `\s+\n → \n`（空行合并），口径未变
  const { C: C8, state: s8 } = makeChatSandbox();
  s8.indexed = '第一段\n\n第二段';
  eq(await C8.getFullText(mkAtt(71)), '第一段\n第二段',
    '④ [口径未变] 索引正文的空行仍被合并（D4 只改 OCR 回退路径）');
}

/* ==================== 集成：真 OcrService 侧车 → getFullText ==================== */

async function testIntegration() {
  // 复用 ocr.js 的沙箱（含虚拟 FS），再把 chat.js 载进来，构成真链路
  const box = makeOcrSandbox();
  box.sandbox.Prefs = { get: (k, d) => (k === 'aiFullTextMaxChars' ? 16000 : (k === 'ocrAutoFallback' ? true : d)) };
  box.sandbox.Zotero.FullText = {
    indexItems: async () => {},
    getItemContent: async () => '', // 扫描件：索引恒为空
  };
  vm.runInContext(read(CHAT_SRC), box.sandbox, { filename: 'chat.js' });
  const OC = box.sandbox.OcrService;
  const C = box.sandbox.AIChat;

  const att = { id: 7, key: 'ATT1', parentItemID: 5, isPDFAttachment: () => true, isRegularItem: () => false };
  eq(await C.getFullText(att), null, '④ 集成：未 OCR 时 getFullText = null');

  await OC.writeSidecar(att, { pages: { 1: '第一页', 2: '第二页' } });
  eq(await C.getFullText(att), '第一页\n\n第二页', '④ 集成：OCR 后 getFullText 立刻读到侧车文本（页间空行保留）');
  eq(C._textCache.size, 0, '④ 集成：OCR 路径全程不写 _textCache');
  // D4 已修（0.63.0）：_ocrFallbackText 的归一收窄成 `[ \t]+\n → \n`，页边界与段落空行都保留。
  // 索引正文那条路径（chat.js 的 `\s+\n → \n`）保持原口径不动，避免影响既有 prompt 体量。
  eq(OC.joinPages({ 1: '第一页', 2: '第二页' }), '第一页\n\n第二页',
    '④ joinPages 用 "\\n\\n" 分隔页');
  eq(await C.getFullText(att), '第一页\n\n第二页',
    '④ [已修复] 回退路径保留页间空行（不再退化为单个换行）');
}

/* ==================== 主流程 ==================== */

(async function main() {
  console.log('OCR / 文本回退 独立验收（test/ocr.test.js）');
  console.log('--- ① 静态纪律 ---');
  testStatic();
  console.log('--- ② 纯函数 ---');
  testClampScale();
  testPanelClamps();
  testMergePages();
  testJoinPages();
  testSidecarName();
  console.log('--- ③ 侧车 IO ---');
  await testSidecarIo();
  console.log('--- ④ AIChat 回退契约 ---');
  await testChatFallback();
  await testIntegration();

  console.log('---');
  if (fails.length) {
    console.log('失败 ' + fails.length + ' 项：');
    for (const f of fails) console.log('  ✗ ' + f);
    console.log('ocr: ' + pass + ' 通过 / ' + fails.length + ' 失败');
    process.exit(1);
  }
  console.log('ocr: ' + pass + ' 项断言全部通过 ✓');
})();
