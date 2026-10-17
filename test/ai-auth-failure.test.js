/* 官方通道 401 判别测试（1.8.x 修复）：
 * 客户端只有收到网关自身的「登录已过期」401 才清除本地会话；
 * 上游通道 401（旧服务端原样透传：密钥失效/模型未授权）绝不清会话——
 * 否则「切换模型后上游 401」会表现为整个插件掉登录、无法使用。
 * 运行：node test/ai-auth-failure.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
}

/** 装配 AIClient 的 VM 沙箱；authCalls 记录 handleAuthFailure 调用次数 */
function loadClient({ status, respBody, channelId }) {
  const authCalls = [];
  const sandbox = {
    console, setTimeout, clearTimeout, JSON, Math, Number, String, Object, Array,
    Prefs: { get: (k, d) => d },
    Channels: {
      getActiveConfig: () => ({
        ok: true, channelId: channelId || 'official',
        baseUrl: 'http://gw.test/v1', apiKey: 'tok', model: 'auto', extraBody: {},
      }),
    },
    Account: {
      touchSession() {},
      handleAuthFailure: (msg) => { authCalls.push(msg); return Promise.resolve(); },
    },
    Zotero: {
      HTTP: {
        request: async () => {
          const e = new Error('HTTP ' + status);
          e.xmlhttp = {
            status,
            response: respBody,                 // responseType:json → 已解析对象
            responseText: typeof respBody === 'string' ? respBody : JSON.stringify(respBody),
          };
          throw e;
        },
      },
    },
  };
  vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(__dirname, '..', 'chrome', 'content', 'scripts', 'ai', 'client.js'), 'utf8');
  vm.runInContext(src + '\n;this.AIClient = AIClient;', sandbox);
  return { AIClient: sandbox.AIClient, authCalls };
}

(async () => {
  /* ---------- A. 网关自身 401「登录已过期」→ 清会话 ---------- */
  {
    const { AIClient, authCalls } = loadClient({
      status: 401, respBody: { ok: false, error: '登录已过期' },
    });
    let err = null;
    try { await AIClient.chat([{ role: 'user', content: 'hi' }]); } catch (e) { err = e; }
    ok(!!err, 'A1 调用抛出错误');
    ok(/401/.test(String(err && err.message)), 'A2 错误文案含 401', err && err.message);
    ok(authCalls.length === 1, 'A3 ★ 网关「登录已过期」→ 会话失效一次', authCalls.length);
  }

  /* ---------- B. 上游 401 透传（旧服务端行为）→ 不清会话 ---------- */
  {
    const { AIClient, authCalls } = loadClient({
      status: 401, respBody: { error: { type: 'prism_local_error', message: 'Invalid Prism Local API key' } },
    });
    let err = null;
    try { await AIClient.chat([{ role: 'user', content: 'hi' }]); } catch (e) { err = e; }
    ok(!!err, 'B1 调用抛出错误');
    ok(authCalls.length === 0, 'B2 ★ 上游 401（透传）不清会话', authCalls.length);
  }

  /* ---------- C. 应答体不可读（字符串且无关键字）→ 不清会话 ---------- */
  {
    const { AIClient, authCalls } = loadClient({ status: 401, respBody: 'Unauthorized' });
    try { await AIClient.chat([{ role: 'user', content: 'hi' }]); } catch (e) { /* ignore */ }
    ok(authCalls.length === 0, 'C1 WAF/反代式 401 不清会话', authCalls.length);
  }

  /* ---------- D. 非 401（403/500）→ 不清会话 ---------- */
  for (const st of [403, 500]) {
    const { AIClient, authCalls } = loadClient({ status: st, respBody: { ok: false, error: 'x' } });
    try { await AIClient.chat([{ role: 'user', content: 'hi' }]); } catch (e) { /* ignore */ }
    ok(authCalls.length === 0, 'D' + st + ' 非 401 不清会话', authCalls.length);
  }

  /* ---------- E. 非官方通道 401 → 不触碰账号会话 ---------- */
  {
    const { AIClient, authCalls } = loadClient({
      status: 401, respBody: { ok: false, error: '登录已过期' }, channelId: 'my-key',
    });
    try { await AIClient.chat([{ role: 'user', content: 'hi' }]); } catch (e) { /* ignore */ }
    ok(authCalls.length === 0, 'E1 自定义通道 401 与账号会话无关', authCalls.length);
  }

  console.log('\n官方通道 401 判别测试：' + pass + ' 项通过，' + fails.length + ' 项失败');
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
