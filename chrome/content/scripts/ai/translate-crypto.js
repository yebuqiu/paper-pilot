// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 翻译模块 · 签名与编码算法子模块（0.73.0 自 translate.js 拆出）
 *
 * 职责（单一）：引擎请求签名所需的**自实现**摘要/编码算法。
 * 为什么手写：插件环境 crypto.subtle 受限（异步 + 权限），而腾讯云老签名、
 * Google gtx tk 等都要同步算出。全部纯函数，对公开测试向量钉死在
 * test/translate.test.js ⑥ 节 —— 算法本体**勿改动**。
 *
 * 零外部依赖。装配：main.js files 列表，须在 translate-engines.js 之前。
 */

var TranslateCrypto = (function () {
  "use strict";

  /* ==================== 编码 / 摘要工具（纯函数，可单测） ==================== */

  /** 字符串 → UTF-8 字节数组 */
  function utf8Bytes(str) {
    const out = [];
    const s = String(str == null ? "" : str);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        const c2 = s.charCodeAt(++i);
        const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
          0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return out;
  }

  function rotl(v, b) { return (v << b) | (v >>> (32 - b)); }

  /** SHA-1 → 20 字节数组（FIPS 180-1；插件环境 crypto.subtle 受限，手写） */
  function sha1Bytes(bytes) {
    const b = bytes.slice();
    const bitLen = b.length * 8;
    b.push(0x80);
    while (b.length % 64 !== 56) b.push(0);
    const hi = Math.floor(bitLen / 0x100000000), lo = bitLen >>> 0;
    for (let i = 3; i >= 0; i--) b.push((hi >>> (i * 8)) & 0xff);
    for (let i = 3; i >= 0; i--) b.push((lo >>> (i * 8)) & 0xff);
    let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
    for (let i = 0; i < b.length; i += 64) {
      const w = new Array(80);
      for (let j = 0; j < 16; j++) {
        w[j] = (b[i + j * 4] << 24) | (b[i + j * 4 + 1] << 16) |
               (b[i + j * 4 + 2] << 8) | b[i + j * 4 + 3];
      }
      for (let j = 16; j < 80; j++) w[j] = rotl(w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16], 1);
      let a = h0, c1 = h1, c2 = h2, c3 = h3, c4 = h4;
      for (let j = 0; j < 80; j++) {
        let f, k;
        if (j < 20) { f = (c1 & c2) | (~c1 & c3); k = 0x5a827999; }
        else if (j < 40) { f = c1 ^ c2 ^ c3; k = 0x6ed9eba1; }
        else if (j < 60) { f = (c1 & c2) | (c1 & c3) | (c2 & c3); k = 0x8f1bbcdc; }
        else { f = c1 ^ c2 ^ c3; k = 0xca62c1d6; }
        const tmp = (rotl(a, 5) + f + c4 + k + w[j]) | 0;
        c4 = c3; c3 = c2; c2 = rotl(c1, 30); c1 = a; a = tmp;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + c1) | 0; h2 = (h2 + c2) | 0;
      h3 = (h3 + c3) | 0; h4 = (h4 + c4) | 0;
    }
    const out = [];
    for (const h of [h0, h1, h2, h3, h4]) {
      for (let i = 3; i >= 0; i--) out.push((h >>> (i * 8)) & 0xff);
    }
    return out;
  }

  /** HMAC-SHA1 → 20 字节数组 */
  function hmacSha1(keyBytes, msgBytes) {
    let key = keyBytes.slice();
    if (key.length > 64) key = sha1Bytes(key);
    while (key.length < 64) key.push(0);
    const ipad = key.map((k) => k ^ 0x36);
    const opad = key.map((k) => k ^ 0x5c);
    const inner = sha1Bytes(ipad.concat(msgBytes));
    return sha1Bytes(opad.concat(inner));
  }

  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  /** 字节数组/字符串 → base64（无填充差异，标准表） */
  function base64(input) {
    const bytes = typeof input === "string" ? utf8Bytes(input) : input;
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
      out += B64[b0 >> 2];
      out += B64[((b0 & 3) << 4) | ((b1 === undefined ? 0 : b1) >> 4)];
      out += b1 === undefined ? "=" : B64[((b1 & 15) << 2) | ((b2 === undefined ? 0 : b2) >> 6)];
      out += b2 === undefined ? "=" : B64[b2 & 63];
    }
    return out;
  }

  /** 腾讯云老签名要求：encodeURIComponent 后再把 ' ( ) * 转义、空格变 + */
  function encodeRFC5987(str) {
    return encodeURIComponent(str)
      .replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
      .replace(/%20/g, "+");
  }

  /** Google gtx 接口的 tk 令牌（算法取自 google translate 前端，勿改） */
  function googleTk(text) {
    const a = String(text == null ? "" : text);
    const bytes = utf8Bytes(a);
    const RL = (x, s) => {
      for (let c = 0; c < s.length - 2; c += 3) {
        let d = s.charAt(c + 2);
        d = d >= "a" ? d.charCodeAt(0) - 87 : Number(d);
        d = s.charAt(c + 1) === "+" ? x >>> d : x << d;
        x = s.charAt(c) === "+" ? (x + d) & 0xffffffff : (x ^ d);
      }
      return x;
    };
    let b = 406644;
    const b1 = 3293161072;
    for (let f = 0; f < bytes.length; f++) {
      b = RL((b + bytes[f]) & 0xffffffff, "+-a^+6");
    }
    b = RL(b, "+-3^+b+-f");
    b ^= b1 || 0;
    if (b < 0) b = (b & 0x7fffffff) + 0x80000000;
    const v = b % 1e6;
    return String(v) + "." + (v ^ 406644);
  }

  /** 轻量 UUID：腾讯 TranSmart 的 client_key 里需要一个随机段（不要求密码学强度） */
  function guid() {
    const hex = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1);
    return hex() + hex() + "-" + hex() + "-" + hex() + "-" + hex() + "-" + hex() + hex() + hex();
  }

  return { utf8Bytes, sha1Bytes, hmacSha1, base64, encodeRFC5987, googleTk, guid };
})();
