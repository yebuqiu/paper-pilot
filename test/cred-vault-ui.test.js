#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 账号与密钥窗口 · 迷你 DOM 烟测（vault.js，0.66.0）
 *
 * 核心域测试能证明「mask() 返回掩码」，但证明不了**窗口有没有把明文塞进 DOM**。
 * 而这一类 bug 恰恰最致命：核心逻辑全绿，界面一打开就把所有 Key 平铺出来。
 *
 * 这里用迷你 DOM 真跑 vault.js，断言四条线：
 *   ① Pro + 锁定：main 的**全部文本**里不存在任何凭据值（包括 hint 与末位）
 *   ② Free / 未登录：不渲染任何条目值，只给锁定卡与升级入口
 *   ③ 解锁（无口令 → 二次确认）后明文出现；点「立即锁定」后明文完全消失
 *   ④ 有口令时：错误口令不放行，正确口令放行
 *
 * 运行：node test/cred-vault-ui.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const CORE = path.join(ROOT, 'chrome', 'content', 'scripts', 'features', 'cred-vault.js');
const UI = path.join(ROOT, 'chrome', 'content', 'vault.js');
const XHTML = path.join(ROOT, 'chrome', 'content', 'vault.xhtml');

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

/* ---------------- 迷你 DOM ---------------- */

class El {
  constructor(tag) {
    this.tag = String(tag);
    this.children = [];
    this.style = {};
    this._attrs = {};
    this.className = '';
    this.id = '';
    this.handlers = {};
    this.value = '';
    this.disabled = false;
    this._text = '';
    this.parentNode = null;
  }
  setAttribute(k, v) {
    if (k === 'class') this.className = String(v);
    else if (k === 'id') this.id = String(v);
    this._attrs[k] = String(v);
  }
  getAttribute(k) {
    if (k === 'class') return this.className;
    if (k === 'id') return this.id;
    return k in this._attrs ? this._attrs[k] : null;
  }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  get firstChild() { return this.children[0] || null; }
  addEventListener(e, f) { (this.handlers[e] = this.handlers[e] || []).push(f); }
  fire(e, a) { for (const f of (this.handlers[e] || []).slice()) f(a || {}); }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    this._text = String(v == null ? '' : v);
    this.children = [];
  }
  /** 收集子树里所有满足条件的节点（测试用查找按钮） */
  find(pred) {
    const out = [];
    const walk = (n) => {
      if (pred(n)) out.push(n);
      for (const c of n.children) walk(c);
    };
    walk(this);
    return out;
  }
}

const nodes = new Map();
const document = {
  readyState: 'complete',
  documentElement: null,
  getElementById(id) { return nodes.get(id) || null; },
  createElementNS(ns, tag) { return new El(tag); },
  createElement(tag) { return new El(tag); },
  addEventListener() {},
};

// 从真实 xhtml 里抽出所有静态 id，保证"脚本找不到节点"这类故障能被测出来
const xhtmlSrc = fs.readFileSync(XHTML, 'utf8');
for (const m of xhtmlSrc.matchAll(/id="([A-Za-z0-9_-]+)"/g)) nodes.set(m[1], new El('div'));
// 关键节点的语义标签（按钮/输入框）
nodes.get('v-unlock').tag = 'button';
nodes.get('v-refresh').tag = 'button';
nodes.get('v-search').tag = 'input';

/* ---------------- 沙箱装配 ---------------- */

function buildEnv(opts) {
  const o = opts || {};
  const store = Object.assign({}, o.prefs || {});
  const Prefs = {
    get(k, dflt) { const v = store[k]; return v === undefined || v === null ? dflt : v; },
    set(k, v) { store[k] = v; },
  };
  const cryptoWeb = require('crypto').webcrypto;
  const Zotero = {
    locale: 'zh-CN',
    getMainWindow: () => ({ crypto: cryptoWeb }),
    Prefs: { set: (k, v) => { store[k.replace('extensions.zotero.papilot.', '')] = v; } },
    debug() {},
    logError() {},
  };
  const Account = {
    isLoggedIn: () => o.loggedIn !== false,
    isPro: () => !!o.pro,
    membership: () => ({ plan: o.pro ? 'Pro' : 'Free', name: o.pro ? '专业版' : '免费版', expiresAt: 0 }),
    async hostedSecrets() { return {}; },
    async saveHostedSecret() { return {}; },
    async revealHostedSecret() { return ''; },
    async deleteHostedSecret() { return {}; },
    onSessionChanged() { return () => {}; },
  };
  const channelsDoc = o.channels || {
    active: 'c1',
    channels: [
      { id: 'official', name: '官方', provider: 'official', apiKey: '' },
      { id: 'c1', name: '我的通道', provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-UI-SECRET-9999' },
    ],
  };
  const Channels = {
    OFFICIAL_ID: 'official',
    _load: () => JSON.parse(JSON.stringify(channelsDoc)),
    _save: (doc) => { channelsDoc.channels = doc.channels; channelsDoc.active = doc.active; },
    _providerNoKey: (p) => p === 'ollama',
  };
  const sandbox = {
    console, btoa, atob, setTimeout, clearTimeout, crypto: cryptoWeb,
    Prefs, Zotero, Account, Channels,
    document, window: null,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(CORE, 'utf8'), sandbox, { filename: 'cred-vault.js' });
  const PP = {
    credVault: sandbox.CredVault,
    _prefsFocus: '',
    menus: { openSettings() { PP._settingsOpened = true; } },
    openVault() {},
  };
  Zotero.Papilot = PP;
  const win = {
    arguments: [{ Zotero, Services: { prompt: { confirm: () => true } } }],
    addEventListener() {},
    confirm: () => true,
    setTimeout,
  };
  sandbox.window = win;
  vm.runInContext(fs.readFileSync(UI, 'utf8'), sandbox, { filename: 'vault.js' });
  return { V: sandbox.CredVault, PP, store, channelsDoc, win };
}

const tick = () => new Promise((r) => setTimeout(r, 15));

function buttons(root, label) {
  return root.find((n) => n.tag === 'button' && n.textContent === label);
}

function mainText() {
  return nodes.get('v-main').textContent;
}

function resetDom() {
  for (const el of nodes.values()) { el.children = []; el._text = ''; el.handlers = {}; }
}

/* ================= ① Pro + 锁定 ================= */

(async () => {
  resetDom();
  const A = { secret: 'sk-UI-SECRET-9999', cnki: 'CNKI-PLAIN-PW-123', es: 'ES-SECRET-KEY-777' };
  const envA = buildEnv({
    pro: true,
    prefs: { cnkiUsername: 'alice@example.com', cnkiPassword: btoa(A.cnki), easyScholarKey: A.es,
      vaultHostedOnly: '["s2.key"]' },
  });
  await tick();

  const t1 = mainText();
  ok(t1.includes('账号与密钥') || t1.length > 0, 'L1 首次渲染有内容');
  ok(!t1.includes(A.secret), 'L2 锁定时不含 AI Key 明文');
  ok(!t1.includes(A.cnki), 'L3 锁定时不含知网密码明文');
  ok(!t1.includes(A.es), 'L4 锁定时不含分区 Key 明文');
  ok(!t1.includes('alice@example.com'), 'L5 锁定时连邮箱也不显示（非敏感项同样脱敏）');
  ok(t1.includes('••••••••'), 'L6 已配置项显示掩码');
  ok(t1.includes('仅托管'), 'L6b 仅托管项有明确状态文案（不是「尚未填写」）');
  eq(nodes.get('v-lock').textContent, '已锁定', 'L7 顶部徽标为已锁定');

  /* ================= ③ 解锁（无口令 → 二次确认） → 明文 → 立即锁定 ================= */

  const unlockBtn = nodes.get('v-unlock');
  unlockBtn.fire('click');
  await tick();
  const confirms = buttons(nodes.get('v-main'), '确认解锁');
  ok(confirms.length === 1, 'U1 无口令时出现二次确认按钮', confirms.length);
  ok(!mainText().includes(A.secret), 'U2 确认前仍无明文');

  confirms[0].fire('click');
  await tick();
  const t2 = mainText();
  ok(t2.includes(A.secret), 'U3 确认后显示 AI Key 明文');
  ok(t2.includes(A.es), 'U4 确认后显示分区 Key 明文');
  eq(nodes.get('v-lock').textContent, '已解锁', 'U5 徽标变为已解锁');

  unlockBtn.fire('click');   // 同一个按钮此时是「立即锁定」
  await tick();
  const t3 = mainText();
  ok(!t3.includes(A.secret) && !t3.includes(A.es), 'U6 锁定后明文从 DOM 彻底消失');
  eq(nodes.get('v-lock').textContent, '已锁定', 'U7 徽标回到已锁定');

  /* ================= ④ 有口令：错误不放行 / 正确放行 ================= */

  resetDom();
  const envP = buildEnv({ pro: true });
  envP.V.setPasscode('pass1234');
  // setPasscode 之后没有自动重渲染，直接重开窗口
  resetDom();
  const envP2 = buildEnv({ pro: true, prefs: envP.store });
  await tick();
  nodes.get('v-unlock').fire('click');
  await tick();
  const input = nodes.get('v-main').find((n) => n.tag === 'input')[0];
  ok(!!input, 'P1 有口令时出现口令输入框');
  const go = buttons(nodes.get('v-main'), '解锁')[0];
  ok(!!go, 'P2 出现解锁按钮');

  input.value = 'wrong';
  go.fire('click');
  await tick();
  ok(!mainText().includes('sk-UI-SECRET-9999'), 'P3 错误口令不放行');
  eq(nodes.get('v-lock').textContent, '已锁定', 'P4 错误口令后仍是锁定态');

  input.value = 'pass1234';
  go.fire('click');
  await tick();
  ok(mainText().includes('sk-UI-SECRET-9999'), 'P5 正确口令放行并显示明文');

  /* ================= ② Free / 未登录：锁定卡 ================= */

  resetDom();
  buildEnv({ pro: false, loggedIn: true });
  await tick();
  const tFree = mainText();
  ok(!tFree.includes('sk-UI-SECRET-9999'), 'G1 Free 不显示任何值');
  ok(tFree.includes('需要专业版'), 'G2 Free 显示升级提示', tFree.slice(0, 120));
  ok(buttons(nodes.get('v-main'), '升级专业版').length === 1, 'G3 Free 有升级按钮');
  ok(nodes.get('v-unlock').disabled === true, 'G4 Free 的解锁按钮禁用');

  resetDom();
  buildEnv({ pro: true, loggedIn: false });
  await tick();
  const tOut = mainText();
  ok(!tOut.includes('sk-UI-SECRET-9999'), 'G5 未登录不显示任何值');
  ok(tOut.includes('登录'), 'G6 未登录提示去登录', tOut.slice(0, 120));
  ok(buttons(nodes.get('v-main'), '去登录').length === 1, 'G7 未登录有登录按钮');

  if (fails.length) {
    console.error(`\n✗ 账号与密钥窗口烟测失败 ${fails.length} 项 / 通过 ${pass} 项`);
    for (const f of fails) console.error('  - ' + f);
    process.exit(1);
  }
  console.log(`✓ 账号与密钥窗口烟测全部通过（${pass} 项）`);
  process.exit(0);
})();
