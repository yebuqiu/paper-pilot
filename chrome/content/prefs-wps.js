// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 设置窗格脚本 · WPS 集成（0.71.1 起对接 Papilot Cite）
 *
 * 运行上下文是设置窗口作用域，拿不到 bootstrap 作用域 —— 全部经 Zotero.Papilot.wpsBridge。
 *
 * 这张卡只做四件事（刻意收窄，别再加"自动""智能"按钮）：
 *   ① 检测五件事：加载项目录 / publish.xml 注册 / WPS 信任 / 21932 代理 / 23119 Zotero；
 *   ② 安装或更新加载项（载荷随 xpi 分发，等价于 wps-cite/tools/install.py）；
 *   ③ 启动代理；
 *   ④ 清理旧版残留（0.68.x 的 wps-zotero，两份同时装着会在功能区打架）。
 *
 * ⚠️ Zotero 先加载脚本、后插入 fragment DOM —— init 必须探测 #pp-wps-detect，
 *    不存在就延迟重试（同 prefs-cloud.js / prefs-subs.js 纪律）。
 */
/* global Zotero, document, setTimeout, confirm */

(function () {
  const $ = (id) => document.getElementById(id);
  const B = () => ((typeof Zotero !== "undefined" && Zotero.Papilot && Zotero.Papilot.wpsBridge) || null);

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
      setText("pp-wps-addon", `${st.addon.name}`, "#2e9e5b");
      parts.push("加载项已装");
    } else if (st.payload && st.payload.available) {
      setText("pp-wps-addon", `未安装（可装 ${st.payload.version}）`, "#d9534f");
    } else {
      setText("pp-wps-addon", "未安装", "#d9534f");
    }

    if (!st.registered) {
      setText("pp-wps-reg", "未注册（点「安装/更新加载项」）", "#d9534f");
    } else if (st.registeredBroken) {
      setText("pp-wps-reg", "注册指向别的目录：" + (st.registeredUrl || "?") + "（重新安装）", "#d9534f");
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

    /* 这张卡本身就跑在 Zotero 里，"Zotero 没开"是不可能的结论，所以三态分开写：
     * true=端口应答 / false=端口没在听 / null=没法确认（代理没跑，探测不了）。 */
    if (st.zotero === true) {
      setText("pp-wps-zotero", "23119 应答正常", "#2e9e5b");
    } else if (st.zotero === false) {
      setText("pp-wps-zotero", "23119 无应答（端口没在监听）", "#d9534f");
      parts.push("集成端口异常");
    } else {
      setText("pp-wps-zotero", "无法确认（先启动代理再检测）", "#c98800");
    }

    const legacy = (st.legacy && st.legacy.dirs) || [];
    const hasLegacy = legacy.length || (st.legacy && st.legacy.publish);
    if (hasLegacy) {
      const what = [];
      if (legacy.length) what.push(legacy.join("、"));
      if (st.legacy.publish) what.push("旧注册项");
      setText("pp-wps-legacy", "发现旧版残留：" + what.join(" + ") + "（建议清理）", "#c98800");
      parts.push("有旧版残留");
    } else {
      setText("pp-wps-legacy", "没有旧版残留", "var(--pp-muted)");
    }

    const regBad = st.registered && st.registeredBroken;
    const allOk = st.addon && st.registered && !regBad && st.trusted && st.proxy && st.zotero && !hasLegacy;
    okDot(allOk);
    setText("pp-wps-state", allOk ? "可用" : "待处理");
    setText("pp-wps-summary", parts.join(" · "));

    const btnInstall = $("pp-wps-install");
    if (btnInstall) {
      const can = !!(st.payload && st.payload.available);
      btnInstall.disabled = !can;
      btnInstall.textContent = st.addon && st.payload && st.payload.version === st.addon.version
        ? "重新安装加载项"
        : (st.payload ? `安装加载项 ${st.payload.version || ""}` : "安装加载项");
    }
    const btnClean = $("pp-wps-clean");
    if (btnClean) btnClean.disabled = !hasLegacy;
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

  /** 一个"点一下、跑一段、报结果"的包装：统一 busy 与提示，不写第二份 */
  function action(fn, opts) {
    return async () => {
      const b = B();
      if (!b || busy) return;
      busy = true;
      setMsg((opts && opts.start) || "正在处理…");
      try {
        const r = await fn(b);
        if (r && r.ok) {
          setMsg(((opts && opts.ok) || "完成") + (r.report && r.report.length ? "：" + r.report.join("；") : ""), "ok");
        } else {
          setMsg(((opts && opts.fail) || "未完成") + "：" + ((r && r.error) || "未知原因"), "bad");
        }
      } catch (e) {
        setMsg(((opts && opts.fail) || "失败") + "：" + String((e && e.message) || e), "bad");
      } finally {
        busy = false;
        await refresh(false);
      }
    };
  }

  function wire() {
    bind("pp-wps-detect", "click", () => refresh(true));

    bind("pp-wps-install", "click", action((b) => b.installAddon(), {
      start: "正在安装加载项…",
      ok: "安装完成（重启 WPS，首次会问「是否信任」→ 点确定）",
      fail: "安装未完成",
    }));

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

    bind("pp-wps-clean", "click", async () => {
      const b = B();
      if (!b || busy) return;
      let yes = true;
      try {
        yes = typeof confirm === "function"
          ? confirm("清理旧版 WPS 加载项残留（wps-zotero 目录、注册项、旧代理目录）？\n\n"
            + "只删旧版，不动当前的 Papilot Cite。")
          : false;
      } catch (e) { yes = false; }
      if (!yes) return;
      busy = true;
      setMsg("正在清理…");
      try {
        const r = await b.cleanupLegacy();
        const removed = (r && r.removed) || [];
        if (removed.length) setMsg("已清理：" + removed.join("；"), "ok");
        else setMsg("没有可清理的东西（可能已被 WPS 占用，关掉 WPS 再试）", "bad");
      } catch (e) {
        setMsg("清理失败：" + String((e && e.message) || e), "bad");
      } finally {
        busy = false;
        await refresh(false);
      }
    });

    bind("pp-wps-open-addon", "click", () => {
      const b = B();
      if (!b || !b.openDir("addon")) setMsg("打不开目录（检查 WPS 是否安装）", "bad");
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
