// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 核心 · WebDAV 协议层（坚果云云同步 0.56.0）
 *
 * 只做协议，不含业务：路径编码 / PROPFIND 解析 / 条件 PUT / GET（含 Range）/
 * MKCOL / 状态码归因 / 重试退避 / 分卷清单校验 / SHA-256。
 * 业务侧（数据集、索引、冲突策略）在 features/cloud-sync.js。
 *
 * 为什么自建这层而不直接用 Zotero 的 WebDAV controller：
 *   1. Zotero 的 storage controller 只服务"条目附件"，我们要同步设置、技能包、
 *      任意安装包，不在它的数据模型里；
 *   2. 需要逐文件进度、错误分类、断点续传、分卷，这些 controller 都不暴露；
 *   3. 参考插件（nutstore/zotero-plugin-nutstore）只是把凭据写进
 *      `sync.storage.*` 交给 Zotero，本身没有传输代码，抄不到东西。
 *
 * ⚠️ 环境铁律（本仓库 §10/§14 的老坑）：
 *   · `Zotero.HTTP.request` 对 4xx/5xx **不抛异常**，只处理网络层错误 —— 必须自判 status；
 *   · 它的 `timeout` 是 socket 空闲超时，不是总时限 —— 这里再加应用层计时器竞速；
 *   · bootstrap 作用域**不一定有** XMLHttpRequest —— 有就用（能拿上传进度），没有回落到
 *     Zotero.HTTP；两条路的返回结构在此统一。
 *
 * 本文件是纯函数 + 一个可注入 transport 的客户端，便于在 Node vm 里跑测试
 * （见 test/cloud-sync.test.js）。
 */
/* global Zotero, XMLHttpRequest, TextEncoder */

var WebDAV = (function () {
  "use strict";

  // 坚果云 WebDAV 根（团队版/国际版可在设置里改）
  var DEFAULT_BASE = "https://dav.jianguoyun.com/dav";

  /** 错误码：引擎与 UI 共用一份，避免各处自己拼字符串 */
  var CODES = {
    AUTH_REQUIRED: "AUTH_REQUIRED",
    AUTH_EXPIRED: "AUTH_EXPIRED",
    FORBIDDEN: "FORBIDDEN",
    NOT_FOUND: "NOT_FOUND",
    CONFLICT: "CONFLICT",
    QUOTA: "QUOTA",
    TOO_LARGE: "TOO_LARGE",
    RATE_LIMIT: "RATE_LIMIT",
    LOCKED: "LOCKED",
    SERVER: "SERVER",
    NETWORK: "NETWORK",
    TIMEOUT: "TIMEOUT",
    ABORTED: "ABORTED",
    IO: "IO",
    CONFIG: "CONFIG",
    UNKNOWN: "UNKNOWN",
  };

  /** 带 code 的错误：`e.code` 是唯一判据，message 只给人看 */
  function syncError(code, message, extra) {
    var e = new Error(message || code);
    e.name = "CloudSyncError";
    e.code = code || CODES.UNKNOWN;
    if (extra) {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) e[k] = extra[k];
      }
    }
    return e;
  }

  /** 只有这些值得重试：网络层 / 超时 / 服务端 5xx / 限流 / 短暂锁定 */
  function retryable(code) {
    return code === CODES.NETWORK || code === CODES.TIMEOUT ||
      code === CODES.SERVER || code === CODES.RATE_LIMIT || code === CODES.LOCKED;
  }

  /** HTTP 状态 → 错误码。401 与 403 必须分开：403 是权限/路径，不是授权过期。 */
  function statusCode(status) {
    var s = Number(status) || 0;
    if (s === 401) return CODES.AUTH_REQUIRED;
    if (s === 403) return CODES.FORBIDDEN;
    if (s === 404 || s === 409) return CODES.NOT_FOUND;
    if (s === 412) return CODES.CONFLICT;
    if (s === 413) return CODES.TOO_LARGE;
    if (s === 423) return CODES.LOCKED;
    if (s === 429) return CODES.RATE_LIMIT;
    if (s === 507) return CODES.QUOTA;
    if (s === 0) return CODES.NETWORK;
    if (s >= 500) return CODES.SERVER;
    return CODES.UNKNOWN;
  }

  function isOk(status) {
    var s = Number(status) || 0;
    return s >= 200 && s < 300;
  }

  /** 指数退避 + 抖动：attempt 从 1 开始；rand 注入便于测试 */
  function backoff(attempt, baseMs, maxMs, rand) {
    var base = Number(baseMs) > 0 ? Number(baseMs) : 800;
    var max = Number(maxMs) > 0 ? Number(maxMs) : 20000;
    var n = Math.max(1, Number(attempt) || 1);
    var raw = Math.min(max, base * Math.pow(2, n - 1));
    var r = typeof rand === "function" ? rand() : Math.random();
    // 0.7 ~ 1.3 抖动，避免多设备同时重试打成尖峰
    return Math.round(raw * (0.7 + 0.6 * r));
  }

  function isAbsoluteUrl(p) {
    return /^https?:\/\//i.test(String(p == null ? "" : p));
  }

  /** 统一成 `/a/b`：反斜杠转正斜杠、去掉 `.`/空段、处理 `..`、去尾斜杠（根除外） */
  function normalizePath(p) {
    var s = String(p == null ? "" : p).replace(/\\/g, "/").trim();
    if (isAbsoluteUrl(s)) {
      try {
        var u = new URL(s);
        s = u.pathname;
      } catch (e) { /* 保持原样，交给上层报错 */ }
    }
    var parts = s.split("/");
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i];
      if (!seg || seg === ".") continue;
      if (seg === "..") { out.pop(); continue; }
      out.push(seg);
    }
    return "/" + out.join("/");
  }

  /** 逐段百分号编码；`'()!*` 这些 encodeURIComponent 保留的字符也一并编码，避免服务端歧义 */
  function encodePath(p) {
    var segs = normalizePath(p).split("/");
    var out = [];
    for (var i = 0; i < segs.length; i++) {
      var seg = segs[i];
      if (!seg) { out.push(""); continue; }
      out.push(encodeURIComponent(seg)
        .replace(/'/g, "%27")
        .replace(/\(/g, "%28")
        .replace(/\)/g, "%29")
        .replace(/!/g, "%21")
        .replace(/\*/g, "%2A"));
    }
    return out.join("/");
  }

  /** 多段拼路径（忽略空段；不改变开头） */
  function join() {
    var segs = [];
    for (var i = 0; i < arguments.length; i++) {
      var v = arguments[i];
      if (v === undefined || v === null || v === "") continue;
      segs.push(String(v));
    }
    return normalizePath(segs.join("/"));
  }

  function basename(p) {
    var n = normalizePath(p);
    var i = n.lastIndexOf("/");
    return i >= 0 ? n.slice(i + 1) : n;
  }

  function dirname(p) {
    var n = normalizePath(p);
    var i = n.lastIndexOf("/");
    return i <= 0 ? "/" : n.slice(0, i);
  }

  function extname(name) {
    var n = String(name || "");
    var i = n.lastIndexOf(".");
    return i > 0 ? n.slice(i) : "";
  }

  /** UTF-8 → Base64（btoa 只吃 latin1；账号里可能有中文/emoji，必须自己转字节） */
  function b64utf8(str) {
    var s = String(str == null ? "" : str);
    var bytes;
    if (typeof TextEncoder !== "undefined") {
      bytes = new TextEncoder().encode(s);
    } else {
      var enc = encodeURIComponent(s);
      bytes = [];
      for (var i = 0; i < enc.length; i++) {
        if (enc[i] === "%") { bytes.push(parseInt(enc.substr(i + 1, 2), 16)); i += 2; }
        else bytes.push(enc.charCodeAt(i));
      }
    }
    var bin = "";
    for (var j = 0; j < bytes.length; j++) bin += String.fromCharCode(bytes[j]);
    if (typeof btoa === "function") return btoa(bin);
    // Node/测试环境兜底
    if (typeof Buffer !== "undefined") return Buffer.from(s, "utf8").toString("base64");
    throw syncError(CODES.UNKNOWN, "当前环境无法做 Base64 编码");
  }

  function basicAuth(user, pass) {
    return "Basic " + b64utf8(String(user == null ? "" : user) + ":" + String(pass == null ? "" : pass));
  }

  function xmlUnescape(s) {
    return String(s == null ? "" : s)
      .replace(/&#x([0-9a-fA-F]+);/g, function (_, h) {
        try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return ""; }
      })
      .replace(/&#(\d+);/g, function (_, d) {
        try { return String.fromCodePoint(parseInt(d, 10)); } catch (e) { return ""; }
      })
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, "\"")
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&");
  }

  function parseHeaders(raw) {
    var out = {};
    String(raw == null ? "" : raw).split(/\r?\n/).forEach(function (line) {
      var i = line.indexOf(":");
      if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    });
    return out;
  }

  /**
   * 解析 207 Multi-Status。
   * 命名空间前缀不固定（`D:` / `d:` / `lp1:` / 无前缀），一律用可选前缀正则。
   * @returns {Array<{href:string,path:string,name:string,isDir:boolean,size:number,etag:string,mtime:number}>}
   */
  function parseMultistatus(xml) {
    var text = String(xml == null ? "" : xml);
    var out = [];
    var re = /<(?:[\w.-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?response>/gi;
    var m;
    while ((m = re.exec(text))) {
      var block = m[1];
      var hrefM = block.match(/<(?:[\w.-]+:)?href[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?href>/i);
      if (!hrefM) continue;
      var href = xmlUnescape(hrefM[1].trim());
      var path = href.replace(/^https?:\/\/[^/]+/i, "");
      try { path = decodeURIComponent(path); } catch (e) { /* 已解码或非法编码：原样用 */ }
      path = normalizePath(path);

      var etagM = block.match(/<(?:[\w.-]+:)?getetag[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?getetag>/i);
      var sizeM = block.match(/<(?:[\w.-]+:)?getcontentlength[^>]*>\s*(\d+)\s*<\//i);
      var mtimeM = block.match(/<(?:[\w.-]+:)?getlastmodified[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?getlastmodified>/i);
      var isDir = /<(?:[\w.-]+:)?resourcetype\b[^>]*>[\s\S]*?<(?:[\w.-]+:)?collection\b/i.test(block) ||
        /\/$/.test(href);

      var mtime = 0;
      if (mtimeM) {
        var t = Date.parse(xmlUnescape(mtimeM[1]).trim());
        if (!isNaN(t)) mtime = t;
      }

      var rawEtag = etagM ? xmlUnescape(etagM[1]).trim().replace(/^W\//, "") : "";
      out.push({
        href: href,
        path: path,
        name: basename(path),
        isDir: isDir,
        size: sizeM ? parseInt(sizeM[1], 10) : 0,
        // etag = 归一化（去引号），用于"变没变"的比较；
        // etagRaw = 服务端原样（可能带引号，也可能裸串），用于 If-Match 原样回传。
        // 坚果云返回的是**裸串**（如 iwlZel-VA8cnzqRY9CcZSg），补引号会被判 412。
        etag: rawEtag.replace(/^"|"$/g, ""),
        etagRaw: rawEtag,
        mtime: mtime,
      });
    }
    return out;
  }

  /** `bytes 100-199/2000` → {start,end,total}；解析不了返回 null */
  function parseContentRange(h) {
    var m = String(h == null ? "" : h).match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);
    if (!m) return null;
    return {
      start: parseInt(m[1], 10),
      end: parseInt(m[2], 10),
      total: m[3] === "*" ? null : parseInt(m[3], 10),
    };
  }

  /** 分卷清单文件名：`foo.xpi.ppmanifest.json`；`.pppart` → true */
  function isManifestName(name) {
    return /\.ppmanifest\.json$/i.test(String(name || ""));
  }

  function manifestPathFor(filePath) {
    return String(filePath || "") + ".ppmanifest.json";
  }

  /** 分卷目录：与目标文件同级的 `.ppparts/<文件名>.<hash8>/` */
  function partsDirFor(filePath, hashHex) {
    var h = String(hashHex || "").slice(0, 8) || "nohash";
    return join(dirname(filePath), ".ppparts", basename(filePath) + "." + h);
  }

  function partName(index) {
    var n = Number(index) + 1;
    var s = String(n);
    while (s.length < 4) s = "0" + s;
    return s + ".part";
  }

  /**
   * 校验分卷清单（结构 + 片数 + 各片大小），不做 IO。
   * @returns {{ok:boolean, error?:string, total:number}}
   */
  function validateManifest(manifest) {
    if (!manifest || typeof manifest !== "object") return { ok: false, error: "清单为空", total: 0 };
    if (manifest.version !== 1) return { ok: false, error: "清单版本不支持：" + manifest.version, total: 0 };
    var parts = manifest.parts;
    if (!Array.isArray(parts) || !parts.length) return { ok: false, error: "清单没有分片", total: 0 };
    var sum = 0;
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i] || {};
      var size = Number(p.size);
      if (!p.name || !isFinite(size) || size < 0) return { ok: false, error: "第 " + (i + 1) + " 片信息不完整", total: 0 };
      sum += size;
    }
    if (Number(manifest.size) !== sum) {
      return { ok: false, error: "分片总大小与清单不符（" + sum + " ≠ " + manifest.size + "）", total: sum };
    }
    return { ok: true, total: sum };
  }

  function formatBytes(n) {
    var v = Number(n) || 0;
    if (v < 1024) return v + " B";
    if (v < 1024 * 1024) return (v / 1024).toFixed(1) + " KB";
    if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + " MB";
    return (v / 1024 / 1024 / 1024).toFixed(2) + " GB";
  }

  /** SHA-256 → hex；不可用（无 crypto.subtle）时返回 ""，调用方降级为 size+mtime */
  async function sha256Hex(bytes) {
    try {
      var subtle = (typeof crypto !== "undefined" && crypto && crypto.subtle) ? crypto.subtle : null;
      if (!subtle || !subtle.digest) return "";
      var buf = toArrayBuffer(bytes);
      var digest = await subtle.digest("SHA-256", buf);
      var arr = new Uint8Array(digest);
      var hex = "";
      for (var i = 0; i < arr.length; i++) hex += (arr[i] < 16 ? "0" : "") + arr[i].toString(16);
      return hex;
    } catch (e) {
      return "";
    }
  }

  /** Uint8Array / ArrayBuffer / string → ArrayBuffer */
  function toArrayBuffer(v) {
    if (v == null) return new ArrayBuffer(0);
    // 跨 realm 的视图/缓冲区不能靠 instanceof 判断（vm 沙箱、worker 都会踩）：
    // ArrayBuffer.isView 走内部槽，跨 realm 可靠；缓冲区用 byteLength 鸭子判定。
    try {
      if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView && ArrayBuffer.isView(v)) {
        // 整块视图直接复用底层 buffer，避免大文件（分卷组装/校验）再多复制一份
        if (v.byteOffset === 0 && v.byteLength === v.buffer.byteLength) return v.buffer;
        return v.buffer.slice(v.byteOffset || 0, (v.byteOffset || 0) + (v.byteLength || 0));
      }
    } catch (e) { /* 继续尝试其它形态 */ }
    if (typeof v === "object" && typeof v.byteLength === "number") {
      return v;   // ArrayBuffer（可能来自另一个 realm）
    }
    if (typeof v === "string") {
      if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(v).buffer;
      var enc = unescape(encodeURIComponent(v));
      var ab = new ArrayBuffer(enc.length);
      var u8 = new Uint8Array(ab);
      for (var i = 0; i < enc.length; i++) u8[i] = enc.charCodeAt(i);
      return ab;
    }
    try { return new TextEncoder().encode(String(v)).buffer; } catch (e) { return new ArrayBuffer(0); }
  }

  function textOf(res) {
    if (!res) return "";
    if (typeof res.text === "string" && res.text) return res.text;
    if (typeof res.body === "string") return res.body;
    return "";
  }

  /* ---------------- 传输层：优先 XHR（有进度/可中断），回落 Zotero.HTTP ---------------- */

  async function xhrTransport(o) {
    var XHR = typeof XMLHttpRequest !== "undefined" ? XMLHttpRequest : null;
    if (!XHR) return zoteroTransport(o);

    return await new Promise(function (resolve, reject) {
      var xhr = new XHR();
      var settled = false;
      var finish = function (fn, arg) {
        if (settled) return;
        settled = true;
        fn(arg);
      };
      try {
        xhr.open(o.method, o.url, true);
        if (o.responseType && o.responseType !== "text") xhr.responseType = o.responseType;
        xhr.timeout = o.timeout || 30000;
        var headers = o.headers || {};
        for (var k in headers) {
          if (!Object.prototype.hasOwnProperty.call(headers, k)) continue;
          try { xhr.setRequestHeader(k, headers[k]); } catch (e) { /* 禁用头忽略 */ }
        }
        if (o.onProgress && xhr.upload) {
          xhr.upload.onprogress = function (ev) {
            if (ev && ev.lengthComputable && o.onProgress) o.onProgress(ev.loaded, ev.total);
          };
        }
        xhr.onload = function () {
          finish(resolve, {
            status: Number(xhr.status) || 0,
            headers: parseHeaders(xhr.getAllResponseHeaders ? xhr.getAllResponseHeaders() : ""),
            body: xhr.response,
            text: xhr.responseType && xhr.responseType !== "text" ? "" : (xhr.responseText || ""),
          });
        };
        xhr.onerror = function () { finish(reject, syncError(CODES.NETWORK, "网络层失败（无响应）")); };
        xhr.ontimeout = function () { finish(reject, syncError(CODES.TIMEOUT, "请求超时")); };
        xhr.onabort = function () { finish(reject, syncError(CODES.ABORTED, "请求已取消")); };
        if (o.abortToken && typeof o.abortToken.register === "function") {
          o.abortToken.register(function () { try { xhr.abort(); } catch (e) { /* ignore */ } });
        }
        xhr.send(o.body == null ? null : o.body);
      } catch (e) {
        finish(reject, syncError(CODES.NETWORK, "请求发起失败：" + (e && e.message || e)));
      }
    });
  }

  async function zoteroTransport(o) {
    if (typeof Zotero === "undefined" || !Zotero.HTTP || typeof Zotero.HTTP.request !== "function") {
      throw syncError(CODES.NETWORK, "当前环境没有可用的 HTTP 传输层");
    }
    var timeout = o.timeout || 30000;
    var opts = {
      headers: o.headers || {},
      timeout: timeout,
      responseType: o.responseType === "text" ? "text" : "arraybuffer",
    };
    if (o.body != null) opts.body = o.body;

    var reqP = Zotero.HTTP.request(o.method, o.url, opts).then(function (req) {
      return {
        status: Number(req && req.status) || 0,
        headers: parseHeaders(req && req.getAllResponseHeaders ? req.getAllResponseHeaders() : ""),
        body: req && req.response,
        text: req && (req.responseText || (typeof req.response === "string" ? req.response : "")) || "",
      };
    });

    // 应用层超时：Zotero 的 timeout 只管 socket 空闲，挂起的请求会一直占着
    var timer = null;
    var timeoutP = new Promise(function (_, rej) {
      timer = setTimeout(function () { rej(syncError(CODES.TIMEOUT, "请求超时（" + Math.round(timeout / 1000) + "s）")); }, timeout + 2000);
    });
    try {
      return await Promise.race([reqP, timeoutP]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function makeTransport() {
    return typeof XMLHttpRequest !== "undefined" ? xhrTransport : zoteroTransport;
  }

  /* ---------------- 客户端 ---------------- */

  /**
   * @param {object} cfg {baseUrl, username, password, timeoutMs, transport, onAuthFail}
   */
  function createClient(cfg) {
    cfg = cfg || {};
    var base = String(cfg.baseUrl || DEFAULT_BASE).replace(/\/+$/, "");
    var auth = cfg.username ? basicAuth(cfg.username, cfg.password) : "";
    var timeoutMs = Number(cfg.timeoutMs) > 0 ? Number(cfg.timeoutMs) : 30000;
    var transport = typeof cfg.transport === "function" ? cfg.transport : makeTransport();
    // 请求节流：坚果云对短时间内的密集请求会返回 503 BlockedTemporarily（真机踩过），
    // 串行 + 最小间隔是唯一稳妥做法。默认 120ms，遇 429/503 限流自动翻倍（上限 3s），
    // 连续成功后按 0.9 系数回落——首次同步比固定 300ms 快约一倍，又不至于撞墙。
    var baseInterval = cfg.minIntervalMs === undefined ? 120 : Math.max(0, Number(cfg.minIntervalMs) || 0);
    var interval = baseInterval;
    var lastAt = 0;
    var stats = { requests: 0, throttled: 0, intervalMs: interval };

    function urlOf(path) {
      if (isAbsoluteUrl(path)) return String(path);
      return base + encodePath(path);
    }

    /** 根据响应自动升降节流档位：限流 → 翻倍；连续成功 → 缓慢回落 */
    function adaptThrottle(res) {
      if (baseInterval <= 0) return;
      var st = Number(res && res.status) || 0;
      var blocked = st === 429 ||
        (st === 503 && /BlockedTemporarily|too many requests/i.test(textOf(res)));
      if (blocked) {
        interval = Math.min(3000, Math.max(600, Math.round(Math.max(interval, baseInterval) * 2)));
        stats.throttled++;
      } else if (st >= 200 && st < 300 && interval > baseInterval) {
        interval = Math.max(baseInterval, Math.round(interval * 0.9));
      }
      stats.intervalMs = interval;
    }

    async function request(method, path, opts) {
      opts = opts || {};
      var headers = {};
      var k;
      if (opts.headers) {
        for (k in opts.headers) {
          if (Object.prototype.hasOwnProperty.call(opts.headers, k)) headers[k] = opts.headers[k];
        }
      }
      if (auth) headers.Authorization = auth;
      // 最小请求间隔（只在本客户端实例内串行；同步本身也是串行的）
      if (interval > 0) {
        var wait = lastAt + interval - Date.now();
        if (wait > 0) await new Promise(function (r) { setTimeout(r, wait); });
        lastAt = Date.now();
      }
      stats.requests++;
      var res = await transport({
        method: method,
        url: urlOf(path),
        headers: headers,
        body: opts.body,
        timeout: opts.timeout || timeoutMs,
        responseType: opts.responseType || "text",
        onProgress: opts.onProgress,
        abortToken: opts.abortToken,
      });
      res = res || { status: 0, headers: {}, body: null, text: "" };
      adaptThrottle(res);
      return res;
    }

    /** 把非 2xx 响应转成带 code 的错误；401 区分「没填凭据」与「凭据失效」 */
    function fail(res, action) {
      var code = statusCode(res && res.status);
      if (code === CODES.AUTH_REQUIRED && auth) code = CODES.AUTH_EXPIRED;
      var detail = textOf(res).slice(0, 200).replace(/\s+/g, " ");
      var extra = { status: res && res.status, action: action };
      // 坚果云限流：503 + BlockedTemporarily。它是"等一会儿再来"，不是服务端故障，
      // 必须按限流处理并给出更长的等待（实测连续请求会触发，等待 >75s 仍未解除）。
      if (res && res.status === 503 && /BlockedTemporarily|too many requests/i.test(detail)) {
        code = CODES.RATE_LIMIT;
        extra.retryAfterMs = 120000;
        extra.blocked = true;
      }
      throw syncError(code, action + "失败（HTTP " + (res && res.status) + "）" +
        (detail ? "：" + detail : ""), extra);
    }

    async function propfind(path, depth) {
      var body = "<?xml version=\"1.0\" encoding=\"utf-8\"?>" +
        "<d:propfind xmlns:d=\"DAV:\"><d:prop>" +
        "<d:resourcetype/><d:getcontentlength/><d:getetag/><d:getlastmodified/>" +
        "</d:prop></d:propfind>";
      var res = await request("PROPFIND", path, {
        headers: {
          Depth: String(depth == null ? 1 : depth),
          "Content-Type": "application/xml; charset=utf-8",
        },
        body: body,
        responseType: "text",
      });
      if (res.status === 207 || isOk(res.status)) return parseMultistatus(textOf(res));
      fail(res, "列目录 " + normalizePath(path));
    }

    async function stat(path) {
      var items = await propfind(path, 0);
      if (!items.length) return null;
      // 服务器会把自身也返回；取 path 最匹配的一条
      var want = normalizePath(path);
      for (var i = 0; i < items.length; i++) {
        if (items[i].path === want) return items[i];
      }
      return items[0];
    }

    async function exists(path) {
      try {
        return !!(await stat(path));
      } catch (e) {
        if (e.code === CODES.NOT_FOUND) return false;
        throw e;
      }
    }

    /** 递归建目录；已存在（405/301）视为成功，不重复报错 */
    async function ensureDir(path) {
      var segs = normalizePath(path).split("/").filter(Boolean);
      var cur = "";
      for (var i = 0; i < segs.length; i++) {
        cur += "/" + segs[i];
        var res = await request("MKCOL", cur, { responseType: "text" });
        if (isOk(res.status) || res.status === 405 || res.status === 301) continue;
        if (res.status === 403) {
          // 某些服务端对已存在目录返回 403；用 stat 复核一次再决定
          if (await exists(cur)) continue;
        }
        fail(res, "创建目录 " + cur);
      }
    }

    async function put(path, body, opts) {
      opts = opts || {};
      var headers = { "Content-Type": opts.contentType || "application/octet-stream" };
      // If-Match 必须**原样回传**服务端给的 etag 形态：坚果云给裸串，Nextcloud 给带引号，
      // 统一补引号会让坚果云直接 412（真机踩过）。
      var ifMatch = opts.ifMatch || opts.etag || "";
      if (ifMatch) headers["If-Match"] = ifMatch;
      else if (opts.createOnly) headers["If-None-Match"] = "*";

      var buf = toArrayBuffer(body);
      var res = await request("PUT", path, {
        headers: headers,
        body: buf,
        timeout: opts.timeout || Math.max(timeoutMs, 120000),
        responseType: "text",
        onProgress: opts.onProgress,
        abortToken: opts.abortToken,
      });

      if (!isOk(res.status)) {
        if (res.status === 412) {
          throw syncError(CODES.CONFLICT, "云端文件已被其它设备修改", { status: 412, path: normalizePath(path) });
        }
        fail(res, "上传 " + basename(path));
      }

      var raw = String((res.headers && res.headers.etag) || "").replace(/^W\//, "");
      var etag = raw.replace(/^"|"$/g, "");
      if (!etag) {
        try {
          var st = await stat(path);
          etag = (st && st.etag) || "";
          raw = (st && (st.etagRaw || st.etag)) || "";
        } catch (e) { /* 取不到 etag 不致命：下次按 size 判定 */ }
      }
      return { status: res.status, etag: etag, etagRaw: raw, size: buf.byteLength };
    }

    async function getBuffer(path, opts) {
      opts = opts || {};
      var headers = {};
      if (Number(opts.rangeStart) > 0) headers.Range = "bytes=" + Number(opts.rangeStart) + "-";
      var res = await request("GET", path, {
        headers: headers,
        responseType: "arraybuffer",
        timeout: opts.timeout || Math.max(timeoutMs, 120000),
        onProgress: opts.onProgress,
        abortToken: opts.abortToken,
      });
      if (!(res.status === 206 || isOk(res.status))) fail(res, "下载 " + basename(path));
      return {
        status: res.status,
        body: toArrayBuffer(res.body),
        headers: res.headers || {},
        contentRange: parseContentRange((res.headers || {})["content-range"] || ""),
      };
    }

    async function del(path) {
      var res = await request("DELETE", path, { responseType: "text" });
      if (!isOk(res.status) && res.status !== 404) fail(res, "删除 " + basename(path));
      return true;
    }

    return {
      baseUrl: base,
      username: cfg.username || "",
      timeoutMs: timeoutMs,
      request: request,
      propfind: propfind,
      stat: stat,
      exists: exists,
      ensureDir: ensureDir,
      put: put,
      getBuffer: getBuffer,
      del: del,
      urlOf: urlOf,
      /** 节流状态（排障/面板展示用）：当前间隔、触发限流次数 */
      throttle: function () {
        return {
          baseIntervalMs: baseInterval,
          intervalMs: interval,
          requests: stats.requests,
          throttled: stats.throttled,
        };
      },
    };
  }

  return {
    DEFAULT_BASE: DEFAULT_BASE,
    CODES: CODES,
    syncError: syncError,
    retryable: retryable,
    statusCode: statusCode,
    isOk: isOk,
    backoff: backoff,
    normalizePath: normalizePath,
    encodePath: encodePath,
    join: join,
    basename: basename,
    dirname: dirname,
    extname: extname,
    b64utf8: b64utf8,
    basicAuth: basicAuth,
    xmlUnescape: xmlUnescape,
    parseHeaders: parseHeaders,
    parseMultistatus: parseMultistatus,
    parseContentRange: parseContentRange,
    isManifestName: isManifestName,
    manifestPathFor: manifestPathFor,
    partsDirFor: partsDirFor,
    partName: partName,
    validateManifest: validateManifest,
    formatBytes: formatBytes,
    sha256Hex: sha256Hex,
    toArrayBuffer: toArrayBuffer,
    textOf: textOf,
    createClient: createClient,
    transport: { xhr: xhrTransport, zotero: zoteroTransport, pick: makeTransport },
  };
})();
