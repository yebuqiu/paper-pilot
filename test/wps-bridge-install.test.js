#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* WPS 加载项「一键安装」桥接测试（0.68.2）
 *
 * 为什么要有它：这段代码要**从网络下载内容并落盘**，是本功能里唯一有破坏性的部分
 * （删目录、写文件、改 WPS 注册）。跑在真文件系统上（临时目录），桩掉 HTTP / XPCOM，
 * 断言：
 *   ① 正常路径：bundle → 文件逐个落盘（含子目录）→ 调 fix() 收尾 → 返回版本；
 *   ② ★ 目录穿越防护：bundle 里带 `../evil.js` / 绝对路径必须被丢弃；
 *   ③ 发布物缺必需文件 → 报错且**不落盘**（宁可失败，不留半个加载项）；
 *   ④ 下载失败 → 退回本地仓库目录（开发机场景），并在 report 里说清走了哪条；
 *   ⑤ 两条源都失败 → ok:false + 可执行提示（不静默）。
 *
 * 运行：node test/wps-bridge-install.test.js
 */
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'chrome', 'content', 'scripts', 'features', 'wps-bridge.js');

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function includes(hay, needle, label) {
  return ok(String(hay).indexOf(needle) >= 0, label, { want: needle, got: String(hay).slice(0, 200) });
}

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');

/** 造一个迷你加载项 bundle */
function makeBundle(extra = {}) {
  return Object.assign({
    name: 'papilot-wps-addon',
    version: '9.9.9',
    files: {
      'index.html': b64('<!DOCTYPE html><script src="js/ribbon.js"></script>'),
      'ribbon.xml': b64('<customUI/>'),
      'version.js': b64("const VERSION = '9.9.9'\n"),
      'js/ribbon.js': b64('// ribbon'),
      'js/zclient.js': b64('// zclient'),
      'js/tools.js': b64('// tools'),
      'js/wpsif.js': b64('// wpsif'),
      'images/default.svg': b64('<svg/>'),
    },
  }, extra);
}

/** 在给定 appdata 下装一个「沙箱版」WpsBridge */
async function makeBridge({ http, appData, prefs = {}, localDir }) {
  const sandbox = {
    console,
    atob,
    TextDecoder,
    Uint8Array,
    setTimeout,
    Services: {
      dirsvc: { get: () => ({ path: appData }) },
      io: {
        newURI: (u) => {
          const url = new URL(u);
          return { host: url.host, path: url.pathname };
        },
      },
    },
    PathUtils: {
      join: (...a) => path.join(...a),
      filename: (p) => path.basename(p),
      parent: (p) => path.dirname(p),
      tempDir: appData,
    },
    IOUtils: {
      exists: async (p) => fsp.access(p).then(() => true, () => false),
      readUTF8: async (p) => fsp.readFile(p, 'utf8'),
      writeUTF8: async (p, t) => fsp.writeFile(p, t, 'utf8'),
      write: async (p, data) => fsp.writeFile(p, Buffer.from(data)),
      makeDirectory: async (p) => fsp.mkdir(p, { recursive: true }),
      remove: async (p) => fsp.rm(p, { recursive: true, force: true }),
      getChildren: async (p) => (await fsp.readdir(p)).map((n) => path.join(p, n)),
      stat: async (p) => ({ type: (await fsp.stat(p)).isDirectory() ? 'directory' : 'regular' }),
      copy: async (a, b) => fsp.copyFile(a, b),
      move: async (a, b) => fsp.rename(a, b),
    },
    Cc: {},
    Ci: {},
    Prefs: {
      get: (k, d) => (k in prefs ? prefs[k] : d),
      set: (k, v) => { prefs[k] = v; },
    },
    Zotero: {
      HTTP: {
        request: async (method, url) => {
          const r = http[url];
          if (!r) throw new Error('offline');
          return { status: r.status, responseText: r.body };
        },
      },
      Papilot: {},
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: 'wps-bridge.js' });
  const B = sandbox.WpsBridge;
  B._rootURI = '';
  // fix() 会写 publish.xml 并拉进程，这里只验证"被调用"，实现本身有 doctor/真机覆盖
  B.fix = async () => ({ ok: true, report: ['已写入注册记录（stub）'] });
  if (localDir) prefs.wpsScriptDir = localDir;
  return { B, prefs };
}

(async function main() {
  const appData = await fsp.mkdtemp(path.join(os.tmpdir(), 'pp-wps-test-'));
  const jsaddons = path.join(appData, 'kingsoft', 'wps', 'jsaddons');
  await fsp.mkdir(jsaddons, { recursive: true });
  const url = 'https://example.com/papilot-wps-addon.bundle.json';

  /* ① 正常安装 */
  {
    const { B } = await makeBridge({
      appData,
      http: { [url]: { status: 200, body: JSON.stringify(makeBundle()) } },
    });
    B.ADDON_URLS = [url];
    const r = await B.installAddon();
    ok(r.ok, '① 安装成功返回 ok', r.error);
    ok(r.version === '9.9.9', '① 版本取自发布物', r.version);
    const dest = path.join(jsaddons, 'wps-zotero_9.9.9');
    const idx = await fsp.readFile(path.join(dest, 'index.html'), 'utf8');
    includes(idx, 'js/ribbon.js', '① index.html 已落盘');
    const nested = await fsp.readFile(path.join(dest, 'js', 'zclient.js'), 'utf8');
    includes(nested, 'zclient', '① 子目录文件已落盘');
    const svg = await fsp.readFile(path.join(dest, 'images', 'default.svg'), 'utf8');
    includes(svg, '<svg/>', '① 二进制/资源文件内容正确（base64 解码无误）');
    includes((r.report || []).join('|'), '已安装加载项 9.9.9', '① report 说明装到了哪');
  }

  /* ② 目录穿越必须被丢弃 */
  {
    const evil = makeBundle();
    evil.files['../evil.js'] = b64('pwn');
    evil.files['/abs/evil.js'] = b64('pwn');
    evil.files['C:/Windows/evil.js'] = b64('pwn');
    const { B } = await makeBridge({ appData, http: { [url]: { status: 200, body: JSON.stringify(evil) } } });
    B.ADDON_URLS = [url];
    const r = await B.installAddon();
    ok(r.ok, '② 正常文件仍安装成功');
    const outside = path.join(appData, 'evil.js');
    ok(!fs.existsSync(outside), '② ★ 目录穿越文件没有被写到 jsaddons 之外');
    const dest = path.join(jsaddons, 'wps-zotero_9.9.9');
    ok(!fs.existsSync(path.join(dest, '..', 'evil.js')), '② ★ 上层目录没有 evil.js');
  }

  /* ③ 缺文件 → 报错且不落盘 */
  {
    const bad = makeBundle();
    delete bad.files['js/wpsif.js'];
    const before = fs.existsSync(path.join(jsaddons, 'wps-zotero_9.9.9'));
    ok(before, '③ 前置：上一轮的目录还在（用来验证本轮不会动它）');
    const { B } = await makeBridge({ appData, http: { [url]: { status: 200, body: JSON.stringify(bad) } } });
    B.ADDON_URLS = [url];
    const r = await B.installAddon();
    ok(!r.ok, '③ 缺必需文件 → ok:false');
    includes((r.report || []).join('|'), '缺少文件', '③ 报错指出缺哪个文件');
  }

  /* ④ 下载失败 → 退本地目录 */
  {
    const repo = path.join(appData, 'fake-repo');
    const local = path.join(repo, 'tools', 'wps-zotero', 'addon');
    await fsp.mkdir(path.join(local, 'js'), { recursive: true });
    await fsp.writeFile(path.join(local, 'index.html'), '<script src="js/ribbon.js"></script>');
    await fsp.writeFile(path.join(local, 'version.js'), "const VERSION = '8.8.8'\n");
    for (const f of ['ribbon.js', 'zclient.js', 'tools.js', 'wpsif.js']) {
      await fsp.writeFile(path.join(local, 'js', f), '// ' + f);
    }
    await fsp.writeFile(path.join(local, 'ribbon.xml'), '<customUI/>');

    const { B } = await makeBridge({
      appData, http: {}, localDir: repo,
    });
    B.ADDON_URLS = [url];   // 该 url 无响应 → 抛错 → 回落本地
    const r = await B.installAddon();
    ok(r.ok, '④ 下载失败时回落本地源成功', r.error);
    ok(r.version === '8.8.8', '④ 版本来自本地 version.js', r.version);
    includes((r.report || []).join('|'), '本地源', '④ report 说明走了本地源');
    const dest = path.join(jsaddons, 'wps-zotero_8.8.8');
    ok(fs.existsSync(path.join(dest, 'js', 'wpsif.js')), '④ 本地目录递归复制完成');
  }

  /* ⑤ 两条源都失败 */
  {
    const { B } = await makeBridge({ appData, http: {} });
    B.ADDON_URLS = [url];
    const r = await B.installAddon();
    ok(!r.ok, '⑤ 无源可用 → ok:false');
    includes(String(r.error), '安装脚本目录', '⑤ 提示可改用本地安装（不静默）');
  }

  await fsp.rm(appData, { recursive: true, force: true });

  console.log('='.repeat(60));
  if (fails.length) {
    for (const f of fails) console.log('  !!  ' + f);
    console.log('='.repeat(60));
    console.log(`WPS 加载项安装桥：${pass} 通过 / ${fails.length} 失败`);
    process.exit(1);
  }
  console.log(`WPS 加载项安装桥：${pass} 项断言全部通过`);
})();
