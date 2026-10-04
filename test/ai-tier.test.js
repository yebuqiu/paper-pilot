#!/usr/bin/env node
/* 套餐 AI 能力：高级模型白名单 + 新用户全模型试用（服务端 1.4.9）
 *
 * 运行：node test/ai-tier.test.js
 *
 * 设计要点（本套测试要钉住的语义）：
 *   1. 「高级模型」= 上线清单（publishedModels）的**子集**，由 channels.json 的
 *      highTierModels 标出；套餐用已有的 plans[].highTierModels 开关决定能不能用。
 *   2. **auto 恒定免费**——它映射到通道默认模型，是全部用户的兜底入口，
 *      即使被误配进高级清单也不锁（防误配把所有人锁死）。
 *   3. 越权调用**明确 403**（code=MODEL_REQUIRES_PRO），不静默换成便宜模型。
 *   4. 试用 = 以 user.createdAt 为起点现场计算 ⇒ 零迁移；trialDays=0 即关闭。
 *   5. "过期不踢下线"的既有语义在此同样成立：套餐/试用结束只收模型，
 *      会话与其它功能不受影响。
 *
 * 覆盖：纯函数边界（毫秒级）→ 配置端点 → /v1/models 按套餐 → gatewayChat 门禁
 *      → /api/auth/me 的 ai 块 → **试用到期真 E2E（老化 createdAt + reloadStores）**
 *      → health / 审计 / 不泄露敏感字段。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-aitier-'));
let PORT = 0;            // 端口由系统分配（listen(0) 后回读）：避免与用户本机常驻服务撞端口导致偶发 EADDRINUSE
process.env.PP_DATA_DIR = WORK;
process.env.PP_PORT = String(PORT);
delete process.env.PP_RESEND_KEY;
process.env.PP_LOGIN_MAX = '500';

const membership = require(path.join(__dirname, '..', 'server', 'lib', 'membership.js'));
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
  return ok(String(hay).indexOf(needle) >= 0, label, { text: String(hay).slice(0, 200), want: needle });
}

const D = 86400e3;
const FREE_MODELS = ['deepseek-v4-flash', 'glm-5.3-flash', 'minimax-m3'];
const HIGH_MODELS = ['deepseek-v4-pro', 'hunyuan-2.0-thinking'];
const ALL_PUBLISHED = FREE_MODELS.concat(HIGH_MODELS);

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
        const text = Buffer.concat(cs).toString('utf8');
        let j = null;
        try { j = JSON.parse(text); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, json: j, text });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function login(email, pw) {
  const r = await req('POST', '/api/auth/login', { email, password: pw });
  return r.json && r.json.token;
}
async function me(token) { return (await req('GET', '/api/auth/me', null, token)).json; }
async function modelsOf(token) {
  const r = await req('GET', '/v1/models', null, token);
  return ((r.json && r.json.data) || []).map((x) => x.id);
}
/** 只关心「有没有被 403 拦下」——上游不可达时会是 502，那是另一回事 */
async function chat(token, model) {
  const r = await req('POST', '/v1/chat/completions',
    { model, messages: [{ role: 'user', content: 'hi' }] }, token);
  return r;
}

(async () => {
  /* ================= A. 试用纯函数（毫秒级边界） ================= */
  {
    const base = Date.parse('2026-10-03T00:00:00.000Z');
    const at = (msAgo) => new Date(base - msAgo).toISOString();
    const s1 = membership.trialState(at(0), 7, base);
    eq(s1.active, true, 'A1 刚注册 → 试用中');
    eq(s1.daysLeft, 7, 'A2 剩余 7 天');
    has(s1.endsAt, '2026-10-10', 'A3 结束时间 = 注册 + 7 天');

    const s2 = membership.trialState(at(6 * D), 7, base);
    eq(s2.active, true, 'A4 第 6 天仍在试用');
    eq(s2.daysLeft, 1, 'A5 剩余 1 天');

    // 边界：到点即结束（left <= 0）
    const s3 = membership.trialState(at(7 * D), 7, base);
    eq(s3.active, false, 'A6 刚好到期 → 已结束（边界取 <=）');
    eq(s3.daysLeft, 0, 'A7 到期后剩余 0 天');
    ok(!!s3.endsAt, 'A8 到期后仍给出 endsAt（供「试用已于 X 结束」文案）', s3.endsAt);

    const s4 = membership.trialState(at(7 * D - 1), 7, base);
    eq(s4.active, true, 'A9 到期前 1 毫秒仍算试用中（不用 > 号偷跑）');

    const s5 = membership.trialState(at(30 * D), 7, base);
    eq(s5.active, false, 'A10 过期 30 天 → 不活跃');

    eq(membership.trialState(at(0), 0, base).active, false, 'A11 trialDays=0 → 关闭');
    eq(membership.trialState(at(0), 0, base).endsAt, null, 'A12 关闭时不编造 endsAt');
    eq(membership.trialState('', 7, base).active, false, 'A13 createdAt 缺失 → 不给默认试用');
    eq(membership.trialState('not-a-date', 7, base).active, false, 'A14 createdAt 是脏值 → 不给试用');
    eq(membership.trialState(at(0), -5, base).active, false, 'A15 trialDays 负数 → 关闭');
    eq(membership.trialState(at(0), 999, base).days, 365, 'A16 trialDays 超上限夹到 365');
  }

  /* ================= B. 配置归一化 ================= */
  {
    const d1 = membership.normalize(membership.newDoc());
    eq(membership.trialDaysFor(d1), 7, 'B1 默认试用 7 天');

    const d2 = membership.normalize(membership.newDoc());
    d2.ai.trialDays = 0;
    eq(membership.trialDaysFor(membership.normalize(d2)), 0, 'B2 0 = 关闭（不被夹成 1）');

    const d3 = membership.normalize(membership.newDoc());
    d3.ai.trialDays = 9999;
    eq(membership.trialDaysFor(membership.normalize(d3)), 365, 'B3 越界夹取到 365');

    const d4 = membership.normalize(membership.newDoc());
    d4.ai.trialDays = 'abc';
    eq(membership.trialDaysFor(membership.normalize(d4)), 7, 'B4 非法值回落默认而非变 0');

    const d5 = membership.normalize(membership.newDoc());
    d5.ai = null;
    eq(membership.trialDaysFor(membership.normalize(d5)), 7, 'B5 ai 缺失时重建默认');

    // 高级模型开关（既有字段，此前无处可改）
    eq(membership.planOf(d1, 'Free').highTierModels, false, 'B6 Free 默认不可用高级模型');
    eq(membership.planOf(d1, 'Pro').highTierModels, true, 'B7 Pro 默认可用高级模型');
  }

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  PORT = server.address().port;

  /* ---- 配置通道 / 上线清单 / 高级清单 ---- */
  await req('POST', '/api/admin/channels', {
    id: 't1', name: '测试通道', provider: 'custom',
    baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-test',
    model: 'glm-5.3-flash', models: ALL_PUBLISHED.slice(),
  });
  await req('PUT', '/api/admin/channels/active', { id: 't1' });
  await req('PUT', '/api/admin/channels/published', { models: ALL_PUBLISHED.slice() });

  /* ================= C. 配置端点 ================= */
  {
    const c1 = await req('PUT', '/api/admin/channels/high-tier', { models: HIGH_MODELS.slice() });
    eq(c1.status, 200, 'C1 保存高级模型清单');
    eq(c1.json.highTierModels.length, 2, 'C2 回传清单');
    eq(c1.json.outsidePublished.length, 0, 'C3 清单内模型都在上线范围内');

    const c2 = await req('GET', '/api/admin/channels');
    eq(c2.json.highTierModels.join(','), HIGH_MODELS.join(','), 'C4 通道接口回传高级清单');

    const c3 = await req('PUT', '/api/admin/channels/high-tier', { models: ['nope-not-published'] });
    eq(c3.status, 200, 'C5 不在上线范围内的模型只提示不阻断（可能先配分级再放开）');
    eq(c3.json.outsidePublished.join(','), 'nope-not-published', 'C6 明确指出越界项');
    // 复位
    await req('PUT', '/api/admin/channels/high-tier', { models: HIGH_MODELS.slice() });

    const c4 = await req('PUT', '/api/admin/channels/high-tier', { models: 'not-array' });
    eq(c4.status, 400, 'C7 models 非数组 → 400');

    // 关闭试用，便于先测「Free 无试用」的基线
    const c5 = await req('PUT', '/api/admin/membership', { ai: { trialDays: 0 } });
    eq(c5.status, 200, 'C8 改试用天数为 0');
    const c6 = await req('GET', '/api/admin/membership');
    eq(c6.json.ai ? c6.json.ai.trialDays : null, 0, 'C9 会员配置接口回读 ai.trialDays');

    const c7 = await req('PUT', '/api/admin/membership', { ai: { trialDays: 'abc' } });
    eq(c7.status, 400, 'C10 非法 trialDays → 400（拒绝，不静默夹取）');

    // 套餐的高级模型开关（此前只定义、无处可改）
    const c8 = await req('PUT', '/api/admin/membership', { plans: { Free: { highTierModels: true } } });
    eq(c8.status, 200, 'C11 Free 的高级模型开关可被管理端修改');
    // 注意：该接口把 plansForClient 整体放在 plans 下（plans.plans 才是数组）
    const freeP = (((c8.json.plans || {}).plans) || []).find((p) => p.id === 'Free');
    eq(freeP && freeP.highTierModels, true, 'C12 开关真的写进去了');
    await req('PUT', '/api/admin/membership', { plans: { Free: { highTierModels: false } } });
  }

  /* ---- 建用户 ---- */
  const PWF = 'pw12345678';
  await req('POST', '/api/auth/register', { email: 'free@t.local', password: PWF });
  await req('POST', '/api/auth/register', { email: 'pro@t.local', password: PWF });
  const tFree = await login('free@t.local', PWF);
  const tPro = await login('pro@t.local', PWF);
  ok(!!tFree && !!tPro, 'C13 两个测试账号登录成功');

  const proU = (await req('GET', '/api/admin/users')).json.users.find((u) => u.email === 'pro@t.local');
  await req('POST', '/api/admin/users/' + proU.id + '/membership', { plan: 'Pro', months: 1 });

  /* ================= D. /v1/models 按套餐过滤 ================= */
  {
    const mFree = await modelsOf(tFree);
    eq(mFree[0], 'auto', 'D1 auto 恒在首位（兜底入口）');
    for (const m of FREE_MODELS) ok(mFree.includes(m), 'D2 Free 可见基础模型 ' + m);
    for (const m of HIGH_MODELS) ok(!mFree.includes(m), 'D3 Free **看不到**高级模型 ' + m);

    const mPro = await modelsOf(tPro);
    for (const m of ALL_PUBLISHED) ok(mPro.includes(m), 'D4 Pro 可见 ' + m);

    eq(mPro.length, mFree.length + HIGH_MODELS.length, 'D5 Pro 比 Free 多出的正好是高级模型');
  }

  /* ================= E. gatewayChat 门禁 ================= */
  {
    const e1 = await chat(tFree, HIGH_MODELS[0]);
    eq(e1.status, 403, 'E1 Free 显式调用高级模型 → 403');
    eq(e1.json.code, 'MODEL_REQUIRES_PRO', 'E2 带可编程识别的 code（插件据此引导升级）');
    has(e1.json.error, '需要专业版', 'E3 文案说明原因');
    has(e1.json.error, '升级后可用', 'E4 文案给出升级后能用的模型');
    for (const m of HIGH_MODELS) has(e1.json.error, m, 'E5 403 文案列出 ' + m);

    const e2 = await chat(tFree, 'auto');
    ok(e2.status !== 403, 'E6 auto 不被拦（上游不可达的 502 不算）', e2.status);

    const e3 = await chat(tFree, FREE_MODELS[0]);
    ok(e3.status !== 403, 'E7 基础模型不被拦', e3.status);

    const e4 = await chat(tFree, 'never-published');
    eq(e4.status, 400, 'E8 未上线模型仍走既有的 400（上线校验优先级在前）');

    const e5 = await chat(tPro, HIGH_MODELS[1]);
    ok(e5.status !== 403, 'E9 Pro 调高级模型不被拦', e5.status);
  }

  /* ================= F. /api/auth/me 的 ai 块 ================= */
  {
    const uf = (await me(tFree)).user;
    ok(!!uf.ai, 'F1 me 带 ai 块');
    eq(uf.ai.highTier, false, 'F2 Free 无试用 → highTier=false');
    eq(uf.ai.reason, 'none', 'F3 reason=none');
    eq(uf.ai.defaultModel, 'auto', 'F4 默认模型为 auto');
    eq(uf.ai.lockedModels.join(','), HIGH_MODELS.join(','), 'F5 lockedModels 列出需升级的模型');
    ok(!uf.ai.models.includes(HIGH_MODELS[0]), 'F6 ai.models 不含高级模型');

    const up = (await me(tPro)).user;
    eq(up.ai.highTier, true, 'F7 Pro → highTier=true');
    eq(up.ai.reason, 'plan', 'F8 reason=plan');
    eq(up.ai.lockedModels.length, 0, 'F9 Pro 没有被锁的模型');

    // 不泄露内部字段
    const raw = JSON.stringify(uf.ai);
    for (const bad of ['apiKey', 'api_key', 'token', 'baseUrl', 'base_url', 'secret', 'password']) {
      ok(raw.toLowerCase().indexOf(bad.toLowerCase()) < 0, 'F10 ai 块不含敏感字段 ' + bad);
    }
  }

  /* ================= G. 试用：开启 → 生效 → 老化到期 ================= */
  {
    await req('PUT', '/api/admin/membership', { ai: { trialDays: 7 } });

    const m1 = await modelsOf(tFree);
    for (const m of HIGH_MODELS) ok(m1.includes(m), 'G1 试用中 Free 可用高级模型 ' + m);
    const uf1 = (await me(tFree)).user;
    eq(uf1.ai.highTier, true, 'G2 试用中 highTier=true');
    eq(uf1.ai.reason, 'trial', 'G3 reason=trial（与「买来的 Pro」区分开）');
    eq(uf1.ai.trial.active, true, 'G4 trial.active=true');
    eq(uf1.ai.trial.days, 7, 'G5 trial.days=7');
    ok(uf1.ai.trial.daysLeft > 0 && uf1.ai.trial.daysLeft <= 7, 'G6 daysLeft 在 1..7', uf1.ai.trial);

    const g7 = await chat(tFree, HIGH_MODELS[0]);
    ok(g7.status !== 403, 'G7 试用期内调高级模型不被拦', g7.status);

    /* ---- 老化 createdAt：把注册时间推到 30 天前，重载存储 ---- */
    const upPath = path.join(WORK, 'users.json');
    const udoc = JSON.parse(fs.readFileSync(upPath, 'utf8'));
    const rec = udoc.users.find((u) => u.email === 'free@t.local');
    rec.createdAt = new Date(Date.now() - 30 * D).toISOString();
    fs.writeFileSync(upPath, JSON.stringify(udoc, null, 2), 'utf8');
    mod.reloadStores();

    const m2 = await modelsOf(tFree);
    for (const m of HIGH_MODELS) ok(!m2.includes(m), 'G8 30 天前注册 → 试用已结束，看不到 ' + m);
    const uf2 = (await me(tFree)).user;
    eq(uf2.ai.highTier, false, 'G9 试用结束后 highTier=false');
    eq(uf2.ai.reason, 'none', 'G10 reason 回落 none');
    eq(uf2.ai.trial.active, false, 'G11 trial.active=false');
    ok(!!uf2.ai.trial.endsAt, 'G12 仍给出 endsAt 供界面说明', uf2.ai.trial);

    const g13 = await chat(tFree, HIGH_MODELS[0]);
    eq(g13.status, 403, 'G13 试用结束后再调高级模型 → 403');

    // 「过期不踢下线」：额度与登录态不受影响
    eq(uf2.plan, 'Free', 'G14 仍在线（试用结束不踢下线）');
    ok(typeof uf2.dailyLimit === 'number' && uf2.dailyLimit > 0, 'G15 每日额度不受试用影响', uf2.dailyLimit);
    const g16 = await req('GET', '/api/sessions', null, tFree);
    eq(g16.status, 200, 'G16 会话仍然有效（只收模型，不动登录）');

    // Pro 不受影响
    const m3 = await modelsOf(tPro);
    for (const m of HIGH_MODELS) ok(m3.includes(m), 'G17 Pro 不受 Free 试用结束影响');

    // 恢复（顺带验证「恢复注册时间又能用」）
    const udoc2 = JSON.parse(fs.readFileSync(upPath, 'utf8'));
    const rec2 = udoc2.users.find((u) => u.email === 'free@t.local');
    rec2.createdAt = new Date().toISOString();
    fs.writeFileSync(upPath, JSON.stringify(udoc2, null, 2), 'utf8');
    mod.reloadStores();
    const m4 = await modelsOf(tFree);
    for (const m of HIGH_MODELS) ok(m4.includes(m), 'G18 注册时间恢复后高级模型又可用 ' + m);
  }

  /* ================= H. auto 防误配 + health + 审计 ================= */
  {
    // 把 auto 误配进高级清单 —— 它必须仍然免费（否则会把所有 Free 用户锁死）
    await req('PUT', '/api/admin/channels/high-tier', { models: ['auto'].concat(HIGH_MODELS) });
    // 此时 free 用户处于试用中（G18 已恢复），先关掉试用
    await req('PUT', '/api/admin/membership', { ai: { trialDays: 0 } });
    const mz = await modelsOf(tFree);
    ok(mz.includes('auto'), 'H1 auto 被误配进高级清单也不锁（防误配锁死全员）');
    const cz = await chat(tFree, 'auto');
    ok(cz.status !== 403, 'H2 误配后调 auto 仍不被拦', cz.status);
    for (const m of HIGH_MODELS) ok(!mz.includes(m), 'H3 高级模型仍然锁着 ' + m);
    eq((await me(tFree)).user.ai.lockedModels.indexOf('auto'), -1,
      'H4 lockedModels 里绝不出现 auto');

    // health
    const h = (await req('GET', '/api/health')).json;
    eq(h.version, '1.5.0', 'H5 服务端版本 1.5.0');
    eq(h.highTierModels, 3, 'H6 health 给出高级模型数量（auto 也配了 → 3 条配置）');
    eq(h.publishedModels, ALL_PUBLISHED.length, 'H7 上线清单数量不受影响');

    // 审计：两个新动作都要留痕
    const au = (await req('GET', '/api/admin/audit?limit=30')).json;
    const actions = au.items.map((x) => x.action);
    ok(actions.indexOf('channel.high-tier') >= 0, 'H8 高级清单改动写入审计');
    ok(actions.indexOf('membership.config') >= 0, 'H9 会员配置改动写入审计');
    const one = au.items.find((x) => x.action === 'channel.high-tier');
    ok(JSON.stringify(one.after || {}).indexOf('hunyuan-2.0-thinking') >= 0,
      'H10 审计记录了具体清单', one && one.after);

    // 复位到「无分级」并确认语义
    const r0 = await req('PUT', '/api/admin/channels/high-tier', { models: [] });
    eq(r0.json.note.indexOf('全部免费') >= 0, true, 'H11 空清单 = 取消分级（全部免费）');
    const m5 = await modelsOf(tFree);
    eq(m5.length, ALL_PUBLISHED.length + 1, 'H12 取消分级后 Free 也能用全部模型', m5);
  }

  /* ---- 收尾 ---- */
  try { mod.stopBackgroundJobs(); } catch (e) { /* ignore */ }
  server.close();
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) { /* ignore */ }

  console.log('\n套餐 AI 能力测试：' + pass + ' 项通过，' + fails.length + ' 项失败');
  if (fails.length) {
    for (const f of fails) console.log('  ✗ ' + f);
    process.exit(1);
  }
  console.log('  ✓ 全部通过');
})().catch((e) => {
  console.error('测试崩溃：', e);
  process.exit(1);
});
