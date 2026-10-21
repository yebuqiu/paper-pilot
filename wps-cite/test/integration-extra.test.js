// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 内核增量能力的契约测试（与 integration-smoke / qa-protocol 不重叠）：
 *   1) changeStyle   —— 换引注样式（改文档数据 + refresh，不弹 setDocPrefs 对话框）
 *   2) addUncited    —— 把未引用条目补进文献表（改写 BIBL 域代码里的 uncited）
 *   3) 悬挂缩进      —— Field.setText 写完文献表后设 LeftIndent/FirstLineIndent
 *
 * 每个用例一个独立沙箱（fieldMap / nextId 会串味），加载顺序与 addon/index.html 一致。
 * 运行：node test/integration-extra.test.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ADDON = path.resolve(__dirname, "..", "addon");
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

const PREFIX = "http://zotero.org/users/local/1234";
const STYLE_OLD = "http://www.zotero.org/styles/apa";
const STYLE_NEW = "http://www.zotero.org/styles/chicago-author-date-17th-edition";
const BIB_CODE = 'ADDIN ZOTERO_BIBL {"uncited":[],"omitted":[],"custom":[]} CSL_BIBLIOGRAPHY';
const CITE_CODE = 'ADDIN ZOTERO_ITEM CSL_CITATION {"citationID":"aaaa1111","citationItems":'
  + '[{"id":"' + PREFIX + '/items/KEY1"}]}';

/* ============================== WPS 桩 ============================== */

/** 域桩：Code.Text 走访问器，方便复现「WPS 截断域代码」 */
function makeField(start, codeText, opts) {
  opts = opts || {};
  let raw = String(codeText == null ? "" : codeText);
  const pfWrites = [];
  const f = {
    Result: { Text: "", Start: start },
    __pfWrites: pfWrites,
    Delete() {},
  };
  Object.defineProperty(f, "Code", {
    configurable: true,
    value: {
      get Text() { return raw; },
      set Text(v) {
        const s = String(v == null ? "" : v);
        raw = opts.truncateCode ? s.slice(0, opts.truncateCode) : s;
      },
    },
  });
  if (opts.noParagraphFormat) {
    Object.defineProperty(f.Result, "ParagraphFormat", {
      configurable: true,
      get() { throw new Error("这个 WPS 版本没有 ParagraphFormat"); },
    });
  } else {
    const pf = { LeftIndent: 0, FirstLineIndent: 0 };
    Object.defineProperty(pf, "LeftIndent", {
      configurable: true,
      get() { return this.__left || 0; },
      set(v) { this.__left = v; pfWrites.push(["LeftIndent", v]); },
    });
    Object.defineProperty(pf, "FirstLineIndent", {
      configurable: true,
      get() { return this.__first || 0; },
      set(v) { this.__first = v; pfWrites.push(["FirstLineIndent", v]); },
    });
    f.Result.ParagraphFormat = pf;
  }
  return f;
}

function makeWorld(cfg) {
  cfg = cfg || {};
  const state = { truncateProps: 0, calls: [], fields: [], props: [] };

  function clamp(v) {
    let s = String(v == null ? "" : v);
    if (state.truncateProps > 0 && s.length > state.truncateProps) s = s.slice(0, state.truncateProps);
    return s;
  }

  const props = {
    get Count() { return state.props.length; },
    Item(i) { return state.props[i - 1] || null; },
    Add(name, linkToContent, type, value) {
      // Word 的自定义文档属性有长度上限；这里可注入同样的截断（含后续改写）
      const p = { Name: name, __v: clamp(value) };
      Object.defineProperty(p, "Value", {
        configurable: true,
        get() { return this.__v; },
        set(v) { this.__v = clamp(v); },
      });
      state.props.push(p);
      return p;
    },
  };

  const doc = {
    FullName: "C:/tmp/integration-extra.docx",
    CustomDocumentProperties: props,
    Content: { Text: "正文", Start: 0, End: 2, Collapse() {} },
    Bookmarks: { get Count() { return 0; }, Item() { return null; }, Exists() { return false; } },
    Fields: {
      get Count() { return state.fields.length; },
      Item(i) { return state.fields[i - 1] || null; },
      Add() { throw new Error("桩：Fields.Add 未实现"); },
    },
    Range(s, e) { return { Start: s, End: e, Font: {} }; },
    Activate() {},
  };

  (cfg.seed || []).forEach(function (s) {
    state.fields.push(makeField(s.start, s.code, s.opts));
  });

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
    fetch: null,
    alert: function () {},
    wps: { WpsApplication: function () { return app; } },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const rel of ORDER) {
    vm.runInContext(fs.readFileSync(path.join(ADDON, rel), "utf8"), sandbox, { filename: rel });
  }

  /* 网络桩：refresh 一进事务就立刻收到 Document.complete，绝不真的长轮询。 */
  sandbox.fetch = async function (url) {
    const p = String(url).replace(/^http:\/\/127\.0\.0\.1:21932/, "");
    state.calls.push(p);
    const ok = function (t) { return { ok: true, status: 200, text: async function () { return t; } }; };
    if (p.indexOf("/log") === 0) return ok("{}");
    if (p.indexOf("execCommand") >= 0) {
      return ok(JSON.stringify({ command: "Document.complete", arguments: [] }));
    }
    return ok("{}");
  };

  return { sandbox, doc, app, I: sandbox.PPIntegration, state };
}

/** 把一段 JSON 存进文档属性（走真实链路：Document.setDocumentData） */
async function seedDocData(world, json) {
  await world.I.handle("Document.setDocumentData", [[], json]);
  const back = await world.I.handle("Document.getDocumentData", []);
  if (back !== json) throw new Error("预置文档数据失败: " + back.length + " / " + json.length);
}

/* ============================== 跑测试 ============================== */

let failed = 0;
let passed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  PASS " + name);
  } catch (e) {
    failed++;
    console.log("  FAIL " + name + " -> " + ((e && e.message) || e));
  }
}

/** 断言 fn 抛错，且错误信息命中 re */
async function expectThrow(fn, re, what) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  if (!err) throw new Error((what || "预期抛错") + "，实际正常返回了");
  if (re && !re.test(String(err.message))) {
    throw new Error((what || "错误信息不符") + "：期望命中 " + re + "，实际「" + err.message + "」");
  }
  return err;
}

function countCalls(state, needle) {
  return state.calls.filter(function (p) { return p.indexOf(needle) >= 0; }).length;
}

function occurences(hay, needle) {
  return String(hay).split(needle).length - 1;
}

(async () => {
  console.log("== changeStyle：换引注样式 ==");

  await check("changeStyle：文档没有 Zotero 数据 → 抛人话错误", async () => {
    const w = makeWorld();
    await expectThrow(() => w.I.changeStyle(STYLE_NEW), /先插入一条引文/, "没有文档数据时应拒绝");
  });

  await check("changeStyle：文档数据不是合法 JSON → 报解析失败", async () => {
    const w = makeWorld();
    await seedDocData(w, "{这不是 JSON");
    await expectThrow(() => w.I.changeStyle(STYLE_NEW), /解析失败/, "坏 JSON 应拒绝");
  });

  await check("changeStyle：正常换样式 → 属性里的 styleID 变了、changed:true、跑了 refresh", async () => {
    const w = makeWorld();
    await seedDocData(w, JSON.stringify({ style: { styleID: STYLE_OLD, locale: "en-US" }, version: 3 }));
    const r = await w.I.changeStyle(STYLE_NEW);
    if (!r || r.ok !== true) throw new Error("没有返回 ok:true：" + JSON.stringify(r));
    if (r.changed !== true) throw new Error("changed 应为 true：" + JSON.stringify(r));
    if (r.from !== STYLE_OLD || r.to !== STYLE_NEW) throw new Error("from/to 不对：" + JSON.stringify(r));

    const saved = JSON.parse(await w.I.handle("Document.getDocumentData", []));
    if (saved.style.styleID !== STYLE_NEW) throw new Error("文档属性里的 styleID 没改：" + saved.style.styleID);
    if (saved.style.locale !== "en-US") throw new Error("换了样式把 locale 弄丢了");
    if (saved.version !== 3) throw new Error("换了样式把 version 弄丢了");
    if (countCalls(w.state, "execCommand") !== 1) {
      throw new Error("应该正好跑一次 refresh 事务，实际 execCommand " + countCalls(w.state, "execCommand"));
    }
  });

  await check("changeStyle：样式没变 → changed:false，且不发起事务", async () => {
    const w = makeWorld();
    await seedDocData(w, JSON.stringify({ style: { styleID: STYLE_OLD } }));
    const r = await w.I.changeStyle(STYLE_OLD);
    if (r.changed !== false) throw new Error("同一样式应返回 changed:false：" + JSON.stringify(r));
    if (countCalls(w.state, "execCommand") !== 0) throw new Error("同一样式不该去打扰 Zotero");
  });

  /* WPS 把自定义属性截断时：必须抛错，而且旧值要退回去（半个 JSON 比直接失败危险得多） */
  await check("changeStyle：写回被截断 → 抛错且旧值已恢复", async () => {
    const w = makeWorld();
    const oldJson = JSON.stringify({ style: { styleID: STYLE_OLD, locale: "en-US" } });
    await seedDocData(w, oldJson);

    // 截断阈值 = 旧数据的长度：新 JSON 更长（STYLE_NEW 比 STYLE_OLD 长）→ 必被截断
    w.state.truncateProps = oldJson.length;
    await expectThrow(() => w.I.changeStyle(STYLE_NEW), /没能完整保存|截断/, "写入被截断时应拒绝");

    const back = await w.I.handle("Document.getDocumentData", []);
    if (back !== oldJson) {
      throw new Error("旧值没恢复：期望 " + oldJson.length + " 字符，实际 " + back.length + " 字符「" + back + "」");
    }
    if (countCalls(w.state, "execCommand") !== 0) throw new Error("数据没存住就不该去 refresh");
  });

  /* 换样式后 refresh 失败（多半本机没装那个样式）：文档数据必须回滚，
   * 否则 styleID 钉在文档里，之后每次刷新都失败，用户只能手动去首选项改回来。 */
  await check("changeStyle：refresh 失败 → 回滚文档数据并报人话", async () => {
    const w = makeWorld();
    const oldJson = JSON.stringify({ style: { styleID: STYLE_OLD, locale: "en-US" } });
    await seedDocData(w, oldJson);
    // 让 execCommand 直接 500（等价于 Zotero 取不到样式/事务起不来）
    w.sandbox.fetch = async function (url) {
      const p = String(url).replace(/^http:\/\/127\.0\.0\.1:21932/, "");
      const ok = function (t) { return { ok: true, status: 200, text: async function () { return t; } }; };
      if (p.indexOf("/log") === 0) return ok("{}");
      if (p.indexOf("execCommand") >= 0) {
        return { ok: false, status: 500, text: async function () { return "style not found"; } };
      }
      return ok("{}");
    };
    let err = null;
    try { await w.I.changeStyle(STYLE_NEW); } catch (e) { err = e; }
    if (!err) throw new Error("refresh 失败时应该抛错");
    if (!/已恢复原来的样式|Ctrl\+Z/.test(String(err.message))) {
      throw new Error("错误文案没告诉用户数据状态：" + err.message);
    }
    const back = await w.I.handle("Document.getDocumentData", []);
    if (back !== oldJson) throw new Error("文档数据没回滚：「" + String(back).slice(0, 80) + "」");
  });

  console.log("== addUncited：补入未引用条目 ==");

  await check("addUncited：keys 为空 → 抛错且不碰文档", async () => {
    const w = makeWorld({ seed: [{ start: 100, code: BIB_CODE }, { start: 5, code: CITE_CODE }] });
    await expectThrow(() => w.I.addUncited([]), /没有要补入的条目/);
    await expectThrow(() => w.I.addUncited([""]), /没有要补入的条目/);
    if (w.state.fields[0].Code.Text !== BIB_CODE) throw new Error("空参数不该改域代码");
  });

  await check("addUncited：没有文献表域 → 提示先插文献表", async () => {
    const w = makeWorld({ seed: [{ start: 5, code: CITE_CODE }] });
    await expectThrow(() => w.I.addUncited(["UN1"]), /还没有文献表/, "缺文献表时应拒绝");
  });

  await check("addUncited：有文献表但没有引文域（取不到 URI 前缀）→ 拒绝而不是瞎猜前缀", async () => {
    const w = makeWorld({ seed: [{ start: 100, code: BIB_CODE }] });
    await expectThrow(() => w.I.addUncited(["UN1"]), /先插入一条引文/, "没有引文域时应拒绝");
    if (w.state.fields[0].Code.Text !== BIB_CODE) throw new Error("取不到前缀时不该改域代码");
  });

  await check("addUncited：正常补入 → uncited 是数组的数组，保留 ADDIN ZOTERO_BIBL 方言", async () => {
    const w = makeWorld({ seed: [{ start: 100, code: BIB_CODE }, { start: 5, code: CITE_CODE }] });
    const r = await w.I.addUncited(["UNC1"]);
    if (!r || r.ok !== true) throw new Error("没有返回 ok:true：" + JSON.stringify(r));
    if (r.added !== 1) throw new Error("added 应为 1：" + JSON.stringify(r));
    if (r.uncited !== 1) throw new Error("uncited 总数应为 1：" + JSON.stringify(r));

    const code = w.state.fields[0].Code.Text;
    const want = '"uncited":[["' + PREFIX + '/items/UNC1"]]';
    if (code.indexOf(want) < 0) throw new Error("域代码里没有 " + want + "\n实际: " + code);
    if (code.indexOf("ADDIN ZOTERO_BIBL ") !== 0) throw new Error("Word 方言前缀丢了: " + code);
    if (!/ CSL_BIBLIOGRAPHY$/.test(code)) throw new Error("CSL_BIBLIOGRAPHY 结尾丢了: " + code);
    if (code.indexOf('"omitted":[]') < 0) throw new Error("omitted 被弄丢了: " + code);
    if (code.indexOf('"custom":[]') < 0) throw new Error("custom 被弄丢了: " + code);
    if (countCalls(w.state, "execCommand") !== 1) throw new Error("补入后应该 refresh 一次");
  });

  await check("addUncited：重复调用不产生重复项（第二次 added:0 且不再 refresh）", async () => {
    const w = makeWorld({ seed: [{ start: 100, code: BIB_CODE }, { start: 5, code: CITE_CODE }] });
    await w.I.addUncited(["UNC1"]);
    const before = w.state.fields[0].Code.Text;
    const exec0 = countCalls(w.state, "execCommand");

    const r2 = await w.I.addUncited(["UNC1"]);
    if (r2.added !== 0) throw new Error("第二次调用不该重复添加：" + JSON.stringify(r2));
    if (r2.uncited !== 1) throw new Error("uncited 总数被算成 " + r2.uncited);
    if (w.state.fields[0].Code.Text !== before) throw new Error("重复调用改了域代码");
    if (occurences(w.state.fields[0].Code.Text, "items/UNC1") !== 1) {
      throw new Error("域代码里出现了多个 UNC1: " + w.state.fields[0].Code.Text);
    }
    if (countCalls(w.state, "execCommand") !== exec0) throw new Error("没有新增条目却去 refresh 了");
  });

  await check("addUncited：多次/批量补入，原有条目与已有 uncited 都保留", async () => {
    const seeded = 'ADDIN ZOTERO_BIBL {"uncited":[["' + PREFIX + '/items/OLD1"]],"omitted":["k9"],'
      + '"custom":["c1"]} CSL_BIBLIOGRAPHY';
    const w = makeWorld({ seed: [{ start: 100, code: seeded }, { start: 5, code: CITE_CODE }] });
    const r = await w.I.addUncited(["NEW1", "NEW2", "OLD1", "NEW1"]);   // 含重复 key
    if (r.added !== 2) throw new Error("应只新增 2 条（OLD1 已存在、NEW1 去重）：" + JSON.stringify(r));
    if (r.uncited !== 3) throw new Error("uncited 总数应为 3：" + JSON.stringify(r));

    const code = w.state.fields[0].Code.Text;
    if (code.indexOf('["' + PREFIX + '/items/OLD1"]') < 0) throw new Error("原有 uncited 丢了: " + code);
    if (code.indexOf('"omitted":["k9"]') < 0) throw new Error("omitted 原值丢了: " + code);
    if (code.indexOf('"custom":["c1"]') < 0) throw new Error("custom 原值丢了: " + code);
    if (occurences(code, "items/NEW1") !== 1) throw new Error("NEW1 重复: " + code);

    // 写回后仍能被 JSON 解析，且形状是数组的数组
    const json = code.slice(code.indexOf("{"), code.lastIndexOf("}") + 1);
    const obj = JSON.parse(json);
    if (!Array.isArray(obj.uncited)) throw new Error("uncited 不是数组");
    for (const g of obj.uncited) {
      if (!Array.isArray(g)) throw new Error("uncited 的每一项都必须是数组（URI 数组）");
    }
  });

  await check("addUncited：文献表域代码被截断 → 抛错而不是写坏", async () => {
    const w = makeWorld({
      seed: [{ start: 100, code: BIB_CODE, opts: { truncateCode: 40 } }, { start: 5, code: CITE_CODE }],
    });
    await expectThrow(() => w.I.addUncited(["UNC1"]), /没能完整保存/, "域代码被截断时应拒绝");
    const code = w.state.fields[0].Code.Text;
    if (code.indexOf("http") >= 0) throw new Error("半截新数据留在了域里: " + code);
    if (code !== BIB_CODE.slice(0, 40)) throw new Error("没有尽量退回原域代码，实际: " + code);
    if (countCalls(w.state, "execCommand") !== 0) throw new Error("域代码没写成就该停下，不该 refresh");
  });

  console.log("== 文献表悬挂缩进 ==");

  await check("文献表 setText → 设 LeftIndent=21 / FirstLineIndent=-21", async () => {
    const w = makeWorld({ seed: [{ start: 100, code: BIB_CODE }] });
    const fmap = w.I.__fieldMapForTest;
    const f = w.state.fields[0];
    fmap.set(7001, { field: f, key: "k7001" });

    await w.I.handle("Field.setText", [null, 7001, '<div class="csl-entry">[1] 张三. 2020.</div>']);
    if (String(f.Result.Text).indexOf("[1] 张三") < 0) throw new Error("文本没写进去: " + f.Result.Text);
    const pf = f.Result.ParagraphFormat;
    if (pf.LeftIndent !== 21) throw new Error("LeftIndent 应为 21，实际 " + pf.LeftIndent);
    if (pf.FirstLineIndent !== -21) throw new Error("FirstLineIndent 应为 -21，实际 " + pf.FirstLineIndent);
    fmap.delete(7001);
  });

  await check("引文域 setText → 绝不动段落缩进", async () => {
    const w = makeWorld({ seed: [{ start: 5, code: CITE_CODE }] });
    const fmap = w.I.__fieldMapForTest;
    const f = w.state.fields[0];
    fmap.set(7002, { field: f, key: "k7002" });

    await w.I.handle("Field.setText", [null, 7002, "<sup>[1]</sup>"]);
    if (f.Result.ParagraphFormat.LeftIndent !== 0 || f.Result.ParagraphFormat.FirstLineIndent !== 0) {
      throw new Error("引文域被设了缩进: " + JSON.stringify(f.__pfWrites));
    }
    if (f.__pfWrites.length !== 0) throw new Error("引文域不该有任何 ParagraphFormat 写入");
    fmap.delete(7002);
  });

  await check("ParagraphFormat 抛错时静默跳过，setText 仍返回成功", async () => {
    const w = makeWorld({ seed: [{ start: 100, code: BIB_CODE, opts: { noParagraphFormat: true } }] });
    const fmap = w.I.__fieldMapForTest;
    const f = w.state.fields[0];
    fmap.set(7003, { field: f, key: "k7003" });

    let r = null;
    let err = null;
    try {
      r = await w.I.handle("Field.setText", [null, 7003, '<div class="csl-entry">[1] A.</div>']);
    } catch (e) { err = e; }
    fmap.delete(7003);
    if (err) throw new Error("ParagraphFormat 的异常冒泡了: " + err.message);
    if (r !== true) throw new Error("命令应仍然成功（返回 true），实际 " + JSON.stringify(r));
    if (String(f.Result.Text).indexOf("[1] A.") < 0) throw new Error("文本没写进去: " + f.Result.Text);
  });

  console.log("\n通过 " + passed + " 项，失败 " + failed + " 项" + (failed === 0 ? "，全部通过" : ""));
  process.exit(failed === 0 ? 0 : 1);
})();
