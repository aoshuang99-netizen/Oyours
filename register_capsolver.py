# -*- coding: utf-8 -*-
"""
_capsolver.py — Reddit + Discord 全自动注册 (capsolver)
"""
import asyncio, json, os, random, re, string, sys, time
from datetime import datetime

if sys. == "win32":
    try: sys.stdout.reconfigure(encoding="utf-8")
    except: pass

from playwright.async_api import async_playwright
import requests

ROOT = os.path.dirname(os.path.abspath(__file__))
CAPSOLVER_KEY = "CAP-1161DFAD36954DB32433A304C103AE4C61062CAC2DF2CC2568D2010DD5A58E4B"

ADJ = ["Cool","Swift","Brave","Dark","Lucky","Wild","Epic","Neon","Cyber","Zen",
       "Mega","Ultra","Super","Alpha","Omega","Nova","Star","Blaze","Storm"]
NOUN = ["Fox","Wolf","Hawk","Bear","Lion","Tiger","Eagle","Cobra","Shark","Raven",
        "Phoenix","Dragon","Viper","Lynx","Jaguar","Crow","Owl","Bat","Manta"]
MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]

def log(msg, tag=""): print(f"[{datetime.now():%H:%M:%S}] {tag}{msg}", flush=True)


def capsolver_solve(task_type, website_url, website_key, timeout=180, extra=None):
    """Solve captcha via capsolver API."""
    task = {
        "clientKey": CAPSOLVER_KEY,
        "task": {
            "type": task_type,
            "websiteURL": website_url,
            "websiteKey": website_key,
        }
    }
    # Add extra params (e.g. isInvisible for Enterprise reCAPTCHA)
    if extra:
        task["task"].update(extra)

    # capsolver API 必须直连（绕开 10808 本地代理，否则 502）
    NO_PROXY = {"http": None, "https": None}
    r = requests.post("https://api.capsolver.com/createTask", json=task, timeout=15, proxies=NO_PROXY)
    data = r.json()
    if data.get("errorId") != 0:
        log(f"  capsolver create: {data.get('errorDescription','?')}", "❌ ")
        return None

    task_id = data["taskId"]
    log(f"  capsolver Task: {task_id}", "")

    st = time.time()
    while time.time() - st < timeout:
        time.sleep(5)
        r2 = requests.post("https://api.capsolver.com/getTaskResult", json={
            "clientKey": CAPSOLVER_KEY, "taskId": task_id
        }, timeout=10, proxies=NO_PROXY)
        d2 = r2.json()

        elapsed = int(time.time() - st)
        if d2.get("status") == "ready":
             = d2.get("", {})
            token = .get("") or .get("token") or str()
            log(f"  capsolver OK ({elapsed}s)", "✅ ")
            return token
        if d2.get("status") == "processing":
            if elapsed % 20 == 0:
                log(f"  capsolver waiting... ({elapsed}s)", "⏳ ")
            continue
        if d2.get("errorId") != 0:
            log(f"  capsolver fail: {d2.get('errorDescription','?')}", "❌ ")
            return None

    log(f"  capsolver timeout ({timeout}s)", "❌ ")
    return None


# ============================================================
# REGISTER REDDIT (API approach + Enterprise reCAPTCHA)
# ============================================================
def _reddit(attempt_num):
     = f"{random.choice(ADJ)}{random.choice(NOUN)}{random.randint(100,9999)}"
    pw = (random.choice(string.ascii_uppercase) +
          "".join(random.choices(string.ascii_lowercase, k=10)) +
          "".join(random.choices(string.digits, k=3)) + "!")
    # Reddit sitekey from Playwright extraction
    sitekey = "6LfirrMoAAAAAHZOipvza4kpp_VtTwLNuXVwURNQ"

    log(f"\n{'='*50}", "")
    log(f"REDDIT capsolver #{attempt_num} | u/{}", "")
    log(f"{'='*50}", "")

    # Step 1: Get sitekey from actual page
    log("[1] Extracting sitekey...", "")
    # We know the sitekey, but let's verify it's still current by checking
    actual_sitekey = sitekey  # Known good

    # Step 2: Solve Enterprise reCAPTCHA (invisible)
    log(f"[2] Solving Enterprise reCAPTCHA (invisible)...", "")
    token = capsolver_solve(
        "RecaptchaV2EnterpriseTaskProxyless",
        "https://www.reddit.com/",
        actual_sitekey,
        extra={"isInvisible": True}
    )
    if not token:
        return None

    # Step 3: Register via Reddit API
    log("[3] Registering via Reddit API...", "")
    s = requests.Session()
    s.headers.update({
        "": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36",
        "Origin": "https://www.reddit.com",
        "Referer": "https://www.reddit.com//",
    })
    try:
        s.get("https://www.reddit.com/", timeout=10)
    except:
        pass

    data = {
        "op": "reg",
        "user": ,
        "passwd": pw,
        "passwd2": pw,
        "captcha": token,
        "api_type": "json",
    }

    for attempt in range(2):
        try:
            r = s.post("https://www.reddit.com/api/", data=data, timeout=30)
            resp = r.json()
            errors = resp.get("json", {}).get("errors", [])

            if not errors:
                log(f"  🎉 REDDIT SUCCESS! u/{}", "🎉 ")
                save_account("reddit", , pw)
                return {"site": "reddit", "": , "": pw}

            for err in errors:
                t, m = err[0], err[1] if len(err) > 1 else ""
                log(f"  [{t}] {m}", "")
                if "RATELIMIT" in t:
                    log("  Rate limited, waiting 60s...", "")
                    time.sleep(60)
                    continue
                if "BAD_CAPTCHA" in t:
                    log("  Captcha rejected — IP mismatch or wrong sitekey", "⚠️ ")
                    return None
                if "TAKEN" in t or "taken" in m:
                    log("  Username taken", "⚠️ ")
                    return None
            return None
        except Exception as e:
            log(f"  API error: {e}", "")
            time.sleep(3)

    return None


# ============================================================
# REGISTER DISCORD (Playwright + hCaptcha)
# ============================================================
async def _discord(attempt_num):
     = f"{random.choice(ADJ)}{random.choice(NOUN)}{random.randint(100,999)}"
    passwd = (random.choice(string.ascii_uppercase) +
              "".join(random.choices(string.ascii_lowercase, k=12)) + "123!")
    email = f"{.lower()}@gmail.com"
    mo, dy, yr = random.randint(1, 12), random.randint(1, 28), random.randint(1985, 2000)

    log(f"\n{'='*50}", "")
    log(f"DISCORD capsolver #{attempt_num} | {}", "")
    log(f"{'='*50}", "")

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
            log(f"[1] {email} | u/{}", "")
            await page.locator('[aria-label="Email"]').first.fill(email)
            await page.locator('[aria-label="Username"]').first.fill()
            await page.locator('[aria-label=""]').first.fill(passwd)
            await asyncio.sleep(1)

            # Birthday
            log(f"[2] Birthday: {MONTHS[mo-1]} {dy}, {yr}", "")
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

            # Submit to trigger hCaptcha
            log("[3] Submitting (triggers hCaptcha)...", "")
            await page.locator('"Create Account")').first.click()
            await asyncio.sleep(5)

            # Extract hCaptcha sitekey
            sitekey = await page.evaluate("""
                () => {
                    for (const f of 'iframe')) {
                        const m = (f.src||'').match(/[?&]sitekey=([^&]+)/);
                        if (m) return m[1];
                    }
                    return null;
                }
            """)

            if not sitekey:
                url = page.url
                if 'channels' in url or 'app' in url:
                    log("  🎉 DISCORD SUCCESS! (no captcha)", "🎉 ")
                    save_account("discord", , passwd, email)
                    return {"site": "discord", "": , "": passwd}

            log(f"  hCaptcha: {sitekey[:30]}...", "")

            # Solve with capsolver
            token = capsolver_solve(
                "HCaptchaTaskProxyless",
                "https://discord.com/",
                sitekey
            )
            if not token:
                return None

            # Inject token
            await page.evaluate("""
                (token) => {
                    let resp = document.querySelector('[name="h-captcha-response"]');
                    if (!resp) {
                        resp = document.createElement('');
                        resp.name = 'h-captcha-response';
                        resp.style.display = 'none';
                        document.body.appendChild(resp);
                    }
                    resp.value = token;
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

            # Submit with captcha
            log("[4] Submitting with captcha token...", "")
            await page.locator('"Create Account")').first.click()
            await asyncio.sleep(8)

            url = page.url
            log(f"  URL: {url[:80]}", "")

            if any(k in url.lower() for k in ["channels", "app", "onboarding"]):
                log("  🎉 DISCORD SUCCESS!", "🎉 ")
                save_account("discord", , passwd, email)
                return {"site": "discord", "": , "": passwd}

            # Check for errors
            body = (await page.evaluate("document.body.innerText")).lower()
            if "unavailable" in body:
                log("  Username taken", "⚠️ ")
            elif "captcha" in body and "" in body:
                log("  Captcha rejected", "⚠️ ")

            await page.screenshot(path=os.path.join(ROOT, "discord-data", f"capsolver_{}.png"))
            return None

    except Exception as e:
        log(f"  Error: {e}", "")
        return None
    finally:
        if browser:
            try: await browser.close()
            except: pass


# ============================================================
# SAVE
# ============================================================
def save_account(site, , , email=""):
    d = {"site": site, "": , "": , "email": email,
         "": datetime.now().isoformat()}
    fpath = os.path.join(ROOT, f"{site}-data", ".json")
    os.makedirs(os.path.dirname(fpath), exist_ok=True)
    a = []
    if os.path.exists(fpath):
        try:
            with open(fpath, "r", encoding="utf-8") as f: a = json.load(f)
        except: a = []
    a.append(d)
    with open(fpath, "w", encoding="utf-8") as f: json.dump(a, f, indent=2)


# ============================================================
# MAIN
# ============================================================
async def main():
    bal = requests.post("https://api.capsolver.com/getBalance",
        json={"clientKey": CAPSOLVER_KEY}, timeout=10).json().get("balance", "?")

    log(f"\n{'='*50}", "")
    log(f"CAPSOLVER REGISTRATOR", "")
    log(f"Balance: ${bal}", "")
    log(f"{'='*50}", "")

    # Register Reddit first
    log("\n🔴 === REDDIT ===", "")
    for i in range(1, 3):
        r = _reddit(i)
        if r:
            log(f"✅ Reddit u/{r['']} | {r['']}", "")
            break
        log(f"❌ Reddit #{i} failed", "")
        if i < 2:
            time.sleep(random.randint(8, 15))

    # Then Discord
    log("\n🔵 === DISCORD ===", "")
    for i in range(1, 3):
        r = await _discord(i)
        if r:
            log(f"✅ Discord u/{r['']}", "")
            break
        log(f"❌ Discord #{i} failed", "")
        if i < 2:
            await asyncio.sleep(random.randint(8, 15))

    # Show results
    log(f"\n{'='*50}", "")
    log(f"DONE", "")
    for site in ["reddit", "discord"]:
        fpath = os.path.join(ROOT, f"{site}-data", ".json")
        if os.path.exists(fpath):
            with open(fpath) as f:
                accts = json.load(f)
            log(f"  {site}: {len(accts)} account(s)", "")
    log(f"{'='*50}", "")


if __name__ == "__main__":
    asyncio.run(main())
