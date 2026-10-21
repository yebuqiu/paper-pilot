// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* QA 协议契约测试（Zotero HTTP integration protocol）
 *
 * 与 integration-smoke.js 的分工：
 *   smoke  —— 单点回归「踩过的坑」（加载顺序、方言往返、锁、取消、错误收尾）
 *   qa     —— 把 **Zotero 那一侧** 按官方源码的消费代码重建出来，逐条校验我们回复的
 *             值的形状。因为协议里出错的成本极高（一次结构不符 = 用户重启 Zotero），
 *             光断言"我们的返回值"不够，必须断言"Zotero 拿它去干什么"。
 *
 * 依据（只读）：%TEMP%/zt-src/httpIntegrationClient.js、server_connectorIntegration.js、integration.js
 *   例：`Document.getFields` 客户端直接 `retVal.map(...)`（httpIntegrationClient.js:149）
 *       `Document.insertField` 客户端 `new Field(docID, retVal)` 后取 `retVal.id`（:145/:169）
 *       `Document.getDocumentData` 客户端直接 `new DocumentData(dataString)`（integration.js:537）
 *
 * 两类断言：
 *   check(...) —— 必须通过。失败=源码 bug，测试别改。
 *   probe(...) —— 已知风险探测：只记录事实并存档（改完源码后把 probe 升级成 check）。
 *
 * 运行：node test/qa-protocol.test.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ADDON = path.resolve(__dirname, "..", "addon");
// 与 index.html 一致的加载顺序（integration.js 必须在 doc.js 之后）
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
  "js/app.js",
  "js/integration.js",
];

const DOCID = "papilot-wps-doc";
const ADDIN_ITEM = "ADDIN ZOTERO_ITEM CSL_CITATION";
const ADDIN_BIBL = "ADDIN ZOTERO_BIBL";

/* ============================ WPS 桩 ============================ */

function makeField(doc, start, codeText) {
  let raw = String(codeText == null ? "" : codeText);
  const f = {
    Result: { Text: "", Start: start },
    Delete() {
      const i = doc.__fields.indexOf(f);
      if (i >= 0) doc.__fields.splice(i, 1);
    },
    Unlink() { f.__unlinked = true; },
  };
  Object.defineProperty(f, "Code", {
    configurable: true,
    value: {
      get Text() { return raw; },
      set Text(v) {
        const s = String(v == null ? "" : v);
        // __truncateCode 用来复现「WPS 把域代码截断」的现场
        raw = doc.__truncateCode ? s.slice(0, doc.__truncateCode) : s;
      },
    },
  });
  return f;
}

function makeDoc(cfg) {
  cfg = cfg || {};
  const fields = [];
  const props = [];
  const doc = {
    FullName: "C:/tmp/qa-protocol.docx",
    Bookmarks: {
      get Count() { return 0; },
      Item() { return null; },
      Exists() { return false; },
    },
    CustomDocumentProperties: {
      get Count() { return props.length; },
      Item(i) { return props[i - 1]; },
      Add(name, linkToContent, type, value) {
        let v = String(value);
        // Word 的自定义属性有 255 字符上限；这里可注入同样的截断
        if (cfg.truncateProps && v.length > cfg.truncateProps) v = v.slice(0, cfg.truncateProps);
        props.push({ Name: name, Value: v });
        return props[props.length - 1];
      },
    },
    // Collapse 按 Word 语义：0=wdCollapseEnd（折到末尾），1=wdCollapseStart
    Content: {
      Text: "正文", Start: 0, End: 2,
      Collapse(dir) { if (dir === 0) this.Start = this.End; else this.End = this.Start; },
    },
    Fields: {
      get Count() { return fields.length; },
      Item(i) { return fields[i - 1] || null; },
      Add(range, type, codeText) {
        const at = range && typeof range.Start === "number" ? range.Start : 0;
        const f = makeField(doc, at, codeText);
        fields.push(f);
        return f;
      },
    },
    Range(s, e) { return { Start: s, End: e, Font: {} }; },
    Activate() { doc.__activated += 1; },
    __fields: fields,
    __props: props,
    __activated: 0,
    __truncateCode: cfg.truncateCode || 0,
  };
  if (cfg.seedFields) {
    for (const s of cfg.seedFields) fields.push(makeField(doc, s.start, s.code));
  }
  return doc;
}

/** 新建一个隔离的沙箱世界（每例独立，避免 fieldMap / nextId 串味） */
function makeWorld(cfg) {
  const doc = makeDoc(cfg);
  const app = {
    ActiveDocument: doc,
    Documents: { get Count() { return 1; }, Item() { return doc; } },
    Selection: { Range: { Start: 500, End: 500, Text: "", Collapse() {}, Select() {} } },
  };
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    AbortController,
    fetch: function () { throw new Error("QA: 这个用例不该发网络请求"); },
    alert: function () {},
    wps: { WpsApplication: function () { return app; } },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const rel of ORDER) {
    vm.runInContext(fs.readFileSync(path.join(ADDON, rel), "utf8"), sandbox, { filename: rel });
  }
  return { sandbox, doc, app, I: sandbox.PPIntegration };
}

/* ==================== Zotero 侧模拟器（关键） ====================
 * 反向 RPC：我们 POST execCommand，Zotero 把「下一条命令」当 HTTP 响应下发；
 * 我们 POST respond 回结果，那条 respond 的响应就是再下一条命令。这里照抄这个乒乓。
 */
const VALIDATORS = {
  "Application.getActiveDocument": function (v) {
    const p = [];
    if (!v || typeof v !== "object") return ["返回值不是对象（client 会读 result.outputFormat / documentID）"];
    if (typeof v.documentID !== "string" || !v.documentID) {
      p.push("documentID 缺失或不是字符串（httpIntegrationClient.js:76 用它构造 Document，缺了后续 docId 全 null）");
    }
    if (typeof v.outputFormat !== "string") p.push("outputFormat 缺失（决定 citeproc 出 html 还是 rtf）");
    return p;
  },
  "Document.getDocumentData": function (v) {
    if (typeof v !== "string") return ["必须是字符串（integration.js:537 直接 new DocumentData(dataString)）"];
    if (v && v !== "ZOTERO_TRANSFER_DOCUMENT") {
      try { JSON.parse(v); } catch (e) { return ["返回的不是合法 JSON —— Zotero 会当新文档，重新弹首选项"]; }
    }
    return [];
  },
  "Document.setDocumentData": function () { return []; },
  "Document.canInsertField": function (v) {
    return v === true ? [] : ["必须 === true（返回假值 Zotero 直接放弃插入并报「此处无法插入」）"];
  },
  "Document.cursorInField": function (v) {
    return v ? ["返回了真值，client 会 new Field(docID, retVal) 当成域（httpIntegrationClient.js:141）"] : [];
  },
  "Document.insertField": function (v) {
    const p = [];
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      return ["必须是对象 {id}（裸数字会让 client 的 Field._id 变 null）"];
    }
    if (typeof v.id !== "number") p.push("id 必须是数字");
    return p;
  },
  "Document.getFields": function (v) {
    if (!Array.isArray(v)) return ["必须是数组（httpIntegrationClient.js:149 直接 retVal.map）"];
    const p = [];
    v.forEach(function (f, k) {
      const at = "第 " + (k + 1) + " 个域";
      if (!f || typeof f !== "object") { p.push(at + " 不是对象"); return; }
      if (typeof f.id !== "number") p.push(at + " id 不是数字");
      if (typeof f.code !== "string") p.push(at + " code 不是字符串");
      if (typeof f.text !== "string") p.push(at + " text 不是字符串");
      if (typeof f.noteIndex !== "number") p.push(at + " noteIndex 不是数字");
      if (typeof f.adjacent !== "boolean") p.push(at + " adjacent 不是布尔");
    });
    return p;
  },
  "Document.insertText": function () { return []; },
  "Document.displayAlert": function (v) {
    return typeof v === "number" ? [] : ["必须返回数字（integration.js:425/1285/1386 都拿它做判断）"];
  },
  "Document.setBibliographyStyle": function () { return []; },
  "Document.convert": function () { return []; },
  "Document.convertPlaceholdersToFields": function (v) {
    return Array.isArray(v) ? [] : ["必须是数组（httpIntegrationClient.js:157 直接 retVal.map —— null 会 TypeError）"];
  },
  "Field.setCode": function () { return []; },
  "Field.setText": function () { return []; },
  "Field.delete": function () { return []; },
  "Field.select": function () { return []; },
  "Field.removeCode": function () { return []; },
};

function makeZotero(sandbox, script, opts) {
  opts = opts || {};
  const st = {
    i: 0,           // 已下发的命令数
    steps: [],      // 每条被应答的命令 + 我们的返回值 + 契约问题
    exec: 0,
    lastFieldId: null,
    fieldIds: [],
  };
  const ok = function (t) { return { ok: true, status: 200, text: async function () { return t; } }; };

  function resolveArgs(args) {
    return (args || []).map(function (a) {
      if (a === "@field") return st.lastFieldId;
      const m = typeof a === "string" && /^@f(\d+)$/.exec(a);
      if (m) return st.fieldIds[Number(m[1])];
      return a;
    });
  }
  function nextCommand() {
    const s = script[st.i];
    if (!s) return null;
    st.i++;
    return { command: s.cmd, arguments: resolveArgs(s.args) };
  }

  sandbox.fetch = async function (url, fetchOpts) {
    const u = String(url);
    if (u.indexOf(":21932/log") > 0) return ok("{}");
    const body = fetchOpts && fetchOpts.body != null ? JSON.parse(fetchOpts.body) : null;

    if (u.indexOf("/connector/document/execCommand") > 0) {
      st.exec += 1;
      const c = nextCommand();
      return ok(JSON.stringify(c || {}));
    }

    // 一次 respond：body 是「上一条命令」的返回值
    const answering = script[st.i - 1];
    const rec = { cmd: answering ? answering.cmd : "(unknown)", payload: body, problems: [] };
    if (answering) {
      const v = VALIDATORS[answering.cmd];
      if (v) rec.problems = v(body, st) || [];
      if (answering.cmd === "Document.insertField") st.lastFieldId = body && body.id;
      if (answering.cmd === "Document.getFields") {
        st.fieldIds = (Array.isArray(body) ? body : []).map(function (f) { return f && f.id; });
      }
    }
    st.steps.push(rec);

    const nxt = nextCommand();
    if (!nxt) {
      // 真机上没有下一条命令时这个请求会一直挂着（见 probe“complete 之后仍挂起”）。
      // 常规用例里给个空 body 让它立刻返回，免得每例都等 30 秒。
      if (opts.dangleFinal) return new Promise(function () { /* 永不 resolve */ });
      return ok(" ");
    }
    return ok(JSON.stringify(nxt));
  };
  return st;
}

/* ============================ 断言框架 ============================ */

let failed = 0;
let passed = 0;
const probes = [];

async function check(name, fn) {
  try {
    const r = await fn();
    passed += 1;
    console.log("  PASS " + name + (r ? "  [" + r + "]" : ""));
  } catch (e) {
    failed += 1;
    console.log("  FAIL " + name + " -> " + ((e && e.message) || e));
  }
}

async function probe(name, fn) {
  try {
    const note = await fn();
    probes.push(name + (note ? " —— " + note : ""));
    console.log("  PROBE " + name + (note ? "  [" + note + "]" : ""));
  } catch (e) {
    probes.push(name + " —— 探测本身失败: " + ((e && e.message) || e));
    console.log("  PROBE " + name + " -> 探测失败: " + ((e && e.message) || e));
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

/** 跑一遍脚本化的会话，返回 {ok, ret, z} */
async function playSession(world, script, command, opts) {
  const z = makeZotero(world.sandbox, script, opts);
  let ret = null;
  let err = null;
  try { ret = await world.I.run(command || "addCitation"); } catch (e) { err = e; }
  return { ret: ret, err: err, z: z };
}

function badSteps(z) {
  const bad = [];
  for (const s of z.steps) for (const p of s.problems) bad.push(s.cmd + "：" + p);
  return bad;
}

/* ============================ 会话脚本 ============================ */

const ITEM_CODE = 'ITEM CSL_CITATION {"citationID":"c1AbCd23","properties":{"formattedCitation":"<sup>[1]</sup>"},"citationItems":[{"id":"X1"}]}';
const DOC_DATA = '{"dataVersion":3,"sessionID":"s-qa-1","style":{"styleID":"http://www.zotero.org/styles/apa","locale":""},"prefs":{"fieldType":"Http","noteType":0}}';

// 「插入一条引文」：照抄 addCitation 实际会下发的命令序列
const SCENE_CITATION = [
  { cmd: "Application.getActiveDocument" },
  { cmd: "Document.getDocumentData", args: [DOCID] },
  { cmd: "Document.canInsertField", args: [DOCID, "Http"] },
  { cmd: "Document.cursorInField", args: [DOCID, "Http"] },
  { cmd: "Document.insertField", args: [DOCID, "Http", 0] },
  { cmd: "Field.setCode", args: [DOCID, "@field", "TEMP"] },
  { cmd: "Field.setText", args: [DOCID, "@field", "<sup>[1]</sup>", true] },
  { cmd: "Field.setCode", args: [DOCID, "@field", ITEM_CODE] },
  { cmd: "Document.getFields", args: [DOCID, "Http"] },
  { cmd: "Field.setCode", args: [DOCID, "@f0", ITEM_CODE] },
  { cmd: "Document.setDocumentData", args: [DOCID, DOC_DATA] },
  { cmd: "Document.activate", args: [DOCID] },
  { cmd: "Document.complete", args: [DOCID] },
];

// 「插入文献表」：注意 addField 之后先 setCode("TEMP")，再 clearCode → BIBL（Zotero 端按 type 决定前缀）
const SCENE_BIBLIOGRAPHY = [
  { cmd: "Application.getActiveDocument" },
  { cmd: "Document.getDocumentData", args: [DOCID] },
  { cmd: "Document.canInsertField", args: [DOCID, "Http"] },
  { cmd: "Document.cursorInField", args: [DOCID, "Http"] },
  { cmd: "Document.insertField", args: [DOCID, "Http", 0] },
  { cmd: "Field.setCode", args: [DOCID, "@field", "TEMP"] },
  { cmd: "Field.setCode", args: [DOCID, "@field", "BIBL {} CSL_BIBLIOGRAPHY"] },
  { cmd: "Document.getFields", args: [DOCID, "Http"] },
  { cmd: "Field.setCode", args: [DOCID, "@f0", 'BIBL {"bibID":"b1AbCd23"} CSL_BIBLIOGRAPHY'] },
  { cmd: "Document.setBibliographyStyle", args: [DOCID, 0, 0, 1, 1, [], 0] },
  { cmd: "Field.setText", args: [DOCID, "@f0", '<div class="csl-entry">[1] 张三. 2020.</div>'] },
  { cmd: "Document.setDocumentData", args: [DOCID, DOC_DATA] },
  { cmd: "Document.activate", args: [DOCID] },
  { cmd: "Document.complete", args: [DOCID] },
];

/* ============================ 用例 ============================ */

(async function main() {
  console.log("== A. 能力位 / 单命令契约 ==");

  await check("getActiveDocument 结构合法，且能力位与实现一致", async function () {
    const w = makeWorld();
    const r = await w.I.handle("Application.getActiveDocument", []);
    assert(r && typeof r === "object", "返回值不是对象");
    assert(r.documentID === DOCID, "documentID 不对：" + r.documentID);
    assert(r.outputFormat === "html", "outputFormat 必须是 html（WPS 侧按 HTML 渲染富文本）");
    assert(typeof r.processorName === "string" && r.processorName, "processorName 缺失");
    // 能力位必须和已实现命令对齐：声明 true 却没实现 = 给用户暴露一个点了就炸的按钮
    assert(r.supportsImportExport === false, "supportsImportExport 必须 false（importDocument/exportDocument 未实现）");
    return "supportsCitationMerging=" + r.supportsCitationMerging;
  });

  await check("getDocumentData 首次返回字符串空串（触发「文档首选项」）", async function () {
    const w = makeWorld();
    const r = await w.I.handle("Document.getDocumentData", [DOCID]);
    assert(r === "", "预期空串，实际 " + JSON.stringify(r));
  });

  await check("getDocumentData 回读值是字符串且是合法 JSON", async function () {
    const w = makeWorld();
    await w.I.handle("Document.setDocumentData", [DOCID, DOC_DATA]);
    const r = await w.I.handle("Document.getDocumentData", [DOCID]);
    assert(typeof r === "string", "必须是字符串");
    JSON.parse(r);   // 解析不出 → Zotero 当新文档，编号从头开始
    assert(r === DOC_DATA, "回读不一致");
  });

  await check("canInsertField === true / cursorInField 为假值", async function () {
    const w = makeWorld();
    assert((await w.I.handle("Document.canInsertField", [DOCID, "Http"])) === true, "canInsertField 必须 === true");
    const c = await w.I.handle("Document.cursorInField", [DOCID, "Http"]);
    assert(!c, "cursorInField 现在恒 false；一旦返回真值 client 会 new Field(docID, false)");
  });

  await check("displayAlert 返回数字，且错误收尾时返回 0（不点「是」）", async function () {
    const w = makeWorld();
    const r = await w.I.handle("Document.displayAlert", [DOCID, "测试消息", 0, 1]);
    assert(typeof r === "number", "必须返回数字");
  });

  await check("insertField 返回 {id:number}（client 用 retVal.id 构造 Field）", async function () {
    const w = makeWorld();
    const r = await w.I.handle("Document.insertField", [DOCID, "Http", 0]);
    assert(r && typeof r === "object" && !Array.isArray(r), "必须是对象");
    assert(typeof r.id === "number", "id 必须是数字，实际 " + typeof r.id);
    assert(w.doc.__fields.length === 1, "文档里没有真的建出域");
    return "id=" + r.id;
  });

  await check("getFields 返回数组，每项字段齐全（id 数字 / code text 字符串）", async function () {
    const w = makeWorld({ seedFields: [{ start: 10, code: "ADDIN ZOTERO_ITEM CSL_CITATION " + ITEM_CODE.slice("ITEM CSL_CITATION ".length) }] });
    const r = await w.I.handle("Document.getFields", [DOCID, "Http"]);
    const bad = VALIDATORS["Document.getFields"](r);
    assert(!bad.length, bad.join("；"));
    assert(r.length === 1, "域数量不对：" + r.length);
    return "1 个域";
  });

  console.log("\n== B. 域代码方言：写进去是 Word 方言，读回来是 Zotero 方言 ==");

  await check("setCode(ITEM …) 落盘为 ADDIN ZOTERO_ITEM，getFields 还原成 ITEM …", async function () {
    const w = makeWorld();
    const f = await w.I.handle("Document.insertField", [DOCID, "Http", 0]);
    await w.I.handle("Field.setCode", [DOCID, f.id, ITEM_CODE]);
    assert(w.doc.__fields[0].Code.Text.indexOf(ADDIN_ITEM) === 0, "落盘不是 Word 方言：" + w.doc.__fields[0].Code.Text.slice(0, 40));
    const fields = await w.I.handle("Document.getFields", [DOCID, "Http"]);
    assert(fields[0].code.indexOf("ITEM CSL_CITATION") === 0, "回读不是内部方言：" + fields[0].code.slice(0, 40));
    // loadExisting 只认「开头」：ITEM/CITATION → 引文；BIBL → 文献表（integration.js:3013）
    assert(/^(ITEM|CITATION)/.test(fields[0].code), "loadExisting 会判不出引文类型");
  });

  await check("setCode(BIBL …) 落盘为 ADDIN ZOTERO_BIBL，getFields 还原成 BIBL …", async function () {
    const w = makeWorld();
    const f = await w.I.handle("Document.insertField", [DOCID, "Http", 0]);
    await w.I.handle("Field.setCode", [DOCID, f.id, "BIBL {} CSL_BIBLIOGRAPHY"]);
    assert(w.doc.__fields[0].Code.Text.indexOf(ADDIN_BIBL) === 0, "落盘不是 " + ADDIN_BIBL);
    const fields = await w.I.handle("Document.getFields", [DOCID, "Http"]);
    assert(fields[0].code.indexOf("BIBL") === 0, "loadExisting 会判不出文献表类型：" + fields[0].code);
  });

  await check("同一个域跨两次 getFields 的 id 稳定（否则 Zotero 把一条引文算成多条）", async function () {
    const w = makeWorld({ seedFields: [{ start: 10, code: ADDIN_ITEM + " " + ITEM_CODE.slice("ITEM CSL_CITATION ".length) }] });
    const a = await w.I.handle("Document.getFields", [DOCID, "Http"]);
    const b = await w.I.handle("Document.getFields", [DOCID, "Http"]);
    assert(a[0].id === b[0].id, "id 漂移：" + a[0].id + " → " + b[0].id);
    return "id=" + a[0].id;
  });

  await check("非 Zotero 域（TOC/PAGE 之类）也返回，但不会被冒充成引文", async function () {
    const w = makeWorld({
      seedFields: [
        { start: 0, code: 'TOC \\o "1-3" \\h \\z \\u' },
        { start: 10, code: ADDIN_ITEM + " " + ITEM_CODE.slice("ITEM CSL_CITATION ".length) },
      ],
    });
    const r = await w.I.handle("Document.getFields", [DOCID, "Http"]);
    assert(r.length === 2, "域数量不对：" + r.length);
    assert(!/^(ITEM|CITATION|BIBL)/.test(r[0].code), "普通域被当成了 Zotero 域：" + r[0].code);
    assert(/^ITEM/.test(r[1].code), "引文域没被识别");
    return "Zotero 只会认第 2 个";
  });

  await check("removeCode 之后域仍在（不能 Unlink 掉，否则文献表永远插不进来）", async function () {
    const w = makeWorld({ seedFields: [{ start: 10, code: ADDIN_BIBL + " {} CSL_BIBLIOGRAPHY" }] });
    const before = await w.I.handle("Document.getFields", [DOCID, "Http"]);
    await w.I.handle("Field.removeCode", [DOCID, before[0].id]);
    const after = await w.I.handle("Document.getFields", [DOCID, "Http"]);
    assert(after.length === before.length, "域被删了");
    assert(w.doc.__fields[0].Code.Text.indexOf(ADDIN_BIBL) === 0, "域代码被改了");
  });

  console.log("\n== C. 端到端：按 Zotero 真实命令序列走完整个事务 ==");

  await check("addCitation：13 条命令全部应答，且每一步都满足 client 的消费契约", async function () {
    const w = makeWorld();
    const r = await playSession(w, SCENE_CITATION, "addCitation");
    assert(!r.err, "run 抛错：" + (r.err && r.err.message));
    assert(r.ret && r.ret.ok === true, "没返回 ok:true：" + JSON.stringify(r.ret));
    assert(r.z.steps.length === SCENE_CITATION.length, "应答次数不对：" + r.z.steps.length);
    const bad = badSteps(r.z);
    assert(!bad.length, bad.join("；"));
    assert(w.doc.__fields.length === 1, "文档里的域数量不对：" + w.doc.__fields.length);
    assert(w.doc.__fields[0].Code.Text.indexOf(ADDIN_ITEM) === 0, "文档里没存成 Word 方言");
    assert(w.doc.__fields[0].Result.Text === "[1]", "域结果文本不对：" + JSON.stringify(w.doc.__fields[0].Result.Text));
    const props = w.doc.__props.filter(function (p) { return p.Name === "ZoteroDocData"; });
    assert(props.length === 1 && props[0].Value === DOC_DATA, "文档数据没存住（下次刷新会当新文档）");
    return r.z.steps.length + " 步全绿";
  });

  await check("addBibliography：文献表域刚建好时 text 非空（躲开 ignoreEmptyBibliography）", async function () {
    const w = makeWorld();
    const r = await playSession(w, SCENE_BIBLIOGRAPHY, "addBibliography");
    assert(!r.err, "run 抛错：" + (r.err && r.err.message));
    const bad = badSteps(r.z);
    assert(!bad.length, bad.join("；"));
    const gf = r.z.steps.filter(function (s) { return s.cmd === "Document.getFields"; })[0];
    assert(gf, "没有 getFields 步骤");
    assert(gf.payload.length === 1, "域数量不对");
    assert(gf.payload[0].text !== "" && String(gf.payload[0].text).trim() !== "", "文献表域 text 为空 → Zotero 会判空文献表并 removeCode");
    assert(gf.payload[0].code.indexOf("BIBL") === 0, "code 不是 BIBL 开头");
    assert(w.doc.__fields[0].Result.Text === "[1] 张三. 2020.", "文献表文本没写进去：" + JSON.stringify(w.doc.__fields[0].Result.Text));
    return "占位=" + JSON.stringify(gf.payload[0].text);
  });

  await check("错误通道：handle 抛错 → respond {error:'Alert'}，且继续把收尾命令应答完", async function () {
    const w = makeWorld();
    const script = [
      { cmd: "Application.getActiveDocument" },
      { cmd: "Document.insertField", args: [DOCID, "Http", 0] },   // 桩里 Fields.Add 正常，改用非法参数制造失败
      { cmd: "Document.activate", args: [DOCID] },
      { cmd: "Document.displayAlert", args: [DOCID, "boom", 0, 0] },
      { cmd: "Document.activate", args: [DOCID] },
      { cmd: "Document.complete", args: [DOCID] },
    ];
    // 让 Fields.Add 抛错
    w.doc.Fields.Add = function () { throw new Error("QA 注入的插入失败"); };
    const r = await playSession(w, script, "addCitation");
    assert(r.err, "应该把错误抛给界面");
    const errRes = r.z.steps.filter(function (s) { return s.payload && s.payload.error; });
    assert(errRes.length === 1, "错误通道应答次数不对：" + errRes.length);
    assert(String(errRes[0].payload.message).indexOf("Papilot Cite") === 0, "message 没有前缀：" + errRes[0].payload.message);
    assert(typeof errRes[0].payload.stack === "string", "缺 stack（Zotero 侧会 JSON.stringify 后再用）");
    const alertStep = r.z.steps.filter(function (s) { return s.cmd === "Document.displayAlert"; })[0];
    assert(alertStep && alertStep.payload === 0, "收尾时的 displayAlert 必须回 0（回 1 会让 Zotero 打开帮助网页）");
    assert(r.z.steps[r.z.steps.length - 1].cmd === "Document.complete", "没有走到 complete，Zotero 会卡在 inProgress");
    return "收尾应答 " + r.z.steps.length + " 次";
  });

  await check("无文档时：getActiveDocument 仍返回合法结构，run 在发事务前就拦住", async function () {
    const w = makeWorld();
    w.app.ActiveDocument = null;
    Object.defineProperty(w.app.Documents, "Count", { get: function () { return 0; }, configurable: true });
    // getActiveDocument 这一条无论如何都要合法：它是 inProgress 的唯一逃生口
    const r = await w.I.handle("Application.getActiveDocument", []);
    assert(r && r.documentID === DOCID, "无文档时 getActiveDocument 不该变形");

    const seen = [];
    w.sandbox.fetch = async function (url) { seen.push(String(url)); return { ok: true, status: 200, text: async function () { return "{}"; } }; };
    let err = null;
    try { await w.I.run("addCitation"); } catch (e) { err = e; }
    assert(err, "无文档时应该报错");
    assert(!seen.some(function (u) { return u.indexOf("execCommand") >= 0; }), "无文档时不许发 execCommand（会永久卡死 Zotero）");
  });

  await check("refresh：内容没变化（全程无 setText）时返回 ok:true，不能判成取消", async function () {
    const w = makeWorld();
    const script = [
      { cmd: "Application.getActiveDocument" },
      { cmd: "Document.getDocumentData", args: [DOCID] },
      { cmd: "Document.getFields", args: [DOCID, "Http"] },
      { cmd: "Document.setDocumentData", args: [DOCID, DOC_DATA] },
      { cmd: "Document.complete", args: [DOCID] },
    ];
    const r = await playSession(w, script, "refresh");
    assert(!r.err, "run 抛错：" + (r.err && r.err.message));
    assert(r.ret && r.ret.ok === true, "refresh 被误判成用户取消：" + JSON.stringify(r.ret));
  });

  await check("addCitation：全程没有 setText（用户点 X）→ 返回 cancelled", async function () {
    const w = makeWorld();
    const script = [
      { cmd: "Application.getActiveDocument" },
      { cmd: "Document.getDocumentData", args: [DOCID] },
      { cmd: "Document.canInsertField", args: [DOCID, "Http"] },
      { cmd: "Document.insertField", args: [DOCID, "Http", 0] },
      { cmd: "Field.setCode", args: [DOCID, "@field", "TEMP"] },
      { cmd: "Field.delete", args: [DOCID, "@field"] },
      { cmd: "Document.setDocumentData", args: [DOCID, DOC_DATA] },
      { cmd: "Document.complete", args: [DOCID] },
    ];
    const r = await playSession(w, script, "addCitation");
    assert(!r.err, "run 抛错：" + (r.err && r.err.message));
    assert(r.ret && r.ret.ok === false && r.ret.cancelled === true, "取消没被识别：" + JSON.stringify(r.ret));
  });

  console.log("\n== D. 富文本渲染的真实输入 ==");

  await check("延迟更新包装 <div class='delayed-zotero-citation-updates'> 不产生换行", async function () {
    const w = makeWorld();
    const runs = w.I.htmlToRuns("<div class='delayed-zotero-citation-updates'>[1]</div>");
    const plain = runs.map(function (r) { return r.text; }).join("");
    assert(plain === "[1]", "延迟更新的引文被塞进了换行：" + JSON.stringify(plain));
  });

  await check("htmlToRuns 解 &#8211; / &nbsp; 等实体（citeproc 会输出数字实体）", async function () {
    const w = makeWorld();
    const plain = w.I.htmlToRuns("1&#8211;3&nbsp;a&amp;b").map(function (r) { return r.text; }).join("");
    assert(plain === "1\u20133\u00a0a&b", JSON.stringify(plain));
  });

  await check("文献表多行：每个 csl-entry 一行（不能挤成一整行）", async function () {
    const w = makeWorld();
    const html = '<div class="csl-bib-body"><div class="csl-entry">[1] A</div><div class="csl-entry">[2] B</div></div>';
    assert(w.I.htmlToRuns(html).map(function (r) { return r.text; }).join("") === "[1] A\n[2] B", "换行不对");
  });

  console.log("\n== E. 本轮修复的回归（原 probe 升级为 check，改坏就红）==");

  await check("complete 之后的 respond 不再阻塞：1 秒内返回（不能等满 SHORT=30s）", async function () {
    const w = makeWorld();
    const t0 = Date.now();
    // dangleFinal：模拟"最后一次 respond 永远不会有响应"的真机行为
    const r = await playSession(w, SCENE_CITATION, "addCitation", { dangleFinal: true });
    const ms = Date.now() - t0;
    assert(!r.err, "run 抛错：" + (r.err && r.err.message));
    assert(r.ret && r.ret.ok === true, "没返回 ok:true：" + JSON.stringify(r.ret));
    assert(ms < 1000, "complete 之后还等了 " + ms + "ms（busy 锁也会被一起占住）");
    return ms + "ms";
  });

  await check("Document.convertPlaceholdersToFields 返回数组（client 直接 retVal.map）", async function () {
    const w = makeWorld();
    const v = await w.I.handle("Document.convertPlaceholdersToFields", [DOCID, ["ph1"], "footnote", "Http"]);
    assert(Array.isArray(v), "必须是数组，实际 " + JSON.stringify(v));
    v.map(function (f) { return f; });          // 复现 client 的 retVal.map，不许抛
    assert(v.length === 0, "暂不支持，应为空数组");
  });

  await check("insertText：整段编码 HTML 落成纯文本（不能把源码写进正文）", async function () {
    const w = makeWorld();
    const html = "<html><body>见引文<a href='https://www.zotero.org/?ph1'>[1]</a>&#20013;</body></html>";
    await w.I.handle("Document.insertText", [DOCID, html]);
    const wrote = String(w.app.Selection.Range.Text || "");
    assert(wrote === "见引文[1]中", "写入的不是纯文本：" + JSON.stringify(wrote));
  });

  await check("复制粘贴同一引文（同 citationID）→ 两个域两个 id，且跨扫描稳定", async function () {
    const tail = ITEM_CODE.slice("ITEM CSL_CITATION ".length);
    const w = makeWorld({ seedFields: [{ start: 10, code: ADDIN_ITEM + " " + tail }, { start: 99, code: ADDIN_ITEM + " " + tail }] });
    const a = await w.I.handle("Document.getFields", [DOCID, "Http"]);
    assert(a[0].id !== a[1].id, "两个物理域拿到同一个 id=" + a[0].id + "（Zotero 会当成一个域）");
    const b = await w.I.handle("Document.getFields", [DOCID, "Http"]);
    assert(b[0].id === a[0].id && b[1].id === a[1].id, "id 跨扫描漂移：" + a.map(function (f) { return f.id; }) + " → " + b.map(function (f) { return f.id; }));
    return "id=" + a[0].id + "/" + a[1].id;
  });

  await check("域代码被 WPS 截断 → 必须抛错（不许静默回成功）", async function () {
    const w = makeWorld({ truncateCode: 120 });
    const f = await w.I.handle("Document.insertField", [DOCID, "Http", 0]);
    let err = null;
    try { await w.I.handle("Field.setCode", [DOCID, f.id, ITEM_CODE]); } catch (e) { err = e; }
    assert(err, "域代码被截断却仍然返回成功（Zotero 拿到残缺 JSON）");
    assert(/域代码/.test(err.message), "错误信息没说清是域代码：" + err.message);
    return err.message.slice(0, 40);
  });

  await check("文档属性被截断 → 必须抛错，且事务仍能正常收尾（不卡在 inProgress）", async function () {
    const w = makeWorld({ truncateProps: 100 });
    const r = await playSession(w, SCENE_CITATION, "addCitation");
    assert(r.err, "属性被截断却仍然成功（下次刷新会当新文档，编号从头来）");
    assert(/文档数据/.test(r.err.message), "错误信息没说清是文档数据：" + r.err.message);
    const errStep = r.z.steps.filter(function (s) { return s.payload && s.payload.error; })[0];
    assert(errStep, "没有走错误通道");
    assert(r.z.steps[r.z.steps.length - 1].cmd === "Document.complete", "没有走到 complete，Zotero 会卡在 inProgress");
    return "错误通道 + 收尾 " + r.z.steps.length + " 步";
  });

  await check("长事务不再撞上限：322 条命令的刷新能走完（原上限 200）", async function () {
    const w = makeWorld();
    const script = [
      { cmd: "Application.getActiveDocument" },
      { cmd: "Document.insertField", args: [DOCID, "Http", 0] },
    ];
    for (let k = 0; k < 160; k++) {
      script.push({ cmd: "Field.setText", args: [DOCID, "@field", "<sup>[1]</sup>", true] });
      script.push({ cmd: "Field.setCode", args: [DOCID, "@field", ITEM_CODE] });
    }
    script.push({ cmd: "Document.complete", args: [DOCID] });
    const r = await playSession(w, script, "refresh");
    assert(!r.err, script.length + " 条命令时抛：" + (r.err && r.err.message));
    assert(r.ret && r.ret.ok === true, "没成功走完：" + JSON.stringify(r.ret));
    return script.length + " 条命令";
  });

  await check("displayAlert 按 buttons 解释返回值（3 键框的「是」是 2，不是 1）", async function () {
    const w = makeWorld();
    // buttons=0（只有确定）不许弹 confirm —— 单向提示不能变成"确定/取消"二选一
    let confirms = 0;
    const alerts = [];
    w.sandbox.confirm = function (t) { confirms += 1; return true; };
    w.sandbox.alert = function (t) { alerts.push(String(t)); };
    assert(await w.I.handle("Document.displayAlert", [DOCID, "Zotero 出错了", 0, 0]) === 0, "OK 框应回 0");
    assert(confirms === 0, "buttons=0 时弹了 confirm（用户被问一个不存在的决定）");
    assert(alerts.length === 1, "buttons=0 时应该 alert 出来一次，实际 " + alerts.length);
    // 没有 confirm（Node）→ 保守回 0，不替用户答应
    delete w.sandbox.confirm;
    assert(await w.I.handle("Document.displayAlert", [DOCID, "题", 1, 3]) === 0, "无 confirm 时必须回 0");
    // 有 confirm 且用户点「是」
    w.sandbox.confirm = function () { return true; };
    assert(await w.I.handle("Document.displayAlert", [DOCID, "题", 1, 3]) === 2, "YES_NO_CANCEL 的「是」必须是 2");
    assert(await w.I.handle("Document.displayAlert", [DOCID, "题", 0, 2]) === 1, "YES_NO 的「是」必须是 1");
    assert(await w.I.handle("Document.displayAlert", [DOCID, "题", 0, 1]) === 1, "OK_CANCEL 的「确定」必须是 1");
    assert(await w.I.handle("Document.displayAlert", [DOCID, "题", 0, 0]) === 0, "OK 框返回值不被使用，取 0 最保守");
    // 用户点「否」→ 一律 0（取消/否），绝不会被当成"替用户点是"
    w.sandbox.confirm = function () { return false; };
    assert(await w.I.handle("Document.displayAlert", [DOCID, "题", 1, 3]) === 0, "点否必须回 0");
    delete w.sandbox.confirm;
    return "0/1/2 全对";
  });

  await check("Document.activate 仍然只应答、不抢前台（回归：不许加回来）", async function () {
    const w = makeWorld();
    const r = await playSession(w, SCENE_CITATION, "addCitation");
    assert(!r.err, r.err && r.err.message);
    await new Promise(function (res) { setTimeout(res, 20); });   // 等 setTimeout(0)，若有的话
    assert(w.doc.__activated === 0, "调用了 " + w.doc.__activated + " 次 d.Activate()——DESIGN §5.5：会让 CEF 转后台断链");
  });

  await check("supportedNotes 必须是 Zotero 的复数枚举（单数会让注文制选项对不上）", async function () {
    const w = makeWorld();
    const r = await w.I.handle("Application.getActiveDocument", []);
    assert(Array.isArray(r.supportedNotes), "supportedNotes 必须是数组");
    assert(JSON.stringify(r.supportedNotes) === '["footnotes","endnotes"]',
      "取值不对：" + JSON.stringify(r.supportedNotes) + "（httpIntegrationClient.js:62 用的是复数值）");
  });

  await check("重复域被 setCode 之后，去重身份不许塌陷（P1-9 回归）", async function () {
    const tail = ITEM_CODE.slice("ITEM CSL_CITATION ".length);
    const w = makeWorld({ seedFields: [{ start: 10, code: ADDIN_ITEM + " " + tail }, { start: 99, code: ADDIN_ITEM + " " + tail }] });
    const a = await w.I.handle("Document.getFields", [DOCID, "Http"]);
    assert(a[0].id !== a[1].id, "scan1 就同 id 了");
    await w.I.handle("Field.setCode", [DOCID, a[1].id, ITEM_CODE]);   // Zotero 会这么干
    const b = await w.I.handle("Document.getFields", [DOCID, "Http"]);
    assert(b[0].id !== b[1].id, "setCode 之后两个域塌回同一个 id=" + b[0].id + "（之后 setText/setCode 全打到同一个物理域）");
    assert(b[0].id === a[0].id && b[1].id === a[1].id,
      "setCode 之后 id 漂移：" + a.map(function (f) { return f.id; }) + " → " + b.map(function (f) { return f.id; }));
    return "id=" + a[0].id + "/" + a[1].id;
  });

  await check("取不到 Selection 时先退回上次插入点（不跳到文末/文首）", async function () {
    const w = makeWorld();
    const end0 = 1000;
    w.doc.Content.End = end0;                                        // 先把文档"变长"，让两个位置可区分
    await w.I.handle("Document.insertField", [DOCID, "Http", 0]);    // Selection 在 500，记下 lastPos
    delete w.app.Selection;                                          // 之后取不到
    await w.I.handle("Document.insertField", [DOCID, "Http", 0]);
    const at = w.doc.__fields[1].Result.Start;
    assert(at === 500, "没退回上次插入点 500，实际插到 " + at);
  });

  /* ★ R1 回归守卫（Round 3 曾是真红项，现已转绿，断言保留防回退）。
   * 历史：selRange 的兜底一度写成 `d.Content.Collapse(1)`，注释还写着「Collapse(1) = wdCollapseEnd」。
   * Word 的 WdCollapseDirection 原文是 wdCollapseEnd = 0（文末）、wdCollapseStart = 1（文首），
   * 且默认参数就是 1 —— 所以 `Collapse(1)` 折到的是**文档开头**，
   * 一旦取不到 Selection 就会把引文插到文章最前面（用户看到「引文跑到第一段之前」）。
   * 现修法不依赖常量：`d.Range(Number(d.Content.End) || 0, 同值)`。
   * 断言的是【行为】（必须落文末），不预设常量写法。 */
  await check("【回归】取不到 Selection 且没有历史位置时，引文必须落文末而不是文首", async function () {
    const w = makeWorld();
    const end0 = 1000;
    w.doc.Content.End = end0;                                       // 在调用前取，Collapse 会改写它
    delete w.app.Selection;                                         // 且 lastPos 还是 -1
    await w.I.handle("Document.insertField", [DOCID, "Http", 0]);
    const at = w.doc.__fields[0].Result.Start;
    assert(at === end0, "引文插到了位置 " + at + "（应为文末 " + end0 + "）。"
      + "WdCollapseDirection 是 0=wdCollapseEnd / 1=wdCollapseStart，"
      + "若这里又出现 Collapse(1) 就会折到文首。");
    return "位置 " + at;
  });

  /* 同一条链路的最后一层兜底：Range() 本身不可用时才会走 `Content.Collapse(0)`。
   * 这一层**仍然带着常量**，所以单独守一次——只要 0 哪天被改成 1，这条会立刻红。
   * 做法：让 d.Range 只第一次调用抛错（正是 selRange 那次），后续恢复正常，
   * 这样既能逼进兜底分支，又不影响 insertField 后面的插入动作。 */
  await check("【回归】Range() 不可用时的末层兜底也不能折到文首", async function () {
    const w = makeWorld();
    const end0 = 777;
    w.doc.Content.End = end0;
    delete w.app.Selection;                                         // 无选区
    const realRange = w.doc.Range;
    let calls = 0;
    w.doc.Range = function () {
      calls += 1;
      if (calls === 1) throw new Error("Range 不可用（模拟）");
      return realRange.apply(w.doc, arguments);
    };
    await w.I.handle("Document.insertField", [DOCID, "Http", 0]);
    w.doc.Range = realRange;
    const at = w.doc.__fields[0].Result.Start;
    assert(at !== 0, "末层兜底把引文插到了位置 0（文首）——Collapse 的方向常量又被写反了");
    assert(at === end0, "末层兜底应折到文末 " + end0 + "，实际 " + at);
    return "位置 " + at;
  });

  await check("noteType>0（脚注/尾注制）必须明确报错，不许静默插在正文", async function () {
    const w = makeWorld();
    let err = null;
    try { await w.I.handle("Document.insertField", [DOCID, "Http", 1]); } catch (e) { err = e; }
    assert(err, "noteType=1 时没有报错——用户选了脚注制却得到正文引文，且毫无提示");
    assert(/脚注|尾注/.test(err.message), "报错没讲清原因：" + err.message);
    return err.message.slice(0, 30);
  });

  console.log("\n== F. 已知问题（probe：只记录事实，不算失败）==");
  console.log("   【待修】= 我判定该修但本轮没人动；【已决策不做】= 评估过、明确不做（理由见 probe 文字）；"
    + "【已知不做】= 长期限制，别再反复提");

  await probe("【已决策不做 P2-2】错误收尾轮里 displayAlert 的文案被丢掉（handle 不参与）", async function () {
    const w = makeWorld();
    w.doc.Fields.Add = function () { throw new Error("QA 注入"); };
    const seen = [];
    w.sandbox.alert = function (t) { seen.push(String(t)); };
    w.sandbox.confirm = function (t) { seen.push("confirm:" + String(t)); return true; };
    const r = await playSession(w, SCENE_CITATION, "addCitation");
    const alertStep = r.z.steps.filter(function (s) { return s.cmd === "Document.displayAlert"; })[0];
    return "错误路径里 Zotero 的 displayAlert（" + JSON.stringify((alertStep && alertStep.payload) === 0 ? "回 0" : "?")
      + "）没有经过 handle，弹窗次数=" + seen.length
      + "；错误文案目前只靠 app.js 的 msg()/alert 兜底显示";
  });

  await probe("【已知不做 P1-4】Document.convert 未实现（改「脚注/尾注」制时域不转换）", async function () {
    const w = makeWorld();
    const v = await w.I.handle("Document.convert", [DOCID, [1, 2], "Http", [0, 0], 2]);
    return "返回 " + JSON.stringify(v) + "（client 丢弃返回值，所以不报错；但域没有真的搬进脚注，用户以为切换成功了）";
  });

  await probe("【已知不做 P1-6】cursorInField 恒 false（光标在引文里再插入 → 域嵌套）", async function () {
    const w = makeWorld();
    const v = await w.I.handle("Document.cursorInField", [DOCID, "Http"]);
    return "返回 " + JSON.stringify(v) + "；addField 因此永远不会走「是否替换」分支（integration.js:1084-1091），"
      + "在已有引文中间再点插入会建出嵌套域。doc.js 里已有 fieldAtCursor() 可实现";
  });

  await probe("【已知不做】Document.getDocument 是死命令（可删，别误调）", async function () {
    const w = makeWorld();
    const v = await w.I.handle("Document.getDocument", [DOCID]);
    return "实现了（返回 {text}），但 httpIntegrationClient.js 的方法表里没有 getDocument —— "
      + "HTTP 路径永远不会下发它，属于死代码（" + JSON.stringify(v).slice(0, 20) + "）";
  });

  /* ── 以下两条来自工程师 Round 4 的提醒（他只读代码、未写 probe，怕和我的冲突） ──
   * 我核实了两处源码，事实成立，且第二处比他说的更严重：不只是 noteIndex 恒 0，
   * 而是 footnotes 里的域**根本不在 getFields 的枚举范围里**（只扫 document.Fields）。 */

  /* integration.js:582 `noteIndex: 0` 硬编码；integration.js:415 insertField 回的是真实序号。
   * Zotero 侧 integration.js:1211 `_updateDocument` 正是靠 field.getNoteIndex() 重建 Citation，
   * 所以 note 类样式（Chicago full note 等）refresh 之后 Ibid. / 同注抑制会全部按"第 0 条注"算。 */
  await probe("【待修 P1-10】getFields 只扫正文 Fields：脚注里的引文对 refresh 完全不可见，且 noteIndex 恒 0", async function () {
    const w = makeWorld();
    // 造"正文 0 个域、脚注里 1 条 Zotero 引文"的文档
    // （典型来源：在 Word 版 Zotero 插件里用脚注制插过，现在拿到 WPS 里刷新）
    const noteField = makeField(w.doc, 0,
      ' ADDIN ZOTERO_ITEM CSL_CITATION {"citationID":"note1","properties":{"noteIndex":7}} ');
    const noteRange = {
      Start: 0, End: 5,
      Fields: { get Count() { return 1; }, Item() { return noteField; } },
    };
    w.doc.Footnotes = { get Count() { return 1; }, Item() { return { Index: 7, Range: noteRange }; } };

    const body = await w.I.handle("Document.getFields", [DOCID]);

    // 同一份文档里再用脚注制插一条，看 insertField 回的序号
    w.app.Selection.Footnotes = { Add() { return { Index: 9, Range: { Start: 0, End: 0 } }; } };
    const ins = await w.I.handle("Document.insertField", [DOCID, "Http", 1]);
    const after = await w.I.handle("Document.getFields", [DOCID]);
    const inserted = after.filter(function (o) { return o.id === ins.id; })[0];

    assert(body.length === 0, "正文没有域，getFields 却返回了 " + body.length + " 条");
    return "脚注里有 1 条引文 → getFields 返回 " + body.length + " 条（看不见）；"
      + "insertField 回 noteIndex=" + ins.noteIndex + "，但同一域在 getFields 里 noteIndex="
      + (inserted ? inserted.noteIndex : "（该域也不在扫描结果里）")
      + "。refresh 走的是 getFields（integration.js:1211），note 类样式的 Ibid. 会全按第 0 条注算";
  });

  /* integration.js:381-393 里 `notes.Add(r, "")` 先成功，之后 `d.Fields.Add` 两条路都失败时
   * 直接 throw —— 没有任何 `note.Delete()` 回滚，用户会看到一个空脚注（编号也占掉了）。 */
  await probe("【待修 P2-3】脚注模式失败会留下空脚注（notes.Add 已成功、Fields.Add 抛错，无回滚）", async function () {
    const w = makeWorld();
    let added = 0;
    w.doc.Fields.Add = function () { throw new Error("Fields.Add 不支持（QA 注入）"); };
    w.app.Selection.Footnotes = {
      Add() { added += 1; return { Index: 1, Range: { Start: 0, End: 0 } }; },
    };
    let err = null;
    try { await w.I.handle("Document.insertField", [DOCID, "Http", 1]); } catch (e) { err = e; }
    assert(err, "预期抛错但没有");
    return "抛错=" + (err ? "是" : "否") + "，脚注已创建 " + added + " 个且失败后未删除 —— "
      + "用户在正文里会多出一个空脚注（编号被占）。修法：catch 里 `note.Delete()` 再抛";
  });

  console.log("");
  if (probes.length) {
    const todo = probes.filter(function (p) { return p.indexOf("【待修") === 0; });
    const wont = probes.filter(function (p) { return p.indexOf("【已知不做") === 0 || p.indexOf("【已决策不做") === 0; });
    console.log("已知问题 " + probes.length + " 项：待修 " + todo.length + " 项 / 不做 " + wont.length + " 项");
    probes.forEach(function (p, i) { console.log("  " + (i + 1) + ". " + p); });
    console.log("");
  }
  console.log("通过 " + passed + " 项，失败 " + failed + " 项" + (failed === 0 ? "，全部通过" : ""));
  process.exit(failed === 0 ? 0 : 1);
})();
