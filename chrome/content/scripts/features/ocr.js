// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot · PDF 无头渲染 + 视觉 OCR + 文本回退（0.63.0）
 *
 * 为什么要有这一层：`Zotero.PDFWorker` 只给**文本层**，扫描件（图片型 PDF）一个字也拿不到；
 * 插件内没有任何光栅化能力，所以历史口径只能是「扫描件请先 OCR」然后什么都不做。
 * 这里用随包分发的 pdf.js（`chrome/content/vendor/pdfjs/`，3.11 legacy UMD，Apache-2.0，
 * 见 THIRD-PARTY-NOTICES.md）在**无窗口环境**把某一页画到 canvas，再把这张图交给
 * 用户自己配置的 AI 通道的视觉模型转写，结果按页落本地侧车。
 *
 * 隐私口径（硬约束，别改）：
 *   - 只发送**当前页的 JPEG base64**——不发整份 PDF、不发其他页、不发题录；
 *   - 只发给用户在「AI 模型通道」里自己登录 / 填 Key 的那**一个**通道，不经任何中转；
 *   - OCR 文本只落本地数据目录 `<DataDirectory>/papilot-ocr/`，不上传。
 *
 * 存储：`<DataDirectory>/papilot-ocr/<itemKey>-<attKey>.json`
 *   `{version:1, updatedAt, engine, pages:{"1":"…","2":"…"}}`
 * 与 Zotero 全文索引**分离**：索引为空时 chat.js 不缓存（既有口径），于是重跑 OCR 后
 * 下一次提问立刻能用上；非空时不混入 OCR 文本（避免污染已索引的正文）。
 *
 * 结构：纯函数（clampScale / mergePages / joinPages / sidecarName）在前半段，Node 单测可直接跑；
 * 运行时（worker 装配 / 渲染 / 识别 / 侧车 IO / 菜单入口）在后半段。
 */
/* global Zotero, Services, Prefs, IOUtils, PathUtils, I18n, AIClient, fetch, Blob, URL, pdfjsLib, Components */

var OcrService = {
  /** 引擎标识：目前只有视觉模型一条路（写进侧车，便于将来换引擎时区分来源） */
  ENGINE: "vision",
  /** 侧车目录名（相对 DataDirectory） */
  DIR: "papilot-ocr",
  DEFAULT_SCALE: 2.0,
  MIN_SCALE: 0.8,
  MAX_SCALE: 3.0,
  DEFAULT_MAX_PAGES: 30,

  /** 视觉转写的系统提示词：口径固定——只要文字，按阅读顺序，公式用 LaTeX，不要解释 */
  SYSTEM_PROMPT: "你是学术 PDF 的 OCR 引擎。只输出页面中的文字，按阅读顺序；"
    + "保留段落换行；公式用 LaTeX；不要解释、不要加标题。",

  /* ==================== 纯函数（可离线单测） ==================== */

  /**
   * 渲染倍率：收进 0.8–3.0，缺省/非法值回落 2.0。
   * 2.0 对应约 144dpi —— 正文小字可读，单页 JPEG 也在视觉模型可接受的大小内。
   * @param {*} v 任意输入（pref 里是字符串，Mozilla pref 没有浮点类型）
   * @returns {number} 0.8–3.0
   */
  clampScale(v) {
    const n = Number(v);
    if (!isFinite(n) || n <= 0) return this.DEFAULT_SCALE;
    return Math.min(this.MAX_SCALE, Math.max(this.MIN_SCALE, n));
  },

  /**
   * 页数上限：整数 1–500，非法/0/空 → 默认 30。
   * **唯一判定处**：识别流程（ocrAttachment / runForSelected）与设置面板都调这里，
   * 免得面板放行 0 页、流程又悄悄钳成别的值（历史「点了没反应」的一种）。
   * @param {*} v 任意输入（pref 里可能是字符串）
   * @returns {number}
   */
  clampMaxPages(v) {
    const n = Math.round(Number(v));
    if (!isFinite(n) || n <= 0) return this.DEFAULT_MAX_PAGES;
    return Math.min(500, Math.max(1, n));
  },

  /**
   * 设置面板提供的三档渲染倍率：1.5 / 2 / 3，非法值回落 "2"。
   * 返回**字符串**——`ocrRenderScale` 是字符串 pref（Mozilla pref 没有浮点类型）。
   * @param {*} v
   * @returns {"1.5"|"2"|"3"}
   */
  pickScale(v) {
    const s = String(v == null ? "" : v).trim();
    return (s === "1.5" || s === "2" || s === "3") ? s : "2";
  },

  /**
   * 按页号合并两组页文本：incoming 覆盖同页，返回按页号升序的 {pages, count}。
   * 页号键统一成字符串（JSON 对象键本来就是字符串），非法页号/非字符串值直接丢弃。
   * @param {Object} existing 旧结果 { "1": "…" }
   * @param {Object} incoming 新结果（覆盖同页）
   * @returns {{pages: Object, count: number}}
   */
  mergePages(existing, incoming) {
    const tmp = {};
    const take = (src) => {
      if (!src || typeof src !== "object") return;
      for (const k of Object.keys(src)) {
        const num = parseInt(k, 10);
        if (!isFinite(num) || num < 1) continue;
        const text = src[k];
        if (typeof text !== "string") continue;
        tmp[String(num)] = text;
      }
    };
    take(existing);
    take(incoming);
    const nums = Object.keys(tmp).map((k) => Number(k)).sort((a, b) => a - b);
    const pages = {};
    for (const n of nums) pages[String(n)] = tmp[String(n)];
    return { pages, count: nums.length };
  },

  /**
   * 页文本 → 整篇文本：按页号升序、页间 `\n\n` 连接、跳过空页。
   * @param {Object} pages { "1": "…" }
   * @returns {string} 没有内容时返回 ""（不抛错——调用方拿它当「无全文」）
   */
  joinPages(pages) {
    if (!pages || typeof pages !== "object") return "";
    const nums = Object.keys(pages).map((k) => Number(k))
      .filter((n) => isFinite(n) && n >= 1)
      .sort((a, b) => a - b);
    const parts = [];
    for (const n of nums) {
      const t = pages[String(n)];
      const s = typeof t === "string" ? t.trim() : "";
      if (s) parts.push(s);
    }
    return parts.join("\n\n");
  },

  /**
   * 侧车文件名：`<itemKey>-<attKey>.json`。Zotero key 是 8 位大写字母数字，
   * 但仍做一次安全字符过滤（中文标题派生的 key、测试桩、异常数据都不至于拼出非法路径）。
   * @param {string} itemKey 父条目 key（取不到时调用方传附件 key）
   * @param {string} attKey 附件 key
   * @returns {string}
   */
  sidecarName(itemKey, attKey) {
    const safe = (s) => String(s == null ? "" : s).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
    return (safe(itemKey) || "item") + "-" + (safe(attKey) || "att") + ".json";
  },

  /* ==================== 运行时：基础设施 ==================== */

  /** 取消标志（runForSelected 之外也可用：自动化/脚本可先 cancel() 再等当前页结束） */
  _cancelled: false,
  /** 已成功的 worker 模式："" | "direct" | "blob" | "inline" | "failed" */
  _workerMode: "",
  /** blob 模式的 objectURL（进程内复用，避免每页新建 Blob） */
  _blobUrl: "",
  /** inline（主线程 fake worker）是否已把 worker 脚本载入作用域 */
  _inlineLoaded: false,

  _diag(msg) {
    const line = "[ocr] " + msg;
    try {
      if (Zotero.Papilot && typeof Zotero.Papilot._diag === "function") { Zotero.Papilot._diag(line); return; }
    } catch (e) { /* 启动早期 Papilot 可能还没挂上 */ }
    try { Zotero.debug(line); } catch (e2) { /* ignore */ }
  },

  /** 带 code 的错误：UI/排障按 code 判别，文案给用户看 */
  _err(code, msg) {
    const e = new Error(msg || code);
    e.code = code;
    return e;
  },

  _alert(msg) {
    let win = null;
    try { win = Zotero.getMainWindow(); } catch (e) { win = null; }
    try { Services.prompt.alert(win, "Papilot", String(msg == null ? "" : msg)); }
    catch (e) { this._diag("alert failed: " + (e && (e.message || e))); }
  },

  /** 路径拼接：优先 PathUtils；特权作用域异常缺位时退回 "/" 拼接（Windows 也接受斜杠） */
  _pjoin(a, b) {
    try { if (typeof PathUtils !== "undefined" && PathUtils && PathUtils.join) return PathUtils.join(a, b); }
    catch (e) { /* fallthrough */ }
    const left = String(a == null ? "" : a).replace(/[\\/]+$/, "");
    const right = String(b == null ? "" : b).replace(/^[\\/]+/, "");
    return left + "/" + right;
  },

  /** DataDirectory 下的侧车目录（不存在时由 writeSidecar 创建） */
  _dir() {
    let base = "";
    try { base = String((Zotero.DataDirectory && Zotero.DataDirectory.dir) || ""); } catch (e) { base = ""; }
    if (!base) throw this._err("OCR_NO_DATA_DIR", "无法定位 Zotero 数据目录，OCR 结果无处存放");
    return this._pjoin(base, this.DIR);
  },

  /** pdf.js 库对象：main.js 已把 UMD 载入 bootstrap 作用域，全局名可能是 var 也可能是 globalThis 属性 */
  _lib() {
    try {
      if (typeof pdfjsLib !== "undefined" && pdfjsLib && typeof pdfjsLib.getDocument === "function") return pdfjsLib;
    } catch (e) { /* 未定义走下面 */ }
    try {
      const g = (typeof globalThis !== "undefined") ? globalThis : null;
      if (g && g.pdfjsLib && typeof g.pdfjsLib.getDocument === "function") return g.pdfjsLib;
    } catch (e) { /* ignore */ }
    return null;
  },

  /** worker 脚本的 chrome:// 绝对路径（随包分发，与 pdf.min.js 同目录） */
  workerSrc() {
    let root = "";
    try { root = String((Zotero.Papilot && Zotero.Papilot.rootURI) || ""); } catch (e) { root = ""; }
    return root + "chrome/content/vendor/pdfjs/pdf.worker.min.js";
  },

  /**
   * 取 worker 文本 → Blob → objectURL。
   * 有些特权作用域能起 Worker 但不认 chrome:// 作为 workerSrc（worker 里没有 chrome 协议
   * 特权），blob URL 是常用解法：脚本内容相同，只是换了个同源地址。
   */
  async _blobWorkerUrl() {
    if (this._blobUrl) return this._blobUrl;
    const hasBlob = (typeof Blob !== "undefined");
    let canObjectUrl = false;
    try { canObjectUrl = !!(URL && typeof URL.createObjectURL === "function"); } catch (e) { canObjectUrl = false; }
    if (!hasBlob || !canObjectUrl || typeof fetch !== "function") {
      throw this._err("OCR_RENDER_UNAVAILABLE", "当前环境不支持 Blob URL，无法用 blob 方式加载渲染 worker");
    }
    const resp = await fetch(this.workerSrc());
    const text = String(await resp.text());
    if (!text) throw this._err("OCR_RENDER_UNAVAILABLE", "渲染 worker 脚本读取为空");
    this._blobUrl = URL.createObjectURL(new Blob([text], { type: "text/javascript" }));
    return this._blobUrl;
  },

  /**
   * 按模式装配 worker：
   *   direct = chrome:// 直接作为 workerSrc（真 worker 线程，最快）
   *   blob   = fetch 文本 → Blob URL
   *   inline = 把 worker 脚本载入主作用域（globalThis.pdfjsWorker），走 pdf.js 的
   *            「主线程 fake worker」——不依赖 Worker/Blob/URL，最稳但占用主线程
   */
  async _prepareWorker(lib, mode) {
    if (!lib || !lib.GlobalWorkerOptions) throw this._err("OCR_RENDER_UNAVAILABLE", "pdf.js 缺少 GlobalWorkerOptions");
    if (mode === "direct") {
      lib.GlobalWorkerOptions.workerSrc = this.workerSrc();
      return;
    }
    if (mode === "blob") {
      lib.GlobalWorkerOptions.workerSrc = await this._blobWorkerUrl();
      return;
    }
    // inline：worker UMD 的根对象是 globalThis，所以只要脚本执行过，
    // pdf.js 就能在 _mainThreadWorkerMessageHandler 里找到 WorkerMessageHandler，
    // 不必再 import(workerSrc) —— workerSrc 留空即可。
    if (!this._inlineLoaded) {
      try {
        const g = (typeof globalThis !== "undefined") ? globalThis : null;
        if (!(g && g.pdfjsWorker && g.pdfjsWorker.WorkerMessageHandler)) {
          Services.scriptloader.loadSubScript(this.workerSrc() + "?v=1");
        }
        this._inlineLoaded = true;
      } catch (e) {
        throw this._err("OCR_RENDER_UNAVAILABLE", "worker 脚本无法载入主作用域：" + (e && (e.message || e)));
      }
    }
    lib.GlobalWorkerOptions.workerSrc = "";
  },

  /**
   * 打开 PDF：按 direct → blob → inline 依次尝试，任一成功即记住模式。
   * 三种都失败 → OCR_RENDER_UNAVAILABLE（UI 提示「渲染引擎不可用」）。
   * @param {Uint8Array} bytes PDF 字节
   * @returns {Promise<Object>} pdf.js PDFDocumentProxy（调用方负责 destroy）
   */
  async openDocument(bytes) {
    const lib = this._lib();
    if (!lib) {
      this._diag("pdfjsLib 缺失（main.js 加载失败？）");
      throw this._err("OCR_RENDER_UNAVAILABLE",
        I18n.t("ocrNoEngine"));
    }
    const modes = ["direct", "blob", "inline"];
    if (this._workerMode && modes.indexOf(this._workerMode) > 0) {
      modes.splice(modes.indexOf(this._workerMode), 1);
      modes.unshift(this._workerMode);
    }
    let last = null;
    for (const mode of modes) {
      try {
        await this._prepareWorker(lib, mode);
        // ⚠️ data 每次给**新副本**：pdf.js 会把 buffer transfer 给 worker（原数组被 detach），
        // 复用同一份会让下一次重试拿到空数据。
        const task = lib.getDocument({
          data: bytes.slice(),
          isEvalSupported: false,
          useWorkerFetch: false,
          disableAutoFetch: true,
          disableStream: true,
        });
        const doc = await task.promise;
        if (this._workerMode !== mode) this._diag("worker mode=" + mode);
        this._workerMode = mode;
        return doc;
      } catch (e) {
        last = e;
        this._diag("worker mode=" + mode + " failed: " + (e && (e.message || e)));
      }
    }
    this._workerMode = "failed";
    this._diag("worker mode=failed（渲染引擎不可用）");
    throw this._err("OCR_RENDER_UNAVAILABLE",
      "渲染引擎不可用（pdf.js worker 三种加载方式均失败）：" + (last && (last.message || last)));
  },

  /**
   * 新建离屏 canvas：首选 `Services.appShell.hiddenDOMWindow`（不闪窗、不受主窗口生命周期影响），
   * 失败退主窗口文档。两者都拿不到 → 渲染不可用（可读错误，不静默）。
   */
  _makeCanvas(w, h) {
    const width = Math.max(1, Math.floor(w));
    const height = Math.max(1, Math.floor(h));
    const docs = [];
    try {
      if (Services.appShell && Services.appShell.hiddenDOMWindow && Services.appShell.hiddenDOMWindow.document) {
        docs.push(Services.appShell.hiddenDOMWindow.document);
      }
    } catch (e) { /* 无头窗口不可用：用主窗口 */ }
    try {
      const win = Zotero.getMainWindow();
      if (win && win.document) docs.push(win.document);
    } catch (e) { /* ignore */ }
    for (const d of docs) {
      try {
        const cv = d.createElement("canvas");
        cv.width = width;
        cv.height = height;
        return cv;
      } catch (e) { /* 换下一个文档环境 */ }
    }
    throw this._err("OCR_RENDER_UNAVAILABLE", "无法创建 canvas（没有可用的文档环境）");
  },

  /**
   * 渲染一页 → JPEG base64（不含 `data:image/jpeg;base64,` 前缀）。
   * @param {Object} doc pdf.js 文档 @param {number} num 页码（1 起）
   * @param {number} scale 倍率（经 clampScale）
   * @returns {Promise<string>}
   */
  async renderPage(doc, num, scale) {
    if (!doc) throw this._err("OCR_RENDER_UNAVAILABLE", "PDF 文档未打开");
    const s = this.clampScale(scale);
    const page = await doc.getPage(num);
    const viewport = page.getViewport({ scale: s });
    const canvas = this._makeCanvas(viewport.width, viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw this._err("OCR_RENDER_UNAVAILABLE", "canvas 2d 上下文不可用");
    try {
      await page.render({ canvasContext: ctx, viewport }).promise;
      const url = String(canvas.toDataURL("image/jpeg", 0.85) || "");
      const idx = url.indexOf(",");
      return idx >= 0 ? url.slice(idx + 1) : "";
    } finally {
      // 一页 2 倍率 A4 ≈ 1654×2339，连续识别不主动释放会堆内存
      try { canvas.width = 1; canvas.height = 1; } catch (e) { /* ignore */ }
      try { if (page && typeof page.cleanup === "function") page.cleanup(); } catch (e) { /* ignore */ }
    }
  },

  /**
   * 单页图像 → 文字（视觉模型）。
   * 消息体用 OpenAI 兼容的多模态格式：content 是数组，第二项是 data URL 图片。
   * ★ 只把**这一页**的 JPEG 发出去。
   * @param {string} base64Jpeg 不带前缀的 base64
   * @param {number} pageNum 页码（只用于提示词，帮模型别把跨页内容混进来）
   * @returns {Promise<string>}
   */
  async askVision(base64Jpeg, pageNum) {
    const b64 = String(base64Jpeg || "");
    if (!b64) throw this._err("OCR_EMPTY_IMAGE", "第 " + pageNum + " 页渲染结果为空");
    const messages = [
      { role: "system", content: this.SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: "请转写第 " + pageNum + " 页" },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64," + b64 } },
        ],
      },
    ];
    const reply = await AIClient.chat(messages);
    return String(reply == null ? "" : reply).trim();
  },

  /* ==================== 运行时：侧车读写 ==================== */

  _parentKey(att) {
    try {
      if (att && att.parentItemID) {
        const p = Zotero.Items.get(att.parentItemID);
        if (p && p.key) return String(p.key);
      }
    } catch (e) { /* 附件可能无父条目 */ }
    try { if (att && att.key) return String(att.key); } catch (e) { /* ignore */ }
    return "item";
  },

  /** 侧车绝对路径（目录可能还不存在——readSidecar 会先判存在） */
  sidecarPath(att) {
    const file = this.sidecarName(this._parentKey(att), (att && att.key) || "");
    return this._pjoin(this._dir(), file);
  },

  /** 空结构（读失败 / 文件不存在都用它，调用方不必判空） */
  _emptySidecar() {
    return { version: 1, updatedAt: 0, engine: this.ENGINE, pages: {} };
  },

  /**
   * 读侧车：文件不存在 / JSON 坏 / 无权限 → 空结构（**不抛错**，OCR 是增强路径，
   * 不能因为一个坏文件把问答/翻译带崩）。
   */
  async readSidecar(att) {
    let path = "";
    try { path = this.sidecarPath(att); } catch (e) { return this._emptySidecar(); }
    try {
      const exists = (typeof IOUtils !== "undefined" && IOUtils && typeof IOUtils.exists === "function")
        ? await IOUtils.exists(path) : false;
      if (!exists) return this._emptySidecar();
      const txt = await IOUtils.readUTF8(path);
      const raw = JSON.parse(txt);
      const merged = this.mergePages(raw && raw.pages, null);
      return {
        version: 1,
        updatedAt: Number(raw && raw.updatedAt) || 0,
        engine: (raw && raw.engine) || this.ENGINE,
        pages: merged.pages,
      };
    } catch (e) {
      this._diag("readSidecar failed (" + path + "): " + (e && (e.message || e)));
      return this._emptySidecar();
    }
  },

  /**
   * 写侧车（含 updatedAt / version / engine）。
   * ⚠️ `IOUtils.writeUTF8` **绝不传 mode**：它要字符串枚举，传数字（如 0o600）会出现
   * 「报告成功但没产出文件」——本仓库历史「掉登录」的真凶，这里不重犯。
   */
  async writeSidecar(att, data) {
    const path = this.sidecarPath(att);
    const merged = this.mergePages(data && data.pages, null);
    const payload = {
      version: 1,
      updatedAt: Date.now(),
      engine: (data && data.engine) || this.ENGINE,
      pages: merged.pages,
    };
    try {
      await IOUtils.makeDirectory(this._dir(), { createAncestors: true, ignoreExisting: true });
    } catch (e) {
      this._diag("mkdir failed: " + (e && (e.message || e)));
    }
    await IOUtils.writeUTF8(path, JSON.stringify(payload));
    return payload;
  },

  /**
   * 附件的 OCR 全文（供 AI 问答回退）。
   * 无侧车 / 全空页 → `""`（**不抛错**：调用方据此判定「仍然没有全文」）。
   */
  async textFor(att) {
    try {
      if (!att) return "";
      const sc = await this.readSidecar(att);
      return this.joinPages(sc.pages);
    } catch (e) {
      this._diag("textFor failed: " + (e && (e.message || e)));
      return "";
    }
  },

  /* ==================== 运行时：附件 / 文档 ==================== */

  /** 归一化到 PDF 附件：附件自身是 PDF 就用它；常规条目取其第一个 PDF 附件 */
  pdfAttachmentOf(target) {
    let item = target || null;
    if (!item) return null;
    // 标注：上溯到其父附件（右键标注也能用）
    try {
      if (item.isAnnotation && item.isAnnotation()) {
        const p = item.parentItemID ? Zotero.Items.get(item.parentItemID) : null;
        if (p) item = p;
      }
    } catch (e) { /* ignore */ }
    try { if (item.isPDFAttachment && item.isPDFAttachment()) return item; } catch (e) { /* ignore */ }
    try { if (item.isAttachment && item.isAttachment()) return null; } catch (e) { /* ignore */ }
    try {
      if (item.isRegularItem && item.isRegularItem()) {
        // 先问「最佳附件」：多附件时用户点开的那份通常就是最佳附件
        const best = typeof item.getBestAttachment === "function" ? item.getBestAttachment() : null;
        if (best && best.attachmentContentType === "application/pdf") return best;
        for (const id of (item.getAttachments() || [])) {
          const a = Zotero.Items.get(id);
          if (a && a.attachmentContentType === "application/pdf") return a;
        }
      }
    } catch (e) { /* ignore */ }
    return null;
  },

  /** 附件的本地文件路径（跨版本：优先 getFilePathAsync，再退 attachmentPath） */
  async _attachmentPath(att) {
    try {
      if (att && typeof att.getFilePathAsync === "function") {
        const p = await att.getFilePathAsync();
        if (p) return String(p);
      }
    } catch (e) { /* fallthrough */ }
    try {
      if (att && att.attachmentPath) return String(att.attachmentPath);
    } catch (e) { /* ignore */ }
    return "";
  },

  /** 只读页数（用于确认框里的「将识别 N 页」）：打开 → 取 numPages → 立刻销毁 */
  async _numPages(att, maxPages) {
    const path = await this._attachmentPath(att);
    if (!path) return 0;
    let bytes = null;
    try { bytes = await IOUtils.read(path); } catch (e) { return 0; }
    if (!bytes || !bytes.length) return 0;
    let doc = null;
    try {
      doc = await this.openDocument(bytes);
      return Math.min(Number(doc.numPages) || 0, maxPages);
    } catch (e) {
      this._diag("_numPages failed: " + (e && (e.message || e)));
      return 0;
    } finally {
      try { if (doc && typeof doc.destroy === "function") await doc.destroy(); } catch (e) { /* ignore */ }
    }
  },

  /* ==================== 运行时：识别主流程 ==================== */

  /** 请求停在上一步之后（每页开头检查；当前页的模型调用不会被中断）。
   *  注意：每次 `ocrAttachment` 开跑都会把标志复位，所以它只作用于**当前这一次**识别。 */
  cancel() {
    this._cancelled = true;
    this._diag("cancel requested");
  },

  /**
   * 识别一个 PDF 附件（逐页渲染 + 视觉转写 + 每页落盘）。
   *
   * 取消：本模块提供 `cancel()` 与 `_cancelled` 标志，但**菜单路径不提供「停止」按钮**——
   * Zotero.ProgressWindow 不支持按钮，为此弹窗打断更像 bug。所以 UI 口径是「先确认页数再开跑，
   * 一次最多 ocrMaxPages 页」；需要中途停止的场景（自动化/脚本）调 `cancel()` 即可，
   * 已识别的页每页都已落盘，下次开跑按 `ocrSkipExistingPages` 续跑。
   *
   * @param att PDF 附件
   * @param {Object} opts {scale?, maxPages?, skipExisting?, onPage?(i,total,phase), stopOnError?}
   * @returns {Promise<{pages:Object,count:number,skipped:number,done:number,total:number,cancelled:boolean}>}
   */
  async ocrAttachment(att, opts) {
    const o = opts || {};
    this._cancelled = false;

    const scale = this.clampScale(o.scale != null ? o.scale : Prefs.get("ocrRenderScale", "2"));
    const maxPages = this.clampMaxPages(
      o.maxPages != null ? o.maxPages : Prefs.get("ocrMaxPages", this.DEFAULT_MAX_PAGES));
    const skipExisting = (o.skipExisting != null)
      ? !!o.skipExisting
      : !!Prefs.get("ocrSkipExistingPages", true);

    const path = await this._attachmentPath(att);
    if (!path) throw this._err("OCR_NO_PDF_PATH", I18n.t("ocrNoPdf"));
    let bytes = null;
    try { bytes = await IOUtils.read(path); }
    catch (e) { throw this._err("OCR_NO_PDF_PATH", "读取 PDF 失败：" + (e && (e.message || e))); }
    if (!bytes || !bytes.length) throw this._err("OCR_NO_PDF_PATH", "PDF 文件为空");

    const doc = await this.openDocument(bytes);
    const total = Math.min(Number(doc.numPages) || 0, maxPages);
    const existing = await this.readSidecar(att);
    const pages = Object.assign({}, existing.pages);
    let done = 0;
    let skipped = 0;

    try {
      for (let i = 1; i <= total; i++) {
        if (this._cancelled) { this._diag("cancelled at page " + i + "/" + total); break; }
        const has = typeof pages[String(i)] === "string" && pages[String(i)].trim();
        if (has && skipExisting) {
          skipped++;
          if (o.onPage) { try { o.onPage(i, total, "skip"); } catch (e) { /* UI 回调 */ } }
          continue;
        }
        try {
          const b64 = await this.renderPage(doc, i, scale);
          const text = await this.askVision(b64, i);
          if (text) { pages[String(i)] = text; done++; }
          // 每页落盘：长扫描件中途被打断/取消，已识别的页不白跑（也是 skipExisting 续跑的前提）
          await this.writeSidecar(att, { pages, engine: this.ENGINE });
        } catch (e) {
          Zotero.logError(e);
          this._diag("page " + i + " failed: " + (e && (e.message || e)));
          if (o.stopOnError) throw e;
        }
        if (o.onPage) { try { o.onPage(i, total, "done"); } catch (e) { /* UI 回调 */ } }
      }
    } finally {
      try { if (doc && typeof doc.destroy === "function") await doc.destroy(); } catch (e) { /* ignore */ }
    }

    const merged = this.mergePages(pages, null);
    return {
      pages: merged.pages,
      count: merged.count,
      skipped,
      done,
      total,
      cancelled: !!this._cancelled,
    };
  },

  /**
   * 条目/附件 → 识别（找不到 PDF 附件时抛 OCR_NO_PDF，文案走 i18n）。
   * @returns {Promise<{att:Object, pages:Object, count:number, skipped:number}>}
   */
  async ocrItem(target, opts) {
    const att = this.pdfAttachmentOf(target);
    if (!att) throw this._err("OCR_NO_PDF", I18n.t("ocrNoPdf"));
    const r = await this.ocrAttachment(att, opts);
    return { att, ...r };
  },

  /* ==================== 运行时：菜单入口 ==================== */

  /**
   * 菜单入口：选中条目/附件 → 校验 PDF → 校验通道 → 确认页数 → 逐条识别 → 汇总。
   * 任何异常：`Zotero.logError` + 提示 `ocrFailed`（不静默）。
   */
  async runForSelected() {
    let win = null;
    try { win = Zotero.getMainWindow(); } catch (e) { win = null; }
    try {
      // ---- 1. 选中项 → PDF 附件清单（去重） ----
      let sel = [];
      try {
        const zp = Zotero.getActiveZoteroPane();
        sel = zp ? (zp.getSelectedItems() || []) : [];
      } catch (e) { sel = []; }

      const seen = new Set();
      const atts = [];
      for (const it of sel) {
        const a = this.pdfAttachmentOf(it);
        if (!a) continue;
        const key = String(a.id || a.key || "");
        if (!key || seen.has(key)) continue;
        seen.add(key);
        atts.push(a);
      }
      if (!atts.length) {
        Services.prompt.alert(win, "Papilot", I18n.t("ocrNoPdf"));
        return;
      }

      // ---- 2. 渲染引擎 / 通道 / 引擎类型三道闸门 ----
      if (!this._lib()) {
        Services.prompt.alert(win, "Papilot", I18n.t("ocrNoEngine"));
        return;
      }
      if (String(Prefs.get("ocrEngine", "vision")) !== "vision") {
        Services.prompt.alert(win, "Papilot", I18n.t("ocrNoEngine"));
        return;
      }
      if (!AIClient.hasKey()) {
        // 精确区分未登录 / 缺 Key：直接复用 AIClient.guidance()
        Services.prompt.alert(win, "Papilot", I18n.t("ocrNoKey") + "\n\n" + (AIClient.guidance() || ""));
        return;
      }

      // ---- 3. 页数确认（先算再问：识别很贵，不能让用户盲点） ----
      const maxPages = this.clampMaxPages(Prefs.get("ocrMaxPages", this.DEFAULT_MAX_PAGES));
      let planned = 0;
      for (const a of atts) planned += await this._numPages(a, maxPages);
      if (!planned) {
        Services.prompt.alert(win, "Papilot", I18n.t("ocrFailed"));
        return;
      }
      const okGo = Services.prompt.confirm(win, "Papilot · " + I18n.t("ocrTitle"),
        I18n.t("ocrConfirm").replace("{n}", String(planned)));
      if (!okGo) return;

      // ---- 4. 逐附件识别（ProgressWindow 显示每页进度） ----
      const pw = new Zotero.ProgressWindow({ closeOnClick: true });
      pw.changeHeadline("Papilot · " + I18n.t("ocrTitle"));
      pw.show();

      let donePages = 0;
      let skippedPages = 0;
      let failed = 0;
      for (const att of atts) {
        let title = "";
        try { title = att.getDisplayTitle() || att.attachmentFilename || ""; } catch (e) { title = ""; }
        let progress = null;
        try {
          progress = new pw.ItemProgress("chrome://papilot/content/icons/chat.svg", title);
        } catch (e) { progress = null; }
        try {
          const r = await this.ocrAttachment(att, {
            scale: Prefs.get("ocrRenderScale", "2"),
            maxPages,
            onPage: (i, total) => {
              try {
                if (!progress) return;
                progress.setText(title + " · " + i + "/" + total);
                progress.setProgress(Math.round((i / Math.max(1, total)) * 100));
              } catch (e) { /* 进度条失效不影响识别 */ }
            },
          });
          donePages += r.done;
          skippedPages += r.skipped;
          try { if (progress) progress.setProgress(100); } catch (e) { /* ignore */ }
        } catch (e) {
          failed++;
          Zotero.logError(e);
          this._diag("attachment failed (" + title + "): " + (e && (e.message || e)));
          try { if (progress) { progress.setError(); progress.setText(title + " · " + I18n.t("ocrFailed")); } }
          catch (e2) { /* ignore */ }
        }
      }

      try {
        const summary = I18n.t("ocrDone").replace("{n}", String(donePages))
          + (skippedPages ? "（" + (I18n.isZh ? "跳过已有 " : "skipped ") + skippedPages + "）" : "");
        new pw.ItemProgress("chrome://papilot/content/icons/chat.svg", summary).setProgress(100);
      } catch (e) { /* ignore */ }
      pw.startCloseTimer(failed ? 6000 : 3500);

      if (failed && !donePages && !skippedPages) {
        Services.prompt.alert(win, "Papilot", I18n.t("ocrFailed"));
      } else if (donePages) {
        // 提示可立即生效：问答下次读取就会用侧车文本（全文索引为空时自动回退）
        this._diag("done pages=" + donePages + " skipped=" + skippedPages + " failed=" + failed);
      }
    } catch (e) {
      Zotero.logError(e);
      this._diag("runForSelected FAILED: " + (e && (e.stack || e.message || e)));
      Services.prompt.alert(win, "Papilot", I18n.t("ocrFailed") + "\n\n" + ((e && (e.message || e)) || ""));
    }
  },
};
