// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 账号后台 · 邮件发送模块（server/lib/mail.js，Node >= 14，零依赖）
 *
 * 通过 Resend HTTPS API 发信（https://resend.com，免费 100 封/天）：
 *   - 环境变量 PP_RESEND_KEY   ：Resend API Key（re_xxx）——配置后邮件功能启用
 *   - 环境变量 PP_MAIL_FROM    ：发件人，默认 "Papilot <noreply@xinglintools.top>"
 *   - 环境变量 PP_MAIL_REPLY_TO：回信地址（Reply-To），留空则不带该字段（用户直接回信即可到人）
 *   - 环境变量 PP_RESEND_BASE  ：API 地址覆盖（测试注入 mock 用）
 *   - 环境变量 PP_PUBLIC_URL   ：邮件里链接的公网前缀（默认按 https://{Host头} 推断）
 *
 * 未配置 PP_RESEND_KEY 时 configured()=false：注册不验证、找回密码引导联系管理员。
 * 使用的 DNS 前置：xinglintools.top 在 Resend 后台添加域名并按提示在 Cloudflare
 * 加 SPF/DKIM 记录后即可用自定义发件地址。
 */
'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');

function configured() {
  return Boolean(process.env.PP_RESEND_KEY);
}

function fromAddress() {
  return process.env.PP_MAIL_FROM || 'Papilot <noreply@xinglintools.top>';
}

/**
 * 回信地址（Reply-To）：取 PP_MAIL_REPLY_TO，trim 后为空则返回 ''。
 * 返回 '' 表示「不设置 Reply-To」——此时用户回信会退回发件地址，不会丢失。
 */
function replyToAddress() {
  return String(process.env.PP_MAIL_REPLY_TO || '').trim();
}

/** 公网链接前缀：PP_PUBLIC_URL > https://{host 头} > 本机回退 */
function publicBaseUrl(req) {
  if (process.env.PP_PUBLIC_URL) return String(process.env.PP_PUBLIC_URL).replace(/\/+$/, '');
  const host = req && req.headers && req.headers.host;
  if (host) return 'https://' + host;
  return 'http://127.0.0.1:' + (process.env.PP_PORT || 8000);
}

/** 发送一封邮件（纯文本 + 简单 HTML）；返回 {ok} | {ok:false,error} */
function send({ subject, text, html, to }) {
  return new Promise((resolve) => {
    if (!configured()) return resolve({ ok: false, error: '邮件服务未配置（PP_RESEND_KEY）' });
    const base = new URL(process.env.PP_RESEND_BASE || 'https://api.resend.com');
    const mod = base.protocol === 'https:' ? https : http;
    const message = {
      from: fromAddress(),
      to: [to],
      subject,
      text,
      html,
    };
    // 回信地址：Resend 字段名就是 reply_to（字符串）；未配置则整条字段不出现
    const replyTo = replyToAddress();
    if (replyTo) message.reply_to = replyTo;
    const payload = Buffer.from(JSON.stringify(message), 'utf8');
    const req = mod.request(base.protocol + '//' + base.host + '/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.PP_RESEND_KEY,
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
      },
      timeout: 12000,
    }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (r.statusCode >= 200 && r.statusCode < 300) return resolve({ ok: true });
        let msg = 'HTTP ' + r.statusCode;
        try { msg = JSON.parse(body).message || msg; } catch (e) { /* ignore */ }
        resolve({ ok: false, error: '邮件发送失败：' + msg });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ ok: false, error: '邮件发送失败：' + (e.message || e) }));
    req.write(payload);
    req.end();
  });
}

/* ---------- 邮件模板 ---------- */

function linkButton(url, label) {
  return '<div style="margin:26px 0">' +
    '<a href="' + url + '" style="display:inline-block;background:#2563eb;color:#ffffff;' +
    'text-decoration:none;border-radius:8px;padding:11px 26px;font-size:15px;font-weight:600">' +
    label + '</a></div>' +
    '<p style="color:#6b7280;font-size:12.5px;word-break:break-all">或复制链接到浏览器：<br>' + url + '</p>';
}

function pageWrap(title, bodyHtml) {
  return '<div style="font-family:\'Microsoft YaHei\',system-ui,sans-serif;max-width:520px;margin:0 auto;' +
    'color:#1f2329;font-size:14px;line-height:1.8">' +
    '<div style="font-size:17px;font-weight:700;margin-bottom:12px">📄 Papilot</div>' +
    '<p>' + title + '</p>' + bodyHtml +
    '<p style="color:#9ca3af;font-size:12px;margin-top:26px">此邮件由系统发送，无需回复。' +
    '如果你没有注册过 Papilot 账号，请忽略本邮件。</p></div>';
}

/** 邮箱验证邮件 */
function sendVerifyMail(to, url) {
  return send({
    to,
    subject: '【Papilot】验证你的邮箱',
    text: '欢迎注册 Papilot！请点击以下链接验证邮箱（24 小时内有效）：\n' + url,
    html: pageWrap('欢迎注册 Papilot！点击下方按钮验证邮箱（<b>24 小时内有效</b>）：',
      linkButton(url, '验证邮箱')),
  });
}

/** 密码重置邮件 */
function sendResetMail(to, url) {
  return send({
    to,
    subject: '【Papilot】重置密码',
    text: '你（或他人）申请了 Papilot 密码重置。请在 30 分钟内点击以下链接设置新密码：\n' + url +
      '\n如非本人操作，请忽略本邮件，密码不会改变。',
    html: pageWrap('收到密码重置请求。点击下方按钮设置新密码（<b>30 分钟内有效</b>）：<br>' +
      '<span style="color:#6b7280;font-size:12.5px">如非本人操作请直接忽略，密码不会改变。</span>',
      linkButton(url, '重置密码')),
  });
}

module.exports = { configured, fromAddress, publicBaseUrl, send, sendVerifyMail, sendResetMail };
