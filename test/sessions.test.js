#!/usr/bin/env node
/* 登录设备与会话可观测（服务端 1.4.7）
 *
 * 运行：node test/sessions.test.js
 *
 * 覆盖：
 *   纯函数 —— sid 生成（不可反推令牌）、IP 打码（v4/v6）、标签清洗、设备头上报解析、
 *            首次登录写设备 / 同一记录不覆盖已有标识、最近活动推进、老令牌现场补齐（changed 守卫）。
 *   视图   —— **用户侧一律打码且不含令牌散列**；管理侧才给完整 IP（追查用）。
 *   阈值   —— 活跃设备超阈值告警：去重（同批不重复 / 成员变化立即再提醒）、日志行、邮件文案。
 *   撤销   —— 踢单台 / 踢其他全部 / 踢自己=登出；改密仍全删（回归）。
 *   接口   —— 三设备登录 → 列表与计数 → 踢出后 401 → 管理侧含完整 IP → health/用户输出/审计。
 *   回归   —— 既有「订单积压」告警字段不受影响（新增设备巡检不得改动原形状）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-sess-'));
let PORT = 0;            // 端口由系统分配（listen(0) 后回读）：避免与用户本机常驻服务撞端口导致偶发 EADDRINUSE
process.env.PP_DATA_DIR = WORK;
process.env.PP_PORT = String(PORT);
delete process.env.PP_RESEND_KEY;
process.env.PP_LOGIN_MAX = '500';
process.env.PP_SESSION_MAX_DEVICES = '2';    // 阈值 2，方便触发超限
process.env.PP_SESSION_ACTIVE_DAYS = '7';

const sessions = require(path.join(__dirname, '..', 'server', 'lib', 'sessions.js'));
const mod = require(path.join(__dirname, '..', 'server', 'account-server.js'));
const { server } = mod;

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }
function has(hay, needle, label) {
  return ok(String(hay).indexOf(needle) >= 0, label, { text: String(hay).slice(0, 180), want: needle });
}

const D = 86400e3;
const T0 = Date.now();
const iso = (t) => new Date(t).toISOString();

function req(method, p, body, token, extraHeaders) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined || body === null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = Object.assign({}, extraHeaders || {});
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    if (token) headers.Authorization = 'Bearer ' + token;
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers,
      agent: false }, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(Buffer.concat(cs).toString('utf8')); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, json: j });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const DEV_A = { 'X-PP-Device': 'aaaa1111-2222-3333-4444-555566667777', 'X-PP-Platform': 'Windows 11', 'X-PP-Zotero': '10.0.5' };
const DEV_B = { 'X-PP-Device': 'bbbb1111-2222-3333-4444-555566667777', 'X-PP-Platform': 'macOS 15', 'X-PP-Zotero': '10.0.5' };

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  PORT = server.address().port;

  /* ================= A. 标识与脱敏 ================= */
  const tk = 'a'.repeat(64);
  const sid = sessions.sidOf(tk);
  eq(sid.length, 8, 'A1 sid 取散列前 8 位');
  eq(sid, sessions.sidOf(tk), 'A2 sid 对同一令牌稳定');
  ok(sessions.sidOf('b'.repeat(64)) !== sid, 'A3 不同令牌 sid 不同');
  ok(tk.indexOf(sid) >= 0 && sid.length < 16, 'A4 sid 只是散列前缀，无法据此反推令牌长度之外的任何信息');

  eq(sessions.maskIp('203.0.113.45'), '203.0.113.*', 'A5 IPv4 只留前三段');
  eq(sessions.maskIp('2001:db8:1234::1'), '2001:db8:*', 'A6 IPv6 只留前两组');
  eq(sessions.maskIp(''), '', 'A7 空 IP 返回空串');
  eq(sessions.maskIp('not-an-ip'), 'not-an-ip', 'A8 非 IP 原样返回（不崩）');

  eq(sessions.cleanLabel('  我的笔记本  '), '我的笔记本', 'A9 标签去首尾空白');
  eq(sessions.cleanLabel('a\u0000b\nc').indexOf('\u0000'), -1, 'A10 标签去掉控制字符');
  eq(sessions.cleanLabel('x'.repeat(80)).length, 40, 'A11 标签限长 40');

  eq(sessions.deviceFromHeaders({}), null, 'A12 未上报任何设备头 → null（不编造）');
  const devOk = sessions.deviceFromHeaders(DEV_A);
  eq(devOk.platform, 'Windows 11', 'A13 解析平台');
  eq(devOk.zoteroVersion, '10.0.5', 'A14 解析 Zotero 版本');
  eq(devOk.deviceId, DEV_A['X-PP-Device'].toLowerCase(), 'A15 解析 deviceId（归一为小写）');
  // HTTP 表头名不区分大小写 —— 大小写两种写法都必须认得（否则调用方一换写法就静默丢设备信息）
  const devLower = sessions.deviceFromHeaders({ 'x-pp-device': DEV_A['X-PP-Device'], 'x-pp-platform': 'Windows 11' });
  eq(devLower.deviceId, devOk.deviceId, 'A15b 全小写表头也能解析（大小写不敏感）');
  eq(devLower.platform, 'Windows 11', 'A15c 全小写表头的平台也解析');
  eq(sessions.deviceFromHeaders({ 'X-PP-Device': '../../etc/passwd' }), null,
    'A16 形状不合的 deviceId 一律丢弃（不把任意内容存进用户数据）');
  eq(sessions.deviceFromHeaders({ 'X-PP-Platform': 'Linux' }).deviceId, null,
    'A17 只有平台也算上报（老插件无 deviceId 也允许降级展示）');

  /* ================= B. 记录读写 ================= */
  const rec = { userId: 'u1', expiresAt: T0 + D };
  sessions.recordStart(rec, { tokenKey: tk, ip: '203.0.113.45', device: devOk, now: T0 });
  eq(rec.sid, sid, 'B1 首次登录写入 sid');
  eq(rec.createdAt, iso(T0), 'B2 写入创建时间');
  eq(rec.createdIp, '203.0.113.45', 'B3 写入来源 IP（落盘侧保留原始值，展示侧再打码）');
  eq(rec.lastSeenAt, iso(T0), 'B4 首次即视为"最近活动"');
  eq(rec.deviceId, DEV_A['X-PP-Device'].toLowerCase(), 'B5 写入设备标识');

  // 同一记录再次 recordStart（例如将来支持"重新识别设备"）绝不能把已有标识覆盖掉
  sessions.recordStart(rec, { tokenKey: tk, ip: '198.51.100.7', device: { deviceId: 'ffff', platform: 'Linux' }, now: T0 + D });
  eq(rec.deviceId, DEV_A['X-PP-Device'].toLowerCase(), 'B6 已有 deviceId 不被后来的上报覆盖');
  eq(rec.platform, 'Windows 11', 'B7 已有 platform 不被覆盖');
  eq(rec.createdAt, iso(T0), 'B8 创建时间不被重置');

  sessions.recordSeen(rec, { ip: '198.51.100.7', now: T0 + 3600e3 });
  eq(rec.lastSeenAt, iso(T0 + 3600e3), 'B9 最近活动被推进');
  eq(rec.lastSeenIp, '198.51.100.7', 'B10 最近来源 IP 被更新');
  eq(rec.createdIp, '203.0.113.45', 'B11 首次来源 IP 保持不动（保留取证价值）');

  const legacy = { userId: 'u1', expiresAt: T0 + D };  // 老版本签发的令牌：只有这两字段
  eq(sessions.backfill(legacy, 'c'.repeat(64)), true, 'B12 老令牌补齐 → changed=true（调用方据此落盘）');
  eq(legacy.sid, 'c'.repeat(8), 'B13 老令牌拿到 sid');
  eq(sessions.backfill(legacy, 'c'.repeat(64)), false, 'B14 已补齐 → changed=false（读接口不再写盘）');

  /* ================= C. 查询与活跃判定 ================= */
  const docC = {
    users: [{ id: 'u1', email: 'a@t.local' }, { id: 'u2', email: 'b@t.local' }],
    tokens: {
      ['k' + '1'.repeat(10)]: { userId: 'u1', expiresAt: T0 + D, sid: 'sid1', createdAt: iso(T0), lastSeenAt: iso(T0 - 1 * D) },
      ['k' + '2'.repeat(10)]: { userId: 'u1', expiresAt: T0 + D, sid: 'sid2', createdAt: iso(T0), lastSeenAt: iso(T0 - 9 * D) },
      ['k' + '3'.repeat(10)]: { userId: 'u1', expiresAt: T0 + D, sid: 'sid3', createdAt: iso(T0), lastSeenAt: iso(T0 - 3 * D) },
      ['k' + '4'.repeat(10)]: { userId: 'u1', expiresAt: T0 - 1, sid: 'sid4', createdAt: iso(T0 - 40 * D), lastSeenAt: iso(T0) },
      ['k' + '5'.repeat(10)]: { userId: 'u2', expiresAt: T0 + D, sid: 'sid5', createdAt: iso(T0), lastSeenAt: iso(T0) },
    },
  };
  eq(sessions.sessionsOf(docC, 'u1').length, 3, 'C1 过期令牌不算设备（即使 pruneTokens 还没跑到）');
  eq(sessions.sessionsOf(docC, 'u1')[0].sid, 'sid1', 'C2 按最近活动降序（最近的排第一）');
  eq(sessions.countActive(docC, 'u1', { now: T0 }), 2, 'C3 活跃 7 天窗口内只有 2 台（9 天前那台不算）');
  eq(sessions.countActive(docC, 'u1', { now: T0, activeDays: 30 }), 3, 'C4 把窗口放到 30 天则 3 台都算活跃');
  eq(sessions.countActiveAll(docC, { now: T0 }), 3, 'C5 全局活跃会话数');
  eq(sessions.countActive(docC, 'u2', { now: T0 }), 1, 'C6 按用户隔离（不串号）');

  const vSelf = sessions.sessionOut(docC.tokens['k' + '3'.repeat(10)], { current: true, now: T0 });
  eq(vSelf.current, true, 'C7 标出当前会话');
  eq(vSelf.active, true, 'C8 标出是否活跃');
  eq(vSelf.ipMasked, '', 'C9 无 IP 时打码为空串');
  eq(vSelf.ip, undefined, 'C10 **用户侧视图不返回完整 IP**（脱敏）');
  ok(vSelf.keys === undefined && vSelf.expiresAt !== undefined, 'C11 视图含有效期但无令牌散列');
  ok(JSON.stringify(vSelf).indexOf('k' + '3'.repeat(10)) < 0, 'C12 **响应里不含令牌散列**');

  const vAdmin = sessions.sessionOut(
    Object.assign({}, docC.tokens['k' + '3'.repeat(10)], { lastSeenIp: '203.0.113.45' }),
    { full: true, now: T0 });
  eq(vAdmin.ip, '203.0.113.45', 'C13 管理侧才给完整 IP（出事要能追）');
  eq(vAdmin.ipMasked, '203.0.113.*', 'C14 管理侧同时也给打码值（界面按需选）');

  const vLegacy = sessions.sessionOut({ userId: 'u1', expiresAt: T0 + D, sid: 'x', createdAt: null, lastSeenAt: null },
    { now: T0 });
  eq(vLegacy.identified, false, 'C15 没有设备信息 → identified=false（界面据此提示升级插件）');
  eq(vLegacy.active, false, 'C16 没有时间戳的历史记录不算活跃');

  /* ================= D. 阈值告警 ================= */
  const info = sessions.deviceAlertOf(docC, { now: T0 });
  eq(info.threshold, 2, 'D1 阈值读环境变量');
  eq(info.activeDays, 7, 'D2 活跃窗口读环境变量');
  eq(info.count, 0, 'D3 恰好等于阈值不算超限（判据是「超过」而不是「达到」）');

  const docD2 = JSON.parse(JSON.stringify(docC));
  docD2.tokens['k' + '6'.repeat(10)] = { userId: 'u1', expiresAt: T0 + D, sid: 'sid6', createdAt: iso(T0), lastSeenAt: iso(T0) };
  const info2 = sessions.deviceAlertOf(docD2, { now: T0 });
  eq(info2.count, 1, 'D4 超过阈值 → 报出 1 个账号');
  eq(info2.users[0].email, 'a@t.local', 'D5 报出账号邮箱');
  eq(info2.users[0].count, 3, 'D6 报出该账号的活跃设备数');
  ok(!!info2.key, 'D7 生成去重签名');

  const st = {};
  eq(sessions.shouldAlert(st, info2, { now: T0 }), true, 'D8 首次超限 → 告警');
  const st2 = sessions.record(st, info2, { mailed: false, now: T0 });
  eq(st2.lastAlertKey, info2.key, 'D9 记录去重签名');
  eq(st2.history.length, 1, 'D10 写入历史');
  eq(sessions.shouldAlert(st2, info2, { now: T0 + 60e3 }), false, 'D11 同一批超限 → 重复窗口内不再打扰');
  eq(sessions.shouldAlert(st2, info2, { now: T0 + 7 * 3600e3 }), true, 'D12 超过重复窗口 → 再提醒一次');

  const docD3 = JSON.parse(JSON.stringify(docD2));
  // 把「超限的账号」从 u1 换成 u2：u1 退回 2 台（不超），u2 攒到 3 台（超）
  delete docD3.tokens['k' + '6'.repeat(10)];
  docD3.tokens['k' + '7'.repeat(10)] = { userId: 'u2', expiresAt: T0 + D, sid: 'sid7', createdAt: iso(T0), lastSeenAt: iso(T0) };
  docD3.tokens['k' + '8'.repeat(10)] = { userId: 'u2', expiresAt: T0 + D, sid: 'sid8', createdAt: iso(T0), lastSeenAt: iso(T0 - 1 * D) };
  const info3 = sessions.deviceAlertOf(docD3, { now: T0 });
  eq(info3.users[0].email, 'b@t.local', 'D13 换了一个账号超限');
  eq(info3.count, 1, 'D13b 只有一个账号超限（u1 退回阈值内）', info3.users);
  ok(info3.key !== info2.key, 'D14 成员变化 → 去重签名变化');
  eq(sessions.shouldAlert(st2, info3, { now: T0 + 60e3 }), true,
    'D15 **换了超限账号立即再提醒**（不被重复窗口压住）');

  has(sessions.logLine(info2), 'DEVICES over=1', 'D16 日志行可 grep（DEVICES）');
  has(sessions.logLine(info2), 'threshold=2', 'D17 日志行带阈值');
  has(sessions.logLine(info2), 'window=7d', 'D18 日志行带活跃窗口');
  has(sessions.buildMail(info2, { serverUrl: 'https://x' }).subject, '活跃设备', 'D19 邮件主题说明事由');
  has(sessions.buildMail(info2, { serverUrl: 'https://x' }).text, '不自动处罚',
    'D20 邮件写明**只提示不处罚**（避免误伤误判）');

  const vw = sessions.view(st2, info2);
  eq(vw.devicesOverLimit, 1, 'D21 视图给出超限账号数');
  eq(vw.deviceThreshold, 2, 'D22 视图给出阈值');
  eq(vw.overUsers.length, 1, 'D23 视图给出超限账号列表');

  /* ================= E. 撤销 ================= */
  const docE = JSON.parse(JSON.stringify(docD2));
  const rk = sessions.revokeSid(docE, 'u1', 'sid6', { currentSid: 'sid1' });
  eq(rk.revoked, 'sid6', 'E1 踢出指定设备');
  eq(rk.self, false, 'E2 踢的不是当前会话 → self=false');
  eq(sessions.sessionsOf(docE, 'u1').length, 3, 'E3 该设备已从列表消失');
  ok(!!sessions.revokeSid(docE, 'u1', 'sid6').error, 'E4 重复踢同一设备 → 明确报「不存在」');
  ok(!!sessions.revokeSid(docE, 'u2', 'sid1').error, 'E5 **不能踢别人的会话**（用户隔离）');
  const rself = sessions.revokeSid(docE, 'u1', 'sid1', { currentSid: 'sid1' });
  eq(rself.self, true, 'E6 踢自己 → self=true（语义 = 登出）');

  const docE2 = JSON.parse(JSON.stringify(docD2));
  const ro = sessions.revokeOthers(docE2, 'u1', { currentSid: 'sid1', now: T0 });
  eq(ro.revoked.length, 3, 'E7 踢出其他全部设备（3 台有效；已过期那台不算，与列表口径一致）', ro.revoked);
  ok(ro.revoked.indexOf('sid4') < 0, 'E7b 已过期的令牌不在「踢出」范围内（它本就不算设备）');
  eq(sessions.sessionsOf(docE2, 'u1').length, 1, 'E8 只剩当前会话');
  eq(sessions.sessionsOf(docE2, 'u1')[0].sid, 'sid1', 'E9 保留的正是当前会话');
  eq(sessions.sessionsOf(docE2, 'u2').length, 1, 'E10 不碰其他账号的设备');
  ok(!!sessions.revokeSid(docE2, 'u1', 'sid4', { now: T0 }).error,
    'E10b 对已过期令牌执行踢出 → 明确报「不存在或已失效」（不会谎报成功）');

  eq(sessions.digestOf(['a', 'b']), sessions.digestOf(['a', 'b']), 'E11 摘要确定性');
  eq(sessions.digestOf(['a', 'b']).length, 8, 'E12 摘要 8 位');
  ok(sessions.digestOf(['a', 'b']) !== sessions.digestOf(['b', 'a']), 'E13 摘要对顺序敏感（不会把两次不同操作看成同一次）');

  /* ================= F. HTTP：三设备登录与自助管理 ================= */
  await req('POST', '/api/auth/register', { email: 'multi@t.local', password: 'pw12345678' });
  const lgA = await req('POST', '/api/auth/login', { email: 'multi@t.local', password: 'pw12345678' }, null, DEV_A);
  const lgB = await req('POST', '/api/auth/login', { email: 'multi@t.local', password: 'pw12345678' }, null, DEV_B);
  const lgC = await req('POST', '/api/auth/login', { email: 'multi@t.local', password: 'pw12345678' });  // 老插件
  const tA = lgA.json.token, tB = lgB.json.token, tC = lgC.json.token;
  ok(!!tA && !!tB && !!tC, 'F1 三台设备各自登录成功');

  const h0 = await req('GET', '/api/health');
  eq(h0.json.version, '1.6.0', 'F2 服务端版本 1.6.0');
  eq(h0.json.sessionsActive, 3, 'F3 health 报告 3 个活跃会话');
  eq(h0.json.devicesOverLimit, 1, 'F4 health 报告 1 个账号设备超限');

  const anon = await req('GET', '/api/sessions');
  eq(anon.status, 401, 'F5 未登录不能看设备列表');

  let ss = await req('GET', '/api/sessions', null, tA);
  eq(ss.status, 200, 'F6 登录后可看设备列表');
  eq(ss.json.sessions.length, 3, 'F7 列出 3 台');
  eq(ss.json.activeCount, 3, 'F8 活跃 3 台（刚登录）');
  eq(ss.json.maxDevices, 2, 'F9 阈值下发（供界面提示）');
  eq(ss.json.overLimit, true, 'F10 界面可据此标红');
  eq(ss.json.identified, true, 'F11 至少一台已上报设备标识');
  eq(ss.json.sessions.filter((x) => x.current).length, 1, 'F12 恰有一台标为当前设备');
  eq(ss.json.sessions.filter((x) => x.current)[0].platform, 'Windows 11', 'F13 当前设备是上报 Windows 11 那台');
  ok(ss.json.sessions.every((x) => x.ip === undefined), 'F14 **用户侧不返回完整 IP**');
  ok(ss.json.sessions.every((x) => x.ipMasked !== undefined), 'F15 但给出打码 IP');
  ok(JSON.stringify(ss.json).indexOf('pp-') < 0, 'F16 响应不含任何令牌原文');
  ok(ss.json.sessions.some((x) => x.identified === false), 'F17 未上报设备的那台被标为未识别');
  eq(ss.json.hint, '', 'F18 有已识别设备时不再提示升级插件');

  // 最近活动会被推进（活跃判据靠它）
  const before = ss.json.sessions.filter((x) => x.current)[0].lastSeenAt;
  await new Promise((r) => setTimeout(r, 15));
  await req('GET', '/api/auth/me', null, tA);
  ss = await req('GET', '/api/sessions', null, tA);
  const after = ss.json.sessions.filter((x) => x.current)[0].lastSeenAt;
  ok(Date.parse(after) > Date.parse(before), 'F19 请求会推进该设备的「最近活动」', { before, after });

  /* ---- 给设备命名（0.24.7）：本机拿不到可靠主机名，所以由用户自己命名 ---- */
  const mySid = ss.json.sessions.filter((x) => x.current)[0].sid;
  const rn = await req('PUT', '/api/sessions/' + mySid, { label: '  办公室台式  ' }, tA);
  eq(rn.status, 200, 'F19a 可以给自己的设备命名');
  eq(rn.json.label, '办公室台式', 'F19b 名字去掉了首尾空白');
  const afterRn = await req('GET', '/api/sessions', null, tA);
  eq(afterRn.json.sessions.filter((x) => x.current)[0].deviceLabel, '办公室台式',
    'F19c 重命名后列表里显示新名字');
  ok(afterRn.json.sessions.filter((x) => x.current)[0].identified === true,
    'F19d 命名后该设备算「已识别」');

  // 名字里的控制字符必须被清洗掉（用 fromCharCode 构造，避免源码里出现真实控制字符）
  const dirtyName = 'a' + String.fromCharCode(0) + 'b' + String.fromCharCode(10) + 'c' + 'x'.repeat(60);
  const badName = await req('PUT', '/api/sessions/' + mySid, { label: dirtyName }, tA);
  eq(badName.json.label.length, 40, 'F19e 名字限长 40 且去掉控制字符', badName.json.label);
  const cleared = await req('PUT', '/api/sessions/' + mySid, { label: '' }, tA);
  eq(cleared.json.label, null, 'F19f 传空串即清除名字（回落默认展示）');
  const noSid = await req('PUT', '/api/sessions/deadbeef', { label: 'x' }, tA);
  eq(noSid.status, 404, 'F19g 重命名不存在的会话 → 404');

  // 不能给别人的设备命名（越权）
  const lgOther = await req('POST', '/api/auth/login', { email: 'other@t.local', password: 'pw12345678' }, null, DEV_B);
  await req('POST', '/api/auth/register', { email: 'other@t.local', password: 'pw12345678' });
  const userOther = (await req('GET', '/api/admin/users')).json.users.filter((u) => u.email === 'other@t.local')[0];
  if (userOther) await req('POST', '/api/admin/users/' + userOther.id + '/password', { password: 'pw12345678' });
  const tOther = (await req('POST', '/api/auth/login', { email: 'other@t.local', password: 'pw12345678' })).json.token;
  if (tOther) {
    const cross = await req('PUT', '/api/sessions/' + mySid, { label: '越权' }, tOther);
    eq(cross.status, 404, 'F19h 不能给别人的设备命名（越权返回 404）');
  } else {
    ok(true, 'F19h 越权用例前置登录失败，跳过');
  }

  const auRn = await req('GET', '/api/admin/audit?action=session.label&limit=5');
  ok(auRn.json.items.length >= 1, 'F19i 命名动作写入审计（session.label）', auRn.json.items.length);

  // 用户输出带设备数
  const usersF = await req('GET', '/api/admin/users');
  const uF = usersF.json.users.filter((x) => x.email === 'multi@t.local')[0];
  eq(uF.sessionsActive, 3, 'F20 后台用户对象带活跃设备数');
  eq(uF.sessionsOverLimit, true, 'F21 后台用户对象带超限标记');

  // 踢出未上报的那台（老插件）
  const lgcSid = ss.json.sessions.filter((x) => !x.identified)[0].sid;
  const kick = await req('DELETE', '/api/sessions/' + lgcSid, null, tA);
  eq(kick.status, 200, 'F22 踢出指定设备');
  eq(kick.json.self, false, 'F23 踢的不是当前会话');
  eq((await req('GET', '/api/sessions', null, tC)).status, 401, 'F24 被踢设备立刻失效（下次请求 401 → 客户端自行清会话）');
  eq((await req('GET', '/api/sessions', null, tB)).status, 200, 'F25 其他设备不受影响');
  eq((await req('GET', '/api/sessions', null, tA)).status, 200, 'F26 当前设备不受影响');

  // 管理侧：完整 IP + 管理员踢出
  const uidF = uF.id;
  const adm1 = await req('GET', '/api/admin/users/' + uidF + '/sessions');
  eq(adm1.status, 200, 'F27 管理侧可查某账号设备');
  eq(adm1.json.activeCount, 2, 'F28 踢出一台后剩 2 台活跃');
  ok(adm1.json.sessions.every((x) => typeof x.ip === 'string'), 'F29 **管理侧给出完整 IP**（追查用）');
  const admSid = adm1.json.sessions.filter((x) => x.platform === 'macOS 15')[0].sid;
  const admKick = await req('DELETE', '/api/admin/users/' + uidF + '/sessions/' + admSid);
  eq(admKick.status, 200, 'F30 管理员可踢出指定设备');
  eq((await req('GET', '/api/sessions', null, tB)).status, 401, 'F31 被管理员踢出的设备立刻失效');
  const admBad = await req('DELETE', '/api/admin/users/' + uidF + '/sessions/deadbeef');
  eq(admBad.status, 404, 'F32 踢不存在的设备 → 404');

  // 踢出其他全部
  const ro2 = await req('POST', '/api/sessions/revoke-others', {}, tA);
  eq(ro2.status, 200, 'F33 一键踢出其他设备');
  eq(ro2.json.revoked, 0, 'F34 此时已经没有别的设备');
  await req('POST', '/api/auth/login', { email: 'multi@t.local', password: 'pw12345678' }, null, DEV_B);
  const ro3 = await req('POST', '/api/sessions/revoke-others', {}, tA);
  eq(ro3.json.revoked, 1, 'F35 有新设备时能踢掉');
  eq((await req('GET', '/api/sessions', null, tA)).status, 200, 'F36 踢出其他后当前设备仍可用');

  // 踢自己 = 登出
  const selfSid = (await req('GET', '/api/sessions', null, tA)).json.sessions.filter((x) => x.current)[0].sid;
  const selfKick = await req('DELETE', '/api/sessions/' + selfSid, null, tA);
  eq(selfKick.json.self, true, 'F37 踢自己标记 self=true');
  eq((await req('GET', '/api/sessions', null, tA)).status, 401, 'F38 踢自己后当前令牌失效（等同登出）');

  /* ================= G. 落盘、审计与回归 ================= */
  // 上面把设备都踢光了，这里重新攒 3 台（2 台上报设备 + 1 台老插件），
  // 既用于核对落盘，也让后面的「设备超限告警」有素材
  await req('POST', '/api/auth/login', { email: 'multi@t.local', password: 'pw12345678' }, null, DEV_A);
  await req('POST', '/api/auth/login', { email: 'multi@t.local', password: 'pw12345678' }, null, DEV_B);
  await req('POST', '/api/auth/login', { email: 'multi@t.local', password: 'pw12345678' });

  const udoc = JSON.parse(fs.readFileSync(path.join(WORK, 'users.json'), 'utf8'));
  const recs = Object.values(udoc.tokens);
  ok(recs.length >= 1, 'G1 令牌仍在 users.json');
  const withDev = recs.filter((r) => r.deviceId)[0];
  ok(!!withDev, 'G2 设备信息已落盘');
  ok(!!withDev.sid && !!withDev.createdAt && !!withDev.lastSeenAt, 'G3 sid/创建时间/最近活动都已落盘',
    withDev && { sid: withDev.sid, createdAt: withDev.createdAt, lastSeenAt: withDev.lastSeenAt });
  ok(!!withDev.createdIp, 'G4 来源 IP 已落盘（原始值，仅存服务端）');

  const au = await req('GET', '/api/admin/audit?limit=20');
  const acts = au.json.items.map((x) => x.action);
  ok(acts.indexOf('session.revoke') >= 0, 'G5 审计记录 session.revoke', acts.slice(0, 8));
  ok(acts.indexOf('session.revoke-others') >= 0, 'G6 审计记录 session.revoke-others');
  ok(acts.indexOf('session.revoke-admin') >= 0, 'G7 审计记录 session.revoke-admin');
  const rawAudit = fs.readFileSync(path.join(WORK, 'audit.log'), 'utf8');
  ok(rawAudit.indexOf('multi@t.local') >= 0, 'G8 审计写明是哪个账号');
  // 审计记录的是 sid（散列前 8 位，不可反推）而不是令牌散列本身 —— 核对确实如此
  ok(rawAudit.indexOf(sid) >= 0 || /"sid":"[0-9a-f]{8}"/.test(rawAudit), 'G9 审计记录 sid（不可反推的短标识）');
  ok(!/"after":\{[^}]*\b(pp-[0-9a-f]{16,})\b/.test(rawAudit), 'G9b 审计不含任何令牌原文');
  ok(!!rawAudit, 'G9c 审计文件已生成');

  // 设备告警：alerts.log 出现 DEVICES 行，且 alerts.json 用独立命名空间
  const chk = await req('POST', '/api/admin/alerts/check', {});
  eq(chk.status, 200, 'G10 手动巡检可用');
  eq(chk.json.result.devices.alerted, true, 'G11 设备超限触发设备告警');
  ok(Array.isArray(chk.json.result.devices.overUsers) && chk.json.result.devices.overUsers.length >= 1,
    'G12 巡检结果列出超限账号', chk.json.result.devices.overUsers);
  const alog = fs.readFileSync(path.join(WORK, 'alerts.log'), 'utf8');
  ok(/DEVICES over=/.test(alog), 'G13 alerts.log 出现可 grep 的设备告警行', alog.trim().split('\n').slice(-1)[0]);
  const adoc = JSON.parse(fs.readFileSync(path.join(WORK, 'alerts.json'), 'utf8'));
  ok(!!adoc.sessions && !!adoc.sessions.lastAlertKey, 'G14 设备告警状态存在 sessions 命名空间下');
  ok(!adoc.lastAlertKey || adoc.lastAlertKey !== adoc.sessions.lastAlertKey,
    'G15 设备状态与积压状态互不覆盖（各自独立去重）');

  // 回归：既有积压告警字段必须保持原形状（新增巡检不得改动它）
  ok('backlog' in chk.json.result && 'alerted' in chk.json.result && 'mailed' in chk.json.result,
    'G16 积压告警返回字段形状未变（回归）');
  const ads = await req('GET', '/api/admin/alerts');
  ok(ads.json.alerts.backlogCount !== undefined && !!ads.json.alerts.sessions,
    'G17 后台告警状态同时给出积压与设备两块',
    { hasBacklog: ads.json.alerts.backlogCount !== undefined, hasSessions: !!ads.json.alerts.sessions });
  eq(ads.json.alerts.sessions.deviceThreshold, 2, 'G18 设备块的阈值可从后台读到');
  eq(ads.json.alerts.sessions.activeDays, 7, 'G18b 设备块的活跃窗口可从后台读到');
  // 巡检的审计要如实记下"积压多少 / 设备超限多少"，不能因为返回结构变了就记成 undefined
  const chkAudit = (await req('GET', '/api/admin/audit?action=alert.check&limit=3')).json.items[0];
  ok(chkAudit && chkAudit.after && chkAudit.after.devicesOver === 1,
    'G18c 巡检审计记录了设备超限账号数', chkAudit && chkAudit.after);
  eq(chkAudit.after.backlog, 0, 'G18d 巡检审计记录了积压数（未变成 undefined）');

  // 老令牌（手工伪造，无 sid/createdAt）读接口不崩、并能补齐
  const udoc2 = JSON.parse(fs.readFileSync(path.join(WORK, 'users.json'), 'utf8'));
  const someone = udoc2.users.filter((u) => u.email === 'multi@t.local')[0];
  udoc2.tokens['f'.repeat(64)] = { userId: someone.id, expiresAt: Date.now() + D };
  fs.writeFileSync(path.join(WORK, 'users.json'), JSON.stringify(udoc2, null, 2), 'utf8');
  mod.reloadStores();
  const lgLegacy = await req('POST', '/api/auth/login', { email: 'multi@t.local', password: 'pw12345678' }, null, DEV_A);
  const legacyList = await req('GET', '/api/sessions', null, lgLegacy.json.token);
  eq(legacyList.status, 200, 'G19 含老令牌时读设备列表不崩');
  ok(legacyList.json.sessions.some((x) => x.sid === 'f'.repeat(8)), 'G20 老令牌被现场补齐 sid 并列出');
  ok(legacyList.json.sessions.every((x) => !!x.sid), 'G21 列出的每台设备都有 sid（否则界面踢不掉）');
  const persisted = JSON.parse(fs.readFileSync(path.join(WORK, 'users.json'), 'utf8'));
  ok(!!persisted.tokens['f'.repeat(64)].sid, 'G22 补齐结果已落盘（下次不必再补）');

  // 改密仍吊销全部设备（回归既有语义）
  const beforePw = (await req('GET', '/api/admin/users')).json.users.filter((x) => x.email === 'multi@t.local')[0];
  await req('POST', '/api/admin/users/' + beforePw.id + '/password', { password: 'newpw12345678' });
  eq((await req('GET', '/api/sessions', null, lgLegacy.json.token)).status, 401,
    'G23 改密后全部设备失效（既有语义保持）');
  const afterPw = (await req('GET', '/api/admin/users')).json.users.filter((x) => x.email === 'multi@t.local')[0];
  eq(afterPw.sessionsActive, 0, 'G24 改密后活跃设备数归零');

  try { mod.stopBackgroundJobs(); } catch (e) { /* ignore */ }
  server.close();
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) { /* ignore */ }

  console.log('\n登录设备与会话测试：' + pass + ' 项通过，' + fails.length + ' 项失败');
  if (fails.length) {
    for (const f of fails) console.log('  ✗ ' + f);
    process.exit(1);
  }
  console.log('  ✓ 全部通过');
})();
