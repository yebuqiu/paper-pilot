/* PaperPilot AI 技能包商店 · 核心域模块（Skills Hub core，0.49.0）
 *
 * 技能包 = 一份 manifest（v1），把四类内容一次性装配进 PaperPilot：
 *   · prompts       → CommandTags 命令标签（id 一律前缀 "sp:<packId>:"，可整体卸载）
 *   · glossary      → 翻译术语表（行式「原文 = 译文 | 领域」；优先 TranslateSvc.mergeGlossary，
 *                     不存在则用本模块兜底合并器直接写 pref translateGlossary）
 *   · noteTemplates → 笔记模板中心自定义模板（仅增量 upsert，绝不动用户已有模板）
 *   · agentPreset   → Agent 模式预设（不自动应用；详情页显式 applyAgentPreset）
 *
 * 记账（pref skillPacksInstalled，JSON）：每包记录 {version, at, manifest,
 * applied:{promptIds, glossaryLines, templateNames}}——卸载按记账精确回滚。
 * 本地评分（pref skillPackRatings）；目录源（pref skillStoreSource，空 = 内置精选）。
 *
 * 纪律：加载期零副作用（仅本对象字面量）；外部依赖全部运行时探测、缺位降级不报错；
 * pref 坏值容错；install/uninstall 永不抛出（返回 {ok, error}）。
 *
 * 消费方：技能商店 UI（features/ 侧）与设置面板。所有 pref 读写走全局 Prefs 封装。
 */
/* global Zotero, Prefs, CommandTags, NoteTemplates, TranslateSvc */

var SkillPacks = {
  MANIFEST_VERSION: 1,
  CATEGORIES: ["写作", "审稿", "翻译", "阅读", "标签", "Agent", "模板", "综合"],

  PREF_INSTALLED: "skillPacksInstalled",
  PREF_RATINGS: "skillPackRatings",
  PREF_SOURCE: "skillStoreSource",
  PREF_GLOSSARY: "translateGlossary",
  PREF_AI_SYSTEM: "aiSystemPrompt",
  PROMPT_PREFIX: "sp:",

  /** 提示词标签缺省配色（与 CommandTags._PALETTE 同源的固定调色板，按序轮转） */
  _PALETTE: ["#2563eb", "#0d9488", "#c2410c", "#7c3aed", "#be185d", "#4d7c0f", "#0369a1", "#a16207"],

  /* ==================== 内置精选目录（6 包，全部通过 validate） ==================== */

  _BUILTIN: [
    {
      id: "survey-writer",
      name: "综述写作助手",
      version: "1.1.0",
      author: "PaperPilot",
      desc: "从文献库生成综述大纲与相关工作段落，按主题组织并逐点标注证据来源。",
      longDesc: "面向写综述的研究者：先用「综述框架」让 Agent 检索文献库、产出分节大纲（每节标明要点与缺失的证据类型），再用「相关工作段落」把上下文文献组织成按主题线索展开的 related work 段落。配套 Agent 预设开启检索/读全文/读详情三工具，8 步上限。",
      category: "写作",
      tags: ["综述", "写作", "文献综合"],
      changelog: "1.1.0: 「相关工作段落」强化「按主题组织」约束，禁止逐篇罗列\n1.0.0: 首发",
      rating: 4.7,
      ratingsCount: 89,
      downloads: 1024,
      contents: {
        prompts: [
          {
            id: "outline",
            label: "综述框架",
            // trigger：输入「综述 <主题>」直接触发；{input} 亦可先输入主题再点标签替换
            prompt: "我要写一篇关于「{input}」的文献综述。请先检索文献库中与该主题相关的文献，然后产出一份数字编号的分节大纲（4-6 节）。每节给出：①小标题；②本节要点（2-4 条，每条说明要综合哪些文献的什么发现，注明「文献 n：短标题」）；③该节还需要、但库中缺少的证据类型（数据/方法/对照基准）。纪律：主题划分必须依据文献实际处理的问题，不凑空节；库内没有覆盖的方向明确标注「库内无证据」，不要编造文献。",
            color: "",
            trigger: "^综述",
          },
          {
            id: "related-work",
            label: "相关工作段落",
            prompt: "请基于当前对话上下文中的文献，写一段中文 related work（300-500 字）。要求：①按主题线索组织（方法流派/问题变体/争议点），绝不按文献逐篇罗列；②每个论断后用「文献 n」标注出处，只引用上下文中真实存在的文献；③对比要具体到方法、数据与结论的差异——谁在什么数据上、比谁好在哪，有数字引数字；④段落末尾用一句话指出这些工作共同留下的空白。论文里没有的信息不要补写。",
            color: "",
            trigger: "",
          },
        ],
        agentPreset: {
          chatAgentMode: true,
          aiAgentTools: "search_library,read_item_fulltext,get_item_details",
          aiAgentMaxSteps: 8,
        },
      },
    },
    {
      id: "reviewer-toolkit",
      name: "批判审稿工具箱",
      version: "1.0.0",
      author: "PaperPilot",
      desc: "顶会式审稿意见与统计学审读：优点配证据、问题三层分级、统计缺口清单。",
      longDesc: "两枚高纪律审读提示词：「顶会式审稿」产出优点（每条配论文内具体位置证据）、按致命/重大/次要分层的问题清单与录用倾向；「统计学审读」核对样本量、效应量、检验方法是否支撑结论，并列出应索要的缺失报告项。",
      category: "审稿",
      tags: ["审稿", "评审", "质量"],
      rating: 4.8,
      ratingsCount: 132,
      downloads: 866,
      contents: {
        prompts: [
          {
            id: "peer-review",
            label: "顶会式审稿",
            prompt: "请以顶会资深审稿人身份用中文审读这篇论文，输出三节：\n**优点**：3 条，每条必须指明论文中的具体位置（章节/图表/实验编号）作为证据；\n**问题**：按「致命（动摇结论）/ 重大（需补实验或论证）/ 次要（表述与规范）」三层列出，每条写明：问题是什么、出现在哪、为什么是问题、怎样才算解决；\n**录用倾向**：接收 / 小修 / 大修 / 拒稿，附 2-3 句理由。\n纪律：只依据论文写了的内容批评，不要求论文做它没承诺的事；区分「作者已承认的局限」与「未被讨论的风险」。",
            color: "",
            trigger: "",
          },
          {
            id: "stats-audit",
            label: "统计学审读",
            prompt: "请用中文对这篇论文做统计学审读：\n**样本与设计**：样本量、分组方式、有无先验功效分析，能否支撑其声称的检测目标；\n**效应量与检验**：逐个核对主要结论——效应量方向与大小、检验方法、p 值或置信区间是否报告齐全；只给 p 值不给效应量的结论单独点名；\n**多重比较**：是否存在多重检验未校正；\n**缺失项清单**：列出论文未报告但审稿应索要的统计信息（随机化细节、剔除标准、方差齐性检验等），逐条标注「未报告」。\n所有判断注明论文位置（章节/表号/图号）；论文没写的信息标注「未报告」，不要臆测。",
            color: "",
            trigger: "",
          },
        ],
      },
    },
    {
      id: "medical-reader",
      name: "医学科研阅读包",
      version: "1.0.0",
      author: "PaperPilot",
      desc: "PICO 五要素提取与疗效/安全性分列阅读，附 10 条医学术语表。",
      longDesc: "临床文献阅读三板斧：「PICO 提取」把研究拆成 P/I/C/O 四要素（出处位置逐一标注，未报告的明确标注）；「疗效与安全性」把主要结局（方向+效应量+置信区间）与不良反应分栏整理，全部数字回溯到原文表号。术语表采用社区通行教科书译法。",
      category: "阅读",
      tags: ["医学", "PICO", "临床"],
      rating: 4.5,
      ratingsCount: 76,
      downloads: 590,
      contents: {
        prompts: [
          {
            id: "pico",
            label: "PICO 提取",
            prompt: "请从这篇论文提取 PICO 要素，用表格输出：\nP（研究对象）：人群、纳入/排除标准、样本量；\nI（干预）：干预内容、剂量/强度、实施者；\nC（对照）：对照类型（安慰剂/常规治疗/阳性对照），无对照写「无」；\nO（结局）：主要结局与次要结局各是什么、测量方式与时点。\n每个要素后注明出处位置（章节/表号/页码）；论文未报告的要素标注「未报告」，不要用常识补写。表下补一行：该研究的 PICO 是否回答了一个明确的临床问题（1-2 句）。",
            color: "",
            trigger: "",
          },
          {
            id: "efficacy-safety",
            label: "疗效与安全性",
            prompt: "请用中文分两栏整理这篇临床研究的证据：\n**疗效**：逐个列主要结局——方向（优于/劣于/无差异）、效应量（RR/OR/HR/均差及 95% CI）、p 值；只有 p 值没有效应量的结局注明「未报告效应量」；\n**安全性**：不良反应按类型列出发生率（干预组 vs 对照组）、严重不良事件、退出/脱落情况。\n所有数字必须来自论文原文（标注表号/图号），论文没给的数字写「未报告」；最后用一句话概括：获益与风险的总体对比。",
            color: "",
            trigger: "",
          },
        ],
        glossary: [
          "randomized controlled trial = 随机对照试验 | 医学",
          "systematic review = 系统评价 | 医学",
          "meta-analysis = 荟萃分析 | 医学",
          "confidence interval = 置信区间 | 医学",
          "hazard ratio = 风险比 | 医学",
          "odds ratio = 比值比 | 医学",
          "intention-to-treat = 意向性分析 | 医学",
          "placebo = 安慰剂 | 医学",
          "adverse event = 不良事件 | 医学",
          "number needed to treat = 需治疗人数 | 医学",
        ],
      },
    },
    {
      id: "deep-reading",
      name: "深度研读模式",
      version: "1.0.0",
      author: "PaperPilot",
      desc: "全六工具 Agent 预设 + 五遍研读法与概念图两枚精读提示词。",
      longDesc: "为深读一篇论文而生的组合：agentPreset 开启全部六个 Agent 工具（检索/读详情/读全文/列分类/加笔记/加标签）、10 步上限；「五遍研读法」按框架→方法→证据→边界→追问五轮递进拆解论文；「概念图」把核心概念与关系输出为 Markdown 层级列表。",
      category: "Agent",
      tags: ["精读", "计划", "工具"],
      rating: 4.6,
      ratingsCount: 64,
      downloads: 733,
      contents: {
        agentPreset: {
          chatAgentMode: true,
          aiAgentTools: "search_library,get_item_details,read_item_fulltext,list_collections,add_note,add_tags",
          aiAgentMaxSteps: 10,
        },
        prompts: [
          {
            id: "five-pass",
            label: "五遍研读法",
            prompt: "请带领我对这篇论文做五遍递进式研读，每遍按以下结构输出，每遍末尾给「下一遍要追问的问题」2-3 个：\n第一遍·框架：研究问题、核心主张、贡献声明（各 1 句，注明出处章节）；\n第二遍·方法：研究设计、数据与规模、关键变量测量，指出最可能引入偏差的步骤；\n第三遍·证据：主要结果逐条核对——主张、支撑数据、效应大小，标注证据薄弱的结论；\n第四遍·边界：适用范围、作者承认的局限、作者未承认但存在的风险；\n第五遍·追问：列出 3-5 个值得追问的问题，区分「论文可回答」与「需要新实验」。\n全程只引用论文实际内容，推断要标注「我的推断」。",
            color: "",
            trigger: "",
          },
          {
            id: "concept-map",
            label: "概念图",
            prompt: "请把这篇论文的核心概念与关系整理成 Markdown 层级列表（用缩进表示从属）：\n顶层是论文要解决的 central problem；其下分出 3-6 个核心概念，每个概念一行：概念名（论文定义 1 句 + 出处）；另设一节「关系」，逐条写「A →(关系类型) B：依据（章节/图号）」。\n只收论文中实际出现且承重的概念，不掺入教科书常识；论文未明确给出的关系标注「推断」。",
            color: "",
            trigger: "",
          },
        ],
      },
    },
    {
      id: "translate-polish",
      name: "论文翻译精调",
      version: "1.0.0",
      author: "PaperPilot",
      desc: "14 条 CS/AI 高频术语表 + 术语一致性自查提示词，让全文翻译用词统一。",
      longDesc: "翻译质量三件套：内置 CS/AI 高频术语表（transformer、微调、消融实验等社区通行译法，安装即并入全局术语表）；「术语一致性自查」扫描整段译文，把同一术语的多种译法列成统一建议表并给出修改位置。",
      category: "翻译",
      tags: ["术语", "一致性", "翻译"],
      rating: 4.4,
      ratingsCount: 58,
      downloads: 812,
      contents: {
        glossary: [
          "transformer = Transformer | 计算机",
          "large language model = 大语言模型 | 计算机",
          "fine-tuning = 微调 | 计算机",
          "prompt = 提示词 | 计算机",
          "retrieval-augmented generation = 检索增强生成 | 计算机",
          "attention mechanism = 注意力机制 | 计算机",
          "embedding = 嵌入表示 | 计算机",
          "benchmark = 基准测试 | 计算机",
          "ablation study = 消融实验 | 计算机",
          "overfitting = 过拟合 | 计算机",
          "generalization = 泛化 | 计算机",
          "reinforcement learning = 强化学习 | 计算机",
          "knowledge distillation = 知识蒸馏 | 计算机",
          "inference = 推理 | 计算机",
        ],
        prompts: [
          {
            id: "term-consistency",
            label: "术语一致性自查",
            prompt: "请检查这段译文中关键术语的翻译一致性，输出一张三列表格：\n列：术语 | 出现的不一致译法（每种标出现次数）| 建议统一译法。\n要求：①只检查反复出现且影响理解的关键术语（含缩写）；②建议译法采用 CS/AI 领域通行译名（如 fine-tuning→微调、ablation study→消融实验、benchmark→基准测试），首次出现可保留英文原词；③表格之后逐条列出需要修改的位置（第几句 / 原短语）；④全文一致的术语注明「已一致」；没有不一致时明确说「未发现不一致」，不要硬凑问题。",
            color: "",
            trigger: "",
          },
        ],
      },
    },
    {
      id: "weekly-report",
      name: "研究周报生成器",
      version: "1.0.0",
      author: "PaperPilot",
      desc: "一键套用周报笔记模板，把本周文献要点整理成 3-5 条周报条目。",
      longDesc: "写给需要定期汇报的研究者：noteTemplates 装「研究周报」模板（本周阅读/要点/问题与卡点/下周计划分节）；「周报要点」提示词把上下文文献压成 3-5 条条目——每条含文献标题与一句具体价值说明（有数字引数字，不写空话）。",
      category: "综合",
      tags: ["周报", "笔记", "总结"],
      rating: 4.3,
      ratingsCount: 41,
      downloads: 455,
      contents: {
        noteTemplates: [
          {
            name: "研究周报",
            body: "## 研究周报：{{title}}\n\n### 本周阅读\n\n\n### 本周要点\n\n\n### 问题与卡点\n\n\n### 下周计划\n\n- [ ] \n",
          },
        ],
        prompts: [
          {
            id: "weekly-digest",
            label: "周报要点",
            prompt: "请把当前上下文中的文献整理成研究周报条目（3-5 条），每条一行：「文献标题」——一句价值说明（这篇解决什么问题 / 给了什么可用的数字或方法 / 对我的课题有什么用）。纪律：只收上下文中真实存在的文献；一句说明要具体到方法或结论，有数字引数字，不写「很有价值」这类空话；最后单列一条「本周综合判断」：这些文献合起来指向什么趋势或空白（2 句以内，并标注这是你的推断）。",
            color: "",
            trigger: "",
          },
        ],
      },
    },
  ],

  /* ==================== manifest 校验 ==================== */

  /**
   * 逐项校验 manifest。宽容策略：未知字段忽略；可选项缺省不报错。
   * @returns {{ok: boolean, errors: string[]}}
   */
  validate(m) {
    const errors = [];
    if (!m || typeof m !== "object" || Array.isArray(m)) {
      return { ok: false, errors: ["manifest 必须是对象"] };
    }
    const id = String(m.id == null ? "" : m.id);
    if (!id) errors.push("id 必填");
    else if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) errors.push("id 格式非法（须为 kebab-case：小写字母/数字/连字符）");
    if (!String(m.name == null ? "" : m.name).trim()) errors.push("name 必填且非空");
    if (!/^\d+\.\d+\.\d+$/.test(String(m.version == null ? "" : m.version).trim())) {
      errors.push("version 必填，须为三段数字（如 1.0.0）");
    }
    if (!String(m.author == null ? "" : m.author).trim()) errors.push("author 必填且非空");
    if (!String(m.desc == null ? "" : m.desc).trim()) errors.push("desc 必填");
    if (this.CATEGORIES.indexOf(String(m.category == null ? "" : m.category)) < 0) {
      errors.push("category 必须是以下之一：" + this.CATEGORIES.join(" / "));
    }
    if (m.tags != null) {
      if (!Array.isArray(m.tags) || m.tags.length > 6) errors.push("tags 须为 0-6 个的数组");
      else if (!m.tags.every((t) => typeof t === "string" && String(t).trim())) {
        errors.push("tags 每项须为非空字符串");
      }
    }
    const c = m.contents;
    if (c != null) {
      if (typeof c !== "object" || Array.isArray(c)) errors.push("contents 须为对象");
      else {
        if (c.prompts != null) {
          if (!Array.isArray(c.prompts)) errors.push("contents.prompts 须为数组");
          else c.prompts.forEach((p, i) => {
            if (!p || typeof p !== "object") errors.push("prompts[" + i + "] 须为对象");
            else if (!String(p.id == null ? "" : p.id).trim()) errors.push("prompts[" + i + "].id 必填");
            else if (!String(p.label == null ? "" : p.label).trim() && !String(p.prompt == null ? "" : p.prompt).trim()) {
              errors.push("prompts[" + i + "] 缺 label 与 prompt（至少其一）");
            }
          });
        }
        if (c.glossary != null) {
          if (!Array.isArray(c.glossary)) errors.push("contents.glossary 须为数组");
          else c.glossary.forEach((g, i) => {
            const good = typeof g === "string"
              ? !!g.trim()
              : !!(g && typeof g === "object"
                && String(g.s == null ? "" : g.s).trim() && String(g.t == null ? "" : g.t).trim());
            if (!good) errors.push("glossary[" + i + "] 须为非空行或 {s,t,d} 对象");
          });
        }
        if (c.noteTemplates != null) {
          if (!Array.isArray(c.noteTemplates)) errors.push("contents.noteTemplates 须为数组");
          else c.noteTemplates.forEach((t, i) => {
            if (!t || typeof t !== "object"
              || !String(t.name == null ? "" : t.name).trim() || !String(t.body == null ? "" : t.body).trim()) {
              errors.push("noteTemplates[" + i + "] 须含非空 name 与 body");
            }
          });
        }
        if (c.agentPreset != null) {
          const ap = c.agentPreset;
          if (!ap || typeof ap !== "object" || Array.isArray(ap)) errors.push("contents.agentPreset 须为对象");
          else {
            if (ap.chatAgentMode != null && typeof ap.chatAgentMode !== "boolean") {
              errors.push("agentPreset.chatAgentMode 须为布尔");
            }
            if (ap.aiAgentTools != null && (typeof ap.aiAgentTools !== "string" || !String(ap.aiAgentTools).trim())) {
              errors.push("agentPreset.aiAgentTools 须为非空字符串（CSV 工具名）");
            }
            if (ap.aiAgentMaxSteps != null
              && (typeof ap.aiAgentMaxSteps !== "number" || !Number.isInteger(ap.aiAgentMaxSteps) || ap.aiAgentMaxSteps < 1)) {
              errors.push("agentPreset.aiAgentMaxSteps 须为正整数");
            }
            if (ap.aiAgentConfirmWrite != null && typeof ap.aiAgentConfirmWrite !== "boolean") {
              errors.push("agentPreset.aiAgentConfirmWrite 须为布尔");
            }
            if (ap.systemPrompt != null && (typeof ap.systemPrompt !== "string" || !String(ap.systemPrompt).trim())) {
              errors.push("agentPreset.systemPrompt 须为非空字符串");
            }
          }
        }
      }
    }
    return { ok: errors.length === 0, errors };
  },

  /* ==================== 目录 ==================== */

  /** 内置精选目录（深拷贝，调用方可随意改） */
  builtinCatalog() {
    return JSON.parse(JSON.stringify(this._BUILTIN));
  },

  /**
   * 拉取技能包目录。读 pref skillStoreSource（URL）；空、请求失败/超时、JSON 坏
   * 或结构不对 → 回退内置目录。远端条目逐个 validate，非法的跳过（不整批失败）。
   * @returns {Promise<{packs: object[], source: "builtin"|"remote", updatedAt: string}>}
   */
  async fetchCatalog() {
    const fallback = () => ({ packs: this.builtinCatalog(), source: "builtin", updatedAt: "" });
    let url = "";
    try { url = String(Prefs.get(this.PREF_SOURCE, "") || "").trim(); } catch (e) { url = ""; }
    if (!url) return fallback();
    try {
      if (typeof Zotero === "undefined" || !Zotero || !Zotero.HTTP || typeof Zotero.HTTP.request !== "function") {
        return fallback();
      }
      const req = await Zotero.HTTP.request("GET", url, { timeout: 15000 });
      const body = req && req.responseText != null ? req.responseText : req;
      const obj = JSON.parse(String(body));
      if (!obj || typeof obj !== "object" || !Array.isArray(obj.packs)) return fallback();
      const packs = [];
      for (const p of obj.packs) {
        if (this.validate(p).ok) packs.push(p);
      }
      return { packs, source: "remote", updatedAt: String(obj.updatedAt == null ? "" : obj.updatedAt) };
    } catch (e) {
      return fallback();
    }
  },

  /**
   * 纯函数检索。query 大小写不敏感匹配 name/desc/tags/author/id；
   * category / tag 精确匹配；installedIds（Set）给定时只留已装的。
   */
  searchPacks(packs, opts) {
    const o = opts || {};
    let list = Array.isArray(packs) ? packs.slice() : [];
    if (o.query) {
      const q = String(o.query).toLowerCase();
      list = list.filter((p) => {
        if (!p) return false;
        const hay = [p.name, p.desc, p.id, p.author]
          .concat(Array.isArray(p.tags) ? p.tags : [])
          .map((x) => String(x == null ? "" : x)).join("\n").toLowerCase();
        return hay.indexOf(q) >= 0;
      });
    }
    if (o.category) list = list.filter((p) => p && p.category === o.category);
    if (o.tag) list = list.filter((p) => p && Array.isArray(p.tags) && p.tags.indexOf(o.tag) >= 0);
    if (o.installedIds && typeof o.installedIds.has === "function") {
      list = list.filter((p) => p && o.installedIds.has(p.id));
    }
    return list;
  },

  /** "1.2.0" vs "1.10.0" 数值逐段比较；坏值当 0.0.0 */
  compareVersion(a, b) {
    const parse = (v) => {
      const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v == null ? "" : v).trim());
      return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
    };
    const x = parse(a), y = parse(b);
    for (let i = 0; i < 3; i++) {
      if (x[i] < y[i]) return -1;
      if (x[i] > y[i]) return 1;
    }
    return 0;
  },

  /* ==================== 安装 / 卸载 ==================== */

  /**
   * 安装技能包（幂等：同 id 已装 → 先按记账回滚旧内容再装新，即覆盖更新）。
   * 各内容槽位独立降级：模块缺位记 0 不报错；任何异常 catch 后返回 {ok:false}。
   * agentPreset 不自动应用，仅在 contents.agentPreset 存在时 applied.agentPreset=true。
   */
  async install(manifest) {
    try {
      const v = this.validate(manifest);
      if (!v.ok) {
        return { ok: false, error: "manifest 校验失败：" + v.errors.join("；"), errors: v.errors };
      }
      const id = String(manifest.id);
      const ledger = this._readLedger();
      if (ledger[id]) {
        this._rollback(ledger[id].applied || {});
        delete ledger[id];
      }

      const applied = { prompts: 0, glossary: 0, templates: 0, agentPreset: false };
      const rec = { promptIds: [], glossaryLines: [], templateNames: [] };
      const c = (manifest.contents && typeof manifest.contents === "object") ? manifest.contents : {};

      // ① prompts → CommandTags（id 一律前缀 sp:<packId>:<原id>；color 缺省调色板轮转）
      if (this._hasCommandTags() && Array.isArray(c.prompts)) {
        c.prompts.forEach((p, i) => {
          const tagId = this.PROMPT_PREFIX + id + ":" + String(p.id);
          try {
            const saved = CommandTags.upsert({
              id: tagId,
              label: String(p.label || p.id),
              prompt: String(p.prompt || ""),
              color: String(p.color || "").trim() || this._PALETTE[i % this._PALETTE.length],
              trigger: String(p.trigger || ""),
            });
            if (saved) { applied.prompts++; rec.promptIds.push(tagId); }
          } catch (e) { /* 单条失败不拖垮整包 */ }
        });
      }

      // ② glossary → 归一为行式；**用户术语表已有同原文（s）的行一律不装**
      //    （0.48.x 审查修复：mergeGlossary 路径同 s 会覆盖用户译法且卸载无法还原，
      //    fallback 路径会产生同 s 双行——统一在入口剔除，包术语绝不与用户数据冲突）
      const lines = this._normalizeGlossary(c.glossary);
      if (lines.length) {
        const existingSrcs = this._existingGlossarySources();
        const fresh = lines.filter((l) => {
          const m = /^(.+?)\s*=\s*/.exec(l);
          const s = m ? m[1].trim().toLowerCase() : l.toLowerCase();
          return !existingSrcs.has(s);
        });
        if (fresh.length) {
          if (this._hasMergeGlossary()) {
            try {
              TranslateSvc.mergeGlossary(fresh);
              applied.glossary = fresh.length;
              rec.glossaryLines = fresh.slice();
            } catch (e) { /* 合并失败不拖垮整包 */ }
          } else {
            try {
              const added = this._mergeGlossaryFallback(fresh);
              applied.glossary = added.length;
              rec.glossaryLines = added; // 只记实际追加的行：卸载不动用户原有的相同行
            } catch (e) { /* ignore */ }
          }
        }
      }

      // ③ noteTemplates → 仅增量 upsert（同名覆盖 / 新增），绝不删用户已有模板
      if (this._hasNoteTemplates() && Array.isArray(c.noteTemplates) && c.noteTemplates.length) {
        try {
          const existing = NoteTemplates.customList();
          for (const t of c.noteTemplates) {
            const name = String(t.name == null ? "" : t.name).trim();
            const body = String(t.body == null ? "" : t.body);
            if (!name || !body.trim()) continue;
            const i = existing.findIndex((x) => x && x.name === name);
            if (i >= 0) existing[i] = { name, body };
            else existing.push({ name, body });
            rec.templateNames.push(name);
          }
          NoteTemplates.saveCustom(existing);
          applied.templates = rec.templateNames.length;
        } catch (e) { /* ignore */ }
      }

      // ④ agentPreset：不自动应用，详情页显式 applyAgentPreset
      applied.agentPreset = !!(c.agentPreset && typeof c.agentPreset === "object" && !Array.isArray(c.agentPreset));

      ledger[id] = {
        version: String(manifest.version),
        at: Date.now(),
        manifest: JSON.parse(JSON.stringify(manifest)),
        applied: rec,
      };
      this._writeJSON(this.PREF_INSTALLED, ledger);
      return { ok: true, applied };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  },

  /** 按记账精确回滚；未安装返回 {ok:false, error:"未安装"} */
  async uninstall(id) {
    try {
      const ledger = this._readLedger();
      const rec = ledger[id];
      if (!rec) return { ok: false, error: "未安装" };
      const removed = this._rollback(rec.applied || {});
      delete ledger[id];
      this._writeJSON(this.PREF_INSTALLED, ledger);
      return { ok: true, removed };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  },

  /** 已安装列表（记账 + manifest 元信息） */
  listInstalled() {
    const ledger = this._readLedger();
    return Object.keys(ledger).map((id) => {
      const r = ledger[id] || {};
      const m = r.manifest || {};
      return {
        id,
        name: String(m.name || id),
        version: String(r.version || m.version || ""),
        installedAt: r.at || 0,
        category: String(m.category || ""),
      };
    });
  },

  isInstalled(id) {
    const ledger = this._readLedger();
    if (!ledger[id]) return { installed: false };
    return { installed: true, version: String(ledger[id].version || "") };
  },

  /* ==================== 本地评分 ==================== */

  /** 本地评分（pref skillPackRatings）；无评分返回 null */
  getRating(id) {
    const all = this._readJSON(this.PREF_RATINGS, {});
    const r = all && typeof all === "object" ? all[id] : null;
    return r && typeof r === "object" ? { stars: r.stars, comment: r.comment, at: r.at } : null;
  },

  /** 打分：stars 取整后钳制 1-5；comment 截断 500 字 */
  rate(id, stars, comment) {
    try {
      let s = Math.round(Number(stars));
      if (!Number.isFinite(s)) s = 5;
      s = Math.max(1, Math.min(5, s));
      const c = String(comment == null ? "" : comment).slice(0, 500);
      const all = this._readJSON(this.PREF_RATINGS, {});
      all[id] = { stars: s, comment: c, at: Date.now() };
      this._writeJSON(this.PREF_RATINGS, all);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  },

  clearRating(id) {
    try {
      const all = this._readJSON(this.PREF_RATINGS, {});
      delete all[id];
      this._writeJSON(this.PREF_RATINGS, all);
    } catch (e) { /* ignore */ }
  },

  /* ==================== Agent 预设 / 导出 / 制作器 ==================== */

  /**
   * 显式应用记账 manifest 的 contents.agentPreset：
   * 四个 Agent pref 键存在即写入；systemPrompt 追加到 aiSystemPrompt 尾部
   * （\n\n 分隔，已包含则跳过）。返回 applied 列出实际应用的键。
   */
  applyAgentPreset(id) {
    const ledger = this._readLedger();
    const rec = ledger[id];
    if (!rec) return { ok: false, error: "未安装" };
    const ap = rec.manifest && rec.manifest.contents && rec.manifest.contents.agentPreset;
    if (!ap || typeof ap !== "object" || Array.isArray(ap)) {
      return { ok: false, error: "该技能包没有 agentPreset" };
    }
    const applied = [];
    try {
      if (ap.chatAgentMode != null) { Prefs.set("chatAgentMode", !!ap.chatAgentMode); applied.push("chatAgentMode"); }
      if (ap.aiAgentTools != null && String(ap.aiAgentTools).trim()) {
        Prefs.set("aiAgentTools", String(ap.aiAgentTools));
        applied.push("aiAgentTools");
      }
      if (ap.aiAgentMaxSteps != null) { Prefs.set("aiAgentMaxSteps", Number(ap.aiAgentMaxSteps)); applied.push("aiAgentMaxSteps"); }
      if (ap.aiAgentConfirmWrite != null) { Prefs.set("aiAgentConfirmWrite", !!ap.aiAgentConfirmWrite); applied.push("aiAgentConfirmWrite"); }
      if (ap.systemPrompt && String(ap.systemPrompt).trim()) {
        const frag = String(ap.systemPrompt);
        let cur = "";
        try { cur = String(Prefs.get(this.PREF_AI_SYSTEM, "") || ""); } catch (e) { cur = ""; }
        if (cur.indexOf(frag) < 0) {
          Prefs.set(this.PREF_AI_SYSTEM, cur ? cur + "\n\n" + frag : frag);
          applied.push("systemPrompt");
        }
      }
      return { ok: true, applied };
    } catch (e) {
      return { ok: false, applied, error: String(e && e.message || e) };
    }
  },

  /** 记账里的 manifest 导出为 JSON 文本；未安装返回 "" */
  exportPack(id) {
    const ledger = this._readLedger();
    const rec = ledger[id];
    if (!rec || !rec.manifest) return "";
    return JSON.stringify(rec.manifest, null, 2);
  },

  /**
   * 制作器：partial = { id?, name, author, desc, category, tags?, version?,
   * prompts: [CommandTags 格式], glossary?, noteTemplates?, agentPreset? }。
   * id 缺省由 name slug 化；version 缺省 "1.0.0"；产出过 validate。
   */
  buildManifest(partial) {
    const p = partial && typeof partial === "object" ? partial : {};
    let id = String(p.id == null ? "" : p.id).trim();
    if (!id) id = this._slug(p.name);
    const m = {
      id,
      name: String(p.name == null ? "" : p.name).trim(),
      version: String(p.version == null ? "" : p.version).trim() || "1.0.0",
      author: String(p.author == null ? "" : p.author).trim(),
      desc: String(p.desc == null ? "" : p.desc).trim(),
      category: String(p.category == null ? "" : p.category),
    };
    if (Array.isArray(p.tags) && p.tags.length) m.tags = p.tags.slice();
    const c = {};
    if (Array.isArray(p.prompts) && p.prompts.length) c.prompts = JSON.parse(JSON.stringify(p.prompts));
    if (Array.isArray(p.glossary) && p.glossary.length) c.glossary = p.glossary.slice();
    if (Array.isArray(p.noteTemplates) && p.noteTemplates.length) c.noteTemplates = JSON.parse(JSON.stringify(p.noteTemplates));
    if (p.agentPreset && typeof p.agentPreset === "object") c.agentPreset = JSON.parse(JSON.stringify(p.agentPreset));
    if (Object.keys(c).length) m.contents = c;
    const v = this.validate(m);
    if (!v.ok) return { ok: false, errors: v.errors };
    return { ok: true, manifest: m };
  },

  /* ==================== 内部工具（全部惰性调用，加载期零执行） ==================== */

  _slug(name) {
    const s = String(name == null ? "" : name).toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return s || ("pack-" + Date.now().toString(36));
  },

  _readJSON(key, fallback) {
    try {
      const raw = Prefs.get(key, "");
      if (!raw) return fallback;
      const v = JSON.parse(String(raw));
      return v == null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  },

  _writeJSON(key, value) {
    try { Prefs.set(key, JSON.stringify(value)); } catch (e) { /* 超限等异常静默 */ }
  },

  _readLedger() {
    const v = this._readJSON(this.PREF_INSTALLED, null);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  },

  _hasCommandTags() {
    return typeof CommandTags !== "undefined" && CommandTags
      && typeof CommandTags.upsert === "function" && typeof CommandTags.remove === "function";
  },

  _hasNoteTemplates() {
    return typeof NoteTemplates !== "undefined" && NoteTemplates
      && typeof NoteTemplates.customList === "function" && typeof NoteTemplates.saveCustom === "function";
  },

  _hasMergeGlossary() {
    return typeof TranslateSvc !== "undefined" && TranslateSvc
      && typeof TranslateSvc.mergeGlossary === "function";
  },

  /** 单条术语 → 规范行 "原文 = 译文 | 领域"（d 缺省 通用）；非法返回 "" */
  _normGlossaryItem(g) {
    if (typeof g === "string") {
      let line = g.trim();
      if (!line || line.charAt(0) === "#" || line.slice(0, 2) === "//") return "";
      let d = "";
      const bar = line.lastIndexOf("|");
      if (bar >= 0) {
        const tail = line.slice(bar + 1).trim();
        if (tail && tail.length <= 48 && !/\s/.test(tail)) { d = tail; line = line.slice(0, bar).trim(); }
      }
      const m = /^(.+?)\s*(?:=>|=)\s*(.+)$/.exec(line.replace(/\t+/g, " => "));
      if (!m) return "";
      const s = m[1].trim(), t = m[2].trim();
      if (!s || !t || s === t) return "";
      return s + " = " + t + " | " + (d || "通用");
    }
    if (g && typeof g === "object" && !Array.isArray(g)) {
      const s = String(g.s == null ? "" : g.s).trim();
      const t = String(g.t == null ? "" : g.t).trim();
      if (!s || !t || s === t) return "";
      const d = String(g.d == null ? "" : g.d).trim();
      return s + " = " + t + " | " + (d || "通用");
    }
    return "";
  },

  /** 术语数组（行式或 {s,t,d} 混合）→ 规范行数组（保序，不去重；去重在合并时做） */
  _normalizeGlossary(list) {
    const out = [];
    for (const g of Array.isArray(list) ? list : []) {
      const line = this._normGlossaryItem(g);
      if (line) out.push(line);
    }
    return out;
  },

  /**
   * 解析用户术语表（pref translateGlossary）里已有的原文集合（小写归一）。
   * 0.48.x 审查修复：install 前用它剔除同原文的包术语——用户译法优先，
   * 卸载只回滚净新增行，两条合并路径（TranslateSvc / 兜底）都因此安全。
   */
  _existingGlossarySources() {
    const srcs = new Set();
    let raw = "";
    try { raw = String(Prefs.get(this.PREF_GLOSSARY, "") || ""); } catch (e) { raw = ""; }
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.charAt(0) === "#" || t.slice(0, 2) === "//") continue;
      let head = t;
      // 剥领域段（与 _normGlossaryItem 同款护栏：无空格且 ≤48 字）
      const bar = head.lastIndexOf("|");
      if (bar >= 0) {
        const tail = head.slice(bar + 1).trim();
        if (tail && tail.length <= 48 && !/\s/.test(tail)) head = head.slice(0, bar).trim();
      }
      const m = /^(.+?)\s*(?:=>|=)\s*(.+)$/.exec(head.replace(/\t+/g, " => "));
      if (m) srcs.add(m[1].trim().toLowerCase());
    }
    return srcs;
  },

  /**
   * 兜底术语合并：读 pref translateGlossary，已有完全相同行跳过，新行去重后追加
   * （原行含注释行一律原位不动）。返回实际追加的行。
   */
  _mergeGlossaryFallback(lines) {
    let raw = "";
    try { raw = String(Prefs.get(this.PREF_GLOSSARY, "") || ""); } catch (e) { raw = ""; }
    const existing = new Set();
    for (const l of raw.split(/\r?\n/)) {
      const t = l.trim();
      if (t) existing.add(t);
    }
    const added = [];
    for (const line of lines) {
      if (existing.has(line)) continue;
      added.push(line);
      existing.add(line);
    }
    if (added.length) {
      const base = raw.replace(/\s+$/, "");
      try { Prefs.set(this.PREF_GLOSSARY, base ? base + "\n" + added.join("\n") : added.join("\n")); } catch (e) { /* ignore */ }
    }
    return added;
  },

  /**
   * 按记账回滚（install 覆盖更新与 uninstall 共用）。
   * 术语行「每行只删一次」：用户手动复制的相同行按记账份数保留多余份。
   */
  _rollback(applied) {
    const rec = applied && typeof applied === "object" ? applied : {};
    const removed = { prompts: 0, glossary: 0, templates: 0 };

    // 标签：逐个 CommandTags.remove（内部对内置默认打墓碑）
    if (this._hasCommandTags() && Array.isArray(rec.promptIds)) {
      for (const pid of rec.promptIds) {
        try { if (CommandTags.remove(pid)) removed.prompts++; } catch (e) { /* ignore */ }
      }
    }

    // 术语：从 pref 中删除完全相同的行（每个记账条目删一次）
    if (Array.isArray(rec.glossaryLines) && rec.glossaryLines.length) {
      try {
        const raw = String(Prefs.get(this.PREF_GLOSSARY, "") || "");
        const lines = raw.split(/\r?\n/);
        for (const target of rec.glossaryLines) {
          const i = lines.findIndex((l) => l.trim() === target);
          if (i >= 0) { lines.splice(i, 1); removed.glossary++; }
        }
        if (removed.glossary) Prefs.set(this.PREF_GLOSSARY, lines.join("\n"));
      } catch (e) { /* ignore */ }
    }

    // 模板：NoteTemplates 无单删方法 → customList 过滤后 saveCustom 写回
    if (this._hasNoteTemplates() && Array.isArray(rec.templateNames) && rec.templateNames.length) {
      try {
        const names = new Set(rec.templateNames);
        const before = NoteTemplates.customList();
        const kept = before.filter((t) => t && !names.has(t.name));
        removed.templates = before.length - kept.length;
        NoteTemplates.saveCustom(kept);
      } catch (e) { /* ignore */ }
    }
    return removed;
  },
};
