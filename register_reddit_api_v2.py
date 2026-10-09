# -*- coding: utf-8 -*-
"""
_reddit_api_v2.py — Reddit API Registration (NO UI, NO email)
Gets sitekey from Playwright page, solves via 2capcha, submits via API.
"""
import asyncio, json, os, random, string, sys, time
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

ADJ = ["Cool","Swift","Brave","Dark","Lucky","Wild","Epic","Neon","Cyber","Zen",
       "Mega","Ultra","Super","Alpha","Omega","Nova","Star","Blaze","Storm"]
NOUN = ["Fox","Wolf","Hawk","Bear","Lion","Tiger","Eagle","Cobra","Shark","Raven",
        "Phoenix","Dragon","Viper","Lynx","Jaguar","Crow","Owl","Bat","Manta"]


def solve_recaptcha(sitekey, timeout=120):
    log(f"  [2captcha] Solving {sitekey[:20]}...")
    r = requests.post("https://api.2captcha.com/createTask", json={
        "clientKey": TWOCAPTCHA_KEY,
        "task": {
            "type": "RecaptchaV2EnterpriseTaskProxyless",
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
            log(f"  [2captcha] OK ({int(time.time()-st)}s)")
            return token
        if d2.get("errorId") != 0:
            log(f"  [2captcha] Fail: {d2.get('errorDescription')}")
            return None
    return None


async def get_sitekey():
    """Extract reCAPTCHA sitekey from Reddit registration page."""
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=False)
        page = await browser.new_page()
        await page.goto("https://www.reddit.com//", timeout=30000, wait_until="domcontentloaded")
        await asyncio.sleep(6)
        
        for _ in range(10):
            sitekey = await page.evaluate("""
                () => {
                    for (const f of 'iframe')) {
                        const m = (f.src || '').match(/[?&]k=([^&]+)/);
                        if (m) return m[1];
                    }
                    return null;
                }
            """)
            if sitekey:
                await browser.close()
                return sitekey
            await asyncio.sleep(1)
        
        await browser.close()
        return None


def (sitekey):
    """Register account via Reddit API (no email)."""
     = f"{random.choice(ADJ)}{random.choice(NOUN)}{random.randint(100,9999)}"
    pw = (random.choice(string.ascii_uppercase) + 
          "".join(random.choices(string.ascii_lowercase, k=8)) + 
          "".join(random.choices(string.digits, k=3)) + 
          random.choice("!@#$"))
    
    log(f"\n{'='*50}")
    log(f"u/{}")
    log(f"{'='*50}")
    
    # Solve captcha
    token = solve_recaptcha(sitekey)
    if not token: return None
    
    # Register via API
    log(f"  [Reddit] Registering...")
    
    # Fresh session with cookies from home page
    s = requests.Session()
    s.headers.update({
        "": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36",
        "Origin": "https://www.reddit.com",
        "Referer": "https://www.reddit.com//",
    })
    try: s.get("https://www.reddit.com/", timeout=10)
    except: pass
    
    data = {
        "op": "reg",
        "user": ,
        "passwd": pw,
        "passwd2": pw,
        "captcha": token,
        "api_type": "json",
    }
    
    for attempt in range(3):
        try:
            r = s.post("https://www.reddit.com/api/", data=data, timeout=30)
            resp = r.json()
            errors = resp.get("json", {}).get("errors", [])
            
            if not errors:
                log(f"  🎉 SUCCESS! u/{}")
                save(, pw)
                return {"": , "": pw}
            
            for err in errors:
                t, m = err[0], err[1] if len(err) > 1 else ""
                log(f"  [{t}] {m}")
                
                if t == "RATELIMIT":
                    log(f"  Rate limited, waiting 30s...")
                    time.sleep(30)
                    continue
                if "BAD_CAPTCHA" in t:
                    return None  # Don't retry — need fresh captcha
                if "TAKEN" in t or "taken" in m:
                    return None  # Username taken
            return None
        except Exception as e:
            log(f"  Network error: {e}")
            time.sleep(3)
    return None


def save(, pw):
    d = {"site": "reddit", "": , "": pw, 
         "": datetime.now().isoformat()}
    a = []
    if os.path.exists(ACCOUNTS):
        try:
            with open(ACCOUNTS, "r", encoding="utf-8") as f: a = json.load(f)
        except: a = []
    a.append(d)
    with open(ACCOUNTS, "w", encoding="utf-8") as f: json.dump(a, f, indent=2)
    log(f"  💾 Saved")


async def main():
    # Get balance
    try:
        bal = requests.get(f"https://2captcha.com/res.php?key={TWOCAPTCHA_KEY}&action=", timeout=10).text
    except:
        bal = "?"
    
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 3
    
    log(f"\n{'='*50}")
    log(f"REDDIT API v2 | 2captcha: ${bal} | count: {count}")
    log(f"{'='*50}")
    
    # Extract sitekey once
    log("[0] Extracting sitekey...")
    sitekey = await get_sitekey()
    if not sitekey:
        log("  ❌ Failed to get sitekey")
        return
    log(f"  Sitekey: {sitekey}")
    
    results = []
    for i in range(1, count + 1):
        r = (sitekey)
        if r: results.append(r); log(f"✅ u/{r['']}")
        else: log(f"❌ FAILED")
        log(f"Progress: {len(results)}/{i}")
        
        if i < count:
            wait = random.randint(8, 15)
            log(f"  Cooling {wait}s...")
            time.sleep(wait)
    
    log(f"\n{'='*50}")
    log(f"DONE: {len(results)}/{count}")
    for r in results:
        log(f"  u/{r['']} | {r['']}")
    log(f"  Saved to: reddit-data/.json")
    log(f"{'='*50}")


if __name__ == "__main__":
    asyncio.run(main())
