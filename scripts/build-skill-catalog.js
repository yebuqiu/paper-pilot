#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 从「内置精选 + 社区包」双源生成在线目录 JSON（server/public/skill-catalog.json）
 *
 * 数据来源（0.48.3 起双源合并）：
 *   ① chrome/content/scripts/features/skill-packs.js 的 _BUILTIN（官方精选，随插件发布）
 *   ② community-packs/*.json（社区贡献，经 PR 审核合并；_ 开头文件与 README 忽略）
 *
 * 双源同构铁律：在线目录只由本脚本生成——手改 catalog JSON 会在下次生成时被覆盖
 * （test/skill-packs.test.js 的 parity 断言与 preflight「技能包目录同构」步骤都会红）。
 * 数据更新流程：
 *   · 官方包：改 skill-packs.js 的 _BUILTIN → 跑本脚本 → 提交两个文件
 *   · 社区包：合并贡献 PR（community-packs/ 多一个 JSON）→ 跑本脚本 → 提交 catalog
 *
 * 在线目录格式（SkillPacks.fetchCatalog 契约）：
 *   { version: <目录格式版本>, updatedAt: <ms 时间戳>, packs: [<manifest>...] }
 *
 * 用法：node scripts/build-skill-catalog.js [--check]
 *   --check：不写文件，仅校验现有 catalog 与双源合并结果一致（updatedAt 除外）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'chrome/content/scripts/features/skill-packs.js');
const COMMUNITY_DIR = path.join(ROOT, 'community-packs');
const OUT = path.join(ROOT, 'server/public/skill-catalog.json');
const CATALOG_VERSION = 1;

function loadSkillPacks() {
  const sandbox = {
    Zotero: {}, Services: {},
    Prefs: { get: () => '', set: () => {} },
    JSON, Date, Math, Set, Map, Promise, isFinite, parseInt, String, Number, Array,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: 'skill-packs.js' });
  return sandbox.SkillPacks;
}

/** 社区包目录：community-packs/*.json（_ 开头与 README 忽略），返回 [manifest] */
function loadCommunityPacks(SP, errors) {
  const out = [];
  if (!fs.existsSync(COMMUNITY_DIR)) return out;
  for (const f of fs.readdirSync(COMMUNITY_DIR).sort()) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    const fp = path.join(COMMUNITY_DIR, f);
    try {
      const pack = JSON.parse(fs.readFileSync(fp, 'utf8'));
      const v = SP.validate(pack);
      if (!v.ok) {
        errors.push('社区包 ' + f + ' 校验失败：' + v.errors.join('；'));
        continue;
      }
      out.push(pack);
    } catch (e) {
      errors.push('社区包 ' + f + ' 不是合法 JSON：' + e.message);
    }
  }
  return out;
}

function main() {
  const check = process.argv.includes('--check');
  const SP = loadSkillPacks();
  const builtin = SP.builtinCatalog();
  const errors = [];

  // 生成侧把关：任何一条非法 manifest 都不允许进目录
  for (const p of builtin) {
    const v = SP.validate(p);
    if (!v.ok) errors.push('内置目录 ' + p.id + '：' + v.errors.join(';'));
  }
  const community = loadCommunityPacks(SP, errors);
  if (errors.length) {
    console.error('✗ 存在非法技能包，拒绝生成：');
    for (const e of errors) console.error('  - ' + e);
    process.exit(1);
  }

  // id 全局查重（官方 + 社区之间）
  const all = builtin.concat(community);
  const ids = all.map((p) => p.id);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length) {
    console.error('✗ id 重复（官方/社区之间冲突）：' + dup.join(', '));
    process.exit(1);
  }

  // 排序：官方包按原序在前，社区包按名称排序在后
  const packs = builtin.concat(
    community.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'))
  );

  if (check) {
    const cur = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    if (JSON.stringify(cur.packs) !== JSON.stringify(packs)) {
      console.error('✗ catalog 与「内置 + 社区」双源不一致——请跑 node scripts/build-skill-catalog.js 重新生成');
      process.exit(1);
    }
    console.log('✓ 在线目录与双源合并结果同构（官方 %d + 社区 %d = %d 包）',
      builtin.length, community.length, packs.length);
    return;
  }
  const catalog = { version: CATALOG_VERSION, updatedAt: Date.now(), packs };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
  console.log('已生成 %s（官方 %d + 社区 %d = %d 包）',
    OUT, builtin.length, community.length, packs.length);
}

main();
