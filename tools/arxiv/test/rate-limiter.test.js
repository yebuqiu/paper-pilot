"use strict";

const { test, assert, run } = require("./_harness");
const { RateLimiter, backoffDelay, sleep } = require("../src/rate-limiter");

test("限速：任务按 FIFO 启动，且启动间隔不小于 minIntervalMs", async () => {
  const starts = [];
  const rl = new RateLimiter({ minIntervalMs: 30, maxConcurrent: 4 });
  const tasks = [1, 2, 3, 4].map((n) => rl.run(async () => { starts.push({ n, t: Date.now() }); return n; }));
  const res = await Promise.all(tasks);
  assert.deepStrictEqual(res, [1, 2, 3, 4], "结果顺序应与入队一致");
  assert.strictEqual(starts.length, 4);
  for (let i = 1; i < starts.length; i++) {
    const gap = starts[i].t - starts[i - 1].t;
    assert.ok(gap >= 25, "第 " + (i + 1) + " 个任务间隔仅 " + gap + "ms（应 ≥30）");
  }
});

test("并发：maxConcurrent=1 时不会重叠执行", async () => {
  const rl = new RateLimiter({ minIntervalMs: 0, maxConcurrent: 1 });
  let active = 0;
  let maxActive = 0;
  await Promise.all([1, 2, 3, 4, 5].map(() => rl.run(async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await sleep(5);
    active--;
  })));
  assert.strictEqual(maxActive, 1, "同时运行数应为 1，实际 " + maxActive);
});

test("并发：maxConcurrent=3 时允许最多 3 个同时在跑", async () => {
  const rl = new RateLimiter({ minIntervalMs: 0, maxConcurrent: 3 });
  let active = 0;
  let maxActive = 0;
  await Promise.all(Array.from({ length: 9 }, () => rl.run(async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await sleep(10);
    active--;
  })));
  assert.ok(maxActive <= 3 && maxActive >= 2, "实际峰值 " + maxActive);
});

test("异常：任务抛错只影响自身，不阻断队列", async () => {
  const rl = new RateLimiter({ minIntervalMs: 0, maxConcurrent: 1 });
  const ok = rl.run(async () => "ok");
  const bad = rl.run(async () => { throw new Error("boom"); });
  const after = rl.run(async () => "after");
  assert.strictEqual(await ok, "ok");
  await assert.rejects(() => bad, /boom/);
  assert.strictEqual(await after, "after", "后续任务必须继续执行");
  assert.strictEqual(rl.stats.failed, 1);
  assert.strictEqual(rl.stats.completed, 2);
});

test("同步抛错的函数也被安全包装", async () => {
  const rl = new RateLimiter({ minIntervalMs: 0, maxConcurrent: 1 });
  await assert.rejects(() => rl.run(() => { throw new Error("sync-boom"); }), /sync-boom/);
});

test("drain：等待队列排空", async () => {
  const rl = new RateLimiter({ minIntervalMs: 5, maxConcurrent: 2 });
  const done = [];
  for (let i = 0; i < 4; i++) rl.run(async () => { await sleep(5); done.push(i); });
  await rl.drain();
  assert.strictEqual(done.length, 4);
  assert.strictEqual(rl.pending, 0);
  assert.strictEqual(rl.running, 0);
});

test("统计：入队/启动/完成/等待时长可观测", async () => {
  const rl = new RateLimiter({ minIntervalMs: 10, maxConcurrent: 1 });
  for (let i = 0; i < 3; i++) rl.run(async () => {});
  await rl.drain();
  const s = rl.stats;
  assert.strictEqual(s.enqueued, 3);
  assert.strictEqual(s.started, 3);
  assert.strictEqual(s.completed, 3);
  assert.ok(s.totalWaitMs > 0, "应累计等待时长（限速造成的排队）");
});

test("backoffDelay：全抖动，落在 [0, base*2^(n-1)] 区间内", () => {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const cap = 1000 * Math.pow(2, attempt - 1);
    for (let i = 0; i < 50; i++) {
      const d = backoffDelay(attempt, 1000, 60000);
      assert.ok(d >= 0 && d <= cap, "attempt=" + attempt + " 得到 " + d + "（上限 " + cap + "）");
    }
  }
});

test("backoffDelay：受 maxMs 封顶", () => {
  for (let i = 0; i < 50; i++) {
    assert.ok(backoffDelay(20, 1000, 5000) <= 5000);
  }
});

test("sleep：0/负数立即返回", async () => {
  const t = Date.now();
  await sleep(0);
  await sleep(-5);
  assert.ok(Date.now() - t < 50);
});

run("rate-limiter");
