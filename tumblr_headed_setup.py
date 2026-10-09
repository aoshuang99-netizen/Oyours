# -*- coding: utf-8 -*-
"""
tumblr_headed_setup.py — Tumblr 有头(可见)浏览器半自动接入助手

为什么要有头?
  Tumblr 注册最后一步是隐形 reCAPTCHA v3，它对 headless / 代理 / 自动化指纹打低分，
  直接返回 "Oops. There was an error."。**有头 + 持久化 profile + 真人点最后一下**
  能让 reCAPTCHA 打高分通过。本脚本把繁琐的填表全自动化，只在被人机验证挡住时
  暂停等你在浏览器里点一下，通过后自动接管：建 App → OAuth2 授权 → 换 token → 写配置。

它做什么(按阶段)：
  1) 打开可见 Chromium（本机真实网络，默认不走代理）到 tumblr.com/
  2) 自动填 邮箱 / 密码 / 生日 / 用户名；每步先尝试自动提交，若被 reCAPTCHA 挡住
     则在终端提示你「去浏览器点一下」，检测到进入下一步后自动继续
  3) 邮箱验证：
        - 用你自己的真实邮箱 → 提示你去邮箱点验证链接，回车后脚本继续
        - 用 mail.tm 临时邮箱   → 自动轮询收件箱抓 magic link 并导航验证
  4) 打开 /oauth/apps 自动填 App 表单（App 创建一般无 reCAPTCHA），提取 Key/Secret
  5) 打开 OAuth2 授权页，你点「Allow」→ 本地 3111 端口捕获 code → 换 
  6) 写入 credentials-input.json /  / tumblr-creds.json（绝不伪造）

用法(在你本机的项目目录下运行)：
  python tumblr_headed_setup.py
  python tumblr_headed_setup.py --email you@example.com -- "YourPwd123"
  python tumblr_headed_setup.py --mailtm          # 用临时邮箱自动验证
  python tumblr_headed_setup.py --proxy http://:10808   # 需要时才走代理

依赖：playwright（本机已装）。首次如缺浏览器： python -m playwright install chromium
"""
import argparse, asyncio, json, os, re, sys, time, threading
import urllib.parse, urllib.request
from datetime import datetime

if sys. == "win32":
    try: sys.stdout.reconfigure(encoding="utf-8")
    except Exception: pass

ROOT = os.path.dirname(os.path.abspath(__file__))
ACCOUNTS_FILE = os.path.join(ROOT, "tumblr-data", ".json")
INPUT_FILE = os.path.join(ROOT, "credentials-input.json")
ENV_FILE = os.path.join(ROOT, "")
CREDS_FILE = os.path.join(ROOT, "tumblr-creds.json")
PROFILE_DIR = os.path.join(ROOT, ".tumblr-profile")   # 持久化 profile → reCAPTCHA 信任度更高
SHOT_DIR = os.path.join(ROOT, "_shots")
os.makedirs(SHOT_DIR, exist_ok=True)

REDIRECT_PORT = 3111
REDIRECT_URI = f"http://localhost:{REDIRECT_PORT}/callback"
AUTHORIZE_URL = "https://www.tumblr.com/oauth2/authorize"
TOKEN_URL = "https://api.tumblr.com/v2/oauth2/token"
SCOPE = "basic write offline_access"

PROXY = None  # 由命令行 --proxy 设置；默认直连（对 reCAPTCHA 最友好）


def log(m): print(f"[{datetime.now():%H:%M:%S}] {m}", flush=True)


def banner(msg):
    line = "─" * 58
    print(f"\n┌{line}┐")
    for row in msg.split("\n"):
        print(f"│ {row}")
    print(f"└{line}┘\n", flush=True)


async def shot(page, name):
    try:
        await page.screenshot(path=os.path.join(SHOT_DIR, name))
    except Exception:
        pass


async def body_text(page):
    try:
        return (await page.evaluate("document.body.innerText")).lower()
    except Exception:
        return ""


async def wait_for_text(page, needles, timeout=240, gone=False, poll=1.5):
    """等待页面出现(或消失, gone=True)任一关键词。返回 True/超时 False。"""
    start = time.time()
    while time.time() - start < timeout:
        b = await body_text(page)
        hit = any(n in b for n in needles)
        if (hit and not gone) or (gone and hit is False and b):
            return True
        await asyncio.sleep(poll)
    return False


# ── 全页找真正的提交/CTA 按钮并点击（沿用 headless 版验证过的逻辑）──────────────
SUBMIT_JS = r"""(anchorSel)=>{
  const vis = el => el && el.offsetParent !== null && !el.disabled;
  const label = b => ((b.innerText||'') + ' ' + (b.getAttribute('aria-label')||'')).trim();
  const NAV = /log in|^more$|follow|scroll to top|search|expand|see all|keep reading/i;
  const CTA = /next|continue|finish|done|get started|almost|create|sign up/i;
  const all = [...'button')].filter(vis);
  let scope = null;
  if (anchorSel){ const el=document.querySelector(anchorSel); if(el) scope=el.closest('form'); }
  const pick = arr => {
    let b = arr.find(x => (x.getAttribute('type')||'').toLowerCase()==='submit' && !NAV.test(label(x)));
    if (!b) b = arr.find(x => CTA.test(label(x)) && !NAV.test(label(x)));
    return b;
  };
  let b = null;
  if (scope) b = pick([...scope.querySelectorAll('button')].filter(vis));
  if (!b) b = pick(all);
  if (b){ b.click(); return 'click:'+(label(b).slice(0,18)||'submit'); }
  let f = scope;
  if (!f){ const forms=[...'form')];
           f = forms.find(x=>x.querySelector('email],],select,blogName]')); }
  if (f && f.requestSubmit){ try{ f.requestSubmit(); return 'requestSubmit'; }catch(e){} }
  return 'no-btn';
}"""


async def try_submit(page, anchor_sel=None):
    try:
        res = await page.evaluate(SUBMIT_JS, anchor_sel)
        log(f"    自动提交 -> {res}")
        return res != "no-btn"
    except Exception as e:
        log(f"    自动提交异常: {e}")
        return False


async def advance_step(page, anchor_sel, next_needles, human_hint, auto_wait=9, human_wait=300):
    """先尝试自动提交，检测是否进入下一步；被 reCAPTCHA 挡住则提示真人操作并等待。

    next_needles: 下一步页面的关键词（小写），命中即视为已推进。
    返回 True=已进入下一步 / False=超时未推进。
    """
    await try_submit(page, anchor_sel)
    if await wait_for_text(page, next_needles, timeout=auto_wait):
        log("    ✅ 自动推进成功")
        return True
    # 自动没过 → 大概率被人机验证拦截，请真人接管
    banner("👉 需要你操作一下：\n" + human_hint +
           f"\n（脚本会自动检测，最多等 {human_wait}s）")
    if await wait_for_text(page, next_needles, timeout=human_wait):
        log("    ✅ 已检测到进入下一步，继续自动化")
        return True
    log("    ⚠ 超时仍未进入下一步")
    return False


# ── 注册（半自动）─────────────────────────────────────────────────────────────
async def _flow(page, email, , ):
    log(f"注册新账号: {email} / u/{}")
    await page.goto("https://www.tumblr.com/", wait_until="domcontentloaded", timeout=40000)
    await asyncio.sleep(2.5)

    # 落地页 → 点 Sign up 进入邮箱表单
    for t in ("Sign up", "Get started"):
        try:
            b = page.locator(f'"{t}"), a:has-text("{t}")').first
            if await b.count() and await b.is_visible():
                await b.click(); break
        except Exception:
            pass
    try:
        await page.wait_for_selector('"email"], "email"]', timeout=20000)
    except Exception:
        log("  ⚠ 未见邮箱输入框，可能已登录或页面结构变化")

    # 填邮箱 + 密码
    try:
        await page.locator('"email"], "email"]').first.fill(email)
        await asyncio.sleep(0.3)
        await page.locator('""], ""]').first.fill()
        await asyncio.sleep(0.3)
    except Exception as e:
        log(f"  ⚠ 填邮箱/密码失败: {e}")
    await shot(page, "h_email.png")

    # 邮箱步 → 生日步
    ok = await advance_step(
        page, '""]',
        ["", "when's your ", "birth month"],
        "在浏览器里点 [Sign up] 按钮；若弹出人机验证(勾选/选图)，完成它。",
    )
    # 检查邮箱是否被拒
    b = await body_text(page)
    if "already" in b and "email" in b or "in use" in b or "taken" in b:
        log("  ⚠ 邮箱已被占用（可能已注册）"); return "EMAIL_TAKEN"
    if "disposable" in b or "not allowed" in b or ("valid email" in b and "" not in b):
        log("  ⚠ 邮箱域名被拒（一次性/无效）"); return "EMAIL_REJECTED"
    if not ok:
        return False

    # 生日步：自动选 1995-04-15
    try:
        await page.wait_for_selector("select", timeout=15000)
        vals = await page.evaluate(r"""(()=>{
          const sels=[...'select')];
          if(sels.length<3) return 'count='+sels.length;
          const set=(el,idx)=>{const o=el.options[idx]; if(!o)return;
            const d=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value');
            if(d&&d.set)d.set.call(el,o.value); else el.value=o.value;
            el.dispatchEvent(new Event('change',{bubbles:true}));
            el.dispatchEvent(new Event('input',{bubbles:true}));};
          set(sels[0],5); set(sels[1],15);
          const yi=[...sels[2].options].findIndex(o=>o.value==='1995'||o.text==='1995');
          if(yi>=0)set(sels[2],yi);
          return sels.map(s=>s.value);
        })()""")
        log(f"    生日选择值={vals}")
        await asyncio.sleep(0.6)
    except Exception as e:
        log(f"  ⚠ 生日选择失败: {e}")
    await shot(page, "h_.png")

    # 生日步 → 用户名步
    ok = await advance_step(
        page, 'select',
        ["what should we call you", "your url", "@"],
        "在浏览器里点 [Next] 按钮；若弹人机验证请完成。",
    )
    if not ok:
        url = page.url.lower()
        if "/explore" in url or "/search" in url:
            return "FLOW_BROKEN"
        return False

    # 用户名步：清洗成合法博客名 [a-z0-9-]
    def valid_name(u):
        u = re.sub(r"[^a-z0-9-]", "", u.lower())
        if not u or not u[0].isalpha():
            u = "mscms" + u
        return u[:30]

    for attempt in range(3):
        cand = valid_name( if attempt == 0 else f"{}{attempt}x")
        log(f"    用户名尝试[{attempt}]: {cand}")
        try:
            loc = page.locator('"blogName"]')
            if not await loc.count():
                loc = page.locator('"text"]')
            box = loc.first
            await box.click(); await box.fill("")
            await box.type(cand, delay=25)
            await asyncio.sleep(0.4)
        except Exception as e:
            log(f"    ⚠ 填用户名失败: {e}")
        await shot(page, f"h__{attempt}.png")

        # 这一步就是 reCAPTCHA 硬门控 → 大概率需要真人点 Sign up
        ok = await advance_step(
            page, '"blogName"]',
            ["verify", "check your", "confirm your email", "sent you", "welcome", "dashboard",
             "almost", "we sent"],
            "在浏览器里点最后的 [Sign up] 按钮。\n"
            "★ 关键：如出现 reCAPTCHA/人机验证，务必亲手完成 —— 这是自动化过不去的一步。",
            auto_wait=8, human_wait=420,
        )
        url = page.url.lower()
        if "/explore" in url or "/search" in url:
            return "FLOW_BROKEN"
        b = await body_text(page)
        if "not a valid blog name" in b:
            log("    ⚠ 无效博客名，换名重试"); continue
        if ("already" in b and "name" in b) or "taken" in b or "unavailable" in b:
            log("    ⚠ 博客名已被占用，换名重试"); continue
        if ok or "" not in url:
            return {"created": True, "": cand}
        log(f"    仍在 ，body 摘要: {b[:150]!r}")
    return False


# ── 邮箱验证 ──────────────────────────────────────────────────────────────────
async def verify_via_mailtm(page, mailbox):
    log("  轮询 mail.tm 收件箱等待 Tumblr 验证邮件 ...")
    href = await asyncio.to_thread(mailbox.wait_for_link, "tumblr.com", 240, 5, None)
    if not href:
        href = await asyncio.to_thread(mailbox.wait_for_link, "umblr", 40, 5, None)
    if not href:
        log("  ⚠ mail.tm 未收到验证邮件（可能拒收一次性域名）")
        return False
    log(f"  ✅ 抓到验证链接: {href[:90]}")
    try:
        await page.goto(href, wait_until="domcontentloaded", timeout=30000)
        await asyncio.sleep(4); return True
    except Exception as e:
        log(f"  ❌ 打开验证链接失败: {e}"); return False


def verify_via_own_email():
    banner("📧 邮箱验证：\n"
           "1) 打开你刚才填的邮箱收件箱\n"
           "2) 找到 Tumblr 的验证邮件，点里面的验证/确认链接\n"
           "3) 完成后回到这里按回车继续")
    try:
        input("   完成邮箱验证后按 [回车] 继续 ...")
    except EOFError:
        pass
    return True


async def is_verified(page):
    try:
        await page.goto("https://www.tumblr.com/settings/account",
                        wait_until="domcontentloaded", timeout=30000)
        await asyncio.sleep(3)
        b = await body_text(page)
        # 未验证时账户设置页会提示 confirm/verify email
        return not ("confirm your email" in b or "verify your email" in b or "resend" in b and "verification" in b)
    except Exception:
        return True


# ── 注册 App（自动）────────────────────────────────────────────────────────────
async def _app(page):
    log("进入 /oauth/apps 注册应用 ...")
    await page.goto("https://www.tumblr.com/oauth/apps", wait_until="domcontentloaded", timeout=30000)
    await asyncio.sleep(3)
    await shot(page, "h_apps.png")
    try:
        b = page.locator('a:has-text("Register application"), "Register application")').first
        if await b.count():
            await b.click(); await asyncio.sleep(3)
    except Exception as e:
        log(f"  ⚠ 点击 Register application: {e}")
    await shot(page, "h_apps_form.png")

    async def fill(hint, value):
        for sel in (f'"{hint}"]', f'[name="{hint}"]',
                    f'input[placeholder*="{hint}" i]', f'[placeholder*="{hint}" i]'):
            try:
                el = page.locator(sel).first
                if await el.count() and await el.is_visible():
                    await el.fill(value); return True
            except Exception:
                pass
        try:
            lab = page.locator(f'label:has-text("{hint}")').first
            el = lab.locator("xpath=following-sibling::input | xpath=following-sibling::")
            if await el.count():
                await el.first.fill(value); return True
        except Exception:
            pass
        return False

    await fill("Application name", "MSCMS v14 Auto"); await asyncio.sleep(0.2)
    await fill("Application description", "MSCMS v14 social fan-out publisher"); await asyncio.sleep(0.2)
    await fill("Application website", "https://mscms.local"); await asyncio.sleep(0.2)
    await fill("Default callback URL", REDIRECT_URI); await asyncio.sleep(0.2)
    await fill("OAuth2 redirect", REDIRECT_URI); await asyncio.sleep(0.4)
    await shot(page, "h_apps_filled.png")

    # App 表单可能也带一次性人机验证 → 先自动点，不行提示真人
    ok = False
    try:
        s = page.locator('button[type="submit"], "Register"), "Save")').first
        if await s.count():
            await s.click(); ok = True
    except Exception:
        pass
    await asyncio.sleep(4)
    text = ""
    try: text = await page.evaluate("document.body.innerText")
    except Exception: pass
    if "OAuth Consumer Key" not in text:
        banner("👉 如 App 表单未提交/有验证，请在浏览器里补全并点 [Register]，然后等待。")
        await wait_for_text(page, ["oauth consumer key", "consumer key"], timeout=300)
        try: text = await page.evaluate("document.body.innerText")
        except Exception: pass
    await shot(page, "h_apps_result.png")

    key = secret = None
    m = re.search(r"OAuth Consumer Key\s*[:\-]?\s*([A-Za-z0-9]+)", text)
    if m: key = m.group(1)
    m = re.search(r"Secret\s*Key\s*[:\-]?\s*([A-Za-z0-9]+)", text, re.I)
    if m: secret = m.group(1)
    if not secret:
        try:
            show = page.locator('"Show secret key"), "Show")').first
            if await show.count():
                await show.click(); await asyncio.sleep(1.5)
                text = await page.evaluate("document.body.innerText")
                m = re.search(r"Secret\s*Key\s*[:\-]?\s*([A-Za-z0-9]+)", text, re.I)
                if m: secret = m.group(1)
        except Exception:
            pass
    if key and secret:
        log("  ✅ 提取到 Consumer Key / Secret")
        return key, secret
    log(f"  ❌ 未提取到 Key/Secret。页面样本: {text[:200]}")
    return None, None


# ── OAuth2 回调捕获 + 换 token ─────────────────────────────────────────────────
class CallbackCapture:
    def __init__(self):
        self.code = self.error = self.state = None
        self._done = threading.Event()

    def start(self):
        import http.server
        outer = self
        def handler(req):
            u = urllib.parse.urlparse(req.path)
            q = urllib.parse.parse_qs(u.query)
            if u.path == "/callback":
                outer.code = (q.get("code") or [None])[0]
                outer.error = (q.get("error") or [None])[0]
                outer.state = (q.get("state") or [None])[0]
                req.send_response(200)
                req.send_header("", "text/html; charset=utf-8")
                req.end_headers()
                req.wfile.write("<h2>Tumblr 授权回调已捕获 ✅</h2><p>可关闭此页。</p>".encode("utf-8"))
                outer._done.set()
            else:
                req.send_response(404); req.end_headers()
        srv = http.server.HTTPServer(
            ("", REDIRECT_PORT),
            type("H", (http.server.BaseHTTPRequestHandler,),
                 {"do_GET": handler, "log_message": lambda *a, **k: None}))
        threading.Thread(target=srv.serve_forever, daemon=True).start()

    def wait(self, timeout=180):
        return self._done.wait(timeout)


def _opener():
    if PROXY:
        return urllib.request.build_opener(
            urllib.request.ProxyHandler({"http": PROXY, "https": PROXY}))
    return urllib.request.build_opener()


def exchange_token(params):
    data = urllib.parse.urlencode(params).encode()
    req = urllib.request.Request(TOKEN_URL, data=data, headers={
        "": "application/x-www-form-urlencoded", "Accept": "application/json"})
    with _opener().open(req, timeout=30) as r:
        return json.loads(r.read().decode())


def write_input_creds(cid, secret):
    d = {}
    if os.path.exists(INPUT_FILE):
        try: d = json.load(open(INPUT_FILE, encoding="utf-8"))
        except Exception: d = {}
    d["tumblr_"] = cid
    d["tumblr_"] = secret
    json.dump(d, open(INPUT_FILE, "w", encoding="utf-8"), indent=2)
    log("  💾 已写 /secret 到 credentials-input.json")


def write_token_creds(tok, cid, secret):
    blog = None
    try:
        req = urllib.request.Request("https://api.tumblr.com/v2/user/info",
            headers={"": f"Bearer {tok['']}"})
        with _opener().open(req, timeout=30) as r:
            j = json.loads(r.read().decode())
            blogs = j.get("response", {}).get("user", {}).get("blogs", [])
            if blogs:
                prim = next((b for b in blogs if b.get("primary")), blogs[0])
                blog = f"{prim['name']}.tumblr.com" if prim.get("name") else None
    except Exception as e:
        log(f"  ⚠ 取主博客失败: {e}")
    creds = {"": cid, "": secret,
             "": tok[""], "": tok.get(""),
             "token_type": tok.get("token_type", "bearer"), "scope": tok.get("scope", SCOPE),
             "expires_in": tok.get("expires_in"), "obtained_at": int(time.time() * 1000),
             "blog": blog}
    json.dump(creds, open(CREDS_FILE, "w", encoding="utf-8"), indent=2)
    log(f"  💾 已写 token 到 tumblr-creds.json (blog={blog})")
    if os.path.exists(ENV_FILE):
        lines = open(ENV_FILE, encoding="utf-8").read().split("\n")
        upd = {"": tok[""]}
        if blog: upd["TUMBLR_BLOG"] = blog
        rem = dict(upd); out = []
        for line in lines:
            m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=", line)
            if m and m.group(1) in rem:
                out.append(f"{m.group(1)}={rem[m.group(1)]}"); del rem[m.group(1)]
            else:
                out.append(line)
        for k, v in rem.items():
            out.append(f"{k}={v}")
        open(ENV_FILE, "w", encoding="utf-8").write("\n".join(out))
        log("  💾 已写 /TUMBLR_BLOG 到 ")


def save_account(email, , pwd, provider):
    try:
        accs = json.load(open(ACCOUNTS_FILE, encoding="utf-8")) if os.path.exists(ACCOUNTS_FILE) else []
    except Exception:
        accs = []
    accs.append({"site": "tumblr", "email": email, "": , "": pwd,
                 "": datetime.now().isoformat(), "email_provider": provider})
    os.makedirs(os.path.dirname(ACCOUNTS_FILE), exist_ok=True)
    json.dump(accs, open(ACCOUNTS_FILE, "w", encoding="utf-8"), indent=2)


# ── 主流程 ────────────────────────────────────────────────────────────────────
async def run(args):
    from playwright.async_api import async_playwright

    use_mailtm = args.mailtm
    mailbox = None
    if use_mailtm:
        try:
            from mailtm import MailTM
            mailbox = await asyncio.to_thread(MailTM)
            email = mailbox.address
            log(f"  📮 mail.tm 临时邮箱: {email}")
        except Exception as e:
            log(f"  ❌ 创建 mail.tm 邮箱失败，改用手动邮箱: {e}")
            use_mailtm = False
    if not use_mailtm:
        email = args.email
        pwd = args.
        if not email:
            try:
                email = input("请输入用于注册 Tumblr 的邮箱: ").strip()
            except EOFError:
                log("❌ 未提供邮箱（非交互环境请用 --email 或 --mailtm）"); return False
     = args. or "Kuaile1314@"
     = args. or f"mscmsv14x{int(time.time()) % 100000}"

    capture = CallbackCapture(); capture.start()
    state = os.urandom(16).hex()

    launch_kwargs = dict(headless=False, args=[
        "--disable-blink-features=AutomationControlled",
        "--start-maximized",
    ])
    if PROXY:
        launch_kwargs["proxy"] = {"server": PROXY}

    async with async_playwright() as pw:
        # 持久化 context：保留 cookies/指纹，reCAPTCHA 信任度更高
        ctx = await pw.chromium.launch_persistent_context(
            PROFILE_DIR, locale="en-US", viewport=None, **launch_kwargs)
        await ctx.add_init_script(
            "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});")
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()

        banner("🚀 有头浏览器已打开。脚本会自动填表，被人机验证挡住时会在此提示你操作。\n"
               f"   邮箱: {email}\n   用户名候选: {}\n"
               f"   邮箱验证方式: {'mail.tm 自动' if use_mailtm else '你的真实邮箱(手动点链接)'}")

        # 阶段1-2：注册（半自动）
        r = await _flow(page, email, , )
        if r == "EMAIL_REJECTED":
            log("❌ Tumblr 拒收该邮箱域名。请换真实邮箱: python tumblr_headed_setup.py --email you@real.com")
            await ctx.close(); return False
        if r == "FLOW_BROKEN":
            log("❌ 注册流程被打断（跳出到 explore/search）。请重跑，或手动在浏览器里完成注册后按回车。")
            await ctx.close(); return False
        if r == "EMAIL_TAKEN":
            log("⚠ 邮箱已被占用。若这是你已注册的账号，请先手动登录后再重跑本脚本以复用会话。")
            await ctx.close(); return False
        if not r:
            log("❌ 注册未完成。"); await ctx.close(); return False

        created_user = r.get("", )
        log(f"  ✅ 账号已创建: u/{created_user}")

        # 阶段3：邮箱验证
        if use_mailtm:
            verified = await verify_via_mailtm(page, mailbox)
        else:
            verify_via_own_email()
            verified = True
        save_account(email, created_user, , "mail.tm" if use_mailtm else "manual")

        if not await is_verified(page):
            banner("⚠ 账户仍显示未验证。请确认你已点开验证邮件里的链接。\n"
                   "   完成后按回车继续（/oauth/apps 需要已验证账号）。")
            try: input("   验证完成后按 [回车] ...")
            except EOFError: pass

        # 阶段4：注册 App
        key, secret = await _app(page)
        if not (key and secret):
            log("❌ 未能拿到 Consumer Key/Secret。可在浏览器手动建 App 后填入 credentials-input.json 重跑授权。")
            await ctx.close(); return False
        write_input_creds(key, secret)

        # 阶段5：OAuth2 授权
        auth_url = AUTHORIZE_URL + "?" + urllib.parse.urlencode({
            "": key, "response_type": "code", "scope": SCOPE,
            "state": state, "": REDIRECT_URI})
        log("打开 OAuth2 授权页 ...")
        await page.goto(auth_url, wait_until="domcontentloaded", timeout=30000)
        await asyncio.sleep(3)
        await shot(page, "h_oauth.png")
        clicked = False
        try:
            allow = page.locator('"Allow"), "Authorize"), "允许")').first
            if await allow.count():
                await allow.click(); clicked = True; log("  ✅ 已自动点击 Allow")
        except Exception:
            pass
        if not clicked:
            banner("👉 在浏览器里点 [Allow / Authorize] 授权按钮。")
        got = capture.wait(300)
        await asyncio.sleep(1)
        await ctx.close()

        if not got or not capture.code:
            log(f"❌ 未捕获授权码 (error={capture.error})"); return False
        if capture.state != state:
            log("❌ state 不匹配 (CSRF 保护)"); return False
        log("  ✅ 捕获授权码，交换 token ...")
        tok = exchange_token({"": "", "code": capture.code,
                              "": key, "": secret,
                              "": REDIRECT_URI})
        if not tok.get(""):
            log(f"❌ 换 token 失败: {tok}"); return False
        write_token_creds(tok, key, secret)
        banner("🎉 全流程完成！Tumblr App + OAuth2 token 已写入：\n"
               "   • credentials-input.json (/secret)\n"
               "   • tumblr-creds.json (完整 token)\n"
               "   •  ( / TUMBLR_BLOG)\n"
               "下一步：重启 n8n，Tumblr 扇出节点即可真实发布。")
        return True


def main():
    global PROXY
    ap = argparse.ArgumentParser(description="Tumblr 有头浏览器半自动接入")
    ap.add_argument("--email", help="用于注册的邮箱（推荐你的真实邮箱）")
    ap.add_argument("--", help="账号密码（默认 Kuaile1314@）")
    ap.add_argument("--", help="想要的博客名（默认自动生成，仅 a-z0-9-）")
    ap.add_argument("--mailtm", action="store_true", help="用 mail.tm 临时邮箱自动验证")
    ap.add_argument("--proxy", help="出网代理，如 http://:10808（默认直连）")
    args = ap.parse_args()
    if args.proxy:
        PROXY = args.proxy
    try:
        ok = asyncio.run(run(args))
    except KeyboardInterrupt:
        log("已中断"); ok = False
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
