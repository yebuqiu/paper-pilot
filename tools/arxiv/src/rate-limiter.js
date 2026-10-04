"use strict";

/**
 * 限速与并发控制。
 *
 * 语义（比常见实现更严格，因为 arXiv 的礼节是「跨所有机器、3 秒 1 次」）：
 *   - 任务按入队顺序 **FIFO** 启动；
 *   - 任意两次「任务启动」之间的间隔 ≥ minIntervalMs（无论并发度多少）；
 *   - 同时运行的任务数 ≤ maxConcurrent。
 *
 * 与「信号量」的区别：信号量只控并发数，控制不了启动频率；arXiv 要的是频率。
 */

class RateLimiter {
  /**
   * @param {{minIntervalMs?:number, maxConcurrent?:number, now?:()=>number, setTimer?:Function, clearTimer?:Function, onStart?:Function}} [opts]
   */
  constructor(opts) {
    const o = opts || {};
    this.minIntervalMs = Math.max(0, Number(o.minIntervalMs) || 0);
    this.maxConcurrent = o.maxConcurrent == null ? Infinity : Math.max(1, Number(o.maxConcurrent) || 1);
    this._now = o.now || (() => Date.now());
    this._setTimer = o.setTimer || setTimeout;
    this._clearTimer = o.clearTimer || clearTimeout;
    this._onStart = o.onStart || null;
    this._queue = [];
    this._running = 0;
    this._nextSlot = 0;
    this._stats = { enqueued: 0, started: 0, completed: 0, failed: 0, totalWaitMs: 0 };
  }

  /**
   * 排队执行一个返回 Promise 的函数。
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  run(fn) {
    return new Promise((resolve, reject) => {
      this._queue.push({ fn, resolve, reject, enqueuedAt: this._now(), timer: null });
      this._stats.enqueued++;
      this._pump();
    });
  }

  /** 队列排空 + 全部完成后 resolve。 */
  drain() {
    if (!this._queue.length && this._running === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const tick = () => {
        if (!this._queue.length && this._running === 0) resolve();
        else this._setTimer(tick, 10);
      };
      this._setTimer(tick, 10);
    });
  }
  get pending() { return this._queue.length; }
  get running() { return this._running; }
  get stats() { return Object.assign({ pending: this._queue.length, running: this._running }, this._stats); }

  _pump() {
    while (this._queue.length && this._running < this.maxConcurrent) {
      const now = this._now();
      const startAt = Math.max(now, this._nextSlot);
      // 预占下一个启动时刻：即使本次是「延迟启动」，也要把后续任务的时刻排开
      this._nextSlot = startAt + this.minIntervalMs;
      const item = this._queue.shift();
      this._running++;
      const delay = startAt - now;
      if (delay <= 0) {
        this._start(item);
      } else {
        // ⚠️ 这里**不能 unref**：调用方通常是 `await limiter.run(...)`，若计时器被 unref，
        // 当事进程除了这个计时器没有其它 handle 时会**直接退出**，await 永远不 resolve
        // ——表现为「脚本无任何输出、退出码 0」这种最难查的静默失败（实测踩过）。
        item.timer = this._setTimer(() => { item.timer = null; this._start(item); }, delay);
      }
    }
  }

  _start(item) {
    this._stats.started++;
    this._stats.totalWaitMs += this._now() - item.enqueuedAt;
    if (this._onStart) { try { this._onStart(item); } catch (e) { /* ignore */ } }
    let p;
    try { p = item.fn(); }
    catch (e) { p = Promise.reject(e); }
    Promise.resolve(p).then(
      (v) => { this._stats.completed++; this._running--; item.resolve(v); this._pump(); },
      (e) => { this._stats.failed++; this._running--; item.reject(e); this._pump(); }
    );
  }
}

/** Promise 版 sleep。计时器保持 referenced（同 RateLimiter 的理由，不可 unref）。 */
function sleep(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 指数退避 + 全抖动（full jitter）。
 * 全抖动比「固定退避」更能打散多进程同时重试造成的尖峰。
 * @param {number} attempt 从 1 开始
 */
function backoffDelay(attempt, baseMs, maxMs) {
  const base = Math.max(0, baseMs == null ? 1000 : baseMs);
  const cap = Math.max(base, maxMs == null ? 30000 : maxMs);
  const exp = Math.min(cap, base * Math.pow(2, Math.max(0, attempt - 1)));
  return Math.floor(Math.random() * exp);
}

module.exports = { RateLimiter, sleep, backoffDelay };
