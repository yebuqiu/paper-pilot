// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 设置窗格脚本 · 坚果云云同步（0.56.0）
 *
 * 运行上下文是设置窗口作用域：拿不到 bootstrap 作用域，全部经 Zotero.Papilot.cloudSync。
 *
 * 面板职责（刻意收窄）：
 *   ① 账号/应用密码 → 保存并测试（走 CloudSync.login，凭据校验失败会回滚）；
 *   ② 同步范围 / 冲突策略 / 方向 / 自动同步间隔 / 大小阈值；
 *   ③ 手动同步 + 取消 + 收集技能包 + 打开本地目录 + 退出登录；
 *   ④ 订阅 CloudSync 的 state/progress/log 事件渲染进度与日志。
 *
 * ⚠️ Zotero 先加载脚本、后插入 fragment DOM —— init 必须探测 #pp-cloud-email，
 *    不存在就延迟重试（同 prefs-subs.js / prefs-schedule.js 纪律）。
 * ⚠️ 应用密码默认不回显：输入框留空 = 沿用已保存的值，避免每次打开面板都明文铺在屏幕上。
 * ⚠️ 动态节点一律经变量持有，不用 $() 取动态节点（check-wiring 守卫）。
 */
/* global Zotero, Services, window, document */

(function () {
  const $ = (id) => document.getElementById(id);
  const S = () => ((typeof Zotero !== "undefined" && Zotero.Papilot && Zotero.Papilot.cloudSync) || null);

  const APP_PW_URL = "https://www.jianguoyun.com/dashboard#/settings/security";

  let unsub = null;
  let busy = false;
  let inited = false;

  function setMsg(text, kind) {
    const node = $("pp-cloud-msg");
    if (!node) return;
    node.textContent = text || "";
    if (kind === "bad") node.style.color = "#d9534f";
    else if (kind === "ok") node.style.color = "#2e9e5b";
    else node.style.color = "var(--pp-muted)";
  }

  function val(id) {
    const n = $(id);
    return n ? String(n.value == null ? "" : n.value).trim() : "";
  }
  function checked(id) {
    const n = $(id);
    return !!(n && n.checked);
  }
  function setVal(id, v) {
    const n = $(id);
    if (n) n.value = v == null ? "" : String(v);
  }
  function setChecked(id, v) {
    const n = $(id);
    if (n) n.checked = !!v;
  }

  /** 错误文案：把 code 翻译成人话；AUTH_EXPIRED 额外提示「不是登录密码」 */
  function errText(e) {
    const code = (e && e.code) || "";
    const msg = String((e && e.message) || e || "");
    if (code === "AUTH_REQUIRED" || code === "AUTH_EXPIRED") {
      return "授权失败：请确认填的是「应用密码」（账户信息 → 安全选项 → 添加应用密码），不是登录密码。" +
        (msg ? "（" + msg + "）" : "");
    }
    if (code === "NETWORK" || code === "TIMEOUT") return "网络不通或超时，稍后重试即可；已完成的文件不会重传。";
    if (code === "QUOTA") return "坚果云空间不足，请清理云端或调小同步范围。";
    if (code === "FORBIDDEN") return "路径无权限（403 不是授权过期），请检查同步目录是否属于该账号。";
    if (code === "TOO_LARGE") return msg || "文件超过上限，已跳过。";
    return msg || "操作失败";
  }

  function datasetsCsv() {
    const out = [];
    if (checked("pp-cloud-ds-settings")) out.push("settings");
    if (checked("pp-cloud-ds-chat")) out.push("chatSessions");
    if (checked("pp-cloud-ds-packs")) out.push("packages");
    return out.join(",");
  }

  function renderDatasets(csv) {
    const set = new Set(String(csv || "").split(",").map((s) => s.trim()).filter(Boolean));
    setChecked("pp-cloud-ds-settings", set.has("settings"));
    setChecked("pp-cloud-ds-chat", set.has("chatSessions"));
    setChecked("pp-cloud-ds-packs", set.has("packages"));
  }

  function renderStatus() {
    const cs = S();
    if (!cs) return;
    let st = null;
    try { st = cs.status(); } catch (e) { return; }
    if (!st) return;

    const dot = $("pp-cloud-dot");
    const state = $("pp-cloud-state");
    const last = $("pp-cloud-last");
    if (state) state.textContent = st.message || st.state;
    if (dot) {
      const color = st.state === "error" ? "#d9534f"
        : (st.state === "done" ? "#2e9e5b"
          : (st.state === "warn" ? "#d9962b" : "#8a8f98"));
      dot.style.color = color;
    }
    if (last) {
      const t = st.lastSyncAt ? new Date(st.lastSyncAt).toLocaleString() : "从未同步";
      last.textContent = "上次同步：" + t + " · 设备：" + (st.deviceName || "-");
    }

    const bar = $("pp-cloud-bar");
    const prog = $("pp-cloud-progress");
    if (bar && prog) {
      const total = Number(st.total) || 0;
      const cur = Number(st.current) || 0;
      let pct = 0;
      if (st.bytesTotal > 0 && st.bytesDone > 0) pct = Math.min(100, Math.round(st.bytesDone / st.bytesTotal * 100));
      else if (total > 0) pct = Math.min(100, Math.round(cur / total * 100));
      else if (st.state === "done") pct = 100;
      bar.style.width = pct + "%";
      if (st.running && st.file) {
        prog.textContent = (st.phase === "retry" ? "重试中 · " : "") + st.file + "（" + cur + "/" + total + "）";
      } else if (st.state === "error") {
        prog.textContent = errText(st.lastError);
      } else {
        prog.textContent = st.state === "done" ? "本轮完成" : "";
      }
    }
  }

  function renderLogs() {
    const cs = S();
    const box = $("pp-cloud-log");
    if (!cs || !box) return;
    let logs = [];
    try { logs = cs.logs ? cs.logs() : []; } catch (e) { logs = []; }
    box.textContent = logs.slice(-12).map((l) => {
      const d = new Date(l.at || Date.now());
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      return hh + ":" + mm + " " + (l.msg || "");
    }).join("\n");
    box.scrollTop = box.scrollHeight;
  }

  function renderAll() {
    const cs = S();
    if (!cs) return;
    let cfg = null;
    try { cfg = cs.config(); } catch (e) { return; }
    if (!cfg) return;

    setVal("pp-cloud-email", cfg.email);
    setVal("pp-cloud-root", cfg.root);
    setVal("pp-cloud-auto", cfg.autoMinutes);
    setVal("pp-cloud-maxmb", cfg.maxFileMB);
    setVal("pp-cloud-large", cfg.largeFileMB);
    setVal("pp-cloud-part", cfg.partMB);
    setChecked("pp-cloud-remember", cfg.remember);
    renderDatasets(cfg.datasets);

    const policy = $("pp-cloud-policy");
    if (policy) policy.value = cfg.policy;
    const dir = $("pp-cloud-direction");
    if (dir) dir.value = cfg.direction;

    const token = $("pp-cloud-token");
    if (token) {
      token.value = "";
      token.placeholder = cfg.token ? "已保存（留空则沿用；重新填写可覆盖）" : "在坚果云安全设置里生成的应用密码";
    }
    renderStatus();
    renderLogs();
  }

  async function withBusy(fn, label) {
    if (busy) { setMsg("上一项操作还没结束…"); return; }
    busy = true;
    setMsg(label || "处理中…");
    try {
      await fn();
    } catch (e) {
      setMsg(errText(e), "bad");
    } finally {
      busy = false;
      renderStatus();
      renderLogs();
    }
  }

  function collect() {
    return {
      email: val("pp-cloud-email"),
      root: val("pp-cloud-root") || "/Papilot",
      policy: val("pp-cloud-policy") || "keepBoth",
      direction: val("pp-cloud-direction") || "both",
      datasets: datasetsCsv(),
      autoMinutes: Number(val("pp-cloud-auto")) || 0,
      maxFileMB: Number(val("pp-cloud-maxmb")) || 512,
      largeFileMB: Number(val("pp-cloud-large")) || 64,
      partMB: Number(val("pp-cloud-part")) || 32,
      remember: checked("pp-cloud-remember"),
    };
  }

  async function onSave() {
    const cs = S();
    if (!cs) return;
    await withBusy(async () => {
      const c = collect();
      if (!c.email) throw Object.assign(new Error("请填写坚果云账号（邮箱）"), { code: "CONFIG" });
      const token = val("pp-cloud-token");
      cs.saveConfig(c);
      if (token) {
        await cs.login({ email: c.email, token: token, remember: c.remember });
        setMsg("已连接坚果云", "ok");
      } else if (cs.isLoggedIn()) {
        cs.saveConfig({ email: c.email });
        const info = await cs.testConnection();
        setMsg("设置已保存：" + info.message, "ok");
        cs.startAutoSync();
      } else {
        throw Object.assign(new Error("还没有应用密码：请在下面填入后点「保存并测试」"), { code: "AUTH_REQUIRED" });
      }
      const t = $("pp-cloud-token");
      if (t) { t.value = ""; t.placeholder = "已保存（留空则沿用；重新填写可覆盖）"; }
      renderAll();
    }, "正在验证…");
  }

  async function runSync(kind) {
    const cs = S();
    if (!cs) return;
    if (!cs.isLoggedIn()) { setMsg("请先填写账号与应用密码并保存", "bad"); return; }
    await withBusy(async () => {
      cs.saveConfig(collect());
      const p = kind === "up" ? cs.uploadOnly() : (kind === "down" ? cs.downloadOnly() : cs.syncNow());
      const res = await p;
      if (res && res.ok) {
        setMsg((res.uploaded ? "上传 " + res.uploaded + " · " : "") +
          (res.downloaded ? "下载 " + res.downloaded + " · " : "") +
          "跳过 " + (res.skipped || 0) +
          (res.conflicts ? " · 冲突 " + res.conflicts : "") +
          (res.failed ? " · 失败 " + res.failed : ""), res.failed ? "bad" : "ok");
      } else {
        setMsg(errText({ code: res && res.code, message: res && res.error }), "bad");
      }
    }, "同步中…");
  }

  function init() {
    if (typeof Zotero === "undefined" || !Zotero.Papilot || !S()) {
      window.setTimeout(init, 400);
      return;
    }
    if (!$("pp-cloud-email")) {
      window.setTimeout(init, 300);
      return;
    }
    if (inited) return;
    inited = true;
    const cs = S();

    const bindings = [
      ["pp-cloud-save", "click", onSave],
      ["pp-cloud-sync", "click", () => runSync("both")],
      ["pp-cloud-up", "click", () => runSync("up")],
      ["pp-cloud-down", "click", () => runSync("down")],
      ["pp-cloud-cancel", "click", () => { try { cs.cancel(); } catch (e) { /* ignore */ } }],
      ["pp-cloud-apppw", "click", () => {
        try { Zotero.launchURL(APP_PW_URL); } catch (e) { setMsg("无法打开浏览器，请手动访问 " + APP_PW_URL, "bad"); }
      }],
      ["pp-cloud-open", "click", async () => {
        try {
          const dir = await cs.openCloudDir();
          setMsg("本地同步目录：" + dir, "ok");
        } catch (e) { setMsg(errText(e), "bad"); }
      }],
      ["pp-cloud-logout", "click", () => {
        try { cs.logout(); renderAll(); setMsg("已退出坚果云", "ok"); }
        catch (e) { setMsg(errText(e), "bad"); }
      }],
      ["pp-cloud-stage", "click", () => withBusy(async () => {
        const r = await cs.stageSkillPacks();
        setMsg("已收集 " + r.written + " 个技能包，点「立即同步」上传", r.written ? "ok" : "");
      }, "收集技能包…")],
    ];

    for (const [id, ev, fn] of bindings) {
      const node = $(id);
      if (node) node.addEventListener(ev, fn);
    }

    // 自动同步间隔改动即时生效（不必等保存）
    const auto = $("pp-cloud-auto");
    if (auto) {
      auto.addEventListener("change", () => {
        try {
          cs.saveConfig({ autoMinutes: Number(auto.value) || 0 });
          cs.startAutoSync();
          setMsg("自动同步：" + ((Number(auto.value) || 0) ? "每 " + Math.max(5, Number(auto.value)) + " 分钟" : "已关闭"), "ok");
        } catch (e) { setMsg(errText(e), "bad"); }
      });
    }

    if (unsub) { try { unsub(); } catch (e) { /* ignore */ } }
    unsub = cs.on((ev) => {
      if (!ev) return;
      if (ev.type === "state" || ev.type === "progress") renderStatus();
      else if (ev.type === "log") renderLogs();
    });

    renderAll();
    // 已登录则顺手刷新一次状态（不自动同步：打开设置不应触发网络请求）
    try { cs.startAutoSync(); } catch (e) { /* ignore */ }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  }
  window.setTimeout(init, 300);
  window.setTimeout(init, 1200);
})();
