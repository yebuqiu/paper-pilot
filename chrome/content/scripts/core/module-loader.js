// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot 模块运行时（module-loader）
 * ================================================================
 * 职责：把「功能组件」从主包里剥出来的那一半——落盘、校验、原子切换、加载、回滚、卸载。
 * 目录拉取与安装编排在 core/module-store.js；本文件只管**本地状态机**，不碰网络。
 *
 * 三条硬约束（与仓库既有纪律对齐）：
 *   1) 逐文件 sha256 核对，任一不符整包丢弃（绝不半装）。
 *   2) 原子切换：先解到 .tmp-<id>-<ts>，校验通过再 move 到 <id>/<version>，
 *      最后才改 installed.json 指针；旧版本目录保留一份供回滚。
 *   3) 加载失败不拖垮宿主：单模块 try/catch，标记 broken，下次启动跳过。
 *
 * 两种加载模式（mode）：
 *   · "scope"   —— loadSubScript 进 bootstrap 共享作用域（兼容现存 features/*.js，
 *                  它们直接把自己挂成全局对象；无法真正卸载，只能尽力 teardown）。
 *   · "sandbox" —— Cu.Sandbox + Papilot.Modules.register(id, {install, uninstall})，
 *                  可卸载、可隔离，供新式组件使用。
 *
 * ⚠️ 本文件被 test/module-loader.test.js 以 vm 方式加载，所有外部依赖都经
 *    `_deps` 注入点获取；顶层不得直接触碰 IO/网络/窗口，否则测试无法离线跑。
 */

/* global Zotero, Services, IOUtils, PathUtils, Cu, Ci, Cc, ChromeUtils */

var ModuleLoader = {
  API_VERSION: 1,
  REGISTRY_FILE: "installed.json",

  // 注入点：测试可整体替换；生产在 _ensureDeps() 里惰性绑定真实现
  _deps: {
    baseDir: null,
    fs: null,
    unzip: null,
    hashFile: null,
    scriptLoader: null,
    makeSandbox: null,
    fileURI: null,
    hostVersion: null,
    now: null,
    diag: null,
  },

  _registry: null,        // {schema, modules:{id:entry}}
  _loaded: {},            // id -> {mode, sandbox?, api?}
  _loading: {},           // id -> true 并发保护
  _queue: Promise.resolve(),
  _initialized: false,

  /* ================= 纯函数（可离线单测，无副作用） ================= */

  _pure: {
    /** 数字点分版本比较：a>b 返回 1，a<b 返回 -1，相等 0。非法段按 0 处理。 */
    compareVersion(a, b) {
      const pa = String(a == null ? "0" : a).split(".").map(x => parseInt(x, 10) || 0);
      const pb = String(b == null ? "0" : b).split(".").map(x => parseInt(x, 10) || 0);
      const n = Math.max(pa.length, pb.length);
      for (let i = 0; i < n; i++) {
        const x = pa[i] || 0, y = pb[i] || 0;
        if (x > y) return 1;
        if (x < y) return -1;
      }
      return 0;
    },

    /** 模块 id 只允许小写字母/数字/连字符，防目录穿越与奇怪路径。 */
    isValidId(id) {
      return typeof id === "string" && /^[a-z0-9][a-z0-9-]{1,63}$/.test(id);
    },

    /**
     * 清单形状校验。返回 {ok, errors:[]}。
     * 安全要点：文件路径禁止绝对路径 / 反斜杠 / ".." 段 —— 否则解压即写穿。
     */
    validateManifest(m, hostVersion, apiVersion) {
      const errors = [];
      if (!m || typeof m !== "object") return { ok: false, errors: ["manifest 不是对象"] };
      if (!this.isValidId(m.id)) errors.push("id 非法：" + m.id);
      if (!m.version || !/^\d+(\.\d+){0,3}$/.test(String(m.version))) errors.push("version 非法");
      if (m.apiVersion != null && Number(m.apiVersion) > Number(apiVersion || 1)) {
        errors.push("apiVersion " + m.apiVersion + " 高于宿主 " + apiVersion);
      }
      if (m.minHost && hostVersion && this.compareVersion(hostVersion, m.minHost) < 0) {
        errors.push("需要主包 ≥ " + m.minHost + "（当前 " + hostVersion + "）");
      }
      if (m.mode && m.mode !== "scope" && m.mode !== "sandbox") errors.push("mode 非法：" + m.mode);
      if (!Array.isArray(m.files) || m.files.length === 0) {
        errors.push("files 为空");
      } else {
        const seen = {};
        for (const f of m.files) {
          const p = f && f.path;
          if (!p || typeof p !== "string") { errors.push("files[].path 缺失"); continue; }
          if (p.indexOf("\\") >= 0) errors.push("路径含反斜杠：" + p);
          if (p.charAt(0) === "/" || /^[a-zA-Z]:/.test(p)) errors.push("绝对路径：" + p);
          if (p.split("/").indexOf("..") >= 0) errors.push("路径穿越：" + p);
          if (seen[p]) errors.push("路径重复：" + p);
          seen[p] = 1;
          if (f.size != null && !(Number(f.size) >= 0)) errors.push("size 非法：" + p);
        }
        if (m.entry && !seen[m.entry]) errors.push("entry 不在 files 内：" + m.entry);
        if (m.mode === "sandbox" && !m.entry) errors.push("sandbox 模式必须有 entry");
      }
      return { ok: errors.length === 0, errors };
    },

    /**
     * 逐文件核对 content：content = { "<path>": { sha256, size } }。
     * 只返回差异，不抛错（调用方决定如何处理）。
     */
    diffFiles(manifest, content) {
      const bad = [];
      const files = (manifest && manifest.files) || [];
      for (const f of files) {
        const got = content && content[f.path];
        if (!got) { bad.push({ path: f.path, reason: "missing" }); continue; }
        if (f.size != null && Number(got.size) !== Number(f.size)) {
          bad.push({ path: f.path, reason: "size", expect: f.size, actual: got.size });
          continue;
        }
        if (f.sha256 && String(got.sha256 || "").toLowerCase() !== String(f.sha256).toLowerCase()) {
          bad.push({ path: f.path, reason: "sha256", expect: f.sha256, actual: got.sha256 });
        }
      }
      return bad;
    },

    /** 装/升/同版/降级判定（降级默认拒绝，除非 allowDowngrade）。 */
    planInstall(manifest, current, allowDowngrade) {
      const to = manifest && manifest.version;
      if (!current) return { action: "install", from: null, to };
      const cmp = this.compareVersion(to, current.version);
      if (cmp === 0) return { action: "same", from: current.version, to };
      if (cmp > 0) return { action: "upgrade", from: current.version, to };
      return { action: allowDowngrade ? "downgrade" : "blocked", from: current.version, to };
    },

    /** 容错解析注册表：坏 JSON 一律当空表（宁可重装，不要启动即炸）。 */
    parseRegistry(text) {
      const empty = { schema: 1, modules: {} };
      if (!text || typeof text !== "string") return empty;
      try {
        const obj = JSON.parse(text);
        if (!obj || typeof obj !== "object") return empty;
        if (!obj.modules || typeof obj.modules !== "object") obj.modules = {};
        if (!obj.schema) obj.schema = 1;
        return obj;
      } catch (e) {
        return empty;
      }
    },

    /** 写指针：返回新对象，不改入参（便于测试断言不可变）。 */
    withEntry(registry, id, entry) {
      const next = { schema: (registry && registry.schema) || 1, modules: {} };
      const src = (registry && registry.modules) || {};
      for (const k of Object.keys(src)) next.modules[k] = src[k];
      if (entry === null) delete next.modules[id];
      else next.modules[id] = entry;
      return next;
    },

    /** 列表视图：注册表 → 稳定排序的数组（不依赖插入顺序）。 */
    toList(registry) {
      const mods = (registry && registry.modules) || {};
      return Object.keys(mods).sort().map(id => {
        const e = mods[id] || {};
        return {
          id,
          version: e.version || null,
          dir: e.dir || null,
          enabled: e.enabled !== false,
          broken: !!e.broken,
          mode: e.mode || "scope",
          installedAt: e.installedAt || null,
          updatedAt: e.updatedAt || null,
          whatsNew: e.whatsNew || "",
          previous: e.previous || null,
        };
      });
    },
  },

  /* ================= 依赖绑定（生产实现） ================= */

  _ensureDeps() {
    const d = this._deps;
    if (d.now) return d;

    d.now = () => Date.now();

    if (!d.baseDir) {
      let base = null;
      try {
        if (typeof Zotero !== "undefined" && Zotero.Profile && Zotero.Profile.dir) {
          base = PathUtils.join(String(Zotero.Profile.dir), "papilot");
        }
      } catch (e) { /* 继续兜底 */ }
      if (!base) {
        try {
          const f = Services.dirsvc.get("ProfD", Ci.nsIFile);
          base = PathUtils.join(f.path, "papilot");
        } catch (e) {
          base = null;
        }
      }
      d.baseDir = base;
    }

    if (!d.fs) d.fs = this._defaultFs();
    if (!d.unzip) d.unzip = (zipPath, destDir) => this._defaultUnzip(zipPath, destDir);
    if (!d.hashFile) d.hashFile = p => this._defaultHashFile(p);
    if (!d.scriptLoader) {
      d.scriptLoader = {
        load(url, scope) {
          if (scope) Services.scriptloader.loadSubScript(url, scope);
          else Services.scriptloader.loadSubScript(url);
        },
      };
    }
    if (!d.makeSandbox) {
      d.makeSandbox = (id) => Cu.Sandbox(null, {
        sandboxName: "papilot-mod-" + id,
        wantXrays: false,
        allowModules: false,
      });
    }
    if (!d.fileURI) d.fileURI = p => PathUtils.toFileURI(p);
    if (!d.diag) d.diag = msg => {
      try {
        if (typeof Zotero !== "undefined" && Zotero.Papilot && Zotero.Papilot._diag) {
          Zotero.Papilot._diag(msg);
        } else if (typeof Zotero !== "undefined" && Zotero.debug) {
          Zotero.debug("[papilot] " + msg);
        }
      } catch (e) { /* 日志自身绝不抛 */ }
    };
    return d;
  },

  /** 默认文件系统：全部走 IOUtils；写文本**永不传 mode**（分册 03 铁律）。 */
  _defaultFs() {
    return {
      exists: p => IOUtils.exists(p),
      mkdirp: async p => IOUtils.makeDirectory(p, { createAncestors: true, ignoreExisting: true }),
      readText: async p => IOUtils.readUTF8(p),
      writeText: async (p, s) => IOUtils.writeUTF8(p, s),
      remove: async p => IOUtils.remove(p, { recursive: true, ignoreAbsent: true }),
      move: async (from, to) => IOUtils.move(from, to, { noOverwrite: false }),
      list: async p => IOUtils.getChildren(p),
      stat: async p => {
        const s = await IOUtils.stat(p);
        return { size: s.size, isDir: s.type === "directory" };
      },
    };
  },

  /** 文件 sha256：读成字节数组再喂 nsICryptoHash（字符串会报
   *  "Cannot convert primitive JavaScript value into an array"——真机实测）。 */
  async _defaultHashFile(path) {
    const bytes = await IOUtils.read(path);
    const hasher = Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);
    hasher.init(Ci.nsICryptoHash.SHA256);
    hasher.update(bytes, bytes.length);
    const raw = hasher.finish(false);
    let hex = "";
    for (let i = 0; i < raw.length; i++) {
      hex += raw.charCodeAt(i).toString(16).padStart(2, "0");
    }
    return hex;
  },

  /** 二进制流读取：优先 NetUtil（若作用域内有），否则用 scriptable stream 分块读。 */
  _readStream(input) {
    const avail = input.available();
    if (typeof NetUtil !== "undefined" && NetUtil && NetUtil.readInputStream) {
      const s = NetUtil.readInputStream(input, avail);
      const out = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
      return out;
    }
    const sis = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(Ci.nsIScriptableInputStream);
    sis.init(input);
    const chunks = [];
    let total = 0;
    while (true) {
      const part = sis.read(65536);
      if (!part || !part.length) break;
      const arr = new Uint8Array(part.length);
      for (let i = 0; i < part.length; i++) arr[i] = part.charCodeAt(i) & 0xff;
      chunks.push(arr);
      total += arr.length;
    }
    try { sis.close(); } catch (e) { /* ignore */ }
    if (chunks.length === 1) return chunks[0];
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  },

  /** 解压：nsIZipReader 逐条目写入 destDir；非法条目名（绝对/穿越）直接跳过并计数。 */
  async _defaultUnzip(zipPath, destDir) {
    const zip = Cc["@mozilla.org/libjar/zip-reader;1"].createInstance(Ci.nsIZipReader);
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(zipPath);
    zip.open(file);
    let skipped = 0;
    try {
      const entries = zip.findEntries(null);
      while (entries.hasMore()) {
        const name = entries.getNext();
        if (!name || name.charAt(name.length - 1) === "/") continue;
        if (name.charAt(0) === "/" || name.indexOf("\\") >= 0 || name.split("/").indexOf("..") >= 0) {
          skipped++;
          continue;
        }
        const out = PathUtils.join(destDir, ...name.split("/"));
        const parent = PathUtils.parent(out);
        if (parent) await IOUtils.makeDirectory(parent, { createAncestors: true, ignoreExisting: true });
        const input = zip.getInputStream(name);
        const bytes = this._readStream(input);
        try { input.close(); } catch (e) { /* ignore */ }
        await IOUtils.write(out, bytes);
      }
    } finally {
      try { zip.close(); } catch (e) { /* ignore */ }
    }
    return { skipped };
  },

  _modulesDir() {
    return PathUtils.join(this._ensureDeps().baseDir, "modules");
  },

  _registryPath() {
    return PathUtils.join(this._modulesDir(), this.REGISTRY_FILE);
  },

  /* ================= 注册表读写（串行化，防并发写坏） ================= */

  _serial(fn) {
    const run = this._queue.then(fn, fn);
    // 队列自身永不 reject，否则后续全部被卡死
    this._queue = run.then(() => undefined, () => undefined);
    return run;
  },

  async _readRegistry(force) {
    if (this._registry && !force) return this._registry;
    const d = this._ensureDeps();
    let text = "";
    try {
      if (await d.fs.exists(this._registryPath())) text = await d.fs.readText(this._registryPath());
    } catch (e) {
      d.diag("module registry read failed: " + e);
    }
    this._registry = this._pure.parseRegistry(text);
    return this._registry;
  },

  async _writeRegistry(next) {
    const d = this._ensureDeps();
    await d.fs.mkdirp(this._modulesDir());
    await d.fs.writeText(this._registryPath(), JSON.stringify(next, null, 2));
    this._registry = next;
    return next;
  },

  /* ================= 生命周期 ================= */

  /**
   * @param {{baseDir?:string, hostVersion?:string, deps?:object}} opts
   */
  async init(opts) {
    const o = opts || {};
    const d = this._ensureDeps();
    if (o.baseDir) d.baseDir = o.baseDir;
    if (o.hostVersion) d.hostVersion = o.hostVersion;
    if (o.deps) Object.assign(d, o.deps);
    if (!d.baseDir) {
      d.diag("module loader disabled: no profile dir");
      return { loaded: 0, skipped: 0, error: "no-base-dir" };
    }
    await this._readRegistry(true);
    const res = await this.loadAll();
    this._initialized = true;
    return res;
  },

  /** 加载所有 enabled && !broken 的模块；单个失败只标 broken。 */
  async loadAll() {
    const d = this._ensureDeps();
    const reg = await this._readRegistry();
    let loaded = 0, skipped = 0;
    for (const id of Object.keys(reg.modules)) {
      const e = reg.modules[id];
      if (!e || e.enabled === false) { skipped++; continue; }
      if (e.broken) { skipped++; continue; }
      try {
        const ok = await this.loadModule(id);
        if (ok) loaded++; else skipped++;
      } catch (err) {
        skipped++;
        d.diag("module load failed " + id + ": " + (err && (err.stack || err.message) || err));
        await this._markBroken(id, true);
      }
    }
    if (loaded || skipped) d.diag("modules: loaded=" + loaded + " skipped=" + skipped);
    return { loaded, skipped };
  },

  /**
   * 缺组件占位：瘦身包里被拆走的模块全局不存在，init 里 `this.account = Account`
   * 这类裸引用会直接 ReferenceError 把启动打断。这里为「未安装模块」声明的全局
   * 装一个惰性桩：可读、可调、可 new，但只返回 undefined，不抛错。
   * 完整包所有全局本来就有 → 一个桩都不会装（typeof 检查）。
   * @param {Array<{id:string, globals:string[]}>} modules
   * @returns {number} 实际安装的桩数量
   */
  installFacades(modules) {
    let n = 0;
    const g = this._global();
    for (const m of (modules || [])) {
      if (!m || !m.id || this.isInstalled(m.id)) continue;
      for (const name of (m.globals || [])) {
        if (typeof g[name] !== "undefined") continue;
        g[name] = this._makeFacade(m.id, name);
        n++;
      }
    }
    if (n) this._ensureDeps().diag("module facades installed: " + n);
    return n;
  },

  _global() {
    if (typeof globalThis !== "undefined") return globalThis;
    return (function () { return this; })();
  },

  _makeFacade(moduleId, globalName) {
    const self = this;
    let booting = true;
    try { setTimeout(() => { booting = false; }, 8000); } catch (e) { booting = false; }

    const target = function () { return undefined; };
    const handler = {
      get(t, prop) {
        // thenable 语义：resolve(undefined) 后返回自身，既让 `await X.foo()` 立即结束，
        // 又让 `.then(...).then(...)` 这种链式写法不炸（真机实测：返回 undefined 会
        // 在 Account.restore().then(...) 这类语句上抛 "undefined is not a function"）。
        if (prop === "then") {
          return (resolve) => {
            try { if (typeof resolve === "function") resolve(undefined); } catch (e) { /* ignore */ }
            return proxy;
          };
        }
        if (prop === Symbol.iterator) return function* () { /* 空迭代：for..of 得到 0 项 */ };
        if (prop === "length" || prop === "size") return 0;
        if (prop === "toString") return () => "[Papilot 组件未安装：" + moduleId + "]";
        if (prop === "valueOf") return () => "";
        if (prop === Symbol.toPrimitive) return () => "";
        if (prop === "prototype") return {};
        if (prop === "__ppFacade") return moduleId;
        if (prop === "__ppGlobal") return globalName;
        return proxy;
      },
      apply() {
        // 启动期静默（init 里的探测调用不该弹窗）；之后再提示安装
        if (!booting) {
          try {
            const store = (typeof Zotero !== "undefined" && Zotero.Papilot && Zotero.Papilot.moduleStore) || null;
            if (store && typeof store.promptInstall === "function") {
              const p = store.promptInstall(moduleId, { reason: "「" + globalName + "」属于未安装的组件。" });
              if (p && typeof p.catch === "function") p.catch(() => {});
            }
          } catch (e) { /* 提示失败按无操作 */ }
        }
        return proxy;      // 返回自身：X.list().active / X.foo().bar 不炸
      },
      construct() { return {}; },
    };
    const proxy = new Proxy(target, handler);
    void self;
    return proxy;
  },

  /**
   * 相对路径拼接：注册表里存的是 "id/version"，
   * PathUtils.join 不接受含 "/" 的单个段（真机实测抛异常），必须逐段展开。
   */
  _joinRel(base, rel) {
    const parts = String(rel || "").split("/").filter(x => x && x !== ".");
    return PathUtils.join(base, ...parts);
  },

  _moduleDirOf(entry) {
    return this._joinRel(this._modulesDir(), entry.dir);
  },

  /** 读模块自带的 module.json（以落盘清单为准，绝不信注册表里的副本）。 */
  async readInstalledManifest(id) {
    const d = this._ensureDeps();
    const reg = await this._readRegistry();
    const e = reg.modules[id];
    if (!e) return null;
    const p = PathUtils.join(this._moduleDirOf(e), "module.json");
    try {
      return JSON.parse(await d.fs.readText(p));
    } catch (err) {
      d.diag("module manifest unreadable " + id + ": " + err);
      return null;
    }
  },

  async loadModule(id) {
    if (this._loaded[id]) return true;
    if (this._loading[id]) return false;
    this._loading[id] = true;
    const d = this._ensureDeps();
    try {
      const reg = await this._readRegistry();
      const entry = reg.modules[id];
      if (!entry) return false;
      const manifest = await this.readInstalledManifest(id);
      if (!manifest) { await this._markBroken(id, true); return false; }
      const dir = this._moduleDirOf(entry);
      // 先占位，sandbox 分支会在 _loadSandboxed 里覆写成带 sandbox/api 的完整句柄；
      // 绝不能在分支之后无条件重写，否则卸载回调（uninstall/nukeSandbox）会丢。
      this._loaded[id] = { mode: manifest.mode || "scope", at: d.now() };
      if (manifest.mode === "sandbox") {
        await this._loadSandboxed(id, manifest, dir);
      } else {
        this._loadInScope(id, manifest, dir);
      }
      d.diag("module loaded " + id + "@" + manifest.version + " (" + (manifest.mode || "scope") + ")");
      return true;
    } catch (err) {
      // 半载入的句柄必须摘掉，否则 unload 会对一个没装完的沙箱调 uninstall
      const h = this._loaded[id];
      if (h) {
        try { if (h.sandbox) Cu.nukeSandbox(h.sandbox, "papilot load failed"); } catch (e) { /* ignore */ }
      }
      delete this._loaded[id];
      d.diag("module loadModule FAILED " + id + ": " + (err && (err.stack || err.message) || err));
      await this._markBroken(id, true);
      return false;
    } finally {
      delete this._loading[id];
    }
  },

  /**
   * scope 模式：按清单顺序 loadSubScript 到共享作用域。
   * 现存 features/*.js 依赖「先加载依赖、后加载消费方」，顺序由 module.json 的
   * files 数组决定 —— 因此 build-module 必须保留显式顺序，不能按字母排序。
   */
  _loadInScope(id, manifest, dir) {
    const d = this._ensureDeps();
    const order = Array.isArray(manifest.loadOrder) && manifest.loadOrder.length
      ? manifest.loadOrder
      : manifest.files.map(f => f.path);
    const bad = [];
    let skippedNonJs = 0;
    for (const rel of order) {
      // 清单里可能有 LICENSE / README 等非脚本文件，别当 JS 加载
      if (!/\.js$/i.test(rel)) { skippedNonJs++; continue; }
      const abs = PathUtils.join(dir, ...String(rel).split("/"));
      try {
        d.scriptLoader.load(d.fileURI(abs));
      } catch (err) {
        // worker 脚本（pdf-render-worker.js 之类）在主作用域必然抛，
        // 属预期：单个文件失败不该让整包不可用。
        bad.push(rel + "(" + (err && (err.message || err)) + ")");
      }
    }
    if (bad.length) d.diag("module " + id + " skipped " + bad.length + " file(s): " + bad.join(", "));
    if (skippedNonJs) d.diag("module " + id + " skipped " + skippedNonJs + " non-js file(s)");
  },

  async _loadSandboxed(id, manifest, dir) {
    const d = this._ensureDeps();
    const sandbox = d.makeSandbox(id);
    const self = this;
    sandbox.Zotero = (typeof Zotero !== "undefined") ? Zotero : null;
    sandbox.Services = (typeof Services !== "undefined") ? Services : null;
    sandbox.console = (typeof console !== "undefined") ? console : { log() {} };
    sandbox.Papilot = {
      Modules: {
        API_VERSION: this.API_VERSION,
        register(targetId, def) {
          if (targetId !== id) throw new Error("模块只能注册自己的 id：" + id);
          self._registry_of_sandbox[id] = def || {};
        },
        require(depId) { return self.isInstalled(depId); },
        isInstalled(depId) { return self.isInstalled(depId); },
      },
    };
    this._registry_of_sandbox = this._registry_of_sandbox || {};

    // 依赖模块先加载进同一沙箱（彼此可见）
    const deps = Array.isArray(manifest.depends) ? manifest.depends : [];
    for (const dep of deps) {
      const dm = await this.readInstalledManifest(dep);
      if (!dm) throw new Error("缺少依赖模块：" + dep);
      const ddir = PathUtils.join(this._modulesDir(), dep, dm.version);
      if (dm.entry) d.scriptLoader.load(d.fileURI(PathUtils.join(ddir, ...dm.entry.split("/"))), sandbox);
    }

    const entryAbs = PathUtils.join(dir, ...String(manifest.entry).split("/"));
    d.scriptLoader.load(d.fileURI(entryAbs), sandbox);

    const def = this._registry_of_sandbox[id];
    if (!def) throw new Error("模块未调用 Papilot.Modules.register()");
    this._loaded[id] = { mode: "sandbox", sandbox, api: def };
    if (typeof def.install === "function") {
      await def.install({
        Zotero: sandbox.Zotero,
        rootURI: this._deps.fileURI(dir) + "/",
        log: msg => d.diag("[" + id + "] " + msg),
      });
    }
  },

  /** 卸载：sandbox 调 uninstall；scope 只能尽力（JS 已进作用域，无法回收）。 */
  async unloadModule(id) {
    const d = this._ensureDeps();
    const h = this._loaded[id];
    delete this._loaded[id];
    if (!h) return true;
    try {
      if (h.mode === "sandbox" && h.api && typeof h.api.uninstall === "function") {
        await h.api.uninstall();
      }
      if (h.sandbox) {
        try { Cu.nukeSandbox(h.sandbox, "papilot unload"); } catch (e) { /* ignore */ }
      }
      d.diag("module unloaded " + id + " (" + h.mode + ")");
      return true;
    } catch (err) {
      d.diag("module unload failed " + id + ": " + (err && (err.message || err)));
      return false;
    }
  },

  /* ================= 安装 / 卸载 / 回滚 ================= */

  /**
   * 从 zip 安装。zipPath 必须已下载到本地；manifest 为目录侧下发的清单
   * （安装前先用它做一次性形状校验，落盘后再按包内 module.json 复核）。
   */
  async installFromZip(zipPath, manifest, opts) {
    const o = opts || {};
    const d = this._ensureDeps();
    return this._serial(async () => {
      const v = this._pure.validateManifest(manifest, d.hostVersion, this.API_VERSION);
      if (!v.ok) return { ok: false, error: "清单非法：" + v.errors.join("; ") };

      const reg = await this._readRegistry(true);
      const current = reg.modules[manifest.id] || null;
      const plan = this._pure.planInstall(manifest, current, !!o.allowDowngrade);
      if (plan.action === "blocked") {
        return { ok: false, error: "已安装更高版本 " + current.version + "，拒绝降级" };
      }
      if (plan.action === "same" && !o.force) {
        return { ok: true, id: manifest.id, version: manifest.version, noop: true };
      }

      await d.fs.mkdirp(this._modulesDir());
      const tmp = PathUtils.join(this._modulesDir(), ".tmp-" + manifest.id + "-" + d.now());
      const finalDir = PathUtils.join(this._modulesDir(), manifest.id, manifest.version);
      let moved = false;
      try {
        if (await d.fs.exists(tmp)) await d.fs.remove(tmp);
        await d.fs.mkdirp(tmp);

        const un = await d.unzip(zipPath, tmp);
        if (un && un.skipped) d.diag("unzip skipped " + un.skipped + " unsafe entries");

        // 以包内清单为准复核（防目录清单与包内容不一致）
        const innerPath = PathUtils.join(tmp, "module.json");
        let inner = null;
        try { inner = JSON.parse(await d.fs.readText(innerPath)); } catch (e) { inner = null; }
        if (!inner) throw new Error("包内缺少 module.json");
        // 包内清单同样过一遍形状校验：路径穿越会让下面的哈希去读 tmp 之外的文件
        const iv = this._pure.validateManifest(inner, d.hostVersion, this.API_VERSION);
        if (!iv.ok) throw new Error("包内清单非法：" + iv.errors.join("; "));
        if (inner.id !== manifest.id) throw new Error("包内 id 与目录不一致");
        if (String(inner.version) !== String(manifest.version)) throw new Error("包内版本与目录不一致");

        const content = {};
        for (const f of inner.files) {
          const abs = PathUtils.join(tmp, ...String(f.path).split("/"));
          if (!(await d.fs.exists(abs))) { content[f.path] = null; continue; }
          const st = await d.fs.stat(abs);
          content[f.path] = { size: st.size, sha256: await d.hashFile(abs) };
        }
        const bad = this._pure.diffFiles(inner, content);
        if (bad.length) {
          throw new Error("校验失败 " + bad.length + " 项（首个：" + bad[0].path + "/" + bad[0].reason + "）");
        }

        if (await d.fs.exists(finalDir)) await d.fs.remove(finalDir);
        await d.fs.mkdirp(PathUtils.parent(finalDir));
        await d.fs.move(tmp, finalDir);
        moved = true;

        const entry = {
          version: String(inner.version),
          dir: manifest.id + "/" + inner.version,
          mode: inner.mode || "scope",
          enabled: true,
          broken: false,
          installedAt: (current && current.installedAt) || new Date(d.now()).toISOString(),
          updatedAt: new Date(d.now()).toISOString(),
          whatsNew: inner.whatsNew || "",
          previous: current && current.version !== inner.version
            ? { version: current.version, dir: current.dir }
            : (current && current.previous) || null,
        };
        await this._writeRegistry(this._pure.withEntry(reg, manifest.id, entry));
        // 只留「当前 + 上一版」，其余历史版本目录清掉（否则每次升级留一份孤儿）
        await this._pruneVersions(manifest.id, [inner.version, entry.previous && entry.previous.version]);

        // 热加载：同版本重装或明确要求时立刻载入；失败只标 broken，不回滚数据
        if (o.hot !== false) {
          const wasLoaded = !!this._loaded[manifest.id];
          if (wasLoaded) await this.unloadModule(manifest.id);
          try { await this.loadModule(manifest.id); } catch (e) { /* loadModule 内部已兜 */ }
        }
        return { ok: true, id: manifest.id, version: inner.version, action: plan.action };
      } catch (err) {
        if (!moved && await d.fs.exists(tmp)) {
          try { await d.fs.remove(tmp); } catch (e) { /* ignore */ }
        }
        d.diag("module install FAILED " + manifest.id + ": " + (err && (err.stack || err.message) || err));
        return { ok: false, error: String(err && (err.message || err)) };
      }
    });
  },

  /** 只保留 keep 里的版本目录；失败静默（清理不是关键路径）。 */
  async _pruneVersions(id, keep) {
    const d = this._ensureDeps();
    const keepSet = {};
    for (const v of (keep || [])) if (v) keepSet[String(v)] = 1;
    const root = PathUtils.join(this._modulesDir(), id);
    try {
      if (!(await d.fs.exists(root))) return 0;
      const kids = await d.fs.list(root);
      let removed = 0;
      for (const p of (kids || [])) {
        const name = String(p).split(/[\\/]/).pop();
        if (!name || name === this.REGISTRY_FILE || keepSet[name]) continue;
        try { await d.fs.remove(p); removed++; } catch (e) { /* 占用中，下次再清 */ }
      }
      return removed;
    } catch (e) { return 0; }
  },

  async uninstall(id) {
    const d = this._ensureDeps();
    return this._serial(async () => {
      const reg = await this._readRegistry(true);
      const e = reg.modules[id];
      if (!e) return { ok: true, noop: true };
      await this.unloadModule(id);
      try {
        // 当前版本 + 回滚版本一起删，否则 <id>/ 永远收不干净
        const dirs = [this._moduleDirOf(e)];
        if (e.previous && e.previous.dir) dirs.push(this._joinRel(this._modulesDir(), e.previous.dir));
        for (const dir of dirs) {
          if (await d.fs.exists(dir)) await d.fs.remove(dir);
        }
        const parent = PathUtils.join(this._modulesDir(), id);
        if (await d.fs.exists(parent)) {
          const kids = await d.fs.list(parent);
          const left = (kids || []).filter(p => String(p).split(/[\\/]/).pop() !== this.REGISTRY_FILE);
          if (left.length === 0) await d.fs.remove(parent);
        }
      } catch (err) {
        d.diag("module uninstall fs error " + id + ": " + err);
      }
      await this._writeRegistry(this._pure.withEntry(reg, id, null));
      return { ok: true, id };
    });
  },

  /** 回滚到安装时保留的上一版本（只在 previous 目录仍存在时可用）。 */
  async rollback(id) {
    const d = this._ensureDeps();
    return this._serial(async () => {
      const reg = await this._readRegistry(true);
      const e = reg.modules[id];
      if (!e || !e.previous) return { ok: false, error: "没有可回滚的版本" };
      const prevDir = this._joinRel(this._modulesDir(), e.previous.dir);
      if (!(await d.fs.exists(prevDir))) return { ok: false, error: "回滚版本目录已清理" };
      await this.unloadModule(id);
      const next = {
        ...e,
        version: e.previous.version,
        dir: e.previous.dir,
        broken: false,
        updatedAt: new Date(d.now()).toISOString(),
        previous: { version: e.version, dir: e.dir },
      };
      await this._writeRegistry(this._pure.withEntry(reg, id, next));
      await this.loadModule(id);
      return { ok: true, id, version: next.version };
    });
  },

  async setEnabled(id, enabled) {
    return this._serial(async () => {
      const reg = await this._readRegistry(true);
      const e = reg.modules[id];
      if (!e) return { ok: false, error: "未安装" };
      const next = { ...e, enabled: !!enabled };
      if (!enabled) await this.unloadModule(id);
      else if (!e.broken) await this.loadModule(id);
      await this._writeRegistry(this._pure.withEntry(reg, id, next));
      return { ok: true, id, enabled: !!enabled };
    });
  },

  async _markBroken(id, broken) {
    try {
      const reg = await this._readRegistry(true);
      const e = reg.modules[id];
      if (!e) return;
      if (!!e.broken === !!broken) return;
      await this._writeRegistry(this._pure.withEntry(reg, id, { ...e, broken: !!broken }));
    } catch (err) { /* 标记失败不影响主流程 */ }
  },

  /* ================= 查询 ================= */

  isInstalled(id) {
    const reg = this._registry;
    return !!(reg && reg.modules && reg.modules[id]);
  },

  getVersion(id) {
    const reg = this._registry;
    return (reg && reg.modules && reg.modules[id] && reg.modules[id].version) || null;
  },

  isActive(id) {
    return !!this._loaded[id];
  },

  list() {
    return this._pure.toList(this._registry);
  },

  /**
   * 功能门卫：未安装 → 弹确认，用户同意后**后台**下载安装，本次调用返回 false，
   * 调用方直接 return 即可（下次点击/启动即生效）。已安装返回 true。
   */
  require(id, opts) {
    if (this.isInstalled(id) && !(this._registry.modules[id].broken)) return true;
    try {
      const store = (typeof Zotero !== "undefined" && Zotero.Papilot && Zotero.Papilot.moduleStore) || null;
      if (!store || typeof store.promptInstall !== "function") return false;
      const p = store.promptInstall(id, opts || {});
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (e) { /* 提示失败按缺失处理 */ }
    return false;
  },
};
