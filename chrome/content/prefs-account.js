// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 设置窗格脚本·账号与模型通道（0.14.0 新增；0.15.0 随设置界面重构改版）
 * 与 prefs-pane.js 同窗格运行；经 Zotero.Papilot.account / .channels 访问
 * bootstrap 作用域的 Account / Channels 模块。
 * 交互逻辑移植自「AI 带教中心」模型通道面板：状态卡 + 通道行（切换/测试连接/参数/删除）
 * + 新增/编辑表单（厂商预设自动填充、密钥检测、上游拉取模型、模型 chips、extraBody）。
 * 0.15.0：动态元素改用 prefs.xhtml 内 <html:style> 的 .pp-* 类（随系统明暗主题）；
 * 语义色经 CSS 变量引用（var(--pp-success) 等，定义于 .pp-root 作用域）。
 * 0.72.2 无障碍：付款弹窗 Esc/focus trap/真关闭钮；通道测试反馈行内化
 */
/* global Zotero, window, document, Components */

(function () {
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const SVG_NS = "http://www.w3.org/2000/svg";
  const zh = (Zotero.locale || "").toLowerCase().startsWith("zh");
  const $ = (id) => document.getElementById(id);
  const PP = () => Zotero.Papilot || {};
  const account = () => PP().account;
  const channels = () => PP().channels;

  const el = (tag, attrs, text) => {
    const node = document.createElementNS(HTML_NS, tag);
    if (attrs) for (const k of Object.keys(attrs)) node.setAttribute(k, attrs[k]);
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const fmtDate = (ms) => {
    try { return new Date(ms).toLocaleString(zh ? "zh-CN" : "en-US", { dateStyle: "medium", timeStyle: "short" }); }
    catch (e) { return new Date(ms).toLocaleString(); }
  };

  /** 服务端时间字段（ISO 字符串或毫秒）→ 本地可读时间；解析不了就原样显示 */
  const fmtAt = (v) => {
    const ms = typeof v === "number" ? v : Date.parse(v);
    if (!Number.isFinite(ms)) return String(v == null ? "" : v);
    return fmtDate(ms);
  };

  /* ---------- 敏感信息掩码（0.14.7；0.43.2 升级完全隐藏）：接口地址**永远**掩码 ----------
   * 防窥屏常开：账号服务器地址与 AI 通道 baseUrl 一律完整隐藏主机名（不再提供
   * 「显示完整地址」出口——排查连接问题看「连接测试」结果即可，不需要看明文）。 */

  const PREF_PREFIX = "extensions.zotero.papilot.";

  /**
   * URL 掩码（完全隐藏）：主机名整体打码，只保留协议形状、端口与路径分段
   * （协议/端口/路径不含厂商与私有域名信息）。本机地址（127.0.0.1/localhost）原样。
   */
  function maskUrl(u) {
    const s = String(u || "");
    if (!s) return "—";
    if (/^(https?:\/\/)?(127\.0\.0\.1|localhost|\[::1\])/.test(s)) return s;
    const m = s.match(/^(https?:\/\/)?([^/:]+)(:\d+)?(\/.*)?$/);
    if (!m) return "***";
    const scheme = m[1] || "", port = m[3] || "", path = m[4] || "";
    // 主机名完全隐藏：不同长度一律同样式，防长度侧信道
    return scheme + "***.***.***" + port + path;
  }

  /** 展示用地址：恒掩码（防窥屏没有明文出口） */
  function displayUrl(u) {
    return maskUrl(u || "—");
  }

  /**
   * 展示用邮箱：默认脱敏（0.68.3）。
   *
   * 为什么：设置面板是最容易被截图/投屏/录屏的界面，账号邮箱属于身份信息，
   * 不该在默认视图里明文出现（旧实现还把没填昵称的用户名直接显示成邮箱，
   * 一屏出现两次）。这里保留「首 2 字 + *** + 域名」，既认得出是哪个号，
   * 又不泄露完整地址；点一下可临时显示完整地址（再点收起）。
   */
  let emailShown = false;

  function maskEmail(email) {
    const s = String(email || "").trim();
    if (!s) return "";
    const at = s.lastIndexOf("@");
    if (at <= 0) {
      // 不是标准邮箱（老数据可能只存了账号名）：只留首字符
      return s.length <= 1 ? "***" : s.charAt(0) + "***";
    }
    const local = s.slice(0, at);
    const domain = s.slice(at);
    const head = local.slice(0, Math.min(2, local.length));
    return head + "***" + domain;
  }

  function paintEmail(email) {
    const node = $("pp-account-email");
    if (!node) return;
    const full = String(email || "").trim();
    // 空邮箱时这个节点是「假可点」的：文本空着仍占一行，还带着虚线可点样式与
    // 「点击显示完整邮箱」的 title，用户点下去什么都不会发生。整块隐藏最干净。
    if (!full) {
      node.textContent = "";
      node.style.display = "none";
      try { node.removeAttribute("title"); } catch (e) { /* ignore */ }
      try { node.removeAttribute("aria-label"); } catch (e) { /* ignore */ }
      return;
    }
    node.style.display = "";
    node.textContent = emailShown ? full : maskEmail(full);
    node.setAttribute("title", emailShown ? "点击隐藏邮箱" : "点击显示完整邮箱");
    // 无障碍：不要把明文塞进 aria-label
    node.setAttribute("aria-label", emailShown ? full : "已隐藏的账号邮箱");
  }

  /* ==================== 账号区块 ==================== */

  function renderAccount() {
    const A = account();
    if (!A || !$("pp-login-view")) return;
    const loggedIn = A.isLoggedIn();
    $("pp-login-view").style.display = loggedIn ? "none" : "";
    // 登录成功时收起注册表单（会话变化回调也会走到这里）
    if (loggedIn) {
      const rv = $("pp-register-view");
      if (rv) rv.style.display = "none";
    }
    $("pp-account-view").style.display = loggedIn ? "" : "none";
    if (!loggedIn) {
      $("pp-login-password").value = "";
      syncCpw();           // 未登录：改密入口收起
      renderAiTierNote();
      renderGrantCopy();   // 登录提示句在登录视图上，未登录也要保持刷新
      return;
    }
    const u = A.user() || {};
    const email = String(u.email || "").trim();
    // 服务端 userForClient() 会拿 email 回填 name（server/account-server.js: `name: user.nickname || user.email`），
    // 所以「昵称为空的账号，u.name 本身就是完整邮箱」——直接显示会让加粗标题上出现明文邮箱，
    // 把下面 paintEmail 的脱敏整个白做。含 @ 的一律不算昵称，统一显示「已登录用户」。
    const rawName = String(u.name || "").trim();
    const nick = rawName && rawName.indexOf("@") < 0 ? rawName : "";
    $("pp-account-name").textContent = nick || "已登录用户";
    paintEmail(email);
    // 头像首字母：昵称优先（中文昵称只有取昵称首字才认得出是谁），邮箱兜底。
    $("pp-account-badge").textContent =
      String(nick || email).trim().charAt(0).toUpperCase() || "P";
    const bits = [];
    if (u.plan) bits.push("套餐：" + u.plan);
    if (A.expiresAt()) bits.push("会话有效期至 " + fmtDate(A.expiresAt()));
    bits.push("服务器 " + displayUrl(A.serverUrl()).replace(/^https?:\/\//, ""));
    $("pp-account-meta").textContent = bits.join(" ｜ ");
    syncCpw();             // 已登录且服务端支持时才出现「修改密码」入口
    renderGrantCopy();     // R2：注册赠送/每月发放文案随 plans 下发
    fillOfficialModelSelect();
  }

  /**
   * 套餐 AI 能力的说明条（1.4.9）：试用剩余天数 / 需要升级的模型。
   * 这段文案是**转化引导**，所以必须同时说清「为什么不能用」和「怎么才能用」。
   */
  /**
   * 归一化 A.ai() 的返回值。**任何异常形状都当作「未知、不限制」**——
   * 旧服务端没有 ai 块、假实现返回 Promise、字段被人塞了字符串……
   * 这些都不能变成 `for…of` 上的 TypeError（那会变成未捕获的 Promise 拒绝，
   * 在 Zotero 里是控制台噪音，在测试里直接打挂进程）。
   */
  function aiTier() {
    const A = account();
    const UNKNOWN = { highTier: true, reason: "unknown", trial: null,
      models: [], lockedModels: [], defaultModel: "auto" };
    if (!A || typeof A.ai !== "function") return UNKNOWN;
    let raw = null;
    try { raw = A.ai(); } catch (e) { return UNKNOWN; }
    if (!raw || typeof raw !== "object") return UNKNOWN;
    return {
      highTier: !!raw.highTier,
      reason: raw.reason || "unknown",
      trial: (raw.trial && typeof raw.trial === "object") ? raw.trial : null,
      models: Array.isArray(raw.models) ? raw.models : [],
      lockedModels: Array.isArray(raw.lockedModels) ? raw.lockedModels : [],
      defaultModel: raw.defaultModel || "auto",
    };
  }

  function renderAiTierNote(note) {
    const box = $("pp-ai-tier-note");
    if (!box) return;
    const A = account();
    if (!A || !A.isLoggedIn()) { box.style.display = "none"; return; }
    const AI = aiTier();
    const parts = [];
    let cls = "pp-ai-tier";
    // 0.72.3：说明条里的 emoji 一律删字符改纯文字（文案本身已自解释，
    // 图标只是读屏噪音；改内联 SVG 会把这块 pre-wrap 文本切成 DOM 片段，不值当）
    if (AI.reason === "trial" && AI.trial && AI.trial.active) {
      cls += " pp-ai-tier-trial";
      parts.push("全模型试用中，剩 " + AI.trial.daysLeft + " 天（至 "
        + fmtDate(AI.trial.endsAt) + "）——当前可使用全部官方模型，到期后回到基础模型。");
    } else if (AI.reason === "none" && AI.lockedModels && AI.lockedModels.length) {
      const endedAt = AI.trial && AI.trial.endsAt;
      parts.push(AI.lockedModels.join("、") + " 属于高级模型，需要专业版"
        + (endedAt ? "（全模型试用已于 " + fmtDate(endedAt) + " 结束）" : "")
        + "。当前可用：" + (AI.models || []).join("、") + "。");
    }
    if (note) parts.push(note);
    if (!parts.length) { box.style.display = "none"; box.textContent = ""; return; }
    box.className = cls;
    box.style.display = "";
    box.textContent = parts.join(" ");
  }

  /**
   * 官方模型下拉（1.4.9 套餐分层）：
   *  - 可用模型以服务端 /v1/models 为准（**已按套餐过滤**），列表天然正确；
   *  - 需升级的模型以「（需专业版）」灰显追加在末尾——让用户**看见**自己缺什么，比藏起来更有转化力；
   *  - 当前保存的模型若已被锁（试用结束 / 套餐到期回落），**可见地**回落到默认并写明原因，
   *    **不静默改配置**（静默会让用户以为还在用原来那个模型）；
   *  - 旧服务端没有 ai 块（reason === "unknown"）→ 一律不做锁定与回落，避免把老服务端用户锁死。
   */
  async function fillOfficialModelSelect() {
    const A = account(), C = channels();
    const sel = $("pp-account-official-model");
    if (!A || !C || !sel || !A.isLoggedIn()) { renderAiTierNote(); return; }
    const AI = aiTier();
    const known = AI.reason !== "unknown";

    const paint = (allowed) => {
      if (!sel.parentNode) return ""; // 面板已关
      const ch = C.getChannel(C.OFFICIAL_ID);
      const cur = (ch && ch.model) || AI.defaultModel;
      // 已知可用集（新服务端）→ 以服务端为准；
      // 未知（旧服务端没有 ai 块）→ 用通道缓存，**绝不擅自缩小用户的选择**
      let list = (allowed && allowed.length) ? allowed.slice()
        : ((ch && Array.isArray(ch.models) && ch.models.length) ? ch.models.slice() : [AI.defaultModel]);
      if (list.indexOf(AI.defaultModel) < 0) list.unshift(AI.defaultModel);
      // 无从判断可用性时，当前选择必须留在列表里 —— 否则下拉会显示成别的模型，
      // 看起来像「配置被改了」，而实际没改（显示与配置不符最容易被当成 bug 报上来）
      if (!known && cur && list.indexOf(cur) < 0) list.unshift(cur);
      sel.innerHTML = "";
      for (const m of list) sel.appendChild(el("option", { value: m }, m));
      if (known) {
        for (const m of AI.lockedModels) {
          if (list.indexOf(m) >= 0) continue;
          // <option> 只渲染纯文本（SVG 在 option 里不显示）→ 用文字标记代替图标
          const o = el("option", { value: m }, m + "（需专业版）");
          o.style.color = "var(--pp-muted)";
          sel.appendChild(o);
        }
      }
      if (list.indexOf(cur) >= 0) { sel.value = cur; return ""; }
      if (!known) { sel.value = list[0]; return ""; }   // 无从判断 → 不动用户的配置
      try { C.upsert({ id: C.OFFICIAL_ID, model: AI.defaultModel }); } catch (e) { /* ignore */ }
      sel.value = AI.defaultModel;
      return "原选用的「" + cur + "」现在不可用，已回落到 " + AI.defaultModel + "。";
    };

    let note = paint(AI.models);
    renderAiTierNote(note);
    try {
      const r = await C.fetchModels({ baseUrl: A.gatewayUrl(), apiKey: A.token(), timeoutMs: 6000 });
      if (r.ok && r.models && r.models.length) {
        // 去重合并默认模型，写回通道 models 缓存（下次秒开）
        C.upsert({ id: C.OFFICIAL_ID,
          models: [AI.defaultModel].concat(r.models.filter((m) => m !== AI.defaultModel)) });
        note = paint(known && AI.models.length ? AI.models : r.models);
        renderAiTierNote(note);
      }
    } catch (e) { /* 拉取失败保持现列表 */ }
  }

  async function onLogin() {
    const A = account();
    const btn = $("pp-login-btn");
    if (!A || !btn) return;
    const email = $("pp-login-email").value.trim();
    const password = $("pp-login-password").value;
    const result = $("pp-login-result");
    if (!email || !password) {
      result.textContent = "请填写邮箱和密码";
      result.style.color = "var(--pp-danger)";
      return;
    }
    btn.disabled = true;
    result.textContent = "登录中…";
    result.style.color = "var(--pp-muted)";
    try {
      await A.login(email, password);
      result.textContent = "✓ 登录成功";
      result.style.color = "var(--pp-success)";
      $("pp-login-password").value = "";
      // 换账号 → 会员缓存与订单状态全部作废重来
      stopMbPolling();
      mbPlans = null;
      mbSel = null;
      mbOrder = null;
      resetEnhancements();   // R1/R4/R5/R8 的缓存与降级标记随账号作废
      OrderDlg.close();          // 0.49.0：旧账号的付款单不得留在屏幕上
      const payBox = $("pp-mb-pay");
      if (payBox) payBox.style.display = "none";
      renderAll(); // 通道状态（官方通道可用性）联动刷新
    } catch (e) {
      result.textContent = "✗ " + (e && e.message || "登录失败");
      result.style.color = "var(--pp-danger)";
    } finally {
      btn.disabled = false;
    }
  }

  async function onLogout() {
    const A = account();
    if (!A) return;
    const result = $("pp-account-result");
    result.textContent = "退出中…";
    result.style.color = "var(--pp-muted)";
    try { await A.logout(); } catch (e) { /* 本地登出不失败 */ }
    // 会员区随登录态清空：停轮询、丢订单、收下面板
    stopMbPolling();
    mbOrder = null;
    mbSel = null;
    resetEnhancements();     // R1/R4/R5/R8 的缓存与降级标记随登出作废
    OrderDlg.close();            // 0.49.0：登出后付款单不得残留
    const payBox = $("pp-mb-pay");
    if (payBox) payBox.style.display = "none";
    const orderBox = $("pp-mb-order");
    if (orderBox) orderBox.style.display = "none";
    result.textContent = "";
    // 登出即抹掉界面上的账号痕迹：登录框里残留的邮箱属于上一个人的身份信息
    // （共用机器 / 录屏场景下尤其不该留着），密码框本来就会清。
    emailShown = false;
    try {
      const mail = $("pp-login-email");
      if (mail) mail.value = "";
    } catch (e) { /* ignore */ }
    renderAll();
  }

  async function onRefreshAccount() {
    const A = account();
    const result = $("pp-account-result");
    if (!A) return;
    if (!A.isLoggedIn()) { renderAll(); return; }
    result.textContent = "刷新中…";
    result.style.color = "var(--pp-muted)";
    try {
      await A.refreshUser();
      result.textContent = "✓ 已刷新";
      result.style.color = "var(--pp-success)";
    } catch (e) {
      result.textContent = "✗ " + (e && e.message || "刷新失败");
      result.style.color = "var(--pp-danger)";
    }
    renderAccount();
  }

  /* ---------- 注册（0.20.0 内置界面：直接调服务端 /api/auth/register，不跳浏览器） ---------- */

  function showRegister(on) {
    const lv = $("pp-login-view");
    const rv = $("pp-register-view");
    if (!lv || !rv) return;
    lv.style.display = on ? "none" : "";
    rv.style.display = on ? "" : "none";
    if (!on) return;
    const res = $("pp-reg-result");
    if (res) res.textContent = "";
    const vr = $("pp-reg-verify-row");
    if (vr) vr.style.display = "none";
    // 已登录邮箱带过来，省一次输入
    const src = $("pp-login-email");
    const dst = $("pp-reg-email");
    if (src && dst && !dst.value) dst.value = src.value || "";
  }

  async function onRegister() {
    const A = account();
    const btn = $("pp-reg-btn");
    const result = $("pp-reg-result");
    if (!A || !btn || !result) return;
    const email = $("pp-reg-email").value.trim();
    const nickname = $("pp-reg-nickname").value.trim();
    const pw = $("pp-reg-password").value;
    const pw2 = $("pp-reg-password2").value;
    const setMsg = (t, ok) => {
      result.textContent = t;
      result.style.color = ok ? "var(--pp-success)" : "var(--pp-danger)";
    };
    if (!email || !pw) return setMsg("请填写邮箱和密码");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setMsg("邮箱格式不正确");
    if (pw.length < 8) return setMsg("密码至少 8 位");
    if (pw !== pw2) return setMsg("两次输入的密码不一致");
    btn.disabled = true;
    result.textContent = "注册中…";
    result.style.color = "var(--pp-muted)";
    try {
      const r = await A.register(email, pw, nickname);
      $("pp-reg-password").value = "";
      $("pp-reg-password2").value = "";
      const vr = $("pp-reg-verify-row");
      if (r.needVerify) {
        setMsg("✓ " + (r.notice || "验证邮件已发送，请到邮箱点链接激活"), true);
        if (vr) vr.style.display = "";
      } else {
        setMsg("✓ " + (r.notice || "注册成功，可直接登录"), true);
        if (vr) vr.style.display = "none";
        try { $("pp-login-email").value = email; } catch (e) { /* ignore */ }
      }
    } catch (e) {
      setMsg("✗ " + ((e && e.message) || "注册失败"));
    } finally {
      btn.disabled = false;
    }
  }

  async function onResendVerify() {
    const A = account();
    const btn = $("pp-reg-resend");
    const out = $("pp-reg-resend-result");
    if (!A || !btn || !out) return;
    const email = $("pp-reg-email").value.trim();
    if (!email) {
      out.textContent = "请先填邮箱";
      out.style.color = "var(--pp-danger)";
      return;
    }
    btn.disabled = true;
    out.textContent = "发送中…";
    out.style.color = "var(--pp-muted)";
    try {
      const msg = await A.resendVerify(email);
      out.textContent = "✓ " + msg;
      out.style.color = "var(--pp-success)";
    } catch (e) {
      out.textContent = "✗ " + ((e && e.message) || "发送失败");
      out.style.color = "var(--pp-danger)";
    } finally {
      btn.disabled = false;
    }
  }

  function onForgotLink() {
    const A = account();
    try { Zotero.launchURL(A.serverUrl() + "/forgot"); } catch (e) { /* ignore */ }
  }

  function onOfficialModelChange() {
    const C = channels(), A = account();
    const sel = $("pp-account-official-model");
    if (!C || !sel) return;
    const v = sel.value;
    const AI = aiTier();
    // 锁定的模型被选中：先把下拉复位到合法状态，再把反馈写在**刷新之后**
    // （写在刷新之前会被刷新重置掉——这是本项目踩过的坑）
    if (AI.lockedModels.indexOf(v) >= 0) {
      Promise.resolve(fillOfficialModelSelect()).then(() => {
        renderAiTierNote("「" + v + "」需要专业版，已保持原模型不变。");
      }).catch(() => { /* ignore */ });
      return;
    }
    try { C.upsert({ id: C.OFFICIAL_ID, model: v }); } catch (e) { /* ignore */ }
    renderAiTierNote("");
  }

  /* ==================== 会员（0.23.0） ====================
   * 等级 Free / Pro，权益、价格档位、收款信息全部由服务端下发（后台可改）。
   * 两条开通路径：
   *   A 订单：生成订单 → 展示订单号/金额/收款码 → 用户付款后点「我已完成支付」
   *           → 轮询订单状态 → 管理员核销后自动开通（无需手输码）
   *   B 激活码：线下购买/赠送/补偿，直接输码激活（绑定账号 + 叠加续期）
   */

  let mbPlans = null;       // {plans, priceOptions, priceItems, upcoming, cycles, pay}（服务端下发，缓存）
  // 0.60.0 在线支付可用性（会员单）：服务端 /api/plans 的 onlinePay；未开通时按钮不出现
  let mbOnline = { available: false, channels: [] };
  let mbSel = null;         // 当前选中的价格档位 {plan, months, text}
  let mbCoupon = null;      // 0.24.6 已应用的优惠码试算结果 {code, discountText, payableText, ...}
  let mbOrder = null;       // 当前订单
  let mbTimer = null;       // 订单轮询定时器
  let mbPollDeadline = 0;   // 轮询截止（避免永久轮询）

  const MB_STATUS = { pending: "待支付", claimed: "待核销", fulfilled: "已开通",
    cancelled: "已取消", expired: "已过期" };

  function mbSetMsg(id, text, color) {
    const n = $(id);
    if (!n) return;
    n.textContent = text;
    n.style.color = color || "var(--pp-muted)";
  }

  /* ==================== 付款订单弹窗（0.49.0） ====================
   * 背景：下单成功后订单只落在卡片内的内联订单区（pp-mb-pay / pp-bal-pay），
   * 用户容易漏看「精确金额 + 专属尾数」而按整数转账 → 自动对账匹配不上。
   * 因此下单成功（服务端校验通过、订单已落库）即**自动弹出一张付款单**，
   * 把订单内容 / 金额（含尾数）/ 订单号 / 状态 / 收款方式 / 二维码一屏摆清。
   *
   * 设计约束：
   *  1) 页面内模态（挂 #pp-dlg-root），不新开窗口：状态与面板轮询同源，
   *     面板关闭弹窗随之销毁，无跨窗口引用与定时器泄漏。
   *  2) 单例：同一时刻只一张；新订单覆盖旧单；同订单 update 只改内容不重弹。
   *  3) 动作单一真源：按钮回调指向面板的 *Core 函数（claim/cancel/refresh），
   *     与内联订单区共用同一实现，绝不各自复制一份副作用逻辑。
   *  4) 全程防御：show() 失败返回 false，调用方回退内联订单区（订单照样可见）。
   */
  const ORDER_TONE = { pending: "warn", claimed: "info", fulfilled: "ok",
    cancelled: "muted", expired: "muted" };

  /** 弹窗前置校验：返回问题文案（'' = 可展示）。字段以服务端 orderOut 为准。 */
  function orderViewProblem(o) {
    if (!o || typeof o !== "object") return "订单数据为空";
    if (!String(o.id || "").trim()) return "缺少订单号";
    const cents = Number(o.amountCents);
    const amount = Number(o.amount);
    const useCents = Number.isFinite(cents) ? cents : (Number.isFinite(amount) ? Math.round(amount * 100) : NaN);
    if (!Number.isFinite(useCents)) return "金额不可读";
    if (useCents < 0) return "金额为负";
    return "";
  }

  /** 订单 → 弹窗视图模型（纯函数）。kind: 'plan' | 'credit' */
  function orderViewModel(o, kind) {
    const isCredit = kind === "credit" || o.kind === "credit";
    const money = o.amountText || ("¥" + (Number(o.amount) || 0).toFixed(2));
    const st = String(o.status || "pending");
    const credit = microTxt(o.creditMicro);
    const bonus = Number(o.bonusMicro) > 0 ? "（含赠送 " + microTxt(o.bonusMicro) + "）" : "";
    const cycle = o.perpetual ? "永久"
      : (Number(o.months) || 1) + " 个月";
    const rows = [];
    rows.push(["订单号", String(o.id || "")]);
    if (isCredit) {
      rows.push(["到账额度", credit + bonus]);
    } else {
      rows.push(["订阅周期", o.cycleName ? (o.cycleName + " · " + cycle) : cycle]);
    }
    if (Number(o.discountCents) > 0) {
      rows.push(["折前价", String(o.originalText || "")]);
      rows.push(["优惠", ((o.couponCode || "优惠码") + " " + String(o.discountText || "")).trim()]);
    }
    const p = o.pay || {};
    if (p.channel) rows.push(["收款方式", String(p.channel)]);
    if (p.qrText) rows.push(["转账备注", String(p.qrText)]);
    if (p.note) rows.push(["说明", String(p.note)]);
    const tailHint = Number(o.tailCents) > 0
      ? ("请精确转账 " + money + "（不能凑整）：末尾 " + String(o.tailCents).padStart(2, "0")
        + " 分是本单专属对账尾数")
      : "";
    return {
      isCredit,
      title: isCredit ? "充值订单" : "会员订单",
      statusText: MB_STATUS[st] || st,
      tone: ORDER_TONE[st] || "muted",
      money,
      content: isCredit
        ? ("充值 " + money + " → 到账 " + credit + bonus)
        : ((o.planName || o.plan || "会员") + " · " + cycle + (o.cycleName ? "（" + o.cycleName + "）" : "")),
      tailHint,
      rows,
      note: isCredit
        ? "核销通过后自动入账余额（永不过期），到账金额以本单为准"
        : "核销通过后自动开通会员（无需手动领码），有效期按叠加续期规则计算",
    };
  }

  const OrderDlg = {
    _mask: null, _node: null, _kind: "", _order: null, _refs: null,
    _onKey: null, _returnFocus: null,

    isOpen() { return !!this._node; },

    /** 弹窗内可聚焦元素（供 focus trap 循环；无 querySelectorAll 的环境返回空表） */
    _focusables() {
      try {
        if (!this._node || typeof this._node.querySelectorAll !== "function") return [];
        const list = this._node.querySelectorAll("button, a[href], input, select, textarea, [tabindex]");
        const out = [];
        for (const n of list) {
          if (n.disabled) continue;
          if (n.getAttribute && n.getAttribute("tabindex") === "-1") continue;
          out.push(n);
        }
        return out;
      } catch (e) { return []; }
    },

    /**
     * 打开付款单（单例）。order 为服务端订单对象；actions = {claim,cancel,refresh}
     * 均返回 Promise<{ok, error}>。失败返回 false（调用方回退内联订单区）。
     */
    show(order, kind, actions) {
      try {
        if (orderViewProblem(order)) return false;
        const root = $("pp-dlg-root");
        if (!root) return false;                 // 老面板/装配异常：回退内联区
        this.close();                            // 单例：先拆旧单
        // 记住触发按钮，关闭后归还焦点（无障碍：焦点不丢回文档顶）
        try {
          const ae = document.activeElement;
          this._returnFocus = (ae && typeof ae.focus === "function") ? ae : null;
        } catch (e) { this._returnFocus = null; }
        const mask = el("div", { class: "pp-order-mask" });
        const card = el("div", { class: "pp-order-dlg",
          role: "dialog", "aria-modal": "true", "aria-labelledby": "pp-order-dlg-title" });
        mask.appendChild(card);

        const head = el("div", { class: "pp-dlg-head" });
        const title = el("b", { class: "pp-dlg-title", id: "pp-order-dlg-title" });
        const badge = el("span", { class: "pp-dlg-badge" });
        // 真关闭钮（0.72.2 无障碍）：内联 SVG x，键盘可达 + 读屏可辨
        const x = el("button", { class: "pp-dlg-close", type: "button",
          title: "关闭", "aria-label": "关闭" });
        try {
          const svg = document.createElementNS(SVG_NS, "svg");
          svg.setAttribute("viewBox", "0 0 24 24");
          svg.setAttribute("width", "14");
          svg.setAttribute("height", "14");
          svg.setAttribute("fill", "none");
          svg.setAttribute("stroke", "currentColor");
          svg.setAttribute("stroke-width", "2");
          svg.setAttribute("stroke-linecap", "round");
          svg.setAttribute("aria-hidden", "true");
          const l1 = document.createElementNS(SVG_NS, "line");
          l1.setAttribute("x1", "18"); l1.setAttribute("y1", "6");
          l1.setAttribute("x2", "6"); l1.setAttribute("y2", "18");
          const l2 = document.createElementNS(SVG_NS, "line");
          l2.setAttribute("x1", "6"); l2.setAttribute("y1", "6");
          l2.setAttribute("x2", "18"); l2.setAttribute("y2", "18");
          svg.appendChild(l1); svg.appendChild(l2);
          x.appendChild(svg);
        } catch (e) { x.textContent = "×"; }   // SVG 不可用时退回字符
        head.appendChild(title); head.appendChild(badge); head.appendChild(x);
        card.appendChild(head);

        const body = el("div", { class: "pp-dlg-body" });
        const content = el("div", { class: "pp-dlg-content" });
        const amount = el("div", { class: "pp-dlg-amount" });
        const tail = el("div", { class: "pp-dlg-tail", style: "display:none" });
        const rows = el("div", { class: "pp-dlg-rows" });
        const qr = el("img", { class: "pp-dlg-qr", style: "display:none" });
        const note = el("div", { class: "pp-dlg-note" });
        const msg = el("div", { class: "pp-msg pp-dlg-msg", "aria-live": "polite" });
        body.appendChild(content); body.appendChild(amount); body.appendChild(tail);
        body.appendChild(rows); body.appendChild(qr); body.appendChild(note); body.appendChild(msg);

        // 2026-10-19：付费前告知。虚拟服务一经使用不支持退款，条款须在付款动作之前可见，
        // 而不是藏在注册页（用户在插件内续费时根本看不到那个页面）。
        try {
          const legal = el("div", { class: "pp-dlg-legal",
            style: "margin-top:8px;font-size:11.5px;line-height:1.6;color:var(--pp-muted)" });
          legal.appendChild(document.createTextNode("付款即表示同意"));
          const mk = (label, path) => {
            const a = el("a", { href: "#", style: "color:var(--pp-accent);text-decoration:underline" }, label);
            a.addEventListener("click", (ev) => {
              try {
                ev.preventDefault();
                Zotero.launchURL(A.serverUrl() + path);
              } catch (e) { /* 打不开浏览器时不影响下单 */ }
            });
            return a;
          };
          legal.appendChild(mk("《用户协议》", "/terms"));
          legal.appendChild(document.createTextNode("与"));
          legal.appendChild(mk("《隐私政策》", "/privacy"));
          legal.appendChild(document.createTextNode("；虚拟服务一经使用不支持退款。"));
          body.appendChild(legal);
        } catch (e) { /* 法律文本挂载失败不阻断交易 */ }

        card.appendChild(body);

        const acts = el("div", { class: "pp-dlg-actions" });
        const claim = el("button", { class: "pp-btn pp-btn-primary pp-btn-sm pp-dlg-claim" }, "我已完成支付");
        // 在线支付按钮只在调用方提供 online 动作时出现（充值单 + 服务端已开通）
        const online = (actions && typeof actions.online === "function")
          ? el("button", { class: "pp-btn pp-btn-primary pp-btn-sm pp-dlg-online" }, "在线支付（扫码）")
          : null;
        const refresh = el("button", { class: "pp-btn pp-btn-sm pp-dlg-refresh" }, "刷新状态");
        const cancel = el("button", { class: "pp-btn pp-btn-sm pp-dlg-cancel" }, "取消订单");
        const done = el("button", { class: "pp-btn pp-btn-sm pp-dlg-done" }, "关闭");
        acts.appendChild(claim);
        if (online) acts.appendChild(online);
        acts.appendChild(refresh); acts.appendChild(cancel); acts.appendChild(done);
        card.appendChild(acts);

        this._mask = mask; this._node = card;
        this._kind = kind === "credit" ? "credit" : "plan";
        this._refs = { title, badge, content, amount, tail, rows, qr, note, msg, claim, refresh, cancel, online };
        root.appendChild(mask);

        const self = this;
        const say = (t, color) => { msg.textContent = t; msg.style.color = color || "var(--pp-muted)"; };
        const act = async (fn, busy, okTxt, failTxt) => {
          if (!actions || typeof actions[fn] !== "function") return;
          say(busy);
          let r = null;
          try { r = await actions[fn](); } catch (e) { r = { ok: false, error: (e && e.message) || failTxt }; }
          if (!self.isOpen()) return;                 // 取消成功等场景弹窗已关
          if (r && r.ok) say(okTxt, "var(--pp-success)");
          else say("✗ " + ((r && r.error) || failTxt), "var(--pp-danger)");
          self._applyButtons();                       // 按钮态永远由当前订单状态推导
        };

        x.addEventListener("click", () => self.close());
        done.addEventListener("click", () => self.close());
        mask.addEventListener("click", (ev) => { if (ev && ev.target === mask) self.close(); });
        claim.addEventListener("click", () => act("claim", "正在提交…", "✓ 已提交，等待核销（一般几分钟内）", "提交失败"));
        if (online) online.addEventListener("click", () => act("online", "正在创建收银台…", "✓ 收银台已打开，扫码后自动到账", "发起失败"));
        refresh.addEventListener("click", () => act("refresh", "正在查询…", "✓ 状态已刷新", "查询失败"));
        cancel.addEventListener("click", () => act("cancel", "正在取消…", "✓ 已取消", "取消失败"));

        /* 0.72.2 无障碍：Esc 关闭 + Tab/Shift+Tab 在弹窗内循环（focus trap）。
         * 监听挂在 document 上（无 document.addEventListener 的环境退回遮罩），close() 摘掉。 */
        this._onKey = (ev) => {
          try {
            if (!ev) return;
            if (ev.key === "Escape") {
              if (ev.preventDefault) ev.preventDefault();
              self.close();
              return;
            }
            if (ev.key !== "Tab") return;
            const items = self._focusables();
            if (!items.length) return;
            let idx = items.indexOf(document.activeElement);
            if (ev.shiftKey) idx = idx <= 0 ? items.length - 1 : idx - 1;
            else idx = idx < 0 || idx === items.length - 1 ? 0 : idx + 1;
            if (ev.preventDefault) ev.preventDefault();
            items[idx].focus();
          } catch (e) { /* 键盘兜底失败不阻断交互 */ }
        };
        try {
          if (document && typeof document.addEventListener === "function") {
            document.addEventListener("keydown", this._onKey);
          } else {
            mask.addEventListener("keydown", this._onKey);
          }
        } catch (e) { /* 老环境无键盘监听也不影响鼠标操作 */ }

        // 打开时焦点进弹窗：关闭钮是 DOM 序第一个可交互元素
        try { x.focus(); } catch (e) { /* ignore */ }

        this._apply(order);
        return true;
      } catch (e) {
        try { this.close(); } catch (e2) { /* ignore */ }
        return false;
      }
    },

    /** 轮询/操作后同步内容；不同订单号不串写（防旧单覆盖新单） */
    update(order) {
      if (!this.isOpen() || !order) return false;
      if (String(order.id || "") !== String((this._order || {}).id || "")) return false;
      try { this._apply(order); return true; } catch (e) { return false; }
    },

    _apply(order) {
      this._order = order;
      const r = this._refs; if (!r) return;
      const vm = orderViewModel(order, this._kind);
      r.title.textContent = vm.title;
      r.badge.textContent = vm.statusText;
      r.badge.setAttribute("class", "pp-dlg-badge pp-dlg-badge-" + vm.tone);
      r.content.textContent = vm.content;
      r.amount.textContent = vm.money;
      r.tail.textContent = vm.tailHint || "";
      r.tail.style.display = vm.tailHint ? "" : "none";
      r.rows.innerHTML = "";
      for (const pair of vm.rows) {
        const line = el("div", { class: "pp-dlg-row" });
        line.appendChild(el("span", { class: "pp-dlg-k" }, pair[0]));
        line.appendChild(el("span", { class: "pp-dlg-v" }, pair[1]));
        r.rows.appendChild(line);
      }
      const p = order.pay || {};
      if (p.qrImage) { r.qr.setAttribute("src", p.qrImage); r.qr.style.display = ""; }
      else { r.qr.removeAttribute("src"); r.qr.style.display = "none"; }
      r.note.textContent = vm.note;
      this._applyButtons();
    },

    _applyButtons() {
      const r = this._refs; if (!r) return;
      const st = String((this._order && this._order.status) || "pending");
      r.claim.disabled = st !== "pending";
      r.claim.textContent = st === "claimed" ? "已提交，等待核销" : "我已完成支付";
      r.cancel.disabled = st === "fulfilled" || st === "cancelled" || st === "expired";
      // 在线支付只对「待支付」可用（服务端同判）；已提交/已开通后入口关闭
      if (r.online) r.online.disabled = st !== "pending";
    },

    close() {
      // 摘掉键盘监听（Esc/focus trap 只在弹窗存活期间生效）
      if (this._onKey) {
        try {
          if (document && typeof document.removeEventListener === "function") {
            document.removeEventListener("keydown", this._onKey);
          }
        } catch (e) { /* ignore */ }
        try {
          if (this._mask && typeof this._mask.removeEventListener === "function") {
            this._mask.removeEventListener("keydown", this._onKey);
          }
        } catch (e) { /* ignore */ }
        this._onKey = null;
      }
      try {
        if (this._mask && this._mask.parentNode) this._mask.parentNode.removeChild(this._mask);
      } catch (e) { /* ignore */ }
      // 焦点归还触发按钮（关弹窗后键盘用户不丢位置）
      try {
        const back = this._returnFocus;
        if (back && typeof back.focus === "function") back.focus();
      } catch (e) { /* ignore */ }
      this._returnFocus = null;
      this._mask = null; this._node = null; this._refs = null; this._kind = ""; this._order = null;
    },
  };

  /** 打开付款单弹窗（会员/充值共用）；返回 false = 回退内联订单区 */
  function openOrderDlg(order, kind) {
    if (orderViewProblem(order)) return false;
    return OrderDlg.show(order, kind, {
      claim: kind === "credit" ? balClaimCore : mbClaimCore,
      cancel: kind === "credit" ? balCancelCore : mbCancelCore,
      refresh: kind === "credit" ? balRefreshCore : mbRefreshCore,
      // 在线支付：会员单（1.8.7+）与充值单（1.7.0+）都支持，前提是服务端已开通；
      // 未开通时按钮不出现（绝不显示一个点了必然失败的入口）
      online: kind === "credit"
        ? (balOnline.available ? balOnlinePayCore : null)
        : (mbOnline.available ? mbOnlinePayCore : null),
    });
  }

  /** 轮询/操作后同步弹窗（未打开或换单 → 不动作） */
  function syncOrderDlg() {
    if (!OrderDlg.isOpen()) return;
    const o = OrderDlg._kind === "credit" ? balOrder : mbOrder;
    if (o) OrderDlg.update(o);
  }

  /** 套餐目录按需拉取（首次进入或强制刷新） */
  async function ensurePlans(force) {
    const A = account();
    if (!A || !A.isLoggedIn()) return null;
    if (mbPlans && !force) return mbPlans;
    try {
      mbPlans = await A.plans();
      mbOnline = (mbPlans && mbPlans.onlinePay) || { available: false, channels: [] };
      // R2：套餐目录是赠送文案的另一真源（登录后拉到的更新鲜），顺手刷新三处文案
      if (mbPlans && (mbPlans.signupGrant != null || mbPlans.proMonthlyGrant != null)) {
        grantCopy = {
          signupGrant: mbPlans.signupGrant || null,
          proMonthlyGrant: mbPlans.proMonthlyGrant || null,
        };
        renderGrantCopy();
      }
      if (!mbSel) mbSel = pickDefaultOption(mbOptions());
    } catch (e) {
      if (force) throw e;
      mbPlans = null;
    }
    return mbPlans;
  }

  /**
   * 价格档位（生效中）→ 统一成 {plan, months, text}。
   * 0.24.4：优先用价格表 priceItems（含中文周期名 + 折合月单价，用户才看得出买长周期划不划算）；
   * 老服务端没有 priceItems 时回落旧的 priceOptions。
   */
  function mbOptions() {
    const items = (mbPlans && mbPlans.priceItems) || [];
    if (items.length) {
      return items.map((it) => {
        const cyc = it.cycleName || it.label || (it.months + " 个月");
        const per = Number(it.months) > 1
          ? " · 折合 ¥" + (Number(it.perMonth) || Math.round((it.price / it.months) * 100) / 100) + "/月"
          : "";
        return { plan: it.plan, months: Number(it.months), cycle: it.cycle,
          perpetual: it.cycle === "perpetual" || Number(it.months) === 0,
          text: cyc + " · ¥" + it.price + per };
      });
    }
    return ((mbPlans && mbPlans.priceOptions) || []).map((o) => ({
      plan: o.plan, months: Number(o.months), cycle: "",
      perpetual: Number(o.months) === 0,
      text: (o.label || o.months + " 个月") + " · ¥" + o.price,
    }));
  }

  /** 默认档位：优先「上次购买的周期」（续费不用重新挑），否则最少月数（花钱最少） */
  function pickDefaultOption(list) {
    if (!list || !list.length) return null;
    const A = account();
    const last = A && A.lastPurchasedMonths ? A.lastPurchasedMonths() : null;
    if (last) {
      const hit = list.find((o) => Number(o.months) === Number(last));
      if (hit) return hit;
    }
    // 有月数的档位优先（按最少月数，花钱最少）；全是永久时才回落永久
    const paid = list.filter((o) => Number(o.months) > 0);
    return (paid.length ? paid : list).slice().sort((a, b) => a.months - b.months)[0];
  }

  function renderMembership() {
    const A = account();
    const block = $("pp-mb-block");
    if (!A || !block) return;
    if (!A.isLoggedIn()) { block.style.display = "none"; return; }
    block.style.display = "";

    const m = A.membership() || { plan: "Free", name: "免费版", expiresAt: 0 };
    const isPro = A.isPro();
    const badge = $("pp-mb-badge");
    badge.textContent = isPro ? "PRO" : "FREE";
    badge.className = isPro ? "pp-mb-badge pp-mb-badge-pro" : "pp-mb-badge";
    $("pp-mb-title").textContent = m.name || (isPro ? "专业版" : "免费版");

    /* 到期与剩余天数：≤7 天转警示色，已到期转危险色 */
    const exp = $("pp-mb-expiry");
    const days = A.membershipDaysLeft();
    let cls = "pp-mb-expiry";
    let txt = "长期有效";
    if (m.expiresAt) {
      if (days <= 0) { txt = "已到期（" + fmtDate(m.expiresAt) + "）"; cls += " pp-mb-expiry-expired"; }
      else if (days <= 7) { txt = "仅剩 " + days + " 天 · " + fmtDate(m.expiresAt) + " 到期"; cls += " pp-mb-expiry-warn"; }
      else { txt = "剩 " + days + " 天 · " + fmtDate(m.expiresAt) + " 到期"; }
    } else if (m.perpetual) {
      txt = "永久有效（无需续费）";
    }
    exp.textContent = txt;
    exp.className = cls;

    /* 权益清单（来自服务端套餐配置；未取到时给占位） */
    const fbox = $("pp-mb-features");
    fbox.innerHTML = "";
    const def = mbPlans && (mbPlans.plans || []).find((p) => p.id === m.plan);
    const feats = (def && def.features) || [];
    if (feats.length) {
      for (const f of feats.slice(0, 6)) fbox.appendChild(el("div", { class: "pp-mb-feat" }, "· " + f));
    } else {
      fbox.appendChild(el("div", { class: "pp-mb-feat" },
        isPro ? "专业版权益加载中…" : "免费版：注册赠送 ¥6 额度（30 天）· 全部核心功能"));
      ensurePlans(false).catch(() => { /* 拉不到就保持占位 */ });
    }

    const up = $("pp-mb-upgrade");
    if (up) up.textContent = isPro ? "续费专业版" : "升级专业版";

    /* 0.24.4 到期提醒横幅：剩余 ≤7 天（含已到期）出现，点击直接打开续费面板 */
    const rb = $("pp-mb-renew");
    if (rb) {
      const rem = A.renewalReminder ? A.renewalReminder() : null;
      if (rem) {
        rb.style.display = "";
        rb.className = rem.expired ? "pp-mb-renew pp-mb-renew-expired" : "pp-mb-renew";
        rb.textContent = rem.expired
          ? ("⚠ 会员已于 " + fmtDate(rem.expiresAt) + " 到期，当前为免费版 —— 点此续费立即恢复")
          : ("⏳ 仅剩 " + rem.daysLeft + " 天（" + fmtDate(rem.expiresAt) + " 到期）—— 点此续费，时长可叠加");
      } else {
        rb.style.display = "none";
      }
    }

    renderMbUsage();
    renderMbHistory();   // R3：开通/续期记录（无 history → 整块隐藏）
    renderPersistWarn();
  }

  /**
   * 消耗趋势（0.46.0）：今日 / 近 7 天金额 + 近 7 天迷你柱状图。
   * 取消「赠送调用次数」后不再展示次数与上限，统一看**余额扣费的金额**；
   * 旧服务端没有 cost.days → 整块隐藏（绝不显示假数据）。
   */
  function renderMbUsage() {
    const box = $("pp-mb-usage");
    const A = account();
    if (!box || !A) return;
    if (!A.isLoggedIn()) { box.style.display = "none"; return; }
    const c = A.cost ? A.cost() : null;
    const days = (c && Array.isArray(c.days)) ? c.days : [];
    if (!days.length) { box.style.display = "none"; return; }
    box.style.display = "";
    box.innerHTML = "";
    const todayMicro = (c.today && Number(c.today.costMicro)) || 0;
    const weekMicro = days.reduce((s, d) => s + (Number(d && d.micro) || 0), 0);
    box.appendChild(el("div", { class: "pp-mb-usage-head" },
      "AI 消耗：今日 " + microTxt(todayMicro) + " · 近 7 天 " + microTxt(weekMicro)));

    const last = days.slice(-7);
    const max = Math.max(1, last.reduce((m, d) => Math.max(m, Number(d && d.micro) || 0), 0));
    const bars = el("div", { class: "pp-mb-bars" });
    for (const d of last) {
      const n = Number(d && d.micro) || 0;
      const h = n ? Math.max(3, Math.round((n / max) * 26)) : 2;
      const col = el("div", { class: "pp-mb-bar-col" });
      const bar = el("div", { class: n ? "pp-mb-bar" : "pp-mb-bar pp-mb-bar-zero" });
      bar.style.height = h + "px";
      bar.setAttribute("title", String(d.date) + "：" + microTxt(n));
      col.appendChild(bar);
      col.appendChild(el("div", { class: "pp-mb-bar-day" }, String(d.date).slice(8, 10)));
      bars.appendChild(col);
    }
    box.appendChild(bars);
  }

  /** 0.23.0：会话写盘失败不再静默——面板直接给出原因与后果 */
  function renderPersistWarn() {
    const A = account();
    const w = $("pp-mb-persist-warn");
    if (!A || !w) return;
    const ps = A.persistStatus || {};
    if (A.isLoggedIn() && ps.attempted && !ps.ok) {
      w.style.display = "";
      w.textContent = "⚠ 登录状态未能写入磁盘（" + ((ps.errors && ps.errors[0]) || "未知原因")
        + "）。本次运行内可用，但重启 Zotero 后需要重新登录；"
        + "请检查 Zotero 数据目录与配置目录是否可写。";
    } else {
      w.style.display = "none";
    }
  }

  /* ==================== 账号与会员增强（2026-10-23，R1/R2/R3/R4/R5/R8） ====================
   * 共同纪律：
   *  - 折叠交互复用 pp-mb-compare-toggle 同款模式（链接外观真按钮 + aria-expanded +
   *    display:none 容器），不引入新 UI 框架；
   *  - 异步渲染函数**自己包 try**（renderAll 同步调用它们，未捕获拒绝会打挂测试进程）；
   *  - 旧服务端降级一律「整块隐藏」（toggle 与容器一起 display:none），不报错占屏；
   *  - 文案零 emoji。
   */

  /* ---------- 折叠区工厂（compare-toggle 同款：状态变量单向写 DOM，不反读 inline style） ---------- */

  let histFold = null;    // R3 开通/续期记录
  let ordersFold = null;  // R4 我的订单
  let ledgerFold = null;  // R5 最近扣费明细

  /**
   * 链接按钮折叠区。onOpen：每次展开时触发（用于重新拉取数据）。
   * 返回 { isShown(), sync() }；整块隐藏由渲染函数直接操作 toggle/box 的 display。
   */
  function makeFold(toggleId, boxId, label, onOpen) {
    const tg = $(toggleId);
    const box = $(boxId);
    let shown = false;
    const sync = () => {
      if (box) box.style.display = shown ? "" : "none";
      if (tg) {
        tg.textContent = label + (shown ? " ▴" : " ▾");
        tg.setAttribute("aria-expanded", shown ? "true" : "false");
      }
    };
    sync();   // 先对齐一次（文案/aria 与收起态一致）
    const toggle = () => {
      shown = !shown;
      sync();
      if (shown && typeof onOpen === "function") {
        try { onOpen(); } catch (e) { /* 数据刷新失败不影响折叠动作 */ }
      }
    };
    if (tg) {
      tg.addEventListener("click", toggle);
      tg.addEventListener("keydown", (e) => {
        if (!e) return;
        const k = e.key;
        if (k !== "Enter" && k !== " " && k !== "Spacebar") return;
        if (e.preventDefault) e.preventDefault();   // 空格不滚页面
        toggle();
      });
    }
    return { isShown: () => shown, sync };
  }

  /** 换账号 / 登出时作废旧账号的增强区缓存与降级标记 */
  function resetEnhancements() {
    cpwUnsupported = false;
    cpwShown = false;
    ordersLoaded = false;
    ordersCache = null;
    ledgerLoaded = false;
    ledgerCache = null;
  }

  /* ---------- R1 修改密码 ---------- */

  let cpwShown = false;       // 表单展开态（变量持有，不反读 inline style）
  let cpwUnsupported = false; // 旧服务端（404）惰性探测结果：入口整块隐藏

  /** 改密入口可见性：已登录 + 未探测到不支持 才出现；表单随展开态 */
  function syncCpw() {
    const A = account();
    const tg = $("pp-cpw-toggle");
    const form = $("pp-cpw-form");
    const loggedIn = !!(A && A.isLoggedIn && A.isLoggedIn());
    if (tg) {
      tg.style.display = (loggedIn && !cpwUnsupported) ? "" : "none";
      tg.setAttribute("aria-expanded", cpwShown ? "true" : "false");
      tg.textContent = "修改密码" + (cpwShown ? " ▴" : " ▾");
    }
    if (form) form.style.display = (loggedIn && !cpwUnsupported && cpwShown) ? "" : "none";
  }

  function onCpwToggle() {
    cpwShown = !cpwShown;
    if (cpwShown) {
      mbSetMsg("pp-cpw-msg", "", "var(--pp-muted)");
    }
    syncCpw();
    if (cpwShown) { try { const o = $("pp-cpw-old"); if (o) o.focus(); } catch (e) { /* ignore */ } }
  }

  function onCpwCancel() {
    cpwShown = false;
    for (const id of ["pp-cpw-old", "pp-cpw-new", "pp-cpw-new2"]) {
      try { const n = $(id); if (n) n.value = ""; } catch (e) { /* ignore */ }
    }
    mbSetMsg("pp-cpw-msg", "", "var(--pp-muted)");
    syncCpw();
  }

  async function onCpwSubmit() {
    // ★ 整个函数体包 try：异步函数里的同步抛错同样会变未捕获拒绝
    try {
      const A = account();
      const btn = $("pp-cpw-submit");
      if (!A || !btn || !A.isLoggedIn()) return;
      const oldPw = String(($("pp-cpw-old") || {}).value || "");
      const newPw = String(($("pp-cpw-new") || {}).value || "");
      const newPw2 = String(($("pp-cpw-new2") || {}).value || "");
      const say = (t, color) => mbSetMsg("pp-cpw-msg", t, color);
      if (!oldPw || !newPw) return say("请填写当前密码与新密码", "var(--pp-danger)");
      if (newPw.length < 8) return say("新密码至少 8 位", "var(--pp-danger)");
      if (newPw !== newPw2) return say("两次输入的新密码不一致", "var(--pp-danger)");
      btn.disabled = true;
      say("正在修改…", "var(--pp-muted)");
      try {
        await A.changePassword(oldPw, newPw);
      } catch (e) {
        btn.disabled = false;
        if (e && e.unsupported) {
          // 旧服务端没有该路由：入口整块隐藏，提示挪到账号行（隐藏的 msg 用户看不到）
          cpwUnsupported = true;
          cpwShown = false;
          syncCpw();
          mbSetMsg("pp-account-result", "服务端版本过旧，暂不支持在线改密码", "var(--pp-muted)");
          return;
        }
        say("✗ " + ((e && e.message) || "修改失败"), "var(--pp-danger)");
        return;
      }
      // 成功：服务端已吊销全部会话（含本机），account.js 已本地清 session 并 _notify
      // （renderAll 随之回登录视图）。反馈写在刷新之后，否则会被刷新覆盖。
      cpwShown = false;
      for (const id of ["pp-cpw-old", "pp-cpw-new", "pp-cpw-new2"]) {
        try { const n = $(id); if (n) n.value = ""; } catch (e) { /* ignore */ }
      }
      renderAll();
      const lr = $("pp-login-result");
      if (lr) {
        lr.textContent = "密码已修改，全部设备已退出，请用新密码登录";
        lr.style.color = "var(--pp-success)";
      }
    } catch (e) {
      try { mbSetMsg("pp-cpw-msg", "✗ " + ((e && e.message) || "修改失败"), "var(--pp-danger)"); } catch (e2) { /* ignore */ }
      try { const btn = $("pp-cpw-submit"); if (btn) btn.disabled = false; } catch (e2) { /* ignore */ }
    }
  }

  /* ---------- R2 注册赠送 / 每月发放文案（plans 下发，三处渲染；拉不到 → 硬编码回退） ---------- */

  // undefined = 尚未拉取；null = 旧服务端无下发（保持 xhtml 硬编码）；对象 = 已下发
  let grantCopy;    // {signupGrant:{amountMicro,validDays,scopeNote}|null, proMonthlyGrant:{amountMicro}|null}
  let grantTried = false;

  /** plans 应答里的赠送文案块（account.js 已归一化；旧服务端两块皆 null） */
  function grantParts(gc) {
    const parts = [];
    const sg = gc && gc.signupGrant;
    const pg = gc && gc.proMonthlyGrant;
    if (sg && Number(sg.amountMicro) > 0) {
      parts.push("注册赠送 " + microTxt(sg.amountMicro) + " 额度（"
        + (Number(sg.validDays) > 0 ? Number(sg.validDays) + " 天内有效" : "永久有效") + "）");
    }
    if (pg && Number(pg.amountMicro) > 0) {
      parts.push("专业版每月发放 " + microTxt(pg.amountMicro) + " 额度");
    }
    return parts;
  }

  /** 对比表「AI 额度」行的一格。grant 缺失（旧服务端）→ 不动，保留 xhtml 硬编码回退 */
  function paintGrantCell(cell, grant, kind) {
    if (!cell || !grant || typeof grant !== "object") return;
    cell.innerHTML = "";
    if (Number(grant.amountMicro) > 0) {
      if (kind === "free") {
        cell.appendChild(el("div", null, "注册赠送 " + microTxt(grant.amountMicro)));
        const sub = [Number(grant.validDays) > 0 ? Number(grant.validDays) + " 天内有效" : "永久有效"];
        if (grant.scopeNote) sub.push(String(grant.scopeNote));
        cell.appendChild(el("span", { class: "pp-cmp-sub" }, sub.join(" · ")));
      } else {
        cell.appendChild(el("div", null, "每月 " + microTxt(grant.amountMicro)));
        cell.appendChild(el("span", { class: "pp-cmp-sub" }, "当月有效，不结转"));
      }
    } else {
      // amountMicro = 0：隐藏「注册赠送/每月发放」说法，如实标注不赠送
      cell.appendChild(el("div", null, "—"));
      cell.appendChild(el("span", { class: "pp-cmp-sub" },
        kind === "free" ? "注册不赠送额度" : "无每月赠送额度"));
    }
  }

  function renderGrantCopy() {
    const gc = grantCopy;
    if (gc === undefined || gc === null) return;   // 未拉取 / 旧服务端：保留硬编码，绝不空白
    const hint = $("pp-login-grant-hint");
    if (hint) {
      const parts = grantParts(gc);
      const tail = "；没有账号点「注册账号」——直接在下面填表注册，不用跳浏览器。";
      hint.textContent = parts.length
        ? "登录账号即可使用官方模型（" + parts.join("，") + "）" + tail
        : "登录账号即可使用官方模型" + tail;
    }
    paintGrantCell($("pp-cmp-grant-free"), gc.signupGrant, "free");
    paintGrantCell($("pp-cmp-grant-pro"), gc.proMonthlyGrant, "pro");
  }

  /** 独立拉取赠送文案（登录提示在未登录视图也要渲染，不能走 ensurePlans 的登录门槛） */
  async function loadGrantCopy() {
    try {
      const A = account();
      if (!A || typeof A.plans !== "function") return;
      const p = await A.plans();
      if (!p || (p.signupGrant == null && p.proMonthlyGrant == null)) return;  // 旧服务端：保持回退
      grantCopy = { signupGrant: p.signupGrant || null, proMonthlyGrant: p.proMonthlyGrant || null };
      renderGrantCopy();
    } catch (e) { /* 拉不到就保持 xhtml 硬编码文案 */ }
  }

  /* ---------- R3 开通/续期记录（membership.history 直读，≤10 条） ---------- */

  const MB_SOURCE = { order: "购买", code: "激活码", admin: "管理员开通",
    manual: "管理员赠送", legacy: "历史迁移" };

  function renderMbHistory() {
    const tg = $("pp-mb-history-toggle");
    const box = $("pp-mb-history");
    if (!tg || !box) return;
    const A = account();
    const m = (A && A.isLoggedIn() && typeof A.membership === "function") ? A.membership() : null;
    const hist = (m && Array.isArray(m.history)) ? m.history.filter(Boolean).slice(0, 10) : [];
    if (!hist.length) {   // 无记录 / 旧服务端无该字段 → 整块隐藏
      tg.style.display = "none";
      box.style.display = "none";
      return;
    }
    tg.style.display = "";
    box.style.display = (histFold && histFold.isShown()) ? "" : "none";
    box.innerHTML = "";
    for (const h of hist) {
      const src = MB_SOURCE[h.source] || String(h.source || "未知");
      const planName = h.plan === "Pro" ? "专业版" : (h.plan === "Free" ? "免费版" : String(h.plan || "会员"));
      const dur = h.perpetual ? "永久" : ((Number(h.months) || 0) > 0 ? Number(h.months) + " 个月" : "");
      const row = el("div", { class: "pp-hist-row" });
      row.appendChild(el("div", null, src + " · " + planName + (dur ? " · " + dur : "")));
      row.appendChild(el("div", { class: "pp-row-sub" },
        (h.at ? fmtAt(h.at) : "时间未知") + (h.note ? " · " + String(h.note) : "")));
      box.appendChild(row);
    }
  }

  /* ---------- R4 我的订单（GET /api/orders 只读列表） ---------- */

  // 契约枚举映射（与内联订单区的 MB_STATUS 口径不同：这里面向「订单台账」，fulfilled = 已入账）
  const ORDER_STATUS_TXT = { pending: "待支付", claimed: "待核销", fulfilled: "已入账",
    cancelled: "已取消", expired: "已过期" };

  let ordersLoaded = false;   // 本次面板生命周期内是否拉过
  let ordersCache = null;     // null = 旧服务端/失败（整块隐藏）

  async function renderOrders() {
    // ★ 自己包 try：renderAll 同步调用，未捕获拒绝会打挂测试
    try {
      const A = account();
      const tg = $("pp-orders-toggle");
      const block = $("pp-orders-block");
      const list = $("pp-orders-list");
      if (!A || !tg || !block || !list) return;
      if (!A.isLoggedIn()) { tg.style.display = "none"; block.style.display = "none"; return; }
      if (!ordersLoaded) {
        ordersLoaded = true;
        ordersCache = (typeof A.ordersList === "function") ? await A.ordersList(10) : null;
      }
      if (!ordersCache || !Array.isArray(ordersCache.orders)) {   // 旧服务端 404 → 整块隐藏
        tg.style.display = "none";
        block.style.display = "none";
        return;
      }
      tg.style.display = "";
      block.style.display = (ordersFold && ordersFold.isShown()) ? "" : "none";
      list.innerHTML = "";
      mbSetMsg("pp-orders-msg", ordersCache.orders.length ? "" : "暂无订单记录", "var(--pp-muted)");
      for (const o of ordersCache.orders) {
        if (!o || typeof o !== "object") continue;
        const bits = [String(o.planName || (o.kind === "credit" ? "AI 额度充值" : "会员订单"))];
        if (o.kind !== "credit") {
          bits.push(o.perpetual ? "永久"
            : ((Number(o.months) || 1) + " 个月" + (o.cycleName ? "（" + o.cycleName + "）" : "")));
        }
        bits.push(o.amountText || ("¥" + ((Number(o.amountCents) || 0) / 100).toFixed(2)));
        const row = el("div", { class: "pp-order-row" });
        row.appendChild(el("div", null, bits.join(" · ")));
        row.appendChild(el("div", { class: "pp-row-sub" },
          (ORDER_STATUS_TXT[o.status] || String(o.status || "未知"))
          + " · " + (o.createdAt ? fmtAt(o.createdAt) : "时间未知")
          + (o.note ? " · " + String(o.note) : "")));
        list.appendChild(row);
      }
    } catch (e) {
      // 网络层瞬时失败：允许下一次 renderAll 重试（404 走上面的 null 分支，不会到这里）
      ordersLoaded = false;
      try { const tg = $("pp-orders-toggle"); if (tg) tg.style.display = "none"; } catch (e2) { /* ignore */ }
      try { const b = $("pp-orders-block"); if (b) b.style.display = "none"; } catch (e2) { /* ignore */ }
    }
  }

  /* ---------- R5 最近扣费明细（GET /api/balance/ledger 只读视图） ---------- */

  let ledgerLoaded = false;
  let ledgerCache = null;     // null = 旧服务端/失败（整块隐藏）

  async function renderLedger() {
    // ★ 自己包 try：同上
    try {
      const A = account();
      const tg = $("pp-ledger-toggle");
      const block = $("pp-ledger-block");
      const list = $("pp-ledger-list");
      if (!A || !tg || !block || !list) return;
      if (!A.isLoggedIn()) { tg.style.display = "none"; block.style.display = "none"; return; }
      if (!ledgerLoaded) {
        ledgerLoaded = true;
        ledgerCache = (typeof A.balanceLedger === "function") ? await A.balanceLedger(20) : null;
      }
      if (!ledgerCache || !Array.isArray(ledgerCache.entries)) {   // 旧服务端 404 → 整块隐藏
        tg.style.display = "none";
        block.style.display = "none";
        return;
      }
      tg.style.display = "";
      block.style.display = (ledgerFold && ledgerFold.isShown()) ? "" : "none";
      list.innerHTML = "";
      if (!ledgerCache.entries.length) {
        list.appendChild(el("div", { class: "pp-hint" }, "暂无扣费记录"));
      }
      for (const en of ledgerCache.entries) {
        if (!en || typeof en !== "object") continue;
        const row = el("div", { class: "pp-ledger-row" });
        // label / deltaText 由服务端生成（前端零换算），直接渲染
        row.appendChild(el("div", null,
          String(en.label || en.kind || "扣费") + "　" + String(en.deltaText || "")));
        row.appendChild(el("div", { class: "pp-row-sub" }, en.at ? fmtAt(en.at) : "时间未知"));
        list.appendChild(row);
      }
    } catch (e) {
      // 网络层瞬时失败：允许下一次 renderAll 重试（404 走上面的 null 分支，不会到这里）
      ledgerLoaded = false;
      try { const tg = $("pp-ledger-toggle"); if (tg) tg.style.display = "none"; } catch (e2) { /* ignore */ }
      try { const b = $("pp-ledger-block"); if (b) b.style.display = "none"; } catch (e2) { /* ignore */ }
    }
  }

  /* ---------- R8 余额不足联动：一键展开「模型通道」卡 ---------- */

  function onBalOpenChannels() {
    try {
      const fold = (typeof window !== "undefined" && window.PapilotPrefsFold) || null;
      let card = null;
      try {
        if (typeof document !== "undefined" && document && typeof document.querySelector === "function") {
          card = document.querySelector('[data-fold="channels"]');
        }
      } catch (e) { /* 迷你 DOM 无 querySelector：按「卡存在」处理 */ }
      // ★ 必须走 open()：直写 classList 不写 prefsFoldOpen，下次开面板又收起（已知坑）
      if (fold && typeof fold.open === "function") fold.open("channels");
      if (card && typeof card.scrollIntoView === "function") {
        try { card.scrollIntoView({ block: "start", behavior: "smooth" }); } catch (e) { card.scrollIntoView(); }
      }
    } catch (e) { /* 联动失败不影响余额区本身 */ }
  }

  /* ---------- 下单 ---------- */

  function renderMbOptions() {
    const opts = $("pp-mb-options");
    if (!opts) return;
    opts.innerHTML = "";
    const list = mbOptions();
    if (!mbSel && list.length) mbSel = pickDefaultOption(list);
    for (const o of list) {
      const on = mbSel && mbSel.plan === o.plan && Number(mbSel.months) === Number(o.months);
      // 0.72.3 无障碍：档位是真按钮（span 假按钮键盘不可达）。pp-mb-opt 自带边框/底色，
      // 只补 font-family 让按钮继承面板字体，避免 UI 字体漂移。
      const chip = el("button", {
        type: "button",
        class: on ? "pp-mb-opt pp-mb-opt-on" : "pp-mb-opt",
        "aria-pressed": on ? "true" : "false",
        style: "font-family:inherit;",
      }, o.text);
      chip.addEventListener("click", () => {
        mbSel = o;
        // 换了档位：之前试算的折后价已经不对了 —— 主动作废，避免用户按旧价格转账
        if (mbCoupon) { mbCoupon = null; mbSetMsg("pp-mb-coupon-msg", "档位已变更，请重新应用优惠码", "var(--pp-warn)"); }
        renderMbOptions();
        renderMbQuote();
      });
      opts.appendChild(chip);
    }
    // 尚未生效的价格：只作预告（灰底、不可点）——让用户知道「什么时候会变价」
    for (const it of ((mbPlans && mbPlans.upcoming) || [])) {
      const d = it.effectiveFrom ? String(it.effectiveFrom).slice(0, 10) : "";
      const text = "即将生效 · " + (it.cycleName || it.label || (it.months + " 个月"))
        + " ¥" + it.price + (d ? " · " + d : "");
      const chip = el("span", { class: "pp-mb-opt pp-mb-opt-soon" }, text);
      chip.setAttribute("title", "该价格尚未生效，到时间后自动可购买");
      opts.appendChild(chip);
    }
    const note = $("pp-mb-price-note");
    if (note) {
      const pay = (mbPlans && mbPlans.pay) || {};
      note.textContent = "支持 " + (pay.channel || "收款码") + (pay.note ? "；" + pay.note : "");
    }
  }

  /* ---------- 登录设备（0.24.7） ---------- */

  /**
   * 列出本账号的登录设备。服务端只给「最近 N 天内有请求」的活跃设备 ——
   * 令牌是 30 天滑动续期，关掉 Zotero 并不会立刻下线，所以界面上写的是「活跃设备」。
   */
  async function renderDevices(note, noteColor) {
    const A = account();
    const box = $("pp-dev-block");
    const list = $("pp-dev-list");
    if (!A || !box || !list) return;
    if (!A.isLoggedIn()) { box.style.display = "none"; return; }
    // ★ 整个函数体都要包在 try 里：renderAll 是同步调用它的，异步抛错会变成
    //   未捕获的 Promise 拒绝（在 Zotero 里表现为控制台噪音，在测试里会直接打挂进程）。
    try {
      const r = await A.sessions();
      // 老服务端没有该接口、或应答形状不对 → 整块隐藏，而不是报错占屏
      if (!r || !Array.isArray(r.sessions)) { box.style.display = "none"; return; }
      box.style.display = "";
      list.innerHTML = "";
      const stat = $("pp-dev-stat");
      if (stat) {
        stat.textContent = "活跃 " + r.activeCount + " 台（阈值 " + r.maxDevices
          + " 台 / 窗口 " + r.activeDays + " 天）";
      }
      if (r.overLimit) {
        mbSetMsg("pp-dev-msg", "有 " + r.activeCount + " 台设备在活跃使用本账号。"
          + "如果这不是你自己，请踢掉不认识的设备，或改密码（会踢掉全部设备）。", "var(--pp-warn)");
      } else {
        mbSetMsg("pp-dev-msg", "", "var(--pp-muted)");
      }
      // ★ 本次操作的反馈要放在最后写 —— 否则会被上面这句清空/覆盖（改前就踩了这个坑）
      if (note) mbSetMsg("pp-dev-msg", note, noteColor || "var(--pp-success)");
      if (!r.identified) {
        list.appendChild(el("div", { class: "pp-hint" }, r.hint || "部分设备未上报标识。"));
      }
      for (const d of r.sessions) {
        const row = el("div", { class: d.current ? "pp-dev-row pp-dev-row-cur" : "pp-dev-row" });
        const name = d.deviceLabel || (d.deviceId ? "设备 " + d.deviceId.slice(0, 8) : "未上报设备标识的客户端");
        const meta = [d.platform, d.zoteroVersion ? "Zotero " + d.zoteroVersion : "",
          d.lastSeenAt ? "最近 " + fmtDate(d.lastSeenAt) : "", d.ipMasked || ""]
          .filter(Boolean).join(" · ");
        const left = el("div", { class: "pp-dev-info" });
        left.appendChild(el("div", { class: "pp-dev-name" }, name + (d.current ? "（本机）" : "")));
        left.appendChild(el("div", { class: "pp-dev-meta" }, meta));
        row.appendChild(left);
        const act = el("div", { class: "pp-dev-act" });
        // 0.72.3 无障碍：链接外观用契约类 .pp-link-btn 的真按钮（span 假按钮键盘不可达）
        const rename = el("button", { type: "button", class: "pp-link-btn",
          "aria-label": "重命名设备「" + name + "」" }, "重命名");
        rename.addEventListener("click", () => onRenameDevice(d));
        act.appendChild(rename);
        if (!d.current) {
          const kick = el("button", { type: "button", class: "pp-link-btn pp-link-danger",
            "aria-label": "踢出设备「" + name + "」" }, "踢出");
          kick.addEventListener("click", () => onKickDevice(d));
          act.appendChild(kick);
        } else {
          act.appendChild(el("span", { class: "pp-hint" }, "当前设备"));
        }
        row.appendChild(act);
        list.appendChild(row);
      }
    } catch (e) {
      box.style.display = "none";
    }
  }

  async function onRenameDevice(d) {
    const A = account();
    if (!A) return;
    const cur = d.deviceLabel || "";
    const name = Services_promptInput(Zotero.getMainWindow(), "Papilot",
      "给这台设备起个名字（例如「办公室台式」，留空可清除）：", cur);
    if (name === null) return;
    try {
      await A.renameSession(d.sid, name);
      await renderDevices("✓ 已保存设备名");
    } catch (e) {
      mbSetMsg("pp-dev-msg", "✗ " + ((e && e.message) || "重命名失败"), "var(--pp-danger)");
    }
  }

  async function onKickDevice(d) {
    const A = account();
    if (!A) return;
    const name = d.deviceLabel || d.platform || "该设备";
    const ok = Services_promptConfirm(Zotero.getMainWindow(), "Papilot",
      "踢出「" + name + "」？\n它下次使用时会要求重新登录；不影响当前设备。");
    if (!ok) return;
    try {
      await A.revokeSession(d.sid);
      await renderDevices("✓ 已踢出该设备");
    } catch (e) {
      mbSetMsg("pp-dev-msg", "✗ " + ((e && e.message) || "踢出失败"), "var(--pp-danger)");
    }
  }

  async function onKickOtherDevices() {
    const A = account();
    if (!A) return;
    if (!Services_promptConfirm(Zotero.getMainWindow(), "Papilot",
      "踢出除本机外的全部设备？其他机器需要重新登录。")) return;
    try {
      const r = await A.revokeOtherSessions();
      await renderDevices("✓ 已踢出 " + (r.revoked || 0) + " 台设备");
    } catch (e) {
      mbSetMsg("pp-dev-msg", "✗ " + ((e && e.message) || "操作失败"), "var(--pp-danger)");
    }
  }

  /* ---------- 优惠码（0.24.6） ---------- */

  /** 应用优惠码：向服务端试算折后价（**不占名额**，用户可反复试） */
  async function onMbCoupon() {
    const A = account();
    const inp = $("pp-mb-coupon");
    if (!A || !inp) return;
    const code = String(inp.value || "").trim();
    if (!code) { mbCoupon = null; renderMbQuote(); mbSetMsg("pp-mb-coupon-msg", "已清除优惠码", "var(--pp-muted)"); return; }
    if (!mbSel) { mbSetMsg("pp-mb-coupon-msg", "请先选择购买档位", "var(--pp-warn)"); return; }
    mbSetMsg("pp-mb-coupon-msg", "正在校验…", "var(--pp-muted)");
    try {
      mbCoupon = await A.validateCoupon(code, mbSel.plan, mbSel.months, mbSel.cycle);
      mbSetMsg("pp-mb-coupon-msg", "✓ " + (mbCoupon.label || "优惠码可用"), "var(--pp-success)");
      renderMbQuote();
    } catch (e) {
      mbCoupon = null;
      renderMbQuote();
      mbSetMsg("pp-mb-coupon-msg", "✗ " + ((e && e.message) || "优惠码不可用"), "var(--pp-danger)");
    }
  }

  /** 折后价明细：折前 / 减免 / 应付（应付不含对账尾数，尾数在下单后才确定） */
  function renderMbQuote() {
    const box = $("pp-mb-quote");
    if (!box) return;
    if (!mbCoupon) { box.style.display = "none"; box.textContent = ""; return; }
    const q = mbCoupon;
    box.style.display = "";
    // 1.8.4：只有服务端开启「唯一尾数」时才提尾数（默认关 = 下单金额即应付价）
    const tailNote = (mbPlans && mbPlans.tailEnabled)
      ? "（下单后另加 1~99 分的专属对账尾数，转账金额以下单页为准）" : "";
    box.textContent = "折前 " + (q.originalText || "") + "　" + (q.discountText || "")
      + "　应付 " + (q.payableText || "") + tailNote;
  }

  /** 点到期横幅 = 打开续费面板（默认档位取「上次购买的周期」） */
  function onMbRenew() {
    const A = account();
    if (!A || !A.isLoggedIn()) return;
    mbSel = null;                       // 重新按上次购买周期挑默认档位
    onMbUpgrade();
    try { const b = $("pp-mb-order"); if (b && b.scrollIntoView) b.scrollIntoView(false); } catch (e) { /* ignore */ }
  }

  async function onMbUpgrade() {
    const A = account();
    const box = $("pp-mb-order");
    if (!A || !box || !A.isLoggedIn()) return;
    box.style.display = "";
    mbCoupon = null;
    renderMbQuote();
    mbSetMsg("pp-mb-coupon-msg", "", "var(--pp-muted)");
    mbSetMsg("pp-mb-order-msg", "正在获取套餐…", "var(--pp-muted)");
    try {
      await ensurePlans(true);
      mbSetMsg("pp-mb-order-msg", "", "var(--pp-muted)");
      renderMbOptions();
    } catch (e) {
      mbSetMsg("pp-mb-order-msg", "✗ " + ((e && e.message) || "获取套餐失败"), "var(--pp-danger)");
    }
  }

  async function onMbCreate() {
    const A = account();
    const btn = $("pp-mb-create");
    if (!A || !mbSel) return;
    btn.disabled = true;
    mbSetMsg("pp-mb-order-msg", "正在生成订单…", "var(--pp-muted)");
    try {
      mbOrder = await A.createOrder(mbSel.plan, mbSel.months, mbSel.cycle,
        mbCoupon ? mbCoupon.code : "");
      // 0.49.0 下单成功（服务端已校验并落库）→ 自动弹出付款单；
      // 订单数据异常则不弹（避免展示脏数据），内联区照常渲染作兜底。
      const bad = orderViewProblem(mbOrder);
      if (bad) {
        mbSetMsg("pp-mb-order-msg", "✗ 订单数据异常（" + bad + "），请重新生成", "var(--pp-danger)");
      } else {
        mbSetMsg("pp-mb-order-msg", "", "var(--pp-muted)");
      }
      renderMbPay();
      startMbPolling();
      if (!bad) openOrderDlg(mbOrder, "plan");
    } catch (e) {
      mbSetMsg("pp-mb-order-msg", "✗ " + ((e && e.message) || "下单失败"), "var(--pp-danger)");
    } finally {
      btn.disabled = false;
    }
  }

  function renderMbPay() {
    const pay = $("pp-mb-pay");
    const info = $("pp-mb-pay-info");
    const qr = $("pp-mb-qr");
    if (!pay || !info) return;
    if (!mbOrder) { pay.style.display = "none"; return; }
    pay.style.display = "";
    // 在线支付可用性随套餐目录 /api/plans 下发；没加载过就补拉一次（否则会员单看不到入口）
    if (!mbPlans) {
      ensurePlans(false).then(() => { if (mbOrder) renderMbPay(); }).catch(() => { /* 拉不到就保持隐藏 */ });
    }
    const o = mbOrder;
    const cycleTxt = o.perpetual ? "永久" : (o.months + " 个月");
    const money = o.amountText || ("¥" + (Number(o.amount) || 0).toFixed(2));
    const lines = ["订单号：" + o.id];
    // 0.24.6：用了优惠码就把「折前 → 减免 → 实付」摆清楚，避免用户以为被多收
    if (Number(o.discountCents) > 0) {
      lines.push((o.planName || o.plan) + " · " + cycleTxt + " · 折前 " + (o.originalText || "") + "（优惠码 " + o.couponCode + "）");
      lines.push("优惠 " + o.discountText + " → 折后 ¥" + ((Number(o.baseCents) || 0) / 100).toFixed(2));
    } else {
      lines.push((o.planName || o.plan) + " · " + cycleTxt + " · " + money);
    }
    lines.push("状态：" + (MB_STATUS[o.status] || o.status));
    // 0.24.5：金额末尾的小数尾数是这笔订单的专属标识（后台据此自动对账核销）
    if (o.tailCents) {
      lines.push("⚠ 请**精确转账 " + money + "**（不能凑整）：末尾 "
        + String(o.tailCents).padStart(2, "0") + " 分是这笔订单的专属尾数，用于自动对账");
    }
    const p = o.pay || {};
    if (p.channel) lines.push("收款方式：" + p.channel);
    if (p.qrText) lines.push(p.qrText);
    if (p.note) lines.push(p.note);
    info.textContent = lines.join("\n");
    if (qr) {
      if (p.qrImage) { qr.setAttribute("src", p.qrImage); qr.style.display = ""; }
      else { qr.removeAttribute("src"); qr.style.display = "none"; }
    }
    const done = o.status === "fulfilled";
    const claim = $("pp-mb-claim");
    if (claim) {
      claim.disabled = done || o.status === "claimed" || o.status === "cancelled" || o.status === "expired";
      claim.textContent = o.status === "claimed" ? "已提交，等待核销" : "我已完成支付";
    }
    const cancel = $("pp-mb-cancel");
    if (cancel) cancel.disabled = done || o.status === "cancelled";
    // 0.60.0 会员订单在线支付：服务端开通且订单待支付时才出现（已提交/已开通后收起）
    const online = $("pp-mb-online");
    if (online) {
      const canOnline = !!mbOnline.available && o.status === "pending";
      online.style.display = canOnline ? "" : "none";
      online.disabled = !canOnline;
    }
    if (done) mbSetMsg("pp-mb-pay-result", "✓ 已开通，会员状态已更新", "var(--pp-success)");
  }

  function startMbPolling() {
    stopMbPolling();
    mbPollDeadline = Date.now() + 10 * 60e3; // 最多轮询 10 分钟
    mbTimer = window.setInterval(() => { onMbPoll(true); }, 6000);
  }

  function stopMbPolling() {
    if (mbTimer) { try { window.clearInterval(mbTimer); } catch (e) { /* ignore */ } mbTimer = null; }
  }

  /**
   * 查一次会员订单状态并同步 UI（弹窗「刷新状态」与轮询共用）。
   * 返回 {ok, error, order}，**不抛异常**——调用方（内联区/弹窗）各自决定措辞。
   */
  async function mbRefreshCore() {
    const A = account();
    if (!A || !mbOrder) return { ok: false, error: "订单不存在" };
    try {
      const o = await A.orderStatus(mbOrder.id);
      mbOrder = o;
      if (o.status === "fulfilled") {
        stopMbPolling();
        try { await A.refreshMembership(); } catch (e) { /* 失败也有本地兜底 */ }
        renderAll();
      } else if (o.status === "expired" || o.status === "cancelled") {
        stopMbPolling();
      }
      renderMbPay();
      syncOrderDlg();
      return { ok: true, order: o };
    } catch (e) {
      return { ok: false, error: (e && e.message) || "查询失败" };
    }
  }

  /** 轮询订单状态（silent=true 时不写内联提示，供定时器调用） */
  async function onMbPoll(silent) {
    const A = account();
    if (!A || !mbOrder) return;
    if (Date.now() > mbPollDeadline) { stopMbPolling(); return; }
    const r = await mbRefreshCore();
    if (!r.ok) {
      if (!silent) mbSetMsg("pp-mb-pay-result", "✗ " + r.error, "var(--pp-danger)");
      return;
    }
    if (!silent) {
      const st = (r.order && r.order.status) || "";
      // fulfilled 的结果行已由 renderMbPay 写好（「✓ 已开通…」）——不能再用
      // 「状态：…」覆盖（反馈写在刷新之后，这里恰好相反）
      if (st !== "fulfilled") mbSetMsg("pp-mb-pay-result", "状态：" + (MB_STATUS[st] || st), "var(--pp-muted)");
    }
  }

  /** 提交「我已完成支付」（内联按钮与弹窗共用） */
  async function mbClaimCore() {
    const A = account();
    if (!A || !mbOrder) return { ok: false, error: "订单不存在" };
    try {
      mbOrder = await A.claimOrder(mbOrder.id);
      renderMbPay();
      syncOrderDlg();
      return { ok: true, order: mbOrder };
    } catch (e) {
      return { ok: false, error: (e && e.message) || "提交失败" };
    }
  }

  async function onMbClaim() {
    const A = account();
    if (!A || !mbOrder) return;
    mbSetMsg("pp-mb-pay-result", "正在提交…", "var(--pp-muted)");
    const r = await mbClaimCore();
    if (!r.ok) return mbSetMsg("pp-mb-pay-result", "✗ " + r.error, "var(--pp-danger)");
    mbSetMsg("pp-mb-pay-result",
      "✓ 已提交，等待管理员核销（一般几分钟内）。可点「刷新订单状态」查看。", "var(--pp-success)");
    startMbPolling();
  }

  /**
   * 在线支付（0.60.0 / 服务端 1.8.7）：为当前**会员订单**创建网关收银台 → 系统浏览器扫码。
   * 支付成功后网关回调自动开通会员（不再等人工核销），面板轮询会看到 fulfilled。
   * 只对「待支付」订单可用（服务端同判）。
   */
  async function mbOnlinePayCore() {
    const A = account();
    if (!A || !mbOrder) return { ok: false, error: "订单不存在" };
    try {
      const r = await A.startOnlinePay(mbOrder.id, "alipay");
      try { Zotero.launchURL(r.payUrl); } catch (e) { /* 打不开浏览器也把地址留在提示里 */ }
      startMbPolling();
      return { ok: true, payUrl: r.payUrl };
    } catch (e) {
      return { ok: false, error: (e && e.message) || "发起在线支付失败" };
    }
  }

  async function onMbOnlinePay() {
    const A = account();
    if (!A || !mbOrder) return;
    mbSetMsg("pp-mb-pay-result", "正在创建网关收银台…", "var(--pp-muted)");
    const r = await mbOnlinePayCore();
    if (!r.ok) return mbSetMsg("pp-mb-pay-result", "✗ " + r.error, "var(--pp-danger)");
    mbSetMsg("pp-mb-pay-result",
      "✓ 收银台已在浏览器打开：扫码支付后自动开通（本窗口保持轮询）", "var(--pp-success)");
  }

  /** 取消订单（内联按钮与弹窗共用）：成功后清空当前订单并关闭弹窗 */
  async function mbCancelCore() {
    const A = account();
    if (!A || !mbOrder) return { ok: false, error: "订单不存在" };
    try {
      await A.cancelOrder(mbOrder.id);
      stopMbPolling();
      mbOrder = null;
      const b = $("pp-mb-pay");
      if (b) b.style.display = "none";
      OrderDlg.close();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e && e.message) || "取消失败" };
    }
  }

  async function onMbCancel() {
    const A = account();
    if (!A || !mbOrder) return;
    const r = await mbCancelCore();
    if (r.ok) mbSetMsg("pp-mb-order-msg", "订单已取消，可重新生成", "var(--pp-muted)");
    else mbSetMsg("pp-mb-pay-result", "✗ " + r.error, "var(--pp-danger)");
  }

  async function onMbRefresh() {
    const A = account();
    if (!A || !A.isLoggedIn()) return;
    mbSetMsg("pp-mb-result", "刷新中…", "var(--pp-muted)");
    try {
      await A.refreshMembership();
      renderAll();
      mbSetMsg("pp-mb-result", "✓ 会员状态已刷新", "var(--pp-success)");
    } catch (e) {
      mbSetMsg("pp-mb-result", "✗ " + ((e && e.message) || "刷新失败"), "var(--pp-danger)");
    }
  }

  /* ==================== AI 额度余额（0.26.0） ====================
   * 三档：注册赠送（有期，限基础模型）/ 订阅额度（当月有效不结转）/ 充值（永不过期）。
   * 服务端 1.6.0 起在 /api/auth/me 下发 user.balance；旧服务端没有该字段 →
   * **整块隐藏**（绝不显示假数据）。
   * 充值走与会员同一套订单机制：档位 → 生成订单（带唯一尾数）→ 扫码 →
   * 「我已完成支付」→ 轮询 → 管理员核销后**自动入账余额**。
   */

  let balOpts = [];      // 服务端下发的充值档位
  let balSel = null;     // 选中的档位
  let balOrder = null;   // 当前充值订单
  let balTimer = null;   // 订单轮询定时器
  let balDeadline = 0;
  let balTried = false;  // 档位已尝试拉取（避免渲染 ↔ 拉取互相触发成无限循环）
  // 0.50.0 在线支付可用性（服务端 /api/plans 的 onlinePay；未开通时「在线支付」按钮不出现）
  let balOnline = { available: false, channels: [] };

  /** 微元 → 元文案（服务端已给带币种文案时优先用它，避免前后端口径漂移） */
  function microTxt(micro, fallback) {
    if (fallback) return fallback;
    const y = (Number(micro) || 0) / 1e6;
    if (y >= 1) return "¥" + y.toFixed(2);
    // 单次调用常低于 1 分：最多保留 4 位小数并去掉尾零，避免显示成 ¥0 或 ¥0.000
    if (y > 0) return "¥" + String(Number(y.toFixed(4)));
    return "¥0";
  }

  function renderBalance() {
    const A = account();
    const block = $("pp-bal-block");
    if (!A || !block) return;
    const b = A.isLoggedIn() ? A.balance() : null;
    if (!b) { block.style.display = "none"; return; }   // 旧服务端 → 整块隐藏
    block.style.display = "";

    $("pp-bal-total").textContent = microTxt(b.totalMicro, b.text);
    const parts = [];
    if (b.grantedMicro > 0) {
      parts.push("注册赠送 " + microTxt(b.grantedMicro, b.grantedText)
        + (b.grantedDaysLeft != null ? "（剩 " + b.grantedDaysLeft + " 天）" : ""));
    }
    if (b.planMicro > 0) {
      parts.push("订阅额度 " + microTxt(b.planMicro, b.planText)
        + (b.planDaysLeft != null ? "（每月发放，不结转）" : ""));
    }
    parts.push("充值 " + microTxt(b.paidMicro, b.paidText) + "（永不过期）");
    $("pp-bal-detail").textContent = parts.join(" ｜ ");

    // 说明条：透支 / 观察模式 / 消耗口径 —— 三种状态给三种说法
    const note = $("pp-bal-note");
    if (b.overdraft) {
      note.textContent = "⚠ 充值余额已透支（并发调用所致）：下次 AI 请求会被拦截，请充值后继续。";
      note.style.color = "var(--pp-danger)";
    } else if (!b.enforce) {
      note.textContent = "当前为观察模式：额度照常扣减与记账，但用尽不会中断使用。";
      note.style.color = "var(--pp-muted)";
    } else if (b.totalMicro <= (b.minBalanceMicro || 0)) {
      note.textContent = "⚠ 额度不足，AI 请求将被拦截；充值或接入自己的模型通道即可继续。";
      note.style.color = "var(--pp-danger)";
    } else {
      note.textContent = "AI 调用按实际用量从余额扣费（无调用次数上限）：注册赠送仅限基础模型，订阅额度与充值额度可用于全部模型。";
      note.style.color = "var(--pp-muted)";
    }

    // R8：额度不足 / 透支时在说明条旁给出「接入自己的模型通道」直达按钮；
    // channels 卡不存在（面板结构变化）时按钮隐藏，不留死入口
    const oc = $("pp-bal-open-channels");
    if (oc) {
      let chCardExists = true;
      try {
        if (typeof document !== "undefined" && document && typeof document.querySelector === "function") {
          chCardExists = !!document.querySelector('[data-fold="channels"]');
        }
      } catch (e) { chCardExists = true; }
      const insufficient = !!b.overdraft || (!!b.enforce && b.totalMicro <= (b.minBalanceMicro || 0));
      oc.style.display = (insufficient && chCardExists) ? "" : "none";
    }

    const tg = $("pp-bal-recharge-toggle");
    if (tg) { tg.disabled = !balOpts.length; tg.textContent = balOpts.length ? "充值额度" : "充值暂未开放"; }
    renderBalOptions();
    // 档位懒加载（只试一次；失败就显示「服务端未配置充值档位」）
    if (!balOpts.length && A.isLoggedIn()) ensureRechargeOptions(false).catch(() => { /* 忽略 */ });
  }

  function renderBalOptions() {
    const box = $("pp-bal-options");
    if (!box) return;
    box.innerHTML = "";
    if (!balOpts.length) {
      box.appendChild(el("span", { class: "pp-hint" }, "服务端未配置充值档位"));
      return;
    }
    for (const o of balOpts) {
      const on = balSel && balSel.id === o.id;
      const text = (o.label || o.amountText || "") + (o.bonusText ? "（" + o.bonusText + "）" : "");
      const chip = el("button", {
        type: "button",
        class: on ? "pp-mb-opt pp-mb-opt-on" : "pp-mb-opt",
        "aria-pressed": on ? "true" : "false",
        style: "font-family:inherit;",
      }, text);
      chip.addEventListener("click", () => {
        balSel = o;
        renderBalOptions();
        const n = $("pp-bal-price-note");
        if (n) n.textContent = "付款 " + (o.amountText || "") + " → 到账 " + (o.creditText || "");
      });
      box.appendChild(chip);
    }
  }

  async function ensureRechargeOptions(force) {
    const A = account();
    if (!A || !A.isLoggedIn()) return;
    if (balOpts.length && !force) return;
    if (balTried && !force) return;   // 试过一次就够了，失败也不再反复请求
    balTried = true;
    try {
      const p = await A.plans();
      balOpts = (p && p.rechargeOptions) || [];
      balOnline = (p && p.onlinePay) || { available: false, channels: [] };
      if (!balSel && balOpts.length) balSel = balOpts[0];
    } catch (e) { balOpts = []; }
    renderBalance();
  }

  function onBalRechargeToggle() {
    const box = $("pp-bal-recharge");
    if (!box) return;
    // 初始隐藏来自 XHTML 的内联 style；在无样式解析的环境（测试迷你 DOM）里
    // 该值为 undefined，所以「隐藏」要同时认 "none" 与空值，否则点了展不开。
    const hidden = !box.style.display || box.style.display === "none";
    box.style.display = hidden ? "" : "none";
    if (hidden) ensureRechargeOptions(true).catch(() => { /* 拉不到就显示空档位提示 */ });
  }

  async function onBalCreate() {
    const A = account();
    const btn = $("pp-bal-create");
    if (!A || !balSel) return mbSetMsg("pp-bal-order-msg", "请先选择充值档位", "var(--pp-danger)");
    btn.disabled = true;
    mbSetMsg("pp-bal-order-msg", "正在生成订单…", "var(--pp-muted)");
    try {
      balOrder = await A.createCreditOrder(balSel.id);
      // 0.49.0 下单成功 → 自动弹出充值付款单（字段异常不弹，内联区兜底）
      const bad = orderViewProblem(balOrder);
      if (bad) {
        mbSetMsg("pp-bal-order-msg", "✗ 订单数据异常（" + bad + "），请重新生成", "var(--pp-danger)");
      } else {
        mbSetMsg("pp-bal-order-msg", "", "var(--pp-muted)");
      }
      renderBalPay();
      startBalPolling();
      if (!bad) openOrderDlg(balOrder, "credit");
    } catch (e) {
      mbSetMsg("pp-bal-order-msg", "✗ " + ((e && e.message) || "下单失败"), "var(--pp-danger)");
    } finally {
      btn.disabled = false;
    }
  }

  function renderBalPay() {
    const pay = $("pp-bal-pay");
    const info = $("pp-bal-pay-info");
    if (!pay || !info) return;
    if (!balOrder) { pay.style.display = "none"; return; }
    pay.style.display = "";
    const o = balOrder;
    const money = o.amountText || ("¥" + (Number(o.amount) || 0).toFixed(2));
    const credit = microTxt(o.creditMicro);
    const bonus = microTxt(o.bonusMicro);
    const lines = ["订单号：" + o.id];
    lines.push("充值 " + money + " → 到账 " + credit
      + (Number(o.bonusMicro) > 0 ? "（含赠送 " + bonus + "）" : ""));
    lines.push("状态：" + (MB_STATUS[o.status] || o.status));
    if (o.tailCents) {
      lines.push("⚠ 请**精确转账 " + money + "**（不能凑整）：末尾 "
        + String(o.tailCents).padStart(2, "0") + " 分是这笔订单的专属尾数，用于自动对账");
    }
    const p = o.pay || {};
    if (p.channel) lines.push("收款方式：" + p.channel);
    if (p.qrText) lines.push(p.qrText);
    if (p.note) lines.push(p.note);
    info.textContent = lines.join("\n");
    const qr = $("pp-bal-qr");
    if (qr) {
      if (p.qrImage) { qr.setAttribute("src", p.qrImage); qr.style.display = ""; }
      else { qr.removeAttribute("src"); qr.style.display = "none"; }
    }
    const done = o.status === "fulfilled";
    const claim = $("pp-bal-claim");
    if (claim) {
      claim.disabled = done || o.status === "claimed" || o.status === "cancelled" || o.status === "expired";
      claim.textContent = o.status === "claimed" ? "已提交，等待核销" : "我已完成支付";
    }
    // 0.50.0 在线支付：服务端开通且订单待支付时才出现（0.60.0 起会员单同样支持）
    const online = $("pp-bal-online");
    if (online) {
      const canOnline = !!balOnline.available && o.status === "pending";
      online.style.display = canOnline ? "" : "none";
      online.disabled = !canOnline;
    }
    const cancel = $("pp-bal-cancel");
    if (cancel) cancel.disabled = done || o.status === "cancelled";
    if (done) mbSetMsg("pp-bal-pay-result", "✓ 已入账，余额已更新", "var(--pp-success)");
  }

  function startBalPolling() {
    stopBalPolling();
    balDeadline = Date.now() + 10 * 60e3;
    balTimer = window.setInterval(() => { onBalPoll(true); }, 6000);
  }

  function stopBalPolling() {
    if (balTimer) { try { window.clearInterval(balTimer); } catch (e) { /* ignore */ } balTimer = null; }
  }

  /** 查一次充值订单状态并同步 UI（弹窗「刷新状态」与轮询共用；不抛异常） */
  async function balRefreshCore() {
    const A = account();
    if (!A || !balOrder) return { ok: false, error: "订单不存在" };
    try {
      const o = await A.orderStatus(balOrder.id);
      balOrder = o;
      if (o.status === "fulfilled") {
        stopBalPolling();
        try { await A.refreshUser(); } catch (e) { /* 失败也有本地兜底 */ }
        renderAll();
      } else if (o.status === "expired" || o.status === "cancelled") {
        stopBalPolling();
      }
      renderBalPay();
      syncOrderDlg();
      return { ok: true, order: o };
    } catch (e) {
      return { ok: false, error: (e && e.message) || "查询失败" };
    }
  }

  async function onBalPoll(silent) {
    const A = account();
    if (!A || !balOrder) return;
    if (Date.now() > balDeadline) { stopBalPolling(); return; }
    const r = await balRefreshCore();
    if (!r.ok) {
      if (!silent) mbSetMsg("pp-bal-pay-result", "✗ " + r.error, "var(--pp-danger)");
      return;
    }
    if (!silent) {
      const st = (r.order && r.order.status) || "";
      // 同上：fulfilled 的「✓ 已入账」由 renderBalPay 写，勿覆盖
      if (st !== "fulfilled") mbSetMsg("pp-bal-pay-result", "状态：" + (MB_STATUS[st] || st), "var(--pp-muted)");
    }
  }

  /** 提交「我已完成支付」（内联按钮与弹窗共用） */
  async function balClaimCore() {
    const A = account();
    if (!A || !balOrder) return { ok: false, error: "订单不存在" };
    try {
      balOrder = await A.claimOrder(balOrder.id);
      renderBalPay();
      syncOrderDlg();
      return { ok: true, order: balOrder };
    } catch (e) {
      return { ok: false, error: (e && e.message) || "提交失败" };
    }
  }

  async function onBalClaim() {
    const A = account();
    if (!A || !balOrder) return;
    mbSetMsg("pp-bal-pay-result", "正在提交…", "var(--pp-muted)");
    const r = await balClaimCore();
    if (!r.ok) return mbSetMsg("pp-bal-pay-result", "✗ " + r.error, "var(--pp-danger)");
    mbSetMsg("pp-bal-pay-result",
      "✓ 已提交，等待管理员核销（一般几分钟内）。可点「刷新订单状态」查看。", "var(--pp-success)");
    startBalPolling();
  }

  /**
   * 在线支付（0.50.0 / 服务端 1.7.0）：为当前充值订单创建网关收银台 → 系统浏览器扫码。
   * 只对「待支付」的订单可用（服务端同判）。
   * 支付成功后网关异步回调自动入账，面板轮询会看到 fulfilled。
   */
  async function balOnlinePayCore() {
    const A = account();
    if (!A || !balOrder) return { ok: false, error: "订单不存在" };
    try {
      const r = await A.startOnlinePay(balOrder.id, "alipay");
      try { Zotero.launchURL(r.payUrl); } catch (e) { /* 打不开浏览器也把地址留在提示里 */ }
      startBalPolling();
      return { ok: true, payUrl: r.payUrl };
    } catch (e) {
      return { ok: false, error: (e && e.message) || "发起在线支付失败" };
    }
  }

  async function onBalOnlinePay() {
    const A = account();
    if (!A || !balOrder) return;
    mbSetMsg("pp-bal-pay-result", "正在创建网关收银台…", "var(--pp-muted)");
    const r = await balOnlinePayCore();
    if (!r.ok) return mbSetMsg("pp-bal-pay-result", "✗ " + r.error, "var(--pp-danger)");
    mbSetMsg("pp-bal-pay-result",
      "✓ 收银台已在浏览器打开：扫码支付后自动到账（本窗口保持轮询）", "var(--pp-success)");
  }

  /** 取消订单（内联按钮与弹窗共用） */
  async function balCancelCore() {
    const A = account();
    if (!A || !balOrder) return { ok: false, error: "订单不存在" };
    try {
      await A.cancelOrder(balOrder.id);
      stopBalPolling();
      balOrder = null;
      const b = $("pp-bal-pay");
      if (b) b.style.display = "none";
      OrderDlg.close();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e && e.message) || "取消失败" };
    }
  }

  async function onBalCancel() {
    const A = account();
    if (!A || !balOrder) return;
    const r = await balCancelCore();
    if (r.ok) mbSetMsg("pp-bal-order-msg", "订单已取消，可重新生成", "var(--pp-muted)");
    else mbSetMsg("pp-bal-pay-result", "✗ " + r.error, "var(--pp-danger)");
  }

  async function onBalRefresh() {
    const A = account();
    if (!A || !A.isLoggedIn()) return;
    mbSetMsg("pp-bal-msg", "刷新中…", "var(--pp-muted)");
    try {
      await A.refreshUser();
      await ensureRechargeOptions(true);
      renderAll();
      mbSetMsg("pp-bal-msg", "✓ 余额已刷新", "var(--pp-success)");
    } catch (e) {
      mbSetMsg("pp-bal-msg", "✗ " + ((e && e.message) || "刷新失败"), "var(--pp-danger)");
    }
  }

  /* ---------- 激活码 ---------- */

  function onMbCodeToggle() {
    const row = $("pp-mb-code-row");
    if (!row) return;
    const show = row.style.display === "none";
    row.style.display = show ? "" : "none";
    if (show) { try { $("pp-mb-code-input").focus(); } catch (e) { /* ignore */ } }
  }

  async function onMbRedeem() {
    const A = account();
    const input = $("pp-mb-code-input");
    const btn = $("pp-mb-code-btn");
    if (!A || !input || !A.isLoggedIn()) return;
    const code = input.value.trim();
    if (!code) return mbSetMsg("pp-mb-result", "请输入激活码", "var(--pp-danger)");
    btn.disabled = true;
    mbSetMsg("pp-mb-result", "激活中…", "var(--pp-muted)");
    try {
      const r = await A.redeem(code);
      input.value = "";
      const m = (r && r.membership) || A.membership() || {};
      const expMs = m.expiresAt ? (Number(m.expiresAt) || Date.parse(m.expiresAt) || 0) : 0;
      mbSetMsg("pp-mb-result",
        "✓ 激活成功：" + (m.name || "专业版") + (expMs ? "，到期 " + fmtDate(expMs) : ""),
        "var(--pp-success)");
      renderAll();
    } catch (e) {
      mbSetMsg("pp-mb-result", "✗ " + ((e && e.message) || "激活失败"), "var(--pp-danger)");
    } finally {
      btn.disabled = false;
    }
  }

  /* ==================== 模型通道区块（移植通道面板） ==================== */

  function renderChannels() {
    const C = channels();
    if (!C || !$("pp-ch-list")) return;
    const { channels: chans, active } = C.list();
    const A = account();
    const loggedIn = A && A.isLoggedIn();

    /* 状态卡 */
    const st = $("pp-ch-status");
    st.innerHTML = "";
    const act = chans.find((c) => c.id === active);
    if (!act) {
      st.appendChild(el("span", { style: "color:var(--pp-danger);" }, "⚠ 没有活动通道，AI 功能不可用——请切换或新增一个通道。"));
    } else if (act.official && !loggedIn) {
      st.appendChild(el("span", { style: "color:var(--pp-warn);" },
        "● 活动通道「" + act.name + "」需要登录——请登录账号（官方模型按 AI 额度扣费），或切换到自己的通道。"));
    } else {
      const dot = el("span", { style: "color:var(--pp-success);" }, "● ");
      const b = el("b", null, act.name);
      const rest = el("span", { style: "color:var(--pp-muted);" },
        " " + act.model + " — 活动通道 · 共 " + chans.length + " 个已注册");
      st.appendChild(dot); st.appendChild(b); st.appendChild(rest);
    }

    /* 通道行 */
    const list = $("pp-ch-list");
    list.innerHTML = "";
    if (!chans.length) {
      list.appendChild(el("div", { class: "pp-hint" },
        "暂无通道，点击下方「新增通道」接入。"));
    }
    for (const c of chans) {
      list.appendChild(buildChannelRow(c, active === c.id));
    }
    $("pp-ch-form").style.display = "none";
  }

  function buildChannelRow(c, isActive) {
    const row = el("div", { class: "pp-ch-row" });

    const left = el("div", { style: "flex:1;min-width:0;" });
    const head = el("div", { class: "pp-ch-head" });
    head.appendChild(el("span", { class: "pp-ch-name" }, c.name));
    if (isActive) {
      head.appendChild(el("span", { class: "pp-pill pp-pill-ok" }, "活动中"));
    }
    if (c.official && !c.available) {
      head.appendChild(el("span", { class: "pp-pill pp-pill-warn" }, "未登录"));
    }
    left.appendChild(head);
    const sub = [displayUrl(c.baseUrl), c.model];
    if (c.models && c.models.length) sub.push(c.models.length + " 模型");
    if (c.provider && c.provider !== "official") {
      const p = channels().providerOf(c.provider);
      sub.push(p ? p.name : c.provider);
    }
    sub.push(c.apiKeyMasked);
    left.appendChild(el("div", { class: "pp-ch-sub" }, sub.join(" · ")));
    row.appendChild(left);

    /* 当前调用模型下拉（0.14.7）：改动立即生效，无需进编辑表单 */
    const modelBox = el("div", { style: "flex:none;max-width:170px;" });
    const modelSel = el("select", {
      class: "pp-input",
      style: "width:100%;font-size:12px;padding:2px 4px;",
      title: "该通道当前调用的模型（选择后立即生效）",
    });
    const opts = Array.isArray(c.models) && c.models.length ? c.models.slice() : [];
    if (c.model && !opts.includes(c.model)) opts.unshift(c.model);
    if (!opts.length) opts.push("auto");
    for (const m of opts) modelSel.appendChild(el("option", { value: m }, m));
    modelSel.value = c.model || opts[0];
    modelSel.addEventListener("change", () => onModelPick(c, modelSel.value, modelSel));
    modelBox.appendChild(modelSel);
    modelBox.appendChild(el("div", { class: "pp-ch-modelcap" }, "当前模型"));
    row.appendChild(modelBox);

    const acts = el("div", { style: "display:flex;gap:6px;flex:none;" });
    const mkBtn = (label, title) => el("button", {
      class: "pp-btn pp-btn-sm", title: title || "",
    }, label);
    if (!isActive) {
      const b = mkBtn("切换", "设为活动通道（全部 AI 功能经此通道）");
      b.addEventListener("click", () => onSwitch(c.id));
      acts.appendChild(b);
    }
    const bTest = mkBtn("测试连接", "小负荷真实调用一次，返回模型/延迟/应答");
    /* 行内反馈槽（0.72.2：测试结果写回本行右侧，不再跳卡片底部；
     * #pp-ch-test-result 保留为表单级错误兜底位） */
    const rowMsg = el("span", { class: "pp-msg", "aria-live": "polite" });
    bTest.addEventListener("click", () => onTest(c.id, bTest, rowMsg));
    acts.appendChild(bTest);
    const bEdit = mkBtn("参数", c.official ? "官方通道说明" : "编辑通道参数");
    bEdit.addEventListener("click", () => onEdit(c));
    acts.appendChild(bEdit);
    if (!c.official) {
      const bDel = mkBtn("删除");
      bDel.addEventListener("click", () => onDelete(c.id));
      acts.appendChild(bDel);
    }
    row.appendChild(acts);
    row.appendChild(rowMsg);
    return row;
  }

  async function onSwitch(id) {
    const r = channels().setActive(id);
    if (!r.ok) {
      const result = $("pp-ch-test-result");
      result.textContent = "✗ " + r.error;
      result.style.color = "var(--pp-danger)";
      return;
    }
    renderAll();
  }

  /** 通道行内模型下拉：选用该通道当前调用模型（部分更新，其余字段原样保留） */
  function onModelPick(c, model, sel) {
    const result = $("pp-ch-test-result");
    try {
      const r = channels().upsert({ id: c.id, model: model });
      if (!r || !r.ok) {
        result.textContent = "✗ 模型切换失败：" + ((r && r.error) || "未知错误");
        result.style.color = "var(--pp-danger)";
        sel.value = c.model; // 回退显示
        return;
      }
      result.textContent = "";
      result.appendChild(el("span", { style: "color:var(--pp-success);" },
        "✓ 「" + c.name + "」当前调用模型已切换为 " + model + "（立即生效）"));
      renderChannels(); // 状态卡/行内显示同步
    } catch (e) {
      result.textContent = "✗ 模型切换异常：" + (e && e.message || e);
      result.style.color = "var(--pp-danger)";
      sel.value = c.model;
    }
  }

  /** 防窥屏（0.43.2）：0.14.7 的「显示完整接口地址」开关已移除——
   *  地址与密钥一律掩码，面板不再提供任何明文出口。此函数仅清理历史 pref。 */
  function initShowUrlToggle() {
    try { Zotero.Prefs.clear(PREF_PREFIX + "uiShowFullUrl", true); } catch (e) { /* ignore */ }
  }

  async function onTest(id, btn, msgEl) {
    // 行内优先：结果写回本行 .pp-msg 槽；无槽时回退卡片底部表单级兜底位
    const result = msgEl || $("pp-ch-test-result");
    btn.disabled = true;
    btn.textContent = "…";
    result.textContent = "测试连接中（真实调用一次）…";
    result.style.color = "var(--pp-muted)";
    try {
      const j = await channels().testChannel(id);
      if (j.ok) {
        result.textContent = "";
        result.appendChild(el("span", { style: "color:var(--pp-success);" },
          "✓ 成功 · 模型 " + j.model + " · 延迟 " + j.latencyMs + "ms · 应答「" + (j.reply || "") + "」"));
      } else {
        result.textContent = "";
        result.appendChild(el("span", { style: "color:var(--pp-danger);" },
          "✗ 失败 · " + (j.error || "未知错误")));
      }
    } catch (e) {
      result.textContent = "✗ 失败 · " + (e && e.message || "测试连接异常");
      result.style.color = "var(--pp-danger)";
    } finally {
      btn.disabled = false;
      btn.textContent = "测试连接";
    }
  }

  function onEdit(c) {
    if (c.official) {
      const result = $("pp-ch-test-result");
      result.textContent = "";
      result.appendChild(el("span", { style: "color:var(--pp-muted);" },
        "官方通道由账号系统管理：模型在上方账号卡片选择（按 AI 额度扣费）；如需自定义接口请「＋ 新增通道」。"));
      return;
    }
    openForm(c);
  }

  function onDelete(id) {
    const win = Zotero.getMainWindow();
    const ok = Services_promptConfirm(win,
      "Papilot",
      "删除通道 " + id + "？（该通道的配置与密钥将被移除，不影响其他通道）");
    if (!ok) return;
    channels().remove(id);
    renderChannels();
  }

  /** Services.prompt.confirm 的安全包装（面板作用域没有 Services） */
  function Services_promptConfirm(win, title, msg) {
    try {
      // Zotero 7+ 面板窗口可以经 Zotero 导出的 Prompter 走主窗口确认框
      const ps = Components.classes["@mozilla.org/embedcomp/prompt-service;1"]
        .getService(Components.interfaces.nsIPromptService);
      return ps.confirm(win, title, msg);
    } catch (e) {
      return window.confirm(msg);
    }
  }

  /** Services.prompt.prompt 的安全包装：单行输入。取消返回 null。 */
  function Services_promptInput(win, title, msg, value) {
    try {
      const ps = Components.classes["@mozilla.org/embedcomp/prompt-service;1"]
        .getService(Components.interfaces.nsIPromptService);
      const input = { value: String(value == null ? "" : value) };
      if (!ps.prompt(win, title, msg, input, null, null)) return null;
      return input.value;
    } catch (e) {
      try { return window.prompt(msg, value); } catch (e2) { return null; }
    }
  }

  /* ---------- 通道编辑表单（原项目 mf-* 逻辑移植） ---------- */

  let mfEditing = null;   // 编辑中的通道 id；null = 新增
  let mfModels = [];      // 模型列表工作副本

  function fillProviderSelect() {
    const sel = $("pp-mf-provider");
    if (!sel || sel.options.length) return;
    for (const p of channels().PROVIDERS) {
      sel.appendChild(el("option", { value: p.id }, p.name));
    }
  }

  function providerPreset(id) {
    return channels().PROVIDERS.find((p) => p.id === id) || null;
  }

  function syncProviderNote() {
    const p = providerPreset($("pp-mf-provider").value);
    $("pp-mf-provider-note").textContent = p ? (p.note || "") : "";
  }

  function onProviderChange() {
    const p = providerPreset(this.value);
    syncProviderNote();
    if (!p) return;
    if (p.baseUrl) $("pp-mf-baseUrl").value = p.baseUrl;
    const cur = $("pp-mf-model").value.trim();
    if (!cur || cur === "auto") $("pp-mf-model").value = (p.models && p.models[0]) || cur;
    const extra = $("pp-mf-extraBody").value.trim();
    if (!extra && p.extraBody && Object.keys(p.extraBody).length) {
      $("pp-mf-extraBody").value = JSON.stringify(p.extraBody);
    }
    if (!mfModels.length && p.models) {
      mfModels = p.models.slice();
      renderModelChips();
    }
  }

  function renderModelChips() {
    const box = $("pp-mf-models");
    box.innerHTML = "";
    if (!mfModels.length) {
      box.appendChild(el("span", { class: "pp-hint" },
        "暂无模型，可拉取上游或手动添加；点击模型名即设为默认模型"));
      return;
    }
    const cur = ($("pp-mf-model").value || "").trim();
    mfModels.forEach((m, i) => {
      const selected = m === cur;
      // 0.72.3 无障碍：pill 只负责外观，内部放两个**同级**真按钮
      // （按钮不能嵌套按钮）——「设为默认」与「移除」各自键盘可达、各有独立无障碍名。
      const chip = el("span", {
        class: selected ? "pp-chip pp-chip-on" : "pp-chip",
      });
      const pick = el("button", {
        type: "button",
        class: "pp-chip-pick",
        title: "设为该通道默认模型",
        "aria-pressed": selected ? "true" : "false",
        "aria-label": "设为默认模型 " + m,
        style: "appearance:none;background:none;border:0;padding:0;font:inherit;color:inherit;cursor:pointer",
      }, m);
      pick.addEventListener("click", () => {
        $("pp-mf-model").value = m;
        renderModelChips();
      });
      const x = el("button", {
        type: "button",
        class: "pp-chip-x",
        title: "从列表移除",
        "aria-label": "从列表移除 " + m,
        style: "appearance:none;background:none;border:0;padding:0;font-family:inherit;font-size:inherit;cursor:pointer",
      }, "×");
      x.addEventListener("click", () => {
        mfModels.splice(i, 1);
        renderModelChips();
      });
      chip.appendChild(pick);
      chip.appendChild(x);
      box.appendChild(chip);
    });
  }

  function onModelAdd() {
    const v = $("pp-mf-model-add").value.trim();
    if (!v) return;
    if (!mfModels.includes(v)) mfModels.push(v);
    $("pp-mf-model-add").value = "";
    renderModelChips();
  }

  async function onModelsFetch() {
    const btn = $("pp-mf-models-fetch");
    const C = channels();
    // 防窥屏：编辑时 baseUrl 留空 = 用原通道地址（与 onSave/onDetect 同口径）
    let baseUrl = $("pp-mf-baseUrl").value.trim();
    if (!baseUrl && mfEditing) baseUrl = (C.getChannel(mfEditing) || {}).baseUrl || "";
    let apiKey = $("pp-mf-apiKey").value.trim();
    if (!apiKey && mfEditing) {
      apiKey = (C.getChannel(mfEditing) || {}).apiKey || ""; // 编辑时留空 = 用原密钥
    }
    if (!baseUrl) {
      setDetectResult("请先填写接口地址", "var(--pp-danger)");
      return;
    }
    btn.disabled = true;
    btn.textContent = "拉取中";
    try {
      const j = await C.fetchModels({ baseUrl, apiKey, timeoutMs: 8000 });
      if (j.ok) {
        mfModels = j.models || [];
        renderModelChips();
        setDetectResult("✓ 拉到 " + mfModels.length + " 个模型", "var(--pp-success)");
      } else {
        setDetectResult("✗ 拉取失败：" + j.error, "var(--pp-danger)");
      }
    } finally {
      btn.disabled = false;
      btn.textContent = "拉取";   // 0.72.3：按钮文字已自解释，不再挂图标（与 xhtml 初始文案一致）
    }
  }

  async function onDetect() {
    const btn = $("pp-mf-detect");
    const C = channels();
    const key = $("pp-mf-apiKey").value.trim();
    // 防窥屏：编辑时 baseUrl 留空 = 用原通道地址
    let baseUrl = $("pp-mf-baseUrl").value.trim();
    if (!baseUrl && mfEditing) baseUrl = (C.getChannel(mfEditing) || {}).baseUrl || "";
    if (!key && !baseUrl) {
      setDetectResult("请先填写 API Key 或接口地址", "var(--pp-danger)");
      return;
    }
    let apiKey = key;
    if (!apiKey && mfEditing) apiKey = (C.getChannel(mfEditing) || {}).apiKey || "";
    btn.disabled = true;
    btn.textContent = "检测中";
    setDetectResult("探测中（识别厂商并拉取模型）…", "var(--pp-muted)");
    try {
      const j = await C.detectChannel({ apiKey, baseUrl });
      if (j.ok) {
        const p = providerPreset(j.provider);
        if (p) { $("pp-mf-provider").value = j.provider; syncProviderNote(); }
        if (j.baseUrl) $("pp-mf-baseUrl").value = j.baseUrl;
        mfModels = j.models || [];
        renderModelChips();
        const cur = $("pp-mf-model").value.trim();
        if (mfModels.length && (!cur || !mfModels.includes(cur))) $("pp-mf-model").value = mfModels[0];
        if (!$("pp-mf-name").value.trim() && j.providerName) $("pp-mf-name").value = j.providerName + " 通道";
        setDetectResult("✓ 识别为 " + (j.providerName || j.provider) + "：" + mfModels.length + " 个模型" +
          (j.latencyMs ? "，" + j.latencyMs + "ms" : ""), "var(--pp-success)");
      } else {
        if (j.provider && providerPreset(j.provider)) {
          $("pp-mf-provider").value = j.provider;
          syncProviderNote();
        }
        setDetectResult("✗ " + (j.error || "检测失败"), "var(--pp-danger)");
      }
    } catch (e) {
      setDetectResult("✗ " + (e && e.message || "检测异常"), "var(--pp-danger)");
    } finally {
      btn.disabled = false;
      btn.textContent = "检测";   // 0.72.3：同上，去图标只留文字
    }
  }

  function setDetectResult(msg, color) {
    const r = $("pp-mf-detect-result");
    r.textContent = msg;
    r.style.color = color || "var(--pp-muted)";
  }

  function openForm(c) {
    fillProviderSelect();
    mfEditing = c ? c.id : null;
    $("pp-mf-id").value = c ? c.id : "";
    $("pp-mf-id").disabled = !!c;
    $("pp-mf-name").value = c ? c.name : "";
    // 防窥屏（0.43.2）：编辑不回填明文 baseUrl——占位显示掩码，留空 = 保持原地址
    $("pp-mf-baseUrl").value = "";
    $("pp-mf-baseUrl").placeholder = c
      ? "留空保持原地址（当前 " + maskUrl(c.baseUrl) + "）"
      : "https://api.example.com/v1";
    $("pp-mf-apiKey").value = "";
    $("pp-mf-apiKey").placeholder = c ? "留空保持不变（当前 " + c.apiKeyMasked + "）" : "sk-...";
    $("pp-mf-model").value = c ? c.model : "auto";
    $("pp-mf-model-add").value = "";
    $("pp-mf-extraBody").value = c && c.extraBody && Object.keys(c.extraBody).length
      ? JSON.stringify(c.extraBody) : "";
    $("pp-mf-timeoutMs").value = c ? c.timeoutMs : 12000;
    mfModels = c && Array.isArray(c.models) ? c.models.slice() : [];
    const pv = c ? (c.provider || "") : "";
    $("pp-mf-provider").value = providerPreset(pv) ? pv : (pv || "custom");
    syncProviderNote();
    renderModelChips();
    setDetectResult("", "var(--pp-muted)");
    $("pp-mf-err").textContent = "";
    $("pp-ch-form").style.display = "";
    try { $("pp-mf-id").focus(); } catch (e) { /* ignore */ }
  }

  function onSave() {
    const C = channels();
    const errEl = $("pp-mf-err");
    const existing = mfEditing ? C.getChannel(mfEditing) : null;
    let extra = {};
    const raw = $("pp-mf-extraBody").value.trim();
    if (raw) {
      try { extra = JSON.parse(raw); } catch (e) {
        errEl.textContent = "附加参数不是合法 JSON";
        return;
      }
    }
    const providerId = $("pp-mf-provider").value;
    const preset = providerPreset(providerId);
    // 防窥屏：编辑时 baseUrl 留空 = 保持原地址（不回填明文的前提下仍可保存）
    const baseUrl = $("pp-mf-baseUrl").value.trim() || (existing ? existing.baseUrl : "");
    const d = {
      id: mfEditing || $("pp-mf-id").value.trim(),
      name: $("pp-mf-name").value.trim(),
      provider: providerId,
      baseUrl,
      apiKey: $("pp-mf-apiKey").value.trim(),
      model: $("pp-mf-model").value.trim() || "auto",
      models: mfModels,
      extraBody: extra,
      timeoutMs: Number($("pp-mf-timeoutMs").value) || 12000,
    };
    if (!d.id || !/^[a-z0-9-]+$/.test(d.id)) { errEl.textContent = "通道 id 必填（小写字母/数字/连字符）"; return; }
    if (!d.baseUrl && !existing) { errEl.textContent = "接口地址必填"; return; }
    const noKeyOk = preset && (preset.noKey || /127\.0\.0\.1|localhost/.test(d.baseUrl));
    if (!d.apiKey && !mfEditing && !noKeyOk) { errEl.textContent = "API Key 必填（本地免密接口除外）"; return; }
    const r = C.upsert(d);
    if (!r.ok) { errEl.textContent = r.error || "保存失败"; return; }
    $("pp-ch-form").style.display = "none";
    renderChannels();
  }

  /* ==================== 装配 ==================== */

  function renderAll() {
    try { renderAccount(); } catch (e) { /* ignore */ }
    // 登录设备是异步拉取的，失败时自行隐藏，不影响其余渲染
    try { renderDevices(); } catch (e) { /* ignore */ }
    try { renderMembership(); } catch (e) { /* ignore */ }
    try { renderBalance(); } catch (e) { /* ignore */ }
    // R4/R5：订单与扣费明细同样异步拉取、失败自行整块隐藏（函数内部已包 try）
    try { renderOrders(); } catch (e) { /* ignore */ }
    try { renderLedger(); } catch (e) { /* ignore */ }
    try { renderChannels(); } catch (e) { /* ignore */ }
  }

  let _offSession = null; // 会话变化回调句柄（窗口关闭必须注销）

  function init() {
    if (typeof Zotero === "undefined" || !Zotero.Papilot || !account() || !channels()) {
      window.setTimeout(init, 400);
      return;
    }
    if (!$("pp-login-btn") || !$("pp-ch-add")) {
      window.setTimeout(init, 300);
      return;
    }
    if (init._done) return;
    init._done = true;

    const bind = (id, ev, fn) => { const node = $(id); if (node) node.addEventListener(ev, fn); };
    // 账号
    bind("pp-login-btn", "click", onLogin);
    bind("pp-login-password", "keydown", (e) => { if (e.key === "Enter") onLogin(); });
    bind("pp-register-link", "click", () => showRegister(true));
    bind("pp-reg-back", "click", () => showRegister(false));
    bind("pp-reg-btn", "click", onRegister);
    bind("pp-reg-password2", "keydown", (e) => { if (e.key === "Enter") onRegister(); });
    bind("pp-reg-resend", "click", onResendVerify);
    bind("pp-forgot-link", "click", onForgotLink);
    bind("pp-logout-btn", "click", onLogout);
    // 邮箱默认脱敏：点一下显示完整地址，再点收起（截图/投屏场景下默认不露明文）
    bind("pp-account-email", "click", () => { emailShown = !emailShown; renderAccount(); });
    bind("pp-account-refresh", "click", onRefreshAccount);
    bind("pp-account-official-model", "change", onOfficialModelChange);
    // 免费版 vs 专业版对照表默认收起（8 行表常驻会把「当前套餐 / 升级」挤出首屏）：
    // 点一下展开，再点收起；键盘 Enter/Space 同样可用（HTML span 不会自己派发 click）
    const cmpToggle = $("pp-mb-compare-toggle");
    if (cmpToggle) {
      // 状态用变量持有、由 syncCompare 单向写 DOM：不去反读 inline style
      // （反读会把「样式被打包/XUL 属性化后读不到」变成功能失效）。初值 false 与 xhtml 的
      // style="display:none;" 一致。
      let cmpShown = false;
      const syncCompare = () => {
        const box = $("pp-mb-compare");
        if (box) box.style.display = cmpShown ? "" : "none";
        cmpToggle.textContent = cmpShown ? "免费版 vs 专业版差异 ▴" : "免费版 vs 专业版差异 ▾";
        cmpToggle.setAttribute("aria-expanded", cmpShown ? "true" : "false");
      };
      syncCompare();   // 进面板先对齐一次（文案/aria 与收起态一致）
      const toggleCompare = () => { cmpShown = !cmpShown; syncCompare(); };
      cmpToggle.addEventListener("click", toggleCompare);
      cmpToggle.addEventListener("keydown", (e) => {
        if (!e) return;
        const k = e.key;
        // Space / Spacebar（老 Gecko 写法）/ Enter
        if (k !== "Enter" && k !== " " && k !== "Spacebar") return;
        if (e.preventDefault) e.preventDefault();   // 空格不滚页面
        toggleCompare();
      });
    }
    // 0.66.0 账号与密钥中心（Pro）：独立窗口，单例复用
    bind("pp-vault-open", "click", () => {
      try { Zotero.Papilot.openVault(); } catch (e) { /* 窗口打不开不影响账号卡 */ }
    });
    // 会员（0.23.0）
    bind("pp-mb-upgrade", "click", onMbUpgrade);
    bind("pp-mb-coupon-btn", "click", onMbCoupon);
    bind("pp-dev-refresh", "click", renderDevices);
    bind("pp-dev-kick-others", "click", onKickOtherDevices);
    bind("pp-mb-renew", "click", onMbRenew);
    bind("pp-mb-create", "click", onMbCreate);
    bind("pp-mb-close-order", "click", () => { const b = $("pp-mb-order"); if (b) b.style.display = "none"; });
    bind("pp-mb-claim", "click", onMbClaim);
    bind("pp-mb-online", "click", onMbOnlinePay);
    bind("pp-mb-poll", "click", () => onMbPoll(false));
    bind("pp-mb-cancel", "click", onMbCancel);
    // 0.49.0 付款单弹窗：内联区「查看付款单」重开（自动弹出只在生成订单时发生一次）
    bind("pp-mb-order-view", "click", () => { if (mbOrder) openOrderDlg(mbOrder, "plan"); });
    bind("pp-mb-refresh", "click", onMbRefresh);
    bind("pp-mb-code-toggle", "click", onMbCodeToggle);
    bind("pp-mb-code-btn", "click", onMbRedeem);
    bind("pp-mb-code-input", "keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); onMbRedeem(); } });
    // AI 额度余额（0.26.0）
    bind("pp-bal-recharge-toggle", "click", onBalRechargeToggle);
    bind("pp-bal-create", "click", onBalCreate);
    bind("pp-bal-claim", "click", onBalClaim);
    bind("pp-bal-online", "click", onBalOnlinePay);
    bind("pp-bal-poll", "click", () => onBalPoll(false));
    bind("pp-bal-cancel", "click", onBalCancel);
    bind("pp-bal-order-view", "click", () => { if (balOrder) openOrderDlg(balOrder, "credit"); });
    bind("pp-bal-refresh", "click", onBalRefresh);
    bind("pp-bal-close", "click", () => { const b = $("pp-bal-recharge"); if (b) b.style.display = "none"; });
    // 通道
    bind("pp-ch-add", "click", () => openForm(null));
    bind("pp-mf-provider", "change", onProviderChange);
    bind("pp-mf-models-add", "click", onModelAdd);
    bind("pp-mf-model-add", "keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); onModelAdd(); } });
    bind("pp-mf-models-fetch", "click", onModelsFetch);
    bind("pp-mf-detect", "click", onDetect);
    bind("pp-mf-save", "click", onSave);
    bind("pp-mf-cancel", "click", () => { $("pp-ch-form").style.display = "none"; });
    // 2026-10-23 增强：R3/R4/R5 折叠区（展开时重新拉取数据，保持新鲜）
    histFold = makeFold("pp-mb-history-toggle", "pp-mb-history", "开通/续期记录", null);
    ordersFold = makeFold("pp-orders-toggle", "pp-orders-block", "我的订单", () => {
      ordersLoaded = false;
      renderOrders();
    });
    ledgerFold = makeFold("pp-ledger-toggle", "pp-ledger-block", "最近扣费明细", () => {
      ledgerLoaded = false;
      renderLedger();
    });
    // R1 修改密码
    bind("pp-cpw-toggle", "click", onCpwToggle);
    bind("pp-cpw-submit", "click", onCpwSubmit);
    bind("pp-cpw-cancel", "click", onCpwCancel);
    bind("pp-cpw-new2", "keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); onCpwSubmit(); } });
    // R8 余额不足 → 展开「模型通道」卡
    bind("pp-bal-open-channels", "click", onBalOpenChannels);
    // R2 注册赠送/每月发放文案：未登录视图也要渲染，独立拉取（不走 ensurePlans 的登录门槛）
    if (!grantTried) { grantTried = true; loadGrantCopy(); }
    initShowUrlToggle();

    renderAll();

    // 账号会话在别处变化（后台 401 失效/启动恢复完成）→ 面板即时对齐
    _offSession = account().onSessionChanged(renderAll);
    window.addEventListener("unload", () => {
      if (_offSession) { try { _offSession(); } catch (e) { /* ignore */ } _offSession = null; }
      stopMbPolling(); // 面板关闭必须停掉订单轮询，否则定时器泄漏
      stopBalPolling(); // 充值订单轮询同理
    });
  }

  init();
  if (typeof window !== "undefined" && window.setTimeout) {
    window.setTimeout(init, 400);
    window.setTimeout(init, 1200);
  }
})();
