/* PaperPilot · AI 技能包商店（Skills Hub）窗口逻辑
 * 运行在独立 XUL 窗口作用域：窗口参数 { Zotero, Services } 经 window.arguments 传入
 * （chat-window.js / workbench 同款），核心域经 Zotero.PaperPilot.skillPacks 访问
 * （另一模块并行实现，本文件只按接口契约调用，全程防御式——skillPacks 缺失或
 *  某方法不存在时一律显示友好状态，绝不抛错拖死 UI）。
 *
 * 三个纪律（与 chat-window.js 0.47.0 修复保持一致）：
 *   1) 时序守卫：XUL 顶部 <script> 先于后续 DOM 执行 → boot() + DOMContentLoaded/
 *      readyState 双保险（§39 纪律，0.45.99 勾选对话框真机踩坑）。
 *   2) 表单控件：动态生成的 textarea 一律 setAttribute("no-native","true")；
 *      全部控件靠 skill-store.xhtml 内的显式 appearance:none + 配色类定型。
 *   3) 所有 UI 回调经 guard() 自包 try-catch（含 Promise rejection），反馈集中
 *      固定状态条，不弹 alert。
 *
 * 视图：列表（默认）/ 详情 / 制作器，页内切换；Esc 在详情/制作器 = 返回列表。
 */
/* global window, document, addEventListener, Components */
(function () {
  "use strict";

  const XHTML = "http://www.w3.org/1999/xhtml";
  const args = (window.arguments && window.arguments[0]) || {};
  const Z = args.Zotero || (window.opener && window.opener.Zotero) || null;
  const PP = Z && Z.PaperPilot ? Z.PaperPilot : null;
  let SP = (PP && PP.skillPacks) || null;   // 核心域（boot 时再刷新一次）
  let CT = (PP && PP.commandTags) || null;   // 制作器勾选源
  function getServices() {
    if (args.Services) return args.Services;
    try { if (typeof Services !== "undefined" && Services) return Services; } catch (e) { /* ignore */ }
    return null;
  }

  // 渲染列表所必需的核心方法；缺任何一个 → 全页「核心模块未就绪」空态。
  const CORE_FNS = ["fetchCatalog", "searchPacks", "listInstalled", "isInstalled",
    "compareVersion", "install"];
  const CATEGORIES_FALLBACK = ["写作", "审稿", "翻译", "阅读", "标签", "Agent", "模板", "综合"];

  /* ---------- 防御式日志（绝不因日志本身抛错） ---------- */
  function log(e) {
    try {
      const msg = "skillstore error: " + (e && (e.stack || e.message) ? (e.stack || e.message) : String(e));
      if (PP && PP._diag) PP._diag(msg);
      else if (Z && Z.logError) Z.logError(e || msg);
    } catch (_) { /* ignore */ }
  }

  // 窗口级错误钩子（chat-window 同款：静默死亡必须留下日志）
  try {
    window.addEventListener("error", (ev) => {
      try {
        if (PP && PP._diag) {
          PP._diag("skillstore error: " + (ev && ev.message) + " @" +
            String((ev && ev.filename) || "").split("/").pop() + ":" + (ev && ev.lineno));
        }
      } catch (e) { /* ignore */ }
    });
  } catch (e) { /* ignore */ }

  /* ---------- 同步/异步安全调用 ---------- */
  function tryCall(fn, fallback) {
    try {
      const v = fn();
      return v === undefined ? fallback : v;
    } catch (e) {
      log(e);
      return fallback;
    }
  }
  async function tryCallAsync(fn, fallback) {
    try {
      const v = await fn();
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
        if (r && typeof r.catch === "function") {
          r.catch((e) => { log(e); });
        }
        return r;
      } catch (e) {
        log(e);
        return undefined;
      }
    };
  }

  /* ---------- 纯工具 ---------- */
  function el(tag, cls, text) {
    const n = document.createElementNS(XHTML, tag);
    if (cls) n.setAttribute("class", cls);
    if (text != null) n.textContent = text;
    return n;
  }
  /** 相对时间（Date.now 粗略即可） */
  function relTime(ts) {
    const t = Number(ts);
    if (!isFinite(t) || t <= 0) return "";
    const diff = Date.now() - t;
    if (diff < 0) return "";
    const min = Math.floor(diff / 60000);
    if (min < 1) return "刚刚";
    if (min < 60) return min + " 分钟前";
    const h = Math.floor(min / 60);
    if (h < 24) return h + " 小时前";
    const d = Math.floor(h / 24);
    if (d < 30) return d + " 天前";
    const mo = Math.floor(d / 30);
    if (mo < 12) return mo + " 个月前";
    return Math.floor(mo / 12) + " 年前";
  }
  /** updatedAt 兼容 number / 数字串 / ISO 串 */
  function fmtUpdatedAt(u) {
    if (u == null || u === "") return "";
    if (typeof u === "number") return relTime(u);
    if (typeof u === "string") {
      if (/^\d+$/.test(u)) return relTime(Number(u));
      const t = Date.parse(u);
      if (!isNaN(t)) return relTime(t);
      return u;
    }
    return "";
  }
  /** applied/removed 字段可能是计数、数组或对象，统一折算 */
  function countOf(v) {
    if (v == null) return 0;
    if (typeof v === "number") return v;
    if (Array.isArray(v)) return v.length;
    if (typeof v === "object") return Object.keys(v).length;
    return 1;
  }
  function fmtInt(n) {
    return tryCall(() => Number(n).toLocaleString("zh-CN"), String(n));
  }
  function fmtRating(r) {
    const n = Number(r);
    return isFinite(n) ? n.toFixed(1) : String(r);
  }
  /** glossary 归一为数组（支持 数组 / {term:def} 对象） */
  function glossaryEntries(g) {
    if (Array.isArray(g)) return g;
    if (g && typeof g === "object") return Object.keys(g).map((k) => ({ term: k, def: g[k] }));
    return [];
  }
  function glossaryLine(item) {
    if (typeof item === "string") return item;
    if (Array.isArray(item)) return item.filter((x) => x != null).map(String).join(" | ");
    if (item && typeof item === "object") {
      // manifest 规范对象格式 {s,t,d} → "s = t | d"；宽松目录格式 {term,def} → "term | def"
      if (item.s != null || item.t != null) {
        const s = String(item.s == null ? "" : item.s);
        const t = String(item.t == null ? "" : item.t);
        const d = String(item.d == null ? "" : item.d).trim();
        return s + " = " + t + (d ? " | " + d : "");
      }
      const term = item.term || item.source || item.from || "";
      const def = item.def || item.target || item.to || item.translation || item.meaning || "";
      if (term || def) return [term, def].filter(Boolean).join(" | ");
      return JSON.stringify(item);
    }
    return String(item);
  }
  /** prompts 条目 →「标签名：prompt 前 80 字」 */
  function promptLine(p) {
    if (p == null) return "";
    if (typeof p === "string") return p.slice(0, 80);
    const label = p.label || p.name || p.title || p.id || "未命名";
    const text = String(p.prompt || p.text || p.content || "");
    return label + "：" + (text ? text.slice(0, 80) : "（无提示词）");
  }
  function tplName(t) {
    if (typeof t === "string") return t;
    return (t && (t.name || t.title || t.id)) || "未命名模板";
  }
  /** 剪贴板（nsIClipboardHelper，参考 note-templates.js _writeClipboard） */
  function copyText(text) {
    try {
      const clip = Components.classes["@mozilla.org/widget/clipboardhelper;1"]
        .getService(Components.interfaces.nsIClipboardHelper);
      clip.copyString(String(text || ""));
      return true;
    } catch (e) {
      log(e);
      return false;
    }
  }

  function boot() {
    const $ = (id) => document.getElementById(id);
    const rootEl = $("pp-ss-root");
    if (!rootEl) return;

    // boot 时再取一次（核心域可能在窗口打开瞬间才注入）
    SP = (PP && PP.skillPacks) || SP || null;
    CT = (PP && PP.commandTags) || CT || null;

    /* ---------- 主题（自定义界面主题优先；无则跟随系统深浅色，CSS @media 兜底） ---------- */
    try {
      let dark = false;
      const theme = PP && PP.uiTheme && PP.uiTheme.current ? PP.uiTheme.current() : null;
      if (theme && theme.dark) dark = true;
      else if (window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: dark)").matches) dark = true;
      rootEl.setAttribute("data-theme", dark ? "dark" : "light");
    } catch (e) {
      rootEl.setAttribute("data-theme", "light");
    }

    const barList = $("pp-ss-bar-list");
    const barDetail = $("pp-ss-bar-detail");
    const barMaker = $("pp-ss-bar-maker");
    const mainEl = $("pp-ss-main");
    const viewList = $("pp-ss-view-list");
    const viewDetail = $("pp-ss-view-detail");
    const viewMaker = $("pp-ss-view-maker");
    const searchEl = $("pp-ss-search");
    const refreshBtn = $("pp-ss-refresh");
    const makeBtn = $("pp-ss-make");
    const backDetailBtn = $("pp-ss-back-detail");
    const backMakerBtn = $("pp-ss-back-maker");
    const detailTitleEl = $("pp-ss-detail-title");
    const catsEl = $("pp-ss-cats");
    const tagsEl = $("pp-ss-tags");
    const installedOnlyEl = $("pp-ss-installed-only");
    const metaEl = $("pp-ss-catalog-meta");
    const gridEl = $("pp-ss-grid");
    const emptyEl = $("pp-ss-empty");
    const emptyTitleEl = $("pp-ss-empty-title");
    const emptySubEl = $("pp-ss-empty-sub");
    const statusEl = $("pp-ss-status");

    /* ---------- 状态 ---------- */
    const state = {
      packs: [], source: "", updatedAt: null,
      query: "", category: "", tag: "",
      installedOnly: false,
      installed: new Map(),   // id(String) -> {version, installedAt, name}
      view: "list",
      detailId: null,
    };
    let lastManifest = null; // 制作器最近生成的 manifest

    function setStatus(text, kind) {
      try {
        statusEl.textContent = text || "";
        statusEl.setAttribute("class", kind === "ok" || kind === "err" ? "pp-ss-st-" + kind : "");
      } catch (e) { log(e); }
    }
    function showEmpty(title, sub) {
      emptyTitleEl.textContent = title || "";
      emptySubEl.textContent = sub || "";
      emptyEl.style.display = "";
      gridEl.textContent = "";
    }
    function hideEmpty() { emptyEl.style.display = "none"; }

    function catList() {
      const cats = tryCall(() => (SP ? SP.CATEGORIES : null), null);
      if (Array.isArray(cats) && cats.length) return cats.map(String);
      return CATEGORIES_FALLBACK.slice();
    }

    /* ==================== 核心就绪检查 ==================== */
    if (!SP || CORE_FNS.some((f) => typeof SP[f] !== "function")) {
      // 友好空态，不抛错；顶栏操作降级为状态提示
      try { metaEl.textContent = ""; } catch (e) { /* ignore */ }
      showEmpty("技能包核心模块未就绪",
        "技能商店依赖 Zotero.PaperPilot.skillPacks，当前无法访问。\n请重启 Zotero 或更新 PaperPilot 后重新打开本窗口。");
      setStatus("技能包核心模块未就绪", "err");
      const deny = guard(() => setStatus("技能包核心模块未就绪，无法执行该操作", "err"));
      try { refreshBtn.addEventListener("click", deny); } catch (e) { /* ignore */ }
      try { makeBtn.addEventListener("click", deny); } catch (e) { /* ignore */ }
      try { searchEl.setAttribute("disabled", "true"); } catch (e) { /* ignore */ }
      return;
    }

    /* ==================== 已安装集合 ==================== */
    function refreshInstalled() {
      state.installed = new Map();
      const list = tryCall(() => SP.listInstalled(), null);
      if (!Array.isArray(list)) return;
      for (const it of list) {
        if (it && it.id != null) {
          state.installed.set(String(it.id), {
            version: it.version != null ? String(it.version) : "",
            installedAt: it.installedAt || null,
            name: it.name || "",
          });
        }
      }
    }
    function instOf(m) {
      try { return state.installed.get(String(m && m.id)) || null; }
      catch (e) { return null; }
    }
    function needUpdateOf(m, inst) {
      if (!inst) return false;
      const cmp = tryCall(() =>
        SP.compareVersion(String((m && m.version) || ""), String(inst.version || "")), 0);
      return cmp === 1; // 目录版本 > 已装版本
    }

    /* ==================== 目录加载 ==================== */
    async function refreshCatalog() {
      refreshBtn.disabled = true;
      setStatus("正在加载目录…");
      const res = await tryCallAsync(() => SP.fetchCatalog(), null);
      let packs = (res && Array.isArray(res.packs)) ? res.packs : null;
      let source = res ? res.source : "";
      let updatedAt = res ? res.updatedAt : null;
      if (!packs) {
        // fetchCatalog 不可用/抛错 → 尝试内置目录兜底
        const bl = tryCall(() => (typeof SP.builtinCatalog === "function" ? SP.builtinCatalog() : null), null);
        if (Array.isArray(bl)) { packs = bl; source = "builtin"; updatedAt = null; }
      }
      refreshBtn.disabled = false;
      if (!packs) {
        state.packs = [];
        metaEl.textContent = "";
        renderCats(); renderTags(); renderList();
        setStatus("目录加载失败：核心模块未返回数据", "err");
        return;
      }
      state.packs = packs;
      state.source = source || "";
      state.updatedAt = updatedAt;
      refreshInstalled();
      renderCats(); renderTags(); renderList();
      const srcName = state.source === "remote" ? "远程" : "内置精选";
      const when = fmtUpdatedAt(state.updatedAt);
      metaEl.textContent = "目录来源：" + srcName + (when ? " · 更新于 " + when : "");
      setStatus("目录已加载：" + packs.length + " 个技能包（" + srcName + "）", "ok");
    }

    /* ==================== 视图切换 ==================== */
    function showView(v) {
      state.view = v;
      barList.style.display = v === "list" ? "flex" : "none";
      barDetail.style.display = v === "detail" ? "flex" : "none";
      barMaker.style.display = v === "maker" ? "flex" : "none";
      viewList.style.display = v === "list" ? "flex" : "none";
      viewDetail.style.display = v === "detail" ? "flex" : "none";
      viewMaker.style.display = v === "maker" ? "flex" : "none";
      try { mainEl.scrollTop = 0; } catch (e) { /* ignore */ }
      if (v === "list") renderList();
    }

    /* ==================== 列表渲染 ==================== */
    function chip(label, on, onClick) {
      const b = el("button", "pp-ss-chip" + (on ? " pp-ss-chip-on" : ""), label);
      b.setAttribute("type", "button");
      b.addEventListener("click", guard(onClick));
      return b;
    }
    function renderCats() {
      catsEl.textContent = "";
      catsEl.appendChild(el("span", "pp-ss-chips-label", "分类："));
      catsEl.appendChild(chip("全部", state.category === "", () => {
        state.category = ""; renderCats(); renderList();
      }));
      for (const c of catList()) {
        catsEl.appendChild(chip(c, state.category === c, () => {
          state.category = c; renderCats(); renderList();
        }));
      }
    }
    function renderTags() {
      tagsEl.textContent = "";
      const seen = new Set();
      for (const m of state.packs) {
        if (m && Array.isArray(m.tags)) {
          for (const t of m.tags) {
            const s = String(t);
            if (s && !seen.has(s)) seen.add(s);
          }
        }
      }
      const tags = Array.from(seen).slice(0, 12); // 去重，≤12 个
      if (!tags.length) return;
      tagsEl.appendChild(el("span", "pp-ss-chips-label", "标签："));
      for (const t of tags) {
        tagsEl.appendChild(chip("#" + t, state.tag === t, () => {
          state.tag = state.tag === t ? "" : t; // 再点取消
          renderTags(); renderList();
        }));
      }
    }
    function renderList() {
      gridEl.textContent = "";
      const installedIds = new Set(state.installed.keys());
      // ★ 0.48.4 接缝修复：searchPacks 契约是「installedIds 给定时只留已装」——
      //   空 Set 也是 truthy 且有 .has，无条件传参会把全部目录包滤光
      //   （0.48.0 起商店列表一直为空的根因）。只在「仅看已安装」时传。
      let list = tryCall(() => SP.searchPacks(state.packs, {
        query: state.query, category: state.category, tag: state.tag,
        installedIds: state.installedOnly ? installedIds : undefined,
      }), null);
      if (!Array.isArray(list)) list = state.packs; // searchPacks 异常 → 安静降级为全量
      if (state.installedOnly) list = list.filter((m) => m && installedIds.has(String(m.id)));

      if (!list.length) {
        if (!state.packs.length) {
          showEmpty("目录为空", "当前目录没有技能包，点击上方「🔄 刷新目录」重新加载。");
        } else {
          showEmpty("没有匹配的技能包", "试试更换关键词、切换分类或标签，或取消「仅看已安装」。");
        }
        return;
      }
      hideEmpty();
      for (const m of list) {
        if (m) gridEl.appendChild(renderCard(m));
      }
    }
    function renderCard(m) {
      const card = el("div", "pp-ss-card");
      card.addEventListener("click", guard(() => openDetail(m)));

      const head = el("div", "pp-ss-card-head");
      head.appendChild(el("span", "pp-ss-card-name", String(m.name || m.id || "未命名")));
      head.appendChild(el("span", "pp-ss-ver", "v" + (m.version || "0")));
      card.appendChild(head);
      if (m.author) card.appendChild(el("div", "pp-ss-card-author", "作者：" + m.author));

      const meta = el("div", "pp-ss-card-meta");
      meta.appendChild(el("span", "pp-ss-cat", String(m.category || "综合")));
      if (Array.isArray(m.tags) && m.tags.length) {
        meta.appendChild(el("span", "pp-ss-card-tags", m.tags.map((t) => "#" + t).join(" ")));
      }
      card.appendChild(meta);

      if (m.rating != null && isFinite(Number(m.rating))) {
        card.appendChild(el("div", "pp-ss-card-rate",
          "★ " + fmtRating(m.rating) + " (" + fmtInt(m.ratingsCount || 0) + ")"));
      } else {
        card.appendChild(el("div", "pp-ss-card-rate none", "暂无评分"));
      }

      card.appendChild(el("div", "pp-ss-card-desc", String(m.desc || "")));

      const btns = el("div", "pp-ss-card-btns");
      const inst = instOf(m);
      const updatable = needUpdateOf(m, inst);
      if (!inst) {
        const b = el("button", "pp-ss-btn pp-ss-btn-primary pp-ss-btn-sm", "安装");
        b.setAttribute("type", "button");
        b.addEventListener("click", guard((ev) => { ev.stopPropagation(); doInstall(m, b, false); }));
        btns.appendChild(b);
      } else if (updatable) {
        const b = el("button", "pp-ss-btn pp-ss-btn-primary pp-ss-btn-sm", "↑ 更新");
        b.setAttribute("type", "button");
        b.addEventListener("click", guard((ev) => { ev.stopPropagation(); doInstall(m, b, true); }));
        btns.appendChild(b);
      } else {
        btns.appendChild(el("span", "pp-ss-installed", "已装 v" + (inst.version || "?")));
      }
      btns.appendChild(el("span", "pp-ss-spacer", ""));
      const d = el("button", "pp-ss-btn pp-ss-btn-sm", "详情");
      d.setAttribute("type", "button");
      d.addEventListener("click", guard((ev) => { ev.stopPropagation(); openDetail(m); }));
      btns.appendChild(d);
      card.appendChild(btns);
      return card;
    }

    /* ==================== 安装 / 卸载 ==================== */
    async function doInstall(m, btn, isUpdate) {
      if (btn) { btn.disabled = true; btn.textContent = isUpdate ? "更新中…" : "安装中…"; }
      setStatus((isUpdate ? "正在更新：" : "正在安装：") + (m.name || m.id) + "…");
      const res = await tryCallAsync(() => SP.install(m), null);
      if (res && res.ok) {
        refreshInstalled();
        const a = res.applied || {};
        let msg = "已安装：" + (m.name || m.id) + " — 标签 " + countOf(a.prompts) +
          " · 术语 " + countOf(a.glossary) + " · 模板 " + countOf(a.templates);
        if (a.agentPreset) msg += " · 含 Agent 预设（详情页可应用）";
        setStatus(msg, "ok");
        afterMutation(m.id);
      } else {
        setStatus((isUpdate ? "更新失败：" : "安装失败：") + ((res && res.error) || "未知错误"), "err");
        afterMutation(m.id); // 重建卡片恢复按钮
      }
    }

    /** 安装/卸载/应用预设后统一刷新当前视图 */
    function afterMutation(packId) {
      try {
        if (state.view === "list") { renderList(); return; }
        if (state.view === "detail" && state.detailId != null && String(state.detailId) === String(packId)) {
          const m = state.packs.find((p) => p && String(p.id) === String(packId));
          if (m) renderDetail(m);
        }
      } catch (e) { log(e); }
    }

    function doUninstall(m) {
      guard(async () => {
        setStatus("正在卸载：" + (m.name || m.id) + "…");
        const res = await tryCallAsync(() =>
          (typeof SP.uninstall === "function" ? SP.uninstall(m.id) : Promise.resolve(null)), null);
        if (res && res.ok) {
          refreshInstalled();
          const r = res.removed || {};
          setStatus("已卸载：" + (m.name || m.id) + " — 移除 标签 " + countOf(r.prompts) +
            " · 术语 " + countOf(r.glossary) + " · 模板 " + countOf(r.templates), "ok");
          afterMutation(m.id);
        } else if (!res) {
          setStatus("卸载失败：核心模块未提供卸载能力", "err");
        } else {
          setStatus("卸载失败：" + (res.error || "未知错误"), "err");
        }
      })();
    }

    /** 卸载二次确认：优先 Services.prompt.confirm；拿不到 → 按钮先变「确认卸载？」再点执行 */
    function requestUninstall(m, btn) {
      let confirmed = false;
      let promptAvailable = false;
      try {
        const Sv = getServices();
        if (Sv && Sv.prompt && typeof Sv.prompt.confirm === "function") {
          promptAvailable = true;
          confirmed = !!Sv.prompt.confirm(window, "PaperPilot · 技能商店",
            "确定要卸载「" + (m.name || m.id) + "」吗？");
        }
      } catch (e) { promptAvailable = false; confirmed = false; log(e); }
      if (promptAvailable) {
        if (confirmed) doUninstall(m);
        return;
      }
      // 降级：双击确认
      if (!btn) { doUninstall(m); return; }
      if (btn.__ppConfirm) {
        btn.__ppConfirm = false;
        btn.textContent = "卸载";
        doUninstall(m);
        return;
      }
      btn.__ppConfirm = true;
      btn.textContent = "确认卸载？";
      window.setTimeout(() => {
        try {
          if (btn.isConnected && btn.__ppConfirm) {
            btn.__ppConfirm = false;
            btn.textContent = "卸载";
          }
        } catch (e) { /* ignore */ }
      }, 2500);
    }

    /* ==================== 详情视图 ==================== */
    function openDetail(m) {
      state.detailId = m && m.id != null ? String(m.id) : null;
      renderDetail(m);
      showView("detail");
    }

    function findPack(id) {
      return state.packs.find((p) => p && String(p.id) === String(id)) || null;
    }

    function renderDetail(m) {
      if (!m) {
        const found = state.detailId != null ? findPack(state.detailId) : null;
        if (!found) { showView("list"); setStatus("该技能包已不在当前目录中", "err"); return; }
        m = found;
      }
      viewDetail.textContent = "";
      detailTitleEl.textContent = String(m.name || m.id || "");
      const inst = instOf(m);
      const updatable = needUpdateOf(m, inst);
      const c = (m.contents && typeof m.contents === "object") ? m.contents : {};

      /* ---- 头部 ---- */
      const head = el("div", "pp-ss-d-head");
      head.appendChild(el("span", "pp-ss-d-name", String(m.name || m.id || "")));
      head.appendChild(el("span", "pp-ss-ver", "v" + (m.version || "0")));
      viewDetail.appendChild(head);

      const bits = [];
      if (m.author) bits.push("作者：" + m.author);
      if (m.category) bits.push("分类：" + m.category);
      if (Array.isArray(m.tags) && m.tags.length) bits.push("标签：" + m.tags.map((t) => "#" + t).join(" "));
      if (m.downloads != null) bits.push("下载 " + fmtInt(m.downloads));
      if (m.rating != null && isFinite(Number(m.rating))) {
        bits.push("官方目录评分：★" + fmtRating(m.rating) + " (" + fmtInt(m.ratingsCount || 0) + ")");
      }
      const headMeta = el("div", "pp-ss-d-sub", bits.join(" · "));
      viewDetail.appendChild(headMeta);
      viewDetail.appendChild(el("div", "pp-ss-d-sub", inst
        ? "已安装 v" + (inst.version || "?") + (inst.installedAt ? " · " + relTime(inst.installedAt) : "")
        : "未安装"));

      /* ---- 介绍（longDesc 无则 desc）与 changelog ---- */
      viewDetail.appendChild(el("div", "pp-ss-d-desc", String(m.longDesc || m.desc || "")));
      if (m.changelog) {
        viewDetail.appendChild(el("div", "pp-ss-sec-title", "更新日志"));
        viewDetail.appendChild(el("pre", "pp-ss-d-changelog", String(m.changelog)));
      }

      /* ---- 内容清单（manifest.contents 有什么列什么） ---- */
      viewDetail.appendChild(el("div", "pp-ss-sec-title", "内容清单"));
      let hasContent = false;
      if (Array.isArray(c.prompts) && c.prompts.length) {
        hasContent = true;
        const box = el("div");
        box.appendChild(el("div", "pp-ss-hint", "Prompt 标签（" + c.prompts.length + " 个）"));
        for (const p of c.prompts) box.appendChild(el("div", "pp-ss-list-item", promptLine(p)));
        viewDetail.appendChild(box);
      }
      const glEntries = glossaryEntries(c.glossary || null);
      if (glEntries.length) {
        hasContent = true;
        const box = el("div");
        box.appendChild(el("div", "pp-ss-hint", "术语表"));
        for (const g of glEntries.slice(0, 6)) box.appendChild(el("div", "pp-ss-list-item", glossaryLine(g)));
        if (glEntries.length > 6) box.appendChild(el("div", "pp-ss-list-item", "…共 " + glEntries.length + " 条"));
        viewDetail.appendChild(box);
      }
      const tpls = Array.isArray(c.noteTemplates) ? c.noteTemplates : [];
      if (tpls.length) {
        hasContent = true;
        const box = el("div");
        box.appendChild(el("div", "pp-ss-hint", "笔记模板（" + tpls.length + " 个）"));
        for (const t of tpls) box.appendChild(el("div", "pp-ss-list-item", tplName(t)));
        viewDetail.appendChild(box);
      }
      if (c.agentPreset) {
        hasContent = true;
        viewDetail.appendChild(el("div", "pp-ss-list-item",
          "包含 Agent 预设（chatAgentMode / 工具白名单 / 轮数上限 / System Prompt 追加）"));
      }
      if (!hasContent) viewDetail.appendChild(el("div", "pp-ss-hint", "（此技能包未声明内容清单）"));

      /* ---- 操作行 ---- */
      const actRow = el("div", "pp-ss-actrow");
      if (!inst) {
        const b = el("button", "pp-ss-btn pp-ss-btn-primary", "安装");
        b.setAttribute("type", "button");
        b.addEventListener("click", guard(() => doInstall(m, b, false)));
        actRow.appendChild(b);
      } else {
        if (updatable) {
          const b = el("button", "pp-ss-btn pp-ss-btn-primary", "↑ 更新");
          b.setAttribute("type", "button");
          b.addEventListener("click", guard(() => doInstall(m, b, true)));
          actRow.appendChild(b);
        } else {
          actRow.appendChild(el("span", "pp-ss-installed", "已装 v" + (inst.version || "?")));
        }
        const u = el("button", "pp-ss-btn pp-ss-btn-danger", "卸载");
        u.setAttribute("type", "button");
        u.addEventListener("click", guard(() => requestUninstall(m, u)));
        actRow.appendChild(u);
      }
      const x = el("button", "pp-ss-btn", "导出 JSON");
      x.setAttribute("type", "button");
      x.addEventListener("click", guard(() => {
        if (typeof SP.exportPack !== "function") {
          setStatus("导出失败：核心模块未提供导出能力", "err");
          return;
        }
        const text = tryCall(() => SP.exportPack(m.id), null);
        if (text == null) { setStatus("导出失败：核心模块未返回数据", "err"); return; }
        const ok = copyText(String(text));
        setStatus(ok ? "✓ 已复制技能包 JSON 到剪贴板" : "复制失败：剪贴板不可用", ok ? "ok" : "err");
      }));
      actRow.appendChild(x);
      if (inst && c.agentPreset) {
        const a = el("button", "pp-ss-btn", "应用 Agent 预设");
        a.setAttribute("type", "button");
        a.addEventListener("click", guard(async () => {
          if (typeof SP.applyAgentPreset !== "function") {
            setStatus("应用失败：核心模块未提供 applyAgentPreset 能力", "err");
            return;
          }
          setStatus("正在应用 Agent 预设…");
          const res = await tryCallAsync(() => SP.applyAgentPreset(m.id), null);
          if (res && res.ok) {
            const applied = Array.isArray(res.applied) ? res.applied : [];
            setStatus("已应用 Agent 预设" +
              (applied.length ? "：" + applied.map(String).join("、") : ""), "ok");
          } else {
            setStatus("应用失败：" + ((res && res.error) || "未知错误"), "err");
          }
        }));
        actRow.appendChild(a);
      }
      viewDetail.appendChild(actRow);

      /* ---- 我的评分评价表单 ---- */
      viewDetail.appendChild(renderRateForm(m));
    }

    function renderRateForm(m) {
      const form = el("div", "pp-ss-rate-form");
      form.appendChild(el("div", "pp-ss-sec-title", "我的评分"));
      const mine = (typeof SP.getRating === "function")
        ? tryCall(() => SP.getRating(m.id), null) : null;
      let selected = (mine && Number(mine.stars)) || 0;

      const starrow = el("div", "pp-ss-starrow");
      const starBtns = [];
      for (let i = 1; i <= 5; i++) {
        const b = el("button", "pp-ss-star", "★");
        b.setAttribute("type", "button");
        b.setAttribute("title", i + " 星");
        b.addEventListener("click", guard(() => {
          selected = i;
          paintStars();
        }));
        starBtns.push(b);
        starrow.appendChild(b);
      }
      function paintStars() {
        for (let idx = 0; idx < starBtns.length; idx++) {
          const on = (idx + 1) <= selected;
          if (on) starBtns[idx].setAttribute("class", "pp-ss-star pp-ss-star-on");
          else starBtns[idx].setAttribute("class", "pp-ss-star");
        }
      }
      paintStars();
      form.appendChild(starrow);

      const ta = el("textarea", "pp-ss-textarea");
      ta.setAttribute("no-native", "true");
      ta.setAttribute("rows", "3");
      ta.setAttribute("placeholder", "这个技能包用得怎么样？给后来的使用者一点参考");
      if (mine && mine.comment) ta.value = String(mine.comment);
      form.appendChild(ta);

      const myMeta = el("div", "pp-ss-hint", mine
        ? "已有我的评价" + (mine.at ? " · " + relTime(mine.at) : "") : "还没有我的评价（与官方目录评分相互独立）");
      form.appendChild(myMeta);

      const row = el("div", "pp-ss-actrow");
      const saveBtn = el("button", "pp-ss-btn pp-ss-btn-primary pp-ss-btn-sm", "保存评价");
      saveBtn.setAttribute("type", "button");
      saveBtn.addEventListener("click", guard(async () => {
        if (!selected) { setStatus("请先点选星级（1-5 星）", "err"); return; }
        if (typeof SP.rate !== "function") {
          setStatus("保存失败：核心模块未提供评价能力", "err");
          return;
        }
        saveBtn.disabled = true;
        const res = await tryCallAsync(() => SP.rate(m.id, selected, ta.value.trim()), null);
        saveBtn.disabled = false;
        if (res && res.ok) {
          myMeta.textContent = "✓ 评价已保存";
          setStatus("✓ 评价已保存", "ok");
        } else {
          setStatus("保存评价失败：" + ((res && res.error) || "未知错误"), "err");
        }
      }));
      const clearBtn = el("button", "pp-ss-btn pp-ss-btn-sm", "清除我的评价");
      clearBtn.setAttribute("type", "button");
      clearBtn.addEventListener("click", guard(() => {
        if (typeof SP.clearRating !== "function") {
          setStatus("清除失败：核心模块未提供清除评价能力", "err");
          return;
        }
        const ok = tryCall(() => { SP.clearRating(m.id); return true; }, false);
        if (!ok) { setStatus("清除失败：核心模块调用异常", "err"); return; }
        selected = 0;
        paintStars();
        ta.value = "";
        myMeta.textContent = "还没有我的评价（与官方目录评分相互独立）";
        setStatus("✓ 已清除我的评价", "ok");
      }));
      row.appendChild(saveBtn);
      row.appendChild(clearBtn);
      form.appendChild(row);
      return form;
    }

    /* ==================== 制作器视图 ==================== */
    const mkName = $("pp-ss-mk-name");
    const mkAuthor = $("pp-ss-mk-author");
    const mkDesc = $("pp-ss-mk-desc");
    const mkCat = $("pp-ss-mk-cat");
    const mkTags = $("pp-ss-mk-tags");
    const mkVer = $("pp-ss-mk-ver");
    const mkGlossary = $("pp-ss-mk-glossary");
    const mkTagsList = $("pp-ss-mk-tags-list");
    const mkTplList = $("pp-ss-mk-tpl-list");
    const mkErrors = $("pp-ss-mk-errors");
    const mkJson = $("pp-ss-mk-json");
    const mkJsonActions = $("pp-ss-mk-json-actions");

    function initMaker() {
      // 分类下拉（每次打开刷新选项，保留已选值）
      try {
        const prev = mkCat.value;
        mkCat.textContent = "";
        for (const c of catList()) {
          const o = el("option", null, c);
          o.setAttribute("value", c);
          mkCat.appendChild(o);
        }
        if (prev) mkCat.value = prev;
      } catch (e) { log(e); }
    }

    function renderMakerTags() {
      // 首次渲染；若上一轮 CT 未就绪（列表为空），下次进入再尝试
      if (mkTagsList.querySelector(".pp-ss-mk-tagrow")) return;
      const all = (CT && typeof CT.all === "function")
        ? tryCall(() => CT.all(), null) : null;
      if (!Array.isArray(all) || !all.length) {
        mkTagsList.appendChild(el("div", "pp-ss-hint",
          "CommandTags 模块未就绪，暂无法勾选 Prompt 标签（名称、术语、模板等其他内容仍可制作）。"));
        return;
      }
      for (const t of all) {
        const row = el("label", "pp-ss-check pp-ss-mk-tagrow");
        const cb = el("input");
        cb.setAttribute("type", "checkbox");
        cb.setAttribute("class", "pp-ss-mk-tag");
        cb.__ppTag = t; // 勾选时回取原始对象
        const cbox = el("span", "pp-ss-cbox");
        const name = el("span", "pp-ss-mk-tagname", String(t.label || t.name || t.id || "未命名"));
        const prev = el("span", "pp-ss-mk-tagprev",
          String(t.prompt || "").slice(0, 40));
        row.appendChild(cb); row.appendChild(cbox); row.appendChild(name); row.appendChild(prev);
        mkTagsList.appendChild(row);
      }
    }

    function addTplRow() {
      const row = el("div", "pp-ss-mk-tplrow");
      const nameI = el("input", "pp-ss-input pp-ss-mk-tplname");
      nameI.setAttribute("type", "text");
      nameI.setAttribute("placeholder", "模板名称");
      const ta = el("textarea", "pp-ss-textarea pp-ss-mk-tplcontent");
      ta.setAttribute("no-native", "true");
      ta.setAttribute("rows", "2");
      ta.setAttribute("placeholder", "模板正文");
      const del = el("button", "pp-ss-btn pp-ss-btn-sm", "移除");
      del.setAttribute("type", "button");
      del.addEventListener("click", guard(() => row.remove()));
      row.appendChild(nameI); row.appendChild(ta); row.appendChild(del);
      mkTplList.appendChild(row);
    }

    function collectTpls() {
      const out = [];
      const rows = mkTplList.querySelectorAll(".pp-ss-mk-tplrow");
      for (const row of rows) {
        const nameI = row.querySelector(".pp-ss-mk-tplname");
        const ta = row.querySelector(".pp-ss-mk-tplcontent");
        const n = nameI ? String(nameI.value || "").trim() : "";
        const body = ta ? String(ta.value || "") : "";
        // ★ 字段名必须是 body（核心域 validate/install 的 noteTemplates 契约；
        //   0.48.x 审查修复：旧值 content 会让含模板的技能包校验必败）
        if (n || body.trim()) out.push({ name: n || "未命名模板", body: body });
      }
      return out;
    }

    function openMaker() {
      initMaker();
      renderMakerTags();
      showView("maker");
    }

    function doBuild() {
      mkErrors.textContent = "";
      const checked = [];
      for (const cb of mkTagsList.querySelectorAll(".pp-ss-mk-tag")) {
        if (cb.checked && cb.__ppTag) {
          // 剥掉其他技能包的 sp:<packId>: 前缀，避免嵌套出 sp:new:sp:old:tag 双前缀
          const rawId = String(cb.__ppTag.id || "");
          const cleanId = rawId.indexOf("sp:") === 0
            ? rawId.split(":").slice(2).join(":") || rawId : rawId;
          checked.push(Object.assign({}, cb.__ppTag, { id: cleanId }));
        }
      }
      const glossaryLines = String(mkGlossary.value || "")
        .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const tpls = collectTpls();
      const partial = {
        name: String(mkName.value || "").trim(),
        author: String(mkAuthor.value || "").trim(),
        desc: String(mkDesc.value || "").trim(),
        version: String(mkVer.value || "").trim() || "1.0.0",
        category: mkCat.value || "综合",
        tags: String(mkTags.value || "").split(/[,，、]/)
          .map((s) => s.trim()).filter(Boolean),
        prompts: checked,
        glossary: glossaryLines,
        noteTemplates: tpls,
        contents: { prompts: checked, glossary: glossaryLines, noteTemplates: tpls },
      };
      if (typeof SP.buildManifest !== "function") {
        setStatus("生成失败：核心模块未提供 buildManifest 能力", "err");
        return;
      }
      const res = tryCall(() => SP.buildManifest(partial), null);
      if (!res) { setStatus("生成失败：核心模块调用异常", "err"); return; }
      if (res.ok && res.manifest) {
        lastManifest = res.manifest;
        mkJson.textContent = JSON.stringify(res.manifest, null, 2);
        mkJson.style.display = "";
        mkJsonActions.style.display = "flex";
        setStatus("✓ 技能包已生成，可复制 JSON 或保存为文件", "ok");
        return;
      }
      // errors 逐条显示
      const errors = Array.isArray(res.errors) ? res.errors : [];
      if (!errors.length) errors.push(res.error || "未知错误");
      for (const e of errors) mkErrors.appendChild(el("div", "pp-ss-errline", "• " + e));
      mkJson.style.display = "none";
      mkJsonActions.style.display = "none";
      setStatus("生成失败：请修正上述问题", "err");
    }

    function saveJsonToFile() {
      if (!lastManifest) return;
      const text = JSON.stringify(lastManifest, null, 2);
      try {
        const nsIFilePicker = Components.interfaces.nsIFilePicker;
        const fp = Components.classes["@mozilla.org/filepicker;1"].createInstance(nsIFilePicker);
        fp.init(window, "保存技能包", nsIFilePicker.modeSave);
        fp.defaultString = "skill-pack-" + (lastManifest.id || "pack") + ".json";
        fp.appendFilter("JSON", "*.json");
        fp.open((rv) => {
          try {
            if (rv !== nsIFilePicker.returnOK && rv !== nsIFilePicker.returnReplace) return;
            const fos = Components.classes["@mozilla.org/network/file-output-stream;1"]
              .createInstance(Components.interfaces.nsIFileOutputStream);
            fos.init(fp.file, 0x02 | 0x08 | 0x20, 0o644, 0);
            const cos = Components.classes["@mozilla.org/intl/converter-output-stream;1"]
              .createInstance(Components.interfaces.nsIConverterOutputStream);
            cos.init(fos, "UTF-8");
            cos.writeString(text);
            cos.close();
            fos.close();
            setStatus("✓ 已保存：" + (fp.file && fp.file.path), "ok");
          } catch (e) {
            log(e);
            setStatus("保存失败: " + (e && e.message ? e.message : e), "err");
          }
        });
      } catch (e) {
        log(e);
        setStatus("保存失败: " + (e && e.message ? e.message : e), "err");
      }
    }

    /* ==================== 事件绑定 ==================== */
    searchEl.addEventListener("input", guard(() => {
      state.query = String(searchEl.value || "").trim();
      renderList();
    }));
    refreshBtn.addEventListener("click", guard(() => refreshCatalog()));
    makeBtn.addEventListener("click", guard(() => openMaker()));
    backDetailBtn.addEventListener("click", guard(() => showView("list")));
    backMakerBtn.addEventListener("click", guard(() => showView("list")));
    installedOnlyEl.addEventListener("change", guard(() => {
      state.installedOnly = !!installedOnlyEl.checked;
      renderList();
    }));
    $("pp-ss-mk-add-tpl").addEventListener("click", guard(() => addTplRow()));
    $("pp-ss-mk-build").addEventListener("click", guard(() => doBuild()));
    $("pp-ss-mk-copy").addEventListener("click", guard(() => {
      if (!lastManifest) return;
      const ok = copyText(JSON.stringify(lastManifest, null, 2));
      setStatus(ok ? "✓ JSON 已复制到剪贴板" : "复制失败：剪贴板不可用", ok ? "ok" : "err");
    }));
    $("pp-ss-mk-save").addEventListener("click", guard(() => saveJsonToFile()));
    // 0.48.3 投稿入口：复制 JSON + 打开 GitHub 社区贡献指南（PR/Issue 两种方式）
    $("pp-ss-mk-submit").addEventListener("click", guard(() => {
      const guideUrl = "https://github.com/yebuqiu/paper-pilot/blob/main/community-packs/README.md";
      let copied = false;
      if (lastManifest) {
        copied = copyText(JSON.stringify(lastManifest, null, 2));
      }
      setStatus(copied
        ? "✓ JSON 已复制——正在打开投稿指南，按其步骤粘贴即可（支持 PR 与 Issue 两种方式）"
        : "正在打开投稿指南（复制 JSON 失败可回到上方「复制 JSON」按钮）", copied ? "ok" : "");
      try {
        if (Z && typeof Z.launchURL === "function") Z.launchURL(guideUrl);
        else if (typeof window !== "undefined" && window.open) window.open(guideUrl);
      } catch (e) { log(e); }
    }));

    // Esc：详情/制作器 → 返回列表；列表视图无操作。
    // 焦点在输入控件（评分评语 / 制作器表单）时忽略 Esc——防误触丢输入内容。
    window.addEventListener("keydown", (ev) => {
      try {
        if (ev.key !== "Escape" || ev.isComposing) return;
        const t = ev.target;
        if (t) {
          const tag = String(t.nodeName || "").toLowerCase();
          if (tag === "textarea" || tag === "input" || tag === "select") return;
        }
        if (state.view === "detail" || state.view === "maker") showView("list");
      } catch (e) { log(e); }
    });

    /* ==================== 启动 ==================== */
    refreshInstalled();
    renderCats();
    renderTags();
    renderList();
    refreshCatalog();
    try { searchEl.focus(); } catch (e) { /* ignore */ }
  }

  // ★ 时序守卫（§39 纪律）：XUL 顶部 script 先于 DOM 执行，等 DOMContentLoaded 再 boot
  if (document.readyState === "loading") {
    addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
