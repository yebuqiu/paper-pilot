// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Zotero 数据访问：走「本地 API」而不是旧的 integration protocol
 *
 * 为什么换路：
 *   旧方案让 Zotero 驱动文字处理器（execCommand/respond），必须实现一整套 Word 域语义，
 *   还要处理它的事务挂起与 Host 校验。我们要的是**读条目、自己排版**，所以直接读
 *   Zotero 7+ 的本地只读 API（http://127.0.0.1:23119/api/users/0/…）更合适：
 *   - 结构化 JSON，字段与网页 API 一致，不用解析报告样式；
 *   - 只读，不会像 integration 那样把 Zotero 卡在半个事务里；
 *   - 排版权在我们手里，双向链接才有地方落。
 *
 * 前提：Zotero 设置 → 高级 → 勾选「允许此计算机上的其他应用程序与 Zotero 通信」
 *       （pref: httpServer.localAPI.enabled）。未开启时 API 返回 403，这里会给出人话提示。
 *
 * 所有请求都经本地代理（21932），因为 WPS 加载项在浏览器环境里会被跨源策略拦住。
 */
(function (root) {
  "use strict";

  const PROXY = "http://127.0.0.1:21932";
  const API_VER = "3";

  /** JSONP：script 标签不受 CORS 约束，作为 fetch 被拦时的兜底 */
  function jsonp(path) {
    return new Promise((resolve, reject) => {
      const cb = "ppcb" + Math.random().toString(36).slice(2, 10);
      const sc = document.createElement("script");
      let done = false;
      const timer = setTimeout(() => finish(new Error("JSONP 超时")), 8000);
      function finish(err, data) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { delete window[cb]; } catch (e) { window[cb] = undefined; }
        try { sc.remove(); } catch (e) { /* 已移除 */ }
        if (err) reject(err); else resolve(data);
      }
      window[cb] = (d) => finish(null, { __jsonp: true, value: d });
      sc.onerror = () => finish(new Error("JSONP 请求失败"));
      sc.src = PROXY + "/jsonp?fn=" + cb + "&p=" + encodeURIComponent(path);
      (document.head || document.documentElement).appendChild(sc);
    });
  }

  async function call(path, opts) {
    const o = opts || {};
    const res = await fetch(PROXY + path, {
      method: o.method || "GET",
      headers: Object.assign({ "Content-Type": "application/json" }, o.headers || {}),
      body: o.body ? JSON.stringify(o.body) : undefined,
      cache: "no-store",
    }).catch((e) => {
      // 只有 GET 能走 JSONP；写操作仍要求 fetch 可用
      if ((o.method || "GET").toUpperCase() !== "GET") throw e;
      return jsonp(path);
    });
    // JSONP 兜底返回的是 {__jsonp:true, value}，这里统一解包成数据本身，
    // 与对外 api_.jsonp(...) 的 .then(r=>r.value) 语义对齐（原来直接返回包装对象，
    // 调用方拿到的是 {value:...}，后续 .ok/.length 全读不到）。
    if (res && res.__jsonp) return res.value;
    if (!res) return res;
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      err.body = text;
      throw err;
    }
    try {
      return text ? JSON.parse(text) : null;
    } catch (e) {
      throw new Error("响应不是 JSON（代理或 Zotero 可能没起来）: " + text.slice(0, 120));
    }
  }

  function api(path) {
    // 注意前缀：本地 API 的完整路径是 /api/users/0/…（漏了它，所有请求都会 404）
    return call("/zotero/api/users/0" + path, { headers: { "Zotero-API-Version": API_VER } });
  }

  /** 探活：返回 {ok, localApi, version} */
  async function health() {
    try {
      const h = await call("/__health");
      return { ok: !!h.ok, localApi: !!h.localApi, version: h.zoteroVersion || "" };
    } catch (e) {
      return { ok: false, localApi: false, version: "", error: String(e.message || e) };
    }
  }

  /** 检索条目（标题/作者/年份）；排除附件与批注 */
  async function search(q, limit) {
    const n = Math.min(Math.max(Number(limit) || 20, 1), 50);
    const params = new URLSearchParams({
      q: String(q || ""),
      limit: String(n * 3),
      sort: "dateModified",
      direction: "desc",
      format: "json",
    });
    const rows = await api(`/items?${params.toString()}`);
    const skip = new Set(["attachment", "note", "annotation"]);
    return (rows || [])
      .filter((r) => r && r.data && !skip.has(r.data.itemType))
      .slice(0, n)
      .map((r) => ({
        key: r.key || r.data.key,
        // 注意：library.id 是远程 ID（个人库是 7 位用户号），书签里的 libId 只有群组库才有意义
        libId: (r.library && r.library.type === "group") ? Number(r.library.id) : 1,
        data: r.data,
      }));
  }

  /** 批量取条目（刷新时一次取全，避免 N 次请求） */
  async function items(keys) {
    const uniq = [...new Set((keys || []).filter(Boolean))];
    if (!uniq.length) return {};
    const out = {};
    for (let i = 0; i < uniq.length; i += 40) {
      const batch = uniq.slice(i, i + 40);
      const params = new URLSearchParams({ itemKey: batch.join(","), format: "json", limit: "100" });
      const rows = await api(`/items?${params.toString()}`);
      for (const r of rows || []) {
        const k = r.key || (r.data && r.data.key);
        if (k) out[k] = r.data;
      }
    }
    return out;
  }

  async function children(key) {
    const rows = await api(`/items/${key}/children?format=json&limit=100`);
    return (rows || []).map((r) => ({ key: r.key, data: r.data }));
  }

  /** 找该条目最适合跳转的 PDF 附件（优先已下载的 imported 附件） */
  async function bestPdf(key) {
    let kids = [];
    try {
      kids = await children(key);
    } catch (e) {
      return null;
    }
    const pdfs = kids.filter((k) => k.data && k.data.itemType === "attachment" &&
      /pdf/i.test(k.data.contentType || ""));
    if (!pdfs.length) return null;
    pdfs.sort((a, b) => {
      const w = (x) => (x.data.linkMode === "imported_file" ? 0 : 1);
      return w(a) - w(b);
    });
    return { key: pdfs[0].key, data: pdfs[0].data };
  }

  /** 某条 PDF 附件上的标注（用于"在原文里挑一句要引的话"） */
  async function annotations(attachmentKey) {
    const kids = await children(attachmentKey);
    return kids
      .filter((k) => k.data && k.data.itemType === "annotation")
      .map((k) => ({
        key: k.key,
        text: k.data.annotationText || "",
        comment: k.data.annotationComment || "",
        page: (String(k.data.annotationPageLabel || "").match(/\d+/) || [0])[0] | 0,
        color: k.data.annotationColor || "",
      }));
  }

  const api_ = {
    PROXY, health, search, items, children, bestPdf, annotations, call,
    jsonp: (p) => jsonp(p).then((r) => r.value),   // 对外的 jsonp 直接给数据
  };
  root.PPZotero = api_;
})(typeof globalThis !== "undefined" ? globalThis : this);
