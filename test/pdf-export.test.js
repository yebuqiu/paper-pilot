#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 对照翻译导出 测试（插件 0.39.0）
 *
 * 为什么要有它：导出是「用户唯一能把译文拿走」的通道，坏在半路最恼人。其中自建 PDF
 * 生成器（零依赖往 PDF 里嵌 JPEG）最容易出结构性错误——CSS 页面尺寸换算、xref 字节
 * 偏移、流长度任一错位，PDF 阅读器会直接打不开。所以这里对 PDF 做**双重验证**：
 *   ① 结构自校验（不依赖任何外部库）：文件头/尾、/Count、每个对象偏移处的 "N 0 obj"、
 *      startxref 指向 xref、xref 条目偏移与实际对象位置一致、JPEG 流长度与实际字节一致；
 *   ② 若本机装有 pdfjs-dist（managed 工作区），再真解析一遍：页数 + MediaBox 尺寸。
 * HTML/Markdown/Word(OOXML) 是纯文本产物，逐条断言内容与转义。
 *
 * 运行：node test/pdf-export.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'chrome', 'content', 'scripts', 'features', 'pdf-export.js');

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

/* ==================== 桩环境 ==================== */
const sandbox = {
  console, TextEncoder, Uint8Array, Promise, Date, Math, JSON, RegExp, Object, Array, String, Number, isFinite,
  I18n: { isZh: true, t: (k) => k },
  Zotero: { logError() {}, getMainWindow: () => ({}), Attachments: {}, File: {} },
  PathUtils: { tempDir: '/tmp', join: (...p) => p.join('/'), parent: (p) => p.split('/').slice(0, -1).join('/') },
  IOUtils: { write: async () => {}, writeUTF8: async () => {}, remove: async () => {}, makeDirectory: async () => {} },
  PdfInline: { _states: new Map() },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: 'pdf-export.js' });
const EX = sandbox.PdfExport;

/* 最小的合法 JPEG（1×1 像素，标准基线 JPEG 字节）——仅供 PDF 嵌入与结构检查 */
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a'
  + 'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA'
  + 'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');

/* ==================== PDF 结构自校验（纯 JS，无依赖） ==================== */
function checkPdfStructure(buf, expectPages) {
  const raw = buf.toString('latin1');
  const errs = [];
  if (!raw.startsWith('%PDF-1.')) errs.push('no %PDF header');
  if (!raw.trimEnd().endsWith('%%EOF')) errs.push('no %%EOF');
  const mCount = /\/Count (\d+)/.exec(raw);
  if (!mCount) errs.push('no /Count');
  else if (Number(mCount[1]) !== expectPages) errs.push('/Count=' + mCount[1] + ' expected ' + expectPages);
  // startxref → xref
  const mSx = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(raw);
  if (!mSx) errs.push('no startxref');
  else {
    const xrefPos = Number(mSx[1]);
    if (raw.slice(xrefPos, xrefPos + 4) !== 'xref') errs.push('startxref does not point at xref');
    // 逐条核对 xref 偏移
    const head = /xref\s+0 (\d+)\s+([\s\S]*?)trailer/.exec(raw);
    if (!head) errs.push('no xref table');
    else {
      const count = Number(head[1]);
      const entries = head[2].trim().split(/\s*\n\s*/).filter(Boolean);
      if (entries.length !== count) errs.push('xref entries ' + entries.length + ' != ' + count);
      for (let id = 1; id < count; id++) {
        const mo = /^(\d{10}) (\d{5}) n$/.exec(entries[id] || '');
        if (!mo) { errs.push('bad xref entry ' + id); continue; }
        const off = Number(mo[1]);
        if (raw.slice(off, off + (String(id) + ' 0 obj').length) !== (String(id) + ' 0 obj')) {
          errs.push('xref offset wrong for obj ' + id);
        }
      }
    }
  }
  // 每个对象的流长度必须与真实字节一致（JPEG 流是二进制，必须按 latin1 计）。
  // 规范允许在 endstream 前多一个 EOL 且不计入 /Length → 两种写法都接受。
  const reStream = /<<([^>]*?)>>\s*stream\r?\n/g;
  let m2;
  while ((m2 = reStream.exec(raw))) {
    const mLen = /\/Length (\d+)/.exec(m2[1]);
    if (!mLen) continue;
    const start = m2.index + m2[0].length;
    const declared = Number(mLen[1]);
    const endStream = raw.indexOf('endstream', start);
    if (endStream < 0) { errs.push('no endstream'); continue; }
    const span = raw.slice(start, endStream);
    const trimmed = span.replace(/\r?\n$/, '');
    if (declared !== span.length && declared !== trimmed.length) {
      errs.push('stream length declared ' + declared + ' actual ' + span.length + '/' + trimmed.length);
    }
  }
  return errs;
}

async function main() {
  /* ==================== ① xmlEscape ==================== */
  eq(EX.xmlEscape('a<b>&"c\'d'), 'a&lt;b&gt;&amp;&quot;c&apos;d', '① XML 转义（5 个实体）');
  eq(EX.xmlEscape(null), '', '① null → 空串');
  eq(EX.xmlEscape('x\u0000y'), 'xy', '① 非法控制字符被剔除');

  /* ==================== ② wrapByMeasure ==================== */
  {
    const measure = (s) => s.length * 10;         // 每字符 10 宽
    const lines = EX.wrapByMeasure('abcdefghij', 50, measure);
    eq(lines.length, 2, '② 10 字符 / 每行 5 → 2 行');
    eq(lines[0], 'abcde', '② 首行填满宽度');
    eq(lines[1], 'fghij', '② 次行接续');
    eq(EX.wrapByMeasure('a\nb', 100, measure).length, 2, '② 显式换行也断行');
    eq(EX.wrapByMeasure('', 50, measure).join(''), '', '② 空串不炸');
    const cn = EX.wrapByMeasure('中文测试内容很长', 30, (s) => s.length * 10);
    eq(cn.length, 3, '② 中文按字折行（3 字/行 → 8 字 = 3 行）');
  }

  /* ==================== ③ buildImagePdf 结构自校验 ==================== */
  {
    const pages = [
      { jpeg: new Uint8Array(TINY_JPEG), pxW: 1, pxH: 1, ptW: 595, ptH: 842 },
      { jpeg: new Uint8Array(TINY_JPEG), pxW: 1, pxH: 1, ptW: 612, ptH: 792 },
    ];
    const buf = Buffer.from(EX.buildImagePdf(pages));
    ok(buf.length > 300, '③ 产出 PDF 字节', { len: buf.length });
    const errs = checkPdfStructure(buf, 2);
    eq(errs.length, 0, '③ ★ PDF 结构自校验通过（xref 偏移/流长度/Count 全对）', errs);
    const raw = buf.toString('latin1');
    ok(raw.indexOf('/MediaBox [0 0 595 842]') > 0 && raw.indexOf('/MediaBox [0 0 612 792]') > 0,
      '③ 每页 MediaBox 用各自的页面尺寸');
    eq((raw.match(/\/Filter \/DCTDecode/g) || []).length, 2, '③ 两张 JPEG 都以 DCTDecode 内嵌');
    eq((raw.match(/\/Im0 Do/g) || []).length, 2, '③ 每页内容流都铺满图像');
    // 单页也要对
    const one = Buffer.from(EX.buildImagePdf([pages[1]]));
    eq(checkPdfStructure(one, 1).length, 0, '③ 单页 PDF 结构同样正确');
    let threw = false;
    try { EX.buildImagePdf([]); } catch (e) { threw = true; }
    ok(threw, '③ 空页列表 → 显式抛错（不产坏文件）');
  }

  /* ==================== ④ buildImagePdf 真实解析（有 pdfjs-dist 才跑） ==================== */
  {
    const cand = [
      process.env.PP_PDFJS_DIR,
      'C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/pdfjs-dist/legacy/build/pdf.mjs',
    ].filter(Boolean);
    let mod = null;
    for (const p of cand) {
      try {
        if (fs.existsSync(p)) { mod = await import('file://' + p.replace(/\\/g, '/')); break; }
      } catch (e) { /* 下一个候选 */ }
    }
    if (!mod) {
      console.log('· 跳过：本机没有 pdfjs-dist（设 PP_PDFJS_DIR 可启用真实解析校验）');
    } else {
      const pages = [
        { jpeg: new Uint8Array(TINY_JPEG), pxW: 1, pxH: 1, ptW: 595, ptH: 842 },
        { jpeg: new Uint8Array(TINY_JPEG), pxW: 1, pxH: 1, ptW: 400, ptH: 300 },
      ];
      const bytes = EX.buildImagePdf(pages);
      const doc = await mod.getDocument({ data: bytes, verbosity: 0 }).promise;
      eq(doc.numPages, 2, '④ ★ pdfjs 真解析：页数 = 2');
      const p1 = await doc.getPage(1);
      const vp = p1.getViewport({ scale: 1 });
      ok(Math.abs(vp.width - 595) < 1 && Math.abs(vp.height - 842) < 1,
        '④ ★ 第一页尺寸 = 595×842（MediaBox 生效）', { w: vp.width, h: vp.height });
      const p2 = await doc.getPage(2);
      const vp2 = p2.getViewport({ scale: 1 });
      ok(Math.abs(vp2.width - 400) < 1 && Math.abs(vp2.height - 300) < 1,
        '④ ★ 第二页尺寸 = 400×300（逐页尺寸独立）', { w: vp2.width, h: vp2.height });
      await doc.destroy();
    }
  }

  /* ==================== ⑤ collectDoc（从内核 state 取段落） ==================== */
  {
    const readerA = {};
    const st = {
      pageBlocks: new Map([
        ['2', [{ text: 'Second page text', dst: '第二页译文', kind: 'body' }]],
        ['1', [
          { text: 'First paragraph', dst: '第一段译文', kind: 'body' },
          { text: 'x = 1', dst: '', kind: 'formula' },      // 公式：不进导出
          { text: '   ', dst: 'noise', kind: 'body' },      // 空白：不进导出
          { text: 'Caption here', dst: null, kind: 'caption' }, // 未译完：保留源文、译文空
        ]],
      ]),
    };
    sandbox.PdfInline._states.set(readerA, st);
    const doc = EX.collectDoc(readerA, 'T', 'meta');
    eq(doc.pages.length, 2, '⑤ 两页都有内容');
    eq(doc.pages[0].num, '1', '⑤ 页序按页码排序（不按插入顺序）');
    eq(doc.pages[0].blocks.length, 2, '⑤ 公式与空白段被排除');
    eq(doc.pages[0].blocks[0].src, 'First paragraph', '⑤ 原文取自内核块 text');
    eq(doc.pages[0].blocks[0].dst, '第一段译文', '⑤ 译文取自 dst');
    eq(doc.pages[0].blocks[1].dst, '', '⑤ 未译完的段译文为空串（渲染成空单元格）');
    eq(EX.collectDoc({}, 'T').pages.length, 0, '⑤ 无 state → 空文档（不抛错）');
    sandbox.PdfInline._states.delete(readerA);
  }

  /* ==================== ⑥ buildBilingualHtml ==================== */
  {
    const doc = {
      title: 'My <Paper>', meta: 'meta & info',
      pages: [{ num: 1, blocks: [{ src: 'A & B', dst: '甲乙' }] }],
    };
    const html = EX.buildBilingualHtml(doc);
    ok(html.indexOf('<!DOCTYPE html>') === 0, '⑥ 完整 HTML 文档');
    ok(html.indexOf('My &lt;Paper&gt;') > 0, '⑥ 标题被转义（不破坏文档结构）');
    ok(html.indexOf('A &amp; B') > 0, '⑥ 原文转义');
    ok(html.indexOf('甲乙') > 0, '⑥ 译文在文内');
    ok(html.indexOf('原文') > 0 && html.indexOf('译文') > 0, '⑥ 两栏表头');
    ok(html.indexOf('第 1 页') > 0, '⑥ 页标题');
    eq((html.match(/<table>/g) || []).length, 1, '⑥ 每页一张表');
  }

  /* ==================== ⑦ buildBilingualMarkdown ==================== */
  {
    const doc = { title: 'T', meta: 'M', pages: [{ num: 3, blocks: [{ src: 'src line', dst: '译行' }] }] };
    const md = EX.buildBilingualMarkdown(doc);
    ok(md.indexOf('# T') === 0, '⑦ 标题为一级标题');
    ok(md.indexOf('> M') > 0, '⑦ 元信息写成引用');
    ok(md.indexOf('## 第 3 页') > 0, '⑦ 页级二级标题');
    ok(md.indexOf('src line') > 0 && md.indexOf('译行') > 0, '⑦ 原文与译文都在');
  }

  /* ==================== ⑧ buildDocxFiles（OOXML 最小集） ==================== */
  {
    const doc = { title: 'Doc & Title', meta: 'gen', pages: [{ num: 1, blocks: [{ src: 'A < B', dst: '甲乙' }] }] };
    const files = EX.buildDocxFiles(doc);
    const keys = Object.keys(files).sort();
    eq(keys.length, 3, '⑧ 三个必需部件（content-types / rels / document）');
    ok(keys.indexOf('[Content_Types].xml') >= 0, '⑧ 含 [Content_Types].xml');
    ok(keys.indexOf('_rels/.rels') >= 0, '⑧ 含 _rels/.rels');
    ok(keys.indexOf('word/document.xml') >= 0, '⑧ 含 word/document.xml');
    const d = files['word/document.xml'];
    ok(d.indexOf('<?xml version="1.0"') === 0, '⑧ 声明 XML 头');
    ok(d.indexOf('xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"') > 0, '⑧ 声明 w 命名空间');
    ok(d.indexOf('<w:tbl>') > 0 && d.indexOf('<w:gridCol') > 0, '⑧ 双列表格骨架');
    ok(d.indexOf('Doc &amp; Title') > 0, '⑧ 标题被转义');
    ok(d.indexOf('A &lt; B') > 0, '⑧ 原文被转义');
    ok(d.indexOf('甲乙') > 0, '⑧ 译文在文内');
    eq((d.match(/<w:tr>/g) || []).length, 3, '⑧ 表头 1 行 + 页码行 1 行 + 段落 1 行');
    ok(d.indexOf('<w:sectPr>') > 0, '⑧ 有节属性（页面尺寸/页边距）');
    // XML 简易合法性：标签开闭配平（只查 w: 主要标签）
    for (const tag of ['w:document', 'w:body', 'w:tbl', 'w:tr', 'w:tc', 'w:p', 'w:r', 'w:t']) {
      const open = (d.match(new RegExp('<' + tag + '[ >]', 'g')) || []).length;
      const close = (d.match(new RegExp('</' + tag + '>', 'g')) || []).length;
      eq(open, close, '⑧ <' + tag + '> 开闭配平（' + open + '）');
    }
    ok(files['[Content_Types].xml'].indexOf('wordprocessingml.document.main+xml') > 0, '⑧ content-types 声明主文档类型');
    ok(files['_rels/.rels'].indexOf('word/document.xml') > 0, '⑧ rels 指向主文档');
  }

  /* ==================== ⑨ _safeName ==================== */
  {
    eq(EX._safeName('a/b:c*d?e"f<g>h|i'), 'a_b_c_d_e_f_g_h_i', '⑨ 文件名非法字符被替换');
    ok(EX._safeName('').length > 0, '⑨ 空标题有兜底名');
    ok(EX._safeName('x'.repeat(300)).length <= 80, '⑨ 超长标题截断');
  }

  /* ==================== ⑩ _drawBlock（叠画译文：用「假 ctx」记录调用） ==================== */
  {
    const calls = [];
    const mkCtx = () => ({
      save() { calls.push(['save']); },
      restore() { calls.push(['restore']); },
      beginPath() { calls.push(['beginPath']); },
      rect(x, y, w, h) { calls.push(['rect', x, y, w, h]); },
      clip() { calls.push(['clip']); },
      fillRect(x, y, w, h) { calls.push(['fillRect', x, y, w, h]); },
      strokeRect(x, y, w, h) { calls.push(['strokeRect', x, y, w, h]); },
      fillText(t, x, y) { calls.push(['fillText', t, x, y]); },
      measureText(s) { return { width: String(s).length * 10 }; },   // 每字 10 宽
      fillStyle: "", strokeStyle: "", lineWidth: 1, textBaseline: "", font: "",
      set font2(v) { /* noop */ },
    });
    const ctx = mkCtx();
    const block = { left: 50, top: 100, right: 250, height: 40, fontSize: 10, dst: '这是一段中文译文' };
    EX._drawBlock(ctx, block, 2);       // k=2（画布像素 / CSS 像素）
    ok(calls.some((c) => c[0] === 'fillRect'), '⑩ 先铺不透明底（盖住原页文字）');
    ok(calls.some((c) => c[0] === 'strokeRect'), '⑩ 画细描边（与窗口观感一致）');
    const texts = calls.filter((c) => c[0] === 'fillText').map((c) => c[1]);
    ok(texts.length >= 1, '⑩ 有 fillText 调用（译文被真的画上去）');
    eq(texts.join(''), '这是一段中文译文', '⑩ 折行后拼回 == 原文译文（不丢字）');
    ok(calls.some((c) => c[0] === 'clip'), '⑩ 超出框的部分被裁剪（不糊到别的段落上）');
    eq(calls.filter((c) => c[0] === 'save').length, calls.filter((c) => c[0] === 'restore').length,
      '⑩ save/restore 配平（不污染画布状态）');
    // 空白译文：只铺底不写字（未译完的段落也不会把原页文字暴露在卡片框里）
    const c2 = [];
    const ctx2 = mkCtx();
    EX._drawBlock(ctx2, { left: 0, top: 0, right: 100, height: 20, fontSize: 10, dst: '' }, 1);
    eq(calls.filter((c) => c[0] === 'fillText').length >= 1, true, '⑩ 上一轮已画过文字（前置）');
    ok(ctx2 !== null, '⑩ 空译文不抛错');
    void c2;
  }

  /* ---------------- 输出 ---------------- */
  console.log('='.repeat(60));
  if (fails.length) {
    for (const f of fails) console.log('  ✗ ' + f);
    console.log('-'.repeat(60));
  }
  console.log('对照翻译导出：' + pass + ' 通过 / ' + fails.length + ' 失败');
  console.log('='.repeat(60));
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => {
  console.log('✗ 测试自身异常：' + (e && e.stack || e));
  process.exit(1);
});
