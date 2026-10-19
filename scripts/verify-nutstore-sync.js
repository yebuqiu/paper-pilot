#!/usr/bin/env node
/* 坚果云云同步 · 真机冒烟（0.56.0）
 *
 * 用真实坚果云 WebDAV 跑一遍：目录创建 / 中文名 PUT / GET 校验 / 412 冲突 /
 * 条件覆盖 / 目录列举 / 引擎三轮增量 / 冲突留档，最后**清理本次创建的临时目录**。
 *
 * 凭据只走环境变量，绝不落盘、不打印：
 *   PP_NUTSTORE_EMAIL=you@example.com
 *   PP_NUTSTORE_TOKEN=<应用密码>
 *
 * 运行：
 *   PP_NUTSTORE_EMAIL=... PP_NUTSTORE_TOKEN=... node scripts/verify-nutstore-sync.js
 *
 * 说明：临时根目录是 `/Papilot-verify-<随机>`，与插件正式目录 `/Papilot` 隔离；
 * 脚本结束会递归删除该目录（删不掉时会打印残留路径，不静默）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const https = require('https');
const { URL } = require('url');

const ROOT = path.join(__dirname, '..');
const EMAIL = process.env.PP_NUTSTORE_EMAIL || '';
const TOKEN = process.env.PP_NUTSTORE_TOKEN || '';

if (!EMAIL || !TOKEN) {
  console.error('缺少凭据：请设置 PP_NUTSTORE_EMAIL / PP_NUTSTORE_TOKEN');
  process.exit(2);
}

/* ---------------- 真实传输（Node https） ---------------- */

function netTransport(o) {
  return new Promise((resolve, reject) => {
    const u = new URL(o.url);
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: o.method,
      headers: o.headers || {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const headers = {};
        for (const k of Object.keys(res.headers)) {
          const v = res.headers[k];
          headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
        }
        const isText = o.responseType === 'text';
        resolve({
          status: res.statusCode,
          headers,
          body: isText ? buf.toString('utf8') : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
          text: isText ? buf.toString('utf8') : '',
        });
      });
    });
    req.on('error', (e) => {
      const err = new Error('网络层失败：' + e.message);
      err.code = 'NETWORK';
      reject(err);
    });
    req.setTimeout(o.timeout || 30000, () => {
      const err = new Error('请求超时');
      err.code = 'TIMEOUT';
      req.destroy(err);
    });
    if (o.body != null) {
      req.write(Buffer.from(o.body instanceof ArrayBuffer ? new Uint8Array(o.body) : o.body));
    }
    req.end();
  });
}

/* ---------------- 最小 Zotero 环境（只为加载 cloud-sync.js） ---------------- */

const PREF_PREFIX = 'extensions.zotero.papilot.';
const prefStore = new Map();
const prefTypes = new Map();
const fullKey = (k) => (String(k).indexOf(PREF_PREFIX) === 0 ? String(k) : PREF_PREFIX + k);

const Prefs = {
  PREFIX: PREF_PREFIX,
  get(k, d) { const f = fullKey(k); return prefStore.has(f) ? prefStore.get(f) : d; },
  set(k, v) {
    const f = fullKey(k);
    prefStore.set(f, v);
    prefTypes.set(f, typeof v === 'boolean' ? 'bool' : (typeof v === 'number' ? 'int' : 'string'));
  },
};

const Services = {
  prefs: {
    PREF_STRING: 32, PREF_INT: 64, PREF_BOOL: 128,
    getChildList(root) { return [...prefStore.keys()].filter((k) => k.indexOf(root) === 0); },
    getPrefType(full) {
      const t = prefTypes.get(full);
      return t === 'bool' ? 128 : (t === 'int' ? 64 : 32);
    },
    prefHasUserValue() { return true; },
    getStringPref(full) { return String(prefStore.get(full)); },
    getBoolPref(full) { return !!prefStore.get(full); },
    getIntPref(full) { return Math.round(Number(prefStore.get(full)) || 0); },
  },
};

const files = new Map();
const mt = new Map();
let clock = Date.now();
const IOUtils = {
  async exists(p) {
    if (files.has(p)) return true;
    for (const k of files.keys()) if (k.startsWith(p + '/')) return true;
    return false;
  },
  async stat(p) {
    if (!files.has(p)) {
      if ([...files.keys()].some((k) => k.startsWith(p + '/'))) return { type: 'directory', size: 0, lastModified: 0 };
      throw new Error('ENOENT ' + p);
    }
    const v = files.get(p);
    return { type: 'regular', size: Buffer.byteLength(v), lastModified: mt.get(p) || clock };
  },
  async read(p) { return new Uint8Array(Buffer.from(files.get(p), 'utf8')); },
  async readUTF8(p) { return String(files.get(p)); },
  async write(p, bytes) { files.set(p, Buffer.from(bytes).toString('utf8')); mt.set(p, ++clock); },
  async writeUTF8(p, text) { files.set(p, String(text)); mt.set(p, ++clock); },
  async makeDirectory() {},
  async copy(src, dst) { files.set(dst, files.get(src)); mt.set(dst, ++clock); },
  async move(src, dst) { files.set(dst, files.get(src)); mt.set(dst, ++clock); files.delete(src); },
  async remove(p) { files.delete(p); },
  async getChildren(p) {
    const pre = p + '/';
    const out = new Set();
    for (const k of files.keys()) {
      if (!k.startsWith(pre)) continue;
      const seg = k.slice(pre.length).split('/')[0];
      if (seg) out.add(pre + seg);
    }
    return [...out];
  },
};

const Zotero = {
  DataDirectory: { dir: '/data' },
  isWin: true, isMac: false, isLinux: false,
  version: '10.0.5',
  Papilot: { version: '0.56.0' },
  Prefs: { get: (k, d) => Prefs.get(k, d), set: (k, v) => Prefs.set(k, v) },
  launchFile() {},
};

const sandbox = {
  console, Buffer, setTimeout, clearTimeout, setInterval, clearInterval,
  Promise, Date, Math, JSON, URL, RegExp, Error, Object, Array, String, Number, Boolean,
  TextEncoder, TextDecoder, crypto: require('crypto').webcrypto,
  Prefs, Services, IOUtils, Zotero, SkillPacks: null,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const rel of ['chrome/content/scripts/core/webdav.js', 'chrome/content/scripts/features/cloud-sync.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox, { filename: rel });
}
const W = sandbox.WebDAV;
const CS = sandbox.CloudSync;

/* ---------------- 断言 ---------------- */

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; console.log('  ✓ ' + label); return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  console.log('  ✗ ' + label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
const eq = (a, b, label) => ok(a === b, label, { got: a, want: b });

/* ---------------- 清理 ---------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 清理：按"已知路径"删，而不是深度递归列举——列举本身会放大请求量，
 * 真机上正是密集 PROPFIND 触发了坚果云 503 限流。每个请求之间留 400ms。
 */
async function cleanup(client, rootPath, extraFiles) {
  const files = [...new Set((extraFiles || []).filter(Boolean))];
  files.push(rootPath + '/data/settings.json');
  try {
    const dev = await client.propfind(rootPath + '/devices', 1);
    for (const it of dev) {
      if (it && !it.isDir && it.path !== W.normalizePath(rootPath + '/devices')) files.push(it.path);
    }
  } catch (e) { /* 目录不存在就跳过 */ }

  for (const p of files) {
    try { await client.del(p); await sleep(400); } catch (e) { /* 已删或不存在 */ }
  }
  for (const d of [rootPath + '/data', rootPath + '/devices', rootPath]) {
    try { await client.del(d); await sleep(400); } catch (e) { /* 目录不空/不存在 */ }
  }

  await sleep(800);
  try {
    const left = await client.propfind(rootPath, 0);
    if (left.length) console.log('  ! 临时目录仍有残留（限流时请稍后手动删除）：' + rootPath);
  } catch (e) {
    if (e && (e.code === 'RATE_LIMIT' || e.blocked)) {
      console.log('  ! 清理时被限流，请稍后确认并删除：' + rootPath);
    }
  }
}

/* ---------------- 主流程 ---------------- */

(async function main() {
  const cfg = { baseUrl: W.DEFAULT_BASE, username: EMAIL, password: TOKEN, transport: netTransport, timeoutMs: 30000 };
  const client = W.createClient(cfg);
  const rootPath = '/Papilot-verify-' + Date.now().toString(36);

  console.log('== 1. 协议层（真实服务端）==');
  const st0 = await client.stat('/');
  ok(!!st0 && st0.isDir, '根目录可列举（凭据有效）');

  await client.ensureDir(rootPath);
  const stDir = await client.stat(rootPath);
  ok(stDir && stDir.isDir, 'MKCOL 创建临时目录');

  const name = '数据 测试(1).json';
  const localPath = rootPath + '/' + name;
  const payload = new TextEncoder().encode('{"hello":"世界","n":1}');
  const up1 = await client.put(localPath, payload, { createOnly: true });
  ok(!!up1.etag, 'PUT 中文/空格/括号文件名成功并返回 ETag', up1.etag);
  ok(up1.size === payload.byteLength, 'PUT 返回大小与本地一致', { got: up1.size, want: payload.byteLength });

  const stFile = await client.stat(localPath);
  eq(stFile.size, payload.byteLength, 'PROPFIND 取到正确大小');
  eq(stFile.name, name, 'PROPFIND 正确解码中文文件名');

  const down = await client.getBuffer(localPath);
  const downText = Buffer.from(new Uint8Array(down.body)).toString('utf8');
  eq(downText, '{"hello":"世界","n":1}', 'GET 内容与上传一致');

  let conflictCode = '';
  try { await client.put(localPath, payload, { etag: 'deadbeef' }); }
  catch (e) { conflictCode = e.code; }
  eq(conflictCode, 'CONFLICT', '错误的 If-Match → 412 CONFLICT');

  const up2 = await client.put(localPath, new TextEncoder().encode('{"hello":"世界","n":2}'), { etag: stFile.etag });
  ok(up2.status === 204 || up2.status === 201, '正确的 If-Match → 条件覆盖成功', up2.status);
  ok(up2.etag && up2.etag !== stFile.etag, '覆盖后 ETag 变化');

  const listing = await client.propfind(rootPath, 1);
  ok(listing.some((x) => x.name === name), '目录列举包含刚上传的文件');
  // 协议层用例的文件先删掉，减少末尾清理的请求量（限流时很关键）
  await client.del(localPath);

  console.log('== 2. 引擎（三轮增量 + 冲突）==');
  Prefs.set('cloudSyncEmail', EMAIL);
  Prefs.set('cloudSyncToken', TOKEN);
  Prefs.set('cloudSyncRoot', rootPath);
  Prefs.set('cloudSyncDatasets', 'settings');
  Prefs.set('cloudSyncConflictPolicy', 'keepBoth');
  Prefs.set('cloudSyncAutoMinutes', 0);
  Prefs.set('aiSystemPrompt', '真机冒烟 v1');
  Prefs.set('cloudSyncDeviceName', 'verify-script');
  CS._transport = netTransport;
  CS._client = null;
  CS._retries = 1;

  const r1 = await CS.syncNow();
  ok(r1.ok && r1.uploaded === 1 && r1.failed === 0, '首轮：上传 1 个快照，无失败', { ok: r1.ok, up: r1.uploaded, failed: r1.failed, err: r1.error, errors: r1.errors });
  const remoteSettings = rootPath + '/data/settings.json';
  const stSettings = await client.stat(remoteSettings);
  ok(!!stSettings && stSettings.size > 0, '云端出现 data/settings.json', stSettings && stSettings.size);

  const r2 = await CS.syncNow();
  ok(r2.uploaded === 0 && r2.downloaded === 0, '第二轮：0 上传 0 下载（增量生效）', { up: r2.uploaded, down: r2.downloaded, skip: r2.skipped });

  Prefs.set('aiSystemPrompt', '真机冒烟 v2');
  const r3 = await CS.syncNow();
  ok(r3.uploaded === 1 && r3.downloaded === 0, '改设置后：只上传 1 个文件', { up: r3.uploaded, down: r3.downloaded });

  // 冲突：模拟另一台设备改了云端，同时本机也改了
  const stNow = await client.stat(remoteSettings);
  const other = new TextEncoder().encode('{"version":1,"prefs":{"aiSystemPrompt":"另一台设备"}}');
  await client.put(remoteSettings, other, { etag: stNow.etag });
  Prefs.set('aiSystemPrompt', '真机冒烟 v3（本机）');
  const r4 = await CS.syncNow();
  ok(r4.conflicts === 1, '两边都改 → 记录 1 个冲突', { conflicts: r4.conflicts, errors: r4.errors });
  const backups = [...files.keys()].filter((k) => k.indexOf('/data/papilot-cloud/conflicts/settings/') === 0);
  ok(backups.length >= 1, '冲突时云端旧版已本机留档', backups);

  console.log('== 3. 清理 ==');
  await cleanup(client, rootPath, [localPath]);

  console.log('');
  console.log('真机冒烟：%d 通过 / %d 失败', pass, fails.length);
  if (fails.length) {
    for (const f of fails) console.log('  ✗ ' + f);
    process.exit(1);
  }
})().catch((e) => {
  console.error('真机冒烟异常：' + (e && (e.stack || e.message) || e));
  process.exit(1);
});
