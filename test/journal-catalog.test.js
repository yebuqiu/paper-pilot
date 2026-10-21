#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 期刊订阅目录测试（chrome/content/scripts/data/journals.js）
 *
 * 为什么单独一套：目录是「按期刊订阅」的唯一数据源，错一条就是静默订错刊
 * （ISSN 打错 → 拉到别的杂志，用户还以为订阅坏了）。这里把能离线验证的
 * 结构问题全部钉住：
 *   ① 每条 ISSN 必须过 mod-11 校验位（手写错号最常见）；
 *   ② 名称 / ISSN 不得重复（重复 = 面板出现两张一模一样的卡）；
 *   ③ 学科必须在内置列表里，且每个学科都有足够条目（否则筛选点了等于空）；
 *   ④ 中文字段不得为空（默认中文界面；英文名对国内用户不友好）；
 *   ⑤ main.js 必须先加载目录再加载 search-subs.js（顺序错 = 面板首次渲染空白）。
 *
 * 在线核对（ISSN ↔ 刊名）需要网络，放在 scripts/verify-journal-catalog.py，不进本测试。
 *
 * 运行：node test/journal-catalog.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'chrome', 'content', 'scripts', 'data', 'journals.js');
const MAIN = path.join(ROOT, 'chrome', 'content', 'scripts', 'main.js');

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

/** ISSN 校验位：前 7 位加权 8..2，总和 mod 11；余数 0 → 校验位 0，余数 1 → X（这里按 11-余 归一到 0..10） */
function issnValid(v) {
  if (!/^\d{4}-\d{3}[\dX]$/.test(String(v || ''))) return false;
  const d = String(v).replace('-', '');
  let total = 0;
  for (let i = 0; i < 7; i++) total += Number(d[i]) * (8 - i);
  const check = (11 - (total % 11)) % 11;
  return d[7] === (check === 10 ? 'X' : String(check));
}

function main() {
  ok(fs.existsSync(DATA), '① 目录文件存在', DATA);
  const cat = require(DATA);

  ok(cat && typeof cat === 'object', '① 导出为对象');
  eq(cat.version, 1, '① 目录版本号为 1');
  ok(Array.isArray(cat.subjects) && cat.subjects.length >= 15, '② 学科数量 ≥ 15', (cat.subjects || []).length);
  ok(Array.isArray(cat.list) && cat.list.length >= 400, '② 期刊数量 ≥ 400（「全世界多种期刊」的底线）', (cat.list || []).length);

  const subIds = new Set();
  for (const s of cat.subjects || []) {
    ok(!!s.id && !!s.name, '② 学科必须有 id 与中文名', s);
    ok(!subIds.has(s.id), '② 学科 id 唯一', s.id);
    ok(/^[\u4e00-\u9fa5]{2,6}$/.test(String(s.name || '')), '② 学科名必须是 2–6 个汉字', s.name);
    subIds.add(s.id);
  }

  const names = new Map();
  const issns = new Map();
  const perSubject = {};
  let hot = 0;
  let withAlias = 0;

  for (const j of cat.list || []) {
    const label = '③ ' + (j && j.n ? j.n : '(无名)');
    ok(!!j && typeof j === 'object', '③ 条目必须是对象');
    if (!j) continue;

    ok(typeof j.n === 'string' && j.n.trim().length >= 2, label + ' 名称非空');
    ok(typeof j.n === 'string' && j.n.length <= 120, label + ' 名称不过长');
    ok(!/[<>"]/.test(String(j.n || '')), label + ' 名称不含 HTML 危险字符');
    ok(issnValid(j.i), label + ' ISSN 校验位正确', j.i);
    ok(subIds.has(j.s), label + ' 学科在列表内', j.s);
    if (j.a !== undefined) {
      ok(typeof j.a === 'string' && j.a.length > 0, label + ' 别名非空（有字段就得有值）');
      ok(String(j.a).indexOf('|') < 0 || String(j.a).split('|').every((x) => x.trim().length > 0),
        label + ' 别名 | 分隔且每段非空');
    }
    if (j.h) hot++;

    const nk = String(j.n).trim().toLowerCase();
    ok(!names.has(nk), label + ' ★ 名称不重复（重复会在面板出现两张同款卡）', names.get(nk));
    names.set(nk, j.i);

    const ik = String(j.i).toUpperCase();
    ok(!issns.has(ik), label + ' ★ ISSN 不重复', issns.get(ik));
    issns.set(ik, j.n);

    perSubject[j.s] = (perSubject[j.s] || 0) + 1;
    if (j.a) withAlias++;
  }

  // 每个学科都要有足够条目：少于 8 条的学科筛选出来几乎是空的，不如不提供
  for (const s of cat.subjects || []) {
    ok((perSubject[s.id] || 0) >= 8, '④ 学科「' + s.name + '」至少 8 种期刊', perSubject[s.id] || 0);
  }

  ok(hot >= 12, '⑤ 热门期刊至少 12 种（面板首屏靠它撑住）', hot);
  ok(withAlias >= 80, '⑤ 至少 80 种期刊带中文别名 / 缩写（中文搜索可用）', withAlias);
  ok(issns.size >= 400, '⑤ ISSN 索引规模 ≥ 400', issns.size);

  // 覆盖「全球主要刊」的抽查：这几本缺了，说明目录明显不完整
  const must = [
    ['New England Journal of Medicine', '0028-4793'],
    ['The Lancet', '0140-6736'],
    ['Nature', '0028-0836'],
    ['Science', '0036-8075'],
    ['Cell', '0092-8674'],
    ['JAMA', '0098-7484'],
    ['BMJ', '0959-8138'],
    ['Physical Review Letters', '0031-9007'],
    ['Journal of the American Chemical Society', '0002-7863'],
    ['IEEE Transactions on Pattern Analysis and Machine Intelligence', '0162-8828'],
    ['American Economic Review', '0002-8282'],
    ['The Journal of Finance', '0022-1082'],
  ];
  for (const [n, i] of must) {
    eq(issns.get(i), n, '⑥ 必含期刊：' + n);
  }

  // 加载顺序：目录必须在 search-subs.js 之前（后者 init 时就要读目录）
  const src = fs.readFileSync(MAIN, 'utf8');
  const atData = src.indexOf('"data/journals.js"');
  const atSubs = src.indexOf('"features/search-subs.js"');
  const atSources = src.indexOf('"features/sub-sources.js"');
  ok(atData > 0, '⑦ main.js 加载了期刊目录');
  ok(atSources > 0 && atData < atSources, '⑦ 目录排在 sub-sources.js 之前');
  ok(atSubs > 0 && atData < atSubs, '⑦ 目录排在 search-subs.js 之前（面板首次渲染就要用）');
}

try {
  main();
} catch (e) {
  fails.push('测试执行异常：' + (e && (e.stack || e.message) || e));
}

if (fails.length) {
  console.error('\n✗ 期刊目录测试失败 ' + fails.length + ' 项 / ' + (pass + fails.length) + ' 项断言');
  for (const f of fails) console.error('  - ' + f);
  process.exit(1);
}
console.log('✓ 期刊目录测试通过：' + pass + ' 项断言');
