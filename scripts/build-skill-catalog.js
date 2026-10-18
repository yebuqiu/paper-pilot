#!/usr/bin/env node
/* 从 skill-packs.js 的 _BUILTIN 生成在线目录 JSON（server/public/skill-catalog.json）
 *
 * 双源同构铁律：在线目录必须与内置目录保持同一份数据——本脚本是**唯一**生成通道，
 * 手改 catalog JSON 会在下次生成时被覆盖（且 test/skill-packs.test.js 的 parity
 * 断言会红）。更新技能包数据 = 改 skill-packs.js 的 _BUILTIN → 跑本脚本 → 提交两个文件。
 *
 * 在线目录格式（SkillPacks.fetchCatalog 契约）：
 *   { version: <目录格式版本>, updatedAt: <ms 时间戳>, packs: [<manifest>...] }
 *
 * 用法：node scripts/build-skill-catalog.js [--check]
 *   --check：不写文件，仅校验现有 catalog 与 _BUILTIN 的 packs 逐字节一致
 *            （updatedAt 除外）——供 preflight / check-wiring 调用
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'chrome/content/scripts/features/skill-packs.js');
const OUT = path.join(ROOT, 'server/public/skill-catalog.json');
const CATALOG_VERSION = 1;

function loadBuiltin() {
  const sandbox = {
    Zotero: {}, Services: {},
    Prefs: { get: () => '', set: () => {} },
    JSON, Date, Math, Set, Map, Promise, isFinite, parseInt, String, Number, Array,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: 'skill-packs.js' });
  const SP = sandbox.SkillPacks;
  if (!SP || typeof SP.builtinCatalog !== 'function') {
    throw new Error('skill-packs.js 未暴露 builtinCatalog');
  }
  const packs = SP.builtinCatalog();
  // 生成侧把关：任何一条非法 manifest 都不允许进目录
  for (const p of packs) {
    const v = SP.validate(p);
    if (!v.ok) throw new Error('内置目录含非法 manifest: ' + p.id + ' → ' + v.errors.join(';'));
  }
  const ids = packs.map((p) => p.id);
  if (new Set(ids).size !== ids.length) throw new Error('内置目录 id 重复');
  return packs;
}

function main() {
  const check = process.argv.includes('--check');
  const packs = loadBuiltin();
  if (check) {
    const cur = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    const a = JSON.stringify(cur.packs);
    const b = JSON.stringify(packs);
    if (a !== b) {
      console.error('✗ catalog 与 _BUILTIN 不一致——请跑 node scripts/build-skill-catalog.js 重新生成');
      process.exit(1);
    }
    console.log('✓ 在线目录与内置目录同构（%d 包）', packs.length);
    return;
  }
  const catalog = { version: CATALOG_VERSION, updatedAt: Date.now(), packs };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
  console.log('已生成 %s（%d 包，updatedAt=%d）', OUT, packs.length, catalog.updatedAt);
}

main();
