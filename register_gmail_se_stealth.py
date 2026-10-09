# -*- coding: utf-8 -*-
"""
_gmail_se_stealth.py
SELENIUM + BITBROWSER + CDP-LEVEL ANTI-DETECTION INJECTION

Uses Page.addScriptToEvaluateOnNewDocument to inject anti-detection JS
BEFORE any page script runs. This is the strongest possible approach with Selenium.
"""
import json, os, random, re, string, sys, time, traceback
from datetime import datetime

if sys. == "win32":
    try: sys.stdout.reconfigure(encoding="utf-8")
    except: pass

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.common.exceptions import TimeoutException, NoSuchElementException

ROOT = os.path.dirname(os.path.abspath(__file__))
ACCOUNTS = os.path.join(ROOT, "gmail-data", ".json")

def log(msg): print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)

# ========== CONFIG ==========
BITBROWSER_API = "http://:54345"
API_KEY = ""
FIVESIM_KEY = "eyJhbGciOiJSUzUxMiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE4MTM3MzQ3ODEsImlhdCI6MTc4MjE5ODc4MSwicmF5IjoiNjIxMWY0MjAyNmM2YjZkNDMxMjMxYjY0MDkwMzg3MDYiLCJzdWIiOjQyMjIwNTB9.wRPYREkUdv60wd68XujZqXlravtg01aMWYECx0Bl1fLqC2uxL2yELzAIWIG_b_yAhKrymtxV5XsGlCpBm_uapnwJZhUw7LyHHnYl_V6weL6uEvk2ayrcIhaUCa13RORmRen8fXdrElnO_flZqQpeJRqm7gpUQF-HSy8Az3iy3j0JWvW9pfg_sAZTCA6vlADn66lrZ36O5g3NiKoTtTB0SYo8lfzFxtBbROc6gSMg_46dmn1hjNgJB6cetJ33DLQ1UJCuckcjV_lVfiPIMYT51RIqaRS8zyPaCTT8938whKFHbbJgWpne-6ldHmdeDudWDtytElk7d204shjBL1q1ww"
PROXY_HOST = ""
PROXY_PORT = 8090

HEADERS = {"": API_KEY, "": "application/json"}

FIRST = ["James","John","Robert","David","William","Richard","Joseph","Thomas","Christopher","Daniel","Matthew","Anthony","Mark","Paul","Steven","Andrew","Kenneth","George","Brian"]
LAST = ["Smith","Johnson","Williams","Brown","Jones","Garcia","Miller","Davis","Rodriguez","Martinez","Hernandez","Lopez","Gonzalez","Wilson","Anderson","Thomas","Taylor","Moore","Jackson"]

import requests as _req

# ========== COMPREHENSIVE ANTI-DETECTION JS ==========
# This script runs BEFORE any page JavaScript, overriding all detectable  markers.
ANTI_DETECTION_JS = """
(() {
    'use strict';
    
    // 1. Override navigator.webdriver (most important)
    Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
    });
    
    // 2. Override chrome.runtime (should exist in real Chrome)
    window.chrome = {
        runtime: {},
        loadTimes: () {},
        csi: () {},
        app: {}
    };
    
    // 3. Realistic plugins array
    Object.defineProperty(navigator, 'plugins', {
        get: () => {
            const makePlugin = (name, filename, desc) => ({
                name, filename, description: desc,
                length: 1,
                item: () => null,
                namedItem: () => null,
            });
            return [
                makePlugin('Chrome PDF Plugin', 'internal-pdf-viewer', 'Portable Document Format'),
                makePlugin('Chrome PDF Viewer', 'mhjfbmdgcfjbbpaeojofohoefgiehjai', ''),
                makePlugin('Native Client', 'internal-nacl-plugin', ''),
            ];
        },
    });
    
    // 4. Realistic languages
    Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
    });
    Object.defineProperty(navigator, 'language', {
        get: () => 'en-US',
    });
    
    // 5. Override permissions API
    const origQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications' ?
        Promise.resolve({ state: Notification.permission, onchange: null }) :
        origQuery(parameters)
    );
    
    // 6. Hardware concurrency
    Object.defineProperty(navigator, 'hardwareConcurrency', {
        get: () => 8,
    });
    
    // 7. Device memory
    Object.defineProperty(navigator, 'deviceMemory', {
        get: () => 8,
    });
    
    // 8. Platform
    Object.defineProperty(navigator, '', {
        get: () => 'Win32',
    });
    
    // 9. Vendor
    Object.defineProperty(navigator, 'vendor', {
        get: () => 'Google Inc.',
    });
    
    // 10. Max touch points
    Object.defineProperty(navigator, 'maxTouchPoints', {
        get: () => 0,
    });
    
    // 11. Override WebDriver-specific properties
    delete Object.getPrototypeOf(navigator).webdriver;
    
    // 12. Connection
    if (navigator.connection) {
        Object.defineProperty(navigator.connection, 'rtt', {
            get: () => 100,
        });
    }
})();
"""

# ========== BITBROWSER API ==========
def api_call(method, path, data=None, timeout=60):
    url = f"{BITBROWSER_API}{path}"
    try:
        if method == "GET":
            r = _req.get(url, headers=HEADERS, timeout=timeout)
        else:
            r = _req.post(url, headers=HEADERS, json=data, timeout=timeout)
        if r.status_code >= 400:
            log(f"  API {path}: {r.status_code} {r.text[:200]}")
            return None
        return r.json()
    except Exception as e:
        log(f"  API {path} error: {e}")
        return None

def create_profile(name):
    data = {
        "name": name,
        "proxyMethod": 2, "proxyType": "http",
        "host": PROXY_HOST, "port": PROXY_PORT,
        "browserFingerPrint": {
            "coreVersion": "124", "ostype": "PC", "os": "Win32",
            "canvas": "0", "webGL": "0", "webGLMeta": "0",
            "audioContext": "0", "mediaDevice": "0",
            "hardwareConcurrency": "8", "deviceMemory": "8",
            "doNotTrack": "1", "clientRectNoiseEnabled": True,
            "reType": "0", "fontType": "2",
            "openWidth": 1440, "openHeight": 900,
        }
    }
    r = api_call("POST", "/browser/update", data)
    if r and r.get("success"): return r["data"]["id"], r["data"]["seq"]
    return None, None

def open_browser(bid):
    r = api_call("POST", "/browser/open", {"id": bid}, timeout=60)
    if r and r.get("success"):
        return r["data"]["http"], r["data"]["driver"]
    return None, None

def close_browser(bid): api_call("POST", "/browser/close", {"id": bid})
def delete_browser(bid): api_call("POST", "/browser/delete", {"id": bid})


# ========== 5SIM ==========
class Sim5:
    B = "https://5sim.net/v1"
    def __init__(self, k):
        self.s = _req.Session()
        self.s.headers.update({"": f"Bearer {k}", "Accept": "application/json"})
    def _g(self, p, pr=None, to=20):
        r = self.s.get(f"{self.B}{p}", params=pr, timeout=to)
        return r.json() if r.status_code < 400 else None
    def bal(self):
        d = self._g("/user/profile")
        return d.get("balance", 0) if d else 0
    def buy(self, c="indonesia"):
        d = self._g(f"/user/buy/activation/{c}/any/google")
        return {"id": d["id"], "phone": d.get("phone", ""), "price": d.get("price", 0)} if (d and d.get("id")) else None
    def chk(self, oid):
        d = self._g(f"/user/check/{oid}")
        if not d: return {"s": "ERROR"}
        sms = d.get("sms", [])
        s = d.get("status", "PENDING")
        if sms and sms[0].get("code"):
            c = sms[0]["code"]
            m = re.search(r'\d{4,8}', c)
            return {"s": "RECEIVED", "code": m.group(0) if m else c}
        if s == "RECEIVED":
            cd = d.get("code") or d.get("sms_code")
            if cd: return {"s": "RECEIVED", "code": str(cd)}
        return {"s": s}
    def wait(self, oid, timeout=180, iv=3):
        st = time.time()
        while time.time() - st < timeout:
            r = self.chk(oid)
            if r["s"] == "RECEIVED" and r.get("code"):
                log(f"  [5sim] {r['code']} ({int(time.time()-st)}s)")
                return r["code"]
            if r["s"] in ("CANCELED", "TIMEOUT", "BANNED", "ERROR"):
                log(f"  [5sim] {r['s']}")
                return None
            time.sleep(iv)
        return None
    def cancel(self, oid): self._g(f"/user/cancel/{oid}")
    def finish(self, oid): self._g(f"/user/finish/{oid}")


def slow_type(element, text, min_delay=40, max_delay=120):
    for char in text:
        element.send_keys(char)
        time.sleep(random.uniform(min_delay/1000, max_delay/1000))


def click_button_by_text(driver, texts, timeout=5):
    for txt in texts:
        try:
            driver.execute_script(f"""
                const btns = 'button, span[role="button"]');
                for (const b of btns) {{
                    if (b.textContent.includes("{txt}")) {{ b.click(); break; }}
                }}
            """)
            return True
        except: pass
    return False


def do_(attempt_num):
    f_name, l_name = random.choice(FIRST), random.choice(LAST)
    uname = f"{f_name.lower()}{l_name.lower()}{random.randint(100,9999)}"
    pw = (random.choice(string.ascii_uppercase) + 
          "".join(random.choices(string.ascii_lowercase, k=6)) + 
          "".join(random.choices(string.digits, k=4)) + "!")
    yr, mo, dy = random.randint(1985, 2000), random.randint(1, 12), random.randint(1, 28)
    g = random.choice(["Male", "Female"])
    email = f"{uname}@gmail.com"
    ma = ["","jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"]
    mf = ["","January","February","March","April","May","June","July","August","September","October","November","December"]
    
    log(f"\n{'='*50}")
    log(f"STEALTH #{attempt_num} | {email} | {mf[mo]} {dy}, {yr} | {g}")
    log(f"{'='*50}")
    
    browser_id = None
    driver = None
    try:
        browser_id, seq = create_profile(f"Gmail-ST-{uname}")
        if not browser_id:
            log("  Failed to create profile")
            return None
        
        http_ep, driver_path = open_browser(browser_id)
        if not http_ep:
            log("  Failed to open")
            delete_browser(browser_id)
            return None
        
        log(f"  Connecting to {http_ep}...")
        options = Options()
        options.debugger_address = http_ep
        service = Service(executable_path=driver_path)
        driver = webdriver.Chrome(service=service, options=options)
        log(f"  ✓ Connected: {driver.title[:50]}")
        
        # ===== CRITICAL: Inject anti-detection BEFORE any page =====
        driver.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {
            "source": ANTI_DETECTION_JS
        })
        log("  ✓ Anti-detection JS injected (pre-page level)")
        
        # ========== STEP 1: Signup ==========
        log("[1] Opening Gmail signup...")
        driver.get(
            "https://.google.com/signup/v2/webcreateaccount?hl=en&flowName=GlifWebSignIn&flowEntry=SignUp"
        )
        time.sleep(5)
        log(f"    URL: {driver.current_url[:80]}")
        
        # Verify navigator.webdriver
        wd = driver.execute_script("return navigator.webdriver")
        log(f"    navigator.webdriver: {wd}")
        
        # ========== STEP 2: Name ==========
        log(f"[2] Name: {f_name} {l_name}")
        try:
            fn = WebDriverWait(driver, 10).until(
                EC.element_to_be_clickable((By.CSS_SELECTOR, '"firstName"]'))
            )
            fn.click(); time.sleep(0.2)
            slow_type(fn, f_name)
        except Exception as e:
            log(f"    FN error: {e}")
        
        try:
            ln = driver.find_element(By.CSS_SELECTOR, '"lastName"]')
            ln.click(); time.sleep(0.2)
            slow_type(ln, l_name)
        except Exception as e:
            log(f"    LN error: {e}")
        
        time.sleep(random.uniform(1, 2))
        click_button_by_text(driver, ["Next"])
        time.sleep(6)
        
        url = driver.current_url.lower()
        log(f"    URL: {driver.current_url[:100]}")
        
        if "gender" in url:
            if "tl=" in url or "TL=" in url:
                log("    ❌ Anti-bot detection (TL=)")
                return None
            # else: normal  page
        else:
            log("    ⚠ Unexpected redirect")
        
        # ========== STEP 3: Birthday ==========
        log(f"[3] Birthday: {mf[mo]} {dy}, {yr} | {g}")
        
        # Google uses custom Material Design — fill via JS directly
        driver.execute_script(f"""
            (() => {{
                // All possible month inputs
                const setEl = (el, val) => {{
                    if (!el) return;
                    el.focus();
                    el.value = val;
                    el.dispatchEvent(new Event('input', {{bubbles: true}}));
                    el.dispatchEvent(new Event('change', {{bubbles: true}}));
                    el.dispatchEvent(new KeyboardEvent('keyup', {{bubbles: true}}));
                }};
                
                // Month - try select first, then input
                const mSel = document.querySelector('select[name="month"]');
                if (mSel) {{ mSel.value = '{mo}'; mSel.dispatchEvent(new Event('change', {{bubbles: true}})); }}
                setEl(document.querySelector('"month"]'), '{ma[mo]}');
                
                // Day
                const dSel = document.querySelector('select[name="day"]');
                if (dSel) {{ dSel.value = '{dy}'; dSel.dispatchEvent(new Event('change', {{bubbles: true}})); }}
                setEl(document.querySelector('"day"]'), '{dy}');
                
                // Year
                const ySel = document.querySelector('select[name="year"]');
                if (ySel) {{ ySel.value = '{yr}'; ySel.dispatchEvent(new Event('change', {{bubbles: true}})); }}
                setEl(document.querySelector('"year"]'), '{yr}');
                
                // Gender
                const gSel = document.querySelector('select[name="gender"]');
                if (gSel) {{ gSel.value = '{1 if g=="Male" else 2}'; gSel.dispatchEvent(new Event('change', {{bubbles: true}})); }}
                setEl(document.querySelector('"gender"]'), '{g}');
            }})()
        """)
        time.sleep(1.5)
        
        click_button_by_text(driver, ["Next"])
        time.sleep(6)
        
        url = driver.current_url.lower()
        log(f"    URL: {driver.current_url[:100]}")
        
        if "gender" in url:
            log("    ❌ Anti-bot after ")
            return None
        
        log("    ✓ Birthday accepted!")
        
        # ========== STEP 4: Username ==========
        log(f"[4] Username: {uname}")
        try:
            click_button_by_text(driver, ["Create your own"])
            time.sleep(2)
        except: pass
        
        try:
            un = driver.find_element(By.CSS_SELECTOR, '"Username"]')
            un.click(); time.sleep(0.3)
            slow_type(un, uname)
        except Exception as e:
            log(f"    UN error: {e}")
        
        time.sleep(0.5)
        click_button_by_text(driver, ["Next"])
        time.sleep(6)
        
        url = driver.current_url.lower()
        log(f"    URL: {driver.current_url[:100]}")
        
        if "gender" in url:
            log("    ❌ Anti-bot after ")
            return None
        if any(k in url for k in ["unavailable", "taken"]):
            log("    ⚠ Username taken")
            return None
        
        log("    ✓ Username accepted!")
        
        # ========== STEP 5:  ==========
        log("[5] ")
        pws = driver.find_elements(By.CSS_SELECTOR, '""]')
        if len(pws) >= 2:
            slow_type(pws[0], pw)
            slow_type(pws[1], pw)
        elif len(pws) == 1:
            slow_type(pws[0], pw)
        
        time.sleep(0.5)
        click_button_by_text(driver, ["Next"])
        time.sleep(5)
        
        # ========== STEP 6-7: Post- ==========
        url = driver.current_url.lower()
        log(f"[6] URL: {driver.current_url[:100]}")
        
        if any(k in url for k in ["", "mail.google", "welcome"]):
            log("🎉 ACCOUNT CREATED!")
            return save(email, uname, pw)
        
        # Terms
        for lbl in ["I agree", "Agree"]:
            click_button_by_text(driver, [lbl])
            time.sleep(2)
        
        # Skip recovery
        for lbl in ["Skip", "Not now", "I prefer"]:
            click_button_by_text(driver, [lbl])
            time.sleep(2)
        
        click_button_by_text(driver, ["Next"])
        time.sleep(5)
        
        url = driver.current_url.lower()
        log(f"[7] URL: {driver.current_url[:100]}")
        
        if any(k in url for k in ["", "mail.google", "welcome"]):
            log("🎉 ACCOUNT CREATED!")
            return save(email, uname, pw)
        
        # Phone verification
        try: body_text = driver.find_element(By.TAG_NAME, "body").text.lower()
        except: body_text = ""
        
        if any(k in body_text for k in ["verify", "phone", "number"]):
            log("[7] Phone verification")
            sim5 = Sim5(FIVESIM_KEY)
            if sim5.bal() < 1.0: return None
            
            order = sim5.buy()
            if not order: return None
            
            log(f"    +{order['phone']} ({order['price']}RUB)")
            try:
                pi = driver.find_element(By.CSS_SELECTOR, '"tel"],"phoneNumber"]')
                pi.click()
                slow_type(pi, order["phone"])
            except: pass
            
            time.sleep(0.5)
            click_button_by_text(driver, ["Next"])
            time.sleep(4)
            
            code = sim5.wait(order["id"])
            if code:
                log(f"    CODE: {code}")
                try:
                    ci = driver.find_element(By.CSS_SELECTOR, '"hidden"""])')
                    ci.click()
                    slow_type(ci, code, min_delay=20, max_delay=60)
                except: pass
                
                click_button_by_text(driver, ["Next", "Verify"])
                time.sleep(5)
                
                url = driver.current_url.lower()
                try: body_text = driver.find_element(By.TAG_NAME, "body").text.lower()
                except: body_text = ""
                
                if "" in body_text:
                    sim5.cancel(order["id"])
                elif any(k in url for k in ["", "welcome", "mail.google"]):
                    sim5.finish(order["id"])
                    log("🎉 ACCOUNT CREATED!")
                    return save(email, uname, pw)
                else:
                    sim5.cancel(order["id"])
            else:
                sim5.cancel(order["id"])
        
        url = driver.current_url.lower()
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
        if driver:
            try: driver.quit()
            except: pass
        if browser_id:
            try: close_browser(browser_id)
            except: pass
            try: delete_browser(browser_id)
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


def main():
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    sim5 = Sim5(FIVESIM_KEY)
    log(f"\n{'='*50}")
    log(f"SELENIUM + BITBROWSER + CDP ANTI-DETECTION")
    log(f"5sim: {sim5.bal()}RUB")
    log(f"Strategy: Page.addScriptToEvaluateOnNewDocument injection")
    log(f"{'='*50}")
    
    results = []
    for i in range(1, count + 1):
        r = do_(i)
        if r: results.append(r); log(f"SUCCESS: {r['email']}")
        else: log(f"FAILED")
        log(f"Progress: {len(results)}/{i}")
        if i < count:
            wait = random.randint(12, 20)
            log(f"  Cooling {wait}s...")
            time.sleep(wait)
    
    log(f"\n{'='*50}")
    log(f"DONE: {len(results)}/{count}")
    for r in results: log(f"  {r['email']} | {r['']}")
    log(f"{'='*50}")


if __name__ == "__main__":
    main()
