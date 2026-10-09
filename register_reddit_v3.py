# -*- coding: utf-8 -*-
"""
_reddit_v3.py — Let Playwright handle the invisible Enterprise reCAPTCHA
The form submission triggers grecaptcha.enterprise.execute() automatically.
"""
import asyncio, json, os, random, string, sys, time
from datetime import datetime

if sys. == "win32":
    try: sys.stdout.reconfigure(encoding="utf-8")
    except: pass

from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.abspath(__file__))
ACCOUNTS = os.path.join(ROOT, "reddit-data", ".json")
os.makedirs(os.path.dirname(ACCOUNTS), exist_ok=True)

def log(msg): print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)

ADJ = ["Cool","Swift","Brave","Dark","Lucky","Wild","Epic","Neon","Cyber","Zen",
       "Mega","Ultra","Super","Alpha","Omega","Nova","Star","Blaze","Storm"]
NOUN = ["Fox","Wolf","Hawk","Bear","Lion","Tiger","Eagle","Cobra","Shark","Raven",
        "Phoenix","Dragon","Viper","Lynx","Jaguar","Crow","Owl","Bat","Manta"]


async def do_(attempt_num):
     = f"{random.choice(ADJ)}{random.choice(NOUN)}{random.randint(100,9999)}"
    pw = (random.choice(string.ascii_uppercase) + 
          "".join(random.choices(string.ascii_lowercase, k=8)) + 
          "".join(random.choices(string.digits, k=3)) + 
          random.choice("!@#$"))
    
    log(f"\n{'='*50}")
    log(f"REDDIT v3 #{attempt_num} | u/{}")
    log(f"{'='*50}")
    
    browser = None
    try:
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(
                headless=False,
                args=["--disable-blink-features=AutomationControlled", "--no-sandbox"]
            )
            ctx = await browser.new_context(locale="en-US", viewport={"width": 1280, "height": 800})
            page = await ctx.new_page()
            
            # Load page
            await page.goto("https://www.reddit.com//", timeout=30000, wait_until="domcontentloaded")
            await asyncio.sleep(5)
            
            # Fill email + click Continue
            log("[1] Email step...")
            await page.evaluate("""
                (email) => {
                    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                    const el = document.querySelector('"email"]');
                    if (el) {
                        setter.call(el, email);
                        el.dispatchEvent(new Event('input', {bubbles: true}));
                        el.dispatchEvent(new Event('change', {bubbles: true}));
                    }
                }
            """, f"test{random.randint(10000,99999)}@gmail.com")
            await asyncio.sleep(1)
            
            try:
                await page.locator("button").first.click(timeout=5000)
            except:
                pass
            await asyncio.sleep(5)
            
            # Fill  + 
            log("[2] Username & ...")
            await page.evaluate("""
                (uname, pwd) => {
                    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                    const setVal = (sel, val) => {
                        const el = document.querySelector(sel);
                        if (!el) return;
                        setter.call(el, val);
                        el.dispatchEvent(new Event('input', {bubbles: true}));
                        el.dispatchEvent(new Event('change', {bubbles: true}));
                    };
                    setVal('""]', uname);
                    setVal('""]', pwd);
                    const pws = '""]');
                    if (pws.length >= 2) {
                        setter.call(pws[1], pwd);
                        pws[1].dispatchEvent(new Event('input', {bubbles: true}));
                    }
                }
            """, {"uname": , "pwd": pw})
            await asyncio.sleep(1)
            
            # SUBMIT — this triggers grecaptcha.enterprise.execute() automatically
            log("[3] Submitting (triggers invisible reCAPTCHA)...")
            
            # Listen for network responses
            submit_clicked = False
            page.on("response", lambda r: None)  # Just for monitoring
            
            try:
                submit_btn = page.locator('button[type="submit"]').first
                await submit_btn.click(timeout=5000)
                submit_clicked = True
            except:
                await page.evaluate("""
                    () => {
                        for (const b of 'button')) {
                            if (b.type === 'submit') { b.click(); return; }
                        }
                    }
                """)
                submit_clicked = True
            
            # Wait for result
            await asyncio.sleep(12)
            url = page.url
            log(f"    URL: {url[:100]}")
            
            # Check token
            token = await page.evaluate("""
                () => {
                    const el = document.getElementById('');
                    return el ? el.value.substring(0, 30) + '...' : null;
                }
            """)
            log(f"    Captcha token: {token}")
            
            # Check body text
            body = await page.evaluate("document.body.innerText")
            body_low = body.lower()
            
            # Check results
            if "" not in url.lower():
                log(f"  🎉 SUCCESS! Redirected to: {url[:60]}")
                save(, pw)
                return {"": , "": pw}
            
            if "welcome" in body_low:
                log("  🎉 SUCCESS!")
                save(, pw)
                return {"": , "": pw}
            
            # Errors
            key_lines = [l.strip() for l in body.split('\n') if l.strip() and len(l.strip()) > 3][:15]
            log(f"    Page: {key_lines}")
            
            if "already taken" in body_low:
                log("  ⚠ Username taken")
            if "email" in body_low and "already" in body_low:
                log("  ⚠ Email already used")
            
            await page.screenshot(path=os.path.join(ROOT, "reddit-data", f"v3_{}.png"))
            log(f"  📸 Screenshot saved")
            return None
            
    except Exception as e:
        log(f"  Error: {e}")
        import traceback; traceback.print_exc()
        return None
    finally:
        if browser:
            try: await browser.close()
            except: pass


def save(, pw):
    d = {"site": "reddit", "": , "": pw, "": datetime.now().isoformat()}
    a = []
    if os.path.exists(ACCOUNTS):
        try:
            with open(ACCOUNTS, "r", encoding="utf-8") as f: a = json.load(f)
        except: a = []
    a.append(d)
    with open(ACCOUNTS, "w", encoding="utf-8") as f: json.dump(a, f, indent=2)
    log(f"  💾 Saved")


async def main():
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    log(f"\n{'='*50}")
    log(f"REDDIT v3 — Auto Enterprise reCAPTCHA")
    log(f"{'='*50}")
    
    results = []
    for i in range(1, count + 1):
        r = await do_(i)
        if r: results.append(r); log(f"✅ u/{r['']}")
        else: log(f"❌ FAILED")
        log(f"Progress: {len(results)}/{i}")
        if i < count:
            await asyncio.sleep(random.randint(5, 10))
    
    log(f"\n{'='*50}\nDONE: {len(results)}/{count}")
    for r in results: log(f"  u/{r['']} | {r['']}")
    log(f"{'='*50}")


if __name__ == "__main__":
    asyncio.run(main())
