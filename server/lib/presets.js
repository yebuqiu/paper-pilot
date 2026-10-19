// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 账号后台 · 厂商预设目录
 * 与插件端 chrome/content/scripts/ai/channels.js 的 PROVIDERS 同源维护：
 * 新增厂商时两处同步。keyHint.unique = true 表示密钥格式特异，
 * 命中即唯一候选；models 为兜底建议，以实时 /models 为准。
 */
'use strict';

const PROVIDERS = [
  { id: 'deepseek', name: 'DeepSeek 深度求索', baseUrl: 'https://api.deepseek.com/v1',
    keyHint: { re: /^sk-/, unique: false },
    models: ['deepseek-chat', 'deepseek-reasoner'], note: '' },
  { id: 'qwen', name: '通义千问（阿里百炼）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    keyHint: { re: /^sk-/, unique: false },
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen-long'], note: '百炼兼容模式入口' },
  { id: 'glm', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    keyHint: { re: /^[A-Za-z0-9-]{6,}\.[A-Za-z0-9_-]{6,}$/, unique: true },
    models: ['glm-4.5', 'glm-4-plus', 'glm-4-air', 'glm-4-flash'], note: '密钥形如 id.secret（中间带点）' },
  { id: 'kimi', name: 'Kimi（月之暗面）', baseUrl: 'https://api.moonshot.cn/v1',
    keyHint: { re: /^sk-/, unique: false },
    models: ['kimi-latest', 'moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'], note: '' },
  { id: 'doubao', name: '豆包（火山方舟）', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    keyHint: { re: /^sk-|^[0-9a-f-]{20,}$/i, unique: false },
    models: ['doubao-seed-1-6', 'doubao-1-5-pro-32k', 'doubao-1-5-lite-32k'],
    note: 'model 可填模型 ID 或推理接入点（ep- 开头）' },
  { id: 'yi', name: '零一万物', baseUrl: 'https://api.lingyiwanwu.com/v1',
    keyHint: { re: /^sk-/, unique: false },
    models: ['yi-large', 'yi-medium', 'yi-lightning'], note: '' },
  { id: 'ernie', name: '文心一言（百度千帆）', baseUrl: 'https://qianfan.baidubce.com/v2',
    keyHint: { re: /^sk-|^bce-/, unique: false },
    models: ['ernie-4.0-8k', 'ernie-3.5-8k', 'ernie-speed-128k'], note: '' },
  { id: 'minimax', name: 'MiniMax', baseUrl: 'https://api.minimaxi.com/v1',
    keyHint: { re: /^eyJ/, unique: true },
    models: ['MiniMax-Text-01', 'abab6.5s-chat'], note: '密钥为 JWT 格式（eyJ 开头）' },
  { id: 'siliconflow', name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1',
    keyHint: { re: /^sk-/, unique: false },
    models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct'],
    note: '聚合平台，模型名形如「厂商/模型」' },
  { id: 'spark', name: '讯飞星火', baseUrl: 'https://spark-api-open.xf-yun.com/v1',
    keyHint: { re: /^[^:\s]{6,}:[^:\s]{6,}$/, unique: true },
    models: ['generalv3.5', '4.0Ultra'], note: '密钥形如 APIKey:APISecret（含冒号）' },
  { id: 'hunyuan', name: '腾讯混元', baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    keyHint: { re: /^sk-/, unique: false },
    models: ['hunyuan-turbo', 'hunyuan-pro', 'hunyuan-lite'], note: '' },
  { id: 'stepfun', name: '阶跃星辰', baseUrl: 'https://api.stepfun.com/v1',
    keyHint: { re: /^sk-/, unique: false },
    models: ['step-3', 'step-2-16k', 'step-1-8k'], note: '' },
  { id: 'baichuan', name: '百川智能', baseUrl: 'https://api.baichuan-ai.com/v1',
    keyHint: { re: /^sk-/, unique: false },
    models: ['Baichuan4', 'Baichuan3-Turbo'], note: '' },
  { id: 'prism-local', name: 'Prism 本地网关', baseUrl: 'http://127.0.0.1:18790/v1',
    keyHint: { re: /^sk-prism-/i, unique: true },
    models: ['auto'], extraBody: { reasoning_effort: 'low' },
    note: '本机 Prism 聚合网关；auto 模型建议配 {"reasoning_effort":"low"}' },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1',
    keyHint: { re: /^sk-/, unique: false },
    models: ['gpt-4o-mini', 'gpt-4o'], note: '' },
  { id: 'ollama', name: 'Ollama（本地）', baseUrl: 'http://127.0.0.1:11434/v1',
    keyHint: null, noKey: true, models: [], note: '本地运行，无需 API Key' },
  { id: 'custom', name: '自定义 OpenAI 兼容接口', baseUrl: '',
    keyHint: null, custom: true, models: [], note: '填任意 /v1 兼容地址' },
];

function providerOf(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}

/** 序列化给管理页（keyHint.re 转字符串） */
function providersForClient() {
  return PROVIDERS.map((p) => ({
    id: p.id, name: p.name, baseUrl: p.baseUrl, models: p.models || [],
    note: p.note || '', noKey: !!p.noKey, custom: !!p.custom,
    extraBody: p.extraBody || null,
  }));
}

module.exports = { PROVIDERS, providerOf, providersForClient };
