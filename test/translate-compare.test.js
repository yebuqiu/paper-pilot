#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 多引擎同屏对比 · 编排测试（C2，0.40.0）
 *
 * 为什么要有它：对比小窗的核心价值是「并行 + 失败隔离 + 按序聚合」——
 * 编排一错，表现就是「一个引擎挂了整窗空白」或「结果张冠李戴」，且窗口侧
 * 无法单测（XUL 窗口跑不进 Node）。编排放在插件侧 TranslateCompare.runAll /
 * defaultEngines / compare，这里桩掉 TranslateSvc/Zotero 后在 Node 里真跑：
 *   ① 并行：多任务同时起跑（用并发计数证明不是串行）；
 *   ② 失败隔离：单引擎 reject 只影响自己那条，其他条正常返回，整体不 reject；
 *   ③ 聚合：结果顺序与输入一致，ok/text/error/ms 字段齐全，耗时非负；
 *   ④ compare()：显式 engine 调 TranslateSvc.translate（不走回退链），
 *      引擎失败翻译层错误透传到该栏；
 *   ⑤ defaultEngines()：活动引擎 + 回退链里 ready 的去重取前 3，全不 ready
 *      退为活动引擎本身。
 *
 * 运行：node test/translate-compare.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FILE = 'chrome/content/scripts/features/translate-compare.js';

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  <- ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

/* ---------------- 沙箱加载 ---------------- */

function loadModule(stub) {
  const sandbox = {
    console,
    Zotero: (stub && stub.Zotero) || {},
    Services: (stub && stub.Services) || {},
    TranslateSvc: (stub && stub.TranslateSvc) || {},
    I18n: (stub && stub.I18n) || { isZh: true },
  };
  vm.createContext(sandbox);
  const code = fs.readFileSync(path.join(ROOT, FILE), 'utf8');
  vm.runInContext(code, sandbox, { filename: FILE });
  return sandbox.TranslateCompare;
}

async function main() {
  const TC = loadModule();

  /* ① 并行：3 个任务各 60ms，串行要 180ms+；并发起跑则总耗时远小于串行，
   *    且并发计数器应达到 3（证明同时起跑，不是逐个 await） */
  {
    let active = 0;
    let maxActive = 0;
    const mk = (id, ms) => ({
      engine: id, name: id,
      run: () => new Promise((res) => {
        active++; maxActive = Math.max(maxActive, active);
        setTimeout(() => { active--; res('out-' + id); }, ms);
      }),
    });
    const t0 = Date.now();
    const r = await TC.runAll([mk('a', 60), mk('b', 60), mk('c', 60)]);
    const elapsed = Date.now() - t0;
    eq(maxActive, 3, 'parallel: 3 tasks started together (max concurrency = 3)');
    ok(elapsed < 170, 'parallel: total elapsed << serial sum', { elapsed });
    eq(r.length, 3, 'parallel: 3 results');
    ok(r.every((x) => x.ok && x.text === 'out-' + x.engine), 'parallel: all ok with own text');
  }

  /* ② 失败隔离 + ③ 聚合顺序与字段 */
  {
    const tasks = [
      { engine: 'ok1', name: '引擎一', run: async () => '译文一' },
      { engine: 'bad', name: '引擎二', run: async () => { throw new Error('HTTP 429'); } },
      { engine: 'ok2', name: '引擎三', run: async () => '译文三' },
      { engine: 'bad2', name: '引擎四', run: async () => { throw 'string-error'; } },
    ];
    let threw = false;
    let r = null;
    try { r = await TC.runAll(tasks); } catch (e) { threw = true; }
    ok(!threw, 'isolation: runAll never rejects as a whole');
    eq(r.length, 4, 'aggregate: 4 results for 4 tasks');
    eq(r[0].engine, 'ok1', 'aggregate: order preserved [0]');
    eq(r[3].engine, 'bad2', 'aggregate: order preserved [3]');
    ok(r[0].ok && r[0].text === '译文一', 'isolation: ok1 unaffected');
    ok(!r[1].ok && r[1].error.indexOf('HTTP 429') >= 0, 'isolation: bad carries its error', r[1]);
    ok(r[2].ok && r[2].text === '译文三', 'isolation: ok2 unaffected by neighbor failure');
    ok(!r[3].ok && r[3].error.length > 0, 'isolation: non-Error throw normalized to string');
    ok(r.every((x) => typeof x.ms === 'number' && x.ms >= 0), 'aggregate: latency ms >= 0 on every row');
    ok(r.every((x) => typeof x.name === 'string' && x.name.length > 0), 'aggregate: name on every row');
    eq(r[1].text, '', 'isolation: failed row has empty text (window renders error placeholder)');
  }

  /* ③b 边界：空任务表 / 非数组 */
  {
    const r0 = await TC.runAll([]);
    eq(r0.length, 0, 'edge: empty tasks -> empty results');
    const r1 = await TC.runAll(null);
    eq(r1.length, 0, 'edge: null tasks -> empty results');
  }

  /* ④ compare()：显式 engine 调用（桩 TranslateSvc，验证不走回退链 + 错误透传） */
  {
    const calls = [];
    const stubSvc = {
      get: (id) => (['e1', 'e2', 'e3'].indexOf(id) >= 0 ? { id, name: '名称-' + id } : null),
      translate: async (text, o) => {
        calls.push({ text, o });
        if (o.engine === 'e2') return { ok: false, error: '密钥无效', tried: [] };
        return { ok: true, text: '[' + o.engine + '] ' + text, engine: o.engine, tried: [] };
      },
    };
    const TC2 = loadModule({ TranslateSvc: stubSvc });
    const r = await TC2.compare(['e1', 'e2', 'e3', 'ghost'], 'hello');
    eq(r.length, 3, 'compare: unknown engine filtered out');
    ok(calls.every((c) => c.o && c.o.engine && !c.o.noFallback), 'compare: explicit engine per call (no fallback chain)');
    eq(calls.length, 3, 'compare: exactly one translate call per engine');
    ok(r[0].ok && r[0].text === '[e1] hello', 'compare: e1 ok with text');
    ok(!r[1].ok && r[1].error === '密钥无效', 'compare: e2 failure isolated with svc error');
    ok(r[2].ok, 'compare: e3 ok despite e2 failure');
    eq(r[0].name, '名称-e1', 'compare: engine display name from registry');
    const rEmpty = await TC2.compare(['e1'], '   ');
    eq(rEmpty.length, 0, 'compare: blank text -> no calls');
    eq(calls.length, 3, 'compare: blank text made no translate calls');
  }

  /* ⑤ defaultEngines() */
  {
    const mkSvc = (cfgDoc, readyIds) => ({
      cfg: () => cfgDoc,
      ready: (id) => readyIds.indexOf(id) >= 0,
    });
    // 活动 + 回退链 ready 去重取前 3
    const TC3 = loadModule({ TranslateSvc: mkSvc(
      { active: 'deepl', fallback: ['edge', 'google', 'deepl', 'bing'] },
      ['deepl', 'google', 'bing']) });
    const d1 = TC3.defaultEngines(3);
    eq(JSON.stringify(d1), JSON.stringify(['deepl', 'google', 'bing']),
      'defaultEngines: active first, dedup, ready-only, cap 3');
    // ready 不足 3 个就有几个算几个
    const TC4 = loadModule({ TranslateSvc: mkSvc(
      { active: 'llm', fallback: ['edge', 'google'] }, ['edge']) });
    eq(JSON.stringify(TC4.defaultEngines(3)), JSON.stringify(['edge']),
      'defaultEngines: only ready ones survive');
    // 全不 ready → 退为活动引擎本身（窗口如实显示失败原因，不静默空窗）
    const TC5 = loadModule({ TranslateSvc: mkSvc(
      { active: 'deepl', fallback: ['edge'] }, []) });
    eq(JSON.stringify(TC5.defaultEngines(3)), JSON.stringify(['deepl']),
      'defaultEngines: none ready -> active engine itself');
    // n=2 截断
    const TC6 = loadModule({ TranslateSvc: mkSvc(
      { active: 'a', fallback: ['b', 'c', 'd'] }, ['a', 'b', 'c', 'd']) });
    eq(JSON.stringify(TC6.defaultEngines(2)), JSON.stringify(['a', 'b']),
      'defaultEngines: respects n');
  }

  /* ---------------- 汇总 ---------------- */
  console.log('');
  if (fails.length) {
    console.log('FAIL ' + fails.length + ' / ' + (pass + fails.length));
    for (const f of fails) console.log('  x ' + f);
    process.exit(1);
  }
  console.log('PASS ' + pass + ' assertions  (translate-compare)');
}

main().catch((e) => { console.error(e); process.exit(1); });
