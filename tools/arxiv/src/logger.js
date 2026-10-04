"use strict";

/**
 * 极简分级日志。零依赖，不引入第三方 logger。
 *
 * 两种形态：
 *   - 人类可读（默认）：`[info] 拉取第 2 页  start=100 total=3490`
 *   - 机器可读（--log-json）：每行一个 JSON，便于被上层脚本/管道消费
 *
 * 纪律：日志一律写 **stderr**，stdout 只留给最终结果（结构化输出 / 报告），
 * 这样 `arxiv search -f json > out.json` 不会被日志污染。
 */

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

const COLORS = { error: "\u001b[31m", warn: "\u001b[33m", info: "\u001b[36m", debug: "\u001b[90m" };
const RESET = "\u001b[0m";

function levelValue(name) {
  const v = LEVELS[String(name || "").toLowerCase()];
  return v == null ? LEVELS.info : v;
}

function isLevel(name) {
  return Object.prototype.hasOwnProperty.call(LEVELS, String(name || "").toLowerCase());
}

/**
 * @param {{level?:string, json?:boolean, stream?:NodeJS.WritableStream, color?:boolean, now?:()=>Date}} [opts]
 */
function createLogger(opts) {
  const o = opts || {};
  const levelName = isLevel(o.level) ? String(o.level).toLowerCase() : "info";
  const max = levelValue(levelName);
  const json = !!o.json;
  const stream = o.stream || process.stderr;
  const now = o.now || (() => new Date());
  const color = o.color != null ? !!o.color : !!(stream && stream.isTTY);

  function stringify(v) {
    if (v == null) return String(v);
    if (typeof v === "object") {
      try { return JSON.stringify(v); } catch (e) { return String(v); }
    }
    return String(v);
  }

  function emit(level, msg, ctx) {
    if (LEVELS[level] > max) return;
    const ts = now().toISOString();
    if (json) {
      const rec = { ts, level, msg: String(msg) };
      if (ctx) for (const k of Object.keys(ctx)) rec[k] = ctx[k];
      try { stream.write(JSON.stringify(rec) + "\n"); } catch (e) { /* 日志失败不得影响主流程 */ }
      return;
    }
    const tag = color ? (COLORS[level] || "") + "[" + level + "]" + RESET : "[" + level + "]";
    let line = tag + " " + msg;
    if (ctx && Object.keys(ctx).length) {
      const parts = [];
      for (const k of Object.keys(ctx)) parts.push(k + "=" + stringify(ctx[k]));
      if (parts.length) line += "  " + parts.join(" ");
    }
    try { stream.write(line + "\n"); } catch (e) { /* ignore */ }
  }

  return {
    level: levelName,
    json,
    isDebug: max >= LEVELS.debug,
    error: (m, c) => emit("error", m, c),
    warn: (m, c) => emit("warn", m, c),
    info: (m, c) => emit("info", m, c),
    debug: (m, c) => emit("debug", m, c),
    /** 派生子 logger：固定附加上下文字段（如 stage/query）。 */
    child(baseCtx) {
      const base = baseCtx || {};
      return {
        level: levelName,
        json,
        isDebug: max >= LEVELS.debug,
        error: (m, c) => emit("error", m, Object.assign({}, base, c)),
        warn: (m, c) => emit("warn", m, Object.assign({}, base, c)),
        info: (m, c) => emit("info", m, Object.assign({}, base, c)),
        debug: (m, c) => emit("debug", m, Object.assign({}, base, c)),
      };
    },
  };
}

/** 静默 logger，供测试与库内调用默认使用。 */
function nullLogger() {
  const noop = () => {};
  return { level: "silent", json: false, isDebug: false, error: noop, warn: noop, info: noop, debug: noop, child: () => nullLogger() };
}

module.exports = { createLogger, nullLogger, LEVELS, isLevel, levelValue };
