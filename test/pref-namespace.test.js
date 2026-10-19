#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* pref 命名空间回归测试（插件 0.54.1）
 *
 * 为什么要有它：`Zotero.Prefs.set(key, value)` 的第三参 global 缺省为 false，
 * Zotero 会自动再补一次 `extensions.zotero.`。历史代码把**完整键**传进去又漏了
 * `true`，值被写进 `extensions.zotero.extensions.zotero.papilot.*` 孤儿键；
 * 读取端用规范键 → 设置面板「提示已保存，但从不生效」，而且没有任何报错。
 *
 * 本套件三层防线：
 *   ① 静态扫描：全仓不允许出现「字面量 extensions.* + 缺 global=true」的 get/set，
 *      也不允许再出现双前缀字面量；
 *   ② 行为：用「按真实语义打前缀」的 Zotero.Prefs 桩，验证 Prefs.set 落点；
 *   ③ 迁移：旧双前缀键（string/bool/int 三种类型、规范键已存在/不存在两种情形）
 *      都能被 Prefs.migrateLegacyNamespace() 正确搬回并清理。
 *
 * 运行：node test/pref-namespace.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const UTILS = path.join(ROOT, 'chrome', 'content', 'scripts', 'core', 'utils.js');

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

/* ---------------- ① 静态扫描 ---------------- */

function jsFiles(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === '.git') continue;
      jsFiles(p, out);
    } else if (name.endsWith('.js')) {
      out.push(p);
    }
  }
  return out;
}

/** 从 openIdx（指向 '(' 后的第一个字符）起做括号配平，返回调用文本 */
function callText(src, from) {
  let depth = 1;
  let quote = "";
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (!depth) return src.slice(from, i); }
  }
  return src.slice(from, Math.min(src.length, from + 400));
}

const CALL_RE = /Zotero\.Prefs\.(get|set)\(\s*(["'])(extensions\.[^"']*)\2/g;

function stripLineComments(src) {
  return src.split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
}

function scanSources() {
  const files = jsFiles(path.join(ROOT, 'chrome'), []);
  const bad = [];
  for (const f of files) {
    const src = stripLineComments(fs.readFileSync(f, 'utf8'));
    let m;
    CALL_RE.lastIndex = 0;
    while ((m = CALL_RE.exec(src))) {
      const fn = m[1];
      const key = m[3];
      const args = callText(src, m.index + m[0].length);
      const hasGlobalTrue = /,\s*true\s*$/.test(args.trim());
      const orphan = key.indexOf('extensions.zotero.extensions.') === 0;
      if (!hasGlobalTrue || orphan) bad.push({ file: path.relative(ROOT, f), fn, key, orphan });
    }
  }
  return { bad, files: files.length };
}

const scan = scanSources();
eq(scan.bad.length, 0, '全仓 Prefs 调用均为规范键且带 global=true（无孤儿键写入/读取）', scan.bad.slice(0, 5));

/* ---------------- ② 行为：真实前缀语义桩 ---------------- */

function makePrefsStub() {
  const store = new Map();          // fullKey -> { type, value }
  const S = {
    PREF_STRING: 32, PREF_INT: 64, PREF_BOOL: 128,
    getChildList(root) { return [...store.keys()].filter((k) => k.indexOf(root) === 0); },
    getPrefType(k) { const e = store.get(k); return e ? e.type : 0; },
    prefHasUserValue(k) { return store.has(k); },
    getStringPref(k) { const e = store.get(k); return e ? String(e.value) : ''; },
    getBoolPref(k) { const e = store.get(k); return e ? !!e.value : false; },
    getIntPref(k) { const e = store.get(k); return e ? Number(e.value) | 0 : 0; },
    setStringPref(k, v) { store.set(k, { type: S.PREF_STRING, value: String(v) }); },
    setBoolPref(k, v) { store.set(k, { type: S.PREF_BOOL, value: !!v }); },
    setIntPref(k, v) { store.set(k, { type: S.PREF_INT, value: Number(v) | 0 }); },
    clearUserPref(k) { store.delete(k); },
  };
  const ZoteroPrefs = {
    get(key, global) {
      const full = global ? key : 'extensions.zotero.' + key;
      const e = store.get(full);
      if (!e) return undefined;
      return e.type === S.PREF_BOOL ? !!e.value : e.value;
    },
    set(key, value, global) {
      const full = global ? key : 'extensions.zotero.' + key;
      const type = typeof value === 'boolean' ? S.PREF_BOOL
        : (typeof value === 'number' ? S.PREF_INT : S.PREF_STRING);
      store.set(full, { type, value });
    },
  };
  return { store, S, ZoteroPrefs };
}

function loadUtils(prefsStub) {
  const ctx = {
    Zotero: { locale: 'zh-CN', Prefs: prefsStub.ZoteroPrefs, logError() {} },
    Services: { prefs: prefsStub.S },
    console,
  };
  ctx.globalThis = ctx;
  const sandbox = vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(UTILS, 'utf8'), sandbox, { filename: 'core/utils.js' });
  return sandbox;
}

const stub = makePrefsStub();
const sandbox = loadUtils(stub);
const Prefs = sandbox.Prefs;
ok(Prefs && typeof Prefs.migrateLegacyNamespace === 'function', 'utils.js 暴露 Prefs.migrateLegacyNamespace');

Prefs.set('probeKey', 'v1');
ok(stub.store.has('extensions.zotero.papilot.probeKey'), 'Prefs.set 落在规范键（带 global=true）');
eq(Prefs.get('probeKey', ''), 'v1', 'Prefs.get 能读回同一键');

/* ---------------- ③ 迁移 ---------------- */

const ROOT_A = 'extensions.zotero.extensions.zotero.papilot.';
const ROOT_B = 'extensions.zotero.extensions.papilot.';
const CANON = 'extensions.zotero.papilot.';

// 三种类型 + 两种情形（规范键缺失 / 已存在）
stub.S.setStringPref(ROOT_A + 'translateGlossary', 'a=b');
stub.S.setBoolPref(ROOT_A + 'pdfDualSyncScroll', false);
stub.S.setIntPref(ROOT_A + 'retries', 3);
stub.S.setStringPref(ROOT_B + 'refPaneCache', '{"k":{"t":1}}');
stub.S.setStringPref(ROOT_A + 'translateGlossaryDomains', '医学');
stub.S.setStringPref(CANON + 'translateGlossaryDomains', '计算机'); // 规范键已有用户值

const moved = Prefs.migrateLegacyNamespace();
eq(moved, 4, '迁移 4 条（规范键已存在的那条不覆盖，只清理）');
eq(Prefs.get('translateGlossary', ''), 'a=b', '术语表已搬到规范键');
eq(Prefs.get('pdfDualSyncScroll', true), false, '布尔值搬迁移保持 false（不被默认值吞掉）');
eq(Prefs.get('retries', 0), 3, '整型值搬运正确');
eq(Prefs.get('refPaneCache', ''), '{"k":{"t":1}}', '少写一级 zotero 的键也能搬回');
eq(Prefs.get('translateGlossaryDomains', ''), '计算机', '规范键已有值时不被旧值覆盖');
ok(!stub.store.has(ROOT_A + 'translateGlossary'), '旧键已清理（避免下次重复搬）');
ok(!stub.store.has(ROOT_B + 'refPaneCache'), '第二类旧键已清理');

const again = Prefs.migrateLegacyNamespace();
eq(again, 0, '迁移幂等：第二次 0 条');

/* ---------------- 汇总 ---------------- */

if (fails.length) {
  console.error('\npref 命名空间测试失败 ' + fails.length + ' 项（通过 ' + pass + '）：');
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('pref 命名空间测试通过：' + pass + ' 项（扫描 ' + scan.files + ' 个 JS 文件）');
