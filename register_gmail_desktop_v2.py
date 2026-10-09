# -*- coding: utf-8 -*-
"""
_gmail_desktop_v2.py — OS-level Desktop Automation
ZERO CDP, ZERO WebDriver, ZERO  protocols.
Google CANNOT detect this — pure simulated human input via pyautogui.

Workflow: keyboard Tab navigation + typing + occasional Space/Enter for buttons.
"""
import json, os, random, re, string, sys, time, traceback, io
from datetime import datetime

if sys. == "win32":
    try: sys.stdout.reconfigure(encoding="utf-8")
    except: pass

import pyautogui
import pyperclip
import pygetwindow as gw

pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.03

ROOT = os.path.dirname(os.path.abspath(__file__))
SS_DIR = os.path.join(ROOT, "gmail-data", "desktop-ss")
ACCOUNTS = os.path.join(ROOT, "gmail-data", ".json")
for d in [SS_DIR]: os.makedirs(d, exist_ok=True)

def log(msg): print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)

# ========== CONFIG ==========
BITBROWSER_API = "http://:54345"
API_KEY = ""
FIVESIM_KEY = "eyJhbGciOiJSUzUxMiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE4MTM3MzQ3ODEsImlhdCI6MTc4MjE5ODc4MSwicmF5IjoiNjIxMWY0MjAyNmM2YjZkNDMxMjMxYjY0MDkwMzg3MDYiLCJzdWIiOjQyMjIwNTB9.wRPYREkUdv60wd68XujZqXlravtg01aMWYECx0Bl1fLqC2uxL2yELzAIWIG_b_yAhKrymtxV5XsGlCpBm_uapnwJZhUw7LyHHnYl_V6weL6uEvk2ayrcIhaUCa13RORmRen8fXdrElnO_flZqQpeJRqm7gpUQF-HSy8Az3iy3j0JWvW9pfg_sAZTCA6vlADn66lrZ36O5g3NiKoTtTB0SYo8lfzFxtBbROc6gSMg_46dmn1hjNgJB6cetJ33DLQ1UJCuckcjV_lVfiPIMYT51RIqaRS8zyPaCTT8938whKFHbbJgWpne-6ldHmdeDudWDtytElk7d204shjBL1q1ww"

import requests as _req
HEADERS = {"": API_KEY, "": "application/json"}

FIRST = ["James","John","Robert","David","William","Richard","Joseph","Thomas","Christopher","Daniel"]
LAST = ["Smith","Johnson","Williams","Brown","Jones","Garcia","Miller","Davis","Rodriguez","Martinez"]

# ========== BITBROWSER API ==========
def api(method, path, data=None, timeout=60):
    try:
        r = (_req.get if method == "GET" else _req.post)(
            f"{BITBROWSER_API}{path}", headers=HEADERS, json=data, timeout=timeout)
        return r.json() if r.status_code < 400 else None
    except: return None

def create_and_open(name):
    data = {
        "name": name,
        "proxyMethod": 2, "proxyType": "http",
        "host": "", "port": 8090,
        "browserFingerPrint": {
            "coreVersion": "124", "canvas": "0", "webGL": "0",
            "hardwareConcurrency": "8", "deviceMemory": "8",
            "openWidth": 1440, "openHeight": 900,
        }
    }
    r = api("POST", "/browser/update", data)
    if not (r and r.get("success")): return None, None
    bid = r["data"]["id"]
    r2 = api("POST", "/browser/open", {"id": bid}, 60)
    if not (r2 and r2.get("success")):
        api("POST", "/browser/delete", {"id": bid})
        return None, None
    return bid, r2["data"]["http"]

def close_and_delete(bid):
    try: api("POST", "/browser/close", {"id": bid})
    except: pass
    time.sleep(0.3)
    try: api("POST", "/browser/delete", {"id": bid})
    except: pass

# ========== 5SIM ==========
class Sim5:
    B = "https://5sim.net/v1"
    def __init__(self, k):
        self.s = _req.Session()
        self.s.headers.update({"": f"Bearer {k}", "Accept": "application/json"})
    def _g(self, p, to=20):
        r = self.s.get(f"{self.B}{p}", timeout=to)
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
            m = re.search(r'\d{4,8}', sms[0]["code"])
            return {"s": "RECEIVED", "code": m.group(0) if m else sms[0]["code"]}
        if d.get("status") == "RECEIVED":
            cd = d.get("code") or d.get("sms_code")
            if cd: return {"s": "RECEIVED", "code": str(cd)}
        return {"s": d.get("status", "PENDING")}
    def wait(self, oid, timeout=180):
        st = time.time()
        while time.time() - st < timeout:
            r = self.chk(oid)
            if r["s"] == "RECEIVED" and r.get("code"):
                log(f"  [5sim] {r['code']} ({int(time.time()-st)}s)")
                return r["code"]
            if r["s"] in ("CANCELED","TIMEOUT","BANNED","ERROR"):
                log(f"  [5sim] {r['s']}")
                return None
            time.sleep(3)
        return None
    def cancel(self, oid): self._g(f"/user/cancel/{oid}")
    def finish(self, oid): self._g(f"/user/finish/{oid}")

# ========== DESKTOP HELPERS ==========

def sshoot(label):
    """Take screenshot."""
    try:
        p = os.path.join(SS_DIR, f"{label}_{datetime.now():%H%M%S}.png")
        pyautogui.screenshot(p)
        log(f"  📸 {label}")
        return p
    except: return None

def get_clipboard_url():
    """Copy current URL from address bar and read clipboard."""
    try:
        pyautogui.hotkey('ctrl', 'l')
        time.sleep(0.3)
        pyautogui.hotkey('ctrl', 'c')
        time.sleep(0.2)
        url = pyperclip.paste().strip()
        # CRITICAL: Return focus to page (press Escape to close address bar)
        pyautogui.keyDown('esc')
        pyautogui.keyUp('esc')
        time.sleep(0.3)
        return url
    except:
        return ""

def human_type(text, cps=3):
    """
    Ultra-realistic typing simulation:
    - Variable speed per character (cps = chars/sec average)
    - Occasional longer pauses (thinking/reaching for keys)
    - Natural clusters of fast typing then pauses
    """
    chars = list(text)
    for i, char in enumerate(chars):
        # Base delay with human variation
        base_delay = 1.0 / cps
        variation = random.uniform(0.5, 2.5) * base_delay
        delay = variation
        
        # Occasional longer pause (thinking)
        if random.random() < 0.15:
            delay += random.uniform(0.3, 0.8)
        
        # Faster clusters — type 2-3 chars fast then pause
        if i > 0 and i % random.randint(2, 4) == 0:
            time.sleep(random.uniform(0.2, 0.5))
        
        pyautogui.typewrite(char)
        time.sleep(delay)

def human_mouse_wander():
    """Move mouse to a random position on the page (simulates human fidgeting)."""
    if random.random() < 0.4:
        x = random.randint(200, 1000)
        y = random.randint(200, 600)
        pyautogui.moveTo(x, y, duration=random.uniform(0.3, 1.0))
        time.sleep(random.uniform(0.1, 0.3))

def human_field_pause():
    """Realistic pause between form fields (reading, thinking)."""
    t = random.uniform(1.5, 4.0)
    time.sleep(t)
    # Maybe move mouse around
    human_mouse_wander()
    time.sleep(random.uniform(0.2, 0.5))

def human_tab(n=1):
    for _ in range(n):
        pyautogui.press('tab')
        time.sleep(0.15)

def find_window(search_term, timeout=15):
    """Find BitBrowser Chrome window."""
    st = time.time()
    while time.time() - st < timeout:
        wins = [w for w in gw.getAllWindows() if search_term in (w.title or "")]
        if wins:
            w = max(wins, key=lambda w: w.width * w.height)
            return w
        time.sleep(0.8)
    return None

def activate_and_maximize(win):
    try:
        win.activate()
        time.sleep(0.5)
        win.maximize()
        time.sleep(0.5)
        return True
    except:
        return False


def page_click():
    """Click on page to restore focus after address bar interaction."""
    pyautogui.click(x=pyautogui.size().width // 2, y=300)
    time.sleep(0.3)


def do_(attempt_num, sim5):
    f_name = random.choice(FIRST)
    l_name = random.choice(LAST)
    uname = f"{f_name.lower()}{l_name.lower()}{random.randint(100,9999)}"
    pw = (random.choice(string.ascii_uppercase) + 
          "".join(random.choices(string.ascii_lowercase, k=6)) + 
          "".join(random.choices(string.digits, k=4)) + "!")
    yr, mo, dy = random.randint(1985, 2000), random.randint(1, 12), random.randint(1, 28)
    g = "Male" if random.random() > 0.5 else "Female"
    email = f"{uname}@gmail.com"
    mf = ["","January","February","March","April","May","June","July","August","September","October","November","December"]

    log(f"\n{'='*50}")
    log(f"DESKTOP v2 #{attempt_num} | {email} | {mf[mo]} {dy}, {yr} | {g}")
    log(f"{'='*50}")
    log("  ⚠ 将控制鼠标键盘！移到左上角(0,0)中止  4秒后开始...")
    time.sleep(4)
    
    browser_id = None
    profile_name = f"Gmail-DT-{uname}"
    try:
        # 1. Create & open profile
        browser_id, http_ep = create_and_open(profile_name)
        if not browser_id:
            log("  Failed to create/open profile")
            return None
        
        # 2. Find window
        log("  Finding Browser window...")
        win = find_window(uname[:8])
        if not win:
            log(f"  ❌ Window not found")
            sshoot("no_window")
            close_and_delete(browser_id)
            return None
        
        log(f"  Window: {win.title[:60]}")
        activate_and_maximize(win)
        time.sleep(1)
        page_click()
        
        # ===== STEP 1: Navigate to Signup =====
        log("[1] Navigating to Gmail signup...")
        pyautogui.hotkey('ctrl', 'l')
        time.sleep(0.4)
        human_type("https://.google.com/signup/v2/webcreateaccount?hl=en&flowName=GlifWebSignIn&flowEntry=SignUp")
        time.sleep(0.3)
        pyautogui.press('enter')
        time.sleep(8)
        page_click()
        sshoot("01_signup_page")
        log("    Signup page should be loaded")
        
        # ===== STEP 2: Name =====
        log(f"[2] Name: {f_name} {l_name}")
        human_type(f_name, cps=2)
        human_mouse_wander()
        human_tab()
        human_field_pause()
        human_type(l_name, cps=2)
        human_mouse_wander()
        human_field_pause()
        pyautogui.press('enter')  # Submit name
        log("    Submitted name → waiting for  page...")
        time.sleep(8)
        page_click()
        sshoot("02_after_name")
        
        # Quick URL check after name
        url = get_clipboard_url()
        log(f"    URL: {(url or '?')[:100]}")
        page_click()
        
        if url and "console.bitbrowser" in url:
            log("    ❌ Landed on BitBrowser console")
            close_and_delete(browser_id)
            return None
        
        if url and "name" in url.lower():
            # Still on name page — form might not have submitted
            log("    ⚠ Still on name page, clicking Next...")
            human_tab(3)
            pyautogui.press('enter')
            time.sleep(8)
            page_click()
        
        # ===== STEP 3: Birthday =====
        log(f"[3] Birthday: {mf[mo]} {dy}, {yr} | {g}")
        
        # Month dropdown
        human_tab()
        human_field_pause()
        pyautogui.press('space')
        human_field_pause()
        human_type(mf[mo][:3], cps=2)
        human_mouse_wander()
        time.sleep(0.5)
        pyautogui.press('enter')
        human_mouse_wander()
        
        # Day
        human_tab()
        human_field_pause()
        human_type(str(dy), cps=2)
        human_mouse_wander()
        
        # Year
        human_tab()
        human_field_pause()
        human_type(str(yr), cps=2)
        human_mouse_wander()
        
        # Gender
        human_tab()
        human_field_pause()
        pyautogui.press('space')
        human_field_pause()
        human_type("Ma" if g == "Male" else "Fe", cps=2)
        human_mouse_wander()
        time.sleep(0.5)
        pyautogui.press('enter')
        human_mouse_wander()
        
        # Tab to Next button and click
        human_tab()
        human_field_pause()
        pyautogui.press('enter')
        log("    Submitted  → waiting...")
        time.sleep(8)
        page_click()
        sshoot("03_after_")
        
        # Critical check:  redirect = anti-bot flag
        url = get_clipboard_url()
        log(f"    URL: {(url or '?')[:100]}")
        page_click()
        
        if url and ("gender" in url.lower() or "tl=" in url.lower()):
            log("    ⚠ Birthday not accepted — retrying once...")
            # Retry: slower typing
            time.sleep(1)
            human_tab()
            time.sleep(0.5); pyautogui.press('space'); time.sleep(0.8)
            human_type(mf[mo][:3], cps=1); time.sleep(0.5); pyautogui.press('enter')
            time.sleep(0.4)
            human_tab(); human_type(str(dy), cps=2)
            human_tab(); human_type(str(yr), cps=2)
            human_tab(); time.sleep(0.5); pyautogui.press('space'); time.sleep(0.8)
            human_type("Ma" if g == "Male" else "Fe", cps=1); time.sleep(0.5); pyautogui.press('enter')
            time.sleep(0.3)
            human_tab(); pyautogui.press('enter')
            time.sleep(8)
            page_click()
            
            url = get_clipboard_url()
            log(f"    Retry URL: {(url or '?')[:100]}")
            page_click()
            
            if url and ("gender" in url.lower() or "tl=" in url.lower()):
                log("    ❌ Anti-bot detection — cannot proceed")
                sshoot("fail_final_")
                close_and_delete(browser_id)
                return None
        
        log("    ✓ Birthday accepted!")
        
        # ===== STEP 4: Username =====
        log(f"[4] Username: {uname}")
        time.sleep(1)
        
        # Skip suggested emails → "Create your own"
        human_tab(4)
        time.sleep(0.3)
        pyautogui.press('space')
        time.sleep(1.5)
        
        human_tab()
        time.sleep(0.3)
        human_type(uname)
        time.sleep(0.6)
        pyautogui.press('enter')
        log("    Submitted  → waiting...")
        time.sleep(8)
        page_click()
        sshoot("04_after_")
        
        # Quick check for redirect
        url = get_clipboard_url()
        page_click()
        if url and "gender" in url.lower():
            log("    ❌ Anti-bot after ")
            close_and_delete(browser_id)
            return None
        log(f"    URL: {(url or '?')[:80]}")
        
        # ===== STEP 5:  =====
        log("[5] ")
        time.sleep(0.5)
        human_type(pw)
        time.sleep(0.4)
        human_tab()
        human_type(pw)
        time.sleep(0.6)
        pyautogui.press('enter')
        log("    Submitted  → waiting...")
        time.sleep(8)
        page_click()
        sshoot("05_after_")
        
        # ===== STEP 6: Terms/Skip =====
        log("[6] Handling terms/skip screens...")
        for attempt in range(5):
            time.sleep(2)
            pyautogui.press('enter')
            time.sleep(5)
            page_click()
        
        sshoot("06_post_terms")
        
        # ===== STEP 7: Check success =====
        url = get_clipboard_url()
        log(f"[7] URL: {(url or '?')[:100]}")
        page_click()
        
        if url and any(k in url.lower() for k in ["", "mail.google", "welcome"]):
            log("🎉 ACCOUNT CREATED!")
            sshoot("success")
            close_and_delete(browser_id)
            return save(email, uname, pw, f_name, l_name, f"{mf[mo]} {dy},{yr}", g)
        
        if url and "console.bitbrowser" in url:
            log("    ❌ On BitBrowser console — browser lost page")
            close_and_delete(browser_id)
            return None
        
        if url and "google.com/search" in url:
            log("    ⚠ On Google search page — typed in address bar!")
            close_and_delete(browser_id)
            return None
        
        # ===== Phone verification =====
        log("[7] Checking phone verification...")
        
        if sim5.bal() < 0.5:
            log("    Insufficient balance")
            sshoot("no_balance")
            close_and_delete(browser_id)
            return None
        
        order = sim5.buy()
        if not order:
            log("    Failed to buy number")
            sshoot("no_phone")
            close_and_delete(browser_id)
            return None
        
        log(f"    +{order['phone']} ({order['price']}RUB)")
        
        time.sleep(1)
        human_type(order["phone"])
        time.sleep(0.5)
        pyautogui.press('enter')
        log("    Submitted phone, waiting for SMS...")
        time.sleep(5)
        sshoot("07_phone_sent")
        
        code = sim5.wait(order["id"], timeout=180)
        if not code:
            log("    No SMS")
            sim5.cancel(order["id"])
            close_and_delete(browser_id)
            return None
        
        log(f"    CODE: {code}")
        time.sleep(0.5)
        human_type(code, cps=3)
        time.sleep(0.5)
        pyautogui.press('enter')
        time.sleep(8)
        page_click()
        sshoot("08_after_code")
        
        url = get_clipboard_url()
        page_click()
        
        if url and any(k in url.lower() for k in ["", "mail.google", "welcome"]):
            sim5.finish(order["id"])
            log("🎉 ACCOUNT CREATED WITH PHONE!")
            sshoot("success_phone")
            close_and_delete(browser_id)
            return save(email, uname, pw, f_name, l_name, f"{mf[mo]} {dy},{yr}", g)
        
        # Code might be wrong
        url2 = get_clipboard_url()
        page_click()
        if url2 and "verify" in url2.lower():
            sim5.cancel(order["id"])
            log("    Code rejected")
        else:
            sim5.cancel(order["id"])
        
        # Final Enter presses
        for _ in range(3):
            pyautogui.press('enter')
            time.sleep(5)
        
        url = get_clipboard_url()
        page_click()
        if url and any(k in url.lower() for k in ["", "mail.google", "welcome"]):
            log("🎉 ACCOUNT CREATED!")
            sshoot("success_final")
            close_and_delete(browser_id)
            return save(email, uname, pw, f_name, l_name, f"{mf[mo]} {dy},{yr}", g)
        
        log("  End of flow — check screenshots")
        sshoot("end_of_flow")
        close_and_delete(browser_id)
        return None
        
    except pyautogui.FailSafeException:
        log("  ⚠ FAILSAFE — mouse at (0,0)")
        sshoot("failsafe")
        if browser_id: close_and_delete(browser_id)
        return None
    except Exception as e:
        log(f"  Error: {e}")
        traceback.print_exc()
        sshoot(f"error_{attempt_num}")
        if browser_id:
            try: close_and_delete(browser_id)
            except: pass
        return None


def save(email, uname, pw, fname, lname, bday, gender):
    d = {
        "email": email, "": uname, "": pw,
        "first": fname, "last": lname, "": bday, "gender": gender,
        "": datetime.now().isoformat()
    }
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
    log(f"DESKTOP v2 — OS-level  (NO CDP)")
    log(f"5sim: {sim5.bal()}RUB")
    log(f"⚠ Mouse to top-left corner (0,0) = ABORT")
    log(f"Starting now...")
    log(f"{'='*50}")
    
    results = []
    for i in range(1, count + 1):
        r = do_(i, sim5)
        if r:
            results.append(r)
            log(f"SUCCESS: {r['email']} | {r['']}")
        else:
            log("FAILED")
        log(f"Progress: {len(results)}/{i}")
        if i < count:
            wait = random.randint(15, 25)
            log(f"  Cooling {wait}s...")
            time.sleep(wait)
    
    log(f"\n{'='*50}")
    log(f"DONE: {len(results)}/{count}")
    for r in results:
        log(f"  {r['email']} | {r['']}")
    log(f"{'='*50}")


if __name__ == "__main__":
    main()
