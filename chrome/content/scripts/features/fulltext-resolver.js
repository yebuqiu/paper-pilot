/* PaperPilot 原生 Find Full Text 集成（0.43.0）
 * 做法与开源插件 zotero-scipdf 相同：不造 UI，把 resolver 写进 Zotero 内置隐藏 pref
 *   extensions.zotero.findPDFs.resolvers（JSON 字符串数组），复用 Zotero 原生
 * 「查找全文」（右键无附件条目 → Find Full Text / Find Available PDF）与
 * 首选项「自动下载 PDF」流程（automatic: true 的 resolver 参与自动下载）。
 *
 * 机制依据（Zotero 7 ～ 10 通用，main 分支 attachments.js 未变）：
 *   - getFileResolvers() 顺序固定为 内置 doi 页 → url 页 → oa（Unpaywall 镜像）→ custom，
 *     custom 段按 pref 数组顺序逐个执行，命中即停 —— 合法 OA 天然先于 Sci-Hub；
 *   - 每条 resolver 必填：name / method(GET|POST) / url(必须含 {doi}) / mode(html|json) / selector；
 *     html 模式可选 attribute/index；json 模式可选 mappings{url,pageURL}；automatic 默认 false；
 *   - url 只支持 {doi} 一个变量（无 {title}）。
 *
 * 本模块纪律：
 *   - 只增删 name 以 "PaperPilot - " 开头的条目，用户手写或其它插件的 resolver 原样保留；
 *   - register() 幂等（先清掉自己旧条目再按当前开关/镜像重建），重复调用不产生重复；
 *   - Sci-Hub/Sci-Net 尊重现有开关（scihubEnabled / scinetEnabled），关则不注入；
 *   - 卸载/关闭时 unregister() 精确移除，不污染用户配置。
 *
 * 与自有右键「补全文」（oa-fetch.js）并存：那边是带进度与报告的增强版，不动。
 * pref：fulltextResolverEnabled（本集成总开关，默认开）。
 */
/* global Zotero, Prefs */

var FullTextResolver = {
  // Zotero 原生 pref 全名（Zotero.Prefs.get/set 需 global=true 直传全名）
  PREF: "extensions.zotero.findPDFs.resolvers",
  NAME_PREFIX: "PaperPilot - ",
  // 与 scihub.js 保持一致（0.43.0 扩为 7 镜像；此处独立副本以保持模块自包含，改时两处同步）
  DEFAULT_MIRRORS: [
    "https://sci-hub.ru", "https://sci-hub.se", "https://sci-hub.st",
    "https://sci-hub.ren", "https://sci-hub.ee",
    "https://sci-hub.hkvisa.net", "https://sci-hub.mksa.top",
  ],
  DEFAULT_SCINET: "https://sci-net.xyz",
  DEFAULT_EMAIL: "paperpilot@users.noreply.local",

  _debug(msg) {
    try { Zotero.debug("PaperPilot fulltext-resolver: " + msg); } catch (e) { /* ignore */ }
  },

  /** 读取 Zotero resolver pref → 数组（容忍未设 / 坏 JSON / 单对象写法） */
  _read() {
    let raw = "";
    try { raw = Zotero.Prefs.get(this.PREF, true); } catch (e) { return []; }
    if (!raw || typeof raw !== "string") return [];
    let arr;
    try { arr = JSON.parse(raw); } catch (e) {
      this._debug("findPDFs.resolvers JSON 解析失败，按空处理（不覆盖用户原值，仅追加时整体重写）");
      return [];
    }
    if (!Array.isArray(arr)) arr = (arr && typeof arr === "object") ? [arr] : [];
    return arr.filter((r) => r && typeof r === "object");
  },

  _isOurs(r) {
    return !!(r && typeof r.name === "string" && r.name.indexOf(this.NAME_PREFIX) === 0);
  },

  /** 镜像列表（与 scihub.js 同一 pref、同一规范化；此处独立解析以保持模块自包含） */
  _mirrors() {
    let raw = "";
    try { raw = String(Prefs.get("scihubMirrors", "") || ""); } catch (e) { /* ignore */ }
    const list = raw.split(/[,，;\n]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (/^https?:\/\//i.test(s) ? s : "https://" + s).replace(/\/+$/, ""));
    return list.length ? list : this.DEFAULT_MIRRORS.slice();
  },

  _scinetBase() {
    let raw = "";
    try { raw = String(Prefs.get("scinetUrl", "") || ""); } catch (e) { /* ignore */ }
    raw = raw.trim() || this.DEFAULT_SCINET;
    if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw;
    return raw.replace(/\/+$/, "");
  },

  /**
   * 一个站点两条 HTML resolver：
   *  ① embed/iframe id="pdf" 的 src（sci-hub .st/.tf 模板，zotero-scipdf 验证过的写法）
   *  ② meta citation_pdf_url 的 content（sci-hub.ru 2026 模板；见 scihub.js 的解析级序）
   * 原生 resolver 单条只支持一个 selector+attribute，两种模板只能拆成两条；
   * 未命中那条只多发一次 GET，Zotero 自动跳过继续下一条。
   */
  _pushHost(list, base, label) {
    const page = base + "/{doi}";
    list.push({
      name: this.NAME_PREFIX + label,
      method: "GET",
      url: page,
      mode: "html",
      selector: "#pdf",
      attribute: "src",
      automatic: true,
    });
    list.push({
      name: this.NAME_PREFIX + label + " (meta)",
      method: "GET",
      url: page,
      mode: "html",
      selector: "meta[name='citation_pdf_url']",
      attribute: "content",
      automatic: true,
    });
  },

  /** 按当前开关/镜像构造「我们想要存在的」resolver 条目 */
  _build() {
    const list = [];
    // ① Unpaywall（合法开放获取，最优先；Zotero 内置 oa 段用的是自家镜像可能滞后，
    //    这里直连官方 API 作为 custom 段的第一顺位）
    let email = "";
    try { email = String(Prefs.get("unpaywallEmail", "") || "").trim(); } catch (e) { /* ignore */ }
    list.push({
      name: this.NAME_PREFIX + "Unpaywall",
      method: "GET",
      url: "https://api.unpaywall.org/v2/{doi}?email=" + encodeURIComponent(email || this.DEFAULT_EMAIL),
      mode: "json",
      selector: ".oa_locations",
      mappings: { url: "url_for_pdf", pageURL: "url_for_landing_page" },
      automatic: true,
    });
    // ② Sci-Hub 各镜像 + ③ Sci-Net（尊重现有开关，与 oa-fetch.js 的判定口径一致）
    const useScihub = Prefs.get("scihubEnabled", true) !== false;
    if (useScihub) {
      for (const m of this._mirrors()) {
        this._pushHost(list, m, "Sci-Hub (" + m.replace(/^https?:\/\//, "") + ")");
      }
      if (Prefs.get("scinetEnabled", true) !== false) {
        const base = this._scinetBase();
        this._pushHost(list, base, "Sci-Net (" + base.replace(/^https?:\/\//, "") + ")");
      }
    }
    // ④ 出版商直连（0.43.0，参考 zotero-scihub-resolver）：经 doi.org 跳转出版商落地页，
    //    从 citation_pdf_url 元标签提取 PDF。独立于 Sci-Hub 开关；校园 VPN / 机构订阅下
    //    兜底 Sci-Hub 停更后的新文献，无订阅时自然失败（302 到登录页，Zotero 跳过继续）
    if (Prefs.get("publisherDirectEnabled", true) !== false) {
      list.push({
        name: this.NAME_PREFIX + "Publisher (doi.org)",
        method: "GET",
        url: "https://doi.org/{doi}",
        mode: "html",
        selector: "meta[name='citation_pdf_url']",
        attribute: "content",
        automatic: true,
      });
    }
    return list;
  },

  _writeIfChanged(cur, next) {
    const a = JSON.stringify(cur);
    const b = JSON.stringify(next);
    if (a === b) return false;
    try {
      Zotero.Prefs.set(this.PREF, b, true);
      return true;
    } catch (e) {
      this._debug("写入 findPDFs.resolvers 失败 - " + (e && e.message));
      return false;
    }
  },

  /**
   * 注册（幂等）：保留非本插件条目，重建本插件条目。
   * fulltextResolverEnabled 关闭时退化为 unregister（只清不加）。
   * 返回本次注入的本插件条目数。
   */
  register() {
    const enabled = Prefs.get("fulltextResolverEnabled", true) !== false;
    const cur = this._read();
    const kept = cur.filter((r) => !this._isOurs(r));
    const ours = enabled ? this._build() : [];
    const changed = this._writeIfChanged(cur, kept.concat(ours));
    this._debug("register: 注入 " + ours.length + " 条，保留用户/他插件 " + kept.length + " 条" + (changed ? "（已写入）" : "（无变化）"));
    return ours.length;
  },

  /** 卸载/关闭：精确移除本插件条目，用户手写与其它插件的 resolver 原样保留 */
  unregister() {
    const cur = this._read();
    const kept = cur.filter((r) => !this._isOurs(r));
    const changed = this._writeIfChanged(cur, kept);
    this._debug("unregister: 移除 " + (cur.length - kept.length) + " 条" + (changed ? "（已写入）" : "（无变化）"));
    return cur.length - kept.length;
  },

  /** 开关/镜像变更后刷新（等价 register，语义给调用方用） */
  refresh() {
    return this.register();
  },
};
