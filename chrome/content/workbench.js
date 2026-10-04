/* PaperPilot 工作台 2.0（0.13.0 重写）
 * 新增：三模式（本文/深度研读/全库）、流式输出+停止、消息操作（复制/重答/存笔记）、
 *       多会话管理（pref 持久化）、Prompt 技能库、AI 配置快照切换、导出 .md、双主题。
 * 数据通道不变：Zotero/Services 经 window.arguments 传入；AI 走 PP.aiClient/PP.aiChat。
 */
/* global window, document, setInterval, clearInterval, setTimeout, Components */

(function () {
  const XHTML = "http://www.w3.org/1999/xhtml";
  const SESSIONS_PREF = "extensions.zotero.paperpilot.workbenchSessions";
  const THEME_PREF = "extensions.zotero.paperpilot.wbTheme";
  const SESSION_CAP = 20;
  const TRANSCRIPT_CAP = 60;

  /* ================= 可测试的纯逻辑（挂 window.PPWorkbench） ================= */

  const Sessions = {
    load(getPref) {
      try {
        const raw = getPref(SESSIONS_PREF);
        const data = JSON.parse(raw || "{}");
        if (!data || !Array.isArray(data.list)) return { active: null, list: [] };
        return { active: data.active || null, list: data.list.slice(0, SESSION_CAP) };
      } catch (e) {
        return { active: null, list: [] };
      }
    },
    save(setPref, store) {
      try {
        setPref(SESSIONS_PREF, JSON.stringify({
          active: store.active, list: store.list.slice(0, SESSION_CAP),
        }));
      } catch (e) { /* 超限时静默 */ }
    },
    newId() {
      return "s" + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
    },
    upsert(store, session) {
      const i = store.list.findIndex((s) => s.id === session.id);
      session.transcript = (session.transcript || []).slice(-TRANSCRIPT_CAP);
      if (i >= 0) store.list[i] = session;
      else store.list.unshift(session);
      store.list = store.list.slice(0, SESSION_CAP);
      store.active = session.id;
      return store;
    },
    remove(store, id) {
      store.list = store.list.filter((s) => s.id !== id);
      if (store.active === id) store.active = store.list[0] ? store.list[0].id : null;
      return store;
    },
    find(store, id) {
      return store.list.find((s) => s.id === id) || null;
    },
  };

  /** 模式 → system prompt 增补 */
  function modeSystemSuffix(mode, zh) {
    if (mode === "deep") {
      return zh
        ? "\n\n当前为深度研读模式：请基于论文全文做深入分析，回答要引用原文具体细节（数据、公式、论证），不确定处明确指出。"
        : "\n\nDeep-reading mode: answer with specific details from the full text.";
    }
    if (mode === "free") {
      return zh
        ? "\n\n当前为全库对话模式：用户未指定具体文献，请作为通用学术研究助手回答。"
        : "\n\nFree chat mode: no specific paper in context.";
    }
    return "";
  }

  /** Markdown → HTML（沿用 0.9.1 渲染器风格，表格/标题/列表/引用/分隔线） */
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function mdInline(s) {
    return esc(s)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "<a href='$2'>$1</a>");
  }
  function mdToHtml(md) {
    const lines = String(md || "").split(/\r?\n/);
    let html = "";
    let inUl = false, inOl = false, para = [], table = [];
    const closeLists = () => {
      if (inUl) { html += "</ul>"; inUl = false; }
      if (inOl) { html += "</ol>"; inOl = false; }
    };
    const flushPara = () => {
      if (para.length) { html += "<p>" + para.join("<br/>") + "</p>"; para = []; }
    };
    const flushTable = () => {
      if (!table.length) return;
      const rows = table.filter((l) => !/^\s*\|[\s:|-]+\|\s*$/.test(l));
      if (rows.length) {
        html += "<table>";
        rows.forEach((l, idx) => {
          const cells = l.trim().replace(/^\||\|$/g, "").split("|");
          const tag = idx === 0 ? "th" : "td";
          html += "<tr>" + cells.map((c) => `<${tag}>${mdInline(c.trim())}</${tag}>`).join("") + "</tr>";
        });
        html += "</table>";
      }
      table = [];
    };
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, "");
      if (/^\s*\|.+\|\s*$/.test(line)) { flushPara(); closeLists(); table.push(line); continue; }
      flushTable();
      const h = line.match(/^\s*#{1,4}\s+(.+)$/);
      const ul = line.match(/^\s*[-*•]\s+(.+)$/);
      const ol = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (h) {
        flushPara(); closeLists();
        html += `<p><strong>${mdInline(h[1])}</strong></p>`;
      } else if (ul) {
        flushPara();
        if (inOl) { html += "</ol>"; inOl = false; }
        if (!inUl) { html += "<ul>"; inUl = true; }
        html += "<li>" + mdInline(ul[1]) + "</li>";
      } else if (ol) {
        flushPara();
        if (inUl) { html += "</ul>"; inUl = false; }
        if (!inOl) { html += "<ol>"; inOl = true; }
        html += "<li>" + mdInline(ol[1]) + "</li>";
      } else if (!line.trim()) {
        flushPara(); closeLists();
      } else if (/^\s*>/.test(line)) {
        flushPara(); closeLists();
        html += "<blockquote>" + mdInline(line.replace(/^\s*>\s?/, "")) + "</blockquote>";
      } else if (/^\s*---+\s*$/.test(line)) {
        flushPara(); closeLists();
        html += "<hr/>";
      } else if (/^\s*```/.test(line)) {
        flushPara(); closeLists();
      } else {
        closeLists();
        para.push(mdInline(line));
      }
    }
    flushTable();
    flushPara(); closeLists();
    return html;
  }

  if (typeof window !== "undefined") {
    window.PPWorkbench = { Sessions, modeSystemSuffix, mdToHtml, SESSION_CAP, TRANSCRIPT_CAP };
  }

  /* ================= 窗口装配 ================= */

  function boot() {
    let Services, opener, Zotero, PP, zh;
    try {
      const args = window.arguments && window.arguments[0];
      Services = (args && args.Services) || window.Services;
      Zotero = (args && args.Zotero) || (window.opener && window.opener.Zotero);
      opener = window.opener;
      if (!Services || !Zotero || !Zotero.PaperPilot) { showError("无法获取依赖"); return; }
      PP = Zotero.PaperPilot;
      zh = (Zotero.locale || "").toLowerCase().startsWith("zh");
    } catch (e) {
      showError("初始化异常：" + (e && (e.message || e)));
      return;
    }
    try {
      _run(Services, opener, Zotero, PP, zh);
    } catch (e) {
      try { Zotero.logError(e); } catch (_) { /* ignore */ }
      showError("工作台初始化失败：" + (e && (e.message || e) || e));
    }
  }

  function showError(text) {
    try {
      const d = document.createElementNS(XHTML, "div");
      d.style.cssText = "color:#c0392b;font-size:12px;padding:8px;";
      d.textContent = text;
      const box = document.getElementById("pp-wb-msgs");
      if (box) box.appendChild(d);
    } catch (_) { /* ignore */ }
  }

  function _run(Services, opener, Zotero, PP, zh) {
    /* ---------- 状态 ---------- */
    let currentItem = null;
    let history = [];
    let transcript = [];
    let busy = false;
    let followTimer = null;
    let contextItem = null;
    let mode = "paper"; // paper | deep | free
    let currentHandle = null; // 流式句柄（停止用）
    let session = null;       // 当前会话 {id,itemID,title,ts,transcript,history}
    let sessionStore = null;

    const $ = (id) => document.getElementById(id);
    const msgs = $("pp-wb-msgs");
    const status = $("pp-wb-status");
    const setStatus = (t, color) => { status.textContent = t || ""; status.style.color = color || ""; };
    const getPref = (k, fb) => {
      try {
        const v = Zotero.Prefs.get(k, true);
        return v === undefined || v === null ? fb : v;
      } catch (e) { return fb; }
    };
    const setPref = (k, v) => { try { Zotero.Prefs.set(k, v, true); } catch (e) { /* ignore */ } };

    function h(tag, cls, text) {
      const el = document.createElementNS(XHTML, tag);
      if (cls) el.className = cls;
      if (text != null) el.textContent = text;
      return el;
    }

    /* ---------- 主题 ---------- */
    function applyTheme() {
      let t = getPref(THEME_PREF, "auto");
      if (t === "auto") {
        try {
          t = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
        } catch (e) { t = "light"; }
      }
      document.documentElement.setAttribute("data-theme", t);
      $("pp-wb-theme").textContent = t === "dark" ? "☀" : "🌙";
      return t;
    }
    $("pp-wb-theme").addEventListener("click", () => {
      const cur = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      setPref(THEME_PREF, cur);
      applyTheme();
    });
    applyTheme();

    /* ---------- 模型与通道切换（0.14.0：取代配置快照） ---------- */
    function refreshModel() {
      $("pp-wb-model").textContent = PP.aiClient.model() || "";
    }
    function fillChannels() {
      const sel = $("pp-wb-profile");
      sel.textContent = "";
      const opt0 = h("option", "", zh ? "切换通道…" : "Channel…");
      opt0.value = "";
      sel.appendChild(opt0);
      let data = { channels: [], active: null };
      try { data = PP.channels.list(); } catch (e) { /* ignore */ }
      for (const c of data.channels) {
        const label = c.name + (c.official && !c.available ? "（需登录）" : "");
        const o = h("option", "", label + (c.id === data.active ? " ✓" : ""));
        o.value = c.id;
        sel.appendChild(o);
      }
    }
    $("pp-wb-profile").addEventListener("change", (ev) => {
      const id = ev.target.value;
      if (!id) return;
      try {
        const r = PP.channels.setActive(id);
        if (r.ok) {
          setStatus((zh ? "✓ 已切换通道：" : "✓ Channel: ") + id);
          refreshModel();
        } else {
          setStatus((zh ? "切换失败：" : "Failed: ") + r.error, "var(--pp-danger)");
        }
      } catch (e) { setStatus((zh ? "切换失败：" : "Failed: ") + (e.message || e), "var(--pp-danger)"); }
      ev.target.value = "";
    });
    fillChannels();
    refreshModel();

    /* ---------- 会话管理 ---------- */
    sessionStore = Sessions.load(getPref);

    function currentSessionSnapshot() {
      return {
        id: session ? session.id : Sessions.newId(),
        itemID: currentItem ? currentItem.id : null,
        title: sessionTitle(),
        ts: Date.now(),
        transcript: transcript.slice(),
        history: history.slice(),
      };
    }
    function sessionTitle() {
      if (session && session.title && transcript.length) return session.title;
      const firstUser = transcript.find((t) => t.role === "user");
      if (firstUser) return firstUser.text.replace(/\s+/g, " ").slice(0, 24);
      if (currentItem) {
        try { return (currentItem.getDisplayTitle() || "").slice(0, 24); } catch (e) { /* ignore */ }
      }
      return zh ? "新会话" : "New session";
    }
    function persistSession() {
      if (!transcript.length) return;
      session = currentSessionSnapshot();
      Sessions.upsert(sessionStore, session);
      Sessions.save(setPref, sessionStore);
    }
    function loadSession(s) {
      session = s;
      transcript = (s.transcript || []).slice();
      history = (s.history || []).slice();
      contextItem = currentItem; // 上下文已在历史里，不重复注入
      msgs.textContent = "";
      for (const t of transcript) {
        if (t.role === "user") addBubble("user", t.text, true);
        else if (t.role === "ai") addAiBubble(t.text, true);
        else addNotice(t.text);
      }
    }
    function newSession() {
      persistSession();
      session = null;
      history = [];
      transcript = [];
      contextItem = null;
      msgs.textContent = "";
      addNotice(zh ? "—— 新会话 ——" : "—— new session ——");
    }

    /* ---------- 气泡 ---------- */
    function addBubble(role, text, noRecord) {
      const wrap = h("div", "pp-wb-msg-row " + (role === "user" ? "user" : "ai"));
      const b = h("div", "pp-wb-bubble");
      b.textContent = text;
      wrap.appendChild(b);
      msgs.appendChild(wrap);
      msgs.scrollTop = msgs.scrollHeight;
      if (!noRecord) transcript.push({ role, text });
      return b;
    }
    /** AI 气泡：富文本 + hover 操作（复制/重答/存笔记） */
    function addAiBubble(md, noRecord, opts = {}) {
      const wrap = h("div", "pp-wb-msg-row ai");
      const b = h("div", "pp-wb-bubble");
      b.innerHTML = mdToHtml(md);
      if (!opts.noActions) {
        const acts = h("div", "pp-wb-msg-actions");
        const mk = (label, fn) => {
          const btn = h("button", "pp-wb-act-btn", label);
          btn.addEventListener("click", fn);
          acts.appendChild(btn);
          return btn;
        };
        const copyBtn = mk(zh ? "复制" : "Copy", () => {
          try {
            Zotero.Utilities.Internal.copyText(md);
            copyBtn.textContent = zh ? "✓ 已复制" : "✓";
            setTimeout(() => { copyBtn.textContent = zh ? "复制" : "Copy"; }, 1200);
          } catch (e) { /* ignore */ }
        });
        mk(zh ? "重答" : "Retry", () => regenerate());
        mk(zh ? "存笔记" : "Save", async () => {
          try {
            if (currentItem) {
              await PP.notes.createFromMarkdown(currentItem,
                (zh ? "工作台摘录｜" : "Excerpt | ") + new Date().toISOString().slice(0, 10), md);
              setStatus(zh ? "✓ 已存为笔记" : "✓ Saved");
            } else {
              setStatus(zh ? "无当前条目，请用底部「存为笔记」存全量" : "No item selected", "var(--pp-danger)");
            }
          } catch (e) { setStatus((zh ? "保存失败：" : "Failed: ") + (e.message || e), "var(--pp-danger)"); }
        });
        b.appendChild(acts);
      }
      wrap.appendChild(b);
      msgs.appendChild(wrap);
      msgs.scrollTop = msgs.scrollHeight;
      if (!noRecord) transcript.push({ role: "ai", text: md });
      return b;
    }
    function addNotice(text, isErr) {
      const wrap = h("div", "pp-wb-msg-row sys");
      const b = h("div", "pp-wb-bubble" + (isErr ? " err" : ""), text);
      wrap.appendChild(b);
      msgs.appendChild(wrap);
      msgs.scrollTop = msgs.scrollHeight;
    }

    /* ---------- 条目上下文 ---------- */
    function itemMetaLine(item) {
      try {
        const get = (f) => { try { return item.getField(f) || ""; } catch (e) { return ""; } };
        const year = String(get("date")).match(/(\d{4})/);
        const bits = [];
        if (get("publicationTitle")) bits.push(get("publicationTitle"));
        if (year) bits.push(year[1]);
        const c = item.getCreators()[0];
        if (c && c.lastName) bits.push(c.lastName + (item.getCreators().length > 1 ? " 等" : ""));
        return bits.join(" · ");
      } catch (e) { return ""; }
    }
    function setItem(item) {
      const changed = !item || !currentItem || item.id !== currentItem.id;
      currentItem = item;
      if (item) {
        let title = "";
        try { title = item.getDisplayTitle() || ""; } catch (e) { /* ignore */ }
        $("pp-wb-item-title").textContent = title || "(no title)";
        $("pp-wb-item-meta").textContent = itemMetaLine(item);
      } else {
        $("pp-wb-item-title").textContent = zh ? "（未选择条目）" : "(No item)";
        $("pp-wb-item-meta").textContent = "";
      }
      if (changed && transcript.length) {
        addNotice(zh ? "—— 条目已切换，后续提问针对新条目 ——" : "—— item switched ——");
      }
    }
    function followSelection() {
      if (busy || !$("pp-wb-follow").checked) return;
      try {
        if (!opener || opener.closed) { window.close(); return; }
        const zp = Zotero.getActiveZoteroPane();
        if (!zp) return;
        const sel = zp.getSelectedItems() || [];
        let it = null;
        for (const i of sel) {
          try {
            if (i.isRegularItem && i.isRegularItem()) { it = i; break; }
            if (i.isAttachment && i.isAttachment() && i.parentID) {
              const p = Zotero.Items.get(i.parentID);
              if (p && p.isRegularItem && p.isRegularItem()) { it = p; break; }
            }
          } catch (e) { /* ignore */ }
        }
        if ((it && !currentItem) || (!it && currentItem)
          || (it && currentItem && it.id !== currentItem.id)) {
          setItem(it);
        }
      } catch (e) { /* ignore */ }
    }
    async function pickItem() {
      const input = { value: "" };
      if (!Services.prompt.prompt(window, "PaperPilot",
        zh ? "输入标题关键词检索文献：" : "Search items by title keyword:", input)) return;
      const kw = (input.value || "").trim();
      if (!kw) return;
      try {
        const s = new Zotero.Search();
        s.libraryID = Zotero.Libraries.userLibraryID;
        s.addCondition("title", "contains", kw);
        s.addCondition("itemType", "isNot", "attachment");
        const ids = await s.search();
        if (!ids.length) {
          Services.prompt.alert(window, "PaperPilot", zh ? "没有匹配的条目" : "No matching items");
          return;
        }
        if (ids.length === 1) { setItem(await Zotero.Items.getAsync(ids[0])); return; }
        const items = [];
        for (const id of ids.slice(0, 10)) items.push(await Zotero.Items.getAsync(id));
        const titles = items.map((i) => {
          let t = "";
          try { t = i.getDisplayTitle() || ""; } catch (e) { /* ignore */ }
          return t.length > 70 ? t.slice(0, 70) + "…" : t;
        });
        const out = { value: 0 };
        if (Services.prompt.select(window, "PaperPilot",
          zh ? `找到 ${ids.length} 篇，选择：` : `Found ${ids.length}, pick one:`,
          titles.length, titles, out)) {
          setItem(items[out.value]);
        }
      } catch (e) {
        Services.prompt.alert(window, "PaperPilot", String(e && e.message || e));
      }
    }

    /* ---------- 模式 ---------- */
    function setMode(m) {
      if (m === mode) return;
      mode = m;
      // 切换模式后上下文失效：下次提问按新模式重新注入（深度=全文，本文=摘要优先）
      contextItem = null;
      history = [];
      if (transcript.length) {
        addNotice(zh ? "—— 模式已切换，对话上下文将重建 ——" : "—— mode switched ——");
      }
      document.querySelectorAll(".pp-wb-mode").forEach((b) => {
        b.className = "pp-wb-mode" + (b.getAttribute("data-mode") === m ? " active" : "");
      });
      setStatus(m === "deep" ? (zh ? "深度研读：基于全文深度分析" : "Deep reading")
        : m === "free" ? (zh ? "全库对话：不绑定具体文献" : "Free chat")
        : "");
    }
    document.querySelectorAll(".pp-wb-mode").forEach((b) => {
      b.addEventListener("click", () => setMode(b.getAttribute("data-mode")));
    });

    async function buildContext(item) {
      const get = (f) => { try { return item.getField(f) || ""; } catch (e) { return ""; } };
      let ctx = `【论文题录】\n标题：${get("title")}\n作者：${(item.getCreators() || [])
        .map((c) => [c.firstName, c.lastName].filter(Boolean).join(" ")).slice(0, 8).join(", ")}\n` +
        `期刊：${get("publicationTitle")}  年份：${String(get("date")).slice(0, 4)}`;
      let body = "";
      try {
        if (mode === "deep") {
          body = (await PP.aiChat.getFullText(item)) || get("abstractNote") || "";
        } else {
          body = get("abstractNote") || (await PP.aiChat.getFullText(item)) || "";
        }
      } catch (e) { /* ignore */ }
      if (body) ctx += `\n【正文材料】\n${body.slice(0, 16000)}`;
      return ctx;
    }

    async function buildMessages(question) {
      const messages = [];
      let sys = getPref("extensions.zotero.paperpilot.aiSystemPrompt", "") || "";
      sys += modeSystemSuffix(mode, zh);
      if (sys.trim()) messages.push({ role: "system", content: sys });
      if (mode !== "free" && currentItem && contextItem !== currentItem) {
        contextItem = currentItem;
        history = [];
        const ctx = await buildContext(currentItem);
        messages.push({ role: "user", content: zh
          ? "以下是背景材料，之后的提问都围绕它：\n\n" + ctx
          : "Background material for the following questions:\n\n" + ctx });
        messages.push({ role: "assistant", content: zh ? "好的，已了解该文献。" : "Got it." });
      }
      for (const m of history) messages.push({ role: m.role, content: m.content });
      messages.push({ role: "user", content: question });
      return messages;
    }

    /* ---------- 发送（流式 + 停止） ---------- */
    function setBusy(b) {
      busy = b;
      $("pp-wb-send").hidden = b;
      $("pp-wb-stop").hidden = !b;
      document.querySelectorAll(".pp-wb-chip").forEach((c) => { c.disabled = b; });
    }

    async function runChat(question) {
      setBusy(true);
      const bubbleWrap = h("div", "pp-wb-msg-row ai");
      const bubble = h("div", "pp-wb-bubble");
      bubble.textContent = zh ? "思考中…" : "Thinking…";
      bubbleWrap.appendChild(bubble);
      msgs.appendChild(bubbleWrap);
      setStatus(zh ? "AI 生成中…（Esc 停止）" : "Generating…");
      let acc = "";
      try {
        const messages = await buildMessages(question);
        const onDelta = (chunk) => {
          if (!acc) bubble.textContent = "";
          acc += chunk;
          bubble.textContent = acc + "▌";
          msgs.scrollTop = msgs.scrollHeight;
        };
        let reply;
        if (PP.aiClient.chatStream) {
          currentHandle = PP.aiClient.chatStream(messages, onDelta);
          reply = await currentHandle.promise;
        } else {
          reply = await PP.aiClient.chat(messages);
        }
        bubbleWrap.remove();
        addAiBubble(reply);
        history.push({ role: "user", content: question }, { role: "assistant", content: reply });
        if (history.length > 12) history = history.slice(-12);
        persistSession();
        setStatus("");
      } catch (e) {
        bubbleWrap.remove();
        if (e && e.message === "ABORTED" && acc) {
          addNotice(zh ? "—— 已停止，保留已生成内容 ——" : "—— stopped ——");
          addAiBubble(acc + (zh ? "\n\n（已中断）" : "\n\n(interrupted)"));
          history.push({ role: "user", content: question }, { role: "assistant", content: acc });
          persistSession();
        } else if (e && e.message === "ABORTED") {
          addNotice(zh ? "—— 已停止 ——" : "—— stopped ——");
        } else {
          addNotice((zh ? "出错：" : "Error: ") + (e && e.message || e), true);
        }
        setStatus(zh ? "已停止" : "Stopped");
      } finally {
        currentHandle = null;
        setBusy(false);
        msgs.scrollTop = msgs.scrollHeight;
      }
    }

    async function regenerate() {
      if (busy) return;
      const lastAiIdx = transcript.map((t) => t.role).lastIndexOf("ai");
      if (lastAiIdx < 1) return;
      const lastUser = transcript[lastAiIdx - 1];
      if (!lastUser || lastUser.role !== "user") return;
      transcript.splice(lastAiIdx - 1, 2);
      history.splice(-2, 2);
      msgs.textContent = "";
      for (const t of transcript) {
        if (t.role === "user") addBubble("user", t.text, true);
        else if (t.role === "ai") addAiBubble(t.text, true);
      }
      addBubble("user", lastUser.text);
      await runChat(lastUser.text);
    }

    async function send() {
      if (busy) return;
      const text = $("pp-wb-input").value.trim();
      if (!text) return;
      if (!PP.aiClient.hasKey()) {
        addNotice(zh
          ? "请先在 设置 → PaperPilot 登录账号（官方模型免费），或在「AI 模型通道」配置自己的接口"
          : "Log in under Settings → PaperPilot, or configure your own AI channel", true);
        return;
      }
      $("pp-wb-input").value = "";
      addBubble("user", text);
      await runChat(text);
    }

    /* ---------- 快捷动作 ---------- */
    async function quickAction(act) {
      if (busy) return;
      if (!currentItem) {
        Services.prompt.alert(window, "PaperPilot",
          zh ? "请先选择条目" : "Select an item first");
        return;
      }
      const labels = {
        summary: zh ? "【快捷】总结本文" : "[Quick] Summarize",
        translate: zh ? "【快捷】翻译标题与摘要" : "[Quick] Translate",
        interpret: zh ? "【快捷】深度解读" : "[Quick] Interpret",
      };
      addBubble("user", labels[act] || act);
      setBusy(true);
      const wrap = h("div", "pp-wb-msg-row ai");
      const bubble = h("div", "pp-wb-bubble", zh ? "AI 生成中…" : "Generating…");
      wrap.appendChild(bubble);
      msgs.appendChild(wrap);
      try {
        const fns = {
          summary: () => PP.aiChat.summarize(currentItem),
          translate: () => PP.aiChat.translateTitleAbstract(currentItem),
          interpret: () => PP.aiChat.interpret(currentItem),
        };
        const reply = await (fns[act] || fns.summary)();
        wrap.remove();
        addAiBubble(reply);
        persistSession();
      } catch (e) {
        wrap.remove();
        addNotice((zh ? "出错：" : "Error: ") + (e && e.message || e), true);
      } finally {
        setBusy(false);
      }
    }
    document.querySelectorAll(".pp-wb-act").forEach((b) =>
      b.addEventListener("click", () => quickAction(b.getAttribute("data-act"))));
    $("pp-wb-chip-bilingual").addEventListener("click", () => {
      // 0.25.2：改为打开左右双栏对照窗口（原「生成双语笔记」入口仍在右键菜单与窗口内）
      try { PP.bilingual.openViewerForSelected(); } catch (e) { /* ignore */ }
    });
    $("pp-wb-chip-mindmap").addEventListener("click", () => {
      try { PP.mindmap.runForSelected(); } catch (e) { /* ignore */ }
    });

    /* ---------- 弹出列表（通用） ---------- */
    let openPop = null;
    function closePop() { if (openPop) { openPop.remove(); openPop = null; } }
    function showPop(anchor, entries) {
      closePop();
      const pop = h("div", "pp-wb-pop");
      for (const e of entries) {
        if (e.sep) { pop.appendChild(h("div", "pp-wb-pop-sep")); continue; }
        const item = h("div", "pp-wb-pop-item" + (e.active ? " active" : ""), e.label);
        item.addEventListener("click", () => { closePop(); e.run(); });
        if (e.trash) {
          const tr = h("span", "pp-wb-trash", "🗑");
          tr.addEventListener("click", (ev2) => { ev2.stopPropagation(); e.trash(); closePop(); });
          item.appendChild(tr);
        }
        pop.appendChild(item);
      }
      anchor.parentNode.appendChild(pop);
      openPop = pop;
    }
    document.addEventListener("click", (ev) => {
      if (openPop && !openPop.contains(ev.target)) closePop();
    });

    /* ---------- Prompt 技能库 ---------- */
    $("pp-wb-chip-prompts").addEventListener("click", (ev) => {
      ev.stopPropagation();
      let prompts = [];
      try { prompts = PP.prompts.all(); } catch (e) { /* ignore */ }
      showPop(ev.target, prompts.map((p) => ({
        label: p.name,
        run: () => {
          if (!currentItem && mode !== "free") {
            setStatus(zh ? "Prompt 需要当前条目（或切到全库对话）" : "Select an item first", "var(--pp-danger)");
            return;
          }
          $("pp-wb-input").value = p.text;
          send();
        },
      })));
    });

    /* ---------- 会话弹窗 ---------- */
    $("pp-wb-sessions").addEventListener("click", (ev) => {
      ev.stopPropagation();
      persistSession();
      const entries = [{
        label: zh ? "＋ 新建会话" : "+ New session",
        run: () => newSession(),
      }, { sep: true }];
      for (const s of sessionStore.list) {
        entries.push({
          label: (s.title || (zh ? "会话" : "Session")) + " · " + new Date(s.ts).toLocaleDateString(),
          active: s.id === (session && session.id),
          run: () => loadSession(Sessions.find(sessionStore, s.id) || s),
          trash: () => {
            Sessions.remove(sessionStore, s.id);
            Sessions.save(setPref, sessionStore);
            if (session && session.id === s.id) newSession();
          },
        });
      }
      showPop(ev.target, entries);
    });

    /* ---------- 存笔记 / 导出 / 清空 ---------- */
    async function saveNote() {
      if (!transcript.some((t) => t.role === "ai")) {
        Services.prompt.alert(window, "PaperPilot", zh ? "还没有可保存的对话" : "Nothing to save yet");
        return;
      }
      try {
        const md = transcript.map((t) =>
          (t.role === "user" ? "**问：**\n" : t.role === "ai" ? "**答：**\n" : "") + (t.text || "")).join("\n\n---\n\n");
        const date = new Date().toISOString().slice(0, 10);
        if (currentItem) {
          await PP.notes.createFromMarkdown(currentItem,
            (zh ? "工作台对话｜" : "Workbench Chat | ") + date, md);
        } else {
          const note = new Zotero.Item("note");
          note.libraryID = Zotero.Libraries.userLibraryID;
          note.setNote(PP.mdLite.toNoteHtml((zh ? "工作台对话｜" : "Workbench Chat | ") + date, md));
          await note.saveTx();
        }
        setStatus(zh ? "✓ 已保存为笔记" : "✓ Saved as note");
      } catch (e) {
        Services.prompt.alert(window, "PaperPilot", String(e && e.message || e));
      }
    }
    function exportMd() {
      if (!transcript.length) {
        setStatus(zh ? "没有可导出的对话" : "Nothing to export", "var(--pp-danger)");
        return;
      }
      try {
        const md = transcript.map((t) =>
          (t.role === "user" ? "## 问\n\n" : t.role === "ai" ? "## 答\n\n" : "") + (t.text || "")).join("\n\n");
        const nsIFilePicker = Components.interfaces.nsIFilePicker;
        const fp = Components.classes["@mozilla.org/filepicker;1"].createInstance(nsIFilePicker);
        fp.init(window, zh ? "导出对话" : "Export chat", nsIFilePicker.modeSave);
        fp.defaultString = "paperpilot-chat-" + new Date().toISOString().slice(0, 10) + ".md";
        fp.appendFilter("Markdown", "*.md");
        fp.open((rv) => {
          if (rv !== nsIFilePicker.returnOK && rv !== nsIFilePicker.returnReplace) return;
          Zotero.File.putContentsAsync(fp.file.path, md)
            .then(() => setStatus(zh ? "✓ 已导出" : "✓ Exported"))
            .catch((e) => setStatus((zh ? "导出失败：" : "Failed: ") + (e.message || e), "var(--pp-danger)"));
        });
      } catch (e) { /* ignore */ }
    }
    function clearChat() {
      history = [];
      transcript = [];
      contextItem = null;
      session = null;
      msgs.textContent = "";
      setStatus("");
    }
    $("pp-wb-save").addEventListener("click", saveNote);
    $("pp-wb-export").addEventListener("click", exportMd);
    $("pp-wb-clear").addEventListener("click", clearChat);
    $("pp-wb-pick").addEventListener("click", () => pickItem());

    /* ---------- 输入与快捷键 ---------- */
    $("pp-wb-send").addEventListener("click", send);
    $("pp-wb-stop").addEventListener("click", () => {
      if (currentHandle) { try { currentHandle.abort(); } catch (e) { /* ignore */ } }
    });
    $("pp-wb-input").addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey) && !ev.isComposing) {
        ev.preventDefault();
        send();
      }
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && busy && currentHandle) {
        try { currentHandle.abort(); } catch (e) { /* ignore */ }
      }
      if (ev.key === "n" && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        newSession();
      }
    });

    /* ---------- 启动 ---------- */
    followTimer = setInterval(followSelection, 1500);
    followSelection();
    if (sessionStore.active) {
      const s = Sessions.find(sessionStore, sessionStore.active);
      if (s && (s.transcript || []).length) {
        loadSession(s);
      }
    }
    if (!transcript.length) {
      addNotice(zh ? "PaperPilot 工作台 · 流式对话 / 多会话 / Prompt 技能库" : "PaperPilot Workbench");
    }

    try { opener.addEventListener("unload", () => window.close(), { once: true }); } catch (e) { /* ignore */ }
    window.addEventListener("unload", () => {
      persistSession();
      if (followTimer) { clearInterval(followTimer); followTimer = null; }
    });
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    boot();
  } else {
    window.addEventListener("load", boot, { once: true });
  }
})();
