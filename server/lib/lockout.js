// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 账号后台 · 账号级登录风控（1.4.2）
 *
 * 为什么需要：原来只有「每 IP 每分钟 10 次」的限速——换个 IP 就能对着某个邮箱
 * 无限撞密码。IP 限速防的是扫描，账号级锁定防的是定向爆破，两者缺一不可。
 *
 * 规则
 *   · 同一账号连续失败 5 次 → 锁定；锁定期内**即使密码正确也拒绝**（否则锁定无意义），
 *     并在应答里给出剩余时间，避免用户以为密码错了反复试。
 *   · 阶梯升级：第 5 次锁 15 分钟，第 10 次锁 1 小时，第 15 次锁 6 小时，第 20 次起锁 24 小时。
 *     failCount 在锁到期后不清零 —— 继续失败会直接进入下一档，抑制"等一刻钟再来撞"。
 *   · 登录成功即清零（failCount / lockUntil / lastFailAt）。
 *   · 记录 lastFailIp，便于事后判断是不是分布式撞库。
 *
 * 不做账号枚举防护之外的花样：邮箱不存在时**不**写 user（没有对象可写），
 * 由 IP 限速兜底；应答文案与密码错误完全一致。
 */
'use strict';

const THRESHOLD = 5;              // 几次失败开始锁
const STEPS_MS = [15 * 60e3, 3600e3, 6 * 3600e3, 24 * 3600e3];

/** 第 failCount 次失败应锁多久（阶梯封顶 24 小时） */
function durationFor(failCount) {
  const reached = Math.floor((Number(failCount) || 0) / THRESHOLD);   // 1,2,3,4…
  if (reached < 1) return 0;
  const idx = Math.min(STEPS_MS.length - 1, reached - 1);
  return STEPS_MS[idx];
}

/** 当前锁定状态（不修改 user） */
function status(user, now) {
  const t = now || Date.now();
  const until = user && user.lockUntil ? Date.parse(user.lockUntil) || 0 : 0;
  const locked = until > t;
  return {
    failCount: Number(user && user.failCount) || 0,
    locked,
    lockUntil: until ? new Date(until).toISOString() : null,
    remainMs: locked ? until - t : 0,
    remainMinutes: locked ? Math.ceil((until - t) / 60000) : 0,
    lastFailAt: (user && user.lastFailAt) || null,
    lastFailIp: (user && user.lastFailIp) || null,
  };
}

/**
 * 记一次失败（就地修改 user）。到阈值就上锁。
 * 返回 { locked, lockUntil, remainMinutes, failCount }
 */
function registerFailure(user, { now, ip } = {}) {
  const t = now || Date.now();
  user.failCount = (Number(user.failCount) || 0) + 1;
  user.lastFailAt = new Date(t).toISOString();
  if (ip) user.lastFailIp = String(ip).slice(0, 64);
  const dur = durationFor(user.failCount);
  if (dur > 0) {
    const until = t + dur;
    // 只在比现有锁定更晚时才延长，避免"每次都从 15 分钟重算"把长时间锁降级
    const cur = user.lockUntil ? Date.parse(user.lockUntil) || 0 : 0;
    if (until > cur) user.lockUntil = new Date(until).toISOString();
  }
  return status(user, t);
}

/** 登录成功清零 */
function reset(user) {
  if (!user) return;
  user.failCount = 0;
  user.lockUntil = null;
  user.lastFailAt = null;
  delete user.lastFailIp;
}

/** 管理员手动解锁（清计数与锁定） */
function unlock(user) {
  reset(user);
  return status(user);
}

/** 锁定时的应答文案（含剩余时间，避免用户反复试） */
function lockedMessage(st) {
  const m = st.remainMinutes;
  const human = m >= 60 ? (Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分钟') : (m + ' 分钟');
  return '该账号因连续登录失败已被临时锁定，请 ' + human + ' 后再试；'
    + '若确认密码无误，可联系管理员在后台「用户列表」中一键解锁。';
}

/** 登录失败（未锁定）时的应答文案 —— 与"邮箱不存在"保持完全一致，不泄漏账号是否存在 */
const GENERIC_FAIL = '邮箱或密码错误';

module.exports = {
  THRESHOLD, STEPS_MS, durationFor, status, registerFailure, reset, unlock,
  lockedMessage, GENERIC_FAIL,
};
