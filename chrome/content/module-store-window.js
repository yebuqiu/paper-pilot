// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot · 组件商店（Module Store）窗口逻辑
 * 运行在独立 XUL 窗口作用域：窗口参数 { Zotero, Services } 经 window.arguments 传入，
 * 核心域经 Zotero.Papilot.moduleStore 访问（另一模块并行实现，本文件只按契约调用，
 * 方法缺失或抛错一律降级为空态，绝不拖死 UI）；Zotero.Papilot.moduleLoader 仅用于
 * 校正「是否落盘」这一展示状态，拿不到就忽略。
 *
 * 三个纪律（与 skill-store.js 0.48.x 修复保持一致）：
 *   1) 时序守卫：XUL 顶部 <script> 先于后续 DOM 执行 → boot() + DOMContentLoaded /
 *      readyState 双保险（§39 纪律），绝不在脚本顶层碰 DOM。
 *   2) 表单控件：动态生成的 button / input / select / textarea 一律
 *      setAttribute("no-native","true")；配色全部由 module-store.css 显式定型。
 *   3) 所有 UI 回调经 guard() 自包 try-catch（含 Promise rejection），反馈集中到
 *      底部固定状态条，不弹 alert。
 *
 * 视图：列表（默认）/ 详情 / 批量更新。Esc：详情与批量更新 → 回列表；列表 → 关闭窗口。
 * 目录内容一律用 textContent / createElement 落地，不做 HTML 字符串拼接（防目录注入）。
 */
/* global window, document, addEventListener */
(function () {
  "use strict";

  const XHTML = "http://www.w3.org/1999/xhtml";
  const args = (window.arguments && window.arguments[0]) || {};
  const Z = args.Zotero || (window.opener && window.opener.Zotero) || null;
  const PP = Z && Z.Papilot ? Z.Papilot : null;
  let MS = (PP && PP.moduleStore) || null;     // 核心域（boot 时再刷新一次）
  let ML = (PP && PP.moduleLoader) || null;    // 落盘状态旁证（可缺失）

  const FILTERS = [
    { id: "all", label: "全部" },
    { id: "installed", label: "已安装" },
    { id: "update", label: "可更新" },
    { id: "recommended", label: "推荐" },
  ];

  // 权限 id → 中文名（目录新增权限时未知 id 原样展示，不炸）
  const PERM_LABELS = {
    storage: "本地存储",
    network: "网络访问",
    ai: "AI 调用",
    prefs: "设置读写",
    filesystem: "文件系统",
    ui: "界面注入",
  };

  const OP = {
    install: { busy: "正在安装", done: "已安装", fail: "安装失败" },
    update: { busy: "正在更新", done: "已更新", fail: "更新失败" },
    uninstall: { busy: "正在卸载", done: "已卸载", fail: "卸载失败" },
    rollback: { busy: "正在回滚", done: "已回滚", fail: "回滚失败" },
  };

  /* ---------- 防御式日志（绝不因日志本身抛错） ---------- */
  function log(e) {
    try {
      const msg = "modstore error: " + (e && (e.stack || e.message) ? (e.stack || e.message) : String(e));
      if (PP && typeof PP._diag === "function") PP._diag(msg);
      else if (Z && Z.logError) Z.logError(e || msg);
    } catch (_) { /* ignore */ }
  }

  // 窗口级错误钩子：静默死亡必须留下日志
  try {
    window.addEventListener("error", (ev) => {
      try {
        if (PP && typeof PP._diag === "function") {
          PP._diag("modstore error: " + (ev && ev.message) + " @" +
            String((ev && ev.filename) || "").split("/").pop() + ":" + (ev && ev.lineno));
        }
      } catch (e) { /* ignore */ }
    });
  } catch (e) { /* ignore */ }

  /* ---------- 安全调用 ---------- */
  function tryCall(fn, fallback) {
    try {
      const v = fn();
      return v === undefined ? fallback : v;
    } catch (e) {
      log(e);
      return fallback;
    }
  }
  /** UI 回调自包 try-catch（含 Promise rejection），不得拖死流程 */
  function guard(fn) {
    return function () {
      try {
        const r = fn.apply(this, arguments);
        if (r && typeof r.catch === "function") r.catch((e) => { log(e); });
        return r;
      } catch (e) {
        log(e);
        return undefined;
      }
    };
  }

  /* ---------- 纯工具 ---------- */
  function str(v) { return v == null ? "" : String(v); }
  function num(v) {
    const n = Number(v);
    return isFinite(n) ? n : 0;
  }
  function el(tag, cls, text) {
    const n = document.createElementNS(XHTML, tag);
    if (tag === "button" || tag === "input" || tag === "select" || tag === "textarea") {
      n.setAttribute("no-native", "true");
    }
    if (cls) n.setAttribute("class", cls);
    if (text != null) n.textContent = String(text);
    return n;
  }
  function badge(text, kind) {
    return el("span", "pp-ms-badge pp-ms-badge-" + kind, text);
  }
  /** 体积自适应：B / KB / MB（≥10MB 不保留小数） */
  function fmtSize(bytes) {
    const n = Number(bytes);
    if (!isFinite(n) || n <= 0) return "";
    if (n >= 1024 * 1024) {
      const mb = n / (1024 * 1024);
      return (mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10) + " MB";
    }
    if (n >= 1024) return Math.max(1, Math.round(n / 1024)) + " KB";
    return Math.round(n) + " B";
  }

  function boot() {
    const $ = (id) => document.getElementById(id);
    const rootEl = $("pp-ms-root");
    if (!rootEl) return;

    // boot 时再取一次：核心域可能在窗口打开瞬间才注入
    MS = (PP && PP.moduleStore) || MS || null;
    ML = (PP && PP.moduleLoader) || ML || null;

    /* ---------- 主题（Papilot 界面主题优先；无则跟随系统，CSS @media 兜底） ---------- */
    try {
      let dark = false;
      const theme = (PP && PP.uiTheme && typeof PP.uiTheme.current === "function")
        ? PP.uiTheme.current() : null;
      if (theme && theme.dark) dark = true;
      else if (window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: dark)").matches) dark = true;
      rootEl.setAttribute("data-theme", dark ? "dark" : "light");
    } catch (e) {
      rootEl.setAttribute("data-theme", "light");
    }

    /* ---------- 节点 ---------- */
    const searchEl = $("pp-ms-search");
    const refreshBtn = $("pp-ms-refresh");
    const chipbar = $("pp-ms-chipbar");
    const chipsEl = $("pp-ms-chips");
    const updatesEntry = $("pp-ms-updates-entry");
    const mainEl = $("pp-ms-main");
    const viewList = $("pp-ms-view-list");
    const viewDetail = $("pp-ms-view-detail");
    const viewUpdates = $("pp-ms-view-updates");
    const gridEl = $("pp-ms-grid");
    const emptyEl = $("pp-ms-empty");
    const emptyTitleEl = $("pp-ms-empty-title");
    const emptySubEl = $("pp-ms-empty-sub");
    const retryBtn = $("pp-ms-retry");
    const updSummary = $("pp-ms-upd-summary");
    const updListEl = $("pp-ms-upd-list");
    const updEmptyEl = $("pp-ms-upd-empty");
    const updateAllBtn = $("pp-ms-update-all");
    const statusEl = $("pp-ms-status");
    const statusText = $("pp-ms-status-text");
    const spinner = $("pp-ms-spinner");

    /* ---------- 状态 ---------- */
    const state = {
      rows: [],
      catalogModules: [],
      filter: "all",
      query: "",
      view: "list",
      detailId: null,
      loaded: false,
      loading: false,
      offline: false,
      opLock: false,
      lastError: "",
      updateResults: {},   // id -> {error}：批量更新失败项（用于「重试」与行内提示）
    };
    let updStatusNodes = new Map();  // id -> 行内状态节点（批量更新逐项反馈）

    /* ==================== 状态条 / 空态 ==================== */
    function setStatus(text, kind) {
      try {
        const k = kind || "";
        statusEl.setAttribute("class", "pp-ms-status" + (k ? " pp-ms-st-" + k : ""));
        statusText.textContent = text || "";
        spinner.style.display = k === "busy" ? "inline-block" : "none";
      } catch (e) { log(e); }
    }
    function showEmpty(title, sub, showRetry) {
      gridEl.textContent = "";
      emptyTitleEl.textContent = title || "";
      emptySubEl.textContent = sub || "";
      retryBtn.style.display = showRetry ? "" : "none";
      emptyEl.style.display = "";
    }
    function hideEmpty() { emptyEl.style.display = "none"; }

    /* ==================== 行归一化 ==================== */
    /** 目录内容不可信：字段全部窄化，缺省值兜底，绝不把原对象直接塞进 DOM 属性 */
    function normalizeRow(r) {
      const id = r.id != null ? String(r.id) : "";
      const files = r.files != null ? r.files : r.fileCount;
      return {
        id: id,
        name: str(r.name) || id || "未命名组件",
        description: str(r.description || r.desc),
        detail: str(r.longDescription || r.longDesc || r.details),
        version: str(r.version),
        installedVersion: str(r.installedVersion),
        sizeBytes: num(r.sizeBytes != null ? r.sizeBytes : r.size),
        fileCount: Array.isArray(files) ? files.length : num(files),
        installed: !!r.installed,
        updateAvailable: !!r.updateAvailable,
        pro: !!r.pro,
        recommended: !!r.recommended,
        tags: Array.isArray(r.tags) ? r.tags.map(str).filter(Boolean) : [],
        requires: Array.isArray(r.requires) ? r.requires.map(str).filter(Boolean) : [],
        permissions: Array.isArray(r.permissions) ? r.permissions.map(str).filter(Boolean) : [],
        broken: !!r.broken,
        notes: str(r.updateNotes || r.changelog || r.releaseNotes || r.notes),
      };
    }

    /** 用 moduleLoader.list() 校正落盘状态（缺失/异常则完全忽略） */
    function mergeLoaderState() {
      if (!ML || typeof ML.list !== "function") return;
      const disk = tryCall(() => ML.list(), null);
      if (!Array.isArray(disk) || !disk.length) return;
      const byId = new Map();
      for (const it of disk) {
        if (it && it.id != null) byId.set(String(it.id), it);
      }
      if (!byId.size) return;
      for (const r of state.rows) {
        const d = byId.get(r.id);
        if (!d) continue;
        if (!r.installed) r.installed = true;
        if (!r.installedVersion && d.version != null) r.installedVersion = str(d.version);
        if (d.broken) r.broken = true;
      }
    }

    function reloadRows() {
      let rows = tryCall(() =>
        (MS && typeof MS.listRows === "function" ? MS.listRows() : null), null);
      if (!Array.isArray(rows)) {
        // listRows 缺失/异常 → 退回最近一次 fetchCatalog 的 modules（结构相近）
        rows = Array.isArray(state.catalogModules) ? state.catalogModules : [];
      }
      state.rows = rows.filter((r) => r && typeof r === "object").map(normalizeRow);
      mergeLoaderState();
    }

    function findRow(id) {
      if (id == null) return null;
      const key = String(id);
      return state.rows.find((r) => r.id === key) || null;
    }
    function updatableRows() {
      return state.rows.filter((r) => r.updateAvailable);
    }
    function visibleRows() {
      const q = state.query.trim().toLowerCase();
      return state.rows.filter((r) => {
        if (state.filter === "installed" && !r.installed) return false;
        if (state.filter === "update" && !r.updateAvailable) return false;
        if (state.filter === "recommended" && !r.recommended) return false;
        if (!q) return true;
        const hay = (r.name + " " + r.description + " " + r.tags.join(" ") + " " + r.id).toLowerCase();
        return hay.indexOf(q) >= 0;
      });
    }

    /* ==================== 视图切换 ==================== */
    function showView(v) {
      state.view = v;
      viewList.style.display = v === "list" ? "" : "none";
      viewDetail.style.display = v === "detail" ? "" : "none";
      viewUpdates.style.display = v === "updates" ? "" : "none";
      chipbar.style.display = v === "list" ? "" : "none";
      searchEl.style.display = v === "list" ? "" : "none";
      try { mainEl.scrollTop = 0; } catch (e) { /* ignore */ }
      if (v === "list") renderList();
      else if (v === "detail") renderDetail();
      else renderUpdates();
    }

    function rerender() {
      renderChips();
      renderUpdatesEntry();
      if (state.view === "detail") renderDetail();
      else if (state.view === "updates") renderUpdates();
      else renderList();
    }

    function openDetail(id) {
      state.detailId = id == null ? null : String(id);
      showView("detail");
    }

    /* ==================== 目录 ==================== */
    async function refreshCatalog(force) {
      if (state.loading) return;
      if (state.opLock) { setStatus("操作进行中，完成后再刷新目录…", "busy"); return; }
      if (!MS) { deadState(); return; }
      const canFetch = typeof MS.fetchCatalog === "function";
      const canRows = typeof MS.listRows === "function";
      if (!canFetch && !canRows) { deadState(); return; }

      state.loading = true;
      refreshBtn.disabled = true;
      refreshBtn.textContent = "刷新中…";
      retryBtn.disabled = true;
      setStatus("正在加载组件目录…", "busy");

      let res = null;
      let failMsg = "";
      if (canFetch) {
        try {
          res = await MS.fetchCatalog(!!force);
        } catch (e) {
          log(e);
          failMsg = (e && e.message) ? e.message : String(e);
        }
      } else {
        failMsg = "当前版本不支持刷新目录";
      }

      state.loaded = true;
      state.offline = !!failMsg;
      state.catalogModules = (res && Array.isArray(res.modules)) ? res.modules : [];
      if (failMsg) {
        const last = tryCall(() =>
          (MS && typeof MS.getLastError === "function" ? MS.getLastError() : null), null);
        state.lastError = str(last) || failMsg;
      } else {
        state.lastError = "";
      }

      reloadRows();

      state.loading = false;
      refreshBtn.disabled = false;
      refreshBtn.textContent = "刷新";
      retryBtn.disabled = false;

      rerender();

      if (failMsg) {
        const installedN = state.rows.filter((r) => r.installed).length;
        setStatus("目录加载失败：" + (state.lastError || "未知错误") +
          (installedN ? " · 已安装的 " + installedN + " 个组件仍可正常使用" : ""), "err");
      } else {
        setStatus("组件目录已更新 · 共 " + state.rows.length + " 个组件", "ok");
      }
    }

    /** 核心域缺失：只给空态与禁用，不抛错 */
    function deadState() {
      state.loaded = true;
      state.offline = true;
      refreshBtn.disabled = true;
      searchEl.disabled = true;
      updatesEntry.style.display = "none";
      showEmpty("组件商店暂不可用",
        "没有找到 Papilot 的组件管理模块（moduleStore）。请重启 Zotero 或更新 Papilot 后重新打开本窗口。",
        false);
      setStatus("组件管理模块未就绪", "err");
    }

    /* ==================== 筛选 chip ==================== */
    function renderChips() {
      chipsEl.textContent = "";
      const counts = {
        all: state.rows.length,
        installed: state.rows.filter((r) => r.installed).length,
        update: state.rows.filter((r) => r.updateAvailable).length,
        recommended: state.rows.filter((r) => r.recommended).length,
      };
      for (const f of FILTERS) {
        const b = el("button", "pp-ms-chip" + (state.filter === f.id ? " pp-ms-chip-on" : ""), f.label);
        b.setAttribute("type", "button");
        if (f.id !== "all") b.appendChild(el("span", "pp-ms-chip-n", String(counts[f.id])));
        b.addEventListener("click", guard(() => {
          if (state.filter === f.id) return;
          state.filter = f.id;
          renderChips();
          renderList();
        }));
        chipsEl.appendChild(b);
      }
    }

    function renderUpdatesEntry() {
      const n = updatableRows().length;
      updatesEntry.style.display = n ? "" : "none";
      updatesEntry.textContent = n ? "批量更新（" + n + "）" : "批量更新";
    }

    /* ==================== 列表 ==================== */
    function stateBadge(r) {
      if (r.broken) return badge("损坏", "danger");
      if (r.updateAvailable) return badge("可更新", "warn");
      if (r.installed) return badge("已安装", "ok");
      return badge("未安装", "muted");
    }

    function renderList() {
      gridEl.textContent = "";
      if (!state.loaded && !state.rows.length) {
        showEmpty("正在加载组件目录…", "首次打开需要从组件源拉取目录，请稍候。", false);
        return;
      }
      const list = visibleRows();
      if (!list.length) {
        if (!state.rows.length) {
          if (state.offline) {
            showEmpty("暂时连不上组件目录", "已安装的组件仍可正常使用。稍后可点下方「重试」再拉一次。", true);
          } else {
            showEmpty("组件目录还是空的", "组件源暂时没有可安装的组件；稍后刷新，或检查组件目录设置。", true);
          }
        } else if (state.query) {
          showEmpty("没有匹配的组件", "换个关键词，或清空搜索框再试。", false);
        } else {
          showEmpty("这里还没有组件", "当前筛选条件下没有内容，切换到「全部」看看。", false);
        }
        return;
      }
      hideEmpty();
      for (const r of list) gridEl.appendChild(buildCard(r));
    }

    /** 卡片操作按钮：阻止冒泡，避免顺带触发「打开详情」 */
    function actBtn(label, cls, row, op, scope) {
      const b = el("button", cls, label);
      b.setAttribute("type", "button");
      b.addEventListener("click", guard((ev) => {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        runOp(row, op, scope);
      }));
      return b;
    }

    function buildCard(r) {
      const card = el("div", "pp-ms-card");
      card.setAttribute("data-id", r.id);
      card.addEventListener("click", guard(() => openDetail(r.id)));

      const head = el("div", "pp-ms-card-head");
      head.appendChild(el("div", "pp-ms-card-name", r.name));
      if (r.version) head.appendChild(el("span", "pp-ms-ver", "v" + r.version));
      card.appendChild(head);

      card.appendChild(el("div", "pp-ms-card-desc", r.description || "（暂无描述）"));

      const meta = el("div", "pp-ms-card-meta");
      meta.appendChild(stateBadge(r));
      if (r.pro) meta.appendChild(badge("Pro", "pro"));
      if (r.recommended) meta.appendChild(badge("推荐", "rec"));
      if (r.tags.length) {
        meta.appendChild(el("span", "pp-ms-tags",
          r.tags.slice(0, 4).map((t) => "#" + t).join(" ")));
      }
      card.appendChild(meta);

      const foot = el("div", "pp-ms-card-foot");
      foot.appendChild(el("span", "pp-ms-size", fmtSize(r.sizeBytes) || "体积未知"));
      foot.appendChild(el("span", "pp-ms-spacer"));
      const acts = el("div", "pp-ms-acts");
      if (!r.installed) {
        acts.appendChild(actBtn("安装", "pp-ms-btn pp-ms-btn-sm pp-ms-btn-primary", r, "install", card));
      } else {
        if (r.updateAvailable) {
          acts.appendChild(actBtn("更新", "pp-ms-btn pp-ms-btn-sm pp-ms-btn-primary", r, "update", card));
        }
        acts.appendChild(actBtn("回滚", "pp-ms-btn pp-ms-btn-sm", r, "rollback", card));
        acts.appendChild(actBtn("卸载", "pp-ms-btn pp-ms-btn-sm pp-ms-btn-danger", r, "uninstall", card));
      }
      const d = el("button", "pp-ms-linkbtn", "详情");
      d.setAttribute("type", "button");
      d.addEventListener("click", guard((ev) => {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        openDetail(r.id);
      }));
      acts.appendChild(d);
      foot.appendChild(acts);
      card.appendChild(foot);
      return card;
    }

    /* ==================== 详情 ==================== */
    function kvRow(k, v) {
      const row = el("div", "pp-ms-kv-row");
      row.appendChild(el("div", "pp-ms-kv-k", k));
      row.appendChild(el("div", "pp-ms-kv-v", v));
      return row;
    }

    function renderDetail() {
      const r = findRow(state.detailId);
      if (!r) {
        state.detailId = null;
        showView("list");
        setStatus("该组件已不在当前目录中", "err");
        return;
      }
      viewDetail.textContent = "";

      const backRow = el("div", "pp-ms-backrow");
      const back = el("button", "pp-ms-linkbtn", "← 返回列表");
      back.setAttribute("type", "button");
      back.addEventListener("click", guard(() => showView("list")));
      backRow.appendChild(back);
      viewDetail.appendChild(backRow);

      const head = el("div", "pp-ms-d-head");
      head.appendChild(el("div", "pp-ms-d-name", r.name));
      if (r.version) head.appendChild(el("span", "pp-ms-ver", "v" + r.version));
      head.appendChild(stateBadge(r));
      if (r.pro) head.appendChild(badge("Pro", "pro"));
      if (r.recommended) head.appendChild(badge("推荐", "rec"));
      viewDetail.appendChild(head);

      if (r.tags.length) {
        viewDetail.appendChild(el("div", "pp-ms-d-tags",
          r.tags.map((t) => "#" + t).join("   ")));
      }
      if (r.broken) {
        viewDetail.appendChild(el("div", "pp-ms-warnbox",
          "该组件已损坏：文件可能缺失或被外部改动。可先尝试回滚，仍无法恢复时卸载后重新安装。"));
      }

      const kv = el("div", "pp-ms-kv");
      kv.appendChild(kvRow("组件 ID", r.id || "—"));
      kv.appendChild(kvRow("目录版本", r.version ? "v" + r.version : "—"));
      kv.appendChild(kvRow("已装版本", r.installed ? "v" + (r.installedVersion || "?") : "未安装"));
      kv.appendChild(kvRow("体积", fmtSize(r.sizeBytes) || "未提供"));
      if (r.fileCount > 0) kv.appendChild(kvRow("文件数", String(r.fileCount)));
      viewDetail.appendChild(kv);

      // 能力与权限：清单可能没有 requires / permissions 字段，两者皆空时整段不出现
      if (r.permissions.length || r.requires.length) {
        viewDetail.appendChild(el("div", "pp-ms-sec", "能力与权限"));
        const perm = el("div", "pp-ms-perm");
        if (r.permissions.length) {
          const plist = el("div", "pp-ms-perm-list");
          for (const p of r.permissions) {
            plist.appendChild(el("span", "pp-ms-perm-chip",
              PERM_LABELS[p] || p));
          }
          perm.appendChild(plist);
        }
        if (r.requires.length) {
          perm.appendChild(el("div", "pp-ms-perm-req",
            "需要宿主能力：" + r.requires.join("、")));
        }
        viewDetail.appendChild(perm);
      }

      viewDetail.appendChild(el("div", "pp-ms-sec", "简介"));
      viewDetail.appendChild(el("div", "pp-ms-desc",
        r.detail || r.description || "该组件没有提供描述。"));

      viewDetail.appendChild(el("div", "pp-ms-sec", "更新说明"));
      let note = r.notes;
      if (!note) {
        if (r.updateAvailable) {
          note = "有新版本可用：v" + (r.version || "?") +
            "（当前 v" + (r.installedVersion || "?") + "）。";
        } else if (r.installed) {
          note = "已是最新版本。";
        } else {
          note = "尚未安装。安装后，组件目录发布新版本时会在这里看到更新提示。";
        }
      }
      viewDetail.appendChild(el("div", "pp-ms-note", note));

      const acts = el("div", "pp-ms-actrow");
      if (!r.installed) {
        acts.appendChild(actBtn("安装", "pp-ms-btn pp-ms-btn-primary", r, "install", acts));
      } else {
        if (r.updateAvailable) {
          acts.appendChild(actBtn(r.version ? "更新到 v" + r.version : "更新",
            "pp-ms-btn pp-ms-btn-primary", r, "update", acts));
        }
        acts.appendChild(actBtn("回滚", "pp-ms-btn", r, "rollback", acts));
        acts.appendChild(actBtn("卸载", "pp-ms-btn pp-ms-btn-danger", r, "uninstall", acts));
      }
      viewDetail.appendChild(acts);
    }

    /* ==================== 批量更新 ==================== */
    function markRow(id, text, kind) {
      const n = updStatusNodes.get(String(id));
      if (!n) return;
      n.textContent = text || "";
      n.setAttribute("class", "pp-ms-upd-state" + (kind ? " pp-ms-upd-state-" + kind : ""));
    }

    function renderUpdates() {
      updListEl.textContent = "";
      updStatusNodes = new Map();
      const list = updatableRows();
      updSummary.textContent = list.length
        ? "共 " + list.length + " 个组件有新版本，可逐个更新或一次全部更新。"
        : "所有已安装组件都是最新版本。";
      updateAllBtn.disabled = !list.length || state.opLock || state.loading;
      updateAllBtn.textContent = list.length ? "全部更新（" + list.length + "）" : "全部更新";
      updEmptyEl.style.display = list.length ? "none" : "";
      if (!list.length) return;

      for (const r of list) {
        const rowEl = el("div", "pp-ms-upd-row");

        const info = el("div", "pp-ms-upd-info");
        info.appendChild(el("div", "pp-ms-upd-name", r.name));
        const bits = ["v" + (r.installedVersion || "?") + " → v" + (r.version || "?")];
        const sz = fmtSize(r.sizeBytes);
        if (sz) bits.push(sz);
        info.appendChild(el("div", "pp-ms-upd-meta", bits.join(" · ")));
        rowEl.appendChild(info);

        const st = el("span", "pp-ms-upd-state");
        const rr = state.updateResults[r.id];
        if (rr) {
          st.textContent = "失败：" + (rr.error || "未知错误");
          st.setAttribute("class", "pp-ms-upd-state pp-ms-upd-state-err");
        }
        updStatusNodes.set(r.id, st);
        rowEl.appendChild(st);

        const b = el("button", "pp-ms-btn pp-ms-btn-sm" +
          (rr ? "" : " pp-ms-btn-primary"), rr ? "重试" : "更新");
        b.setAttribute("type", "button");
        b.disabled = state.opLock;
        b.addEventListener("click", guard(() => runOp(r, "update", rowEl)));
        rowEl.appendChild(b);

        updListEl.appendChild(rowEl);
      }
    }

    async function updateAll() {
      if (state.opLock) return;
      if (!MS || typeof MS.install !== "function") {
        setStatus("当前版本不支持更新组件", "err");
        return;
      }
      const targets = updatableRows().slice();
      if (!targets.length) { setStatus("没有可更新的组件", "ok"); return; }

      state.opLock = true;
      state.updateResults = {};
      updateAllBtn.disabled = true;
      setScopeDisabled(updListEl, true);

      let ok = 0;
      let fail = 0;
      for (let i = 0; i < targets.length; i++) {
        const r = targets[i];
        markRow(r.id, "更新中…", "busy");
        setStatus("正在更新（" + (i + 1) + "/" + targets.length + "）：" + r.name + "…", "busy");

        let res = null;
        try {
          res = await MS.install(r.id);
        } catch (e) {
          log(e);
          res = { ok: false, error: (e && e.message) ? e.message : String(e) };
        }
        if (res && res.ok) {
          ok++;
          markRow(r.id, "已更新" + (res.version ? " 到 v" + res.version : ""), "ok");
        } else {
          fail++;
          const err = (res && res.error) || "未知错误";
          state.updateResults[r.id] = { ok: false, error: err };
          markRow(r.id, "失败：" + err, "err");
        }
      }

      state.opLock = false;
      reloadRows();
      rerender();

      if (fail) {
        setStatus("批量更新完成：成功 " + ok + " 个，失败 " + fail + " 个", "err");
      } else {
        setStatus("批量更新完成：已更新 " + ok + " 个组件", "ok");
      }
    }

    /* ==================== 安装 / 卸载 / 回滚 / 更新 ==================== */
    function setScopeDisabled(scope, on) {
      if (!scope || !scope.querySelectorAll) return;
      for (const b of scope.querySelectorAll("button")) b.disabled = !!on;
    }

    function getServices() {
      if (args.Services) return args.Services;
      try {
        if (typeof Services !== "undefined" && Services) return Services;
      } catch (e) { /* ignore */ }
      return null;
    }

    function askUninstall(row) {
      try {
        const Sv = getServices();
        if (Sv && Sv.prompt && typeof Sv.prompt.confirm === "function") {
          return !!Sv.prompt.confirm(window, "Papilot 组件商店",
            "确定要卸载「" + row.name + "」吗？卸载后其功能将立即失效。");
        }
      } catch (e) { log(e); }
      return true;
    }

    async function runOp(row, op, scopeEl) {
      if (state.opLock) {
        setStatus("请等待当前操作完成…", "busy");
        return;
      }
      const api = op === "update" ? "install" : op;
      if (!MS || typeof MS[api] !== "function") {
        setStatus("当前版本不支持「" + OP[op].busy.replace("正在", "") + "」操作", "err");
        return;
      }
      if (op === "uninstall" && !askUninstall(row)) return;

      state.opLock = true;
      setScopeDisabled(scopeEl, true);
      setStatus(OP[op].busy + "：" + row.name + "…", "busy");

      let res = null;
      try {
        res = await MS[api](row.id);
      } catch (e) {
        log(e);
        res = { ok: false, error: (e && e.message) ? e.message : String(e) };
      }
      state.opLock = false;

      if (res && res.ok) {
        const ver = res.version ? "（v" + res.version + "）" : "";
        setStatus(OP[op].done + "：" + row.name + ver, "ok");
        reloadRows();
        rerender();
        return;
      }
      setScopeDisabled(scopeEl, false);
      setStatus(OP[op].fail + "：" + ((res && res.error) || "未知错误"), "err");
    }

    /* ==================== 事件绑定 ==================== */
    searchEl.addEventListener("input", guard(() => {
      state.query = str(searchEl.value).trim();
      if (state.view !== "list") showView("list");
      else renderList();
    }));

    refreshBtn.addEventListener("click", guard(() => refreshCatalog(true)));
    retryBtn.addEventListener("click", guard(() => refreshCatalog(true)));
    updatesEntry.addEventListener("click", guard(() => showView("updates")));
    updateAllBtn.addEventListener("click", guard(() => updateAll()));

    // Esc：详情 / 批量更新 → 回列表；列表 → 关闭窗口（操作进行中不响应，避免中断下载）
    window.addEventListener("keydown", (ev) => {
      try {
        if (!ev || ev.key !== "Escape" || ev.isComposing) return;
        if (state.opLock || state.loading) {
          setStatus("操作进行中，请稍候…", "busy");
          return;
        }
        if (state.view !== "list") {
          showView("list");
          return;
        }
        window.close();
      } catch (e) { log(e); }
    });

    /* ==================== 启动 ==================== */
    renderChips();
    renderUpdatesEntry();
    showView("list");
    try { searchEl.focus(); } catch (e) { /* ignore */ }

    if (!MS || (typeof MS.listRows !== "function" && typeof MS.fetchCatalog !== "function")) {
      deadState();
      return;
    }
    refreshCatalog(false);
  }

  // ★ 时序守卫（§39 纪律）：XUL 顶部 script 先于 DOM 执行，等 DOMContentLoaded 再 boot
  if (document.readyState === "loading") {
    addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
