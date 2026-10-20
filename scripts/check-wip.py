# -*- coding: utf-8 -*-
"""构建前并发在制品检查：别把别人没写完的文件打进用户包。

背景（2026-10-20 实踩）：构建 0.66.0 时，另一个并行会话正在 `chrome/content/`
下写 `ui-kit.css`，`build-xpi.py` 按目录遍历、无法排除单文件，于是它被顺带打进了
dist 包。功能上无害（未被任何窗口引用），但「把别人的半成品发给用户」这件事本身
不该靠人盯。

做法：`build-xpi.py` 的打包范围 = 顶层文件 + `chrome/` + `locale/`。
这里取出 `chrome/` 下**未被 git 跟踪**的文件（= 只可能来自本地在制品或新功能），
逐条报告 mtime，并可用 `--pack <xpi>` 检查它是否已经在某个包里。

用法：
  python scripts/check-wip.py                      # 只列出未跟踪文件
  python scripts/check-wip.py --pack dist/papilot-0.67.0.xpi
  python scripts/check-wip.py --pack <xpi> --allow vault.js,vault.xhtml
        （--allow 用于「这些就是我这次的产物」；其余未跟踪文件会让退出码为 1）

退出码：0 = 干净或全部已放行；1 = 包里含未放行的在制品；2 = 参数/路径错误。
"""
import io
import os
import subprocess
import sys
import time
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def untracked():
    """git 未跟踪的 chrome/ 文件（相对仓库根的 POSIX 路径）"""
    try:
        out = subprocess.run(
            ["git", "status", "--porcelain", "--untracked-files=all", "--", "chrome/"],
            cwd=ROOT, capture_output=True, text=True, timeout=30,
        )
    except Exception as e:
        print("无法执行 git：%s" % e)
        return None
    if out.returncode != 0:
        print("git status 失败：%s" % (out.stderr or "").strip())
        return None
    files = []
    for line in out.stdout.splitlines():
        if line.startswith("?? "):
            files.append(line[3:].strip())
    # 只关心真正会被打包的（chrome/ 下的文件）
    return [f for f in files if f.startswith("chrome/")]


def mtime(f):
    try:
        return time.strftime("%Y-%m-%d %H:%M", time.localtime(os.path.getmtime(os.path.join(ROOT, f))))
    except OSError:
        return "?"


def main(argv):
    allow = set()
    pack = None
    for i, a in enumerate(argv):
        if a == "--pack" and i + 1 < len(argv):
            pack = argv[i + 1]
        if a == "--allow" and i + 1 < len(argv):
            allow = {s.strip() for s in argv[i + 1].split(",") if s.strip()}

    files = untracked()
    if files is None:
        return 2
    if not files:
        print("✓ chrome/ 下没有未跟踪文件（无在制品风险）")
        return 0

    print("chrome/ 下未跟踪文件（可能是本地在制品）：")
    for f in files:
        print("  · %-56s %s" % (f, mtime(f)))

    if not pack:
        print("\n未指定 --pack，跳过包内核对。")
        return 0

    xpi = pack if os.path.isabs(pack) else os.path.join(ROOT, pack)
    if not os.path.isfile(xpi):
        print("包不存在：%s" % xpi)
        return 2
    names = set(zipfile.ZipFile(xpi).namelist())
    hit = [f for f in files if f in names]
    bad = [f for f in hit if os.path.basename(f) not in allow and f not in allow]
    print("\n包 %s 内命中的未跟踪文件：%d 个" % (os.path.basename(xpi), len(hit)))
    for f in hit:
        print("  %s %s" % ("→" if f in bad else "✓", f))
    if bad:
        print("\n✗ 包里含未放行的在制品 %d 个：请等它们完成/提交，或用 --allow 明确放行。" % len(bad))
        return 1
    print("\n✓ 包内未跟踪文件全部已放行")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
