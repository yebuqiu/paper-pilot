// 生成物：由 scripts/build-module.py --all 自动生成，请勿手改。
// 用途：瘦身包缺少组件时，为这些全局装惰性占位，避免 init 里裸引用 ReferenceError。
var ModuleGlobals = [
  {
    "id": "papilot-mod-pdf",
    "globals": [
      "PdfCompare",
      "OcrService",
      "PdfTheme",
      "PdfInline",
      "PdfDual",
      "PdfExport"
    ],
    "name": "PDF 对照与 OCR"
  },
  {
    "id": "papilot-mod-ai",
    "globals": [
      "AIProviders",
      "Account",
      "Channels",
      "AIClient",
      "PdfText",
      "TranslateLang",
      "TranslateCrypto",
      "TranslateGlossary",
      "TranslateFormula",
      "TranslateEngines",
      "TranslateSvc",
      "GlossaryPacks",
      "TranslateX",
      "AIChat",
      "Prompts",
      "AgentTools",
      "CommandTags",
      "SlashCommands",
      "AutoTag",
      "Matrix",
      "S2Client",
      "AgentMemory",
      "AIChatPane",
      "GlancePane",
      "TranslatePane",
      "RefPane",
      "ChatSessions",
      "ChatFloat"
    ],
    "name": "AI 问答与翻译"
  },
  {
    "id": "papilot-mod-cnki",
    "globals": [
      "CNMeta",
      "CNTranslators",
      "CNAI",
      "CNFetch",
      "CNVerify",
      "CNAuth"
    ],
    "name": "知网与中文文献"
  },
  {
    "id": "papilot-mod-discovery",
    "globals": [
      "LibSearch",
      "JournalCatalog",
      "SearchSubs",
      "ArxivErrors",
      "EXIT",
      "ArxivDates",
      "ArxivQuery",
      "FIELDS",
      "FIELD_LABELS",
      "ArxivCategories",
      "RAW",
      "ALL",
      "BY_CODE",
      "ArxivAtom",
      "ArxivAnalyze",
      "STOPWORDS",
      "SECTION_LABELS",
      "LABEL_LOOKUP",
      "LABEL_ALT",
      "ArxivRateLimiter",
      "ArxivFetch",
      "Discovery"
    ],
    "name": "检索订阅与发现"
  },
  {
    "id": "papilot-mod-notes",
    "globals": [
      "Annotations",
      "AnnotationDigest",
      "ObsidianExport",
      "NoteTemplates",
      "NoteTools",
      "MindMap",
      "AnkiExport",
      "NoteGraph"
    ],
    "name": "笔记与知识图谱"
  },
  {
    "id": "papilot-mod-meta",
    "globals": [
      "CollectionStats",
      "FakeCheck",
      "MetaEnrich",
      "AttachManager",
      "MetaLint",
      "MetaDoctor",
      "LibGraph",
      "AttachDoctor",
      "MetaRules"
    ],
    "name": "元数据与文库健康"
  },
  {
    "id": "papilot-mod-cite",
    "globals": [
      "CC_TERMS",
      "CC_EXACT",
      "CC_GROUPS",
      "CC_RANK",
      "CitationContext",
      "CitationTrace",
      "RefFormat",
      "RefSources",
      "RefImport",
      "CiteExport"
    ],
    "name": "引用与写作"
  },
  {
    "id": "papilot-mod-sync",
    "globals": [
      "WebDAV",
      "CloudSync",
      "CredVault"
    ],
    "name": "云同步与凭据"
  },
  {
    "id": "papilot-mod-ui",
    "globals": [
      "SkillPacks",
      "BilingualTranslate",
      "TagOps",
      "TagMenu",
      "UiTheme",
      "ThemeToggle",
      "ColumnViews",
      "ToolbarQuick",
      "Hotkeys"
    ],
    "name": "界面与工具窗口"
  }
];
