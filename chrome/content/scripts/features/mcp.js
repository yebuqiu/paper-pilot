/* PaperPilot MCP 对外供给（0.24.0，功能借鉴 cookjohn/zotero-mcp）
 *
 * 解决的问题：PaperPilot 目前是「用 AI 的工具」。反过来——让**别人的 AI 客户端
 * （Claude Desktop / Cursor / 自建 Agent）能调用你的文献库**，是另一个生态位：
 * 把「库检索 / 读全文 / 读批注 / 写笔记 / 看分类」封装成 MCP 工具对外供给。
 *
 * 零外部依赖的载体：Zotero 自己就有一个只监听 127.0.0.1 的 HTTP 服务（默认 23119）。
 * 我们注册一个端点 /paperpilot/mcp，实现 JSON-RPC 2.0 + MCP 的 Streamable HTTP
 * 传输里「单次 JSON 响应」那一支（服务器一次性返回 application/json，不用 SSE）。
 *
 * 安全纪律：
 *   - 服务本身只绑 127.0.0.1，公网不可达；
 *   - 每个请求都要 Bearer 令牌（首次自动生成、随机 48 hex，可在窗口里重置）；
 *   - 默认**不启用**（opt-in），窗口里一键开启并给出客户端配置 JSON。
 *
 * 可测性：handleMessage / handlePayload / toolsList / _authOk / _timingSafeEq 全是纯逻辑，
 * 不碰 Zotero，可离线断言；只有 callTool 里的工具实现需要真实库。
 */
/* 0.50.0 追加「反向供给」：把 PaperPilot 自己的 Agent 工具（AgentTools.TOOLS）
 * 以 list_agent_tools / run_agent_tool 两个 MCP 工具暴露给外部 AI。
 * 与上面 8 个原生工具的区别：原生工具是直接操作 Zotero API 的窄接口，
 * 这两个是**桥接**——外部 AI 能复用「检索/详情/全文/笔记/标签」同一套实现，
 * 行为与 PaperPilot 内置 AI 助手完全一致。
 * 写操作门控：MCP 无人交互，绝不用 Services.prompt.confirm 阻塞请求，
 * 改为要求调用方在参数里传 allowWrite: true 显式授权。
 */
/* global Zotero, Services, Prefs, I18n, LibSearch, AIChat, Annotations, MdLite, AgentTools */

var MCP = {
  PATH: "/paperpilot/mcp",
  PROTOCOL_VERSIONS: ["2025-06-18", "2025-03-26", "2024-11-05"],
  DEFAULT_PROTOCOL: "2025-06-18",
  _registered: false,
  // run_agent_tool 单次返回给外部 AI 的字符上限（对齐 AgentTools.RESULT_MAX）
  AGENT_RESULT_MAX: 8000,

  /* ---------------- 工具定义（纯数据） ---------------- */

  TOOLS: [
    {
      name: "search_library",
      description: "在用户的本地 Zotero 文献库中做关键词检索（标题/标签/期刊/摘要 + 可选全文复核），返回按相关度排序的候选文献及其条目 key。适合回答「我的库里有没有讲过 X」。",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "检索词或自然语言问题" },
          limit: { type: "integer", description: "返回条数上限（1-30，默认 8）" },
          fulltext: { type: "boolean", description: "是否读 PDF 全文索引复核（默认 true，较慢但更准）" },
        },
        required: ["query"],
      },
    },
    {
      name: "get_item",
      description: "按 Zotero 条目 key、DOI、arXiv ID 或标题，取回该文献的完整元数据（作者/期刊/年份/标签/分类/附件/摘要）。",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "条目 key（8 位）、DOI、arXiv ID 或标题" } },
        required: ["id"],
      },
    },
    {
      name: "read_fulltext",
      description: "读取某条文献 PDF 的全文（取自 Zotero 全文索引，扫描件无文本层时返回空并说明）。",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "条目 key / DOI / 标题" },
          maxChars: { type: "integer", description: "返回字符上限（默认 20000）" },
        },
        required: ["id"],
      },
    },
    {
      name: "list_annotations",
      description: "列出某条文献 PDF 上的全部高亮与批注（含页码与备注）。",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "条目 key / DOI / 标题" } },
        required: ["id"],
      },
    },
    {
      name: "create_note",
      description: "在库中创建一条笔记（Markdown 正文）；给了 id 则挂到该条目下，否则建为库级笔记。",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "（可选）目标条目 key / DOI / 标题" },
          title: { type: "string", description: "笔记标题" },
          markdown: { type: "string", description: "笔记正文（Markdown）" },
        },
        required: ["title", "markdown"],
      },
    },
    {
      name: "list_collections",
      description: "列出用户库的全部分类（含层级与直接子条目数）。",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "library_stats",
      description: "文献库概览：条目总数、各类型分布、Top 标签、按年份分布、有附件的比例。",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "list_recent",
      description: "最近加入库的文献列表。",
      inputSchema: {
        type: "object",
        properties: { limit: { type: "integer", description: "返回条数（默认 20，上限 100）" } },
      },
    },

    /* ---- 0.50.0 桥接 PaperPilot 的 Agent 工具（只列/只跑用户在设置里启用的） ---- */

    {
      name: "list_agent_tools",
      description: "列出 PaperPilot AI 助手当前启用的 Agent 工具（id、名称、说明、是否只读、参数说明）。" +
        "这些工具用 run_agent_tool 调用；只列出用户在设置里启用的（被禁用的不会出现）。",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "run_agent_tool",
      description: "调用 PaperPilot AI 助手的一个 Agent 工具（先用 list_agent_tools 查可用 id）。" +
        "读工具直接执行；**写工具**（会修改文献库）需要额外传 allowWrite: true 显式授权，" +
        "否则直接返回拒绝说明——MCP 无人在场确认，不会弹窗阻塞。",
      inputSchema: {
        type: "object",
        properties: {
          tool: { type: "string", description: "Agent 工具 id（见 list_agent_tools）" },
          args: { type: "object", description: "传给该工具的参数对象（按 list_agent_tools 里的 args 说明）" },
          allowWrite: { type: "boolean", description: "写操作授权：目标工具非只读时必须为 true，否则拒绝执行" },
        },
        required: ["tool"],
      },
    },
  ],

  toolsList() {
    // 深拷贝，避免外部改动污染定义
    return this.TOOLS.map((t) => JSON.parse(JSON.stringify(t)));
  },

  serverVersion() {
    try { return String(Zotero.PaperPilot.version || "0"); } catch (e) { return "0"; }
  },

  /* ---------------- JSON-RPC 2.0（纯逻辑） ---------------- */

  ok(id, result) { return { jsonrpc: "2.0", id, result }; },
  err(id, code, message, data) {
    const e = { code, message: String(message == null ? "" : message) };
    if (data !== undefined) e.data = data;
    return { jsonrpc: "2.0", id: id == null ? null : id, error: e };
  },

  /**
   * 单条消息 → 响应（notification 返回 null）
   * @param {object} msg JSON-RPC 消息
   * @param {{callTool?:Function}} ctx 可注入的调用器（测试用）
   */
  async handleMessage(msg, ctx) {
    const c = ctx || {};
    if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return this.err(msg && msg.id != null ? msg.id : null, -32600, "Invalid Request");
    }
    const id = msg.id == null ? null : msg.id;
    const isNotification = msg.id == null;
    const method = msg.method;
    try {
      if (method === "initialize") {
        const want = (msg.params && msg.params.protocolVersion) || "";
        const protocolVersion = this.PROTOCOL_VERSIONS.indexOf(want) >= 0 ? want : this.DEFAULT_PROTOCOL;
        return isNotification ? null : this.ok(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "paperpilot", title: "PaperPilot (Zotero)", version: this.serverVersion() },
          instructions: "PaperPilot 把用户的本地 Zotero 文献库作为工具提供。先用 search_library 找文献，" +
            "拿到条目 key 后用 read_fulltext / list_annotations 深读，用 get_item 取元数据，用 create_note 写回笔记。",
        });
      }
      if (method.indexOf("notifications/") === 0) return null; // initialized / cancelled / progress …
      if (method === "ping") return isNotification ? null : this.ok(id, {});
      if (method === "tools/list") return isNotification ? null : this.ok(id, { tools: this.toolsList() });
      if (method === "tools/call") {
        const name = msg.params && msg.params.name;
        const args = (msg.params && msg.params.arguments) || {};
        if (!name) return isNotification ? null : this.err(id, -32602, "Missing tool name");
        const callTool = c.callTool || ((n, a) => this.callTool(n, a));
        const result = await callTool(name, args);
        return isNotification ? null : this.ok(id, result);
      }
      if (method === "resources/list") return isNotification ? null : this.ok(id, { resources: [] });
      if (method === "prompts/list") return isNotification ? null : this.ok(id, { prompts: [] });
      if (method === "logging/setLevel") return isNotification ? null : this.ok(id, {});
      return isNotification ? null : this.err(id, -32601, "Method not found: " + method);
    } catch (e) {
      return isNotification ? null : this.err(id, -32603, String((e && e.message) || e));
    }
  },

  /**
   * HTTP body（单条或批量）→ 响应体
   * @returns {object|Array|null} null = 只有通知，无需响应（HTTP 204）
   */
  async handlePayload(body, ctx) {
    if (Array.isArray(body)) {
      if (!body.length) return this.err(null, -32600, "Invalid Request");
      const out = [];
      for (const m of body) {
        const r = await this.handleMessage(m, ctx);
        if (r) out.push(r);
      }
      return out.length ? out : null;
    }
    return this.handleMessage(body, ctx);
  },

  _text(s, isError) {
    return { content: [{ type: "text", text: String(s == null ? "" : s) }], isError: !!isError };
  },

  /* ---------------- 鉴权 ---------------- */

  _makeToken() {
    try {
      if (typeof crypto !== "undefined" && crypto && crypto.getRandomValues) {
        const a = new Uint8Array(24);
        crypto.getRandomValues(a);
        return Array.from(a).map((x) => x.toString(16).padStart(2, "0")).join("");
      }
    } catch (e) { /* ignore */ }
    try { return String(Zotero.Utilities.randomString(32)); } catch (e) { /* ignore */ }
    let s = "";
    for (let i = 0; i < 48; i++) s += "0123456789abcdef"[Math.floor(Math.random() * 16)];
    return s;
  },

  /** 读取令牌；没有则生成并持久化（首次自动） */
  token(create) {
    let t = "";
    try { t = String(Prefs.get("mcpToken", "") || ""); } catch (e) { t = ""; }
    if (!t && create !== false) {
      t = this._makeToken();
      try { Prefs.set("mcpToken", t); } catch (e) { /* ignore */ }
    }
    return t;
  },

  regenerateToken() {
    const t = this._makeToken();
    try { Prefs.set("mcpToken", t); } catch (e) { /* ignore */ }
    return t;
  },

  enabled() {
    try { return Prefs.get("mcpEnabled", false) === true; } catch (e) { return false; }
  },

  /** 常量时间比较（避免令牌逐字符试探） */
  _timingSafeEq(a, b) {
    const x = String(a || ""), y = String(b || "");
    if (!x || !y || x.length !== y.length) return false;
    let diff = 0;
    for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
    return diff === 0;
  },

  /** 从请求头/查询串取出令牌并校验（纯逻辑，headers 可为普通对象或 Zotero Headers 代理） */
  _authOk(headers, searchParams) {
    const want = this.token();
    if (!want) return false;
    const h = headers || {};
    const pick = (k) => {
      try { if (typeof h.get === "function") return h.get(k); } catch (e) { /* ignore */ }
      return h[k];
    };
    let got = "";
    const auth = String(pick("authorization") || pick("Authorization") || "");
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m) got = m[1];
    if (!got) got = String(pick("x-paperpilot-token") || pick("X-PaperPilot-Token") || "");
    if (!got && searchParams) {
      try { got = String((typeof searchParams.get === "function" ? searchParams.get("token") : searchParams.token) || ""); } catch (e) { got = ""; }
    }
    return this._timingSafeEq(String(got).trim(), want);
  },

  /* ---------------- HTTP 传输层 ---------------- */

  endpointUrl() {
    return "http://127.0.0.1:" + this.serverStatus().port + this.PATH;
  },

  /**
   * Zotero 本地 HTTP 服务状态。
   * ⚠️ 端点由 Zotero 自己的「连接器服务」承载，而该服务受核心 pref
   * `httpServer.enabled` 控制（默认 true，但用户可在「高级 → 其他」里关掉）。
   * 关掉时我们的端点根本不会被监听 —— 必须显式检测并在窗口里说明，
   * 否则表现就是「配好了客户端却连不上」这种静默失败。
   */
  serverStatus() {
    let enabled = true, port = 23119, running = false;
    try { enabled = Zotero.Prefs.get("httpServer.enabled", true) !== false; } catch (e) { enabled = true; }
    try { const p = Zotero.Server.port; if (p) { port = p; running = true; } } catch (e) { running = false; }
    return { enabled, running, port };
  },

  /** 确保本地服务在跑（只在用户显式点击时调用；不静默改用户配置） */
  async ensureServer() {
    try {
      if (Zotero.Prefs.get("httpServer.enabled", true) === false) {
        Zotero.Prefs.set("httpServer.enabled", true, true);
      }
      if (!this.serverStatus().running) await Zotero.Server.init();
      return this.serverStatus();
    } catch (e) {
      const st = this.serverStatus();
      st.error = String((e && e.message) || e);
      return st;
    }
  },

  clientConfig() {
    return {
      mcpServers: {
        paperpilot: {
          type: "http",
          url: this.endpointUrl(),
          headers: { Authorization: "Bearer " + this.token() },
        },
      },
    };
  },

  info() {
    const st = this.serverStatus();
    return {
      server: "paperpilot-mcp",
      version: this.serverVersion(),
      protocolVersion: this.DEFAULT_PROTOCOL,
      endpoint: this.endpointUrl(),
      enabled: this.enabled(),
      zoteroServer: { enabled: st.enabled, running: st.running, port: st.port },
      transport: "Streamable HTTP（单次 application/json 响应）",
      auth: "Authorization: Bearer <token>；令牌见 PaperPilot 的 MCP 窗口",
      tools: this.TOOLS.map((t) => t.name),
    };
  },

  /** Zotero 端点的 init（单参数形态）：返回 [status, contentType, body] */
  async _handleHttp(req) {
    const headers = (req && req.headers) || {};
    const sp = req && req.searchParams;
    if (!this.enabled()) {
      return [503, "application/json", JSON.stringify(this.err(null, -32000, "MCP endpoint is disabled. Enable it in PaperPilot → MCP."))];
    }
    if (!this._authOk(headers, sp)) {
      // Zotero 的 responseCodes 没有 401，用 403（语义等价：拒绝）
      const r = this.err(null, -32001, "Unauthorized: missing or invalid token");
      return [403, "application/json", JSON.stringify(r)];
    }
    if (req.method === "GET") {
      return [200, "application/json", JSON.stringify(this.info(), null, 2)];
    }
    if (req.method !== "POST") {
      return [400, "application/json", JSON.stringify(this.err(null, -32600, "Only GET/POST supported"))];
    }
    let resp;
    try {
      resp = await this.handlePayload(req.data, { callTool: (n, a) => this.callTool(n, a) });
    } catch (e) {
      return [400, "application/json", JSON.stringify(this.err(null, -32700, "Parse error: " + String((e && e.message) || e)))];
    }
    if (resp == null) return [204, null, null]; // 只有通知
    return [200, "application/json", JSON.stringify(resp)];
  },

  /** 注册 Zotero 本地端点（幂等） */
  register() {
    try {
      if (!Zotero.Server || !Zotero.Server.Endpoints) return false;
      if (Zotero.Server.Endpoints[this.PATH]) { this._registered = true; return true; }
      const self = this;
      const Ctor = function () {};
      Ctor.prototype = {
        supportedMethods: ["GET", "POST"],
        supportedDataTypes: ["application/json"],
        // 允许任意 UA 访问（含 Mozilla/*）——安全由 Bearer 令牌保证；
        // 服务本身只监听 127.0.0.1，公网不可达。
        allowRequestsFromUnsafeWebContent: true,
        init(req) { return self._handleHttp(req); },
      };
      Zotero.Server.Endpoints[this.PATH] = Ctor;
      this._registered = true;
      try { this.token(); } catch (e) { /* 首次顺带生成令牌 */ }
      return true;
    } catch (e) {
      try { Zotero.logError(e); } catch (_) { /* ignore */ }
      return false;
    }
  },

  unregister() {
    try {
      if (Zotero.Server && Zotero.Server.Endpoints && Zotero.Server.Endpoints[this.PATH]) {
        delete Zotero.Server.Endpoints[this.PATH];
      }
    } catch (e) { /* ignore */ }
    this._registered = false;
  },

  /** 端到端自检：真的往 127.0.0.1 发一次 tools/list */
  async selfTest() {
    let st = this.serverStatus();
    if (!st.running) st = await this.ensureServer();
    if (!st.running) {
      const err = new Error(st.error || "Zotero 本地 HTTP 服务未运行（可在本窗口点「启用本地服务」）");
      err.serverStatus = st;
      throw err;
    }
    const url = this.endpointUrl();
    const r = await Zotero.HTTP.request("POST", url, {
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + this.token() },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      responseType: "json",
      timeout: 10000,
    });
    const data = r.response;
    const tools = (data && data.result && data.result.tools) || [];
    return { ok: !!tools.length, count: tools.length, names: tools.map((t) => t.name), serverStatus: this.serverStatus() };
  },

  /** 本地（不经 HTTP）跑一遍核心协议，用于无网络/未启用时也能验证逻辑 */
  async localSelfTest() {
    const out = [];
    out.push(await this.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }));
    out.push(await this.handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    out.push(await this.handleMessage({ jsonrpc: "2.0", id: 3, method: "nope" }));
    return out;
  },

  /* ---------------- 工具实现（依赖真实库） ---------------- */

  async callTool(name, args) {
    const a = args || {};
    try {
      switch (name) {
        case "search_library": return await this._toolSearch(a);
        case "get_item": return await this._toolGetItem(a);
        case "read_fulltext": return await this._toolReadFulltext(a);
        case "list_annotations": return await this._toolListAnnotations(a);
        case "create_note": return await this._toolCreateNote(a);
        case "list_collections": return await this._toolListCollections();
        case "library_stats": return await this._toolLibraryStats();
        case "list_recent": return await this._toolListRecent(a);
        case "list_agent_tools": return this._toolListAgentTools();
        case "run_agent_tool": return await this._toolRunAgentTool(a);
        default: return this._text("未知工具：" + name, true);
      }
    } catch (e) {
      return this._text("工具执行失败：" + String((e && e.message) || e), true);
    }
  },

  /** 条目 key / 数字 id / DOI / arXiv id / 标题 → Zotero 条目 */
  async resolveItem(idOrQuery) {
    const q = String(idOrQuery == null ? "" : idOrQuery).trim();
    if (!q) return null;
    const libID = Zotero.Libraries.userLibraryID;
    if (/^[A-Z0-9]{8}$/.test(q)) {
      try { const it = Zotero.Items.getByLibraryAndKey(libID, q); if (it) return it; } catch (e) { /* ignore */ }
    }
    if (/^\d+$/.test(q)) {
      try { const it = Zotero.Items.get(Number(q)); if (it) return it; } catch (e) { /* ignore */ }
    }
    const s = new Zotero.Search();
    s.libraryID = libID;
    if (/^10\.\d{4,9}\//.test(q)) s.addCondition("DOI", "is", q);
    else if (/^(arxiv:)?\d{4}\.\d{4,5}(v\d+)?$/i.test(q)) s.addCondition("archiveID", "contains", q.replace(/^arxiv:/i, ""));
    else s.addCondition("quicksearch-everything", "contains", q);
    let ids = [];
    try { ids = await s.search(); } catch (e) { ids = []; }
    if (!ids.length) return null;
    const it = await Zotero.Items.getAsync(ids[0]);
    return it || null;
  },

  year(item) {
    try { const m = String(item.getField("date") || "").match(/(\d{4})/); return m ? m[1] : ""; } catch (e) { return ""; }
  },

  authors(item, max) {
    try {
      const cs = item.getCreators() || [];
      const names = cs.slice(0, max || 6).map((c) => [c.firstName, c.lastName].filter(Boolean).join(" ") || c.name || "").filter(Boolean);
      return names.join(", ") + (cs.length > (max || 6) ? " et al." : "");
    } catch (e) { return ""; }
  },

  brief(item) {
    const g = (f) => { try { return String(item.getField(f) || ""); } catch (e) { return ""; } };
    let tags = [];
    try { tags = (item.getTags() || []).map((t) => t.tag); } catch (e) { tags = []; }
    let collections = [];
    try {
      collections = (item.getCollections() || []).map((cid) => {
        try { const c = Zotero.Collections.get(cid); return c ? c.name : String(cid); } catch (e) { return String(cid); }
      });
    } catch (e) { collections = []; }
    let attachments = [];
    try {
      for (const aid of item.getAttachments() || []) {
        const a = Zotero.Items.get(aid);
        if (!a) continue;
        attachments.push({ key: a.key, title: (a.getField && a.getField("title")) || "", contentType: (a.attachmentContentType || "") });
      }
    } catch (e) { attachments = []; }
    let itemType = "";
    try { itemType = item.itemType || ""; } catch (e) { itemType = ""; }
    let typeName = itemType;
    try { typeName = Zotero.ItemTypes.getLocalizedString(itemType) || itemType; } catch (e) { /* ignore */ }
    return {
      key: item.key,
      itemID: item.id,
      itemType: typeName || itemType,
      title: g("title"),
      creators: this.authors(item, 20),
      year: this.year(item),
      date: g("date"),
      publication: g("publicationTitle") || g("proceedingsTitle") || g("bookTitle") || "",
      publisher: g("publisher"),
      volume: g("volume"),
      issue: g("issue"),
      pages: g("pages"),
      DOI: g("DOI"),
      url: g("url"),
      language: g("language"),
      abstract: g("abstractNote").slice(0, 2000),
      tags,
      collections,
      attachments,
      noteCount: (() => { try { return (item.getNotes() || []).length; } catch (e) { return 0; } })(),
    };
  },

  _fmtCandidates(scope, scanned, results) {
    const lines = ["检索范围：" + scope + " ｜ 扫描 " + scanned + " 篇 ｜ 命中 " + results.length + " 篇", ""];
    results.forEach((h, i) => {
      const b = this.brief(h.item);
      lines.push((i + 1) + ". [" + b.key + "] " + (b.title || "(无标题)"));
      lines.push("   作者：" + (b.creators || "-") + " ｜ 年份：" + (b.year || "-") + " ｜ 期刊：" + (b.publication || "-"));
      lines.push("   相关度：" + h.score + (h.hitTokens && h.hitTokens.length ? " ｜ 命中词：" + h.hitTokens.slice(0, 8).join(", ") : ""));
      if (b.tags.length) lines.push("   标签：" + b.tags.slice(0, 10).join(", "));
      if (h.snippet) lines.push("   正文片段：" + h.snippet.slice(0, 240));
      lines.push("");
    });
    lines.push("提示：把中括号里的 key 传给 read_fulltext / list_annotations / get_item 可继续深读。");
    return lines.join("\n");
  },

  async _toolSearch(a) {
    const query = String(a.query || "").trim();
    if (!query) return this._text("参数 query 必填", true);
    const limit = Math.max(1, Math.min(30, Number(a.limit) || 8));
    if (typeof LibSearch === "undefined" || !LibSearch) return this._text("库内检索模块未加载", true);
    const r = await LibSearch.retrieve(query, { deep: a.fulltext !== false, topN: limit });
    if (!r.results.length) return this._text("没有找到相关文献（查询词：" + query + "）。可换用更具体的术语，或减少限定条件。");
    return this._text(this._fmtCandidates(r.scope, r.scanned, r.results.slice(0, limit)));
  },

  async _toolGetItem(a) {
    const item = await this.resolveItem(a.id);
    if (!item) return this._text("未找到条目：" + a.id, true);
    return this._text(JSON.stringify(this.brief(item), null, 2));
  },

  async _toolReadFulltext(a) {
    const item = await this.resolveItem(a.id);
    if (!item) return this._text("未找到条目：" + a.id, true);
    const maxChars = Math.max(1000, Math.min(200000, Number(a.maxChars) || 20000));
    if (typeof AIChat === "undefined" || !AIChat) return this._text("全文读取模块未加载", true);
    const att = await AIChat.getPdfAttachment(item);
    if (!att) return this._text("该条目没有可用的 PDF 附件。", true);
    const text = await AIChat._readIndexedText(att);
    if (!text) return this._text("该 PDF 没有可读取的文本层（可能是扫描件，需要先 OCR）。", true);
    const body = text.length > maxChars ? text.slice(0, maxChars) + "\n\n…（已截断，共 " + text.length + " 字符）" : text;
    return this._text(body);
  },

  async _toolListAnnotations(a) {
    const item = await this.resolveItem(a.id);
    if (!item) return this._text("未找到条目：" + a.id, true);
    if (typeof Annotations === "undefined" || !Annotations) return this._text("批注模块未加载", true);
    const groups = Annotations.collect(item);
    if (!groups) return this._text("该条目没有高亮或批注。");
    let n = 0;
    const lines = [];
    for (const g of groups) {
      for (const x of g.list) {
        n++;
        lines.push(n + ". " + (x.page ? "（第 " + x.page + " 页）" : "") + (x.text || ""));
        if (x.comment) lines.push("   备注：" + x.comment);
      }
    }
    return this._text("共 " + n + " 条批注：\n\n" + lines.join("\n"));
  },

  async _toolCreateNote(a) {
    const title = String(a.title || "").trim();
    const md = String(a.markdown || "");
    if (!title || !md) return this._text("参数 title 与 markdown 必填", true);
    let parent = null;
    if (a.id) parent = await this.resolveItem(a.id);
    const note = new Zotero.Item("note");
    note.libraryID = Zotero.Libraries.userLibraryID;
    if (parent) {
      try {
        if (parent.isRegularItem && parent.isRegularItem()) note.parentID = parent.id;
        else if (parent.parentID) note.parentID = parent.parentID;
      } catch (e) { /* ignore */ }
    }
    try {
      const M = (typeof MdLite !== "undefined") ? MdLite : null;
      note.setNote(M ? M.toNoteHtml(title, md) : "<h2>" + title + "</h2><pre>" + md.replace(/</g, "&lt;") + "</pre>");
    } catch (e) {
      note.setNote("<h2>" + title + "</h2><pre>" + String(md).replace(/</g, "&lt;") + "</pre>");
    }
    await note.saveTx();
    return this._text("已创建笔记。key=" + note.key + (parent ? "（挂在条目 " + parent.key + " 下）" : "（库级笔记）"));
  },

  async _toolListCollections() {
    // ⚠️ 真机验证抓到的 bug：`Zotero.Library` 上**没有** `getCollections()`，
    // 之前调用它抛 TypeError 又被 try/catch 吞掉 → 回落到空数组 →
    // 对外报告「库中还没有任何分类」这个**看起来合理的错答案**。
    // 正确 API = `Zotero.Collections.getByLibrary(libraryID, recursive, includeTrashed)`。
    // 纪律：拿不到就明确报错，绝不把「接口失败」伪装成「没有数据」。
    let cols;
    try {
      cols = Zotero.Collections.getByLibrary(Zotero.Libraries.userLibraryID, true, false) || [];
    } catch (e) {
      return this._text("读取分类失败（Zotero API 不可用）：" + String((e && e.message) || e), true);
    }
    if (!cols.length) return this._text("库中确实还没有任何分类（已成功查询，返回 0 条）。");
    const byID = new Map(cols.map((c) => [c.id, c]));
    const lines = ["共 " + cols.length + " 个分类：", ""];
    for (const c of cols) {
      let parent = "";
      try { parent = c.parentID && byID.get(c.parentID) ? byID.get(c.parentID).name + " / " : ""; } catch (e) { /* ignore */ }
      let n = 0;
      try { n = (c.getChildItems(true) || []).length; } catch (e) { n = -1; }
      lines.push("- [" + c.id + "] " + parent + c.name + "（" + (n < 0 ? "条数未知" : n + " 条") + "）");
    }
    return this._text(lines.join("\n"));
  },

  async _toolLibraryStats() {
    const s = new Zotero.Search();
    s.libraryID = Zotero.Libraries.userLibraryID;
    s.addCondition("itemType", "isNot", "attachment");
    s.addCondition("itemType", "isNot", "note");
    const ids = await s.search();
    const cap = 5000;
    const types = new Map(), tags = new Map(), years = new Map();
    let withPdf = 0, scanned = 0;
    for (const id of ids.slice(0, cap)) {
      const it = await Zotero.Items.getAsync(id);
      if (!it) continue;
      scanned++;
      let t = ""; try { t = it.itemType || ""; } catch (e) { t = ""; }
      types.set(t, (types.get(t) || 0) + 1);
      try { for (const tg of it.getTags() || []) tags.set(tg.tag, (tags.get(tg.tag) || 0) + 1); } catch (e) { /* ignore */ }
      const y = this.year(it);
      if (y) years.set(y, (years.get(y) || 0) + 1);
      try { if (it.getAttachments().some((aid) => { const a = Zotero.Items.get(aid); return a && a.isPDFAttachment && a.isPDFAttachment(); })) withPdf++; } catch (e) { /* ignore */ }
    }
    const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
    const lines = [
      "条目总数：" + ids.length + (ids.length > cap ? "（统计前 " + cap + " 条）" : ""),
      "有 PDF 的条目：" + withPdf + " / " + scanned,
      "",
      "按类型：" + top(types, 12).map(([k, v]) => k + " " + v).join("、"),
      "",
      "Top 标签：" + top(tags, 20).map(([k, v]) => k + "(" + v + ")").join("、"),
      "",
      "按年份：" + top(years, 24).sort((a, b) => String(a[0]).localeCompare(String(b[0]))).map(([k, v]) => k + ":" + v).join(" "),
    ];
    return this._text(lines.join("\n"));
  },

  async _toolListRecent(a) {
    const limit = Math.max(1, Math.min(100, Number(a.limit) || 20));
    const s = new Zotero.Search();
    s.libraryID = Zotero.Libraries.userLibraryID;
    s.addCondition("itemType", "isNot", "attachment");
    s.addCondition("itemType", "isNot", "note");
    s.addCondition("dateAdded", "isAfter", "1970-01-01");
    let ids = [];
    try { ids = await s.search(); } catch (e) { ids = []; }
    const items = [];
    for (const id of ids.slice(0, 400)) {
      const it = await Zotero.Items.getAsync(id);
      if (it) items.push(it);
    }
    items.sort((x, y) => String(y.dateAdded || "").localeCompare(String(x.dateAdded || "")));
    const lines = ["最近加入（显示 " + Math.min(limit, items.length) + " 条，共检索到 " + ids.length + " 条常规条目）：", ""];
    items.slice(0, limit).forEach((it, i) => {
      const b = this.brief(it);
      lines.push((i + 1) + ". [" + b.key + "] " + (b.title || "(无标题)") + " — " + (b.creators || "-") + " (" + (b.year || "-") + ") ｜ 加入：" + String(it.dateAdded || "").slice(0, 10));
    });
    return this._text(lines.join("\n"));
  },

  /* ---------------- Agent 工具桥接（0.50.0） ----------------
   * 设计约束：
   *   · 只暴露 AgentTools.enabledIds() 内的工具（用户在设置里开关说了算）；
   *   · 写工具（readOnly === false）必须 allowWrite === true，绝不弹
   *     Services.prompt.confirm —— MCP 请求来自外部 AI，没有窗口给人点确认，
   *     弹窗只会把手无寸铁的客户端请求挂死；
   *   · 所有失败降级成 isError 文本（JSON-RPC 层仍是成功响应），
   *     让外部模型读到原因自行纠正，而不是收到 -32603 后无从下手。
   */

  // AgentTools 只有 desc、没有结构化参数 schema，这里补一份参数说明；
  // 未收录的（用户自定义扩展）回退空对象，不影响调用。
  AGENT_ARG_HINTS: {
    search_library: { query: "检索关键词（必填）" },
    get_item_details: { item_id: "条目编号（必填，取自 search_library 结果）" },
    read_item_fulltext: { item_id: "条目编号（缺省 = 当前会话锁定的文献）" },
    list_collections: {},
    add_note: { item_id: "条目编号", text: "笔记正文（Markdown；写操作）" },
    add_tags: { item_id: "条目编号", tags: "标签数组或逗号分隔字符串（写操作）" },
  },

  _agentTools() {
    try {
      return (typeof AgentTools !== "undefined" && AgentTools && Array.isArray(AgentTools.TOOLS)) ? AgentTools : null;
    } catch (e) { return null; }
  },

  _toolListAgentTools() {
    const AT = this._agentTools();
    if (!AT) return this._text("Agent 工具模块未加载", true);
    let on;
    try { on = AT.enabledIds(); }
    catch (e) { return this._text("读取工具启用状态失败：" + String((e && e.message) || e), true); }
    const tools = AT.TOOLS.filter((t) => on.has(t.id)).map((t) => ({
      id: t.id,
      label: t.label || "",
      desc: t.desc || "",
      readOnly: t.readOnly !== false,
      args: this.AGENT_ARG_HINTS[t.id] ? JSON.parse(JSON.stringify(this.AGENT_ARG_HINTS[t.id])) : {},
    }));
    return this._text(JSON.stringify({ tools }, null, 2));
  },

  async _toolRunAgentTool(a) {
    const p = a || {};
    const name = String(p.tool || "").trim();
    if (!name) return this._text("参数 tool 必填", true);
    const AT = this._agentTools();
    if (!AT) return this._text("Agent 工具模块未加载", true);
    let on;
    try { on = AT.enabledIds(); }
    catch (e) { return this._text("读取工具启用状态失败：" + String((e && e.message) || e), true); }
    const tool = AT.TOOLS.find((t) => t.id === name);
    if (!tool || !on.has(name)) return this._text("未知或未启用的工具：" + name, true);
    if (tool.readOnly === false && p.allowWrite !== true) {
      return this._text("该工具会修改文献库（写操作）。请在参数中传 allowWrite: true 明确授权后重试", true);
    }
    const args = (p.args && typeof p.args === "object" && !Array.isArray(p.args)) ? p.args : {};
    let out;
    try {
      // ctx.skipConfirm 是写给「写工具」的无人值守旁路（与 A 模块约定的契约）。
      // AgentTools 尚未消费它时只当作多余字段忽略，不会报错。
      out = String(await AT.execTool(name, args, { mcp: true, skipConfirm: true }));
    } catch (e) {
      return this._text("工具执行失败：" + String((e && e.message) || e), true);
    }
    const max = this.AGENT_RESULT_MAX;
    if (out.length > max) out = out.slice(0, max) + "…（已截断）";
    return this._text(out);
  },

  /* ---------------- 窗口 ---------------- */

  openDialog() {
    const win = Zotero.getMainWindow();
    if (!win) return null;
    try {
      const en = Services.wm.getEnumerator("paperpilot:mcp");
      if (en.hasMoreElements()) { const w = en.getNext(); w.focus(); return w; }
    } catch (e) { /* ignore */ }
    return win.openDialog(
      "chrome://paperpilot/content/mcp.xhtml",
      "paperpilot-mcp",
      "chrome,centerscreen,resizable,dialog=no",
      { Zotero, Services }
    );
  },
};
