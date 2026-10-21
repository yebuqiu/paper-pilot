#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 首次使用向导 · 落盘逻辑测试（B3.1）
 *
 * 为什么要有它：向导会**写 pref**，而且是在用户刚装好、最不该出事的时刻。
 * 真正的风险不是界面，而是这三类静默错误：
 *   ① 覆盖用户已有的非默认设置（比如他早就把翻译引擎设成 DeepL，向导又改回 Google）；
 *   ② 写了白名单以外的 pref（越权改动 AI 参数、密钥等）；
 *   ③ 「稍后再说」被当成「已完成」，之后再也不弹（或反过来反复弹）。
 * 所以这里只测**纯逻辑 applyOutcome(ctx)**：给定选择与当前 pref，产出哪些写入、哪些模块调用。
 *
 * 运行：node test/wizard.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const JS = path.join(ROOT, 'chrome', 'content', 'wizard.js');
const XHTML = path.join(ROOT, 'chrome', 'content', 'wizard.xhtml');

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

/* ---------------- 沙箱：只桩 Zotero.Prefs / 通道模块 / window ---------------- */
function load(prefs, opts) {
  opts = opts || {};
  const store = new Map(Object.entries(prefs || {}));
  const calls = [];
  const channels = opts.noChannels ? null : {
    setActive(id) { calls.push(['setActive', id]); return { ok: true }; },
    upsert(ch) { calls.push(['upsert', ch]); return { ok: true }; },
    getActiveConfig() { return { id: 'official', name: '官方通道', model: 'auto' }; },
  };
  const Zotero = {
    Prefs: {
      get: (k, v) => (store.has(k.replace(/^extensions\.zotero\.papilot\./, ''))
        ? store.get(k.replace(/^extensions\.zotero\.papilot\./, '')) : store.get(k)),
      set: (k, v) => { store.set(k.replace(/^extensions\.zotero\.papilot\./, ''), v); },
    },
    Papilot: { channels },
  };
  const window = {
    setTimeout: () => 0,
    addEventListener: () => {},
    close: () => {},
  };
  const document = {
    readyState: 'loading',
    addEventListener: () => {},
    getElementById: () => null,
    querySelector: () => null,
  };
  const sandbox = { Zotero, window, document, console, Date, JSON, Array, String, Number, Object, Math };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(JS, 'utf8'), sandbox, { filename: 'wizard.js' });
  const api = sandbox.window.PapilotWizard;
  return { api, store, calls };
}

/** 跑一次 applyOutcome，返回 {out, wrote:Set, notes} */
function run(prefs, ctx) {
  const { api, store, calls } = load(prefs, ctx);
  const wrote = [];
  const out = api.applyOutcome(Object.assign({
    setPref: (k, v) => { wrote.push(k); store.set(k, v); },
    getPref: (k) => store.get(k) || '',
    loggedIn: false,
    mode: 'done',
    channel: 'skip',
    translate: 'skip',
    custom: {},
  }, ctx, { channels: calls.length >= 0 ? (ctx.channels === undefined ? null : ctx.channels) : null }));
  return { api, store, calls, wrote, out };
}

/* ---------------- ① 生命周期：完成 / 跳过 ---------------- */
{
  const { api, store, wrote } = load({});
  const out = api.applyOutcome({
    mode: 'done', channel: 'skip', translate: 'skip', loggedIn: false,
    setPref: (k, v) => store.set(k, v), getPref: () => '',
  });
  eq(store.get('wizardDone'), 'done', '① 走完三步 → wizardDone=done');
  ok(/^\d{4}-\d{2}-\d{2}T/.test(String(store.get('wizardDoneAt'))), '① 同时记 ISO 时间戳', store.get('wizardDoneAt'));
  ok(out.wrote.indexOf('wizardDone') >= 0 && out.wrote.indexOf('wizardDoneAt') >= 0, '① 返回体里如实列出写入项');
}
{
  const { api, store } = load({});
  const out = api.applyOutcome({
    mode: 'skipped', channel: 'official', translate: 'free', loggedIn: true,
    setPref: (k, v) => store.set(k, v), getPref: () => '',
    channels: { setActive() { throw new Error('不应调用'); }, upsert() { throw new Error('不应调用'); } },
  });
  eq(store.get('wizardDone'), 'skipped', '① 「稍后再说」→ wizardDone=skipped（之后不再自动弹）');
  eq(store.get('wizardDoneAt'), undefined, '① 跳过不写时间戳');
  eq(store.get('translateCfg'), undefined, '① 跳过后不写任何配置');
  eq(out.calls.length, 0, '① 跳过后不调任何模块');
}

/* ---------------- ② 白名单：只写这三项 ---------------- */
{
  const { api, store } = load({});
  const out = api.applyOutcome({
    mode: 'done', channel: 'custom', translate: 'free', loggedIn: true,
    custom: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-test' },
    setPref: (k, v) => store.set(k, v), getPref: () => '',
    channels: { setActive() { return { ok: true }; }, upsert() { return { ok: true }; } },
  });
  const allow = api.WRITE_WHITELIST;
  const illegal = out.wrote.filter((k) => allow.indexOf(k) < 0);
  eq(JSON.stringify(illegal), '[]', '② ★ 写入项全部在白名单内（不越权改别的 pref）');
  ok(out.wrote.indexOf('wizardDone') >= 0, '② 白名单含 wizardDone');
}

/* ---------------- ③ 官方通道：登录才切 ---------------- */
{
  const calls = [];
  const { api, store } = load({});
  api.applyOutcome({
    mode: 'done', channel: 'official', translate: 'skip', loggedIn: true,
    setPref: (k, v) => store.set(k, v), getPref: () => '',
    channels: { setActive(id) { calls.push(id); return { ok: true }; }, upsert() { return { ok: true }; } },
  });
  eq(JSON.stringify(calls), JSON.stringify(['official']), '③ 已登录 + 官方通道 → setActive(official)');
}
{
  const calls = [];
  const { api, store } = load({});
  const out = api.applyOutcome({
    mode: 'done', channel: 'official', translate: 'skip', loggedIn: false,
    setPref: (k, v) => store.set(k, v), getPref: () => '',
    channels: { setActive(id) { calls.push(id); return { ok: true }; }, upsert() { return { ok: true }; } },
  });
  eq(calls.length, 0, '③ 未登录 → 不调用 setActive（模块本身也会拒）');
  ok(out.notes.join('').indexOf('未登录') >= 0, '③ 未登录时给出可读提示');
}

/* ---------------- ④ 自定义通道：固定 id，重复走不会堆通道 ---------------- */
{
  const ups = [];
  const { api, store } = load({});
  api.applyOutcome({
    mode: 'done', channel: 'custom', translate: 'skip', loggedIn: false,
    custom: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-test' },
    setPref: (k, v) => store.set(k, v), getPref: () => '',
    channels: { setActive() { return { ok: true }; }, upsert(c) { ups.push(c); return { ok: true }; } },
  });
  eq(ups.length, 1, '④ 自定义接口 → upsert 一次');
  eq(ups[0].id, 'wizard', '④ ★ 通道 id 固定 wizard（幂等：重跑是更新同一条）');
  eq(ups[0].baseUrl, 'https://api.deepseek.com/v1', '④ baseUrl 原样传入');
}

/* ---------------- ⑤ 翻译：不覆盖用户已有设置 ---------------- */
{
  const { api, store } = load({ translateCfg: JSON.stringify({ active: 'llm', timeoutMs: 20000, secrets: { x: 'y' } }) });
  api.applyOutcome({
    mode: 'done', channel: 'skip', translate: 'free', loggedIn: false,
    setPref: (k, v) => store.set(k, v), getPref: (k) => store.get(k) || '',
  });
  const doc = JSON.parse(store.get('translateCfg'));
  eq(doc.active, 'google', '⑤ 默认 llm + 选免费引擎 → active=google');
  eq(doc.timeoutMs, 20000, '⑤ 其它字段原样保留（timeoutMs）');
  eq(JSON.stringify(doc.secrets), JSON.stringify({ x: 'y' }), '⑤ 密钥块原样保留');
  ok(Array.isArray(doc.fallback) && doc.fallback.length > 0, '⑤ 回退链非空');
}
{
  const before = JSON.stringify({ active: 'deepl', secrets: { deepl: 'k' } });
  const { api, store } = load({ translateCfg: before });
  const out = api.applyOutcome({
    mode: 'done', channel: 'skip', translate: 'free', loggedIn: false,
    setPref: (k, v) => store.set(k, v), getPref: (k) => store.get(k) || '',
  });
  eq(store.get('translateCfg'), before, '⑤ ★ 用户已设 deepl → 一个字节都不改');
  ok(out.notes.length > 0, '⑤ 并且给出「保持原值」的说明');
}
{
  const before = JSON.stringify({ active: 'deepl' });
  const { api, store } = load({ translateCfg: before });
  api.applyOutcome({
    mode: 'done', channel: 'skip', translate: 'ai', loggedIn: false,
    setPref: (k, v) => store.set(k, v), getPref: (k) => store.get(k) || '',
  });
  eq(store.get('translateCfg'), before, '⑤ 选 AI 但用户已设 deepl → 也不改（不抢用户的选择）');
}

/* ---------------- ⑥ 异常：模块缺位 / 写失败都不崩 ---------------- */
{
  const { api, store } = load({});
  const out = api.applyOutcome({
    mode: 'done', channel: 'custom', translate: 'skip', loggedIn: false,
    custom: { baseUrl: 'https://x/v1' },
    setPref: (k, v) => store.set(k, v), getPref: () => '',
    channels: null,
  });
  ok(out.notes.join('').indexOf('模块未就绪') >= 0, '⑥ 通道模块缺位 → 记一条提示，不抛');
  eq(store.get('wizardDone'), 'done', '⑥ 模块缺位仍算完成（不卡用户）');
}
{
  const { api } = load({});
  const out = api.applyOutcome({
    mode: 'done', channel: 'skip', translate: 'skip', loggedIn: false,
    setPref: () => { throw new Error('磁盘只读'); }, getPref: () => '',
  });
  ok(out.failed.length > 0, '⑥ pref 写失败 → 记入 failed 而不是抛出去');
}
{
  // 通道模块自身抛错：不能把整份结果冲掉（否则完成页连「写了什么」都显示不出来）
  const { api, store } = load({});
  const out = api.applyOutcome({
    mode: 'done', channel: 'custom', translate: 'skip', loggedIn: true,
    custom: { baseUrl: 'https://x/v1', apiKey: 'k' },
    setPref: (k, v) => store.set(k, v), getPref: () => '',
    channels: { upsert() { throw new Error('配额满了'); }, setActive() { return { ok: true }; } },
  });
  eq(store.get('wizardDone'), 'done', '⑥ 通道抛错时 wizardDone 仍算完成（不卡用户）');
  ok(out.notes.join('').indexOf('配额满了') >= 0, '⑥ 通道异常的原始原因写进 notes');
}

/* ---------------- ⑦ 结构体检（纯文本） ---------------- */
{
  const x = fs.readFileSync(XHTML, 'utf8');
  ok(x.indexOf('windowtype="papilot:wizard"') >= 0, '⑦ 窗口 windowtype = papilot:wizard（B3.2 单例靠它）');
  ok(x.indexOf('chrome://papilot/content/wizard.js') >= 0, '⑦ 引入 wizard.js');
  ok(x.indexOf('wizard.css') >= 0, '⑦ 引入 wizard.css');
  ok(!/<\?xml/.test(x), '⑦ 不写 XML 声明（项目纪律：避免 parseXULToFragment 报错）');
  const bad = (x.match(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)[a-zA-Z][a-zA-Z0-9]*;/g) || []);
  eq(JSON.stringify(bad), '[]', '⑦ 无未定义命名实体（面板/窗口空白的高发原因）');
  // 只允许 kit 类与窗口私有 wz- 类；不允许出现内联颜色
  const classes = Array.from(new Set((x.match(/class="([^"]+)"/g) || [])
    .map((s) => s.replace(/class="|"/g, ''))
    .reduce((a, s) => a.concat(s.split(/\s+/)), [])
    .filter(Boolean)));
  const alien = classes.filter((c) => !/^(pp-|wz-)/.test(c));
  eq(JSON.stringify(alien), '[]', '⑦ 类名只用 pp-*（ui-kit）与 wz-*（窗口私有）', alien);
  const inlineColors = (x.match(/style="[^"]*(color|background)\s*:[^"]*"/g) || []);
  eq(JSON.stringify(inlineColors), '[]', '⑦ 不写内联颜色（暗色/主题下才不会白块）');
}

/* ---------------- ⑧ 真机窗口作用域：Zotero 只能从 window.arguments 来 ---------------- */
/*
 * 0.68.3 排障背景：向导窗口在真机里「点什么都没反应」，同时每次启动都弹。
 * 根因是 wizard.js 裸用 `Zotero` 全局 —— openDialog 打开的 chrome 窗口里没有这个全局
 * （skill-store / chat-window / vault 都靠 window.arguments[0] 注入）。后果是双向的：
 *   · pref 读写全失败 → wizardDone 永远为空 → 每次启动都弹（已登录用户也照弹）
 *   · account / channels 模块拿不到 → 登录回「账号模块未就绪」
 * 纯逻辑测试（上面的 ①~⑦）永远发现不了这类问题，因为它们在沙箱里塞了一个 Zotero 全局。
 * 所以这里刻意**不塞 Zotero 全局**，只按真机形态给 window.arguments[0]。
 */

class El {
  constructor(tag) {
    this.tag = tag; this.children = []; this.parentNode = null;
    this.style = {}; this._attrs = {}; this.id = '';
    this.className = ''; this._text = ''; this.value = '';
    this.handlers = {}; this.disabled = false;
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
    return c;
  }
  get firstChild() { return this.children[0] || null; }
  addEventListener(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
  fire(ev, arg) {
    const e = Object.assign({ preventDefault() {}, stopPropagation() {} }, arg || {});
    for (const f of (this.handlers[ev] || []).slice()) f(e);
  }
  click() { this.fire('click'); }
  focus() {}
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const m = /^\.([\w-]+)\[data-seg="(\d)"\]$/.exec(String(sel));
    if (!m) return [];
    const out = [];
    this._walk((n) => {
      if (String(n.className || '').split(/\s+/).indexOf(m[1]) >= 0 && n._attrs['data-seg'] === m[2]) out.push(n);
    });
    return out;
  }
  _walk(fn) { for (const c of this.children) { fn(c); c._walk(fn); } }
  set textContent(v) { this._text = v == null ? '' : String(v); }
  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join('');
    return this._text;
  }
}

const WZ_IDS = ['pp-wz-root', 'pp-wz-step-1', 'pp-wz-step-2', 'pp-wz-step-3', 'pp-wz-step-done',
  'pp-wz-stepnum', 'pp-wz-back', 'pp-wz-next', 'pp-wz-close', 'pp-wz-skip', 'pp-wz-settings',
  'pp-wz-ch-official', 'pp-wz-ch-custom', 'pp-wz-ch-form', 'pp-wz-tr-ai', 'pp-wz-tr-free',
  'pp-wz-acc-on', 'pp-wz-acc-off', 'pp-wz-acc-email', 'pp-wz-acc-tier', 'pp-wz-acc-msg',
  'pp-wz-login-view', 'pp-wz-reg-view', 'pp-wz-reg-link', 'pp-wz-back-login',
  'pp-wz-reg', 'pp-wz-reg-email', 'pp-wz-reg-nickname', 'pp-wz-reg-password', 'pp-wz-reg-password2', 'pp-wz-reg-msg',
  'pp-wz-email', 'pp-wz-password', 'pp-wz-login', 'pp-wz-login-msg',
  'pp-wz-baseurl', 'pp-wz-apikey', 'pp-wz-ch-test', 'pp-wz-ch-msg',
  'pp-wz-ch-state', 'pp-wz-tr-state', 'pp-wz-summary', 'pp-wz-done-msg', 'pp-wz-tr-msg'];

/**
 * 按**真机形态**装载向导窗口。
 * opts.scope=false → 连 window.arguments 都不给（模拟最坏情况：窗口参数丢失）
 * opts.register = 'ok' | 'verify' | 'fail' | 'nogate'（注册后行为）
 */
function loadWindow(opts) {
  opts = opts || {};
  const root = new El('window');
  const byId = new Map();
  for (const id of WZ_IDS) {
    const n = new El('div');
    n.id = id;
    n.setAttribute('id', id);
    root.appendChild(n);
    byId.set(id, n);
  }
  for (let i = 1; i <= 3; i++) {
    const seg = new El('div');
    seg.className = 'wz-bar-seg';
    seg.setAttribute('data-seg', String(i));
    root.appendChild(seg);
  }

  const listeners = {};      // window 级监听（DOMContentLoaded / unload / keydown / error）
  const timers = [];
  const store = new Map();
  const calls = [];
  const failKeys = opts.failWrites || [];

  const Account = {
    isLoggedIn() { return !!opts.loggedIn; },
    // 服务端档位就是 'Pro' / 'Free'（大写）：桩必须照实，否则测不出口径 bug
    isPro() { return !!opts.pro; },
    user() { return opts.loggedIn ? { email: 'me@example.com', plan: opts.pro ? 'Pro' : 'Free' } : null; },
    async login(email, password) {
      calls.push(['login', email, password]);
      if (opts.register === 'verify') throw new Error('账号未激活');
      opts.loggedIn = true;
      return { ok: true };
    },
    async register(email, password, nickname) {
      calls.push(['register', email, password, nickname]);
      if (opts.register === 'fail') throw new Error('邮箱已被注册');
      if (opts.register === 'verify') return { user: { email, status: 'pending' }, notice: '验证邮件已发送', needVerify: true };
      return { user: { email, status: 'active' }, notice: '注册成功', needVerify: false };
    },
  };
  const Channels = {
    setActive(id) { calls.push(['setActive', id]); return { ok: true }; },
    upsert(ch) { calls.push(['upsert', ch.id]); return { ok: true }; },
    // 真机语义：没配过 / 未登录 → ok:false；只有当前通道真的可用才 ok:true
    getActiveConfig() {
      return opts.channelOk
        ? { ok: true, channelId: 'my-api', model: 'auto' }
        : { ok: false, reason: 'no_active' };
    },
    getChannel(id) {
      return { id, name: id === 'official' ? '官方通道' : '我的接口', baseUrl: 'https://api.example.com/v1' };
    },
    async detectChannel() { return { ok: true, models: ['a', 'b'] }; },
  };
  const Zotero = {
    Prefs: {
      get(k) { return store.has(k) ? store.get(k) : undefined; },
      set(k, v) {
        if (failKeys.indexOf(k.replace(/^extensions\.zotero\.papilot\./, '')) >= 0) {
          throw new Error('磁盘只读(桩)');
        }
        store.set(k, v);
      },
    },
    Papilot: {
      account: Account, channels: Channels, _diag: () => {},
      menus: { openSettings() { calls.push(['openSettings']); } },
    },
    logError() {},
    debug() {},
  };

  const win = {
    arguments: opts.scope === false ? [] : [{ Zotero, Services: { prompt: { alert() { calls.push(['alert']); } } } }],
    addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    setTimeout(fn) { timers.push(fn); return timers.length; },
    close() { win.closed = true; },
    closed: false,
    fire(ev, arg) { for (const f of (listeners[ev] || []).slice()) f(arg || {}); },
  };
  const document = {
    readyState: 'loading',
    getElementById: (id) => byId.get(id) || null,
    querySelector: (sel) => root.querySelector(sel),
    createElementNS: (ns, tag) => new El(tag),
  };

  const sandbox = { window: win, document, console, Date, JSON, Array, String, Number, Object, Math };
  // ★ 刻意不注入 Zotero：真机窗口作用域里也没有。唯一来源是 window.arguments[0]
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(JS, 'utf8'), sandbox, { filename: 'wizard.js' });

  document.readyState = 'complete';
  win.fire('DOMContentLoaded');

  return { api: sandbox.window.PapilotWizard, root, $: (id) => byId.get(id), win, store, calls, timers };
}

/* ⑧-1 窗口里没有 Zotero 全局时，登录仍须可用（旧代码在这里回「账号模块未就绪」） */
{
  const h = loadWindow({});
  eq(h.$('pp-wz-acc-off').style.display, '', '⑧ 未登录：显示登录表单');
  h.$('pp-wz-login').click();
  eq(h.$('pp-wz-login-msg').textContent, '请填写邮箱和密码', '⑧ 空表单给校验提示（不是「模块未就绪」）');
  h.$('pp-wz-email').value = 'me@example.com';
  h.$('pp-wz-password').value = 'pw';
  h.$('pp-wz-login').click();
  ok(h.calls.some((c) => c[0] === 'login'), '⑧ ★ 登录调到了 account.login（作用域已解析）', h.calls);
}
/* ⑧-2 走完三步必须真的把 wizardDone 写进 pref（否则每次启动都弹） */
{
  const h = loadWindow({ loggedIn: true });   // 已登录：官方通道可切，完成页无告警
  h.$('pp-wz-next').click();   // 1 → 2
  h.$('pp-wz-next').click();   // 2 → 3
  h.$('pp-wz-next').click();   // 3 → 完成
  eq(h.store.get('extensions.zotero.papilot.wizardDone'), 'done', '⑧ ★ 完成三步写入 wizardDone=done');
  ok(/^\d{4}-\d{2}-\d{2}T/.test(String(h.store.get('extensions.zotero.papilot.wizardDoneAt'))),
    '⑧ 同时写 ISO 时间戳', h.store.get('extensions.zotero.papilot.wizardDoneAt'));
  ok(h.$('pp-wz-step-done').className.indexOf('wz-on') >= 0, '⑧ 完成页显示');
  eq(h.$('pp-wz-skip').style.display, 'none', '⑧ 完成页隐藏「稍后再说」（免得把 done 改写成 skipped）');
  eq(h.$('pp-wz-summary').children.length, 4, '⑧ 完成页列出 4 行总结');
  eq(h.$('pp-wz-done-msg').textContent, '随时可以在设置里调整。', '⑧ 全部写入成功 → 无告警');
  eq(h.$('pp-wz-settings').style.display, '', '⑧ ★ 完成页有「打开设置」入口（不是只写一句「去设置里改」）');
  h.$('pp-wz-settings').click();
  ok(h.calls.some((c) => c[0] === 'openSettings'), '⑧ 点「打开设置」真的打开设置面板');
}
/* ⑧-3 关窗 = 稍后再说：必须落 skipped，否则下次启动又弹 */
{
  const h = loadWindow({});
  h.win.fire('unload');
  eq(h.store.get('extensions.zotero.papilot.wizardDone'), 'skipped', '⑧ ★ 关窗写 wizardDone=skipped');
}
/* ⑧-4 写入失败必须如实报出来（旧实现把 failed 吞了，界面显示「成功」） */
{
  const h = loadWindow({ loggedIn: true, failWrites: ['wizardDone'] });
  h.$('pp-wz-next').click();
  h.$('pp-wz-next').click();
  h.$('pp-wz-next').click();
  ok(h.$('pp-wz-done-msg').textContent.indexOf('没能保存') >= 0,
    '⑧ ★ 完成页列出未写入项', h.$('pp-wz-done-msg').textContent);
  eq(h.$('pp-wz-summary').children.length, 5, '⑧ 总结里多一行「未写入」');
  ok(h.$('pp-wz-done-msg').className.indexOf('pp-msg-err') >= 0, '⑧ 用错误色而不是警告色');
}
/* ⑧-5 窗口参数彻底丢失时不崩、有可见提示（而不是白窗） */
{
  const h = loadWindow({ scope: false });
  eq(h.$('pp-wz-step-1').className, 'wz-panel wz-on', '⑧ 作用域缺失仍渲染出第 1 步（不白窗）');
  ok(h.$('pp-wz-login-msg').textContent.indexOf('窗口作用域异常') >= 0,
    '⑧ ★ 作用域缺失给可见提示', h.$('pp-wz-login-msg').textContent);
  const scope = (typeof h.api._scope === 'function') ? h.api._scope() : {};
  eq(scope.hasZotero, false, '⑧ _scope() 如实报告作用域缺失');
}
/* ⑧-6 已完成登录的用户打开向导：直接显示账号，不要求再登录一次 */
{
  const h = loadWindow({ loggedIn: true, pro: true });
  eq(h.$('pp-wz-acc-on').style.display, '', '⑧ 已登录：显示账号块');
  eq(h.$('pp-wz-acc-email').textContent, 'me@example.com', '⑧ 显示邮箱');
  // 服务端档位是 'Pro' 大写：旧代码比 'pro' 恒 false → 专业版用户被写成「免费版」
  eq(h.$('pp-wz-acc-tier').textContent, '专业版', '⑧ ★ 专业版用户显示「专业版」（档位大小写归一）');
  eq(h.$('pp-wz-acc-off').style.display, 'none', '⑧ 隐藏登录表单');
}
{
  const h = loadWindow({ loggedIn: true, pro: false });
  eq(h.$('pp-wz-acc-tier').textContent, '免费版', '⑧ 免费版用户显示「免费版」');
}
/* ⑧-7 完成页按 Esc 只关窗，不把 done 改写成 skipped */
{
  const h = loadWindow({});
  h.$('pp-wz-next').click();
  h.$('pp-wz-next').click();
  h.$('pp-wz-next').click();
  h.win.fire('keydown', { key: 'Escape' });
  eq(h.store.get('extensions.zotero.papilot.wizardDone'), 'done', '⑧ ★ Esc 不覆盖 done');
  eq(h.win.closed, true, '⑧ Esc 关窗');
}

/* ---------------- ⑨ 首启闸门矩阵（WizardGate.decide） ---------------- */
/*
 * 「已登录老用户还被反复弹」的另一半在 main.js：它必须
 *   ① 等会话恢复完再判断登录态；② 已登录 / 已配过自定义通道就补写 skipped。
 * 判定本身抽成纯函数，这里穷举矩阵。
 */
{
  const UTILS = path.join(ROOT, 'chrome', 'content', 'scripts', 'core', 'utils.js');
  const ctx = {
    Zotero: { locale: 'zh-CN', Prefs: { get: () => undefined, set: () => {} }, logError() {} },
    Services: { prefs: {} },
    console,
  };
  ctx.globalThis = ctx;
  const us = vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(UTILS, 'utf8'), us, { filename: 'core/utils.js' });
  const G = us.WizardGate;
  ok(G && typeof G.decide === 'function', '⑨ utils.js 暴露 WizardGate.decide');

  const d0 = G.decide({ wizardDone: '', loggedIn: false, configured: false });
  eq(d0.show, true, '⑨ 真空档 → 弹');
  eq(d0.mark, '', '⑨ 真空档不写 pref');

  eq(G.decide({ wizardDone: 'done', loggedIn: false, configured: false }).show, false,
    '⑨ wizardDone=done → 不弹');
  eq(G.decide({ wizardDone: 'skipped', loggedIn: true, configured: true }).show, false,
    '⑨ wizardDone=skipped → 不弹（哪怕已登录）');

  const dLogin = G.decide({ wizardDone: '', loggedIn: true, configured: false });
  eq(dLogin.show, false, '⑨ ★ 已登录 → 不弹');
  eq(dLogin.mark, 'skipped', '⑨ ★ 已登录要补写 skipped（否则每次启动都重判）');
  eq(dLogin.reason, 'logged-in', '⑨ 原因可读（进启动日志）');

  const dCfg = G.decide({ wizardDone: '', loggedIn: false, configured: true });
  eq(dCfg.show, false, '⑨ ★ 已配过自定义通道 → 不弹');
  eq(dCfg.mark, 'skipped', '⑨ 同样补写 skipped');
  eq(dCfg.reason, 'configured', '⑨ 原因可读');

  eq(G.decide({ wizardDone: '   ', loggedIn: false, configured: false }).show, true,
    '⑨ 只有空白字符也算「没走过」（pref 脏值不留坑）');
  eq(G.decide({ wizardDone: null, loggedIn: false, configured: false }).show, true, '⑨ null 不当作已完成');
  eq(G.decide({}).show, true, '⑨ 空入参不抛（返回要弹）');
}

{
  // 选了「我自己的接口」却没填地址：不能静默跳过（用户会以为存下了）
  const { api, store } = load({});
  const out = api.applyOutcome({
    mode: 'done', channel: 'custom', translate: 'skip', loggedIn: true,
    custom: { baseUrl: '', apiKey: '' },
    setPref: (k, v) => store.set(k, v), getPref: () => '',
    channels: { upsert() { throw new Error('不应调用'); }, setActive() { throw new Error('不应调用'); } },
  });
  ok(out.notes.join('').indexOf('没填地址') >= 0, '⑥ 选自定义但没填地址 → 明确提示未保存', out.notes);
}

/* ---------------- ⑪ 第 3 步：没有可用通道 → 自动回落免费引擎 ---------------- */
/*
 * 契约 §2 第 3 步写着「选 AI 但第 2 步没配 → 自动回落到免费引擎并提示」，
 * 旧实现根本没做：用户跳过登录、又选了「AI 大模型」，向导会把 active 留在 llm，
 * 第一次翻译必然失败。这里把两条分支都钉住。
 */
{
  const { api, store } = load({ translateCfg: JSON.stringify({ active: 'llm' }) });
  const out = api.applyOutcome({
    mode: 'done', channel: 'official', translate: 'ai', loggedIn: false,
    setPref: (k, v) => store.set(k, v), getPref: (k) => store.get(k) || '',
    channels: { setActive() { return { ok: true }; }, upsert() { return { ok: true }; } },
  });
  eq(JSON.parse(store.get('translateCfg')).active, 'google', '⑪ ★ 未登录却选 AI → 自动回落 google');
  ok(out.notes.join('').indexOf('自动改用免费') >= 0, '⑪ 并且说明原因（不静默改）');
}
{
  const { api, store } = load({ translateCfg: JSON.stringify({ active: 'llm' }) });
  api.applyOutcome({
    mode: 'done', channel: 'custom', translate: 'ai', loggedIn: false,
    custom: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k' },
    setPref: (k, v) => store.set(k, v), getPref: (k) => store.get(k) || '',
    channels: { setActive() { return { ok: true }; }, upsert() { return { ok: true }; } },
  });
  eq(JSON.parse(store.get('translateCfg')).active, 'llm', '⑪ 有自定义通道 → 尊重「AI 大模型」');
}
{
  const { api, store } = load({ translateCfg: JSON.stringify({ active: 'llm' }) });
  api.applyOutcome({
    mode: 'done', channel: 'official', translate: 'ai', loggedIn: true,
    setPref: (k, v) => store.set(k, v), getPref: (k) => store.get(k) || '',
    channels: { setActive() { return { ok: true }; }, upsert() { return { ok: true }; } },
  });
  eq(JSON.parse(store.get('translateCfg')).active, 'llm', '⑪ 已登录（官方通道可用）→ 尊重「AI 大模型」');
}

/* ---------------- ⑩ 第一步必须能注册（0.68.3） ---------------- */
/*
 * 用户原话：「首次引导里面没有注册选项，极其不合理」。
 * 真实场景里向导是新用户唯一会打开的界面——只给登录、不给注册，等于把人挡在门外
 * （设置面板里明明有注册入口，向导却漏了）。这里按真机形态跑完整注册链路：
 * 校验 → 调 account.register → 需要验证 / 无需验证两条分支。
 */
const tick = () => new Promise((r) => setTimeout(r, 0));

(async () => {
  {
    const h = loadWindow({ register: 'ok' });
    h.$('pp-wz-reg-link').click();
    eq(h.$('pp-wz-reg-view').style.display, '', '⑩ ★ 点「立即注册」→ 显示注册表单');
    eq(h.$('pp-wz-login-view').style.display, 'none', '⑩ 同时隐藏登录表单');

    h.$('pp-wz-reg').click();
    eq(h.$('pp-wz-reg-msg').textContent, '请填写邮箱和密码', '⑩ 空表单给校验提示');

    h.$('pp-wz-reg-email').value = 'bad-email';
    h.$('pp-wz-reg-password').value = '12345678';
    h.$('pp-wz-reg-password2').value = '12345678';
    h.$('pp-wz-reg').click();
    eq(h.$('pp-wz-reg-msg').textContent, '邮箱格式不正确', '⑩ 邮箱格式校验');

    h.$('pp-wz-reg-email').value = 'new@example.com';
    h.$('pp-wz-reg-password').value = 'short';
    h.$('pp-wz-reg-password2').value = 'short';
    h.$('pp-wz-reg').click();
    eq(h.$('pp-wz-reg-msg').textContent, '密码至少 8 位', '⑩ 密码长度校验（与服务端/面板同标准）');

    h.$('pp-wz-reg-password').value = '12345678';
    h.$('pp-wz-reg-password2').value = '87654321';
    h.$('pp-wz-reg').click();
    eq(h.$('pp-wz-reg-msg').textContent, '两次输入的密码不一致', '⑩ 两次密码一致性');
    eq(h.calls.filter((c) => c[0] === 'register').length, 0, '⑩ 校验不过不发请求');
  }

  /* 无需邮箱验证 → 注册后自动登录，用户一步到位 */
  {
    const h = loadWindow({ register: 'ok' });
    h.$('pp-wz-reg-link').click();
    h.$('pp-wz-reg-email').value = 'new@example.com';
    h.$('pp-wz-reg-nickname').value = '小明';
    h.$('pp-wz-reg-password').value = '12345678';
    h.$('pp-wz-reg-password2').value = '12345678';
    h.$('pp-wz-reg').click();
    await tick(); await tick();
    const reg = h.calls.find((c) => c[0] === 'register');
    ok(!!reg, '⑩ ★ 注册调到了 account.register（作用域已解析）', h.calls);
    eq(reg && reg[1], 'new@example.com', '⑩ 邮箱原样传入');
    eq(reg && reg[3], '小明', '⑩ 昵称原样传入');
    ok(h.calls.some((c) => c[0] === 'login'), '⑩ ★ 无需验证时自动登录（少一步操作）');
    eq(h.$('pp-wz-acc-on').style.display, '', '⑩ 注册后显示账号块');
    eq(h.$('pp-wz-acc-msg').textContent, '注册成功，已登录', '⑩ 成功提示写在账号块里（不是隐藏的表单里）');
    eq(h.$('pp-wz-reg-password').value, '', '⑩ ★ 注册后清空密码框');
  }

  /* 需要邮箱验证 → 不假装登录，回登录视图并预填邮箱 */
  {
    const h = loadWindow({ register: 'verify' });
    h.$('pp-wz-reg-link').click();
    h.$('pp-wz-reg-email').value = 'v@example.com';
    h.$('pp-wz-reg-password').value = '12345678';
    h.$('pp-wz-reg-password2').value = '12345678';
    h.$('pp-wz-reg').click();
    await tick(); await tick();
    ok(h.$('pp-wz-login-msg').textContent.indexOf('验证') >= 0,
      '⑩ ★ 需验证时明确提示去点邮件链接', h.$('pp-wz-login-msg').textContent);
    eq(h.$('pp-wz-login-view').style.display, '', '⑩ 切回登录视图');
    eq(h.$('pp-wz-email').value, 'v@example.com', '⑩ 邮箱已预填');
    eq(h.$('pp-wz-acc-on').style.display, 'none', '⑩ 未激活不算已登录');
    eq(h.$('pp-wz-reg-password').value, '', '⑩ 密码已清空');
  }

  /* 注册失败 → 原始原因如实显示，仍停在注册视图 */
  {
    const h = loadWindow({ register: 'fail' });
    h.$('pp-wz-reg-link').click();
    h.$('pp-wz-reg-email').value = 'dup@example.com';
    h.$('pp-wz-reg-password').value = '12345678';
    h.$('pp-wz-reg-password2').value = '12345678';
    h.$('pp-wz-reg').click();
    await tick(); await tick();
    eq(h.$('pp-wz-reg-msg').textContent, '邮箱已被注册', '⑩ 注册失败显示服务端原因');
    eq(h.$('pp-wz-reg-view').style.display, '', '⑩ 失败后留在注册视图（不用重填）');
    eq(h.$('pp-wz-reg-email').value, 'dup@example.com', '⑩ 邮箱没被清掉');
  }

  /* 重开向导（当前通道本来就可用、且没点过通道卡片）→ 保持现状，不许切回官方 */
  {
    const h = loadWindow({ loggedIn: true, channelOk: true });
    h.$('pp-wz-next').click();
    h.$('pp-wz-next').click();
    h.$('pp-wz-next').click();
    ok(h.$('pp-wz-summary').children[1].textContent.indexOf('保持当前通道') >= 0,
      '⑩ ★ 重开向导不改变现有通道', h.$('pp-wz-summary').children[1].textContent);
    eq(h.calls.filter((c) => c[0] === 'setActive').length, 0, '⑩ 不调 setActive（用户没改选择）');
  }

  /* 选了自定义通道但没填地址：完成页要如实说「未保存」，不能写「已保存」 */
  {
    const h = loadWindow({ loggedIn: true });
    h.$('pp-wz-ch-custom').click();
    h.$('pp-wz-next').click();
    h.$('pp-wz-next').click();
    h.$('pp-wz-next').click();
    ok(h.$('pp-wz-summary').children[1].textContent.indexOf('未保存') >= 0,
      '⑩ 完成页如实写「自定义接口没填地址（未保存）」',
      h.$('pp-wz-summary').children[1].textContent);
  }

  /* 已有账号 → 能切回登录；反之也能切过去 */
  {
    const h = loadWindow({ register: 'ok' });
    h.$('pp-wz-reg-link').click();
    h.$('pp-wz-back-login').click();
    eq(h.$('pp-wz-login-view').style.display, '', '⑩ 「已有账号？去登录」切回登录视图');
    eq(h.$('pp-wz-reg-view').style.display, 'none', '⑩ 注册视图隐藏');
  }
  summary();
})().catch((e) => {
  console.log('wizard: 异步用例崩溃 → ' + ((e && e.stack) || e));
  process.exit(1);
});

/* ---------------- 汇总 ---------------- */
function summary() {
  console.log('wizard: %d 通过 / %d 失败', pass, fails.length);
  if (fails.length) {
    for (const f of fails) console.log('  ✗ ' + f);
    process.exit(1);
  }
}
