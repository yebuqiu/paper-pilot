// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 国产大模型接入增强（0.5.0 新增）
 * - 12 家国产/本地服务商目录 + 自定义 OpenAI 兼容接口
 * - 输入 API Key 自动探测上游服务商（并发请求各 /models，首个授权成功即上游）
 * - 模型下拉（探测结果）+ 自定义模型名
 * - 配置快照（profiles）：保存多套配置，一键切换
 * 设置面板脚本经 Zotero.Papilot.providers 访问本模块（面板脚本访问不到 bootstrap 作用域）。
 */
/* global Zotero, Prefs */

var AIProviders = {
  PROVIDERS: [
    // 0.13.2: 账号系统网关(本地) - 统一多模型入口, Key 在账号系统个人中心生成
    // /v1/models 自动返回可用模型(auto + 各渠道模型); model 支持:
    //   auto / 纯模型名(默认渠道透传) / provider:model 指定渠道
    { id: "account", name: "Papilot 账号系统（本地网关）",
      base: "http://127.0.0.1:8000/v1", models: ["auto"] },
    { id: "deepseek", name: "DeepSeek 深度求索", base: "https://api.deepseek.com/v1",
      models: ["deepseek-chat", "deepseek-reasoner"] },
    { id: "qwen", name: "通义千问（阿里百炼）", base: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      models: ["qwen-plus", "qwen-max", "qwen-turbo", "qwen-long", "qwen3-235b-a22b"] },
    { id: "glm", name: "智谱 GLM", base: "https://open.bigmodel.cn/api/paas/v4",
      models: ["glm-4-plus", "glm-4-air", "glm-4-flash", "glm-4.5", "glm-4.5-air"] },
    { id: "kimi", name: "Kimi（月之暗面）", base: "https://api.moonshot.cn/v1",
      models: ["kimi-k2-0905-preview", "moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"] },
    { id: "doubao", name: "豆包（火山方舟）", base: "https://ark.cn-beijing.volces.com/api/v3",
      models: ["doubao-pro-32k", "doubao-lite-32k", "doubao-1.5-pro-32k"] },
    { id: "yi", name: "零一万物", base: "https://api.lingyiwanwu.com/v1",
      models: ["yi-large", "yi-medium", "yi-lightning"] },
    { id: "ernie", name: "文心一言（百度千帆）", base: "https://qianfan.baidubce.com/v2",
      models: ["ernie-4.0-8k", "ernie-3.5-8k", "ernie-speed-128k"] },
    { id: "minimax", name: "MiniMax", base: "https://api.minimaxi.com/v1",
      models: ["MiniMax-Text-01", "abab6.5s-chat"] },
    { id: "siliconflow", name: "硅基流动", base: "https://api.siliconflow.cn/v1",
      models: ["deepseek-ai/DeepSeek-V3", "Qwen/Qwen2.5-72B-Instruct", "Qwen/Qwen2.5-7B-Instruct"] },
    { id: "spark", name: "讯飞星火", base: "https://spark-api-open.xf-yun.com/v1",
      models: ["generalv3.5", "4.0Ultra"] },
    { id: "hunyuan", name: "腾讯混元", base: "https://api.hunyuan.cloud.tencent.com/v1",
      models: ["hunyuan-turbo", "hunyuan-standard"] },
    { id: "ollama", name: "Ollama（本地）", base: "http://127.0.0.1:11434/v1",
      models: [], noKey: true },
    { id: "custom", name: "自定义 OpenAI 兼容接口", base: "", models: [], custom: true },
  ],

  getProvider(id) {
    return this.PROVIDERS.find((p) => p.id === id) || null;
  },

  /** 探测某个 base 的 /models，成功返回模型 id 数组 */
  async probeModels(base, apiKey, timeoutMs) {
    const url = String(base || "").replace(/\/+$/, "") + "/models";
    const headers = {};
    if (apiKey) headers["Authorization"] = "Bearer " + apiKey;
    const req = await Zotero.HTTP.request("GET", url, {
      headers, responseType: "json", timeout: timeoutMs || 8000,
    });
    const data = req.response && req.response.data;
    if (!Array.isArray(data)) throw new Error("响应缺少 data 数组");
    return data.map((m) => m && m.id).filter(Boolean);
  },

  /**
   * 输入 API Key 自动探测上游服务商：并发探测候选 /models，任一成功即返回。
   * customBase 提供时只探测自定义地址。
   * @returns {Promise<{provider, base, models: string[]}>}
   */
  async detectProvider(apiKey, customBase) {
    if (customBase) {
      const models = await this.probeModels(customBase, apiKey, 10000);
      return { provider: this.getProvider("custom"), base: customBase, models };
    }
    const candidates = this.PROVIDERS.filter((p) => !p.custom && p.base);
    const attempts = candidates.map((p) =>
      this.probeModels(p.base, p.noKey ? "" : apiKey, 8000)
        .then((models) => ({ provider: p, base: p.base, models }))
    );
    try {
      return await Promise.any(attempts);
    } catch (e) {
      throw new Error("所有候选服务商均探测失败（Key 无效、网络不可达或非兼容接口）");
    }
  },

  /** 对话接口连通性测试，返回实际响应的模型标识 */
  async testChat(base, apiKey, model) {
    const url = String(base || "").replace(/\/+$/, "") + "/chat/completions";
    const req = await Zotero.HTTP.request("POST", url, {
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      }),
      responseType: "json",
      timeout: 30000,
    });
    return (req.response && (req.response.model || req.response.id)) || model;
  },

  /** 应用配置到 Papilot（AIClient 直接消费这些 pref，全部 AI 功能即时生效） */
  apply({ base, apiKey, model, providerId }) {
    Prefs.set("aiBaseUrl", base);
    Prefs.set("aiApiKey", apiKey || "");
    Prefs.set("aiModel", model);
    if (providerId !== undefined) Prefs.set("aiProvider", providerId);
    Zotero.debug(`Papilot: applied provider config base=${base} model=${model}`);
  },

  /* ---------- 配置快照 ---------- */

  getProfiles() {
    try { return JSON.parse(Prefs.get("aiProfiles", "[]")) || []; } catch (e) { return []; }
  },

  _saveProfiles(list) {
    Prefs.set("aiProfiles", JSON.stringify(list || []));
  },

  addProfile(name, cfg) {
    const list = this.getProfiles().filter((p) => p.name !== name);
    list.push({
      name,
      base: cfg.base, key: cfg.key, model: cfg.model,
      provider: cfg.provider || "",
    });
    this._saveProfiles(list);
    return list;
  },

  removeProfile(name) {
    const list = this.getProfiles().filter((p) => p.name !== name);
    this._saveProfiles(list);
    return list;
  },

  /** 应用指定快照，返回是否成功 */
  applyProfile(name) {
    const p = this.getProfiles().find((x) => x.name === name);
    if (!p) return false;
    this.apply({ base: p.base, apiKey: p.key, model: p.model, providerId: p.provider });
    return true;
  },
};
