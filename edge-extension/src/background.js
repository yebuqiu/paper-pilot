// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 后台 Service Worker：
 * - 侧边栏与页内气泡的流式请求都走这里（扩展页面跨域 fetch 受 host_permissions 保护）
 * - 页内气泡只上传「动作 + 选中文本 + 页面节选」，提示词在这里拼装
 * - 摘录保存（本地，去重、限量）
 * - Papilot 账号登录 / 会话校验（密码只进请求体，不落盘、不打日志）
 */

import { getSettings, saveSettings, resolveProvider } from "./lib/settings.js";
import { streamChat, ChatError } from "./lib/sse.js";
import { buildMessages } from "./lib/prompts.js";
import { parseGlossary } from "./lib/glossary.js";
import { normalizeExcerpt, mergeExcerpt } from "./lib/excerpts.js";

const KEEPALIVE_MS = 20000;

chrome.runtime.onInstalled.addListener(async (details) => {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (e) { /* 旧版本不支持时忽略 */ }
  if (details.reason === "install") {
    try { await chrome.runtime.openOptionsPage(); } catch (e) { /* ignore */ }
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-panel") return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab && tab.id) await chrome.sidePanel.open({ tabId: tab.id });
  } catch (e) { /* 无活动标签时忽略 */ }
});

/* ==================== 流式通道 ==================== */

function guidance(reason) {
  switch (reason) {
    case "not_logged_in":
      return "请先在「设置 → Papilot 账号」登录，或在设置里改用自带 API Key。";
    case "expired":
      return "登录已过期，请在设置里重新登录。";
    case "no_key":
      return "请先在设置里填写 API Key（任何 OpenAI 兼容接口均可）。";
    default:
      return "模型尚未配置，请打开设置完成配置。";
  }
}

async function quickMessages(msg) {
  const settings = await getSettings();
  const glossary = parseGlossary(settings.glossary);
  return buildMessages({
    action: msg.action === "translate" ? "translate" : "explain",
    selection: String(msg.selection || ""),
    page: msg.page || {},
    glossary,
    lang: settings.outputLang || "zh",
    maxContextChars: settings.maxContextChars || 18000,
  });
}

function attachStreamPort(port) {
  let controller = null;
  let keepAlive = null;

  const stopKeepAlive = () => {
    if (keepAlive) clearInterval(keepAlive);
    keepAlive = null;
  };

  const abort = () => {
    if (controller) {
      try { controller.abort(); } catch (e) { /* ignore */ }
    }
  };

  port.onDisconnect.addListener(() => {
    stopKeepAlive();
    abort();
    controller = null;
  });

  async function run(messages) {
    if (controller) return;
    const settings = await getSettings();
    const provider = resolveProvider(settings);
    if (!provider.ok) {
      port.postMessage({ type: "error", code: provider.reason, message: guidance(provider.reason) });
      return;
    }

    controller = new AbortController();
    const started = Date.now();
    keepAlive = setInterval(() => {
      try { port.postMessage({ type: "ping", at: Date.now() }); } catch (e) { /* disconnected */ }
    }, KEEPALIVE_MS);

    try {
      let text = "";
      const full = await streamChat({
        endpoint: provider.endpoint,
        apiKey: provider.apiKey,
        model: provider.model,
        messages,
        temperature: 0.3,
        extraBody: provider.extraBody,
        signal: controller.signal,
        onDelta: (delta) => {
          text += delta;
          try { port.postMessage({ type: "delta", text: delta }); } catch (e) { /* disconnected */ }
        },
      });
      port.postMessage({
        type: "done",
        text: full || text,
        meta: { mode: provider.mode, ms: Date.now() - started, model: provider.model },
      });
    } catch (err) {
      if (err && err.name === "AbortError") {
        try { port.postMessage({ type: "aborted" }); } catch (e) { /* ignore */ }
      } else {
        const status = err instanceof ChatError ? err.status : 0;
        let message = err && err.message ? err.message : String(err);
        if (status === 401) {
          message = "登录已过期或 Key 无效（401）。请在设置里重新登录或更换 Key。";
          if (provider.mode === "papilot") await saveSettings({ papilotToken: "", papilotTokenExpiresAt: 0 });
        } else if (status === 403) {
          message = "请求被拒绝（403）。若使用 Papilot 账号，请稍后重试；不要重复登录。";
        } else if (status === 429) {
          message = "请求过于频繁（429），请稍后再试。";
        }
        try { port.postMessage({ type: "error", message, status }); } catch (e) { /* ignore */ }
      }
    } finally {
      stopKeepAlive();
      controller = null;
    }
  }

  port.onMessage.addListener(async (msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "abort") {
      abort();
      return;
    }
    if (msg.type === "chat" && Array.isArray(msg.messages)) {
      await run(msg.messages);
      return;
    }
    if (msg.type === "quick") {
      try {
        const messages = await quickMessages(msg);
        await run(messages);
      } catch (e) {
        port.postMessage({ type: "error", message: String(e && e.message ? e.message : e) });
      }
    }
  });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "pp-ai" || port.name === "pp-quick") attachStreamPort(port);
});

/* ==================== 摘录 ==================== */

async function saveExcerpt(input) {
  const item = normalizeExcerpt(input);
  if (!item) return { ok: false, error: "没有可保存的内容" };
  const stored = await chrome.storage.local.get("excerpts");
  const next = mergeExcerpt(stored.excerpts || [], item);
  await chrome.storage.local.set({ excerpts: next });
  return { ok: true, count: next.length, id: item.id };
}

/* ==================== Papilot 账号 ==================== */

function apiUrl(base, path) {
  return String(base || "").replace(/\/+$/, "") + path;
}

async function readJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch (e) { return { ok: false, error: text.slice(0, 200) }; }
}

async function apiCall(base, path, options) {
  const res = await fetch(apiUrl(base, path), options);
  const json = await readJson(res);
  return { status: res.status, json };
}

async function login({ email, password }) {
  const settings = await getSettings();
  const base = settings.papilotBase;
  const res = await apiCall(base, "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: String(email || "").trim(), password: String(password || "") }),
    credentials: "omit",
  });

  if (res.status === 401 || res.status === 400) {
    return { ok: false, error: res.json && res.json.error ? res.json.error : "邮箱或密码不正确" };
  }
  if (!res.json || !res.json.ok || !res.json.token) {
    return { ok: false, error: (res.json && res.json.error) || "登录失败（服务端应答异常）" };
  }

  const expiresAt = res.json.expiresAt ? Date.parse(res.json.expiresAt) : Date.now() + 30 * 86400000;
  await saveSettings({
    provider: "papilot",
    papilotToken: String(res.json.token),
    papilotTokenExpiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 30 * 86400000,
    papilotEmail: String(email || "").trim(),
  });
  return { ok: true, user: res.json.user || null };
}

async function authCheck() {
  const settings = await getSettings();
  if (!settings.papilotToken) return { ok: false, reason: "not_logged_in" };
  try {
    const res = await apiCall(settings.papilotBase, "/api/auth/me", {
      headers: { Authorization: "Bearer " + settings.papilotToken },
      credentials: "omit",
    });
    if (res.status === 401) {
      await saveSettings({ papilotToken: "", papilotTokenExpiresAt: 0 });
      return { ok: false, reason: "expired" };
    }
    if (res.status !== 200 || !res.json || !res.json.ok) {
      return { ok: false, reason: "unreachable", status: res.status };
    }
    await saveSettings({ papilotEmail: (res.json.user && res.json.user.email) || settings.papilotEmail });
    return { ok: true, user: res.json.user || null };
  } catch (e) {
    return { ok: false, reason: "network", error: String(e && e.message ? e.message : e) };
  }
}

async function logout() {
  const settings = await getSettings();
  if (settings.papilotToken) {
    try {
      await apiCall(settings.papilotBase, "/api/auth/logout", {
        method: "POST",
        headers: { Authorization: "Bearer " + settings.papilotToken },
        credentials: "omit",
      });
    } catch (e) { /* 服务端登出失败不影响本地登出 */ }
  }
  await saveSettings({ papilotToken: "", papilotTokenExpiresAt: 0 });
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;

  if (msg.type === "pp.login") {
    login(msg).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true;
  }
  if (msg.type === "pp.logout") {
    logout().then(sendResponse).catch(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "pp.authCheck") {
    authCheck().then(sendResponse).catch((e) => sendResponse({ ok: false, reason: "network", error: String(e) }));
    return true;
  }
  if (msg.type === "pp.saveExcerpt") {
    saveExcerpt(msg.item).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true;
  }
  if (msg.type === "pp.openOptions") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
