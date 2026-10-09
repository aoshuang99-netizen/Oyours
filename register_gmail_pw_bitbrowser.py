# -*- coding: utf-8 -*-
"""
_gmail_pw_bitbrowser.py
PLAYWRIGHT + BITBROWSER CHROME BINARY — launch BitBrowser's Chrome directly.

Key: Playwright launches BitBrowser.exe natively (not via CDP/webdriver).
No chromedriver, no WebDriver protocol. Uses pipe-based CDP communication.
"""
import asyncio, json, os, random, re, string, sys, time, traceback
from datetime import datetime

if sys. == "win32":
    try: sys.stdout.reconfigure(encoding="utf-8")
    except: pass

from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.abspath(__file__))
ACCOUNTS = os.path.join(ROOT, "gmail-data", ".json")

def log(msg): print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)

# ========== CONFIG ==========
BITBROWSER_EXE = r"C:\Users\AS\AppData\Roaming\BitBrowser\Chrome-bin\124\win124.11.9\BitBrowser.exe"
FIVESIM_KEY = "eyJhbGciOiJSUzUxMiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE4MTM3MzQ3ODEsImlhdCI6MTc4MjE5ODc4MSwicmF5IjoiNjIxMWY0MjAyNmM2YjZkNDMxMjMxYjY0MDkwMzg3MDYiLCJzdWIiOjQyMjIwNTB9.wRPYREkUdv60wd68XujZqXlravtg01aMWYECx0Bl1fLqC2uxL2yELzAIWIG_b_yAhKrymtxV5XsGlCpBm_uapnwJZhUw7LyHHnYl_V6weL6uEvk2ayrcIhaUCa13RORmRen8fXdrElnO_flZqQpeJRqm7gpUQF-HSy8Az3iy3j0JWvW9pfg_sAZTCA6vlADn66lrZ36O5g3NiKoTtTB0SYo8lfzFxtBbROc6gSMg_46dmn1hjNgJB6cetJ33DLQ1UJCuckcjV_lVfiPIMYT51RIqaRS8zyPaCTT8938whKFHbbJgWpne-6ldHmdeDudWDtytElk7d204shjBL1q1ww"
PROXY_HOST = ""
PROXY_PORT = 8090

FIRST = ["James","John","Robert","David","William","Richard","Joseph","Thomas","Christopher","Daniel","Matthew","Anthony","Mark","Paul","Steven","Andrew","Kenneth","George","Brian"]
LAST = ["Smith","Johnson","Williams","Brown","Jones","Garcia","Miller","Davis","Rodriguez","Martinez","Hernandez","Lopez","Gonzalez","Wilson","Anderson","Thomas","Taylor","Moore","Jackson"]

import requests as _req

# ========== 5SIM ==========
class Sim5:
    B="https://5sim.net/v1"
    def __init__(self,k): self.s=_req.Session(); self.s.headers.update({"":f"Bearer {k}","Accept":"application/json"})
    def _g(self,p,pr=None,to=20): r=self.s.get(f"{self.B}{p}",params=pr,timeout=to); return r.json() if r.status_code<400 else None
    def bal(self): d=self._g("/user/profile"); return d.get("balance",0) if d else 0
    def buy(self,c="indonesia"):
        d=self._g(f"/user/buy/activation/{c}/any/google")
        return {"id":d["id"],"phone":d.get("phone",""),"price":d.get("price",0)} if(d and d.get("id")) else None
    def chk(self,oid):
        d=self._g(f"/user/check/{oid}")
        if not d: return {"s":"ERROR"}
        sms=d.get("sms",[]); s=d.get("status","PENDING")
        if sms and sms[0].get("code"):
            c=sms[0]["code"]; m=re.search(r'\d{4,8}',c); return {"s":"RECEIVED","code":m.group(0) if m else c}
        if s=="RECEIVED":
            cd=d.get("code") or d.get("sms_code")
            if cd: return {"s":"RECEIVED","code":str(cd)}
        return {"s":s}
    def wait(self,oid,timeout=180,iv=3):
        st=time.time()
        while time.time()-st<timeout:
            r=self.chk(oid)
            if r["s"]=="RECEIVED" and r.get("code"): log(f"  [5sim] {r['code']} ({int(time.time()-st)}s)"); return r["code"]
            if r["s"] in ("CANCELED","TIMEOUT","BANNED","ERROR"): log(f"  [5sim] {r['s']}"); return None
            time.sleep(iv)
        return None
    def cancel(self,oid): self._g(f"/user/cancel/{oid}")
    def finish(self,oid): self._g(f"/user/finish/{oid}")


async def do_(attempt_num):
    f_name, l_name = random.choice(FIRST), random.choice(LAST)
    uname = f"{f_name.lower()}{l_name.lower()}{random.randint(100,9999)}"
    pw = (random.choice(string.ascii_uppercase) + "".join(random.choices(string.ascii_lowercase,k=6)) + "".join(random.choices(string.digits,k=4)) + "!")
    yr, mo, dy = random.randint(1985,2000), random.randint(1,12), random.randint(1,28)
    g = random.choice(["Male","Female"])
    email = f"{uname}@gmail.com"
    ma = ["","jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"]
    mf = ["","January","February","March","April","May","June","July","August","September","October","November","December"]

    log(f"\n{'='*50}")
    log(f"PW-BITBROWSER #{attempt_num} | {email} | {mf[mo]} {dy}, {yr} | {g}")
    log(f"{'='*50}")

    user_data = os.path.join(ROOT, "gmail-data", f"profile_{attempt_num}_{int(time.time())}")
    browser = None
    try:
        async with async_playwright() as pw:
            log("[0] Launching BitBrowser Chrome binary...")
            
            # Create user data dir
            os.makedirs(user_data, exist_ok=True)
            
            # Launch with anti-detection args
            context = await pw.chromium.launch_persistent_context(
                =user_data,
                executable_path=BITBROWSER_EXE,
                headless=False,
                proxy={
                    "server": f"http://{PROXY_HOST}:{PROXY_PORT}",
                },
                args=[
                    "--disable-blink-features=AutomationControlled",
                    "--disable-features=IsolateOrigins,site-per-process",
                    "--no-sandbox",
                    "--disable-gpu",
                    "--disable-dev-shm-usage",
                    f"--window-size=1440,900",
                ],
                ignore_default_args=["--enable-"],
                viewport={"width": 1440, "height": 900},
                locale="en-US",
                timezone_id="America/New_York",
            )
            
            page = context.pages[0] if context.pages else await context.new_page()
            
            # Inject anti-detection scripts
            await page.add_init_script("""
                // Override navigator.webdriver
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
                // Override chrome.runtime
                window.chrome = { runtime: {} };
                // Override permissions
                const origQuery = window.navigator.permissions.query;
                window.navigator.permissions.query = (params) => (
                    params.name === 'notifications' ?
                    Promise.resolve({state: Notification.permission}) :
                    origQuery(params)
                );
                // Override plugins
                Object.defineProperty(navigator, 'plugins', {
                    get: () => [1, 2, 3, 4, 5]
                });
                // Override languages
                Object.defineProperty(navigator, 'languages', {
                    get: () => ['en-US', 'en']
                });
            """)
            
            # Verify
            await page.goto("about:blank")
            wd = await page.evaluate("navigator.webdriver")
            log(f"  navigator.webdriver: {wd}")
            
            # ========== STEP 1: Signup ==========
            log("[1] Opening Gmail signup...")
            await page.goto(
                "https://.google.com/signup/v2/webcreateaccount?hl=en&flowName=GlifWebSignIn&flowEntry=SignUp",
                timeout=40000, wait_until="domcontentloaded"
            )
            await asyncio.sleep(5)
            log(f"    URL: {page.url[:80]}")
            
            # ========== STEP 2: Name ==========
            log(f"[2] Name: {f_name} {l_name}")
            for sel, val in [('"firstName"]', f_name), ('"lastName"]', l_name)]:
                try:
                    inp = page.locator(sel).first
                    await inp.click(timeout=3000)
                    await asyncio.sleep(0.2)
                    await inp.type(val, delay=random.randint(40, 100))
                except Exception as e:
                    log(f"    {sel} error: {e}")
            await asyncio.sleep(0.5)
            
            # Click Next
            await page.locator('"Next")').first.click(timeout=5000)
            await asyncio.sleep(6)
            
            url = page.url.lower()
            log(f"    URL: {page.url[:100]}")
            
            if "gender" in url:
                if "tl=" in url or "TL=" in url:
                    log("    ❌ Anti-bot detection (TL= marker)")
                    return None
                # Normal  page
                pass
            else:
                log("    ⚠ Unexpected redirect")
            
            # ========== STEP 3: Birthday ==========
            log(f"[3] Birthday: {mf[mo]} {dy}, {yr} | {g}")
            
            # Google uses Material Design — inject values via JS
            await page.evaluate(f"""
                (() => {{
                    // Helper: set value and dispatch events
                    const setEl = (el, val) => {{
                        if (!el) return;
                        el.focus();
                        el.value = val;
                        el.dispatchEvent(new Event('input', {{bubbles: true}}));
                        el.dispatchEvent(new Event('change', {{bubbles: true}}));
                    }};
                    
                    // Month: custom dropdown, need to click the right option
                    const monthEl = document.querySelector('select[name="month"], "month"], [data-is-month]');
                    if (monthEl) {{
                        monthEl.value = '{mo}';
                        monthEl.dispatchEvent(new Event('change', {{bubbles: true}}));
                    }}
                    
                    // Day
                    setEl(document.querySelector('"day"]'), '{dy}');
                    
                    // Year
                    setEl(document.querySelector('"year"]'), '{yr}');
                    
                    // Gender
                    const genEl = document.querySelector('select[name="gender"], "gender"]');
                    if (genEl) {{
                        genEl.value = '{1 if g=="Male" else 2}';
                        genEl.dispatchEvent(new Event('change', {{bubbles: true}}));
                    }}
                }})()
            """)
            await asyncio.sleep(1)
            
            await page.locator('"Next")').first.click(force=True, timeout=5000)
            await asyncio.sleep(6)
            
            url = page.url.lower()
            log(f"    URL: {page.url[:100]}")
            
            if "gender" in url:
                log("    ❌ Anti-bot after ")
                return None
            
            log("    ✓ Birthday accepted!")
            
            # ========== STEP 4: Username ==========
            log(f"[4] Username: {uname}")
            try:
                await page.locator('span:has-text("Create your own")').first.click(timeout=3000)
                await asyncio.sleep(2)
            except: pass
            
            try:
                uin = page.locator('"Username"]').first
                await uin.click(timeout=3000)
                await asyncio.sleep(0.3)
                await uin.type(uname, delay=random.randint(40, 90))
            except Exception as e:
                log(f"    Username error: {e}")
            
            await asyncio.sleep(0.5)
            await page.locator('"Next")').first.click(force=True, timeout=5000)
            await asyncio.sleep(6)
            
            url = page.url.lower()
            log(f"    URL: {page.url[:100]}")
            
            if "gender" in url:
                log("    ❌ Anti-bot after ")
                return None
            if any(k in url for k in ["unavailable", "taken"]):
                log("    ⚠ Username taken")
                return None
            
            log("    ✓ Username accepted!")
            
            # ========== STEP 5:  ==========
            log("[5] ")
            pws = page.locator('""]')
            pc = await pws.count()
            if pc >= 2:
                await pws.nth(0).fill(pw)
                await pws.nth(1).fill(pw)
            elif pc == 1:
                await pws.nth(0).fill(pw)
            
            await page.locator('"Next")').first.click(force=True, timeout=5000)
            await asyncio.sleep(5)
            
            # ========== STEP 6: Post- ==========
            url = page.url.lower()
            log(f"[6] URL: {page.url[:100]}")
            
            if any(k in url for k in ["", "mail.google", "welcome"]):
                log("🎉 ACCOUNT CREATED!")
                return save(email, uname, pw)
            
            # Terms / Skip
            body_text = ""
            try: body_text = (await page.locator("body").inner_text()).lower()
            except: pass
            
            for lbl in ["I agree", "Agree", "Accept"]:
                try:
                    await page.locator(f'"{lbl}")').first.click(timeout=3000)
                    await asyncio.sleep(3)
                    break
                except: pass
            
            for lbl in ["Skip", "Not now", "Skip for now", "I prefer"]:
                try:
                    await page.locator(f'"{lbl}"),span:has-text("{lbl}")').first.click(timeout=3000)
                    await asyncio.sleep(2)
                    break
                except: pass
            
            try:
                await page.locator('"Next")').first.click(force=True, timeout=5000)
                await asyncio.sleep(5)
            except: pass
            
            # ========== STEP 7: Phone / Final ==========
            url = page.url.lower()
            log(f"[7] URL: {page.url[:100]}")
            
            if any(k in url for k in ["", "mail.google", "welcome"]):
                log("🎉 ACCOUNT CREATED!")
                return save(email, uname, pw)
            
            try: body_text = (await page.locator("body").inner_text()).lower()
            except: body_text = ""
            
            if any(k in body_text for k in ["verify", "phone", "number"]):
                log("[7] Phone verification")
                sim5 = Sim5(FIVESIM_KEY)
                if sim5.bal() < 1.0: return None
                
                order = sim5.buy()
                if not order: return None
                
                log(f"    +{order['phone']} ({order['price']}RUB)")
                
                try:
                    pi = page.locator('"tel"],"phoneNumber"]').first
                    await pi.fill(order["phone"])
                except: pass
                
                await asyncio.sleep(0.5)
                try: await page.locator('"Next")').first.click(force=True, timeout=5000)
                except: pass
                await asyncio.sleep(4)
                
                code = sim5.wait(order["id"])
                if code:
                    log(f"    CODE: {code}")
                    try:
                        ci = page.locator('"hidden"""])').first
                        await ci.fill(code)
                    except: pass
                    
                    try: await page.locator('"Next"),"Verify")').first.click(force=True, timeout=5000)
                    except: pass
                    await asyncio.sleep(5)
                    
                    url = page.url.lower()
                    try: body_text = (await page.locator("body").inner_text()).lower()
                    except: body_text = ""
                    
                    if "" in body_text:
                        sim5.cancel(order["id"])
                    elif any(k in url for k in ["", "welcome", "mail.google"]):
                        sim5.finish(order["id"])
                        log("🎉 ACCOUNT CREATED WITH PHONE!")
                        return save(email, uname, pw)
                    else:
                        sim5.cancel(order["id"])
                else:
                    sim5.cancel(order["id"])
            
            url = page.url.lower()
            if any(k in url for k in ["", "mail.google", "welcome"]):
                log("🎉 ACCOUNT CREATED!")
                return save(email, uname, pw)
            
            log("End of flow")
            return None
            
    except Exception as e:
        log(f"Error: {e}")
        traceback.print_exc()
        return None
    finally:
        # Cleanup user data
        if os.path.exists(user_data):
            try:
                import shutil
                shutil.rmtree(user_data, ignore_errors=True)
            except: pass


def save(email, uname, pw):
    d = {"email": email, "": uname, "": pw, "": datetime.now().isoformat()}
    a = []
    if os.path.exists(ACCOUNTS):
        try:
            with open(ACCOUNTS, "r", encoding="utf-8") as f: a = json.load(f)
        except: a = []
    a.append(d)
    with open(ACCOUNTS, "w", encoding="utf-8") as f: json.dump(a, f, indent=2)
    log(f"  Saved: {email}")
    return d


async def main():
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    sim5 = Sim5(FIVESIM_KEY)
    log(f"\n{'='*50}")
    log(f"PLAYWRIGHT + BITBROWSER CHROME BINARY")
    log(f"5sim: {sim5.bal()}RUB")
    log(f"{'='*50}")
    
    results = []
    for i in range(1, count + 1):
        r = await do_(i)
        if r: results.append(r); log(f"SUCCESS: {r['email']}")
        else: log(f"FAILED")
        log(f"Progress: {len(results)}/{i}")
        if i < count:
            wait = random.randint(10, 20)
            log(f"  Cooling {wait}s...")
            await asyncio.sleep(wait)
    
    log(f"\n{'='*50}")
    log(f"DONE: {len(results)}/{count}")
    for r in results: log(f"  {r['email']} | {r['']}")
    log(f"{'='*50}")


if __name__ == "__main__":
    asyncio.run(main())
