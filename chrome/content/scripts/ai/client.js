// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot AI 客户端：OpenAI 兼容接口（/chat/completions）
 * 兼容 OpenAI / DeepSeek / 通义 / 月之暗面 / SiliconFlow / 本地网关等
 * 0.14.0：配置改由「AI 模型通道」体系提供（Channels.getActiveConfig），
 * 官方通道需登录账号（未登录给出明确指引）；通道 extraBody 并入请求；
 * 官方通道 401 自动失效会话并提醒重新登录。Channels 缺位时兜底旧 pref。
 * 0.15.1：官方通道调用成功 → Account.touchSession() 本地滑动续期（30 天，
 * 与服务端网关续期对齐）；仅 401 清会话，403（WAF/反代拦截）不清。
 */
/* global Zotero, Prefs, Channels, Account, fetch, AbortController, TextDecoder, setTimeout, clearTimeout */

var AIClient = {
  /**
   * 解析当前调用配置（每次调用时读取，通道切换即时生效）。
   * 返回 {ok:true, channelId, baseUrl, apiKey, model, extraBody}
   * 或 {notLoggedIn:true}（官方通道未登录）/ {noKey:true}（无任何可用配置）
   */
  _config() {
    if (typeof Channels !== "undefined" && Channels) {
      const cfg = Channels.getActiveConfig();
      if (cfg.ok) return cfg;
      if (cfg.reason === "not_logged_in") return { notLoggedIn: true };
      if (cfg.reason === "no_key") return { noKey: true };
      // no_active：理论上不会发生（官方通道恒存在），兜底走旧 pref
    }
    const base = (Prefs.get("aiBaseUrl", "") || "").replace(/\/+$/, "");
    const key = Prefs.get("aiApiKey", "");
    if (base && key) {
      return {
        ok: true, channelId: "legacy",
        baseUrl: base, apiKey: key,
        model: Prefs.get("aiModel", "") || "auto",
        extraBody: {},
      };
    }
    return { noKey: true };
  },

  /** AI 是否就绪（官方通道未登录视为未就绪；本地免密接口视为就绪） */
  hasKey() {
    const c = this._config();
    return !c.notLoggedIn && !c.noKey && !!c.ok;
  },

  /**
   * 就绪状态的**可读原因**（0.21.0）：调用点据此给出精确指引，避免
   * 「未登录」与「没填 Key」被同一条笼统提示盖住——这正是历史投诉
   * 「AI 翻译没反应/只说没 Key」的根因。
   * @returns {"ok"|"not_logged_in"|"no_key"}
   */
  status() {
    if (this.hasKey()) return "ok";
    const c = this._config();
    if (c && c.notLoggedIn) return "not_logged_in";
    return "no_key";
  },

  /** 未就绪原因 → 用户可执行的指引文案（I18n 表） */
  guidance() {
    const s = this.status();
    if (s === "not_logged_in") return typeof I18n !== "undefined" ? I18n.t("chatNotLoggedIn") : "";
    if (s === "no_key") return typeof I18n !== "undefined" ? I18n.t("chatNoKeyConfigured") : "";
    return "";
  },

  baseUrl() {
    const c = this._config();
    return c.ok ? c.baseUrl : "";
  },

  model() {
    const c = this._config();
    return c.ok ? c.model : "";
  },

  /** 官方通道未登录的统一提示（34 项功能的 catch 链都能直接展示这条消息） */
  _notLoggedInError() {
    return new Error("官方模型需要登录：请在 设置 → Papilot 登录账号（调用从 AI 额度扣费），或在「AI 模型通道」中配置自己的接口");
  },

  /** 官方通道鉴权失败：异步失效会话 + 弹窗，不阻塞当前错误返回。
   *  0.15.1：仅 401（令牌确实无效）触发；403 多为 WAF/反代拦截，不清会话。
   *  1.8.x 起再收紧：必须应答体确为网关自身的「登录已过期」才清会话——
   *  旧版服务端会把**上游通道**的 401 原样透传（密钥失效/模型未授权），
   *  那种 401 与用户登录态无关，清会话会造成「切个模型就整个插件掉登录」。 */
  _maybeAuthFailure(status, bodyText) {
    if (status !== 401) return;
    if (typeof Account === "undefined" || !Account) return;
    if (String(bodyText || "").indexOf("登录已过期") < 0) return;
    try {
      Account.handleAuthFailure("官方模型请求被拒绝（HTTP " + status + "）").catch(() => {});
    } catch (e) { /* ignore */ }
  },

  /** 官方通道调用成功（0.15.1）：本地会话滑动续期，与服务端网关续期对齐 */
  _touchOfficialSession(cfg) {
    if (!cfg || cfg.channelId !== "official") return;
    try {
      if (typeof Account !== "undefined" && Account && Account.touchSession) Account.touchSession();
    } catch (e) { /* 续期失败不影响 AI 调用 */ }
  },

  _endpoint(cfg) {
    return String(cfg.baseUrl || "").replace(/\/+$/, "") + "/chat/completions";
  },

  /**
   * 采样参数（0.48.0 起含可选 top_p）：temperature / max_tokens 恒定传入；
   * top_p 仅在用户显式设置时携带（部分网关对未知字段报错，空 = 不传）。
   */
  _sampleParams() {
    const temperature = Number(Prefs.get("aiTemperature", 0.3));
    const out = {
      temperature: isNaN(temperature) ? 0.3 : Math.min(2, Math.max(0, temperature)),
      max_tokens: Number(Prefs.get("aiMaxTokens", 4096)) || 4096,
    };
    let topP = "";
    try { topP = Prefs.get("aiTopP", ""); } catch (e) { topP = ""; }
    const tp = (topP === "" || topP === null || topP === undefined) ? NaN : Number(topP);
    if (!isNaN(tp)) out.top_p = Math.min(1, Math.max(0, tp));
    return out;
  },

  /**
   * @param {Array<{role:string, content:string}>} messages
   * @param {{model?:string}=} opts 可选覆盖项（仅 model：Agent 决策轮路由用）
   * @returns {Promise<string>} 助手回复文本
   */
  async chat(messages, opts) {
    const cfg = this._config();
    if (cfg.notLoggedIn) throw this._notLoggedInError();
    if (!cfg.ok || !cfg.apiKey && !this._noKeyLocal(cfg)) throw new Error("NO_API_KEY");

    const payload = {
      model: opts && opts.model ? String(opts.model) : cfg.model,
      messages,
      ...this._sampleParams(),
      ...(cfg.extraBody || {}),
    };

    let req;
    try {
      req = await Zotero.HTTP.request("POST", this._endpoint(cfg), {
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + (cfg.apiKey || ""),
        },
        body: JSON.stringify(payload),
        responseType: "json",
        timeout: 180000,
      });
    } catch (e) {
      const status = e && e.xmlhttp && e.xmlhttp.status;
      if (cfg.channelId === "official") {
        // 取应答体判别「网关自身的登录失效」还是「上游 401 透传」（后者不清会话）
        let bodyText = "";
        try {
          const r = e.xmlhttp && e.xmlhttp.response;
          bodyText = typeof r === "string" ? r : (r ? JSON.stringify(r) : (e.xmlhttp.responseText || ""));
        } catch (_) { /* ignore */ }
        this._maybeAuthFailure(status, bodyText);
      }
      throw this._wrapError(e);
    }

    const data = req.response;
    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : "";
    if (!content) throw new Error("AI 返回内容为空");
    this._touchOfficialSession(cfg);
    return content;
  },

  /** 免密本地接口（Ollama 等）：无 Key 但可调用 */
  _noKeyLocal(cfg) {
    return /127\.0\.0\.1|localhost/.test(String(cfg.baseUrl || ""));
  },

  /**
   * 流式问答（0.10.0 新增）：fetch + 手工 SSE 解析。
   * Zotero.HTTP 不支持流式，必须走 bootstrap 作用域的 fetch（Z7 FF115+/Z10 均有）。
   * 网关不透传 SSE 时自动降级为一次性读取，用户体验与 chat() 一致，不会更差。
   * @param messages 同 chat()
   * @param onDelta (textChunk) => void 每收到一段增量即回调
   * @param {{model?:string}=} opts 同 chat()（仅 model 覆盖；缺省不影响既有调用）
   * @returns {{promise: Promise<string>, abort: Function}} promise 解析为完整回复
   */
  chatStream(messages, onDelta, opts) {
    const controller = (typeof AbortController === "function") ? new AbortController() : null;
    const promise = this._streamImpl(messages, onDelta, controller, opts);
    return {
      promise,
      abort() { try { if (controller) controller.abort(); } catch (e) { /* ignore */ } },
    };
  },

  async _streamImpl(messages, onDelta, controller, opts) {
    const cfg = this._config();
    if (cfg.notLoggedIn) throw this._notLoggedInError();
    if (!cfg.ok || !cfg.apiKey && !this._noKeyLocal(cfg)) throw new Error("NO_API_KEY");

    // 流式总开关 / fetch 不可用：整体回退非流式（走完再一次性回调）
    const wantStream = Prefs.get("readerPopupStream", true) !== false &&
      typeof fetch === "function" && !!controller;
    if (!wantStream) {
      const full = await this.chat(messages, opts);
      if (onDelta) try { onDelta(full); } catch (e) { /* UI 回调不得拖死流程 */ }
      return full;
    }

    const payload = {
      model: opts && opts.model ? String(opts.model) : cfg.model,
      messages,
      ...this._sampleParams(),
      stream: true,
      ...(cfg.extraBody || {}),
    };

    // 首字节 30s（防非流式网关挂死）+ 总计 180s（与 chat() 对齐）。
    // FF115 没有 signal.reason，用标志位区分超时与外部 abort。
    let timedOut = false;
    const firstByteTimer = setTimeout(() => {
      timedOut = "first";
      try { controller.abort(); } catch (e) { /* ignore */ }
    }, 30000);
    const totalTimer = setTimeout(() => {
      timedOut = "total";
      try { controller.abort(); } catch (e) { /* ignore */ }
    }, 180000);
    const clearTimers = () => { clearTimeout(firstByteTimer); clearTimeout(totalTimer); };

    try {
      const resp = await fetch(this._endpoint(cfg), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + (cfg.apiKey || ""),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!resp.ok) {
        let detail = "";
        try {
          const txt = await resp.text();
          if (cfg.channelId === "official") this._maybeAuthFailure(resp.status, txt);
          try {
            const j = JSON.parse(txt);
            detail = (j && j.error && (j.error.message || j.error)) || txt;
          } catch (e) { detail = txt; }
        } catch (e) { /* ignore */ }
        throw this._httpStatusError(resp.status, detail);
      }

      // 网关不透传 SSE：按普通 JSON 一次性读取，降级但行为正确
      const ctype = resp.headers.get("content-type") || "";
      if (!ctype.includes("event-stream") || !resp.body) {
        const data = await resp.json();
        const content = data && data.choices && data.choices[0] && data.choices[0].message
          ? data.choices[0].message.content : "";
        if (!content) throw new Error("AI 返回内容为空");
        if (onDelta) try { onDelta(content); } catch (e) { /* ignore */ }
        return content;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buf = "";
      let full = "";
      let gotFirst = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!gotFirst) { gotFirst = true; clearTimeout(firstByteTimer); }
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          try {
            const j = JSON.parse(data);
            const delta = j.choices && j.choices[0] && j.choices[0].delta &&
              j.choices[0].delta.content;
            if (delta) {
              full += delta;
              if (onDelta) try { onDelta(delta); } catch (e) { /* ignore */ }
            }
          } catch (e) { /* 半帧 JSON 忽略，等下一帧拼齐 */ }
        }
      }
      if (!full) throw new Error("AI 返回内容为空");
      this._touchOfficialSession(cfg);
      return full;
    } catch (e) {
      clearTimers();
      if (controller.signal.aborted) {
        if (timedOut) throw new Error("AI 请求失败：请求超时");
        throw new Error("ABORTED"); // 外部主动取消：调用方静默处理
      }
      if (e && e._ppWrapped) throw e;
      throw this._wrapError(e);
    } finally {
      clearTimers();
    }
  },

  /** fetch 流式路径的 HTTP 状态错误（与 _wrapError 文案对齐） */
  _httpStatusError(status, detail) {
    detail = String(detail || "").slice(0, 300);
    let msg;
    if (status === 401 || status === 403) msg = `API Key 无效或未授权（HTTP ${status}）`;
    else if (status === 429) msg = "请求过于频繁或额度不足（HTTP 429）";
    else msg = `HTTP ${status}`;
    const err = new Error(`AI 请求失败：${msg}${detail ? "（" + detail + "）" : ""}`);
    err._ppWrapped = true;
    return err;
  },

  /** 把 Zotero.HTTP 异常翻译为可读错误 */
  _wrapError(e) {
    let detail = "";
    try {
      const resp = e.xmlhttp && e.xmlhttp.response;
      detail = (resp && resp.error && (resp.error.message || resp.error)) || e.xmlhttp.responseText || "";
    } catch (_) { /* ignore */ }
    if (typeof detail !== "string") detail = "";
    detail = detail.slice(0, 300);

    let msg = (e && e.message) || String(e);
    const status = e && e.xmlhttp && e.xmlhttp.status;
    if (/timed?\s*out|timeout/i.test(msg)) msg = "请求超时";
    else if (status === 401 || status === 403) msg = `API Key 无效或未授权（HTTP ${status}）`;
    else if (status === 429) msg = "请求过于频繁或额度不足（HTTP 429）";
    else if (status) msg = `HTTP ${status}`;

    return new Error(`AI 请求失败：${msg}${detail ? "（" + detail + "）" : ""}`);
  },
};
