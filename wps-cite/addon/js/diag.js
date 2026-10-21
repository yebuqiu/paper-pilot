// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 一键诊断包（插件侧）
 *
 * 为什么：用户报"某个按钮不好使"时，我们看不到他那台机器上的任何东西，也不该要求远程连过去。
 * 这里把"加载项自己知道的现场"（版本、文档路径、文档里有哪些 Zotero 域）POST 给本地代理，
 * 由代理补上日志尾巴与脱敏配置、打成 zip 落盘；用户只要把那个文件发过来。
 *
 * 纪律：**任何一步失败都不许抛**。按钮点下去最坏的结果是"弹一句人话"，绝不是控制台一片红、
 * 用户以为插件彻底坏了。所以取版本、取文档、扫域各自包 try/catch，值缺了就留空继续走。
 */
(function (root) {
  "use strict";

  const PROXY = "http://127.0.0.1:21932";
  // 代理要读日志尾巴、写 zip，比普通请求慢；给 20 秒，超时也要能说清"是超时"，
  // 免得按钮一直转圈（用户会当成"点了没反应"——正是我们要避免的那种报障）。
  const TIMEOUT = 20000;
  const LABEL_MAX = 12;   // 标签只用来看"这个域长什么样"，不需要全文

  /** 域代码 → 类型：引文、文献表、其它，排障时必须能分开数。 */
  function kindOf(code) {
    const s = String(code || "");
    if (s.indexOf("CSL_CITATION") >= 0) return "citation";
    if (s.indexOf("CSL_BIBLIOGRAPHY") >= 0) return "bib";
    return "other";
  }

  /** 域的显示文本。WPS 上 Result.Text 不一定可取，取不到就当空——诊断信息缺一点没关系。 */
  function resultText(d, index) {
    try {
      const f = d.Fields.Item(index);
      const t = f && f.Result ? f.Result.Text : "";
      return String(t == null ? "" : t);
    } catch (e) {
      return "";
    }
  }

  /** 扫文档里的域 → [{index, kind, codeLen, textLen, label}]；失败退化为空清单。 */
  function collectFields() {
    let raw = [];
    try {
      raw = (root.PPDoc && root.PPDoc.scanFields && root.PPDoc.scanFields()) || [];
    } catch (e) {
      return [];                       // 文档没打开 / 没有 Fields 集合
    }
    let d = null;
    try { d = root.PPDoc.doc(); } catch (e) { d = null; }
    const out = [];
    for (let i = 0; i < raw.length; i++) {
      const f = raw[i] || {};
      try {
        const text = d ? resultText(d, f.index) : "";
        out.push({
          index: Number(f.index) || (i + 1),
          kind: kindOf(f.code),
          codeLen: String(f.code || "").length,
          textLen: text.length,
          label: text.slice(0, LABEL_MAX),
        });
      } catch (e) { /* 单个域坏掉不影响整份清单 */ }
    }
    return out;
  }

  function docPath() {
    try {
      return String((root.PPDoc && root.PPDoc.docPath && root.PPDoc.docPath()) || "");
    } catch (e) {
      return "";
    }
  }

  /** 把不可达/超时翻成人话：这两种情况用户自己就能处理（重启代理、重开文档）。 */
  function humanError(e) {
    // name 和 message 都要看：AbortError 只看 message 会漏（Chromium 的文案各版本不一样），
    // 而 TypeError("Failed to fetch") 只看 name 也判断不出是"连不上"。
    const name = String((e && e.name) || "");
    const msg = String((e && e.message) || e || "");
    const all = name + " " + msg;
    if (/abort/i.test(all)) {
      return "导出诊断包超时（20 秒）——代理可能卡住了，请重启 Papilot Cite 代理后重试";
    }
    if (/failed to fetch|networkerror|load failed|network request failed/i.test(all)) {
      return "连不上本地代理（127.0.0.1:21932）——请确认 Papilot Cite 代理正在运行";
    }
    return "导出失败：" + (msg || name || "未知错误");
  }

  /**
   * 导出诊断包。永不 reject：调用方只需看 ok 决定弹什么。
   * @returns {Promise<{ok: boolean, path?: string, error?: string}>}
   */
  async function exportBundle() {
    const payload = { version: "", docPath: "", fields: [], note: "" };
    try { payload.version = String(root.PPC_VERSION || ""); } catch (e) { /* 读不到就留空 */ }
    payload.docPath = docPath();
    payload.fields = collectFields();

    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(function () { ctrl.abort(); }, TIMEOUT) : null;
    try {
      const init = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        cache: "no-store",
      };
      if (ctrl) init.signal = ctrl.signal;

      const res = await fetch(PROXY + "/diag", init);
      let data = null;
      try {
        data = JSON.parse(await res.text());
      } catch (e) {
        data = null;                   // 代理 500 时正文可能不是 JSON
      }
      if (!res.ok || !data || !data.ok) {
        const why = data && data.error ? String(data.error) : "HTTP " + (res && res.status);
        return { ok: false, error: "代理没能生成诊断包：" + why };
      }
      return { ok: true, path: String(data.path || "") };
    } catch (e) {
      return { ok: false, error: humanError(e) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  root.PPDiag = { export: exportBundle };
})(typeof globalThis !== "undefined" ? globalThis : this);
