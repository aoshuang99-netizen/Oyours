# -*- coding: utf-8 -*-
"""
_discord_batch.py — Discord 批量注册
Playwright cookies → API rqdata → 2captcha hCaptcha → API 
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

TWOCAPTCHA_KEY = "ec6ff4cca146b810a53ad5d6f7d59ff1"
SITEKEY = "a9b5fb07-92ff-493f-86fe-352a2803b3df"

ADJ = ["Cool","Swift","Brave","Dark","Lucky","Wild","Epic","Neon","Cyber","Zen",
       "Mega","Ultra","Super","Alpha","Omega","Nova","Star","Blaze","Storm"]
NOUN = ["Fox","Wolf","Hawk","Bear","Lion","Tiger","Eagle","Cobra","Shark","Raven",
        "Phoenix","Dragon","Viper","Lynx","Jaguar","Crow","Owl","Bat","Manta"]

def log(msg): print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


async def get_discord_session():
    """Launch Playwright, get cookies and x-super-properties."""
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            proxy={"server": "socks5://:10808"},
            args=["--disable-blink-features=AutomationControlled", "--no-sandbox"]
        )
        ctx = await browser.new_context(locale="en-US")
        page = await ctx.new_page()
        await page.goto("https://discord.com/", wait_until="domcontentloaded")
        await asyncio.sleep(4)
        
        cookies = await ctx.cookies()
        xsp = await page.evaluate("""
            () => JSON.stringify({
                os:"Windows", browser:"Chrome", device:"",
                system_locale:"en-US", browser_user_agent:navigator.userAgent,
                browser_version:"125.0.0.0", os_version:"10",
                referrer:"", referring_domain:"", referrer_current:"",
                referring_domain_current:"", release_channel:"stable",
                client_build_number:300000, client_event_source:null
            })
        """)
        await browser.close()
        return cookies, xsp


async def _one(attempt):
     = f"{random.choice(ADJ)}{random.choice(NOUN)}{random.randint(100,999)}"
    passwd = (random.choice(string.ascii_uppercase) +
              "".join(random.choices(string.ascii_lowercase, k=12)) + "123!")
    email = f"{.lower()}@gmail.com"
    mo, dy, yr = random.randint(1, 12), random.randint(1, 28), random.randint(1985, 2000)
    dob = f"{yr:04d}-{mo:02d}-{dy:02d}"

    log(f"\n{'='*50}")
    log(f"DISCORD #{attempt} | {}")
    log(f"{'='*50}")

    # Get fresh session
    cookies, xsp = await get_discord_session()

    s = requests.Session()
    for c in cookies:
        s.cookies.set(c["name"], c["value"], domain=c.get("domain", ".discord.com"))
    s.headers.update({
        "": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125.0.0.0 Safari/537.36",
        "": "application/json",
        "Origin": "https://discord.com",
        "Referer": "https://discord.com/",
        "X-Super-Properties": xsp,
    })

    # Step 1: Get rqdata
    log("[1] Getting rqdata...")
    r = s.post("https://discord.com/api/v9/auth/", json={
        "consent": True, "date_of_birth": dob,
        "email": email, "": passwd, "": ,
        "": None, "promotional_email_opt_in": False,
    }, timeout=30)

    resp = r.json()
    rqdata = resp.get("captcha_rqdata", "")
    rqtoken = resp.get("", "")

    if not rqdata:
        log(f"  No rqdata: {json.dumps(resp)[:200]}")
        return None

    # Step 2: Solve hCaptcha
    log("[2] Solving hCaptcha (2captcha)...")
    create = requests.post("https://api.2captcha.com/createTask", json={
        "clientKey": TWOCAPTCHA_KEY,
        "task": {
            "type": "HCaptchaTaskProxyless",
            "websiteURL": "https://discord.com/",
            "websiteKey": SITEKEY,
            "data": rqdata,
        }
    }, timeout=15)

    if create.json().get("errorId") != 0:
        log(f"  2captcha error: {create.json().get('errorDescription')}")
        return None

    task_id = create.json()["taskId"]
    log(f"  Task: {task_id}")

    token = None
    st = time.time()
    while time.time() - st < 300:
        time.sleep(5)
        r2 = requests.post("https://api.2captcha.com/getTaskResult", json={
            "clientKey": TWOCAPTCHA_KEY, "taskId": task_id
        }, timeout=10)
        d2 = r2.json()
        elapsed = int(time.time() - st)
        if d2.get("status") == "ready":
            token = d2[""][""]
            log(f"  Solved! ({elapsed}s)")
            break
        if d2.get("status") == "processing":
            if elapsed % 30 == 0:
                log(f"  Waiting... ({elapsed}s)")
            continue
        log(f"  Error: {d2.get('errorDescription','unknown')}")
        return None

    if not token:
        log("  Timeout")
        return None

    # Step 3: Register
    log("[3] Registering...")
    r3 = s.post("https://discord.com/api/v9/auth/", json={
        "consent": True, "date_of_birth": dob,
        "email": email, "": passwd, "": ,
        "": token,
        "": rqtoken,
        "promotional_email_opt_in": False,
    }, timeout=30)

    resp3 = r3.json()

    if "token" in resp3:
        log(f"  🎉 SUCCESS! Token: {resp3['token'")
        save(, passwd, email, resp3.get("token", ""))
        return {"": , "": passwd, "email": email}

    # Check errors
    errors = resp3.get("", []) if isinstance(resp3.get(""), list) else []
    if errors:
        log(f"  Captcha error: {errors}")
    if "email" in resp3 and isinstance(resp3["email"], list):
        log(f"  Email error: {resp3['email']}")
    if "" in resp3 and isinstance(resp3[""], list):
        log(f"  Username error: {resp3['']}")

    log(f"  Response: {json.dumps(resp3)[:300]}")
    return None


def save(, passwd, email, token):
    d = {"site": "discord", "": , "": passwd,
         "email": email, "token": token[:30], "": datetime.now().isoformat()}
    a = []
    if os.path.exists(ACCOUNTS):
        try:
            with open(ACCOUNTS, "r", encoding="utf-8") as f: a = json.load(f)
        except: a = []
    a.append(d)
    with open(ACCOUNTS, "w", encoding="utf-8") as f: json.dump(a, f, indent=2)
    log(f"  💾 Saved ({len(a)} total Discord )")


async def main():
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 10
    bal = requests.get(f"https://2captcha.com/res.php?key={TWOCAPTCHA_KEY}&action=", timeout=10).text

    log(f"\n{'='*50}")
    log(f"DISCORD BATCH REGISTRATOR")
    log(f"Target: {count}  | 2captcha: ${bal}")
    log(f"{'='*50}")

    results = []
    for i in range(1, count + 1):
        r = await _one(i)
        if r:
            results.append(r)
            log(f"✅ u/{r['']}")
        else:
            log(f"❌ FAILED")
        log(f"Progress: {len(results)}/{i}")

        if i < count:
            w = random.randint(8, 15)
            log(f"  Cooling {w}s...")
            await asyncio.sleep(w)

    log(f"\n{'='*50}")
    log(f"DONE: {len(results)}/{count}")
    for r in results:
        log(f"  u/{r['']} | {r['']}")
    log(f"  Saved: discord-data/.json")
    log(f"{'='*50}")


if __name__ == "__main__":
    asyncio.run(main())
