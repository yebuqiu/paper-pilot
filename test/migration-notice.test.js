#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* PaperPilot → Papilot 迁移提示包测试
 *
 * 守住三条线：
 *   ① 扩展 ID 必须还是旧的 paperpilot@dev.local（改了就等于放弃老用户）
 *   ② 版本必须 > 0.54.0 且不与主包冲突（否则老 ID 的更新通道不会拉取）
 *   ③ bootstrap 的提示逻辑：只弹一次；点主按钮才开下载页；取消不乱开
 *
 * 运行：node test/migration-notice.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'migration');
const PY = process.env.PP_PYTHON || 'python';

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 用假环境加载 bootstrap.js；返回 { ctx, startup } */
function loadBootstrap(opts) {
  const o = opts || {};
  const prefs = o.prefs || {};
  const state = o.state || { prompts: 0, launches: [], answer: o.answer === undefined ? 0 : o.answer };

  const sandbox = {
    Promise, Date, JSON, Math, console,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 30)), // 把 1500ms 压到 30ms
    clearTimeout,
    Services: {
      prefs: {
        getStringPref: (k, dft) => (Object.prototype.hasOwnProperty.call(prefs, k) ? prefs[k] : dft),
        setStringPref: (k, v) => { prefs[k] = String(v); },
        clearUserPref: (k) => { delete prefs[k]; },
      },
      prompt: {
        BUTTON_POS_0: 1, BUTTON_POS_1: 2, BUTTON_TITLE_IS_STRING: 128, BUTTON_TITLE_CANCEL: 8,
        confirmEx: () => { state.prompts++; return state.answer; },
      },
    },
    Zotero: {
      debug: () => {},
      initializationPromise: Promise.resolve(),
      DataDirectory: { dir: os.tmpdir() },
      getMainWindow: () => ({ document: { documentElement: {} } }),
      launchURL: (u) => state.launches.push(u),
    },
    IOUtils: { writeUTF8: () => Promise.resolve() },
    PathUtils: { join: (a, b) => a + '/' + b },
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  const code = fs.readFileSync(path.join(SRC, 'bootstrap.js'), 'utf8');
  vm.runInContext(code, ctx, { filename: 'migration/bootstrap.js' });
  return { ctx, state, prefs };
}

(async () => {
  /* ---- A. 包与清单静态校验 ---- */
  const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
  const zot = manifest.applications.zotero;
  eq(zot.id, 'paperpilot@dev.local', 'A1 扩展 ID 仍是旧 ID（老用户更新通道靠它匹配）');
  const ver = manifest.version.split('.').map(Number);
  const cmp = (a, b) => {
    for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] - b[i]; }
    return 0;
  };
  ok(cmp(ver, [0, 54, 0]) > 0, 'A2 版本高于 0.54.0（旧清单最高版本）', manifest.version);
  ok(cmp(ver, [0, 56, 0]) < 0, 'A3 版本低于 0.56.0，避免与主包版本混淆', manifest.version);
  ok(!!zot.update_url, 'A4 带 update_url');
  ok(!/papilot@dev\.local/.test(JSON.stringify(manifest)), 'A5 manifest 里绝不出现新 ID');
  ok(fs.existsSync(path.join(SRC, 'bootstrap.js')), 'A6 有 bootstrap.js 入口');

  // 真跑构建脚本（顺带验证硬校验没被绕过）
  let built = false;
  try {
    const out = execFileSync(PY, [path.join(ROOT, 'scripts', 'build-migration-xpi.py')],
      { cwd: ROOT, encoding: 'utf8' });
    built = /迁移提示包/.test(out);
  } catch (e) {
    fails.push('A7 构建脚本执行失败: ' + (e.stdout || e.message));
  }
  ok(built, 'A7 构建脚本可执行且产物自检通过');
  const xpi = path.join(ROOT, 'dist', `paperpilot-${manifest.version}.xpi`);
  ok(fs.existsSync(xpi), 'A8 产物落在 dist/', xpi);
  if (fs.existsSync(xpi)) {
    const head = fs.readFileSync(xpi).slice(0, 2).toString('hex');
    eq(head, '504b', 'A9 产物是合法 zip（PK 头）');
    const size = fs.statSync(xpi).size;
    ok(size > 1000 && size < 200 * 1024, 'A10 体积合理（提示包不该带任何资源）', size);
  }

  /* ---- B. bootstrap 行为 ---- */
  // B1 首次启动：弹一次，点主按钮 → 打开下载页
  {
    const { ctx, state } = loadBootstrap({ answer: 0 });
    await ctx.startup({ id: 'paperpilot@dev.local', version: manifest.version, rootURI: 'x' }, 3);
    await sleep(120);
    eq(state.prompts, 1, 'B1 首次启动弹一次提示');
    eq(state.launches.length, 1, 'B2 点「打开发行版页面」后调用 launchURL');
    ok(/zotero-papilot\/releases/.test(state.launches[0] || ''), 'B3 打开的是 Papilot 发行版页', state.launches[0]);
  }

  // B4 同一版本再次启动：不再打扰
  {
    const prefs = {};
    const { ctx, state } = loadBootstrap({ prefs, answer: 0 });
    await ctx.startup({ version: manifest.version }, 3);
    await sleep(80);
    await ctx.startup({ version: manifest.version }, 1);
    await sleep(80);
    eq(state.prompts, 1, 'B4 同一版本只弹一次（第二次启动静默）');
  }

  // B5 用户取消：不打开浏览器
  {
    const { ctx, state } = loadBootstrap({ answer: 1 });
    await ctx.startup({ version: manifest.version }, 3);
    await sleep(120);
    eq(state.prompts, 1, 'B5 取消时仍然弹过提示');
    eq(state.launches.length, 0, 'B6 取消后不打开浏览器');
  }

  // B7 没有主窗口：不弹，也不写「已提示」（留到下次）
  {
    const prefs = {};
    const sandboxNoWin = loadBootstrap({ prefs, answer: 0 });
    // 换掉 getMainWindow 后再跑一次
    sandboxNoWin.ctx.Zotero.getMainWindow = () => null;
    // 缩短等待：把 40×500ms 的轮询也压掉
    sandboxNoWin.ctx.setTimeout = (fn) => setTimeout(fn, 1);
    await sandboxNoWin.ctx.startup({ version: manifest.version }, 3);
    await sleep(120);
    eq(sandboxNoWin.state.prompts, 0, 'B7 无主窗口时不弹窗');
    eq(prefs['extensions.zotero.paperpilot-migration.shownFor'], undefined,
      'B8 无主窗口时不写「已提示」（下次启动还能补上）');
  }

  if (fails.length) {
    console.error(`\n✗ 迁移提示包测试失败 ${fails.length} 项 / 通过 ${pass} 项`);
    for (const f of fails) console.error('  - ' + f);
    process.exit(1);
  }
  console.log(`✓ 迁移提示包测试全部通过（${pass} 项）`);
  process.exit(0);
})();
