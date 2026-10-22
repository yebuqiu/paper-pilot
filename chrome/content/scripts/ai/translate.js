// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 多引擎翻译（0.28.0 建立；0.73.0 重构为「门面 + 子模块」）
 *
 * 定位：**独立于 AI 大模型**的翻译引擎接入层的**统一门面**（Facade）。
 * 上层只调 TranslateSvc.*，与具体厂商、与内部文件划分完全解耦。
 *
 * 模块地图（本目录 translate-*.js，装配顺序即依赖顺序，见 main.js files）：
 *   ┌─────────────────────┬───────────────────────────────────────────┐
 *   │ translate-lang.js    │ 语言模型：规范码 LANGS / normalizeLang /     │
 *   │  (TranslateLang)     │ 厂商码映射表（纯数据+纯函数，零依赖）          │
 *   ├─────────────────────┼───────────────────────────────────────────┤
 *   │ translate-crypto.js  │ 签名算法：SHA-1/HMAC/base64/googleTk（纯函数）│
 *   │  (TranslateCrypto)   │                                           │
 *   ├─────────────────────┼───────────────────────────────────────────┤
 *   │ translate-glossary.js│ 术语表域：解析/域过滤/提示块/指纹/统计/导入导出│
 *   │  (TranslateGlossary) │ （仅依赖 Prefs）                            │
 *   ├─────────────────────┼───────────────────────────────────────────┤
 *   │ translate-formula.js │ 行内公式掩码/还原（仅非 LLM 引擎；依赖 Prefs） │
 *   │  (TranslateFormula)  │                                           │
 *   ├─────────────────────┼───────────────────────────────────────────┤
 *   │ translate-engines.js │ 引擎注册表 SERVICES（16）+ 密钥复合串解析      │
 *   │  (TranslateEngines)  │ （数据驱动：新增引擎只改这个文件）            │
 *   ├─────────────────────┼───────────────────────────────────────────┤
 *   │ translate.js（本文件）│ 门面：配置 / 请求上下文 / 运行时（缓存·冷却·  │
 *   │  (TranslateSvc)      │ 探测·分段·重试·回退）/ 状态判定 / 迁移        │
 *   └─────────────────────┴───────────────────────────────────────────┘
 *
 * 设计要点：
 *   1. 引擎接口：{ id, name, group, needsSecret, secretFields, codes(ctx),
 *      prepare?(ctx), endpoint(ctx) -> {method,url,headers,body,responseType},
 *      extract(resp, ctx) -> string } —— endpoint/extract 是纯函数（不碰网络），
 *      可在 Node 里直接单测；只有 prepare 允许联网（Bing/Edge 取临时 token）。
 *   2. 稳定性：单请求超时（可配）+ 预算内重试一次 + **回退链**（主引擎失败自动
 *      依次尝试备用引擎）+ 失败冷却 + 结果缓存 + 错误归一化。
 *   3. 可扩展：新增厂商 = 在 translate-engines.js 的 SERVICES 里加一条；上层零改动。
 *   4. 准确性：语言码统一走 TranslateLang.normalizeLang，每引擎再映射到自己的码。
 *   5. 兼容：目标语言沿用既有 pref readerPopupTargetLang，源语言/回退链/超时/重试/
 *      各引擎密钥存 pref translateCfg；**本文件对外的 TranslateSvc 导出键保持不动**。
 *
 * 消费方：reader-popup.js（划词翻译）、bilingual-translate.js（全文对照）、
 *         chat.js（标题摘要）、pdf-compare.js（整页翻译）、panels/translate-pane.js
 *         （阅读器侧栏）、prefs-translate.js（设置面板）。
 */
/* global Zotero, Prefs, AIClient, TranslateLang, TranslateCrypto, TranslateGlossary, TranslateFormula, TranslateEngines */

var TranslateSvc = (function () {
  "use strict";

  /* ==================== 子模块别名（定义见各 translate-*.js） ==================== */

  const { LANGS, normalizeLang, langMeta, langLabel, langName } = TranslateLang;
  const { utf8Bytes, sha1Bytes, hmacSha1, base64, encodeRFC5987, googleTk } = TranslateCrypto;
  const { parseGlossary, glossaryAll, activeDomains, glossary, glossaryDomains,
    glossaryBlock, glossaryFingerprint, glossaryStats, _glossaryCheck,
    glossaryToCsv, parseGlossaryImport, mergeGlossary } = TranslateGlossary;
  const { maskInlineFormulas, unmaskFormulas } = TranslateFormula;
  const _formulaProtect = TranslateFormula.formulaProtect;
  const { SERVICES, get, list, parseSecret, joinSecret, resolveSecret, langCode } = TranslateEngines;

  /** 读 pref 的统一薄壳（Prefs 不可用时按默认值降级，绝不抛） */
  function _pref(key, dflt) {
    try { return Prefs.get(key, dflt); } catch (e) { return dflt; }
  }

  /* ==================== 配置（pref translateCfg） ==================== */

  const CFG_DEFAULTS = {
    active: "llm",
    fallback: ["edge", "google", "bing", "youdao"],
    timeoutMs: 15000,
    retry: 1,
    cache: true,
    secrets: {},
    // 回退链预算（0.31.0，参考 FluentRead 的调度参数）：单引擎预算 / 整条链总预算 / 失败冷却
    routeMs: 20000,
    totalMs: 45000,
    cooldownMs: 60000,
  };

  function cfg() {
    const raw = _pref("translateCfg", "");
    let doc = null;
    try { doc = raw ? JSON.parse(raw) : null; } catch (e) { doc = null; }
    const out = Object.assign({}, CFG_DEFAULTS);
    const num = (v, lo, hi) => (Number(v) > 0 ? Math.min(hi, Math.max(lo, Number(v))) : 0);
    if (doc && typeof doc === "object") {
      if (doc.active && get(doc.active)) out.active = doc.active;
      if (Array.isArray(doc.fallback)) out.fallback = doc.fallback.filter((x) => get(x));
      if (Number(doc.timeoutMs) > 0) out.timeoutMs = Math.min(120000, Math.max(3000, Number(doc.timeoutMs)));
      if (doc.retry !== undefined) out.retry = doc.retry ? 1 : 0;
      if (doc.cache !== undefined) out.cache = !!doc.cache;
      if (doc.secrets && typeof doc.secrets === "object") out.secrets = doc.secrets;
      // 0 表示"关闭该项保护"（routeMs/totalMs 为 0 则不限时；cooldownMs 为 0 则不做冷却）
      if (doc.routeMs !== undefined) out.routeMs = Number(doc.routeMs) > 0 ? num(doc.routeMs, 3000, 120000) : 0;
      if (doc.totalMs !== undefined) out.totalMs = Number(doc.totalMs) > 0 ? num(doc.totalMs, 5000, 300000) : 0;
      if (doc.cooldownMs !== undefined) out.cooldownMs = Number(doc.cooldownMs) > 0 ? num(doc.cooldownMs, 5000, 3600000) : 0;
    }
    return out;
  }

  function saveCfg(patch) {
    const cur = cfg();
    const next = Object.assign({}, cur, patch || {});
    if (next.active && !get(next.active)) next.active = CFG_DEFAULTS.active;
    next.fallback = (Array.isArray(next.fallback) ? next.fallback : []).filter((x) => get(x));
    try { Prefs.set("translateCfg", JSON.stringify(next)); } catch (e) { /* ignore */ }
    return next;
  }

  function setActive(id) {
    if (!get(id)) return { ok: false, error: "未知引擎" };
    saveCfg({ active: id });
    return { ok: true };
  }

  function setSecret(id, value) {
    const svc = get(id);
    if (!svc) return { ok: false, error: "未知引擎" };
    const cur = cfg();
    const secrets = Object.assign({}, cur.secrets);
    const str = typeof value === "object" ? joinSecret(id, value) : String(value == null ? "" : value);
    if (str) secrets[id] = str; else delete secrets[id];
    saveCfg({ secrets });
    return { ok: true };
  }

  function secretOf(id) {
    const c = cfg();
    return (c.secrets && c.secrets[id]) || "";
  }

  /** 目标语言（规范码）：沿用 readerPopupTargetLang，兼容旧的显示名值 */
  function targetCode() {
    return normalizeLang(_pref("readerPopupTargetLang", "zh-CN") || "zh-CN");
  }

  /** 源语言（规范码）：独立 pref translateFromLang，默认自动检测 */
  function sourceCode() {
    return normalizeLang(_pref("translateFromLang", "auto") || "auto");
  }

  /** 目标语言的 prompt 用名（"中文" / "英文" …） */
  function targetName() { return langName(targetCode()); }

  /* ==================== 请求构造 / 响应解析（纯，可直接单测） ==================== */

  /** 组装引擎调用上下文（不联网） */
  function makeCtx(id, o) {
    o = o || {};
    const c = cfg();
    const from = normalizeLang(o.from || sourceCode());
    const to = normalizeLang(o.to || targetCode());
    const rawSecret = o.secret !== undefined ? String(o.secret) : secretOf(id);
    return {
      id,
      text: String(o.text == null ? "" : o.text),
      from, to,
      fromCode: langCode(id, from, true),
      toCode: langCode(id, to, false),
      secret: rawSecret,
      parts: parseSecret(id, rawSecret),
      pre: o.pre || null,
      // 0.33.0 上下文感知（仅 llm 引擎消费）：{title?, prev?}
      context: o.context || null,
      timeoutMs: Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : c.timeoutMs,
    };
  }

  /** 构造请求描述（纯）；llm 引擎返回 null（由 _runEngine 特判） */
  function buildEndpoint(id, ctx) {
    const svc = get(id);
    if (!svc || svc.llm) return null;
    return svc.endpoint(ctx);
  }

  /** 解析响应（纯） */
  function extractResult(id, resp, ctx) {
    const svc = get(id);
    if (!svc || svc.llm) return "";
    return svc.extract(resp, ctx);
  }

  /* ==================== 运行 ==================== */

  const cache = new Map();
  const CACHE_LIMIT = 200;

  /** 缓存键含术语表指纹：改术语表后不吃旧缓存（LLM 引擎才有差异，但键统一无害） */
  function _cacheKey(id, from, to, gfp, text) {
    return id + "|" + from + "|" + to + "|" + (gfp || "") + "|" + text;
  }
  function _cacheGet(k) { return cache.has(k) ? cache.get(k) : undefined; }
  function _cacheSet(k, v) {
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
    cache.set(k, v);
  }
  function clearCache() { cache.clear(); }

  /* ---------------- 本机自建服务探测（0.31.0） ----------------
   * 让「自建离线」真正可落地：LibreTranslate / DLX / Lingva 都能本机自建且默认端口固定，
   * 但要求用户自己记住 5000/1188/3000 并不合理。这里做一次轻量探测，命中就告诉用户
   * "你本机已经跑了一个，填这个地址就能用"，一键填入即可，无需新增引擎。
   */
  const LOCAL_PROBES = [
    { engine: "libretranslate", name: "LibreTranslate", port: 5000, path: "/languages", method: "GET" },
    { engine: "lingva", name: "Lingva", port: 3000, path: "/api/v1/languages?source", method: "GET" },
    // DLX 没有健康检查端点，用一次极短的真实翻译来探活
    { engine: "deeplx", name: "DLX（DeepLX）", port: 1188, path: "/translate", method: "POST" },
  ];

  /** 探测本机常见自建翻译服务。**永不抛异常**（探不到就是探不到）。
   *  @returns {Promise<{found: Array<{engine,name,url,latencyMs}>, missed: Array<{engine,name,url,error}>}>} */
  async function probeLocal(timeoutMs) {
    const to = Number(timeoutMs) > 0 ? Number(timeoutMs) : 1500;
    const found = [];
    const missed = [];
    for (const p of LOCAL_PROBES) {
      const base = "http://127.0.0.1:" + p.port;
      const t0 = Date.now();
      try {
        const opts = { timeout: to, responseType: "json" };
        if (p.method === "POST") {
          opts.headers = { "Content-Type": "application/json" };
          opts.body = JSON.stringify({ text: "ping", source_lang: "EN", target_lang: "ZH" });
        }
        await Zotero.HTTP.request(p.method, base + p.path, opts);
        found.push({ engine: p.engine, name: p.name, url: base, latencyMs: Date.now() - t0 });
      } catch (e) {
        missed.push({ engine: p.engine, name: p.name, url: base, error: (e && e.message) || String(e) });
      }
    }
    return { found, missed };
  }

  /* ---------------- 失败冷却（0.31.0）：一个引擎刚失败过，短时间内不再用它 ----------------
   * 目的是"别把整条回退链在一次抖动里跑满"：某引擎超时/限流后，后续请求先跳过它，
   * 冷却期内其它引擎顶上；冷却到期自动恢复。只在内存里（会话级），不落 pref。
   */
  const cooldownUntil = new Map(); // engineId -> 到期时间戳

  function _markCooldown(id, ms) {
    if (!ms || ms <= 0) return;
    cooldownUntil.set(id, Date.now() + ms);
  }
  function _inCooldown(id, now) {
    const t = cooldownUntil.get(id);
    if (!t) return false;
    if (t <= (now || Date.now())) { cooldownUntil.delete(id); return false; }
    return true;
  }
  /** 冷却剩余毫秒（0 = 未冷却） */
  function cooldownLeft(id) {
    const t = cooldownUntil.get(id);
    return t && t > Date.now() ? t - Date.now() : 0;
  }
  function clearCooldown(id) {
    if (id) cooldownUntil.delete(id); else cooldownUntil.clear();
  }

  /** 网络/HTTP 异常 → 可读中文；带 retryable 标记供重试判定 */
  function _wrapError(e) {
    const status = e && e.xmlhttp && e.xmlhttp.status;
    let detail = "";
    try {
      const resp = e && e.xmlhttp && e.xmlhttp.response;
      detail = (resp && resp.error && (resp.error.message || resp.error)) ||
        (e.xmlhttp && e.xmlhttp.responseText) || "";
    } catch (_) { /* ignore */ }
    if (typeof detail !== "string") detail = "";
    detail = detail.slice(0, 200);
    let msg;
    let retryable = true;
    if (/timed?\s*out|timeout/i.test((e && e.message) || "")) { msg = "请求超时"; }
    else if (status === 401 || status === 403) { msg = "密钥无效或未授权（HTTP " + status + "）"; retryable = false; }
    else if (status === 429) { msg = "请求过于频繁或额度不足（HTTP 429）"; }
    else if (status) { msg = "HTTP " + status; retryable = status >= 500; }
    else { msg = (e && e.message) || String(e); }
    const err = new Error(msg + (detail ? "（" + detail + "）" : ""));
    err.retryable = retryable;
    err.status = status || 0;
    return err;
  }

  async function _http(spec, timeoutMs) {
    const opts = { timeout: timeoutMs || 15000, responseType: spec.responseType || "json" };
    if (spec.headers) opts.headers = spec.headers;
    if (spec.body != null) opts.body = spec.body;
    return await Zotero.HTTP.request(spec.method || "POST", spec.url, opts);
  }

  /* ---------------- 长文本分段（引擎声明单次长度/字节上限时） ---------------- */

  /**
   * 按上限把文本切成多段（**纯函数**，可离线单测）。
   *
   * 为什么需要它：不少引擎有"单次请求上限"——MyMemory 只有 **500 UTF-8 字节**
   * （不是 500 个字符！），必应网页版 1000 字符，腾讯 TMT 2000 字符，百度 6000 字节。
   * 超限时对方要么报错要么悄悄截断，表现都是"翻译结果莫名变短/失败"。
   *
   * 切分点优先落在空白处（不切开单词）；尾部空白从段里摘出来存进 `seps`，
   * 拼接时按序补回，保证"原文 → 分段 → 拼回"与空白形态一致；
   * CJK 无空白时 sep 为空串（直接相接，不会平白多出空格）。
   *
   * @param text 原文
   * @param limit 单段上限（正数）
   * @param metric "bytes"（UTF-8 字节）| "chars"（码点数）
   * @returns {{parts: string[], seps: string[]}} seps.length === parts.length - 1
   */
  function _splitText(text, limit, metric) {
    const s = String(text == null ? "" : text);
    const cap = Number(limit) > 0 ? Number(limit) : 0;
    if (!cap || !s) return { parts: s ? [s] : [], seps: [] };
    const byChars = metric === "chars";
    const cost = (t) => (byChars ? Array.from(t).length : utf8Bytes(t).length);
    // 先按"词 / 空白"交替切 token：保证不切开单词，也不会切开代理对
    const tokens = s.match(/[^\s\u3000]+|[\s\u3000]+/g) || [];
    const parts = [];
    const seps = [];
    let cur = "";
    let curCost = 0;
    /** 收段：把段尾的空白摘出来存成 sep（拼回时按序补上） */
    const flush = () => {
      if (!cur) return;
      const m = /([\s\u3000]+)$/.exec(cur);
      const body = m ? cur.slice(0, cur.length - m[1].length) : cur;
      if (!body) { cur = ""; curCost = 0; return; } // 纯空白：丢弃，不产空段
      parts.push(body);
      seps.push(m ? (m[1].indexOf("\n") >= 0 ? "\n" : " ") : "");
      cur = "";
      curCost = 0;
    };
    for (const t of tokens) {
      const c = cost(t);
      if (/^[\s\u3000]+$/.test(t)) { cur += t; curCost += c; continue; }
      if (c > cap) {
        // 单个"词"就超限（无空格的长 CJK 连串）：先收段，再按码点硬切
        flush();
        let piece = "";
        let pieceCost = 0;
        for (const ch of Array.from(t)) {
          const cc = cost(ch);
          if (piece && pieceCost + cc > cap) {
            parts.push(piece); seps.push(""); piece = ""; pieceCost = 0;
          }
          piece += ch;
          pieceCost += cc;
        }
        cur = piece;
        curCost = pieceCost;
        continue;
      }
      if (cur && curCost + c > cap) flush();
      cur += t;
      curCost += c;
    }
    if (cur) parts.push(cur); // 末段：它与前一段之间的 sep 已在上一次 flush 写入
    while (seps.length >= parts.length) seps.pop();
    return { parts, seps };
  }

  /** 该引擎单次能吞多少（未声明 limits 则不分段） */
  function _segmentsFor(svc, text) {
    const lim = svc && svc.limits;
    if (lim && lim.bytes) return _splitText(text, lim.bytes, "bytes");
    if (lim && lim.chars) return _splitText(text, lim.chars, "chars");
    return { parts: [String(text == null ? "" : text)], seps: [] };
  }

  /** 分段数上限保护：切太多段会退化成一长串串行请求 */
  const SEG_MAX = 24;

  /** 单段调用（含预算内重试）；失败抛异常 */
  async function _callOnce(svc, ctx, timeoutMs) {
    const spec = buildEndpoint(svc.id, ctx);
    if (!spec) throw new Error("该引擎未实现请求构造");

    const budget = timeoutMs || ctx.timeoutMs || 15000;
    const deadline = Date.now() + budget;
    const retry = cfg().retry;
    let lastErr = null;
    for (let attempt = 0; attempt <= retry; attempt++) {
      try {
        const resp = await _http(spec, Math.max(3000, deadline - Date.now()));
        let out;
        try {
          out = extractResult(svc.id, resp, ctx);
        } catch (pe) {
          // 解析/业务错误（密钥错、参数错、配额用尽…）重试无意义且会白烧额度
          if (pe && pe.retryable === undefined) pe.retryable = false;
          throw pe;
        }
        if (!out || !String(out).trim()) {
          const empty = new Error("引擎返回空结果");
          empty.retryable = true; // 空结果常是网关抖动，允许重试
          throw empty;
        }
        return String(out).trim();
      } catch (e) {
        const wrapped = (e && e.retryable !== undefined) ? e : _wrapError(e);
        lastErr = wrapped;
        if (!wrapped.retryable || attempt >= retry || deadline - Date.now() < 800) break;
        await new Promise((r) => setTimeout(r, 350));
      }
    }
    throw lastErr || new Error("翻译失败");
  }

  /** 调用某引擎（含 prepare、长文本分段、预算内重试）；失败抛异常 */
  async function _runEngine(id, ctx, timeoutMs) {
    const svc = get(id);
    if (!svc) throw new Error("未知翻译引擎：" + id);

    if (svc.llm) {
      // 大模型引擎：走当前 AI 通道（划词浮窗的流式路径不在这里，见 reader-popup.js）
      // 0.33.0：术语表 + 上下文感知 + 公式保持指令（术语约束只有 LLM 能理解）
      const gl = glossary();
      const cx = ctx.context || {};
      let prompt = "请将以下内容翻译成" + langName(ctx.to) +
        "，忠实原文、不增删内容，专业术语保留英文并用括号标注。" +
        "数学公式与数学表达式保持原样，不要翻译或改写其中的符号、上下标与变量；" +
        "数字、单位与统计量原样保留；逐段翻译，不要合并或拆分段落。";
      if (cx.title) prompt += "\n本文档标题：《" + String(cx.title).slice(0, 200) + "》。";
      if (cx.prev) {
        prompt += "\n上一段的译文（请保持术语与行文风格一致）：\n" + String(cx.prev).slice(0, 600);
      }
      const gb = glossaryBlock(gl, ctx.text);
      if (gb) prompt += "\n术语表（以下术语必须按给定译法翻译，并保持全文一致）：\n" + gb;
      prompt += "\n纯文本输出，禁止使用任何 Markdown 标记；只输出译文，不要任何解释。\n\n" + ctx.text;
      const msgs = [
        { role: "system", content: (_pref("aiSystemPrompt", "") || "") },
        { role: "user", content: prompt },
      ];
      const out = await AIClient.chat(msgs);
      return String(out == null ? "" : out).trim();
    }

    // prepare：联网预处理（取临时 token / 会话参数）。**整次调用只做一次**，
    // 多段切分时复用同一份 pre —— 否则每段都会去取一次 token。
    // （0.31.0 修：此前 prepare 只声明、从未被调用，导致依赖它的 bing 引擎必然失败）
    if (typeof svc.prepare === "function" && !ctx.pre) {
      ctx = Object.assign({}, ctx, { pre: await svc.prepare(ctx) });
    }

    // 0.33.0 行内公式保护：高置信数学片段换成占位符，译后还原（LLM 走提示词不掩码）
    let fMap = null;
    if (ctx.text && _formulaProtect()) {
      const m = maskInlineFormulas(ctx.text);
      if (m.count) {
        fMap = m.map;
        ctx = Object.assign({}, ctx, { text: m.text });
      }
    }

    const seg = _segmentsFor(svc, ctx.text);
    let out;
    if (seg.parts.length <= 1) {
      out = await _callOnce(svc, ctx, timeoutMs);
    } else if (seg.parts.length > SEG_MAX) {
      throw new Error("文本过长：「" + svc.name + "」按单次上限需切成 " + seg.parts.length +
        " 段（上限 " + SEG_MAX + " 段）。请改用其他引擎，或调大「全文对照翻译分段字符数」");
    } else {
      const outs = [];
      for (let i = 0; i < seg.parts.length; i++) {
        outs.push(await _callOnce(svc, Object.assign({}, ctx, { text: seg.parts[i] }), timeoutMs));
        if (i < seg.parts.length - 1) await new Promise((r) => setTimeout(r, 120));
      }
      out = outs[0];
      for (let i = 1; i < outs.length; i++) out += (seg.seps[i - 1] || "") + outs[i];
    }
    return fMap ? unmaskFormulas(out, fMap) : out;
  }

  /**
   * 解析候选引擎顺序：显式指定 > 活动引擎 + 回退链（去重、跳过不可用）
   */
  function _candidates(o) {
    if (o && o.engine) return [o.engine];
    const c = cfg();
    const seq = [c.active].concat(Array.isArray(o && o.noFallback) && o.noFallback ? [] : c.fallback);
    const seen = new Set();
    const out = [];
    for (const id of seq) {
      if (!id || seen.has(id) || !get(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  }

  /**
   * 翻译入口。
   * @param text 原文
   * @param o { to?, from?, engine?, secret?, noFallback?, noCache?, timeoutMs?,
   *            context? {title?, prev?} —— 0.33.0 上下文感知（仅 llm 引擎消费：
   *            title=文档标题，prev=上一段译文，用于保持术语与行文一致） }
   * @returns {Promise<{ok, text?, engine?, engineName?, fallback?, cached?, tried, error?}>}
   *   tried: [{engine, error}] —— 失败过的引擎，供 UI 展示与排障
   */
  async function translate(text, o) {
    o = o || {};
    const clean = String(text == null ? "" : text).trim();
    if (!clean) return { ok: false, error: "没有可翻译的内容", tried: [] };

    const c = cfg();
    const to = normalizeLang(o.to || targetCode());
    const from = normalizeLang(o.from || sourceCode());
    const tried = [];

    const cands = _candidates(o);
    if (!cands.length) return { ok: false, error: "没有可用的翻译引擎", tried };

    // 冷却过滤：跳过刚失败过的引擎（显式指定 o.engine 时不跳，尊重调用方意图）
    const now0 = Date.now();
    const cooled = [];
    let chain = cands;
    if (!o.engine && c.cooldownMs > 0) {
      chain = cands.filter((id) => {
        if (_inCooldown(id, now0)) { cooled.push({ engine: id, leftMs: cooldownLeft(id) }); return false; }
        return true;
      });
      // 全在冷却 → 仍然按原顺序试一次（宁可慢，也不要"什么都没做"）
      if (!chain.length) chain = cands;
    }

    const started = Date.now();
    const nameOf = (id) => { const s = get(id); return s ? s.name : id; };
    // 0.33.0：术语表指纹进缓存键（上下文刻意不进——滚动上下文会让缓存形同虚设）
    const gfp = glossaryFingerprint();

    for (let i = 0; i < chain.length; i++) {
      const id = chain[i];
      const svc = get(id);
      const useCache = c.cache && !o.noCache;
      const key = _cacheKey(id, from, to, gfp, clean);
      if (useCache) {
        const hit = _cacheGet(key);
        if (hit !== undefined) {
          return { ok: true, text: hit, engine: id, engineName: svc.name,
            fallback: i > 0, cached: true, tried, cooled,
            glossary: _glossaryCheck(clean, hit) };
        }
      }
      // llm 引擎需要 AI 就绪；未就绪直接跳过（避免把「没登录」当成引擎故障）
      if (svc.llm && typeof AIClient !== "undefined" && AIClient && !AIClient.hasKey()) {
        tried.push({ engine: id, error: "AI 不可用（" + (AIClient.guidance ? AIClient.guidance() : "未登录/未配置") + "）" });
        continue;
      }
      if (svc.needsSecret) {
        const r = resolveSecret(id, secretOf(id));
        if (!r.ok) { tried.push({ engine: id, error: r.error }); continue; }
      }

      // 预算：单路不超过 routeMs，整体不超过 totalMs（0 = 不限）
      const spent = Date.now() - started;
      if (c.totalMs > 0 && c.totalMs - spent < 2000) {
        tried.push({ engine: id, error: "总预算已用完（" + c.totalMs + "ms）" });
        break;
      }
      let budget = o.timeoutMs || c.timeoutMs;
      if (c.routeMs > 0) budget = Math.min(budget, c.routeMs);
      if (c.totalMs > 0) budget = Math.min(budget, Math.max(3000, c.totalMs - spent));

      try {
        const ctx = makeCtx(id, { text: clean, from, to, secret: o.secret,
          context: o.context || null, timeoutMs: budget });
        const out = await _runEngine(id, ctx, budget);
        if (useCache) _cacheSet(key, out);
        if (i > 0) clearCooldown(id); // 顶上来了说明已恢复
        return { ok: true, text: out, engine: id, engineName: svc.name,
          fallback: i > 0, cached: false, tried, cooled,
          // 0.4x 术语一致性自检（轻量 includes；空表/未命中时为 null，零成本）
          glossary: _glossaryCheck(clean, out) };
      } catch (e) {
        const msg = (e && e.message) || String(e);
        tried.push({ engine: id, error: msg });
        _markCooldown(id, c.cooldownMs); // 失败的引擎先冷一会儿
      }
    }
    const first = tried[0];
    return {
      ok: false,
      error: first ? first.error : "翻译失败",
      tried,
      cooled,
      // 一键重排的可读摘要（UI 直接展示"哪些被跳过、为什么"）
      detail: tried.map((t) => nameOf(t.engine) + "：" + t.error).join("；"),
    };
  }

  /** 设置界面「测试」：指定引擎实测一小段 */
  async function testEngine(id, sample) {
    const svc = get(id);
    if (!svc) return { ok: false, error: "未知引擎" };
    if (svc.needsSecret) {
      const r = resolveSecret(id, secretOf(id));
      if (!r.ok) return { ok: false, error: "请先填写密钥 —— " + r.error };
    }
    if (svc.llm && typeof AIClient !== "undefined" && AIClient && !AIClient.hasKey()) {
      return { ok: false, error: "AI 不可用：" + (AIClient.guidance ? AIClient.guidance() : "未登录/未配置") };
    }
    const text = sample || "Hello, world. This is a translation test.";
    const to = targetCode() === "auto" ? "zh-CN" : targetCode();
    const t0 = Date.now();
    try {
      const ctx = makeCtx(id, { text, to: to === "en" ? "zh-CN" : to, from: "auto" });
      const out = await _runEngine(id, ctx, 20000);
      return { ok: true, engine: id, text: out, latencyMs: Date.now() - t0 };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }

  /** 活动引擎能否实际翻译（用于浮窗按钮可用性判断） */
  function ready(id) {
    const svc = get(id || cfg().active);
    if (!svc) return false;
    if (svc.llm) return !!(typeof AIClient !== "undefined" && AIClient && AIClient.hasKey());
    if (svc.needsSecret) return resolveSecret(svc.id, secretOf(svc.id)).ok;
    return true;
  }

  function isLLM(id) {
    const svc = get(id || cfg().active);
    return !!(svc && svc.llm);
  }

  /** 是否**存在可用的翻译路径**：活动引擎或任一备用引擎就绪。
   *  浮窗/菜单据此决定翻译入口是否可用（与大模型是否就绪解耦）。 */
  function available() {
    const c = cfg();
    const seq = [c.active].concat(Array.isArray(c.fallback) ? c.fallback : []);
    const seen = new Set();
    for (const id of seq) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (ready(id)) return true;
    }
    return false;
  }

  /** 活动引擎不可用时，给一句可执行指引（浮窗/菜单提示用） */
  function unavailableHint() {
    const svc = activeEngine();
    if (svc && svc.llm) {
      return typeof AIClient !== "undefined" && AIClient && AIClient.guidance
        ? AIClient.guidance()
        : "当前翻译引擎需要 AI，但 AI 不可用";
    }
    if (svc && svc.needsSecret) {
      const r = resolveSecret(svc.id, secretOf(svc.id));
      return "翻译引擎「" + svc.name + "」" + (r.error || "未配置");
    }
    return "请在 设置 → Papilot → 翻译引擎 中选择并配置一个翻译引擎";
  }

  function activeEngine() {
    const c = cfg();
    return get(c.active) || null;
  }

  /* ==================== 迁移 ==================== */

  /** 一次性迁移：把 readerPopupTargetLang 的旧显示名值（"中文"）改成规范码 */
  function migrate() {
    try {
      if (!Prefs.get("translateMigrated28", false)) {
        const cur = String(Prefs.get("readerPopupTargetLang", "") || "");
        if (cur && normalizeLang(cur) !== cur) {
          Prefs.set("readerPopupTargetLang", normalizeLang(cur));
        }
        Prefs.set("translateMigrated28", true);
      }
    } catch (e) { /* ignore */ }
    try {
      const raw = Prefs.get("translateCfg", "");
      if (!raw) saveCfg({});
    } catch (e) { /* ignore */ }
    // 0.31.0：默认回退链升级（免密钥阵营加入 edge 并排首位）。**仅当用户从未自定义过**
    // （现存值与旧默认完全一致）才改，避免覆盖用户自己的排序。
    try {
      if (!Prefs.get("translateFallbackUpgraded", false)) {
        const cur = cfg();
        if (JSON.stringify(cur.fallback) === JSON.stringify(["google", "bing", "youdao"])) {
          saveCfg({ fallback: CFG_DEFAULTS.fallback.slice() });
        }
        Prefs.set("translateFallbackUpgraded", true);
      }
    } catch (e) { /* ignore */ }
  }

  /** 供设置界面渲染：全部引擎 + 当前状态 */
  function overview() {
    const c = cfg();
    return {
      cfg: c,
      active: c.active,
      target: targetCode(),
      targetLabel: langLabel(targetCode()),
      source: sourceCode(),
      sourceLabel: langLabel(sourceCode()),
      services: SERVICES.map((s) => {
        const needsSecret = !!s.needsSecret;
        const configured = needsSecret ? resolveSecret(s.id, secretOf(s.id)).ok : true;
        return {
          id: s.id, name: s.name, group: s.group || "free",
          needsSecret, configured, experimental: !!s.experimental,
          docs: s.docs || "", note: s.note || "",
          hint: s.hint || "",
          limits: s.limits || null,
          secretFields: s.secretFields || [],
          secretRaw: secretOf(s.id),
          isLLM: !!s.llm,
          enabled: s.id === c.active,
          inFallback: c.fallback.indexOf(s.id) >= 0,
        };
      }),
      langs: LANGS.slice(),
    };
  }

  return {
    // 语言（子模块 translate-lang.js）
    LANGS, normalizeLang, langMeta, langLabel, langName, langCode,
    // 引擎注册表（子模块 translate-engines.js）与状态判定
    SERVICES, get, list, activeEngine, isLLM, ready, available, unavailableHint, overview,
    // 密钥（复合 "#" 串）
    parseSecret, joinSecret, resolveSecret,
    // 纯构造/解析（测试用）
    makeCtx, buildEndpoint, extractResult,
    // 长文本分段（测试用）：splitText 是纯函数；segmentsFor 是"按引擎上限分段"的入口
    splitText: _splitText, segmentsFor: _segmentsFor, SEG_MAX,
    // 术语表（子模块 translate-glossary.js；0.33.0 纯函数可单测；0.4x 领域化）
    parseGlossary, glossary, glossaryAll, glossaryDomains, activeDomains,
    glossaryBlock, glossaryFingerprint, glossaryStats,
    glossaryToCsv, parseGlossaryImport, mergeGlossary,
    // 行内公式保护（子模块 translate-formula.js；仅非 LLM 引擎启用）
    maskInlineFormulas, unmaskFormulas,
    // 算法（子模块 translate-crypto.js；测试用）
    googleTk, sha1Bytes, hmacSha1, base64, encodeRFC5987, utf8Bytes,
    // 配置
    cfg, saveCfg, setActive, setSecret, secretOf, targetCode, sourceCode, targetName,
    // 运行
    translate, testEngine, clearCache,
    // 失败冷却（0.31.0）
    clearCooldown, cooldownLeft,
    // 本机自建服务探测（0.31.0）
    probeLocal, LOCAL_PROBES,
    // 迁移
    migrate,
  };
})();
