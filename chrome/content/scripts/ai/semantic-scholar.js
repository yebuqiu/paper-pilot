// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot Semantic Scholar Graph API 客户端（0.6.0 新增，0.8.0 加应用层超时）
 * 免费公开接口，无需注册；有 API Key 限速更高（在设置中填写 s2ApiKey）。
 * 文档：https://api.semanticscholar.org/api-docs/
 * 端点：
 *  - GET  /graph/v1/paper/{paperId}?fields=...   单查（paperId 形如 DOI:10.x/xx、ARXIV:xxxx、CorpusId:xxx）
 *  - POST /graph/v1/paper/batch?fields=...       批量（ids 数组，最多 500，响应与请求对齐，未命中为 null）
 *  - GET  /graph/v1/paper/search?query=...       标题检索（无 DOI 时的兜底）
 *
 * ⚠️ 为什么有 _req 竞速超时（0.8.0 实证）：Firefox 每主机连接数有限（~6），
 * S2 限流时服务器会长时间挂起连接不回数据；挂起的 XHR 占满连接池后，
 * 新请求在队列里【永不发出】，XHR timeout 不生效，await 永不返回，
 * 功能层面表现为"彻底卡死无报错"。应用层 Promise.race 至少让调用方能脱身。
 */
/* global Zotero, Prefs */

var S2Client = {
  API: "https://api.semanticscholar.org/graph/v1",
  FIELDS: "title,year,venue,citationCount,influentialCitationCount,externalIds,authors,url,openAccessPdf",

  _apiKey() {
    return String(Prefs.get("s2ApiKey", "") || "").trim();
  },

  _headers(extra) {
    const h = Object.assign({}, extra || {});
    const k = this._apiKey();
    if (k) h["x-api-key"] = k;
    return h;
  },

  /** 应用层超时包装：ms 后无论底层 XHR 是否完成都 reject，防止连接池耗尽卡死 */
  _req(method, url, opts, appTimeoutMs) {
    const ms = appTimeoutMs || 25000;
    return Promise.race([
      Zotero.HTTP.request(method, url, opts),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("S2 请求应用层超时（" + Math.round(ms / 1000) + "s），可能限流，请稍后重试")), ms)
      ),
    ]);
  },

  /** 单查：paperId 如 "DOI:10.1038/nature12373" */
  async paperById(paperId, fields) {
    const url = this.API + "/paper/" + encodeURIComponent(paperId)
      + "?fields=" + encodeURIComponent(fields || this.FIELDS);
    const req = await this._req("GET", url, {
      responseType: "json",
      timeout: 20000,
      headers: this._headers(),
    });
    return req.response;
  },

  /** 批量：ids 形如 ["DOI:10.x/a", "ARXIV:2101.00001"]，最多 500 条 */
  async batch(ids, fields) {
    const url = this.API + "/paper/batch?fields=" + encodeURIComponent(fields || this.FIELDS);
    const req = await this._req("POST", url, {
      body: JSON.stringify({ ids }),
      headers: this._headers({ "Content-Type": "application/json" }),
      responseType: "json",
      timeout: 45000,
    }, 50000);
    return Array.isArray(req.response) ? req.response : [];
  },

  /** 标题检索，返回候选数组 */
  async searchByTitle(title, limit, fields) {
    const url = this.API + "/paper/search?query=" + encodeURIComponent(title)
      + "&limit=" + (limit || 5)
      + "&fields=" + encodeURIComponent(fields || this.FIELDS);
    const req = await this._req("GET", url, {
      responseType: "json",
      timeout: 20000,
      headers: this._headers(),
    });
    return (req.response && req.response.data) || [];
  },

  /** 参考文献（本文引用的）：返回 [{citedPaper:{...}}] */
  async references(paperId, fields, limit) {
    return this._linked(paperId, "references", fields, limit);
  },

  /** 施引文献（谁引用了本文）：返回 [{citingPaper:{...}}] */
  async citations(paperId, fields, limit) {
    return this._linked(paperId, "citations", fields, limit);
  },

  async _linked(paperId, kind, fields, limit) {
    const url = this.API + "/paper/" + encodeURIComponent(paperId) + "/" + kind
      + "?fields=" + encodeURIComponent(fields || this.FIELDS)
      + "&limit=" + (limit || 200);
    const req = await this._req("GET", url, {
      responseType: "json",
      timeout: 30000,
      headers: this._headers(),
    }, 35000);
    return (req.response && req.response.data) || [];
  },
};
