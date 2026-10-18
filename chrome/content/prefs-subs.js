/* PaperPilot 设置窗格脚本 · 检索订阅（Saved query → 定时检索 → 自动入库 + 速递笔记）
 *
 * 集成方在 prefs.xhtml 里提供的节点（缺任何一个都不会炸，只是那块不渲染）：
 *   列表容器   <html:div id="pp-subs-list"></html:div>
 *   新建按钮   <html:button id="pp-subs-add">添加订阅</html:button>
 *   表单       #pp-sub-name / #pp-sub-keywords / #pp-sub-cats / #pp-sub-time / #pp-sub-auto
 *   提示位     <html:span id="pp-sub-msg"></html:span>
 *
 * 行为：
 *   - 列表最多渲染 20 条（超出的在底部提示「仅显示前 20 条」）；
 *   - 「立即运行」走 Zotero.PaperPilot.searchSubs.run(id)，完成后在行内显示 `+N 新入库 / M 跳过`；
 *   - 「删除」优先 Services.prompt.confirm，不可用则直接删；
 *   - 新建成功清空表单并重渲染；失败只在提示位说明（不弹窗、不打断）。
 *
 * ⚠️ Zotero 先加载脚本、后插入 fragment DOM —— init 必须探测 #pp-subs-list，
 *    不存在就延迟重试（同 prefs-schedule.js / prefs-agent.js 纪律）。
 * ⚠️ 动态生成的节点一律经变量持有，不用 $(…) 取动态节点（check-wiring 守卫）。
 */
/* global Zotero, Services, window, document */

(function () {
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const MAX_ROWS = 20;
  const $ = (id) => document.getElementById(id);
  const S = () => ((typeof Zotero !== "undefined" && Zotero.PaperPilot && Zotero.PaperPilot.searchSubs) || null);

  const el = (tag, attrs, text) => {
    const node = document.createElementNS(HTML_NS, tag);
    if (attrs) for (const k of Object.keys(attrs)) {
      if (attrs[k] === undefined || attrs[k] === null) continue;
      node.setAttribute(k, attrs[k]);
    }
    if (text !== undefined) node.textContent = text;
    return node;
  };

  function setMsg(text, color) {
    const node = $("pp-sub-msg");
    if (!node) return;
    node.textContent = text || "";
    node.style.color = color || "var(--pp-muted)";
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

  function specLine(sub) {
    const parts = [];
    if (sub.keywords) parts.push("关键词：" + sub.keywords);
    if (sub.categories) parts.push("分类：" + sub.categories);
    return parts.length ? parts.join(" · ") : "（未设置检索条件）";
  }

  function runLabel(sub) {
    return sub.dailyTime ? "每日 " + sub.dailyTime : "仅手动";
  }

  function reasonText(r) {
    const reason = (r && r.reason) || "";
    if (reason === "no_arxiv") return "arXiv 模块未就绪";
    if (reason === "network") return "网络或解析失败";
    if (reason === "empty") return "没有命中结果";
    if (reason === "no_sub") return "订阅不存在";
    if (reason === "busy") return "上一次运行尚未结束";
    return reason || "未知错误";
  }

  /** 一行：名称 · 条件 · 每日/手动 · 上次运行 · [立即运行][删除] */
  function buildRow(sub, moduleReady) {
    const row = el("div", {
      class: "pp-row pp-subs-row",
      "data-sub": sub.id,
      style: "align-items:flex-start;border-bottom:1px solid var(--pp-border);padding:8px 0;margin-top:0;flex-wrap:wrap;",
    });

    const head = el("div", { style: "flex:1 1 100%;display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;" });
    head.appendChild(el("span", { style: "font-weight:600;" }, sub.name || "（未命名）"));
    head.appendChild(el("span", { class: "pp-hint pp-subs-spec" }, specLine(sub)));
    head.appendChild(el("span", { class: "pp-hint pp-subs-time" }, runLabel(sub)));
    head.appendChild(el("span", { class: "pp-hint pp-subs-last" },
      "上次运行：" + (sub.lastRun || "未运行")));
    row.appendChild(head);

    const btnRun = el("button", { class: "pp-btn pp-btn-sm pp-subs-run" }, "立即运行");
    const btnDel = el("button", { class: "pp-btn pp-btn-sm pp-subs-del" }, "删除");
    if (!moduleReady) btnRun.disabled = true;
    const msg = el("span", { class: "pp-hint pp-subs-msg", style: "flex:1 1 100%;" });

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
      try {
        const r = await s.run(sub.id);
        if (r && r.ok) {
          msg.textContent = "+" + (r.added || 0) + " 新入库 / " + (r.skipped || 0) + " 跳过"
            + (r.failed ? " / " + r.failed + " 失败" : "");
          msg.style.color = "var(--pp-success)";
        } else {
          msg.textContent = "未完成：" + reasonText(r);
          msg.style.color = "var(--pp-danger)";
        }
      } catch (e) {
        msg.textContent = "运行失败：" + ((e && (e.message || e)) || e);
        msg.style.color = "var(--pp-danger)";
      } finally {
        btnRun.disabled = !S();
      }
    });

    btnDel.addEventListener("click", () => {
      const s = S();
      if (!s || typeof s.remove !== "function") {
        setMsg("检索订阅模块未就绪（请重启 Zotero 后再试）", "var(--pp-danger)");
        return;
      }
      if (!confirmDelete(sub.name || "")) return;
      let ok = false;
      try { ok = !!s.remove(sub.id); }
      catch (e) { ok = false; }
      if (ok) {
        setMsg("已删除订阅：" + (sub.name || ""), "var(--pp-success)");
        render();
      } else {
        setMsg("删除失败（订阅可能已不存在）", "var(--pp-danger)");
      }
    });

    row.appendChild(btnRun);
    row.appendChild(btnDel);
    row.appendChild(msg);
    return row;
  }

  function render() {
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
      try { subs = s.list() || []; }
      catch (e) { subs = []; }
    }
    if (!subs.length) {
      host.appendChild(el("div", { class: "pp-hint" }, "还没有订阅：填好下方表单后点「添加订阅」。"));
      return;
    }

    const shown = subs.slice(0, MAX_ROWS);
    for (const sub of shown) host.appendChild(buildRow(sub, moduleReady));
    if (subs.length > shown.length) {
      host.appendChild(el("div", { class: "pp-hint" },
        "共 " + subs.length + " 条订阅，仅显示前 " + MAX_ROWS + " 条。"));
    }
  }

  function clearForm() {
    for (const id of ["pp-sub-name", "pp-sub-keywords", "pp-sub-cats", "pp-sub-time"]) {
      const node = $(id);
      if (node) node.value = "";
    }
    const auto = $("pp-sub-auto");
    if (auto) auto.checked = true;
  }

  function addFromForm() {
    const s = S();
    if (!s || typeof s.add !== "function") {
      setMsg("检索订阅模块未就绪（请重启 Zotero 后再试）", "var(--pp-danger)");
      return;
    }
    const nameNode = $("pp-sub-name");
    const kwNode = $("pp-sub-keywords");
    const catNode = $("pp-sub-cats");
    const timeNode = $("pp-sub-time");
    const autoNode = $("pp-sub-auto");

    const name = String((nameNode && nameNode.value) || "").trim();
    const keywords = String((kwNode && kwNode.value) || "").trim();
    const categories = String((catNode && catNode.value) || "").trim();
    const dailyTime = String((timeNode && timeNode.value) || "").trim();
    const autoImport = autoNode ? !!autoNode.checked : true;

    if (!name) {
      setMsg("请填写订阅名称", "var(--pp-danger)");
      try { if (nameNode) nameNode.focus(); } catch (e) { /* ignore */ }
      return;
    }
    if (!keywords && !categories) {
      setMsg("关键词与分类至少填一个", "var(--pp-danger)");
      try { if (kwNode) kwNode.focus(); } catch (e) { /* ignore */ }
      return;
    }

    let sub = null;
    try {
      sub = s.add({
        name: name,
        keywords: keywords,
        categories: categories,
        dailyTime: dailyTime,
        max: 10,
        autoImport: autoImport,
      });
    } catch (e) {
      sub = null;
    }
    if (!sub) {
      setMsg("添加失败（名称与检索条件必填）", "var(--pp-danger)");
      return;
    }
    clearForm();
    render();
    setMsg("已添加：" + sub.name, "var(--pp-success)");
  }

  /* ---------------- init（探测重试，同 prefs-schedule.js 纪律） ---------------- */

  function retry() {
    try {
      window.setTimeout(init, 400);
      window.setTimeout(init, 1200);
    } catch (e) { /* ignore */ }
  }

  function init() {
    if (typeof Zotero === "undefined" || !Zotero.Prefs) { retry(); return; }
    if (!$("pp-subs-list")) { retry(); return; }
    if (init._done) return;
    init._done = true;

    try {
      const auto = $("pp-sub-auto");
      if (auto) auto.checked = true;
      const addBtn = $("pp-subs-add");
      if (addBtn) {
        addBtn.addEventListener("click", function (ev) {
          try { if (ev && ev.preventDefault) ev.preventDefault(); } catch (e) { /* ignore */ }
          addFromForm();
        });
      }
      render();
    } catch (e) {
      try { Zotero.logError(e); } catch (e2) { /* ignore */ }
    }
  }

  init();
  if (typeof window !== "undefined" && window.setTimeout) {
    window.setTimeout(init, 400);
    window.setTimeout(init, 1200);
  }
})();
