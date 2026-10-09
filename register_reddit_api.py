# -*- coding: utf-8 -*-
"""
_reddit_api.py — Reddit Registration via API (NO Playwright needed)
Uses POST /api/ with reCAPTCHA solved via 2captcha.
"""
import json, os, random, re, string, sys, time
from datetime import datetime
import requests

ROOT = os.path.dirname(os.path.abspath(__file__))
ACCOUNTS = os.path.join(ROOT, "reddit-data", ".json")
os.makedirs(os.path.dirname(ACCOUNTS), exist_ok=True)

def log(msg): print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)

# ========== CONFIG ==========
TWOCAPTCHA_KEY = "ec6ff4cca146b810a53ad5d6f7d59ff1"
EMAIL_DOMAIN = "hlua.cc.cd"
REDDIT_SITEKEY = "6LeTnxkTAAAAAN9QEuDZRpn90WwKk_R1TRW_g-JC"

ADJ = ["Cool","Swift","Brave","Dark","Lucky","Wild","Epic","Neon","Cyber","Zen",
       "Mega","Ultra","Super","Hyper","Alpha","Omega","Nova","Star","Blaze","Storm"]
NOUN = ["Fox","Wolf","Hawk","Bear","Lion","Tiger","Eagle","Falcon","Shark","Raven",
        "Phoenix","Dragon","Viper","Cobra","Lynx","Jaguar","Crow","Owl","Bat","Manta"]


def solve_recaptcha(sitekey, page_url, timeout=120):
    """Solve reCAPTCHA v2 via 2captcha."""
    log("  [2captcha] Solving reCAPTCHA v2...")
    
    r = requests.post("https://api.2captcha.com/createTask", json={
        "clientKey": TWOCAPTCHA_KEY,
        "task": {
            "type": "RecaptchaV2TaskProxyless",
            "websiteURL": page_url,
            "websiteKey": sitekey,
        }
    }, timeout=15)
    data = r.json()
    
    if data.get("errorId") != 0:
        log(f"  [2captcha] Error: {data.get('errorDescription')}")
        return None
    
    task_id = data["taskId"]
    log(f"  [2captcha] Task: {task_id}, waiting...")
    
    st = time.time()
    while time.time() - st < timeout:
        time.sleep(4)
        r2 = requests.post("https://api.2captcha.com/getTaskResult", json={
            "clientKey": TWOCAPTCHA_KEY, "taskId": task_id
        }, timeout=10)
        d2 = r2.json()
        if d2.get("status") == "ready":
            token = d2[""][""]
            log(f"  [2captcha] Solved in {int(time.time()-st)}s")
            return token
        if d2.get("errorId") != 0:
            log(f"  [2captcha] Error: {d2.get('errorDescription')}")
            return None
    
    log("  [2captcha] Timeout")
    return None


def do_(attempt_num):
     = f"{random.choice(ADJ)}{random.choice(NOUN)}{random.randint(100,9999)}"
    pw = (random.choice(string.ascii_uppercase) + 
          "".join(random.choices(string.ascii_lowercase, k=8)) + 
          "".join(random.choices(string.digits, k=3)) + 
          random.choice("!@#$"))
    email = f"{.lower()}@{EMAIL_DOMAIN}"
    
    log(f"\n{'='*50}")
    log(f"REDDIT API #{attempt_num} | u/{}")
    log(f"{'='*50}")
    log(f"  Email:    {email}")
    log(f"  : {pw}")
    
    # Solve captcha
    token = solve_recaptcha(REDDIT_SITEKEY, "https://www.reddit.com/")
    if not token:
        log("  ❌ Captcha failed")
        return None
    
    # Register via Reddit API
    log("  [Reddit] Registering...")
    s = requests.Session()
    s.headers.update({
        "": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Origin": "https://www.reddit.com",
        "Referer": "https://www.reddit.com//",
    })
    
    # Get initial cookies (might fail if blocked, that's OK)
    try: s.get("https://www.reddit.com/", timeout=10)
    except: pass
    
    # Submit registration
    try:
        r = s.post("https://www.reddit.com/api/", data={
            "op": "reg",
            "user": ,
            "passwd": pw,
            "passwd2": pw,
            "email": email,
            "captcha": token,
            "api_type": "json",
        }, timeout=30)
    except requests.exceptions.Timeout:
        log("  ❌ Reddit API timeout — connection blocked (need proxy)")
        return None
    except Exception as e:
        log(f"  ❌ Network error: {e}")
        return None
    
    log(f"  Status: {r.status_code}")
    
    try:
        resp = r.json()
    except:
        log(f"  Non-JSON response: {r.text[:300]}")
        return None
    
    # Check response
    errors = resp.get("json", {}).get("errors", [])
    
    if not errors:
        log(f"  🎉 SUCCESS! u/{}")
        save(email, , pw)
        return {"": , "email": email, "": pw}
    
    # Analyze errors
    for err in errors:
        err_type = err[0] if len(err) > 0 else "UNKNOWN"
        err_msg = err[1] if len(err) > 1 else ""
        log(f"  Error: [{err_type}] {err_msg}")
        
        if err_type == "RATELIMIT":
            log("  ⚠ Rate limited — waiting 60s...")
            time.sleep(60)
            return None
        
        if err_type in ("BAD_CAPTCHA", "INCORRECT_CAPTCHA"):
            log("  ⚠ Captcha rejected — wrong sitekey or expired token")
            return None
        
        if "USERNAME_TAKEN" in err_type or "taken" in err_msg.lower():
            log("  ⚠ Username taken")
            return None
        
        if "EMAIL" in err_type or "email" in err_msg.lower():
            log(f"  ⚠ Email issue: {err_msg}")
    
    return None


def save(email, , ):
    d = {"site": "reddit", "email": email, "": , "": , 
         "": datetime.now().isoformat()}
    a = []
    if os.path.exists(ACCOUNTS):
        try:
            with open(ACCOUNTS, "r", encoding="utf-8") as f: a = json.load(f)
        except: a = []
    a.append(d)
    with open(ACCOUNTS, "w", encoding="utf-8") as f: json.dump(a, f, indent=2)
    log(f"  💾 Saved to .json")


def main():
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    
    log(f"\n{'='*50}")
    log(f"REDDIT API REGISTRATOR")
    log(f"2captcha: ${requests.get(f'https://2captcha.com/res.php?key={TWOCAPTCHA_KEY}&action=', timeout=10).text}")
    log(f"Email: @{EMAIL_DOMAIN}")
    log(f"{'='*50}")
    
    results = []
    for i in range(1, count + 1):
        r = do_(i)
        if r:
            results.append(r)
            log(f"✅ u/{r['']}")
        else:
            log(f"❌ FAILED")
        log(f"Progress: {len(results)}/{i}")
        
        if i < count:
            wait = random.randint(5, 10)
            log(f"  Cooling {wait}s...")
            time.sleep(wait)
    
    log(f"\n{'='*50}")
    log(f"DONE: {len(results)}/{count}")
    for r in results:
        log(f"  u/{r['']} | {r['']} | {r['email']}")
    log(f"{'='*50}")
    
    return results


if __name__ == "__main__":
    main()
