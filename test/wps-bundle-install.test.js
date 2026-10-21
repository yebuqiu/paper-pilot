#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* WPS 加载项「随包安装」桥接测试（0.71.1）
 *
 * 为什么要有它：这段代码要往用户的 WPS 目录里**写文件、改注册项、清信任记录**，
 * 是本功能里唯一有破坏性的部分。而且它跑在 xpi 里（jar:），载荷只能靠 fetch 读
 * 一个 bundle JSON —— 这两件事都不能只靠人眼。
 *
 * 用内存文件系统（IOUtils 全桩）跑真实现，断言：
 *   ① 正常路径：bundle 里每个文件都落到 jsaddons/papilot-cite_0.2.0/ 下；
 *   ② ★ 目录穿越：`../evil.js` / 绝对路径 / 盘符路径必须被丢弃，且不落盘；
 *   ③ 注册项格式与 wps-cite/tools/install.py 一致（customDomain=""）；
 *   ④ 清掉本插件的 authaddin 信任记录（否则 WPS 不重新确认）；
 *   ⑤ 代理随包落一份到 %APPDATA%/PapilotCite/proxy.py；
 *   ⑥ bundle 缺失 → ok:false 且不写任何文件。
 *
 * 运行：node test/wps-bundle-install.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const BRIDGE = path.join(ROOT, 'chrome', 'content', 'scripts', 'features', 'wps-bridge.js');

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}

const APPDATA = 'C:\\Users\\x\\AppData\\Roaming';
const ADDONS = APPDATA + '\\kingsoft\\wps\\jsaddons';

const BUNDLE = {
  version: '0.2.0',
  proxyVersion: '0.9.9',
  files: {
    'index.html': '<!DOCTYPE html><html></html>',
    'version.js': "var PPC_VERSION = '0.2.0';",
    'js/app.js': '// app',
    'img/cite.svg': '<svg/>',
    '../evil.js': 'boom',
    '/abs/evil.js': 'boom',
    'C:/evil.js': 'boom',
  },
  proxy: '# proxy\n',
};

function makeWorld(opts) {
  opts = opts || {};
  const files = Object.create(null);
  const removed = [];
  const calls = [];
  // 预置：旧的 authaddin（含本插件与别的插件各一条）
  files[ADDONS + '\\authaddin.json'] = JSON.stringify({
    comp1: {
      namelist: 'a;b',
      a: { name: 'papilot-cite', isload: 1 },
      b: { name: 'other-addon', isload: 1 },
    },
  });
  files[ADDONS + '\\publish.xml'] = '<jsplugins>\n</jsplugins>\n';

  const PathUtils = {
    join: (...xs) => xs.filter(Boolean).join('\\').replace(/\\+/g, '\\'),
    filename: (p) => String(p).split('\\').pop().split('/').pop(),
    parent: (p) => String(p).replace(/\\[^\\]+$/, ''),
  };

  const IOUtils = {
    async exists(p) { return p in files; },
    async read(p) { return files[p]; },
    async readUTF8(p) { return files[p]; },
    async write(p, data) { files[p] = typeof data === 'string' ? data : String(data); },
    async writeUTF8(p, s) { files[p] = s; },
    async makeDirectory() {},
    async remove(p) {
      removed.push(p);
      for (const k of Object.keys(files)) {
        if (k === p || k.startsWith(p + '\\') || k.startsWith(p + '/')) delete files[k];
      }
    },
    async stat(p) { return { type: p.endsWith('\\') ? 'directory' : 'regular' }; },
    async getChildren(p) {
      const out = [];
      const pref = p.endsWith('\\') ? p : p + '\\';
      for (const k of Object.keys(files)) {
        if (k.startsWith(pref) && k.indexOf('\\', pref.length) < 0) out.push(k);
      }
      return out;
    },
  };

  const sandbox = {
    console,
    PathUtils,
    IOUtils,
    Services: { dirsvc: { get: () => ({ path: APPDATA }) }, io: { newURI: () => { throw new Error('jar'); } } },
    Ci: { nsIFile: function () {}, nsIProcess: function () {}, nsIEnvironment: function () {} },
    Cc: { '@mozilla.org/process/util;1': { createInstance: () => ({
            init() {},
            runw(...a) { calls.push(a); if (opts.onRun) opts.onRun(a); },
          }) },
          '@mozilla.org/file/local;1': { createInstance: () => ({ initWithPath() {} }) },
          '@mozilla.org/process/environment;1': { getService: () => ({ get: () => '' }) } },
    fetch: async () => ({
      ok: true,
      text: async () => JSON.stringify(opts.bundle === null ? null : (opts.bundle || BUNDLE)),
    }),
    Zotero: { Promise: { delay: async () => {} },
              HTTP: { request: opts.http || (async () => { throw new Error('offline'); }) } },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(BRIDGE, 'utf8'), sandbox, { filename: 'wps-bridge.js' });
  const B = sandbox.WpsBridge;
  B.init({ rootURI: 'jar:file:///C:/x/papilot.xpi!/' });
  return { B, files, removed, calls };
}

(async () => {
  {
    const w = makeWorld();
    const r = await w.B.installAddon();
    console.log('DEBUG_KEYS', Object.keys(w.files), r.report);
    ok(r.ok === true, '正常路径返回 ok', r);
    const base = ADDONS + '\\papilot-cite_0.2.0\\';
    for (const rel of ['index.html', 'version.js', 'js/app.js', 'img/cite.svg']) {
      ok(base + rel.replace(/\//g, '\\') in w.files, '落盘 ' + rel);
    }
    ok(Object.keys(w.files).every((p) => p.indexOf('evil') < 0), '★ 目录穿越/绝对路径被丢弃', Object.keys(w.files).filter((p) => p.indexOf('evil') >= 0));
    ok(r.report.join(' ').indexOf('跳过非法路径 3 个') >= 0, '把丢弃的非法路径数报给用户', r.report);
  }

  {
    const w = makeWorld();
    await w.B.installAddon();
    const pub = w.files[ADDONS + '\\publish.xml'] || '';
    ok(/name="papilot-cite"/.test(pub), 'publish.xml 写了 papilot-cite');
    ok(/url="papilot-cite_0\.2\.0"/.test(pub), 'url 指向版本目录', pub.slice(0, 120));
    ok(/customDomain=""/.test(pub), '注册项格式与 install.py 一致（customDomain 空）');
  }

  {
    const w = makeWorld();
    await w.B.installAddon();
    const auth = JSON.parse(w.files[ADDONS + '\\authaddin.json']);
    const names = Object.values(auth.comp1).filter((v) => v && v.name).map((v) => v.name);
    ok(names.indexOf('papilot-cite') < 0, '★ 本插件的信任记录被清掉（WPS 会重新问）');
    ok(names.indexOf('other-addon') >= 0, '★ 别的插件的信任记录不许动');
  }

  {
    const w = makeWorld();
    await w.B.installAddon();
    ok(APPDATA + '\\PapilotCite\\proxy.py' in w.files, '代理随包落到 %APPDATA%/PapilotCite/proxy.py');
  }

  {
    // 载荷缺失：绝不能写半个加载项，也不能动注册项
    const w = makeWorld({ bundle: null });
    const r = await w.B.installAddon();
    ok(r.ok === false, 'bundle 缺失时返回 ok:false');
    ok(Object.keys(w.files).filter((p) => p.indexOf('papilot-cite_') >= 0).length === 0, 'bundle 缺失时一个文件都不写');
    ok(w.files[ADDONS + '\\publish.xml'] === '<jsplugins>\n</jsplugins>\n', 'bundle 缺失时不动注册项');
  }

  {
    // ★ 0.72.1 回归：版本一致 → 直接复用，不许动运行中的进程
    const w = makeWorld({
      http: async () => ({ status: 200, responseText: '{"ok":true,"proxyVersion":"0.9.9"}' }),
    });
    const r = await w.B.startProxy();
    ok(r.started === true && r.already === true, '代理版本一致时直接复用', r);
    ok(w.calls.length === 0, '版本一致时不起新进程、不杀旧进程', w.calls);
  }

  {
    // ★ 0.72.1 回归（0.72.0 外机实踩）：老代理不报 proxyVersion，必须停旧起新。
    //   Python 启动即把源码读进内存，覆盖 proxy.py 对运行中的实例完全无效。
    let alive = true;
    const stopArgs = [];
    const w = makeWorld({
      onRun: (a) => {
        const s = Array.isArray(a) ? a.join(' ') : String(a);
        if (s.indexOf('Stop-Process') >= 0) { stopArgs.push(s); alive = false; }
      },
      http: async () => {
        if (!alive) throw new Error('refused');
        return { status: 200, responseText: '{"ok":true}' };
      },
    });
    const r = await w.B.startProxy();
    ok(stopArgs.length === 1, '★ 旧代理（无版本字段）被 Stop-Process 停掉', stopArgs);
    ok(r.already !== true, '停掉后不再谎报「已在运行」', r);
  }

  {
    // 版本不符（运行 0.1.2 ≠ 载荷 0.9.9）同样要重启
    let alive = true;
    const stopArgs = [];
    const w = makeWorld({
      onRun: (a) => {
        const s = Array.isArray(a) ? a.join(' ') : String(a);
        if (s.indexOf('Stop-Process') >= 0) { stopArgs.push(s); alive = false; }
      },
      http: async () => {
        if (!alive) throw new Error('refused');
        return { status: 200, responseText: '{"ok":true,"proxyVersion":"0.1.2"}' };
      },
    });
    await w.B.startProxy();
    ok(stopArgs.length === 1, '版本不符时也重启代理', stopArgs);
  }

  if (fails.length) {
    console.log('\n失败 ' + fails.length + ' 项：');
    for (const f of fails) console.log('  ✗ ' + f);
    console.log('\n通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
    process.exit(1);
  }
  console.log('WPS 载荷安装桥：' + pass + ' 项断言全部通过');
})();
