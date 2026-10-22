// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 设置窗格脚本·翻译引擎（0.28.0 新增）
 * 与 prefs-pane.js / prefs-account.js 同窗格运行；经 Zotero.Papilot.translateSvc
 * 访问 bootstrap 作用域的 TranslateSvc 模块（设置窗口访问不到 bootstrap 作用域）。
 *
 * 渲染内容：状态行 + 当前引擎/源语言/目标语言 + 回退链 + 超时/重试/缓存
 *          + 全部引擎列表（设为主引擎 / 纳入回退 / 填写密钥 / 实测）
 *
 * 语言两项（源/目标）走 prefs.xhtml 的 preference= 声明式绑定，本脚本不碰；
 * 引擎 id / 回退链 / 超时 / 重试 / 缓存 / 各引擎密钥存 pref translateCfg。
 *
 * ⚠ Zotero 先加载脚本、后插入 fragment DOM —— init 必须探测关键节点，
 *    不存在就延迟重试，否则 null 崩溃会让整个面板永远不 loaded（同 prefs-pane）。
 * ⚠ 动态创建的节点一律经变量持有，**不要**用 $(…) 去取动态节点，
 *    否则 check-wiring 的「元素 id 必须存在于 prefs.xhtml」守卫会误报。
 * 0.72.2 设计修复：动词统一 / emoji 清除 / aria-live / 密钥眼睛钮改内联 SVG。
 */
/* global Zotero, window, document */

(function () {
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const zh = (Zotero.locale || "").toLowerCase().startsWith("zh");
  const $ = (id) => document.getElementById(id);
  const PP = () => Zotero.Papilot || {};
  const T = () => PP().translateSvc;

  /**
   * 写扩展 pref。
   * ★ 第三参 `true`（global）绝不能省：省略时 Zotero 会再补一次 `extensions.zotero.`，
   *   值落到 `extensions.zotero.extensions.zotero.papilot.*` 孤儿键——读取端读的是
   *   正确键，于是「保存成功但从不生效」（0.54.1 修复，回归见 test/pref-namespace.test.js）。
   */
  const setPref = (key, value) => {
    Zotero.Prefs.set("extensions.zotero.papilot." + key, value, true);
  };

  const el = (tag, attrs, text) => {
    const node = document.createElementNS(HTML_NS, tag);
    if (attrs) for (const k of Object.keys(attrs)) {
      if (attrs[k] === undefined || attrs[k] === null) continue;
      node.setAttribute(k, attrs[k]);
    }
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const PASSWORD_KEYS = { key: 1, apiKey: 1, secretKey: 1, token: 1, appkey: 1 };

  /* 0.72.2：密钥眼睛钮改内联 SVG（Lucide eye 风，currentColor 跟随主题），不再用 emoji 眼睛 */
  const SVG_NS = "http://www.w3.org/2000/svg";
  function eyeIcon() {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "14");
    svg.setAttribute("height", "14");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.5");
    svg.setAttribute("aria-hidden", "true");
    const outline = document.createElementNS(SVG_NS, "path");
    outline.setAttribute("d", "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z");
    const pupil = document.createElementNS(SVG_NS, "circle");
    pupil.setAttribute("cx", "12");
    pupil.setAttribute("cy", "12");
    pupil.setAttribute("r", "3");
    svg.appendChild(outline);
    svg.appendChild(pupil);
    return svg;
  }

  /* ---------- 折叠式布局（0.31.0）----------
   * 16 个引擎全平铺，每行还带密钥表单与说明 → "界面过于杂乱"。
   * 默认只列「常用」（当前活动 + 回退链成员 + 内置常用清单，去重后最多 6 个），
   * 其余收进可展开区域（展开后按类别分组）。展开状态存模块变量，
   * 这样任何一次 renderAll 重建列表后仍保持用户的展开/收起选择。
   */
  const COMMON_ENGINES = ["llm", "edge", "google", "microsoft", "deepl"];
  const COMMON_MAX = 6;
  let showAllEngines = false;
  let lastCommonIds = [];

  /** 常用引擎 id 列表：活动引擎 → 回退链顺序 → 内置常用清单 */
  function commonIds(ov, S) {
    const out = [];
    const push = (id) => { if (id && S.get(id) && out.indexOf(id) < 0) out.push(id); };
    push(ov.active);
    for (const id of (ov.cfg.fallback || [])) push(id);
    for (const id of COMMON_ENGINES) push(id);
    return out.slice(0, COMMON_MAX);
  }

  function setMsg(text, color) {
    const box = $("pp-tr-test-result");
    if (!box) return;
    box.textContent = text || "";
    box.style.color = color || "var(--pp-muted)";
  }

  /* ---------- 状态行 ---------- */
  function renderStatus() {
    const box = $("pp-tr-status");
    const S = T();
    if (!box || !S) return;
    box.innerHTML = "";
    const svc = S.activeEngine();
    const c = S.cfg();
    if (!svc) {
      box.appendChild(el("span", { style: "color:var(--pp-danger);" },
        zh ? "没有可用的翻译引擎" : "No usable translation engine"));
      return;
    }
    // ready() 已内聚「大模型引擎要求 AI 就绪 / 需密钥引擎要求已配置」的判定
    const ready = S.ready(svc.id);
    if (ready) {
      box.appendChild(el("span", { style: "color:var(--pp-success);" }, "● "));
    } else {
      box.appendChild(el("span", { style: "color:var(--pp-warn);" }, "● "));
    }
    box.appendChild(el("b", null, svc.name));
    const bits = [];
    bits.push((zh ? "目标语言 " : "to ") + S.langLabel(S.targetCode()));
    if (c.fallback && c.fallback.length) {
      bits.push((zh ? "回退 " : "fallback ") + c.fallback.length);
    }
    if (!ready) bits.push(zh ? "当前不可用（见下方说明）" : "currently unavailable");
    box.appendChild(el("span", { style: "color:var(--pp-muted);" }, "  " + bits.join(" · ")));
    if (!ready) {
      const hint = el("div", { class: "pp-hint", style: "margin-top:2px;color:var(--pp-warn);" },
        S.unavailableHint());
      box.appendChild(hint);
    }
  }

  /* ---------- 当前引擎下拉 ---------- */
  function renderActiveSelect() {
    const sel = $("pp-tr-active");
    const S = T();
    if (!sel || !S) return;
    const cur = S.cfg().active;
    while (sel.firstChild) sel.removeChild(sel.firstChild);
    for (const s of S.list()) {
      const opt = el("option", { value: s.id });
      let label = s.name;
      // 0.72.2：引擎标记文字化（原免费/密钥/机器人三个 emoji 随平台漂移，改纯文字后缀）
      if (s.group === "free" && !s.needsSecret) label += zh ? "（免费）" : " (free)";
      if (s.needsSecret) label += zh ? "（需密钥）" : " (key)";
      if (s.llm) label += zh ? "（AI）" : " (AI)";
      opt.textContent = label;
      sel.appendChild(opt);
    }
    sel.value = cur;
  }

  /* ---------- 回退链 / 超时 / 重试 / 缓存 ---------- */
  function renderKnobs() {
    const S = T();
    if (!S) return;
    const c = S.cfg();
    const fb = $("pp-tr-fallback");
    if (fb) fb.value = (c.fallback || []).join(", ");
    const to = $("pp-tr-timeout");
    if (to) to.value = String(c.timeoutMs || 15000);
    const rt = $("pp-tr-retry");
    if (rt) rt.checked = !!c.retry;
    const ca = $("pp-tr-cache");
    if (ca) ca.checked = c.cache !== false;
    // 回退链预算三件套（0.31.0）：预算存毫秒、冷却界面用秒
    const ro = $("pp-tr-route");
    if (ro) ro.value = String(c.routeMs || 0);
    const tt = $("pp-tr-total");
    if (tt) tt.value = String(c.totalMs || 0);
    const cd = $("pp-tr-cooldown");
    if (cd) cd.value = String(Math.round((c.cooldownMs || 0) / 1000));
    // 0.33.0 术语表与全文翻译优化（三个开关直接走 Zotero.Prefs 布尔默认值）
    // 0.4x 追加：领域 chips + 种子词包下拉（数据面在 renderGlossaryDomains/Packs）
    const gl = $("pp-tr-glossary");
    if (gl) {
      gl.value = String((function () {
        try { return Zotero.Prefs.get("extensions.zotero.papilot.translateGlossary", true) || ""; }
        catch (e) { return ""; }
      })());
      renderGlossaryMsg(gl.value);
      renderGlossaryDomains();
      renderGlossaryPacks();
    }
    const st = $("pp-tr-bl-struct");
    if (st) st.checked = prefBool("bilingualStructExtract", true);
    const cx = $("pp-tr-bl-context");
    if (cx) cx.checked = prefBool("bilingualContext", true);
    const fp = $("pp-tr-formula");
    if (fp) fp.checked = prefBool("translateFormulaProtect", true);
    // 0.36.0 PDF 对照翻译（左原版 / 右译文）
    const pdm = $("pp-pd-rightmode");
    if (pdm) {
      pdm.value = String(prefStr("pdfDualRightMode", "mono") || "mono");
      if (["mono", "overlay"].indexOf(pdm.value) < 0) pdm.value = "mono";
    }
    const pds = $("pp-pd-scale");
    if (pds) pds.value = String(prefStr("pdfInlineFontScale", "1") || "1");
    const pdsc = $("pp-pd-sync");
    if (pdsc) pdsc.checked = prefBool("pdfDualSyncScroll", true);
    const pdz = $("pp-pd-zoom");
    if (pdz) pdz.checked = prefBool("pdfDualSyncZoom", true);
  }

  /** 读取扩展字符串 pref（默认值在 prefs.js 声明，这里只兜 undefined） */
  function prefStr(key, dflt) {
    try {
      const v = Zotero.Prefs.get("extensions.zotero.papilot." + key, true);
      return v === undefined || v === null ? dflt : String(v);
    } catch (e) { return dflt; }
  }

  /** 读取扩展布尔 pref（默认值在 prefs.js 声明，这里只兜 undefined） */
  function prefBool(key, dflt) {
    try {
      const v = Zotero.Prefs.get("extensions.zotero.papilot." + key, true);
      return v === undefined || v === null ? dflt : !!v;
    } catch (e) { return dflt; }
  }

  /** 术语表输入反馈：解析条数实时显示在文本框下方（行内反馈，别让用户猜是否生效）
   *  0.4x：追加领域统计（通用 N · 计算机 12 · 医学 20 …），领域 chips 由 renderGlossaryDomains 渲染 */
  function renderGlossaryMsg(raw) {
    const msg = $("pp-tr-glossary-msg");
    if (!msg) return;
    const S = T();
    let n = 0;
    let bad = 0;
    let domBits = [];
    if (S && S.parseGlossary) {
      try {
        const list = S.parseGlossary(raw);
        n = list.length;
        const doms = {};
        let general = 0;
        for (const g of list) {
          if (g.d) { for (const d of String(g.d).split(";")) if (d) doms[d] = (doms[d] || 0) + 1; }
          else general++;
        }
        domBits = Object.keys(doms).sort().map((d) => d + " " + doms[d]);
        if (general) domBits.unshift((zh ? "通用 " : "general ") + general);
      } catch (e) { n = 0; }
    }
    // 无法解析出术语的非空行 = 写法提示（不含注释行）
    for (const line of String(raw || "").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.charAt(0) === "#" || t.slice(0, 2) === "//") continue;
      if (!/=>|=|\t/.test(t)) bad++;
    }
    msg.style.color = "var(--pp-muted)";
    const domTail = domBits.length ? "（" + domBits.join(" · ") + "）" : "";
    if (!String(raw || "").trim()) {
      msg.textContent = zh ? "尚未配置术语表" : "No glossary yet";
    } else if (bad) {
      msg.style.color = "var(--pp-warn)";
      msg.textContent = zh
        ? "已解析 " + n + " 条" + domTail + "；" + bad + " 行缺少「=」分隔符（# 开头的行为注释）"
        : n + " parsed" + domTail + "; " + bad + " line(s) missing '=' separator";
    } else {
      msg.textContent = (zh ? "已解析 " + n + " 条术语" : n + " term(s) parsed") + domTail;
    }
  }

  /* ---------- 0.4x 领域筛选 chips / 导入导出 / 种子词包 ---------- */

  /** 领域 chips：pref translateGlossaryDomains 为空 = 全部启用（未筛选态）；
   *  点击某域 → 进入筛选态只启用该域；再点其他域增选；点已选域取消；全部取消 = 回未筛选态。 */
  function renderGlossaryDomains() {
    const box = $("pp-tr-glossary-domains");
    const S = T();
    if (!box || !S) return;
    while (box.firstChild) box.removeChild(box.firstChild);
    let doms = [];
    try { doms = S.glossaryDomains ? S.glossaryDomains() : []; } catch (e) { doms = []; }
    if (!doms.length) return; // 无领域标注 → 整行隐藏（min-height 占位防布局跳动）
    const raw = prefStr("translateGlossaryDomains", "");
    const active = raw
      ? raw.split(/[;,，；]/).map((x) => x.trim().toLowerCase()).filter(Boolean)
      : null;
    const activeSet = active ? new Set(active) : null;
    box.appendChild(el("span", { style: "color:var(--pp-muted);margin-right:4px;" },
      zh ? "领域：" : "domains:"));
    for (const d of doms) {
      const on = !activeSet || activeSet.has(d);
      const chip = el("button", {
        class: "pp-btn pp-btn-sm",
        style: on ? "" : "opacity:.45;",
        "data-domain": d,
      }, d + (activeSet && activeSet.has(d) ? " ✓" : ""));
      chip.addEventListener("click", () => onDomainChipToggle(d));
      box.appendChild(chip);
    }
    box.appendChild(el("span", { style: "color:var(--pp-muted);margin-left:4px;" },
      activeSet
        ? (zh ? "（点已选域取消；全部取消=不再筛选）" : "(click selected to clear)")
        : (zh ? "未筛选 = 全部启用" : "all enabled")));
  }

  function onDomainChipToggle(domain) {
    const raw = prefStr("translateGlossaryDomains", "");
    let active = raw
      ? raw.split(/[;,，；]/).map((x) => x.trim().toLowerCase()).filter(Boolean)
      : null;
    if (!active) active = [domain];            // 未筛选 → 只启用该域
    else {
      const i = active.indexOf(domain);
      if (i >= 0) active.splice(i, 1);         // 已选 → 取消
      else active.push(domain);                // 未选 → 增选
    }
    const v = active.join(";");
    try { setPref("translateGlossaryDomains", v); } catch (e) { /* ignore */ }
    // 不清缓存：域启停改变 glossary() 过滤结果 → 术语表指纹变 → 缓存键自然失效
    renderGlossaryDomains();
    setMsg(v
      ? (zh ? "术语表已按领域筛选：" + v.split(";").join("、") : "Glossary filtered: " + v)
      : (zh ? "领域筛选已清除（全部启用）" : "Domain filter cleared (all enabled)"),
      "var(--pp-success)");
  }

  /** 领域种子词包下拉（数据来自 Zotero.Papilot.glossaryPacks，插件未就绪时留空） */
  function renderGlossaryPacks() {
    const sel = $("pp-tr-glossary-pack");
    if (!sel) return;
    while (sel.firstChild) sel.removeChild(sel.firstChild);
    let packs = [];
    try {
      const gp = PP().glossaryPacks;
      if (gp && gp.list) packs = gp.list() || [];
    } catch (e) { packs = []; }
    for (const p of packs) {
      const opt = el("option", { value: p.id });
      opt.textContent = p.label + "（" + p.count + (zh ? " 条" : " terms") + "）";
      sel.appendChild(opt);
    }
  }

  /** 术语表落盘公共路径：写 pref + 清缓存 + 刷新三个反馈区 */
  function persistGlossary(raw) {
    try { setPref("translateGlossary", raw); } catch (e) { /* ignore */ }
    const S = T();
    try { if (S && S.clearCache) S.clearCache(); } catch (e) { /* ignore */ }
    if ($("pp-tr-glossary")) $("pp-tr-glossary").value = raw;
    renderGlossaryMsg(raw);
    renderGlossaryDomains();
  }

  async function onGlossaryImport() {
    const S = T();
    if (!S || !S.parseGlossaryImport || !S.mergeGlossary) return;
    if (typeof Zotero === "undefined" || !Zotero.FilePicker) {
      setMsg(zh ? "此环境不支持文件选择" : "FilePicker unavailable", "var(--pp-warn)");
      return;
    }
    try {
      const fp = new Zotero.FilePicker();
      fp.init(window, zh ? "导入术语表（CSV / TSV / JSON / 行式文本）" : "Import glossary (CSV/TSV/JSON/lines)",
        fp.modeOpen);
      const rv = await fp.show();
      if (rv !== fp.returnOK && rv !== fp.returnReplace) return;
      const text = String(await Zotero.File.getContentsAsync(fp.file) || "");
      const parsed = S.parseGlossaryImport(text);
      if (!parsed.list.length) {
        setMsg(zh
          ? "未识别到任何术语——支持带表头 CSV/TSV（source,target,domain）、裸两三列、JSON 数组与「原文 = 译文」行式"
          : "No terms recognized (CSV/TSV with header, bare 2-3 columns, JSON array, or 'src = tgt' lines)",
          "var(--pp-warn)");
        return;
      }
      const m = S.mergeGlossary(String($("pp-tr-glossary") ? $("pp-tr-glossary").value || "" : ""), parsed.list);
      persistGlossary(m.raw);
      setMsg((zh ? "已导入（" + parsed.format + "）：新增 " + m.added + " 条、更新 " + m.updated + " 条"
        : "Imported (" + parsed.format + "): " + m.added + " added, " + m.updated + " updated"),
        "var(--pp-success)");
    } catch (e) {
      setMsg((zh ? "导入失败：" : "Import failed: ") + String((e && e.message) || e).slice(0, 120),
        "var(--pp-danger)");
    }
  }

  async function onGlossaryExport() {
    const S = T();
    if (!S || !S.glossaryToCsv) return;
    if (typeof Zotero === "undefined" || !Zotero.FilePicker) {
      setMsg(zh ? "此环境不支持文件保存" : "FilePicker unavailable", "var(--pp-warn)");
      return;
    }
    try {
      // 导出全部（含被域过滤暂时停用的条目）——域只是启停开关，不是数据删改
      const list = S.glossaryAll ? S.glossaryAll() : [];
      if (!list.length) {
        setMsg(zh ? "术语表为空，无可导出" : "Glossary is empty", "var(--pp-warn)");
        return;
      }
      const csv = S.glossaryToCsv(list);
      const fp = new Zotero.FilePicker();
      fp.init(window, zh ? "导出术语表为 CSV" : "Export glossary as CSV", fp.modeSave);
      fp.defaultString = "papilot-glossary.csv";
      const rv = await fp.show();
      if (rv !== fp.returnOK && rv !== fp.returnReplace) return;
      // BOM 头让 Excel 直接打开中文不乱码（UTF-8 CSV 的通行做法）
      await Zotero.File.putContentsAsync(fp.file, "\uFEFF" + csv);
      setMsg((zh ? "已导出 " + list.length + " 条术语 → " : "Exported " + list.length + " terms → ") +
        String(fp.file || ""), "var(--pp-success)");
    } catch (e) {
      setMsg((zh ? "导出失败：" : "Export failed: ") + String((e && e.message) || e).slice(0, 120),
        "var(--pp-danger)");
    }
  }

  function onGlossaryPackAdd() {
    const S = T();
    const sel = $("pp-tr-glossary-pack");
    if (!S || !S.mergeGlossary || !sel) return;
    let pack = null;
    try {
      const gp = PP().glossaryPacks;
      if (gp && gp.get) pack = gp.get(sel.value);
    } catch (e) { pack = null; }
    if (!pack) {
      setMsg(zh ? "词包不可用（插件重载后重试？）" : "Packs unavailable", "var(--pp-warn)");
      return;
    }
    const m = S.mergeGlossary(String($("pp-tr-glossary") ? $("pp-tr-glossary").value || "" : ""), pack.terms);
    persistGlossary(m.raw);
    setMsg((zh ? "已添加词包「" + pack.label + "」：新增 " + m.added + " 条、更新 " + m.updated +
        " 条（可自行增删改；领域标签已标注）"
      : "Pack '" + pack.label + "' merged: " + m.added + " added, " + m.updated + " updated"),
      "var(--pp-success)");
  }

  /* ---------- 0.4x 在线词包目录（数据源：GitHub open-termbank，CC BY 4.0） ----------
   * 懒加载：面板打开不发请求，点「获取在线目录」才拉 index.json；
   * 逐域导入走 parseGlossaryImport + mergeGlossary（与文件导入同一条链）；
   * sha256 记账在 pref translateGlossaryPackState → 「有更新」检测；
   * 网络失败静默回落（提示后不影响内置词包与文件导入）。 */

  function readPackState() {
    try {
      const v = Zotero.Prefs.get("extensions.zotero.papilot.translateGlossaryPackState", true);
      return v ? JSON.parse(String(v)) : {};
    } catch (e) { return {}; }
  }
  function writePackState(st) {
    try {
      setPref("translateGlossaryPackState", JSON.stringify(st));
    } catch (e) { /* ignore */ }
  }

  let onlineCatalog = null; // fetchCatalog 成功结果（{ok,index,via}），供逐域导入复用基址

  async function onOnlineFetch() {
    const btn = $("pp-tr-glossary-online-fetch");
    const status = $("pp-tr-glossary-online-status");
    if (!gp()) return;
    if (btn) { btn.disabled = true; btn.textContent = zh ? "获取中…" : "Fetching…"; }
    try {
      const r = await gp().fetchCatalog();
      if (!r || !r.ok) {
        onlineCatalog = null;
        renderOnlineList(null);
        if (status) {
          status.style.color = "var(--pp-warn)";
          status.textContent = (zh ? "在线目录不可用（" : "Catalog unavailable (") +
            String((r && r.error) || "网络不可达").slice(0, 60) + "）——可先用上方内置词包或导入文件";
        }
        return;
      }
      onlineCatalog = r;
      renderOnlineList(r.index);
      if (status) {
        status.style.color = "var(--pp-muted)";
        status.textContent = "open-termbank v" + r.index.version + " · " + (r.index.total || "?") +
          (zh ? " 条 · " : " terms · ") + r.index.domains.length + (zh ? " 个领域" : " domains");
      }
    } catch (e) {
      if (status) {
        status.style.color = "var(--pp-danger)";
        status.textContent = (zh ? "获取失败：" : "Failed: ") + String((e && e.message) || e).slice(0, 80);
      }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = zh ? "获取在线目录" : "Fetch catalog"; }
    }
  }

  function renderOnlineList(index) {
    const list = $("pp-tr-glossary-online-list");
    if (!list) return;
    while (list.firstChild) list.removeChild(list.firstChild);
    if (!index || !Array.isArray(index.domains)) return;
    const state = readPackState();
    for (const d of index.domains) {
      const row = el("div", { style: "display:flex;gap:6px;align-items:center;margin-top:4px;" });
      const imported = state[d.slug];
      const fresh = imported === d.sha256;
      row.appendChild(el("span", { style: "min-width:110px;" }, String(d.domain || d.slug)));
      row.appendChild(el("span", { style: "color:var(--pp-muted);min-width:60px;text-align:right;" },
        String(d.count) + (zh ? " 条" : "")));
      const btn = el("button", { class: "pp-btn pp-btn-sm", "data-slug": d.slug },
        imported ? (fresh ? (zh ? "重新导入" : "Re-import") : (zh ? "更新" : "Update")) : (zh ? "导入" : "Import"));
      btn.addEventListener("click", () => onOnlineImport(d));
      row.appendChild(btn);
      if (imported) {
        row.appendChild(el("span", { style: fresh ? "color:var(--pp-success);" : "color:var(--pp-warn);" },
          fresh ? (zh ? "✓ 已导入" : "imported") : (zh ? "↑ 有更新" : "update available")));
      }
      list.appendChild(row);
    }
  }

  async function onOnlineImport(d) {
    const S = T();
    if (!S || !S.parseGlossaryImport || !S.mergeGlossary || !gp()) return;
    try {
      const r = await gp().fetchDomain(d.slug, onlineCatalog ? onlineCatalog.via : undefined);
      if (!r || !r.ok) throw new Error(String((r && r.error) || "下载失败"));
      const parsed = S.parseGlossaryImport(r.text);
      if (!parsed.list.length) throw new Error(zh ? "CSV 里没有可识别的术语" : "no terms recognized");
      const m = S.mergeGlossary(String($("pp-tr-glossary") ? $("pp-tr-glossary").value || "" : ""), parsed.list);
      persistGlossary(m.raw);
      const st = readPackState();
      st[d.slug] = d.sha256; // 记账：导入时点的 sha256（下次目录 sha 不同 → 「有更新」）
      writePackState(st);
      renderOnlineList(onlineCatalog ? onlineCatalog.index : null);
      setMsg((zh ? "已导入在线词包「" + d.domain + "」：新增 " + m.added + " 条、更新 " + m.updated +
          " 条（open-termbank · CC BY 4.0）"
        : "Imported '" + d.domain + "': " + m.added + " added, " + m.updated + " updated"),
        "var(--pp-success)");
    } catch (e) {
      setMsg((zh ? "在线导入失败：" : "Online import failed: ") + String((e && e.message) || e).slice(0, 120),
        "var(--pp-danger)");
    }
  }

  /** 插件沙箱里的 GlossaryPacks（在线目录模块；旧版插件对象上可能没有 → 面板静默降级） */
  function gp() {
    try { return PP().glossaryPacks || null; } catch (e) { return null; }
  }

  /* ---------- 引擎行 ---------- */
  function buildEngineRow(s, compact) {
    const S = T();
    const row = el("div", { class: "pp-ch-row", "data-engine": s.id });

    const left = el("div", { style: "flex:1;min-width:0;" });
    const head = el("div", { class: "pp-ch-head" });
    head.appendChild(el("span", { class: "pp-ch-name" }, s.name));
    if (s.enabled) head.appendChild(el("span", { class: "pp-pill pp-pill-ok" }, zh ? "当前" : "active"));
    if (s.inFallback) head.appendChild(el("span", { class: "pp-pill" }, zh ? "回退" : "fallback"));
    if (s.needsSecret) {
      head.appendChild(el("span", { class: "pp-pill " + (s.configured ? "pp-pill-ok" : "pp-pill-warn") },
        s.configured ? (zh ? "已配置" : "configured") : (zh ? "未配置" : "not set")));
    }
    if (s.experimental) {
      head.appendChild(el("span", { class: "pp-pill pp-pill-warn" }, zh ? "实验性" : "experimental"));
    }
    left.appendChild(head);

    const sub = [];
    if (s.group === "llm") sub.push(zh ? "使用当前 AI 通道" : "uses active AI channel");
    else if (s.group === "key") sub.push(zh ? "自有密钥" : "own key");
    else if (!s.needsSecret) sub.push(zh ? "免费·免配置" : "free");
    if (s.note) sub.push(s.note);
    // 单次上限：超长自动分段（0.31.0）——让用户知道"为什么长文会被拆成几次请求"
    if (s.limits) {
      sub.push(zh
        ? "单次 ≤ " + (s.limits.bytes ? s.limits.bytes + " 字节" : s.limits.chars + " 字符") + "（超长自动分段）"
        : "≤ " + (s.limits.bytes || s.limits.chars) +
          (s.limits.bytes ? " bytes" : " chars") + " per call (auto-split)");
    }
    if (sub.length) left.appendChild(el("div", { class: "pp-ch-sub" }, sub.join(" · ")));

    // 密钥表单：每项一个输入，变更即保存（无需单独保存按钮）
    if (s.needsSecret && s.secretFields && s.secretFields.length) {
      const parts = S.parseSecret(s.id, s.secretRaw);
      const wrap = el("div", { style: "margin-top:6px;display:flex;flex-wrap:wrap;gap:6px;" });
      for (const f of s.secretFields) {
        const cell = el("div", { style: "display:flex;align-items:center;gap:4px;" });
        const isPw = !!PASSWORD_KEYS[f.key];
        const input = el("input", {
          type: isPw ? "password" : "text",
          class: "pp-input",
          placeholder: f.placeholder || f.label || f.key,
          title: f.label || f.key,
          style: "min-width:180px;font-size:12px;",
        });
        input.value = parts[f.key] || "";
        input.addEventListener("change", () => {
          const obj = {};
          for (const ff of s.secretFields) {
            obj[ff.key] = ff.key === f.key ? input.value
              : ((wrap.querySelector('input[data-k="' + ff.key + '"]') || {}).value || "");
          }
          S.setSecret(s.id, obj);
          renderStatus();
          setMsg((zh ? "已保存密钥：" : "Saved secret: ") + s.name, "var(--pp-success)");
        });
        input.setAttribute("data-k", f.key);
        cell.appendChild(input);
        if (isPw) {
          // 0.72.2：单 eye 图标常显，只切 aria-label 与输入框类型（不再切换 emoji 字符）
          const eye = el("button", {
            class: "pp-btn pp-btn-sm",
            title: zh ? "显示/隐藏" : "show/hide",
            "aria-label": zh ? "显示密钥" : "Show secret",
          });
          eye.appendChild(eyeIcon());
          eye.style.opacity = "0.55";
          eye.addEventListener("click", () => {
            const show = input.type === "password";
            input.type = show ? "text" : "password";
            eye.style.opacity = show ? "1" : "0.55";
            eye.setAttribute("aria-label", show
              ? (zh ? "隐藏密钥" : "Hide secret")
              : (zh ? "显示密钥" : "Show secret"));
          });
          cell.appendChild(eye);
        }
        wrap.appendChild(cell);
      }
      left.appendChild(wrap);
    }

    // 引擎说明（额度 / 免密钥 / 申请方式）：由引擎自身声明，界面直接展示。
    // compact（展开区里的行）只在"要填密钥/是实验性"时展示说明，避免展开后一屏全是字。
    if (s.hint && (!compact || s.needsSecret || s.experimental)) {
      left.appendChild(el("div", {
        class: "pp-hint",
        style: "margin-top:5px;line-height:1.5;",
      }, s.hint));
    }

    row.appendChild(left);

    // 右侧：操作按钮 + **行内测试结果**（反馈就在刚点的按钮下面，不再跑到卡片底部）
    const right = el("div", {
      style: "display:flex;flex-direction:column;gap:4px;flex:none;align-items:flex-end;max-width:240px;",
    });
    const acts = el("div", { style: "display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;" });
    const mkBtn = (label, title) => el("button", { class: "pp-btn pp-btn-sm", title: title || "" }, label);
    if (!s.enabled) {
      const b = mkBtn(zh ? "设为当前" : "Set active", zh ? "用作主翻译引擎" : "Use as primary engine");
      b.addEventListener("click", () => {
        const r = S.setActive(s.id);
        if (!r.ok) { setMsg("✗ " + r.error, "var(--pp-danger)"); return; }
        setMsg((zh ? "已设为当前引擎：" : "Active engine: ") + s.name, "var(--pp-success)");
        renderAll();
      });
      acts.appendChild(b);
    }
    const bFb = mkBtn(
      zh ? (s.inFallback ? "移出回退" : "纳入回退") : (s.inFallback ? "Remove fallback" : "Add fallback"),
      zh ? "主引擎失败时依次尝试该引擎" : "Try this engine when primary fails");
    bFb.addEventListener("click", () => {
      const list = (S.cfg().fallback || []).slice();
      const i = list.indexOf(s.id);
      if (i >= 0) list.splice(i, 1); else list.push(s.id);
      S.saveCfg({ fallback: list });
      renderKnobs();
      renderAll();
    });
    acts.appendChild(bFb);
    const bTest = mkBtn(zh ? "测试" : "Test", zh ? "真实调用一次，返回耗时与译文" : "Real call: latency + result");
    const rowMsg = el("div", {
      class: "pp-tr-rowmsg",
      style: "font-size:11px;line-height:1.45;text-align:right;word-break:break-word;min-height:0;",
      "aria-live": "polite", // 0.72.2：行内测试结果对读屏可见
    }, "");
    bTest.addEventListener("click", () => onTest(s.id, bTest, rowMsg));
    acts.appendChild(bTest);
    if (s.docs) {
      const bDoc = mkBtn(zh ? "文档" : "Docs", s.docs);
      bDoc.addEventListener("click", () => {
        try { Zotero.launchURL(s.docs); } catch (e) { /* ignore */ }
      });
      acts.appendChild(bDoc);
    }
    right.appendChild(acts);
    right.appendChild(rowMsg);
    row.appendChild(right);
    return row;
  }

  function renderList() {
    const box = $("pp-tr-list");
    const S = T();
    if (!box || !S) return;
    while (box.firstChild) box.removeChild(box.firstChild);

    const ov = S.overview();
    const total = ov.services.length;
    const common = commonIds(ov, S);
    lastCommonIds = common;

    const groups = [
      { key: "plain", label: zh ? "完全免配置（开箱即用）" : "Zero-config" },
      { key: "free-url", label: zh ? "免费 · 需填自建/公共地址" : "Free · needs a URL" },
      { key: "key", label: zh ? "需自备密钥" : "Bring your own key" },
      { key: "ai", label: zh ? "AI 大模型" : "AI model" },
    ];
    const catOf = (s) => (s.isLLM ? "ai"
      : (s.needsSecret ? (s.group === "free" ? "free-url" : "key") : "plain"));

    // 标题行 + 展开/收起
    const head = el("div", {
      class: "pp-tr-listhead",
      style: "display:flex;align-items:center;gap:8px;margin-top:9px;flex-wrap:wrap;",
    });
    head.appendChild(el("span", { class: "pp-sub-title" }, showAllEngines
      ? (zh ? "全部引擎（" + total + " 个）" : "All engines (" + total + ")")
      : (zh ? "常用引擎（" + common.length + " 个）" : "Common (" + common.length + ")")));
    const toggle = el("button", { class: "pp-btn pp-btn-sm pp-tr-toggle" },
      showAllEngines
        ? (zh ? "收起，只看常用 ▴" : "Collapse ▴")
        : (zh ? "展开全部 " + total + " 个 ▾" : "Show all " + total + " ▾"));
    toggle.style.marginLeft = "auto";
    toggle.addEventListener("click", () => {
      showAllEngines = !showAllEngines;
      renderList();
    });
    head.appendChild(toggle);
    box.appendChild(head);

    if (!showAllEngines) {
      for (const id of common) {
        const s = ov.services.find((x) => x.id === id);
        if (s) box.appendChild(buildEngineRow(s, false));
      }
      const rest = total - common.length;
      if (rest > 0) {
        box.appendChild(el("div", { class: "pp-hint pp-tr-more", style: "margin-top:6px;" },
          (zh ? "已收起 " + rest + " 个引擎 —— 点右上「展开全部」查看（免配置 / 自备密钥 / 自建地址都在里面）。"
            : rest + " more engines hidden — click “Show all”.")));
      }
      return;
    }

    for (const g of groups) {
      const list = ov.services.filter((s) => catOf(s) === g.key);
      if (!list.length) continue;
      // 活动引擎排在该组最前，便于对照
      list.sort((a, b) => (a.enabled ? -1 : b.enabled ? 1 : 0));
      box.appendChild(el("div", { class: "pp-sub-title", style: "margin-top:9px;" },
        g.label + "（" + list.length + "）"));
      for (const s of list) box.appendChild(buildEngineRow(s, true));
    }
  }

  /** 扫描本机自建翻译服务（LibreTranslate 5000 / Lingva 3000 / DLX 1188），命中即一键填入地址 */
  async function onLocalScan() {
    const S = T();
    const btn = $("pp-tr-local-scan");
    const box = $("pp-tr-local");
    if (!S || !box) return;
    if (btn) btn.disabled = true;
    box.textContent = zh ? "扫描中（本机 5000 / 3000 / 1188 端口）…" : "Scanning localhost ports…";
    box.style.color = "var(--pp-muted)";
    try {
      const r = await S.probeLocal(2000);
      while (box.firstChild) box.removeChild(box.firstChild);
      if (!r.found.length) {
        box.textContent = zh
          ? "未发现本机自建服务。想零成本无限流？例如先跑一个：docker run -p 5000:5000 libretranslate/libretranslate —— 起来后再点此按钮。"
          : "No local instance found. e.g. docker run -p 5000:5000 libretranslate/libretranslate";
        box.style.color = "var(--pp-muted)";
        return;
      }
      box.textContent = "";
      box.style.color = "var(--pp-success)";
      box.appendChild(el("span", null, (zh ? "发现 " : "Found ") + r.found.length + (zh ? " 个：" : ": ")));
      for (const f of r.found) {
        const b = el("button", { class: "pp-btn pp-btn-sm", title: f.url },
          (zh ? "填入 " : "Use ") + f.name + "（" + f.latencyMs + "ms）");
        b.style.marginRight = "6px";
        b.addEventListener("click", () => {
          S.setSecret(f.engine, { url: f.url });
          setMsg((zh ? "已填入 " : "Filled ") + f.name + "：" + f.url, "var(--pp-success)");
          renderAll();
        });
        box.appendChild(b);
      }
    } catch (e) {
      box.textContent = "✗ " + ((e && e.message) || e);
      box.style.color = "var(--pp-danger)";
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /**
   * 「测试」：真实调用一次引擎。
   * ⚠ 0.31.0 修的坑：此前结果只写进卡片底部那个**共用**结果区，而它在十几行引擎之后 ——
   * 用户点了按钮，反馈出现在屏幕外，按钮又飞快复原，观感就是"测试没反应"。
   * 现在双写：**行内即时反馈**（就在按钮下方）+ 底部汇总（多引擎对比时仍有用）。
   * 失败一律给出可读原因（缺密钥 / 取 token 失败 / HTTP 状态 / 超时…），不静默。
   */
  async function onTest(id, btn, msgEl) {
    const S = T();
    if (!S) return;
    const old = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "…"; }
    const nm = (S.get(id) || {}).name || id;
    const say = (text, color) => {
      if (msgEl) { msgEl.textContent = text; msgEl.style.color = color; }
      setMsg(text, color);
    };
    say((zh ? "测试中（真实调用一次）：" : "Testing: ") + nm, "var(--pp-muted)");
    try {
      const r = await S.testEngine(id);
      if (r.ok) {
        const txt = String(r.text || "").replace(/\s+/g, " ").slice(0, 40);
        say("✓ " + r.latencyMs + "ms · 「" + txt + "」", "var(--pp-success)");
        setMsg("✓ " + nm + (zh ? " 正常，延迟 " : " OK, ") + r.latencyMs + "ms" +
          (zh ? "，译文「" : ", result “") + txt + "」", "var(--pp-success)");
      } else {
        const err = r.error || (zh ? "未知错误" : "unknown error");
        say("✗ " + (zh ? "失败：" : "Failed: ") + err, "var(--pp-danger)");
        setMsg("✗ " + nm + (zh ? " 失败：" : " failed: ") + err, "var(--pp-danger)");
      }
    } catch (e) {
      const m = (e && e.message) || String(e);
      say("✗ " + (zh ? "异常：" : "Error: ") + m, "var(--pp-danger)");
      setMsg("✗ " + nm + "：" + m, "var(--pp-danger)");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = old; }
    }
  }

  function renderAll() {
    renderStatus();
    renderActiveSelect();
    renderKnobs();
    renderList();
  }

  /* ---------- 初始化（DOM 就绪探测） ---------- */
  function init() {
    if (typeof Zotero === "undefined" || !Zotero.Papilot || !T()) {
      window.setTimeout(init, 400);
      return;
    }
    // Zotero 先执行脚本、后插入 fragment：关键节点不存在就延迟重试
    if (!$("pp-tr-list") || !$("pp-tr-active")) {
      window.setTimeout(init, 300);
      return;
    }
    if (init._done) return;
    init._done = true;

    const S = T();
    try { S.migrate(); } catch (e) { /* ignore */ }

    const bind = (id, ev, fn) => { const n = $(id); if (n) n.addEventListener(ev, fn); };

    bind("pp-tr-active", "change", () => {
      const v = $("pp-tr-active").value;
      const r = S.setActive(v);
      if (!r.ok) { setMsg("✗ " + r.error, "var(--pp-danger)"); return; }
      setMsg(zh ? "已切换翻译引擎（立即生效，无需重启）" : "Engine switched (takes effect immediately)",
        "var(--pp-success)");
      renderAll();
    });

    bind("pp-tr-fallback", "change", () => {
      const raw = String($("pp-tr-fallback").value || "");
      const list = raw.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
      const bad = list.filter((x) => !S.get(x));
      S.saveCfg({ fallback: list });
      if (bad.length) {
        setMsg((zh ? "已保存回退链；未知引擎 id 已忽略：" : "Saved; unknown ids ignored: ") + bad.join(", "),
          "var(--pp-warn)");
      } else {
        setMsg(zh ? "已保存回退链" : "Fallback chain saved", "var(--pp-success)");
      }
      renderAll();
    });

    bind("pp-tr-timeout", "change", () => {
      S.saveCfg({ timeoutMs: Number($("pp-tr-timeout").value) || 15000 });
      renderKnobs();
    });
    bind("pp-tr-retry", "change", () => {
      S.saveCfg({ retry: !!$("pp-tr-retry").checked });
    });
    bind("pp-tr-cache", "change", () => {
      S.saveCfg({ cache: !!$("pp-tr-cache").checked });
      try { S.clearCache(); } catch (e) { /* ignore */ }
    });
    // 预算三件套：0 = 关闭该项保护（界面上写明）
    bind("pp-tr-route", "change", () => {
      S.saveCfg({ routeMs: Math.max(0, Number($("pp-tr-route").value) || 0) });
      renderKnobs();
    });
    bind("pp-tr-total", "change", () => {
      S.saveCfg({ totalMs: Math.max(0, Number($("pp-tr-total").value) || 0) });
      renderKnobs();
    });
    bind("pp-tr-cooldown", "change", () => {
      const sec = Math.max(0, Number($("pp-tr-cooldown").value) || 0);
      S.saveCfg({ cooldownMs: sec > 0 ? Math.round(sec * 1000) : 0 });
      try { S.clearCooldown(); } catch (e) { /* ignore */ } // 改了就重新计时
      renderKnobs();
    });
    bind("pp-tr-local-scan", "click", onLocalScan);

    // 0.33.0 术语表与全文翻译优化：术语表存 translateGlossary（改完即时生效——
    // 翻译侧每次调用都重新解析；缓存键含术语表指纹，不吃旧缓存）
    bind("pp-tr-glossary", "change", () => {
      const v = String($("pp-tr-glossary").value || "");
      try {
        setPref("translateGlossary", v);
      } catch (e) { /* ignore */ }
      try { if (T() && T().clearCache) T().clearCache(); } catch (e) { /* ignore */ }
      renderGlossaryMsg(v);
      renderGlossaryDomains();
      setMsg(zh ? "已保存术语表（下次翻译即生效）" : "Glossary saved (effective immediately)",
        "var(--pp-success)");
    });
    // 0.4x 术语表领域化：导入 / 导出 / 种子词包
    bind("pp-tr-glossary-import", "click", onGlossaryImport);
    bind("pp-tr-glossary-export", "click", onGlossaryExport);
    bind("pp-tr-glossary-pack-add", "click", onGlossaryPackAdd);
    // 0.4x 在线词包目录（GitHub open-termbank；懒加载，面板打开不发请求）
    bind("pp-tr-glossary-online-fetch", "click", onOnlineFetch);
    bind("pp-tr-bl-struct", "change", () => {
      try {
        setPref("bilingualStructExtract", !!$("pp-tr-bl-struct").checked);
      } catch (e) { /* ignore */ }
    });
    bind("pp-tr-bl-context", "change", () => {
      try {
        setPref("bilingualContext", !!$("pp-tr-bl-context").checked);
      } catch (e) { /* ignore */ }
    });
    bind("pp-tr-formula", "change", () => {
      try {
        setPref("translateFormulaProtect", !!$("pp-tr-formula").checked);
      } catch (e) { /* ignore */ }
    });

    // 0.36.0 PDF 对照翻译（左原版 / 右译文）：右栏形态与字号改动即时 refresh 内核
    const piRefresh = () => {
      try {
        const pi = PP().pdfInline;
        if (pi && pi.refresh) pi.refresh();
      } catch (e) { /* ignore */ }
    };
    bind("pp-pd-rightmode", "change", () => {
      let v = String($("pp-pd-rightmode").value || "mono");
      if (["mono", "overlay"].indexOf(v) < 0) v = "mono";
      try { setPref("pdfDualRightMode", v); } catch (e) { /* ignore */ }
      piRefresh();
      setMsg(v === "mono"
        ? (zh ? "右栏：译文替换原文（图表与公式保留）" : "Right pane: translation replaces text")
        : (zh ? "右栏：译文叠加在原位上（原文淡显）" : "Right pane: overlay with ghosted source"),
        "var(--pp-success)");
    });
    bind("pp-pd-scale", "change", () => {
      const n = Number($("pp-pd-scale").value);
      const v = isFinite(n) && n > 0 ? Math.min(1.6, Math.max(0.7, n)) : 1;
      try {
        setPref("pdfInlineFontScale", String(v));
      } catch (e) { /* ignore */ }
      if ($("pp-pd-scale")) $("pp-pd-scale").value = String(v);
      piRefresh();
    });
    bind("pp-pd-sync", "change", () => {
      try {
        setPref("pdfDualSyncScroll", !!$("pp-pd-sync").checked);
      } catch (e) { /* ignore */ }
    });
    bind("pp-pd-zoom", "change", () => {
      try {
        setPref("pdfDualSyncZoom", !!$("pp-pd-zoom").checked);
      } catch (e) { /* ignore */ }
    });

    try { renderAll(); } catch (e) { /* 渲染失败不影响面板其余部分 */ }
  }

  init();
  if (typeof window !== "undefined" && window.setTimeout) {
    window.setTimeout(init, 400);
    window.setTimeout(init, 1200);
  }
})();
