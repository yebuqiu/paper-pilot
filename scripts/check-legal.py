# -*- coding: utf-8 -*-
"""发版前检查法律文本是否还留着占位符。

付费服务上线后，`server/public/terms.html` 与 `privacy.html` 会被真实用户看到；
带 `【待填】` 的页面既不能作为「已告知」的证据，也会直接暴露给付费用户。

用法：python scripts/check-legal.py
退出码：0 = 无占位符；1 = 仍有待填项（发版阻断）
"""
import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FILES = [
    os.path.join(ROOT, "server", "public", "terms.html"),
    os.path.join(ROOT, "server", "public", "privacy.html"),
]
PAT = re.compile(r"【待填[^】]*】")


def main():
    total = 0
    for p in FILES:
        rel = os.path.relpath(p, ROOT)
        if not os.path.exists(p):
            print("✗ 缺失：%s" % rel)
            total += 1
            continue
        text = io.open(p, encoding="utf-8").read()
        hits = PAT.findall(text)
        if not hits:
            print("✓ %s 无待填项" % rel)
            continue
        print("✗ %s 还有 %d 处待填：" % (rel, len(hits)))
        for h in dict.fromkeys(hits):
            print("    - " + h)
        total += len(hits)

    if total:
        print("\n发版阻断：请补齐上述内容后再发布（法律服务条款不建议带占位符上线）。")
        return 1
    print("\n法律文本检查通过。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
