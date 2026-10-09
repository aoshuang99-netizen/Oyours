# -*- coding: utf-8 -*-
"""
_gmail_v9.py — Full ShadowHackrs Technique Integration

从 ShadowHackrs/gmail-account-creator 提取的关键技术:
  1. ✅ 使用 signup/v2/createaccount (不是 webcreateaccount)
  2. ✅ 使用 #month/#gender/#year 原生 select + dispatchEvent(change)
  3. ✅ 使用 #selectionc2 选择自定义用户名
  4. ✅ 非headless模式 (headless: false)
  5. ✅ --incognito 模式
  6. ✅ 随机生日 (每次不同)
  7. ✅ 5sim Indonesia 接码 (已验证可用)

用法: python _gmail_v9.py
"""

import asyncio, json, os, random, re, string, sys, time, traceback
from datetime import datetime

if sys. == "win32":
    try: sys.stdout.reconfigure(encoding="utf-8")
    except: pass

from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.abspath(__file__))
SS = os.path.join(ROOT, "gmail-data", "screenshots")
ACCOUNTS = os.path.join(ROOT, "gmail-data", ".json")
for d in [os.path.dirname(SS)]: os.makedirs(d, exist_ok=True)

def log(msg): print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)

FIRST = ["James","John","Robert","Michael","David","William","Richard",
         "Joseph","Thomas","Christopher","Daniel","Matthew","Anthony",
         "Mark","Paul","Steven","Andrew","Kenneth","George","Brian",
         "Kevin","Jason","Jeff","Scott","Eric","Ryan","Justin","Brandon"]
LAST = ["Smith","Johnson","Williams","Brown","Jones","Garcia","Miller",
        "Davis","Rodriguez","Martinez","Hernandez","Lopez","Gonzalez",
        "Wilson","Anderson","Thomas","Taylor","Moore","Jackson","Martin",
        "Lee","White","Harris","Clark","Lewis","Walker","Hall","Allen"]

FIVESIM_KEY = "eyJhbGciOiJSUzUxMiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE4MTMyMTY4NjUsImlhdCI6MTc4MTY4MDg2NSwicmF5IjoiNjIxMWY0MjAyNmM2YjZkNDMxMjMxYjY0MDkwMzg3MDIiLCJzdWIiOjQyMjIwNTB9.yQynL-xH5YwzT3xvHtoUIJo3l5A2-wQu0_gGnoQ5J7m6rpSR9yTuzWy0GELllhDDjxo3fDTEBDSm5pZBQOIUFJquJAJMnpEH2U0ymOPWkbIe8BNg4KyC9syN7jh9DyHmDi4eio8qP3ZUqNwNH8XnNUncoovECkzEtWtmGDxTsP3sy7lvqPoBSGivkbFvAAzSOs1w6jAntupK_41KuwTBiMig60WD7p7W8xwcQi3df-WohHJ6YNGvFj8MtKBoIY6cIaho56WEbjOUiG39NFtO11yzq9x1jSNhFpbPhk_7wOFlOd-JQNcSmslW-ECeBUyGjBZZnLD3DNSgkRDpR1fWrQ"

import requests as _req

class Sim5:
    B = "https://5sim.net/v1"
    def __init__(self, key): 
        self.s = _req.Session()
        self.s.headers.update({"": f"Bearer {key}", "Accept": "application/json"})
    def _g(self, path, params=None, t=20):
        r = self.s.get(f"{self.B}{path}", params=params, timeout=t)
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
            cd = d.get("code")or d.get("sms_code")
            if cd: return {"s":"RECEIVED","code":str(cd)}
        return {"s":s}
    def wait(self, oid, timeout=180, iv=3):
        start = time.time()
        while time.time()-start < timeout:
            r = self.chk(oid)
            if r["s"]=="RECEIVED" and r.get("code"):
                log(f"  [5sim] ✓ CODE: {r['code']} ({int(time.time()-start)}s)"); return r["code"]
            if r["s"] in ("CANCELED","TIMEOUT","BANNED","ERROR"):
                log(f"  [5sim] ✗ {r['s']}"); return None
            time.sleep(iv)
        return None
    def cancel(self, oid): self._g(f"/user/cancel/{oid}")
    def finish(self, oid): self._g(f"/user/finish/{oid}")


def gen():
    f,l = random.choice(FIRST), random.choice(LAST)
    u = f"{f.lower()}{l.lower()}{random.randint(100,9999)}"
    p = random.choice(string.ascii_uppercase)+"".join(random.choices(string.ascii_lowercase,k=5))+"".join(random.choices(string.digits,k=4))+"!"
    y,m,d = random.randint(1980,2005), random.randint(1,12), random.randint(1,28)
    g = random.choice(["Male","Female"])
    return f,l,u,p,y,m,d,g


async def main():
    f,l,u,pw,yr,mo,dy,g = gen()
    email = f"{u}@gmail.com"
    
    # RANDOM  every time!
    gender_idx = 1 if g == "Male" else 2

    log("="*60)
    log(f"🎯 {email} | {f} {l} | 🎂 {yr}-{mo:02d}-{dy:02d} | {g}")
    log(f"   ShadowHackrs Method: createaccount + native select + dispatchEvent")
    log("="*60)

    async with async_playwright() as pw:
        # KEY: non-headless mode like the original tool
        browser = await pw.chromium.launch(
            channel="chrome",
            headless=False,  # CRITICAL: non-headless like original
            args=["--no-sandbox", "--disable-blink-features=AutomationControlled",
                  "--incognito",  # CRITICAL: incognito mode
                  "--window-size=800,600",  # Smaller window like original
                  "--window-position=1921,0"]
        )
        ctx = await browser.new_context(
            viewport={"width": 800, "height": 600},
            locale="en-US", timezone_id="America/New_York"
        )
        page = await ctx.new_page()
        
        # Inject webdriver override
        await page.add_init_script("""
            Object.defineProperty(navigator, 'webdriver', {get: () => false});
            Object.defineProperty(navigator, 'plugins', {get: () => [1,2,3,4,5]});
        """)
        
        order = None
        try:
            # ═══ STEP 1: Open signup with SHADOWHACKRS URL ═══
            log("[1] Opening signup (ShadowHackrs URL)...")
            await page.goto(
                "https://.google.com/signup/v2/createaccount?flowName=GlifWebSignIn&flowEntry=SignUp",
                timeout=30000, wait_until="domcontentloaded"
            )
            await asyncio.sleep(random.uniform(3, 5))
            log(f"    URL: {page.url[:100]}")

            # ═══ STEP 2: Name ═══
            log(f"[2] Name: {f} {l}")
            await page.wait_for_selector('"firstName"]', timeout=10000)
            await page.type('"firstName"]', f, delay=random.randint(30, 80))
            await asyncio.sleep(random.uniform(0.3, 0.8))
            await page.type('"lastName"]', l, delay=random.randint(30, 80))
            
            # Click Next using SHADOWHACKRS selector
            await asyncio.sleep(random.uniform(0.5, 1.5))
            await page.click('#collectNameNext > div > button > span')
            log(f"    ✓ Name submitted")
            await asyncio.sleep(random.uniform(4, 6))

            # ═══ STEP 3: Birthday using NATIVE SELECT (ShadowHackrs method!) ═══
            log(f"[3] Birthday: {mo}/{dy}/{yr} Gender: {g}")
            await page.wait_for_selector('#day', state='visible')
            
            # Day
            await page.type('#day', str(dy), delay=random.randint(40, 100))
            log(f"    Day: {dy}")
            await asyncio.sleep(random.uniform(0.3, 0.7))
            
            # Year
            await page.wait_for_selector('#year')
            await page.type('#year', str(yr), delay=random.randint(40, 100))
            log(f"    Year: {yr}")
            await asyncio.sleep(random.uniform(0.3, 0.7))
            
            # Month — NATIVE SELECT with dispatchEvent (ShadowHackrs exact method!)
            month_idx = mo - 1  # 0-based index
            await page.evaluate(f"""
                const monthDropdown = document.querySelector('#month');
                monthDropdown.selectedIndex = {month_idx};
                monthDropdown.dispatchEvent(new Event('change'));
            """)
            log(f"    Month: {mo} (native select)")
            await asyncio.sleep(random.uniform(0.3, 0.7))
            
            # Gender — NATIVE SELECT with dispatchEvent
            await page.evaluate(f"""
                const genderDropdown = document.querySelector('#gender');
                genderDropdown.selectedIndex = {gender_idx};
                genderDropdown.dispatchEvent(new Event('change'));
            """)
            log(f"    Gender: {g} (native select)")
            await asyncio.sleep(random.uniform(0.5, 1.5))
            
            # Click Next
            await page.click('#genderNext > div > button > span')
            await asyncio.sleep(random.uniform(3, 5))
            
            # ═══ STEP 4: Username using SHADOWHACKRS method ═══
            log(f"[4] Username: {u}")
            
            # Wait for and click "Create your own Gmail address"
            try:
                await page.wait_for_selector('#selectionc2', timeout=10000)
                await asyncio.sleep(random.uniform(1, 2))
                selectionText = await page.evaluate('document.querySelector("#selectionc2").textContent')
                log(f"    Option: {selectionText}")
                await page.click('#selectionc2')
                log(f"    ✓ Clicked 'Create your own'")
            except:
                log(f"    ⚠ #selectionc2 not found, trying fallback...")
                for lbl in ["Create your own", "Create your own Gmail address"]:
                    el = page.locator(f'span:has-text("{lbl}")').first
                    if await el.count() > 0:
                        await el.click(timeout=3000); log(f"    ✓ Clicked '{lbl}'"); break
            
            await asyncio.sleep(random.uniform(1, 3))
            
            # Fill 
            un_inp = page.locator('"Username"]').first
            if await un_inp.count() > 0:
                await un_inp.fill(u)
                log(f"    ✓ Username filled")
            
            await asyncio.sleep(random.uniform(2, 4))  # Human-like pause
            
            # Check for redirect before clicking Next
            curl = page.url.lower()
            if "/gender" in curl:
                log(f"    ⚠ Already on  page — refilling...")
                await page.type('#day', str(dy))
                await page.evaluate(f"document.querySelector('#month').selectedIndex={month_idx};document.querySelector('#month').dispatchEvent(new Event('change'))")
                await page.type('#year', str(yr))
                await page.evaluate(f"document.querySelector('#gender').selectedIndex={gender_idx};document.querySelector('#gender').dispatchEvent(new Event('change'))")
                await page.click('#genderNext > div > button > span')
                await asyncio.sleep(4)
            
            await page.click('#next > div > button > div.VfPpkd-RLmnJb')
            await asyncio.sleep(random.uniform(4, 6))
            
            # Check for redirect
            body = (await page.locator("body").inner_text()).lower()
            curl2 = page.url.lower()
            
            if "/gender" in curl2:
                log(f"    ⚠ Redirect detected — ONE retry...")
                await _refill_(page, yr, mo, dy, g, month_idx, gender_idx)
                await page.click('#genderNext > div > button > span')
                await asyncio.sleep(4)
                await asyncio.sleep(random.uniform(1, 2))
                # Re-click create your own
                try:
                    await page.waitForSelector('#selectionc2', timeout=5000)
                    await page.click('#selectionc2')
                except: pass
                await asyncio.sleep(1)
                un2 = page.locator('"Username"]').first
                if await un2.count() > 0: await un2.fill(u)
                await asyncio.sleep(2)
                await page.click('#next > div > button > div.VfPpkd-RLmnJb')
                await asyncio.sleep(5)
            
            body = (await page.locator("body").inner_text()).lower()
            if any(k in body for k in ["taken", "already used", "exists"]):
                u = f"{f.lower()}{l.lower()}{random.randint(100,9999)}"
                email = f"{u}@gmail.com"
                log(f"    taken → {u}")
                # refill and retry
                un2 = page.locator('"Username"]').first
                if await un2.count() > 0: await un2.fill(u)
                await asyncio.sleep(2)
                await page.click('#next > div > button > div.VfPpkd-RLmnJb')
                await asyncio.sleep(4)
            
            log(f"    ✓ Username: {u}")
            await page.screenshot(path=os.path.join(SS, f"v9_after_.png"))
            
            # ═══ STEP 5:  ═══
            log("[5] ...")
            await asyncio.sleep(random.uniform(2, 4))
            try: await page.waitForSelector('#passwd', timeout=15000)
            except: log("    ⚠ #passwd not found")
            
            try: await page.waitForSelector('', timeout=5000)
            except: pass
            
            pw1 = page.locator('#passwd, "Passwd"]').first
            pw2 = page.locator(', "PasswdAgain"]').first
            
            if await pw1.count() > 0:
                await pw1.fill(pw)
                log(f"    ✓ Passwd 1")
            if await pw2.count() > 0:
                await pw2.fill(pw)
                log(f"    ✓ Passwd 2 (confirm)")
            
            await asyncio.sleep(random.uniform(0.5, 1.5))
            await page.click('#createNext > div > button > div.VfPpkd-RLmnJb')
            await asyncio.sleep(random.uniform(4, 7))
            
            # ═══ STEP 6: Terms / Skip ═══
            log("[6] Terms & recovery...")
            body = (await page.locator("body").inner_text()).lower()
            if "terms" in body or "privacy" in body:
                for l in ["I agree", "Agree", "Next"]:
                    b = page.locator(f'"{l}")').first
                    if await b.count() > 0: await b.click(timeout=3000); break
                await asyncio.sleep(3)
            await asyncio.sleep(2)
            body = (await page.locator("body").inner_text()).lower()
            if "skip" in body or "recovery" in body:
                for l in ["Skip", "Not now"]:
                    b = page.locator(f'"{l}")').first
                    if await b.count() > 0: await b.click(timeout=3000); break
                await asyncio.sleep(2)
            
            # Try Next
            await page.keyboard.press("Enter")
            await asyncio.sleep(random.uniform(4, 6))
            
            # ═══ STEP 7: Phone Verification ═══
            log("[7] Phone verification...")
            await page.screenshot(path=os.path.join(SS, f"v9_verify_{u}.png"))
            body = (await page.locator("body").inner_text()).lower()
            curl = page.url.lower()
            
            log(f"    URL: {curl[:100]}")
            
            # Already in Gmail?
            if "" in curl or "mail.google.com" in curl:
                log("🎉 NO VERIFICATION NEEDED!")
                return _save(email, u, pw)
            
            # Skip button?
            for lbl in ["Skip", "Skip for now", "Not now", "Later"]:
                btn = page.locator(f'"{lbl}"),span:has-text("{lbl}")')
                if await btn.count() > 0:
                    await btn.first.click(timeout=5000)
                    log(f"    ✓ Clicked '{lbl}'")
                    await asyncio.sleep(3)
                    curl2 = page.url.lower()
                    if "" in curl2 or "mail.google.com" in curl2:
                        log("🎉 SUCCESS!"); return _save(email, u, pw)
                    break
            
            # Use 5sim Indonesia SMS
            if "phone" in body or "verify" in body or "number" in body:
                sim5 = Sim5(FIVESIM_KEY)
                bal = sim5.bal()
                log(f"    5sim: {bal} RUB")
                
                if bal < 0.2:
                    log("    ⚠ Low balance"); return
                
                order = sim5.buy(country="indonesia")
                if not order:
                    log("    ⚠ Buy failed"); return
                
                phone = order["phone"]
                log(f"    📱 Indonesia: {phone} (#{order['id']}, {order['price']}RUB)")
                
                # Fill phone
                pi = page.locator('"tel"],"phoneNumber"],#phoneNumberId').first
                if await pi.count() > 0:
                    await pi.fill(phone)
                    log(f"    ✓ Phone filled")
                
                await asyncio.sleep(random.uniform(1, 2))
                await page.keyboard.press("Enter")  # Submit
                await asyncio.sleep(2)
                
                log("    ⏳ Waiting for SMS...")
                code = sim5.wait(order["id"], timeout=180, iv=3)
                
                if code:
                    log(f"    ✓ CODE: {code}")
                    ci = page.locator('"hidden"""])').first
                    if await ci.count() > 0:
                        await ci.fill(code)
                        await page.keyboard.press("Enter")
                        await asyncio.sleep(6)
                        
                        pu = page.url.lower()
                        pb = (await page.locator("body").inner_text()).lower()
                        
                        if "" in pb or "wrong" in pb:
                            log("    ✗ Wrong code"); sim5.cancel(order["id"])
                        elif "" in pu or "mail.google.com" in pu or "welcome" in pb:
                            log("🎉 VERIFIED!"); sim5.finish(order["id"])
                            await page.screenshot(path=os.path.join(SS, f"v9_success_{u}.png"))
                            return _save(email, u, pw)
                        elif "signup" not in pu and "verify" not in pu:
                            sim5.finish(order["id"])
                            return _save(email, u, pw)
                        else:
                            log(f"    ? {pu[:80]}"); sim5.cancel(order["id"])
                else:
                    log("    ✗ No code"); sim5.cancel(order["id"])
            else:
                log(f"    ? Body: {body[:200]}")
                await page.keyboard.press("Enter"); await asyncio.sleep(4)
                curl2 = page.url.lower()
                if "" in curl2 or "mail.google.com" in curl2:
                    return _save(email, u, pw)
            
            await page.screenshot(path=os.path.join(SS, f"v9_final_{u}.png"))
            
        except Exception as e:
            log(f"❌ {e}"); traceback.print_exc()
            if order:
                try: sim5.cancel(order["id"])
                except: pass
        finally:
            await browser.close()


async def _refill_(page, yr, mo, dy, g, month_idx, gender_idx):
    """Refill  using native select method"""
    await page.wait_for_selector('#day', state='visible')
    await page.type('#day', str(dy))
    await page.evaluate(f"document.querySelector('#month').selectedIndex={month_idx};document.querySelector('#month').dispatchEvent(new Event('change'))")
    await page.type('#year', str(yr))
    await page.evaluate(f"document.querySelector('#gender').selectedIndex={gender_idx};document.querySelector('#gender').dispatchEvent(new Event('change'))")
    log(f"    ↻ Birthday refilled: {mo}/{dy}/{yr}")


def _save(email, u, pw):
    d = {"email": email, "": u, "": pw, "": datetime.now().isoformat(), "status": "active"}
     = []
    if os.path.exists(ACCOUNTS):
        with open(ACCOUNTS, "r", encoding="utf-8") as f:
             = json.load(f)
    .append(d)
    with open(ACCOUNTS, "w", encoding="utf-8") as f:
        json.dump(, f, indent=2, ensure_ascii=False)
    log(f"  💾 Saved: {email}")
    return d


if __name__ == "__main__":
    r = asyncio.run(main())
    print(f"\n{'🎉 '+r['email'] if r else '❌ FAILED'}")
