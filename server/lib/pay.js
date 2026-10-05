/* PaperPilot 账号后台 · 在线支付协议层（易支付 / 码支付）
 *
 * 移植自「医疗工具平台」售卖站 `store/server/pay.js`（那套已在生产跑通），按本仓库约束做了改造：
 *   · **原生 http/https 模块**，不用全局 fetch（本仓库服务端声明支持 Node ≥14）
 *   · 配置读写留在 account-server（JsonStore 惯用法），本模块只做「纯协议 + 形状规整」
 *   · 履约副作用**不在这里**：回调只做校验，履约交给 account-server 的
 *     `applyOrderFulfill()`（与人工核销/对账共用同一入口，避免副作用逻辑漂移）
 *   · 深度连接测试改为**显式触发**（它会在网关产生一笔 0.01 元未支付测试单）
 *
 * 两种协议（provider）：
 *   epay  易支付/码支付 V1（MD5 签名）
 *     下单跳转 {gateway}/submit.php   异步回调 GET notify_url   同步返回 return_url
 *     主动查单 {gateway}/api.php?act=order
 *     变体 queryMode='checkOrder'：GET {gateway}/Api/checkOrder（密钥不出现在参数里）
 *   mzf2  易支付/码支付 V2（SHA256WithRSA 签名）
 *     下单跳转 {gateway}/api/pay/submit   主动查单 POST {gateway}/api/pay/query
 *     商户信息 POST {gateway}/api/merchant/info（连接测试用；响应带平台签名需验签）
 *   异步通知：V1 用商户密钥验签；V2 用**平台公钥**验签
 *
 * 配置形状（存 server/data/pay.json，密文字段见 secretbox.js）：
 *   { schemaVersion, enabled, provider, gateway, pid, name, queryMode,
 *     keyEnc, privateKeyEnc, platformKey }
 */
'use strict';

const crypto = require('crypto');
const http = require('http');
const https = require('https');

/** 回调应答体：易支付协议约定 —— 收到 success 才停止重试 */
const NOTIFY_OK = 'success';
const NOTIFY_FAIL = 'fail';

/** 支持的支付渠道（网关侧取值） */
const CHANNELS = ['wxpay', 'alipay'];
const CHANNEL_TEXT = { wxpay: '微信支付', alipay: '支付宝' };

/* ==================== 配置 ==================== */

function newCfg() {
  return {
    schemaVersion: 1,
    enabled: false,
    provider: 'epay',
    gateway: '',
    pid: '',
    name: '在线支付',
    queryMode: '',
    keyEnc: '',           // V1 商户密钥（密文）
    privateKeyEnc: '',    // V2 商户私钥（密文）
    platformKey: '',      // V2 平台公钥（公钥无密性要求，明文存便于核对）
  };
}

/** 形状规整（幂等；密文字段按不透明字符串原样保留，不做解密） */
function sanitizeCfg(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const qm = r.queryMode === 'checkOrder' ? 'checkOrder' : '';
  return {
    schemaVersion: 1,
    enabled: !!r.enabled,
    provider: r.provider === 'mzf2' ? 'mzf2' : 'epay',
    gateway: String(r.gateway || '').trim().replace(/\/+$/, ''),
    pid: String(r.pid || '').trim().slice(0, 64),
    name: String(r.name || '在线支付').trim().slice(0, 30) || '在线支付',
    queryMode: qm,
    keyEnc: typeof r.keyEnc === 'string' ? r.keyEnc : '',
    privateKeyEnc: typeof r.privateKeyEnc === 'string' ? r.privateKeyEnc : '',
    platformKey: cleanKeyMaterial(r.platformKey),
  };
}

/** 是否「配齐且启用」（缺材料时在线支付不可用，且必须 fail-safe 而非半残运行） */
function isReady(cfg) {
  if (!cfg || !cfg.enabled || !cfg.pid || !cfg.gateway) return false;
  if (!/^https?:\/\//i.test(cfg.gateway)) return false;
  return cfg.provider === 'epay' ? !!cfg.keyEnc : !!(cfg.privateKeyEnc && cfg.platformKey);
}

/**
 * 管理端视图：**密文一律不回显**（只告知「存过没有」）。
 * 平台公钥是公钥，回显便于人工核对粘贴是否正确。
 * @param {object} cfg 已解密补齐的配置（含 key / privateKey 明文，仅供内部判定）
 */
function adminOut(cfg, extra) {
  const c = cfg || newCfg();
  return Object.assign({
    enabled: !!c.enabled,
    provider: c.provider,
    gateway: c.gateway,
    pid: c.pid,
    name: c.name,
    queryMode: c.queryMode,
    hasKey: !!c.keyEnc,
    hasPrivateKey: !!c.privateKeyEnc,
    hasPlatformKey: !!c.platformKey,
    platformKey: c.platformKey || '',
    ready: isReady(c),
    channels: CHANNELS.map((id) => ({ id, text: CHANNEL_TEXT[id] })),
  }, extra || {});
}

/* ==================== 密钥材料规范化 ==================== */

/** 去掉全部空白；PEM 则提取正文。网关后台复制出来的密钥常带换行/空格 */
function cleanKeyMaterial(s) {
  let v = String(s == null ? '' : s).trim();
  const m = /-----BEGIN ([A-Z ]+)-----([\s\S]+?)-----END \1-----/.exec(v);
  if (m) v = m[2];
  return v.replace(/\s+/g, '');
}

function wrap64(b64) { return b64.replace(/(.{64})/g, '$1\n').replace(/\n$/, ''); }

/** 商户私钥：优先 PKCS#8，失败回退 PKCS#1 */
function toPrivateKey(b64) {
  const body = wrap64(cleanKeyMaterial(b64));
  try {
    return crypto.createPrivateKey(`-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`);
  } catch (e) {
    return crypto.createPrivateKey(`-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`);
  }
}

/** 平台公钥：优先 X.509 SPKI，失败回退 PKCS#1 */
function toPublicKey(b64) {
  const body = wrap64(cleanKeyMaterial(b64));
  try {
    return crypto.createPublicKey(`-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----`);
  } catch (e) {
    return crypto.createPublicKey(`-----BEGIN RSA PUBLIC KEY-----\n${body}\n-----END RSA PUBLIC KEY-----`);
  }
}

/** 保存前校验密钥能否解析（返回错误文案，'' = 通过）——别等回调来了才发现密钥是坏的 */
function checkKeys({ privateKey, platformKey }) {
  if (privateKey) {
    try { toPrivateKey(privateKey); } catch (e) { return '商户私钥无法解析，请确认粘贴完整（支持 base64 或 PEM）'; }
  }
  if (platformKey) {
    try { toPublicKey(platformKey); } catch (e) { return '平台公钥无法解析，请确认粘贴完整（支持 base64 或 PEM）'; }
  }
  return '';
}

/* ==================== 签名 ==================== */

/** 待签名字符串：非空参数、剔除 sign/sign_type、键名 ASCII 升序、k=v 以 & 连接 */
function buildSignStr(params) {
  return Object.keys(params)
    .filter((k) => k !== 'sign' && k !== 'sign_type'
      && params[k] !== '' && params[k] !== undefined && params[k] !== null)
    .sort()
    .map((k) => k + '=' + params[k])
    .join('&');
}

/** V1 易支付 MD5：sign = md5(待签名串 + 商户密钥) */
function buildSign(params, key) {
  return crypto.createHash('md5').update(buildSignStr(params) + String(key || ''), 'utf8').digest('hex');
}

function verifySign(query, key) {
  if (!query || !query.sign || !key) return false;
  const expect = buildSign(query, key);
  const got = String(query.sign).toLowerCase();
  // 定长比对，避免时序侧信道（长度不等直接 false，不调用 timingSafeEqual）
  if (expect.length !== got.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(got));
  } catch (e) { return false; }
}

function rsaSign(params, privateKeyB64) {
  return crypto.sign('RSA-SHA256', Buffer.from(buildSignStr(params), 'utf8'),
    toPrivateKey(privateKeyB64)).toString('base64');
}

function rsaVerify(query, platformKeyB64) {
  try {
    if (!query || !query.sign || !platformKeyB64) return false;
    return crypto.verify('RSA-SHA256', Buffer.from(buildSignStr(query), 'utf8'),
      toPublicKey(platformKeyB64), Buffer.from(String(query.sign), 'base64'));
  } catch (e) { return false; }
}

/** 异步回调验签：按 provider 分发（V1 商户密钥 / V2 平台公钥） */
function verifyNotify(cfg, query) {
  if (!cfg) return false;
  return cfg.provider === 'epay' ? verifySign(query, cfg.key) : rsaVerify(query, cfg.platformKey);
}

/* ==================== HTTP（原生模块，零依赖） ==================== */

function requestText(urlStr, { method = 'GET', form = null, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('地址不合法：' + urlStr)); }
    const mod = u.protocol === 'https:' ? https : http;
    const body = form ? new URLSearchParams(form).toString() : null;
    const headers = {};
    if (body) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || undefined,
      path: u.pathname + u.search,
      method,
      headers,
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('timeout', () => req.destroy(new Error('请求超时（' + timeoutMs + 'ms）')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** 取 JSON；网关偶尔会返回带 BOM / 前后空白的体，这里统一容错 */
async function requestJson(urlStr, opts) {
  const r = await requestText(urlStr, opts);
  const t = String(r.text || '').replace(/^\uFEFF/, '').trim();
  try {
    return JSON.parse(t);
  } catch (e) {
    throw new Error('网关响应不是 JSON：' + t.slice(0, 120));
  }
}

/* ==================== 订单号 ==================== */

/**
 * 网关可用的商户订单号：**只允许字母数字**（易支付类网关普遍如此）。
 * PaperPilot 内部订单号形如 `o-05ebc5e72c3b`（带连字符，会被网关拒单），
 * 所以支付下单时另生成一个纯字母数字号，存在订单的 outTradeNo 字段里。
 */
function newTradeNo(prefix) {
  const p = String(prefix || 'PP').replace(/[^A-Za-z0-9]/g, '').slice(0, 4) || 'PP';
  const ts = Date.now().toString(36).toUpperCase();
  const rnd = crypto.randomBytes(4).toString('hex').toUpperCase();
  return p + ts + rnd;   // 形如 PPKY2M1A3B7F1C9
}

/* ==================== 下单 / 查单 / 自检 ==================== */

function moneyStr(cents) {
  return (Math.round(Number(cents) || 0) / 100).toFixed(2);
}

/**
 * 生成收银台跳转地址（GET）。
 * @param {object} cfg 已解密补齐的配置
 * @param {{outTradeNo:string, amountCents:number, itemName:string}} order
 * @param {string} channel wxpay | alipay
 * @param {string} base 站点公网基地址（**必须显式传入**，不要按请求头推断）
 */
function createPayUrl(cfg, order, channel, base) {
  const ch = CHANNELS.indexOf(channel) >= 0 ? channel : 'wxpay';
  const root = String(base || '').replace(/\/+$/, '');
  const params = {
    pid: cfg.pid,
    type: ch,
    out_trade_no: String(order.outTradeNo || ''),
    notify_url: root + '/api/pay/notify',
    return_url: root + '/api/pay/return',
    name: String(order.itemName || 'PaperPilot').slice(0, 60),
    money: moneyStr(order.amountCents),
  };
  if (cfg.provider === 'epay') {
    const sign = buildSign(params, cfg.key);
    const qs = Object.entries(Object.assign({}, params, { sign, sign_type: 'MD5' }))
      .map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
    return cfg.gateway + '/submit.php?' + qs;
  }
  params.timestamp = String(Math.floor(Date.now() / 1000));   // V2 必传：10 位秒级时间戳
  const sign = rsaSign(params, cfg.privateKey);
  const qs = Object.entries(Object.assign({}, params, { sign, sign_type: 'RSA' }))
    .map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
  return cfg.gateway + '/api/pay/submit?' + qs;
}

/**
 * 主动查单（**回调丢包时的兜底，属必需项**）。
 * @returns {Promise<{ok:boolean, paid:boolean, tradeNo:string, raw:object}>}
 */
async function queryOrder(cfg, outTradeNo) {
  if (!cfg || !cfg.gateway) return { ok: false, paid: false, tradeNo: '', raw: { error: 'not_configured' } };
  const no = String(outTradeNo || '');
  if (cfg.provider === 'epay') {
    if (cfg.queryMode === 'checkOrder') {
      // 变体：GET {gw}/Api/checkOrder，MD5 签名（密钥不出现在参数里）
      const params = { pid: cfg.pid, out_trade_no: no };
      const sign = buildSign(params, cfg.key);
      const url = cfg.gateway + '/Api/checkOrder?' + new URLSearchParams(Object.assign({}, params, { sign })).toString();
      const data = await requestJson(url);
      const d = (data && data.data) || {};
      // 该变体 code=0 为成功
      return { ok: Number(data && data.code) === 0, paid: Number(d.status) === 1, tradeNo: String(d.trade_no || ''), raw: data };
    }
    // 标准易支付：GET {gw}/api.php?act=order（密钥以 key 参数直传）
    const url = cfg.gateway + '/api.php?act=order'
      + '&pid=' + encodeURIComponent(cfg.pid)
      + '&key=' + encodeURIComponent(cfg.key)
      + '&out_trade_no=' + encodeURIComponent(no);
    const data = await requestJson(url);
    // V1 返回 code=1 为成功（与 V2 相反）
    return { ok: Number(data && data.code) === 1, paid: Number(data && data.status) === 1, tradeNo: String((data && data.trade_no) || ''), raw: data };
  }
  // V2：POST /api/pay/query，响应带平台签名需验签（code=0 为成功）
  const params = { pid: cfg.pid, out_trade_no: no, timestamp: String(Math.floor(Date.now() / 1000)) };
  const signed = Object.assign({}, params, { sign: rsaSign(params, cfg.privateKey), sign_type: 'RSA' });
  const data = await requestJson(cfg.gateway + '/api/pay/query', { method: 'POST', form: signed, timeoutMs: 12000 });
  if (data && data.sign && !rsaVerify(data, cfg.platformKey)) {
    return { ok: false, paid: false, tradeNo: '', raw: { error: 'response_sign_invalid', data } };
  }
  return { ok: Number(data && data.code) === 0, paid: Number(data && data.status) === 1, tradeNo: String((data && data.trade_no) || ''), raw: data };
}

/**
 * 连接自检（不动任何订单；深度模式除外）。
 * @param {object} cfg 已解密补齐的配置
 * @param {{deep?:boolean}} [opts] deep=true 时按真实参数试探下单一笔 0.01 元测试单
 *   —— 会在网关商户后台留下一条未支付记录（可忽略），故**默认关闭、由管理员显式触发**
 */
async function testConnection(cfg, { deep } = {}) {
  if (!cfg || !cfg.gateway) return { ok: false, msg: '未填写网关地址' };
  if (!/^https?:\/\//i.test(cfg.gateway)) return { ok: false, msg: '网关地址必须以 http(s):// 开头' };
  if (cfg.provider === 'epay') {
    if (!cfg.key) return { ok: false, msg: '未填写商户密钥（V1 用 MD5 密钥）' };
    // 查一个不可能存在的订单号：网关返回规范 JSON 即证明地址可达 + 签名被接受
    let r;
    try {
      r = await queryOrder(cfg, 'PING0000000000');
    } catch (e) {
      return { ok: false, msg: '无法连接 ' + cfg.gateway + '：' + e.message };
    }
    const rawMsg = String((r.raw && (r.raw.msg || r.raw.error)) || '');
    if (r.raw && r.raw.code === undefined && r.raw.error) {
      return { ok: false, msg: '网关响应异常：' + JSON.stringify(r.raw).slice(0, 200) };
    }
    if (!r.ok && /签名|密钥|sign|key/i.test(rawMsg)) {
      return { ok: false, msg: '网关拒绝了签名（商户密钥或商户号可能不正确）：' + rawMsg, raw: r.raw };
    }
    if (!r.ok && r.raw && r.raw.code === undefined) {
      return { ok: false, msg: '网关响应异常：' + JSON.stringify(r.raw).slice(0, 200) };
    }
    // 查单通 ≠ 下单通：再探下单一，确认 submit.php 存在
    let sres;
    try {
      sres = await requestText(cfg.gateway + '/submit.php', { timeoutMs: 8000 });
    } catch (e) {
      return { ok: false, msg: '查单接口正常，但 submit.php 探测失败：' + e.message, raw: r.raw };
    }
    if (sres.status === 404) {
      return { ok: false, msg: '查单接口正常，但 submit.php 返回 404，下单入口不可用', raw: r.raw };
    }
    if (!deep) {
      return { ok: true, msg: '查单链路通过（签名被网关接受，' + (rawMsg || '响应正常') + '），下单入口 submit.php 可达（HTTP ' + sres.status + '）' };
    }
    // 深度：按真实下单参数构造 0.01 元测试单
    try {
      const p = {
        pid: cfg.pid, type: 'wxpay',
        out_trade_no: newTradeNo('WBT'),
        notify_url: 'https://example.com/notify', return_url: 'https://example.com/return',
        name: '连接测试商品', money: '0.01',
      };
      const sign = buildSign(p, cfg.key);
      const qs = new URLSearchParams(Object.assign({}, p, { sign, sign_type: 'MD5' })).toString();
      const sr = await requestText(cfg.gateway + '/submit.php?' + qs, { timeoutMs: 12000 });
      const text = String(sr.text || '').slice(0, 600);
      const errM = /签名错误|签名失败|验签失败|sign[_ ]?(error|fail)|参数错误|商户不存在/i.exec(text);
      if (errM) return { ok: false, msg: 'submit.php 下单被拒绝：' + errM[0], raw: text.slice(0, 200) };
      return { ok: true, msg: '全链路通过：查单签名被接受，submit.php 下单链路正常（HTTP ' + sr.status
        + '；网关已产生一笔 0.01 元未支付测试单，可在商户后台忽略）' };
    } catch (e) {
      return { ok: false, msg: '查单接口正常，但 submit.php 下单探测失败：' + e.message };
    }
  }
  /* V2：POST /api/merchant/info，同时验证私钥签名 + 平台公钥验签 */
  if (!cfg.privateKey || !cfg.platformKey) return { ok: false, msg: '未填写商户私钥或平台公钥（V2 用 RSA）' };
  const params = { pid: cfg.pid, timestamp: String(Math.floor(Date.now() / 1000)) };
  let signed;
  try {
    signed = Object.assign({}, params, { sign: rsaSign(params, cfg.privateKey), sign_type: 'RSA' });
  } catch (e) {
    return { ok: false, msg: '商户私钥签名失败：' + e.message };
  }
  let data;
  try {
    data = await requestJson(cfg.gateway + '/api/merchant/info', { method: 'POST', form: signed, timeoutMs: 12000 });
  } catch (e) {
    return { ok: false, msg: '无法连接 ' + cfg.gateway + '/api/merchant/info：' + e.message };
  }
  if (Number(data && data.code) !== 0) {
    return { ok: false, msg: '网关返回错误：' + ((data && data.msg) || JSON.stringify(data).slice(0, 200)), raw: data };
  }
  if (data.sign && !rsaVerify(data, cfg.platformKey)) {
    return { ok: false, msg: '网关响应验签失败：平台公钥不匹配', raw: data };
  }
  return {
    ok: true,
    msg: '连接成功：商户 ' + (data.pid || cfg.pid) + '，状态 '
      + (Number(data.status) === 1 ? '正常' : '异常')
      + '，今日订单 ' + (data.order_num_today == null ? '-' : data.order_num_today) + ' 笔',
    raw: data,
  };
}

module.exports = {
  NOTIFY_OK, NOTIFY_FAIL, CHANNELS, CHANNEL_TEXT,
  newCfg, sanitizeCfg, isReady, adminOut,
  cleanKeyMaterial, toPrivateKey, toPublicKey, checkKeys,
  buildSignStr, buildSign, verifySign, rsaSign, rsaVerify, verifyNotify,
  newTradeNo, moneyStr, createPayUrl, queryOrder, testConnection,
};
