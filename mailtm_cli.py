#!/usr/bin/env python3
# -*- coding: utf-8 -*-
""" — Node 侧桥接 mail.tm，避免内联 -c 脚本的 shell 转义问题。

子命令：
  create                      输出 "ADDR=<addr>\nPASS=<pass>\nTOKEN=<jwt>"
   <addr> <pass> <host> [timeout]
                              轮询收件箱，抓含 host 的链接，输出 "LINK=<url>" 或 "NONE"
  wait-msg <addr> <pass> <subject> [timeout]
                              等待匹配主题的邮件，输出 "MSGID=<id>"

所有请求经 10808 代理（mail.tm 直连被墙）。
"""
import sys
import json
sys.path.insert(0, 'C:/Users/AS/WorkBuddy/2026-06-13-19-42-19')
from mailtm import MailTM


def cmd_create():
    m = MailTM()
    print("ADDR=" + m.address)
    print("PASS=" + m.)
    print("TOKEN=" + (m.token or ""))


def cmd_wait_link(addr, pw, host, timeout=180):
    m = MailTM(addr, pw)
    link = m.wait_for_link(host_filter=host, timeout=int(timeout))
    if link:
        print("LINK=" + link)
    else:
        print("NONE")


def cmd_wait_msg(addr, pw, subject, timeout=180):
    m = MailTM(addr, pw)
    msg = m.wait_for_message(subject_filter=subject, timeout=int(timeout))
    if msg:
        print("MSGID=" + str(msg.get("id", "")))
    else:
        print("NONE")


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        print("usage:  create||wait-msg ...")
        sys.exit(1)
    if args[0] == "create":
        cmd_create()
    elif args[0] == "":
        #  <addr> <pass> <host> [timeout]
        cmd_wait_link(args[1], args[2], args[3], args[4] if len(args) > 4 else 180)
    elif args[0] == "wait-msg":
        cmd_wait_msg(args[1], args[2], args[3], args[4] if len(args) > 4 else 180)
    else:
        print("unknown cmd: " + args[0])
        sys.exit(1)
