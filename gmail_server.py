# -*- coding: utf-8 -*-
"""
gmail_server.py — Gmail Creator Pro Backend API Server
基于 ShadowHackrs/gmail-account-creator 架构重建
Flask REST API + 5sim 集成 + 4层验证绕过 + 进度追踪
"""

import asyncio, json, os, random, re, string, sys, time, traceback, threading
from datetime import datetime
from flask import Flask, jsonify, request, Response
from flask_cors import CORS

if sys. == "win32":
    try: sys.stdout.reconfigure(encoding="utf-8")
    except: pass

# ── Paths ──
ROOT = os.path.dirname(os.path.abspath(__file__))
SRC_DIR = os.path.join(os.path.dirname(ROOT), "reg-factory-isolated")
DATA_DIR = os.path.join(ROOT, "gmail-data")
ACCOUNTS_FILE = os.path.join(DATA_DIR, ".json")
CONFIG_FILE = os.path.join(DATA_DIR, "config.json")
SCREENSHOTS_DIR = os.path.join(DATA_DIR, "screenshots")
for d in [DATA_DIR, SCREENSHOTS_DIR]: os.makedirs(d, exist_ok=True)

# ── Flask App ──
app = Flask(__name__)
CORS(app)

# ── Global State ──
tasks = {}
 = []
if os.path.exists(ACCOUNTS_FILE):
    try:
        with open(ACCOUNTS_FILE, "r", encoding="utf-8") as f:
             = json.load(f)
    except: pass

config = {
    "_month": 3, "_day": 15, "_year": 1985,
    "gender": 1,  # 1=Male, 2=Female
    "use_arabic_names": False,
    "": "",
    "fivesim_country": "usa",
    "fivesim_": "any",
    "use_voice_call": True,
}

if os.path.exists(CONFIG_FILE):
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            config.update(json.load(f))
    except: pass

FIRST_NAMES = ["James","John","Robert","Michael","David","William","Richard",
               "Joseph","Thomas","Christopher","Daniel","Matthew","Anthony",
               "Mark","Paul","Steven","Andrew","Kenneth","George","Brian"]
LAST_NAMES = ["Smith","Johnson","Williams","Brown","Jones","Garcia","Miller",
              "Davis","Rodriguez","Martinez","Hernandez","Lopez","Gonzalez",
              "Wilson","Anderson","Thomas","Taylor","Moore","Jackson","Martin"]
MONTH_ABBR = ["","jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"]

def gen_account():
    f,l = random.choice(FIRST_NAMES), random.choice(LAST_NAMES)
    u = f"{f.lower()}{l.lower()}{random.randint(100,9999)}"
    p = random.choice(string.ascii_uppercase)+"".join(random.choices(string.ascii_lowercase,k=5))+"".join(random.choices(string.digits,k=4))+"!"
    y,m,d = random.randint(1980,2000), random.randint(1,12), random.randint(1,28)
    g = random.choice(["Male","Female"])
    return f,l,u,p,y,m,d,g


class Sim5:
    B = "https://5sim.net/v1"
    
    def __init__(self, api_key):
        import requests as _r
        self.s = _r.Session()
        self.s.headers.update({"": f"Bearer {api_key}", "Accept": "application/json"})

    def _g(self, path, params=None, t=20):
        r = self.s.get(f"{self.B}{path}", params=params, timeout=t)
        return r.json() if r.status_code < 400 else None

    def bal(self): d = self._g("/user/profile"); return d.get("balance", 0) if d else 0
    
    def buy(self, country="indonesia", voice=True):
        d = self._g(f"/user/buy/activation/{country}/any/google", {"voice": "1"} if voice else None)
        return {"id": d["id"], "phone": d.get("phone", ""), "price": d.get("price", 0)} if (d and d.get("id")) else None

    def chk(self, oid):
        d = self._g(f"/user/check/{oid}")
        if not d: return {"s": "ERROR"}
        sms = d.get("sms", []); s = d.get("status", "PENDING")
        if sms and sms[0].get("code"):
            c = sms[0]["code"]; m = re.search(r'\d{4,8}', c)
            return {"s": "RECEIVED", "code": m.group(0) if m else c}
        if s == "RECEIVED":
            cd = d.get("code") or d.get("sms_code")
            if cd: return {"s": "RECEIVED", "code": str(cd)}
        return {"s": s}

    def wait(self, oid, timeout=120, iv=3, progress_cb=None):
        start = time.time()
        while time.time() - start < timeout:
            r = self.chk(oid)
            if r["s"] == "RECEIVED" and r.get("code"):
                elapsed = int(time.time() - start)
                if progress_cb: progress_cb(f"Code received: {r['code']} ({elapsed}s)")
                return r["code"]
            if r["s"] in ("CANCELED", "TIMEOUT", "BANNED", "ERROR"):
                if progress_cb: progress_cb(f"5sim error: {r['s']}")
                return None
            time.sleep(iv)
        return None

    def cancel(self, oid): self._g(f"/user/cancel/{oid}")
    def finish(self, oid): self._g(f"/user/finish/{oid}")


# ── Core Registration Pipeline (uses Playwright) ──
async def run_registration(task_id, cfg):
    """Full Gmail registration pipeline with progress reporting"""
    def report(msg, step=None, pct=None):
        tasks[task_id] = {"status": "running", "log": msg, "step": step or tasks[task_id].get("step", 0), "pct": pct or tasks[task_id].get("pct", 0)}
        print(f"[{task_id}] {msg}")

    report("Starting browser...", 1, 5)
    
    f, l, u, pw, yr, mo, dy, g = gen_account()
    email = f"{u}@gmail.com"
    report(f"Account: {f} {l} | {email}", 1, 10)

    try:
        from playwright.async_api import async_playwright
    except ImportError:
        report("Playwright not installed. Run: pip install playwright", 0, 100)
        tasks[task_id]["status"] = "error"
        return None

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            channel="chrome", headless=False,
            args=["--no-sandbox", "--disable-blink-features=AutomationControlled",
                  "--disable-dev-shm-usage", "--window-size=1440,900", "--no-first-run"]
        )
        ctx = await browser.new_context(
            viewport={"width": 1440, "height": 900},
            locale="en-US", timezone_id="America/New_York",
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36"
        )
        page = await ctx.new_page()
        order = None

        try:
            # ── Warmup ──
            report("Session warmup: browsing Google...", 2, 15)
            await page.goto("https://www.google.com", wait_until="domcontentloaded", timeout=15000)
            await asyncio.sleep(3)
            sb = page.locator('[name="q"]').first
            if await sb.count() > 0: await sb.fill("news today"); await page.keyboard.press("Enter")
            await asyncio.sleep(3)

            # ── Signup Page ──
            report("Opening Gmail signup...", 3, 25)
            await page.goto("https://.google.com/signup/v2/webcreateaccount?hl=en&flowName=GlifWebSignIn&flowEntry=SignUp",
                           timeout=30000, wait_until="domcontentloaded")
            await asyncio.sleep(5)

            # ── Name ──
            report(f"Filling name: {f} {l}", 3, 35)
            for s, v in [('"firstName"]', f), ('"lastName"]', l)]:
                inp = page.locator(s).first
                if await inp.count() > 0: await inp.fill(v)
            await _click_next(page)
            await asyncio.sleep(random.uniform(4, 6))

            # ── Birthday + Gender ──
            report(f"Filling : {mo}/{dy}/{yr}", 3, 50)
            await _fill_(page, yr, mo, dy, g)
            await _click_next(page)
            await asyncio.sleep(random.uniform(4, 6))

            # ── Username ──
            report(f"Setting : {u}", 4, 60)
            # Click "Create your own" if present
            for lbl in ["Create your own", "Create your own Gmail address"]:
                el = page.locator(f'span:has-text("{lbl}")').first
                if await el.count() > 0:
                    try: await el.click(timeout=3000); break
                    except: pass

            redirect_count = 0
            while redirect_count < 8:
                un_inp = page.locator('"Username"]').first
                if await un_inp.count() > 0:
                    await un_inp.fill(u)
                await asyncio.sleep(random.uniform(2, 4))
                await _click_next(page)
                await asyncio.sleep(4)

                body = (await page.locator("body").inner_text()).lower()
                curl = page.url.lower()

                # Redirect detection
                if "/gender" in curl:
                    redirect_count += 1
                    cd = min(5 + redirect_count * 2, 15)
                    report(f"Google anti-bot redirect #{redirect_count} → cooldown {cd}s", 4, 60)
                    await asyncio.sleep(cd)
                    await _fill_(page, yr, mo, dy, g)
                    await _click_next(page)
                    await asyncio.sleep(4)
                    continue

                if any(k in body for k in ["taken", "already used", "exists"]):
                    u = f"{f.lower()}{l.lower()}{random.randint(100, 9999)}"
                    email = f"{u}@gmail.com"
                    report(f"Username taken → {u}", 4, 60)
                    continue

                report(f"✓ Username accepted: {u}", 4, 70)
                break

            if redirect_count >= 8:
                report("Too many redirects, giving up", 0, 100)
                tasks[task_id]["status"] = "error"
                return None

            # ──  ──
            report("Setting ...", 5, 75)
            try: await page.wait_for_selector('""', timeout=15000)
            except: pass

            pws = page.locator('""')
            pwc = await pws.count()
            if pwc >= 2:
                await pws.nth(0).fill(pw); await pws.nth(1).fill(pw)
            elif pwc == 1:
                await pws.nth(0).fill(pw)
            await _click_next(page)
            await asyncio.sleep(random.uniform(4, 6))

            # ── Terms / Skip recovery ──
            report("Handling terms & recovery...", 6, 82)
            ptext = (await page.locator("body").inner_text()).lower()
            if "terms" in ptext or "privacy" in ptext:
                for l in ["I agree", "Agree"]:
                    b = page.locator(f'"{l}")').first
                    if await b.count() > 0: await b.click(timeout=3000); break
                await asyncio.sleep(3)
            await asyncio.sleep(2)
            p2 = (await page.locator("body").inner_text()).lower()
            if "skip" in p2 or "recovery" in p2:
                for l in ["Skip", "Not now"]:
                    b = page.locator(f'"{l}")').first
                    if await b.count() > 0: await b.click(timeout=3000); break
            await _click_next(page)
            await asyncio.sleep(4)

            # ── Phone Verification (4-layer) ──
            report("Phone verification page...", 7, 88)
            await page.screenshot(path=os.path.join(SCREENSHOTS_DIR, f"{task_id}_verify.png"))
            body = (await page.locator("body").inner_text()).lower()
            curl = page.url.lower()

            # Layer 1: Already in Gmail?
            if "" in curl or "mail.google.com" in curl:
                report("🎉 NO VERIFICATION NEEDED!", 7, 100)
                return _save_account(email, u, pw, task_id)

            # Layer 2: Skip button?
            skip_found = False
            for lbl in ["Skip", "Skip for now", "Not now", "Later", "I prefer"]:
                elements = page.locator(f'"{lbl}"),span:has-text("{lbl}"),a:has-text("{lbl}")')
                cnt = await elements.count()
                if cnt > 0:
                    await elements.first.click(timeout=5000)
                    report(f"✓ Clicked '{lbl}' button!", 7, 92)
                    skip_found = True
                    await asyncio.sleep(3)
                    break

            if skip_found:
                curl2 = page.url.lower()
                body2 = (await page.locator("body").inner_text()).lower()
                if "" in curl2 or "mail.google.com" in curl2:
                    report("🎉 SUCCESS (skipped verification!)", 7, 100)
                    return _save_account(email, u, pw, task_id)
                # Handle recovery page
                for sl in ["Skip", "Not now", "Next"]:
                    sb2 = page.locator(f'"{sl}")').first
                    if await sb2.count() > 0:
                        await sb2.click(timeout=3000); await asyncio.sleep(3); break
                curl3 = page.url.lower()
                if "" in curl3 or "mail.google.com" in curl3:
                    report("🎉 SUCCESS!", 7, 100)
                    return _save_account(email, u, pw, task_id)

            # Layer 3: 5sim Voice Call
            if "phone" in body or "verify" in body or "number" in body:
                api_key = cfg.get("", "")
                if not api_key:
                    report("⚠ No 5sim API key configured", 7, 100)
                    tasks[task_id]["status"] = "phone_required"
                    return None

                sim5 = Sim5(api_key)
                bal = sim5.bal()
                report(f"5sim balance: {bal} RUB", 7, 90)

                if bal < 0.3:
                    report("⚠ Low 5sim balance", 7, 100)
                    tasks[task_id]["status"] = "low_balance"
                    return None

                voice = cfg.get("use_voice_call", True)
                country = cfg.get("fivesim_country", "indonesia")
                order = sim5.buy(country=country, voice=voice)
                if not order:
                    report("⚠ 5sim buy failed", 7, 100)
                    tasks[task_id]["status"] = "sms_buy_failed"
                    return None

                phone = order["phone"]
                report(f"5sim phone: {phone} (order #{order['id']})", 7, 92)

                # Fill phone
                pi = page.locator('"tel"],"phoneNumber"]').first
                if await pi.count() > 0: await pi.fill(phone)

                # Click voice call if available
                for l in ["Call", "Call me", "Phone call", "Voice call", "Get a call"]:
                    cb = page.locator(f'text="{l}",[role="radio"]:has-text("{l}")').first
                    if await cb.count() > 0:
                        await cb.click(timeout=3000); report(f"✓ Voice call selected", 7, 93); break

                await _click_next(page)
                await asyncio.sleep(2)

                report("Waiting for 5sim code...", 7, 94)
                code = sim5.wait(order["id"], timeout=120, iv=3)

                if code:
                    report(f"✓ Code: {code}", 7, 96)
                    ci = page.locator('"hidden"""])').first
                    if await ci.count() > 0:
                        await ci.fill(code)
                        await _click_next(page)
                        await asyncio.sleep(6)

                        pb = (await page.locator("body").inner_text()).lower()
                        pu = page.url.lower()
                        if "" in pb or "wrong" in pb:
                            report("✗ Wrong code", 7, 100)
                            sim5.cancel(order["id"])
                            tasks[task_id]["status"] = "wrong_code"
                        elif "" in pu or "mail.google.com" in pu or "welcome" in pb:
                            report("🎉 VERIFIED!", 7, 100)
                            sim5.finish(order["id"])
                            return _save_account(email, u, pw, task_id)
                        elif "signup" not in pu and "verify" not in pu:
                            sim5.finish(order["id"])
                            return _save_account(email, u, pw, task_id)
                        else:
                            report(f"? {pu[:80]}", 7, 100)
                            sim5.cancel(order["id"])
                else:
                    report("✗ No code received", 7, 100)
                    sim5.cancel(order["id"])
                    tasks[task_id]["status"] = "no_code"
            else:
                report(f"? Unknown page: {body[:200]}", 7, 100)
                await _click_next(page); await asyncio.sleep(4)
                curl2 = page.url.lower()
                if "" in curl2 or "mail.google.com" in curl2:
                    return _save_account(email, u, pw, task_id)

            return None

        except Exception as e:
            report(f"ERROR: {e}", 0, 100)
            traceback.print_exc()
            tasks[task_id]["status"] = "error"
            if order: 
                try: sim5.cancel(order["id"])
                except: pass
            return None
        finally:
            await browser.close()


async def _click_next(page):
    for l in ["Next", "Continue", "I agree", "Agree", "Create account"]:
        try:
            b = page.locator(f'"{l}")').first
            if await b.count() > 0 and await b.is_visible():
                await b.click(timeout=5000); return
        except: pass
    try: await page.keyboard.press("Enter")
    except: pass


async def _fill_(page, yr, mo, dy, g):
    mabbr = MONTH_ABBR[mo]
    mt = page.locator('[role="listbox"]:has-text("Month"),div[aria-label*="Month" i]').first
    if await mt.count() > 0:
        try: await mt.click(force=True, timeout=5000); await asyncio.sleep(0.5)
        except: pass
        await page.keyboard.type(mabbr, delay=30); await asyncio.sleep(0.3)
        await page.keyboard.press("Enter")

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
        try: await gt.click(force=True, timeout=5000); await asyncio.sleep(0.5)
        except: pass
        await page.keyboard.type(gk, delay=50); await asyncio.sleep(0.3)
        await page.keyboard.press("Enter")


def _save_account(email, , , task_id):
    global 
    acc = {
        "email": email, "": , "": ,
        "": datetime.now().isoformat(), "status": "active"
    }
    .append(acc)
    try:
        with open(ACCOUNTS_FILE, "w", encoding="utf-8") as f:
            json.dump(, f, indent=2, ensure_ascii=False)
    except: pass
    
    tasks[task_id] = {"status": "completed", "account": acc, "step": 7, "pct": 100, "log": f"🎉 Created: {email}"}
    return acc


# ── Flask API Endpoints ──
@app.route("/api/gmail/config", methods=["GET", "POST"])
def api_config():
    if request.method == "POST":
        data = request.get_json()
        config.update(data)
        try:
            with open(CONFIG_FILE, "w", encoding="utf-8") as f:
                json.dump(config, f, indent=2)
        except: pass
        return jsonify({"ok": True, "config": config})
    return jsonify(config)


@app.route("/api/gmail/create", methods=["POST"])
def api_create():
    task_id = f"gmail_{int(time.time()*1000)}"
    tasks[task_id] = {"status": "pending", "step": 0, "pct": 0, "log": "Starting..."}
    
    def run():
        asyncio.run(run_registration(task_id, config))
    
    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    
    return jsonify({"task_id": task_id, "status": "started"})


@app.route("/api/gmail/status/<task_id>")
def api_status(task_id):
    task = tasks.get(task_id)
    if not task:
        return jsonify({"error": "Task not found"}), 404
    return jsonify({"task_id": task_id, **task})


@app.route("/api/gmail/")
def api_():
    return jsonify()


@app.route("/api/gmail/stats")
def api_stats():
    total = len()
    active = len([a for a in  if a.get("status") == "active"])
    success_rate = (active / total * 100) if total > 0 else 0
    return jsonify({
        "total": total, "active": active, "success_rate": round(success_rate, 1),
        "last_created": [-1][""] if  else None
    })


@app.route("/api/gmail/delete/<>", methods=["DELETE"])
def api_delete():
    global 
     = [a for a in  if a.get("") != ]
    try:
        with open(ACCOUNTS_FILE, "w", encoding="utf-8") as f:
            json.dump(, f, indent=2, ensure_ascii=False)
    except: pass
    return jsonify({"ok": True})


# ── Static Files ──
@app.route("/gmail-creator")
def serve_ui():
    """Serve the Gmail Creator web UI"""
    ui_path = os.path.join(ROOT, "gmail-creator-ui.html")
    if os.path.exists(ui_path):
        with open(ui_path, "r", encoding="utf-8") as f:
            return f.read()
    return "<h1>UI not found</h1>", 404


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=3010, debug=True)
