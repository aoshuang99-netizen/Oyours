#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""capsolver_cli.py — Node 侧桥接 capsolver（直连，绕开 10808 代理）。

子命令：
  balance                                 输出 "BALANCE=<num>"
  solve <task_type> <url> <sitekey> [extra_json]
                                           解出 token 输出 "" 或 "NONE"

示例：
  python capsolver_cli.py solve  https://www.tumblr.com/ 6LeYrbYqAAAAAF9Hyb1luPFtcSylK688Hk22La0B {"pageAction":""}
"""
import sys
import json
sys.path.insert(0, 'C:/Users/AS/WorkBuddy/2026-06-13-19-42-19')
from _capsolver import capsolver_solve

if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        print("usage: capsolver_cli.py balance|solve ...")
        sys.exit(1)
    if args[0] == "balance":
        import requests
        key = "CAP-1161DFAD36954DB32433A304C103AE4C61062CAC2DF2CC2568D2010DD5A58E4B"
        bal = requests.post("https://api.capsolver.com/getBalance",
                            json={"clientKey": key}, timeout=10).json().get("balance", "?")
        print("BALANCE=" + str(bal))
    elif args[0] == "solve":
        task_type = args[1]
        url = args[2]
        sitekey = args[3]
        extra = json.loads(args[4]) if len(args) > 4 else None
        tok = capsolver_solve(task_type, url, sitekey, extra=extra)
        if tok:
            print("TOKEN=" + tok)
        else:
            print("NONE")
    else:
        print("unknown cmd: " + args[0])
        sys.exit(1)
