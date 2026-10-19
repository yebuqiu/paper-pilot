#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 坚果云云同步回归测试（0.56.0）
 *
 * 覆盖四层：
 *   ① WebDAV 协议层：路径编码、207 解析（各种命名空间前缀）、状态码归因、
 *      退避区间、Range、分卷清单校验、分卷命名；
 *   ② 同步决策：三向增量判定矩阵（本地/云端/索引 × 方向 × 策略）；
 *   ③ 安全边界：设置快照必须剔除密钥类 pref，且内容稳定（否则每轮乒乓）；
 *   ④ 行为：登录参数校验、401/403/412/507 分类、重试只对可重试码生效、
 *      分卷上传幂等（已存在同尺寸分片跳过）、快照应用白名单。
 *
 * 运行：node test/cloud-sync.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const WEBDAV_JS = path.join(ROOT, 'chrome', 'content', 'scripts', 'core', 'webdav.js');
const SYNC_JS = path.join(ROOT, 'chrome', 'content', 'scripts', 'features', 'cloud-sync.js');

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

/* ---------------- 沙箱 ---------------- */

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
    getChildList(root) {
      return [...prefStore.keys()].filter((k) => k.indexOf(root) === 0);
    },
    getPrefType(full) {
      const t = prefTypes.get(full);
      return t === 'bool' ? 128 : (t === 'int' ? 64 : 32);
    },
    prefHasUserValue() { return true; },
    getStringPref(full) { return String(prefStore.get(full)); },
    getBoolPref(full) { return !!prefStore.get(full); },
    getIntPref(full) { return Math.round(Number(prefStore.get(full)) || 0); },
  },
  prompt: { alert() {} },
};

const files = new Map();       // 路径 → Uint8Array | string
const mt = new Map();          // 路径 → mtime（写入即推进，供增量判定）
const dirs = new Set();
let clock = 1700000000000;

const IOUtils = {
  async exists(p) {
    if (files.has(p) || dirs.has(p)) return true;
    // 目录可由子文件推断（真机上 IOUtils.exists 对目录同样返回 true）
    for (const k of files.keys()) if (k.startsWith(p + '/')) return true;
    return false;
  },
  async stat(p) {
    const isDir = dirs.has(p) || [...files.keys()].some((k) => k.startsWith(p + '/'));
    if (isDir) return { type: 'directory', size: 0, lastModified: mt.get(p) || 0 };
    if (!files.has(p)) throw new Error('ENOENT ' + p);
    const v = files.get(p);
    return {
      type: 'regular',
      size: typeof v === 'string' ? Buffer.byteLength(v) : v.byteLength,
      lastModified: mt.get(p) || 1700000000000,
    };
  },
  async read(p) {
    const v = files.get(p);
    if (v === undefined) throw new Error('ENOENT ' + p);
    return typeof v === 'string' ? new Uint8Array(Buffer.from(v, 'utf8')) : v;
  },
  async readUTF8(p) {
    const v = files.get(p);
    if (v === undefined) throw new Error('ENOENT ' + p);
    return typeof v === 'string' ? v : Buffer.from(v).toString('utf8');
  },
  async write(p, bytes) { files.set(p, bytes); mt.set(p, ++clock); },
  async writeUTF8(p, text) { files.set(p, String(text)); mt.set(p, ++clock); },
  async makeDirectory(p) { dirs.add(p); },
  async copy(src, dst) {
    if (!files.has(src)) throw new Error('ENOENT ' + src);
    files.set(dst, files.get(src));
    mt.set(dst, ++clock);
  },
  async move(src, dst) {
    files.set(dst, files.get(src));
    mt.set(dst, ++clock);
    files.delete(src);
  },
  async remove(p) { files.delete(p); dirs.delete(p); },
  async getChildren(p) {
    const pre = p.endsWith('/') ? p : p + '/';
    const out = new Set();
    for (const k of [...files.keys(), ...dirs]) {
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
  Prefs: {
    get(k, d) { return Prefs.get(k, d); },
    set(k, v) { Prefs.set(k, v); },
  },
  launchFile() {},
  launchURL() {},
};

const sandbox = {
  console, Buffer, setTimeout, clearTimeout, setInterval, clearInterval,
  Promise, Date, Math, JSON, URL, RegExp, Error, Object, Array, String, Number, Boolean,
  TextEncoder, TextDecoder,
  crypto: require('crypto').webcrypto,
  Prefs, Services, IOUtils, Zotero,
  SkillPacks: null,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

function load(file) {
  vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: path.basename(file) });
}
load(WEBDAV_JS);
load(SYNC_JS);

const W = sandbox.WebDAV;
const CS = sandbox.CloudSync;

// 测试里不需要真的等退避（保留原实现给退避断言用）
const realBackoff = W.backoff;
W.backoff = () => 0;

/* ---------------- ① 协议层 ---------------- */

{
  eq(W.normalizePath('Papilot//data/./x/../y.json'), '/Papilot/data/y.json', '路径归一：空段/./.. 折叠');
  eq(W.normalizePath('/'), '/', '路径归一：根保持 /');
  eq(W.join('/Papilot', 'data', 'a b.json'), '/Papilot/data/a b.json', 'join 保留空格');
  eq(W.encodePath('/Papilot/data/中文 名(1).json'),
    '/Papilot/data/%E4%B8%AD%E6%96%87%20%E5%90%8D%281%29.json', '路径按段编码（中文/空格/括号）');
  eq(W.basename('/a/b/c.tar.gz'), 'c.tar.gz', 'basename');
  eq(W.dirname('/a/b/c.txt'), '/a/b', 'dirname');
  eq(W.extname('a.b.xpi'), '.xpi', 'extname');
  eq(W.dirname('/x'), '/', 'dirname 顶层回落 /');
  eq(W.partName(0), '0001.part', '分片名零填充');
  eq(W.partName(41), '0042.part', '分片名零填充（两位）');
  ok(W.partsDirFor('/Papilot/p/a.bin', 'abcdef123456').endsWith('/.ppparts/a.bin.abcdef12'), '分卷目录取 hash 前 8 位', W.partsDirFor('/Papilot/p/a.bin', 'abcdef123456'));
  eq(W.manifestPathFor('/p/a.bin'), '/p/a.bin.ppmanifest.json', '清单路径');
  ok(W.isManifestName('a.bin.ppmanifest.json') && !W.isManifestName('a.bin'), '清单识别');
}

{
  const xml = `<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:">
 <D:response>
  <D:href>/dav/Papilot/data/</D:href>
  <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat>
 </D:response>
 <D:response>
  <D:href>/dav/Papilot/data/a%20b.json</D:href>
  <D:propstat><D:prop>
    <D:getcontentlength>123</D:getcontentlength>
    <D:getetag>"abc123"</D:getetag>
    <D:getlastmodified>Mon, 19 Oct 2026 02:35:46 GMT</D:getlastmodified>
  </D:prop></D:propstat>
 </D:response>
 <d:response xmlns:d="DAV:">
   <d:href>/dav/Papilot/data/&#20013;&#25991;.json</d:href>
   <d:propstat><d:prop><d:getetag>W/"weak"</d:getetag></d:prop></d:propstat>
 </d:response>
</D:multistatus>`;
  const items = W.parseMultistatus(xml);
  eq(items.length, 3, '207 解析：三种前缀都能取到 response');
  eq(items[0].isDir, true, '207 解析：collection → 目录');
  eq(items[1].size, 123, '207 解析：content-length');
  eq(items[1].etag, 'abc123', '207 解析：etag 去引号');
  eq(items[1].mtime > 0, true, '207 解析：Last-Modified 转时间戳');
  eq(items[1].name, 'a b.json', '207 解析：href 解码 + name');
  eq(items[2].etag, 'weak', '207 解析：W/ 前缀剥离 + 数字实体解码');
  eq(items[2].name, '中文.json', '207 解析：href 百分号解码');
}

{
  eq(W.statusCode(401), 'AUTH_REQUIRED', '401 → 授权');
  eq(W.statusCode(403), 'FORBIDDEN', '403 → 权限（不是过期）');
  eq(W.statusCode(404), 'NOT_FOUND', '404');
  eq(W.statusCode(412), 'CONFLICT', '412 → 冲突');
  eq(W.statusCode(413), 'TOO_LARGE', '413 → 过大');
  eq(W.statusCode(423), 'LOCKED', '423 → 锁定');
  eq(W.statusCode(429), 'RATE_LIMIT', '429 → 限流');
  eq(W.statusCode(507), 'QUOTA', '507 → 配额');
  eq(W.statusCode(0), 'NETWORK', '0 → 网络');
  eq(W.statusCode(503), 'SERVER', '5xx → 服务端');
  ok(W.retryable('NETWORK') && W.retryable('SERVER') && W.retryable('RATE_LIMIT'), '可重试码');
  ok(!W.retryable('AUTH_EXPIRED') && !W.retryable('CONFLICT') && !W.retryable('QUOTA'), '不可重试码');
  const d1 = realBackoff(1, 1000, 10000, () => 0.5);
  const d2 = realBackoff(2, 1000, 10000, () => 0.5);
  const d3 = realBackoff(5, 1000, 10000, () => 0.5);
  ok(d2 > d1 && d3 <= 10000, '退避递增且有上限', { d1, d2, d3 });
  eq(W.parseContentRange('bytes 100-199/2000').start, 100, 'Range 解析 start');
  eq(W.parseContentRange('bytes 100-199/2000').total, 2000, 'Range 解析 total');
  eq(W.parseContentRange('garbage'), null, 'Range 解析异常返回 null');
}

{
  const m = { version: 1, size: 30, parts: [{ name: '0001.part', size: 10 }, { name: '0002.part', size: 20 }] };
  eq(W.validateManifest(m).ok, true, '清单校验：正常');
  eq(W.validateManifest({ version: 2, size: 1, parts: [] }).ok, false, '清单校验：版本不符');
  eq(W.validateManifest({ version: 1, size: 99, parts: [{ name: 'a', size: 1 }] }).ok, false, '清单校验：总大小不符');
  eq(W.validateManifest({ version: 1, size: 1, parts: [] }).ok, false, '清单校验：空分片');
  eq(W.formatBytes(2048), '2.0 KB', '体积格式化');
}

/* ---------------- ② 决策矩阵 ---------------- */

const L = (size, mtime, hash) => ({ size, mtime: mtime || 1000, hash: hash || '' });
const R = (size, etag) => ({ size, etag: etag || 'e1' });
const E = (localSize, localMtime, etag, size) => ({ localSize, localMtime, etag, size: size || localSize });

{
  const cases = [
    ['本地有云端无 → 上传', { local: L(10), remote: null }, 'upload'],
    ['云端有本地无 → 下载', { local: null, remote: R(10) }, 'download'],
    ['两边都没有 → 跳过', { local: null, remote: null }, 'skip'],
    ['无基线但大小一致 → 视为已同步', { local: L(10), remote: R(10) }, 'skip'],
    ['无基线且大小不同 → 冲突', { local: L(10), remote: R(11) }, 'conflict'],
    ['仅本地改 → 上传', { local: L(11, 5000), remote: R(10, 'e1'), entry: E(10, 1000, 'e1') }, 'upload'],
    ['仅云端改 → 下载', { local: L(10, 1000), remote: R(12, 'e2'), entry: E(10, 1000, 'e1') }, 'download'],
    ['两边都改 → 冲突', { local: L(11, 5000), remote: R(12, 'e2'), entry: E(10, 1000, 'e1') }, 'conflict'],
    ['都没变 → 跳过', { local: L(10, 1000), remote: R(10, 'e1'), entry: E(10, 1000, 'e1') }, 'skip'],
    ['仅上传：云端独有 → 跳过', { local: null, remote: R(10), direction: 'up' }, 'skip'],
    ['仅下载：本地独有 → 跳过', { local: L(10), remote: null, direction: 'down' }, 'skip'],
    ['仅下载：云端改了 → 下载', { local: L(10, 1000), remote: R(12, 'e2'), entry: E(10, 1000, 'e1'), direction: 'down' }, 'download'],
    ['哈希一致但 mtime 变了 → 仍算未改（设置快照）',
      { local: L(10, 999999, 'h1'), remote: R(10, 'e1'), entry: { localSize: 10, localMtime: 1000, etag: 'e1', size: 10, hash: 'h1' } }, 'skip'],
    ['哈希不同但 size 相同 → 上传（设置快照真实改动）',
      { local: L(10, 1000, 'h2'), remote: R(10, 'e1'), entry: { localSize: 10, localMtime: 1000, etag: 'e1', size: 10, hash: 'h1' } }, 'upload'],
  ];
  for (const [label, input, want] of cases) {
    eq(CS.decideAction(input).action, want, '决策：' + label);
  }
  eq(CS.conflictName('a.json', new Date(2026, 9, 19, 10, 30, 0)), 'a (冲突 本机 20261019-103000).json', '冲突命名：保留扩展名');
  eq(CS.conflictRel('sub/a.json'), 'sub/a (冲突 本机 ' + CS.conflictName('x', new Date()).match(/\d{8}-\d{6}/)[0] + ').json',
    '冲突命名：保留子目录');
}

/* ---------------- ③ 安全边界 ---------------- */

{
  ok(CS.shouldSyncPref('aiSystemPrompt'), '白名单：普通设置可同步');
  ok(!CS.shouldSyncPref('cloudSyncToken'), '排除：同步自身的 token');
  ok(!CS.shouldSyncPref('cloudSyncRoot'), '排除：同步自身配置');
  ok(!CS.shouldSyncPref('aiApiKey'), '排除：aiApiKey');
  ok(!CS.shouldSyncPref('aiChannels'), '排除：aiChannels（内含密钥）');
  ok(!CS.shouldSyncPref('cnkiPassword'), '排除：cnkiPassword');
  ok(!CS.shouldSyncPref('easyScholarKey'), '排除：easyScholarKey');
  ok(!CS.shouldSyncPref('mcpToken'), '排除：mcpToken');
  ok(!CS.shouldSyncPref('thirdSourcePassword'), '排除：thirdSourcePassword');
  ok(!CS.shouldSyncPref('s2ApiKey'), '排除：s2ApiKey');
  ok(!CS.shouldSyncPref('openAlexApiKey'),
    '★ 排除：openAlexApiKey（0.58.0 免费 Key，属密钥；SECRET_LEAF_RE 的 apikey 分支命中）');
  ok(CS.shouldSyncPref('aiMaxTokens'), '不误伤：aiMaxTokens 不是密钥');
  // 检索订阅的本机运行态：跨机同步会制造幽灵行为（A 机的推荐 / 记账灌给 B 机）
  ok(!CS.shouldSyncPref('searchSubsRecoCache'),
    '★ 排除：推荐缓存（本机图书馆画像，且 at 每 12h 变化会让快照乒乓）');
  ok(!CS.shouldSyncPref('searchSubsSeen'),
    '★ 排除：投递记账（跨机后 B 机会把 A 机见过的论文当往期已见而静默不推送）');
  ok(CS.shouldSyncPref('searchSubscriptions'),
    '不误伤：订阅本体（纯配置）仍随云端同步');
}

{
  prefStore.clear(); prefTypes.clear();
  Prefs.set('aiSystemPrompt', '请严谨');
  Prefs.set('aiChannels', '{"channels":[{"apiKey":"sk-secret"}]}');
  Prefs.set('cnkiPassword', 'p@ss');
  Prefs.set('mcpToken', 'tok');
  Prefs.set('readingProgress', '{}');
  Prefs.set('cloudSyncToken', 'app-pass');
  Prefs.set('searchSubscriptions', '[{"id":"sub-1"}]');
  Prefs.set('searchSubsRecoCache', '{"at":1,"items":[{"id":"x"}]}');
  Prefs.set('searchSubsSeen', '{"arXiv:2501.00001":{"at":1}}');

  const s1 = CS.snapshotPrefs();
  const s2 = CS.snapshotPrefs();
  ok(!('aiChannels' in s1.prefs), '快照不含 aiChannels');
  ok(!('cnkiPassword' in s1.prefs), '快照不含 cnkiPassword');
  ok(!('mcpToken' in s1.prefs), '快照不含 mcpToken');
  ok(!('cloudSyncToken' in s1.prefs), '快照不含同步自身凭据');
  ok('aiSystemPrompt' in s1.prefs && s1.prefs.aiSystemPrompt === '请严谨', '快照含普通设置');
  ok(!('searchSubsRecoCache' in s1.prefs), '★ 快照不含推荐缓存（纯本机，且会引发乒乓）');
  ok(!('searchSubsSeen' in s1.prefs), '★ 快照不含投递记账（跨机会静默不推送）');
  ok('searchSubscriptions' in s1.prefs, '快照仍含订阅本体（配置要跟人走）');
  eq(JSON.stringify(s1), JSON.stringify(s2), '快照内容稳定（两次导出完全一致，避免每轮乒乓）');
  ok(!('exportedAt' in s1), '快照不带时间戳字段');

  // 应用侧白名单
  const n = CS.applySnapshot({
    prefs: {
      aiSystemPrompt: '新提示', cnkiPassword: 'hack', cloudSyncRoot: '/evil',
      searchSubsRecoCache: '{"at":2,"items":[]}', searchSubsSeen: '{"arXiv:1":{"at":2}}',
    },
  });
  eq(n, 1, '应用快照只写允许的键');
  eq(Prefs.get('aiSystemPrompt'), '新提示', '应用快照：普通键生效');
  eq(Prefs.get('cnkiPassword'), 'p@ss', '应用快照：密钥键被忽略');
  eq(Prefs.get('cloudSyncRoot', '/Papilot'), '/Papilot', '应用快照：同步自身配置被忽略');
  eq(Prefs.get('searchSubsRecoCache'), '{"at":1,"items":[{"id":"x"}]}', '★ 应用快照：推荐缓存不被覆盖');
  eq(Prefs.get('searchSubsSeen'), '{"arXiv:2501.00001":{"at":1}}', '★ 应用快照：投递记账不被覆盖');
}

/* ---------------- ④ 行为 ---------------- */

function fakeClient(overrides) {
  const calls = [];
  const store = new Map();
  const client = {
    calls, store,
    async ensureDir(p) { calls.push(['mkcol', p]); return true; },
    async propfind() { return []; },
    async stat(p) { return store.get(p) || null; },
    async put(p, body) {
      const size = body && body.byteLength !== undefined ? body.byteLength : 0;
      calls.push(['put', p, size]);
      const etag = 'etag-' + calls.length;
      store.set(p, { size, etag });
      return { status: 201, etag, size };
    },
    async getBuffer() { return { status: 200, body: new ArrayBuffer(0), headers: {} }; },
    async del(p) { calls.push(['del', p]); return true; },
  };
  Object.assign(client, overrides || {});
  return client;
}

/* ---------------- 内存 WebDAV 服务器（端到端用） ---------------- */

/**
 * 极简服务端：只实现本引擎用到的 PROPFIND/MKCOL/PUT/GET/DELETE 语义。
 * 放在 transport 层（而不是 client 层），这样 syncNow 的整条链路都被覆盖：
 * URL 编码、207 解析、etag 条件写、目录递归、索引落盘。
 */
function makeFakeDav() {
  const srvFiles = new Map();   // path → { bytes, etag, mtime }
  const srvDirs = new Set(['/dav']);
  let seq = 0;

  const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const enc = (x) => x.split('/').map((seg) => encodeURIComponent(seg)).join('/');

  function entryXml(p) {
    const isDir = srvDirs.has(p);
    const f = srvFiles.get(p);
    return '<D:response><D:href>' + esc(enc(p)) + '</D:href><D:propstat><D:prop>' +
      '<D:resourcetype>' + (isDir ? '<D:collection/>' : '') + '</D:resourcetype>' +
      (isDir ? '' : '<D:getcontentlength>' + f.bytes.byteLength + '</D:getcontentlength>' +
        '<D:getetag>"' + f.etag + '"</D:getetag>' +
        '<D:getlastmodified>' + new Date(f.mtime).toUTCString() + '</D:getlastmodified>') +
      '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>';
  }

  function children(dir) {
    const out = [];
    for (const p of srvDirs) {
      if (p !== dir && p.startsWith(dir + '/') && p.slice(dir.length + 1).indexOf('/') < 0) out.push(p);
    }
    for (const p of srvFiles.keys()) {
      if (p.startsWith(dir + '/') && p.slice(dir.length + 1).indexOf('/') < 0) out.push(p);
    }
    return out;
  }

  const transport = async function (o) {
    const u = new URL(o.url);
    let path = decodeURIComponent(u.pathname);
    if (path.length > 1) path = path.replace(/\/+$/, '');
    const method = o.method.toUpperCase();
    const h = {};
    for (const k of Object.keys(o.headers || {})) h[k.toLowerCase()] = o.headers[k];

    if (method === 'PROPFIND') {
      const isFile = srvFiles.has(path);
      if (!isFile && !srvDirs.has(path)) return { status: 404, headers: {}, body: null, text: '' };
      const depth = String(h.depth || '0');
      const parts = [entryXml(path)];
      if (!isFile && depth !== '0') for (const c of children(path)) parts.push(entryXml(c));
      const xml = '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">' + parts.join('') + '</D:multistatus>';
      return { status: 207, headers: { 'content-type': 'application/xml' }, body: xml, text: xml };
    }

    if (method === 'MKCOL') {
      if (srvDirs.has(path) || srvFiles.has(path)) return { status: 405, headers: {}, body: null, text: '' };
      const parent = path.slice(0, path.lastIndexOf('/')) || '/';
      if (!srvDirs.has(parent)) return { status: 409, headers: {}, body: null, text: '' };
      srvDirs.add(path);
      return { status: 201, headers: {}, body: null, text: '' };
    }

    if (method === 'PUT') {
      const parent = path.slice(0, path.lastIndexOf('/')) || '/';
      if (!srvDirs.has(parent)) return { status: 409, headers: {}, body: null, text: '' };
      const cur = srvFiles.get(path);
      if (h['if-match']) {
        const want = h['if-match'].replace(/^"|"$/g, '');
        if (!cur || cur.etag !== want) return { status: 412, headers: {}, body: null, text: '' };
      }
      if (h['if-none-match'] === '*' && cur) return { status: 412, headers: {}, body: null, text: '' };
      const bytes = new Uint8Array(o.body || new ArrayBuffer(0));
      const etag = 'e' + (++seq);
      srvFiles.set(path, { bytes, etag, mtime: Date.now() });
      return { status: cur ? 204 : 201, headers: { etag: '"' + etag + '"' }, body: null, text: '' };
    }

    if (method === 'GET') {
      const f = srvFiles.get(path);
      if (!f) return { status: 404, headers: {}, body: null, text: '' };
      return {
        status: 200,
        headers: { etag: '"' + f.etag + '"', 'content-length': String(f.bytes.byteLength) },
        body: f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.byteLength),
        text: '',
      };
    }

    if (method === 'DELETE') {
      if (srvFiles.delete(path)) return { status: 204, headers: {}, body: null, text: '' };
      if (srvDirs.delete(path)) return { status: 204, headers: {}, body: null, text: '' };
      return { status: 404, headers: {}, body: null, text: '' };
    }

    return { status: 405, headers: {}, body: null, text: '' };
  };

  return { transport, files: srvFiles, dirs: srvDirs };
}

const CFG = {
  email: 'u@example.com', token: 'app-pass', baseUrl: W.DEFAULT_BASE, root: '/Papilot',
  policy: 'keepBoth', direction: 'both', datasets: 'settings,chatSessions,packages',
  autoMinutes: 0, maxFileMB: 512, largeFileMB: 64, partMB: 32, timeoutSec: 40,
  deviceId: 'dev-test', lastSyncAt: 0,
};

(async function run() {
  // 登录参数校验（不发请求）
  for (const [label, input, code] of [
    ['空账号', { email: '', token: 'x' }, 'CONFIG'],
    ['空密码', { email: 'a@b.c', token: '' }, 'AUTH_REQUIRED'],
  ]) {
    let got = '';
    try { await CS.login(input); } catch (e) { got = e.code; }
    eq(got, code, '登录校验：' + label);
  }

  // 401 / 403 / 507 分类（客户端层）
  const mk = (status, username) => W.createClient({
    baseUrl: W.DEFAULT_BASE,
    username: username === undefined ? 'u@example.com' : username,
    password: 'p',
    transport: async () => ({ status, headers: {}, body: null, text: '' }),
  });
  for (const [status, code, label] of [
    [401, 'AUTH_EXPIRED', '客户端：带凭据的 401 → 应用密码失效'],
    [403, 'FORBIDDEN', '客户端：403 → 权限问题（不是过期）'],
    [507, 'QUOTA', '客户端：507 → 空间不足'],
    [429, 'RATE_LIMIT', '客户端：429 → 限流'],
    [503, 'SERVER', '客户端：503 → 服务端'],
  ]) {
    let got = '';
    try { await mk(status).propfind('/Papilot', 0); } catch (e) { got = e.code; }
    eq(got, code, label);
  }
  {
    let got = '';
    try { await mk(401, '').propfind('/Papilot', 0); } catch (e) { got = e.code; }
    eq(got, 'AUTH_REQUIRED', '客户端：未填凭据的 401 → 需要授权');
  }
  {
    let e503 = null;
    const client = W.createClient({
      baseUrl: W.DEFAULT_BASE, username: 'u', password: 'p', minIntervalMs: 0,
      transport: async () => ({
        status: 503, headers: {},
        body: '<d:error><s:exception>BlockedTemporarily</s:exception><s:message>Too many requests are received recently</s:message></d:error>',
        text: '<d:error><s:exception>BlockedTemporarily</s:exception></d:error>',
      }),
    });
    try { await client.propfind('/Papilot', 0); } catch (e) { e503 = e; }
    eq(e503 && e503.code, 'RATE_LIMIT', '客户端：503 BlockedTemporarily → 限流（不是服务端故障）');
    ok(e503 && e503.retryAfterMs >= 60000, '客户端：限流带长等待提示（不短退避硬撞）', e503 && e503.retryAfterMs);
  }
  {
    let got = '';
    const client = W.createClient({
      baseUrl: W.DEFAULT_BASE, username: 'u', password: 'p', minIntervalMs: 0,
      transport: async () => ({ status: 412, headers: {}, body: null, text: '' }),
    });
    try { await client.put('/Papilot/a.json', new Uint8Array([1])); } catch (e) { got = e.code; }
    eq(got, 'CONFLICT', '客户端：PUT 412 → 冲突');
  }

  // 重试：网络类重试后成功；授权类不重试
  {
    let n = 0;
    const out = await CS._withRetry(async () => {
      n++;
      if (n < 3) throw W.syncError('NETWORK', 'boom');
      return 'ok';
    }, 'test');
    eq(out, 'ok', '重试：网络错误第 3 次成功');
    eq(n, 3, '重试：共调用 3 次');

    let m = 0;
    let code = '';
    try {
      await CS._withRetry(async () => { m++; throw W.syncError('AUTH_EXPIRED', 'bad'); }, 'test');
    } catch (e) { code = e.code; }
    eq(m, 1, '重试：授权错误不重试');
    eq(code, 'AUTH_EXPIRED', '重试：授权错误原样抛出');
  }

  // 分卷上传：首轮 4 片；次轮同尺寸分片全部跳过，只重写清单
  {
    const client = fakeClient();
    const bytes = new Uint8Array(10 * 1024 * 1024 + 123);   // 10MB+ → partMB=4 → 3 片
    const cfg = Object.assign({}, CFG, { partMB: 4 });
    const r1 = await CS._uploadParts(client, cfg, '/Papilot/packages/big.xpi', bytes, {}, 'packages');
    eq(r1.parts, 3, '分卷：10MB+ 按 4MB 切成 3 片');
    const partPuts = client.calls.filter((c) => c[0] === 'put' && /\.part$/.test(c[1]));
    eq(partPuts.length, 3, '分卷：首轮上传 3 个分片');
    const manifestPut = client.calls.filter((c) => c[0] === 'put' && /\.ppmanifest\.json$/.test(c[1]));
    eq(manifestPut.length, 1, '分卷：写 1 份清单');

    const manifest = JSON.parse(Buffer.from(
      // fakeClient 只存了大小，这里直接校验内存里的清单结构
      JSON.stringify(r1.manifest)
    ).toString());
    eq(W.validateManifest(manifest).ok, true, '分卷：清单自校验通过');
    eq(manifest.parts.length, 3, '分卷：清单含 3 片');

    client.calls.length = 0;
    const r2 = await CS._uploadParts(client, cfg, '/Papilot/packages/big.xpi', bytes, {}, 'packages');
    eq(r2.parts, 3, '分卷幂等：第二轮片数一致');
    eq(client.calls.filter((c) => c[0] === 'put' && /\.part$/.test(c[1])).length, 0,
      '分卷幂等：已存在且同尺寸的分片不再上传');
    eq(client.calls.filter((c) => c[0] === 'put' && /\.ppmanifest\.json$/.test(c[1])).length, 1,
      '分卷幂等：清单仍会重写');
  }

  // 上传单文件：超限直接报 TOO_LARGE，不发请求
  {
    const client = fakeClient();
    let code = '';
    try {
      await CS._uploadOne(client, Object.assign({}, CFG, { maxFileMB: 1 }), { key: 'x', kind: 'file', remoteDir: 'data' }, {
        rel: 'a.bin', local: { data: new Uint8Array(2 * 1024 * 1024), size: 2 * 1024 * 1024, mtime: 1 }, remote: null, entry: null,
      });
    } catch (e) { code = e.code; }
    eq(code, 'TOO_LARGE', '上传：超过上限 → TOO_LARGE');
    eq(client.calls.filter((c) => c[0] === 'put').length, 0, '上传：超限时不发网络请求');
  }

  // 上传单文件：正常路径返回 entry
  {
    const client = fakeClient();
    const out = await CS._uploadOne(client, CFG, { key: 'x', kind: 'file', remoteDir: 'data' }, {
      rel: 'a.json', local: { data: new Uint8Array([1, 2, 3]), size: 3, mtime: 1 }, remote: null, entry: null,
    });
    eq(!!out.entry.etag, true, '上传：成功记录 etag');
    eq(out.entry.size, 3, '上传：记录大小');
    eq(out.entry.localSize, 3, '上传：记录本地基线');
  }

  // 下载设置快照：只应用白名单键
  {
    prefStore.clear(); prefTypes.clear();
    Prefs.set('aiSystemPrompt', '本机');
    const payload = JSON.stringify({ version: 1, prefs: { aiSystemPrompt: '云端', cnkiPassword: 'leak' } });
    const client = fakeClient({
      async getBuffer() {
        return { status: 200, body: new Uint8Array(Buffer.from(payload, 'utf8')).buffer, headers: {} };
      },
    });
    const ds = CS.datasetOf('settings');
    const payloadBytes = Buffer.byteLength(payload, 'utf8');
    const out = await CS._downloadOne(client, CFG, ds, { rel: 'settings.json', local: { size: 10, mtime: 1 }, remote: { size: payloadBytes, etag: 'e9' }, entry: null });
    eq(Prefs.get('aiSystemPrompt'), '云端', '下载快照：普通键已应用');
    eq(Prefs.get('cnkiPassword', 'untouched'), 'untouched', '下载快照：密钥键未写入');
    ok(out.entry.etag === 'e9', '下载快照：记录云端 etag');
  }

  // 数据集注册表
  {
    eq(CS._selectDatasets(['settings']).length, 1, '数据集：按 key 选择');
    eq(CS._selectDatasets(['settings', 'chatSessions', 'packages']).length, 3, '数据集：全选');
    let threw = false;
    try { CS.registerDataset({ key: 'x' }); } catch (e) { threw = true; }
    ok(threw, '数据集：缺 kind 拒绝注册');
    const ds = CS.registerDataset({ key: 'extra', name: '额外', kind: 'file', remoteDir: 'data', localName: 'x.json', fileName: 'x.json' });
    ok(!!CS.datasetOf('extra'), '数据集：运行期可扩展');
    ok(CS._selectDatasets(['extra']).length === 1, '数据集：新数据集可被选中');
    CS.DATASETS.splice(CS.DATASETS.indexOf(ds), 1);
  }

  // 状态与日志
  {
    const seen = [];
    const off = CS.on((ev) => seen.push(ev.type));
    CS._setState({ message: '测试状态' });
    CS._log('info', 'hello');
    eq(CS.status().message, '测试状态', '状态：可读回');
    ok(seen.indexOf('state') >= 0 && seen.indexOf('log') >= 0, '事件：state/log 都派发');
    off();
    const n = seen.length;
    CS._setState({ message: 'after off' });
    eq(seen.length, n, '事件：退订后不再收到');
  }

  // ---------- ④b 批次 1：快照分层 / 索引指纹 / 扫描预算 / 分卷清理 ----------
  {
    // 快照分层：缓存、机器路径、大型数据集一律不出现；普通设置照常
    prefStore.clear(); prefTypes.clear();
    Prefs.set('aiSystemPrompt', '保留我');
    Prefs.set('readingProgress', '{"items":{}}');
    Prefs.set('readingStats', '{}');
    Prefs.set('uiWallpaperPath', 'C:\Users\a\wall.jpg');
    Prefs.set('cnDownloadDir', 'D:\Downloads');
    Prefs.set('rankDataSets', 'x'.repeat(2000));
    Prefs.set('autoTagCacheData', '{}');
    Prefs.set('searchSubsSeen', '{}');
    Prefs.set('installId', 'abc');

    const snap = CS.snapshotPrefs();
    ok('aiSystemPrompt' in snap.prefs, '批次1：普通设置进快照');
    ok(!('readingProgress' in snap.prefs), '批次1：阅读进度（本机数据）不进快照');
    ok(!('readingStats' in snap.prefs), '批次1：阅读统计不进快照');
    ok(!('uiWallpaperPath' in snap.prefs), '批次1：壁纸绝对路径不进快照（防跨机污染）');
    ok(!('cnDownloadDir' in snap.prefs), '批次1：下载目录绝对路径不进快照');
    ok(!('rankDataSets' in snap.prefs), '批次1：大型分区数据不进快照');
    ok(!('autoTagCacheData' in snap.prefs), '批次1：打标缓存不进快照');
    ok(!('searchSubsSeen' in snap.prefs), '批次1：订阅 seen 不进快照');
    ok(!('installId' in snap.prefs), '批次1：设备标识不进快照');
  }

  {
    // 快照体积上限：超限抛 TOO_LARGE，并指出最大键（不静默截断）
    prefStore.clear(); prefTypes.clear();
    Prefs.set('cloudSyncSnapshotMaxKB', 1);
    Prefs.set('aiSystemPrompt', 'x'.repeat(100 * 1024));
    let code = '';
    let msg = '';
    try { await CS._buildSnapshot(); } catch (e) { code = e.code; msg = e.message; }
    eq(code, 'TOO_LARGE', '批次1：快照超限 → TOO_LARGE');
    ok(/aiSystemPrompt/.test(msg), '批次1：超限信息指出最大的键', msg.slice(0, 80));
    Prefs.set('cloudSyncSnapshotMaxKB', 1024);
  }

  {
    // 索引按账号+根目录隔离
    prefStore.clear(); prefTypes.clear();
    Prefs.set('cloudSyncEmail', 'a@example.com');
    Prefs.set('cloudSyncRoot', '/Papilot');
    const p1 = CS._indexPath();
    Prefs.set('cloudSyncEmail', 'b@example.com');
    const p2 = CS._indexPath();
    Prefs.set('cloudSyncRoot', '/Other');
    const p3 = CS._indexPath();
    ok(/index-[0-9a-f]{8}\.json$/.test(p1), '批次1：索引文件名带账号指纹', p1);
    ok(p1 !== p2, '批次1：换账号 → 换索引');
    ok(p2 !== p3, '批次1：改同步根 → 换索引');
    Prefs.set('cloudSyncEmail', 'a@example.com');
    Prefs.set('cloudSyncRoot', '/Papilot');
    eq(CS._indexPath(), p1, '批次1：索引指纹稳定可复现');
  }

  {
    // 扫描预算：maxFiles=1 时第 2 个文件被截断，并标记 truncated（调用方据此整集跳过）
    prefStore.clear(); prefTypes.clear();
    files.clear(); mt.clear(); dirs.clear();
    await IOUtils.writeUTF8('/data/papilot-cloud/packages/a.json', '{"a":1}');
    await IOUtils.writeUTF8('/data/papilot-cloud/packages/b.json', '{"b":2}');
    const ds = CS.datasetOf('packages');
    const budget = { maxFiles: 1, maxDepth: 6, count: 0, truncated: 0, deep: 0 };
    const local = await CS._scanLocal(ds, budget);
    eq(Object.keys(local).length, 1, '批次1：预算内只收 1 个文件');
    ok(budget.truncated >= 1, '批次1：超出预算被标记（调用方整数据集跳过）', budget);
  }

  {
    // 分卷清理：先删分片文件再删目录；只处理同 basename 的其它 hash 目录
    const deleted = [];
    const tree = {};
    const D = '/Papilot/packages/.ppparts';
    tree[D] = [
      { path: D + '/big.xpi.aaaa1111', name: 'big.xpi.aaaa1111', isDir: true },
      { path: D + '/big.xpi.bbbb2222', name: 'big.xpi.bbbb2222', isDir: true },
      { path: D + '/other.xpi.cccc3333', name: 'other.xpi.cccc3333', isDir: true },
    ];
    tree[D + '/big.xpi.aaaa1111'] = [
      { path: D + '/big.xpi.aaaa1111/0001.part', name: '0001.part', isDir: false },
      { path: D + '/big.xpi.aaaa1111/0002.part', name: '0002.part', isDir: false },
    ];
    const client = {
      async propfind(p) { return tree[p] || []; },
      async del(p) { deleted.push(p); return true; },
    };
    const n = await CS._cleanupOldParts(client, '/Papilot/packages/big.xpi', D + '/big.xpi.bbbb2222');
    ok(n >= 3, '批次1：旧分卷的分片与目录都被清理', { n, deleted });
    ok(deleted.some((x) => x === D + '/big.xpi.aaaa1111/0001.part'), '批次1：先删分片文件', deleted);
    ok(deleted.some((x) => x === D + '/big.xpi.aaaa1111'), '批次1：再删分卷目录', deleted);
    ok(deleted.every((x) => x.indexOf('other.xpi') < 0), '批次1：不误删其它文件的旧分卷');
    ok(deleted.every((x) => x.indexOf('big.xpi.bbbb2222') < 0), '批次1：保留本次写入的分卷目录');
  }

  {
    // 分卷组装上限：独立于单文件上限，超限直接拒绝（避免内存爆掉）
    const cfg = Object.assign({}, CFG, { assembleMaxMB: 8, maxFileMB: 512 });
    const manifest = { version: 1, size: 9 * 1024 * 1024, parts: [{ name: '0001.part', size: 9 * 1024 * 1024 }], sha256: '' };
    let code = '';
    try {
      await CS._downloadParts(fakeClient(), cfg, '/Papilot/packages/big.xpi', { parts: true, manifest: manifest });
    } catch (e) { code = e.code; }
    eq(code, 'TOO_LARGE', '批次1：超过组装上限 → TOO_LARGE（不硬分配内存）');
  }

  {
    // 本地路径：绝不能复用 WebDAV.join（Windows 上会得到 /C:/...，索引/备份全写不出来）
    const bs = String.fromCharCode(92);
    const winRoot = "C:" + bs + "Users" + bs + "a" + bs + "Zotero";
    eq(CS._localJoin(winRoot, "papilot-cloud"), "C:/Users/a/Zotero/papilot-cloud",
      "批次1：本地路径拼接保留盘符、不产生前导斜杠");
    eq(CS._localJoin("/data", "papilot-cloud", "index-1.json"), "/data/papilot-cloud/index-1.json",
      "批次1：POSIX 本地路径照常拼接");
    eq(CS._localParent("C:/Users/a/Zotero"), "C:/Users/a", "批次1：本地父目录（Windows）");
    eq(CS._localParent("/data/papilot-cloud"), "/data", "批次1：本地父目录（POSIX）");
    ok(CS._localJoin(winRoot, "x").charAt(0) === "C", "批次1：Windows 本地路径不以 / 开头");
  }

  // ---------- ④c 批次 2：墓碑 / 三向合并 / 文件名 ----------
  {
    // 三向合并：各改各的都要保住；同一键两边改 → 本机优先并记冲突
    const base = { a: 1, b: 'x', c: true };
    const local = { a: 2, b: 'x', c: false };          // 本机改 a、c
    const remote = { a: 1, b: 'y', c: true, d: 'new' }; // 云端改 b、新增 d
    const m = CS.mergeSnapshots(base, local, remote);
    eq(m.merged.a, 2, '批次2：仅本机改的键保留本机值');
    eq(m.merged.b, 'y', '批次2：仅云端改的键采用云端值');
    eq(m.merged.c, false, '批次2：本机改的布尔键保留');
    eq(m.merged.d, 'new', '批次2：云端新增键被合并');
    eq(m.conflicts.length, 0, '批次2：不同键各改各的 → 无冲突');
    ok(m.fromRemote.indexOf('b') >= 0, '批次2：记录来自云端的键', m.fromRemote);

    const m2 = CS.mergeSnapshots({ a: 1 }, { a: 2 }, { a: 3 });
    eq(m2.merged.a, 2, '批次2：同键两边都改 → 本机优先');
    eq(m2.conflicts.join(','), 'a', '批次2：同键冲突被记录');

    const m3 = CS.mergeSnapshots({ a: 1, b: 2 }, { a: 2 }, { a: 2, b: 2, c: 3 });
    eq(m3.merged.a, 2, '批次2：两边改成同一个值 → 不算冲突');
    eq(m3.conflicts.length, 0, '批次2：同值不记冲突');
    eq(m3.merged.c, 3, '批次2：云端新增键仍被采纳');
  }

  {
    // 墓碑：本地缺失 + 云端仍在 → 记录墓碑；大批缺失 → 整批跳过
    prefStore.clear(); prefTypes.clear();
    files.clear(); mt.clear(); dirs.clear();
    const ds = CS.datasetOf('packages');
    const index = { version: 1, entries: {}, snapshots: {} };
    index.entries['packages::installers/gone.xpi'] = { syncedAt: Date.now(), localSize: 10, size: 10 };
    index.entries['packages::installers/keep.xpi'] = { syncedAt: Date.now(), localSize: 10, size: 10 };
    const local = { 'installers/keep.xpi': { size: 10, mtime: Date.now() } };
    const remote = { 'installers/gone.xpi': { size: 10, mtime: Date.now() }, 'installers/keep.xpi': { size: 10, mtime: Date.now() } };
    const result = { warnings: [] };
    const tombs = await CS._collectLocalDeletions(ds, index, local, remote, result);
    ok(!!tombs['packages::installers/gone.xpi'], '批次2：本地删除被记成墓碑');
    ok(!tombs['packages::installers/keep.xpi'], '批次2：未删除的文件不记墓碑');
    ok(!index.entries['packages::installers/gone.xpi'], '批次2：墓碑同时清掉索引条目');
    eq(result.warnings.length, 0, '批次2：少量删除不触发大批删除保护');

    // 大批缺失保护
    const idx2 = { version: 1, entries: {}, snapshots: {} };
    for (let i = 0; i < 25; i++) idx2.entries['packages::bulk/f' + i + '.xpi'] = { syncedAt: Date.now() };
    const r2 = { warnings: [] };
    const t2 = await CS._collectLocalDeletions(ds, idx2, {}, {}, r2);
    eq(Object.keys(t2).filter((k) => k.indexOf('packages::bulk/') === 0).length, 0,
      '批次2：大批缺失不写墓碑（防目录不可用误删）');
    ok(r2.warnings.some((w) => w.code === 'MASS_DELETE'), '批次2：大批缺失给出告警');
  }

  {
    // 应用墓碑：云端文件早于删除 → 删除云端；云端在删除后又改过 → 保留
    const client = { deleted: [], async del(p) { this.deleted.push(p); return true; } };
    const ds = CS.datasetOf('packages');
    const idx = { entries: { 'packages::a.xpi': {} } };
    const stat = { deleted: 0 };
    const result = { deleted: 0 };
    const old = Date.now() - 3600 * 1000;
    const handled = await CS._applyTombstone(client, { root: '/Papilot' }, ds, {
      rel: 'a.xpi', local: null, remote: { size: 10, mtime: old },
      tomb: { at: Date.now() }, idxKey: 'packages::a.xpi', index: idx, stat, result,
    });
    eq(handled, true, '批次2：墓碑命中 → 已处理');
    eq(client.deleted.length, 1, '批次2：云端旧文件被删除');
    eq(result.deleted, 1, '批次2：结果计数删除 1');

    const client2 = { deleted: [], async del(p) { this.deleted.push(p); return true; } };
    const r3 = { deleted: 0 };
    const handled2 = await CS._applyTombstone(client2, { root: '/Papilot' }, ds, {
      rel: 'b.xpi', local: null, remote: { size: 10, mtime: Date.now() },
      tomb: { at: old }, idxKey: 'packages::b.xpi', index: { entries: {} }, stat: { deleted: 0 }, result: r3,
    });
    eq(handled2, false, '批次2：删除后云端又改过 → 不删，交回常规决策');
    eq(client2.deleted.length, 0, '批次2：不误删后改的文件');
  }

  {
    // 文件名清理
    eq(CS.sanitizeName('a:b?.xpi'), 'a_b_.xpi', '批次2：Windows 非法字符替换');
    eq(CS.sanitizeName('CON'), '_CON', '批次2：保留名加前缀');
    eq(CS.sanitizeName('name. '), 'name', '批次2：去掉末尾点/空格');
    eq(CS.sanitizeName('正常 文件.pdf'), '正常 文件.pdf', '批次2：正常文件名不变');
  }

  {
    // 冲突留档列表
    files.clear(); mt.clear(); dirs.clear();
    await IOUtils.writeUTF8('/data/papilot-cloud/conflicts/packages/a (冲突 本机 20261019-103000).xpi', 'x');
    const list = await CS.listConflicts();
    ok(list.length >= 1, '批次2：能列出冲突留档', list);
    ok(/冲突/.test(list[0].rel), '批次2：冲突文件名可读', list[0] && list[0].rel);
  }

  // ---------- ⑤ 端到端：transport 层模拟真实服务端，跑完整 syncNow ----------
  {
    prefStore.clear(); prefTypes.clear();
    files.clear(); mt.clear(); dirs.clear();
    Prefs.set('aiSystemPrompt', '端到端');
    Prefs.set('cloudSyncEmail', 'u@example.com');
    Prefs.set('cloudSyncToken', 'app-pass');
    Prefs.set('cloudSyncDatasets', 'settings,chatSessions,packages');
    Prefs.set('cloudSyncConflictPolicy', 'keepBoth');
    Prefs.set('cloudSyncAutoMinutes', 0);
    CS._retries = 0;
    CS._minIntervalMs = 0;

    await IOUtils.writeUTF8('/data/papilot-chat-sessions.json', JSON.stringify({ sessions: [] }));
    await IOUtils.writeUTF8('/data/papilot-cloud/packages/installers/demo.json', '{"a":1}');

    const dav = makeFakeDav();
    CS._transport = dav.transport;
    CS._client = null;

    const r1 = await CS.syncNow();
    ok(r1.ok, '端到端：首轮同步成功', r1.error);
    ok(dav.files.has('/dav/Papilot/data/settings.json'), '端到端：设置快照已上传');
    ok(dav.files.has('/dav/Papilot/data/papilot-chat-sessions.json'), '端到端：对话记录已上传');
    ok(dav.files.has('/dav/Papilot/packages/installers/demo.json'), '端到端：安装包已上传');
    ok([...dav.files.keys()].some((k) => k.indexOf('/dav/Papilot/devices/') === 0), '端到端：设备心跳已写');
    eq(r1.failed, 0, '端到端：首轮无失败', r1.errors);

    const r2 = await CS.syncNow();
    eq(r2.uploaded, 0, '端到端：第二轮 0 上传');
    eq(r2.downloaded, 0, '端到端：第二轮 0 下载');
    ok(r2.skipped >= 3, '端到端：第二轮全部跳过', r2.skipped);

    Prefs.set('aiSystemPrompt', '改过了');
    const r3 = await CS.syncNow();
    eq(r3.uploaded, 1, '端到端：改设置只上传 1 个文件');
    eq(r3.downloaded, 0, '端到端：改设置不下载');

    // 冲突：本机与云端同时改同一个安装包
    await IOUtils.writeUTF8('/data/papilot-cloud/packages/installers/demo.json', '{"a":2,"local":true}');
    dav.files.set('/dav/Papilot/packages/installers/demo.json', {
      bytes: new TextEncoder().encode('{"a":3,"remote":true}'),
      etag: 'remote9',
      mtime: Date.now(),
    });
    const r4 = await CS.syncNow();
    eq(r4.conflicts, 1, '端到端：两边都改 → 1 个冲突', { conflicts: r4.conflicts, errors: r4.errors });
    ok([...dav.files.keys()].some((k) => /冲突 本机/.test(k)), '端到端：冲突副本已上传到云端',
      [...dav.files.keys()].filter((k) => /installers/.test(k)));
    const localNow = await IOUtils.readUTF8('/data/papilot-cloud/packages/installers/demo.json');
    ok(localNow.indexOf('remote') >= 0, '端到端：原名文件已替换为云端版本', localNow);
  }

  console.log('cloud-sync: %d 通过 / %d 失败', pass, fails.length);
  if (fails.length) {
    for (const f of fails) console.log('  ✗ ' + f);
    process.exit(1);
  }
})().catch((e) => {
  console.log('cloud-sync: 运行异常 ' + (e && e.stack || e));
  process.exit(1);
});
