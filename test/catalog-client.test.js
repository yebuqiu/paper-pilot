#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 共享目录基建（catalog-client）离线单测
 *
 * 覆盖：
 *   ① 源顺序：官方列表按序 + 镜像 pref 置顶（空值不置顶）；
 *   ② 失败源会话记忆：URL 挂一次本会话跳过（不再等超时），clearFailures 可复位，
 *      rememberFailures:false 时每次都真实尝试；
 *   ③ TTL 缓存：命中（source=cache、不发请求）、过期穿透、成功写 pref；
 *   ④ 校验失败降级：validate 拒绝 → 换下一源，错误带「目录结构非法」；
 *   ⑤ 兜底：全失败回落过期缓存（stale-cache + 保留根因），无缓存 ok:false；
 *   ⑥ 返回形状：{ok,data} 与顶层 modules/items/updated 同时存在（窗口接缝守卫）；
 *   ⑦ 默认 HTTP：JSON 8s / 二进制 60s 超时、Promise 形式 Zotero.HTTP.request、
 *      response/responseText 双通道解析。
 *
 * 纪律：不发真实网络请求；httpGet/prefGet/prefSet/now 全部是桩。
 * 运行：node test/catalog-client.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'chrome', 'content', 'scripts', 'core', 'catalog-client.js'), 'utf8');

let pass = 0;
const fails = [];
function ok(cond, label, extra) {
  if (cond) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  <- ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }
function has(hay, needle, label) { return ok(String(hay).indexOf(needle) >= 0, label, needle); }

const URL_A = 'https://raw.githubusercontent.com/x/y/main/index.json';
const URL_B = 'https://gitee.com/x/y/raw/main/index.json';
const URL_M = 'https://mirror.example.com/index.json';

/* ---------------- 上下文工厂（每个用例独立沙箱，互不污染） ---------------- */

function makeEnv() {
  const sandbox = {
    console: { log: function () {}, error: function () {}, warn: function () {} },
    Zotero: { HTTP: null },   // 默认 HTTP 用例再填桩
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'core/catalog-client.js' });
  return sandbox;
}

/** 造一个客户端 + 全套桩。o: {urls, mirrorPref, cachePref, cacheTtlMs, validate, rememberFailures, httpGet, sourceLabel} */
function makeClient(sandbox, o) {
  const prefs = new Map();
  const state = { now: 1750000000000 };
  const calls = [];
  const diagMsgs = [];
  const client = sandbox.CatalogClient.create({
    urls: o.urls || [URL_A, URL_B],
    mirrorPref: o.mirrorPref === undefined ? 'mirrorUrl' : o.mirrorPref,
    cachePref: o.cachePref === undefined ? 'catCache' : o.cachePref,
    cacheTtlMs: o.cacheTtlMs === undefined ? 1000 : o.cacheTtlMs,
    validate: o.validate || null,
    sourceLabel: o.sourceLabel || null,
    rememberFailures: o.rememberFailures,
    prefGet: function (k, def) { return prefs.has(k) ? prefs.get(k) : def; },
    prefSet: function (k, v) { prefs.set(k, v); },
    diag: function (m) { diagMsgs.push(String(m)); },
    now: function () { return state.now; },
    httpGet: o.httpGet || async function (url) { calls.push(url); throw new Error('offline: ' + url); },
  });
  return { client: client, prefs: prefs, state: state, calls: calls, diagMsgs: diagMsgs };
}

const CAT = { schema: 1, updated: '2026-10-22T00:00:00Z', modules: [{ id: 'mod-a', version: '1.0.0' }] };

/* ================= ① 源顺序与镜像置顶 ================= */

async function testSourceOrder() {
  const sb = makeEnv();

  // 镜像 pref 为空 → 官方列表原序
  const e1 = makeClient(sb, {});
  eq(e1.client.urls().join(','), URL_A + ',' + URL_B, '源顺序：镜像 pref 空时按官方列表原序');

  // 镜像 pref 非空 → 置顶
  const e2 = makeClient(sb, {});
  e2.prefs.set('mirrorUrl', URL_M);
  eq(e2.client.urls().join(','), [URL_M, URL_A, URL_B].join(','), '镜像置顶：pref 值排在官方列表之前');

  // urls() 返回副本，改它不污染配置
  e2.client.urls().push('junk');
  eq(e2.client.urls().length, 3, '源顺序：urls() 返回副本（外部改动不污染）');

  // 拉取按解析顺序：镜像成功则官方源不发请求
  const e3 = makeClient(sb, {
    httpGet: async function (url) { e3.calls.push(url); return CAT; },
  });
  e3.prefs.set('mirrorUrl', URL_M);
  const r3 = await e3.client.fetch(false);
  eq(r3.ok, true, '镜像置顶：镜像源成功');
  eq(e3.calls.join(','), URL_M, '镜像置顶：只请求了镜像源');
  eq(r3.url, URL_M, '镜像置顶：结果带实际来源 URL');

  // 镜像挂 → 按序降到官方源
  const e4 = makeClient(sb, {
    httpGet: async function (url) {
      e4.calls.push(url);
      if (url === URL_M) throw new Error('mirror 502');
      return CAT;
    },
  });
  e4.prefs.set('mirrorUrl', URL_M);
  const r4 = await e4.client.fetch(true);
  eq(r4.ok, true, '镜像降级：镜像挂后仍拿到目录');
  eq(e4.calls.join(','), [URL_M, URL_A].join(','), '镜像降级：按序尝试 镜像→官方A');

  // sourceLabel 注入（module-store 的 gitee/github 标记走这里）
  const e5 = makeClient(sb, {
    sourceLabel: function (url) { return String(url).indexOf('gitee') >= 0 ? 'gitee' : 'github'; },
    httpGet: async function (url) {
      e5.calls.push(url);
      if (url === URL_A) throw new Error('github 403');
      return CAT;
    },
  });
  const r5 = await e5.client.fetch(true);
  eq(r5.source, 'gitee', 'sourceLabel：gitee URL 标记为 gitee');
}

/* ================= ② 失败源会话记忆 ================= */

async function testFailureMemory() {
  const sb = makeEnv();
  const e = makeClient(sb, {
    httpGet: async function (url) {
      e.calls.push(url);
      if (url === URL_A) throw new Error('github 403');
      return CAT;
    },
  });
  const r1 = await e.client.fetch(true);
  eq(r1.ok, true, '失败记忆：A 挂 B 顶上');
  eq(e.client.deadUrls[URL_A], 1, '失败记忆：A 已记 dead');
  eq(e.client.deadUrls[URL_B], undefined, '失败记忆：B 未被误记');

  // 第二次（force 穿透缓存）：A 直接跳过，不等超时
  const r2 = await e.client.fetch(true);
  eq(r2.ok, true, '失败记忆：二次拉取仍成功');
  eq(e.calls.join(','), [URL_A, URL_B, URL_B].join(','), '失败记忆：二次拉取跳过已知不通的 A');
  ok(e.diagMsgs.some(function (m) { return m.indexOf('本会话已知不通') >= 0; }),
    '失败记忆：跳过时写诊断日志');

  // clearFailures 复位 → A 重新尝试（仍挂，于是 B 再次顶上）
  e.client.clearFailures();
  await e.client.fetch(true);
  eq(e.calls.length, 5, '失败记忆：clearFailures 后恢复完整尝试链');
  eq(e.calls[3], URL_A, '失败记忆：重试的正是 A');

  // rememberFailures:false → 不记不跳（技能包语义：用户可改 pref 自救）
  const e2 = makeClient(sb, {
    rememberFailures: false,
    httpGet: async function (url) { e2.calls.push(url); throw new Error('down'); },
  });
  await e2.client.fetch(true);
  await e2.client.fetch(true);
  eq(e2.calls.join(','), [URL_A, URL_B, URL_A, URL_B].join(','),
    '失败记忆：rememberFailures=false 时每次都真实尝试');
  eq(Object.keys(e2.client.deadUrls).length, 0, '失败记忆：rememberFailures=false 不写 deadUrls');
}

/* ================= ③ TTL 缓存 ================= */

async function testTtlCache() {
  const sb = makeEnv();
  const e = makeClient(sb, {
    httpGet: async function (url) { e.calls.push(url); return CAT; },
  });
  const r1 = await e.client.fetch(false);
  eq(r1.ok, true, 'TTL：首发成功');
  ok(e.prefs.has('catCache'), 'TTL：成功目录写入 pref 缓存');
  const cachedRaw = JSON.parse(e.prefs.get('catCache'));
  eq(cachedRaw.ts, e.state.now, 'TTL：缓存时间戳来自注入的 now');
  eq(cachedRaw.data.modules.length, 1, 'TTL：缓存内容完整');

  // 命中：TTL 内再拉 → source=cache，零请求
  e.calls.length = 0;
  e.state.now += 500;
  const r2 = await e.client.fetch(false);
  eq(r2.ok, true, 'TTL：命中返回 ok');
  eq(r2.source, 'cache', 'TTL：命中标记 source=cache');
  eq(r2.ts, cachedRaw.ts, 'TTL：命中透出缓存时间戳（不是当前时间）');
  eq(e.calls.length, 0, 'TTL：命中期内不发请求');

  // 过期：穿透缓存重新走网络
  e.state.now += 501;   // 距缓存 ts 共 1001ms > TTL 1000
  const r3 = await e.client.fetch(false);
  eq(r3.ok, true, 'TTL：过期后重新拉取成功');
  eq(r3.source, URL_A, 'TTL：过期后来源是真实 URL（无 sourceLabel 时用 URL 本身）');
  eq(e.calls.length, 1, 'TTL：过期穿透发了新请求');

  // force=true：TTL 内也强制穿透
  e.calls.length = 0;
  const r4 = await e.client.fetch(true);
  eq(e.calls.length, 1, 'TTL：force=true 穿透缓存');

  // cachePref:null → 完全不缓存（技能包语义）
  const e2 = makeClient(sb, {
    cachePref: null,
    httpGet: async function (url) { e2.calls.push(url); return CAT; },
  });
  await e2.client.fetch(false);
  await e2.client.fetch(false);
  eq(e2.calls.length, 2, 'TTL：cachePref=null 时每次都走网络');
  ok(!e2.prefs.has('catCache'), 'TTL：cachePref=null 不写缓存');

  // 坏值容错：缓存 pref 是坏 JSON → 当作无缓存走网络
  const e3 = makeClient(sb, {
    httpGet: async function (url) { e3.calls.push(url); return CAT; },
  });
  e3.prefs.set('catCache', '###not json###');
  const r5 = await e3.client.fetch(false);
  eq(r5.ok, true, 'TTL：坏缓存容错后走网络成功');
  eq(e3.calls.length, 1, 'TTL：坏缓存不产生假命中');
}

/* ================= ④ 校验失败降级 ================= */

async function testValidateFallback() {
  const sb = makeEnv();
  const e = makeClient(sb, {
    validate: function (data) {
      return (data && Array.isArray(data.modules) && data.modules.length > 0)
        ? { ok: true, errors: [] }
        : { ok: false, errors: ['modules 为空'] };
    },
    httpGet: async function (url) {
      e.calls.push(url);
      if (url === URL_A) return { modules: [] };   // A 返回结构非法数据
      return CAT;
    },
  });
  const r = await e.client.fetch(true);
  eq(r.ok, true, '校验降级：A 结构非法后 B 顶上');
  eq(e.calls.join(','), [URL_A, URL_B].join(','), '校验降级：两源都尝试过');
  eq(r.url, URL_B, '校验降级：成功源是 B');
  eq(e.client.deadUrls[URL_A], 1, '校验降级：结构非法的源同样记 dead（防每操作重试）');
  ok(e.diagMsgs.some(function (m) { return m.indexOf('目录结构非法') >= 0; }),
    '校验降级：诊断带「目录结构非法」根因');
}

/* ================= ⑤ 全失败兜底 ================= */

async function testStaleFallback() {
  const sb = makeEnv();

  // 全失败 + 过期缓存 → stale-cache（保留根因）
  const e1 = makeClient(sb, {
    httpGet: async function () { throw new Error('network down'); },
  });
  const staleTs = 1750000000000 - 13 * 60 * 60 * 1000;
  e1.prefs.set('catCache', JSON.stringify({ ts: staleTs, data: CAT }));
  const r1 = await e1.client.fetch(false);
  eq(r1.ok, true, '兜底：全失败时过期缓存仍返回数据');
  eq(r1.source, 'stale-cache', '兜底：来源标记 stale-cache');
  eq(r1.data.modules.length, 1, '兜底：过期缓存内容完整');
  eq(r1.ts, staleTs, '兜底：透出原缓存时间戳');
  has(r1.error, 'network down', '兜底：保留最后一次错误根因');

  // 全失败 + 无缓存 → ok:false
  const e2 = makeClient(sb, {
    httpGet: async function () { throw new Error('dns failure'); },
  });
  const r2 = await e2.client.fetch(false);
  eq(r2.ok, false, '兜底：无缓存时 ok=false');
  has(r2.error, 'dns failure', '兜底：error 保留根因');
  eq(r2.modules.length, 0, '兜底：失败形状带空 modules（窗口不会读到 undefined）');

  // 源列表为空（无镜像无官方源）→ ok:false，不发请求
  const e3 = makeClient(sb, { urls: [], mirrorPref: 'mirrorUrl' });
  const r3 = await e3.client.fetch(false);
  eq(r3.ok, false, '兜底：源列表为空直接 ok:false');
  eq(e3.calls.length, 0, '兜底：源列表为空不发请求');
}

/* ================= ⑥ 返回形状（接缝守卫） ================= */

async function testResultShape() {
  const sb = makeEnv();

  // modules 目录：顶层 modules/updated 直读可用（商店窗口接缝，0.48.4 同款事故）
  const e1 = makeClient(sb, {
    httpGet: async function () { return CAT; },
  });
  const r1 = await e1.client.fetch(false);
  eq(r1.ok, true, '形状：ok 标记');
  eq(Array.isArray(r1.modules) ? r1.modules.length : -1, 1, '形状：顶层 modules 直读（窗口接缝）');
  eq(r1.updated, '2026-10-22T00:00:00Z', '形状：顶层 updated 透出');
  eq(r1.data.modules[0].id, 'mod-a', '形状：data 原样保留');

  // items 目录：顶层 items 直读
  const e2 = makeClient(sb, {
    httpGet: async function () { return { items: [{ id: 'x' }] }; },
  });
  const r2 = await e2.client.fetch(false);
  eq(r2.items.length, 1, '形状：顶层 items 直读');
  eq(r2.modules.length, 0, '形状：无 modules 时给空数组（不是 undefined）');

  // 失败形状：顶层字段齐全
  const e3 = makeClient(sb, {});
  const r3 = await e3.client.fetch(false);
  eq(r3.ok, false, '形状：失败 ok=false');
  ok(Array.isArray(r3.modules) && Array.isArray(r3.items), '形状：失败也给空数组');
  eq(r3.updated, null, '形状：失败 updated=null');
  eq(r3.source, null, '形状：失败 source=null');
}

/* ================= ⑦ 默认 HTTP（Promise 形式 + 双超时） ================= */

async function testDefaultHttp() {
  const sb = makeEnv();
  eq(sb.CatalogClient.JSON_TIMEOUT_MS, 8000, '超时：JSON 8s 常量');
  eq(sb.CatalogClient.BINARY_TIMEOUT_MS, 60000, '超时：二进制 60s 常量');

  // JSON：responseType=json + 8s；优先 req.response，回退 responseText
  const calls = [];
  sb.Zotero.HTTP = {
    request: function (method, url, opts) {
      calls.push({ method: method, url: url, opts: opts });
      return Promise.resolve({ responseText: JSON.stringify(CAT) });
    },
  };
  const obj = await sb.CatalogClient.httpGet(URL_A);
  eq(obj.modules.length, 1, 'HTTP：responseText 通道 JSON.parse 成功');
  eq(calls[0].method, 'GET', 'HTTP：GET 方法');
  eq(calls[0].opts.timeout, 8000, 'HTTP：JSON 8s 超时');
  eq(calls[0].opts.responseType, 'json', 'HTTP：responseType=json');

  sb.Zotero.HTTP = {
    request: function () { return Promise.resolve({ response: CAT }); },
  };
  const obj2 = await sb.CatalogClient.httpGet(URL_A);
  eq(obj2.modules[0].id, 'mod-a', 'HTTP：response 对象通道优先');

  // 二进制：60s + arraybuffer → Uint8Array；空响应抛错
  sb.Zotero.HTTP = {
    request: function (method, url, opts) {
      calls.push({ method: method, url: url, opts: opts });
      return Promise.resolve({ response: new Uint8Array([80, 75, 3, 4]).buffer });
    },
  };
  const bytes = await sb.CatalogClient.httpGetBytes(URL_B);
  // 沙箱是独立 realm，跨 realm instanceof Uint8Array 必假——验长度与内容即可
  ok(bytes && bytes.length === 4 && bytes[0] === 80 && bytes[3] === 4, 'HTTP：二进制转 Uint8Array');
  eq(calls[1].opts.timeout, 60000, 'HTTP：二进制 60s 超时');
  eq(calls[1].opts.responseType, 'arraybuffer', 'HTTP：responseType=arraybuffer');

  sb.Zotero.HTTP = {
    request: function () { return Promise.resolve({ response: null }); },
  };
  let threw = false;
  try { await sb.CatalogClient.httpGetBytes(URL_B); } catch (e) { threw = true; }
  ok(threw, 'HTTP：空二进制响应抛错');

  // create 不传 httpGet 时默认走 CatalogClient.httpGet
  sb.Zotero.HTTP = {
    request: function () { return Promise.resolve({ response: CAT }); },
  };
  const direct = sb.CatalogClient.create({ urls: [URL_A] });
  const r = await direct.fetch(true);
  eq(r.ok, true, 'HTTP：客户端缺省 httpGet 走共享默认实现');
}

/* ================= main ================= */

async function main() {
  await testSourceOrder();
  await testFailureMemory();
  await testTtlCache();
  await testValidateFallback();
  await testStaleFallback();
  await testResultShape();
  await testDefaultHttp();

  if (fails.length) {
    console.log('');
    for (const f of fails) console.log('✗ ' + f);
    console.log('');
    console.log('catalog-client：' + pass + ' 通过，' + fails.length + ' 失败');
    process.exitCode = 1;
    return;
  }
  console.log('✓ ' + pass + ' assertions  (catalog-client)');
  process.exitCode = 0;
}

main().catch(function (e) {
  if (fails.length) {
    console.log('');
    for (const f of fails) console.log('✗ ' + f);
  }
  console.error('测试框架异常:', e);
  process.exitCode = 1;
});
