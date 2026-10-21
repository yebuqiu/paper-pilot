// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

import { test, run } from "./harness.js";

const MODULES = ["./record.test.js", "./format.test.js", "./manifest.test.js"];

console.log("Papilot 引文快取 · 单元与结构检查\n");

let loadFailed = 0;
for (const mod of MODULES) {
  try {
    const imported = await import(mod);
    if (typeof imported.default === "function") imported.default(test);
  } catch (err) {
    loadFailed++;
    console.error("  ! 无法加载 " + mod + "：" + (err && err.message ? err.message : err));
  }
}

await run();
if (loadFailed) process.exitCode = 1;
