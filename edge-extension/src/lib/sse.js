// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* OpenAI 兼容接口的流式客户端。
 * 只依赖 fetch / TextDecoder，浏览器与 Node 18+ 都能跑，便于用本地 mock 服务做端到端测试。
 */

export class ChatError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.name = "ChatError";
    this.status = status || 0;
    this.detail = detail || "";
  }
}

function pickDelta(payload) {
  const choice = payload && payload.choices && payload.choices[0];
  if (!choice) return "";
  if (choice.delta && typeof choice.delta.content === "string") return choice.delta.content;
  if (choice.message && typeof choice.message.content === "string") return choice.message.content;
  if (typeof choice.text === "string") return choice.text;
  return "";
}

/**
 * @param {{
 *   endpoint: string, apiKey: string, model: string,
 *   messages: Array<{role: string, content: string}>,
 *   temperature?: number, signal?: AbortSignal,
 *   onDelta?: (text: string) => void, fetchImpl?: typeof fetch
 * }} opts
 * @returns {Promise<string>} 完整回答
 */
export async function streamChat(opts) {
  const doFetch = opts.fetchImpl || fetch;
  const onDelta = typeof opts.onDelta === "function" ? opts.onDelta : function () {};

  const res = await doFetch(opts.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + (opts.apiKey || ""),
    },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      temperature: typeof opts.temperature === "number" ? opts.temperature : 0.3,
      stream: true,
      ...(opts.extraBody && typeof opts.extraBody === "object" ? opts.extraBody : {}),
    }),
    signal: opts.signal,
    credentials: "omit",
  });

  if (!res.ok) {
    let detail = "";
    try { detail = await res.text(); } catch (e) { detail = ""; }
    let message = "AI 接口返回 " + res.status;
    try {
      const j = JSON.parse(detail);
      if (j && (j.error?.message || j.message)) message = j.error?.message || j.message;
    } catch (e) { /* 非 JSON 错误体，保留状态码文案 */ }
    throw new ChatError(message, res.status, String(detail || "").slice(0, 300));
  }

  const ctype = String(res.headers.get("content-type") || "");
  if (!ctype.includes("event-stream") || !res.body) {
    const data = await res.json();
    const text = pickDelta(data);
    if (text) onDelta(text);
    return text;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

  while (true) {
    const step = await reader.read();
    if (step.done) break;
    buffer += decoder.decode(step.value, { stream: true });

    let idx;
    while ((idx = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + (buffer[idx] === "\r" ? 4 : 2));
      const step2 = consumeBlock(block, onDelta);
      full += step2.text;
      if (step2.done) {
        try { await reader.cancel(); } catch (e) { /* ignore */ }
        return full;
      }
    }
  }

  if (buffer.trim()) {
    full += consumeBlock(buffer, onDelta).text;
  }
  return full;
}

function consumeBlock(block, onDelta) {
  let text = "";
  let done = false;
  for (const raw of String(block || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(":")) continue;
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") {
      done = true;
      continue;
    }
    let json;
    try { json = JSON.parse(payload); } catch (e) { continue; }
    const delta = pickDelta(json);
    if (delta) {
      text += delta;
      onDelta(delta);
    }
  }
  return { text, done };
}
