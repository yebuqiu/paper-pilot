#!/usr/bin/env node
/* PaperPilot 账号后台 · account-server.js（Node >= 14，零依赖）
 *
 * 实现 Zotero 插件 0.14.0 账号系统契约（docs/账号系统与模型通道.md）：
 *   POST /api/auth/register  {email,password,nickname} → {ok,user}（公开自助注册，固定 Free）
 *   POST /api/auth/login     {email,password} → {ok,token,expiresAt,user} | 401
 *   POST /api/auth/logout    Bearer → {ok:true}
 *   GET  /api/auth/me        Bearer → {ok,user,expiresAt}（滑动续期）
 *   GET  /v1/models          Bearer → OpenAI 格式
 *   POST /v1/chat/completions Bearer → 转发活动通道上游（SSE 流式透传，auto→通道模型）
 *   GET  /register           公开自助注册页（public/register.html）
 *
 * 会员域（服务端 1.6.0，插件 0.25.x；Free / Pro 两档 + 价格表 + 永久会员 + 对账核销 + 优惠券
 *          + 套餐 AI 能力（高级模型白名单 / 新用户全模型试用）
 *          + **AI 计费计量（网关按 token 记成本，为按量计费铺路）**
 *          + **余额域（注册赠送 / 充值 / 按成本扣减 / 流水）**）：
 * AI 计量（1.5.0）：每次成功转发都解析上游 usage（流式自动带 include_usage），
 *   按「响应里的真实模型」计价并累计到 user.usage（token / 成本微元 / 按模型）。
 *   上游没返 usage → 计入 missingUsage（未知成本，不是 0），后台看板显著提示。
 * 余额域（1.6.0）：user.balance = { grantedMicro（注册赠送,有期）/ planMicro（订阅额度,当期不结转）
 *   / paidMicro（充值,永不过期）/ ledger }。
 *   注册自动赠送（signupGrantMicro，默认 ¥6/30 天，限基础模型）；Pro 每月发放订阅额度
 *   （plans[].monthlyGrantMicro，现场推导不发定时任务，只按期号判重＝不结转）；
 *   网关按真实成本扣减（注册赠送 → 订阅额度 → 充值，越保值越晚扣；高级模型跳过注册赠送）；
 *   enforce=false 为观察模式只记账不拦，开启后余额低于阈值返回 402 + 充值引导
 *   （同时 dailyLimit 次数上限自动失效，额度改由余额承担）。
 *   管理员可充值/调账（audit: balance.adjust）。
 * 在线支付（1.7.0）：易支付/码支付接入，充值订单可自助下单→扫码→**自动到账**。
 *   配置存 data/pay.json，商户密钥用 AES-256-GCM 加密（主密钥 data/.secret.key，均不进备份）。
 *   ★ 回调地址由 **PP_PUBLIC_URL** 决定（不按 Host 头推断——公网 Host 可伪造）。
 *   ★ 不启用时一切照旧（收款码 + 人工核销）；`enforce`/`enabled` 各自独立开关。
 * 登录设备（1.4.7）：令牌带 sid/设备/来源 IP 与最近活动；用户可自查并踢出设备，
 *   GET  /api/plans                 公开 → {plans, priceOptions, priceItems, upcoming, cycles, pay}
 *   GET  /api/membership            Bearer → {membership(等级/到期/剩余天数/额度/历史), user(含用量趋势)}
 *   GET  /api/auth/me               Bearer → user 内附带 usage:{today,limit,last7,days[30]}
 *   POST /api/orders                Bearer {plan,months} → 下单（订单号+金额+收款信息）
 *   GET  /api/orders/:id            Bearer → 订单状态
 *   POST /api/orders/:id/claim      Bearer → 标记「我已完成支付」，等管理员核销
 *   POST /api/orders/:id/cancel     Bearer → 取消未支付订单
 *   POST /api/orders/:id/pay        （1.7.0）发起在线支付 {channel:wxpay|alipay} → {payUrl}
 *   POST /api/orders/:id/query      （1.7.0）主动查单：网关回调丢包时的兜底，确认即自动入账
 *   GET  /api/pay/notify            （1.7.0）**公开**：网关异步回调（验签→商户号→状态→金额→幂等履约）
 *   GET  /api/pay/return            （1.7.0）**公开**：支付完成同步返回页（轮询 + 引导回插件）
 *   GET  /api/pay/return/status     （1.7.0）**公开**：返回页轮询用（只回是否已支付，不泄露细节）
 *   POST /api/redeem                Bearer {code} → 激活码兑换（绑定账号 + 叠加续期）
 *   POST /api/coupons/validate      Bearer {code,plan,months|cycle} → 优惠码试算（不占名额）
 *   GET  /api/sessions              Bearer → 本账号登录设备（IP 打码）+ 活跃设备数
 *   PUT  /api/sessions/:sid        Bearer {label} → 给自己的设备命名（本机拿不到主机名）
 *   DELETE /api/sessions/:sid       Bearer → 踢出指定设备（踢自己 = 登出）
 *   POST /api/sessions/revoke-others Bearer → 踢出除当前外的全部设备
 *   POST /api/orders                支持 {couponCode} → 折后下单（尾数在折后金额上分配）
 *   POST /api/admin/reconcile       收款流水按金额（含唯一尾数）自动匹配核销（默认 dryRun 预览）
 * 会员管理（仅本机直连）：
 *   GET  /api/admin/membership      订单 + 激活码 + 套餐/价格表/收款配置一览
 *   PUT  /api/admin/membership      改套餐额度 / 收款信息（局部更新；仍兼容旧的 priceOptions 写法）
 *   GET  /api/admin/prices          价格表全量（含未生效/已过期/已停用）+ 计费周期预设
 *   GET  /api/admin/pricing         （1.5.0）AI 模型单价表 + 实际用过但未配价的模型
 *   PUT  /api/admin/pricing         （1.5.0）改单价 {set:{模型:{inPer1k,outPer1k}},remove:[...],fallback:{}}
 *   GET  /api/admin/usage-summary   （1.5.0）成本看板 ?days=30（总量/按天/按模型/人均/Top 账号）
 *   PUT  /api/admin/pricing         （1.6.0）同接口可改余额配置 {balance:{enforce,signupGrantMicro,...}}
 *   POST /api/admin/users/:id/balance  （1.6.0）充值/调余额 {micro（有符号微元）,kind,reason}
 *   GET|PUT /api/admin/payment      （1.7.0）在线支付网关配置（密钥只写不读；PUT 支持三态）
 *   POST /api/admin/payment/test    （1.7.0）连接自检 {deep:true 会探一笔 0.01 元测试单}
 *   POST /api/admin/prices          新增价格条目 {plan, cycle, months, price, label,
 *                                   effectiveFrom, effectiveTo, enabled, note}
 *   PUT  /api/admin/prices/:id      改价格条目（局部更新，用于改价 / 定时生效 / 启停）
 *   DELETE /api/admin/prices/:id    删除价格条目
 *   GET  /api/admin/orders          订单列表
 *   POST /api/admin/orders/:id/fulfill | /cancel   核销（自动开通）/ 取消
 *   GET  /api/admin/users/:id/sessions        某账号的登录设备（**含完整 IP**，仅供本机追查）
 *   DELETE /api/admin/users/:id/sessions/:sid 管理员踢出某设备（处置账号共享）
 *   GET|POST /api/admin/coupons     优惠券列表 / 批量生成（只打折，与"发会员"的激活码分工不同）
 *   PUT|DELETE /api/admin/coupons/:id  局部更新（启停/额度/有效期）/ 作废（有占用则拒绝删除）
 *   GET|POST /api/admin/codes       激活码列表 / 批量生成
 *   DELETE /api/admin/codes/:id     作废未使用的激活码
 *   POST /api/admin/users/:id/membership           直接给用户开通/续期（叠加式）
 * 数据：server/data/membership.json（套餐 / 价格表 priceItems / 收款 / 订单 / 激活码）
 * ★ 价格表 = 等级 × 计费周期 × 生效时段；同等级同月数的生效时段不允许重叠（写入校验），
 *   因此「下单价」永远唯一。促销 = 给旧价填 effectiveTo，再新增一条同周期的促销价。
 *
 * 令牌生命周期（0.15.1 / 服务端 1.3.1，修「更新后被迫重新登录」）：
 *   TTL 30 天（PP_TOKEN_TTL_MS 可覆盖，测试用）；/api/auth/me 与 /v1/* 网关调用
 *   均滑动续期——用户只要在用（含仅用 AI 而不重启 Zotero 的场景）令牌就一直有效，
 *   不再出现「距上次重启 >7 天，更新后首次校验 401 → 被登出」。
 *
 * 公网部署（Cloudflare Tunnel）：
 *   cloudflared 回源 http://localhost:8000，socket 恒为回环但带 CF-Connecting-IP 头。
 *   clientIp() 取真实访客 IP（限速按真实 IP 计）；管理接口/管理页仅认「本机直连」
 *   （回环 socket 且无代理头）——公网用户只能注册/登录/调网关，摸不到管理面。
 *
 * 本机管理 API（仅本机直连，供启动管理器 GUI 与 /admin 管理页）：
 *   GET    /api/health
 *   GET    /admin                       浏览器管理页（public/admin.html）
 *   GET    /api/admin/providers         厂商预设目录
 *   用户：GET/POST /api/admin/users · PUT /api/admin/users/:id
 *         POST /api/admin/users/:id/password · DELETE /api/admin/users/:id
 *   通道：GET/POST /api/admin/channels · PUT/DELETE /api/admin/channels/:id
 *         PUT /api/admin/channels/active · POST /api/admin/channels/:id/test
 *         GET /api/admin/channels/:id/models · POST /api/admin/channels/detect
 *   上线：PUT /api/admin/channels/published {models:[...]}（0.15.0 对外上线模型清单，
 *         空数组=全部上线；/v1/models 只返回上线模型，显式调用未上线模型返回 400）
 *   分级：PUT /api/admin/channels/high-tier {models:[...]}（1.4.9 高级模型清单——仅这些
 *         模型需要「可用高级模型」的套餐（plans[].highTierModels）或新用户试用期；
 *         auto 恒免费。空数组 = 不存在高级模型，全部免费）
 *
 * 数据：server/data/users.json（scrypt 密码散列 + 令牌表，令牌仅存散列）
 *      server/data/channels.json（官方网关上游通道池 + active + publishedModels，
 *      与插件本地通道互不相干）
 *
 * 启动：node account-server.js [--port=8000]（或环境变量 PP_PORT）
 * 用量：官方网关每成功转发一次 chat/completions，当日计数 +1；超 dailyLimit 返回 429。
 *      1.5.0 起同一入口还记录 token 与成本（见 user.usage.inTok/outTok/costMicro/byModel）。
 *      数据：server/data/pricing.json（模型单价，元/千 token）。
 */
'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { JsonStore } = require('./lib/store');
const { PROVIDERS, providerOf, providersForClient } = require('./lib/presets');
const membership = require('./lib/membership');
const coupon = require('./lib/coupon');
const backup = require('./lib/backup');
const alerts = require('./lib/alerts');
const lockout = require('./lib/lockout');
const sessions = require('./lib/sessions');
const audit = require('./lib/audit');
const reconcile = require('./lib/reconcile');
const mail = require('./lib/mail');
const pricing = require('./lib/pricing');
const balance = require('./lib/balance');
const pay = require('./lib/pay');
const secretbox = require('./lib/secretbox');

/* ---------------- 配置 ---------------- */

const args = process.argv.slice(2);
const portArg = args.find((a) => a.startsWith('--port='));
const PORT = Number((portArg && portArg.slice(7)) || process.env.PP_PORT || 8000);
const HOST = '127.0.0.1';
// 数据目录：默认 server/data；环境变量 PP_DATA_DIR 可覆盖（测试隔离用）
const DATA_DIR = process.env.PP_DATA_DIR || path.join(__dirname, 'data');
const ADMIN_HTML = path.join(__dirname, 'public', 'admin.html');
const REGISTER_HTML = path.join(__dirname, 'public', 'register.html');
const VERIFY_HTML = path.join(__dirname, 'public', 'verify.html');
const FORGOT_HTML = path.join(__dirname, 'public', 'forgot.html');
const RESET_HTML = path.join(__dirname, 'public', 'reset.html');

/* 本地配置文件 {DATA_DIR}/pp.env（KEY=VALUE 每行；server/data/ 已 gitignore，密钥不进 git）：
 * PP_RESEND_KEY=re_xxx      启用邮箱验证/密码找回（Resend）
 * PP_MAIL_FROM=...          发件人（可选）
 * PP_PUBLIC_URL=https://... 站点公网地址。邮件链接前缀用它；**在线支付的回调地址也由它决定**
 *                           （不按 Host 头推断——公网 Host 可伪造）。未配置时在线支付不可用。
 * PP_PAY_MAX / PP_PAY_QUERY_MAX / PP_PAY_NOTIFY_MAX  支付相关限速（可选，见下方常量）
 * 已有的同名进程环境变量优先，不会被覆盖。 */
(function loadEnvFile() {
  try {
    const envPath = path.join(DATA_DIR, 'pp.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && m[1] && !m[1].startsWith('#') && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2];
      }
    }
    log('pp.env loaded (keys:', Object.keys(process.env).filter((k) => /^PP_/.test(k)).join(', ') + ')');
  } catch (e) { log('pp.env load failed:', e.message); }
})();

// 令牌 TTL：默认 30 天，滑动续期（/me 与 /v1/* 网关调用均续期）。
// 0.14.x 的 7 天 + 仅 /me 续期曾导致：用户不重启 Zotero 超过 7 天后令牌悄然过期，
// 下次启动（往往正是插件更新触发的重启）首次校验 401 → 客户端清会话 →「每次更新都要重新登录」。
// PP_TOKEN_TTL_MS 可覆盖（毫秒），E2E 测试用短 TTL 实测续期行为。
const TOKEN_TTL_MS = Number(process.env.PP_TOKEN_TTL_MS) > 0
  ? Number(process.env.PP_TOKEN_TTL_MS) : 30 * 86400e3;
// 限速阈值均可通过环境变量覆盖（PP_*_MAX），既方便按需收紧，也让自动化测试
// 不必为了绕开限速而拉长用例。账号级的锁定策略见 lib/lockout.js（与 IP 限速互补）。
const LOGIN_WINDOW_MS = 60e3;            // 限速窗口
function limitOf(envKey, dft) {
  const n = Number(process.env[envKey]);
  return Number.isFinite(n) && n > 0 ? n : dft;
}
const LOGIN_MAX = limitOf('PP_LOGIN_MAX', 10);     // 登录限速（每 IP 每分钟）
const REDEEM_MAX = limitOf('PP_REDEEM_MAX', 10);   // 激活码兑换限速（每 IP 每分钟，防撞码）
// 每日额度不再写死在这里：0.23.0 起由 membership.json 的套餐配置驱动
// （membership.dailyLimitFor），管理员在用户级的 dailyLimit 覆盖优先级最高。
const REG_MAX = 5;                       // 公开注册限速（每 IP 每分钟）
const MAIL_MAX = 3;                      // 验证/重置邮件请求限速（每 IP 每分钟）
const GATEWAY_MAX = 20;                  // 网关全局限速（每 IP 每分钟，防高频薅上游 Key）
// 1.6.0 在线支付限速：下单/查单按账号，回调按 IP
const PAY_MAX = limitOf('PP_PAY_MAX', 10);              // 发起支付（每账号每分钟）
const PAY_QUERY_MAX = limitOf('PP_PAY_QUERY_MAX', 12);  // 主动查单（每账号每分钟）
const PAY_NOTIFY_MAX = limitOf('PP_PAY_NOTIFY_MAX', 60); // 网关回调（每 IP 每分钟，网关会重试）
const VERIFY_TTL_MS = 24 * 3600e3;       // 邮箱验证链接有效期
const RESET_TTL_MS = 30 * 60e3;          // 密码重置链接有效期
const GATEWAY_TIMEOUT_MS = 120e3;        // 网关转发上限（流式应答可能较长）
// 1.5.0 计量：非流式响应超过此体积就放弃解析 usage（只影响计量，转发照旧）。
// 科研问答的正常响应远小于此；超限说明响应异常，不值得为计量吞进内存。
const PLAIN_METER_MAX = 4 * 1024 * 1024;

/* ---------------- 存储 ---------------- */

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const usersStore = new JsonStore(path.join(DATA_DIR, 'users.json'), { users: [], tokens: {} });
const channelsStore = new JsonStore(path.join(DATA_DIR, 'channels.json'), { channels: [], active: null });
// 0.23.0 会员域：套餐/价格/收款信息/订单/激活码。
// 首次启动自动落默认配置；v1（无 schemaVersion）文档自动升级，幂等。
const membershipStore = new JsonStore(path.join(DATA_DIR, 'membership.json'), membership.newDoc());
membershipStore.data = membership.normalize(membershipStore.data);
membershipStore.save();
// 1.4.2 订单积压告警状态（重启不丢，避免重复轰炸）
const alertStore = new JsonStore(path.join(DATA_DIR, 'alerts.json'), {});
// 1.5.0 AI 计费单价表（模型 → 元/千 token）。默认空表 = 一切按「未配置单价」计，
// 后台看板会显著提示哪些模型还没配价——**不猜价**，缺价就是缺数据。
const pricingStore = new JsonStore(path.join(DATA_DIR, 'pricing.json'), pricing.newDoc());
pricingStore.data = pricing.normalize(pricingStore.data);
/* 1.6.0 在线支付网关配置（易支付/码支付）。**独立文件**，且**不进快照备份**：
 *   · 密钥属运营商级基础设施配置，不是用户数据；跟着数据回滚被换成一份旧商户配置，
 *     是"改钱"级的意外，宁可显式排除。
 *   · 密文字段由 secretbox 加密，主密钥单独存 data/.secret.key（同样不进备份），
 *     于是备份被整包拿走也解不开商户密钥。
 *   · enabled 默认 false：接进来但这轮不开，先跑通链路再决定上线。
 */
const payStore = new JsonStore(path.join(DATA_DIR, 'pay.json'), pay.newCfg());
payStore.data = pay.sanitizeCfg(payStore.data);
// 1.6.0 余额配置（pricing.json 顶层 balance 块）：注册赠送 / enforce 开关 / 拦截阈值。
// ★ enforce 默认 false = 观察模式：只扣账不拦截。真实成本数据没跑够之前，
//   任何拦截阈值都是拍脑袋——先观察、配准价，再开。
balance.normalizeCfg(pricingStore.data);
pricingStore.save();
/** 当前余额配置（每次读都归一化，改配置即时生效） */
function balanceCfg() { return balance.cfgOf(pricingStore.data); }

/* ---------------- 在线支付网关（1.6.0） ----------------
 * 配置存 pay.json；密钥密文用 secretbox 解出**仅在本进程内**使用，绝不下发、绝不日志。
 */

/**
 * 取支付配置。
 * @param {boolean} withSecrets true 时解出 key / privateKey 明文（仅服务端内部使用）
 */
function payCfg(withSecrets) {
  const c = pay.sanitizeCfg(payStore.data);
  if (!withSecrets) return c;
  const out = Object.assign({}, c);
  out.key = c.keyEnc ? (secretbox.decrypt(DATA_DIR, c.keyEnc) || '') : '';
  out.privateKey = c.privateKeyEnc ? (secretbox.decrypt(DATA_DIR, c.privateKeyEnc) || '') : '';
  // 密文存在但解不开（主密钥换了/密文损坏）——要能说清，不能让它表现成"密钥没填"
  out.keyBroken = !!c.keyEnc && !out.key;
  out.privateKeyBroken = !!c.privateKeyEnc && !out.privateKey;
  return out;
}

/**
 * 站点公网基地址（回调 notify_url 用）。
 * **必须显式配置 PP_PUBLIC_URL**：不能按请求 Host 头推断——
 * 支付下单是公网请求，Host 可被伪造，会把回调指向攻击者域名。
 * 未配置时退回本地地址（此时在线支付不可用，见 onlinePayReady）。
 */
function siteBaseUrl() {
  const u = String(process.env.PP_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (u) return u;
  return 'http://127.0.0.1:' + (process.env.PP_PORT || 8000);
}

/** 在线支付是否真的可用（配置齐 + 公网基地址已显式配置 + 密钥能解开） */
function onlinePayReady() {
  const c = payCfg(true);
  if (!pay.isReady(c)) return false;
  if (c.keyBroken || c.privateKeyBroken) return false;
  return /^https:\/\//i.test(siteBaseUrl());   // 回调必须是公网 https
}

/* ---------------- 订阅额度发放（1.6.0 订阅去无限化） ----------------
 * ★ 不做定时任务：在 /api/auth/me 与网关入口**现场补发**当期额度。
 *   代价是"从不登录的用户不会拿到额度"——他们本来也不用 AI，无影响。
 * ★ 不结转：直接覆盖（不是累加），过期时间 = 当期自然月末。
 */

/** 当期标识：自然月 YYYY-MM（本地时区） */
function planPeriodKey(now) {
  const d = new Date(Number.isFinite(now) ? now : Date.now());
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

/** 当期截止：下月 1 日 0 点（本地时区）——订阅额度作废的时间点 */
function planPeriodEnd(now) {
  const d = new Date(Number.isFinite(now) ? now : Date.now());
  return new Date(d.getFullYear(), d.getMonth() + 1, 1, 0, 0, 0, 0).toISOString();
}

/**
 * 按期发放订阅额度（幂等）。
 * @returns {{micro,periodKey,expiresAt}|null} null = 本期不需要发放
 */
function ensurePlanGrant(user, now) {
  const t = Number.isFinite(now) ? now : Date.now();
  const p = membership.planOf(membershipStore.data, planEffective(user));
  const grantMicro = Math.max(0, Math.round(Number(p.monthlyGrantMicro) || 0));
  if (!grantMicro) return null;                     // 该档不发订阅额度（Free）
  const b = balance.ensure(user);
  const key = planPeriodKey(t);
  // ★ 只认 periodKey，不认余额是否为 0：本期已发过（哪怕已花完）就不再补，
  //   否则会把"不结转"变成"花完自动续杯"
  if (b.planPeriodKey === key) return null;
  const r = balance.grantPlan(user, { micro: grantMicro, periodKey: key, expiresAt: planPeriodEnd(t) }, t);
  if (r) log('plan credit granted:', user.email, planEffective(user), r.micro + ' micro, period', r.periodKey);
  return r;
}

/* ---------------- 工具 ---------------- */

// 日志：始终写 server-console.log（任何启动方式都有排障日志，不依赖 stdout 重定向）；
// 前台交互（TTY）时额外打印到控制台
const LOG_FILE = path.join(DATA_DIR, 'server-console.log');
function log(...a) {
  const line = '[' + new Date().toISOString() + '] ' + a.join(' ');
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) { /* ignore */ }
  if (process.stdout.isTTY) {
    try { console.log(line); } catch (e) { /* stdout 不可用时静默 */ }
  }
}

function uid(prefix) { return prefix + '-' + crypto.randomBytes(6).toString('hex'); }

function today() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/* ---------------- 用量与 AI 成本（近 30 天按日趋势，1.4.3 / 1.5.0 计量） ----------------
 * 旧结构只有 { date, count }（当日计数，跨天即清零），用户看不到趋势、
 * 也无法判断"这个月用了多少"。1.4.3 在不破坏旧字段的前提下增加
 * usage.daily = { 'YYYY-MM-DD': count }，只留最近 30 天。
 * 旧数据（只有 date/count）由 usageDays() 现场兼容，无需迁移。
 *
 * 1.5.0 AI 计费计量：**次数口径不变**（daily 仍是 number，所有旧读取点零改动），
 * 另加三条并行的按日序列 + 一条全时段累计：
 *   usage.inTok[d] / usage.outTok[d]   输入 / 输出 token 按日
 *   usage.costMicro[d]                 当日成本（微元 = 1e-6 元）
 *   usage.byModel[model]               { n, inTok, outTok, costMicro, lastAt }
 *   usage.missingUsage                 ★ 上游未返回 usage 的次数（计量盲区，单独计数）
 * 全部现场补默认值，老账号零迁移。
 */

/** 本地时区的 YYYY-MM-DD（与 today() 同口径，避免 UTC 偏移导致跨天错位） */
function isoDay(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

const USAGE_KEEP_DAYS = 30;
const USAGE_DAY_MAPS = ['daily', 'inTok', 'outTok', 'costMicro'];

/** 丢弃 keepDays 之前的按日记录（字符串比较即可，YYYY-MM-DD 天然有序） */
function pruneDayMap(map, refDay, keepDays) {
  if (!map || typeof map !== 'object') return map;
  const n = Number(keepDays) > 0 ? Number(keepDays) : USAGE_KEEP_DAYS;
  const refMs = Date.parse((refDay || today()) + 'T00:00:00');
  if (Number.isNaN(refMs)) return map;
  const cutoff = isoDay(refMs - (n - 1) * 86400e3);
  for (const k of Object.keys(map)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || k < cutoff) delete map[k];
  }
  return map;
}

/** 兼容旧名（1.4.3 起就在用） */
function pruneUsageDaily(daily, refDay, keepDays) {
  return pruneDayMap(daily, refDay, keepDays);
}

/** 确保 usage 的新结构存在（幂等；老账号现场补，不迁移、不落盘） */
function ensureUsage(user) {
  if (!user.usage || typeof user.usage !== 'object') user.usage = {};
  const u = user.usage;
  for (const k of USAGE_DAY_MAPS) {
    if (!u[k] || typeof u[k] !== 'object' || Array.isArray(u[k])) u[k] = {};
  }
  if (!u.byModel || typeof u.byModel !== 'object' || Array.isArray(u.byModel)) u.byModel = {};
  u.missingUsage = Number(u.missingUsage) || 0;
  return u;
}

/**
 * 记一次用量。dayKey 可注入（单测用），默认今天。
 * 同时维护 { date, count }（旧契约）与 { daily }（新趋势）。
 * 1.5.0 起改为 recordUsage 的**无计量信息**调用（保持旧调用点行为不变）。
 */
function bumpUsage(user, dayKey) {
  return recordUsage(user, { dayKey });
}

/**
 * 记一次网关调用（1.5.0）。
 * usage === null / undefined ⇒ **上游没给用量**，只记次数并把 missingUsage +1。
 * 这是计量盲区：绝不能当成 0 token / 0 成本，否则免费额度会被无声掏空。
 * @param {{model?:string, usage?:{inTok,outTok}|null, costMicro?:number, dayKey?:string}} info
 */
function recordUsage(user, info) {
  const o = info || {};
  const d = o.dayKey || today();
  const u = ensureUsage(user);
  // —— 次数（与 1.4.x 完全一致，旧读取点不受影响）——
  if (u.date !== d) { u.date = d; u.count = 0; }
  u.count = (Number(u.count) || 0) + 1;
  u.daily[d] = (Number(u.daily[d]) || 0) + 1;
  pruneDayMap(u.daily, d);
  // —— token / 成本（1.5.0）——
  if (o.usage && (o.usage.inTok || o.usage.outTok || o.usage.totalTok)) {
    u.inTok[d] = (Number(u.inTok[d]) || 0) + (Number(o.usage.inTok) || 0);
    u.outTok[d] = (Number(u.outTok[d]) || 0) + (Number(o.usage.outTok) || 0);
    u.costMicro[d] = (Number(u.costMicro[d]) || 0) + (Number(o.costMicro) || 0);
    pruneDayMap(u.inTok, d);
    pruneDayMap(u.outTok, d);
    pruneDayMap(u.costMicro, d);
    const key = String(o.model || '').trim().slice(0, 120);
    // byModel 键来自上游响应的 model 字段。正常通道不会产生大量模型名，
    // 但防御性地设个上限：异常/恶意上游返回随机 model 时不会把用户对象撑爆。
    const canAdd = key && (u.byModel[key] || Object.keys(u.byModel).length < 200);
    if (canAdd) {
      const m = u.byModel[key] || { n: 0, inTok: 0, outTok: 0, costMicro: 0 };
      m.n = (Number(m.n) || 0) + 1;
      m.inTok = (Number(m.inTok) || 0) + (Number(o.usage.inTok) || 0);
      m.outTok = (Number(m.outTok) || 0) + (Number(o.usage.outTok) || 0);
      m.costMicro = (Number(m.costMicro) || 0) + (Number(o.costMicro) || 0);
      m.lastAt = new Date().toISOString();
      u.byModel[key] = m;
    }
  } else {
    u.missingUsage += 1;
  }
  return u;
}

/**
 * 取最近 n 天（含当天）的按日用量，缺日补 0 —— 前端画图直接可用。
 * 无 daily 的旧账号：把 { date, count } 当作那一天的值，其余为 0。
 */
function usageDays(user, days, endDay) {
  const n = Math.max(1, Math.min(90, Number(days) || USAGE_KEEP_DAYS));
  const u = (user && user.usage) || {};
  const daily = (u.daily && typeof u.daily === 'object') ? u.daily : {};
  const end = endDay || today();
  const endMs = Date.parse(end + 'T00:00:00');
  const base = Number.isNaN(endMs) ? Date.now() : endMs;
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const key = isoDay(base - i * 86400e3);
    let c = Number(daily[key]) || 0;
    if (!c && u.date === key) c = Number(u.count) || 0;   // 旧数据兜底
    out.push({ date: key, count: c });
  }
  return out;
}

/** 通用：取某张按日映射（inTok/outTok/costMicro）最近 n 天的值，缺日补 0 */
function usageSeriesDays(user, days, mapKey, endDay) {
  const n = Math.max(1, Math.min(90, Number(days) || USAGE_KEEP_DAYS));
  const u = (user && user.usage) || {};
  const map = (u[mapKey] && typeof u[mapKey] === 'object') ? u[mapKey] : {};
  const end = endDay || today();
  const endMs = Date.parse(end + 'T00:00:00');
  const base = Number.isNaN(endMs) ? Date.now() : endMs;
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const key = isoDay(base - i * 86400e3);
    out.push({ date: key, value: Number(map[key]) || 0 });
  }
  return out;
}

/** 某账号最近 n 天的合计（次数 / token / 成本 / 计量盲区） */
function usageTotalsIn(user, days, endDay) {
  const n = Math.max(1, Math.min(90, Number(days) || USAGE_KEEP_DAYS));
  const u = (user && user.usage) || {};
  const sum = (key) => usageSeriesDays(user, n, key, endDay).reduce((s, d) => s + d.value, 0);
  return {
    days: n,
    n: sum('daily'),
    inTok: sum('inTok'),
    outTok: sum('outTok'),
    costMicro: sum('costMicro'),
    missingUsage: Number(u.missingUsage) || 0,
  };
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}

function verifyPassword(user, password) {
  const h = Buffer.from(hashPassword(password, user.salt), 'hex');
  const s = Buffer.from(user.hash, 'hex');
  return h.length === s.length && crypto.timingSafeEqual(h, s);
}

function maskKey(key) {
  const k = String(key || '');
  if (!k) return '';
  if (k.length <= 8) return '****';
  return k.slice(0, 4) + '****' + k.slice(-4);
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > (limit || 5 * 1024 * 1024)) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

/** 原生 http(s) JSON 请求（Title-Case 头名，兼容按大小写提取头的老网关） */
function requestJson(method, url, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('接口地址格式非法')); }
    const mod = u.protocol === 'https:' ? https : http;
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const h = Object.assign({ 'Accept': 'application/json' }, headers || {});
    if (payload) {
      h['Content-Type'] = h['Content-Type'] || 'application/json';
      h['Content-Length'] = payload.length;
    }
    const req = mod.request(u, { method, headers: h, timeout: timeoutMs || 10000 }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = JSON.parse(text); } catch (e) { /* 非 JSON */ }
        resolve({ status: r.statusCode, data, text });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('连接超时')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function netErrorText(e) {
  const msg = (e && e.message) || String(e);
  if (/timed?\s*out|timeout/i.test(msg)) return '连接超时';
  if (/ECONNREFUSED/i.test(msg)) return '无法连接（服务未启动或地址不对）';
  return '网络错误：' + msg.slice(0, 120);
}

/** 客户端真实 IP：经 Cloudflare Tunnel/反向代理回源时 socket 恒为回环，取代理头 */
function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(cf).split(',')[0].trim();
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

/** 管理请求判定：必须「本机直连」= 回环 socket 且无代理头。
 *  Tunnel/反代回源虽也来自回环，但必带 CF-Connecting-IP / X-Forwarded-For——
 *  一律视为公网请求并拒绝管理访问（公网只开放注册/登录/网关）。 */
function isLocalAdmin(req) {
  if (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']) return false;
  const ra = req.socket.remoteAddress || '';
  return ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
}

function slug(name, fallback) {
  const s = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || fallback || 'ch';
}

/* ---------------- 账号域 ---------------- */

function planEffective(user) {
  // 套餐有效期过期 → 降级 Free 限额（不踢下线，插件端契约无需新增错误码）
  if (user.expiresAt && Date.now() > new Date(user.expiresAt).getTime()) return 'Free';
  return user.plan || 'Free';
}

/**
 * 每日额度（0.23.0 起由套餐配置驱动）：
 *   管理员在用户级显式设置的 dailyLimit 优先 → 否则取该等级在 membership.json
 *   里配置的 dailyLimit。等级/额度调整只需改后台配置，无需动代码。
 */
function dailyLimitOf(user) {
  if (Number(user.dailyLimit) > 0) return Number(user.dailyLimit);
  return membership.dailyLimitFor(membershipStore.data, planEffective(user));
}

function dailyUsedOf(user) {
  return user.usage && user.usage.date === today() ? Number(user.usage.count) || 0 : 0;
}

/**
 * 账号的成本视图（1.5.0）。金额一律同时给「微元」与已格式化文案，
 * 前端不做换算也不做舍入——避免前后端口径不一致。
 */
function costViewOf(user) {
  const t = usageTotalsIn(user, 1);
  const d7 = usageTotalsIn(user, 7);
  const d30 = usageTotalsIn(user, USAGE_KEEP_DAYS);
  const one = (x) => ({
    inTok: x.inTok, outTok: x.outTok, totalTok: x.inTok + x.outTok,
    costMicro: x.costMicro, text: pricing.microText(x.costMicro),
    tokensText: pricing.tokText(x.inTok + x.outTok),
  });
  return {
    today: one(t), last7: one(d7), last30: one(d30),
    // ★ 上游未返回 usage 的次数：成本是「未知」而不是 0，必须让界面说清楚
    missingUsage: Number((user.usage && user.usage.missingUsage) || 0),
    currency: pricingStore.data.currency || 'CNY',
  };
}

/** 客户端可见的用户对象（docs 契约字段 + 0.23.0 会员视图） */
function userForClient(user) {
  const out = {
    email: user.email,
    name: user.nickname || user.email,
    plan: planEffective(user),
    dailyUsed: dailyUsedOf(user),
    dailyLimit: dailyLimitOf(user),
    status: user.status === 'pending' ? 'pending' : 'active',
    membership: membership.membershipOf(membershipStore.data, user),
    // 1.4.3 用量趋势（近 30 天按日；days 供前端画图，last7 为近 7 天合计）
    usage: {
      today: dailyUsedOf(user),
      limit: dailyLimitOf(user),
      last7: usageDays(user, 7).reduce((s, d) => s + d.count, 0),
      days: usageDays(user, USAGE_KEEP_DAYS),
    },
    // 1.5.0 AI 计量：今日 / 近 7 天 / 近 30 天 token 与成本（为按量计费铺路）
    cost: costViewOf(user),
    // 1.6.0 余额（注册赠送 + 充值；enforce=false 时仅展示与记账，不拦截）
    balance: balance.userView(user, balanceCfg()),
  };
    if (user.expiresAt) out.expiresAt = user.expiresAt; // 套餐有效期（可缺省）
    // 1.4.9 套餐 AI 能力（供插件端展示与升级引导；lockedModels 让面板能灰显）
    const av = modelsForUser(user);
    out.ai = {
      highTier: av.highTier,
      reason: av.reason,              // plan | trial | none
      trial: av.trial,                // {active, days, endsAt, daysLeft}
      models: av.models,              // 当前可用
      lockedModels: av.locked,        // 需升级（升级引导用）
      defaultModel: 'auto',
    };
  return out;
}

function findUserByEmail(email) {
  return usersStore.data.users.find((u) => u.email.toLowerCase() === String(email).toLowerCase()) || null;
}

function findUserById(id) {
  return usersStore.data.users.find((u) => u.id === id) || null;
}

function pruneTokens() {
  const now = Date.now();
  let changed = false;
  for (const [tok, rec] of Object.entries(usersStore.data.tokens || {})) {
    if (!rec || rec.expiresAt < now || !findUserById(rec.userId)) {
      delete usersStore.data.tokens[tok];
      changed = true;
    }
  }
  if (changed) usersStore.save();
}

/** 令牌仅存散列（数据文件泄露也不至于直接拿到可用令牌） */
function tokenKey(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** 请求头里的 Bearer 令牌原文（未带则空串） */
function bearerToken(req) {
  return (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
}

/** 当前请求所用的会话 id（= 令牌散列前 8 位；无法反推令牌） */
function currentSid(req) {
  const b = bearerToken(req);
  return b ? sessions.sidOf(tokenKey(b)) : '';
}

/**
 * 签发令牌。1.4.7 起同时记录**设备与会话元数据**（sid / 创建时间 / 来源 IP / 插件上报的设备信息），
 * 这样后台才能回答「这个账号在几台机器上登录着」，也才有据可查账号共享。
 */
function issueToken(userId, opts) {
  const token = 'pp-' + crypto.randomBytes(24).toString('hex');
  const key = tokenKey(token);
  usersStore.data.tokens = usersStore.data.tokens || {};
  const rec = { userId, expiresAt: Date.now() + TOKEN_TTL_MS };
  const req = opts && opts.req;
  sessions.recordStart(rec, {
    tokenKey: key,
    ip: req ? clientIp(req) : '',
    device: req ? sessions.deviceFromHeaders(req.headers) : null,
  });
  usersStore.data.tokens[key] = rec;
  return token;
}

/** 一次性令牌（邮箱验证 / 密码重置）：仅存 SHA-256 散列 + 有效期 */
function oneTimeToken() { return crypto.randomBytes(24).toString('hex'); }

function findUserByOneTimeToken(field, token) {
  const hash = tokenKey(String(token || ''));
  const now = Date.now();
  for (const u of usersStore.data.users) {
    const rec = u[field];
    if (rec && rec.hash === hash) {
      if (rec.expiresAt < now) return { user: u, expired: true };
      return { user: u, expired: false };
    }
  }
  return null;
}

function userByToken(req) {
  const auth = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  if (!auth) return null;
  const rec = (usersStore.data.tokens || {})[tokenKey(auth)];
  if (!rec || rec.expiresAt < Date.now()) return null;
  const user = findUserById(rec.userId);
  return user || null;
}

function touchToken(req) {
  const auth = bearerToken(req);
  const rec = auth && (usersStore.data.tokens || {})[tokenKey(auth)];
  if (!rec) return;
  rec.expiresAt = Date.now() + TOKEN_TTL_MS;          // 滑动续期
  sessions.recordSeen(rec, { ip: clientIp(req) });    // 1.4.7：最近活动（活跃设备判据）
}

/** 滑动续期（网关高频路径用）：内存即时续期，磁盘落盘按 30s 节流——
 *  避免每次 AI 调用都重写 users.json（含密码散列，文件不小）。停机/崩溃兜底：
 *  shutdown 时强制落盘；即便丢最后一次续期也只是提前一天过期，无安全影响。 */
let _tokenSaveTimer = null;
function touchTokenSoon(req) {
  const auth = bearerToken(req);
  const rec = auth && (usersStore.data.tokens || {})[tokenKey(auth)];
  if (!rec) return;
  rec.expiresAt = Date.now() + TOKEN_TTL_MS;
  // 只改内存 + 复用既有的 30s 落盘节流 —— 不因记录活跃时间而增加写盘频率
  sessions.recordSeen(rec, { ip: clientIp(req) });
  if (!_tokenSaveTimer) {
    _tokenSaveTimer = setTimeout(() => {
      _tokenSaveTimer = null;
      try { usersStore.save(); } catch (e) { log('token touch save failed:', e.message); }
    }, 30e3);
    if (typeof _tokenSaveTimer.unref === 'function') _tokenSaveTimer.unref();
  }
}

const rateAttempts = new Map(); // key → [ts]
function rateThrottled(key, max, windowMs) {
  const now = Date.now();
  const list = (rateAttempts.get(key) || []).filter((t) => now - t < windowMs);
  if (list.length >= max) { rateAttempts.set(key, list); return true; }
  list.push(now);
  rateAttempts.set(key, list);
  return false;
}

/**
 * 网关成功转发后落一次用量（1.5.0 起带 token 与成本）。
 * info = { model, usage, costMicro, dayKey }；不传即只记次数（旧行为）。
 */
function countUsage(user, info) {
  recordUsage(user, info);
  usersStore.save();
}

/* ---------------- 通道域（官方网关上游池） ---------------- */

function sanitizeModels(list) {
  if (!Array.isArray(list)) return undefined;
  const out = [];
  for (const m of list) {
    const s = String(m == null ? '' : m).trim();
    if (s && s.length <= 120 && !out.includes(s)) out.push(s);
    if (out.length >= 200) break;
  }
  return out;
}

function validExtra(extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return null;
  return extra;
}

function channelOut(c) {
  return {
    id: c.id, name: c.name || c.id, provider: c.provider || '',
    baseUrl: c.baseUrl, apiKeyMasked: maskKey(c.apiKey),
    model: c.model || 'auto', models: Array.isArray(c.models) ? c.models : [],
    extraBody: c.extraBody || {}, timeoutMs: c.timeoutMs || 12000,
    // 1.5.0 计量开关：流式请求是否要求上游返回 usage（默认开；个别上游不认会 400）
    streamUsage: c.streamUsage !== false,
  };
}

function providerNoKey(providerId, baseUrl) {
  if (providerId === 'ollama') return true;
  return /127\.0\.0\.1|localhost/.test(String(baseUrl || ''));
}

/** 通道 upsert（与插件端 channels.js 校验规则一致；编辑时 apiKey 留空=保持原值） */
function upsertChannel(input, existingId) {
  if (!input || typeof input !== 'object') return { error: '参数缺失' };
  const channels = channelsStore.data.channels;
  const id = String(input.id || existingId || '').trim();
  if (!/^[a-z0-9-]+$/.test(id)) return { error: '通道 id 必填（小写字母/数字/连字符）' };
  const idx = channels.findIndex((c) => c && c.id === id);
  const existing = idx >= 0 ? channels[idx] : null;

  const apiKey = String(input.apiKey || '') || (existing && existing.apiKey) || '';
  const baseUrl = String(input.baseUrl || (existing && existing.baseUrl) || '').replace(/\/+$/, '');
  if (!baseUrl && !(existing && existing.baseUrl)) return { error: '接口地址 baseUrl 必填' };
  const provider = input.provider !== undefined
    ? String(input.provider || '').slice(0, 40) : (existing && existing.provider) || '';
  if (!apiKey && !providerNoKey(provider, baseUrl)) {
    return { error: 'API Key 必填（本地 Ollama 等免密接口除外）' };
  }
  const models = sanitizeModels(input.models);
  const clean = {
    id,
    name: String(input.name || (existing && existing.name) || id).slice(0, 60),
    provider,
    baseUrl,
    apiKey,
    model: String(input.model || (existing && existing.model) || 'auto'),
    models: models !== undefined ? models : (existing && Array.isArray(existing.models) ? existing.models : []),
    extraBody: validExtra(input.extraBody) || (existing && existing.extraBody) || {},
    timeoutMs: Number(input.timeoutMs) || (existing && existing.timeoutMs) || 12000,
  };
  // streamUsage：局部更新（未传则保持原值/默认开），只允许显式 false 关闭
  clean.streamUsage = input.streamUsage === undefined
    ? (existing ? existing.streamUsage !== false : true)
    : input.streamUsage !== false;
  if (idx >= 0) channels[idx] = clean; else channels.push(clean);
  if (!channelsStore.data.active) channelsStore.data.active = clean.id;
  channelsStore.save();
  return { channel: clean };
}

/** GET {baseUrl}/models → {ok,models,latencyMs} | {ok:false,error} */
async function fetchModelsOf({ baseUrl, apiKey, timeoutMs }) {
  const t0 = Date.now();
  const bu = String(baseUrl || '').trim().replace(/\/+$/, '');
  let r;
  try {
    r = await requestJson('GET', bu + '/models',
      apiKey ? { 'Authorization': 'Bearer ' + apiKey } : {}, undefined, timeoutMs || 8000);
  } catch (e) { return { ok: false, error: netErrorText(e) }; }
  if (r.status >= 400) {
    const hint = r.status === 401 || r.status === 403 ? '（密钥无效或无权限）' : '';
    return { ok: false, error: 'HTTP ' + r.status + hint };
  }
  const data = r.data || {};
  const raw = Array.isArray(data.data) ? data.data : (Array.isArray(data.models) ? data.models : []);
  const models = [];
  for (const m of raw) {
    const s = typeof m === 'string' ? m : String((m && (m.id || m.name)) || '').trim();
    if (s && !models.includes(s)) models.push(s);
    if (models.length >= 300) break;
  }
  if (!models.length) return { ok: false, error: '上游未返回任何模型' };
  return { ok: true, models, latencyMs: Date.now() - t0 };
}

/** 按密钥格式圈定候选厂商（特异格式唯一；与插件端同源逻辑） */
function candidatesByKey(apiKey) {
  const k = String(apiKey || '').trim();
  if (!k) return [];
  const uniq = PROVIDERS.filter((p) => p.keyHint && p.keyHint.unique && p.keyHint.re.test(k));
  if (uniq.length) return uniq;
  const generic = PROVIDERS.filter((p) => p.keyHint && !p.keyHint.unique && p.keyHint.re.test(k));
  if (generic.length) return generic;
  return PROVIDERS.filter((p) => !p.custom && p.baseUrl && !/127\.0\.0\.1|localhost/.test(p.baseUrl));
}

/** 自动探测：有 baseUrl 直探；只有 key 按格式圈候选并行探，首个应答者胜出 */
async function detectChannel({ apiKey, baseUrl, timeoutMs }) {
  const key = String(apiKey || '').trim();
  const bu = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!key && !bu) return { ok: false, error: 'apiKey 与 baseUrl 至少填一项' };

  if (bu) {
    const preset = PROVIDERS.find((p) => p.baseUrl &&
      (bu === p.baseUrl || bu.startsWith(p.baseUrl + '/') || p.baseUrl.startsWith(bu + '/')));
    const r = await fetchModelsOf({ baseUrl: bu, apiKey: key, timeoutMs });
    if (!r.ok) return { ok: false, error: r.error, provider: preset ? preset.id : 'custom', baseUrl: bu, models: [] };
    return { ok: true, provider: preset ? preset.id : 'custom', providerName: preset ? preset.name : '自定义接口',
      baseUrl: bu, models: r.models, latencyMs: r.latencyMs };
  }

  const cands = candidatesByKey(key).slice(0, 10);
  if (!cands.length) return { ok: false, error: '无法根据密钥格式识别厂商，请手动填写接口地址' };
  const results = await Promise.all(cands.map(async (p) => {
    const r = await fetchModelsOf({ baseUrl: p.baseUrl, apiKey: key, timeoutMs: timeoutMs || 8000 });
    return r.ok ? { provider: p, models: r.models, latencyMs: r.latencyMs } : null;
  }));
  const matches = results.filter(Boolean);
  if (!matches.length) {
    const uniqueHit = cands.length === 1 && cands[0].keyHint && cands[0].keyHint.unique;
    return {
      ok: false, tried: cands.map((p) => p.id),
      provider: uniqueHit ? cands[0].id : '',
      error: uniqueHit
        ? '密钥格式像「' + cands[0].name + '」但探测失败（密钥无效/欠费/网络不可达），已按该厂商预填，可手动修正'
        : '所有候选厂商探测均失败（密钥无效或网络不可达），请手动填写接口地址',
    };
  }
  const best = matches[0];
  return { ok: true, provider: best.provider.id, providerName: best.provider.name,
    baseUrl: best.provider.baseUrl, models: best.models, latencyMs: best.latencyMs,
    matches: matches.map((m) => m.provider.id) };
}

/** 通道实测：小负荷一次调用，预算内对 5xx/超时/网络抖动重试一次 */
async function testChannelById(id) {
  const c = channelsStore.data.channels.find((x) => x && x.id === id);
  if (!c) return { ok: false, error: '通道不存在' };
  if (!c.apiKey && !providerNoKey(c.provider, c.baseUrl)) return { ok: false, error: '该通道缺少 API Key' };
  const t0 = Date.now();
  const body = {
    model: c.model || 'auto',
    messages: [
      { role: 'system', content: '你是连通性测试助手，用一句中文回答。' },
      { role: 'user', content: '请回复：通道正常' },
    ],
    temperature: 0.4,
    max_tokens: 120,
    ...(c.extraBody || {}),
  };
  const once = async (timeoutMs) => {
    let r;
    try {
      r = await requestJson('POST', String(c.baseUrl).replace(/\/+$/, '') + '/chat/completions',
        { 'Authorization': 'Bearer ' + (c.apiKey || ''), 'Content-Type': 'application/json' },
        body, timeoutMs);
    } catch (e) {
      return { error: netErrorText(e), retryable: true };
    }
    if (r.status >= 400) {
      return { error: 'HTTP ' + r.status + (r.status === 401 || r.status === 403 ? '（密钥无效或未授权）' : ''),
        retryable: r.status >= 500 || r.status === 429 };
    }
    const msg = r.data && r.data.choices && r.data.choices[0] && r.data.choices[0].message;
    const text = msg && msg.content ? String(msg.content).trim() : '';
    if (!text) return { error: '模型返回内容为空', retryable: true };
    return { text, model: (r.data && r.data.model) || c.model, latencyMs: Date.now() - t0 };
  };
  const budget = c.timeoutMs || 12000;
  const deadline = Date.now() + budget;
  let r = await once(budget);
  if (r.error && r.retryable && deadline - Date.now() >= 800) {
    await new Promise((ok) => setTimeout(ok, 350));
    r = await once(deadline - Date.now());
  }
  if (r.error) return { ok: false, error: r.error };
  return { ok: true, model: r.model, latencyMs: r.latencyMs, reply: (r.text || '').slice(0, 60) };
}

/* ---------------- 官方网关（/v1/*） ---------------- */

function activeChannel() {
  const doc = channelsStore.data;
  if (!doc.active) return null;
  return doc.channels.find((c) => c && c.id === doc.active) || null;
}

/** 对外上线模型清单（0.15.0）：channels.json 顶层 publishedModels。
 * 空/缺省 = 全部上线（兼容既有部署）；非空 = 仅上线清单内模型（auto 恒放行）。
 * 后台据此控制官方模型分批上线：不一次性暴露全部上游模型。 */
function publishedModels() {
  const s = sanitizeModels(channelsStore.data.publishedModels);
  return s || [];
}

/** 官方网关「全部可用模型」（不区分套餐）。auto 恒在首位。 */
function gatewayModelsAll() {
  const pub = publishedModels();
  const c = activeChannel();
  const out = ['auto'];
  const src = pub.length ? pub : ((c && c.models) || []);
  for (const m of src) {
    if (!out.includes(m)) out.push(m);
  }
  return out;
}

/**
 * 高级模型清单（1.4.9）：channels.json 顶层 highTierModels。
 * 语义与 publishedModels 正交 —— publishedModels 定「对外可见/可调用的范围」，
 * highTierModels 定「其中哪些属于付费档」。两者是子集关系（不是子集也不报错，
 * 交集外的项自然不生效）。auto 恒免费，即使被误配也不受影响。
 */
function highTierModels() {
  const s = sanitizeModels(channelsStore.data.highTierModels);
  return s || [];
}

/* ---------------- 套餐 AI 能力（1.4.9） ---------------- */

/**
 * 新用户「全模型试用」状态。
 * 起点取 user.createdAt 现场计算 ⇒ 零迁移、无需落盘；改 membership.ai.trialDays
 * 即对全体生效（缩短会立即结束进行中的试用，这是政策语义，不额外记账）。
 */
function trialOf(user, now) {
  // 计算逻辑在 membership.trialState（纯函数，单测覆盖到毫秒边界）
  return membership.trialState(
    user && user.createdAt,
    membership.trialDaysFor(membershipStore.data),
    now
  );
}

/**
 * 此刻能否使用高级模型。三条路径：
 *   plan  = 套餐本身含高级模型（plans[].highTierModels）
 *   trial = Free 但在新用户试用期内
 *   none  = 不能用
 * 注意：**过期不踢下线**的既有语义在这里同样成立 —— 套餐过期后 planEffective
 * 回落 Free，高级模型也跟着回落，但会话与其它功能不受影响。
 */
function highTierAccess(user, now) {
  const plan = planEffective(user);
  const p = membership.planOf(membershipStore.data, plan);
  const tr = trialOf(user, now);
  if (p && p.highTierModels) return { allowed: true, reason: 'plan', trial: tr };
  if (tr.active) return { allowed: true, reason: 'trial', trial: tr };
  return { allowed: false, reason: 'none', trial: tr };
}

/**
 * 该用户在官方网关上可用的模型集合。
 * models = 可调用；locked = 需升级才能用（供插件端灰显 + 升级引导）。
 * **auto 永不被锁**（它映射到通道默认模型，是全部用户的兜底入口）。
 */
function modelsForUser(user, now) {
  const all = gatewayModelsAll();
  const hi = highTierModels();
  const acc = highTierAccess(user, now);
  const isHi = (m) => m !== 'auto' && hi.includes(m);
  const locked = all.filter(isHi);
  return {
    models: acc.allowed ? all.slice() : all.filter((m) => !isHi(m)),
    locked: acc.allowed ? [] : locked,
    highTier: acc.allowed,
    reason: acc.reason,
    trial: acc.trial,
  };
}

/** 转发 chat/completions：auto→通道模型、合并 extraBody、SSE 透传、用量计数 */
function gatewayChat(req, res, user) {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > 8 * 1024 * 1024) { json(res, 413, { ok: false, error: '请求体过大' }); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', async () => {
    let body = {};
    try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; }
    catch (e) { return json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); }

    // 全局限速：每 IP 每分钟 GATEWAY_MAX 次（正常科研对话远低于此；防高频脚本薅上游 Key）
    if (rateThrottled('gw:' + clientIp(req), GATEWAY_MAX, LOGIN_WINDOW_MS)) {
      return json(res, 429, { ok: false,
        error: '请求过于频繁（每 IP 每分钟 ' + GATEWAY_MAX + ' 次），请稍后再试' });
    }

    const c = activeChannel();
    if (!c) {
      return json(res, 503, { ok: false,
        error: '官方网关尚未配置模型通道：请在「启动管理器」或后台管理页添加并启用一条通道' });
    }

    // 0.15.0 模型上线管控：后台配置了 publishedModels 时，显式指定的模型必须在
    // 上线清单内（auto 恒放行——映射到通道默认模型，由通道 model 字段另行控制）
    const pub = publishedModels();
    const asked = (!body.model || body.model === 'auto') ? null : String(body.model);
    if (pub.length && asked && !pub.includes(asked)) {
      return json(res, 400, { ok: false,
        error: '模型 ' + asked + ' 暂未开放。当前开放模型：auto、' + pub.join('、') });
    }

    // 1.4.9 套餐 AI 能力：高级模型需套餐内含或处于试用期。
    // 与上线清单一样**明确拒绝**而不是静默换成便宜模型——静默降级会让用户
    // 以为在用自己选的模型，比报错危险得多。
    const acc = modelsForUser(user);
    if (asked && !acc.models.includes(asked)) {
      const why = acc.trial && acc.trial.days
        ? '新用户全模型试用已于 ' + String(acc.trial.endsAt || '').slice(0, 10) + ' 结束'
        : '该模型属于高级模型，需要专业版';
      return json(res, 403, { ok: false, code: 'MODEL_REQUIRES_PRO',
        error: why + '。当前可用：' + acc.models.join('、') + '；升级后可用：'
          + (acc.locked || []).join('、') });
    }

    // 1.6.0 现场补发当期订阅额度（幂等）——用户只要在用就会拿到当月额度
    ensurePlanGrant(user);

    // ★ 次数额度（dailyLimit）只在**观察模式**下生效：
    //   观察模式 = 次数管、余额只记账；开启 enforce 后改由余额管，
    //   否则"订阅去无限化"就是空话（用户既拿每月额度、又享受每日 3000 次）。
    if (!balanceCfg().enforce && dailyUsedOf(user) >= dailyLimitOf(user)) {
      return json(res, 429, { ok: false,
        error: '今日官方模型用量已达上限（' + dailyLimitOf(user) + ' 次），明日自动重置；或在设置中配置自己的模型通道' });
    }

    // 模型映射与 extraBody 合并（不覆盖调用方已有键）
    const upstreamBody = Object.assign({}, body);
    if (!upstreamBody.model || upstreamBody.model === 'auto') upstreamBody.model = c.model || 'auto';
    for (const [k, v] of Object.entries(c.extraBody || {})) {
      if (!(k in upstreamBody)) upstreamBody[k] = v;
    }
    // 1.5.0 计量：流式必须让上游在最后一片带上 usage，否则流式调用**完全无法计费**
    // （绝大多数 OpenAI 兼容上游默认不返回）。通道可设 streamUsage:false 关掉
    // ——少数上游不认 stream_options 会直接 400，那种通道需要后退。
    const wantStreamUsage = !!body.stream && c.streamUsage !== false;
    if (wantStreamUsage) {
      upstreamBody.stream_options = Object.assign({}, upstreamBody.stream_options, { include_usage: true });
    }
    const payload = Buffer.from(JSON.stringify(upstreamBody), 'utf8');

    // 1.6.0 余额 pre-check：放在 auto 解析之后，高级模型判定才准确。
    // enforce=false（观察模式）恒放行，只记账不拦——真实成本数据没跑够之前
    // 任何阈值都是拍脑袋，先观察、配准价、再开。
    const isHighTier = highTierModels().includes(String(upstreamBody.model));
    const gate = balance.precheck(user, balanceCfg(), { highTier: isHighTier });
    if (!gate.allowed) {
      return json(res, 402, { ok: false, code: gate.code, error: gate.error,
        balance: balance.userView(user, balanceCfg()) });
    }

    let u;
    try { u = new URL(String(c.baseUrl).replace(/\/+$/, '') + '/chat/completions'); }
    catch (e) { return json(res, 500, { ok: false, error: '通道 baseUrl 非法：' + c.baseUrl }); }

    const mod = u.protocol === 'https:' ? https : http;
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': payload.length,
      'Accept': body.stream ? 'text/event-stream' : 'application/json',
    };
    if (c.apiKey) headers['Authorization'] = 'Bearer ' + c.apiKey;

    const timeout = Math.min(Number(c.timeoutMs) > 0 ? Number(c.timeoutMs) * 5 : GATEWAY_TIMEOUT_MS, GATEWAY_TIMEOUT_MS);
    const isStream = !!body.stream;
    const requestedModel = String(upstreamBody.model || '');
    let meterTail = '';          // 流式：未成行的 SSE 尾巴（有界，不随响应增长）
    let respModel = '';          // 响应里的真实模型名（auto 会被上游解析成真名）
    let respUsage = null;        // 从上游 usage 解析出的 token 数；null = 计量盲区
    let plainChunks = [];        // 非流式：响应体（用于解析 usage）
    let plainSize = 0;
    let plainAbandoned = false;  // 响应体过大 → 放弃解析（只影响计量，不影响转发）

    /** 从任意 JSON 对象提取 model / usage（非流式 body 与流式分片共用） */
    const absorb = (j) => {
      if (!j || typeof j !== 'object') return;
      if (j.model) respModel = String(j.model);
      if (j.usage) {
        const uu = pricing.usageOf(j.usage);
        if (uu) respUsage = uu;
      }
    };
    /** 逐行扫描 SSE：只保留未成行的尾巴，内存不随响应体量增长 */
    const scanSse = (text) => {
      meterTail += text;
      let idx;
      while ((idx = meterTail.indexOf('\n')) >= 0) {
        const line = meterTail.slice(0, idx).trim();
        meterTail = meterTail.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try { absorb(JSON.parse(data)); } catch (e) { /* 跨行分片或非 JSON：忽略 */ }
      }
      if (meterTail.length > 1e6) meterTail = meterTail.slice(-4096);   // 防御异常超长行
    };

    const upReq = mod.request(u, { method: 'POST', headers, timeout }, (upRes) => {
      const passHeaders = {};
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (['connection', 'transfer-encoding', 'keep-alive'].includes(k)) continue;
        passHeaders[k] = v;
      }
      passHeaders['Cache-Control'] = 'no-store';
      res.writeHead(upRes.statusCode, passHeaders);
      const ok = upRes.statusCode < 400;

      upRes.on('data', (chunk) => {
        if (!res.writableEnded) {
          // 手动转发（原先 pipe 无法旁路解析）；保留基本背压处理
          if (!res.write(chunk)) { upRes.pause(); res.once('drain', () => upRes.resume()); }
        }
        if (!ok) return;
        if (isStream) scanSse(chunk.toString('utf8'));
        else if (!plainAbandoned) {
          plainChunks.push(chunk);
          plainSize += chunk.length;
          if (plainSize > PLAIN_METER_MAX) { plainChunks = []; plainAbandoned = true; }
        }
      });
      upRes.on('end', () => {
        if (!res.writableEnded) { try { res.end(); } catch (e) { /* ignore */ } }
        if (!ok) return;   // 上游 4xx/5xx：不计次（旧行为）。上游是否已产生成本无从得知，保持原口径。
        try {
          if (!isStream && !plainAbandoned) {
            try { absorb(JSON.parse(Buffer.concat(plainChunks).toString('utf8'))); }
            catch (e) { /* 非 JSON 响应：usage 记为缺失 */ }
          }
          // ★ 计价用「响应里的真实模型」：auto 会被上游映射成真名，
          //   按请求里的 "auto" 计价会让成本统计彻底失真。
          const billModel = respModel || requestedModel;
          const cost = respUsage ? pricing.costOf(pricingStore.data, billModel, respUsage) : null;
          // 1.6.0 余额扣减：按真实成本扣（允许透支——拦截由请求前的 pre-check 负责）。
          // 必须在 countUsage 之前：countUsage 内部的 usersStore.save() 会把余额一并落盘。
          if (cost && cost.micro > 0) {
            balance.consume(user, cost.micro, {
              highTier: highTierModels().includes(billModel),
              reason: 'AI 调用 ' + billModel,
            });
          }
          countUsage(user, { model: billModel, usage: respUsage, costMicro: cost ? cost.micro : 0 });
          if (!respUsage) {
            log('metering: 上游未返回 usage →', billModel, '（计入 missingUsage，成本未知）');
          } else if (!cost.known) {
            log('metering: 模型未配置单价 →', billModel,
              '（' + (respUsage.inTok + respUsage.outTok) + ' token 按兜底 0 计，请在后台补价）');
          }
        } catch (e) { log('usage count failed:', e.message); }
      });
    });
    upReq.on('timeout', () => {
      upReq.destroy(new Error('上游连接超时'));
    });
    upReq.on('error', (e) => {
      if (res.headersSent) { try { res.end(); } catch (_) { /* ignore */ } return; }
      json(res, 502, { ok: false, error: '上游请求失败：' + netErrorText(e) });
    });
    upReq.write(payload);
    upReq.end();
  });
}

/* ---------------- 快照 / 告警 / 风控（1.4.2 运维三件套） ---------------- */

const PUBLIC_URL_FALLBACK = 'https://pp.xinglintools.top';

function publicUrl() {
  return String(process.env.PP_PUBLIC_URL || PUBLIC_URL_FALLBACK).replace(/\/+$/, '');
}

/**
 * 告警收件人：PP_ALERT_EMAIL（逗号分隔可多个）。
 * 不配置也能跑——只是退化为「只写 alerts.log」，后台会明确提示怎么开。
 * 刻意不默认取 PP_MAIL_FROM（那通常是 noreply，发过去没人看）。
 */
function alertRecipients() {
  return String(process.env.PP_ALERT_EMAIL || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

function alertLogPath() { return path.join(DATA_DIR, 'alerts.log'); }

/** alerts.log 追加（保留最后 2000 行，防止无限增长） */
function appendAlertLog(line) {
  const p = alertLogPath();
  let text = '';
  try { text = fs.readFileSync(p, 'utf8'); } catch (e) { /* 首次写 */ }
  let lines = (text + line + '\n').split('\n');
  if (lines.length > 2000) lines = lines.slice(lines.length - 2000);
  fs.writeFileSync(p, lines.join('\n'), 'utf8');
}

/** alerts.log 尾部若干行（后台直接展示，不用去翻文件） */
function readAlertLogTail(n) {
  try {
    const lines = fs.readFileSync(alertLogPath(), 'utf8').split('\n').filter(Boolean);
    return lines.slice(-(n || 20));
  } catch (e) { return []; }
}

/**
 * 改动前打快照。**失败绝不影响主流程**——它是保险，不是前置条件。
 * 同 reason 在节流窗口内只留第一份（保住「这一串改动开始前」的状态）。
 */
function snapshot(reason, opts) {
  try {
    const r = backup.snapshot(DATA_DIR, reason, opts);
    if (!r.skipped) log('snapshot:', r.snapshot.id, '(' + r.snapshot.files.length + ' files)');
    return r;
  } catch (e) {
    log('snapshot FAILED (' + reason + '):', e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * 记一条管理操作审计（1.4.4）。**写入失败绝不影响主流程** —— 审计是留痕，不是前置条件；
 * 但也不能静默：失败时至少往 console 日志留一行。
 */
function auditLog(req, action, opts) {
  const o = opts || {};
  try {
    const r = audit.append(DATA_DIR, {
      action, target: o.target, before: o.before, after: o.after, note: o.note,
      ip: req ? clientIp(req) : '', ok: o.ok === false ? false : true,
    });
    if (!r.ok) log('audit write failed:', r.error);
  } catch (e) {
    log('audit write failed:', e && e.message);
  }
}

/** 回滚后把内存 store 换成磁盘内容（否则会继续用回滚前的旧数据对外服务） */
function reloadStores() {
  const before = { users: usersStore.data.users.length, orders: membershipStore.data.orders.length };
  usersStore.reload();
  channelsStore.reload();
  membershipStore.reload();
  membershipStore.data = membership.normalize(membershipStore.data);
  // 1.5.0：单价表也参与快照回滚，回滚后必须一并重载，否则内存里还是旧价
  pricingStore.reload();
  pricingStore.data = pricing.normalize(pricingStore.data);
  balance.normalizeCfg(pricingStore.data);
  return {
    before,
    after: { users: usersStore.data.users.length, orders: membershipStore.data.orders.length },
  };
}

/** 当前积压视图 */
function backlogNow(now) {
  return alerts.backlogOf(membershipStore.data, { now });
}

/**
 * 巡检一次积压，必要时告警（写 alerts.log + 发邮件）。
 * force=true 忽略去重直接告警（后台「立即测试」用）；dryRun=true 只算不发。
 */
async function runAlertCheck({ now, force, dryRun } = {}) {
  const t = now || Date.now();
  const bl = backlogNow(t);
  const dev = deviceAlertNow(t);
  const state = (alertStore.data && typeof alertStore.data === 'object') ? alertStore.data : {};
  // 设备告警状态放在 alerts.json 的 `sessions` 命名空间下 —— 不动既有积压状态的形状
  const devState = (state.sessions && typeof state.sessions === 'object') ? state.sessions : {};

  const needBacklog = force ? (bl.count > 0 && bl.over) : alerts.shouldAlert(state, bl, { now: t });
  const needDev = force ? dev.over : sessions.shouldAlert(devState, dev, { now: t });
  if (!needBacklog && !needDev) {
    return {
      backlog: alerts.view(state, bl), alerted: false, mailed: false,
      devices: Object.assign(sessions.view(devState, dev), { alerted: false, mailed: false }),
    };
  }

  const to = alertRecipients();
  const ctx = { dryRun, to, mailError: '' };
  if (!dryRun && to.length && !mail.configured()) ctx.mailError = '邮件服务未配置（PP_RESEND_KEY）';
  else if (!dryRun && !to.length) ctx.mailError = '未配置收件人（PP_ALERT_EMAIL）';

  let mailed = false;
  if (needBacklog) {
    const line = alerts.logLine(bl) + ' at=' + new Date(t).toISOString();
    try { appendAlertLog(line); } catch (e) { log('alert log failed:', e.message); }
    log('ALERT', line);
    mailed = await sendAlertMail(ctx, alerts.buildMail(bl, { serverUrl: publicUrl() }));
    alertStore.data = alerts.record(state, bl, { mailed, now: t });
  }

  let devMailed = false;
  if (needDev) {
    const line = sessions.logLine(dev) + ' at=' + new Date(t).toISOString();
    try { appendAlertLog(line); } catch (e) { log('device alert log failed:', e.message); }
    log('ALERT', line);
    devMailed = await sendAlertMail(ctx, sessions.buildMail(dev, { serverUrl: publicUrl() }));
    alertStore.data = Object.assign(alertStore.data || {}, {
      sessions: sessions.record(devState, dev, { mailed: devMailed, now: t }),
    });
  }

  if (needBacklog || needDev) {
    try { alertStore.save(); } catch (e) { log('alert state save failed:', e.message); }
  }
  return {
    backlog: alerts.view(alertStore.data, bl), alerted: needBacklog, mailed,
    devices: Object.assign(sessions.view(alertStore.data && alertStore.data.sessions, dev), {
      alerted: needDev, mailed: devMailed,
    }),
    mailError: ctx.mailError,
    logPath: alertLogPath(),
  };
}

/** 当前设备超限视图（1.4.7）：只报告「活跃设备超阈值」的账号，不处罚 */
function deviceAlertNow(now) {
  return sessions.deviceAlertOf(usersStore.data, { now });
}

/** 发一封告警邮件；未配收件人/未配邮件服务/dryRun 都只如实记原因，绝不抛 */
async function sendAlertMail(context, built) {
  const c = context || {};
  if (c.dryRun) return false;
  if (!c.to || !c.to.length) return false;
  if (!mail.configured()) return false;
  try {
    const r = await mail.send({ subject: built.subject, text: built.text, to: c.to.join(',') });
    if (!r.ok) c.mailError = r.error || '发送失败';
    return !!r.ok;
  } catch (e) {
    c.mailError = e.message;
    return false;
  }
}

/** 后台展示用的告警配置与状态 */
function alertStatus() {
  const bl = backlogNow();
  return Object.assign(alerts.view(alertStore.data, bl), {
    sessions: sessions.view(alertStore.data && alertStore.data.sessions, deviceAlertNow()),
    mailConfigured: mail.configured(),
    recipients: alertRecipients(),
    logPath: 'server/data/alerts.log',
    hint: alertRecipients().length
      ? ''
      : '邮件告警未启用：在 server/data/pp.env 里加一行 PP_ALERT_EMAIL=你的邮箱 即可（支持逗号分隔多个）；不配则只写 alerts.log。',
  });
}

/* ---------------- 后台任务（订单积压巡检） ---------------- */

let _alertTimer = null;
const ALERT_INTERVAL_MS = Number(process.env.PP_ALERT_INTERVAL_MS) > 0
  ? Number(process.env.PP_ALERT_INTERVAL_MS) : 5 * 60e3;

/**
 * 启动周期任务：每 ALERT_INTERVAL_MS（默认 5 分钟）巡检一次待核销积压。
 * 放在函数里而不是模块顶层 —— 测试 require 本模块时不该凭空多出定时器。
 */
function startBackgroundJobs({ intervalMs } = {}) {
  if (_alertTimer) return _alertTimer;
  const ms = Number(intervalMs) > 0 ? Number(intervalMs) : ALERT_INTERVAL_MS;
  _alertTimer = setInterval(() => {
    runAlertCheck().catch((e) => log('alert check failed:', e.message));
  }, ms);
  if (_alertTimer.unref) _alertTimer.unref();
  log('background jobs started: 订单积压巡检每 ' + Math.round(ms / 60000) + ' 分钟一次');
  return _alertTimer;
}

function stopBackgroundJobs() {
  if (_alertTimer) { clearInterval(_alertTimer); _alertTimer = null; }
}

/**
 * 优惠码试算（1.4.6）：把 (等级, 周期/月数) 解析成折前价，再走优惠券报价。
 * **不创建订单、不占名额** —— 用户在支付前反复试算不会消耗券额度。
 * 与 createOrder 共用 coupon.quote()，保证「试算价」与「下单价」永远一致。
 */
function quoteOrder(doc, o) {
  const inp = o || {};
  const perpetual = membership.isPerpetual(inp.cycle) || Number(inp.months) === 0;
  const m = perpetual ? 0 : membership.clampMonths(inp.months);
  const pid = membership.planOf(doc, inp.plan).id || String(inp.plan || 'Pro');
  const eff = membership.effectivePrice(doc, pid, m);
  if (eff.error) return { error: eff.error };
  const baseCents = Math.round(eff.price * 100);
  const q = coupon.quote(doc, {
    code: inp.code, plan: pid, months: m, baseCents, userId: inp.userId, now: inp.now,
  });
  if (!q.ok) return { error: q.error };
  const yuan = (c) => '¥' + (c / 100).toFixed(2);
  return {
    code: q.coupon.code, type: q.type, label: q.label,
    plan: pid, months: m, cycle: eff.cycle, cycleName: membership.cycleName(eff.cycle),
    priceItemId: eff.itemId, priceSource: eff.source,
    originalCents: baseCents, discountCents: q.discountCents, payableCents: q.payableCents,
    originalText: yuan(baseCents), discountText: '−' + yuan(q.discountCents), payableText: yuan(q.payableCents),
    coupon: coupon.couponPublicOut(q.coupon),
  };
}

/* ---------------- AI 计费看板（1.5.0） ---------------- */

/** 取 URL 查询参数（req.url 形如 /api/admin/usage-summary?days=7） */
function queryOf(req) {
  const q = String(req.url || '').split('?')[1] || '';
  const out = {};
  for (const kv of q.split('&')) {
    if (!kv) continue;
    const i = kv.indexOf('=');
    const k = decodeURIComponent(i < 0 ? kv : kv.slice(0, i));
    out[k] = decodeURIComponent(i < 0 ? '' : kv.slice(i + 1));
  }
  return out;
}

/**
 * 单价表后台视图。
 * ★ 关键设计：把「实际被调用过的模型」与「已配单价的模型」对账，列出**没配单价的模型**。
 *   否则看板会显示成本 ≈ 0，让人误以为「很省」——实际是「没数据」。
 *   这是按量计费最容易骗自己的地方，所以 unconfigured 必须显著暴露。
 */
function pricingAdminOut() {
  const doc = pricingStore.data;
  const configured = pricing.modelList(doc);
  const used = new Map();
  for (const u of usersStore.data.users) {
    const bm = (u.usage && u.usage.byModel) || {};
    for (const [model, m] of Object.entries(bm)) {
      const key = String(model);
      const cur = used.get(key) || { model: key, n: 0, inTok: 0, outTok: 0, costMicro: 0, lastAt: '' };
      cur.n += Number(m.n) || 0;
      cur.inTok += Number(m.inTok) || 0;
      cur.outTok += Number(m.outTok) || 0;
      cur.costMicro += Number(m.costMicro) || 0;
      if (m.lastAt && m.lastAt > cur.lastAt) cur.lastAt = m.lastAt;
      used.set(key, cur);
    }
  }
  const usedModels = Array.from(used.values()).map((x) => {
    const p = pricing.priceFor(doc, x.model);
    return Object.assign({}, x, {
      configured: p.known,
      inPer1k: p.inPer1k,
      outPer1k: p.outPer1k,
      tokensText: pricing.tokText(x.inTok + x.outTok),
      costText: pricing.microText(x.costMicro),
    });
  }).sort((a, b) => (b.costMicro - a.costMicro) || (b.n - a.n));
  return {
    currency: doc.currency || 'CNY',
    unit: '元 / 千 token',
    models: configured,
    fallback: doc.fallback,
    usedModels,
    unconfigured: usedModels.filter((x) => !x.configured).map((x) => x.model),
    // 1.6.0 余额配置（enforce=false = 观察模式：只记账不拦截）
    balance: balanceCfg(),
  };
}

/**
 * 成本看板（近 n 天）。
 * byModel 是**全时段累计**（取自 user.usage.byModel，不按窗口截断），
 * 字段名刻意用 byModelAllTime 以免与窗口口径混淆。
 */
function usageSummary(days) {
  const n = Math.max(1, Math.min(90, Number(days) || USAGE_KEEP_DAYS));
  const byDay = [];
  const dayIndex = new Map();
  const nowMs = Date.now();
  for (let i = n - 1; i >= 0; i--) {
    const key = isoDay(nowMs - i * 86400e3);
    const row = { date: key, n: 0, inTok: 0, outTok: 0, costMicro: 0 };
    byDay.push(row);
    dayIndex.set(key, row);
  }
  const totals = { n: 0, inTok: 0, outTok: 0, costMicro: 0, missingUsage: 0, activeUsers: 0 };
  const byModel = new Map();
  const perUser = [];

  for (const u of usersStore.data.users) {
    const us = (u.usage && typeof u.usage === 'object') ? u.usage : {};
    // —— 按天累计（直接读按日映射；旧账号只有 {date,count} 时兜底）——
    for (const key of dayIndex.keys()) {
      const row = dayIndex.get(key);
      row.n += Number((us.daily || {})[key]) || 0;
      row.inTok += Number((us.inTok || {})[key]) || 0;
      row.outTok += Number((us.outTok || {})[key]) || 0;
      row.costMicro += Number((us.costMicro || {})[key]) || 0;
    }
    if (!us.daily || !Object.keys(us.daily).length) {
      const row = us.date ? dayIndex.get(us.date) : null;
      if (row) row.n += Number(us.count) || 0;
    }
    // —— 账号合计 ——
    const t = usageTotalsIn(u, n);
    if (!t.n && !t.inTok && !t.costMicro) continue;
    totals.n += t.n;
    totals.inTok += t.inTok;
    totals.outTok += t.outTok;
    totals.costMicro += t.costMicro;
    totals.missingUsage += t.missingUsage;
    totals.activeUsers += 1;
    perUser.push({
      id: u.id, email: u.email, plan: planEffective(u),
      n: t.n, inTok: t.inTok, outTok: t.outTok, costMicro: t.costMicro,
      costText: pricing.microText(t.costMicro),
      tokensText: pricing.tokText(t.inTok + t.outTok),
      missingUsage: t.missingUsage,
      // 说明：窗口内有调用但成本为 0 → 极可能是没配单价，不是真的免费
      suspectUnpriced: t.costMicro === 0 && (t.inTok + t.outTok) > 0,
    });
    // —— 按模型（全时段累计）——
    const bm = (us.byModel && typeof us.byModel === 'object') ? us.byModel : {};
    for (const [model, m] of Object.entries(bm)) {
      const key = String(model);
      const cur = byModel.get(key) || { model: key, n: 0, inTok: 0, outTok: 0, costMicro: 0 };
      cur.n += Number(m.n) || 0;
      cur.inTok += Number(m.inTok) || 0;
      cur.outTok += Number(m.outTok) || 0;
      cur.costMicro += Number(m.costMicro) || 0;
      byModel.set(key, cur);
    }
  }

  perUser.sort((a, b) => (b.costMicro - a.costMicro) || (b.n - a.n));
  const models = Array.from(byModel.values()).map((x) => Object.assign({}, x, {
    configured: pricing.hasModel(pricingStore.data, x.model),
    costText: pricing.microText(x.costMicro),
    tokensText: pricing.tokText(x.inTok + x.outTok),
  })).sort((a, b) => (b.costMicro - a.costMicro) || (b.n - a.n));

  return {
    days: n,
    currency: pricingStore.data.currency || 'CNY',
    totals: Object.assign({}, totals, {
      costText: pricing.microText(totals.costMicro),
      tokensText: pricing.tokText(totals.inTok + totals.outTok),
      // 人均成本（按有调用的账号算）——定价时的核心输入
      perUserMicro: totals.activeUsers ? Math.round(totals.costMicro / totals.activeUsers) : 0,
      perUserText: totals.activeUsers ? pricing.microText(totals.costMicro / totals.activeUsers) : '¥0',
    }),
    byDay: byDay.map((r) => Object.assign({}, r, {
      costText: pricing.microText(r.costMicro),
      tokensText: pricing.tokText(r.inTok + r.outTok),
    })),
    byModelAllTime: models,
    topUsers: perUser.slice(0, 20),
    unconfigured: models.filter((x) => !x.configured).map((x) => x.model),
  };
}

/* ---------------- 管理域（用户） ---------------- */

/**
 * 管理端直接改 plan / expiresAt 时同步会员对象（0.23.0）。
 * 注意语义差别：这里是**覆盖式**设置（以管理员填写的到期日为准），
 * 与「激活码/订单自动开通」的**叠加式续期**不同——后台手改就是最终裁决。
 */
function syncMembershipFromLegacy(user) {
  const plan = user.plan || 'Free';
  if (plan === 'Free') { user.membership = null; return; }
  const prev = user.membership || {};
  user.membership = {
    plan,
    name: membership.planOf(membershipStore.data, plan).name,
    months: prev.months || 0,
    activatedAt: prev.activatedAt || new Date().toISOString(),
    expiresAt: user.expiresAt || null,
    source: 'admin',
    refId: prev.refId || '',
    history: Array.isArray(prev.history) ? prev.history : [],
  };
}

function userAdminOut(u) {
  const lock = lockout.status(u);
  return {
    id: u.id, email: u.email, nickname: u.nickname || '', plan: planEffective(u),
    planRaw: u.plan || 'Free', expiresAt: u.expiresAt || null,
    dailyLimit: dailyLimitOf(u), dailyUsed: dailyUsedOf(u),
    membership: membership.membershipOf(membershipStore.data, u),
    // 1.4.3 用量趋势（后台用户列表 / CSV 导出用）
    usage7: usageDays(u, 7).reduce((s, d) => s + d.count, 0),
    usage30: usageDays(u, USAGE_KEEP_DAYS).reduce((s, d) => s + d.count, 0),
    // 1.4.7 登录设备：近 N 天活跃会话数（后台用户列表据此标出「设备偏多」）
    sessionsActive: sessions.countActive(usersStore.data, u.id),
    sessionsOverLimit: sessions.countActive(usersStore.data, u.id) > sessions.maxDevices(),
    usageDaily: usageDays(u, USAGE_KEEP_DAYS),
    // 1.5.0 AI 成本（后台用户列表 → 成本列 / Top 消耗用户）
    cost: costViewOf(u),
    // 1.6.0 余额（含流水，供「调余额」弹窗回显）
    balance: balance.adminView(u),
    status: u.status === 'pending' ? 'pending' : 'active',
    createdAt: u.createdAt || null, lastLoginAt: u.lastLoginAt || null,
    // 1.4.2 风控状态：后台用户列表据此显示「已锁定 / 近失败 N 次」
    locked: lock.locked,
    lockUntil: lock.lockUntil,
    lockRemainMinutes: lock.remainMinutes,
    failCount: lock.failCount,
    lastFailAt: lock.lastFailAt,
    lastFailIp: lock.lastFailIp,
  };
}

/**
 * 管理端激活码展示：把 userId 回查成邮箱。
 * 只给后台用的接口加，客户端契约（codeOut）保持不含任何用户标识。
 */
function adminCodeOut(c) {
  const out = membership.codeOut(c);
  const mail = (id) => {
    if (!id) return null;
    const u = findUserById(id);
    return u ? u.email : String(id);
  };
  out.usedByEmail = mail(c.usedBy);
  out.boundToEmail = mail(c.boundTo);
  return out;
}

/**
 * 在线支付确认入账（**回调通知与主动查单共用**，保证两条路径副作用完全一致）。
 * 幂等：已 fulfilled 直接返回 already —— 网关会重试通知，不能重复入账。
 * 第一阶段只接充值订单（kind='credit'）。
 * @returns {{ok:true, already?:boolean, user?:object, creditMicro?:number}|{ok:false, error:string}}
 */
function fulfillByGateway(order, { tradeNo, channel, source } = {}) {
  if (!order) return { ok: false, error: 'order_not_found' };
  if (order.status === 'fulfilled') return { ok: true, already: true };
  if (order.status !== 'pending' && order.status !== 'claimed') {
    return { ok: false, error: 'order_' + order.status };
  }
  if (order.kind !== 'credit') return { ok: false, error: 'unsupported_kind' };
  const r = applyOrderFulfill(order, source || 'gateway');
  if (!r.ok) return r;
  order.tradeNo = String(tradeNo || order.tradeNo || '').slice(0, 64);
  if (channel) order.payChannel = String(channel).slice(0, 16);
  order.paidAt = new Date().toISOString();
  return { ok: true, user: r.user, creditMicro: r.creditMicro };
}

/** 支付完成后的同步返回页：轮询订单状态，然后引导用户回插件 */
function payReturnHtml(outTradeNo) {
  const no = String(outTradeNo || '').replace(/[^A-Za-z0-9]/g, '');
  return [
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>支付结果 · PaperPilot</title>',
    '<style>',
    'body{margin:0;font:15px/1.7 -apple-system,"Segoe UI",system-ui,sans-serif;background:#f6f7f9;color:#222}',
    '.box{max-width:420px;margin:12vh auto;background:#fff;border-radius:14px;padding:28px 26px;',
    'box-shadow:0 8px 30px rgba(0,0,0,.08);text-align:center}',
    'h1{font-size:19px;margin:0 0 8px}.s{font-size:46px;margin:0 0 8px}',
    'p{color:#666;margin:6px 0}.n{font-family:ui-monospace,Consolas,monospace;color:#888;font-size:12px}',
    '</style></head><body><div class="box">',
    '<div class="s" id="icon">⏳</div><h1 id="title">正在确认支付结果…</h1>',
    '<p id="hint">通常几秒内到账，请不要关闭此页</p>',
    '<p class="n">订单号 ' + (no || '—') + '</p>',
    '</div><script>',
    '(function(){var no=' + JSON.stringify(no) + ';var n=0;',
    'function tick(){n++;fetch("/api/pay/return/status?out_trade_no="+encodeURIComponent(no),{cache:"no-store"})',
    '.then(function(r){return r.json()}).then(function(j){',
    'if(j&&j.paid){document.getElementById("icon").textContent="✅";',
    'document.getElementById("title").textContent="支付成功，额度已到账";',
    'document.getElementById("hint").textContent="可以关闭本页，回到 Zotero 查看余额";return}',
    'slow()}).catch(slow)}',
    'function slow(){if(n<20){setTimeout(tick,3000)}else{',
    'document.getElementById("icon").textContent="ℹ️";',
    'document.getElementById("title").textContent="暂未查到支付结果";',
    'document.getElementById("hint").textContent="若已付款，请回 Zotero 点「刷新订单状态」；未付款可关闭本页";}}',
    'tick()})();',
    '</script></body></html>',
  ].join('');
}

/**
 * 核销订单并施加副作用（**唯一入口**：管理端手动核销、对账自动核销、在线支付回调共用，
 * 避免多条路径的副作用逻辑漂移）。
 *   会员订单（kind=plan）  → 叠加开通/续期 + 留一枚已用兑换码
 *   充值订单（kind=credit）→ 到账进「充值余额」（永不过期）
 * @returns {{ok:true, user, order, ...}|{ok:false, error}}
 */
function applyOrderFulfill(order, by) {
  const user = findUserById(order.userId);
  if (!user) return { ok: false, error: '下单账号已不存在（无法开通/入账）' };
  if (order.kind === 'credit' && !(Number(order.creditMicro) > 0)) {
    return { ok: false, error: '充值订单的到账额度非法，拒绝核销（避免核销后无法入账）', user };
  }
  const f = membership.fulfillOrder(membershipStore.data, order, { by });
  if (f.error) return { ok: false, error: f.error, user };
  if (order.kind === 'credit') {
    const r = balance.creditTopUp(user, Number(order.creditMicro), {
      orderId: order.id, reason: '充值订单 ' + order.id,
    });
    if (r.error) return { ok: false, error: r.error, user };
    return { ok: true, user, order, creditMicro: Number(order.creditMicro), balance: r.balance };
  }
  const mp = membership.grantMembership(membershipStore.data, user, {
    plan: order.plan, months: order.months, perpetual: order.perpetual,
    cycle: order.cycle, source: 'order', refId: order.id,
  });
  return { ok: true, user, order, membership: mp };
}

async function adminCreateUser(input) {
  const email = String(input.email || '').trim();
  const password = String(input.password || '');
  const nickname = String(input.nickname || '').trim().slice(0, 40);
  const plan = ['Free', 'Pro'].includes(input.plan) ? input.plan : 'Free';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: '邮箱格式不正确' };
  if (password.length < 8) return { error: '密码至少 8 位' };
  if (findUserByEmail(email)) return { error: '该邮箱已注册' };
  let expiresAt = null;
  if (input.expiresAt) {
    const t = new Date(input.expiresAt).getTime();
    if (!Number.isNaN(t) && t > Date.now()) expiresAt = input.expiresAt;
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const user = {
    id: uid('u'), email, nickname: nickname || email.split('@')[0],
    salt, hash: hashPassword(password, salt), plan, expiresAt,
    dailyLimit: input.dailyLimit > 0 ? Number(input.dailyLimit) : null,
    createdAt: new Date().toISOString(), lastLoginAt: null, usage: { date: today(), count: 0 },
  };
  usersStore.data.users.push(user);
  syncMembershipFromLegacy(user);
  pruneTokens();
  usersStore.save();
  log('user created:', email, plan);
  return { user: userAdminOut(user) };
}

function adminUpdateUser(id, input) {
  const user = findUserById(id);
  if (!user) return { error: '用户不存在' };
  if (input.nickname !== undefined) user.nickname = String(input.nickname || '').trim().slice(0, 40);
  if (input.plan !== undefined && ['Free', 'Pro'].includes(input.plan)) user.plan = input.plan;
  if (input.expiresAt !== undefined) {
    const t = new Date(input.expiresAt).getTime();
    user.expiresAt = (input.expiresAt && !Number.isNaN(t)) ? input.expiresAt : null;
  }
  if (input.dailyLimit !== undefined) {
    user.dailyLimit = Number(input.dailyLimit) > 0 ? Number(input.dailyLimit) : null;
  }
  // 等级或到期日被改动 → 同步会员对象（覆盖式，不做叠加）
  if (input.plan !== undefined || input.expiresAt !== undefined) syncMembershipFromLegacy(user);
  usersStore.save();
  return { user: userAdminOut(user) };
}

/* ---------------- 路由 ---------------- */

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  const method = req.method;
  try {
    /* --- 静态与管理页 --- */
    if (method === 'GET' && (url === '/admin' || url === '/admin.html')) {
      if (!isLocalAdmin(req)) return json(res, 403, { ok: false, error: '管理页仅限本机访问' });
      let html;
      try { html = fs.readFileSync(ADMIN_HTML); }
      catch (e) { return json(res, 500, { ok: false, error: 'admin.html 缺失' }); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    // 浏览器自动请求的站点图标：回 204，避免各公开页控制台出现无意义的 404
    if (method === 'GET' && (url === '/favicon.ico' || url === '/favicon.png')) {
      res.writeHead(204, { 'Cache-Control': 'public, max-age=86400' });
      return res.end();
    }
    // 公开自助注册页（插件「注册账号」链接指向这里；本机/公网均可访问）
    if (method === 'GET' && url === '/register') {
      let html;
      try { html = fs.readFileSync(REGISTER_HTML); }
      catch (e) { return json(res, 500, { ok: false, error: 'register.html 缺失' }); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    // 邮箱验证 / 忘记密码 / 重置密码（公开页面，token 走 query）
    if (method === 'GET' && (url === '/verify' || url === '/forgot' || url === '/reset')) {
      const file = { '/verify': VERIFY_HTML, '/forgot': FORGOT_HTML, '/reset': RESET_HTML }[url];
      let html;
      try { html = fs.readFileSync(file); }
      catch (e) { return json(res, 500, { ok: false, error: '页面文件缺失' }); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }

    if (method === 'GET' && url === '/api/health') {
      return json(res, 200, {
        ok: true, service: 'paperpilot-account-server', version: '1.7.0',
        uptime: Math.round(process.uptime()), now: new Date().toISOString(),
        mail: mail.configured() ? 'on' : 'off',
        users: usersStore.data.users.length,
        channels: channelsStore.data.channels.length,
        active: channelsStore.data.active || null,
        publishedModels: publishedModels().length, // 0 = 全部上线
        highTierModels: highTierModels().length,   // 1.4.9 需付费档的模型数（0 = 无分级）
        // 1.5.0 AI 计量：配了单价的模型数 + 计量盲区累计（上游未返回 usage 的次数）
        pricedModels: pricing.modelList(pricingStore.data).length,
        meteringGaps: usersStore.data.users.reduce((s, u) => s + (Number((u.usage || {}).missingUsage) || 0), 0),
        // 1.6.0 余额：enforce=false = 观察模式（只记账不拦截）；signupGrant 为注册赠送额度
        balanceEnforce: balanceCfg().enforce,
        signupGrantMicro: balanceCfg().signupGrantMicro,
        // 1.7.0 在线支付：仅当「配置齐 + PP_PUBLIC_URL 已配（须 https）+ 密钥能解开」才算可用
        onlinePay: onlinePayReady(),
        // 0.23.0 会员域
        plans: Object.keys(membershipStore.data.plans || {}),
        orders: membershipStore.data.orders.length,
        ordersAwaitingReview: membershipStore.data.orders.filter((o) => o.status === 'claimed').length,
        // 1.4.6 优惠券
        coupons: (membershipStore.data.coupons || []).length,
        couponsActive: (membershipStore.data.coupons || []).filter((c) => coupon.stateOf(c) === 'active').length,
        codesUnused: membershipStore.data.codes.filter((c) => !c.usedAt).length,
        // 1.4.1 价格表
        priceActive: membershipStore.data.priceItems.filter((i) => membership.priceState(i) === 'active').length,
        priceScheduled: membershipStore.data.priceItems.filter((i) => membership.priceState(i) === 'scheduled').length,
        // 1.4.2 运维观测：订单积压 + 快照
        backlogCount: backlogNow().count,
        backlogOldestMinutes: backlogNow().oldestMinutes,
        backlogOverdue: backlogNow().over,
        snapshots: backup.list(DATA_DIR).length,
        lastSnapshotAt: (backup.latest(DATA_DIR) || {}).at || null,
        // 1.4.7 登录设备：近 N 天活跃会话数 / 活跃设备超阈值的账号数
        sessionsActive: sessions.countActiveAll(usersStore.data),
        devicesOverLimit: deviceAlertNow().count,
        // 1.4.4 审计：日志体积（后台据此判断是否需要查看/归档）
        auditBytes: audit.stats(DATA_DIR).bytes,
        auditArchiveBytes: audit.stats(DATA_DIR).archiveBytes,
      });
    }

    /* --- 插件契约：鉴权 --- */
    if (method === 'POST' && url === '/api/auth/register') {
      const ip = clientIp(req);
      if (rateThrottled('register:' + ip, REG_MAX, LOGIN_WINDOW_MS)) {
        return json(res, 429, { ok: false, error: '注册过于频繁，请稍后再试' });
      }
      let input;
      try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
      // 公开自助注册：固定 Free 套餐（升级/有效期管理走本机管理页或启动管理器）
      const r = await adminCreateUser(Object.assign({}, input, { plan: 'Free' }));
      if (r.error) return json(res, 400, { ok: false, error: r.error });
      const user = findUserByEmail(r.user.email);
      // 1.6.0 注册赠送 AI 额度（配置为 0 即关闭；重复发放幂等跳过）
      const gift = balance.grantSignup(user, balanceCfg());
      if (gift.granted) {
        log('signup credit granted:', user.email, gift.granted + ' micro, expires', gift.expiresAt);
        usersStore.save();
      }
      const base = { email: user.email, name: user.nickname, plan: user.plan };
      if (mail.configured()) {
        // 邮箱验证注册：pending → 验证邮件（24h）；发信失败自动降级为直接激活
        user.status = 'pending';
        const token = oneTimeToken();
        user.verify = { hash: tokenKey(token), expiresAt: Date.now() + VERIFY_TTL_MS };
        const verifyUrl = mail.publicBaseUrl(req) + '/verify?token=' + token;
        const m = await mail.sendVerifyMail(user.email, verifyUrl);
        if (!m.ok) {
          user.status = 'active'; user.verify = null;
          usersStore.save();
          log('verify mail failed, activated directly:', user.email, '|', m.error);
          return json(res, 200, { ok: true, user: Object.assign(base, { status: 'active' }),
            notice: '验证邮件暂不可用（' + m.error + '），账号已直接激活' });
        }
        usersStore.save();
        log('user self-registered (pending verify):', user.email, 'ip', ip);
        return json(res, 200, { ok: true, user: Object.assign(base, { status: 'pending' }),
          notice: '验证邮件已发送到 ' + user.email + '，请在 24 小时内点击邮件中的链接完成激活' });
      }
      log('user self-registered:', user.email, 'ip', ip);
      return json(res, 200, { ok: true, user: Object.assign(base, { status: 'active' }) });
    }

    if (method === 'POST' && url === '/api/auth/resend') {
      const ip = clientIp(req);
      if (rateThrottled('mailresend:' + ip, MAIL_MAX, LOGIN_WINDOW_MS)) {
        return json(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' });
      }
      let input;
      try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
      const user = findUserByEmail(input.email || '');
      if (user && user.status === 'pending') {
        const token = oneTimeToken();
        user.verify = { hash: tokenKey(token), expiresAt: Date.now() + VERIFY_TTL_MS };
        const m = await mail.sendVerifyMail(user.email,
          mail.publicBaseUrl(req) + '/verify?token=' + token);
        usersStore.save();
        if (m.ok) log('verify mail resent:', user.email);
      }
      // 恒定成功文案：不暴露邮箱是否存在/是否待验证
      return json(res, 200, { ok: true, message: '如果该邮箱待验证，验证邮件已重新发送，请查收（含垃圾邮件箱）' });
    }

    if (method === 'POST' && url === '/api/auth/verify') {
      let input;
      try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
      const hit = findUserByOneTimeToken('verify', input.token);
      if (!hit) return json(res, 400, { ok: false, error: '验证链接无效' });
      if (hit.expired) {
        hit.user.verify = null; usersStore.save();
        return json(res, 400, { ok: false, error: '验证链接已过期——请回到注册页重新发送验证邮件' });
      }
      hit.user.status = 'active';
      hit.user.verify = null;
      usersStore.save();
      log('email verified:', hit.user.email);
      return json(res, 200, { ok: true, message: '邮箱验证成功，现在可以在 Zotero 中登录了' });
    }

    if (method === 'POST' && url === '/api/auth/forgot') {
      const ip = clientIp(req);
      if (rateThrottled('mailforgot:' + ip, MAIL_MAX, LOGIN_WINDOW_MS)) {
        return json(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' });
      }
      let input;
      try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
      const user = findUserByEmail(input.email || '');
      if (user && user.status !== 'pending' && mail.configured()) {
        const token = oneTimeToken();
        user.reset = { hash: tokenKey(token), expiresAt: Date.now() + RESET_TTL_MS };
        const m = await mail.sendResetMail(user.email,
          mail.publicBaseUrl(req) + '/reset?token=' + token);
        usersStore.save();
        if (m.ok) log('reset mail sent:', user.email);
      }
      // 恒定成功文案：不暴露邮箱是否已注册
      return json(res, 200, { ok: true, message: '如果该邮箱已注册，重置邮件已发送，请在 30 分钟内完成重置' });
    }

    if (method === 'POST' && url === '/api/auth/reset') {
      let input;
      try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
      if (String(input.password || '').length < 8) {
        return json(res, 400, { ok: false, error: '密码至少 8 位' });
      }
      const hit = findUserByOneTimeToken('reset', input.token);
      if (!hit) return json(res, 400, { ok: false, error: '重置链接无效' });
      if (hit.expired) {
        hit.user.reset = null; usersStore.save();
        return json(res, 400, { ok: false, error: '重置链接已过期——请重新申请忘记密码' });
      }
      const user = hit.user;
      user.salt = crypto.randomBytes(16).toString('hex');
      user.hash = hashPassword(input.password, user.salt);
      user.reset = null;
      // 重置密码 = 吊销该用户全部既有令牌
      for (const [tok, rec] of Object.entries(usersStore.data.tokens || {})) {
        if (rec && rec.userId === user.id) delete usersStore.data.tokens[tok];
      }
      usersStore.save();
      log('password self-reset:', user.email);
      return json(res, 200, { ok: true, message: '密码已重置，请用新密码在 Zotero 中登录' });
    }

    if (method === 'POST' && url === '/api/auth/login') {
      const ip = clientIp(req);
      if (rateThrottled('login:' + ip, LOGIN_MAX, LOGIN_WINDOW_MS)) {
        return json(res, 429, { ok: false, error: '尝试过于频繁，请稍后再试' });
      }
      let input;
      try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
      const user = findUserByEmail(input.email || '');

      // 账号级风控（1.4.2）：锁定期内**即使密码正确也拒绝**，否则锁定形同虚设
      if (user) {
        const st = lockout.status(user);
        if (st.locked) {
          log('login blocked (locked):', user.email, 'remain=' + st.remainMinutes + 'min', 'ip=' + ip);
          return json(res, 403, { ok: false, code: 'account_locked',
            lockUntil: st.lockUntil, remainMinutes: st.remainMinutes,
            error: lockout.lockedMessage(st) });
        }
      }

      const passOk = !!user && verifyPassword(user, String(input.password || ''));
      if (!passOk) {
        // 邮箱不存在时没有对象可写 —— 由 IP 限速兜底；应答文案与密码错误完全一致，不泄漏账号是否存在
        if (user) {
          const st = lockout.registerFailure(user, { ip });
          usersStore.save();
          if (st.locked) {
            log('account locked:', user.email, 'failCount=' + st.failCount, 'ip=' + ip);
          } else {
            log('login failed:', user.email, 'failCount=' + st.failCount, 'ip=' + ip);
          }
        }
        return json(res, 401, { ok: false, error: lockout.GENERIC_FAIL });
      }
      if (user.status === 'pending') {
        return json(res, 403, { ok: false, code: 'email_unverified',
          error: '邮箱未验证：请查收验证邮件并点击激活链接；未收到可在注册页点「重新发送」' });
      }
      lockout.reset(user);            // 登录成功清零失败计数与锁定
      const token = issueToken(user.id, { req });
      user.lastLoginAt = new Date().toISOString();
      pruneTokens();
      usersStore.save();
      log('login ok:', user.email);
      return json(res, 200, {
        ok: true, token,
        expiresAt: new Date(Date.now() + TOKEN_TTL_MS).toISOString(),
        user: userForClient(user),
      });
    }

    if (method === 'POST' && url === '/api/auth/logout') {
      const auth = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
      if (auth && usersStore.data.tokens && usersStore.data.tokens[tokenKey(auth)]) {
        delete usersStore.data.tokens[tokenKey(auth)];
        usersStore.save();
      }
      return json(res, 200, { ok: true }); // 未带令牌也视为登出成功（幂等）
    }

    if (method === 'GET' && url === '/api/auth/me') {
      const user = userByToken(req);
      if (!user) return json(res, 401, { ok: false, error: '登录已过期' });
      // 1.6.0 现场补发当期订阅额度（幂等；跨月后第一次 /me 就会到账）
      ensurePlanGrant(user);
      touchToken(req);
      usersStore.save();
      return json(res, 200, {
        ok: true, user: userForClient(user),
        expiresAt: new Date(Date.now() + TOKEN_TTL_MS).toISOString(),
      });
    }

    /* --- 插件契约：会员（0.23.0） --- */

    // 套餐目录：公开接口（未登录也能看价格，便于登录前决策）
    if (method === 'GET' && url === '/api/plans') {
      return json(res, 200, Object.assign({ ok: true },
        membership.plansForClient(membershipStore.data),
        // 1.6.0 充值档位（插件据此展示「充值」入口）
        { rechargeOptions: balance.rechargeOptionsForClient(balanceCfg()),
          recharge: { enforce: balanceCfg().enforce, minBalanceMicro: balanceCfg().minBalanceMicro },
          // 1.7.0 在线支付可用性（插件据此决定「在线支付」按钮是否出现；未开通时走收款码）
          onlinePay: onlinePayReady()
            ? { available: true, channels: pay.CHANNELS.map((id) => ({ id, text: pay.CHANNEL_TEXT[id] })) }
            : { available: false, channels: [] } }));
    }

    if (url === '/api/membership' || url === '/api/orders' || url === '/api/redeem'
        || url === '/api/coupons/validate' || url.startsWith('/api/orders/')
        || url === '/api/sessions' || url.startsWith('/api/sessions/')) {
      const user = userByToken(req);
      if (!user) return json(res, 401, { ok: false, error: '登录已过期' });
      touchTokenSoon(req);

      if (method === 'GET' && url === '/api/membership') {
        return json(res, 200, { ok: true,
          membership: membership.membershipOf(membershipStore.data, user),
          user: userForClient(user) });
      }

      // 激活码兑换：绑定当前账号 + 叠加续期，一步到位
      if (method === 'POST' && url === '/api/redeem') {
        if (rateThrottled('redeem:' + clientIp(req), REDEEM_MAX, LOGIN_WINDOW_MS)) {
          return json(res, 429, { ok: false, error: '尝试过于频繁，请稍后再试' });
        }
        let input;
        try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
        snapshot('membership-change', { note: '激活码兑换：' + user.email });
        const r = membership.redeem(membershipStore.data, input.code, user);
        if (r.error) return json(res, 400, { ok: false, error: r.error });
        membershipStore.save();
        usersStore.save();
        log('membership redeemed:', user.email, r.code.plan, r.code.months + 'm');
        return json(res, 200, { ok: true, membership: r.membership, user: userForClient(user), code: r.code });
      }

      /* ---- 登录设备（1.4.7）：用户自查 + 自助踢出 ---- */

      // 列出本账号的登录设备（IP 一律打码；完整 IP 只在仅本机直连的管理接口里给）
      if (method === 'GET' && url === '/api/sessions') {
        const cur = currentSid(req);
        const det = sessions.sessionsOfDetailed(usersStore.data, user.id);
        const list = det.list.map((r) => sessions.sessionOut(r, { current: r.sid === cur }));
        const activeCount = list.filter((x) => x.active).length;
        const anyIdentified = list.some((x) => x.identified);
        // 只有当场补齐了老令牌的 sid/createdAt 才落盘 —— 这是个会被频繁调用的读接口
        if (det.changed) usersStore.save();
        return json(res, 200, {
          ok: true, sessions: list, activeCount,
          activeDays: sessions.activeDays(), maxDevices: sessions.maxDevices(),
          overLimit: activeCount > sessions.maxDevices(),
          identified: anyIdentified,
          hint: anyIdentified ? ''
            : '当前设备未上报设备标识（插件需 0.24.7 及以上）；升级后这里会显示设备名与平台。',
        });
      }

      // 踢出除当前设备外的全部设备
      if (method === 'POST' && url === '/api/sessions/revoke-others') {
        snapshot('users-change', { note: '踢出其他设备：' + user.email });
        const r = sessions.revokeOthers(usersStore.data, user.id, { currentSid: currentSid(req) });
        usersStore.save();
        auditLog(req, 'session.revoke-others', {
          target: user.email, after: { count: r.revoked.length, digest: sessions.digestOf(r.revoked) } });
        log('sessions revoked (others):', user.email, 'n=' + r.revoked.length);
        return json(res, 200, { ok: true, revoked: r.revoked.length });
      }

      // 踢出指定设备（踢自己 = 登出，语义与 /api/auth/logout 一致）
      const sm = url.match(/^\/api\/sessions\/([a-zA-Z0-9-]+)$/);
      if (sm && method === 'PUT') {
        // 给自己的设备起名（本机拿不到可靠主机名，所以由用户自己命名）
        let input;
        try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
        const rec = sessions.sessionsOf(usersStore.data, user.id).find((r) => r.sid === sm[1]);
        if (!rec) return json(res, 404, { ok: false, error: '会话不存在或已失效' });
        sessions.setLabel(rec, input && input.label);
        usersStore.save();
        auditLog(req, 'session.label', { target: user.email, after: { sid: sm[1], label: rec.deviceLabel } });
        return json(res, 200, { ok: true, sid: sm[1], label: rec.deviceLabel,
          session: sessions.sessionOut(rec, { current: sm[1] === currentSid(req) }) });
      }
      if (sm && method === 'DELETE') {
        snapshot('users-change', { note: '踢出设备 ' + sm[1] });
        const r = sessions.revokeSid(usersStore.data, user.id, sm[1], { currentSid: currentSid(req) });
        if (r.error) return json(res, 404, { ok: false, error: r.error });
        usersStore.save();
        auditLog(req, 'session.revoke', {
          target: user.email, note: r.self ? '踢出的是当前会话（等同登出）' : '',
          after: { sid: r.revoked, self: !!r.self } });
        log('session revoked:', user.email, r.revoked, r.self ? '(self)' : '');
        return json(res, 200, { ok: true, revoked: r.revoked, self: !!r.self });
      }

      // 优惠码试算：下单前预览折后价（不占名额、不写库）
      if (method === 'POST' && url === '/api/coupons/validate') {
        if (rateThrottled('coupon:' + clientIp(req), REDEEM_MAX, LOGIN_WINDOW_MS)) {
          return json(res, 429, { ok: false, error: '尝试过于频繁，请稍后再试' });
        }
        let input;
        try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
        const q = quoteOrder(membershipStore.data, {
          code: input.code, plan: input.plan, months: input.months, cycle: input.cycle, userId: user.id,
        });
        if (q.error) return json(res, 400, { ok: false, error: q.error });
        return json(res, 200, { ok: true, quote: q });
      }

      // 下单：返回订单号 + 金额 + 收款信息；支付与核销在线下完成
      if (method === 'POST' && url === '/api/orders') {
        let input;
        try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
        if (membership.reapOrders(membershipStore.data)) membershipStore.save();

        // 1.6.0 充值订单：{ kind:'credit', optionId } → 买 AI 余额（核销后自动入账）
        if (input.kind === 'credit') {
          const opt = balance.rechargeOptionOf(balanceCfg(), input.optionId);
          if (!opt) return json(res, 400, { ok: false, error: '充值档位不存在或已下架' });
          const r = membership.createCreditOrder(membershipStore.data, {
            user,
            cents: opt.cents,
            // 1 分 = 1e4 微元（pricing.MICRO_PER_CENT），到账额度含赠送
            creditMicro: opt.creditCents * pricing.MICRO_PER_CENT,
            bonusMicro: Math.max(0, opt.creditCents - opt.cents) * pricing.MICRO_PER_CENT,
            label: opt.label || ('AI 额度充值 ¥' + (opt.cents / 100).toFixed(0)),
          });
          if (r.error) return json(res, 400, { ok: false, error: r.error });
          membershipStore.save();
          log('credit order created:', user.email, '¥' + (opt.cents / 100).toFixed(2),
            '→ credit', r.order.creditMicro + ' micro');
          return json(res, 200, { ok: true, order: membership.orderOut(membershipStore.data, r.order) });
        }

        const r = membership.createOrder(membershipStore.data, {
          user, plan: input.plan, months: input.months, cycle: input.cycle,
          // couponCode 由插件在上一步 /api/coupons/validate 拿到并回传；
          // 这里会**重新校验**（不信客户端），且此刻才真正占住券的名额
          couponCode: input.couponCode || '',
        });
        if (r.error) return json(res, 400, { ok: false, error: r.error });
        membershipStore.save();
        log('order created:', user.email, r.order.plan, r.order.months + 'm',
          '¥' + r.order.amount, r.order.couponCode ? ('coupon=' + r.order.couponCode) : '');
        return json(res, 200, { ok: true, order: membership.orderOut(membershipStore.data, r.order) });
      }

      const om = url.match(/^\/api\/orders\/([a-zA-Z0-9-]+)(\/claim|\/cancel)?$/);
      if (om) {
        const order = membership.findOrder(membershipStore.data, om[1]);
        if (!order || order.userId !== user.id) return json(res, 404, { ok: false, error: '订单不存在' });
        if (method === 'GET' && !om[2]) {
          return json(res, 200, { ok: true, order: membership.orderOut(membershipStore.data, order) });
        }
        if (method === 'POST' && om[2] === '/claim') {
          const r = membership.claimOrder(membershipStore.data, order, user);
          if (r.error) return json(res, 400, { ok: false, error: r.error });
          membershipStore.save();
          log('order claimed (awaiting review):', user.email, order.id);
          return json(res, 200, { ok: true, order: membership.orderOut(membershipStore.data, order) });
        }
        if (method === 'POST' && om[2] === '/cancel') {
          const r = membership.cancelOrder(membershipStore.data, order, user);
          if (r.error) return json(res, 400, { ok: false, error: r.error });
          membershipStore.save();
          return json(res, 200, { ok: true, order: membership.orderOut(membershipStore.data, order) });
        }
      }

      /* ---- 1.6.0 在线支付：发起支付 / 主动查单 ---- */

      let pm;

      /** 发起在线支付：返回收银台跳转地址（客户端开浏览器，再轮询订单状态即可） */
      pm = url.match(/^\/api\/orders\/([a-zA-Z0-9-]+)\/pay$/);
      if (pm && method === 'POST') {
        if (rateThrottled('pay:' + user.id, PAY_MAX, LOGIN_WINDOW_MS)) {
          return json(res, 429, { ok: false, error: '操作过于频繁，请稍后再试' });
        }
        const order = membership.findOrder(membershipStore.data, pm[1]);
        if (!order || order.userId !== user.id) return json(res, 404, { ok: false, error: '订单不存在' });
        if (!onlinePayReady()) return json(res, 503, { ok: false, error: '在线支付未开通，请用收款码支付' });
        // 第一阶段只接充值订单：金额小、退款纠纷少，先跑通链路
        if (order.kind !== 'credit') return json(res, 400, { ok: false, error: '该订单类型暂不支持在线支付' });
        if (order.status !== 'pending') return json(res, 400, { ok: false, error: '订单当前状态不可支付' });
        let input = {};
        try { input = await readBody(req); } catch (e) { /* 允许空体 */ }
        const channel = pay.CHANNELS.indexOf(String(input.channel)) >= 0 ? String(input.channel) : 'wxpay';
        // 商户订单号：网关只收字母数字，内部 id 带连字符，故另生成并落库
        if (!order.outTradeNo) order.outTradeNo = pay.newTradeNo('PP');
        order.payChannel = channel;
        order.updatedAt = new Date().toISOString();
        const cfg = payCfg(true);
        const payUrl = pay.createPayUrl(cfg, {
          outTradeNo: order.outTradeNo,
          amountCents: order.amountCents,
          itemName: order.note || ('PaperPilot ' + pay.moneyStr(order.amountCents) + ' 充值'),
        }, channel, siteBaseUrl());
        membershipStore.save();
        log('online pay started:', user.email, order.id, channel, pay.moneyStr(order.amountCents), 'no=' + order.outTradeNo);
        return json(res, 200, { ok: true, payUrl,
          order: membership.orderOut(membershipStore.data, order),
          channel, channelText: pay.CHANNEL_TEXT[channel] });
      }

      /** 主动查单：网关异步通知丢包时的兜底（也是「用户点了支付但没返回」时的补救） */
      pm = url.match(/^\/api\/orders\/([a-zA-Z0-9-]+)\/query$/);
      if (pm && method === 'POST') {
        if (rateThrottled('payq:' + user.id, PAY_QUERY_MAX, LOGIN_WINDOW_MS)) {
          return json(res, 429, { ok: false, error: '查询过于频繁，请稍后再试' });
        }
        const order = membership.findOrder(membershipStore.data, pm[1]);
        if (!order || order.userId !== user.id) return json(res, 404, { ok: false, error: '订单不存在' });
        if (order.status !== 'pending') {
          return json(res, 200, { ok: true, order: membership.orderOut(membershipStore.data, order) });
        }
        if (!order.outTradeNo || !onlinePayReady()) {
          return json(res, 200, { ok: true, order: membership.orderOut(membershipStore.data, order),
            hint: '该订单未发起在线支付' });
        }
        const cfg = payCfg(true);
        let q;
        try {
          q = await pay.queryOrder(cfg, order.outTradeNo);
        } catch (e) {
          return json(res, 502, { ok: false, error: '查单失败：' + e.message });
        }
        if (q.ok && q.paid) {
          const r = fulfillByGateway(order, { tradeNo: q.tradeNo, channel: order.payChannel, source: 'gateway-query' });
          if (!r.ok) return json(res, 500, { ok: false, error: '入账失败：' + r.error });
          membershipStore.save();
          usersStore.save();
          if (!r.already) {
            auditLog(req, 'order.pay', { target: order.id, note: '主动查单确认支付：' + user.email,
              after: { outTradeNo: order.outTradeNo, tradeNo: order.tradeNo,
                amountCents: membership.amountCentsOf(order), creditMicro: order.creditMicro } });
          }
          return json(res, 200, { ok: true, order: membership.orderOut(membershipStore.data, order), justPaid: true });
        }
        return json(res, 200, { ok: true, order: membership.orderOut(membershipStore.data, order),
          hint: '网关显示暂未支付' });
      }
      return json(res, 405, { ok: false, error: '该方法不支持：' + method + ' ' + url });
    }

    /* ---- 1.6.0 支付网关回调（**公开路由**：靠验签而非来源 IP 保护） ----
     * 放在 isLocalAdmin 守卫之前——网关服务器从公网发起，不可能来自回环。
     * 校验顺序：限速 → 配置就绪 → 验签 → 商户号 → 交易状态 → 订单存在 → **金额比对** → 幂等履约。
     * 拒绝原因**只进本地日志**，响应体恒为 fail：不给探测者任何可观测差异。
     */
    if (method === 'GET' && url === '/api/pay/notify') {
      const qp = new URLSearchParams(queryOf(req));
      const q = {};
      for (const [k, v] of qp.entries()) q[k] = v;
      const reject = (why) => {
        log('[pay-notify] reject:', why, '| no=' + String(q.out_trade_no || ''),
          'pid=' + String(q.pid || ''), 'st=' + String(q.trade_status || ''), 'ip', clientIp(req));
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(pay.NOTIFY_FAIL);
        return true;
      };
      if (rateThrottled('payn:' + clientIp(req), PAY_NOTIFY_MAX, LOGIN_WINDOW_MS)) return reject('rate_limit');
      const cfg = payCfg(true);
      if (!pay.isReady(cfg) || cfg.keyBroken || cfg.privateKeyBroken) return reject('not_ready');
      if (!pay.verifyNotify(cfg, q)) return reject('bad_sign');
      if (String(q.pid) !== cfg.pid) return reject('pid_mismatch');
      if (q.trade_status !== 'TRADE_SUCCESS') return reject('trade_status_' + String(q.trade_status || ''));
      const order = membership.findOrderByTradeNo(membershipStore.data, q.out_trade_no);
      if (!order) return reject('order_not_found');
      // ★ 防少付：只验签不够，必须比对实付金额与本地订单金额（精确到分）
      const localMoney = pay.moneyStr(order.amountCents);
      if (Number(q.money).toFixed(2) !== localMoney) {
        return reject('amount_mismatch gw=' + String(q.money) + ' local=' + localMoney);
      }
      const r = fulfillByGateway(order, { tradeNo: q.trade_no, channel: q.type, source: 'gateway' });
      if (!r.ok) return reject('fulfill_' + r.error);
      membershipStore.save();
      usersStore.save();
      log('[pay-notify] fulfilled', order.id, 'no=' + order.outTradeNo, r.already ? '(already)' : '');
      if (!r.already) {
        auditLog(req, 'order.pay', { target: order.id,
          note: '在线支付自动入账：' + String(order.email || ''),
          after: { outTradeNo: order.outTradeNo, tradeNo: order.tradeNo, channel: order.payChannel,
            amountCents: membership.amountCentsOf(order), creditMicro: order.creditMicro } });
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(pay.NOTIFY_OK);
      return true;
    }

    /* 支付完成后的同步跳转页（浏览器从这里回来）：只做「轮询订单状态 + 引导回插件」 */
    if (method === 'GET' && url === '/api/pay/return') {
      const qp = new URLSearchParams(queryOf(req));
      const no = String(qp.get('out_trade_no') || '').replace(/[^A-Za-z0-9]/g, '');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(payReturnHtml(no));
      return true;
    }

    /* 返回页轮询用：按商户订单号查支付状态。
     * 无需登录（浏览器里没有 Bearer）；号是随机不可猜的，故只回「是否已支付 + 状态」，
     * 不回金额、账号等任何信息，并按 IP 限速。 */
    if (method === 'GET' && url === '/api/pay/return/status') {
      if (rateThrottled('payrs:' + clientIp(req), PAY_NOTIFY_MAX, LOGIN_WINDOW_MS)) {
        return json(res, 429, { ok: false, error: '查询过于频繁' });
      }
      const qp = new URLSearchParams(queryOf(req));
      const no = String(qp.get('out_trade_no') || '').replace(/[^A-Za-z0-9]/g, '');
      const order = membership.findOrderByTradeNo(membershipStore.data, no);
      if (!order) return json(res, 200, { ok: true, paid: false, status: 'not_found' });
      return json(res, 200, { ok: true,
        paid: order.status === 'fulfilled', status: order.status });
    }

    /* --- 插件契约：官方模型网关 --- */
    if ((url === '/v1/models' || url === '/v1/chat/completions')) {
      const user = userByToken(req);
      if (!user) return json(res, 401, { ok: false, error: '登录已过期' });
      // 0.15.1：网关调用滑动续期（节流落盘）——用户持续使用 AI 即保持登录有效，
      // 不再依赖「重启 Zotero 触发 /me」这一个续期点
      touchTokenSoon(req);
      if (method === 'GET' && url === '/v1/models') {
        // 1.4.9：按套餐过滤——客户端下拉自然只出现该用户可用的模型
        const av = modelsForUser(user);
        return json(res, 200, { object: 'list',
          data: av.models.map((id) => ({ id, object: 'model' })) });
      }
      if (method === 'POST' && url === '/v1/chat/completions') {
        return gatewayChat(req, res, user);
      }
    }

    /* --- 以下为管理 API：仅本机 --- */
    if (url.startsWith('/api/admin/')) {
      if (!isLocalAdmin(req)) return json(res, 403, { ok: false, error: '管理接口仅限本机调用' });

      if (method === 'GET' && url === '/api/admin/providers') {
        return json(res, 200, { ok: true, providers: providersForClient() });
      }

      /* 用户管理 */
      if (url === '/api/admin/users') {
        if (method === 'GET') {
          return json(res, 200, { ok: true, users: usersStore.data.users.map(userAdminOut) });
        }
        if (method === 'POST') {
          let input;
          try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
          snapshot('users-change', { note: '新建用户：' + String(input && input.email || '') });
          const r = await adminCreateUser(input);
          if (r.error) return json(res, 400, { ok: false, error: r.error });
          auditLog(req, 'user.create', { target: r.user.email,
            after: { plan: r.user.plan, planRaw: r.user.planRaw, expiresAt: r.user.expiresAt, status: r.user.status } });
          return json(res, 200, { ok: true, user: r.user });
        }
      }
      let m = url.match(/^\/api\/admin\/users\/([a-zA-Z0-9-]+)$/);
      if (m) {
        const id = m[1];
        if (method === 'PUT') {
          let input;
          try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
          snapshot('users-change', { note: '修改用户：' + id });
          const pre = findUserById(id);
          const r = adminUpdateUser(id, input);
          if (r.error) return json(res, 404, { ok: false, error: r.error });
          auditLog(req, 'user.update', { target: r.user.email,
            before: pre ? { nickname: pre.nickname, plan: pre.plan, expiresAt: pre.expiresAt, dailyLimit: pre.dailyLimit } : null,
            after: { nickname: r.user.nickname, plan: r.user.planRaw, expiresAt: r.user.expiresAt, dailyLimit: r.user.dailyLimit } });
          return json(res, 200, { ok: true, user: r.user });
        }
        if (method === 'DELETE') {
          const idx = usersStore.data.users.findIndex((u) => u.id === id);
          if (idx < 0) return json(res, 404, { ok: false, error: '用户不存在' });
          snapshot('users-change', { note: '删除用户：' + usersStore.data.users[idx].email });
          const victim = usersStore.data.users[idx];
          log('user deleted:', victim.email);
          auditLog(req, 'user.delete', { target: victim.email,
            before: { plan: victim.plan, status: victim.status,
              membership: (victim.membership && victim.membership.plan) || null } });
          usersStore.data.users.splice(idx, 1);
          for (const [tok, rec] of Object.entries(usersStore.data.tokens || {})) {
            if (rec && rec.userId === id) delete usersStore.data.tokens[tok];
          }
          usersStore.save();
          return json(res, 200, { ok: true });
        }
      }
      m = url.match(/^\/api\/admin\/users\/([a-zA-Z0-9-]+)\/password$/);
      if (m && method === 'POST') {
        const user = findUserById(m[1]);
        if (!user) return json(res, 404, { ok: false, error: '用户不存在' });
        let input;
        try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
        if (String(input.password || '').length < 8) return json(res, 400, { ok: false, error: '密码至少 8 位' });
        snapshot('users-change', { note: '重置密码：' + user.email });
        user.salt = crypto.randomBytes(16).toString('hex');
        user.hash = hashPassword(input.password, user.salt);
        // 重置密码 = 吊销该用户全部既有令牌 + 顺带解除登录锁定（管理员介入即视为人工放行）
        for (const [tok, rec] of Object.entries(usersStore.data.tokens || {})) {
          if (rec && rec.userId === user.id) delete usersStore.data.tokens[tok];
        }
        lockout.reset(user);
        usersStore.save();
        log('password reset:', user.email);
        auditLog(req, 'user.password', { target: user.email, note: '同时吊销该账号全部登录令牌并解除锁定' });
        return json(res, 200, { ok: true });
      }
      // 1.4.2：一键解锁（连续失败被临时锁定的账号）
      m = url.match(/^\/api\/admin\/users\/([a-zA-Z0-9-]+)\/unlock$/);
      if (m && method === 'POST') {
        const user = findUserById(m[1]);
        if (!user) return json(res, 404, { ok: false, error: '用户不存在' });
        const st = lockout.status(user);
        lockout.unlock(user);
        usersStore.save();
        log('account unlocked:', user.email, '(was failCount=' + st.failCount + ')');
        auditLog(req, 'user.unlock', { target: user.email, before: { failCount: st.failCount, locked: st.locked } });
        return json(res, 200, { ok: true, user: userAdminOut(user),
          note: st.locked ? '已解除锁定' : '该账号当前未被锁定（已顺带清零失败计数）' });
      }

      /* 通道管理 */
      if (url === '/api/admin/channels') {
        if (method === 'GET') {
          return json(res, 200, {
            ok: true,
            channels: channelsStore.data.channels.map(channelOut),
            active: channelsStore.data.active || null,
            publishedModels: publishedModels(), // 0.15.0 对外上线清单（空 = 全部上线）
            highTierModels: highTierModels(),   // 1.4.9 高级模型清单（空 = 无分级）
          });
        }
        if (method === 'POST') {
          let input;
          try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
          let id = String(input.id || input.name || '').trim();
          if (input.id && !/^[a-z0-9-]+$/.test(input.id)) {
            return json(res, 400, { ok: false, error: '通道 id 只能含小写字母/数字/连字符' });
          }
          if (!input.id) id = slug(input.name || input.provider || '', 'ch');
          while (channelsStore.data.channels.some((c) => c && c.id === id)) id = id + '-2';
          const r = upsertChannel(Object.assign({}, input, { id }));
          if (r.error) return json(res, 400, { ok: false, error: r.error });
          auditLog(req, 'channel.create', { target: r.channel.id, after: channelOut(r.channel) });
          return json(res, 200, { ok: true, channel: channelOut(r.channel) });
        }
      }
      if (url === '/api/admin/channels/active' && method === 'PUT') {
        let input;
        try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
        const id = String(input.id || '');
        if (!channelsStore.data.channels.some((c) => c && c.id === id)) {
          return json(res, 404, { ok: false, error: '通道不存在' });
        }
        channelsStore.data.active = id;
        channelsStore.save();
        log('active channel ->', id);
        auditLog(req, 'channel.active', { target: id });
        return json(res, 200, { ok: true, active: id });
      }
      // 0.15.0 对外上线模型清单：{ models: [...] }（空数组 = 恢复全部上线）
      if (url === '/api/admin/channels/published' && method === 'PUT') {
        let input;
        try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
        const list = sanitizeModels(input.models);
        if (list === undefined) return json(res, 400, { ok: false, error: 'models 必须是模型名数组' });
        channelsStore.data.publishedModels = list;
        channelsStore.save();
        log('published models ->', JSON.stringify(list));
        auditLog(req, 'channel.published', { target: list.length + ' 个模型', after: { models: list } });
        return json(res, 200, { ok: true, publishedModels: list,
          note: list.length ? '仅上线清单内模型（auto 恒放行）' : '已恢复全部上线' });
      }
      // 1.4.9 高级模型清单：{ models: [...] }（空数组 = 无分级，全部免费）
      if (url === '/api/admin/channels/high-tier' && method === 'PUT') {
        let input;
        try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
        const list = sanitizeModels(input.models);
        if (list === undefined) return json(res, 400, { ok: false, error: 'models 必须是模型名数组' });
        // 高级模型必须是「已上线」的子集才有意义；不在上线清单内只提示不阻断
        // （可能先配分级再放开上线，顺序不该被强制）。
        const pub = publishedModels();
        const outside = pub.length ? list.filter((m) => !pub.includes(m)) : [];
        channelsStore.data.highTierModels = list;
        channelsStore.save();
        log('high-tier models ->', JSON.stringify(list));
        auditLog(req, 'channel.high-tier', { target: list.length + ' 个模型', after: { models: list } });
        return json(res, 200, { ok: true, highTierModels: list,
          outsidePublished: outside,
          note: list.length
            ? '仅这些模型需要专业版（auto 恒免费）' + (outside.length ? '；其中 ' + outside.join('、') + ' 不在上线清单内，暂不生效' : '')
            : '已取消模型分级——全部免费' });
      }
      if (url === '/api/admin/channels/detect' && method === 'POST') {
        let input;
        try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
        const r = await detectChannel(input);
        return json(res, r.ok ? 200 : 400, r);
      }
      m = url.match(/^\/api\/admin\/channels\/([a-z0-9-]+)$/);
      if (m) {
        const id = m[1];
        if (method === 'PUT') {
          let input;
          try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
          if (!channelsStore.data.channels.some((c) => c && c.id === id)) {
            return json(res, 404, { ok: false, error: '通道不存在' });
          }
          const r = upsertChannel(Object.assign({}, input, { id }));
          if (r.error) return json(res, 400, { ok: false, error: r.error });
          auditLog(req, 'channel.update', { target: r.channel.id, after: channelOut(r.channel) });
          return json(res, 200, { ok: true, channel: channelOut(r.channel) });
        }
        if (method === 'DELETE') {
          const idx = channelsStore.data.channels.findIndex((c) => c && c.id === id);
          if (idx < 0) return json(res, 404, { ok: false, error: '通道不存在' });
          const chName = channelsStore.data.channels[idx].name;
          log('channel deleted:', chName);
          auditLog(req, 'channel.delete', { target: id, before: { name: chName } });
          channelsStore.data.channels.splice(idx, 1);
          if (channelsStore.data.active === id) channelsStore.data.active = null;
          channelsStore.save();
          return json(res, 200, { ok: true });
        }
        if (method === 'POST' && url.endsWith('/test')) { /* handled below via /test route */ }
      }
      m = url.match(/^\/api\/admin\/channels\/([a-z0-9-]+)\/test$/);
      if (m && method === 'POST') {
        const r = await testChannelById(m[1]);
        return json(res, r.ok ? 200 : 400, r);
      }
      m = url.match(/^\/api\/admin\/channels\/([a-z0-9-]+)\/models$/);
      if (m && method === 'GET') {
        const c = channelsStore.data.channels.find((x) => x && x.id === m[1]);
        if (!c) return json(res, 404, { ok: false, error: '通道不存在' });
        const r = await fetchModelsOf({ baseUrl: c.baseUrl, apiKey: c.apiKey, timeoutMs: c.timeoutMs });
        if (!r.ok) return json(res, 400, { ok: false, error: r.error });
        // 拉取成功即刷新通道的模型列表缓存（「官方默认模型」下拉与 /v1/models 展示用）
        const models = sanitizeModels(r.models);
        if (models && models.length && JSON.stringify(models) !== JSON.stringify(c.models || [])) {
          c.models = models;
          channelsStore.save();
          log('channel models refreshed:', c.id, models.length);
        }
        return json(res, 200, { ok: true, models: r.models, latencyMs: r.latencyMs });
      }

      /* ---- 会员管理（0.23.0，仅本机） ---- */

      /** 订单 + 激活码 + 套餐配置一览 */
      if (url === '/api/admin/membership' && method === 'GET') {
        if (membership.reapOrders(membershipStore.data)) membershipStore.save();
        const orders = membershipStore.data.orders.slice().reverse()
          .map((o) => Object.assign(membership.orderOut(membershipStore.data, o),
            { userId: o.userId, email: o.email }));
        const codes = membershipStore.data.codes.slice().reverse().map((c) => adminCodeOut(c));
        return json(res, 200, {
          ok: true, orders, codes,
          plans: membership.plansForClient(membershipStore.data),
          ai: { trialDays: membership.trialDaysFor(membershipStore.data) }, // 1.4.9 新用户全模型试用天数
          // 1.6.0 余额与充值档位（后台「充值档位」编辑用）
          balance: balanceCfg(),
          priceItems: membershipStore.data.priceItems.map((i) => membership.priceItemOut(membershipStore.data, i)),
          cycles: membership.CYCLE_PRESETS,
          counts: {
            orders: orders.length,
            awaitingReview: orders.filter((o) => o.status === 'claimed').length,
            fulfilled: orders.filter((o) => o.status === 'fulfilled').length,
            codesUnused: codes.filter((c) => c.status === 'unused').length,
            codesUsed: codes.filter((c) => c.status === 'used').length,
            priceActive: membershipStore.data.priceItems
              .filter((i) => membership.priceState(i) === 'active').length,
            priceScheduled: membershipStore.data.priceItems
              .filter((i) => membership.priceState(i) === 'scheduled').length,
          },
        });
      }

      /* ---- 价格表 CRUD（1.4.1：等级 × 计费周期 × 生效时段） ---- */

      /** 全部价格条目（含未生效 / 已过期 / 已停用），供后台列表 */
      if (url === '/api/admin/prices' && method === 'GET') {
        const doc = membershipStore.data;
        return json(res, 200, {
          ok: true,
          items: doc.priceItems
            .slice()
            .sort((a, b) => (a.plan === b.plan ? a.months - b.months : a.plan < b.plan ? -1 : 1))
            .map((i) => membership.priceItemOut(doc, i)),
          cycles: membership.CYCLE_PRESETS,
          plans: Object.values(doc.plans)
            .filter((p) => p.id !== 'Free')
            .map((p) => ({ id: p.id, name: p.name })),
          states: membership.PRICE_STATE_TEXT,
        });
      }

      /** 新增价格条目 */
      if (url === '/api/admin/prices' && method === 'POST') {
        let input;
        try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
        snapshot('membership-change', { note: '新增价格条目' });
        const r = membership.upsertPriceItem(membershipStore.data, input);
        if (r.error) return json(res, 400, { ok: false, error: r.error });
        membershipStore.save();
        log('price item created:', r.item.plan, r.item.months + 'm', '¥' + r.item.price);
        auditLog(req, 'price.create', { target: r.item.id, after: { plan: r.item.plan, cycle: r.item.cycle,
          months: r.item.months, price: r.item.price, effectiveFrom: r.item.effectiveFrom,
          effectiveTo: r.item.effectiveTo, enabled: r.item.enabled, priority: r.item.priority } });
        return json(res, 200, { ok: true, warn: r.warn || '',
          item: membership.priceItemOut(membershipStore.data, r.item),
          plans: membership.plansForClient(membershipStore.data) });
      }

      /* ---- 1.6.0 在线支付网关配置（仅本机：守卫已在本区块入口检查） ----
       * ★ 故意**不打快照**：pay.json 不在备份文件清单里，打一份不含它的快照会给人
       *   「出事了能回滚支付配置」的错觉。这条链路的可追溯性靠审计（pay.config）。
       */

      if (url === '/api/admin/payment' && method === 'GET') {
        const c = payCfg(true);
        return json(res, 200, {
          ok: true,
          payment: pay.adminOut(c, {
            keyBroken: c.keyBroken, privateKeyBroken: c.privateKeyBroken,
            siteBaseUrl: siteBaseUrl(),
            siteBaseConfigured: !!String(process.env.PP_PUBLIC_URL || '').trim(),
            onlineReady: onlinePayReady(),
          }),
          notifyUrl: siteBaseUrl() + '/api/pay/notify',
          returnUrl: siteBaseUrl() + '/api/pay/return',
        });
      }

      if (url === '/api/admin/payment' && method === 'PUT') {
        let input;
        try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
        const before = pay.adminOut(payCfg(true));
        const cur = payStore.data;
        const next = pay.sanitizeCfg({
          enabled: input.enabled === undefined ? cur.enabled : !!input.enabled,
          provider: input.provider === undefined ? cur.provider : input.provider,
          gateway: input.gateway === undefined ? cur.gateway : input.gateway,
          pid: input.pid === undefined ? cur.pid : input.pid,
          name: input.name === undefined ? cur.name : input.name,
          queryMode: input.queryMode === undefined ? cur.queryMode : input.queryMode,
          keyEnc: cur.keyEnc,
          privateKeyEnc: cur.privateKeyEnc,
          platformKey: cur.platformKey,
        });
        // 保存前校验密钥可解析——别等回调来了才发现粘贴不完整
        const keyErr = pay.checkKeys({
          privateKey: typeof input.privateKey === 'string' ? input.privateKey : '',
          platformKey: typeof input.platformKey === 'string' ? input.platformKey : '',
        });
        if (keyErr) return json(res, 400, { ok: false, error: keyErr });
        if (cur.provider === 'mzf2' && next.provider === 'mzf2' && !next.pid) {
          return json(res, 400, { ok: false, error: 'V2（RSA）需要填写商户号 pid' });
        }
        // 密钥三态：提交非空 → 加密保存；提交空串 → 清除；未提交（undefined）→ 保持原值
        if (input.key !== undefined) {
          const k = String(input.key).trim();
          next.keyEnc = k ? secretbox.encrypt(DATA_DIR, k) : '';
        }
        if (input.privateKey !== undefined) {
          const k = pay.cleanKeyMaterial(input.privateKey);
          next.privateKeyEnc = k ? secretbox.encrypt(DATA_DIR, k) : '';
        }
        if (input.platformKey !== undefined) next.platformKey = pay.cleanKeyMaterial(input.platformKey);
        payStore.data = next;
        payStore.save();
        const after = pay.adminOut(payCfg(true));
        log('payment config updated:', 'enabled=' + after.enabled, 'provider=' + after.provider, 'ready=' + after.ready);
        auditLog(req, 'pay.config', {
          target: 'payment',
          before: { enabled: before.enabled, provider: before.provider, gateway: before.gateway, pid: before.pid, ready: before.ready },
          after: { enabled: after.enabled, provider: after.provider, gateway: after.gateway, pid: after.pid, ready: after.ready },
          note: input.note ? String(input.note).slice(0, 80) : '',
        });
        return json(res, 200, { ok: true, payment: after,
          notifyUrl: siteBaseUrl() + '/api/pay/notify', returnUrl: siteBaseUrl() + '/api/pay/return' });
      }

      /** 连接自检。deep=true 会按真实参数探一笔 0.01 元测试单（网关后台会留未支付记录） */
      if (url === '/api/admin/payment/test' && method === 'POST') {
        let input = {};
        try { input = await readBody(req); } catch (e) { /* 允许空体 */ }
        const c = payCfg(true);
        if (c.keyBroken || c.privateKeyBroken) {
          return json(res, 400, { ok: false, msg: '已保存的密钥无法解密（主密钥文件可能已更换），请重新粘贴密钥' });
        }
        let r;
        try {
          r = await pay.testConnection(c, { deep: !!input.deep });
        } catch (e) {
          r = { ok: false, msg: '自检异常：' + e.message };
        }
        log('payment connection test:', r.ok ? 'OK' : 'FAIL', '|', String(r.msg || '').slice(0, 160));
        return json(res, 200, { ok: !!r.ok, msg: r.msg || '', raw: r.raw || null });
      }

      /** 修改 / 启停价格条目（局部更新：未提交字段保持原值） */
      let pm = url.match(/^\/api\/admin\/prices\/([a-zA-Z0-9-]+)$/);
      if (pm && (method === 'PUT' || method === 'DELETE')) {
        const doc = membershipStore.data;
        const cur = doc.priceItems.find((i) => i && i.id === pm[1]);
        if (!cur) return json(res, 404, { ok: false, error: '价格条目不存在' });
        snapshot('membership-change', { note: (method === 'DELETE' ? '删除价格条目 ' : '修改价格条目 ') + pm[1] });
        if (method === 'DELETE') {
          const r = membership.removePriceItem(doc, pm[1]);
          if (r.error) return json(res, 400, { ok: false, error: r.error });
          membershipStore.save();
          log('price item deleted:', pm[1], r.item.plan, r.item.months + 'm');
          auditLog(req, 'price.delete', { target: pm[1], before: { plan: r.item.plan, months: r.item.months,
            price: r.item.price, cycle: r.item.cycle } });
          return json(res, 200, { ok: true, plans: membership.plansForClient(doc) });
        }
        let input;
        try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
        // 局部更新：只覆盖显式提交的字段，其余沿用现值
        // ⚠️ 新增字段必须同步加进这里，否则「只改 enabled」之类的局部更新会把该字段抹掉
        const merged = {
          id: cur.id, plan: input.plan !== undefined ? input.plan : cur.plan,
          months: input.months !== undefined ? input.months : cur.months,
          price: input.price !== undefined ? input.price : cur.price,
          label: input.label !== undefined ? input.label : cur.label,
          cycle: input.cycle !== undefined ? input.cycle : cur.cycle,
          effectiveFrom: input.effectiveFrom !== undefined ? input.effectiveFrom : cur.effectiveFrom,
          effectiveTo: input.effectiveTo !== undefined ? input.effectiveTo : cur.effectiveTo,
          enabled: input.enabled !== undefined ? input.enabled : cur.enabled,
          priority: input.priority !== undefined ? input.priority : cur.priority,
          note: input.note !== undefined ? input.note : cur.note,
          createdAt: cur.createdAt,
        };
        const r = membership.upsertPriceItem(doc, merged);
        if (r.error) return json(res, 400, { ok: false, error: r.error });
        membershipStore.save();
        log('price item updated:', r.item.id, r.item.plan, r.item.months + 'm', '¥' + r.item.price);
        auditLog(req, 'price.update', { target: r.item.id,
          before: { price: cur.price, months: cur.months, enabled: cur.enabled, priority: cur.priority,
            effectiveFrom: cur.effectiveFrom, effectiveTo: cur.effectiveTo },
          after: { price: r.item.price, months: r.item.months, enabled: r.item.enabled, priority: r.item.priority,
            effectiveFrom: r.item.effectiveFrom, effectiveTo: r.item.effectiveTo } });
        return json(res, 200, { ok: true, warn: r.warn || '',
          item: membership.priceItemOut(doc, r.item),
          plans: membership.plansForClient(doc) });
      }

      /* --- 1.5.0 AI 计费：单价表 + 成本看板 (仅本机直连) --- */

      /** 单价表全量（含「实际用过但未配价」的模型，供补价） */
      if (url === '/api/admin/pricing' && method === 'GET') {
        return json(res, 200, { ok: true, pricing: pricingAdminOut() });
      }

      /** 单价表写入（局部）：{ set:{模型:{inPer1k,outPer1k,note}}, remove:[模型], fallback:{inPer1k,outPer1k} } */
      if (url === '/api/admin/pricing' && method === 'PUT') {
        let input;
        try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
        const doc = pricingStore.data;
        const changed = [];
        if (Array.isArray(input.remove)) {
          for (const m of input.remove) {
            const r = pricing.removeModel(doc, m);
            if (!r.error) changed.push({ op: 'remove', model: r.model });
          }
        }
        if (input.set && typeof input.set === 'object' && !Array.isArray(input.set)) {
          for (const [m, v] of Object.entries(input.set)) {
            const r = pricing.setModel(doc, m, v);
            if (r.error) return json(res, 400, { ok: false, error: m + '：' + r.error });
            changed.push({ op: 'set', model: r.model, inPer1k: r.entry.inPer1k, outPer1k: r.entry.outPer1k });
          }
        }
        if (input.fallback && typeof input.fallback === 'object') {
          doc.fallback = {
            inPer1k: pricing.normPrice(input.fallback.inPer1k, 0),
            outPer1k: pricing.normPrice(input.fallback.outPer1k, 0),
          };
          changed.push({ op: 'fallback', inPer1k: doc.fallback.inPer1k, outPer1k: doc.fallback.outPer1k });
        }
        // 1.6.0 余额配置（局部更新：未提交的字段保持原值）
        if (input.balance && typeof input.balance === 'object' && !Array.isArray(input.balance)) {
          const merged = Object.assign({}, doc.balance || {}, input.balance);
          const cfg = balance.normalizeCfg({ balance: merged });
          doc.balance = cfg;
          changed.push({ op: 'balance', enforce: cfg.enforce,
            signupGrantMicro: cfg.signupGrantMicro, signupValidDays: cfg.signupValidDays,
            minBalanceMicro: cfg.minBalanceMicro, rechargeOptions: cfg.rechargeOptions.length });
        }
        if (!changed.length) return json(res, 400, { ok: false, error: '没有可应用的改动（需提供 set / remove / fallback）' });
        pricing.normalize(doc);
        pricingStore.save();
        log('pricing updated:', JSON.stringify(changed));
        auditLog(req, 'pricing.update', { after: changed });
        return json(res, 200, { ok: true, changed, pricing: pricingAdminOut() });
      }

      /** 成本看板：总量 / 按天 / 按模型（全时段）/ Top 消耗账号 / 未配价模型 */
      if (url === '/api/admin/usage-summary' && method === 'GET') {
        const q = queryOf(req);
        return json(res, 200, { ok: true, summary: usageSummary(q.days) });
      }

      /** 改套餐配置 / 收款信息（局部更新，未提交的字段保持原值） */
      if (url === '/api/admin/membership' && method === 'PUT') {
        let input;
        try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
        snapshot('membership-change', { note: '改套餐额度/收款配置' });
        const doc = membershipStore.data;
        const cfgBefore = { plans: JSON.parse(JSON.stringify(doc.plans || {})),
          pay: JSON.parse(JSON.stringify(doc.pay || {})),
          ai: JSON.parse(JSON.stringify(doc.ai || {})) };
        if (input.plans && typeof input.plans === 'object') {
          for (const [pid, p] of Object.entries(input.plans)) {
            if (!doc.plans[pid] || !p || typeof p !== 'object') continue;
            if (p.dailyLimit !== undefined) doc.plans[pid].dailyLimit = Math.max(0, Number(p.dailyLimit) || 0);
            if (p.price !== undefined) doc.plans[pid].price = Math.max(0, Number(p.price) || 0);
            if (p.name !== undefined) doc.plans[pid].name = String(p.name).slice(0, 20);
            if (p.tagline !== undefined) doc.plans[pid].tagline = String(p.tagline).slice(0, 60);
            // 1.4.9：高级模型开关（此前只定义、无处可改——补上管理入口）
            if (p.highTierModels !== undefined) doc.plans[pid].highTierModels = !!p.highTierModels;
            // 1.6.0 订阅去无限化：每月发放的额度（微元；0 = 该档不发）
            if (p.monthlyGrantMicro !== undefined) {
              doc.plans[pid].monthlyGrantMicro = Math.max(0, Math.round(Number(p.monthlyGrantMicro) || 0));
            }
            if (Array.isArray(p.features)) {
              doc.plans[pid].features = p.features.slice(0, 12).map((s) => String(s).slice(0, 80));
            }
          }
        }
        // 1.4.9 全局 AI 策略：新用户全模型试用天数（0 = 关闭）
        // 只夹取这一个字段，不整体 renormalize（避免顺手改动别的表）
        if (input.ai && typeof input.ai === 'object' && input.ai.trialDays !== undefined) {
          const td = Math.round(Number(input.ai.trialDays));
          if (!Number.isFinite(td)) return json(res, 400, { ok: false, error: 'ai.trialDays 必须是数字' });
          doc.ai = Object.assign({}, doc.ai || {}, { trialDays: Math.max(0, Math.min(365, td)) });
        }
        if (input.pay && typeof input.pay === 'object') {
          if (input.pay.channel !== undefined) doc.pay.channel = String(input.pay.channel).slice(0, 20);
          if (input.pay.qrImage !== undefined) doc.pay.qrImage = String(input.pay.qrImage).slice(0, 500);
          if (input.pay.qrText !== undefined) doc.pay.qrText = String(input.pay.qrText).slice(0, 500);
          if (input.pay.note !== undefined) doc.pay.note = String(input.pay.note).slice(0, 200);
        }
        // 兼容旧后台：提交 priceOptions（平铺档位）时，同步到对应价格条目
        // —— 命中「同等级 + 同月数」的现有条目就改价，没有就新建一条立即生效的价格。
        if (input.priceOptions && typeof input.priceOptions === 'object') {
          for (const [pid, list] of Object.entries(input.priceOptions)) {
            if (!Array.isArray(list)) continue;
            for (const o of list) {
              if (!o) continue;
              const months = membership.clampMonths(o.months);
              const price = Math.max(0, Number(o.price) || 0);
              const exist = doc.priceItems.find((i) => i.plan === pid && i.months === months);
              const r = membership.upsertPriceItem(doc, {
                id: exist ? exist.id : null, plan: pid, months, price,
                label: String(o.label || '').slice(0, 40),
                effectiveFrom: exist ? exist.effectiveFrom : null,
                effectiveTo: exist ? exist.effectiveTo : null,
                enabled: true,
              });
              if (r.error) log('priceOptions 兼容写入失败:', pid, months, r.error);
            }
          }
        }
        membershipStore.save();
        log('membership config updated');
        auditLog(req, 'membership.config', { target: 'plans+pay+ai',
          before: cfgBefore, after: { plans: input.plans || null, pay: input.pay || null, ai: input.ai || null } });
        return json(res, 200, { ok: true, plans: membership.plansForClient(membershipStore.data),
          ai: { trialDays: membership.trialDaysFor(membershipStore.data) } });
      }

      if (url === '/api/admin/orders' && method === 'GET') {
        if (membership.reapOrders(membershipStore.data)) membershipStore.save();
        return json(res, 200, {
          ok: true,
          orders: membershipStore.data.orders.slice().reverse()
            .map((o) => Object.assign(membership.orderOut(membershipStore.data, o),
              { userId: o.userId, email: o.email })),
        });
      }

      /** 核销（fulfill）/ 取消（cancel）订单 */
      m = url.match(/^\/api\/admin\/orders\/([a-zA-Z0-9-]+)\/(fulfill|cancel)$/);
      if (m && method === 'POST') {
        const order = membership.findOrder(membershipStore.data, m[1]);
        if (!order) return json(res, 404, { ok: false, error: '订单不存在' });
        let input = {};
        try { input = await readBody(req); } catch (e) { /* 允许空请求体 */ }
        if (m[2] === 'fulfill') {
          snapshot('orders-change', { note: '核销订单 ' + order.id });
          const r = applyOrderFulfill(order, 'admin');
          if (!r.ok) return json(res, 400, { ok: false, error: r.error });
          const user = r.user;
          membershipStore.save();
          usersStore.save();
          if (order.kind === 'credit') {
            log('credit order fulfilled:', order.id, user.email, order.creditMicro + ' micro');
            auditLog(req, 'order.fulfill', { target: order.id, note: '充值入账 ' + user.email,
              after: { kind: 'credit', creditMicro: order.creditMicro,
                amountCents: membership.amountCentsOf(order),
                balanceMicro: (user.balance || {}).paidMicro } });
            return json(res, 200, {
              ok: true, order: membership.orderOut(membershipStore.data, order),
              archiveCode: null, user: userAdminOut(user),
            });
          }
          log('order fulfilled:', order.id, user.email, order.plan, order.months + 'm');
          auditLog(req, 'order.fulfill', { target: order.id, note: '下单账号 ' + user.email,
            after: { plan: order.plan, months: order.months, perpetual: !!order.perpetual,
              amountCents: membership.amountCentsOf(order),
              expiresAt: (user.membership && user.membership.expiresAt) || null } });
          return json(res, 200, {
            ok: true, order: membership.orderOut(membershipStore.data, order),
            archiveCode: r.order.codeId ? membership.codeOut(
              membershipStore.data.codes.find((c) => c.id === r.order.codeId)) : null,
            user: userAdminOut(user),
          });
        }
        snapshot('orders-change', { note: '取消订单 ' + order.id });
        const r = membership.cancelOrder(membershipStore.data, order, { id: order.userId }, input.reason || '管理员取消');
        if (r.error) return json(res, 400, { ok: false, error: r.error });
        membershipStore.save();
        auditLog(req, 'order.cancel', { target: order.id, note: String((input && input.reason) || '管理员取消'),
          before: { status: 'claimed' }, after: { status: order.status } });
        return json(res, 200, { ok: true, order: membership.orderOut(membershipStore.data, order) });
      }

      /** 激活码：批量生成 / 列表 / 作废（已使用的不可删，保留对账） */
      if (url === '/api/admin/codes') {
        if (method === 'GET') {
          return json(res, 200, { ok: true,
            codes: membershipStore.data.codes.slice().reverse().map((c) => adminCodeOut(c)) });
        }
        if (method === 'POST') {
          let input;
          try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
          snapshot('membership-change', { note: '生成激活码' });
          const r = membership.createCodes(membershipStore.data, {
            plan: input.plan, months: input.months, count: input.count,
            note: input.note, by: 'admin',
            expiresAt: input.expiresAt || null, boundTo: input.boundTo || null,
          });
          if (r.error) return json(res, 400, { ok: false, error: r.error });
          membershipStore.save();
          log('activation codes created:', r.codes.length, input.plan, input.months + 'm');
          auditLog(req, 'code.create', { target: r.codes.length + ' 枚',
            note: '不记录码值本身（激活码即凭据）',
            after: { plan: input.plan, months: input.months, count: r.codes.length,
              boundTo: input.boundTo || null, expiresAt: input.expiresAt || null, note: input.note || '' } });
          return json(res, 200, { ok: true, codes: r.codes });
        }
      }
      m = url.match(/^\/api\/admin\/codes\/([a-zA-Z0-9-]+)$/);
      if (m && method === 'DELETE') {
        const idx = membershipStore.data.codes.findIndex((c) => c && c.id === m[1]);
        if (idx < 0) return json(res, 404, { ok: false, error: '激活码不存在' });
        if (membershipStore.data.codes[idx].usedAt) {
          return json(res, 400, { ok: false, error: '已使用的激活码不能删除（保留对账记录）' });
        }
        membershipStore.data.codes.splice(idx, 1);
        membershipStore.save();
        log('activation code revoked:', m[1]);
        auditLog(req, 'code.revoke', { target: m[1], before: { status: 'unused' } });
        return json(res, 200, { ok: true });
      }

      /** 直接给指定用户开通/续期会员（叠加式，与激活码同语义） */
      m = url.match(/^\/api\/admin\/users\/([a-zA-Z0-9-]+)\/membership$/);
      if (m && method === 'POST') {
        const user = findUserById(m[1]);
        if (!user) return json(res, 404, { ok: false, error: '用户不存在' });
        let input;
        try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
        snapshot('membership-change', { note: '管理员开通/续期：' + user.email });
        const perpetual = !!input.perpetual || Number(input.months) === 0;
        const mp = membership.grantMembership(membershipStore.data, user, {
          plan: input.plan || 'Pro',
          months: perpetual ? 0 : (input.months || 1),
          perpetual,
          source: 'admin', note: input.note || '',
        });
        usersStore.save();
        log('membership granted by admin:', user.email, mp.plan,
          perpetual ? '永久' : mp.expiresAt);
        auditLog(req, 'user.membership', { target: user.email, note: input.note || '',
          after: { plan: mp.plan, perpetual: !!mp.perpetual, expiresAt: mp.expiresAt, daysLeft: mp.daysLeft } });
        return json(res, 200, { ok: true, membership: mp, user: userAdminOut(user) });
      }

      /** 1.6.0 管理员充值 / 调余额：{ micro（有符号微元）, kind: recharge|adjust, reason } */
      m = url.match(/^\/api\/admin\/users\/([a-zA-Z0-9-]+)\/balance$/);
      if (m && method === 'POST') {
        const user = findUserById(m[1]);
        if (!user) return json(res, 404, { ok: false, error: '用户不存在' });
        let input;
        try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
        const before = balance.adminView(user);
        const r = balance.adminAdjust(user, {
          micro: input.micro, kind: input.kind, reason: input.reason, refId: input.refId,
        });
        if (r.error) return json(res, 400, { ok: false, error: r.error });
        usersStore.save();
        log('balance adjusted by admin:', user.email, (Number(input.micro) || 0) + ' micro', input.reason || '');
        auditLog(req, 'balance.adjust', { target: user.email,
          before: { totalMicro: before.totalMicro, grantedMicro: before.grantedMicro, paidMicro: before.paidMicro },
          after: { totalMicro: r.balance.totalMicro, grantedMicro: r.balance.grantedMicro, paidMicro: r.balance.paidMicro },
          note: input.reason || '' });
        return json(res, 200, { ok: true, balance: r.balance, user: userAdminOut(user) });
      }

      /* ---- 数据快照与一键回滚（1.4.2） ---- */

      if (url === '/api/admin/backups' && method === 'GET') {
        const items = backup.list(DATA_DIR);
        return json(res, 200, { ok: true, items, policy: backup.policy(),
          latest: items.length ? items[0].id : null });
      }
      if (url === '/api/admin/backups' && method === 'POST') {
        let input = {};
        try { input = await readBody(req); } catch (e) { /* 允许空体 */ }
        const r = backup.snapshot(DATA_DIR, 'manual', { note: input && input.note, force: true });
        const pr = backup.prune(DATA_DIR);
        log('manual snapshot:', r.snapshot && r.snapshot.id, 'pruned=' + pr.removed.length);
        auditLog(req, 'backup.create', { target: (r.snapshot && r.snapshot.id) || '', note: (input && input.note) || '' });
        return json(res, 200, { ok: true, snapshot: r.snapshot, pruned: pr.removed });
      }
      let bm = url.match(/^\/api\/admin\/backups\/([A-Za-z0-9_-]+)(\/restore)?$/);
      if (bm && method === 'DELETE' && !bm[2]) {
        const snap = backup.find(DATA_DIR, bm[1]);
        if (!snap) return json(res, 404, { ok: false, error: '快照不存在' });
        fs.rmSync(path.join(backup.backupRoot(DATA_DIR), bm[1]), { recursive: true, force: true });
        log('snapshot deleted:', bm[1]);
        auditLog(req, 'backup.delete', { target: bm[1], before: { at: snap.at, reason: snap.reason } });
        return json(res, 200, { ok: true });
      }
      if (bm && method === 'POST' && bm[2]) {
        let input = {};
        try { input = await readBody(req); } catch (e) { /* 允许空体 */ }
        // 二次确认：回滚会把全站数据退回旧状态，必须显式回填 RESTORE，杜绝误点
        if (String((input && input.confirm) || '') !== 'RESTORE') {
          return json(res, 400, { ok: false,
            error: '回滚是不可逆操作：请在请求体里带上 {"confirm":"RESTORE"} 以确认' });
        }
        const r = backup.restore(DATA_DIR, bm[1], { note: input && input.note });
        if (r.error) return json(res, 404, { ok: false, error: r.error });
        if (r.mismatched && r.mismatched.length) {
          log('RESTORE HASH MISMATCH:', r.mismatched.join(','));
          auditLog(req, 'backup.restore', { target: bm[1], ok: false,
            note: '回滚后校验失败：' + r.mismatched.join('、'), after: { mismatched: r.mismatched } });
          return json(res, 500, { ok: false,
            error: '回滚后校验失败：' + r.mismatched.join('、')
              + '（已保留现场快照 ' + r.safety + '，请勿继续操作）', result: r });
        }
        const counts = reloadStores();
        log('restored from:', bm[1], 'safety=' + r.safety, JSON.stringify(counts));
        auditLog(req, 'backup.restore', { target: bm[1], note: '现场快照 ' + r.safety, after: counts });
        return json(res, 200, { ok: true, result: r, counts });
      }

      /* ---- 订单积压告警（1.4.2） ---- */

      if (url === '/api/admin/alerts' && method === 'GET') {
        return json(res, 200, { ok: true, alerts: alertStatus(), log: readAlertLogTail(40) });
      }
      if (url === '/api/admin/alerts/check' && method === 'POST') {
        let input = {};
        try { input = await readBody(req); } catch (e) { /* 允许空体 */ }
        const r = await runAlertCheck({ force: true, dryRun: !!(input && input.dryRun) });
        auditLog(req, 'alert.check', { after: {
          backlog: r.backlog && r.backlog.backlogCount,
          devicesOver: r.devices && r.devices.devicesOverLimit,
          alerted: r.alerted, devicesAlerted: r.devices && r.devices.alerted, mailed: r.mailed } });
        return json(res, 200, { ok: true, result: r, alerts: alertStatus() });
      }

      /* ---- 收款流水对账（1.4.5）：按金额（含唯一尾数）自动匹配并核销 ---- */

      /**
       * body: { text?: '每行「金额,时间,备注」', entries?: [{amount|amountCents, at, note, txnId}],
       *         dryRun?: false 才真核销（默认只预览）, windowDays?: 30 }
       * 说明：核销语义与管理员手动核销完全一致（叠加开通 + 留档一枚已用码），只是触发源换成流水。
       */
      if (url === '/api/admin/reconcile' && method === 'POST') {
        let input = {};
        try { input = await readBody(req); } catch (e) { /* 允许空体 */ }
        const entries = (Array.isArray(input.entries) && input.entries.length)
          ? input.entries.map((e) => ({
            amountCents: Math.round((Number(e && e.amountCents) || Number(e && e.amount) * 100) || 0),
            at: Date.parse((e && e.at) || '') || Date.now(),
            note: String((e && e.note) || ''),
            txnId: String((e && e.txnId) || ''),
            raw: String((e && e.raw) || ''),
          })).filter((e) => e.amountCents > 0)
          : reconcile.parseEntries(input.text || '');
        if (!entries.length) {
          return json(res, 400, { ok: false,
            error: '没有解析出任何收款流水。每行格式：金额,时间,备注（时间与备注可空），例如 128.62,2026-10-03 12:30,微信' });
        }
        const dryRun = input.dryRun !== false;   // 默认只预览：必须显式传 dryRun:false 才真核销
        const m = reconcile.matchPayments(membershipStore.data, entries, {
          windowDays: input.windowDays, membership,
        });
        if (dryRun) {
          return json(res, 200, { ok: true, dryRun: true, results: m.results, summary: m.summary,
            statusText: reconcile.STATUS_TEXT });
        }
        const applied = [];
        for (const r of m.results) {
          if (r.status !== 'matched') continue;
          const order = membership.findOrder(membershipStore.data, r.orderId);
          if (!order) {
            applied.push({ orderId: r.orderId, ok: false, error: '订单已不存在' });
            continue;
          }
          snapshot('orders-change', { note: '对账核销 ' + order.id });
          const f = applyOrderFulfill(order, 'reconcile');
          if (!f.ok) { applied.push({ orderId: order.id, ok: false, error: f.error }); continue; }
          const user = f.user;
          if (order.kind === 'credit') {
            applied.push({ orderId: order.id, ok: true, email: user.email, kind: 'credit',
              creditMicro: order.creditMicro, balanceMicro: (user.balance || {}).paidMicro });
            auditLog(req, 'order.reconcile', {
              target: order.id,
              note: '对账自动充值：' + user.email + '（流水 ' + reconcile.money(r.amountCents)
                + (r.entry && r.entry.txnId ? ' / ' + r.entry.txnId : '') + '）',
              after: { kind: 'credit', amountCents: r.amountCents, creditMicro: order.creditMicro },
            });
            continue;
          }
          const mp = (user.membership) || {};
          applied.push({ orderId: order.id, ok: true, email: user.email,
            plan: mp.plan || null, perpetual: !!mp.perpetual, expiresAt: mp.expiresAt || null });
          auditLog(req, 'order.reconcile', {
            target: order.id,
            note: '对账自动核销：' + user.email + '（流水 ' + reconcile.money(r.amountCents)
              + (r.entry && r.entry.txnId ? ' / ' + r.entry.txnId : '') + '）',
            after: { amountCents: r.amountCents, perpetual: !!mp.perpetual, expiresAt: mp.expiresAt || null },
          });
        }
        membershipStore.save();
        usersStore.save();
        log('reconcile applied:',
          applied.filter((x) => x.ok).length + '/' + m.results.length,
          'matched=' + m.summary.matched, 'cents=' + m.summary.matchedCents);
        return json(res, 200, { ok: true, dryRun: false, results: m.results, summary: m.summary,
          applied, statusText: reconcile.STATUS_TEXT });
      }

      /* ---- 管理操作审计（1.4.4） ---- */

      if (url === '/api/admin/audit' && method === 'GET') {
        const q = new URLSearchParams((req.url.split('?')[1] || ''));
        const items = audit.list(DATA_DIR, {
          limit: q.get('limit'), action: q.get('action') || '', target: q.get('target') || '',
          ok: q.has('ok') ? q.get('ok') === '1' : undefined,
          since: q.get('since') || '', until: q.get('until') || '',
        }).map((e) => Object.assign({}, e, { actionText: audit.labelOf(e.action) }));
        return json(res, 200, { ok: true, items, actions: audit.ACTIONS, stats: audit.stats(DATA_DIR) });
      }

      /* ---- 登录设备（1.4.7，仅本机直连）----
       * 与用户侧 `/api/sessions` 的差别：这里给**完整 IP**（出事时要能追），
       * 并且允许管理员踢出任意设备（处置账号共享）；两者都会写审计。 */

      m = url.match(/^\/api\/admin\/users\/([a-zA-Z0-9-]+)\/sessions$/);
      if (m && method === 'GET') {
        const u = findUserById(m[1]);
        if (!u) return json(res, 404, { ok: false, error: '用户不存在' });
        const det = sessions.sessionsOfDetailed(usersStore.data, u.id);
        const list = det.list.map((r) => sessions.sessionOut(r, { full: true }));
        if (det.changed) usersStore.save();
        return json(res, 200, {
          ok: true, email: u.email, sessions: list,
          activeCount: list.filter((x) => x.active).length,
          activeDays: sessions.activeDays(), maxDevices: sessions.maxDevices(),
        });
      }

      m = url.match(/^\/api\/admin\/users\/([a-zA-Z0-9-]+)\/sessions\/([a-zA-Z0-9-]+)$/);
      if (m && method === 'DELETE') {
        const u = findUserById(m[1]);
        if (!u) return json(res, 404, { ok: false, error: '用户不存在' });
        snapshot('users-change', { note: '管理员踢出设备：' + u.email + ' / ' + m[2] });
        const r = sessions.revokeSid(usersStore.data, u.id, m[2]);
        if (r.error) return json(res, 404, { ok: false, error: r.error });
        usersStore.save();
        auditLog(req, 'session.revoke-admin', { target: u.email, after: { sid: r.revoked } });
        log('session revoked by admin:', u.email, r.revoked);
        return json(res, 200, { ok: true, revoked: r.revoked });
      }

      /* ---- 优惠券 / 折扣码（1.4.6） ----
       * 与激活码的分工：激活码**发会员**（免费、不走订单），优惠券**只打折**（走完整下单收款）。
       * 券码值本身不是敏感凭据（泄漏最多让人少付点钱），所以后台可查、并按需写进审计。 */

      if (url === '/api/admin/coupons' && method === 'GET') {
        const list = (membershipStore.data.coupons || []).slice().reverse()
          .map((c) => coupon.couponOut(c));
        const by = (st) => list.filter((c) => c.state === st).length;
        return json(res, 200, { ok: true, coupons: list, types: coupon.TYPE_TEXT,
          counts: {
            total: list.length, active: by('active'), scheduled: by('scheduled'),
            exhausted: by('exhausted'), disabled: by('disabled'), expired: by('expired'),
            reserved: list.reduce((n, c) => n + c.usedReserved, 0),
            used: list.reduce((n, c) => n + c.usedDone, 0),
          } });
      }

      if (url === '/api/admin/coupons' && method === 'POST') {
        let input;
        try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
        snapshot('membership-change', { note: '生成优惠券' });
        const r = coupon.createCoupons(membershipStore.data, {
          type: input.type, percent: input.percent, amountCents: input.amountCents,
          plans: input.plans, minAmountCents: input.minAmountCents,
          maxUses: input.maxUses, perUser: input.perUser,
          effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo,
          note: input.note, count: input.count, createdBy: 'admin',
        });
        if (r.error) return json(res, 400, { ok: false, error: r.error });
        membershipStore.save();
        log('coupons created:', r.coupons.length, input.type,
          input.type === 'amount' ? ('¥' + (Number(input.amountCents) / 100).toFixed(2)) : (input.percent + '%'));
        // 审计记「配置与数量」，**不逐条落码值**（批量生成时会把日志撑爆）
        auditLog(req, 'coupon.create', { target: r.coupons.length + ' 枚券',
          after: { type: input.type, percent: input.percent || null, amountCents: input.amountCents || null,
            plans: input.plans || [], minAmountCents: input.minAmountCents || 0,
            maxUses: input.maxUses || 0, perUser: input.perUser,
            effectiveFrom: input.effectiveFrom || null, effectiveTo: input.effectiveTo || null,
            count: r.coupons.length, note: input.note || '' } });
        return json(res, 200, { ok: true, coupons: r.coupons.map((c) => coupon.couponOut(c)) });
      }

      m = url.match(/^\/api\/admin\/coupons\/([a-zA-Z0-9-]+)$/);
      if (m && method === 'PUT') {
        let input;
        try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
        const before = coupon.findById(membershipStore.data, m[1]);
        if (!before) return json(res, 404, { ok: false, error: '优惠券不存在' });
        const b4 = { enabled: before.enabled, maxUses: before.maxUses, perUser: before.perUser,
          percent: before.percent, amountCents: before.amountCents,
          minAmountCents: before.minAmountCents,
          effectiveFrom: before.effectiveFrom, effectiveTo: before.effectiveTo, note: before.note };
        snapshot('membership-change', { note: '修改优惠券 ' + before.code });
        const r = coupon.updateCoupon(membershipStore.data, m[1], input);
        if (r.error) return json(res, 400, { ok: false, error: r.error });
        membershipStore.save();
        log('coupon updated:', r.coupon.code);
        auditLog(req, 'coupon.update', { target: r.coupon.code, before: b4, after: {
          enabled: r.coupon.enabled, maxUses: r.coupon.maxUses, perUser: r.coupon.perUser,
          percent: r.coupon.percent, amountCents: r.coupon.amountCents,
          minAmountCents: r.coupon.minAmountCents,
          effectiveFrom: r.coupon.effectiveFrom, effectiveTo: r.coupon.effectiveTo, note: r.coupon.note } });
        return json(res, 200, { ok: true, coupon: coupon.couponOut(r.coupon) });
      }

      if (m && method === 'DELETE') {
        const target = coupon.findById(membershipStore.data, m[1]);
        if (!target) return json(res, 404, { ok: false, error: '优惠券不存在' });
        snapshot('membership-change', { note: '删除优惠券 ' + target.code });
        const r = coupon.removeCoupon(membershipStore.data, m[1]);
        if (r.error) return json(res, 400, { ok: false, error: r.error });
        membershipStore.save();
        log('coupon revoked:', r.coupon.code);
        auditLog(req, 'coupon.revoke', { target: r.coupon.code, before: {
          state: coupon.stateOf(r.coupon), used: coupon.usedCount(r.coupon) } });
        return json(res, 200, { ok: true });
      }
    }

    return json(res, 404, { ok: false, error: 'not found: ' + method + ' ' + url });
  } catch (e) {
    log('ERROR', method, url, e && (e.stack || e.message));
    if (!res.headersSent) json(res, 500, { ok: false, error: '服务器内部错误：' + (e && e.message) });
    else { try { res.end(); } catch (_) { /* ignore */ } }
  }
});

if (require.main === module) {
  // 启动即打一份每日快照并清退过期快照（服务端原本是一份孤本，没有退路）
  try {
    const r = backup.snapshot(DATA_DIR, 'daily', { note: '服务启动快照' });
    const pr = backup.prune(DATA_DIR);
    log('startup snapshot:', (r.snapshot && r.snapshot.id) || ('skipped(' + r.skipped + ')'),
      '| snapshots kept=' + pr.kept, 'pruned=' + pr.removed.length);
  } catch (e) {
    log('startup snapshot failed:', e.message);
  }
  startBackgroundJobs();
  server.listen(PORT, HOST, () => {
    log('PaperPilot account server listening on http://' + HOST + ':' + PORT);
    log('admin page: http://' + HOST + ':' + PORT + '/admin  (loopback only)');
    log('data dir :', DATA_DIR);
    log('token ttl:', Math.round(TOKEN_TTL_MS / 3600e3) + 'h (sliding renewal on /me and /v1/*)');
  });
  const shutdown = (sig) => {
    log('shutdown (' + sig + ')');
    stopBackgroundJobs();
    // 兜底：把网关调用节流续期中尚未落盘的令牌有效期刷盘
    if (_tokenSaveTimer) { clearTimeout(_tokenSaveTimer); _tokenSaveTimer = null; }
    try { usersStore.save(); } catch (e) { log('shutdown save failed:', e.message); }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = {
  server, PORT, DATA_DIR,
  startBackgroundJobs, stopBackgroundJobs, runAlertCheck, alertStatus,
  backlogNow, deviceAlertNow, reloadStores, snapshot,
  usageDays, bumpUsage, isoDay, pruneUsageDaily, USAGE_KEEP_DAYS, today,
  // 1.5.0 AI 计量
  recordUsage, usageTotalsIn, usageSeriesDays, costViewOf, usageSummary, pricingAdminOut,
  pricingStore,
};
