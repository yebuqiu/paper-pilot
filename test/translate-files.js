// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 翻译模块文件清单（0.73.0 拆分后的**单一真源**）
 *
 * 翻译模块 = chrome/content/scripts/ai/ 下的 5 个子模块 + translate.js 门面，
 * 顺序即依赖顺序（与 main.js files 列表保持一致）：
 *   lang（语言模型）→ crypto（签名算法）→ glossary（术语表）→ formula（公式掩码）
 *   → engines（引擎注册表）→ translate.js（门面，组合出 TranslateSvc）。
 *
 * 凡在 Node/vm 里真加载翻译模块的测试（translate / prefs-translate / translate-pane）
 * 一律 require 本清单，禁止各自维护一份文件列表（多份清单必然漂移）。
 */
'use strict';

module.exports = [
  'chrome/content/scripts/ai/translate-lang.js',
  'chrome/content/scripts/ai/translate-crypto.js',
  'chrome/content/scripts/ai/translate-glossary.js',
  'chrome/content/scripts/ai/translate-formula.js',
  'chrome/content/scripts/ai/translate-engines.js',
  'chrome/content/scripts/ai/translate.js',
];
