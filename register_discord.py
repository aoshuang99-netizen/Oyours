# -*- coding: utf-8 -*-
"""
_discord.py — Discord 全自动注册 (hCaptcha via 2captcha)
Birthday 下拉框使用 keyboard typing 交互。
"""
import asyncio, json, os, random, string, sys, time
from datetime import datetime

if sys. == "win32":
    try: sys.stdout.reconfigure(encoding="utf-8")
    except: pass

from playwright.async_api import async_playwright
import requests

ROOT = os.path.dirname(os.path.abspath(__file__))
ACCOUNTS = os.path.join(ROOT, "discord-data", ".json")
os.makedirs(os.path.dirname(ACCOUNTS), exist_ok=True)

def log(msg): print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)

TWOCAPTCHA_KEY = "ec6ff4cca146b810a53ad5d6f7d59ff1"

ADJ = ["Cool","Swift","Brave","Dark","Lucky","Wild","Epic","Neon","Cyber","Zen",
       "Mega","Ultra","Super","Alpha","Omega","Nova","Star","Blaze","Storm"]
NOUN = ["Fox","Wolf","Hawk","Bear","Lion","Tiger","Eagle","Cobra","Shark","Raven",
        "Phoenix","Dragon","Viper","Lynx","Jaguar","Crow","Owl","Bat","Manta"]
MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]


def solve_(sitekey, page_url="https://discord.com/", timeout=180):
    """Solve hCaptcha via 2captcha."""
    log(f"  [2captcha] Solving hCaptcha: {sitekey[:20]}...")
    r = requests.post("https://api.2captcha.com/createTask", json={
        "clientKey": TWOCAPTCHA_KEY,
        "task": {
            "type": "HCaptchaTaskProxyless",
            "websiteURL": page_url,
            "websiteKey": sitekey,
        }
    }, timeout=15)
    data = r.json()
    if data.get("errorId") != 0:
        log(f"  [2captcha] Create error: {data.get('errorDescription')}")
        return None
    
    task_id = data["taskId"]
    log(f"  [2captcha] Task: {task_id}")
    st = time.time()
    while time.time() - st < timeout:
        try: time.sleep(5)
        except: return None
        r2 = requests.post("https://api.2captcha.com/getTaskResult", json={
            "clientKey": TWOCAPTCHA_KEY, "taskId": task_id
        }, timeout=10)
        d2 = r2.json()
        elapsed = int(time.time() - st)
        if d2.get("status") == "ready":
            token = d2[""][""]
            log(f"  [2captcha] OK ({elapsed}s)")
            return token
        if d2.get("status") == "processing":
            if elapsed % 15 == 0:
                log(f"  [2captcha] Still waiting... ({elapsed}s)")
            continue
        if d2.get("errorId") != 0:
            log(f"  [2captcha] Fail ({elapsed}s): {d2.get('errorDescription')}")
            return None
    log(f"  [2captcha] Timeout after {timeout}s")
    return None


async def do_(attempt_num):
     = f"{random.choice(ADJ)}{random.choice(NOUN)}{random.randint(100,999)}"
    passwd = (random.choice(string.ascii_uppercase) + 
              "".join(random.choices(string.ascii_lowercase, k=12)) + 
              "123!")
    email = f"{.lower()}@gmail.com"
    mo, dy, yr = random.randint(1, 12), random.randint(1, 28), random.randint(1985, 2000)
    
    log(f"\n{'='*50}")
    log(f"DISCORD #{attempt_num} | {}")
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
            
            await page.goto("https://discord.com/", wait_until="domcontentloaded")
            await asyncio.sleep(4)
            
            # Fill form
            log(f"[1] {email} | u/{}")
            await page.locator('[aria-label="Email"]').first.fill(email)
            await page.locator('[aria-label="Username"]').first.fill()
            await page.locator('[aria-label=""]').first.fill(passwd)
            await asyncio.sleep(1)
            
            # Birthday via keyboard typing
            log(f"[2] Birthday: {MONTHS[mo-1]} {dy}, {yr}")
            await page.locator('.month_b0f4cc .selectButton__0edde').click()
            await asyncio.sleep(0.5)
            await page.keyboard.type(MONTHS[mo-1], delay=30)
            await asyncio.sleep(0.3)
            await page.keyboard.press('Enter')
            await asyncio.sleep(0.5)
            
            await page.locator('.day_b0f4cc .selectButton__0edde').click()
            await asyncio.sleep(0.5)
            await page.keyboard.type(str(dy), delay=30)
            await asyncio.sleep(0.3)
            await page.keyboard.press('Enter')
            await asyncio.sleep(0.5)
            
            await page.locator('.year_b0f4cc .selectButton__0edde').click()
            await asyncio.sleep(0.5)
            await page.keyboard.type(str(yr), delay=30)
            await asyncio.sleep(0.3)
            await page.keyboard.press('Enter')
            await asyncio.sleep(0.5)
            
            # Submit first time → triggers hCaptcha
            log("[3] Clicking Create Account...")
            await page.locator('"Create Account")').first.click()
            await asyncio.sleep(5)
            
            # Check for hCaptcha
            sitekey = await page.evaluate("""
                () => {
                    for (const f of 'iframe')) {
                        const m = (f.src||'').match(/[?&]sitekey=([^&]+)/);
                        if (m) return m[1];
                    }
                    const d = document.querySelector('[data-sitekey]');
                    return d ? d.getAttribute('data-sitekey') : null;
                }
            """)
            
            if not sitekey:
                # Maybe already succeeded
                url = page.url
                if 'channels' in url or 'app' in url or 'onboarding' in url:
                    log("  🎉 SUCCESS!")
                    save(email, , passwd)
                    return {"email": email, "": , "": passwd}
                log("  ⚠ No hCaptcha, but not redirected")
                return None
            
            log(f"  hCaptcha: {sitekey[:30]}...")
            
            # Solve captcha
            token = solve_(sitekey)
            if not token:
                log("  ❌ Captcha failed")
                return None
            
            # Inject captcha token
            await page.evaluate("""
                (token) => {
                    // Inject into h-captcha-response
                    let resp = document.querySelector('[name="h-captcha-response"]');
                    if (!resp) {
                        resp = document.createElement('');
                        resp.name = 'h-captcha-response';
                        resp.style.display = 'none';
                        document.body.appendChild(resp);
                    }
                    resp.value = token;
                    
                    // Also try 
                    let gresp = document.getElementById('');
                    if (!gresp) {
                        gresp = document.createElement('');
                        gresp.id = '';
                        gresp.name = '';
                        gresp.style.display = 'none';
                        document.body.appendChild(gresp);
                    }
                    gresp.value = token;
                }
            """, token)
            await asyncio.sleep(1)
            
            # Submit again
            log("[4] Submitting with captcha...")
            await page.locator('"Create Account")').first.click()
            await asyncio.sleep(8)
            
            url = page.url
            log(f"  URL: {url[:80]}")
            
            # Check result
            if any(k in url.lower() for k in ["channels", "app", "onboarding"]):
                log("  🎉 SUCCESS!")
                save(email, , passwd)
                return {"email": email, "": , "": passwd}
            
            # Check for errors
            body = (await page.evaluate("document.body.innerText")).lower()
            if "unavailable" in body:
                log("  ⚠ Username taken")
                return None
            if "captcha" in body and ("" in body or "failed" in body):
                log("  ⚠ Captcha rejected")
                return None
            
            # Try "Continue" button if it appears (Discord redirects to verify)
            try:
                await page.locator('"Continue"), "Verify")').first.click(timeout=3000)
                await asyncio.sleep(5)
                url = page.url
                if any(k in url.lower() for k in ["channels", "app"]):
                    log("  🎉 SUCCESS! (after Continue)")
                    save(email, , passwd)
                    return {"email": email, "": , "": passwd}
            except:
                pass
            
            await page.screenshot(path=os.path.join(ROOT, "discord-data", f"debug_{}.png"))
            log("  📸 Screenshot saved")
            return None
            
    except Exception as e:
        log(f"  Error: {e}")
        import traceback; traceback.print_exc()
        return None
    finally:
        if browser:
            try: await browser.close()
            except: pass


def save(email, , passwd):
    d = {"site": "discord", "email": email, "": , "": passwd,
         "": datetime.now().isoformat()}
    a = []
    if os.path.exists(ACCOUNTS):
        try:
            with open(ACCOUNTS, "r", encoding="utf-8") as f: a = json.load(f)
        except: a = []
    a.append(d)
    with open(ACCOUNTS, "w", encoding="utf-8") as f: json.dump(a, f, indent=2)
    log(f"  💾 Saved")
    return d


async def main():
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    bal = requests.get(f"https://2captcha.com/res.php?key={TWOCAPTCHA_KEY}&action=", timeout=10).text
    
    log(f"\n{'='*50}")
    log(f"DISCORD AUTO REGISTRATOR")
    log(f"2captcha: ${bal}")
    log(f"{'='*50}")
    
    results = []
    for i in range(1, count + 1):
        r = await do_(i)
        if r: results.append(r); log(f"✅ u/{r['']}")
        else: log(f"❌ FAILED")
        log(f"Progress: {len(results)}/{i}")
        if i < count:
            w = random.randint(5, 10)
            log(f"  Cooling {w}s...")
            await asyncio.sleep(w)
    
    log(f"\n{'='*50}\nDONE: {len(results)}/{count}")
    for r in results: log(f"  u/{r['']} | {r['']}")
    log(f"{'='*50}")


if __name__ == "__main__":
    asyncio.run(main())
