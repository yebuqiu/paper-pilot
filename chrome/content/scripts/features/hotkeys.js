// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 快捷键中央注册表（D4）
 *
 * 暴露 Papilot.Hotkeys（init 时自挂；main.js 也可显式赋值）。
 *
 * API：
 *   register({id, label, combo, scope, handler})
 *     scope: "main"（主窗口 XUL keyset，handler(win) 随 keyset 注入各主窗口）
 *            "reader"（reader 文档 keydown，由消费方用 matches() 自行捕获）
 *     combo: "Ctrl+Shift+K" / "Ctrl+Enter"（Cmd 归一为 Ctrl = XUL accel：
 *            Win/Linux=Ctrl、Mac=Cmd，沿用既有 (ctrlKey||metaKey) 语义）
 *   getAll()        → [{id,label,scope,defaultCombo,combo,enabled}]（含默认与生效值）
 *   get(id)         → 单条生效视图或 null
 *   combo(id)       → 生效 combo 串
 *   isEnabled(id)
 *   setCombo(id, newCombo) / resetCombo(id) / setEnabled(id, bool)
 *   startRecording(onDone) → 捕获下一次 keydown 合成 combo 回调（Esc=取消回调 null），
 *                            返回静默取消函数（供设置面板录制 UI）
 *   normalizeCombo(raw) / comboFromEvent(ev) / matches(ev, combo)
 *
 * 覆盖存 pref extensions.papilot.hotkeys（JSON {id:{combo,enabled}}），
 * 仅记与默认的差异；变更即时重建主窗口 keyset（含外部改 pref，经 observer）。
 *
 * 生命周期：main.js 加载本文件后调 Hotkeys.init()（须在 ChatFloat.register 之前），
 * destroy 时调 Hotkeys.shutdown()。
 */
/* global Zotero, Services */

var Hotkeys = {
  PREF_KEY: "extensions.papilot.hotkeys",
  KEYSET_ID: "papilot-hotkeys-keyset",
  KEY_PREFIX: "papilot-hotkey-",
  XUL: "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul",

  _defs: [],        // 注册顺序 [{id,label,combo,scope,handler}]
  _byId: {},
  _overrides: {},   // {id:{combo?,enabled?}}（仅差异）
  _inited: false,
  _winObserver: null,
  _prefObserver: null,

  /* ==================== 生命周期 ==================== */

  init() {
    if (this._inited) return;
    this._inited = true;
    this._loadOverrides();
    this._rebuildAll();
    // 之后新开的主窗口补挂 keyset（只装 Zotero 主窗口，与 chat-float 既有写法一致）
    try {
      this._winObserver = {
        observe(subject) {
          try {
            const win = subject && subject.defaultView ? subject.defaultView : subject;
            if (win && win.ZoteroPane) Hotkeys._rebuildKeyset(win);
          } catch (e) { /* ignore */ }
        },
      };
      Services.obs.addObserver(this._winObserver, "domwindowopened", false);
    } catch (e) {
      this._winObserver = null;
      this._err(e);
    }
    // pref 被外部（设置面板之外的途径）改动时也即时生效
    try {
      if (Zotero.Prefs && typeof Zotero.Prefs.registerObserver === "function") {
        this._prefObserver = Zotero.Prefs.registerObserver(this.PREF_KEY, () => {
          try {
            Hotkeys._loadOverrides();
            Hotkeys._rebuildAll();
          } catch (e) { /* ignore */ }
        }, true);
      }
    } catch (e) { /* ignore */ }
    try { if (Zotero.Papilot) Zotero.Papilot.Hotkeys = this; } catch (e) { /* ignore */ }
  },

  shutdown() {
    try {
      if (this._winObserver) Services.obs.removeObserver(this._winObserver, "domwindowopened");
    } catch (e) { /* ignore */ }
    this._winObserver = null;
    try {
      if (this._prefObserver && Zotero.Prefs && Zotero.Prefs.unregisterObserver) {
        Zotero.Prefs.unregisterObserver(this._prefObserver);
      }
    } catch (e) { /* ignore */ }
    this._prefObserver = null;
    let wins = [];
    try { wins = Zotero.getMainWindows() || []; } catch (e) { /* ignore */ }
    for (const win of wins) {
      try {
        const ks = win && win.document && win.document.getElementById(this.KEYSET_ID);
        if (ks) ks.remove();
      } catch (e) { /* ignore */ }
    }
    this._inited = false;
  },

  _err(e) {
    try { Zotero.logError(e); } catch (_) { /* ignore */ }
  },

  /* ==================== 注册与查询 ==================== */

  register(def) {
    if (!def || !def.id) return null;
    const id = String(def.id);
    const rec = {
      id,
      label: String(def.label || id),
      combo: this.normalizeCombo(def.combo || ""),
      scope: def.scope === "reader" ? "reader" : "main",
      handler: typeof def.handler === "function" ? def.handler : null,
    };
    const old = this._byId[id];
    if (old) {
      // 重复注册：覆盖定义（保留旧默认 combo 兜底），位序不变
      if (!rec.combo) rec.combo = old.combo;
      this._defs[this._defs.indexOf(old)] = rec;
    } else {
      this._defs.push(rec);
    }
    this._byId[id] = rec;
    if (this._inited) this._rebuildAll();
    return id;
  },

  get(id) {
    const def = this._byId[id];
    if (!def) return null;
    const eff = this._effective(id);
    return {
      id: def.id, label: def.label, scope: def.scope,
      defaultCombo: def.combo, combo: eff.combo, enabled: eff.enabled,
    };
  },

  getAll() {
    return this._defs.map((d) => this.get(d.id));
  },

  combo(id) {
    const g = this.get(id);
    return g ? g.combo : "";
  },

  isEnabled(id) {
    const g = this.get(id);
    return !!(g && g.enabled);
  },

  /* ==================== 覆盖（set / reset / enable） ==================== */

  setCombo(id, newCombo) {
    if (!this._byId[id]) return false;
    const c = this.normalizeCombo(newCombo);
    if (!c) return false;
    const o = this._overrides[id] || (this._overrides[id] = {});
    o.combo = c;
    this._saveOverrides();
    if (this._inited) this._rebuildAll();
    return true;
  },

  resetCombo(id) {
    if (!this._byId[id]) return false;
    const o = this._overrides[id];
    if (o) {
      delete o.combo;
      if (!Object.keys(o).length) delete this._overrides[id];
      this._saveOverrides();
    }
    if (this._inited) this._rebuildAll();
    return true;
  },

  setEnabled(id, flag) {
    if (!this._byId[id]) return false;
    const o = this._overrides[id] || (this._overrides[id] = {});
    if (flag === false) o.enabled = false;
    else delete o.enabled;
    if (!Object.keys(o).length) delete this._overrides[id];
    this._saveOverrides();
    if (this._inited) this._rebuildAll();
    return true;
  },

  _effective(id) {
    const def = this._byId[id];
    const o = (id && this._overrides[id]) || {};
    return {
      combo: o.combo || (def ? def.combo : ""),
      enabled: o.enabled !== false,
    };
  },

  _loadOverrides() {
    this._overrides = {};
    let v = null;
    try {
      const raw = Zotero.Prefs.get(this.PREF_KEY, true);
      if (raw) v = JSON.parse(String(raw));
    } catch (e) { v = null; }
    if (!v || typeof v !== "object" || Array.isArray(v)) return;
    for (const id in v) {
      const o = v[id];
      if (!o || typeof o !== "object") continue;
      const entry = {};
      if (o.combo != null) {
        const c = this.normalizeCombo(o.combo);
        if (c) entry.combo = c;
      }
      if (o.enabled === false) entry.enabled = false;
      if (Object.keys(entry).length) this._overrides[id] = entry;
    }
  },

  _saveOverrides() {
    try {
      Zotero.Prefs.set(this.PREF_KEY, JSON.stringify(this._overrides), true);
    } catch (e) { /* 超限时静默 */ }
  },

  /* ==================== combo 规范化与匹配 ==================== */

  /** 键名归一：单字符大写；常见别名收敛（大小写不敏感，Esc→Escape、" "→Space 等） */
  _canonKey(k) {
    k = String(k == null ? "" : k);
    if (k === " ") return "Space";
    const low = k.trim().toLowerCase();
    const alias = {
      spacebar: "Space", esc: "Escape", del: "Delete", return: "Enter",
      up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
    };
    if (alias[low]) return alias[low];
    const t = k.trim();
    if (!t) return "";
    if (t.length === 1) return t.toUpperCase();
    return t[0].toUpperCase() + t.slice(1);
  },

  /**
   * combo 字符串规范化：修饰键顺序归一为 Ctrl+Alt+Shift+键；
   * Cmd/Command/Meta/Control/Option 等别名收敛（Cmd→Ctrl，即 XUL accel）。
   * 无有效键名返回 ""。
   */
  normalizeCombo(raw) {
    const s = String(raw || "").trim();
    if (!s) return "";
    const toks = s.split("+").map((t) => t.trim()).filter(Boolean);
    if (!toks.length) return "";
    let ctrl = false, alt = false, shift = false, key = "";
    for (const t of toks) {
      const l = t.toLowerCase();
      if (l === "ctrl" || l === "control" || l === "cmd" || l === "command"
        || l === "meta" || l === "accel") { ctrl = true; continue; }
      if (l === "alt" || l === "option") { alt = true; continue; }
      if (l === "shift") { shift = true; continue; }
      key = t; // 最后一个非修饰符 token 为键名
    }
    key = this._canonKey(key);
    if (!key) return "";
    const parts = [];
    if (ctrl) parts.push("Ctrl");
    if (alt) parts.push("Alt");
    if (shift) parts.push("Shift");
    parts.push(key);
    return parts.join("+");
  },

  /** keydown 事件 → 规范 combo 串；纯修饰键按下返回 null */
  comboFromEvent(ev) {
    if (!ev || !ev.key) return null;
    const k = String(ev.key);
    if (k === "Control" || k === "Shift" || k === "Alt" || k === "Meta") return null;
    const parts = [];
    if (ev.ctrlKey || ev.metaKey) parts.push("Ctrl");
    if (ev.altKey) parts.push("Alt");
    if (ev.shiftKey) parts.push("Shift");
    parts.push(this._canonKey(k));
    return parts.join("+");
  },

  /** 事件是否命中 combo（Ctrl 匹配 ctrlKey||metaKey，修饰键严格相等） */
  matches(ev, combo) {
    const norm = this.normalizeCombo(combo);
    if (!norm || !ev) return false;
    const toks = norm.split("+");
    const key = toks[toks.length - 1];
    if (!!(ev.ctrlKey || ev.metaKey) !== (toks.indexOf("Ctrl") >= 0)) return false;
    if (!!ev.altKey !== (toks.indexOf("Alt") >= 0)) return false;
    if (!!ev.shiftKey !== (toks.indexOf("Shift") >= 0)) return false;
    return this._canonKey(String(ev.key || "")) === key;
  },

  /**
   * 录制助手：捕获主窗口下一次 keydown 合成 combo 回调 onDone(combo)；
   * Esc 取消（回调 null）。返回静默取消函数（不触发回调）。供设置面板录制 UI。
   */
  startRecording(onDone) {
    const done = typeof onDone === "function" ? onDone : function () {};
    let win = null;
    try { win = Zotero.getMainWindow(); } catch (e) { /* ignore */ }
    const doc = win && win.document;
    if (!doc || typeof doc.addEventListener !== "function") {
      done(null);
      return function () {};
    }
    let finished = false;
    const detach = () => {
      try { doc.removeEventListener("keydown", onKey, true); } catch (e) { /* ignore */ }
    };
    const finish = (combo) => {
      if (finished) return;
      finished = true;
      detach();
      done(combo);
    };
    const onKey = (ev) => {
      try { ev.preventDefault(); ev.stopPropagation(); } catch (e) { /* ignore */ }
      if (ev.key === "Escape") { finish(null); return; }
      const combo = this.comboFromEvent(ev);
      if (combo) finish(combo);
    };
    doc.addEventListener("keydown", onKey, true);
    return function cancel() {
      if (finished) return;
      finished = true;
      detach();
    };
  },

  /* ==================== 主窗口 keyset 动态重建 ==================== */

  _xul(doc, tag) {
    return doc.createXULElement
      ? doc.createXULElement(tag)
      : doc.createElementNS(this.XUL, tag);
  },

  _XUL_KEYCODES: {
    Enter: "VK_RETURN", Escape: "VK_ESCAPE", Tab: "VK_TAB", Space: "VK_SPACE",
    Backspace: "VK_BACK", Delete: "VK_DELETE", Insert: "VK_INSERT",
    Home: "VK_HOME", End: "VK_END", PageUp: "VK_PAGE_UP", PageDown: "VK_PAGE_DOWN",
    ArrowUp: "VK_UP", ArrowDown: "VK_DOWN", ArrowLeft: "VK_LEFT", ArrowRight: "VK_RIGHT",
    F1: "VK_F1", F2: "VK_F2", F3: "VK_F3", F4: "VK_F4", F5: "VK_F5", F6: "VK_F6",
    F7: "VK_F7", F8: "VK_F8", F9: "VK_F9", F10: "VK_F10", F11: "VK_F11", F12: "VK_F12",
  },

  /** 规范 combo → XUL <key> 属性；无法表达（未知特殊键）返回 null */
  _parseForXul(combo) {
    const norm = this.normalizeCombo(combo);
    if (!norm) return null;
    const toks = norm.split("+");
    const key = toks.pop();
    const mods = [];
    if (toks.indexOf("Ctrl") >= 0) mods.push("accel");
    if (toks.indexOf("Alt") >= 0) mods.push("alt");
    if (toks.indexOf("Shift") >= 0) mods.push("shift");
    const out = { modifiers: mods.join(" "), key: "", keycode: "" };
    if (this._XUL_KEYCODES[key]) out.keycode = this._XUL_KEYCODES[key];
    else if (key.length === 1) out.key = key;
    else return null;
    return out;
  },

  _rebuildAll() {
    let wins = [];
    try { wins = Zotero.getMainWindows() || []; } catch (e) { /* ignore */ }
    for (const win of wins) {
      try { this._rebuildKeyset(win); } catch (e) { this._err(e); }
    }
  },

  /** 单窗口重建：整块 keyset 清掉重填（参考 chat-float.js 的 keyset 注入写法） */
  _rebuildKeyset(win) {
    const doc = win && win.document;
    if (!doc || !doc.documentElement) return;
    let keyset = doc.getElementById(this.KEYSET_ID);
    if (!keyset) {
      keyset = this._xul(doc, "keyset");
      keyset.id = this.KEYSET_ID;
      doc.documentElement.appendChild(keyset);
    }
    while (keyset.firstChild) keyset.removeChild(keyset.firstChild);
    for (const def of this._defs) {
      if (def.scope !== "main" || !def.handler) continue;
      const eff = this._effective(def.id);
      if (!eff.enabled || !eff.combo) continue;
      const parsed = this._parseForXul(eff.combo);
      if (!parsed) continue;
      const key = this._xul(doc, "key");
      key.id = this.KEY_PREFIX + def.id;
      key.setAttribute("modifiers", parsed.modifiers);
      if (parsed.keycode) key.setAttribute("keycode", parsed.keycode);
      else key.setAttribute("key", parsed.key);
      key.setAttribute("oncommand", "//");
      key.addEventListener("command", () => {
        try { def.handler(win); } catch (e) { this._err(e); }
      });
      keyset.appendChild(key);
    }
  },
};
