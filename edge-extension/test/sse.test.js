// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

import assert from "node:assert/strict";
import http from "node:http";
import { streamChat, ChatError } from "../src/lib/sse.js";

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: "http://127.0.0.1:" + server.address().port + "/v1/chat/completions",
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => resolve(data));
  });
}

export default function register(test) {
  test("streamChat 解析 SSE 分片并逐段回调", async () => {
    let seenAuth = "";
    let seenBody = null;
    const srv = await listen(async (req, res) => {
      seenAuth = req.headers.authorization;
      seenBody = JSON.parse(await readBody(req));
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"注意"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"力机制"}}]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    });

    try {
      const deltas = [];
      const full = await streamChat({
        endpoint: srv.url,
        apiKey: "test-key",
        model: "demo",
        messages: [{ role: "user", content: "hi" }],
        extraBody: { reasoning_effort: "low" },
        onDelta: (d) => deltas.push(d),
      });
      assert.equal(full, "注意力机制");
      assert.deepEqual(deltas, ["注意", "力机制"]);
      assert.equal(seenAuth, "Bearer test-key");
      assert.equal(seenBody.stream, true);
      assert.equal(seenBody.model, "demo");
      assert.equal(seenBody.reasoning_effort, "low");
    } finally {
      await srv.close();
    }
  });

  test("streamChat 兼容非流式 JSON 应答", async () => {
    const srv = await listen(async (req, res) => {
      await readBody(req);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "一次性回答" } }] }));
    });
    try {
      const full = await streamChat({
        endpoint: srv.url,
        apiKey: "k",
        model: "m",
        messages: [{ role: "user", content: "hi" }],
      });
      assert.equal(full, "一次性回答");
    } finally {
      await srv.close();
    }
  });

  test("streamChat 在 401 时抛出带状态码的 ChatError", async () => {
    const srv = await listen(async (req, res) => {
      await readBody(req);
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid api key" } }));
    });
    try {
      await assert.rejects(
        () => streamChat({ endpoint: srv.url, apiKey: "bad", model: "m", messages: [] }),
        (err) => {
          assert.ok(err instanceof ChatError);
          assert.equal(err.status, 401);
          assert.equal(err.message, "invalid api key");
          return true;
        }
      );
    } finally {
      await srv.close();
    }
  });

  test("streamChat 支持中途 abort", async () => {
    const srv = await listen(async (req, res) => {
      await readBody(req);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"开始"}}]}\n\n');
      setTimeout(() => {
        try {
          res.write('data: {"choices":[{"delta":{"content":"继续"}}]}\n\n');
          res.end();
        } catch (e) { /* client 已断开 */ }
      }, 300);
    });
    try {
      const controller = new AbortController();
      const p = streamChat({
        endpoint: srv.url,
        apiKey: "k",
        model: "m",
        messages: [],
        signal: controller.signal,
        onDelta: () => controller.abort(),
      });
      await assert.rejects(p, (err) => err.name === "AbortError");
    } finally {
      await srv.close();
    }
  });
}
