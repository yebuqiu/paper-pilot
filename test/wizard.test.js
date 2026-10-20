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

/* ---------------- 汇总 ---------------- */
console.log('wizard: %d 通过 / %d 失败', pass, fails.length);
if (fails.length) {
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
