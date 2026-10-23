// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 组件目录签名工具（Ed25519，构建期用）
 *
 * 为什么签：组件 zip 走 Release 附件、索引走主仓 raw —— 两条通道都挂同一个仓。
 * zipSha256 能挡住「附件被换」，但挡不住「仓被劫持后索引也被换」。
 * 索引签名是出带外的信任根：私钥不进 git，放 H:/project/_brain/keys/（用户授权的密钥区）。
 *
 * 用法：
 *   node scripts/sign-modules-index.js --gen-key          # 生成密钥对（一次性）
 *   node scripts/sign-modules-index.js <index.json>       # 就地对索引签名
 *
 * 签名内容（canonical payload，与插件侧验签严格一致）：
 *   "papilot-modules-v1\n" + hostMin + "\n" + Σ 每行 "id|version|zipSha256\n"（按 id 排序）
 * 注意：不含 updated 时间戳——签名针对完整性相关字段，时间戳可自由更新。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.dirname(__dirname);
const KEY_DEFAULT = path.join(ROOT, "..", "_brain", "keys", "papilot-modules-ed25519.pem");
const PUB_JSON = path.join(ROOT, "chrome", "content", "modules", "signing-pubkey.json");

function payloadOf(index) {
  const mods = (index.modules || []).slice()
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  let s = "papilot-modules-v1\n" + String(index.hostMin || "") + "\n";
  for (const m of mods) {
    s += String(m.id) + "|" + String(m.version) + "|" + String(m.zipSha256 || "") + "\n";
  }
  s += String(mods.length) + "\n";
  return Buffer.from(s, "utf8");
}

function genKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  fs.mkdirSync(path.dirname(KEY_DEFAULT), { recursive: true });
  fs.writeFileSync(KEY_DEFAULT, pem);
  fs.mkdirSync(path.dirname(PUB_JSON), { recursive: true });
  fs.writeFileSync(PUB_JSON, JSON.stringify({
    kty: "OKP", crv: "Ed25519",
    key: Buffer.from(spki).toString("base64"),
    note: "Papilot 组件目录签名公钥；私钥在 _brain/keys/，永不入库",
  }, null, 2) + "\n");
  console.log("私钥 → " + KEY_DEFAULT);
  console.log("公钥 → " + PUB_JSON);
}

function signIndex(file) {
  const keyPath = process.env.PP_MODULES_SIGNING_KEY || KEY_DEFAULT;
  if (!fs.existsSync(keyPath)) {
    console.error("私钥不存在：" + keyPath + "（先 --gen-key；不设签名时索引保持未签名）");
    process.exitCode = 2;
    return;
  }
  const index = JSON.parse(fs.readFileSync(file, "utf8"));
  const missingHash = (index.modules || []).filter(m => !m.zipSha256);
  if (missingHash.length) {
    console.error("索引缺 zipSha256：" + missingHash.map(m => m.id).join(","));
    process.exitCode = 1;
    return;
  }
  const key = crypto.createPrivateKey(fs.readFileSync(keyPath, "utf8"));
  const sig = crypto.sign(null, payloadOf(index), key);
  index.signature = sig.toString("base64");
  index.signatureAlgo = "ed25519";
  fs.writeFileSync(file, JSON.stringify(index, null, 2) + "\n");
  console.log("已签名：" + file + "（" + (index.modules || []).length + " 条）");
}

const argv = process.argv.slice(2);
if (argv[0] === "--gen-key") {
  genKey();
} else if (argv.length === 1) {
  signIndex(path.resolve(argv[0]));
} else {
  console.log("usage: node scripts/sign-modules-index.js [--gen-key | <index.json>]");
  process.exitCode = 64;
}
