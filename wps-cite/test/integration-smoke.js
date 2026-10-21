// 按 index.html 的顺序在 Node 里复现加载，验证 integration.js 能拿到 root.PPDoc。
// 目的：复现并回归「Cannot read properties of undefined (reading 'doc')」。
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

// ---- 迷你 WPS 桩：只实现 doc.js / integration.js 走到的那几个属性 ----
function makeDoc() {
  const props = [];
  return {
    FullName: "C:\\tmp\\smoke.docx",
    CustomDocumentProperties: {
      get Count() { return props.length; },
      Item(i) { return props[i - 1]; },
      Add(name, linkToContent, type, value) {
        props.push({ Name: name, Value: value });
        return props[props.length - 1];
      },
    },
    Content: { Text: "hello world", Collapse() {} },
    Bookmarks: {
      get Count() { return 0; },
      Item() { return null; },
    },
    Fields: {
      get Count() { return 0; },
      Item() { return null; },
      Add() { throw new Error("smoke: Fields.Add 未实现"); },
    },
    Activate() {},
  };
}

const docObj = makeDoc();
const app = {
  ActiveDocument: docObj,
  Documents: { get Count() { return 1; }, Item() { return docObj; } },
  Selection: { Range: { Text: "", Collapse() {}, Select() {} } },
};

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  AbortController,
  fetch: () => { throw new Error("smoke: 不该发网络请求"); },
  alert: () => {},
  wps: { WpsApplication: () => app },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

let failed = 0;
function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      return r.then(
        () => console.log("  PASS " + name),
        (e) => { failed++; console.log("  FAIL " + name + " -> " + ((e && e.message) || e)); }
      );
    }
    console.log("  PASS " + name);
  } catch (e) {
    failed++;
    console.log("  FAIL " + name + " -> " + ((e && e.message) || e));
  }
  return Promise.resolve();
}

(async () => {
  for (const rel of ORDER) {
    const code = fs.readFileSync(path.join(ADDON, rel), "utf8");
    vm.runInContext(code, sandbox, { filename: rel });
  }
  console.log("加载完成，全局：", Object.keys(sandbox).filter((k) => k.startsWith("PP")).join(", "));

  await check("PPDoc 已定义", () => {
    if (!sandbox.PPDoc) throw new Error("PPDoc undefined");
  });
  await check("PPIntegration 已定义", () => {
    if (!sandbox.PPIntegration) throw new Error("PPIntegration undefined");
  });

  const I = sandbox.PPIntegration;
  await check("handle(getActiveDocument) 不抛 reading 'doc'", async () => {
    const r = await I.handle("Application.getActiveDocument", []);
    if (r.documentID !== "papilot-wps-doc") throw new Error("documentID 不对: " + JSON.stringify(r));
    if (!r.supportsCitationMerging) throw new Error("能力位缺失");
  });
  await check("handle(getDocumentData) 首次返回空串", async () => {
    const r = await I.handle("Document.getDocumentData", []);
    if (r !== "") throw new Error("预期空串，实际 " + JSON.stringify(r));
  });
  await check("handle(setDocumentData) 后能读回", async () => {
    await I.handle("Document.setDocumentData", [[], '{"a":1}']);
    const r = await I.handle("Document.getDocumentData", []);
    if (r !== '{"a":1}') throw new Error("读回不一致: " + JSON.stringify(r));
  });
  await check("handle(canInsertField) = true", async () => {
    const r = await I.handle("Document.canInsertField", []);
    if (r !== true) throw new Error("预期 true");
  });
  await check("handle(getFields) 空文档返回空数组", async () => {
    const r = await I.handle("Document.getFields", []);
    if (!Array.isArray(r) || r.length !== 0) throw new Error("预期 []，实际 " + JSON.stringify(r));
  });
  await check("handle(getDocument) 返回正文", async () => {
    const r = await I.handle("Document.getDocument", []);
    if (r.text !== "hello world") throw new Error("正文不对: " + JSON.stringify(r));
  });
  await check("handle(未实现命令) 不抛", async () => {
    await I.handle("Document.somethingUnknown", []);
  });

  // ---- Zotero 的 HTML → 富文本（这是【<sup>[1]</sup>】能变成真上标的关键）----
  await check("htmlToRuns: <sup>[1]</sup> → 上标 run", () => {
    const runs = I.htmlToRuns("<sup>[1]</sup>");
    if (runs.length !== 1) throw new Error("run 数不对: " + JSON.stringify(runs));
    if (!runs[0].sup) throw new Error("没识别出 sup");
    if (runs[0].text !== "[1]") throw new Error("文本不对: " + JSON.stringify(runs[0].text));
  });
  await check("htmlToRuns: 纯文本不带格式", () => {
    const runs = I.htmlToRuns("[1, 2]");
    if (runs.length !== 1) throw new Error("run 数不对");
    if (runs[0].sup || runs[0].italic || runs[0].bold) throw new Error("不该有格式");
    if (runs[0].text !== "[1, 2]") throw new Error("文本不对: " + JSON.stringify(runs[0].text));
  });
  await check("htmlToRuns: 嵌套 i/b 与 span[small-caps]", () => {
    const runs = I.htmlToRuns('<i>Nature</i> <b>2020</b> <span style="font-variant:small-caps">cn</span>');
    const it = runs.find((r) => r.text === "Nature");
    const bd = runs.find((r) => r.text === "2020");
    const sc = runs.find((r) => r.text === "cn");
    if (!it || !it.italic) throw new Error("斜体丢了");
    if (!bd || !bd.bold) throw new Error("粗体丢了");
    if (!sc || !sc.smallcaps) throw new Error("小型大写丢了");
  });
  await check("htmlToRuns: 实体解码", () => {
    const runs = I.htmlToRuns("a &amp; b&#160;c");
    const all = runs.map((r) => r.text).join("");
    if (all !== "a & b\u00a0c") throw new Error("解码不对: " + JSON.stringify(all));
  });
  await check("htmlToRuns: sup 只作用于自己那段", () => {
    const runs = I.htmlToRuns("前缀<sup>[3]</sup>后缀");
    const joined = runs.map((r) => (r.sup ? "S" : "-") + r.text).join("|");
    if (joined !== "-前缀|S[3]|-后缀") throw new Error("分段不对: " + joined);
  });
  await check("htmlToRuns: 文献表 <div class=csl-entry> 每条一行", () => {
    const runs = I.htmlToRuns(
      '<div class="csl-bib-body"><div class="csl-entry">[1] 张三. 2020.</div>'
      + '<div class="csl-entry">[2] 李四. 2021.</div></div>'
    );
    const plain = runs.map((r) => r.text).join("");
    if (plain !== "[1] 张三. 2020.\n[2] 李四. 2021.") {
      throw new Error("换行不对: " + JSON.stringify(plain));
    }
  });
  /* 真机回归（2026-10-21）：GB/T 7714 这类 second-field-align 样式，citeproc 输出的是
   *   <div class="csl-entry"><div class="csl-left-margin">[1]</div>
   *   <div class="csl-right-inline">作者. 题名[J]…</div></div>
   * 两个 div 是同一行的左右两半。早先一律当块级 → 用户看到的是「[1]↵作者…」，
   * 每个编号独占一行。这里必须钉死：[1] 与正文同行，条目间只一个换行，且不许有前导空行。 */
  await check("htmlToRuns: 数字制 [1] 与正文同一行（csl-left-margin 不断行）", () => {
    const runs = I.htmlToRuns(
      '<div class="csl-bib-body">\n  <div class="csl-entry">\n'
      + '    <div class="csl-left-margin">[1]</div>'
      + '<div class="csl-right-inline">刘广运, 白莉. 2020版《中国药典》分析[J]. 2024, 40(4): 115-120.</div>\n'
      + '  </div>\n  <div class="csl-entry">\n'
      + '    <div class="csl-left-margin">[2]</div>'
      + '<div class="csl-right-inline">（明）倪朱谟撰. 本草汇言[M]. 2005.</div>\n'
      + '  </div>\n</div>'
    );
    const plain = runs.map((r) => r.text).join("");
    const want = "[1] 刘广运, 白莉. 2020版《中国药典》分析[J]. 2024, 40(4): 115-120."
      + "\n[2] （明）倪朱谟撰. 本草汇言[M]. 2005.";
    if (plain !== want) throw new Error("排版不对: " + JSON.stringify(plain));
    if (plain.indexOf("\n[1]") === 0 || plain[0] === " ") throw new Error("开头有空行/空格: " + JSON.stringify(plain));
    if (/\n\n/.test(plain)) throw new Error("条目之间有连续空行: " + JSON.stringify(plain));
  });
  /* 缩进块（csl-indent）确实是块级，必须保留换行 —— 别把上面的修复做成"什么都不断行"。 */
  await check("htmlToRuns: csl-indent 仍然换行（修复没有把块级一起干掉）", () => {
    const plain = I.htmlToRuns('<div class="csl-entry">A.<div class="csl-indent">B</div></div>')
      .map((r) => r.text).join("");
    if (plain !== "A.\nB") throw new Error("缩进块没换行: " + JSON.stringify(plain));
  });
  /* 行内元素之间的单个空格有意义，不能被"去缩进"误删 */
  await check("htmlToRuns: 行内元素之间的空格保留", () => {
    const plain = I.htmlToRuns("见 <i>Nature</i> 与 <i>Science</i>").map((r) => r.text).join("");
    if (plain !== "见 Nature 与 Science") throw new Error("空格丢了: " + JSON.stringify(plain));
  });
  /* 真机回归（2026-10-21）：光标停在已有引文域内部时插入，新域会被**嵌进**旧域，
   * 旧引文显示被撕成 "[1[5,5–7]–4]"，Zotero 还会弹"您做了修改，要保留吗"。
   * 要求：插入点自动挪到该域之后；而光标紧跟域尾（域外）时不许动。 */
  await check("插入点在已有域内 → 改插到该域之后（不嵌域）", async () => {
    const appObj = sandbox.wps.WpsApplication();
    const docObj = appObj.ActiveDocument;
    const oldFields = docObj.Fields;
    const oldRange = docObj.Range;
    const sel = appObj.Selection;
    const oldStart = sel.Range.Start;
    const added = [];
    docObj.Range = (s, e) => ({ Start: s, End: e, Font: {} });
    docObj.Fields = {
      get Count() { return 1; },
      Item: () => ({ Result: { Start: 100, End: 300, Text: "[1–4]" }, Code: { Text: "" } }),
      Add: (r) => {
        added.push(r.Start);
        return { Result: { Start: r.Start, End: r.Start, Text: "" }, Code: { Text: "" } };
      },
    };
    try {
      sel.Range.Start = 150;                       // 落在域内
      await I.handle("Document.insertField", [null, "Http", 0]);
      if (added[0] !== 300) throw new Error("域内插入没挪到域尾，落在 " + added[0]);
      sel.Range.Start = 310;                       // 紧跟域后 = 域外
      await I.handle("Document.insertField", [null, "Http", 0]);
      if (added[1] !== 310) throw new Error("域外插入被误改到 " + added[1]);
    } finally {
      docObj.Fields = oldFields;
      docObj.Range = oldRange;
      sel.Range.Start = oldStart;
    }
  });
  /* 真机回归（2026-10-21）：命令名写错（refreshDocument）时 Zotero 抛 TypeError 但走不到
   * complete，表现为"点了没反应"，我们等 30 分钟才超时。这里静态校验按钮用的每个名字
   * 都真实存在于 Zotero.Integration.Interface.prototype 的方法表里。 */
  await check("三个主按钮的命令名都在 Zotero 的 Interface 方法表里", () => {
    const src = fs.readFileSync(path.join(ADDON, "js", "app.js"), "utf8");
    const names = [...src.matchAll(/nativeRun\("([A-Za-z]+)"\)/g)].map((m) => m[1]);
    if (!names.length) throw new Error('app.js 里没有 nativeRun("…")，这条测试要跟着改');
    const KNOWN = [
      "addCitation", "editCitation", "addEditCitation", "addNote", "addAnnotation",
      "addBibliography", "editBibliography", "addEditBibliography", "citationExplorer",
      "refresh", "removeCodes", "setDocPrefs", "exportDocument",
    ];
    for (const n of names) {
      if (KNOWN.indexOf(n) < 0) throw new Error("按钮用了 Zotero 不存在的命令名：" + n);
    }
    if (names.indexOf("refresh") < 0) throw new Error("【刷新】没有映射到 refresh");
    if (names.indexOf("addEditCitation") < 0) throw new Error("【插入引文】没用 addEditCitation（会嵌域）");
    if (names.indexOf("addEditBibliography") < 0) throw new Error("【文献表】没用 addEditBibliography（会重复建表）");
  });
  /* 官方"添加/编辑引注"的前提：光标在引注里时 cursorInField 必须返回那个域。 */
  await check("cursorInField：引注里返回该域、普通域与域尾都返回 false", async () => {
    const appObj = sandbox.wps.WpsApplication();
    const docObj = appObj.ActiveDocument;
    const oldFields = docObj.Fields;
    const oldRange = docObj.Range;
    const sel = appObj.Selection;
    const oldStart = sel.Range.Start;
    docObj.Range = (s, e) => ({ Start: s, End: e, Font: {} });
    docObj.Fields = {
      get Count() { return 2; },
      Item: (i) => (i === 1
        ? { Result: { Start: 100, End: 140, Text: "[1]" }, Code: { Text: 'ADDIN ZOTERO_ITEM CSL_CITATION {"citationID":"abc12345"}' } }
        : { Result: { Start: 200, End: 210, Text: "3" }, Code: { Text: "PAGE" } }),
    };
    try {
      sel.Range.Start = 120;
      const r = await I.handle("Document.cursorInField", [null, "Http"]);
      if (!r || !r.id) throw new Error("引注里没返回域对象: " + JSON.stringify(r));
      if (!/CSL_CITATION/.test(r.code)) throw new Error("code 没还原成 Zotero 方言: " + r.code);
      sel.Range.Start = 205;
      if ((await I.handle("Document.cursorInField", [null, "Http"])) !== false) {
        throw new Error("普通域（PAGE）被当成引注了");
      }
      sel.Range.Start = 140;
      if ((await I.handle("Document.cursorInField", [null, "Http"])) !== false) {
        throw new Error("域尾（紧跟引注之后）被误判成域内");
      }
    } finally {
      docObj.Fields = oldFields;
      docObj.Range = oldRange;
      sel.Range.Start = oldStart;
    }
  });
  await check("handle(Field.setText) 把 HTML 写成纯文本并置上标", async () => {
    // 先造一个域（桩里的 Fields.Add 会抛，所以直接塞一个假 field 进 handle 的路径）
    const docObj = sandbox.wps.WpsApplication().ActiveDocument;
    const made = [];
    docObj.Range = function (s, e) {
      const r = { Start: s, End: e, Font: {} };
      made.push(r);
      return r;
    };
    // 用 insertField 会抛，改为直接验证 writeRuns 的效果：调用 setText 前先手工注册域
    const fakeField = { Result: { Text: "", Start: 100 }, Code: { Text: "" } };
    const fmap = I.__fieldMapForTest;
    if (!fmap) throw new Error("测试桩缺失 __fieldMapForTest");
    fmap.set(9001, { field: fakeField, key: "t" });
    await I.handle("Field.setText", [null, 9001, "<sup>[7]</sup>"]);
    if (fakeField.Result.Text !== "[7]") throw new Error("写入文本不对: " + fakeField.Result.Text);
    if (!made.length) throw new Error("没有取到 Range，上标没设");
    if (!made[0].Font.Superscript) throw new Error("Range 没设 Superscript");
  });
  await check("getFields: 空文献表域返回零宽占位，避免被 Zotero 清掉", async () => {
    const docObj = sandbox.wps.WpsApplication().ActiveDocument;
    const saved = docObj.Fields;
    const bibl = { Code: { Text: "BIBL {} CSL_BIBLIOGRAPHY" }, Result: { Text: "", Start: 200 } };
    docObj.Fields = { get Count() { return 1; }, Item() { return bibl; } };
    try {
      const r = await I.handle("Document.getFields", [null, "Field"]);
      if (r.length !== 1) throw new Error("域数量不对: " + r.length);
      if (!r[0].text || String(r[0].text).trim() === "") {
        throw new Error("空文献表域没给占位——Zotero 会判成空文献表并 removeCode");
      }
    } finally {
      docObj.Fields = saved;
    }
  });
  await check("removeCode 不许 Unlink 掉域", async () => {
    const fmap = I.__fieldMapForTest;
    let unlinked = false;
    const f = {
      Code: { Text: "" }, Result: { Text: "x", Start: 1 },
      Delete() {}, Unlink() { unlinked = true; },
    };
    fmap.set(9100, { field: f, key: "k9100" });
    await I.handle("Field.removeCode", [null, 9100]);
    if (unlinked) throw new Error("removeCode 把域 Unlink 了——文献表会被毁");
    if (!fmap.has(9100)) throw new Error("域不该从映射里消失");
    fmap.delete(9100);
  });

  // ---- 域代码方言转换：文档里要 Word 格式，交给 Zotero 要内部格式 ----
  await check("toWordCode: ITEM → ADDIN ZOTERO_ITEM", () => {
    const out = I.toWordCode('ITEM CSL_CITATION {"citationID":"x"}');
    if (out !== 'ADDIN ZOTERO_ITEM CSL_CITATION {"citationID":"x"}') {
      throw new Error("转换不对: " + out);
    }
  });
  await check("toWordCode: BIBL → ADDIN ZOTERO_BIBL", () => {
    const out = I.toWordCode("BIBL {} CSL_BIBLIOGRAPHY");
    if (out !== "ADDIN ZOTERO_BIBL {} CSL_BIBLIOGRAPHY") throw new Error("转换不对: " + out);
  });
  await check("toZoteroCode: 还原回内部方言", () => {
    const a = I.toZoteroCode('ADDIN ZOTERO_ITEM CSL_CITATION {"citationID":"x"}');
    if (a !== 'ITEM CSL_CITATION {"citationID":"x"}') throw new Error("引文还原不对: " + a);
    const b = I.toZoteroCode("ADDIN ZOTERO_BIBL {} CSL_BIBLIOGRAPHY");
    if (b !== "BIBL {} CSL_BIBLIOGRAPHY") throw new Error("文献表还原不对: " + b);
  });
  await check("域代码方言往返无损", () => {
    const cases = ['ITEM CSL_CITATION {"citationID":"gGbTpug8"}', "BIBL {} CSL_BIBLIOGRAPHY"];
    for (const c of cases) {
      const back = I.toZoteroCode(I.toWordCode(c));
      if (back !== c) throw new Error("往返不一致: " + c + " -> " + back);
    }
  });
  await check("文档里存 Word 方言，双向链接才认得（zfields 要有 ZOTERO_ITEM）", () => {
    const stored = I.toWordCode('ITEM CSL_CITATION {"citationID":"x"}');
    if (stored.indexOf("ZOTERO_ITEM") < 0) throw new Error("域代码里没有 ZOTERO_ITEM，双向链接会解析不到");
  });

  // ---- 互斥锁：用户在 Zotero 框里点 X 取消后，不能把 UI 永久锁死 ----
  await check("忙等：前一个事务收尾后，第二次点击能成功而不是被硬拒绝", async () => {
    I.__setBusyTimings(1500, 60000);          // 缩短等待窗口，便于测试
    let release = null;
    let execCount = 0;
    sandbox.fetch = async (url) => {
      const p = String(url).replace(/^http:\/\/127\.0\.0\.1:21932/, "");
      if (p.indexOf("/log") === 0) return { ok: true, status: 200, text: async () => "{}" };
      if (p.indexOf("execCommand") >= 0) {
        execCount++;
        if (execCount === 1) await new Promise((r) => { release = r; });   // 第一个事务挂住
        return { ok: true, status: 200, text: async () => JSON.stringify({ command: "Document.complete" }) };
      }
      return { ok: true, status: 200, text: async () => "{}" };
    };

    const first = I.run("addCitation").catch(() => null);
    await new Promise((r) => setTimeout(r, 60));
    if (!I.__getBusy()) throw new Error("第一个事务没拿到锁");

    const second = I.run("addBibliography").then(() => "ok", (e) => "err:" + e.message);
    await new Promise((r) => setTimeout(r, 300));
    // 此时第二次应该还在等，而不是已经抛错
    const early = await Promise.race([second, new Promise((r) => setTimeout(() => r("pending"), 120))]);
    if (early !== "pending") throw new Error("第二次点击被立刻拒绝/结束了：" + early);

    release();                                 // 放行第一个事务
    await first;
    const after = await second;
    if (after !== "ok") throw new Error("收尾后第二次点击仍失败：" + after);
    if (I.__getBusy()) throw new Error("锁没释放");
    I.__setBusyTimings(10000, 1800000);         // 复原
  });
  await check("僵尸锁：超时后打日志提示，不永久卡死 UI（不擅自放锁）", async () => {
    /* 语义更新（2026-10-21，审查 P2-7）：原来"超时强制释放"会让真在挑文献的用户
     * 丢锁（挑超过 3 分钟就被人从后面抢走）。现在 STALE 默认 30 分钟，
     * 触发后**只打日志提示、不放锁** —— 并发的裁决权交回给 Zotero 自己的 503。
     * 这条用例验证的是"UI 不卡死 + 给出人话错误"，不再验证"锁被释放"。 */
    I.__setBusyTimings(1200, 100);            // 等 1200ms；锁被占超 100ms 就视为僵死
    let firstHang = true;
    sandbox.fetch = async (url) => {
      const p = String(url).replace(/^http:\/\/127\.0\.0\.1:21932/, "");
      if (p.indexOf("/log") === 0) return { ok: true, status: 200, text: async () => "{}" };
      if (p.indexOf("execCommand") >= 0) {
        if (firstHang) { firstHang = false; await new Promise(() => {}); }  // 第一个事务永远不返回
        return { ok: true, status: 200, text: async () => "{}" };
      }
      return { ok: true, status: 200, text: async () => "{}" };
    };
    const stuck = I.run("addCitation").catch(() => null);   // 占住锁且不放手
    await new Promise((r) => setTimeout(r, 200));
    const t0 = Date.now();
    let msg = "";
    try { await I.run("addBibliography"); } catch (e) { msg = String(e.message); }
    if (!msg) throw new Error("僵尸锁没有被识别");
    if (Date.now() - t0 > 1500) throw new Error("等太久，像是被硬锁住");
    I.__setBusyTimings(10000, 1800000);
    // 第一个事务的 fetch 永远悬挂，busy 没法走正常路径清掉；这里手动复位，
    // 否则后续所有用例都会拿到"还在收尾"。
    I.__resetBusy();
    void stuck;
  });

  /* 真机回归（2026-10-21）：文献表命令没有"用户取消"这回事。第一次插入文献表时，
   * 域刚建好、结果为空，Zotero 会判空表并 removeCode，于是整笔事务一个 setText 都没有。
   * 这种情况原来被当成"用户取消"，界面静默 —— 用户看到的就是"点【插入/更新文献表】没反应，
   * 点第二次才行"。要求：返回 ok:true（empty），绝不能是 cancelled。 */
  await check("文献表没有可写内容 → ok:true(empty)，不许判成用户取消", async () => {
    I.__setBusyTimings(10000, 1800000);
    const SEQ = [
      { command: "Document.getDocumentData", arguments: ["d"] },
      { command: "Field.removeCode", arguments: ["d", 1] },
      { command: "Document.activate", arguments: ["d"] },
      { command: "Document.complete", arguments: ["d"] },
    ];
    const ok = (t) => ({ ok: true, status: 200, text: async () => t });
    let step = 0;
    sandbox.fetch = async (url) => {
      const p = String(url).replace(/^http:\/\/127\.0\.0\.1:21932/, "");
      if (p.indexOf("/log") === 0) return ok("{}");
      if (p.indexOf("execCommand") >= 0) {
        return ok(JSON.stringify({ command: "Application.getActiveDocument", arguments: [] }));
      }
      if (p.indexOf("respond") >= 0) return ok(JSON.stringify(SEQ[Math.min(step++, SEQ.length - 1)]));
      return ok("{}");
    };
    const r = await I.run("addEditBibliography");
    if (r.cancelled) throw new Error("文献表被误判成用户取消：" + JSON.stringify(r));
    if (r.ok !== true) throw new Error("没有返回 ok:true：" + JSON.stringify(r));
    if (!r.empty) throw new Error("应该标 empty 让界面能给一句人话：" + JSON.stringify(r));
  });
  /* 同一个空文本场景，引注类命令仍然必须判成取消（用户点 X 取消插入是真实存在的）。 */
  await check("引注类仍然要判 cancelled（与文献表区分开）", async () => {
    I.__setBusyTimings(10000, 1800000);
    const SEQ = [
      { command: "Document.getDocumentData", arguments: ["d"] },
      { command: "Document.activate", arguments: ["d"] },
      { command: "Document.complete", arguments: ["d"] },
    ];
    const ok = (t) => ({ ok: true, status: 200, text: async () => t });
    let step = 0;
    sandbox.fetch = async (url) => {
      const p = String(url).replace(/^http:\/\/127\.0\.0\.1:21932/, "");
      if (p.indexOf("/log") === 0) return ok("{}");
      if (p.indexOf("execCommand") >= 0) {
        return ok(JSON.stringify({ command: "Application.getActiveDocument", arguments: [] }));
      }
      if (p.indexOf("respond") >= 0) return ok(JSON.stringify(SEQ[Math.min(step++, SEQ.length - 1)]));
      return ok("{}");
    };
    const r = await I.run("addEditCitation");
    if (!r.cancelled) throw new Error("引注取消没被识别：" + JSON.stringify(r));
  });

  // ---- 用户点 X 取消：全程没有 setText，要判成 cancelled ----
  await check("点 X 取消 → 返回 cancelled，不触发台账同步", async () => {
    I.__setBusyTimings(10000, 1800000);
    const SEQ = [
      { command: "Document.getDocumentData", arguments: ["d"] },
      { command: "Document.activate", arguments: ["d"] },
      { command: "Document.complete", arguments: ["d"] },
    ];
    let step = 0;
    sandbox.fetch = async (url) => {
      const p = String(url).replace(/^http:\/\/127\.0\.0\.1:21932/, "");
      if (p.indexOf("/log") === 0) return { ok: true, status: 200, text: async () => "{}" };
      if (p.indexOf("execCommand") >= 0) {
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ command: "Application.getActiveDocument", arguments: [] }),
        };
      }
      if (p.indexOf("respond") >= 0) {
        const c = SEQ[Math.min(step++, SEQ.length - 1)];
        return { ok: true, status: 200, text: async () => JSON.stringify(c) };
      }
      return { ok: true, status: 200, text: async () => "{}" };
    };
    const r = await I.run("addCitation");
    if (r.ok) throw new Error("取消时不该返回 ok:true（外层还会去同步台账）");
    if (!r.cancelled) throw new Error("没标记 cancelled：" + JSON.stringify(r));
  });

  // ---- run() 的错误收尾：handle 抛错后必须把事务走完，否则 Zotero 卡在 inProgress（503）----
  await check("run 失败后走完事务并抛出原始错误", async () => {
    const seen = [];
    let step = 0;
    const SEQ = [
      { command: "Document.activate", arguments: ["papilot-wps-doc"] },
      { command: "Document.displayAlert", arguments: ["papilot-wps-doc", "boom", 0, 0] },
      { command: "Document.cleanup", arguments: ["papilot-wps-doc"] },
      { command: "Document.activate", arguments: ["papilot-wps-doc"] },
      { command: "Document.complete", arguments: ["papilot-wps-doc"] },
    ];
    const ok = (t) => ({ ok: true, status: 200, text: async () => t });
    sandbox.fetch = async (url, opts) => {
      const p = String(url).replace(/^http:\/\/127\.0\.0\.1:21932/, "");
      const body = opts && opts.body ? JSON.parse(opts.body) : null;
      seen.push({ path: p, body });
      if (p.indexOf("/log") === 0) return ok("{}");
      if (p.indexOf("/zit/connector/document/execCommand") === 0) {
        // 故意挑一个我们的桩一定会抛错的命令
        return ok(JSON.stringify({ command: "Document.insertField", arguments: ["papilot-wps-doc"] }));
      }
      if (p.indexOf("/zit/connector/document/respond") === 0) {
        step++;
        return ok(JSON.stringify(SEQ[Math.min(step - 1, SEQ.length - 1)]));
      }
      return ok("{}");
    };

    let err = null;
    try { await I.run("addCitation"); } catch (e) { err = e; }
    if (!err) throw new Error("run 应该抛出原始错误，实际正常返回了");
    if (String(err.message).indexOf("Fields.Add") < 0) {
      throw new Error("抛出的不是原始错误: " + err.message);
    }
    // 注意：路径是 /zit/connector/document/respond，前缀不是路径开头
    const responds = seen.filter((s) => s.path.indexOf("/connector/document/respond") >= 0);
    if (!responds.length) {
      throw new Error("没有任何 respond；err=" + String(err.message)
        + "；请求序列=" + JSON.stringify(seen.map((s) => s.path)));
    }
    if (!(responds[0].body && responds[0].body.error === "Alert")) {
      throw new Error("首个 respond 应走 {error:'Alert'} 通道，实际 " + JSON.stringify(responds[0].body));
    }
    // 关键断言：错误之后仍然继续响应了后续命令（activate/displayAlert/cleanup/complete）
    if (responds.length < 4) {
      throw new Error("出错后没有继续收尾，respond 只有 " + responds.length + " 次 —— Zotero 会卡死");
    }
    // 最后一步必须是把 complete 的那次 respond 收尾（/log 是 fire-and-forget，要滤掉）
    const real = seen.filter((s) => s.path.indexOf("/log") < 0);
    const last = real[real.length - 1];
    if (last.path.indexOf("respond") < 0) {
      throw new Error("最后一次业务请求不是 respond：" + last.path);
    }
  });

  // ---- 没有文档时必须在发起事务前就拦住（否则 Zotero 永久卡 inProgress）----
  await check("无文档时 run 不发 execCommand，直接报错", async () => {
    const appObj = sandbox.wps.WpsApplication();
    const savedDoc = appObj.ActiveDocument;
    const savedCount = Object.getOwnPropertyDescriptor(appObj.Documents, "Count");
    appObj.ActiveDocument = null;
    Object.defineProperty(appObj.Documents, "Count", { get: () => 0, configurable: true });

    const seen = [];
    sandbox.fetch = async (url, opts) => {
      const p = String(url).replace(/^http:\/\/127\.0\.0\.1:21932/, "");
      seen.push(p);
      return { ok: true, status: 200, text: async () => "{}" };
    };

    let err = null;
    try { await I.run("addCitation"); } catch (e) { err = e; } finally {
      appObj.ActiveDocument = savedDoc;
      Object.defineProperty(appObj.Documents, "Count", savedCount);
    }
    if (!err) throw new Error("无文档时应直接报错");
    if (seen.some((p) => p.indexOf("execCommand") >= 0)) {
      throw new Error("无文档时不应发起事务（会卡死 Zotero），实际发了 execCommand");
    }
    if (String(err.message).indexOf("打开一个文档") < 0) {
      throw new Error("错误信息不友好: " + err.message);
    }
  });

  console.log(failed === 0 ? "\n全部通过" : "\n失败 " + failed + " 项");
  process.exit(failed === 0 ? 0 : 1);
})();
