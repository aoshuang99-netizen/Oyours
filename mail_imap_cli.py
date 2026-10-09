#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
mail_imap_cli.py — Tumblr 验证邮件 IMAP 自动接收（真实域名邮箱 catch-all）
子命令：
   <expected_address> <timeout_seconds>
      轮询收件箱，匹配发往 expected_address 的 Tumblr 验证邮件，提取首个 http(s) 链接。
      输出： LINK=<url>
依赖配置（同目录 tumblr_email.json 的 imap 段）：
  {
    "mode": "imap",
    "domain": "yourdomain.com",
    "verify": true,
    "imap": { "host":"imap.yourdomain.com", "port":993, "user":"catchall@yourdomain.com", "pass":"", "tls": true, "mailbox":"INBOX" }
  }
注意：
  - user 必须是能收到 catch-all 邮件的账号（或域名全局转发到该账号）。
  - 密码用邮箱服务商的「授权码/应用专用密码」，不是登录密码。
  - 本工具只读邮件、提取链接，绝不删除或修改邮件。
"""
import sys, os, re, json, time, imaplib, email as emaillib
from datetime import datetime, timedelta

WS = os.path.dirname(os.path.abspath(__file__))

def load_cfg():
    f = os.path.join(WS, 'tumblr_email.json')
    if not os.path.exists(f):
        sys.stderr.write('tumblr_email.json 不存在\n'); sys.exit(2)
    return json.load(open(f, encoding='utf-8'))

def extract_links(text):
    return re.findall(r'https?://[^\s"\'<>\)]+', text)

def wait_link(address, timeout):
    cfg = load_cfg().get('imap', {})
    host = cfg.get('host'); port = int(cfg.get('port', 993))
    user = cfg.get('user'); pw = cfg.get('pass')
    tls = cfg.get('tls', True)
    mailbox = cfg.get('mailbox', 'INBOX')
    if not (host and user and pw):
        sys.stderr.write('imap 配置不完整 (host/user/pass)\n'); sys.exit(2)
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if tls:
                M = imaplib.IMAP4_SSL(host, port)
            else:
                M = imaplib.IMAP4(host, port)
            M.login(user, pw)
            M.select(mailbox)
            # 搜最近 24h 全部邮件
            since = (datetime.now() - timedelta(hours=24)).strftime('%d-%b-%Y')
            typ, data = M.search(None, 'SINCE', since)
            if typ == 'OK' and data and data[0]:
                for num in data[0].split()[::-1]:
                    typ, msg_data = M.fetch(num, '(RFC822)')
                    if typ != 'OK': continue
                    raw = msg_data[0][1]
                    msg = emaillib.message_from_bytes(raw)
                    tos = msg.get('To', '') + ' ' + msg.get('Delivered-To', '')
                    subj = (msg.get('Subject', '') or '').lower()
                    if address.lower() not in tos.lower():
                        continue
                    # 提取正文
                    body = ''
                    if msg.is_multipart():
                        for part in msg.walk():
                            if part.get_content_type() == 'text/plain':
                                body += part.get_payload(decode=True).decode('utf-8', 'ignore')
                            elif part.get_content_type() == 'text/html':
                                body += part.get_payload(decode=True).decode('utf-8', 'ignore')
                    else:
                        body = msg.get_payload(decode=True).decode('utf-8', 'ignore')
                    if 'tumblr' in (subj + body).lower() or 'verify' in (subj + body).lower():
                        links = extract_links(body)
                        if links:
                            M.close(); M.logout()
                            print('LINK=' + links[0].rstrip('.,)'))
                            return
            M.close(); M.logout()
        except Exception as e:
            sys.stderr.write('IMAP 轮询异常: %s\n' % e)
        time.sleep(10)
    sys.stderr.write('超时未收到验证邮件\n')
    sys.exit(1)

if __name__ == '__main__':
    if len(sys.argv) < 3:
        sys.stderr.write('用法: mail_imap_cli.py  <address> <timeout>\n'); sys.exit(2)
    cmd = sys.argv[1]
    if cmd == '':
        wait_link(sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 180)
    else:
        sys.stderr.write('未知子命令: %s\n' % cmd); sys.exit(2)
