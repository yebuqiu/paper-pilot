#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 模块运行时（module-loader）离线单测
 *
 * 覆盖三层：
 *   ① 纯函数：版本比较 / id 规则 / 清单校验 / 逐文件差异 / 装升同降 / 注册表读写；
 *   ② 生命周期：内存 fs + fake unzip/hashFile/scriptLoader 跑「装 → 升 → 回滚 → 卸」；
 *   ③ 失败面：校验失败整包丢弃（绝不半装）、降级拦截、坏清单标 broken。
 *
 * 纪律：不碰真实 IO / 网络 / 系统时间；所有外部依赖经 init({deps}) 注入，
 *      fake now 是唯一时间源，虚拟路径全部 POSIX 形态（与宿主平台无关）。
 * 运行：node test/module-loader.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'chrome', 'content', 'scripts', 'core', 'module-loader.js');
const LOADER_SRC = fs.readFileSync(SRC, 'utf8');

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
function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/* ---------------- 虚拟路径（POSIX 形态，宿主无关） ---------------- */

const P = {
  join: function () {
    const out = [];
    for (let i = 0; i < arguments.length; i++) {
      const part = arguments[i];
      for (const seg of String(part == null ? '' : part).split('/')) {
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
  toFileURI: function (p) { return 'file://' + p; },
};

/* ---------------- 内存文件系统桩 ---------------- */

function norm(p) {
  const s = String(p).replace(/\/+/g, '/').replace(/\/+$/, '');
  return s || '/';
}

function createMemFs() {
  const files = new Map(); // absPath -> { text, size }
  const dirs = new Set(['/']);

  function parentOf(p) {
    const i = p.lastIndexOf('/');
    return i <= 0 ? '/' : p.slice(0, i);
  }
  function addDir(p) {
    let cur = '';
    for (const seg of norm(p).split('/').slice(1)) {
      cur += '/' + seg;
      dirs.add(cur);
    }
  }
  function under(p, root) {
    return p === root || p.indexOf(root === '/' ? '/' : root + '/') === 0;
  }

  return {
    async exists(p) { p = norm(p); return files.has(p) || dirs.has(p); },
    async mkdirp(p) { addDir(p); },
    async readText(p) {
      p = norm(p);
      if (!files.has(p)) throw new Error('ENOENT: ' + p);
      return files.get(p).text;
    },
    async writeText(p, s) {
      p = norm(p);
      addDir(parentOf(p));
      files.set(p, { text: String(s), size: Buffer.byteLength(String(s)) });
    },
    async remove(p) {
      p = norm(p);
      for (const k of Array.from(files.keys())) if (under(k, p)) files.delete(k);
      for (const d of Array.from(dirs)) if (under(d, p)) dirs.delete(d);
    },
    async move(from, to) {
      from = norm(from); to = norm(to);
      addDir(parentOf(to));
      for (const entry of Array.from(files.entries())) {
        const k = entry[0];
        if (under(k, from)) {
          files.delete(k);
          files.set(to + k.slice(from.length), entry[1]);
        }
      }
      for (const d of Array.from(dirs)) {
        if (under(d, from)) {
          dirs.delete(d);
          addDir(to + d.slice(from.length));
        }
      }
    },
    async list(p) {
      p = norm(p);
      const prefix = p === '/' ? '/' : p + '/';
      const out = [];
      for (const d of dirs) {
        if (d !== p && d.indexOf(prefix) === 0 && d.slice(prefix.length).indexOf('/') < 0) out.push(d);
      }
      for (const k of files.keys()) {
        if (k.indexOf(prefix) === 0 && k.slice(prefix.length).indexOf('/') < 0) out.push(k);
      }
      return out;
    },
    async stat(p) {
      p = norm(p);
      if (files.has(p)) return { size: files.get(p).size, isDir: false };
      if (dirs.has(p)) return { size: 0, isDir: true };
      throw new Error('ENOENT: ' + p);
    },
    // 测试专用
    readRaw: function (p) { p = norm(p); return files.has(p) ? files.get(p).text : null; },
    allFiles: function () { return Array.from(files.keys()).sort(); },
    allDirs: function () { return Array.from(dirs).sort(); },
  };
}

/* ---------------- 沙箱装载 ---------------- */

function newLoader() {
  const sandbox = {
    console: { log: function () {}, error: function () {}, warn: function () {} },
    PathUtils: P,
    IOUtils: {},
    Cu: { nukeSandbox: function () {} },
    Zotero: { Papilot: { _diag: function () {} } },
  };
  vm.createContext(sandbox);
  vm.runInContext(LOADER_SRC, sandbox, { filename: 'core/module-loader.js' });
  return sandbox.ModuleLoader;
}

const ML = newLoader();

function makeEnv(opts) {
  const o = opts || {};
  const memfs = createMemFs();
  const state = { now: 1750000000000 };   // 固定时钟：2025-06-15 前后，与真实时间无关
  const diagMsgs = [];
  const scripts = [];
  const loader = newLoader();
  const deps = {
    baseDir: '/mem/papilot',
    fs: memfs,
    unzip: async function () { return { skipped: 0 }; },
    hashFile: async function () { return ''; },
    scriptLoader: { load: function (url) { scripts.push(url); } },
    makeSandbox: function () { return {}; },
    fileURI: P.toFileURI,
    diag: function (m) { diagMsgs.push(String(m)); },
    now: function () { return state.now; },
    hostVersion: '0.73.0',
  };
  Object.assign(deps, o.deps || {});
  return { loader: loader, memfs: memfs, deps: deps, diagMsgs: diagMsgs, scripts: scripts, state: state };
}

async function initEnv(env) {
  return env.loader.init({ baseDir: env.deps.baseDir, hostVersion: env.deps.hostVersion, deps: env.deps });
}

/** init 会把 deps 浅拷贝进 loader._deps，init 之后换桩必须两边一起换。 */
function setDeps(env, patch) {
  Object.assign(env.deps, patch);
  Object.assign(env.loader._deps, patch);
}

/* ---------------- 清单 / 包 / 解压桩 ---------------- */

function manifestOf(fileMap, opts) {
  const o = opts || {};
  const files = Object.keys(fileMap).map(function (p) {
    return { path: p, sha256: sha256(fileMap[p]), size: Buffer.byteLength(fileMap[p]) };
  });
  const m = {
    id: o.id || 'papilot-mod-demo',
    version: o.version || '1.0.0',
    apiVersion: o.apiVersion != null ? o.apiVersion : 1,
    minHost: o.minHost || '0.73.0',
    mode: o.mode || 'scope',
    files: files,
  };
  if (o.entry) m.entry = o.entry;
  if (o.whatsNew) m.whatsNew = o.whatsNew;
  return m;
}

function pkgOf(manifest, fileMap) {
  const pkg = { 'module.json': JSON.stringify(manifest) };
  for (const p of Object.keys(fileMap)) pkg[p] = fileMap[p];
  return pkg;
}

/** fake unzip：把 pkg 逐条写进 destDir，同时登记每个绝对路径的真实 sha256。 */
function unzipFrom(pkg, memfs, hashes) {
  return async function (zipPath, destDir) {
    for (const rel of Object.keys(pkg)) {
      const abs = P.join(destDir, rel);
      await memfs.writeText(abs, pkg[rel]);
      if (hashes) hashes.set(abs, sha256(pkg[rel]));
    }
    return { skipped: 0 };
  };
}

/* ================= ① 纯函数 ================= */

function testPure() {
  eq(ML.API_VERSION, 1, 'API_VERSION = 1');

  /* 版本比较矩阵 */
  const cmp = ML._pure.compareVersion;
  eq(cmp('0.10.0', '0.9.9'), 1, 'compareVersion：0.10.0 > 0.9.9（数字段不是字典序）');
  eq(cmp('0.9.9', '0.10.0'), -1, 'compareVersion：0.9.9 < 0.10.0（反向）');
  eq(cmp('1.0', '1.0.0'), 0, 'compareVersion：长度不等补 0（1.0 == 1.0.0）');
  eq(cmp('1.0.0.1', '1.0.0'), 1, 'compareVersion：多出的尾段参与比较');
  eq(cmp('1.2.3', '1.2.4'), -1, 'compareVersion：末段小者更小');
  eq(cmp('2', '10'), -1, 'compareVersion：个位段按数值比较');
  eq(cmp('1.0.0', '1.0.0'), 0, 'compareVersion：完全相等');
  eq(cmp('1.x.3', '1.0.3'), 0, 'compareVersion：非法段按 0 处理');
  eq(cmp('', '0'), 0, 'compareVersion：空串按 0');
  eq(cmp('3.0', '2.99.99'), 1, 'compareVersion：高位段优先');

  /* id 规则 */
  const vid = ML._pure.isValidId;
  ok(vid('ab'), 'isValidId：两位 id 合法（最短 2 字符）');
  ok(vid('papilot-mod-ai'), 'isValidId：常规模块 id 合法');
  ok(vid('a0-' + 'b'.repeat(60)), 'isValidId：64 字符内合法');
  ok(!vid('A-mod'), 'isValidId：大写拒绝');
  ok(!vid('a'), 'isValidId：单字符拒绝');
  ok(!vid('-ab'), 'isValidId：连字符开头拒绝');
  ok(!vid('a_b'), 'isValidId：下划线拒绝');
  ok(!vid('a/b'), 'isValidId：斜杠拒绝（目录穿越防线）');
  ok(!vid('a'.repeat(65)), 'isValidId：超 64 字符拒绝');
  ok(!vid(null), 'isValidId：非字符串拒绝');

  /* validateManifest 正例 */
  const baseFiles = [
    { path: 'main.js', sha256: 'a'.repeat(64), size: 3 },
    { path: 'lib/util.js', sha256: 'b'.repeat(64), size: 5 },
  ];
  const base = {
    id: 'papilot-mod-demo', version: '1.0.0', apiVersion: 1,
    minHost: '0.73.0', mode: 'scope', entry: 'main.js', files: baseFiles,
  };
  function clone() { return JSON.parse(JSON.stringify(base)); }
  let v = ML._pure.validateManifest(clone(), '0.73.0', 1);
  ok(v.ok && v.errors.length === 0, 'validateManifest：合法清单通过', v.errors);

  function bad(patch, needle, label) {
    const m = clone();
    for (const k of Object.keys(patch)) m[k] = patch[k];
    const r = ML._pure.validateManifest(m, '0.73.0', 1);
    ok(!r.ok && r.errors.join('; ').indexOf(needle) >= 0, label, r.errors);
  }

  bad({ id: 'Bad_ID' }, 'id 非法', 'validateManifest：id 含大写/下划线被拒');
  bad({ id: '../escape' }, 'id 非法', 'validateManifest：id 含 .. 被拒');
  bad({ version: '1.0.0-beta' }, 'version 非法', 'validateManifest：version 非纯数字点分被拒');
  bad({ version: '' }, 'version 非法', 'validateManifest：version 为空被拒');
  bad({ files: [] }, 'files 为空', 'validateManifest：files 空数组被拒');
  bad({ files: null }, 'files 为空', 'validateManifest：files 缺失被拒');
  bad({ files: [{ path: '/etc/passwd' }] }, '绝对路径', 'validateManifest：POSIX 绝对路径被拒');
  bad({ files: [{ path: 'C:/x.js' }] }, '绝对路径', 'validateManifest：盘符绝对路径被拒');
  bad({ files: [{ path: 'a/../../b.js' }] }, '路径穿越', 'validateManifest：.. 穿越被拒');
  bad({ files: [{ path: 'a\\b.js' }] }, '路径含反斜杠', 'validateManifest：反斜杠被拒');
  bad({ files: [{ path: 'main.js' }, { path: 'main.js' }] }, '路径重复', 'validateManifest：重复路径被拒');
  bad({ entry: 'nope.js' }, 'entry 不在 files', 'validateManifest：entry 不在 files 被拒');
  bad({ mode: 'sandbox', entry: '' }, 'sandbox 模式必须有 entry', 'validateManifest：sandbox 无 entry 被拒');
  bad({ apiVersion: 2 }, '高于宿主', 'validateManifest：apiVersion 高于宿主被拒');
  bad({ minHost: '9.9.9' }, '需要主包', 'validateManifest：minHost 高于宿主被拒');
  bad({ mode: 'weird' }, 'mode 非法', 'validateManifest：未知 mode 被拒');
  bad({ files: [{ path: 'x.js', size: -1 }] }, 'size 非法', 'validateManifest：负 size 被拒');

  const nonObj = ML._pure.validateManifest(null, '0.73.0', 1);
  ok(!nonObj.ok && nonObj.errors.join('; ').indexOf('manifest 不是对象') >= 0,
    'validateManifest：非对象入参被拒', nonObj.errors);

  /* diffFiles */
  const man = { files: [
    { path: 'a.js', sha256: 'aa', size: 10 },
    { path: 'b.js', sha256: 'bb', size: 20 },
    { path: 'c.js', sha256: 'cc', size: 30 },
  ] };
  eq(ML._pure.diffFiles(man, {
    'a.js': { sha256: 'aa', size: 10 },
    'b.js': { sha256: 'bb', size: 20 },
    'c.js': { sha256: 'cc', size: 30 },
  }).length, 0, 'diffFiles：全部一致返回空数组');

  const dMissing = ML._pure.diffFiles(man, {
    'a.js': { sha256: 'aa', size: 10 },
    'c.js': { sha256: 'cc', size: 30 },
  });
  eq(dMissing.length, 1, 'diffFiles：缺文件只报一条');
  eq(dMissing[0].reason, 'missing', 'diffFiles：缺文件 reason=missing');

  const dSize = ML._pure.diffFiles(man, {
    'a.js': { sha256: 'aa', size: 11 },
    'b.js': { sha256: 'bb', size: 20 },
    'c.js': { sha256: 'cc', size: 30 },
  });
  eq(dSize.length, 1, 'diffFiles：尺寸不符只报一条');
  eq(dSize[0].reason, 'size', 'diffFiles：尺寸不符 reason=size');

  const dHash = ML._pure.diffFiles(man, {
    'a.js': { sha256: 'ff', size: 10 },
    'b.js': { sha256: 'bb', size: 20 },
    'c.js': { sha256: 'cc', size: 30 },
  });
  eq(dHash.length, 1, 'diffFiles：摘要不符只报一条');
  eq(dHash[0].reason, 'sha256', 'diffFiles：摘要不符 reason=sha256');

  eq(ML._pure.diffFiles(man, {
    'a.js': { sha256: 'AA', size: 10 },
    'b.js': { sha256: 'BB', size: 20 },
    'c.js': { sha256: 'CC', size: 30 },
  }).length, 0, 'diffFiles：sha256 大小写不敏感');

  /* planInstall 四态 */
  eq(ML._pure.planInstall({ version: '1.0.0' }, null, false).action, 'install',
    'planInstall：未装 → install');
  eq(ML._pure.planInstall({ version: '1.0.0' }, { version: '1.0.0' }, false).action, 'same',
    'planInstall：同版 → same');
  eq(ML._pure.planInstall({ version: '1.1.0' }, { version: '1.0.0' }, false).action, 'upgrade',
    'planInstall：更高 → upgrade');
  eq(ML._pure.planInstall({ version: '0.9.0' }, { version: '1.0.0' }, false).action, 'blocked',
    'planInstall：更低默认 → blocked');
  eq(ML._pure.planInstall({ version: '0.9.0' }, { version: '1.0.0' }, true).action, 'downgrade',
    'planInstall：allowDowngrade → downgrade');

  /* parseRegistry 容错 */
  const empty = ML._pure.parseRegistry('{not json');
  ok(empty && empty.schema === 1 && Object.keys(empty.modules).length === 0,
    'parseRegistry：坏 JSON 回空表且不抛');
  ok(ML._pure.parseRegistry('').modules !== undefined, 'parseRegistry：空串回空表');
  ok(ML._pure.parseRegistry(null).schema === 1, 'parseRegistry：null 回空表');
  const parsed = ML._pure.parseRegistry(JSON.stringify({ modules: { a: { version: '1.0.0' } } }));
  eq(parsed.schema, 1, 'parseRegistry：缺 schema 时补 1');
  eq(parsed.modules.a.version, '1.0.0', 'parseRegistry：保留既有模块');

  /* withEntry 不可变 */
  const reg0 = { schema: 1, modules: { a: { version: '1.0.0' } } };
  const reg1 = ML._pure.withEntry(reg0, 'b', { version: '2.0.0' });
  ok(reg1 !== reg0, 'withEntry：返回新对象');
  eq(reg0.modules.b, undefined, 'withEntry：不改入参（b 未写入原对象）');
  eq(reg1.modules.b.version, '2.0.0', 'withEntry：新对象含新条目');
  eq(reg1.modules.a.version, '1.0.0', 'withEntry：既有条目被复制');
  const reg2 = ML._pure.withEntry(reg1, 'a', null);
  eq(reg2.modules.a, undefined, 'withEntry(entry=null)：删除条目');
  eq(reg1.modules.a.version, '1.0.0', 'withEntry(entry=null)：仍不改入参');

  /* toList 稳定排序 */
  const list = ML._pure.toList({ schema: 1, modules: {
    'papilot-mod-b': { version: '1.0.0' },
    'papilot-mod-a': { version: '2.0.0', enabled: false, broken: true, mode: 'sandbox' },
  } });
  eq(list.length, 2, 'toList：条目数正确');
  eq(list[0].id, 'papilot-mod-a', 'toList：按 id 升序（不依赖插入顺序）');
  eq(list[0].enabled, false, 'toList：enabled=false 透出');
  eq(list[0].broken, true, 'toList：broken 透出');
  eq(list[0].mode, 'sandbox', 'toList：mode 透出');
  eq(list[1].enabled, true, 'toList：默认 enabled=true');
  eq(list[1].mode, 'scope', 'toList：默认 mode=scope');
  eq(list[1].broken, false, 'toList：默认 broken=false');
}

/* ================= ② 生命周期 ================= */

const V1 = {
  'main.js': 'var Demo = { v: "1.0.0" };\n',
  'lib.js': 'function demoLib(){ return 1; }\n',
  'style.css': '.demo{color:red}\n',
};
const V2 = {
  'main.js': 'var Demo = { v: "1.1.0", extra: true };\n',
  'lib.js': 'function demoLib(){ return 2; }\n',
  'style.css': '.demo{color:blue}\n',
};

async function testLifecycle() {
  const env = makeEnv();
  const hashes = new Map();
  const m1 = manifestOf(V1, { version: '1.0.0', whatsNew: '首个版本' });
  const m2 = manifestOf(V2, { version: '1.1.0', whatsNew: '修了三个 bug' });
  env.deps.unzip = unzipFrom(pkgOf(m1, V1), env.memfs, hashes);
  env.deps.hashFile = async function (abs) { return hashes.get(abs); };

  const ir = await initEnv(env);
  eq(ir.loaded, 0, 'init：空注册表 loaded=0');
  eq(ir.skipped, 0, 'init：空注册表 skipped=0');

  /* 装 */
  const r1 = await env.loader.installFromZip('/tmp/demo-1.0.0.zip', m1, {});
  ok(r1.ok, 'install：首次安装成功', r1);
  eq(r1.action, 'install', 'install：action=install');
  eq(r1.version, '1.0.0', 'install：返回版本 1.0.0');
  eq(env.loader.isInstalled('papilot-mod-demo'), true, 'install：isInstalled=true');
  eq(env.loader.getVersion('papilot-mod-demo'), '1.0.0', 'install：getVersion=1.0.0');
  eq(env.loader.isActive('papilot-mod-demo'), true, 'install：热加载后 isActive=true');
  eq(env.loader.list().length, 1, 'install：list() 长度 1');

  const regPath = '/mem/papilot/modules/installed.json';
  const regRaw = env.memfs.readRaw(regPath);
  ok(!!regRaw, 'install：注册表已落盘');
  const reg = JSON.parse(regRaw);
  eq(reg.schema, 1, 'install：注册表 schema=1');
  eq(reg.modules['papilot-mod-demo'].version, '1.0.0', 'install：注册表记录版本');
  eq(reg.modules['papilot-mod-demo'].dir, 'papilot-mod-demo/1.0.0', 'install：注册表记录相对目录');
  eq(reg.modules['papilot-mod-demo'].mode, 'scope', 'install：注册表记录加载模式');
  eq(reg.modules['papilot-mod-demo'].enabled, true, 'install：默认 enabled');
  eq(reg.modules['papilot-mod-demo'].broken, false, 'install：默认 broken=false');
  eq(reg.modules['papilot-mod-demo'].whatsNew, '首个版本', 'install：whatsNew 落盘');
  ok(env.memfs.allFiles().every(function (p) { return p.indexOf('/.tmp-') < 0; }),
    'install：临时目录已清理（无 .tmp-* 残留）');
  // 0.73.0：scope 模式只加载 .js（style.css 这类资源不该被当脚本执行）
  eq(env.scripts.length, 2, 'install：scope 模式只加载 2 个 .js 文件（css 跳过）');
  has(env.scripts[0], '/papilot-mod-demo/1.0.0/main.js', 'install：加载 URI 指向版本目录');

  /* 同版本重装 → noop */
  const before = JSON.parse(env.memfs.readRaw(regPath));
  const r2 = await env.loader.installFromZip('/tmp/demo-1.0.0.zip', m1, {});
  eq(r2.ok, true, 'same：同版本重装返回 ok');
  eq(r2.noop, true, 'same：同版本重装标记 noop');
  eq(JSON.parse(env.memfs.readRaw(regPath)).modules['papilot-mod-demo'].updatedAt,
    before.modules['papilot-mod-demo'].updatedAt, 'same：noop 不重写注册表');

  /* 升级保留 previous */
  env.state.now += 60000;
  setDeps(env, { unzip: unzipFrom(pkgOf(m2, V2), env.memfs, hashes) });
  const r3 = await env.loader.installFromZip('/tmp/demo-1.1.0.zip', m2, {});
  ok(r3.ok, 'upgrade：升级成功', r3);
  eq(r3.action, 'upgrade', 'upgrade：action=upgrade');
  eq(env.loader.getVersion('papilot-mod-demo'), '1.1.0', 'upgrade：当前版本 1.1.0');
  const rowAfterUp = env.loader.list()[0];
  eq(rowAfterUp.previous && rowAfterUp.previous.version, '1.0.0', 'upgrade：previous 指向 1.0.0');
  eq(await env.memfs.exists('/mem/papilot/modules/papilot-mod-demo/1.0.0'), true,
    'upgrade：旧版本目录保留（供回滚）');
  eq(await env.memfs.exists('/mem/papilot/modules/papilot-mod-demo/1.1.0'), true,
    'upgrade：新版本目录存在');

  /* 回滚 */
  env.state.now += 60000;
  const r4 = await env.loader.rollback('papilot-mod-demo');
  ok(r4.ok, 'rollback：成功', r4);
  eq(r4.version, '1.0.0', 'rollback：回到 1.0.0');
  eq(env.loader.getVersion('papilot-mod-demo'), '1.0.0', 'rollback：getVersion=1.0.0');
  eq(env.loader.list()[0].previous.version, '1.1.0', 'rollback：previous 反向指向 1.1.0');
  const during = env.scripts.slice(-3);
  ok(during.some(function (u) { return u.indexOf('/papilot-mod-demo/1.0.0/main.js') >= 0; }),
    'rollback：重新加载的是旧版本入口', during);

  /* 卸载 */
  const r5 = await env.loader.uninstall('papilot-mod-demo');
  eq(r5.ok, true, 'uninstall：成功');
  eq(env.loader.isInstalled('papilot-mod-demo'), false, 'uninstall：isInstalled=false');
  eq(env.loader.getVersion('papilot-mod-demo'), null, 'uninstall：getVersion=null');
  eq(env.loader.list().length, 0, 'uninstall：list() 为空');
  eq(JSON.parse(env.memfs.readRaw(regPath)).modules['papilot-mod-demo'], undefined,
    'uninstall：注册表条目已删');
  eq(await env.memfs.exists('/mem/papilot/modules/papilot-mod-demo/1.0.0'), false,
    'uninstall：当前版本目录已删');

  const r6 = await env.loader.uninstall('papilot-mod-demo');
  eq(r6.ok, true, 'uninstall：重复卸载幂等');
  eq(r6.noop, true, 'uninstall：未装时标记 noop');

  /* 干净模块（无 previous）卸载 → 连 <id>/ 一起收掉 */
  const cleanFiles = { 'only.js': 'var Only = 1;\n' };
  const mc = manifestOf(cleanFiles, { id: 'papilot-mod-clean', version: '1.0.0' });
  setDeps(env, { unzip: unzipFrom(pkgOf(mc, cleanFiles), env.memfs, hashes) });
  const rc = await env.loader.installFromZip('/tmp/clean.zip', mc, {});
  eq(rc.ok, true, 'uninstall：干净模块安装成功');
  await env.loader.uninstall('papilot-mod-clean');
  eq(await env.memfs.exists('/mem/papilot/modules/papilot-mod-clean'), false,
    'uninstall：无 previous 时整个 <id>/ 目录被收掉');
}

/* ================= ③ 失败面：整包丢弃 ================= */

async function testNoHalfInstall() {
  const env = makeEnv();
  const hashes = new Map();
  const m = manifestOf(V1, { id: 'papilot-mod-bad', version: '1.0.0' });
  env.deps.unzip = unzipFrom(pkgOf(m, V1), env.memfs, hashes);
  // 第一个文件摘要被篡改 → 整包必须丢弃
  env.deps.hashFile = async function (abs) {
    return abs.indexOf('/main.js') >= 0 ? '0'.repeat(64) : hashes.get(abs);
  };

  await initEnv(env);
  const r = await env.loader.installFromZip('/tmp/bad.zip', m, {});
  eq(r.ok, false, '校验失败：安装返回 ok=false');
  has(r.error, '校验失败', '校验失败：错误信息含「校验失败」');
  eq(await env.memfs.exists('/mem/papilot/modules/installed.json'), false,
    '校验失败：注册表文件未创建（未半写）');
  eq(env.loader.list().length, 0, '校验失败：内存注册表仍为空');
  eq(await env.memfs.exists('/mem/papilot/modules/papilot-mod-bad/1.0.0'), false,
    '校验失败：目标版本目录不存在');
  ok(env.memfs.allFiles().every(function (p) { return p.indexOf('/papilot-mod-bad/') < 0; }),
    '校验失败：包内文件没有落到正式目录');
  ok(env.memfs.allDirs().every(function (p) { return p.indexOf('/.tmp-') < 0; }),
    '校验失败：临时目录已清理');
  eq(env.scripts.length, 0, '校验失败：不触发脚本加载');
}

/* ================= ④ 降级 ================= */

async function testDowngrade() {
  const env = makeEnv();
  const hashes = new Map();
  const a = { 'a.js': 'var A = "1.2.0";\n' };
  const b = { 'a.js': 'var A = "1.0.0";\n' };
  const m12 = manifestOf(a, { id: 'papilot-mod-down', version: '1.2.0' });
  const m10 = manifestOf(b, { id: 'papilot-mod-down', version: '1.0.0' });
  env.deps.unzip = unzipFrom(pkgOf(m12, a), env.memfs, hashes);
  env.deps.hashFile = async function (abs) { return hashes.get(abs); };

  await initEnv(env);
  eq((await env.loader.installFromZip('/tmp/a.zip', m12, {})).ok, true, '降级：先装 1.2.0');

  setDeps(env, { unzip: unzipFrom(pkgOf(m10, b), env.memfs, hashes) });
  const blocked = await env.loader.installFromZip('/tmp/b.zip', m10, {});
  eq(blocked.ok, false, '降级：默认被拦截');
  has(blocked.error, '拒绝降级', '降级：错误信息说明拒绝降级');
  eq(env.loader.getVersion('papilot-mod-down'), '1.2.0', '降级：版本保持 1.2.0');
  eq(await env.memfs.exists('/mem/papilot/modules/papilot-mod-down/1.0.0'), false,
    '降级：没有落盘 1.0.0');

  const forced = await env.loader.installFromZip('/tmp/b.zip', m10, { allowDowngrade: true });
  ok(forced.ok, '降级：allowDowngrade=true 放行', forced);
  eq(forced.action, 'downgrade', '降级：action=downgrade');
  eq(env.loader.getVersion('papilot-mod-down'), '1.0.0', '降级：版本变为 1.0.0');
}

/* ================= ⑤ scope 加载顺序 ================= */

async function testScopeOrder() {
  const env = makeEnv();
  const hashes = new Map();
  const order = ['z-last.js', 'a-first.js', 'm-mid.js'];
  const files = {};
  files['z-last.js'] = 'var Z = 1;\n';
  files['a-first.js'] = 'var A = 1;\n';
  files['m-mid.js'] = 'var M = 1;\n';
  const m = manifestOf(files, { id: 'papilot-mod-order', version: '1.0.0' });
  eq(m.files.map(function (f) { return f.path; }).join(','), order.join(','),
    'scope 顺序：清单 files 保持声明顺序（非字母序）');
  env.deps.unzip = unzipFrom(pkgOf(m, files), env.memfs, hashes);
  env.deps.hashFile = async function (abs) { return hashes.get(abs); };

  await initEnv(env);
  const r = await env.loader.installFromZip('/tmp/order.zip', m, { hot: false });
  eq(r.ok, true, 'scope 顺序：安装成功（hot=false）');
  eq(env.scripts.length, 0, 'scope 顺序：hot=false 时安装不加载');

  const lr = await env.loader.loadAll();
  eq(lr.loaded, 1, 'scope 顺序：loadAll 加载 1 个');
  eq(env.scripts.length, 3, 'scope 顺序：加载 3 个文件');
  const names = env.scripts.map(function (u) { return u.split('/').pop(); });
  eq(names.join(','), order.join(','), 'scope 顺序：loadSubScript 调用顺序 == files 声明顺序');
}

/* ================= ⑥ sandbox 模式 ================= */

async function testSandbox() {
  const events = [];
  const entryName = 'index.js';
  const files = { 'index.js': 'Papilot.Modules.register("papilot-mod-sbx", {});\n', 'helper.js': 'var H = 1;\n' };
  const m = manifestOf(files, { id: 'papilot-mod-sbx', version: '1.0.0', mode: 'sandbox', entry: entryName });

  const env = makeEnv({ deps: {
    makeSandbox: function (id) { events.push(['sandbox', id]); return {}; },
    scriptLoader: { load: function (url, scope) {
      events.push(['load', url, !!scope]);
      if (scope && url.slice(-(entryName.length + 1)) === '/' + entryName) {
        scope.Papilot.Modules.register('papilot-mod-sbx', {
          install: async function (ctx) { events.push(['install', !!ctx && ctx.rootURI]); },
          uninstall: async function () { events.push(['uninstall']); },
        });
      }
    } },
  } });
  const hashes = new Map();
  env.deps.unzip = unzipFrom(pkgOf(m, files), env.memfs, hashes);
  env.deps.hashFile = async function (abs) { return hashes.get(abs); };

  await initEnv(env);
  const r = await env.loader.installFromZip('/tmp/sbx.zip', m, {});
  ok(r.ok, 'sandbox：安装成功', r);
  eq(events.filter(function (e) { return e[0] === 'sandbox'; }).length, 1, 'sandbox：创建了一个沙箱');
  eq(events.filter(function (e) { return e[0] === 'install'; }).length, 1, 'sandbox：register 的 install 被调用');
  const instEv = events.filter(function (e) { return e[0] === 'install'; })[0];
  has(instEv[1], '/papilot-mod-sbx/1.0.0/', 'sandbox：install 收到 rootURI');
  eq(env.loader.isActive('papilot-mod-sbx'), true, 'sandbox：安装后 isActive=true');

  // 句柄覆盖缺陷已修（回归见 ⑧-A）：这里直接走公开 uninstall，验证卸载回调链路。
  events.length = 0;
  const rd = await env.loader.uninstall('papilot-mod-sbx');
  eq(rd.ok, true, 'sandbox：卸载成功');
  eq(events.filter(function (e) { return e[0] === 'uninstall'; }).length, 1,
    'sandbox：卸载时 uninstall 被调用');
  eq(env.loader.isActive('papilot-mod-sbx'), false, 'sandbox：卸载后 isActive=false');
  eq(env.loader.isInstalled('papilot-mod-sbx'), false, 'sandbox：卸载后 isInstalled=false');
}

/* ================= ⑦ 坏清单不加载、标 broken ================= */

async function testBroken() {
  const env = makeEnv();
  await initEnv(env);
  const id = 'papilot-mod-broken';
  // 模拟「已装但清单缺 entry」：磁盘上有 module.json，注册表里有条目
  await env.memfs.mkdirp('/mem/papilot/modules/' + id + '/1.0.0');
  await env.memfs.writeText('/mem/papilot/modules/installed.json', JSON.stringify({
    schema: 1,
    modules: { [id]: { version: '1.0.0', dir: id + '/1.0.0', mode: 'sandbox', enabled: true, broken: false } },
  }));
  await env.memfs.writeText('/mem/papilot/modules/' + id + '/1.0.0/module.json', JSON.stringify({
    id: id, version: '1.0.0', mode: 'sandbox',
    files: [{ path: 'index.js', sha256: 'aa', size: 1 }],
    // 缺 entry
  }));

  const res = await env.loader.init({ baseDir: env.deps.baseDir, hostVersion: '0.73.0', deps: env.deps });
  eq(res.loaded, 0, 'broken：坏清单不计入 loaded');
  eq(res.skipped, 1, 'broken：坏清单计入 skipped');
  eq(env.loader.isActive(id), false, 'broken：模块未激活');
  eq(env.loader.list()[0].broken, true, 'broken：注册表标记 broken=true');
  eq(env.scripts.length, 1, 'broken：只尝试加载入口（未注册即失败）');
  ok(env.diagMsgs.some(function (m) { return m.indexOf('未调用 Papilot.Modules.register') >= 0; }),
    'broken：诊断日志说明未注册', env.diagMsgs);
}

/* ================= ⑧ 回归：已修缺陷钉死 ================= */

/**
 * ⑧-A sandbox 句柄不被 loadModule 覆盖。
 * 修复前：_loadSandboxed 写入 {mode, sandbox, api} 后，loadModule 末尾又无条件赋
 * {mode, at}，句柄里的 sandbox/api 丢失 → unloadModule 既不会调模块 uninstall()，
 * 也不会 nukeSandbox（监听器泄漏）。此断言在修复前 sandbox 为 undefined、uninstall 计数 0。
 */
async function testSandboxHandleKept() {
  const events = [];
  const entryName = 'index.js';
  const id = 'papilot-mod-sbx-keep';
  const files = { 'index.js': 'var X = 1;\n', 'helper.js': 'var H = 1;\n' };
  const m = manifestOf(files, { id: id, version: '1.0.0', mode: 'sandbox', entry: entryName });

  const env = makeEnv({ deps: {
    makeSandbox: function () { return {}; },
    scriptLoader: { load: function (url, scope) {
      if (scope && url.slice(-(entryName.length + 1)) === '/' + entryName) {
        scope.Papilot.Modules.register(id, {
          install: async function () { events.push('install'); },
          uninstall: async function () { events.push('uninstall'); },
        });
      }
    } },
  } });
  const hashes = new Map();
  env.deps.unzip = unzipFrom(pkgOf(m, files), env.memfs, hashes);
  env.deps.hashFile = async function (abs) { return hashes.get(abs); };

  await initEnv(env);
  const r = await env.loader.installFromZip('/tmp/sbx-keep.zip', m, {});
  ok(r.ok, '回归 A：sandbox 模块安装成功', r);
  eq(env.loader.isActive(id), true, '回归 A：安装后 isActive=true');

  const handle = env.loader._loaded[id];
  // 修复前 handle 只有 {mode, at}，sandbox 为 undefined。
  ok(!!(handle && handle.sandbox), '回归 A：句柄保留 sandbox（修复前被 {mode,at} 覆盖）',
    handle && Object.keys(handle));
  ok(!!(handle && handle.api && typeof handle.api.uninstall === 'function'),
    '回归 A：句柄保留 register 返回的 api（uninstall 可调用）');
  eq(events.filter(function (e) { return e === 'install'; }).length, 1,
    '回归 A：install 回调恰好一次');

  const un = await env.loader.unloadModule(id);
  eq(un, true, '回归 A：unloadModule 返回 true');
  // 修复前这里恒为 0：句柄被覆盖后 h.api 不存在。
  eq(events.filter(function (e) { return e === 'uninstall'; }).length, 1,
    '回归 A：unloadModule 必须调用模块 uninstall() 恰好一次（修复前 0 次）');
  eq(env.loader.isActive(id), false, '回归 A：unloadModule 后 isActive=false');
}

/**
 * ⑧-B 卸载时当前版本 + previous 版本目录一起清。
 * 修复前：uninstall 只删 entry.dir（当前 1.1.0），1.0.0（previous）残留，
 * 导致 <id>/ 目录永远收不掉，磁盘上留下死代码。
 */
async function testUninstallCleansPrevious() {
  const env = makeEnv();
  const hashes = new Map();
  const id = 'papilot-mod-prune';
  const v1 = { 'a.js': 'var A = 1;\n' };
  const v2 = { 'a.js': 'var A = 2;\n' };
  const m1 = manifestOf(v1, { id: id, version: '1.0.0' });
  const m2 = manifestOf(v2, { id: id, version: '1.1.0' });
  env.deps.unzip = unzipFrom(pkgOf(m1, v1), env.memfs, hashes);
  env.deps.hashFile = async function (abs) { return hashes.get(abs); };

  await initEnv(env);
  ok((await env.loader.installFromZip('/tmp/prune-1.zip', m1, {})).ok,
    '回归 B：先装 1.0.0');
  env.state.now += 60000;
  setDeps(env, { unzip: unzipFrom(pkgOf(m2, v2), env.memfs, hashes) });
  const up = await env.loader.installFromZip('/tmp/prune-2.zip', m2, {});
  ok(up.ok, '回归 B：升级到 1.1.0 成功', up);
  eq(env.loader.getVersion(id), '1.1.0', '回归 B：当前版本 1.1.0');
  eq(env.loader.list()[0].previous.version, '1.0.0', '回归 B：previous 指向 1.0.0');
  eq(await env.memfs.exists('/mem/papilot/modules/' + id + '/1.0.0'), true,
    '回归 B：升级后保留上一版目录（回滚需要）');

  const un = await env.loader.uninstall(id);
  eq(un.ok, true, '回归 B：卸载成功');
  // 修复前 1.0.0 目录仍在 → <id>/ 也收不掉，此断言为 true 失败。
  eq(await env.memfs.exists('/mem/papilot/modules/' + id), false,
    '回归 B：卸载后整个 <id>/ 目录不存在（修复前 1.0.0 残留）');
  ok(env.memfs.allFiles().every(function (p) { return p.indexOf('/' + id + '/') < 0; }),
    '回归 B：该模块不再残留任何文件');
  eq(env.loader.isInstalled(id), false, '回归 B：注册表条目已删');
}

/**
 * ⑧-C 包内 module.json 的路径穿越必须整包拒绝。
 * 修复前：只校验包内 id/version，inner.files 的 "../../evil.txt" 会被拼成 tmp 之外的
 * 路径去 stat/hash（可读取任意文件）；包内清单绕过目录侧校验。
 */
async function testInnerManifestTraversal() {
  const env = makeEnv();
  const hashes = new Map();
  const keepFiles = { 'k.js': 'var K = 1;\n' };
  const keep = manifestOf(keepFiles, { id: 'papilot-mod-keep', version: '1.0.0' });
  env.deps.unzip = unzipFrom(pkgOf(keep, keepFiles), env.memfs, hashes);
  env.deps.hashFile = async function (abs) { return hashes.get(abs); };

  await initEnv(env);
  ok((await env.loader.installFromZip('/tmp/keep.zip', keep, {})).ok,
    '回归 C：先装一个正常模块作为基线');
  const regPath = '/mem/papilot/modules/installed.json';
  const regBefore = env.memfs.readRaw(regPath);

  const evilFiles = { 'main.js': 'var E = 1;\n' };
  const evil = manifestOf(evilFiles, { id: 'papilot-mod-evil', version: '1.0.0' });
  // 在 tmp 之外预置一个「真实存在」的文件：修复前包内清单会把 ../../evil.txt 拼到
  // /mem/papilot/evil.txt 去 stat/hash，只要摘要对得上就能装成功（读取 tmp 之外的内容）。
  const outsidePath = '/mem/papilot/evil.txt';
  const outsideText = 'TOPSECRET-OUTSIDE-TMP\n';
  await env.memfs.writeText(outsidePath, outsideText);
  hashes.set(outsidePath, sha256(outsideText));
  // 目录侧清单合法；恶意内容藏在包内 module.json 的 files 里。
  const inner = {
    id: evil.id, version: evil.version, apiVersion: 1, mode: 'scope',
    files: [{
      path: '../../evil.txt',
      sha256: sha256(outsideText),
      size: Buffer.byteLength(outsideText),
    }],
  };
  eq(await env.memfs.exists(outsidePath), true,
    '回归 C：陷阱文件在 tmp 之外真实存在（修复前会被读去校验）');
  setDeps(env, { unzip: async function (zipPath, destDir) {
    await env.memfs.writeText(P.join(destDir, 'module.json'), JSON.stringify(inner));
    await env.memfs.writeText(P.join(destDir, 'main.js'), evilFiles['main.js']);
    return { skipped: 0 };
  } });

  const r = await env.loader.installFromZip('/tmp/evil.zip', evil, {});
  eq(r.ok, false, '回归 C：包内清单穿越 → 安装失败');
  has(r.error, '包内清单非法', '回归 C：错误归类为包内清单非法');
  has(r.error, '路径穿越', '回归 C：错误明确指向路径穿越');
  eq(env.memfs.readRaw(regPath), regBefore, '回归 C：注册表原样未变');
  eq(env.loader.list().length, 1, '回归 C：只有基线模块留在注册表');
  eq(await env.memfs.exists('/mem/papilot/modules/papilot-mod-evil/1.0.0'), false,
    '回归 C：目标版本目录不存在');
  eq(await env.memfs.exists('/mem/papilot/modules/papilot-mod-evil'), false,
    '回归 C：<id>/ 目录不存在');
  ok(env.memfs.allDirs().every(function (p) { return p.indexOf('/.tmp-') < 0; }),
    '回归 C：.tmp-* 临时目录已清理');
  eq(env.memfs.readRaw(outsidePath), outsideText,
    '回归 C：tmp 之外的文件只被拒绝、未被搬动/覆盖');
}

/* ================= main ================= */

async function main() {
  testPure();
  await testLifecycle();
  await testNoHalfInstall();
  await testDowngrade();
  await testScopeOrder();
  await testSandbox();
  await testBroken();
  await testSandboxHandleKept();
  await testUninstallCleansPrevious();
  await testInnerManifestTraversal();

  if (fails.length) {
    console.log('');
    for (const f of fails) console.log('✗ ' + f);
    console.log('');
    console.log('module-loader：' + pass + ' 通过，' + fails.length + ' 失败');
    process.exitCode = 1;
    return;
  }
  console.log('✓ ' + pass + ' assertions  (module-loader)');
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
