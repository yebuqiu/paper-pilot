/* PaperPilot 更新提示（0.37.1）
 *
 * 为什么需要它：Zotero 对第三方插件的更新是**静默后台替换**（启动时查 update_url、
 * 下载、替换 profile 里的 xpi、下次启动生效），**不弹任何提示**。用户视角就是
 * 「我发了新版，但 Zotero 里什么都没发生」—— 实际上早就更新完了，只是没有任何反馈。
 * 本模块补上这个反馈：启动后台检查一次更新清单，**只有确实有更高版本时**才弹出
 * Zotero 原生进度通知（含「Zotero 会在后台自动更新，重启生效」），并把版本写进
 * `updateNoticeLastVersion` → **同一版本只提示一次**，不骚扰。
 *
 * 0.44.1 增强（用户报「以前能看到更新了哪些内容，现在没有了」）：
 *   · 更新清单条目新增 `whatsNew` 字段（更新摘要，可多行）→ 通知里直接展示；
 *   · 新增 `updateNoticeLastSeen`（上次"运行过"的版本）→ 即使更新是 Zotero 静默
 *     完成的（或用户手动装机），下次启动也会弹一次「✓ 已更新到 vX · 本次更新内容：…」，
 *     每版只提示一次。
 *
 * 边界：
 *   · pref `updateNoticeEnabled` 默认开（可在设置 → 增强功能里关）；
 *   · 网络失败/超时/JSON 异常一律**静默**（只写 Zotero.debug），绝不弹错误窗；
 *   · 当前版本 ≥ 清单最新 → 静默（本机已是最新，没什么可说的）；
 *   · UPDATE_URL 必须与 manifest 的 applications.zotero.update_url 一致
 *     （check-wiring 有断言钉住，防止两处漂移）。
 */
/* global Zotero, Prefs, I18n */

var UpdateNotice = {
  /** 与 manifest.json 的 applications.zotero.update_url 保持一致（门禁有断言） */
  UPDATE_URL: "https://gitee.com/cassiuschen9261/paper-pilot/raw/main/paperpilot-update.json",
  ADDON_ID: "paperpilot@dev.local",
  PREF_ENABLED: "updateNoticeEnabled",
  PREF_LAST: "updateNoticeLastVersion",
  // 0.44.1：上次「运行过」的版本（识别静默更新完成 → 弹「已更新到 vX」；每版只提示一次）
  PREF_SEEN: "updateNoticeLastSeen",
  DELAY_MS: 15000,          // 启动后台跑，不拖慢启动
  TIMEOUT_MS: 8000,

  _timer: null,

  /**
   * 版本比较（纯函数）。只比较数字段，忽略非数字后缀（如 1.0.0-beta）。
   * @returns {number} a<b → -1；a===b → 0；a>b → 1
   */
  compareVersion(a, b) {
    const norm = (v) => String(v == null ? "" : v).trim().replace(/^v/i, "")
      .split(/[.\-+]/).map((x) => {
        const n = parseInt(x, 10);
        return isFinite(n) ? n : 0;
      });
    const A = norm(a);
    const B = norm(b);
    const len = Math.max(A.length, B.length);
    for (let i = 0; i < len; i++) {
      const x = A[i] || 0;
      const y = B[i] || 0;
      if (x < y) return -1;
      if (x > y) return 1;
    }
    return 0;
  },

  /**
   * 从更新清单里取最高版本（纯函数）。
   * 清单结构：{addons: {"paperpilot@dev.local": {updates: [{version, update_link, ...}]}}}
   * @returns {string} 最高版本号（清单不可用时返回 ""）
   */
  latestVersion(json) {
    try {
      const ups = json && json.addons && json.addons[this.ADDON_ID] &&
        json.addons[this.ADDON_ID].updates;
      if (!Array.isArray(ups) || !ups.length) return "";
      let best = "";
      for (const u of ups) {
        const v = u && u.version ? String(u.version) : "";
        if (!v) continue;
        if (!best || this.compareVersion(v, best) > 0) best = v;
      }
      return best;
    } catch (e) {
      return "";
    }
  },

  /** 从清单里取指定版本的条目（纯函数） → 条目对象 | null */
  entryOf(json, version) {
    try {
      const ups = json && json.addons && json.addons[this.ADDON_ID] &&
        json.addons[this.ADDON_ID].updates;
      if (!Array.isArray(ups)) return null;
      const want = String(version == null ? "" : version).trim().replace(/^v/i, "");
      if (!want) return null;
      for (const u of ups) {
        if (u && String(u.version || "").replace(/^v/i, "") === want) return u;
      }
      return null;
    } catch (e) {
      return null;
    }
  },

  /** 指定版本的更新说明（清单条目的 whatsNew 字段；纯函数） → 字符串（可空） */
  whatsNewOf(json, version) {
    const e = this.entryOf(json, version);
    return e && e.whatsNew ? String(e.whatsNew) : "";
  },

  enabled() {
    try { return Prefs.get(this.PREF_ENABLED, true) !== false; } catch (e) { return true; }
  },

  lastNotified() {
    try { return String(Prefs.get(this.PREF_LAST, "") || ""); } catch (e) { return ""; }
  },

  setLastNotified(v) {
    try { Prefs.set(this.PREF_LAST, String(v || "")); } catch (e) { /* ignore */ }
  },

  lastSeen() {
    try { return String(Prefs.get(this.PREF_SEEN, "") || ""); } catch (e) { return ""; }
  },

  setLastSeen(v) {
    try { Prefs.set(this.PREF_SEEN, String(v || "")); } catch (e) { /* ignore */ }
  },

  /**
   * 检查一次。返回诊断对象（**永不抛异常**）：
   * {checked, current, latest, newer, notified, skipped}
   */
  async check(currentVersion) {
    const out = { checked: false, current: String(currentVersion || ""), latest: "", newer: false, notified: false, updated: false };
    if (!this.enabled()) { out.skipped = "disabled"; return out; }
    let json = null;
    try {
      const xhr = await Zotero.HTTP.request("GET", this.UPDATE_URL, {
        responseType: "json",
        timeout: this.TIMEOUT_MS,
      });
      json = xhr && xhr.response ? xhr.response : null;
      if (typeof json === "string") json = JSON.parse(json);
    } catch (e) {
      out.skipped = "network: " + String((e && e.message) || e);
      try { Zotero.debug("PaperPilot UpdateNotice: 检查失败（静默）：" + out.skipped); } catch (_) { /* ignore */ }
      return out;
    }
    out.checked = true;
    const latest = this.latestVersion(json);
    out.latest = latest;

    // ★ 0.44.1：先处理「刚更新完」——上次运行版本 ≠ 当前版本（且是升级）→ 展示一次
    //   「已更新到 vX · 本次更新内容」（即使更新是 Zotero 静默完成的，用户也能看到更新了什么）。
    const seen = this.lastSeen();
    if (seen && seen !== out.current && this.compareVersion(out.current, seen) > 0) {
      this._notifyUpdated(out.current, this.whatsNewOf(json, out.current));
      out.updated = true;
      out.updatedFrom = seen;
    }
    // 无论是否提示，都记录这次「运行过的版本」（下次再变化 = 又更新过一轮）
    this.setLastSeen(out.current);

    if (!latest) { out.skipped = "empty-manifest"; return out; }
    out.newer = this.compareVersion(latest, out.current) > 0;
    if (!out.newer) { out.skipped = "up-to-date"; return out; }
    // 同一版本只提示一次（用户看到过就不重复打扰）
    if (this.lastNotified() === latest) { out.skipped = "already-notified"; return out; }
    this._notify(latest, out.current, this.whatsNewOf(json, latest));
    this.setLastNotified(latest);
    out.notified = true;
    return out;
  },

  /** 更新摘要拆行（纯函数）：≤4 行、去空行、每行截断 80 字符 */
  _whatsNewLines(whatsNew) {
    return String(whatsNew || "").split(/\r?\n+/)
      .map((s) => s.trim()).filter(Boolean)
      .slice(0, 4).map((s) => (s.length > 80 ? s.slice(0, 79) + "…" : s));
  },

  _notify(latest, current, whatsNew) {
    try {
      const zh = !!(I18n && I18n.isZh);
      const pw = new Zotero.ProgressWindow({ closeOnClick: true });
      pw.changeHeadline("PaperPilot");
      pw.addDescription(zh
        ? "发现新版本 v" + latest + "（当前 v" + current + "）"
        : "New version v" + latest + " available (current v" + current + ")");
      pw.addDescription(zh
        ? "Zotero 会在后台自动更新，重启 Zotero 后生效"
        : "Zotero updates it in the background — restart Zotero to apply");
      for (const l of this._whatsNewLines(whatsNew)) { pw.addDescription("· " + l); }
      pw.show();
      try { pw.startCloseTimer(12000); } catch (e) { /* 老版本可能没有该方法 */ }
    } catch (e) {
      try { Zotero.logError(e); } catch (_) { /* ignore */ }
    }
  },

  /** 0.44.1：更新完成后的「✓ 已更新到 vX · 本次更新内容：…」提示（每版一次） */
  _notifyUpdated(version, whatsNew) {
    try {
      const zh = !!(I18n && I18n.isZh);
      const pw = new Zotero.ProgressWindow({ closeOnClick: true });
      pw.changeHeadline("PaperPilot");
      pw.addDescription(zh ? "✓ 已更新到 v" + version : "✓ Updated to v" + version);
      const lines = this._whatsNewLines(whatsNew);
      if (lines.length) {
        pw.addDescription(zh ? "本次更新内容：" : "What's new:");
        for (const l of lines) { pw.addDescription("· " + l); }
      } else {
        pw.addDescription(zh ? "本次更新暂无详细说明" : "No detailed notes for this update");
      }
      pw.show();
      try { pw.startCloseTimer(15000); } catch (e) { /* ignore */ }
    } catch (e) {
      try { Zotero.logError(e); } catch (_) { /* ignore */ }
    }
  },

  /**
   * 启动后台检查一次（延迟 DELAY_MS，不阻塞初始化）。
   * @param {string} pluginID
   * @param {string} currentVersion
   * @param {Function} [onResult] 检查结果回调（main.js 用它写 boot 日志，便于实机验证）
   */
  register(pluginID, currentVersion, onResult) {
    this.unregister();
    if (!this.enabled()) {
      if (typeof onResult === "function") {
        try { onResult({ skipped: "disabled" }); } catch (e) { /* ignore */ }
      }
      return false;
    }
    this._current = currentVersion || "";
    this._timer = setTimeout(() => {
      this._timer = null;
      this.check(this._current)
        .then((r) => { if (typeof onResult === "function") { try { onResult(r); } catch (e) { /* ignore */ } } })
        .catch(() => { /* check 内部已吞异常 */ });
    }, this.DELAY_MS);
    return true;
  },

  unregister() {
    try {
      if (this._timer) clearTimeout(this._timer);
    } catch (e) { /* ignore */ }
    this._timer = null;
  },
};
