// 生成物：由 scripts/build-module.py --all 自动生成，请勿手改。
// 用途：瘦身包缺少组件时，为这些全局装惰性占位，避免 init 里裸引用 ReferenceError。
var ModuleGlobals = [
  {
    "id": "papilot-mod-pdf",
    "globals": [
      "OcrService",
      "PdfCompare",
      "PdfDual",
      "PdfExport",
      "PdfInline",
      "PdfTheme"
    ],
    "name": "PDF 对照与 OCR"
  },
  {
    "id": "papilot-mod-ai",
    "globals": [
      "Account",
      "AgentTools",
      "AutoTag",
      "Channels",
      "AIChat",
      "AIClient",
      "CommandTags",
      "GlossaryPacks",
      "Matrix",
      "PdfText",
      "Prompts",
      "AIProviders",
      "S2Client",
      "SlashCommands",
      "TranslateCrypto",
      "TranslateEngines",
      "TranslateFormula",
      "TranslateGlossary",
      "TranslateLang",
      "TranslateX",
      "TranslateSvc",
      "AgentMemory",
      "ChatSessions",
      "AIChatPane",
      "ChatFloat",
      "GlancePane",
      "RefPane",
      "TranslatePane"
    ],
    "name": "AI 问答与翻译"
  },
  {
    "id": "papilot-mod-cnki",
    "globals": [
      "CNAI",
      "CNFetch",
      "CNVerify",
      "CNAuth",
      "CNMeta",
      "CNTranslators"
    ],
    "name": "知网与中文文献"
  },
  {
    "id": "papilot-mod-discovery",
    "globals": [
      "ArxivAnalyze",
      "STOPWORDS",
      "SECTION_LABELS",
      "LABEL_LOOKUP",
      "LABEL_ALT",
      "ArxivAtom",
      "ArxivCategories",
      "RAW",
      "ALL",
      "BY_CODE",
      "ArxivDates",
      "ArxivErrors",
      "EXIT",
      "ArxivFetch",
      "ArxivQuery",
      "FIELDS",
      "FIELD_LABELS",
      "ArxivRateLimiter",
      "JournalCatalog",
      "Discovery",
      "LibSearch",
      "SearchSubs"
    ],
    "name": "检索订阅与发现"
  },
  {
    "id": "papilot-mod-notes",
    "globals": [
      "AnkiExport",
      "AnnotationDigest",
      "Annotations",
      "MindMap",
      "NoteGraph",
      "NoteTemplates",
      "NoteTools",
      "ObsidianExport"
    ],
    "name": "笔记与知识图谱"
  },
  {
    "id": "papilot-mod-meta",
    "globals": [
      "AttachDoctor",
      "AttachManager",
      "CollectionStats",
      "FakeCheck",
      "LibGraph",
      "MetaDoctor",
      "MetaEnrich",
      "MetaLint",
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
      "CiteExport",
      "RefFormat",
      "RefImport",
      "RefSources"
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
      "BilingualTranslate",
      "Hotkeys",
      "SkillPacks",
      "TagMenu",
      "TagOps",
      "ThemeToggle",
      "ColumnViews",
      "ToolbarQuick",
      "UiTheme"
    ],
    "name": "界面与工具窗口"
  }
];
