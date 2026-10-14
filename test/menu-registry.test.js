/* 菜单注册表测试（0.29.0 菜单瘦身）：
 * 覆盖「重组不减功能」的静态口径——
 *   ① 注册表恰好 40 条（0.28 的 40 个右键命令一条不少、一条不多）；
 *   ② id 唯一、group 合法（null / state / GROUPS 已定义）；
 *   ③ 全部 labelKey 在 i18n 表中真实存在（I18n.t 缺 key 会原样返回 key）；
 *   ④ 默认直达项合法且被解析；非法/超量直达项被过滤；
 *   ⑤ classic 回退代码在（menuMode=classic 不是空话）。
 * 运行方式：node test/menu-registry.test.js（无网络、无 DOM）。 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const ROOT = path.join(__dirname, "..");

function deepProxy(name) {
  const fn = function () { return deepProxy(name + "()"); };
  return new Proxy(fn, {
    get(t, k) {
      if (k === Symbol.toPrimitive) return () => "";
      if (k === "toString") return () => name;
      if (k === "then") return undefined;
      return deepProxy(name + "." + String(k));
    },
    apply() { return deepProxy(name + "()"); },
    construct() { return deepProxy("new " + name); },
  });
}

// ⚠️ utils.js 自带 var Prefs（覆盖沙箱全局），其 get/set 实际走
// Zotero.Prefs.get(完整key, true)——所以真桩必须挂在 Zotero.Prefs 上、
// 按完整 key 存取、缺 key 返回 undefined（第二个参数是 global 标记不是默认值）。
const PrefStore = new Map();
const prefsStub = {
  get(k) { return PrefStore.has(k) ? PrefStore.get(k) : undefined; },
  set(k, v) { PrefStore.set(k, v); },
};
const ZoteroStub = new Proxy(deepProxy("Zotero"), {
  get(t, k) {
    if (k === "Prefs") return prefsStub;
    if (k === "locale") return "zh-CN";
    return deepProxy("Zotero." + String(k));
  },
});
const setPref = (k, v) => PrefStore.set("extensions.zotero.paperpilot." + k, v);

const sandbox = {
  console,
  Zotero: ZoteroStub,
  Services: deepProxy("Services"),
  setTimeout, clearTimeout, Promise, Date, Math, JSON,
};
vm.createContext(sandbox);

for (const f of ["core/utils.js", "menus.js"]) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, "chrome/content/scripts", f), "utf8"),
    sandbox, { filename: f });
}

const Menus = sandbox.Menus;
const I18n = sandbox.I18n;
let failed = 0;
const ok = (cond, name) => {
  console.log((cond ? "  ✓ " : "  ✗ ") + name);
  if (!cond) failed++;
};

// ① 注册表规模：0.28 的 40 个右键命令一条不减（0.31.0 +ai-chat → 41；0.36.0 撤 pdf-inline → 41）
const reg = Menus.ITEM_REGISTRY;
ok(reg.length === 41, "注册表恰好 41 条（实测 " + reg.length + "）");

// ② id 唯一 + group 合法
const ids = reg.map((i) => i.id);
ok(new Set(ids).size === ids.length, "命令 id 唯一");
const groupIds = new Set(Menus.GROUPS.map((g) => g.id));
ok(reg.every((i) => i.group === null || groupIds.has(i.group)), "每条命令的 group 合法（null 或已定义分组）");

// 分组覆盖：8 组每组都有成员（state=3）
for (const g of Menus.GROUPS) {
  const n = reg.filter((i) => i.group === g.id).length;
  ok(n > 0, "分组 " + g.id + " 有成员（" + n + " 条）");
}

// ③ labelKey 全部存在于 i18n 表
const missingLabels = [
  ...reg.map((i) => i.labelKey),
  ...Menus.GROUPS.map((g) => g.labelKey),
  "menuReadingState",
].filter((k) => I18n.t(k) === k);
ok(!missingLabels.length, "全部 labelKey 在 i18n 表中（缺失：" + (missingLabels.join(",") || "无") + "）");

// ④ 默认直达项：合法、可解析
const defQuick = Menus._quickItems();
ok(defQuick.length === 2 && defQuick[0].id === "ai-summary" && defQuick[1].id === "bilingual-view",
  "默认直达项 = AI 摘要 + 双语对照（实测 " + defQuick.map((q) => q.id).join(",") + "）");

// 非法/超量/重复直达项被过滤
setPref("menuQuickItems", "ai-summary,no-such-id,bilingual-view,ai-translate,bilingual");
const messy = Menus._quickItems();
ok(messy.length === 3 && messy.map((q) => q.id).join(",") === "ai-summary,bilingual-view,ai-translate",
  "非法 id 剔除、超量截断为 3（实测 " + messy.map((q) => q.id).join(",") + "）");

// state 组与顶层直达项不可作直达
setPref("menuQuickItems", "state-unread,hub,pdf-compare,ai-summary");
const noState = Menus._quickItems();
ok(noState.length === 1 && noState[0].id === "ai-summary",
  "state 组与顶层直达项不可作直达（实测 " + noState.map((q) => q.id).join(",") + "）");

// ⑤ classic 回退：0.28 平铺结构的构建代码必须在
const menusSrc = fs.readFileSync(path.join(ROOT, "chrome/content/scripts/menus.js"), "utf8");
ok("_buildClassicItemMenu" in Menus && "_buildClassicTools" in Menus, "classic 回退构建器存在");
ok(menusSrc.includes('"classic"'), "menuMode=classic 分支存在");
// 0.36.0：主入口改为「左原右译」对照窗口；旧「文本双栏」出口仍在模块里（备用）
ok(menusSrc.includes("PdfDual.openForSelected"), "注册表主入口指向左原右译对照窗口（0.36.0）");
ok(!menusSrc.includes("startForSelected"), "页内叠加入口已从菜单撤掉（0.36.0）");
ok(menusSrc.includes("BilingualTranslate.runForSelected()"), "注册表保留 AI 双语笔记出口");

// pref 观察者：三个菜单 pref 键名正确
ok(menusSrc.includes('"menuMode", "menuHiddenGroups", "menuQuickItems"'), "三个菜单 pref 均被观察（即时重建）");

console.log(failed ? "菜单注册表测试：" + failed + " 项失败" : "菜单注册表测试：全部通过 ✓");
process.exit(failed ? 1 : 0);
