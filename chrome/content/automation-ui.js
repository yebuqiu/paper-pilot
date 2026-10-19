// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 自动化规则对话框（0.23.0）
 * 左侧规则列表（启用勾选 / 编辑 / 删除），右侧表单（名称 / 触发 / 条件 / 动作）。
 * 全部读写经 Zotero.Papilot.automation（窗口作用域访问不到 bootstrap 作用域）。
 * 「试跑预览」只统计命中与变更数，不落库 —— 与菜单入口共用同一套 preview()。
 */
/* global window, document */

(function () {
  const XHTML = "http://www.w3.org/1999/xhtml";
  const args = (window.arguments && window.arguments[0]) || {};
  const Z = args.Zotero || (window.opener && window.opener.Zotero);
  const PP = Z && Z.Papilot;
  const zh = Z && (Z.locale || "").toLowerCase().startsWith("zh");

  const $ = (id) => document.getElementById(id);
  const listEl = $("pp-au-list");
  const editorEl = $("pp-au-editor");
  const statusEl = $("pp-au-status");

  if (!PP || !PP.automation) {
    statusEl.textContent = zh ? "错误：无法访问 Papilot 模块" : "Error: module unavailable";
    return;
  }
  const AU = PP.automation;

  const T = {
    newItem: zh ? "新条目入库" : "New item",
    readerOpen: zh ? "打开 PDF" : "Reader opened",
    manual: zh ? "手动（选中条目）" : "Manual (selected)",
  };
  const FIELD_LABEL = {
    title: "标题", publicationTitle: zh ? "期刊" : "Journal", journalAbbreviation: zh ? "期刊缩写" : "Journal abbr.",
    abstractNote: zh ? "摘要" : "Abstract", year: zh ? "年份" : "Year", itemType: zh ? "条目类型" : "Item type",
    DOI: "DOI", creators: zh ? "作者" : "Creators", language: zh ? "语言" : "Language", extra: "Extra",
    url: "URL", publisher: zh ? "出版社" : "Publisher", volume: zh ? "卷" : "Volume",
    issue: zh ? "期" : "Issue", pages: zh ? "页码" : "Pages", tags: zh ? "标签" : "Tags", collection: zh ? "所属分类" : "Collection",
  };
  const OP_LABEL = {
    contains: zh ? "包含" : "contains", "!contains": zh ? "不包含" : "not contains",
    regex: zh ? "正则匹配（默认忽略大小写）" : "regex (case-insensitive)",
    "=": zh ? "等于" : "equals", "!=": zh ? "不等于" : "not equals", ">": ">", "<": "<",
    exists: zh ? "存在（非空）" : "exists", "!exists": zh ? "不存在（为空）" : "not exists",
  };
  const ACTION_LABEL = {
    tag: zh ? "打标签" : "Add tag", removeTag: zh ? "去掉标签" : "Remove tag", field: zh ? "写字段" : "Set field",
    readingState: zh ? "设阅读状态" : "Set reading state", addToCollection: zh ? "加入分类" : "Add to collection",
    aiSummarize: zh ? "AI 总结生成笔记" : "AI summary note", aiAutoTag: zh ? "AI 自动打标签" : "AI auto-tag",
  };

  let rules = AU.load();
  let currentId = null;

  function el(tag, css, text) {
    const n = document.createElementNS(XHTML, tag);
    if (css) n.style.cssText = css;
    if (text != null) n.textContent = text;
    return n;
  }

  function setStatus(t, isErr) {
    statusEl.textContent = t || "";
    statusEl.style.color = isErr ? "var(--accent-red,#c0392b)" : "var(--fill-secondary,#666)";
  }

  function sel(options, value, onchange, css) {
    const s = el("select", css || "font-size:12.5px;padding:2px 4px;");
    for (const [v, label] of options) {
      const o = el("option", "", label);
      o.value = v;
      if (v === value) o.selected = true;
      s.appendChild(o);
    }
    if (onchange) s.addEventListener("change", () => onchange(s.value));
    return s;
  }

  function input(value, oninput, css, placeholder) {
    const i = el("input", css || "font-size:12.5px;padding:2px 6px;width:200px;");
    i.value = value == null ? "" : value;
    if (placeholder) i.placeholder = placeholder;
    if (oninput) i.addEventListener("input", () => oninput(i.value));
    return i;
  }

  function summary(rule) {
    const conds = (rule.conditions || []).map((c) =>
      (FIELD_LABEL[c.field] || c.field) + " " + (OP_LABEL[c.op] || c.op) + (c.op === "exists" ? "" : " " + (c.value || "")));
    const acts = (rule.actions || []).map((a) => ACTION_LABEL[a.type] || a.type);
    return {
      trigger: T[rule.trigger] || rule.trigger,
      cond: conds.length ? conds.join(rule.match === "any" ? " 或 " : " 且 ") : (zh ? "无条件（对所有条目）" : "no conditions"),
      act: acts.join("，"),
    };
  }

  /* ---------------- 全局开关 ---------------- */

  const P = {
    get: (k, d) => { try { return Z.Prefs.get("extensions.zotero.papilot." + k, true); } catch (e) { return d; } },
    set: (k, v) => { try { Z.Prefs.set("extensions.zotero.papilot." + k, v, true); } catch (e) { /* ignore */ } },
  };

  function renderSwitches() {
    const box = $("pp-au-switches");
    box.textContent = "";
    box.appendChild(el("div", "font-weight:600;font-size:12.5px;margin-bottom:5px;", zh ? "全局开关" : "Switches"));

    const mk = (key, def, label, hint) => {
      const lab = el("label", "font-size:12.5px;margin-right:16px;display:inline-flex;align-items:center;gap:4px;");
      const cb = el("input", "");
      cb.type = "checkbox";
      cb.checked = P.get(key, def) === true;
      cb.addEventListener("change", () => { P.set(key, cb.checked); renderSwitches(); });
      lab.appendChild(cb);
      lab.appendChild(el("span", "", label));
      if (hint) lab.appendChild(el("span", "color:var(--fill-secondary,#888);font-size:11px;", hint));
      return lab;
    };

    const r1 = el("div", "display:flex;flex-wrap:wrap;align-items:center;gap:4px;");
    r1.appendChild(mk("automationOnNewItem", false, zh ? "新条目入库时自动执行规则" : "Run rules on new items"));
    r1.appendChild(mk("automationOnReaderOpen", false, zh ? "打开 PDF 时自动执行规则" : "Run rules when opening a PDF"));
    box.appendChild(r1);

    const r2 = el("div", "display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:5px;font-size:12.5px;");
    r2.appendChild(mk("autoReadEnabled", false, zh ? "入库自动精读（AI 生成总结笔记）" : "Auto-read on import (AI summary)"));
    r2.appendChild(el("span", "color:var(--fill-secondary,#666);", zh ? "仅限分类" : "Only in"));
    const cols = [["", zh ? "全库" : "Whole library"]];
    try {
      const libs = Z.Collections.getByLibrary(Z.Libraries.userLibraryID, true) || [];
      for (const c of libs) cols.push([String(c.id), c.name]);
    } catch (e) { /* ignore */ }
    r2.appendChild(sel(cols, String(P.get("autoReadCollection", "") || ""), (v) => { P.set("autoReadCollection", v); }, "max-width:220px;font-size:12.5px;padding:2px 4px;"));
    r2.appendChild(el("span", "color:var(--fill-secondary,#666);", zh ? "每日上限" : "Daily cap"));
    r2.appendChild(input(String(P.get("autoReadDailyCap", 10)), (v) => {
      const n = Number(v);
      if (!isNaN(n) && n > 0) P.set("autoReadDailyCap", n);
    }, "width:56px;font-size:12.5px;padding:2px 5px;"));
    r2.appendChild(el("span", "color:var(--fill-secondary,#666);font-size:11.5px;",
      (zh ? "今日已用 " : "used today ") + PP.autoRead.todayCount()));
    box.appendChild(r2);

    const r3 = el("div", "margin-top:5px;font-size:12px;color:var(--fill-secondary,#666);", zh
      ? "AI 动作与自动精读共用每日额度（automationDailyAiCap），额度用尽会自动暂停并在下次操作时告知。"
      : "AI actions share a daily quota; it pauses automatically when exhausted.");
    box.appendChild(r3);
  }

  /* ---------------- 列表 ---------------- */

  function renderList() {
    listEl.textContent = "";
    if (!rules.length) {
      listEl.appendChild(el("div", "color:var(--fill-tertiary,#999);padding:6px;",
        zh ? "还没有规则。点「新建规则」或「恢复内置示例」。" : "No rules yet."));
      return;
    }
    rules.forEach((r) => {
      const s = summary(r);
      const card = el("div", "border:1px solid var(--fill-quinary,#ddd);border-radius:6px;padding:7px;margin-bottom:6px;" +
        (r.id === currentId ? "background:var(--color-accent-10,rgba(37,99,235,.08));" : ""));
      const head = el("div", "display:flex;align-items:center;gap:6px;");
      const cb = el("input", "flex:0 0 auto;");
      cb.type = "checkbox";
      cb.checked = r.enabled !== false;
      cb.addEventListener("change", () => { r.enabled = cb.checked; AU.save(rules); renderList(); });
      head.appendChild(cb);
      head.appendChild(el("b", "font-size:13px;flex:1;min-width:0;", r.name || (zh ? "（未命名）" : "(untitled)")));
      const errors = AU.validate(r);
      if (errors.length) head.appendChild(el("span", "color:#c0392b;font-size:11px;", zh ? "配置有误" : "invalid"));
      card.appendChild(head);
      const extras = [];
      if (String(r.hotkey || "").trim()) extras.push("⌨ " + String(r.hotkey).trim());
      if (r.showInMenu === true) extras.push(zh ? "右键菜单" : "menu");
      card.appendChild(el("div", "color:var(--fill-secondary,#666);font-size:11.5px;margin-top:3px;",
        "触发：" + s.trigger + " ｜ 条件：" + s.cond + (extras.length ? " ｜ " + extras.join(" · ") : "")));
      card.appendChild(el("div", "color:var(--color-accent,#2563eb);font-size:11.5px;margin-top:2px;", "动作：" + s.act));
      const bar = el("div", "display:flex;gap:6px;margin-top:5px;");
      const be = el("button", "font-size:11.5px;padding:1px 8px;", zh ? "编辑" : "Edit");
      be.addEventListener("click", () => { currentId = r.id; renderList(); renderEditor(); });
      const bd = el("button", "font-size:11.5px;padding:1px 8px;", zh ? "删除" : "Delete");
      bd.addEventListener("click", () => {
        rules = rules.filter((x) => x.id !== r.id);
        AU.save(rules);
        if (currentId === r.id) { currentId = null; renderEditor(); }
        renderList();
        setStatus(zh ? "已删除" : "Deleted");
      });
      bar.appendChild(be); bar.appendChild(bd);
      card.appendChild(bar);
      card.addEventListener("click", (ev) => {
        if (ev.target === cb || ev.target === be || ev.target === bd) return;
        currentId = r.id; renderList(); renderEditor();
      });
      listEl.appendChild(card);
    });
  }

  /* ---------------- 编辑器 ---------------- */

  function blankRule() {
    return {
      id: "r" + Date.now().toString(36), name: "", enabled: true,
      trigger: "manual", match: "all", conditions: [], actions: [{ type: "tag", tag: "" }],
      hotkey: "", showInMenu: false,
    };
  }

  /* ---------------- 快捷键录制 ---------------- */

  /** keydown 事件 → combo 串（如 "Ctrl+Shift+T"）；纯修饰键返回 null（继续等下一次按键） */
  function comboFromEvent(ev) {
    const key = ev.key || "";
    if (["Control", "Alt", "Shift", "Meta"].includes(key)) return null;
    const parts = [];
    if (ev.ctrlKey) parts.push("Ctrl");
    if (ev.altKey) parts.push("Alt");
    if (ev.shiftKey) parts.push("Shift");
    if (ev.metaKey) parts.push("Meta");
    let k = key === " " ? "Space" : key;
    if (k.indexOf("Arrow") === 0) k = k.slice(5); // ArrowUp → Up
    if (k.length === 1) k = k.toUpperCase();
    parts.push(k);
    return parts.join("+");
  }

  let recording = null; // {done()} 录制进行中时非空

  function stopRecording() {
    if (!recording) return;
    recording.done();
    recording = null;
  }

  /** 录制下一次按键，成功后写入 rule.hotkey 并重绘编辑器 */
  function startRecording(rule, btn) {
    stopRecording();
    btn.textContent = zh ? "请按快捷键…（Esc 取消）" : "Press keys… (Esc to cancel)";
    const onKey = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.key === "Escape" && !ev.ctrlKey && !ev.altKey && !ev.shiftKey && !ev.metaKey) {
        stopRecording();
        renderEditor();
        return;
      }
      const combo = comboFromEvent(ev);
      if (!combo) return; // 只按了修饰键，继续等
      stopRecording();
      if (!validCombo(combo)) {
        setStatus(zh ? "快捷键需要至少一个修饰键（Ctrl/Alt/Shift）+ 主键" : "Need a modifier + a key", true);
        renderEditor();
        return;
      }
      rule.hotkey = combo;
      renderEditor();
      renderList();
      setStatus((zh ? "已录制快捷键：" : "Recorded: ") + combo);
    };
    const done = () => document.removeEventListener("keydown", onKey, true);
    recording = { done };
    document.addEventListener("keydown", onKey, true);
  }

  function validCombo(combo) {
    try { return AU.isValidHotkey(combo); } catch (e) { return false; }
  }

  function renderEditor() {
    editorEl.textContent = "";
    let rule = rules.find((r) => r.id === currentId);
    if (!rule) {
      editorEl.appendChild(el("div", "color:var(--fill-tertiary,#999);padding:6px;",
        zh ? "从左侧选择一条规则，或点「新建规则」。" : "Select a rule or create a new one."));
      return;
    }

    // 名称
    const row1 = el("div", "display:flex;gap:8px;align-items:center;margin-bottom:8px;");
    row1.appendChild(el("span", "width:56px;color:var(--fill-secondary,#666);", zh ? "名称" : "Name"));
    row1.appendChild(input(rule.name, (v) => { rule.name = v; }, "flex:1;font-size:13px;padding:3px 6px;"));
    editorEl.appendChild(row1);

    // 触发 + 匹配方式
    const row2 = el("div", "display:flex;gap:16px;align-items:center;margin-bottom:8px;flex-wrap:wrap;");
    row2.appendChild(el("span", "color:var(--fill-secondary,#666);", zh ? "触发" : "Trigger"));
    row2.appendChild(sel(AU.TRIGGERS.map((t) => [t, T[t]]), rule.trigger, (v) => { rule.trigger = v; renderList(); }));
    row2.appendChild(el("span", "color:var(--fill-secondary,#666);margin-left:8px;", zh ? "条件满足方式" : "Match"));
    row2.appendChild(sel([["all", zh ? "全部满足" : "all"], ["any", zh ? "任一满足" : "any"]], rule.match || "all", (v) => { rule.match = v; renderList(); }));
    editorEl.appendChild(row2);

    // 快捷键 + 右键菜单
    const row2b = el("div", "display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap;");
    row2b.appendChild(el("span", "color:var(--fill-secondary,#666);", zh ? "快捷键" : "Hotkey"));
    const hkInput = el("input", "font-size:12.5px;padding:2px 6px;width:170px;color:var(--fill-primary,#222);");
    hkInput.readOnly = true;
    hkInput.value = String(rule.hotkey || "");
    hkInput.placeholder = zh ? "（未设置）" : "(none)";
    row2b.appendChild(hkInput);
    const bRec = el("button", "font-size:12px;padding:1px 9px;", zh ? "录制" : "Record");
    bRec.addEventListener("click", () => startRecording(rule, bRec));
    row2b.appendChild(bRec);
    const bClear = el("button", "font-size:12px;padding:1px 9px;", zh ? "清除" : "Clear");
    bClear.addEventListener("click", () => {
      stopRecording();
      rule.hotkey = "";
      renderEditor();
      renderList();
    });
    row2b.appendChild(bClear);
    const menuLab = el("label", "font-size:12.5px;display:inline-flex;align-items:center;gap:4px;margin-left:10px;");
    const menuCb = el("input", "");
    menuCb.type = "checkbox";
    menuCb.checked = rule.showInMenu === true;
    menuCb.addEventListener("change", () => { rule.showInMenu = menuCb.checked; renderList(); });
    menuLab.appendChild(menuCb);
    menuLab.appendChild(el("span", "", zh ? "出现在条目右键菜单" : "Show in item context menu"));
    row2b.appendChild(menuLab);
    editorEl.appendChild(row2b);
    row2b.appendChild(el("span", "color:var(--fill-secondary,#888);font-size:11px;flex-basis:100%;",
      zh ? "快捷键与右键菜单项在保存规则后生效；快捷键需至少一个修饰键（Ctrl/Alt/Shift）。"
        : "Hotkey/menu take effect after saving; hotkey needs a modifier key."));

    // 条件
    editorEl.appendChild(el("div", "font-weight:600;margin:6px 0 4px;", zh ? "条件（留空=对所有条目生效）" : "Conditions"));
    (rule.conditions || []).forEach((c, i) => {
      const row = el("div", "display:flex;gap:6px;align-items:center;margin-bottom:4px;flex-wrap:wrap;");
      row.appendChild(sel(AU.READ_FIELDS.map((f) => [f, FIELD_LABEL[f] || f]), c.field, (v) => { c.field = v; renderList(); }));
      row.appendChild(sel(AU.OPS.map((o) => [o, OP_LABEL[o] || o]), c.op, (v) => { c.op = v; renderList(); }));
      row.appendChild(input(c.value, (v) => { c.value = v; renderList(); }, "flex:1;min-width:160px;font-size:12.5px;padding:2px 6px;",
        c.op === "exists" ? (zh ? "（exists 无需填值）" : "(no value)") : ""));
      const bd = el("button", "font-size:11.5px;padding:1px 7px;", "−");
      bd.addEventListener("click", () => { rule.conditions.splice(i, 1); renderEditor(); renderList(); });
      row.appendChild(bd);
      editorEl.appendChild(row);
    });
    const addCond = el("button", "font-size:12px;padding:1px 9px;margin-bottom:8px;", zh ? "＋ 添加条件" : "+ Condition");
    addCond.addEventListener("click", () => {
      rule.conditions = rule.conditions || [];
      rule.conditions.push({ field: "publicationTitle", op: "contains", value: "" });
      renderEditor(); renderList();
    });
    editorEl.appendChild(addCond);

    // 动作
    editorEl.appendChild(el("div", "font-weight:600;margin:10px 0 4px;", zh ? "动作（按顺序执行）" : "Actions"));
    (rule.actions || []).forEach((a, i) => {
      const row = el("div", "display:flex;gap:6px;align-items:center;margin-bottom:4px;flex-wrap:wrap;");
      row.appendChild(sel(AU.ACTION_TYPES.map((t) => [t, ACTION_LABEL[t] || t]), a.type, (v) => {
        a.type = v;
        delete a.tag; delete a.field; delete a.value; delete a.state; delete a.collectionID;
        if (v === "tag" || v === "removeTag") a.tag = "";
        if (v === "field") { a.field = AU.WRITE_FIELDS[0]; a.value = ""; }
        if (v === "readingState") a.state = "未读";
        renderEditor(); renderList();
      }));
      if (a.type === "tag" || a.type === "removeTag") {
        row.appendChild(input(a.tag, (v) => { a.tag = v; renderList(); }, "flex:1;min-width:180px;font-size:12.5px;padding:2px 6px;", "#标签"));
      } else if (a.type === "field") {
        row.appendChild(sel(AU.WRITE_FIELDS.map((f) => [f, FIELD_LABEL[f] || f]), a.field, (v) => { a.field = v; renderList(); }));
        row.appendChild(input(a.value, (v) => { a.value = v; renderList(); }, "flex:1;min-width:150px;font-size:12.5px;padding:2px 6px;"));
      } else if (a.type === "readingState") {
        row.appendChild(sel([["未读", zh ? "未读" : "Unread"], ["在读", zh ? "在读" : "Reading"], ["已读", zh ? "已读" : "Done"]], a.state, (v) => { a.state = v; renderList(); }));
      } else if (a.type === "addToCollection") {
        const cols = [];
        try {
          const libs = Z.Collections.getByLibrary(Z.Libraries.userLibraryID, true) || [];
          for (const c of libs) cols.push([String(c.id), c.name]);
        } catch (e) { /* ignore */ }
        if (!cols.length) cols.push(["", zh ? "（没有可用分类）" : "(none)"]);
        row.appendChild(sel(cols, String(a.collectionID || ""), (v) => { a.collectionID = v ? Number(v) : ""; renderList(); }, "max-width:280px;font-size:12.5px;padding:2px 4px;"));
      } else if (a.type === "aiSummarize" || a.type === "aiAutoTag") {
        row.appendChild(el("span", "color:var(--fill-secondary,#666);font-size:11.5px;",
          zh ? "（受每日 AI 额度限制，可在设置中调整）" : "(limited by daily AI quota)"));
      }
      const bd = el("button", "font-size:11.5px;padding:1px 7px;", "−");
      bd.addEventListener("click", () => { rule.actions.splice(i, 1); renderEditor(); renderList(); });
      row.appendChild(bd);
      editorEl.appendChild(row);
    });
    const addAct = el("button", "font-size:12px;padding:1px 9px;margin-bottom:10px;", zh ? "＋ 添加动作" : "+ Action");
    addAct.addEventListener("click", () => {
      rule.actions = rule.actions || [];
      rule.actions.push({ type: "tag", tag: "" });
      renderEditor(); renderList();
    });
    editorEl.appendChild(addAct);

    // 校验提示 + 保存 / 试跑
    const errs = AU.validate(rule);
    if (errs.length) {
      const box = el("div", "background:rgba(192,57,43,.08);border:1px solid rgba(192,57,43,.4);border-radius:6px;padding:7px;margin-bottom:8px;color:#c0392b;font-size:12.5px;");
      box.appendChild(el("div", "font-weight:600;margin-bottom:2px;", zh ? "还不能启用：" : "Not ready:"));
      errs.forEach((e) => box.appendChild(el("div", "", "· " + e)));
      editorEl.appendChild(box);
    }

    const bar = el("div", "display:flex;gap:8px;align-items:center;flex-wrap:wrap;");
    const bs = el("button", "font-weight:bold;", zh ? "保存规则" : "Save rule");
    bs.addEventListener("click", () => {
      stopRecording();
      const e2 = AU.validate(rule);
      if (e2.length) { setStatus((zh ? "校验失败：" : "Invalid: ") + e2[0], true); return; }
      const idx = rules.findIndex((r) => r.id === rule.id);
      if (idx >= 0) rules[idx] = rule; else rules.push(rule);
      AU.save(rules);
      renderList();
      setStatus(zh ? "已保存" : "Saved");
    });
    const bt = el("button", "", zh ? "对选中条目试跑（只预览）" : "Dry-run on selection");
    bt.addEventListener("click", async () => {
      setStatus(zh ? "正在预览…" : "Previewing…");
      try {
        const e2 = AU.validate(rule);
        if (e2.length) { setStatus((zh ? "校验失败：" : "Invalid: ") + e2[0], true); return; }
        const zp = Z.getActiveZoteroPane();
        const items = (zp && zp.getSelectedItems ? zp.getSelectedItems() : []) || [];
        const reg = [];
        for (const it of items) {
          if (it && it.isRegularItem && it.isRegularItem() && !it.deleted) reg.push(it);
        }
        if (!reg.length) { setStatus(zh ? "主窗口没有选中条目" : "Nothing selected in the main window", true); return; }
        const pv = await AU.preview([rule], reg);
        setStatus((zh ? `选中 ${reg.length} 篇 → 命中 ${pv.hits.length} 处，预计 ${pv.changeCount} 项变更（未执行）`
                      : `${reg.length} selected → ${pv.hits.length} matches, ${pv.changeCount} changes (not applied)`));
      } catch (e) {
        setStatus((zh ? "预览失败：" : "Preview failed: ") + ((e && e.message) || e), true);
      }
    });
    bar.appendChild(bs); bar.appendChild(bt);
    editorEl.appendChild(bar);
  }

  /* ---------------- 顶部按钮 ---------------- */

  $("pp-au-new").addEventListener("click", () => {
    const r = blankRule();
    rules.push(r);
    currentId = r.id;
    renderList(); renderEditor();
    setStatus(zh ? "新规则（未保存）" : "New rule (unsaved)");
  });

  $("pp-au-import").addEventListener("click", () => {
    const res = AU.importFromRuleTag();
    rules = res.list;
    renderList();
    setStatus(res.imported
      ? (zh ? "已导入 " + res.imported + " 条规则（触发=手动）" : "Imported " + res.imported)
      : (zh ? "「规则打标」里没有可导入的规则" : "Nothing to import"));
  });

  $("pp-au-presets").addEventListener("click", () => {
    let n = 0;
    for (const p of AU.presets()) {
      if (rules.some((r) => r.id === p.id)) continue;
      rules.push(p);
      n++;
    }
    AU.save(rules);
    renderList();
    setStatus(n ? (zh ? "已加入 " + n + " 条示例（默认未启用，请按需勾选）" : "Added " + n + " presets (disabled by default)")
                : (zh ? "示例已存在" : "Presets already present"));
  });

  $("pp-au-close").addEventListener("click", () => window.close());

  renderSwitches();
  renderList();
  renderEditor();
  setStatus(zh ? "提示：规则改动后点「保存规则」；自动触发需在设置中开启对应开关。" : "");
})();
