// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 账号后台 · 订单积压告警（1.4.2）
 *
 * 为什么需要：用户付款后在插件里点「我已完成支付」→ 订单变 claimed → 等管理员核销。
 * 这一步全靠人主动点开后台看，夜里下单就可能干等到早上——"付了钱没人管"是最伤信任的故障。
 *
 * 只把 claimed（已付款待核销）算作积压；pending（用户还没付款）不算——
 * 否则每个没付款的订单都会制造噪音。
 *
 * 去重：以「当前最老的那笔 claimed 订单」为 key。最老订单换了（说明有人处理了旧的）
 * 立即再提醒；同一个最老订单则隔 PP_ALERT_REPEAT_H（默认 6 小时）才重复提醒一次。
 * 状态存 data/alerts.json，重启不丢。
 */
'use strict';

const DEFAULT_THRESHOLD_MIN = 30;
const DEFAULT_REPEAT_H = 6;

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

function thresholdMin() { return num(process.env.PP_ALERT_BACKLOG_MIN, DEFAULT_THRESHOLD_MIN); }
function repeatMs() { return num(process.env.PP_ALERT_REPEAT_H, DEFAULT_REPEAT_H) * 3600e3; }

/**
 * 计算待核销积压。
 * 返回 { count, oldestId, oldestAt, oldestMinutes, over, thresholdMin }
 */
function backlogOf(doc, { now, threshold } = {}) {
  const t = now || Date.now();
  const th = num(threshold, thresholdMin());
  const claimed = (doc && Array.isArray(doc.orders) ? doc.orders : [])
    .filter((o) => o && o.status === 'claimed');
  if (!claimed.length) {
    return { count: 0, oldestId: null, oldestAt: null, oldestMinutes: 0, over: false, thresholdMin: th };
  }
  const when = (o) => Date.parse(o.claimedAt || o.createdAt) || 0;
  let oldest = claimed[0];
  for (const o of claimed) if (when(o) < when(oldest)) oldest = o;
  const oldestAt = oldest.claimedAt || oldest.createdAt;
  const minutes = Math.max(0, Math.round((t - when(oldest)) / 60000));
  return {
    count: claimed.length, oldestId: oldest.id, oldestAt,
    oldestMinutes: minutes, over: minutes >= th, thresholdMin: th,
  };
}

/** 是否该提醒（最老订单换了立刻提醒；同一笔按 repeat 窗口节流） */
function shouldAlert(state, backlog, { now, repeat } = {}) {
  if (!backlog || !backlog.count || !backlog.over) return false;
  const t = now || Date.now();
  const s = state || {};
  if (!s.lastAlertAt || s.lastAlertKey !== backlog.oldestId) return true;
  return (t - (Date.parse(s.lastAlertAt) || 0)) >= num(repeat, repeatMs());
}

/** 记录一次告警（就地修改并返回 state） */
function record(state, backlog, { mailed, now } = {}) {
  const s = state && typeof state === 'object' ? state : {};
  const at = new Date(now || Date.now()).toISOString();
  s.lastAlertAt = at;
  s.lastAlertKey = backlog.oldestId;
  s.lastCount = backlog.count;
  s.lastOldestMinutes = backlog.oldestMinutes;
  s.lastMailed = !!mailed;
  s.history = (Array.isArray(s.history) ? s.history : []).slice(-19);
  s.history.push({
    at, orderId: backlog.oldestId, count: backlog.count,
    oldestMinutes: backlog.oldestMinutes, mailed: !!mailed,
  });
  return s;
}

/** alerts.log 的一行（纯文本，方便 grep） */
function logLine(backlog) {
  return 'BACKLOG count=' + backlog.count
    + ' oldest=' + backlog.oldestId
    + ' waiting=' + backlog.oldestMinutes + 'min'
    + ' threshold=' + backlog.thresholdMin + 'min';
}

/** 告警邮件内容（未配邮件服务时只写日志，不报错） */
function buildMail(backlog, platform) {
  const h = Math.floor(backlog.oldestMinutes / 60);
  const m = backlog.oldestMinutes % 60;
  const waited = h > 0 ? (h + ' 小时 ' + m + ' 分钟') : (m + ' 分钟');
  return {
    subject: '【Papilot】有 ' + backlog.count + ' 笔订单待核销，最久已等 ' + waited,
    text: '有已付款订单在等待核销：\n\n'
      + '· 待核销订单数：' + backlog.count + '\n'
      + '· 最老订单：' + backlog.oldestId + '\n'
      + '· 已等待：' + waited + '（下单时间 ' + backlog.oldestAt + '）\n'
      + '· 触发阈值：' + backlog.thresholdMin + ' 分钟\n\n'
      + '处理入口：' + (platform.serverUrl || '') + '\n'
      + '  启动器 → 账号管理 → 会员管理 → 订单 → 核销开通\n'
      + '  或浏览器打开 ' + (platform.serverUrl || '') + '/admin → 会员管理 → 订单\n\n'
      + '（核对收款后点「核销开通」即自动为该账号叠加会员）\n',
  };
}

/** 给后台/health 用的紧凑视图 */
function view(state, backlog) {
  const s = state || {};
  return {
    backlogCount: backlog ? backlog.count : 0,
    backlogOldestMinutes: backlog ? backlog.oldestMinutes : 0,
    backlogOverdue: !!(backlog && backlog.over),
    thresholdMin: backlog ? backlog.thresholdMin : thresholdMin(),
    lastAlertAt: s.lastAlertAt || null,
    lastAlertOrderId: s.lastAlertKey || null,
    lastMailed: !!s.lastMailed,
    history: Array.isArray(s.history) ? s.history.slice(-10) : [],
  };
}

module.exports = {
  DEFAULT_THRESHOLD_MIN, DEFAULT_REPEAT_H,
  thresholdMin, repeatMs, backlogOf, shouldAlert, record, logLine, buildMail, view,
};
