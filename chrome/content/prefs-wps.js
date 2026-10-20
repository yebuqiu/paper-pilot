// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 设置窗格脚本 · WPS 集成（0.68.1）
 *
 * 运行上下文是设置窗口作用域，拿不到 bootstrap 作用域 —— 全部经 Zotero.Papilot.wpsBridge。
 *
 * 面板职责（刻意收窄）：
 *   ① 检测四件事：加载项目录 / WPS 信任记录 / CORS 代理 / Zotero 集成端口；
 *   ② 一键修复：部署代理 + 重写 publish.xml 注册 + 拉起代理（幂等，不动信任记录）；
 *   ③ 起代理 / 打开目录 / 记安装脚本目录 / 自动代理开关。
 *
 * ⚠️ Zotero 先加载脚本、后插入 fragment DOM —— init 必须探测 #pp-wps-detect，
 *    不存在就延迟重试（同 prefs-cloud.js / prefs-subs.js 纪律）。
 * ⚠️ 加载项本体是 GPL-3.0，本插件不打包、不分发；这里只装代理与注册项。
 */
/* global Zotero, window, document, setTimeout */

(function () {
  const $ = (id) => document.getElementById(id);
  const B = () => ((typeof Zotero !== "undefined" && Zotero.Papilot && Zotero.Papilot.wpsBridge) || null);

  // ⚠️ 设置窗口作用域里**没有**裸 Prefs（那是 bootstrap 作用域的助手），
  //    必须走 Zotero.Prefs 且带 full path + global=true，否则写入静默失效。
  const PREF = "extensions.zotero.papilot.";
  const pset = (k, v) => Zotero.Prefs.set(PREF + k, v, true);

  let inited = false;
  let busy = false;

  function setMsg(text, kind) {
    const node = $("pp-wps-msg");
    if (!node) return;
    node.textContent = text || "";
    node.style.color = kind === "bad" ? "#d9534f" : kind === "ok" ? "#2e9e5b" : "var(--pp-muted)";
  }

  function setText(id, text, cls) {
    const node = $(id);
    if (!node) return;
    node.textContent = text;
    if (cls) node.style.color = cls;
  }

  function okDot(on) {
    setText("pp-wps-dot", "●", on ? "#2e9e5b" : "#d9534f");
  }

  function render(st) {
    if (!st) {
      okDot(false);
      setText("pp-wps-state", "桥接模块未加载");
      return;
    }
    const parts = [];
    if (st.addon) {
      const fixHint = st.addonStaticScripts ? "" : "（index.html 仍用 document.write，WPS 12 不执行 → 点一键修复无法改文件，需重装加载项）";
      setText("pp-wps-addon", `${st.addon.name}${fixHint}`, st.addonStaticScripts ? "#2e9e5b" : "#d9534f");
      parts.push("加载项已装");
    } else {
      setText("pp-wps-addon", "未安装（见 docs/wps-zotero.md）", "#d9534f");
    }

    if (!st.registered) {
      setText("pp-wps-reg", "未注册（点一键修复）", "#d9534f");
    } else if (st.registeredBroken) {
      setText("pp-wps-reg", "注册异常：" + (st.registeredUrl || "?") + "（点一键修复）", "#d9534f");
      parts.push("注册异常");
    } else {
      setText("pp-wps-reg", "已注册：" + (st.registeredUrl || ""), "#2e9e5b");
    }

    if (st.trusted) {
      setText("pp-wps-trust", "已信任", "#2e9e5b");
      parts.push("已信任");
    } else {
      setText("pp-wps-trust", "未确认（WPS 里点【确定】）", "#c98800");
    }

    if (st.proxy) {
      setText("pp-wps-proxy", st.proxyUpstream ? "运行中（上游可达）" : "运行中（Zotero 未运行）",
        st.proxyUpstream ? "#2e9e5b" : "#c98800");
      parts.push("代理在跑");
    } else {
      setText("pp-wps-proxy", st.proxyFile ? "未运行" : "未部署", "#d9534f");
    }

    setText("pp-wps-zotero", st.zotero ? "23119 应答正常" : "23119 无应答（Zotero 没开？）",
      st.zotero ? "#2e9e5b" : "#d9534f");

    const regBad = st.registered && st.registeredBroken;
    const allOk = st.addon && st.registered && !regBad && st.trusted && st.proxy && st.zotero;
    okDot(allOk);
    setText("pp-wps-state", allOk ? "可用" : "待处理");
    setText("pp-wps-summary", parts.join(" · "));

    const cb = $("pp-wps-autoproxy");
    if (cb) cb.checked = !!st.autoProxy;
    const dir = $("pp-wps-scriptdir");
    if (dir && document.activeElement !== dir) dir.value = st.scriptDir || "";
  }

  async function refresh(verbose) {
    const b = B();
    if (!b) {
      render(null);
      return;
    }
    if (busy) return;
    busy = true;
    try {
      const st = await b.status();
      render(st);
      if (verbose) setMsg("已重新检测", "ok");
    } catch (e) {
      setMsg("检测失败：" + String((e && e.message) || e), "bad");
    } finally {
      busy = false;
    }
  }

  function bind(id, event, handler) {
    const node = $(id);
    if (node) node.addEventListener(event, handler);
  }

  function wire() {
    bind("pp-wps-detect", "click", () => refresh(true));

    bind("pp-wps-fix", "click", async () => {
      const b = B();
      if (!b || busy) return;
      busy = true;
      setMsg("正在修复…");
      try {
        const r = await b.fix();
        if (r.ok) {
          setMsg("修复完成：" + (r.report || []).join("；") + "。重启 WPS 生效。", "ok");
        } else {
          setMsg("修复未完成：" + (r.error || (r.report || []).join("；")), "bad");
        }
      } catch (e) {
        setMsg("修复失败：" + String((e && e.message) || e), "bad");
      } finally {
        busy = false;
        await refresh(false);
      }
    });

    bind("pp-wps-proxy-start", "click", async () => {
      const b = B();
      if (!b || busy) return;
      busy = true;
      setMsg("正在启动代理…");
      try {
        const r = await b.startProxy();
        if (r.started) setMsg(r.already ? "代理已在运行" : "代理已启动", "ok");
        else setMsg("启动失败：" + (r.error || "未知原因"), "bad");
      } catch (e) {
        setMsg("启动失败：" + String((e && e.message) || e), "bad");
      } finally {
        busy = false;
        await refresh(false);
      }
    });

    bind("pp-wps-install-addon", "click", async () => {
      const b = B();
      if (!b || busy) return;
      busy = true;
      setMsg("正在获取加载项（约 0.2 MB）…");
      try {
        const r = await b.installAddon();
        if (r.ok) {
          setMsg(`加载项 ${r.version || ""} 已安装并注册。重启 WPS 后首次会问「是否信任」→ 点确定。`
            + (r.report && r.report.length ? "（" + r.report[0] + "）" : ""), "ok");
        } else {
          setMsg("安装未完成：" + (r.error || "") +
            (r.report && r.report.length ? " ｜ " + r.report.join("；") : ""), "bad");
        }
      } catch (e) {
        setMsg("安装失败：" + String((e && e.message) || e), "bad");
      } finally {
        busy = false;
        await refresh(false);
      }
    });

    bind("pp-wps-open-addon", "click", () => {
      const b = B();
      if (!b || !b.openDir("addon")) setMsg("打不开目录（检查 WPS 是否安装）", "bad");
    });

    bind("pp-wps-open-script", "click", () => {
      const b = B();
      if (!b || !b.openDir("script")) setMsg("请先在下面填写安装脚本目录", "bad");
    });

    bind("pp-wps-autoproxy", "change", (ev) => {
      try {
        pset("wpsAutoProxy", !!ev.target.checked);
        setMsg(ev.target.checked ? "已开启：启动 Zotero 时自动拉起代理" : "已关闭自动代理", "ok");
      } catch (e) {
        setMsg("保存失败：" + String((e && e.message) || e), "bad");
      }
    });

    bind("pp-wps-savedir", "click", () => {
      const node = $("pp-wps-scriptdir");
      const v = node ? String(node.value || "").trim() : "";
      try {
        pset("wpsScriptDir", v);
        setMsg(v ? "已保存脚本目录" : "已清空脚本目录", "ok");
      } catch (e) {
        setMsg("保存失败：" + String((e && e.message) || e), "bad");
      }
    });
  }

  function init(attempt) {
    if (inited) return;
    if (!$("pp-wps-detect")) {
      if ((attempt || 0) < 40) setTimeout(() => init((attempt || 0) + 1), 100);
      return;
    }
    inited = true;
    wire();
    refresh(false);
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    init(0);
  } else {
    document.addEventListener("DOMContentLoaded", () => init(0));
  }
  // Zotero 是"先加载脚本、后插 DOM"，再兜一层定时探测
  setTimeout(() => init(0), 300);
})();
