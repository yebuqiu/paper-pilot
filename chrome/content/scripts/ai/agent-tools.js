/* PaperPilot Agent 工具层（0.48.0，交互设计参考开源项目 Hermes Agent）
 *
 * 三大能力（对齐 Hermes Agent 的核心循环）：
 *   ① 任务规划：协议提示词要求模型对复杂任务先输出 1-3 步计划再执行；
 *   ② 工具调用：提示词约定的标准化 JSON 调用协议（与 Hermes 同思路——不依赖
 *      原生 function calling，任意 OpenAI 兼容网关 / 官方通道 auto 模型都能用）；
 *   ③ 上下文管理：agent 循环内完整携带工具结果，历史轮数由 AIChat.windowHistory
 *      统一滑窗（pref aiHistoryRounds 可配，见 chat.js）。
 *
 * 安全模型（读写分离，对齐 Hermes 的 Auto / Interactive 双模式）：
 *   · 读工具（search_library / get_item_details / read_item_fulltext / list_collections）
 *     无副作用，直接执行；
 *   · 写工具（add_note / add_tags）默认逐次弹确认（协作模式，pref
 *     aiAgentConfirmWrite，默认开）；关掉即「自主模式」。
 *   · 工具白名单 pref aiAgentTools（CSV），设置面板可逐个开关。
 *
 * 可测性：runAgentLoop 的 callLLM / runTool 全部依赖注入（test/agent-tools.test.js
 * 不碰网络与 Zotero）；工具执行 execTool 独立于循环。
 *
 * 消费方：chat-float.js runSend（chatAgentMode 开启时走 agent 循环）。
 * 生命周期：无 register——纯函数 + 惰性缓存；加载顺序须在 ai/chat.js 之后
 * （工具消费 AIChat.getFullText / AIChat.paperMeta）。
 */
/* global Zotero, Services, Prefs, AIChat, Notes */

var AgentTools = {
  PREF_TOOLS: "aiAgentTools",
  PREF_CONFIRM: "aiAgentConfirmWrite",
  DEFAULT_TOOLS: "search_library,get_item_details,read_item_fulltext,list_collections,add_note,add_tags",

  // 单个工具喂给模型的全文上限（与 chat-float CHIP_TEXT_MAX 同量级，防撑爆上下文）
  FULLTEXT_MAX: 6000,
  // 工具结果回填给模型的上限
  RESULT_MAX: 8000,

  _allItemsCache: null,
  _allItemsAt: 0,

  /* ==================== 工具注册表（读写分离） ==================== */

  TOOLS: [
    {
      id: "search_library", label: "检索文献库", readOnly: true,
      desc: "按关键词检索用户文献库（匹配标题/作者/年份），返回条目编号与题录",
      async run(args) {
        const hits = await AgentTools._searchItems(args && args.query, 8);
        if (!hits.length) {
          return "没有找到匹配的文献。请更换关键词（支持标题、作者、年份的子串匹配）。";
        }
        return "检索结果（[编号] 可用于后续工具调用）：\n" +
          hits.map((it) => AgentTools._itemLine(it)).join("\n");
      },
    },
    {
      id: "get_item_details", label: "读取条目详情", readOnly: true,
      desc: "读取条目的题录、摘要与标签（item_id 为条目编号）",
      async run(args) {
        const it = await AgentTools._getItem(args && args.item_id);
        if (!it) return "找不到该条目（item_id 无效）。请先用 search_library 检索拿编号。";
        const meta = AIChat.paperMeta(it);
        let abstract = "";
        try { abstract = it.getField("abstractNote") || ""; } catch (e) { /* ignore */ }
        let tags = [];
        try { tags = (it.getTags() || []).map((t) => t.tag); } catch (e) { /* ignore */ }
        return "编号：" + it.id +
          "\n标题：" + meta.title +
          "\n作者：" + (meta.creators || "（无）") +
          "\n年份：" + (meta.year || "（无）") +
          "\n期刊：" + (meta.pub || "（无）") +
          "\n标签：" + (tags.length ? tags.join("、") : "无") +
          "\n摘要：" + (abstract ? abstract.slice(0, 1500) : "（无摘要，可用 read_item_fulltext 读全文）");
      },
    },
    {
      id: "read_item_fulltext", label: "读取条目全文", readOnly: true,
      desc: "读取条目 PDF 全文（超长自动截断；item_id 缺省 = 当前会话锁定的文献）",
      async run(args, ctx) {
        const it = (await AgentTools._getItem(args && args.item_id)) ||
          (ctx && ctx.item) || null;
        if (!it) return "没有可读的条目（item_id 无效且当前无锁定文献）。";
        let full = "";
        try { full = (await AIChat.getFullText(it)) || ""; } catch (e) { full = ""; }
        if (!full) return "该条目没有可读的 PDF 全文（扫描件需先 OCR）。";
        return full.length > AgentTools.FULLTEXT_MAX
          ? full.slice(0, AgentTools.FULLTEXT_MAX) +
              "\n[……后文已截断；需要特定章节请说明关键词……]"
          : full;
      },
    },
    {
      id: "list_collections", label: "列出分类", readOnly: true,
      desc: "列出文献库的分类树（缩进表示层级）",
      async run() {
        let cols = [];
        try {
          cols = await Zotero.Collections.getAll(Zotero.Libraries.userLibraryID);
        } catch (e) {
          return "分类读取失败：" + ((e && e.message) || e);
        }
        if (!cols || !cols.length) return "（文献库还没有任何分类）";
        const lines = [];
        const walk = (parent, depth) => {
          for (const c of cols) {
            let pid = 0;
            try { pid = c.parentID || 0; } catch (e) { pid = 0; }
            if (pid !== parent) continue;
            let name = "";
            try { name = String(c.name || "").trim(); } catch (e) { name = ""; }
            lines.push("  ".repeat(depth) + "- " + name);
            if (lines.length >= 60) return true;
            if (walk(c.id, depth + 1)) return true;
          }
          return false;
        };
        walk(0, 0);
        return "文献库分类树：\n" + lines.join("\n");
      },
    },
    {
      id: "add_note", label: "添加笔记", readOnly: false,
      desc: "把 Markdown 文本作为笔记添加到条目（写操作，执行前会请求用户确认）",
      async run(args, ctx) {
        const it = (await AgentTools._getItem(args && args.item_id)) ||
          (ctx && ctx.item) || null;
        if (!it) return "没有目标条目（item_id 无效且当前无锁定文献）。";
        const text = String((args && args.text) || "").trim();
        if (!text) return "笔记内容为空。";
        let title = "";
        try { title = it.getDisplayTitle() || ""; } catch (e) { /* ignore */ }
        if (!AgentTools._confirmWrite("添加笔记 →《" + title + "》", text)) {
          return "用户拒绝了本次写操作（add_note）。请基于对话继续，不要重试写入。";
        }
        await Notes.createFromMarkdown(it, "AI 助手笔记", text);
        return "✓ 笔记已添加到条目 " + it.id + "（可在 Zotero 笔记列表查看）";
      },
    },
    {
      id: "add_tags", label: "添加标签", readOnly: false,
      desc: "给条目添加标签（tags 为数组或逗号分隔字符串；写操作，执行前会请求用户确认）",
      async run(args, ctx) {
        const it = (await AgentTools._getItem(args && args.item_id)) ||
          (ctx && ctx.item) || null;
        if (!it) return "没有目标条目（item_id 无效且当前无锁定文献）。";
        let tags = args && args.tags;
        if (Array.isArray(tags)) tags = tags.map(String);
        else tags = String(tags || "").split(/[,，、]/);
        tags = tags.map((t) => t.trim()).filter(Boolean).slice(0, 12);
        if (!tags.length) return "没有可添加的标签。";
        let title = "";
        try { title = it.getDisplayTitle() || ""; } catch (e) { /* ignore */ }
        if (!AgentTools._confirmWrite("添加标签 →《" + title + "》", tags.join("、"))) {
          return "用户拒绝了本次写操作（add_tags）。请基于对话继续，不要重试写入。";
        }
        for (const t of tags) {
          try { it.addTag(t); } catch (e) { /* 单个失败不拖垮整批 */ }
        }
        await it.saveTx();
        return "✓ 已给条目 " + it.id + " 添加标签：" + tags.join("、");
      },
    },
  ],

  /* ==================== 白名单 ==================== */

  /** 启用的工具 id 集合（pref CSV；坏值回退全量默认） */
  enabledIds() {
    let raw = "";
    try { raw = String(Prefs.get(this.PREF_TOOLS, this.DEFAULT_TOOLS) || ""); }
    catch (e) { raw = this.DEFAULT_TOOLS; }
    const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (!ids.length) return new Set(this.DEFAULT_TOOLS.split(","));
    // 只保留注册表里真实存在的 id（防手改 pref 出幽灵工具）
    const known = new Set(this.TOOLS.map((t) => t.id));
    const set = new Set(ids.filter((id) => known.has(id)));
    return set.size ? set : new Set(this.DEFAULT_TOOLS.split(","));
  },

  enabledTools() {
    const on = this.enabledIds();
    return this.TOOLS.filter((t) => on.has(t.id));
  },

  /** 写确认是否开启（协作模式） */
  confirmWrite() {
    try { return Prefs.get(this.PREF_CONFIRM, true) !== false; }
    catch (e) { return true; }
  },

  /** 写操作确认（Zotero 原生 confirm；异常时保守拒绝） */
  _confirmWrite(head, detail) {
    if (!this.confirmWrite()) return true; // 自主模式
    try {
      const win = Zotero.getMainWindow();
      if (win && typeof Services !== "undefined" && Services.prompt) {
        return Services.prompt.confirm(win,
          "PaperPilot · AI 工具写操作确认",
          "AI 请求执行写操作：\n\n" + head + "\n\n" +
          String(detail || "").slice(0, 300) + "\n\n允许执行？");
      }
    } catch (e) { /* ignore */ }
    return false; // 拿不到对话框能力 → 拒绝写（宁可不写也不错写）
  },

  /* ==================== 条目检索（读侧） ==================== */

  /** 全库条目（60s 缓存；Zotero 10 的 Items.getAll 是 async） */
  async _allItems() {
    const now = Date.now();
    if (this._allItemsCache && now - this._allItemsAt < 60000) return this._allItemsCache;
    let items = [];
    try {
      items = await Zotero.Items.getAll(Zotero.Libraries.userLibraryID);
    } catch (e) {
      try { items = await Zotero.Items.getAll(); } catch (e2) { items = []; }
    }
    this._allItemsCache = items || [];
    this._allItemsAt = now;
    return this._allItemsCache;
  },

  /** item_id → 条目（附件上溯父条目；无效返回 null） */
  async _getItem(id) {
    const n = parseInt(id, 10);
    if (!isFinite(n) || n <= 0) return null;
    let it = null;
    try { it = Zotero.Items.get(n); } catch (e) { return null; }
    if (!it) return null;
    try {
      if (it.isRegularItem && it.isRegularItem()) return it;
      if (it.parentItemID) {
        const p = Zotero.Items.get(it.parentItemID);
        if (p) return p;
      }
    } catch (e) { /* ignore */ }
    return null;
  },

  /** 关键词过滤（标题/作者/年份 子串，大小写不敏感），返回前 limit 条常规条目 */
  async _searchItems(query, limit) {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return [];
    const all = await this._allItems();
    const hits = [];
    for (const it of all) {
      if (!it || !it.isRegularItem || !it.isRegularItem()) continue;
      let hay = "";
      try {
        const meta = AIChat.paperMeta(it);
        hay = (meta.title + " " + meta.creators + " " + meta.year).toLowerCase();
      } catch (e) { continue; }
      if (hay.indexOf(q) >= 0) {
        hits.push(it);
        if (hits.length >= (limit || 8)) break;
      }
    }
    return hits;
  },

  /** 条目单行题录（喂给模型的紧凑格式，含编号供后续工具引用） */
  _itemLine(it) {
    const meta = AIChat.paperMeta(it);
    const first = (meta.creators || "").split(",")[0].trim();
    return "[" + it.id + "] " + meta.title +
      (first ? "（" + first + " 等）" : "") +
      (meta.year ? " " + meta.year : "");
  },

  /* ==================== 调用协议（提示词约定，兼容任意网关） ==================== */

  /** 工具协议 system 提示块（含任务规划指令——Hermes 式「先规划后执行」） */
  protocolPrompt() {
    const tools = this.enabledTools();
    if (!tools.length) return "";
    const zh = (typeof I18n !== "undefined" && I18n && I18n.isZh) !== false;
    const lines = tools.map((t) => {
      const args = t.id === "search_library" ? "(query)"
        : t.id === "get_item_details" || t.id === "read_item_fulltext" ||
          t.id === "add_note" || t.id === "add_tags" ? "(item_id, …)"
        : "()";
      return "- " + t.id + args + "：" + t.label + "——" + t.desc;
    });
    if (zh) {
      return "\n\n【可用工具】需要更多信息或执行操作时，输出**单独一行 JSON** 调用工具（不要放在代码块里）：\n" +
        '{"tool": "工具id", "args": {"参数": "值"}}\n' +
        lines.join("\n") + "\n" +
        "【工具使用规则】\n" +
        "1. 一次只调用一个工具；收到【工具结果】后基于结果继续（可再次调用，也可直接回答）；\n" +
        "2. 工具结果里没有的信息不要编造；条目引用请用工具返回的编号；\n" +
        "3. 复杂任务先简述计划（1-3 步，一行一条），再逐步执行；简单问题直接回答；\n" +
        "4. 无需工具或任务完成时，直接给最终回答（不要再输出工具 JSON）。\n";
    }
    return "\n\n[Tools] When you need more information or actions, output a single-line JSON to call a tool (not in a code block):\n" +
      '{"tool": "tool_id", "args": {...}}\n' +
      lines.join("\n") + "\n" +
      "Rules: one tool per turn; continue from [tool results]; never invent facts absent from tool results; " +
      "for complex tasks outline a 1-3 step plan first; give the final answer directly when tools are not needed.\n";
  },

  /** 把工具协议并入消息（附加到首条 system；没有 system 则插到最前） */
  augmentMessages(messages) {
    const out = (messages || []).slice();
    const proto = this.protocolPrompt();
    if (!proto) return out;
    const idx = out.findIndex((m) => m && m.role === "system");
    if (idx >= 0) {
      out.splice(idx, 1, { role: "system", content: out[idx].content + proto });
    } else {
      out.unshift({ role: "system", content: proto });
    }
    return out;
  },

  /**
   * 从模型回复中提取工具调用 JSON。
   * 按括号配平提取（支持单行 / 多行 pretty-print / 代码围栏内嵌）；
   * 只认含 "tool" 字段的对象；坏 JSON 静默跳过。
   */
  extractCall(text) {
    const s = String(text || "");
    let idx = 0;
    while ((idx = s.indexOf('"tool"', idx)) >= 0) {
      const start = s.lastIndexOf("{", idx);
      if (start >= 0) {
        const cand = this._balancedJson(s, start);
        if (cand) {
          try {
            const j = JSON.parse(cand);
            if (j && typeof j.tool === "string") {
              return {
                tool: j.tool,
                args: (j.args && typeof j.args === "object" && !Array.isArray(j.args)) ? j.args : {},
              };
            }
          } catch (e) { /* 半截 JSON 继续找下一个 */ }
        }
      }
      idx += 6;
    }
    return null;
  },

  /** 从 start（必须指向 '{'）做字符串感知的括号配平；不闭合返回 null */
  _balancedJson(s, start) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return s.slice(start, i + 1);
      }
    }
    return null;
  },

  /* ==================== Agent 循环（依赖注入，可测） ====================
   * Hermes 式推理循环：LLM → 工具 → 结果回填 → LLM …… 直到给出最终回答
   * 或用满 maxSteps 工具轮（最后一轮强制收敛，防失控）。
   *
   * @param opts.messages 初始消息（通常已经 augmentMessages 注入协议）
   * @param opts.callLLM  async (messages) => string
   * @param opts.runTool  async (toolId, args) => string（ChatFloat 传 execTool，
   *                      顺带 onStep 上报；测试传 mock）
   * @param opts.maxSteps 工具调用次数上限（默认 5，pref aiAgentMaxSteps）
   * @param opts.onStep   (step) => void 每完成一次工具调用的回调（UI 围观过程）
   * @returns {answer, steps, done, limited}
   *   done=true 正常收敛；limited=true 用满轮数仍想调工具（answer 为原始输出）
   */
  async runAgentLoop(opts) {
    const messages = (opts && opts.messages || []).slice();
    const maxSteps = Math.max(1, Math.min(12, Number(opts && opts.maxSteps) || 5));
    const steps = [];
    const LIMIT_NOTE = "（已达到本轮工具调用次数上限：请立即基于已获取的信息给出最终回答，不要再输出工具调用 JSON）";
    for (let step = 0; ; step++) {
      const isFinalCall = step >= maxSteps; // 工具轮已用满 → 本次为收敛轮
      if (isFinalCall) messages.push({ role: "user", content: LIMIT_NOTE });
      const text = await opts.callLLM(messages);
      const call = this.extractCall(text);
      if (!call || isFinalCall) {
        return { answer: text, steps, done: !call, limited: !!call };
      }
      let result = "";
      try { result = String(await opts.runTool(call.tool, call.args)); }
      catch (e) { result = "工具执行失败：" + ((e && e.message) || e); }
      const rec = { tool: call.tool, args: call.args, result };
      steps.push(rec);
      if (opts.onStep) { try { opts.onStep(rec); } catch (e) { /* UI 回调不得拖死循环 */ } }
      messages.push({ role: "assistant", content: text });
      messages.push({
        role: "user",
        content: "【工具结果】" + call.tool + " →\n" +
          (result.length > this.RESULT_MAX
            ? result.slice(0, this.RESULT_MAX) + "\n[……结果过长已截断……]" : result),
      });
    }
  },

  /* ==================== 工具执行（白名单 + 读写分级） ==================== */

  /** 执行一次工具调用；未注册 / 被禁用返回说明文本（不抛错，喂回模型自纠） */
  async execTool(id, args, ctx) {
    const tool = this.TOOLS.find((t) => t.id === id);
    if (!tool) return "未知工具：" + id + "（请检查工具名拼写）";
    if (!this.enabledIds().has(id)) return "工具 " + id + " 已被用户禁用。请基于对话继续。";
    return String(await tool.run(args || {}, ctx || {}));
  },
};
