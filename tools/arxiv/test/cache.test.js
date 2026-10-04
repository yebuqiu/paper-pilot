"use strict";

const fs = require("fs");
const path = require("path");
const { setTimeout: sleep } = require("timers/promises");
const { test, assert, run, tmpDir, rmTemp } = require("./_harness");
const { Cache, StateStore, atomicWrite, humanBytes } = require("../src/cache");

function withTmp(fn) {
  const dir = tmpDir("pp-cache-");
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmTemp(dir));
}

test("Cache：写入后读回（含元信息）", async () => {
  await withTmp(async (dir) => {
    const c = new Cache({ dir, ttlMs: 60000 });
    assert.strictEqual(c.set("k1", { a: 1, b: ["x"] }), true);
    const hit = c.get("k1");
    assert.deepStrictEqual(hit.value, { a: 1, b: ["x"] });
    assert.ok(hit.ageMs >= 0 && hit.ageMs < 5000);
    assert.strictEqual(hit.key, "k1");
  });
});

test("Cache：未命中的 key 返回 null 并计入 miss", async () => {
  await withTmp(async (dir) => {
    const c = new Cache({ dir, ttlMs: 60000 });
    assert.strictEqual(c.get("nope"), null);
    assert.strictEqual(c.stats().misses, 1);
  });
});

test("Cache：TTL 过期后视为未命中并删除文件", async () => {
  await withTmp(async (dir) => {
    const c = new Cache({ dir, ttlMs: 10 });
    c.set("k", { v: 1 });
    await sleep(40);
    assert.strictEqual(c.get("k"), null);
    assert.strictEqual(fs.readdirSync(dir).filter((f) => /^[0-9a-f]{32}\.json$/.test(f)).length, 0, "过期文件应被删除");
  });
});

test("Cache：跨实例持久化（同一目录）", async () => {
  await withTmp(async (dir) => {
    new Cache({ dir, ttlMs: 60000 }).set("shared", { v: 42 });
    const c2 = new Cache({ dir, ttlMs: 60000 });
    assert.strictEqual(c2.get("shared").value.v, 42);
  });
});

test("Cache：命中率统计", async () => {
  await withTmp(async (dir) => {
    const c = new Cache({ dir, ttlMs: 60000 });
    c.set("a", 1);
    c.get("a"); c.get("a"); c.get("b");
    const s = c.stats();
    assert.strictEqual(s.hits, 2);
    assert.strictEqual(s.misses, 1);
    assert.strictEqual(s.writes, 1);
    assert.strictEqual(Math.round(s.hitRate * 100), 67);
  });
});

test("Cache：超过 maxEntries 时按 LRU 淘汰", async () => {
  await withTmp(async (dir) => {
    const c = new Cache({ dir, ttlMs: 60000, maxEntries: 2 });
    c.set("a", 1); await sleep(5);
    c.set("b", 2); await sleep(5);
    c.set("c", 3);   // 触发淘汰
    const files = fs.readdirSync(dir).filter((f) => /^[0-9a-f]{32}\.json$/.test(f));
    assert.strictEqual(files.length, 2, "应淘汰到上限，实际 " + files.length);
    assert.strictEqual(c.get("a"), null, "最旧的 a 应被淘汰");
    assert.ok(c.get("c"));
  });
});

test("Cache：clear 清空内容并重置统计", async () => {
  await withTmp(async (dir) => {
    const c = new Cache({ dir, ttlMs: 60000 });
    c.set("a", 1); c.get("a");
    const r = c.clear();
    assert.ok(r.files >= 1);
    assert.strictEqual(c.stats().entries, 0);
    assert.strictEqual(c.stats().hits, 0);
  });
});

test("Cache：disabled 时 get/set 均为空操作（不落盘）", async () => {
  await withTmp(async (dir) => {
    const c = new Cache({ dir, ttlMs: 60000, enabled: false });
    assert.strictEqual(c.set("a", 1), false);
    assert.strictEqual(c.get("a"), null);
    assert.strictEqual(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 0);
  });
});

test("Cache：目录不可写时降级而不抛错（缓存是纯优化）", async () => {
  const badDir = path.join(tmpDir("pp-cache-"), "nested", "conflict");
  const rm = path.dirname(badDir);
  // 用「同名文件占住目录位置」制造 mkdir 失败
  fs.writeFileSync(badDir.replace(/[\\/][^\\/]+$/, ""), "x");
  try {
    const c = new Cache({ dir: badDir, ttlMs: 60000 });
    assert.strictEqual(c.set("k", 1), false, "写入失败应返回 false");
    assert.strictEqual(c.get("k"), null);
    assert.doesNotThrow(() => c.stats());
  } finally {
    rmTemp(path.dirname(rm));
  }
});

test("atomicWrite：写临时文件再改名，不留残片", async () => {
  await withTmp(async (dir) => {
    const f = path.join(dir, "x.json");
    atomicWrite(f, JSON.stringify({ ok: 1 }));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, "utf8")), { ok: 1 });
    assert.strictEqual(fs.readdirSync(dir).filter((n) => n.indexOf(".tmp") >= 0).length, 0);
  });
});

test("humanBytes 友好格式", () => {
  assert.strictEqual(humanBytes(512), "512 B");
  assert.strictEqual(humanBytes(2048), "2.0 KB");
  assert.strictEqual(humanBytes(3 * 1048576), "3.0 MB");
});

/* ---------------------------- StateStore ---------------------------- */

test("StateStore：markSeen / seenIds / touch / lastRunAt", async () => {
  await withTmp(async (dir) => {
    const st = new StateStore({ dir });
    assert.strictEqual(st.lastRunAt("q1"), "");
    st.markSeen("q1", ["2501.00001@1", "2501.00002@1"]);
    assert.strictEqual(st.seenIds("q1").size, 2);
    const t = st.touch("q1");
    assert.ok(t);
    assert.strictEqual(st.lastRunAt("q1"), t);
    assert.strictEqual(st.runs("q1"), 1);
    assert.strictEqual(st.save(), true);
    // 新实例读回
    const st2 = new StateStore({ dir });
    assert.strictEqual(st2.seenIds("q1").size, 2);
    assert.strictEqual(st2.runs("q1"), 1);
  });
});

test("StateStore：seenIds 去重且受 maxSeen 限制（保留最新）", async () => {
  await withTmp(async (dir) => {
    const st = new StateStore({ dir, maxSeen: 3 });
    st.markSeen("q", ["a", "b", "c", "d", "e"]);
    const ids = Array.from(st.seenIds("q"));
    assert.strictEqual(ids.length, 3);
    assert.deepStrictEqual(ids, ["c", "d", "e"]);
    st.markSeen("q", ["c"]);   // 重复不应增长
    assert.strictEqual(st.seenIds("q").size, 3);
  });
});

test("StateStore：不同查询源互不干扰，reset 可单独清", async () => {
  await withTmp(async (dir) => {
    const st = new StateStore({ dir });
    st.markSeen("q1", ["a"]);
    st.markSeen("q2", ["b"]);
    assert.strictEqual(st.seenIds("q1").size, 1);
    st.reset("q1");
    assert.strictEqual(st.seenIds("q1").size, 0);
    assert.strictEqual(st.seenIds("q2").size, 1);
    st.reset();
    assert.strictEqual(st.seenIds("q2").size, 0);
  });
});

run("cache");
