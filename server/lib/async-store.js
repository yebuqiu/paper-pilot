// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Cassiuschen. All rights reserved.

/* Papilot · JsonStore 异步合并写（服务端 1.8.5，审查 P1-4）
 *
 * 问题：users.json 的计量路径（每次成功的 AI 调用都 countUsage → save）走的是
 *   「JSON.stringify 全量 + writeFileSync + fsync + renameSync」的**同步**全量写。
 *   单进程单事件循环下，1000 用户 ≈ 6MB/次、30–60ms 的同步 IO 会把整个服务卡住，
 *   控制台 health 的 maxLagMs 曾因此冲到 2.6s。
 *
 * 做法（单飞 + 合并窗口）：
 *   · saveSoon(delayMs)：只打一个合并窗口定时器（默认 800ms，**不因后续请求顺延**，
 *     所以最坏延迟有上界）。窗口内 N 次调用只会落盘 1 次，且落的是「最后一次」快照
 *     ——快照在真正开写那一刻才序列化，期间的内存改动自然被带上。
 *   · 同一时刻最多一个在途写（writing 标志）；期间又有新改动 → dirty=true，
 *     等这次写完立刻串行补写，绝不并发开第二个写。
 *   · 异步写（fs.promises）用独立 tmp 名（.async-*.tmp），不与管理路径的同步 save()
 *     共用 .tmp，避免互相踩临时文件。
 *   · 写失败（EBUSY/EPERM/ENOSPC）记日志，1s 后重试一次；仍失败则保持 dirty，
 *     下一次 saveSoon/flush 再试 —— 不静默吞掉。
 *   · flush()：同步落盘（沿用 JsonStore.save 的 tmp+fsync+rename 语义）。
 *     停机/SIGINT 走它，保证「窗口内未落盘的计量与扣费」一起写进磁盘。
 *   · invalidate()：外部要改写/重载该文件（备份回滚、测试改盘）时调用，
 *     丢弃未落盘快照；在途写完成时发现代际变化也会丢弃，避免旧快照覆盖新数据。
 *
 * ★ 一致性取舍（资金口径，必须明说）：
 *   balance.consume() 只改内存，随后的 countUsage() 用本模块的合并窗口落盘，
 *   两者在**同一次快照**里落盘（不存在「扣了钱但没记用量」或反过来的中间态）。
 *   但若进程在窗口内（默认 ≤800ms）**硬崩溃/断电**，这一窗口内的用量与扣费会一起丢：
 *   方向是「少收钱」，不是「多收钱」，且下次调用会继续正常计量。
 *   进程正常退出（SIGINT/SIGTERM → shutdown）会先 flush() 再退出，不丢。
 *   其它资金路径（充值/核销/管理调账）仍走同步 save()，语义不变。
 */
'use strict';

const fs = require('fs');

const fsp = fs.promises;

/** 默认合并窗口（毫秒）：可用 PP_USAGE_SAVE_DELAY_MS 覆盖（测试用） */
function defaultDelayMs() {
  const n = Number(process.env.PP_USAGE_SAVE_DELAY_MS);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 60000) : 800;
}

/**
 * 为一个 JsonStore 实例创建异步合并写入器。
 * @param {object} store  JsonStore 实例（需有 file / data / save / loadFailed）
 * @param {object} opts   { delayMs, log, label }
 */
function createAsyncWriter(store, opts) {
  const o = opts || {};
  const log = typeof o.log === 'function' ? o.log : ((...a) => console.error(...a));
  const label = o.label || 'store';
  const baseDelay = Number.isFinite(o.delayMs) && o.delayMs >= 0 ? o.delayMs : defaultDelayMs();

  let timer = null;        // 合并窗口定时器
  let retryTimer = null;   // 失败后的 1s 重试
  let writing = false;     // 是否有在途异步写（单飞）
  let dirty = false;       // 自上次快照后是否有新改动
  let retryUsed = false;   // 本轮失败是否已重试过（避免无限重试）
  let closed = false;
  let gen = 0;             // 写代际：同步 save / flush / invalidate 都会 +1

  // 统计（测试注入断言用）
  const stats = { writes: 0, flushes: 0, coalesced: 0, failures: 0, discards: 0, skips: 0 };

  /* 接管同步 save：任何外部同步落盘都推进代际，让在途异步快照作废（防旧覆盖新）。
   * 只包一层计数，不改 JsonStore.save 的任何行为（loadFailed 时照旧抛错）。 */
  const origSave = store.save.bind(store);
  store.save = function saveWithGen() {
    gen += 1;
    return origSave();
  };

  function canWrite() {
    if (store.loadFailed) {
      stats.skips += 1;
      log('[' + label + '] 加载失败维护模式，跳过异步写（数据不会被默认值覆盖）');
      return false;
    }
    return true;
  }

  /** 真正执行一次写入（单飞）。快照在开写时序列化，因此总是最新数据。 */
  async function run() {
    if (writing || closed || !dirty) return;
    if (!canWrite()) { dirty = false; return; }
    writing = true;
    dirty = false;
    const myGen = gen;
    const tmp = store.file + '.async-' + process.pid + '.tmp';
    try {
      const text = JSON.stringify(store.data, null, 2);
      const fh = await fsp.open(tmp, 'w');
      try {
        await fh.writeFile(text, 'utf8');
        try { await fh.sync(); } catch (_) { /* 部分文件系统不支持 fsync，退化为普通写 */ }
      } finally {
        try { await fh.close(); } catch (_) { /* ignore */ }
      }
      if (gen !== myGen) {
        // 期间发生了同步落盘/失效：本次快照已过时，丢弃，重新排队
        stats.discards += 1;
        dirty = true;
        try { await fsp.unlink(tmp); } catch (_) { /* ignore */ }
      } else {
        await fsp.rename(tmp, store.file);   // 原子替换：读者只看到旧文件或新文件
        stats.writes += 1;
        retryUsed = false;
      }
    } catch (e) {
      stats.failures += 1;
      dirty = true;
      const code = (e && (e.code || e.message)) || 'unknown';
      if (retryUsed) {
        log('[' + label + '] 异步写重试仍失败（' + code + '），保持待写状态，下次再试');
        retryUsed = false;                    // 交出一次重试名额，允许下一轮再试
      } else {
        log('[' + label + '] 异步写失败（' + code + '），1s 后重试一次');
        retryUsed = true;
        scheduleRetry();
      }
      try { await fsp.unlink(tmp); } catch (_) { /* ignore */ }
    } finally {
      writing = false;
      // 写期间又有新改动：立刻串行补写（不额外等窗口，避免延迟叠加）
      if (dirty && !closed && !timer && !retryTimer) {
        timer = setTimeout(() => { timer = null; run(); }, 0);
        if (timer.unref) timer.unref();
      }
    }
  }

  function scheduleRetry() {
    if (retryTimer || closed) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      run();
    }, 1000);
    if (retryTimer.unref) retryTimer.unref();
  }

  /** 排一次「稍后落盘」。已有窗口/在途写时只标 dirty，不重复开写。 */
  function saveSoon(delayMs) {
    if (closed) return false;
    dirty = true;
    if (writing) { stats.coalesced += 1; return false; }
    if (timer) { stats.coalesced += 1; return false; }
    const ms = Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : baseDelay;
    timer = setTimeout(() => { timer = null; run(); }, ms);
    if (timer.unref) timer.unref();
    return true;
  }

  /** 同步落盘：取消防抖/重试，立刻把当前内存写入磁盘（停机/测试读盘前用）。 */
  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (!canWrite()) return false;
    // 推进代际：任何在途异步写都会在 rename 前发现自己过时而丢弃
    gen += 1;
    origSave();
    dirty = false;
    stats.flushes += 1;
    return true;
  }

  /** 外部改写/重载该文件前调用：丢弃未落盘快照（在途写也会被代际检查丢弃）。 */
  function invalidate() {
    gen += 1;
    dirty = false;
    if (timer) { clearTimeout(timer); timer = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  }

  function close() {
    closed = true;
    if (timer) { clearTimeout(timer); timer = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  }

  function statsOf() {
    return Object.assign({}, stats, { pending: dirty, writing, delayMs: baseDelay });
  }

  return { store, saveSoon, flush, invalidate, close, stats: statsOf };
}

module.exports = { createAsyncWriter, defaultDelayMs };
