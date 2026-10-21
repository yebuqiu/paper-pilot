// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

const DEFAULTS = { defaultFormat: "gbt", closeAfterCopy: false };
const $ = (id) => document.getElementById(id);

function setMsg(text, ok) {
  $("save-msg").textContent = text || "";
  $("save-msg").className = "msg" + (ok ? " ok" : "");
}

async function load() {
  const { settings } = await chrome.storage.local.get("settings");
  const s = { ...DEFAULTS, ...(settings || {}) };
  $("default-format").value = s.defaultFormat;
  $("close-after-copy").checked = !!s.closeAfterCopy;
}

async function save() {
  const settings = {
    defaultFormat: $("default-format").value,
    closeAfterCopy: $("close-after-copy").checked,
  };
  await chrome.storage.local.set({ settings });
  setMsg("已保存", true);
  setTimeout(() => setMsg(""), 2000);
}

$("btn-save").addEventListener("click", () => save().catch((e) => setMsg(String(e.message || e), false)));
load().catch((e) => setMsg(String(e.message || e), false));
