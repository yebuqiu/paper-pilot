#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 设置面板 · WPS 集成卡片（0.71.1 起对接 Papilot Cite）
 *
 * 为什么要有它：这张卡的价值全在「敢不敢信任它报的状态」——
 * 状态文案错了，用户就会以为链路通了（或者白折腾一遍重装）。所以用迷你 DOM
 * 把 prefs-wps.js 真跑一遍，桩掉 Zotero.Papilot.wpsBridge，断言：
 *   ① 全绿 / 缺加载项 / 注册跑偏 / 有旧版残留 四种状态说的是人话且不撒谎；
 *   ② 按钮真的调到 bridge 的对应方法，成功失败都写进 #pp-wps-msg（不静默）；
 *   ③ 「清理旧版残留」必须经 confirm，用户点取消就什么都不做；
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
  return ok(String(hay).indexOf(needle) >= 0, label, { want: needle, got: String(hay).slice(0, 200) });
}

/* ---------------- 迷你 DOM ---------------- */

class El {
  constructor(id) {
    this.id = id;
    this.textContent = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.style = {};
    this.handlers = {};
    this.nodeType = 1;
  }
  addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); }
  dispatch(type, ev) {
    for (const fn of this.handlers[type] || []) fn(ev || { target: this, preventDefault() {} });
  }
}

const IDS = [
  'pp-wps-dot', 'pp-wps-state', 'pp-wps-summary', 'pp-wps-addon', 'pp-wps-reg',
  'pp-wps-trust', 'pp-wps-proxy', 'pp-wps-zotero', 'pp-wps-legacy', 'pp-wps-msg',
  'pp-wps-detect', 'pp-wps-install', 'pp-wps-proxy-start', 'pp-wps-clean', 'pp-wps-open-addon',
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

function baseStatus(over) {
  return Object.assign({
    addon: { name: 'papilot-cite_0.2.0', version: '0.2.0', path: 'C:/jsaddons/papilot-cite_0.2.0' },
    registered: true,
    registeredUrl: 'papilot-cite_0.2.0',
    registeredBroken: false,
    trusted: true,
    proxy: true,
    proxyFile: true,
    proxyUpstream: true,
    zotero: true,
    payload: { available: true, dir: 'C:/x', version: '0.2.0' },
    legacy: { dirs: [], publish: false },
  }, over || {});
}

/** 跑一遍面板脚本；返回 {nodes, calls, msg} */
async function runPanel(status, opts) {
  opts = opts || {};
  const { nodes, document } = makeDom();
  const calls = { status: 0, install: 0, startProxy: 0, clean: 0, openDir: [], confirm: 0 };
  const bridge = {
    async status() { calls.status++; return typeof status === 'function' ? status() : status; },
    async installAddon() {
      calls.install++;
      return opts.installResult || { ok: true, version: '0.2.0', report: ['写入 42 个文件', '已写注册项'] };
    },
    async startProxy() { calls.startProxy++; return opts.startResult || { started: true, already: false }; },
    async cleanupLegacy() { calls.clean++; return opts.cleanResult || { ok: true, removed: ['wps-zotero_1.0.1'] }; },
    openDir(kind) { calls.openDir.push(kind); return true; },
  };
  const sandbox = {
    document,
    console,
    setTimeout: (fn, ms) => setTimeout(fn, ms || 0),
    confirm: (text) => { calls.confirm++; calls.confirmText = String(text); return opts.confirm !== false; },
    Zotero: { Papilot: { wpsBridge: opts.noBridge ? null : bridge } },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SCRIPT, 'utf8'), sandbox, { filename: 'prefs-wps.js' });
  // 等 init 的第一次 status（脚本里还有一条 300ms 兜底 setTimeout）
  await new Promise((r) => setTimeout(r, 40));
  return { nodes, calls, msg: () => nodes['pp-wps-msg'].textContent };
}

(async () => {
  /* ---------- 状态渲染 ---------- */
  {
    const { nodes } = await runPanel(baseStatus());
    ok(nodes['pp-wps-state'].textContent === '可用', '全绿时状态是「可用」', nodes['pp-wps-state'].textContent);
    includes(nodes['pp-wps-summary'].textContent, '加载项已装', '摘要列出加载项已装');
    includes(nodes['pp-wps-addon'].textContent, 'papilot-cite_0.2.0', '加载项名称直接显示目录名');
    includes(nodes['pp-wps-legacy'].textContent, '没有旧版残留', '无残留时明确说没有');
    ok(nodes['pp-wps-clean'].disabled === true, '无残留时「清理」按钮禁用');
    ok(nodes['pp-wps-install'].disabled === false, '有载荷时「安装」按钮可用');
  }

  {
    // 未安装但有载荷：必须告诉用户可装哪个版本，而不是只说"未安装"
    const { nodes } = await runPanel(baseStatus({
      addon: null, registered: false, registeredUrl: '', trusted: false, proxy: false, proxyFile: false,
    }));
    includes(nodes['pp-wps-addon'].textContent, '可装 0.2.0', '未安装时提示可装版本');
    includes(nodes['pp-wps-reg'].textContent, '未注册', '未注册时说清楚');
    includes(nodes['pp-wps-install'].textContent, '安装加载项 0.2.0', '安装按钮带版本号');
    ok(nodes['pp-wps-state'].textContent === '待处理', '未装完时状态不是「可用」');
  }

  {
    // 注册跑偏（url 指向别的目录）：最容易让人白调半天的情况，必须点名
    const { nodes } = await runPanel(baseStatus({ registeredUrl: 'wps-zotero_1.0.1', registeredBroken: true }));
    includes(nodes['pp-wps-reg'].textContent, '注册指向别的目录', '注册跑偏时点名');
    includes(nodes['pp-wps-reg'].textContent, 'wps-zotero_1.0.1', '把跑偏的 url 显示出来');
    ok(nodes['pp-wps-state'].textContent === '待处理', '注册跑偏时不能报可用');
  }

  {
    // 旧版残留：本次清理的核心，必须显眼
    const { nodes } = await runPanel(baseStatus({
      legacy: { dirs: ['wps-zotero_1.0.1', 'wps-zotero'], publish: true },
    }));
    includes(nodes['pp-wps-legacy'].textContent, '发现旧版残留', '残留要显眼');
    includes(nodes['pp-wps-legacy'].textContent, '旧注册项', 'publish.xml 里的旧注册项也算残留');
    ok(nodes['pp-wps-clean'].disabled === false, '有残留时「清理」按钮可用');
    ok(nodes['pp-wps-state'].textContent !== '可用', '有残留时不能报可用');
  }

  {
    /* 端口三态：这张卡跑在 Zotero 里，所以"Zotero 没开"是不可能的结论。
     * 曾经因为进程内自连 23119 超时，直接报「无应答（Zotero 没开?）」把用户带偏。 */
    const t = await runPanel(baseStatus({ zotero: true }));
    includes(t.nodes['pp-wps-zotero'].textContent, '应答正常', '端口正常时说明正常');

    const no = await runPanel(baseStatus({ zotero: false }));
    includes(no.nodes['pp-wps-zotero'].textContent, '端口没在监听', '端口无应答时只说端口');
    ok(no.nodes['pp-wps-zotero'].textContent.indexOf('Zotero 没开') < 0,
      '★ 不许再说「Zotero 没开」（卡片能显示就说明 Zotero 在跑）');

    const unknown = await runPanel(baseStatus({ zotero: null, proxy: false, proxyFile: true }));
    includes(unknown.nodes['pp-wps-zotero'].textContent, '无法确认', '探测不了时给"无法确认"而不是假红');
  }

  /* ---------- 按钮行为 ---------- */
  {
    const p = await runPanel(baseStatus());
    p.nodes['pp-wps-install'].dispatch('click');
    await new Promise((r) => setTimeout(r, 40));
    ok(p.calls.install === 1, '点「安装」调到 bridge.installAddon');
    includes(p.msg(), '安装完成', '安装成功后提示里说安装完成');
    includes(p.msg(), '写入 42 个文件', '安装报告原样透出（用户能看到做了什么）');
  }

  {
    const p = await runPanel(baseStatus(), { installResult: { ok: false, error: '载荷缺失' } });
    p.nodes['pp-wps-install'].dispatch('click');
    await new Promise((r) => setTimeout(r, 40));
    includes(p.msg(), '载荷缺失', '安装失败要把原因显示出来（不静默）');
    ok(p.msg().indexOf('安装完成') < 0, '失败时不许说完成');
  }

  {
    const p = await runPanel(baseStatus({ legacy: { dirs: ['wps-zotero_1.0.1'], publish: false } }));
    p.nodes['pp-wps-clean'].dispatch('click');
    await new Promise((r) => setTimeout(r, 40));
    ok(p.calls.confirm === 1, '清理前必须确认一次');
    includes(p.calls.confirmText, 'wps-zotero', '确认文案说清要删什么');
    ok(p.calls.clean === 1, '确认后调到 bridge.cleanupLegacy');
    includes(p.msg(), '已清理', '清理结果要提示');
  }

  {
    const p = await runPanel(baseStatus({ legacy: { dirs: ['wps-zotero_1.0.1'], publish: false } }), { confirm: false });
    p.nodes['pp-wps-clean'].dispatch('click');
    await new Promise((r) => setTimeout(r, 40));
    ok(p.calls.clean === 0, '用户点「取消」时绝不能动别人的文件');
  }

  {
    const p = await runPanel(baseStatus({ proxy: false, proxyFile: true }), { startResult: { started: true, already: true } });
    p.nodes['pp-wps-proxy-start'].dispatch('click');
    await new Promise((r) => setTimeout(r, 40));
    ok(p.calls.startProxy === 1, '点「启动代理」调到 bridge.startProxy');
    includes(p.msg(), '已在运行', '代理本来就在跑时要说「已在运行」而不是「已启动」');
  }

  {
    const p = await runPanel(baseStatus());
    const before = p.calls.status;
    p.nodes['pp-wps-detect'].dispatch('click');
    await new Promise((r) => setTimeout(r, 40));
    ok(p.calls.status > before, '点「重新检测」会再问一次 bridge.status');
    includes(p.msg(), '已重新检测', '重新检测后给反馈');
  }

  {
    const p = await runPanel(baseStatus());
    p.nodes['pp-wps-open-addon'].dispatch('click');
    ok(p.calls.openDir.length === 1 && p.calls.openDir[0] === 'addon', '「打开加载项目录」传的是 addon');
  }

  {
    // 桥接模块没加载：不能抛，要给一句人话
    const p = await runPanel(baseStatus(), { noBridge: true });
    includes(p.nodes['pp-wps-state'].textContent, '桥接模块未加载', '没有 wpsBridge 时明确报出来');
  }

  /* ---------- 静态守卫 ---------- */
  {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    const xhtml = fs.readFileSync(XHTML, 'utf8');

    // ★ 脚本里用到的每个 id 都必须真实存在
    const used = new Set();
    for (const re of [/\$\("([^"]+)"\)/g, /setText\("([^"]+)"/g, /bind\("([^"]+)"/g]) {
      for (const m of src.matchAll(re)) used.add(m[1]);
    }
    const missing = [...used].filter((id) => xhtml.indexOf('id="' + id + '"') < 0);
    ok(missing.length === 0, '★ 脚本引用的 id 全部存在于 prefs.xhtml', missing.slice(0, 6));

    ok(!/(?<!Zotero\.)Prefs\.(get|set)\(/.test(src),
      '面板脚本不得使用裸 Prefs（设置窗口作用域没有它，用了会静默失效）');
    ok(src.indexOf('pp-wps-fix') < 0, '不再引用已删除的「一键修复」按钮');
    ok(src.indexOf('wpsAutoProxy') < 0 && src.indexOf('wpsScriptDir') < 0,
      '不再读写已删除的旧偏好（wpsAutoProxy / wpsScriptDir）');
    ok(xhtml.indexOf('id="pp-wps-legacy"') > 0, 'prefs.xhtml 里有「旧版残留」这一行');
  }

  /* ---------- 汇总 ---------- */
  if (fails.length) {
    console.log('\n失败 ' + fails.length + ' 项：');
    for (const f of fails) console.log('  ✗ ' + f);
    console.log('\n通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
    process.exit(1);
  }
  console.log('WPS 集成面板：' + pass + ' 项断言全部通过');
})();
