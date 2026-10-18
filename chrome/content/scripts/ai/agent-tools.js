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
 *   · 读工具（search_library / get_item_details / read_item_fulltext / list_collections
 *     / search_arxiv / get_citation_count / search_notes / export_bibliography / memory_read）
 *     无副作用，直接执行；
 *   · 写工具（add_note / add_tags / move_to_collection / memory_write）默认逐次弹确认（协作模式，
 *     pref aiAgentConfirmWrite，默认开）；关掉即「自主模式」。MCP 等无 UI 入口可传
 *     ctx.skipConfirm === true 绕过弹框（由调用方先做 allowWrite 校验）。
 *   · 工具白名单 pref aiAgentTools（CSV），设置面板可逐个开关。
 *
 * 写操作审计（pref agentAuditLog，JSON 数组，LRU 100 条，最新在前）：
 *   每次写操作成功后记 `{id, ts, tool, summary, undo}`；undoLast / undoEntry 按
 *   undo 描述执行撤销（removeTags / eraseNote / removeFromCollection /
 *   removeMemory / restoreFields），成功才删记录。
 *   restoreFields（0.52.0，元数据医生）：`{kind:"restoreFields", itemID, fields:{字段:旧值}}`
 *   —— 字段值写回旧值（空串 = 清空），`creators` 键按作者数组还原（[] = 清空作者）。
 *
 * 可测性：runAgentLoop 的 callLLM / runTool 全部依赖注入（test/agent-tools.test.js
 * 不碰网络与 Zotero）；工具执行 execTool 独立于循环。
 *
 * 消费方：chat-float.js runSend（chatAgentMode 开启时走 agent 循环）。
 * 生命周期：无 register——纯函数 + 惰性缓存；加载顺序须在 ai/chat.js 之后
 * （工具消费 AIChat.getFullText / AIChat.paperMeta）。外部能力（ArxivFetch /
 * S2Client / RefFormat / AgentMemory）一律**运行时探测**，缺位降级为可读文案，
 * 不做加载期依赖。
 */
/* global Zotero, Services, Prefs, AIChat, Notes, ArxivFetch, S2Client, RefFormat, AgentMemory */

var AgentTools = {
  PREF_TOOLS: "aiAgentTools",
  PREF_CONFIRM: "aiAgentConfirmWrite",
  PREF_AUDIT: "agentAuditLog",
  DEFAULT_TOOLS: "search_library,get_item_details,read_item_fulltext,list_collections,add_note,add_tags",

  // 单个工具喂给模型的全文上限（与 chat-float CHIP_TEXT_MAX 同量级，防撑爆上下文）
  FULLTEXT_MAX: 6000,
  // 工具结果回填给模型的上限
  RESULT_MAX: 8000,
  // 审计环形缓冲上限（最新在前）
  AUDIT_MAX: 100,
  // search_notes 单次最多扫描的条目数（防超大库卡死 UI）
  NOTE_SCAN_MAX: 800,
  // memory_read 单次最多回填的记忆条数（防 200 条记忆撑爆上下文）
  MEMORY_READ_MAX: 50,

  _allItemsCache: null,
  _allItemsAt: 0,
  _auditSeq: 0,

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
            // 编号追加在行尾：move_to_collection 需要 collection_id，且不破坏既有缩进格式
            lines.push("  ".repeat(depth) + "- " + name + "（编号 " + c.id + "）");
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
      id: "search_arxiv", label: "检索 arXiv", readOnly: true,
      desc: "按关键词检索 arXiv 预印本（category 可选，如 cs.CL；max 最多 10 条）",
      async run(args) {
        const AF = AgentTools._arxiv();
        if (!AF) return "arXiv 工具包不可用";
        const query = String((args && args.query) || "").trim();
        if (!query) return "请提供检索关键词（query），可加 category（如 cs.CL）限定分类。";
        const max = AgentTools._clampInt(args && args.max, 5, 1, 10);
        const spec = { keywords: [query] };
        const cat = String((args && args.category) || "").trim();
        if (cat) spec.categories = [cat];
        let res = null;
        try {
          res = await AF.search(spec, { limit: max, sortBy: "relevance" });
        } catch (e) {
          return "arXiv 检索失败：" + ((e && e.message) || e) +
            "（网络不可用时请告知用户稍后再试）";
        }
        const entries = Array.isArray(res) ? res : ((res && res.entries) || []);
        if (!entries.length) return "arXiv 没有找到匹配的论文。请更换关键词或去掉分类限定。";
        return "arXiv 检索结果：\n" + entries.slice(0, max).map((en, i) => {
          const title = String(en.title || "（无标题）").replace(/\s+/g, " ").trim();
          const year = String(en.published || "").slice(0, 4);
          const id = en.arxivId || en.baseId || "";
          const sum = String(en.summary || "").replace(/\s+/g, " ").trim();
          return "[" + (i + 1) + "] " + title + (year ? "（" + year + "）" : "") +
            "\n  arXiv:" + (id || "—") + " · " + (sum ? sum.slice(0, 200) : "（无摘要）");
        }).join("\n");
      },
    },
    {
      id: "get_citation_count", label: "查询被引量", readOnly: true,
      desc: "查文献被引次数（Semantic Scholar；给 item_id 或 doi，item_id 会自动取条目 DOI）",
      async run(args) {
        const S2 = AgentTools._s2();
        if (!S2) return "Semantic Scholar 客户端不可用（S2Client 未加载）";
        const a = args || {};
        let doi = String(a.doi || "").trim();
        let title = "";
        if (!doi && a.item_id !== undefined && a.item_id !== null && a.item_id !== "") {
          const it = await AgentTools._getItem(a.item_id);
          if (!it) return "找不到该条目（item_id 无效）。请先用 search_library 检索拿编号。";
          doi = AgentTools._itemDoi(it);
          try { title = it.getDisplayTitle() || ""; } catch (e) { title = ""; }
          if (!doi) {
            return "该条目没有 DOI，无法查询被引量。可在条目「其他」字段补一行 DOI: 10.xxxx/xxxx，" +
              "或直接给 doi 参数。";
          }
        }
        if (!doi) return "请提供 item_id 或 doi（例如 10.1038/nature12373）。";
        doi = AgentTools._normDoi(doi);
        let paper = null;
        try {
          paper = await S2.paperById("DOI:" + doi);
        } catch (e) {
          return "被引量查询失败：" + ((e && e.message) || e) +
            "（网络不可用或限流时请告知用户稍后再试）";
        }
        if (!paper) return "Semantic Scholar 未收录该文献（DOI: " + doi + "），暂无被引数据。";
        const n = Number(paper.citationCount);
        const paperTitle = String(paper.title || title || "").replace(/\s+/g, " ").trim();
        return "被引：" + (isFinite(n) ? n : "未知") + " 次（Semantic Scholar）· " +
          (paperTitle || "（无标题）");
      },
    },
    {
      id: "search_notes", label: "检索笔记", readOnly: true,
      desc: "在文献库的笔记正文里按关键词检索（大小写不敏感，max 最多 10 条）",
      async run(args) {
        const query = String((args && args.query) || "").trim();
        if (!query) return "请提供检索关键词（query），例如笔记里出现过的概念或作者名。";
        const max = AgentTools._clampInt(args && args.max, 10, 1, 10);
        let ids = [];
        try {
          ids = await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, false, false, true);
        } catch (e) { ids = []; }
        if (!Array.isArray(ids) || !ids.length) {
          // 退路：拿不到 id 列表时退回全量条目对象（再按 note 过滤）
          const all = await AgentTools._allItems();
          ids = (all || []).map((it) => (it && it.id) || 0).filter(Boolean);
        }
        const needle = query.toLowerCase();
        const hits = [];
        let scanned = 0;
        for (const raw of ids) {
          if (hits.length >= max) break;
          if (++scanned > AgentTools.NOTE_SCAN_MAX) break;
          // 兼容两种 getAll：id 列表（idOnly）或条目对象数组
          const asObj = (raw && typeof raw === "object") ? raw : null;
          const id = asObj ? asObj.id : raw;
          let note = asObj;
          if (!note) {
            try {
              note = (typeof Zotero.Items.getAsync === "function")
                ? await Zotero.Items.getAsync(id)
                : Zotero.Items.get(id);
            } catch (e) { continue; }
          }
          if (!note) continue;
          let isNote = false;
          try {
            isNote = (typeof note.isNote === "function") ? !!note.isNote() : note.itemType === "note";
          } catch (e) { isNote = false; }
          if (!isNote) continue;
          let text = "";
          try { text = AgentTools._stripHtml(note.getNote ? note.getNote() : ""); } catch (e) { continue; }
          const at = text.toLowerCase().indexOf(needle);
          if (at < 0) continue;
          let parent = "";
          try {
            const pid = note.parentItemID;
            if (pid) {
              const p = Zotero.Items.get(pid);
              parent = (p && p.getDisplayTitle && p.getDisplayTitle()) || "";
            }
          } catch (e) { parent = ""; }
          const start = Math.max(0, at - 20);
          const end = Math.min(text.length, start + 80);
          const snippet = (start > 0 ? "…" : "") + text.slice(start, end) +
            (end < text.length ? "…" : "");
          hits.push("[" + (hits.length + 1) + "] " + (parent || "（独立笔记）") +
            " · " + snippet);
        }
        if (!hits.length) {
          return "没有在笔记正文中找到「" + query + "」。可换更短的关键词，" +
            "或先用 search_library 定位条目再 get_item_details。";
        }
        return "笔记检索结果：\n" + hits.join("\n");
      },
    },
    {
      id: "export_bibliography", label: "导出参考文献", readOnly: true,
      desc: "把条目导出为参考文献文本（item_ids 缺省 = 当前文献；style 支持 bibtex/ris/csl）",
      async run(args, ctx) {
        const RF = AgentTools._refFormat();
        if (!RF) return "参考文献格式器不可用（RefFormat 未加载）";
        const a = args || {};
        const limit = AgentTools._clampInt(a.limit, 5, 1, 20);
        const items = [];
        const ids = Array.isArray(a.item_ids) ? a.item_ids : [];
        const byIds = ids.length > 0;
        if (byIds) {
          for (const id of ids.slice(0, limit)) {
            const it = await AgentTools._getItem(id);
            if (it) items.push(it);
          }
          if (!items.length) {
            return "item_ids 里没有有效条目（编号可先用 search_library 查）。";
          }
        } else if (ctx && ctx.item) {
          items.push(ctx.item);
        } else {
          items.push(...(await AgentTools._recentItems(limit)));
        }
        if (!items.length) {
          return "没有可导出的条目。请先给 item_ids，或在对话中锁定一篇文献。";
        }
        const style = String(a.style || "").trim();
        const FORMATS = {
          bibtex: "bibtex", bib: "bibtex", ris: "ris", endnote: "ris", enw: "ris",
          csl: "csl", json: "csl",
        };
        const key = style.toLowerCase();
        const format = FORMATS[key] || "bibtex";
        const note = (style && !FORMATS[key])
          ? "（RefFormat 不支持 " + style + " 样式，已按默认 BibTeX 输出）"
          : "";
        const lines = [];
        for (const it of items) {
          let text = "";
          try { text = String(RF.exportAs([AgentTools._itemRec(it)], format) || ""); }
          catch (e) { text = ""; }
          if (!text.trim()) continue;
          // 一条文献一行：压掉序列化器里的换行与缩进，便于模型/用户直接引用
          lines.push(text.replace(/\s*\n\s*/g, " ").trim());
        }
        if (!lines.length) return "这些条目缺少题录信息，无法生成参考文献。";
        return "参考文献（" + (format === "bibtex" ? "BibTeX" : format.toUpperCase()) + "）" +
          note + "：\n" + lines.map((l, i) => (i + 1) + ". " + l).join("\n");
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
        if (!AgentTools._confirmWrite("添加笔记 →《" + title + "》", text, ctx)) {
          return "用户拒绝了本次写操作（add_note）。请基于对话继续，不要重试写入。";
        }
        let note = null;
        try {
          note = await Notes.createFromMarkdown(it, "AI 助手笔记", text);
        } catch (e) {
          return "笔记创建失败：" + ((e && e.message) || e);
        }
        const noteID = AgentTools._noteId(note);
        AgentTools._recordAudit("add_note",
          "添加笔记 →《" + title + "》（来源：" + AgentTools._ctxSource(ctx) + "）",
          noteID ? { kind: "eraseNote", noteID: noteID }
            : { kind: "manual", hint: "请手动删除该笔记（未拿到新笔记 id）" });
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
        if (!AgentTools._confirmWrite("添加标签 →《" + title + "》", tags.join("、"), ctx)) {
          return "用户拒绝了本次写操作（add_tags）。请基于对话继续，不要重试写入。";
        }
        // 只记「净新增」标签：已存在的（含大小写/空白差异）不写也不进撤销账本
        let existing = new Set();
        try {
          existing = new Set((it.getTags() || []).map((t) => String((t && t.tag) || "").trim()));
        } catch (e) { existing = new Set(); }
        const added = [];
        for (const t of tags) {
          if (existing.has(t)) continue;
          try { it.addTag(t); existing.add(t); added.push(t); }
          catch (e) { /* 单个失败不拖垮整批 */ }
        }
        await it.saveTx();
        if (added.length) {
          AgentTools._recordAudit("add_tags",
            "添加标签 " + added.join("、") + " →《" + title + "》（来源：" +
              AgentTools._ctxSource(ctx) + "）",
            { kind: "removeTags", itemID: it.id, tags: added });
        }
        return "✓ 已给条目 " + it.id + " 添加标签：" + tags.join("、");
      },
    },
    {
      id: "move_to_collection", label: "加入文集", readOnly: false,
      desc: "把条目加入指定文集（collection_id 见 list_collections；写操作，执行前会请求用户确认）",
      async run(args, ctx) {
        const it = (await AgentTools._getItem(args && args.item_id)) ||
          (ctx && ctx.item) || null;
        if (!it) return "找不到该条目（item_id 无效且当前无锁定文献）。请先用 search_library 检索。";
        const cid = parseInt(args && args.collection_id, 10);
        if (!isFinite(cid) || cid <= 0) {
          return "请提供 collection_id（可先用 list_collections 查看编号）。";
        }
        let col = null;
        try { col = await AgentTools._getCollection(cid); } catch (e) { col = null; }
        if (!col) return "找不到该文集（collection_id 无效）。请先用 list_collections 查看编号。";
        let title = "", cname = "";
        try { title = it.getDisplayTitle() || ""; } catch (e) { /* ignore */ }
        try { cname = String(col.name || "").trim(); } catch (e) { /* ignore */ }
        if (!AgentTools._confirmWrite("加入文集 →《" + title + "》", cname, ctx)) {
          return "用户拒绝了本次写操作（move_to_collection）。请基于对话继续，不要重试写入。";
        }
        try {
          await it.addToCollection(cid);
          await it.saveTx();
        } catch (e) {
          return "加入文集失败：" + ((e && e.message) || e);
        }
        AgentTools._recordAudit("move_to_collection",
          "把《" + title + "》加入文集「" + cname + "」（来源：" + AgentTools._ctxSource(ctx) + "）",
          { kind: "removeFromCollection", itemID: it.id, collectionID: cid });
        return "✓ 已把「" + title + "」加入文集「" + cname + "」";
      },
    },
    {
      id: "memory_read", label: "读取长期记忆", readOnly: true,
      desc: "读取 AI 长期记忆（研究方向 / 已得结论 / 用户偏好；query 可选关键词）",
      async run(args) {
        const M = AgentTools._memory();
        if (!M) return "记忆模块不可用（AgentMemory 未加载）";
        const q = String((args && args.query) || "").trim();
        const hits = M.search(q).slice(0, AgentTools.MEMORY_READ_MAX);
        if (!hits.length) {
          if (!q || !M.list().length) {
            return "暂无记忆（可用 memory_write 保存研究方向、结论、偏好）";
          }
          return "没有匹配「" + q + "」的记忆（共 " + M.list().length +
            " 条）。可换关键词，或不带 query 查看全部。";
        }
        return "记忆清单（最新在前；[序号] [kind] text）：\n" +
          hits.map((m, i) => "[" + (i + 1) + "] [" + m.kind + "] " + m.text).join("\n");
      },
    },
    {
      id: "memory_write", label: "写入长期记忆", readOnly: false,
      desc: "把研究方向、结论或偏好写入长期记忆（kind: project/fact/prefer；" +
        "写操作，执行前会请求用户确认）",
      async run(args, ctx) {
        const M = AgentTools._memory();
        if (!M) return "记忆模块不可用（AgentMemory 未加载）";
        const text = String((args && args.text) == null ? "" : args.text)
          .replace(/\s+/g, " ").trim();
        if (!text) return "记忆内容为空（请提供 text）。";
        const kind = M.normKind(args && args.kind);
        const label = M.kindLabel(kind);
        if (!AgentTools._confirmWrite("写入长期记忆 → [" + label + "]", text, ctx)) {
          return "用户拒绝了本次写操作（memory_write）。请基于对话继续，不要重试写入。";
        }
        const entry = M.add({ kind: kind, text: text, source: AgentTools._ctxSource(ctx) });
        if (!entry) return "记忆写入失败（内容为空或 pref 不可写）。";
        AgentTools._recordAudit("memory_write",
          "记忆写入：[" + label + "] " + text.slice(0, 80) +
            "（来源：" + AgentTools._ctxSource(ctx) + "）",
          { kind: "removeMemory", memoryId: entry.id });
        return "✓ 已记住（[" + label + "] " + entry.text + "）";
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

  /** 写操作确认（Zotero 原生 confirm；异常时保守拒绝）
   *  ctx.skipConfirm === true 时跳过弹框（MCP / 无 UI 入口，调用方须先校验 allowWrite） */
  _confirmWrite(head, detail, ctx) {
    if (ctx && ctx.skipConfirm === true) return true; // 无 UI 通道（已由调用方鉴权）
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

  /** 审计记录里的来源标签（MCP / UI / 自定义） */
  _ctxSource(ctx) {
    if (ctx && ctx.source) return String(ctx.source);
    if (ctx && ctx.skipConfirm === true) return "mcp";
    return "ui";
  },

  /** 整数参数钳制（坏值回退默认） */
  _clampInt(v, dflt, min, max) {
    let n = parseInt(v, 10);
    if (!isFinite(n)) n = dflt;
    return Math.max(min, Math.min(max, n));
  },

  /* ==================== 外部能力（运行时惰性探测） ====================
   * 三个模块可能因加载顺序 / 精简安装而不存在：一律 typeof 探测 + 可读降级，
   * 绝不在加载期引用（保持本文件「字面量 + 纯函数」的零副作用约定）。
   */

  _arxiv() {
    try {
      if (typeof ArxivFetch !== "undefined" && ArxivFetch &&
          typeof ArxivFetch.search === "function") return ArxivFetch;
    } catch (e) { /* ignore */ }
    return null;
  },

  _s2() {
    try {
      if (typeof S2Client !== "undefined" && S2Client &&
          typeof S2Client.paperById === "function") return S2Client;
    } catch (e) { /* ignore */ }
    return null;
  },

  _refFormat() {
    try {
      if (typeof RefFormat !== "undefined" && RefFormat &&
          typeof RefFormat.exportAs === "function") return RefFormat;
    } catch (e) { /* ignore */ }
    return null;
  },

  /** 长期记忆模块（agent-memory.js；缺位返回 null） */
  _memory() {
    try {
      if (typeof AgentMemory !== "undefined" && AgentMemory &&
          typeof AgentMemory.add === "function" &&
          typeof AgentMemory.list === "function") return AgentMemory;
    } catch (e) { /* ignore */ }
    return null;
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

  /** collection_id → 文集（优先 Collections.get；缺位时退回 getAll 查表） */
  async _getCollection(id) {
    const n = parseInt(id, 10);
    if (!isFinite(n) || n <= 0) return null;
    try {
      if (typeof Zotero.Collections.get === "function") {
        const c = Zotero.Collections.get(n);
        if (c) return c;
      }
    } catch (e) { /* ignore */ }
    try {
      const all = await Zotero.Collections.getAll(Zotero.Libraries.userLibraryID);
      return (all || []).find((c) => c && Number(c.id) === n) || null;
    } catch (e) { return null; }
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

  /** 最近条目（当前库；按 dateAdded 倒序，缺失则维持库顺序） */
  async _recentItems(limit) {
    const all = await this._allItems();
    const regs = (all || []).filter((it) => it && it.isRegularItem && it.isRegularItem());
    regs.sort((a, b) => String((b && b.dateAdded) || "").localeCompare(String((a && a.dateAdded) || "")));
    return regs.slice(0, Math.max(1, limit || 5));
  },

  /** DOI 归一：去 doi.org / doi: 前缀与尾部标点 */
  _normDoi(doi) {
    return String(doi || "")
      .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
      .replace(/^doi\s*[:：]\s*/i, "")
      .trim()
      .replace(/[)。，,；;.]+$/, "");
  },

  /** 条目 DOI：先 getField('DOI')，再扫 extra 字段的 DOI 行 */
  _itemDoi(it) {
    let doi = "";
    try { doi = String(it.getField("DOI") || "").trim(); } catch (e) { doi = ""; }
    if (!doi) {
      try {
        const extra = String(it.getField("extra") || "");
        const m = extra.match(/\bDOI\s*[:：]\s*(10\.[^\s，,；;]+)/i);
        if (m) doi = m[1];
      } catch (e) { /* ignore */ }
    }
    return this._normDoi(doi);
  },

  /** 去 HTML 标签（笔记正文检索用；实体做最小还原） */
  _stripHtml(html) {
    return String(html == null ? "" : html)
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, "\"")
      .replace(/&#39;/gi, "'")
      .replace(/&amp;/gi, "&")
      .replace(/\s+/g, " ")
      .trim();
  },

  /** 新笔记 id（createFromMarkdown 返回值；拿不到返回 null） */
  _noteId(note) {
    let raw = null;
    try { raw = note && (note.id != null ? note.id : note.noteID); } catch (e) { raw = null; }
    const n = parseInt(raw, 10);
    return isFinite(n) && n > 0 ? n : null;
  },

  /** Zotero 条目 → RefFormat 记录（只取导出需要的字段） */
  _itemRec(it) {
    const get = (f) => {
      try { return String(it.getField(f) || "").trim(); } catch (e) { return ""; }
    };
    const date = get("date");
    const rec = {
      title: get("title") || (it.getDisplayTitle ? String(it.getDisplayTitle() || "") : ""),
      date: date,
      year: (date.match(/\d{4}/) || [""])[0],
      container: get("publicationTitle") || get("bookTitle") || get("proceedingsTitle"),
      volume: get("volume"),
      issue: get("issue"),
      pages: get("pages"),
      doi: this._itemDoi(it),
      url: get("url"),
      abstract: get("abstractNote"),
      itemType: "",
      authors: [],
    };
    try { rec.itemType = String(it.itemType || ""); } catch (e) { /* ignore */ }
    try {
      rec.authors = (it.getCreators() || []).map((c) => (
        c && c.lastName
          ? { family: String(c.lastName), given: String(c.firstName || "") }
          : { literal: String((c && (c.name || c.firstName)) || "") }
      )).filter((a) => a.family || a.literal);
    } catch (e) { rec.authors = []; }
    return rec;
  },

  /* ==================== 写操作审计 / 撤销 ====================
   * 存储：pref agentAuditLog = JSON 字符串（数组，最新在前，上限 AUDIT_MAX）。
   * 单条：{id:"<ts>-<seq>", ts, tool, summary, undo:{kind,...}}
   * 撤销成功的语义：执行成功 → 移除该条并返回 {ok:true, done}；
   * 执行失败 → 保留记录（可重试）并返回 {ok:false, error}。
   */

  _auditRead() {
    let raw = null;
    try { raw = Prefs.get(this.PREF_AUDIT, ""); } catch (e) { return []; }
    let list = raw;
    if (typeof raw === "string") {
      try { list = JSON.parse(raw); } catch (e) { list = []; }
    }
    if (!Array.isArray(list)) return [];
    return list.filter((r) => r && typeof r === "object" && r.id != null)
      .slice(0, this.AUDIT_MAX);
  },

  _auditWrite(list) {
    const out = (Array.isArray(list) ? list : []).slice(0, this.AUDIT_MAX);
    try { Prefs.set(this.PREF_AUDIT, JSON.stringify(out)); } catch (e) { /* pref 不可用时放弃持久化 */ }
    return out;
  },

  /** 追加一条审计（内部；工具成功后调用）。返回新记录。 */
  _recordAudit(tool, summary, undo) {
    const list = this._auditRead();
    const ts = Date.now();
    this._auditSeq = (Number(this._auditSeq) || 0) + 1;
    const rec = {
      id: String(ts) + "-" + String(this._auditSeq),
      ts: ts,
      tool: String(tool || ""),
      summary: String(summary || ""),
      undo: (undo && typeof undo === "object") ? undo : { kind: "manual", hint: "该操作无自动撤销方案" },
    };
    list.unshift(rec);
    this._auditWrite(list);
    return rec;
  },

  /** 审计记录（最新在前；limit 缺省 = 全部，防御式拷贝） */
  auditList(limit) {
    const list = this._auditRead().slice();
    if (limit === undefined || limit === null || limit === "") return list;
    const n = parseInt(limit, 10);
    if (!isFinite(n)) return list;
    if (n <= 0) return [];
    return list.slice(0, Math.min(this.AUDIT_MAX, n));
  },

  /** 撤销最新一条；失败保留记录 */
  async undoLast() {
    const list = this._auditRead();
    if (!list.length) return { ok: false, error: "没有可撤销的操作" };
    return await this._undoRecord(list[0]);
  },

  /** 按 id 撤销（逻辑与 undoLast 复用） */
  async undoEntry(id) {
    const key = String(id == null ? "" : id);
    const rec = this._auditRead().find((r) => String(r.id) === key);
    if (!rec) return { ok: false, error: "找不到该审计记录（id 无效）" };
    return await this._undoRecord(rec);
  },

  async _undoRecord(rec) {
    const undo = (rec && rec.undo) || {};
    let done = "";
    try {
      if (undo.kind === "removeTags") {
        const it = await this._getItem(undo.itemID);
        if (!it) return { ok: false, error: "条目不存在（可能已被删除）：" + undo.itemID };
        const tags = Array.isArray(undo.tags) ? undo.tags : [];
        if (!tags.length) return { ok: false, error: "该记录没有可移除的标签" };
        for (const t of tags) it.removeTag(t); // 失败让它冒泡 → 保留记录可重试
        await it.saveTx();
        done = "已移除标签：" + tags.join("、") + "（条目 " + undo.itemID + "）";
      } else if (undo.kind === "eraseNote") {
        let note = null;
        try { note = Zotero.Items.get(undo.noteID); } catch (e) { note = null; }
        if (!note) return { ok: false, error: "笔记不存在（可能已被删除）：" + undo.noteID };
        if (typeof note.eraseTx !== "function") {
          return { ok: false, error: "该笔记无法删除（缺少 eraseTx）" };
        }
        await note.eraseTx();
        done = "已删除笔记（ID " + undo.noteID + "）";
      } else if (undo.kind === "removeFromCollection") {
        const it = await this._getItem(undo.itemID);
        if (!it) return { ok: false, error: "条目不存在（可能已被删除）：" + undo.itemID };
        let col = null;
        try { col = await this._getCollection(undo.collectionID); } catch (e) { col = null; }
        if (!col) return { ok: false, error: "文集不存在（可能已被删除）：" + undo.collectionID };
        await it.removeFromCollection(undo.collectionID);
        await it.saveTx();
        done = "已把条目 " + undo.itemID + " 移出文集「" + String(col.name || undo.collectionID) + "」";
      } else if (undo.kind === "removeMemory") {
        const M = this._memory();
        if (!M) return { ok: false, error: "记忆模块不可用（AgentMemory 未加载）" };
        if (!M.remove(undo.memoryId)) {
          return { ok: false, error: "记忆不存在（可能已被删除）：" + undo.memoryId };
        }
        done = "已删除记忆：" + undo.memoryId;
      } else if (undo.kind === "restoreFields") {
        // 元数据医生：把字段写回旧值（空串即清空）；creators 用作者数组还原
        const it = await this._getItem(undo.itemID);
        if (!it) return { ok: false, error: "条目不存在（可能已被删除）：" + undo.itemID };
        const fields = (undo.fields && typeof undo.fields === "object") ? undo.fields : {};
        const restored = [];
        for (const f of Object.keys(fields)) {
          try {
            if (f === "creators") {
              if (typeof it.setCreators !== "function") continue;
              it.setCreators(Array.isArray(fields[f]) ? fields[f] : []);
            } else {
              it.setField(f, fields[f] == null ? "" : String(fields[f]));
            }
            restored.push(f);
          } catch (e) {
            // 单个字段失败（类型不支持/字段名非法）→ 跳过，其余照常还原
          }
        }
        if (!restored.length) return { ok: false, error: "该记录没有可恢复的字段" };
        await it.saveTx();
        done = "已恢复字段：" + restored.join("、") + "（条目 " + undo.itemID + "）";
      } else {
        return { ok: false, error: (undo.hint || "该操作不支持自动撤销") };
      }
    } catch (e) {
      return { ok: false, error: "撤销失败：" + ((e && e.message) || e) };
    }
    this._auditWrite(this._auditRead().filter((r) => String(r.id) !== String(rec.id)));
    return { ok: true, done: done };
  },

  /* ==================== 调用协议（提示词约定，兼容任意网关） ==================== */

  /** 工具协议 system 提示块（含任务规划指令——Hermes 式「先规划后执行」） */
  protocolPrompt() {
    const tools = this.enabledTools();
    if (!tools.length) return "";
    const zh = (typeof I18n !== "undefined" && I18n && I18n.isZh) !== false;
    // 参数提示按工具 id 查表（工具清单本身来自注册表，这里只补调用签名）
    const ARG_HINTS = {
      search_library: "(query)",
      get_item_details: "(item_id)",
      read_item_fulltext: "(item_id?)",
      list_collections: "()",
      search_arxiv: "(query, category?, max?)",
      get_citation_count: "(item_id? | doi?)",
      search_notes: "(query, max?)",
      export_bibliography: "(item_ids?, style?)",
      add_note: "(item_id?, text)",
      add_tags: "(item_id?, tags)",
      move_to_collection: "(item_id?, collection_id)",
      memory_read: "(query?)",
      memory_write: "(kind?, text)",
    };
    const lines = tools.map((t) => {
      const args = ARG_HINTS[t.id] || "()";
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
