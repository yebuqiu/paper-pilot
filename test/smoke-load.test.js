/* 全模块加载冒烟测试：按 main.js 的顺序在共享作用域里加载全部子模块，
 * 用深 Proxy 顶替 Zotero/Services，只验证「加载期不抛异常 + 关键全局已定义」。
 * 目的是抓出跨模块的加载期回归（本次改动动过 utils.js / menus.js / hub.js）。 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const ROOT = process.argv[2] || path.join(__dirname, "..");

function deepProxy(name) {
  const fn = function () { return deepProxy(name + "()"); };
  return new Proxy(fn, {
    get(t, k) {
      if (k === Symbol.toPrimitive) return () => "";
      if (k === "toString") return () => name;
      if (k === "then") return undefined; // 不伪装成 thenable
      return deepProxy(name + "." + String(k));
    },
    apply() { return deepProxy(name + "()"); },
    construct() { return deepProxy("new " + name); },
  });
}

const PrefStore = new Map();
const sandbox = {
  console,
  Zotero: deepProxy("Zotero"),
  Services: deepProxy("Services"),
  IOUtils: deepProxy("IOUtils"),
  PathUtils: deepProxy("PathUtils"),
  Prefs: {
    PREFIX: "extensions.zotero.paperpilot.",
    get(k, d) { return PrefStore.has(k) ? PrefStore.get(k) : d; },
    set(k, v) { PrefStore.set(k, v); },
  },
  setTimeout, clearTimeout, setInterval, clearInterval, Promise, Date, Math, JSON,
};
sandbox.Zotero.locale = "zh-CN";            // utils.js 加载期会读
sandbox.Zotero.Prefs = sandbox.Prefs;

vm.createContext(sandbox);
const main = fs.readFileSync(path.join(ROOT, "chrome/content/scripts/main.js"), "utf8");
const files = main.match(/"((?:core|ai|features|columns|panels|arxiv)\/[^"]+\.js)"/g).map((s) => s.replace(/"/g, ""));

files.push("menus.js");
let failed = 0;
for (const f of files) {
  const p = path.join(ROOT, "chrome/content/scripts", f);
  try {
    vm.runInContext(fs.readFileSync(p, "utf8"), sandbox, { filename: f });
  } catch (e) {
    failed++;
    console.log("  ✗ 加载失败 " + f + " → " + e.message);
  }
}
console.log("加载模块 " + files.length + " 个，失败 " + failed + " 个");

const expect = ["Prefs", "I18n", "MdLite", "Notes", "ItemSel", "TagCurator", "AttachDoctor", "LibSearch",
  "SmartCleanup", "RuleTag", "Automation", "AutoRead", "TagCurator", "LibSearch", "NoteGraph", "ReadingStats", "AttachDoctor", "AIChat", "AIClient", "Menus", "ReadingState", "UiTheme", "PdfCompare", "MetaRules", "Discovery", "MCP", "SciHub", "OAFetch",
  "ArxivErrors", "ArxivDates", "ArxivQuery", "ArxivCategories", "ArxivAtom", "ArxivAnalyze", "ArxivRateLimiter", "ArxivFetch"];
const missing = expect.filter((k) => !sandbox[k]);
console.log("关键全局缺失:", missing.length ? missing : "无 ✓");

// 关键纯函数可用性（加载后仍可调用）
const r = sandbox.TagCurator.analyze([{ name: "DNN", count: 2 }, { name: "dnn", count: 1 }]);
console.log("TagCurator.analyze 可用:", r.groups.length === 1 ? "✓" : "✗");
const t = sandbox.LibSearch.tokenize("机器学习 survey");
console.log("LibSearch.tokenize 可用:", t.includes("学习") && t.includes("survey") ? "✓" : "✗");
const mh = sandbox.MetaRules.journalHint("Nat Med", sandbox.MetaRules.journalIndex(""), "expand");
console.log("MetaRules.journalHint 可用:", mh && mh.to === "Nature Medicine" ? "✓" : "✗ " + JSON.stringify(mh));
// 0.25.0 起解析不再由 Discovery 自带，改为生成出来的 ArxivAtom（单一真源 tools/arxiv/src）
const atom = sandbox.ArxivAtom.parseAtom('<entry><id>http://arxiv.org/abs/2401.00001v1</id><title>T</title><summary>S</summary><author><name>A B</name></author></entry>');
console.log("ArxivAtom.parseAtom 可用:", atom.entries.length === 1 && atom.entries[0].arxivId === "2401.00001" ? "✓" : "✗");
// 生成物自检：在共享作用域里跑一遍（实机 boot 日志用的是同一个函数）
const selfTest = sandbox.ArxivFetch.selfTest();
console.log("ArxivFetch.selfTest:", selfTest.indexOf("ok ") === 0 ? "✓ " + selfTest : "✗ " + selfTest);
console.log("MCP 工具数:", sandbox.MCP.TOOLS.length === 8 ? "✓ 8" : "✗ " + sandbox.MCP.TOOLS.length);
console.log("I18n 新条目:", sandbox.I18n.t("menuLibAsk"), "|", sandbox.I18n.t("menuDiscovery"), "|", sandbox.I18n.t("menuMetaRules"), "|", sandbox.I18n.t("menuMcp"));
process.exit(failed || missing.length ? 1 : 0);
