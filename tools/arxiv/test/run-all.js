"use strict";

/**
 * 测试入口：逐个测试文件用**独立子进程**运行（进程隔离，避免状态串扰），再汇总。
 *
 * 为什么不用 node:test / jest：本仓库的既定风格是「Node 内置能力 + 手写断言」，
 * 零第三方依赖是硬约束，测试框架也不例外。
 *
 * 用法：
 *   node test/run-all.js                    # 全部离线用例
 *   node test/run-all.js --include-network  # 追加真实 arXiv 连通性用例
 *   node test/run-all.js --filter query     # 只跑文件名含 query 的套件
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const TEST_DIR = __dirname;
const args = process.argv.slice(2);
const includeNetwork = args.indexOf("--include-network") >= 0;
const filterIdx = args.indexOf("--filter");
const filter = filterIdx >= 0 ? args[filterIdx + 1] : "";

const OFFLINE = [
  "query.test.js",
  "atom.test.js",
  "analyze.test.js",
  "cache.test.js",
  "config.test.js",
  "exporter.test.js",
  "rate-limiter.test.js",
  "client.test.js",
  "cli.test.js",
];
const NETWORK = ["network.test.js"];

const files = OFFLINE.concat(includeNetwork ? NETWORK : [])
  .filter((f) => fs.existsSync(path.join(TEST_DIR, f)))
  .filter((f) => !filter || f.indexOf(filter) >= 0);

if (!files.length) {
  console.error("没有匹配的测试文件（filter=" + filter + "）");
  process.exit(1);
}

const t0 = Date.now();
const results = [];

console.log("PaperPilot arXiv 工具包 · 测试" + (includeNetwork ? "（含联网用例）" : "（离线）"));
console.log("");

for (const f of files) {
  console.log("=== " + f + " " + "=".repeat(Math.max(0, 46 - f.length)));
  const r = spawnSync(process.execPath, [path.join(TEST_DIR, f)], {
    stdio: "inherit",
    env: Object.assign({}, process.env, includeNetwork ? { PP_ARXIV_NETWORK: "1" } : {}),
  });
  results.push({ file: f, code: r.status == null ? 1 : r.status });
  console.log("");
}

const failed = results.filter((x) => x.code !== 0);
const total = results.length;

console.log("=".repeat(56));
console.log("汇总：" + (total - failed.length) + " / " + total + " 套件通过，用时 " + ((Date.now() - t0) / 1000).toFixed(1) + "s");
if (failed.length) {
  console.log("失败套件：");
  for (const f of failed) console.log("  ✗ " + f.file);
  process.exit(1);
}
console.log("全部通过 ✓");
