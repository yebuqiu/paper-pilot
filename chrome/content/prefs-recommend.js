// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 设置面板 · 「推荐配置」与「首次使用向导」入口（B3.3）
 *
 * 定位：向导负责「从零配好」（登录 / 通道 / 翻译），这里负责「把体验项一次改齐」。
 * 两者共用同一套纪律：
 *   · **只改与推荐值不一致的项**，并且先把清单摆给用户看（确认框），不做静默批量改；
 *   · 只写这张白名单里的键，别的一概不碰；
 *   · 全部是「关了也能用、开了更顺手」的项，不涉及密钥、不涉及计费。
 *
 * 运行环境：Zotero 设置窗口（脚本由 PreferencePanes.register 注入），
 * 因此顶层不碰 DOM，boot() 里探测节点后再绑。
 * 0.72.2 设计修复：反馈槽补 aria-live。
 */
/* global Zotero, Services, window, document */

(function () {
  'use strict';

  const PFX = 'extensions.zotero.papilot.';

  /** 推荐值表：[pref 键, 人话说明, 推荐值] */
  const RECOMMENDED = [
    ['readerPopupEnabled', '阅读器划词浮窗（选中文字即翻译/解读）', true],
    ['progressRowEnabled', '标题列阅读进度（装完即见，不用勾列）', true],
    ['citeLinksEnabled', 'AI 回答里的「文献 n」可点击定位', true],
    ['relatedPapersEnabled', '条目详情面板显示「相关文献」', true],
    ['autoTagUseVocab', 'AI 打标签优先复用库内已有标签', true],
    ['updateNoticeEnabled', '有新版本时提示（Zotero 自身更新是静默的）', true],
  ];

  const pGet = (k, d) => {
    try {
      const v = Zotero.Prefs.get(PFX + k, true);
      return (v === undefined || v === null) ? d : v;
    } catch (e) { return d; }
  };
  const pSet = (k, v) => { Zotero.Prefs.set(PFX + k, v, true); };

  /**
   * 纯逻辑：算出「当前值与推荐值不一致」的项。
   * @param {(k:string, d:any)=>any} get 读 pref（测试可注入）
   * @returns {{key:string,label:string,from:any,to:any}[]}
   */
  function plan(get) {
    const out = [];
    for (const [key, label, want] of RECOMMENDED) {
      const cur = get(key, want);
      if (cur !== want) out.push({ key, label, from: cur, to: want });
    }
    return out;
  }

  /** 纯逻辑：只写 plan 出来的那些键（返回实写列表） */
  function apply(set, items) {
    const wrote = [];
    for (const it of (items || [])) {
      try { set(it.key, it.to); wrote.push(it.key); } catch (e) { /* 单个失败不影响其它 */ }
    }
    return wrote;
  }

  /* ---------------- DOM 层 ---------------- */

  const $ = (id) => document.getElementById(id);

  function setMsg(text, kind) {
    const el = $('pp-recommend-msg');
    if (!el) return;
    el.setAttribute('aria-live', 'polite'); // 0.72.2：动态反馈对读屏可见
    el.textContent = text || '';
    el.className = 'pp-msg' + (kind ? ' pp-msg-' + kind : '');
  }

  function confirmText(items) {
    return '以下 ' + items.length + ' 项与推荐值不同，将被修改：\n\n'
      + items.map((it) => '· ' + it.label).join('\n')
      + '\n\n其余设置不受影响；改完可在这里逐项再调。';
  }

  function onRecommend() {
    const items = plan(pGet);
    if (!items.length) { setMsg('已是最佳配置，无需修改。', 'ok'); return; }
    let ok = true;
    try {
      const win = window;
      const flags = Services.prompt.BUTTON_POS_0 * Services.prompt.BUTTON_TITLE_IS_STRING
        + Services.prompt.BUTTON_POS_1 * Services.prompt.BUTTON_TITLE_CANCEL;
      ok = Services.prompt.confirmEx(win, '应用推荐配置', confirmText(items), flags,
        '全部改为推荐值', null, null, null, {}) === 0;
    } catch (e) {
      ok = false;   // 弹不出确认框就不动（保守拒绝，绝不静默改）
    }
    if (!ok) { setMsg('已取消，未修改任何设置。'); return; }
    const wrote = apply(pSet, items);
    setMsg('已应用 ' + wrote.length + ' 项推荐配置（' + wrote.join('、') + '）。', 'ok');
  }

  function onWizard() {
    try {
      const P = Zotero.Papilot;
      if (P && typeof P.openWizard === 'function') { P.openWizard(); return; }
      setMsg('向导入口未就绪（插件启动后可重试）。', 'warn');
    } catch (e) {
      setMsg((e && e.message) || '打不开向导', 'err');
    }
  }

  function boot() {
    if (typeof document === 'undefined' || !document.getElementById) return;
    const btn = $('pp-recommend');
    if (!btn) { window.setTimeout(boot, 300); return; }
    if (boot._done) return;
    boot._done = true;
    btn.addEventListener('click', onRecommend);
    const wiz = $('pp-wizard-open');
    if (wiz) wiz.addEventListener('click', onWizard);
  }

  try { window.PapilotRecommend = { RECOMMENDED, plan, apply, boot }; } catch (e) { /* ignore */ }
  boot();
  try { window.setTimeout(boot, 600); } catch (e) { /* ignore */ }
})();
