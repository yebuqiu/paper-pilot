/* PaperPilot 设置面板 · 第三方文献源卡片（实验性 · Pro 试用 · 0.44.0 草案）
 * 与 prefs-cnki.js 同构：Zotero 先跑脚本后插 DOM → init 探测节点、延迟重试；
 * 经 Zotero.PaperPilot.thirdSource 访问主模块（bootstrap 作用域），pref 直接走 Zotero.Prefs。
 * 卡片元素 id 前缀统一 pp-ts-（见 check-wiring §37 守卫）。
 */
/* global Zotero, window, document, setTimeout */

(function () {
  const PREFIX = "extensions.zotero.paperpilot.";
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const zh = (Zotero.locale || "").toLowerCase().startsWith("zh");
  const $ = (id) => document.getElementById(id);
  const TS = () => Zotero.PaperPilot && Zotero.PaperPilot.thirdSource;

  function el(tag, attrs, text) {
    const n = document.createElementNS(HTML_NS, tag);
    if (attrs) { for (const k of Object.keys(attrs)) n.setAttribute(k, attrs[k]); }
    if (text !== undefined) { n.textContent = text; }
    return n;
  }

  function setText(id, msg, color) {
    const elm = $(id);
    if (elm) { elm.textContent = msg; elm.style.color = color || "var(--pp-muted)"; }
  }

  const OK = "var(--pp-success, #2e7d32)";
  const ERR = "var(--pp-danger, #c0392b)";

  /* ---------- 渲染 ---------- */

  function renderGate() {
    try {
      const g = TS().proGate();
      if (!g.ok) {
        setText("pp-ts-gate", TS().gateMessage(g), ERR);
      } else if (g.reason === "pro") {
        setText("pp-ts-gate", zh ? "✓ Pro 会员 · 试用已授权" : "✓ Pro · trial unlocked", OK);
      } else {
        setText("pp-ts-gate", "");
      }
    } catch (e) { /* ignore */ }
  }

  function renderStatus() {
    try {
      const s = TS().status();
      const parts = [
        (zh ? "站点：" : "Site: ") + s.siteName,
        s.enabled ? (zh ? "已启用" : "enabled") : (zh ? "未启用" : "disabled"),
      ];
      if (s.configured) { parts.push(zh ? "凭据已保存" : "credentials saved"); }
      if (s.loggedIn) { parts.push((zh ? "插件内会话在线：" : "in-plugin session: ") + s.username); }
      else { parts.push(zh ? "插件内未登录（可用「保存并测试登录」建立）" : "no in-plugin session"); }
      setText("pp-ts-status", parts.join(" · "));
      // 账号权限（缓存于 pref，登录成功时自动刷新）
      const ent = $("pp-ts-ent");
      if (ent) {
        if (s.entitlements && s.entitlements.length) {
          ent.textContent = s.entitlements.join("；");
        } else {
          ent.textContent = zh ? "未获取（登录测试成功后自动拉取，或点「检测权限」）" : "Not fetched";
        }
      }
      // 上次测试记录
      const lt = s.lastTest;
      if (lt) {
        let when = "";
        try { when = new Date(lt.at).toLocaleString(zh ? "zh-CN" : "en-US"); } catch (e) { /* ignore */ }
        const msg = lt.ok ? (zh ? "✓ 成功" : "✓ ok") : ((zh ? "✗ 失败：" : "✗ failed: ") + lt.code);
        setText("pp-ts-result", (zh ? "上次测试 " : "Last test ") + when + " · " + msg,
          lt.ok ? OK : ERR);
      }
    } catch (e) { /* ignore */ }
  }

  function setResult(msg, color) {
    setText("pp-ts-result", msg || "", color);
  }

  function fillSites() {
    const sel = $("pp-ts-site");
    if (!sel) { return; }
    try {
      const t = TS();
      const cur = t.currentSite().id;
      sel.innerHTML = "";
      for (const s of t.SITES) {
        sel.appendChild(el("option", { value: s.id }, s.name + "（" + t.hostOf(s.base) + "）"));
      }
      sel.value = cur;
    } catch (e) { /* ignore */ }
  }

  function prefillUser() {
    try {
      const c = TS().creds();
      const u = $("pp-ts-user");
      const p = $("pp-ts-pass");
      if (u) { u.value = c ? c.u : ""; }
      if (p) {
        p.value = "";
        p.placeholder = c ? (zh ? "已保存（留空 = 沿用）" : "Saved (leave empty to keep)")
          : (zh ? "只存本机 Zotero，不上传" : "Stored locally only");
      }
    } catch (e) { /* ignore */ }
  }

  /* ---------- 动作 ---------- */

  async function onLogin() {
    const t = TS();
    if (!t) { return; }
    const gate = t.proGate();
    if (!gate.ok) { setResult(t.gateMessage(gate), ERR); return; }
    const u = (($("pp-ts-user") || {}).value || "").trim();
    let p = ($("pp-ts-pass") || {}).value || "";
    if (!p) {
      const c = t.creds();
      if (c && c.u === u) { p = c.p; }
    }
    if (!u || !p) {
      setResult(zh ? "请填写卡号与密码" : "Enter card number & password", ERR);
      return;
    }
    const btn = $("pp-ts-login-btn");
    if (btn) { btn.disabled = true; }
    setResult(zh ? "登录中…（低频纪律：请求间隔 ≥ 1.5s）" : "Signing in…");
    try {
      const r = await t.login(u, p);
      if (r.ok) {
        t.saveCreds(u, p);
        setResult(t.loginMsg("ok", zh) + (r.username ? "（" + r.username + "）" : ""), OK);
        const pl = $("pp-ts-pass");
        if (pl) { pl.value = ""; pl.placeholder = zh ? "已保存（留空 = 沿用）" : "Saved (leave empty to keep)"; }
      } else {
        setResult(t.loginMsg(r.code, zh) + (r.msg ? "：" + r.msg : ""), ERR);
      }
    } catch (e) {
      setResult((zh ? "登录失败：" : "Failed: ") + (e && (e.message || e)), ERR);
    } finally {
      if (btn) { btn.disabled = false; }
    }
    renderStatus();
  }

  function onOpen() {
    const t = TS();
    if (!t) { return; }
    const ok = t.openPortal();
    setResult(ok ? (zh ? "已打开「文献下载」入口（外部浏览器）" : "Opened in browser")
      : (zh ? "未打开（见上方门控/启用提示）" : "Not opened"), ok ? OK : ERR);
    renderStatus();
  }

  function onCenter() {
    const t = TS();
    if (!t) { return; }
    const ok = t.openCenter();
    setResult(ok ? (zh ? "已打开用户中心（外部浏览器）" : "Opened user center")
      : (zh ? "未打开（见上方门控提示）" : "Not opened"), ok ? OK : ERR);
  }

  function onClear() {
    try {
      TS().clearCreds();
      const u = $("pp-ts-user"); if (u) { u.value = ""; }
      const p = $("pp-ts-pass"); if (p) { p.value = ""; }
      setResult(zh ? "已清除本机凭据" : "Cleared");
      renderStatus();
    } catch (e) { /* ignore */ }
  }

  async function onRefresh() {
    const t = TS();
    if (!t) { return; }
    const gate = t.proGate();
    if (!gate.ok) { setResult(t.gateMessage(gate), ERR); return; }
    setResult(zh ? "检测权限中…" : "Checking entitlements…");
    try {
      const list = await t.fetchEntitlements();
      if (list && list.length) {
        setResult((zh ? "✓ 账号权限：" : "✓ Entitlements: ") + list.join("；"), OK);
      } else {
        setResult(zh ? "未能读取权限（插件内会话未建立时读不到——先「保存并测试登录」）"
          : "Could not read entitlements (sign in first)", ERR);
      }
    } catch (e) {
      setResult((zh ? "检测失败：" : "Failed: ") + (e && (e.message || e)), ERR);
    }
    renderStatus();
  }

  function onEnable() {
    try {
      const cb = $("pp-ts-enabled");
      TS().setEnabled(!!(cb && cb.checked));
      setResult(zh ? (cb && cb.checked ? "已启用（Pro 试用）" : "已关闭") : "Updated");
      renderStatus();
    } catch (e) { /* ignore */ }
  }

  function onSite() {
    try {
      const sel = $("pp-ts-site");
      TS().setSite(sel && sel.value);
      prefillUser();
      renderStatus();
      setResult(zh ? "站点已切换（凭据按站点共用一份，请按需更新）" : "Site switched");
    } catch (e) { /* ignore */ }
  }

  /* ---------- 初始化（DOM 就绪探测，同 prefs-cnki.js 模式） ---------- */

  function init() {
    if (typeof Zotero === "undefined" || !Zotero.PaperPilot || !TS()) {
      window.setTimeout(init, 400);
      return;
    }
    if (!$("pp-ts-login-btn") || !$("pp-ts-site")) {
      window.setTimeout(init, 300);
      return;
    }
    if (init._done) { return; }
    init._done = true;

    const t = TS();
    const en = $("pp-ts-enabled");
    if (en) { en.checked = t.enabled(); }
    fillSites();
    prefillUser();
    renderGate();
    renderStatus();

    const bind = (id, ev, fn) => { const elm = $(id); if (elm) { elm.addEventListener(ev, fn); } };
    bind("pp-ts-login-btn", "click", onLogin);
    bind("pp-ts-open-btn", "click", onOpen);
    bind("pp-ts-center-btn", "click", onCenter);
    bind("pp-ts-clear-btn", "click", onClear);
    bind("pp-ts-refresh-btn", "click", onRefresh);
    bind("pp-ts-enabled", "change", onEnable);
    bind("pp-ts-site", "change", onSite);
    bind("pp-ts-pass", "keydown", (ev) => { if (ev.key === "Enter") { onLogin(); } });
  }

  init();
  if (typeof window !== "undefined" && window.setTimeout) {
    window.setTimeout(init, 400);
    window.setTimeout(init, 1200);
  }
})();
