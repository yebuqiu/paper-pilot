#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 「推荐配置」逻辑测试（B3.3）
 *
 * 一键改配置最容易出的事故不是崩，而是**悄悄改掉用户明明关掉的项**。
 * 所以这里只测纯逻辑：plan() 只产出与推荐值不一致的项；apply() 只写这些项；
 * 白名单外的键一个都不碰；用户已经是推荐值时不产生任何写入。
 *
 * 运行：node test/prefs-recommend.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const JS = path.join(ROOT, 'chrome', 'content', 'prefs-recommend.js');
const XHTML = path.join(ROOT, 'chrome', 'content', 'prefs.xhtml');
const MAIN = path.join(ROOT, 'chrome', 'content', 'scripts', 'main.js');

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

function load(prefs) {
  const store = new Map(Object.entries(prefs || {}));
  const Zotero = {
    Prefs: {
      get: (k, d) => {
        const key = k.replace(/^extensions\.zotero\.papilot\./, '');
        return store.has(key) ? store.get(key) : d;
      },
      set: (k, v) => { store.set(k.replace(/^extensions\.zotero\.papilot\./, ''), v); },
    },
    Papilot: { openWizard: () => { store.set('__wizardOpened', true); } },
  };
  const window = { setTimeout: () => 0, addEventListener: () => {} };
  const document = { getElementById: () => null };
  const Services = { prompt: { BUTTON_POS_0: 1, BUTTON_POS_1: 2, BUTTON_TITLE_IS_STRING: 4, BUTTON_TITLE_CANCEL: 8, confirmEx: () => 1 } };
  const sandbox = { Zotero, window, document, Services, console, JSON, Array, String, Number, Object };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(JS, 'utf8'), sandbox, { filename: 'prefs-recommend.js' });
  return { api: sandbox.window.PapilotRecommend, store };
}

/* ---------------- ① plan：只列不一致项 ---------------- */
{
  const { api } = load({});
  // 空配置：默认值就是推荐值 → 不应产生任何修改
  const none = api.plan((k, d) => d);
  eq(none.length, 0, '① 全部为推荐值时不产生任何项');

  const some = api.plan((k, d) => (k === 'citeLinksEnabled' ? false : d));
  eq(some.length, 1, '① 只有被关掉的那一项进清单');
  eq(some[0].key, 'citeLinksEnabled', '① 清单项指向正确的键');
  eq(some[0].to, true, '① 推荐值是 true');
}
{
  // 用户改了「非推荐」的值（例如把进度条设成 false）→ 也要能识别
  const { api } = load({});
  const items = api.plan((k, d) => (k === 'progressRowEnabled' ? false : (k === 'updateNoticeEnabled' ? false : d)));
  eq(items.length, 2, '① 关掉两项 → 清单两项');
  const keys = items.map((i) => i.key).sort().join(',');
  eq(keys, 'progressRowEnabled,updateNoticeEnabled', '① 清单键正确', keys);
}

/* ---------------- ② apply：只写清单里的键 ---------------- */
{
  const { api, store } = load({});
  const wrote = api.apply((k, v) => store.set(k, v), [
    { key: 'citeLinksEnabled', to: true },
    { key: 'relatedPapersEnabled', to: true },
  ]);
  eq(JSON.stringify(wrote), JSON.stringify(['citeLinksEnabled', 'relatedPapersEnabled']), '② 实写列表与清单一致');
  eq(store.get('citeLinksEnabled'), true, '② 值确实写进去了');
  eq(store.size, 2, '② 没有多写任何键', [...store.keys()]);
}
{
  const { api, store } = load({});
  api.apply((k, v) => store.set(k, v), []);
  eq(store.size, 0, '② 空清单 → 零写入');
}

/* ---------------- ③ 白名单：不碰密钥/计费/账号类 ---------------- */
{
  const { api } = load({});
  const keys = api.RECOMMENDED.map((r) => r[0]);
  const forbidden = ['easyScholarKey', 's2ApiKey', 'cnkiPassword', 'aiChannels', 'translateCfg',
    'wizardDone', 'uiTheme', 'pdfTheme', 'aiTemperature', 'aiSystemPrompt'];
  const bad = keys.filter((k) => forbidden.indexOf(k) >= 0);
  eq(JSON.stringify(bad), '[]', '③ ★ 推荐表不含密钥 / 计费 / 账号 / 主题类设置', bad);
  ok(keys.length >= 4 && keys.length <= 8, '③ 推荐项数量克制（4–8 项）', keys.length);
}

/* ---------------- ④ 结构体检 ---------------- */
{
  const x = fs.readFileSync(XHTML, 'utf8');
  ok(x.indexOf('id="pp-recommend"') >= 0, '④ 工具条有「推荐配置」按钮');
  ok(x.indexOf('id="pp-wizard-open"') >= 0, '④ 工具条有「首次使用向导」入口');
  ok(x.indexOf('id="pp-recommend-msg"') >= 0, '④ 有结果提示位（不静默改配置）');
  const m = fs.readFileSync(MAIN, 'utf8');
  ok(m.indexOf('prefs-recommend.js') >= 0, '④ 面板脚本已注册到 PreferencePanes');
  ok(m.indexOf('openWizard()') >= 0 && m.indexOf('papilot:wizard') >= 0,
    '④ 主模块有 openWizard() 且用 papilot:wizard 单例');
}

/* ---------------- 汇总 ---------------- */
console.log('prefs-recommend: %d 通过 / %d 失败', pass, fails.length);
if (fails.length) {
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
