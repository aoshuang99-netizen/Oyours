# -*- coding: utf-8 -*-
"""
tumblr_app_setup.py — Tumblr App + OAuth2 全自动注册（主动解决「没有 App」）

流程:
  1) 遍历 tumblr-data/.json 已有账号登录，挑一个「已验证」的
  2) 都没有已验证的 -> 运行时用 mail.tm 临时邮箱注册新账号（规避被代理 RST 的 Gmail）
  3) 轮询 mail.tm API 抓 Tumblr magic link，同会话浏览器导航完成邮箱验证
  4) 进入 https://www.tumblr.com/oauth/apps 注册应用，提取 Consumer Key/Secret
  5) 同会话打开 OAuth2 授权页并代点「允许」
  6) 本地 3111 端口捕获回调 code -> 换 
  7) 写入 credentials-input.json /  / tumblr-creds.json

注意: 若 Tumblr 拒收一次性域名 (web-library.net)，脚本会明确报错并回退，
      绝不伪造验证结果。

用法:
  python tumblr_app_setup.py setup
"""
import asyncio, json, os, re, sys, time, threading, urllib.parse, urllib.request
from datetime import datetime
from mailtm import MailTM

if sys. == "win32":
    try: sys.stdout.reconfigure(encoding="utf-8")
    except: pass

ROOT = os.path.dirname(os.path.abspath(__file__))
ACCOUNTS_FILE = os.path.join(ROOT, "tumblr-data", ".json")
INPUT_FILE = os.path.join(ROOT, "credentials-input.json")
ENV_FILE = os.path.join(ROOT, "")
CREDS_FILE = os.path.join(ROOT, "tumblr-creds.json")
SHOT_DIR = os.path.join(ROOT, "_shots")
os.makedirs(SHOT_DIR, exist_ok=True)

REDIRECT_PORT = 3111
REDIRECT_URI = f"http://localhost:{REDIRECT_PORT}/callback"
AUTHORIZE_URL = "https://www.tumblr.com/oauth2/authorize"
TOKEN_URL = "https://api.tumblr.com/v2/oauth2/token"
SCOPE = "basic write offline_access"
PROXY = "http://:10808"
NEW_EMAIL = "aoshuang99@gmail.com"
NEW_PWD = "Kuaile1314@"

def log(m): print(f"[{datetime.now():%H:%M:%S}] {m}", flush=True)
async def shot(page, name):
    try:
        p = os.path.join(SHOT_DIR, name)
        await page.screenshot(path=p)
    except Exception as e:
        log(f"  ⚠ 截图失败 {name}: {e}")


def load_():
    if not os.path.exists(ACCOUNTS_FILE): return []
    try: return json.load(open(ACCOUNTS_FILE, encoding="utf-8"))
    except: return []


async def check_verified(page):
    try:
        b = (await page.evaluate("document.body.innerText")).lower()
        return ("verification email" not in b) and ("magic link" not in b) and ("confirm your email" not in b)
    except: return False


async def try_login(page, email, ):
    log(f"  尝试登录: {email}")
    try:
        await page.goto("https://www.tumblr.com/login", wait_until="domcontentloaded", timeout=25000)
        await asyncio.sleep(3)
        email_box = page.locator('"email"], "email"]').first
        if not await email_box.count():
            # 已登录状态，无输入框
            return "already"
        await email_box.fill(email)
        await asyncio.sleep(0.3)
        await page.locator('""], ""]').first.fill()
        await asyncio.sleep(0.3)
        await page.locator('button[type="submit"], "Log in")').first.click()
        await asyncio.sleep(6)
        url = page.url.lower()
        body = ""
        try: body = (await page.evaluate("document.body.innerText")).lower()
        except: pass
        if "login" not in url:
            return "ok"
        if "" in body or "wrong" in body:
            return "badpwd"
        return "unknown"
    except Exception as e:
        log(f"  ❌ 登录异常: {e}")
        return "err"


async def _new(page, email, , ):
    log(f"  注册新账号: {email} / u/{}")
    async def snap(tag):
        try:
            u = page.url
            b = (await page.evaluate("document.body.innerText"))[:400]
            log(f"    [{tag}] url={u}")
            log(f"    [{tag}] body={b!r}")
        except Exception as e:
            log(f"    [{tag}] url=? ({e})")
    async def click_btn(texts):
        for t in texts:
            try:
                b = page.locator(f'"{t}"), a:has-text("{t}")').first
                if await b.count() and await b.is_visible() and not await b.is_disabled():
                    await b.click(); return True
            except: pass
        return False
    async def log_buttons(tag):
        try:
            btns = await page.evaluate("""Array.from('button')).filter(b=>b.offsetParent!==null).map(b=>({t:(b.innerText||'').trim().slice(0,25), al:(b.getAttribute('aria-label')||'').slice(0,25), dis:b.disabled, type:b.getAttribute('type'), inForm:!!b.closest('form')}))""")
            log(f"    [{tag}] 可见按钮={btns}")
        except Exception as e:
            log(f"    [{tag}] 按钮读取失败: {e}")
    async def submit_form(anchor_sel=None):
        # 关键修复: Tumblr 注册各步的 CTA 按钮(如生日步的 "Next", type=submit)
        # 常常在 <form> 之外(inForm:false)，且后台注入的 nav/search <form> 排 DOM 首位。
        # 旧代码 querySelector('form').requestSubmit() 会误提交搜索框 -> 跳 /explore。
        # 新策略: 全页搜索「可见+未禁用」的按钮，优先 type=submit，再按 CTA 文案/aria-label，
        #        并排除 nav 的 Log in / More / Follow 等；requestSubmit 仅作最后兜底。
        res = await page.evaluate("""(anchorSel)=>{
          const vis = el => el && el.offsetParent !== null && !el.disabled;
          const label = b => ((b.innerText||'') + ' ' + (b.getAttribute('aria-label')||'')).trim();
          const NAV = /log in|^more$|follow|scroll to top|search|expand|see all|keep reading/i;
          const CTA = /next|continue|finish|done|get started|almost|create|sign up/i;
          const all = [...'button')].filter(vis);
          // 1) 优先 anchor 所在 form 内的 submit 按钮
          let scope = null;
          if (anchorSel) { const el = document.querySelector(anchorSel); if (el) scope = el.closest('form'); }
          const pick = (arr) => {
            let b = arr.find(x => (x.getAttribute('type')||'').toLowerCase()==='submit' && !NAV.test(label(x)));
            if (!b) b = arr.find(x => CTA.test(label(x)) && !NAV.test(label(x)));
            return b;
          };
          let b = null;
          if (scope) b = pick([...scope.querySelectorAll('button')].filter(vis));
          if (!b) b = pick(all);                    // 2) 全页 type=submit / CTA
          if (b) { b.click(); return 'click:'+ (label(b).slice(0,18) || 'submit'); }
          // 3) 兜底: requestSubmit 含当前输入的那个 form
          let f = scope;
          if (!f) { const forms=[...'form')];
                    f = forms.find(x=>x.querySelector('email],],select,blogName]')); }
          if (f && f.requestSubmit) { try { f.requestSubmit(); return 'requestSubmit'; } catch(e){} }
          return 'no-btn';
        }""", anchor_sel)
        if res == 'no-btn':
            await click_btn(["Next", "Continue", "Sign up", "Finish"])
        else:
            log(f"    submit_form -> {res}")
        return True
    async def set_selects():
        return await page.evaluate("""(() => {
          const sels = Array.from('select'));
          if (sels.length < 3) return 'count='+sels.length;
          const pick = (el, idx) => {
            const opt = el.options[idx];
            if (!opt) return;
            const proto = Object.getPrototypeOf(el);
            const d = Object.getOwnPropertyDescriptor(proto, 'value');
            if (d && d.set) d.set.call(el, opt.value); else el.value = opt.value;
            el.dispatchEvent(new Event('change', {bubbles:true}));
            el.dispatchEvent(new Event('input', {bubbles:true}));
          };
          pick(sels[0], 5);
          pick(sels[1], 15);
          const yi = Array.from(sels[2].options).findIndex(o=>o.value==='1995' || o.text==='1995');
          if (yi>=0) pick(sels[2], yi);
          return Array.from(sels).map(s=>s.value);
        })()""")
    try:
        await page.goto("https://www.tumblr.com/", wait_until="domcontentloaded", timeout=25000)
        await asyncio.sleep(3)
        # 落地页 -> 点 Sign up
        if not await click_btn(["Sign up"]):
            log("  ⚠ 未找到 Sign up 按钮")
        await page.wait_for_selector('"email"], "email"]', timeout=15000)
        await page.locator('"email"], "email"]').first.fill(email)
        await asyncio.sleep(0.3)
        await page.locator('""], ""]').first.fill()
        await asyncio.sleep(0.3)
        await snap("email-filled")
        await submit_form('""]')
        await asyncio.sleep(5)
        body = (await page.evaluate("document.body.innerText")).lower()
        if "already" in body or "taken" in body or "in use" in body:
            log("  ⚠ 邮箱已被占用（可能已注册）")
            return "EMAIL_TAKEN"
        # 一次性/无效邮箱域名被拒
        if (("valid email" in body or "не" in body) and "email" in body) or \
           "disposable" in body or "not allowed" in body or "invalid email" in body:
            log("  ⚠ 邮箱域名疑似被拒（一次性/无效）")
            return "EMAIL_REJECTED"
        await snap("after-email")
        # 生日步
        await page.wait_for_selector("select", timeout=15000)
        vals = await set_selects()
        log(f"    生日选择值={vals}")
        await asyncio.sleep(0.8)
        await snap("-filled")
        await log_buttons("")
        await submit_form('select')
        await asyncio.sleep(5)
        await snap("after-")
        # 跳错页守卫: 若离开注册流跳到 explore/search/dashboard(logged-out) 说明被打断
        url = page.url.lower()
        if "/explore" in url or "/search" in url:
            log("  ❌ 生日步后被跳出注册流 (疑似反自动化拦截或表单未提交)")
            return "FLOW_BROKEN"
        # 用户名步 —— Tumblr 博客名只允许 [a-z0-9-]，禁止下划线；且可能被占用
        import re as _re
        def _valid_name(u):
            u = _re.sub(r"[^a-z0-9-]", "", u.lower())
            if not u or not u[0].isalpha():
                u = "mscms" + u
            return u[:30]
        # 等待用户名输入框
        try:
            await page.wait_for_selector('"blogName"], "text"]', timeout=15000)
        except Exception:
            if "" not in page.url.lower():
                log("  ❌ 未见用户名输入框且已离开注册流")
                return "FLOW_BROKEN"

        async def fill_name(u):
            loc = page.locator('"blogName"]')
            if not await loc.count():
                loc = page.locator('"text"]')
            box = loc.first
            await box.click()
            await box.fill("")
            await box.type(u, delay=25)      # 逐字输入，确保 React 受控组件同步
            await asyncio.sleep(0.4)

        ok_created = False
        for attempt in range(3):
            cand = _valid_name( if attempt == 0 else f"{}{attempt}x")
            log(f"    用户名尝试[{attempt}]: {cand}")
            await fill_name(cand)
            if attempt == 0:
                await log_buttons("")
                await shot(page, "_step.png")
            await snap(f"-filled-{attempt}")
            await submit_form('"blogName"]')
            await asyncio.sleep(6)
            await snap(f"after--{attempt}")
            url = page.url.lower()
            if "/explore" in url or "/search" in url:
                return "FLOW_BROKEN"
            body = (await page.evaluate("document.body.innerText")).lower()
            if "not a valid blog name" in body:
                log("    ⚠ 无效博客名，换名重试"); continue
            if "already" in body and "name" in body or "taken" in body or "unavailable" in body:
                log("    ⚠ 博客名已被占用，换名重试"); continue
            # 离开注册流 = 成功进入验证/引导
            if "" not in url:
                ok_created = True; break
            # 仍在  但无报错 -> 可能进入验证提示页
            if "verify" in body or "check your" in body or "confirm" in body or "sent" in body:
                ok_created = True; break
            log(f"    仍在 ，body 摘要: {body[:150]!r}")
        return ok_created
    except Exception as e:
        log(f"  ❌ 注册异常: {e}")
        return False


async def verify_via_gmail(page, email, ):
    """在同一浏览器会话里打开 Gmail，点 Tumblr 验证链接。返回 True/False。"""
    log("  打开 Gmail 验证邮箱 ...")
    async def gsnap(tag):
        try:
            b = (await page.evaluate("document.body.innerText"))[:400]
            log(f"    [gmail:{tag}] url={page.url}")
            log(f"    [gmail:{tag}] body={b!r}")
        except Exception as e:
            log(f"    [gmail:{tag}] err {e}")
    try:
        await page.goto("https://mail.google.com", wait_until="domcontentloaded", timeout=25000)
        await asyncio.sleep(5)
        await gsnap("load")
        await shot(page, "gmail_1.png")
        # 选择账号页?
        chooser = page.locator(f'div[role="button"]:has-text("{email}")').first
        if await chooser.count() and await chooser.is_visible():
            log("    选择账号页，点击该账号")
            await chooser.click(); await asyncio.sleep(4)
            await gsnap("after-choose")
        # 填 email
        try:
            await page.wait_for_selector('#identifierId, "identifier"], "email"], "text"]', timeout=10000)
            await page.locator('#identifierId, "identifier"], "email"], "text"]').first.fill(email)
            await asyncio.sleep(1)
            nb = page.locator('#identifierNext button, "Next")').first
            if await nb.count(): await nb.click()
            else: await page.locator('form').first.evaluate("f=>f.requestSubmit()")
            await asyncio.sleep(5)
        except Exception as e:
            log(f"    email 步异常(可能已跳过): {e}")
        await gsnap("after-email")
        # 填 
        try:
            await page.wait_for_selector('#, ""], ""]', timeout=10000)
            await page.locator('#, ""], ""]').first.fill()
            await asyncio.sleep(1)
            nb = page.locator('#Next button, "Next")').first
            if await nb.count(): await nb.click()
            else: await page.locator('form').first.evaluate("f=>f.requestSubmit()")
            await asyncio.sleep(6)
        except Exception as e:
            log(f"     步异常: {e}")
        await gsnap("after-")
        body = (await page.evaluate("document.body.innerText")).lower()
        if ("verify it" in body or "2-step" in body or "phone number" in body
                or "confirm your identity" in body or ("couldn" in body and "sign" in body)):
            log("  ⚠ Gmail 触发 2FA/人机验证，无法自动验证")
            return False
        # 进收件箱搜 tumblr
        await page.goto("https://mail.google.com/mail/u/0/#search/tumblr", wait_until="domcontentloaded", timeout=25000)
        await asyncio.sleep(6)
        await gsnap("search")
        await shot(page, "gmail_search.png")
        # 点第一封邮件
        row = page.locator('div[role="main"] tr.zA').first
        if await row.count():
            await row.click(); await asyncio.sleep(4)
        await shot(page, "gmail_open.png")
        await gsnap("open")
        # 找验证链接
        link = page.locator('a:has-text("Verify"), a:has-text("Confirm"), a:has-text("magic link"), a[href*="tumblr.com"]').first
        href = None
        try: href = await link.get_attribute("href")
        except: pass
        if href and "tumblr.com" in href:
            log(f"  点击验证链接: {href[:80]}")
            await page.goto(href, wait_until="domcontentloaded", timeout=25000)
            await asyncio.sleep(5)
            await shot(page, "gmail_verified.png")
            return True
        links = await page.evaluate("""Array.from(document.links).map(a=>a.href).filter(h=>h&&h.includes('tumblr.com')).slice(0,5)""")
        if links:
            await page.goto(links[0], wait_until="domcontentloaded", timeout=25000)
            await asyncio.sleep(5)
            return True
        log("  ⚠ 未在 Gmail 中找到 Tumblr 验证链接")
        return False
    except Exception as e:
        log(f"  ❌ Gmail 验证异常: {e}")
        return False


async def verify_via_mailtm(page, mailbox):
    """轮询 mail.tm 收件箱抓 Tumblr magic link，同会话浏览器导航完成验证。

    mailbox: MailTM 实例（已创建并鉴权）。返回 True/False。
    """
    log("  轮询 mail.tm 收件箱等待 Tumblr 验证邮件 ...")
    # mailtm 用 urllib 阻塞轮询，放到线程里避免卡住事件循环
    href = await asyncio.to_thread(
        mailbox.wait_for_link, "tumblr.com", 180, 5, None)
    if not href:
        # 再尝试无 host 过滤（有些邮件链接域名是 email.tumblr.com / t.umblr.com）
        href = await asyncio.to_thread(
            mailbox.wait_for_link, "umblr", 30, 5, None)
    if not href:
        log("  ⚠ mail.tm 180s 内未收到 Tumblr 验证邮件")
        log("     可能原因: Tumblr 拒收一次性域名 / 邮件延迟 / 落入其它主题")
        # 打印收件箱概览便于诊断
        try:
            msgs = mailbox.list_messages()
            log(f"     当前收件箱 {len(msgs)} 封: " +
                str([(m.get('subject'), (m.get('from') or {}).get('address')) for m in msgs])[:300])
        except Exception:
            pass
        return False
    log(f"  ✅ 抓到验证链接: {href[:90]}")
    try:
        await page.goto(href, wait_until="domcontentloaded", timeout=25000)
        await asyncio.sleep(5)
        await shot(page, "mailtm_verified.png")
        return True
    except Exception as e:
        log(f"  ❌ 打开验证链接失败: {e}")
        return False


async def _app(page):
    log("进入 /oauth/apps 注册应用 ...")
    await page.goto("https://www.tumblr.com/oauth/apps", wait_until="domcontentloaded", timeout=25000)
    await asyncio.sleep(4)
    await shot(page, "apps_page.png")
    if not await check_verified(page):
        log("  ⚠ 账号仍未验证，/oauth/apps 不可达")
        return None, None
    reg_btn = page.locator('a:has-text("Register application"), "Register application")').first
    try:
        await reg_btn.click()
    except Exception as e:
        log(f"  ⚠ 点击 Register application 失败: {e}")
    await asyncio.sleep(4)
    await shot(page, "apps_form.png")

    async def fill_by_label(hint, value):
        for sel in [f'"{hint}"]', f'[name="{hint}"]',
                    f'input[placeholder*="{hint}" i]', f'[placeholder*="{hint}" i]']:
            try:
                el = page.locator(sel).first
                if await el.count() and await el.is_visible():
                    await el.fill(value); return True
            except: pass
        try:
            lab = page.locator(f'label:has-text("{hint}")').first
            el = lab.locator("xpath=following-sibling::input | xpath=following-sibling::")
            if await el.count():
                await el.first.fill(value); return True
        except: pass
        return False

    await fill_by_label("Application name", "MSCMS v14 Auto")
    await asyncio.sleep(0.3)
    await fill_by_label("Application description", "MSCMS v14 social fan-out publisher")
    await asyncio.sleep(0.3)
    await fill_by_label("Application website", "https://mscms.local")
    await asyncio.sleep(0.3)
    await fill_by_label("OAuth2 redirect", REDIRECT_URI)
    await asyncio.sleep(0.5)
    await shot(page, "apps_filled.png")
    submit = page.locator('button[type="submit"], "Register"), "Save")').first
    await submit.click()
    await asyncio.sleep(6)
    await shot(page, "apps_result.png")

    text = ""
    try: text = await page.evaluate("document.body.innerText")
    except: pass
    key = secret = None
    m = re.search(r"OAuth Consumer Key\s*[:\-]?\s*([A-Za-z0-9]+)", text)
    if m: key = m.group(1)
    m = re.search(r"Secret\s*Key\s*[:\-]?\s*([A-Za-z0-9]+)", text, re.I)
    if m: secret = m.group(1)
    if not secret:
        try:
            show = page.locator('"Show secret key"), "Show")').first
            if await show.count():
                await show.click(); await asyncio.sleep(2)
                text = await page.evaluate("document.body.innerText")
                m = re.search(r"Secret\s*Key\s*[:\-]?\s*([A-Za-z0-9]+)", text, re.I)
                if m: secret = m.group(1)
        except: pass
    if key and secret:
        log("  ✅ 提取到 Consumer Key / Secret")
        return key, secret
    log(f"  ❌ 未提取到 Key/Secret。页面样本: {text[:200]}")
    return None, None


class CallbackCapture:
    def __init__(self):
        self.code = None; self.error = None; self.state = None
        self._server = None; self._done = threading.Event()
    def start(self):
        import http.server
        def handler(req):
            u = urllib.parse.urlparse(req.path)
            q = urllib.parse.parse_qs(u.query)
            if u.path == "/callback":
                self.code = (q.get("code") or [None])[0]
                self.error = (q.get("error") or [None])[0]
                self.state = (q.get("state") or [None])[0]
                req.send_response(200)
                req.send_header("", "text/html; charset=utf-8")
                req.end_headers()
                req.wfile.write("<h2>Tumblr 授权回调已捕获 ✅</h2><p>可关闭此页。</p>".encode("utf-8"))
                self._done.set()
            else:
                req.send_response(404); req.end_headers()
        srv = http.server.HTTPServer(("", REDIRECT_PORT),
            type("H", (http.server.BaseHTTPRequestHandler,), {"do_GET": handler}))
        self._server = srv
        threading.Thread(target=srv.serve_forever, daemon=True).start()
    def wait(self, timeout=120):
        return self._done.wait(timeout)


def exchange_token(params):
    data = urllib.parse.urlencode(params).encode()
    req = urllib.request.Request(TOKEN_URL, data=data, headers={
        "": "application/x-www-form-urlencoded", "Accept": "application/json"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({"http": PROXY, "https": PROXY}))
    with opener.open(req, timeout=30) as r:
        return json.loads(r.read().decode())


def write_input_creds(, ):
    d = {}
    if os.path.exists(INPUT_FILE):
        try: d = json.load(open(INPUT_FILE, encoding="utf-8"))
        except: d = {}
    d["tumblr_"] = 
    d["tumblr_"] = 
    json.dump(d, open(INPUT_FILE, "w", encoding="utf-8"), indent=2)
    log("  💾 已写 /secret 到 credentials-input.json")


def write_token_creds(tok, , ):
    blog = None
    try:
        req = urllib.request.Request("https://api.tumblr.com/v2/user/info",
            headers={"": f"Bearer {tok['']}"})
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({"http": PROXY, "https": PROXY}))
        with opener.open(req, timeout=30) as r:
            j = json.loads(r.read().decode())
            blogs = j.get("response", {}).get("user", {}).get("blogs", [])
            if blogs:
                prim = next((b for b in blogs if b.get("primary")), blogs[0])
                blog = f"{prim['name']}.tumblr.com" if prim.get("name") else None
    except Exception as e:
        log(f"  ⚠ 取主博客失败: {e}")
    creds = {"": , "": ,
        "": tok[""], "": tok.get(""),
        "token_type": tok.get("token_type", "bearer"), "scope": tok.get("scope", SCOPE),
        "expires_in": tok.get("expires_in"), "obtained_at": int(time.time()*1000), "blog": blog}
    json.dump(creds, open(CREDS_FILE, "w", encoding="utf-8"), indent=2)
    log(f"  💾 已写 token 到 tumblr-creds.json (blog={blog})")
    if os.path.exists(ENV_FILE):
        lines = open(ENV_FILE, encoding="utf-8").read().split("\n")
        upd = {"": tok[""]}
        if blog: upd["TUMBLR_BLOG"] = blog
        rem = dict(upd)
        out = []
        for line in lines:
            m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=", line)
            if m and m.group(1) in rem:
                out.append(f"{m.group(1)}={rem[m.group(1)]}"); del rem[m.group(1)]
            else: out.append(line)
        for k, v in rem.items(): out.append(f"{k}={v}")
        open(ENV_FILE, "w", encoding="utf-8").write("\n".join(out))
        log(f"  💾 已写 /TUMBLR_BLOG 到 ")


async def run_setup():
    from playwright.async_api import async_playwright
    capture = CallbackCapture(); capture.start()
    state = os.urandom(16).hex()
    used_session = False

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True, proxy={"server": PROXY},
            args=["--disable-blink-features=AutomationControlled", "--no-sandbox"])

        # ---- 阶段1: 找一个已验证的账号（只试第一个快速探明，其余都是未验证随机 gmail）----
        verified_page = None
        for acc in load_()[:1]:
            ctx = await browser.new_context(locale="en-US", viewport={"width": 1280, "height": 800})
            await ctx.add_init_script("Object.defineProperty(navigator,'webdriver',{get:()=>false});")
            page = await ctx.new_page()
            r = await try_login(page, acc["email"], acc[""])
            if r in ("ok", "already"):
                if await check_verified(page):
                    log(f"  ✅ 已验证账号: {acc['email']}")
                    verified_page = (ctx, page); break
                else:
                    log(f"  ⚠ 账号 {acc['email']} 未验证，跳过")
            await ctx.close()

        # ---- 阶段2: 没有已验证的 -> 用 mail.tm 临时邮箱注册新账号并验证 ----
        if not verified_page:
            log("无已验证账号，用 mail.tm 临时邮箱注册新账号 ...")
            try:
                mailbox = await asyncio.to_thread(MailTM)
            except Exception as e:
                log(f"  ❌ 创建 mail.tm 邮箱失败: {e}")
                await browser.close(); return False
            reg_email = mailbox.address
            log(f"  📮 临时邮箱: {reg_email}")
            ctx = await browser.new_context(locale="en-US", viewport={"width": 1280, "height": 800})
            await ctx.add_init_script("Object.defineProperty(navigator,'webdriver',{get:()=>false});")
            page = await ctx.new_page()
            new_user = f"mscmsv14x{int(time.time())%100000}"
            r = await _new(page, reg_email, NEW_PWD, new_user)
            if r == "EMAIL_REJECTED":
                log("  ❌ Tumblr 拒收该一次性邮箱域名 (web-library.net)")
                log("     mail.tm 目前只有此域名。回退方案见结尾提示。")
                await browser.close(); return False
            elif r == "FLOW_BROKEN":
                log("  ❌ 注册流程中途被打断（生日/用户名步跳出到 explore/search）")
                log("     常见于 Tumblr 对 headless/自动化的拦截。回退方案见结尾提示。")
                await browser.close(); return False
            elif r == "EMAIL_TAKEN":
                log("  邮箱已被占用，尝试用该邮箱+密码登录既有账号 ...")
                lr = await try_login(page, reg_email, NEW_PWD)
                if lr not in ("ok", "already"):
                    log("  ❌ 既存账号登录失败（密码不匹配或需验证），需你手动处理")
                    await browser.close(); return False
            elif not r:
                await browser.close(); return False
            # 注册成功 或 EMAIL_TAKEN 已登录 -> mail.tm 验证
            await asyncio.sleep(3)
            if await verify_via_mailtm(page, mailbox):
                await page.goto("https://www.tumblr.com/dashboard", wait_until="domcontentloaded", timeout=25000)
                await asyncio.sleep(4)
                if await check_verified(page):
                    log("  ✅ 新账号已验证")
                    verified_page = (ctx, page)
                    accs = load_()
                    accs.append({"site": "tumblr", "email": reg_email, "": new_user,
                                 "": NEW_PWD, "": datetime.now().isoformat(),
                                 "email_provider": "mail.tm"})
                    json.dump(accs, open(ACCOUNTS_FILE, "w", encoding="utf-8"), indent=2)
                else:
                    log("  ⚠ 验证链接点击后 Tumblr 仍显示未验证（可能延迟）")
            else:
                log("  ⚠ mail.tm 自动验证失败（未收到邮件 / 域名被拒）")
            if not verified_page:
                await browser.close()
                log("\n❌ 无法获得已验证 Tumblr 账号。回退方案：")
                log("   1) 若因一次性域名被拒 → 用你已验证的真实邮箱手动注册 Tumblr")
                log("   2) 然后在 https://www.tumblr.com/oauth/apps 建 App")
                log("   3) 把 Consumer Key/Secret 填入 credentials-input.json 后重跑本脚本的授权阶段")
                return False

        ctx, page = verified_page

        # ---- 阶段3: 注册 App ----
        key, secret = await _app(page)
        if not (key and secret):
            await browser.close()
            return False
        write_input_creds(key, secret)

        # ---- 阶段4: OAuth2 授权（同会话代点允许）----
        auth_url = AUTHORIZE_URL + "?" + urllib.parse.urlencode({
            "": key, "response_type": "code", "scope": SCOPE,
            "state": state, "": REDIRECT_URI})
        log(f"打开授权页并代点允许 ...")
        await page.goto(auth_url, wait_until="domcontentloaded", timeout=25000)
        await asyncio.sleep(4)
        await shot(page, "oauth_consent.png")
        allow = page.locator('"Allow"), "Authorize"), "允许")').first
        try:
            await allow.click(); log("  ✅ 已点击允许")
        except Exception as e:
            log(f"  ⚠ 未找到允许按钮（可能已自动重定向）: {e}")
        got = capture.wait(120)
        await browser.close()
        if not got or not capture.code:
            log(f"❌ 未捕获授权码 (error={capture.error})"); return False
        if capture.state != state:
            log("❌ state 不匹配(CSRF)"); return False
        log("  ✅ 捕获授权码，交换 token ...")
        tok = exchange_token({"": "", "code": capture.code,
            "": key, "": secret, "": REDIRECT_URI})
        if not tok.get(""):
            log(f"❌ 换 token 失败: {tok}"); return False
        write_token_creds(tok, key, secret)
        log("\n🎉 全流程完成！Tumblr App + OAuth2 token 已就绪。")
        return True


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "setup"
    if mode == "setup":
        ok = asyncio.run(run_setup())
        sys.exit(0 if ok else 1)
    else:
        print("用法: python tumblr_app_setup.py setup")

if __name__ == "__main__":
    main()
