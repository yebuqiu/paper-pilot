// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 设置窗格脚本 · 检索订阅 v2（0.58.0）
 *
 * 交互模型（五步，任何一步失败都不阻断其余功能）：
 *   ⓿ 期刊：内置 500+ 种期刊目录（18 个学科、中文别名），输入即过滤；目录外自动查
 *      OpenAlex Sources（3 万+ 刊）；勾选/点「订阅」即建订阅（ISSN 自动带出，不用查地址）
 *   ① 推荐：扫描库内画像 → 3 张可解释的主题卡（含「追踪作者」）→ [预览] / [创建] / [忽略]
 *   ② 一句话：AI 只做「描述 → 检索条件」的翻译，结果填进表单（不创建、不入库）
 *   ③ 试跑：preview 只取数不入库、不记账；结果卡上可 [收藏]（入库 + 记为感兴趣）
 *      或 [忽略]（记 -1，之后标「已忽略」并跳过）
 *   ④ 保存/运行：列表里可暂停、编辑、看历史；运行时显示 +N 新入库 / M 跳过
 *
 * 集成方在 prefs.xhtml 里提供的节点（缺任何一个都不会炸，只是那块不渲染）：
 *   期刊：#pp-sub-journal-q / #pp-sub-journal-search / #pp-sub-journal-msg
 *         / #pp-sub-journal-subjects / #pp-sub-journal-list / #pp-sub-journal-subscribe
 *         / #pp-sub-journal-sel
 *   推荐：#pp-subs-reco / #pp-subs-reco-refresh / #pp-subs-reco-msg
 *   一句话：#pp-sub-nl / #pp-sub-ai / #pp-sub-nl-msg
 *   列表：#pp-subs-list / #pp-subs-detail / #pp-subs-export / #pp-subs-import
 *         / #pp-subs-feedback-clear（清空收藏/忽略学习）
 *   表单：#pp-sub-name / -keywords / -cats / -authors / -exclude / -journals / -journals-clear
 *         / -mode / -freq / -time / -weekdays / -maxagedays / -max / -src-arxiv / -src-openalex
 *         / -src-crossref / -src-pubmed / -src-europepmc / -auto / -notify / -ai-rerank / -ai-digest
 *         / -seed / #pp-subs-add / #pp-subs-preview / #pp-subs-cancel / #pp-sub-msg
 *
 * ⚠️ Zotero 先加载脚本、后插入 fragment DOM —— init 必须探测 #pp-subs-list，
 *    不存在就延迟重试（同 prefs-schedule.js / prefs-agent.js 纪律）。
 * ⚠️ 动态生成的节点一律经变量持有，不用 $(…) 取动态节点（check-wiring 守卫）。
 * 0.72.2 设计修复：AI 回填后自动展开「更多条件」details + 反馈槽 aria-live。
 */
/* global Zotero, Services, window, document */

(function () {
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const MAX_ROWS = 50;
  const SOURCES = [
    { id: "arxiv", label: "arXiv", el: "pp-sub-src-arxiv" },
    { id: "openalex", label: "OpenAlex", el: "pp-sub-src-openalex" },
    { id: "crossref", label: "Crossref", el: "pp-sub-src-crossref" },
    { id: "europepmc", label: "Europe PMC", el: "pp-sub-src-europepmc" },
    { id: "pubmed", label: "PubMed", el: "pp-sub-src-pubmed" },
  ];
  const $ = (id) => document.getElementById(id);
  const S = () => ((typeof Zotero !== "undefined" && Zotero.Papilot && Zotero.Papilot.searchSubs) || null);
  // 0.71.0 订阅落地桥（库内分类 + 原生 RSS）：模块缺位时按钮自己降级成提示，不报错
  const B = () => ((typeof Zotero !== "undefined" && Zotero.Papilot && Zotero.Papilot.subsBridge) || null);

  let editingId = "";
  let pendingDraft = null;
  let recoItems = [];
  let recoLoading = false;

  // 期刊订阅（0.69.0）
  let journalRows = [];            // 当前结果（未按学科过滤）
  let journalTotal = 0;            // 本次查询的命中总数（journalRows 只取前 200 条，
                                   // 提示「共 N 种」必须用总数，否则默认列表会错报「共 200 种」）
  let journalSubject = "";         // 学科筛选（"" = 全部）
  let journalQuery = "";           // 上一次搜索词（换词时自动回到「全部」学科）
  let journalSelected = new Map(); // issn → item（批量订阅）
  let journalTimer = null;
  let journalBusy = false;
  let journalAutoTried = "";       // 已自动在线补搜过的词（同一个词只补一次）
  let editIssns = [];              // 编辑中的订阅自带 ISSN（表单只展示，不手填）
  let editJournals = [];

  const el = (tag, attrs, text) => {
    const node = document.createElementNS(HTML_NS, tag);
    if (attrs) for (const k of Object.keys(attrs)) {
      if (attrs[k] === undefined || attrs[k] === null) continue;
      if (k === "style") node.style.cssText = attrs[k];
      else node.setAttribute(k, attrs[k]);
    }
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  };

  function setMsg(id, text, tone) {
    const node = $(id);
    if (!node) return;
    node.textContent = text || "";
    node.style.color = tone === "bad" ? "var(--pp-danger)" : tone === "good" ? "var(--pp-success)" : "var(--pp-muted)";
  }

  function openUrl(url) {
    const u = String(url || "").trim();
    if (!u) return;
    try { Zotero.launchURL(u); }
    catch (e) {
      try { Zotero.getMainWindow().Zotero.launchURL(u); } catch (e2) { /* ignore */ }
    }
  }

  function confirmDelete(name) {
    try {
      if (typeof Services !== "undefined" && Services && Services.prompt &&
        typeof Services.prompt.confirm === "function") {
        return !!Services.prompt.confirm(window, "删除订阅", "确定删除订阅「" + name + "」？");
      }
    } catch (e) { /* 走「直接删」 */ }
    return true;
  }

  function srcLabel(sub) {
    const ids = Array.isArray(sub && sub.sources) && sub.sources.length ? sub.sources : ["arxiv"];
    return ids.map((id) => {
      const hit = SOURCES.filter((s) => s.id === id)[0];
      return hit ? hit.label : id;
    }).join(" + ");
  }

  function condLine(sub) {
    const parts = [];
    if (sub.keywords) {
      const mode = sub.mode === "any" ? "任一" : sub.mode === "phrase" ? "短语" : "全部";
      parts.push("关键词：" + sub.keywords + "（" + mode + "）");
    }
    if (sub.categories) parts.push("分类：" + sub.categories);
    if (sub.authors) parts.push("作者：" + sub.authors);
    if (sub.exclude) parts.push("排除：" + sub.exclude);
    if (sub.maxAgeDays) parts.push("近 " + sub.maxAgeDays + " 天");
    return parts.length ? parts.join(" · ") : "（未设置检索条件）";
  }

  function weekLabel(list) {
    const names = ["一", "二", "三", "四", "五", "六", "日"];
    return (Array.isArray(list) ? list : []).map((n) => names[n - 1] || "").join("");
  }

  function freqLabel(sub) {
    if (sub.freq === "weekly") return "每周 " + (weekLabel(sub.weekdays) || "一至五") + " " + (sub.dailyTime || "08:00");
    if (sub.freq === "daily") return "每日 " + (sub.dailyTime || "08:00");
    return "仅手动";
  }

  function reasonText(r) {
    const reason = (r && r.reason) || "";
    if (reason === "no_arxiv") return "arXiv 模块未就绪";
    if (reason === "network") return "网络或解析失败";
    if (reason === "empty") return "没有命中结果";
    if (reason === "no_sub") return "订阅不存在";
    if (reason === "no_query") return "缺少检索条件";
    if (reason === "busy") return "上一次运行尚未结束";
    if (reason === "no_ai") return "AI 未配置";
    if (reason === "ai_failed") return "AI 调用失败";
    if (reason === "parse_failed") return "AI 返回无法解析";
    return reason || "未知错误";
  }

  /** 导入 / 导出失败原因 → 可读文案（error 也可能是异常字符串） */
  function clipReason(r) {
    const err = (r && r.error) || "";
    if (err === "clipboard_empty") return "剪贴板里没有文本，先复制一份订阅 JSON";
    if (err === "clipboard_write_failed") return "无法写入剪贴板（检查系统剪贴板权限后重试）";
    if (err === "parse_failed") return "剪贴板内容不是合法的 JSON";
    if (err === "bad_shape") return "JSON 结构不认识（需要 {kind:\"searchSubscriptions\"} 包裹或裸数组）";
    if (err === "empty") return "内容为空";
    if (err === "write_failed") return "写入订阅失败（本地配置不可写）";
    return err || "未知错误";
  }

  function statusText(status) {
    if (status === "new") return "新命中";
    if (status === "seen") return "往期已见";
    if (status === "known") return "已在库";
    if (status === "ignored") return "已忽略";
    return status || "";
  }

  /* ================== 列表行 ================== */

  function buildRow(sub) {
    const row = el("div", {
      class: "pp-row pp-subs-row",
      "data-sub": sub.id,
      style: "align-items:flex-start;border-bottom:1px solid var(--pp-border);padding:8px 0;margin-top:0;flex-wrap:wrap;",
    });

    const head = el("div", { style: "flex:1 1 100%;display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;" });
    const toggle = el("input", { type: "checkbox", title: sub.enabled ? "暂停订阅" : "启用订阅" });
    toggle.checked = sub.enabled !== false;
    toggle.addEventListener("change", () => {
      const s = S();
      if (!s || typeof s.update !== "function") return;
      const ok = !!s.update(sub.id, { enabled: !!toggle.checked });
      setMsg("pp-sub-msg", ok ? (toggle.checked ? "已启用：" : "已暂停：") + sub.name : "状态保存失败", ok ? "good" : "bad");
      renderList();
    });
    head.appendChild(toggle);
    head.appendChild(el("span", { style: "font-weight:600;" }, sub.name || "（未命名）"));
    head.appendChild(el("span", { class: "pp-hint", style: "border:1px solid var(--pp-border);border-radius:6px;padding:0 5px;" }, srcLabel(sub)));
    head.appendChild(el("span", { class: "pp-hint pp-subs-spec" }, condLine(sub)));
    head.appendChild(el("span", { class: "pp-hint pp-subs-time" }, freqLabel(sub)));
    head.appendChild(el("span", { class: "pp-hint pp-subs-last", title: "最近 5 次运行可在「历史」里查看" },
      "上次：" + (sub.lastStatus || sub.lastRun || "未运行")));
    row.appendChild(head);

    const bar = el("div", { style: "flex:1 1 100%;display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;" });
    const msg = el("span", { class: "pp-hint pp-subs-msg", style: "flex:1 1 100%;", "aria-live": "polite" });

    const btnPreview = el("button", { class: "pp-btn pp-btn-sm pp-subs-preview" }, "预览");
    btnPreview.addEventListener("click", () => doPreview(sub.id, null));

    const btnRun = el("button", { class: "pp-btn pp-btn-sm pp-subs-run" }, "立即运行");
    btnRun.addEventListener("click", async () => {
      const s = S();
      if (!s || typeof s.run !== "function") {
        msg.textContent = "检索订阅模块未就绪（请重启 Zotero 后再试）";
        msg.style.color = "var(--pp-danger)";
        return;
      }
      btnRun.disabled = true;
      msg.textContent = "运行中…";
      msg.style.color = "var(--pp-muted)";
      let line = "";
      let tone = "muted";
      try {
        const r = await s.run(sub.id, { trigger: "manual" });
        if (r && r.ok) {
          line = "+" + (r.added || 0) + " 新入库 / " + (r.skipped || 0) + " 跳过"
            + (r.failed ? " / " + r.failed + " 失败" : "") + (r.noteTitle ? " · 已生成速递" : "");
          tone = "good";
        } else {
          line = "未完成：" + reasonText(r);
          tone = "bad";
        }
      } catch (e) {
        line = "运行失败：" + ((e && (e.message || e)) || e);
        tone = "bad";
      } finally {
        btnRun.disabled = !S();
        // 先刷新列表（更新「上次」与历史），再把结果写到表单提示位——
        // 写在行内会被 renderList 替换掉（0.57.0 真机自查发现的消息丢失）
        renderList();
        setMsg("pp-sub-msg", "「" + (sub.name || "") + "」" + line, tone);
      }
    });

    const btnHist = el("button", { class: "pp-btn pp-btn-sm pp-subs-hist" }, "历史");
    const histBox = el("div", { class: "pp-hint", style: "display:none;flex:1 1 100%;padding:4px 0 0 2px;line-height:1.7;" });
    btnHist.addEventListener("click", () => {
      const open = histBox.style.display !== "none";
      histBox.style.display = open ? "none" : "block";
      if (open) return;
      while (histBox.firstChild) histBox.removeChild(histBox.firstChild);
      const log = Array.isArray(sub.runLog) ? sub.runLog : [];
      if (!log.length) {
        histBox.appendChild(el("div", null, "还没有运行记录。"));
        return;
      }
      for (const r of log) {
        histBox.appendChild(el("div", null,
          (r.at || "-") + " · +" + (r.added || 0) + " 入库 / " + (r.skipped || 0) + " 跳过"
          + (r.failed ? " / " + r.failed + " 失败" : "")
          + (r.trigger ? " · " + (r.trigger === "manual" ? "手动" : r.trigger === "weekly" ? "每周" : "每日") : "")
          + (r.reason ? " · " + reasonText(r) : "")));
      }
    });

    const btnEdit = el("button", { class: "pp-btn pp-btn-sm pp-subs-edit" }, "编辑");
    btnEdit.addEventListener("click", () => {
      fillForm(sub);
      editingId = sub.id;
      const title = $("pp-subs-form-title");
      if (title) title.textContent = "编辑订阅：" + sub.name;
      const cancel = $("pp-subs-cancel");
      if (cancel) cancel.style.display = "";
      const anchor = $("pp-subs-form-title");
      if (anchor && anchor.scrollIntoView) {
        try { anchor.scrollIntoView({ block: "center" }); } catch (e) { /* ignore */ }
      }
      setMsg("pp-sub-msg", "正在编辑「" + sub.name + "」，保存后生效。");
    });

    const btnDel = el("button", { class: "pp-btn pp-btn-sm pp-subs-del" }, "删除");
    btnDel.addEventListener("click", () => {
      const s = S();
      if (!s || typeof s.remove !== "function") {
        msg.textContent = "检索订阅模块未就绪（请重启 Zotero 后再试）";
        msg.style.color = "var(--pp-danger)";
        return;
      }
      if (!confirmDelete(sub.name || "")) return;
      let ok = false;
      try { ok = !!s.remove(sub.id); } catch (e) { ok = false; }
      if (ok) {
        setMsg("pp-sub-msg", "已删除订阅：" + (sub.name || ""), "good");
        if (editingId === sub.id) resetForm();
        renderList();
        // 0.69.1 真机实证：删完只刷「我的订阅」，上面期刊列表里该刊仍显示「已订阅」
        // （按钮 disabled），用户会以为删不掉。这里让两处状态同源。
        try { renderJournals(); } catch (e) { /* 期刊区块未初始化时忽略 */ }
      } else {
        msg.textContent = "删除失败（订阅可能已不存在）";
        msg.style.color = "var(--pp-danger)";
      }
    });

    bar.appendChild(btnPreview);
    bar.appendChild(btnRun);
    bar.appendChild(btnHist);
    bar.appendChild(btnEdit);
    bar.appendChild(btnDel);
    row.appendChild(bar);
    row.appendChild(histBox);
    row.appendChild(msg);
    return row;
  }

  function renderList() {
    const host = $("pp-subs-list");
    if (!host) return;
    while (host.firstChild) host.removeChild(host.firstChild);

    const s = S();
    const moduleReady = !!(s && typeof s.run === "function");
    if (!moduleReady) {
      host.appendChild(el("div", { class: "pp-hint", style: "color:var(--pp-warn);" },
        "检索订阅模块未就绪：订阅数据仍可查看，运行与删除需重启 Zotero 后可用。"));
    }

    let subs = [];
    if (s && typeof s.list === "function") {
      try { subs = s.list() || []; } catch (e) { subs = []; }
    }
    if (!subs.length) {
      host.appendChild(el("div", { class: "pp-hint" }, "还没有订阅：可以从上面的推荐一键创建，或用一句话描述你的方向。"));
      return;
    }
    const shown = subs.slice(0, MAX_ROWS);
    for (const sub of shown) host.appendChild(buildRow(sub));
    if (subs.length > shown.length) {
      host.appendChild(el("div", { class: "pp-hint" }, "共 " + subs.length + " 条订阅，仅显示前 " + MAX_ROWS + " 条。"));
    }
    // 0.71.0 落地状态（只读探测；建分类/RSS 由按钮或订阅流程触发）
    renderBridgeMsg();
  }

  /* ================== 试跑预览 ================== */

  function previewCard(e, idx, subId) {
    const box = el("div", {
      style: "padding:8px 10px;border:1px solid var(--pp-border);border-radius:8px;margin-top:6px;background:var(--pp-surface-2);",
    });
    const top = el("div", { style: "display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap;" });
    const left = el("div", { style: "flex:1;min-width:220px;" });

    const a = el("a", { href: "#", style: "font-weight:600;font-size:13px;" }, (idx + 1) + ". " + (e.title || "(无标题)"));
    a.addEventListener("click", (ev) => { try { ev.preventDefault(); } catch (err) { /* ignore */ } openUrl(e.url); });
    left.appendChild(a);

    const meta = [];
    if (e.source) meta.push(e.source);
    if (e.published) meta.push(String(e.published).slice(0, 10));
    if (e.venue) meta.push(e.venue);
    if (e.citationCount) meta.push("被引 " + e.citationCount);
    if (e.doi) meta.push("DOI:" + e.doi);
    if (e.arxivId) meta.push("arXiv:" + e.arxivId);
    left.appendChild(el("div", { class: "pp-hint", style: "margin-top:2px;" }, meta.join(" · ")));

    if (e.reasons && e.reasons.length) {
      left.appendChild(el("div", { class: "pp-hint", style: "margin-top:2px;color:var(--pp-accent);" },
        "命中：" + e.reasons.slice(0, 6).join(", ")));
    }
    const abs = el("div", { class: "pp-hint", style: "margin-top:3px;line-height:1.55;" },
      String(e.summary || "").replace(/\s+/g, " ").slice(0, 240));
    left.appendChild(abs);
    top.appendChild(left);

    const right = el("div", { style: "display:flex;flex-direction:column;gap:4px;align-items:flex-end;min-width:92px;" });
    right.appendChild(el("span", { class: "pp-hint", style: "font-weight:700;color:" + (e.status === "new" ? "var(--pp-success)" : "var(--pp-muted)") + ";" },
      statusText(e.status)));
    if (e.score) right.appendChild(el("span", { class: "pp-hint" }, "相关度 " + e.score));
    const bOpen = el("button", { class: "pp-btn pp-btn-sm" }, "打开");
    bOpen.addEventListener("click", () => openUrl(e.url));
    right.appendChild(bOpen);
    if (e.pdfUrl) {
      const bPdf = el("button", { class: "pp-btn pp-btn-sm" }, "PDF");
      bPdf.addEventListener("click", () => openUrl(e.pdfUrl));
      right.appendChild(bPdf);
    }
    // 收藏 / 忽略：把「人工判断」沉淀成之后排序与过滤的依据（feedback learning）
    const bAccept = el("button", { class: "pp-btn pp-btn-sm pp-subs-accept", title: "入库并记为感兴趣（之后同类结果排序靠前）" }, "收藏");
    bAccept.addEventListener("click", async () => {
      const s = S();
      if (!s || typeof s.accept !== "function") {
        setMsg("pp-sub-msg", "检索订阅模块未就绪（请重启 Zotero 后再试）", "bad");
        return;
      }
      bAccept.disabled = true;
      let r = null;
      try {
        r = await s.accept(e, subId || null);
      } catch (err) {
        r = { ok: false };
      }
      bAccept.disabled = false;
      if (r && r.ok) {
        setMsg("pp-sub-msg", "已收藏并记为感兴趣：" + (e.title || ""), "good");
      } else {
        setMsg("pp-sub-msg", "收藏失败（条目可能重复或库不可写）", "bad");
      }
    });
    right.appendChild(bAccept);

    const bIgnore = el("button", { class: "pp-btn pp-btn-sm pp-subs-ignore", title: "记为不感兴趣（之后该条目标「已忽略」并从订阅里跳过）" }, "忽略");
    bIgnore.addEventListener("click", () => {
      const s = S();
      if (!s || typeof s.ignoreEntry !== "function") {
        setMsg("pp-sub-msg", "检索订阅模块未就绪（请重启 Zotero 后再试）", "bad");
        return;
      }
      let ok = false;
      try { ok = !!s.ignoreEntry(e, subId || null); } catch (err) { ok = false; }
      if (!ok) {
        setMsg("pp-sub-msg", "忽略失败（条目指纹为空）", "bad");
        return;
      }
      setMsg("pp-sub-msg", "已忽略：" + (e.title || "") + "（之后不再出现在订阅里）", "good");
      // 从本轮预览里移除这张卡（保留结果条数提示不动，避免误导）
      const parent = box.parentNode;
      if (parent && typeof parent.removeChild === "function") {
        try { parent.removeChild(box); } catch (err) { /* ignore */ }
      }
    });
    right.appendChild(bIgnore);
    top.appendChild(right);
    box.appendChild(top);
    return box;
  }

  async function doPreview(input, draft) {
    const s = S();
    const host = $("pp-subs-detail");
    if (!host) return;
    // 收藏 / 忽略要记住「来自哪条订阅」：按 id 预览时写该订阅 id，草稿预览写 null
    const currentSubId = (typeof input === "string" && input) ? input : "";
    if (!s || typeof s.preview !== "function") {
      host.textContent = "";
      host.appendChild(el("div", { class: "pp-hint", style: "color:var(--pp-danger);" }, "检索订阅模块未就绪（请重启 Zotero 后再试）"));
      return;
    }
    pendingDraft = draft || null;
    while (host.firstChild) host.removeChild(host.firstChild);
    host.appendChild(el("div", { class: "pp-hint" }, "试跑中（只取数，不入库）…"));

    let r = null;
    try {
      r = await s.preview(input, { limit: 10 });
    } catch (e) {
      r = { ok: false, reason: "network", entries: [] };
    }
    while (host.firstChild) host.removeChild(host.firstChild);

    const head = el("div", { style: "display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px;" });
    head.appendChild(el("span", { style: "font-weight:600;" }, "试跑结果"));
    head.appendChild(el("span", { class: "pp-hint" }, r.ok ? "（不写订阅、不入库；确认后才会创建/运行时生效）" : ""));
    if (pendingDraft && r.ok) {
      const btnCreate = el("button", { class: "pp-btn pp-btn-primary pp-btn-sm" }, "按此预览创建订阅");
      btnCreate.addEventListener("click", () => {
        const sc = S();
        if (!sc || typeof sc.add !== "function") return;
        const sub = sc.add(pendingDraft);
        if (!sub) {
          setMsg("pp-sub-msg", "创建失败（名称与检索条件必填）", "bad");
          return;
        }
        setMsg("pp-sub-msg", "已创建：" + sub.name + "（可在下方列表编辑频率 / 启停）", "good");
        pendingDraft = null;
        resetForm();
        renderList();
        while (host.firstChild) host.removeChild(host.firstChild);
      });
      head.appendChild(btnCreate);
    }
    const btnClose = el("button", { class: "pp-btn pp-btn-sm" }, "关闭预览");
    btnClose.addEventListener("click", () => {
      pendingDraft = null;
      while (host.firstChild) host.removeChild(host.firstChild);
    });
    head.appendChild(btnClose);
    host.appendChild(head);

    if (!r.ok) {
      host.appendChild(el("div", { class: "pp-hint", style: "color:var(--pp-danger);margin-top:4px;" },
        "预览失败：" + reasonText(r) + (r.reason === "network" ? "（检查网络，或在本卡底部填一个「礼貌邮箱」以提高 OpenAlex / Crossref 配额）" : "")));
      return;
    }

    const entries = r.entries || [];
    const fresh = entries.filter((e) => e.status === "new").length;
    const ignoredCount = entries.filter((e) => e.status === "ignored").length;
    const known = entries.length - fresh - ignoredCount;
    host.appendChild(el("div", { class: "pp-hint", style: "margin-top:2px;" },
      "共 " + entries.length + " 条 · 新命中 " + fresh + " · 已在库/往期 " + known
      + (ignoredCount ? " · 已忽略 " + ignoredCount : "")
      + (r.partial ? " · 部分来源失败" : "")));
    if (r.bySource) {
      const bad = Object.keys(r.bySource).filter((k) => r.bySource[k] && r.bySource[k].ok === false);
      if (bad.length) {
        host.appendChild(el("div", { class: "pp-hint", style: "color:var(--pp-warn);" },
          "失败来源：" + bad.map((k) => k + "（" + (r.bySource[k].reason || "失败") + "）").join("；")));
      }
    }
    if (!entries.length) {
      host.appendChild(el("div", { class: "pp-hint" }, "没有命中。可放宽关键词、去掉分类限制，或把「只看近 N 天」调大。"));
      return;
    }
    entries.forEach((e, i) => host.appendChild(previewCard(e, i, currentSubId)));
  }

  /* ================== 期刊订阅（0.69.0） ==================
   *
   * 这一块的唯一目标：把「订阅一本刊」压缩到「输两个字 → 点订阅」。
   * 目录在 chrome/content/scripts/data/journals.js（525 种 / 18 学科 / 中文别名），
   * 目录外的刊走 OpenAlex Sources 在线检索（3 万+），两条路都不需要用户知道 ISSN 或 RSS。
   */

  function journalMsg(text, tone) {
    setMsg("pp-sub-journal-msg", text, tone);
  }

  function renderJournalSubjects() {
    const host = $("pp-sub-journal-subjects");
    if (!host) return;
    while (host.firstChild) host.removeChild(host.firstChild);
    const s = S();
    let subjects = [];
    try {
      const cat = (s && typeof s.journalCatalog === "function") ? s.journalCatalog() : null;
      subjects = (cat && cat.subjects) || [];
    } catch (e) { subjects = []; }
    const chips = [{ id: "", name: "全部" }].concat(subjects);
    for (const c of chips) {
      const active = journalSubject === c.id;
      const b = el("button", {
        class: "pp-btn pp-btn-sm" + (active ? " pp-btn-primary" : ""),
        style: "padding:2px 8px;font-size:12px;margin-top:0;",
      }, c.name);
      b.addEventListener("click", () => {
        journalSubject = c.id;
        renderJournalSubjects();
        renderJournals();
      });
      host.appendChild(b);
    }
  }

  function updateJournalSel() {
    const btn = $("pp-sub-journal-subscribe");
    const txt = $("pp-sub-journal-sel");
    const n = journalSelected.size;
    if (btn) btn.disabled = n === 0;
    if (txt) txt.textContent = n ? ("已选 " + n + " 种期刊") : "未选择期刊";
  }

  function journalRow(item) {
    const s = S();
    let subscribed = false;
    try {
      subscribed = !!(s && typeof s.journalSubscribed === "function"
        && s.journalSubscribed(item.issn, item.name));
    } catch (e) { subscribed = false; }

    const row = el("div", {
      class: "pp-row pp-subs-jrow",
      style: "align-items:center;gap:8px;border-bottom:1px solid var(--pp-border);padding:6px 0;margin-top:0;flex-wrap:wrap;",
    });
    const cb = el("input", { type: "checkbox", title: subscribed ? "已订阅" : "勾选后一起订阅" });
    cb.checked = journalSelected.has(item.issn);
    cb.disabled = subscribed;
    cb.addEventListener("change", () => {
      if (cb.checked) journalSelected.set(item.issn, item);
      else journalSelected.delete(item.issn);
      updateJournalSel();
    });
    row.appendChild(cb);

    const main = el("div", { style: "flex:1 1 300px;min-width:220px;" });
    main.appendChild(el("span", { style: "font-weight:600;" }, item.name || "(未命名)"));
    const meta = [];
    if (item.subjectName) meta.push(item.subjectName);
    if (item.issn) meta.push("ISSN " + item.issn);
    if (item.publisher) meta.push(item.publisher);
    if (item.online) meta.push("在线检索");
    if (meta.length) main.appendChild(el("span", { class: "pp-hint", style: "margin-left:8px;" }, meta.join(" · ")));
    row.appendChild(main);

    const btn = el("button", { class: "pp-btn pp-btn-sm" + (subscribed ? "" : " pp-btn-primary") },
      subscribed ? "已订阅" : "订阅");
    btn.disabled = subscribed;
    btn.addEventListener("click", () => doSubscribeJournals([item]));
    row.appendChild(btn);
    return row;
  }

  function renderJournals() {
    const host = $("pp-sub-journal-list");
    if (!host) return;
    while (host.firstChild) host.removeChild(host.firstChild);

    let items = journalRows.slice();
    if (journalSubject) items = items.filter((x) => x.subject === journalSubject);
    if (!items.length) {
      host.appendChild(el("div", { class: "pp-hint" },
        journalBusy ? "正在搜索…"
          : "没有匹配的期刊。换个写法（英文全名 / 缩写 / ISSN），或点「在线搜索」到全球 3 万+ 期刊里找。"));
      return;
    }
    const MAX_SHOW = 50;
    const shown = items.slice(0, MAX_SHOW);
    for (const item of shown) host.appendChild(journalRow(item));
    // 提示里的「共 N 种」必须用真实命中数：本地查询 journalRows 只取前 200 条
    // （0.69.0 真机首次打开面板时错报「共 200 种期刊」，实际 525 种）。
    // 按学科筛选时总数为该学科在这批结果里的条数，不能用全局总数。
    const total = journalSubject ? items.length : Math.max(journalTotal, items.length);
    if (total > shown.length) {
      host.appendChild(el("div", { class: "pp-hint" },
        "共 " + total + " 种期刊，先显示前 " + MAX_SHOW + " 种；继续输入可缩小范围。"));
    }
  }

  async function loadJournalList(opts) {
    const o = opts || {};
    const s = S();
    const input = $("pp-sub-journal-q");
    const q = String((input && input.value) || "").trim();
    if (!s || (typeof s.journalFind !== "function" && typeof s.journalSearch !== "function")) {
      journalRows = [];
      journalTotal = 0;
      renderJournals();
      return;
    }
    if (journalBusy && !o.force) return;
    // 换搜索词时回到「全部」学科：否则「选了临床医学 → 搜 Nature」会得到空列表，
    // 用户会以为期刊不存在（真实原因是被学科筛选挡住了）
    if (q !== journalQuery) {
      journalQuery = q;
      if (journalSubject) {
        journalSubject = "";
        renderJournalSubjects();
      }
    }
    journalBusy = true;
    try {
      if (o.online && typeof s.journalSearch === "function") {
        journalMsg("在线检索 3 万+ 期刊中…");
        const r = await s.journalSearch(q, { online: true, limit: 60 });
        journalRows = (r && r.items) || [];
        journalTotal = Math.max(0, parseInt(r && r.total, 10) || journalRows.length);
        if (r && r.online) journalMsg("");
        else {
          journalMsg(journalRows.length
            ? "在线检索暂不可用，先显示本地目录结果"
            : "在线检索暂不可用（检查网络后重试）", journalRows.length ? "" : "bad");
        }
      } else {
        const r = s.journalFind(q, { limit: 200 });
        journalRows = (r && r.items) || [];
        journalTotal = Math.max(0, parseInt(r && r.total, 10) || journalRows.length);
        journalMsg("");
        // 目录里没有 + 至少 2 个字 → 自动到在线库补一次（同一个词只补一次，避免每敲一键都发请求）
        if (!journalRows.length && q.length >= 2 && journalAutoTried !== q
          && typeof s.journalSearch === "function") {
          journalAutoTried = q;
          journalBusy = false;
          return loadJournalList({ online: true, force: true });
        }
      }
    } catch (e) {
      journalRows = [];
      journalTotal = 0;
      journalMsg("期刊检索失败：" + ((e && (e.message || e)) || e), "bad");
    }
    journalBusy = false;
    renderJournals();
    updateJournalSel();
  }

  /** 一键订阅：单条（行内按钮）或批量（订阅所选）。失败原因直接说人话。 */
  function doSubscribeJournals(items) {
    const s = S();
    if (!s || typeof s.subscribeJournals !== "function") {
      journalMsg("检索订阅模块未就绪（请重启 Zotero 后再试）", "bad");
      return;
    }
    let r = null;
    try { r = s.subscribeJournals(items); } catch (e) { r = null; }
    if (!r) {
      journalMsg("订阅失败（本地配置不可写）", "bad");
      return;
    }
    const created = r.created || [];
    const skipped = r.skipped || [];
    if (created.length) {
      const names = created.slice(0, 3).map((x) => x.name).join("、")
        + (created.length > 3 ? " 等 " + created.length + " 种" : "");
      // 「首次会立即补跑」必须写明：调度是「到点后 6 小时内补跑」，下午订阅的刊
      // 会当场抓一次（真机实证：13:53 订阅当场入库 10 条），不提示用户会莫名其妙
      // 看到库里多出一批文章。
      journalMsg("已订阅：" + names + "（每天 08:00 取近 30 天新文章，今天已过点会立即补跑一次；"
        + "可在下方「我的订阅」改成每周或仅手动）", "good");
      journalSelected.clear();
      renderList();
      // 0.71.0：订阅完立刻落到左侧（分类同步建；RSS 逐个试，慢且可能失败，所以不 await 也不挡提示）
      bridgeAfterSubscribe(created);
    } else if (skipped.some((x) => x && x.reason === "exists")) {
      journalMsg("这些期刊已经订阅过了，无需重复添加");
    } else {
      journalMsg("订阅失败（期刊缺少 ISSN 或本地配置不可写）", "bad");
    }
    renderJournals();
    updateJournalSel();
  }

  /* ================== 落地桥（0.71.0）：库内分类 + 原生 RSS ================== */

  /** 当前所有「期刊订阅」（有 ISSN 或刊名；主题订阅不算） */
  function journalSubs() {
    const s = S();
    if (!s || typeof s.list !== "function") return [];
    let subs = [];
    try { subs = s.list() || []; } catch (e) { subs = []; }
    return subs.filter((x) => x && (
      (Array.isArray(x.issns) && x.issns.length) || (Array.isArray(x.journals) && x.journals.length)));
  }

  /**
   * 状态行：几本刊有分类、几个有 RSS。
   * 每条都在 SubsBridge 里只读探测（不建分类、不发请求），所以可以在每次 renderList 里刷。
   */
  function renderBridgeMsg(extra, tone) {
    const node = $("pp-subs-bridge-msg");
    if (!node) return;
    const b = B();
    if (!b || typeof b.status !== "function") {
      node.textContent = "订阅落地模块未就绪（重启 Zotero 后可用）";
      node.style.color = "var(--pp-muted)";
      return;
    }
    const list = journalSubs();
    let st = { total: 0, withCol: 0, withFeed: 0 };
    try { st = b.status(list) || st; } catch (e) { /* 探测失败不影响列表 */ }
    const base = st.total
      ? "期刊订阅 " + st.total + " 本 · 左侧「订阅期刊」分类 " + st.withCol + "/" + st.total
        + " · 左侧【订阅】RSS " + st.withFeed + "/" + st.total
      : "还没有期刊订阅（订阅后会自动建左侧分类）";
    node.textContent = extra ? base + " —— " + extra : base;
    node.style.color = tone === "bad" ? "var(--pp-danger)"
      : tone === "good" ? "var(--pp-success)" : "var(--pp-muted)";
  }

  /** 「同步到左侧面板」：建分类 + 回填历史文章 + 尽力挂 RSS（慢操作，按钮期间禁用） */
  async function doBridgeSync() {
    const b = B();
    const btn = $("pp-subs-bridge");
    if (!b || typeof b.sync !== "function") {
      renderBridgeMsg("模块未就绪，重启 Zotero 后可用", "bad");
      return;
    }
    const subs = journalSubs();
    if (!subs.length) { renderBridgeMsg("没有期刊订阅可同步", "bad"); return; }
    if (btn) btn.disabled = true;
    renderBridgeMsg("正在建分类、回填历史文章（首次可能要十几秒）…");
    let r = null;
    try { r = await b.sync(subs, { feeds: true, backfill: true }); }
    catch (e) { r = null; }
    if (btn) btn.disabled = false;
    if (!r) { renderBridgeMsg("同步失败（详见 Zotero 调试输出）", "bad"); return; }
    const colNew = (r.collections && r.collections.created) || 0;
    const moved = (r.backfill && r.backfill.moved) || 0;
    const feeds = (r.feeds || []).filter((x) => x && x.ok);
    const feedsNew = feeds.filter((x) => !x.existed).length;
    const existed = feeds.length - feedsNew;
    renderBridgeMsg("新建分类 " + colNew + " 个 · 回填文章 " + moved + " 篇 · 左侧【订阅】新增 "
      + feedsNew + " 个源" + (existed > 0 ? "（" + existed + " 个已存在）" : ""), "good");
    renderList();
  }

  /**
   * 订阅成功后自动落地：分类立刻建（毫秒级），RSS 逐个试（每本最多 1~3 个候选地址，
   * 单个候选 12s 超时）。失败不是错误 —— 有些刊（尤其中文刊）本来就没有公开 RSS。
   */
  async function bridgeAfterSubscribe(created) {
    const b = B();
    if (!b || !created || !created.length) return;
    let colMsg = "";
    try {
      const r = await b.ensureCollections(created);
      colMsg = "左侧已建分类 " + ((r && r.created) || 0) + " 个";
    } catch (e) { colMsg = ""; }
    renderBridgeMsg((colMsg ? colMsg + "，" : "") + "正在尝试挂 RSS…");
    let ok = 0;
    for (const sub of created) {
      try {
        const r = await b.ensureFeed(sub);
        if (r && r.ok) ok++;
      } catch (e) { /* 单本失败不影响其它刊 */ }
    }
    renderBridgeMsg(colMsg + (ok
      ? "；左侧【订阅】新增 " + ok + " 个 RSS 源"
      : "；这几本刊暂未找到可用 RSS（库内分类照常可用）"), ok ? "good" : "muted");
    renderList();
  }

  /* ================== 推荐 ================== */

  function recoCard(item) {
    const box = el("div", {
      style: "padding:8px 10px;border:1px solid var(--pp-border);border-radius:8px;margin-top:6px;background:var(--pp-surface-2);",
    });
    box.appendChild(el("div", { style: "font-weight:600;font-size:13px;" }, item.name || "推荐主题"));
    box.appendChild(el("div", { class: "pp-hint", style: "margin-top:2px;" },
      "关键词：" + (item.keywords || "-") + (item.categories ? " · 分类：" + item.categories : "")));
    if (item.authors) {
      box.appendChild(el("div", { class: "pp-hint pp-subs-reco-authors", style: "margin-top:2px;" },
        "作者：" + item.authors));
    }
    box.appendChild(el("div", { class: "pp-hint", style: "margin-top:2px;" }, item.reason || ""));
    if (item.coverage) {
      box.appendChild(el("div", { class: "pp-hint", style: "margin-top:2px;color:var(--pp-accent);" },
        "覆盖库内 " + item.coverage + " 篇" + (item.recent ? " · 近 90 天 " + item.recent + " 篇" : "")));
    }

    const bar = el("div", { style: "display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;" });
    const bPreview = el("button", { class: "pp-btn pp-btn-sm" }, "预览");
    bPreview.addEventListener("click", () => doPreview(item, item));

    const bCreate = el("button", { class: "pp-btn pp-btn-primary pp-btn-sm" }, "直接创建");
    bCreate.addEventListener("click", () => {
      const s = S();
      if (!s || typeof s.add !== "function") return;
      const sub = s.add(item);
      if (!sub) {
        setMsg("pp-subs-reco-msg", "创建失败（名称与检索条件必填）", "bad");
        return;
      }
      setMsg("pp-subs-reco-msg", "已创建：" + sub.name + "（仅手动；可到下方列表编辑为每日/每周）", "good");
      renderList();
    });

    const bIgnore = el("button", { class: "pp-btn pp-btn-sm" }, "忽略");
    bIgnore.addEventListener("click", () => {
      const s = S();
      if (s && typeof s.dismissReco === "function") s.dismissReco(item.id);
      recoItems = recoItems.filter((x) => x.id !== item.id);
      renderReco();
    });

    bar.appendChild(bPreview);
    bar.appendChild(bCreate);
    bar.appendChild(bIgnore);
    box.appendChild(bar);
    return box;
  }

  function renderReco() {
    const host = $("pp-subs-reco");
    if (!host) return;
    while (host.firstChild) host.removeChild(host.firstChild);
    if (recoLoading) {
      host.appendChild(el("div", { class: "pp-hint" }, "正在分析库内文献…（只读本地数据，不联网）"));
      return;
    }
    if (!recoItems.length) {
      host.appendChild(el("div", { class: "pp-hint" },
        "暂无可推荐的主题：库里可分析的文献还太少，或现有订阅已覆盖这些方向。可以先导入一些文献，或在「AI 与翻译 → 研究者画像」写一句研究方向。"));
      return;
    }
    for (const item of recoItems) host.appendChild(recoCard(item));
  }

  async function loadReco(force) {
    const s = S();
    if (!s || typeof s.suggest !== "function") return;
    if (recoLoading) return;
    if (!force && recoItems.length) return;
    recoLoading = true;
    setMsg("pp-subs-reco-msg", force ? "重新分析中…" : "分析中…");
    renderReco();
    try {
      // 12h 缓存：自动加载通常直接复用上次结果；「重新分析我的库」传 force 强制重算
      const list = await s.suggest({ max: 3, force: !!force });
      recoItems = Array.isArray(list) ? list : [];
      const fromCache = typeof s.recoFromCache === "function" ? !!s.recoFromCache() : false;
      if (!recoItems.length) {
        setMsg("pp-subs-reco-msg", "");
      } else if (fromCache) {
        setMsg("pp-subs-reco-msg", "来自最近一次分析（12 小时内）；库里有新文献时点「重新分析我的库」");
      } else if (force) {
        setMsg("pp-subs-reco-msg", "已重新分析：基于库内 " + (recoItems[0].coverage || 0) + "+ 篇文献");
      } else {
        setMsg("pp-subs-reco-msg", "基于库内 " + (recoItems[0].coverage || 0) + "+ 篇文献的方向");
      }
    } catch (e) {
      recoItems = [];
      setMsg("pp-subs-reco-msg", "分析失败：" + ((e && (e.message || e)) || e), "bad");
    }
    recoLoading = false;
    renderReco();
  }

  /* ================== 导出 / 导入（剪贴板） ================== */

  async function doExport() {
    const s = S();
    if (!s || typeof s.exportToClipboard !== "function") {
      setMsg("pp-sub-msg", "检索订阅模块未就绪（请重启 Zotero 后再试）", "bad");
      return;
    }
    let r = null;
    try {
      r = await s.exportToClipboard();
    } catch (e) {
      r = { ok: false, error: String((e && (e.message || e)) || e) };
    }
    if (r && r.ok) {
      setMsg("pp-sub-msg", "已导出 " + (r.count || 0) + " 条订阅到剪贴板（只含配置，不含运行记录）", "good");
    } else {
      setMsg("pp-sub-msg", "导出失败：" + clipReason(r), "bad");
    }
  }

  async function doImport() {
    const s = S();
    if (!s || typeof s.importFromClipboard !== "function") {
      setMsg("pp-sub-msg", "检索订阅模块未就绪（请重启 Zotero 后再试）", "bad");
      return;
    }
    let r = null;
    try {
      r = await s.importFromClipboard();
    } catch (e) {
      r = { ok: false, added: 0, skipped: 0, error: String((e && (e.message || e)) || e) };
    }
    if (!r || !r.ok) {
      setMsg("pp-sub-msg", "导入失败：" + clipReason(r), "bad");
      return;
    }
    renderList();
    const added = Number(r.added) || 0;
    const skipped = Number(r.skipped) || 0;
    if (!added) {
      setMsg("pp-sub-msg", "没有新增订阅：" + (skipped ? "剪贴板里的 " + skipped + " 条都已存在或无效" : "剪贴板里没有可导入的订阅"));
      return;
    }
    setMsg("pp-sub-msg", "已导入 " + added + " 条订阅"
      + (skipped ? "（跳过 " + skipped + " 条重复或无效）" : ""), "good");
  }

  /* ================== 反馈学习（收藏 / 忽略）清空 ================== */

  /** 清空反馈学习：二次确认 → feedbackClear（内部同时作废推荐缓存），并回报 liked / ignored */
  function doFeedbackClear() {
    const s = S();
    if (!s || typeof s.feedbackClear !== "function") {
      setMsg("pp-sub-msg", "检索订阅模块未就绪（请重启 Zotero 后再试）", "bad");
      return;
    }
    let stats = { liked: 0, ignored: 0 };
    try { stats = s.feedbackStats() || stats; } catch (e) { stats = { liked: 0, ignored: 0 }; }
    let go = true;
    try {
      if (typeof Services !== "undefined" && Services && Services.prompt &&
        typeof Services.prompt.confirm === "function") {
        go = !!Services.prompt.confirm(window, "清空反馈学习",
          "将清空 " + (stats.liked || 0) + " 条「收藏」与 " + (stats.ignored || 0)
          + " 条「忽略」记录，排序回到默认。继续？");
      }
    } catch (e) { go = true; }
    if (!go) {
      setMsg("pp-sub-msg", "已取消");
      return;
    }
    let ok = false;
    try { ok = !!s.feedbackClear(); } catch (e) { ok = false; }
    if (!ok) {
      setMsg("pp-sub-msg", "清空失败（本地配置不可写）", "bad");
      return;
    }
    setMsg("pp-sub-msg", "已清空反馈学习（收藏 " + (stats.liked || 0) + " / 忽略 " + (stats.ignored || 0) + "）", "good");
  }

  /* ================== 表单 ================== */

  function clearForm() {
    for (const id of ["pp-sub-name", "pp-sub-keywords", "pp-sub-cats", "pp-sub-authors", "pp-sub-exclude",
      "pp-sub-journals", "pp-sub-time", "pp-sub-weekdays", "pp-sub-maxagedays", "pp-sub-max"]) {
      const node = $(id);
      if (node) node.value = "";
    }
    editIssns = [];
    editJournals = [];
    const clearBtn = $("pp-sub-journals-clear");
    if (clearBtn) clearBtn.style.display = "none";
    for (const src of SOURCES) {
      const node = $(src.el);
      if (node) node.checked = src.id === "arxiv";
    }
    const mode = $("pp-sub-mode");
    if (mode) mode.value = "all";
    const freq = $("pp-sub-freq");
    if (freq) freq.value = "manual";
    for (const id of ["pp-sub-auto", "pp-sub-notify", "pp-sub-ai-rerank", "pp-sub-ai-digest", "pp-sub-seed"]) {
      const node = $(id);
      if (node) node.checked = id === "pp-sub-auto" || id === "pp-sub-notify";
    }
  }

  function resetForm() {
    editingId = "";
    clearForm();
    const title = $("pp-subs-form-title");
    if (title) title.textContent = "新建订阅";
    const cancel = $("pp-subs-cancel");
    if (cancel) cancel.style.display = "none";
  }

  function fillForm(o) {
    const set = (id, v) => { const n = $(id); if (n) n.value = v == null ? "" : String(v); };
    set("pp-sub-name", o.name);
    set("pp-sub-keywords", o.keywords);
    set("pp-sub-cats", o.categories);
    set("pp-sub-authors", o.authors);
    set("pp-sub-exclude", o.exclude);
    set("pp-sub-time", o.dailyTime);
    set("pp-sub-weekdays", Array.isArray(o.weekdays) ? o.weekdays.join(",") : o.weekdays);
    set("pp-sub-maxagedays", o.maxAgeDays ? String(o.maxAgeDays) : "");
    set("pp-sub-max", o.max ? String(o.max) : "");
    // 期刊条件：只展示，不在这里手填 —— ISSN 由「按期刊订阅」带出，避免「改了刊名但 ISSN 还是旧的」
    editIssns = Array.isArray(o.issns) ? o.issns.slice() : (o.issns ? [o.issns] : []);
    editJournals = Array.isArray(o.journals) ? o.journals.slice()
      : (o.journals ? String(o.journals).split(/[;；\n]+/).map((x) => x.trim()).filter(Boolean) : []);
    set("pp-sub-journals", editJournals.join("; "));
    const clearJournals = $("pp-sub-journals-clear");
    if (clearJournals) clearJournals.style.display = (editJournals.length || editIssns.length) ? "" : "none";
    const srcs = Array.isArray(o.sources) && o.sources.length ? o.sources : ["arxiv"];
    for (const src of SOURCES) {
      const node = $(src.el);
      if (node) node.checked = srcs.indexOf(src.id) >= 0;
    }
    const mode = $("pp-sub-mode");
    if (mode) mode.value = o.mode === "any" || o.mode === "phrase" ? o.mode : "all";
    const freq = $("pp-sub-freq");
    if (freq) freq.value = o.freq === "daily" || o.freq === "weekly" ? o.freq : "manual";
    const check = (id, v) => { const n = $(id); if (n) n.checked = !!v; };
    check("pp-sub-auto", o.autoImport === undefined ? true : o.autoImport);
    check("pp-sub-notify", o.notify === undefined ? true : o.notify);
    check("pp-sub-ai-rerank", o.aiRerank);
    check("pp-sub-ai-digest", o.aiDigest);
    check("pp-sub-seed", o.seedProfile);
  }

  function readForm() {
    const val = (id) => {
      const n = $(id);
      return n ? String(n.value || "").trim() : "";
    };
    const chk = (id) => {
      const n = $(id);
      return !!(n && n.checked);
    };
    const sources = SOURCES.filter((s) => chk(s.el)).map((s) => s.id);
    return {
      name: val("pp-sub-name"),
      keywords: val("pp-sub-keywords"),
      categories: val("pp-sub-cats"),
      authors: val("pp-sub-authors"),
      // 期刊条件随编辑态带出（输入框只读）：清空按钮会把这两个数组清掉
      issns: editIssns.slice(),
      journals: editJournals.slice(),
      exclude: val("pp-sub-exclude"),
      sources: sources.length ? sources : ["arxiv"],
      mode: val("pp-sub-mode") || "all",
      freq: val("pp-sub-freq") || "manual",
      dailyTime: val("pp-sub-time"),
      weekdays: val("pp-sub-weekdays"),
      maxAgeDays: val("pp-sub-maxagedays"),
      max: val("pp-sub-max") || 10,
      autoImport: chk("pp-sub-auto"),
      notify: chk("pp-sub-notify"),
      aiRerank: chk("pp-sub-ai-rerank"),
      aiDigest: chk("pp-sub-ai-digest"),
      seedProfile: chk("pp-sub-seed"),
    };
  }

  function saveForm() {
    const s = S();
    if (!s || typeof s.add !== "function") {
      setMsg("pp-sub-msg", "检索订阅模块未就绪（请重启 Zotero 后再试）", "bad");
      return;
    }
    const draft = readForm();
    if (!draft.name) {
      setMsg("pp-sub-msg", "请填写订阅名称", "bad");
      const n = $("pp-sub-name");
      if (n && n.focus) try { n.focus(); } catch (e) { /* ignore */ }
      return;
    }
    if (!draft.keywords && !draft.categories && !draft.authors
      && !(draft.issns && draft.issns.length) && !(draft.journals && draft.journals.length)) {
      setMsg("pp-sub-msg", "关键词、分类、作者、期刊至少要有一个", "bad");
      const n = $("pp-sub-keywords");
      if (n && n.focus) try { n.focus(); } catch (e) { /* ignore */ }
      return;
    }
    let sub = null;
    try {
      sub = editingId ? s.update(editingId, draft) : s.add(draft);
    } catch (e) {
      sub = null;
    }
    if (!sub) {
      setMsg("pp-sub-msg", "保存失败（名称与检索条件必填：关键词 / 分类 / 作者 / 期刊至少一个）", "bad");
      return;
    }
    setMsg("pp-sub-msg", (editingId ? "已保存：" : "已创建：") + sub.name, "good");
    resetForm();
    renderList();
  }

  /* ================== AI 解析 ================== */

  /**
   * 0.72.2 设计修复：AI 回填后自动展开「更多条件」details（.pp-disclose，summary 文案「更多条件」），
   * 让用户看到被填了什么；details 由 xhtml 侧提供，缺失时静默跳过。
   */
  function openMoreConditions() {
    try {
      if (typeof document.querySelectorAll !== "function") return;
      const list = document.querySelectorAll("details.pp-disclose");
      for (let i = 0; i < list.length; i++) {
        const sum = list[i].querySelector("summary");
        if (sum && String(sum.textContent || "").indexOf("更多条件") >= 0) list[i].open = true;
      }
    } catch (e) { /* ignore */ }
  }

  async function aiParse() {
    const s = S();
    const input = $("pp-sub-nl");
    const text = String((input && input.value) || "").trim();
    if (!text) {
      setMsg("pp-sub-nl-msg", "先写一句你想追踪的方向", "bad");
      return;
    }
    if (!s || typeof s.aiParseQuery !== "function") {
      setMsg("pp-sub-nl-msg", "检索订阅模块未就绪（请重启 Zotero 后再试）", "bad");
      return;
    }
    const btn = $("pp-sub-ai");
    if (btn) btn.disabled = true;
    setMsg("pp-sub-nl-msg", "解析中…");
    try {
      const r = await s.aiParseQuery(text);
      if (!r || !r.ok) {
        setMsg("pp-sub-nl-msg", "未能解析：" + reasonText(r) + (r && r.guide ? "（" + r.guide + "）" : ""), "bad");
        return;
      }
      fillForm(r.input);
      openMoreConditions(); // AI 填了高级条件 → 展开给用户看（0.72.2）
      editingId = "";
      const title = $("pp-subs-form-title");
      if (title) title.textContent = "新建订阅（AI 解析草稿）";
      const cancel = $("pp-subs-cancel");
      if (cancel) cancel.style.display = "";
      setMsg("pp-sub-nl-msg", "已解析并填入下方表单，请确认后试跑。", "good");
      doPreview(r.input, r.input);
    } catch (e) {
      setMsg("pp-sub-nl-msg", "解析失败：" + ((e && (e.message || e)) || e), "bad");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /* ================== init（探测重试，同 prefs-schedule.js 纪律） ================== */

  function retry() {
    try {
      window.setTimeout(init, 400);
      window.setTimeout(init, 1200);
    } catch (e) { /* ignore */ }
  }

  function bind(id, type, fn) {
    const node = $(id);
    if (node) node.addEventListener(type, fn);
  }

  function init() {
    if (typeof Zotero === "undefined" || !Zotero.Prefs) { retry(); return; }
    if (!$("pp-subs-list")) { retry(); return; }
    if (init._done) return;
    init._done = true;

    try {
      clearForm();
      bind("pp-subs-add", "click", (ev) => {
        try { if (ev && ev.preventDefault) ev.preventDefault(); } catch (e) { /* ignore */ }
        saveForm();
      });
      bind("pp-subs-preview", "click", (ev) => {
        try { if (ev && ev.preventDefault) ev.preventDefault(); } catch (e) { /* ignore */ }
        const draft = readForm();
        if (!draft.keywords && !draft.categories && !draft.authors
          && !(draft.issns && draft.issns.length) && !(draft.journals && draft.journals.length)) {
          setMsg("pp-sub-msg", "关键词、分类、作者、期刊至少有一个再试跑", "bad");
          return;
        }
        if (!draft.name) draft.name = draft.keywords || draft.categories || draft.authors
          || (draft.journals && draft.journals[0]) || "";
        commitDraftForPreview(draft);
      });
      bind("pp-subs-cancel", "click", () => { resetForm(); setMsg("pp-sub-msg", "已取消编辑"); });
      bind("pp-subs-reco-refresh", "click", () => loadReco(true));
      bind("pp-subs-export", "click", (ev) => {
        try { if (ev && ev.preventDefault) ev.preventDefault(); } catch (e) { /* ignore */ }
        doExport();
      });
      bind("pp-subs-import", "click", (ev) => {
        try { if (ev && ev.preventDefault) ev.preventDefault(); } catch (e) { /* ignore */ }
        doImport();
      });
      bind("pp-subs-feedback-clear", "click", (ev) => {
        try { if (ev && ev.preventDefault) ev.preventDefault(); } catch (e) { /* ignore */ }
        doFeedbackClear();
      });
      bind("pp-subs-bridge", "click", (ev) => {
        try { if (ev && ev.preventDefault) ev.preventDefault(); } catch (e) { /* ignore */ }
        doBridgeSync();
      });
      bind("pp-sub-ai", "click", (ev) => {
        try { if (ev && ev.preventDefault) ev.preventDefault(); } catch (e) { /* ignore */ }
        aiParse();
      });
      // 期刊订阅（0.69.0）：学科 chips + 本地目录即时过滤 + 在线兜底
      renderJournalSubjects();
      loadJournalList();
      bind("pp-sub-journal-search", "click", (ev) => {
        try { if (ev && ev.preventDefault) ev.preventDefault(); } catch (e) { /* ignore */ }
        loadJournalList({ online: true, force: true });
      });
      const jq = $("pp-sub-journal-q");
      if (jq) {
        jq.addEventListener("input", () => {
          journalAutoTried = "";
          if (journalTimer) { try { window.clearTimeout(journalTimer); } catch (e) { /* ignore */ } }
          journalTimer = window.setTimeout(() => { journalTimer = null; loadJournalList(); }, 260);
        });
        jq.addEventListener("keydown", (ev) => {
          if (ev && ev.key === "Enter") {
            try { ev.preventDefault(); } catch (e) { /* ignore */ }
            if (journalTimer) { try { window.clearTimeout(journalTimer); } catch (e) { /* ignore */ } journalTimer = null; }
            loadJournalList({ online: true, force: true });
          }
        });
      }
      bind("pp-sub-journal-subscribe", "click", (ev) => {
        try { if (ev && ev.preventDefault) ev.preventDefault(); } catch (e) { /* ignore */ }
        if (!journalSelected.size) {
          journalMsg("先勾选期刊（或直接点某一行的「订阅」）");
          return;
        }
        doSubscribeJournals(Array.from(journalSelected.values()));
      });
      bind("pp-sub-journals-clear", "click", (ev) => {
        try { if (ev && ev.preventDefault) ev.preventDefault(); } catch (e) { /* ignore */ }
        editIssns = [];
        editJournals = [];
        const n = $("pp-sub-journals");
        if (n) n.value = "";
        const b = $("pp-sub-journals-clear");
        if (b) b.style.display = "none";
        setMsg("pp-sub-msg", "已清空期刊条件（点「保存订阅」后生效）");
      });
      const nl = $("pp-sub-nl");
      if (nl) nl.addEventListener("keydown", (ev) => {
        if (ev && ev.key === "Enter" && !ev.shiftKey) {
          try { ev.preventDefault(); } catch (e) { /* ignore */ }
          aiParse();
        }
      });
      renderList();
      // 推荐只读本地库，不联网；首次打开设置时后台算一次，失败不影响其它块
      loadReco(false);
    } catch (e) {
      try { Zotero.logError(e); } catch (e2) { /* ignore */ }
    }
  }

  /** 表单草稿试跑：把 weekdays 字符串转成数组，避免 update/coerce 收到 "1,3,5" 被当成单个值 */
  function commitDraftForPreview(draft) {
    const o = Object.assign({}, draft);
    o.weekdays = String(o.weekdays || "").split(/[^0-9]+/).map((x) => parseInt(x, 10)).filter((n) => n >= 1 && n <= 7);
    doPreview(o, o);
  }

  init();
  if (typeof window !== "undefined" && window.setTimeout) {
    window.setTimeout(init, 400);
    window.setTimeout(init, 1200);
  }
})();
