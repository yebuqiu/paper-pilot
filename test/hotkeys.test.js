#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 快捷键中央注册表（Hotkeys）测试
 *
 * 覆盖：combo 字符串规范化（Ctrl/Cmd/Shift 顺序归一）、comboFromEvent 合成、
 * matches 判定（Ctrl/Cmd 等价、修饰键严格）、register/getAll/setCombo/resetCombo/
 * setEnabled 生效与 pref 持久化、主窗口 keyset 动态重建、startRecording 录制助手。
 *
 * 运行：node test/hotkeys.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FILES = ['chrome/content/scripts/features/hotkeys.js'];

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  <- ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

/* ---------------- 迷你 DOM（keyset 重建用） ---------------- */

class El {
  constructor(tag) {
    this.tag = tag; this.children = []; this._attrs = {};
    this.id = ''; this.parentNode = null; this.handlers = {};
  }
  setAttribute(k, v) { this._attrs[k] = String(v); }
  getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { c.remove(); return c; }
  remove() {
    if (this.parentNode) {
      this.parentNode.children = this.parentNode.children.filter((x) => x !== this);
      this.parentNode = null;
    }
  }
  get firstChild() { return this.children[0] || null; }
  addEventListener(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
  removeEventListener(ev, fn) {
    const list = this.handlers[ev] || [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  fire(ev, arg) {
    for (const f of (this.handlers[ev] || []).slice()) f(arg || {});
  }
  _by(pred) {
    for (const c of this.children) {
      if (pred(c)) return c;
      const r = c._by(pred);
      if (r) return r;
    }
    return null;
  }
  byId(i) { return this._by((n) => n.id === i) || null; }
}

function makeDoc() {
  const docRoot = new El('window');
  const document = {
    documentElement: docRoot,
    createXULElement: (tag) => new El(tag),
    createElementNS: (ns, tag) => new El(tag),
    getElementById(id) { return docRoot.byId(id); },
    addEventListener(ev, fn) { (this.handlers = this.handlers || {})[ev] = this.handlers[ev] || []; this.handlers[ev].push(fn); },
    removeEventListener(ev, fn) {
      const list = (this.handlers || {})[ev] || [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    fire(ev, arg) {
      for (const f of ((this.handlers || {})[ev] || []).slice()) f(arg || {});
    },
  };
  return { document, docRoot };
}

/* ---------------- 桩环境 ---------------- */

const PrefStore = new Map();
const { document, docRoot } = makeDoc();
const win = { document, ZoteroPane: {} };
const Zotero = {
  Prefs: {
    get: (k) => (PrefStore.has(k) ? PrefStore.get(k) : undefined),
    set: (k, v) => PrefStore.set(k, v),
  },
  getMainWindow: () => win,
  getMainWindows: () => [win],
  logError() {},
};
const Services = { obs: { addObserver() {}, removeObserver() {} } };

const sandbox = { console, Zotero, Services, JSON, Date, Math };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of FILES) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
}
const HK = sandbox.Hotkeys;
const PREF = HK.PREF_KEY;

(function main() {
  /* ---------------- ① combo 规范化（顺序归一 + Cmd 别名） ---------------- */

  eq(HK.normalizeCombo('shift+ctrl+k'), 'Ctrl+Shift+K', '规范化：修饰键顺序归一');
  eq(HK.normalizeCombo('Cmd+Enter'), 'Ctrl+Enter', '规范化：Cmd 归一为 Ctrl（accel）');
  eq(HK.normalizeCombo('cmd+shift+p'), 'Ctrl+Shift+P', '规范化：cmd 小写别名');
  eq(HK.normalizeCombo('alt+f4'), 'Alt+F4', '规范化：Alt + 功能键');
  eq(HK.normalizeCombo('ctrl+alt+delete'), 'Ctrl+Alt+Delete', '规范化：三键组合');
  eq(HK.normalizeCombo('Control+Option+t'), 'Ctrl+Alt+T', '规范化：Control/Option 别名');
  eq(HK.normalizeCombo('ctrl+esc'), 'Ctrl+Escape', '规范化：Esc 别名收敛');
  eq(HK.normalizeCombo('shift+ctrl+shift+k'), 'Ctrl+Shift+K', '规范化：重复修饰键去重');
  eq(HK.normalizeCombo('ctrl+'), '', '规范化：缺键名返回空');
  eq(HK.normalizeCombo(''), '', '规范化：空串返回空');
  eq(HK.normalizeCombo('k'), 'K', '规范化：裸键大写');

  /* ---------------- ② comboFromEvent ---------------- */

  eq(HK.comboFromEvent({ key: 'k', ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+K',
    'fromEvent: ctrl+shift+k');
  eq(HK.comboFromEvent({ key: 'Enter', metaKey: true }), 'Ctrl+Enter',
    'fromEvent: metaKey 归一为 Ctrl');
  eq(HK.comboFromEvent({ key: 'Control', ctrlKey: true }), null, 'fromEvent: 纯修饰键返回 null');
  eq(HK.comboFromEvent({ key: ' ', altKey: true }), 'Alt+Space', 'fromEvent: 空格键名');
  eq(HK.comboFromEvent({ key: 'F9', ctrlKey: true }), 'Ctrl+F9', 'fromEvent: 功能键');

  /* ---------------- ③ matches ---------------- */

  ok(HK.matches({ key: 'Enter', metaKey: true }, 'Ctrl+Enter'), 'matches: Cmd 命中 Ctrl');
  ok(!HK.matches({ key: 'Enter', metaKey: true, shiftKey: true }, 'Ctrl+Enter'),
    'matches: 多按 Shift 不命中（严格）');
  ok(!HK.matches({ key: 'Enter' }, 'Ctrl+Enter'), 'matches: 缺修饰键不命中');
  ok(HK.matches({ key: 'k', ctrlKey: true, shiftKey: true }, 'Ctrl+Shift+K'),
    'matches: 字母大小写不敏感');
  ok(!HK.matches({ key: 'k', ctrlKey: true, shiftKey: true }, ''), 'matches: 空 combo 不命中');

  /* ---------------- ④ register / getAll / set / reset / enabled ---------------- */

  let mainFired = 0;
  HK.register({
    id: 'a', label: '主窗口动作', combo: 'Ctrl+Shift+K', scope: 'main',
    handler: () => { mainFired++; },
  });
  HK.register({ id: 'b', label: '阅读器动作', combo: 'Ctrl+Enter', scope: 'reader', handler: null });

  const all0 = HK.getAll();
  eq(all0.length, 2, 'getAll: 两条注册项');
  eq(all0[0].combo, 'Ctrl+Shift+K', 'getAll: 生效值 = 默认');
  eq(all0[0].defaultCombo, 'Ctrl+Shift+K', 'getAll: 含默认值');
  eq(all0[0].enabled, true, 'getAll: 默认启用');
  eq(all0[1].scope, 'reader', 'getAll: scope 保留');

  eq(HK.setCombo('a', 'alt+f9'), true, 'setCombo 返回 true');
  eq(HK.combo('a'), 'Alt+F9', 'setCombo: 生效值更新');
  eq(HK.get('a').defaultCombo, 'Ctrl+Shift+K', 'setCombo: 默认值不变');
  const ov = JSON.parse(PrefStore.get(PREF));
  eq(ov.a.combo, 'Alt+F9', 'setCombo: 覆盖落 pref（差异存储）');

  eq(HK.setCombo('a', 'ctrl+'), false, 'setCombo: 非法 combo 拒绝');
  eq(HK.combo('a'), 'Alt+F9', 'setCombo: 非法拒绝后保持原值');

  eq(HK.resetCombo('a'), true, 'resetCombo 返回 true');
  eq(HK.combo('a'), 'Ctrl+Shift+K', 'resetCombo: 回到默认');
  ok(!JSON.parse(PrefStore.get(PREF) || '{}').a, 'resetCombo: pref 差异清除');

  eq(HK.setEnabled('a', false), true, 'setEnabled 返回 true');
  eq(HK.isEnabled('a'), false, 'setEnabled: 禁用生效');
  eq(JSON.parse(PrefStore.get(PREF)).a.enabled, false, 'setEnabled: 落 pref');
  eq(HK.isEnabled('b'), true, 'setEnabled: 他项不受影响');
  HK.setEnabled('a', true);
  eq(HK.isEnabled('a'), true, 'setEnabled: 重新启用');
  ok(!JSON.parse(PrefStore.get(PREF) || '{}').a, 'setEnabled: 启用后差异清除');

  eq(HK.setCombo('nope', 'Ctrl+A'), false, 'setCombo: 未注册 id 返回 false');
  eq(HK.get('nope'), null, 'get: 未注册返回 null');

  /* ---------------- ⑤ 主窗口 keyset 动态重建 ---------------- */

  HK.init();
  const keyset = docRoot.byId(HK.KEYSET_ID);
  ok(!!keyset, 'init: keyset 已挂载');
  eq(keyset.children.length, 1, 'keyset: 仅 main scope 且有 handler 的项注入（reader 不注入）');
  eq(keyset.children[0].id, HK.KEY_PREFIX + 'a', 'keyset: key id 前缀');
  eq(keyset.children[0].getAttribute('modifiers'), 'accel shift', 'keyset: modifiers 映射');
  eq(keyset.children[0].getAttribute('key'), 'K', 'keyset: key 属性');
  ok(typeof keyset.children[0].handlers.command[0] === 'function', 'keyset: command 监听已挂');

  // 改键 → 立即重建（keycode 路径）
  HK.setCombo('a', 'ctrl+alt+delete');
  const ks2 = docRoot.byId(HK.KEYSET_ID);
  eq(ks2.children.length, 1, '改键后重建仍 1 个 key');
  eq(ks2.children[0].getAttribute('modifiers'), 'accel alt', '改键后 modifiers 更新');
  eq(ks2.children[0].getAttribute('keycode'), 'VK_DELETE', '特殊键走 keycode');
  eq(ks2.children[0].getAttribute('key'), null, 'keycode 时不设 key');

  // 禁用 → key 消失；启用 → 回来
  HK.setEnabled('a', false);
  eq(docRoot.byId(HK.KEYSET_ID).children.length, 0, '禁用后 keyset 清空');
  HK.setEnabled('a', true);
  HK.resetCombo('a');
  eq(docRoot.byId(HK.KEYSET_ID).children.length, 1, '重新启用后 key 恢复');
  eq(docRoot.byId(HK.KEYSET_ID).children[0].getAttribute('key'), 'K', 'reset 后回到默认键');

  // command 触发 handler（带 win）
  docRoot.byId(HK.KEYSET_ID).children[0].fire('command');
  eq(mainFired, 1, 'key command 触发注册 handler');

  // shutdown 清场
  HK.shutdown();
  ok(!docRoot.byId(HK.KEYSET_ID), 'shutdown: keyset 摘除');

  /* ---------------- ⑥ startRecording ---------------- */

  let recorded = 'unset';
  const cancel = HK.startRecording((combo) => { recorded = combo; });
  ok(typeof cancel === 'function', 'startRecording 返回取消函数');
  document.fire('keydown', {
    key: 'k', ctrlKey: true, shiftKey: true,
    preventDefault() {}, stopPropagation() {},
  });
  eq(recorded, 'Ctrl+Shift+K', '录制：合成 combo 回调');

  let recorded2 = 'unset';
  HK.startRecording((combo) => { recorded2 = combo; });
  document.fire('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} });
  eq(recorded2, null, '录制：Esc 取消回调 null');

  let recorded3 = 'unset';
  const cancel3 = HK.startRecording((combo) => { recorded3 = combo; });
  cancel3();
  document.fire('keydown', { key: 'a', ctrlKey: true, preventDefault() {}, stopPropagation() {} });
  eq(recorded3, 'unset', '录制：取消函数静默（不再回调）');

  /* ---------------- 汇总 ---------------- */

  console.log(`\nhotkeys: ${pass} passed, ${fails.length} failed`);
  if (fails.length) {
    for (const f of fails) console.log('  x ' + f);
    process.exit(1);
  }
  console.log('ALL OK');
})();
