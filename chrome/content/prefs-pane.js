// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 设置窗格脚本（0.14.0 重构）
 * 由 Zotero.PreferencePanes.register({scripts:[...]}) 注入设置窗口执行。
 * 运行上下文是设置窗口：访问不到 bootstrap 作用域，但可经 Zotero.Papilot
 * 访问主模块暴露的 rankColumn / citationColumn。
 * 账号与 AI 模型通道的 UI 逻辑在 prefs-account.js（同一窗格的第二个脚本）。
 *
 * ⚠ Zotero 先加载本脚本、后插入 fragment DOM（_loadPane 顺序）——init 必须
 * 探测关键节点、不存在就延迟重试，否则 null 崩溃导致面板永远不 loaded。
 */
/* global Zotero, Components, window, document */

(function () {
  const PREFIX = "extensions.zotero.papilot.";
  const zh = (Zotero.locale || "").toLowerCase().startsWith("zh");
  const txt = {
    pickJson: zh ? "选择分区数据 JSON" : "Select rank data JSON",
    cacheCleared: zh ? "缓存已清空" : "Cache cleared",
  };

  const $ = (id) => document.getElementById(id);
  const rankColumn = () => Zotero.Papilot && Zotero.Papilot.rankColumn;

  const getPref = (key, fallback) => {
    try {
      const v = Zotero.Prefs.get(PREFIX + key, true);
      return v === undefined || v === null ? fallback : v;
    } catch (e) { return fallback; }
  };

  const setPref = (key, value) => {
    try { Zotero.Prefs.set(PREFIX + key, value, true); } catch (e) { /* 写失败不拖死面板 */ }
  };

  function setText(id, msg, color) {
    const el = $(id);
    if (el) { el.textContent = msg; el.style.color = color || "var(--pp-muted)"; }
  }

  /* ---------- easyScholar ---------- */

  function refreshEsStats() {
    try {
      const rc = rankColumn();
      let msg = (zh ? "缓存条目：" : "Cached: ") + rc.esCacheSize();
      // 0.56.0：内置官方 Key 已移除（第三方 Key 无商用授权）。把「为什么没有在线数据」
      // 直接写在状态行里，否则未填 Key 的用户只会看到分区列空白，误判成插件坏了。
      const st = (typeof rc.esStatus === "function") ? rc.esStatus() : "ok";
      if (st === "need_key") {
        setText("pp-es-stats", msg + (zh ? " · 在线查询需填写自己的 easyScholar Key（easyscholar.cn 免费注册）"
                                         : " · Online lookup needs your own easyScholar key (free at easyscholar.cn)"),
          "var(--pp-warn)");
        return;
      }
      if (st === "hosted") {
        setText("pp-es-stats", msg + (zh ? " · 正在使用账号托管的 Key" : " · using hosted key"),
          "var(--pp-success)");
        return;
      }
      setText("pp-es-stats", msg);
    } catch (e) { /* ignore */ }
  }

  async function onEsClear() {
    try { await rankColumn().esClearCache(); } catch (e) { /* ignore */ }
    refreshEsStats();
    setText("pp-es-stats", txt.cacheCleared, "var(--pp-success)");
  }

  /* ---------- easyScholar Key 托管（0.64.0 / 服务端 1.9.0） ----------
   * 用户自己的 Key 加密存进自己账号，换机器/重装后自动取回。
   * ★ 服务端只做保险箱，不提供任何第三方额度——文案里不要说成「官方 Key」。
   */
  const account = () => Zotero.Papilot && Zotero.Papilot.account;

  async function refreshHostState() {
    const el = $("pp-es-host-state");
    if (!el) return;
    const A = account();
    if (!A || !A.isLoggedIn || !A.isLoggedIn()) {
      setText("pp-es-host-state", zh ? "未登录账号（托管需登录）" : "Sign in to host your key");
      return;
    }
    try {
      const meta = await A.hostedSecrets();
      const st = meta && meta.easyscholar;
      if (st && st.set) {
        setText("pp-es-host-state", (zh ? "账号已托管：" : "Hosted: ") + (st.hint || "***"),
          "var(--pp-success)");
      } else {
        setText("pp-es-host-state", zh ? "账号未托管（换机器需重填）" : "Not hosted");
      }
    } catch (e) {
      setText("pp-es-host-state", (e && e.message) || "读取失败", "var(--pp-warn)");
    }
  }

  async function onHostSave() {
    const A = account();
    if (!A || !A.isLoggedIn || !A.isLoggedIn()) {
      setText("pp-es-host-state", zh ? "请先登录账号" : "Sign in first", "var(--pp-warn)");
      return;
    }
    const key = String(getPref("easyScholarKey", "") || "").trim();
    if (!key) {
      setText("pp-es-host-state", zh ? "请先在上方填入 SecretKey" : "Fill in the key first", "var(--pp-warn)");
      return;
    }
    try {
      await A.saveHostedSecret("easyscholar", key);
      setText("pp-es-host-state", zh ? "已加密保存到账号" : "Saved to your account", "var(--pp-success)");
      refreshHostState();
    } catch (e) {
      setText("pp-es-host-state", (e && e.message) || "保存失败", "var(--pp-warn)");
    }
  }

  async function onHostLoad() {
    const A = account();
    if (!A || !A.isLoggedIn || !A.isLoggedIn()) {
      setText("pp-es-host-state", zh ? "请先登录账号" : "Sign in first", "var(--pp-warn)");
      return;
    }
    try {
      const v = await A.revealHostedSecret("easyscholar");
      if (!v) throw new Error(zh ? "账号里没有托管的密钥" : "No hosted key");
      setPref("easyScholarKey", v);
      const input = $("pp-es-key");
      if (input) input.value = v;
      try { rankColumn()._lookupCache.clear(); } catch (e) { /* ignore */ }
      try { rankColumn()._esRefreshColumns(); } catch (e) { /* ignore */ }
      setText("pp-es-host-state", zh ? "已取回并填入" : "Restored", "var(--pp-success)");
      refreshEsStats();
    } catch (e) {
      setText("pp-es-host-state", (e && e.message) || "取回失败", "var(--pp-warn)");
    }
  }

  async function onHostDelete() {
    const A = account();
    if (!A || !A.isLoggedIn || !A.isLoggedIn()) {
      setText("pp-es-host-state", zh ? "请先登录账号" : "Sign in first", "var(--pp-warn)");
      return;
    }
    try {
      await A.deleteHostedSecret("easyscholar");
      setText("pp-es-host-state", zh ? "已删除账号里的托管副本" : "Removed", "var(--pp-success)");
      refreshHostState();
    } catch (e) {
      setText("pp-es-host-state", (e && e.message) || "删除失败", "var(--pp-warn)");
    }
  }

  /* ---------- Semantic Scholar 被引量 ---------- */

  const citationColumn = () => Zotero.Papilot && Zotero.Papilot.citationColumn;

  function refreshS2Stats() {
    try {
      setText("pp-s2-stats", (zh ? "缓存条目：" : "Cached: ") + citationColumn().cacheSize());
    } catch (e) { /* ignore */ }
  }

  async function onS2Clear() {
    try { await citationColumn().clearCache(); } catch (e) { /* ignore */ }
    refreshS2Stats();
    setText("pp-s2-stats", txt.cacheCleared, "var(--pp-success)");
  }

  /* ---------- 分区数据文件选择 ---------- */

  function browseRankData() {
    const nsIFilePicker = Components.interfaces.nsIFilePicker;
    const fp = Components.classes["@mozilla.org/filepicker;1"]
      .createInstance(nsIFilePicker);
    fp.init(window, txt.pickJson, nsIFilePicker.modeOpen);
    fp.appendFilter("JSON", "*.json");
    fp.open((rv) => {
      if (rv !== nsIFilePicker.returnOK || !fp.file) return;
      const path = fp.file.path;
      Zotero.Prefs.set(PREFIX + "rankDataPath", path, true);
      const input = $("pp-rank-path-input");
      if (input) input.value = path;
    });
  }

  /* ---------- 敏感信息掩码：眼睛图标切换明文/隐藏 ---------- */

  function bindEye(inputId, btnId) {
    const input = $(inputId), btn = $(btnId);
    if (!input || !btn) return;
    btn.addEventListener("click", () => {
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.style.opacity = show ? "1" : "0.55";
      btn.title = show ? (zh ? "点击隐藏" : "Click to hide") : (zh ? "点击显示" : "Click to show");
    });
    btn.style.opacity = "0.55";
  }

  /* ---------- 分区显示细化（0.18.0） ---------- */

  /** 数据集勾选 chips：勾选状态写 rankDataSets pref（逗号分隔 kind） */
  function renderDatasets() {
    const box = $("pp-rank-datasets");
    const rc = rankColumn();
    if (!box || !rc || !rc.DATASETS) return;
    while (box.firstChild) box.removeChild(box.firstChild);
    const enabled = rc.enabledKinds();
    for (const ds of rc.DATASETS) {
      const on = enabled.has(ds.kind);
      // 0.72.3 无障碍：勾选 chip 是真按钮（原先只挂了 click 的 span，键盘完全不可达）。
      // pp-ds-chip 只设 font-size 不设 family，按钮补 font-family:inherit 免掉到 system-ui。
      const chip = document.createElementNS("http://www.w3.org/1999/xhtml", "button");
      chip.setAttribute("type", "button");
      chip.setAttribute("class", "pp-ds-chip" + (on ? " pp-ds-on" : ""));
      chip.setAttribute("aria-pressed", on ? "true" : "false");
      chip.setAttribute("style", "font-family:inherit;");
      chip.textContent = (on ? "✓ " : "") + ds.label;
      chip.addEventListener("click", () => {
        const cur = rc.enabledKinds();
        if (cur.has(ds.kind)) cur.delete(ds.kind); else cur.add(ds.kind);
        // 保持 DATASETS 声明顺序写入 pref
        const ordered = rc.DATASETS.map((d) => d.kind).filter((k) => cur.has(k));
        Zotero.Prefs.set(PREFIX + "rankDataSets", ordered.join(","), true);
        renderDatasets();
        renderRankPreview();
      });
      box.appendChild(chip);
    }
  }

  /** 每种数据集/评级的示例徽章（配色图例用） */
  const RANK_DEMO = {
    warning: { text: "⚠预警", level: 1 },
    jcr: { text: "Q1", level: 1 },
    ssci: { text: "SSCI Q2", level: 2 },
    cas: { text: "中科院1区", level: 1, top: true },
    casSmall: { text: "小类2区", level: 2 },
    ccf: { text: "CCF-A", level: 1 },
    cnTier: { text: "T1", level: 1 },
    pku: { text: "北大核心", level: 1 },
    cscd: { text: "CSCD核心", level: 1 },
    core: { text: "科技核心", level: 1 },
    cssci: { text: "CSSCI", level: 1 },
    if: { text: "IF 9.4", level: 0 },
    if5: { text: "IF5 8.1", level: 0 },
    casBase: { text: "基础版2区", level: 2 },
    esi: { text: "ESI 计算机", level: 0 },
    ajg: { text: "AJG 4", level: 0 },
    abdc: { text: "ABDC A", level: 0 },
    jci: { text: "JCI 1.2", level: 0 },
    org: { text: "T1中医学", level: 1 },
    legacy: { text: "自定义", level: 0 },
  };

  /** 配色图例：遍历全部数据集 kind（按显示优先级），勾选的逐个渲染示例徽章。
   *  0.18.1 改为「全 kind 图例」——不再按每行上限截断，用户一眼能核对自己
   *  的配色风格/勾选是否真的生效（旧版截断到 N 个，看起来像没生效）。 */
  function renderRankPreview() {
    const box = $("pp-rank-preview");
    const rc = rankColumn();
    if (!box || !rc) return;
    while (box.firstChild) box.removeChild(box.firstChild);
    const kinds = rc.enabledKinds();
    const mono = rc.badgeStyleMode() === "mono";
    const cap = document.createElementNS("http://www.w3.org/1999/xhtml", "span");
    cap.style.cssText = "color:var(--pp-muted);font-size:11px;margin-right:6px;";
    cap.textContent = "配色图例：";
    box.appendChild(cap);
    let n = 0;
    for (const ds of rc.DATASETS) {
      if (!kinds.has(ds.kind)) continue;
      const demo = RANK_DEMO[ds.kind];
      if (!demo) continue;
      const b = Object.assign({ kind: ds.kind }, demo); // kind 必须带上，_badgeColor 按 kind 取色
      const el = document.createElementNS("http://www.w3.org/1999/xhtml", "span");
      el.setAttribute("class", "pp-badge-demo");
      el.textContent = b.text;
      el.title = ds.label;
      el.style.background = mono ? "var(--pp-accent, #2563eb)" : rc._badgeColor(b);
      if (b.top) el.style.boxShadow = "inset 0 0 0 1.5px #ffd76a";
      box.appendChild(el);
      n++;
    }
    if (!n) {
      const empty = document.createElementNS("http://www.w3.org/1999/xhtml", "span");
      empty.style.cssText = "color:var(--pp-muted);font-size:11px;";
      empty.textContent = "（未勾选任何数据集，列表中不会显示任何分区徽章）";
      box.appendChild(empty);
      return;
    }
    const note = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
    note.style.cssText = "color:var(--pp-muted);font-size:11px;margin-top:6px;";
    note.textContent = "列表中每行最多显示 " + rc.maxBadges() + " 个徽章（超出显示 +N）；"
      + "灰蓝 = Q4/4区（低区，不是配色失效）；鼠标悬停单元格可见完整分区明细。";
    box.appendChild(note);
  }

  /* ---------- 分区配置导入导出（0.18.0） ---------- */

  const RANK_CFG_KEYS = ["rankDataSets", "rankMaxBadges", "rankBadgeStyle"];

  function exportRankCfg() {
    const cfg = {};
    for (const k of RANK_CFG_KEYS) cfg[k] = getPref(k, "");
    try {
      const nsIFilePicker = Components.interfaces.nsIFilePicker;
      const fp = Components.classes["@mozilla.org/filepicker;1"].createInstance(nsIFilePicker);
      fp.init(window, "导出分区配置", nsIFilePicker.modeSave);
      fp.defaultString = "papilot-rank-config.json";
      fp.appendFilter("JSON", "*.json");
      fp.open((rv) => {
        if (rv !== nsIFilePicker.returnOK && rv !== nsIFilePicker.returnReplace) return;
        try {
          const fos = Components.classes["@mozilla.org/network/file-output-stream;1"]
            .createInstance(Components.interfaces.nsIFileOutputStream);
          fos.init(fp.file, 0x02 | 0x08 | 0x20, 0o644, 0);
          const text = JSON.stringify(cfg, null, 2);
          const cos = Components.classes["@mozilla.org/intl/converter-output-stream;1"]
            .createInstance(Components.interfaces.nsIConverterOutputStream);
          cos.init(fos, "UTF-8");
          cos.writeString(text);
          cos.close();
          fos.close();
          setText("pp-rank-cfg-result", "✓ 已导出", "var(--pp-success)");
        } catch (e) {
          setText("pp-rank-cfg-result", "导出失败: " + e.message, "var(--pp-danger)");
        }
      });
    } catch (e) { /* ignore */ }
  }

  function importRankCfg() {
    try {
      const nsIFilePicker = Components.interfaces.nsIFilePicker;
      const fp = Components.classes["@mozilla.org/filepicker;1"].createInstance(nsIFilePicker);
      fp.init(window, "导入分区配置", nsIFilePicker.modeOpen);
      fp.appendFilter("JSON", "*.json");
      fp.open((rv) => {
        if (rv !== nsIFilePicker.returnOK || !fp.file) return;
        try {
          const fis = Components.classes["@mozilla.org/network/file-input-stream;1"]
            .createInstance(Components.interfaces.nsIFileInputStream);
          fis.init(fp.file, 0x01, 0, 0);
          const cis = Components.classes["@mozilla.org/intl/converter-input-stream;1"]
            .createInstance(Components.interfaces.nsIConverterInputStream);
          cis.init(fis, "UTF-8", 4096, 0);
          const out = {};
          const read = {};
          let text = "";
          while (cis.readString(4096, read) !== 0) text += read.value;
          cis.close();
          fis.close();
          const cfg = JSON.parse(text);
          let applied = 0;
          for (const k of RANK_CFG_KEYS) {
            if (cfg[k] !== undefined) {
              const v = k === "rankMaxBadges" ? Number(cfg[k]) : String(cfg[k]);
              Zotero.Prefs.set(PREFIX + k, v, true);
              applied++;
            }
          }
          renderDatasets();
          renderRankPreview();
          setText("pp-rank-cfg-result", "✓ 已导入 " + applied + " 项配置", "var(--pp-success)");
        } catch (e) {
          setText("pp-rank-cfg-result", "导入失败: " + e.message, "var(--pp-danger)");
        }
      });
    } catch (e) { /* ignore */ }
  }

  /* ---------- 初始化（DOM 就绪探测） ---------- */

  /* ---------- OCR（扫描版 PDF）子块：0.63.0 ---------- */

  // 这一小块用 XUL 控件 + 显式 Prefs 读写，**没有**走 preference= 声明式绑定：
  // 因为要钳制非法输入（页数 1–500、倍率只认 1.5/2/3）。声明式绑定会把空串 / 越界值
  // 原样写进 pref，于是 `ocrMaxPages=0` 会让识别循环一页都不跑、`ocrRenderScale=abc`
  // 会让 clampScale 悄悄回落——两者都是「点了没反应」型的静默失败。
  const OCR_DEFAULT_PAGES = 30;
  const OCR_SCALES = ["1.5", "2", "3"];
  const ocrService = () => (Zotero.Papilot && Zotero.Papilot.ocr) || null;

  /** 页数钳制：优先用 OcrService.clampMaxPages（识别流程与面板同一份判定），模块缺位时本地兜底 */
  function ocrClampPages(v) {
    const svc = ocrService();
    if (svc && typeof svc.clampMaxPages === "function") return svc.clampMaxPages(v);
    const n = Math.round(Number(v));
    if (!isFinite(n) || n <= 0) return OCR_DEFAULT_PAGES;
    return Math.min(500, Math.max(1, n));
  }

  function ocrClampScale(v) {
    const svc = ocrService();
    if (svc && typeof svc.pickScale === "function") return svc.pickScale(v);
    const s = String(v == null ? "" : v).trim();
    return OCR_SCALES.indexOf(s) >= 0 ? s : "2";
  }

  /** 绑定 OCR 子块。DOM 还没插进来时返回 false（由 init 与独立重试再调） */
  function initOcr() {
    const pages = $("pp-ocr-maxpages");
    const scale = $("pp-ocr-scale");
    const auto = $("pp-ocr-autofallback");
    const skip = $("pp-ocr-skip");
    if (!pages || !scale || !auto || !skip) return false;
    if (pages.getAttribute("data-pp-bound") === "1") return true;
    pages.setAttribute("data-pp-bound", "1");

    const hint = (msg) => {
      const el = $("pp-ocr-pages-msg");
      if (!el) return;
      el.textContent = msg || "";
      el.style.color = msg ? "var(--pp-warn)" : "";
    };

    // 初值：读 → 钳制 → 只在被钳制过时写回（避免每次打开面板都刷一遍 pref）
    const rawPages = getPref("ocrMaxPages", OCR_DEFAULT_PAGES);
    const nPages = ocrClampPages(rawPages);
    pages.value = String(nPages);
    if (String(rawPages) !== String(nPages)) {
      setPref("ocrMaxPages", nPages);
      hint(zh ? "已按 1–500 修正" : "Clamped to 1–500");
    }

    const rawScale = getPref("ocrRenderScale", "2");
    const sScale = ocrClampScale(rawScale);
    scale.value = sScale;
    if (String(rawScale) !== sScale) setPref("ocrRenderScale", sScale);

    auto.checked = getPref("ocrAutoFallback", true) !== false;
    skip.checked = getPref("ocrSkipExistingPages", true) !== false;

    // 用 change（失焦/提交）而不是 input：边打字边改写会跟用户的光标打架
    pages.addEventListener("change", () => {
      const raw = pages.value;
      const n = ocrClampPages(raw);
      pages.value = String(n);
      setPref("ocrMaxPages", n);
      hint(String(raw).trim() === String(n) ? "" : (zh ? "已按 1–500 修正" : "Clamped to 1–500"));
    });
    scale.addEventListener("command", () => {
      const s = ocrClampScale(scale.value);
      scale.value = s; // 非法值（理论上选不出来）回落默认，并保证界面与 pref 一致
      setPref("ocrRenderScale", s);
    });
    auto.addEventListener("command", () => { setPref("ocrAutoFallback", !!auto.checked); });
    skip.addEventListener("command", () => { setPref("ocrSkipExistingPages", !!skip.checked); });
    return true;
  }

  function init() {
    if (typeof Zotero === "undefined" || !Zotero.Papilot || !rankColumn()) {
      window.setTimeout(init, 400);
      return;
    }
    // Zotero 先执行脚本、后插入 fragment：关键节点不存在就延迟重试
    if (!$("pp-es-clear") || !$("pp-s2-clear")) {
      window.setTimeout(init, 300);
      return;
    }
    if (init._done) return;
    init._done = true;

    try { refreshEsStats(); } catch (e) { /* ignore */ }
    try { refreshHostState(); } catch (e) { /* ignore */ }
    try { refreshS2Stats(); } catch (e) { /* ignore */ }
    try { renderDatasets(); } catch (e) { /* ignore */ }
    try { renderRankPreview(); } catch (e) { /* ignore */ }

    const bind = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
    bind("pp-es-clear", "click", onEsClear);
    bind("pp-es-host-save", "click", onHostSave);
    bind("pp-es-host-load", "click", onHostLoad);
    bind("pp-es-host-del", "click", onHostDelete);
    bind("pp-s2-clear", "click", onS2Clear);
    bind("pp-rank-browse", "click", browseRankData);
    bind("pp-rank-export", "click", exportRankCfg);
    bind("pp-rank-import", "click", importRankCfg);
    // 配色风格/数量变化即时重绘预览（pref 双向绑定已持久化，主模块 observer 刷新列）
    bind("pp-rank-style", "change", renderRankPreview);
    bind("pp-rank-max", "input", renderRankPreview);
    // 敏感字段掩码切换（easyScholar Key / S2 Key；
    // 0.15.0 起账号服务器地址不再出现在设置界面——官方地址内置固定）
    bindEye("pp-es-key", "pp-es-key-eye");
    bindEye("pp-s2-key", "pp-s2-key-eye");
    try { initOcr(); } catch (e) { /* OCR 子块绑定失败不影响其它设置项 */ }
  }

  init();
  if (typeof window !== "undefined" && window.setTimeout) {
    window.setTimeout(init, 400);
    window.setTimeout(init, 1200);
  }

  // OCR 子块与其它控件同批插入 DOM：独立重试，避免「rankColumn 未就绪」把这块永久漏绑
  let ocrBootTries = 0;
  (function bootOcr() {
    if (initOcr()) return;
    if (++ocrBootTries > 12) return;
    try { window.setTimeout(bootOcr, 300); } catch (e) { /* ignore */ }
  })();
})();
