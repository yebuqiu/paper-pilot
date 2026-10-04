#!/usr/bin/env node
/* 管理操作审计测试（服务端 1.4.4）
 *
 * 运行：node test/audit.test.js
 *
 * 覆盖：
 *   纯函数 —— entry 规范化、redact 脱敏（密钥/密码/IP 之外一切照旧）、append 写 JSONL、
 *            list 的倒序与筛选、损坏行跳过、超限轮转成 audit.log.1、labelOf 中文名。
 *   接口   —— 跑一遍真实管理操作（用户/价格/会员配置/激活码/快照/告警/订单核销），
 *            再 GET /api/admin/audit 逐条核对；**并断言密钥绝不落进审计文件**。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-audit-'));
let PORT = 0;            // 端口由系统分配（listen(0) 后回读）：避免与用户本机常驻服务撞端口导致偶发 EADDRINUSE
process.env.PP_DATA_DIR = WORK;
process.env.PP_PORT = String(PORT);
delete process.env.PP_RESEND_KEY;
process.env.PP_LOGIN_MAX = '500';

const audit = require(path.join(__dirname, '..', 'server', 'lib', 'audit.js'));
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

const readAuditFile = () => {
  try { return fs.readFileSync(path.join(WORK, 'audit.log'), 'utf8'); } catch (e) { return ''; }
};

(async () => {
  try {
    /* ================= A. 纯函数 ================= */
    const TD = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-audit-pure-'));

    /* --- entry 规范化 --- */
    let e = audit.entry({ action: 'user.delete', target: 'a@b.c', ip: '1.2.3.4' });
    ok(/^\d{4}-\d{2}-\d{2}T/.test(e.at), 'A1 缺时间时补当前 ISO 时间', e.at);
    eq(audit.entry({ at: 'not-a-date' }).at, e.at.slice(0, 0) + audit.entry({}).at, 'A2 非法时间回落当前时间');
    eq(audit.entry({}).action, 'unknown', 'A3 缺 action 记为 unknown');
    eq(audit.entry({ action: 'x', ok: false }).ok, false, 'A4 ok=false 保留');
    eq(audit.entry({ action: 'x', ok: 0 }).ok, true, 'A5 只有显式 false 才算失败');

    /* --- redact 脱敏 --- */
    const r = audit.redact({
      apiKey: 'sk-live-abcdef', apiKeyMasked: 'sk-…', password: 'p@ss',
      token: 'tok', authorization: 'Bearer x', salt: 'abc', hash: 'def',
      note: 'ok', list: [{ secretKey: 'zzz' }], long: 'x'.repeat(300),
    });
    eq(r.apiKey, '***', 'A6 apiKey 被脱敏');
    eq(r.apiKeyMasked, '***', 'A7 apiKeyMasked 同样被脱敏（键名含 key）');
    eq(r.password, '***', 'A8 password 被脱敏');
    eq(r.token, '***', 'A9 token 被脱敏');
    eq(r.authorization, '***', 'A10 authorization 被脱敏');
    eq(r.salt, '***', 'A11 salt 被脱敏');
    eq(r.hash, '***', 'A12 hash 被脱敏');
    eq(r.note, 'ok', 'A13 普通字段照原样');
    eq(r.list[0].secretKey, '***', 'A14 嵌套对象也脱敏');
    ok(r.long.length < 300 && /…\(300\)$/.test(r.long), 'A15 超长字符串被截断并标注原长', r.long.slice(-12));

    /* --- append / list --- */
    audit.append(TD, { action: 'user.create', target: 'x@y.z', ip: '127.0.0.1' });
    audit.append(TD, { action: 'price.update', target: 'p1', before: { price: 29 }, after: { price: 19 } });
    audit.append(TD, { action: 'user.delete', target: 'x@y.z', ok: false, note: '模拟失败' });
    ok(fs.existsSync(path.join(TD, 'audit.log')), 'A16 append 会创建 audit.log');
    const raw = fs.readFileSync(path.join(TD, 'audit.log'), 'utf8').trim().split('\n');
    eq(raw.length, 3, 'A17 一行一条（JSONL）');
    ok(raw.every((l) => { try { JSON.parse(l); return true; } catch (err) { return false; } }), 'A18 每行都是合法 JSON');

    let items = audit.list(TD, { limit: 10 });
    eq(items.length, 3, 'A19 list 取回全部');
    eq(items[0].action, 'user.delete', 'A20 最新的在最前');
    eq(items[2].action, 'user.create', 'A21 最早的排最后');
    eq(items[1].after.price, 19, 'A22 before/after 原样带回');
    eq(audit.list(TD, { action: 'price.update' }).length, 1, 'A23 按 action 过滤');
    eq(audit.list(TD, { target: 'x@y.z' }).length, 2, 'A24 按 target 模糊匹配');
    eq(audit.list(TD, { ok: false }).length, 1, 'A25 按 ok=false 过滤');
    eq(audit.list(TD, { ok: true }).length, 2, 'A26 按 ok=true 过滤');
    eq(audit.list(TD, { limit: 1 }).length, 1, 'A27 limit 生效');
    eq(audit.list(TD, { since: '2000-01-01T00:00:00Z' }).length, 3, 'A28 since 很早 → 全部命中');
    eq(audit.list(TD, { until: '2000-01-01T00:00:00Z' }).length, 0, 'A29 until 很早 → 全部排除');

    // 损坏行不能让整个 list 崩掉
    fs.appendFileSync(path.join(TD, 'audit.log'), '{半截 JSON\n', 'utf8');
    eq(audit.list(TD, { limit: 10 }).length, 3, 'A30 损坏行被跳过而不是抛错');

    /* --- 轮转 --- */
    const RD = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-audit-rot-'));
    for (let i = 0; i < 12; i++) {
      audit.append(RD, { action: 'noop', target: 't' + i, note: 'x'.repeat(120) }, { maxBytes: 500 });
    }
    ok(fs.existsSync(path.join(RD, 'audit.log.1')), 'A31 超限后生成 audit.log.1');
    const kept = audit.list(RD, { limit: 100 });
    ok(kept.length > 1, 'A32 轮转后 list 仍能读到当前文件', kept.length);
    ok(kept.every((x) => x.action === 'noop'), 'A33 轮转内容可解析');
    fs.rmSync(RD, { recursive: true, force: true });

    /* --- labelOf --- */
    eq(audit.labelOf('order.fulfill'), '核销开通订单', 'A34 已知动作有中文名');
    eq(audit.labelOf('whatever.new'), 'whatever.new', 'A35 未知动作原样返回');
    ok(Object.keys(audit.ACTIONS).length >= 20, 'A36 动作表覆盖完整', Object.keys(audit.ACTIONS).length);

    const st = audit.stats(TD);
    ok(st.bytes > 0 && st.maxBytes > 0, 'A37 stats 给出体积与上限', st);

    /* ================= B. 真实接口：跑一遍管理操作 ================= */

    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    PORT = server.address().port;

    // 造数据：一个普通用户 + 一个待核销订单
    await req('POST', '/api/auth/register', { email: 'buyer@test.local', password: 'pw12345678' });
    const tok = (await req('POST', '/api/auth/login', { email: 'buyer@test.local', password: 'pw12345678' })).json.token;
    const order = (await req('POST', '/api/orders', { plan: 'Pro', months: 12 }, tok)).json.order;
    await req('POST', `/api/orders/${order.id}/claim`, null, tok);

    // 用户
    await req('POST', '/api/admin/users', { email: 'made@test.local', password: 'pw12345678', plan: 'Free' });
    const made = (await req('GET', '/api/admin/users')).json.users.find((u) => u.email === 'made@test.local');
    await req('PUT', `/api/admin/users/${made.id}`, { nickname: '改名了' });
    await req('POST', `/api/admin/users/${made.id}/password`, { password: 'newpw12345' });
    await req('POST', `/api/admin/users/${made.id}/membership`, { plan: 'Pro', months: 3, note: '测试开通' });
    await req('POST', `/api/admin/users/${made.id}/unlock`, {});

    // 价格表
    const created = (await req('POST', '/api/admin/prices', { plan: 'Pro', months: 24, price: 399, label: '两年' })).json.item;
    await req('PUT', `/api/admin/prices/${created.id}`, { price: 369 });
    await req('DELETE', `/api/admin/prices/${created.id}`);

    // 会员配置
    await req('PUT', '/api/admin/membership', { plans: { Free: { dailyLimit: 120 } } });

    // 激活码
    const codes = (await req('POST', '/api/admin/codes', { plan: 'Pro', months: 1, count: 2, note: '测试' })).json.codes;
    await req('DELETE', `/api/admin/codes/${codes[0].id}`);

    // 通道（带一个假密钥，用来验证不会被写进审计）
    await req('POST', '/api/admin/channels', { id: 'audit-ch', name: '审计通道', provider: 'custom',
      baseUrl: 'https://example.com/v1', apiKey: 'sk-super-secret-value', model: 'auto' });

    // 快照 / 告警 / 订单核销
    const snap = (await req('POST', '/api/admin/backups', { note: '审计测试快照' })).json.snapshot;
    await req('POST', '/api/admin/backups/' + snap.id + '/restore', { confirm: 'RESTORE' });
    await req('POST', '/api/admin/alerts/check', {});
    await req('POST', `/api/admin/orders/${order.id}/fulfill`, {});
    await req('DELETE', `/api/admin/backups/${snap.id}`);

    // 最后删用户
    await req('DELETE', `/api/admin/users/${made.id}`);

    /* ---- 读审计 ---- */
    const res = await req('GET', '/api/admin/audit?limit=200');
    eq(res.status, 200, 'B1 审计接口可读');
    const list = res.json.items || [];
    ok(list.length >= 18, 'B2 记下了足够多的操作', list.length);

    const seen = {};
    for (const it of list) seen[it.action] = (seen[it.action] || 0) + 1;
    const want = ['user.create', 'user.update', 'user.password', 'user.unlock', 'user.membership', 'user.delete',
      'price.create', 'price.update', 'price.delete', 'membership.config',
      'code.create', 'code.revoke', 'channel.create', 'backup.create', 'backup.restore',
      'backup.delete', 'alert.check', 'order.fulfill'];
    const missing = want.filter((a) => !seen[a]);
    ok(!missing.length, 'B3 所有被覆盖的写操作都留了痕 → 缺: ' + (missing.join(', ') || '无'), seen);
    eq(seen['user.create'], 1, 'B4 user.create 恰好 1 条');
    eq(seen['price.delete'], 1, 'B5 price.delete 恰好 1 条');

    ok(list.every((it) => !!it.actionText), 'B6 每条都带中文 actionText');
    ok(list.every((it) => it.ip === '127.0.0.1'), 'B7 记下了来源 IP', list[0].ip);
    ok(list.every((it) => !!it.at && !Number.isNaN(Date.parse(it.at))), 'B8 时间可解析');
    ok(list.map((x) => x.at).every((t, i, arr) => i === 0 || Date.parse(arr[i - 1]) >= Date.parse(t)),
      'B9 返回按时间倒序');

    const fu = list.find((x) => x.action === 'order.fulfill');
    eq(fu.target, order.id, 'B10 核销记录指向订单号');
    ok(/buyer@test.local/.test(fu.note), 'B11 核销记录写明下单账号', fu.note);
    eq(fu.after.months, 12, 'B12 记下开通时长');

    const pu = list.find((x) => x.action === 'price.update');
    eq(pu.before.price, 399, 'B13 改价记录了改前价');
    eq(pu.after.price, 369, 'B14 改价记录了改后价');

    const cc = list.find((x) => x.action === 'code.create');
    eq(cc.after.count, 2, 'B15 生成激活码记录数量');
    ok(!/PP-[A-Z0-9]{4}/.test(JSON.stringify(cc)), 'B16 激活码**码值本身不入审计**（它即凭据）');

    /* ---- 密钥绝不落盘 ---- */
    const rawAll = readAuditFile();
    ok(!rawAll.includes('sk-super-secret-value'), 'B17 通道密钥没有写进 audit.log');
    const chEntry = list.find((x) => x.action === 'channel.create');
    eq(chEntry.after.apiKeyMasked, '***', 'B18 通道条目里的密钥字段被替换为 ***');

    /* ---- 查询参数 ---- */
    const only = await req('GET', '/api/admin/audit?action=order.fulfill');
    eq(only.json.items.length, 1, 'B19 可按 action 过滤');
    const byTarget = await req('GET', '/api/admin/audit?target=' + encodeURIComponent(order.id));
    ok(byTarget.json.items.length >= 1 && byTarget.json.items.every((x) => String(x.target).includes(order.id)),
      'B20 可按 target 过滤');
    const lim = await req('GET', '/api/admin/audit?limit=3');
    eq(lim.json.items.length, 3, 'B21 可按 limit 截断');
    ok(!!lim.json.actions['user.create'] && !!lim.json.stats, 'B22 同时回传动作表与体积统计');

    /* ---- health ---- */
    const h = (await req('GET', '/api/health')).json;
    eq(h.version, '1.6.0', 'B23 服务端版本');
    ok(typeof h.auditBytes === 'number' && h.auditBytes > 0, 'B24 health 暴露审计日志体积', h.auditBytes);
  } catch (e) {
    fails.push('异常中断：' + ((e && e.stack) || e));
  } finally {
    try { mod.stopBackgroundJobs(); } catch (e) { /* ignore */ }
    server.close();
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  console.log('\n管理操作审计测试：' + pass + ' 项通过，' + fails.length + ' 项失败');
  if (fails.length) {
    for (const f of fails) console.log('  ✗ ' + f);
    process.exit(1);
  }
  console.log('  ✓ 全部通过');
})();
