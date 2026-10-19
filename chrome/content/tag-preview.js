// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 标签勾选对话框逻辑（modal，经 window.arguments 传参）
 * io = { tags: string[], detail?: [{tag, reason, confidence}],
 *        paperTitle: string, existing?: string[],
 *        threshold?: number, selected: string[]|null }
 * 兼容旧调用：只传 tags（纯字符串数组）时不显示依据/置信度，默认全选——
 * 旧调用方（若有）行为不变。
 *
 * ⚠️ 0.45.99 真机教训（compare.js 同款）：XUL 窗口的 <script src> 可能在
 * DOM 解析完成**之前**执行——此时 getElementById 全部返回 null，直接
 * appendChild 会抛异常，弹窗只剩空列表和死按钮（用户报「弹出框没有标签
 * 选项」）。必须等 DOMContentLoaded（或 readyState 已过 loading）再渲染。
 */
/* global window, document */

(function () {
  const io = window.arguments && window.arguments[0];
  if (!io) { window.close(); return; }

  function init() {
    const list = document.getElementById("pp-tag-list");
    const titleEl = document.getElementById("pp-tag-title");
    const existingEl = document.getElementById("pp-tag-existing");
    if (!list) {
      // DOM 就绪后仍找不到列表容器 = 文档结构异常：按「取消」语义收场，
      // 不让调用方拿到 undefined 卡住（selected 保持 null → runForSelected 视为已取消）
      try { console.error("[Papilot] tag-preview: pp-tag-list missing"); } catch (e) { /* ignore */ }
      io.selected = null;
      window.close();
      return;
    }
    if (titleEl) titleEl.setAttribute("value", io.paperTitle || "");

    const hasDetail = Array.isArray(io.detail) && io.detail.length > 0;
    const detail = hasDetail
      ? io.detail
      : (io.tags || []).map((t) => ({ tag: t, reason: "", confidence: 1 }));
    const threshold = typeof io.threshold === "number"
      ? Math.min(1, Math.max(0, io.threshold)) : 0.7;

    // 预选：有置信度时按阈值勾选；全不达标则至少预选置信度最高的一条（避免空勾选误导）
    let preselect;
    if (hasDetail) {
      preselect = detail.map((d) => (Number(d.confidence) || 0) >= threshold);
      if (!preselect.some(Boolean) && detail.length) {
        let best = 0;
        for (let i = 1; i < detail.length; i++) {
          if ((Number(detail[i].confidence) || 0) > (Number(detail[best].confidence) || 0)) best = i;
        }
        preselect[best] = true;
      }
    } else {
      preselect = detail.map(() => true); // 旧调用：全选（与历史行为一致）
    }

    const boxes = [];
    detail.forEach((d, i) => {
      const row = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
      row.style.cssText = "padding:3px 0;";

      const cb = document.createElementNS("http://www.w3.org/1999/xhtml", "input");
      cb.type = "checkbox";
      cb.checked = preselect[i];
      cb.id = "pp-t-" + i;
      row.appendChild(cb);

      const name = document.createElementNS("http://www.w3.org/1999/xhtml", "span");
      name.textContent = " " + d.tag;
      name.style.cssText = "cursor:pointer;";
      row.appendChild(name);

      if (hasDetail) {
        const conf = Math.round((Number(d.confidence) || 0) * 100);
        const badge = document.createElementNS("http://www.w3.org/1999/xhtml", "span");
        badge.textContent = "  " + conf + "%";
        badge.style.cssText = "font-size:11px;color:" +
          (conf >= 70 ? "#15803d" : conf >= 40 ? "#6b7280" : "#b45309") + ";";
        row.appendChild(badge);
        if (d.reason) {
          const why = document.createElementNS("http://www.w3.org/1999/xhtml", "span");
          why.textContent = "  · " + d.reason;
          why.style.cssText = "font-size:12px;color:#888;";
          row.appendChild(why);
        }
      }
      list.appendChild(row);
      boxes.push({ cb, tag: d.tag });
    });

    // 该条目已有、被从建议中排除的标签（透明度：告诉用户为什么没出现在列表里）
    if (existingEl) {
      const ex = Array.isArray(io.existing) ? io.existing.filter(Boolean) : [];
      existingEl.setAttribute("value",
        ex.length ? "该条目已有（已从建议中排除）：" + ex.join("、") : "");
    }

    document.getElementById("pp-tag-all").addEventListener("click", () => {
      for (const b of boxes) b.cb.checked = true;
    });
    document.getElementById("pp-tag-none").addEventListener("click", () => {
      for (const b of boxes) b.cb.checked = false;
    });
    document.getElementById("pp-tag-ok").addEventListener("click", () => {
      io.selected = boxes.filter(b => b.cb.checked).map(b => b.tag);
      window.close();
    });
    document.getElementById("pp-tag-cancel").addEventListener("click", () => {
      io.selected = null;
      window.close();
    });
  }

  // 时序守卫：脚本可能在 DOM 解析前执行（readyState=loading/uninitialized）→ 等
  // DOMContentLoaded；已就绪（或老平台无 readyState）→ 立即渲染。
  const rs = (typeof document !== "undefined" && document.readyState) || "complete";
  if (rs === "loading" || rs === "uninitialized") {
    window.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
