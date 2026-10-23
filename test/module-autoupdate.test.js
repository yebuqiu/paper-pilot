#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 组件自动批量更新测试（P1-5，0.73.2）
 *
 * 背景：模块化后组件版本跟主包走（papilot-modules-index.json 每次发版都更新），
 * 用户升完主包不该再去组件商店逐个手动点更新。本特性在启动时复用同一轮
 * checkUpdates(false) 的结果，对已装且「有新版」的组件串行静默 install。
 *
 * 成败全在这几条上：
 *   ① shouldRun 纯函数：开关关 / 同版本 / 无已装组件 → 不跑；
 *   ② planUpdates 纯函数：从 checkUpdates.updates 取 id（去重、去空、容错）；
 *   ③ 执行体：串行（第二个 install 必须等第一个落定才开始）、单项失败记 diag
 *      继续下一个、完成后（无论单项成败）记账 modulesLastHostVersion；
 *   ④ 目录这一轮没拉到（checkResult.ok=false）→ **不记账**，下次启动再试；
 *   ⑤ 接线：prefs.js 有默认值、mods 卡片里有声明式绑定复选框。
 *
 * 运行：node test/module-autoupdate.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const MAIN = path.join(ROOT, 'chrome', 'content', 'scripts', 'main.js');
const XHTML = path.join(ROOT, 'chrome', 'content', 'prefs.xhtml');
const PREFS = path.join(ROOT, 'prefs.js');

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

/* ---------------- 桩环境：整份 main.js 进 vm（顶层只有 Zotero.Papilot = {...}） ---------------- */

function load(opts) {
  const o = opts || {};
  const PFX = 'extensions.zotero.papilot.';
  const prefStore = new Map(Object.entries(o.prefs || {}).map(([k, v]) => [PFX + k, v]));
  const Prefs = {
    get(k, d) { return prefStore.has(PFX + k) ? prefStore.get(PFX + k) : d; },
    set(k, v) { prefStore.set(PFX + k, v); },
  };
  const installCalls = [];
  const ModuleLoader = { list: () => (o.installed || []) };
  const ModuleStore = {
    async install(id) {
      installCalls.push(id);
      const behavior = (o.installBehavior || {})[id];
      if (behavior === 'throw') throw new Error('boom-' + id);
      if (behavior === 'fail') return { ok: false, error: '下载失败-' + id };
      if (typeof behavior === 'function') return behavior(id);
      return { ok: true, version: '9.9.9' };
    },
  };
  const sandbox = {
    console, JSON, Array, Object, String, Number, Promise, Error,
    Zotero: {}, Prefs, ModuleLoader, ModuleStore,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(MAIN, 'utf8'), sandbox, { filename: 'main.js' });
  const diags = [];
  const PP = sandbox.Zotero.Papilot;
  PP._diag = (m) => { diags.push(String(m)); };   // 不走 _ppDiag，直接收集
  return { PP, prefStore, PFX, installCalls, diags };
}

/* ---------------- ① shouldRun 纯函数 ---------------- */
{
  const { PP } = load({});
  const f = PP._moduleAutoUpdateShouldRun;
  eq(f({ enabled: true, lastVersion: '0.73.1', version: '0.73.2', installedCount: 3 }), true,
    '①.1 开关开 + 版本不同 + 有已装 → 跑');
  eq(f({ enabled: false, lastVersion: '0.73.1', version: '0.73.2', installedCount: 3 }), false,
    '①.2 ★ 开关关 → 不跑');
  eq(f({ enabled: true, lastVersion: '0.73.2', version: '0.73.2', installedCount: 3 }), false,
    '①.3 ★ 同版本 → 不跑（每版只跑一次）');
  eq(f({ enabled: true, lastVersion: '', version: '0.73.2', installedCount: 0 }), false,
    '①.4 ★ 无已装组件 → 不跑');
  eq(f({ enabled: true, lastVersion: '', version: '0.73.2', installedCount: 'abc' }), false,
    '①.5 installedCount 非数字 → 按 0 处理');
  eq(f(null), false, '①.6 null 入参 → 不跑（不抛）');
}

/* ---------------- ② planUpdates 纯函数 ---------------- */
{
  const { PP } = load({});
  const p = PP._moduleAutoUpdatePlan;
  eq(p([{ id: 'a' }, { id: 'b' }]).join(','), 'a,b', '②.1 取 id 保序');
  eq(p([{ id: 'a' }, { id: 'a' }, { id: 'b' }]).join(','), 'a,b', '②.2 去重');
  eq(p([{ id: 'a' }, null, {}, { id: '' }, { id: 'b' }]).join(','), 'a,b',
    '②.3 跳过空条目/缺 id/空 id');
  eq(p(null).length, 0, '②.4 null → 空数组（不抛）');
  eq(p('junk').length, 0, '②.5 非数组 → 空数组（不抛）');
  eq(p(undefined).length, 0, '②.6 undefined → 空数组（不抛）');
}

/* ---------------- ③ 执行体：串行 + 失败续跑 + 记账 ---------------- */

async function main() {
  // 3a. 同版本 → 不装、不记 diag
  {
    const { PP, installCalls, diags } = load({ prefs: { modulesLastHostVersion: '0.73.2' }, installed: [{ id: 'a' }] });
    await PP._autoUpdateModules('0.73.2', { ok: true, updates: [{ id: 'a' }] });
    eq(installCalls.length, 0, '③a.1 同版本 → 零安装');
    eq(diags.length, 0, '③a.2 同版本 → 静默');
  }

  // 3b. 开关关 → 不装
  {
    const { PP, installCalls } = load({
      prefs: { modulesAutoUpdate: false },
      installed: [{ id: 'a' }],
    });
    await PP._autoUpdateModules('0.73.2', { ok: true, updates: [{ id: 'a' }] });
    eq(installCalls.length, 0, '③b.1 ★ 开关关 → 不装任何组件');
  }

  // 3c. 目录没拉到（ok=false）→ 不装、**不记账**（下次启动再试）
  {
    const { PP, prefStore, PFX, installCalls } = load({ installed: [{ id: 'a' }] });
    await PP._autoUpdateModules('0.73.2', { ok: false, error: 'offline', updates: [] });
    eq(installCalls.length, 0, '③c.1 离线轮 → 不装');
    eq(prefStore.get(PFX + 'modulesLastHostVersion'), undefined,
      '③c.2 ★ 离线轮不记账（下次启动还会再试）');
  }

  // 3d. 串行证据：第二个 install 开始时第一个必须已落定
  {
    const order = [];
    const { PP, prefStore, PFX, diags } = load({
      installed: [{ id: 'a' }, { id: 'b' }],
      installBehavior: {
        a: async () => { await new Promise((r) => setTimeout(r, 20)); order.push('a-done'); return { ok: true, version: '1' }; },
        b: async () => { order.push('b-start'); return { ok: true, version: '1' }; },
      },
    });
    await PP._autoUpdateModules('0.73.2', { ok: true, updates: [{ id: 'a' }, { id: 'b' }] });
    eq(order.join(','), 'a-done,b-start', '③d.1 ★ 串行：a 落定后 b 才开始');
    eq(prefStore.get(PFX + 'modulesLastHostVersion'), '0.73.2', '③d.2 完成后记账');
    ok(diags.some((d) => d.indexOf('module auto-update: updated=2 failed=0') >= 0),
      '③d.3 汇总 diag：updated=2 failed=0', diags);
  }

  // 3e. 单项失败（ok:false 与抛异常两种）→ 记 diag、继续下一个、仍记账
  {
    const { PP, prefStore, PFX, installCalls, diags } = load({
      installed: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      installBehavior: { a: 'fail', b: 'throw' },
    });
    await PP._autoUpdateModules('0.73.2', { ok: true, updates: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
    eq(installCalls.join(','), 'a,b,c', '③e.1 ★ 失败不中断：三个都尝试过');
    eq(prefStore.get(PFX + 'modulesLastHostVersion'), '0.73.2', '③e.2 ★ 有失败也记账（下个主版本再跑）');
    ok(diags.some((d) => d.indexOf('module auto-update: updated=1 failed=2') >= 0),
      '③e.3 汇总 diag：updated=1 failed=2', diags);
    ok(diags.some((d) => d.indexOf('FAILED a') >= 0) && diags.some((d) => d.indexOf('FAILED b') >= 0),
      '③e.4 单项失败各记一条 diag', diags);
  }

  // 3f. 有已装但无更新 → 不装、记账、记一条 updated=0 汇总
  {
    const { PP, prefStore, PFX, installCalls, diags } = load({ installed: [{ id: 'a' }] });
    await PP._autoUpdateModules('0.73.2', { ok: true, updates: [] });
    eq(installCalls.length, 0, '③f.1 无更新 → 不装');
    eq(prefStore.get(PFX + 'modulesLastHostVersion'), '0.73.2', '③f.2 记账');
    ok(diags.some((d) => d.indexOf('module auto-update: updated=0 failed=0') >= 0),
      '③f.3 汇总 diag 照常', diags);
  }

  // 3g. checkUpdates 结果为 null（异常路径）→ 静默，不抛、不记账
  {
    const { PP, prefStore, PFX } = load({ installed: [{ id: 'a' }] });
    let threw = false;
    try { await PP._autoUpdateModules('0.73.2', null); } catch (e) { threw = true; }
    eq(threw, false, '③g.1 ★ null 结果不抛（绝不打断启动）');
    eq(prefStore.get(PFX + 'modulesLastHostVersion'), undefined, '③g.2 不记账');
  }

  /* ---------------- ④ 接线：pref 默认值 + 面板复选框 ---------------- */
  const prefsDef = fs.readFileSync(PREFS, 'utf8');
  ok(/pref\("extensions\.zotero\.papilot\.modulesAutoUpdate",\s*true\)/.test(prefsDef),
    '④.1 ★ prefs.js 注册 modulesAutoUpdate 默认 true');

  const xhtml = fs.readFileSync(XHTML, 'utf8');
  ok(xhtml.indexOf('&nbsp;') < 0, '④.2 prefs.xhtml 无 &nbsp;（未定义实体会整页 XML 解析失败）');
  const modsStart = xhtml.indexOf('data-fold="mods"');
  ok(modsStart >= 0, '④.3 mods 卡片存在');
  // 复选框必须落在 mods 卡片内部（下一张卡片/分类标签之前）
  const rest = xhtml.slice(modsStart);
  const nextCard = rest.search(/data-fold="(?!mods")/);
  const modsCard = nextCard > 0 ? rest.slice(0, nextCard) : rest;
  ok(modsCard.indexOf('preference="extensions.zotero.papilot.modulesAutoUpdate"') >= 0,
    '④.4 ★ 复选框声明式绑定在 mods 卡片内部');
  ok(modsCard.indexOf('id="pp-mods-autoupdate"') >= 0, '④.5 复选框带 id pp-mods-autoupdate');
  ok(modsCard.indexOf('主包升级后自动更新组件') >= 0, '④.6 复选框文案在卡片内');
  // 只许动 mods 卡片：复选框全文只此一处
  eq(xhtml.split('modulesAutoUpdate').length - 1, 1, '④.7 modulesAutoUpdate 全文仅 mods 卡片一处');

  // main.js 侧接线：复用同一轮 checkUpdates 结果、fire-and-forget
  const mainSrc = fs.readFileSync(MAIN, 'utf8');
  ok(mainSrc.indexOf('this._autoUpdateModules(version, r)') >= 0,
    '④.8 ★ 复用同一轮 checkUpdates(false) 的结果（不重复拉目录）');
  eq((mainSrc.match(/this\._autoUpdateModules\(/g) || []).length, 1,
    '④.9 _autoUpdateModules 只调用一次');

  /* ---------------- 输出 ---------------- */
  console.log('='.repeat(60));
  if (fails.length) {
    for (const f of fails) console.log('  ✗ ' + f);
    console.log('-'.repeat(60));
  }
  console.log('组件自动批量更新：' + pass + ' 通过 / ' + fails.length + ' 失败');
  console.log('='.repeat(60));
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => {
  console.log('✗ 测试自身异常：' + (e && e.stack || e));
  process.exit(1);
});
