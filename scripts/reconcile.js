#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 收款流水对账 CLI（服务端 1.4.5）
 *
 * 用法：
 *   node scripts/reconcile.js payments.txt             # 预览（不改任何数据）
 *   node scripts/reconcile.js payments.txt --apply     # 确认后执行核销
 *   node scripts/reconcile.js payments.txt --window 7  # 只匹配 7 天内的订单（默认 30）
 *   node scripts/reconcile.js payments.txt --url http://127.0.0.1:8000
 *
 * 流水文件格式（每行一条，时间与备注可空；也接受粘贴的 CSV，`¥` 与全角逗号都能识别）：
 *   128.62
 *   128.35,2026-10-03 12:30
 *   29.50,2026-10-03 13:05,微信转账,4200001234
 *
 * 为什么走 HTTP 而不是直接改 server/data/*.json：**正在运行的服务端在内存里持有权威副本**，
 * 直接改文件会被它下一次 save() 覆盖（甚至丢失本次核销）。走接口才是一致的。
 */
'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const file = argv.find((a) => !a.startsWith('--') && !/^\d+$/.test(a) && a !== opt('--url') && a !== opt('--window'));
if (!file) {
  console.log('用法: node scripts/reconcile.js <流水文件> [--apply] [--window 30] [--url http://127.0.0.1:8000]');
  process.exit(2);
}
const apply = flag('--apply');
const windowDays = Number(opt('--window', '30')) || 30;
const base = String(opt('--url', 'http://127.0.0.1:8000')).replace(/\/+$/, '');

function post(urlStr, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr + '/api/admin/reconcile');
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const mod = u.protocol === 'https:' ? https : http;
    const r = mod.request({
      host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      method: 'POST', path: u.pathname,
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
    }, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(Buffer.concat(cs).toString('utf8')); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, json: j });
      });
    });
    r.on('error', reject);
    r.write(payload);
    r.end();
  });
}

const money = (c) => '¥' + ((Number(c) || 0) / 100).toFixed(2);
const pad = (s, n) => {
  const w = [...String(s)].reduce((a, ch) => a + (ch.charCodeAt(0) > 127 ? 2 : 1), 0);
  return String(s) + ' '.repeat(Math.max(0, n - w));
};

(async () => {
  const src = path.resolve(file);
  if (!fs.existsSync(src)) { console.error('找不到流水文件：' + src); process.exit(2); }
  const text = fs.readFileSync(src, 'utf8');

  let res;
  try {
    res = await post(base, { text, dryRun: !apply, windowDays });
  } catch (e) {
    console.error('请求失败：' + (e && e.message) + '\n（服务端在运行吗？' + base + '）');
    process.exit(1);
  }
  const j = res.json;
  if (res.status !== 200 || !j || !j.ok) {
    console.error('对账失败：' + ((j && j.error) || ('HTTP ' + res.status)));
    process.exit(1);
  }

  console.log('\n收款流水对账' + (j.dryRun ? '（预览：不会改动任何数据）' : '（已执行核销）'));
  console.log('  文件：' + src + '   时间窗：' + windowDays + ' 天');
  console.log('  ' + '-'.repeat(96));
  for (const r of j.results) {
    const mark = r.status === 'matched' ? '✓ 命中' : (r.status === 'unmatched' ? '· 无对应' : '! ' + r.status);
    const detail = r.status === 'matched'
      ? ('订单 ' + pad(r.orderId, 16) + pad(r.email || '', 26)
        + (r.perpetual ? '永久会员' : (r.months + ' 个月')) + '　' + (r.createdAt || '').replace('T', ' ').slice(0, 16))
      : (r.reason || '');
    console.log('  ' + pad(r.amountText, 11) + pad(mark, 10) + detail);
  }
  const s = j.summary;
  console.log('  ' + '-'.repeat(96));
  console.log('  共 ' + s.total + ' 条：命中 ' + s.matched + ' · 无对应 ' + s.unmatched
    + ' · 需人工 ' + s.ambiguous + ' · 重复 ' + s.duplicate + '　命中金额 ' + money(s.matchedCents));
  if (j.dryRun) {
    console.log('\n  确认无误后执行：node scripts/reconcile.js ' + file + ' --apply\n');
  } else {
    const bad = (j.applied || []).filter((x) => !x.ok);
    console.log('  已核销 ' + (j.applied || []).filter((x) => x.ok).length + ' 笔'
      + (bad.length ? ('，失败 ' + bad.length + ' 笔：' + bad.map((x) => x.orderId + '(' + x.error + ')').join('、')) : ''));
    console.log('');
  }
  process.exit(0);
})();
