// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot · 个人中心「账号与密钥」窗口（0.66.0，Pro）
 *
 * 职责只有三件：把 CredVault.items() 画出来、把用户操作转成 CredVault 调用、
 * 控制「什么时候可以把明文放进 DOM」。
 *
 * 安全纪律（改这个文件前先读）：
 *   ① 默认 locked：**任何明文都不写进 DOM**，只渲染 mask()。
 *   ② 解锁需要「访问口令」（设了才要求）或窗口内二次确认；解锁后按 autoHideSec
 *      自动重新锁定，锁定即刻重渲染（明文从 DOM 上彻底移除，不是 css 隐藏）。
 *   ③ 口令连续错 3 次 → 内存里冻结 30 秒（避免窗口内快速穷举）。
 *   ④ 这里不落盘任何东西：所有写操作走 CredVault（它负责 pref / 托管 / 审计）。
 *
 * 窗口纪律（与 skill-store.xhtml 同源）：顶部 <script> 先于 DOM 执行 →
 * boot() + DOMContentLoaded 双保险；表单控件一律 no-native + 显式配色；
 * 不依赖 window.confirm 之外的平台 API（Services 经 window.arguments 传入）。
 */
/* global window, document, setTimeout, clearTimeout */

(function () {
  const XHTML = "http://www.w3.org/1999/xhtml";

  let zh = true;
  let PP = null;      // Zotero.Papilot
  let V = null;       // CredVault
  let SV = null;      // Services（窗口参数传入；缺失时回落 window.confirm）
  let ZOT = null;     // Zotero（窗口参数传入）

  const T = (a, b) => (zh ? a : (b || a));

  /** 窗口状态：全部在内存里，关窗即弃 */
  const S = {
    unlocked: false,
    editId: "",
    q: "",
    active: "overview",
    hosted: {},
    failCount: 0,
    lockUntil: 0,
    busy: false,
    hideTimer: null,
    pending: "",       // "" | "pass"（输口令）| "confirm"（无口令二次确认）
    pendingEditId: "", // 未解锁时点「编辑」→ 解锁成功后直接进编辑态
    prefObs: null,     // aiChannels 观察者（窗口关闭必须注销，否则重开窗口会重复渲染）
  };

  const ACT_LABEL = {
    open: "打开窗口", unlock: "解锁", lock: "锁定", reveal: "查看明文",
    edit: "修改", clear: "清除", "host-up": "存到账号", "host-down": "从账号取回",
    "host-del": "删除托管", "pass-set": "设置口令", "pass-clear": "清除口令",
    "host-only-on": "改为仅托管", "host-only-off": "取消仅托管", "audit-clear": "清空记录",
  };

  /* ================= 工具 ================= */

  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    const n = document.createElementNS(XHTML, tag);
    if (cls) n.setAttribute("class", cls);
    if (text != null) n.textContent = String(text);
    return n;
  }

  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

  function setMsg(text, kind) {
    const m = $("v-msg");
    if (!m) return;
    m.textContent = text || "";
    m.className = "v-msg" + (kind === "ok" ? " v-msg-ok" : (kind === "err" ? " v-msg-err" : ""));
  }

  function fmtTime(ts) {
    try {
      const d = new Date(Number(ts) || 0);
      const p = (n) => (n < 10 ? "0" : "") + n;
      return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " "
        + p(d.getHours()) + ":" + p(d.getMinutes());
    } catch (e) { return ""; }
  }

  /** 确认框：优先 Services.prompt（与插件其他窗口一致），否则窗口原生 confirm */
  function confirmDlg(title, msg) {
    try {
      if (SV && SV.prompt && SV.prompt.confirm) {
        const win = ZOT && ZOT.getMainWindow ? ZOT.getMainWindow() : null;
        return !!SV.prompt.confirm(win, title, msg);
      }
    } catch (e) { /* 回落 */ }
    try { return !!window.confirm(msg); } catch (e2) { return false; }
  }

  /* ================= 解锁 / 锁定 ================= */

  function resetHideTimer() {
    if (S.hideTimer) { clearTimeout(S.hideTimer); S.hideTimer = null; }
    if (!S.unlocked) return;
    const sec = V.autoHideSec();
    if (!sec) return;
    S.hideTimer = setTimeout(() => {
      lockNow(T("已自动锁定（长时间无操作）", "Auto-locked after inactivity"));
    }, sec * 1000);
  }

  function lockNow(reason) {
    if (!S.unlocked) return;
    S.unlocked = false;
    S.editId = "";
    S.pending = "";
    if (S.hideTimer) { clearTimeout(S.hideTimer); S.hideTimer = null; }
    try { V.journal("lock", "", ""); } catch (e) { /* ignore */ }
    renderAll();
    if (reason) setMsg(reason);
  }

  /** 「解锁查看」按钮：有口令 → 口令条；无口令 → 窗口内二次确认条 */
  function beginUnlock() {
    const now = Date.now();
    if (S.lockUntil && now < S.lockUntil) {
      setMsg(T("尝试过于频繁，请 " + Math.ceil((S.lockUntil - now) / 1000) + " 秒后再试",
        "Too many attempts, wait a moment"), "err");
      return;
    }
    S.pending = V.hasPasscode() ? "pass" : "confirm";
    renderMain();
  }

  function doUnlock(pass) {
    if (V.hasPasscode()) {
      const r = V.verifyPasscode(String(pass || ""));
      if (!r.ok) {
        S.failCount++;
        if (S.failCount >= 3) {
          S.lockUntil = Date.now() + 30000;
          S.failCount = 0;
          setMsg(T("口令连续错误 3 次，已冻结 30 秒", "Too many wrong attempts; locked for 30s"), "err");
        } else {
          setMsg(T("口令不正确（还可尝试 " + (3 - S.failCount) + " 次）", "Wrong passcode"), "err");
        }
        renderMain();
        return;
      }
      S.failCount = 0;
    }
    S.unlocked = true;
    S.pending = "";
    if (S.pendingEditId) { S.editId = S.pendingEditId; S.pendingEditId = ""; }
    V.journal("unlock", "", "");
    renderAll();
    resetHideTimer();
    const sec = V.autoHideSec();
    setMsg(sec ? T("已解锁 · " + sec + " 秒无操作自动锁定", "Unlocked · auto-locks after " + sec + "s")
      : T("已解锁 · 手动锁定", "Unlocked · lock manually"), "ok");
  }

  /* ================= 渲染 ================= */

  function renderHeader() {
    const acc = V.access();
    const plan = $("v-plan");
    const lock = $("v-lock");
    if (plan) {
      plan.textContent = acc.pro ? "PRO" : (acc.loggedIn ? String(acc.plan || "FREE").toUpperCase() : T("未登录", "SIGNED OUT"));
      plan.className = "v-badge" + (acc.pro ? " v-badge-pro" : "");
    }
    if (lock) {
      const isLocked = !S.unlocked;
      lock.textContent = isLocked ? T("已锁定", "Locked") : T("已解锁", "Unlocked");
      lock.className = "v-badge " + (isLocked ? "v-badge-lock" : "v-badge-open");
    }
    const btn = $("v-unlock");
    if (btn) {
      btn.textContent = S.unlocked ? T("立即锁定", "Lock now") : T("解锁查看", "Unlock");
      btn.disabled = !acc.pro;
    }
    const hs = $("v-host-state");
    if (hs) {
      hs.textContent = !acc.loggedIn ? T("账号托管：需登录 Papilot 账号", "Hosting: sign in required")
        : (V.hostedReady() ? T("账号托管：可用（AES-256-GCM 加密）", "Hosting: available (AES-256-GCM)")
          : T("账号托管：服务端未开通", "Hosting: unavailable"));
    }
  }

  function renderNav() {
    const nav = $("v-nav");
    if (!nav) return;
    clear(nav);
    const all = V.items();
    const rows = [
      { id: "overview", icon: "🔑", title: T("全部凭据", "All credentials"),
        count: all.filter((x) => x.configured).length + "/" + all.length },
    ];
    for (const g of V.GROUPS) {
      const items = all.filter((x) => x.group === g.id);
      rows.push({ id: g.id, icon: g.icon, title: g.title,
        count: items.filter((x) => x.configured).length + "/" + items.length });
    }
    rows.push({ id: "security", icon: "🛡", title: T("安全设置", "Security"), count: "" });
    rows.push({ id: "journal", icon: "🧾", title: T("访问记录", "Access log"), count: "" });

    for (const r of rows) {
      const n = el("div", "v-nav-item" + (S.active === r.id ? " is-active" : ""));
      n.appendChild(el("span", "", r.icon));
      n.appendChild(el("span", "", r.title));
      if (r.count) n.appendChild(el("span", "v-nav-count", r.count));
      n.addEventListener("click", () => {
        S.active = r.id;
        renderNav();
        renderMain();
      });
      nav.appendChild(n);
    }
  }

  function section(icon, title, desc) {
    const sec = el("div", "v-sec");
    const head = el("div", "v-sec-head");
    head.appendChild(el("span", "v-sec-icon", icon));
    const wrap = el("div", "");
    wrap.appendChild(el("div", "v-sec-title", title));
    if (desc) wrap.appendChild(el("div", "v-sec-desc", desc));
    head.appendChild(wrap);
    sec.appendChild(head);
    const body = el("div", "v-sec-body");
    sec.appendChild(body);
    return { sec, body };
  }

  function stateChip(item) {
    if (item.noKey) return { text: T("免密钥", "No key"), cls: "v-chip" };
    if (item.hostedOnly) {
      return { text: item.configured ? T("仅托管", "Hosted only") : T("仅托管 · 待取回", "Hosted · pending"),
        cls: "v-chip v-chip-host" };
    }
    if (!item.configured) return { text: T("未配置", "Not set"), cls: "v-chip" };
    return { text: T("已配置", "Set"), cls: "v-chip v-chip-on" };
  }

  function hostedChip(item) {
    if (!item.hosted) return null;
    const rec = S.hosted[item.hosted];
    if (!rec || !rec.set) return null;
    const c = el("span", "v-chip v-chip-host", T("已托管", "Hosted"));
    let title = T("账号里的副本：", "Hosted copy: ") + (rec.hint || "***");
    if (rec.updatedAt) title += " · " + fmtTime(Date.parse(rec.updatedAt) || 0);
    c.setAttribute("title", title);
    return c;
  }

  function valueNode(item) {
    if (item.noKey) return el("span", "v-val v-val-empty", T("本地接口无需密钥", "Local endpoint, no key needed"));
    if (!item.configured) {
      if (item.hostedOnly) {
        const st = V.hydrateState(item.id);
        return el("span", "v-val v-val-empty", st === "pending"
          ? T("仅托管 · 正在从账号取回…", "Hosted only · restoring…")
          : T("仅托管 · 需要登录并联网才能取回", "Hosted only · sign in + online to restore"));
      }
      return el("span", "v-val v-val-empty", T("尚未填写", "Not set"));
    }
    const show = S.unlocked ? String(item.value || "") : V.mask(item.value);
    return el("span", "v-val", show);
  }

  function rowEl(item) {
    const row = el("div", "v-row");
    const main = el("div", "v-row-main");
    const top = el("div", "v-row-top");
    top.appendChild(el("span", "v-row-label", item.label));
    const chip = stateChip(item);
    top.appendChild(el("span", chip.cls, chip.text));
    const hc = hostedChip(item);
    if (hc) top.appendChild(hc);
    main.appendChild(top);
    if (item.hint) main.appendChild(el("div", "v-row-hint", item.hint));

    if (S.editId === item.id) {
      const box = el("div", "v-edit");
      const input = el("input", "v-input");
      input.setAttribute("type", "text");
      input.setAttribute("no-native", "true");
      input.setAttribute("placeholder", item.placeholder || "");
      input.value = String(item.value || "");
      const save = el("button", "v-btn v-btn-primary v-btn-sm", T("保存", "Save"));
      const cancel = el("button", "v-btn v-btn-sm", T("取消", "Cancel"));
      save.addEventListener("click", () => saveEdit(item, input.value));
      cancel.addEventListener("click", () => { S.editId = ""; renderMain(); });
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") saveEdit(item, input.value);
        if (ev.key === "Escape") { S.editId = ""; renderMain(); }
      });
      box.appendChild(input);
      box.appendChild(save);
      box.appendChild(cancel);
      main.appendChild(box);
      setTimeout(() => { try { input.focus(); } catch (e) { /* ignore */ } }, 0);
    } else {
      const val = valueNode(item);
      if (item.dynamic && item.baseUrl) val.setAttribute("title", item.baseUrl);
      main.appendChild(val);
    }
    row.appendChild(main);

    const act = el("div", "v-row-act");
    if (item.noKey) {
      const b = el("button", "v-btn v-btn-sm", T("无需密钥", "No key"));
      b.disabled = true;
      act.appendChild(b);
    } else if (S.editId !== item.id) {
      const edit = el("button", "v-btn v-btn-sm", T("编辑", "Edit"));
      edit.addEventListener("click", () => {
        if (!S.unlocked) { S.pendingEditId = item.id; beginUnlock(); return; }
        S.editId = item.id;
        resetHideTimer();
        renderMain();
      });
      act.appendChild(edit);
      if (item.configured) {
        const clr = el("button", "v-btn v-btn-sm v-btn-danger", T("清除", "Clear"));
        clr.addEventListener("click", () => {
          if (!S.unlocked) { beginUnlock(); return; }
          clearItem(item);
        });
        act.appendChild(clr);
      }
      if (item.hosted && V.hostedReady()) {
        if (item.configured) {
          const up = el("button", "v-btn v-btn-sm", T("存到账号", "Save to account"));
          up.addEventListener("click", () => hostUp(item));
          act.appendChild(up);
        }
        const rec = S.hosted[item.hosted];
        if (rec && rec.set) {
          const down = el("button", "v-btn v-btn-sm", T("从账号取回", "Restore"));
          down.addEventListener("click", () => hostDown(item));
          act.appendChild(down);
        }
        if (item.secret && !item.dynamic) {
          const only = el("button", "v-btn v-btn-sm",
            item.hostedOnly ? T("取消仅托管", "Store locally") : T("仅托管", "Host only"));
          only.addEventListener("click", () => toggleHostedOnly(item));
          act.appendChild(only);
        }
      }
    }
    row.appendChild(act);
    return row;
  }

  function visibleItems(groupId) {
    const q = S.q.trim().toLowerCase();
    return V.items().filter((it) => {
      if (groupId && it.group !== groupId) return false;
      if (!q) return true;
      return (it.label + " " + (it.hint || "") + " " + (it.group || "")).toLowerCase().indexOf(q) >= 0;
    });
  }

  /** 解锁条：口令模式 / 二次确认模式 / 未开始（只给入口） */
  function renderUnlockBar(container) {
    const acc = V.access();
    if (!acc.pro) return;
    const s = section("🔓", S.pending === "pass" ? T("输入访问口令", "Enter passcode")
      : (S.pending === "confirm" ? T("确认解锁", "Confirm unlock") : T("解锁查看", "Unlock")), "");
    const body = s.body;

    if (S.pending === "confirm") {
      body.appendChild(el("div", "v-row-hint",
        T("解锁后将在此窗口显示全部凭据明文，任何看到屏幕的人都能看到。"
          + "建议在「安全设置」里设置访问口令，并保持自动隐藏开启。",
          "All secrets will be visible in plain text. Consider setting a passcode.")));
      const row = el("div", "v-edit");
      const go = el("button", "v-btn v-btn-primary v-btn-sm", T("确认解锁", "Unlock"));
      go.addEventListener("click", () => doUnlock(""));
      const cancel = el("button", "v-btn v-btn-sm", T("取消", "Cancel"));
      cancel.addEventListener("click", () => { S.pending = ""; renderMain(); });
      row.appendChild(go); row.appendChild(cancel);
      body.appendChild(row);
      container.appendChild(s.sec);
      return;
    }

    if (S.pending === "pass") {
      body.appendChild(el("div", "v-row-hint",
        T("解锁后 " + (V.autoHideSec() ? V.autoHideSec() + " 秒" : "直到手动锁定") + "无操作会自动重新锁定。",
          "Auto-locks after " + (V.autoHideSec() || "manual lock") + "s.")));
      const row = el("div", "v-edit");
      const input = el("input", "v-input");
      input.setAttribute("type", "password");
      input.setAttribute("no-native", "true");
      input.setAttribute("placeholder", T("访问口令", "Passcode"));
      const go = el("button", "v-btn v-btn-primary v-btn-sm", T("解锁", "Unlock"));
      go.addEventListener("click", () => doUnlock(input.value));
      input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") doUnlock(input.value); });
      const cancel = el("button", "v-btn v-btn-sm", T("取消", "Cancel"));
      cancel.addEventListener("click", () => { S.pending = ""; renderMain(); });
      row.appendChild(input); row.appendChild(go); row.appendChild(cancel);
      body.appendChild(row);
      container.appendChild(s.sec);
      setTimeout(() => { try { input.focus(); } catch (e) { /* ignore */ } }, 0);
      return;
    }

    body.appendChild(el("div", "v-row-hint",
      T("当前为锁定状态：条目名称与配置状态可见，值全部脱敏。",
        "Locked: names and status are visible, values are masked.")));
    const row = el("div", "v-edit");
    const go = el("button", "v-btn v-btn-primary v-btn-sm", T("解锁查看", "Unlock"));
    go.addEventListener("click", () => beginUnlock());
    row.appendChild(go);
    body.appendChild(row);
    container.appendChild(s.sec);
  }

  function renderLockCard(container) {
    const box = el("div", "v-lock");
    box.appendChild(el("div", "v-lock-icon", "🔒"));
    const acc = V.access();
    box.appendChild(el("div", "v-lock-title", acc.loggedIn
      ? T("账号与密钥中心需要专业版", "Credential center requires Pro")
      : T("登录或注册后使用账号与密钥中心", "Sign in or register to manage credentials")));
    box.appendChild(el("div", "v-lock-text",
      T("把第三方服务的账号与密钥收在一处，避免散落在各个设置卡里：",
        "Keep third-party credentials in one place:")));
    const list = el("div", "v-lock-list");
    for (const g of V.GROUPS) list.appendChild(el("div", "", g.icon + " · " + g.title));
    box.appendChild(list);
    box.appendChild(el("div", "v-lock-text",
      T("专业版会员可用：脱敏查看、按需解锁、加密托管到你自己的账号（换机一键取回）、本地访问审计。",
        "Pro unlocks masked viewing, on-demand reveal, encrypted hosting in your own account, and a local access log.")));
    const acts = el("div", "v-lock-actions");
    const b = el("button", "v-btn v-btn-primary", acc.loggedIn
      ? T("升级专业版", "Upgrade to Pro") : T("去登录 / 注册", "Sign in / Register"));
    b.addEventListener("click", () => openSettings("account"));
    acts.appendChild(b);
    box.appendChild(acts);
    // 价格锚点：服务端价格表有数就显示「¥X 起」，比空喊「升级」有效
    if (acc.loggedIn) {
      const priceEl = el("div", "v-lock-text", "");
      box.appendChild(priceEl);
      try {
        const A = PP && PP.account;
        if (A && typeof A.plans === "function") {
          A.plans().then((p) => {
            const opts = ((p && p.priceOptions) || []).filter((o) => Number(o.price) > 0);
            if (!opts.length) return;
            opts.sort((x, y) => Number(x.price) - Number(y.price));
            const m = opts[0];
            priceEl.textContent = T("专业版 ¥" + m.price + " 起（" + (m.label || m.months + " 个月") + "）",
              "Pro from ¥" + m.price + " (" + (m.label || m.months + " mo") + ")");
          }).catch(() => { /* 价格拉不到就不显示，绝不编造 */ });
        }
      } catch (e) { /* ignore */ }
    }
    container.appendChild(box);
  }

  function renderSections(container) {
    if (!S.unlocked) renderUnlockBar(container);

    if (S.active === "security") return renderSecurity(container);
    if (S.active === "journal") return renderJournal(container);

    const groups = S.active === "overview" ? V.GROUPS : V.GROUPS.filter((g) => g.id === S.active);
    let shown = 0;
    for (const g of groups) {
      const items = visibleItems(g.id);
      if (!items.length && S.q) continue;
      if (!items.length) {
        const empty = section(g.icon, g.title, g.desc);
        empty.body.appendChild(el("div", "v-empty", g.id === "ai"
          ? T("还没有自定义 AI 通道。到「设置 → AI 模型通道」添加后，这里会自动列出每个通道的 Key。",
            "No custom AI channels yet. Add one in Settings → AI channels.")
          : T("没有条目。", "No entries.")));
        container.appendChild(empty.sec);
        continue;
      }
      const s = section(g.icon, g.title, g.desc);
      for (const it of items) { s.body.appendChild(rowEl(it)); shown++; }
      container.appendChild(s.sec);
    }
    if (!shown && S.q) container.appendChild(el("div", "v-empty", T("没有匹配的条目", "No matching entries")));
  }

  function renderSecurity(container) {
    const has = V.hasPasscode();
    const s1 = section("🛡", T("访问口令", "Access passcode"),
      T("口令只用来「解锁查看明文」，不是加密密钥；忘记后可本机重置（不影响已保存的凭据）。",
        "The passcode gates reveal only; it is not a decryption key."));
    s1.body.appendChild(el("div", "v-row-hint",
      has ? T("当前：已设置访问口令", "Current: passcode set")
        : T("当前：未设置（解锁需二次确认）", "Current: none (confirm to unlock)")));

    const wrap = el("div", "v-edit");
    wrap.style.flexWrap = "wrap";
    if (has) {
      const oldI = el("input", "v-input v-input-num");
      oldI.setAttribute("type", "password");
      oldI.setAttribute("no-native", "true");
      oldI.setAttribute("placeholder", T("当前口令", "Current passcode"));
      oldI.id = "v-pass-old";
      wrap.appendChild(oldI);
    }
    const p1 = el("input", "v-input v-input-num");
    p1.setAttribute("type", "password");
    p1.setAttribute("no-native", "true");
    p1.setAttribute("placeholder", T("新口令（≥4 位）", "New passcode (4+)"));
    p1.id = "v-pass-new";
    const p2 = el("input", "v-input v-input-num");
    p2.setAttribute("type", "password");
    p2.setAttribute("no-native", "true");
    p2.setAttribute("placeholder", T("再输一次", "Repeat"));
    p2.id = "v-pass-new2";
    const save = el("button", "v-btn v-btn-primary v-btn-sm", has ? T("修改口令", "Change") : T("设置口令", "Set"));
    save.addEventListener("click", () => {
      if (has) {
        const oldI = $("v-pass-old");
        const r = V.verifyPasscode(oldI ? oldI.value : "");
        if (!r.ok) { setMsg(T("当前口令不正确", "Current passcode is wrong"), "err"); return; }
      }
      const a = $("v-pass-new");
      const b = $("v-pass-new2");
      const v1 = a ? a.value : "";
      const v2 = b ? b.value : "";
      if (!v1 || v1 !== v2) { setMsg(T("两次输入不一致", "Passcodes do not match"), "err"); return; }
      const r = V.setPasscode(v1);
      if (!r.ok) { setMsg(r.error, "err"); return; }
      setMsg(T("已保存访问口令", "Passcode saved"), "ok");
      renderAll();
    });
    wrap.appendChild(p1); wrap.appendChild(p2); wrap.appendChild(save);
    if (has) {
      const rm = el("button", "v-btn v-btn-sm v-btn-danger", T("清除口令", "Remove"));
      rm.addEventListener("click", () => {
        const oldI = $("v-pass-old");
        const r = V.clearPasscode(oldI ? oldI.value : "");
        if (!r.ok) { setMsg(r.error, "err"); return; }
        setMsg(T("已清除访问口令", "Passcode removed"), "ok");
        renderAll();
      });
      wrap.appendChild(rm);
    }
    s1.body.appendChild(wrap);
    container.appendChild(s1.sec);

    const s2 = section("⏱", T("自动隐藏", "Auto-hide"),
      T("解锁后无操作超过该时长即重新锁定，明文同时从窗口移除。", "Re-lock after inactivity."));
    const row2 = el("div", "v-edit");
    const sel = el("select", "v-select");
    sel.setAttribute("no-native", "true");
    sel.id = "v-autohide";
    for (const opt of [[15, T("15 秒", "15s")], [30, T("30 秒", "30s")],
      [60, T("60 秒", "60s")], [0, T("不自动隐藏", "Never")]]) {
      const o = document.createElementNS(XHTML, "option");
      o.setAttribute("value", String(opt[0]));
      o.textContent = opt[1];
      if (Number(V.autoHideSec()) === opt[0]) o.setAttribute("selected", "selected");
      sel.appendChild(o);
    }
    const apply = el("button", "v-btn v-btn-sm", T("保存", "Save"));
    apply.addEventListener("click", () => {
      const n = Number(sel.value);
      try {
        ZOT.Prefs.set("extensions.zotero.papilot.vaultAutoHideSec", isFinite(n) ? n : 30, true);
      } catch (e) { /* ignore */ }
      setMsg(T("已更新自动隐藏时长", "Auto-hide updated"), "ok");
      resetHideTimer();
    });
    row2.appendChild(sel); row2.appendChild(apply);
    s2.body.appendChild(row2);
    container.appendChild(s2.sec);

    const s3 = section("🗄", T("存储位置", "Storage"),
      T("了解每一层保护边界，比一个「已加密」标签更有用。", "Know where each layer lives."));
    const lines = [
      T("本机：Zotero 配置目录（profile）。敏感值做混淆存放，防随手翻看 prefs，但不是加密——系统账户权限才是这一层的主要保护。",
        "Local: Zotero profile. Values are obfuscated, not encrypted."),
      T("账号托管：点「存到账号」后，值由服务端 AES-256-GCM 加密落盘（主密钥不进备份），列表只回掩码；换机/重装可一键取回。",
        "Account hosting: AES-256-GCM on the server; lists return masks only."),
      T("永不出本机：访问口令、访问记录、明文都不会进入云同步快照或任何导出文件。",
        "Never leaves the machine: passcode, access log, plaintext."),
      T("仅托管（可选，逐项开）：值只存账号密文，本机 pref 清空，运行时只放进内存。"
        + "代价是离线或未登录 Papilot 账号时该项不可用——所以默认关闭，由你逐项决定。",
        "Host-only (opt-in per item): the value lives only as server ciphertext; "
        + "the local pref is cleared and the value is hydrated into memory at runtime."),
    ];
    for (const l of lines) s3.body.appendChild(el("div", "v-row-hint", "· " + l));
    container.appendChild(s3.sec);
  }

  function renderJournal(container) {
    const s = section("🧾", T("访问记录", "Access log"),
      T("只记动作与时间，不记任何值；最多保留 40 条，只在本机。", "Actions and timestamps only."));
    const list = V.recentJournal();
    if (!list.length) {
      s.body.appendChild(el("div", "v-empty", T("暂无记录", "No entries yet")));
    } else {
      const box = el("div", "v-log");
      for (const r of list.slice(0, 20)) {
        const line = el("div", "v-log-row");
        line.appendChild(el("span", "v-log-time", fmtTime(r.t)));
        line.appendChild(el("span", "v-log-act", ACT_LABEL[r.a] || r.a || "-"));
        line.appendChild(el("span", "v-log-note", r.n || r.id || ""));
        box.appendChild(line);
      }
      s.body.appendChild(box);
      const btn = el("button", "v-btn v-btn-sm v-btn-danger", T("清空记录", "Clear log"));
      btn.addEventListener("click", () => { V.clearJournal(); renderMain(); });
      s.body.appendChild(btn);
    }
    container.appendChild(s.sec);
  }

  function renderMain() {
    const main = $("v-main");
    if (!main) return;
    clear(main);
    if (!V) {
      main.appendChild(el("div", "v-empty", T("核心模块未加载，请重启 Zotero 后再试。", "Core module not loaded.")));
      return;
    }
    const acc = V.access();
    if (!acc.pro) { renderLockCard(main); return; }
    renderSections(main);
  }

  function renderAll() {
    renderHeader();
    renderNav();
    renderMain();
  }

  /* ================= 操作 ================= */

  function saveEdit(item, value) {
    const r = V.set(item.id, String(value || ""));
    if (!r.ok) { setMsg(r.error || T("保存失败", "Save failed"), "err"); return; }
    S.editId = "";
    resetHideTimer();
    setMsg(r.cleared ? T("已清除该项", "Cleared")
      : T("已保存 · 立即生效（各功能读到的就是这份值）", "Saved — effective immediately"), "ok");
    renderAll();
  }

  function clearItem(item) {
    const ok = confirmDlg(T("清除凭据", "Clear"),
      T("确定清除「" + item.label + "」？\n\n会立即影响依赖它的功能（例如知网登录、云同步）。",
        "Clear \"" + item.label + "\"?"));
    if (!ok) return;
    const r = V.set(item.id, "");
    setMsg(r.ok ? T("已清除", "Cleared") : (r.error || "失败"), r.ok ? "ok" : "err");
    renderAll();
  }

  async function hostUp(item) {
    if (S.busy) return;
    S.busy = true;
    setMsg(T("正在加密保存到账号…", "Saving to your account…"));
    const r = await V.uploadHosted(item.id);
    S.busy = false;
    if (!r.ok) { setMsg(r.error, "err"); return; }
    setMsg(T("已加密保存到你的账号（换机可取回）", "Encrypted copy saved to your account"), "ok");
    await refreshHosted();
    renderAll();
  }

  async function hostDown(item) {
    if (S.busy) return;
    const ok = confirmDlg(T("从账号取回", "Restore"),
      T("将用账号里的副本覆盖本机当前的「" + item.label + "」。\n\n（AI 通道 Key 例外：只填空缺，不覆盖已有通道）\n\n继续？",
        "This will overwrite the local value with the hosted copy.\n\nContinue?"));
    if (!ok) return;
    S.busy = true;
    setMsg(T("正在从账号取回…", "Restoring…"));
    const r = await V.downloadHosted(item.id);
    S.busy = false;
    if (!r.ok) { setMsg(r.error, "err"); return; }
    if (r.warning) { setMsg(r.warning, "err"); renderAll(); return; }
    setMsg(r.filled ? T("已填充 " + r.filled + " 个通道的密钥", "Restored " + r.filled + " channel key(s)")
      : T("已取回并覆盖本机值", "Restored"), "ok");
    renderAll();
  }

  async function toggleHostedOnly(item) {
    if (S.busy) return;
    const on = !item.hostedOnly;
    if (on) {
      const ok = confirmDlg(T("改为仅托管", "Host only"),
        T("「" + item.label + "」将只保存在你的账号里（服务端 AES-256-GCM 加密），本机不再留值。\n\n" 
          + "代价：离线或未登录 Papilot 账号时，依赖它的功能不可用（会给出明确提示）。\n\n确认开启？",
          "The value will only live in your account. Offline / signed-out means the feature is unavailable.\n\nContinue?"));
      if (!ok) return;
    }
    S.busy = true;
    setMsg(on ? T("正在上传并清理本机值…", "Uploading…") : T("正在写回本机…", "Restoring to this machine…"));
    const r = await V.setHostedOnly(item.id, on);
    S.busy = false;
    if (!r.ok) { setMsg(r.error || T("操作失败", "Failed"), "err"); return; }
    setMsg(on ? T("已改为仅托管：本机值已清空，值只在你账号的密文里",
      "Now hosted-only: the local copy is gone")
      : T("已恢复本机存储", "Stored locally again"), "ok");
    await refreshHosted();
    renderAll();
  }

  async function refreshHosted() {
    if (!V.hostedReady()) { S.hosted = {}; return; }
    S.hosted = await V.hostedStatus();
  }

  function openSettings(focus) {
    try {
      if (PP) PP._prefsFocus = focus || "";
      PP.menus.openSettings();
    } catch (e) { /* ignore */ }
  }

  /* ================= 启动 ================= */

  function bindToolbar() {
    const unlock = $("v-unlock");
    if (unlock) unlock.addEventListener("click", () => {
      if (!V) return;
      if (S.unlocked) { lockNow(T("已锁定", "Locked")); return; }
      beginUnlock();
    });
    const refresh = $("v-refresh");
    if (refresh) refresh.addEventListener("click", async () => {
      if (!V) return;
      await refreshHosted();
      renderAll();
      setMsg(T("已刷新", "Refreshed"), "ok");
    });
    const q = $("v-search");
    if (q) {
      q.setAttribute("no-native", "true");
      q.addEventListener("input", (ev) => {
        S.q = (ev && ev.target && ev.target.value) || "";
        renderMain();
      });
    }
    const main = $("v-main");
    if (main) main.addEventListener("click", () => { if (S.unlocked) resetHideTimer(); });
    // 设置里新增/删除 AI 通道后，本窗口的条目要跟着变（否则用户以为没刷出来）
    try {
      if (ZOT && ZOT.Prefs && ZOT.Prefs.registerObserver) {
        S.prefObs = ZOT.Prefs.registerObserver("extensions.zotero.papilot.aiChannels", () => {
          if (S.editId) return;   // 正在编辑时不要打断（会吞掉用户输入）
          renderAll();
        });
      }
    } catch (e) { /* 观察者注册失败不影响主流程 */ }
  }

  async function boot() {
    try {
      const args = (window.arguments && window.arguments[0]) || {};
      const Z = args.Zotero || window.Zotero;
      SV = args.Services || window.Services || null;
      ZOT = Z || null;
      PP = Z && Z.Papilot;
      if (Z && Z.locale) zh = String(Z.locale).toLowerCase().indexOf("zh") === 0;
      if (!PP) { renderFatal(T("Papilot 未就绪，请重开窗口。", "Papilot not ready.")); return; }
      V = PP.credVault;
      if (!V) {
        renderFatal(T("账号与密钥模块未加载（可能被旧版本缓存）。请重启 Zotero 后再试。",
          "Credential module not loaded. Restart Zotero."));
        return;
      }
      bindToolbar();
      V.journal("open", "", "");
      // 先渲染（全部数据都在本地 pref 里，零等待），再异步补「账号托管」状态。
      // ⚠️ 不能反过来 await：hostedSecrets 是网络请求，离线/服务慢时窗口会空白十几秒，
      // 用户会以为坏了（0.66.0 真机自检实测：3 秒时窗口仍是一片空白）。
      renderAll();
      refreshHosted().then(() => { renderAll(); }).catch(() => { /* 托管状态拿不到不影响凭据查看 */ });
    } catch (e) {
      try { Zotero.logError(e); } catch (e2) { /* ignore */ }
      const msg = T("初始化失败：", "Init failed: ") + (e && e.message || e);
      renderFatal(msg);
      // 同时写进工具栏状态位：窗口里的异常在 Zotero 控制台之外没有任何可见出口
      try { setMsg(msg, "err"); } catch (e3) { /* ignore */ }
    }
  }

  function renderFatal(msg) {
    const main = $("v-main");
    if (!main) return;
    clear(main);
    main.appendChild(el("div", "v-empty", msg));
  }

  window.addEventListener("unload", () => {
    if (S.hideTimer) clearTimeout(S.hideTimer);
    try {
      if (S.prefObs && ZOT && ZOT.Prefs && ZOT.Prefs.unregisterObserver) {
        ZOT.Prefs.unregisterObserver(S.prefObs);
      }
    } catch (e) { /* ignore */ }
    S.prefObs = null;
  });

  /* 供测试与排障：纯逻辑锚点（不触碰 DOM） */
  window.PPVaultUI = {
    ACT_LABEL,
    chipText: (item) => stateChip(item).text,
    isLocked: () => !S.unlocked,
  };

  if (document.readyState === "complete" || document.readyState === "interactive") {
    boot();
  } else {
    window.addEventListener("DOMContentLoaded", boot, { once: true });
  }
})();
