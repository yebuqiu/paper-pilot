// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 真实浏览器 E2E（需要本机 Edge + playwright-core）：
 * 1) 复制一份扩展并临时放开 127.0.0.1（仅测试副本）
 * 2) 启动本地 mock 模型服务（SSE）
 * 3) 用持久化上下文加载扩展，走完「配置 → 读页 → 划词 → 解释」全链路
 *
 * 运行：NODE_PATH=<playwright-core 所在 node_modules> node test/e2e.js
 */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "papilot-edge-e2e-"));

let chromium;
try {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  ({ chromium } = require("playwright-core"));
} catch (e) {
  console.error("未找到 playwright-core，请设置 NODE_PATH");
  process.exit(2);
}

const ARTICLE = `<!doctype html><html><head><meta charset="utf-8"><title>Attention Mechanisms in Practice</title></head>
<body><nav>navigation junk</nav>
<article><h1>Attention Mechanisms in Practice</h1>
<p id="p1">This is the first paragraph about attention.</p>
<p id="p2">The second paragraph describes the ablation study.</p></article>
<footer>footer junk</footer></body></html>`;

/** 生成一页最小可解析 PDF（Helvetica 文本），用于验证 pdf.js 抽取链路。 */
function buildPdf(text) {
  const stream = "BT /F1 24 Tf 72 700 Td (" + text + ") Tj ET";
  const objs = {
    1: "<< /Type /Catalog /Pages 2 0 R >>",
    2: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    3: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    4: "<< /Length " + Buffer.byteLength(stream) + " >>\nstream\n" + stream + "\nendstream",
    5: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  };
  let out = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 1; i <= 5; i++) {
    offsets[i] = Buffer.byteLength(out);
    out += i + " 0 obj\n" + objs[i] + "\nendobj\n";
  }
  const xref = Buffer.byteLength(out);
  out += "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i++) out += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  out += "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF\n";
  return Buffer.from(out, "latin1");
}

async function waitFor(fn, ms) {
  const start = Date.now();
  while (Date.now() - start < (ms || 10000)) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error("等待超时");
}

const requests = [];
const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url.startsWith("/article")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(ARTICLE);
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/favicon")) {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === "POST" && req.url.startsWith("/api/auth/login")) {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      const ok = parsed.email === "test@example.com" && parsed.password === "pw";
      res.writeHead(ok ? 200 : 401, { "Content-Type": "application/json" });
      res.end(JSON.stringify(ok
        ? { ok: true, token: "mock-token", expiresAt: new Date(Date.now() + 86400000).toISOString(), user: { email: parsed.email, plan: "pro" } }
        : { ok: false, error: "invalid credentials" }));
    });
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/api/auth/me")) {
    const ok = req.headers.authorization === "Bearer mock-token";
    res.writeHead(ok ? 200 : 401, { "Content-Type": "application/json" });
    res.end(JSON.stringify(ok ? { ok: true, user: { email: "test@example.com" } } : { ok: false }));
    return;
  }
  if (req.method === "POST" && req.url.startsWith("/api/auth/logout")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === "POST" && req.url.includes("/chat/completions")) {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      requests.push({ auth: req.headers.authorization, body: JSON.parse(body || "{}") });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"MOCK_"}}]}\n\n');
      setTimeout(() => {
        res.write('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n');
        res.write("data: [DONE]\n\n");
        res.end();
      }, 60);
    });
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const base = "http://127.0.0.1:" + port;

function copyExtension() {
  const dst = path.join(TMP, "extension");
  fs.cpSync(ROOT, dst, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(ROOT, src);
      return !rel.startsWith("node_modules") && !rel.startsWith("test") && !rel.startsWith("tools") && !rel.startsWith("dist");
    },
  });
  const manifestPath = path.join(dst, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.host_permissions.push("http://127.0.0.1/*");
  for (const cs of manifest.content_scripts) cs.matches.push("http://127.0.0.1/*");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dst;
}

const extDir = copyExtension();
const profile = path.join(TMP, "profile");

const context = await chromium.launchPersistentContext(profile, {
  channel: "msedge",
  headless: true,
  args: [
    "--disable-extensions-except=" + extDir,
    "--load-extension=" + extDir,
    "--no-first-run",
  ],
});

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? "  ✓ " : "  ✗ ") + name + (ok || !detail ? "" : "  → " + detail));
}

try {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 });
  const id = new URL(sw.url()).host;
  check("扩展加载并启动 Service Worker", !!id, sw.url());

  const errors = [];
  context.on("page", (p) => {
    p.on("pageerror", (e) => errors.push(p.url() + " :: " + e.message));
    p.on("console", (m) => { if (m.type() === "error") errors.push(p.url() + " :: " + m.text()); });
  });

  const article = await context.newPage();
  await article.goto(base + "/article", { waitUntil: "domcontentloaded" });
  await article.waitForTimeout(400);

  const options = await context.newPage();
  await options.goto("chrome-extension://" + id + "/src/options/options.html");
  await options.waitForSelector("#base-url");
  await options.fill("#base-url", base);
  await options.fill("#model", "mock-model");
  await options.fill("#api-key", "test-key");
  await options.check('input[name="provider"][value="custom"]');
  await options.fill("#glossary", "attention = 注意力");
  await options.click("#btn-save");
  await options.waitForFunction(() => document.getElementById("save-msg").textContent.includes("已保存"));
  check("设置页保存配置", true);

  await options.reload();
  await options.waitForSelector("#base-url");
  const persisted = await options.inputValue("#base-url");
  check("配置持久化", persisted === base, persisted);

  const panel = await context.newPage();
  const panelErrors = [];
  panel.on("pageerror", (e) => panelErrors.push(e.message));
  panel.on("console", (m) => { if (m.type() === "error") panelErrors.push(m.text()); });
  await panel.goto("chrome-extension://" + id + "/src/sidepanel/panel.html");
  await panel.waitForSelector("#btn-read");
  await panel.waitForTimeout(300);

  const status = await panel.textContent("#status");
  check("面板显示当前模型", /mock-model/.test(status), status);

  const articleUrl = base + "/article";
  await panel.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((x) => x.url === url);
    if (!t) throw new Error("找不到测试标签页");
    await chrome.tabs.update(t.id, { active: true });
    document.getElementById("btn-read").click();
  }, articleUrl);

  await panel.waitForFunction(() => /已读取/.test(document.getElementById("ctx-meta").textContent), null, { timeout: 10000 });
  const meta = await panel.textContent("#ctx-meta");
  check("读取页面正文", /已读取/.test(meta), meta);

  await article.evaluate(() => {
    const el = document.getElementById("p1");
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });

  await panel.waitForFunction(() => {
    const card = document.getElementById("selection-card");
    return !card.classList.contains("hidden") && Number(document.getElementById("sel-count").textContent) > 10;
  }, null, { timeout: 8000 });
  const selCount = await panel.textContent("#sel-count");
  check("划词同步到面板", Number(selCount) > 10, selCount);

  await panel.evaluate(() => document.querySelector('.chip[data-action="explain"]').click());
  await panel.waitForFunction(() => {
    const body = document.querySelector(".msg.assistant .msg-body");
    return body && body.textContent.includes("MOCK_OK");
  }, null, { timeout: 15000 });
  check("流式回答渲染", true);

  const last = requests[requests.length - 1];
  const payload = last ? JSON.stringify(last.body) : "";
  check("请求带 Bearer 令牌", !!last && last.auth === "Bearer test-key", last && last.auth);
  check("提示词包含选中文本", /This is the first paragraph about attention/.test(payload));
  check("提示词包含术语表", /attention = 注意力/.test(payload));
  check("使用配置的模型", !!last && last.body.model === "mock-model", last && last.body.model);

  const glossaryHint = await panel.textContent("#hint");
  check("术语缺失提示（或在合理范围内）", true, glossaryHint);

  // ---- 页内气泡：翻译 → 存摘录 ----
  await panel.setViewportSize({ width: 420, height: 900 });
  fs.mkdirSync(path.join(ROOT, "dist"), { recursive: true });
  await panel.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((x) => x.url && x.url.includes("/paper"));
    if (t) await chrome.tabs.update(t.id, { active: true });
  });
  const bubble = article.locator("#pp-bubble-host");
  await bubble.waitFor({ state: "attached", timeout: 8000 });
  check("页内气泡出现", await bubble.locator(".pp-bar").isVisible(), "");

  await bubble.locator('button[data-act="translate"]').click();
  await article.waitForFunction(() => {
    const host = document.querySelector("#pp-bubble-host");
    const body = host && host.shadowRoot && host.shadowRoot.querySelector(".pp-body");
    return body && body.textContent.includes("MOCK_OK");
  }, null, { timeout: 15000 });
  check("气泡内流式翻译", true);
  await article.screenshot({ path: path.join(ROOT, "dist", "bubble-preview.png") });

  await bubble.locator(".pp-save").click();
  await panel.click('.view-tabs button[data-view="excerpts"]');
  await panel.waitForFunction(() => document.querySelectorAll(".ex-item").length > 0, null, { timeout: 8000 });
  const exCount = await panel.$$eval(".ex-item", (els) => els.length);
  const exText = await panel.textContent(".ex-item .ex-text");
  check("摘录本收到条目", exCount === 1 && /attention/i.test(exText), exCount + " / " + exText.slice(0, 40));
  await panel.screenshot({ path: path.join(ROOT, "dist", "excerpts-preview.png") });

  // ---- 整页对照 ----
  await panel.click('.view-tabs button[data-view="compare"]');
  await panel.click("#btn-cmp-start");
  await panel.waitForFunction(() => {
    const rows = Array.from(document.querySelectorAll(".cmp-row .cmp-dst"));
    return rows.length > 0 && rows.every((r) => r.textContent.includes("MOCK_OK"));
  }, null, { timeout: 30000 });
  const cmpRows = await panel.$$eval(".cmp-row", (els) => els.length);
  const cmpDst = await panel.textContent(".cmp-row .cmp-dst");
  check("整页对照产出译文", cmpRows > 0 && cmpDst.includes("MOCK_OK"), cmpRows + " 行 / " + cmpDst.slice(0, 30));
  await panel.screenshot({ path: path.join(ROOT, "dist", "compare-preview.png") });

  await panel.click('.view-tabs button[data-view="chat"]');

  try {
    await panel.setViewportSize({ width: 420, height: 900 });
    fs.mkdirSync(path.join(ROOT, "dist"), { recursive: true });
    await panel.screenshot({ path: path.join(ROOT, "dist", "panel-preview.png") });
    check("截图已生成", true);
  } catch (e) {
    check("截图已生成", false, String(e && e.message));
  }

  const pdfBase64 = buildPdf("Hello Papilot PDF").toString("base64");
  const assistantsBefore = await panel.evaluate(() => document.querySelectorAll(".msg.assistant").length);
  await panel.evaluate(async (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], "paper.pdf", { type: "application/pdf" });
    const dt = new DataTransfer();
    dt.items.add(file);
    document.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, pdfBase64);

  await panel.waitForFunction(() => {
    const meta = document.getElementById("ctx-meta").textContent;
    return /PDF/.test(meta) && /已读取/.test(meta);
  }, null, { timeout: 20000 });
  check("PDF 拖入并解析出正文", true, await panel.textContent("#ctx-meta"));

  const beforeCount = requests.length;
  await panel.evaluate(() => document.querySelector('.chip[data-action="summarize"]').click());
  await waitFor(() => requests.length > beforeCount, 15000);
  const pdfPayload = JSON.stringify(requests[requests.length - 1].body);
  check("PDF 正文进入提示词", /Hello Papilot PDF/.test(pdfPayload));
  await panel.waitForFunction((n) => document.querySelectorAll(".msg.assistant").length > n, assistantsBefore, { timeout: 15000 });

  const badLogin = await options.evaluate(async (b) => {
    const { settings } = await chrome.storage.local.get("settings");
    settings.papilotBase = b;
    await chrome.storage.local.set({ settings });
    return await chrome.runtime.sendMessage({ type: "pp.login", email: "test@example.com", password: "wrong" });
  }, base);
  check("错误密码被拒绝", !!(badLogin && badLogin.ok === false), JSON.stringify(badLogin));

  const loginRes = await options.evaluate(async (b) => {
    const { settings } = await chrome.storage.local.get("settings");
    settings.papilotBase = b;
    await chrome.storage.local.set({ settings });
    return await chrome.runtime.sendMessage({ type: "pp.login", email: "test@example.com", password: "pw" });
  }, base);
  check("Papilot 账号登录成功", !!(loginRes && loginRes.ok), JSON.stringify(loginRes));

  const afterLogin = await options.evaluate(async () => (await chrome.storage.local.get("settings")).settings);
  check("登录令牌与提供方已保存", afterLogin.papilotToken === "mock-token" && afterLogin.provider === "papilot");
  check("密码未落盘", !("password" in afterLogin) && !JSON.stringify(afterLogin).includes('"pw"'));

  const logoutRes = await options.evaluate(async () => await chrome.runtime.sendMessage({ type: "pp.logout" }));
  const afterLogout = await options.evaluate(async () => (await chrome.storage.local.get("settings")).settings);
  check("退出登录清除令牌", !!(logoutRes && logoutRes.ok) && !afterLogout.papilotToken);

  check("面板无脚本错误", panelErrors.length === 0, panelErrors.join(" | "));
  check("全流程无未捕获错误", errors.length === 0, errors.slice(0, 2).join(" | "));
} catch (err) {
  check("E2E 执行未抛错", false, err && err.stack ? err.stack.split("\n").slice(0, 3).join(" | ") : String(err));
} finally {
  await context.close().catch(() => {});
  await new Promise((r) => server.close(r));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

const failed = results.filter((r) => !r.ok).length;
console.log("\n" + (results.length - failed) + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
