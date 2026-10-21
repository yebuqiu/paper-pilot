#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 Cassiuschen. All rights reserved.
"""协议探针：模拟"文字处理器"，把 Zotero 的 HTTP 集成序列跑一遍（联调/回归用）。

Zotero 的集成协议是**反向 RPC**（读 xpcom/httpIntegrationClient.js 得）：
    处理器 POST /connector/document/execCommand {command, docId}
      ← Zotero 返回下一条要你执行的命令 {command, arguments}
    处理器 POST /connector/document/respond <该命令返回值>
      ← 继续下发，直到 Document.complete

**已确认的命令契约（逆向所得，写进 docs/DESIGN.md 了）**：
    Application.getActiveDocument → {"documentID": "...", "outputFormat": "html",
                                     "processorName": "...", 各能力位}
    Document.canInsertField       → true（否则 Zotero 直接报"此处无法插入字段"）
    Document.cursorInField        → false
    Document.insertField          → {"id": <fieldId>}（Field 构造取 retVal.id）
    Field.setCode                 → null
    Document.getFields            → 数组（结构待确认，见 DESIGN 的"未闭环节点"）

用法：
    python wps-cite/tools/integration_probe.py       # 跑一遍（会自动点掉 Zotero 的「文档首选项」）
    python wps-cite/tools/integration_probe.py --step   # 只发第一步

注意：Zotero 的集成事务是**有状态**的。探针异常退出会把它卡在 inProgress，
     之后的请求都返回 503 —— 重启 Zotero 即可解除。

"""
import json
import threading
import time
import urllib.error
import urllib.request

import uiautomation as auto

auto.SetGlobalSearchTimeout(1.2)
BASE = "http://127.0.0.1:23119"
DOC = "ppc-auto-1"
import os
DATA_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".workbuddy", "tmp", "probe-docdata.txt")


def load_data():
    try:
        return open(DATA_FILE, encoding="utf-8").read()
    except OSError:
        return ""


def save_data(x):
    os.makedirs(os.path.dirname(DATA_FILE), exist_ok=True)
    open(DATA_FILE, "w", encoding="utf-8").write(x)
TEXT = "这是用于联调的假文档正文。The quick brown fox jumps over the lazy dog."
clicked = []
current_cmd = [None]
stop = threading.Event()


def find_win(*keys):
    for w in auto.GetRootControl().GetChildren():
        try:
            n = w.Name or ""
            if any(k in n for k in keys):
                return w
        except Exception:
            continue
    return None


def click_ok(win):
    st = [win]
    while st:
        c = st.pop()
        try:
            if c.ControlTypeName == "ButtonControl" and (c.Name or "").strip() == "OK":
                c.GetInvokePattern().Invoke()
                return True
            for k in c.GetChildren()[:80]:
                st.append(k)
        except Exception:
            continue
    return False


def clicker():
    with auto.UIAutomationInitializerInThread():   # 子线程用 UIA 必须先初始化 COM
        _loop()


def _loop():
    while not stop.is_set():
        for keys, label in ((("文档首选项",), "文档首选项"), (("添加引文", "Add Citation"), "添加引文")):
            w = find_win(*keys)
            if not w:
                continue
            if label == "文档首选项":
                if current_cmd[0] != "Document.getDocumentData":
                    time.sleep(0.5)   # 时机未到：Zotero 还没到等用户的节点，先别点
                    continue
                if click_ok(w):
                    clicked.append((label, time.time()))
                    print("   [UI] 点了「文档首选项」的 OK")
                else:
                    print("   [UI] 文档首选项里没找到 OK 按钮")
            else:
                print("   [UI] 出现「添加引文」窗口 → 说明已进入选择文献阶段")
                clicked.append((label, time.time()))
                stop.set()
                return
            time.sleep(2)
        time.sleep(0.5)


def post(url, payload, timeout=8):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), method="POST",
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
            return r.status, json.loads(raw) if raw.strip().startswith("{") else raw
    except Exception as e:
        return -1, str(e)[:80]


def handle(cmd, args):
    if cmd == "Document.cursorInField":
        return False                    # 光标不在已有引文里
    if cmd == "Document.canInsertField":
        return True                     # 只有 true 才会继续走"选样式 → 选文献"
    if cmd == "Application.getActiveDocument":
        # 契约：{documentID, outputFormat, processorName, 能力位}（读 httpIntegrationClient.js 得）
        return {"documentID": DOC, "outputFormat": "html", "processorName": "WPS",
                "supportsCitationMerging": True, "supportsTextInsertion": True,
                "supportsImportExport": True, "supportedNotes": ["footnote"]}
    if cmd == "Document.insertField":
        return {"id": 1}                # Field 构造取 retVal.id
    if cmd == "Field.setCode":
        return None
    if cmd == "Document.getFields":
        return []
    if cmd == "Document.getDocument":
        return {"docId": DOC, "text": TEXT}
    if cmd == "Document.getDocumentData":
        d = load_data()
        print("      ↳ 返回已存文档数据" if d else "      ↳ 无文档数据（首次）")
        return d or ""
    if cmd == "Document.setDocumentData":
        print("      ↳ 保存文档数据:", str(args)[:120])
        return True
    if cmd in ("Application.activate", "Document.activate"):
        return None
    if cmd in ("Document.setDocumentData",):
        save_data(str(args[1]) if len(args) > 1 else "")
        return True
    if cmd == "Document.displayAlert":
        print("      ↳ 弹出提示:", str(args[1:3])[:120])
        return None
    print("      ↳ (未实现) 返回 null")
    return None


def main():
    threading.Thread(target=clicker, daemon=True).start()
    code, resp = post(BASE + "/connector/document/execCommand", {"command": "addCitation", "docId": DOC})
    print("① ", code, json.dumps(resp, ensure_ascii=False) if isinstance(resp, dict) else resp)
    for i in range(1, 40):
        if not isinstance(resp, dict):
            print("!! 非命令响应:", resp)
            return 1
        cmd, args = resp.get("command"), resp.get("arguments") or []
        if cmd and "complete" in cmd.lower():
            print("✔ 完成:", cmd)
            return 0
        print("%2d) %-38s %s" % (i, cmd, str(args)[:90]))
        code, resp = post(BASE + "/connector/document/respond", handle(cmd, args), timeout=90)
        if code == -1:
            print("   ← 等待中（%s）→ Zotero 停在界面上等用户" % resp)
            print("   已发生 UI 动作:", [c[0] for c in clicked])
            return 0
    stop.set()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
