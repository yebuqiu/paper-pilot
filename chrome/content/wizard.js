// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot · 首次使用向导（B3.1）
 *
 * 契约：docs/parallel/wizard-spec.md（三步 / 跳过 / 幂等 / 写入白名单 / 降级）。
 * 本文件提供两件事：
 *   ① 纯逻辑 `applyOutcome(ctx)`——把「用户在三步里选了什么」落成 pref 与模块调用，
 *      不碰 DOM，可单测（test/wizard.test.js 直接调它）；
 *   ② DOM 层 boot()——渲染步骤、按钮、登录/测试连接。
 *
 * ★ 写入白名单（只有这三项 + 通过 Channels 模块间接写 aiChannels）：
 *     wizardDone / wizardDoneAt / translateCfg
 *   其余任何 pref 一律不碰：绝不覆盖用户已有的非默认设置。
 *
 * ★ 纪律一（0.68.3 踩坑）：窗口顶部 <script> 先于 DOM 执行 —— 顶层只定义函数，
 *   boot() 由 DOMContentLoaded 触发；顶层永不抛。
 *
 * ★ 纪律二（0.68.3 踩坑，本文件 0.68.2 及以前违反）：**插件用 openDialog 打开的
 *   chrome 窗口没有 `Zotero` 全局**，Zotero / Services 只能经 window.arguments[0]
 *   注入（skill-store / chat-window / vault / compare 全部如此）。旧代码裸用
 *   `Zotero.Prefs`，真机里每次调用都抛 ReferenceError，而错误又被各处 try 吞掉：
 *     · 所有 pref 读取返回默认值、写入全部失败 → `wizardDone` 永远为空
 *       → **每次启动都弹**（连已登录的老用户也照弹）
 *     · `Zotero.Papilot.account / .channels` 一律拿不到 → 登录按钮回
 *       「账号模块未就绪」、测试连接回「通道模块未就绪」→ 向导整体不可用
 *   下面统一解析一次，并对缺位做可见降级（不再静默）。
 */
/* global window, document */

(function () {
  'use strict';

  const ARGS = (typeof window !== "undefined" && window.arguments && window.arguments[0]) || {};
  const Z = ARGS.Zotero
    || (typeof Zotero !== "undefined" && Zotero ? Zotero : null)
    || (typeof window !== "undefined" && window.opener && window.opener.Zotero
      ? window.opener.Zotero : null)
    || null;
  const Services = ARGS.Services
    || (typeof window !== "undefined" && window.Services ? window.Services : null)
    || null;

  const PFX = 'extensions.zotero.papilot.';
  const WRITE_WHITELIST = ['wizardDone', 'wizardDoneAt', 'translateCfg'];
  const STEP_COUNT = 3;

  /** 诊断：优先写进插件启动日志，退化为 Zotero.debug（窗口作用域没有 console 可见性） */
  function diag(msg) {
    try {
      if (Z && Z.Papilot && Z.Papilot._diag) { Z.Papilot._diag("wizard: " + msg); return; }
      if (Z && Z.debug) Z.debug("Papilot wizard: " + msg);
    } catch (e) { /* 日志本身绝不抛 */ }
  }

  const pGet = (k, d) => {
    try {
      if (!Z || !Z.Prefs) return d;
      const v = Z.Prefs.get(PFX + k, true);
      return (v === undefined || v === null) ? d : v;
    } catch (e) { return d; }
  };
  const pSet = (k, v) => {
    // 这里刻意抛：applyOutcome 会把异常记进 failed，完成页据此如实列出「没写成」
    if (!Z || !Z.Prefs) throw new Error("插件作用域未就绪，设置无法保存");
    Z.Prefs.set(PFX + k, v, true);
  };
  const pp = () => (Z && Z.Papilot) || null;
  const mod = (name) => { const P = pp(); return (P && P[name]) || null; };

  /** 读 translateCfg（JSON），坏数据当空对象 */
  function readTranslateCfg(getRaw) {
    try {
      const raw = getRaw ? getRaw() : pGet('translateCfg', '');
      const doc = raw ? JSON.parse(raw) : null;
      return (doc && typeof doc === 'object') ? doc : {};
    } catch (e) { return {}; }
  }

  /**
   * 纯逻辑：根据选择产出写入计划并执行。
   * ctx = {
   *   mode: 'done' | 'skipped',
   *   channel: 'official' | 'custom' | 'skip',
   *   translate: 'ai' | 'free' | 'skip',
   *   custom: { baseUrl, apiKey },
   *   loggedIn: boolean,
   *   setPref(k, v)  — 写 pref（抛错表示失败）
   *   getPref(k)     — 读 pref（仅 translateCfg 用）
   *   channels       — Zotero.Papilot.channels（可缺省）
   * }
   * 返回 { wrote:[], calls:[], notes:[], failed:[] }
   */
  function applyOutcome(ctx) {
    const out = { wrote: [], calls: [], notes: [], failed: [] };
    const set = (k, v) => {
      try { ctx.setPref(k, v); out.wrote.push(k); } catch (e) { out.failed.push(k); }
    };
    const mode = ctx.mode === 'skipped' ? 'skipped' : 'done';

    set('wizardDone', mode);
    if (mode === 'done') set('wizardDoneAt', new Date().toISOString());

    if (mode !== 'done') return out;

    /* ---- 2. 通道 ---- */
    // 模块调用一律自包 try：channels 里任何一次抛错都不该让整份结果丢失
    // （旧实现会让 finish() 的 catch 把 wrote/failed 全清空，完成页显示「写入项（无）」）
    if (ctx.channel === 'official') {
      if (!ctx.loggedIn) {
        out.notes.push('未登录：官方通道暂不可用，保持原通道');
      } else if (ctx.channels) {
        let r = null;
        try { r = ctx.channels.setActive('official'); out.calls.push('setActive:official'); }
        catch (e) { out.notes.push('官方通道切换异常：' + ((e && e.message) || e)); }
        if (r && r.ok === false) out.notes.push(r.error || '官方通道切换失败');
      }
    } else if (ctx.channel === 'custom') {
      if (!ctx.custom || !ctx.custom.baseUrl) {
        // 选了「我自己的接口」却没填地址：不能静默跳过（用户会以为存下了）
        out.notes.push('自定义接口没填地址，未保存（可稍后在「AI 模型通道」里配）');
      } else if (!ctx.channels) {
        out.notes.push('通道模块未就绪，未保存自定义接口');
      } else {
        // 固定 id = 'wizard'：重复走向导是「更新同一条」，不会堆出一串通道
        let r = null;
        let threw = false;
        try {
          r = ctx.channels.upsert({
            id: 'wizard',
            name: '向导创建的通道',
            baseUrl: ctx.custom.baseUrl,
            apiKey: ctx.custom.apiKey || '',
            provider: 'openai',
          });
          out.calls.push('upsert:wizard');
        } catch (e) {
          threw = true;
          out.notes.push('自定义通道保存异常：' + ((e && e.message) || e));
        }
        if (r && r.ok) {
          let a = null;
          try { a = ctx.channels.setActive('wizard'); out.calls.push('setActive:wizard'); }
          catch (e) { out.notes.push('自定义通道切换异常：' + ((e && e.message) || e)); }
          if (a && a.ok === false) out.notes.push(a.error || '自定义通道切换失败');
        } else if (!threw) {
          out.notes.push((r && r.error) || '自定义通道保存失败');
        }
      }
    }

    /* ---- 3. 翻译引擎（只在「还是默认值」时才改） ---- */
    // 契约 §2 第 3 步：选了 AI 但第 2 步没有任何可用通道 → 自动回落到免费引擎并说明。
    // 旧实现只在「已经是别的引擎」时提示一句，选 AI 却不可用时会留下一个必然失败的配置。
    // 「可用」由调用方（finish）算好传进来：它知道当前生效通道是否要保留（channel=skip）。
    const channelUsable = (typeof ctx.channelUsable === 'boolean')
      ? ctx.channelUsable
      : ((ctx.channel === 'official' && ctx.loggedIn)
        || (ctx.channel === 'custom' && ctx.custom && ctx.custom.baseUrl));
    let translate = ctx.translate;
    if (translate === 'ai' && !channelUsable) {
      translate = 'free';
      out.notes.push('第 2 步没有可用通道，已自动改用免费翻译引擎');
    }

    if (translate === 'free') {
      const doc = readTranslateCfg(() => (ctx.getPref ? ctx.getPref('translateCfg') : pGet('translateCfg', '')));
      const active = doc.active || 'llm';
      if (active === 'llm') {
        doc.active = 'google';
        if (!Array.isArray(doc.fallback) || !doc.fallback.length) doc.fallback = ['bing', 'youdao'];
        set('translateCfg', JSON.stringify(doc));
      } else {
        out.notes.push('翻译引擎已被设为 ' + active + '，保持原值');
      }
    } else if (translate === 'ai') {
      const doc = readTranslateCfg(() => (ctx.getPref ? ctx.getPref('translateCfg') : pGet('translateCfg', '')));
      const active = doc.active || 'llm';
      if (active !== 'llm') out.notes.push('保留你已设置的翻译引擎：' + active);
    }

    return out;
  }

  /* ==================== DOM 层 ==================== */

  const $ = (id) => document.getElementById(id);
  const state = {
    step: 1,
    authMode: 'login',        // 'login' | 'register'（0.68.3：第一步必须能注册）
    channel: 'official',
    channelTouched: false,    // 用户是否真的点过通道卡片（没点 = 重开向导，保持现状）
    translate: 'ai',
    custom: { baseUrl: '', apiKey: '' },
    loggedIn: false,
  };

  // 窗口级错误钩子：窗口脚本静默死亡最难查（blank window），一律落进启动日志
  try {
    window.addEventListener('error', (ev) => {
      diag('error: ' + (ev && ev.message) + ' @'
        + String((ev && ev.filename) || '').split('/').pop() + ':' + (ev && ev.lineno));
    });
  } catch (e) { /* ignore */ }

  function setMsg(id, text, kind) {
    const el = $(id);
    if (!el) return;
    el.textContent = text || '';
    el.className = 'pp-msg' + (kind ? ' pp-msg-' + kind : '');
  }

  function render() {
    const done = state.step > STEP_COUNT;
    for (let i = 1; i <= STEP_COUNT; i++) {
      const panel = $('pp-wz-step-' + i);
      if (panel) panel.className = 'wz-panel' + (state.step === i ? ' wz-on' : '');
      const seg = document.querySelector('.wz-bar-seg[data-seg="' + i + '"]');
      if (seg) seg.className = 'wz-bar-seg' + (i <= state.step ? ' wz-on' : '');
    }
    const donePanel = $('pp-wz-step-done');
    if (donePanel) donePanel.className = 'wz-panel' + (done ? ' wz-on' : '');

    const num = $('pp-wz-stepnum');
    if (num) num.textContent = done ? '已完成' : ('第 ' + state.step + ' / ' + STEP_COUNT + ' 步');

    const back = $('pp-wz-back');
    const next = $('pp-wz-next');
    const close = $('pp-wz-close');
    const skip = $('pp-wz-skip');
    const settings = $('pp-wz-settings');
    if (back) back.style.display = (state.step > 1 && !done) ? '' : 'none';
    if (next) next.style.display = done ? 'none' : '';
    if (close) close.style.display = done ? '' : 'none';
    // 完成页还留着「稍后再说」= 用户读完总结顺手点它，会把 done 改写成 skipped（无意义但脏数据）
    if (skip) skip.style.display = done ? 'none' : '';
    // 契约 §2 完成页有「打开设置」：只写到「可随时在设置里改」却不给入口，等于让人自己去翻菜单
    if (settings) settings.style.display = done ? '' : 'none';

    const official = $('pp-wz-ch-official');
    const custom = $('pp-wz-ch-custom');
    if (official) official.className = 'wz-choice' + (state.channel === 'official' ? ' wz-on' : '');
    if (custom) custom.className = 'wz-choice' + (state.channel === 'custom' ? ' wz-on' : '');
    const form = $('pp-wz-ch-form');
    if (form) form.style.display = state.channel === 'custom' ? '' : 'none';

    const ai = $('pp-wz-tr-ai');
    const free = $('pp-wz-tr-free');
    if (ai) ai.className = 'wz-choice' + (state.translate === 'ai' ? ' wz-on' : '');
    if (free) free.className = 'wz-choice' + (state.translate === 'free' ? ' wz-on' : '');
  }

  function paintAccount() {
    const A = mod('account');
    state.loggedIn = !!(A && A.isLoggedIn && A.isLoggedIn());
    const on = $('pp-wz-acc-on');
    const off = $('pp-wz-acc-off');
    if (on) on.style.display = state.loggedIn ? '' : 'none';
    if (off) off.style.display = state.loggedIn ? 'none' : '';
    if (state.loggedIn) {
      const u = (A && A.user && A.user()) || {};
      const email = $('pp-wz-acc-email');
      if (email) email.textContent = u.email || '';
      const tier = $('pp-wz-acc-tier');
      // 服务端档位值是 'Free' / 'Pro'（大写）。旧代码比 'pro' 恒 false，
      // 于是专业版用户在这一步被写成「免费版」——与设置面板自相矛盾。
      let pro = false;
      try {
        pro = !!(A && A.isPro && A.isPro());
      } catch (e) { pro = false; }
      if (!A || typeof A.isPro !== 'function') {
        pro = String(u.plan || '').toLowerCase() === 'pro';
      }
      if (tier) tier.textContent = pro ? '专业版' : '免费版';
    }
    const official = $('pp-wz-ch-official');
    if (official) official.disabled = false;   // 未登录也可选，但应用时会提示
  }

  function paintCurrent() {
    const Ch = mod('channels');
    const st = $('pp-wz-ch-state');
    if (st) {
      let line = '当前活动通道：未知';
      let usable = false;
      try {
        // ★ getActiveConfig() 返回 {ok, channelId, model}；旧代码读的是 cfg.id（不存在），
        //   所以这一行永远显示「未知」。按真实字段 + getChannel 取名字。
        const cfg = Ch && Ch.getActiveConfig && Ch.getActiveConfig();
        usable = !!(cfg && cfg.ok);
        if (cfg && cfg.ok) {
          const ch = (Ch.getChannel && Ch.getChannel(cfg.channelId)) || {};
          const model = (cfg.model && cfg.model !== 'auto') ? '（' + cfg.model + '）' : '';
          line = '当前活动通道：' + (ch.name || cfg.channelId) + model;
        } else if (cfg && cfg.reason === 'not_logged_in') {
          line = '当前活动通道：官方通道（未登录，暂不可用）';
        } else if (cfg && cfg.reason === 'no_key') {
          line = '当前活动通道：缺少 API Key';
        } else if (cfg && cfg.reason === 'no_active') {
          line = '当前活动通道：尚未配置';
        }
      } catch (e) { /* ignore */ }
      // 重开向导时明确「不选就保持现状」：默认卡片停在官方通道，但用户现有配置不会被改
      const keepHint = (usable && !state.channelTouched) ? '（不改选择就保持不变）' : '';
      st.textContent = line + keepHint + ' · 换通道随时可在设置里改';
    }
    const tr = $('pp-wz-tr-state');
    if (tr) {
      const doc = readTranslateCfg();
      tr.textContent = '当前翻译引擎：' + (doc.active || 'llm') + '（默认 llm = AI 大模型）';
    }
  }

  /** 作用域缺失时的统一文案：区分「插件还没起来」与「窗口参数没传到」 */
  function moduleMissing(what) {
    return Z
      ? (what + '未就绪（插件可能仍在启动，请稍后重试）')
      : '窗口作用域异常：请在 Zotero 里重新打开向导';
  }

  /** 登录 / 注册视图切换（0.68.3）——第一步必须两条路都能走通 */
  function setAuthMode(mode) {
    state.authMode = mode === 'register' ? 'register' : 'login';
    const lv = $('pp-wz-login-view');
    const rv = $('pp-wz-reg-view');
    if (lv) lv.style.display = state.authMode === 'login' ? '' : 'none';
    if (rv) rv.style.display = state.authMode === 'register' ? '' : 'none';
    if (state.authMode === 'register') {
      setMsg('pp-wz-reg-msg', '');
      // 登录框里已经填了邮箱就带过来，省一次输入
      const src = $('pp-wz-email');
      const dst = $('pp-wz-reg-email');
      if (src && dst && !dst.value) dst.value = src.value || '';
      const f = $('pp-wz-reg-email');
      try { if (f && f.focus) f.focus(); } catch (e) { /* ignore */ }
    } else {
      setMsg('pp-wz-login-msg', '');
      const f = $('pp-wz-email');
      try { if (f && f.focus) f.focus(); } catch (e) { /* ignore */ }
    }
  }

  async function onLogin() {
    const A = mod('account');
    if (!A || typeof A.login !== 'function') {
      setMsg('pp-wz-login-msg', moduleMissing('账号模块'), 'err');
      diag('account module missing (Z=' + !!Z + ', loggedIn=' + state.loggedIn + ')');
      return;
    }
    const email = ($('pp-wz-email') || {}).value || '';
    const password = ($('pp-wz-password') || {}).value || '';
    if (!String(email).trim() || !String(password)) {
      setMsg('pp-wz-login-msg', '请填写邮箱和密码', 'warn');
      return;
    }
    const btn = $('pp-wz-login');
    if (btn) btn.disabled = true;
    setMsg('pp-wz-login-msg', '登录中…');
    try {
      await A.login(email, password);
      const pw = $('pp-wz-password');
      if (pw) pw.value = '';                 // 不在内存/界面上留密码
      paintAccount();
      // 表单已随登录成功隐藏，提示要写在账号块里（旧实现写在隐藏的登录框里，用户看不到）
      setMsg('pp-wz-acc-msg', '已登录', 'ok');
    } catch (e) {
      setMsg('pp-wz-login-msg', (e && e.message) || '登录失败', 'err');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /**
   * 注册（0.68.3）：与设置面板同源，直接调 `Account.register`（服务端 /api/auth/register）。
   * 三步校验与设置面板一致（邮箱格式 / 密码 ≥8 / 两次一致），避免两个入口两套标准。
   * 注册成功分两种：
   *   · 需要邮箱验证 → 不假装登录，回到登录视图并预填邮箱，提示去点验证链接；
   *   · 无需验证     → 立刻用刚填的密码登录，少一步操作。
   */
  async function onRegister() {
    const A = mod('account');
    if (!A || typeof A.register !== 'function') {
      setMsg('pp-wz-reg-msg', moduleMissing('账号模块'), 'err');
      diag('account.register missing (Z=' + !!Z + ')');
      return;
    }
    const email = String(($('pp-wz-reg-email') || {}).value || '').trim();
    const nickname = String(($('pp-wz-reg-nickname') || {}).value || '').trim();
    const pw = String(($('pp-wz-reg-password') || {}).value || '');
    const pw2 = String(($('pp-wz-reg-password2') || {}).value || '');
    if (!email || !pw) { setMsg('pp-wz-reg-msg', '请填写邮箱和密码', 'warn'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setMsg('pp-wz-reg-msg', '邮箱格式不正确', 'warn'); return; }
    if (pw.length < 8) { setMsg('pp-wz-reg-msg', '密码至少 8 位', 'warn'); return; }
    if (pw !== pw2) { setMsg('pp-wz-reg-msg', '两次输入的密码不一致', 'warn'); return; }

    const btn = $('pp-wz-reg');
    if (btn) btn.disabled = true;
    setMsg('pp-wz-reg-msg', '注册中…');
    try {
      const r = await A.register(email, pw, nickname);
      // 密码用完立刻从界面清掉
      const p1 = $('pp-wz-reg-password');
      if (p1) p1.value = '';
      const p2 = $('pp-wz-reg-password2');
      if (p2) p2.value = '';
      const notice = (r && r.notice) || '注册成功';

      if (r && r.needVerify) {
        // 账户还没激活，此时登录必失败：如实告知，并把邮箱带回登录框
        const le = $('pp-wz-email');
        if (le) le.value = email;
        setAuthMode('login');
        setMsg('pp-wz-login-msg', notice + '：请到邮箱点验证链接后再登录（含垃圾邮件箱）', 'ok');
        return;
      }

      // 无需验证 → 直接登录，让用户一步到位
      try {
        await A.login(email, pw);
        paintAccount();
        setMsg('pp-wz-acc-msg', '注册成功，已登录', 'ok');
      } catch (e) {
        const le = $('pp-wz-email');
        if (le) le.value = email;
        setAuthMode('login');
        setMsg('pp-wz-login-msg', '注册成功，请用刚才的密码登录', 'ok');
      }
    } catch (e) {
      setMsg('pp-wz-reg-msg', (e && e.message) || '注册失败', 'err');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function onTestChannel() {
    const Ch = mod('channels');
    const baseUrl = ($('pp-wz-baseurl') || {}).value || '';
    const apiKey = ($('pp-wz-apikey') || {}).value || '';
    state.custom = { baseUrl: String(baseUrl).trim(), apiKey: String(apiKey) };
    if (!state.custom.baseUrl) { setMsg('pp-wz-ch-msg', '请先填接口地址', 'warn'); return; }
    if (!Ch || !Ch.detectChannel) {
      setMsg('pp-wz-ch-msg', moduleMissing('通道模块'), 'err');
      diag('channels module missing (Z=' + !!Z + ')');
      return;
    }
    setMsg('pp-wz-ch-msg', '测试中…');
    try {
      const r = await Ch.detectChannel({ baseUrl: state.custom.baseUrl, apiKey: state.custom.apiKey });
      const n = (r && Array.isArray(r.models)) ? r.models.length : 0;
      setMsg('pp-wz-ch-msg', r && r.ok === false
        ? ('连接失败：' + (r.error || '未知原因') + '（仍可继续，稍后再配）')
        : ('连接成功' + (n ? '，可用模型 ' + n + ' 个' : '')), r && r.ok === false ? 'warn' : 'ok');
    } catch (e) {
      setMsg('pp-wz-ch-msg', '连接失败：' + ((e && e.message) || '网络异常') + '（仍可继续）', 'warn');
    }
  }

  function finish(mode) {
    // 用户可能填了接口地址就直接点「下一步」（没点「测试连接」）：落盘前再从界面同步一次，
    // 否则 state.custom 还是空的，通道与「AI 可用性」判断都会错。
    const bu = $('pp-wz-baseurl');
    const ak = $('pp-wz-apikey');
    if (bu || ak) {
      state.custom = {
        baseUrl: String((bu && bu.value) || '').trim(),
        apiKey: String((ak && ak.value) || ''),
      };
    }
    // ★ 「重开向导」不该动用户现有配置：用户没点过通道卡片（channelTouched=false）
    //   且当前通道本来就可用 → 保持现状，不调 setActive（旧实现会一路默认切回官方）。
    let currentUsable = false;
    try {
      const Ch = mod('channels');
      const cfg = Ch && Ch.getActiveConfig && Ch.getActiveConfig();
      currentUsable = !!(cfg && cfg.ok);
    } catch (e) { currentUsable = false; }
    const keepChannel = !state.channelTouched && currentUsable;

    const channelUsable = keepChannel
      || (state.channel === 'official' && state.loggedIn)
      || (state.channel === 'custom' && !!state.custom.baseUrl);

    const ctx = {
      mode: mode,
      channel: keepChannel ? 'skip' : state.channel,
      // 把「通道是否可用」的判定结果一并交给纯逻辑，避免两边各判一次判出分歧
      channelUsable: channelUsable,
      translate: state.translate,
      custom: state.custom,
      loggedIn: state.loggedIn,
      setPref: pSet,
      getPref: (k) => pGet(k, ''),
      channels: mod('channels'),
    };
    let out;
    try { out = applyOutcome(ctx); }
    catch (e) { out = { wrote: [], calls: [], notes: ['写入失败：' + ((e && e.message) || e)], failed: [] }; }
    diag(mode + ' wrote=[' + out.wrote.join(',') + '] failed=[' + out.failed.join(',') + ']'
      + ' notes=' + out.notes.length);

    if (mode === 'skipped') {
      // 「稍后再说」的写入失败必须让用户知道：否则下次启动照样弹，用户只会觉得甩不掉。
      if (out.failed.length) {
        try {
          if (Services && Services.prompt) {
            Services.prompt.alert(window, 'Papilot',
              '无法保存「稍后再说」状态（' + out.failed.join('、') + ' 写入失败），下次启动可能还会提示。');
          }
        } catch (e) { /* 提示失败不挡关窗 */ }
      }
      closeWindow();
      return;
    }

    // 完成页总结
    const sum = $('pp-wz-summary');
    if (sum) {
      while (sum.firstChild) sum.removeChild(sum.firstChild);
      // 通道/翻译都要如实：未登录却写「官方通道」、没通道却写「AI 大模型」，
      // 用户会以为已经配好了，直到第一次用才发现不通。
      const channelText = keepChannel
        ? '保持当前通道'
        : (state.channel === 'custom'
          ? (state.custom.baseUrl ? '已保存自定义接口' : '自定义接口没填地址（未保存）')
          : (state.loggedIn ? '官方通道' : '官方通道（未登录，暂不可用）'));
      const translateText = (state.translate === 'ai' && channelUsable)
        ? 'AI 大模型'
        : (state.translate === 'free' ? '免费引擎' : '免费引擎（自动回落）');
      const rows = [
        ['账号', state.loggedIn ? '已登录' : '未登录（可稍后）'],
        ['AI 通道', channelText],
        ['翻译引擎', translateText],
        ['写入项', out.wrote.join('、') || '（无）'],
      ];
      if (out.failed.length) rows.push(['未写入', out.failed.join('、')]);
      for (const [k, v] of rows) {
        const li = document.createElementNS('http://www.w3.org/1999/xhtml', 'li');
        const a = document.createElementNS('http://www.w3.org/1999/xhtml', 'span');
        a.setAttribute('class', 'wz-sum-k');
        a.textContent = k;
        const b = document.createElementNS('http://www.w3.org/1999/xhtml', 'span');
        b.setAttribute('class', 'wz-sum-v');
        b.textContent = v;
        li.appendChild(a); li.appendChild(b); sum.appendChild(li);
      }
    }
    const dm = $('pp-wz-done-msg');
    if (dm) {
      if (out.failed.length) {
        // 契约 §4：写入失败要如实列出未写入项（旧实现把 failed 吞了，界面显示「成功」）
        dm.className = 'pp-msg pp-msg-err';
        dm.textContent = '以下设置没能保存：' + out.failed.join('、')
          + '（其余已生效，可稍后在设置里重试）'
          + (out.notes.length ? '；' + out.notes.join('；') : '');
      } else {
        dm.className = 'pp-msg' + (out.notes.length ? ' pp-msg-warn' : '');
        dm.textContent = out.notes.length ? out.notes.join('；') : '随时可以在设置里调整。';
      }
    }
    state.step = STEP_COUNT + 1;
    render();
  }

  function closeWindow() {
    try { window.close(); } catch (e) { /* ignore */ }
  }

  function wire() {
    const on = (id, ev, fn) => {
      const el = $(id);
      if (el) el.addEventListener(ev, fn);
    };
    on('pp-wz-login', 'click', onLogin);
    on('pp-wz-reg-link', 'click', () => setAuthMode('register'));
    on('pp-wz-back-login', 'click', () => setAuthMode('login'));
    on('pp-wz-reg', 'click', onRegister);
    // 回车即提交（登录框：密码；注册框：任一字段）——窗口里没有 form，得手动接
    const enter = (ids, fn) => {
      for (const id of ids) {
        const el = $(id);
        if (el && el.addEventListener) {
          el.addEventListener('keydown', (e) => { if (e && e.key === 'Enter') fn(); });
        }
      }
    };
    enter(['pp-wz-email', 'pp-wz-password'], onLogin);
    enter(['pp-wz-reg-email', 'pp-wz-reg-nickname', 'pp-wz-reg-password', 'pp-wz-reg-password2'], onRegister);
    on('pp-wz-ch-test', 'click', onTestChannel);
    on('pp-wz-ch-official', 'click', () => {
      state.channel = 'official'; state.channelTouched = true; render(); paintCurrent();
    });
    on('pp-wz-ch-custom', 'click', () => {
      state.channel = 'custom'; state.channelTouched = true; render(); paintCurrent();
    });
    on('pp-wz-tr-ai', 'click', () => { state.translate = 'ai'; render(); });
    on('pp-wz-tr-free', 'click', () => { state.translate = 'free'; render(); });
    on('pp-wz-next', 'click', () => {
      if (state.step === 3) { finish('done'); return; }
      state.step = Math.min(STEP_COUNT, state.step + 1);
      render();
      paintCurrent();
    });
    on('pp-wz-back', 'click', () => {
      state.step = Math.max(1, state.step - 1);
      render();
    });
    on('pp-wz-skip', 'click', () => finish('skipped'));
    on('pp-wz-settings', 'click', () => {
      // 深链到「账号与会员」卡：用户刚配完账号/通道，最可能要继续调的就是这里
      try {
        const P = pp();
        if (P) P._prefsFocus = 'account';
        if (P && P.menus && P.menus.openSettings) { P.menus.openSettings(); return; }
        if (Z && Z.Utilities && Z.Utilities.Internal && Z.Utilities.Internal.openPreferences) {
          Z.Utilities.Internal.openPreferences();
          return;
        }
        diag('open settings unavailable');
      } catch (e) {
        diag('open settings failed: ' + (e && e.message));
      }
    });
    on('pp-wz-close', 'click', closeWindow);

    // Esc = 稍后再说（与「关窗」等价，但会记一笔 skipped，避免下次又弹）
    // 完成页例外：已经写过 done，按 Esc 只关窗，绝不把 done 改写成 skipped。
    try {
      window.addEventListener('keydown', (e) => {
        if (!e || e.key !== 'Escape') return;
        if (state.step > STEP_COUNT) { closeWindow(); return; }
        finish('skipped');
      });
    } catch (e) { /* ignore */ }
  }

  function boot() {
    if (typeof document === 'undefined' || !document.getElementById) return;
    if (!$('pp-wz-root')) { window.setTimeout(boot, 200); return; }
    if (boot._done) return;
    boot._done = true;
    // 作用域缺失时给一句可见提示（否则用户只看到「点什么都没反应」）
    if (!Z) {
      diag('Zotero scope missing in window (window.arguments[0] 未注入)');
      setMsg('pp-wz-login-msg', '窗口作用域异常：请在 Zotero 里重新打开向导', 'err');
      setMsg('pp-wz-ch-msg', '窗口作用域异常：请在 Zotero 里重新打开向导', 'err');
    }
    try { paintAccount(); } catch (e) { diag('paintAccount failed: ' + (e && e.message)); }
    try { paintCurrent(); } catch (e) { diag('paintCurrent failed: ' + (e && e.message)); }
    try { wire(); } catch (e) { diag('wire failed: ' + (e && e.message)); }
    try { render(); } catch (e) { diag('render failed: ' + (e && e.message)); }
    diag('boot done (loggedIn=' + state.loggedIn + ', scope=' + !!Z + ')');
  }

  // 关窗（含点右上角 X）= 「稍后再说」：否则下次启动又弹，用户会以为甩不掉。
  // finish('done') 已经写过 done，这里只在「还没写过」时补一笔 skipped。
  try {
    window.addEventListener('unload', () => {
      try {
        if (!pGet('wizardDone', '')) pSet('wizardDone', 'skipped');
      } catch (e) { /* 卸载期写失败不抛 */ }
    });
  } catch (e) { /* ignore */ }

  // 导出（单测直接调 applyOutcome；窗口内也可被 B3.2 复用）
  const API = {
    applyOutcome: applyOutcome,
    WRITE_WHITELIST: WRITE_WHITELIST,
    boot: boot,
    _state: state,
    // 排障用：真机里若再出现「点什么都没反应」，先看这两个值
    _scope: () => ({ hasZotero: !!Z, hasServices: !!Services, argsKeys: Object.keys(ARGS || {}) }),
  };
  try { window.PapilotWizard = API; } catch (e) { /* ignore */ }

  try {
    if (document.readyState === 'loading') {
      window.addEventListener('DOMContentLoaded', boot);
    } else {
      boot();
    }
  } catch (e) { /* 顶层永不抛：窗口空白比报错更难查 */ }
})();
