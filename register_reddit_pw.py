# -*- coding: utf-8 -*-
"""
_reddit_pw.py — Playwright + 2captcha Reddit Registration
Uses Playwright to extract sitekey dynamically, 2captcha to solve, then submit via API.
"""
import asyncio, json, os, random, re, string, sys, time
from datetime import datetime

if sys. == "win32":
    try: sys.stdout.reconfigure(encoding="utf-8")
    except: pass

from playwright.async_api import async_playwright
import requests

ROOT = os.path.dirname(os.path.abspath(__file__))
ACCOUNTS = os.path.join(ROOT, "reddit-data", ".json")
os.makedirs(os.path.dirname(ACCOUNTS), exist_ok=True)

def log(msg): print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)

TWOCAPTCHA_KEY = "ec6ff4cca146b810a53ad5d6f7d59ff1"
EMAIL_DOMAIN = "hlua.cc.cd"

ADJ = ["Cool","Swift","Brave","Dark","Lucky","Wild","Epic","Neon","Cyber","Zen",
       "Mega","Ultra","Super","Alpha","Omega","Nova","Star","Blaze","Storm"]
NOUN = ["Fox","Wolf","Hawk","Bear","Lion","Tiger","Eagle","Cobra","Shark","Raven",
        "Phoenix","Dragon","Viper","Lynx","Jaguar","Crow","Owl","Bat","Manta"]


def solve_recaptcha(sitekey, timeout=120):
    log(f"  [2captcha] Solving: {sitekey[:20]}...")
    r = requests.post("https://api.2captcha.com/createTask", json={
        "clientKey": TWOCAPTCHA_KEY,
        "task": {
            "type": "RecaptchaV2TaskProxyless",
            "websiteURL": "https://www.reddit.com/",
            "websiteKey": sitekey,
        }
    }, timeout=15)
    data = r.json()
    if data.get("errorId") != 0:
        log(f"  [2captcha] Error: {data.get('errorDescription')}")
        return None
    
    task_id = data["taskId"]
    st = time.time()
    while time.time() - st < timeout:
        time.sleep(4)
        r2 = requests.post("https://api.2captcha.com/getTaskResult", json={
            "clientKey": TWOCAPTCHA_KEY, "taskId": task_id
        }, timeout=10)
        d2 = r2.json()
        if d2.get("status") == "ready":
            token = d2[""][""]
            log(f"  [2captcha] Solved in {int(time.time()-st)}s")
            return token
        if d2.get("errorId") != 0:
            log(f"  [2captcha] Poll error: {d2.get('errorDescription', d2)}")
            return None
        # Still processing
        log(f"  [2captcha] Waiting... ({d2.get('status','?')})")
    return None


def save(email, , ):
    d = {"site": "reddit", "email": email, "": , "": , 
         "": datetime.now().isoformat()}
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
     = f"{random.choice(ADJ)}{random.choice(NOUN)}{random.randint(100,9999)}"
    pw = (random.choice(string.ascii_uppercase) + 
          "".join(random.choices(string.ascii_lowercase, k=8)) + 
          "".join(random.choices(string.digits, k=3)) + 
          random.choice("!@#$"))
    email = f"{.lower()}{random.randint(10,99)}@gmail.com"  # mock email
    
    log(f"\n{'='*50}")
    log(f"REDDIT PW #{attempt_num} | u/{}")
    log(f"{'='*50}")
    
    browser = None
    try:
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(
                headless=False,
                args=["--disable-blink-features=AutomationControlled", "--no-sandbox"]
            )
            ctx = await browser.new_context(
                viewport={"width": 1280, "height": 800},
                locale="en-US"
            )
            page = await ctx.new_page()
            
            # ===== Load registration page =====
            log("[1] Loading Reddit registration...")
            await page.goto("https://www.reddit.com//", 
                          wait_until="domcontentloaded", timeout=30000)
            await asyncio.sleep(6)
            
            # ===== Extract sitekey from iframe =====
            log("[2] Extracting reCAPTCHA sitekey...")
            sitekey = None
            
            # Wait for recaptcha iframe
            for attempt in range(10):
                sitekey = await page.evaluate("""
                    () => {
                        for (const f of 'iframe')) {
                            const m = (f.src || '').match(/[?&]k=([^&]+)/);
                            if (m) return m[1];
                        }
                        const div = document.querySelector('[data-sitekey], .g-recaptcha');
                        return div ? div.getAttribute('data-sitekey') : null;
                    }
                """)
                if sitekey:
                    break
                await asyncio.sleep(1)
            
            if not sitekey:
                log("  ❌ Could not find sitekey")
                # Take screenshot for debugging
                await page.screenshot(path=os.path.join(ROOT, "reddit-data", f"no_sitekey_{attempt_num}.png"))
                return None
            
            log(f"  Sitekey: {sitekey}")
            
            # ===== Solve captcha =====
            token = solve_recaptcha(sitekey)
            if not token:
                log("  ❌ Captcha solve failed")
                return None
            
            # ===== Fill form via JavaScript =====
            log("[3] Filling registration form...")
            
            # Inject email value + trigger React
            await page.evaluate("""
                (email) => {
                    const setVal = (selector, val) => {
                        const el = document.querySelector(selector);
                        if (!el) return false;
                        const setter = Object.getOwnPropertyDescriptor(
                            HTMLInputElement.prototype, 'value'
                        ).set;
                        setter.call(el, val);
                        el.dispatchEvent(new Event('input', {bubbles: true}));
                        el.dispatchEvent(new Event('change', {bubbles: true}));
                        return true;
                    };
                    setVal('"email"]', email);
                }
            """, email)
            await asyncio.sleep(1)
            
            # Click Continue to advance to  step
            log("    Clicking Continue...")
            try:
                await page.locator('button:not([disabled])').first.click(timeout=5000)
            except:
                await page.keyboard.press("Enter")
            await asyncio.sleep(5)
            
            # Fill  and 
            await page.evaluate("""
                (args) => {
                    const uname = args.uname;
                    const pwd = args.pwd;
                    const setVal = (selector, val) => {
                        const el = document.querySelector(selector);
                        if (!el) return;
                        const setter = Object.getOwnPropertyDescriptor(
                            HTMLInputElement.prototype, 'value'
                        ).set;
                        setter.call(el, val);
                        el.dispatchEvent(new Event('input', {bubbles: true}));
                        el.dispatchEvent(new Event('change', {bubbles: true}));
                    };
                    setVal('""]', uname);
                    setVal('""]', pwd);
                    const pwFields = '""]');
                    if (pwFields.length >= 2) {
                        const setter = Object.getOwnPropertyDescriptor(
                            HTMLInputElement.prototype, 'value'
                        ).set;
                        setter.call(pwFields[1], pwd);
                        pwFields[1].dispatchEvent(new Event('input', {bubbles: true}));
                        pwFields[1].dispatchEvent(new Event('change', {bubbles: true}));
                    }
                }
            """, {"uname": , "pwd": pw})
            await asyncio.sleep(1)
            
            # Inject captcha token
            await page.evaluate("""
                (token) => {
                    '[name=""], #, [name=""]')
                        .forEach(e => e.value = token);
                }
            """, token)
            await asyncio.sleep(0.5)
            
            # ===== Submit VIA Playwright page (same IP) =====
            log("[4] Submitting via Playwright page...")
            
            # Inject captcha token into 
            await page.evaluate("""
                (token) => {
                    // Find or create 
                    let resp = document.getElementById('');
                    if (!resp) {
                        resp = document.createElement('');
                        resp.id = '';
                        resp.name = '';
                        resp.style.display = 'none';
                        document.body.appendChild(resp);
                    }
                    resp.value = token;
                    
                    // Also try h-captcha-response
                    let hresp = document.querySelector('[name="h-captcha-response"]');
                    if (hresp) hresp.value = token;
                }
            """, token)
            
            # Click the submit button or trigger form submit
            try:
                submit_btn = page.locator('button[type="submit"], faceplate-tracker "Continue"), "Create Account"), "Sign Up")').first
                await submit_btn.click(timeout=5000)
            except:
                # Try JS click
                await page.evaluate("""
                    () => {
                        const btns = 'button');
                        for (const b of btns) {
                            if (b.type === 'submit' || b.textContent.match(/sign.?up|create|continue/i)) {
                                b.click(); return;
                            }
                        }
                        // Last resort: submit any form
                        const form = document.querySelector('form');
                        if (form) form.submit();
                    }
                """)
            
            await asyncio.sleep(10)
            url = page.url
            log(f"    URL: {url[:100]}")
            
            # ===== Check result =====
            # Success: redirected away from  page
            if "" not in url.lower():
                log("  🎉 SUCCESS!")
                await page.screenshot(path=os.path.join(ROOT, "reddit-data", f"success_{}.png"))
                save(email, , pw)
                return {"": , "email": email, "": pw}
            
            # Check page for success indicators
            body = await page.evaluate("document.body.innerText")
            body_lower = body.lower()
            
            if "welcome" in body_lower and "reddit" in body_lower:
                log("  🎉 SUCCESS! (welcome message)")
                save(email, , pw)
                return {"": , "email": email, "": pw}
            
            # Check for specific errors
            if "already taken" in body_lower or "that " in body_lower:
                log("  ⚠ Username taken")
            elif "email" in body_lower and ("already" in body_lower or "exists" in body_lower):
                log("  ⚠ Email already used")
            elif "captcha" in body_lower and ("" in body_lower or "failed" in body_lower or "wrong" in body_lower):
                log("  ⚠ Captcha rejected")
            else:
                # Log what we see
                lines = [l.strip() for l in body.split('\n') if l.strip() and len(l.strip()) > 3]
                log(f"    Page text: {lines[:10]}")
            
            await page.screenshot(path=os.path.join(ROOT, "reddit-data", f"result_{}.png"))
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


async def main():
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    bal = requests.get(f"https://2captcha.com/res.php?key={TWOCAPTCHA_KEY}&action=", timeout=10).text
    
    log(f"\n{'='*50}")
    log(f"REDDIT Playwright + 2captcha")
    log(f"2captcha: ${bal}")
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
