// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 内容脚本（学术站点白名单）：
 * - 划词后弹出页内气泡：翻译 / 解释 / 存摘录（结果流式显示）
 * - 把选中文本同步给侧边栏
 * - 响应侧边栏的「读取本页」请求
 */
(function () {
  "use strict";

  if (window.__papilotContentLoaded) return;
  window.__papilotContentLoaded = true;

  var lastText = "";
  var timer = null;
  var host = null;
  var root = null;
  var bar = null;
  var panel = null;
  var bodyEl = null;
  var titleEl = null;
  var statusEl = null;
  var toastEl = null;
  var currentText = "";
  var currentRect = null;
  var port = null;
  var busy = false;
  var resultText = "";
  var settings = { bubbleEnabled: true };
  var pageCache = { at: 0, data: null };

  var STYLE = [
    ":host{all:initial}",
    "*{box-sizing:border-box}",
    ".pp-bar,.pp-panel{position:fixed;z-index:2147483647;font:13px/1.6 system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;color:#1f2328}",
    ".pp-bar{display:flex;gap:2px;padding:4px;border:1px solid #e1e7e4;border-radius:10px;background:#fff;box-shadow:0 8px 24px rgba(17,40,33,.16)}",
    ".pp-bar button{border:0;background:none;padding:4px 9px;border-radius:7px;font:inherit;font-size:12.5px;color:#1f2328;cursor:pointer;white-space:nowrap}",
    ".pp-bar button:hover{background:#e1f5ee;color:#0f6e56}",
    ".pp-panel{width:340px;max-height:360px;display:flex;flex-direction:column;border:1px solid #e1e7e4;border-radius:12px;background:#fff;box-shadow:0 18px 48px rgba(17,40,33,.20);overflow:hidden}",
    ".pp-head{display:flex;align-items:center;justify-content:space-between;padding:7px 10px;border-bottom:1px solid #eef3f1;font-size:12px;color:#5f6b76}",
    ".pp-head b{font-weight:600;color:#0f6e56}",
    ".pp-close{border:0;background:none;font-size:16px;line-height:1;padding:0 2px;color:#7b878f;cursor:pointer}",
    ".pp-body{padding:9px 11px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.7;min-height:52px;max-height:260px}",
    ".pp-foot{display:flex;align-items:center;gap:8px;padding:6px 10px;border-top:1px solid #eef3f1}",
    ".pp-foot button{border:1px solid #e1e7e4;background:#fff;border-radius:7px;padding:3px 9px;font:inherit;font-size:11.5px;color:#1f2328;cursor:pointer}",
    ".pp-foot button:hover{border-color:#0f6e56;color:#0f6e56}",
    ".pp-status{margin-left:auto;font-size:10.5px;color:#7b878f}",
    ".pp-toast{position:fixed;left:50%;bottom:40px;transform:translateX(-50%);background:rgba(31,35,40,.92);color:#fff;font-size:11.5px;padding:5px 12px;border-radius:999px;z-index:2147483647}",
    "@media (prefers-color-scheme:dark){.pp-bar,.pp-panel{background:#1c2226;border-color:#2a3237;color:#e8edf0}.pp-bar button{color:#e8edf0}.pp-bar button:hover{background:#12302a;color:#5dcaa5}.pp-head{color:#98a4ac;border-color:#2a3237}.pp-head b{color:#5dcaa5}.pp-body{color:#e8edf0}.pp-foot{border-color:#2a3237}.pp-foot button{background:#1c2226;border-color:#2a3237;color:#e8edf0}.pp-status{color:#98a4ac}}",
  ].join("");

  var MARKUP = [
    '<div class="pp-bar" hidden>',
    '<button data-act="translate" title="译成中文">翻译</button>',
    '<button data-act="explain" title="在本文语境中解释">解释</button>',
    '<button data-act="save" title="保存到摘录本">存摘录</button>',
    "</div>",
    '<div class="pp-panel" hidden>',
    '<div class="pp-head"><b>Papilot</b><span class="pp-title"></span><button class="pp-close" title="关闭">×</button></div>',
    '<div class="pp-body"></div>',
    '<div class="pp-foot"><button class="pp-copy">复制</button><button class="pp-save">存摘录</button><span class="pp-status"></span></div>',
    "</div>",
    '<div class="pp-toast" hidden></div>',
  ].join("");

  function ensureHost() {
    if (host && root) return;
    host = document.createElement("div");
    host.id = "pp-bubble-host";
    host.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647";
    root = host.attachShadow({ mode: "open" });
    root.innerHTML = "<style>" + STYLE + "</style>" + MARKUP;
    document.documentElement.appendChild(host);

    bar = root.querySelector(".pp-bar");
    panel = root.querySelector(".pp-panel");
    bodyEl = root.querySelector(".pp-body");
    titleEl = root.querySelector(".pp-title");
    statusEl = root.querySelector(".pp-status");
    toastEl = root.querySelector(".pp-toast");

    bar.addEventListener("mousedown", (e) => e.preventDefault());
    bar.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => onAction(btn.dataset.act));
    });
    root.querySelector(".pp-close").addEventListener("click", () => {
      if (port) { try { port.postMessage({ type: "abort" }); } catch (e) { /* ignore */ } }
      hidePanel();
    });
    root.querySelector(".pp-copy").addEventListener("click", () => copy(resultText));
    root.querySelector(".pp-save").addEventListener("click", () => saveExcerpt(currentText, resultText));
  }

  function place(el, rect, above) {
    var width = el === bar ? 200 : 340;
    var left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 12));
    el.style.left = left + "px";
    if (above) {
      el.style.top = "auto";
      el.style.bottom = Math.max(8, window.innerHeight - rect.top + 8) + "px";
    } else {
      el.style.bottom = "auto";
      el.style.top = Math.min(window.innerHeight - 60, rect.bottom + 8) + "px";
    }
  }

  function hideBar() {
    if (bar) bar.hidden = true;
  }

  function hidePanel() {
    busy = false;
    resultText = "";
    if (panel) panel.hidden = true;
    if (port) {
      try { port.disconnect(); } catch (e) { /* ignore */ }
      port = null;
    }
  }

  function hideAll() {
    hideBar();
    hidePanel();
  }

  function showToast(text) {
    if (!toastEl) return;
    toastEl.textContent = text;
    toastEl.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { toastEl.hidden = true; }, 1500);
  }

  function currentSelection() {
    try {
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed) return "";
      return String(sel.toString() || "").replace(/\s+/g, " ").trim().slice(0, 4000);
    } catch (e) {
      return "";
    }
  }

  function selectionRect() {
    try {
      var sel = window.getSelection();
      if (!sel || !sel.rangeCount) return null;
      var rect = sel.getRangeAt(0).getBoundingClientRect();
      if (!rect || (!rect.width && !rect.height)) return null;
      return rect;
    } catch (e) {
      return null;
    }
  }

  function send(payload) {
    try {
      var p = chrome.runtime.sendMessage(payload);
      if (p && typeof p.catch === "function") p.catch(function () { /* 侧边栏未打开 */ });
    } catch (e) { /* ignore */ }
  }

  function syncSelection() {
    var text = currentSelection();
    if (text === lastText) return;
    lastText = text;
    send({ type: "pp.selection", text: text, title: document.title, url: location.href });
  }

  function flush() {
    var text = currentSelection();
    syncSelection();
    if (!settings.bubbleEnabled) return;
    if (!text) {
      hideBar();
      return;
    }
    var rect = selectionRect();
    if (!rect) return;
    ensureHost();
    currentText = text;
    currentRect = rect;
    if (panel && !panel.hidden) return;
    place(bar, rect, false);
    bar.hidden = false;
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 160);
  }

  function pageContext() {
    var now = Date.now();
    if (pageCache.data && now - pageCache.at < 15000) return pageCache.data;
    var data = window.PPTextLib.extractFromDocument(document);
    pageCache = { at: now, data: data };
    return data;
  }

  function onAction(action) {
    if (action === "save") {
      saveExcerpt(currentText, "");
      return;
    }
    startQuick(action);
  }

  function startQuick(action) {
    ensureHost();
    if (!currentText) return;
    hideBar();
    place(panel, currentRect || { left: 40, bottom: 80, top: 80 }, false);
    panel.hidden = false;
    titleEl.textContent = action === "translate" ? "翻译" : "解释";
    bodyEl.textContent = "";
    statusEl.textContent = "生成中…";
    resultText = "";
    busy = true;

    var page = pageContext();
    try {
      port = chrome.runtime.connect({ name: "pp-quick" });
    } catch (e) {
      statusEl.textContent = "后台未就绪";
      busy = false;
      return;
    }
    port.onMessage.addListener(function (msg) {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "delta") {
        bodyEl.textContent += msg.text;
        bodyEl.scrollTop = bodyEl.scrollHeight;
        resultText = bodyEl.textContent;
      } else if (msg.type === "done") {
        if (msg.text) {
          bodyEl.textContent = msg.text;
          resultText = msg.text;
        }
        statusEl.textContent = "";
        busy = false;
      } else if (msg.type === "aborted") {
        statusEl.textContent = "已停止";
        busy = false;
      } else if (msg.type === "error") {
        bodyEl.textContent = msg.message || "请求失败";
        resultText = "";
        statusEl.textContent = "出错";
        busy = false;
      }
    });
    port.onDisconnect.addListener(function () {
      busy = false;
      if (panel && !panel.hidden && statusEl.textContent === "生成中…") statusEl.textContent = "连接已断开";
    });
    port.postMessage({
      type: "quick",
      action: action,
      selection: currentText,
      page: { title: page.title || document.title, url: page.url || location.href, text: page.text || "" },
    });
  }

  function copy(text) {
    if (!text) return;
    var done = function () { showToast("已复制"); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(fallbackCopy);
    } else {
      fallbackCopy();
    }
    function fallbackCopy() {
      try {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.style.cssText = "position:fixed;opacity:0;left:-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
        done();
      } catch (e) {
        showToast("复制失败");
      }
    }
  }

  function saveExcerpt(text, note) {
    if (!text) {
      showToast("没有可保存的内容");
      return;
    }
    try {
      var p = chrome.runtime.sendMessage({
        type: "pp.saveExcerpt",
        item: { text: text, note: note || "", title: document.title, url: location.href, createdAt: Date.now() },
      });
      if (p && typeof p.then === "function") {
        p.then(function (res) {
          showToast(res && res.ok ? "已存摘录" : "保存失败");
        }).catch(function () {
          showToast("保存失败");
        });
      } else {
        showToast("已存摘录");
      }
    } catch (e) {
      showToast("保存失败");
    }
    hidePanel();
  }

  function loadSettings() {
    try {
      chrome.storage.local.get("settings", function (data) {
        var s = (data && data.settings) || {};
        settings.bubbleEnabled = s.bubbleEnabled !== false;
        if (!settings.bubbleEnabled) hideBar();
      });
    } catch (e) { /* ignore */ }
  }

  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== "local" || !changes.settings) return;
      var s = changes.settings.newValue || {};
      settings.bubbleEnabled = s.bubbleEnabled !== false;
      if (!settings.bubbleEnabled) hideBar();
    });
  } catch (e) { /* ignore */ }

  document.addEventListener("mouseup", schedule, true);
  document.addEventListener("keyup", schedule, true);
  document.addEventListener("selectionchange", schedule, true);

  document.addEventListener("mousedown", function (e) {
    if (!host) return;
    var path = e.composedPath ? e.composedPath() : [];
    if (path.indexOf(host) >= 0) return;
    if (!busy) hideAll();
  }, true);

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") hideAll();
  }, true);

  window.addEventListener("scroll", function () {
    if (!busy) hideBar();
  }, true);

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg !== "object") return false;

    if (msg.type === "pp.context") {
      var data;
      try {
        data = window.PPTextLib.extractFromDocument(document);
      } catch (e) {
        data = { title: document.title, url: location.href, text: "", chars: 0, paragraphs: 0 };
      }
      data.ok = true;
      data.isPdf = /\.pdf($|[?#])/i.test(location.href);
      sendResponse(data);
      return false;
    }

    if (msg.type === "pp.selectionNow") {
      sendResponse({ ok: true, text: currentSelection() });
      return false;
    }

    return false;
  });

  loadSettings();
})();
