/* PaperPilot · 综述工作台窗口逻辑（0.53.0）
 *
 * 运行在独立 XUL 窗口作用域，窗口参数经 window.arguments 传入：
 *   { Zotero, Services, metas, itemIDs, api, trimmed, maxItems }
 *   · api = 全局 ReviewWorkbench 单例（纯函数 + 编排都在这，窗口只做显示）；
 *   · 不依赖 window.opener / 全局 Zotero（真机实证：新 chrome 窗口里没有
 *     Zotero 全局，opener.Zotero 也不可靠，唯一通道是 arguments）。
 *
 * 三个纪律（同 skill-store.js）：
 *   1) 时序守卫：顶部 script 先于 DOM 执行 → boot() + readyState 双保险；
 *   2) 动态 textarea 一律 setAttribute("no-native","true")（本窗口无动态表单，
 *      仍是静态保险）；
 *   3) 所有 UI 回调经 guard() 自包 try-catch（含 Promise rejection），反馈集中
 *      固定状态条，不弹 alert。
 *
 * 交互流程：
 *   ① 生成大纲 → 中栏出现「## n. 标题 + 说明」，激活 ②（可手改后重新点 ②）
 *   ② 逐节起草 → 顺序调 AI，状态条显示「3/6 节」，完成后拼全文 + 引用转链接
 *   ③ 保存为笔记 / 导出 Markdown（文件保存对话框）
 * 本窗口不创建任何 timer，关闭即无残留。
 */
/* global window, document, addEventListener, Components */
(function () {
  "use strict";

  const XHTML = "http://www.w3.org/1999/xhtml";
  const args = (window.arguments && window.arguments[0]) || {};
  const Z = args.Zotero || null;
  const PP = Z && Z.PaperPilot ? Z.PaperPilot : null;
  let API = args.api || (PP && PP.reviewWorkbench) || null;
  let metas = Array.isArray(args.metas) ? args.metas.slice() : [];
  let trimmed = !!args.trimmed;
  let maxItems = Number(args.maxItems) || 30;

  let busy = false;
  let hasDraft = false;

  function log(e) {
    try {
      const msg = "review-workbench error: " + (e && (e.stack || e.message) ? (e.stack || e.message) : String(e));
      if (PP && PP._diag) PP._diag(msg);
      else if (Z && Z.logError) Z.logError(e || msg);
    } catch (_) { /* ignore */ }
  }

  try {
    window.addEventListener("error", (ev) => {
      try {
        if (PP && PP._diag) {
          PP._diag("review-workbench error: " + (ev && ev.message) + " @" +
            String((ev && ev.filename) || "").split("/").pop() + ":" + (ev && ev.lineno));
        }
      } catch (e) { /* ignore */ }
    });
  } catch (e) { /* ignore */ }

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

  function el(tag, cls, text) {
    const n = document.createElementNS(XHTML, tag);
    if (cls) n.setAttribute("class", cls);
    if (text != null) n.textContent = text;
    return n;
  }

  /** 大纲数组 → 可编辑文本（与 parseOutline 的输入格式一致） */
  function outlineToText(outline) {
    return (outline || []).map((s) =>
      "## " + (s.n != null ? s.n : 1) + ". " + (s.title || "") +
      (s.desc ? "\n" + s.desc : "")).join("\n\n");
  }

  /** 安全的 markdown 文件名 */
  function safeName(s) {
    return (String(s || "文献综述").replace(/[\\/:*?"<>|\r\n]+/g, "_").trim() || "文献综述").slice(0, 120);
  }

  function boot() {
    const $ = (id) => document.getElementById(id);
    const rootEl = $("pp-rw-root");
    if (!rootEl) return;

    API = API || (PP && PP.reviewWorkbench) || null;

    /* ---------- 主题（自定义界面主题优先；无则跟随系统，CSS @media 兜底） ---------- */
    try {
      let dark = false;
      const theme = PP && PP.uiTheme && PP.uiTheme.current ? PP.uiTheme.current() : null;
      if (theme && theme.dark) dark = true;
      else if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) dark = true;
      rootEl.setAttribute("data-theme", dark ? "dark" : "light");
    } catch (e) {
      rootEl.setAttribute("data-theme", "light");
    }

    const countEl = $("pp-rw-count");
    const trimmedEl = $("pp-rw-trimmed");
    const hintEl = $("pp-rw-hint");
    const listEl = $("pp-rw-list");
    const titleEl = $("pp-rw-doctitle");
    const outlineEl = $("pp-rw-outline");
    const draftEl = $("pp-rw-draft");
    const genOutlineBtn = $("pp-rw-gen-outline");
    const genDraftBtn = $("pp-rw-gen-draft");
    const saveBtn = $("pp-rw-save");
    const exportBtn = $("pp-rw-export");
    const statusEl = $("pp-rw-status");
    const progressEl = $("pp-rw-progress");

    function setStatus(text, kind) {
      try {
        statusEl.textContent = text || "";
        statusEl.setAttribute("class",
          kind === "ok" ? "pp-rw-ok" : kind === "err" ? "pp-rw-err" : kind === "warn" ? "pp-rw-warn" : "");
      } catch (e) { log(e); }
    }
    function setHint(text, kind) {
      try {
        hintEl.textContent = text || "";
        hintEl.setAttribute("class",
          kind === "err" ? "pp-rw-err" : kind === "warn" ? "pp-rw-warn" : "");
      } catch (e) { log(e); }
    }
    function setProgress(text) {
      try { progressEl.textContent = text || ""; } catch (e) { log(e); }
    }

    /** 当前按钮可用性（集中一处，避免各分支漏改） */
    function refreshControls() {
      const aiOk = !!AI_OK;
      const secs = API ? API.parseOutline(outlineEl.value || "") : [];
      genOutlineBtn.disabled = busy || !aiOk || !metas.length;
      genDraftBtn.disabled = busy || !aiOk || !metas.length || !secs.length;
      saveBtn.disabled = busy || !hasDraft;
      exportBtn.disabled = busy || !hasDraft;
    }

    /* ---------- 依赖检查 ---------- */
    let AI_OK = false;
    if (!API || typeof API.generateOutline !== "function" ||
      typeof API.draftSections !== "function" || typeof API.parseOutline !== "function") {
      setHint("核心模块未就绪（ReviewWorkbench 未加载）。请重启 Zotero 或更新 PaperPilot 后重试。", "err");
      setStatus("核心模块未就绪", "err");
      genOutlineBtn.disabled = true;
      genDraftBtn.disabled = true;
      saveBtn.disabled = true;
      exportBtn.disabled = true;
      return;
    }

    let ready = { ok: false, guidance: "" };
    try { ready = API.aiReady(); } catch (e) { ready = { ok: false, guidance: "" }; }
    AI_OK = !!(ready && ready.ok);
    if (!AI_OK) {
      setHint("AI 未就绪：" + (ready.guidance || "请先在 设置 → PaperPilot 登录或配置模型通道") + "（配置后重开本窗口）", "err");
      setStatus("AI 未配置：按钮已禁用", "warn");
    } else {
      setHint("流程：① 生成大纲（可手改）→ ② 逐节起草 → ③ 保存为笔记 / 导出 Markdown");
      setStatus("");
    }

    /* ---------- 左栏：文献清单 ---------- */
    function renderList() {
      listEl.textContent = "";
      if (!metas.length) {
        listEl.appendChild(el("div", "pp-rw-empty", "没有传入文献。请关闭窗口，在条目列表中选中多篇文献后重新打开。"));
        countEl.textContent = "0 篇";
        return;
      }
      for (let i = 0; i < metas.length; i++) {
        const m = metas[i] || {};
        const row = el("div", "pp-rw-item");
        row.appendChild(el("span", "pp-rw-num", String(i + 1)));
        const main = el("div", "pp-rw-itemmain");
        main.appendChild(el("div", "pp-rw-itemtitle", String(m.title || "（无标题）")));
        const bits = [];
        if (m.year) bits.push(String(m.year));
        if (m.journal) bits.push(String(m.journal));
        if (bits.length) main.appendChild(el("div", "pp-rw-itemmeta", bits.join(" · ")));
        row.appendChild(main);
        listEl.appendChild(row);
      }
      countEl.textContent = metas.length + " 篇";
      trimmedEl.textContent = trimmed ? "（已达上限 " + maxItems + " 篇，其余未载入）" : "";
      if (trimmed) {
        setHint("已选文献超过 " + maxItems + " 篇上限，仅载入前 " + maxItems + " 篇（可分批处理）。", "warn");
      }
    }

    /** 单实例复用时换入新题录（由 ReviewWorkbench.openDialog 调用） */
    window.PaperPilotSetPayload = function (payload) {
      try {
        const p = payload || {};
        if (Array.isArray(p.metas)) metas = p.metas.slice();
        if (p.trimmed != null) trimmed = !!p.trimmed;
        hasDraft = false;
        draftEl.value = "";
        outlineEl.value = "";
        setProgress("");
        renderList();
        refreshControls();
        setStatus("已换入新的文献清单", "ok");
      } catch (e) { log(e); }
    };

    /* ---------- ① 生成大纲 ---------- */
    async function doOutline() {
      if (busy) return;
      busy = true;
      refreshControls();
      genOutlineBtn.textContent = "生成中…";
      setStatus("AI 正在规划分节大纲…");
      try {
        const res = await API.generateOutline(metas);
        if (res && res.ok) {
          outlineEl.value = outlineToText(res.outline);
          setStatus("✓ 已生成 " + res.outline.length + " 节大纲，可手动修改后再起草", "ok");
          setProgress("");
        } else if (res && res.reason === "no_key") {
          AI_OK = false;
          setStatus("AI 未就绪：" + (res.guidance || "请先登录或配置模型通道"), "err");
          setHint("AI 未就绪：" + (res.guidance || ""), "err");
        } else {
          setStatus("生成大纲失败：" + ((res && (res.error || res.reason)) || "未知错误"), "err");
        }
      } finally {
        busy = false;
        genOutlineBtn.textContent = "① 生成大纲";
        refreshControls();
      }
    }

    /* ---------- ② 逐节起草 ---------- */
    async function doDraft() {
      if (busy) return;
      const outline = API.parseOutline(outlineEl.value || "");
      if (!outline.length) {
        setStatus("没有可用大纲：请先点「① 生成大纲」，或按「## 1. 标题」格式手动输入", "err");
        return;
      }
      busy = true;
      hasDraft = false;
      draftEl.value = "";
      refreshControls();
      genDraftBtn.textContent = "起草中…";
      setStatus("开始逐节起草…");

      const title = String(titleEl.value || "").trim() || "文献综述";
      try {
        const res = await API.draftSections(metas, outline, (done, total) => {
          setStatus("正在起草 " + done + "/" + total + " 节…");
          setProgress(done + "/" + total + " 节");
        });
        if (res && res.sections && res.sections.length) {
          const assembled = API.assembleDraft(title, metas, outline, res.sections);
          draftEl.value = API.citeToLink(assembled, metas);
          hasDraft = true;
          const failed = (res.failed || []).length;
          setStatus(failed
            ? "✓ 已完成 " + res.sections.length + "/" + outline.length + " 节（" + failed + " 节失败，可再次点「②」重试全部）"
            : "✓ 全部 " + res.sections.length + " 节已完成，引用已转为可点击链接", failed ? "warn" : "ok");
          setProgress("完成 " + res.sections.length + "/" + outline.length +
            (failed ? "（失败 " + failed + "）" : ""));
        } else if (res && res.reason === "no_key") {
          AI_OK = false;
          setStatus("AI 未就绪：" + (res.guidance || "请先登录或配置模型通道"), "err");
        } else {
          setStatus("起草失败：" + ((res && (res.error || res.reason)) || "所有小节均未返回内容"), "err");
        }
      } finally {
        busy = false;
        genDraftBtn.textContent = "② 逐节起草";
        refreshControls();
      }
    }

    /* ---------- ③ 保存为笔记 ---------- */
    async function doSave() {
      if (busy || !hasDraft) return;
      busy = true;
      refreshControls();
      setStatus("正在保存笔记…");
      try {
        const title = String(titleEl.value || "").trim() || "文献综述";
        const res = await API.saveAsNote(metas, draftEl.value, title);
        if (res && res.ok) {
          setStatus("✓ 已保存为笔记" + (res.noteID != null ? "（ID " + res.noteID + "）" : "") + "，挂在第 1 篇文献下", "ok");
        } else if (res && res.reason === "notes_unavailable") {
          setStatus("保存失败：笔记模块不可用（Notes.createFromMarkdown 缺失）", "err");
        } else if (res && res.reason === "no_item") {
          setStatus("保存失败：找不到可挂靠的文献条目（可改用「导出 Markdown」）", "err");
        } else {
          setStatus("保存失败：" + ((res && (res.error || res.reason)) || "未知错误"), "err");
        }
      } finally {
        busy = false;
        refreshControls();
      }
    }

    /* ---------- ④ 导出 Markdown（nsIFilePicker，同 skill-store 写法） ---------- */
    function doExport() {
      if (!hasDraft) return;
      const text = String(draftEl.value || "");
      const name = safeName(String(titleEl.value || "").trim() || "文献综述") + ".md";
      try {
        const nsIFilePicker = Components.interfaces.nsIFilePicker;
        const fp = Components.classes["@mozilla.org/filepicker;1"].createInstance(nsIFilePicker);
        fp.init(window, "导出综述 Markdown", nsIFilePicker.modeSave);
        fp.defaultString = name;
        try { fp.defaultExtension = "md"; } catch (e) { /* ignore */ }
        fp.appendFilter("Markdown", "*.md");
        try { fp.appendFilters(nsIFilePicker.filterAll); } catch (e) { /* ignore */ }
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
            setStatus("✓ 已导出：" + (fp.file && fp.file.path), "ok");
          } catch (e) {
            log(e);
            setStatus("导出失败：" + ((e && e.message) || e), "err");
          }
        });
      } catch (e) {
        log(e);
        setStatus("导出失败：" + ((e && e.message) || e), "err");
      }
    }

    /* ---------- 事件 ---------- */
    genOutlineBtn.addEventListener("click", guard(() => doOutline()));
    genDraftBtn.addEventListener("click", guard(() => doDraft()));
    saveBtn.addEventListener("click", guard(() => doSave()));
    exportBtn.addEventListener("click", guard(() => doExport()));
    outlineEl.addEventListener("input", guard(() => refreshControls()));

    // Esc 关闭（焦点在文本域时让浏览器处理，避免误关丢草稿）
    window.addEventListener("keydown", (ev) => {
      try {
        if (ev.key !== "Escape" || ev.isComposing) return;
        const t = ev.target;
        const tag = t ? String(t.nodeName || "").toLowerCase() : "";
        if (tag === "textarea" || tag === "input") return;
        window.close();
      } catch (e) { log(e); }
    });

    /* ---------- 启动 ---------- */
    if (!String(titleEl.value || "").trim()) titleEl.value = "文献综述";
    renderList();
    refreshControls();
    try { outlineEl.focus(); } catch (e) { /* ignore */ }
  }

  // 时序守卫：XUL 顶部 script 先于 DOM 执行
  if (document.readyState === "loading") {
    addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
