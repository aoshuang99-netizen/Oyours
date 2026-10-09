# -*- coding: utf-8 -*-
"""
_gmail_v15.py — YOUTUBE ENTRY REGISTRATION

Strategy: Use YouTube's "Create Account" flow instead of bare Google signup.
YouTube  have the same Gmail email but lower security checks.

Usage: python _gmail_v15.py
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

FIVESIM_KEY = "eyJhbGciOiJSUzUxMiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE4MTM3MzQ3ODEsImlhdCI6MTc4MjE5ODc4MSwicmF5IjoiNjIxMWY0MjAyNmM2YjZkNDMxMjMxYjY0MDkwMzg3MDIiLCJzdWIiOjQyMjIwNTB9.wRPYREkUdv60wd68XujZqXlravtg01aMWYECx0Bl1fLqC2uxL2yELzAIWIG_b_yAhKrymtxV5XsGlCpBm_uapnwJZhUw7LyHHnYl_V6weL6uEvk2ayrcIhaUCa13RORmRen8fXdrElnO_flZqQpeJRqm7gpUQF-HSy8Az3iy3j0JWvW9pfg_sAZTCA6vlADn66lrZ36O5g3NiKoTtTB0SYo8lfzFxtBbROc6gSMg_46dmn1hjNgJB6cetJ33DLQ1UJCuckcjV_lVfiPIMYT51RIqaRS8zyPaCTT8938whKFHbbJgWpne-6ldHmdeDudWDtytElk7d204shjBL1q1ww"
PROXY_URL = "http://:10808"

FIRST = ["James","John","Robert","Michael","David","William","Richard","Joseph","Thomas","Christopher","Daniel","Matthew","Anthony","Mark","Paul","Steven","Andrew","Kenneth","George","Brian","Kevin","Jason","Jeff","Scott"]
LAST = ["Smith","Johnson","Williams","Brown","Jones","Garcia","Miller","Davis","Rodriguez","Martinez","Hernandez","Lopez","Gonzalez","Wilson","Anderson","Thomas","Taylor","Moore","Jackson","Martin","Lee","White","Harris"]

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


async def human_mouse(page, seconds=2):
    vp = page.viewport_size or {"width":1280,"height":800}
    for _ in range(random.randint(2,5)):
        await page.mouse.move(
            random.randint(vp["width"]//4, vp["width"]*3//4),
            random.randint(vp["height"]//4, vp["height"]*3//4),
            steps=random.randint(5,15)
        )
        await asyncio.sleep(random.uniform(0.2, 0.6))
    await asyncio.sleep(seconds)


async def fill__v15(page):
    """Fill  — combined native select + Material click"""
    month_name = ["","January","February","March","April","May","June","July","August","September","October","November","December"]
    month_abbr = ["","jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"]
    
    yr, mo, dy = random.randint(1980,2002), random.randint(1,12), random.randint(1,28)
    g = random.choice(["Male","Female"])
    log(f"    Birthday: {mo}/{dy}/{yr} {g}")
    
    try:
        await page.wait_for_selector('input, [role="button"], select', timeout=10000)
        await asyncio.sleep(1)
        
        # Try native select first
        await page.evaluate(f"""
            const m=document.querySelector('#month,select[aria-label*="Month"]');
            const d=document.querySelector('#day,input[aria-label*="Day"]');
            const y=document.querySelector('#year,input[aria-label*="Year"]');
            const g=document.querySelector('#gender,select[aria-label*="Gender"]');
            if(m){{m.selectedIndex={mo-1};m.dispatchEvent(new Event('change',{{bubbles:true}}));}}
            if(d){{d.value='{dy}';d.dispatchEvent(new Event('input',{{bubbles:true}}));}}
            if(y){{y.value='{yr}';y.dispatchEvent(new Event('input',{{bubbles:true}}));}}
            if(g){{g.selectedIndex={'1' if g=='Male' else '2'};g.dispatchEvent(new Event('change',{{bubbles:true}}));}}
        """)
        await asyncio.sleep(0.5)
        
        # Material click approach for dropdowns
        for target, selector, text in [
            ("Month", 'span:has-text("Month"),div[role="button"]:has-text("Month")', month_abbr[mo]),
            ("Gender", 'span:has-text("Gender"),div[role="button"]:has-text("Gender")', "m" if g=="Male" else "f"),
        ]:
            el = page.locator(selector).first
            if await el.count() > 0:
                try:
                    await el.click(force=True, timeout=3000)
                    await asyncio.sleep(0.5)
                    await page.keyboard.type(text, delay=60)
                    await asyncio.sleep(0.3)
                    await page.keyboard.press("Enter")
                except: pass
        
        log(f"    \u2713 Birthday filled: {month_name[mo]} {dy}, {yr} | {g}")
        
        # Close any open dropdowns before proceeding
        await page.keyboard.press("Escape")
        await asyncio.sleep(0.5)
        await page.keyboard.press("Escape")
        await asyncio.sleep(0.3)
        
        return True, yr, mo, dy, g
    except Exception as e:
        log(f"    \u2717 Birthday error: {e}")
        return False, yr, mo, dy, g


async def yt_(attempt_num):
    """Register via YouTube's Create Account flow"""
    yr, mo, dy = random.randint(1980,2002), random.randint(1,12), random.randint(1,28)
    g = random.choice(["Male","Female"])
    f, l = random.choice(FIRST), random.choice(LAST)
    uname = f"{f.lower()}{l.lower()}{random.randint(100,9999)}"
    pw = (random.choice(string.ascii_uppercase) + "".join(random.choices(string.ascii_lowercase,k=5)) + "".join(random.choices(string.digits,k=4)) + "!")
    email = f"{uname}@gmail.com"
    
    log("")
    log("="*60)
    log(f"YT #REGISTER {attempt_num} | {email} | {f} {l}")
    log("="*60)
    
    browser = None
    try:
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(
                headless=False,
                proxy={"server":PROXY_URL},
                args=["--no-sandbox","--disable-blink-features=AutomationControlled"]
            )
            context = await browser.new_context(
                viewport={"width":1366,"height":768},
                locale="en-US",
                timezone_id="America/Los_Angeles",
                geolocation={"latitude":34.05,"longitude":-118.24},
                permissions=["geolocation"],
            )
            page = await context.new_page()
            
            # Stealth
            stealth = Stealth(navigator_webdriver=True,navigator_languages=True,chrome_runtime=True,chrome_app=True,hairline=True)
            await stealth.apply_stealth_async(page)
            
            # ═══ STEP 1: Go to YouTube ═══
            log("[1] Opening YouTube...")
            await page.goto("https://www.youtube.com", timeout=30000, wait_until="domcontentloaded")
            await asyncio.sleep(4)
            await human_mouse(page, 2)
            
            # ═══ STEP 2: Click Sign In → Create account ═══
            log("[2] Clicking 'Sign in'...")
            for sig in ['a:has-text("Sign in")', '"Sign in")', '[aria-label*="Sign in"]']:
                btn = page.locator(sig).first
                if await btn.count() > 0:
                    await btn.click(timeout=5000)
                    break
            await asyncio.sleep(4)
            
            # Take screenshot
            await page.screenshot(path=os.path.join(SS, f"v15_yt_signin_{attempt_num}.png"))
            
            # ═══ STEP 3: Create account ═══
            log("[3] Clicking 'Create account'...")
            for cre in ['span:has-text("Create account")', '"Create account")', 'a:has-text("Create account")']:
                btn = page.locator(cre).first
                if await btn.count() > 0:
                    await btn.click(timeout=5000)
                    break
            await asyncio.sleep(3)
            
            # Click "For myself"
            for myself in ['span:has-text("For myself")', 'span:has-text("For my personal use")']:
                btn = page.locator(myself).first
                if await btn.count() > 0:
                    await btn.click(timeout=5000)
                    break
            await asyncio.sleep(3)
            
            await page.screenshot(path=os.path.join(SS, f"v15_create_{attempt_num}.png"))
            
            # ═══ STEP 4: Fill name ═══
            log(f"[4] Name: {f} {l}")
            for sel, val in [('"firstName"]',f), ('"lastName"]',l)]:
                inp = page.locator(sel).first
                if await inp.count() > 0:
                    await inp.click(timeout=3000)
                    for c in val: await inp.type(c, delay=random.randint(40,100))
                    await asyncio.sleep(0.3)
            
            for nxt in ['"Next")', '"Continue")']:
                btn = page.locator(nxt).first
                if await btn.count() > 0:
                    try: await btn.click(timeout=5000, force=True)
                    except: await page.keyboard.press("Enter")
                    break
            await asyncio.sleep(5)
            
            # ═══ STEP 5: Birthday ═══
            log(f"[5] Birthday...")
            ok, yr, mo, dy, g = await fill__v15(page)
            if not ok:
                log("    BIRTHDAY FAILED — skipping")
            
            for nxt in ['"Next")', '"Continue")']:
                btn = page.locator(nxt).first
                if await btn.count() > 0:
                    try: await btn.click(timeout=5000, force=True)
                    except: await page.keyboard.press("Enter")
                    break
            await asyncio.sleep(5)
            
            # Check for redirect
            curl = page.url.lower()
            log(f"    URL: {curl[:80]}")
            
            if "gender" in curl:
                log("    \u2717 Redirected to  — anti-bot detected")
                await page.screenshot(path=os.path.join(SS, f"v15_redirect_{attempt_num}.png"))
                
                # Try again with different 
                log("    Retrying with manual input...")
                # Try direct input approach
                for dd in page.locator('input').all():
                    try:
                        label = await dd.get_attribute('aria-label') or ''
                        if 'month' in label.lower():
                            await dd.click(force=True)
                            abbr = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"][mo-1]
                            await dd.fill(abbr)
                        elif 'day' in label.lower():
                            await dd.fill(str(dy))
                        elif 'year' in label.lower():
                            await dd.fill(str(yr))
                    except: pass
                
                await asyncio.sleep(2)
                for nxt in ['"Next")']:
                    btn = page.locator(nxt).first
                    if await btn.count() > 0:
                        await btn.click(timeout=5000)
                        break
                await asyncio.sleep(5)
            
            curl = page.url.lower()
            if "gender" in curl:
                log("    \u2717 Still redirected — giving up on this attempt")
                return None
            
            # ═══ STEP 6: Username ═══
            log(f"[6] Username: {uname}")
            await page.screenshot(path=os.path.join(SS, f"v15__{attempt_num}.png"))
            
            # Handle "Create your own"
            for cl in ['span:has-text("Create your own")', '"Create your own")']:
                el = page.locator(cl).first
                if await el.count() > 0:
                    try: await el.click(timeout=3000); await asyncio.sleep(2)
                    except: pass
            
            un_in = page.locator('"Username"]').first
            if await un_in.count() > 0:
                await un_in.click(timeout=3000)
                await un_in.fill(uname)
                await asyncio.sleep(1)
            
            for nxt in ['"Next")', '"Continue")']:
                btn = page.locator(nxt).first
                if await btn.count() > 0:
                    try: await btn.click(timeout=5000, force=True)
                    except: await page.keyboard.press("Enter")
                    break
            await asyncio.sleep(5)
            
            if "gender" in page.url.lower():
                log("    \u2717 Redirect after  — proxy flagged")
                return None
            
            log("    \u2713 Username accepted!")
            
            # ═══ STEP 7:  ═══
            log(f"[7] ...")
            pws = page.locator('""]')
            pc = await pws.count()
            if pc >= 2:
                await pws.nth(0).fill(pw)
                await pws.nth(1).fill(pw)
            elif pc == 1:
                await pws.nth(0).fill(pw)
            
            for nxt in ['"Next")', '"Continue")']:
                btn = page.locator(nxt).first
                if await btn.count() > 0:
                    try: await btn.click(timeout=5000, force=True)
                    except: await page.keyboard.press("Enter")
                    break
            await asyncio.sleep(5)
            
            await page.screenshot(path=os.path.join(SS, f"v15_postpw_{attempt_num}.png"))
            
            # ═══ STEP 8: Terms ═══
            log("[8] Terms & recovery...")
            body = (await page.locator("body").inner_text()).lower()
            
            if "terms" in body or "privacy" in body:
                for l in ["I agree","Agree"]:
                    b = page.locator(f'"{l}")').first
                    if await b.count()>0: await b.click(timeout=3000); break
                await asyncio.sleep(3)
            
            if "skip" in body or "recovery" in body:
                for l in ["Skip","Not now"]:
                    b = page.locator(f'"{l}")').first
                    if await b.count()>0: await b.click(timeout=3000); break
                await asyncio.sleep(2)
            
            for nxt in ['"Next")']:
                btn = page.locator(nxt).first
                if await btn.count() > 0:
                    await btn.click(timeout=5000)
                    break
            await asyncio.sleep(5)
            
            # ═══ STEP 9: Phone ═══
            log("[9] Phone verification...")
            await page.screenshot(path=os.path.join(SS, f"v15_phone_{attempt_num}.png"))
            
            curl = page.url.lower()
            body = (await page.locator("body").inner_text()).lower()
            
            if "" in curl or "mail.google.com" in curl or "youtube.com" in curl:
                log("\U0001F389 NO VERIFICATION NEEDED!")
                d = {"email":email,"":uname,"":pw,"":datetime.now().isoformat(),"status":"active"}
                accts = []
                if os.path.exists(ACCOUNTS):
                    try:
                        with open(ACCOUNTS,"r",encoding="utf-8") as ff: accts = json.load(ff)
                    except: accts=[]
                accts.append(d)
                with open(ACCOUNTS,"w",encoding="utf-8") as ff: json.dump(accts,ff,indent=2)
                log(f"  \U0001f4be Saved: {email}")
                return d
            
            # Try skip
            for lbl in ["Skip","Skip for now","Not now","Later"]:
                btn = page.locator(f'"{lbl}"),span:has-text("{lbl}")')
                if await btn.count()>0:
                    await btn.first.click(timeout=5000)
                    await asyncio.sleep(3)
                    if "" in page.url.lower() or "mail.google.com" in page.url.lower() or "youtube.com" in page.url.lower():
                        log("\U0001F389 SUCCESS!")
                        return {"email":email,"":uname,"":pw}
                    break
            
            # Phone verify via 5sim
            if "verify" in body or "phone" in body:
                sim5 = Sim5(FIVESIM_KEY)
                order = sim5.buy(country="indonesia")
                if order:
                    log(f"    \U0001F1EE\U0001F1E9 {order['phone']}")
                    pi = page.locator('"tel"],"phoneNumber"]').first
                    if await pi.count()>0: await pi.fill(order["phone"])
                    await asyncio.sleep(1)
                    for nxt in ['"Next")']:
                        btn = page.locator(nxt).first
                        if await btn.count()>0: await btn.click(timeout=5000); break
                    await asyncio.sleep(3)
                    
                    code = sim5.wait(order["id"])
                    if code:
                        log(f"    CODE: {code}")
                        ci = page.locator('"hidden"""])').first
                        if await ci.count()>0: await ci.fill(code)
                        for nxt in ['"Next")']:
                            btn = page.locator(nxt).first
                            if await btn.count()>0: await btn.click(timeout=5000); break
                        await asyncio.sleep(6)
                        
                        if "welcome" in (await page.locator("body").inner_text()).lower() or "" in page.url.lower():
                            sim5.finish(order["id"])
                            log("\U0001F389 VERIFIED!")
                            return {"email":email,"":uname,"":pw}
                        else:
                            sim5.cancel(order["id"])
            
            return None
            
    except Exception as e:
        log(f"\u274c Error: {e}")
        traceback.print_exc()
        return None
    finally:
        if browser:
            try: await browser.close()
            except: pass


async def main():
    log(f"\n{'='*60}")
    log(f"GMAIL v15 — YOUTUBE ENTRY REGISTRATION")
    log(f"Proxy: {PROXY_URL}")
    log(f"5sim: {Sim5(FIVESIM_KEY).bal()} RUB")
    log(f"{'='*60}")
    
    result = await yt_(1)
    if result:
        log(f"\n\U0001f389 SUCCESS: {result['email']} | {result['']}")
    else:
        log(f"\n\u274c FAILED")

if __name__ == "__main__":
    asyncio.run(main())
