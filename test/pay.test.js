#!/usr/bin/env node
/* 在线支付网关测试（服务端 1.7.0）
 *
 * 运行：node test/pay.test.js
 *
 * 覆盖：
 *   A 纯函数 —— 签名/验签（V1 MD5、V2 RSA）、密钥材料、商户订单号、加密盒子
 *   B 协议   —— 对着**假网关**跑下单地址生成、主动查单（标准/checkOrder 变体）、连接自检
 *   C 集成   —— 真服务端 + 假网关：配置读写（密钥不回显）→ 发起支付 → 回调履约 →
 *              余额到账 → 重放幂等；以及五重校验逐条拒绝
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-pay-'));
process.env.PP_DATA_DIR = WORK;
process.env.PP_PORT = '0';
process.env.PP_PUBLIC_URL = 'https://pp.test.example';
process.env.PP_LOGIN_MAX = '500';
process.env.PP_PAY_MAX = '500';
process.env.PP_PAY_QUERY_MAX = '500';
process.env.PP_PAY_NOTIFY_MAX = '500';
delete process.env.PP_RESEND_KEY;

const KEY = 'TESTMERCHANTKEY0123456789abcdef';       // V1 商户密钥（假）
let UPSTREAM_PORT = 0;

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

const yuan = (n) => Math.round(n * 1e6);

function req(port, method, p, body, token, headers) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined || body === null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const h = Object.assign({}, headers || {});
    if (payload) { h['Content-Type'] = 'application/json'; h['Content-Length'] = payload.length; }
    if (token) h['Authorization'] = 'Bearer ' + token;
    const r = http.request({ host: '127.0.0.1', port: port, method, path: p, headers: h, agent: false }, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        const text = Buffer.concat(cs).toString('utf8');
        let j = null;
        try { j = JSON.parse(text); } catch (e) { /* 非 JSON（回调应答是纯文本） */ }
        resolve({ status: res.statusCode, json: j, text });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function userOnDisk(email) {
  const doc = JSON.parse(fs.readFileSync(path.join(WORK, 'users.json'), 'utf8'));
  return doc.users.find((x) => x.email === email);
}
function orderOnDisk(id) {
  const doc = JSON.parse(fs.readFileSync(path.join(WORK, 'membership.json'), 'utf8'));
  return (doc.orders || []).find((o) => o.id === id);
}

(async () => {
  const pay = require(path.join(__dirname, '..', 'server', 'lib', 'pay.js'));
  const secretbox = require(path.join(__dirname, '..', 'server', 'lib', 'secretbox.js'));
  let mod = null;
  let gw = null;

  try {
    /* ================= A. 纯函数 ================= */

    const p1 = { pid: '1001', type: 'wxpay', out_trade_no: 'PPABC123', money: '10.42', name: 'x' };
    const sign1 = pay.buildSign(p1, KEY);
    eq(!!sign1 && sign1.length, 32, 'A1 V1 签名是 32 位 MD5 十六进制');
    ok(pay.verifySign(Object.assign({}, p1, { sign: sign1 }), KEY), 'A2 正确签名通过验签');
    ok(!pay.verifySign(Object.assign({}, p1, { sign: sign1, money: '0.01' }), KEY), 'A3 ★ 改金额 → 验签失败');
    ok(!pay.verifySign(Object.assign({}, p1, { sign: sign1 }), 'WRONGKEY'), 'A4 错密钥 → 验签失败');
    ok(!pay.verifySign(Object.assign({}, p1), KEY), 'A5 缺 sign → 验签失败');

    // 待签名串规则：剔除空值/sign/sign_type、键名升序
    eq(pay.buildSignStr({ b: '2', a: '1', sign: 'zz', sign_type: 'MD5', c: '' }), 'a=1&b=2',
      'A6 待签名串：升序 + 剔除空值与 sign 字段');

    // V2：真生成一对 RSA 密钥来验
    const kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    const privB64 = pay.cleanKeyMaterial(kp.privateKey);
    const pubB64 = pay.cleanKeyMaterial(kp.publicKey);
    eq(pay.checkKeys({ privateKey: kp.privateKey, platformKey: kp.publicKey }), '', 'A7 PEM 形式的密钥校验通过');
    ok(pay.checkKeys({ privateKey: 'not-a-key' }).indexOf('无法解析') >= 0, 'A8 坏私钥被挡下（保存前就报错）');
    const p2 = { pid: '2001', out_trade_no: 'PPX1', money: '5.00', timestamp: '1700000000' };
    const s2 = pay.rsaSign(p2, privB64);
    ok(pay.rsaVerify(Object.assign({}, p2, { sign: s2 }), pubB64), 'A9 V2 RSA 签名/验签往返');
    ok(!pay.rsaVerify(Object.assign({}, p2, { sign: s2, money: '9.99' }), pubB64), 'A10 V2 改字段 → 验签失败');
    ok(!pay.rsaVerify({ pid: '1', sign: 'AAAA' }, pubB64), 'A11 V2 乱签名 → 失败而不抛异常');

    // 商户订单号：网关只收字母数字
    const nos = [];
    for (let i = 0; i < 200; i++) nos.push(pay.newTradeNo('PP'));
    eq(new Set(nos).size, 200, 'A12 商户订单号 200 次不重复');
    ok(nos.every((n) => /^[A-Za-z0-9]+$/.test(n)), 'A13 ★ 商户订单号只含字母数字（带连字符会被网关拒单）');
    ok(nos.every((n) => n.indexOf('PP') === 0), 'A14 商户订单号带前缀，便于商户后台辨认');
    eq(pay.newTradeNo('P-P!x').indexOf('-'), -1, 'A15 前缀里的非法字符被清掉');

    eq(pay.cleanKeyMaterial('-----BEGIN PUBLIC KEY-----\nAA BB\n-----END PUBLIC KEY-----'), 'AABB', 'A16 PEM 提取正文并去空白');
    eq(pay.moneyStr(1042), '10.42', 'A17 金额按分转两位小数字符串');
    eq(pay.moneyStr(0), '0.00', 'A18 零元金额');

    // 加密盒子
    const blob = secretbox.encrypt(WORK, KEY);
    ok(blob.split('.').length === 3, 'A19 密文格式 iv.tag.ct');
    eq(secretbox.decrypt(WORK, blob), KEY, 'A20 加解密往返');
    const broken = blob.slice(0, -4) + 'AAAA';
    eq(secretbox.decrypt(WORK, broken), null, 'A21 ★ 密文被篡改 → 返回 null（GCM 认证标签生效）');
    eq(secretbox.decrypt(WORK, 'garbage'), null, 'A22 非法密文 → null 而不是抛异常');
    eq(secretbox.decrypt('C:/nonexistent-key-dir-xyz', blob), null, 'A23 主密钥不可用 → null');
    ok(secretbox.isEncryptedBlob(blob) && !secretbox.isEncryptedBlob('plain'), 'A24 密文识别');

    // 就绪判定
    const ready = (o) => pay.isReady(Object.assign(pay.newCfg(), { enabled: true, pid: '1', gateway: 'https://g', keyEnc: 'x' }, o));
    ok(ready({}), 'A25 材料齐 + 启用 → 就绪');
    ok(!ready({ enabled: false }), 'A26 未启用 → 不就绪');
    ok(!ready({ gateway: 'g' }), 'A27 网关地址缺协议 → 不就绪');
    ok(!pay.isReady(Object.assign(pay.newCfg(), { enabled: true, pid: '1', provider: 'mzf2', gateway: 'https://g' })),
      'A28 V2 缺密钥 → 不就绪（fail-safe，不做半残运行）');

    /* ================= B. 协议（假网关） ================= */

    const seen = { checkOrder: [], apiOrder: [], submit: [], query: [], merchant: [] };
    const gwKey = KEY;
    gw = http.createServer((rq, rs) => {
      const u = new URL(rq.url, 'http://x');
      const q = {};
      for (const [k, v] of u.searchParams.entries()) q[k] = v;
      const send = (obj, code) => { rs.writeHead(code || 200, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify(obj)); };
      if (u.pathname === '/Api/checkOrder') {
        seen.checkOrder.push(q);
        if (!pay.verifySign(q, gwKey)) return send({ code: 1, msg: '签名错误' });
        return send({ code: 0, data: { trade_no: 'GW001', out_trade_no: q.out_trade_no, status: 1, money: '0.01' } });
      }
      if (u.pathname === '/api.php') {
        seen.apiOrder.push(q);
        if (q.key !== gwKey) return send({ code: 0, msg: '密钥错误' });
        return send({ code: 1, status: 1, trade_no: 'GW002', out_trade_no: q.out_trade_no, money: '0.01' });
      }
      if (u.pathname === '/submit.php') {
        seen.submit.push(q);
        if (q.pid && q.sign && !pay.verifySign(q, gwKey)) {
          rs.writeHead(200, { 'Content-Type': 'text/html' }); return rs.end('<html>签名错误</html>');
        }
        rs.writeHead(200, { 'Content-Type': 'text/html' }); return rs.end('<html>收银台</html>');
      }
      if (u.pathname === '/api/pay/query' && rq.method === 'POST') {
        const cs = [];
        rq.on('data', (c) => cs.push(c));
        return rq.on('end', () => {
          const body = new URLSearchParams(Buffer.concat(cs).toString());
          const b = {};
          for (const [k, v] of body.entries()) b[k] = v;
          seen.query.push(b);
          if (!pay.rsaVerify(b, kp.publicKey)) return send({ code: 1, msg: '验签失败' });
          const rep = { code: 0, status: 1, trade_no: 'GW003', out_trade_no: b.out_trade_no };
          rep.sign = pay.rsaSign(rep, privB64);
          return send(rep);
        });
      }
      if (u.pathname === '/api/merchant/info' && rq.method === 'POST') {
        const cs = [];
        rq.on('data', (c) => cs.push(c));
        return rq.on('end', () => {
          const body = new URLSearchParams(Buffer.concat(cs).toString());
          const b = {};
          for (const [k, v] of body.entries()) b[k] = v;
          if (!pay.rsaVerify(b, kp.publicKey)) return send({ code: 1, msg: '验签失败' });
          const rep = { code: 0, pid: b.pid, status: 1, order_num_today: 7 };
          rep.sign = pay.rsaSign(rep, privB64);
          return send(rep);
        });
      }
      send({ code: 1, msg: 'not found' }, 404);
    });
    await new Promise((r) => gw.listen(0, '127.0.0.1', r));
    UPSTREAM_PORT = gw.address().port;
    const GW = 'http://127.0.0.1:' + UPSTREAM_PORT;

    const cfgV1 = Object.assign(pay.newCfg(), { enabled: true, provider: 'epay', gateway: GW, pid: '1001', key: KEY });
    const url1 = pay.createPayUrl(cfgV1, { outTradeNo: 'PPA1', amountCents: 1042, itemName: '充值' }, 'wxpay', 'https://site.example');
    ok(url1.indexOf(GW + '/submit.php?') === 0, 'B1 V1 下单跳 submit.php');
    const u1 = new URL(url1);
    eq(u1.searchParams.get('money'), '10.42', 'B2 金额字段两位小数');
    eq(u1.searchParams.get('notify_url'), 'https://site.example/api/pay/notify', 'B3 notify_url 用显式基地址拼装');
    eq(u1.searchParams.get('type'), 'wxpay', 'B4 渠道');
    eq(u1.searchParams.get('sign_type'), 'MD5', 'B5 V1 声明 MD5');

    const cfgOrder = Object.assign({}, cfgV1, { queryMode: 'checkOrder' });
    let qr = await pay.queryOrder(cfgOrder, 'PPA1');
    ok(qr.ok && qr.paid && qr.tradeNo === 'GW001', 'B6 ★ checkOrder 变体查单（code=0 为成功）', qr);
    ok(seen.checkOrder[0].sign && !seen.checkOrder[0].key, 'B7 checkOrder 变体不在参数里传密钥');
    qr = await pay.queryOrder(Object.assign({}, cfgV1, { queryMode: '' }), 'PPA1');
    ok(qr.ok && qr.paid, 'B8 标准易支付查单（code=1 为成功）', qr);

    let tc = await pay.testConnection(cfgV1);
    ok(tc.ok && tc.msg.indexOf('查单链路通过') >= 0, 'B9 连接自检（浅）通过', tc.msg);
    tc = await pay.testConnection(cfgV1, { deep: true });
    ok(tc.ok && tc.msg.indexOf('全链路通过') >= 0, 'B10 深度自检通过（探测 submit.php 下单）', tc.msg);
    ok(seen.submit.length > 0, 'B11 深度自检确实打了下单一（0.01 元测试单）');

    const cfgV2 = Object.assign(pay.newCfg(), { enabled: true, provider: 'mzf2', gateway: GW, pid: '2001', privateKey: privB64, platformKey: pubB64 });
    const url2 = pay.createPayUrl(cfgV2, { outTradeNo: 'PPB2', amountCents: 3000, itemName: '充值' }, 'alipay', 'https://site.example');
    ok(url2.indexOf(GW + '/api/pay/submit?') === 0, 'B12 V2 下单跳 api/pay/submit');
    ok(!!new URL(url2).searchParams.get('timestamp'), 'B13 V2 带 10 位时间戳');
    qr = await pay.queryOrder(cfgV2, 'PPB2');
    ok(qr.ok && qr.paid && qr.tradeNo === 'GW003', 'B14 ★ V2 查单（响应验签通过）', qr);
    const tc2 = await pay.testConnection(cfgV2);
    ok(tc2.ok && tc2.msg.indexOf('连接成功') >= 0, 'B15 V2 连接自检（商户信息接口）', tc2.msg);
    // 平台公钥不匹配时必须报错，而不是"连接成功"
    const tcBad = await pay.testConnection(Object.assign({}, cfgV2, { platformKey: pay.cleanKeyMaterial(
      crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' } }).publicKey) }));
    ok(!tcBad.ok && tcBad.msg.indexOf('平台公钥不匹配') >= 0, 'B16 ★ 平台公钥不匹配 → 自检失败（不误报成功）', tcBad.msg);

    /* ================= C. 集成（真服务端 + 假网关） ================= */

    mod = require(path.join(__dirname, '..', 'server', 'account-server.js'));
    const server = mod.server;
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const PORT = server.address().port;   // 回读实际端口（端口由系统分配）

    // 默认状态：未启用
    let r = await req(PORT, 'GET', '/api/health');
    eq(r.json.onlinePay, false, 'C1 health：默认未开通在线支付');
    eq(r.json.version, '1.7.0', 'C2 服务端版本 1.7.0');
    r = await req(PORT, 'GET', '/api/plans');
    eq(r.json.onlinePay.available, false, 'C3 /api/plans：未开通时 available=false');

    // 配置接口：未填网关时保存也要成功（允许先存草稿）
    r = await req(PORT, 'PUT', '/api/admin/payment', { enabled: true, provider: 'epay', gateway: GW, pid: '1001', key: KEY });
    eq(r.status, 200, 'C4 保存支付配置成功');
    eq(r.json.payment.hasKey, true, 'C5 只回显「有没有密钥」');
    eq(r.json.payment.key, undefined, 'C6 ★ 密钥明文绝不下发');
    eq(r.json.payment.ready, true, 'C7 材料齐 → ready');
    eq(r.json.notifyUrl, 'https://pp.test.example/api/pay/notify', 'C8 回显 notify_url（用 PP_PUBLIC_URL）');
    r = await req(PORT, 'GET', '/api/admin/payment');
    eq(r.json.payment.pid, '1001', 'C9 配置可回显（pid 属可回显字段）');
    eq(r.json.payment.onlineReady, true, 'C10 onlineReady=true（配置齐 + https 公网地址）');
    // 磁盘上必须是密文
    const payDoc = JSON.parse(fs.readFileSync(path.join(WORK, 'pay.json'), 'utf8'));
    ok(payDoc.keyEnc && payDoc.keyEnc !== KEY, 'C11 ★ 商户密钥以密文落盘');
    eq(secretbox.decrypt(WORK, payDoc.keyEnc), KEY, 'C12 密文可被本机主密钥解回');
    ok(!fs.readFileSync(path.join(WORK, 'pay.json'), 'utf8').includes(KEY), 'C13 ★ 明文密钥不出现在文件里');

    r = await req(PORT, 'POST', '/api/admin/payment/test', {});
    ok(r.json.ok && r.json.msg.indexOf('查单链路通过') >= 0, 'C14 后台连接自检可用', r.json.msg);

    let audit = (await req(PORT, 'GET', '/api/admin/audit?limit=50')).json;
    ok((audit.items || []).some((e) => e.action === 'pay.config'), 'C15 改支付配置写入审计');

    // 注册 + 下单（充值）
    await req(PORT, 'POST', '/api/auth/register', { email: 'pay@test.local', password: 'pw12345678' });
    const tok = (await req(PORT, 'POST', '/api/auth/login', { email: 'pay@test.local', password: 'pw12345678' })).json.token;
    const co = await req(PORT, 'POST', '/api/orders', { kind: 'credit', optionId: 'rc10' }, tok);
    eq(co.status, 200, 'C16 充值订单创建成功');
    const oid = co.json.order.id;
    const amountCents = Math.round(co.json.order.amount * 100);
    ok(co.json.order.outTradeNo === '', 'C17 未发起支付前没有商户订单号');

    // 发起在线支付
    r = await req(PORT, 'POST', '/api/orders/' + oid + '/pay', { channel: 'wxpay' }, tok);
    eq(r.status, 200, 'C18 发起在线支付成功');
    ok(String(r.json.payUrl).indexOf(GW + '/submit.php?') === 0, 'C19 返回收银台地址');
    const outTradeNo = r.json.order.outTradeNo;
    ok(/^[A-Za-z0-9]+$/.test(outTradeNo), 'C20 ★ 商户订单号纯字母数字', outTradeNo);
    eq(orderOnDisk(oid).outTradeNo, outTradeNo, 'C21 商户订单号已落库（回调按它反查）');
    eq(r.json.order.payChannel, 'wxpay', 'C22 记录支付渠道');
    // notify_url 必须指向公网地址
    const signParams = { pid: '1001', type: 'wxpay', out_trade_no: outTradeNo,
      notify_url: 'https://pp.test.example/api/pay/notify', return_url: 'https://pp.test.example/api/pay/return',
      name: 'x', money: (amountCents / 100).toFixed(2) };
    eq(new URL(r.json.payUrl).searchParams.get('out_trade_no'), outTradeNo, 'C23 收银台地址带商户订单号');

    /* ---- 五重校验：逐条拒绝 ---- */
    const notifyUrl = (q) => '/api/pay/notify?' + new URLSearchParams(q).toString();
    const baseNotify = () => ({ pid: '1001', trade_status: 'TRADE_SUCCESS', out_trade_no: outTradeNo,
      money: (amountCents / 100).toFixed(2), trade_no: 'GW-OK-1', type: 'wxpay' });

    let bad = baseNotify(); bad.sign = 'deadbeef';
    r = await req(PORT, 'GET', notifyUrl(bad));
    eq(r.text, 'fail', 'C24 ★ 坏签名 → fail');
    bad = baseNotify(); bad.sign = pay.buildSign(bad, KEY); bad.pid = '9999';
    r = await req(PORT, 'GET', notifyUrl(bad));
    eq(r.text, 'fail', 'C25 ★ 商户号不匹配 → fail');
    bad = baseNotify(); bad.trade_status = 'WAIT_BUYER_PAY';
    bad.sign = pay.buildSign(bad, KEY);
    r = await req(PORT, 'GET', notifyUrl(bad));
    eq(r.text, 'fail', 'C26 ★ 非 TRADE_SUCCESS → fail');
    bad = baseNotify(); bad.out_trade_no = 'NOSUCHORDER';
    bad.sign = pay.buildSign(bad, KEY);
    r = await req(PORT, 'GET', notifyUrl(bad));
    eq(r.text, 'fail', 'C27 ★ 订单不存在 → fail');
    bad = baseNotify(); bad.money = '0.01';                       // 少付
    bad.sign = pay.buildSign(bad, KEY);
    r = await req(PORT, 'GET', notifyUrl(bad));
    eq(r.text, 'fail', 'C28 ★ 少付（金额不符）→ fail');
    eq(orderOnDisk(oid).status, 'pending', 'C29 以上拒绝均未改动订单状态');
    // 拒绝原因不回显给调用方（响应体恒为 fail，不含细节）
    ok(r.text.length === 4, 'C30 ★ 拒绝时响应体只有 fail，不泄露原因');

    /* ---- 正确回调 → 履约入账 ---- */
    const good = baseNotify();
    good.sign = pay.buildSign(good, KEY);
    r = await req(PORT, 'GET', notifyUrl(good));
    eq(r.text, 'success', 'C31 ★ 合法回调 → success');
    const od = orderOnDisk(oid);
    eq(od.status, 'fulfilled', 'C32 订单已履约');
    eq(od.tradeNo, 'GW-OK-1', 'C33 记录网关交易号');
    ok(!!od.paidAt, 'C34 记录支付时间');
    let me = (await req(PORT, 'GET', '/api/auth/me', null, tok)).json.user;
    eq(me.balance.paidMicro, yuan(10), 'C35 ★ 按订单到账额度入账（¥10，与实付尾数无关）');
    const paidAfterFirst = me.balance.paidMicro;

    // 幂等：网关会重试
    r = await req(PORT, 'GET', notifyUrl(good));
    eq(r.text, 'success', 'C37 ★ 重复回调仍回 success（让网关停止重试）');
    me = (await req(PORT, 'GET', '/api/auth/me', null, tok)).json.user;
    eq(me.balance.paidMicro, paidAfterFirst, 'C38 ★ 重复回调不重复入账（幂等）');

    audit = (await req(PORT, 'GET', '/api/admin/audit?limit=50')).json;
    ok((audit.items || []).some((e) => e.action === 'order.pay'), 'C39 自动入账写入审计（order.pay）');

    /* ---- 已履约订单不可再发起支付 ---- */
    r = await req(PORT, 'POST', '/api/orders/' + oid + '/pay', { channel: 'alipay' }, tok);
    eq(r.status, 400, 'C40 已履约订单不能重复发起支付');

    /* ---- 主动查单兜底 ---- */
    const co2 = await req(PORT, 'POST', '/api/orders', { kind: 'credit', optionId: 'rc30' }, tok);
    const oid2 = co2.json.order.id;
    // 未发起支付 → 查单只给提示
    r = await req(PORT, 'POST', '/api/orders/' + oid2 + '/query', null, tok);
    eq(r.status, 200, 'C41 未发起支付的订单查单返回 200 + 提示');
    ok(String(r.json.hint || '').indexOf('未发起') >= 0, 'C42 提示说明未发起在线支付');
    r = await req(PORT, 'POST', '/api/orders/' + oid2 + '/pay', { channel: 'wxpay' }, tok);
    eq(r.status, 200, 'C43 发起第二笔在线支付');
    // 假网关此时返回「已支付」→ 查单应直接履约
    r = await req(PORT, 'POST', '/api/orders/' + oid2 + '/query', null, tok);
    eq(r.status, 200, 'C44 主动查单成功');
    eq(r.json.justPaid, true, 'C45 ★ 查单确认已支付 → 立即入账（回调丢包时的兜底）');
    eq(orderOnDisk(oid2).status, 'fulfilled', 'C46 第二笔订单已履约');
    me = (await req(PORT, 'GET', '/api/auth/me', null, tok)).json.user;
    eq(me.balance.paidMicro, paidAfterFirst + yuan(33), 'C47 第二笔按到账额度入账（¥30 到账 ¥33）');

    /* ---- 返回页与状态查询 ---- */
    r = await req(PORT, 'GET', '/api/pay/return?out_trade_no=' + outTradeNo);
    eq(r.status, 200, 'C48 同步返回页可访问');
    ok(r.text.indexOf('支付结果') >= 0, 'C49 返回页是 HTML');
    r = await req(PORT, 'GET', '/api/pay/return/status?out_trade_no=' + outTradeNo);
    eq(r.json.paid, true, 'C50 返回页轮询接口：已支付');
    eq(r.json.amountCents, undefined, 'C51 ★ 匿名查询不泄露金额等订单细节');
    r = await req(PORT, 'GET', '/api/pay/return/status?out_trade_no=NOSUCH');
    eq(r.json.paid, false, 'C52 查不到的商户订单号 → paid=false');

    /* ---- 关闭支付后行为不变 ---- */
    r = await req(PORT, 'PUT', '/api/admin/payment', { enabled: false });
    eq(r.status, 200, 'C53 关闭在线支付');
    r = await req(PORT, 'GET', '/api/plans');
    eq(r.json.onlinePay.available, false, 'C54 关闭后 available=false');
    const co3 = await req(PORT, 'POST', '/api/orders', { kind: 'credit', optionId: 'rc10' }, tok);
    eq(co3.status, 200, 'C55 ★ 关闭在线支付后，充值下单照常可用（走收款码 + 人工核销）');
    r = await req(PORT, 'POST', '/api/orders/' + co3.json.order.id + '/pay', { channel: 'wxpay' }, tok);
    eq(r.status, 503, 'C56 ★ 关闭后发起支付 → 503（客户端据此回落收款码）');
    r = await req(PORT, 'GET', notifyUrl(baseNotify()));
    eq(r.text, 'fail', 'C57 关闭后回调一律 fail（不验签就放行）');
    r = await req(PORT, 'POST', '/api/admin/payment/test', {});
    ok(r.json.ok, 'C58 ★ 关闭状态下**仍可**做连接自检（它就是启用前的预检工具，不该被 enabled 挡住）', r.json.msg);
    r = await req(PORT, 'GET', '/api/admin/payment');
    eq(r.json.payment.enabled, false, 'C59 自检不改变配置状态（只读）');

    /* ---- 密钥清除与坏密钥提示 ---- */
    r = await req(PORT, 'PUT', '/api/admin/payment', { enabled: true, provider: 'epay', gateway: GW, pid: '1001', key: KEY });
    eq(r.json.payment.ready, true, 'C60 重新配置密钥');
    r = await req(PORT, 'PUT', '/api/admin/payment', { privateKey: 'not-a-valid-key' });
    eq(r.status, 400, 'C61 ★ 无法解析的密钥被拒绝（保存前就报错）');
    r = await req(PORT, 'PUT', '/api/admin/payment', { key: '' });
    eq(r.json.payment.hasKey, false, 'C62 提交空密钥 → 清除');
    eq(r.json.payment.ready, false, 'C63 清除后不再 ready');
    r = await req(PORT, 'GET', '/api/health');
    eq(r.json.onlinePay, false, 'C64 health 同步反映不可用');
  } catch (e) {
    fails.push('异常中断：' + ((e && e.stack) || e));
  } finally {
    try { if (mod) mod.stopBackgroundJobs(); } catch (e) { /* ignore */ }
    try { if (mod) mod.server.close(); } catch (e) { /* ignore */ }
    try { if (gw) gw.close(); } catch (e) { /* ignore */ }
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  console.log('\n在线支付测试：' + pass + ' 项通过，' + fails.length + ' 项失败');
  if (fails.length) {
    for (const f of fails) console.log('  ✗ ' + f);
    process.exit(1);
  }
  console.log('  ✓ 全部通过');
})();
