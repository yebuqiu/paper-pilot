#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 组件目录与安装编排（module-store）离线单测
 *
 * 覆盖：
 *   ① 目录校验：id 规则 + 下载源/清单源白名单（模块自带第三方 URL 一律拒绝）；
 *   ② 三级降级：GitHub 失败 → Gitee；全失败 → 过期缓存；无缓存 → ok:false + lastError；
 *   ③ 列表合并：目录 ∪ 已装（目录下架的也要列，否则用户没法卸载）；
 *   ④ Pro 门控、安装编排顺序（清单 → 包 → loader）、whatsNew/统计记账、id 不一致拒绝。
 *
 * 纪律：不发真实网络请求；httpGet / httpGetBytes / loader 全部是桩，
 *      时间戳只来自 fake now（不读系统时钟）。
 * 运行：node test/module-store.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'chrome', 'content', 'scripts', 'core', 'module-store.js');
const STORE_SRC = fs.readFileSync(SRC, 'utf8');
// 共享目录基建（0.73.2 P1-4 抽取）：module-store 的目录拉取/缓存/失败源记忆已委托给它
const CAT_SRC = fs.readFileSync(path.join(ROOT, 'chrome', 'content', 'scripts', 'core', 'catalog-client.js'), 'utf8');

let pass = 0;
const fails = [];

function ok(cond, label, extra) {
  if (cond) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  <- ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }
function has(hay, needle, label) {
  return ok(String(hay).indexOf(needle) >= 0, label, needle);
}

/* 与被测 loader 同语义的版本比较（store 通过 loader._pure 委托） */
function cmp(a, b) {
  const pa = String(a == null ? '0' : a).split('.').map(function (x) { return parseInt(x, 10) || 0; });
  const pb = String(b == null ? '0' : b).split('.').map(function (x) { return parseInt(x, 10) || 0; });
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

const P = {
  join: function () {
    const out = [];
    for (let i = 0; i < arguments.length; i++) {
      for (const seg of String(arguments[i] == null ? '' : arguments[i]).split('/')) {
        if (!seg || seg === '.') continue;
        if (seg === '..') out.pop(); else out.push(seg);
      }
    }
    return '/' + out.join('/');
  },
  parent: function (p) {
    const s = String(p).replace(/\/+$/, '');
    const i = s.lastIndexOf('/');
    return i <= 0 ? '/' : s.slice(0, i);
  },
};

/* ---------------- 上下文工厂（每个用例独立实例，互不污染） ---------------- */

function makeStore(opts) {
  const o = opts || {};
  const prefs = new Map();
  const state = { now: 1750000000000 };
  const diagMsgs = [];
  const io = { dirs: [], writes: [], removed: [] };
  const sandbox = {
    console: { log: function () {}, error: function () {}, warn: function () {} },
    Zotero: o.zotero || { Papilot: {} },
    PathUtils: P,
    IOUtils: {
      makeDirectory: async function (p) { io.dirs.push(p); },
      write: async function (p, bytes) { io.writes.push([p, bytes]); },
      remove: async function (p) { io.removed.push(p); },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(CAT_SRC, sandbox, { filename: 'core/catalog-client.js' });
  vm.runInContext(STORE_SRC, sandbox, { filename: 'core/module-store.js' });

  const deps = {
    prefGet: function (k, def) { return prefs.has(k) ? prefs.get(k) : def; },
    prefSet: function (k, v) { prefs.set(k, v); },
    httpGet: o.httpGet || async function (url) { throw new Error('offline: ' + url); },
    httpGetBytes: o.httpGetBytes || async function (url) { throw new Error('offline: ' + url); },
    diag: function (m) { diagMsgs.push(String(m)); },
    now: function () { return state.now; },
  };
  const store = sandbox.ModuleStore;
  store.init({ loader: o.loader || null, deps: deps });
  return { store: store, prefs: prefs, state: state, diagMsgs: diagMsgs, io: io, sandbox: sandbox };
}

/* ---------------- 目录夹具 ---------------- */

function modEntry(id, version, extra) {
  const base = {
    id: id,
    name: id,
    version: version,
    description: id + ' 的描述',
    sizeBytes: 1024,
    fileCount: 3,
    download: {
      github: 'https://github.com/papilot-lab/' + id + '/releases/download/v' + version + '/' + id + '.zip',
      gitee: 'https://gitee.com/papilot-lab/' + id + '/releases/download/v' + version + '/' + id + '.zip',
    },
    manifest: {
      github: 'https://raw.githubusercontent.com/papilot-lab/' + id + '/main/module.json',
      gitee: 'https://gitee.com/papilot-lab/' + id + '/raw/main/module.json',
    },
  };
  if (extra) for (const k of Object.keys(extra)) base[k] = extra[k];
  return base;
}

function catalogOf(mods) { return { schema: 1, updated: '2026-10-22T00:00:00Z', modules: mods }; }
function validCatalog() {
  return catalogOf([modEntry('papilot-mod-a', '1.2.0'), modEntry('papilot-mod-b', '0.5.0')]);
}

/* ================= ① 目录校验 ================= */

function testValidateCatalog() {
  const st = makeStore();
  const store = st.store;

  const good = store.validateCatalog(validCatalog());
  ok(good.ok && good.errors.length === 0, 'validateCatalog：合法目录通过', good.errors);

  const nonObj = store.validateCatalog(null);
  ok(!nonObj.ok && nonObj.errors.join(' ').indexOf('不是对象') >= 0,
    'validateCatalog：非对象被拒', nonObj.errors);

  const notArr = store.validateCatalog({ modules: {} });
  ok(!notArr.ok && notArr.errors.join(' ').indexOf('modules 不是数组') >= 0,
    'validateCatalog：modules 非数组被拒', notArr.errors);

  const badId = store.validateCatalog(catalogOf([modEntry('Bad_ID', '1.0.0')]));
  ok(!badId.ok && badId.errors.join(' ').indexOf('id 非法') >= 0,
    'validateCatalog：非法 id 被拒（大写/下划线）', badId.errors);

  const evilDl = store.validateCatalog(catalogOf([
    modEntry('papilot-mod-a', '1.2.0', { download: { github: 'https://evil.com/a.zip' } }),
  ]));
  ok(!evilDl.ok && evilDl.errors.join(' ').indexOf('下载源不在白名单') >= 0,
    'validateCatalog：https://evil.com 下载源被拒', evilDl.errors);

  const evilMf = store.validateCatalog(catalogOf([
    modEntry('papilot-mod-a', '1.2.0', { manifest: { gitee: 'http://gitee.com/x/module.json' } }),
  ]));
  ok(!evilMf.ok && evilMf.errors.join(' ').indexOf('清单源不在白名单') >= 0,
    'validateCatalog：非 https 清单源被拒（白名单要求 https）', evilMf.errors);

  const noVer = store.validateCatalog(catalogOf([{ id: 'papilot-mod-a', download: {} }]));
  ok(!noVer.ok && noVer.errors.join(' ').indexOf('缺 version') >= 0,
    'validateCatalog：缺 version 被拒', noVer.errors);

  const noId = store.validateCatalog(catalogOf([{ version: '1.0.0' }]));
  ok(!noId.ok && noId.errors.join(' ').indexOf('条目缺 id') >= 0,
    'validateCatalog：条目缺 id 被拒', noId.errors);
}

/* ================= ② 三级降级 ================= */

async function testFallback() {
  /* GitHub 失败 → Gitee 成功 */
  const cat = validCatalog();
  const urls = [];
  const st1 = makeStore({
    httpGet: async function (url) {
      urls.push(url);
      if (url.indexOf('raw.githubusercontent.com') >= 0) throw new Error('github 403');
      return cat;
    },
  });
  const r1 = await st1.store.fetchCatalog(false);
  eq(r1.ok, true, 'fallback：GitHub 失败后仍拿到目录');
  eq(r1.source, 'gitee', 'fallback：来源标记 gitee');
  eq(urls.length, 2, 'fallback：恰好尝试两个源');
  has(urls[0], 'raw.githubusercontent.com', 'fallback：第一源是 GitHub raw');
  has(urls[1], 'gitee.com', 'fallback：第二源是 Gitee 镜像');
  eq(r1.data.modules.length, 2, 'fallback：目录条目数正确');
  // 接缝守卫：窗口读的是 res.modules（不是 res.data.modules）。
  // 曾经只返回 {ok,data} 会让商店列表恒为空（同 0.48.4 技能商店事故形态）。
  eq(Array.isArray(r1.modules) ? r1.modules.length : -1, 2, 'fallback：顶层 modules 直读可用（窗口接缝）');
  eq(typeof r1.updated === 'string' && r1.updated.length > 10, true, 'fallback：顶层 updated 透出');
  eq(st1.store.getCatalogSource(), 'gitee', 'fallback：getCatalogSource=gitee');
  ok(st1.prefs.has('modulesCatalogCache'), 'fallback：成功目录写入缓存');

  /* 两源都失败 → 回落过期缓存 */
  const staleTs = 1750000000000 - 13 * 60 * 60 * 1000;
  const st2 = makeStore({
    httpGet: async function () { throw new Error('network down'); },
  });
  st2.prefs.set('modulesCatalogCache', JSON.stringify({ ts: staleTs, data: cat }));
  const r2 = await st2.store.fetchCatalog(false);
  eq(r2.ok, true, 'fallback：全失败时仍返回数据（过期缓存）');
  eq(r2.source, 'stale-cache', 'fallback：来源标记 stale-cache');
  eq(r2.data.modules.length, 2, 'fallback：过期缓存内容完整');
  has(r2.error, 'network down', 'fallback：保留最后一次错误原因');
  eq(st2.store.getCatalog().modules.length, 2, 'fallback：内存目录已填充');

  /* 全失败且无缓存 → ok:false + lastError */
  const st3 = makeStore({
    httpGet: async function () { throw new Error('dns failure'); },
  });
  const r3 = await st3.store.fetchCatalog(false);
  eq(r3.ok, false, 'fallback：无缓存时返回 ok=false');
  ok(!!r3.error, 'fallback：返回值带 error');
  ok(!!st3.store.getLastError(), 'fallback：getLastError 非空');
  has(st3.store.getLastError(), 'dns failure', 'fallback：lastError 保留根因');
}

/* ================= ③ 列表合并 ================= */

async function testListRows() {
  const loader = {
    API_VERSION: 1,
    _pure: { compareVersion: cmp },
    _ensureDeps: function () { return { baseDir: '/mem/papilot' }; },
    list: function () {
      return [
        { id: 'papilot-mod-a', version: '1.0.0', broken: false, previous: null },
        { id: 'papilot-mod-z', version: '0.1.0', broken: false,
          previous: { version: '0.0.9', dir: 'papilot-mod-z/0.0.9' } },
      ];
    },
    installFromZip: async function () { return { ok: false, error: 'unused' }; },
  };
  const cat = catalogOf([modEntry('papilot-mod-a', '1.2.0'), modEntry('papilot-mod-b', '0.5.0')]);
  const st = makeStore({ loader: loader, httpGet: async function () { return cat; } });
  await st.store.fetchCatalog(false);

  const rows = st.store.listRows();
  eq(rows.length, 3, 'listRows：目录 2 条 + 目录外已装 1 条 = 3 行');

  const rowA = rows.filter(function (r) { return r.id === 'papilot-mod-a'; })[0];
  eq(rowA.installed, true, 'listRows：a 标记已装');
  eq(rowA.installedVersion, '1.0.0', 'listRows：a installedVersion=1.0.0');
  eq(rowA.version, '1.2.0', 'listRows：a 目录版本=1.2.0');
  eq(rowA.updateAvailable, true, 'listRows：a 可更新（1.2.0 > 1.0.0）');
  eq(rowA.canRollback, false, 'listRows：a 无 previous 不可回滚');

  const rowB = rows.filter(function (r) { return r.id === 'papilot-mod-b'; })[0];
  eq(rowB.installed, false, 'listRows：b 未装');
  eq(rowB.installedVersion, null, 'listRows：b installedVersion=null');
  eq(rowB.updateAvailable, false, 'listRows：b 未装不提示更新');

  const rowZ = rows.filter(function (r) { return r.id === 'papilot-mod-z'; })[0];
  ok(!!rowZ, 'listRows：目录已下架的已装模块仍列出（否则没法卸载）');
  eq(rowZ.version, null, 'listRows：下架行没有目录版本');
  eq(rowZ.installedVersion, '0.1.0', 'listRows：下架行 installedVersion 保留');
  eq(rowZ.canRollback, true, 'listRows：下架行可回滚（有 previous）');
  has(rowZ.description, '下架', 'listRows：下架行给出说明文案');
  eq(rowZ.updateAvailable, false, 'listRows：下架行不提示更新');
}

/* ================= ④ Pro 门控 ================= */

function testPlanAllows() {
  const st = makeStore();
  const store = st.store;

  eq(store.planAllows(null).ok, true, 'planAllows：无条目放行');
  eq(store.planAllows({ id: 'papilot-mod-a' }).ok, true, 'planAllows：无 pro 字段放行');

  const noAcc = store.planAllows({ id: 'papilot-mod-a', pro: true });
  eq(noAcc.ok, false, 'planAllows：pro=true 且无账号时拒绝');
  has(noAcc.reason, '专业版', 'planAllows：拒绝原因提到专业版');

  st.sandbox.Zotero.Papilot.account = {
    isLoggedIn: function () { return false; },
    isPro: function () { return true; },
  };
  const loggedOut = store.planAllows({ id: 'papilot-mod-a', pro: true });
  eq(loggedOut.ok, false, 'planAllows：未登录时拒绝');
  has(loggedOut.reason, '登录', 'planAllows：拒绝原因提到登录');

  st.sandbox.Zotero.Papilot.account = {
    isLoggedIn: function () { return true; },
    isPro: function () { return false; },
  };
  const freeUser = store.planAllows({ id: 'papilot-mod-a', pro: true });
  eq(freeUser.ok, false, 'planAllows：免费用户装 pro 组件被拒');
  has(freeUser.reason, '仅限专业版', 'planAllows：拒绝原因说明仅限专业版');

  st.sandbox.Zotero.Papilot.account = {
    isLoggedIn: function () { return true; },
    isPro: function () { return true; },
  };
  eq(store.planAllows({ id: 'papilot-mod-a', pro: true }).ok, true, 'planAllows：Pro 用户放行');
}

/* ================= ⑤ 安装编排 ================= */

async function testInstallFlow() {
  const cat = catalogOf([modEntry('papilot-mod-a', '1.2.0')]);
  const manifest = {
    id: 'papilot-mod-a',
    version: '1.2.0',
    apiVersion: 1,
    mode: 'scope',
    files: [{ path: 'a.js', sha256: 'aa', size: 1 }],
    whatsNew: '修了三个 bug',
  };
  const events = [];
  let installCalls = 0;

  const loader = {
    API_VERSION: 1,
    _pure: {
      compareVersion: cmp,
      validateManifest: function () { return { ok: true, errors: [] }; },
    },
    _ensureDeps: function () { return { baseDir: '/mem/papilot' }; },
    list: function () { return []; },
    installFromZip: async function (zipPath, m, opts) {
      installCalls++;
      events.push('install');
      return { ok: true, id: m.id, version: m.version, action: 'install' };
    },
  };
  const httpGet = async function (url) {
    if (url.indexOf('index.json') >= 0) return cat;
    events.push('manifest');
    return manifest;
  };
  const httpGetBytes = async function (url) {
    events.push('zip');
    return new Uint8Array([80, 75, 3, 4]);
  };

  const st = makeStore({ loader: loader, httpGet: httpGet, httpGetBytes: httpGetBytes });
  const fr = await st.store.fetchCatalog(false);
  eq(fr.ok, true, 'install：目录先行加载');
  events.length = 0;

  const r = await st.store.install('papilot-mod-a');
  ok(r.ok, 'install：编排返回 ok', r);
  eq(installCalls, 1, 'install：loader.installFromZip 调用一次');
  eq(events.join(','), 'manifest,zip,install',
    'install：调用顺序 == 清单 → 包 → installFromZip');

  eq(st.io.writes.length, 1, 'install：临时 zip 落盘一次');
  has(st.io.writes[0][0], '/modules/.downloads/papilot-mod-a-1.2.0.zip',
    'install：zip 路径按 <id>-<version>.zip 命名');
  eq(st.io.writes[0][1].length, 4, 'install：写入的是下载到的字节');
  ok(st.io.removed.some(function (p) { return p.indexOf('.zip') >= 0; }),
    'install：安装后清理临时 zip');

  const wn = st.store.getWhatsNew();
  eq(wn.length, 1, 'install：whatsNew 记账 1 条');
  eq(wn[0].id, 'papilot-mod-a', 'install：whatsNew 记 id');
  eq(wn[0].version, '1.2.0', 'install：whatsNew 记版本');
  eq(wn[0].text, '修了三个 bug', 'install：whatsNew 记更新说明');
  eq(wn[0].at, new Date(st.state.now).toISOString(), 'install：whatsNew 时间来自 fake now');

  const stats = st.store.getStats();
  eq(stats['papilot-mod-a'].installs, 1, 'install：本地统计 installs+1');

  /* 清单 id 与目录不一致 → 拒绝且不下载包 */
  const cat2 = catalogOf([modEntry('papilot-mod-a', '1.2.0')]);
  const wrongManifest = {
    id: 'papilot-mod-b', version: '1.2.0', apiVersion: 1, mode: 'scope',
    files: [{ path: 'b.js', sha256: 'bb', size: 1 }],
  };
  const events2 = [];
  let installCalls2 = 0;
  const loader2 = {
    API_VERSION: 1,
    _pure: {
      compareVersion: cmp,
      validateManifest: function () { return { ok: true, errors: [] }; },
    },
    _ensureDeps: function () { return { baseDir: '/mem/papilot' }; },
    list: function () { return []; },
    installFromZip: async function () { installCalls2++; return { ok: true }; },
  };
  const st2 = makeStore({
    loader: loader2,
    httpGet: async function (url) {
      if (url.indexOf('index.json') >= 0) return cat2;
      events2.push('manifest');
      return wrongManifest;
    },
    httpGetBytes: async function () { events2.push('zip'); return new Uint8Array([1]); },
  });
  await st2.store.fetchCatalog(false);
  const r2 = await st2.store.install('papilot-mod-a');
  eq(r2.ok, false, 'install：清单 id 不一致时拒绝安装');
  has(r2.error, '清单下载失败', 'install：错误归类为清单下载失败');
  has(r2.error, '不一致', 'install：错误说明 id 不一致');
  eq(installCalls2, 0, 'install：id 不一致时未调用 installFromZip');
  eq(events2.indexOf('zip'), -1, 'install：id 不一致时不下载包');
}

/* ================= ⑥ 更新检查 / 工具 ================= */

async function testUpdatesAndTools() {
  const cat = catalogOf([modEntry('papilot-mod-a', '1.2.0'), modEntry('papilot-mod-b', '0.5.0')]);
  const loader = {
    API_VERSION: 1,
    _pure: { compareVersion: cmp },
    _ensureDeps: function () { return { baseDir: '/mem/papilot' }; },
    list: function () {
      return [
        { id: 'papilot-mod-a', version: '1.0.0' },
        { id: 'papilot-mod-b', version: '0.5.0' },
      ];
    },
    installFromZip: async function () { return { ok: true }; },
  };
  const st = makeStore({ loader: loader, httpGet: async function () { return cat; } });
  const r = await st.store.checkUpdates();
  eq(r.ok, true, 'checkUpdates：成功');
  eq(r.updates.length, 1, 'checkUpdates：只报真有更新的模块');
  eq(r.updates[0].id, 'papilot-mod-a', 'checkUpdates：命中的是 a');
  eq(r.updates[0].version, '1.2.0', 'checkUpdates：目标版本 1.2.0');
  eq(r.updates[0].installedVersion, '1.0.0', 'checkUpdates：当前版本 1.0.0');

  const st2 = makeStore();
  eq(st2.store.formatSize(512), '512 B', 'formatSize：<1KB 用 B');
  eq(st2.store.formatSize(2048), '2 KB', 'formatSize：KB 取整');
  eq(st2.store.formatSize(2 * 1024 * 1024), '2.0 MB', 'formatSize：MB 保留一位小数');
  eq(st2.store.formatSize(0), '0 B', 'formatSize：0 兜底');
}

/* ================= main ================= */

async function main() {
/* ================= ⑥ 完整性钉死与目录验签（0.74.1） ================= */

async function testZipSha256Pin() {
  const crypto = require('crypto');
  const goodBytes = Buffer.from('fake-zip-bytes');

  const mk = function (entryExtra, bytes, hashReturn) {
    const cat = catalogOf([modEntry('papilot-mod-a', '1.2.0', entryExtra)]);
    const manifest = {
      id: 'papilot-mod-a', version: '1.2.0', apiVersion: 1, mode: 'scope',
      files: [{ path: 'a.js', sha256: 'aa', size: 1 }],
    };
    let installCalls = 0;
    const loader = {
      API_VERSION: 1,
      _pure: { compareVersion: cmp, validateManifest: function () { return { ok: true, errors: [] }; } },
      _ensureDeps: function () {
        return { baseDir: '/mem/papilot', hashFile: async function () { return hashReturn; } };
      },
      list: function () { return []; },
      installFromZip: async function () { installCalls++; return { ok: true, id: 'papilot-mod-a', version: '1.2.0' }; },
    };
    const httpGet = async function (url) {
      return url.indexOf('index.json') >= 0 ? cat : manifest;
    };
    const httpGetBytes = async function () { return new Uint8Array(bytes); };
    return { st: makeStore({ loader: loader, httpGet: httpGet, httpGetBytes: httpGetBytes }),
             count: function () { return installCalls; } };
  };

  // 匹配 → 放行
  const good = mk({ zipSha256: 'deadbeef' }, goodBytes, 'deadbeef');
  await good.st.store.fetchCatalog(false);
  const r1 = await good.st.store.install('papilot-mod-a');
  ok(r1.ok, 'zipSha256：匹配放行', r1);
  eq(good.count(), 1, 'zipSha256：匹配时 installFromZip 被调用');

  // 不符 → 拒绝且不交给 loader
  const bad = mk({ zipSha256: 'deadbeef' }, goodBytes, 'cafef00d');
  await bad.st.store.fetchCatalog(false);
  const r2 = await bad.st.store.install('papilot-mod-a');
  ok(!r2.ok, 'zipSha256：不符被拒');
  has(r2.error, '完整性校验失败', 'zipSha256：错误文案');
  eq(bad.count(), 0, 'zipSha256：不符时 installFromZip 未被调用');
}

/* 验签：真实 Ed25519（Node webcrypto） */
async function testCatalogSignature() {
  const crypto = require('crypto');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const spkiB64 = Buffer.from(publicKey.export({ type: 'spki', format: 'der' })).toString('base64');

  // 与 scripts/sign-modules-index.js 的 payloadOf 同构
  function payloadOf(index) {
    const mods = (index.modules || []).slice()
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    let s = 'papilot-modules-v1\n' + String(index.hostMin || '') + '\n';
    for (const m of mods) {
      s += String(m.id) + '|' + String(m.version) + '|' + String(m.zipSha256 || '') + '\n';
    }
    s += String(mods.length) + '\n';
    return Buffer.from(s, 'utf8');
  }
  function sign(index) {
    const sig = crypto.sign(null, payloadOf(index), privateKey);
    return Object.assign({}, index, { signature: sig.toString('base64'), signatureAlgo: 'ed25519' });
  }

  const rawCat = catalogOf([modEntry('papilot-mod-a', '1.2.0', { zipSha256: 'aa' })]);
  rawCat.hostMin = '0.74.1';

  // 沙箱里注入带公钥的 fetch + 真实 webcrypto
  function mkWithKey(httpData) {
    const st = makeStore({
      httpGet: async function (url) {
        if (url.indexOf('index.json') >= 0) return httpData;
        throw new Error('offline');
      },
    });
    st.sandbox.fetch = async function (url) {
      if (String(url).indexOf('signing-pubkey.json') >= 0) {
        return { ok: true, json: async function () { return { key: spkiB64 }; } };
      }
      return { ok: false, json: async function () { return {}; } };
    };
    st.sandbox.Zotero = { Papilot: { rootURI: 'chrome://papilot/' } };
    st.sandbox.crypto = crypto.webcrypto;
    st.sandbox.TextEncoder = TextEncoder;
    st.sandbox.atob = atob;
    return st;
  }

  // 正确签名 → 通过
  const stA = mkWithKey(sign(rawCat));
  const rA = await stA.store.fetchCatalog(true);
  ok(rA.ok, '验签：正确签名放行', rA);

  // 篡改（换了 zipSha256 但签名是旧载荷的）→ 拒绝并降级
  const tampered = sign(rawCat);
  tampered.modules[0].zipSha256 = 'tampered';
  const stB = mkWithKey(tampered);
  const rB = await stB.store.fetchCatalog(true);
  ok(!rB.ok, '验签：篡改载荷被拒');

  // 有公钥但索引没签名 → 拒绝（防降级攻击）
  const stC = mkWithKey(rawCat);
  const rC = await stC.store.fetchCatalog(true);
  ok(!rC.ok, '验签：缺签名被拒');

  // crypto 不可用 → 降级接受 + 记诊断（不阻断老宿主）
  const stD = makeStore({
    httpGet: async function (url) {
      if (url.indexOf('index.json') >= 0) return sign(rawCat);
      throw new Error('offline');
    },
  });
  stD.sandbox.fetch = async function (url) {
    if (String(url).indexOf('signing-pubkey.json') >= 0) {
      return { ok: true, json: async function () { return { key: spkiB64 }; } };
    }
    return { ok: false, json: async function () { return {}; } };
  };
  stD.sandbox.Zotero = { Papilot: { rootURI: 'chrome://papilot/' } };
  // 不注入 crypto/TextEncoder → 触发降级
  const rD = await stD.store.fetchCatalog(true);
  ok(rD.ok, '验签：crypto 缺失降级接受');
  has(stD.diagMsgs.join('\n'), 'signature check degraded', '验签：降级有诊断');

  // 无公钥（0.74.0 过渡）→ 直接接受
  const stE = makeStore({
    httpGet: async function (url) {
      if (url.indexOf('index.json') >= 0) return rawCat;
      throw new Error('offline');
    },
  });
  stE.sandbox.fetch = async function () { return { ok: false, json: async function () { return {}; } }; };
  const rE = await stE.store.fetchCatalog(true);
  ok(rE.ok, '验签：无公钥过渡期接受');
}

  testValidateCatalog();
  await testFallback();
  await testListRows();
  testPlanAllows();
  await testInstallFlow();
  await testUpdatesAndTools();
  await testZipSha256Pin();
  await testCatalogSignature();

  if (fails.length) {
    console.log('');
    for (const f of fails) console.log('✗ ' + f);
    console.log('');
    console.log('module-store：' + pass + ' 通过，' + fails.length + ' 失败');
    process.exitCode = 1;
    return;
  }
  console.log('✓ ' + pass + ' assertions  (module-store)');
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
