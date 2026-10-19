#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 原生 Find Full Text 集成（fulltext-resolver.js）测试
 *
 * 覆盖：
 *   ① pref 读取：未设 / 坏 JSON / 单对象写法 → 归一化为数组；
 *   ② 注入：Unpaywall（合法优先、数组第一位）+ Sci-Hub 各镜像 ×2（#pdf/src 与 meta 模板）
 *      + Sci-Net ×2；每条都过 Zotero 的校验规则（name/method/url 含 {doi}/mode/selector）；
 *   ③ 用户手写与其它插件的 resolver 原样保留且排在本插件条目之前；
 *   ④ 幂等：register 连调两次内容不变、无重复；
 *   ⑤ 精确移除：unregister 只删 "Papilot - " 前缀条目，不动其它；
 *   ⑥ 开关：scihubEnabled=false → 无 Sci-Hub/Sci-Net 仍有 Unpaywall；
 *      scinetEnabled=false → 有 Sci-Hub 无 Sci-Net；
 *      fulltextResolverEnabled=false → register 退化为只清不加；
 *   ⑦ 镜像/邮箱 pref 覆盖生效；无变化时不写 pref（避免触发 observer）。
 *
 * 运行：node test/fulltext-resolver.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const MODULE = 'chrome/content/scripts/features/fulltext-resolver.js';
const RESOLVER_PREF = 'extensions.zotero.findPDFs.resolvers';

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  <- ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }
function includes(hay, needle, label) {
  return ok(String(hay).indexOf(needle) >= 0, label, { want: needle, got: String(hay).slice(0, 200) });
}

/* ---------------- 桩环境（每个用例可重置） ---------------- */

function makeEnv() {
  const zoteroPrefs = new Map();   // Zotero 原生 pref（全名键）
  const pluginPrefs = new Map();   // 插件 pref（短名键）
  let writeCount = 0;
  const Zotero = {
    Prefs: {
      get(k, global) { return zoteroPrefs.has(k) ? zoteroPrefs.get(k) : undefined; },
      set(k, v, global) { writeCount++; zoteroPrefs.set(k, v); },
    },
    debug() {},
  };
  const Prefs = {
    get(k, d) { return pluginPrefs.has(k) ? pluginPrefs.get(k) : d; },
    set(k, v) { pluginPrefs.set(k, v); },
  };
  const sandbox = { Zotero, Prefs, JSON, Math, Date, console };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, MODULE), 'utf8'), sandbox, { filename: MODULE });
  return {
    F: sandbox.FullTextResolver,
    zoteroPrefs, pluginPrefs,
    getWriteCount: () => writeCount,
    read() { const r = zoteroPrefs.get(RESOLVER_PREF); return r ? JSON.parse(r) : []; },
  };
}

/** Zotero attachments.js 对单条 resolver 的校验（2026-10 main 分支） */
function validByZotero(r) {
  return !!r && typeof r.name === 'string' && r.name.length > 0 &&
    ['GET', 'POST'].includes(String(r.method).toUpperCase()) &&
    typeof r.url === 'string' && r.url.indexOf('{doi}') >= 0 &&
    ['html', 'json'].includes(String(r.mode).toLowerCase()) &&
    !!r.selector;
}

const names = (list) => list.map((r) => r.name);
const hasName = (list, frag) => list.some((r) => String(r.name).indexOf(frag) >= 0);

/* ---------------- ① 读取归一化 ---------------- */

{
  const env = makeEnv();
  eq(env.F._read().length, 0, 'pref 未设 → 空数组');
  env.zoteroPrefs.set(RESOLVER_PREF, '{bad json');
  eq(env.F._read().length, 0, '坏 JSON → 空数组');
  env.zoteroPrefs.set(RESOLVER_PREF, JSON.stringify({ name: 'Solo', method: 'GET', url: 'https://x/{doi}', mode: 'html', selector: '#a' }));
  const arr = env.F._read();
  eq(arr.length, 1, '单对象写法 → 归一化为数组');
  eq(arr[0].name, 'Solo', '单对象内容保留');
}

/* ---------------- ② 注入 + Zotero 校验 ---------------- */

{
  const env = makeEnv();
  const n = env.F.register();
  const list = env.read();
  eq(n, list.length, 'register 返回注入条数');
  // 默认：1 Unpaywall + 7 镜像×2 + Sci-Net×2 + 出版商直连×1 = 18
  eq(list.length, 18, '默认注入 18 条（1 + 7*2 + 1*2 + 1）', names(list));
  eq(list[0].name, 'Papilot - Unpaywall', 'Unpaywall 排最前（合法优先）');
  ok(list.every(validByZotero), '每条都通过 Zotero 的 resolver 校验', names(list));
  ok(list.every((r) => r.automatic === true), '全部 automatic:true（参与自动下载 PDF）');
  const up = list[0];
  eq(up.mode, 'json', 'Unpaywall 用 json 模式');
  includes(up.url, 'https://api.unpaywall.org/v2/{doi}?email=', 'Unpaywall URL 模板');
  eq(up.mappings && up.mappings.url, 'url_for_pdf', 'Unpaywall mappings.url');
  const sh = list.find((r) => r.name === 'Papilot - Sci-Hub (sci-hub.ru)');
  eq(sh && sh.selector, '#pdf', 'Sci-Hub 主 selector #pdf');
  eq(sh && sh.attribute, 'src', 'Sci-Hub 主 attribute src');
  const meta = list.find((r) => r.name === 'Papilot - Sci-Hub (sci-hub.ru) (meta)');
  eq(meta && meta.selector, "meta[name='citation_pdf_url']", 'Sci-Hub meta 兜底 selector');
  eq(meta && meta.attribute, 'content', 'Sci-Hub meta attribute content');
  ok(hasName(list, 'Sci-Hub (sci-hub.ren)'), '默认链含 .ren（0.43.0 扩充）');
  ok(hasName(list, 'Sci-Hub (sci-hub.hkvisa.net)'), '默认链含 .hkvisa.net');
  ok(hasName(list, 'Sci-Net (sci-net.xyz)'), '含 Sci-Net');
  // 出版商直连：doi.org 跳转落地页取 citation_pdf_url，排链尾（Sci-Hub 之后兜底）
  const pub = list.find((r) => r.name === 'Papilot - Publisher (doi.org)');
  ok(!!pub, '含出版商直连条目');
  eq(pub && pub.url, 'https://doi.org/{doi}', '出版商直连 URL 模板（{doi} 跳转）');
  eq(pub && pub.selector, "meta[name='citation_pdf_url']", '出版商直连 selector');
  eq(pub && pub.attribute, 'content', '出版商直连 attribute content');
  eq(list.indexOf(pub), list.length - 1, '出版商直连排链尾（Sci-Hub 未命中才走）');
  ok(list.every((r) => r.name.indexOf('Papilot - ') === 0), '全部带本插件前缀');
}

/* ---------------- ③ 保留用户/他插件条目 ---------------- */

{
  const env = makeEnv();
  env.zoteroPrefs.set(RESOLVER_PREF, JSON.stringify([
    { name: 'My Paper Source', method: 'GET', url: 'https://example.com/{doi}', mode: 'html', selector: '#pdf-link', attribute: 'href' },
    { name: 'OtherPlugin - X', method: 'GET', url: 'https://o/{doi}', mode: 'html', selector: '#p' },
  ]));
  env.F.register();
  const list = env.read();
  eq(list.length, 20, '用户 2 条保留 + 本插件 18 条');
  eq(list[0].name, 'My Paper Source', '用户条目位置不被挤动');
  eq(list[1].name, 'OtherPlugin - X', '他插件条目保留');
}

/* ---------------- ④ 幂等 ---------------- */

{
  const env = makeEnv();
  env.F.register();
  const first = env.zoteroPrefs.get(RESOLVER_PREF);
  const writes = env.getWriteCount();
  env.F.register();
  env.F.register();
  eq(env.zoteroPrefs.get(RESOLVER_PREF), first, 'register 连调内容不变');
  eq(env.getWriteCount(), writes, '无变化时不再写 pref');
  eq(env.read().length, 18, '无重复条目');
  // 配置变化（旧条目前缀清理）：改镜像后再注册，旧镜像条目被替换而非叠加
  env.pluginPrefs.set('scihubMirrors', 'sci-hub.box');
  env.F.register();
  const list = env.read();
  eq(list.length, 6, '换镜像后 1 + 1*2 + 1*2 + 1 = 6 条', names(list));
  ok(hasName(list, 'Sci-Hub (sci-hub.box)'), '新镜像生效');
  ok(!hasName(list, 'sci-hub.ru'), '旧镜像条目被精确清除');
}

/* ---------------- ⑤ 精确移除 ---------------- */

{
  const env = makeEnv();
  env.zoteroPrefs.set(RESOLVER_PREF, JSON.stringify([
    { name: 'My Paper Source', method: 'GET', url: 'https://example.com/{doi}', mode: 'html', selector: '#pdf-link' },
  ]));
  env.F.register();
  const removed = env.F.unregister();
  eq(removed, 18, 'unregister 报告移除 18 条');
  const list = env.read();
  eq(list.length, 1, '只剩用户条目');
  eq(list[0].name, 'My Paper Source', '用户条目原样保留');
  const writes = env.getWriteCount();
  env.F.unregister();
  eq(env.getWriteCount(), writes, '重复 unregister 无变化不写 pref');
}

/* ---------------- ⑥ 开关 ---------------- */

{
  const env = makeEnv();
  env.pluginPrefs.set('scihubEnabled', false);
  env.F.register();
  const list = env.read();
  eq(list.length, 2, 'scihubEnabled=false → Unpaywall + 出版商直连（出版商独立于 Sci-Hub 开关）', names(list));
  eq(list[0].name, 'Papilot - Unpaywall', 'Unpaywall 仍在');
  eq(list[1].name, 'Papilot - Publisher (doi.org)', '出版商直连仍在（独立开关）');
}
{
  const env = makeEnv();
  env.pluginPrefs.set('scinetEnabled', false);
  env.F.register();
  const list = env.read();
  eq(list.length, 16, 'scinetEnabled=false → 1 + 7*2 + 1 = 16 条', names(list));
  ok(!hasName(list, 'Sci-Net'), '无 Sci-Net');
}
{
  const env = makeEnv();
  env.pluginPrefs.set('publisherDirectEnabled', false);
  env.F.register();
  const list = env.read();
  eq(list.length, 17, 'publisherDirectEnabled=false → 1 + 7*2 + 2 = 17 条（无 doi.org 条目）', names(list));
  ok(!hasName(list, 'Publisher (doi.org)'), '出版商直连被关闭');
}
{
  const env = makeEnv();
  env.F.register();
  eq(env.read().length, 18, '总开关默认开：先注入 18 条');
  env.pluginPrefs.set('fulltextResolverEnabled', false);
  const n = env.F.register();
  eq(n, 0, 'fulltextResolverEnabled=false → 不加');
  eq(env.read().length, 0, '且清掉已有本插件条目');
}

/* ---------------- ⑦ pref 覆盖 ---------------- */

{
  const env = makeEnv();
  env.pluginPrefs.set('unpaywallEmail', 'me@lab.edu');
  env.pluginPrefs.set('scihubMirrors', 'mirror-a.org, https://mirror-b.net/');
  env.pluginPrefs.set('scinetUrl', 'sci-net.example.org');
  env.F.register();
  const list = env.read();
  includes(list[0].url, 'email=me%40lab.edu', 'unpaywallEmail 进 URL 且编码');
  eq(list.length, 8, '自定义镜像 2 个 → 1 + 2*2 + 1*2 + 1 = 8 条', names(list));
  ok(hasName(list, 'Sci-Hub (mirror-a.org)'), '裸域名自动补 https://');
  ok(hasName(list, 'Sci-Hub (mirror-b.net)'), '尾斜杠去除');
  ok(hasName(list, 'Sci-Net (sci-net.example.org)'), 'scinetUrl 覆盖生效');
  const mb = list.find((r) => r.name === 'Papilot - Sci-Hub (mirror-b.net)');
  includes(mb.url, 'https://mirror-b.net/{doi}', '镜像 URL 模板拼 {doi}');
}

/* ---------------- 汇总 ---------------- */

console.log('通过 ' + pass + ' 项');
if (fails.length) {
  console.log('失败 ' + fails.length + ' 项：');
  for (const f of fails) console.log('  x ' + f);
  process.exit(1);
}
console.log('全部通过');
