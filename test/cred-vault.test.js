#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 账号与密钥中心（CredVault）单元测试（0.66.0）
 *
 * 这一层的失败几乎都是**静默**的：脱敏写成了截断、写 pref 时丢了 base64 编码
 * （知网登录拿到 base64 当密码）、AI 通道写回时把别的通道覆盖掉、门控在未登录时
 * 反向放行。所以这里逐条钉死：
 *   ① SHA-256 标准向量（口令哈希的地基）
 *   ② 脱敏不泄露值/长度；tail() 只在足够长时给
 *   ③ 口令往返 + 错误口令 + 盐随机 + 清除需旧口令
 *   ④ 写入格式与消费方一致（cnkiPassword = base64）
 *   ⑤ AI 通道动态项：读取/写回/免密通道
 *   ⑥ Pro 门控：未登录 / Free / Pro 三态
 *   ⑦ 审计只记动作、封顶 40 条
 *   ⑧ 账号托管：上传集合、取回只填空缺
 *   ⑨ 静态体检：vault.js 里每个 $("id") 在 vault.xhtml 都存在；main.js 已装载模块
 *
 * 运行：node test/cred-vault.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const CORE = path.join(ROOT, 'chrome', 'content', 'scripts', 'features', 'cred-vault.js');
const UI = path.join(ROOT, 'chrome', 'content', 'vault.js');
const XHTML = path.join(ROOT, 'chrome', 'content', 'vault.xhtml');
const MAIN = path.join(ROOT, 'chrome', 'content', 'scripts', 'main.js');

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

/* ---------------- 桩：Prefs / Zotero / Account / Channels ---------------- */

function makeSandbox(opts) {
  const o = opts || {};
  const store = Object.assign({}, o.prefs || {});
  const Prefs = {
    get(k, dflt) {
      const v = store[k];
      return v === undefined || v === null ? dflt : v;
    },
    set(k, v) { store[k] = v; },
  };
  const cryptoWeb = require('crypto').webcrypto;
  const Zotero = {
    locale: o.locale || 'zh-CN',
    getMainWindow: () => ({ crypto: cryptoWeb }),
    debug() {},
    logError() {},
  };
  const secrets = o.secrets || {};   // 不拷贝：模拟「换一次启动，托管还在」时能共享
  const Account = {
    _pro: !!o.pro,
    isLoggedIn: () => o.loggedIn !== false,
    isPro() { return this._pro; },
    membership() { return { plan: this._pro ? 'Pro' : 'Free', name: this._pro ? '专业版' : '免费版', expiresAt: 0 }; },
    async hostedSecrets() {
      const out = {};
      for (const k of Object.keys(secrets)) out[k] = { set: true, hint: 'xxxx…yyyy', updatedAt: '2026-10-01T00:00:00.000Z' };
      return out;
    },
    async saveHostedSecret(name, value) { secrets[name] = String(value); return {}; },
    async revealHostedSecret(name) { return secrets[name] || ''; },
    async deleteHostedSecret(name) { delete secrets[name]; return {}; },
  };
  const channelsDoc = JSON.parse(JSON.stringify(o.channels || { channels: [], active: null }));
  const Channels = {
    OFFICIAL_ID: 'official',
    _load: () => JSON.parse(JSON.stringify(channelsDoc)),
    _save: (doc) => {
      channelsDoc.channels = doc.channels;
      channelsDoc.active = doc.active;
      store.aiChannels = JSON.stringify(doc);
    },
    _providerNoKey: (provider, baseUrl) => provider === 'ollama' || /127\.0\.0\.1|localhost/.test(String(baseUrl || '')),
  };
  const sandbox = {
    console, btoa, atob, TextEncoder, TextDecoder,
    setTimeout, clearTimeout,
    Prefs, Zotero, Account, Channels,
    crypto: cryptoWeb,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(CORE, 'utf8'), sandbox, { filename: 'cred-vault.js' });
  return { V: sandbox.CredVault, store, secrets, channelsDoc, sandbox, Account };
}

/* ================= ① SHA-256 标准向量 ================= */

const env = makeSandbox();
const V = env.V;
eq(V.sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'S1 空串向量');
eq(V.sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'S2 "abc" 向量');
eq(V.sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
  '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1', 'S3 两段 56 字节向量');
eq(V.sha256('中文口令').length, 64, 'S4 中文输入产出 64 位 hex');
ok(/^[0-9a-f]{64}$/.test(V.sha256('a'.repeat(200))), 'S5 长输入（跨多块）格式正确');

/* ================= ② 脱敏 ================= */

eq(V.mask(''), '', 'M1 空值脱敏为空串');
eq(V.mask('sk-1234567890abcdef'), '••••••••', 'M2 脱敏为固定掩码，不泄露长度');
ok(!V.mask('supersecret').includes('super'), 'M3 掩码不含原值片段');
eq(V.tail('sk-1234567890abcdef'), 'cdef', 'M4 足够长时给出末 4 位');
eq(V.tail('short'), '', 'M5 太短不给末位（否则等于全泄露）');

/* ================= ③ 访问口令 ================= */

const envP = makeSandbox();
const VP = envP.V;
ok(!VP.hasPasscode(), 'P1 默认没有口令');
const r1 = VP.setPasscode('1234');
ok(r1.ok, 'P2 设置口令成功');
ok(VP.hasPasscode(), 'P3 设置后状态为已设口令');
ok(!envP.store.vaultPassHash.includes('1234'), 'P4 盘上不含口令明文');
ok(VP.verifyPasscode('1234').ok, 'P5 正确口令通过');
ok(!VP.verifyPasscode('12345').ok, 'P6 错误口令拒绝');
ok(VP.setPasscode('').ok === false, 'P7 空口令被拒绝');
ok(VP.setPasscode('abc').ok === false, 'P8 过短口令被拒绝');
const h1 = VP.hashPass('same', 'saltA');
const h2 = VP.hashPass('same', 'saltB');
ok(h1 !== h2, 'P9 不同盐 → 不同哈希');
ok(h1 === VP.hashPass('same', 'saltA'), 'P10 同盐同口令 → 稳定哈希');
ok(VP.verifyPasscode('').ok === false, 'P11 已设口令时空口令不通过');
ok(!VP.clearPasscode('wrong').ok, 'P12 清除口令必须给对旧口令');
ok(VP.hasPasscode(), 'P13 清除失败后口令仍在');
ok(VP.clearPasscode('1234').ok, 'P14 旧口令正确时可清除');
ok(!VP.hasPasscode(), 'P15 清除后状态为未设');

/* ================= ④ 字段读写与编码 ================= */

const envW = makeSandbox({ prefs: { cnkiUsername: 'u1' } });
const VW = envW.V;
const items = VW.items();
eq(items.length, 10, 'F1 默认 10 个静态字段（知网2/坚果云2/分区1/第三方源3/其他集成2）');
eq(items.filter((x) => x.group === 'cnki').length, 2, 'F2 知网 2 项');
eq(items.filter((x) => x.group === 'nutstore').length, 2, 'F3 坚果云 2 项');
eq(items.filter((x) => x.group === 'rank').length, 1, 'F4 分区 1 项');
eq(items.filter((x) => x.group === 'third').length, 3, 'F4b 第三方文献源 3 项');
eq(items.filter((x) => x.group === 'services').length, 2, 'F4c 其他集成 2 项');
eq(items.filter((x) => x.secret).length, 6, 'F4d 敏感项 6 个（知网密码/坚果云/分区/第三方源/S2/MCP）');

const cnkiPass = items.find((x) => x.id === 'cnki.pass');
ok(cnkiPass && cnkiPass.secret === true, 'F5 密码是敏感项');
eq(cnkiPass.configured, false, 'F6 未配置时 configured=false');

const w1 = VW.set('cnki.pass', 'pw-中文');
ok(w1.ok, 'F7 写入密码成功');
eq(envW.store.cnkiPassword, btoa(unescape(encodeURIComponent('pw-中文'))), 'F8 落盘为 base64（与 CNAuth 兼容）');
eq(VW.get('cnki.pass'), 'pw-中文', 'F9 读回解码正确');
eq(VW.items().find((x) => x.id === 'cnki.pass').configured, true, 'F10 写入后为已配置');

ok(VW.set('nutstore.token', 'app-pass').ok, 'F11 坚果云应用密码写入');
eq(envW.store.cloudSyncToken, 'app-pass', 'F12 坚果云令牌保持明文格式（消费方直接当 Basic 密码）');

ok(VW.set('rank.key', 'es-key').ok, 'F13 分区 Key 写入');
eq(envW.store.easyScholarKey, 'es-key', 'F14 分区 Key 落在 easyScholarKey');

ok(VW.set('cnki.user', 'x'.repeat(121)).ok === false, 'F15 超长字段被拒绝');
ok(VW.set('nope.nope', 'x').ok === false, 'F16 未知字段被拒绝');

const c1 = VW.set('cnki.pass', '');
ok(c1.ok && c1.cleared, 'F17 空值 = 清除');
eq(envW.store.cnkiPassword, '', 'F18 清除后 pref 为空串');

const st = VW.stats();
eq(st.total, 10, 'F19 stats.total 正确');
eq(st.configured, 3, 'F20 stats.configured 正确（user/token/rank），新增项默认未配置');

/* ================= ⑤ AI 通道动态项 ================= */

const envAI = makeSandbox({
  channels: {
    active: 'c1',
    channels: [
      { id: 'official', name: '官方', provider: 'official', apiKey: '' },
      { id: 'c1', name: '我的 DeepSeek', provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-aaaaaaaaaaaa' },
      { id: 'c2', name: '本地 Ollama', provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '' },
    ],
  },
});
const VA = envAI.V;
const aiItems = VA.items().filter((x) => x.group === 'ai');
eq(aiItems.length, 2, 'A1 只列出非官方通道');
ok(!aiItems.some((x) => x.id === 'ai.official'), 'A2 官方通道不出现');
const c1item = aiItems.find((x) => x.id === 'ai.c1');
eq(c1item.value, 'sk-aaaaaaaaaaaa', 'A3 读出通道 Key');
eq(c1item.configured, true, 'A4 有 Key 时为已配置');
const c2item = aiItems.find((x) => x.id === 'ai.c2');
eq(c2item.noKey, true, 'A5 本地免密通道标记 noKey');
eq(c2item.configured, true, 'A6 免密通道算作已配置（不显示"未配置"误导用户）');

ok(VA.set('ai.c1', 'sk-bbbbbbbbbbbb').ok, 'A7 写回通道 Key');
eq(envAI.channelsDoc.channels.find((c) => c.id === 'c1').apiKey, 'sk-bbbbbbbbbbbb', 'A8 落点仍是 aiChannels JSON');
eq(envAI.channelsDoc.channels.find((c) => c.id === 'c1').baseUrl, 'https://api.deepseek.com/v1', 'A9 写 Key 不破坏同通道其它字段');
eq(envAI.channelsDoc.channels.length, 3, 'A10 写 Key 不增删通道');

ok(VA.set('ai.c1', '').ok, 'A11 可清空通道 Key');
eq(envAI.channelsDoc.channels.find((c) => c.id === 'c1').apiKey, '', 'A12 清空后 apiKey 为空串');
ok(VA.set('ai.gone', 'x').ok === false, 'A13 不存在的通道被拒绝');

/* ================= ⑥ 门控 ================= */

const envFree = makeSandbox({ pro: false, loggedIn: true });
const accFree = envFree.V.access();
eq(accFree.pro, false, 'G1 Free 用户不通过');
eq(accFree.reason, 'need_pro', 'G2 原因 need_pro');

const envOut = makeSandbox({ pro: true, loggedIn: false });
const accOut = envOut.V.access();
eq(accOut.pro, false, 'G3 未登录不通过（即使缓存的 plan 是 Pro）');
eq(accOut.reason, 'not_logged_in', 'G4 原因 not_logged_in');

const envPro = makeSandbox({ pro: true, loggedIn: true });
const accPro = envPro.V.access();
eq(accPro.pro, true, 'G5 Pro 通过');
eq(accPro.plan, 'Pro', 'G6 plan 透出');
eq(accPro.reason, 'ok', 'G7 原因 ok');

/* ================= ⑦ 审计 ================= */

const envJ = makeSandbox();
const VJ = envJ.V;
VJ.journal('edit', 'cnki.pass', '密码');
for (let i = 0; i < 60; i++) VJ.journal('reveal', 'rank.key', '查看 ' + i);
const jl = VJ.recentJournal();
eq(jl.length, VJ.JOURNAL_MAX, 'J1 审计封顶 JOURNAL_MAX');
eq(jl[0].id, 'rank.key', 'J2 最新一条在最前');
const rawJ = String(envJ.store.vaultAudit || '');
ok(!rawJ.includes('pw-'), 'J3 审计里不含值');
ok(VJ.recentJournal().every((x) => typeof x.t === 'number' && typeof x.a === 'string'), 'J4 每条都有时间与动作');
VJ.clearJournal();
eq(VJ.recentJournal().length, 1, 'J5 清空后保留一条留痕');
eq(VJ.recentJournal()[0].a, 'audit-clear', 'J6 留痕动作是 audit-clear（谁擦了痕迹也要能查到）');

/* ================= ⑧ 账号托管 ================= */

(async () => {
  const envH = makeSandbox({ pro: true, loggedIn: true });
  const VH = envH.V;
  ok(VH.hostedReady(), 'H1 已登录时托管可用');

  // 单字段上传
  VH.set('rank.key', 'es-secret-key-123');
  const up = await VH.uploadHosted('rank.key');
  ok(up.ok, 'H2 上传分区 Key 成功');
  eq(envH.secrets.easyscholar, 'es-secret-key-123', 'H3 托管名为 easyscholar（与服务端白名单一致）');

  // 空值不允许上传
  const upEmpty = await VH.uploadHosted('nutstore.token');
  ok(!upEmpty.ok, 'H4 空值不产生空托管');

  // 取回：覆盖本机
  envH.store.easyScholarKey = '';
  const down = await VH.downloadHosted('rank.key');
  ok(down.ok, 'H5 取回成功');
  eq(envH.store.easyScholarKey, 'es-secret-key-123', 'H6 取回后本机值恢复');

  // AI 集合上传：只含非空 Key
  const envHA = makeSandbox({
    pro: true, loggedIn: true,
    channels: {
      active: 'c1',
      channels: [
        { id: 'official', name: '官方', provider: 'official', apiKey: '' },
        { id: 'c1', name: 'A', provider: 'deepseek', baseUrl: 'https://a/v1', apiKey: 'sk-aaaa1111' },
        { id: 'c2', name: 'B', provider: 'deepseek', baseUrl: 'https://b/v1', apiKey: 'sk-bbbb2222' },
      ],
    },
  });
  const VHA = envHA.V;
  const upAI = await VHA.uploadHosted('ai.c1');
  ok(upAI.ok, 'H7 AI 集合上传成功');
  const payload = JSON.parse(envHA.secrets.ai_channels_keys || '{}');
  eq(payload.c1, 'sk-aaaa1111', 'H8 集合里有 c1 的 Key');
  eq(payload.c2, 'sk-bbbb2222', 'H9 集合里有 c2 的 Key');
  eq(payload.official, undefined, 'H10 官方通道不入集合');

  // AI 取回：只填空缺，不覆盖已有
  envHA.channelsDoc.channels.find((c) => c.id === 'c1').apiKey = 'sk-local-9999';
  envHA.channelsDoc.channels.find((c) => c.id === 'c2').apiKey = '';
  const downAI = await VHA.downloadHosted('ai.c1');
  ok(downAI.ok && downAI.filled === 1, 'H11 AI 取回填充 1 个空通道', downAI);
  eq(envHA.channelsDoc.channels.find((c) => c.id === 'c1').apiKey, 'sk-local-9999', 'H12 已有 Key 不被覆盖');
  eq(envHA.channelsDoc.channels.find((c) => c.id === 'c2').apiKey, 'sk-bbbb2222', 'H13 空通道被填充（集合按通道 id 匹配）');

  // 全部有 Key 时取回 = 明确失败（不静默）
  const again = await VHA.downloadHosted('ai.c1');
  ok(!again.ok, 'H14 没有可填通道时明确报错');

  // 删除托管
  const del = await VH.removeHosted('rank.key');
  ok(del.ok, 'H15 删除托管成功');
  eq(envH.secrets.easyscholar, undefined, 'H16 托管副本已删除');
  eq(envH.store.easyScholarKey, 'es-secret-key-123', 'H17 删除托管不动本机值');

  // 未登录时托管不可用
  const envNo = makeSandbox({ pro: true, loggedIn: false });
  ok(!envNo.V.hostedReady(), 'H18 未登录时托管不可用');
  const r = await envNo.V.uploadHosted('rank.key');
  ok(!r.ok, 'H19 未登录上传被拒绝');

  /* ================= ⑧b 知网「账号+密码」合并托管（0.67.0） ================= */

  const envC = makeSandbox({ pro: true, loggedIn: true,
    prefs: { cnkiUsername: 'alice', cnkiPassword: btoa('pw-cnki') } });
  const VC = envC.V;
  const upC = await VC.uploadHosted('cnki.pass');
  ok(upC.ok && upC.bundled, 'C1 知网上传是合并托管（含用户名）');
  const cobj = JSON.parse(envC.secrets.cnki_account || '{}');
  eq(cobj.u, 'alice', 'C2 托管里有用户名');
  eq(cobj.p, 'pw-cnki', 'C3 托管里有密码');
  eq(envC.secrets.cnki_password, 'pw-cnki', 'C4 兼容副本 cnki_password 仍写（旧客户端能读）');

  // 换机：新环境只有托管，两个字段一起回来
  const envC2 = makeSandbox({ pro: true, loggedIn: true, secrets: envC.secrets });
  const downC = await envC2.V.downloadHosted('cnki.pass');
  ok(downC.ok && downC.bundled, 'C5 取回是合并恢复');
  eq(envC2.store.cnkiUsername, 'alice', 'C6 用户名被一起恢复');
  eq(envC2.V.get('cnki.pass'), 'pw-cnki', 'C7 密码被一起恢复');

  // 旧格式（只有密码副本）→ 回退并明确告知
  const envC3 = makeSandbox({ pro: true, loggedIn: true, secrets: { cnki_password: 'only-pass' } });
  const downC3 = await envC3.V.downloadHosted('cnki.pass');
  ok(downC3.ok && downC3.partial, 'C8 只有旧格式时回退成功');
  eq(envC3.V.get('cnki.pass'), 'only-pass', 'C9 旧格式密码恢复');
  ok(/用户名仍需手填/.test(downC3.warning || ''), 'C10 明确告知用户名要手填（不静默半恢复）');

  // 缺用户名 → 拒绝上传（否则换机又只回一半）
  const envC4 = makeSandbox({ pro: true, loggedIn: true, prefs: { cnkiPassword: btoa('x1') } });
  const upC4 = await envC4.V.uploadHosted('cnki.pass');
  ok(!upC4.ok && /用户名/.test(upC4.error || ''), 'C11 缺用户名时拒绝托管');

  /* ================= ⑧c 仅托管模式（本机不留值） ================= */

  const envO = makeSandbox({ pro: true, loggedIn: true, prefs: { cloudSyncToken: 'nt-token-1234' } });
  const VO = envO.V;
  const onR = await VO.setHostedOnly('nutstore.token', true);
  ok(onR.ok, 'O1 开启仅托管成功');
  eq(envO.store.cloudSyncToken, '', 'O2 本机 pref 被清空（磁盘上不再有明文）');
  eq(VO.cached('nutstore.token'), 'nt-token-1234', 'O3 内存里仍然可用');
  ok(VO.hasHostedOnly(), 'O4 标记已记录');
  eq(VO.hydrateState('nutstore.token'), 'ready', 'O5 状态为已水合');
  eq(VO.cached('nutstore.email'), '', 'O6 其它字段不受影响');

  // 模拟换一次启动：内存空了，从托管水合
  const envO2 = makeSandbox({ pro: true, loggedIn: true, prefs: envO.store, secrets: envO.secrets });
  const VO2 = envO2.V;
  eq(VO2.cached('nutstore.token'), '', 'O7 重启后内存为空（磁盘确实没有值）');
  const nHyd = await VO2.hydrateHostedOnly(true);
  ok(nHyd >= 1, 'O8 启动水合取回', nHyd);
  eq(VO2.cached('nutstore.token'), 'nt-token-1234', 'O9 水合后消费方可读');

  // 关闭：值回写本机
  const offR = await VO2.setHostedOnly('nutstore.token', false);
  ok(offR.ok, 'O10 关闭仅托管成功');
  eq(envO2.store.cloudSyncToken, 'nt-token-1234', 'O11 值回写本机 pref');
  ok(!VO2.hasHostedOnly(), 'O12 标记已清除');

  // 未登录不能开
  const envO3 = makeSandbox({ pro: true, loggedIn: false, prefs: { cloudSyncToken: 'x' } });
  const badO = await envO3.V.setHostedOnly('nutstore.token', true);
  ok(!badO.ok, 'O13 未登录时拒绝开启');

  // AI 通道不支持仅托管（清掉等于删通道）
  const envO4 = makeSandbox({ pro: true, loggedIn: true,
    channels: { active: 'c1', channels: [
      { id: 'official', name: '官方', provider: 'official', apiKey: '' },
      { id: 'c1', name: 'A', provider: 'deepseek', baseUrl: 'https://a/v1', apiKey: 'sk-x' },
    ] } });
  const badO2 = await envO4.V.setHostedOnly('ai.c1', true);
  ok(!badO2.ok, 'O14 AI 通道拒绝仅托管');

  /* ================= ⑨ 静态体检 ================= */

  const uiSrc = fs.readFileSync(UI, 'utf8');
  const xhtml = fs.readFileSync(XHTML, 'utf8');
  // 口令区的三个输入框是渲染时动态创建的（静态 xhtml 里没有），白名单必须同时
  // 证明它们**真的**在脚本里被赋了 id —— 否则白名单会掩盖"输入框丢了"的静默故障
  const DYNAMIC_IDS = ['v-pass-old', 'v-pass-new', 'v-pass-new2'];
  for (const id of DYNAMIC_IDS) {
    ok(uiSrc.includes('id = "' + id + '"'), 'W0 动态输入框 ' + id + ' 在脚本里赋值', id);
  }
  const ids = new Set();
  const re = /\$\("([a-zA-Z0-9_-]+)"\)/g;
  let m;
  while ((m = re.exec(uiSrc))) ids.add(m[1]);
  const missing = [...ids].filter((id) => !DYNAMIC_IDS.includes(id) && xhtml.indexOf('id="' + id + '"') < 0);
  eq(missing.length, 0, 'W1 vault.js 引用的每个 id 都在 vault.xhtml 存在', missing);

  ok(xhtml.indexOf('windowtype="papilot:vault"') > 0, 'W2 窗口类型用于单例枚举');
  ok(xhtml.indexOf('xmlns:html') > 0, 'W3 声明了 XHTML 命名空间');
  ok(!/&nbsp;|&mdash;|&copy;/.test(xhtml), 'W4 没有未定义的命名实体（Zotero 解析会整页失败）');
  ok(!xhtml.trimStart().startsWith('<?xml'), 'W5 没有 XML 声明（chrome 窗口会白屏）');

  const mainSrc = fs.readFileSync(MAIN, 'utf8');
  ok(mainSrc.includes('"features/cred-vault.js"'), 'W6 main.js 已装载 cred-vault.js');
  ok(mainSrc.includes('this.credVault = '), 'W7 main.js 暴露 credVault');
  ok(mainSrc.includes('chrome://papilot/content/vault.xhtml'), 'W8 openVault 指向正确窗口');

  if (fails.length) {
    console.error(`\n✗ 账号与密钥中心测试失败 ${fails.length} 项 / 通过 ${pass} 项`);
    for (const f of fails) console.error('  - ' + f);
    process.exit(1);
  }
  console.log(`✓ 账号与密钥中心测试全部通过（${pass} 项）`);
  process.exit(0);
})();
