# -*- coding: utf-8 -*-
"""
_gmail_cdp_raw.py
RAW CDP (Chrome DevTools Protocol) via WebSocket — ZERO  drivers.

NO Playwright, NO Selenium, NO chromedriver, NO WebDriver protocol.
Just a plain WebSocket connection to BitBrowser's Chrome debugging port.
Google CANNOT detect this — it looks like native Chrome DevTools usage.
"""
import asyncio, json, os, random, re, string, sys, time, traceback
from datetime import datetime

if sys. == "win32":
    try: sys.stdout.reconfigure(encoding="utf-8")
    except: pass

import websockets
import requests as _req

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

# ========== CDP CLIENT ==========
class CDPClient:
    """
    Minimal CDP client — connects via WebSocket, sends commands, reads events.
    No chromedriver, no WebDriver, no Playwright. Just raw WebSocket + JSON.
    """
    def __init__(self, ws_url):
        self.ws_url = ws_url
        self._ws = None
        self._msg_id = 0
        self._results = {}
        self._events = asyncio.Queue()
        self._running = False

    async def connect(self, timeout=15):
        self._ws = await asyncio.wait_for(
            websockets.connect(self.ws_url, max_size=2**24),
            timeout=timeout
        )
        self._running = True
        asyncio.create_task(self._reader())
        
        # Get existing targets or create new page
        targets = await self.send("Target.getTargets")
        page_targets = [t for t in targets.get("result", {}).get("targetInfos", [])
                       if t.get("type") == "page"]
        if page_targets:
            self._page_target = page_targets[0]["targetId"]
            log(f"  Using page: {page_targets[0].get('url','')[:60]}")
        else:
            # Create new page
            cr = await self.send("Target.createTarget", {"url": "about:blank"})
            self._page_target = cr.get("result", {}).get("targetId")
            log(f"  Created page: {self._page_target}")
        
        # Attach to the page target
        await self.send("Target.attachToTarget", {"targetId": self._page_target, "flatten": True})
        
        # Enable domains
        await self.send("Runtime.enable")
        await self.send("Page.enable")
        await self.send("DOM.enable")
        await self.send("Network.enable")

    async def _reader(self):
        while self._running:
            try:
                msg = await asyncio.wait_for(self._ws.recv(), timeout=30)
                data = json.loads(msg)
                mid = data.get("id")
                if mid and mid in self._results:
                    self._results[mid] = data
                else:
                    await self._events.put(data)
            except asyncio.TimeoutError:
                continue
            except Exception:
                break

    async def send(self, method, params=None, timeout=15):
        """Send CDP command and wait for response."""
        self._msg_id += 1
        mid = self._msg_id
        cmd = {"id": mid, "method": method, "params": params or {}}
        self._results[mid] = None
        await self._ws.send(json.dumps(cmd))
        start = time.time()
        while time.time() - start < timeout:
            if self._results[mid] is not None:
                return self._results.pop(mid)
            await asyncio.sleep(0.05)
        self._results.pop(mid, None)
        return None

    async def evaluate(self, expression, timeout=15):
        """Execute JavaScript in page context."""
        result = await self.send("Runtime.evaluate", {
            "expression": expression,
            "returnByValue": True,
            "awaitPromise": False,
        }, timeout=timeout)
        if result and "result" in result:
            r = result["result"]
            # CDP response: {id:N, result:{result:{type, value}}}
            inner = r.get("result", r)  # handle both nesting levels
            if isinstance(inner, dict):
                if inner.get("type") == "string":
                    return inner.get("value", "")
                if inner.get("type") == "number":
                    return inner.get("value")
                if inner.get("type") == "boolean":
                    return inner.get("value", False)
                if inner.get("type") == "undefined":
                    return None
                return inner.get("value", inner)
            return inner
        return None

    async def navigate(self, url, timeout=30):
        """Navigate to URL."""
        rid = self._msg_id + 1
        result = await self.send("Page.navigate", {"url": url}, timeout=timeout)
        # Wait for load
        await asyncio.sleep(3)
        return result

    async def get_url(self):
        """Get current page URL."""
        r = await self.evaluate("window.location.href")
        return str(r) if r else ""

    async def type_text(self, text, delay_ms=60):
        """Type text with human-like delays."""
        for char in text:
            key = char
            await self.send("Input.dispatchKeyEvent", {
                "type": "keyDown",
                "key": key,
                "code": f"Key{char.upper()}" if char.isalpha() else f"Digit{char}" if char.isdigit() else "Space",
                "text": char,
            })
            await self.send("Input.dispatchKeyEvent", {
                "type": "keyUp",
                "key": key,
                "code": f"Key{char.upper()}" if char.isalpha() else f"Digit{char}" if char.isdigit() else "Space",
            })
            await asyncio.sleep(random.uniform(delay_ms/1000, (delay_ms*2)/1000))

    async def click_element(self, selector, timeout=10):
        """Click element by CSS selector via JavaScript."""
        await self.evaluate(f"""
            (() => {{
                const el = document.querySelector('{selector.replace("'", "\\'")}');
                if (el) {{ el.click(); return true; }}
                return false;
            }})()
        """, timeout=timeout)
        await asyncio.sleep(0.5)

    async def set_input_value(self, selector, value, timeout=10):
        """Set input value (for non-reactive fields)."""
        await self.evaluate(f"""
            (() => {{
                const el = document.querySelector('{selector.replace("'", "\\'")}');
                if (el) {{
                    el.focus();
                    el.value = '{value}';
                    el.dispatchEvent(new Event('input', {{bubbles: true}}));
                    el.dispatchEvent(new Event('change', {{bubbles: true}}));
                    return true;
                }}
                return false;
            }})()
        """, timeout=timeout)

    async def click_button_by_text(self, texts, timeout=10):
        """Click a button containing any of the given texts."""
        import json as _j
        result = await self.evaluate(f"""
            (() => {{
                const texts = {_j.dumps(texts)};
                const allBtns = 'button, span[role="button"], div[role="button"]');
                for (const t of texts) {{
                    for (const btn of allBtns) {{
                        if (btn.textContent && btn.textContent.includes(t)) {{
                            btn.click();
                            return t;
                        }}
                    }}
                }}
                return null;
            }})()
        """, timeout=timeout)
        return result

    async def set_select_by_index(self, selector, index, timeout=10):
        """Set SELECT element by index."""
        await self.evaluate(f"""
            (() => {{
                const el = document.querySelector('{selector.replace("'", "\\'")}');
                if (el) {{
                    el.selectedIndex = {index};
                    el.dispatchEvent(new Event('change', {{bubbles: true}}));
                    return true;
                }}
                return false;
            }})()
        """, timeout=timeout)

    async def get_page_text(self):
        """Get visible page text."""
        return await self.evaluate("document.body.innerText")

    async def wait_for_selector(self, selector, timeout=15):
        """Wait until element matching selector exists."""
        start = time.time()
        while time.time() - start < timeout:
            r = await self.evaluate(f"!!document.querySelector('{selector.replace("'", "\\'")}')")
            if r:
                return True
            await asyncio.sleep(0.5)
        return False

    async def close(self):
        self._running = False
        if self._ws:
            await self._ws.close()


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
            "coreVersion": "124", "canvas": "0", "webGL": "0",
            "hardwareConcurrency": "8", "deviceMemory": "8",
        }
    }
    r = api_call("POST", "/browser/update", data)
    if r and r.get("success"):
        return r["data"]["id"]
    return None

def open_browser(bid):
    r = api_call("POST", "/browser/open", {"id": bid}, timeout=60)
    if r and r.get("success"):
        return r["data"]["ws"], r["data"]["http"]
    return None, None

def close_browser(bid):
    api_call("POST", "/browser/close", {"id": bid})

def delete_browser(bid):
    api_call("POST", "/browser/delete", {"id": bid})


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


# ========== MAIN REGISTRATION ==========
async def do_(attempt_num):
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
    log(f"RAW CDP #{attempt_num} | {email} | {mf[mo]} {dy}, {yr} | {g}")
    log(f"{'='*50}")
    
    browser_id = None
    cdp = None
    try:
        # Create + open browser
        browser_id = create_profile(f"Gmail-CDP-{uname}")
        if not browser_id:
            log("  Failed to create profile")
            return None
        
        ws_url, http_ep = open_browser(browser_id)
        if not ws_url:
            log("  Failed to open browser")
            delete_browser(browser_id)
            return None
        log(f"  CDP WebSocket: {ws_url[:60]}...")
        
        # Connect via raw CDP
        cdp = CDPClient(ws_url)
        await cdp.connect()
        
        # Verify: navigator.webdriver should be false
        wd = await cdp.evaluate("navigator.webdriver")
        log(f"  navigator.webdriver: {wd}")
        lang = await cdp.evaluate("navigator.language")
        log(f"  Language: {lang}")
        
        # ========== STEP 1: Signup Page ==========
        log("[1] Opening Gmail signup...")
        await cdp.navigate("https://.google.com/signup/v2/webcreateaccount?hl=en&flowName=GlifWebSignIn&flowEntry=SignUp")
        await asyncio.sleep(5)
        url = await cdp.get_url()
        log(f"    URL: {url[:80]}")
        
        # ========== STEP 2: Name ==========
        log(f"[2] Name: {f_name} {l_name}")
        
        # Set first name via JS
        await cdp.evaluate("""
            (() => {
                const fn = document.querySelector('"firstName"]');
                if (fn) { fn.focus(); fn.value = arguments[0]; fn.dispatchEvent(new Event('input', {bubbles:true})); }
            })()
        """)
        await asyncio.sleep(0.3)
        # Type first name character by character for realism
        await cdp.set_input_value('"firstName"]', f_name)
        await asyncio.sleep(0.5)
        await cdp.set_input_value('"lastName"]', l_name)
        await asyncio.sleep(0.5)
        
        # Click Next
        await cdp.click_button_by_text(["Next"])
        await asyncio.sleep(6)
        url = await cdp.get_url()
        log(f"    URL: {url[:80]}")
        
        # ========== STEP 3: Birthday ==========
        log(f"[3] Birthday: {mf[mo]} {dy}, {yr} | {g}")
        
        # Set  via JS (directly on SELECT elements)
        await cdp.evaluate(f"""
            (() => {{
                const setSelect = (sel, val) => {{
                    const el = document.querySelector(sel);
                    if (el) {{ el.value = val; el.dispatchEvent(new Event('change', {{bubbles: true}})); }}
                }};
                const setInput = (sel, val) => {{
                    const el = document.querySelector(sel);
                    if (el) {{ el.focus(); el.value = val; el.dispatchEvent(new Event('input', {{bubbles: true}})); el.dispatchEvent(new Event('change', {{bubbles: true}})); }}
                }};
                // Try SELECT first, then INPUT
                setSelect('select[name="month"]', '{mo}');
                setInput('"month"]', '{ma[mo]}');
                setInput('input[aria-label*=\"Month\" i]', '{ma[mo]}');
                
                setSelect('select[name="day"]', '{dy}');
                setInput('"day"]', '{dy}');
                
                setSelect('select[name="year"]', '{yr}');
                setInput('"year"]', '{yr}');
                
                setSelect('select[name="gender"]', '{1 if g=="Male" else 2}');
                setInput('"gender"]', '{g}');
                setInput('input[aria-label*=\"Gender\" i]', '{g}');
            }})()
        """)
        await asyncio.sleep(1.5)
        
        # Click Next
        await cdp.click_button_by_text(["Next"])
        await asyncio.sleep(6)
        url = await cdp.get_url()
        log(f"    URL: {url[:100]}")
        
        # Check for  redirect
        if "gender" in url.lower():
            log("    ❌ Anti-bot detection —  redirect")
            return None
        
        log("    ✓ Birthday accepted!")
        
        # ========== STEP 4: Username ==========
        log(f"[4] Username: {uname}")
        
        # Click "Create your own"
        await cdp.click_button_by_text(["Create your own", "Create your own Gmail"])
        await asyncio.sleep(2)
        
        await cdp.set_input_value('"Username"]', uname)
        await asyncio.sleep(1)
        await cdp.click_button_by_text(["Next"])
        await asyncio.sleep(6)
        
        url = await cdp.get_url()
        log(f"    URL: {url[:100]}")
        
        if "gender" in url.lower():
            log("    ❌ Anti-bot after ")
            return None
        if any(k in url.lower() for k in ["unavailable", "taken"]):
            log("    ⚠ Username taken")
            return None
        
        log("    ✓ Username accepted!")
        
        # ========== STEP 5:  ==========
        log("[5] ")
        pw_count = await cdp.evaluate("'\"\"]'")
        log(f"     fields: {pw_count}")
        
        await cdp.set_input_value('""', pw)
        if pw_count == 2:
            await cdp.set_input_value('""', pw)
        await asyncio.sleep(0.5)
        await cdp.click_button_by_text(["Next"])
        await asyncio.sleep(5)
        
        url = await cdp.get_url()
        log(f"[6] URL: {url[:100]}")
        
        # Check for success
        if any(k in url.lower() for k in ["", "mail.google", "welcome"]):
            log("🎉 ACCOUNT CREATED!")
            return save(email, uname, pw)
        
        # Handle Terms
        await cdp.click_button_by_text(["I agree", "Agree", "Accept"])
        await asyncio.sleep(3)
        await cdp.click_button_by_text(["Skip", "Not now", "Skip for now"])
        await asyncio.sleep(2)
        await cdp.click_button_by_text(["Next"])
        await asyncio.sleep(5)
        
        url = await cdp.get_url()
        log(f"[7] URL: {url[:100]}")
        
        if any(k in url.lower() for k in ["", "mail.google", "welcome"]):
            log("🎉 ACCOUNT CREATED!")
            return save(email, uname, pw)
        
        # Phone verification
        page_text = await cdp.get_page_text() or ""
        if any(k in page_text.lower() for k in ["verify", "phone", "number"]):
            log("[7] Phone verification needed")
            sim5 = Sim5(FIVESIM_KEY)
            if sim5.bal() < 1.0:
                log("    Insufficient 5sim balance")
                return None
            
            order = sim5.buy()
            if not order:
                log("    Failed to buy number")
                return None
            
            log(f"    +{order['phone']} ({order['price']}RUB)")
            await cdp.set_input_value('"tel"], "phoneNumber"]', order["phone"])
            await asyncio.sleep(1)
            await cdp.click_button_by_text(["Next"])
            await asyncio.sleep(4)
            
            code = sim5.wait(order["id"])
            if code:
                log(f"    CODE: {code}")
                await cdp.evaluate(f"""
                    const inp = document.querySelector('"hidden"""])');
                    if (inp) {{ inp.focus(); inp.value = '{code}'; }}
                """)
                await cdp.click_button_by_text(["Next", "Verify"])
                await asyncio.sleep(5)
                
                url = await cdp.get_url()
                page_text = await cdp.get_page_text() or ""
                
                if "" in page_text.lower():
                    sim5.cancel(order["id"])
                elif any(k in url.lower() for k in ["", "welcome", "mail.google"]):
                    sim5.finish(order["id"])
                    log("🎉 ACCOUNT CREATED WITH PHONE!")
                    return save(email, uname, pw)
                else:
                    sim5.cancel(order["id"])
            else:
                sim5.cancel(order["id"])
        
        # Final check
        url = await cdp.get_url()
        if any(k in url.lower() for k in ["", "mail.google", "welcome"]):
            log("🎉 ACCOUNT CREATED!")
            return save(email, uname, pw)
        
        log("End of flow")
        return None
        
    except Exception as e:
        log(f"Error: {e}")
        traceback.print_exc()
        return None
    finally:
        if cdp:
            try: await cdp.close()
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


async def main():
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    sim5 = Sim5(FIVESIM_KEY)
    log(f"\n{'='*50}")
    log(f"RAW CDP GMAIL REGISTRATOR (ZERO AUTOMATION DRIVERS)")
    log(f"5sim: {sim5.bal()}RUB")
    log(f"{'='*50}")
    
    results = []
    for i in range(1, count + 1):
        r = await do_(i)
        if r:
            results.append(r)
            log(f"SUCCESS: {r['email']}")
        else:
            log(f"FAILED")
        log(f"Progress: {len(results)}/{i}")
        if i < count:
            wait = random.randint(10, 20)
            log(f"  Cooling {wait}s...")
            await asyncio.sleep(wait)
    
    log(f"\n{'='*50}")
    log(f"DONE: {len(results)}/{count}")
    for r in results:
        log(f"  {r['email']} | {r['']}")
    log(f"{'='*50}")


if __name__ == "__main__":
    asyncio.run(main())
