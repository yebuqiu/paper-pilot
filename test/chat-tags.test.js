#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 可编辑 #命令标签体系（CommandTags）测试
 *
 * 覆盖：首次启动播种内置默认、pref 合并（同 id 覆盖 / 自定义追加 / 缺失默认补齐）、
 * 删除内置打墓碑（重启不复活）、upsert 持久化、trigger 正则匹配与 {input} 套用、
 * 剪贴板 JSON 全量导入导出。
 *
 * 运行：node test/chat-tags.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FILES = ['chrome/content/scripts/ai/command-tags.js'];

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  <- ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

/* ---------------- 桩环境 ---------------- */

const PrefStore = new Map();
const Zotero = {
  Prefs: {
    get: (k) => (PrefStore.has(k) ? PrefStore.get(k) : undefined),
    set: (k, v) => PrefStore.set(k, v),
  },
  logError() {},
};

const Prompts = {
  all: () => [
    { id: 't1', name: '总结', text: '请总结这篇论文' },
    { id: 't2', name: '方法', text: '这篇论文用了什么方法？' },
  ],
};

const sandbox = { console, Zotero, Prompts, JSON, Date, Math };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of FILES) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
}
const CT = sandbox.CommandTags;
const PREF = CT.PREF_KEY;

/** 模拟重启：清内存视图，强制下次访问重读 pref */
function restart() { CT._tags = null; CT._tombstones = null; }

(function main() {
  /* ---------------- ① 首次启动：播种内置默认 ---------------- */

  eq(CT.all().length, 2, '首次启动：内置默认标签 2 个');
  eq(CT.all()[0].id, 't1', '默认标签沿用 Prompts 内置 id');
  ok(!!CT.all()[0].color, '默认标签带调色板颜色');
  ok(PrefStore.has(PREF), '首次启动即落 pref');
  const seeded = JSON.parse(PrefStore.get(PREF));
  eq(seeded.length, 2, 'pref 播种为全量数组');

  /* ---------------- ② pref 合并：同 id 覆盖 / 自定义追加 / 缺失补齐 ---------------- */

  PrefStore.set(PREF, JSON.stringify([
    { id: 't1', label: '改名总结', prompt: '改过的提示词', color: '#123456', trigger: '^/zj' },
    { id: 'u1', label: '自定义', prompt: '自定义提示词', color: '', trigger: '' },
  ]));
  restart();
  const merged = CT.all();
  eq(merged.length, 3, '合并：2 pref + 缺失默认 t2 补齐 = 3');
  const t1 = merged.find((t) => t.id === 't1');
  eq(t1.label, '改名总结', '合并：同 id 用 pref 覆盖 label');
  eq(t1.prompt, '改过的提示词', '合并：同 id 用 pref 覆盖 prompt');
  eq(t1.trigger, '^/zj', '合并：trigger 一并覆盖');
  ok(merged.some((t) => t.id === 'u1'), '合并：pref 自定义标签保留');
  const t2 = merged.find((t) => t.id === 't2');
  eq(t2.prompt, '这篇论文用了什么方法？', '合并：pref 缺失的内置默认补齐');

  /* ---------------- ③ 删除内置：墓碑防复活 ---------------- */

  eq(CT.remove('t2'), true, '删除内置默认返回 true');
  restart();
  ok(!CT.all().some((t) => t.id === 't2'), '删除内置后重启不复活（墓碑）');
  const rawAfterDel = JSON.parse(PrefStore.get(PREF));
  ok(rawAfterDel.some((t) => t.id === 't2' && t.deleted), 'pref 含 {id,deleted:true} 墓碑');
  eq(CT.remove('t2'), false, '重复删除返回 false');

  // 重建同 id = 撤销删除
  CT.upsert({ id: 't2', label: '方法v2', prompt: '方法问题v2' });
  restart();
  eq((CT.all().find((t) => t.id === 't2') || {}).label, '方法v2', '重建同 id 撤销墓碑');

  /* ---------------- ④ upsert 新建 / 编辑持久化 ---------------- */

  const created = CT.upsert({ label: '新标签', prompt: '新提示词', color: '#abc', trigger: '' });
  ok(created && created.id, 'upsert 无 id 自动生成');
  restart();
  ok(CT.all().some((t) => t.id === created.id), '新建标签重启后仍在');
  CT.upsert({ id: created.id, label: '新标签改', prompt: '新提示词', color: '', trigger: '' });
  restart();
  eq(CT.get(created.id).label, '新标签改', '编辑同 id 覆盖并持久化');
  eq(CT.upsert({ label: '', prompt: '' }), null, '非法入参返回 null');

  /* ---------------- ⑤ trigger 正则匹配与套用 ---------------- */

  CT.upsert({ id: 'trig1', label: '触发', prompt: '触发提示词', trigger: '^/sum\\b' });
  CT.upsert({ id: 'trig2', label: '占位', prompt: '总结：{input}', trigger: '^/in' });
  CT.upsert({ id: 'trigBad', label: '坏正则', prompt: 'x', trigger: '([invalid' });

  const hit = CT.matchTrigger('/sum 这段文字');
  ok(hit && hit.tag.id === 'trig1', 'trigger: 命中对应标签');
  eq(CT.matchTrigger('普通输入'), null, 'trigger: 无命中返回 null');
  eq(CT.matchTrigger(''), null, 'trigger: 空输入返回 null');
  eq(CT.applyTrigger('/sum 这段'), '触发提示词', 'applyTrigger: 无 {input} 整体替换');
  eq(CT.applyTrigger('/in 论文要点'), '总结：/in 论文要点', 'applyTrigger: {input} 替换为原输入');
  eq(CT.applyTrigger('无触发'), '无触发', 'applyTrigger: 无命中原样返回');
  // 坏正则不炸、不命中（且在 trig1/trig2 之后也不影响它们）
  ok(CT.all().some((t) => t.id === 'trigBad'), '坏正则标签仍可存储');
  eq(CT.matchTrigger('([invalid anything') && CT.matchTrigger('([invalid anything').tag.id, null, '坏正则不产生误命中');

  /* ---------------- ⑥ 导入 / 导出 ---------------- */

  const exported = CT.exportJSON();
  const expArr = JSON.parse(exported);
  ok(Array.isArray(expArr) && expArr.length >= 4, '导出为全量数组');
  ok(!expArr.some((t) => t.deleted), '导出不带墓碑');

  // 全量导入（省略内置 t1/t2 → 打墓碑防复活）
  const r = CT.importJSON(JSON.stringify([{ id: 'only', label: '唯一', prompt: 'P' }]));
  eq(r.ok, true, '导入成功');
  eq(r.count, 1, '导入计数正确');
  restart();
  eq(CT.all().length, 1, '导入全量替换（内置不补齐）');
  eq(CT.all()[0].id, 'only', '导入内容正确');
  const rawAfterImport = JSON.parse(PrefStore.get(PREF));
  ok(rawAfterImport.filter((t) => t.deleted).length >= 2, '导入省略的内置默认已打墓碑');

  eq(CT.importJSON('not json').ok, false, '坏 JSON 导入失败');
  eq(CT.importJSON('{"a":1}').ok, false, '非数组导入失败');
  eq(CT.all().length, 1, '失败导入不破坏现有标签');

  /* ---------------- 汇总 ---------------- */

  console.log(`\nchat-tags: ${pass} passed, ${fails.length} failed`);
  if (fails.length) {
    for (const f of fails) console.log('  x ' + f);
    process.exit(1);
  }
  console.log('ALL OK');
})();
