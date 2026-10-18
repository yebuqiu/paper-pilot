/* PaperPilot 设置窗格脚本 · 定时任务卡片（研究晨报 / 阅读周报 / 库体检）
 *
 * 由集成方在 prefs.xhtml 里放一个空容器 `<html:div id="pp-sch-rows"></html:div>`，
 * 本脚本按 Scheduler.JOBS 动态生成三行（时间输入 + 启用状态 + 「立即运行」）：
 *   - 时间输入直接读写 pref（不从 preference= 声明式绑定：动态节点无法声明）；
 *   - 运行入口走 Zotero.PaperPilot.scheduler.runJob(id)（模块未就绪时给明确提示）；
 *   - 上次运行日期读 scheduleLastRun（JSON {jobId:"YYYY-MM-DD"}）。
 *
 * ⚠️ Zotero 先加载脚本、后插入 fragment DOM —— init 必须探测 pp-sch-rows，
 *    不存在就延迟重试（同 prefs-agent.js / prefs-pane.js 纪律）。
 * ⚠️ 动态生成的节点一律经变量持有，不用 $(…) 取动态节点（check-wiring 守卫）。
 */
/* global Zotero, window, document */

(function () {
  const PREFIX = "extensions.zotero.paperpilot.";
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const $ = (id) => document.getElementById(id);
  const S = () => (Zotero.PaperPilot && Zotero.PaperPilot.scheduler) || null;

  /* 模块未就绪时的展示副本：时间仍可先设置（pref 直连），只有「立即运行」不可用 */
  const FALLBACK_JOBS = [
    { id: "digest", label: "每日研究晨报", desc: "每天固定时间生成最近新增文献清单笔记" },
    { id: "weekly", label: "每周阅读周报", desc: "每周固定时间汇总阅读统计为笔记" },
    { id: "health", label: "每周库体检", desc: "每周固定时间跑库健康检查并生成报告笔记" },
  ];
  const FALLBACK_PREF = {
    digest: "scheduleDailyDigest",
    weekly: "scheduleWeeklyReport",
    health: "scheduleLibHealth",
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

  function jobs() {
    const s = S();
    if (s && Array.isArray(s.JOBS) && s.JOBS.length) return s.JOBS;
    return FALLBACK_JOBS;
  }

  function prefKeyOf(id) {
    const s = S();
    const key = (s && s.PREF_TIME && s.PREF_TIME[id]) || FALLBACK_PREF[id];
    return PREFIX + (key || FALLBACK_PREF[id]);
  }

  function readTime(id) {
    try { return String(Zotero.Prefs.get(prefKeyOf(id), true) || "").trim(); }
    catch (e) { return ""; }
  }

  function writeTime(id, value) {
    try { Zotero.Prefs.set(prefKeyOf(id), String(value || ""), true); return true; }
    catch (e) {
      try { Zotero.logError(e); } catch (e2) { /* ignore */ }
      return false;
    }
  }

  function lastRunOf(id) {
    try {
      const raw = String(Zotero.Prefs.get(PREFIX + "scheduleLastRun", true) || "");
      if (!raw) return "";
      const o = JSON.parse(raw);
      return (o && typeof o === "object" && !Array.isArray(o) && o[id]) ? String(o[id]) : "";
    } catch (e) {
      return "";
    }
  }

  /** "HH:MM" / "H:MM" / "HHMM"；空或非法返回 null */
  function parseTime(raw) {
    const s = String(raw == null ? "" : raw).trim();
    if (!s) return null;
    let m = s.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) m = s.match(/^(\d{1,2})(\d{2})$/);
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (!(h >= 0 && h <= 23) || !(min >= 0 && min <= 59)) return null;
    return { h: h, m: min };
  }

  /** 优先用模块的 state()（单一真源）；模块缺席时按同一规则本地推导 */
  function stateOf(id) {
    const s = S();
    if (s && typeof s.state === "function") {
      try {
        const list = s.state() || [];
        for (const st of list) if (st && st.id === id) return st;
      } catch (e) { /* 回落本地 */ }
    }
    const time = readTime(id);
    return { id: id, time: time, enabled: !!parseTime(time), lastRun: lastRunOf(id) };
  }

  function setMsg(node, text, color) {
    if (!node) return;
    node.textContent = text || "";
    node.style.color = color || "var(--pp-muted)";
  }

  function buildRow(job, moduleReady) {
    const row = el("div", {
      class: "pp-row pp-sch-row",
      "data-job": job.id,
      style: "align-items:flex-start;border-bottom:1px solid var(--pp-border);padding:8px 0;margin-top:0;",
    });

    const head = el("div", { style: "flex:1 1 100%;display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;" });
    head.appendChild(el("span", { style: "font-weight:600;" }, job.label));
    head.appendChild(el("span", { class: "pp-hint" }, job.desc || ""));
    row.appendChild(head);

    const input = el("input", {
      type: "text",
      class: "pp-input pp-sch-time",
      maxlength: "5",
      placeholder: "HH:MM，留空关闭",
      style: "width:130px;",
    });
    input.value = readTime(job.id);
    const stateEl = el("span", { class: "pp-hint pp-sch-state", style: "min-width:200px;" });
    const btn = el("button", { class: "pp-btn pp-btn-sm pp-sch-run" }, "立即运行");
    if (!moduleReady) btn.disabled = true;
    const msg = el("span", { class: "pp-hint pp-sch-msg", style: "flex:1 1 100%;" });

    const refreshState = () => {
      const st = stateOf(job.id);
      stateEl.textContent = (st.enabled ? "已启用（" + st.time + "）" : "未启用")
        + " · 上次运行：" + (st.lastRun || "未运行");
      stateEl.style.color = st.enabled ? "var(--pp-muted)" : "var(--pp-warn)";
    };

    input.addEventListener("change", () => {
      const v = String(input.value || "").trim();
      input.value = v;
      const saved = writeTime(job.id, v);
      if (!saved) {
        setMsg(msg, "保存失败（pref 写入异常）", "var(--pp-danger)");
      } else if (v && !parseTime(v)) {
        setMsg(msg, "格式无效：" + v + "（应为 HH:MM，如 07:30；留空=关闭）", "var(--pp-danger)");
      } else {
        setMsg(msg, v ? "✓ 已保存：" + v : "已关闭该任务", "var(--pp-success)");
      }
      refreshState();
    });

    btn.addEventListener("click", async () => {
      const s = S();
      if (!s || typeof s.runJob !== "function") {
        setMsg(msg, "定时任务模块未就绪（请重启 Zotero 后再试）", "var(--pp-danger)");
        return;
      }
      btn.disabled = true;
      setMsg(msg, "运行中…", "var(--pp-muted)");
      try {
        const r = await s.runJob(job.id);
        if (r && r.ok) {
          setMsg(msg, "✓ 已生成笔记：" + (r.noteTitle || job.label), "var(--pp-success)");
        } else {
          setMsg(msg, "失败：" + ((r && r.error) || "未知错误"), "var(--pp-danger)");
        }
      } catch (e) {
        setMsg(msg, "失败：" + ((e && (e.message || e)) || e), "var(--pp-danger)");
      } finally {
        btn.disabled = !S();
        refreshState();
      }
    });

    row.appendChild(input);
    row.appendChild(stateEl);
    row.appendChild(btn);
    row.appendChild(msg);
    refreshState();
    return row;
  }

  function render() {
    const host = $("pp-sch-rows");
    if (!host) return;
    while (host.firstChild) host.removeChild(host.firstChild);

    const s = S();
    const moduleReady = !!(s && typeof s.runJob === "function");
    if (!moduleReady) {
      host.appendChild(el("div", { class: "pp-hint", style: "color:var(--pp-warn);" },
        "定时任务模块未就绪：时间仍可先设置，保存后重启 Zotero 生效。"));
    }
    for (const job of jobs()) host.appendChild(buildRow(job, moduleReady));
  }

  /* ---------------- init（探测重试，同 prefs-agent.js 纪律） ---------------- */

  function retry() {
    try {
      window.setTimeout(init, 400);
      window.setTimeout(init, 1200);
    } catch (e) { /* ignore */ }
  }

  function init() {
    if (typeof Zotero === "undefined" || !Zotero.Prefs) { retry(); return; }
    if (!$("pp-sch-rows")) { retry(); return; }
    if (init._done) return;
    init._done = true;
    try { render(); }
    catch (e) {
      try { Zotero.logError(e); } catch (e2) { /* ignore */ }
    }
  }

  init();
  if (typeof window !== "undefined" && window.setTimeout) {
    window.setTimeout(init, 400);
    window.setTimeout(init, 1200);
  }
})();
