#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 根因取证探针：用同一个 mock 跑「0.14.0 初版 account.js」，证明
 * 「登录成功 → 磁盘上什么都没有 → 更新 xpi 后掉登录」这条链。
 *
 * 与 account-persistence.test.js 共用同一套 mock（IOUtils 忠实实现 + 故障注入），
 * 但加载的是 git 里的历史版本，因此可以作为「修复前后对照」的活证据。
 *
 * 运行：node test/legacy-rootcause.probe.js [git-ref]     (默认 a8daa3e = 0.14.0)
 * 期望输出：❌ 三个断言全部复现（登录成功 / 无文件 / 无任何可见失败）
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const REF = process.argv[2] || 'a8daa3e';
const REL = 'chrome/content/scripts/ai/account.js';

let legacySrc;
try {
  legacySrc = execFileSync('git', ['show', REF + ':' + REL], { cwd: ROOT, encoding: 'utf8' });
} catch (e) {
  console.log('取不到历史版本 ' + REF + '，跳过探针');
  process.exit(0);
}

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-rootcause-'));
const DATA_DIR = path.join(WORK, 'zotero-data');
const PROF_DIR = path.join(WORK, 'profile');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(PROF_DIR, { recursive: true });

let pass = 0;
const failures = [];
function ok(cond, label, extra) {
  if (cond) { pass++; return true; }
  failures.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}

let rejectedMode = 0;
const IOUtils = {
  async readUTF8(p) { return fs.promises.readFile(p, 'utf8'); },
  async writeUTF8(p, data, opts) {
    // IOUtils.options.mode 是字符串开关（"append"/"create"/"overwrite"），不是权限位。
    // 传数字 = 用法非法 → 该次写入不会产出文件。
    if (opts && opts.mode !== undefined && typeof opts.mode !== 'string') {
      rejectedMode++;
      throw new Error('Invalid mode: expected string, got ' + typeof opts.mode);
    }
    if (opts && opts.tmpPath) {
      await fs.promises.writeFile(opts.tmpPath, data, 'utf8');
      await fs.promises.rename(opts.tmpPath, p);
      return;
    }
    await fs.promises.writeFile(p, data, 'utf8');
  },
};

const TOKEN = 'tok-legacy';
const iso = (d) => new Date(Date.now() + d * 86400e3).toISOString();
const reply = (s, j) => ({ status: s, response: j, responseText: JSON.stringify(j) });
const user = { email: 'a@b.c', name: '甲', plan: 'Free', dailyUsed: 0, dailyLimit: 100, status: 'active' };

const sandbox = {
  console, setTimeout, clearTimeout, Promise, Date, Math, JSON, Symbol, Error,
  IOUtils,
  PathUtils: { join: (...a) => path.join(...a) },
  Components: { interfaces: { nsIFile: function nsIFile() {} } },
  Services: {
    dirsvc: { get: (k) => (k === 'ProfD' ? { path: PROF_DIR } : null) },
    prompt: { alert() {} },
  },
  Prefs: { PREFIX: 'extensions.zotero.papilot.', get: (k, d) => d, set() {} },
};
sandbox.Zotero = {
  DataDirectory: { dir: DATA_DIR },
  locale: 'zh-CN',
  debug() {},                                  // 旧版失败只写这里，用户永远看不到
  getMainWindow: () => ({}),
  HTTP: {
    request: (m, u) => {
      const p = String(u).replace(/^https?:\/\/[^/]+/, '');
      if (p === '/api/auth/login') {
        return Promise.resolve(reply(200, { ok: true, token: TOKEN, expiresAt: iso(30), user }));
      }
      if (p === '/api/auth/me') return Promise.resolve(reply(200, { ok: true, user, expiresAt: iso(30) }));
      if (p === '/api/auth/logout') return Promise.resolve(reply(200, { ok: true }));
      return Promise.resolve(reply(404, { ok: false, error: 'nf' }));
    },
  },
};
vm.createContext(sandbox);
vm.runInContext(legacySrc, sandbox, { filename: REF + ':account.js' });

(async () => {
  let loginErr = '';
  try {
    await sandbox.Account.login('a@b.c', 'pw12345678');
  } catch (e) {
    loginErr = (e && e.message) || String(e);
  }

  ok(!loginErr, '旧版 login() 不抛错 —— 界面显示「✓ 登录成功」', loginErr);
  ok(sandbox.Account.isLoggedIn(), '旧版本次运行内确实处于已登录态（内存会话有效）');
  ok(rejectedMode > 0, '旧版确实向 IOUtils.writeUTF8 传了非字符串 mode（' + rejectedMode + ' 次）');

  const files = (dir) => fs.readdirSync(dir).filter((n) => /^papilot-account.*\.json$/.test(n));
  ok(files(DATA_DIR).length === 0, '数据目录里没有任何会话文件（写入被吞）', files(DATA_DIR));
  ok(files(PROF_DIR).length === 0, '配置目录里也没有任何会话文件', files(PROF_DIR));

  // 0.20.0 才引入 _diag / persistStatus —— 按参照版本自适应断言，
  // 这样同一个探针可以对着任意历史版本跑（用于「修复前 vs 修复后」对照）。
  // 注意：0.20.0~0.22.0 的 _diag 是 fire-and-forget（不 await），读日志前要让出一拍。
  await new Promise((r) => setTimeout(r, 400));
  const hasDiag = /_diag\s*\(/.test(legacySrc);
  const hasPersist = /persistStatus/.test(legacySrc);
  const logPath = path.join(DATA_DIR, 'papilot-account.log');
  const logText = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  if (hasDiag) {
    ok(/save FAILED/.test(logText), '该版本有诊断日志，且记录了「save FAILED」', logText.split('\n')[0]);
  } else {
    ok(!fs.existsSync(logPath), '该版本没有落盘诊断日志 —— 掉登录后无从回溯');
  }
  if (!hasPersist) {
    ok(typeof sandbox.Account.persistStatus === 'undefined',
      '该版本没有 persistStatus —— 落盘失败无法被界面感知（「谎报成功」的机制）');
  } else {
    ok(sandbox.Account.persistStatus && sandbox.Account.persistStatus.ok === false,
      '该版本会上报落盘失败（但 0.22.0 仍未修写入本身）',
      sandbox.Account.persistStatus);
  }

  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) { /* ignore */ }

  console.log('\n根因取证（参照 ' + REF + '）：' + pass + ' 项复现，' + failures.length + ' 项不符');
  if (failures.length) {
    for (const f of failures) console.log('  ✗ ' + f);
    process.exit(1);
  }
  console.log('  ✓ 全部复现：登录成功 ≠ 会话落盘，且失败不可见 → 更新 xpi 后必然掉登录');
})();
