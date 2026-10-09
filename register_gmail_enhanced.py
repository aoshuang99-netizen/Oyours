# -*- coding: utf-8 -*-
"""
_gmail_enhanced.py — BEST OF ALL APPROACHES

1. SG residential proxy via HTTP relay chain
2. Mobile emulation (lower Google security)
3. Persistent Chrome profile for realism
4. Enhanced anti-detection (Canvas, WebGL, extensions)
5. Stack Overflow OAuth entry point
6. Human-like delays and form filling
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
CHROME_PROFILE = os.path.join(ROOT, "gmail-data", "chrome-profile-mobile")
for d in [SS, CHROME_PROFILE]: os.makedirs(d, exist_ok=True)

def log(msg): print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)

FIVESIM_KEY = "eyJhbGciOiJSUzUxMiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE4MTM3MzQ3ODEsImlhdCI6MTc4MjE5ODc4MSwicmF5IjoiNjIxMWY0MjAyNmM2YjZkNDMxMjMxYjY0MDkwMzg3MDYiLCJzdWIiOjQyMjIwNTB9.wRPYREkUdv60wd68XujZqXlravtg01aMWYECx0Bl1fLqC2uxL2yELzAIWIG_b_yAhKrymtxV5XsGlCpBm_uapnwJZhUw7LyHHnYl_V6weL6uEvk2ayrcIhaUCa13RORmRen8fXdrElnO_flZqQpeJRqm7gpUQF-HSy8Az3iy3j0JWvW9pfg_sAZTCA6vlADn66lrZ36O5g3NiKoTtTB0SYo8lfzFxtBbROc6gSMg_46dmn1hjNgJB6cetJ33DLQ1UJCuckcjV_lVfiPIMYT51RIqaRS8zyPaCTT8938whKFHbbJgWpne-6ldHmdeDudWDtytElk7d204shjBL1q1ww"
CAPTCHA_KEY = "4170beecd8d7c70ee4444a0bcc9dd28d"
PROXY_URL = "http://:8090"

FIRST = ["James","John","Robert","Michael","David","William","Richard","Joseph","Thomas","Christopher","Daniel","Matthew","Anthony","Mark","Paul","Steven","Andrew","Kenneth","George","Brian","Kevin","Jason","Jeff","Ryan","Justin"]
LAST = ["Smith","Johnson","Williams","Brown","Jones","Garcia","Miller","Davis","Rodriguez","Martinez","Hernandez","Lopez","Gonzalez","Wilson","Anderson","Thomas","Taylor","Moore","Jackson","Martin","Lee","White","Harris"]

MOBILE_DEVICES = [
    {"viewport":{"width":412,"height":915},"ua":"Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36","name":"Pixel 8 Pro (Chrome)","mobile":True},
    {"viewport":{"width":412,"height":915},"ua":"Mozilla/5.0 (Linux; Android 13; SM-S908B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36","name":"Galaxy S22 (Chrome)","mobile":True},
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


class CaptchaSolver:
    API = "https://api.2captcha.com"
    def __init__(self, key): self.key = key; self.s = _req.Session()
    def balance(self):
        try:
            r = self.s.get(f"https://2captcha.com/res.php?key={self.key}&action=", timeout=10)
            if r.text.replace('.','').isdigit(): return float(r.text)
        except: pass
        return 0
    def solve_recaptcha(self, sitekey, url, timeout=120):
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
                    token = result[""]["token"]
                    log(f"  [2captcha] \u2713 Solved ({int(time.time()-start)}s)")
                    return token
                if result.get("errorId")!=0: return None
            return None
        except Exception as e:
            log(f"  [2captcha] Error: {e}")
            return None
    async def detect_and_solve(self, page, timeout=120):
        try:
            html = await page.locator('html').inner_html()
            m = re.search(r'(?:sitekey|data-sitekey)[\'"]?\s*[=:]\s*[\'"](6[A-Za-z0-9_-]{38,40})[\'"]', html)
            if not m: return None
            sitekey = m.group(1)
            log(f"  [2captcha] Solving: {sitekey[:20]}...")
            token = self.solve_recaptcha(sitekey, page.url, timeout)
            if token:
                await page.evaluate(f"""
                    const el = document.getElementById('');
                    if (el) el.value = {json.dumps(token)};
                    if (window.___grecaptcha_cfg && window.___grecaptcha_cfg.clients) {{
                        for (const [id, c] of Object.entries(window.___grecaptcha_cfg.clients)) {{
                            if (c.callback) {{ c.callback({json.dumps(token)}); break; }}
                        }}
                    }}
                """)
            return token
        except: return None


async def _one(attempt_num):
    f, l = random.choice(FIRST), random.choice(LAST)
    uname = f"{f.lower()}{l.lower()}{random.randint(100,9999)}"
    pw = (random.choice(string.ascii_uppercase) + "".join(random.choices(string.ascii_lowercase, k=6)) + "".join(random.choices(string.digits, k=4)) + "!")
    yr, mo, dy = random.randint(1985, 2000), random.randint(1, 12), random.randint(1, 28)
    g = random.choice(["Male", "Female"])
    email = f"{uname}@gmail.com"
    dev = random.choice(MOBILE_DEVICES)
    month_abbr = ["","jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"]
    month_full = ["","January","February","March","April","May","June","July","August","September","October","November","December"]
    
    log("")
    log("="*60)
    log(f"ATTEMPT #{attempt_num} | {email} | {dev['name']}")
    log(f"  {f} {l} | {month_full[mo]} {dy}, {yr} | {g}")
    log(f"  Proxy: {PROXY_URL} (SG residential + relay chain)")
    log("="*60)
    
    captcha = CaptchaSolver(CAPTCHA_KEY)
    context = None
    
    try:
        async with async_playwright() as pw:
            context = await pw.chromium.launch_persistent_context(
                =CHROME_PROFILE,
                headless=False,
                proxy={"server": PROXY_URL},
                viewport=dev["viewport"],
                user_agent=dev["ua"],
                is_mobile=dev["mobile"],
                has_touch=dev["mobile"],
                locale="en-US",
                timezone_id="America/Los_Angeles",
                geolocation={"latitude": 34.05, "longitude": -118.24},
                permissions=["geolocation"],
                args=[
                    "--no-sandbox",
                    "--disable-blink-features=AutomationControlled",
                    "--disable-features=IsolateOrigins,site-per-process",
                ]
            )
            page = context.pages[0]
            
            # ═══ ENHANCED ANTI-DETECTION ═══
            await page.add_init_script("""
                // 1. Hide webdriver
                Object.defineProperty(navigator, 'webdriver', {get: () => false});
                delete navigator.__proto__.webdriver;
                
                // 2. Chrome runtime
                window.chrome = {
                    runtime: {},
                    loadTimes: () {},
                    csi: () {return {}}, 
                    app: {}
                };
                
                // 3. Plugins (real-looking)
                Object.defineProperty(navigator, 'plugins', {
                    get: () => {
                        const plugins = [
                            {name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format'},
                            {name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: ''},
                            {name: 'Native Client', filename: 'internal-nacl-plugin', description: ''}
                        ];
                        plugins.item = (i) => plugins[i];
                        plugins.namedItem = (n) => plugins.find(p => p.name === n);
                        plugins.refresh = () => {};
                        return Object.setPrototypeOf(plugins, PluginArray.prototype);
                    }
                });
                
                // 4. Languages
                Object.defineProperty(navigator, 'languages', {get: () => ['en-US', 'en']});
                
                // 5. Hardware concurrency
                Object.defineProperty(navigator, 'hardwareConcurrency', {get: () => 8});
                
                // 6. Device memory
                Object.defineProperty(navigator, 'deviceMemory', {get: () => 8});
                
                // 7. Platform
                Object.defineProperty(navigator, '', {get: () => 'Linux armv8l'});
                
                // 8. Vendor
                Object.defineProperty(navigator, 'vendor', {get: () => 'Google Inc.'});
                
                // 9. Permissions
                const origQuery = window.navigator.permissions.query;
                window.navigator.permissions.query = (parameters) => (
                    parameters.name === 'notifications' ?
                    Promise.resolve({state: Notification.permission}) :
                    origQuery(parameters)
                );
                
                // 10. Canvas fingerprint randomization
                const origGetContext = HTMLCanvasElement.prototype.getContext;
                HTMLCanvasElement.prototype.getContext = () {
                    const context = origGetContext.apply(this, arguments);
                    if (arguments[0] === '2d') {
                        const origFillText = context.fillText;
                        context.fillText = () {
                            // Add microscopic noise to text rendering
                            context.save();
                            context.shadowColor = 'rgba(255,255,255,0.001)';
                            context.shadowBlur = 0.3;
                            origFillText.apply(this, arguments);
                            context.restore();
                        };
                        const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
                        HTMLCanvasElement.prototype.toDataURL = () {
                            // Add noise to image data
                            const ctx = this.getContext('2d');
                            if (ctx) {
                                const imageData = ctx.getImageData(0, 0, this.width, this.height);
                                for (let i = 0; i < imageData.data.length; i += 4) {
                                    imageData.data[i] = imageData.data[i] ^ (Math.random() < 0.02 ? 1 : 0);
                                }
                                ctx.putImageData(imageData, 0, 0);
                            }
                            return origToDataURL.apply(this, arguments);
                        };
                    }
                    return context;
                };
                
                // 11. WebGL vendor spoofing
                const origGetParameter = WebGLRenderingContext.prototype.getParameter;
                WebGLRenderingContext.prototype.getParameter = (parameter) {
                    if (parameter === 37445) return 'Qualcomm';
                    if (parameter === 37446) return 'Adreno (TM) 650';
                    return origGetParameter.call(this, parameter);
                };
                
                // 12. Disable  flags
                delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
                delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
                delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
            """)
            
            log("    \u2713 Enhanced anti-detection injected")
            
            # ═══ ENTRY POINT: Stack Overflow OAuth ═══
            log("[1] Stack Overflow warmup...")
            await page.goto("https://stackoverflow.com/", wait_until="domcontentloaded", timeout=30000)
            await asyncio.sleep(random.uniform(2, 4))
            
            # Human-like scroll
            vp = dev["viewport"]
            await page.mouse.wheel(0, vp["height"] // 2)
            await asyncio.sleep(random.uniform(0.5, 1.5))
            
            log("[2] Clicking 'Log in'...")
            for sel in ['a:has-text("Log in")', 'a:has-text("Sign up")', 'a:has-text("Join")']:
                btn = page.locator(sel).first
                if await btn.count() > 0:
                    try:
                        await btn.click(timeout=5000)
                        await asyncio.sleep(3)
                        break
                    except: pass
            
            log("[3] Clicking 'Sign up with Google'...")
            for sel in ['"Google")', 'a:has-text("Google")', '[data-provider="google"]']:
                btn = page.locator(sel).first
                if await btn.count() > 0:
                    try:
                        await btn.click(timeout=5000)
                        await asyncio.sleep(4)
                        break
                    except: pass
            
            await page.screenshot(path=os.path.join(SS, f"enhanced_oauth_{attempt_num}.png"))
            
            # Find Google popup page
            google_page = page
            for p in context.pages:
                if ".google.com" in p.url:
                    google_page = p
                    log(f"    Google popup: {p.url[:80]}")
                    break
            
            if ".google.com" not in google_page.url:
                # Fallback: go directly to signup
                log("[4] Direct signup fallback...")
                await google_page.goto(
                    "https://.google.com/signup/v2/webcreateaccount?hl=en&flowName=GlifWebSignIn&flowEntry=SignUp",
                    timeout=30000, wait_until="domcontentloaded"
                )
                await asyncio.sleep(4)
            else:
                # In Google popup, click "Create account"
                log("[4] Google OAuth — Create account...")
                for cre in ['span:has-text("Create account")', '"Create account")']:
                    btn = google_page.locator(cre).first
                    if await btn.count() > 0:
                        try:
                            await btn.click(timeout=5000)
                            await asyncio.sleep(3)
                            break
                        except: pass
                
                # Then select "For personal use"
                for opts in ['span:has-text("For my personal use")', 'span:has-text("For personal use")', 'li:has-text("personal")']:
                    btn = google_page.locator(opts).first
                    if await btn.count() > 0:
                        try:
                            await btn.click(timeout=5000)
                            await asyncio.sleep(3)
                            break
                        except: pass
            
            await google_page.screenshot(path=os.path.join(SS, f"enhanced_signup_{attempt_num}.png"))
            
            # Check for reCAPTCHA
            captcha_token = await captcha.detect_and_solve(google_page)
            if captcha_token:
                log("    \u2713 CAPTCHA solved")
            
            # ═══ FILL FORM ═══
            log(f"[5] Name: {f} {l}")
            
            # Type name like human
            for sel, val in [('"firstName"]', f), ('"lastName"]', l)]:
                inp = google_page.locator(sel).first
                if await inp.count() > 0:
                    await inp.click(timeout=3000)
                    await asyncio.sleep(0.2)
                    await inp.type(val, delay=random.randint(60, 150))
                    await asyncio.sleep(random.uniform(0.5, 1.0))
            
            await google_page.screenshot(path=os.path.join(SS, f"enhanced_name_{attempt_num}.png"))
            
            # Click Next
            for nxt in ['"Next")', '"Continue")']:
                btn = google_page.locator(nxt).first
                if await btn.count() > 0 and await btn.is_visible():
                    await btn.click(timeout=5000)
                    break
            await asyncio.sleep(5)
            
            await google_page.screenshot(path=os.path.join(SS, f"enhanced_bday_{attempt_num}.png"))
            
            # ═══ BIRTHDAY ═══
            log(f"[6] Birthday: {month_full[mo]} {dy}, {yr} | {g}")
            
            # Wait for  form
            await google_page.wait_for_selector('input, select, [role="button"]', timeout=10000)
            await asyncio.sleep(1)
            
            # Native select attempt
            eval_result = await google_page.evaluate(f"""
                (() => {{
                    const m = document.querySelector('#month, select[name="month"]');
                    const d = document.querySelector('#day, "day"]');
                    const y = document.querySelector('#year, "year"]');
                    const gd = document.querySelector('#gender, select[name="gender"]');
                    
                    let result = [];
                    if (m) {{
                        m.selectedIndex = {mo-1};
                        m.dispatchEvent(new Event('change', {{bubbles: true}}));
                        result.push('month');
                    }}
                    if (d) {{
                        d.value = '{dy}';
                        d.dispatchEvent(new Event('input', {{bubbles: true}}));
                        d.dispatchEvent(new Event('change', {{bubbles: true}}));
                        result.push('day');
                    }}
                    if (y) {{
                        y.value = '{yr}';
                        y.dispatchEvent(new Event('input', {{bubbles: true}}));
                        y.dispatchEvent(new Event('change', {{bubbles: true}}));
                        result.push('year');
                    }}
                    if (gd) {{
                        gd.selectedIndex = {'1' if g=='Male' else '2'};
                        gd.dispatchEvent(new Event('change', {{bubbles: true}}));
                        result.push('gender');
                    }}
                    return result.join(',');
                }})()
            """)
            log(f"    Native set: {eval_result}")
            await asyncio.sleep(0.5)
            
            # Material dropdown click-based fallback
            for target, sel, txt in [
                ("Month", 'span:has-text("Month")', month_abbr[mo]),
                ("Gender", 'span:has-text("Gender")', "m" if g=="Male" else "f"),
            ]:
                el = google_page.locator(sel).first
                if await el.count() > 0:
                    try:
                        await el.click(force=True, timeout=3000)
                        await asyncio.sleep(0.5)
                        await google_page.keyboard.type(txt, delay=80)
                        await asyncio.sleep(0.3)
                        await google_page.keyboard.press("Enter")
                        await asyncio.sleep(0.3)
                        log(f"    {target} clicked: {txt}")
                    except Exception as e:
                        log(f"    {target} click fail: {e}")
            
            await google_page.keyboard.press("Escape")
            await asyncio.sleep(0.3)
            await google_page.keyboard.press("Escape")
            
            await google_page.screenshot(path=os.path.join(SS, f"enhanced_bday_filled_{attempt_num}.png"))
            log(f"    \u2713 Birthday filled")
            
            # Human delay before Next
            delay = random.uniform(2.0, 4.0)
            log(f"    Delay {delay:.1f}s...")
            await asyncio.sleep(delay)
            
            # Click Next
            for nxt in ['"Next")']:
                btn = google_page.locator(nxt).first
                if await btn.count() > 0 and await btn.is_visible():
                    await btn.click(force=True, timeout=5000)
                    await asyncio.sleep(6)
                    break
            
            await google_page.screenshot(path=os.path.join(SS, f"enhanced_after_bday_{attempt_num}.png"))
            
            curl = google_page.url.lower()
            log(f"    URL: {curl[:80]}")
            
            # Check for redirect (anti-bot detection)
            if "gender" in curl or "signup/" in curl:
                log("    \u26a0 Redirected — trying alternate fill...")
                
                # Second attempt: try different approach with Material Design inputs
                await google_page.evaluate(f"""
                    setTimeout(() => {{
                        const inputs = 'input');
                        for (const inp of inputs) {{
                            const label = (inp.getAttribute('aria-label') || inp.placeholder || '').toLowerCase();
                            if (label.includes('month')) {{
                                inp.value = '{month_abbr[mo]}';
                                inp.dispatchEvent(new Event('input', {{bubbles: true}}));
                                inp.dispatchEvent(new Event('change', {{bubbles: true}}));
                            }}
                            if (label.includes('day')) {{
                                inp.value = '{dy}';
                                inp.dispatchEvent(new Event('input', {{bubbles: true}}));
                            }}
                            if (label.includes('year')) {{
                                inp.value = '{yr}';
                                inp.dispatchEvent(new Event('input', {{bubbles: true}}));
                            }}
                            if (label.includes('gender')) {{
                                inp.value = '{"Male" if g=="Male" else "Female"}';
                                inp.dispatchEvent(new Event('input', {{bubbles: true}}));
                                inp.dispatchEvent(new Event('change', {{bubbles: true}}));
                            }}
                        }}
                    }}, 1000);
                """)
                await asyncio.sleep(3)
                
                # Click Next again
                for nxt in ['"Next")']:
                    btn = google_page.locator(nxt).first
                    if await btn.count() > 0 and await btn.is_visible():
                        await btn.click(force=True, timeout=5000)
                        await asyncio.sleep(6)
                        break
                
                curl = google_page.url.lower()
            
            if "gender" in curl:
                log("    \u2717 Still on  — Google anti-bot")
                await google_page.screenshot(path=os.path.join(SS, f"enhanced_fail_{attempt_num}.png"))
                return None
            
            # ═══ USERNAME ═══
            log(f"[7] Username: {uname}")
            
            for cl in ['span:has-text("Create your own")', 'span:has-text("Create your own Gmail address")']:
                el = google_page.locator(cl).first
                if await el.count() > 0:
                    try:
                        await el.click(timeout=3000)
                        await asyncio.sleep(2)
                        break
                    except: pass
            
            un_in = google_page.locator('"Username"]').first
            if await un_in.count() > 0:
                await un_in.click(timeout=3000)
                await asyncio.sleep(0.5)
                await un_in.type(uname, delay=random.randint(50, 100))
                await asyncio.sleep(1)
            else:
                log("    No Username input found!")
            
            for nxt in ['"Next")']:
                btn = google_page.locator(nxt).first
                if await btn.count() > 0:
                    await btn.click(force=True, timeout=5000)
                    await asyncio.sleep(6)
                    break
            
            curl = google_page.url.lower()
            if "gender" in curl:
                log("    \u2717 Anti-bot redirect after ")
                return None
            
            log("    \u2713 Username accepted!")
            
            # ═══ PASSWORD ═══
            log(f"[8] ...")
            pws = google_page.locator('""]')
            pc = await pws.count()
            if pc >= 2:
                await pws.nth(0).fill(pw)
                await asyncio.sleep(0.5)
                await pws.nth(1).fill(pw)
            elif pc == 1:
                await pws.nth(0).fill(pw)
            else:
                log("    No  fields!")
            
            for nxt in ['"Next")']:
                btn = google_page.locator(nxt).first
                if await btn.count() > 0:
                    await btn.click(force=True, timeout=5000)
                    await asyncio.sleep(5)
                    break
            
            # ═══ TERMS & RECOVERY ═══
            log("[9] Terms & recovery...")
            body = (await google_page.locator("body").inner_text()).lower()
            
            if "terms" in body or "privacy" in body:
                for l in ["I agree", "Agree"]:
                    b = google_page.locator(f'"{l}")').first
                    if await b.count() > 0:
                        await b.click(timeout=3000)
                        break
                await asyncio.sleep(3)
            
            if "skip" in body or "recovery" in body:
                for l in ["Skip", "Not now"]:
                    b = google_page.locator(f'"{l}")').first
                    if await b.count() > 0:
                        await b.click(timeout=3000)
                        break
                await asyncio.sleep(2)
            
            for nxt in ['"Next")']:
                btn = google_page.locator(nxt).first
                if await btn.count() > 0:
                    await btn.click(force=True, timeout=5000)
                    await asyncio.sleep(5)
                    break
            
            # ═══ PHONE VERIFICATION ═══
            await google_page.screenshot(path=os.path.join(SS, f"enhanced_phone_{attempt_num}.png"))
            
            curl = google_page.url.lower()
            body = (await google_page.locator("body").inner_text()).lower()
            log(f"    URL: {curl[:100]}")
            log(f"    Body: {body[:200]}")
            
            if any(kw in curl or kw in body for kw in ["", "mail.google", "welcome"]):
                log("\U0001F389 ACCOUNT CREATED!")
                return save_account(email, uname, pw)
            
            # Skip phone if possible
            for lbl in ["Skip", "Skip for now", "Not now", "Later", "I prefer"]:
                btn = google_page.locator(f'"{lbl}"),span:has-text("{lbl}")').first
                if await btn.count() > 0 and await btn.is_visible():
                    await btn.click(timeout=5000)
                    await asyncio.sleep(3)
                    break
            
            # Re-check
            curl = google_page.url.lower()
            if any(kw in curl for kw in ["", "mail.google"]):
                log("\U0001F389 ACCOUNT CREATED!")
                return save_account(email, uname, pw)
            
            # 5sim phone verification
            if any(kw in body for kw in ["verify", "phone", "number", "confirm"]):
                sim5 = Sim5(FIVESIM_KEY)
                bal = sim5.bal()
                log(f"    5sim balance: {bal} RUB")
                
                if bal < 0.5:
                    log("    \u26a0 Low 5sim balance")
                    return None
                
                order = sim5.buy(country="indonesia")
                if not order:
                    return None
                
                log(f"    \U0001F1EE\U0001F1E9 {order['phone']} ({order['price']} RUB)")
                
                pi = google_page.locator('"tel"],"phoneNumber"]').first
                if await pi.count() > 0:
                    await pi.fill(order["phone"])
                    await asyncio.sleep(1)
                
                for nxt in ['"Next")', '"Send")']:
                    btn = google_page.locator(nxt).first
                    if await btn.count() > 0:
                        await btn.click(force=True, timeout=5000)
                        break
                await asyncio.sleep(3)
                
                log("    Waiting for SMS...")
                code = sim5.wait(order["id"], timeout=180)
                
                if code:
                    log(f"    CODE: {code}")
                    ci = google_page.locator('"hidden"""])').first
                    if await ci.count() > 0:
                        await ci.fill(code)
                    
                    for nxt in ['"Next")', '"Verify")']:
                        btn = google_page.locator(nxt).first
                        if await btn.count() > 0:
                            await btn.click(force=True, timeout=5000)
                            break
                    await asyncio.sleep(6)
                    
                    curl = google_page.url.lower()
                    body = (await google_page.locator("body").inner_text()).lower()
                    
                    if "" in body or "wrong" in body:
                        log("    \u2717 Wrong code")
                        sim5.cancel(order["id"])
                    elif any(kw in curl or kw in body for kw in ["", "welcome", "mail.google"]):
                        log("\U0001F389 VERIFIED!")
                        sim5.finish(order["id"])
                        return save_account(email, uname, pw)
                    else:
                        sim5.cancel(order["id"])
                else:
                    sim5.cancel(order["id"])
            
            # Final check
            curl = google_page.url.lower()
            body = (await google_page.locator("body").inner_text()).lower()
            if any(kw in curl or kw in body for kw in ["", "welcome", "mail.google", "gmail"]):
                log("\U0001F389 ACCOUNT CREATED!")
                return save_account(email, uname, pw)
            
            log("    \u26a0 End of flow")
            return None
            
    except Exception as e:
        log(f"\u274c Error: {e}")
        traceback.print_exc()
        return None
    finally:
        if context:
            try: await context.close()
            except: pass


def save_account(email, uname, pw):
    d = {"email": email, "": uname, "": pw, "": datetime.now().isoformat(), "status": "active"}
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
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    
    log(f"\n{'='*60}")
    log(f"GMAIL ENHANCED — Mobile + OAuth + Canvas Randomization")
    log(f"Target: {count} account(s)")
    log(f"Proxy: {PROXY_URL}")
    log(f"5sim: {Sim5(FIVESIM_KEY).bal()} RUB")
    log(f"2captcha: ${CaptchaSolver(CAPTCHA_KEY).balance()}")
    log(f"{'='*60}")
    
    results = []
    for attempt in range(1, count + 1):
        r = await _one(attempt)
        if r:
            results.append(r)
            log(f"\U0001f389 SUCCESS: {r['email']}")
        else:
            log(f"\u274c FAILED")
        log(f"Results: {len(results)}/{attempt}")
        if attempt < count:
            await asyncio.sleep(random.randint(5, 15))
    
    log(f"\n{'='*60}")
    log(f"DONE: {len(results)}/{count}")
    for r in results:
        log(f"  {r['email']} | {r['']}")
    log(f"{'='*60}")


if __name__ == "__main__":
    asyncio.run(main())
