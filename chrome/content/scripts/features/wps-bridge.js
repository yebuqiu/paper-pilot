// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot · WPS 集成桥（0.2.0 起对接 Papilot Cite）
 *
 * 这条链路现在长什么样（一句话）：Zotero 通过本地 23119 的 integration 协议对外服务，
 * WPS 里的「Papilot Cite」加载项负责说话，本机 21932 的代理负责补 CORS 与转发。
 *
 * 本文件的职责（刻意收窄）：
 *   ① 检测：加载项目录 / publish.xml 注册 / WPS 信任 / 21932 代理 / 23119 Zotero；
 *   ② 安装：把随 xpi 分发的加载项载荷（chrome/content/tools/wps-cite）复制到 WPS 的
 *      jsaddons 目录、写注册项、清掉旧信任记录 —— 等价于 wps-cite/tools/install.py；
 *   ③ 起代理；
 *   ④ **清理旧版残留**：0.68.x 那套 `wps-zotero` 加载项已被 Papilot Cite 取代，
 *      两份同时装着会在 WPS 功能区打架，所以这里提供一键清掉（目录 + 注册项 + 旧代理目录）。
 *
 * 已删除的东西（别再往回加）：
 *   · 从 Gitee 下载 `papilot-wps-addon.bundle.json` 再落盘 —— 那装的是旧的 wps-zotero，
 *     用户装完连不上 Zotero（实测），正是本次要清掉的"不要的内容"；
 *   · `chrome/content/tools/wps/proxy.py`（21931 的旧代理）—— 现由 21932 的代理取代；
 *   · 「安装脚本目录」这种要用户自己填路径的配置 —— 载荷随包分发，不需要外部脚本。
 */
/* global Zotero, Services, PathUtils, IOUtils, Ci */

var WpsBridge = {
  ADDON_NAME: "papilot-cite",
  LEGACY_NAME: "wps-zotero",
  ZOTERO_PORT: 23119,
  PROXY_PORT: 21932,
  _rootURI: "",

  init({ rootURI } = {}) {
    this._rootURI = rootURI || "";
    return this;
  },

  // ---------- 路径 ----------

  appData() {
    return Services.dirsvc.get("AppData", Ci.nsIFile).path;
  },

  jsaddonsDir() {
    return PathUtils.join(this.appData(), "kingsoft", "wps", "jsaddons");
  },

  proxyHome() {
    return PathUtils.join(this.appData(), "PapilotCite");
  },

  proxyPath() {
    return PathUtils.join(this.proxyHome(), "proxy.py");
  },

  // ---------- 小工具 ----------

  async _exists(path) {
    try {
      return await IOUtils.exists(path);
    } catch (e) {
      return false;
    }
  },

  async _read(path) {
    try {
      return await IOUtils.readUTF8(path);
    } catch (e) {
      return "";
    }
  },

  async _write(path, text) {
    const dir = PathUtils.parent(path);
    await IOUtils.makeDirectory(dir, { ignoreExisting: true });
    await IOUtils.writeUTF8(path, text);
  },

  async _get(url, timeout = 1500) {
    try {
      const xhr = await Zotero.HTTP.request("GET", url, {
        timeout,
        responseType: "text",
        successCodes: false,
      });
      return { ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, body: xhr.responseText || "" };
    } catch (e) {
      return { ok: false, status: 0, body: "", error: String((e && e.message) || e) };
    }
  },

  _verOf(name) {
    const m = /_(\d+(?:\.\d+)*)$/.exec(String(name || ""));
    return m ? m[1] : "";
  },

  _cmpVersion(a, b) {
    const pa = String(a || "0").split(".").map(Number);
    const pb = String(b || "0").split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d;
    }
    return 0;
  },

  async _children(path) {
    try {
      return await IOUtils.getChildren(path);
    } catch (e) {
      return [];
    }
  },

  // ---------- 检测 ----------

  /** 当前装着的 papilot-cite_<ver>（取版本最大者） */
  async addonDir() {
    const names = (await this._children(this.jsaddonsDir()))
      .map((p) => PathUtils.filename(p))
      .filter((n) => n === this.ADDON_NAME || n.indexOf(this.ADDON_NAME + "_") === 0);
    if (!names.length) return null;
    names.sort((a, b) => this._cmpVersion(this._verOf(b), this._verOf(a)));
    const name = names[0];
    return { name, version: this._verOf(name) || "?", path: PathUtils.join(this.jsaddonsDir(), name) };
  },

  /** 旧版（wps-zotero*）残留目录名 */
  async legacyDirs() {
    return (await this._children(this.jsaddonsDir()))
      .map((p) => PathUtils.filename(p))
      .filter((n) => n === this.LEGACY_NAME || n.indexOf(this.LEGACY_NAME + "_") === 0);
  },

  /** publish.xml 里本插件的注册项 */
  async publishState() {
    const path = PathUtils.join(this.jsaddonsDir(), "publish.xml");
    const xml = await this._read(path);
    const st = { registered: false, url: "", legacy: false };
    const m = new RegExp('<jsplugin[^>]*name="' + this.ADDON_NAME + '"[^>]*url="([^"]*)"').exec(xml);
    if (m) {
      st.registered = true;
      st.url = m[1] || "";
    }
    st.legacy = new RegExp('<jsplugin[^>]*name="' + this.LEGACY_NAME + '"').test(xml);
    return st;
  },

  /** authaddin.json 里有没有本加载项的信任记录 */
  async trusted() {
    const path = PathUtils.join(this.jsaddonsDir(), "authaddin.json");
    const raw = await this._read(path);
    if (!raw) return false;
    try {
      const data = JSON.parse(raw);
      for (const comp of Object.values(data || {})) {
        if (!comp || typeof comp !== "object") continue;
        for (const v of Object.values(comp)) {
          if (v && typeof v === "object" && String(v.name || "") === this.ADDON_NAME) return true;
        }
      }
    } catch (e) {
      return false;
    }
    return false;
  },

  /**
   * 随包分发的加载项载荷。
   *
   * ⚠️ 用户装的是 xpi（`jar:file:///…!/`），**jar 里没有可枚举的目录**、也拿不到 nsIFile，
   *    所以载荷不能以"文件夹"形式随包 —— 打成 `chrome/content/tools/wps-cite.bundle.json`
   *    （相对路径 → 文件内容），这里用 fetch 读出来（bootstrap 里唯一能读 jar 的通道；
   *    Zotero.File.getContentsAsync 对 jar: 会抛 NS_ERROR_FAILURE，这是实测结论）。
   */
  async payload() {
    if (this._payload) return this._payload;
    const rel = "chrome/content/tools/wps-cite.bundle.json";
    let json = null;
    try {
      const res = await fetch(this._rootURI + rel);
      if (!res || res.ok === false) throw new Error("fetch 失败（HTTP " + (res ? res.status : 0) + "）");
      json = JSON.parse(String(await res.text()));
    } catch (e) {
      /* 瘦身包（--modular）里载荷已拆到 papilot-mod-cite 组件、不在主包：
       * 读不到 ≠ 故障。给调用方一个能直接展示的结构化失败，而不是把异常甩出去。
       * 既有字段（available/files/...）保持原样，老调用方不受影响。 */
      this._payload = {
        ok: false,
        reason: "组件未安装",
        hint: "在 设置→组件管理 或 组件商店 安装「引文与导出」组件后可用",
        available: false, version: "", proxyVersion: "", files: {}, proxy: "",
        error: String((e && e.message) || e),
      };
      return this._payload;
    }
    const files = (json && json.files && typeof json.files === "object") ? json.files : {};
    const ok = !!files["index.html"];
    this._payload = {
      available: ok,
      version: String((json && json.version) || ""),
      // 载荷里带的代理版本：更新后据此判断运行中的旧实例要不要重启
      proxyVersion: String((json && json.proxyVersion) || ""),
      files,
      proxy: String((json && json.proxy) || ""),
    };
    return this._payload;
  },

  async status() {
    const addon = await this.addonDir();
    const pub = await this.publishState();
    const legacy = await this.legacyDirs();
    const payload = await this.payload();
    const proxyFile = await this._exists(this.proxyPath());

    /* 端口检测交给**代理进程**做（它对 23119 只做一次 TCP connect，见 proxy.py 的
     * /__health → zotero_alive()）。
     *
     * ★ 为什么不在本进程里直接请求 23119：这张卡跑在 Zotero 里面，让自己的 HTTP 客户端
     *   去打自己的服务端，会在设置面板打开那一瞬偶发超时（实测就是"Zotero 没开？"那条假红）。
     *   而且文案本身就错了 —— 卡片能显示出来，Zotero 必然在跑，不可能"没开"。
     *   代理是外部进程，判断"端口有没有在监听"才是它擅长且已验证的事。 */
    const health = await this._get(`http://127.0.0.1:${this.PROXY_PORT}/__health`, 2500);
    let proxyUpstream = false;
    let zoteroPort = null;                 // true / false / null=无法确认
    if (health.ok) {
      try {
        const j = JSON.parse(health.body);
        zoteroPort = !!j.zotero;
        proxyUpstream = !!j.zotero;
      } catch (e) {
        proxyUpstream = true;
      }
    } else {
      zoteroPort = await this._probeZoteroDirect();
    }

    return {
      addon,
      registered: pub.registered,
      registeredUrl: pub.url,
      registeredBroken: pub.registered && !!addon && pub.url !== addon.name,
      trusted: await this.trusted(),
      proxy: health.ok,
      proxyFile,
      proxyUpstream,
      zotero: zoteroPort,
      payload,
      legacy: { dirs: legacy, publish: pub.legacy },
      proxyHome: this.proxyHome(),
      addonRoot: this.jsaddonsDir(),
    };
  },

  /** 代理没跑时的兜底：进程内自连试一次。失败只能算"未知"，不能断言端口挂了。 */
  async _probeZoteroDirect() {
    const r = await this._get(`http://127.0.0.1:${this.ZOTERO_PORT}/connector/ping`, 1500);
    return r.ok ? true : null;
  },

  // ---------- 安装 ----------

  /** 写注册项（与 wps-cite/tools/install.py 的 upsert_publish 保持同一格式） */
  async _upsertPublish(ver) {
    const dir = this.jsaddonsDir();
    await IOUtils.makeDirectory(dir, { ignoreExisting: true });
    const path = PathUtils.join(dir, "publish.xml");
    let xml = await this._read(path);
    if (!xml) xml = "<jsplugins>\n</jsplugins>\n";
    const target = `${this.ADDON_NAME}_${ver}`;
    xml = xml.replace(new RegExp('[ \\t]*<jsplugin[^>]*name="' + this.ADDON_NAME + '"[^>]*/>\\s*', "g"), "");
    if (xml.indexOf("</jsplugins>") < 0) xml = "<jsplugins>\n</jsplugins>\n";
    const rec = `    <jsplugin name="${this.ADDON_NAME}" type="wps" url="${target}" `
      + `version="${ver}" enable="enable_dev" install="null" customDomain=""/>`;
    xml = xml.replace("</jsplugins>", rec + "\n</jsplugins>");
    await this._write(path, xml);
    return target;
  },

  /** 清掉本插件旧的授权记录：改了目录内容后 WPS 才肯重新问一次 */
  async _dropAuth() {
    const path = PathUtils.join(this.jsaddonsDir(), "authaddin.json");
    const raw = await this._read(path);
    if (!raw) return 0;
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return 0;
    }
    let n = 0;
    try {
      for (const comp of Object.values(data || {})) {
        if (!comp || typeof comp !== "object") continue;
        const keep = {};
        for (const [k, v] of Object.entries(comp)) {
          const drop = k === "namelist" || (v && typeof v === "object" && String(v.name || "") === this.ADDON_NAME);
          if (drop) { n++; continue; }
          keep[k] = v;
        }
        for (const k of Object.keys(comp)) delete comp[k];
        Object.assign(comp, keep);
        comp.namelist = Object.keys(keep).join(";");
      }
      await this._write(path, JSON.stringify(data, null, 4));
    } catch (e) {
      return n;
    }
    return n;
  },

  /** 相对路径安全校验：载荷虽然是我们自己打的包，但落盘逻辑必须防穿越（测起来也放心） */
  _safeRel(rel) {
    const s = String(rel == null ? "" : rel).replace(/\\/g, "/");
    if (!s || s.startsWith("/") || /^[a-zA-Z]:/.test(s)) return "";
    const parts = s.split("/");
    for (const p of parts) {
      if (!p || p === "." || p === "..") return "";
    }
    return parts.join("/");
  },

  /** 从随包载荷安装/更新加载项（幂等；等价于 wps-cite/tools/install.py） */
  async installAddon() {
    const report = [];
    const p = await this.payload();
    if (!p.available) {
      return {
        ok: false,
        error: p.hint
          ? p.reason + "：" + p.hint + (p.error ? "（" + p.error + "）" : "")
          : "这个版本的插件没有随包分发加载项载荷（chrome/content/tools/wps-cite.bundle.json 缺失或读不出来）"
            + (p.error ? "：" + p.error : ""),
      };
    }
    const ver = p.version;
    if (!/^\d+\.\d+\.\d+$/.test(ver)) {
      return { ok: false, error: "载荷里的版本号读不出来（version.js）" };
    }

    const dst = PathUtils.join(this.jsaddonsDir(), `${this.ADDON_NAME}_${ver}`);
    try { await IOUtils.remove(dst, { recursive: true }); } catch (e) { /* 不存在 */ }

    let count = 0;
    const bad = [];
    for (const [rel, text] of Object.entries(p.files)) {
      const safe = this._safeRel(rel);
      if (!safe) { bad.push(rel); continue; }
      // 按段 join：_safeRel 用 / 归一过，整段直接拼在 Windows 上会得到
      // `...\papilot-cite_0.2.0\js/app.js` 这种混分隔符的路径
      await this._write(PathUtils.join(dst, ...safe.split("/")), String(text));
      count++;
    }
    report.push(`写入 ${count} 个文件`);
    if (bad.length) report.push(`跳过非法路径 ${bad.length} 个`);
    if (!(await this._exists(PathUtils.join(dst, "index.html")))) {
      return { ok: false, error: "写完了还缺 index.html，安装中止（载荷不完整）", report };
    }

    // 清同名旧版本，避免 WPS 列出两份
    for (const name of (await this._children(this.jsaddonsDir())).map((x) => PathUtils.filename(x))) {
      if (name.indexOf(this.ADDON_NAME + "_") === 0 && name !== `${this.ADDON_NAME}_${ver}`) {
        try { await IOUtils.remove(PathUtils.join(this.jsaddonsDir(), name), { recursive: true }); report.push("清旧版 " + name); } catch (e) { report.push("⚠ 旧目录没删掉：" + name + "（被 WPS 占用，重启 WPS 后再装一次）"); }
      }
    }

    await this._upsertPublish(ver);
    report.push("已写注册项");
    const dropped = await this._dropAuth();
    if (dropped) report.push(`清信任记录 ${dropped} 条（WPS 会再问一次，点确定）`);

    // 代理随包带一份，落到 %APPDATA%\PapilotCite\ 供看门狗启动
    if (p.proxy) {
      try {
        await this._write(this.proxyPath(), p.proxy);
        report.push("已部署代理");
      } catch (e) {
        report.push("代理部署失败：" + String((e && e.message) || e));
      }
    }
    // ★ 必须过一遍 startProxy：它会在版本不符时停旧起新。
    //   只写文件不重启 = 旧进程继续用旧代码应答（0.72.0 外机踩过）。
    const pr = await this.startProxy();
    if (pr && pr.stale) {
      report.push(`⚠ 旧代理 v${pr.version || "?"} 仍在运行（应升到 v${pr.want || "?"}），自动停止失败——请重启电脑`);
    } else if (pr && pr.error) {
      report.push("代理未启动：" + pr.error);
    } else if (pr && pr.started && pr.already) {
      report.push(`代理已是 v${pr.version || "?"}`);
    } else if (pr && pr.started) {
      report.push(`代理已启动 v${pr.version || "?"}`);
    }
    return { ok: true, version: ver, report, proxy: pr };
  },

  // ---------- 清理旧版 ----------

  /** 清掉 0.68.x 的 wps-zotero 残留：目录 + publish.xml 条目 + 旧代理目录 */
  async cleanupLegacy() {
    const removed = [];
    for (const name of await this.legacyDirs()) {
      try {
        await IOUtils.remove(PathUtils.join(this.jsaddonsDir(), name), { recursive: true });
        removed.push(name);
      } catch (e) { /* 目录被 WPS 占用：留给用户关掉 WPS 再点 */ }
    }

    const path = PathUtils.join(this.jsaddonsDir(), "publish.xml");
    let xml = await this._read(path);
    if (xml && new RegExp('name="' + this.LEGACY_NAME + '"').test(xml)) {
      xml = xml.replace(new RegExp('[ \\t]*<jsplugin[^>]*name="' + this.LEGACY_NAME + '"[^>]*/>\\s*', "g"), "");
      await this._write(path, xml);
      removed.push("publish.xml 里的旧注册项");
    }

    const oldProxy = PathUtils.join(this.appData(), "Papilot", "wps-zotero");
    if (await this._exists(oldProxy)) {
      try {
        await IOUtils.remove(oldProxy, { recursive: true });
        removed.push("旧代理目录");
      } catch (e) { /* 忽略 */ }
    }
    return { ok: true, removed };
  },

  // ---------- 代理 ----------

  /**
   * 启动时兜一层（main.js 的 boot 钩子会调它）：
   * 代理已经由「开机自启 + 看门狗计划任务」照顾，这里只做"没在跑且确实装过就拉起来"。
   * 没装过 Papilot Cite 的机器（没有 proxy.py）返回 false，绝不凭空起进程。
   */
  async ensureProxy() {
    // 没装过 Papilot Cite 的机器（没有 proxy.py）绝不凭空起进程
    if (!(await this._exists(this.proxyPath()))) {
      const alive0 = await this._get(`http://127.0.0.1:${this.PROXY_PORT}/__health`, 800);
      return !!alive0.ok;
    }
    // 装了就走 startProxy：版本不符时它会把旧实例重启掉（覆盖文件对运行中的进程无效）
    const r = await this.startProxy();
    return !!r.started;
  },

  /** 从运行中代理的 __health 响应里读版本（老代理没有这个字段 → 空串） */
  _healthVersion(body) {
    try { return String((JSON.parse(body) || {}).proxyVersion || ""); } catch (e) { return ""; }
  },

  /** 随包载荷里的代理版本：优先 bundle 显式字段，老 bundle 退回解析源码 */
  async _bundledProxyVersion() {
    const p = await this.payload();
    if (!p || !p.available) return "";
    if (p.proxyVersion) return String(p.proxyVersion);
    const m = /PROXY_VERSION\s*=\s*["']([0-9.]+)["']/.exec(String(p.proxy || ""));
    return m ? m[1] : "";
  },

  /** 按端口停掉监听 21932 的进程（PowerShell Stop-Process），再靠探活确认真的停了 */
  async _stopProxyByPort() {
    try {
      const proc = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
      const exe = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      exe.initWithPath("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
      proc.init(exe);
      const args = ["-NoProfile", "-NonInteractive", "-Command",
        "Get-NetTCPConnection -LocalPort " + this.PROXY_PORT + " -State Listen -ErrorAction SilentlyContinue"
        + " | Select-Object -ExpandProperty OwningProcess -Unique"
        + " | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"];
      proc.runw(false, args, args.length);
    } catch (e) { /* PowerShell 不可用就靠下面探活判定 */ }
    for (let i = 0; i < 16; i++) {
      await Zotero.Promise.delay(250);
      const h = await this._get(`http://127.0.0.1:${this.PROXY_PORT}/__health`, 400);
      if (!h.ok) return true;
    }
    return false;
  },

  async startProxy() {
    const health = `http://127.0.0.1:${this.PROXY_PORT}/__health`;
    const alive = await this._get(health, 800);
    if (alive.ok) {
      const running = this._healthVersion(alive.body);
      const want = await this._bundledProxyVersion();
      // ★ 2026-10-21 外机实踩：Python 启动时就把源码读进内存，覆盖 proxy.py 对
      //   **正在运行**的实例完全无效——新版插件 + 旧代理会一直 403。
      //   版本不符（老代理不报版本 = 空串）时必须停旧起新，不能直接判 already。
      if (!want || running === want) return { started: true, already: true, version: running };
      const stopped = await this._stopProxyByPort();
      if (!stopped) {
        return { started: true, already: true, stale: true, version: running, want: want };
      }
    }

    const py = await this._whichPythonw();
    if (!py) return { started: false, error: "找不到 pythonw.exe（Papilot Cite 依赖本机 Python 3）" };
    const file = this.proxyPath();
    if (!(await this._exists(file))) return { started: false, error: "代理还没部署到 " + file };

    try {
      const proc = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
      const exe = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      exe.initWithPath(py);
      proc.init(exe);
      proc.runw(false, [file], 1);
    } catch (e) {
      return { started: false, error: String((e && e.message) || e) };
    }
    for (let i = 0; i < 12; i++) {
      await Zotero.Promise.delay(250);
      const h = await this._get(health, 600);
      if (h.ok) {
        const v = this._healthVersion(h.body) || (await this._bundledProxyVersion());
        return { started: true, already: false, version: v };
      }
    }
    return { started: false, error: "代理起来了但 3 秒内没应答（看 %APPDATA%\\PapilotCite\\proxy.log）" };
  },

  async _whichPythonw() {
    // 1) Papilot 自带 runtime（便携版优先）  2) PATH 里的 pythonw
    const bundled = PathUtils.join(this.proxyHome(), "python", "pythonw.exe");
    if (await this._exists(bundled)) return bundled;
    for (const p of ["C:\\Python314\\pythonw.exe", "C:\\Python313\\pythonw.exe", "C:\\Python312\\pythonw.exe"]) {
      if (await this._exists(p)) return p;
    }
    try {
      const env = Cc["@mozilla.org/process/environment;1"].getService(Ci.nsIEnvironment);
      const pathVar = env.get("PATH") || "";
      for (const dir of pathVar.split(";")) {
        if (!dir) continue;
        const cand = PathUtils.join(dir.trim(), "pythonw.exe");
        if (await this._exists(cand)) return cand;
      }
    } catch (e) { /* 拿不到 PATH */ }
    return "";
  },

  // ---------- 目录 ----------

  openDir(kind) {
    let path = "";
    if (kind === "addon") path = this.jsaddonsDir();
    else if (kind === "proxy") path = this.proxyHome();
    if (!path) return false;
    try {
      Zotero.File.reveal(path);
      return true;
    } catch (e) {
      return false;
    }
  },
};
