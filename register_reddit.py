# -*- coding: utf-8 -*-
"""
_reddit.py v2 — Reddit Registration
Reddit uses dynamic React Web Components. We interact via clicks + keyboard.
"""
import asyncio, json, os, random, re, string, sys, time, traceback
from datetime import datetime

if sys. == "win32":
    try: sys.stdout.reconfigure(encoding="utf-8")
    except: pass

from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.abspath(__file__))
ACCOUNTS = os.path.join(ROOT, "reddit-data", ".json")
SS_DIR = os.path.join(ROOT, "reddit-data", "screenshots")
for d in [os.path.dirname(ACCOUNTS), SS_DIR]: os.makedirs(d, exist_ok=True)

def log(msg): print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)

TWOCAPTCHA_KEY = "a1e17257c62b643f4a7ff5b40edbf5dc"
EMAIL_DOMAIN = "hlua.cc.cd"
PROXY_SERVER = None  # Direct connection for now

import requests as _req

def solve_(sitekey, page_url, timeout=120):
    log("  [2captcha] Solving...")
    r = _req.post("https://api.2captcha.com/createTask", json={
        "clientKey": TWOCAPTCHA_KEY,
        "task": {"type": "HCaptchaTaskProxyless", "websiteURL": page_url, "websiteKey": sitekey}
    }, timeout=15)
    data = r.json()
    if data.get("errorId") != 0:
        log(f"  [2captcha] Error: {data.get('errorDescription')}")
        return None
    task_id = data["taskId"]
    st = time.time()
    while time.time() - st < timeout:
        time.sleep(5)
        r2 = _req.post("https://api.2captcha.com/getTaskResult", json={
            "clientKey": TWOCAPTCHA_KEY, "taskId": task_id
        }, timeout=10)
        d2 = r2.json()
        if d2.get("status") == "ready":
            token = d2[""][""]
            log(f"  [2captcha] Solved in {int(time.time()-st)}s")
            return token
        if d2.get("errorId") != 0: return None
    return None

def save(email, , ):
    d = {"site": "reddit", "email": email, "": , "": , "": datetime.now().isoformat()}
    a = []
    if os.path.exists(ACCOUNTS):
        try:
            with open(ACCOUNTS, "r", encoding="utf-8") as f: a = json.load(f)
        except: a = []
    a.append(d)
    with open(ACCOUNTS, "w", encoding="utf-8") as f: json.dump(a, f, indent=2)
    log(f"  Saved: u/{}")
    return d


async def do_(attempt_num):
    adj = ["Cool","Swift","Brave","Dark","Lucky","Wild","Epic","Neon","Cyber","Zen"]
    noun = ["Fox","Wolf","Hawk","Bear","Lion","Tiger","Eagle","Falcon","Shark","Raven"]
    suffix = random.randint(100, 9999)
     = f"{random.choice(adj)}{random.choice(noun)}{suffix}"
     = (random.choice(string.ascii_uppercase) + "".join(random.choices(string.ascii_lowercase, k=8)) + 
                "".join(random.choices(string.digits, k=3)) + random.choice("!@#"))
    email = f"{.lower()}@{EMAIL_DOMAIN}"
    
    log(f"\n{'='*50}")
    log(f"REDDIT v2 #{attempt_num} | u/{}")
    log(f"{'='*50}")
    
    browser = None
    try:
        async with async_playwright() as pw:
            log("[1] Launching...")
            browser = await pw.chromium.launch(
                headless=False,
                args=["--disable-blink-features=AutomationControlled", "--no-sandbox"]
            )
            context = await browser.new_context(
                viewport={"width": 1280, "height": 800},
                locale="en-US", timezone_id="America/Los_Angeles"
            )
            await context.add_init_script("""
                Object.defineProperty(navigator, 'webdriver', {get: () => false});
            """)
            page = await context.new_page()
            
            # ===== STEP 1: Open =====
            log("[2] Opening Reddit...")
            await page.goto("https://www.reddit.com//", 
                          timeout=30000, wait_until="domcontentloaded")
            await asyncio.sleep(6)
            log(f"    URL: {page.url[:80]}")
            
            # ===== STEP 2: Email =====
            # Reddit shows "Email" text. Click it, then type.
            log(f"[3] Email: {email}")
            try:
                await page.locator('text="Email"').first.click(timeout=5000)
            except:
                await page.mouse.click(400, 380)
            await asyncio.sleep(1.5)
            
            # Type email (input should now be focused)
            await page.keyboard.type(email, delay=50)
            await asyncio.sleep(1)
            
            # The Continue button should now be enabled
            log("    Clicking Continue...")
            try:
                await page.locator('"Continue"):not([disabled])').first.click(timeout=8000)
            except:
                await page.keyboard.press("Enter")
            await asyncio.sleep(5)
            log(f"    After email: {page.url[:80]}")
            
            # ===== STEP 3: Username =====
            log(f"[4] Username: {}")
            try:
                # Username input should be visible now
                un = page.locator('""]').first
                await un.wait_for(state="visible", timeout=15000)
                await un.fill()
                await asyncio.sleep(2)
                
                body = (await page.evaluate("document.body.innerText")).lower()
                if "already taken" in body:
                    log("    ⚠ Username taken")
                    return None
                log("    Username filled")
            except Exception as e:
                log(f"    Username error: {e}")
                # Fallback: click + type
                await page.mouse.click(400, 250)
                await page.keyboard.type(, delay=60)
            
            # ===== STEP 4:  =====
            try:
                pws = page.locator('""]')
                count = await pws.count()
                if count >= 2:
                    await pws.nth(0).fill()
                    await pws.nth(1).fill()
                elif count == 1:
                    await pws.nth(0).fill()
                log(f"     ({count} fields)")
            except Exception as e:
                log(f"     error: {e}")
            
            # ===== STEP 5: Captcha =====
            log("[5] Captcha...")
            sitekey = None
            try:
                sitekey = await page.evaluate("""
                    (() => {
                        for (const f of 'iframe')) {
                            const m = (f.src||'').match(/[?&]sitekey=([^&]+)/);
                            if (m) return m[1];
                        }
                        const e = document.querySelector('[data-sitekey]');
                        return e ? e.getAttribute('data-sitekey') : null;
                    })()
                """)
            except: pass
            
            if sitekey:
                token = solve_(sitekey, page.url)
                if token:
                    await page.evaluate("""
                        (() => {
                            const t = arguments[0];
                            '[name="h-captcha-response"], [name="h-captcha-response"], #')
                                .forEach(e => e.value = t);
                        })()
                    """, token)
                    log("    Solved")
            
            # ===== STEP 6: Submit =====
            log("[6] Submit...")
            await asyncio.sleep(1)
            try:
                await page.locator('button[type="submit"], "Sign Up"), "Create")').first.click(timeout=5000)
            except:
                await page.keyboard.press("Enter")
            
            await asyncio.sleep(8)
            url = page.url
            log(f"    URL: {page.url[:80]}")
            
            # ===== Check =====
            for check in range(3):
                if any(k in url.lower() for k in ["reddit.com", "www.reddit.com"]):
                    if "" not in url.lower() and "login" not in url.lower():
                        log("🎉 SUCCESS!")
                        await page.screenshot(path=os.path.join(SS_DIR, f"ok_{}.png"))
                        return save(email, , )
                
                # Try skip/next buttons
                try:
                    await page.locator('"Skip"), "Next"), "Continue")').first.click(timeout=3000)
                    await asyncio.sleep(4)
                    url = page.url
                except:
                    break
            
            # Error check
            try:
                pt = (await page.evaluate("document.body.innerText")).lower()
                if "welcome" in pt and "reddit" in pt:
                    log("🎉 SUCCESS (welcome msg)!")
                    return save(email, , )
                if "already taken" in pt: log("    ⚠ Username taken"); return None
                if "email" in pt and "already" in pt: log("    ⚠ Email used"); return None
            except: pass
            
            await page.screenshot(path=os.path.join(SS_DIR, f"end_{}.png"))
            log("    📸 Screenshot saved")
            return None
            
    except Exception as e:
        log(f"  Error: {e}"); traceback.print_exc(); return None
    finally:
        if browser:
            try: await browser.close()
            except: pass


async def main():
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    log(f"\n{'='*50}\nREDDIT v2 | @{EMAIL_DOMAIN}\n{'='*50}")
    results = []
    for i in range(1, count + 1):
        r = await do_(i)
        if r: results.append(r); log(f"✅ u/{r['']} | {r['']}")
        else: log(f"❌ FAILED")
        log(f"Progress: {len(results)}/{i}")
        if i < count:
            w = random.randint(5, 10)
            log(f"  Cooling {w}s..."); await asyncio.sleep(w)
    log(f"\n{'='*50}\nDONE: {len(results)}/{count}")
    for r in results: log(f"  u/{r['']} | {r['']}")
    log(f"{'='*50}")

if __name__ == "__main__":
    asyncio.run(main())
