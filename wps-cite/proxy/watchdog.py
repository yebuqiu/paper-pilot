#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 Cassiuschen. All rights reserved.
"""Papilot Cite 代理看门狗：端口没监听就拉起来。

为什么不能只靠"Run 项 + 启动文件夹"：
    那两条只在**登录时**触发一次。代理进程一旦退出（崩溃、被安全软件清、被上层会话回收），
    用户下一次点「插入引文」就是 `Failed to fetch`。
    看门狗由 Windows 计划任务每分钟跑一次，与任何终端会话无关，是唯一真正可靠的兜底。

设计：
    - 幂等：端口在监听就直接退出（不做任何事），所以每 1 分钟跑一次几乎零成本。
    - 无窗：用 pythonw 跑，不闪黑框。
    - 有据可查：动作写进 %APPDATA%\\PapilotCite\\watchdog.log（只记录"拉起"这种事件）。
"""
import os
import socket
import subprocess
import sys
import time

PORT = 21932
HOME = os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~"), "PapilotCite")
PROXY = os.path.join(HOME, "proxy.py")
LOG = os.path.join(HOME, "watchdog.log")


def up():
    s = socket.socket()
    s.settimeout(0.4)
    try:
        s.connect(("127.0.0.1", PORT))
        return True
    except OSError:
        return False
    finally:
        s.close()


def note(msg):
    try:
        os.makedirs(HOME, exist_ok=True)
        if os.path.isfile(LOG) and os.path.getsize(LOG) > 128 * 1024:
            os.remove(LOG)
        with open(LOG, "a", encoding="utf-8") as f:
            f.write("%s %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg))
    except OSError:
        pass


def main():
    if up():
        return 0
    if not os.path.isfile(PROXY):
        note("proxy.py 不存在，跳过")
        return 1
    exe = os.path.join(os.path.dirname(sys.executable), "pythonw.exe")
    if not os.path.isfile(exe):
        exe = sys.executable
    try:
        subprocess.Popen([exe, PROXY], cwd=HOME,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL)
    except OSError as e:
        note("拉起失败: %s" % e)
        return 1
    for _ in range(40):
        if up():
            note("已拉起代理")
            return 0
        time.sleep(0.25)
    note("拉起后端口仍无响应")
    return 1


if __name__ == "__main__":
    sys.exit(main())
