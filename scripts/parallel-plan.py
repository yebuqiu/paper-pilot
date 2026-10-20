# -*- coding: utf-8 -*-
"""B2/B3 并行编排校验器（读取 docs/parallel/tasks.json）。

它解决的问题：多条工作线同时改同一个仓库时，真正的事故不是「慢」，而是
①两个人改了同一个文件（后提交的把前面的覆盖/冲突）、②共享汇合文件（manifest / pref 默认值 /
  接线守卫 / 产物清单）被并发写、③依赖没做完就开工（B2.1 拿不到 ui-kit 的类名）。

校验四件事：
  1. DAG 合法：id 唯一、依赖都存在、无环；
  2. 波次一致：声明的 wave 必须等于「最长依赖路径 + 1」（防止把有依赖的任务塞进同一波）；
  3. 同波次文件零交集（含 glob；`dist/*` 视为目录前缀）；
  4. 共享汇合文件只归 INTEGRATE（其余任务写即报错）。

用法：
  python scripts/parallel-plan.py            # 打印执行计划（波次 / 任务 / 文件 / 依赖）
  python scripts/parallel-plan.py --check    # 只校验，有违规 exit 1（门禁/开工前用）
  python scripts/parallel-plan.py --ready    # 列出「依赖都已完成」的可开工任务
  python scripts/parallel-plan.py --wave 2   # 只看某一波
"""
import fnmatch
import io
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REG = os.path.join(ROOT, "docs", "parallel", "tasks.json")

problems = []
notes = []


def norm(p):
    return p.replace("\\", "/").strip()


def load():
    if not os.path.exists(REG):
        sys.exit("找不到 %s" % REG)
    with io.open(REG, encoding="utf-8") as f:
        return json.load(f)


def overlap(a, b):
    """两个文件模式是否可能指向同一路径（精确 / 双向 glob / 目录前缀）。"""
    a, b = norm(a), norm(b)
    if a == b:
        return True
    if fnmatch.fnmatch(a, b) or fnmatch.fnmatch(b, a):
        return True
    # 目录前缀：`dist/*` 与 `dist/x.xpi`
    for x, y in ((a, b), (b, a)):
        if x.endswith("/*") and y.startswith(x[:-1]):
            return True
        if x.endswith("/") and y.startswith(x):
            return True
    return False


def main(argv):
    data = load()
    tasks = data.get("tasks") or []
    rules = data.get("rules") or {}
    exclusive = [norm(x) for x in (rules.get("exclusiveFiles") or [])]

    by_id = {}
    for t in tasks:
        tid = t.get("id")
        if not tid:
            problems.append("有任务缺 id")
            continue
        if tid in by_id:
            problems.append("任务 id 重复：%s" % tid)
        by_id[tid] = t
        t["files"] = [norm(x) for x in (t.get("files") or [])]
        t.setdefault("deps", [])
        t.setdefault("status", "pending")

    # ---- 1. 依赖存在 + 无环 + 计算波次 ----
    for tid, t in by_id.items():
        for d in t["deps"]:
            if d not in by_id:
                problems.append("%s 依赖不存在的任务 %s" % (tid, d))

    wave_cache = {}

    def wave_of(tid, stack=()):
        if tid in wave_cache:
            return wave_cache[tid]
        if tid in stack:
            problems.append("依赖成环：%s" % " → ".join(stack + (tid,)))
            return 1
        deps = [d for d in by_id[tid]["deps"] if d in by_id]
        w = 1 if not deps else 1 + max(wave_of(d, stack + (tid,)) for d in deps)
        wave_cache[tid] = w
        return w

    for tid, t in by_id.items():
        calc = wave_of(tid)
        if t.get("wave") != calc:
            problems.append("%s 声明 wave=%s，但依赖关系要求 wave=%s"
                            % (tid, t.get("wave"), calc))

    # ---- 2. 共享汇合文件只归 INTEGRATE ----
    for tid, t in by_id.items():
        if tid == "INTEGRATE":
            continue
        for f in t["files"]:
            for ex in exclusive:
                if overlap(f, ex):
                    problems.append("%s 触碰共享汇合文件 %s（只允许 INTEGRATE 写）" % (tid, f))

    # ---- 3. 同波次文件零交集 ----
    waves = {}
    for tid, t in by_id.items():
        waves.setdefault(wave_of(tid), []).append(t)
    for w, ts in sorted(waves.items()):
        for i in range(len(ts)):
            for j in range(i + 1, len(ts)):
                a, b = ts[i], ts[j]
                for fa in a["files"]:
                    for fb in b["files"]:
                        if overlap(fa, fb):
                            problems.append("wave %d 内文件冲突：%s ↔ %s（%s / %s）"
                                            % (w, fa, fb, a["id"], b["id"]))

    # ---- 输出 ----
    only = None
    if "--wave" in argv:
        i = argv.index("--wave")
        only = int(argv[i + 1]) if i + 1 < len(argv) else None

    if "--ready" in argv:
        done = {t.get("id") for t in tasks if t.get("status") == "completed"}
        ready = [t for t in tasks
                 if t.get("status") != "completed" and all(d in done for d in t["deps"])]
        print("可开工（依赖已完成）：")
        for t in sorted(ready, key=lambda x: wave_of(x["id"])):
            print("  wave %d  %-9s %s" % (wave_of(t["id"]), t["id"], t["title"]))
        if not ready:
            print("  （无：要么还有依赖未完成，要么全部完成）")
        return 1 if problems else 0

    print("B2/B3 并行执行计划  ·  登记表 docs/parallel/tasks.json")
    print("-" * 78)
    for w in sorted(waves):
        if only and w != only:
            continue
        print("wave %d： %s" % (w, " ｜ ".join(t["id"] for t in sorted(waves[w], key=lambda x: x["id"]))))
        for t in sorted(waves[w], key=lambda x: x["id"]):
            flag = "  ⚠ " + t["externalBlock"] if t.get("externalBlock") else ""
            print("  %-9s %-46s %s" % (t["id"], t["title"][:46], t["est"]))
            print("            deps=%s  status=%s" % (",".join(t["deps"]) or "-", t.get("status")))
            for f in t["files"]:
                print("            · " + f)
            if flag:
                print(flag)
        print("")

    if problems:
        print("=" * 78)
        print("✗ %d 处违规：" % len(problems))
        for p in problems:
            print("  - " + p)
        return 1
    print("=" * 78)
    print("✓ 计划合法：DAG 无环 · 波次一致 · 同波次文件零交集 · 汇合文件归属正确")
    if notes:
        for n in notes:
            print("· " + n)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
