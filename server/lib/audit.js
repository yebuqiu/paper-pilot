/* PaperPilot 账号后台 · 管理操作审计（服务端 1.4.4）
 *
 * 为什么需要：核销、改价、删除用户、回滚数据此前都没有留痕 —— 出了问题只能翻
 * server-console.log 里自然语言的 log() 行，既不好筛也不好导。这里记**结构化**的一条，
 * 一行一个 JSON（JSONL），可以直接 grep / 用脚本统计 / 导出 CSV。
 *
 * 一条长这样：
 *   { at, action, target, before, after, ip, note, ok }
 *
 * 设计
 *   · 文件 `data/audit.log`，追加写（append-only）；**绝不写入密钥/密码**（redact() 兜底，
 *     通道的 apiKey、用户密码等字段一律替换成 "***"）
 *   · 体积超过 PP_AUDIT_MAX_BYTES（默认 2MB）时轮转成 `audit.log.1`，只留 1 份历史
 *   · 读取走 list()：先读历史再读当前，**从尾部往前取**，不必把整文件解析成数组
 *   · **不参与数据快照**（backup.js 只快照业务 JSON）—— 日志不该被回滚带回去
 *   · 写入失败**绝不影响主流程**：审计是留痕，不是前置条件（调用方只记一条 console 日志）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const LOG_NAME = 'audit.log';
const ARCHIVE_NAME = 'audit.log.1';
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_STRING = 200;          // 单个字符串字段的落盘上限（避免把大 blob 塞进日志）

/** 动作 → 中文说明（后台直接展示，避免让运维去猜 action 代码） */
const ACTIONS = {
  'user.create': '新建用户',
  'user.update': '修改用户',
  'user.password': '重置密码',
  'user.delete': '删除用户',
  'user.unlock': '解除登录锁定',
  'user.membership': '开通/续期会员',
  'price.create': '新增价格条目',
  'price.update': '修改价格条目',
  'price.delete': '删除价格条目',
  'membership.config': '修改会员/收款配置',
  'order.fulfill': '核销开通订单',
  'order.cancel': '取消订单',
  'order.reconcile': '对账自动核销',
  'code.create': '生成激活码',
  'code.revoke': '作废激活码',
  'coupon.create': '生成优惠券',
  'coupon.update': '修改优惠券',
  'coupon.revoke': '作废优惠券',
  'session.revoke': '踢出登录设备',
  'session.revoke-others': '踢出其他全部设备',
  'session.revoke-admin': '管理员踢出设备',
  'session.label': '给设备命名',
  'backup.create': '手动打快照',
  'backup.restore': '回滚数据',
  'backup.delete': '删除快照',
  'alert.check': '手动巡检积压告警',
  'channel.create': '新增模型通道',
  'channel.update': '修改模型通道',
  'channel.delete': '删除模型通道',
  'channel.active': '切换活动通道',
  'channel.published': '修改上线模型清单',
  'channel.high-tier': '修改高级模型清单',
  'pricing.update': '修改 AI 模型单价',
  'balance.adjust': '充值/调整余额',
};

const SECRET_KEY = /(api.?key|token|password|passwd|secret|authorization|salt|hash|credential)/i;

/** 深度拷贝 + 脱敏：密钥类字段一律 "***"，超长字符串截断 */
function redact(v, depth) {
  const d = depth || 0;
  if (v == null) return v;
  if (typeof v === 'string') return v.length > MAX_STRING ? v.slice(0, MAX_STRING) + '…(' + v.length + ')' : v;
  if (typeof v !== 'object') return v;
  if (d > 6) return '…';
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redact(x, d + 1));
  const out = {};
  for (const k of Object.keys(v)) {
    out[k] = SECRET_KEY.test(k) ? '***' : redact(v[k], d + 1);
  }
  return out;
}

function isoOrNow(v) {
  const t = Date.parse(v);
  return Number.isNaN(t) ? new Date().toISOString() : new Date(t).toISOString();
}

/** 规范化一条审计记录（时间统一 ISO；对象做脱敏） */
function entry(raw) {
  const e = raw || {};
  return {
    at: isoOrNow(e.at),
    action: String(e.action || 'unknown'),
    target: String(e.target == null ? '' : e.target).slice(0, MAX_STRING),
    before: e.before === undefined ? null : redact(e.before),
    after: e.after === undefined ? null : redact(e.after),
    ip: String(e.ip || ''),
    note: String(e.note == null ? '' : e.note).slice(0, MAX_STRING),
    ok: e.ok === false ? false : true,
  };
}

function fileOf(dataDir) { return path.join(dataDir, LOG_NAME); }
function archiveOf(dataDir) { return path.join(dataDir, ARCHIVE_NAME); }

function maxBytesOf(v) {
  const n = Number(v != null ? v : process.env.PP_AUDIT_MAX_BYTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BYTES;
}

/** 超限就把当前日志轮转成 audit.log.1（旧的历史被覆盖） */
function rotateIfNeeded(dataDir, cap) {
  const p = fileOf(dataDir);
  let size = 0;
  try { size = fs.statSync(p).size; } catch (e) { return false; }
  if (size <= maxBytesOf(cap)) return false;
  try {
    fs.renameSync(p, archiveOf(dataDir));
    return true;
  } catch (e) {
    return false;   // 轮转失败不影响主流程，下一条再试
  }
}

/** 追加一条；返回 { ok, entry } 或 { ok:false, error }（调用方不应因此中断业务） */
function append(dataDir, raw, opts) {
  const e = entry(raw);
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(fileOf(dataDir), JSON.stringify(e) + '\n', 'utf8');
    const rotated = rotateIfNeeded(dataDir, opts && opts.maxBytes);
    return { ok: true, entry: e, rotated };
  } catch (err) {
    return { ok: false, error: err && err.message, entry: e };
  }
}

function readLines(p) {
  try { return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()); } catch (e) { return []; }
}

/**
 * 读取审计记录（**新的在前**）。
 * 先读历史再读当前（拼成时间升序），再从尾部往前筛，命中 limit 条即停。
 */
function list(dataDir, opts) {
  const o = opts || {};
  const limit = Math.max(1, Math.min(2000, Number(o.limit) || 100));
  const all = readLines(archiveOf(dataDir)).concat(readLines(fileOf(dataDir)));
  const out = [];
  const since = o.since ? Date.parse(o.since) : 0;
  const until = o.until ? Date.parse(o.until) : 0;
  for (let i = all.length - 1; i >= 0 && out.length < limit; i--) {
    let e = null;
    try { e = JSON.parse(all[i]); } catch (err) { continue; }   // 半截行/损坏行跳过
    if (o.action && e.action !== o.action) continue;
    if (o.target && String(e.target || '').indexOf(String(o.target)) < 0) continue;
    if (o.ok !== undefined && !!e.ok !== !!o.ok) continue;
    const t = Date.parse(e.at) || 0;
    if (since && t < since) continue;
    if (until && t > until) continue;
    out.push(e);
  }
  return out;
}

/** 给后台用的观测值（health 里带一眼） */
function stats(dataDir) {
  let bytes = 0, archiveBytes = 0;
  try { bytes = fs.statSync(fileOf(dataDir)).size; } catch (e) { /* 尚无 */ }
  try { archiveBytes = fs.statSync(archiveOf(dataDir)).size; } catch (e) { /* 无历史 */ }
  return { bytes, archiveBytes, maxBytes: maxBytesOf() };
}

const labelOf = (action) => ACTIONS[action] || action;

module.exports = {
  LOG_NAME, ARCHIVE_NAME, ACTIONS, DEFAULT_MAX_BYTES,
  redact, entry, append, list, stats, labelOf, fileOf, archiveOf, maxBytesOf,
};
