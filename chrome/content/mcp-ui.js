// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot MCP 状态与配置对话框（0.24.0） */
/* global window, document */

(function () {
  const XHTML = "http://www.w3.org/1999/xhtml";
  const args = (window.arguments && window.arguments[0]) || {};
  const Z = args.Zotero || (window.opener && window.opener.Zotero);
  const PP = Z && Z.Papilot;
  const zh = !!(Z && (Z.locale || "").toLowerCase().startsWith("zh"));
  const PREFIX = "extensions.zotero.papilot.";

  const $ = (id) => document.getElementById(id);
  const badgeEl = $("pp-mc-badge");
  const statusEl = $("pp-mc-status");

  if (!PP || !PP.mcp) {
    if (statusEl) statusEl.textContent = zh ? "错误：无法访问 Papilot 模块" : "Error: Papilot unavailable";
    return;
  }
  const M = PP.mcp;
  const pget = (k, d) => {
    try { const v = Z.Prefs.get(PREFIX + k, true); return v === undefined || v === null ? d : v; } catch (e) { return d; }
  };
  const pset = (k, v) => { try { Z.Prefs.set(PREFIX + k, v, true); } catch (e) { /* ignore */ } };

  let showToken = false;

  function el(tag, css, text) {
    const n = document.createElementNS(XHTML, tag);
    if (css) n.style.cssText = css;
    if (text != null) n.textContent = text;
    return n;
  }
  function setStatus(t, err) {
    statusEl.textContent = t || "";
    statusEl.style.color = err ? "var(--accent-red,#c0392b)" : "var(--fill-secondary,#666)";
  }
  function line(parent, label, value, mono) {
    const d = el("div", "margin:2px 0;word-break:break-all;");
    d.appendChild(el("span", "color:var(--fill-secondary,#777);", label + "："));
    d.appendChild(el("span", mono ? "font-family:Consolas,Menlo,monospace;" : "", value == null ? "-" : String(value)));
    parent.appendChild(d);
    return d;
  }

  function mask(t) {
    if (!t) return "(未生成)";
    return showToken ? t : t.slice(0, 6) + "…" + t.slice(-4) + "（点「显示」查看）";
  }

  function render() {
    const enabled = M.enabled();
    badgeEl.textContent = enabled ? (zh ? "● 已启用" : "● Enabled") : (zh ? "○ 已停用" : "○ Disabled");
    badgeEl.style.color = enabled ? "var(--accent-green,#1f8b4c)" : "var(--fill-tertiary,#999)";
    $("pp-mc-toggle").textContent = enabled ? (zh ? "停用" : "Disable") : (zh ? "启用" : "Enable");

    const info = $("pp-mc-info");
    info.textContent = "";
    line(info, zh ? "端点" : "Endpoint", M.endpointUrl(), true);
    const tokLine = line(info, zh ? "令牌" : "Token", mask(M.token()), true);
    const eye = el("a", "font-size:11.5px;color:var(--color-accent,#2563eb);cursor:pointer;margin-left:6px;");
    eye.textContent = showToken ? (zh ? "隐藏" : "hide") : (zh ? "显示" : "show");
    eye.addEventListener("click", () => { showToken = !showToken; render(); });
    tokLine.appendChild(eye);
    line(info, zh ? "协议版本" : "Protocol", M.DEFAULT_PROTOCOL);
    line(info, zh ? "签名" : "Signature", "Bearer <token> / X-Papilot-Token / ?token=");
    line(info, zh ? "监听" : "Bind", "127.0.0.1（仅本机；公网不可达）");

    // Zotero 本地 HTTP 服务状态：端点由它承载，未运行时外部客户端一定连不上
    const st = M.serverStatus();
    const svc = line(info, zh ? "Zotero 本地服务" : "Zotero server",
      st.running ? (zh ? "运行中（端口 " : "running (port ") + st.port + "）"
        : (st.enabled ? (zh ? "已启用但未运行（重启 Zotero 或点上方「启用本地服务」）" : "enabled but not running")
          : (zh ? "已被关闭：设置 → 高级 → 其他 → 允许其他应用与 Zotero 通信" : "disabled in Advanced prefs")));
    svc.lastChild.style.color = st.running ? "var(--accent-green,#1f8b4c)" : "var(--accent-orange,#d9822b)";

    const tools = $("pp-mc-tools");
    tools.textContent = "";
    for (const t of M.TOOLS) {
      const d = el("div", "padding:4px 0;border-bottom:1px solid var(--fill-quinary,#f0f0f0);");
      d.appendChild(el("div", "font-weight:600;font-family:Consolas,Menlo,monospace;font-size:12px;", t.name));
      d.appendChild(el("div", "color:var(--fill-secondary,#666);font-size:11.5px;margin-top:1px;", t.description));
      tools.appendChild(d);
    }

    $("pp-mc-config").value = JSON.stringify(M.clientConfig(), null, 2);
  }

  function toggle() {
    const next = !M.enabled();
    pset("mcpEnabled", next);
    if (next) {
      M.register();
      setStatus(zh ? "已启用：回到 Zotero 主窗口即可让客户端连接" : "Enabled");
    } else {
      setStatus(zh ? "已停用（端点返回 503）" : "Disabled");
    }
    render();
  }

  async function test() {
    setStatus(zh ? "正在自检…" : "Testing…");
    try {
      const r = await M.selfTest();
      if (r.ok) setStatus((zh ? "✓ 自检通过，端点返回 " : "✓ OK, endpoint returned ") + r.count + (zh ? " 个工具" : " tools"));
      else setStatus(zh ? "端点可达但没有返回工具列表" : "Endpoint reachable but returned no tools", true);
    } catch (e) {
      let hint = (zh ? "自检失败：" : "Self-test failed: ") + ((e && e.message) || e);
      if (!M.enabled()) hint += zh ? "（端点当前是停用状态，请先点「启用」）" : " (endpoint is disabled — enable it first)";
      setStatus(hint, true);
    }
  }

  $("pp-mc-toggle").addEventListener("click", toggle);
  $("pp-mc-test").addEventListener("click", test);
  $("pp-mc-server").addEventListener("click", async () => {
    setStatus(zh ? "正在启用 Zotero 本地服务…" : "Starting Zotero local server…");
    const st = await M.ensureServer();
    render();
    if (st.running) setStatus((zh ? "✓ 本地服务已运行（端口 " : "✓ Server running (port ") + st.port + "）");
    else setStatus((zh ? "启用失败：" : "Failed: ") + (st.error || (zh ? "服务仍未运行" : "server still down")), true);
  });
  $("pp-mc-close").addEventListener("click", () => window.close());
  $("pp-mc-regen").addEventListener("click", () => {
    M.regenerateToken();
    M.register();
    render();
    setStatus(zh ? "已重置令牌：请把新令牌更新到客户端配置里" : "Token regenerated — update your client config");
  });
  $("pp-mc-copy").addEventListener("click", () => {
    const txt = $("pp-mc-config").value;
    try {
      const clip = Z.getMainWindow().navigator.clipboard;
      if (clip && clip.writeText) { clip.writeText(txt); setStatus(zh ? "✓ 已复制配置 JSON" : "✓ Copied"); return; }
    } catch (e) { /* 回落到选区复制 */ }
    try {
      const ta = $("pp-mc-config");
      ta.select();
      Z.getMainWindow().document.execCommand("copy");
      setStatus(zh ? "✓ 已复制配置 JSON" : "✓ Copied");
    } catch (e) { setStatus(zh ? "复制失败，请手动选中复制" : "Copy failed", true); }
  });

  render();
  setStatus(M.enabled() ? (zh ? "运行中" : "Running") : (zh ? "未启用：点「启用」后外部客户端才能连接" : "Disabled"));
})();
