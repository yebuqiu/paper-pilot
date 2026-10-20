// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 参考文献导出 · 窗口脚本（0.61.0）
 *
 * 运行在独立 chrome 窗口作用域：拿不到 bootstrap 作用域，也不直接读 Zotero。
 * 一切数据与动作经 window.arguments[0].api 注入 —— 与 ref-import 同纪律，
 * 好处是这个窗口可以脱离 Zotero 做迷你 DOM 测试。
 *
 * ★ 启动顺序：<script> 在 DOM 之前执行，所以必须等 DOMContentLoaded 再绑事件
 *   （见 0.47.0 分屏窗口的教训：脚本先跑 → getElementById 全是 null → 界面看似正常但按钮全死）。
 */
/* global window, document */

(function () {
  const arg = (window.arguments && window.arguments[0]) || {};
  const api = arg.api || {};
  const payload = arg.payload || {};
  const zh = (() => { try { return api.isZh ? !!api.isZh() : true; } catch (e) { return true; } })();

  const $ = (id) => document.getElementById(id);

  function text(key, cn, en) { return zh ? cn : en; }

  function readOptions() {
    const numeric = $("ce-style-numeric");
    const style = numeric && numeric.selected ? "numeric" : "authorDate";
    const tc = $("ce-typecode");
    const doi = $("ce-doi");
    const max = $("ce-max");
    return {
      style,
      typeCode: tc ? !!tc.checked : true,
      doi: doi ? !!doi.checked : true,
      maxAuthors: Number((max && max.value) || 3) || 3,
      accessDate: new Date().toISOString().slice(0, 10),
      numbered: style === "numeric",
    };
  }

  let current = "";

  function refresh() {
    const opts = readOptions();
    try {
      current = String(api.preview ? api.preview(opts) : "");
    } catch (e) {
      current = "";
    }
    const out = $("ce-out");
    if (out) out.value = current;
    try { if (api.saveOptions) api.saveOptions(opts); } catch (e) { /* ignore */ }
    setStatus(text("count", "共 " + (payload.count || 0) + " 条", (payload.count || 0) + " item(s)"));
  }

  function setStatus(s, isError) {
    const el = $("ce-status");
    if (!el) return;
    el.textContent = String(s || "");
    el.style.color = isError ? "#b42318" : "#1a7f37";
  }

  function applyOptions(o) {
    if (!o) return;
    const numeric = $("ce-style-numeric");
    const ad = $("ce-style-authordate");
    if (numeric && ad) {
      numeric.selected = o.style !== "authorDate";
      ad.selected = o.style === "authorDate";
    }
    const tc = $("ce-typecode");
    if (tc) tc.checked = o.typeCode !== false;
    const doi = $("ce-doi");
    if (doi) doi.checked = o.doi !== false;
    const max = $("ce-max");
    if (max) max.value = String(o.maxAuthors || 3);
  }

  function boot() {
    if (!$("ce-out")) return;

    // 界面文案（标题由窗口 title 决定，这里只补可切换的部分）
    const head = $("ce-head");
    if (head) {
      head.textContent = text("head",
        "已选条目将按 GB/T 7714-2015 生成，可直接粘贴进 Word。",
        "Selected items will be formatted per GB/T 7714-2015 and can be pasted into Word.");
    }
    const copy = $("ce-copy");
    const save = $("ce-save");
    const close = $("ce-close");
    const maxLabel = $("ce-max-label");
    if (copy) copy.textContent = text("copy", "复制", "Copy");
    if (save) save.textContent = text("save", "另存为 .txt", "Save as .txt");
    if (close) close.textContent = text("close", "关闭", "Close");
    if (maxLabel) maxLabel.setAttribute("value", text("maxAuthors", "作者上限", "Max authors"));

    try { applyOptions(api.loadOptions ? api.loadOptions() : null); } catch (e) { /* ignore */ }
    refresh();

    const onOpt = () => refresh();
    for (const id of ["ce-style-numeric", "ce-style-authordate", "ce-typecode", "ce-doi", "ce-max"]) {
      const el = $(id);
      if (!el) continue;
      el.addEventListener("command", onOpt);
      el.addEventListener("change", onOpt);
      el.addEventListener("click", onOpt);
    }

    if (copy) {
      copy.addEventListener("click", () => {
        const ok = api.copy ? api.copy(current) : false;
        setStatus(ok ? text("copied", "已复制到剪贴板", "Copied") : text("copyFail", "复制失败", "Copy failed"), !ok);
      });
    }
    if (save) {
      save.addEventListener("click", async () => {
        setStatus(text("saving", "正在保存…", "Saving…"));
        let p = "";
        try { p = await (api.saveAs ? api.saveAs(current, "references.txt") : ""); } catch (e) { p = ""; }
        if (p) setStatus(text("saved", "已保存：" + p, "Saved: " + p));
        else setStatus(text("saveCancel", "已取消", "Cancelled"));
      });
    }
    if (close) close.addEventListener("click", () => window.close());

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { try { window.close(); } catch (err) { /* ignore */ } }
    });
  }

  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
