// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 真实站点验证（无需账号）：arXiv 摘要页 → 取引文 → 五种格式。
 * 运行：NODE_PATH=<pw> node test/real-site.js
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "papilot-cite-real-"));
const URL_ = "https://arxiv.org/abs/1706.03762";

let chromium;
try {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  ({ chromium } = require("playwright-core"));
} catch (e) {
  console.error("未找到 playwright-core，请设置 NODE_PATH");
  process.exit(2);
}

function copyExtension() {
  const dst = path.join(TMP, "extension");
  fs.cpSync(ROOT, dst, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(ROOT, src);
      return !rel.startsWith("test") && !rel.startsWith("tools") && !rel.startsWith("dist");
    },
  });
  const p = path.join(dst, "manifest.json");
  const m = JSON.parse(fs.readFileSync(p, "utf8"));
  m.host_permissions.push("https://*.arxiv.org/*");
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

  const paper = await context.newPage();
  const nav = await paper.goto(URL_, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => null);
  check("打开真实 arXiv 页面", !!(nav && nav.ok()), nav ? String(nav.status()) : "failed");

  const popup = await context.newPage();
  await popup.goto("chrome-extension://" + id + "/src/popup/popup.html");
  await popup.waitForSelector("#btn-reread");

  await popup.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((x) => x.url && x.url.startsWith(url));
    if (!t) throw new Error("找不到 arXiv 标签页");
    await chrome.tabs.update(t.id, { active: true });
    document.getElementById("btn-reread").click();
  }, URL_);

  await popup.waitForFunction(() => document.getElementById("output").textContent.length > 20, null, { timeout: 20000 });

  const title = await popup.textContent("#paper-title");
  const meta = await popup.textContent("#paper-meta");
  const gbt = await popup.textContent("#output");
  check("识别真实论文标题", /Attention Is All You Need/i.test(title), title);
  check("识别 arXiv 与年份", /arXiv/.test(meta) && /2017/.test(meta), meta);
  check("GB/T 输出为预印本格式", /\[J\/OL\]/.test(gbt) && /arXiv/.test(gbt), gbt.slice(0, 120));

  await popup.click('.tab[data-id="bibtex"]');
  const bib = await popup.textContent("#output");
  check("BibTeX 输出含 eprint", /eprint = \{1706\.03762\}/.test(bib), bib.split("\n")[0]);

  await popup.click('.tab[data-id="gbt"]');
  try {
    await popup.setViewportSize({ width: 420, height: 640 });
    fs.mkdirSync(path.join(ROOT, "dist"), { recursive: true });
    await popup.screenshot({ path: path.join(ROOT, "dist", "real-site-preview.png") });
    check("截图已生成", true);
  } catch (e) {
    check("截图已生成", false, String(e.message));
  }
} catch (err) {
  check("验证流程未抛错", false, err && err.stack ? err.stack.split("\n").slice(0, 3).join(" | ") : String(err));
} finally {
  await context.close().catch(() => {});
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

const failed = results.filter((r) => !r.ok).length;
console.log("\n" + (results.length - failed) + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
