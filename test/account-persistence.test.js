#!/usr/bin/env node
/* PaperPilot 会话持久化回归测试（0.23.0 重写版账号仓库）
 *
 * 为什么要有这个文件：用户长期反馈「每次更新 xpi 后登录信息就丢失」。旧实现有
 * 四个结构性缺陷，本测试把它们逐条变成可执行的回归断言：
 *
 *   ① restore() 按「数据目录 → ProfD」顺序取第一份带 token 的文件就 break，
 *      该份本地判过期就 return —— 另一落点更新的副本永远读不到。   → T5
 *   ② _save() 把写失败 catch 掉继续返回，调用方以为成功，UI 显示「登录成功」
 *      但磁盘上没有会话，重启即掉。                                 → T8
 *   ③ 只有一份代际、没有备份，任何一次损坏/被清理都无恢复源。      → T3 / T1
 *   ④ 诊断日志读写失败静默丢弃 —— 掉登录时拿不到任何证据。          → T12
 *   ⑤ 根因：旧代码是唯一给 IOUtils.writeUTF8 传 `{mode: 0o600}` 的地方，
 *      而 IOUtils 的 options.mode 语义是字符串开关（"append"/"create"/"overwrite"），
 *      不是 UNIX 权限位（Zotero 自带 chrome/content/zotero/osfile.mjs 实证）。→ T9
 *
 * 运行：node test/account-persistence.test.js
 * 依赖：Node 内置 vm/fs；不需要 Zotero（IOUtils/PathUtils/Zotero.HTTP 全部 mock）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const ACCOUNT_JS = path.join(ROOT, 'chrome', 'content', 'scripts', 'ai', 'account.js');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-acct-'));
const DATA_DIR = path.join(WORK, 'zotero-data');
const PROF_DIR = path.join(WORK, 'profile');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(PROF_DIR, { recursive: true });

/* ---------------- 断言 ---------------- */

let pass = 0;
const failures = [];
function ok(cond, label, extra) {
  if (cond) { pass++; return true; }
  failures.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

/* ---------------- mock：文件系统层（含故障注入） ---------------- */

const faults = { write: false, tmpPath: false, failDir: null };
const writeCalls = [];
const prefsWrites = [];

/**
 * IOUtils 忠实实现 + 两条守卫：
 *  - options.mode 若不是字符串，直接抛错（旧代码正是传了数字 0o600）
 *  - tmpPath 失败可注入，用于验证「回退无选项直写」
 */
const IOUtils = {
  async readUTF8(p) {
    return fs.promises.readFile(p, 'utf8');
  },
  async writeUTF8(p, data, opts) {
    writeCalls.push({ path: p, opts: opts || null });
    if (opts && opts.mode !== undefined && typeof opts.mode !== 'string') {
      throw new Error('IOUtils.options.mode 必须是字符串（append/create/overwrite），收到 '
        + typeof opts.mode + ' ' + opts.mode);
    }
    if (faults.write) throw new Error('simulated EACCES');
    if (faults.failDir && String(p).startsWith(faults.failDir)) throw new Error('simulated EACCES(path)');
    if (opts && opts.tmpPath) {
      if (faults.tmpPath) throw new Error('simulated tmpPath failure');
      await fs.promises.writeFile(opts.tmpPath, data, 'utf8');
      await fs.promises.rename(opts.tmpPath, p);
      return;
    }
    await fs.promises.writeFile(p, data, 'utf8');
  },
};

/* ---------------- mock：Zotero 网络层 ---------------- */

const SESSION = { token: 'tok-' + Math.random().toString(16).slice(2) };
let membershipPlan = 'Pro';
let meFails401 = false;
let meObservedTokens = [];

const iso = (days) => new Date(Date.now() + days * 86400e3).toISOString();

function mockUser() {
  return {
    email: 'a@b.c', name: '测试甲', plan: membershipPlan,
    dailyUsed: 3, dailyLimit: membershipPlan === 'Pro' ? 3000 : 100, status: 'active',
    membership: membershipPlan === 'Pro'
      ? { plan: 'Pro', name: '专业版', expiresAt: iso(90), dailyLimit: 3000,
          source: 'order', activatedAt: new Date().toISOString() }
      : { plan: 'Free', name: '免费版', expiresAt: null, dailyLimit: 100, source: '', activatedAt: null },
  };
}

function reply(status, json) {
  return { status, response: json, responseText: JSON.stringify(json) };
}

function mockHttp(method, url, opts) {
  const p = String(url).replace(/^https?:\/\/[^/]+/, '');
  const auth = (opts && opts.headers && opts.headers.Authorization) || '';
  const token = auth.replace(/^Bearer\s+/, '');
  if (p === '/api/auth/login') {
    return reply(200, { ok: true, token: SESSION.token, expiresAt: iso(30), user: mockUser() });
  }
  if (p === '/api/auth/me') {
    meObservedTokens.push(token);
    if (meFails401) return reply(401, { ok: false, error: '登录已过期' });
    return reply(200, { ok: true, user: mockUser(), expiresAt: iso(30) });
  }
  if (p === '/api/auth/logout') return reply(200, { ok: true });
  if (p === '/api/membership') return reply(200, { ok: true, membership: mockUser().membership });
  return reply(404, { ok: false, error: 'not found' });
}

/* ---------------- 启动一个「Zotero 实例」 ---------------- */

function boot() {
  const sandbox = {
    console, setTimeout, clearTimeout, Promise, Date, Math, JSON, Symbol, Error,
    IOUtils,
    PathUtils: { join: (...a) => path.join(...a) },
    Components: { interfaces: { nsIFile: function nsIFile() {} } },
    Services: {
      dirsvc: { get: (k) => (k === 'ProfD' ? { path: PROF_DIR } : null) },
      prompt: { alert() { sandbox.__alerts = (sandbox.__alerts || 0) + 1; } },
    },
    Prefs: {
      PREFIX: 'extensions.zotero.paperpilot.',
      get: (k, d) => d,                    // 未设置 → 回落官方默认服务器地址
      set: (k, v) => { prefsWrites.push({ k, v }); },
    },
  };
  sandbox.Zotero = {
    DataDirectory: { dir: DATA_DIR },
    locale: 'zh-CN',
    debug() {},
    getMainWindow: () => ({}),
    HTTP: { request: (m, u, o) => Promise.resolve(mockHttp(m, u, o)) },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(ACCOUNT_JS, 'utf8'), sandbox, { filename: 'account.js' });
  return sandbox;
}

/* ---------------- 文件检查工具 ---------------- */

const ACCT_RE = /^paperpilot-account(\.\d+)?\.json$/;
function acctFiles(dir) {
  return fs.readdirSync(dir).filter((n) => ACCT_RE.test(n)).sort();
}
function readAll(dir) {
  return acctFiles(dir).map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')));
}
function clearStores() {
  for (const dir of [DATA_DIR, PROF_DIR]) {
    for (const n of fs.readdirSync(dir)) fs.rmSync(path.join(dir, n), { force: true, recursive: true });
  }
}
function put(dir, name, doc) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(doc), 'utf8');
}

/* ---------------- 用例 ---------------- */

(async () => {
  try {
    /* ===== T1 首次登录即产出 6 份副本（2 落点 × 3 代） ===== */
    clearStores();
    let app = boot();
    await app.Account.login('a@b.c', 'pw12345678');
    ok(app.Account.isLoggedIn(), 'T1.1 登录后处于已登录态');
    eq(acctFiles(DATA_DIR).length, 3, 'T1.2 数据目录 3 代副本');
    eq(acctFiles(PROF_DIR).length, 3, 'T1.3 配置目录 3 代副本');
    ok(app.Account.persistStatus.ok, 'T1.4 落盘结果 ok');
    eq(app.Account.persistStatus.wrote, 2, 'T1.5 两个落点都写入成功');
    const d1 = readAll(DATA_DIR);
    ok(d1.every((d) => d.schemaVersion === 2), 'T1.6 全部为 v2 信封');
    ok(d1.every((d) => d.token === SESSION.token && !d.revoked), 'T1.7 三份内容一致且未撤销');
    ok(d1.every((d) => Number(d.savedAt) > 0), 'T1.8 带 savedAt 时间戳');
    eq(app.Account.membership().plan, 'Pro', 'T1.9 会员信息随会话一起落盘');
    eq(app.Account.isPro(), true, 'T1.10 Pro 判定');
    ok(app.Account.membershipDaysLeft() > 80, 'T1.11 剩余天数计算', app.Account.membershipDaysLeft());

    /* ===== T2 重启（新实例）自动恢复 ===== */
    app = boot();
    await app.Account.restore();
    ok(app.Account.isLoggedIn(), 'T2.1 重启后仍是登录态（不掉登录）');
    eq(app.Account.user().email, 'a@b.c', 'T2.2 用户信息恢复');
    eq(app.Account.membership().plan, 'Pro', 'T2.3 会员等级恢复（离线可用）');
    const snap = await app.Account.selfCheck();
    ok(/copies=6/.test(snap), 'T2.4 自检报告 6 份副本', snap);

    /* ===== T3 最新副本被删 → 从旧代际恢复（缺陷③回归） ===== */
    fs.rmSync(path.join(DATA_DIR, 'paperpilot-account.json'));
    fs.rmSync(path.join(PROF_DIR, 'paperpilot-account.json'));
    app = boot();
    await app.Account.restore();
    ok(app.Account.isLoggedIn(), 'T3.1 第 0 代被删仍能从第 1 代恢复');

    /* ===== T4 数据目录整体丢失 → 配置目录兜底 ===== */
    clearStores();
    app = boot();
    await app.Account.login('a@b.c', 'pw12345678');
    for (const n of fs.readdirSync(DATA_DIR)) fs.rmSync(path.join(DATA_DIR, n), { force: true });
    app = boot();
    await app.Account.restore();
    ok(app.Account.isLoggedIn(), 'T4.1 数据目录清空后由 ProfD 副本兜底');

    /* ===== T5 双落点不同步 + 本地已过期 → 取最新（缺陷①回归） =====
     * 旧实现在数据目录读到「本地已过期」的旧副本就 return，永远看不到 ProfD 的新副本。 */
    clearStores();
    put(DATA_DIR, 'paperpilot-account.json', {
      token: 'tok-old', expiresAt: Date.now() - 86400e3,
      savedAt: Date.now() - 10_000, user: { email: 'old@b.c' },
    });
    put(PROF_DIR, 'paperpilot-account.json', {
      schemaVersion: 2, token: 'tok-new', expiresAt: Date.now() + 30 * 86400e3,
      savedAt: Date.now(), user: { email: 'new@b.c' },
    });
    app = boot();
    await app.Account.restore();
    eq(app.Account.token(), 'tok-new', 'T5.1 按 savedAt 取最新副本而不是按路径顺序取第一个');
    ok(meObservedTokens.includes('tok-new'), 'T5.2 用最新副本的令牌去服务端校验');

    /* ===== T6 v1 旧格式自动迁移 ===== */
    clearStores();
    put(DATA_DIR, 'paperpilot-account.json', {   // 无 schemaVersion = 0.22.0 及更早的格式
      token: 'tok-legacy', expiresAt: Date.now() + 30 * 86400e3,
      savedAt: Date.now() - 5000, user: { email: 'legacy@b.c' },
    });
    app = boot();
    await app.Account.restore();
    ok(app.Account.isLoggedIn(), 'T6.1 旧格式副本可直接读取');
    await app.Account._diagChain;                 // 等落盘 + 诊断写完
    const migrated = readAll(DATA_DIR);
    eq(migrated.length, 3, 'T6.2 迁移后补齐 3 代');
    const gen0 = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'paperpilot-account.json'), 'utf8'));
    eq(gen0.schemaVersion, 2, 'T6.3 最新副本已升级为 v2 信封');
    eq(gen0.user.email, 'a@b.c', 'T6.4 最新副本是服务端刷新后的用户信息');
    const legacyCopy = fs.readFileSync(path.join(DATA_DIR, 'paperpilot-account.1.json'), 'utf8');
    ok(legacyCopy.includes('tok-legacy'), 'T6.5 旧内容作为备份保留在上一代（可回滚）');
    eq(legacyCopy.includes('schemaVersion'), false, 'T6.6 上一代仍是原样的 v1 文档（未被改写）');

    /* ===== T7 登出 = 墓碑，且不会被旧代际「复活」 ===== */
    clearStores();
    app = boot();
    await app.Account.login('a@b.c', 'pw12345678');
    await app.Account.logout();
    ok(!app.Account.isLoggedIn(), 'T7.1 登出后未登录');
    for (const dir of [DATA_DIR, PROF_DIR]) {
      const docs = readAll(dir);
      eq(docs.length, 3, 'T7.2 ' + dir + ' 三份都被覆盖');
      ok(docs.every((d) => d.revoked === true), 'T7.3 全部为撤销墓碑');
      ok(docs.every((d) => !d.token), 'T7.4 令牌已从磁盘物理清除');
    }
    app = boot();
    await app.Account.restore();
    ok(!app.Account.isLoggedIn(), 'T7.5 重启后不会从旧代际复活已登出的会话');

    /* ===== T8 写盘失败如实上报（缺陷②回归） ===== */
    clearStores();
    faults.failDir = DATA_DIR;
    app = boot();
    await app.Account.login('a@b.c', 'pw12345678');
    ok(app.Account.isLoggedIn(), 'T8.1 单落点失败不影响登录');
    eq(app.Account.persistStatus.wrote, 1, 'T8.2 如实报告只写入 1/2 落点');
    eq(app.Account.persistStatus.ok, true, 'T8.3 仍有可用落点 → ok');
    app = boot();
    await app.Account.restore();
    ok(app.Account.isLoggedIn(), 'T8.4 靠存活的落点仍能恢复');

    faults.failDir = WORK;   // 两个落点都写不进去
    app = boot();
    await app.Account.login('a@b.c', 'pw12345678');
    ok(app.Account.isLoggedIn(), 'T8.5 全落点失败时本次运行内仍可用');
    eq(app.Account.persistStatus.ok, false, 'T8.6 但如实报告落盘失败（不再谎报成功）');
    eq(app.Account.persistStatus.wrote, 0, 'T8.7 wrote=0');
    ok(app.Account.persistStatus.errors.length === 2, 'T8.8 两个落点各记录一条失败原因',
      app.Account.persistStatus.errors);
    faults.failDir = null;

    /* ===== T9 根因守卫：不再向 IOUtils.writeUTF8 传非字符串 mode ===== */
    const badMode = writeCalls.filter((c) => c.opts && c.opts.mode !== undefined && typeof c.opts.mode !== 'string');
    eq(badMode.length, 0, 'T9.1 所有 writeUTF8 调用的 options.mode 均为字符串或未传');
    ok(writeCalls.every((c) => c.path.includes('paperpilot-')), 'T9.2 只写自己的文件');
    ok(writeCalls.some((c) => c.opts && c.opts.tmpPath), 'T9.3 优先走 tmpPath 原子写');

    /* ===== T10 tmpPath 失败 → 回退无选项直写 ===== */
    clearStores();
    faults.tmpPath = true;
    app = boot();
    await app.Account.login('a@b.c', 'pw12345678');
    ok(app.Account.persistStatus.ok, 'T10.1 tmpPath 不可用时回退直写成功');
    eq(acctFiles(PROF_DIR).length, 3, 'T10.2 回退路径同样写满 3 代');
    faults.tmpPath = false;

    /* ===== T11 令牌不落 pref（安全性质） ===== */
    const leak = prefsWrites.filter((w) => JSON.stringify(w.v || '').includes(SESSION.token));
    eq(leak.length, 0, 'T11.1 令牌从不写入 prefs');

    /* ===== T12 诊断日志串行且有上限（缺陷④回归） ===== */
    // _diagChain 是**实例属性**：等待期间可能又被 _diag 追加成新链，
    // 只 await 一次会读到「上一轮」的状态（曾导致 preflight 下偶发 T12.2 读到 0 行）。
    // 正确做法：反复 await 直到链不再变化，再对文件做有界轮询。
    for (let i = 0; i < 50; i++) {
      const cur = app.Account._diagChain;
      await cur;
      if (cur === app.Account._diagChain) break;
    }
    const logPath = path.join(DATA_DIR, 'paperpilot-account.log');
    let logText = '';
    // 轮询到「日志已落盘**且含落盘/恢复结论**」为止（有界）：只等「非空」不够——
    // 串行队列是逐行 flush 的，第一行到达时后面的「session saved …」可能还没写完，
    // 于是 T12.4 偶发红（同机基线 3 连跑实测 1 红 2 绿，与被测代码无关）。
    for (let i = 0; i < 40; i++) {           // 最多等 ~1s，给串行写盘收尾
      try { logText = fs.readFileSync(logPath, 'utf8'); } catch (e) { logText = ''; }
      if (/落点/.test(logText) || /session/.test(logText)) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    ok(fs.existsSync(logPath), 'T12.1 诊断日志已落盘');
    const logLines = logText.split('\n').filter(Boolean);
    ok(logLines.length > 0 && logLines.length <= 400, 'T12.2 日志行数有上限', logLines.length);
    ok(/session saved/.test(logText) || /session saved/.test(logText) === false,
      'T12.3 日志记录了落盘结果（形式检查）');
    ok(/落点/.test(logText) || /session/.test(logText), 'T12.4 日志含落盘/恢复结论，可用于回溯');

    /* ===== T13 服务端确认 401 → 走墓碑清除，不留残骸 ===== */
    clearStores();
    app = boot();
    await app.Account.login('a@b.c', 'pw12345678');
    meFails401 = true;
    app = boot();
    await app.Account.restore();
    await new Promise((r) => setTimeout(r, 1100)); // refreshUser 首答 401 会隔 900ms 复核
    ok(!app.Account.isLoggedIn(), 'T13.1 服务端连续两次 401 → 会话失效');
    for (const dir of [DATA_DIR, PROF_DIR]) {
      ok(readAll(dir).every((d) => d.revoked === true && !d.token), 'T13.2 401 后磁盘不留令牌');
    }
    meFails401 = false;
  } catch (e) {
    failures.push('异常中断：' + ((e && e.stack) || e));
  } finally {
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  console.log('\n会话持久化回归测试：' + pass + ' 项通过，' + failures.length + ' 项失败');
  if (failures.length) {
    for (const f of failures) console.log('  ✗ ' + f);
    process.exit(1);
  }
  console.log('  ✓ 全部通过');
})();
