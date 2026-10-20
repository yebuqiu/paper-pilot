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
 * ★ 纪律：窗口顶部 <script> 先于 DOM 执行 —— 顶层只定义函数，boot() 由 DOMContentLoaded 触发。
 */
/* global Zotero, window, document */

(function () {
  'use strict';

  const PFX = 'extensions.zotero.papilot.';
  const WRITE_WHITELIST = ['wizardDone', 'wizardDoneAt', 'translateCfg'];
  const STEP_COUNT = 3;

  const pGet = (k, d) => {
    try {
      const v = Zotero.Prefs.get(PFX + k, true);
      return (v === undefined || v === null) ? d : v;
    } catch (e) { return d; }
  };
  const pSet = (k, v) => { Zotero.Prefs.set(PFX + k, v, true); };
  const pp = () => (typeof Zotero !== 'undefined' && Zotero.Papilot) || null;
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
    if (ctx.channel === 'official') {
      if (!ctx.loggedIn) {
        out.notes.push('未登录：官方通道暂不可用，保持原通道');
      } else if (ctx.channels) {
        const r = ctx.channels.setActive('official');
        out.calls.push('setActive:official');
        if (r && r.ok === false) out.notes.push(r.error || '官方通道切换失败');
      }
    } else if (ctx.channel === 'custom' && ctx.custom && ctx.custom.baseUrl) {
      if (!ctx.channels) {
        out.notes.push('通道模块未就绪，未保存自定义接口');
      } else {
        // 固定 id = 'wizard'：重复走向导是「更新同一条」，不会堆出一串通道
        const r = ctx.channels.upsert({
          id: 'wizard',
          name: '向导创建的通道',
          baseUrl: ctx.custom.baseUrl,
          apiKey: ctx.custom.apiKey || '',
          provider: 'openai',
        });
        out.calls.push('upsert:wizard');
        if (r && r.ok) {
          const a = ctx.channels.setActive('wizard');
          out.calls.push('setActive:wizard');
          if (a && a.ok === false) out.notes.push(a.error || '自定义通道切换失败');
        } else {
          out.notes.push((r && r.error) || '自定义通道保存失败');
        }
      }
    }

    /* ---- 3. 翻译引擎（只在「还是默认值」时才改） ---- */
    if (ctx.translate === 'free') {
      const doc = readTranslateCfg(() => (ctx.getPref ? ctx.getPref('translateCfg') : pGet('translateCfg', '')));
      const active = doc.active || 'llm';
      if (active === 'llm') {
        doc.active = 'google';
        if (!Array.isArray(doc.fallback) || !doc.fallback.length) doc.fallback = ['bing', 'youdao'];
        set('translateCfg', JSON.stringify(doc));
      } else {
        out.notes.push('翻译引擎已被设为 ' + active + '，保持原值');
      }
    } else if (ctx.translate === 'ai') {
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
    channel: 'official',
    translate: 'ai',
    custom: { baseUrl: '', apiKey: '' },
    loggedIn: false,
  };

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
    if (back) back.style.display = (state.step > 1 && !done) ? '' : 'none';
    if (next) next.style.display = done ? 'none' : '';
    if (close) close.style.display = done ? '' : 'none';

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
      const u = (A.user && A.user()) || {};
      const email = $('pp-wz-acc-email');
      if (email) email.textContent = u.email || '';
      const tier = $('pp-wz-acc-tier');
      if (tier) tier.textContent = u.plan === 'pro' ? '专业版' : '免费版';
    }
    const official = $('pp-wz-ch-official');
    if (official) official.disabled = false;   // 未登录也可选，但应用时会提示
  }

  function paintCurrent() {
    const Ch = mod('channels');
    const st = $('pp-wz-ch-state');
    if (st) {
      let line = '当前活动通道：未知';
      try {
        const cfg = Ch && Ch.getActiveConfig && Ch.getActiveConfig();
        if (cfg && cfg.id) line = '当前活动通道：' + (cfg.name || cfg.id) + (cfg.model ? '（' + cfg.model + '）' : '');
      } catch (e) { /* ignore */ }
      st.textContent = line + ' · 换通道随时可在设置里改';
    }
    const tr = $('pp-wz-tr-state');
    if (tr) {
      const doc = readTranslateCfg();
      tr.textContent = '当前翻译引擎：' + (doc.active || 'llm') + '（默认 llm = AI 大模型）';
    }
  }

  async function onLogin() {
    const A = mod('account');
    if (!A || !A.login) { setMsg('pp-wz-login-msg', '账号模块未就绪', 'err'); return; }
    const email = ($('pp-wz-email') || {}).value || '';
    const password = ($('pp-wz-password') || {}).value || '';
    setMsg('pp-wz-login-msg', '登录中…');
    try {
      await A.login(email, password);
      const pw = $('pp-wz-password');
      if (pw) pw.value = '';                 // 不在内存/界面上留密码
      paintAccount();
      setMsg('pp-wz-login-msg', '已登录', 'ok');
    } catch (e) {
      setMsg('pp-wz-login-msg', (e && e.message) || '登录失败', 'err');
    }
  }

  async function onTestChannel() {
    const Ch = mod('channels');
    const baseUrl = ($('pp-wz-baseurl') || {}).value || '';
    const apiKey = ($('pp-wz-apikey') || {}).value || '';
    state.custom = { baseUrl: String(baseUrl).trim(), apiKey: String(apiKey) };
    if (!state.custom.baseUrl) { setMsg('pp-wz-ch-msg', '请先填接口地址', 'warn'); return; }
    if (!Ch || !Ch.detectChannel) { setMsg('pp-wz-ch-msg', '通道模块未就绪', 'err'); return; }
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
    const ctx = {
      mode: mode,
      channel: state.channel,
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

    if (mode === 'skipped') { closeWindow(); return; }

    // 完成页总结
    const sum = $('pp-wz-summary');
    if (sum) {
      while (sum.firstChild) sum.removeChild(sum.firstChild);
      const rows = [
        ['账号', state.loggedIn ? '已登录' : '未登录（可稍后）'],
        ['AI 通道', state.channel === 'custom' ? '已保存自定义接口' : '官方通道'],
        ['翻译引擎', state.translate === 'free' ? '免费引擎' : 'AI 大模型'],
        ['写入项', out.wrote.join('、') || '（无）'],
      ];
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
      dm.className = 'pp-msg' + (out.notes.length ? ' pp-msg-warn' : '');
      dm.textContent = out.notes.length ? out.notes.join('；') : '随时可以在设置里调整。';
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
    on('pp-wz-ch-test', 'click', onTestChannel);
    on('pp-wz-ch-official', 'click', () => { state.channel = 'official'; render(); });
    on('pp-wz-ch-custom', 'click', () => { state.channel = 'custom'; render(); });
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
    on('pp-wz-close', 'click', closeWindow);

    // Esc = 稍后再说（与「关窗」等价，但会记一笔 skipped，避免下次又弹）
    try {
      window.addEventListener('keydown', (e) => {
        if (e && e.key === 'Escape') finish('skipped');
      });
    } catch (e) { /* ignore */ }
  }

  function boot() {
    if (typeof document === 'undefined' || !document.getElementById) return;
    if (!$('pp-wz-root')) { window.setTimeout(boot, 200); return; }
    if (boot._done) return;
    boot._done = true;
    paintAccount();
    paintCurrent();
    wire();
    render();
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
