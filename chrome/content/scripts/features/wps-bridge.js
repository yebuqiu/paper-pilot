// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot · WPS 集成桥（0.68.1）
 *
 * 目标：让「非企业版 WPS（个人版，无 VBA）」也能用 Zotero 插文献。
 *
 * 原理（三句话）：
 *   ① 引用格式与文献库都在 Zotero 里，它通过本地 HTTP（127.0.0.1:23119）的
 *      integration 协议对外服务（/connector/document/execCommand）；
 *   ② WPS 个人版没有 VBA，只能用 WPS 官方 JS 加载项（jsapi）当"手和眼睛"；
 *   ③ 加载项跑在浏览器环境里会被同源策略拦住，所以需要一条本地 CORS 代理
 *      （127.0.0.1:21931 → 23119），并在转发时把 Host 改写回 127.0.0.1:23119
 *      （Zotero 10 会校验 Host，否则一律 400 Bad Request）。
 *
 * 职责边界（刻意收窄，遵守 Apache-2.0 与 GPL 的边界）：
 *   - 只做「检测 / 修复 / 起停代理 / 打开目录」；
 *   - **不打包、不分发** WPS 加载项本体（上游 WPS-Zotero 是 GPL-3.0），
 *     加载项由用户按 docs/wps-zotero.md 自行安装；
 *   - 随插件分发的只有本文件与 proxy.py（均为 Apache-2.0 自有代码）。
 *
 * 关键约束：
 *   - WPS 会校验加载项目录的内容哈希，改动目录内任何文件都会触发
 *     「加载项已被修改，是否继续加载？」→ 所以代理**必须**放在加载项目录之外
 *     （%APPDATA%\Papilot\wps-zotero\proxy.py）。
 *   - `wps.OAAssist.ShellExecute` 在 WPS 12 已失效（上游 issue #16），
 *     加载项不能自己拉起代理，必须由外部（本桥 / 自启）负责。
 */
/* global Zotero, Services, PathUtils, IOUtils, Ci, Cc, Prefs */

var WpsBridge = {
  ADDON_NAME: "wps-zotero",
  ZOTERO_PORT: 23119,
  PROXY_PORT: 21931,
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
    return PathUtils.join(this.appData(), "Papilot", "wps-zotero");
  },

  proxyPath() {
    return PathUtils.join(this.proxyHome(), "proxy.py");
  },

  /** 插件自带的 proxy.py（随 xpi 分发，Apache-2.0） */
  bundledProxyPath() {
    if (!this._rootURI) return "";
    try {
      const uri = Services.io.newURI(this._rootURI + "chrome/content/tools/wps/proxy.py");
      return uri.QueryInterface(Ci.nsIFileURL).file.path;
    } catch (e) {
      return "";
    }
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

  /** 找到 wps-zotero_* 目录（取版本号最大者） */
  async addonDir() {
    const base = this.jsaddonsDir();
    let names = [];
    try {
      names = await IOUtils.getChildren(base);
    } catch (e) {
      return null;
    }
    const dirs = names
      .map((p) => PathUtils.filename(p))
      .filter((n) => n === this.ADDON_NAME || n.indexOf(this.ADDON_NAME + "_") === 0)
      .sort((a, b) => this._cmpVersion(this._verOf(b), this._verOf(a)));
    for (const n of dirs) {
      const index = PathUtils.join(base, n, "index.html");
      if (await this._exists(index)) {
        return { name: n, dir: PathUtils.join(base, n), version: this._verOf(n) };
      }
    }
    return null;
  },

  _verOf(name) {
    const m = /_(\d+\.\d+\.\d+)$/.exec(name);
    return m ? m[1] : "0.0.0";
  },

  _cmpVersion(a, b) {
    const pa = String(a).split(".").map(Number);
    const pb = String(b).split(".").map(Number);
    for (let i = 0; i < 3; i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d;
    }
    return 0;
  },

  // ---------- 检测 ----------

  async status() {
    const st = {
      addon: null,
      registered: false,
      registeredBroken: false,
      trusted: false,
      proxy: false,
      proxyFile: false,
      zotero: false,
      autoProxy: false,
      scriptDir: "",
      jsaddonsDir: this.jsaddonsDir(),
      proxyHome: this.proxyHome(),
      proxyPath: this.proxyPath(),
      proxyUpstream: false,
    };

    const addon = await this.addonDir();
    if (addon) {
      st.addon = addon;
      const html = await this._read(PathUtils.join(addon.dir, "index.html"));
      // WPS 12 不执行 document.write，index.html 必须静态引入脚本
      st.addonStaticScripts = /src=["']js\/ribbon\.js/.test(html);
    }

    const publish = await this._read(PathUtils.join(this.jsaddonsDir(), "publish.xml"));
    st.registered = /name="wps-zotero"/.test(publish);
    if (st.registered) {
      const m = /<jsplugin[^>]*name="wps-zotero"[^>]*url="([^"]+)"/.exec(publish);
      st.registeredUrl = m ? m[1] : "";
      // 开发模式（http://127.0.0.1:3889/）在 WPS 12 上不加载；或指向的目录不存在
      st.registeredBroken = /^https?:/.test(st.registeredUrl) || !addon;
    }

    const auth = await this._read(PathUtils.join(this.jsaddonsDir(), "authaddin.json"));
    if (auth) {
      try {
        const data = JSON.parse(auth);
        for (const comp of Object.values(data || {})) {
          if (!comp || typeof comp !== "object") continue;
          for (const v of Object.values(comp)) {
            if (v && typeof v === "object" && String(v.name || "") === this.ADDON_NAME) {
              st.trusted = !!v.isload;
            }
          }
        }
      } catch (e) {
        st.trusted = false;
      }
    }

    st.proxyFile = await this._exists(this.proxyPath());
    const health = await this._get(`http://127.0.0.1:${this.PROXY_PORT}/__health`);
    st.proxy = health.ok;
    if (health.ok) {
      try {
        st.proxyUpstream = !!JSON.parse(health.body).zotero;
      } catch (e) { /* 保持 false */ }
    }
    st.zotero = (await this._get(`http://127.0.0.1:${this.ZOTERO_PORT}/connector/ping`)).ok;
    st.autoProxy = !!(typeof Prefs !== "undefined" && Prefs.get("wpsAutoProxy", false));
    st.scriptDir = (typeof Prefs !== "undefined" && Prefs.get("wpsScriptDir", "")) || "";
    return st;
  },

  // ---------- 代理 ----------

  /** fire-and-forget：代理常驻，不能等它退出 */
  _spawnDetached(exePath, args) {
    const localFile = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    localFile.initWithPath(exePath);
    if (!localFile.exists()) throw new Error("找不到可执行文件: " + exePath);
    const proc = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
    proc.init(localFile);
    proc.run(false, args, args.length);
    return proc;
  },

  /** pythonw 候选：PATH 里的 pythonw 不可靠（Zotero 不继承用户 PATH），按目录探测 */
  async _pythonw() {
    const cands = [];
    if (this._scriptDirAbs()) {
      const dir = PathUtils.parent(this._scriptDirAbs());
      cands.push(PathUtils.join(dir, "pythonw.exe"));
    }
    const local = Services.dirsvc.get("LocalAppData", Ci.nsIFile).path;
    const prog = PathUtils.join(local, "Programs", "Python");
    try {
      for (const p of await IOUtils.getChildren(prog)) {
        for (const v of ["pythonw.exe", "python.exe"]) {
          cands.push(PathUtils.join(p, v));
        }
      }
    } catch (e) { /* 目录不存在 */ }
    cands.push("C:\\Python314\\pythonw.exe", "C:\\Python313\\pythonw.exe", "C:\\Python312\\pythonw.exe");
    for (const c of cands) {
      if (c && (await this._exists(c))) return c;
    }
    return "pythonw.exe"; // 交给系统 PATH 兜底
  },

  _scriptDirAbs() {
    const d = (typeof Prefs !== "undefined" && Prefs.get("wpsScriptDir", "")) || "";
    return d ? PathUtils.join(d, "install.py") : "";
  },

  /** 确保代理在跑；返回 {started, already, error} */
  async startProxy() {
    const health = await this._get(`http://127.0.0.1:${this.PROXY_PORT}/__health`, 800);
    if (health.ok) return { started: true, already: true };
    if (!(await this._exists(this.proxyPath()))) {
      return { started: false, error: "代理脚本不存在，请先点「一键修复」" };
    }
    try {
      const py = await this._pythonw();
      this._spawnDetached(py, [this.proxyPath()]);
    } catch (e) {
      return { started: false, error: String((e && e.message) || e) };
    }
    for (let i = 0; i < 20; i++) {
      await Zotero.Promise.delay(250);
      if ((await this._get(`http://127.0.0.1:${this.PROXY_PORT}/__health`, 600)).ok) {
        return { started: true, already: false };
      }
    }
    return { started: false, error: "代理启动超时（检查 Python 是否可用）" };
  },

  async stopProxy() {
    try {
      await Zotero.HTTP.request("POST", `http://127.0.0.1:${this.PROXY_PORT}/__stopproxy`, {
        timeout: 1200,
        successCodes: false,
      });
      return true;
    } catch (e) {
      return false;
    }
  },

  // ---------- 修复 ----------

  /**
   * 一键修复（幂等）：
   *   ① 把随插件分发的 proxy.py 拷到 %APPDATA%\Papilot\wps-zotero\（加载项目录之外）
   *   ② 重写 publish.xml 的注册记录为 WPS 12 认的本地格式（url = 目录名）
   *   ③ 拉起代理
   * 不触碰 authaddin.json：清它会强制重弹「是否信任」，属于用户侧确认。
   */
  async fix() {
    const report = [];
    const addon = await this.addonDir();
    if (!addon) {
      return {
        ok: false,
        report,
        error:
          "未检测到 WPS 加载项。请先按 docs/wps-zotero.md 第 3 节运行 install.py 安装加载项" +
          "（本插件不分发 GPL 加载项，只负责检测与修复）。",
      };
    }

    // ① 代理
    const bundled = this.bundledProxyPath();
    if (bundled && (await this._exists(bundled))) {
      await this._write(this.proxyPath(), await IOUtils.readUTF8(bundled));
      report.push("已部署代理到 " + this.proxyPath());
    } else if (await this._exists(this.proxyPath())) {
      report.push("沿用已有代理（插件内资源缺失）");
    } else {
      return { ok: false, report, error: "插件缺少 proxy.py 资源，无法部署代理" };
    }

    // ② 注册
    const publishPath = PathUtils.join(this.jsaddonsDir(), "publish.xml");
    let xml = await this._read(publishPath);
    if (!xml) {
      xml = '<?xml version="1.0" encoding="UTF-8"?>\n<jsplugins>\n</jsplugins>\n';
    }
    const bak = publishPath + ".papilot.bak";
    if (!(await this._exists(bak))) {
      try {
        await IOUtils.writeUTF8(bak, xml);
      } catch (e) { /* 备份失败不阻塞 */ }
    }
    xml = xml.replace(/[ \t]*<jsplugin[^>]*name="wps-zotero"[^>]*\/>\s*/g, "");
    if (xml.indexOf("</jsplugins>") < 0) {
      xml = '<?xml version="1.0" encoding="UTF-8"?>\n<jsplugins>\n</jsplugins>\n';
    }
    const record =
      `    <jsplugin name="wps-zotero" type="wps" url="${addon.name}" version="${addon.version}" ` +
      'enable="enable_dev" install="null" customDomain=""/>';
    xml = xml.replace("</jsplugins>", record + "\n</jsplugins>");
    await this._write(publishPath, xml);
    report.push(`已写入注册记录（url=${addon.name}）`);

    // ③ 代理起停
    const started = await this.startProxy();
    report.push(started.started ? (started.already ? "代理已在运行" : "代理已启动") : "代理启动失败：" + started.error);

    return { ok: started.started, report, addon };
  },

  /** 启动时按 pref 自动拉起代理（默认关，用户在设置卡里勾选） */
  async ensureProxy() {
    if (typeof Prefs === "undefined" || !Prefs.get("wpsAutoProxy", false)) return false;
    if (!(await this._exists(this.proxyPath()))) return false;
    const r = await this.startProxy();
    return !!r.started;
  },

  // ---------- 安装加载项（独立发布物，按需下载） ----------
  //
  // 加载项是 GPL-3.0，**不随 xpi 分发**；用户点击时从项目发布地址下载一个
  // bundle.json（文件 → base64），落到 jsaddons 后与人工解压 zip 的结果一致。
  // 用 bundle 而非 zip：不依赖 Gecko 的 ZipReader，逻辑是纯 JS + IOUtils，
  // 可以被单测完整覆盖（本项目吃够了"没测到的运行时 API 静默失败"的亏）。
  ADDON_URLS: [
    "https://gitee.com/cassiuschen9261/zotero-papilot/raw/main/dist/papilot-wps-addon.bundle.json",
  ],

  ADDON_REQUIRED: [
    "index.html", "ribbon.xml", "version.js",
    "js/ribbon.js", "js/zclient.js", "js/tools.js", "js/wpsif.js",
  ],

  _shortUrl(url) {
    try {
      const u = Services.io.newURI(url);
      return u.host + "/…/" + PathUtils.filename(u.path);
    } catch (e) {
      return String(url).slice(0, 60);
    }
  },

  async _getText(url) {
    const xhr = await Zotero.HTTP.request("GET", url, {
      timeout: 20000,
      responseType: "text",
      successCodes: false,
    });
    if (xhr.status !== 200) throw new Error("HTTP " + xhr.status);
    return xhr.responseText || "";
  },

  /** base64 → Uint8Array（atob 不在就用纯 JS 兜底，避免作用域差异导致静默失败） */
  _b64decode(b64) {
    const str = String(b64 || "");
    if (typeof atob === "function") {
      const bin = atob(str);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    const ABC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const clean = str.replace(/[^A-Za-z0-9+/]/g, "");
    const out = new Uint8Array(Math.floor(clean.length * 3 / 4));
    let buf = 0, bits = 0, o = 0;
    for (const ch of clean) {
      buf = (buf << 6) | ABC.indexOf(ch);
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[o++] = (buf >> bits) & 0xFF;
      }
    }
    return out.subarray(0, o);
  },

  /** 只接受相对路径：数据来自网络，必须挡目录穿越 */
  _safeRel(rel) {
    const r = String(rel || "");
    if (!r || r.indexOf("..") >= 0 || r.startsWith("/") || /^[a-zA-Z]:/.test(r)) return "";
    if (r.indexOf("\\") >= 0) return "";
    return r;
  },

  async _writeTree(destDir, files) {
    let n = 0;
    for (const rel of Object.keys(files)) {
      const safe = this._safeRel(rel);
      if (!safe) continue;
      const target = PathUtils.join(destDir, ...safe.split("/"));
      await IOUtils.makeDirectory(PathUtils.parent(target), { ignoreExisting: true });
      await IOUtils.write(target, this._b64decode(files[rel]));
      n++;
    }
    return n;
  },

  async _copyTree(src, dst) {
    await IOUtils.makeDirectory(dst, { ignoreExisting: true });
    let names = [];
    try {
      names = await IOUtils.getChildren(src);
    } catch (e) {
      return;
    }
    for (const child of names) {
      const name = PathUtils.filename(child);
      if (name === "__pycache__" || name.indexOf(".pyc") >= 0) continue;
      const to = PathUtils.join(dst, name);
      const st = await IOUtils.stat(child);
      if (st.type === "directory") await this._copyTree(child, to);
      else await IOUtils.copy(child, to);
    }
  },

  _localAddonSource() {
    const d = (typeof Prefs !== "undefined" && Prefs.get("wpsScriptDir", "")) || "";
    if (!d) return "";
    return PathUtils.join(d, "tools", "wps-zotero", "addon");
  },

  /** 装新版后清掉同名的旧版本目录：WPS 会把同名的多份都列出来，容易点错 */
  async _pruneOldAddons(keepDir) {
    const removed = [];
    let names = [];
    try {
      names = await IOUtils.getChildren(this.jsaddonsDir());
    } catch (e) {
      return removed;
    }
    for (const p of names) {
      const name = PathUtils.filename(p);
      if (name.indexOf(this.ADDON_NAME + "_") !== 0) continue;
      if (PathUtils.join(this.jsaddonsDir(), name) === keepDir) continue;
      try {
        await IOUtils.remove(p, { recursive: true });
        removed.push(name);
      } catch (e) { /* 被占用就留着，下次再清 */ }
    }
    return removed;
  },

  /** 装好文件后统一收尾：校验静态引入 → 写注册 → 起代理 */
  async _finalizeAddon(destDir, version) {
    const index = await this._read(PathUtils.join(destDir, "index.html"));
    if (!/src=["']js\/ribbon\.js/.test(index)) {
      throw new Error("index.html 不是静态引入版（WPS 12 不执行 document.write）");
    }
    const fixed = await this.fix();
    const pruned = await this._pruneOldAddons(destDir);
    return {
      ok: fixed.ok,
      version,
      dir: destDir,
      report: [
        `已安装加载项 ${version} → ${destDir}`,
        ...(pruned.length ? [`已清理旧版本：${pruned.join("、")}`] : []),
        ...(fixed.report || []),
      ],
      error: fixed.error,
    };
  },

  async _installFromBundle(url) {
    const text = await this._getText(url);
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error("发布物不是合法 JSON（可能被登录页/镜像页替换）");
    }
    const files = (data && data.files) || {};
    const version = String((data && data.version) || "");
    if (!version || !Object.keys(files).length) throw new Error("发布物缺少 version/files");
    const missing = this.ADDON_REQUIRED.filter((k) => !(k in files));
    if (missing.length) throw new Error("发布物缺少文件：" + missing.join(", "));

    const dest = PathUtils.join(this.jsaddonsDir(), `${this.ADDON_NAME}_${version}`);
    // 先写临时目录再整体替换：中途失败不会留下半个加载项
    const tmp = dest + ".installing";
    if (await this._exists(tmp)) await IOUtils.remove(tmp, { recursive: true });
    await this._writeTree(tmp, files);
    if (await this._exists(dest)) await IOUtils.remove(dest, { recursive: true });
    await IOUtils.move(tmp, dest);
    return this._finalizeAddon(dest, version);
  },

  async _installFromDir(src) {
    const verText = await this._read(PathUtils.join(src, "version.js"));
    const m = /VERSION\s*=\s*'([^']+)'/.exec(verText);
    const version = m ? m[1] : "0.0.0";
    const dest = PathUtils.join(this.jsaddonsDir(), `${this.ADDON_NAME}_${version}`);
    const tmp = dest + ".installing";
    if (await this._exists(tmp)) await IOUtils.remove(tmp, { recursive: true });
    await this._copyTree(src, tmp);
    if (await this._exists(dest)) await IOUtils.remove(dest, { recursive: true });
    await IOUtils.move(tmp, dest);
    return this._finalizeAddon(dest, version);
  },

  /**
   * 安装/重装加载项：先试发布地址，再退本地仓库目录（开发机）。
   * 返回 {ok, version, dir, report, error}
   */
  async installAddon() {
    const report = [];
    const custom = (typeof Prefs !== "undefined" && Prefs.get("wpsAddonUrl", "")) || "";
    const urls = [];
    if (custom) urls.push(custom);
    for (const u of this.ADDON_URLS) if (urls.indexOf(u) < 0) urls.push(u);

    for (const url of urls) {
      try {
        const r = await this._installFromBundle(url);
        report.push("下载源：" + this._shortUrl(url));
        report.push(...(r.report || []));
        return { ok: r.ok, version: r.version, dir: r.dir, report, error: r.error };
      } catch (e) {
        report.push("下载失败：" + this._shortUrl(url) + " → " + String((e && e.message) || e));
      }
    }

    const local = this._localAddonSource();
    if (local && (await this._exists(local))) {
      try {
        const r = await this._installFromDir(local);
        report.push("本地源：" + local);
        report.push(...(r.report || []));
        return { ok: r.ok, version: r.version, dir: r.dir, report, error: r.error };
      } catch (e) {
        report.push("本地源失败：" + String((e && e.message) || e));
      }
    }

    return {
      ok: false,
      report,
      error: "无法获取加载项：检查网络，或在下面填「安装脚本目录」改用本地安装",
    };
  },

  // ---------- 打开目录 ----------

  openDir(kind) {
    const map = {
      addon: this.jsaddonsDir(),
      proxy: this.proxyHome(),
      script: (typeof Prefs !== "undefined" && Prefs.get("wpsScriptDir", "")) || "",
    };
    const dir = map[kind];
    if (!dir) return false;
    try {
      Zotero.Utilities.Internal.exec("explorer.exe", [dir]);
      return true;
    } catch (e) {
      try {
        const f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
        f.initWithPath(dir);
        f.launch();
        return true;
      } catch (e2) {
        return false;
      }
    }
  },
};
