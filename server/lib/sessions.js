// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

'use strict';
/**
 * 登录设备与会话可观测（服务端 1.4.7）
 *
 * 为什么需要：`tokens` 表此前只有 `{userId, expiresAt}` —— 同一个账号可以从任意多台机器
 * 无限次登录，服务端**完全无法区分**两台机器和一台机器。共享账号（一个人买 Pro 给整个课题组用）
 * 因此不可见，用户也无从自查"我在几台机器上登录着"。
 *
 * ★ 先纠正一个容易做错的语义：**「同时在线设备数」在现有模型里没有可实现的定义。**
 * 令牌是 30 天滑动续期、靠请求续期，用户关掉 Zotero 并不会"下线"。能实现的只有两种判据：
 *   ① 活跃设备数 = 最近 N 天有请求的令牌数（本模块采用这个，语义诚实）② 并发在途请求数。
 *
 * 设计取舍：
 *   · **只观测，不处罚**（本版）。超阈值只写 alerts.log + 发管理员邮件 + 在后台标出来。
 *     「踢设备」是用户/管理员的**显式动作**，不做自动踢下线 —— 同一人台式+笔记本+实验室机器的
 *     场景很常见，自动踢的误伤成本远大于共享账号的损失；而且降级/踢下线不可逆，客服成本高。
 *   · **脱敏分层**：用户看自己的设备 → IP 打码（`1.2.3.*`）；管理员（仅本机直连）→ 完整 IP，
 *     否则出事时没法查。原始 IP 只落在 `users.json`，不进审计正文。
 *   · **绝不外泄令牌散列**：对外只给 `sid`（= tokenKey 前 8 位），它无法反推令牌。
 *   · 设备标识由插件上报（`deviceId` = 本机生成一次的 UUID）；**它是非敏感标识，不是凭据** ——
 *     可伪造，所以只用于「展示与异常检测」，绝不作为鉴权依据。
 *
 * 纯函数、无 IO —— 持久化由 account-server 的 JsonStore 负责，便于单测。
 */

const crypto = require('crypto');

const SID_LEN = 8;
const DEFAULT_ACTIVE_DAYS = 7;    // 「活跃」窗口
const DEFAULT_MAX_DEVICES = 3;    // 超过就告警（不处罚）
const DEFAULT_REPEAT_H = 6;       // 重复提醒窗口（小时）
const MAX_LABEL = 40;

const DAY_MS = 86400e3;

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

function activeDays() { return num(process.env.PP_SESSION_ACTIVE_DAYS, DEFAULT_ACTIVE_DAYS); }
function maxDevices() { return num(process.env.PP_SESSION_MAX_DEVICES, DEFAULT_MAX_DEVICES); }
function repeatMs() { return num(process.env.PP_SESSION_ALERT_REPEAT_H, DEFAULT_REPEAT_H) * 3600e3; }

/* ---------------- 标识与脱敏 ---------------- */

/** 对外可见的会话 id：令牌散列前 8 位（无法反推令牌，也不暴露完整散列） */
function sidOf(tokenKey) {
  return String(tokenKey || '').slice(0, SID_LEN);
}

/**
 * IP 打码（用户侧展示用）。
 * IPv4 → 保留前三段；IPv6 → 保留前两组。两者都只留下"大致网段"。
 */
function maskIp(ip) {
  const s = String(ip || '').trim();
  if (!s) return '';
  if (s.indexOf(':') >= 0) {
    const parts = s.split(':').filter(Boolean);
    return parts.length >= 2 ? (parts[0] + ':' + parts[1] + ':*') : (parts[0] || '') + ':*';
  }
  const oct = s.split('.');
  if (oct.length === 4) return oct[0] + '.' + oct[1] + '.' + oct[2] + '.*';
  return s;
}

/** 设备标签清洗：去掉控制字符、限长（用户可自定义设备名的将来会用到） */
function cleanLabel(v) {
  const s = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return s.slice(0, MAX_LABEL);
}

/** 取请求头值：HTTP 表头名**不区分大小写**，这里统一兜住（Node 给的是全小写，
 *  但直接调用本模块的代码可能传原始大小写形式） */
function pickHeader(headers, name) {
  const h = headers || {};
  if (h[name] !== undefined) return h[name];
  const lower = name.toLowerCase();
  for (const k of Object.keys(h)) {
    if (k.toLowerCase() === lower) return h[k];
  }
  return undefined;
}

/** 从请求头取设备信息（插件上报；缺失时全部为 null，不编造） */
function deviceFromHeaders(headers) {
  const dev = cleanLabel(pickHeader(headers, 'x-pp-device'));
  const label = cleanLabel(pickHeader(headers, 'x-pp-device-label'));
  const platform = cleanLabel(pickHeader(headers, 'x-pp-platform'));
  const zver = cleanLabel(pickHeader(headers, 'x-pp-zotero'));
  // deviceId 只接受十六进制/短横线（插件生成 UUID）；形状不对就当没上报，避免被塞任意内容
  const id = /^[0-9a-fA-F-]{8,64}$/.test(dev) ? dev.toLowerCase() : '';
  if (!id && !platform && !zver) return null;
  return { deviceId: id || null, deviceLabel: label || null, platform: platform || null, zoteroVersion: zver || null };
}

/* ---------------- 记录读写 ---------------- */

/** 新建令牌时写入设备与起始信息（就地修改 rec） */
function recordStart(rec, { tokenKey, ip, device, now } = {}) {
  if (!rec) return rec;
  const t = Number.isFinite(now) ? now : Date.now();
  rec.sid = rec.sid || sidOf(tokenKey);
  rec.createdAt = rec.createdAt || new Date(t).toISOString();
  rec.createdIp = rec.createdIp || String(ip || '');
  rec.lastSeenAt = rec.lastSeenAt || rec.createdAt;
  rec.lastSeenIp = rec.lastSeenIp || rec.createdIp;
  if (device) {
    // 设备标识只在首次登录时写入；后续请求只补充缺失字段，避免"最后一台机器覆盖全部"
    rec.deviceId = rec.deviceId || device.deviceId;
    rec.deviceLabel = rec.deviceLabel || device.deviceLabel;
    rec.platform = rec.platform || device.platform;
    rec.zoteroVersion = device.zoteroVersion || rec.zoteroVersion;
  }
  return rec;
}

/** 每次已认证请求更新"最近活动"（就地修改 rec） */
function recordSeen(rec, { ip, now } = {}) {
  if (!rec) return rec;
  const t = Number.isFinite(now) ? now : Date.now();
  rec.lastSeenAt = new Date(t).toISOString();
  if (ip) rec.lastSeenIp = String(ip);
  return rec;
}

/**
 * 给设备起名（用户给自己的设备命名，如「办公室台式」）。
 * 空串 = 清空回落到默认展示。理由：本机拿不到可靠主机名（Zotero 10 的 Firefox 基座
 * 已移除 Services.sysinfo），由用户自己命名既能达到「认出是哪台机器」的目的，
 * 又符合最小必要原则（不上报主机名等更多标识）。
 */
function setLabel(rec, label) {
  if (!rec) return false;
  rec.deviceLabel = cleanLabel(label) || null;
  return true;
}

/** 兼容历史令牌：老记录没有 sid/createdAt，读取时按需现场补齐。
 *  返回 true 表示**确实改动了记录**（调用方据此决定要不要落盘）。 */
function backfill(rec, tokenKey) {
  if (!rec) return false;
  let changed = false;
  if (!rec.sid) { rec.sid = sidOf(tokenKey); changed = true; }
  if (rec.createdAt === undefined) { rec.createdAt = rec.lastSeenAt || null; changed = true; }
  if (rec.createdIp === undefined) { rec.createdIp = ''; changed = true; }
  if (rec.lastSeenIp === undefined) { rec.lastSeenIp = ''; changed = true; }
  return changed;
}

/* ---------------- 查询 ---------------- */

function atOf(rec) {
  return Date.parse(rec.lastSeenAt || rec.createdAt) || 0;
}

function isActive(rec, { now, activeDays: days } = {}) {
  const t = Number.isFinite(now) ? now : Date.now();
  const d = num(days, activeDays());
  const at = atOf(rec);
  return at > 0 && (t - at) <= d * DAY_MS;
}

/**
 * 某用户的全部会话，按最近活动降序。
 * 返回 `{ list, changed }`：`changed=true` 说明有老令牌被现场补齐了 sid/createdAt，
 * **调用方应当落盘一次**；否则读取路径不必写盘（`GET /api/sessions` 会被频繁调用）。
 */
function sessionsOfDetailed(doc, userId, { now, activeDays: days } = {}) {
  const t = Number.isFinite(now) ? now : Date.now();
  const out = [];
  let changed = false;
  for (const [tok, rec] of Object.entries((doc && doc.tokens) || {})) {
    if (!rec || rec.userId !== userId) continue;
    // 过期令牌不算设备（pruneTokens 尚未跑到时也能给出正确视图）
    if (!(Number(rec.expiresAt) > t)) continue;
    if (backfill(rec, tok)) changed = true;
    out.push(rec);
  }
  out.sort((a, b) => atOf(b) - atOf(a));
  return { list: out, changed };
}

/** 只要列表（不关心是否需要落盘时用） */
function sessionsOf(doc, userId, opts) {
  return sessionsOfDetailed(doc, userId, opts).list;
}

function countActive(doc, userId, { now, activeDays: days } = {}) {
  return sessionsOf(doc, userId, { now, activeDays: days })
    .filter((r) => isActive(r, { now, activeDays: days })).length;
}

/** 全局活跃会话数（health / 后台概览用）；同样可能补齐老令牌 */
function countActiveAll(doc, { now, activeDays: days } = {}) {
  return countActiveAllDetailed(doc, { now, activeDays: days }).count;
}

function countActiveAllDetailed(doc, { now, activeDays: days } = {}) {
  const t = Number.isFinite(now) ? now : Date.now();
  let n = 0;
  let changed = false;
  for (const [tok, rec] of Object.entries((doc && doc.tokens) || {})) {
    if (!rec || !(Number(rec.expiresAt) > t)) continue;
    if (backfill(rec, tok)) changed = true;
    if (isActive(rec, { now: t, activeDays: days })) n++;
  }
  return { count: n, changed };
}

/** 是否有任何老令牌需要补齐（写入路径的守卫用） */
function needsBackfill(doc, { now } = {}) {
  const t = Number.isFinite(now) ? now : Date.now();
  for (const [tok, rec] of Object.entries((doc && doc.tokens) || {})) {
    if (!rec || !(Number(rec.expiresAt) > t)) continue;
    if (rec.sid === undefined || rec.createdAt === undefined) return true;
  }
  return false;
}

/**
 * 单条会话的对外视图。
 * `full` = true 时返回完整 IP（**只给仅本机直连的管理接口**，用户侧一律打码）。
 */
function sessionOut(rec, { current, now, activeDays: days, full } = {}) {
  if (!rec) return null;
  const t = Number.isFinite(now) ? now : Date.now();
  const active = isActive(rec, { now: t, activeDays: days });
  return {
    sid: rec.sid || null,
    deviceId: rec.deviceId || null,
    deviceLabel: rec.deviceLabel || null,
    platform: rec.platform || null,
    zoteroVersion: rec.zoteroVersion || null,
    createdAt: rec.createdAt || null,
    lastSeenAt: rec.lastSeenAt || null,
    ipMasked: maskIp(rec.lastSeenIp || rec.createdIp),
    ip: full ? String(rec.lastSeenIp || rec.createdIp || '') : undefined,
    createdIp: full ? String(rec.createdIp || '') : undefined,
    expiresAt: new Date(Number(rec.expiresAt) || 0).toISOString(),
    active: active,
    current: !!current,
    // 设备标识缺失（老插件 / 未升级）时如实说明，界面据此提示"升级后可识别设备"
    identified: !!(rec.deviceId || rec.platform || rec.zoteroVersion),
  };
}

/** 设备是否"可操作"（踢出）：只有当前有效令牌才谈得上踢 */
function revocable(rec, { now } = {}) {
  const t = Number.isFinite(now) ? now : Date.now();
  return !!(rec && Number(rec.expiresAt) > t);
}

/* ---------------- 阈值告警 ---------------- */

/**
 * 找出「活跃设备数超阈值」的账号。**只报告，不处罚。**
 * key = 超限账号与其设备数的确定性签名 —— 用于去重：
 * 同一批超限账号不重复打扰，有人被踢出去（签名变了）就立刻再提醒一次。
 */
function deviceAlertOf(doc, { now, threshold, activeDays: days } = {}) {
  const t = Number.isFinite(now) ? now : Date.now();
  const max = num(threshold, maxDevices());
  const users = Array.isArray((doc && doc.users)) ? doc.users : [];
  const over = [];
  for (const u of users) {
    const n = countActive(doc, u.id, { now: t, activeDays: days });
    if (n > max) over.push({ userId: u.id, email: u.email, nickname: u.nickname || '', count: n });
  }
  over.sort((a, b) => b.count - a.count || (a.email < b.email ? -1 : 1));
  const key = over.map((x) => x.userId + ':' + x.count).join('|');
  return {
    over: over.length > 0, threshold: max,
    activeDays: num(days, activeDays()),
    users: over, count: over.length, key: key || null,
  };
}

/** 是否该提醒（同一批超限按 repeat 窗口节流；成员变化立即提醒） */
function shouldAlert(state, info, { now, repeat } = {}) {
  if (!info || !info.over) return false;
  const t = Number.isFinite(now) ? now : Date.now();
  const s = state || {};
  if (!s.lastAlertAt || s.lastAlertKey !== info.key) return true;
  return (t - (Date.parse(s.lastAlertAt) || 0)) >= num(repeat, repeatMs());
}

/** 记录一次设备告警（就地修改并返回 state） */
function record(state, info, { mailed, now } = {}) {
  const s = state && typeof state === 'object' ? state : {};
  const at = new Date(Number.isFinite(now) ? now : Date.now()).toISOString();
  s.lastAlertAt = at;
  s.lastAlertKey = info ? info.key : null;
  s.lastCount = info ? info.count : 0;
  s.lastMailed = !!mailed;
  s.history = (Array.isArray(s.history) ? s.history : []).slice(-19);
  s.history.push({
    at, count: info ? info.count : 0, threshold: info ? info.threshold : null,
    users: info ? info.users.slice(0, 10).map((u) => u.email) : [], mailed: !!mailed,
  });
  return s;
}

/** alerts.log 的一行（纯文本，便于 grep） */
function logLine(info) {
  const who = (info.users || []).slice(0, 5)
    .map((u) => u.email + '(' + u.count + ')').join(',');
  return 'DEVICES over=' + info.count
    + ' threshold=' + info.threshold
    + ' window=' + info.activeDays + 'd'
    + ' users=' + who;
}

/** 告警邮件内容（未配邮件服务时只写日志，不报错） */
function buildMail(info, platform) {
  const rows = (info.users || []).map((u) => '· ' + (u.nickname ? u.nickname + ' ' : '') + u.email
    + ' —— 活跃设备 ' + u.count + ' 台').join('\n');
  return {
    subject: '【Papilot】有 ' + info.count + ' 个账号的活跃设备超过 ' + info.threshold + ' 台',
    text: '以下账号在最近 ' + info.activeDays + ' 天内的活跃登录设备超过阈值（' + info.threshold + ' 台）：\n\n'
      + rows + '\n\n'
      + '**这只提示可能存在的账号共享，不自动处罚。**同一个人多台机器很正常；\n'
      + '如确认是共享/倒卖，可在后台删除该账号，或让用户在插件设置里「踢出其他设备」。\n\n'
      + '处理入口：' + (platform && platform.serverUrl ? platform.serverUrl : '') + '\n'
      + '  启动器 → 账号管理 → 用户列表 → 选中 → 「查看/踢出设备」\n'
      + '  或浏览器打开 ' + (platform && platform.serverUrl ? platform.serverUrl : '') + '/admin → 账号管理 → 设备\n',
  };
}

/** 给后台/health 用的紧凑视图 */
function view(state, info) {
  const s = state || {};
  const i = info || { over: false, count: 0, threshold: maxDevices(), activeDays: activeDays(), users: [] };
  return {
    devicesOverLimit: i.count,
    devicesOver: !!i.over,
    deviceThreshold: i.threshold,
    activeDays: i.activeDays,
    overUsers: (i.users || []).slice(0, 20),
    lastDeviceAlertAt: s.lastAlertAt || null,
    lastDeviceMailed: !!s.lastMailed,
    history: Array.isArray(s.history) ? s.history.slice(-10) : [],
  };
}

/* ---------------- 令牌撤销（踢设备） ---------------- */

/** 一条会话记录的 sid：优先取记录里已保存的，缺失才由令牌散列推导。
 *  ★ 展示（sessionOut）与撤销（revokeSid/revokeOthers）**必须用同一个取值来源**，
 *  否则会出现"界面看得见、却怎么都踢不掉"的设备。 */
function sidOfRec(rec, tokenKey) {
  return (rec && rec.sid) || sidOf(tokenKey);
}

/**
 * 踢出某台设备：删掉该 sid 对应的令牌。
 * **不在这里写盘** —— 由调用方统一 save，保证「一次操作一次落盘 + 一次审计」。
 * 只处理**仍然有效**的令牌：与用户看到的设备列表口径一致（过期的本就不算设备，
 * 也不该让「已踢出 N 台」的提示跟用户数出来的台数对不上）。
 * 返回 { revoked, self }：self=true 表示踢的是当前正在用的会话（语义 = 登出）。
 */
function revokeSid(doc, userId, sid, { now, currentSid } = {}) {
  const t = Number.isFinite(now) ? now : Date.now();
  const want = String(sid || '');
  if (!want) return { error: '缺少会话 id' };
  for (const [tok, rec] of Object.entries((doc && doc.tokens) || {})) {
    if (!rec || rec.userId !== userId) continue;
    if (!(Number(rec.expiresAt) > t)) continue;      // 已过期：不算设备，交给 pruneTokens
    if (sidOfRec(rec, tok) !== want) continue;
    delete doc.tokens[tok];
    return { revoked: want, self: want === String(currentSid || '') };
  }
  return { error: '会话不存在或已失效' };
}

/** 踢出该用户除当前会话外的全部**有效**设备，返回被踢的 sid 列表 */
function revokeOthers(doc, userId, { now, currentSid } = {}) {
  const t = Number.isFinite(now) ? now : Date.now();
  const keep = String(currentSid || '');
  const out = [];
  for (const [tok, rec] of Object.entries((doc && doc.tokens) || {})) {
    if (!rec || rec.userId !== userId) continue;
    if (!(Number(rec.expiresAt) > t)) continue;
    if (sidOfRec(rec, tok) === keep) continue;
    delete doc.tokens[tok];
    out.push(sidOfRec(rec, tok));
  }
  return { revoked: out };
}

/** 会话 id 的确定性摘要（审计里记「踢了几台」而不记具体 sid 列表） */
function digestOf(list) {
  const s = (Array.isArray(list) ? list : []).join(',');
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 8);
}

module.exports = {
  SID_LEN, DEFAULT_ACTIVE_DAYS, DEFAULT_MAX_DEVICES, DEFAULT_REPEAT_H, DAY_MS,
  activeDays, maxDevices, repeatMs,
  sidOf, maskIp, cleanLabel, pickHeader, deviceFromHeaders,
  recordStart, recordSeen, setLabel, backfill,
  sessionsOf, sessionsOfDetailed, countActive, countActiveAll, countActiveAllDetailed,
  needsBackfill, isActive, sessionOut, revocable, sidOfRec,
  deviceAlertOf, shouldAlert, record, logLine, buildMail, view,
  revokeSid, revokeOthers, digestOf,
};
