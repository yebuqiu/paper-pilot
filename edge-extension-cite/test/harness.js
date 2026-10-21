// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

const tests = [];

export function test(name, fn) {
  tests.push({ name, fn });
}

export async function run() {
  let pass = 0;
  const failures = [];
  for (const t of tests) {
    try {
      await t.fn();
      pass++;
      console.log("  \u2713 " + t.name);
    } catch (err) {
      failures.push({ name: t.name, err });
      console.log("  \u2717 " + t.name);
      console.log("      " + (err && err.message ? err.message : String(err)));
    }
  }
  console.log("\n" + pass + " passed, " + failures.length + " failed, " + tests.length + " total");
  if (failures.length) {
    process.exitCode = 1;
    for (const f of failures) {
      if (f.err && f.err.stack) console.log("\n--- " + f.name + " ---\n" + f.err.stack.split("\n").slice(0, 4).join("\n"));
    }
  }
}
