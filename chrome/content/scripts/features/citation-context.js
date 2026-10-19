// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot · 引文上下文（Scite 风格，0.52.0 新增）
 *
 * 解决什么：判断一篇文献「是否站得住」，最省力的一步是看后来者**怎么引用它**——
 * 是「与之一致」还是「指出其局限」。现在这些引用句散落在几百篇 PDF 里，没人会去翻。
 * 本模块把「谁引用了本文 + 引用它的原句 + 句子倾向」压进条目面板一屏。
 *
 * 数据：Semantic Scholar /graph/v1/paper/{id}/citations 的 contexts/intents/
 *       isInfluential（S2Client.citations，见 features/s2-client.js）。依据是条目 DOI。
 * 判定：`_classify` 是**纯函数**（无 IO、无全局），启发式规则见下方常量与注释。
 *       它只是「读句子给个倾向」，不是事实判断；UI 用徽标+原句并排展示，让用户自己复核。
 *
 * 注册路径（与 related-papers 同款四坑）：
 *   ① onRender 必填且自己包 try；② header/sidenav 的 l10nID 必须有 ftl 条目
 *      （本模块用 `_l10nID` / `_sidenavID` 常量，集成方按 key 补 ftl）；
 *   ③ 注销用 registerSection 的**返回值**；④ 注册时机由 main.js 主线控制。
 *   宿主机没有 ItemPaneManager 或校验失败（返回 false / 抛错）时 register() 返回
 *   false、**不抛**，绝不影响启动。
 *
 * 与 RelatedPapers 的关系：独立状态（自己的 _panes / paneID），互不干扰；只共享
 * S2Client 的限速与缓存。
 */
/* global Zotero, Services, I18n, S2Client */

/* ---------------- 词表（大小写不敏感；英文 + 中文） ---------------- */

/* 英文用小写词干 + 前缀断言，允许 fails/failure/limitations/supporting 这类词形；
 * 全词匹配才安全的（unlike 会被 unlikely 误命中）放进 EXACT。中文用子串。 */
var CC_TERMS = {
  // 批评：明确否定/指出问题
  critique: ["fail", "limitation", "problem", "weakness", "contradict",
    "incorrect", "questionable", "inaccurate", "质疑", "不足", "错误"],
  // 对比：并置差异，未必否定
  contrast: ["in contrast", "unlike", "differs", "whereas", "compared with",
    "however", "contrary", "相反", "不同于"],
  // 支持：正面沿用/印证
  support: ["consistent with", "confirm", "support", "extend", "in line with",
    "corroborate", "支持", "印证", "一致"],
};

/* 只有整词匹配才安全的英文词（避免 unlikely / furthermore 之类误命中） */
var CC_EXACT = { unlike: 1, however: 1, whereas: 1, differs: 1, contrary: 1 };

/** 词表 → {re:RegExp|null, cn:[string]}（模块加载时编译一次） */
function ccBuild(tems) {
  var en = [];
  var cn = [];
  for (var i = 0; i < tems.length; i++) {
    var t = tems[i];
    if (/^[a-z][a-z ]*$/.test(t)) {
      en.push(CC_EXACT[t] ? "\\b" + t + "\\b" : "\\b" + t);
    } else {
      cn.push(t); // 中文（含全角标点的短语）走子串
    }
  }
  return { re: en.length ? new RegExp("(?:" + en.join("|") + ")", "i") : null, cn: cn };
}

var CC_GROUPS = {
  critique: ccBuild(CC_TERMS.critique),
  contrast: ccBuild(CC_TERMS.contrast),
  support: ccBuild(CC_TERMS.support),
};

/* 展示顺序：批评 > 对比 > 支持 > 中性 */
var CC_RANK = { critique: 0, contrast: 1, support: 2, neutral: 3 };

var CitationContext = {
  PANE_ID: "papilot-citecon",
  ICON: "chrome://papilot/content/icons/refs.svg",
  LIMIT: 20,        // 向 S2 请求的条数
  SHOW_MAX: 8,      // 面板最多展示条数（按倾向排序后截断）
  CONTEXT_MAX: 200, // 引用句截断长度
  _l10nID: "papilot-citecon-section-header",
  _sidenavID: "papilot-citecon-section-sidenav",

  _registered: false,
  _registeredPaneID: null,
  _panes: new Map(),

  /* ---------------- 基础 ---------------- */

  _zh() {
    try { return (typeof I18n !== "undefined" && I18n) ? !!I18n.isZh : true; } catch (e) { return true; }
  },

  _h(doc, tag, attrs, text) {
    const el = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
    if (attrs) for (const k in attrs) {
      if (attrs[k] === undefined || attrs[k] === null) continue;
      if (k === "style") el.style.cssText = attrs[k];
      else el.setAttribute(k, attrs[k]);
    }
    if (text != null) el.textContent = text;
    return el;
  },

  _state(paneID) {
    if (!this._panes.has(paneID)) {
      this._panes.set(paneID, { item: null, res: null, token: 0, doc: null, refs: null });
    }
    return this._panes.get(paneID);
  },

  /** 常规条目；PDF 附件归一到父条目（阅读器侧栏选中的常是附件） */
  _resolveItem(item) {
    if (!item) return null;
    try {
      if (item.isRegularItem && item.isRegularItem()) return item;
      if (item.isAttachment && item.isAttachment()) {
        const p = item.parentItem;
        if (p && p.isRegularItem && p.isRegularItem()) return p;
      }
    } catch (e) { /* ignore */ }
    return null;
  },

  _field(item, name) {
    try { return String(item.getField(name) || "").trim(); } catch (e) { return ""; }
  },

  /** DOI：标准字段优先，其次 extra 里的 `DOI: 10.x/y`（Zotero 通用约定） */
  _doiOf(item) {
    const direct = this._field(item, "DOI").replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
    if (direct) return direct;
    const extra = this._field(item, "extra");
    const m = /DOI:\s*(\S+)/i.exec(extra);
    return m ? String(m[1]).replace(/[.,;]+$/, "") : "";
  },

  /* ---------------- 倾向判定（纯函数，可单测） ---------------- */

  /** intents 归一：数组或 "methodology,background" 字符串 → 小写数组 */
  _intentsOf(v) {
    const out = [];
    if (Array.isArray(v)) {
      for (const x of v) {
        const s = String(x == null ? "" : x).trim().toLowerCase();
        if (s) out.push(s);
      }
    } else if (v != null) {
      for (const s of String(v).split(/[,;]/)) {
        const t = s.trim().toLowerCase();
        if (t) out.push(t);
      }
    }
    return out;
  },

  _hit(text, group) {
    const g = group || {};
    if (g.re) {
      g.re.lastIndex = 0;
      if (g.re.test(text)) return true;
    }
    for (const cn of (g.cn || [])) if (text.indexOf(cn) >= 0) return true;
    return false;
  },

  /**
   * 引用句倾向。
   *   规则（优先级从高到低）：
   *     ① 空文本 → neutral（没有证据就不猜）
   *     ② critique 词命中 → critique
   *     ③ contrast 词命中 → contrast
   *     ④ support 词命中 → support，但 intents 含 methodology 且非 influential 时降为
   *        neutral（方法学引用里的 "consistent with / based on" 常是描述而非赞同）
   *     ⑤ 其余 → neutral
   *   isInfluential 只用于**守住** support（不把支持降级），不额外升级任何档位：
   *   一篇被重点引用的文章不会因为「影响力大」就从对比变成批评。
   *
   * @param {string} text         引用句（一般取第一个 context）
   * @param {string[]|string} [intents]
   * @param {boolean} [isInfluential]
   * @returns {"support"|"contrast"|"critique"|"neutral"}
   */
  _classify(text, intents, isInfluential) {
    const s = String(text == null ? "" : text).toLowerCase();
    if (!s.trim()) return "neutral";
    const methodology = this._intentsOf(intents).indexOf("methodology") >= 0;

    if (this._hit(s, CC_GROUPS.critique)) return "critique";
    if (this._hit(s, CC_GROUPS.contrast)) return "contrast";
    if (this._hit(s, CC_GROUPS.support)) {
      if (methodology && !isInfluential) return "neutral";
      return "support";
    }
    return "neutral";
  },

  /* ---------------- 注册 ---------------- */

  /**
   * item pane section 注册（幂等）。
   * @returns {string|false} 成功返回 registerSection 的句柄（注销必须用它），失败返回 false
   */
  register(pluginID) {
    if (this._registered) return this._registeredPaneID || false;
    const IPM = (typeof Zotero !== "undefined" && Zotero) ? Zotero.ItemPaneManager : null;
    if (!IPM || typeof IPM.registerSection !== "function") return false;

    const self = this;
    let handle = false;
    try {
      handle = IPM.registerSection({
        paneID: this.PANE_ID,
        pluginID,
        header: { l10nID: this._l10nID, icon: this.ICON },
        sidenav: { l10nID: this._sidenavID, icon: this.ICON },
        // 坑①：onRender 必填；渲染异常自己兜住，不能把 section 宿主拖垮
        onRender({ paneID, doc, body }) {
          try {
            if (!body || (body.querySelector && body.querySelector("[data-pp-citecon-root]"))) return;
            self._build(doc, body, paneID);
          } catch (e) {
            try { Zotero.logError(e); } catch (_) { /* ignore */ }
          }
        },
        onItemChange({ paneID, item, setEnabled }) {
          try {
            const target = self._resolveItem(item);
            if (typeof setEnabled === "function") setEnabled(!!target);
            const st = self._state(paneID);
            const prev = st.item;
            st.item = target;
            if (!target) {
              st.token++;          // 换/清空条目：作废在途请求
              st.res = null;
              self._render(paneID);
              return true;
            }
            if (!prev || prev.id !== target.id) self._fetchDebounced(paneID);
            return true;
          } catch (e) {
            try { Zotero.logError(e); } catch (_) { /* ignore */ }
            return false;
          }
        },
        onDestroy({ paneID }) {
          const _st = self._panes.get(paneID);
          if (_st && _st.timer) { try { clearTimeout(_st.timer); } catch (e) { /* ignore */ } }
          self._panes.delete(paneID);
        },
      });
    } catch (e) {
      handle = false;
    }
    // 坑②：Z10 schema 校验失败时静默返回 false，必须显式检查
    if (!handle) return false;
    this._registeredPaneID = handle;
    this._registered = true;
    return handle;
  },

  /** 坑③：用 registerSection 的返回值注销；未注册时静默 */
  unregister() {
    const handle = this._registeredPaneID;
    this._registeredPaneID = null;
    this._registered = false;
    this._panes.clear();
    if (!handle) return false;
    try {
      if (Zotero.ItemPaneManager && typeof Zotero.ItemPaneManager.unregisterSection === "function") {
        Zotero.ItemPaneManager.unregisterSection(handle);
      }
    } catch (e) { /* 已注销则忽略 */ }
    return true;
  },

  /* ---------------- 取数（条目 → 结果，不碰 DOM） ---------------- */

  /** 一条 S2 施引记录 → UI/测试都吃的扁平条目 */
  _entry(raw) {
    const r = raw || {};
    const rawCtx = Array.isArray(r.contexts) ? r.contexts : [];
    const contexts = [];
    for (const c of rawCtx) {
      const s = String(c == null ? "" : c).replace(/\s+/g, " ").trim();
      if (s) contexts.push(s);
    }
    // 只用**第一个** context 判定与展示：同一篇施引文献的其他句子可能说的是别的事，
    // 混在一起会把「支持」和「批评」平均成噪声。
    const context = contexts.length ? contexts[0] : "";
    const year = parseInt(r.year, 10);
    return {
      title: String(r.title == null ? "" : r.title).replace(/\s+/g, " ").trim(),
      year: isFinite(year) ? year : 0,
      authors: (typeof r.authors === "string") ? r.authors : "",
      stance: this._classify(context, r.intents, r.isInfluential),
      context,
      isInfluential: !!r.isInfluential,
    };
  },

  /**
   * @returns {Promise<{ok:boolean, total:number, entries:Array, reason?:string, message?:string}>}
   *   reason: no_item / no_doi / no_client / rate_limit / network / server / auth / http
   *   total = S2 返回的原始条数；entries 已按倾向排序并截到 SHOW_MAX。永不抛。
   */
  async fetchFor(item) {
    const it = this._resolveItem(item);
    if (!it) return { ok: false, total: 0, entries: [], reason: "no_item" };

    const doi = this._doiOf(it);
    if (!doi) return { ok: false, total: 0, entries: [], reason: "no_doi" };

    const S2 = (typeof S2Client !== "undefined" && S2Client) ? S2Client : null;
    if (!S2 || typeof S2.citations !== "function") {
      return { ok: false, total: 0, entries: [], reason: "no_client" };
    }

    try {
      // 显式传 limit：单参调用在 S2Client 里保留给 citation-trace 的旧语义
      const raw = await S2.citations("DOI:" + doi, this.LIMIT);
      if (raw && raw.ok === false) {
        return {
          ok: false, total: 0, entries: [],
          reason: raw.reason || "http", message: raw.error || "",
        };
      }
      const list = Array.isArray(raw) ? raw : [];
      const entries = [];
      for (const one of list) {
        const e = this._entry(one);
        if (e.title) entries.push(e);
      }
      // 稳定排序：同倾向内保持 S2 原序（sort 在旧引擎上不保证稳定，这里显式带下标）
      const idx = new Map();
      entries.forEach((e, i) => idx.set(e, i));
      entries.sort((a, b) => (CC_RANK[a.stance] - CC_RANK[b.stance]) || (idx.get(a) - idx.get(b)));
      return { ok: true, total: list.length, entries: entries.slice(0, this.SHOW_MAX) };
    } catch (e) {
      return {
        ok: false, total: 0, entries: [],
        reason: "network", message: (e && e.message) || String(e),
      };
    }
  },

  /* ---------------- 文案 ---------------- */

  _stanceLabel(stance) {
    const zh = this._zh();
    if (stance === "critique") return zh ? "批评" : "Critique";
    if (stance === "contrast") return zh ? "对比" : "Contrast";
    if (stance === "support") return zh ? "支持" : "Support";
    return zh ? "中性" : "Neutral";
  },

  _stanceColor(stance) {
    if (stance === "critique") return "#b91c1c";
    if (stance === "contrast") return "#b45309";
    if (stance === "support") return "#2f9e6f";
    return "#6b7280";
  },

  _statusText(res) {
    const zh = this._zh();
    const r = res && res.reason;
    if (r === "no_doi") return zh ? "该条目缺少 DOI，无法查询引文上下文" : "This item has no DOI, so citation contexts cannot be looked up";
    if (r === "rate_limit") return zh ? "Semantic Scholar 限流，请稍后重试" : "Semantic Scholar rate limit reached, try again later";
    if (r === "network") return zh ? "网络不可用" : "Network unavailable";
    if (r === "auth") return zh ? "Semantic Scholar 拒绝了请求，请检查 API Key" : "Request rejected by Semantic Scholar, check the API key";
    if (r === "server") return zh ? "Semantic Scholar 服务异常" : "Semantic Scholar service error";
    if (r === "no_item") return zh ? "请选择一条文献" : "Select an item";
    if (r === "no_client") return zh ? "Semantic Scholar 客户端不可用" : "Semantic Scholar client unavailable";
    return (res && res.message) || (zh ? "暂时无法获取引文上下文" : "Citation contexts unavailable");
  },

  _lineText(e) {
    const zh = this._zh();
    let s = String(e.title || "");
    if (e.year) s += (zh ? "（" : " (") + e.year + (zh ? "）" : ")");
    return s;
  },

  _cut(s, n) {
    const str = String(s == null ? "" : s);
    return str.length > n ? str.slice(0, n) + "…" : str;
  },

  /* ---------------- UI（onRender 调用；测试可直接调） ---------------- */

  _build(doc, body, paneID) {
    const self = this;
    const H = (t, a, x) => self._h(doc, t, a, x);
    const zh = this._zh();
    const st = this._state(paneID);
    st.doc = doc;

    const root = H("div", {
      "data-pp-citecon-root": "1",
      style: "display:flex;flex-direction:column;gap:6px;padding:7px 8px;font-size:12.5px;line-height:1.5;",
    });
    const current = H("div", {
      class: "pp-citecon-current",
      style: "font-size:11.5px;color:var(--fill-secondary,#888);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;",
    }, zh ? "当前文献" : "Current item");
    root.appendChild(current);

    const status = H("div", {
      class: "pp-citecon-status",
      style: "font-size:11px;color:var(--fill-secondary,#888);min-height:14px;",
    }, zh ? "正在查询引文上下文…" : "Looking up citation contexts…");
    root.appendChild(status);

    const list = H("div", {
      class: "pp-citecon-list",
      style: "display:flex;flex-direction:column;gap:5px;max-height:420px;overflow-y:auto;",
    });
    root.appendChild(list);

    const link = H("a", {
      class: "pp-citecon-s2",
      href: "#",
      style: "font-size:11.5px;color:var(--color-accent,#2f9e6f);text-decoration:none;cursor:pointer;margin-top:2px;",
    }, zh ? "在 S2 打开" : "Open in S2");
    link.addEventListener("click", (ev) => {
      try { if (ev && ev.preventDefault) ev.preventDefault(); } catch (e) { /* ignore */ }
      self._openCurrent(paneID);
    });
    root.appendChild(link);

    body.appendChild(root);
    st.refs = { current, status, list, link };

    if (st.item) this._fetch(paneID);
    else this._renderTitle(paneID);
  },

  _status(paneID, msg, warn) {
    const st = this._state(paneID);
    if (!st.refs || !st.refs.status) return;
    st.refs.status.textContent = msg || "";
    st.refs.status.style.color = warn ? "var(--color-warning,#b45309)" : "var(--fill-secondary,#888)";
  },

  _renderTitle(paneID) {
    const st = this._state(paneID);
    if (!st.refs || !st.refs.current) return;
    let title = "";
    try {
      if (st.item) title = st.item.getDisplayTitle ? st.item.getDisplayTitle() : this._field(st.item, "title");
    } catch (e) { title = ""; }
    st.refs.current.textContent = title || (this._zh() ? "当前文献" : "Current item");
    st.refs.current.title = title;
  },

  _openURL(url) {
    if (!url) return false;
    try { if (Zotero.launchURL) { Zotero.launchURL(url); return true; } } catch (e) { /* 落兜底 */ }
    try { Services.appShell.hiddenDOMWindow.open(url, "_blank"); return true; } catch (e) { /* ignore */ }
    return false;
  },

  /** 当前条目的 S2 论文页（有 DOI 时用 DOI: 形式，S2 会重定向到规范页） */
  _paperURL(paneID) {
    const st = this._state(paneID);
    const doi = st.item ? this._doiOf(st.item) : "";
    if (!doi) return "";
    return "https://www.semanticscholar.org/paper/" + encodeURI("DOI:" + doi);
  },

  _openCurrent(paneID) {
    return this._openURL(this._paperURL(paneID));
  },

  /**
   * 取数 + 代际丢弃：每次请求带一个自增 token，await 回来发现 token 变了
   * （用户已切到别的条目）就整包丢弃——旧结果绝不能盖掉新条目的面板。
   */
  /** 0.54.0（审查 P1-6）：条目切换防抖 400ms（S2 无限速时 1.1s/请求，快速翻阅会排队） */
  _fetchDebounced(paneID) {
    const delay = Number(this.DEBOUNCE_MS);
    if (!isFinite(delay) || delay <= 0) { this._fetch(paneID); return; }
    const st = this._state(paneID);
    if (st.timer) { try { clearTimeout(st.timer); } catch (e) { /* ignore */ } }
    st.timer = setTimeout(() => {
      st.timer = null;
      this._fetch(paneID);
    }, delay);
  },

  async _fetch(paneID) {
    const st = this._state(paneID);
    const item = st.item;
    if (!item) { this._render(paneID); return; }
    const token = ++st.token;
    st.res = null;
    this._renderTitle(paneID);
    this._status(paneID, this._zh() ? "正在查询引文上下文…" : "Looking up citation contexts…");
    this._render(paneID);
    try {
      const res = await this.fetchFor(item);
      if (token !== st.token) return; // 期间换了条目：丢弃旧结果
      st.res = res;
      this._render(paneID);
    } catch (e) {
      if (token !== st.token) return;
      st.res = { ok: false, total: 0, entries: [], reason: "error", message: (e && e.message) || String(e) };
      this._render(paneID);
    }
  },

  _render(paneID) {
    const st = this._state(paneID);
    if (!st.refs || !st.doc) return;
    const zh = this._zh();
    const H = (t, a, x) => this._h(st.doc, t, a, x);
    const list = st.refs.list;
    while (list.firstChild) list.removeChild(list.firstChild);
    this._renderTitle(paneID);

    if (!st.item) {
      this._status(paneID, zh ? "请选择一条文献" : "Select an item");
      return;
    }
    const res = st.res;
    if (!res) return; // 加载中：状态行已由 _fetch 写好

    if (!res.ok) {
      this._status(paneID, this._statusText(res), true);
      return;
    }
    if (!res.entries || !res.entries.length) {
      this._status(paneID, zh ? "暂无引用记录" : "No citations yet");
      return;
    }
    this._status(paneID, zh
      ? "共 " + res.total + " 条引用，按倾向排序展示 " + res.entries.length + " 条"
      : res.total + " citations, showing " + res.entries.length + " by stance");

    for (const e of res.entries) {
      const row = H("div", {
        "data-pp-cite": e.stance,
        class: "pp-citecon-row",
        style: "display:flex;flex-direction:column;gap:2px;padding:5px 6px;border-radius:5px;" +
          "background:#88888810;border:1px solid #88888828;",
      });
      const head = H("div", { style: "display:flex;align-items:baseline;gap:6px;" });
      const color = this._stanceColor(e.stance);
      head.appendChild(H("span", {
        class: "pp-citecon-badge pp-citecon-" + e.stance,
        style: "flex:none;font-size:10px;line-height:1.6;padding:0 5px;border-radius:4px;color:" + color +
          ";border:1px solid " + color + "55;background:" + color + "14;",
      }, this._stanceLabel(e.stance)));
      head.appendChild(H("div", {
        class: "pp-citecon-title",
        title: e.title || "",
        style: "flex:1;min-width:0;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;",
      }, this._lineText(e)));
      row.appendChild(head);

      if (e.context) {
        row.appendChild(H("div", {
          class: "pp-citecon-quote",
          style: "font-size:11px;font-style:italic;color:var(--fill-secondary,#888);padding-left:2px;",
        }, this._cut(e.context, this.CONTEXT_MAX)));
      }
      list.appendChild(row);
    }
  },
};

// 与 related-papers 同款：main.js 装配完成后可直接 Zotero.Papilot.CitationContext 取到
try {
  if (typeof Zotero !== "undefined" && Zotero.Papilot && !Zotero.Papilot.CitationContext) {
    Zotero.Papilot.CitationContext = CitationContext;
  }
} catch (e) { /* ignore */ }
