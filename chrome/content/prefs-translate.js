/* PaperPilot 设置窗格脚本·翻译引擎（0.28.0 新增）
 * 与 prefs-pane.js / prefs-account.js 同窗格运行；经 Zotero.PaperPilot.translateSvc
 * 访问 bootstrap 作用域的 TranslateSvc 模块（设置窗口访问不到 bootstrap 作用域）。
 *
 * 渲染内容：状态行 + 当前引擎/源语言/目标语言 + 回退链 + 超时/重试/缓存
 *          + 全部引擎列表（设为主引擎 / 纳入回退 / 填写密钥 / 实测）
 *
 * 语言两项（源/目标）走 prefs.xhtml 的 preference= 声明式绑定，本脚本不碰；
 * 引擎 id / 回退链 / 超时 / 重试 / 缓存 / 各引擎密钥存 pref translateCfg。
 *
 * ⚠️ Zotero 先加载脚本、后插入 fragment DOM —— init 必须探测关键节点，
 *    不存在就延迟重试，否则 null 崩溃会让整个面板永远不 loaded（同 prefs-pane）。
 * ⚠️ 动态创建的节点一律经变量持有，**不要**用 $(…) 去取动态节点，
 *    否则 check-wiring 的「元素 id 必须存在于 prefs.xhtml」守卫会误报。
 */
/* global Zotero, window, document */

(function () {
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const zh = (Zotero.locale || "").toLowerCase().startsWith("zh");
  const $ = (id) => document.getElementById(id);
  const PP = () => Zotero.PaperPilot || {};
  const T = () => PP().translateSvc;

  const el = (tag, attrs, text) => {
    const node = document.createElementNS(HTML_NS, tag);
    if (attrs) for (const k of Object.keys(attrs)) {
      if (attrs[k] === undefined || attrs[k] === null) continue;
      node.setAttribute(k, attrs[k]);
    }
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const PASSWORD_KEYS = { key: 1, apiKey: 1, secretKey: 1, token: 1, appkey: 1 };

  /* ---------- 折叠式布局（0.31.0）----------
   * 16 个引擎全平铺，每行还带密钥表单与说明 → "界面过于杂乱"。
   * 默认只列「常用」（当前活动 + 回退链成员 + 内置常用清单，去重后最多 6 个），
   * 其余收进可展开区域（展开后按类别分组）。展开状态存模块变量，
   * 这样任何一次 renderAll 重建列表后仍保持用户的展开/收起选择。
   */
  const COMMON_ENGINES = ["llm", "edge", "google", "microsoft", "deepl"];
  const COMMON_MAX = 6;
  let showAllEngines = false;
  let lastCommonIds = [];

  /** 常用引擎 id 列表：活动引擎 → 回退链顺序 → 内置常用清单 */
  function commonIds(ov, S) {
    const out = [];
    const push = (id) => { if (id && S.get(id) && out.indexOf(id) < 0) out.push(id); };
    push(ov.active);
    for (const id of (ov.cfg.fallback || [])) push(id);
    for (const id of COMMON_ENGINES) push(id);
    return out.slice(0, COMMON_MAX);
  }

  function setMsg(text, color) {
    const box = $("pp-tr-test-result");
    if (!box) return;
    box.textContent = text || "";
    box.style.color = color || "var(--pp-muted)";
  }

  /* ---------- 状态行 ---------- */
  function renderStatus() {
    const box = $("pp-tr-status");
    const S = T();
    if (!box || !S) return;
    box.innerHTML = "";
    const svc = S.activeEngine();
    const c = S.cfg();
    if (!svc) {
      box.appendChild(el("span", { style: "color:var(--pp-danger);" },
        zh ? "⚠ 没有可用的翻译引擎" : "⚠ No usable translation engine"));
      return;
    }
    // ready() 已内聚「大模型引擎要求 AI 就绪 / 需密钥引擎要求已配置」的判定
    const ready = S.ready(svc.id);
    if (ready) {
      box.appendChild(el("span", { style: "color:var(--pp-success);" }, "● "));
    } else {
      box.appendChild(el("span", { style: "color:var(--pp-warn);" }, "● "));
    }
    box.appendChild(el("b", null, svc.name));
    const bits = [];
    bits.push((zh ? "目标语言 " : "to ") + S.langLabel(S.targetCode()));
    if (c.fallback && c.fallback.length) {
      bits.push((zh ? "回退 " : "fallback ") + c.fallback.length);
    }
    if (!ready) bits.push(zh ? "当前不可用（见下方说明）" : "currently unavailable");
    box.appendChild(el("span", { style: "color:var(--pp-muted);" }, "  " + bits.join(" · ")));
    if (!ready) {
      const hint = el("div", { class: "pp-hint", style: "margin-top:2px;color:var(--pp-warn);" },
        S.unavailableHint());
      box.appendChild(hint);
    }
  }

  /* ---------- 当前引擎下拉 ---------- */
  function renderActiveSelect() {
    const sel = $("pp-tr-active");
    const S = T();
    if (!sel || !S) return;
    const cur = S.cfg().active;
    while (sel.firstChild) sel.removeChild(sel.firstChild);
    for (const s of S.list()) {
      const opt = el("option", { value: s.id });
      let label = s.name;
      if (s.group === "free" && !s.needsSecret) label += " 🆓";
      if (s.needsSecret) label += " 🔑";
      if (s.llm) label += " 🤖";
      opt.textContent = label;
      sel.appendChild(opt);
    }
    sel.value = cur;
  }

  /* ---------- 回退链 / 超时 / 重试 / 缓存 ---------- */
  function renderKnobs() {
    const S = T();
    if (!S) return;
    const c = S.cfg();
    const fb = $("pp-tr-fallback");
    if (fb) fb.value = (c.fallback || []).join(", ");
    const to = $("pp-tr-timeout");
    if (to) to.value = String(c.timeoutMs || 15000);
    const rt = $("pp-tr-retry");
    if (rt) rt.checked = !!c.retry;
    const ca = $("pp-tr-cache");
    if (ca) ca.checked = c.cache !== false;
    // 回退链预算三件套（0.31.0）：预算存毫秒、冷却界面用秒
    const ro = $("pp-tr-route");
    if (ro) ro.value = String(c.routeMs || 0);
    const tt = $("pp-tr-total");
    if (tt) tt.value = String(c.totalMs || 0);
    const cd = $("pp-tr-cooldown");
    if (cd) cd.value = String(Math.round((c.cooldownMs || 0) / 1000));
    // 0.33.0 术语表与全文翻译优化（三个开关直接走 Zotero.Prefs 布尔默认值）
    const gl = $("pp-tr-glossary");
    if (gl) {
      gl.value = String((function () {
        try { return Zotero.Prefs.get("extensions.zotero.paperpilot.translateGlossary", true) || ""; }
        catch (e) { return ""; }
      })());
      renderGlossaryMsg(gl.value);
    }
    const st = $("pp-tr-bl-struct");
    if (st) st.checked = prefBool("bilingualStructExtract", true);
    const cx = $("pp-tr-bl-context");
    if (cx) cx.checked = prefBool("bilingualContext", true);
    const fp = $("pp-tr-formula");
    if (fp) fp.checked = prefBool("translateFormulaProtect", true);
    // 0.34.0 PDF 原位对照翻译（读的是字符串型 pref，prefBool 只管布尔）
    const pim = $("pp-pi-mode");
    if (pim) {
      pim.value = String(prefStr("pdfInlineMode", "off") || "off");
      if (["off", "overlay", "bilingual"].indexOf(pim.value) < 0) pim.value = "off";
    }
    const pis = $("pp-pi-scale");
    if (pis) pis.value = String(prefStr("pdfInlineFontScale", "1") || "1");
    const pig = $("pp-pi-gap");
    if (pig) pig.value = String(prefStr("pdfInlineGapMs", "120") || "120");
    const pise = $("pp-pi-selectable");
    if (pise) pise.checked = prefBool("pdfInlineSelectable", false);
  }

  /** 读取扩展字符串 pref（默认值在 prefs.js 声明，这里只兜 undefined） */
  function prefStr(key, dflt) {
    try {
      const v = Zotero.Prefs.get("extensions.zotero.paperpilot." + key, true);
      return v === undefined || v === null ? dflt : String(v);
    } catch (e) { return dflt; }
  }

  /** 读取扩展布尔 pref（默认值在 prefs.js 声明，这里只兜 undefined） */
  function prefBool(key, dflt) {
    try {
      const v = Zotero.Prefs.get("extensions.zotero.paperpilot." + key, true);
      return v === undefined || v === null ? dflt : !!v;
    } catch (e) { return dflt; }
  }

  /** 术语表输入反馈：解析条数实时显示在文本框下方（行内反馈，别让用户猜是否生效） */
  function renderGlossaryMsg(raw) {
    const msg = $("pp-tr-glossary-msg");
    if (!msg) return;
    const S = T();
    let n = 0;
    let bad = 0;
    if (S && S.parseGlossary) {
      try { n = S.parseGlossary(raw).length; } catch (e) { n = 0; }
    }
    // 无法解析出术语的非空行 = 写法提示（不含注释行）
    for (const line of String(raw || "").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.charAt(0) === "#" || t.slice(0, 2) === "//") continue;
      if (!/=>|=|\t/.test(t)) bad++;
    }
    msg.style.color = "var(--pp-muted)";
    if (!String(raw || "").trim()) {
      msg.textContent = zh ? "尚未配置术语表" : "No glossary yet";
    } else if (bad) {
      msg.style.color = "var(--pp-warn)";
      msg.textContent = zh
        ? "已解析 " + n + " 条；" + bad + " 行缺少「=」分隔符（# 开头的行为注释）"
        : n + " parsed; " + bad + " line(s) missing '=' separator";
    } else {
      msg.textContent = zh ? "已解析 " + n + " 条术语" : n + " term(s) parsed";
    }
  }

  /* ---------- 引擎行 ---------- */
  function buildEngineRow(s, compact) {
    const S = T();
    const row = el("div", { class: "pp-ch-row", "data-engine": s.id });

    const left = el("div", { style: "flex:1;min-width:0;" });
    const head = el("div", { class: "pp-ch-head" });
    head.appendChild(el("span", { class: "pp-ch-name" }, s.name));
    if (s.enabled) head.appendChild(el("span", { class: "pp-pill pp-pill-ok" }, zh ? "当前" : "active"));
    if (s.inFallback) head.appendChild(el("span", { class: "pp-pill" }, zh ? "回退" : "fallback"));
    if (s.needsSecret) {
      head.appendChild(el("span", { class: "pp-pill " + (s.configured ? "pp-pill-ok" : "pp-pill-warn") },
        s.configured ? (zh ? "已配置" : "configured") : (zh ? "未配置" : "not set")));
    }
    if (s.experimental) {
      head.appendChild(el("span", { class: "pp-pill pp-pill-warn" }, zh ? "实验性" : "experimental"));
    }
    left.appendChild(head);

    const sub = [];
    if (s.group === "llm") sub.push(zh ? "使用当前 AI 通道" : "uses active AI channel");
    else if (s.group === "key") sub.push(zh ? "自有密钥" : "own key");
    else if (!s.needsSecret) sub.push(zh ? "免费·免配置" : "free");
    if (s.note) sub.push(s.note);
    // 单次上限：超长自动分段（0.31.0）——让用户知道"为什么长文会被拆成几次请求"
    if (s.limits) {
      sub.push(zh
        ? "单次 ≤ " + (s.limits.bytes ? s.limits.bytes + " 字节" : s.limits.chars + " 字符") + "（超长自动分段）"
        : "≤ " + (s.limits.bytes || s.limits.chars) +
          (s.limits.bytes ? " bytes" : " chars") + " per call (auto-split)");
    }
    if (sub.length) left.appendChild(el("div", { class: "pp-ch-sub" }, sub.join(" · ")));

    // 密钥表单：每项一个输入，变更即保存（无需单独保存按钮）
    if (s.needsSecret && s.secretFields && s.secretFields.length) {
      const parts = S.parseSecret(s.id, s.secretRaw);
      const wrap = el("div", { style: "margin-top:6px;display:flex;flex-wrap:wrap;gap:6px;" });
      for (const f of s.secretFields) {
        const cell = el("div", { style: "display:flex;align-items:center;gap:4px;" });
        const isPw = !!PASSWORD_KEYS[f.key];
        const input = el("input", {
          type: isPw ? "password" : "text",
          class: "pp-input",
          placeholder: f.placeholder || f.label || f.key,
          title: f.label || f.key,
          style: "min-width:180px;font-size:12px;",
        });
        input.value = parts[f.key] || "";
        input.addEventListener("change", () => {
          const obj = {};
          for (const ff of s.secretFields) {
            obj[ff.key] = ff.key === f.key ? input.value
              : ((wrap.querySelector('input[data-k="' + ff.key + '"]') || {}).value || "");
          }
          S.setSecret(s.id, obj);
          renderStatus();
          setMsg((zh ? "已保存密钥：" : "Saved secret: ") + s.name, "var(--pp-success)");
        });
        input.setAttribute("data-k", f.key);
        cell.appendChild(input);
        if (isPw) {
          const eye = el("button", { class: "pp-btn pp-btn-sm", title: zh ? "显示/隐藏" : "show/hide" }, "👁");
          eye.style.opacity = "0.55";
          eye.addEventListener("click", () => {
            const show = input.type === "password";
            input.type = show ? "text" : "password";
            eye.style.opacity = show ? "1" : "0.55";
          });
          cell.appendChild(eye);
        }
        wrap.appendChild(cell);
      }
      left.appendChild(wrap);
    }

    // 引擎说明（额度 / 免密钥 / 申请方式）：由引擎自身声明，界面直接展示。
    // compact（展开区里的行）只在"要填密钥/是实验性"时展示说明，避免展开后一屏全是字。
    if (s.hint && (!compact || s.needsSecret || s.experimental)) {
      left.appendChild(el("div", {
        class: "pp-hint",
        style: "margin-top:5px;line-height:1.5;",
      }, s.hint));
    }

    row.appendChild(left);

    // 右侧：操作按钮 + **行内测试结果**（反馈就在刚点的按钮下面，不再跑到卡片底部）
    const right = el("div", {
      style: "display:flex;flex-direction:column;gap:4px;flex:none;align-items:flex-end;max-width:240px;",
    });
    const acts = el("div", { style: "display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;" });
    const mkBtn = (label, title) => el("button", { class: "pp-btn pp-btn-sm", title: title || "" }, label);
    if (!s.enabled) {
      const b = mkBtn(zh ? "设为当前" : "Set active", zh ? "用作主翻译引擎" : "Use as primary engine");
      b.addEventListener("click", () => {
        const r = S.setActive(s.id);
        if (!r.ok) { setMsg("✗ " + r.error, "var(--pp-danger)"); return; }
        setMsg((zh ? "已设为当前引擎：" : "Active engine: ") + s.name, "var(--pp-success)");
        renderAll();
      });
      acts.appendChild(b);
    }
    const bFb = mkBtn(
      zh ? (s.inFallback ? "移出回退" : "纳入回退") : (s.inFallback ? "Remove fallback" : "Add fallback"),
      zh ? "主引擎失败时依次尝试该引擎" : "Try this engine when primary fails");
    bFb.addEventListener("click", () => {
      const list = (S.cfg().fallback || []).slice();
      const i = list.indexOf(s.id);
      if (i >= 0) list.splice(i, 1); else list.push(s.id);
      S.saveCfg({ fallback: list });
      renderKnobs();
      renderAll();
    });
    acts.appendChild(bFb);
    const bTest = mkBtn(zh ? "测试" : "Test", zh ? "真实调用一次，返回耗时与译文" : "Real call: latency + result");
    const rowMsg = el("div", {
      class: "pp-tr-rowmsg",
      style: "font-size:11px;line-height:1.45;text-align:right;word-break:break-word;min-height:0;",
    }, "");
    bTest.addEventListener("click", () => onTest(s.id, bTest, rowMsg));
    acts.appendChild(bTest);
    if (s.docs) {
      const bDoc = mkBtn(zh ? "文档" : "Docs", s.docs);
      bDoc.addEventListener("click", () => {
        try { Zotero.launchURL(s.docs); } catch (e) { /* ignore */ }
      });
      acts.appendChild(bDoc);
    }
    right.appendChild(acts);
    right.appendChild(rowMsg);
    row.appendChild(right);
    return row;
  }

  function renderList() {
    const box = $("pp-tr-list");
    const S = T();
    if (!box || !S) return;
    while (box.firstChild) box.removeChild(box.firstChild);

    const ov = S.overview();
    const total = ov.services.length;
    const common = commonIds(ov, S);
    lastCommonIds = common;

    const groups = [
      { key: "plain", label: zh ? "完全免配置（开箱即用）" : "Zero-config" },
      { key: "free-url", label: zh ? "免费 · 需填自建/公共地址" : "Free · needs a URL" },
      { key: "key", label: zh ? "需自备密钥" : "Bring your own key" },
      { key: "ai", label: zh ? "AI 大模型" : "AI model" },
    ];
    const catOf = (s) => (s.isLLM ? "ai"
      : (s.needsSecret ? (s.group === "free" ? "free-url" : "key") : "plain"));

    // 标题行 + 展开/收起
    const head = el("div", {
      class: "pp-tr-listhead",
      style: "display:flex;align-items:center;gap:8px;margin-top:9px;flex-wrap:wrap;",
    });
    head.appendChild(el("span", { class: "pp-sub-title" }, showAllEngines
      ? (zh ? "全部引擎（" + total + " 个）" : "All engines (" + total + ")")
      : (zh ? "常用引擎（" + common.length + " 个）" : "Common (" + common.length + ")")));
    const toggle = el("button", { class: "pp-btn pp-btn-sm pp-tr-toggle" },
      showAllEngines
        ? (zh ? "收起，只看常用 ▴" : "Collapse ▴")
        : (zh ? "展开全部 " + total + " 个 ▾" : "Show all " + total + " ▾"));
    toggle.style.marginLeft = "auto";
    toggle.addEventListener("click", () => {
      showAllEngines = !showAllEngines;
      renderList();
    });
    head.appendChild(toggle);
    box.appendChild(head);

    if (!showAllEngines) {
      for (const id of common) {
        const s = ov.services.find((x) => x.id === id);
        if (s) box.appendChild(buildEngineRow(s, false));
      }
      const rest = total - common.length;
      if (rest > 0) {
        box.appendChild(el("div", { class: "pp-hint pp-tr-more", style: "margin-top:6px;" },
          (zh ? "已收起 " + rest + " 个引擎 —— 点右上「展开全部」查看（免配置 / 自备密钥 / 自建地址都在里面）。"
            : rest + " more engines hidden — click “Show all”.")));
      }
      return;
    }

    for (const g of groups) {
      const list = ov.services.filter((s) => catOf(s) === g.key);
      if (!list.length) continue;
      // 活动引擎排在该组最前，便于对照
      list.sort((a, b) => (a.enabled ? -1 : b.enabled ? 1 : 0));
      box.appendChild(el("div", { class: "pp-sub-title", style: "margin-top:9px;" },
        g.label + "（" + list.length + "）"));
      for (const s of list) box.appendChild(buildEngineRow(s, true));
    }
  }

  /** 检测本机自建翻译服务（LibreTranslate 5000 / Lingva 3000 / DLX 1188），命中即一键填入地址 */
  async function onLocalScan() {
    const S = T();
    const btn = $("pp-tr-local-scan");
    const box = $("pp-tr-local");
    if (!S || !box) return;
    if (btn) btn.disabled = true;
    box.textContent = zh ? "检测中（本机 5000 / 3000 / 1188 端口）…" : "Scanning localhost ports…";
    box.style.color = "var(--pp-muted)";
    try {
      const r = await S.probeLocal(2000);
      while (box.firstChild) box.removeChild(box.firstChild);
      if (!r.found.length) {
        box.textContent = zh
          ? "未发现本机自建服务。想零成本无限流？例如先跑一个：docker run -p 5000:5000 libretranslate/libretranslate —— 起来后再点此按钮。"
          : "No local instance found. e.g. docker run -p 5000:5000 libretranslate/libretranslate";
        box.style.color = "var(--pp-muted)";
        return;
      }
      box.textContent = "";
      box.style.color = "var(--pp-success)";
      box.appendChild(el("span", null, (zh ? "发现 " : "Found ") + r.found.length + (zh ? " 个：" : ": ")));
      for (const f of r.found) {
        const b = el("button", { class: "pp-btn pp-btn-sm", title: f.url },
          (zh ? "填入 " : "Use ") + f.name + "（" + f.latencyMs + "ms）");
        b.style.marginRight = "6px";
        b.addEventListener("click", () => {
          S.setSecret(f.engine, { url: f.url });
          setMsg((zh ? "已填入 " : "Filled ") + f.name + "：" + f.url, "var(--pp-success)");
          renderAll();
        });
        box.appendChild(b);
      }
    } catch (e) {
      box.textContent = "✗ " + ((e && e.message) || e);
      box.style.color = "var(--pp-danger)";
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /**
   * 「测试」：真实调用一次引擎。
   * ⚠️ 0.31.0 修的坑：此前结果只写进卡片底部那个**共用**结果区，而它在十几行引擎之后 ——
   * 用户点了按钮，反馈出现在屏幕外，按钮又飞快复原，观感就是"测试没反应"。
   * 现在双写：**行内即时反馈**（就在按钮下方）+ 底部汇总（多引擎对比时仍有用）。
   * 失败一律给出可读原因（缺密钥 / 取 token 失败 / HTTP 状态 / 超时…），不静默。
   */
  async function onTest(id, btn, msgEl) {
    const S = T();
    if (!S) return;
    const old = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "…"; }
    const nm = (S.get(id) || {}).name || id;
    const say = (text, color) => {
      if (msgEl) { msgEl.textContent = text; msgEl.style.color = color; }
      setMsg(text, color);
    };
    say((zh ? "测试中（真实调用一次）：" : "Testing: ") + nm, "var(--pp-muted)");
    try {
      const r = await S.testEngine(id);
      if (r.ok) {
        const txt = String(r.text || "").replace(/\s+/g, " ").slice(0, 40);
        say("✓ " + r.latencyMs + "ms · 「" + txt + "」", "var(--pp-success)");
        setMsg("✓ " + nm + (zh ? " 正常，延迟 " : " OK, ") + r.latencyMs + "ms" +
          (zh ? "，译文「" : ", result “") + txt + "」", "var(--pp-success)");
      } else {
        const err = r.error || (zh ? "未知错误" : "unknown error");
        say("✗ " + (zh ? "失败：" : "Failed: ") + err, "var(--pp-danger)");
        setMsg("✗ " + nm + (zh ? " 失败：" : " failed: ") + err, "var(--pp-danger)");
      }
    } catch (e) {
      const m = (e && e.message) || String(e);
      say("✗ " + (zh ? "异常：" : "Error: ") + m, "var(--pp-danger)");
      setMsg("✗ " + nm + "：" + m, "var(--pp-danger)");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = old; }
    }
  }

  function renderAll() {
    renderStatus();
    renderActiveSelect();
    renderKnobs();
    renderList();
  }

  /* ---------- 初始化（DOM 就绪探测） ---------- */
  function init() {
    if (typeof Zotero === "undefined" || !Zotero.PaperPilot || !T()) {
      window.setTimeout(init, 400);
      return;
    }
    // Zotero 先执行脚本、后插入 fragment：关键节点不存在就延迟重试
    if (!$("pp-tr-list") || !$("pp-tr-active")) {
      window.setTimeout(init, 300);
      return;
    }
    if (init._done) return;
    init._done = true;

    const S = T();
    try { S.migrate(); } catch (e) { /* ignore */ }

    const bind = (id, ev, fn) => { const n = $(id); if (n) n.addEventListener(ev, fn); };

    bind("pp-tr-active", "change", () => {
      const v = $("pp-tr-active").value;
      const r = S.setActive(v);
      if (!r.ok) { setMsg("✗ " + r.error, "var(--pp-danger)"); return; }
      setMsg(zh ? "已切换翻译引擎（立即生效，无需重启）" : "Engine switched (takes effect immediately)",
        "var(--pp-success)");
      renderAll();
    });

    bind("pp-tr-fallback", "change", () => {
      const raw = String($("pp-tr-fallback").value || "");
      const list = raw.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
      const bad = list.filter((x) => !S.get(x));
      S.saveCfg({ fallback: list });
      if (bad.length) {
        setMsg((zh ? "已保存回退链；未知引擎 id 已忽略：" : "Saved; unknown ids ignored: ") + bad.join(", "),
          "var(--pp-warn)");
      } else {
        setMsg(zh ? "已保存回退链" : "Fallback chain saved", "var(--pp-success)");
      }
      renderAll();
    });

    bind("pp-tr-timeout", "change", () => {
      S.saveCfg({ timeoutMs: Number($("pp-tr-timeout").value) || 15000 });
      renderKnobs();
    });
    bind("pp-tr-retry", "change", () => {
      S.saveCfg({ retry: !!$("pp-tr-retry").checked });
    });
    bind("pp-tr-cache", "change", () => {
      S.saveCfg({ cache: !!$("pp-tr-cache").checked });
      try { S.clearCache(); } catch (e) { /* ignore */ }
    });
    // 预算三件套：0 = 关闭该项保护（界面上写明）
    bind("pp-tr-route", "change", () => {
      S.saveCfg({ routeMs: Math.max(0, Number($("pp-tr-route").value) || 0) });
      renderKnobs();
    });
    bind("pp-tr-total", "change", () => {
      S.saveCfg({ totalMs: Math.max(0, Number($("pp-tr-total").value) || 0) });
      renderKnobs();
    });
    bind("pp-tr-cooldown", "change", () => {
      const sec = Math.max(0, Number($("pp-tr-cooldown").value) || 0);
      S.saveCfg({ cooldownMs: sec > 0 ? Math.round(sec * 1000) : 0 });
      try { S.clearCooldown(); } catch (e) { /* ignore */ } // 改了就重新计时
      renderKnobs();
    });
    bind("pp-tr-local-scan", "click", onLocalScan);

    // 0.33.0 术语表与全文翻译优化：术语表存 translateGlossary（改完即时生效——
    // 翻译侧每次调用都重新解析；缓存键含术语表指纹，不吃旧缓存）
    bind("pp-tr-glossary", "change", () => {
      const v = String($("pp-tr-glossary").value || "");
      try {
        Zotero.Prefs.set("extensions.zotero.paperpilot.translateGlossary", v);
      } catch (e) { /* ignore */ }
      try { if (T() && T().clearCache) T().clearCache(); } catch (e) { /* ignore */ }
      renderGlossaryMsg(v);
      setMsg(zh ? "已保存术语表（下次翻译即生效）" : "Glossary saved (effective immediately)",
        "var(--pp-success)");
    });
    bind("pp-tr-bl-struct", "change", () => {
      try {
        Zotero.Prefs.set("extensions.zotero.paperpilot.bilingualStructExtract",
          !!$("pp-tr-bl-struct").checked);
      } catch (e) { /* ignore */ }
    });
    bind("pp-tr-bl-context", "change", () => {
      try {
        Zotero.Prefs.set("extensions.zotero.paperpilot.bilingualContext",
          !!$("pp-tr-bl-context").checked);
      } catch (e) { /* ignore */ }
    });
    bind("pp-tr-formula", "change", () => {
      try {
        Zotero.Prefs.set("extensions.zotero.paperpilot.translateFormulaProtect",
          !!$("pp-tr-formula").checked);
      } catch (e) { /* ignore */ }
    });

    // 0.34.0 PDF 原位对照翻译：改完即时生效（refresh 会重铺所有活跃阅读器）
    const piRefresh = () => {
      try {
        const pi = PP().pdfInline;
        if (pi && pi.refresh) pi.refresh();
      } catch (e) { /* ignore */ }
    };
    bind("pp-pi-mode", "change", () => {
      let v = String($("pp-pi-mode").value || "off");
      if (["off", "overlay", "bilingual"].indexOf(v) < 0) v = "off";
      try { Zotero.Prefs.set("extensions.zotero.paperpilot.pdfInlineMode", v); } catch (e) { /* ignore */ }
      piRefresh();
      setMsg(v === "off"
        ? (zh ? "已关闭原位对照翻译（阅读器工具栏按钮仍可按需开启）" : "Inline translation off")
        : (zh ? "已开启：打开 PDF 后译文将按段叠加在原页位置" : "Inline translation enabled"),
        "var(--pp-success)");
    });
    bind("pp-pi-scale", "change", () => {
      const n = Number($("pp-pi-scale").value);
      const v = isFinite(n) && n > 0 ? Math.min(1.6, Math.max(0.7, n)) : 1;
      try {
        Zotero.Prefs.set("extensions.zotero.paperpilot.pdfInlineFontScale", String(v));
      } catch (e) { /* ignore */ }
      if ($("pp-pi-scale")) $("pp-pi-scale").value = String(v);
      piRefresh();
    });
    bind("pp-pi-gap", "change", () => {
      const n = Number($("pp-pi-gap").value);
      const v = isFinite(n) && n >= 0 ? Math.min(5000, Math.round(n)) : 120;
      try {
        Zotero.Prefs.set("extensions.zotero.paperpilot.pdfInlineGapMs", String(v));
      } catch (e) { /* ignore */ }
      if ($("pp-pi-gap")) $("pp-pi-gap").value = String(v);
    });
    bind("pp-pi-selectable", "change", () => {
      try {
        Zotero.Prefs.set("extensions.zotero.paperpilot.pdfInlineSelectable",
          !!$("pp-pi-selectable").checked);
      } catch (e) { /* ignore */ }
      piRefresh();
    });

    try { renderAll(); } catch (e) { /* 渲染失败不影响面板其余部分 */ }
  }

  init();
  if (typeof window !== "undefined" && window.setTimeout) {
    window.setTimeout(init, 400);
    window.setTimeout(init, 1200);
  }
})();
