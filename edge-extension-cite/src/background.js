// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 最小后台：首次安装写入默认设置（弹窗与设置页都会读同一份）。 */

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== "install") return;
  try {
    const { settings } = await chrome.storage.local.get("settings");
    if (!settings) {
      await chrome.storage.local.set({ settings: { defaultFormat: "gbt", closeAfterCopy: false } });
    }
  } catch (e) { /* 初始化失败不阻塞使用 */ }
});
