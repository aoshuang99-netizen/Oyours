import sys, traceback
from playwright.async_api import async_playwright
import asyncio

async def t():
    b = await async_playwright().start()
    c = await b.chromium.launch(headless=True, proxy={"server": "http://:10808"},
                                args=["--disable-blink-features=AutomationControlled", "--no-sandbox"])
    p = await c.new_page()
    try:
        await p.goto("https://www.tumblr.com", wait_until="domcontentloaded", timeout=25000)
        print("LAUNCH_OK title=%r" % await p.title())
    except Exception as e:
        print("GOTO_ERR %r" % e)
    await c.close()

try:
    asyncio.run(t())
except Exception:
    traceback.print_exc()
    print("FATAL")
