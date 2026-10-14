/* PaperPilot 设置窗格脚本（0.14.0 重构）
 * 由 Zotero.PreferencePanes.register({scripts:[...]}) 注入设置窗口执行。
 * 运行上下文是设置窗口：访问不到 bootstrap 作用域，但可经 Zotero.PaperPilot
 * 访问主模块暴露的 rankColumn / citationColumn。
 * 账号与 AI 模型通道的 UI 逻辑在 prefs-account.js（同一窗格的第二个脚本）。
 *
 * ⚠️ Zotero 先加载本脚本、后插入 fragment DOM（_loadPane 顺序）——init 必须
 * 探测关键节点、不存在就延迟重试，否则 null 崩溃导致面板永远不 loaded。
 */
/* global Zotero, Components, window, document */

(function () {
  const PREFIX = "extensions.zotero.paperpilot.";
  const zh = (Zotero.locale || "").toLowerCase().startsWith("zh");
  const txt = {
    pickJson: zh ? "选择分区数据 JSON" : "Select rank data JSON",
    cacheCleared: zh ? "缓存已清空" : "Cache cleared",
  };

  const $ = (id) => document.getElementById(id);
  const rankColumn = () => Zotero.PaperPilot && Zotero.PaperPilot.rankColumn;

  const getPref = (key, fallback) => {
    try {
      const v = Zotero.Prefs.get(PREFIX + key, true);
      return v === undefined || v === null ? fallback : v;
    } catch (e) { return fallback; }
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
      // 0.41.0：内置官方 Key 仅「专业版 / 新用户试用期」可用。把「为什么没有在线数据」
      // 直接写在状态行里，否则免费版用户只会看到分区列空白，误判成插件坏了。
      const st = (typeof rc.esStatus === "function") ? rc.esStatus() : "ok";
      if (st === "need_key") {
        setText("pp-es-stats", msg + (zh ? " · 在线查询需专业版，或填写自己的 Key"
                                         : " · Online lookup needs Pro or your own key"),
          "var(--pp-warn)");
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

  /* ---------- Semantic Scholar 被引量 ---------- */

  const citationColumn = () => Zotero.PaperPilot && Zotero.PaperPilot.citationColumn;

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

  /* ---------- 敏感信息掩码：👁 切换明文/隐藏 ---------- */

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
      const chip = document.createElementNS("http://www.w3.org/1999/xhtml", "span");
      chip.setAttribute("class", "pp-ds-chip" + (on ? " pp-ds-on" : ""));
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
      fp.defaultString = "paperpilot-rank-config.json";
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

  function init() {
    if (typeof Zotero === "undefined" || !Zotero.PaperPilot || !rankColumn()) {
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
    try { refreshS2Stats(); } catch (e) { /* ignore */ }
    try { renderDatasets(); } catch (e) { /* ignore */ }
    try { renderRankPreview(); } catch (e) { /* ignore */ }

    const bind = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
    bind("pp-es-clear", "click", onEsClear);
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
  }

  init();
  if (typeof window !== "undefined" && window.setTimeout) {
    window.setTimeout(init, 400);
    window.setTimeout(init, 1200);
  }
})();
