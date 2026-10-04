#!/usr/bin/env node
/* 网关 AI 计量端到端测试（服务端 1.5.0）
 *
 * 运行：node test/metering.test.js
 *
 * 做法：起一个**假上游**（本地 http），把活动通道指向它，然后走真实网关链路，
 * 断言 token / 成本确实被记到 user.usage 上。覆盖：
 *   A 非流式 auto  —— 按「响应里的真实模型」计价（不是按请求里的 auto）
 *   B 流式        —— 自动注入 stream_options.include_usage，且末片 usage 被解析
 *   C 上游不给 usage —— 计入 missingUsage（不是 0 成本）
 *   D 上游 4xx    —— 不计次（保持旧口径）
 *   E 未配价模型   —— known=false、成本 0，且后台 unconfigured 列表能揪出来
 *   F 通道级 streamUsage:false —— 不注入 include_usage（兼容不认这个参数的上游）
 *   G 后台接口     —— /api/admin/pricing 与 /api/admin/usage-summary
 *   H 客户端下发   —— /api/auth/me 的 cost 视图
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-metering-'));
process.env.PP_DATA_DIR = WORK;
process.env.PP_PORT = '0';
delete process.env.PP_RESEND_KEY;
process.env.PP_LOGIN_MAX = '500';

let UPSTREAM_PORT = 0;
/** 假上游记录的最近一次请求（用于断言 include_usage 注入） */
let lastUpstreamBody = null;
let upstreamCalls = 0;

const USAGE = { prompt_tokens: 22, completion_tokens: 30, total_tokens: 52 };

/** 假 OpenAI 兼容上游 */
const upstream = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u.endsWith('/models')) {
    const body = JSON.stringify({ data: [{ id: 'auto' }, { id: 'glm-5.3-flash' }, { id: 'nousage-model' }] });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(body);
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    upstreamCalls += 1;
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (e) { /* ignore */ }
    lastUpstreamBody = body;
    const asked = String(body.model || '');
    if (asked === 'fail-model') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'bad request' } }));
    }
    // 上游把 auto/别名解析成真实模型名（真实上游就是这么干的）
    const real = (asked === 'auto' || asked === 'upstream-default') ? 'glm-5.3-flash' : asked;
    const withUsage = real !== 'nousage-model';

    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const base = { id: 'c1', object: 'chat.completion.chunk', model: real };
      res.write('data: ' + JSON.stringify(Object.assign({}, base, {
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      })) + '\n\n');
      res.write('data: ' + JSON.stringify(Object.assign({}, base, {
        choices: [{ index: 0, delta: { content: '你好' }, finish_reason: null }],
      })) + '\n\n');
      // 只有被要求 include_usage 时才给末尾 usage 分片（与真实上游一致）
      const wantUsage = !!(body.stream_options && body.stream_options.include_usage);
      res.write('data: ' + JSON.stringify(Object.assign({}, base, {
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: wantUsage && withUsage ? USAGE : null,
      })) + '\n\n');
      return res.end('data: [DONE]\n\n');
    }

    const out = { id: 'c1', object: 'chat.completion', model: real,
      choices: [{ index: 0, message: { role: 'assistant', content: '你好' }, finish_reason: 'stop' }] };
    if (withUsage) out.usage = USAGE;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
  });
});

let mod = null;
let PORT = 0;

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
        const text = Buffer.concat(cs).toString('utf8');
        let j = null;
        try { j = JSON.parse(text); } catch (e) { /* SSE 或非 JSON */ }
        resolve({ status: res.statusCode, json: j, text });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/** 取某账号当前落盘的 usage */
function usageOf(email) {
  const doc = JSON.parse(fs.readFileSync(path.join(WORK, 'users.json'), 'utf8'));
  const u = doc.users.find((x) => x.email === email);
  return (u && u.usage) || {};
}
const todayKey = () => mod.isoDay(Date.now());

(async () => {
  try {
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    UPSTREAM_PORT = upstream.address().port;

    // 通道指向假上游（必须在 require 服务端之前落盘）
    fs.writeFileSync(path.join(WORK, 'channels.json'), JSON.stringify({
      channels: [{
        id: 'fake', name: 'fake', provider: 'custom',
        baseUrl: 'http://127.0.0.1:' + UPSTREAM_PORT + '/v1',
        apiKey: 'sk-fake', model: 'glm-5.3-flash',
        models: ['auto', 'glm-5.3-flash', 'nousage-model', 'fail-model'],
      }],
      active: 'fake',
    }, null, 2), 'utf8');

    mod = require(path.join(__dirname, '..', 'server', 'account-server.js'));
    const { server } = mod;
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    PORT = server.address().port;

    await req('POST', '/api/auth/register', { email: 'meter@test.local', password: 'pw12345678' });
    const tok = (await req('POST', '/api/auth/login', { email: 'meter@test.local', password: 'pw12345678' })).json.token;
    ok(!!tok, 'A0 注册并登录成功');

    // 配价：glm-5.3-flash 输入 0.0008 / 输出 0.002（元/千 token）
    const put = await req('PUT', '/api/admin/pricing', {
      set: { 'glm-5.3-flash': { inPer1k: 0.0008, outPer1k: 0.002 } },
    });
    eq(put.status, 200, 'A1 写入单价成功');
    ok(put.json && put.json.ok, 'A2 返回 ok');
    eq(put.json.pricing.models.length, 1, 'A3 单价表落 1 条');

    /* ---------- A. 非流式 auto ---------- */
    upstreamCalls = 0;
    const r1 = await req('POST', '/v1/chat/completions',
      { model: 'auto', messages: [{ role: 'user', content: 'hi' }] }, tok);
    eq(r1.status, 200, 'A4 非流式转发 200');
    eq(r1.json.model, 'glm-5.3-flash', 'A5 客户端收到上游真实模型名');
    eq(upstreamCalls, 1, 'A6 上游确实被调用一次');
    ok(!(lastUpstreamBody.stream_options), 'A7 非流式不注入 stream_options');

    // (22*0.0008 + 30*0.002) * 1000 = 78 微元
    let us = usageOf('meter@test.local');
    eq(us.count, 1, 'A8 次数 +1');
    eq(us.daily[todayKey()], 1, 'A9 当日次数为 1');
    eq(us.inTok[todayKey()], 22, 'A10 输入 token 记录');
    eq(us.outTok[todayKey()], 30, 'A11 输出 token 记录');
    eq(us.costMicro[todayKey()], 78, 'A12 成本 78 微元（按真实模型计价）');
    eq(us.missingUsage, 0, 'A13 无计量盲区');
    eq(Object.keys(us.byModel).join(','), 'glm-5.3-flash', 'A14 ★ 按 auto 的**真实模型**归集，键不是 auto');

    /* ---------- B. 流式 ---------- */
    lastUpstreamBody = null;
    const r2 = await req('POST', '/v1/chat/completions',
      { model: 'glm-5.3-flash', messages: [{ role: 'user', content: 'hi' }], stream: true }, tok);
    eq(r2.status, 200, 'B1 流式转发 200');
    ok(r2.text.includes('data: [DONE]'), 'B2 SSE 完整透传（含 [DONE]）');
    ok(r2.text.includes('你好'), 'B3 SSE 内容透传给客户端');
    ok(!!(lastUpstreamBody && lastUpstreamBody.stream_options
      && lastUpstreamBody.stream_options.include_usage === true), 'B4 ★ 自动注入 stream_options.include_usage');

    us = usageOf('meter@test.local');
    eq(us.count, 2, 'B5 流式也计数');
    eq(us.inTok[todayKey()], 44, 'B6 流式 token 被解析并累加（22×2）');
    eq(us.outTok[todayKey()], 60, 'B7 输出 token 累加（30×2）');
    eq(us.costMicro[todayKey()], 156, 'B8 成本累加（78×2）');

    /* ---------- C. 上游不给 usage ---------- */
    await req('POST', '/v1/chat/completions',
      { model: 'nousage-model', messages: [{ role: 'user', content: 'hi' }] }, tok);
    us = usageOf('meter@test.local');
    eq(us.count, 3, 'C1 无 usage 的调用仍计次');
    eq(us.missingUsage, 1, 'C2 ★ 上游未返回 usage → missingUsage +1（不是 0 成本）');
    eq(us.costMicro[todayKey()], 156, 'C3 计量盲区不污染成本数字');
    ok(!('nousage-model' in us.byModel), 'C4 无 usage 不进 byModel（避免伪造 0 成本记录）');

    /* ---------- D. 上游 4xx ---------- */
    upstreamCalls = 0;
    const r4 = await req('POST', '/v1/chat/completions',
      { model: 'fail-model', messages: [{ role: 'user', content: 'hi' }] }, tok);
    eq(r4.status, 400, 'D1 上游 4xx 透传状态码');
    eq(upstreamCalls, 1, 'D2 上游确实被调用');
    us = usageOf('meter@test.local');
    eq(us.count, 3, 'D3 ★ 上游 4xx 不计次（保持旧口径）');
    eq(us.missingUsage, 1, 'D4 4xx 也不计入计量盲区');

    /* ---------- E. 未配价模型 ---------- */
    await req('POST', '/v1/chat/completions',
      { model: 'auto', messages: [{ role: 'user', content: 'hi' }] }, tok);
    // 把 glm-5.3-flash 的价删掉 → 后续调用虽有 usage 但无价
    await req('PUT', '/api/admin/pricing', { remove: ['glm-5.3-flash'] });
    await req('POST', '/v1/chat/completions',
      { model: 'auto', messages: [{ role: 'user', content: 'hi' }] }, tok);
    const pr = (await req('GET', '/api/admin/pricing')).json.pricing;
    ok(pr.unconfigured.includes('glm-5.3-flash'), 'E1 ★ 未配价但被调用过的模型出现在 unconfigured', pr.unconfigured);
    const usedRow = pr.usedModels.find((x) => x.model === 'glm-5.3-flash');
    ok(usedRow && usedRow.configured === false, 'E2 usedModels 标出 configured=false');
    eq(usedRow.inTok, 22 * 4, 'E3 未配价也照常记 token（数据不能丢）');
    // 恢复价格，后续断言用它
    await req('PUT', '/api/admin/pricing', { set: { 'glm-5.3-flash': { inPer1k: 0.0008, outPer1k: 0.002 } } });

    /* ---------- F. 通道级 streamUsage:false ---------- */
    await req('PUT', '/api/admin/channels/fake', {
      id: 'fake', baseUrl: 'http://127.0.0.1:' + UPSTREAM_PORT + '/v1', apiKey: 'sk-fake',
      streamUsage: false,
    });
    lastUpstreamBody = null;
    await req('POST', '/v1/chat/completions',
      { model: 'glm-5.3-flash', messages: [{ role: 'user', content: 'hi' }], stream: true }, tok);
    ok(!!(lastUpstreamBody && !lastUpstreamBody.stream_options), 'F1 ★ 通道关掉后不注入 include_usage');
    us = usageOf('meter@test.local');
    eq(us.missingUsage, 2, 'F2 不注入 ⇒ 上游不给 usage ⇒ 计入盲区（如实反映）');
    // 恢复通道开关
    await req('PUT', '/api/admin/channels/fake', {
      id: 'fake', baseUrl: 'http://127.0.0.1:' + UPSTREAM_PORT + '/v1', apiKey: 'sk-fake', streamUsage: true,
    });

    /* ---------- G. 成本看板 ---------- */
    const sum = (await req('GET', '/api/admin/usage-summary?days=7')).json.summary;
    eq(sum.days, 7, 'G1 窗口天数按参数解析');
    eq(sum.byDay.length, 7, 'G2 byDay 长度为 7');
    eq(sum.totals.n, us.count, 'G3 总量次数与账号次数一致');
    ok(sum.totals.costMicro > 0, 'G4 总成本 > 0');
    ok(sum.byDay[6].costMicro === sum.totals.costMicro, 'G5 今天的成本 = 窗口总量（只有今天的记录）');
    eq(sum.topUsers.length, 1, 'G6 Top 账号 1 个');
    eq(sum.topUsers[0].email, 'meter@test.local', 'G7 Top 账号是测试账号');
    ok(sum.totals.missingUsage === 2, 'G8 看板汇总计量盲区');
    ok(sum.byModelAllTime.some((m) => m.model === 'glm-5.3-flash'), 'G9 按模型累计含 glm-5.3-flash');

    /* ---------- H. 客户端 cost 视图 ---------- */
    const me = (await req('GET', '/api/auth/me', null, tok)).json.user;
    ok(!!me.cost, 'H1 /api/auth/me 下发 cost 视图');
    eq(me.cost.today.totalTok, us.inTok[todayKey()] + us.outTok[todayKey()], 'H2 today token 合计正确');
    eq(me.cost.today.costMicro, us.costMicro[todayKey()], 'H3 today 成本与落盘一致');
    ok(typeof me.cost.today.text === 'string' && me.cost.today.text.startsWith('¥'), 'H4 成本文案已格式化');
    eq(me.cost.missingUsage, 2, 'H5 计量盲区透出给客户端');
    eq(me.cost.currency, 'CNY', 'H6 币种');

    /* ---------- I. health 暴露计量状态 ---------- */
    const h = (await req('GET', '/api/health')).json;
    eq(h.version, '1.6.0', 'I1 服务端版本 1.6.0');
    eq(h.pricedModels, 1, 'I2 health 报告已配价模型数');
    eq(h.meteringGaps, 2, 'I3 health 报告计量盲区累计');
  } catch (e) {
    fails.push('异常中断：' + ((e && e.stack) || e));
  } finally {
    try { if (mod) mod.stopBackgroundJobs(); } catch (e) { /* ignore */ }
    try { if (mod) mod.server.close(); } catch (e) { /* ignore */ }
    try { upstream.close(); } catch (e) { /* ignore */ }
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  console.log('\n网关计量测试：' + pass + ' 项通过，' + fails.length + ' 项失败');
  if (fails.length) {
    for (const f of fails) console.log('  ✗ ' + f);
    process.exit(1);
  }
  console.log('  ✓ 全部通过');
})();
