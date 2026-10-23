// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 共享目录基建（catalog-client）
 * ================================================================
 * 组件商店（core/module-store.js）与技能包商店（features/skill-packs.js）
 * 曾各写一套目录拉取/缓存/降级，接缝形状不一致已两次造成「商店列表恒空」
 * （0.48.4 技能商店；组件商店窗口直读 res.modules 顶层）。本模块是唯一真源：
 *
 *   · 多源 URL 列表 + 镜像 pref 置顶（module-store 的 modulesCatalogUrl 机制；
 *     技能包的 skillStoreSource 复用同一「置顶」语义——urls 为空时它就是唯一源）
 *   · TTL 缓存（pref 持久化 {ts,data}）+ 过期缓存兜底（stale-cache，离线降级）
 *   · 会话内失败源记忆：URL 挂一次，本会话跳过不再等超时（国内网络下 GitHub
 *     不可达时，每个操作都先等它超时一遍会显得「反复卡死」）
 *   · 超时：JSON 8s / 二进制 60s；Zotero 7+ 用 Promise 形式的
 *     Zotero.HTTP.request（回调式已实测不可靠）
 *   · 目录结构校验回调由调用方注入（两店结构不同）
 *   · 返回形状同时带 {ok, data} 与顶层 modules/items/updated——少一半就是
 *     「列表恒空」接缝 bug
 *
 * 纯对象、零依赖、无框架；prefGet/prefSet/diag/now/httpGet 全部注入。
 */
/* global Zotero */

var CatalogClient = {
  JSON_TIMEOUT_MS: 8000,
  BINARY_TIMEOUT_MS: 60000,

  /** JSON 拉取：Zotero 7+ 的 Zotero.HTTP.request 返回 Promise<response>（回调式不可靠）。 */
  async httpGet(url) {
    const req = await Zotero.HTTP.request("GET", url, {
      timeout: this.JSON_TIMEOUT_MS,
      responseType: "json",
      headers: { "Accept": "application/json", "Cache-Control": "no-cache" },
    });
    if (req.response && typeof req.response === "object") return req.response;
    return JSON.parse(req.responseText || "{}");
  },

  /** 二进制拉取（组件 zip 等）。 */
  async httpGetBytes(url) {
    const req = await Zotero.HTTP.request("GET", url, {
      timeout: this.BINARY_TIMEOUT_MS,
      responseType: "arraybuffer",
    });
    const buf = req.response;
    if (!buf) throw new Error("空响应");
    return new Uint8Array(buf);
  },

  /**
   * 创建一个目录客户端实例。cfg:
   *   urls             string[]  官方源列表（按序尝试）
   *   mirrorPref       string    镜像 pref 键：值非空时置顶到 urls 之前
   *   cachePref        string    TTL 缓存 pref 键（JSON {ts,data}）；空 = 不缓存
   *   cacheTtlMs       number    缓存有效期；0 = 不缓存
   *   validate         fn(data) -> {ok, errors[]}  结构校验（调用方注入）；空 = 不校验
   *   sourceLabel      fn(url) -> string  来源标签（如 gitee/github）；空 = 用 URL 本身
   *   rememberFailures bool      默认 true：源挂一次，本会话跳过（不再等超时）
   *   prefGet/prefSet/diag/now   依赖注入
   *   httpGet          fn(url) -> Promise<object>  空 = 用 CatalogClient.httpGet
   */
  create(cfg) {
    const c = cfg || {};
    return {
      _c: {
        urls: Array.isArray(c.urls) ? c.urls.slice() : [],
        mirrorPref: c.mirrorPref || null,
        cachePref: c.cachePref || null,
        cacheTtlMs: Number(c.cacheTtlMs) || 0,
        validate: typeof c.validate === "function" ? c.validate : null,
        sourceLabel: typeof c.sourceLabel === "function" ? c.sourceLabel : null,
        rememberFailures: c.rememberFailures !== false,
        prefGet: typeof c.prefGet === "function" ? c.prefGet : function (k, def) { return def; },
        prefSet: typeof c.prefSet === "function" ? c.prefSet : function () {},
        diag: typeof c.diag === "function" ? c.diag : function () {},
        now: typeof c.now === "function" ? c.now : function () { return Date.now(); },
        httpGet: typeof c.httpGet === "function" ? c.httpGet : function (url) { return CatalogClient.httpGet(url); },
      },
      /** 会话内失败源记忆（URL 挂一次记 1，之后本会话跳过） */
      deadUrls: {},

      /** 解析后的源列表：镜像 pref（自建/自检）置顶，其后才是官方列表。 */
      urls() {
        let extra = "";
        if (this._c.mirrorPref) {
          try { extra = String(this._c.prefGet(this._c.mirrorPref, "") || "").trim(); } catch (e) { extra = ""; }
        }
        return extra ? [extra].concat(this._c.urls) : this._c.urls.slice();
      },

      /** 读 pref 持久化缓存：{ts, data} 或 null（坏值容错为 null）。 */
      readCache() {
        if (!this._c.cachePref) return null;
        try {
          const raw = this._c.prefGet(this._c.cachePref, "");
          if (!raw) return null;
          const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
          if (!obj || !obj.data || !obj.ts) return null;
          return obj;
        } catch (e) { return null; }
      },

      /** 清空会话失败源记忆（手动刷新/排障用）。 */
      clearFailures() { this.deadUrls = {}; },

      /**
       * 拉目录。force=true 穿透 TTL 缓存直接走网络；全部源失败时回落过期缓存
       * （source="stale-cache"，error 保留最后根因），无缓存才 ok:false。
       * 返回同时带 {ok, data} 与顶层 modules/items/updated（窗口直读顶层）。
       */
      async fetch(force) {
        const c = this._c;
        const now = c.now();
        if (!force && c.cachePref && c.cacheTtlMs > 0) {
          const cached = this.readCache();
          if (cached && (now - cached.ts) < c.cacheTtlMs) {
            return this._ok("cache", cached.data, { ts: cached.ts });
          }
        }
        let lastErr = null;
        for (const url of this.urls()) {
          if (c.rememberFailures && this.deadUrls[url]) {
            c.diag("catalog source skipped（本会话已知不通）: " + url);
            continue;
          }
          try {
            const data = await c.httpGet(url);
            if (c.validate) {
              const v = c.validate(data);
              if (!v || !v.ok) throw new Error("目录结构非法：" + ((v && v.errors) || []).join("; "));
            }
            if (c.cachePref) {
              try { c.prefSet(c.cachePref, JSON.stringify({ ts: now, data: data })); } catch (e) { /* 缓存写失败不影响本次结果 */ }
            }
            c.diag("catalog fetched from " + url);
            return this._ok(c.sourceLabel ? c.sourceLabel(url) : url, data, { url: url, ts: now });
          } catch (e) {
            lastErr = String(e && (e.message || e));
            if (c.rememberFailures) this.deadUrls[url] = 1;
            c.diag("catalog source failed: " + lastErr);
          }
        }
        // 过期缓存也好过没有（离线降级）
        const stale = this.readCache();
        if (stale) return this._ok("stale-cache", stale.data, { ts: stale.ts, error: lastErr });
        return this._fail(lastErr || "无法连接目录");
      },

      /** 统一返回形状：既给编排层（ok/data）也给窗口（顶层 modules/items/updated）。 */
      _ok(source, data, extra) {
        const r = {
          ok: true, data: data,
          modules: (data && data.modules) || [],
          items: (data && data.items) || [],
          updated: (data && data.updated) || null,
          source: source, url: null, ts: null, error: undefined,
        };
        if (extra) Object.assign(r, extra);
        return r;
      },

      _fail(error) {
        return { ok: false, error: error, data: null, modules: [], items: [], updated: null, source: null, url: null, ts: null };
      },
    };
  },
};
