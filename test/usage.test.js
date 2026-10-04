#!/usr/bin/env node
/* 用量趋势测试（服务端 1.4.3 / 插件 0.24.4）
 *
 * 运行：node test/usage.test.js
 *
 * 覆盖：
 *   纯函数 —— bumpUsage 累计 / 跨天重置当日计数 / daily 保留历史；
 *            pruneUsageDaily 只留最近 N 天（并清掉非法键）；
 *            usageDays 补零、长度正确、能兼容只有 {date,count} 的旧数据。
 *   接口   —— /api/auth/me 与 /api/membership 下发 usage{ today,limit,last7,days[30] }；
 *            /api/admin/users 带 usage7 / usage30 / usageDaily。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-usage-'));
let PORT = 0;            // 端口由系统分配（listen(0) 后回读）：避免与用户本机常驻服务撞端口导致偶发 EADDRINUSE
process.env.PP_DATA_DIR = WORK;
process.env.PP_PORT = String(PORT);
delete process.env.PP_RESEND_KEY;
process.env.PP_LOGIN_MAX = '500';

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

const dayShift = (n) => mod.isoDay(Date.now() + n * 86400e3);

(async () => {
  try {
    /* ================= A. 纯函数 ================= */

    const u = {};
    mod.bumpUsage(u, '2026-03-01');
    mod.bumpUsage(u, '2026-03-01');
    mod.bumpUsage(u, '2026-03-01');
    eq(u.usage.date, '2026-03-01', 'A1 当日日期写对');
    eq(u.usage.count, 3, 'A2 当日计数累计到 3');
    eq(u.usage.daily['2026-03-01'], 3, 'A3 daily 与当日计数一致');

    mod.bumpUsage(u, '2026-03-02');
    eq(u.usage.count, 1, 'A4 跨天当日计数归零后 +1');
    eq(u.usage.daily['2026-03-01'], 3, 'A5 跨天不丢历史');
    eq(u.usage.daily['2026-03-02'], 1, 'A6 新的一天另起一条');

    // 旧数据（只有 date/count，没有 daily）也要能继续累加，不把历史抹掉
    const legacy = { usage: { date: '2026-03-05', count: 7 } };
    mod.bumpUsage(legacy, '2026-03-05');
    eq(legacy.usage.count, 8, 'A7 旧结构继续累加');
    eq(legacy.usage.daily['2026-03-05'], 1, 'A8 旧结构首次写入 daily（从 1 开始）');
    // 兜底只在 daily 缺该日时生效：只有 {date,count} 的老账号也要读出当天值
    const onlyLegacy = { usage: { date: '2026-03-05', count: 8 } };
    eq(mod.usageDays(onlyLegacy, 3, '2026-03-05')[2].count, 8, 'A9 只有 {date,count} 的旧数据由兜底读出');
    eq(mod.usageDays(onlyLegacy, 3, '2026-03-05')[1].count, 0, 'A9b 旧数据的其余日子为 0');

    /* ---- pruneUsageDaily：只留最近 30 天 ---- */
    const daily = {};
    for (let i = 0; i < 45; i++) daily[dayShift(-i)] = 1;
    daily['not-a-date'] = 9;
    mod.pruneUsageDaily(daily, dayShift(0), 30);
    const keys = Object.keys(daily).filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k));
    eq(keys.length, 30, 'A10 保留 30 天（45 天入参）', keys.length);
    ok(!('not-a-date' in daily), 'A11 非法键被清掉');
    ok(keys.includes(dayShift(0)) && keys.includes(dayShift(-29)), 'A12 保留的是最近 30 天（含今天与 29 天前）');
    ok(!keys.includes(dayShift(-30)), 'A13 第 30 天前的那条被淘汰');

    /* ---- usageDays：补零 + 长度 + 顺序 ---- */
    const list = mod.usageDays({ usage: { date: '2026-03-10', count: 4, daily: { '2026-03-10': 4, '2026-03-08': 2 } } }, 5, '2026-03-10');
    eq(list.length, 5, 'A14 usageDays 长度 = 请求天数');
    eq(list[4].date, '2026-03-10', 'A15 末位是当天');
    eq(list[4].count, 4, 'A16 当天值正确');
    eq(list[2].date, '2026-03-08', 'A17 中间那天对齐（3-08）');
    eq(list[2].count, 2, 'A18 缺失日补 0 之外有值的那天正确');
    eq(list[0].count, 0, 'A19 无记录的日子补 0');
    eq(mod.usageDays({}, 30).length, 30, 'A20 空用户也能给出 30 天骨架');
    eq(mod.usageDays({}, 500).length, 90, 'A21 天数上限 90（防滥用）');
    eq(mod.usageDays({}, 0).length, 30, 'A22 非法天数回落 30');

    /* ================= B. 接口下发 ================= */

    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    PORT = server.address().port;

    await req('POST', '/api/auth/register', { email: 'usage@test.local', password: 'pw12345678' });
    const tok = (await req('POST', '/api/auth/login', { email: 'usage@test.local', password: 'pw12345678' })).json.token;
    ok(!!tok, 'B1 注册并登录成功');

    let me = (await req('GET', '/api/auth/me', null, tok)).json.user;
    ok(!!me.usage, 'B2 /api/auth/me 下发 usage');
    eq(me.usage.days.length, 30, 'B3 usage.days 为 30 天');
    eq(me.usage.today, 0, 'B4 新账号今日用量 0');
    eq(me.usage.last7, 0, 'B5 新账号近 7 天合计 0');
    eq(me.usage.days[29].date, mod.today(), 'B6 末位是今天');
    eq(me.dailyUsed, 0, 'B7 旧字段 dailyUsed 仍在（向后兼容）');

    // 直接改盘再重载，模拟"昨天用了 5 次、今天用了 2 次"
    const usersFile = path.join(WORK, 'users.json');
    const udoc = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
    const su = udoc.users.find((x) => x.email === 'usage@test.local');
    su.usage = { date: mod.today(), count: 2, daily: { [dayShift(-1)]: 5, [mod.today()]: 2 } };
    fs.writeFileSync(usersFile, JSON.stringify(udoc, null, 2), 'utf8');
    mod.reloadStores();

    me = (await req('GET', '/api/auth/me', null, tok)).json.user;
    eq(me.usage.today, 2, 'B8 today 取当日计数');
    eq(me.usage.last7, 7, 'B9 last7 = 昨天 5 + 今天 2');
    eq(me.usage.days[28].count, 5, 'B10 昨天的值出现在倒数第二位');
    eq(me.usage.days[28].date, dayShift(-1), 'B11 倒数第二位是昨天');

    const mb = (await req('GET', '/api/membership', null, tok)).json;
    ok(!!(mb.user && mb.user.usage), 'B12 /api/membership 同时回传 user（含 usage）');
    eq(mb.user.usage.last7, 7, 'B13 其中的 last7 一致');

    const adm = (await req('GET', '/api/admin/users')).json.users.find((x) => x.email === 'usage@test.local');
    eq(adm.usageDaily.length, 30, 'B14 管理端带 usageDaily（30 天）');
    eq(adm.usage7, 7, 'B15 管理端 usage7 正确');
    eq(adm.usage30, 7, 'B16 管理端 usage30 正确');

    // 落盘也要带上 daily（重启后趋势不丢）
    const after = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
    const su2 = after.users.find((x) => x.email === 'usage@test.local');
    ok(!!(su2.usage && su2.usage.daily), 'B17 usage.daily 已落盘（重启不丢趋势）');
    eq(mod.usageDays(su2, 7).reduce((s, d) => s + d.count, 0), 7, 'B18 从落盘数据复算 last7 仍为 7');
  } catch (e) {
    fails.push('异常中断：' + ((e && e.stack) || e));
  } finally {
    try { mod.stopBackgroundJobs(); } catch (e) { /* ignore */ }
    server.close();
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  console.log('\n用量趋势测试：' + pass + ' 项通过，' + fails.length + ' 项失败');
  if (fails.length) {
    for (const f of fails) console.log('  ✗ ' + f);
    process.exit(1);
  }
  console.log('  ✓ 全部通过');
})();
