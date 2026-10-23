#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 翻译引擎「真实联网」可用性探针（运维/排障工具，不进 xpi）
 *
 * 为什么需要它：`test/translate.test.js` 全部用桩 HTTP，只能证明「我们的代码按契约
 * 构造/解析」，无法证明「对方接口今天还活着」。第三方网页接口改版极其频繁
 * （换域名、加签名、加 cookie 门禁、下线），单测永远绿而用户侧全红。
 * 这个脚本用**真实插件代码 + 真实网络**逐个引擎跑一句样文，输出可用性与失败原因。
 *
 * 用法：
 *   node scripts/diag/probe-translate-live.js                 # 全部引擎（需密钥的跳过）
 *   node scripts/diag/probe-translate-live.js edge google      # 只探指定引擎
 *   node scripts/diag/probe-translate-live.js --text "自定义样文"
 *   node scripts/diag/probe-translate-live.js --secret deepl=<key>   # 临时注入密钥（不落盘）
 *   node scripts/diag/probe-translate-live.js --json           # 机器可读输出
 *
 * 退出码：0 = 所有被探测的引擎都通过；1 = 有失败（便于挂到巡检里）。
 * 注意：不走插件 pref，密钥只在内存里；样文不要放未发表内容（会发往第三方）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const ROOT = path.join(__dirname, '..', '..');
const MODULE_FILES = require(path.join(ROOT, 'test', 'translate-files.js'));

/* ---------------- 参数 ---------------- */
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
let sample = 'The quick brown fox jumps over the lazy dog. Machine translation is a hard problem.';
let textIdx = argv.indexOf('--text');
if (textIdx >= 0 && argv[textIdx + 1]) sample = argv[textIdx + 1];
const secrets = {};
argv.forEach((a, i) => {
  if (a === '--secret' && argv[i + 1]) {
    const kv = String(argv[i + 1]);
    const eq = kv.indexOf('=');
    if (eq > 0) secrets[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
});
const want = argv.filter((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--text'
  && argv[argv.indexOf(a) - 1] !== '--secret');

/* ---------------- 极简 cookie jar（必应/Edge 链路依赖 prepare 阶段下发的 cookie） ---------------- */
const jar = new Map();
function jarHeader(u) {
  const host = new URL(u).host;
  const out = [];
  for (const [k, v] of jar) { if (v.host === host) out.push(k + '=' + v.value); }
  return out.join('; ');
}
function jarStore(u, setCookie) {
  if (!setCookie) return;
  const host = new URL(u).host;
  for (const line of [].concat(setCookie)) {
    const m = /^([^=;\s]+)=([^;]*)/.exec(line);
    if (m) jar.set(m[1], { host, value: m[2] });
  }
}

/* ---------------- Zotero.HTTP.request 的最小真实实现（含重定向 / cookie / 超时） ---------------- */
function realRequest(method, url, opts) {
  opts = opts || {};
  const timeout = Number(opts.timeout) > 0 ? Number(opts.timeout) : 15000;
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const go = (u, redirects) => {
      let parsed;
      try { parsed = new URL(u); } catch (e) { return reject(new Error('URL 非法：' + u)); }
      const mod = parsed.protocol === 'http:' ? http : https;
      const headers = Object.assign({}, opts.headers || {});
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'user-agent')) {
        headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
      }
      const ck = jarHeader(u);
      if (ck) headers.Cookie = ck;
      let body = opts.body;
      if (body != null) headers['Content-Length'] = Buffer.byteLength(String(body));
      const req = mod.request({
        method: method || 'GET', hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
        path: parsed.pathname + parsed.search, headers,
      }, (res) => {
        jarStore(u, res.headers['set-cookie']);
        const sc = res.statusCode;
        if (sc >= 300 && sc < 400 && res.headers.location && redirects < 5) {
          res.resume();
          const next = new URL(res.headers.location, u).href;
          return go(next, redirects + 1);
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let response = text;
          if (opts.responseType === 'json') {
            try { response = JSON.parse(text); } catch (e) { response = text; }
          }
          if (sc >= 400) {
            const err = new Error('HTTP ' + sc + ' for ' + u.slice(0, 90));
            err.xmlhttp = { status: sc, response, responseText: text };
            return reject(err);
          }
          resolve({ status: sc, response, responseText: text });
        });
      });
      req.setTimeout(Math.max(1000, deadline - Date.now()), () => {
        req.destroy(new Error('timeout after ' + timeout + 'ms'));
      });
      req.on('error', (e) => {
        const err = new Error((e && e.message) || String(e));
        err.xmlhttp = { status: 0, response: null, responseText: '' };
        reject(err);
      });
      if (body != null) req.write(String(body));
      req.end();
    };
    go(url, 0);
  });
}

/* ---------------- 桩环境（Prefs 用内存；Zotero.HTTP 走真实网络） ---------------- */
const PrefStore = new Map();
const Prefs = {
  get(k, d) { return PrefStore.has(k) ? PrefStore.get(k) : d; },
  set(k, v) { PrefStore.set(k, v); },
};
const Zotero = {
  locale: 'zh-CN',
  Prefs,
  Utilities: { Internal: { md5: (s) => require('crypto').createHash('md5').update(String(s), 'utf8').digest('hex') } },
  HTTP: { request: realRequest },
};
const AIClient = { hasKey: () => false, guidance: () => '探针不测大模型', async chat() { return ''; } };

const sandbox = { console, Zotero, Prefs, AIClient, setTimeout, clearTimeout,
  Promise, Date, Math, JSON, URLSearchParams, TextEncoder, TextDecoder };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of MODULE_FILES) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
}
const T = sandbox.TranslateSvc;

/* ---------------- 逐引擎探测 ---------------- */
(async function main() {
  const all = T.list().filter((s) => !s.llm);
  const ids = want.length ? want : all.map((s) => s.id);
  // 密钥注入（仅内存）
  for (const [id, raw] of Object.entries(secrets)) T.setSecret(id, raw);

  const rows = [];
  for (const id of ids) {
    const svc = T.get(id);
    if (!svc) { rows.push({ id, ok: false, error: '未知引擎' }); continue; }
    if (svc.needsSecret && !T.resolveSecret(id, T.secretOf(id)).ok) {
      rows.push({ id, name: svc.name, ok: null, error: '跳过：未配置密钥（' +
        T.resolveSecret(id, T.secretOf(id)).error + '）' });
      if (!asJson) process.stdout.write('· ' + id + ' 跳过（未配置密钥）\n');
      continue;
    }
    const t0 = Date.now();
    const r = await T.testEngine(id, sample);
    rows.push({
      id, name: svc.name, ok: !!r.ok, ms: Date.now() - t0,
      text: r.ok ? r.text : undefined, error: r.ok ? undefined : r.error,
    });
    if (!asJson) {
      const mark = r.ok ? 'OK  ' : 'FAIL';
      process.stdout.write(mark + '  ' + id.padEnd(16) + (Date.now() - t0 + 'ms').padStart(7) +
        '  ' + (r.ok ? JSON.stringify(String(r.text).slice(0, 60)) : r.error) + '\n');
    }
  }

  if (asJson) process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
  const failed = rows.filter((r) => r.ok === false);
  if (!asJson) {
    process.stdout.write('\n合计 ' + rows.length + ' 个：通过 ' + rows.filter((r) => r.ok).length +
      '，失败 ' + failed.length + '，跳过 ' + rows.filter((r) => r.ok === null).length + '\n');
  }

  // --flow：再走一次**真实的主翻译流程**（默认配置：llm 不可用 → 回退链 edge→bing→youdao→transmart）
  // 单引擎都能通，不代表整条链能通（预算/冷却/prepare/回退任一环出问题都会让用户看到"翻译失败"）。
  let flowOk = true;
  if (argv.includes('--flow')) {
    const r = await T.translate(sample, { to: 'zh-CN' });
    flowOk = !!r.ok;
    if (!flowOk) failed.push({ id: 'flow', ok: false, error: r.error, detail: r.detail });
    if (!asJson) {
      process.stdout.write('\n[主流程] ' + (r.ok ? 'OK  ' : 'FAIL') +
        '  engine=' + (r.engine || '-') + (r.fallback ? '（回退）' : '') +
        '  tried=' + (r.tried || []).map((t) => t.id || t.engine).join(',') +
        '\n  译文：' + String(r.ok ? r.text : (r.error || '')).slice(0, 120) + '\n' +
        (!r.ok && r.detail ? '  明细：' + r.detail + '\n' : ''));
    } else {
      process.stdout.write(JSON.stringify({ flow: r }, null, 2) + '\n');
    }
  }
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('探针异常：' + ((e && e.stack) || e));
  process.exit(2);
});
