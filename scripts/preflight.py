#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PaperPilot 发版前一键门禁（preflight）。

把仓库里长期分散的验证脚本串成一条命令：任一环节失败即非零退出，
并打印「哪一步失败 + 怎么单独复现」。目的：本仓库长期是**多会话并发**
改同一棵树，preflight 能显著减少「一个会话把另一个改坏而没人发现」。

用法：
    python scripts/preflight.py                # 全量（含浏览器 E2E；无浏览器会自动跳过）
    python scripts/preflight.py --fast         # 只跑确定性的静态/单测，跳过 E2E
    python scripts/preflight.py --with-build 0.24.4
                                               # 追加构建 xpi 并做包内自检

退出码：0 = 全部通过；1 = 有失败项。
环境变量：
    PP_NODE   指定 node 可执行文件（默认取 PATH 上的 node，再退回本机 managed 版本）
"""
import glob
import os
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY = sys.executable

# ---- 定位 node ----
_CANDIDATE_NODE = [
    os.environ.get("PP_NODE") or "",
    shutil.which("node") or "",
    r"C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-5\node.exe",
]
NODE = next((p for p in _CANDIDATE_NODE if p and os.path.exists(p)), None)

GREEN, RED, YELLOW, DIM, RESET = "\033[32m", "\033[31m", "\033[33m", "\033[2m", "\033[0m"
if os.name == "nt" and not os.environ.get("WT_SESSION"):
    # 老控制台可能不支持 ANSI —— 保守起见保留（现代 Windows Terminal / VSCode 均支持）
    pass


def say(msg):
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


def run(argv, timeout=600):
    """执行并返回 (code, output)。输出合并 stdout+stderr。"""
    try:
        p = subprocess.run(argv, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                           timeout=timeout)
        return p.returncode, p.stdout.decode("utf-8", "replace")
    except subprocess.TimeoutExpired:
        return 124, "[超时 %ss] %s" % (timeout, " ".join(argv))
    except FileNotFoundError as e:
        return 127, "[找不到可执行文件] %s" % e


def pick_summary(out):
    """从输出里挑一行最能说明结果的摘要（优先含「通过/失败/问题」的行）。"""
    lines = [l.strip() for l in out.strip().splitlines() if l.strip()]
    for l in reversed(lines):
        if ("通过" in l) or ("失败" in l) or ("问题" in l) or ("跳过" in l):
            return l[:90]
    return lines[-1][:90] if lines else ""


def collect_js():
    pats = [
        os.path.join(ROOT, "bootstrap.js"),
        os.path.join(ROOT, "chrome", "**", "*.js"),
        os.path.join(ROOT, "server", "**", "*.js"),
        os.path.join(ROOT, "test", "**", "*.js"),
        # 0.25.0：tools/（arXiv 工具包）也要过语法 —— 它是插件侧核心的**单一真源**，
        # 生成物在 chrome/ 下已被覆盖，但源文件本身错了会让「生成出一份坏代码」。
        os.path.join(ROOT, "tools", "**", "*.js"),
    ]
    out = set()
    for p in pats:
        out.update(glob.glob(p, recursive=True))
    # 备份目录 / 产物目录不参与
    return sorted(f for f in out if os.sep + "backup" + os.sep not in f)


def step_syntax():
    """全部 JS 的语法检查（node --check）。"""
    files = collect_js()
    bad = []
    for f in files:
        code, out = run([NODE, "--check", f], timeout=60)
        if code != 0:
            bad.append((os.path.relpath(f, ROOT), out.strip()[:200]))
    if bad:
        return False, "%d/%d 个 JS 文件语法错误" % (len(bad), len(files)), bad
    return True, "%d 个 JS 文件语法全部通过" % len(files), None


NODE_SUITES = [
    ("会话持久化", "test/account-persistence.test.js"),
    ("会员域集成", "test/membership.test.js"),
    ("价格表", "test/price.test.js"),
    ("用量趋势", "test/usage.test.js"),
    ("会员面板渲染", "test/membership-panel.test.js"),
    ("运维三件套", "test/server-ops.test.js"),
    ("管理操作审计", "test/audit.test.js"),
    ("永久会员与对账", "test/reconcile.test.js"),
    ("优惠券/折扣码", "test/coupon.test.js"),
    ("登录设备与会话", "test/sessions.test.js"),
    ("套餐 AI 能力", "test/ai-tier.test.js"),
    ("AI 计费单价", "test/pricing.test.js"),
    ("网关计量", "test/metering.test.js"),
    ("余额域", "test/balance.test.js"),
    ("arXiv 核心(插件侧)", "test/arxiv-core.test.js"),
    ("双栏对照窗口", "test/bilingual-view.test.js"),
    ("历史根因探针", "test/legacy-rootcause.probe.js"),
    ("全模块加载冒烟", "test/smoke-load.test.js"),
]


def main(argv):
    fast = "--fast" in argv
    build_ver = None
    if "--with-build" in argv:
        i = argv.index("--with-build")
        build_ver = argv[i + 1] if i + 1 < len(argv) else None
        if not build_ver:
            say("--with-build 需要跟一个版本号，例如 --with-build 0.24.4")
            return 2

    if not NODE:
        say(RED + "✗ 找不到 node（可用 PP_NODE 指定路径）" + RESET)
        return 2

    say("")
    say("PaperPilot preflight  ·  root=%s" % ROOT)
    say("node: %s" % NODE)
    say("模式: %s" % ("fast（跳过浏览器 E2E）" if fast else "full"))
    say("-" * 68)

    results = []   # (名称, ok, 摘要, 详情)

    def record(name, ok, summary, detail=None):
        results.append((name, ok, summary, detail))
        mark = GREEN + "✓" + RESET if ok else RED + "✗" + RESET
        say("%s %-14s %s" % (mark, name, summary))
        if not ok and detail:
            for line in (detail if isinstance(detail, list) else [detail]):
                for sub in str(line).splitlines()[:6]:
                    say("    " + DIM + sub + RESET)

    # 1) 语法
    t0 = time.time()
    ok, summary, detail = step_syntax()
    record("语法检查", ok, summary, detail)

    # 1b) arXiv 核心生成物同步（改了 tools/arxiv/src 却忘了重新生成 → 这里拦住）
    #     必须排在插件侧测试之前：生成物不同步时那套测试测的是旧产物，结论无意义。
    code, out = run([PY, "scripts/build-arxiv-core.py", "--check"], timeout=120)
    record("arXiv 生成物", code == 0, pick_summary(out), None if code == 0 else out)

    # 2) 各测试套件（即便语法步失败也照跑，能给出更具体的报错）
    for label, rel in NODE_SUITES:
        code, out = run([NODE, rel], timeout=600)
        record(label, code == 0, pick_summary(out), None if code == 0 else out)

    # 2b) arXiv 工具包（tools/arxiv/，CLI + 库；离线用例约 20s，与插件共用同一份核心）
    code, out = run([NODE, "tools/arxiv/test/run-all.js"], timeout=600)
    record("arXiv 工具包", code == 0, pick_summary(out), None if code == 0 else out)

    # 3) 接线一致性静态扫描
    code, out = run([PY, "scripts/check-wiring.py"], timeout=300)
    record("接线扫描", code == 0, pick_summary(out), None if code == 0 else out)

    # 4) 浏览器 E2E（可跳过；脚本自身在缺依赖时退出 0）
    if not fast:
        code, out = run([NODE, "test/admin-e2e.test.js"], timeout=600)
        record("后台 E2E", code == 0, pick_summary(out), None if code == 0 else out)
    else:
        results.append(("后台 E2E", True, "（--fast 跳过）", None))
        say("%s %-14s %s" % (YELLOW + "·" + RESET, "后台 E2E", "已跳过（--fast）"))

    # 5) 可选构建
    if build_ver:
        code, out = run([PY, "scripts/build-xpi.py", build_ver], timeout=600)
        record("构建 xpi", code == 0, pick_summary(out), None if code == 0 else out)

    # ---- 汇总 ----
    failed = [r for r in results if not r[1]]
    say("-" * 68)
    say("共 %d 项，通过 %d，失败 %d  ·  耗时 %.1fs"
        % (len(results), len(results) - len(failed), len(failed), time.time() - t0))
    if failed:
        say("")
        say(RED + "失败项：" + RESET)
        for name, _, summary, detail in failed:
            say("  ✗ %s  %s" % (name, summary))
        say("")
        say("单独复现：见上面对应步骤的命令；本脚本 = 这些步骤的顺序串联。")
        return 1
    say(GREEN + "全部通过 —— 可以进入发版流程（git status → 显式 add → tag → push）。" + RESET)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
