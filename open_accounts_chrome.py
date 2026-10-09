# -*- coding: utf-8 -*-
"""
open__chrome.py — 用真实 Google Chrome 为每个真实 Tumblr 账号打开一个已登录窗口供检查。

前置：先用 `node tumblr-login-check.js --all --headless` 为每个账号在
      chrome_profiles/<id> 持久化登录会话（cookie）。本脚本再逐个用真实 Chrome
      打开这些 profile，每个账号独立窗口、无需 node 常驻。

用法：
  python open__chrome.py            # 打开全部真实账号
  python open__chrome.py 5          # 只打开前 5 个
"""
import json
import os
import subprocess
import sys
import time

WS = 'C:/Users/AS/WorkBuddy/2026-06-13-19-42-19'
CHROME = r'C:\Users\AS\AppData\Local\Google\Chrome\Application\chrome.exe'
PROXY = 'http://:10808'
PROFILE_BASE = os.path.join(WS, 'chrome_profiles')


def load_real_():
    acc = json.load(open(os.path.join(WS, 'data', '.json'), encoding='utf-8'))
    tk = json.load(open(os.path.join(WS, 'data', '.json'), encoding='utf-8'))
    tkids = {t['id'] for t in tk if isinstance(t, dict) and t.get('id')}
    return [a for a in acc if isinstance(a, dict) and a.get('') == 'tumblr' and a['id'] in tkids]


def main():
    limit = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else None
     = load_real_()
    if limit:
         = [:limit]
    print(f'准备打开 {len()} 个真实账号的真实 Chrome 窗口', flush=True)
    opened = 0
    for a in :
        pid = a['id']
        prof = os.path.join(PROFILE_BASE, pid)
        if not os.path.isdir(prof):
            print(f'  [跳过] {pid}: 未找到登录 profile（请先跑 tumblr-login-check.js --all --headless）', flush=True)
            continue
        url = 'https://www.tumblr.com/dashboard'
        cmd = [
            CHROME,
            f'--user-data-dir={prof}',
            f'--proxy-server={PROXY}',
            '--proxy-bypass-list=localhost;',
            '--no-first-run', '--no-default-browser-check',
            url
        ]
        try:
            subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            opened += 1
            print(f'  [已打开] {pid}  blog={a.get("")}  email={a.get("email")}', flush=True)
        except Exception as e:
            print(f'  [失败] {pid}: {e}', flush=True)
        time.sleep(1.2)  # 错开启动，避免瞬时过载
    print(f'完成：成功打开 {opened}/{len()} 个窗口。', flush=True)


if __name__ == '__main__':
    main()
