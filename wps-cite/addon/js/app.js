// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* 加载项主控：功能区回调 + 五个命令
 *
 * 命令：
 *   插入引文   打开任务窗格检索 Zotero，选中后写到光标处（可多选，同处一篇/多篇）
 *   刷新       扫书签 → 取条目 → 重排编号与正文 → 重建文献表 → 同步台账
 *   文献表     同刷新（文献表锚点不存在时新建）
 *   回到原文   取光标所在引文的 page/anno → zotero://open-pdf 精确跳到 PDF 该页/该高亮
 *   查看引用   取光标所在引文 → 查本地台账 → 列出"哪个文档哪一处在引它"并可打开
 */
(function (root) {
  "use strict";
  const Doc = root.PPDoc;
  const M = root.PPModel;
  const L = root.PPLinks;
  const Z = root.PPZotero;

  const STYLES = { gb7714: root.PPStyleGB, apa: root.PPStyleAPA };
  const ANCHOR = "PPANCHOR";                 // 插入锚：点任务窗格会丢选区，先记下来

  function style() {
    const id = Doc.meta("PPCStyle") || "gb7714";
    return STYLES[id] || STYLES.gb7714;
  }

  function setStyle(id) {
    if (!STYLES[id]) throw new Error("未知样式：" + id);
    Doc.meta("PPCStyle", id);
    return STYLES[id];
  }

  function msg(t) {
    try { alert("Papilot Cite：" + t); } catch (e) { console.log(t); }
  }

  /** 代理的启动脚本路径（连接失败时告诉用户点哪里，而不是只喊"连不上"） */
  function proxyBat() {
    try {
      const base = String(wps.Env.GetAppDataPath() || "").replace(/\//g, "\\");
      return base + "\\PapilotCite\\start-proxy.bat";
    } catch (e) {
      return "%APPDATA%\\PapilotCite\\start-proxy.bat";
    }
  }

  /** 图片探针：不受 CORS 约束，代理日志里能看到它，用来区分"网不通"和"逻辑错" */
  function beacon() {
    try {
      const img = new Image();
      img.src = Z.PROXY + "/__beacon?t=" + Date.now();
    } catch (e) { /* 探针失败不影响任何流程 */ }
  }

  function connError(e) {
    if (e && e.status === 403) {
      return "Zotero 拒绝访问：请到 Zotero 设置 → 高级，勾选「允许此计算机上的其他应用程序与 Zotero 通信」。";
    }
    return "连接不上本地服务。请先双击运行：\n" + proxyBat() +
      "\n（或在 Papilot 仓库运行 python wps-cite/tools/install.py --repair）";
  }

  /** 远程日志：WPS 界面不能自动化点，把现场写进代理日志（proxy.log）才有得查 */
  function log(msg, extra) {
    try {
      fetch(Z.PROXY + "/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msg: msg, extra: extra || null }),
      });
    } catch (e) { /* 日志失败不影响功能 */ }
  }

  /** 探测这台 WPS 到底给了哪些界面 API（决定用任务窗格还是对话框还是兜底） */
  function apiProbe() {
    const t = (n) => { try { return typeof n; } catch (e) { return "throw"; } };
    return {
      CreateTaskPane: t(wps.CreateTaskPane),
      ShowDialog: t(wps.ShowDialog),
      CreateDialog: t(wps.CreateDialog),
      OAAssist: t(wps.OAAssist),
      Env: t(wps.Env),
      Alert: t(wps.OAAssist && wps.OAAssist.Alert),
    };
  }


  // ---------- 台账同步（反向链接的数据基础） ----------

  async function pushLinks(plan, byKey, docPath, extraCites) {
    const cites = [];
    for (const c of plan.clusters) {
      const first = c.alive && c.alive[0];
      if (!first) continue;
      const item = byKey[first.itemKey] || {};
      cites.push(L.record(docPath, {
        token: c.token,
        itemKey: first.itemKey,
        libId: first.libId,
        page: first.page,
        anno: first.anno,
        locator: first.locator,
        seq: first.seq,
        text: (item.title || "").slice(0, 80),
        snippet: c.items.map((x) => (byKey[x.itemKey] || {}).title || "").join(" / "),
      }));
    }
    for (const c of (extraCites || [])) cites.push(c);
    try {
      await Z.call("/links/upsert", { method: "POST", body: { doc: docPath, cites: cites } });
    } catch (e) {
      console.warn("台账写入失败（不影响文档）:", e);
    }
  }

  // ---------- 刷新 ----------

  async function refreshAll(opts) {
    const o = opts || {};
    const st = style();
    const scan = Doc.scan();
    // dotm（Zotero 官方插件）插入的是 Word 域，不是我们的书签；两类都要认
    const domainFields = (Doc.scanFields() || [])
      .map((f) => ({ field: f, parsed: (root.PPZFields ? root.PPZFields.parseField(f.code) : null) }))
      .filter((x) => x.parsed && x.parsed.items.length);

    if (!scan.length && !domainFields.length && !o.forceBib) {
      msg("本文档还没有引文。先用「插入引文」加一条（或用 Zotero 官方选项卡插入）。");
      return { ok: true, empty: true };
    }

    const keys = scan.map((s) => (root.PPCodes.parse(s.name) || {}).itemKey).filter(Boolean)
      .concat(domainFields.reduce((a, x) => a.concat(x.parsed.items.map((i) => i.key)), []));
    let byKey = {};
    try {
      byKey = await Z.items(keys);
    } catch (e) {
      msg(connError(e));
      return { ok: false };
    }

    const plan = M.plan(scan, byKey, st);

    if (!o.syncOnly) {
      // 先写文本再清理同簇的其余书签，避免书签在枚举中消失导致漏改
      for (const e of plan.edits) {
        if (e.remove) continue;
        if (!Doc.exists(e.name)) continue;
        Doc.setText(e.name, e.text);
      }
      for (const e of plan.edits) {
        if (!e.remove) continue;
        Doc.setText(e.name, "");
        Doc.remove(e.name);
      }
      const entries = plan.bib.map((b) => ({ item: byKey[b.itemKey], seq: b.seq, locator: "" }));
      const lines = st.bib(entries);
      if (lines.length || o.forceBib) Doc.setBib(lines);
    }

    const domainCites = [];
    for (const x of domainFields) {
      const f = x.parsed;
      for (const it of f.items) {
        domainCites.push(L.record(Doc.docPath(), {
          token: f.citationID || it.key,
          itemKey: it.key, libId: it.libId || 1,
          page: 0, anno: "", locator: it.locator || "",
          seq: 0, text: (byKey[it.key] || {}).title || "",
        }));
      }
    }
    await pushLinks(plan, byKey, Doc.docPath(), domainCites);

    if (plan.missing.length) {
      msg(`有 ${plan.missing.length} 条引文在 Zotero 里找不到对应条目（可能是别处复制过来的），已标为 [?]。`);
    }
    return { ok: true, count: plan.clusters.length, missing: plan.missing.length };
  }

  // ---------- 插入 ----------

  /** 记住当前插入点，供任务窗格回调时使用 */
  function markAnchor() {
    try {
      const d = Doc.doc();
      if (d.Bookmarks.Exists(ANCHOR)) d.Bookmarks.Item(ANCHOR).Delete();
      d.Bookmarks.Add(ANCHOR, Doc.app().Selection.Range);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * 在锚点处插入一处引文。
   * @param items [{key, libId, page, anno, locator}]
   */
  async function insertCitation(items) {
    if (!items || !items.length) return { ok: false, error: "没有选中文献" };
    const d = Doc.doc();
    if (d.Bookmarks.Exists(ANCHOR)) {
      Doc.gotoBookmark(ANCHOR);
    }
    const byKey = await Z.items(items.map((x) => x.key));

    // 同一处多篇共用一个 token，逐条建书签
    let tok = null;
    const names = [];
    let idx = 0;
    for (const it of items) {
      const p = {
        itemKey: String(it.key).toUpperCase(),
        page: it.page || 0,
        anno: it.anno || "",
        locator: it.locator || "",
        libId: it.libId || 1,
        idx: idx,
      };
      const name = tok
        ? root.PPCodes.makeInCluster(Doc.exists, tok, p, idx)
        : root.PPCodes.make(Doc.exists, p);
      if (!tok) tok = root.PPCodes.parse(name).token;
      names.push(name);
      idx++;
    }

    // 渲染这一处引文的文本（用插入后的整体顺序重算一次最稳）
    const probe = Doc.scan().concat(names.map((n) => ({ name: n, start: 1e9 })));
    const plan0 = M.plan(probe, byKey, style());
    const text = (plan0.edits.find((e) => e.name === names[0]) || {}).text || "[]";

    Doc.insertAtCursor(text, names[0]);
    for (let i = 1; i < names.length; i++) {
      // 后续成员紧跟在第一个书签之后，占位长度为 0，仅用于记住条目身份
      const bm = d.Bookmarks.Item(names[0]);
      const r = bm.Range;
      r.Collapse(0);
      d.Bookmarks.Add(names[i], r);
    }
    if (d.Bookmarks.Exists(ANCHOR)) d.Bookmarks.Item(ANCHOR).Delete();

    await refreshAll({});
    return { ok: true, names: names, text: text };
  }

  // ---------- 双向跳转 ----------

  /** 取光标处的引文身份：优先我们自己的书签，其次 dotm 的域 */
  function citationHere() {
    const at = Doc.citationAtCursor();
    if (at) {
      return { key: at.parsed.itemKey, libId: at.parsed.libId, page: at.parsed.page, anno: at.parsed.anno, src: "bookmark" };
    }
    const f = Doc.fieldAtCursor();
    if (f && root.PPZFields) {
      const parsed = root.PPZFields.parseField(f.code);
      if (parsed && parsed.items.length) {
        const it = parsed.items[0];
        return { key: it.key, libId: it.libId, page: 0, anno: "", src: "field", locator: it.locator || "" };
      }
    }
    return null;
  }

  async function gotoSource() {
    const p = citationHere();
    if (!p) {
      msg("光标不在引文上。把光标放到引文（如 [1] 或 Zotero 域）里，再点「回到原文」。");
      return { ok: false };
    }
    let uri = "";
    if (p.anno || p.page) {
      const pdf = await Z.bestPdf(p.itemKey);
      if (pdf) uri = L.pdfUri(pdf.key, p.page, p.anno);
    }
    if (!uri) uri = L.selectUri(p.itemKey, p.libId);
    try {
      await Z.call("/open", { method: "POST", body: { uri: uri } });
    } catch (e) {
      msg("打不开 Zotero：" + (e.message || e) + "。请确认 Zotero 已安装并能响应 zotero:// 链接。");
      return { ok: false, error: String(e) };
    }
    return { ok: true, uri: uri };
  }

  async function findCitations() {
    const p = citationHere();
    if (!p) {
      msg("光标不在引文上。");
      return { ok: false };
    }
    let rows = [];
    try {
      const q = new URLSearchParams({ itemKey: p.itemKey });
      if (p.page) q.set("page", String(p.page));
      rows = (await Z.call("/links?" + q.toString())) || [];
    } catch (e) {
      msg("查台账失败：" + (e.message || e));
      return { ok: false };
    }
    const cur = Doc.docPath().toLowerCase();
    const others = (rows || []).filter((r) => String(r.doc).toLowerCase() !== cur);
    if (!others.length) {
      msg("除了当前文档，还没有别的文档引用这条文献。");
      return { ok: true, rows: [] };
    }
    const text = others.slice(0, 12)
      .map((r, i) => `${i + 1}. ${r.doc}${r.page ? "（第 " + r.page + " 页）" : ""}${r.text ? " · " + r.text : ""}`)
      .join("\n");
    if (confirm(`共 ${others.length} 处其它引用：\n\n${text}\n\n点「确定」打开第一个文档。`)) {
      await Z.call("/open", { method: "POST", body: { path: others[0].doc } }).catch(() => {});
    }
    return { ok: true, rows: others };
  }

  // ---------- 任务窗格 ----------

  let pane = null;

  /** 兜底：没有任务窗格/对话框时，用两个 prompt 完成"搜一条、插一条" */
  async function quickPick() {
    let q = "";
    try {
      q = prompt("检索 Zotero（输入关键词，回车后按序号选一条）") || "";
    } catch (e) {
      log("prompt unavailable", { err: String((e && e.message) || e) });
      msg("本机 WPS 没有可用的选择界面，且 prompt 也不可用。请改用 WPS 自带的「Zotero」选项卡插入引文。");
      return;
    }
    if (!q.trim()) return;
    const rows = await Z.search(q.trim(), 5);
    if (!rows.length) {
      msg("没找到条目：" + q);
      return;
    }
    const head = rows.slice(0, 5).map((r, i) => `${i + 1}. ${(r.data.title || "").slice(0, 50)}`).join("\n");
    const pick = prompt(`找到 ${rows.length} 条：\n${head}\n\n输入序号（默认 1）`, "1") || "1";
    const idx = Math.min(Math.max(parseInt(pick, 10) || 1, 1), rows.length) - 1;
    const r = rows[idx];
    await insertCitation([{ key: r.key, libId: r.libId || 1 }]);
    msg("已插入：" + (r.data.title || r.key));
  }

  /** WPS 各版本对 CreateTaskPane 的签名不完全一致，按可能性逐个试 */
  /** 弹窗页的绝对地址：ShowDialog 传相对路径会被 CEF 当成网址去解析（ERR_NAME_NOT_RESOLVED） */
  function pickerUrl() {
    try {
      const raw = String(wps.Env.GetAppDataPath() || "");
      const base = raw.split("\\").join("/").replace(/\/+$/, "");
      const ver = root.PPC_VERSION || "0.1.0";
      return "file:///" + base + "/kingsoft/wps/jsaddons/papilot-cite_" + ver + "/picker.html";
    } catch (e) {
      return "";
    }
  }

  function tryTaskPane() {
    const url = "picker.html";
    const tries = [
      ["4-arg", () => wps.CreateTaskPane(url, "插入引文", 380, 520)],
      ["2-arg", () => wps.CreateTaskPane(url, "插入引文")],
      ["1-arg", () => wps.CreateTaskPane(url)],
    ];
    let last = null;
    for (const [tag, fn] of tries) {
      try {
        const p = fn();
        if (p) {
          log("taskpane created", { sig: tag });
          return p;
        }
        log("taskpane returned null", { sig: tag });
      } catch (e) {
        last = e;
        log("taskpane attempt failed", { sig: tag, err: String((e && e.message) || e) });
      }
    }
    throw last || new Error("CreateTaskPane 全部签名失败");
  }

  /** 首次加载自动探一次"窗格能不能建"，把结果写进日志（只探一次，用代理配置做标记） */
  async function probePaneOnce() {
    try {
      const cfg = await Z.call("/config");
      if (cfg && cfg.pickerProbed) return;
    } catch (e) { return; }
    let result = "skipped";
    try {
      const p = tryTaskPane();
      try { p.Visible = false; } catch (e) { /* 关不掉也没关系 */ }
      result = "ok";
    } catch (e) {
      result = "failed: " + String((e && e.message) || e);
    }
    log("taskpane self-test", { result: result });
    try {
      await Z.call("/config", { method: "POST", body: { pickerProbed: true } });
    } catch (e) { /* 标记失败就下次再探 */ }
  }

  /** 主页面定时取窗格放进队列的选择（窗格若没有 wps 对象就靠这条路） */
  let pollTimer = null;
  function startQueuePoll() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      try {
        const r = await Z.call("/queue");
        const items = (r && r.items) || [];
        if (!items.length) return;
        log("queue got", { n: items.length });
        const res = await insertCitation(items);
        msg(res && res.ok ? "已插入 " + items.length + " 条引文" : "插入失败：" + ((res && res.error) || ""));
      } catch (e) {
        // 这里不能静默：队列插入失败时用户看不到任何提示，只能靠日志
        log("queue insert failed", {
          err: String((e && e.message) || e),
          stack: String((e && e.stack) || "").slice(0, 500),
        });
        msg("插入失败：" + String((e && e.message) || e));
      }
    }, 1200);
  }

  function openPicker() {
    markAnchor();
    const probe = apiProbe();
    log("openPicker", probe);
    // ① 首选**弹出对话框**（最接近 Word 插件"点一下弹搜索框"的手感）
    if (probe.ShowDialog === "function") {
      const abs = pickerUrl();
      const cands = [];
      if (abs) cands.push(["abs-4", () => wps.ShowDialog(abs, "插入引文", 420, 560)]);
      cands.push(["rel-4", () => wps.ShowDialog("picker.html", "插入引文", 420, 560)]);
      cands.push(["abs-1", () => abs && wps.ShowDialog(abs)]);
      for (const [tag, fn] of cands) {
        try {
          fn();
          log("showdialog ok", { sig: tag });
          return;
        } catch (e) {
          log("showdialog attempt failed", { sig: tag, err: String((e && e.message) || e) });
        }
      }
    }
    // ② 退到任务窗格（可停靠、可边看边点）
    try {
      if (probe.CreateTaskPane === "function") {
        if (!pane) pane = tryTaskPane();
        pane.Visible = true;
        log("taskpane ok");
        return;
      }
    } catch (e) {
      log("taskpane failed", { err: String((e && e.message) || e) });
    }
    // ③ 再退到 prompt 兜底（丑但能用）
    log("fallback quickPick");
    Promise.resolve(quickPick()).catch((e) => msg(String((e && e.message) || e)));
  }

  // ---------- 功能区 ----------

  /** 走 Zotero 原生集成命令；结束后同步一次台账（域解析见 zfields.js） */
  async function nativeRun(command) {
    try {
      const r = await root.PPIntegration.run(command);
      if (r && r.ok) {
        await refreshAll({ syncOnly: true });   // 只同步台账与文献状态，不重排文本（文本由 Zotero 写）
      }
      return r;
    } catch (e) {
      msg(String((e && e.message) || e));
      return { ok: false };
    }
  }

  function OnAddinLoad(ribbonUI) {
    if (typeof wps.ribbonUI !== "object") wps.ribbonUI = ribbonUI;
    // 把"这台 WPS 提供了哪些界面 API"写进代理日志：后续点按钮走哪条路，靠它决定
    log("addin loaded", Object.assign({ version: root.PPC_VERSION || "" }, apiProbe()));
    // 启动时打一发探针（日志可见）+ 探一次链路，只记录不弹窗
    beacon();
    Z.health().then((h) => {
      if (!h.ok) console.warn("Papilot Cite 代理未运行");
      else if (!h.localApi) console.warn("Zotero 本地 API 未开启");
    });
    Promise.resolve(probePaneOnce()).catch(() => {});
    startQueuePoll();
    return true;
  }

  function OnAction(control) {
    const id = control && control.Id;
    log("action", { id: id });
    const run = {
      /* 三个主命令走 Zotero 原生对话框（integration 协议）：页面与功能与官方 Word 插件一致。
       *
       * ★ 命令名必须和 Zotero.Integration.Interface.prototype 上的方法名**逐字一致**
       *   （integration.js:708-1013 的方法表）：
       *     addCitation / editCitation / addEditCitation / addNote / addAnnotation /
       *     addBibliography / editBibliography / addEditBibliography /
       *     citationExplorer / refresh / removeCodes / setDocPrefs / exportDocument
       *   Zotero 侧就是 `new Interface(...)[command]()` —— 名字写错不是"没效果"，
       *   而是抛 TypeError 后**连 complete 都走不到**，Zotero 永久 inProgress，
       *   我们这边等 30 分钟超时。踩过：把 refresh 写成 refreshDocument，
       *   结果【刷新】点了完全没反应（日志里连一条 cmd 都没有）。
       *
       * 为什么用 AddEdit* 而不是 Add*：
       *   addEditCitation 会先 `_doc.cursorInField()`，光标在某条引注里就**编辑它**，
       *   否则新建 —— 这正是官方功能区那个按钮的行为（integration.js:740）。
       *   addCitation 只会无脑新建，于是在已有引注里点插入会嵌域。
       *   addEditBibliography 同理：已有文献表就编辑、没有才新建（:860），
       *   而 addBibliography 每次都新建一条，会把文档里堆出好几张文献表。 */
      btnCite: () => nativeRun("addEditCitation"),
      btnBib: () => nativeRun("addEditBibliography"),
      btnRefresh: () => nativeRun("refresh"),
      btnGoto: () => gotoSource(),
      btnFind: () => findCitations(),
      btnAbout: () => msg(`Papilot Cite ${root.PPC_VERSION || ""}\n\n` +
        `引用插入 + 引文与原文双向链接。\n` +
        `许可：Apache-2.0（本加载项）；样式算法自实现。`),
    }[id];
    if (!run) {
      log("action unknown", { id: id, keys: Object.keys(control || {}) });
      msg("这个按钮没有绑定命令（id=" + id + "），请反馈这条提示。");
      return true;
    }
    try {
      Promise.resolve(run()).catch((e) => {
        log("action failed", { id: id, err: String((e && e.message) || e), stack: String(e && e.stack || "").slice(0, 400) });
        msg(String((e && e.message) || e));
      });
    } catch (e) {
      log("action threw", { id: id, err: String((e && e.message) || e) });
      msg(String((e && e.message) || e));
    }
    return true;
  }

  function GetImage(control) {
    const map = {
      btnCite: "img/cite.svg", btnRefresh: "img/refresh.svg", btnBib: "img/bib.svg",
      btnGoto: "img/goto.svg", btnFind: "img/find.svg", btnAbout: "img/about.svg",
    };
    try {
      return map[control.Id] || "";
    } catch (e) {
      return "";
    }
  }

  root.PPApp = {
    OnAddinLoad, OnAction, GetImage, proxyBat, beacon, connError, log, pickerUrl,
    refreshAll, insertCitation, gotoSource, findCitations,
    style, setStyle, STYLES, ANCHOR, citationHere,
  };
}(typeof globalThis !== "undefined" ? globalThis : this));
