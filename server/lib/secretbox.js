/* PaperPilot 账号后台 · 对称加密盒子（AES-256-GCM）
 *
 * 用途：加密落盘「不该明文躺着」的配置项。当前唯一使用方是支付商户密钥
 * （server/lib/pay.js 的 keyEnc / privateKeyEnc）。
 *
 * 设计：
 *   · 主密钥单独存 data/.secret.key（0600，首次自动生成）——**不进快照、不进备份**。
 *     于是备份文件即使被整包拿走也解不开商户密钥（备份里只有密文）。
 *   · 密文格式 `iv.tag.ct`（各段 base64）。GCM 自带认证标签：密文被改一个字节，
 *     解密端直接失败，不会悄悄返回垃圾明文。
 *   · 解密失败一律返回 null，**由调用方决定怎么表述**——绝不让异常冒到路由层
 *     （那会变成 500 或更糟：静默地用空密钥去验签，把所有回调判成失败）。
 *
 * ★ 主密钥丢失（换机器没带走 .secret.key、或误删）的后果：
 *   已存的商户密钥解不开 → 支付配置视为「未就绪」→ 在线支付自动不可用（fail-safe），
 *   管理员重新粘贴一次密钥即可恢复。**这是可接受的**，比把密钥明文存盘好。
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KEY_BYTES = 32;
const KEY_FILE = '.secret.key';

function keyPath(dataDir) {
  return path.join(dataDir, KEY_FILE);
}

/** 读主密钥；不存在则生成（首次调用即落盘，0600） */
function loadKey(dataDir) {
  const f = keyPath(dataDir);
  try {
    if (!fs.existsSync(f)) {
      const hex = crypto.randomBytes(KEY_BYTES).toString('hex');
      fs.writeFileSync(f, hex, { mode: 0o600 });
      return Buffer.from(hex, 'hex');
    }
    const buf = Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex');
    if (buf.length !== KEY_BYTES) throw new Error('长度不是 32 字节');
    return buf;
  } catch (e) {
    throw new Error('主密钥不可用（' + f + '）：' + e.message);
  }
}

/** 加密 → `iv.tag.ct`（base64 三段） */
function encrypt(dataDir, plain) {
  const s = String(plain == null ? '' : plain);
  if (!s) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', loadKey(dataDir), iv);
  const ct = Buffer.concat([cipher.update(s, 'utf8'), cipher.final()]);
  return iv.toString('base64') + '.' + cipher.getAuthTag().toString('base64') + '.' + ct.toString('base64');
}

/** 解密；**任何失败都返回 null**（密文损坏、主密钥换了、格式不对都归这一类） */
function decrypt(dataDir, blob) {
  try {
    const parts = String(blob || '').split('.');
    if (parts.length !== 3) return null;
    const iv = Buffer.from(parts[0], 'base64');
    const tag = Buffer.from(parts[1], 'base64');
    const ct = Buffer.from(parts[2], 'base64');
    if (iv.length !== 12 || tag.length !== 16 || !ct.length) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', loadKey(dataDir), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch (e) {
    return null;
  }
}

/** 是否像一个加密串（供配置回显时判断「存过没有」） */
function isEncryptedBlob(v) {
  return typeof v === 'string' && v.split('.').length === 3 && v.length > 40;
}

module.exports = { KEY_FILE, loadKey, encrypt, decrypt, isEncryptedBlob };
