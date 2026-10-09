# -*- coding: utf-8 -*-
"""
Quick Gmail registration with Indonesia 5sim numbers
Direct execution — no Flask server needed
"""

import asyncio, json, os, random, re, string, sys, time, traceback
from datetime import datetime

if sys. == "win32":
    try: sys.stdout.reconfigure(encoding="utf-8")
    except: pass

from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.abspath(__file__))
SS = os.path.join(ROOT, "gmail-data", "screenshots")
ACCOUNTS_FILE = os.path.join(ROOT, "gmail-data", ".json")
for d in [os.path.dirname(SS)]: os.makedirs(d, exist_ok=True)

def log(msg): print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)

FIRST = ["James","John","Robert","Michael","David","William","Richard","Joseph","Thomas","Christopher","Daniel","Matthew","Anthony","Mark","Paul","Steven","Andrew"]
LAST = ["Smith","Johnson","Williams","Brown","Jones","Garcia","Miller","Davis","Rodriguez","Martinez","Hernandez","Lopez","Gonzalez","Wilson","Anderson","Thomas"]
MONTH_ABBR = ["","jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"]

FIVESIM_KEY = "eyJhbGciOiJSUzUxMiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE4MTMyMTY4NjUsImlhdCI6MTc4MTY4MDg2NSwicmF5IjoiNjIxMWY0MjAyNmM2YjZkNDMxMjMxYjY0MDkwMzg3MDIiLCJzdWIiOjQyMjIwNTB9.yQynL-xH5YwzT3xvHtoUIJo3l5A2-wQu0_gGnoQ5J7m6rpSR9yTuzWy0GELllhDDjxo3fDTEBDSm5pZBQOIUFJquJAJMnpEH2U0ymOPWkbIe8BNg4KyC9syN7jh9DyHmDi4eio8qP3ZUqNwNH8XnNUncoovECkzEtWtmGDxTsP3sy7lvqPoBSGivkbFvAAzSOs1w6jAntupK_41KuwTBiMig60WD7p7W8xwcQi3df-WohHJ6YNGvFj8MtKBoIY6cIaho56WEbjOUiG39NFtO11yzq9x1jSNhFpbPhk_7wOFlOd-JQNcSmslW-ECeBUyGjBZZnLD3DNSgkRDpR1fWrQ"

import requests as _req

class Sim5:
    B = "https://5sim.net/v1"
    def __init__(self, key): self.s = _req.Session(); self.s.headers.update({"": f"Bearer {key}", "Accept": "application/json"})
    def _g(self, path, params=None, t=20):
        r = self.s.get(f"{self.B}{path}", params=params, timeout=t)
        return r.json() if r.status_code < 400 else None
    def bal(self): d = self._g("/user/profile"); return d.get("balance", 0) if d else 0
    def buy(self, country="indonesia"):
        d = self._g(f"/user/buy/activation/{country}/any/google")
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
    def wait(self, oid, timeout=180, iv=3):
        start = time.time()
        while time.time() - start < timeout:
            r = self.chk(oid)
            if r["s"] == "RECEIVED" and r.get("code"):
                log(f"  [5sim] ✓ CODE: {r['code']} ({int(time.time()-start)}s)"); return r["code"]
            if r["s"] in ("CANCELED", "TIMEOUT", "BANNED", "ERROR"):
                log(f"  [5sim] ✗ {r['s']}"); return None
            time.sleep(iv)
        return None
    def cancel(self, oid): self._g(f"/user/cancel/{oid}")
    def finish(self, oid): self._g(f"/user/finish/{oid}")


async def _next(page):
    for l in ["Next", "Continue", "I agree", "Agree", "Create account"]:
        try:
            b = page.locator(f'"{l}")').first
            if await b.count() > 0 and await b.is_visible():
                await b.click(timeout=5000); return True
        except: pass
    try: await page.keyboard.press("Enter"); return True
    except: return False


async def _fill_bday(page, yr, mo, dy, g):
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


async def main():
    f, l = random.choice(FIRST), random.choice(LAST)
    u = f"{f.lower()}{l.lower()}{random.randint(100, 9999)}"
    pw = random.choice(string.ascii_uppercase) + "".join(random.choices(string.ascii_lowercase, k=5)) + "".join(random.choices(string.digits, k=4)) + "!"
    yr, mo, dy = random.randint(1985, 2000), random.randint(1, 12), random.randint(1, 28)
    g = random.choice(["Male", "Female"])
    email = f"{u}@gmail.com"

    log("="*60)
    log(f"🎯 Target: {email} | {f} {l} | {yr}-{mo:02d}-{dy:02d} {g}")
    log("="*60)

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
            # Warmup
            log("[1] Warmup: browsing Google...")
            await page.goto("https://www.google.com", wait_until="domcontentloaded", timeout=15000)
            await asyncio.sleep(3)

            # Signup
            log("[2] Opening Gmail signup...")
            await page.goto("https://.google.com/signup/v2/webcreateaccount?hl=en&flowName=GlifWebSignIn&flowEntry=SignUp",
                           timeout=30000, wait_until="domcontentloaded")
            await asyncio.sleep(5)

            # Name
            log(f"[3] Name: {f} {l}")
            for s, v in [('"firstName"]', f), ('"lastName"]', l)]:
                inp = page.locator(s).first
                if await inp.count() > 0: await inp.fill(v)
            await _next(page); await asyncio.sleep(random.uniform(4, 6))

            # Birthday
            log(f"[4] Birthday: {mo}/{dy}/{yr} {g}")
            await _fill_bday(page, yr, mo, dy, g)
            await _next(page); await asyncio.sleep(random.uniform(4, 6))

            # Username
            log(f"[5] Username: {u}")
            for lbl in ["Create your own", "Create your own Gmail address"]:
                el = page.locator(f'span:has-text("{lbl}")').first
                if await el.count() > 0:
                    try: await el.click(timeout=3000); break
                    except: pass

            attempts = 0
            while attempts < 6:
                un_inp = page.locator('"Username"]').first
                if await un_inp.count() > 0: await un_inp.fill(u)
                await asyncio.sleep(random.uniform(2, 4))
                await _next(page); await asyncio.sleep(4)

                body = (await page.locator("body").inner_text()).lower()
                curl = page.url.lower()

                if "/gender" in curl:
                    attempts += 1
                    cd = min(5 + attempts * 2, 15)
                    log(f"  ↓ Redirect #{attempts} → {cd}s cooldown")
                    await asyncio.sleep(cd)
                    await _fill_bday(page, yr, mo, dy, g)
                    await _next(page); await asyncio.sleep(4)
                    continue

                if any(k in body for k in ["taken", "already used", "exists"]):
                    u = f"{f.lower()}{l.lower()}{random.randint(100, 9999)}"
                    email = f"{u}@gmail.com"
                    log(f"  taken → {u}")
                    continue

                log(f"  ✓ Accepted: {u}"); break

            if attempts >= 6:
                log("❌ Too many redirects"); return

            await page.screenshot(path=os.path.join(SS, f"after_.png"))

            # 
            log("[6] ...")
            await asyncio.sleep(3)
            try: await page.wait_for_selector('""', timeout=15000)
            except: pass
            pws = page.locator('""')
            pwc = await pws.count()
            if pwc >= 2: await pws.nth(0).fill(pw); await pws.nth(1).fill(pw)
            elif pwc == 1: await pws.nth(0).fill(pw)
            else: log("  ⚠ No pw fields")
            await _next(page); await asyncio.sleep(random.uniform(4, 6))

            # Terms / Skip
            log("[7] Terms & recovery...")
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
                await asyncio.sleep(2)
            await _next(page); await asyncio.sleep(4)

            # Phone Verification
            log("[8] Phone verification...")
            await page.screenshot(path=os.path.join(SS, f"verify_{email.replace('@','_')}.png"))
            body = (await page.locator("body").inner_text()).lower()
            curl = page.url.lower()

            if "" in curl or "mail.google.com" in curl:
                log("🎉 NO VERIFICATION!"); return _save(email, u, pw)

            # Skip button
            skip = False
            for lbl in ["Skip", "Skip for now", "Not now", "Later"]:
                elements = page.locator(f'"{lbl}"),span:has-text("{lbl}")')
                if await elements.count() > 0:
                    await elements.first.click(timeout=5000)
                    log(f"  ✓ Clicked '{lbl}'"); skip = True; await asyncio.sleep(3); break

            if skip:
                curl2 = page.url.lower()
                if "" in curl2 or "mail.google.com" in curl2:
                    log("🎉 SUCCESS!"); return _save(email, u, pw)
                for sl in ["Skip", "Not now", "Next"]:
                    b = page.locator(f'"{sl}")').first
                    if await b.count() > 0: await b.click(timeout=3000); await asyncio.sleep(3); break
                curl3 = page.url.lower()
                if "" in curl3 or "mail.google.com" in curl3:
                    log("🎉 SUCCESS!"); return _save(email, u, pw)

            # Use 5sim Indonesia
            if "phone" in body or "verify" in body or "number" in body:
                sim5 = Sim5(FIVESIM_KEY)
                bal = sim5.bal()
                log(f"  5sim: {bal} RUB")

                if bal < 0.2:
                    log("⚠ Low balance"); return

                order = sim5.buy(country="indonesia")
                if not order:
                    log("⚠ Buy failed"); return

                phone = order["phone"]
                log(f"  📱 Indonesia: {phone} (#{order['id']}, {order['price']}RUB)")

                pi = page.locator('"tel"],"phoneNumber"]').first
                if await pi.count() > 0: await pi.fill(phone)

                await _next(page); await asyncio.sleep(2)

                log("  ⏳ Waiting for SMS code...")
                code = sim5.wait(order["id"], timeout=180, iv=3)

                if code:
                    log(f"  ✓ CODE: {code}")
                    ci = page.locator('"hidden"""])').first
                    if await ci.count() > 0:
                        await ci.fill(code); await _next(page); await asyncio.sleep(6)
                        pu = page.url.lower(); pb = (await page.locator("body").inner_text()).lower()
                        if "" in pb or "wrong" in pb:
                            log("  ✗ Wrong code"); sim5.cancel(order["id"])
                        elif "" in pu or "mail.google.com" in pu or "welcome" in pb:
                            log("🎉 VERIFIED!"); sim5.finish(order["id"])
                            return _save(email, u, pw)
                        elif "signup" not in pu and "verify" not in pu:
                            sim5.finish(order["id"]); return _save(email, u, pw)
                        else:
                            log(f"  ? {pu[:80]}"); sim5.cancel(order["id"])
                else:
                    log("  ✗ No code"); sim5.cancel(order["id"])
            else:
                log(f"  ? {body[:200]}")
                await _next(page); await asyncio.sleep(4)

            await page.screenshot(path=os.path.join(SS, f"final_{email.replace('@','_')}.png"))

        except Exception as e:
            log(f"❌: {e}"); traceback.print_exc()
            if order:
                try: sim5.cancel(order["id"])
                except: pass
        finally:
            await browser.close()


def _save(email, u, pw):
    d = {"email": email, "": u, "": pw, "": datetime.now().isoformat(), "status": "active"}
     = []
    if os.path.exists(ACCOUNTS_FILE):
        with open(ACCOUNTS_FILE, "r", encoding="utf-8") as f:
             = json.load(f)
    .append(d)
    with open(ACCOUNTS_FILE, "w", encoding="utf-8") as f:
        json.dump(, f, indent=2, ensure_ascii=False)
    log(f"  💾 Saved: {email}")
    return d


if __name__ == "__main__":
    asyncio.run(main())
