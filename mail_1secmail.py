#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""1secmail 临时邮箱桥接（替代 mail.tm，域名更干净）"""
import sys
import json
import time
import random
import string
import urllib.request
import urllib.error

PROXY = "http://:10808"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
_BASE = "https://www.1secmail.com/api/v1"


def _req(method, url, data=None, timeout=20):
    hdr = {"": UA, "Accept": "application/json"}
    req = urllib.request.Request(url, data=data, headers=hdr, method=method)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({"http": PROXY, "https": PROXY}))
    try:
        with opener.open(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def _rand(n=10):
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=n))


class SecMail:
    def __init__(self, login=None, domain=None):
        self.login = login or ("mscms" + _rand(8))
        self.domain = domain or random.choice(["1secmail.com", "1secmail.net", "1secmail.org"])
        self.address = f"{self.login}@{self.domain}"

    def list_messages(self):
        st, raw = _req("GET", f"{_BASE}?action=getMessages&login={self.login}&domain={self.domain}")
        if st == 200:
            try:
                return json.loads(raw)
            except Exception:
                return []
        return []

    def fetch_message(self, msg_id):
        st, raw = _req("GET", f"{_BASE}?action=readMessage&login={self.login}&domain={self.domain}&id={msg_id}")
        if st == 200:
            try:
                return json.loads(raw)
            except Exception:
                return None
        return None

    def wait_for_link(self, host_filter=None, timeout=150, interval=5, subject_filter=None):
        import re
        deadline = time.time() + timeout
        seen = set()
        while time.time() < deadline:
            for m in self.list_messages():
                mid = m.get("id")
                if not mid or mid in seen:
                    continue
                subj = (m.get("subject") or "")
                if subject_filter and subject_filter.lower() not in subj.lower():
                    continue
                seen.add(mid)
                full = self.fetch_message(mid)
                if not full:
                    continue
                text = full.get("textBody") or full.get("htmlBody") or ""
                if isinstance(text, list):
                    text = "\n".join(text)
                links = re.findall(r'https?://[^\s"\'<>)]+', text)
                for link in links:
                    if host_filter is None or host_filter in link:
                        return link.rstrip('.,;')
            time.sleep(interval)
        return None


if __name__ == "__main__":
    m = SecMail()
    print("ADDR=" + m.address)
