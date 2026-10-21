#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 一键诊断包 · 插件侧契约测试
 *
 * 为什么单独测：这个功能的**唯一**用途就是"用户出问题时用得上"。
 * 它自己要是抛异常、卡住、或者在没打开文档时崩掉，用户拿到的只有"按钮不好使"，
 * 而我们连现场都收不到。所以这里把"最坏情况"逐条钉死：
 *   正常导出 / 没开文档 / 代理 500 / 超时 / 代理没起。
 *
 * 运行：node test/diag.test.js
 * 代理侧另有独立冒烟：python test/diag_proxy_smoke.py（不占端口）
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ADDON = path.resolve(__dirname, "..", "addon");

// 版本号动态读，不写死：version.js 是发布用的单一来源（install.py 拿它当加载项目录名），
// 写死字符串的话每次升版都要来改测试——这种断言只会给自己埋雷。
const VERSION = (/PPC_VERSION\s*=\s*'([^']+)'/.exec(
  fs.readFileSync(path.join(ADDON, "version.js"), "utf8")) || [])[1] || "";
// 与 index.html 一致的顺序（只到 doc.js：diag.js 不依赖 app.js / integration.js）
const ORDER = [
  "version.js",
  "js/codes.js",
  "js/styles/util.js",
  "js/styles/gb7714.js",
  "js/styles/apa.js",
  "js/model.js",
  "js/links.js",
  "js/zfields.js",
  "js/zotero.js",
  "js/doc.js",
  "js/diag.js",
];

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? "  ← " + JSON.stringify(extra) : ""));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }
function includes(hay, needle, label) {
  return ok(String(hay).indexOf(needle) >= 0, label, { want: needle, got: String(hay).slice(0, 200) });
}

/* ============================ WPS 桩 ============================ */

function makeField(seed) {
  return {
    Code: { Text: seed.code },
    Result: { Text: seed.text == null ? "" : seed.text, Start: seed.start || 0 },
  };
}

/** cfg.doc === false 模拟"WPS 里没有打开的文档"（doc() 直接抛） */
function makeWorld(cfg) {
  cfg = cfg || {};
  const fields = (cfg.fields || []).map(makeField);
  const doc = {
    FullName: cfg.docPath === undefined ? "H:\\paper\\x.docx" : cfg.docPath,
    Bookmarks: { get Count() { return 0; }, Item() { return null; }, Exists() { return false; } },
    Content: { Text: "", Start: 0, End: 0, Collapse() {} },
    CustomDocumentProperties: { get Count() { return 0; }, Item() { return null; }, Add() { return null; } },
    Fields: { get Count() { return fields.length; }, Item(i) { return fields[i - 1] || null; } },
  };
  const app = {
    ActiveDocument: cfg.doc === false ? null : doc,
    Documents: {
      get Count() { return cfg.doc === false ? 0 : 1; },
      Item() { return cfg.doc === false ? null : doc; },
    },
    Selection: { Range: { Start: 0, End: 0, Text: "", Collapse() {}, Select() {} } },
  };

  // 记录插件发给代理的请求体；每个用例自己决定 fetch 怎么答
  const calls = [];
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    AbortController,
    fetch: null,
    alert() {},
    wps: { WpsApplication() { return app; } },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const rel of ORDER) {
    vm.runInContext(fs.readFileSync(path.join(ADDON, rel), "utf8"), sandbox, { filename: rel });
  }

  /** 装一个假 fetch：answer 收到 {url, method, body(已解析)} 后决定返回值/抛错 */
  function setFetch(answer) {
    sandbox.fetch = async function (url, init) {
      const body = init && init.body != null ? JSON.parse(init.body) : null;
      const rec = { url: String(url), method: (init && init.method) || "GET", body: body, signal: init && init.signal };
      calls.push(rec);
      return answer(rec);
    };
  }
  sandbox.PPDiag.__calls = calls;
  return { sandbox, doc, app, D: sandbox.PPDiag, setFetch, calls };
}

/** 代理正常返回 */
function okAnswer(obj) {
  const text = JSON.stringify(obj);
  return { ok: true, status: 200, text: async function () { return text; } };
}

/* ============================ ① 正常导出 ============================ */

(async function () {
  {
    const CITATION = ' ADDIN ZOTERO_ITEM CSL_CITATION {"citationID":"A1","citationItems":[{"id":"http://zotero.org/users/1/items/ABCD2345"}]} ';
    const BIBL = " ADDIN ZOTERO_BIBL {\"custom\":[]} CSL_BIBLIOGRAPHY ";
    const OTHER = ' ADDIN HYPERLINK "http://x" ';
    const w = makeWorld({
      docPath: "H:\\paper\\x.docx",
      fields: [
        { code: CITATION, text: "[3]", start: 10 },
        { code: BIBL, text: "张三. 一篇很长很长的文献题名[M]. 2020.", start: 100 },
        { code: OTHER, text: "链接", start: 200 },
      ],
    });
    w.setFetch(function () { return okAnswer({ ok: true, path: "C:\\diag\\papilot-diag-1.zip", size: 2048 }); });

    const r = await w.D.export();

    eq(r.ok, true, "① 正常导出返回 ok");
    eq(r.path, "C:\\diag\\papilot-diag-1.zip", "① 带回 zip 路径");
    eq(r.error, undefined, "① 成功时不带 error");

    eq(w.calls.length, 1, "① 只发一次请求");
    eq(w.calls[0].url, "http://127.0.0.1:21932/diag", "① 打到代理的 /diag");
    eq(w.calls[0].method, "POST", "① 用 POST");

    const body = w.calls[0].body;
    eq(body.version, VERSION, "① 带插件版本（与 version.js 一致）");
    ok(/^\d+\.\d+\.\d+$/.test(body.version), "① 版本号是像样的版本串", body.version);
    eq(w.sandbox.PPC_VERSION, VERSION, "① 沙箱里读到的版本与源文件一致");
    eq(body.docPath, "H:\\paper\\x.docx", "① 带文档路径");
    eq(Array.isArray(body.fields), true, "① fields 是数组");
    eq(body.fields.length, 3, "① 三个域都进清单");

    eq(body.fields[0].kind, "citation", "① CSL_CITATION 判为 citation");
    eq(body.fields[1].kind, "bib", "① CSL_BIBLIOGRAPHY 判为 bib");
    eq(body.fields[2].kind, "other", "① 其它域判为 other");

    eq(body.fields[0].index, 1, "① 域序号从文档来");
    eq(body.fields[0].codeLen, CITATION.length, "① codeLen = 域代码长度");
    eq(body.fields[0].textLen, 3, "① textLen = 显示文本长度");
    const LONG = "张三. 一篇很长很长的文献题名[M]. 2020.";
    eq(body.fields[0].label, "[3]", "① label 取显示文本");
    eq(body.fields[1].label, LONG.slice(0, 12), "① label 截到 12 字");
    eq(body.fields[1].label.length, 12, "① label 不超过 12 字");
    eq(body.fields[1].textLen, LONG.length, "① textLen 是全文长度（不是截断后的）");

    ok(w.calls[0].signal, "① 带 AbortSignal（可超时）");
  }

  /* ============================ ② 没打开文档 ============================ */
  {
    const w = makeWorld({ doc: false });
    w.setFetch(function () { return okAnswer({ ok: true, path: "C:\\diag\\empty.zip", size: 512 }); });

    let threw = null;
    let r = null;
    try { r = await w.D.export(); } catch (e) { threw = e; }
    eq(threw, null, "② 没文档时不抛异常");
    ok(r && r.ok === true, "② 没文档也能导出（结构留空）");
    eq(w.calls[0].body.docPath, "", "② docPath 退化为空串");
    eq(w.calls[0].body.fields.length, 0, "② fields 退化为空数组");
    // 版本号不受文档影响
    eq(w.calls[0].body.version, VERSION, "② 版本号照常带上");
  }

  /* ============================ ③ 代理 500 ============================ */
  {
    const w = makeWorld({});
    w.setFetch(function () {
      return { ok: false, status: 500, text: async function () { return '{"ok":false,"error":"磁盘满了"}'; } };
    });
    let threw = null;
    let r = null;
    try { r = await w.D.export(); } catch (e) { threw = e; }
    eq(threw, null, "③ 代理 500 不抛异常");
    eq(r && r.ok, false, "③ 代理 500 返回 ok:false");
    ok(r && typeof r.error === "string" && r.error.length > 0, "③ 带人话错误");
    includes(r.error, "磁盘满了", "③ 把代理给的原因透出来");
    ok(!/undefined|\[object/.test(r.error), "③ 错误文案里没有 undefined/[object", r.error);
  }

  /* ============================ ④ 超时 ============================ */
  {
    const w = makeWorld({});
    w.setFetch(function () {
      const e = new Error("The user aborted a request.");
      e.name = "AbortError";
      throw e;
    });
    let threw = null;
    let r = null;
    try { r = await w.D.export(); } catch (e) { threw = e; }
    eq(threw, null, "④ 超时不抛异常");
    eq(r && r.ok, false, "④ 超时返回 ok:false");
    includes(r.error, "超时", "④ 明说是超时");
  }

  /* ============================ ⑤ 代理没起（fetch 直接失败） ============================ */
  {
    const w = makeWorld({});
    w.setFetch(function () {
      const e = new TypeError("Failed to fetch");
      throw e;
    });
    let threw = null;
    let r = null;
    try { r = await w.D.export(); } catch (e) { threw = e; }
    eq(threw, null, "⑤ 代理不可达不抛异常");
    eq(r && r.ok, false, "⑤ 代理不可达返回 ok:false");
    includes(r.error, "连不上本地代理", "⑤ 提示去确认代理在跑");
  }

  /* ============ ⑥ 代理回 200 但正文不是 JSON（比如被中间层改写） ============ */
  {
    const w = makeWorld({});
    w.setFetch(function () {
      return { ok: true, status: 200, text: async function () { return "<html>oops</html>"; } };
    });
    let r = null;
    try { r = await w.D.export(); } catch (e) { r = { ok: "", error: "threw " + e }; }
    eq(r.ok, false, "⑥ 正文不是 JSON 时返回 ok:false（不抛）");
    ok(typeof r.error === "string" && r.error.length > 0, "⑥ 有错误文案");
  }

  /* ============================ 汇总 ============================ */
  console.log("=".repeat(60));
  if (fails.length) {
    for (const f of fails) console.log("  !!  " + f);
    console.log("=".repeat(60));
    console.log(`诊断包（插件侧）：${pass} 通过 / ${fails.length} 失败`);
    process.exit(1);
  }
  console.log(`诊断包（插件侧）：${pass} 项断言全部通过`);
})();
