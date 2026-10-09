# -*- coding: utf-8 -*-
"""
_gmail_final.py — REAL CHROME PROFILE + MOBILE EMULATION

Strategy: Use a persistent Chrome user-data-dir (like a real user),
emulate a mobile device (lower security), and go through Stack Overflow's 
"Sign in with Google" flow to create a new account.

Usage: python _gmail_final.py
"""

import asyncio, json, os, random, re, string, sys, time, traceback, shutil
from datetime import datetime

if sys. == "win32":
    try: sys.stdout.reconfigure(encoding="utf-8")
    except: pass

from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.abspath(__file__))
SS = os.path.join(ROOT, "gmail-data", "screenshots")
ACCOUNTS = os.path.join(ROOT, "gmail-data", ".json")
CHROME_PROFILE = os.path.join(ROOT, "gmail-data", "chrome-profile")
for d in [os.path.dirname(SS), CHROME_PROFILE]: os.makedirs(d, exist_ok=True)

def log(msg): print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)

FIVESIM_KEY = "eyJhbGciOiJSUzUxMiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE4MTM3MzQ3ODEsImlhdCI6MTc4MjE5ODc4MSwicmF5IjoiNjIxMWY0MjAyNmM2YjZkNDMxMjMxYjY0MDkwMzg3MDYiLCJzdWIiOjQyMjIwNTB9.wRPYREkUdv60wd68XujZqXlravtg01aMWYECx0Bl1fLqC2uxL2yELzAIWIG_b_yAhKrymtxV5XsGlCpBm_uapnwJZhUw7LyHHnYl_V6weL6uEvk2ayrcIhaUCa13RORmRen8fXdrElnO_flZqQpeJRqm7gpUQF-HSy8Az3iy3j0JWvW9pfg_sAZTCA6vlADn66lrZ36O5g3NiKoTtTB0SYo8lfzFxtBbROc6gSMg_46dmn1hjNgJB6cetJ33DLQ1UJCuckcjV_lVfiPIMYT51RIqaRS8zyPaCTT8938whKFHbbJgWpne-6ldHmdeDudWDtytElk7d204shjBL1q1ww"

FIRST = ["James","John","Robert","Michael","David","William","Richard","Joseph","Thomas","Christopher","Daniel","Matthew","Anthony","Mark","Paul","Steven","Andrew","Kenneth","George","Brian","Kevin"]
LAST = ["Smith","Johnson","Williams","Brown","Jones","Garcia","Miller","Davis","Rodriguez","Martinez","Hernandez","Lopez","Gonzalez","Wilson","Anderson","Thomas","Taylor","Moore","Jackson","Martin"]

MOBILE_DEVICES = [
    {"viewport":{"width":390,"height":844},"user_agent":"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1","device":"iPhone 14 Pro","isMobile":True},
    {"viewport":{"width":412,"height":915},"user_agent":"Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36","device":"Pixel 7","isMobile":True},
    {"viewport":{"width":412,"height":915},"user_agent":"Mozilla/5.0 (Linux; Android 14; SM-S908B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36","device":"Galaxy S22","isMobile":True},
]

import requests as _req
class Sim5:
    B = "https://5sim.net/v1"
    def __init__(self,key): self.s=_req.Session(); self.s.headers.update({"":f"Bearer {key}","Accept":"application/json"})
    def _g(self,p,pr=None,to=20): r=self.s.get(f"{self.B}{p}",params=pr,timeout=to); return r.json() if r.status_code<400 else None
    def bal(self): d=self._g("/user/profile"); return d.get("balance",0) if d else 0
    def buy(self,country="indonesia"):
        d=self._g(f"/user/buy/activation/{country}/any/google")
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


async def gmail__mobile():
    """Register Gmail via mobile emulation + Stack Overflow Google sign-in"""
    dev = MOBILE_DEVICES[0]
    f, l = random.choice(FIRST), random.choice(LAST)
    uname = f"{f.lower()}{l.lower()}{random.randint(100,9999)}"
    pw = "Gm" + "".join(random.choices(string.ascii_lowercase,k=6)) + "".join(random.choices(string.digits,k=4)) + "!"
    email = f"{uname}@gmail.com"
    yr, mo, dy = random.randint(1985,2000), random.randint(1,12), random.randint(1,28)
    g = random.choice(["Male","Female"])
    
    log("="*60)
    log(f"MOBILE REG: {email} | {f} {l} | {dev['device']}")
    log("="*60)
    
    browser = None
    try:
        async with async_playwright() as pw:
            # Use persistent context for real browser profile
            context = await pw.chromium.launch_persistent_context(
                =CHROME_PROFILE,
                headless=False,
                proxy={"server": "http://:10808"},
                viewport=dev["viewport"],
                user_agent=dev["user_agent"],
                is_mobile=dev["isMobile"],
                has_touch=dev["isMobile"],
                locale="en-US",
                timezone_id="America/Los_Angeles",
                geolocation={"latitude":34.05,"longitude":-118.24},
                permissions=["geolocation"],
                args=["--no-sandbox","--disable-blink-features=AutomationControlled"],
            )
            page = context.pages[0]
            
            # Disable webdriver detection
            await page.add_init_script("""
                Object.defineProperty(navigator, 'webdriver', {get: () => false});
                Object.defineProperty(navigator, 'plugins', {get: () => [1,2,3,4,5]});
                delete navigator.__proto__.webdriver;
            """)
            
            # Step 1: Visit a normal site first to warm up
            log("[1] Warming up browser fingerprint...")
            await page.goto("https://www.stackoverflow.com", wait_until="domcontentloaded", timeout=30000)
            await asyncio.sleep(3)
            
            # Step 2: Click "Sign up" on Stack Overflow
            log("[2] Clicking Stack Overflow sign up...")
            for sel in ['a:has-text("Sign up")', 'a:has-text("Log in")', 'a:has-text("Join")']:
                btn = page.locator(sel).first
                if await btn.count() > 0:
                    await btn.click(timeout=5000)
                    break
            await asyncio.sleep(3)
            
            # Step 3: Click "Sign up with Google"
            log("[3] Clicking 'Sign up with Google'...")
            for sel in ['"Google")', 'a:has-text("Google")', '[data-provider="google"]', 'button[aria-label*="Google"]']:
                btn = page.locator(sel).first
                if await btn.count() > 0:
                    await btn.click(timeout=5000)
                    break
            await asyncio.sleep(5)
            
            await page.screenshot(path=os.path.join(SS, "final_google_popup.png"))
            
            # Step 4: In the Google popup, click "Create account"
            log("[4] Google OAuth popup — Create account...")
            # If there are multiple pages (popups), switch to the Google one
            all_pages = context.pages
            google_page = page
            for p in all_pages:
                if ".google.com" in p.url:
                    google_page = p
                    log(f"    Found Google page: {p.url[:60]}")
                    break
            
            if ".google.com" not in google_page.url:
                log("    Checking popup pages...")
                for p in all_pages:
                    await p.bring_to_front()
                    await asyncio.sleep(1)
                    if ".google.com" in p.url:
                        google_page = p
                        break
            
            # Click "Create account" or fill email
            for cre in ['span:has-text("Create account")', '"Create account")', 'span:has-text("Use another account")']:
                btn = google_page.locator(cre).first
                if await btn.count() > 0:
                    await btn.click(timeout=5000)
                    await asyncio.sleep(3)
                    break
            
            # If no Google page found, go directly to signup
            if ".google.com" not in google_page.url:
                log("    Going to Gmail signup directly...")
                await google_page.goto("https://.google.com/signup/v2/webcreateaccount?hl=en&flowName=GlifWebSignIn&flowEntry=SignUp", timeout=30000, wait_until="domcontentloaded")
                await asyncio.sleep(3)
            
            await google_page.screenshot(path=os.path.join(SS, "final_signup_page.png"))
            
            # Step 5: Fill registration form
            log(f"[5] Filling form: {f} {l}")
            
            # Name
            for sel, val in [('"firstName"]',f), ('"lastName"]',l)]:
                inp = google_page.locator(sel).first
                if await inp.count() > 0:
                    await inp.fill(val)
                    await asyncio.sleep(0.5)
            
            for nxt in ['"Next")', '"Continue")']:
                btn = google_page.locator(nxt).first
                if await btn.count() > 0:
                    await btn.click(force=True, timeout=5000)
                    break
            await asyncio.sleep(5)
            
            # Birthday
            log(f"    Birthday: {mo}/{dy}/{yr} {g}")
            month_abbr = ["","jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"]
            month_full = ["","January","February","March","April","May","June","July","August","September","October","November","December"]
            
            # Native select
            await google_page.evaluate(f"""
                const m=document.querySelector('#month');
                const d=document.querySelector('#day');
                const y=document.querySelector('#year');
                const gd=document.querySelector('#gender');
                if(m){{m.selectedIndex={mo-1};m.dispatchEvent(new Event('change',{{bubbles:true}}));}}
                if(d){{d.value='{dy}';d.dispatchEvent(new Event('input',{{bubbles:true}}));}}
                if(y){{y.value='{yr}';y.dispatchEvent(new Event('input',{{bubbles:true}}));}}
                if(gd){{gd.selectedIndex={'1' if g=='Male' else '2'};gd.dispatchEvent(new Event('change',{{bubbles:true}}));}}
            """)
            await asyncio.sleep(0.5)
            
            # Material click fallback
            for target, sel, txt in [
                ("Month",'span:has-text("Month")',month_abbr[mo]),
                ("Gender",'span:has-text("Gender")',"m" if g=="Male" else "f"),
            ]:
                el = google_page.locator(sel).first
                if await el.count() > 0:
                    try:
                        await el.click(force=True, timeout=3000)
                        await asyncio.sleep(0.5)
                        await google_page.keyboard.type(txt, delay=60)
                        await asyncio.sleep(0.3)
                        await google_page.keyboard.press("Enter")
                    except: pass
            
            await google_page.keyboard.press("Escape")
            await asyncio.sleep(0.3)
            await google_page.keyboard.press("Escape")
            
            log(f"    ✓ Birthday: {month_full[mo]} {dy}, {yr} | {g}")
            
            for nxt in ['"Next")']:
                btn = google_page.locator(nxt).first
                if await btn.count() > 0:
                    await btn.click(force=True, timeout=5000)
                    break
            await asyncio.sleep(5)
            
            # Check redirect
            curl = google_page.url.lower()
            log(f"    URL: {curl[:80]}")
            if "gender" in curl or "signup/" in curl:
                log("    ⚠️ Google detected — trying alternate flow...")
                # Try filling directly via Python evaluate
                await google_page.evaluate(f"""
                    setTimeout(() => {{
                        const allInputs = 'input');
                        allInputs.forEach(inp => {{
                            const label = (inp.getAttribute('aria-label') || inp.placeholder || '').toLowerCase();
                            if (label.includes('month')) inp.value = '{month_abbr[mo]}';
                            if (label.includes('day')) inp.value = '{dy}';
                            if (label.includes('year')) inp.value = '{yr}';
                            if (label.includes('gender')) inp.value = '{"m" if g=="Male" else "f"}';
                            inp.dispatchEvent(new Event('input', {{bubbles:true}}));
                            inp.dispatchEvent(new Event('change', {{bubbles:true}}));
                        }});
                    }}, 1000);
                """)
                await asyncio.sleep(3)
                for nxt in ['"Next")']:
                    btn = google_page.locator(nxt).first
                    if await btn.count() > 0:
                        await btn.click(force=True, timeout=5000)
                        break
                await asyncio.sleep(5)
            
            curl = google_page.url.lower()
            if "gender" in curl:
                log("    ❌ Still on  — giving up")
                await google_page.screenshot(path=os.path.join(SS, "final__fail.png"))
                return None
            
            # Username
            log(f"[6] Username: {uname}")
            for cl in ['span:has-text("Create your own")']:
                el = google_page.locator(cl).first
                if await el.count() > 0:
                    try: await el.click(timeout=3000); await asyncio.sleep(2)
                    except: pass
            
            un_in = google_page.locator('"Username"]').first
            if await un_in.count() > 0:
                await un_in.fill(uname); await asyncio.sleep(1)
            
            for nxt in ['"Next")']:
                btn = google_page.locator(nxt).first
                if await btn.count() > 0:
                    await btn.click(force=True, timeout=5000)
                    break
            await asyncio.sleep(5)
            
            if "gender" in google_page.url.lower():
                log("    ❌ Anti-bot redirect — proxy flagged")
                return None
            
            log("    ✓ Username accepted!")
            
            # 
            log(f"[7] ...")
            pws = google_page.locator('""]')
            pc = await pws.count()
            if pc >= 2:
                await pws.nth(0).fill(pw); await pws.nth(1).fill(pw)
            elif pc == 1:
                await pws.nth(0).fill(pw)
            
            for nxt in ['"Next")']:
                btn = google_page.locator(nxt).first
                if await btn.count() > 0: await btn.click(force=True, timeout=5000); break
            await asyncio.sleep(5)
            
            # Terms
            body = (await google_page.locator("body").inner_text()).lower()
            if "terms" in body or "privacy" in body:
                for l in ["I agree","Agree"]:
                    b = google_page.locator(f'"{l}")').first
                    if await b.count()>0: await b.click(timeout=3000); break
                await asyncio.sleep(3)
            
            if "skip" in body or "recovery" in body:
                for l in ["Skip","Not now"]:
                    b = google_page.locator(f'"{l}")').first
                    if await b.count()>0: await b.click(timeout=3000); break
                await asyncio.sleep(2)
            
            for nxt in ['"Next")']:
                btn = google_page.locator(nxt).first
                if await btn.count()>0: await btn.click(force=True, timeout=5000); break
            await asyncio.sleep(5)
            
            # Phone verification
            await google_page.screenshot(path=os.path.join(SS, "final_phone.png"))
            curl = google_page.url.lower()
            body = (await google_page.locator("body").inner_text()).lower()
            
            if "" in curl or "mail.google.com" in curl:
                log("🎉 NO VERIFICATION!")
                d={"email":email,"":uname,"":pw,"":datetime.now().isoformat()}
                accts=[]
                if os.path.exists(ACCOUNTS):
                    try:
                        with open(ACCOUNTS,"r",encoding="utf-8") as ff: accts=json.load(ff)
                    except: accts=[]
                accts.append(d)
                with open(ACCOUNTS,"w",encoding="utf-8") as ff: json.dump(accts,ff,indent=2)
                log(f"  💾 {email}")
                return d
            
            # Skip phone
            for lbl in ["Skip","Skip for now","Not now","Later"]:
                btn = google_page.locator(f'"{lbl}"),span:has-text("{lbl}")')
                if await btn.count()>0:
                    await btn.first.click(timeout=5000); await asyncio.sleep(3)
                    if "" in google_page.url.lower(): return {"email":email,"":uname,"":pw}
                    break
            
            # 5sim
            if "verify" in body or "phone" in body:
                sim5 = Sim5(FIVESIM_KEY)
                order = sim5.buy(country="indonesia")
                if order:
                    log(f"    🇮🇩 {order['phone']} ({order['price']} RUB)")
                    pi = google_page.locator('"tel"],"phoneNumber"]').first
                    if await pi.count()>0: await pi.fill(order["phone"])
                    for nxt in ['"Next")']:
                        btn=google_page.locator(nxt).first
                        if await btn.count()>0: await btn.click(force=True,timeout=5000); break
                    await asyncio.sleep(3)
                    
                    code = sim5.wait(order["id"])
                    if code:
                        ci=google_page.locator('"hidden"""])').first
                        if await ci.count()>0: await ci.fill(code)
                        for nxt in ['"Next")']:
                            btn=google_page.locator(nxt).first
                            if await btn.count()>0: await btn.click(force=True,timeout=5000); break
                        await asyncio.sleep(6)
                        if "welcome" in (await google_page.locator("body").inner_text()).lower():
                            sim5.finish(order["id"])
                            log("🎉 VERIFIED!")
                            d={"email":email,"":uname,"":pw,"":datetime.now().isoformat()}
                            accts=[]
                            if os.path.exists(ACCOUNTS):
                                try:
                                    with open(ACCOUNTS,"r",encoding="utf-8") as ff: accts=json.load(ff)
                                except: accts=[]
                            accts.append(d)
                            with open(ACCOUNTS,"w",encoding="utf-8") as ff: json.dump(accts,ff,indent=2)
                            return d
                        sim5.cancel(order["id"])
            
            return None
    except Exception as e:
        log(f"❌ {e}"); traceback.print_exc()
        return None
    finally:
        try: await context.close()
        except: pass


async def main():
    log(f"\n{'='*50}")
    log(f"GMAIL FINAL — MOBILE EMULATION + REAL PROFILE")
    log(f"5sim: {Sim5(FIVESIM_KEY).bal()} RUB")
    log(f"{'='*50}")
    r = await gmail__mobile()
    if r: log(f"\n🎉 {r['email']} | {r['']}")
    else: log(f"\n❌ FAILED")

if __name__ == "__main__":
    asyncio.run(main())
