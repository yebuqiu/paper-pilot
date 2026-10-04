"use strict";

/**
 * 极简测试框架（零依赖，与仓库既有测试风格一致：Node 内置 assert + 手写收集器）。
 *
 * 每个测试文件独立成进程运行（run-all.js 用 spawnSync 拉起），互不污染状态。
 * 用法：
 *   const { test, assert, run, tmpDir } = require("./_harness");
 *   test("名字", async () => { assert.strictEqual(1, 1); });
 *   run("套件名");
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tests = [];
const DIM = "\u001b[90m";
const RED = "\u001b[31m";
const GREEN = "\u001b[32m";
const RESET = "\u001b[0m";

function test(name, fn) {
  tests.push({ name, fn });
}

/** 建一个临时目录（调用方负责在 finally 里 rmTemp）。 */
function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), (prefix || "pp-arxiv-")));
}

function rmTemp(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

/**
 * 运行当前文件注册的全部用例。
 * @param {string} label
 * @returns {Promise<{pass:number,fail:number}>}
 */
async function run(label) {
  const t0 = Date.now();
  let pass = 0;
  let fail = 0;
  const failures = [];

  // 保活计时器：用例未 await 时（本框架的设计如此），若某处把唯一的计时器 unref 掉了，
  // 进程会静默退出、测试「全部通过」——这是最难发现的一类假绿。这里显式把事件循环钉住。
  const keepAlive = setInterval(() => {}, 1000);

  try {
    for (const t of tests) {
      const s = Date.now();
      try {
        await t.fn();
        pass++;
        process.stdout.write("  " + GREEN + "✓" + RESET + " " + t.name + " " + DIM + (Date.now() - s) + "ms" + RESET + "\n");
      } catch (e) {
        fail++;
        failures.push({ name: t.name, error: e });
        process.stdout.write("  " + RED + "✗" + RESET + " " + t.name + "\n");
        process.stdout.write("      " + RED + ((e && e.message) || String(e)) + RESET + "\n");
      }
    }
  } finally {
    clearInterval(keepAlive);
  }

  process.stdout.write("\n" + label + ": " + pass + " 通过, " + fail + " 失败 (" + (Date.now() - t0) + "ms)\n");
  if (fail) {
    for (const f of failures) {
      process.stdout.write("\n--- 失败详情：" + f.name + " ---\n");
      process.stdout.write(((f.error && f.error.stack) || String(f.error)) + "\n");
    }
    process.exitCode = 1;
  }
  return { pass, fail };
}

module.exports = { test, assert, run, tmpDir, rmTemp };
