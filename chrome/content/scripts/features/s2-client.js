// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot · Semantic Scholar 推荐端点扩展（0.51.0 新增）
 *
 * ⚠️ 本文件**不是** S2Client 的定义处。S2Client 的正文在
 *    chrome/content/scripts/ai/semantic-scholar.js（graph/v1 的单查 / 批量 / 标题检索）。
 *    这里只做「就地加方法」：不重新声明对象、不覆盖已有方法。
 *    为什么不用 `var S2Client = {...}` 全量重写？两个脚本在同一个全局作用域里
 *    声明同名 var，后加载的会把先加载的整个对象换掉——谁先谁后都会**静默丢一半方法**，
 *    这类接线错误在真机上只表现为「某个功能突然没有」，极难定位。
 *    故这里用 `S2Client = S2Client || {}` 保留既有对象（幂等扩展）。
 *
 * 端点（与 graph/v1 不同根）：
 *    GET https://api.semanticscholar.org/recommendations/v1/papers/forpaper/{paperId}
 *        ?fields=...&limit=N
 *    GET https://api.semanticscholar.org/graph/v1/paper/{paperId}/citations
 *        ?fields=title,year,authors,contexts,intents,isInfluential&limit=N   （0.52.0 追加）
 *    paperId 形如 DOI:10.x/xx / CorpusId:123 / ARXIV:2101.00001。
 *
 * ⚠️ 0.52.0 的 `citations` 与 semantic-scholar.js 里的**同名方法**冲突：
 *    后者 `citations(paperId, fields, limit)` 返回原始 [{citingPaper}]，是
 *    citation-trace.js 的取数入口。这里做**双模分派**而非硬覆盖：
 *      单参（或第二参是 fields 字符串）→ 旧实现原样返回（citation-trace 不受影响）
 *      显式传数字 limit               → 新的归一结果（带 contexts/intents）
 *    新调用方（CitationContext）必须显式传 limit。
 *
 * 复用主客户端的四件事（保持一致，不另起一套）：
 *   ① `_req` 的应用层超时竞速——S2 限流时会挂起连接、占满 Firefox 连接池，
 *      XHR 自带 timeout 不生效（0.8.0 实证）；本端点同样包一层 race。
 *   ② `_headers`（x-api-key 由设置里的 s2ApiKey 注入）。
 *   ③ 失败**不抛**给 UI：返回 {ok:false, error, reason}，调用方按文案降级。
 *   ④ 限速：无 key 时 1 req/s 量级（与 citation-column 的 1100ms 间隔同口径），
 *      有 key 时 250ms；串行排队，避免并发打爆。
 * 额外补一层内存缓存（10 分钟 / 50 条）：同一条目反复切面板不该重复请求。
 */
/* global Zotero, Prefs */

var S2Client = (typeof S2Client !== "undefined" && S2Client) ? S2Client : {};

(function (S2) {
  if (!S2 || typeof S2 !== "object") return;
  // 逐方法守卫（不是整段 return）：0.52.0 起同一文件里有 recommendations 与
  // citations 两段扩展，整段 return 会让后加的那段在二次加载时永远挂不上。

  var RECS_API = "https://api.semanticscholar.org/recommendations/v1/papers/forpaper/";
  var RECS_FIELDS = "title,year,venue,authors,citationCount,externalIds,abstract";
  var CACHE_TTL = 10 * 60 * 1000;
  var CACHE_MAX = 50;

  S2.RECS_API = S2.RECS_API || RECS_API;
  S2.RECS_FIELDS = S2.RECS_FIELDS || RECS_FIELDS;

  var cache = new Map();   // key -> {t, list}
  var queue = Promise.resolve();
  var lastAt = 0;

  function apiKey() {
    try {
      if (typeof S2._apiKey === "function") return String(S2._apiKey() || "").trim();
      return String(Prefs.get("s2ApiKey", "") || "").trim();
    } catch (e) { return ""; }
  }

  function headers() {
    var h = {};
    if (typeof S2._headers === "function") {
      try { return S2._headers(h); } catch (e) { /* 落下面的兜底 */ }
    }
    var k = apiKey();
    if (k) h["x-api-key"] = k;
    return h;
  }

  /** 与主客户端同款：应用层超时竞速，防止限流时连接池耗尽、await 永不返回 */
  function request(url, ms) {
    var opts = { responseType: "json", timeout: 20000, headers: headers() };
    if (typeof S2._req === "function") {
      try { return S2._req("GET", url, opts, ms || 25000); } catch (e) { /* 落兜底 */ }
    }
    return Promise.race([
      Zotero.HTTP.request("GET", url, opts),
      new Promise(function (_, reject) {
        setTimeout(function () {
          reject(new Error("S2 请求应用层超时（" + Math.round((ms || 25000) / 1000) + "s），可能限流，请稍后重试"));
        }, ms || 25000);
      }),
    ]);
  }

  /** 串行限速：两条请求之间至少间隔 minGap 毫秒 */
  function throttle(minGap) {
    var run = function () {
      var wait = Math.max(0, lastAt + minGap - Date.now());
      return new Promise(function (r) { setTimeout(r, wait); }).then(function () { lastAt = Date.now(); });
    };
    queue = queue.then(run, run);
    return queue;
  }

  /** paperKey 归一：裸 DOI / 纯数字 CorpusId / 已带前缀的 paperId */
  function normalizeId(paperKey) {
    var s = String(paperKey == null ? "" : paperKey).trim();
    if (!s) return "";
    if (/^(DOI|ARXIV|CORPUSID|MAG|ACL|PMID|PMCID|URL):/i.test(s)) return s;
    if (/^10\.\d{4,9}\//.test(s)) return "DOI:" + s;
    if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(s)) return "ARXIV:" + s;
    if (/^\d+$/.test(s)) return "CorpusId:" + s;
    return s;
  }

  function cleanText(v) {
    var s = String(v == null ? "" : v).replace(/\s+/g, " ").trim();
    return s;
  }

  /**
   * 归一为 UI 与入库都吃的形态：
   *   {title, year, venue, authors:"A, B and C", citationCount, doi, paperId, abstract}
   * authors 用**字符串**（S2 返回 [{authorId,name}]），由调用方自行拆分。
   */
  function normalize(p) {
    var ext = (p && p.externalIds) || {};
    var names = [];
    for (var i = 0; i < ((p && p.authors) || []).length; i++) {
      var a = p.authors[i] || {};
      var n = cleanText(a.name);
      if (n) names.push(n);
    }
    var year = parseInt(p && p.year, 10);
    return {
      title: cleanText(p && p.title),
      year: isFinite(year) ? year : 0,
      venue: cleanText(p && p.venue),
      authors: names.join(", "),
      citationCount: (p && typeof p.citationCount === "number") ? p.citationCount : 0,
      doi: cleanText(ext.DOI || ""),
      paperId: cleanText(p && p.paperId),
      abstract: String((p && p.abstract) || "").trim(),
    };
  }

  /** HTTP 异常 → 可读原因（不抛） */
  function classify(e) {
    var status = e && (e.status || (e.response && e.response.status));
    var msg = String((e && (e.message || e)) || "");
    if (status === 429) return { ok: false, reason: "rate_limit", error: "Semantic Scholar 限流（429），请稍后重试" };
    if (status === 403 || status === 401) return { ok: false, reason: "auth", error: "Semantic Scholar 拒绝了请求（HTTP " + status + "），请检查 API Key" };
    if (status >= 500) return { ok: false, reason: "server", error: "Semantic Scholar 服务异常（HTTP " + status + "）" };
    if (/NS_ERROR|NetworkError|network|timed out|timeout|offline/i.test(msg)) {
      return { ok: false, reason: "network", error: "网络不可用，无法连接 Semantic Scholar" };
    }
    if (status) return { ok: false, reason: "http", error: "Semantic Scholar 请求失败（HTTP " + status + "）" };
    return { ok: false, reason: "network", error: "无法连接 Semantic Scholar：" + (msg || "未知错误") };
  }

  /**
   * 相关文献推荐。
   * @param {string} paperKey  DOI / "DOI:10.x/y" / CorpusId / S2 paperId
   * @param {number} [limit=5]
   * @returns {Promise<Array|{ok:false, error:string, reason:string}>}
   *   成功 = 归一后的数组（可能为空数组）；失败 = 明确错误对象，**绝不抛**。
   */
  S2.recommendations = S2.recommendations || async function (paperKey, limit) {
    var id = normalizeId(paperKey);
    if (!id) return { ok: false, reason: "no_id", error: "缺少可用于推荐的 paperId" };

    var n = parseInt(limit, 10);
    if (!isFinite(n) || n <= 0) n = 5;
    n = Math.min(n, 100);

    var key = id + "|" + n;
    var hit = cache.get(key);
    if (hit && Date.now() - hit.t < CACHE_TTL) return hit.list.slice();

    var url = (S2.RECS_API || RECS_API) + encodeURIComponent(id)
      + "?fields=" + encodeURIComponent(S2.RECS_FIELDS || RECS_FIELDS)
      + "&limit=" + n;

    try {
      await throttle(apiKey() ? 250 : 1100);
      var req = await request(url, 25000);
      var data = req && req.response;
      var recs = (data && Array.isArray(data.recommendedPapers)) ? data.recommendedPapers : [];
      var list = [];
      for (var i = 0; i < recs.length; i++) {
        var one = normalize(recs[i]);
        if (one.title) list.push(one);
      }
      list = list.slice(0, n);
      if (cache.size >= CACHE_MAX) {
        // 简单 LRU：先删最旧的一条（Map 保持插入序，命中时会重插）
        var oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
      cache.set(key, { t: Date.now(), list: list.slice() });
      return list;
    } catch (e) {
      return classify(e);
    }
  };

  /** 测试与排障用：清掉内存缓存/限速时间戳 */
  S2._recsReset = S2._recsReset || function () {
    cache.clear();
    lastAt = 0;
    queue = Promise.resolve();
  };

  /* ---------------- citations：施引文献 + 引用句（0.52.0） ----------------
   *
   * 与 recommendations 共用同一条链路：_req 竞速超时 / _headers 注入 key /
   * 串行限速（有 key 250ms、无 key 1100ms）/ 同一个 LRU（10 分钟、50 条）。
   * 差别只在端点与归一形态：这里要的是**引用句**（contexts）与作者意图
   * （intents / isInfluential），供 CitationContext 判定「支持 / 对比 / 批评 / 中性」。
   */

  var CITE_API = "https://api.semanticscholar.org/graph/v1/paper/";
  var CITE_FIELDS = "title,year,authors,contexts,intents,isInfluential";

  S2.CITE_API = S2.CITE_API || CITE_API;
  S2.CITE_FIELDS = S2.CITE_FIELDS || CITE_FIELDS;

  /** 施引文献归一：S2 的 [{citingPaper, contexts, intents, isInfluential}] → 扁平条目 */
  function normalizeCite(c) {
    var citing = (c && c.citingPaper) || {};
    var names = [];
    var rawAuthors = (citing && citing.authors) || [];
    for (var i = 0; i < rawAuthors.length; i++) {
      var n = cleanText(rawAuthors[i] && rawAuthors[i].name);
      if (n) names.push(n);
    }
    var ctx = [];
    var rawCtx = (c && c.contexts) || [];
    for (var j = 0; j < rawCtx.length; j++) {
      var s = cleanText(rawCtx[j]);
      if (s) ctx.push(s);
    }
    var intents = [];
    var rawIntents = (c && c.intents) || [];
    for (var k = 0; k < rawIntents.length; k++) {
      var v = cleanText(rawIntents[k]).toLowerCase();
      if (v) intents.push(v);
    }
    var year = parseInt(citing && citing.year, 10);
    return {
      title: cleanText(citing && citing.title),
      year: isFinite(year) ? year : 0,
      authors: names.join(", "),
      contexts: ctx,
      intents: intents,
      isInfluential: !!(c && c.isInfluential),
    };
  }

  if (!S2._citationsExtended) {
    // 旧实现：semantic-scholar.js 的 citations(paperId, fields, limit) → [{citingPaper}]
    var legacyCitations = (typeof S2.citations === "function") ? S2.citations : null;
    S2._citationsLegacy = legacyCitations;

    /**
     * 施引文献 + 引用句。
     *   双模：citations(id) / citations(id, "fields", n) → 旧实现（citation-trace 用）
     *         citations(id, 20)                        → 新归一结果
     * @param {string} paperKey DOI / DOI: / arXiv / CorpusId / S2 paperId
     * @param {number} [limit=20]
     * @returns {Promise<Array|{ok:false, reason:string, error:string}>}
     *   成功 = 归一数组（可能为空）；失败 = 明确错误对象，**绝不抛**。
     */
    S2.citations = async function (paperKey, limit) {
      if (legacyCitations && (arguments.length < 2 || typeof limit === "string")) {
        return legacyCitations.apply(S2, arguments);
      }

      var id = normalizeId(paperKey);
      if (!id) return { ok: false, reason: "no_id", error: "缺少可用于查询引文的 paperId" };

      var n = parseInt(limit, 10);
      if (!isFinite(n) || n <= 0) n = 20;
      n = Math.min(n, 1000); // S2 该端点上限 1000

      var key = "cit:" + id + "|" + n;
      var hit = cache.get(key);
      if (hit && Date.now() - hit.t < CACHE_TTL) return hit.list.slice();

      var url = (S2.CITE_API || CITE_API) + encodeURIComponent(id)
        + "/citations?fields=" + encodeURIComponent(S2.CITE_FIELDS || CITE_FIELDS)
        + "&limit=" + n;

      try {
        await throttle(apiKey() ? 250 : 1100);
        var req = await request(url, 25000);
        var data = req && req.response;
        var rows = (data && Array.isArray(data.data)) ? data.data : [];
        var list = [];
        for (var i = 0; i < rows.length; i++) {
          var one = normalizeCite(rows[i]);
          if (one.title) list.push(one);
        }
        list = list.slice(0, n);
        if (cache.size >= CACHE_MAX) {
          var oldest = cache.keys().next();
          if (!oldest.done) cache.delete(oldest.value);
        }
        cache.set(key, { t: Date.now(), list: list.slice() });
        return list;
      } catch (e) {
        return classify(e);
      }
    };
    S2._citationsExtended = true;
  }

  /** 测试与排障用：清掉引文缓存（与 recommendations 共用 cache，故一并清） */
  S2._citationsReset = function () {
    cache.clear();
    lastAt = 0;
    queue = Promise.resolve();
  };
})(typeof S2Client !== "undefined" ? S2Client : null);
