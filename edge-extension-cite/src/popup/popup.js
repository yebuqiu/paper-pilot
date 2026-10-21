// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 弹窗：读取当前页元数据 → 归一 → （可选 Crossref 补全）→ 五种格式 → 复制。 */

import { normalizeRecord, applyCrossref, normalizeDoi } from "../lib/record.js";
import { FORMATS, formatAll } from "../lib/format.js";

const $ = (id) => document.getElementById(id);
const DEFAULTS = { defaultFormat: "gbt", closeAfterCopy: false };

const state = {
  record: null,
  formats: {},
  format: "gbt",
  closeAfterCopy: false,
  crossref: false,
};

/** 注入到页面执行；必须是自包含函数（不能引用模块作用域）。 */
function extractPageData() {
  const clean = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const meta = {};
  const authors = [];

  document.querySelectorAll("meta").forEach((m) => {
    const key = (m.getAttribute("name") || m.getAttribute("property") || "").toLowerCase();
    if (!key) return;
    const content = m.getAttribute("content") || "";
    if (!content) return;
    if (key === "citation_author" || key === "dc.creator" || key === "dc.creator.personalname") {
      authors.push(content);
      return;
    }
    if (!(key in meta)) meta[key] = content;
  });

  const jsonld = [];
  document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
    try {
      const data = JSON.parse(s.textContent);
      const push = (x) => { if (x && typeof x === "object") jsonld.push(x); };
      if (Array.isArray(data)) data.forEach(push);
      else if (data && Array.isArray(data["@graph"])) data["@graph"].forEach(push);
      else push(data);
    } catch (e) { /* 非法 JSON-LD 忽略 */ }
  });

  const url = location.href;
  const arxivMatch = url.match(/arxiv\.org\/(?:abs|pdf)\/([^?#]+?)(?:\.pdf)?(?:[?#]|$)/i);
  const pmidMatch = url.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/);
  const bodyText = document.body ? String(document.body.innerText || "").slice(0, 40000) : "";
  const doiMatch = bodyText.match(/\b10\.\d{4,9}\/[^\s"'<>]+/);

  return {
    url: url,
    pageTitle: document.title,
    lang: document.documentElement.lang || "",
    arxivId: arxivMatch ? decodeURIComponent(arxivMatch[1]).replace(/v\d+$/, "") : "",
    doiFromText: doiMatch ? doiMatch[0].replace(/[.,;:)\]}]+$/, "") : "",
    meta: {
      title: meta["citation_title"] || meta["dc.title"] || meta["og:title"] || "",
      authors: authors,
      journal: meta["citation_journal_title"] || "",
      conference: meta["citation_conference_title"] || "",
      volume: meta["citation_volume"] || "",
      issue: meta["citation_issue"] || "",
      firstpage: meta["citation_firstpage"] || "",
      lastpage: meta["citation_lastpage"] || "",
      date: meta["citation_publication_date"] || meta["citation_date"] || meta["dc.date"] || "",
      year: meta["citation_year"] || "",
      doi: meta["citation_doi"] || "",
      issn: meta["citation_issn"] || "",
      isbn: meta["citation_isbn"] || "",
      publisher: meta["citation_publisher"] || "",
      place: meta["citation_place"] || "",
      type: meta["citation_publication_type"] || meta["dc.type"] || "",
      abstract: meta["citation_abstract"] || meta["dc.description"] || "",
      pmid: meta["citation_pmid"] || (pmidMatch ? pmidMatch[1] : ""),
      language: meta["citation_language"] || "",
    },
    jsonld: jsonld,
  };
}

function setStatus(text, kind) {
  const el = $("status");
  el.textContent = text || "";
  el.className = "status" + (kind ? " " + kind : "");
}

function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 1500);
}

function showError(message) {
  $("error").textContent = message;
  $("error").classList.remove("hidden");
  $("output").classList.add("hidden");
  $("formats").classList.add("hidden");
  $("btn-copy").disabled = true;
  $("paper-title").textContent = "未能生成引文";
  $("paper-meta").textContent = "";
  $("source-badge").textContent = "读取失败";
}

function buildTabs() {
  const box = $("formats");
  box.innerHTML = "";
  for (const f of FORMATS) {
    const btn = document.createElement("button");
    btn.className = "tab";
    btn.type = "button";
    btn.textContent = f.label;
    btn.dataset.id = f.id;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", String(f.id === state.format));
    btn.addEventListener("click", () => selectFormat(f.id));
    box.appendChild(btn);
  }
}

function selectFormat(id) {
  state.format = id;
  for (const btn of document.querySelectorAll(".tab")) {
    btn.setAttribute("aria-selected", String(btn.dataset.id === id));
  }
  const text = state.formats[id] || "";
  $("output").textContent = text;
  $("btn-copy").disabled = !text;
  setStatus(text ? text.length + " 字符" : "该格式信息不足");
}

function render() {
  const rec = state.record;
  if (!rec || !rec.title) {
    showError("没有识别到文献信息。请在期刊详情页、PubMed 或 arXiv 摘要页使用；只有 PDF 的页面请先打开它的摘要页。");
    return;
  }

  $("error").classList.add("hidden");
  $("output").classList.remove("hidden");
  $("formats").classList.remove("hidden");
  $("paper-title").textContent = rec.title;

  const bits = [];
  if (rec.container) bits.push(rec.container);
  if (rec.year) bits.push(rec.year);
  if (rec.authors && rec.authors.length) {
    const a = rec.authors[0];
    bits.push(a.literal || [a.family, a.given].filter(Boolean).join(" "));
    if (rec.authors.length > 1) bits.push("等 " + rec.authors.length + " 人");
  }
  if (rec.doi) bits.push("DOI " + rec.doi);
  $("paper-meta").textContent = bits.filter(Boolean).join(" · ");

  $("source-badge").textContent = state.crossref ? "页面 + Crossref 补全" : "页面元数据";
  buildTabs();
  selectFormat(state.formats[state.format] ? state.format : "gbt");
}

async function enrich(record) {
  if (!record.doi) return record;
  const needs = !record.container || !record.year || !record.authors.length || !record.pages;
  if (!needs) return record;
  try {
    const res = await fetch("https://api.crossref.org/works/" + encodeURIComponent(record.doi), {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return record;
    const data = await res.json();
    if (!data || !data.message) return record;
    state.crossref = true;
    return applyCrossref(record, data.message);
  } catch (e) {
    return record;
  }
}

async function load() {
  setStatus("正在读取页面…");
  $("error").classList.add("hidden");
  $("output").classList.remove("hidden");
  $("formats").classList.remove("hidden");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error("没有活动标签页");
    const injected = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractPageData });
    const raw = injected && injected[0] && injected[0].result;
    if (!raw) throw new Error("页面没有返回数据");

    let record = normalizeRecord(raw);
    record = await enrich(record);

    state.record = record;
    state.formats = formatAll(record);
    const saved = await chrome.storage.local.get("settings");
    const settings = { ...DEFAULTS, ...(saved.settings || {}) };
    state.closeAfterCopy = !!settings.closeAfterCopy;
    if (FORMATS.some((f) => f.id === settings.defaultFormat)) state.format = settings.defaultFormat;

    render();
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    const friendly = /Cannot access|chrome:\/\/|extension:\/\/|showing error page/i.test(msg)
      ? "无法读取此页面（浏览器内部页或 PDF 阅读器）。请在论文详情页使用。"
      : "读取失败：" + msg;
    showError(friendly);
  }
}

async function copy() {
  const text = state.formats[state.format] || "";
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制");
    setStatus("已复制 " + text.length + " 字符");
    if (state.closeAfterCopy) setTimeout(() => window.close(), 220);
  } catch (e) {
    try {
      const pre = $("output");
      const range = document.createRange();
      range.selectNodeContents(pre);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand("copy");
      toast("已复制");
    } catch (err) {
      toast("复制失败，请手动选中");
    }
  }
}

function bind() {
  $("btn-settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("btn-copy").addEventListener("click", copy);
  $("btn-reread").addEventListener("click", load);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") window.close();
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") copy();
  });
}

bind();
load();
