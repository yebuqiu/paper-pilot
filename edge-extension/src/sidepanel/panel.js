// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 侧边栏交互层：页面上下文、划词、动作、流式回答、PDF 解析、导出。 */

import { getSettings, resolveProvider, providerLabel } from "../lib/settings.js";
import { buildMessages, buildParagraphTranslation, ACTION_META, estimateChars } from "../lib/prompts.js";
import { pickParagraphs, paragraphsChars } from "../lib/paragraphs.js";
import { normalizeExcerpt, excerptToMarkdown } from "../lib/excerpts.js";
import { parseGlossary, checkGlossary } from "../lib/glossary.js";

const $ = (id) => document.getElementById(id);

const state = {
  settings: null,
  page: null,
  selection: "",
  messages: [],
  busy: false,
  port: null,
  tabId: null,
  nextId: 1,
  pdfPages: 0,
  view: "chat",
  excerpts: [],
  compare: { items: [], running: false, abort: false, port: null, done: 0 },
};

let renderTick = 0;

/* ==================== 基础渲染 ==================== */

function escapeHtml(input) {
  return String(input || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderBlocks(text) {
  const fences = [];
  let s = String(text || "").replace(/```(\w*)\r?\n([\s\S]*?)```/g, (m, lang, code) => {
    fences.push("<pre><code>" + escapeHtml(code.trim()) + "</code></pre>");
    return "\u0000" + (fences.length - 1) + "\u0000";
  });

  s = escapeHtml(s);
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");

  const lines = s.split(/\r?\n/);
  const out = [];
  let mode = "";
  let buf = [];

  const flush = () => {
    if (!buf.length) {
      mode = "";
      return;
    }
    if (mode === "ul") out.push("<ul>" + buf.join("") + "</ul>");
    else if (mode === "ol") out.push("<ol>" + buf.join("") + "</ol>");
    else if (mode === "p") out.push("<p>" + buf.join("<br>") + "</p>");
    buf = [];
    mode = "";
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flush();
      continue;
    }
    if (/^#{1,4}\s+/.test(line)) {
      flush();
      out.push("<h4>" + line.replace(/^#{1,4}\s+/, "") + "</h4>");
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      if (mode !== "ul") flush();
      mode = "ul";
      buf.push("<li>" + line.replace(/^[-*]\s+/, "") + "</li>");
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      if (mode !== "ol") flush();
      mode = "ol";
      buf.push("<li>" + line.replace(/^\d+\.\s+/, "") + "</li>");
      continue;
    }
    if (mode === "ul" || mode === "ol") flush();
    mode = "p";
    buf.push(line);
  }
  flush();

  let html = out.join("");
  html = html.replace(/\u0000(\d+)\u0000/g, (m, i) => fences[Number(i)] || "");
  return html;
}

function messageEl(msg) {
  const wrap = document.createElement("div");
  wrap.className = "msg " + (msg.role === "user" ? "user" : "assistant") + (msg.error ? " error" : "");
  wrap.dataset.id = String(msg.id);
  const label = document.createElement("div");
  label.className = "msg-label";
  label.textContent = msg.role === "user" ? "你" : (msg.error ? "出错" : "Papilot");
  const body = document.createElement("div");
  body.className = "msg-body";
  const tools = document.createElement("div");
  tools.className = "msg-tools";
  if (msg.role === "assistant" && !msg.error) {
    const copy = document.createElement("button");
    copy.textContent = "复制";
    copy.addEventListener("click", () => copyText(msg.content));
    const save = document.createElement("button");
    save.textContent = "存摘录";
    save.addEventListener("click", () => saveExcerptItem(msg.content, ""));
    tools.append(copy, save);
  }
  wrap.append(label, body, tools);
  return wrap;
}

function paintMessage(el, msg) {
  const body = el.querySelector(".msg-body");
  if (!body) return;
  body.innerHTML = msg.content ? renderBlocks(msg.content) : (msg.streaming ? "" : "<p>（空）</p>");
  if (msg.error) body.textContent = msg.content;
  el.classList.toggle("streaming", !!msg.streaming);
}

function renderAll() {
  const box = $("messages");
  box.innerHTML = "";
  if (!state.messages.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.innerHTML =
      '<p class="empty-title">把论文读薄一点</p>' +
      "<p>1. 在学术页面点「读取本页」<br>2. 选中不懂的句子，点「解释选中」<br>3. 读完让「本页摘要」给你四段式卡片</p>" +
      '<p class="empty-note">首次使用请先在设置里配置模型或登录 Papilot 账号。</p>';
    box.appendChild(empty);
    return;
  }
  for (const msg of state.messages) {
    const el = messageEl(msg);
    paintMessage(el, msg);
    box.appendChild(el);
  }
  scrollToBottom();
}

function updateOne(msg) {
  const el = $("messages").querySelector('.msg[data-id="' + msg.id + '"]');
  if (!el) {
    renderAll();
    return;
  }
  paintMessage(el, msg);
}

function scrollToBottom() {
  const box = $("messages");
  box.scrollTop = box.scrollHeight;
}

function throttlePaint(msg) {
  if (renderTick) return;
  renderTick = requestAnimationFrame(() => {
    renderTick = 0;
    updateOne(msg);
    scrollToBottom();
  });
}

/* ==================== 状态与提示 ==================== */

function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 1600);
}

function hint(text) {
  $("hint").textContent = text || "";
}

function refreshBanner() {
  const banner = $("banner");
  if (!state.settings) return;
  const p = resolveProvider(state.settings);
  if (p.ok) {
    banner.classList.add("hidden");
  } else {
    const text =
      p.reason === "not_logged_in" ? "尚未登录 Papilot，也没填自己的 API Key" :
      p.reason === "expired" ? "登录已过期，需要重新登录" :
      "尚未配置模型";
    $("banner-text").textContent = text;
    banner.classList.remove("hidden");
  }
  $("status").textContent = providerLabel(state.settings) + (state.page ? " · " + state.page.chars + " 字" : "");
}

function updatePageUI() {
  const page = state.page;
  if (!page) {
    $("page-title").textContent = "尚未读取页面";
    $("ctx-meta").textContent = "在论文页面点击「读取本页」，或直接选中文字提问。";
    $("pdf-row").classList.add("hidden");
  } else {
    $("page-title").textContent = page.title || "未命名页面";
    const bits = [];
    if (page.isPdf) bits.push("PDF" + (state.pdfPages ? " · " + state.pdfPages + " 页" : ""));
    if (page.chars) bits.push("已读取 " + page.chars.toLocaleString() + " 字");
    if (page.paragraphs) bits.push(page.paragraphs + " 段");
    if (!page.chars) bits.push("未取得正文");
    $("ctx-meta").textContent = bits.join(" · ");
    $("pdf-row").classList.toggle("hidden", !(page.isPdf && !page.chars));
  }
  refreshBanner();
}

function updateSelectionUI() {
  const card = $("selection-card");
  const text = state.selection || "";
  if (!text) {
    card.classList.add("hidden");
    $("sel-preview").textContent = "";
    return;
  }
  card.classList.remove("hidden");
  $("sel-count").textContent = String(text.length);
  $("sel-preview").textContent = text;
}

/* ==================== 会话持久化 ==================== */

let saveTimer = null;
function saveSession() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const payload = {
      page: state.page,
      messages: state.messages.filter((m) => !m.streaming).slice(-40),
      savedAt: Date.now(),
    };
    chrome.storage.local.set({ session: payload }).catch(() => {});
  }, 400);
}

async function restoreSession() {
  try {
    const { session } = await chrome.storage.local.get("session");
    if (!session) return;
    if (session.page) state.page = session.page;
    if (Array.isArray(session.messages)) {
      state.messages = session.messages.map((m) => ({ ...m, id: state.nextId++ }));
    }
    updatePageUI();
    renderAll();
  } catch (e) { /* ignore */ }
}

/* ==================== 页面上下文 ==================== */

function tabQuery() {
  return chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((tabs) => tabs[0] || null);
}

function sendToTab(tabId, msg) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, msg, (resp) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(resp || null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

async function ensureInjected(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/lib/text.js", "src/content/selection.js"],
    });
    return true;
  } catch (e) {
    return false;
  }
}

async function readPage(opts) {
  const silent = !!(opts && opts.silent);
  const tab = await tabQuery();
  if (!tab || !tab.id) {
    if (!silent) toast("没有活动标签页");
    return false;
  }
  state.tabId = tab.id;

  // PDF 直接用标签页地址判定：Edge 内置 PDF 查看器无法注入内容脚本
  const tabUrl = tab.url || "";
  if (/\.pdf($|[?#])/i.test(tabUrl)) {
    let name = "PDF 文档";
    try {
      const last = tabUrl.split("?")[0].split("#")[0].split("/").pop();
      if (last) name = decodeURIComponent(last).replace(/\.pdf$/i, "");
    } catch (e) { /* 保留默认名 */ }
    state.page = { title: name, url: tabUrl, text: "", chars: 0, paragraphs: 0, isPdf: true };
    updatePageUI();
    saveSession();
    return true;
  }

  let ctx = await sendToTab(tab.id, { type: "pp.context" });
  if (!ctx && !silent) {
    hint("正在读取页面…");
    const ok = await ensureInjected(tab.id);
    if (ok) ctx = await sendToTab(tab.id, { type: "pp.context" });
    hint("");
  }
  if (!ctx) {
    if (!silent) {
      $("ctx-meta").textContent = "无法读取此页面。若是站外页面，请点一下工具栏图标重新授予访问权限。";
    }
    return false;
  }

  const isPdf = ctx.isPdf || /\.pdf($|[?#])/i.test(ctx.url || "");
  state.page = {
    title: ctx.title || "",
    url: ctx.url || (tab.url || ""),
    text: isPdf ? "" : (ctx.text || ""),
    chars: isPdf ? 0 : (ctx.chars || 0),
    paragraphs: ctx.paragraphs || 0,
    isPdf: isPdf,
  };
  state.pdfPages = 0;
  updatePageUI();
  saveSession();

  if (isPdf) {
    $("pdf-row").classList.remove("hidden");
    if (!silent) toast("检测到 PDF，点「解析 PDF 全文」");
    return true;
  }
  if (!state.page.chars && !silent) {
    $("ctx-meta").textContent = "页面已识别，但没抽到正文（可能是扫描版或需要登录）。";
  }
  return true;
}

/* ==================== PDF 解析 ==================== */

function pdfLinesFromContent(content) {
  const items = (content.items || []).filter((i) => i && typeof i.str === "string" && i.str.trim());
  const rows = [];
  for (const item of items) {
    const y = item.transform ? item.transform[5] : 0;
    const x = item.transform ? item.transform[4] : 0;
    let row = rows.find((r) => Math.abs(r.y - y) <= 2.6);
    if (!row) {
      row = { y: y, items: [] };
      rows.push(row);
    }
    row.items.push({ x: x, str: item.str });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows
    .map((r) => r.items.sort((a, b) => a.x - b.x).map((i) => i.str).join(" ").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

async function parsePdfBuffer(buffer, url, fallbackTitle) {
  const lib = window.pdfjsLib;
  if (!lib) throw new Error("PDF 组件未加载");
  lib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("src/vendor/pdfjs/pdf.worker.min.js");

  const task = lib.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: true,
  });
  const doc = await task.promise;
  try {
    const maxPages = Math.min(doc.numPages, 40);
    const chunks = [];
    let total = 0;
    for (let i = 1; i <= maxPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = pdfLinesFromContent(content);
      if (text) {
        chunks.push(text);
        total += text.length;
      }
      page.cleanup();
      if (total > 60000) break;
    }

    let title = fallbackTitle || "";
    try {
      const meta = await doc.getMetadata();
      const info = meta && meta.info ? meta.info : {};
      if (info.Title && String(info.Title).trim().length > 2) title = String(info.Title).trim();
    } catch (e) { /* metadata 不可用 */ }

    const text = chunks.join("\n\n").slice(0, 60000);
    state.pdfPages = doc.numPages;
    state.page = {
      title: title || "PDF 文档",
      url: url || "",
      text: text,
      chars: text.length,
      paragraphs: chunks.length,
      isPdf: true,
    };
    updatePageUI();
    saveSession();
    return text;
  } finally {
    try { await doc.destroy(); } catch (e) { /* ignore */ }
  }
}

async function parsePdfFromUrl(url) {
  if (!url) {
    toast("没有 PDF 地址");
    return;
  }
  hint("正在下载 PDF…");
  $("btn-pdf").disabled = true;
  try {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const buffer = await res.arrayBuffer();
    hint("正在解析 PDF（" + Math.round(buffer.byteLength / 1024) + " KB）…");
    await parsePdfBuffer(buffer, url, state.page && state.page.title);
    toast("已解析 " + state.pdfPages + " 页");
  } catch (e) {
    $("ctx-meta").textContent = "无法读取该 PDF（可能需要登录或权限）。可先把 PDF 下载到本地，再拖进这个面板。";
    toast("PDF 解析失败");
  } finally {
    hint("");
    $("btn-pdf").disabled = false;
  }
}

/* ==================== 发送 ==================== */

function ensureReady() {
  const p = resolveProvider(state.settings || {});
  if (p.ok) return true;
  refreshBanner();
  toast("请先配置模型或登录");
  return false;
}

function addMessage(role, content, extra) {
  const msg = { id: state.nextId++, role: role, content: content, ...extra };
  state.messages.push(msg);
  const el = messageEl(msg);
  paintMessage(el, msg);
  const empty = $("messages").querySelector(".empty");
  if (empty) empty.remove();
  $("messages").appendChild(el);
  scrollToBottom();
  return msg;
}

function setBusy(busy) {
  state.busy = busy;
  const btn = $("send");
  btn.textContent = busy ? "停止" : "发送";
  btn.classList.toggle("stop", busy);
  document.querySelectorAll(".chip").forEach((c) => { c.disabled = busy; });
}

function glossaryTerms() {
  try {
    return parseGlossary((state.settings && state.settings.glossary) || "");
  } catch (e) {
    return [];
  }
}

function askAI(messages, userLabel, kind) {
  addMessage("user", userLabel, { kind: kind || "action" });
  const assistant = addMessage("assistant", "", { streaming: true });
  setBusy(true);
  hint("已发送约 " + estimateChars(messages).toLocaleString() + " 字");

  let port;
  try {
    port = chrome.runtime.connect({ name: "pp-ai" });
  } catch (e) {
    assistant.streaming = false;
    assistant.error = true;
    assistant.content = "无法连接后台服务，请重新加载扩展。";
    updateOne(assistant);
    setBusy(false);
    return;
  }
  state.port = port;

  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "delta") {
      assistant.content += msg.text;
      throttlePaint(assistant);
    } else if (msg.type === "done") {
      assistant.streaming = false;
      if (msg.text) assistant.content = msg.text;
      updateOne(assistant);
      finishRun(assistant);
    } else if (msg.type === "aborted") {
      assistant.streaming = false;
      assistant.content += "\n\n（已停止）";
      updateOne(assistant);
      finishRun(assistant);
    } else if (msg.type === "error") {
      assistant.streaming = false;
      assistant.error = true;
      assistant.content = msg.message || "请求失败";
      updateOne(assistant);
      finishRun(assistant);
      if (msg.code) refreshBanner();
    }
  });

  port.onDisconnect.addListener(() => {
    if (assistant.streaming) {
      assistant.streaming = false;
      updateOne(assistant);
      finishRun(assistant);
    }
  });

  try {
    port.postMessage({ type: "chat", messages: messages });
  } catch (e) {
    assistant.streaming = false;
    assistant.error = true;
    assistant.content = "后台连接已断开，请重新打开面板再试。";
    updateOne(assistant);
    finishRun(assistant);
  }
}

function finishRun(assistant) {
  state.port = null;
  setBusy(false);
  hint("");
  const terms = glossaryTerms();
  if (terms.length && assistant.content) {
    const result = checkGlossary(terms, assistant.content);
    if (result.missing.length) {
      hint("术语未按表出现：" + result.missing.join("、"));
    }
  }
  saveSession();
}

async function runAction(action) {
  if (state.busy) return;
  if (!ensureReady()) return;
  const meta = ACTION_META[action];

  if (meta.needsSelection && !state.selection) {
    const chip = document.querySelector('.chip[data-action="' + action + '"]');
    if (chip) {
      chip.classList.add("shake");
      setTimeout(() => chip.classList.remove("shake"), 320);
    }
    toast("请先在页面上选中一段文字");
    return;
  }

  if (!meta.needsSelection && (!state.page || !state.page.text)) {
    const ok = await readPage({ silent: false });
    if (!ok || !state.page || !state.page.text) {
      toast(state.page && state.page.isPdf ? "请先解析 PDF 全文" : "请先读取本页正文");
      return;
    }
  }

  let messages;
  try {
    messages = buildMessages({
      action: action,
      selection: state.selection,
      page: state.page,
      glossary: glossaryTerms(),
      lang: (state.settings && state.settings.outputLang) || "zh",
      maxContextChars: (state.settings && state.settings.maxContextChars) || 18000,
    });
  } catch (e) {
    toast(e.message);
    return;
  }

  let label;
  if (action === "explain") label = "解释选中：" + short(state.selection, 80);
  else if (action === "translate") label = "翻译选中：" + short(state.selection, 80);
  else if (action === "summarize") label = "本页摘要";
  else if (action === "critique") label = "评估创新与局限";
  else label = "追问";
  askAI(messages, label, "action");
}

function short(text, max) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/** 追问带最近几轮；动作类请求会被跳过，避免上一轮的格式影响本轮。 */
function historyForAsk() {
  const out = [];
  let skip = false;
  for (const m of state.messages) {
    if (!m.content || m.error || m.streaming) continue;
    if (m.role === "user") {
      skip = m.kind === "action";
      if (skip) continue;
    }
    if (skip) continue;
    out.push({ role: m.role, content: m.content });
  }
  return out.slice(-6);
}

function askQuestion() {
  const input = $("input");
  const q = input.value.trim();
  if (!q) return;
  if (state.busy) return;
  if (!ensureReady()) return;

  if (!state.page || !state.page.text) {
    if (!state.selection) {
      toast("请先读取本页，或选中一段文字再提问");
      return;
    }
  }

  let messages;
  try {
    messages = buildMessages({
      action: "ask",
      question: q,
      selection: state.selection,
      page: state.page,
      glossary: glossaryTerms(),
      lang: (state.settings && state.settings.outputLang) || "zh",
      maxContextChars: (state.settings && state.settings.maxContextChars) || 18000,
      history: historyForAsk(),
    });
  } catch (e) {
    toast(e.message);
    return;
  }

  input.value = "";
  autosize();
  askAI(messages, q, "ask");
}

/* ==================== 导出 / 复制 ==================== */

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text || "");
    toast("已复制");
  } catch (e) {
    toast("复制失败");
  }
}

function exportMarkdown() {
  if (!state.messages.length) {
    toast("还没有内容可导出");
    return;
  }
  const lines = [];
  if (state.page) {
    lines.push("# " + (state.page.title || "阅读笔记"));
    if (state.page.url) lines.push(state.page.url);
    lines.push("");
  }
  for (const msg of state.messages) {
    if (!msg.content) continue;
    lines.push(msg.role === "user" ? "## 问" : "## 答");
    lines.push(msg.content);
    lines.push("");
  }
  const base = (state.page && state.page.title ? state.page.title : "papilot").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 60);
  downloadText(base + "-笔记.md", lines.join("\n"));
}

function downloadText(filename, text) {
  const blob = new Blob([String(text || "")], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = String(filename || "papilot.md").replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ==================== 事件绑定 ==================== */

function autosize() {
  const el = $("input");
  el.style.height = "auto";
  el.style.height = Math.min(120, el.scrollHeight) + "px";
}

/* ==================== 视图切换 ==================== */

function switchView(name) {
  state.view = name;
  for (const btn of document.querySelectorAll(".view-tabs button")) {
    btn.setAttribute("aria-selected", String(btn.dataset.view === name));
  }
  for (const id of ["view-chat", "view-compare", "view-excerpts"]) {
    $(id).classList.toggle("hidden", id !== "view-" + name);
  }
  if (name === "excerpts") loadExcerpts();
  if (name === "compare") updateCompareProgress();
}

/* ==================== 摘录本 ==================== */

function fmtDate(ts) {
  try { return new Date(ts).toLocaleDateString("zh-CN"); } catch (e) { return ""; }
}

function updateExcerptBadge() {
  const n = state.excerpts.length;
  const badge = $("excerpt-count");
  badge.textContent = String(n);
  badge.classList.toggle("has", n > 0);
  $("ex-count-label").textContent = n + " 条";
}

function renderExcerpts() {
  updateExcerptBadge();
  const box = $("ex-list");
  box.innerHTML = "";
  if (!state.excerpts.length) {
    const p = document.createElement("p");
    p.className = "view-hint";
    p.textContent = "还没有摘录。选中文字后点页内气泡的「存摘录」。";
    box.appendChild(p);
    return;
  }

  for (const item of state.excerpts) {
    const card = document.createElement("div");
    card.className = "ex-item";

    const text = document.createElement("div");
    text.className = "ex-text";
    text.textContent = item.text;
    card.appendChild(text);

    if (item.note) {
      const note = document.createElement("div");
      note.className = "ex-note";
      note.textContent = item.note;
      card.appendChild(note);
    }

    const meta = document.createElement("div");
    meta.className = "ex-meta";
    const title = document.createElement("span");
    title.className = "spacer";
    title.textContent = (item.title || "未命名") + " · " + fmtDate(item.createdAt);
    const copy = document.createElement("button");
    copy.textContent = "复制";
    copy.addEventListener("click", () => copyText(item.text));
    const del = document.createElement("button");
    del.textContent = "删除";
    del.addEventListener("click", () => deleteExcerpt(item.id));
    meta.append(title, copy, del);
    card.appendChild(meta);

    box.appendChild(card);
  }
}

async function loadExcerpts() {
  try {
    const stored = await chrome.storage.local.get("excerpts");
    state.excerpts = Array.isArray(stored.excerpts) ? stored.excerpts : [];
  } catch (e) {
    state.excerpts = [];
  }
  renderExcerpts();
}

async function saveExcerptItem(text, note, title, url) {
  const item = normalizeExcerpt({
    text: text,
    note: note || "",
    title: title || (state.page && state.page.title) || "",
    url: url || (state.page && state.page.url) || "",
  });
  if (!item) {
    toast("没有可保存的内容");
    return;
  }
  try {
    const res = await chrome.runtime.sendMessage({ type: "pp.saveExcerpt", item });
    if (res && res.ok) {
      toast("已存摘录");
      await loadExcerpts();
    } else {
      toast((res && res.error) || "保存失败");
    }
  } catch (e) {
    toast("保存失败");
  }
}

async function deleteExcerpt(id) {
  state.excerpts = state.excerpts.filter((x) => x.id !== id);
  await chrome.storage.local.set({ excerpts: state.excerpts });
  renderExcerpts();
}

async function clearExcerpts() {
  if (!state.excerpts.length) return;
  if (!window.confirm("清空全部摘录？导出后再清空可以保留内容。")) return;
  state.excerpts = [];
  await chrome.storage.local.set({ excerpts: [] });
  renderExcerpts();
}

function exportExcerpts() {
  if (!state.excerpts.length) {
    toast("还没有摘录");
    return;
  }
  downloadText("papilot-excerpts.md", excerptToMarkdown(state.excerpts));
}

/* ==================== 整页对照 ==================== */

function compareParagraphs() {
  return pickParagraphs((state.page && state.page.text) || "", { maxItems: 20 });
}

function updateCompareProgress() {
  const list = state.compare.items;
  const total = list.length;
  if (!total) {
    $("cmp-progress").textContent = "未开始";
    return;
  }
  const done = list.filter((x) => x.status === "done").length;
  const chars = paragraphsChars(list.map((x) => x.src));
  $("cmp-progress").textContent = done + "/" + total + " 段 · 原文约 " + chars.toLocaleString() + " 字";
}

function renderCompare() {
  const box = $("cmp-list");
  box.innerHTML = "";
  if (!state.compare.items.length) {
    const p = document.createElement("p");
    p.className = "view-hint";
    p.textContent = "点「翻译本页」开始。只翻译有正文的段落，最多 20 段。";
    box.appendChild(p);
    updateCompareProgress();
    return;
  }

  state.compare.items.forEach((item, i) => {
    const row = document.createElement("div");
    row.className = "cmp-row";
    row.dataset.i = String(i);

    const src = document.createElement("div");
    src.className = "cmp-src";
    src.textContent = item.src;
    const dst = document.createElement("div");
    dst.className = "cmp-dst" + (item.status === "pending" ? " pending" : item.status === "error" ? " err" : "");
    dst.textContent = item.dst || (item.status === "pending" ? "…" : "");
    const tools = document.createElement("div");
    tools.className = "cmp-tools";
    const copy = document.createElement("button");
    copy.textContent = "复制译文";
    copy.addEventListener("click", () => copyText(item.dst));
    tools.appendChild(copy);

    row.append(src, dst, tools);
    box.appendChild(row);
  });
  updateCompareProgress();
}

function updateCompareRow(index, text, status) {
  const row = $("cmp-list").querySelector('.cmp-row[data-i="' + index + '"]');
  if (!row) return;
  const dst = row.querySelector(".cmp-dst");
  if (!dst) return;
  dst.textContent = text;
  dst.classList.toggle("pending", status === "pending");
  dst.classList.toggle("err", status === "error");
}

function streamOne(messages, onDelta) {
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = chrome.runtime.connect({ name: "pp-ai" });
    } catch (e) {
      reject(new Error("后台未就绪"));
      return;
    }
    state.compare.port = port;
    let full = "";
    let settled = false;

    const cleanup = () => {
      if (settled) return false;
      settled = true;
      state.compare.port = null;
      try { port.disconnect(); } catch (e) { /* ignore */ }
      return true;
    };

    port.onMessage.addListener((msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "delta") {
        full += msg.text;
        if (typeof onDelta === "function") onDelta(msg.text, full);
      } else if (msg.type === "done") {
        const text = msg.text || full;
        if (cleanup()) resolve(text);
      } else if (msg.type === "aborted") {
        if (cleanup()) resolve(full);
      } else if (msg.type === "error") {
        if (cleanup()) reject(new Error(msg.message || "请求失败"));
      }
    });

    port.onDisconnect.addListener(() => {
      if (!settled) {
        settled = true;
        state.compare.port = null;
        resolve(full);
      }
    });

    port.postMessage({ type: "chat", messages: messages });
  });
}

function setCompareRunning(running) {
  state.compare.running = running;
  $("btn-cmp-start").disabled = running;
  $("btn-cmp-stop").classList.toggle("hidden", !running);
}

async function startCompare() {
  if (state.compare.running) return;
  if (!ensureReady()) return;

  if (!state.page || !state.page.text) {
    const ok = await readPage({ silent: false });
    if (!ok || !state.page || !state.page.text) {
      toast(state.page && state.page.isPdf ? "请先解析 PDF 全文" : "请先读取本页正文");
      return;
    }
  }

  const paragraphs = compareParagraphs();
  if (!paragraphs.length) {
    toast("没有找到可翻译的段落");
    return;
  }

  state.compare.items = paragraphs.map((src) => ({ src: src, dst: "", status: "pending" }));
  state.compare.done = 0;
  state.compare.abort = false;
  state.compare.cache = state.compare.cache || new Map();
  renderCompare();
  setCompareRunning(true);
  hint("对照翻译中，可点「停止」");

  const glossary = glossaryTerms();
  const lang = (state.settings && state.settings.outputLang) || "zh";

  for (let i = 0; i < state.compare.items.length; i++) {
    if (state.compare.abort) break;
    const item = state.compare.items[i];
    const cached = state.compare.cache.get(item.src);
    if (cached) {
      item.dst = cached;
      item.status = "done";
      updateCompareRow(i, cached, "done");
      updateCompareProgress();
      continue;
    }

    item.status = "running";
    try {
      const messages = buildParagraphTranslation(item.src, { glossary: glossary, lang: lang });
      const text = await streamOne(messages, (delta, full) => {
        item.dst = full;
        updateCompareRow(i, full, "running");
      });
      if (state.compare.abort && !text) {
        item.status = "pending";
        updateCompareRow(i, "", "pending");
        break;
      }
      item.dst = text;
      item.status = "done";
      state.compare.cache.set(item.src, text);
      updateCompareRow(i, text || "（空）", "done");
    } catch (e) {
      item.status = "error";
      item.dst = e && e.message ? e.message : "翻译失败";
      updateCompareRow(i, item.dst, "error");
      break;
    } finally {
      updateCompareProgress();
    }
  }

  setCompareRunning(false);
  hint("");
  if (state.compare.abort) toast("已停止，可稍后继续");
}

function stopCompare() {
  state.compare.abort = true;
  if (state.compare.port) {
    try { state.compare.port.postMessage({ type: "abort" }); } catch (e) { /* ignore */ }
  }
}

function exportCompare() {
  if (!state.compare.items.length) {
    toast("还没有对照内容");
    return;
  }
  const lines = ["# 对照：" + ((state.page && state.page.title) || "阅读材料"), ""];
  for (const item of state.compare.items) {
    if (!item.dst) continue;
    lines.push("**原文**", item.src, "", "**译文**", item.dst, "", "---", "");
  }
  downloadText("papilot-compare.md", lines.join("\n"));
}


function bind() {
  $("btn-settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("banner-action").addEventListener("click", () => chrome.runtime.openOptionsPage());

  document.querySelectorAll(".view-tabs button").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });

  $("btn-read").addEventListener("click", () => readPage({ silent: false }));

  $("btn-pdf").addEventListener("click", async () => {
    let url = state.page && state.page.url;
    if (!url) {
      const tab = await tabQuery();
      url = tab && tab.url;
    }
    await parsePdfFromUrl(url);
  });

  document.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => runAction(chip.dataset.action));
  });

  $("sel-clear").addEventListener("click", () => {
    state.selection = "";
    updateSelectionUI();
  });

  $("sel-save").addEventListener("click", () => {
    if (!state.selection) {
      toast("先选中一段文字");
      return;
    }
    saveExcerptItem(state.selection, "");
  });

  $("btn-cmp-start").addEventListener("click", () => startCompare());
  $("btn-cmp-stop").addEventListener("click", stopCompare);
  $("btn-cmp-export").addEventListener("click", exportCompare);
  $("btn-ex-export").addEventListener("click", exportExcerpts);
  $("btn-ex-clear").addEventListener("click", clearExcerpts);

  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    if (state.busy) {
      if (state.port) state.port.postMessage({ type: "abort" });
      return;
    }
    askQuestion();
  });

  $("input").addEventListener("input", autosize);
  $("input").addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      askQuestion();
    }
  });

  $("btn-export").addEventListener("click", exportMarkdown);
  $("btn-clear").addEventListener("click", () => {
    if (!state.messages.length) return;
    if (!window.confirm("清空当前会话？导出后再清空可以保留内容。")) return;
    state.messages = [];
    renderAll();
    saveSession();
  });

  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || msg.type !== "pp.selection") return;
    // 只接受当前活动标签页的划词，避免多标签互相覆盖
    if (sender && sender.tab && state.tabId && sender.tab.id !== state.tabId) return;
    const text = String(msg.text || "");
    if (!state.page && (msg.title || msg.url)) {
      state.page = { title: msg.title || "", url: msg.url || "", text: "", chars: 0, paragraphs: 0, isPdf: false };
      updatePageUI();
    }
    if (text === state.selection) return;
    state.selection = text;
    updateSelectionUI();
  });

  chrome.tabs.onActivated.addListener(async (info) => {
    state.tabId = info && info.tabId ? info.tabId : state.tabId;
    state.selection = "";
    state.page = null;
    updateSelectionUI();
    updatePageUI();
    await readPage({ silent: true });
  });

  document.addEventListener("dragover", (e) => { e.preventDefault(); });
  document.addEventListener("drop", async (e) => {
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    e.preventDefault();
    if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name || "")) {
      toast("只支持 PDF 文件");
      return;
    }
    hint("正在读取本地 PDF…");
    try {
      const buffer = await file.arrayBuffer();
      await parsePdfBuffer(buffer, "", file.name.replace(/\.pdf$/i, ""));
      toast("已解析 " + state.pdfPages + " 页");
    } catch (err) {
      toast("解析失败");
    } finally {
      hint("");
    }
  });
}

/* ==================== 启动 ==================== */

async function init() {
  bind();
  state.settings = await getSettings();
  refreshBanner();
  updatePageUI();
  updateSelectionUI();
  renderAll();
  switchView("chat");
  await loadExcerpts();
  await restoreSession();
  const ok = await readPage({ silent: true });
  if (!ok) {
    // 静默读取失败（站外页面 / 需要授权）时丢弃上次会话的页面上下文，避免拿旧正文作答
    state.page = null;
    state.selection = "";
    updatePageUI();
    updateSelectionUI();
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) {
    state.settings = changes.settings.newValue || state.settings;
    refreshBanner();
  }
  if (area === "local" && changes.excerpts) {
    state.excerpts = Array.isArray(changes.excerpts.newValue) ? changes.excerpts.newValue : [];
    renderExcerpts();
  }
});

init().catch((e) => {
  try { $("ctx-meta").textContent = "初始化失败：" + (e && e.message ? e.message : e); } catch (err) { /* ignore */ }
});
