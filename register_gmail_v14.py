# -*- coding: utf-8 -*-
"""
_gmail_v14.py — 2CAPTCHA + SESSION WARMING + STEALTH

Integrated improvements:
1. 2captcha reCAPTCHA v2 auto-solving (RecaptchaV2TaskProxyless)
2. Session warming: visit YouTube first to build trusted browser fingerprint
3. Anti-bot detection with multiple retry strategies
4. Material Design dropdown handling with JavaScript injection

Usage: python _gmail_v14.py [count]
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

# ─── API Keys ───
FIVESIM_KEY = "eyJhbGciOiJSUzUxMiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE4MTM3MzQ3ODEsImlhdCI6MTc4MjE5ODc4MSwicmF5IjoiNjIxMWY0MjAyNmM2YjZkNDMxMjMxYjY0MDkwMzg3MDYiLCJzdWIiOjQyMjIwNTB9.wRPYREkUdv60wd68XujZqXlravtg01aMWYECx0Bl1fLqC2uxL2yELzAIWIG_b_yAhKrymtxV5XsGlCpBm_uapnwJZhUw7LyHHnYl_V6weL6uEvk2ayrcIhaUCa13RORmRen8fXdrElnO_flZqQpeJRqm7gpUQF-HSy8Az3iy3j0JWvW9pfg_sAZTCA6vlADn66lrZ36O5g3NiKoTtTB0SYo8lfzFxtBbROc6gSMg_46dmn1hjNgJB6cetJ33DLQ1UJCuckcjV_lVfiPIMYT51RIqaRS8zyPaCTT8938whKFHbbJgWpne-6ldHmdeDudWDtytElk7d204shjBL1q1ww"
CAPTCHA_KEY = "4170beecd8d7c70ee4444a0bcc9dd28d"

PROXY_URL = "http://:8090"  # HTTP Proxy Relay -> US V2Ray -> LokiProxy Residential (AT&T/Spectrum)

# ─── Names ───
FIRST = ["James","John","Robert","Michael","David","William","Richard","Joseph","Thomas","Christopher","Daniel","Matthew","Anthony","Mark","Paul","Steven","Andrew","Kenneth","George","Brian","Kevin","Jason","Jeff","Scott","Eric","Ryan","Justin","Brandon"]
LAST = ["Smith","Johnson","Williams","Brown","Jones","Garcia","Miller","Davis","Rodriguez","Martinez","Hernandez","Lopez","Gonzalez","Wilson","Anderson","Thomas","Taylor","Moore","Jackson","Martin","Lee","White","Harris","Clark","Lewis","Walker","Hall","Allen"]

import requests as _req

# ─── 5sim ───
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


# ─── 2captcha ───
class CaptchaSolver:
    API = "https://api.2captcha.com"
    
    def __init__(self, key):
        self.key = key
        self.s = _req.Session()
    
    def balance(self):
        try:
            r = self.s.get(f"https://2captcha.com/res.php?key={self.key}&action=", timeout=10)
            if r.text.isdigit() or "." in r.text:
                return float(r.text)
            return 0
        except: return 0
    
    def solve_recaptcha_v2_proxyless(self, sitekey, url, invisible=False, timeout=120):
        """Use 2captcha's own proxy pool to solve reCAPTCHA v2"""
        try:
            # Step 1: Create task
            task_data = {
                "clientKey": self.key,
                "task": {
                    "type": "RecaptchaV2TaskProxyless",
                    "websiteURL": url,
                    "websiteKey": sitekey,
                    "isInvisible": invisible
                }
            }
            log(f"  [2captcha] Creating reCAPTCHA task: sitekey={sitekey[:20]}...")
            r = self.s.post(f"{self.API}/createTask", json=task_data, timeout=15)
            data = r.json()
            
            if data.get("errorId") != 0:
                log(f"  [2captcha] \u2717 Error: {data.get('errorDescription', 'Unknown')}")
                return None
            
            task_id = data["taskId"]
            log(f"  [2captcha] Task created: {task_id}")
            
            # Step 2: Poll for result
            start = time.time()
            while time.time() - start < timeout:
                time.sleep(5)
                r = self.s.post(f"{self.API}/getTaskResult", json={"clientKey": self.key, "taskId": task_id}, timeout=15)
                result = r.json()
                
                if result.get("status") == "ready":
                    token = result[""]["token"]
                    log(f"  [2captcha] \u2713 Solved ({int(time.time()-start)}s, {result.get('cost','?')}$)")
                    return token
                
                if result.get("errorId") != 0:
                    log(f"  [2captcha] Error: {result.get('errorDescription', '?')}")
                    return None
            
            log(f"  [2captcha] Timeout after {timeout}s")
            return None
            
        except Exception as e:
            log(f"  [2captcha] Exception: {e}")
            return None
    
    async def detect_and_solve(self, page, timeout=120):
        """Detect reCAPTCHA on page and solve it"""
        try:
            # Check if reCAPTCHA is present
            has_recaptcha = False
            
            # Method 1: Check for g-recaptcha element
            rc = page.locator('.g-recaptcha, [data-sitekey], iframe[src*="recaptcha"]')
            if await rc.count() > 0:
                has_recaptcha = True
            
            # Method 2: Check for recaptcha  frame
            rc2 = page.locator('iframe[src*="recaptcha"], div[class*="captcha"], div[id*="captcha"]')
            if await rc2.count() > 0:
                has_recaptcha = True
            
            if not has_
                log("  [2captcha] No reCAPTCHA detected on page")
                return None
            
            # Extract sitekey
            sitekey = None
            for sel in ['.g-recaptcha', '[data-sitekey]']:
                el = page.locator(sel)
                if await el.count() > 0:
                    sitekey = await el.first.get_attribute('data-sitekey')
                    if sitekey: break
            
            # If sitekey not found in DOM, try Google's common keys
            if not sitekey:
                # Google's standard reCAPTCHA sitekeys for account creation
                sitekey = "6LfD3PIbAAAAAJs_eEHvoOl75_83eXSqpPSRFJ_u"
                # Also try: detect from page source
                html = await page.locator('html').inner_html()
                m = re.search(r'(?:sitekey|data-sitekey)[\'"]?\s*[=:]\s*[\'"](6[A-Za-z0-9_-]{38,40})[\'"]', html)
                if m:
                    sitekey = m.group(1)
                    log(f"  [2captcha] Found sitekey: {sitekey[:20]}...")
                else:
                    log(f"  [2captcha] \u26a0 No sitekey found in page source")
                    # Try scanning network requests for recaptcha API calls
                    log(f"  [2captcha] Attempting to extract sitekey from page scripts...")
                    scripts = await page.evaluate("""() => {
                        const scripts = 'script[src*="recaptcha"]');
                        const results = [];
                        scripts.forEach(s => results.push(s.src));
                        return results;
                    }""")
                    log(f"  [2captcha] Found {len(scripts) if scripts else 0} recaptcha scripts")
                    if scripts:
                        for s in scripts:
                            m2 = re.search(r'[?&]k=(6[A-Za-z0-9_-]{38,40})', s)
                            if m2:
                                sitekey = m2.group(1)
                                break
            
            if not sitekey:
                log("  [2captcha] Could not find reCAPTCHA sitekey")
                return None
            
            url = page.url
            log(f"  [2captcha] Solving reCAPTCHA v2 for: {url[:60]}...")
            token = self.solve_recaptcha_v2_proxyless(sitekey, url, timeout=timeout)
            
            if token:
                # Inject token into the page
                log(f"  [2captcha] Injecting token: {token[:30]}...")
                await page.evaluate(f"""
                    const token = {json.dumps(token)};
                    // Set in 
                    const el = document.getElementById('');
                    if (el) el.value = token;
                    // Call callback if exists
                    if (window.___grecaptcha_cfg && window.___grecaptcha_cfg.clients) {{
                        for (const [clientId, client] of Object.entries(window.___grecaptcha_cfg.clients)) {{
                            if (client.callback) {{
                                client.callback(token);
                                break;
                            }}
                        }}
                    }}
                    // Trigger any onRecaptchaVerified callbacks
                    if (window.onRecaptchaVerified) window.onRecaptchaVerified(token);
                    if (window.recaptchaCallback) window.recaptchaCallback(token);
                """)
                return token
            
            return None
        except Exception as e:
            log(f"  [2captcha] Detection error: {e}")
            return None


async def check_proxy_ip(page: Page):
    try:
        await page.goto("https://api.ipify.org?format=json", wait_until="domcontentloaded", timeout=15000)
        body = await page.locator("body").inner_text()
        data = json.loads(body)
        log(f"    Proxy IP: {data.get('ip','?')}")
        return data
    except Exception as e:
        log(f"    Proxy check: {e}")
        return None


async def session_warmup(page: Page):
    """Warm up the browser session with realistic browsing BEFORE signup"""
    log("[W] Session warming...")
    
    # Step 1: Visit YouTube to build cookie/profile
    log("    Visiting YouTube...")
    await page.goto("https://www.youtube.com/", wait_until="domcontentloaded", timeout=30000)
    await asyncio.sleep(3)
    
    # Step 2: Scroll a bit (human behavior)
    vp = page.viewport_size or {"width": 1280, "height": 800}
    await page.mouse.wheel(0, vp["height"] // 3)
    await asyncio.sleep(1)
    await page.mouse.wheel(0, -vp["height"] // 5)
    await asyncio.sleep(1)
    
    # Step 3: Visit google.com to establish Google cookies
    log("    Visiting Google...")
    await page.goto("https://www.google.com/", wait_until="domcontentloaded", timeout=30000)
    await asyncio.sleep(2)
    
    # Step 4: Random mouse movements
    for _ in range(random.randint(2, 4)):
        x = random.randint(vp["width"]//4, vp["width"]*3//4)
        y = random.randint(vp["height"]//4, vp["height"]*3//4)
        await page.mouse.move(x, y, steps=random.randint(5, 10))
        await asyncio.sleep(random.uniform(0.3, 0.8))
    
    log("    \u2713 Session warmed (cookies + fingerprint built)")
    return True


async def fill__v14(page: Page, yr, mo, dy, g):
    """Fill  form — JavaScript injection for Google's dynamic form"""
    log(f"    Birthday: {mo}/{dy}/{yr} {g}")
    
    await page.screenshot(path=os.path.join(SS, f"v14__start.png"))
    
    try:
        # Wait for inputs to be visible (Google SPA uses reactive components, no <form>)
        await page.wait_for_selector('input, select, [role="button"]', timeout=10000)
        await asyncio.sleep(1)
        
        # Debug: find all form elements
        form_info = await page.evaluate("""() => {
            const form = document.querySelector('form');
            if (!form) return 'NO_FORM';
            const inputs = form.querySelectorAll('input, select');
            const info = [];
            inputs.forEach(inp => {
                info.push({
                    tag: inp.tagName,
                    type: inp.type || '',
                    name: inp.name || '',
                    id: inp.id || '',
                    ariaLabel: inp.getAttribute('aria-label') || '',
                    placeholder: inp.placeholder || '',
                    class: inp.className.substring(0, 50)
                });
            });
            return JSON.stringify(info);
        }""")
        log(f"    Form elements: {form_info[:300]}")
        
        # Strategy: use JavaScript to directly set the React/Material state
        # Google stores form values in their internal state, not just DOM
        
        month_name = ["", "January","February","March","April","May","June","July","August","September","October","November","December"][mo]
        gender_val = "1" if g == "Male" else "2"
        
        # Try to set all fields via JavaScript, targeting Google's form structure
        result = await page.evaluate(f"""() => {{
            const monthName = "{month_name}";
            const day = "{dy}";
            const year = "{yr}";
            const gender = "{g}";
            
            let success = 'none';
            
            // Attempt 1: Try native select elements
            const monthSelect = document.querySelector('#month, select[name="month"], select[id*="month"]');
            const dayInput = document.querySelector('#day, "day"], input[id*="day"]');
            const yearInput = document.querySelector('#year, "year"], input[id*="year"]');
            const genderSelect = document.querySelector('#gender, select[name="gender"], select[id*="gender"]');
            
            if (monthSelect && dayInput && yearInput && genderSelect) {{
                // Native elements approach
                monthSelect.selectedIndex = {mo-1};
                monthSelect.dispatchEvent(new Event('change', {{bubbles: true}}));
                dayInput.value = day;
                dayInput.dispatchEvent(new Event('input', {{bubbles: true}}));
                yearInput.value = year;
                yearInput.dispatchEvent(new Event('input', {{bubbles: true}}));
                genderSelect.selectedIndex = {gender_val};
                genderSelect.dispatchEvent(new Event('change', {{bubbles: true}}));
                success = 'native';
            }}
            
            // Attempt 2: Try Material Design inputs by aria-label
            if (success === 'none') {{
                const allInputs = 'input');
                for (const inp of allInputs) {{
                    const label = (inp.getAttribute('aria-label') || '').toLowerCase();
                    if (label.includes('month') || label.includes('day') || label.includes('year') || label.includes('gender')) {{
                        if (label.includes('month')) {{
                            inp.value = monthName;
                            inp.dispatchEvent(new Event('input', {{bubbles: true}}));
                            inp.dispatchEvent(new Event('change', {{bubbles: true}}));
                        }} else if (label.includes('day')) {{
                            inp.value = day;
                            inp.dispatchEvent(new Event('input', {{bubbles: true}}));
                        }} else if (label.includes('year')) {{
                            inp.value = year;
                            inp.dispatchEvent(new Event('input', {{bubbles: true}}));
                        }} else if (label.includes('gender')) {{
                            inp.value = gender;
                            inp.dispatchEvent(new Event('input', {{bubbles: true}}));
                        }}
                        success = 'aria-label';
                    }}
                }}
            }}
            
            // Attempt 3: Force-set all form fields by placeholder pattern
            if (success === 'none') {{
                const allInputs = '"hidden"])');
                // Find all text-like inputs in the form
                const formInputs = Array.from(allInputs).filter(i => 
                    i.type === 'text' || i.type === 'number' || i.type === 'tel'
                );
                // Google's  form typically has 4 fields in order: month dropdown, day, year, gender dropdown
                // But they might be all inputs now (Material Design)
                for (const inp of formInputs) {{
                    const ph = (inp.placeholder || inp.getAttribute('aria-label') || '').toLowerCase();
                    const parent_text = (inp.parentElement?.textContent || '').toLowerCase();
                    
                    if (ph.includes('month') || parent_text.includes('month')) {{
                        inp.focus(); inp.value = monthName;
                        inp.dispatchEvent(new Event('input', {{bubbles: true}}));
                        inp.dispatchEvent(new Event('change', {{bubbles: true}}));
                    }} else if (ph.includes('day') || parent_text.includes('day')) {{
                        inp.focus(); inp.value = day;
                        inp.dispatchEvent(new Event('input', {{bubbles: true}}));
                    }} else if (ph.includes('year') || parent_text.includes('year')) {{
                        inp.focus(); inp.value = year;
                        inp.dispatchEvent(new Event('input', {{bubbles: true}}));
                    }} else if (ph.includes('gender') || parent_text.includes('gender')) {{
                        inp.focus(); inp.value = gender;
                        inp.dispatchEvent(new Event('input', {{bubbles: true}}));
                        inp.dispatchEvent(new Event('change', {{bubbles: true}}));
                    }}
                    success = 'placeholder';
                }}
            }}
            
            return success;
        }}""")
        
        log(f"    Fill method: {result}")
        
        await page.screenshot(path=os.path.join(SS, f"v14__after_js.png"))
        
        # Now try click-based approach for dropdowns that didn't work
        log("    Trying click-based approach for dropdowns...")
        
        # Month - click and type
        for month_sel in [
            'div[role="button"]:has-text("Month")',
            'span:has-text("Month")',
            'div:has(> span:text("Month"))',
        ]:
            mt = page.locator(month_sel).first
            if await mt.count() > 0:
                try:
                    await mt.click(force=True, timeout=3000)
                    await asyncio.sleep(0.5)
                    m_abbr = ["","J","F","M","A","M","J","J","A","S","O","N","D"][mo]
                    await page.keyboard.type(m_abbr, delay=60)
                    await asyncio.sleep(0.3)
                    await page.keyboard.press("Enter")
                    log(f"    Month clicked: {month_sel}")
                    break
                except Exception as e:
                    log(f"    Month click failed: {e}")
        
        await asyncio.sleep(0.5)
        
        # Gender - click and type
        for gender_sel in [
            'div[role="button"]:has-text("Gender")',
            'span:has-text("Gender")',
            'div:has-text("Gender")',
        ]:
            gt = page.locator(gender_sel).first
            if await gt.count() > 0:
                try:
                    await gt.click(force=True, timeout=3000)
                    await asyncio.sleep(0.5)
                    g_abbr = "M" if g == "Male" else "F"
                    await page.keyboard.type(g_abbr, delay=60)
                    await asyncio.sleep(0.3)
                    await page.keyboard.press("Enter")
                    log(f"    Gender clicked: {gender_sel}")
                    break
                except Exception as e:
                    log(f"    Gender click failed: {e}")
        
        await page.screenshot(path=os.path.join(SS, f"v14__final.png"))
        log("    \u2713 Birthday fill complete")
        return True
        
    except Exception as e:
        log(f"    \u2717 Birthday error: {e}")
        traceback.print_exc()
        await page.screenshot(path=os.path.join(SS, f"v14__error.png"))
        return False


async def click_next(page):
    for label in ["Next", "Continue", "I agree", "Agree", "Create account"]:
        try:
            b = page.locator(f'"{label}")').first
            if await b.count() > 0 and await b.is_visible():
                await b.click(timeout=5000)
                return True
        except: pass
    try:
        await page.keyboard.press("Enter")
        return True
    except: return False


async def _one(attempt_num):
    f, l = random.choice(FIRST), random.choice(LAST)
    uname = f"{f.lower()}{l.lower()}{random.randint(100,9999)}"
    pw = (random.choice(string.ascii_uppercase) + 
          "".join(random.choices(string.ascii_lowercase, k=5)) + 
          "".join(random.choices(string.digits, k=4)) + "!")
    yr, mo, dy = random.randint(1980, 2002), random.randint(1, 12), random.randint(1, 28)
    g = random.choice(["Male", "Female"])
    email = f"{uname}@gmail.com"
    vw = random.choice([(1280, 800), (1366, 768), (1440, 900), (1536, 864)])
    
    log("")
    log("="*60)
    log(f"ATTEMPT #{attempt_num} | {email} | {f} {l} | {yr}-{mo:02d}-{dy:02d} | {g}")
    log(f"Proxy: {PROXY_URL}")
    log("="*60)
    
    captcha = CaptchaSolver(CAPTCHA_KEY)
    sim5 = None
    order = None
    browser = None
    
    try:
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(
                headless=False,
                proxy={"server": PROXY_URL},
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
            )
            
            page = await context.new_page()
            
            # ═══ STEALTH ═══
            stealth = Stealth(
                navigator_webdriver=True,
                navigator_languages=True,
                navigator_plugins=True,
                chrome_runtime=True,
                chrome_app=True,
                chrome_csi=True,
                chrome_load_times=True,
                iframe_content_window=True,
                media_codecs=True,
                hairline=True,
                webgl_vendor=True,
                webgl_renderer_override="ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)",
            )
            await stealth.apply_stealth_async(page)
            log("    \u2713 Stealth applied")
            
            # ═══ Proxy check ═══
            # Skip proxy check for IP consistency
            log("[0] Skipping proxy check (IP consistency)")
            # ip_info = await check_proxy_ip(page)
            # if not ip_info:
            #     return None
            ip_info = {"ip": "via_lokiproxy"}
            
            # ═══ Skip Session Warming (IP rotation breaks Google) ═══
            log("[W] Skipping session warming to avoid IP inconsistency")
            # await session_warmup(page)

            # ═══ Direct to Signup with clean IP ═══
            # Wait a moment to let the proxy settle
            await asyncio.sleep(1)

            # ═══ Signup ═══
            log("[1] Opening Gmail signup...")
            await page.goto(
                "https://.google.com/signup/v2/webcreateaccount?hl=en&flowName=GlifWebSignIn&flowEntry=SignUp",
                timeout=30000, wait_until="domcontentloaded"
            )
            await asyncio.sleep(4)
            
            # Check for reCAPTCHA
            log("[C] Checking for reCAPTCHA...")
            captcha_token = await captcha.detect_and_solve(page)
            if captcha_token:
                log("    \u2713 CAPTCHA solved, continuing...")
            
            await page.screenshot(path=os.path.join(SS, f"v14_step1_{attempt_num}.png"))
            
            # ═══ Name - type like a human ═══
            log(f"[2] Name: {f} {l}")
            for sel, val in [('"firstName"]', f), ('"lastName"]', l)]:
                inp = page.locator(sel).first
                if await inp.count() > 0:
                    await inp.click(timeout=3000)
                    await asyncio.sleep(0.3)
                    await inp.fill('')
                    await inp.type(val, delay=random.randint(60, 150))
                    await asyncio.sleep(random.uniform(0.5, 1.0))
            await page.screenshot(path=os.path.join(SS, f"v14_name_filled_{attempt_num}.png"))
            await click_next(page)
            await asyncio.sleep(5)
            
            # ═══ Birthday ═══
            log(f"[3] Birthday...")
            bd_ok = await fill__v14(page, yr, mo, dy, g)
            if not bd_ok:
                return None
            
            # Human-like pause before clicking Next
            await page.screenshot(path=os.path.join(SS, f"v14_step3_{attempt_num}.png"))
            log(f"    Human delay {random.uniform(1.5, 3.5):.1f}s before clicking Next...")
            await asyncio.sleep(random.uniform(1.5, 3.5))
            
            await click_next(page)
            await asyncio.sleep(5)
            
            # Check for redirect
            curl = page.url.lower()
            log(f"    After Next: {curl[:80]}")
            await page.screenshot(path=os.path.join(SS, f"v14_step3_after_{attempt_num}.png"))
            
            if "/gender" in curl:
                log("    \u2717 Redirected back to  — anti-bot")
                return None
            
            # ═══ Username ═══
            log(f"[4] Username: {uname}")
            await page.screenshot(path=os.path.join(SS, f"v14_step4_{attempt_num}.png"))
            
            # Click "Create your own"
            for lbl in ["Create your own", "Create your own Gmail address"]:
                el = page.locator(f'span:has-text("{lbl}"),"{lbl}")').first
                if await el.count() > 0:
                    try:
                        await el.click(timeout=5000)
                        await asyncio.sleep(2)
                    except: pass
            
            un_el = page.locator('"Username"]').first
            if await un_el.count() > 0:
                await un_el.click(timeout=3000)
                await un_el.fill(uname)
                await asyncio.sleep(2)
                await click_next(page)
                await asyncio.sleep(4)
            
            if "/gender" in page.url.lower():
                log("    \u2717 Redirected back to  after  — proxy flagged")
                return None
            
            # Check if we're actually on the  page
            await page.screenshot(path=os.path.join(SS, f"v14_step5_pre_{attempt_num}.png"))
            curl = page.url.lower()
            body_text = (await page.locator("body").inner_text()).lower()
            log(f"    Page: {curl[:80]}")
            
            pws = page.locator('""]')
            pwc = await pws.count()
            
            if pwc == 0:
                # Not on  page — check where we are
                log(f"    No  fields found, current state: {body_text[:200]}")
                # Try clicking next again or handling suggestions
                for lbl in ["Next", "Continue", "Skip", "I'll choose"]:
                    btn = page.locator(f'"{lbl}"),span:has-text("{lbl}")').first
                    if await btn.count() > 0 and await btn.is_visible():
                        await btn.click(timeout=3000)
                        await asyncio.sleep(3)
                        break
                pwc = await page.locator('""]').count()
            
            log("    \u2713 Username accepted")
            
            # ═══  ═══
            log(f"[5] ...")
            pws = page.locator('""]')
            pwc = await pws.count()
            if pwc >= 2:
                await pws.nth(0).click(timeout=3000); await pws.nth(0).fill(pw)
                await pws.nth(1).click(timeout=3000); await pws.nth(1).fill(pw)
            elif pwc == 1:
                await pws.nth(0).click(timeout=3000); await pws.nth(0).fill(pw)
            
            await click_next(page)
            await asyncio.sleep(4)
            
            # ═══ Terms / Recovery ═══
            log("[6] Terms & recovery...")
            body = (await page.locator("body").inner_text()).lower()
            
            if "terms" in body or "privacy" in body:
                for l in ["I agree", "Agree"]:
                    b = page.locator(f'"{l}")').first
                    if await b.count() > 0:
                        await b.click(timeout=3000); break
                await asyncio.sleep(3)
            
            if "skip" in body or "recovery" in body:
                for l in ["Skip", "Not now"]:
                    b = page.locator(f'"{l}")').first
                    if await b.count() > 0:
                        await b.click(timeout=3000); break
                await asyncio.sleep(2)
            
            await click_next(page)
            await asyncio.sleep(4)
            
            # ═══ Phone ═══
            log("[7] Phone verification...")
            await page.screenshot(path=os.path.join(SS, f"v14_step7_{attempt_num}.png"))
            
            curl = page.url.lower()
            body = (await page.locator("body").inner_text()).lower()
            log(f"    URL: {curl[:100]}")
            log(f"    Body: {body[:200]}")
            
            # Check if we're already done
            for check_url in ["", "mail.google.com", "welcome", "complete", "success", "home"]:
                if check_url in curl or check_url in body:
                    log("\U0001F389 ACCOUNT CREATED!")
                    return save_account(email, uname, pw)
            
            # Check if we're back at the name page (error)
            if "first name" in body or "enter your name" in body:
                log("    \u2717 Redirected back to name page —  may be taken")
                return None
            
            # Try every skip button
            skip_clicked = False
            for lbl in ["Skip", "Skip for now", "Not now", "Later", "I prefer", "No thanks"]:
                btn = page.locator(f'"{lbl}"),span:has-text("{lbl}"),a:has-text("{lbl}")').first
                if await btn.count() > 0 and await btn.is_visible():
                    await btn.click(timeout=5000)
                    await asyncio.sleep(3)
                    skip_clicked = True
                    if "" in page.url.lower() or "mail.google.com" in page.url.lower():
                        log("\U0001F389 SUCCESS!")
                        return save_account(email, uname, pw)
                    break
            
            # Try clicking Next if skip didn't work
            if not skip_clicked:
                await click_next(page)
                await asyncio.sleep(3)
            
            # Re-check
            curl = page.url.lower()
            body = (await page.locator("body").inner_text()).lower()
            
            if "" in curl or "mail.google.com" in curl or "welcome" in body:
                log("\U0001F389 ACCOUNT CREATED!")
                return save_account(email, uname, pw)
            
            # 5sim phone verification
            if any(kw in body for kw in ["verify", "phone", "number", "confirm", "prove"]):
                sim5 = Sim5(FIVESIM_KEY)
                bal = sim5.bal()
                log(f"    5sim: {bal} RUB")
                
                if bal < 0.3:
                    log("\u26a0 Low balance")
                    return None
                
                order = sim5.buy(country="indonesia")
                if not order:
                    return None
                
                phone = order["phone"]
                log(f"    \U0001F1EE\U0001F1E9 {phone} (#{order['id']}, {order['price']} RUB)")
                
                pi = page.locator('"tel"],"phoneNumber"]').first
                if await pi.count() > 0:
                    await pi.click(timeout=3000)
                    await pi.fill(phone)
                
                await click_next(page)
                await asyncio.sleep(2)
                
                log("    Waiting for SMS...")
                code = sim5.wait(order["id"], timeout=180)
                
                if code:
                    log(f"    CODE: {code}")
                    ci = page.locator('"hidden"""])').first
                    if await ci.count() > 0:
                        await ci.fill(code)
                    await click_next(page)
                    await asyncio.sleep(6)
                    
                    if "" in (await page.locator("body").inner_text()).lower():
                        log("\u2717 Wrong code")
                        sim5.cancel(order["id"])
                    elif "" in page.url.lower() or "mail.google.com" in page.url.lower():
                        log("\U0001F389 VERIFIED!")
                        sim5.finish(order["id"])
                        return save_account(email, uname, pw)
                    else:
                        sim5.cancel(order["id"])
                else:
                    sim5.cancel(order["id"])
            
            if "" in page.url.lower() or "mail.google.com" in page.url.lower():
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
    d = {"email": email, "": uname, "": pw, "": datetime.now().isoformat(), "status": "active"}
     = []
    if os.path.exists(ACCOUNTS):
        try:
            with open(ACCOUNTS,"r",encoding="utf-8") as f:  = json.load(f)
        except:  = []
    .append(d)
    with open(ACCOUNTS,"w",encoding="utf-8") as f: json.dump(,f,indent=2,ensure_ascii=False)
    log(f"  \U0001f4be Saved: {email}")
    return d


async def main():
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    
    log(f"\n{'='*60}")
    log(f"GMAIL REGISTRATOR v14 — 2CAPTCHA + WARMING + STEALTH")
    log(f"Target: {count} account(s)")
    log(f"{'='*60}\n")
    
    sim5 = Sim5(FIVESIM_KEY)
    cpt = CaptchaSolver(CAPTCHA_KEY)
    log(f"5sim balance: {sim5.bal()} RUB")
    log(f"2captcha balance: ${cpt.balance()}")
    
    results = []
    for attempt in range(1, count+1):
        r = await _one(attempt)
        if r:
            results.append(r)
            log(f"\U0001f389 SUCCESS: {r['email']}")
        else:
            log(f"\u274c FAILED")
        log(f"Results: {len(results)}/{attempt}")
    
    log(f"\n{'='*60}")
    log(f"DONE: {len(results)}/{count}")
    for r in results:
        log(f"  {r['email']} | {r['']}")
    log(f"{'='*60}")

if __name__ == "__main__":
    asyncio.run(main())
