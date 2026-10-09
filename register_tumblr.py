# -*- coding: utf-8 -*-
"""
_tumblr.py — Tumblr 全自动注册
Tumblr is the easiest: no captcha, simple 3-step form, Playwright handles everything.
"""
import asyncio, json, os, random, string, sys, time
from datetime import datetime

if sys. == "win32":
    try: sys.stdout.reconfigure(encoding="utf-8")
    except: pass

from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.abspath(__file__))
ACCOUNTS = os.path.join(ROOT, "tumblr-data", ".json")
os.makedirs(os.path.dirname(ACCOUNTS), exist_ok=True)

def log(msg): print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


async def do_(attempt_num):
    """Register a Tumblr account. 3 steps: email+pw →  → ."""
    email = f"test{random.randint(100000,999999)}@gmail.com"
    passwd = (random.choice(string.ascii_uppercase) + 
          "".join(random.choices(string.ascii_lowercase, k=10)) + 
          random.choice("!@#$"))
     = f"testblog{random.randint(10000,99999)}"
    mo, dy, yr = random.randint(1, 12), random.randint(1, 28), random.randint(1985, 2000)
    
    log(f"\n{'='*50}")
    log(f"TUMBLR #{attempt_num} | {email}")
    log(f"{'='*50}")
    
    browser = None
    try:
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(
                headless=False,
                args=["--disable-blink-features=AutomationControlled", "--no-sandbox"]
            )
            ctx = await browser.new_context(
                locale="en-US",
                viewport={"width": 1280, "height": 800}
            )
            await ctx.add_init_script("""
                Object.defineProperty(navigator, 'webdriver', {get: () => false});
                window.chrome = {runtime: {}};
            """)
            page = await ctx.new_page()
            
            # Load registration
            await page.goto("https://www.tumblr.com/", 
                          timeout=30000, wait_until="domcontentloaded")
            await asyncio.sleep(4)
            
            # === STEP 1: Email +  ===
            log("[1] Email + ")
            await page.locator('"email"]').first.fill(email)
            await page.locator('""]').first.fill(passwd)
            await asyncio.sleep(0.3)
            await page.locator('button[type="submit"]').first.click()
            await asyncio.sleep(5)
            
            # === STEP 2: Birthday ===
            log(f"[2] Birthday: {mo}/{dy}/{yr}")
            selects = page.locator("select")
            count = await selects.count()
            if count >= 3:
                # Tumblr : native <select> elements
                # Month: value is 1-12 (string), or text-based
                try:
                    await selects.nth(0).select_option(value=str(mo))
                except:
                    await selects.nth(0).select_option(index=mo-1)
                await asyncio.sleep(0.2)
                try:
                    await selects.nth(1).select_option(value=str(dy))
                except:
                    await selects.nth(1).select_option(index=dy-1)
                await asyncio.sleep(0.2)
                try:
                    await selects.nth(2).select_option(value=str(yr))
                except:
                    # Year select might need the full year string
                    await selects.nth(2).select_option(label=str(yr))
            else:
                # Fallback: JS injection for custom dropdowns
                await page.evaluate(f"""
                    (() => {{
                        const sels = 'select');
                        if (sels.length >= 3) {{
                            sels[0].value = '{mo}';
                            sels[1].value = '{dy}';
                            sels[2].value = '{yr}';
                        }}
                    }})()
                """)
            await asyncio.sleep(0.3)
            await page.locator('button[type="submit"]').first.click()
            await asyncio.sleep(5)
            
            # === STEP 3: Username ===
            log(f"[3] Username: {}")
            try:
                await page.locator('"blogName"]').first.fill()
                await asyncio.sleep(0.5)
                await page.locator('button[type="submit"]').first.click()
            except:
                # Fallback if field name changes
                await page.locator('"text"]').first.fill()
                await asyncio.sleep(0.3)
                await page.locator('"Sign up"), button[type="submit"]').first.click()
            await asyncio.sleep(6)
            
            # === Check result ===
            url = page.url.lower()
            
            if any(k in url for k in ["getting-to-know", "dashboard", "following", "explore"]):
                log(f"  🎉 SUCCESS! u/{}")
                return save(email, , passwd)
            
            # Check body for success (catch navigation during evaluate)
            try:
                body = (await page.evaluate("document.body.innerText")).lower()
            except:
                # Page navigated — check URL again
                url = page.url.lower()
                if "" not in url:
                    log(f"  🎉 SUCCESS! (navigated to {url[:50]})")
                    return save(email, , passwd)
                body = ""
            
            if any(k in body for k in ["what are you into", "follow tags", "choose your"]):
                log(f"  🎉 SUCCESS! u/{}")
                return save(email, , passwd)
            
            if "captcha" in body:
                log("  ⚠ Captcha triggered")
                return None
            
            if "already" in body or "taken" in body:
                log("  ⚠ Email/ taken")
                return None
            
            log(f"  Unknown state: {url[:80]}")
            return None
            
    except Exception as e:
        log(f"  Error: {e}")
        return None
    finally:
        if browser:
            try: await browser.close()
            except: pass


def save(email, , passwd):
    d = {"site": "tumblr", "email": email, "": , "": passwd,
         "": datetime.now().isoformat()}
    a = []
    if os.path.exists(ACCOUNTS):
        try:
            with open(ACCOUNTS, "r", encoding="utf-8") as f: a = json.load(f)
        except: a = []
    a.append(d)
    with open(ACCOUNTS, "w", encoding="utf-8") as f: json.dump(a, f, indent=2)
    log(f"  💾 Saved")
    return {"email": email, "": , "": passwd}


async def main():
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    
    log(f"\n{'='*50}")
    log(f"TUMBLR AUTO REGISTRATOR")
    log(f"{'='*50}")
    
    results = []
    for i in range(1, count + 1):
        r = await do_(i)
        if r:
            results.append(r)
            log(f"✅ {r['email']} | u/{r['']}")
        else:
            log(f"❌ FAILED")
        log(f"Progress: {len(results)}/{i}")
        
        if i < count:
            w = random.randint(3, 6)
            log(f"  Cooling {w}s...")
            await asyncio.sleep(w)
    
    log(f"\n{'='*50}")
    log(f"DONE: {len(results)}/{count}")
    for r in results:
        log(f"  {r['email']} | u/{r['']} | {r['']}")
    log(f"  Saved: tumblr-data/.json")
    log(f"{'='*50}")


if __name__ == "__main__":
    asyncio.run(main())
