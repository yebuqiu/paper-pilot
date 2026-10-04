"use strict";

/**
 * HTTP 传输层：Node 原生 http/https，零依赖。
 *
 * 几个刻意的选择：
 *   - **不用 fetch/undici**：本机网络环境下 undici 会把请求头名小写化，某些网关/代理对头名大小写敏感
 *     （已在另一项目踩实：小写 authorization 触发 502）。原生模块显式写 Title-Case 头名，行为确定。
 *   - **应用层超时**：只用 socket timeout 不够——连接建立了但服务端不吐数据时，socket 不会超时。
 *     这里用独立计时器 destroy 请求，保证「永远不挂死」。
 *   - **只收文本**：arXiv 返回 Atom XML，按 utf8 拼接即可；不请求 gzip（不发 Accept-Encoding），
 *     省掉 zlib 分支与「解压失败」这类噪声故障。
 */

const http = require("http");
const https = require("https");
const { URL } = require("url");
const { TimeoutError, NetworkError, HttpError, ParseError } = require("./errors");

const DEFAULT_HEADERS = {
  Accept: "application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1",
  "Accept-Language": "en-US,en;q=0.9",
  Connection: "close",
};

/**
 * 单次请求（不跟随重定向）。
 * @param {string} url
 * @param {{method?:string, headers?:object, timeoutMs?:number, agent?:object}} [opts]
 * @returns {Promise<{status:number, headers:object, body:string, url:string}>}
 */
function once(url, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || 30000;

  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); }
    catch (e) { reject(new NetworkError("非法 URL：" + url, { cause: e })); return; }

    const mod = u.protocol === "http:" ? http : https;
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      reject(new NetworkError("不支持的协议：" + u.protocol));
      return;
    }

    const reqOpts = {
      method: o.method || "GET",
      headers: Object.assign({}, DEFAULT_HEADERS, o.headers || {}),
      agent: o.agent,
    };

    let settled = false;
    let timer = null;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(arg);
    };

    let req;
    try {
      req = mod.request(u, reqOpts, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          done(resolve, {
            status: res.statusCode || 0,
            headers: res.headers || {},
            body: Buffer.concat(chunks).toString("utf8"),
            url,
          });
        });
        res.on("error", (e) => done(reject, new NetworkError("读取响应失败：" + e.message, { cause: e })));
      });
    } catch (e) {
      done(reject, new NetworkError("发起请求失败：" + e.message, { cause: e }));
      return;
    }

    timer = setTimeout(() => {
      const err = new TimeoutError("请求超时（" + timeoutMs + "ms）：" + url);
      try { req.destroy(err); } catch (e) { /* ignore */ }
      done(reject, err);
    }, timeoutMs);

    req.on("error", (e) => {
      if (e && e.code === "TIMEOUT") { done(reject, new TimeoutError("请求超时（" + timeoutMs + "ms）", { cause: e })); return; }
      done(reject, new NetworkError("网络错误：" + (e && e.message ? e.message : String(e)), { cause: e }));
    });

    req.end();
  });
}

/**
 * 带重定向跟随的请求。
 * @returns {Promise<{status:number, headers:object, body:string, url:string, redirects:string[]}>}
 */
async function request(url, opts) {
  const o = opts || {};
  const maxRedirects = o.maxRedirects == null ? 5 : o.maxRedirects;
  const redirects = [];
  let current = url;

  for (let i = 0; i <= maxRedirects; i++) {
    const res = await once(current, o);
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      const next = new URL(res.headers.location, current).toString();
      redirects.push(next);
      current = next;
      continue;
    }
    return Object.assign(res, { redirects });
  }
  throw new HttpError("重定向次数超过 " + maxRedirects + " 次：" + url, 310, { details: { redirects } });
}

/**
 * 生成绑定默认参数的传输函数，便于注入到 client（也让测试能替换成桩）。
 * @param {{userAgent?:string, timeoutMs?:number, headers?:object}} [cfg]
 * @returns {(url:string, opts?:object) => Promise<object>}
 */
function createTransport(cfg) {
  const c = cfg || {};
  return function transport(url, opts) {
    const o = Object.assign({}, opts);
    o.timeoutMs = o.timeoutMs || c.timeoutMs || 30000;
    o.headers = Object.assign({ "User-Agent": c.userAgent || "PaperPilot-arXiv-Toolkit/1.0" }, c.headers || {}, o.headers || {});
    return request(url, o);
  };
}

/** 把响应体解析为 JSON，失败抛 ParseError（带截断上下文，便于定位返回了 HTML 错误页的情况）。 */
function parseJson(body, url) {
  try { return JSON.parse(String(body || "")); }
  catch (e) {
    throw new ParseError("响应不是合法 JSON：" + String(url || "") + " — " + String(body || "").slice(0, 200), { cause: e });
  }
}

module.exports = { request, once, createTransport, parseJson, DEFAULT_HEADERS };
