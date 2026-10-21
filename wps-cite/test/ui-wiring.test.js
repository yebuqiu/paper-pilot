// 功能区的按钮必须"三处对齐"，漏一处就是点了没反应的哑按钮：
//   ribbon.xml 里的 <button id>  ←→  app.js 的 OnAction 分发表  ←→  GetImage 图标
// 这三样都是手写的、分属不同段落，最容易在加按钮时漏掉一个。
// 本测试纯静态（读源码做比对），不需要 WPS，也不会发网络请求。
const fs = require("fs");
const path = require("path");

const ADDON = path.resolve(__dirname, "..", "addon");
const ribbon = fs.readFileSync(path.join(ADDON, "ribbon.xml"), "utf8");
const appJs = fs.readFileSync(path.join(ADDON, "js", "app.js"), "utf8");

let failed = 0;
let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log("  PASS " + name);
  } catch (e) {
    failed += 1;
    console.log("  FAIL " + name + " -> " + ((e && e.message) || e));
  }
}

const ribbonIds = [...ribbon.matchAll(/<button\s+id="([^"]+)"/g)].map((m) => m[1]);

// 分发表：OnAction 里那一串 `btnXxx: () => ...`（缩进 6 个空格，避免误抓别处的对象字面量）
const dispatchIds = [...appJs.matchAll(/^ {6}(btn[A-Za-z0-9]+):\s*\(\)/gm)].map((m) => m[1]);

// 图标表：GetImage 里的 `btnXxx: "img/xxx.svg"`
// 注意别加行首锚点 —— 那张表里一行写了多个条目（btnCite / btnRefresh / btnBib 在同一行）
const iconPairs = [...appJs.matchAll(/(btn[A-Za-z0-9]+):\s*"(img\/[^"]+)"/g)];
const iconIds = iconPairs.map((m) => m[1]);
const iconFiles = iconPairs.map((m) => m[2]);

check("ribbon.xml 能被解析出按钮", () => {
  if (!ribbonIds.length) throw new Error("没解析到任何 <button id>");
});

check("每个功能区按钮都在 OnAction 分发表里（否则点了没反应）", () => {
  const miss = ribbonIds.filter((id) => dispatchIds.indexOf(id) < 0);
  if (miss.length) throw new Error("缺分发：" + miss.join(", "));
});

check("每个功能区按钮都有图标映射", () => {
  const miss = ribbonIds.filter((id) => iconIds.indexOf(id) < 0);
  if (miss.length) throw new Error("缺图标：" + miss.join(", "));
});

check("图标文件真实存在（路径写错功能区就是空白）", () => {
  const uniq = [...new Set(iconFiles)];
  const miss = uniq.filter((p) => !fs.existsSync(path.join(ADDON, p)));
  if (miss.length) throw new Error("文件不存在：" + miss.join(", "));
});

check("分发表里没有多余按钮（改名后留下的死条目）", () => {
  const extra = dispatchIds.filter((id) => ribbonIds.indexOf(id) < 0);
  if (extra.length) throw new Error("多余分发：" + extra.join(", "));
});

check("index.html 加载了工具箱模块（nav / diag）", () => {
  const html = fs.readFileSync(path.join(ADDON, "index.html"), "utf8");
  for (const f of ["js/nav.js", "js/diag.js"]) {
    if (html.indexOf(f) < 0) throw new Error("index.html 没加载 " + f);
  }
  // 顺序：这两个模块只依赖 PPDoc，必须排在 doc.js 之后、integration.js 之前或同时，
  // 但不能排在 doc.js 之前（app.js 里是懒调用，但加载顺序错会在启动时炸）
  const iDoc = html.indexOf("js/doc.js");
  const iNav = html.indexOf("js/nav.js");
  const iDiag = html.indexOf("js/diag.js");
  if (!(iDoc >= 0 && iDoc < iNav && iDoc < iDiag)) {
    throw new Error("nav.js / diag.js 必须排在 doc.js 之后");
  }
});

check("工具箱模块文件存在", () => {
  for (const f of ["js/nav.js", "js/diag.js"]) {
    const p = path.join(ADDON, f);
    if (!fs.existsSync(p)) throw new Error("缺文件 " + f);
    if (!fs.readFileSync(p, "utf8").trim()) throw new Error(f + " 是空文件");
  }
});

console.log("");
console.log("通过 " + passed + " 项，失败 " + failed + " 项" + (failed ? "" : "，全部通过"));
process.exit(failed ? 1 : 0);
