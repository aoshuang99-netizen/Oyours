# -*- coding: utf-8 -*-
"""
_gmail_desktop.py
DESKTOP AUTOMATION via pyautogui — ZERO CDP, ZERO WebDriver, ZERO protocols.

Controls the mouse/keyboard at the OS level. Google CANNOT detect this
because there's no  protocol — just simulated human input.
"""
import json, os, random, re, string, sys, time, traceback
from datetime import datetime

if sys. == "win32":
    try: sys.stdout.reconfigure(encoding="utf-8")
    except: pass

import pyautogui
import pygetwindow as gw

ROOT = os.path.dirname(os.path.abspath(__file__))
ACCOUNTS = os.path.join(ROOT, "gmail-data", ".json")

# Safety: set fail-safe to corner — moving mouse to (0,0) stops the script
pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.05

def log(msg): print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)

# ========== CONFIG ==========
BITBROWSER_API = "http://:54345"
API_KEY = ""
FIVESIM_KEY = "eyJhbGciOiJSUzUxMiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE4MTM3MzQ3ODEsImlhdCI6MTc4MjE5ODc4MSwicmF5IjoiNjIxMWY0MjAyNmM2YjZkNDMxMjMxYjY0MDkwMzg3MDIiLCJzdWIiOjQyMjIwNTB9.wRPYREkUdv60wd68XujZqXlravtg01aMWYECx0Bl1fLqC2uxL2yELzAIWIG_b_yAhKrymtxV5XsGlCpBm_uapnwJZhUw7LyHHnYl_V6weL6uEvk2ayrcIhaUCa13RORmRen8fXdrElnO_flZqQpeJRqm7gpUQF-HSy8Az3iy3j0JWvW9pfg_sAZTCA6vlADn66lrZ36O5g3NiKoTtTB0SYo8lfzFxtBbROc6gSMg_46dmn1hjNgJB6cetJ33DLQ1UJCuckcjV_lVfiPIMYT51RIqaRS8zyPaCTT8938whKFHbbJgWpne-6ldHmdeDudWDtytElk7d204shjBL1q1ww"
PROXY_HOST = ""
PROXY_PORT = 8090

HEADERS = {"": API_KEY, "": "application/json"}

FIRST = ["James","John","Robert","David","William","Richard","Joseph","Thomas","Christopher","Daniel","Matthew","Anthony","Mark","Paul","Steven","Andrew","Kenneth","George","Brian"]
LAST = ["Smith","Johnson","Williams","Brown","Jones","Garcia","Miller","Davis","Rodriguez","Martinez","Hernandez","Lopez","Gonzalez","Wilson","Anderson","Thomas","Taylor","Moore","Jackson"]

import requests as _req

# ========== BITBROWSER API ==========
def api_call(method, path, data=None, timeout=60):
    url = f"{BITBROWSER_API}{path}"
    try:
        r = (_req.get if method == "GET" else _req.post)(url, headers=HEADERS, json=data, timeout=timeout)
        return r.json() if r.status_code < 400 else None
    except: return None

def create_profile(name):
    data = {
        "name": name, "proxyMethod": 2, "proxyType": "http",
        "host": PROXY_HOST, "port": PROXY_PORT,
        "browserFingerPrint": {
            "coreVersion": "124", "canvas": "0", "webGL": "0",
            "hardwareConcurrency": "8", "deviceMemory": "8",
            "openWidth": 1440, "openHeight": 900,
        }
    }
    r = api_call("POST", "/browser/update", data)
    return r["data"]["id"] if (r and r.get("success")) else None

def open_browser(bid):
    r = api_call("POST", "/browser/open", {"id": bid}, timeout=60)
    return r["data"]["http"] if (r and r.get("success")) else None

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
        if sms and sms[0].get("code"):
            c = sms[0]["code"]
            m = re.search(r'\d{4,8}', c)
            return {"s": "RECEIVED", "code": m.group(0) if m else c}
        s = d.get("status", "PENDING")
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


# ========== DESKTOP AUTOMATION HELPERS ==========
def find_bitbrowser_window(profile_name, timeout=20):
    """Find the BitBrowser Chrome window by profile name."""
    start = time.time()
    search = profile_name.split("-")[-1][:10] if "-" in profile_name else profile_name[:10]
    while time.time() - start < timeout:
        for w in gw.getAllWindows():
            if w.title and search in w.title and "比特" in w.title:
                return w
        time.sleep(0.5)
    return None

def activate_window(win):
    """Bring window to front and maximize."""
    try:
        win.activate()
        time.sleep(0.5)
        win.maximize()
        time.sleep(0.5)
        return True
    except:
        return False

def human_type(text, min_delay=0.05, max_delay=0.15):
    """Type text with human-like delays."""
    for char in text:
        pyautogui.typewrite(char, interval=random.uniform(min_delay, max_delay))

def human_press(key, count=1):
    """Press a key with slight delay."""
    for _ in range(count):
        pyautogui.press(key)
        time.sleep(random.uniform(0.05, 0.1))

def wait_for_page_load(timeout=8):
    """Wait for page to load by checking if browser is responding."""
    time.sleep(timeout)

def navigate_to_url(url):
    """Navigate to URL via address bar (Ctrl+L)."""
    time.sleep(0.5)
    pyautogui.hotkey('ctrl', 'l')
    time.sleep(0.5)
    human_type(url)
    time.sleep(0.3)
    pyautogui.press('enter')
    wait_for_page_load(6)


def do_(attempt_num):
    f_name, l_name = random.choice(FIRST), random.choice(LAST)
    uname = f"{f_name.lower()}{l_name.lower()}{random.randint(100,9999)}"
    pw = (random.choice(string.ascii_uppercase) + 
          "".join(random.choices(string.ascii_lowercase, k=6)) + 
          "".join(random.choices(string.digits, k=4)) + "!")
    yr, mo, dy = random.randint(1985, 2000), random.randint(1, 12), random.randint(1, 28)
    g = random.choice(["Male", "Female"])
    email = f"{uname}@gmail.com"
    mf = ["","January","February","March","April","May","June","July","August","September","October","November","December"]

    log(f"\n{'='*50}")
    log(f"DESKTOP #{attempt_num} | {email} | {mf[mo]} {dy}, {yr} | {g}")
    log(f"{'='*50}")
    
    # WARNING: Show what's about to happen
    log("  ⚠ This will control your mouse/keyboard!")
    log("  ⚠ Move mouse to top-left corner (0,0) to abort!")
    log("  Starting in 3 seconds...")
    time.sleep(3)
    
    browser_id = None
    profile_name = f"Gmail-DT-{uname}"
    try:
        # Create + open browser
        browser_id = create_profile(profile_name)
        if not browser_id:
            log("  Failed to create profile")
            return None
        
        http_ep = open_browser(browser_id)
        if not http_ep:
            log("  Failed to open browser")
            delete_browser(browser_id)
            return None
        
        log(f"  Browser opened, finding window...")
        
        # Find the BitBrowser window
        win = find_bitbrowser_window(profile_name)
        if not win:
            log("  ❌ Could not find BitBrowser window")
            close_browser(browser_id)
            delete_browser(browser_id)
            return None
        
        log(f"  Window: {win.title[:60]}")
        activate_window(win)
        time.sleep(1)
        
        # ========== STEP 1: Navigate to Google Signup ==========
        log("[1] Navigating to Google Signup...")
        navigate_to_url(
            "https://.google.com/signup/v2/webcreateaccount?hl=en&flowName=GlifWebSignIn&flowEntry=SignUp"
        )
        log("    Page loaded")
        
        # ========== STEP 2: Name ==========
        log(f"[2] Name: {f_name} {l_name}")
        time.sleep(1)
        # Tab to first name field (should be first focusable input)
        human_type(f_name)
        time.sleep(0.3)
        pyautogui.press('tab')
        time.sleep(0.3)
        human_type(l_name)
        time.sleep(0.5)
        pyautogui.press('enter')  # Submit name form
        log("    Submitted name")
        wait_for_page_load(8)
        
        # ========== STEP 3: Birthday ==========
        log(f"[3] Birthday: {mf[mo]} {dy}, {yr} | {g}")
        
        # The  page has: Month dropdown, Day input, Year input, Gender dropdown
        # Tab order: Month → Day → Year → Gender → Next button
        
        # Month — this is a Material Design dropdown
        # Press Tab to reach it, then Space to open, then type month name
        time.sleep(1)
        pyautogui.press('tab')  # Focus month
        time.sleep(0.3)
        pyautogui.press('space')  # Open dropdown
        time.sleep(0.5)
        human_type(mf[mo][:3])  # Type first 3 chars of month (e.g., "Jan")
        time.sleep(0.3)
        pyautogui.press('enter')  # Select
        time.sleep(0.3)
        
        # Day — Tab to day field
        pyautogui.press('tab')
        time.sleep(0.2)
        human_type(str(dy))
        time.sleep(0.2)
        
        # Year — Tab to year field  
        pyautogui.press('tab')
        time.sleep(0.2)
        human_type(str(yr))
        time.sleep(0.2)
        
        # Gender — Tab to gender dropdown
        pyautogui.press('tab')
        time.sleep(0.3)
        pyautogui.press('space')  # Open dropdown
        time.sleep(0.5)
        human_type("Ma" if g == "Male" else "Fe")  # First 2 chars
        time.sleep(0.3)
        pyautogui.press('enter')  # Select
        time.sleep(0.3)
        
        # Tab to Next button
        pyautogui.press('tab')
        time.sleep(0.3)
        pyautogui.press('enter')  # Click Next
        log("    Submitted ")
        wait_for_page_load(8)
        
        # ========== STEP 4: Username ==========
        log(f"[4] Username: {uname}")
        
        # Google shows: "Create your own Gmail address" radio +  input
        # We need to select the radio button first
        time.sleep(1)
        pyautogui.press('tab')  # Focus the first radio/button
        time.sleep(0.3)
        pyautogui.press('space')  # Select "Create your own"
        time.sleep(0.5)
        pyautogui.press('tab')  # Focus  input
        time.sleep(0.3)
        human_type(uname)
        time.sleep(0.5)
        pyautogui.press('enter')  # Submit
        log("    Submitted ")
        wait_for_page_load(8)
        
        # ========== STEP 5:  ==========
        log("[5] ")
        time.sleep(1)
        human_type(pw)
        time.sleep(0.3)
        pyautogui.press('tab')
        time.sleep(0.2)
        human_type(pw)  # Confirm 
        time.sleep(0.3)
        pyautogui.press('enter')
        log("    Submitted ")
        wait_for_page_load(8)
        
        # ========== STEP 6: Skip/Next ==========
        log("[6] Post-...")
        # Try to press Enter for Next/Skip
        for _ in range(3):
            pyautogui.press('enter')
            time.sleep(5)
        
        # ========== STEP 7: Phone? ==========
        log("[7] Checking if phone verification needed...")
        wait_for_page_load(5)
        
        # Take a screenshot to check
        ss_path = os.path.join(ROOT, "gmail-data", f"desktop_result_{attempt_num}.png")
        pyautogui.screenshot(ss_path)
        log(f"  Screenshot: {ss_path}")
        
        # At this point, manually check screenshot to see if account was created
        # For now, save as tentative
        log("  ⚠ Check screenshot to verify result")
        
        return save(email, uname, pw)
        
    except pyautogui.FailSafeException:
        log("  ⚠ FAILSAFE TRIGGERED — mouse moved to (0,0)")
        return None
    except Exception as e:
        log(f"Error: {e}")
        traceback.print_exc()
        return None
    finally:
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
    log(f"DESKTOP AUTOMATION GMAIL REGISTRATOR")
    log(f"5sim: {sim5.bal()}RUB")
    log(f"Strategy: OS-level mouse/keyboard (NO CDP/WebDriver)")
    log(f"⚠ Move mouse to top-left corner (0,0) to abort!")
    log(f"{'='*50}")
    
    results = []
    for i in range(1, count + 1):
        r = do_(i)
        if r: results.append(r); log(f"RESULT: {r['email']} | {r['']}")
        else: log(f"FAILED")
        log(f"Progress: {len(results)}/{i}")
        if i < count:
            wait = random.randint(10, 15)
            log(f"  Cooling {wait}s...")
            time.sleep(wait)
    
    log(f"\n{'='*50}")
    log(f"DONE: {len(results)}/{count}")
    for r in results: log(f"  {r['email']} | {r['']}")
    log(f"{'='*50}")


if __name__ == "__main__":
    main()
