#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* AI 技能包商店（SkillPacks）核心域模块测试
 *
 * 覆盖：validate 全字段/缺必填/坏 id/坏版本/坏 category/glossary 混合形态、
 * builtinCatalog 合法性与 id 唯一、install（sp: 前缀/记账/术语行级去重/幂等覆盖更新/
 * CommandTags 缺位降级/TranslateSvc.mergeGlossary 路径）、uninstall 按记账精确回滚
 * （术语只删记账份数、用户模板幸存）、compareVersion、searchPacks、rate 钳制、
 * applyAgentPreset（键写入 + systemPrompt 追加去重）、buildManifest、exportPack 往返、
 * fetchCatalog 回退链。
 *
 * 运行：node test/skill-packs.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FILES = ['chrome/content/scripts/features/skill-packs.js'];

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  <- ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

/* ---------------- 桩环境（方法一律普通函数，防 this 丢失） ---------------- */

const PrefStore = new Map();
const PP = 'extensions.zotero.papilot.'; // Prefs 封装的真实前缀

// fetchCatalog 桩行为开关
let HTTPBehavior = 'ok';   // 'ok' | 'throw'
let HTTPBody = '';

const Zotero = {
  Prefs: {
    get: function (k) { return PrefStore.has(k) ? PrefStore.get(k) : undefined; },
    set: function (k, v) { PrefStore.set(k, v); },
  },
  HTTP: {
    request: function (method, url, opts) {
      ZoteroHTTPCalls.push({ method, url, opts });
      if (HTTPBehavior === 'throw') return Promise.reject(new Error('network down'));
      return Promise.resolve({ responseText: HTTPBody });
    },
  },
  logError: function () {},
};
const ZoteroHTTPCalls = [];

const Prefs = {
  PREFIX: PP,
  get: function (key, fallback) {
    const k = this.PREFIX + key;
    const v = PrefStore.has(k) ? PrefStore.get(k) : undefined;
    return v === undefined || v === null ? fallback : v;
  },
  set: function (key, value) { PrefStore.set(this.PREFIX + key, value); },
};

function makeCommandTags() {
  return {
    tags: [],
    calls: [],
    upsert: function (tag) {
      this.calls.push(['upsert', tag && tag.id]);
      const n = {
        id: String((tag && tag.id) || ''),
        label: String((tag && tag.label) || ''),
        prompt: String((tag && tag.prompt) || ''),
        color: String((tag && tag.color) || ''),
        trigger: String((tag && tag.trigger) || ''),
      };
      if (!n.id || !(n.label || n.prompt)) return null;
      const i = this.tags.findIndex(function (t) { return t.id === n.id; });
      if (i >= 0) this.tags[i] = n; else this.tags.push(n);
      return n;
    },
    remove: function (id) {
      this.calls.push(['remove', id]);
      const before = this.tags.length;
      this.tags = this.tags.filter(function (t) { return t.id !== id; });
      return this.tags.length < before;
    },
  };
}

function makeNoteTemplates() {
  return {
    list: [],
    calls: [],
    customList: function () { return this.list.map(function (t) { return { name: t.name, body: t.body }; }); },
    saveCustom: function (list) {
      this.calls.push(['save', (list || []).length]);
      this.list = (list || []).filter(function (t) { return t && t.name && t.body; })
        .map(function (t) { return { name: t.name, body: t.body }; });
      return this.list.length;
    },
  };
}

const sandbox = {
  console, Zotero, Prefs,
  JSON, Date, Math, Set, Map, Promise, Object, Array, String, Number, Boolean, Error, RegExp,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of FILES) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
}
const SP = sandbox.SkillPacks;

const CT = makeCommandTags();
const NT = makeNoteTemplates();
sandbox.CommandTags = CT;
sandbox.NoteTemplates = NT;
// TranslateSvc 故意不提供：install 走兜底合并器；mergeGlossary 路径单独注入桩再测。

const TSVCalls = [];

/* ---------------- 测试数据 ---------------- */

const M1 = {
  id: 'test-pack',
  name: '测试包',
  version: '1.0.0',
  author: 'tester',
  desc: '用于测试的技能包',
  category: '写作',
  tags: ['测试'],
  contents: {
    prompts: [
      { id: 'p1', label: '提示一', prompt: '提示词一', color: '', trigger: '' },
      { id: 'p2', label: '提示二', prompt: '提示词二', color: '#111111', trigger: '^/t' },
    ],
    glossary: [
      'foo = bar',                         // 无领域 → 归一为 "| 通用"
      { s: 'baz', t: '巴兹', d: '医学' },  // 对象 → 行式
      'foo = bar',                         // 包内重复 → 合并时去重
    ],
    noteTemplates: [
      { name: '周报模板', body: '## {{title}}\n\n要点' },
    ],
    agentPreset: {
      chatAgentMode: true,
      aiAgentTools: 'search_library',
      aiAgentMaxSteps: 8,
      aiAgentConfirmWrite: true,
      systemPrompt: '专项指令：回答时先给结论。',
    },
  },
};

/* ---------------- 主流程 ---------------- */

async function main() {
  /* ================ ① validate ================ */

  const v1 = SP.validate(M1);
  eq(v1.ok, true, 'validate: 合法全字段 ok');
  eq(v1.errors.length, 0, 'validate: 合法全字段无错误');

  const vName = SP.validate(Object.assign({}, M1, { name: '' }));
  eq(vName.ok, false, 'validate: 缺 name 不通过');
  ok(vName.errors.join(';').indexOf('name') >= 0, 'validate: 缺 name 报 name 错误');

  const vId = SP.validate(Object.assign({}, M1, { id: 'Bad_ID' }));
  eq(vId.ok, false, 'validate: 坏 id 不通过');
  ok(vId.errors.join(';').indexOf('id') >= 0, 'validate: 坏 id 报格式错误');

  eq(SP.validate(Object.assign({}, M1, { version: '1.2' })).ok, false, 'validate: 坏版本（两段）不通过');
  eq(SP.validate(Object.assign({}, M1, { version: 'abc' })).ok, false, 'validate: 坏版本（非数字）不通过');
  eq(SP.validate(Object.assign({}, M1, { category: '魔法' })).ok, false, 'validate: 坏 category 不通过');

  const vMix = SP.validate(Object.assign({}, M1, {
    contents: { glossary: ['a = b', { s: 'c', t: 'd', d: '医学' }] },
  }));
  eq(vMix.ok, true, 'validate: glossary 行式与对象混合合法');

  eq(SP.validate(Object.assign({}, M1, {
    contents: { glossary: ['a = b', { s: '', t: 'd' }] },
  })).ok, false, 'validate: glossary 空对象条目不通过');
  eq(SP.validate(Object.assign({}, M1, {
    contents: { prompts: [{ label: '无id', prompt: 'P' }] },
  })).ok, false, 'validate: prompts 缺 id 不通过');
  eq(SP.validate(Object.assign({}, M1, {
    contents: { noteTemplates: [{ name: '有名字无正文' }] },
  })).ok, false, 'validate: noteTemplates 缺 body 不通过');
  eq(SP.validate(Object.assign({}, M1, { tags: ['1', '2', '3', '4', '5', '6', '7'] })).ok, false, 'validate: tags 超 6 个不通过');

  eq(SP.validate(Object.assign({}, M1, { extraField: 'x', surprise: 1 },
    { contents: Object.assign({}, M1.contents, { unknownSlot: 42 }) })).ok, true,
    'validate: 未知字段宽容忽略');

  /* ================ ② builtinCatalog ================ */

  const cat = SP.builtinCatalog();
  eq(cat.length, 45, 'builtinCatalog: 45 个内置包（8 类 5-6 个，0.48.1 后续扩容）');
  ok(cat.every(function (p) { return SP.validate(p).ok; }), 'builtinCatalog: 每包 validate ok');
  const ids = cat.map(function (p) { return p.id; });
  eq(new Set(ids).size, 45, 'builtinCatalog: id 全局唯一');
  ok(cat.every(function (p) { return SP.CATEGORIES.indexOf(p.category) >= 0; }),
    'builtinCatalog: category 均在枚举内');
  // 0.48.1：全分类覆盖（每类 3-5 个，在线/内置双源一致的底线）
  const byCat = {};
  for (const p of cat) byCat[p.category] = (byCat[p.category] || 0) + 1;
  eq(Object.keys(byCat).length, 8, 'builtinCatalog: 8 个分类全覆盖');
  ok(SP.CATEGORIES.every(function (c) { return byCat[c] >= 4 && byCat[c] <= 6; }),
    'builtinCatalog: 每类 4-6 个 → 实际 ' + JSON.stringify(byCat));
  // 0.48.1：在线目录文件与内置目录同构（唯一生成通道 = build-skill-catalog.js）
  const catPath = path.join(ROOT, 'server', 'public', 'skill-catalog.json');
  ok(fs.existsSync(catPath), 'online catalog: server/public/skill-catalog.json 在库');
  if (fs.existsSync(catPath)) {
    const online = JSON.parse(fs.readFileSync(catPath, 'utf8'));
    ok(online && Array.isArray(online.packs), 'online catalog: {version, updatedAt, packs} 结构');
    ok(online.packs.length >= cat.length,
      'online catalog: 包数 >= 内置数（官方 45 + 社区 N）→ 实际 ' + online.packs.length);
    ok(online.packs.every(function (p) { return SP.validate(p).ok; }),
      'online catalog: 每包过 validate（含社区包）');
    // 0.48.3 双源语义：官方包按原序排在目录前缀，社区包跟在后面（build-skill-catalog 排序契约）
    eq(JSON.stringify(online.packs.slice(0, cat.length)), JSON.stringify(cat),
      'online catalog: 官方包前缀与 _BUILTIN 逐字节同构（漂移 = 忘跑 build-skill-catalog.js）');
    const fsC = require('fs'), pathC = require('path');
    const cpDir = pathC.join(ROOT, 'community-packs');
    let cpN = 0;
    try {
      cpN = fsC.readdirSync(cpDir).filter(function (f) {
        return f.endsWith('.json') && !f.startsWith('_');
      }).length;
    } catch (e) { cpN = 0; }
    eq(online.packs.length, cat.length + cpN,
      'online catalog: 总数 = 官方 ' + cat.length + ' + 社区 ' + cpN);
    ok(online.updatedAt && Number(online.updatedAt) > 0, 'online catalog: updatedAt 存在');
  }

  /* ================ ③ compareVersion ================ */

  eq(SP.compareVersion('1.2.0', '1.10.0'), -1, 'compareVersion: 1.2.0 < 1.10.0（数值逐段）');
  eq(SP.compareVersion('1.10.0', '1.2.0'), 1, 'compareVersion: 1.10.0 > 1.2.0');
  eq(SP.compareVersion('1.0.0', '1.0.0'), 0, 'compareVersion: 相等返回 0');
  eq(SP.compareVersion('garbage', '0.0.0'), 0, 'compareVersion: 坏值当 0.0.0');
  eq(SP.compareVersion('1.0.0', '1.0.1'), -1, 'compareVersion: 补丁位差异');

  /* ================ ④ searchPacks ================ */

  const hitSurvey = SP.searchPacks(cat, { query: '综述' });
  ok(hitSurvey.some(function (p) { return p.id === 'survey-writer'; }), 'searchPacks: query 命中 name');
  const hitTag = SP.searchPacks(cat, { query: 'pico' });
  eq(hitTag.length, 1, 'searchPacks: query 大小写不敏感命中 tag');
  eq(hitTag[0].id, 'medical-reader', 'searchPacks: pico → medical-reader');

  const custom = [
    { id: 'a', name: '甲', desc: 'x', author: '张三', category: '写作', tags: [] },
    { id: 'b', name: '乙', desc: 'x', author: '李四', category: '审稿', tags: [] },
  ];
  eq(SP.searchPacks(custom, { query: '张三' }).length, 1, 'searchPacks: query 命中 author');
  eq(SP.searchPacks(cat, { category: '翻译' }).length, 6, 'searchPacks: category 精确过滤（翻译 6 包）');
  eq(SP.searchPacks(cat, { tag: '精读' })[0].id, 'deep-reading', 'searchPacks: tag 精确过滤');
  eq(SP.searchPacks(cat, { installedIds: new Set(['weekly-report']) }).length, 1,
    'searchPacks: installedIds 只留已装');
  eq(SP.searchPacks(cat, { installedIds: new Set(['weekly-report']) })[0].id, 'weekly-report',
    'searchPacks: installedIds 命中正确包');
  // ★ 0.48.4 契约加固：空 Set 是 truthy 且有 .has——「给定时只留已装」意味着
  //   空 Set 滤光全部。调用方（skill-store.js renderList）必须只在需要过滤时才传。
  eq(SP.searchPacks(cat, { installedIds: new Set() }).length, 0,
    'searchPacks: 空 Set = 滤光全部（契约语义，调用方不得无条件传参）');
  eq(SP.searchPacks(cat, { installedIds: undefined }).length, cat.length,
    'searchPacks: installedIds 为 undefined 时不过滤');

  /* ================ ⑤ rate / getRating / clearRating ================ */

  eq(SP.rate('survey-writer', 0, '太差').ok, true, 'rate: 返回 ok');
  eq(SP.getRating('survey-writer').stars, 1, 'rate: 0 分钳制到 1');
  SP.rate('survey-writer', 9, '');
  eq(SP.getRating('survey-writer').stars, 5, 'rate: 9 分钳制到 5');
  SP.rate('survey-writer', 4.4, '');
  eq(SP.getRating('survey-writer').stars, 4, 'rate: 4.4 取整到 4');
  SP.rate('survey-writer', 5, new Array(600).join('长'));
  eq(SP.getRating('survey-writer').comment.length, 500, 'rate: comment 截断 500 字');
  ok(SP.getRating('survey-writer').at > 0, 'getRating: 带时间戳 at');
  eq(SP.getRating('ghost-pack'), null, 'getRating: 未评分返回 null');
  SP.clearRating('survey-writer');
  eq(SP.getRating('survey-writer'), null, 'clearRating: 清除后返回 null');

  /* ================ ⑥ buildManifest ================ */

  const bm1 = SP.buildManifest({
    name: 'My Cool Pack', author: 'a', desc: 'd', category: '写作',
    prompts: [{ id: 'x', label: 'L', prompt: 'P' }],
  });
  eq(bm1.ok, true, 'buildManifest: 基本产出 ok');
  eq(bm1.manifest.id, 'my-cool-pack', 'buildManifest: id 由 name slug 化');
  eq(bm1.manifest.version, '1.0.0', 'buildManifest: version 缺省 1.0.0');
  eq(SP.validate(bm1.manifest).ok, true, 'buildManifest: 产出过 validate');

  const bm2 = SP.buildManifest({ name: '深度研读', author: 'a', desc: 'd', category: '阅读' });
  ok(bm2.ok && bm2.manifest.id.indexOf('pack-') === 0, 'buildManifest: 中文名 slug 为空回退 pack-<ts>');

  const bm3 = SP.buildManifest({ id: 'explicit-id', name: 'N', author: 'a', desc: 'd', category: '写作' });
  eq(bm3.manifest.id, 'explicit-id', 'buildManifest: 显式 id 保留');

  eq(SP.buildManifest({ author: 'a', desc: 'd', category: '写作' }).ok, false, 'buildManifest: 缺 name 报错');

  /* ================ ⑦ install / uninstall 全链路 ================ */

  // 初始术语表：一条注释 + 一条用户术语
  PrefStore.set(PP + 'translateGlossary', '# 我的术语表\nalpha = 阿尔法\n');

  // --- G1: 安装 M1（全内容） ---
  const r1 = await SP.install(M1);
  eq(r1.ok, true, 'install: ok');
  eq(r1.applied.prompts, 2, 'install: 2 个提示词');
  eq(r1.applied.glossary, 2, 'install: 术语 2 行（包内重复行去重）');
  eq(r1.applied.templates, 1, 'install: 1 个模板');
  eq(r1.applied.agentPreset, true, 'install: agentPreset 标记 true（不自动应用）');

  ok(CT.tags.some(function (t) { return t.id === 'sp:test-pack:p1'; }), 'install: prompt id 前缀 sp:<packId>:');
  const spTag1 = CT.tags.find(function (t) { return t.id === 'sp:test-pack:p1'; });
  eq(spTag1.color, SP._PALETTE[0], 'install: color 缺省用调色板轮转');
  const spTag2 = CT.tags.find(function (t) { return t.id === 'sp:test-pack:p2'; });
  eq(spTag2.color, '#111111', 'install: 显式 color 保留');
  eq(spTag2.trigger, '^/t', 'install: trigger 保留');

  // 记账写入
  const ledgerRaw1 = JSON.parse(PrefStore.get(PP + 'skillPacksInstalled'));
  ok(!!ledgerRaw1['test-pack'], 'install: 记账写入 pref');
  eq(ledgerRaw1['test-pack'].version, '1.0.0', 'install: 记账含 version');
  ok(ledgerRaw1['test-pack'].at > 0, 'install: 记账含 at 时间戳');
  eq(ledgerRaw1['test-pack'].applied.promptIds.length, 2, 'install: 记账 promptIds');
  eq(ledgerRaw1['test-pack'].applied.glossaryLines.length, 2, 'install: 记账 glossaryLines（只记实际追加）');
  eq(ledgerRaw1['test-pack'].applied.templateNames[0], '周报模板', 'install: 记账 templateNames');

  // 术语表合并：注释与用户行原位保留，新行归一追加
  const gloss1 = String(PrefStore.get(PP + 'translateGlossary'));
  ok(gloss1.indexOf('# 我的术语表') === 0, 'install: 注释行原位保留');
  ok(gloss1.indexOf('alpha = 阿尔法') >= 0, 'install: 用户已有术语行保留');
  ok(gloss1.indexOf('foo = bar | 通用') >= 0, 'install: 无领域行归一加「| 通用」');
  ok(gloss1.indexOf('baz = 巴兹 | 医学') >= 0, 'install: {s,t,d} 对象转行式');

  // 模板：只新增，不动别的东西
  eq(NT.list.length, 1, 'install: 模板写入 NoteTemplates');

  // --- G2: applyAgentPreset（M1 已装） ---
  PrefStore.delete(PP + 'aiSystemPrompt');
  const ap1 = SP.applyAgentPreset('test-pack');
  eq(ap1.ok, true, 'applyAgentPreset: ok');
  eq(ap1.applied.length, 5, 'applyAgentPreset: 应用全部 5 键');
  eq(PrefStore.get(PP + 'chatAgentMode'), true, 'applyAgentPreset: chatAgentMode 写入');
  eq(PrefStore.get(PP + 'aiAgentTools'), 'search_library', 'applyAgentPreset: aiAgentTools 写入');
  eq(PrefStore.get(PP + 'aiAgentMaxSteps'), 8, 'applyAgentPreset: aiAgentMaxSteps 写入');
  eq(PrefStore.get(PP + 'aiAgentConfirmWrite'), true, 'applyAgentPreset: aiAgentConfirmWrite 写入');
  eq(PrefStore.get(PP + 'aiSystemPrompt'), '专项指令：回答时先给结论。', 'applyAgentPreset: systemPrompt 首次写入');
  const ap2 = SP.applyAgentPreset('test-pack');
  eq(ap2.ok, true, 'applyAgentPreset: 二次应用仍 ok');
  ok(ap2.applied.indexOf('systemPrompt') < 0, 'applyAgentPreset: 已包含则跳过（去重）');
  eq(PrefStore.get(PP + 'aiSystemPrompt'), '专项指令：回答时先给结论。', 'applyAgentPreset: systemPrompt 不重复追加');

  // --- G3: exportPack 往返 ---
  const exported = SP.exportPack('test-pack');
  const ex = JSON.parse(exported);
  eq(ex.id, 'test-pack', 'exportPack: id 往返一致');
  eq(ex.name, '测试包', 'exportPack: name 往返一致');
  eq(ex.version, '1.0.0', 'exportPack: version 往返一致');
  eq(ex.contents.prompts.length, M1.contents.prompts.length, 'exportPack: prompts 往返一致');
  eq(ex.contents.glossary.length, M1.contents.glossary.length, 'exportPack: glossary 往返一致');
  eq(SP.exportPack('ghost-pack'), '', 'exportPack: 未安装返回空串');

  // --- G4: 幂等重装（先回滚旧内容再装新） ---
  CT.calls.length = 0;
  const r4 = await SP.install(M1);
  eq(r4.ok, true, 'install: 重装 ok');
  eq(r4.applied.prompts, 2, 'install: 重装提示词数一致');
  eq(r4.applied.glossary, 2, 'install: 重装术语先删后加（回滚+重追加）');
  const calls4 = CT.calls.map(function (c) { return c[0]; });
  ok(calls4.indexOf('remove') >= 0 && calls4.indexOf('remove') < calls4.indexOf('upsert'),
    'install: 重装先 remove 旧 promptIds 再 upsert');
  const gloss4 = String(PrefStore.get(PP + 'translateGlossary'));
  eq(gloss4.split('foo = bar | 通用').length - 1, 1, 'install: 重装后无重复术语行');
  eq(CT.tags.filter(function (t) { return t.id.indexOf('sp:test-pack:') === 0; }).length, 2,
    'install: 重装后 sp: 标签不翻倍');

  // --- G5: 术语行级去重（已存在的行不二次追加） ---
  const r5 = await SP.install({
    id: 'dup-pack', name: '去重包', version: '1.0.0', author: 't', desc: 'd', category: '翻译',
    contents: { glossary: ['foo = bar | 通用', { s: 'qux', t: '奎克斯' }] },
  });
  eq(r5.ok, true, 'install: 去重包 ok');
  eq(r5.applied.glossary, 1, 'install: 已存在行跳过，只追加新行');
  const u5 = await SP.uninstall('dup-pack');
  eq(u5.ok, true, 'uninstall: 去重包回滚 ok');
  eq(u5.removed.glossary, 1, 'uninstall: 只删记账的 1 行');
  ok(String(PrefStore.get(PP + 'translateGlossary')).indexOf('foo = bar | 通用') >= 0,
    'uninstall: 用户/他包的同名行幸存');

  // --- G6: 覆盖更新（内容变化，旧内容按记账回滚） ---
  const M2 = {
    id: 'test-pack', name: '测试包', version: '1.1.0', author: 'tester',
    desc: '更新版', category: '写作',
    contents: { prompts: [{ id: 'p2', label: '提示二改', prompt: '新提示词', color: '', trigger: '' }] },
  };
  const r6 = await SP.install(M2);
  eq(r6.ok, true, 'install: 覆盖更新 ok');
  eq(r6.applied.agentPreset, false, 'install: 新版无 preset 则 false');
  ok(!CT.tags.some(function (t) { return t.id === 'sp:test-pack:p1'; }), 'install: 覆盖更新移除旧 prompt');
  eq((CT.tags.find(function (t) { return t.id === 'sp:test-pack:p2'; }) || {}).label, '提示二改',
    'install: 覆盖更新写入新 prompt');
  const gloss6 = String(PrefStore.get(PP + 'translateGlossary'));
  ok(gloss6.indexOf('foo = bar | 通用') < 0 && gloss6.indexOf('baz = 巴兹 | 医学') < 0,
    'install: 覆盖更新回滚旧术语行');
  ok(gloss6.indexOf('alpha = 阿尔法') >= 0, 'install: 覆盖更新不动用户术语');
  ok(!NT.list.some(function (t) { return t.name === '周报模板'; }), 'install: 覆盖更新回滚旧模板');
  eq(SP.isInstalled('test-pack').version, '1.1.0', 'install: 记账版本更新');

  // --- G7: uninstall 主流程 ---
  const u7 = await SP.uninstall('test-pack');
  eq(u7.ok, true, 'uninstall: ok');
  eq(u7.removed.prompts, 1, 'uninstall: 删除记账数量的标签');
  eq(CT.tags.filter(function (t) { return t.id.indexOf('sp:test-pack:') === 0; }).length, 0,
    'uninstall: sp: 标签全部移除');
  eq(SP.isInstalled('test-pack').installed, false, 'uninstall: 记账清除');
  eq(SP.listInstalled().some(function (x) { return x.id === 'test-pack'; }), false,
    'uninstall: listInstalled 不再包含');

  // --- G8: 用户模板幸存 ---
  NT.list = [{ name: '用户自有', body: '保住我' }];
  const r8 = await SP.install({
    id: 'tpl-pack', name: '模板包', version: '1.0.0', author: 't', desc: 'd', category: '模板',
    contents: { noteTemplates: [{ name: '临时模板', body: 'X' }] },
  });
  eq(r8.applied.templates, 1, 'install: 模板包装入');
  eq(NT.list.length, 2, 'install: 增量不删用户模板');
  const u8 = await SP.uninstall('tpl-pack');
  eq(u8.removed.templates, 1, 'uninstall: 删除记账数量的模板');
  eq(NT.list.length, 1, 'uninstall: 用户自有模板幸存');
  eq(NT.list[0].name, '用户自有', 'uninstall: 幸存的是用户模板');

  // --- G9: CommandTags 缺位 → 记 0 不报错 ---
  sandbox.CommandTags = undefined;
  const r9 = await SP.install({
    id: 'no-ct-pack', name: '无标签模块包', version: '1.0.0', author: 't', desc: 'd', category: '写作',
    contents: { prompts: [{ id: 'a', label: 'A', prompt: 'P' }] },
  });
  eq(r9.ok, true, 'install: CommandTags 缺位仍 ok');
  eq(r9.applied.prompts, 0, 'install: CommandTags 缺位记 0');
  sandbox.CommandTags = CT;
  const u9 = await SP.uninstall('no-ct-pack');
  eq(u9.ok && u9.removed.prompts, 0, 'uninstall: 无记账标签回滚 0');

  // --- G10: 用户手动复制术语多份 → 只删记账份数 ---
  await SP.install({
    id: 'copy-pack', name: '复制包', version: '1.0.0', author: 't', desc: 'd', category: '翻译',
    contents: { glossary: ['dup = 都普'] },
  });
  // 用户手动再复制一份（pref 中同线两份）
  PrefStore.set(PP + 'translateGlossary',
    String(PrefStore.get(PP + 'translateGlossary')) + '\ndup = 都普 | 通用');
  const u10 = await SP.uninstall('copy-pack');
  eq(u10.removed.glossary, 1, 'uninstall: 只删记账 1 份');
  const gloss10 = String(PrefStore.get(PP + 'translateGlossary'));
  eq(gloss10.split('dup = 都普 | 通用').length - 1, 1, 'uninstall: 用户复制的份数幸存');

  // --- G11: 未安装 / 非法 manifest ---
  const u11 = await SP.uninstall('ghost-pack');
  eq(u11.ok, false, 'uninstall: 未安装返回 not ok');
  eq(u11.error, '未安装', 'uninstall: 错误文案「未安装」');
  const r11 = await SP.install({ id: 'bad', name: '', version: 'x' });
  eq(r11.ok, false, 'install: 非法 manifest 拒绝');
  ok(!!r11.error, 'install: 非法 manifest 带错误说明');

  // --- G12: TranslateSvc.mergeGlossary 存在时优先走它 ---
  sandbox.TranslateSvc = {
    mergeGlossary: function (lines) { TSVCalls.push(lines.slice()); return { ok: true }; },
  };
  const r12 = await SP.install({
    id: 'tsvc-pack', name: '术语服务包', version: '1.0.0', author: 't', desc: 'd', category: '翻译',
    contents: { glossary: ['aa = 甲', 'bb = 乙'] },
  });
  eq(r12.ok, true, 'install: TranslateSvc 路径 ok');
  eq(r12.applied.glossary, 2, 'install: TranslateSvc 路径计入行数');
  eq(TSVCalls.length, 1, 'install: mergeGlossary 被调用一次');
  eq(TSVCalls[0][0], 'aa = 甲 | 通用', 'install: mergeGlossary 收到归一化行');
  ok(String(PrefStore.get(PP + 'translateGlossary')).indexOf('aa = 甲') < 0,
    'install: TranslateSvc 路径不直写 pref（交给术语服务）');
  const u12 = await SP.uninstall('tsvc-pack');
  eq(u12.ok, true, 'uninstall: TranslateSvc 路径回滚 ok（尽力而为）');
  delete sandbox.TranslateSvc;

  // --- G12b: 用户术语表已有同原文 → 兜底路径剔除该行（不覆盖用户译法） ---
  PrefStore.set(PP + 'translateGlossary',
    'transformer = 变压器 | 通用\npretrained = 预训练\n');
  const r12b = await SP.install({
    id: 'conflict-pack', name: '冲突包', version: '1.0.0', author: 't', desc: 'd', category: '翻译',
    contents: { glossary: ['transformer = Transformer | 计算机', 'brand-new = 全新术语'] },
  });
  eq(r12b.ok, true, 'install: 同原文冲突包 ok');
  eq(r12b.applied.glossary, 1, 'install: 同原文行被剔除，只装 1 条全新行');
  const gl12b = String(PrefStore.get(PP + 'translateGlossary'));
  ok(gl12b.indexOf('transformer = 变压器 | 通用') >= 0, 'install: 用户原译文行原样保留');
  ok(gl12b.indexOf('transformer = Transformer') < 0, 'install: 包内同原文行未写入（不覆盖用户译法）');
  ok(gl12b.indexOf('brand-new = 全新术语 | 通用') >= 0, 'install: 全新行正常追加');
  const u12b = await SP.uninstall('conflict-pack');
  eq(u12b.ok, true, 'uninstall: 冲突包回滚 ok');
  const gl12c = String(PrefStore.get(PP + 'translateGlossary'));
  ok(gl12c.indexOf('transformer = 变压器 | 通用') >= 0,
    'uninstall: 冲突包卸载后用户原译文行仍在（数据安全）');
  ok(gl12c.indexOf('brand-new') < 0, 'uninstall: 净新增行被正确移除');
  ok(gl12c.indexOf('pretrained = 预训练') >= 0, 'uninstall: 无关用户行不受影响');

  // --- G12c: 用户术语表已有同原文 → TranslateSvc.mergeGlossary 路径同样剔除 ---
  TSVCalls.length = 0; // 清掉 G12 的调用记录，本用例独立断言
  sandbox.TranslateSvc = {
    mergeGlossary: function (lines) { TSVCalls.push(lines.slice()); return { ok: true }; },
  };
  const r12d = await SP.install({
    id: 'tsvc-conflict', name: '服务冲突包', version: '1.0.0', author: 't', desc: 'd', category: '翻译',
    contents: { glossary: ['pretrained = Pre-trained | 计算机', 'extra-term = 附加术语'] },
  });
  eq(r12d.ok, true, 'install: TranslateSvc 冲突路径 ok');
  eq(r12d.applied.glossary, 1, 'install: 同原文（pretrained）被剔除，只装 1 条');
  eq(TSVCalls.length, 1, 'install: mergeGlossary 调用一次');
  ok(TSVCalls[0].some((l) => l.indexOf('pretrained') >= 0) === false,
    'install: mergeGlossary 收到的行不含用户已有原文（防服务端覆盖用户译法）');
  ok(TSVCalls[0].some((l) => l.indexOf('extra-term') >= 0),
    'install: mergeGlossary 收到全新行');
  await SP.uninstall('tsvc-conflict');
  delete sandbox.TranslateSvc;
  ok(String(PrefStore.get(PP + 'translateGlossary')).indexOf('pretrained = 预训练') >= 0,
    'uninstall: 用户原有 pretrained 行在两条路径后都幸存');

  // --- G13: applyAgentPreset 错误分支 ---
  const ap13a = SP.applyAgentPreset('ghost-pack');
  eq(ap13a.ok, false, 'applyAgentPreset: 未安装报错');
  await SP.install({
    id: 'plain-pack', name: '无预设包', version: '1.0.0', author: 't', desc: 'd', category: '写作',
    contents: { prompts: [] },
  });
  eq(SP.applyAgentPreset('plain-pack').ok, false, 'applyAgentPreset: 无 preset 报错');
  await SP.uninstall('plain-pack');

  // --- G14: listInstalled 元信息 ---
  await SP.install(M2);
  const li = SP.listInstalled();
  eq(li.length, 1, 'listInstalled: 返回已装包');
  eq(li[0].name, '测试包', 'listInstalled: 带 manifest 元信息 name');
  eq(li[0].category, '写作', 'listInstalled: 带 manifest 元信息 category');
  ok(li[0].installedAt > 0, 'listInstalled: 带 installedAt');
  await SP.uninstall('test-pack');

  /* ================ ⑧ fetchCatalog 回退链 ================ */

  // pref 源为空 → builtin
  PrefStore.delete(PP + 'skillStoreSource');
  const f1 = await SP.fetchCatalog();
  eq(f1.source, 'builtin', 'fetchCatalog: 源为空回退 builtin');
  eq(f1.packs.length, 45, 'fetchCatalog: builtin 45 包');
  eq(f1.updatedAt, '', 'fetchCatalog: builtin updatedAt 为空');

  // 坏 JSON → builtin
  PrefStore.set(PP + 'skillStoreSource', 'https://example.com/catalog.json');
  HTTPBehavior = 'ok'; HTTPBody = 'not json at all';
  const f2 = await SP.fetchCatalog();
  eq(f2.source, 'builtin', 'fetchCatalog: 坏 JSON 回退 builtin');

  // 请求抛错 → builtin
  HTTPBehavior = 'throw';
  const f3 = await SP.fetchCatalog();
  eq(f3.source, 'builtin', 'fetchCatalog: 请求失败回退 builtin');
  HTTPBehavior = 'ok';

  // 结构不对（无 packs 数组）→ builtin
  HTTPBody = JSON.stringify({ version: 1, updatedAt: 'x' });
  const f3b = await SP.fetchCatalog();
  eq(f3b.source, 'builtin', 'fetchCatalog: 远端缺 packs 数组回退 builtin');

  // 正常远端：非法条目跳过，不整批失败
  const remotePack = {
    id: 'remote-pack', name: '远端包', version: '2.0.0', author: 'remote',
    desc: '远端目录里的包', category: '写作',
    contents: { prompts: [{ id: 'rp', label: '远端', prompt: 'P', color: '', trigger: '' }] },
  };
  HTTPBody = JSON.stringify({
    version: 1, updatedAt: '2026-10-01T00:00:00Z',
    packs: [remotePack, { id: 'bad-pack', name: '', version: 'x', author: '', desc: '', category: '魔法' }],
  });
  const f4 = await SP.fetchCatalog();
  eq(f4.source, 'remote', 'fetchCatalog: 正常远端 source=remote');
  eq(f4.packs.length, 1, 'fetchCatalog: 非法条目被跳过');
  eq(f4.packs[0].id, 'remote-pack', 'fetchCatalog: 合法远端包保留');
  eq(f4.updatedAt, '2026-10-01T00:00:00Z', 'fetchCatalog: updatedAt 透传');

  // 请求参数：GET + 15s 超时（f1 源为空不发请求，共 4 次：坏 JSON/抛错/缺 packs/正常）
  eq(ZoteroHTTPCalls.length, 4, 'fetchCatalog: 共发起 4 次请求');
  eq(ZoteroHTTPCalls[3].method, 'GET', 'fetchCatalog: GET 方法');
  eq(ZoteroHTTPCalls[3].opts.timeout, 15000, 'fetchCatalog: 15s 超时');

  /* ================ ⑨ 记账 pref 坏值容错 ================ */

  PrefStore.set(PP + 'skillPacksInstalled', '###not json###');
  eq(SP.listInstalled().length, 0, '记账 pref 坏值容错为空');
  eq(SP.isInstalled('x').installed, false, '记账 pref 坏值 isInstalled false');
  PrefStore.set(PP + 'skillPackRatings', '###bad###');
  eq(SP.getRating('x'), null, '评分 pref 坏值容错返回 null');
}

main().then(function () {
  console.log(`\nskill-packs 测试：${pass} 通过，${fails.length} 失败`);
  if (fails.length) {
    for (const f of fails) console.log('  x ' + f);
    process.exit(1);
  }
  console.log('ALL OK');
}, function (e) {
  console.error(e);
  console.log(`\nskill-packs 测试：${pass} 通过，${fails.length + 1} 失败`);
  process.exit(1);
});
