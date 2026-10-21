#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 引文导航（nav.js）单测
 *
 * 做法照 test/integration-smoke.js：用 vm 按 addon/index.html 的顺序把模块加载到一个沙箱里，
 * wps 用桩顶替。区别是这里的桩要**记账**：Fields.Item(i).Result.Select() 被调用过几次、
 * 调的是哪一条 —— 导航的最终效果就是「选中了哪条域」，不记账等于没测。
 *
 * 运行：node wps-cite/test/nav.test.js
 */
"use strict";

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
  "js/nav.js",          // ← 被测模块，按 index.html 里最终会追加的位置放最后
];

/* ---------------- 可变文档桩：每个用例改 state 就行 ---------------- */
const state = { fields: [], pos: 0, selects: [], scrolls: 0 };

function mkField(i, code, start, text) {
  return {
    index: i,
    Code: { Text: code },
    Result: {
      Start: start,
      End: start + String(text || "").length,
      Text: text,
      Select() { state.selects.push(i); },
    },
  };
}

const docObj = {
  FullName: "C:\\tmp\\nav.docx",
  Content: { Text: "", Collapse() {} },
  Bookmarks: {
    get Count() { return 0; },
    Item() { return null; },
    Exists() { return false; },
  },
  Fields: {
    get Count() { return state.fields.length; },
    Item(i) {
      const f = state.fields[i - 1];
      if (!f) throw new Error("桩：没有第 " + i + " 个域");
      return f;
    },
  },
};

const app = {
  get ActiveDocument() { return docObj; },
  Documents: { get Count() { return 1; }, Item() { return docObj; } },
  Selection: { get Range() { return { Start: state.pos, Text: "" }; } },
  get ActiveWindow() {
    return { ScrollIntoView() { state.scrolls++; } };
  },
};

const sandbox = {
  console: { log() {}, warn() {}, error() {} },   // 导航会打日志，测试时静音
  setTimeout,
  clearTimeout,
  AbortController,
  fetch: () => { throw new Error("nav 不该发网络请求"); },
  alert: () => {},
  prompt: () => null,
  wps: { WpsApplication: () => app },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

for (const rel of ORDER) {
  const code = fs.readFileSync(path.join(ADDON, rel), "utf8");
  vm.runInContext(code, sandbox, { filename: rel });
}

/* ---------------- 迷你断言框架 ---------------- */
let pass = 0;
const fails = [];
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log("  PASS " + name);
  } catch (e) {
    fails.push(name + " -> " + ((e && e.message) || e));
    console.log("  FAIL " + name + " -> " + ((e && e.message) || e));
  }
}
function eq(a, b, label) {
  if (a !== b) throw new Error(label + "：期望 " + JSON.stringify(b) + "，实际 " + JSON.stringify(a));
}
function ok(c, label) {
  if (!c) throw new Error(label);
}

/* ---------------- 造域 ---------------- */
function citCode(id, family, year, title) {
  return "ADDIN ZOTERO_ITEM CSL_CITATION "
    + JSON.stringify({
      citationID: id,
      properties: { noteIndex: 0 },
      citationItems: [{
        id: "http://zotero.org/users/1/items/K" + id,
        itemData: {
          id: "K" + id,
          type: "article-journal",
          title: title || "",
          author: family ? [{ family: family, given: "X" }] : undefined,
          issued: year ? { "date-parts": [[Number(year)]] } : undefined,
        },
      }],
    });
}
const BIB_CODE = 'ADDIN ZOTERO_BIBL {"custom":[]} CSL_BIBLIOGRAPHY';
const PAGE_CODE = " PAGE \\* MERGEFORMAT ";

function useFields(fields, pos) {
  state.fields = fields;
  state.scanned = scan(fields);
  state.pos = pos == null ? 0 : pos;
  state.selects = [];
  state.scrolls = 0;
}

/** 把原始域投影成 PPDoc.scanFields() 的形状 —— __parse 的入参就是这个形状，别直接喂原始域 */
function scan(fields) {
  return (fields || []).map((f) => ({ index: f.index, code: f.Code.Text, start: f.Result.Start }));
}

const Nav = sandbox.PPNav;

/* ================= ① __parse：混合域 ================= */
console.log("① __parse 混合域");
{
  useFields([
    mkField(1, citCode("C1", "张三", 2020, "甲"), 10, "[1]"),
    mkField(2, BIB_CODE, 20, "参考文献"),                 // 文献表：跳过
    mkField(3, PAGE_CODE, 30, "1"),                      // 普通域：跳过
    mkField(4, citCode("C2", "李四", 2021, "乙"), 50, "  [3, 5]  "),
  ]);

  check("只出 2 条（文献表 / PAGE 域被跳过）", () => {
    eq(Nav.__parse(state.scanned).length, 2, "条数");
  });

  check("顺序与文档顺序一致，n 从 1 起，字段都带全", () => {
    const r = Nav.__parse(state.scanned);
    eq(r[0].n, 1, "第 1 条 n");
    eq(r[0].index, 1, "第 1 条 index");
    eq(r[0].start, 10, "第 1 条 start");
    eq(r[0].citationID, "C1", "第 1 条 citationID");
    eq(r[1].n, 2, "第 2 条 n");
    eq(r[1].index, 4, "第 2 条 index");
    eq(r[1].citationID, "C2", "第 2 条 citationID");
  });

  check("label 取显示文本并去空白（不传 getText 时为空串）", () => {
    const r = Nav.__parse(state.scanned);
    eq(r[0].label, "", "没回调时 label 应为空");
    const withText = Nav.__parse(state.scanned, (i) => (i === 1 ? "[1]" : "  [3, 5]  "));
    eq(withText[0].label, "[1]", "第 1 条 label");
    eq(withText[1].label, "[3, 5]", "第 2 条 label（空白被归一）");
  });

  check("label 超过 12 字被截断", () => {
    const r = Nav.__parse(scan([mkField(1, citCode("C1"), 0, "x")]), () => "1234567890123456");
    eq(r[0].label, "123456789012", "截断长度");
  });

  check("authors / year 从 itemData 取（第一作者 family + issued）", () => {
    const r = Nav.__parse(state.scanned);
    eq(r[0].authors, "张三", "第 1 条作者");
    eq(r[0].year, "2020", "第 1 条年份");
    eq(r[1].authors, "李四", "第 2 条作者");
    eq(r[1].year, "2021", "第 2 条年份");
  });

  check("没有作者时退回 title 前 20 字，且不抛", () => {
    const code = "ADDIN ZOTERO_ITEM CSL_CITATION " + JSON.stringify({
      citationID: "CT",
      citationItems: [{ itemData: { title: "一个很长很长很长很长很长很长的标题啊" } }],
    });
    const r = Nav.__parse(scan([mkField(1, code, 0, "[9]")]));
    eq(r.length, 1, "条数");
    eq(r[0].authors, "一个很长很长很长很长很长很长的标题啊".slice(0, 20), "title 兜底");
    eq(r[0].year, "", "没有 issued 时年份为空");
  });
}

/* ================= ② __parse：坏 JSON 不许炸 ================= */
console.log("② __parse 坏 JSON");
{
  useFields([
    mkField(1, 'ADDIN ZOTERO_ITEM CSL_CITATION {"citationID":"X", "citationItems":[', 10, "[7]"),
    mkField(2, citCode("C2", "王五", 2019, "丙"), 40, "[8]"),
  ]);

  check("坏域不抛，条数不丢，坏域仍可导航", () => {
    let r;
    r = Nav.__parse(state.scanned, () => "[7]");   // 不抛就是这一步的关键
    eq(r.length, 2, "条数");
    eq(r[0].citationID, "", "坏域的 citationID 应为空串");
    eq(r[0].authors, "", "坏域作者为空");
    eq(r[0].year, "", "坏域年份为空");
    eq(r[0].label, "[7]", "坏域 label 仍从显示文本取");
    eq(r[0].start, 10, "坏域 start 保留");
    eq(r[1].citationID, "C2", "好域不受影响");
  });

  check("getText 回调抛错也不影响解析", () => {
    const r = Nav.__parse(state.scanned, () => { throw new Error("Result 没了"); });
    eq(r.length, 2, "条数");
    eq(r[0].text, "", "取不到文本 → 空串");
  });
}

/* ================= ③ next ================= */
console.log("③ next");
{
  const three = () => [
    mkField(1, citCode("C1", "张三", 2020), 10, "[1]"),
    mkField(2, citCode("C2", "李四", 2021), 50, "[2]"),
    mkField(3, citCode("C3", "王五", 2022), 90, "[3]"),
  ];

  check("光标在第一条之前 → 跳第 1 条，不循环", () => {
    useFields(three(), 0);
    const r = Nav.next();
    eq(r.ok, true, "ok");
    eq(r.n, 1, "n");
    eq(r.label, "[1]", "label");
    eq(r.total, 3, "total");
    eq(r.wrapped, undefined, "不该标记 wrapped");
    eq(state.selects.join(","), "1", "选中的域");
  });

  check("光标在两条之间 → 跳之后的那一条", () => {
    useFields(three(), 60);
    eq(Nav.next().n, 3, "n");
    eq(state.selects.join(","), "3", "选中的域");
  });

  check("光标压在第 2 条上（start 相等）→ 跳第 3 条，不原地打转", () => {
    useFields(three(), 50);
    eq(Nav.next().n, 3, "n");
    eq(state.selects.join(","), "3", "选中的域");
  });

  check("光标在最后一条之后 → 回到第 1 条并标记 wrapped", () => {
    useFields(three(), 500);
    const r = Nav.next();
    eq(r.n, 1, "n");
    eq(r.wrapped, true, "wrapped");
    eq(state.selects.join(","), "1", "选中的域");
  });
}

/* ================= ④ prev ================= */
console.log("④ prev");
{
  const three = () => [
    mkField(1, citCode("C1", "张三", 2020), 10, "[1]"),
    mkField(2, citCode("C2", "李四", 2021), 50, "[2]"),
    mkField(3, citCode("C3", "王五", 2022), 90, "[3]"),
  ];

  check("光标在第 1 条上 → 跳最后一条并标记 wrapped", () => {
    useFields(three(), 10);
    const r = Nav.prev();
    eq(r.n, 3, "n");
    eq(r.label, "[3]", "label");
    eq(r.wrapped, true, "wrapped");
    eq(state.selects.join(","), "3", "选中的域");
  });

  check("光标在两条之间 → 跳之前的那一条", () => {
    useFields(three(), 60);
    eq(Nav.prev().n, 2, "n");
    eq(state.selects.join(","), "2", "选中的域");
  });

  check("光标在第一条之前 → 回到最后一条", () => {
    useFields(three(), 0);
    eq(Nav.prev().n, 3, "n");
    eq(state.selects.join(","), "3", "选中的域");
  });

  check("光标在最后一条之后 → 跳最后一条，不循环", () => {
    useFields(three(), 500);
    const r = Nav.prev();
    eq(r.n, 3, "n");
    eq(r.wrapped, undefined, "不该标记 wrapped");
    eq(state.selects.join(","), "3", "选中的域");
  });
}

/* ================= ⑤ 跳转确实调用了 Select / ScrollIntoView ================= */
console.log("⑤ 跳转副作用");
{
  useFields([mkField(7, citCode("C7", "赵六", 2018), 30, "[7]")], 0);
  const r = Nav.next();
  check("Select() 被调用且只调一次", () => {
    eq(r.ok, true, "ok");
    eq(state.selects.length, 1, "Select 次数");
    eq(state.selects[0], 7, "Select 的域序号（是 Fields 里的 index，不是 n）");
  });
  check("尝试过 ScrollIntoView", () => {
    eq(state.scrolls, 1, "ScrollIntoView 次数");
  });

  check("ScrollIntoView 抛错不影响跳转", () => {
    const backup = app.ActiveWindow;
    Object.defineProperty(app, "ActiveWindow", {
      configurable: true,
      get() { return { ScrollIntoView() { throw new Error("这个版本没有 ScrollIntoView"); } }; },
    });
    try {
      useFields([mkField(7, citCode("C7"), 30, "[7]")], 0);
      const r2 = Nav.next();
      eq(r2.ok, true, "ok 仍为 true");
      eq(state.selects.join(","), "7", "仍然选中了");
    } finally {
      Object.defineProperty(app, "ActiveWindow", { configurable: true, get() { return backup; } });
    }
  });
}

/* ================= ⑥ 空文档 / 没有 prompt ================= */
console.log("⑥ 空文档与 prompt 缺失");
{
  useFields([mkField(1, BIB_CODE, 10, "参考文献"), mkField(2, PAGE_CODE, 20, "1")], 0);

  check("没有引文 → next 返回 ok:false 且不抛", () => {
    const r = Nav.next();
    eq(r.ok, false, "ok");
    eq(r.error, "本文档还没有引文", "error");
    eq(state.selects.length, 0, "不该选中任何域");
  });

  check("没有引文 → prev 返回 ok:false", () => {
    eq(Nav.prev().ok, false, "ok");
  });

  check("没有引文 → list 返回 ok:false", () => {
    const r = Nav.list();
    eq(r.ok, false, "ok");
    eq(r.error, "本文档还没有引文", "error");
  });

  useFields([
    mkField(1, citCode("C1", "张三", 2020), 10, "[1]"),
    mkField(2, citCode("C2", "李四", 2021), 50, "[2]"),
  ], 0);

  check("prompt 不存在时 list 返回 ok:false 而不是抛", () => {
    const saved = sandbox.prompt;
    try {
      delete sandbox.prompt;                  // 模拟 WPS 没有 prompt
      eq(typeof sandbox.prompt, "undefined", "前置：prompt 已删除");
      const r = Nav.list();
      eq(r.ok, false, "ok");
      ok(/没有可用的输入框/.test(String(r.error)), "error 提示不对：" + r.error);
      eq(state.selects.length, 0, "不该选中任何域");
    } finally {
      sandbox.prompt = saved;
    }
  });

  check("prompt 存在但一调就抛 → 也返回 ok:false", () => {
    const saved = sandbox.prompt;
    try {
      sandbox.prompt = () => { throw new Error("prompt is not a function"); };
      const r = Nav.list();
      eq(r.ok, false, "ok");
      ok(/没有可用的输入框/.test(String(r.error)), "error 提示不对：" + r.error);
    } finally {
      sandbox.prompt = saved;
    }
  });
}

/* ================= ⑦ list ================= */
console.log("⑦ list");
{
  useFields([
    mkField(1, citCode("C1", "张三", 2020), 10, "[1]"),
    mkField(2, citCode("C2", "李四", 2021), 50, "[2]"),
    mkField(3, citCode("C3", "王五", 2022), 90, "[3]"),
  ], 0);

  check("输入序号 → 跳到对应引文", () => {
    let shown = "";
    const saved = sandbox.prompt;
    try {
      sandbox.prompt = (text) => { shown = String(text); return " 2 "; };
      const r = Nav.list();
      eq(r.ok, true, "ok");
      eq(r.n, 2, "n");
      eq(r.label, "[2]", "label");
      eq(state.selects.join(","), "2", "选中的域");
      ok(shown.indexOf("共 3 条引文") === 0, "标题行不对：" + shown.split("\n")[0]);
    } finally {
      sandbox.prompt = saved;
    }
  });

  check("列表文本：每条一行「序号. label 作者 年份」+ 末尾提示", () => {
    let shown = "";
    const saved = sandbox.prompt;
    try {
      sandbox.prompt = (text) => { shown = String(text); return null; };
      Nav.list();
      const lines = shown.split("\n");
      ok(lines.indexOf("2. [2] 李四 2021") >= 0, "第 2 行不对：" + JSON.stringify(lines));
      ok(lines[lines.length - 1].indexOf("输入序号跳转") >= 0, "缺少末尾提示");
    } finally {
      sandbox.prompt = saved;
    }
  });

  check("空输入 / 取消 / 越界 / 非数字 → cancelled:true 且不跳", () => {
    const saved = sandbox.prompt;
    const cases = [null, "", "   ", "0", "4", "-1", "abc", "1.5"];
    try {
      for (const v of cases) {
        state.selects = [];
        sandbox.prompt = () => v;
        const r = Nav.list();
        eq(r.ok, false, "输入 " + JSON.stringify(v) + " 的 ok");
        eq(r.cancelled, true, "输入 " + JSON.stringify(v) + " 应标记 cancelled");
        eq(state.selects.length, 0, "输入 " + JSON.stringify(v) + " 不该跳转");
      }
    } finally {
      sandbox.prompt = saved;
    }
  });
}

/* ---------------- 汇总 ---------------- */
console.log("");
console.log("通过 " + pass + " 项，失败 " + fails.length + " 项");
if (fails.length) {
  for (const f of fails) console.log("  × " + f);
  process.exit(1);
}
console.log("OK");
