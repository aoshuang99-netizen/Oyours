#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Tumblr 写权限 App 半自动创建器
================================
用途：在已登录的 Tumblr 账号下，自动创建「允许发帖」的 OAuth App，
      并抓取 Consumer Key / Secret，供 tumblr_oauth1_local.js 使用。

你只需做：
  1) 运行本脚本（可见浏览器自动打开）
  2) 若未登录 → 在浏览器里登录 Tumblr（登录后脚本自动继续）
  3) 出现 reCAPTCHA / 验证码 → 手动过一下
  4) 点「创建应用」按钮
  5) 脚本自动抓取 Key/Secret 并保存到 tumblr_app_creds.json

运行（用带 playwright 的 hermes venv）：
  C:/Users/AS/AppData/Local/hermes/hermes-agent/venv/Scripts/python.exe tumblr_create_app.py

依赖：playwright（已装在 hermes venv），代理走 :10808
"""
import asyncio
import json
import re
import sys
from pathlib import Path

from playwright.async_api import async_playwright

NEW_APP_URL = "https://www.tumblr.com/oauth/apps/new"
PROXY = "http://:10808"
USER_DATA = str(Path(__file__).parent / ".pw_tumblr_profile")
OUT = Path(__file__).parent / "tumblr_app_creds.json"


async def fill_any(page, selectors, value, label):
    for sel in selectors:
        try:
            el = await page.query_selector(sel)
            if el and await el.is_visible():
                await el.fill(value)
                print(f"  ✓ {label} <- {value!r}  ({sel})")
                return True
        except Exception:
            pass
    print(f"  ✗ {label} 未自动定位（请手动填写）：{selectors}")
    return False


async def main():
    async with async_playwright() as p:
        print("🌐 启动可见浏览器（经 10808 代理）…")
        ctx = await p.chromium.launch_persistent_context(
            USER_DATA,
            headless=False,
            slow_mo=250,
            proxy={"server": PROXY},
        )
        page = await ctx.new_page()
        page.set_default_timeout(30000)

        await page.goto(NEW_APP_URL, wait_until="domcontentloaded")
        await page.wait_for_timeout(2500)

        # 登录检测
        if "login" in page.url.lower() or await page.query_selector('"email"]'):
            print("🔐 检测到未登录，请在浏览器里登录 Tumblr（登录后脚本自动继续）…")
            try:
                await page.wait_for_(
                    "() => !/login|signup/.test(location.href)", timeout=300000
                )
            except Exception:
                print("⏰ 登录等待超时，请手动导航到创建页后回车继续。")
            await page.goto(NEW_APP_URL, wait_until="domcontentloaded")
            await page.wait_for_timeout(2500)

        print("📝 自动填写申请表单…")
        await fill_any(
            page,
            ['"name"]', "#name", 'input[placeholder*="name" i]',
             '"application_name"]'],
            "MSCMS Auto Poster", "Application name")
        await fill_any(
            page,
            ['[name="description"]', "#description", ""],
            "Automated social posting pipeline via MSCMS.", "Description")
        await fill_any(
            page,
            ['"website"]', "#website", 'input[placeholder*="website" i]',
             '"url"]'],
            "https://mscms.local", "Website")
        await fill_any(
            page,
            ['"callback_url"]', "#callback_url",
             'input[placeholder*="callback" i]', '"oauth_callback"]'],
            "http://localhost:3122/callback", "Callback URL")

        # 选「允许发帖」权限
        perms_sel = ['select[name="default_permissions"]', "#default_permissions",
                     'select[name="permissions"]', "select"]
        for sel in perms_sel:
            try:
                el = await page.query_selector(sel)
                if not el:
                    continue
                opts = await el.query_selector_all("option")
                for o in opts:
                    txt = (await o.inner_text()).lower()
                    if "post" in txt or "write" in txt or "发帖" in txt:
                        val = await o.get_attribute("value")
                        await el.select_option(value=val)
                        print(f"  ✓ 权限 <- {await o.inner_text().strip()}  ({sel})")
                        break
                break
            except Exception:
                pass
        else:
            print("  ⚠ 未找到权限下拉，请手动选择「允许发帖」")

        print("\n👉 请在浏览器里完成 reCAPTCHA（如有），然后点击「Create application / 创建应用」按钮。")
        print("   脚本会等待跳转并自动抓取 Key/Secret…\n")

        try:
            await page.wait_for_url(
                lambda u: "oauth/apps" in u and "new" not in u, timeout=300000)
        except Exception:
            print("⏰ 未检测到跳转，若应用已创建请手动刷新页面后回车。")
            input("按回车继续抓取…")
        await page.wait_for_timeout(2500)

        # 尝试展开 secret
        for btn in await page.query_selector_all("button, a"):
            try:
                t = (await btn.inner_text()).lower()
                if "show" in t and "secret" in t:
                    await btn.click()
                    print("  ✓ 已点击 Show secret")
                    await page.wait_for_timeout(800)
                    break
            except Exception:
                pass

        # 抓取 key/secret：提取页面里所有长 hex 串，去重，按顺序取前两个
        tokens = await page.evaluate(
            """() => {
                const re = /[A-Za-z0-9]{40,}/g;
                const set = [];
                const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
                let n;
                while ((n = walker.nextNode())) {
                    const m = n.nodeValue.match(re);
                    if (m) set.push(...m);
                }
                // 也抓 input/ 的 value
                'input,').forEach(e => {
                    const m = (e.value || '').match(re);
                    if (m) set.push(...m);
                });
                return [...new Set(set)];
            }"""
        )
        # 过滤掉明显不是凭据的（如长 uuid 过短/过长）
        tokens = [t for t in tokens if 40 <= len(t) <= 60]
        if len(tokens) >= 2:
            consumer_key,  = tokens[0], tokens[1]
            print(f"\n✅ 抓取到凭据：")
            print(f"   consumer_key    = {consumer_key}")
            print(f"    = {}")
            OUT.write_text(json.dumps({
                "consumer_key": consumer_key,
                "": ,
            }, indent=2, ensure_ascii=False), encoding="utf-8")
            print(f"\n💾 已保存到 {OUT}")
            print("\n下一步：运行以下命令完成 OAuth 授权（浏览器点 Allow 即可）")
            print(f'  node tumblr_oauth1_local.js --consumer-key {consumer_key} '
                  f'-- {} --probe-write')
        else:
            print("❌ 未能自动抓取到 Key/Secret，请在浏览器里手动复制并运行：")
            print("  node tumblr_oauth1_local.js --consumer-key <KEY> -- <SECRET> --probe-write")
            print("页面上的长字符串候选：", tokens[:8])

        await ctx.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n已取消。")
        sys.exit(1)
