// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 多引擎同屏对比（C2，0.40.0）
 *
 * 为什么要有它：13 个翻译引擎质量/速度差异很大，用户选引擎只能靠「感觉」——
 * 想知道「同一段话 Google / Edge / DeepL 谁译得好、谁更快」得逐一切换引擎重译，
 * 既慢又无法同屏对照。本模块提供一个小窗口：一段文本 → 勾选多个引擎 →
 * **并行**请求 → 分栏同屏展示各引擎译文与耗时，失败引擎单独占位、不拖垮其他栏。
 *
 * 结构（沿用项目窗口纪律）：
 *   · 本文件 = 插件作用域那一半：并行编排（runAll，纯异步可单测）、默认勾选引擎
 *     （defaultEngines）、打开/复用窗口并注入回调载荷；
 *   · chrome/content/translate-compare.xhtml + translate-compare.js = 窗口那一半：
 *     只做 UI（勾选、分栏渲染），翻译一律经 payload.compare 回本模块 —— 窗口作用域
 *     访问不到 TranslateSvc（同 bilingual-translate.js 的载荷注入纪律）。
 *
 * 单引擎隔离：每个引擎显式 TranslateSvc.translate(text, {engine}) —— 显式指定引擎
 * 时翻译层本身不走回退链（见 translate.js _candidates），单引擎失败只影响自己那一栏。
 */
/* global Zotero, Services, TranslateSvc, I18n */

var TranslateCompare = {
  WINDOW_TYPE: "papilot:translate-compare",
  WINDOW_URL: "chrome://papilot/content/translate-compare.xhtml",
  WINDOW_NAME: "papilot-translate-compare",

  _win: null,

  /* ---------------- 纯编排（可单测，不碰 Zotero） ---------------- */

  /**
   * 并行跑一批翻译任务，失败隔离、按输入顺序聚合。
   * @param {Array<{engine:string, name:string, run:function():Promise<string>}>} tasks
   * @returns {Promise<Array<{engine,name,ok,text,error,ms}>>} 顺序与 tasks 一致；
   *   单任务失败 → 该条 ok=false + error，其他条不受影响；永不整体 reject。
   */
  async runAll(tasks) {
    const list = Array.isArray(tasks) ? tasks : [];
    const one = async (t) => {
      const t0 = Date.now();
      try {
        const text = await t.run();
        return { engine: t.engine, name: t.name || t.engine, ok: true,
          text: String(text == null ? "" : text), error: "", ms: Date.now() - t0 };
      } catch (e) {
        return { engine: t.engine, name: t.name || t.engine, ok: false,
          text: "", error: String((e && e.message) || e), ms: Date.now() - t0 };
      }
    };
    // 同时起跑（真并行）：map 出全部 Promise 再统一 await
    return await Promise.all(list.map(one));
  },

  /**
   * 默认勾选的引擎（当前实际可用者优先）：活动引擎 + 回退链里 ready 的，去重取前 n 个。
   * 一个都不 ready 时退为活动引擎本身（窗口里会如实显示它的失败原因，不静默）。
   * @param {number} [n] 默认 3
   * @returns {string[]} 引擎 id 列表
   */
  defaultEngines(n) {
    const max = Math.max(1, Number(n) || 3);
    const c = TranslateSvc.cfg();
    const seq = [c.active].concat(Array.isArray(c.fallback) ? c.fallback : []);
    const seen = new Set();
    const out = [];
    for (const id of seq) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      let ready = false;
      try { ready = TranslateSvc.ready(id); } catch (e) { ready = false; }
      if (ready) out.push(id);
      if (out.length >= max) break;
    }
    if (!out.length && c.active) out.push(c.active);
    return out;
  },

  /* ---------------- 对比执行（窗口回调） ---------------- */

  /**
   * 对一段文本并行跑指定引擎（窗口「开始对比」按钮的唯一入口）。
   * @param {string[]} ids 引擎 id
   * @param {string} text 原文
   * @returns {Promise<Array>} runAll 结果（顺序与 ids 一致）
   */
  async compare(ids, text) {
    const clean = String(text == null ? "" : text).trim();
    if (!clean) return [];
    const tasks = (Array.isArray(ids) ? ids : []).filter((id) => TranslateSvc.get(id))
      .map((id) => {
        const svc = TranslateSvc.get(id);
        return {
          engine: id,
          name: svc ? svc.name : id,
          run: async () => {
            // 显式 engine：不走回退链 —— 要的就是「这个引擎自己」的真实表现
            const r = await TranslateSvc.translate(clean, { engine: id });
            if (!r.ok) throw new Error(r.error || "翻译失败");
            return r.text;
          },
        };
      });
    return await this.runAll(tasks);
  },

  /* ---------------- 窗口 ---------------- */

  _payload(text) {
    return {
      Zotero,
      Services,
      isZh: !!I18n.isZh,
      text: String(text == null ? "" : text),
      targetLabel: (() => {
        try { return TranslateSvc.langLabel(TranslateSvc.targetCode()); } catch (e) { return ""; }
      })(),
      engines: TranslateSvc.list().map((s) => ({
        id: s.id,
        name: s.name,
        ready: (() => { try { return TranslateSvc.ready(s.id); } catch (e) { return false; } })(),
        llm: !!s.llm,
      })),
      checked: this.defaultEngines(3),
      compare: (ids, txt) => this.compare(ids, txt),
    };
  },

  /** 打开（或复用）对比小窗；text 可由调用方预填（如翻译面板的待译框） */
  openWindow(text) {
    const payload = this._payload(text);
    // 单实例：已开则聚焦并换文本（窗口侧 ppTCLoad 重渲染）
    try {
      const en = Services.wm.getEnumerator(this.WINDOW_TYPE);
      if (en.hasMoreElements()) {
        const win = en.getNext();
        this._win = win;
        try { win.focus(); } catch (e) { /* ignore */ }
        try {
          if (typeof win.ppTCLoad === "function") win.ppTCLoad(payload);
        } catch (e) { /* ignore */ }
        return win;
      }
    } catch (e) { /* ignore */ }

    const win = Zotero.getMainWindow();
    if (!win) return null;
    try {
      const w = win.openDialog(
        this.WINDOW_URL,
        this.WINDOW_NAME,
        "chrome,extracz,resizable,dialog=no,centerscreen",
        payload
      );
      this._win = w;
      return w;
    } catch (e) {
      Zotero.logError(new Error("Papilot: 打开多引擎对比窗口失败"));
      Zotero.logError(e);
      return null;
    }
  },
};
