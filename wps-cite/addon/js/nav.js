// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 引文导航：在文档里按位置跳「上一条 / 下一条」引文，或列出全部引文按序号跳
 *
 * 为什么单独一个文件：WPS 里域（field）只能靠 Fields 集合从头遍历，用户想核对第 37 条引文
 * 就得在几十页里手工找。这里把「域」变成可排序、可定位的列表，全部基于 Result.Start
 * 与光标 Selection.Range.Start —— 两者是同一个坐标系（文档字符偏移），可以直接比较大小。
 *
 * 依赖只有 root.PPDoc（doc.js）。不碰 wps.*，所以能在 Node 里用桩单测。
 */
(function (root) {
  "use strict";

  /**
   * 从域代码里抠出 CSL 的 JSON。
   * 域代码是「关键字 + JSON 混排」的 Word 方言（`ADDIN ZOTERO_ITEM CSL_CITATION {...}`），
   * 直接 JSON.parse 整串必失败，所以按花括号配对只取对象那一段。
   * 解析失败返回 null（不抛）——一条坏域不该让整个引文列表消失。
   */
  function cslJSON(code) {
    const s = String(code || "");
    const i = s.indexOf("{");
    if (i < 0) return null;
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      if (s[j] === "{") depth++;
      else if (s[j] === "}") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(s.slice(i, j + 1));
          } catch (e) {
            return null;
          }
        }
      }
    }
    return null;
  }

  /**
   * 从 citationItems[0].itemData 里挑出「给人看」的作者与年份。
   * 这几行只影响列表里的提示文字，任何一环缺失都退回空串：
   * **绝不允许因为元数据不规范而抛错**，否则一条域就能让导航整体不可用。
   */
  function peek(json) {
    const out = { authors: "", year: "" };
    try {
      const ci = json && json.citationItems && json.citationItems[0];
      const d = ci && ci.itemData;
      if (!d) return out;

      const creators = d.author || d.editor || d.contributor || [];
      const first = creators && creators[0];
      if (first) out.authors = String(first.family || first.literal || first.name || "");
      if (!out.authors && d.title) out.authors = String(d.title).slice(0, 20);

      const dp = d.issued && d.issued["date-parts"];
      if (dp && dp[0] && dp[0][0] != null) out.year = String(dp[0][0]);
      if (!out.year) {
        const raw = (d.issued && d.issued.raw) || d.date || "";
        const m = /(\d{4})/.exec(String(raw));
        if (m) out.year = m[1];
      }
    } catch (e) {
      /* 元数据不可信：取到多少算多少 */
    }
    return out;
  }

  /**
   * 纯函数：把 scanFields() 的结果整理成「可导航的引文列表」（按文档顺序）。
   * @param {Array<{index:number, code:string, start:number}>} fields
   * @param {(index:number)=>string} [getText] 取域结果区显示文本的回调；不传则 text 为空串
   * @returns {Array<{index:number,start:number,citationID:string,text:string,label:string,authors:string,year:string,n:number}>}
   */
  function parseCitations(fields, getText) {
    const out = [];
    const list = fields || [];
    for (let i = 0; i < list.length; i++) {
      const f = list[i] || {};
      const code = String(f.code || "");
      // 只留引文域。文献表域（CSL_BIBLIOGRAPHY）和 PAGE / REF 之类的普通域一律跳过，
      // 否则「下一条」会把用户带到参考文献列表里。
      if (code.indexOf("CSL_CITATION") < 0) continue;

      const index = Number(f.index);
      let text = "";
      if (typeof getText === "function") {
        try {
          text = String(getText(index) || "");
        } catch (e) {
          text = "";                 // 域的 Result 可能已被别的流程改掉，取不到就当空
        }
      }

      const json = cslJSON(code);    // 坏 JSON → null，本条目仍然保留
      const meta = peek(json);
      const label = text.replace(/\s+/g, " ").trim().slice(0, 12);

      out.push({
        index: index,
        start: Number(f.start) || 0,
        citationID: json && json.citationID ? String(json.citationID) : "",
        text: text,
        label: label,
        authors: meta.authors,
        year: meta.year,
        n: out.length + 1,
      });
    }
    return out;
  }

  function log(t, extra) {
    try {
      console.log("[PPNav] " + t + (extra ? " " + JSON.stringify(extra) : ""));
    } catch (e) { /* 没有 console 就算了 */ }
  }

  /**
   * 当前光标位置（文档字符偏移）。
   * 取不到时按 0（= 从文档开头算）处理**并记一条日志**：
   * 静默当成 0 会让「点下一条没反应」变成没法排查的玄学。
   */
  function cursor() {
    try {
      const pos = Number(root.PPDoc.app().Selection.Range.Start);
      if (!isNaN(pos)) return pos;
    } catch (e) { /* 落到下面记日志 */ }
    log("拿不到光标位置，按文档开头处理");
    return 0;
  }

  /** 域的显示文本；只用于 label 与列表，失败返回空串（导航本身不依赖它） */
  function fieldText(index) {
    try {
      const f = root.PPDoc.doc().Fields.Item(index);
      return String((f && f.Result && f.Result.Text) || "");
    } catch (e) {
      return "";
    }
  }

  function collect() {
    return parseCitations(root.PPDoc.scanFields(), fieldText);
  }

  /** 把光标落到某条引文上：先选中域结果区，再尽量滚进可视区 */
  function jump(c) {
    const r = root.PPDoc.doc().Fields.Item(c.index).Result;
    r.Select();
    try {
      // 整段包起来：某些 WPS 版本没有 ActiveWindow / ScrollIntoView，
      // 滚不动只是「看不到高亮」，选中已经成功，不该报错。
      root.PPDoc.app().ActiveWindow.ScrollIntoView(r, true);
    } catch (e) { /* 忽略 */ }
  }

  function hit(c, total, wrapped) {
    const o = { ok: true, n: c.n, label: c.label, total: total };
    if (wrapped) o.wrapped = true;
    return o;
  }

  /** 跳到当前光标之后的第 1 条引文；已经在最后一条就回到第一条（循环） */
  function next() {
    try {
      const all = collect();
      if (!all.length) return { ok: false, error: "本文档还没有引文" };
      const pos = cursor();
      // 严格 >：光标经常正落在当前引文的 Result 区间里（其 start 等于或小于光标），
      // 用 >= 会把这一条再选一次，用户看到的就是「点下一条没反应」。
      let target = null;
      for (let i = 0; i < all.length; i++) {
        if (all[i].start > pos) { target = all[i]; break; }
      }
      let wrapped = false;
      if (!target) { target = all[0]; wrapped = true; }
      jump(target);
      return hit(target, all.length, wrapped);
    } catch (e) {
      return { ok: false, error: "导航失败：" + ((e && e.message) || e) };
    }
  }

  /** 跳到当前光标之前的最后 1 条引文；已经在第一条就跳到最后一条（循环） */
  function prev() {
    try {
      const all = collect();
      if (!all.length) return { ok: false, error: "本文档还没有引文" };
      const pos = cursor();
      // 严格 <：理由同 next 的注释。反过来的话，光标停在某条引文内部时
      // 会一直选中这一条，永远退不回去。
      let target = null;
      for (let i = 0; i < all.length; i++) {
        if (all[i].start < pos) target = all[i];
      }
      let wrapped = false;
      if (!target) { target = all[all.length - 1]; wrapped = true; }
      jump(target);
      return hit(target, all.length, wrapped);
    } catch (e) {
      return { ok: false, error: "导航失败：" + ((e && e.message) || e) };
    }
  }

  /**
   * 列出全部引文，输入序号跳转。
   *
   * 为什么用 prompt 而不是新开任务窗格：
   *   ① 任务窗格（CreateTaskPane / ShowDialog）会抢焦点，抢完文档的 Selection 可能变 null 或跑位，
   *      而导航恰恰靠光标算位置，「打开列表 → 光标丢了 → 选错条目」是必然的；
   *   ② prompt 是同步模态框，关掉后光标还在原处，也不需要额外页面与授权；
   *   ③ 导航是「低头看一眼编号」的操作，朴素对话框够用。
   * 代价是样式没法美化——等 WPS 提供了不抢焦点的浮层再换。
   */
  function list() {
    try {
      const all = collect();
      if (!all.length) return { ok: false, error: "本文档还没有引文" };
      if (typeof prompt !== "function") {
        return { ok: false, error: "这个 WPS 版本没有可用的输入框，请用【上一条/下一条】" };
      }

      const lines = ["共 " + all.length + " 条引文："];
      for (let i = 0; i < all.length; i++) {
        const c = all[i];
        // 序号固定显示 c.n，后面能显示什么就显示什么（label 可能为空）
        const tail = [c.label, c.authors, c.year].filter(Boolean).join(" ");
        lines.push(c.n + ". " + (tail || "(无显示文本)"));
      }
      lines.push("");
      lines.push("输入序号跳转，直接确定取消");

      let raw;
      try {
        raw = prompt(lines.join("\n"));
      } catch (e) {
        // 有的 WPS 版本 prompt 存在但一调就抛，等价于「没有输入框」
        return { ok: false, error: "这个 WPS 版本没有可用的输入框，请用【上一条/下一条】" };
      }
      if (raw == null) return { ok: false, cancelled: true };

      const s = String(raw).trim();
      if (!s) return { ok: false, cancelled: true };
      const k = Number(s);
      // 非法或越界一律当「取消」：用户已经看到提示了，再弹一个错误框只是打扰
      if (!isFinite(k) || Math.floor(k) !== k || k < 1 || k > all.length) {
        return { ok: false, cancelled: true };
      }

      const target = all[k - 1];
      jump(target);
      return hit(target, all.length, false);
    } catch (e) {
      return { ok: false, error: "导航失败：" + ((e && e.message) || e) };
    }
  }

  const api = { next: next, prev: prev, list: list, __parse: parseCitations };
  root.PPNav = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
