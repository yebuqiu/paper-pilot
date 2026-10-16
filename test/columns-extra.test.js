#!/usr/bin/env node
/* PaperPilot 条目列表三能力测试（Node vm 桩，无 Zotero 环境）
 *
 * 覆盖：
 *   ① extra 译文写回：upsertLine 替换语义（不动其他 extra 行 / CRLF /
 *      空值删除 / 多行译文压平）、writeBackTranslations 端到端（无变化不落盘）、
 *      parseSections 解析 LLM 合并输出；
 *   ② 阅读进度：computeProgress 有页数 / 无页数（启发值）两分支、
 *      无阅读记录留空、minutesOf 与真实 reading-stats.js 集成；
 *   ③ 星标评级：applyRating 纯函数（新增/替换/清除/夹紧）、get、
 *      set 端到端（含「★abc 用户标签不被误清」与重复设置不落盘）。
 *
 * 运行：node test/columns-extra.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const S = (p) => path.join(ROOT, 'chrome', 'content', 'scripts', p);

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
  PREFIX: 'extensions.zotero.paperpilot.',
  get(k, d) { return PrefStore.has(k) ? PrefStore.get(k) : d; },
  set(k, v) { PrefStore.set(k, v); },
};
const Zotero = {
  debug() {}, logError() {},
  ItemTreeManager: {
    async registerColumns() {},
    unregisterColumns() {},
    refreshColumns() {},
  },
  Notifier: { trigger() {} },
};
const I18n = { t: (k) => k, isZh: true };

const sandbox = {
  console, Zotero, Prefs, I18n,
  setTimeout, clearTimeout, Promise, Date, Math, JSON,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

for (const f of [
  'ai/translate-writeback.js',
  'features/reading-stats.js',
  'columns/progress-column.js',
  'features/rating.js',
  'columns/title-translation-column.js',
  'columns/rating-column.js',
]) {
  vm.runInContext(fs.readFileSync(S(f), 'utf8'), sandbox, { filename: f });
}
const TX = sandbox.TranslateX;
const PC = sandbox.ProgressColumn;
const R = sandbox.Rating;
const TTC = sandbox.TitleTranslationColumn;
const RC = sandbox.RatingColumn;

/** extra 假条目 */
function mkExtraItem(extra) {
  const item = {
    id: 100, saved: 0, _extra: String(extra == null ? '' : extra),
    getField(f) { return f === 'extra' ? this._extra : ''; },
    setField(f, v) { if (f === 'extra') this._extra = v; },
    async saveTx() { this.saved++; },
  };
  return item;
}

/* ==================== ① extra 译文写回 ==================== */

// --- upsertLine：追加 ---
eq(TX.upsertLine('', TX.TITLE_PREFIX, '深度学习综述'),
  'PP Title Translation: 深度学习综述', '① 空 extra 追加标题译文行');
eq(TX.upsertLine('DOI: 10.1/abc', TX.TITLE_PREFIX, '译文'),
  'DOI: 10.1/abc\nPP Title Translation: 译文', '① 已有行保留，译文行追加在末尾');

// --- upsertLine：替换且不动其他行 ---
const extra0 = 'DOI: 10.1/abc\nPP Title Translation: 旧译文\nZotero 自己的行\nPP Abstract Translation: 旧摘要';
const extra1 = TX.upsertLine(extra0, TX.TITLE_PREFIX, '新译文');
eq(extra1, 'DOI: 10.1/abc\nZotero 自己的行\nPP Abstract Translation: 旧摘要\nPP Title Translation: 新译文',
  '① ★ 替换标题行：旧行消失、其他行逐字保留');
ok(extra1.indexOf('旧译文') < 0, '① 旧译文被彻底清除（不堆积）');
ok(extra1.indexOf('PP Abstract Translation: 旧摘要') >= 0, '① 摘要行不受标题替换影响');
ok(extra1.indexOf('Zotero 自己的行') >= 0, '① 无关行原样保留');

// --- CRLF 兼容 ---
eq(TX.upsertLine('A\r\nPP Title Translation: x\r\nB', TX.TITLE_PREFIX, 'y'),
  'A\nB\nPP Title Translation: y', '① CRLF 输入同样命中替换');

// --- 空值 = 删除该行 ---
eq(TX.upsertLine('A\nPP Title Translation: x\nB', TX.TITLE_PREFIX, ''),
  'A\nB', '① 空值删除既有译文行');
eq(TX.upsertLine('A', TX.TITLE_PREFIX, ''), 'A', '① 无该行时空值不产生垃圾行');

// --- 多行译文压平成单行 ---
eq(TX.upsertLine('', TX.ABSTRACT_PREFIX, '第一行\n第二行\r\n  第三行'),
  'PP Abstract Translation: 第一行 第二行 第三行', '① ★ 译文内换行压平为单空格（extra 行级格式）');

// --- readLine ---
eq(TX.readLine('A\nPP Title Translation: 你好世界\nB', TX.TITLE_PREFIX), '你好世界', '① readLine 取值');
eq(TX.readLine('A\nB', TX.TITLE_PREFIX), '', '① 无该行返回空串');
eq(TX.readLine('PP Title Translation: 带:冒号', TX.TITLE_PREFIX), '带:冒号', '① 值里的冒号不受影响');

// --- writeBackTranslations 端到端 ---
(async () => {
  const it1 = mkExtraItem('DOI: 10.1/abc\n旧数据行');
  const changed = await TX.writeBackTranslations(it1, { title: '标题译文', abstract: '摘要\n译文' });
  eq(changed, true, '① 首次写回返回 true');
  eq(it1.saved, 1, '① 落盘一次');
  eq(it1._extra, 'DOI: 10.1/abc\n旧数据行\nPP Title Translation: 标题译文\nPP Abstract Translation: 摘要 译文',
    '① ★ 写回后 extra：其他行不动 + 两条译文行');

  // 再次写回 = 替换而不是追加
  await TX.writeBackTranslations(it1, { title: '标题译文2' });
  eq(it1._extra.split('PP Title Translation').length - 1, 1, '① ★ 重译后标题译文行仍只有一条（替换非堆积）');
  ok(it1._extra.indexOf('PP Abstract Translation: 摘要 译文') >= 0, '① 只给 title 时摘要行不动');
  ok(it1._extra.indexOf('标题译文2') >= 0, '① 新译文已替换');

  // 无变化不落盘
  const savedBefore = it1.saved;
  const noop = await TX.writeBackTranslations(it1, { title: '标题译文2' });
  eq(noop, false, '① 内容相同返回 false');
  eq(it1.saved, savedBefore, '① ★ 内容相同不 saveTx（不产生多余库写入）');

  // 空键不动作
  eq(await TX.writeBackTranslations(it1, {}), false, '① 空 translations 不动作');
  eq(await TX.writeBackTranslations(null, { title: 'x' }), false, '① 空条目安全返回');

  // readTranslations
  const rt = TX.readTranslations(it1);
  eq(rt.title, '标题译文2', '① readTranslations 读标题');
  eq(rt.abstract, '摘要 译文', '① readTranslations 读摘要');

  /* ==================== ①b parseSections ==================== */

  const sec1 = TX.parseSections('标题\n深度学习综述\n\n摘要\n本文综述了……\n第二段。');
  eq(sec1.title, '深度学习综述', '①b 中文节标题解析标题');
  eq(sec1.abstract, '本文综述了……\n第二段。', '①b 摘要保留多行');
  const sec2 = TX.parseSections('Title\nA Survey\n\nAbstract\nWe survey...');
  eq(sec2.title, 'A Survey', '①b 英文节标题');
  eq(sec2.abstract, 'We survey...', '①b 英文摘要');
  const sec3 = TX.parseSections('## 标题：\n译题\n### 摘要\n译摘');
  eq(sec3.title, '译题', '①b 容忍 Markdown # 前缀与冒号');
  const sec4 = TX.parseSections('直接一段没有节标题的输出');
  eq(sec4.title, '', '①b 无节标题 → 标题空（不写回）');
  eq(sec4.abstract, '', '①b 无节标题 → 摘要空（不写回）');

  /* ==================== ② 阅读进度 ==================== */

  // --- computeProgress 纯函数 ---
  eq(PC.computeProgress(0, 20), null, '② 无阅读记录 → null（列留空）');
  eq(PC.computeProgress(-5, 20), null, '② 负时长 → null');
  const p1 = PC.computeProgress(15, 20); // 15 / (20*1.5) = 0.5
  eq(p1.pct, 0.5, '② 有页数：分钟 ÷（页数×1.5）');
  eq(p1.heuristic, false, '② 有页数 → 非启发');
  eq(p1.pages, 20, '② 带回页数');
  eq(PC.computeProgress(999, 10).pct, 1, '② 读完夹紧到 100%（不超 1）');
  const p2 = PC.computeProgress(22.5, 0); // 22.5 / (30*1.5) = 0.5
  eq(p2.pct, 0.5, '② 无页数：按 30 页×1.5 分钟启发折算');
  eq(p2.heuristic, true, '② ★ 无页数 → 标记启发值（title 提示依据）');
  eq(PC.computeProgress(22.5, undefined).heuristic, true, '② 页数缺失同样走启发');
  eq(PC.computeProgress(9999, 0).pct, 1, '② 启发值同样夹紧 100%');
  ok(PC.detail(p2).indexOf('估算') >= 0, '② 启发分支 title 文案含「估算」提示');
  ok(PC.detail(p1).indexOf('/20') >= 0, '② 页数分支 title 含 x/20 页');

  // --- 与真实 reading-stats.js 集成：心跳 store → minutesOf ---
  const store = { schema: 1, days: {
    '2026-10-14': { KEYAAA: 5, KEYBBB: 3 },
    '2026-10-15': { KEYAAA: 7 },
  } };
  Prefs.set('readingStats', JSON.stringify(store));
  const itemA = { id: 201, key: 'KEYAAA', isRegularItem: () => true,
    getBestAttachment: async () => null };
  eq(PC.minutesOf(itemA), 12, '② ★ minutesOf 跨天求和（真实 ReadingStats.load）');
  eq(PC.minutesOf({ id: 202, key: 'KEYCCC', isRegularItem: () => true }), 0, '② 无记录条目 0 分钟');

  // lookup：页数未缓存时先走启发，页数预置后走精确
  PC._pageCache.clear();
  const lk1 = PC.lookup(itemA);
  eq(lk1.heuristic, true, '② lookup 页数未缓存 → 启发分支');
  await new Promise((r) => setTimeout(r, 10)); // 让 _fetchPages（无附件 → 0 页）落地
  PC._pageCache.set(201, 24);
  const lk2 = PC.lookup(itemA);
  eq(lk2.heuristic, false, '② 页数缓存命中 → 精确分支');
  eq(lk2.pct, 12 / (24 * 1.5), '② 精确分支数值正确');
  eq(PC.lookup({ id: 203, key: 'KEYCCC', isRegularItem: () => true }), null, '② 无记录 → null');
  eq(PC.lookup({ id: 204, isRegularItem: () => false }), null, '② 非常规条目 → null');
  Prefs.set('progressColumnEnabled', false);
  eq(PC.lookup(itemA), null, '② pref 关闭 → 列留空');
  PrefStore.delete('progressColumnEnabled');

  // 列 pref 关闭时标题译文列/评级列也留空（对齐开关语义）
  Prefs.set('titleTranslationColumnEnabled', false);
  eq(TTC.lookup({ isRegularItem: () => true, getField: () => 'PP Title Translation: x' }), '',
    '② 标题译文列 pref 关闭 → 空');
  PrefStore.delete('titleTranslationColumnEnabled');

  /* ==================== ③ 星标评级 ==================== */

  // --- applyRating 纯函数 ---
  eq(R.applyRating([], 3).join(','), '★★★', '③ 空标签打 3 星');
  eq(R.applyRating(['未读', '机器学习'], 2).join(','), '未读,机器学习,★★',
    '③ 保留既有标签并追加星标');
  eq(R.applyRating(['★★★', '未读'], 5).join(','), '未读,★★★★★',
    '③ ★ 重设评级：旧星标被替换而非叠加');
  eq(R.applyRating(['★★', '未读'], 0).join(','), '未读', '③ n=0 清除评级');
  eq(R.applyRating(['★abc', '未读'], 1).join(','), '★abc,未读,★',
    '③ ★ 用户自定义「★abc」标签不被误清');
  eq(R.applyRating([], 9).join(','), '★★★★★', '③ 超界夹紧到 5 星');
  eq(R.applyRating([], -2).length, 0, '③ 负数按 0 处理');
  eq(R.applyRating(['★★'], 2).join(','), '★★', '③ 同星重设结果一致（幂等）');

  // --- get / set 端到端（假条目） ---
  function mkTagged(tags) {
    const item = {
      saved: 0, _tags: tags.slice(),
      isRegularItem: () => true,
      getTags() { return this._tags.map((t) => ({ tag: t })); },
      addTag(t) { this._tags.push(t); },
      removeTag(t) { const i = this._tags.indexOf(t); if (i >= 0) this._tags.splice(i, 1); },
      async saveTx() { this.saved++; },
    };
    return item;
  }
  const it3 = mkTagged(['未读']);
  eq(R.get(it3), 0, '③ 无星标 → 0');
  eq(await R.set([it3], 3), 1, '③ set 3 星修改 1 条');
  eq(R.get(it3), 3, '③ get 读回 3 星');
  eq(it3._tags.join(','), '未读,★★★', '③ 标签形态正确');
  eq(await R.set([it3], 5), 1, '③ 改 5 星');
  eq(R.get(it3), 5, '③ get 读回 5 星');
  eq(it3._tags.filter((t) => /^★+$/.test(t)).length, 1, '③ ★ 星标签始终只有一条');
  const saved3 = it3.saved;
  eq(await R.set([it3], 5), 0, '③ ★ 同星重设 → 0 条修改（不重复落盘）');
  eq(it3.saved, saved3, '③ 幂等不 saveTx');
  eq(await R.set([it3], 0), 1, '③ 清除评级');
  eq(R.get(it3), 0, '③ 清除后 get = 0');
  eq(it3._tags.join(','), '未读', '③ 清除后仅余原标签');

  // 批量
  const batch = [mkTagged(['★']), mkTagged([]), mkTagged(['★★★★'])];
  eq(await R.set(batch, 2), 3, '③ 批量设置：3 条均变更');
  ok(batch.every((it) => R.get(it) === 2), '③ 批量后全部 2 星');

  // 评级列
  const itR = mkTagged(['★★★★']);
  eq(RC.lookup(itR), 4, '③ 评级列读出 4');
  eq(RC.lookup(mkTagged([])), '', '③ 评级列无评级 → 空');
  Prefs.set('ratingColumnEnabled', false);
  eq(RC.lookup(itR), '', '③ 评级列 pref 关闭 → 空');
  PrefStore.delete('ratingColumnEnabled');

  /* ==================== ③b 标题译文列 ==================== */

  const itT = mkExtraItem('A\nPP Title Translation: 图神经网络综述\nPP Abstract Translation: 摘…');
  itT.isRegularItem = () => true;
  eq(TTC.lookup(itT), '图神经网络综述', '③b 标题译文列读取 extra 行');
  eq(TTC.lookup(mkExtraItem('A')), '', '③b 无译文行 → 空');
  ok(TTC.lookupDetail(itT).indexOf('摘…') >= 0, '③b tooltip 含摘要译文');

  // TranslateX 未加载时的本地兜底（列自给自足）
  const sb2 = { console, Zotero, Prefs, I18n, setTimeout, clearTimeout, Promise, Date, Math, JSON };
  sb2.globalThis = sb2;
  vm.createContext(sb2);
  vm.runInContext(fs.readFileSync(S('columns/title-translation-column.js'), 'utf8'), sb2,
    { filename: 'title-translation-column.js' });
  const itT2 = mkExtraItem('PP Title Translation: 兜底译文');
  itT2.isRegularItem = () => true;
  eq(sb2.TitleTranslationColumn.lookup(itT2), '兜底译文', '③b TranslateX 缺失时本地解析兜底');

  /* ---------------- 输出 ---------------- */
  console.log('='.repeat(60));
  if (fails.length) {
    for (const f of fails) console.log('  x ' + f);
    console.log('-'.repeat(60));
  }
  console.log('条目列表三能力测试：' + pass + ' 通过 / ' + fails.length + ' 失败');
  console.log('='.repeat(60));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.error('测试执行异常：', e);
  process.exit(1);
});
