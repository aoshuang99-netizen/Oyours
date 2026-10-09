# -*- coding: utf-8 -*-
"""
_gmail_firefox.py — FIREFOX + ANTI-DETECTION
Google's anti- focuses on Chromium. Firefox has different detection patterns.
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
for d in [SS]: os.makedirs(d, exist_ok=True)

def log(msg): print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)

FIVESIM_KEY = "eyJhbGciOiJSUzUxMiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE4MTM3MzQ3ODEsImlhdCI6MTc4MjE5ODc4MSwicmF5IjoiNjIxMWY0MjAyNmM2YjZkNDMxMjMxYjY0MDkwMzg3MDYiLCJzdWIiOjQyMjIwNTB9.wRPYREkUdv60wd68XujZqXlravtg01aMWYECx0Bl1fLqC2uxL2yELzAIWIG_b_yAhKrymtxV5XsGlCpBm_uapnwJZhUw7LyHHnYl_V6weL6uEvk2ayrcIhaUCa13RORmRen8fXdrElnO_flZqQpeJRqm7gpUQF-HSy8Az3iy3j0JWvW9pfg_sAZTCA6vlADn66lrZ36O5g3NiKoTtTB0SYo8lfzFxtBbROc6gSMg_46dmn1hjNgJB6cetJ33DLQ1UJCuckcjV_lVfiPIMYT51RIqaRS8zyPaCTT8938whKFHbbJgWpne-6ldHmdeDudWDtytElk7d204shjBL1q1ww"
CAPTCHA_KEY = "4170beecd8d7c70ee4444a0bcc9dd28d"
PROXY_URL = "http://:8090"

FIRST = ["James","John","Robert","David","William","Richard","Joseph","Thomas","Christopher","Daniel","Matthew","Anthony","Mark","Paul","Steven","Andrew","Kenneth","George","Brian","Kevin","Jason"]
LAST = ["Smith","Johnson","Williams","Brown","Jones","Garcia","Miller","Davis","Rodriguez","Martinez","Hernandez","Lopez","Gonzalez","Wilson","Anderson","Thomas","Taylor","Moore","Jackson","Martin"]

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


class CaptchaSolver:
    API = "https://api.2captcha.com"
    def __init__(self, key): self.key = key; self.s = _req.Session()
    def solve_recaptcha(self, sitekey, url, timeout=90):
        try:
            r = self.s.post(f"{self.API}/createTask", json={"clientKey":self.key,"task":{"type":"RecaptchaV2TaskProxyless","websiteURL":url,"websiteKey":sitekey}}, timeout=15)
            data = r.json()
            if data.get("errorId")!=0: return None
            task_id = data["taskId"]
            start = time.time()
            while time.time()-start < timeout:
                time.sleep(5)
                r = self.s.post(f"{self.API}/getTaskResult", json={"clientKey":self.key,"taskId":task_id}, timeout=15)
                result = r.json()
                if result.get("status")=="ready":
                    log(f"  [2captcha] Solved ({int(time.time()-start)}s)")
                    return result[""]["token"]
                if result.get("errorId")!=0: return None
            return None
        except Exception as e:
            log(f"  [2captcha] Error: {e}")
            return None


async def _one(attempt_num):
    f, l = random.choice(FIRST), random.choice(LAST)
    uname = f"{f.lower()}{l.lower()}{random.randint(100,9999)}"
    pw = (random.choice(string.ascii_uppercase) + "".join(random.choices(string.ascii_lowercase, k=6)) + "".join(random.choices(string.digits, k=4)) + "!")
    yr, mo, dy = random.randint(1985, 2000), random.randint(1, 12), random.randint(1, 28)
    g = random.choice(["Male", "Female"])
    email = f"{uname}@gmail.com"
    month_abbr = ["","jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"]
    month_full = ["","January","February","March","April","May","June","July","August","September","October","November","December"]
    
    log("")
    log("="*60)
    log(f"FIREFOX ATTEMPT #{attempt_num} | {email}")
    log(f"  {f} {l} | {month_full[mo]} {dy}, {yr} | {g}")
    log("="*60)
    
    captcha = CaptchaSolver(CAPTCHA_KEY)
    browser = None
    
    try:
        async with async_playwright() as pw:
            browser = await pw.firefox.launch(
                headless=False,
                proxy={"server": PROXY_URL},
                firefox_user_prefs={
                    "dom.webdriver.enabled": False,
                    "dom.webnotifications.enabled": False,
                    "media.navigator.enabled": False,
                    "media.peerconnection.enabled": False,
                    "privacy.trackingprotection.enabled": False,
                    "browser.safebrowsing.enabled": False,
                }
            )
            
            context = await browser.new_context(
                viewport={"width": 1366, "height": 768},
                locale="en-US",
                timezone_id="America/Los_Angeles",
                geolocation={"latitude": 34.05, "longitude": -118.24},
                permissions=["geolocation"],
            )
            page = await context.new_page()
            
            # Firefox-specific anti-detection
            await page.add_init_script("""
                // Override webdriver for Firefox
                Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
                
                // Fake plugins
                Object.defineProperty(navigator, 'plugins', {
                    get: () => {
                        let plugins = [
                            {name: 'Widevine Content Decryption Module', filename: 'widevinecdm.dll', description: 'Widevine Content Decryption Module'},
                            {name: 'OpenH264 Video Codec', filename: 'openh264.dll', description: 'OpenH264 Video Codec provided by Cisco Systems, Inc.'},
                        ];
                        plugins.item = (i) => plugins[i];
                        plugins.namedItem = (n) => plugins.find(p => p.name === n);
                        plugins.refresh = () => {};
                        plugins.length = plugins.length;
                        return Object.setPrototypeOf(plugins, PluginArray.prototype);
                    }
                });
                
                // Languages
                Object.defineProperty(navigator, 'languages', {get: () => ['en-US', 'en']});
                Object.defineProperty(navigator, 'language', {get: () => 'en-US'});
                
                // Hardware
                Object.defineProperty(navigator, 'hardwareConcurrency', {get: () => 8});
                Object.defineProperty(navigator, 'deviceMemory', {get: () => 8});
                
                // Remove 
                delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
                delete window.cdc_adoQpoasnfa76pfcZLmcfl_JSON;
                delete window.cdc_adoQpoasnfa76pfcZLmcfl_Object;
                delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
                delete window.cdc_adoQpoasnfa76pfcZLmcfl_Proxy;
                delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
            """)
            
            log("[1] Opening Gmail signup...")
            await page.goto(
                "https://.google.com/signup/v2/webcreateaccount?hl=en&flowName=GlifWebSignIn&flowEntry=SignUp",
                timeout=30000, wait_until="domcontentloaded"
            )
            await asyncio.sleep(4)
            
            # Check for captcha
            html = await page.locator('html').inner_html()
            m = re.search(r'(?:sitekey|data-sitekey)[\'"]?\s*[=:]\s*[\'"](6[A-Za-z0-9_-]{38,40})[\'"]', html)
            if m:
                log("[C] Solving reCAPTCHA...")
                token = captcha.solve_recaptcha(m.group(1), page.url)
                if token:
                    await page.evaluate(f"""
                        document.getElementById('').value = '{token}';
                    """)
            
            await page.screenshot(path=os.path.join(SS, f"ff_step1_{attempt_num}.png"))
            
            # ═══ NAME ═══
            log(f"[2] Name: {f} {l}")
            for sel, val in [('"firstName"]', f), ('"lastName"]', l)]:
                inp = page.locator(sel).first
                if await inp.count() > 0:
                    await inp.click(timeout=3000)
                    await asyncio.sleep(0.2)
                    await inp.type(val, delay=random.randint(60, 150))
                    await asyncio.sleep(random.uniform(0.3, 0.6))
            
            await page.screenshot(path=os.path.join(SS, f"ff_name_{attempt_num}.png"))
            
            for nxt in ['"Next")', '"Continue")']:
                btn = page.locator(nxt).first
                if await btn.count() > 0:
                    await btn.click(timeout=5000)
                    break
            await asyncio.sleep(5)
            
            # ═══ BIRTHDAY ═══
            log(f"[3] Birthday: {month_full[mo]} {dy}, {yr} | {g}")
            
            await page.wait_for_selector('input, select, [role="button"]', timeout=10000)
            await asyncio.sleep(1)
            
            # Native select
            result = await page.evaluate(f"""
                (() => {{
                    const m = document.querySelector('#month, select[name="month"]');
                    const d = document.querySelector('#day, "day"]');
                    const y = document.querySelector('#year, "year"]');
                    const gd = document.querySelector('#gender, select[name="gender"]');
                    let r = [];
                    if (m) {{ m.selectedIndex = {mo-1}; m.dispatchEvent(new Event('change', {{bubbles:true}})); r.push('M'); }}
                    if (d) {{ d.value = '{dy}'; d.dispatchEvent(new Event('input', {{bubbles:true}})); d.dispatchEvent(new Event('change', {{bubbles:true}})); r.push('D'); }}
                    if (y) {{ y.value = '{yr}'; y.dispatchEvent(new Event('input', {{bubbles:true}})); y.dispatchEvent(new Event('change', {{bubbles:true}})); r.push('Y'); }}
                    if (gd) {{ gd.selectedIndex = {'1' if g=='Male' else '2'}; gd.dispatchEvent(new Event('change', {{bubbles:true}})); r.push('G'); }}
                    return r.join();
                }})()
            """)
            log(f"    Native: {result}")
            await asyncio.sleep(0.5)
            
            # Material click fallback
            for target, sel, txt in [
                ("Month", 'span:has-text("Month")', month_abbr[mo]),
                ("Gender", 'span:has-text("Gender")', "m" if g=="Male" else "f"),
            ]:
                el = page.locator(sel).first
                if await el.count() > 0:
                    try:
                        await el.click(force=True, timeout=3000)
                        await asyncio.sleep(0.5)
                        await page.keyboard.type(txt, delay=80)
                        await asyncio.sleep(0.3)
                        await page.keyboard.press("Enter")
                        await asyncio.sleep(0.2)
                    except: pass
            
            await page.keyboard.press("Escape")
            await asyncio.sleep(0.3)
            await page.keyboard.press("Escape")
            
            await page.screenshot(path=os.path.join(SS, f"ff_bday_{attempt_num}.png"))
            log(f"    Birthday filled")
            
            # Human delay
            delay = random.uniform(2.0, 4.0)
            log(f"    Delay {delay:.1f}s...")
            await asyncio.sleep(delay)
            
            for nxt in ['"Next")']:
                btn = page.locator(nxt).first
                if await btn.count() > 0:
                    await btn.click(force=True, timeout=5000)
                    break
            await asyncio.sleep(6)
            
            curl = page.url.lower()
            log(f"    URL: {curl[:80]}")
            await page.screenshot(path=os.path.join(SS, f"ff_after_bday_{attempt_num}.png"))
            
            if "gender" in curl:
                log("    Redetected — retrying with aria-label...")
                await page.evaluate(f"""
                    setTimeout(() => {{
                        'input').forEach(inp => {{
                            const lbl = (inp.getAttribute('aria-label') || '').toLowerCase();
                            if (lbl.includes('month')) {{ inp.value = '{month_abbr[mo]}'; inp.dispatchEvent(new Event('input', {{bubbles:true}})); inp.dispatchEvent(new Event('change', {{bubbles:true}})); }}
                            if (lbl.includes('day')) {{ inp.value = '{dy}'; inp.dispatchEvent(new Event('input', {{bubbles:true}})); }}
                            if (lbl.includes('year')) {{ inp.value = '{yr}'; inp.dispatchEvent(new Event('input', {{bubbles:true}})); }}
                            if (lbl.includes('gender')) {{ inp.value = '{"Male" if g=="Male" else "Female"}'; inp.dispatchEvent(new Event('input', {{bubbles:true}})); }}
                        }});
                    }}, 1000);
                """)
                await asyncio.sleep(3)
                for nxt in ['"Next")']:
                    btn = page.locator(nxt).first
                    if await btn.count() > 0: await btn.click(force=True, timeout=5000); break
                await asyncio.sleep(6)
                curl = page.url.lower()
            
            if "gender" in curl:
                log("    FAILED - Google anti-bot")
                return None
            
            # ═══ USERNAME ═══
            log(f"[4] Username: {uname}")
            for cl in ['span:has-text("Create your own")', 'span:has-text("Create your own Gmail address")']:
                el = page.locator(cl).first
                if await el.count() > 0:
                    try: await el.click(timeout=3000); await asyncio.sleep(2); break
                    except: pass
            
            un_in = page.locator('"Username"]').first
            if await un_in.count() > 0:
                await un_in.click(timeout=3000)
                await asyncio.sleep(0.5)
                await un_in.type(uname, delay=random.randint(50, 100))
                await asyncio.sleep(1)
            
            for nxt in ['"Next")']:
                btn = page.locator(nxt).first
                if await btn.count() > 0: await btn.click(force=True, timeout=5000); break
            await asyncio.sleep(6)
            
            if "gender" in page.url.lower():
                log("    Anti-bot redirect after ")
                return None
            
            log("    Username accepted!")
            
            # ═══ PASSWORD ═══
            log(f"[5] ...")
            pws = page.locator('""]')
            pc = await pws.count()
            if pc >= 2:
                await pws.nth(0).fill(pw); await asyncio.sleep(0.3)
                await pws.nth(1).fill(pw)
            elif pc == 1:
                await pws.nth(0).fill(pw)
            
            for nxt in ['"Next")']:
                btn = page.locator(nxt).first
                if await btn.count() > 0: await btn.click(force=True, timeout=5000); break
            await asyncio.sleep(5)
            
            # ═══ TERMS ═══
            log("[6] Terms & recovery...")
            body = (await page.locator("body").inner_text()).lower()
            
            if "terms" in body or "privacy" in body:
                for l in ["I agree", "Agree"]:
                    b = page.locator(f'"{l}")').first
                    if await b.count() > 0: await b.click(timeout=3000); break
                await asyncio.sleep(3)
            
            if "skip" in body or "recovery" in body:
                for l in ["Skip", "Not now"]:
                    b = page.locator(f'"{l}")').first
                    if await b.count() > 0: await b.click(timeout=3000); break
                await asyncio.sleep(2)
            
            for nxt in ['"Next")']:
                btn = page.locator(nxt).first
                if await btn.count() > 0: await btn.click(force=True, timeout=5000); break
            await asyncio.sleep(5)
            
            # ═══ PHONE ═══
            await page.screenshot(path=os.path.join(SS, f"ff_phone_{attempt_num}.png"))
            curl = page.url.lower()
            body = (await page.locator("body").inner_text()).lower()
            log(f"    URL: {curl[:100]}")
            
            if any(kw in curl for kw in ["", "mail.google", "welcome"]):
                log("ACCOUNT CREATED!")
                return save_account(email, uname, pw)
            
            for lbl in ["Skip", "Skip for now", "Not now", "Later", "I prefer"]:
                btn = page.locator(f'"{lbl}"),span:has-text("{lbl}")').first
                if await btn.count() > 0:
                    await btn.click(timeout=5000); await asyncio.sleep(3)
                    break
            
            if any(kw in page.url.lower() for kw in ["", "mail.google"]):
                log("ACCOUNT CREATED!")
                return save_account(email, uname, pw)
            
            if any(kw in body for kw in ["verify", "phone", "number", "confirm"]):
                sim5 = Sim5(FIVESIM_KEY)
                if sim5.bal() < 0.5:
                    log("Low 5sim balance")
                    return None
                
                order = sim5.buy(country="indonesia")
                if not order: return None
                
                log(f"    +{order['phone']} ({order['price']} RUB)")
                
                pi = page.locator('"tel"],"phoneNumber"]').first
                if await pi.count() > 0: await pi.fill(order["phone"]); await asyncio.sleep(1)
                
                for nxt in ['"Next")', '"Send")']:
                    btn = page.locator(nxt).first
                    if await btn.count() > 0: await btn.click(force=True, timeout=5000); break
                await asyncio.sleep(3)
                
                log("    Waiting SMS...")
                code = sim5.wait(order["id"], timeout=180)
                
                if code:
                    log(f"    CODE: {code}")
                    ci = page.locator('"hidden"""])').first
                    if await ci.count() > 0: await ci.fill(code)
                    
                    for nxt in ['"Next")', '"Verify")']:
                        btn = page.locator(nxt).first
                        if await btn.count() > 0: await btn.click(force=True, timeout=5000); break
                    await asyncio.sleep(6)
                    
                    body = (await page.locator("body").inner_text()).lower()
                    if "" in body or "wrong" in body:
                        sim5.cancel(order["id"])
                    elif any(kw in page.url.lower() or kw in body for kw in ["", "welcome", "mail.google"]):
                        log("VERIFIED!")
                        sim5.finish(order["id"])
                        return save_account(email, uname, pw)
                    else:
                        sim5.cancel(order["id"])
                else:
                    sim5.cancel(order["id"])
            
            if any(kw in page.url.lower() for kw in ["", "mail.google", "welcome", "gmail"]):
                return save_account(email, uname, pw)
            
            log("End of flow")
            return None
            
    except Exception as e:
        log(f"Error: {e}")
        traceback.print_exc()
        return None
    finally:
        if browser:
            try: await browser.close()
            except: pass


def save_account(email, uname, pw):
    d = {"email": email, "": uname, "": pw, "": datetime.now().isoformat()}
     = []
    if os.path.exists(ACCOUNTS):
        try:
            with open(ACCOUNTS, "r", encoding="utf-8") as f:  = json.load(f)
        except:  = []
    .append(d)
    with open(ACCOUNTS, "w", encoding="utf-8") as f: json.dump(, f, indent=2)
    log(f"  Saved: {email}")
    return d


async def main():
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    log(f"\n{'='*50}")
    log(f"FIREFOX GMAIL REGISTRATOR")
    log(f"5sim: {Sim5(FIVESIM_KEY).bal()} RUB")
    log(f"{'='*50}")
    
    results = []
    for attempt in range(1, count+1):
        r = await _one(attempt)
        if r: results.append(r); log(f"SUCCESS: {r['email']}")
        else: log(f"FAILED")
        log(f"Progress: {len(results)}/{attempt}")
    
    log(f"\nDONE: {len(results)}/{count}")
    for r in results: log(f"  {r['email']} | {r['']}")

if __name__ == "__main__":
    asyncio.run(main())
