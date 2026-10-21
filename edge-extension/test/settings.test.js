// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

import assert from "node:assert/strict";
import { mergeSettings, chatEndpoint, resolveProvider, providerLabel, DEFAULTS } from "../src/lib/settings.js";

export default function register(test) {
  test("mergeSettings 补齐默认值并保持未知字段不污染", () => {
    const s = mergeSettings({ apiKey: "k", hacked: true });
    assert.equal(s.apiKey, "k");
    assert.equal(s.provider, "custom");
    assert.equal(s.maxContextChars, DEFAULTS.maxContextChars);
    assert.equal("hacked" in s, false);
  });

  test("mergeSettings 归一化 provider / 语言 / 上下文上限", () => {
    const s = mergeSettings({ provider: "weird", outputLang: "fr", maxContextChars: 999999 });
    assert.equal(s.provider, "custom");
    assert.equal(s.outputLang, "zh");
    assert.equal(s.maxContextChars, 40000);
    assert.equal(mergeSettings({ maxContextChars: 1 }).maxContextChars, 4000);
  });

  test("chatEndpoint 兼容三种常见写法", () => {
    assert.equal(chatEndpoint("https://api.deepseek.com"), "https://api.deepseek.com/v1/chat/completions");
    assert.equal(chatEndpoint("https://api.deepseek.com/v1/"), "https://api.deepseek.com/v1/chat/completions");
    assert.equal(chatEndpoint("https://x.test/v1/chat/completions"), "https://x.test/v1/chat/completions");
    assert.throws(() => chatEndpoint(""));
  });

  test("resolveProvider: 自带 Key 未填时报 no_key", () => {
    assert.deepEqual(resolveProvider({ provider: "custom", apiKey: "" }), { ok: false, reason: "no_key" });
  });

  test("resolveProvider: 账号模式未登录 / 过期 / 正常", () => {
    assert.equal(resolveProvider({ provider: "papilot" }).reason, "not_logged_in");
    assert.equal(
      resolveProvider({ provider: "papilot", papilotToken: "t", papilotTokenExpiresAt: Date.now() - 1000 }).reason,
      "expired"
    );
    const ok = resolveProvider({ provider: "papilot", papilotToken: "t", papilotTokenExpiresAt: Date.now() + 10000 });
    assert.equal(ok.ok, true);
    assert.equal(ok.endpoint, "https://pp.xinglintools.top/v1/chat/completions");
    assert.equal(ok.model, "auto");
  });

  test("providerLabel 给出可读状态", () => {
    assert.match(providerLabel({ provider: "custom", apiKey: "" }), /未配置/);
    assert.match(providerLabel({ provider: "custom", apiKey: "k", model: "m" }), /m/);
    assert.match(providerLabel({ provider: "papilot" }), /未登录/);
  });
}
