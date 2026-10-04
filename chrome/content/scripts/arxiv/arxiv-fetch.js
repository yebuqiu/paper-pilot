/* PaperPilot arXiv 抓取适配层（0.25.0）
 *
 * 这是「Node 工具包 → Zotero 插件」的**唯一接缝**。
 *
 * 设计：`chrome/content/scripts/arxiv/arxiv-*.js` 是从 `tools/arxiv/src/` **生成**的纯核心
 * （查询构建 / Atom 解析 / 去重 / 限速器，单一真源在 tools 侧，改逻辑改源文件后重跑
 * `python scripts/build-arxiv-core.py`）。这里只把两件环境相关的事换掉：
 *
 *   传输：node http/https   →  Zotero.HTTP.request
 *   节奏：由 ArxivRateLimiter 保证「任意两次请求启动间隔 ≥ 3 秒」——arXiv 官方礼节
 *         （每 3 秒不超过 1 次、同时只保持 1 条连接），越界会被临时封 IP。
 *
 * ⚠️ 两个本仓库踩过的坑，务必保持：
 *   1. `Zotero.HTTP.request` 对 4xx/5xx **不抛异常**（只解析网络层错误），
 *      必须自己判 `req.status`；否则 400/503 会被当成「0 条结果」静默吞掉。
 *   2. Zotero 的 `timeout` 是 socket 空闲超时，不是总时限；挂起的请求会占满连接池，
 *      导致后续请求永不发出。所以额外加应用层计时器竞速（仓库内既有做法）。
 */
/* global Zotero, ArxivErrors, ArxivQuery, ArxivAtom, ArxivRateLimiter */

var ArxivFetch = {
  API: "https://export.arxiv.org/api/query",
  UA: "PaperPilot/1.0 (+https://github.com/yebuqiu/paper-pilot)",

  DEFAULTS: {
    minIntervalMs: 3000,
    timeoutMs: 30000,
    retries: 3,
    backoffBaseMs: 1200,
    backoffMaxMs: 20000,
    pageSize: 100,
    maxItems: 200,
    maxPages: 5,
    sortBy: "submittedDate",
    sortOrder: "descending",
  },

  _limiter: null,
  _opts: null,
  _stats: { requests: 0, retries: 0, failures: 0, rateLimited: 0, lastStatus: 0 },

  /** 运行期可覆盖节奏参数（例如设置面板里改「最小请求间隔」）。传空则回落默认。 */
  configure(opts) {
    const o = opts || {};
    this._opts = Object.assign({}, this.DEFAULTS, this._opts || {}, o);
    this._limiter = null;   // 重建限速器，让新间隔立即生效
    return this._opts;
  },

  options() {
    if (!this._opts) this._opts = Object.assign({}, this.DEFAULTS);
    return this._opts;
  },

  limiter() {
    if (!this._limiter) {
      const o = this.options();
      // 单连接 + 最小启动间隔：这才是 arXiv 要的「频率」约束（信号量只管并发数）
      this._limiter = new ArxivRateLimiter.RateLimiter({
        minIntervalMs: o.minIntervalMs,
        maxConcurrent: 1,
      });
    }
    return this._limiter;
  },

  stats() { return Object.assign({ pending: 0 }, this._stats); },

  resetStats() {
    this._stats = { requests: 0, retries: 0, failures: 0, rateLimited: 0, lastStatus: 0 };
  },

  /* ---------------- 网络 ---------------- */

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms || 0)));
  },

  /** 指数退避 + 全抖动（与 CLI 侧同款策略：打散多客户端同时重试的尖峰）。 */
  _backoff(attempt) {
    const o = this.options();
    const cap = Math.min(o.backoffMaxMs, o.backoffBaseMs * Math.pow(2, Math.max(0, attempt - 1)));
    return Math.floor(Math.random() * cap);
  },

  /**
   * 单次请求（不含重试）。返回 `{status, text}` —— 4xx/5xx 也走正常返回，由上层判状态。
   */
  async _once(url) {
    const o = this.options();
    const timeoutMs = o.timeoutMs;
    const req = await Promise.race([
      Zotero.HTTP.request("GET", url, {
        responseType: "text",
        timeout: timeoutMs,
        headers: {
          "User-Agent": this.UA,
          Accept: "application/atom+xml, application/xml;q=0.9, */*;q=0.1",
        },
      }),
      new Promise((_, rej) => setTimeout(
        () => rej(new Error("arXiv 请求应用层超时（" + Math.round(timeoutMs / 1000) + "s）")),
        timeoutMs + 1000
      )),
    ]);
    return {
      status: Number(req && req.status) || 0,
      text: String((req && (req.responseText || req.response)) || ""),
    };
  },

  /** 失败分类：只有网络层/5xx/429 值得重试；400 是查询本身的问题，重试无意义。 */
  _classify(status, text, url) {
    const E = ArxivErrors;
    if (status >= 200 && status < 300) return null;
    if (status === 0) {
      const err = new E.NetworkError("arXiv 无响应（网络层失败）");
      err.retryable = true;
      return err;
    }
    if (status === 400) {
      const msg = ArxivAtom.extractApiError(text);
      if (msg) {
        return new E.ApiError("arXiv 拒绝了该查询：" + msg, {
          status: 400,
          hint: "分类代码区分大小写（cs.CL 合法，cs.cl 不合法）；括号需成对；日期区间形如 submittedDate:[202401010000 TO 202401312359]",
        });
      }
      return new E.HttpError("arXiv 返回 HTTP 400（查询被拒绝，未给出说明）", 400);
    }
    if (status === 429 || status === 503) {
      const err = new E.RateLimitError("触发 arXiv 限速（HTTP " + status + "）", { status });
      return err;
    }
    if (status >= 500) {
      return new E.HttpError("arXiv 服务端错误（HTTP " + status + "）", status);
    }
    return new E.HttpError("arXiv 请求失败（HTTP " + status + "）", status);
  },

  /** 请求 + 重试。成功返回响应文本。 */
  async _request(url) {
    const o = this.options();
    const maxRetries = Math.max(0, Number(o.retries) || 0);
    let attempt = 0;
    let lastErr = null;

    while (attempt <= maxRetries) {
      attempt++;
      try {
        const res = await this.limiter().run(() => this._once(url));
        this._stats.requests++;
        this._stats.lastStatus = res.status;
        const err = this._classify(res.status, res.text, url);
        if (!err) return res.text;
        throw err;
      } catch (e) {
        lastErr = e;
        const retryable = !!(e && e.retryable) || e instanceof Error && /超时|timeout|NetworkError/i.test(String(e.message || ""));
        if (!retryable || attempt > maxRetries) break;
        if (e && e.code === "RATE_LIMIT") this._stats.rateLimited++;
        this._stats.retries++;
        const delay = this._backoff(attempt);
        try {
          Zotero.debug("[paperpilot] arxiv retry " + attempt + "/" + maxRetries + " in " + Math.round(delay) + "ms: " + (e && e.message));
        } catch (ignored) { /* ignore */ }
        await this._sleep(delay);
      }
    }
    this._stats.failures++;
    const e = lastErr || new ArxivErrors.NetworkError("arXiv 请求失败");
    if (!(e instanceof Error)) return Promise.reject(new ArxivErrors.ArxivError("arXiv 请求失败"));
    throw e;
  },

  /* ---------------- 检索 ---------------- */

  /**
   * 检索（自动分页 + 去重）。
   *
   * @param {object} spec 检索条件，交给 ArxivQuery.buildQuery
   *        { keywords, authors, categories, ids, doi, dateFrom, dateTo, boolean, phrase, raw, ... }
   * @param {{limit?:number, pageSize?:number, maxPages?:number, sortBy?:string, sortOrder?:string}} [opts]
   * @returns {Promise<{entries:Array, totalResults:number, fetched:number, pages:number,
   *                    duplicatesRemoved:number, query:string, url:string, stopped:string}>}
   */
  async search(spec, opts) {
    const o = Object.assign({}, this.options(), opts || {});
    const built = ArxivQuery.buildQuery(spec || {});
    if (built.isEmpty) {
      throw new ArxivErrors.UsageError("没有可执行的检索条件", {
        hint: "至少给一个：分类（如 cs.LG）、关键词，或库内兴趣词",
      });
    }

    const limit = Math.max(1, Math.min(30000, Number(o.limit) || o.maxItems));
    const pageSize = Math.max(1, Math.min(2000, Number(o.pageSize) || 100));
    const maxPages = Math.max(1, Math.min(200, Number(o.maxPages) || 5));

    const raw = [];
    let start = 0;
    let pages = 0;
    let total = 0;
    let firstUrl = "";
    let stopped = "complete";

    while (pages < maxPages && raw.length < limit && start < 30000) {
      const maxResults = Math.min(pageSize, limit - raw.length, 30000 - start);
      const url = ArxivQuery.buildUrl({
        baseUrl: this.API,
        searchQuery: built.encoded,
        idList: built.idList,
        start: start,
        maxResults: maxResults,
        sortBy: o.sortBy,
        sortOrder: o.sortOrder,
      });
      if (!firstUrl) firstUrl = url;

      const text = await this._request(url);
      const parsed = ArxivAtom.parseAtom(text);
      pages++;
      if (pages === 1) total = parsed.meta.totalResults || parsed.entries.length;
      if (!parsed.entries.length) { stopped = "empty-page"; break; }

      for (const e of parsed.entries) raw.push(e);
      // 游标按「服务端实际返回条数」推进：请求 100 只回 30 时若按 100 推进会静默跳过结果
      start += parsed.entries.length;
      if (parsed.entries.length < maxResults) { stopped = "short-page"; break; }
      if (total && start >= total) { stopped = "reached-total"; break; }
    }

    const dedup = ArxivAtom.dedupeEntries(raw, { byId: true, byDoi: true, byTitle: true });
    return {
      query: built.query,
      encodedQuery: built.encoded,
      url: firstUrl,
      totalResults: total,
      fetched: raw.length,
      pages: pages,
      duplicatesRemoved: dedup.removed,
      entries: dedup.entries,
      stopped: stopped,
      fromCache: false,
    };
  },

  /* ---------------- 自检 ---------------- */

  /**
   * 离线自检（不联网）——在真实 Zotero 作用域里跑一遍「生成物是否可用」。
   *
   * 起因：生成物是**代码生成代码**的产物，一旦转换出错（例如把 `module.exports =`
   * 换成 `return =` 这种语法错误），插件里 `loadSubScript` 失败只会写一行 boot 日志、
   * 功能静默降级，光看界面根本发现不了。所以启动时跑一次纯本地的解析+构建断言，
   * 把结论写进 boot 日志，实机排查第一眼就能看到。
   *
   * @returns {string} 一行摘要，形如 `ok query=1 atom=2 dedupe=1 cat=1 rate=1`
   */
  selfTest() {
    const SAMPLE = "<?xml version='1.0' encoding='UTF-8'?>" +
      "<feed xmlns:arxiv='http://arxiv.org/schemas/atom' xmlns='http://www.w3.org/2005/Atom'>" +
      "<opensearch:totalResults xmlns:opensearch='http://a9.com/-/spec/opensearch/1.1/'>2</opensearch:totalResults>" +
      "<entry><id>http://arxiv.org/abs/2501.00001v2</id><title>Self &amp; Test</title>" +
      "<published>2025-01-01T00:00:00Z</published><updated>2025-03-01T00:00:00Z</updated>" +
      "<summary>Background: a. Methods: b. Results: c.</summary>" +
      "<category term='cs.LG'/><arxiv:primary_category term='cs.LG'/>" +
      "<author><name>Ada Lovelace</name></author></entry>" +
      "<entry><id>http://arxiv.org/abs/2501.00001v1</id><title>Self &amp; Test</title>" +
      "<published>2025-01-01T00:00:00Z</published><updated>2025-01-01T00:00:00Z</updated>" +
      "<summary>older version</summary><category term='cs.LG'/>" +
      "<author><name>Ada Lovelace</name></author></entry></feed>";

    const marks = [];
    const built = ArxivQuery.buildQuery({ keywords: ["self test"], categories: ["cs.LG"] });
    marks.push("query=" + (built.encoded === 'all:%22self+test%22+AND+cat:cs.LG' ? 1 : 0));

    const parsed = ArxivAtom.parseAtom(SAMPLE);
    marks.push("atom=" + (parsed.entries.length === 2 && parsed.meta.totalResults === 2 ? 1 : 0));

    const dd = ArxivAtom.dedupeEntries(parsed.entries, { byId: true, byDoi: true, byTitle: true });
    marks.push("dedupe=" + (dd.entries.length === 1 && dd.entries[0].version === 2 ? 1 : 0));

    marks.push("cat=" + (ArxivCategories.checkAll(["cs.LG", "cs.NLP"]).unknown.length === 1 ? 1 : 0));
    marks.push("rate=" + (typeof ArxivRateLimiter.RateLimiter === "function" ? 1 : 0));

    const bad = marks.filter((m) => /=\d+$/.test(m) && !/=[1-9]/.test(m));
    return (bad.length ? "FAIL " + marks.join(" ") : "ok " + marks.join(" ")) +
      " api=" + (this.API.indexOf("export.arxiv.org") > 0 ? 1 : 0);
  },
};
