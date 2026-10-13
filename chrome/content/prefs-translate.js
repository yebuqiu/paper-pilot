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
  }

  /* ---------- 引擎行 ---------- */
  function buildEngineRow(s) {
    const S = T();
    const row = el("div", { class: "pp-ch-row" });

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
    row.appendChild(left);

    // 操作按钮
    const acts = el("div", { style: "display:flex;gap:6px;flex:none;align-items:flex-start;flex-wrap:wrap;max-width:220px;justify-content:flex-end;" });
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
    bTest.addEventListener("click", () => onTest(s.id, bTest));
    acts.appendChild(bTest);
    if (s.docs) {
      const bDoc = mkBtn(zh ? "文档" : "Docs", s.docs);
      bDoc.addEventListener("click", () => {
        try { Zotero.launchURL(s.docs); } catch (e) { /* ignore */ }
      });
      acts.appendChild(bDoc);
    }
    row.appendChild(acts);
    return row;
  }

  function renderList() {
    const box = $("pp-tr-list");
    const S = T();
    if (!box || !S) return;
    while (box.firstChild) box.removeChild(box.firstChild);
    const ov = S.overview();
    for (const s of ov.services) box.appendChild(buildEngineRow(s));
  }

  async function onTest(id, btn) {
    const S = T();
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = "…";
    setMsg((zh ? "测试中（真实调用一次）：" : "Testing: ") + id, "var(--pp-muted)");
    try {
      const r = await S.testEngine(id);
      if (r.ok) {
        const txt = String(r.text || "").slice(0, 60);
        setMsg("✓ " + id + (zh ? " 正常，延迟 " : " OK, ") + r.latencyMs + "ms" +
          (zh ? "，译文「" : ", result “") + txt + "」", "var(--pp-success)");
      } else {
        setMsg("✗ " + id + (zh ? " 失败：" : " failed: ") + r.error, "var(--pp-danger)");
      }
    } catch (e) {
      setMsg("✗ " + id + "： " + ((e && e.message) || e), "var(--pp-danger)");
    } finally {
      btn.disabled = false;
      btn.textContent = old;
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

    try { renderAll(); } catch (e) { /* 渲染失败不影响面板其余部分 */ }
  }

  init();
  if (typeof window !== "undefined" && window.setTimeout) {
    window.setTimeout(init, 400);
    window.setTimeout(init, 1200);
  }
})();
