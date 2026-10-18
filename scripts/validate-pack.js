#!/usr/bin/env node
/* 技能包独立校验器（社区贡献工作流，0.48.3）
 *
 * 用途：
 *   · 贡献者本地自检：node scripts/validate-pack.js community-packs/my-pack.json
 *   · GitHub Actions CI：PR 改动 community-packs/*.json 时自动跑（validate-pack.yml）
 *   · 维护者合并前复核：同一份校验逻辑，三处一致
 *
 * 校验内容 = SkillPacks.validate 的完整规则（id kebab-case / 必填字段 / 三段版本号 /
 * category 枚举 / tags 0-6 / 四内容槽形状）+ 社区包附加规则：
 *   · author 必填非 "PaperPilot"（官方署名保留）——只警告不拦截
 *   · 提示词内 {input} 占位符给出 trigger 建议提醒——只警告
 *   · id 与内置目录 / 已有社区包冲突 → 报错（防覆盖官方包）
 *
 * 退出码：0 = 通过；1 = 有错误（警告不影响退出码）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'chrome/content/scripts/features/skill-packs.js');

/** 与 build-skill-catalog.js 同款的最小沙箱（只借用 validate 与 builtinCatalog） */
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

function checkFile(file) {
  const SP = loadSkillPacks();
  const errors = [];
  const warns = [];
  let pack = null;
  try {
    pack = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.log('✗ %s 不是合法 JSON：%s', file, e.message);
    return false;
  }
  const v = SP.validate(pack);
  if (!v.ok) errors.push(...v.errors.map((s) => '规范校验：' + s));

  if (pack && typeof pack === 'object') {
    // id 冲突检查：不得与内置目录或其它社区包重名
    const ids = new Set(SP.builtinCatalog().map((p) => p.id));
    const myId = String(pack.id || '');
    const myFile = path.basename(file);
    for (const f of fs.readdirSync(path.join(ROOT, 'community-packs'))) {
      if (!f.endsWith('.json') || f.startsWith('_')) continue;
      if (f === myFile) continue;
      try {
        const other = JSON.parse(fs.readFileSync(path.join(ROOT, 'community-packs', f), 'utf8'));
        if (other && other.id) ids.add(other.id);
      } catch (e) { /* 坏文件由各自校验报告 */ }
    }
    if (myId && ids.has(myId)) errors.push('id 冲突：「' + myId + '」已被内置目录或其它社区包占用');
    if (myId && myFile !== '_TEMPLATE.json' && myFile !== myId + '.json') {
      warns.push('建议文件名与 id 一致：' + myId + '.json（当前 ' + myFile + '）');
    }
    if (String(pack.author || '') === 'PaperPilot') {
      warns.push('author 请署你自己的名字（PaperPilot 保留给官方内置包）');
    }
    const prompts = (pack.contents && pack.contents.prompts) || [];
    for (const p of prompts) {
      if (p && String(p.prompt || '').indexOf('{input}') >= 0 && !String(p.trigger || '').trim()) {
        warns.push('prompts[' + p.id + '] 含 {input} 但未配 trigger——建议加触发正则（如 "^关键词"），否则占位符只能靠「先输入再点标签」路径生效');
      }
    }
    if (pack.contents && pack.contents.glossary) {
      warns.push('提示：术语表请使用自编或已获授权的高置信译法，勿搬运版权受限词库（微软术语集/商业词典等）');
    }
  }

  console.log('校验 %s', file);
  for (const w of warns) console.log('  ⚠ %s', w);
  for (const e of errors) console.log('  ✗ %s', e);
  if (!errors.length) {
    console.log('  ✓ 通过（%d 警告）', warns.length);
    return true;
  }
  return false;
}

function main() {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === '--help' || args[0] === '-h') {
    console.log('用法：node scripts/validate-pack.js <pack.json> [more.json ...]');
    console.log('校验技能包 manifest 是否符合 PaperPilot 技能商店规范。');
    process.exit(args.length ? 0 : 1);
  }
  let allOk = true;
  for (const f of args) {
    if (!checkFile(f)) allOk = false;
  }
  process.exit(allOk ? 0 : 1);
}

main();
