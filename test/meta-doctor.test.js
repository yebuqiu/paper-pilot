#!/usr/bin/env node
/* 元数据医生（MetaDoctor，0.52.0）测试 —— 检测 → 反查 → 预览 → 确认 → 应用 → 撤销
 *
 * 覆盖：
 *   ① _titleSim：相同 / 大小写与标点 / 部分重叠 / 完全不同 / 空串 / 中文 bigram 兜底；
 *   ② _previewFor：缺 DOI 命中 → diffs 正确 / 已有值 → no_gap / 相似度低 → low_score /
 *      年份差 > 1 → low_score / 无命中 → no_match / 网络失败 → request_failed（不抛）/
 *      无作者条目用标题检索 / 只有空缺字段进 diffs / 作者与年份回填；
 *   ③ run：无选区 no_selection / skipConfirm 不写库 / 取消不写库 / 确认后写库计数 /
 *      部分失败 errors 收集且成功条目仍应用 / 交付 id 与条目混合入参 / 无缺口 nothing_to_do；
 *   ④ 审计与撤销：meta_doctor + restoreFields（只记实际改动字段）→ AgentTools.undoLast()
 *      把字段恢复成旧值（端到端，条目为 getField/setField 状态机桩）。
 *
 * 全程无网络：网络单点 MetaDoctor._req 被替换为桩。
 * 运行：node test/meta-doctor.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FILES = [
  'chrome/content/scripts/features/meta-doctor.js',
  'chrome/content/scripts/ai/agent-tools.js',
];

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
const Prefs = {
  get(k, d) { return PrefStore.has(k) ? PrefStore.get(k) : d; },
  set(k, v) { PrefStore.set(k, v); },
};

/** 条目桩：getField/setField/saveTx 是真实状态机（撤销断言依赖它） */
function makeItem(id, fields, creators) {
  return {
    id,
    itemType: (fields && fields._type) || 'journalArticle',
    _fields: Object.assign({}, fields || {}),
    _creators: (creators || []).slice(),
    _setField: 0,
    _saves: 0,
    _failSave: false,
    _failFields: [],
    isRegularItem: function () { return true; },
    getField: function (f) { return this._fields[f] === undefined ? '' : this._fields[f]; },
    setField: function (f, v) {
      if (this._failFields.indexOf(f) >= 0) throw new Error('字段写入失败：' + f);
      this._setField++;
      this._fields[f] = v;
    },
    getCreators: function () { return this._creators.map(function (c) { return Object.assign({}, c); }); },
    setCreators: function (cs) { this._creators = (cs || []).map(function (c) { return Object.assign({}, c); }); },
    getDisplayTitle: function () { return this._fields.title || ''; },
    saveTx: async function () {
      if (this._failSave) throw new Error('数据库忙');
      this._saves++;
    },
  };
}

const ITEMS = [
  // 四类缺口全占：DOI / 期刊 / 年份 / 作者
  makeItem(201, { title: 'Deep Residual Learning for Image Recognition' }, []),
  // 字段齐全
  makeItem(202, {
    title: 'Attention Is All You Need', DOI: '10.1000/xyz', publicationTitle: 'NeurIPS',
    date: '2017-06',
  }, [{ creatorType: 'author', firstName: 'Ashish', lastName: 'Vaswani' }]),
  // 相似度低
  makeItem(203, { title: 'Quantum Widget Calibration in Low Earth Orbit', DOI: '10.9/q' }, [
    { creatorType: 'author', firstName: 'A', lastName: 'Ng' },
  ]),
  // 年份差 5（2010 vs 2015）
  makeItem(204, {
    title: 'Graph Neural Networks for Molecules', publicationTitle: 'JMLR', date: '2010-01',
  }, [{ creatorType: 'author', firstName: 'X', lastName: 'Li' }]),
  // 网络失败
  makeItem(205, { title: 'Deep Residual Learning for Image Recognition', DOI: '10.9/n' }, [
    { creatorType: 'author', firstName: 'B', lastName: 'Wu' },
  ]),
  // 只有 DOI 缺（其余已有）→ 只补空
  makeItem(206, {
    title: 'Deep Residual Learning for Image Recognition', publicationTitle: 'Nature',
    date: '2015-06',
  }, [{ creatorType: 'author', firstName: 'Kaiming', lastName: 'He' }]),
  // 无作者条目（查询只能用标题）
  makeItem(207, { title: 'Deep Residual Learning for Image Recognition' }, []),
];

function byId(id) { return ITEMS.find(function (i) { return i.id === Number(id); }) || null; }

const paneState = { selected: [] };
const promptState = { choice: 0, calls: [], lastMsg: '' };

function ProgressWindow() {
  this.headline = '';
  this.rows = [];
  this.changeHeadline = function (t) { this.headline = t; };
  this.show = function () {};
  this.startCloseTimer = function () {};
  const self = this;
  this.ItemProgress = function (icon, text) {
    const row = {
      text: text, progress: 0, error: false,
      setProgress: function (n) { row.progress = n; },
      setText: function (t) { row.text = t; },
      setError: function () { row.error = true; },
    };
    self.rows.push(row);
    return row;
  };
}

const Zotero = {
  locale: 'zh-CN',
  Prefs: Prefs,
  debug: function () {},
  logError: function () {},
  getMainWindow: function () { return { __win: true }; },
  getActiveZoteroPane: function () { return { getSelectedItems: function () { return paneState.selected; } }; },
  Items: { get: function (id) { return byId(id); } },
  HTTP: { request: async function () { throw new Error('测试不允许真网络'); } },
  ProgressWindow: ProgressWindow,
  Libraries: { userLibraryID: 1 },
};

const Services = {
  prompt: {
    BUTTON_POS_0: 1, BUTTON_POS_1: 256, BUTTON_TITLE_IS_STRING: 128,
    confirmEx: function (win, title, text, flags, b0, b1) {
      promptState.calls.push({ title: title, text: text, flags: flags, b0: b0, b1: b1 });
      promptState.lastMsg = text;
      return promptState.choice;
    },
  },
};

const I18n = { isZh: true, t: function (k) { return k; } };

const sandbox = {
  console, Zotero, Services, Prefs, I18n,
  JSON, Date, Math, Promise, isFinite, parseInt, parseFloat, String, Number,
  Array, Object, Set, Map, Error, RegExp, encodeURIComponent, decodeURIComponent,
  setTimeout, clearTimeout,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of FILES) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
}
const MD = sandbox.MetaDoctor;
const AT = sandbox.AgentTools;

/* ---------------- Crossref 夹具 / 网络桩 ---------------- */

function crItem(doi, title, container, year, authors) {
  return {
    DOI: doi,
    title: [title],
    'container-title': container ? [container] : [],
    issued: { 'date-parts': [[year]] },
    author: (authors || []).map(function (a) {
      return { given: a[0], family: a[1] };
    }),
    score: 25,
  };
}

const FIXTURES = {
  'Deep Residual Learning': [
    crItem('10.1038/nature14539', 'Deep Residual Learning for Image Recognition', 'Nature', 2015,
      [['Kaiming', 'He'], ['Xiangyu', 'Zhang']]),
  ],
  'Quantum Widget Calibration': [
    crItem('10.9/other', 'Completely Different Paper About Coastal Erosion', 'Other Journal', 2021,
      [['A', 'B']]),
  ],
  'Graph Neural Networks for Molecules': [
    crItem('10.9/gnn', 'Graph Neural Networks for Molecules', 'JMLR', 2015, [['X', 'Y']]),
  ],
};

const netState = { urls: [], fail: false, error: '连接被重置' };

function netStub(url) {
  netState.urls.push(url);
  if (netState.fail) return { ok: false, status: 0, json: null, error: netState.error };
  const q = decodeURIComponent(url);
  for (const key of Object.keys(FIXTURES)) {
    if (q.indexOf(key) >= 0) {
      return { ok: true, status: 200, json: { message: { items: FIXTURES[key] } } };
    }
  }
  return { ok: true, status: 200, json: { message: { items: [] } } };
}
const RAW_REQ = MD._req.bind(MD);  // 真实现（下面单测 _req 的失败路径）
MD._req = netStub;                 // 普通函数桩（非箭头），无网络

function resetItem(it, fields, creators) {
  it._fields = Object.assign({}, fields || {});
  it._creators = (creators || []).slice();
  it._setField = 0;
  it._saves = 0;
  it._failSave = false;
  it._failFields = [];
}

function resetNet() {
  netState.urls.length = 0;
  netState.fail = false;
}

function resetPrompt(choice) {
  promptState.choice = choice === undefined ? 0 : choice;
  promptState.calls.length = 0;
  promptState.lastMsg = '';
}

(async function main() {

  /* ---------------- ① _titleSim ---------------- */

  eq(MD._titleSim('Deep Learning', 'Deep Learning'), 1, '① 完全相同 = 1');
  eq(MD._titleSim('Attention Is All You Need', 'attention is all you need.'), 1,
    '① 大小写/标点差异 = 1');
  eq(MD._titleSim('Deep Residual Learning',
    'Deep Residual Learning for Image Recognition'), 0.5,
    '① 部分重叠 = 0.5（3/6 词级 Jaccard）');
  ok(MD._titleSim('Deep Residual Learning', 'Quantum Widget Calibration') < 0.2,
    '① 完全不同 < 0.2');
  eq(MD._titleSim('', 'Deep Learning'), 0, '① 空串（左）= 0');
  eq(MD._titleSim('Deep Learning', ''), 0, '① 空串（右）= 0');
  eq(MD._titleSim('', ''), 0, '① 双空串 = 0');
  eq(MD._titleSim('Deep Learning', 'Learning Deep'), 1, '① 词序无关（词集 Jaccard）');
  ok(MD._titleSim('基于深度学习的图像识别', '基于深度学习的图像分类方法') > 0.5,
    '① 中文无空格标题走字符 bigram（可命中）', MD._titleSim('基于深度学习的图像识别', '基于深度学习的图像分类方法'));
  ok(MD._titleSim('基于深度学习的图像识别', '量子材料的低温输运') < 0.2, '① 中文不相关 < 0.2');

  /* ---------------- ② _previewFor ---------------- */

  // 缺 DOI + 高相似度 → 四类 diff 齐备
  await (async () => {
    resetNet();
    resetItem(ITEMS[0], { title: 'Deep Residual Learning for Image Recognition' }, []);
    const p = await MD._previewFor(ITEMS[0]);
    ok(Array.isArray(p.diffs) && p.diffs.length === 4, '② 四类缺口 → 4 条 diff', p.diffs);
    const byField = {};
    (p.diffs || []).forEach(function (d) { byField[d.field] = d; });
    eq(byField.DOI && byField.DOI.new, '10.1038/nature14539', '② DOI diff 值正确（小写归一）');
    eq(byField.DOI && byField.DOI.old, '', '② DOI 旧值为空');
    eq(byField.publicationTitle && byField.publicationTitle.new, 'Nature', '② 期刊 diff 正确');
    eq(byField.date && byField.date.new, '2015', '② 年份 diff 正确（只写年份）');
    eq(byField.creators && byField.creators.new.length, 2, '② 作者 diff 正确');
    eq(byField.creators && byField.creators.new[0].lastName, 'He', '② 作者姓/名拆分');
    ok(p.match && p.match.sim === 1, '② match.sim 记录相似度');
    eq(netState.urls.length, 1, '② 只有一次请求');
    ok(decodeURIComponent(netState.urls[0]).indexOf('query.bibliographic=') > 0,
      '② 走 query.bibliographic');
    ok(netState.urls[0].indexOf('rows=3') > 0, '② rows=3');
    ok(netState.urls[0].indexOf('container-title') > 0, '② select 含 container-title');
  })().catch(function (e) { ok(false, '② 四类缺口异常: ' + e.message); });

  // 已有值 → no_gap
  await (async () => {
    resetNet();
    const p = await MD._previewFor(ITEMS[1]);
    eq(p.skip, 'no_gap', '② 字段齐全 → no_gap');
    eq(netState.urls.length, 0, '② no_gap 不发请求');
  })().catch(function (e) { ok(false, '② no_gap 异常: ' + e.message); });

  // 相似度低 → low_score
  await (async () => {
    resetNet();
    const p = await MD._previewFor(ITEMS[2]);
    eq(p.skip, 'low_score', '② 相似度低 → low_score');
    ok(!p.diffs, '② low_score 无 diffs');
  })().catch(function (e) { ok(false, '② low_score 异常: ' + e.message); });

  // 年份差 > 1 → low_score
  await (async () => {
    resetNet();
    const p = await MD._previewFor(ITEMS[3]);
    eq(p.skip, 'low_score', '② 年份差 5 → low_score（标题虽 1.0）');
    ok(p.gaps.indexOf('date') < 0, '② date 有 4 位年份 → 不算缺口');
  })().catch(function (e) { ok(false, '② 年份差异常: ' + e.message); });

  // 无命中 → no_match
  await (async () => {
    resetNet();
    const it = makeItem(281, { title: 'Zeta Unknown Manuscript', DOI: '10.9/z' }, []);
    const p = await MD._previewFor(it);
    eq(p.skip, 'no_match', '② 0 条候选 → no_match');
  })().catch(function (e) { ok(false, '② no_match 异常: ' + e.message); });

  // 网络失败 → request_failed（不抛）
  await (async () => {
    resetNet();
    netState.fail = true;
    const p = await MD._previewFor(ITEMS[4]);
    eq(p.skip, 'request_failed', '② 网络失败 → request_failed（不抛）');
    eq(p.error, '连接被重置', '② 透传网络错误原因');
    resetNet();
  })().catch(function (e) { ok(false, '② 网络失败异常: ' + e.message); });

  // _req 单点（真实现）：HTTP 层异常 / 非 2xx 都返回对象，不抛
  await (async () => {
    const savedReq = Zotero.HTTP.request;
    Zotero.HTTP.request = async function () { throw new Error('NS_ERROR_UNKNOWN_HOST'); };
    const r1 = await RAW_REQ('https://api.crossref.org/works?x=1');
    eq(r1.ok, false, '② _req：HTTP 异常 → ok=false');
    ok(r1.error.indexOf('NS_ERROR_UNKNOWN_HOST') >= 0, '② _req：透传异常原因');
    eq(r1.json, null, '② _req：无 JSON');
    Zotero.HTTP.request = async function () { return { status: 429, response: null }; };
    const r2 = await RAW_REQ('https://api.crossref.org/works?x=1');
    eq(r2.ok, false, '② _req：HTTP 429 → ok=false');
    ok(r2.error.indexOf('429') >= 0, '② _req：错误含状态码');
    Zotero.HTTP.request = savedReq;
  })().catch(function (e) { ok(false, '② _req 异常路径异常: ' + e.message); });

  // 无作者条目：查询串只用标题
  await (async () => {
    resetNet();
    resetItem(ITEMS[6], { title: 'Deep Residual Learning for Image Recognition' }, []);
    const p = await MD._previewFor(ITEMS[6]);
    ok(Array.isArray(p.diffs) && p.diffs.length > 0, '② 无作者条目仍能命中', p.skip);
    const q = decodeURIComponent(netState.urls[0]);
    ok(q.indexOf('Deep Residual Learning for Image Recognition') > 0, '② 查询串含标题');
    ok(netState.urls[0].indexOf('query.bibliographic=' +
      encodeURIComponent('Deep Residual Learning for Image Recognition')) >= 0,
      '② 无作者/无年份时查询串只有标题', netState.urls[0]);
  })().catch(function (e) { ok(false, '② 无作者异常: ' + e.message); });

  // 只补空：已有期刊/年份 → diffs 只含 DOI
  await (async () => {
    resetNet();
    const p = await MD._previewFor(ITEMS[5]);
    ok(Array.isArray(p.diffs), '② 部分缺口有 diffs');
    eq(p.diffs.length, 1, '② 只补空字段：仅 DOI 进 diffs', p.diffs);
    eq(p.diffs[0].field, 'DOI', '② 唯一 diff 是 DOI');
    eq(p.diffs[0].old, '', '② 旧值空（未覆盖 Nature/2015-06）');
  })().catch(function (e) { ok(false, '② 只补空异常: ' + e.message); });

  // 附件 → 父条目；id → 条目
  await (async () => {
    const parent = ITEMS[1];
    const att = {
      id: 9001, parentItemID: parent.id,
      isRegularItem: function () { return false; },
      getField: function () { return ''; },
    };
    const resolved = await MD._resolveItems([att]);
    eq(resolved.length, 1, '② 附件归一为父条目');
    eq(resolved[0].id, parent.id, '② 归一结果指向父条目');
    const byIdList = await MD._resolveItems([parent.id]);
    eq(byIdList.length, 1, '② 数字 id 可解析');
    eq(byIdList[0].id, parent.id, '② 数字 id 指向同一条目');
    eq((await MD._resolveItems([9999])).length, 0, '② 无效 id 被丢弃');
  })().catch(function (e) { ok(false, '② 选区归一异常: ' + e.message); });

  /* ---------------- ③ run：确认 / 取消 / 写库 ---------------- */

  // 无选区
  await (async () => {
    paneState.selected = [];
    const r = await MD.run();
    eq(r.ok, false, '③ 无选区 ok=false');
    eq(r.reason, 'no_selection', '③ 无选区 reason=no_selection');
    eq(r.applied.length, 0, '③ 无选区 applied 为空');
  })().catch(function (e) { ok(false, '③ 无选区异常: ' + e.message); });

  // skipConfirm → 不写库，只给预览
  await (async () => {
    resetNet();
    resetPrompt(0);
    resetItem(ITEMS[0], { title: 'Deep Residual Learning for Image Recognition' }, []);
    const r = await MD.run([ITEMS[0]], { skipConfirm: true });
    eq(r.ok, false, '③ skipConfirm：ok=false');
    eq(r.reason, 'confirm_required', '③ skipConfirm：reason=confirm_required');
    eq(r.preview.length, 1, '③ skipConfirm：返回预览 1 条');
    eq(r.preview[0].diffs.length, 4, '③ skipConfirm：预览含 4 条 diff');
    eq(promptState.calls.length, 0, '③ skipConfirm：不弹确认');
    eq(ITEMS[0]._setField, 0, '③ skipConfirm：不写字段');
    eq(ITEMS[0]._saves, 0, '③ skipConfirm：不存库');
  })().catch(function (e) { ok(false, '③ skipConfirm 异常: ' + e.message); });

  // 取消 → 不写库
  await (async () => {
    resetNet();
    resetPrompt(1);
    resetItem(ITEMS[0], { title: 'Deep Residual Learning for Image Recognition' }, []);
    const r = await MD.run([ITEMS[0]]);
    eq(r.reason, 'cancelled', '③ 取消：reason=cancelled');
    eq(promptState.calls.length, 1, '③ 取消：弹过一次确认');
    ok(promptState.lastMsg.indexOf('《Deep Residual Learning for Image Recognition》') >= 0,
      '③ 预览文案逐条列标题');
    ok(promptState.lastMsg.indexOf('补 DOI: 10.1038/nature14539') > 0, '③ 预览文案含补 DOI');
    ok(promptState.lastMsg.indexOf('期刊: Nature') > 0, '③ 预览文案含期刊');
    ok(promptState.lastMsg.indexOf('年份: 2015') > 0, '③ 预览文案含年份');
    ok(promptState.lastMsg.indexOf('共 1 条可补全') > 0, '③ 预览文案含合计行');
    eq(ITEMS[0]._setField, 0, '③ 取消：不写字段');
    eq(ITEMS[0]._saves, 0, '③ 取消：不存库');
  })().catch(function (e) { ok(false, '③ 取消异常: ' + e.message); });

  // 确认 → 写库；计数正确（3 次 setField + 1 次 setCreators + 1 次 saveTx）
  await (async () => {
    resetNet();
    resetPrompt(0);
    PrefStore.delete('agentAuditLog');
    resetItem(ITEMS[0], { title: 'Deep Residual Learning for Image Recognition' }, []);
    const r = await MD.run([ITEMS[0]]);
    eq(r.ok, true, '③ 确认：ok=true');
    eq(r.applied.length, 1, '③ 确认：applied 1 条');
    eq(r.applied[0].fields.join(','), 'DOI,publicationTitle,date,creators', '③ applied 字段清单');
    eq(ITEMS[0]._setField, 3, '③ setField 调用 3 次（DOI/期刊/年份）');
    eq(ITEMS[0]._creators.length, 2, '③ 作者已写入');
    eq(ITEMS[0]._saves, 1, '③ 每条约一次 saveTx');
    eq(ITEMS[0]._fields.DOI, '10.1038/nature14539', '③ DOI 落库');
    eq(ITEMS[0]._fields.publicationTitle, 'Nature', '③ 期刊落库');
    eq(ITEMS[0]._fields.date, '2015', '③ 年份落库');
    eq(r.errors.length, 0, '③ 无错误');
    eq(r.skipped.length, 0, '③ 无跳过');
  })().catch(function (e) { ok(false, '③ 确认异常: ' + e.message); });

  // 部分失败：成功条目仍应用，失败进 errors
  await (async () => {
    resetNet();
    resetPrompt(0);
    PrefStore.delete('agentAuditLog');
    const good = makeItem(301, { title: 'Deep Residual Learning for Image Recognition' }, []);
    const bad = makeItem(302, { title: 'Deep Residual Learning for Image Recognition' }, []);
    bad._failSave = true;
    const r = await MD.run([good, bad]);
    eq(r.applied.length, 1, '③ 部分失败：成功条目仍应用');
    eq(r.applied[0].itemID, 301, '③ 部分失败：成功的是 301');
    eq(r.errors.length, 1, '③ 部分失败：errors 收集 1 条');
    eq(r.errors[0].itemID, 302, '③ 部分失败：失败的是 302');
    ok(r.errors[0].error.indexOf('保存失败') >= 0, '③ 部分失败：错误原因可读', r.errors[0].error);
    eq(good._saves, 1, '③ 部分失败：成功条目已存库');
    eq(bad._saves, 0, '③ 部分失败：失败条目未计入存库');
    eq(bad._fields.DOI, '', '③ 部分失败：saveTx 失败后内存值已回滚');
    eq(AT.auditList().length, 1, '③ 部分失败：只给成功条目记审计');
    PrefStore.delete('agentAuditLog');
  })().catch(function (e) { ok(false, '③ 部分失败异常: ' + e.message); });

  // 无缺口 → nothing_to_do
  await (async () => {
    resetNet();
    resetPrompt(0);
    const r = await MD.run([ITEMS[1]]);
    eq(r.ok, false, '③ 无缺口：ok=false');
    eq(r.reason, 'nothing_to_do', '③ 无缺口：reason=nothing_to_do');
    eq(r.skipped.length, 1, '③ 无缺口：计入 skipped');
    eq(r.skipped[0].reason, 'no_gap', '③ 无缺口：skip=no_gap');
    eq(promptState.calls.length, 0, '③ 无缺口：不弹确认');
  })().catch(function (e) { ok(false, '③ 无缺口异常: ' + e.message); });

  /* ---------------- ④ 审计 + 撤销（端到端） ---------------- */

  await (async () => {
    resetNet();
    resetPrompt(0);
    PrefStore.delete('agentAuditLog');
    // 只缺 DOI：审计字段清单必须只有 DOI
    resetItem(ITEMS[5], {
      title: 'Deep Residual Learning for Image Recognition',
      publicationTitle: 'Nature', date: '2015-06',
    }, [{ creatorType: 'author', firstName: 'Kaiming', lastName: 'He' }]);
    const r = await MD.run([ITEMS[5]]);
    eq(r.applied.length, 1, '④ 只补空：应用 1 条');
    const list = AT.auditList();
    eq(list.length, 1, '④ 审计新增 1 条');
    eq(list[0].tool, 'meta_doctor', '④ 审计 tool=meta_doctor');
    eq(list[0].undo.kind, 'restoreFields', '④ undo.kind=restoreFields');
    eq(list[0].undo.itemID, 206, '④ undo.itemID 正确');
    eq(Object.keys(list[0].undo.fields).join(','), 'DOI', '④ 只记实际改动的字段（不记已有期刊/年份）');
    eq(list[0].undo.fields.DOI, '', '④ 记旧值（空串）');
    ok(list[0].summary.indexOf('元数据补全：《Deep Residual Learning for Image Recognition》补 DOI') === 0,
      '④ summary 文案形如「元数据补全：《标题》补 DOI」', list[0].summary);

    const u = await AT.undoLast();
    eq(u.ok, true, '④ undoLast 成功');
    ok(u.done.indexOf('已恢复字段') === 0, '④ 撤销返回恢复说明', u.done);
    eq(ITEMS[5]._fields.DOI, '', '④ DOI 恢复为空');
    eq(ITEMS[5]._fields.publicationTitle, 'Nature', '④ 已有期刊未被误改');
    eq(ITEMS[5]._fields.date, '2015-06', '④ 已有年份未被误改');
    eq(AT.auditList().length, 0, '④ 撤销成功后移除审计记录');
  })().catch(function (e) { ok(false, '④ 审计/撤销异常: ' + (e && e.stack || e)); });

  // 四类全改 → 撤销恢复全部旧值（含作者清空）
  await (async () => {
    resetNet();
    resetPrompt(0);
    PrefStore.delete('agentAuditLog');
    resetItem(ITEMS[0], { title: 'Deep Residual Learning for Image Recognition' }, []);
    await MD.run([ITEMS[0]]);
    const rec = AT.auditList()[0];
    eq(Object.keys(rec.undo.fields).sort().join(','),
      'DOI,creators,date,publicationTitle', '④ 四类字段全记入审计');
    eq(rec.undo.fields.date, '', '④ date 旧值为空串');
    eq(rec.undo.fields.creators.length, 0, '④ creators 旧值为空数组');
    const u = await AT.undoLast();
    eq(u.ok, true, '④ 四类撤销成功');
    eq(ITEMS[0]._fields.DOI, '', '④ DOI 已清空');
    eq(ITEMS[0]._fields.publicationTitle, '', '④ 期刊已清空');
    eq(ITEMS[0]._fields.date, '', '④ 年份已清空');
    eq(ITEMS[0]._creators.length, 0, '④ 作者已清空');
    eq(ITEMS[0]._saves, 2, '④ 应用 1 次 + 撤销 1 次 saveTx');
    PrefStore.delete('agentAuditLog');
  })().catch(function (e) { ok(false, '④ 四类撤销异常: ' + (e && e.stack || e)); });

  // restoreFields：条目不存在 / 字段为空 → 明确错误且保留记录
  await (async () => {
    PrefStore.delete('agentAuditLog');
    AT._recordAudit('meta_doctor', '元数据补全：《已删除》补 DOI',
      { kind: 'restoreFields', itemID: 7777, fields: { DOI: '' } });
    const u1 = await AT.undoLast();
    eq(u1.ok, false, '④ 条目不存在：撤销失败');
    ok(u1.error.indexOf('条目不存在') >= 0, '④ 条目不存在：错误可读', u1.error);
    eq(AT.auditList().length, 1, '④ 失败保留审计记录');

    PrefStore.delete('agentAuditLog');
    AT._recordAudit('meta_doctor', '元数据补全：空字段', { kind: 'restoreFields', itemID: 201, fields: {} });
    const u2 = await AT.undoLast();
    eq(u2.ok, false, '④ 无字段：撤销失败');
    ok(u2.error.indexOf('没有可恢复的字段') >= 0, '④ 无字段：错误可读', u2.error);
    PrefStore.delete('agentAuditLog');
  })().catch(function (e) { ok(false, '④ 撤销异常路径异常: ' + e.message); });

  /* ---------------- 汇总 ---------------- */

  console.log(`\nmeta-doctor 测试：${pass} 通过，${fails.length} 失败`);
  if (fails.length) {
    fails.forEach((f) => console.log('  ✗ ' + f));
    process.exit(1);
  }
})().catch(function (e) {
  console.error('测试运行异常：', e);
  process.exit(1);
});
