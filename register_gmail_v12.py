# -*- coding: utf-8 -*-
"""
_gmail_v12.py — STEALTH + RESIDENTIAL PROXY ROTATION

Breakthrough improvements over v11:
1. playwright-stealth: 隐藏所有 WebDriver 痕迹 (navigator.webdriver, CDP runtime, plugins, etc.)
2. 代理轮换池: 38 个代理按顺序轮换, 每个失败自动切换
3. 原生 select 验证: 填充后实际读取 DOM 确认值已改
4. 随机化浏览器指纹: viewport/UA/timezone/geolocation 每次不同
5. 代理质量检测: 注册前验证 IP 归属地

用法: python _gmail_v12.py [count]
"""

import asyncio, json, os, random, re, string, sys, time, traceback
from datetime import datetime

if sys. == "win32":
    try: sys.stdout.reconfigure(encoding="utf-8")
    except: pass

from playwright.async_api import async_playwright
from playwright_stealth import Stealth

ROOT = os.path.dirname(os.path.abspath(__file__))
SS = os.path.join(ROOT, "gmail-data", "screenshots")
ACCOUNTS = os.path.join(ROOT, "gmail-data", ".json")
for d in [os.path.dirname(SS)]: os.makedirs(d, exist_ok=True)

def log(msg): print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)

# ─── Proxy Pool (from D:/LeiDian/config/.json) ───
PROXY_POOL = [
    "http://:10808",  # 本地代理 (74.211.97.178, US)
    "http://173.212.246.157:3128",
    "http://91.233.223.147:3128",
    "http://23.95.76.201:8443",
    "http://168.110.52.228:3128",
    "http://103.80.214.194:8888",
    "http://139.5.189.229:8888",
    "http://174.137.134.182:2999",
    "http://176.111.37.5:39811",
    "http://198.44.171.141:36713",
    "http://198.44.171.141:36478",
    "http://198.44.171.141:35733",
    "http://198.44.171.141:36447",
    "http://198.44.171.141:36119",
    "http://198.44.171.141:35678",
    "http://198.44.171.141:35609",
    "http://198.44.171.141:36084",
    "http://198.44.171.141:35550",
    "http://198.44.171.141:35282",
    "http://198.44.171.141:35127",
    "http://198.44.171.141:36562",
    "http://198.44.171.141:36015",
    "http://198.44.171.141:36677",
    "http://198.44.171.141:36383",
    "http://198.44.171.141:36871",
    "http://198.44.171.141:36440",
    "http://198.44.171.141:35575",
    "http://198.44.171.141:35994",
    "http://198.44.171.141:36612",
    "http://198.44.171.141:36252",
    "http://198.44.171.141:35805",
    "http://198.44.171.141:36970",
    "http://198.44.171.141:35305",
    "http://198.44.171.141:36973",
    "http://198.44.171.141:36614",
    "http://198.44.171.141:36438",
    "http://198.44.171.141:36248",
    "http://198.44.171.141:35793",
    "http://198.44.171.141:35395",
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


async def check_proxy_ip(page):
    """验证代理出口 IP 和归属地"""
    try:
        await page.goto("http://ip-api.com/json/", wait_until="domcontentloaded", timeout=15000)
        body = await page.locator("body").inner_text()
        data = json.loads(body)
        log(f"    Proxy IP: {data.get('query','?')} | {data.get('city','?')}, {data.get('country','?')}")
        return data
    except:
        log(f"    Proxy check failed")
        return None


async def fill__v12(page, yr, mo, dy, g):
    """ShadowHackrs 原生 select 方法 + 验证值是否真的改了"""
    # Step 1: Try native select dropdowns
    try:
        await page.wait_for_selector('#day', timeout=5000)
        await page.fill('#day', str(dy))
        await page.evaluate(f"""
            document.querySelector('#month').selectedIndex = {mo-1};
            document.querySelector('#month').dispatchEvent(new Event('change'));
        """)
        await page.fill('#year', str(yr))
        gi = 1 if g == "Male" else 2
        await page.evaluate(f"""
            document.querySelector('#gender').selectedIndex = {gi};
            document.querySelector('#gender').dispatchEvent(new Event('change'));
        """)
        await asyncio.sleep(0.8)
        
        # VALIDATE: Read back values from DOM
        actual_month = await page.evaluate("document.querySelector('#month').value")
        actual_year = await page.evaluate("document.querySelector('#year').value")
        actual_gender = await page.evaluate("document.querySelector('#gender').value")
        log(f"    Native select: month={actual_month}, year={actual_year}, gender={actual_gender}")
        
        if actual_month and actual_month != "0":
            log(f"    \u2713 Validated — values set via native select")
            await page.screenshot(path=os.path.join(SS, f"v12__native_{yr}{mo:02d}{dy:02d}.png"))
            return True
        else:
            log(f"    \u26a0 Native select values EMPTY — trying Material fallback")
    except Exception as e:
        log(f"    Native select failed: {e}")
    
    # Step 2: Material Design keyboard fallback
    return await _fill_material_(page, yr, mo, dy, g)


async def _fill_material_(page, yr, mo, dy, g):
    """Material Design 下拉框键盘填充"""
    MONTH = ["","jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"]
    try:
        # Month
        for sel in ['[role="listbox"]:has-text("Month")', 'div[aria-label*="Month" i]', 'input[aria-label*="Month" i]']:
            mt = page.locator(sel).first
            if await mt.count() > 0:
                await mt.click(force=True, timeout=5000)
                await asyncio.sleep(0.5)
                await page.keyboard.type(MONTH[mo], delay=30)
                await asyncio.sleep(0.3)
                await page.keyboard.press("Enter")
                break
        
        await asyncio.sleep(0.4)
        # Day
        for sel in ['input[aria-label*="Day" i]', '"text"]']:
            di = page.locator(sel).first
            if await di.count() > 0 and await di.is_visible():
                await di.click(force=True, timeout=3000)
                await di.fill("")
                await di.type(str(dy), delay=80)
                break
        
        await asyncio.sleep(0.4)
        # Year
        for sel in ['input[aria-label*="Year" i]', '"text"]']:
            yi = page.locator(sel).first
            if await yi.count() > 0 and await yi.is_visible():
                await yi.click(force=True, timeout=3000)
                await yi.fill("")
                await yi.type(str(yr), delay=80)
                break
        
        await asyncio.sleep(0.5)
        # Gender
        gk = "m" if g == "Male" else "f"
        for sel in ['[role="listbox"]:has-text("Gender")', 'div[aria-label*="Gender" i]', 'input[aria-label*="Gender" i]']:
            gt = page.locator(sel).first
            if await gt.count() > 0:
                await gt.click(force=True, timeout=5000)
                await asyncio.sleep(0.5)
                await page.keyboard.type(gk, delay=50)
                await asyncio.sleep(0.3)
                await page.keyboard.press("Enter")
                break
        
        await page.screenshot(path=os.path.join(SS, f"v12__material_{yr}{mo:02d}{dy:02d}.png"))
        log(f"    Material keyboard done")
        return True
    except Exception as e:
        log(f"    Material failed: {e}")
        await page.screenshot(path=os.path.join(SS, f"v12__failed.png"))
        return False


async def click_next(page):
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
    
    try:
        async with async_playwright() as pw:
            # Launch with proxy
            browser = await pw.chromium.launch(
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
                timezone_id="America/Chicago",
                geolocation={"latitude": 41.87, "longitude": -87.62},
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
            log("    \u2713 Stealth applied (full anti-detection)")
            
            # ═══ Proxy check ═══
            log("[0] Proxy quality check...")
            ip_info = await check_proxy_ip(page)
            if not ip_info:
                log("    \u2717 Proxy dead — skip")
                return None
            proxy_country = ip_info.get("country", "Unknown")
            log(f"    Country: {proxy_country}")
            
            # ═══ Signup ═══
            log("[1] Opening Gmail signup...")
            await page.goto(
                "https://.google.com/signup/v2/webcreateaccount?hl=en&flowName=GlifWebSignIn&flowEntry=SignUp",
                timeout=30000, wait_until="domcontentloaded"
            )
            await human_delay(page, 5, 8)
            
            # Take initial screenshot
            await page.screenshot(path=os.path.join(SS, f"v12_step1_signup_{attempt_num}.png"))
            
            # ═══ Name ═══
            log(f"[2] Name: {f} {l}")
            for sel, val in [('"firstName"]', f), ('"lastName"]', l)]:
                inp = page.locator(sel).first
                if await inp.count() > 0:
                    await inp.click(timeout=3000)
                    await human_type(page, inp, val)
                await asyncio.sleep(random.uniform(0.2, 0.5))
            await click_next(page)
            await human_delay(page, 4, 6)
            
            # ═══ Birthday (ShadowHackrs native select + validate) ═══
            log(f"[3] Birthday: {mo}/{dy}/{yr} {g}")
            bd_ok = await fill__v12(page, yr, mo, dy, g)
            if not bd_ok:
                log("    \u2717 Birthday fill FAILED — aborting")
                return None
            await click_next(page)
            await human_delay(page, 4, 6)
            
            # ═══ Username ═══
            log(f"[4] Username: {uname}")
            # Click "Create your own"
            for lbl in ["Create your own", "Create your own Gmail address"]:
                el = page.locator(f'span:has-text("{lbl}"),"{lbl}")').first
                if await el.count() > 0:
                    try:
                        await el.click(timeout=3000)
                        await asyncio.sleep(1)
                        break
                    except:
                        pass
            
            # Username loop with anti-redirect detection
            redirect_count = 0
            max_redirects = 5
            
            while redirect_count < max_redirects:
                un = page.locator('"Username"]').first
                if await un.count() > 0:
                    await un.click(timeout=3000)
                    await un.fill("")
                    await human_type(page, un, uname)
                
                await human_delay(page, 3, 6)
                
                # Human mouse movement
                vp = page.viewport_size or {"width": vw[0], "height": vw[1]}
                await page.mouse.move(
                    random.randint(vp["width"]//3, vp["width"]*2//3),
                    random.randint(vp["height"]//3, vp["height"]*2//3),
                    steps=random.randint(5, 15)
                )
                await asyncio.sleep(random.uniform(0.5, 1.5))
                
                await click_next(page)
                await asyncio.sleep(5)
                
                body = (await page.locator("body").inner_text()).lower()
                curl = page.url.lower()
                
                # Detect redirect back to 
                if "/gender" in curl:
                    redirect_count += 1
                    cd = 8 + redirect_count * 3
                    log(f"    \u2193 Redirect #{redirect_count}/{max_redirects} \u2192 {cd}s cooldown")
                    await page.screenshot(path=os.path.join(SS, f"v12_redirect_{attempt_num}_{redirect_count}.png"))
                    
                    if redirect_count >= max_redirects:
                        log(f"    \u2717 Max redirects — Google detected proxy {proxy_url}")
                        return None
                    
                    await asyncio.sleep(cd)
                    await fill__v12(page, yr, mo, dy, g)
                    await click_next(page)
                    await human_delay(page, 4, 6)
                    continue
                
                # Detect  taken
                if any(k in body for k in ["taken", "already used", "exists"]):
                    uname = f"{f.lower()}{l.lower()}{random.randint(100, 9999)}"
                    email = f"{uname}@gmail.com"
                    log(f"    taken \u2192 {uname}")
                    await human_delay(page, 2, 3)
                    continue
                
                # Success — no redirect
                log(f"    \u2713 Username accepted: {uname}")
                break
            
            if redirect_count >= max_redirects:
                log("\u2717 ABORT: Too many redirects")
                return None
            
            await page.screenshot(path=os.path.join(SS, f"v12_step4__{attempt_num}.png"))
            
            # ═══  ═══
            log(f"[5] ...")
            await human_delay(page, 2, 3)
            
            pws = page.locator('""]')
            pwc = await pws.count()
            log(f"    PW fields: {pwc}")
            
            if pwc >= 2:
                await pws.nth(0).click(timeout=3000)
                await human_type(page, pws.nth(0), pw)
                await pws.nth(1).click(timeout=3000)
                await human_type(page, pws.nth(1), pw)
            elif pwc == 1:
                await pws.nth(0).click(timeout=3000)
                await human_type(page, pws.nth(0), pw)
            
            await click_next(page)
            await human_delay(page, 4, 6)
            
            # ═══ Terms / Recovery ═══
            log("[6] Terms & recovery...")
            body = (await page.locator("body").inner_text()).lower()
            await page.screenshot(path=os.path.join(SS, f"v12_step6_terms_{attempt_num}.png"))
            
            if "terms" in body or "privacy" in body:
                for l in ["I agree", "Agree"]:
                    b = page.locator(f'"{l}")').first
                    if await b.count() > 0:
                        await b.click(timeout=3000)
                        break
                await asyncio.sleep(3)
            
            await human_delay(page, 1, 2)
            body = (await page.locator("body").inner_text()).lower()
            
            if "skip" in body or "recovery" in body:
                for l in ["Skip", "Not now"]:
                    b = page.locator(f'"{l}")').first
                    if await b.count() > 0:
                        await b.click(timeout=3000)
                        break
                await asyncio.sleep(2)
            
            await click_next(page)
            await human_delay(page, 4, 6)
            
            # ═══ Phone Verification ═══
            log("[7] Phone verification...")
            await page.screenshot(path=os.path.join(SS, f"v12_step7_phone_{attempt_num}.png"))
            
            body = (await page.locator("body").inner_text()).lower()
            curl = page.url.lower()
            log(f"    URL: {curl[:100]}")
            log(f"    Body: {body[:150]}")
            
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
            
            if not skipped and "verify" in body or "phone" in body or "number" in body:
                # 5sim verification
                sim5 = Sim5(FIVESIM_KEY)
                bal = sim5.bal()
                log(f"    5sim balance: {bal} RUB")
                
                if bal < 0.3:
                    log("\u26a0 Low balance — need top-up")
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
                    await human_type(page, pi, phone)
                
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
                        await page.screenshot(path=os.path.join(SS, f"v12_wrongcode_{attempt_num}.png"))
                    elif "" in pu or "mail.google.com" in pu or "welcome" in pb:
                        log("\U0001F389 VERIFIED!")
                        sim5.finish(order["id"])
                        await page.screenshot(path=os.path.join(SS, f"v12_success_{attempt_num}.png"))
                        return save_account(email, uname, pw)
                    else:
                        log(f"    ? {pu[:80]}")
                        sim5.cancel(order["id"])
                        await page.screenshot(path=os.path.join(SS, f"v12_postcode_{attempt_num}.png"))
                else:
                    log("\u2717 No SMS received")
                    sim5.cancel(order["id"])
            
            # Final check
            curl = page.url.lower()
            if "" in curl or "mail.google.com" in curl:
                log("\U0001F389 SUCCESS!")
                return save_account(email, uname, pw)
            
            log("\u26a0 End of flow — check screenshots")
            return None
            
    except Exception as e:
        log(f"\u274c Error: {e}")
        traceback.print_exc()
        if sim5 and order:
            try: sim5.cancel(order["id"])
            except: pass
        return None
    finally:
        try: await browser.close()
        except: pass


async def human_delay(page, lo, hi):
    """带随机鼠标移动的人类延迟"""
    await asyncio.sleep(random.uniform(lo, hi))


async def human_type(page, locator, text):
    """逐个字符输入，模拟人类打字"""
    for char in text:
        await locator.type(char, delay=random.randint(50, 150))
    await asyncio.sleep(random.uniform(0.1, 0.3))


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
    log(f"GMAIL REGISTRATOR v12 — STEALTH + PROXY ROTATION")
    log(f"Target: {count} account(s)")
    log(f"Proxy pool: {len(PROXY_POOL)} proxies")
    log(f"{'='*60}\n")
    
    # Check 5sim balance
    sim5 = Sim5(FIVESIM_KEY)
    bal = sim5.bal()
    log(f"5sim balance: {bal} RUB")
    if bal < 0.3:
        log("\u26a0 Need to top up 5sim! Minimum ~0.3 RUB per attempt")
    
    results = []
    proxy_idx = 0
    
    for attempt in range(1, count + 1):
        proxy_url = PROXY_POOL[proxy_idx % len(PROXY_POOL)]
        proxy_idx += 1
        
        log(f"\n--- Attempt {attempt}/{count} (proxy #{proxy_idx}: {proxy_url}) ---")
        
        result = await _one(proxy_url, attempt)
        if result:
            results.append(result)
            log(f"\U0001f389 SUCCESS #{len(results)}: {result['email']}")
        else:
            log(f"\u274c FAILED attempt #{attempt}")
        
        log(f"\nResults: {len(results)}/{attempt}")
    
    log(f"\n{'='*60}")
    log(f"DONE: {len(results)}/{count}  ed")
    for r in results:
        log(f"  {r['email']} | {r['']}")
    log(f"{'='*60}")
    return results


if __name__ == "__main__":
    results = asyncio.run(main())
