/**
 * PaperPilot arXiv 工具包 · 类型声明
 *
 * 实现是 CommonJS / JavaScript，这里用 `.d.ts` 给 IDE 与 TS 调用方提供
 * 「清晰的类型定义」——尤其是 ArxivEntry / SearchSpec / Config 这三个到处流转的结构。
 */

declare namespace arxiv {
  /* -------------------------------- 配置 -------------------------------- */

  interface ApiConfig {
    baseUrl: string;
    absBaseUrl: string;
    userAgent: string;
  }

  interface RequestConfig {
    timeoutMs: number;
    retries: number;
    backoffBaseMs: number;
    backoffMaxMs: number;
    /** 两次请求最小间隔（毫秒）。arXiv 礼节要求 ≥ 3000。 */
    minIntervalMs: number;
    maxConcurrent: number;
  }

  interface SearchConfig {
    pageSize: number;
    maxResults: number;
    maxPages: number;
    sortBy: SortBy;
    sortOrder: SortOrder;
  }

  interface CacheConfig {
    enabled: boolean;
    dir: string;
    ttlMs: number;
    maxEntries: number;
  }

  interface OutputConfig {
    format: OutputFormat;
    out: string | null;
    report: string | null;
    pretty: boolean;
    maxEntries: number;
    maxAbstract: number;
  }

  interface LogConfig { level: LogLevel; json: boolean }

  interface ClusterConfig { enabled: boolean; k: number; maxTerms: number }

  interface AnalyzeConfig {
    highlight: boolean;
    highlightTerms: string[];
    highlightMark: string;
    structuredAbstract: boolean;
    stats: boolean;
    cluster: ClusterConfig;
  }

  interface EnrichConfig {
    versionHistory: boolean;
    references: boolean;
    citations: boolean;
    s2BaseUrl: string;
    s2MinIntervalMs: number;
  }

  interface DedupeConfig { byId: boolean; byDoi: boolean; byTitle: boolean }

  interface Config {
    api: ApiConfig;
    request: RequestConfig;
    search: SearchConfig;
    cache: CacheConfig;
    output: OutputConfig;
    log: LogConfig;
    analyze: AnalyzeConfig;
    enrich: EnrichConfig;
    dedupe: DedupeConfig;
    /** 记录配置来源（loadConfig 注入） */
    __meta?: { configPath: string | null };
  }

  type SortBy = "relevance" | "lastUpdatedDate" | "submittedDate";
  type SortOrder = "ascending" | "descending";
  type OutputFormat = "md" | "json" | "jsonl" | "csv" | "bibtex" | "table" | "url";
  type LogLevel = "silent" | "error" | "warn" | "info" | "debug";
  type BooleanOp = "AND" | "OR";

  /* -------------------------------- 检索 -------------------------------- */

  interface SearchSpec {
    /** 原始查询串，与其它条件以 AND 组合 */
    raw?: string;
    /** 关键词；可带字段前缀，如 `ti:attention` */
    keywords?: string | string[];
    authors?: string | string[];
    categories?: string | string[];
    /** arXiv ID（走 id_list 参数） */
    ids?: string | string[];
    doi?: string;
    journalRef?: string;
    excludeCategories?: string | string[];
    excludeKeywords?: string | string[];
    /** 起始日期：2025 / 2025-01 / 2025-01-31 / 2025-01-31T12:30 */
    dateFrom?: string;
    dateTo?: string;
    dateField?: "submittedDate" | "lastUpdatedDate";
    boolean?: BooleanOp;
    /** 关键词强制按精确短语处理（加引号） */
    phrase?: boolean;
  }

  interface SearchOptions {
    limit?: number;
    pageSize?: number;
    maxPages?: number;
    sortBy?: SortBy;
    sortOrder?: SortOrder;
    cache?: boolean;
    refresh?: boolean;
    cacheTtlMs?: number;
    retries?: number;
  }

  /* -------------------------------- 条目 -------------------------------- */

  interface Author {
    name: string;
    affiliations: string[];
  }

  interface LinkInfo { rel: string; type: string; title: string; href: string }

  interface VersionInfo {
    version: number;
    /** 原始日期文本（如 `Mon, 2 Oct 2026 12:00:00 UTC`） */
    date: string;
    /** ISO 字符串；解析失败为空串 */
    iso: string;
    sizeKb: number | null;
  }

  interface VersionHistory {
    ok: boolean;
    arxivId: string;
    versions: VersionInfo[];
    count: number;
    latest: number;
    reason?: string;
  }

  interface ReferenceItem {
    title: string;
    authors: string[];
    year: number | null;
    venue: string;
    publicationDate: string;
    doi: string;
    arxivId: string;
    s2Id: string;
    citationCount: number;
  }

  interface ArxivEntry {
    /** 不含版本号的 arXiv ID，如 `2501.00001` */
    arxivId: string;
    baseId: string;
    version: number;
    versionTag: string;
    idUrl: string;
    title: string;
    /** 压平空白后的摘要 */
    summary: string;
    /** 保留段落换行的摘要 */
    summaryRaw: string;
    summaryParagraphs: string[];
    authors: string[];
    authorsDetailed: Author[];
    authorText: string;
    published: string;
    updated: string;
    publishedDay: string;
    updatedDay: string;
    categories: string[];
    primaryCategory: string;
    archive: string;
    doi: string;
    journalRef: string;
    comment: string;
    license: string;
    absUrl: string;
    pdfUrl: string;
    links: { abs: string; pdf: string; doi: string; other: LinkInfo[] };
    /* 分析阶段附加 */
    titleHighlighted?: string;
    summaryHighlighted?: string;
    highlightMarks?: number;
    highlightHits?: Array<{ term: string; count: number }>;
    /* 增强阶段附加 */
    versionHistory?: VersionHistory;
    versionCount?: number;
    references?: ReferenceItem[];
    referenceCount?: number | null;
    referencesError?: string;
    citations?: ReferenceItem[];
    citationCount?: number | null;
    citationsError?: string;
  }

  interface DuplicateInfo { kept: string; dropped: string; reason: string }

  interface SearchResult {
    query: string;
    encodedQuery: string;
    idList: string;
    url: string;
    sortBy: SortBy;
    sortOrder: SortOrder;
    totalResults: number;
    fetched: number;
    pages: number;
    duplicatesRemoved: number;
    duplicates: DuplicateInfo[];
    entries: ArxivEntry[];
    generatedAt: string;
    fromCache: boolean;
    elapsedMs: number;
    cacheAgeMs?: number;
    analysis?: Analysis;
  }

  interface GetByIdsResult {
    requested: number;
    totalResults: number;
    fetched: number;
    pages: number;
    duplicatesRemoved: number;
    /** 请求了但 arXiv 未返回的 ID */
    missing: string[];
    entries: ArxivEntry[];
    generatedAt: string;
    elapsedMs: number;
  }

  interface UpdateResult {
    sourceKey: string;
    firstRun: boolean;
    since: string;
    scanned: number;
    scannedPages: number;
    stoppedEarly: boolean;
    newCount: number;
    entries: ArxivEntry[];
    query: string;
    generatedAt: string;
    elapsedMs: number;
  }

  /* -------------------------------- 分析 -------------------------------- */

  interface HighlightOpts {
    mark?: string;
    caseSensitive?: boolean;
    wholeWord?: boolean;
    maxMarks?: number;
  }

  interface HighlightResult {
    text: string;
    marks: number;
    hits: Array<{ term: string; count: number }>;
  }

  interface AbstractSection { key: string; label: string; text: string }

  interface StructuredAbstract {
    structured: boolean;
    sections: AbstractSection[];
    text: string;
    preamble?: string;
  }

  interface CategoryRow { name: string; count: number; share: number }

  interface CategoryStats {
    total: number;
    distinctCategories: number;
    byCategory: CategoryRow[];
    byPrimary: CategoryRow[];
    byArchive: CategoryRow[];
    coOccurrence: Array<{ pair: string; count: number }>;
  }

  interface KeywordRow { term: string; tf: number; df: number; idf: number; score: number }

  interface Cluster {
    id: number;
    size: number;
    topTerms: string[];
    entryIds: string[];
    titles: string[];
  }

  interface ClusterResult {
    k: number;
    iterations: number;
    clusters: Cluster[];
    unclustered: number;
  }

  interface Analysis {
    total: number;
    entries: ArxivEntry[];
    highlightTerms?: string[];
    structured?: Array<{ arxivId: string; structured: boolean; sections: AbstractSection[]; preamble: string }>;
    structuredCount?: number;
    categories?: CategoryStats;
    histogram: Array<{ bucket: string; count: number }>;
    keywords: KeywordRow[];
    clusters?: ClusterResult;
  }

  /* -------------------------------- 客户端 -------------------------------- */

  interface ClientOptions {
    config?: Config;
    /** 便于测试：不落盘、不读配置文件的部分覆盖项 */
    configOverrides?: Partial<Config>;
    env?: Record<string, string | undefined>;
    cwd?: string;
    configPath?: string;
    /** 注入传输函数（默认 Node 原生 http/https） */
    transport?: (url: string, opts?: { timeoutMs?: number; headers?: Record<string, string> }) => Promise<TransportResponse>;
    logger?: Logger;
    cache?: Cache | null;
    state?: StateStore | null;
    limiter?: RateLimiter;
    sleep?: (ms: number) => Promise<void>;
    backoff?: (attempt: number) => number;
    now?: () => number;
  }

  interface TransportResponse {
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
    url: string;
    redirects?: string[];
  }

  interface ClientStats {
    requests: number;
    cacheHits: number;
    limiter: Record<string, number>;
    cache: Record<string, unknown>;
    state: Record<string, unknown>;
  }

  interface Logger {
    level: LogLevel;
    json: boolean;
    isDebug: boolean;
    error(msg: string, ctx?: Record<string, unknown>): void;
    warn(msg: string, ctx?: Record<string, unknown>): void;
    info(msg: string, ctx?: Record<string, unknown>): void;
    debug(msg: string, ctx?: Record<string, unknown>): void;
    child(baseCtx: Record<string, unknown>): Logger;
  }

  interface Cache {
    get(key: string): { value: unknown; fetchedAt: string; ageMs: number; expiresAt: string; key: string } | null;
    set(key: string, value: unknown, opts?: { ttlMs?: number }): boolean;
    del(key: string): boolean;
    prune(): { expired: number; evicted: number };
    stats(): Record<string, unknown>;
    clear(): { files: number };
  }

  interface StateStore {
    seenIds(key: string): Set<string>;
    lastRunAt(key: string): string;
    runs(key: string): number;
    markSeen(key: string, ids: string[]): number;
    touch(key: string): string;
    reset(key?: string): boolean;
    summary(): Record<string, unknown>;
  }

  interface RateLimiter {
    run<T>(fn: () => Promise<T>): Promise<T>;
    drain(): Promise<void>;
    readonly pending: number;
    readonly running: number;
    readonly stats: Record<string, number>;
  }

  class ArxivClient {
    constructor(opts?: ClientOptions);
    readonly config: Config;
    readonly requestCount: number;
    stats(): ClientStats;
    urlFor(params: Record<string, unknown>): string;
    search(spec: SearchSpec, opts?: SearchOptions): Promise<SearchResult>;
    searchRaw(rawQuery: string, opts?: SearchOptions): Promise<SearchResult>;
    streamSearch(spec: SearchSpec, opts?: SearchOptions): AsyncGenerator<{ page: number; start: number; totalResults: number; entries: ArxivEntry[]; url: string }>;
    getByIds(ids: string | string[], opts?: { batchSize?: number; retries?: number; cache?: boolean; refresh?: boolean }): Promise<GetByIdsResult>;
    update(spec: SearchSpec, opts?: SearchOptions & { sourceKey?: string }): Promise<UpdateResult>;
    enrich(entries: ArxivEntry[], opts?: { versions?: boolean; references?: boolean; citations?: boolean; limit?: number }): Promise<ArxivEntry[]>;
    probe(): Promise<{ ok: boolean; status: number; totalResults: number; sample: ArxivEntry | null; url: string }>;
  }

  /* -------------------------------- 错误 -------------------------------- */

  class ArxivError extends Error {
    code: string;
    retryable: boolean;
    status?: number;
    hint?: string;
    details?: Record<string, unknown>;
    toLine(): string;
  }
  class ConfigError extends ArxivError {}
  class UsageError extends ArxivError {}
  class NetworkError extends ArxivError {}
  class TimeoutError extends ArxivError {}
  class HttpError extends ArxivError {}
  class RateLimitError extends ArxivError {}
  class ParseError extends ArxivError {}
  class ApiError extends ArxivError {}
  class CacheError extends ArxivError {}

  const EXIT: {
    OK: 0; GENERIC: 1; USAGE: 2; NETWORK: 3; PARSE: 4; CONFIG: 5; API: 6;
  };
  function exitCodeFor(err: unknown): number;

  /* -------------------------------- 函数 -------------------------------- */

  function loadConfig(opts?: { cli?: Record<string, unknown>; env?: Record<string, string | undefined>; cwd?: string; configPath?: string }): Config;
  function createClient(opts?: ClientOptions): ArxivClient;
  function createLogger(opts?: { level?: LogLevel; json?: boolean }): Logger;
  function nullLogger(): Logger;

  function buildQuery(spec: SearchSpec): { query: string; encoded: string; idList: string; isEmpty: boolean; parts: string[] };
  function buildUrl(params: Record<string, unknown>): string;
  function parseAtom(xml: string): { entries: ArxivEntry[]; meta: Record<string, unknown> };
  function dedupeEntries(entries: ArxivEntry[], opts?: DedupeConfig): { entries: ArxivEntry[]; removed: number; duplicates: DuplicateInfo[] };
  function highlight(text: string, terms: string[], opts?: HighlightOpts): HighlightResult;
  function splitStructuredAbstract(input: string | string[]): StructuredAbstract;
  function categoryStats(entries: ArxivEntry[]): CategoryStats;
  function dateHistogram(entries: ArxivEntry[], opts?: { bucket?: "day" | "month" | "year"; field?: "published" | "updated" }): Array<{ bucket: string; count: number }>;
  function extractKeywords(entries: ArxivEntry[], opts?: { topN?: number; minDf?: number }): KeywordRow[];
  function clusterTopics(entries: ArxivEntry[], opts?: { k?: number; maxTerms?: number; seed?: number }): ClusterResult;
  function analyze(entries: ArxivEntry[], opts?: Record<string, unknown>): Analysis;

  function toJSON(data: unknown, opts?: { pretty?: boolean }): string;
  function toJSONL(data: unknown): string;
  function toCSV(data: unknown, opts?: { bom?: boolean; crlf?: boolean; delimiter?: string; columns?: string[] }): string;
  function toBibTeX(data: unknown, opts?: { keyPrefix?: string; includeAbstract?: boolean }): string;
  function toMarkdown(result: SearchResult, opts?: Record<string, unknown>): string;
  function toTerminal(result: SearchResult, opts?: Record<string, unknown>): string;

  function fetchVersionHistory(arxivId: string, opts: { transport: Function }): Promise<VersionHistory>;
  function fetchReferences(arxivId: string, opts: { transport: Function }): Promise<{ ok: boolean; items: ReferenceItem[]; reason?: string }>;
  function fetchCitations(arxivId: string, opts: { transport: Function }): Promise<{ ok: boolean; items: ReferenceItem[]; reason?: string }>;

  function listCategories(): Array<{ code: string; name: string; archive: string }>;
  function groupCategories(): Record<string, Array<{ code: string; name: string; archive: string }>>;
  function validateCategory(code: string): { ok: boolean; known: boolean; shape: boolean };
  function suggestCategory(code: string, limit?: number): Array<{ code: string; name: string; distance: number }>;
}

export = arxiv;
