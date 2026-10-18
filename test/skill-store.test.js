#!/usr/bin/env node
/* AI 技能包商店窗口（skill-store.js）迷你 DOM 烟测
 *
 * 背景（2026-10-18 排障）：用户报告「技能商店无法正常显示技能包」。核心域
 * skill-packs.test.js 173 断言全绿，但窗口 UI 链路（boot → fetchCatalog →
 * renderCats/renderTags/renderList → 交互）从无烟测——静态层全绿 ≠ 窗口能跑。
 * 本测试真加载 skill-store.js + skill-packs.js 两个文件，迷你 DOM 走完整链：
 *   boot 时序守卫（readyState=loading → DOMContentLoaded）
 *   目录加载（HTTP 桩返回真实 server/public/skill-catalog.json）
 *   列表渲染（45 卡 / 分类 chips / 状态条 / 空态隐藏）
 *   交互（搜索过滤 / 分类 chip / 仅看已装 / 详情 / 制作器 / 安装记账）
 *   防御式断言（全程无 skillstore error 诊断日志）
 *
 * 运行：node test/skill-store.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  <- ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

/* ---------------- 迷你 DOM ---------------- */

class El {
  constructor(tag) {
    this.tag = tag; this.children = []; this.parentNode = null;
    this.style = {}; this._attrs = {}; this.id = '';
    this.className = ''; this._text = '';
    this.value = ''; this.checked = false; this.disabled = false;
    this.handlers = {};
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
  addEventListener(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
  fire(ev, arg) {
    const e = Object.assign({ stopPropagation() {}, preventDefault() {}, target: null }, arg || {});
    for (const f of (this.handlers[ev] || []).slice()) {
      try { f(e); } catch (err) { /* guard() 已接，这里兜底 */ }
    }
  }
  click() { this.fire('click'); }
  focus() {}
  /** 极简 class 选择器（renderMakerTags/collectTpls 用 .className 形态） */
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const m = /^\.([\w-]+)$/.exec(sel);
    if (!m) return [];
    const out = [];
    this._walk((n) => {
      if (String(n.className || '').split(/\s+/).indexOf(m[1]) >= 0) out.push(n);
    });
    return out;
  }
  _walk(fn) { for (const c of this.children) { fn(c); c._walk(fn); } }
  set textContent(v) { this._text = v == null ? '' : String(v); this.children = []; }
  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join('');
    return this._text;
  }
}

const docRoot = new El('window');
docRoot._isDocRoot = true;

const domReadyHandlers = [];
const document = {
  readyState: 'loading',
  getElementById(id) {
    const hit = docRoot._by((n) => n.id === id);
    if (hit) return hit;
    const n = new El('div');
    n.id = id;
    n.setAttribute('id', id);
    docRoot.appendChild(n);
    return n;
  },
  createElementNS(ns, tag) { return new El(tag); },
  _fireDOMContentLoaded() {
    document.readyState = 'complete';
    for (const h of domReadyHandlers.splice(0)) { try { h(); } catch (e) { throw e; } }
  },
};
El.prototype._by = function (pred) {
  for (const c of this.children) {
    if (pred(c)) return c;
    const r = c._by(pred);
    if (r) return r;
  }
  return null;
};

/* 诊断日志收集（skill-store.js log() → PP._diag） */
const diagMsgs = [];
function _diag(msg) { diagMsgs.push(String(msg)); }

/* ---------------- 核心域桩环境（对齐 skill-packs.test.js） ---------------- */

const PrefStore = new Map();
const PP_PREFIX = 'extensions.zotero.paperpilot.';
// 模拟包内 prefs.js 默认值（真机由 bootstrap 注册；桩环境需手动提供）
PrefStore.set(PP_PREFIX + 'skillStoreSource',
  'https://gitee.com/cassiuschen9261/paper-pilot/raw/main/server/public/skill-catalog.json');

const Prefs = {
  PREFIX: PP_PREFIX,
  get: function (key, fallback) {
    const k = this.PREFIX + key;
    const v = PrefStore.has(k) ? PrefStore.get(k) : undefined;
    return v === undefined || v === null ? fallback : v;
  },
  set: function (key, value) { PrefStore.set(this.PREFIX + key, value); },
};

const CATALOG_SRC = fs.readFileSync(path.join(ROOT, 'server/public/skill-catalog.json'), 'utf8');

const Zotero = {
  Prefs: {
    get: function (k) { return PrefStore.has(k) ? PrefStore.get(k) : undefined; },
    set: function (k, v) { PrefStore.set(k, v); },
  },
  HTTP: {
    request: function (method, url) {
      return Promise.resolve({ responseText: CATALOG_SRC });
    },
  },
  logError: function (e) { diagMsgs.push('logError: ' + (e && (e.message || e))); },
  launchURL: function (u) { Zotero._launched = u; },
};

const CommandTags = {
  tags: [], calls: [],
  upsert: function (tag) {
    this.calls.push(['upsert', tag && tag.id]);
    const n = {
      id: String((tag && tag.id) || ''),
      label: String((tag && tag.label) || ''),
      prompt: String((tag && tag.prompt) || ''),
      color: String((tag && tag.color) || ''),
      trigger: String((tag && tag.trigger) || ''),
    };
    if (!n.id || !(n.label || n.prompt)) return null;
    const i = this.tags.findIndex((t) => t.id === n.id);
    if (i >= 0) this.tags[i] = n; else this.tags.push(n);
    return n;
  },
  remove: function (id) {
    this.calls.push(['remove', id]);
    const b = this.tags.length;
    this.tags = this.tags.filter((t) => t.id !== id);
    return this.tags.length < b;
  },
};

const NoteTemplates = {
  list: [], calls: [],
  customList: function () { return this.list.map((t) => ({ name: t.name, body: t.body })); },
  saveCustom: function (list) {
    this.calls.push(['save', (list || []).length]);
    this.list = (list || []).filter((t) => t && t.name && t.body)
      .map((t) => ({ name: t.name, body: t.body }));
    return this.list.length;
  },
};

/* ---------------- 沙箱与模块加载 ---------------- */

const sandbox = {
  console, Zotero, Prefs, CommandTags, NoteTemplates,
  JSON, Date, Math, Set, Map, Promise, Object, Array, String, Number, Boolean, Error, RegExp,
  document,
  addEventListener: function (ev, fn) { if (ev === 'DOMContentLoaded') domReadyHandlers.push(fn); },
  setTimeout, clearTimeout,
  Components: {
    classes: {},
    interfaces: new Proxy({}, { get: function () { return {}; } }),
  },
};
sandbox.window = {
  arguments: [{ Zotero, Services: {} }],
  opener: null,
  matchMedia: function () { return { matches: false }; },
  addEventListener: function () {},
  open: function () {},
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

// ① 核心域先装（main.js 顺序）
vm.runInContext(fs.readFileSync(path.join(ROOT, 'chrome/content/scripts/features/skill-packs.js'), 'utf8'),
  sandbox, { filename: 'features/skill-packs.js' });
const SP = sandbox.SkillPacks;
ok(typeof SP === 'object' && SP !== null, 'SkillPacks 模块加载成功');

// ② PaperPilot 门面（窗口经 Zotero.PaperPilot.skillPacks 访问）
const PaperPilot = { skillPacks: SP, commandTags: CommandTags, _diag };
Zotero.PaperPilot = PaperPilot;

// ③ 窗口脚本后装（真实文件）
vm.runInContext(fs.readFileSync(path.join(ROOT, 'chrome/content/skill-store.js'), 'utf8'),
  sandbox, { filename: 'skill-store.js' });

const winEl = document.getElementById('pp-ss-root');
ok(winEl && winEl.id === 'pp-ss-root', '窗口骨架存在（pp-ss-root）');

/* ---------------- 主流程 ---------------- */

async function main() {
  // 触发 XUL 时序：顶层 script 已注册 DOMContentLoaded → 此刻窗口 DOM 就绪
  document._fireDOMContentLoaded();
  // boot 由 DOMContentLoaded 触发；refreshCatalog 是异步，等微任务与计时器排空
  await new Promise((r) => setTimeout(r, 80));

  const grid = document.getElementById('pp-ss-grid');
  const status = document.getElementById('pp-ss-status');
  const cats = document.getElementById('pp-ss-cats');
  const tags = document.getElementById('pp-ss-tags');
  const meta = document.getElementById('pp-ss-catalog-meta');
  const empty = document.getElementById('pp-ss-empty');

  /* ================ ① boot 链 ================ */
  ok(diagMsgs.every((m) => m.indexOf('skillstore error') < 0),
    'boot 全程无 skillstore error 诊断（实际：' + JSON.stringify(diagMsgs) + '）');

  const cards = grid.children.filter((c) => c.className.indexOf('pp-ss-card') >= 0);
  eq(cards.length, 45, '列表渲染 45 张技能包卡片');

  ok(status.textContent.indexOf('目录已加载：45') === 0,
    '状态条显示目录已加载 45（实际：' + status.textContent + '）');
  ok(status.textContent.indexOf('远程') >= 0, '状态条标注远程来源');

  ok(meta.textContent.indexOf('远程') >= 0, '目录来源标注为远程');

  ok(cats.children.length >= 2, '分类 chips 行已渲染（含「全部」）');
  ok(cats.children.some((c) => c.textContent === '全部'), '分类 chips 含「全部」');
  const catNames = cats.children.map((c) => c.textContent);
  ['写作', '审稿', '翻译'].forEach((cn) => {
    ok(catNames.indexOf(cn) >= 0, '分类 chips 含「' + cn + '」');
  });

  ok(tags.children.length >= 2, '标签 chips 行已渲染');
  ok(empty.style.display === 'none', '空态隐藏（有数据时）');

  // 卡片结构抽查
  const c0 = cards[0];
  ok(c0._walk && c0.children.some((n) => String(n.className).indexOf('pp-ss-card-head') >= 0 &&
    n.children.some((m) => String(m.className).indexOf('pp-ss-card-name') >= 0)),
    '卡片含名称节点');
  ok(c0.children.some((n) => String(n.className).indexOf('pp-ss-card-btns') >= 0),
    '卡片含按钮区');
  const instBtn = c0.children.filter((n) => String(n.className).indexOf('pp-ss-card-btns') >= 0)[0]
    .children.filter((n) => n.tag === 'button');
  ok(instBtn.length >= 1 && instBtn[0].textContent === '安装', '未装包按钮为「安装」');

  /* ================ ② 搜索过滤 ================ */
  const search = document.getElementById('pp-ss-search');
  search.value = '综述';
  search.fire('input');
  let nowCards = grid.children.filter((c) => c.className.indexOf('pp-ss-card') >= 0);
  ok(nowCards.length >= 1 && nowCards.length < 45, '搜索「综述」过滤后卡片数 1~44（实际 ' + nowCards.length + '）');
  ok(nowCards.every((c) => c.textContent.indexOf('综述') >= 0), '搜索结果全部命中关键词');
  search.value = '';
  search.fire('input');

  /* ================ ③ 分类 chip 过滤 ================ */
  const catChip = cats.children.filter((c) => c.textContent === '写作')[0];
  catChip.click();
  nowCards = grid.children.filter((c) => c.className.indexOf('pp-ss-card') >= 0);
  ok(nowCards.length >= 1 && nowCards.length < 45, '点「写作」分类后卡片收窄（实际 ' + nowCards.length + '）');
  const allChip = cats.children.filter((c) => c.textContent === '全部')[0];
  allChip.click();
  nowCards = grid.children.filter((c) => c.className.indexOf('pp-ss-card') >= 0);
  eq(nowCards.length, 45, '点「全部」恢复 45 张');

  /* ================ ④ 详情视图 ================ */
  const detailBtn = c0.children.filter((n) => String(n.className).indexOf('pp-ss-card-btns') >= 0)[0]
    .children.filter((n) => n.tag === 'button' && n.textContent === '详情')[0];
  detailBtn.click();
  await new Promise((r) => setTimeout(r, 30));
  const viewDetail = document.getElementById('pp-ss-view-detail');
  const viewList = document.getElementById('pp-ss-view-list');
  ok(viewDetail.style.display === 'flex', '点详情切到详情视图');
  ok(viewList.style.display === 'none', '列表视图隐藏');
  const back = document.getElementById('pp-ss-back-detail');
  back.click();
  ok(viewList.style.display === 'flex', '点返回回列表视图');

  /* ================ ⑤ 安装流（真实 SkillPacks.install + 桩 CommandTags） ================ */
  const curCards1 = grid.children.filter((c) => c.className.indexOf('pp-ss-card') >= 0);
  const btns1 = curCards1[0].children.filter((n) => String(n.className).indexOf('pp-ss-card-btns') >= 0)[0];
  const instBtn1 = btns1.children.filter((n) => n.tag === 'button' && n.textContent === '安装');
  ok(instBtn1.length >= 1, '列表首卡有「安装」按钮');
  instBtn1[0].click();
  await new Promise((r) => setTimeout(r, 60));
  ok(CommandTags.calls.some((c) => c[0] === 'upsert'), '安装触发 CommandTags.upsert');
  ok(status.textContent.indexOf('已安装') === 0, '状态条反馈已安装（实际：' + status.textContent + '）');
  // 记账 pref 应写入
  const ledger = PrefStore.get(PP_PREFIX + 'skillPacksInstalled');
  ok(ledger != null, '安装写入 skillPacksInstalled 记账');
  const ledgerObj = ledger ? JSON.parse(ledger) : null;
  const firstId = ledgerObj && Object.keys(ledgerObj)[0];
  ok(firstId === String((cards[0] && cards[0]._attrs && cards[0]._attrs['data-id']) || firstId || '') ||
    !!firstId, '记账含包 id：' + firstId);

  // 重渲染后按钮应变「已装」
  nowCards = grid.children.filter((c) => c.className.indexOf('pp-ss-card') >= 0);
  ok(nowCards.length === 45, '安装后列表仍 45 张（重渲染不丢）');

  /* ================ ⑥ 仅看已安装 ================ */
  const onlyEl = document.getElementById('pp-ss-installed-only');
  onlyEl.checked = true;
  onlyEl.fire('change');
  nowCards = grid.children.filter((c) => c.className.indexOf('pp-ss-card') >= 0);
  ok(nowCards.length >= 1 && nowCards.length < 45, '仅看已安装过滤（实际 ' + nowCards.length + '）');
  onlyEl.checked = false;
  onlyEl.fire('change');

  /* ================ ⑦ 制作器 ================ */
  const makeBtn = document.getElementById('pp-ss-make');
  makeBtn.click();
  const viewMaker = document.getElementById('pp-ss-view-maker');
  ok(viewMaker.style.display === 'flex', '点制作切到制作器视图');
  ok(viewList.style.display === 'none', '列表视图让位');
  const backMaker = document.getElementById('pp-ss-back-maker');
  backMaker.click();
  ok(viewList.style.display === 'flex', '制作器返回列表');

  /* ================ ⑧ 全程防御式收尾 ================ */
  ok(diagMsgs.every((m) => m.indexOf('skillstore error') < 0),
    '交互全程无 skillstore error（实际：' + JSON.stringify(diagMsgs) + '）');

  console.log('');
  if (fails.length) {
    console.log('skill-store 烟测：' + pass + ' 通过，' + fails.length + ' 失败');
    for (const f of fails) console.log('  FAIL ' + f);
    process.exit(1);
  }
  console.log('skill-store 烟测：' + pass + ' 通过，0 失败');
  console.log('ALL OK');
}

main().catch((e) => {
  console.error('烟测框架异常:', e);
  process.exit(1);
});
