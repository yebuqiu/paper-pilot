#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 启动诊断合批写盘测试（审查 P0-1；Node vm 桩，无 Zotero 环境）
 *
 * 背景：旧实现每记一行 boot 日志就「全量 join + 两处目录覆盖写盘」，一次启动
 * 120+ 行 → ~240 次磁盘写，且散落在启动关键路径上。现改为 200ms 合批 flush
 * （shutdown/install/uninstall 前补 flush），本测试钉住这条性能契约：
 *   ① _ppDiag 只记行不落盘（同步返回，不 await 也完整）；
 *   ② 100 行密集日志只触发一轮 flush（两处路径 = 2 次写，不是 200 次）；
 *   ③ 落盘内容 = 完整行序（一行不缺、顺序不乱）；
 *   ④ 后续批次再合批（增量触发，不回头重写历史以外的开销）；
 *   ⑤ shutdown 立即 flush（清掉 pending 定时器，缓冲行不丢）。
 *
 * 运行：node test/boot-diag.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const BOOT_JS = path.join(ROOT, 'bootstrap.js');

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

/* ---------------- 桩环境：IOUtils.writeUTF8 计数 + 记录内容 ---------------- */

const writeCalls = [];   // [{ path, text }]
const files = new Map(); // path → 最后写入的全文
const IOUtilsStub = {
  writeUTF8(p, text) {
    writeCalls.push({ path: p, text: String(text) });
    files.set(p, String(text));
    return Promise.resolve();
  },
};

const sandbox = {
  console,
  setTimeout, clearTimeout, Promise, Date, JSON,
  APP_SHUTDOWN: 8,
  Zotero: {
    debug() {}, logError() {},
    DataDirectory: { dir: '/data' },
    initializationPromise: Promise.resolve(),
  },
  Services: {
    dirsvc: { get: () => ({ path: '/prof' }) },
  },
  Components: { interfaces: { nsIFile: {} } },
  PathUtils: { join: (a, b) => String(a).replace(/\/+$/, '') + '/' + String(b) },
  IOUtils: IOUtilsStub,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(BOOT_JS, 'utf8'), sandbox, { filename: 'bootstrap.js' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  /* ==================== ① 记行不落盘（同步语义） ==================== */

  // bootstrap.js 顶层已记过一行 "bootstrap.js evaluated"（排程中，未落盘）
  eq(writeCalls.length, 0, '① 加载期零写盘（flush 是 200ms 合批，不同步写）');

  // 密集记 100 行：调用方不 await（_ppDiag 现已同步），写盘计数必须仍是 0
  for (let i = 1; i <= 100; i++) sandbox._ppDiag('line-' + i);
  eq(writeCalls.length, 0, '① 100 行密集日志触发 0 次写盘（合批排程中）');
  eq(sandbox._ppBootLines.length, 101, '① 行缓冲完整（含加载期 1 行）');

  /* ==================== ② 一轮合批 = 两处路径各 1 写 ==================== */

  await sleep(300);   // 越过 200ms 合批窗口
  eq(writeCalls.length, 2, '② 101 行只写了 2 次（数据目录 + profile 各 1 次，非 202 次）');
  ok(writeCalls.every((c) => c.path.indexOf('papilot-boot.log') >= 0), '② 写盘目标为 boot 日志');

  /* ==================== ③ 内容 = 完整行序 ==================== */

  const text1 = files.get('/data/papilot-boot.log') || '';
  const lines1 = text1.trim().split('\n');
  eq(lines1.length, 101, '③ 落盘 101 行（一行不缺）');
  ok(lines1[0].indexOf('bootstrap.js evaluated') >= 0, '③ 首行 = 加载期留痕');
  ok(lines1[1].indexOf('line-1') >= 0 && lines1[100].indexOf('line-100') >= 0,
    '③ 行序完整（line-1 … line-100 按序）');
  // 两处路径内容一致（同一份全量文本）
  eq(files.get('/prof/papilot-boot.log'), text1, '③ 两处日志内容一致');

  /* ==================== ④ 后续批次增量合批 ==================== */

  const before = writeCalls.length;
  for (let i = 101; i <= 105; i++) sandbox._ppDiag('line-' + i);
  await sleep(300);
  eq(writeCalls.length, before + 2, '④ 第二批 5 行再合批一次（+2 写，不是 +10）');
  const lines2 = (files.get('/data/papilot-boot.log') || '').trim().split('\n');
  eq(lines2.length, 106, '④ 第二批落盘后全量 106 行（全量覆盖写，历史不丢）');

  /* ==================== ⑤ shutdown 立即 flush（不丢尾部缓冲行） ==================== */

  sandbox._ppDiag('tail-line-pending');
  sandbox.shutdown({}, 4);   // reason=4（非 APP_SHUTDOWN）：走清理分支
  eq(writeCalls.length, before + 2, '⑤ shutdown 内 flush 已发起（不等 200ms，写调用同拍登记）');
  await sleep(20);
  const tail = files.get('/data/papilot-boot.log') || '';
  ok(tail.indexOf('tail-line-pending') >= 0, '⑤ 最后一行缓冲行已落盘（shutdown 兜底 flush）');
  ok(tail.indexOf('shutdown reason=4') >= 0, '⑤ shutdown 自身日志也在');
  // 路径合计：6 次写对应 3 轮 flush × 2 路径（107 行日志 → 6 次写，量级 ≈ 行数/窗口 × 2）
  eq(writeCalls.length, before + 4, '⑤ shutdown flush 再 +2 写（总 6 次 ≪ 旧版 214 次）');

  /* ---------------- 输出 ---------------- */
  console.log('='.repeat(60));
  if (fails.length) {
    for (const f of fails) console.log('  x ' + f);
    console.log('-'.repeat(60));
  }
  console.log('启动诊断合批写盘测试：' + pass + ' 通过 / ' + fails.length + ' 失败');
  console.log('='.repeat(60));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.error('测试执行异常：', e);
  process.exit(1);
});
