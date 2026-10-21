// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 设置读写与提供方解析：所有配置只落在 chrome.storage.local，不参与账号同步。 */

export const DEFAULTS = Object.freeze({
  provider: "custom", // custom | papilot
  baseUrl: "https://api.deepseek.com",
  apiKey: "",
  model: "deepseek-chat",
  papilotBase: "https://pp.xinglintools.top",
  papilotToken: "",
  papilotTokenExpiresAt: 0,
  papilotEmail: "",
  papilotModel: "auto",
  outputLang: "zh",
  glossary: "",
  maxContextChars: 18000,
  bubbleEnabled: true,
});

export function mergeSettings(raw) {
  const out = { ...DEFAULTS };
  if (!raw || typeof raw !== "object") return out;
  for (const key of Object.keys(DEFAULTS)) {
    if (raw[key] !== undefined && raw[key] !== null) out[key] = raw[key];
  }
  out.maxContextChars = Math.min(40000, Math.max(4000, Number(out.maxContextChars) || DEFAULTS.maxContextChars));
  out.provider = out.provider === "papilot" ? "papilot" : "custom";
  out.outputLang = out.outputLang === "en" ? "en" : "zh";
  return out;
}

export async function getSettings() {
  const stored = await chrome.storage.local.get("settings");
  return mergeSettings(stored.settings);
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = mergeSettings({ ...current, ...patch });
  await chrome.storage.local.set({ settings: next });
  return next;
}

export function chatEndpoint(baseUrl) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!base) throw new Error("未配置接口地址");
  if (/\/chat\/completions$/.test(base)) return base;
  if (/\/v1$/.test(base)) return base + "/chat/completions";
  return base + "/v1/chat/completions";
}

/** 解析当前生效的调用配置；未就绪时返回 reason，由调用方给出可读指引。 */
export function resolveProvider(settings) {
  const s = mergeSettings(settings);
  if (s.provider === "papilot") {
    if (!s.papilotToken) return { ok: false, reason: "not_logged_in" };
    if (s.papilotTokenExpiresAt && Number(s.papilotTokenExpiresAt) < Date.now()) {
      return { ok: false, reason: "expired" };
    }
    return {
      ok: true,
      mode: "papilot",
      baseUrl: s.papilotBase,
      endpoint: chatEndpoint(s.papilotBase),
      apiKey: s.papilotToken,
      model: s.papilotModel || "auto",
      // 与插件官方通道一致：聚合网关的 auto 模型建议低推理档，避免长时间思考
      extraBody: { reasoning_effort: "low" },
    };
  }
  if (!s.apiKey) return { ok: false, reason: "no_key" };
  return {
    ok: true,
    mode: "custom",
    baseUrl: s.baseUrl,
    endpoint: chatEndpoint(s.baseUrl),
    apiKey: s.apiKey,
    model: s.model || "deepseek-chat",
  };
}

export function providerLabel(settings) {
  const s = mergeSettings(settings);
  if (s.provider === "papilot") {
    if (!s.papilotToken) return "Papilot 账号（未登录）";
    return "Papilot 官方网关 · " + (s.papilotModel || "auto");
  }
  if (!s.apiKey) return "未配置模型";
  return String(s.model || "custom") + " · 自带 Key";
}
