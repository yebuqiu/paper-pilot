#!/usr/bin/env node
/* 服务端运维三件套集成测试（服务端 1.4.2）：数据快照/回滚 · 订单积压告警 · 账号级登录风控
 *
 * 运行：node test/server-ops.test.js
 * 说明：本文件在 require 服务端模块**之前**设置环境变量，用来把限速放开、
 *       把快照节流窗口放大，从而让用例确定性地验证节流行为。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-ops-'));
let PORT = 0;            // 端口由系统分配（listen(0) 后回读）：避免与用户本机常驻服务撞端口导致偶发 EADDRINUSE

process.env.PP_DATA_DIR = WORK;
process.env.PP_PORT = String(PORT);
delete process.env.PP_RESEND_KEY;          // 邮件关闭：告警退化为「只写日志」
delete process.env.PP_ALERT_EMAIL;
process.env.PP_LOGIN_MAX = '500';          // 放开 IP 限速，避免用例被 429 干扰
process.env.PP_REDEEM_MAX = '500';
process.env.PP_BACKUP_THROTTLE_MS = '600000';  // 10 分钟：验证「同类操作只留第一份」
process.env.PP_ALERT_BACKLOG_MIN = '30';
process.env.PP_ALERT_REPEAT_H = '6';

const SERVER = path.join(__dirname, '..', 'server', 'account-server.js');
const backupLib = require(path.join(__dirname, '..', 'server', 'lib', 'backup.js'));
const alertsLib = require(path.join(__dirname, '..', 'server', 'lib', 'alerts.js'));
const lockoutLib = require(path.join(__dirname, '..', 'server', 'lib', 'lockout.js'));
const mod = require(SERVER);
const { server } = mod;

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

function req(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined || body === null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = {};
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    if (token) headers['Authorization'] = 'Bearer ' + token;
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * 按订单号把 claimedAt 拨回到 N 分钟前，再重载内存 store（模拟"这笔订单已放置很久"）。
 * 必须按 id 精准回拨——曾经写成 `orders.find(status==='claimed')`，那是**数组里第一笔**
 * 而不是**最老那笔**，导致"最老订单换人"的去重用例假失败。
 */
function rewindOrder(orderId, minutes) {
  const f = path.join(WORK, 'membership.json');
  const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
  const o = doc.orders.find((x) => x.id === orderId);
  if (!o) return false;
  o.claimedAt = new Date(Date.now() - minutes * 60000).toISOString();
  fs.writeFileSync(f, JSON.stringify(doc, null, 2), 'utf8');
  mod.reloadStores();
  return true;
}

(async () => {
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  PORT = server.address().port;

  try {
    /* ================= A. 数据快照与一键回滚 ================= */

    // 造一个含密钥的 pp.env —— 快照绝不该把它复制进去
    fs.writeFileSync(path.join(WORK, 'pp.env'), 'PP_RESEND_KEY=re_fake_secret_for_test\n', 'utf8');

    await req('POST', '/api/auth/register', { email: 'keep@test.local', password: 'pw12345678' });
    await req('POST', '/api/auth/register', { email: 'gone@test.local', password: 'pw12345678' });
    let r = await req('GET', '/api/admin/users');
    eq(r.json.users.length, 2, 'A1 先建 2 个用户');

    // 手动打一份快照
    r = await req('POST', '/api/admin/backups', { note: '测试基线' });
    eq(r.status, 200, 'A2 手动快照成功');
    const baseId = r.json.snapshot.id;
    ok(/^\d{8}-\d{6}-manual$/.test(baseId), 'A3 快照 id 形如 时间戳-原因', baseId);
    ok(r.json.snapshot.files.some((f) => f.name === 'users.json'), 'A4 快照含 users.json');
    ok(r.json.snapshot.files.every((f) => f.name !== 'pp.env'), 'A5 快照刻意不含 pp.env（不复制密钥）');
    ok(r.json.snapshot.files.every((f) => f.sha256 && f.sha256.length === 64), 'A6 每个文件都留了 sha256');
    const snapDir = path.join(WORK, 'backup', baseId);
    ok(fs.existsSync(snapDir) && !fs.existsSync(path.join(snapDir, 'pp.env')),
      'A7 快照目录里确实没有 pp.env');

    // 删一个用户（写操作会自动打 membership/users 快照）
    const usersNow = (await req('GET', '/api/admin/users')).json.users;
    const gone = usersNow.find((u) => u.email === 'gone@test.local');
    r = await req('DELETE', '/api/admin/users/' + gone.id);
    eq(r.status, 200, 'A8 删除用户成功');
    eq((await req('GET', '/api/admin/users')).json.users.length, 1, 'A9 只剩 1 个用户');

    r = await req('GET', '/api/admin/backups');
    eq(r.status, 200, 'A10 快照列表可读');
    ok(r.json.items.length >= 2, 'A11 列表含手动快照与自动快照', r.json.items.map((i) => i.reason));
    ok(r.json.items.some((i) => i.reason === 'users-change'), 'A12 删除用户触发了 users-change 快照');
    ok(!!r.json.policy && /保留最近/.test(r.json.policy.text), 'A13 返回保留策略说明');

    // 回滚必须二次确认
    r = await req('POST', `/api/admin/backups/${baseId}/restore`, {});
    eq(r.status, 400, 'A14 未带确认的回滚被拒');
    ok(/RESTORE/.test(r.json.error || ''), 'A15 提示需要怎样的确认');
    r = await req('POST', `/api/admin/backups/${baseId}/restore`, { confirm: 'RESTORE' });
    eq(r.status, 200, 'A16 带确认的回滚成功');
    ok(r.json.result.safety, 'A17 回滚前先留了现场快照（可反悔）', r.json.result.safety);
    ok(r.json.result.restored.every((f) => f.ok), 'A18 回滚后逐文件 sha256 校验通过');
    eq(r.json.counts.after.users, 2, 'A19 内存 store 已重载（用户数回到 2）');
    r = await req('GET', '/api/admin/users');
    eq(r.json.users.length, 2, 'A20 被删的用户回来了');
    ok(r.json.users.some((u) => u.email === 'gone@test.local'), 'A21 恢复的是正确的那份数据');

    r = await req('GET', '/api/admin/backups');
    ok(r.json.items.some((i) => i.reason === 'pre-restore'), 'A22 现场快照已入库');

    r = await req('POST', '/api/admin/backups/nosuch/restore', { confirm: 'RESTORE' });
    eq(r.status, 404, 'A23 回滚不存在的快照 → 404');

    /* ---- A24-A26 节流：同类操作在窗口内只留第一份 ---- */
    const before = (await req('GET', '/api/admin/backups')).json.items
      .filter((i) => i.reason === 'membership-change').length;
    await req('POST', '/api/admin/prices', { plan: 'Pro', months: 6, price: 149, label: '半年' });
    await req('POST', '/api/admin/prices', { plan: 'Pro', months: 9, price: 199, label: '九月' });
    await req('PUT', '/api/admin/membership', { pay: { channel: '微信收款码' } });
    const after = (await req('GET', '/api/admin/backups')).json.items
      .filter((i) => i.reason === 'membership-change').length;
    eq(after - before, 1, 'A24 同一原因在节流窗口内只产生 1 份快照', { before, after });
    ok(after - before === 1, 'A25 连续 3 次会员域改动只多出 1 份快照（保住改动前的状态）');

    /* ---- A27 删除快照 ---- */
    const tmp = (await req('POST', '/api/admin/backups', { note: '待删' })).json.snapshot.id;
    r = await req('DELETE', '/api/admin/backups/' + tmp);
    eq(r.status, 200, 'A27 删除快照成功');
    ok(!(await req('GET', '/api/admin/backups')).json.items.some((i) => i.id === tmp), 'A28 列表已不含它');

    /* ---- A29-A33 保留策略（lib 级，用伪造时间戳控制）
     * 时间戳必须相对**当前**时间。曾经写成固定的 2026-01-xx → 距今已 9 个月，
     * 全部落在「每日锚点」窗口之外，锚点规则等于没被测到（期望 5 实得 3）。
     * 这里只用**整日偏移**（不做小时级偏移），避免「距 UTC 零点不足 1 小时」时
     * 两个时间戳落到不同 UTC 日、令锚点归属不确定。窗口天数取大于最大偏移，
     * 躲开 cutoff 边界上的浮点比较。 ---- */
    const pd = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-prune-'));
    const day = 86400e3;
    const nowMs = Date.now();
    const mkSnap = (name, atMs) => {
      const d = path.join(pd, 'backup', name);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'meta.json'),
        JSON.stringify({ id: name, at: new Date(atMs).toISOString(), reason: 'manual',
          files: [{ name: 'users.json', size: 1, sha256: 'x' }] }), 'utf8');
    };
    mkSnap('bk-today-a', nowMs);            // D0
    mkSnap('bk-today-b', nowMs);            // D0（同日第二份）
    mkSnap('bk-d1', nowMs - 1 * day);       // D-1
    mkSnap('bk-d2', nowMs - 2 * day);       // D-2
    mkSnap('bk-d5', nowMs - 5 * day);       // 窗口外
    mkSnap('bk-d6', nowMs - 6 * day);
    mkSnap('bk-d7', nowMs - 7 * day);
    mkSnap('bk-d8', nowMs - 8 * day);

    // 最近 2 份 = {today-a, today-b}（同属 D0）；
    // 最近 4 天锚点 = D0(1 份) ∪ D-1 ∪ D-2 → 补进 d1、d2 ⇒ 并集 4 份
    let pr = backupLib.prune(pd, { keepRecent: 2, dailyDays: 4 });
    eq(pr.kept, 4, 'A29 保留 = 最近 2 份 ∪ 最近 4 天每日锚点 = 4 份', pr);
    eq(backupLib.list(pd).length, 4, 'A30 实际剩下 4 份');
    eq(pr.removed.length, 4, 'A30b 窗口外的 4 份被清理', pr.removed);

    // 现有 {D0×2, D-1, D-2}：keepRecent=1 只留最新 1 份，
    // 但「最近 3 天锚点」把 D-1、D-2 救回来 ⇒ 3 份
    pr = backupLib.prune(pd, { keepRecent: 1, dailyDays: 3 });
    eq(backupLib.list(pd).length, 3, 'A31 「最近 1 份 + 最近 3 天锚点」= 3 份（锚点救回旧份）');
    ok(backupLib.list(pd).some((s) => s.at.slice(0, 10) === new Date(nowMs - 2 * day).toISOString().slice(0, 10)),
      'A32 两天前那份被每日锚点保留');
    eq(backupLib.list(pd)[0].reason, 'manual', 'A32b 列表按时间倒序读出原因');
    ok(backupLib.list(pd).every((s) => s.valid), 'A33 每份快照都带 meta（valid=true）');
    fs.rmSync(pd, { recursive: true, force: true });

    /* ---- A34-A36 快照内容被篡改时，回滚必须报错而不是静默写坏数据 ---- */
    const td = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-tamper-'));
    fs.writeFileSync(path.join(td, 'users.json'), JSON.stringify({ users: [{ id: 'u1' }], tokens: {} }), 'utf8');
    const sn = backupLib.snapshot(td, 'manual', { force: true }).snapshot;
    fs.writeFileSync(path.join(td, 'backup', sn.id, 'users.json'), '{"users":[]}', 'utf8');   // 篡改快照内容
    fs.writeFileSync(path.join(td, 'users.json'), '{"users":[{"id":"u1"},{"id":"u2"}],"tokens":{}}', 'utf8');
    const rs = backupLib.restore(td, sn.id);
    eq(rs.mismatched.length, 1, 'A34 篡改过的快照在回滚时被 sha256 抓出');
    eq(rs.safety !== null, true, 'A35 即便校验失败也留了现场快照');
    fs.rmSync(td, { recursive: true, force: true });

    /* ================= B. 订单积压告警 ================= */

    // 造一个已付款待核销的订单
    const tok = (await req('POST', '/api/auth/login', { email: 'keep@test.local', password: 'pw12345678' })).json.token;
    const order = (await req('POST', '/api/orders', { plan: 'Pro', months: 1 }, tok)).json.order;
    await req('POST', `/api/orders/${order.id}/claim`, null, tok);

    r = await req('GET', '/api/admin/alerts');
    eq(r.status, 200, 'B1 告警状态可读');
    eq(r.json.alerts.backlogCount, 1, 'B2 刚提交的订单算积压 1 笔');
    eq(r.json.alerts.backlogOverdue, false, 'B3 刚提交未超阈值 → 不告警');
    eq(r.json.alerts.thresholdMin, 30, 'B4 阈值来自 PP_ALERT_BACKLOG_MIN');
    ok(/PP_ALERT_EMAIL/.test(r.json.alerts.hint || ''), 'B5 未配收件人时明确提示怎么开', r.json.alerts.hint);
    eq(r.json.alerts.mailConfigured, false, 'B6 未配邮件服务时如实上报');

    r = await req('POST', '/api/admin/alerts/check', {});
    eq(r.json.result.alerted, false, 'B7 未超阈值 → 不告警');

    // 把订单的 claimedAt 拨回 45 分钟前
    ok(rewindOrder(order.id, 45), 'B8 把订单回拨到 45 分钟前');
    r = await req('POST', '/api/admin/alerts/check', {});
    eq(r.json.result.alerted, true, 'B9 超阈值 → 告警触发');
    eq(r.json.result.mailed, false, 'B10 未配收件人 → 不发邮件（只写日志）');
    ok(/PP_ALERT_EMAIL|PP_RESEND_KEY/.test(r.json.result.mailError || ''),
      'B11 如实说明为什么没发邮件', r.json.result.mailError);
    const logPath = path.join(WORK, 'alerts.log');
    ok(fs.existsSync(logPath), 'B12 alerts.log 已生成');
    const logTxt = fs.readFileSync(logPath, 'utf8');
    ok(/BACKLOG count=1 oldest=/.test(logTxt), 'B13 日志含可 grep 的积压行', logTxt.trim().split('\n').slice(-1)[0]);
    ok(/waiting=45min/.test(logTxt), 'B14 日志记录了等待时长');
    eq(r.json.alerts.lastAlertOrderId, order.id, 'B15 记住已告警的最老订单');

    // 去重：同一最老订单不重复告警（force=false 的内部巡检路径）
    let chk = await mod.runAlertCheck();
    eq(chk.alerted, false, 'B16 同一最老订单 → 不再重复告警');
    // 最老订单换人 → 立即再告警
    const tok2 = (await req('POST', '/api/auth/login', { email: 'gone@test.local', password: 'pw12345678' })).json.token;
    const o2 = (await req('POST', '/api/orders', { plan: 'Pro', months: 3 }, tok2)).json.order;
    await req('POST', `/api/orders/${o2.id}/claim`, null, tok2);
    rewindOrder(o2.id, 90);   // 让新订单成为最老（90 分钟）
    chk = await mod.runAlertCheck();
    eq(chk.alerted, true, 'B17 最老订单变了 → 立即再告警', chk.backlog);
    eq(chk.backlog.backlogCount, 2, 'B18 积压数更新为 2');

    // health 暴露积压观测
    r = await req('GET', '/api/health');
    eq(r.json.backlogCount, 2, 'B19 health 暴露 backlogCount');
    ok(r.json.backlogOldestMinutes >= 90, 'B20 health 暴露最老等待分钟数', r.json.backlogOldestMinutes);
    eq(r.json.backlogOverdue, true, 'B21 health 暴露是否超阈值');
    ok(typeof r.json.snapshots === 'number' && r.json.snapshots > 0, 'B22 health 暴露快照数量', r.json.snapshots);
    ok(!!r.json.lastSnapshotAt, 'B23 health 暴露最近快照时间');

    // 纯函数：阈值与去重窗口
    const bl = alertsLib.backlogOf({ orders: [{ id: 'x', status: 'claimed', claimedAt: new Date(Date.now() - 60000).toISOString() }] }, { threshold: 0.5 });
    eq(bl.over, true, 'B24 阈值可下调（0.5 分钟）→ 1 分钟的订单即超时');
    eq(alertsLib.backlogOf({ orders: [{ id: 'y', status: 'pending' }] }).count, 0,
      'B25 未付款（pending）不计入积压，避免噪音');
    const st = {};
    alertsLib.record(st, { count: 1, oldestId: 'a', oldestMinutes: 40 }, { mailed: true, now: Date.now() });
    eq(alertsLib.shouldAlert(st, { count: 1, oldestId: 'a', oldestMinutes: 40, over: true }, {}), false,
      'B26 窗口内同一订单不重复');
    eq(alertsLib.shouldAlert(st, { count: 1, oldestId: 'b', oldestMinutes: 40, over: true }, {}), true,
      'B27 换了订单立刻提醒');
    eq(alertsLib.shouldAlert(st, { count: 1, oldestId: 'a', oldestMinutes: 40, over: true },
      { now: Date.now() + 7 * 3600e3 }), true, 'B28 超过重复窗口（6h）再提醒');

    /* ================= C. 账号级登录风控 ================= */

    await req('POST', '/api/auth/register', { email: 'lock@test.local', password: 'correct-pw-123' });
    const lockUser = (await req('GET', '/api/admin/users')).json.users.find((u) => u.email === 'lock@test.local');
    ok(!!lockUser && lockUser.failCount === 0 && lockUser.locked === false, 'C1 新账号无失败计数、未锁定');

    // 4 次错误密码 → 仍未锁定
    for (let i = 1; i <= 4; i++) {
      r = await req('POST', '/api/auth/login', { email: 'lock@test.local', password: 'wrong-pw-' + i });
      eq(r.status, 401, `C2.${i} 第 ${i} 次密码错误 → 401`);
    }
    let lu = (await req('GET', '/api/admin/users')).json.users.find((u) => u.email === 'lock@test.local');
    eq(lu.failCount, 4, 'C3 失败计数累计到 4');
    eq(lu.locked, false, 'C4 未到阈值不锁定');
    eq(lu.lastFailIp, '127.0.0.1', 'C5 记录了失败来源 IP');

    // 第 5 次 → 触发锁定；应答仍是通用文案，不泄漏"账号被锁"这个额外信息
    r = await req('POST', '/api/auth/login', { email: 'lock@test.local', password: 'wrong-pw-5' });
    eq(r.status, 401, 'C6 第 5 次错误密码仍返回 401');
    eq(r.json.error, lockoutLib.GENERIC_FAIL, 'C7 应答文案与"邮箱不存在"完全一致（不泄漏账号状态）');
    lu = (await req('GET', '/api/admin/users')).json.users.find((u) => u.email === 'lock@test.local');
    eq(lu.locked, true, 'C8 到达阈值 → 账号已锁定');
    ok(lu.lockRemainMinutes > 0 && lu.lockRemainMinutes <= 15, 'C9 第一档锁定 15 分钟', lu.lockRemainMinutes);

    // 锁定期内即使密码正确也必须拒绝 —— 否则锁定形同虚设
    r = await req('POST', '/api/auth/login', { email: 'lock@test.local', password: 'correct-pw-123' });
    eq(r.status, 403, 'C10 锁定期内正确密码同样被拒');
    eq(r.json.code, 'account_locked', 'C11 返回可识别的错误码');
    ok(r.json.remainMinutes > 0, 'C12 告知剩余锁定时间（避免用户反复试）', r.json.remainMinutes);
    ok(/临时锁定/.test(r.json.error || ''), 'C13 文案说明是锁定而非密码错误', r.json.error);

    // 管理员一键解锁
    r = await req('POST', `/api/admin/users/${lockUser.id}/unlock`, {});
    eq(r.status, 200, 'C14 管理员解锁成功');
    ok(/解除锁定/.test(r.json.note || ''), 'C15 解锁结果有说明', r.json.note);
    lu = (await req('GET', '/api/admin/users')).json.users.find((u) => u.email === 'lock@test.local');
    eq(lu.locked, false, 'C16 解锁后不再锁定');
    eq(lu.failCount, 0, 'C17 解锁同时清零失败计数');

    r = await req('POST', '/api/auth/login', { email: 'lock@test.local', password: 'correct-pw-123' });
    eq(r.status, 200, 'C18 解锁后正确密码可登录');
    ok(!!r.json.token, 'C19 拿到令牌');
    lu = (await req('GET', '/api/admin/users')).json.users.find((u) => u.email === 'lock@test.local');
    eq(lu.failCount, 0, 'C20 登录成功清零失败计数');

    // 登录成功后再次失败 → 计数从 1 重新开始（不会接着旧计数直接锁死）
    r = await req('POST', '/api/auth/login', { email: 'lock@test.local', password: 'nope' });
    eq(r.status, 401, 'C21 成功后再失败 → 401');
    lu = (await req('GET', '/api/admin/users')).json.users.find((u) => u.email === 'lock@test.local');
    eq(lu.failCount, 1, 'C22 计数从 1 重新开始');

    // 邮箱不存在：文案一致，且不会凭空造 user
    r = await req('POST', '/api/auth/login', { email: 'nobody@test.local', password: 'whatever' });
    eq(r.status, 401, 'C23 不存在的邮箱 → 401');
    eq(r.json.error, lockoutLib.GENERIC_FAIL, 'C24 文案与密码错误一致');
    eq((await req('GET', '/api/admin/users')).json.users.filter((u) => u.email === 'nobody@test.local').length,
      0, 'C25 不会为不存在的邮箱建档');

    // 阶梯时长（纯函数）
    eq(lockoutLib.durationFor(4), 0, 'C26 未到阈值不锁');
    eq(lockoutLib.durationFor(5), 15 * 60e3, 'C27 第 5 次 → 15 分钟');
    eq(lockoutLib.durationFor(9), 15 * 60e3, 'C28 第 9 次仍在第一档');
    eq(lockoutLib.durationFor(10), 3600e3, 'C29 第 10 次 → 1 小时');
    eq(lockoutLib.durationFor(15), 6 * 3600e3, 'C30 第 15 次 → 6 小时');
    eq(lockoutLib.durationFor(20), 24 * 3600e3, 'C31 第 20 次 → 24 小时');
    eq(lockoutLib.durationFor(40), 24 * 3600e3, 'C32 封顶 24 小时');
    eq(lockoutLib.durationFor(100), 24 * 3600e3, 'C33 一直封顶');

    /* ================= D. 既有能力不回归 ================= */
    r = await req('GET', '/api/health');
    eq(r.json.version, '1.5.0', 'D1 服务端版本');
    ok(/Free/.test((r.json.plans || []).join(',')), 'D2 套餐仍在');
    r = await req('GET', '/api/admin/prices');
    ok(r.json.items.length >= 5, 'D3 价格表仍可用（含 A24 新增的两条）', r.json.items.length);
    r = await req('GET', '/api/admin/membership');
    eq(r.json.counts.awaitingReview, 2, 'D4 待核销计数正确');
  } catch (e) {
    fails.push('异常中断：' + ((e && e.stack) || e));
  } finally {
    try { mod.stopBackgroundJobs(); } catch (e) { /* ignore */ }
    server.close();
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  console.log('\n服务端运维三件套测试：' + pass + ' 项通过，' + fails.length + ' 项失败');
  if (fails.length) {
    for (const f of fails) console.log('  ✗ ' + f);
    process.exit(1);
  }
  console.log('  ✓ 全部通过');
})();
