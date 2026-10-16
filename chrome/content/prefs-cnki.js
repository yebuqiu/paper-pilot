/* PaperPilot 设置面板 · 知网账号卡片（0.43.1）
 * 登录类入口收敛于此：账号登录 / IP 权限检测 / 风控验证 / 转换器更新。
 * 面板脚本运行在设置窗口作用域，经 Zotero.PaperPilot.cnAuth / cnVerify / cnTranslators
 * 访问主模块（main.js 暴露）。
 * 加载时序与 prefs-pane.js 同：Zotero 先跑脚本后插 DOM → init 探测节点、延迟重试。
 */
/* global Zotero, window, document */

(function () {
  const PREFIX = "extensions.zotero.paperpilot.";
  const zh = (Zotero.locale || "").toLowerCase().startsWith("zh");
  const $ = (id) => document.getElementById(id);

  const cnAuth = () => Zotero.PaperPilot && Zotero.PaperPilot.cnAuth;
  const cnVerify = () => Zotero.PaperPilot && Zotero.PaperPilot.cnVerify;
  const cnTranslators = () => Zotero.PaperPilot && Zotero.PaperPilot.cnTranslators;

  function setText(id, msg, color) {
    const el = $(id);
    if (el) { el.textContent = msg; el.style.color = color || "var(--pp-muted)"; }
  }

  /* ---------- 权限状态三态渲染 ---------- */

  async function refreshStatus() {
    const el = $("pp-cnki-status");
    if (!el) return;
    setText("pp-cnki-status", zh ? "正在检测权限…" : "Detecting access…");
    try {
      const r = await cnAuth().detectAccess();
      if (r.type === "ip") {
        setText("pp-cnki-status",
          (zh ? "✓ 校园网/机构 IP 授权已生效" : "✓ Campus/institutional IP access active") +
          (r.name ? "（" + r.name + "）" : "") +
          (zh ? "——无需账号，直接可用" : " — no account needed"),
          "var(--pp-success, #2e7d32)");
      } else if (r.type === "account") {
        setText("pp-cnki-status",
          (zh ? "✓ 知网账号已登录：" : "✓ Logged in as ") + r.name,
          "var(--pp-success, #2e7d32)");
      } else {
        setText("pp-cnki-status",
          (zh ? "✗ 当前无知网权限（不在校园网且未登录账号）" : "✗ No access (off-campus & not logged in)") +
          (r.ip ? (zh ? "；当前 IP " : "; IP ") + r.ip : ""),
          "var(--pp-danger, #c0392b)");
      }
    } catch (e) {
      setText("pp-cnki-status", (zh ? "检测失败：" : "Detection failed: ") + (e && e.message || e),
        "var(--pp-danger, #c0392b)");
    }
  }

  /* ---------- 按钮 ---------- */

  async function onLogin() {
    const u = ($("pp-cnki-user") || {}).value || "";
    const p = ($("pp-cnki-pass") || {}).value || "";
    if (!u.trim() || !p) {
      setText("pp-cnki-result", zh ? "请填写用户名和密码" : "Enter username & password",
        "var(--pp-danger, #c0392b)");
      return;
    }
    const btn = $("pp-cnki-login-btn");
    if (btn) btn.disabled = true;
    setText("pp-cnki-result", zh ? "登录中…" : "Signing in…");
    try {
      const ok = await cnAuth().loginFromPanel(u.trim(), p);
      setText("pp-cnki-result",
        ok ? (zh ? "✓ 登录成功" : "✓ Signed in") : (zh ? "✗ 登录未完成（可能遇到滑块，已打开官方登录页）" : "✗ Not completed"),
        ok ? "var(--pp-success, #2e7d32)" : "var(--pp-danger, #c0392b)");
    } catch (e) {
      setText("pp-cnki-result", (zh ? "登录失败：" : "Failed: ") + (e && e.message || e),
        "var(--pp-danger, #c0392b)");
    } finally {
      if (btn) btn.disabled = false;
    }
    await refreshStatus();
  }

  function onClear() {
    try {
      Zotero.Prefs.set(PREFIX + "cnkiUsername", "", true);
      Zotero.Prefs.set(PREFIX + "cnkiPassword", "", true);
      // 0.43.2：同时退出登录（清 cnki.net 会话 cookie）——「清除凭据」= 彻底退出
      let n = 0;
      try { n = cnAuth().logout(); } catch (e) { /* ignore */ }
      const u = $("pp-cnki-user"); if (u) u.value = "";
      const p = $("pp-cnki-pass"); if (p) p.value = "";
      setText("pp-cnki-result",
        (zh ? "已清除凭据并退出登录（会话 " : "Cleared & logged out (") + n + (zh ? " 项）" : ")"));
    } catch (e) { /* ignore */ }
    refreshStatus();
  }

  async function onVerify() {
    setText("pp-cnki-result", zh ? "发起验证…" : "Starting verification…");
    try { await cnVerify().interactive(); } catch (e) { /* ignore */ }
    await refreshStatus();
  }

  async function onTranslators() {
    setText("pp-cnki-result", zh ? "更新中…" : "Updating…");
    try { await cnTranslators().update(true); } catch (e) { /* ignore */ }
    setText("pp-cnki-result", zh ? "已触发更新（见右上角进度）" : "Update triggered");
  }

  /* ---------- 初始化（DOM 就绪探测，同 prefs-pane.js 模式） ---------- */

  function init() {
    if (typeof Zotero === "undefined" || !Zotero.PaperPilot || !cnAuth()) {
      window.setTimeout(init, 400);
      return;
    }
    if (!$("pp-cnki-login-btn") || !$("pp-cnki-user")) {
      window.setTimeout(init, 300);
      return;
    }
    if (init._done) return;
    init._done = true;

    // 预填已存凭据（密码不回填——只显示「已保存」占位提示）
    try {
      const saved = cnAuth().creds();
      if (saved) {
        const u = $("pp-cnki-user"); if (u) u.value = saved.u;
        const p = $("pp-cnki-pass");
        if (p) { p.value = ""; p.placeholder = zh ? "已保存（留空 = 沿用）" : "Saved (leave empty to keep)"; }
      }
    } catch (e) { /* ignore */ }

    const bind = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
    bind("pp-cnki-login-btn", "click", onLogin);
    bind("pp-cnki-detect-btn", "click", refreshStatus);
    bind("pp-cnki-clear-btn", "click", onClear);
    bind("pp-cnki-verify-btn", "click", onVerify);
    bind("pp-cnki-translators-btn", "click", onTranslators);
    bind("pp-cnki-pass", "keydown", (ev) => { if (ev.key === "Enter") onLogin(); });

    // 打开面板即自动检测（低成本：IP 探测 + 本地 cookie 判定，无账号登录）
    refreshStatus();
  }

  init();
  if (typeof window !== "undefined" && window.setTimeout) {
    window.setTimeout(init, 400);
    window.setTimeout(init, 1200);
  }
})();
