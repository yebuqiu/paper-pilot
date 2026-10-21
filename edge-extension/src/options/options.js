// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 设置页：模型来源、账号登录、阅读偏好、术语表。 */

import { getSettings, saveSettings } from "../lib/settings.js";
import { parseGlossary } from "../lib/glossary.js";

const $ = (id) => document.getElementById(id);

function setMsg(id, text, kind) {
  const el = $(id);
  el.textContent = text || "";
  el.className = "msg" + (kind ? " " + kind : "");
}

function currentProvider() {
  const checked = document.querySelector('input[name="provider"]:checked');
  return checked ? checked.value : "custom";
}

function togglePanels() {
  const provider = currentProvider();
  $("custom-panel").classList.toggle("hidden", provider !== "custom");
  $("papilot-panel").classList.toggle("hidden", provider !== "papilot");
}

function fillForm(s) {
  document.querySelectorAll('input[name="provider"]').forEach((el) => {
    el.checked = el.value === s.provider;
  });
  $("base-url").value = s.baseUrl || "";
  $("model").value = s.model || "";
  $("api-key").value = s.apiKey || "";
  $("email").value = s.papilotEmail || "";
  $("lang").value = s.outputLang || "zh";
  $("max-context").value = s.maxContextChars || 18000;
  $("bubble").checked = s.bubbleEnabled !== false;
  $("glossary").value = s.glossary || "";
  updateGlossaryCount();
  togglePanels();
  renderAccount(s);
}

function renderAccount(s) {
  const box = $("account-status");
  const logout = $("btn-logout");
  const form = $("login-form");
  if (s && s.papilotToken) {
    const who = s.papilotEmail || "已登录";
    const expired = s.papilotTokenExpiresAt && Number(s.papilotTokenExpiresAt) < Date.now();
    box.textContent = expired ? who + "（登录已过期）" : who + "（已登录）";
    box.className = "account-status" + (expired ? "" : " ok");
    logout.classList.remove("hidden");
    form.classList.add("hidden");
    if (!expired) checkAuth();
  } else {
    box.textContent = "未登录";
    box.className = "account-status";
    logout.classList.add("hidden");
    form.classList.remove("hidden");
  }
}

async function checkAuth() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "pp.authCheck" });
    if (res && res.ok) {
      setMsg("login-msg", "会话有效" + (res.user && res.user.email ? "：" + res.user.email : ""), "ok");
    } else if (res && res.reason === "expired") {
      const s = await getSettings();
      renderAccount(s);
      setMsg("login-msg", "登录已过期，请重新登录", "err");
    }
  } catch (e) { /* 后台未就绪时忽略 */ }
}

function updateGlossaryCount() {
  const terms = parseGlossary($("glossary").value);
  $("glossary-count").textContent = terms.length + " 条";
}

function collect() {
  return {
    provider: currentProvider(),
    baseUrl: $("base-url").value.trim(),
    model: $("model").value.trim(),
    apiKey: $("api-key").value.trim(),
    outputLang: $("lang").value,
    maxContextChars: Number($("max-context").value) || 18000,
    bubbleEnabled: $("bubble").checked,
    glossary: $("glossary").value,
  };
}

async function save() {
  const patch = collect();
  if (patch.provider === "custom") {
    if (!patch.baseUrl || !patch.apiKey || !patch.model) {
      setMsg("save-msg", "自带 Key 模式需要填完整地址、模型名与 Key", "err");
      return;
    }
    try {
      const u = new URL(patch.baseUrl);
      if (!/^https?:$/.test(u.protocol)) throw new Error("bad protocol");
    } catch (e) {
      setMsg("save-msg", "接口地址不是合法的 http(s) URL", "err");
      return;
    }
  }
  const next = await saveSettings(patch);
  fillForm(next);
  setMsg("save-msg", "已保存", "ok");
  setTimeout(() => setMsg("save-msg", ""), 2200);
}

async function login() {
  const email = $("email").value.trim();
  const password = $("password").value;
  if (!email || !password) {
    setMsg("login-msg", "请填写邮箱与密码", "err");
    return;
  }
  $("btn-login").disabled = true;
  setMsg("login-msg", "正在登录…");
  try {
    const res = await chrome.runtime.sendMessage({ type: "pp.login", email, password });
    if (res && res.ok) {
      $("password").value = "";
      const s = await getSettings();
      fillForm(s);
      setMsg("login-msg", "登录成功", "ok");
    } else {
      setMsg("login-msg", (res && res.error) || "登录失败", "err");
    }
  } catch (e) {
    setMsg("login-msg", "登录失败：" + (e && e.message ? e.message : e), "err");
  } finally {
    $("btn-login").disabled = false;
  }
}

async function logout() {
  try {
    await chrome.runtime.sendMessage({ type: "pp.logout" });
  } catch (e) { /* ignore */ }
  const s = await getSettings();
  renderAccount(s);
  setMsg("login-msg", "已退出登录", "ok");
}

async function init() {
  const s = await getSettings();
  fillForm(s);

  document.querySelectorAll('input[name="provider"]').forEach((el) => {
    el.addEventListener("change", togglePanels);
  });
  $("glossary").addEventListener("input", updateGlossaryCount);
  $("btn-save").addEventListener("click", () => save().catch((e) => setMsg("save-msg", String(e.message || e), "err")));
  $("btn-login").addEventListener("click", login);
  $("btn-logout").addEventListener("click", logout);
  $("btn-shortcuts").addEventListener("click", () => {
    setMsg("save-msg", "默认 Alt+Shift+P；可在 edge://extensions/shortcuts 修改", "ok");
  });
}

init().catch((e) => setMsg("save-msg", "初始化失败：" + (e && e.message ? e.message : e), "err"));
