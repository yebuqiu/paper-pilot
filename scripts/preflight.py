#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 Cassiuschen. All rights reserved.

# -*- coding: utf-8 -*-
"""Papilot 发版前一键门禁（preflight）。

把仓库里长期分散的验证脚本串成一条命令：任一环节失败即非零退出，
并打印「哪一步失败 + 怎么单独复现」。目的：本仓库长期是**多会话并发**
改同一棵树，preflight 能显著减少「一个会话把另一个改坏而没人发现」。

用法：
    python scripts/preflight.py                # 全量（含浏览器 E2E；无浏览器会自动跳过）
    python scripts/preflight.py --fast         # 只跑确定性的静态/单测，跳过 E2E（汇总会标注「跳过」）
    python scripts/preflight.py --strict       # 不允许跳过：跳过项按失败处理（CI 用）
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
    ("浮窗会话存档", "test/chat-sessions.test.js"),
    ("定时任务", "test/scheduler.test.js"),
    ("MCP 工具桥", "test/mcp.test.js"),
    ("长期记忆", "test/agent-memory.test.js"),
    ("相关文献", "test/related-papers.test.js"),
    ("引文上下文", "test/citation-context.test.js"),
    ("元数据医生", "test/meta-doctor.test.js"),
    ("标注速记", "test/annotation-digest.test.js"),
    ("检索订阅", "test/search-subs.test.js"),
    ("订阅多源适配", "test/sub-sources.test.js"),
    ("订阅面板渲染", "test/prefs-subs.test.js"),
    ("综述工作台", "test/review-workbench.test.js"),
    ("会员域集成", "test/membership.test.js"),
    ("价格表", "test/price.test.js"),
    ("用量趋势", "test/usage.test.js"),
    ("会员面板渲染", "test/membership-panel.test.js"),
    ("统一设计令牌", "test/ui-tokens.test.js"),
    ("运维三件套", "test/server-ops.test.js"),
    ("服务端规模与索引", "test/server-scale.test.js"),
    ("管理面来源校验", "test/admin-origin.test.js"),
    ("存储损坏维护模式", "test/store-corrupt.test.js"),
    ("资金履约原子性", "test/pay-atomic.test.js"),
    ("余额预留（并发透支）", "test/balance-hold.test.js"),
    ("余额预留审计", "test/balance-hold-audit.test.js"),
    ("网关断开处理", "test/gateway-abort.test.js"),
    ("管理操作审计", "test/audit.test.js"),
    ("密钥托管", "test/secret-host.test.js"),
    ("迁移提示包", "test/migration-notice.test.js"),
    ("永久会员与对账", "test/reconcile.test.js"),
    ("优惠券/折扣码", "test/coupon.test.js"),
    ("登录设备与会话", "test/sessions.test.js"),
    ("套餐 AI 能力", "test/ai-tier.test.js"),
    ("AI 计费单价", "test/pricing.test.js"),
    ("网关计量", "test/metering.test.js"),
    ("官方通道401判别", "test/ai-auth-failure.test.js"),
    ("余额域", "test/balance.test.js"),
    ("在线支付", "test/pay.test.js"),
    ("arXiv 核心(插件侧)", "test/arxiv-core.test.js"),
    ("双栏对照窗口", "test/bilingual-view.test.js"),
    ("多引擎翻译", "test/translate.test.js"),
    ("PDF 文本分析", "test/pdf-text.test.js"),
    ("PDF 页内叠加内核", "test/pdf-inline.test.js"),
    ("PDF 左原右译窗口", "test/pdf-dual.test.js"),
    ("对照翻译导出", "test/pdf-export.test.js"),
    ("更新提示", "test/update-notice.test.js"),
    ("翻译设置面板", "test/prefs-translate.test.js"),
    ("设置折叠分组", "test/prefs-fold.test.js"),
    ("pref 命名空间", "test/pref-namespace.test.js"),
    ("顶部快捷按钮", "test/toolbar-quick.test.js"),
    ("阅读器翻译面板", "test/translate-pane.test.js"),
    ("AI 问答悬浮窗", "test/chat-float.test.js"),
    ("分屏问答窗口流式", "test/chat-window-stream.test.js"),
    ("菜单注册表", "test/menu-registry.test.js"),
    ("参考文献入库", "test/ref-import.test.js"),
    ("Sci-Hub 补全文", "test/scihub-fetch.test.js"),
    ("中文文献AI增强", "test/cn-ai.test.js"),
    ("知网账号登录", "test/cn-auth.test.js"),
    ("第三方文献源(实验)", "test/third-source.test.js"),
    ("期刊分区列门控", "test/rank-gate.test.js"),
    ("#命令标签", "test/chat-tags.test.js"),
    ("Agent工具层", "test/agent-tools.test.js"),
    ("技能包核心域", "test/skill-packs.test.js"),
    ("技能包商店窗口", "test/skill-store.test.js"),
    ("快捷键注册表", "test/hotkeys.test.js"),
    ("参考文献面板", "test/ref-pane.test.js"),
    ("划词拼接与批注标记", "test/reader-popup-concat.test.js"),
    ("新数据列与译文写回", "test/columns-extra.test.js"),
    ("阅读进度与进度条", "test/reading-progress.test.js"),
    ("模板与自动化扩展", "test/templates-automation.test.js"),
    ("原生全文resolver", "test/fulltext-resolver.test.js"),
    ("翻译多引擎对比", "test/translate-compare.test.js"),
    ("嵌套标签树", "test/tag-nested.test.js"),
    ("AI 打标签 v2", "test/auto-tag.test.js"),
    ("拖拽条目上下文", "test/chat-drag-context.test.js"),
    ("列视图组", "test/column-views.test.js"),
    # 0.56.0 坚果云云同步：协议层 + 三向决策 + 密钥边界 + 端到端（内存 WebDAV）
    ("坚果云云同步", "test/cloud-sync.test.js"),
    # 0.63.0 笔记工具（A2）：大纲幂等 + 批量标签/分类/前缀/合并（原笔记保留）
    ("笔记工具(大纲/批量)", "test/note-tools.test.js"),
    # 0.63.0 PDF 无头渲染 + 视觉 OCR：纯函数 + 侧车读写 + 问答回退契约
    ("OCR(渲染/侧车/回退)", "test/ocr.test.js"),
    ("笔记工具(独立验收)", "test/note-tools-qa.test.js"),
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

    if fast and "--strict" in argv:
        say(RED + "✗ --strict 与 --fast 互斥：fast 必然跳过浏览器 E2E，strict 不允许跳过。" + RESET)
        return 2

    if not NODE:
        say(RED + "✗ 找不到 node（可用 PP_NODE 指定路径）" + RESET)
        return 2

    say("")
    say("Papilot preflight  ·  root=%s" % ROOT)
    say("node: %s" % NODE)
    say("模式: %s" % ("fast（跳过浏览器 E2E）" if fast else "full"))
    say("-" * 68)

    # 0.65.1：结果改**三态**（pass / skip / fail）。
    # ★ 原实现把「脚本自己跳过」和「真的通过」都记成 ok=True：
    #   后台 E2E 缺 playwright-core 时 admin-e2e 自己 exit 0，--fast 下更是直接 append True，
    #   于是 153 条管理面断言可能长期没跑，门禁却永远是绿的。跳过必须能被看见。
    results = []   # (名称, 状态, 摘要, 详情)；状态 ∈ "pass" / "skip" / "fail"

    def record(name, ok, summary, detail=None, skipped=False):
        state = "skip" if skipped else ("pass" if ok else "fail")
        results.append((name, state, summary, detail))
        mark = {"pass": GREEN + "✓" + RESET,
                "skip": YELLOW + "·" + RESET,
                "fail": RED + "✗" + RESET}[state]
        say("%s %-14s %s" % (mark, name, summary))
        if state == "fail" and detail:
            for line in (detail if isinstance(detail, list) else [detail]):
                for sub in str(line).splitlines()[:6]:
                    say("    " + DIM + sub + RESET)

    # 1) 语法
    t0 = time.time()
    ok, summary, detail = step_syntax()
    record("语法检查", ok, summary, detail)

    # 1a) 文档版本与真源一致（manifest 的 version / 服务端头注释 → AGENTS · README badge）
    #     为什么进门禁：版本号是手工抄的，已经漂过两次（AGENTS 停在 0.58.0、README badge 停在 0.63.0）。
    code, out = run([PY, "scripts/sync-docs-version.py", "--check"], timeout=60)
    record("文档版本", code == 0, pick_summary(out), None if code == 0 else out)

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

    # 0.48.1：技能包在线目录与内置目录同构（漂移 = 改了 _BUILTIN 忘跑生成器）
    code, out = run([NODE, "scripts/build-skill-catalog.js", "--check"], timeout=60)
    record("技能包目录同构", code == 0, pick_summary(out), None if code == 0 else out)

    # 4) 浏览器 E2E（脚本缺依赖时会自行跳过并 exit 0 → 这里识别为「跳过」，不记通过）
    if not fast:
        code, out = run([NODE, "test/admin-e2e.test.js"], timeout=600)
        _e2e_skip = (code == 0) and ("跳过" in out or "SKIPPED" in out)
        record("后台 E2E", (code == 0) and not _e2e_skip, pick_summary(out),
               None if code == 0 else out, skipped=_e2e_skip)
    else:
        record("后台 E2E", True, "（--fast 跳过，未执行）", None, skipped=True)

    # 5) 可选构建
    if build_ver:
        code, out = run([PY, "scripts/build-xpi.py", build_ver], timeout=600)
        record("构建 xpi", code == 0, pick_summary(out), None if code == 0 else out)

    # ---- 汇总（三态 + --strict） ----
    strict = "--strict" in argv
    failed = [r for r in results if r[1] == "fail"]
    skipped = [r for r in results if r[1] == "skip"]
    passed = [r for r in results if r[1] == "pass"]
    say("-" * 68)
    say("共 %d 项，通过 %d，跳过 %d，失败 %d  ·  耗时 %.1fs"
        % (len(results), len(passed), len(skipped), len(failed), time.time() - t0))
    if skipped:
        say("")
        say(YELLOW + "跳过项（不计入通过）：" + RESET)
        for name, _, summary, _ in skipped:
            say("  · %s  %s" % (name, summary))
        say("  发布前请在装有浏览器的环境跑一次全量（去掉 --fast）；CI 用 --strict 让跳过直接失败。")
    if failed:
        say("")
        say(RED + "失败项：" + RESET)
        for name, _, summary, detail in failed:
            say("  ✗ %s  %s" % (name, summary))
        say("")
        say("单独复现：见上面对应步骤的命令；本脚本 = 这些步骤的顺序串联。")
        return 1
    if strict and skipped:
        say("")
        say(RED + "--strict：存在跳过项，按失败处理（%d 项）" % len(skipped))
        return 1
    if skipped:
        say(YELLOW + "其余全部通过 —— 但上面有 %d 项被跳过，不等于全绿。" % len(skipped) + RESET)
        return 0
    say(GREEN + "全部通过 —— 可以进入发版流程（git status → 显式 add → tag → push）。" + RESET)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
