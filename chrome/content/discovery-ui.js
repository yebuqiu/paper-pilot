// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 文献发现对话框（0.24.0）
 * 列表直接读 Discovery 的按天缓存；只有点「刷新推荐」才发网络请求。
 */
/* global window, document */

(function () {
  const XHTML = "http://www.w3.org/1999/xhtml";
  const args = (window.arguments && window.arguments[0]) || {};
  const Z = args.Zotero || (window.opener && window.opener.Zotero);
  const PP = Z && Z.Papilot;
  const zh = !!(Z && (Z.locale || "").toLowerCase().startsWith("zh"));
  const PREFIX = "extensions.zotero.papilot.";

  const $ = (id) => document.getElementById(id);
  const listEl = $("pp-dc-list");
  const statusEl = $("pp-dc-status");
  const sumEl = $("pp-dc-sum");

  if (!PP || !PP.discovery) {
    if (statusEl) statusEl.textContent = zh ? "错误：无法访问 Papilot 模块" : "Error: Papilot unavailable";
    return;
  }
  const D = PP.discovery;

  const pget = (k, d) => {
    try { const v = Z.Prefs.get(PREFIX + k, true); return v === undefined || v === null ? d : v; } catch (e) { return d; }
  };
  const pset = (k, v) => { try { Z.Prefs.set(PREFIX + k, v, true); } catch (e) { /* ignore */ } };

  let data = { items: [], generatedAt: "", scope: "" };
  let running = false;
  const expanded = new Set();

  function el(tag, css, text) {
    const n = document.createElementNS(XHTML, tag);
    if (css) n.style.cssText = css;
    if (text != null) n.textContent = text;
    return n;
  }

  function setStatus(t, err) {
    statusEl.textContent = t || "";
    statusEl.style.color = err ? "var(--accent-red,#c0392b)" : "var(--fill-secondary,#666)";
  }

  function openUrl(url) {
    if (!url) return;
    try { Z.launchURL(url); } catch (e) {
      try { Z.getMainWindow().Zotero.launchURL(url); } catch (e2) {
        try { window.open(url); } catch (e3) { /* ignore */ }
      }
    }
  }

  function when(iso) {
    return String(iso || "").replace("T", " ").slice(0, 16) || "-";
  }

  function card(e, idx) {
    const box = el("div", "padding:9px 10px;border:1px solid var(--fill-quinary,#eee);border-radius:8px;margin-bottom:8px;background:var(--material-surface,#fff);");
    const top = el("div", "display:flex;align-items:flex-start;gap:8px;");
    const left = el("div", "flex:1;min-width:0;");
    const a = el("a", "font-weight:600;font-size:13.5px;color:var(--color-accent,#2563eb);cursor:pointer;text-decoration:none;");
    a.textContent = (idx + 1) + ". " + (e.title || "(无标题)");
    a.addEventListener("click", () => openUrl(e.link));
    left.appendChild(a);
    left.appendChild(el("div", "color:var(--fill-secondary,#777);font-size:11.5px;margin-top:3px;",
      (e.authors || []).slice(0, 5).join(", ") + ((e.authors || []).length > 5 ? " et al." : "") +
      " ｜ " + String(e.published || "").slice(0, 10) +
      " ｜ " + (e.categories || []).join(", ") + " ｜ arXiv:" + e.arxivId));
    if (e.reasons && e.reasons.length) {
      left.appendChild(el("div", "font-size:11px;margin-top:2px;color:var(--color-accent,#2563eb);",
        (zh ? "命中画像：" : "matched: ") + e.reasons.slice(0, 8).join(", ")));
    }
    if (e.comment) {
      left.appendChild(el("div", "font-size:11px;margin-top:2px;color:var(--fill-tertiary,#999);",
        (zh ? "作者注：" : "comment: ") + String(e.comment).slice(0, 160)));
    }
    const abst = el("div", "font-size:12px;margin-top:4px;color:var(--fill-secondary,#666);line-height:1.55;");
    const full = String(e.summary || "");
    abst.textContent = expanded.has(e.arxivId) ? full : full.slice(0, 320) + (full.length > 320 ? " …" : "");
    if (full.length > 320) {
      const t = el("a", "font-size:11px;color:var(--color-accent,#2563eb);cursor:pointer;margin-left:4px;");
      t.textContent = expanded.has(e.arxivId) ? (zh ? "收起" : "less") : (zh ? "展开" : "more");
      t.addEventListener("click", () => {
        if (expanded.has(e.arxivId)) expanded.delete(e.arxivId); else expanded.add(e.arxivId);
        render();
      });
      abst.appendChild(t);
    }
    left.appendChild(abst);
    top.appendChild(left);

    const right = el("div", "display:flex;flex-direction:column;gap:4px;align-items:flex-end;min-width:86px;");
    right.appendChild(el("span", "font-size:11.5px;font-weight:700;color:var(--accent-green,#1f8b4c);",
      (zh ? "相关度 " : "score ") + e.score));
    const bOpen = el("button", "font-size:11px;padding:2px 10px;cursor:pointer;", zh ? "打开" : "Open");
    bOpen.addEventListener("click", () => openUrl(e.link));
    const bPdf = el("button", "font-size:11px;padding:2px 10px;cursor:pointer;", "PDF");
    bPdf.addEventListener("click", () => openUrl(e.pdfLink));
    const bAdd = el("button", "font-size:11px;padding:2px 10px;cursor:pointer;", zh ? "收藏到库" : "Collect");
    bAdd.addEventListener("click", async () => {
      bAdd.disabled = true;
      bAdd.textContent = zh ? "收藏中…" : "…";
      try {
        const r = await D.collect(e);
        bAdd.textContent = zh ? "✓ 已收藏" : "✓ done";
        if (r && r.collection) {
          setStatus((zh ? "已收藏并加入分类「" : "Collected into \"") + r.collection.name + (zh ? "」：" : "\": ") + (e.title || "").slice(0, 50));
        } else if (r && r.colError) {
          setStatus((zh ? "条目已建，但加入分类失败：" : "Item created but adding to collection failed: ") + r.colError, true);
        } else {
          setStatus((zh ? "已收藏：" : "Collected: ") + (e.title || "").slice(0, 50));
        }
      } catch (err) {
        bAdd.disabled = false;
        bAdd.textContent = zh ? "收藏到库" : "Collect";
        setStatus((zh ? "收藏失败：" : "Collect failed: ") + ((err && err.message) || err), true);
      }
    });
    const bNo = el("button", "font-size:11px;padding:2px 10px;cursor:pointer;", zh ? "忽略" : "Ignore");
    bNo.addEventListener("click", () => { D.ignore(e.arxivId); render(); });
    right.appendChild(bOpen);
    right.appendChild(bPdf);
    right.appendChild(bAdd);
    right.appendChild(bNo);
    top.appendChild(right);

    box.appendChild(top);
    return box;
  }

  function render() {
    listEl.textContent = "";
    // 推荐与库内兴趣毫无重合时（只命中分类）显式告警，不给出「看起来正常的无用清单」
    if (data.note) {
      listEl.appendChild(el("div",
        "padding:9px 11px;margin-bottom:8px;border:1px solid var(--accent-orange,#d9822b);border-radius:8px;" +
        "color:var(--accent-orange,#d9822b);font-size:12.5px;line-height:1.6;background:transparent;",
        "⚠️ " + data.note));
    }
    const ignored = D.ignoredSet();
    const items = (data.items || []).filter((e) => !ignored.has(e.arxivId));
    if (!items.length) {
      listEl.appendChild(el("div", "padding:10px;color:var(--fill-tertiary,#999);", zh
        ? "还没有推荐。点右上角「刷新推荐」拉取 arXiv 最新提交（需要联网）。"
        : "No recommendations yet. Click “Refresh” to fetch from arXiv."));
      sumEl.textContent = "";
      return;
    }
    const shown = items.slice(0, 60);
    shown.forEach((e, i) => listEl.appendChild(card(e, i)));
    sumEl.textContent = (zh ? "显示 " : "Shown ") + shown.length + (zh ? " / 共 " : " / ") + items.length +
      (zh ? " 条 ｜ 基线时间 " : " ｜ generated ") + when(data.generatedAt) +
      (data.scope ? " ｜ " + data.scope : "");
  }

  async function refresh() {
    if (running) return;
    running = true;
    const cats = String($("pp-dc-cats").value || "").trim();
    pset("discoveryCategories", cats);
    const btn = $("pp-dc-run");
    btn.disabled = true;
    setStatus(zh ? "正在拉取 arXiv（首次可能要十几秒）…" : "Fetching arXiv…");
    try {
      const r = await D.run();
      if (!r.ok) { setStatus(r.reason || (zh ? "刷新失败" : "Refresh failed"), true); }
      else {
        data = D.loadCache();
        render();
        setStatus((zh ? "已更新：拉到 " : "Updated: fetched ") + r.fetched + (zh ? " 篇，筛出推荐 " : " / recommended ") + r.count + (zh ? " 篇" : ""));
      }
    } catch (e) {
      setStatus((zh ? "刷新失败：" : "Refresh failed: ") + ((e && e.message) || e), true);
    }
    btn.disabled = false;
    running = false;
  }

  async function saveNote() {
    const ignored = D.ignoredSet();
    const list = { generatedAt: data.generatedAt, scope: data.scope, items: (data.items || []).filter((e) => !ignored.has(e.arxivId)) };
    if (!list.items.length) { setStatus(zh ? "还没有推荐可保存" : "Nothing to save", true); return; }
    try {
      await D.saveListAsNote(list);
      setStatus(zh ? "已存为库级笔记" : "Saved as a note");
    } catch (e) {
      setStatus((zh ? "保存失败：" : "Save failed: ") + ((e && e.message) || e), true);
    }
  }

  /* ---- 初始化 ---- */
  try {
    $("pp-dc-cats").value = String(pget("discoveryCategories", "cs.AI, cs.CL, cs.LG"));
    $("pp-dc-daily").checked = pget("discoveryEnabled", false) === true;
  } catch (e) { /* ignore */ }

  $("pp-dc-run").addEventListener("click", refresh);
  $("pp-dc-note").addEventListener("click", saveNote);
  $("pp-dc-close").addEventListener("click", () => window.close());
  $("pp-dc-daily").addEventListener("change", (ev) => {
    pset("discoveryEnabled", !!ev.target.checked);
    setStatus(ev.target.checked ? (zh ? "已开启每日自动刷新（Zotero 运行期间每天一次）" : "Daily refresh on") : (zh ? "已关闭每日自动刷新" : "Daily refresh off"));
  });
  $("pp-dc-clear-ignored").addEventListener("click", () => {
    pset("discoveryIgnored", "[]");
    setStatus(zh ? "已恢复全部被忽略的推荐" : "Ignored list cleared");
    render();
  });

  data = D.loadCache();
  render();
  setStatus(data.generatedAt
    ? (zh ? "上次刷新：" : "Last refresh: ") + when(data.generatedAt)
    : (zh ? "尚未刷新过" : "Never refreshed"));
})();
