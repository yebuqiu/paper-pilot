// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 真实 Edge E2E：加载「引文快取」扩展，在本地论文页上走完 读取 → 五种格式 → 复制 → 设置持久化。 */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "papilot-cite-e2e-"));

let chromium;
try {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  ({ chromium } = require("playwright-core"));
} catch (e) {
  console.error("未找到 playwright-core，请设置 NODE_PATH");
  process.exit(2);
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>A Study of Things - Journal of Demos</title>
<meta name="citation_title" content="A Study of Things">
<meta name="citation_author" content="Smith, John">
<meta name="citation_author" content="Doe, Jane">
<meta name="citation_author" content="Lee, K.">
<meta name="citation_journal_title" content="Journal of Demos">
<meta name="citation_volume" content="12">
<meta name="citation_issue" content="3">
<meta name="citation_firstpage" content="45">
<meta name="citation_lastpage" content="58">
<meta name="citation_publication_date" content="2021-04-02">
<meta name="citation_doi" content="10.1016/j.demo.2021.01.001">
<meta name="citation_issn" content="1234-5678">
<meta name="citation_publisher" content="Elsevier">
</head><body><article><h1>A Study of Things</h1><p>Abstract text.</p></article></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/favicon")) { res.writeHead(204); res.end(); return; }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(PAGE);
});
const port = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));
const base = "http://127.0.0.1:" + port;

function copyExtension() {
  const dst = path.join(TMP, "extension");
  fs.cpSync(ROOT, dst, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(ROOT, src);
      return !rel.startsWith("test") && !rel.startsWith("tools") && !rel.startsWith("dist") && !rel.startsWith("node_modules");
    },
  });
  const p = path.join(dst, "manifest.json");
  const m = JSON.parse(fs.readFileSync(p, "utf8"));
  m.host_permissions.push("http://127.0.0.1/*");
  fs.writeFileSync(p, JSON.stringify(m, null, 2));
  return dst;
}

const extDir = copyExtension();
const context = await chromium.launchPersistentContext(path.join(TMP, "profile"), {
  channel: "msedge",
  headless: true,
  args: ["--disable-extensions-except=" + extDir, "--load-extension=" + extDir, "--no-first-run"],
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
  check("扩展加载并启动 Service Worker", !!id, sw.url());

  const errors = [];
  context.on("page", (p) => {
    p.on("pageerror", (e) => errors.push(p.url() + " :: " + e.message));
    p.on("console", (m) => { if (m.type() === "error") errors.push(p.url() + " :: " + m.text()); });
  });

  const article = await context.newPage();
  await article.goto(base + "/paper", { waitUntil: "domcontentloaded" });

  const popup = await context.newPage();
  popup.on("pageerror", (e) => errors.push("popup :: " + e.message));
  await popup.goto("chrome-extension://" + id + "/src/popup/popup.html");
  await popup.waitForSelector("#btn-reread");

  await popup.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((x) => x.url && x.url.includes("/paper"));
    if (!t) throw new Error("找不到测试页");
    await chrome.tabs.update(t.id, { active: true });
    document.getElementById("btn-reread").click();
  });

  await popup.waitForFunction(() => {
    const out = document.getElementById("output");
    return out && out.textContent.includes("A Study of Things");
  }, null, { timeout: 10000 });

  const title = await popup.textContent("#paper-title");
  check("识别页面标题", title.includes("A Study of Things"), title);

  const tabs = await popup.$$eval(".tab", (els) => els.map((e) => e.textContent));
  check("五种格式齐全", tabs.length === 5, tabs.join(" | "));

  const gbt = await popup.textContent("#output");
  check(
    "GB/T 7714 输出正确",
    gbt === "Smith J., Doe J., Lee K. A Study of Things[J]. Journal of Demos, 2021, 12(3): 45-58. DOI:10.1016/j.demo.2021.01.001.",
    gbt
  );

  await popup.click('.tab[data-id="apa"]');
  const apa = await popup.textContent("#output");
  check("APA 输出包含年份与 DOI 链接", /\(2021\)/.test(apa) && apa.includes("https://doi.org/"), apa);

  await popup.click('.tab[data-id="mla"]');
  const mla = await popup.textContent("#output");
  check("MLA 输出含 vol./no./pp.", /vol\. 12/.test(mla) && /no\. 3/.test(mla) && /pp\. 45-58/.test(mla), mla);

  await popup.click('.tab[data-id="bibtex"]');
  const bib = await popup.textContent("#output");
  check("BibTeX 输出", /^@article\{/.test(bib) && bib.includes("journal = {Journal of Demos}"), bib.split("\n")[0]);

  await popup.click('.tab[data-id="ris"]');
  const ris = await popup.textContent("#output");
  check("RIS 输出", ris.startsWith("TY  - JOUR") && ris.includes("ER  -"), ris.split("\n")[0]);

  await popup.click('.tab[data-id="gbt"]');
  await popup.click("#btn-copy");
  await popup.waitForFunction(() => /已复制/.test(document.getElementById("status").textContent), null, { timeout: 5000 });
  check("复制写入剪贴板", true);

  const options = await context.newPage();
  await options.goto("chrome-extension://" + id + "/src/options/options.html");
  await options.waitForSelector("#default-format");
  await options.selectOption("#default-format", "apa");
  await options.check("#close-after-copy");
  await options.click("#btn-save");
  await options.waitForFunction(() => document.getElementById("save-msg").textContent.includes("已保存"));

  await options.reload();
  await options.waitForSelector("#default-format");
  const savedFormat = await options.inputValue("#default-format");
  const savedClose = await options.isChecked("#close-after-copy");
  check("设置持久化", savedFormat === "apa" && savedClose === true, savedFormat + "/" + savedClose);

  await popup.reload();
  await popup.waitForSelector("#btn-reread");
  await popup.evaluate(async () => {
    const all = await chrome.tabs.query({});
    const t = all.find((x) => x.url && x.url.includes("/paper"));
    await chrome.tabs.update(t.id, { active: true });
    document.getElementById("btn-reread").click();
  });
  await popup.waitForFunction(() => document.getElementById("output").textContent.includes("A Study of Things"), null, { timeout: 10000 });
  const active = await popup.getAttribute('.tab[data-id="apa"]', "aria-selected");
  check("默认格式生效（APA）", active === "true", String(active));

  try {
    await popup.setViewportSize({ width: 420, height: 640 });
    fs.mkdirSync(path.join(ROOT, "dist"), { recursive: true });
    await popup.screenshot({ path: path.join(ROOT, "dist", "popup-preview.png") });
    check("截图已生成", true);
  } catch (e) {
    check("截图已生成", false, String(e && e.message));
  }

  check("无未捕获脚本错误", errors.length === 0, errors.slice(0, 3).join(" | "));
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
