/* PaperPilot 账号后台 · AI 计费单价域（服务端 1.5.0，配合插件 0.26.0）
 *
 * 职责：模型单价表（元 / 千 token）+ 上游 usage 解析 + 成本折算。
 * 数据：{DATA_DIR}/pricing.json（JsonStore 原子写）
 *   {
 *     schemaVersion: 1,
 *     currency: 'CNY',
 *     models:   { '<模型名>': { inPer1k, outPer1k, note, updatedAt } },
 *     fallback: { inPer1k, outPer1k }   // 未配置单价的模型兜底（默认 0）
 *   }
 *
 * ★ 为什么按「响应里的 model」计价，而不是「请求里的 model」：
 *   客户端最常用的是 auto，它由上游映射成真实模型，**响应里的 model 字段会回填真实名**。
 *   若按请求计价，所有 auto 请求都会被记到键名 "auto" 下，成本统计完全失真。
 *   调用方应传 responseModel || requestModel。
 *
 * ★ 为什么成本用「微元」（1e-6 元）整数，而不是「分」：
 *   一次短问答可能只值 ¥0.0008。用「分」累计时每一笔都被四舍五入成 0，
 *   跑一个月也看不到任何成本。微元保留 6 位小数且是整数，累加无浮点误差。
 *   换算：1 元 = 1e6 微元；1 分 = 1e4 微元。
 *
 * 价格口径：inPer1k / outPer1k 的单位是「元 / 千 token」。
 *   cost(元)   = inTok/1000 * inPer1k + outTok/1000 * outPer1k
 *   cost(微元) = (inTok * inPer1k + outTok * outPer1k) * 1000
 *
 * 计量盲区（重要）：上游未返回 usage 时**不是 0 成本，而是「未知成本」**。
 *   本模块把这种情况标成 known=false 且 micro=null，由调用方单独计数
 *   （user.usage.missingUsage），后台看板会显著提示——绝不静默当成免费。
 */
'use strict';

/** 单价上限（元 / 千 token）：防手滑输入把成本算成天文数字 */
const MAX_PER_1K = 10000;

const DEFAULT_DOC = {
  schemaVersion: 1,
  currency: 'CNY',
  models: {},
  fallback: { inPer1k: 0, outPer1k: 0 },
};

function clone(o) { return JSON.parse(JSON.stringify(o)); }

function newDoc() { return clone(DEFAULT_DOC); }

/** 非负有限数（非法 → 默认值） */
function num(v, dft) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dft;
}

/** 单价夹取：0 ≤ v ≤ MAX_PER_1K，保留 6 位小数（元 / 千 token 的精度的现实上限） */
function normPrice(v, dft) {
  const n = num(v, dft);
  return Math.round(Math.min(MAX_PER_1K, n) * 1e6) / 1e6;
}

function normModelName(m) { return String(m == null ? '' : m).trim().slice(0, 120); }

function sanitizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const inPer1k = normPrice(raw.inPer1k, 0);
  const outPer1k = normPrice(raw.outPer1k, 0);
  return {
    inPer1k,
    outPer1k,
    note: String(raw.note || '').slice(0, 80),
    updatedAt: String(raw.updatedAt || '') || new Date().toISOString(),
  };
}

/** 规范化 / 迁移（幂等，每次启动都可安全调用） */
function normalize(doc) {
  const out = doc && typeof doc === 'object' ? doc : newDoc();
  if (!out.models || typeof out.models !== 'object' || Array.isArray(out.models)) out.models = {};
  const models = {};
  for (const [k, v] of Object.entries(out.models)) {
    const name = normModelName(k);
    const e = sanitizeEntry(v);
    if (name && e) models[name] = e;
  }
  out.models = models;
  if (!out.fallback || typeof out.fallback !== 'object') out.fallback = clone(DEFAULT_DOC.fallback);
  out.fallback = {
    inPer1k: normPrice(out.fallback.inPer1k, 0),
    outPer1k: normPrice(out.fallback.outPer1k, 0),
  };
  out.currency = String(out.currency || 'CNY').slice(0, 8);
  out.schemaVersion = 1;
  return out;
}

/** 模型单价表（按名称排序，供后台列表 / 客户端只读展示） */
function modelList(doc) {
  const models = (doc && doc.models) || {};
  return Object.keys(models).sort().map((name) => Object.assign({ model: name }, models[name]));
}

/**
 * 查单价。命中顺序：精确 → 忽略大小写精确 → 兜底（known=false）。
 * ★ 刻意**不做前缀/模糊匹配**：`glm-5.3` 是 `glm-5.3-flash` 的前缀，但两者单价不同，
 *   前缀匹配会把贵模型的钱算成便宜模型的价。宁可报「未配置」让运营补，也不要算错。
 */
function priceFor(doc, model) {
  const name = normModelName(model);
  const models = (doc && doc.models) || {};
  if (name && models[name]) return Object.assign({ known: true, matched: name }, models[name]);
  if (name) {
    const lower = name.toLowerCase();
    const hit = Object.keys(models).find((k) => k.toLowerCase() === lower);
    if (hit) return Object.assign({ known: true, matched: hit }, models[hit]);
  }
  const fb = (doc && doc.fallback) || DEFAULT_DOC.fallback;
  return {
    inPer1k: normPrice(fb.inPer1k, 0),
    outPer1k: normPrice(fb.outPer1k, 0),
    known: false,
    matched: null,
  };
}

/** 新增 / 更新一条单价。返回 { model, entry } 或 { error } */
function setModel(doc, model, input) {
  const name = normModelName(model);
  if (!name) return { error: '模型名不能为空' };
  const inp = input || {};
  if (inp.inPer1k === undefined && inp.outPer1k === undefined) {
    return { error: '至少要提供 inPer1k 或 outPer1k' };
  }
  const prev = (doc.models && doc.models[name]) || {};
  const entry = sanitizeEntry({
    inPer1k: inp.inPer1k === undefined ? prev.inPer1k : inp.inPer1k,
    outPer1k: inp.outPer1k === undefined ? prev.outPer1k : inp.outPer1k,
    note: inp.note === undefined ? prev.note : inp.note,
  });
  if (!entry) return { error: '单价配置非法' };
  entry.updatedAt = new Date().toISOString();
  if (!doc.models || typeof doc.models !== 'object') doc.models = {};
  doc.models[name] = entry;
  return { model: name, entry };
}

function removeModel(doc, model) {
  const name = normModelName(model);
  if (!name) return { error: '模型名不能为空' };
  if (!doc.models || !doc.models[name]) return { error: '该模型未配置单价' };
  const entry = doc.models[name];
  delete doc.models[name];
  return { model: name, entry };
}

function hasModel(doc, model) {
  return !!priceFor(doc, model).known;
}

/* ---------------- usage 解析 ---------------- */

function tok(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/**
 * 从上游 usage 对象解析 token 数。
 * 兼容两种命名：OpenAI 系 prompt_tokens/completion_tokens，部分上游 input_tokens/output_tokens。
 * 完全取不到有效 token 时返回 null（= 计量盲区，不是 0）。
 */
function usageOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const pick = (a, b) => (raw[a] !== undefined ? raw[a] : raw[b]);
  const inTok = tok(pick('prompt_tokens', 'input_tokens'));
  const outTok = tok(pick('completion_tokens', 'output_tokens'));
  const totalRaw = raw.total_tokens;
  const totalTok = tok(totalRaw) || (inTok + outTok);
  if (!inTok && !outTok && !totalTok) return null;
  return { inTok, outTok, totalTok };
}

/**
 * 成本折算 → 微元整数。
 * @returns {{micro:number, known:boolean, inPer1k:number, outPer1k:number, inTok:number, outTok:number, model:string}}
 *   micro = 0 且 known=false 表示「按兜底 0 价计」（上游有 usage 但模型没配单价）；
 *   调用方若需要区分「免费」与「未知单价」，看 known。
 */
function costOf(doc, model, usage) {
  const u = usage || { inTok: 0, outTok: 0 };
  const p = priceFor(doc, model);
  const yuanPer1k = u.inTok * p.inPer1k + u.outTok * p.outPer1k;
  const micro = Math.round(yuanPer1k * 1000);
  return {
    model: normModelName(model),
    inTok: tok(u.inTok),
    outTok: tok(u.outTok),
    inPer1k: p.inPer1k,
    outPer1k: p.outPer1k,
    known: p.known,
    // micro=0 有两种含义，用 known 区分：known=true 是真免费（单价配 0），
    // known=false 是「模型没配单价、按兜底 0 计」——调用方须单独统计后者。
    micro: micro > 0 ? micro : 0,
  };
}

/* ---------------- 展示换算 ---------------- */

const MICRO_PER_YUAN = 1e6;
const MICRO_PER_CENT = 1e4;

function microToYuan(micro) { return (Number(micro) || 0) / MICRO_PER_YUAN; }
function microToCents(micro) { return (Number(micro) || 0) / MICRO_PER_CENT; }
function yuanToMicro(yuan) { return Math.round((Number(yuan) || 0) * MICRO_PER_YUAN); }

/**
 * 金额文案：小额给足小数位，避免满屏「¥0.00」。
 *   ≥ 1 元 → 2 位；≥ 0.01 元 → 3 位；否则 4 位。
 */
function microText(micro) {
  const y = microToYuan(micro);
  if (!Number.isFinite(y) || y <= 0) return '¥0';
  if (y >= 1) return '¥' + y.toFixed(2);
  if (y >= 0.01) return '¥' + y.toFixed(3);
  return '¥' + y.toFixed(4);
}

/** token 数文案：≥ 10000 用「万」，否则千分位 */
function tokText(n) {
  const v = Number(n) || 0;
  if (v >= 10000) return (Math.round(v / 1000) / 10) + ' 万';
  return String(Math.round(v));
}

module.exports = {
  DEFAULT_DOC, MAX_PER_1K,
  MICRO_PER_YUAN, MICRO_PER_CENT,
  newDoc, normalize, sanitizeEntry, normPrice, normModelName,
  modelList, priceFor, setModel, removeModel, hasModel,
  usageOf, costOf,
  microToYuan, microToCents, yuanToMicro, microText, tokText,
};
