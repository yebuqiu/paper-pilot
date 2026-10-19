// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 账号后台 · 收款流水对账（服务端 1.4.5）
 *
 * 解决什么：人工核销是运营瓶颈 —— 用户付了钱要等人点一下，夜里下单就干等。
 * 做法（零支付资质，纯对账自动化）：**下单时给每笔订单分配一个同金额内唯一的小数尾数**
 * （见 membership.js 的 assignTail），于是收款流水只要按金额就能唯一确定是哪一笔订单。
 *
 *   128.62 → 订单 o-xxxx（Pro 永久 ¥128）
 *   128.35 → 订单 o-yyyy（Pro 永久 ¥128）
 *
 * 这里只做**纯匹配**（不碰数据、不落盘、不授予），便于单测；真正的核销由
 * account-server 在 apply 阶段调用 fulfillOrder + grantMembership，并写审计。
 *
 * 匹配规则
 *   · 金额：**精确到分**（amountCents === 订单实付分）。多付/少付一律不匹配 → 人工处理。
 *   · 时间：流水时间必须落在 [订单创建 - 10 分钟, 订单创建 + windowDays 天]。
 *     10 分钟是给两端时钟偏差留的余量；窗口默认 30 天（可配）。
 *   · 状态：只匹配 pending（未点「已支付」）与 claimed（已点，待核销）两种未完成订单。
 *   · 唯一性：正常情况一金额只对应一单。若命中多单（历史遗留的同价订单）→ 标 `ambiguous`
 *     并列出候选，**不自动核销**（涉及资金，宁可让人看一眼）。
 *   · 去重：同一批流水里，已经匹配过的订单不再被第二次匹配（标 `duplicate`）。
 */
'use strict';

const DEFAULTS = { windowDays: 30, skewMs: 10 * 60e3 };

const STATUS_TEXT = {
  matched: '命中',
  unmatched: '无对应订单',
  ambiguous: '多笔同价，需人工确认',
  duplicate: '重复流水（该订单本批已匹配过）',
  settled: '订单已是完成状态',
};

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/**
 * 把一行文本解析成 { amountCents, at, note, txnId }。
 * 容忍：`¥` / 全角逗号 / 只用金额（时间为空 → 用「现在」）；返回 null 表示这行不是有效流水。
 */
function parseLine(line, nowDefault) {
  const raw = String(line == null ? '' : line).trim();
  if (!raw || raw.startsWith('#')) return null;
  const parts = raw.replace(/，/g, ',').split(',').map((x) => x.trim());
  const amountTxt = parts[0].replace(/[¥￥\s]/g, '');
  const n = Number(amountTxt);
  if (!Number.isFinite(n) || n <= 0) return null;
  const amountCents = Math.round(n * 100);
  const atTxt = parts[1] || '';
  const at = atTxt ? Date.parse(atTxt.replace(/\//g, '-').replace(' ', 'T')) : 0;
  return {
    amountCents,
    at: Number.isFinite(at) && at > 0 ? at : (nowDefault || Date.now()),
    atGiven: !!atTxt,
    note: parts[2] || '',
    txnId: parts[3] || '',
    raw,
  };
}

/** 批量解析（粘贴的多行文本 / CSV 内容） */
function parseEntries(text, nowDefault) {
  const out = [];
  for (const line of String(text == null ? '' : text).split(/\r?\n/)) {
    const e = parseLine(line, nowDefault);
    if (e) out.push(e);
  }
  return out;
}

const money = (cents) => '¥' + (Number(cents) || 0) / 100;

/** 订单实付金额（分）；旧订单由 membership 的换算口径统一处理 */
function orderCents(order, membership) {
  if (Number.isFinite(order.amountCents) && order.amountCents > 0) return Math.round(order.amountCents);
  if (membership && typeof membership.amountCentsOf === 'function') return membership.amountCentsOf(order);
  return Math.round((Number(order.amount) || 0) * 100);
}

/**
 * 匹配一批收款流水。
 * @param doc        membership 文档（含 orders）
 * @param entries    parseEntries / parseLine 出来的数组
 * @param opts       { now, windowDays, skewMs, membership } —— membership 只用于旧订单金额换算
 * @returns { results, summary }
 */
function matchPayments(doc, entries, opts) {
  const o = opts || {};
  const now = o.now || Date.now();
  const windowDays = num(o.windowDays, DEFAULTS.windowDays);
  const skewMs = num(o.skewMs, DEFAULTS.skewMs);
  const orders = (doc && doc.orders) || [];
  const used = new Set();
  const results = [];

  for (const entry of entries || []) {
    const base = { entry, amountCents: entry.amountCents, amountText: money(entry.amountCents) };
    // 候选：金额精确相同 + 未完成状态 + 在时间窗内
    const cands = orders.filter((od) => {
      if (!od) return false;
      if (od.status !== 'pending' && od.status !== 'claimed') return false;
      if (orderCents(od, o.membership) !== entry.amountCents) return false;
      const created = Date.parse(od.createdAt) || 0;
      if (!created) return false;
      return entry.at >= created - skewMs && entry.at <= created + windowDays * 86400e3;
    });
    if (!cands.length) {
      // 金额能对上但状态已终态（已被核销/取消）→ 给更有用的提示
      const settled = orders.filter((od) => od && (od.status === 'fulfilled')
        && orderCents(od, o.membership) === entry.amountCents);
      results.push(Object.assign(base, {
        status: 'unmatched',
        reason: settled.length
          ? '该金额对应的订单已完成/已取消（' + settled.length + ' 笔），无需重复核销'
          : '没有金额与时间窗匹配的待核销订单（金额需精确到分，含尾数）',
        candidateOrderIds: settled.slice(0, 5).map((x) => x.id),
      }));
      continue;
    }
    const free = cands.filter((x) => !used.has(x.id));
    if (!free.length) {
      results.push(Object.assign(base, {
        status: 'duplicate',
        orderId: cands[0].id, email: cands[0].email,
        reason: '本批流水里该订单已经匹配过一次，跳过以避免重复核销',
      }));
      continue;
    }
    if (free.length > 1) {
      results.push(Object.assign(base, {
        status: 'ambiguous',
        reason: '有 ' + free.length + ' 笔订单金额相同（历史遗留的同价订单），需人工确认',
        candidates: free.slice(0, 8).map((x) => ({ orderId: x.id, email: x.email, createdAt: x.createdAt })),
      }));
      continue;
    }
    const hit = free[0];
    used.add(hit.id);
    results.push(Object.assign(base, {
      status: 'matched',
      orderId: hit.id, email: hit.email, userId: hit.userId,
      plan: hit.plan, months: hit.months, perpetual: !!hit.perpetual,
      orderStatus: hit.status,
      createdAt: hit.createdAt,
    }));
  }

  return { results, summary: summarize(results) };
}

function summarize(results) {
  const s = { total: 0, matched: 0, unmatched: 0, ambiguous: 0, duplicate: 0, matchedCents: 0 };
  for (const r of results || []) {
    s.total += 1;
    if (s[r.status] !== undefined) s[r.status] += 1;
    if (r.status === 'matched') s.matchedCents += r.amountCents;
  }
  s.matchedText = money(s.matchedCents);
  return s;
}

module.exports = {
  DEFAULTS, STATUS_TEXT,
  parseLine, parseEntries, matchPayments, summarize, money, orderCents,
};
