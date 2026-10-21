#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* pdf.js 懒加载测试（审查 P1-3；Node vm 桩，无 Zotero 环境）
 *
 * 背景：0.63.0 起 pdf.min.js（≈320KB UMD）在启动时无条件 loadSubScript；
 * 改为懒加载后契约是：
 *   ① 启动路径不再载入（init 里只有一行 deferred 诊断，无 loadSubScript 调用）；
 *   ② _ensurePdfjs() 首次调用才载入，成功后幂等（第二次零加载）；
 *   ③ 载入失败 → _pdfjs 保持 null（OCR 降级语义不变）+ _pdfjsFailed 熔断
 *     （不反复 loadSubScript）+ 只记一次诊断；
 *   ④ main.js 里 _lib 包装点存在且带 _ppLazyPdf 幂等标记（OcrService 取库的
 *      唯一入口被兜住：openDocument / runForSelected 闸门 / _numPages 全覆盖）。
 *
 * 运行：node test/pdfjs-lazy.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const MAIN = path.join(ROOT, 'chrome', 'content', 'scripts', 'main.js');

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

const SRC = fs.readFileSync(MAIN, 'utf8');

/* ---------------- ① 启动路径不再载入 pdf.js ---------------- */

// init 体内的 pdf.min.js 引用处不再有 loadSubScript（只有 _ensurePdfjs 方法体里有）
const initBody = SRC.slice(SRC.indexOf('async init('), SRC.indexOf('openWorkbench()'));
ok(initBody.indexOf('pdf.min.js') < 0 || initBody.indexOf('loadSubScript(\n        rootURI + "chrome/content/vendor/pdfjs') < 0,
  '① init 内不再直接 loadSubScript pdf.min.js');
ok(initBody.indexOf('pdfjs deferred') >= 0, '① 启动只留一行 deferred 诊断');
ok(SRC.indexOf('chrome/content/vendor/pdfjs/pdf.min.js') < SRC.indexOf('for (const f of files)'),
  '① pdf.min.js 引用仍在模块循环之前（check-wiring 50.2 的钉点）');

/* ---------------- 桩环境：只取 Zotero.Papilot 对象 ---------------- */

function makeSandbox(opts) {
  opts = opts || {};
  const loadCalls = [];
  const diags = [];
  const sandbox = {
    console, Promise, Date, Math, JSON, setTimeout, clearTimeout,
    Zotero: { debug() {}, logError() {} },
    Services: {
      scriptloader: {
        loadSubScript(url) {
          loadCalls.push(url);
          if (opts.fail) throw new Error('load boom');
          sandbox.pdfjsLib = { version: '3.11-test', GlobalWorkerOptions: {}, getDocument() {} };
        },
      },
    },
    _ppDiag: (m) => { diags.push(String(m)); },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'main.js' });
  const P = sandbox.Zotero.Papilot;
  P.rootURI = 'jar:file:///xpi!/';
  P.version = '0.71.0';
  return { P, loadCalls, diags, sandbox };
}

/* ---------------- ② 首次调用才载入，成功后幂等 ---------------- */

{
  const { P, loadCalls, diags } = makeSandbox();
  eq(P._pdfjs, null, '② 初始 _pdfjs = null（未加载）');
  eq(loadCalls.length, 0, '② 未调用前零加载');
  const lib = P._ensurePdfjs();
  eq(loadCalls.length, 1, '② ★ 首次 _ensurePdfjs 触发一次 loadSubScript');
  ok(loadCalls[0].indexOf('pdf.min.js?v=0.71.0') >= 0, '② 带 ?v= 缓存破坏（热升级语义不变）');
  ok(lib && lib.version === '3.11-test', '② 返回库对象');
  eq(P._pdfjs, lib, '② _pdfjs 已挂实例');
  eq(P._pdfjs.GlobalWorkerOptions.workerSrc,
    'jar:file:///xpi!/chrome/content/vendor/pdfjs/pdf.worker.min.js', '② workerSrc 指向 vendor worker');
  ok(diags.some((d) => d.indexOf('lazy loaded') >= 0), '② 成功记诊断');
  P._ensurePdfjs();
  P._ensurePdfjs();
  eq(loadCalls.length, 1, '② ★ 后续调用幂等（不再重复加载）');
}

/* ---------------- ③ 失败熔断 + 降级语义 ---------------- */

{
  const { P, loadCalls, diags } = makeSandbox({ fail: true });
  const r = P._ensurePdfjs();
  eq(r, null, '③ 载入失败返回 null（OCR 降级语义不变）');
  eq(P._pdfjs, null, '③ _pdfjs 保持 null');
  eq(P._pdfjsFailed, true, '③ 置熔断标记');
  eq(diags.filter((d) => d.indexOf('lazy load FAILED') >= 0).length, 1, '③ 失败只记一次诊断');
  P._ensurePdfjs();
  eq(loadCalls.length, 1, '③ ★ 熔断后不重试 loadSubScript');
}

/* ---------------- ④ _lib 包装点（源码形态断言，与 ocr.test.js 同款） ---------------- */

ok(SRC.indexOf('this.ocr._lib = function ()') >= 0, '④ main.js 包装 OcrService._lib');
ok(SRC.indexOf('._ppLazyPdf = true') >= 0, '④ 包装带幂等标记（热升级/二次 init 不叠包）');
ok(/typeof this\.ocr\._lib === "function"/.test(SRC), '④ 包装前判 _lib 存在（防崩）');

/* ---------------- 输出 ---------------- */
console.log('='.repeat(60));
if (fails.length) {
  for (const f of fails) console.log('  x ' + f);
  console.log('-'.repeat(60));
}
console.log('pdf.js 懒加载测试：' + pass + ' 通过 / ' + fails.length + ' 失败');
console.log('='.repeat(60));
process.exit(fails.length ? 1 : 0);
