#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 笔记模板导入导出 + 自动化规则快捷键/菜单字段 测试（0.39.0）
 *
 * 为什么要有它：这次改动全是「静默失败高发区」——
 *   ① 模板导出/导入走剪贴板 JSON，结构校验或冲突合并错了，表现为「导入了但列表没变
 *      / 重名模板互相覆盖丢内容」；
 *   ② 规则新增的 hotkey / showInMenu 是可选字段，旧 pref 里的规则没有它们，
 *      任何一处没做兼容就是「升级后自动化面板打不开」；
 *   ③ getMenuRules()/getHotkeyRules() 是 menus.js 动态菜单与中央快捷键表的数据源，
 *      过滤条件错了（禁用规则也冒出来 / 空 hotkey 注册失败）会直接打断主窗口。
 * 用 Node vm 把两个模块真跑一遍，桩掉 Prefs / Services.prompt / 剪贴板 hooks：
 *   ① 内置模板规模（>=6）与导出 JSON 结构；
 *   ② 导入：非法 JSON / 结构不对 / 无效条目跳过；
 *   ③ 冲突三分支：skip / overwrite / rename（含与内置撞名重命名）；
 *   ④ 旧规则（无 hotkey/showInMenu）load/validate/过滤不炸；
 *   ⑤ getMenuRules/getHotkeyRules 过滤（禁用、空 hotkey、非法 combo）；
 *   ⑥ runRule：id 不存在 → false 且提示；存在 → 走预览-确认-执行并真改条目。
 *
 * 运行：node test/templates-automation.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const NT_JS = path.join(ROOT, 'chrome', 'content', 'scripts', 'features', 'note-templates.js');
const AU_JS = path.join(ROOT, 'chrome', 'content', 'scripts', 'features', 'automation.js');

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  <- ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

/* ---------------- 桩环境 ---------------- */

function makeSandbox(extra) {
  const PrefStore = new Map();
  const alerts = [];
  const sandbox = {
    console, JSON, Math, Date, Array, Object, String, Number, Set, Map, Promise, RegExp, Error,
    Zotero: {
      logError: () => {},
      debug: () => {},
      getMainWindow: () => ({}),
    },
    Services: {
      prompt: {
        BUTTON_POS_0: 1, BUTTON_POS_1: 256, BUTTON_POS_2: 65536,
        BUTTON_TITLE_IS_STRING: 1,
        alert: (w, t, msg) => alerts.push(String(msg)),
      },
    },
    Prefs: {
      get: (k, d) => (PrefStore.has(k) ? PrefStore.get(k) : d),
      set: (k, v) => PrefStore.set(k, v),
    },
    I18n: { isZh: true, t: (k) => k },
    ItemSel: {
      regularOnly: (items) => (items || []).filter((it) => it && it.regular !== false),
      alertEmpty: () => alerts.push('empty'),
    },
    __alerts: alerts,
    __prefs: PrefStore,
  };
  Object.assign(sandbox, extra || {});
  vm.createContext(sandbox);
  return sandbox;
}

function loadTemplates(sandbox) {
  vm.runInContext(fs.readFileSync(NT_JS, 'utf8'), sandbox, { filename: 'note-templates.js' });
  return sandbox.NoteTemplates;
}
function loadAutomation(sandbox) {
  vm.runInContext(fs.readFileSync(AU_JS, 'utf8'), sandbox, { filename: 'automation.js' });
  return sandbox.Automation;
}

/* ---------------- ① 内置模板与导出 ---------------- */

{
  const NT = loadTemplates(makeSandbox());
  ok(NT.builtin.length >= 6 && NT.builtin.length <= 8, '内置模板 6-8 个', NT.builtin.length);
  const names = NT.builtin.map((t) => t.name).join('|');
  for (const want of ['综述框架', '组会汇报', '文献对比卡', '速读记录增强版']) {
    ok(names.includes(want), '内置模板含「' + want + '」');
  }

  // all() = 内置 + 自定义
  NT.saveCustom([{ name: '我的模板', body: '第一行\n第二行' }]);
  const all = NT.all();
  eq(all.length, NT.builtin.length + 1, 'all() 含自定义');
  eq(all[all.length - 1].body, '第一行\n第二行', '自定义正文换行还原');
}

(async () => {
  /* 导出 → 剪贴板 JSON */
  {
    const sb = makeSandbox();
    const NT = loadTemplates(sb);
    NT.saveCustom([{ name: 'A 模板', body: '正文A' }, { name: 'B 模板', body: '正文B\n换行' }]);
    let clip = '';
    const done = await NT.exportAll({ writeClipboard: async (t) => { clip = t; return true; } });
    eq(done, true, 'exportAll 返回成功');
    const obj = JSON.parse(clip);
    eq(obj.kind, 'noteTemplates', '导出 kind');
    eq(obj.version, 1, '导出 version');
    eq(obj.templates.length, 2, '导出模板数');
    eq(obj.templates[1].body, '正文B\n换行', '导出正文保真');
  }

  // 空自定义 → 不导出
  {
    const NT = loadTemplates(makeSandbox());
    const done = await NT.exportAll({ writeClipboard: async () => true });
    eq(done, false, '无自定义时 exportAll 拒绝');
  }

  /* ---------------- ② 解析校验 ---------------- */
  {
    const NT = loadTemplates(makeSandbox());
    ok(NT.parseImport('不是 json').error, '非法 JSON 报错');
    ok(NT.parseImport('{"foo":1}').error, '结构不对报错');
    ok(NT.parseImport('{"kind":"otherThing","templates":[]}').error, 'kind 不符报错');
    const p = NT.parseImport('{"kind":"noteTemplates","version":1,"templates":[{"name":"X","body":"Y"},{"name":"","body":"Z"},{"body":"W"}]}');
    eq(p.error, '', '合法包无错误');
    eq(p.templates.length, 1, '无效条目被跳过');
    eq(p.skipped, 2, '跳过计数');
    const bare = NT.parseImport('[{"name":"X","body":"Y"}]');
    eq(bare.templates.length, 1, '宽容接受裸数组');
  }

  /* ---------------- ③ 冲突三分支 ---------------- */
  {
    const NT = loadTemplates(makeSandbox());
    const existing = [{ name: '同名', body: '旧内容' }, { name: '独有', body: '不变' }];
    const imported = [{ name: '同名', body: '新内容' }, { name: '全新', body: '新模板' }];

    const skip = NT.applyImport(existing, imported, 'skip');
    eq(skip.merged.length, 3, 'skip：只加不冲突的');
    eq(skip.skipped, 1, 'skip：冲突跳过 1');
    eq(skip.merged.find((t) => t.name === '同名').body, '旧内容', 'skip：旧内容保留');

    const ow = NT.applyImport(existing, imported, 'overwrite');
    eq(ow.merged.length, 3, 'overwrite：总数不膨胀');
    eq(ow.overwritten, 1, 'overwrite：覆盖 1');
    eq(ow.merged.find((t) => t.name === '同名').body, '新内容', 'overwrite：新内容生效');

    const rn = NT.applyImport(existing, imported, 'rename');
    eq(rn.merged.length, 4, 'rename：两份都保留');
    eq(rn.renamed, 1, 'rename：重命名 1');
    eq(rn.merged.find((t) => t.name === '同名').body, '旧内容', 'rename：旧模板不动');
    ok(rn.merged.some((t) => t.name.indexOf('同名（导入') === 0 && t.body === '新内容'), 'rename：导入者带序号后缀');

    // 与内置模板撞名也重命名
    const bi = NT.applyImport([], [{ name: NT.builtin[0].name, body: '冒充内置' }], 'skip');
    eq(bi.merged[0].name !== NT.builtin[0].name, true, '与内置撞名强制重命名');
  }

  /* importJSON 集成（桩剪贴板 + 策略确认） */
  {
    const sb = makeSandbox();
    const NT = loadTemplates(sb);
    NT.saveCustom([{ name: '同名', body: '旧内容' }]);
    const payload = JSON.stringify({
      kind: 'noteTemplates', version: 1,
      templates: [{ name: '同名', body: '新内容' }, { name: '新模板', body: '正文' }],
    });
    let asked = false;
    const res = await NT.importJSON({
      readClipboard: async () => payload,
      confirmStrategy: async () => { asked = true; return 'rename'; },
      alert: () => {},
    });
    eq(res.ok, true, 'importJSON 成功');
    eq(asked, true, '有冲突时询问策略');
    eq(res.added, 2, 'rename 策略两份都进');
    eq(NT.customList().length, 3, '入库 3 条自定义');
  }

  {
    const sb = makeSandbox();
    const NT = loadTemplates(sb);
    const res = await NT.importJSON({ readClipboard: async () => '垃圾内容', alert: () => {} });
    eq(res.ok, false, '剪贴板垃圾 → 失败不炸');
    eq(NT.customList().length, 0, '失败不写库');
  }

  /* ---------------- ④ 旧规则兼容 ---------------- */
  {
    const sb = makeSandbox();
    const AU = loadAutomation(sb);
    // 0.23.0 时代的规则：没有 hotkey / showInMenu
    sb.__prefs.set('automationRules', JSON.stringify([
      { id: 'r1', name: '旧规则', enabled: true, trigger: 'manual', match: 'all',
        conditions: [], actions: [{ type: 'tag', tag: '#旧' }] },
    ]));
    const rules = AU.load();
    eq(rules.length, 1, '旧规则可读');
    eq(AU.validate(rules[0]).length, 0, '旧规则 validate 不炸');
    eq(AU.getMenuRules().length, 0, '旧规则不进菜单');
    eq(AU.getHotkeyRules().length, 0, '旧规则无快捷键');
    eq(AU.activeRules().length, 1, '旧规则仍在激活集');
  }

  /* ---------------- ⑤ 菜单/快捷键过滤 ---------------- */
  {
    const sb = makeSandbox();
    const AU = loadAutomation(sb);
    const base = { trigger: 'manual', match: 'all', conditions: [], actions: [{ type: 'tag', tag: '#x' }] };
    sb.__prefs.set('automationRules', JSON.stringify([
      Object.assign({ id: 'a', name: '菜单规则', enabled: true, showInMenu: true }, base),
      Object.assign({ id: 'b', name: '菜单但禁用', enabled: false, showInMenu: true }, base),
      Object.assign({ id: 'c', name: '未勾选菜单', enabled: true, showInMenu: false }, base),
      Object.assign({ id: 'd', name: '快捷键规则', enabled: true, hotkey: 'Ctrl+Shift+T' }, base),
      Object.assign({ id: 'e', name: '快捷键禁用', enabled: false, hotkey: 'Ctrl+Shift+U' }, base),
      Object.assign({ id: 'f', name: '空快捷键', enabled: true, hotkey: '  ' }, base),
      Object.assign({ id: 'g', name: '非法快捷键', enabled: true, hotkey: 'T' }, base),
    ]));
    const menu = AU.getMenuRules();
    eq(menu.length, 1, 'getMenuRules 只留启用且勾选');
    eq(menu[0].id, 'a', '菜单规则 id');
    eq(Object.keys(menu[0]).sort().join(','), 'id,name', '菜单项只带 id/name');
    const hk = AU.getHotkeyRules();
    eq(hk.length, 1, 'getHotkeyRules 只留启用且合法 combo');
    eq(hk[0].hotkey, 'Ctrl+Shift+T', '快捷键 combo 原样透出');
    eq(hk[0].id, 'd', '快捷键规则 id');
    // isValidHotkey 单元
    eq(AU.isValidHotkey('Ctrl+Shift+T'), true, '合法 combo');
    eq(AU.isValidHotkey('T'), false, '无修饰键拒绝');
    eq(AU.isValidHotkey('Ctrl+'), false, '缺主键拒绝');
    eq(AU.isValidHotkey('Foo+T'), false, '非法修饰键拒绝');
    // 非法 hotkey 计入 validate 错误
    eq(AU.validate(Object.assign({ name: 'x' }, base, { hotkey: 'bad combo!!' })).length > 0, true, '非法 hotkey 校验报错');
  }

  /* ---------------- ⑥ runRule ---------------- */
  {
    const sb = makeSandbox();
    // ProgressWindow 桩
    sb.Zotero.ProgressWindow = class {
      constructor() { this.ItemProgress = class { setProgress() {} setError() {} }; }
      changeHeadline() {} show() {} startCloseTimer() {}
    };
    sb.Services.prompt.confirmEx = () => 0; // 点「执行」
    const AU = loadAutomation(sb);
    sb.__prefs.set('automationRules', JSON.stringify([
      { id: 'r-tag', name: '打标签', enabled: true, trigger: 'manual', match: 'all',
        conditions: [], actions: [{ type: 'tag', tag: '#已处理' }] },
    ]));

    // id 不存在
    const missing = await AU.runRule('no-such-id', [{ getTags: () => [] }]);
    eq(missing, false, 'runRule 未知 id 返回 false');
    ok(sb.__alerts.some((m) => m.includes('不存在')), '未知 id 有提示');

    // 正常执行：真打到条目上
    const tags = [];
    const item = {
      getTags: () => tags.map((t) => ({ tag: t })),
      addTag: (t) => tags.push(t),
      saveTx: async () => {},
      getDisplayTitle: () => '测试条目',
      getField: () => '',
    };
    const ran = await AU.runRule('r-tag', [item]);
    eq(ran, true, 'runRule 执行成功');
    eq(tags.join(','), '#已处理', '标签真写入条目');

    // 确认框点取消 → 不执行
    sb.Services.prompt.confirmEx = () => 1;
    const tags2 = [];
    const item2 = {
      getTags: () => tags2.map((t) => ({ tag: t })),
      addTag: (t) => tags2.push(t),
      saveTx: async () => {},
      getDisplayTitle: () => 'T2', getField: () => '',
    };
    const cancelled = await AU.runRule('r-tag', [item2]);
    eq(cancelled, false, '取消预览不执行');
    eq(tags2.length, 0, '取消后无改动');
  }

  /* ---------------- 汇总 ---------------- */
  console.log('');
  console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.log('✗ 测试自身异常: ' + (e && e.stack || e));
  process.exit(1);
});
