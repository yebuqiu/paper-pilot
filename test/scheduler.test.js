#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 定时任务模块测试（研究晨报 / 阅读周报 / 库体检）
 *
 * 为什么要有它：定时任务最容易坏在「静默」——时间解析错了、当天重复跑、
 * 错过 6 小时还补跑、任务抛错把轮询打断，用户都看不出来。这个套件在 vm 沙箱里
 * 把 scheduler.js 真跑一遍（Zotero / Prefs / Items / 笔记 / 统计模块全部桩化，
 * 不碰磁盘与网络），断言调度语义与三个任务的产出/降级路径。
 *
 * 运行：node test/scheduler.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'chrome', 'content', 'scripts', 'features', 'scheduler.js');
const PREFIX = 'extensions.zotero.papilot.';

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }
function has(hay, needle, label) {
  return ok(String(hay == null ? '' : hay).indexOf(needle) >= 0, label, { needle: needle });
}
function notHas(hay, needle, label) {
  return ok(String(hay == null ? '' : hay).indexOf(needle) < 0, label, { needle: needle });
}

/* ---------------- 测试桩 ---------------- */

/** 24h 内的固定时刻（本地时间；任务内部只按本地日历取标题） */
const AT = new Date(2026, 9, 18, 8, 0, 0); // 2026-10-18 08:00 本地
const DAY = '2026-10-18';

/** Date → Zotero 的 UTC SQL 时间串 */
function sqlUTC(d) { return d.toISOString().slice(0, 19).replace('T', ' '); }

function mkItem(o) {
  o = o || {};
  const fields = o.fields || {};
  return {
    key: o.key || 'K' + Math.random().toString(36).slice(2, 8),
    libraryID: 1,
    deleted: !!o.deleted,
    dateAdded: o.dateAdded || '',
    isRegularItem() { return true; },
    getDisplayTitle() { return fields.title || ''; },
    getField(f) { return fields[f] || ''; },
    getCreators() { return o.creators || []; },
    getCollections() { return o.collections || []; },
    getAttachments() { return o.attachments || []; },
  };
}

function makeEnv(opts) {
  opts = opts || {};
  const store = new Map(Object.entries(opts.prefs || {}));
  const notes = [];
  const intervals = [];
  const errors = [];
  const calls = { getAll: 0 };
  let seq = 1;

  class Note {
    constructor(type) { this.type = type; this.libraryID = null; this.html = ''; }
    setNote(h) { this.html = String(h); }
    async saveTx() { notes.push(this); }
  }

  const Zotero = {
    locale: 'zh-CN',
    Prefs: {
      get(k) { return store.has(k) ? store.get(k) : undefined; },
      set(k, v) { store.set(k, v); },
    },
    Libraries: { userLibraryID: 1 },
    Collections: { get(id) { return { id: id, name: '分类' + id }; } },
    Items: {
      async getAll() {
        calls.getAll++;
        if (typeof opts.items === 'function') return opts.items(calls.getAll);
        return opts.items || [];
      },
    },
    Item: Note,
    Papilot: {
      diags: [],
      _diag(msg) { Zotero.Papilot.diags.push(String(msg)); return Promise.resolve(); },
    },
    logError(e) { errors.push(e); },
    debug() {},
  };

  const Prefs = {
    get(k, fallback) {
      const full = PREFIX + k;
      return store.has(full) ? store.get(full) : fallback;
    },
    set(k, v) { store.set(PREFIX + k, v); },
  };

  const win = {
    setInterval(fn, ms) {
      const rec = { id: seq++, fn: fn, ms: ms, cleared: false };
      intervals.push(rec);
      return rec.id;
    },
    clearInterval(id) {
      const rec = intervals.filter((x) => x.id === id)[0];
      if (rec) rec.cleared = true;
    },
    setTimeout() { return seq++; },
  };

  const sandbox = {
    Zotero: Zotero,
    Prefs: Prefs,
    window: win,
    console: console,
    // 关键：Date 必须用外层实例，否则 _dateOf 的 instanceof 会跨 realm 失败
    Date: Date,
    Math: Math,
    JSON: JSON,
    Object: Object,
    Array: Array,
    String: String,
    Number: Number,
    Boolean: Boolean,
    Map: Map,
    Set: Set,
    Promise: Promise,
    Error: Error,
    RegExp: RegExp,
    isNaN: isNaN,
    parseInt: parseInt,
    setInterval: win.setInterval,
    clearInterval: win.clearInterval,
    setTimeout: win.setTimeout,
  };
  if (opts.ReadingStats) sandbox.ReadingStats = opts.ReadingStats;
  if (opts.ReadingProgress) sandbox.ReadingProgress = opts.ReadingProgress;
  if (opts.MetaLint) sandbox.MetaLint = opts.MetaLint;
  if (opts.MdLite) sandbox.MdLite = opts.MdLite;

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: 'scheduler.js' });

  return {
    S: sandbox.Scheduler,
    store: store,
    notes: notes,
    intervals: intervals,
    errors: errors,
    calls: calls,
    diags: Zotero.Papilot.diags,
    prefs: (k) => store.get(PREFIX + k),
    lastRun: () => {
      const raw = store.get(PREFIX + 'scheduleLastRun');
      if (!raw) return {};
      try { return JSON.parse(raw); } catch (e) { return null; }
    },
  };
}

function duePrefs(minutes) {
  const h = String(Math.floor(minutes / 60)).padStart(2, '0');
  const m = String(minutes % 60).padStart(2, '0');
  return h + ':' + m;
}

async function main() {

  /* ================== ① 时间解析边界 ================== */

  {
    const { S } = makeEnv();
    const t1 = S._parseTime('07:30');
    ok(t1 && t1.h === 7 && t1.m === 30 && t1.minutes === 450, '① "07:30" → 7:30 / 450 分钟', t1);
    const t2 = S._parseTime('7:30');
    ok(t2 && t2.minutes === 450, '① "7:30"（单位小时）也接受', t2);
    const t3 = S._parseTime('0730');
    ok(t3 && t3.minutes === 450, '① "0730"（无冒号）也接受', t3);
    eq(S._parseTime('00:00').minutes, 0, '① "00:00" → 0（午夜合法）');
    eq(S._parseTime('23:59').minutes, 1439, '① "23:59" → 1439（当天最后一分钟）');
    eq(S._parseTime('25:99'), null, '① "25:99" 非法 → null');
    eq(S._parseTime('24:00'), null, '① "24:00" 越界 → null');
    eq(S._parseTime('07:60'), null, '① "07:60" 分钟越界 → null');
    eq(S._parseTime('7:5'), null, '① "7:5"（分钟不足两位）→ null');
    eq(S._parseTime('abc'), null, '① "abc" → null');
    eq(S._parseTime(''), null, '① 空串 → null（关闭）');
    eq(S._parseTime('  '), null, '① 纯空白 → null（关闭）');
    eq(S._parseTime(null), null, '① null → null');
    eq(S._parseTime('07:30:00'), null, '① 带秒 "07:30:00" → null');
  }

  /* ================== ② checkDue 调度语义 ================== */

  /* ②-1 时间未到：不执行、不写 lastRun */
  {
    const env = makeEnv({ prefs: { [PREFIX + 'scheduleDailyDigest']: '09:00' } });
    const done = await env.S.checkDue(new Date(2026, 9, 18, 8, 0, 0));
    eq(done.length, 0, '② 时间未到 → 不执行');
    eq(env.notes.length, 0, '② 时间未到 → 不生成笔记');
    eq(env.prefs('scheduleLastRun'), undefined, '② 时间未到 → 不写 lastRun');
  }

  /* ②-2 到点未跑：执行 + 记 lastRun */
  {
    const env = makeEnv({ prefs: { [PREFIX + 'scheduleDailyDigest']: '07:30' } });
    const done = await env.S.checkDue(AT);
    eq(JSON.stringify(done), '["digest"]', '② 到点 → 执行 digest（返回 jobId）');
    eq(env.notes.length, 1, '② 到点 → 生成 1 条笔记');
    eq(env.lastRun().digest, DAY, '② 到点 → lastRun 记当天');
    eq(env.notes[0].html.indexOf('研究晨报 ' + DAY) >= 0, true, '② 笔记标题带当天日期');
  }

  /* ②-3 当天已跑：不重复 */
  {
    const env = makeEnv({
      prefs: {
        [PREFIX + 'scheduleDailyDigest']: '07:30',
        [PREFIX + 'scheduleLastRun']: JSON.stringify({ digest: DAY }),
      },
    });
    const done = await env.S.checkDue(AT);
    eq(done.length, 0, '② 当天已跑 → 跳过');
    eq(env.notes.length, 0, '② 当天已跑 → 不重复建笔记');
    eq(env.lastRun().digest, DAY, '② 当天已跑 → lastRun 保持不变');
  }

  /* ②-4 跨天重置：昨天跑过 → 今天照跑 */
  {
    const env = makeEnv({
      prefs: {
        [PREFIX + 'scheduleDailyDigest']: '07:30',
        [PREFIX + 'scheduleLastRun']: JSON.stringify({ digest: '2026-10-17' }),
      },
    });
    const done = await env.S.checkDue(AT);
    eq(JSON.stringify(done), '["digest"]', '② 跨天 → 昨天跑过不影响今天');
    eq(env.lastRun().digest, DAY, '② 跨天 → lastRun 更新为今天');
  }

  /* ②-5 坏格式跳过 */
  {
    const env = makeEnv({
      prefs: {
        [PREFIX + 'scheduleDailyDigest']: '25:99',
        [PREFIX + 'scheduleWeeklyReport']: 'abc',
        [PREFIX + 'scheduleLibHealth']: '7:5',
      },
    });
    const done = await env.S.checkDue(AT);
    eq(done.length, 0, '② 三个 job 时间全坏 → 全部跳过');
    eq(env.notes.length, 0, '② 坏格式 → 不生成笔记');
  }

  /* ②-6 超过 6 小时窗口不补跑；边界（正好 6h）补跑 */
  {
    const env = makeEnv({ prefs: { [PREFIX + 'scheduleDailyDigest']: '00:30' } });
    const done = await env.S.checkDue(AT); // 00:30 → 08:00 已过 7.5h
    eq(done.length, 0, '② 错过 7.5 小时 → 不补跑');
    eq(env.notes.length, 0, '② 错过窗口 → 不生成笔记');
  }
  {
    const env = makeEnv({ prefs: { [PREFIX + 'scheduleDailyDigest']: '02:00' } });
    const done = await env.S.checkDue(AT); // 02:00 + 6h = 08:00，含边界
    eq(JSON.stringify(done), '["digest"]', '② 正好 6 小时边界 → 补跑');
  }

  /* ②-7 空 pref 全跳过 */
  {
    const env = makeEnv();
    const done = await env.S.checkDue(AT);
    eq(done.length, 0, '② 三个时间都为空 → 全部跳过');
    eq(env.calls.getAll, 0, '② 没有任务执行 → 完全不扫库');
  }

  /* ②-8 多 job 各自独立：各自按自己的时间命中 */
  {
    const env = makeEnv({
      prefs: {
        [PREFIX + 'scheduleDailyDigest']: '07:30',
        [PREFIX + 'scheduleWeeklyReport']: '08:00',
        [PREFIX + 'scheduleLibHealth']: '09:00',
      },
    });
    const done = await env.S.checkDue(AT); // 08:00
    eq(JSON.stringify(done), '["digest","weekly"]', '② 多 job：到点的两个执行，未到点的跳过');
    eq(env.notes.length, 2, '② 多 job：生成 2 条笔记');
    const last = env.lastRun();
    eq(last.digest, DAY, '② 多 job：digest 记 lastRun');
    eq(last.weekly, DAY, '② 多 job：weekly 记 lastRun');
    eq(last.health, undefined, '② 多 job：未执行的 health 不记 lastRun');
  }

  /* ②-9 lastRun pref 是脏 JSON → 视为空，不阻塞执行 */
  {
    const env = makeEnv({
      prefs: {
        [PREFIX + 'scheduleDailyDigest']: '07:30',
        [PREFIX + 'scheduleLastRun']: '{oops',
      },
    });
    const done = await env.S.checkDue(AT);
    eq(JSON.stringify(done), '["digest"]', '② 脏 lastRun → 容错并照常执行');
  }

  /* ②-10 任务执行失败：不抛出，仍记 lastRun（当天不再反复重试） */
  {
    const env = makeEnv({
      prefs: { [PREFIX + 'scheduleDailyDigest']: '07:30' },
      items: () => { throw new Error('db down'); },
    });
    const done = await env.S.checkDue(AT);
    eq(JSON.stringify(done), '["digest"]', '② Items 抛错 → 调度仍算已执行');
    eq(env.lastRun().digest, DAY, '② Items 抛错 → 记 lastRun，避免每分钟重试');
    ok(env.diags.length > 0, '② Items 抛错 → 写日志（_diag）');
    has(env.notes[0].html, '今日无新增文献', '② Items 抛错 → 降级为空态笔记');
  }

  /* ================== ③ runJob(digest) ================== */

  function digestEnv(items) {
    return makeEnv({ items: items });
  }

  /* ③-1 有新增：只收 24h 内的条目，带标题/作者/年份/分类 */
  {
    const recent = new Date(AT.getTime() - 2 * 3600 * 1000);
    const old = new Date(AT.getTime() - 48 * 3600 * 1000);
    const env = digestEnv([
      mkItem({
        dateAdded: sqlUTC(recent),
        fields: { title: 'Attention Is All You Need', date: '2017-06-12' },
        creators: [{ lastName: 'Vaswani', firstName: 'Ashish' }, { lastName: 'Shazeer', firstName: 'Noam' }],
        collections: [7],
      }),
      mkItem({ dateAdded: sqlUTC(old), fields: { title: 'Old Paper', date: '2010' } }),
    ]);
    const r = await env.S.runJob('digest', AT);
    eq(r.ok, true, '③ digest 返回 ok');
    eq(r.noteTitle, '研究晨报 ' + DAY, '③ digest 笔记标题 = 研究晨报 YYYY-MM-DD');
    eq(env.notes.length, 1, '③ digest 生成 1 条独立笔记');
    const html = env.notes[0].html;
    has(html, 'Attention Is All You Need', '③ 清单含新增文献标题');
    has(html, 'Vaswani', '③ 清单含作者');
    has(html, '(2017)', '③ 清单含年份');
    has(html, '分类：分类7', '③ 清单含分类名');
    notHas(html, 'Old Paper', '③ 48 小时前的条目不计入');
    has(html, '新增 **1** 篇', '③ 概览数量正确');
  }

  /* ③-2 0 新增：空态文案 */
  {
    const env = digestEnv([]);
    const r = await env.S.runJob('digest', AT);
    eq(r.ok, true, '③ digest 空库仍返回 ok');
    has(env.notes[0].html, '今日无新增文献', '③ 0 新增 → 空态文案');
    eq(/研究晨报 /.test(r.noteTitle), true, '③ 空态也有规范标题');
  }

  /* ③-3 上限 30 条 */
  {
    const items = [];
    for (let i = 0; i < 40; i++) {
      const t = new Date(AT.getTime() - (i + 1) * 60000);
      items.push(mkItem({
        dateAdded: sqlUTC(t),
        fields: { title: 'Paper ' + String(i + 1).padStart(2, '0') },
      }));
    }
    const env = digestEnv(items);
    await env.S.runJob('digest', AT);
    const html = env.notes[0].html;
    eq((html.match(/Paper \d\d/g) || []).length, 30, '③ 40 条新增只列前 30 条');
    has(html, '下列前 30 篇', '③ 超出上限时明确提示');
  }

  /* ③-4 dateAdded 解析：UTC SQL 串按 UTC 解析，不因时区把 24h 边界算错 */
  {
    const boundary = new Date(AT.getTime() - 23 * 3600 * 1000 - 59 * 60000);
    const env = digestEnv([mkItem({ dateAdded: sqlUTC(boundary), fields: { title: 'Boundary' } })]);
    await env.S.runJob('digest', AT);
    has(env.notes[0].html, 'Boundary', '③ 23h59m 前的条目仍算 24h 内');
  }

  /* ③-5 手工运行不写 lastRun（否则会吞掉当天的定时执行） */
  {
    const env = digestEnv([]);
    await env.S.runJob('digest', AT);
    eq(env.prefs('scheduleLastRun'), undefined, '③ runJob 不写 lastRun');
  }

  /* ================== ④ runJob(weekly) / runJob(health) 降级 ================== */

  /* ④-1 weekly：ReadingStats 缺位 → 库统计兜底，不抛错 */
  {
    const env = makeEnv({
      items: [
        mkItem({ dateAdded: sqlUTC(new Date(2026, 9, 2, 9, 0, 0)), fields: { title: 'A' } }),
        mkItem({ dateAdded: sqlUTC(new Date(2026, 8, 2, 9, 0, 0)), fields: { title: 'B' } }),
      ],
    });
    const r = await env.S.runJob('weekly', AT);
    eq(r.ok, true, '④ weekly 在 ReadingStats 缺位时仍 ok');
    eq(/^阅读周报 2026-W\d{2}$/.test(r.noteTitle), true, '④ weekly 标题 = 阅读周报 YYYY-Www', r.noteTitle);
    const html = env.notes[0].html;
    has(html, '阅读统计模块未就绪', '④ weekly 明确说明统计模块缺席');
    has(html, '条目总数：2', '④ weekly 输出库概况兜底');
    has(html, '本月新增：1', '④ weekly 统计本月新增');
  }

  /* ④-2 weekly：ReadingStats 可用 → 用其聚合结果 */
  {
    const ReadingStats = {
      load() { return { schema: 1, days: {} }; },
      aggregate() {
        return {
          totalMin: 95,
          perDay: [{ day: '2026-10-12', min: 60 }, { day: '2026-10-13', min: 35 }],
          topItems: [],
          activeDays: 2,
          avgPerActiveDay: 48,
        };
      },
      human(m) { return m + ' 分钟'; },
    };
    const env = makeEnv({ prefs: {}, items: [], ReadingStats: ReadingStats });
    const r = await env.S.runJob('weekly', AT);
    eq(r.ok, true, '④ weekly 调用 ReadingStats 成功');
    has(env.notes[0].html, '总时长：**95 分钟**', '④ weekly 总时长来自 ReadingStats.aggregate');
    has(env.notes[0].html, '2026-10-12：60 分钟', '④ weekly 列出每日时长');
  }

  /* ④-3 weekly：ReadingProgress 可用 → 补一条进度统计 */
  {
    const ReadingProgress = {
      snapshot() { return { K1: { p: 100, t: 60 }, K2: { p: 2, t: 3 } }; },
      compute(o) { return { pct: o.page >= 100 ? 1 : 0.1 }; },
    };
    const env = makeEnv({ prefs: {}, items: [], ReadingProgress: ReadingProgress });
    await env.S.runJob('weekly', AT);
    has(env.notes[0].html, '读完（≥95%）：1 篇', '④ weekly 统计已读完篇数');
  }

  /* ④-4 health：MetaLint 缺位 → 轻量检查兜底 */
  {
    const env = makeEnv({
      items: [
        mkItem({ fields: { title: 'No Attachment No DOI' }, attachments: [], creators: [] }),
        mkItem({ fields: { title: 'Deep Learning for Graphs', DOI: '10.1/x' }, attachments: [1] }),
        mkItem({ fields: { title: 'deep learning for graphs!', DOI: '10.1/y' }, attachments: [2] }),
      ],
    });
    const r = await env.S.runJob('health', AT);
    eq(r.ok, true, '④ health 在 MetaLint 缺位时仍 ok');
    eq(r.noteTitle, '库体检报告 ' + DAY, '④ health 标题 = 库体检报告 YYYY-MM-DD');
    const html = env.notes[0].html;
    has(html, '常规条目：3', '④ health 概览条目数');
    has(html, '无附件：1', '④ health 统计无附件');
    has(html, '缺 DOI：1', '④ health 统计缺 DOI');
    has(html, '疑似重复标题：1 组', '④ health 检测重复标题（大小写/标点归一）');
    has(html, '《Deep Learning for Graphs》— 2 条', '④ health 列出重复组');
    notHas(html, '可规范化元数据', '④ health 无 MetaLint 时不出现该节');
  }

  /* ④-5 health：MetaLint 可用 → 附加可规范化项 */
  {
    const MetaLint = {
      scan(item) {
        return item.getField('DOI') === 'doi:BAD' ? [{ rule: 'doi', field: 'DOI', from: 'doi:BAD', to: 'bad' }] : [];
      },
    };
    const env = makeEnv({
      items: [mkItem({ fields: { title: 'Bad DOI Paper', DOI: 'doi:BAD' }, attachments: [1] })],
      MetaLint: MetaLint,
    });
    const r = await env.S.runJob('health', AT);
    eq(r.ok, true, '④ health 调 MetaLint.scan 成功');
    has(env.notes[0].html, '可规范化元数据：1 条', '④ health 统计 MetaLint 命中条数');
    has(env.notes[0].html, 'Bad DOI Paper（DOI）', '④ health 列出可规范化条目与字段');
  }

  /* ④-6 Items.getAll 抛错 → 三个任务都降级为 ok（不把异常抛给面板） */
  {
    for (const id of ['digest', 'weekly', 'health']) {
      const env = makeEnv({ items: () => { throw new Error('boom'); } });
      const r = await env.S.runJob(id, AT);
      eq(r.ok, true, '④ ' + id + ' 遇 Items 抛错仍返回 ok');
      eq(env.notes.length, 1, '④ ' + id + ' 仍能写出降级报告');
    }
  }

  eq(typeof makeEnv().S.runJob, 'function', '④ runJob 存在');
  {
    const env = makeEnv();
    const r = await env.S.runJob('nope', AT);
    eq(r.ok, false, '④ 未知 jobId → ok:false');
    has(r.error, 'unknown job', '④ 未知 jobId 给出原因');
  }

  /* ================== ⑤ state() ================== */

  {
    const env = makeEnv({
      prefs: {
        [PREFIX + 'scheduleDailyDigest']: '07:30',
        [PREFIX + 'scheduleWeeklyReport']: '',
        [PREFIX + 'scheduleLibHealth']: '0730',
        [PREFIX + 'scheduleLastRun']: JSON.stringify({ health: '2026-10-17' }),
      },
    });
    const st = env.S.state();
    eq(st.length, 3, '⑤ state() 返回三个 job');
    eq(st[0].id, 'digest', '⑤ 第一个是 digest');
    eq(st[0].enabled, true, '⑤ digest 07:30 → 已启用');
    eq(st[0].time, '07:30', '⑤ state 回显时间');
    eq(st[1].enabled, false, '⑤ weekly 空时间 → 未启用');
    eq(st[2].enabled, true, '⑤ health "0730" → 已启用（无冒号也接受）');
    eq(st[2].lastRun, '2026-10-17', '⑤ state 回显上次运行日期');
    eq(st[0].lastRun, '', '⑤ 未运行 → 空串');
    eq(st[0].label, '每日研究晨报', '⑤ state 带中文标签');
  }

  /* ================== ⑥ start / stop ================== */

  /* ⑥-1 幂等：两次 start 只建一个 interval */
  {
    const env = makeEnv();
    env.S.start();
    env.S.start();
    eq(env.intervals.length, 1, '⑥ 两次 start 只创建一个 interval');
    eq(env.intervals[0].ms, 60000, '⑥ 轮询间隔 60s');
    const first = await env.S._startupCheck;
    eq(Array.isArray(first), true, '⑥ start 先跑一次 checkDue（返回 jobId 数组）');
    env.S.stop();
    eq(env.intervals[0].cleared, true, '⑥ stop 清掉 interval');
  }

  /* ⑥-2 start 的启动检查真的会执行到点任务 */
  {
    const now = new Date();
    const t = duePrefs(now.getHours() * 60 + now.getMinutes());
    const env = makeEnv({ prefs: { [PREFIX + 'scheduleDailyDigest']: t } });
    env.S.start();
    const done = await env.S._startupCheck;
    eq(JSON.stringify(done), '["digest"]', '⑥ 启动检查命中当前分钟 → 立即执行');
    eq(env.notes.length, 1, '⑥ 启动检查生成笔记');
    env.S.stop();
  }

  /* ⑥-3 stop 可重复调用；stop 后 start 可重新启动 */
  {
    const env = makeEnv();
    env.S.stop();
    eq(env.S._timer, null, '⑥ 未启动时 stop 安全（_timer=null）');
    env.S.start();
    const firstId = env.S._timer;
    eq(typeof firstId === 'number', true, '⑥ start 记下 interval id');
    env.S.stop();
    eq(env.S._timer, null, '⑥ stop 后 _timer 清空');
    env.S.start();
    eq(env.intervals.length, 2, '⑥ 重新 start 会建新 interval（旧的不叠加）');
    eq(env.intervals[1].id !== firstId, true, '⑥ 新 interval 是新 id');
    env.S.stop();
  }

  /* ⑥-4 轮询回调重复触发不会重复建笔记 */
  {
    const env = makeEnv({ prefs: { [PREFIX + 'scheduleDailyDigest']: '07:30' } });
    const now = new Date();
    env.store.set(PREFIX + 'scheduleDailyDigest', duePrefs(now.getHours() * 60 + now.getMinutes()));
    env.S.start();
    await env.S._startupCheck;
    const rec = env.intervals[0];
    // 再触发一次（同一天）——应跳过
    const saved = rec.fn;
    saved();
    await env.S._lastCheck;
    eq(env.notes.length, 1, '⑥ 同一天第二次轮询不重复建笔记');
    env.S.stop();
  }

} // main

/* ---------------- 汇总 ---------------- */

main().then(function () {
  report();
}).catch(function (e) {
  console.error('✗ 测试执行异常：' + (e && (e.stack || e.message) || e));
  process.exit(1);
});

function report() {
  if (fails.length) {
    console.error('\n✗ 定时任务测试失败 ' + fails.length + ' 项 / ' + (pass + fails.length) + ' 项断言');
    for (const f of fails) console.error('  - ' + f);
    process.exit(1);
}
console.log('✓ 定时任务测试通过：' + pass + ' 项断言');
}
