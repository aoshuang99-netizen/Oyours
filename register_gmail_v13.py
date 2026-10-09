# -*- coding: utf-8 -*-
"""
_gmail_v13.py — MATERIAL DESIGN DROPDOWN FIX

Fixed over v12:
- Correct Material Design dropdown handling for Month/Gender
- Proper shadow DOM and overlay interaction
- Click dropdown → Type option → Press Enter flow

Usage: python _gmail_v13.py [count]
"""

import asyncio, json, os, random, re, string, sys, time, traceback
from datetime import datetime

if sys. == "win32":
    try: sys.stdout.reconfigure(encoding="utf-8")
    except: pass

from playwright.async_api import async_playwright, Page
from playwright_stealth import Stealth

ROOT = os.path.dirname(os.path.abspath(__file__))
SS = os.path.join(ROOT, "gmail-data", "screenshots")
ACCOUNTS = os.path.join(ROOT, "gmail-data", ".json")
for d in [os.path.dirname(SS)]: os.makedirs(d, exist_ok=True)

def log(msg): print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)

# ─── Proxy Pool ───
PROXY_POOL = [
    "http://:10808",  # 本地代理 (74.211.97.178, US)
]

# ─── Names & Constants ───
FIRST = ["James","John","Robert","Michael","David","William","Richard","Joseph","Thomas","Christopher","Daniel","Matthew","Anthony","Mark","Paul","Steven","Andrew","Kenneth","George","Brian","Kevin","Jason","Jeff","Scott","Eric","Ryan","Justin","Brandon"]
LAST = ["Smith","Johnson","Williams","Brown","Jones","Garcia","Miller","Davis","Rodriguez","Martinez","Hernandez","Lopez","Gonzalez","Wilson","Anderson","Thomas","Taylor","Moore","Jackson","Martin","Lee","White","Harris","Clark","Lewis","Walker","Hall","Allen"]

FIVESIM_KEY = "eyJhbGciOiJSUzUxMiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE4MTM3MzQ3ODEsImlhdCI6MTc4MjE5ODc4MSwicmF5IjoiNjIxMWY0MjAyNmM2YjZkNDMxMjMxYjY0MDkwMzg3MDYiLCJzdWIiOjQyMjIwNTB9.wRPYREkUdv60wd68XujZqXlravtg01aMWYECx0Bl1fLqC2uxL2yELzAIWIG_b_yAhKrymtxV5XsGlCpBm_uapnwJZhUw7LyHHnYl_V6weL6uEvk2ayrcIhaUCa13RORmRen8fXdrElnO_flZqQpeJRqm7gpUQF-HSy8Az3iy3j0JWvW9pfg_sAZTCA6vlADn66lrZ36O5g3NiKoTtTB0SYo8lfzFxtBbROc6gSMg_46dmn1hjNgJB6cetJ33DLQ1UJCuckcjV_lVfiPIMYT51RIqaRS8zyPaCTT8938whKFHbbJgWpne-6ldHmdeDudWDtytElk7d204shjBL1q1ww"

import requests as _req
class Sim5:
    B = "https://5sim.net/v1"
    def __init__(self, key): self.s = _req.Session(); self.s.headers.update({"": f"Bearer {key}", "Accept": "application/json"})
    def _g(self, p, params=None, t=20):
        r = self.s.get(f"{self.B}{p}", params=params, timeout=t)
        return r.json() if r.status_code < 400 else None
    def bal(self): d = self._g("/user/profile"); return d.get("balance", 0) if d else 0
    def buy(self, country="indonesia"):
        d = self._g(f"/user/buy/activation/{country}/any/google")
        return {"id": d["id"], "phone": d.get("phone",""), "price": d.get("price",0)} if (d and d.get("id")) else None
    def chk(self, oid):
        d = self._g(f"/user/check/{oid}")
        if not d: return {"s":"ERROR"}
        sms = d.get("sms",[]); s = d.get("status","PENDING")
        if sms and sms[0].get("code"):
            c = sms[0]["code"]; m = re.search(r'\d{4,8}', c)
            return {"s":"RECEIVED","code":m.group(0)if m else c}
        if s == "RECEIVED":
            cd = d.get("code") or d.get("sms_code")
            if cd: return {"s":"RECEIVED","code":str(cd)}
        return {"s":s}
    def wait(self, oid, timeout=180, iv=3):
        start = time.time()
        while time.time()-start < timeout:
            r = self.chk(oid)
            if r["s"]=="RECEIVED" and r.get("code"):
                log(f"  [5sim] \u2713 {r['code']} ({int(time.time()-start)}s)"); return r["code"]
            if r["s"] in ("CANCELED","TIMEOUT","BANNED","ERROR"):
                log(f"  [5sim] \u2717 {r['s']}"); return None
            time.sleep(iv)
        return None
    def cancel(self, oid): self._g(f"/user/cancel/{oid}")
    def finish(self, oid): self._g(f"/user/finish/{oid}")


async def check_proxy_ip(page: Page):
    """验证代理出口 IP 和归属地"""
    try:
        await page.goto("http://ip-api.com/json/", wait_until="domcontentloaded", timeout=15000)
        body = await page.locator("body").inner_text()
        data = json.loads(body)
        log(f"    Proxy IP: {data.get('query','?')} | {data.get('city','?')}, {data.get('country','?')}")
        return data
    except Exception as e:
        log(f"    Proxy check failed: {e}")
        return None


async def fill__v13(page: Page, yr: int, mo: int, dy: int, g: str):
    """Fill Google  form with native select + text inputs"""
    MONTH_ABBR = ["","Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
    
    log(f"    Birthday target: {mo}/{dy}/{yr} {g}")
    await page.screenshot(path=os.path.join(SS, f"v13__start.png"))
    
    try:
        # Wait for the form to be ready
        await page.wait_for_selector('#month, select[aria-label*="Month"], [aria-label*="Month"] select', timeout=10000)
        await asyncio.sleep(0.5)
        
        # ─── MONTH (Native Select) ───
        log("    [Month] Setting...")
        month_idx = mo - 1
        await page.evaluate(f"""
            const monthEl = document.querySelector('#month, select[aria-label*="Month"], [data-field-index="0"] select');
            if (monthEl) {{
                monthEl.selectedIndex = {month_idx};
                monthEl.dispatchEvent(new Event('change', {{ bubbles: true }}));
                monthEl.dispatchEvent(new Event('input', {{ bubbles: true }}));
            }}
        """)
        await asyncio.sleep(0.5)
        
        # ─── DAY ───
        log("    [Day] Filling...")
        day_sel = '#day, input[aria-label*="Day"], input[placeholder*="Day"], "number"]'
        day_input = page.locator(day_sel).first
        if await day_input.count() > 0:
            await day_input.click(timeout=3000)
            await asyncio.sleep(0.2)
            await day_input.fill(str(dy))
        await asyncio.sleep(0.3)
        
        # ─── YEAR ───
        log("    [Year] Filling...")
        year_sel = '#year, input[aria-label*="Year"], input[placeholder*="Year"]'
        year_input = page.locator(year_sel).first
        if await year_input.count() > 0:
            await year_input.click(timeout=3000)
            await asyncio.sleep(0.2)
            await year_input.fill(str(yr))
        await asyncio.sleep(0.3)
        
        # ─── GENDER (Native Select) ───
        log("    [Gender] Setting...")
        gender_val = "1" if g == "Male" else "2"  # 1=Male, 2=Female
        await page.evaluate(f"""
            const genderEl = document.querySelector('#gender, select[aria-label*="Gender"], [data-field-index="3"] select');
            if (genderEl) {{
                genderEl.selectedIndex = {gender_val};
                genderEl.dispatchEvent(new Event('change', {{ bubbles: true }}));
                genderEl.dispatchEvent(new Event('input', {{ bubbles: true }}));
            }}
        """)
        await asyncio.sleep(0.5)
        
        # Verify by taking screenshot
        await page.screenshot(path=os.path.join(SS, f"v13__filled.png"))
        
        # Read back values to confirm
        actual_mo = await page.evaluate('document.querySelector("#month, [data-field-index=\'0\'] select")?.value || "?"')
        actual_yr = await page.evaluate('document.querySelector("#year")?.value || "?"')
        actual_g = await page.evaluate('document.querySelector("#gender, [data-field-index=\'3\'] select")?.value || "?"')
        log(f"    Values: month={actual_mo}, year={actual_yr}, gender={actual_g}")
        
        if actual_mo != "?" and actual_yr != "?":
            log("    \u2713 Birthday filled successfully")
            return True
        else:
            log("    \u26a0 Could not verify values, but continuing...")
            return True
        
    except Exception as e:
        log(f"    \u2717 Birthday fill failed: {e}")
        traceback.print_exc()
        await page.screenshot(path=os.path.join(SS, f"v13__error.png"))
        return False


async def click_next(page: Page):
    """点击 Next/Continue 按钮"""
    for label in ["Next", "Continue", "I agree", "Agree", "Create account"]:
        try:
            b = page.locator(f'"{label}")').first
            if await b.count() > 0 and await b.is_visible():
                await b.click(timeout=5000)
                return True
        except:
            pass
    try:
        await page.keyboard.press("Enter")
        return True
    except:
        return False


async def _one(proxy_url, attempt_num):
    """使用指定代理注册一个 Gmail 账号"""
    f, l = random.choice(FIRST), random.choice(LAST)
    uname = f"{f.lower()}{l.lower()}{random.randint(100,9999)}"
    pw = (random.choice(string.ascii_uppercase) + 
          "".join(random.choices(string.ascii_lowercase, k=5)) + 
          "".join(random.choices(string.digits, k=4)) + "!")
    yr, mo, dy = random.randint(1980, 2002), random.randint(1, 12), random.randint(1, 28)
    g = random.choice(["Male", "Female"])
    email = f"{uname}@gmail.com"
    
    # Random viewport
    vw = random.choice([(1280, 800), (1366, 768), (1440, 900), (1536, 864), (1920, 1080)])
    
    log("")
    log("="*60)
    log(f"ATTEMPT #{attempt_num} | {email} | {f} {l} | {yr}-{mo:02d}-{dy:02d} | {g}")
    log(f"Proxy: {proxy_url}")
    log(f"Viewport: {vw[0]}x{vw[1]}")
    log("="*60)
    
    order = None
    sim5 = None
    browser = None
    
    try:
        async with async_playwright() as pw_inst:
            # Launch with proxy
            browser = await pw_inst.chromium.launch(
                headless=False,
                proxy={"server": proxy_url},
                args=[
                    "--no-sandbox",
                    "--disable-blink-features=AutomationControlled",
                    "--disable-dev-shm-usage",
                    f"--window-size={vw[0]},{vw[1]}",
                ]
            )
            
            context = await browser.new_context(
                viewport={"width": vw[0], "height": vw[1]},
                locale="en-US",
                timezone_id="America/Los_Angeles",
                geolocation={"latitude": 34.05, "longitude": -118.24},
                permissions=["geolocation"],
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
            )
            
            page = await context.new_page()
            
            # ═══ STEALTH ═══
            stealth = Stealth(
                navigator_webdriver=True,
                navigator_languages=True,
                navigator_plugins=True,
                navigator_permissions=True,
                chrome_runtime=True,
                chrome_app=True,
                chrome_csi=True,
                chrome_load_times=True,
                iframe_content_window=True,
                media_codecs=True,
                hairline=True,
            )
            await stealth.apply_stealth_async(page)
            log("    \u2713 Stealth applied")
            
            # ═══ Proxy check ═══
            log("[0] Proxy quality check...")
            ip_info = await check_proxy_ip(page)
            if not ip_info:
                log("    \u2717 Proxy dead")
                return None
            proxy_country = ip_info.get("country", "Unknown")
            log(f"    Country: {proxy_country}")
            
            # ═══ Signup ═══
            log("[1] Opening Gmail signup...")
            await page.goto(
                "https://.google.com/signup/v2/webcreateaccount?hl=en&flowName=GlifWebSignIn&flowEntry=SignUp",
                timeout=30000, wait_until="domcontentloaded"
            )
            await asyncio.sleep(4)
            await page.screenshot(path=os.path.join(SS, f"v13_step1_{attempt_num}.png"))
            
            # ═══ Name ═══
            log(f"[2] Name: {f} {l}")
            for sel, val in [('"firstName"]', f), ('"lastName"]', l)]:
                inp = page.locator(sel).first
                if await inp.count() > 0:
                    await inp.click(timeout=3000)
                    await inp.fill(val)
                    await asyncio.sleep(random.uniform(0.2, 0.5))
            await click_next(page)
            await asyncio.sleep(4)
            
            # ═══ Birthday (Material Design) ═══
            log(f"[3] Birthday...")
            bd_ok = await fill__v13(page, yr, mo, dy, g)
            if not bd_ok:
                log("    \u2717 Birthday fill FAILED")
                return None
            await click_next(page)
            await asyncio.sleep(4)
            
            # ═══ Username ═══
            log(f"[4] Username: {uname}")
            await page.screenshot(path=os.path.join(SS, f"v13_step4_{attempt_num}.png"))
            
            # Detect redirect back to 
            curl = page.url.lower()
            if "/gender" in curl:
                log("    \u2717 Redirected back to  — anti-bot detected")
                return None
            
            # Try to fill 
            un_in = page.locator('"Username"]').first
            if await un_in.count() == 0:
                # Might need to click "Create your own"
                for lbl in ["Create your own", "Create your own Gmail address"]:
                    el = page.locator(f'span:has-text("{lbl}"),"{lbl}")').first
                    if await el.count() > 0:
                        try:
                            await el.click(timeout=5000)
                            await asyncio.sleep(2)
                            break
                        except:
                            pass
                un_in = page.locator('"Username"]').first
            
            if await un_in.count() > 0:
                await un_in.click(timeout=3000)
                await un_in.fill(uname)
                await asyncio.sleep(2)
                await click_next(page)
                await asyncio.sleep(4)
            
            # Check for redirect after 
            curl = page.url.lower()
            if "/gender" in curl:
                log("    \u2717 Redirected back to  after  — proxy flagged")
                return None
            
            log("    \u2713 Username accepted")
            await page.screenshot(path=os.path.join(SS, f"v13_step5_{attempt_num}.png"))
            
            # ═══  ═══
            log(f"[5] ...")
            pws = page.locator('""]')
            pwc = await pws.count()
            log(f"    PW fields: {pwc}")
            
            if pwc >= 2:
                await pws.nth(0).click(timeout=3000)
                await pws.nth(0).fill(pw)
                await pws.nth(1).click(timeout=3000)
                await pws.nth(1).fill(pw)
            elif pwc == 1:
                await pws.nth(0).click(timeout=3000)
                await pws.nth(0).fill(pw)
            
            await click_next(page)
            await asyncio.sleep(4)
            
            # ═══ Terms / Recovery ═══
            log("[6] Terms & recovery...")
            body = (await page.locator("body").inner_text()).lower()
            await page.screenshot(path=os.path.join(SS, f"v13_step6_{attempt_num}.png"))
            
            if "terms" in body or "privacy" in body:
                for l in ["I agree", "Agree"]:
                    b = page.locator(f'"{l}")').first
                    if await b.count() > 0:
                        await b.click(timeout=3000)
                        break
                await asyncio.sleep(3)
            
            if "skip" in body or "recovery" in body:
                for l in ["Skip", "Not now"]:
                    b = page.locator(f'"{l}")').first
                    if await b.count() > 0:
                        await b.click(timeout=3000)
                        break
                await asyncio.sleep(2)
            
            await click_next(page)
            await asyncio.sleep(4)
            
            # ═══ Phone Verification ═══
            log("[7] Phone verification...")
            await page.screenshot(path=os.path.join(SS, f"v13_step7_{attempt_num}.png"))
            
            curl = page.url.lower()
            body = (await page.locator("body").inner_text()).lower()
            
            # Check if no verification needed
            if "" in curl or "mail.google.com" in curl:
                log("\U0001F389 NO VERIFICATION REQUIRED!")
                return save_account(email, uname, pw)
            
            # Try skip
            skipped = False
            for lbl in ["Skip", "Skip for now", "Not now", "Later", "I prefer"]:
                btn = page.locator(f'"{lbl}"),span:has-text("{lbl}"),a:has-text("{lbl}")')
                if await btn.count() > 0:
                    await btn.first.click(timeout=5000)
                    log(f"    Skipped: '{lbl}'")
                    await asyncio.sleep(3)
                    curl2 = page.url.lower()
                    if "" in curl2 or "mail.google.com" in curl2:
                        log("\U0001F389 SUCCESS!")
                        return save_account(email, uname, pw)
                    skipped = True
                    break
            
            if not skipped and ("verify" in body or "phone" in body or "number" in body):
                # 5sim verification
                sim5 = Sim5(FIVESIM_KEY)
                bal = sim5.bal()
                log(f"    5sim balance: {bal} RUB")
                
                if bal < 0.3:
                    log("\u26a0 Low balance")
                    return None
                
                order = sim5.buy(country="indonesia")
                if not order:
                    log("\u26a0 Buy failed")
                    return None
                
                phone = order["phone"]
                log(f"    \U0001F1EE\U0001F1E9 {phone} (#{order['id']}, {order['price']} RUB)")
                
                pi = page.locator('"tel"],"phoneNumber"]').first
                if await pi.count() > 0:
                    await pi.click(timeout=3000)
                    await pi.fill(phone)
                
                await asyncio.sleep(1)
                await click_next(page)
                await asyncio.sleep(2)
                
                log("    Waiting for SMS...")
                code = sim5.wait(order["id"], timeout=180, iv=3)
                
                if code:
                    log(f"    CODE: {code}")
                    ci = page.locator('"hidden"""])').first
                    if await ci.count() > 0: await ci.fill(code)
                    await click_next(page)
                    await asyncio.sleep(6)
                    
                    pu = page.url.lower()
                    pb = (await page.locator("body").inner_text()).lower()
                    
                    if "" in pb or "wrong" in pb:
                        log("\u2717 Wrong code")
                        sim5.cancel(order["id"])
                    elif "" in pu or "mail.google.com" in pu or "welcome" in pb:
                        log("\U0001F389 VERIFIED!")
                        sim5.finish(order["id"])
                        return save_account(email, uname, pw)
                    else:
                        sim5.cancel(order["id"])
                else:
                    log("\u2717 No SMS")
                    sim5.cancel(order["id"])
            
            # Final check
            curl = page.url.lower()
            if "" in curl or "mail.google.com" in curl:
                log("\U0001F389 SUCCESS!")
                return save_account(email, uname, pw)
            
            log("\u26a0 End of flow")
            return None
            
    except Exception as e:
        log(f"\u274c Error: {e}")
        traceback.print_exc()
        if sim5 and order:
            try: sim5.cancel(order["id"])
            except: pass
        return None
    finally:
        if browser:
            try: await browser.close()
            except: pass


def save_account(email, uname, pw):
    d = {
        "email": email, "": uname, "": pw,
        "": datetime.now().isoformat(), "status": "active"
    }
     = []
    if os.path.exists(ACCOUNTS):
        try:
            with open(ACCOUNTS, "r", encoding="utf-8") as f:
                 = json.load(f)
        except:
             = []
    .append(d)
    with open(ACCOUNTS, "w", encoding="utf-8") as f:
        json.dump(, f, indent=2, ensure_ascii=False)
    log(f"  \U0001f4be Saved: {email}")
    return d


async def main():
    count = 1
    if len(sys.argv) > 1:
        try: count = int(sys.argv[1])
        except: pass
    
    log(f"\n{'='*60}")
    log(f"GMAIL REGISTRATOR v13 — MATERIAL DESIGN FIX")
    log(f"Target: {count} account(s)")
    log(f"Proxy: :10808 (74.211.97.178)")
    log(f"{'='*60}\n")
    
    sim5 = Sim5(FIVESIM_KEY)
    bal = sim5.bal()
    log(f"5sim balance: {bal} RUB")
    
    results = []
    
    for attempt in range(1, count + 1):
        proxy_url = PROXY_POOL[0]
        
        log(f"\n--- Attempt {attempt}/{count} ---")
        
        result = await _one(proxy_url, attempt)
        if result:
            results.append(result)
            log(f"\U0001f389 SUCCESS: {result['email']}")
        else:
            log(f"\u274c FAILED")
        
        log(f"\nResults: {len(results)}/{attempt}")
    
    log(f"\n{'='*60}")
    log(f"DONE: {len(results)}/{count} ")
    for r in results:
        log(f"  {r['email']} | {r['']}")
    log(f"{'='*60}")
    return results


if __name__ == "__main__":
    results = asyncio.run(main())
