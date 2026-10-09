'use strict';
/**
 * tumblr-onboard-shardx.js — 用 ShardX 反检测浏览器跑 Tumblr 注册
 * -----------------------------------------------------------------
 * 背景：headless chromium 直连注册，在生日步骤被 Tumblr 反欺诈打死
 *       （POST /api/v2/user/validate -> 400 {"errors":["An error occurred."]}，
 *        同时向 blackbox-api.wp.com/v1/collect 上报设备指纹）。
 *       此前定位的两个代码级 bug（setReactSelect 对 React 受控 select 无效、
 *       line 389 只匹配英文 'Next'）一并修复。
 *
 * 本脚本改用 ShardX Launcher 的真实指纹浏览器：
 *   - 每个账号建独立临时 profile（独立指纹 + 独立 user-data）
 *   - playwright connectOverCDP 接进去，webdriver=false、UA/WebGL/屏幕全真
 *   - 出口按 accountId 确定性分配到【出口单元】（见 registration-exits.js）
 *
 * 【2026-09-12 灰度定标改造】出口不再硬编码 10808：
 *   改造前所有账号从同一个出口 IP（10808）注册，且 .json 的
 *    全空、 全是 10808（117/117），事后无法复盘。
 *   现在：
 *     · pickUnit(accountId) = hashStr(accountId) % 9 单元 → 重启一致、防关联；
 *     · 每单元 ≤3 注册/天、同单元间隔 ≥10 分钟（registration-exits.js 账本）；
 *     · 注册后落库  /  / registration_exit / registration_at。
 *
 * 用法：
 *   node tumblr-onboard-shardx.js                    # 1 个（自动选路）
 *   node tumblr-onboard-shardx.js 3                  # 3 个
 *   node tumblr-onboard-shardx.js 1 --probe          # 只诊断交互流程，不落盘/不授权
 *   node tumblr-onboard-shardx.js 1 --unit <单元key> # 强制钉住指定出口单元（灰度用）
 *   node tumblr-onboard-shardx.js 1 --no-throttle    # 跳过节流检查（人工干预时用）
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { TumblrPublisher } = require('./tumblr-publisher.js');
const { encrypt } = require('./account-crypto');
const { DataStore } = require('./data-store.js');
// dataStore 实例化放在 WS 定义之后（见下方）

const WS = 'C:/Users/AS/WorkBuddy/2026-06-13-19-42-19';
const API = 'http://:40325';
const CALLBACK_URL = 'http://localhost:3122/callback';
const SITEKEY = '6LeYrbYqAAAAAF9Hyb1luPFtcSylK688Hk22La0B';
const ACCOUNTS = path.join(WS, 'data', '.json');
/** 旧行为：单出口写死。现作为「选路失败时的兜底」，正常路径由 registration-exits 决定。 */
const OUT_PROXY = 'http://:10808';
const RX = require('./registration-exits.js');
// 【2026-09-16 走 B】命名规则的唯一定义处（与 tools/build-rename-map.js 共用，避免漂移）
const NAMING = require('./account-naming.js');
process.env.MSCMS_DATASTORE_WRITE_MODULES = process.env.MSCMS_DATASTORE_WRITE_MODULES || '*,-content';
// [2026-09-12] 本脚本不是 content 属主：显式声明写入范围，防止与主服务抢写（多写者覆盖）
const dataStore = new DataStore(path.join(WS, 'data'));

const log = (m, pfx = '') => console.log(pfx + m);

// ---------- 代理设置（出网走 10808）----------
process.env.HTTP_PROXY = process.env.HTTP_PROXY || OUT_PROXY;
process.env.HTTPS_PROXY = process.env.HTTPS_PROXY || OUT_PROXY;
process.env.NO_PROXY = process.env.NO_PROXY || ',localhost';

// ---------- ShardX Automation API ----------
const TOKEN = fs.readFileSync(path.join(WS, '_shardx_token.txt'), 'utf8').trim();
const SHX_HDR = { : 'Bearer ' + TOKEN };

async  shx(pathname, opts = {}) {
  const r = await fetch(API + pathname, {
    ...opts,
    headers: { '': 'application/json', ...SHX_HDR },
    signal: AbortSignal.timeout(60000),
  });
  const txt = await r.text().catch(() => '');
  if (!r.ok) throw new Error('ShardX ' + pathname + ' HTTP ' + r.status + ' ' + txt.slice(0, 200));
  try { return JSON.parse(txt); } catch (_) { return txt; }
}

// ---------- 账号生成（与原脚本一致，保持格式兼容）----------
/**
 * 注册邮箱 —— 【2026-09-14 改造】
 * 旧实现 `'mscms' + rand + '@gmail.com'` 有两个硬伤：
 *   ① 凭空占用一个可能真实存在的 Gmail 地址（撞真人、退信、投诉风险）；
 *   ② 邮箱不可收信 → 117 个历史账号无法找回/验证，集体失效风险。
 * 现改为从【真实可收信地址池】取（Cloudflare Email Routing catch-all → Workers KV，
 * 见 email-provider.js）。池空会实时申请，不阻塞注册。
 * 零伪造：链路不可用时【默认抛错中止】；仅当显式 MSCMS_ALLOW_FAKE_EMAIL=1 才回退旧行为。
 */
async  genEmail() {
  try {
    const { nextAddress } = require('./email-provider.js');
    const r = await nextAddress({ label: 'tumblr' });
    return r.address;
  } catch (e) {
    if (process.env.MSCMS_ALLOW_FAKE_EMAIL === '1') {
      console.error('[!] 真实邮箱不可用（' + e.message.split('\n')[0] + '）');
      console.error('[!] MSCMS_ALLOW_FAKE_EMAIL=1 → 回退捏造 Gmail（有撞真人风险，仅限应急）');
      return 'mscms' + Math.random(36).slice(2, 9) + '@gmail.com';
    }
    throw new Error(
      '无可用真实邮箱：' + e.message + '\n' +
      '  · 部署：node tools/cf-mail-setup.js --deploy --domain <你的域>\n' +
      '  · 应急回退捏造地址：设 MSCMS_ALLOW_FAKE_EMAIL=1（不推荐）'
    );
  }
}
 gen() {
  const a = 'abcdefghijkmnpqrstuvwxyz';
  const b = 'abcdefghijkmnpqrstuvwxyz';
  const n = '23456789';
  const s = '!@#$%';
  const pick = (str, k) => Array.from({ length: k }, () => str[Math.floor(Math.random() * str.length)]).join('');
  return pick(a, 2) + pick(b, 3) + pick(n, 3) + pick(s, 1) + pick(b, 2) + Math.floor(Math.random() * 999);
}

// ---------- 命名（2026-09-16 走 B 方案：规则前移到注册链路）----------
/**
 * 已占用 blogName（本地账本，进程内缓存）
 * 来源：data/.json 的 /blog_name + data/.json 的 blogName
 * 只做「本地不撞名」，线上是否已被别人占用由 precheckBlogName() 现场判定。
 */
let _USED_NAMES = null;
 getUsedNames() {
  if (!_USED_NAMES) {
    _USED_NAMES = NAMING.collectUsedNames(WS);
    log('  命名账本: 本地已占用 blogName ' + _USED_NAMES.size + ' 个');
  }
  return _USED_NAMES;
}

/**
 * 线上名称可用性预检 —— 在【反检测浏览器内】发起，与注册同出口、同会话。
 * 判据（已实测）：未授权 GET /info → 404 = 名字可用 / 401 = 已被占用。
 * 返回 true(可用) / false(已占用) / null(判不了)
 * ⚠️ 任何异常都返回 null，调用方必须「null 也放行」——绝不因预检失败而阻断注册。
 */
async  precheckBlogName(page, name) {
  try {
    const code = await page.evaluate(async (n) => {
      const r = await fetch('https://api.tumblr.com/v2/blog/' + encodeURIComponent(n) + '.tumblr.com/info', { method: 'GET' });
      return r.status;
    }, name);
    if (code === 404) return true;
    if (code === 401 || code === 200) return false;
    return null;
  } catch (_) { return null; }
}

// ---------- reCAPTCHA Enterprise 同页执行 ----------
async  solveRecaptchaInPage(page, timeoutMs = 45000) {
  // 【2026-09-14 修复·重要】原实现【没有任何超时】：
  //   `grecaptcha.enterprise.ready(cb)` 在某些出口（实测 CF 池化 IP）下 cb 永不触发
  //   → Promise 永不 resolve → page.evaluate 永久挂起 → 【整批灰度被一条卡死】。
  //   现在页面内自带 setTimeout 兜底，超时返回 'TIMEOUT'，让流程继续走（不伪造 token）。
  return await page.evaluate(async ({ sk, timeoutMs }) => {
    return await new Promise((resolve) => {
      let done = false;
      const fin = (v) => { if (!done) { done = true; resolve(v); } };
      const timer = setTimeout(() => fin('TIMEOUT'), timeoutMs);
      try {
        if (!window.grecaptcha || !window.grecaptcha.enterprise) { clearTimeout(timer); return fin('NO_ENT'); }
        window.grecaptcha.enterprise.ready(async () => {
          try {
            const t = await window.grecaptcha.enterprise.execute(sk, { action: '' });
            clearTimeout(timer); fin(t || 'EMPTY');
          } catch (e) { clearTimeout(timer); fin('ERR:' + e.message); }
        });
      } catch (e) { clearTimeout(timer); fin('ERR:' + e.message); }
    });
  }, { sk: SITEKEY, timeoutMs });
}

async  injectRecaptcha(page, token) {
  await page.evaluate((t) => {
    let el = document.getElementById('');
    if (!el) {
      el = document.createElement('');
      el.id = '';
      el.name = '';
      el.style.display = 'none';
      document.body.appendChild(el);
    }
    el.value = t;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, token);
}

// ---------- OAuth 本地回调服务器 ----------
const http = require('http');
 startCallbackServer(port) {
  return new Promise((resolve) => {
    let resolveVerifier;
    const verifierPromise = new Promise((res) => { resolveVerifier = res; });
    let listenErr = null;
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://');
      const verifier = u.searchParams.get('');
      const token = u.searchParams.get('');
      res.writeHead(200, { '': 'text/plain; charset=utf-8' });
      res.end('OK - Tumblr callback captured. This window can be closed.');
      resolveVerifier({ verifier, token });
    });
    server.on('error', (e) => { listenErr = e.message; resolveVerifier({ verifier: null, token: null, err: e.message }); });
    server.listen(port, '', () => resolve({ server, verifierPromise, getListenError: () => listenErr }));
  });
}

// ---------- 交互流程（含全程网络抓包）----------
 attachNetCapture(page, tag, sink) {
  page.on('response', async (r) => {
    const u = r.url();
    const m = r.request().method();
    if (!/tumblr\.com\/api|tumblr\.com\/oauth|www\.tumblr\.com\/|blackbox-api\.wp\.com/.test(u)) return;
    let body = '';
    if (m === 'POST' && /tumblr\.com/.test(u)) {
      body = (await r.text().catch(() => '')).slice(0, 160);
    }
    const rec = { t: new Date().toISOString().slice(11, 19), m, s: r.status(), u: u.replace(/^https?:\/\/[^/]+/, '').slice(0, 90), body: body || undefined };
    sink.push(rec);
    log('    [net] ' + tag + ' ' + rec.m + ' ' + rec.s + ' ' + rec.u + (body ? '  ' + body : ''));
  });
}

/**
 * 等待「下一步」元素出现（替代固定 sleep）。
 *
 * 【2026-09-12 灰度实测根因】原实现用固定 `waitForTimeout(4500)` / `(6000)` 推进多步表单。
 * 固定睡眠在出口抖动（尤其 CF Worker 出口）下会抢跑：生日 select 还没渲染就往下走
 * → blogName 也拿不到 → grecaptcha 也不在 → 最后 createStatus=null（`create:no-req`）。
 * 灰度 12 次 CF 尝试中 3 次因此失败。
 * 本函数轮询直到任一选择器「可见」或超时；超时不抛异常，交由调用方按原逻辑降级。
 */
async  waitAnyVisible(page, selectors, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      try {
        const vis = await page.evaluate((s) => {
          const el = document.querySelector(s);
          if (!el) return 0;
          const r = el.getBoundingClientRect();
          return (r.width > 0 && r.height > 0) ? 1 : 0;
        }, sel);
        if (vis) return true;
      } catch (_) { /* 页面导航中，忽略 */ }
    }
    await page.waitForTimeout(400);
  }
  return false;
}

/**
 * 注册（带一次自动重试）。
 * 首轮回填因出口抖动未触发创建接口时，重新导航再走一遍（最多 2 轮）。
 * 成功判据：createStatus 有值（200=成功；非 200 也说明请求已到达，不需要重试）。
 */
async  WithShardX(page, email, pw, blogName, blogTitle) {
  const net = [];
  attachNetCapture(page, 'reg', net);
  const state = { createStatus: null };
  page.on('response', (r) => {
    const u = r.url();
    if (u.includes('tumblr.com/api') && r.request().method() === 'POST' && u.split('/').pop() === 'nrksaaknsdzc') state.createStatus = r.status();
  });

  let last = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1) log('  ♻️ 首轮未触发创建接口，重试第 ' + attempt + ' 轮', '♻️ ');
    last = await Attempt(page, email, pw, blogName, net, state, blogTitle);
    if (last && last.createStatus) break;
    if (attempt < 2) {
      try { await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 15000 }); } catch (_) {}
      try { await page.waitForTimeout(2500); } catch (_) {}
    }
  }
  return last;
}

async  Attempt(page, email, pw, blogName, net, state, blogTitle) {
  log('  goto /');
  const gr = await page.goto('https://www.tumblr.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  log('    HTTP ' + (gr ? gr.status() : 'ERR') + ' final=' + page.url().slice(0, 70));
  await page.waitForSelector('email]', { timeout: 30000 });

  log('  填 email=' + email + ' / ');
  await page.fill('email]', email);
  await page.fill(']', pw);
  await page.waitForTimeout(600);

  log('  提交第一步 (button[type=submit])');
  await page.click('button[type=submit]');
  await page.waitForTimeout(4500);

  // ---- 生日步骤：关键修复，用原生 selectOption（React 受控组件必须走原生 setter + change 事件链）----
  const hasSelects = await page.evaluate(() => ({
    month: !!document.querySelector('select[name=month]'),
    day: !!document.querySelector('select[name=day]'),
    year: !!document.querySelector('select[name=year]'),
    btns: Array.from('button')).map(b => b.textContent.trim()).filter(Boolean).slice(0, 8),
  }));
  log('  生日步骤元素: ' + JSON.stringify(hasSelects));

  if (hasSelects.month && hasSelects.day && hasSelects.year) {
    // 先确认原生 select 的 disabled 状态与可选值
    const selInfo = await page.evaluate(() => {
      const out = {};
      const names = ['month', 'day', 'year'];
      for (const nm of names) {
        const s = document.querySelector('select[name=' + nm + ']');
        out[nm] = s ? { disabled: s.disabled, len: s.options.length } : null;
      }
      return out;
    });
    log('    select 状态: ' + JSON.stringify(selInfo));
    await page.selectOption('select[name=month]', '0', { timeout: 8000 });
    await page.selectOption('select[name=day]', '15', { timeout: 8000 });
    await page.selectOption('select[name=year]', '1995', { timeout: 8000 });
    await page.waitForTimeout(700);

    const btnState = await page.evaluate(() => {
      const subs = Array.from('button[type=submit]'));
      return subs.map(b => ({ txt: b.textContent.trim().slice(0, 24), disabled: b.disabled }));
    });
    log('    提交按钮: ' + JSON.stringify(btnState));

    log('  点 Next/下一步');
    // 兜底：优先非禁用 submit，其次匹配英文 Next，再其次任意非禁用按钮
    const clicked = await page.evaluate(() => {
      const subs = Array.from('button[type=submit]:not([disabled])'));
      if (subs.length) { subs[subs.length - 1].click(); return 'submit:not(disabled)=' + subs[subs.length - 1].textContent.trim().slice(0, 20); }
      const nx = Array.from('button')).find(x => /^next$/i.test(x.textContent.trim()) && !x.disabled);
      if (nx) { nx.click(); return 'Next'; }
      return null;
    });
    log('    点击: ' + clicked);
    await page.waitForTimeout(6000);
  } else {
    log('    ⚠️ 未出现生日 select，页面可能已推进或卡住', '⚠️ ');
  }

  // ---- blog name 步骤 ----
  const hasBlog = await page.evaluate(() => !!document.querySelector('blogName]'));
  if (hasBlog) {
    log('  填 blogName=' + blogName);
    await page.fill('blogName]', blogName, { timeout: 20000 });
    // ── 防御式显示名填写（2026-09-16）────────────────────────────────
    // 现状：注册表单只在 blog 步骤暴露 blogName]，未观察到独立显示名字段，
    //       因此 Tumblr 侧 primary blog 的 title 一直是 "Untitled"。
    // 这里做「有则填、无则静默」——不改变流程，只把现场输入框名记进日志，
    // 供后续判断是否能在注册期就把显示名（KK-Jane 这类）设好。
    try {
      const inputs = await page.evaluate(() => Array.from('input'))
        .map((i) => i.name || i.type).filter(Boolean).slice(0, 15));
      log('    blog 步骤输入框: ' + JSON.stringify(inputs));
      if (blogTitle) {
        const titleSel = 'blogTitle], title], blog_title]';
        const hasTitle = await page.evaluate((s) => !!document.querySelector(s), titleSel);
        if (hasTitle) {
          await page.fill(titleSel, blogTitle, { timeout: 8000 });
          log('    ✅ 已填写显示名 title=' + blogTitle);
        } else if (process.env.MSCMS_DEBUG_NAMING === '1') {
          log('    未发现显示名字段（Tumblr 侧 title 将保持 Untitled）');
        }
      }
    } catch (e) {
      log('    显示名步骤异常（已忽略，不影响注册）: ' + e.message, '⚠️ ');
    }
    await page.waitForTimeout(3500);
  } else {
    log('    ⚠️ 未出现 blogName 输入框', '⚠️ ');
    const snap = await page.evaluate(() => ({
      url: location.href,
      inputs: Array.from('input')).map(i => i.name || i.type).slice(0, 12),
      btns: Array.from('button')).map(b => b.textContent.trim() + (b.disabled ? '(d)' : '')).slice(0, 10),
      body: document.body ? document.body.innerText.slice(0, 300) : '',
    }));
    log('    现场: ' + JSON.stringify(snap).slice(0, 700));
  }

  // ---- reCAPTCHA ----
  const hasEnt = await page.evaluate(() => !!(window.grecaptcha && window.grecaptcha.enterprise));
  log('  grecaptcha.enterprise 存在: ' + hasEnt);
  if (hasEnt) {
    const t0 = Date.now();
    const token = await solveRecaptchaInPage(page, Number(process.env.MSCMS_RECAPTCHA_TIMEOUT_MS) || 45000);
    log('  reCAPTCHA 结果 (' + ((Date.now() - t0) / 1000).toFixed(1) + 's): ' + String(token).slice(0, 40));
    if (token === 'TIMEOUT') log('    ⚠️ reCAPTCHA 超时（ready 回调未触发，通常是该出口 IP 被灰度限制）→ 跳过注入，不伪造 token', '⚠️ ');
    // ⚠️ 'TIMEOUT' 必须排除，否则会被当作合法 token 注入（旧实现漏了这个分支）
    if (token && !token.startsWith('ERR') && token !== 'NO_ENT' && token !== 'EMPTY' && token !== 'TIMEOUT') {
      await injectRecaptcha(page, token);
      await page.waitForTimeout(1200);
      log('  点 Sign up');
      const c = await page.evaluate(() => {
        const b = Array.from('button')).find(x => /sign up/i.test(x.textContent) && !x.disabled);
        if (b) { b.click(); return b.textContent.trim().slice(0, 20); }
        const subs = Array.from('button[type=submit]:not([disabled])'));
        if (subs.length) { subs[subs.length - 1].click(); return 'submit=' + subs[subs.length - 1].textContent.trim().slice(0, 20); }
        return null;
      });
      log('    点击: ' + c);
      await page.waitForTimeout(8000);
    }
  }

  const createStatus = state.createStatus;
  const endUrl = page.url();
  log('  结束: url=' + endUrl.slice(0, 80));
  log('  创建接口: ' + (createStatus === 200 ? '✅ HTTP 200' : '❌ ' + (createStatus || '未触发 nrksaaknsdzc POST')));

  return { createStatus, endUrl, net };
}

// ---------- 一机一号设备分配 ----------
 pickLeastLoadedDevice() {
  let arr = [];
  try { arr = JSON.parse(fs.readFileSync(ACCOUNTS, 'utf8')); if (!Array.isArray(arr)) arr = []; } catch (e) { arr = []; }
  const load = {};
  for (let i = 1; i <= 50; i++) load[i] = 0;
  for (const a of arr) if (a && a.) load[a.] = (load[a.] || 0) + 1;
  let best = 1, min = Infinity;
  for (let i = 1; i <= 50; i++) { if (load[i] < min) { min = load[i]; best = i; } }
  return best;
}
 appendAccount(rec) {
  let arr = [];
  if (fs.existsSync(ACCOUNTS)) {
    try { arr = JSON.parse(fs.readFileSync(ACCOUNTS, 'utf8')); if (!Array.isArray(arr)) arr = []; } catch (e) { arr = []; }
  }
  arr.push(rec);
  fs.writeFileSync(ACCOUNTS, JSON.stringify(arr, null, 2), 'utf8');
}
 makeAccountRecord(accountId, email, pw, blogName, verified, extra) {
  const now = new Date().toISOString();
  return {
    id: accountId,
    : 'tumblr',
    : blogName,
    email,
    : encrypt(pw),
    _plain: '',
    blog_name: blogName,
    blog_url: 'https://' + blogName + '.tumblr.com',
    status: verified ? 'verified' : 'unverified',
    verified_email: verified,
    // 【2026-09-14】邮箱可收信性显式落库，避免日后又要靠猜判断哪些账号能找回
    email_provider: /@gmail\.com$/i.test(String(email || '')) ? 'fabricated-gmail' : 'cf-email-routing',
    email_receivable: !!email && !/@gmail\.com$/i.test(String(email)),
    ed_at: now,
    // 【2026-09-20 B5】必须同时写 createdAt：
    //   本函数用 fs.writeFileSync 直写 .json，绕过了 DataStore.create()
    //   （后者一定会补 createdAt/updatedAt）。此前只写 ed_at，导致
    //    模块出现「字段世代分裂」——8 月导入的 87 条只有 createdAt，
    //   本脚本注册的 36 条只有 ed_at，两者交集为 0，
    //   任何按 createdAt 的新增趋势图都会在这批账号上显示为「零新增」（失真）。
    //   两个字段都保留：ed_at 是既有消费方（日报/审计）的字段，不动。
    createdAt: now,
    : pickLeastLoadedDevice(),
    created_by: 'tumblr-onboard-shardx',
    ...(extra || {}),
  };
}

/** 出口单元 → 实测出口 IP 的进程内缓存（**已废弃**：CF 出口会漂移，
 *  缓存会导致  失真。保留函数仅为兼容，实际每条账号现测现取。） */
const IP_CACHE = new Map();
async  egressIpOf(unit, exitProxy) {
  const k = (unit && unit.unit) || exitProxy;
  if (IP_CACHE.has(k)) return IP_CACHE.get(k);
  let ip = null;
  try { ip = await RX.resolveEgressIp(exitProxy); } catch (_) { ip = null; }
  IP_CACHE.set(k, ip);
  return ip;
}

// ---------- OAuth 授权（复用 tumblr-publisher）----------
async  oauthInPage(page, accountId, appIdx, exitProxy) {
  const publisher = new TumblrPublisher(dataStore);
  // 【2026-09-12】OAuth 必须与注册走【同一出口 IP】——换 IP 授权是典型的风控信号。
  if (exitProxy) { try { publisher.setProxyResolver(() => exitProxy); } catch (_) {} }
  let apps = [];
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(WS, 'tumblr_apps.json'), 'utf8'));
    if (Array.isArray(raw)) apps = raw.filter(a => a && a. && a.);
  } catch (e) {}
  if (apps.length) {
    const app = apps[appIdx % apps.length];
    publisher. = app.;
    publisher. = app.;
    log('  OAuth App: ' + (app.label || app..slice(0, 8)) + '...');
  }

  const cb = await startCallbackServer(3122 + (appIdx % 40));
  // 请求级兜底：ShardX 浏览器可能把 localhost:3122 走代理，server 收不到；
  // 但浏览器仍会「发出」该请求，url 里带 ，拦截即可。
  let capturedFromRequest = null;
  const onReq = (req) => {
    const u = req.url();
    const hit = u.indexOf('3122/callback') >= 0 || u.indexOf('localhost:3122') >= 0;
    if (!hit) return;
    try {
      const q = u.split('=')[1];
      if (q) capturedFromRequest = decodeURIComponent(q.split('&')[0]);
    } catch (_) {}
  };
  page.on('request', onReq);
  try {
    const beginRes = await publisher.beginAuth(accountId, CALLBACK_URL);
    const authorizeUrl = beginRes.authorizeUrl;
    log('  beginAuth ok -> ' + authorizeUrl.slice(0, 90) + '...');
    await page.goto(authorizeUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3000);

    // 点击 Allow / 授权按钮（多语言兜底）
    const clicked = await page.evaluate(() => {
      const allowWords = ['allow', 'authorize', 'approve', '授权', '允许'];
      const els = 'button, a');
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        if (el.offsetParent === null) continue;
        const txt = (el.textContent || '').trim().toLowerCase();
        let matched = false;
        for (let w = 0; w < allowWords.length; w++) {
          if (txt.indexOf(allowWords[w]) >= 0) { matched = true; break; }
        }
        if (matched) { el.click(); return el.textContent.trim().slice(0, 20); }
      }
      const subs = 'button[type=submit]');
      for (let i = 0; i < subs.length; i++) {
        if (!subs[i].disabled) { subs[i].click(); return 'submit=' + subs[i].textContent.trim().slice(0, 20); }
      }
      return null;
    });
    log('  授权点击: ' + clicked);

    const timeoutP = new Promise((r) => setTimeout(() => r({ verifier: null, source: 'timeout' }), 35000));
    const serverP = cb.verifierPromise.then((r) => { r.source = 'server'; return r; });
    const cbRes = await Promise.race([serverP, timeoutP]);
    let verifier = cbRes.verifier || capturedFromRequest;
    if (!verifier) {
      const m = page.url().split('=')[1];
      if (m) verifier = m.split('&')[0];
    }
    if (!verifier) {
      log('  未拿到 verifier (src=' + cbRes.source + ', req=' + !!capturedFromRequest + ', url=' + page.url().slice(0, 70) + ')', '❌ ');
      return null;
    }
    const src = (capturedFromRequest && !cbRes.verifier) ? 'request-intercept' : (cbRes.source || 'url-fallback');
    log('  verifier 来源: ' + src);
    const res = await publisher.completeAuth(verifier, accountId);
    log('  completeAuth: ' + JSON.stringify(res).slice(0, 160));
    return dataStore.get('', accountId) || res;
  } finally {
    page.off('request', onReq);
    cb.server.close();
  }
}

// ---------- 主流程 ----------
async  onboardOne(appIdx, probe, opts) {
  opts = opts || {};
  const accountId = 'tumblr_' + Math.random(36).slice(2, 10);
  const email = await genEmail();
  const pw = gen();
  // ── 命名（2026-09-16 起，走 B：规则前移，只对新号生效）─────────────────
  // 旧实现 `'mscms' + rand`：152 个存量账号全是 mscms 前缀 → 极强批量指纹。
  // 现按 `<family>-<name>` 规则生成，家系池默认 8 个（env MSCMS_NAME_FAMILIES 可覆盖），
  // 家系按 accountId 哈希稳定选路（同一账号永远同一家系，不同账号散开）。
  const usedNames = getUsedNames();
  const named = NAMING.allocate({ accountId, used: usedNames });
  let blogName = named.blogName;
  const blogTitle = named.title;
  usedNames.add(blogName);

  // ── 出口选路（2026-09-12 灰度）：hashStr(accountId) % 9 单元，重启一致 ──
  const unit = RX.pickUnit(accountId, opts.unit || null);
  const exitProxy = (unit && unit.proxy) || OUT_PROXY;
  if (!unit) log('  ⚠️ 出口池为空，回退单出口 ' + OUT_PROXY, '⚠️ ');
  if (opts.unit && unit && unit.unit !== opts.unit && unit.name !== opts.unit) {
    log('  ⚠️ 指定单元 ' + opts.unit + ' 未在池中命中，已按哈希选路', '⚠️ ');
  }

  log('\n===== 账号 ' + (appIdx + 1) + ': ' + email + ' / blog=' + blogName + ' =====');
  log('  命名: family=' + named.family + ' name=' + named.name + (named.initial ? ' initial=' + named.initial : '') +
      ' → blog=' + blogName + '（显示名待设: ' + blogTitle + '）');
  log('  出口单元: ' + (unit ? unit.unit : '(空池→' + OUT_PROXY + ')') + (unit && unit.cf ? '  [CF /64]' : '') + '  代理: ' + exitProxy);

  // 实测出口 IP —— 必须在节流判断【之前】拿：
  // CF Worker 出口 IP 会漂移（实测 20205 池记录 :1187 但实测 :1846），
  // 只看池记录的单元会漏计同一真实 /64 上的注册。取不到就留 null（零伪造）。
  const egressIp = await RX.resolveEgressIp(exitProxy);
  const egressKey = egressIp ? RX.exitKey(egressIp) : null;
  log('  实测出口 IP: ' + (egressIp || '❌ 取不到（ 将留空）') + (egressKey ? '  → /64=' + egressKey : ''));

  // ── 注册节流（池单元 ∪ 实测出口，每键 ≤3/天、间隔 ≥10 分钟、全局 ≤30/天）──
  if (!probe && !opts.noThrottle && unit) {
    const t = RX.checkThrottle(unit.unit, egressKey);
    if (!t.ok) {
      log(`  ⏸ 节流拦截 [${unit.unit}]：${t.reason}`, '⏸ ');
      return { ok: false, accountId, email, blogName, unit: unit.unit, ip: egressIp, reason: 'throttled:' + t.reason, throttled: true };
    }
  }

  /** 本次注册的出口元数据，统一落库 */
  const exitMeta = () => ({
    : egressIp || '',
    origin_ip: egressIp || '',
    registration_exit_live: egressKey || null,
    : exitProxy,
    bound_proxy: exitProxy,
    registration_exit: unit ? unit.unit : null,
    registration_exit_cf: !!(unit && unit.cf),
    registration_at: new Date().toISOString(),
    gray_cohort: process.env.MSCMS_GRAY_COHORT || null,
  });

  // 建临时 profile（独立指纹 + 独立 user-data）
  let profile = null;
  try {
    // TempProfileRequest 只接受内联 proxy 字符串（无 proxy_id 字段）
    profile = await shx('/profiles/temporary', {
      method: 'POST',
      body: JSON.stringify({ name: 'mscms-' + accountId, proxy: exitProxy, : 'Windows', folder: '' }),
    });
  } catch (e) {
    log('  创建临时 profile 失败: ' + e.message + '，回退用现有运行中的', '⚠️ ');
  }
  if (profile && profile.id) log('  profile=' + profile.id);

  // 启动 -> 拿 CDP
  let ws;
  if (profile && profile.id) {
    try {
      const st = await shx('/profiles/' + profile.id + '/start', { method: 'POST', body: '{}' });
      ws = (st && st.cdp && st.cdp.web_socket_debugger_url) || (st && st.web_socket_debugger_url);
    } catch (e) { log('  启动 profile 失败: ' + e.message, '⚠️ '); ws = null; }
  }
  if (!ws) {
    const running = await shx('/running');
    if (!running.length) throw new Error('没有可用浏览器：临时 profile 启动失败且无 running');
    ws = running[0].cdp.web_socket_debugger_url;
    log('  回退用 running profile=' + running[0].profile_id, '⚠️ ');
  }
  log('  CDP ws=' + ws);

  let browser = null;
  try {
    browser = await chromium.connectOverCDP(ws, { timeout: 30000 });
    const ctx = browser.contexts()[0] || await browser.newContext({ locale: 'en-US' });
    const page = await ctx.newPage();

    // 环境自检
    await page.goto('about:blank', { timeout: 10000 }).catch(() => {});
    const env = await page.evaluate(() => ({
      ua: navigator.userAgent,
      webdriver: navigator.webdriver,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      screen: screen.width + 'x' + screen.height,
    }));
    log('  环境: webdriver=' + env.webdriver + ' tz=' + env.tz + ' screen=' + env.screen);
    log('  UA=' + env.ua.slice(0, 80));

    // ── 名称可用性预检（2026-09-16 新增）────────────────────────────────
    // 在反检测浏览器内发起，同出口同会话；404=可用 / 401=已被占用。
    // 目的：避免把一个「名字已被别人占用」的账号送上注册表单、白白打穿单元配额与信誉。
    // ⚠️ 预检只会【换名】，绝不会因预检异常而中止注册（null 一律放行）。
    // 可用 MSCMS_BLOGNAME_PRECHECK=0 关闭。
    if (process.env.MSCMS_BLOGNAME_PRECHECK !== '0') {
      const st0 = await precheckBlogName(page, blogName);
      if (st0 === false) {
        log('  ⚠️ 名称已被占用: ' + blogName + ' → 按规则换名', '⚠️ ');
        let swapped = false;
        for (let k = 1; k <= 5; k++) {
          const alt = NAMING.buildBlogName(named.family, named.name, named.initial, usedNames, k);
          const st = await precheckBlogName(page, alt);
          if (st === false) { usedNames.add(alt); continue; }
          log('  ✅ 换用可用名: ' + alt + (st === null ? '（预检无法判定，按可用处理）' : ''));
          blogName = alt; usedNames.add(alt); swapped = true; break;
        }
        if (!swapped) log('  ⚠️ 连续 5 个候选名都不可用/判不了，仍按原候选继续（不阻断注册）', '⚠️ ');
      } else if (st0 === true) {
        log('  名称预检: ' + blogName + ' 可用 ✅');
      } else {
        log('  名称预检: 无法判定（不阻断注册）');
      }
    }

    const res = await WithShardX(page, email, pw, blogName, blogTitle);

    if (probe) {
      log('\n--- [probe] 抓包共 ' + res.net.length + ' 条，已保留现场页面（不记账、不落盘）---');
      return { ok: res.createStatus === 200, accountId, email, pw, blogName, unit: unit && unit.unit, ...res };
    }

    // 记账（成功失败都记）——防止失败重试把某单元的每日配额与信誉打穿
    RX.markRegistration({
      unit: unit ? unit.unit : 'unknown',
      egress: egressKey,
      accountId, ip: egressIp, proxy: exitProxy, email,
      ok: res.createStatus === 200,
      note: res.createStatus === 200 ? 'created' : 'create:' + (res.createStatus || 'no-req'),
    });

    if (res.createStatus !== 200) {
      log('  注册失败，放弃（不产生孤儿记录）', '❌ ');
      return { ok: false, accountId, email, blogName, unit: unit && unit.unit, reason: 'create:' + (res.createStatus || 'no-req'), net: res.net };
    }

    // OAuth —— 与注册同出口
    const tok = await oauthInPage(page, accountId, appIdx, exitProxy).catch(e => { log('  OAuth 异常: ' + e.message, '⚠️ '); return null; });
    appendAccount(makeAccountRecord(accountId, email, pw, blogName, false, {
      ...exitMeta(),
      // ── 命名元数据（2026-09-16 走 B）────────────────────────────
      // intended_title：规则推导出的显示名；Tumblr 侧注册期可能设不上（保持 Untitled），
      //   故以 intended_ 前缀标明它是【本地意图】而非「已生效值」——零伪造。
      name_family: named.family,
      naming_rule: 'family-name',
      intended_title: blogTitle,
      title_applied: false,
    }));
    log('  已写入 .json (blog=' + blogName + ', exit=' + (unit && unit.unit) + ', ip=' + (egressIp || 'N/A') + ')', '📝 ');
    return { ok: true, accountId, email, blogName, unit: unit && unit.unit, ip: egressIp, hasToken: !!(tok && tok.oauthToken), net: res.net };
  } catch (e) {
    log('  流程异常: ' + e.message, '❌ ');
    return { ok: false, accountId, reason: 'exception:' + e.message };
  } finally {
    try { if (browser) await browser.close(); } catch (_) {}
    if (profile && profile.id) {
      await shx('/profiles/' + profile.id + '/stop', { method: 'POST', body: '{}' }).catch(() => {});
    }
  }
}

module.exports = { onboardOne, buildUnits: RX.buildUnits, pickUnit: RX.pickUnit, RX };

if (require.main === module) (async () => {
  const argv = process.argv.slice(2);
  const probe = argv.includes('--probe');
  const noThrottle = argv.includes('--no-throttle');
  const ui = argv.indexOf('--unit');
  const unitOverride = ui >= 0 ? argv[ui + 1] : null;
  const count = Math.max(1, parseInt(argv.find(a => /^\d+$/.test(a)) || '1', 10));

  // 出口单元总览（灰度必看）
  const units = RX.buildUnits();
  log('出口单元: ' + units.length + ' 个（CF /64 ' + units.filter(u => u.cf + ' + 其他 ' + units.filter(u => !u.cf + '）');
  for (const u of units) log('   · ' + u.unit.padEnd(26) + ' 条目' + String(u.n).padStart(3) + '  ' + u.proxy + (unitOverride === u.unit ? '   ← 本次指定' : ''));

  log('启动 ShardX Tumblr 注册：count=' + count + ' probe=' + probe + ' unit=' + (unitOverride || 'auto') + ' throttle=' + (noThrottle ? 'off' : 'on') + ' API=' + API);

  // 前置：API 与 token 自检
  const h = await shx('/health');
  log('ShardX: ' + h.name + ' v' + h.version + ' ok=' + h.ok);
  const running = await shx('/running');
  log('当前 running profiles: ' + running.length + ' (总 PID ' + running.map(r => r.pid).join(',') + ')');

  const results = [];
  for (let i = 0; i < count; i++) {
    const r = await onboardOne(i, probe, { unit: unitOverride, noThrottle });
    results.push(r);
    if (r.throttled && unitOverride) { log('  ⏸ 指定单元已节流，停止本次运行'); break; }
    if (i < count - 1) {
      const wait = 15000 + Math.floor(Math.random() * 10000);
      log('  ⏳ 冷却 ' + (wait / 1000) + 's ...');
      await new Promise(r2 => setTimeout(r2, wait));
    }
  }
  const ok = results.filter(r => r.ok;
  log('\n===== 完成：成功 ' + ok + '/' + results.length + ' =====');
  for (const r of results) {
    log('  ' + (r.ok ? '✅' : '❌') + ' ' + r.accountId + ' blog=' + (r.blogName || '-') + ' unit=' + (r.unit || '-') + ' ip=' + (r.ip || '-') + (r.reason ? ' reason=' + r.reason : '') + (r.hasToken === false ? ' token=MISSING' : r.hasToken ? ' token=OK' : ''));
  }
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
