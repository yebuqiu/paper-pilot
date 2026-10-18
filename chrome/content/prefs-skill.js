/* PaperPilot 设置窗格脚本·技能商店卡片（0.48.x 新增）
 * 与 prefs-pane 等同窗格运行。渲染内容：
 *   ① 「打开技能商店」按钮（经 Zotero.PaperPilot.openSkillStore 调起独立窗口）；
 *   ② 已安装技能包 chips（SkillPacks.listInstalled，防御式：核心域未就绪时提示）；
 *   ③ 从剪贴板导入技能包 JSON（读剪贴板 → SkillPacks.install，装完刷新列表）。
 *
 * ⚠️ Zotero 先加载脚本、后插入 fragment DOM —— init 必须探测关键节点，
 *    不存在就延迟重试（同 prefs-pane.js / prefs-agent.js 纪律）。
 * ⚠️ 动态创建的节点一律经变量持有，不要用 $(…) 取动态节点（check-wiring 守卫）。
 * ⚠️ SkillPacks 核心域由并行模块提供，任何调用都包 try-catch，未就绪给提示不抛错。
 */
/* global Zotero, Components, window, document */

(function () {
  const zh = (Zotero.locale || "").toLowerCase().startsWith("zh");
  const $ = (id) => document.getElementById(id);
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const SP = () => (Zotero.PaperPilot && Zotero.PaperPilot.skillPacks) || null;

  const el = (tag, attrs, text) => {
    const node = document.createElementNS(HTML_NS, tag);
    if (attrs) for (const k of Object.keys(attrs)) {
      if (attrs[k] === undefined || attrs[k] === null) continue;
      node.setAttribute(k, attrs[k]);
    }
    if (text !== undefined) node.textContent = text;
    return node;
  };

  function setMsg(box, text, color) {
    if (!box) return;
    box.textContent = text || "";
    box.style.color = color || "var(--pp-muted)";
  }

  /* ---------------- ① 打开商店 ---------------- */

  function wireOpen() {
    const btn = $("pp-sk-open");
    if (!btn) return;
    btn.addEventListener("click", () => {
      setMsg($("pp-sk-msg"), "");
      try {
        const r = Zotero.PaperPilot.openSkillStore();
        if (!r) setMsg($("pp-sk-msg"),
          zh ? "窗口打开失败（主窗口未就绪？）" : "Failed to open store window",
          "var(--pp-danger)");
      } catch (e) {
        setMsg($("pp-sk-msg"), String((e && e.message) || e), "var(--pp-danger)");
      }
    });
  }

  /* ---------------- ② 已安装 chips ---------------- */

  /** 取包的展示名与版本（核心域结构未定稿时也能渲染：字符串 / 对象都兼容） */
  function packLabel(p) {
    if (p == null) return "?";
    if (typeof p === "string") return p;
    const name = p.name || p.id || p.title || "?";
    const ver = p.version || p.ver || "";
    return ver ? name + " " + ver : name;
  }

  function renderInstalled() {
    const host = $("pp-sk-installed");
    if (!host) return;
    while (host.firstChild) host.removeChild(host.firstChild);
    const sp = SP();
    if (!sp || typeof sp.listInstalled !== "function") {
      host.appendChild(el("span", { class: "pp-hint" },
        zh ? "技能包核心域未就绪（插件启动后可查看）" : "Skill packs module not ready"));
      return;
    }
    let packs = [];
    try { packs = sp.listInstalled() || []; } catch (e) { packs = []; }
    if (!packs.length) {
      host.appendChild(el("span", { class: "pp-hint" },
        zh ? "尚未安装任何技能包；点上方「打开技能商店」浏览精选" : "No skill packs installed yet"));
      return;
    }
    for (const p of packs) {
      let title = "";
      try { title = String((p && (p.description || p.desc)) || "").slice(0, 200); }
      catch (e) { title = ""; }
      const chip = el("span", { class: "pp-ds-chip", title: title || packLabel(p) },
        "🧩 " + packLabel(p));
      chip.addEventListener("click", () => {
        // 点击无操作（仅展示；安装 / 卸载 / 更新在商店窗口里管理）
      });
      host.appendChild(chip);
    }
  }

  /* ---------------- ③ 剪贴板导入 ---------------- */

  /** 读剪贴板（navigator.clipboard 优先，XPCOM 回落；与 prefs-agent.js 同款） */
  async function readClipboard() {
    try {
      const win = Zotero.getMainWindow();
      if (win && win.navigator && win.navigator.clipboard && win.navigator.clipboard.readText) {
        return String(await win.navigator.clipboard.readText() || "");
      }
    } catch (e) { /* 走 XPCOM 回落 */ }
    try {
      const clip = Components.classes["@mozilla.org/widget/clipboard;1"]
        .getService(Components.interfaces.nsIClipboard);
      const trans = Components.classes["@mozilla.org/widget/transferable;1"]
        .createInstance(Components.interfaces.nsITransferable);
      if (trans.init) trans.init(null);
      for (const flavor of ["text/plain", "text/unicode"]) {
        try {
          trans.addDataFlavor(flavor);
          clip.getData(trans, clip.kGlobalClipboard);
          const data = {};
          const len = {};
          try { trans.getTransferData(flavor, data, len); } catch (e) { data.value = trans.getTransferData(flavor); }
          if (data.value) {
            const str = data.value.QueryInterface(Components.interfaces.nsISupportsString);
            if (str && str.data) return String(str.data);
          }
        } catch (e) { /* 换下一个 flavor */ }
      }
    } catch (e) { /* ignore */ }
    return "";
  }

  function wireImport() {
    const btn = $("pp-sk-import");
    if (!btn) return;
    btn.addEventListener("click", async () => {
      const result = $("pp-sk-import-result");
      const sp = SP();
      if (!sp || typeof sp.install !== "function") {
        setMsg(result, zh ? "技能包核心域未就绪" : "Skill packs module not ready", "var(--pp-danger)");
        return;
      }
      const text = await readClipboard();
      if (!text.trim()) {
        setMsg(result, zh ? "剪贴板为空" : "Clipboard is empty", "var(--pp-danger)");
        return;
      }
      let pack = null;
      try { pack = JSON.parse(text); } catch (e) {
        setMsg(result, zh ? "剪贴板内容不是合法 JSON" : "Clipboard is not valid JSON", "var(--pp-danger)");
        return;
      }
      try {
        const r = await sp.install(pack);
        if (r && r.ok === false) {
          setMsg(result,
            (zh ? "安装失败：" : "Install failed: ") + (r && (r.error || r.reason) || ""),
            "var(--pp-danger)");
          return;
        }
        renderInstalled();
        setMsg(result,
          (zh ? "✓ 已安装：" : "Installed: ") + packLabel(pack && pack.pack ? pack.pack : pack),
          "var(--pp-success)");
      } catch (e) {
        setMsg(result, String((e && e.message) || e), "var(--pp-danger)");
      }
    });
  }

  /* ---------------- init（探测重试，同 prefs-agent.js 纪律） ---------------- */

  function init() {
    if (typeof Zotero === "undefined" || !Zotero.Prefs) {
      window.setTimeout(init, 400);
      return;
    }
    if (!$("pp-sk-open") || !$("pp-sk-installed") || !$("pp-sk-import") || !$("pp-sk-source")) {
      window.setTimeout(init, 400);
      window.setTimeout(init, 1200);
      return;
    }
    if (init._done) return;
    init._done = true;

    try { wireOpen(); } catch (e) { /* 失败不影响面板其余部分 */ }
    try { renderInstalled(); } catch (e) { /* ignore */ }
    try { wireImport(); } catch (e) { /* ignore */ }
  }

  init();
  if (typeof window !== "undefined" && window.setTimeout) {
    window.setTimeout(init, 400);
    window.setTimeout(init, 1200);
  }
})();
