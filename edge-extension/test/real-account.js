// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 真实账号验证（不落盘、不回显密码）：
 * - 在真实 Edge 中加载 Papilot 阅读扩展
 * - 用 Papilot 账号登录（邮箱/密码从环境变量读取）
 * - 在真实 arXiv 页面上读页、划词、发起一次最小 AI 请求
 * - 打印账号套餐与回答摘要，最后退出登录并删除临时 profile
 *
 * 运行：PP_EMAIL=... PP_PASSWORD=... NODE_PATH=<pw> node test/real-account.js
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EMAIL = process.env.PP_EMAIL || "";
const PASSWORD = process.env.PP_PASSWORD || "";
if (!EMAIL || !PASSWORD) {
  console.error("缺少 PP_EMAIL / PP_PASSWORD");
  process.exit(2);
}

let chromium;
try {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  ({ chromium } = require("playwright-core"));
} catch (e) {
  console.error("未找到 playwright-core，请设置 NODE_PATH");
  process.exit(2);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "papilot-real-"));
const mask = (s) => String(s || "").replace(/^(.{3}).*(@.*)$/, "$1***$2");

const context = await chromium.launchPersistentContext(path.join(TMP, "profile"), {
  channel: "msedge",
  headless: true,
  args: [
    "--disable-extensions-except=" + ROOT,
    "--load-extension=" + ROOT,
    "--no-first-run",
  ],
});

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log((ok ? "  ✓ " : "  ✗ ") + name + (ok || !detail ? "" : "  → " + detail));
}

try {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 });
  const id = new URL(sw.url()).host;
  check("扩展加载", !!id);

  const options = await context.newPage();
  await options.goto("chrome-extension://" + id + "/src/options/options.html");
  await options.waitForSelector('input[name="provider"][value="papilot"]');

  await options.check('input[name="provider"][value="papilot"]');
  await options.waitForSelector("#email", { state: "visible" });
  await options.fill("#email", EMAIL);
  await options.fill("#password", PASSWORD);
  await options.click("#btn-login");

  await options.waitForFunction(() => {
    const el = document.getElementById("login-msg");
    return el && (el.textContent.includes("登录成功") || el.classList.contains("err"));
  }, null, { timeout: 30000 });

  const loginMsg = await options.textContent("#login-msg");
  check("Papilot 账号登录", loginMsg.includes("登录成功"), loginMsg);

  const auth = await options.evaluate(async () => await chrome.runtime.sendMessage({ type: "pp.authCheck" }));
  check("会话有效", !!(auth && auth.ok), JSON.stringify(auth && auth.reason));
  if (auth && auth.ok && auth.user) {
    console.log("    账号：" + mask(auth.user.email) + " · 套餐：" + (auth.user.plan || "unknown"));
  }

  const settings = (await options.evaluate(async () => (await chrome.storage.local.get("settings")).settings)) || {};
  check("令牌只存本地且非空", !!settings.papilotToken, "");
  check("配置中不含密码", !JSON.stringify(settings).includes(PASSWORD), "");

  const paper = await context.newPage();
  const nav = await paper.goto("https://arxiv.org/abs/1706.03762", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => null);
  check("打开真实 arXiv 页面", !!(nav && nav.ok()), nav ? String(nav.status()) : "navigation failed");

  const panel = await context.newPage();
  panel.on("pageerror", (e) => console.log("    [panel error] " + e.message));
  await panel.goto("chrome-extension://" + id + "/src/sidepanel/panel.html");
  await panel.waitForSelector("#btn-read");

  await panel.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((x) => x.url && x.url.startsWith(url));
    if (!t) throw new Error("找不到 arXiv 标签页");
    await chrome.tabs.update(t.id, { active: true });
    document.getElementById("btn-read").click();
  }, "https://arxiv.org/abs/1706.03762");

  await panel.waitForFunction(() => /已读取/.test(document.getElementById("ctx-meta").textContent), null, { timeout: 20000 });
  const meta = await panel.textContent("#ctx-meta");
  check("读取真实页面正文", /已读取/.test(meta), meta);

  await paper.evaluate(() => {
    const root = document.querySelector("blockquote.abstract") || document.querySelector("article") || document.body;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = null;
    let target = null;
    while ((node = walker.nextNode())) {
      if (node.textContent && node.textContent.trim().length > 80) { target = node; break; }
    }
    if (!target) return;
    const range = document.createRange();
    range.setStart(target, 0);
    range.setEnd(target, Math.min(260, target.textContent.length));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });

  await panel.waitForFunction(() => {
    const card = document.getElementById("selection-card");
    return !card.classList.contains("hidden") && Number(document.getElementById("sel-count").textContent) > 40;
  }, null, { timeout: 10000 });
  check("划词同步", true, await panel.textContent("#sel-count"));

  await panel.evaluate(() => document.querySelector('.chip[data-action="explain"]').click());

  await panel.waitForFunction(() => {
    const body = document.querySelector(".msg.assistant .msg-body");
    if (!body) return false;
    const err = body.closest(".msg.error");
    if (err) return true;
    return body.textContent.trim().length > 30;
  }, null, { timeout: 120000 });

  const answer = await panel.evaluate(() => {
    const body = document.querySelector(".msg.assistant .msg-body");
    return {
      text: body ? body.textContent.trim() : "",
      error: !!(body && body.closest(".msg.error")),
    };
  });

  check("真实 AI 返回内容", !answer.error && answer.text.length > 30, answer.text.slice(0, 60));
  if (!answer.error && answer.text) {
    console.log("    回答摘要：" + answer.text.replace(/\s+/g, " ").slice(0, 120) + "…");
  }

  try {
    await panel.setViewportSize({ width: 420, height: 900 });
    fs.mkdirSync(path.join(ROOT, "dist"), { recursive: true });
    await panel.screenshot({ path: path.join(ROOT, "dist", "real-account-verify.png") });
    check("验证截图已生成", true);
  } catch (e) {
    check("验证截图已生成", false, String(e.message));
  }

  await options.evaluate(async () => await chrome.runtime.sendMessage({ type: "pp.logout" }));
  const after = (await options.evaluate(async () => (await chrome.storage.local.get("settings")).settings)) || {};
  check("退出登录清除令牌", !after.papilotToken, "");
} catch (err) {
  check("验证流程未抛错", false, err && err.stack ? err.stack.split("\n").slice(0, 3).join(" | ") : String(err));
} finally {
  await context.close().catch(() => {});
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

const failed = results.filter((r) => !r.ok).length;
console.log("\n" + (results.length - failed) + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
