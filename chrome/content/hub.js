/* PaperPilot 功能中心逻辑（0.12.0）
 * 只负责导航与调用分发：所有功能动作都经 Zotero.PaperPilot 暴露的
 * 模块引用调起现有 runForSelected()/run() 入口，核心逻辑零改动。
 * 数据通道与 workbench 相同：Zotero/Services 经 window.arguments 传入。
 */
/* global window, document, setInterval, clearInterval */

(function () {
  const XHTML = "http://www.w3.org/1999/xhtml";

  /** 功能模型（纯数据，动作闭包在调用时才触碰 PP，便于测试与维护） */
  function buildCats(PP, zh) {
    return [
      {
        id: "reader", icon: "📖",
        title: zh ? "阅读助手" : "Reading",
        desc: zh ? "阅读单篇文献时的 AI 精读工具（作用于当前选中的文献）" : "AI tools for the current paper",
        features: [
          { t: zh ? "AI 工作台" : "Workbench", d: zh ? "独立窗口对话，跟随主窗口选中条目" : "Standalone chat window", run: () => PP.openWorkbench() },
          { t: zh ? "AI 总结（生成笔记）" : "Summarize", d: zh ? "300-500 字总结研究问题、方法、结果与结论" : "300-500 word summary note", run: () => PP.menus.aiTaskForSelected((it) => PP.aiChat.summarize(it), "noteSummaryTitle") },
          { t: zh ? "AI 翻译标题与摘要" : "Translate title/abstract", d: zh ? "学术语气翻译，术语保留英文括号标注" : "Academic translation note", run: () => PP.menus.aiTaskForSelected((it) => PP.aiChat.translateTitleAbstract(it), "noteTranslateTitle") },
          { t: zh ? "AI 深度解读" : "Deep interpret", d: zh ? "五段式结构化解读：问题/方法/实验/创新/局限" : "Structured interpretation note", run: () => PP.menus.aiTaskForSelected((it) => PP.aiChat.interpret(it), "noteTitle") },
          { t: zh ? "全文对照翻译" : "Bilingual translation", d: zh ? "左右双栏对照窗口（左原文/右译文，窄屏自动单栏；一次一篇，窗口内可一键导出双语笔记）" : "Side-by-side bilingual window (source left / translation right; export a note from within)", run: () => PP.bilingual.openViewerForSelected() },
          { t: zh ? "AI 思维导图" : "Mind map", d: zh ? "生成层级大纲笔记，可导出 markmap .md" : "Outline note + .md export", run: () => PP.mindmap.runForSelected() },
          { t: zh ? "AI 问答侧栏" : "Chat sidebar", d: zh ? "选中条目后在右侧栏「AI 问答」直接提问" : "Auto: ask in the sidebar", info: true },
          { t: zh ? "划词浮窗" : "Selection popup", d: zh ? "阅读器内划词即翻译/解读/追问（设置中可配置）" : "Auto: translate/explain/ask in reader", info: true },
          { t: zh ? "PDF 速览" : "PDF glance", d: zh ? "侧栏显示摘要与全文开篇，无需打开 PDF" : "Auto: abstract + opening in sidebar", info: true },
          { t: zh ? "入库自动精读" : "Auto-read on import", d: zh ? "新条目入库自动生成总结笔记（需在「自动化规则」窗口开启，受每日额度与分类白名单限制）" : "Automatically summarize new items (opt-in, quota-limited)", run: () => PP.autoRead.runForSelected() },
        ],
      },
      {
        id: "search", icon: "🧭",
        title: zh ? "检索与发现" : "Search & Discovery",
        desc: zh ? "跨整个库的检索与问答（不再局限于当前这一篇）" : "Ask and search across the whole library",
        features: [
          { t: zh ? "库内问答（问整个库）" : "Ask the library", d: zh ? "用一句话提问，自动检索候选文献（标题/标签/摘要+全文复核）后由 AI 依据候选作答，带 [n] 引用编号" : "Natural-language Q&A across your library with [n] citations", run: () => PP.libSearch.openDialog() },
          { t: zh ? "库内检索（只看候选）" : "Retrieve only", d: zh ? "只要候选文献列表与命中片段，不调用 AI（可在对话框内关闭 AI 回答）" : "Candidate list only, no AI call", run: () => PP.libSearch.openDialog() },
          { t: zh ? "文献发现（arXiv 每日推荐）" : "Discovery (arXiv daily)", d: zh ? "用库里已有文献建兴趣画像，从 arXiv 最新提交里挑出值得看的新论文；自动排除已入库的，可一键收藏到「推荐」分类" : "arXiv recommendations built from your library's interests", run: () => PP.discovery.openDialog() },
        ],
      },
      {
        id: "notes", icon: "🗒",
        title: zh ? "笔记与卡片" : "Notes & Cards",
        desc: zh ? "读完后的知识沉淀：笔记、模板、记忆卡片" : "Knowledge capture after reading",
        features: [
          { t: zh ? "收集批注为笔记" : "Collect annotations", d: zh ? "聚合全部高亮与批注为一篇笔记" : "Gather highlights into a note", run: () => PP.menus.annotationTask(false) },
          { t: zh ? "AI 解读批注" : "Interpret annotations", d: zh ? "解读划出的重点反映了什么主线与关注点" : "AI insights on your highlights", run: () => PP.menus.annotationTask(true) },
          { t: zh ? "按模板新建笔记" : "Note from template", d: zh ? "阅读笔记/精读卡片/速读记录等模板一键生成" : "Structured note from templates", run: () => PP.noteTemplates.runForSelected() },
          { t: zh ? "AI 制卡导出 Anki" : "Cards to Anki", d: zh ? "基于全文生成问答卡，导出 Anki 导入格式" : "Q/A cards export (.txt)", run: () => PP.ankiExport.runForSelected() },
          { t: zh ? "笔记关系图谱" : "Note graph", d: zh ? "把条目与笔记的链接关系画成可交互图谱（支持 zotero:// 链接与 [[标题]]），点节点可在主窗口定位" : "Interactive graph of notes and their links", run: () => PP.noteGraph.openDialog() },
        ],
      },
      {
        id: "batch", icon: "📊",
        title: zh ? "批量分析" : "Batch Analysis",
        desc: zh ? "多篇文献横向对比与汇总（需选中 2 篇以上或一个分类）" : "Compare and synthesize multiple papers",
        features: [
          { t: zh ? "多篇 PDF 并排对比" : "Compare PDFs", d: zh ? "最多 4 篇并排同屏：横向/纵向/网格布局，同步滚动与缩放，只读预览已有高亮（需选中 2 篇以上）" : "Up to 4 PDFs side by side with synced scroll/zoom (select 2+)", run: () => PP.pdfCompare.runForSelected() },
          { t: zh ? "AI 文献矩阵" : "Literature matrix", d: zh ? "按维度抽取生成对比表格笔记" : "Dimension comparison table", run: () => PP.matrix.forSelected() },
          { t: zh ? "AI 文献综述" : "Literature review", d: zh ? "多篇生成带引用编号的综述段落" : "Review with citation numbers", run: () => PP.reviewGen.forSelected() },
          { t: zh ? "引文追溯" : "Citation trace", d: zh ? "参考文献/施引文献分析笔记" : "References & citing papers note", run: () => PP.citationTrace.runForSelected() },
          { t: zh ? "参考文献一键入库" : "Import references", d: zh ? "把当前文献的参考文献批量添加进库" : "Batch import references", run: () => PP.citationTrace.importForSelected() },
          { t: zh ? "分类条目统计" : "Collection stats", d: zh ? "当前分类的条目/附件/标签统计" : "Stats for current collection", run: () => PP.collectionStats.showForSelectedCollection() },
          { t: zh ? "文献统计图谱" : "Library report", d: zh ? "年份/期刊/作者/标签分布 HTML 报告" : "HTML report with charts", run: () => PP.libGraph.run() },
          { t: zh ? "阅读报告（日历热力图）" : "Reading report", d: zh ? "近 30 天阅读时长、日历热力图与时长最多的文献（打开 PDF 时自动每分钟累计）" : "Reading time with calendar heatmap", run: () => PP.readingStats.run() },
        ],
      },
      {
        id: "health", icon: "🩺",
        title: zh ? "库健康" : "Library Health",
        desc: zh ? "元数据与附件的检查、修复与补全" : "Metadata & attachment maintenance",
        features: [
          { t: zh ? "中文文件名识别元数据" : "CN filename metadata", d: zh ? "解析知网/万方文件名回填标题作者期刊" : "Parse CNKI-style filenames", run: () => PP.cnMeta.runForSelected() },
          { t: zh ? "抓取中文元数据" : "Fetch CN metadata", d: zh ? "网络搜索（公益学术平台/知网）回填完整题录，保留原附件" : "Search & fill full metadata, keep attachments", run: () => PP.cnFetch.runForSelected() },
          { t: zh ? "更新中文转换器" : "Update CN translators", d: zh ? "拉取最新知网/万方转换器，修复中文抓取与 PDF 下载" : "Fix CNKI scraping & PDF download", run: () => PP.cnTranslators.update(true) },
          { t: zh ? "知网验证" : "CNKI verification", d: zh ? "知网风控拦截时打开验证页解除（滑块），验证通过自动续抓" : "Unblock CNKI risk control via verification page", run: () => PP.cnVerify.interactive() },
          { t: zh ? "下载文件夹查找附件" : "Match attachments", d: zh ? "把下载目录里已下载的 PDF/CAJ 按标题匹配到条目" : "Match downloaded PDFs to items", run: () => PP.cnFetch.matchAttachmentsFromDownloads() },
          { t: zh ? "元数据补全" : "Enrich metadata", d: zh ? "S2 查询回写空缺字段（不覆盖已有值）" : "Fill missing fields via S2", run: () => PP.metaEnrich.runForSelected() },
          { t: zh ? "元数据规范清洗" : "Metadata lint", d: zh ? "DOI/日期/标题/URL 格式规范化" : "Normalize DOI/date/title/URL", run: () => PP.metaLint.runForSelected() },
          { t: zh ? "元数据体检（规则补齐）" : "Metadata rules", d: zh ? "期刊缩写↔全称互转、作者名归一化、DOI 有效性、类型必备字段、重复 DOI —— 出问题清单后勾选修复" : "Journal abbrev/full, author names, DOI validity, required fields, duplicate DOIs (checklist fix)", run: () => PP.metaRules.openDialog() },
          { t: zh ? "智能清理" : "Smart cleanup", d: zh ? "扫描重复/无附件/缺元数据条目" : "Scan duplicates & gaps", run: () => PP.smartCleanup.run() },
          { t: zh ? "真假文献识别" : "Fake check", d: zh ? "AI 幻觉检测：题录是否真实存在" : "Detect hallucinated references", run: () => PP.fakeCheck.runForSelected() },
          { t: zh ? "粘贴文献列表核验" : "Verify pasted list", d: zh ? "粘贴一段参考文献列表逐条核验真伪" : "Verify a pasted reference list", run: () => PP.fakeCheck.openPasteDialog() },
          { t: zh ? "开放获取补全文" : "Find OA full text", d: zh ? "Unpaywall 合法渠道为有 DOI 条目补 PDF" : "Attach OA PDFs via Unpaywall", run: () => PP.oaFetch.runForSelected() },
          { t: zh ? "附件按规则重命名" : "Rename attachments", d: zh ? "按 作者-年份-标题 模板统一附件文件名" : "Rename PDFs by pattern", run: () => PP.attachManager.runForSelected() },
          { t: zh ? "附件体检（断链/重复/扫描件）" : "Attachment doctor", d: zh ? "扫描无附件、文件丢失、同父重复、无文本层 PDF（AI 读不了）、存储孤儿文件，出报告不打标签不删文件" : "Scan missing/duplicate/scanned attachments and storage orphans", run: () => PP.attachDoctor.run() },
        ],
      },
      {
        id: "tags", icon: "🏷",
        title: zh ? "标签与状态" : "Tags & State",
        desc: zh ? "组织与筛选：标签体系与阅读状态管理" : "Tagging and reading states",
        features: [
          { t: zh ? "AI 自动打标签" : "AI auto tag", d: zh ? "LLM 按内容建议标签" : "LLM-suggested tags", run: () => PP.autoTag.runForSelected() },
          { t: zh ? "规则打标" : "Rule tag", d: zh ? "按自定义条件规则批量打标签" : "Conditional rule tagging", run: () => PP.ruleTag.runForSelected() },
          { t: zh ? "标签治理（扫描变体）" : "Tag curator (scan)", d: zh ? "找出同一含义的多种写法（大小写/全半角/空格连字符）、罕见标签与层级缺失，只出报告不改数据" : "Find variant/rare/missing-parent tags (read-only)", run: () => PP.tagCurator.run(false) },
          { t: zh ? "标签归一（执行合并）" : "Normalize tags", d: zh ? "按扫描结果把变体合并到主体写法，执行前弹确认框，不可自动撤销" : "Merge tag variants into the main spelling (confirm required)", run: () => PP.tagCurator.run(true) },
          { t: zh ? "自动化规则（触发→条件→动作）" : "Automation rules", d: zh ? "可视化配置：新条目入库/打开 PDF/手动 → 条件匹配 → 打标签/写字段/设状态/加分类/AI 总结；含试跑预览与入库自动精读开关" : "Visual trigger-condition-action rules with dry-run and auto-read switches", run: () => PP.automation.openDialog() },
          { t: zh ? "标记为「未读」" : "Mark unread", d: zh ? "阅读状态三态互斥（未读/在读/已读）" : "Mutually exclusive states", run: () => PP.readingState.markForSelected("未读") },
          { t: zh ? "标记为「在读」" : "Mark reading", d: zh ? "打开 PDF 也会自动从「未读」转为「在读」" : "Auto-updated when opening PDF", run: () => PP.readingState.markForSelected("在读") },
          { t: zh ? "标记为「已读」" : "Mark done", d: zh ? "读完后归档状态" : "Finished state", run: () => PP.readingState.markForSelected("已读") },
        ],
      },
      {
        id: "integrate", icon: "🔌",
        title: zh ? "集成与互操作" : "Integration",
        desc: zh ? "把 PaperPilot 的能力交给外部 AI 客户端使用（本地、带鉴权）" : "Expose PaperPilot's abilities to external AI clients",
        features: [
          { t: zh ? "MCP 对外供给" : "MCP server", d: zh ? "把「库检索 / 读全文 / 读批注 / 写笔记 / 分类统计」封装为 MCP 工具，供 Claude Desktop、Cursor 或自建 Agent 调用；仅监听 127.0.0.1 且需 Bearer 令牌，默认关闭" : "Expose library tools over MCP (localhost + token, off by default)", run: () => PP.mcp.openDialog() },
        ],
      },
      {
        id: "config", icon: "⚙",
        title: zh ? "数据列与配置" : "Data & Settings",
        desc: zh ? "自动展示的数据列与全局配置入口" : "Columns and global settings",
        features: [
          { t: zh ? "重新抓取被引量" : "Refresh citations", d: zh ? "Semantic Scholar 被引量手动刷新" : "Refresh citation counts", run: () => PP.citationColumn.refreshForSelected() },
          { t: zh ? "接口连通性测试" : "Connection test", d: zh ? "测试当前 AI 服务商与模型是否可用" : "Test AI endpoint", run: () => PP.menus.testConnection() },
          { t: zh ? "打开设置" : "Open settings", d: zh ? "服务商/模型/快照/浮窗/模板等全部配置" : "All preferences", run: () => PP.menus.openSettings() },
          { t: zh ? "期刊分区列" : "Journal rank column", d: zh ? "easyScholar 在线 + 离线数据，列表自动显示" : "Auto column", info: true },
          { t: zh ? "被引量列" : "Citation column", d: zh ? "Semantic Scholar 被引数，右键表头勾选显示" : "Auto column", info: true },
          { t: zh ? "AI 配置快照" : "AI profiles", d: zh ? "工具菜单中一键切换多套 AI 配置" : "Switch profiles in Tools menu", info: true },
        ],
      },
    ];
  }

  function boot() {
    let Services, opener, Zotero, PP, zh;
    try {
      const args = window.arguments && window.arguments[0];
      Services = (args && args.Services) || window.Services;
      Zotero = (args && args.Zotero) || (window.opener && window.opener.Zotero);
      opener = window.opener;
      if (!Services || !Zotero || !Zotero.PaperPilot) return;
      PP = Zotero.PaperPilot;
      zh = (Zotero.locale || "").toLowerCase().startsWith("zh");
    } catch (e) { return; }

    const $ = (id) => document.getElementById(id);
    const nav = $("pp-hub-nav");
    const cards = $("pp-hub-cards");
    const status = $("pp-hub-status");
    const cats = buildCats(PP, zh);
    let activeId = cats[0].id;
    let filterText = "";

    function h(tag, css, text) {
      const el = document.createElementNS(XHTML, tag);
      if (css) el.style.cssText = css;
      if (text != null) el.textContent = text;
      return el;
    }

    function setStatus(t, color) {
      status.textContent = t || "";
      status.style.color = color || "var(--fill-tertiary,#888)";
    }

    function renderNav() {
      nav.textContent = "";
      for (const c of cats) {
        const active = c.id === activeId;
        const btn = h("div",
          "padding:6px 10px;border-radius:6px;cursor:pointer;font-size:13px;" +
          (active ? "background:var(--color-accent,#2563eb);color:#fff;font-weight:600;" : "color:var(--fill-primary,#333);"),
          `${c.icon} ${c.title}`);
        if (!active) {
          btn.addEventListener("mouseenter", () => { btn.style.background = "var(--fill-quinary,#e2e2e6)"; });
          btn.addEventListener("mouseleave", () => { btn.style.background = ""; });
        }
        btn.addEventListener("click", () => { activeId = c.id; renderAll(); });
        nav.appendChild(btn);
      }
    }

    function renderCards() {
      cards.textContent = "";
      const cat = cats.find((c) => c.id === activeId);
      $("pp-hub-cat-title").textContent = `${cat.icon} ${cat.title}`;
      $("pp-hub-cat-desc").textContent = cat.desc;
      const kw = filterText.trim().toLowerCase();
      const feats = cat.features.filter((f) =>
        !kw || (f.t + " " + f.d).toLowerCase().includes(kw));
      if (!feats.length) {
        cards.appendChild(h("div", "color:var(--fill-tertiary,#999);padding:12px;",
          zh ? "没有匹配的功能" : "No matching features"));
        return;
      }
      for (const f of feats) {
        const card = h("div",
          "display:flex;align-items:center;gap:10px;border:1px solid var(--material-border,1px solid #ddd);border-radius:8px;" +
          "padding:10px 12px;background:var(--material-surface,#fafafa);");
        const left = h("div", "flex:1;min-width:0;");
        left.appendChild(h("div", "font-weight:600;font-size:13px;", f.t));
        left.appendChild(h("div", "color:var(--fill-secondary,#666);font-size:12px;margin-top:2px;", f.d));
        card.appendChild(left);
        if (f.info) {
          card.appendChild(h("span",
            "color:var(--color-accent,#2563eb);font-size:11px;border:1px solid var(--color-accent,#2563eb);border-radius:10px;" +
            "padding:1px 8px;white-space:nowrap;",
            zh ? "自动" : "auto"));
        } else {
          const btn = h("button", "padding:4px 14px;font-size:12px;cursor:pointer;white-space:nowrap;",
            zh ? "运行" : "Run");
          btn.addEventListener("click", () => {
            setStatus("");
            try {
              const r = f.run();
              if (r && r.catch) r.catch((e) => setStatus((zh ? "出错：" : "Error: ") + (e && e.message || e), "var(--accent-red,#c0392b)"));
            } catch (e) {
              setStatus((zh ? "出错：" : "Error: ") + (e && e.message || e), "var(--accent-red,#c0392b)");
            }
          });
          card.appendChild(btn);
        }
        cards.appendChild(card);
      }
    }

    function renderAll() { renderNav(); renderCards(); }

    // 主窗口选中计数（批量类功能的可用性提示）
    function pollSelection() {
      try {
        if (!opener || opener.closed) { window.close(); return; }
        const zp = Zotero.getActiveZoteroPane();
        const n = zp ? (zp.getSelectedItems() || []).length : 0;
        $("pp-hub-selcount").textContent = (zh ? "主窗口选中：" : "Selected: ") + n + (zh ? " 篇" : "");
      } catch (e) { /* 主窗口切换瞬间忽略 */ }
    }

    $("pp-hub-filter").addEventListener("input", (ev) => {
      filterText = ev.target.value || "";
      renderCards();
    });

    renderAll();
    pollSelection();
    const timer = setInterval(pollSelection, 1500);
    try { opener.addEventListener("unload", () => window.close(), { once: true }); } catch (e) { /* ignore */ }
    window.addEventListener("unload", () => clearInterval(timer));
  }

  // 暴露模型给测试与调试
  if (typeof window !== "undefined") window.PPHub = { buildCats };

  if (document.readyState === "complete" || document.readyState === "interactive") {
    boot();
  } else {
    window.addEventListener("load", boot, { once: true });
  }
})();
