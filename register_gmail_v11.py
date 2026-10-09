# -*- coding: utf-8 -*-
"""
_gmail_v11.py — US PROXY BREAKTHROUGH!

使用本地代理 :10808 (美国洛杉矶 IP: 74.211.97.178)
+ ShadowHackrs 原生select技术
+ 随机生日
+ 5sim Indonesia SMS接码

用法: python _gmail_v11.py
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

# US PROXY — confirmed working!
PROXY = {"server": "http://:10808"}
US_PROXY_IP = "74.211.97.178"  # Los Angeles, California

def log(msg): print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)

FIRST = ["James","John","Robert","Michael","David","William","Richard","Joseph","Thomas","Christopher","Daniel","Matthew","Anthony","Mark","Paul","Steven","Andrew","Kenneth","George","Brian","Kevin","Jason","Jeff","Scott","Eric","Ryan","Justin","Brandon"]
LAST = ["Smith","Johnson","Williams","Brown","Jones","Garcia","Miller","Davis","Rodriguez","Martinez","Hernandez","Lopez","Gonzalez","Wilson","Anderson","Thomas","Taylor","Moore","Jackson","Martin","Lee","White","Harris","Clark","Lewis","Walker","Hall","Allen"]

FIVESIM_KEY = "eyJhbGciOiJSUzUxMiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE4MTMyMTY4NjUsImlhdCI6MTc4MTY4MDg2NSwicmF5IjoiNjIxMWY0MjAyNmM2YjZkNDMxMjMxYjY0MDkwMzg3MDIiLCJzdWIiOjQyMjIwNTB9.yQynL-xH5YwzT3xvHtoUIJo3l5A2-wQu0_gGnoQ5J7m6rpSR9yTuzWy0GELllhDDjxo3fDTEBDSm5pZBQOIUFJquJAJMnpEH2U0ymOPWkbIe8BNg4KyC9syN7jh9DyHmDi4eio8qP3ZUqNwNH8XnNUncoovECkzEtWtmGDxTsP3sy7lvqPoBSGivkbFvAAzSOs1w6jAntupK_41KuwTBiMig60WD7p7W8xwcQi3df-WohHJ6YNGvFj8MtKBoIY6cIaho56WEbjOUiG39NFtO11yzq9x1jSNhFpbPhk_7wOFlOd-JQNcSmslW-ECeBUyGjBZZnLD3DNSgkRDpR1fWrQ"

import requests as _req
class Sim5:
    B = "https://5sim.net/v1"
    def __init__(self, key): self.s = _req.Session(); self.s.headers.update({"": f"Bearer {key}", "Accept": "application/json"})
    def _g(self, p, params=None, t=20):
        r = self.s.get(f"{self.B}{p}", params=params, timeout=t)
        return r.json() if r.status_code < 400 else None
    def bal(self): d = self._g("/user/profile"); return d.get("balance", 0) if d else 0
    def buy(self, c="indonesia"):
        d = self._g(f"/user/buy/activation/{c}/any/google")
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
                log(f"  [5sim] ✓ {r['code']} ({int(time.time()-start)}s)"); return r["code"]
            if r["s"] in ("CANCELED","TIMEOUT","BANNED","ERROR"):
                log(f"  [5sim] ✗ {r['s']}"); return None
            time.sleep(iv)
        return None
    def cancel(self, oid): self._g(f"/user/cancel/{oid}")
    def finish(self, oid): self._g(f"/user/finish/{oid}")


async def _fill_(page, yr, mo, dy, g):
    """Native select first, Material keyboard fallback"""
    try:
        await page.wait_for_selector('#day', timeout=5000)
        await page.fill('#day', str(dy))
        await page.evaluate(f"""document.querySelector('#month').selectedIndex = {mo-1};document.querySelector('#month').dispatchEvent(new Event('change'));""")
        await page.fill('#year', str(yr))
        gi = 1 if g == "Male" else 2
        await page.evaluate(f"""document.querySelector('#gender').selectedIndex = {gi};document.querySelector('#gender').dispatchEvent(new Event('change'));""")
        log("    ✓ Native select")
        return
    except:
        pass
    
    # Material fallback
    MONTH = ["","jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"]
    mt = page.locator('[role="listbox"]:has-text("Month"),div[aria-label*="Month" i]').first
    if await mt.count() > 0:
        await mt.click(force=True, timeout=5000); await asyncio.sleep(0.5)
        await page.keyboard.type(MONTH[mo], delay=30); await asyncio.sleep(0.3)
        await page.keyboard.press("Enter")
    await asyncio.sleep(0.3)
    for s in ['input[aria-label*="Day" i]']:
        di = page.locator(s).first
        if await di.count() > 0: await di.fill(str(dy)); break
    await asyncio.sleep(0.3)
    for s in ['input[aria-label*="Year" i]']:
        yi = page.locator(s).first
        if await yi.count() > 0: await yi.fill(str(yr)); break
    await asyncio.sleep(0.5)
    gk = "m" if g == "Male" else "f"
    gt = page.locator('[role="listbox"]:has-text("Gender"),div[aria-label*="Gender" i]').first
    if await gt.count() > 0:
        await gt.click(force=True, timeout=5000); await asyncio.sleep(0.5)
        await page.keyboard.type(gk, delay=50); await asyncio.sleep(0.3)
        await page.keyboard.press("Enter")
    log("    ✓ Material keyboard")


async def _next(page):
    for l in ["Next","Continue","I agree","Agree","Create account"]:
        try:
            b = page.locator(f'"{l}")').first
            if await b.count() > 0 and await b.is_visible():
                await b.click(timeout=5000); return True
        except: pass
    try: await page.keyboard.press("Enter"); return True
    except: return False


async def main():
    f,l = random.choice(FIRST), random.choice(LAST)
    u = f"{f.lower()}{l.lower()}{random.randint(100,9999)}"
    pw = random.choice(string.ascii_uppercase)+"".join(random.choices(string.ascii_lowercase,k=5))+"".join(random.choices(string.digits,k=4))+"!"
    yr,mo,dy = random.randint(1980,2005), random.randint(1,12), random.randint(1,28)
    g = random.choice(["Male","Female"])
    email = f"{u}@gmail.com"

    log("="*60)
    log(f"🎯 {email} | {f} {l} | 🎂 {yr}-{mo:02d}-{dy:02d} | {g}")
    log(f"   🌐 US PROXY: {US_PROXY_IP} (Los Angeles)")
    log("="*60)

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            channel="chrome",
            headless=False,
            proxy=PROXY,  # <- THE BREAKTHROUGH!
            args=["--no-sandbox","--disable-blink-features=AutomationControlled",
                  "--incognito","--window-size=1440,900"]
        )
        ctx = await browser.new_context(
            viewport={"width":1440,"height":900},
            locale="en-US", timezone_id="America/Los_Angeles",  # Match proxy location!
            geolocation={"latitude":34.05,"longitude":-118.27},
            permissions=["geolocation"]
        )
        page = await ctx.new_page()
        
        await page.add_init_script("""
            Object.defineProperty(navigator, 'webdriver', {get: () => false});
        """)
        
        order = None
        try:
            # Warmup with proxy
            log("[0] Warmup (via US proxy)...")
            await page.goto("https://api.ipify.org", wait_until="domcontentloaded", timeout=10000)
            ip_text = await page.locator("body").inner_text()
            log(f"    Proxy IP: {ip_text.strip()}")
            
            # Signup
            log("[1] Gmail signup (US IP)...")
            await page.goto("https://.google.com/signup/v2/webcreateaccount?hl=en&flowName=GlifWebSignIn&flowEntry=SignUp",
                           timeout=30000, wait_until="domcontentloaded")
            await asyncio.sleep(random.uniform(5,8))

            # Name
            log(f"[2] Name: {f} {l}")
            for s,v in [('"firstName"]',f),('"lastName"]',l)]:
                inp = page.locator(s).first
                if await inp.count() > 0: await inp.fill(v)
                await asyncio.sleep(random.uniform(0.2,0.5))
            await _next(page); await asyncio.sleep(random.uniform(4,6))

            # Birthday
            log(f"[3] Birthday: {mo}/{dy}/{yr} {g}")
            await _fill_(page, yr, mo, dy, g)
            await _next(page); await asyncio.sleep(random.uniform(4,6))

            # Username
            log(f"[4] Username: {u}")
            for lbl in ["Create your own","Create your own Gmail address"]:
                el = page.locator(f'span:has-text("{lbl}"),"{lbl}")').first
                if await el.count() > 0:
                    try: await el.click(timeout=3000); await asyncio.sleep(1); break
                    except: pass
            
            redirect = 0
            while redirect < 8:
                un = page.locator('"Username"]').first
                if await un.count() > 0: await un.fill(u)
                await asyncio.sleep(random.uniform(3, 6))
                
                # Random mouse
                vp = page.viewport_size or {"width":1440,"height":900}
                await page.mouse.move(random.randint(vp["width"]//3,vp["width"]*2//3), random.randint(vp["height"]//3,vp["height"]*2//3))
                await asyncio.sleep(random.uniform(0.5,1.5))
                
                await _next(page); await asyncio.sleep(5)
                body = (await page.locator("body").inner_text()).lower()
                curl = page.url.lower()
                
                if "/gender" in curl:
                    redirect += 1
                    cd = min(8 + redirect*3, 20)
                    log(f"    ↓ Redirect #{redirect}/8 → {cd}s")
                    await asyncio.sleep(cd)
                    await _fill_(page, yr, mo, dy, g)
                    await _next(page); await asyncio.sleep(random.uniform(4,6))
                    continue
                
                if any(k in body for k in ["taken","already used","exists"]):
                    redirect += 1
                    u = f"{f.lower()}{l.lower()}{random.randint(100,9999)}"
                    email = f"{u}@gmail.com"
                    log(f"    taken → {u}")
                    continue
                
                log(f"    ✓ {u}"); break

            if redirect >= 8:
                log("❌ Too many redirects"); return

            # 
            log("[5] ...")
            await asyncio.sleep(3)
            body5 = (await page.locator("body").inner_text()).lower()
            log(f"    Page: {body5[:100]}")
            log(f"    URL: {page.url[:100]}")
            
            pws = page.locator('""]')
            pwc = await pws.count()
            log(f"    PW fields found: {pwc}")
            
            if pwc >= 2:
                await pws.nth(0).fill(pw); await pws.nth(1).fill(pw)
                log(f"    ✓ 2 fields filled")
            elif pwc == 1:
                await pws.nth(0).fill(pw)
                log(f"    ✓ 1 field filled")
            else:
                log(f"    ⚠ NO  fields — checking page...")
                # Maybe we're already past ?
                if "skip" in body5 or "recovery" in body5 or "terms" in body5:
                    log(f"    → Already at terms/recovery page")
                elif "phone" in body5 or "verify" in body5:
                    log(f"    → Already at phone page!")
            
            await _next(page); await asyncio.sleep(random.uniform(4,6))

            # Terms
            log("[6] Terms & recovery...")
            body = (await page.locator("body").inner_text()).lower()
            log(f"    Terms page: {body[:100]}")
            log(f"    Terms URL: {page.url[:100]}")
            if "terms" in body or "privacy" in body:
                for l in ["I agree","Agree"]:
                    b = page.locator(f'"{l}")').first
                    if await b.count() > 0: await b.click(timeout=3000); break
                await asyncio.sleep(3)
            await asyncio.sleep(2)
            body = (await page.locator("body").inner_text()).lower()
            if "skip" in body or "recovery" in body:
                for l in ["Skip","Not now"]:
                    b = page.locator(f'"{l}")').first
                    if await b.count() > 0: await b.click(timeout=3000); break
                await asyncio.sleep(2)
            await _next(page); await asyncio.sleep(random.uniform(4,6))

            # Phone Verification
            log("[7] Phone verification...")
            await page.screenshot(path=os.path.join(SS, f"v11_{u}.png"))
            body = (await page.locator("body").inner_text()).lower()
            curl = page.url.lower()
            log(f"    URL: {curl[:100]}")

            if "" in curl or "mail.google.com" in curl:
                log("🎉 NO VERIFICATION!"); return _save(email,u,pw)

            # Skip button
            for lbl in ["Skip","Skip for now","Not now","Later","I prefer"]:
                btn = page.locator(f'"{lbl}"),span:has-text("{lbl}"),a:has-text("{lbl}")')
                if await btn.count() > 0:
                    await btn.first.click(timeout=5000)
                    log(f"    ✓ '{lbl}'"); await asyncio.sleep(3)
                    curl2 = page.url.lower()
                    if "" in curl2 or "mail.google.com" in curl2:
                        log("🎉 SUCCESS!"); return _save(email,u,pw)
                    for sl in ["Skip","Not now","Next"]:
                        b = page.locator(f'"{sl}")').first
                        if await b.count() > 0: await b.click(timeout=3000); await asyncio.sleep(3); break
                    curl3 = page.url.lower()
                    if "" in curl3 or "mail.google.com" in curl3:
                        log("🎉 SUCCESS!"); return _save(email,u,pw)
                    break

            # 5sim Indonesia SMS
            if "phone" in body or "verify" in body or "number" in body:
                sim5 = Sim5(FIVESIM_KEY)
                bal = sim5.bal()
                log(f"    5sim: {bal} RUB")
                if bal < 0.2: log("⚠ Low balance"); return
                
                order = sim5.buy(country="indonesia")
                if not order: log("⚠ Buy failed"); return
                phone = order["phone"]
                log(f"    🇮🇩 {phone} (#{order['id']}, {order['price']}RUB)")
                
                pi = page.locator('"tel"],"phoneNumber"]').first
                if await pi.count() > 0: await pi.fill(phone)
                await asyncio.sleep(1)
                await _next(page); await asyncio.sleep(2)
                
                log("    ⏳ SMS...")
                code = sim5.wait(order["id"], timeout=180, iv=3)
                if code:
                    log(f"    ✓ CODE: {code}")
                    ci = page.locator('"hidden"""])').first
                    if await ci.count() > 0:
                        await ci.fill(code); await _next(page); await asyncio.sleep(6)
                        pu = page.url.lower(); pb = (await page.locator("body").inner_text()).lower()
                        if "" in pb or "wrong" in pb:
                            log("✗ Wrong code"); sim5.cancel(order["id"])
                        elif "" in pu or "mail.google.com" in pu or "welcome" in pb:
                            log("🎉 VERIFIED!"); sim5.finish(order["id"])
                            await page.screenshot(path=os.path.join(SS, f"v11_success_{u}.png"))
                            return _save(email,u,pw)
                        else:
                            log(f"? {pu[:80]}"); sim5.cancel(order["id"])
                else:
                    log("✗ No code"); sim5.cancel(order["id"])
            
            return None

        except Exception as e:
            log(f"❌ {e}"); traceback.print_exc()
            if order: 
                try: sim5.cancel(order["id"])
                except: pass
            return None
        finally:
            await browser.close()


def _save(email,u,pw):
    d = {"email":email,"":u,"":pw,"":datetime.now().isoformat(),"status":"active"}
     = []
    if os.path.exists(ACCOUNTS):
        with open(ACCOUNTS,"r",encoding="utf-8") as f:
             = json.load(f)
    .append(d)
    with open(ACCOUNTS,"w",encoding="utf-8") as f:
        json.dump(,f,indent=2,ensure_ascii=False)
    log(f"  💾 {email}")
    return d


if __name__ == "__main__":
    r = asyncio.run(main())
    print(f"\n{'🎉 '+r['email'] if r else '❌ FAILED'}")
