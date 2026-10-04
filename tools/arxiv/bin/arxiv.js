#!/usr/bin/env node
"use strict";

/**
 * CLI 可执行入口。
 *   node bin/arxiv.js search -k "diffusion" -c cs.LG
 * 安装到 PATH 后可直接：arxiv search ...
 */

const { run } = require("../src/cli");

run(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((e) => {
    process.stderr.write("未预期错误：" + ((e && e.stack) || e) + "\n");
    process.exitCode = 1;
  });
