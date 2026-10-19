// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot AI 模型通道管理（0.14.0 新增）
 * 移植自「心血管科药物」项目的统一模型通道管理（model-channels.js），
 * 保持原有功能结构与交互逻辑，适配 Zotero 桌面端：
 * - 通道注册表存 pref aiChannels（JSON）：{channels:[{id,name,provider,baseUrl,apiKey,
 *   model,models[],extraBody{},timeoutMs}], active:"official"}
 *   model = 默认模型；models = 该通道可用模型列表（上游拉取或手动添加）
 * - 厂商预设目录 PROVIDERS（国内主流 OpenAI 兼容厂商 + keyHint 密钥格式识别）
 * - 自动探测 detectChannel()：按 apiKey 格式圈定候选厂商并行探 /models，
 *   或按 baseUrl 直探——与原项目逻辑一致
 * - 探活 testChannel()：小负荷实测调用，返回模型/延迟/应答
 * - 官方通道（official）：登录账号后免费使用；apiKey 由账号会话令牌动态注入，
 *   不可删除；未登录时不可切换为活动通道
 * - 旧版单通道配置 + 配置快照自动迁移为通道（不丢用户数据）
 * 说明：原项目的「连续失败熔断」是服务端多用户保护，桌面单用户场景不适用，
 * 保留「5xx/超时预算内重试一次」的可见行为。
 */
/* global Zotero, Prefs, Account */

var Channels = {
  OFFICIAL_ID: "official",

  /* ----------------------------------------------------------------
   * 厂商预设目录（均为 OpenAI 兼容接口；models 为兜底建议，以实时 /models 为准）
   * keyHint.unique = true 表示密钥格式特异，命中即唯一候选，无需再探其他厂商
   * id 沿用本插件旧版服务商 id（迁移兼容），新增 prism-local/stepfun/baichuan/openai
   * -------------------------------------------------------------- */
  PROVIDERS: [
    { id: "deepseek", name: "DeepSeek 深度求索", baseUrl: "https://api.deepseek.com/v1",
      keyHint: { re: /^sk-/, unique: false },
      models: ["deepseek-chat", "deepseek-reasoner"], note: "" },
    { id: "qwen", name: "通义千问（阿里百炼）", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      keyHint: { re: /^sk-/, unique: false },
      models: ["qwen-plus", "qwen-max", "qwen-turbo", "qwen-long"], note: "百炼兼容模式入口" },
    { id: "glm", name: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      keyHint: { re: /^[A-Za-z0-9-]{6,}\.[A-Za-z0-9_-]{6,}$/, unique: true },
      models: ["glm-4.5", "glm-4-plus", "glm-4-air", "glm-4-flash"], note: "密钥形如 id.secret（中间带点）" },
    { id: "kimi", name: "Kimi（月之暗面）", baseUrl: "https://api.moonshot.cn/v1",
      keyHint: { re: /^sk-/, unique: false },
      models: ["kimi-latest", "moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"], note: "" },
    { id: "doubao", name: "豆包（火山方舟）", baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      keyHint: { re: /^sk-|^[0-9a-f-]{20,}$/i, unique: false },
      models: ["doubao-seed-1-6", "doubao-1-5-pro-32k", "doubao-1-5-lite-32k"],
      note: "model 可填模型 ID 或推理接入点（ep- 开头）" },
    { id: "yi", name: "零一万物", baseUrl: "https://api.lingyiwanwu.com/v1",
      keyHint: { re: /^sk-/, unique: false },
      models: ["yi-large", "yi-medium", "yi-lightning"], note: "" },
    { id: "ernie", name: "文心一言（百度千帆）", baseUrl: "https://qianfan.baidubce.com/v2",
      keyHint: { re: /^sk-|^bce-/, unique: false },
      models: ["ernie-4.0-8k", "ernie-3.5-8k", "ernie-speed-128k"], note: "" },
    { id: "minimax", name: "MiniMax", baseUrl: "https://api.minimaxi.com/v1",
      keyHint: { re: /^eyJ/, unique: true },
      models: ["MiniMax-Text-01", "abab6.5s-chat"], note: "密钥为 JWT 格式（eyJ 开头）" },
    { id: "siliconflow", name: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1",
      keyHint: { re: /^sk-/, unique: false },
      models: ["deepseek-ai/DeepSeek-V3", "Qwen/Qwen2.5-72B-Instruct"],
      note: "聚合平台，模型名形如「厂商/模型」" },
    { id: "spark", name: "讯飞星火", baseUrl: "https://spark-api-open.xf-yun.com/v1",
      keyHint: { re: /^[^:\s]{6,}:[^:\s]{6,}$/, unique: true },
      models: ["generalv3.5", "4.0Ultra"], note: "密钥形如 APIKey:APISecret（含冒号）" },
    { id: "hunyuan", name: "腾讯混元", baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
      keyHint: { re: /^sk-/, unique: false },
      models: ["hunyuan-turbo", "hunyuan-pro", "hunyuan-lite"], note: "" },
    { id: "stepfun", name: "阶跃星辰", baseUrl: "https://api.stepfun.com/v1",
      keyHint: { re: /^sk-/, unique: false },
      models: ["step-3", "step-2-16k", "step-1-8k"], note: "" },
    { id: "baichuan", name: "百川智能", baseUrl: "https://api.baichuan-ai.com/v1",
      keyHint: { re: /^sk-/, unique: false },
      models: ["Baichuan4", "Baichuan3-Turbo"], note: "" },
    { id: "prism-local", name: "Prism 本地网关", baseUrl: "http://127.0.0.1:18790/v1",
      keyHint: { re: /^sk-prism-/i, unique: true },
      models: ["auto"], extraBody: { reasoning_effort: "low" },
      note: '本机 Prism 聚合网关；auto 模型建议配 {"reasoning_effort":"low"}' },
    { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1",
      keyHint: { re: /^sk-/, unique: false },
      models: ["gpt-4o-mini", "gpt-4o"], note: "" },
    { id: "ollama", name: "Ollama（本地）", baseUrl: "http://127.0.0.1:11434/v1",
      keyHint: null, noKey: true, models: [], note: "本地运行，无需 API Key" },
    { id: "custom", name: "自定义 OpenAI 兼容接口", baseUrl: "",
      keyHint: null, custom: true, models: [], note: "填任意 /v1 兼容地址" },
  ],

  providerOf(id) {
    return this.PROVIDERS.find((p) => p.id === id) || null;
  },

  /* ---------- 通道注册表（pref 存储） ---------- */

  _load() {
    let doc = null;
    try { doc = JSON.parse(Prefs.get("aiChannels", "")); } catch (e) { /* ignore */ }
    if (!doc || !Array.isArray(doc.channels)) return { channels: [], active: null };
    return doc;
  },

  _save(doc) {
    Prefs.set("aiChannels", JSON.stringify(doc));
  },

  /** 确保官方通道存在且排在首位（baseUrl 动态跟随账号服务器地址） */
  _ensureOfficial(doc) {
    const idx = doc.channels.findIndex((c) => c && c.id === this.OFFICIAL_ID);
    const official = {
      id: this.OFFICIAL_ID,
      name: "Papilot 官方模型（按额度计费）",
      provider: this.OFFICIAL_ID,
      baseUrl: "", // 运行时取 Account.gatewayUrl()，不落盘防服务器地址变更后过期
      apiKey: "",  // 运行时取登录令牌，绝不落盘
      model: "auto",
      models: ["auto"],
      extraBody: {},
      timeoutMs: 12000,
    };
    if (idx < 0) {
      doc.channels.unshift(official);
    } else {
      // 保留用户对官方通道 model/models/extraBody/timeoutMs 的自定义
      const cur = doc.channels[idx];
      official.model = cur.model || "auto";
      official.models = Array.isArray(cur.models) && cur.models.length ? cur.models : ["auto"];
      official.extraBody = cur.extraBody || {};
      official.timeoutMs = cur.timeoutMs || 12000;
      doc.channels[idx] = official;
    }
    return official;
  },

  /**
   * 面板展示用列表：官方通道置顶 + 运行时状态（available/apiKeyMasked）。
   * 自定义通道密钥脱敏返回（sk-p****OgFS），官方通道显示登录令牌状态。
   */
  list() {
    const doc = this._load();
    const official = this._ensureOfficial(doc);
    const loggedIn = Account.isLoggedIn();
    const out = [{
      id: official.id,
      name: official.name,
      provider: this.OFFICIAL_ID,
      baseUrl: Account.gatewayUrl(),
      model: official.model,
      models: official.models || [],
      extraBody: official.extraBody || {},
      timeoutMs: official.timeoutMs || 12000,
      official: true,
      available: loggedIn,
      apiKeyMasked: loggedIn ? "登录令牌 " + this._mask(Account.token()) : "未登录",
    }];
    for (const c of doc.channels) {
      if (!c || c.id === this.OFFICIAL_ID) continue;
      out.push({
        id: c.id, name: c.name || c.id, provider: c.provider || "",
        baseUrl: c.baseUrl, model: c.model || "auto",
        models: Array.isArray(c.models) ? c.models : [],
        extraBody: c.extraBody || {},
        timeoutMs: c.timeoutMs || 12000,
        official: false,
        available: true,
        apiKeyMasked: this._mask(c.apiKey),
      });
    }
    return { channels: out, active: doc.active };
  },

  getChannel(id) {
    if (id === this.OFFICIAL_ID) {
      const doc = this._load();
      return this._ensureOfficial(doc);
    }
    return this._load().channels.find((c) => c && c.id === id) || null;
  },

  /**
   * AIClient 消费入口：解析活动通道的完整调用配置。
   * 返回 {ok:true, channelId, baseUrl, apiKey, model, extraBody, timeoutMs}
   * 或   {ok:false, reason: "not_logged_in" | "no_key" | "no_active"}
   */
  getActiveConfig() {
    const doc = this._load();
    this._ensureOfficial(doc);
    const id = doc.active;
    if (!id) return { ok: false, reason: "no_active" };
    const c = doc.channels.find((x) => x && x.id === id);
    if (!c) return { ok: false, reason: "no_active" };
    if (c.id === this.OFFICIAL_ID) {
      if (!Account.isLoggedIn()) return { ok: false, reason: "not_logged_in" };
      return {
        ok: true, channelId: this.OFFICIAL_ID,
        baseUrl: Account.gatewayUrl(),
        apiKey: Account.token(),
        model: c.model || "auto",
        extraBody: c.extraBody || {},
        timeoutMs: c.timeoutMs || 12000,
      };
    }
    if (!c.apiKey && !this._providerNoKey(c.provider, c.baseUrl)) {
      return { ok: false, reason: "no_key", channelId: c.id };
    }
    return {
      ok: true, channelId: c.id,
      baseUrl: String(c.baseUrl || "").replace(/\/+$/, ""),
      apiKey: c.apiKey || "",
      model: c.model || "auto",
      extraBody: c.extraBody || {},
      timeoutMs: c.timeoutMs || 12000,
    };
  },

  _providerNoKey(providerId, baseUrl) {
    if (providerId === "ollama") return true;
    // 旧配置可能无 provider：本地地址默认免密（与原项目一致）
    return /127\.0\.0\.1|localhost/.test(String(baseUrl || ""));
  },

  /* ---------- 通道 CRUD（逻辑与原项目 upsert/remove/setActive 一致） ---------- */

  /**
   * 新建/编辑通道。编辑时 apiKey 留空 = 保持原密钥（原项目交互）。
   * 官方通道只允许改 model/models/extraBody/timeoutMs。
   */
  upsert(channel) {
    if (!channel || typeof channel !== "object") return { ok: false, error: "参数缺失" };
    const id = String(channel.id || "").trim();
    if (!/^[a-z0-9-]+$/.test(id)) return { ok: false, error: "通道 id 必填（小写字母/数字/连字符）" };
    const doc = this._load();
    this._ensureOfficial(doc);
    const idx = doc.channels.findIndex((c) => c.id === id);
    const existing = idx >= 0 ? doc.channels[idx] : null;

    if (id === this.OFFICIAL_ID) {
      // 官方通道：只接受模型相关字段，忽略 baseUrl/apiKey/name
      const cur = existing;
      cur.model = String(channel.model || cur.model || "auto");
      cur.models = this._sanitizeModels(channel.models) ?? cur.models;
      cur.extraBody = this._validExtra(channel.extraBody) || cur.extraBody || {};
      cur.timeoutMs = Number(channel.timeoutMs) || cur.timeoutMs || 12000;
      this._save(doc);
      return { ok: true };
    }

    const apiKey = String(channel.apiKey || "") || (existing && existing.apiKey) || "";
    const baseUrl = String(channel.baseUrl || (existing && existing.baseUrl) || "").replace(/\/+$/, "");
    if (!baseUrl && !(existing && existing.baseUrl)) return { ok: false, error: "接口地址 baseUrl 必填" };
    const providerNoKey = this._providerNoKey(channel.provider, baseUrl);
    if (!apiKey && !providerNoKey) return { ok: false, error: "API Key 必填（本地 Ollama 等免密接口除外）" };

    const models = this._sanitizeModels(channel.models);
    const clean = {
      id,
      name: String(channel.name || (existing && existing.name) || id).slice(0, 60),
      provider: channel.provider !== undefined
        ? String(channel.provider || "").slice(0, 40)
        : (existing && existing.provider) || "",
      baseUrl,
      apiKey,
      model: String(channel.model || (existing && existing.model) || "auto"),
      models: models !== undefined ? models : (existing && Array.isArray(existing.models) ? existing.models : []),
      extraBody: this._validExtra(channel.extraBody) || (existing && existing.extraBody) || {},
      timeoutMs: Number(channel.timeoutMs) || (existing && existing.timeoutMs) || 12000,
    };
    if (idx >= 0) doc.channels[idx] = clean; else doc.channels.push(clean);
    if (!doc.active) doc.active = clean.id;
    this._save(doc);
    return { ok: true };
  },

  remove(id) {
    if (id === this.OFFICIAL_ID) return { ok: false, error: "官方通道不可删除" };
    const doc = this._load();
    this._ensureOfficial(doc);
    const idx = doc.channels.findIndex((c) => c && c.id === id);
    if (idx < 0) return { ok: false, error: "通道不存在" };
    doc.channels.splice(idx, 1);
    // 删的是活动通道：回落到官方通道（原项目回落首个；桌面端官方永远可用）
    if (doc.active === id) doc.active = this.OFFICIAL_ID;
    this._save(doc);
    return { ok: true };
  },

  /** 切换活动通道。官方通道未登录时拒绝（模型权限门槛） */
  setActive(id) {
    const doc = this._load();
    this._ensureOfficial(doc);
    if (!doc.channels.some((c) => c && c.id === id)) return { ok: false, error: "通道不存在" };
    if (id === this.OFFICIAL_ID && !Account.isLoggedIn()) {
      return { ok: false, error: "请先登录 Papilot 账号后再使用官方模型（调用从 AI 额度扣费）" };
    }
    doc.active = id;
    this._save(doc);
    return { ok: true };
  },

  /* ---------- 校验与脱敏 ---------- */

  /** 模型列表清洗：字符串化/去空白/去重/限量；非数组返回 undefined（表示不改动） */
  _sanitizeModels(list) {
    if (!Array.isArray(list)) return undefined;
    const out = [];
    for (const m of list) {
      const s = String(m == null ? "" : m).trim();
      if (s && s.length <= 120 && !out.includes(s)) out.push(s);
      if (out.length >= 200) break;
    }
    return out;
  },

  /** extraBody 必须是普通对象（JSON 对象），其余返回 null */
  _validExtra(extra) {
    if (!extra || typeof extra !== "object" || Array.isArray(extra)) return null;
    return extra;
  },

  /** 密钥脱敏：sk-prism-...OgFS → sk-p****OgFS */
  _mask(key) {
    const k = String(key || "");
    if (!k) return "";
    if (k.length <= 8) return "****";
    return k.slice(0, 4) + "****" + k.slice(-4);
  },

  /* ---------- 上游探测（原项目 fetchModels/detectChannel 移植） ---------- */

  /** GET {baseUrl}/models → {ok:true, models[], latencyMs} 或 {ok:false, error}；永不抛异常 */
  async fetchModels({ baseUrl, apiKey, timeoutMs }) {
    const t0 = Date.now();
    const bu = String(baseUrl || "").trim().replace(/\/+$/, "");
    let url;
    try { url = new URL(bu + "/models"); } catch (e) { return { ok: false, error: "接口地址格式非法" }; }
    const headers = { "Accept": "application/json" };
    if (apiKey) headers["Authorization"] = "Bearer " + apiKey;
    let req;
    try {
      req = await Zotero.HTTP.request("GET", url.href, {
        headers, responseType: "json", timeout: timeoutMs || 8000,
      });
    } catch (e) {
      return { ok: false, error: this._netError(e) };
    }
    let data = req.response;
    if (!data && req.responseText) {
      try { data = JSON.parse(req.responseText); } catch (e) { /* 非 JSON 应答 */ }
    }
    if (req.status >= 400) {
      const hint = req.status === 401 || req.status === 403 ? "（密钥无效或无权限）" : "";
      return { ok: false, error: "HTTP " + req.status + hint };
    }
    const raw = Array.isArray(data && data.data) ? data.data
      : (Array.isArray(data && data.models) ? data.models : []);
    const models = [];
    for (const m of raw) {
      const s = typeof m === "string" ? m : String((m && (m.id || m.name)) || "").trim();
      if (s && !models.includes(s)) models.push(s);
      if (models.length >= 300) break;
    }
    if (!models.length) return { ok: false, error: "上游未返回任何模型" };
    return { ok: true, models, latencyMs: Date.now() - t0 };
  },

  /** 按密钥格式圈定候选厂商（有序，特异格式优先且唯一）——原项目 candidatesByKey */
  candidatesByKey(apiKey) {
    const k = String(apiKey || "").trim();
    if (!k) return [];
    const uniq = this.PROVIDERS.filter((p) => p.keyHint && p.keyHint.unique && p.keyHint.re.test(k));
    if (uniq.length) return uniq;
    const generic = this.PROVIDERS.filter((p) => p.keyHint && !p.keyHint.unique && p.keyHint.re.test(k));
    if (generic.length) return generic;
    return this.PROVIDERS.filter((p) => !p.custom && p.baseUrl && !/127\.0\.0\.1|localhost/.test(p.baseUrl));
  },

  /**
   * 自动探测通道（原项目 detectChannel 逻辑）：
   * - 给了 baseUrl：直探该地址 /models，并与预设目录比对识别厂商
   * - 只有 apiKey：按密钥格式圈定候选厂商，并行探 /models，首个应答者胜出
   * 返回 {ok, provider, providerName, baseUrl, models, latencyMs?, error?}
   */
  async detectChannel({ apiKey, baseUrl, timeoutMs }) {
    const key = String(apiKey || "").trim();
    const bu = String(baseUrl || "").trim().replace(/\/+$/, "");
    if (!key && !bu) return { ok: false, error: "apiKey 与 baseUrl 至少填一项" };

    if (bu) {
      const preset = this.PROVIDERS.find((p) => p.baseUrl &&
        (bu === p.baseUrl || bu.startsWith(p.baseUrl + "/") || p.baseUrl.startsWith(bu + "/")));
      const r = await this.fetchModels({ baseUrl: bu, apiKey: key, timeoutMs });
      if (!r.ok) return { ok: false, error: r.error, provider: preset ? preset.id : "custom", baseUrl: bu, models: [] };
      return {
        ok: true,
        provider: preset ? preset.id : "custom",
        providerName: preset ? preset.name : "自定义接口",
        baseUrl: bu, models: r.models, latencyMs: r.latencyMs,
      };
    }

    const cands = this.candidatesByKey(key).slice(0, 10);
    if (!cands.length) return { ok: false, error: "无法根据密钥格式识别厂商，请手动填写接口地址" };
    const results = await Promise.all(cands.map(async (p) => {
      const r = await this.fetchModels({ baseUrl: p.baseUrl, apiKey: key, timeoutMs: timeoutMs || 8000 });
      return r.ok ? { provider: p, models: r.models, latencyMs: r.latencyMs } : null;
    }));
    const matches = results.filter(Boolean);
    if (!matches.length) {
      const uniqueHit = cands.length === 1 && cands[0].keyHint && cands[0].keyHint.unique;
      return {
        ok: false, tried: cands.map((p) => p.id),
        provider: uniqueHit ? cands[0].id : "",
        error: uniqueHit
          ? "密钥格式像「" + cands[0].name + "」但探测失败（密钥无效/欠费/网络不可达），已按该厂商预填，可手动修正"
          : "所有候选厂商探测均失败（密钥无效或网络不可达），请手动填写接口地址",
      };
    }
    const best = matches[0];
    return {
      ok: true,
      provider: best.provider.id,
      providerName: best.provider.name,
      baseUrl: best.provider.baseUrl,
      models: best.models,
      latencyMs: best.latencyMs,
      matches: matches.map((m) => m.provider.id),
    };
  },

  /* ---------- 探活：小负荷实测一次调用（原项目 testChannel） ---------- */

  /** 按 id 解析单通道调用配置（不依赖活动通道状态；官方通道动态注入登录令牌） */
  _channelConfig(id) {
    const c = this.getChannel(id);
    if (!c) return null;
    if (c.id === this.OFFICIAL_ID) {
      if (!Account.isLoggedIn()) return { blocked: "not_logged_in" };
      return {
        ok: true, channelId: this.OFFICIAL_ID,
        baseUrl: Account.gatewayUrl(), apiKey: Account.token(),
        model: c.model || "auto", extraBody: c.extraBody || {}, timeoutMs: c.timeoutMs || 12000,
      };
    }
    if (!c.apiKey && !this._providerNoKey(c.provider, c.baseUrl)) {
      return { blocked: "no_key" };
    }
    return {
      ok: true, channelId: c.id,
      baseUrl: String(c.baseUrl || "").replace(/\/+$/, ""),
      apiKey: c.apiKey || "", model: c.model || "auto",
      extraBody: c.extraBody || {}, timeoutMs: c.timeoutMs || 12000,
    };
  },

  async testChannel(id) {
    const cfg = this._channelConfig(id);
    if (!cfg) return { ok: false, error: "通道不存在" };
    if (cfg.blocked) {
      return { ok: false, error: cfg.blocked === "not_logged_in" ? "未登录：官方通道需要登录后使用" : "该通道缺少 API Key" };
    }
    const t0 = Date.now();
    const body = {
      model: cfg.model,
      messages: [
        { role: "system", content: "你是连通性测试助手，用一句中文回答。" },
        { role: "user", content: "请回复：通道正常" },
      ],
      temperature: 0.4,
      max_tokens: 120,
      ...(cfg.extraBody || {}),
    };
    // 预算内重试一次（5xx/超时/网络抖动；与原项目降级链一致）
    const budget = cfg.timeoutMs || 12000;
    const deadline = Date.now() + budget;
    let r = await this._chatOnce(cfg, body, t0, budget);
    if (r.error && r.retryable && deadline - Date.now() >= 800) {
      await new Promise((ok) => setTimeout(ok, 350));
      r = await this._chatOnce(cfg, body, t0, deadline - Date.now());
    }
    if (r.error) return { ok: false, error: r.error, channelId: cfg.channelId };
    return { ok: true, channelId: cfg.channelId, model: r.model, latencyMs: r.latencyMs, reply: (r.text || "").slice(0, 60) };
  },

  /** 单次小负荷调用；返回 {text, model, latencyMs} 或 {error, retryable} */
  async _chatOnce(c, body, t0, timeoutMs) {
    const url = String(c.baseUrl || "").replace(/\/+$/, "") + "/chat/completions";
    let req;
    try {
      req = await Zotero.HTTP.request("POST", url, {
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + (c.apiKey || ""),
        },
        body: JSON.stringify(body),
        responseType: "json",
        timeout: timeoutMs || 12000,
      });
    } catch (e) {
      const status = e && e.xmlhttp && e.xmlhttp.status;
      return {
        error: status ? this._httpErrorText(c, status) : this._netError(e),
        retryable: !status || status >= 500 || status === 429,
      };
    }
    let data = req.response;
    if (!data && req.responseText) {
      try { data = JSON.parse(req.responseText); } catch (e) { return { error: "应答不是合法 JSON", retryable: true }; }
    }
    if (req.status >= 400) {
      return { error: this._httpErrorText(c, req.status), retryable: req.status >= 500 || req.status === 429 };
    }
    const msg = data && data.choices && data.choices[0] && data.choices[0].message;
    const text = msg && msg.content ? String(msg.content).trim() : "";
    if (!text) return { error: "模型返回内容为空", retryable: true };
    return { text, model: data.model || c.model, latencyMs: Date.now() - t0 };
  },

  /** 实测/探测的 HTTP 错误文案：官方通道 401 = 登录令牌失效（网关自身语义），
   *  与自定义通道的「密钥无效」区分开——官方通道用户手里没有密钥，文案不能误导。 */
  _httpErrorText(c, status) {
    if (status === 401 && c && c.channelId === this.OFFICIAL_ID) {
      return "HTTP 401（登录状态已过期，请重新登录账号）";
    }
    return "HTTP " + status + (status === 401 || status === 403 ? "（密钥无效或未授权）" : "");
  },

  _netError(e) {
    const msg = (e && e.message) || String(e);
    if (/timed?\s*out|timeout/i.test(msg)) return "连接超时";
    if (/CONNECTION_REFUSED|connection refused/i.test(msg)) return "无法连接（服务未启动或地址不对）";
    return "网络错误：" + msg.slice(0, 120);
  },

  /* ---------- 旧版配置迁移（一次性，不丢数据） ---------- */

  /**
   * 旧版「单通道 + 配置快照」→ 通道体系：
   * - 现行 aiBaseUrl/aiApiKey/aiModel 配置 → 一条「原配置」通道（有 Key 才迁）
   * - aiProfiles 快照逐条 → 通道
   * - 无任何配置 → 仅官方通道（active=official，登录即用）
   * 幂等：已有通道数据（aiChannels 非空）则只确保官方通道存在。
   */
  migrateLegacy() {
    let doc = null;
    try { doc = JSON.parse(Prefs.get("aiChannels", "")); } catch (e) { /* ignore */ }
    if (doc && Array.isArray(doc.channels) && doc.channels.length) {
      this._ensureOfficial(doc);
      this._save(doc);
      return;
    }

    doc = { channels: [], active: null };
    let legacyActive = null;

    // 1) 现行配置（有 Key 才值得迁移；0.13.2 默认 account+空 Key 直接跳过）
    const key = String(Prefs.get("aiApiKey", "") || "").trim();
    const base = String(Prefs.get("aiBaseUrl", "") || "").trim();
    if (key && base) {
      const providerId = String(Prefs.get("aiProvider", "") || "");
      const isGateway = providerId === "account" || base === Account.gatewayUrl() || base === this.SERVER_DEFAULT_BASE;
      doc.channels.push({
        id: isGateway ? "account-key" : "legacy-main",
        name: isGateway ? "账号网关（个人 Key）" : "原配置（0.13 迁移）",
        provider: isGateway ? "custom" : (this.providerOf(providerId) ? providerId : "custom"),
        baseUrl: base.replace(/\/+$/, ""),
        apiKey: key,
        model: String(Prefs.get("aiModel", "") || "auto"),
        models: [],
        extraBody: {},
        timeoutMs: 12000,
      });
      legacyActive = doc.channels[0].id;
    }

    // 2) 配置快照 → 通道（快照体系由通道列表取代）
    let profiles = [];
    try { profiles = JSON.parse(Prefs.get("aiProfiles", "[]")) || []; } catch (e) { /* ignore */ }
    for (const p of profiles) {
      if (!p || !p.name || !p.base || !p.key) continue;
      let id = this._slug(p.name);
      if (doc.channels.some((c) => c.id === id)) id = id + "-2";
      doc.channels.push({
        id, name: p.name,
        provider: this.providerOf(p.provider) ? p.provider : "custom",
        baseUrl: String(p.base).replace(/\/+$/, ""),
        apiKey: String(p.key),
        model: String(p.model || "auto"),
        models: [], extraBody: {}, timeoutMs: 12000,
      });
    }

    // 3) 官方通道置顶；活动通道：有可用旧配置沿用之，否则官方
    this._ensureOfficial(doc);
    doc.active = legacyActive || this.OFFICIAL_ID;
    this._save(doc);
    try { Zotero.debug("Papilot: channels migrated, n=" + doc.channels.length + " active=" + doc.active); } catch (e) { /* ignore */ }
  },

  SERVER_DEFAULT_BASE: "http://127.0.0.1:8000/v1",

  _slug(name) {
    const s = String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return s || "ch";
  },
};
