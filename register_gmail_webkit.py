# -*- coding: utf-8 -*-
"""
_gmail_webkit.py — WEBKIT (Safari engine)
WebKit has completely different browser internals, harder for Google to fingerprint.
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
for d in [SS]: os.makedirs(d, exist_ok=True)
def log(msg): print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)

FIVESIM_KEY = "eyJhbGciOiJSUzUxMiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE4MTM3MzQ3ODEsImlhdCI6MTc4MjE5ODc4MSwicmF5IjoiNjIxMWY0MjAyNmM2YjZkNDMxMjMxYjY0MDkwMzg3MDYiLCJzdWIiOjQyMjIwNTB9.wRPYREkUdv60wd68XujZqXlravtg01aMWYECx0Bl1fLqC2uxL2yELzAIWIG_b_yAhKrymtxV5XsGlCpBm_uapnwJZhUw7LyHHnYl_V6weL6uEvk2ayrcIhaUCa13RORmRen8fXdrElnO_flZqQpeJRqm7gpUQF-HSy8Az3iy3j0JWvW9pfg_sAZTCA6vlADn66lrZ36O5g3NiKoTtTB0SYo8lfzFxtBbROc6gSMg_46dmn1hjNgJB6cetJ33DLQ1UJCuckcjV_lVfiPIMYT51RIqaRS8zyPaCTT8938whKFHbbJgWpne-6ldHmdeDudWDtytElk7d204shjBL1q1ww"
PROXY_URL = "http://:8090"
FIRST = ["James","John","Robert","David","William","Richard","Joseph","Thomas","Christopher","Daniel","Matthew","Anthony","Mark","Paul","Steven","Andrew","Kenneth","George","Brian"]
LAST = ["Smith","Johnson","Williams","Brown","Jones","Garcia","Miller","Davis","Rodriguez","Martinez","Hernandez","Lopez","Gonzalez","Wilson","Anderson","Thomas","Taylor","Moore","Jackson"]

import requests as _req
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


async def do_(attempt_num):
    f, l = random.choice(FIRST), random.choice(LAST)
    uname = f"{f.lower()}{l.lower()}{random.randint(100,9999)}"
    pw = (random.choice(string.ascii_uppercase) + "".join(random.choices(string.ascii_lowercase,k=6)) + "".join(random.choices(string.digits,k=4)) + "!")
    yr, mo, dy = random.randint(1985,2000), random.randint(1,12), random.randint(1,28)
    g = random.choice(["Male","Female"])
    email = f"{uname}@gmail.com"
    ma = ["","jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"]
    mf = ["","January","February","March","April","May","June","July","August","September","October","November","December"]
    
    log(f"\n{'='*50}")
    log(f"WEBKIT #{attempt_num} | {email} | {mf[mo]} {dy}, {yr} | {g}")
    log(f"{'='*50}")
    
    browser = None
    try:
        async with async_playwright() as pw:
            browser = await pw.webkit.launch(
                headless=False,
                proxy={"server": PROXY_URL}
            )
            context = await browser.new_context(
                viewport={"width":1440,"height":900},
                locale="en-US",
                timezone_id="America/Los_Angeles",
                geolocation={"latitude":34.05,"longitude":-118.24},
            )
            page = await context.new_page()
            
            # WebKit anti-detection
            await page.add_init_script("""
                delete navigator.__proto__.webdriver;
                Object.defineProperty(navigator, 'webdriver', {get: () => false});
                Object.defineProperty(navigator, 'plugins', {get: () => {
                    let p = [{name:'WebKit built-in PDF',filename:'',description:''}];
                    p.item = (i) => p[i]; p.namedItem = (n) => p[0]; p.refresh = () => {};
                    p.length = 1;
                    return Object.setPrototypeOf(p, PluginArray.prototype);
                }});
                Object.defineProperty(navigator, 'languages', {get: () => ['en-US','en']});
                Object.defineProperty(navigator, 'hardwareConcurrency', {get: () => 8});
            """)
            
            log("[1] Signup...")
            await page.goto("https://.google.com/signup/v2/webcreateaccount?hl=en&flowName=GlifWebSignIn&flowEntry=SignUp", timeout=40000, wait_until="domcontentloaded")
            await asyncio.sleep(4)
            
            # Name
            log(f"[2] {f} {l}")
            for sel,val in [('"firstName"]',f),('"lastName"]',l)]:
                inp = page.locator(sel).first
                if await inp.count()>0:
                    await inp.click(timeout=3000); await asyncio.sleep(0.2)
                    await inp.type(val, delay=random.randint(60,150))
                    await asyncio.sleep(random.uniform(0.3,0.6))
            
            for n in ['"Next")']:
                b = page.locator(n).first
                if await b.count()>0: await b.click(timeout=5000); break
            await asyncio.sleep(5)
            
            # Birthday
            log(f"[3] {mf[mo]} {dy} {yr} {g}")
            await page.wait_for_selector('input,select,[role="button"]',timeout=10000)
            await asyncio.sleep(1)
            
            await page.evaluate(f"""
                (()=>{{
                    const m=document.querySelector('#month,select[name="month"]');
                    const d=document.querySelector('#day,"day"]');
                    const y=document.querySelector('#year,"year"]');
                    const gd=document.querySelector('#gender,select[name="gender"]');
                    if(m){{m.selectedIndex={mo-1};m.dispatchEvent(new Event('change',{{bubbles:true}}));}}
                    if(d){{d.value='{dy}';d.dispatchEvent(new Event('input',{{bubbles:true}}));d.dispatchEvent(new Event('change',{{bubbles:true}}));}}
                    if(y){{y.value='{yr}';y.dispatchEvent(new Event('input',{{bubbles:true}}));y.dispatchEvent(new Event('change',{{bubbles:true}}));}}
                    if(gd){{gd.selectedIndex={'1'if g=='Male'else'2'};gd.dispatchEvent(new Event('change',{{bubbles:true}}));}}
                }})()
            """)
            await asyncio.sleep(0.5)
            
            for target,sel,txt in [("M",'span:has-text("Month")',ma[mo]),("G",'span:has-text("Gender")',"m"if g=="Male" else"f")]:
                el=page.locator(sel).first
                if await el.count()>0:
                    try:
                        await el.click(force=True,timeout=3000); await asyncio.sleep(0.5)
                        await page.keyboard.type(txt,delay=80); await asyncio.sleep(0.3)
                        await page.keyboard.press("Enter"); await asyncio.sleep(0.2)
                    except: pass
            await page.keyboard.press("Escape"); await asyncio.sleep(0.2)
            await page.keyboard.press("Escape")
            
            delay = random.uniform(2,4)
            await asyncio.sleep(delay)
            
            for n in ['"Next")']:
                b = page.locator(n).first
                if await b.count()>0: await b.click(force=True,timeout=5000); break
            await asyncio.sleep(6)
            
            curl=page.url.lower()
            log(f"    URL: {curl[:80]}")
            
            if "gender" in curl:
                log("    Redirected")
                return None
            
            # Username
            log(f"[4] {uname}")
            for cl in ['span:has-text("Create your own")']:
                el=page.locator(cl).first
                if await el.count()>0:
                    try: await el.click(timeout=3000); await asyncio.sleep(2); break
                    except: pass
            
            uin=page.locator('"Username"]').first
            if await uin.count()>0:
                await uin.click(timeout=3000); await asyncio.sleep(0.5)
                await uin.type(uname,delay=random.randint(50,100)); await asyncio.sleep(1)
            
            for n in ['"Next")']:
                b=page.locator(n).first
                if await b.count()>0: await b.click(force=True,timeout=5000); break
            await asyncio.sleep(6)
            
            if "gender" in page.url.lower():
                log("    Anti-bot")
                return None
            log("    Accepted!")
            
            # 
            log("[5] ")
            pws=page.locator('""]')
            pc=await pws.count()
            if pc>=2: await pws.nth(0).fill(pw); await pws.nth(1).fill(pw)
            elif pc==1: await pws.nth(0).fill(pw)
            
            for n in ['"Next")']:
                b=page.locator(n).first
                if await b.count()>0: await b.click(force=True,timeout=5000); break
            await asyncio.sleep(5)
            
            # Terms
            body=(await page.locator("body").inner_text()).lower()
            if "terms" in body or "privacy" in body:
                for l in ["I agree","Agree"]:
                    b=page.locator(f'"{l}")').first
                    if await b.count()>0: await b.click(timeout=3000); break
                await asyncio.sleep(3)
            if "skip" in body or "recovery" in body:
                for l in ["Skip","Not now"]:
                    b=page.locator(f'"{l}")').first
                    if await b.count()>0: await b.click(timeout=3000); break
                await asyncio.sleep(2)
            
            for n in ['"Next")']:
                b=page.locator(n).first
                if await b.count()>0: await b.click(force=True,timeout=5000); break
            await asyncio.sleep(5)
            
            # Phone
            await page.screenshot(path=os.path.join(SS,f"wk_phone_{attempt_num}.png"))
            curl=page.url.lower()
            body=(await page.locator("body").inner_text()).lower()
            log(f"    URL: {curl[:100]}")
            
            if any(k in curl or k in body for k in ["","mail.google","welcome"]):
                return save(email,uname,pw)
            
            for lbl in ["Skip","Skip for now","Not now","Later","I prefer"]:
                b=page.locator(f'"{lbl}"),span:has-text("{lbl}")').first
                if await b.count()>0: await b.click(timeout=5000); await asyncio.sleep(3); break
            
            if any(k in page.url.lower() for k in ["","mail.google"]):
                return save(email,uname,pw)
            
            if any(k in body for k in ["verify","phone","number","confirm"]):
                sim5=Sim5(FIVESIM_KEY)
                if sim5.bal()<0.5: return None
                order=sim5.buy()
                if not order: return None
                log(f"    +{order['phone']} ({order['price']}RUB)")
                pi=page.locator('"tel"],"phoneNumber"]').first
                if await pi.count()>0: await pi.fill(order["phone"]); await asyncio.sleep(1)
                for n in ['"Next")']:
                    b=page.locator(n).first
                    if await b.count()>0: await b.click(force=True,timeout=5000); break
                await asyncio.sleep(3)
                code=sim5.wait(order["id"])
                if code:
                    log(f"    CODE:{code}")
                    ci=page.locator('"hidden"""])').first
                    if await ci.count()>0: await ci.fill(code)
                    for n in ['"Next")']:
                        b=page.locator(n).first
                        if await b.count()>0: await b.click(force=True,timeout=5000); break
                    await asyncio.sleep(6)
                    body=(await page.locator("body").inner_text()).lower()
                    if "" in body: sim5.cancel(order["id"])
                    elif any(k in page.url.lower() or k in body for k in ["","welcome","mail.google"]):
                        sim5.finish(order["id"]); return save(email,uname,pw)
                    else: sim5.cancel(order["id"])
                else: sim5.cancel(order["id"])
            
            if any(k in page.url.lower() for k in ["","mail.google","welcome"]):
                return save(email,uname,pw)
            
            return None
    except Exception as e:
        log(f"Error: {e}"); traceback.print_exc()
        return None
    finally:
        if browser:
            try: await browser.close()
            except: pass

def save(email,uname,pw):
    d={"email":email,"":uname,"":pw,"":datetime.now().isoformat()}
    a=[]
    if os.path.exists(ACCOUNTS):
        try:
            with open(ACCOUNTS,"r",encoding="utf-8") as f: a=json.load(f)
        except: a=[]
    a.append(d)
    with open(ACCOUNTS,"w",encoding="utf-8") as f: json.dump(a,f,indent=2)
    log(f"  Saved:{email}")
    return d

async def main():
    count=int(sys.argv[1]) if len(sys.argv)>1 else 1
    log(f"\n{'='*40}")
    log(f"WEBKIT GMAIL REGISTRATOR")
    log(f"5sim:{Sim5(FIVESIM_KEY).bal()}RUB")
    log(f"{'='*40}")
    r=[]
    for i in range(1,count+1):
        x=await do_(i)
        if x: r.append(x); log(f"SUCCESS:{x['email']}")
        else: log(f"FAILED")
        log(f"Progress:{len(r)}/{i}")
    log(f"\nDONE:{len(r)}/{count}")
    for x in r: log(f"  {x['email']}|{x['']}")

if __name__=="__main__":
    asyncio.run(main())
