# -*- coding: utf-8 -*-
"""
_gmail_bitbrowser_selenium.py
BITBROWSER + NATIVE SELENIUM WEBDRIVER (NO PLAYWRIGHT, NO CDP INJECTION)

Key: Uses BitBrowser's native chromedriver + Selenium to control the real Chrome
without Playwright's detectable CDP hooks (__playwright__, etc.).
"""
import json, os, random, re, string, sys, time, traceback
from datetime import datetime

if sys. == "win32":
    try: sys.stdout.reconfigure(encoding="utf-8")
    except: pass

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait, Select
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.common.exceptions import TimeoutException, NoSuchElementException

ROOT = os.path.dirname(os.path.abspath(__file__))
SS = os.path.join(ROOT, "gmail-data", "screenshots")
ACCOUNTS = os.path.join(ROOT, "gmail-data", ".json")
for d in [SS]: os.makedirs(d, exist_ok=True)

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


def create_browser_profile(name):
    data = {
        "name": name,
        "": "https://.google.com",
        "Icon": ".google.com",
        "url": "https://.google.com/signup",
        "remark": f"Gmail-Selenium {datetime.now():%H:%M}",
        "proxyMethod": 2,
        "proxyType": "http",
        "host": PROXY_HOST,
        "port": PROXY_PORT,
        "browserFingerPrint": {
            "coreVersion": "124",
            "ostype": "PC",
            "os": "Win32",
            "userAgent": "",
            "canvas": "0",
            "webGL": "0",
            "webGLMeta": "0",
            "audioContext": "0",
            "mediaDevice": "0",
            "hardwareConcurrency": "8",
            "deviceMemory": "8",
            "doNotTrack": "1",
            "clientRectNoiseEnabled": True,
            "reType": "0",
            "fontType": "2",
            "openWidth": 1440,
            "openHeight": 900,
        }
    }
    result = api_call("POST", "/browser/update", data, timeout=20)
    if result and result.get("success"):
        bid = result.get("data", {}).get("id")
        log(f"  Created profile: {bid[:16] if bid else '?'}...")
        return bid
    return None


def open_browser(browser_id):
    """Open browser and get debug address + driver path."""
    result = api_call("POST", "/browser/open", {"id": browser_id}, timeout=60)
    if result and result.get("success"):
        http = result["data"]["http"]
        driver = result["data"]["driver"]
        ws = result["data"]["ws"]
        log(f"  Opened: {http} | driver: ...\\chromedriver.exe")
        return http, driver
    return None, None


def close_browser(browser_id):
    api_call("POST", "/browser/close", {"id": browser_id})


def delete_browser(browser_id):
    api_call("POST", "/browser/delete", {"id": browser_id})


def screenshot(driver, name):
    try:
        p = os.path.join(SS, f"{name}_{datetime.now():%H%M%S}.png")
        driver.save_screenshot(p)
        log(f"  📸 {name}")
    except: pass


def wait_for_any(driver, selectors, timeout=15):
    """Wait for any of the given CSS selectors to appear."""
    end = time.time()
    while time.time() - end < timeout:
        for sel in selectors:
            try:
                el = driver.find_element(By.CSS_SELECTOR, sel)
                if el.is_displayed():
                    return el, sel
            except: pass
        time.sleep(0.3)
    return None, None


def click_button(driver, texts, timeout=8):
    """Click a button matching any of the given texts."""
    for txt in texts:
        try:
            btn = WebDriverWait(driver, timeout).until(
                EC.element_to_be_clickable((By.XPATH, f'//button[contains(text(),"{txt}")] | //span[contains(text(),"{txt}")]'))
            )
            btn.click()
            return True
        except: pass
    return False


def slow_type(element, text, min_delay=30, max_delay=120):
    """Type text with human-like delays."""
    for char in text:
        element.send_keys(char)
        time.sleep(random.uniform(min_delay/1000, max_delay/1000))


def do_(attempt_num):
    f_name, l_name = random.choice(FIRST), random.choice(LAST)
    uname = f"{f_name.lower()}{l_name.lower()}{random.randint(100,9999)}"
    pw = (random.choice(string.ascii_uppercase) + 
          "".join(random.choices(string.ascii_lowercase, k=6)) + 
          "".join(random.choices(string.digits, k=4)) + "!")
    yr, mo, dy = random.randint(1985, 2000), random.randint(1, 12), random.randint(1, 28)
    g = random.choice(["Male", "Female"])
    email = f"{uname}@gmail.com"
    ma = ["", "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
    mf = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

    log(f"\n{'='*50}")
    log(f"SELENIUM #{attempt_num} | {email} | {mf[mo]} {dy}, {yr} | {g}")
    log(f"{'='*50}")

    browser_id = None
    driver = None
    try:
        # 1. Create profile
        browser_id = create_browser_profile(f"Gmail-Se-{uname}")
        if not browser_id:
            log("  Failed to create profile")
            return None

        # 2. Open browser via BitBrowser API
        http_endpoint, driver_path = open_browser(browser_id)
        if not http_endpoint:
            log("  Failed to open browser")
            delete_browser(browser_id)
            return None

        # 3. Connect via Selenium (NATIVE chromedriver - NO Playwright/CDP!)
        log(f"  Connecting Selenium to {http_endpoint}...")
        options = Options()
        options.debugger_address = http_endpoint
        # NOTE: BitBrowser's Chrome already has anti-detection fingerprinting.
        # No need for excludeSwitches — that's only for fresh Chrome launches.
        
        service = Service(executable_path=driver_path)
        driver = webdriver.Chrome(service=service, options=options)
        log(f"  ✓ Selenium connected! Title: {driver.title[:60]}")

        # ========== STEP 1: Navigate to Google Signup ==========
        log("[1] Opening Gmail signup...")
        driver.get(
            "https://.google.com/signup/v2/webcreateaccount?hl=en&flowName=GlifWebSignIn&flowEntry=SignUp"
        )
        time.sleep(5)
        log(f"    URL: {driver.current_url[:80]}")

        # ========== STEP 2: Name ==========
        log(f"[2] Name: {f_name} {l_name}")
        try:
            fn = WebDriverWait(driver, 10).until(
                EC.element_to_be_clickable((By.CSS_SELECTOR, '"firstName"]'))
            )
            fn.click(); time.sleep(0.3)
            slow_type(fn, f_name)
            time.sleep(random.uniform(0.3, 0.6))
        except Exception as e:
            log(f"    First name error: {e}")
        
        try:
            ln = driver.find_element(By.CSS_SELECTOR, '"lastName"]')
            ln.click(); time.sleep(0.3)
            slow_type(ln, l_name)
            time.sleep(random.uniform(0.3, 0.6))
        except Exception as e:
            log(f"    Last name error: {e}")

        # Click Next
        click_button(driver, ["Next"])
        time.sleep(6)

        # ========== STEP 3: Birthday & Gender ==========
        log(f"[3] Birthday: {mf[mo]} {dy}, {yr} | {g}")
        
        # Strategy: Use Selenium's native Select for dropdowns, keyboard for inputs
        month_name = mf[mo]  # "March"
        month_abbr = month_name[:3]  # "Mar"
        
        # --- YEAR ---
        try:
            yr_sel = driver.find_element(By.CSS_SELECTOR, 'select[name="year"]')
            Select(yr_sel).select_by_visible_text(str(yr))
        except:
            try:
                yr_inp = driver.find_element(By.CSS_SELECTOR, '"year"]')
                yr_inp.click(); time.sleep(0.2)
                yr_inp.clear()
                slow_type(yr_inp, str(yr))
            except: pass
        
        # --- MONTH ---  
        try:
            mo_sel = driver.find_element(By.CSS_SELECTOR, 'select[name="month"]')
            Select(mo_sel).select_by_visible_text(month_name)
        except:
            try:
                mo_inp = driver.find_element(By.CSS_SELECTOR, 'input[aria-label*="Month" i]')
                mo_inp.click(); time.sleep(0.3)
                mo_inp.clear()
                slow_type(mo_inp, month_abbr)
            except: pass
        
        # --- DAY ---
        try:
            day_sel = driver.find_element(By.CSS_SELECTOR, 'select[name="day"]')
            Select(day_sel).select_by_visible_text(str(dy))
        except:
            try:
                day_inp = driver.find_element(By.CSS_SELECTOR, '"day"]')
                day_inp.click(); time.sleep(0.2)
                day_inp.clear()
                slow_type(day_inp, str(dy))
            except: pass
        
        # --- GENDER ---
        try:
            gen_sel = driver.find_element(By.CSS_SELECTOR, 'select[name="gender"]')
            Select(gen_sel).select_by_visible_text(g)
        except:
            try:
                gen_inp = driver.find_element(By.CSS_SELECTOR, 'input[aria-label*="Gender" i]')
                gen_inp.click(); time.sleep(0.3)
                gen_inp.clear()
                slow_type(gen_inp, g[:1])  # "M" or "F"
            except: pass

        # Try click Next
        click_button(driver, ["Next"])
        time.sleep(6)

        curl = driver.current_url.lower()
        log(f"    URL: {driver.current_url[:100]}")

        # ========== CHECK: Birthday redirect ==========
        if "gender" in curl:
            log("    ❌ Anti-bot detection —  redirect")
            screenshot(driver, "fail_bitbrowser_se")
            return None

        log("    ✓ Birthday accepted!")

        # ========== STEP 4: Username ==========
        log(f"[4] Username: {uname}")
        try:
            # Click "Create your own Gmail address"
            click_button(driver, ["Create your own"])
            time.sleep(2)
        except: pass

        try:
            user_inp = WebDriverWait(driver, 10).until(
                EC.element_to_be_clickable((By.CSS_SELECTOR, '"Username"]'))
            )
            user_inp.click(); time.sleep(0.5)
            slow_type(user_inp, uname)
        except Exception as e:
            log(f"    Username input error: {e}")

        time.sleep(1)
        click_button(driver, ["Next"])
        time.sleep(6)

        curl = driver.current_url.lower()
        log(f"    URL: {driver.current_url[:100]}")
        
        if "gender" in curl:
            log("    ❌ Anti-bot after ")
            screenshot(driver, "fail__se")
            return None

        if any(k in curl for k in ["unavailable", "taken"]):
            log("    ⚠ Username taken, retry with new name")
            return None

        log("    ✓ Username accepted!")

        # ========== STEP 5:  ==========
        log("[5] ")
        try:
            pw_inputs = WebDriverWait(driver, 10).until(
                lambda d: d.find_elements(By.CSS_SELECTOR, '""]')
            )
            if len(pw_inputs) >= 2:
                slow_type(pw_inputs[0], pw)
                slow_type(pw_inputs[1], pw)
            elif len(pw_inputs) == 1:
                slow_type(pw_inputs[0], pw)
            log(f"     filled ({len(pw_inputs)} fields)")
        except Exception as e:
            log(f"     error: {e}")

        time.sleep(0.5)
        click_button(driver, ["Next"])
        time.sleep(5)

        # ========== STEP 6: Terms / Skip ==========
        curl = driver.current_url.lower()
        log(f"[6] URL: {driver.current_url[:100]}")
        
        # Check if already done
        if any(k in curl for k in ["", "mail.google", "welcome"]):
            log("🎉 ACCOUNT CREATED! (after )")
            screenshot(driver, "success_se")
            return save(email, uname, pw)

        # Handle Terms
        for btn_text in ["I agree", "Agree", "Accept"]:
            if click_button(driver, [btn_text]):
                time.sleep(3)
                break

        # Handle Skip/Recovery
        for btn_text in ["Skip", "Not now", "Skip for now", "I prefer"]:
            if click_button(driver, [btn_text]):
                time.sleep(3)
                break

        # Click Next if present
        click_button(driver, ["Next"])
        time.sleep(5)

        # ========== STEP 7: Check success or phone verification ==========
        curl = driver.current_url.lower()
        body_text = ""
        try: body_text = driver.find_element(By.TAG_NAME, "body").text.lower()
        except: pass

        log(f"[7] URL: {driver.current_url[:100]}")
        
        if any(k in curl for k in ["", "mail.google", "welcome"]):
            log("🎉 ACCOUNT CREATED!")
            screenshot(driver, "success_se")
            return save(email, uname, pw)

        # Handle phone verification
        if any(k in body_text for k in ["verify", "phone", "number", "confirm"]):
            log("[7] Phone verification needed")
            sim5 = Sim5(FIVESIM_KEY)
            bal = sim5.bal()
            log(f"    5sim balance: {bal}RUB")
            if bal < 1.0:
                log("    Insufficient balance")
                return None
            
            order = sim5.buy()
            if not order:
                log("    Failed to buy number")
                return None
            
            log(f"    +{order['phone']} ({order['price']}RUB)")
            
            try:
                phone_inp = WebDriverWait(driver, 10).until(
                    EC.element_to_be_clickable((By.CSS_SELECTOR, '"tel"], "phoneNumber"]'))
                )
                phone_inp.click(); time.sleep(0.3)
                phone_inp.clear()
                slow_type(phone_inp, order["phone"])
            except Exception as e:
                log(f"    Phone input error: {e}")
                sim5.cancel(order["id"])
                return None

            time.sleep(1)
            click_button(driver, ["Next"])
            time.sleep(4)

            code = sim5.wait(order["id"])
            if code:
                log(f"    CODE: {code}")
                try:
                    code_inp = driver.find_element(By.CSS_SELECTOR, 
                        '"hidden"""""])')
                    code_inp.click(); time.sleep(0.2)
                    slow_type(code_inp, code)
                except: pass

                click_button(driver, ["Next", "Verify"])
                time.sleep(5)

                curl = driver.current_url.lower()
                try: body_text = driver.find_element(By.TAG_NAME, "body").text.lower()
                except: body_text = ""

                if "" in body_text:
                    sim5.cancel(order["id"])
                elif any(k in curl for k in ["", "welcome", "mail.google"]):
                    sim5.finish(order["id"])
                    log("🎉 ACCOUNT CREATED WITH PHONE!")
                    screenshot(driver, "success_se")
                    return save(email, uname, pw)
                else:
                    sim5.cancel(order["id"])
            else:
                sim5.cancel(order["id"])

        # Final check
        curl = driver.current_url.lower()
        if any(k in curl for k in ["", "mail.google", "welcome"]):
            log("🎉 ACCOUNT CREATED!")
            return save(email, uname, pw)

        log("End of flow — no success condition met")
        screenshot(driver, "end_no_success_se")
        return None

    except Exception as e:
        log(f"Error: {e}")
        traceback.print_exc()
        if driver:
            try: screenshot(driver, f"error_{attempt_num}")
            except: pass
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
            with open(ACCOUNTS, "r", encoding="utf-8") as f:
                a = json.load(f)
        except: a = []
    a.append(d)
    with open(ACCOUNTS, "w", encoding="utf-8") as f:
        json.dump(a, f, indent=2)
    log(f"  Saved: {email}")
    return d


def main():
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    sim5 = Sim5(FIVESIM_KEY)
    log(f"\n{'='*50}")
    log(f"BITBROWSER + SELENIUM GMAIL REGISTRATOR")
    log(f"5sim: {sim5.bal()}RUB")
    log(f"Strategy: Native chromedriver (no Playwright/CDP)")
    log(f"{'='*50}")

    results = []
    for i in range(1, count + 1):
        r = do_(i)
        if r:
            results.append(r)
            log(f"SUCCESS: {r['email']}")
        else:
            log(f"FAILED")
        log(f"Progress: {len(results)}/{i}")
        if i < count:
            wait = random.randint(8, 15)
            log(f"  Cooling down {wait}s...")
            time.sleep(wait)

    log(f"\n{'='*50}")
    log(f"DONE: {len(results)}/{count}  created")
    for r in results:
        log(f"  {r['email']} | {r['']}")
    log(f"{'='*50}")


if __name__ == "__main__":
    main()
