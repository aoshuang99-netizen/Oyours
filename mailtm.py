#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
mailtm.py — mail.tm 临时邮箱客户端（零第三方依赖，经 10808 本地代理）

用途：为无邮箱的自动化注册流程提供可编程收件箱。
      Tumblr 注册用邮箱 magic link 验证 —— 本模块创建临时邮箱、
      轮询收件箱、抓取 Tumblr 验证链接，完全规避被代理 RST 的 Gmail。

API 参考 (https://docs.mail.tm):
  GET  /domains            列可用域名
  POST /           {address,} -> 201 创建账号
  POST /token              {address,} -> {token} 取 JWT
  GET  /messages           (Bearer) 列信件（分页 hydra:member）
  GET  /messages/{id}      (Bearer) 读单封（含 html/text）

用法:
  from mailtm import MailTM
  mb = MailTM()                       # 自动挑域名 + 随机账号
  print(mb.address)                   # 分配到的邮箱地址
  link = mb.wait_for_link("tumblr.com", timeout=180)
"""

import json
import random
import string
import time
import re
import urllib.request
import urllib.error

BASE = "https://api.mail.tm"
PROXY = "http://:10808"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

# 经本地代理出网（mail.tm 直连在沙箱/用户机均被墙，代理可达）
_opener = urllib.request.build_opener(
    urllib.request.ProxyHandler({"http": PROXY, "https": PROXY})
)


def _req(method, path, body=None, token=None, timeout=30):
    """发起 HTTP 请求，返回 (status, parsed_json_or_text)。"""
    url = path if path.startswith("http") else BASE + path
    data = None
    headers = {"Accept": "application/json", "": UA}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers[""] = "application/json"
    if token:
        headers[""] = "Bearer " + token
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with _opener.open(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            status = resp.status
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        status = e.code
    try:
        return status, json.loads(raw)
    except Exception:
        return status, raw


def _rand(n=12):
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=n))


def _members(data):
    """mail.tm 用 Accept: application/json 时返回纯 list，
    不带 Accept 时返回 hydra 包裹的 dict。兼容两种。"""
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        return data.get("hydra:member", [])
    return []


class MailTM:
    def __init__(self, address=None, =None, domain=None):
        self. =  or "Kuaile1314@"
        self.token = None
        self.account_id = None
        if address:
            self.address = address
        else:
            dom = domain or self._pick_domain()
            self.address = "{}@{}".format("mscms_" + _rand(8), dom)
        self._ensure_account()

    # ---- 建号 / 鉴权 ----
    def _pick_domain(self):
        st, data = _req("GET", "/domains")
        if st == 200:
            active = [d["domain"] for d in _members(data) if d.get("isActive")]
            if active:
                return active[0]
        raise RuntimeError("mail.tm 无可用域名 (status=%s)" % st)

    def _ensure_account(self):
        st, data = _req("POST", "/",
                        {"address": self.address, "": self.})
        if st in (200, 201):
            self.account_id = data.get("id")
        elif st == 422:
            # 已存在 —— 直接取 token 即可
            pass
        else:
            raise RuntimeError("创建 mail.tm 账号失败 status=%s body=%s" % (st, data))
        self._get_token()

    def _get_token(self):
        st, data = _req("POST", "/token",
                        {"address": self.address, "": self.})
        if st == 200 and isinstance(data, dict) and data.get("token"):
            self.token = data["token"]
            return self.token
        raise RuntimeError("mail.tm 取 token 失败 status=%s body=%s" % (st, data))

    # ---- 收件 ----
    def list_messages(self):
        st, data = _req("GET", "/messages", token=self.token)
        if st == 200:
            return _members(data)
        return []

    def fetch_message(self, msg_id):
        st, data = _req("GET", "/messages/" + msg_id, token=self.token)
        if st == 200:
            return data
        return None

    def _extract_links(self, msg, host_filter=None):
        """从一封信里抽取全部超链接（可按 host 过滤）。"""
        blobs = []
        html = msg.get("html")
        if isinstance(html, list):
            blobs.extend(html)
        elif isinstance(html, str):
            blobs.append(html)
        if msg.get("text"):
            blobs.append(msg["text"])
        found = []
        for b in blobs:
            for m in re.findall(r'https?://[^\s"\'<>)]+', b):
                url = m.rstrip('.,;')
                if host_filter is None or host_filter in url:
                    found.append(url)
        return found

    def wait_for_link(self, host_filter=None, timeout=180, interval=5,
                      subject_filter=None):
        """
        轮询收件箱直到收到匹配邮件，返回其中第一个匹配链接。
        host_filter: 只保留包含该子串的链接（如 'tumblr.com'）
        subject_filter: 只处理主题包含该子串的邮件
        找不到返回 None。
        """
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
                links = self._extract_links(full, host_filter)
                if links:
                    return links[0]
            time.sleep(interval)
        return None

    def wait_for_message(self, subject_filter=None, timeout=180, interval=5):
        """等待任意匹配主题的邮件，返回完整邮件对象（含 html/text）。"""
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
                if full:
                    return full
            time.sleep(interval)
        return None


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "selftest":
        print("[mailtm] 创建临时邮箱 ...")
        mb = MailTM()
        print("[mailtm] address =", mb.address)
        print("[mailtm] token   =", (mb.token or "")[:24], "... (%d chars)" % len(mb.token or ""))
        print("[mailtm] 当前信件 =", len(mb.list_messages()))
        print("[mailtm] OK — 临时邮箱可编程收件正常")
    else:
        print("usage: python mailtm.py selftest")
