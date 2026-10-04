"use strict";

/**
 * 统一错误体系。
 *
 * 设计目标：调用方（CLI / 插件 / 上层脚本）不需要解析错误文案就能决定行为——
 * 靠 `err.code` 分类、`err.retryable` 决定是否重试、`err.status` 透出 HTTP 状态。
 * 全部错误都继承自 ArxivError，便于 `catch (e) { if (e instanceof ArxivError) ... }`。
 */

/** 进程退出码字典（CLI 与调用方共用，避免各处硬编码数字）。 */
const EXIT = {
  OK: 0,
  GENERIC: 1,
  USAGE: 2,
  NETWORK: 3,
  PARSE: 4,
  CONFIG: 5,
  API: 6,
};

class ArxivError extends Error {
  /**
   * @param {string} message 面向人的错误说明（中文）
   * @param {string} code 机器可读错误码
   * @param {{retryable?:boolean, status?:number, cause?:Error, hint?:string, details?:object}} [opts]
   */
  constructor(message, code, opts) {
    super(message);
    this.name = this.constructor.name;
    this.code = code || "ARXIV_ERROR";
    this.retryable = !!(opts && opts.retryable);
    if (opts && opts.status != null) this.status = opts.status;
    if (opts && opts.hint) this.hint = opts.hint;
    if (opts && opts.details) this.details = opts.details;
    if (opts && opts.cause) this.cause = opts.cause;
    if (Error.captureStackTrace) Error.captureStackTrace(this, this.constructor);
  }

  /** 单行摘要，供日志与 CLI 首行输出。 */
  toLine() {
    let s = this.message;
    if (this.hint) s += "（建议：" + this.hint + "）";
    return s;
  }
}

/** 配置非法：字段类型/取值越界、配置文件不存在或 JSON 损坏。 */
class ConfigError extends ArxivError {
  constructor(message, opts) { super(message, "CONFIG_ERROR", opts); }
}

/** 命令行用法错误：未知选项、缺少必填参数、子命令不存在。 */
class UsageError extends ArxivError {
  constructor(message, opts) { super(message, "USAGE_ERROR", opts); }
}

/** 底层网络失败：DNS、连接重置、TLS。可重试。 */
class NetworkError extends ArxivError {
  constructor(message, opts) { super(message, "NETWORK_ERROR", Object.assign({ retryable: true }, opts)); }
}

/** 应用层超时（自建计时器，不依赖 socket 超时）。可重试。 */
class TimeoutError extends ArxivError {
  constructor(message, opts) { super(message, "TIMEOUT", Object.assign({ retryable: true }, opts)); }
}

/** HTTP 状态非 2xx。4xx（除 429）默认不可重试，5xx 与 429 可重试。 */
class HttpError extends ArxivError {
  constructor(message, status, opts) {
    const retryable = status === 429 || status === 408 || (status >= 500 && status <= 599);
    super(message, "HTTP_ERROR", Object.assign({ status, retryable }, opts));
  }
}

/** 触发限速（HTTP 429 / 503 且带 Retry-After）。可重试，且应显著退避。 */
class RateLimitError extends ArxivError {
  constructor(message, opts) {
    super(message, "RATE_LIMIT", Object.assign({ retryable: true }, opts));
  }
}

/** Atom/XML 解析失败或缺关键字段。不可重试（内容已拿到但不可用）。 */
class ParseError extends ArxivError {
  constructor(message, opts) { super(message, "PARSE_ERROR", opts); }
}

/** arXiv 明确返回的业务错误（新版后端对畸形查询返回 400 + Atom error entry）。不可重试。 */
class ApiError extends ArxivError {
  constructor(message, opts) { super(message, "API_ERROR", opts); }
}

/** 缓存层错误（磁盘不可写等）。刻意设计为**不影响主流程**：调用方应吞掉并降级。 */
class CacheError extends ArxivError {
  constructor(message, opts) { super(message, "CACHE_ERROR", opts); }
}

/** 错误 → 退出码。 */
function exitCodeFor(err) {
  if (!err) return EXIT.OK;
  switch (err.code) {
    case "USAGE_ERROR": return EXIT.USAGE;
    case "CONFIG_ERROR": return EXIT.CONFIG;
    case "NETWORK_ERROR":
    case "TIMEOUT":
    case "HTTP_ERROR":
    case "RATE_LIMIT": return EXIT.NETWORK;
    case "PARSE_ERROR": return EXIT.PARSE;
    case "API_ERROR": return EXIT.API;
    default: return EXIT.GENERIC;
  }
}

module.exports = {
  EXIT,
  ArxivError,
  ConfigError,
  UsageError,
  NetworkError,
  TimeoutError,
  HttpError,
  RateLimitError,
  ParseError,
  ApiError,
  CacheError,
  exitCodeFor,
};
