"use strict";

/**
 * arXiv 客户端：把「查询构建 → 限速 → 重试 → 分页 → 解析 → 去重 → 缓存/增量 → 可选增强」
 * 串成一条可测试的流水线。
 *
 * 可测试性的关键设计：**transport / limiter / cache / state / sleep / backoff 全部可注入**。
 * 因此测试可以：起一个本地 http 桩服务器，注入指向 127.0.0.1 的 baseUrl，
 * 就能在不碰外网的前提下覆盖分页、重试、限速、缓存命中、增量更新等全部分支。
 */

const { loadConfig } = require("./config");
const { createTransport } = require("./http");
const { RateLimiter, sleep, backoffDelay } = require("./rate-limiter");
const { Cache, StateStore } = require("./cache");
const { buildQuery, buildUrl, encodeQuery } = require("./query");
const { parseAtom, dedupeEntries, detectErrorEntry, extractApiError } = require("./atom");
const { ConfigError, UsageError, ApiError, HttpError, RateLimitError } = require("./errors");
const { nullLogger } = require("./logger");
const { fetchVersionHistory } = require("./version-history");
const { fetchReferences, fetchCitations } = require("./references");

/** arXiv 分页总量硬上限：超过会返回 HTTP 400。 */
const MAX_START = 30000;

function clamp(n, lo, hi) {
  const v = Number(n);
  if (!isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

class ArxivClient {
  /**
   * @param {{config?:object, configOverrides?:object, transport?:Function, logger?:object,
   *          cache?:Cache|null, state?:StateStore|null, limiter?:RateLimiter,
   *          sleep?:Function, backoff?:Function, now?:Function}} [opts]
   */
  constructor(opts) {
    const o = opts || {};
    this.config = o.config || loadConfig({ cli: o.configOverrides || {} });
    this.log = o.logger || nullLogger();
    this._now = o.now || (() => Date.now());
    this._sleep = o.sleep || sleep;
    this._backoff = o.backoff || ((attempt) => backoffDelay(attempt, this.config.request.backoffBaseMs, this.config.request.backoffMaxMs));
    this._requests = 0;
    this._fromCache = 0;
    this._lastUrl = "";

    this.transport = o.transport || createTransport({
      userAgent: this.config.api.userAgent,
      timeoutMs: this.config.request.timeoutMs,
    });

    this.limiter = o.limiter || new RateLimiter({
      minIntervalMs: this.config.request.minIntervalMs,
      maxConcurrent: this.config.request.maxConcurrent,
    });

    // 第三方（S2）用独立限速器：额度更紧，不能与 arXiv 共用节奏
    this.s2Limiter = new RateLimiter({
      minIntervalMs: this.config.enrich.s2MinIntervalMs,
      maxConcurrent: 1,
    });

    if (o.cache !== undefined) this.cache = o.cache;
    else this.cache = this.config.cache.enabled
      ? new Cache({ dir: this.config.cache.dir, ttlMs: this.config.cache.ttlMs, maxEntries: this.config.cache.maxEntries, logger: this.log })
      : null;

    if (o.state !== undefined) this.state = o.state;
    else this.state = this.config.cache.enabled ? new StateStore({ dir: this.config.cache.dir, logger: this.log }) : null;
  }

  get requestCount() { return this._requests; }

  stats() {
    return {
      requests: this._requests,
      cacheHits: this._fromCache,
      limiter: this.limiter.stats,
      cache: this.cache ? this.cache.stats() : { enabled: false },
      state: this.state ? this.state.summary() : { enabled: false },
    };
  }

  /** 组装单页 URL（供 --dry-run / 调试用）。 */
  urlFor(params) {
    return buildUrl(Object.assign({
      baseUrl: this.config.api.baseUrl,
      sortBy: this.config.search.sortBy,
      sortOrder: this.config.search.sortOrder,
    }, params || {}));
  }

  /**
   * 单次请求 + 重试。这是所有网络访问的**唯一出口**（便于统计与限速）。
   * @returns {Promise<{status:number, headers:object, body:string, attempts:number, url:string}>}
   */
  async _request(url, opts) {
    const o = opts || {};
    const retries = o.retries == null ? this.config.request.retries : Math.max(0, Number(o.retries) || 0);
    const timeoutMs = o.timeoutMs || this.config.request.timeoutMs;
    let attempt = 0;
    let lastErr = null;
    this._lastUrl = url;

    while (attempt <= retries) {
      attempt++;
      let retryAfterMs = 0;
      try {
        const res = await this.limiter.run(() => this.transport(url, { timeoutMs }));
        this._requests++;
        this.log.debug("HTTP 响应", { status: res.status, attempt, url: url.length > 140 ? url.slice(0, 140) + "…" : url });

        if (res.status >= 200 && res.status < 300) return Object.assign(res, { attempts: attempt, url });

        if (res.status === 400) {
          const msg = extractApiError(res.body);
          if (msg) {
            throw new ApiError("arXiv 拒绝了该查询：" + msg, {
              status: 400,
              hint: "检查检索语法（分类大小写敏感、括号需成对、日期区间形如 submittedDate:[202401010000 TO 202401312359]）",
              details: { url, body: String(res.body || "").slice(0, 500) },
            });
          }
          throw new HttpError("HTTP 400（arXiv 未给出说明）", 400, { details: { url } });
        }

        if (res.status === 429 || res.status === 503) {
          const ra = res.headers && (res.headers["retry-after"] || res.headers["Retry-After"]);
          retryAfterMs = ra ? (isFinite(Number(ra)) ? Number(ra) * 1000 : 15000) : 0;
          throw new RateLimitError("触发限速（HTTP " + res.status + "）", { status: res.status, details: { url, retryAfterMs } });
        }

        throw new HttpError("HTTP " + res.status + "：" + url, res.status, { details: { url } });
      } catch (e) {
        lastErr = e;
        const retryable = e && e.retryable;
        if (!retryable || attempt > retries) break;
        const delay = retryAfterMs || this._backoff(attempt);
        this.log.warn("请求失败，准备重试", { attempt, of: retries + 1, delayMs: Math.round(delay), error: e.message });
        await this._sleep(delay);
      }
    }
    throw lastErr || new HttpError("请求失败：" + url, 0);
  }

  /**
   * 检索。
   * @param {object} spec buildQuery 的 spec
   * @param {{limit?:number, pageSize?:number, maxPages?:number, sortBy?:string, sortOrder?:string,
   *          cache?:boolean, refresh?:boolean, cacheTtlMs?:number, retries?:number}} [opts]
   */
  async search(spec, opts) {
    const o = opts || {};
    const started = this._now();
    const built = buildQuery(spec);
    if (built.isEmpty) {
      throw new UsageError("没有可执行的检索条件", { hint: "至少提供 --keyword / --author / --category / --id / --query 之一" });
    }

    const cfg = this.config.search;
    const limit = clamp(o.limit == null ? cfg.maxResults : o.limit, 1, 30000);
    const pageSize = clamp(o.pageSize == null ? cfg.pageSize : o.pageSize, 1, 2000);
    const maxPages = clamp(o.maxPages == null ? cfg.maxPages : o.maxPages, 1, 500);
    const sortBy = o.sortBy || cfg.sortBy;
    const sortOrder = o.sortOrder || cfg.sortOrder;

    const cacheKey = this._cacheKey({ built, limit, pageSize, sortBy, sortOrder });
    const useCache = o.cache !== false && !!this.cache && !o.refresh;
    if (useCache) {
      const hit = this.cache.get(cacheKey);
      if (hit) {
        this._fromCache++;
        this.log.info("命中缓存", { fetchedAt: hit.fetchedAt, ageMin: Math.round(hit.ageMs / 60000) });
        return Object.assign({}, hit.value, { fromCache: true, cacheAgeMs: hit.ageMs, elapsedMs: this._now() - started });
      }
    }

    const raw = [];
    const duplicates = [];
    let totalResults = 0;
    let pages = 0;
    let start = 0;
    let firstUrl = "";

    while (pages < maxPages && raw.length < limit && start < MAX_START) {
      const maxResults = Math.min(pageSize, limit - raw.length, MAX_START - start);
      const url = this.urlFor({
        searchQuery: built.encoded,
        idList: built.idList,
        start,
        maxResults,
        sortBy,
        sortOrder,
      });
      if (!firstUrl) firstUrl = url;

      const res = await this._request(url, { retries: o.retries });
      const parsed = parseAtom(res.body);
      pages++;
      if (pages === 1) {
        totalResults = parsed.meta.totalResults || parsed.entries.length;
        this.log.info("开始检索", { total: totalResults, url: url.length > 120 ? url.slice(0, 120) + "…" : url });
      }
      if (!parsed.entries.length) break;

      raw.push.apply(raw, parsed.entries);
      // ★ 用「服务端实际返回条数」推进游标，而不是请求的条数：
      // 请求 100 条只回 30 条时若按 100 推进，会静默跳过后面的结果。
      start += parsed.entries.length;
      this.log.debug("已获取分页", { page: pages, got: parsed.entries.length, total: raw.length, start });

      if (parsed.entries.length < maxResults) break;   // 服务端给不满 = 到底了
      if (totalResults && start >= totalResults) break;
    }

    const dedup = dedupeEntries(raw, this.config.dedupe);

    const result = {
      query: built.query,
      encodedQuery: built.encoded,
      idList: built.idList,
      url: firstUrl,
      sortBy,
      sortOrder,
      totalResults,
      fetched: raw.length,
      pages,
      duplicatesRemoved: dedup.removed,
      duplicates: dedup.duplicates.slice(0, 50),
      entries: dedup.entries,
      generatedAt: new Date(this._now()).toISOString(),
      fromCache: false,
      elapsedMs: 0,
    };

    if (useCache && this.cache) this.cache.set(cacheKey, result, { ttlMs: o.cacheTtlMs });
    result.elapsedMs = this._now() - started;
    return result;
  }

  /** 便捷：直接传原始查询串。 */
  searchRaw(rawQuery, opts) { return this.search({ raw: rawQuery }, opts); }

  /**
   * 逐页流式检索（供上层边抓边展示；不会把全部结果堆在内存里再返回）。
   * @param {object} spec
   * @param {{limit?:number, pageSize?:number, maxPages?:number, sortBy?:string, sortOrder?:string, retries?:number}} [opts]
   * @yields {{page:number, start:number, totalResults:number, entries:Array, url:string}}
   */
  async *streamSearch(spec, opts) {
    const o = opts || {};
    const built = buildQuery(spec);
    if (built.isEmpty) throw new UsageError("没有可执行的检索条件");
    const cfg = this.config.search;
    const limit = clamp(o.limit == null ? cfg.maxResults : o.limit, 1, 30000);
    const pageSize = clamp(o.pageSize == null ? cfg.pageSize : o.pageSize, 1, 2000);
    const maxPages = clamp(o.maxPages == null ? cfg.maxPages : o.maxPages, 1, 500);
    const sortBy = o.sortBy || cfg.sortBy;
    const sortOrder = o.sortOrder || cfg.sortOrder;

    let start = 0;
    let page = 0;
    let seen = 0;
    let totalResults = 0;
    while (page < maxPages && seen < limit && start < MAX_START) {
      const maxResults = Math.min(pageSize, limit - seen, MAX_START - start);
      const url = this.urlFor({ searchQuery: built.encoded, idList: built.idList, start, maxResults, sortBy, sortOrder });
      const res = await this._request(url, { retries: o.retries });
      const parsed = parseAtom(res.body);
      page++;
      if (page === 1) totalResults = parsed.meta.totalResults || parsed.entries.length;
      if (!parsed.entries.length) return;
      seen += parsed.entries.length;
      yield { page, start, totalResults, entries: parsed.entries, url };
      start += parsed.entries.length;
      if (parsed.entries.length < maxResults) return;
      if (totalResults && start >= totalResults) return;
    }
  }

  /**
   * 按 arXiv ID 精确获取（自动分批，避免一次塞几百个 ID 触发 URL 过长/服务端截断）。
   * @param {string|string[]} ids
   * @param {{batchSize?:number, retries?:number, cache?:boolean, refresh?:boolean}} [opts]
   */
  async getByIds(ids, opts) {
    const o = opts || {};
    const list = (Array.isArray(ids) ? ids : String(ids || "").split(/[\s,;]+/))
      .map((x) => String(x || "").trim())
      .map((x) => x.replace(/^https?:\/\/(www\.)?arxiv\.org\/(abs|pdf)\//i, "").replace(/\.pdf$/i, ""))
      .filter(Boolean);
    if (!list.length) throw new UsageError("未提供 arXiv ID", { hint: "示例：--id 2501.00001,2501.00002" });

    const batchSize = clamp(o.batchSize || 100, 1, 200);
    const started = this._now();
    const entries = [];
    const batches = [];
    let pages = 0;

    for (let i = 0; i < list.length; i += batchSize) {
      const batch = list.slice(i, i + batchSize);
      const cacheKey = "ids:v1:" + batch.join(",");
      const useCache = o.cache !== false && !!this.cache && !o.refresh;
      if (useCache) {
        const hit = this.cache.get(cacheKey);
        if (hit) { this._fromCache++; entries.push.apply(entries, hit.value.entries); batches.push({ ids: batch, fromCache: true, count: hit.value.entries.length }); continue; }
      }
      const url = this.urlFor({ searchQuery: "", idList: batch.join(","), start: 0, maxResults: batch.length });
      const res = await this._request(url, { retries: o.retries });
      const parsed = parseAtom(res.body);
      pages++;
      const got = dedupeEntries(parsed.entries, this.config.dedupe).entries;
      entries.push.apply(entries, got);
      batches.push({ ids: batch, fromCache: false, count: got.length });
      if (useCache && this.cache) this.cache.set(cacheKey, { entries: got });
    }

    const dedup = dedupeEntries(entries, this.config.dedupe);
    const missing = list.filter((id) => {
      const base = id.replace(/v\d+$/, "");
      return !dedup.entries.some((e) => e.baseId === base || e.arxivId === base);
    });

    return {
      requested: list.length,
      totalResults: dedup.entries.length,
      fetched: entries.length,
      pages,
      duplicatesRemoved: dedup.removed,
      missing,
      entries: dedup.entries,
      batches,
      generatedAt: new Date(this._now()).toISOString(),
      elapsedMs: this._now() - started,
    };
  }

  /**
   * 增量更新：只返回「上次运行之后出现的新提交 / 新版本」。
   *
   * 判据同时用两条，缺一不可：
   *   ① `baseId@version` 未见过（覆盖「老论文出了 v2」这种情况，仅比对 id 会漏）；
   *   ② 结果按 lastUpdatedDate 降序，遇到 updated ≤ 上次运行时间即可提前停止，避免翻完全部页。
   */
  async update(spec, opts) {
    const o = opts || {};
    if (!this.state) throw new ConfigError("增量更新需要启用缓存目录（cache.enabled=true）来保存状态");
    const built = buildQuery(spec);
    if (built.isEmpty) throw new UsageError("没有可执行的检索条件");

    const key = o.sourceKey || ("update:" + (built.encoded || built.idList));
    const seen = this.state.seenIds(key);
    const lastRunAt = this.state.lastRunAt(key);
    const firstRun = !lastRunAt;
    const lastRunMs = lastRunAt ? Date.parse(lastRunAt) : 0;

    const res = await this.search(spec, Object.assign({}, o, {
      sortBy: "lastUpdatedDate",
      sortOrder: "descending",
      cache: false,
      refresh: true,
    }));

    const fresh = [];
    let stoppedEarly = false;
    for (const e of res.entries) {
      const stamp = e.baseId + "@" + (e.version || 1);
      const updatedMs = Date.parse(e.updated || e.published || "");
      if (!firstRun && isFinite(updatedMs) && updatedMs <= lastRunMs) {
        stoppedEarly = true;
        break;
      }
      if (!seen.has(stamp) && !seen.has(e.baseId)) fresh.push(e);
    }

    this.state.markSeen(key, res.entries.map((e) => e.baseId + "@" + (e.version || 1)));
    this.state.touch(key);
    // ★ 必须显式落盘：StateStore 的 markSeen/touch 只改内存（便于批量更新后一次写），
    // 忘了这一步会导致「每次运行都是首次运行」——同一进程内的连续调用看不出来，
    // 跨进程（CLI 每次一个新进程）才会暴露，属于典型的测试假通过。
    this.state.save();

    return {
      sourceKey: key,
      firstRun,
      since: lastRunAt || "",
      scanned: res.entries.length,
      scannedPages: res.pages,
      stoppedEarly,
      newCount: fresh.length,
      entries: fresh,
      query: built.query,
      generatedAt: new Date(this._now()).toISOString(),
      elapsedMs: res.elapsedMs,
    };
  }

  /**
   * 可选增强：补版本历史（arXiv abs 页）与参考文献/被引（Semantic Scholar）。
   * 任何单条失败都只记录并跳过，不抛出。
   * @param {Array<object>} entries
   * @param {{versions?:boolean, references?:boolean, citations?:boolean, limit?:number}} [opts]
   */
  async enrich(entries, opts) {
    const o = opts || {};
    const wantV = o.versions != null ? o.versions : this.config.enrich.versionHistory;
    const wantR = o.references != null ? o.references : this.config.enrich.references;
    const wantC = o.citations != null ? o.citations : this.config.enrich.citations;
    if (!wantV && !wantR && !wantC) return entries || [];

    const cap = clamp(o.limit == null ? 20 : o.limit, 1, 200);
    const out = [];
    let i = 0;
    for (const e of entries || []) {
      const copy = Object.assign({}, e);
      if (i++ < cap && (e.baseId || e.arxivId)) {
        const id = e.baseId || e.arxivId;
        if (wantV) {
          const vh = await this.limiter.run(() => fetchVersionHistory(id, {
            transport: this.transport,
            logger: this.log,
            absBaseUrl: this.config.api.absBaseUrl,
          }));
          copy.versionHistory = vh;
          copy.versionCount = vh.count;
        }
        if (wantR) {
          const refs = await this.s2Limiter.run(() => fetchReferences(id, { transport: this.transport, logger: this.log, s2BaseUrl: this.config.enrich.s2BaseUrl }));
          copy.references = refs.items;
          copy.referenceCount = refs.ok ? refs.total : null;
          copy.referencesError = refs.ok ? "" : refs.reason;
        }
        if (wantC) {
          const cits = await this.s2Limiter.run(() => fetchCitations(id, { transport: this.transport, logger: this.log, s2BaseUrl: this.config.enrich.s2BaseUrl }));
          copy.citations = cits.items;
          copy.citationCount = cits.ok ? cits.total : null;
          copy.citationsError = cits.ok ? "" : cits.reason;
        }
      }
      out.push(copy);
    }
    return out;
  }

  /** 连通性自检：拉 1 条，返回是否可以正常访问 arXiv。 */
  async probe() {
    const url = this.urlFor({ searchQuery: encodeQuery("cat:cs.LG"), start: 0, maxResults: 1 });
    const res = await this._request(url, { retries: 0 });
    const parsed = parseAtom(res.body);
    return { ok: true, status: res.status, totalResults: parsed.meta.totalResults, sample: parsed.entries[0] || null, url };
  }

  _cacheKey(parts) {
    const payload = JSON.stringify({
      q: parts.built.encoded,
      ids: parts.built.idList,
      limit: parts.limit,
      pageSize: parts.pageSize,
      sortBy: parts.sortBy,
      sortOrder: parts.sortOrder,
      ver: 2,
    });
    const crypto = require("crypto");
    return "search:" + crypto.createHash("sha1").update(payload).digest("hex");
  }
}

/** 工厂：一步拿到配置好的 client。 */
function createClient(opts) {
  const o = opts || {};
  const config = o.config || loadConfig({ cli: o.configOverrides || {}, env: o.env, cwd: o.cwd, configPath: o.configPath });
  return new ArxivClient(Object.assign({}, o, { config }));
}

module.exports = { ArxivClient, createClient, extractApiError, detectErrorEntry, MAX_START };
