#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 设置面板 · WPS 集成卡片（0.68.1）
 *
 * 为什么要有它：这张卡的价值全在「敢不敢信任它报的状态」——
 * 状态文案错了，用户就会以为链路通了（或者白折腾）。所以用迷你 DOM 把
 * prefs-wps.js 真跑一遍，桩掉 Zotero.Papilot.wpsBridge，断言：
 *   ① 全绿 / 缺加载项 / 缺代理 三种状态下，状态行与摘要说的是人话且不撒谎；
 *   ② 点「一键修复」真的调 bridge.fix()，成功/失败都写进 #pp-wps-msg（不静默）；
 *   ③ 勾选自动代理 / 保存脚本目录 写回同一个 pref；
 *   ④ ★ 脚本引用的每个元素 id 都必须在 prefs.xhtml 里存在（拼错 id = 静默失效）。
 *
 * 运行：node test/prefs-wps.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const XHTML = path.join(ROOT, 'chrome', 'content', 'prefs.xhtml');
const SCRIPT = path.join(ROOT, 'chrome', 'content', 'prefs-wps.js');

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function includes(hay, needle, label) {
  return ok(String(hay).indexOf(needle) >= 0, label, { want: needle, got: String(hay).slice(0, 160) });
}

/* ---------------- 迷你 DOM ---------------- */

class El {
  constructor(id) {
    this.id = id;
    this.textContent = '';
    this.value = '';
    this.checked = false;
    this.style = {};
    this.handlers = {};
    this.nodeType = 1;
  }
  addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); }
  dispatch(type, ev) {
    const list = this.handlers[type] || [];
    for (const fn of list) fn(ev || { target: this, preventDefault() {} });
  }
}

const IDS = [
  'pp-wps-dot', 'pp-wps-state', 'pp-wps-summary', 'pp-wps-addon', 'pp-wps-reg',
  'pp-wps-trust', 'pp-wps-proxy', 'pp-wps-zotero', 'pp-wps-detect', 'pp-wps-fix',
  'pp-wps-proxy-start', 'pp-wps-install-addon', 'pp-wps-open-addon', 'pp-wps-open-script', 'pp-wps-autoproxy',
  'pp-wps-scriptdir', 'pp-wps-savedir', 'pp-wps-msg',
];

function makeDom() {
  const nodes = {};
  for (const id of IDS) nodes[id] = new El(id);
  const document = {
    readyState: 'complete',
    activeElement: null,
    getElementById: (id) => nodes[id] || null,
    addEventListener() {},
    createElementNS() { return new El(''); },
  };
  return { nodes, document };
}

/** 跑一遍面板脚本；返回 {nodes, prefs, calls} */
function runPanel(status, opts = {}) {
  const { nodes, document } = makeDom();
  const prefs = Object.assign({ wpsAutoProxy: false, wpsScriptDir: '' }, opts.prefs || {});
  const calls = { fix: 0, startProxy: 0, openDir: [], set: [] };
  const bridge = {
    async status() { return status; },
    async fix() {
      calls.fix++;
      return opts.fixResult || { ok: true, report: ['已部署代理'] };
    },
    async startProxy() {
      calls.startProxy++;
      return opts.startResult || { started: true, already: false };
    },
    openDir(kind) { calls.openDir.push(kind); return true; },
    async installAddon() {
      calls.installAddon = (calls.installAddon || 0) + 1;
      return opts.installResult || { ok: true, version: '1.0.0', report: ['已安装加载项 1.0.0'] };
    },
  };
  const sandbox = {
    document,
    window: {},
    console,
    setTimeout: (fn, ms) => setTimeout(fn, ms || 0),
    Zotero: {
      Papilot: { wpsBridge: bridge },
      Prefs: {
        // 面板作用域走 Zotero.Prefs（full path + global=true），键必须带命名空间
        get: (k, g) => {
          const short = String(k).replace('extensions.zotero.papilot.', '');
          return short in prefs ? prefs[short] : undefined;
        },
        set: (k, v) => {
          const short = String(k).replace('extensions.zotero.papilot.', '');
          prefs[short] = v;
          calls.set.push([k, v]);
        },
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SCRIPT, 'utf8'), sandbox, { filename: 'prefs-wps.js' });
  return { nodes, prefs, calls, sandbox };
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms || 30));

const GREEN = {
  addon: { name: 'wps-zotero_1.0.0', version: '1.0.0', dir: 'C:/x' },
  addonStaticScripts: true,
  registered: true,
  registeredUrl: 'wps-zotero_1.0.0',
  registeredBroken: false,
  trusted: true,
  proxy: true,
  proxyUpstream: true,
  proxyFile: true,
  zotero: true,
  autoProxy: true,
  scriptDir: 'H:/project/paper-pilot',
};

(async function main() {
  /* ① 全绿 */
  {
    const { nodes } = runPanel(GREEN);
    await tick();
    includes(nodes['pp-wps-state'].textContent, '可用', '① 全绿 → 状态「可用」');
    includes(nodes['pp-wps-addon'].textContent, 'wps-zotero_1.0.0', '① 显示加载项目录名');
    includes(nodes['pp-wps-trust'].textContent, '已信任', '① 信任行说「已信任」');
    includes(nodes['pp-wps-proxy'].textContent, '运行中', '① 代理行说「运行中」');
    includes(nodes['pp-wps-zotero'].textContent, '23119', '① Zotero 行提到 23119');
    ok(nodes['pp-wps-autoproxy'].checked === true, '① 自动代理勾选状态回填');
    ok(nodes['pp-wps-scriptdir'].value === 'H:/project/paper-pilot', '① 脚本目录回填');
  }

  /* ② 缺加载项：不许说「可用」，修复给出可执行提示 */
  {
    const { nodes, calls } = runPanel({
      addon: null, registered: false, registeredBroken: false, trusted: false,
      proxy: false, proxyFile: false, zotero: true, autoProxy: false, scriptDir: '',
    }, {
      fixResult: { ok: false, report: [], error: '未检测到 WPS 加载项' },
    });
    await tick();
    includes(nodes['pp-wps-state'].textContent, '待处理', '② 缺加载项 → 状态「待处理」');
    includes(nodes['pp-wps-addon'].textContent, '未安装', '② 加载项行说「未安装」');
    includes(nodes['pp-wps-reg'].textContent, '未注册', '② 注册行说「未注册」');

    nodes['pp-wps-fix'].dispatch('click');
    await tick(60);
    ok(calls.fix === 1, '② 一键修复调用了 bridge.fix()');
    includes(nodes['pp-wps-msg'].textContent, '未检测到', '② 修复失败原因写进提示行（不静默）');
  }

  /* ③ 修复成功：报告落地 */
  {
    const { nodes, calls } = runPanel(GREEN, { fixResult: { ok: true, report: ['已部署代理', '已写入注册记录'] } });
    await tick();
    nodes['pp-wps-fix'].dispatch('click');
    await tick(60);
    ok(calls.fix === 1, '③ 修复按钮可用');
    includes(nodes['pp-wps-msg'].textContent, '修复完成', '③ 成功提示');
    includes(nodes['pp-wps-msg'].textContent, '已写入注册记录', '③ 修复步骤逐条展示');
  }

  /* ④ 注册异常（开发模式 URL / 目录不存在）必须显式报出来 */
  {
    const { nodes } = runPanel(Object.assign({}, GREEN, {
      registered: true, registeredBroken: true, registeredUrl: 'http://127.0.0.1:3889/',
    }));
    await tick();
    includes(nodes['pp-wps-reg'].textContent, '注册异常', '④ 开发模式 url 被判为注册异常');
    includes(nodes['pp-wps-state'].textContent, '待处理', '④ 有异常时状态不得显示「可用」');
  }

  /* ⑤ 勾选自动代理 / 保存脚本目录写回 pref */
  {
    const { nodes, prefs } = runPanel(GREEN);
    await tick();
    nodes['pp-wps-autoproxy'].checked = true;
    nodes['pp-wps-autoproxy'].dispatch('change', { target: { checked: true } });
    ok(prefs.wpsAutoProxy === true, '⑤ 勾选写回 wpsAutoProxy=true');

    nodes['pp-wps-scriptdir'].value = 'D:/repo/papilot';
    nodes['pp-wps-savedir'].dispatch('click');
    ok(prefs.wpsScriptDir === 'D:/repo/papilot', '⑤ 保存写回 wpsScriptDir');
  }

  /* ⑥ 启动代理按钮 */
  {
    const { nodes, calls } = runPanel(Object.assign({}, GREEN, { proxy: false }));
    await tick();
    nodes['pp-wps-proxy-start'].dispatch('click');
    await tick(60);
    ok(calls.startProxy === 1, '⑥ 启动代理调用 bridge.startProxy()');
    includes(nodes['pp-wps-msg'].textContent, '代理已启动', '⑥ 启动成功有回执');
  }

  /* ⑥b 下载并安装加载项 */
  {
    const { nodes, calls } = runPanel(Object.assign({}, GREEN, { addon: null }), {
      installResult: { ok: true, version: '1.0.0', report: ['已安装加载项 1.0.0 → C:/x'] },
    });
    await tick();
    nodes['pp-wps-install-addon'].dispatch('click');
    await tick(80);
    ok(calls.installAddon === 1, '⑥b 下载并安装调用 bridge.installAddon()');
    includes(nodes['pp-wps-msg'].textContent, '1.0.0', '⑥b 成功提示带版本号');
    includes(nodes['pp-wps-msg'].textContent, '重启 WPS', '⑥b 提示重启 WPS 并点信任');
  }

  /* ⑥c 安装失败要说清原因 */
  {
    const { nodes } = runPanel(GREEN, {
      installResult: { ok: false, error: '无法获取加载项', report: ['下载失败：gitee.com'] },
    });
    await tick();
    nodes['pp-wps-install-addon'].dispatch('click');
    await tick(80);
    includes(nodes['pp-wps-msg'].textContent, '无法获取加载项', '⑥c 失败原因展示');
    includes(nodes['pp-wps-msg'].textContent, 'gitee.com', '⑥c 同时展示每一步的尝试（不静默）');
  }

  /* ⑦ ★ 脚本里引用的每个 id 都必须在 prefs.xhtml 里存在 */
  {
    const xhtml = fs.readFileSync(XHTML, 'utf8');
    const src = fs.readFileSync(SCRIPT, 'utf8');
    const ids = new Set();
    // 三类引用都要抓：$("id") / setText("id", …) / bind("id", …)
    for (const re of [/\$\("(pp-[a-z-]+)"\)/g, /setText\("(pp-[a-z-]+)"/g, /bind\("(pp-[a-z-]+)"/g]) {
      let m;
      while ((m = re.exec(src))) ids.add(m[1]);
    }
    const missing = [...ids].filter((id) => xhtml.indexOf('id="' + id + '"') < 0);
    ok(missing.length === 0, '⑦ prefs-wps.js 引用的 id 都在 prefs.xhtml 里', missing);
    ok(ids.size >= 10, '⑦ 至少引用 10 个元素（防止脚本被改空）', ids.size);
  }

  /* ⑧ 卡片本身：折叠键、搜索串、说明到位 */
  {
    const xhtml = fs.readFileSync(XHTML, 'utf8');
    includes(xhtml, 'data-fold="wps"', '⑧ 卡片折叠键 data-fold="wps"');
    includes(xhtml, 'data-search-strings-raw="wps', '⑧ 卡片可被搜索命中');
    includes(xhtml, '界面与效率', '⑧ 归入「界面与效率」大类');
    includes(xhtml, '不随 Papilot 分发', '⑧ 卡片明确写了加载项不随包分发（许可边界）');
  }

  console.log('='.repeat(60));
  if (fails.length) {
    for (const f of fails) console.log('  !!  ' + f);
    console.log('='.repeat(60));
    console.log(`WPS 集成面板：${pass} 通过 / ${fails.length} 失败`);
    process.exit(1);
  }
  console.log(`WPS 集成面板：${pass} 项断言全部通过`);
})();
