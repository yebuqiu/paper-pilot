#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 更新提示 测试（插件 0.37.1）
 *
 * 背景：Zotero 对第三方插件的更新是**静默后台替换**（不弹提示），用户完全感知不到
 * 「已经有新版本了」。本模块补一次可见反馈，而它的成败全在三个分支上：
 *   ① **有新版才提示** —— 本机已是最新时弹窗 = 纯骚扰；
 *   ② **同一版本只提示一次** —— 否则每次启动都弹，用户会想卸载插件；
 *   ③ **网络/JSON 异常必须静默** —— 断网时弹错误窗比不提示更糟。
 * 这三条都在这里逐条钉死（外加版本比较的边界与 UPDATE_URL 与 manifest 的一致性）。
 *
 * 运行：node test/update-notice.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'chrome', 'content', 'scripts', 'features', 'update-notice.js');

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

/* ==================== 桩 ==================== */

const PrefStore = new Map();
const PFX = "extensions.zotero.papilot.";   // 真实 Prefs 包装会自动加前缀（utils.js）
const Prefs = {
  get(k, d) { const key = PFX + k; return PrefStore.has(key) ? PrefStore.get(key) : d; },
  set(k, v) { PrefStore.set(PFX + k, v); },
};

let httpReply = null;      // {ok: json} | {err: message}
const httpCalls = [];
const notices = [];

function mkSandbox() {
  const Zotero = {
    debug() {},
    logError() {},
    HTTP: {
      async request(method, url, opts) {
        httpCalls.push({ method, url, opts });
        if (httpReply && httpReply.err) throw new Error(httpReply.err);
        return { response: httpReply ? httpReply.ok : null, status: 200 };
      },
    },
    ProgressWindow: class {
      constructor() { this.lines = []; notices.push(this); }
      changeHeadline(h) { this.headline = h; }
      addDescription(t) { this.lines.push(String(t)); }
      show() { this.shown = true; }
      startCloseTimer() { this.timer = true; }
    },
  };
  const sandbox = {
    console, Zotero, Prefs,
    I18n: { isZh: true, t: (k) => k },
    setTimeout, clearTimeout, Promise, Date, Math, JSON, parseInt, isFinite, String,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: 'update-notice.js' });
  return sandbox;
}

const LIST = (versions) => ({
  addons: {
    "papilot@dev.local": {
      updates: versions.map((v) => ({ version: v, update_link: "https://example.invalid/" + v + ".xpi" })),
    },
  },
});

function reset() {
  PrefStore.clear();
  httpCalls.length = 0;
  notices.length = 0;
  httpReply = null;
}

async function main() {
  const sb = mkSandbox();
  const UN = sb.UpdateNotice;

  /* ---- 1. 版本比较（纯函数） ---- */
  eq(UN.compareVersion("0.37.1", "0.37.0"), 1, "1.1 0.37.1 > 0.37.0");
  eq(UN.compareVersion("0.37.0", "0.37.0"), 0, "1.2 同版本相等");
  eq(UN.compareVersion("0.9.9", "0.10.0"), -1, "1.3 数字段比较（9 < 10，不是字符串比较）");
  eq(UN.compareVersion("v0.37.0", "0.37.0"), 0, "1.4 容忍前缀 v");
  eq(UN.compareVersion("0.38.0", "0.37.9"), 1, "1.5 次版本优先");
  eq(UN.compareVersion("1.0.0", "1.0"), 0, "1.6 缺段按 0 处理");
  eq(UN.compareVersion("1.0.0-beta", "1.0.0"), 0, "1.7 非数字后缀被忽略（不误判为更高）");

  /* ---- 2. 清单取最新（纯函数） ---- */
  eq(UN.latestVersion(LIST(["0.36.0", "0.37.1", "0.35.0"])), "0.37.1", "2.1 取清单里最高版本（顺序无关）");
  eq(UN.latestVersion(LIST([])), "", "2.2 空清单 → 空串");
  eq(UN.latestVersion({}), "", "2.3 结构不对 → 空串（不抛）");
  eq(UN.latestVersion(null), "", "2.4 null → 空串（不抛）");

  /* ---- 3. 有新版 → 提示一次并记录 ---- */
  reset();
  httpReply = { ok: LIST(["0.36.0", "0.37.1"]) };
  let r = await UN.check("0.37.0");
  eq(r.checked, true, "3.1 请求成功即视为已检查");
  eq(r.latest, "0.37.1", "3.2 解析出最新版本");
  eq(r.newer, true, "3.3 判定「有更新」");
  eq(r.notified, true, "3.4 弹提示");
  eq(notices.length, 1, "3.5 只弹一个提示窗");
  ok(notices[0].headline === "Papilot", "3.6 提示窗标题为插件名");
  ok(notices[0].shown === true, "3.7 提示窗已显示");
  ok(notices[0].lines.some((l) => l.indexOf("0.37.1") >= 0), "3.8 文案含新版本号");
  ok(notices[0].lines.some((l) => l.indexOf("重启") >= 0), "3.9 文案说明「重启生效」");
  eq(PrefStore.get("extensions.zotero.papilot.updateNoticeLastVersion"), "0.37.1",
    "3.10 记录已提示版本");

  /* ---- 4. 同一版本第二次检查 → 不再提示（不骚扰） ---- */
  reset();
  Prefs.set("updateNoticeLastVersion", "0.37.1");
  httpReply = { ok: LIST(["0.37.1"]) };
  r = await UN.check("0.37.0");
  eq(r.notified, false, "4.1 ★ 同一版本不重复提示");
  eq(r.skipped, "already-notified", "4.2 跳过原因是「已提示过」");
  eq(notices.length, 0, "4.3 没有新弹窗");

  /* ---- 5. 已是最新 → 静默 ---- */
  reset();
  httpReply = { ok: LIST(["0.36.0", "0.37.0"]) };
  r = await UN.check("0.37.0");
  eq(r.newer, false, "5.1 当前版本 = 清单最新 → 无更新");
  eq(r.skipped, "up-to-date", "5.2 跳过原因是「已是最新」");
  eq(notices.length, 0, "5.3 ★ 已是最新时不弹窗（不骚扰）");

  /* ---- 6. 网络失败 → 静默（绝不弹错误窗） ---- */
  reset();
  httpReply = { err: "NetworkError when attempting to fetch resource." };
  r = await UN.check("0.37.0");
  eq(r.checked, false, "6.1 请求失败 → checked=false");
  eq(r.notified, false, "6.2 不提示");
  eq(notices.length, 0, "6.3 ★ 断网不弹错误窗");
  ok(String(r.skipped).indexOf("network") === 0, "6.4 记录跳过原因供排障");

  /* ---- 7. JSON 结构异常 → 静默 ---- */
  reset();
  httpReply = { ok: { addons: {} } };
  r = await UN.check("0.37.0");
  eq(r.notified, false, "7.1 清单结构不对 → 不提示");
  eq(r.skipped, "empty-manifest", "7.2 跳过原因「清单为空」");

  /* ---- 8. pref 关掉 → 不请求、不提示 ---- */
  reset();
  Prefs.set("updateNoticeEnabled", false);
  httpReply = { ok: LIST(["9.9.9"]) };
  r = await UN.check("0.37.0");
  eq(r.skipped, "disabled", "8.1 关掉后直接跳过");
  eq(httpCalls.length, 0, "8.2 ★ 关掉后**不发网络请求**（不偷偷联网）");
  eq(notices.length, 0, "8.3 不提示");

  /* ---- 9. register 延迟触发 + unregister 清理 ---- */
  reset();
  Prefs.set("updateNoticeEnabled", true);
  httpReply = { ok: LIST(["0.37.1"]) };
  ok(UN.register("papilot@dev.local", "0.37.0") === true, "9.1 register 返回 true（已排程）");
  eq(httpCalls.length, 0, "9.2 register 不同步发请求（延迟 15s，不拖慢启动）");
  UN.unregister();
  eq(UN._timer, null, "9.3 unregister 清掉定时器");

  /* ---- 11. 0.44.1：whatsNew 摘要 + 「已更新到」提示（静默更新完成场景） ---- */
  const LIST2 = {
    addons: { "papilot@dev.local": { updates: [
      { version: "0.44.0", update_link: "https://example.invalid/a.xpi", whatsNew: "第一条说明\n第二条说明" },
      { version: "0.44.1", update_link: "https://example.invalid/b.xpi" },
    ] } },
  };
  eq(UN.whatsNewOf(LIST2, "0.44.0"), "第一条说明\n第二条说明", "11.1 whatsNewOf 取到摘要");
  eq(UN.whatsNewOf(LIST2, "0.44.1"), "", "11.2 无 whatsNew 字段 → 空串");
  eq(UN.whatsNewOf(LIST2, "9.9.9"), "", "11.3 版本不在清单 → 空串（不抛）");
  eq(UN.whatsNewOf(null, "0.44.0"), "", "11.4 null 清单 → 空串（不抛）");
  ok(!!UN.entryOf(LIST2, "v0.44.0"), "11.5 entryOf 容忍 v 前缀");
  eq(UN._whatsNewLines("a\n\nb\nc\nd\ne").length, 4, "11.5b 摘要最多 4 行");

  // 刚更新完（seen=0.44.0 → 装机运行 0.44.1）：弹「已更新到」+ 记录 lastSeen
  reset();
  Prefs.set("updateNoticeLastSeen", "0.44.0");
  httpReply = { ok: LIST2 };
  r = await UN.check("0.44.1");
  eq(r.updated, true, "11.6 ★ 静默更新完成 → updated=true");
  eq(notices.length, 1, "11.7 弹出一个提示窗");
  ok(notices[0].lines.some((l) => l.indexOf("已更新到") >= 0 && l.indexOf("0.44.1") >= 0),
    "11.8 文案含「已更新到 v0.44.1」");
  ok(notices[0].lines.some((l) => l.indexOf("暂无详细说明") >= 0),
    "11.9 条目无 whatsNew → 显示「暂无详细说明」兜底");
  eq(PrefStore.get(PFX + "updateNoticeLastSeen"), "0.44.1", "11.10 lastSeen 已更新为当前版本");

  // 升级且有 whatsNew：提示里带「本次更新内容」+ 摘要行
  reset();
  Prefs.set("updateNoticeLastSeen", "0.44.1");
  httpReply = { ok: { addons: { "papilot@dev.local": { updates: [
    { version: "0.44.2", update_link: "z", whatsNew: "升级说明X\n修复Y" },
  ] } } } };
  r = await UN.check("0.44.2");
  eq(r.updated, true, "11.10b 升级到带摘要版本 → updated=true");
  ok(notices[0].lines.some((l) => l.indexOf("本次更新内容") >= 0), "11.10c 含「本次更新内容」行");
  ok(notices[0].lines.some((l) => l.indexOf("升级说明X") >= 0), "11.10d 含摘要正文行");

  // 同版本再启动：seen==current → 不再弹「已更新到」
  reset();
  Prefs.set("updateNoticeLastSeen", "0.44.1");
  httpReply = { ok: LIST2 };
  r = await UN.check("0.44.1");
  eq(r.updated, false, "11.11 ★ 同版本不再重复「已更新到」");
  eq(notices.length, 0, "11.12 无提示");

  // 首次运行（无历史记录）：静默记录，不弹
  reset();
  httpReply = { ok: LIST2 };
  r = await UN.check("0.44.1");
  eq(r.updated, false, "11.13 ★ 首次运行（无历史）→ 静默");
  eq(notices.length, 0, "11.14 不弹窗");
  eq(PrefStore.get(PFX + "updateNoticeLastSeen"), "0.44.1", "11.14b 静默记录 lastSeen");

  // 有新版且清单带 whatsNew：发现新版本提示里带摘要
  reset();
  httpReply = { ok: { addons: { "papilot@dev.local": { updates: [
    { version: "0.44.1", update_link: "x" },
    { version: "0.44.2", update_link: "y", whatsNew: "新功能A\n修复B" },
  ] } } } };
  r = await UN.check("0.44.1");
  eq(r.notified, true, "11.15 有新版且未提示过 → 提示");
  ok(notices[0].lines.some((l) => l.indexOf("新功能A") >= 0), "11.16 ★ 新版本提示带 whatsNew 摘要");

  /* ---- 10. UPDATE_URL 必须与 manifest 一致（防止两处漂移） ---- */
  const mf = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const u = mf.applications && mf.applications.zotero && mf.applications.zotero.update_url;
  eq(UN.UPDATE_URL, u, "10.1 ★ 模块里的 UPDATE_URL 与 manifest 的 update_url 完全一致");
  ok(UN.ADDON_ID === mf.applications.zotero.id, "10.2 ADDON_ID 与 manifest 一致");

  /* ---------------- 输出 ---------------- */
  console.log("=".repeat(60));
  if (fails.length) {
    for (const f of fails) console.log("  ✗ " + f);
    console.log("-".repeat(60));
  }
  console.log("更新提示：" + pass + " 通过 / " + fails.length + " 失败");
  console.log("=".repeat(60));
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => {
  console.log("✗ 测试自身异常：" + (e && e.stack || e));
  process.exit(1);
});
