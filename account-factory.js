/**
 * account-factory.js — 社媒账号自动注册工厂
 *
 * 支持平台：X (Twitter) / Reddit / Instagram / TikTok
 *
 * 核心能力：
 *   1. mail.tm 临时邮箱自动获取 + 验证码提取
 *   2. Playwright 浏览器自动化 + 代理隔离
 *   3. 人类行为模拟（随机打字延迟、鼠标轨迹、滚动）
 *   4. 自动 Cookie + Profile 持久化
 *   5. 注册成功后通过 API 自动写入 MySQL
 *
 * 用法：
 *   node account-factory.js --platform=X --count=3 --proxy-pool=proxies.json
 */

const { chromium } = require('playwright-core');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

// ══════════════════════════════════════════════════════════
//  配置
// ══════════════════════════════════════════════════════════

const CFG = {
  apiBase: process.env.API_BASE || 'http://localhost:3002',
  profileDir: path.resolve(process.env.PROFILE_DIR || './profiles'),
  cookieDir: path.resolve(process.env.COOKIE_DIR || './cookies'),
  mailDomain: process.env.MAIL_DOMAIN || 'mail.tm',   // 临时邮箱服务
  headless: process.env.HEADLESS === '1',
  timeout: 60000,
};

// ══════════════════════════════════════════════════════════
//  1. 临时邮箱服务 (mail.tm)
// ══════════════════════════════════════════════════════════

class TempMail {
  constructor() {
    this.base = 'https://api.mail.tm';
    this.account = null;
    this.token = null;
  }

  async createAccount() {
    // 生成随机邮箱
    const name = 'u' + crypto.randomBytes(6).toString('hex');
    const password = crypto.randomBytes(10).toString('hex');

    const { data } = await axios.post(`${this.base}/accounts`, {
      address: `${name}@${CFG.mailDomain}`,
      password,
    }, { timeout: 10000 });

    this.account = data;
    // 获取 token
    const auth = await axios.post(`${this.base}/token`, {
      address: data.address,
      password,
    }, { timeout: 10000 });

    this.token = auth.data.token;
    return { email: data.address, password, id: data.id };
  }

  async waitForCode(timeoutMs = 120000, pollMs = 5000) {
    if (!this.token) throw new Error('No mail account');
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const { data } = await axios.get(`${this.base}/messages`, {
        headers: { Authorization: `Bearer ${this.token}` },
        timeout: 8000,
      });

      const msgs = data['hydra:member'] || [];
      for (const msg of msgs) {
        // 获取邮件正文
        const { data: full } = await axios.get(`${this.base}/messages/${msg.id}`, {
          headers: { Authorization: `Bearer ${this.token}` },
          timeout: 8000,
        });

        const body = (full.text || full.html || '').toLowerCase();
        // 提取 4-8 位验证码
        const codeMatch = body.match(/\b(\d{4,8})\b/);
        if (codeMatch) return codeMatch[1];

        // 提取链接中的 token
        const linkMatch = body.match(/https?:\/\/[^\s]*?(?:verify|confirm|activate)[^\s]*?(?:token|code)=([a-zA-Z0-9_-]+)/i);
        if (linkMatch) return linkMatch[1];
      }

      await new Promise(r => setTimeout(r, pollMs));
    }

    throw new Error('Verification code timeout');
  }
}

// ══════════════════════════════════════════════════════════
//  2. 人类行为模拟工具
// ══════════════════════════════════════════════════════════

async function humanType(page, selector, text) {
  const el = await page.$(selector);
  if (!el) return;
  await el.click({ delay: 100 + Math.random() * 200 });

  for (const char of text) {
    await page.keyboard.type(char, { delay: 40 + Math.random() * 120 });
    if (Math.random() < 0.08) {
      await new Promise(r => setTimeout(r, 200 + Math.random() * 500));
    }
  }
}

async function humanClick(page, selector) {
  const el = await page.waitForSelector(selector, { timeout: 15000 });
  if (!el) return false;
  const box = await el.boundingBox();
  if (box) {
    await page.mouse.move(
      box.x + box.width * (0.3 + Math.random() * 0.4),
      box.y + box.height * (0.3 + Math.random() * 0.4),
      { steps: 5 + Math.floor(Math.random() * 10) }
    );
  }
  await new Promise(r => setTimeout(r, 100 + Math.random() * 300));
  await el.click();
  return true;
}

// ══════════════════════════════════════════════════════════
//  3. 平台注册处理器
// ══════════════════════════════════════════════════════════

/**
 * X (Twitter) 注册
 * 流程：name → email → DOB → verify code → username → password
 */
async function registerX(context, page, { email, username, password, proxyServer }) {
  const log = (msg) => console.log(`[X] ${msg}`);

  log('navigating to signup...');
  await page.goto('https://x.com/i/flow/signup', { waitUntil: 'networkidle', timeout: 30000 });

  // Step 1: Name
  try {
    const displayName = username.replace(/[^a-zA-Z]/g, '').slice(0, 12) || 'User';
    await page.waitForSelector('input[name="name"]', { timeout: 10000 });
    await humanType(page, 'input[name="name"]', displayName);
    log('name filled');
  } catch { log('name step skipped'); }

  // Step 2: Email
  await page.waitForTimeout(1000);
  try {
    // X uses phone by default — need to click "Use email instead"
    const emailLink = await page.$('text=Use email');
    if (emailLink) {
      await emailLink.click();
      await page.waitForTimeout(800);
    }
    await page.waitForSelector('input[name="email"]', { timeout: 5000 });
    await humanType(page, 'input[name="email"]', email);
    log('email filled');
  } catch { log('email step failed'); return null; }

  // Step 3: DOB
  await page.waitForTimeout(1500);
  try {
    // X asks for DOB with select dropdowns
    const selects = await page.$$('select');
    if (selects.length >= 3) {
      await selects[0].selectOption('1');   // January
      await selects[1].selectOption('15');  // 15th
      await selects[2].selectOption('1995'); // 1995
      log('DOB filled');
    }
  } catch { log('DOB step skipped'); }

  // Step 4: Submit and wait for verification
  await page.waitForTimeout(1000);
  const nextBtns = await page.$$('div[role="button"]');
  for (const btn of nextBtns) {
    const text = await btn.textContent().catch(() => '');
    if (text.includes('Next') || text.includes('下一步')) {
      await btn.click();
      break;
    }
  }

  // Step 5: Verification code (from temp mail)
  log('waiting for verification code...');
  // The caller should pass the code or we extract from temp mail
  try {
    await page.waitForSelector('input[name="verification_code"], input[data-testid="ocfEnterTextTextInput"]', { timeout: 30000 });
    // Code will be filled by caller via callback
    log('verification input visible');
  } catch { log('verification step skipped (may already be verified)'); }

  // Step 6: Password
  await page.waitForTimeout(2000);
  try {
    await page.waitForSelector('input[name="password"]', { timeout: 10000 });
    await humanType(page, 'input[name="password"]', password);
    log('password filled');

    // Confirm
    await page.waitForTimeout(500);
    const signupBtn = await page.$('div[data-testid="LoginForm_Login_Button"], div[role="button"]:has-text("Sign up")');
    if (signupBtn) await signupBtn.click();
  } catch { log('password step failed'); return null; }

  // Step 7: Username suggestion
  await page.waitForTimeout(3000);
  try {
    // X suggests usernames — try to set custom one
    const usernameInput = await page.$('input[name="username"]');
    if (usernameInput) {
      await humanType(page, 'input[name="username"]', username);
      log('username set');
    }
  } catch { log('username step skipped'); }

  // Wait for registration to complete
  await page.waitForTimeout(5000);
  const currentUrl = page.url();
  if (currentUrl.includes('home') || currentUrl.includes('x.com/home')) {
    log('SUCCESS — registered and logged in');
    return { success: true, username, email };
  }

  log(`registration may need further steps — current: ${currentUrl}`);
  return { success: true, username, email, needsFollowup: true };
}

/**
 * Reddit 注册
 * 流程：email → username → password → captcha → verify
 */
async function registerReddit(context, page, { email, username, password, proxyServer }) {
  const log = (msg) => console.log(`[Reddit] ${msg}`);

  log('navigating to register...');
  await page.goto('https://www.reddit.com/register/', { waitUntil: 'networkidle', timeout: 30000 });

  // Step 1: Email
  try {
    await page.waitForSelector('input[name="email"]', { timeout: 10000 });
    await humanType(page, 'input[name="email"]', email);
    log('email filled');
  } catch { log('email field not found'); return null; }

  // Step 2: Username check
  await page.waitForTimeout(800);
  try {
    const nextBtn1 = await page.$('button:has-text("Continue"), button[type="submit"]');
    if (nextBtn1) await nextBtn1.click();
    await page.waitForTimeout(2000);
  } catch {}

  // Step 3: Username & Password
  try {
    const usernameEl = await page.$('input[name="username"]');
    if (usernameEl) {
      await humanType(page, 'input[name="username"]', username);
      log('username filled');
    }
    const passEl = await page.$('input[name="password"]');
    if (passEl) {
      await humanType(page, 'input[name="password"]', password);
      log('password filled');
    }
  } catch { log('credential step failed'); return null; }

  // Step 4: Submit
  await page.waitForTimeout(1000);
  try {
    const signupBtn = await page.$('button[type="submit"], button:has-text("Sign Up"), button:has-text("Create")');
    if (signupBtn) {
      await signupBtn.click();
      log('signup submitted');
    }
  } catch {}

  // Wait for result
  await page.waitForTimeout(8000);
  const url = page.url();
  if (url.includes('reddit.com') && !url.includes('register')) {
    log('SUCCESS — registered');
    return { success: true, username, email };
  }

  log(`needs follow-up — captcha likely at: ${url}`);
  return { success: true, username, email, needsFollowup: true, note: 'captcha required' };
}

/**
 * Instagram 注册 (mobile emulation required)
 */
async function registerInstagram(context, page, { email, username, password, proxyServer }) {
  const log = (msg) => console.log(`[IG] ${msg}`);

  log('navigating to signup (mobile)...');
  // Instagram web signup is notoriously hard — try with mobile UA
  await page.goto('https://www.instagram.com/accounts/emailsignup/', {
    waitUntil: 'networkidle',
    timeout: 30000,
  });

  // Step 1: Email
  try {
    await page.waitForSelector('input[name="emailOrPhone"]', { timeout: 10000 });
    await humanType(page, 'input[name="emailOrPhone"]', email);
    log('email filled');
  } catch { log('email field not found'); return null; }

  // Step 2: Full name
  await page.waitForTimeout(500);
  try {
    await humanType(page, 'input[name="fullName"]', username.replace(/[^a-zA-Z]/g, ' ').trim() || 'User Account');
    log('name filled');
  } catch {}

  // Step 3: Username
  await page.waitForTimeout(500);
  try {
    await humanType(page, 'input[name="username"]', username);
    log('username filled');
  } catch {}

  // Step 4: Password
  await page.waitForTimeout(500);
  try {
    await humanType(page, 'input[name="password"]', password);
    log('password filled');
  } catch {}

  // Step 5: Submit
  await page.waitForTimeout(1000);
  try {
    const submitBtn = await page.$('button[type="submit"]');
    if (submitBtn) await submitBtn.click();
    log('signup submitted');
  } catch {}

  await page.waitForTimeout(8000);
  const url = page.url();
  if (url.includes('instagram.com') && !url.includes('signup')) {
    log('SUCCESS');
    return { success: true, username, email };
  }

  log('registration needs follow-up or verification');
  return { success: true, username, email, needsFollowup: true, note: 'email/phone verification required' };
}

/**
 * TikTok 注册
 */
async function registerTikTok(context, page, { email, username, password, proxyServer }) {
  const log = (msg) => console.log(`[TikTok] ${msg}`);

  log('navigating to signup...');
  await page.goto('https://www.tiktok.com/signup', {
    waitUntil: 'networkidle',
    timeout: 30000,
  });

  // TikTok signup is notoriously hard via web — try email method
  try {
    // Click "Use phone or email"
    const emailOpt = await page.$('text=Use phone or email,text=Email');
    if (emailOpt) await emailOpt.click();
    await page.waitForTimeout(1000);
  } catch {}

  // Email
  try {
    await page.waitForSelector('input[name="email"]', { timeout: 8000 });
    await humanType(page, 'input[name="email"]', email);
    log('email filled');
  } catch { log('email field not found'); return null; }

  // Password
  try {
    await page.waitForSelector('input[type="password"]', { timeout: 5000 });
    await humanType(page, 'input[type="password"]', password);
    log('password filled');
  } catch {}

  // Username
  await page.waitForTimeout(1000);
  try {
    const usernameEl = await page.$('input[name="username"]');
    if (usernameEl) {
      await humanType(page, 'input[name="username"]', username);
      log('username filled');
    }
  } catch {}

  // Submit
  try {
    const submitBtn = await page.$('button[type="submit"]');
    if (submitBtn) await submitBtn.click();
    log('signup submitted');
  } catch {}

  await page.waitForTimeout(10000);
  log(`registration flow ended at: ${page.url()}`);
  return { success: true, username, email, needsFollowup: true, note: 'verification/captcha required' };
}

// ══════════════════════════════════════════════════════════
//  4. 注册工厂核心
// ══════════════════════════════════════════════════════════

const REGISTRARS = { X: registerX, Reddit: registerReddit, Instagram: registerInstagram, TikTok: registerTikTok };

/**
 * 注册单个账号
 *
 * @param {object} opts
 * @param {'X'|'Reddit'|'Instagram'|'TikTok'} opts.platform
 * @param {string} opts.proxyServer  - 代理 URL
 * @param {object} [opts.profile]    - {email, username, password} 预生成
 * @returns {Promise<object>}
 */
async function registerAccount(opts = {}) {
  const { platform, proxyServer } = opts;
  if (!platform || !proxyServer) throw new Error('platform and proxyServer required');

  const registrar = REGISTRARS[platform];
  if (!registrar) throw new Error(`Unsupported platform: ${platform}`);

  // ── 1. 生成临时邮箱 ──
  const mail = new TempMail();
  let mailAccount;
  try {
    mailAccount = await mail.createAccount();
    console.log(`[factory] temp email: ${mailAccount.email}`);
  } catch (e) {
    console.log(`[factory] mail.tm failed: ${e.message}, using generated email`);
    mailAccount = { email: `u${crypto.randomBytes(6).toString('hex')}@${CFG.mailDomain}`, password: crypto.randomBytes(10).toString('hex') };
  }

  // ── 2. 生成账号凭据 ──
  const profile = opts.profile || {
    email: mailAccount.email,
    username: `${platform.toLowerCase()}_${crypto.randomBytes(5).toString('hex')}`.slice(0, 15),
    password: crypto.randomBytes(8).toString('hex') + 'Aa1!',
  };

  const botId = `${platform}_Agent_${crypto.randomBytes(3).toString('hex')}`;

  // ── 3. 启动浏览器 ──
  const userDataDir = path.join(CFG.profileDir, `${platform}_${botId}`);
  await fsp.mkdir(userDataDir, { recursive: true });

  const launchOpts = {
    headless: CFG.headless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--disable-webrtc',
      `--window-size=1280,900`,
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  };

  if (platform === 'Instagram' || platform === 'TikTok') {
    // Mobile emulation for mobile-first platforms
    launchOpts.args.push('--window-size=390,844');
  }

  const contextOpts = {
    ...launchOpts,
    viewport: platform === 'Instagram' || platform === 'TikTok'
      ? { width: 390, height: 844 }
      : { width: 1280, height: 900 },
    userAgent: platform === 'Instagram' || platform === 'TikTok'
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/New_York',
    geolocation: { latitude: 40.7128, longitude: -74.006 },
    permissions: ['geolocation'],
  };

  if (proxyServer) {
    const pu = new URL(proxyServer);
    contextOpts.proxy = { server: `${pu.protocol}//${pu.hostname}:${pu.port}` };
    if (pu.username) contextOpts.proxy.username = pu.username;
    if (pu.password) contextOpts.proxy.password = pu.password;
  }

  console.log(`[factory] launching ${platform} registration for ${botId}...`);
  const context = await chromium.launchPersistentContext(userDataDir, contextOpts);

  // 注入反检测
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = { runtime: {}, loadTimes: function(){}, csi: function(){}, app: {} };
  });

  const page = await context.newPage();

  // ── 4. 执行注册 ──
  let result;
  try {
    result = await registrar(context, page, {
      email: profile.email,
      username: profile.username,
      password: profile.password,
      proxyServer,
      mail,           // pass temp mail for code extraction
      mailAccount,
    });

    // If verification code needed, try to extract from temp mail
    if (result?.needsFollowup && mailAccount?.email) {
      try {
        console.log(`[factory] waiting for verification email...`);
        const code = await mail.waitForCode(90000, 6000);
        console.log(`[factory] got verification code: ${code}`);

        // Try to fill the code
        const codeInput = await page.$('input[name="verification_code"], input[data-testid="ocfEnterTextTextInput"], input[type="text"]');
        if (codeInput) {
          await humanType(page, codeInput.tagName === 'INPUT' ? `input[name="${codeInput.getAttribute('name')}"]` : 'input', code);
          await page.waitForTimeout(3000);
          result = { ...result, needsFollowup: false, verified: true };
        }
      } catch (e) {
        console.log(`[factory] verification code timeout: ${e.message}`);
      }
    }
  } catch (err) {
    console.error(`[factory] ${platform} registration error: ${err.message}`);
    result = { success: false, error: err.message };
  }

  // ── 5. 保存 Cookie 快照 ──
  if (result?.success) {
    const cookies = await context.cookies();
    const cookieFile = path.join(CFG.cookieDir, `${botId}.json`);
    await fsp.mkdir(path.dirname(cookieFile), { recursive: true });
    await fsp.writeFile(cookieFile, JSON.stringify(cookies, null, 2));
    console.log(`[factory] saved ${cookies.length} cookies → ${cookieFile}`);

    // ── 6. 自动入库 ──
    try {
      await axios.post(`${CFG.apiBase}/api/v1/accounts`, {
        bot_id: botId,
        platform,
        proxy_server: proxyServer,
        bound_country: 'US',
      }, { timeout: 5000 });
      console.log(`[factory] account ${botId} saved to database`);
    } catch (e) {
      console.log(`[factory] DB save failed (server may be down): ${e.message}`);
    }
  }

  await context.close();

  return {
    botId,
    platform,
    ...profile,
    ...result,
    userDataDir,
    needsFollowup: result?.needsFollowup || false,
  };
}

/**
 * 批量注册
 *
 * @param {'X'|'Reddit'|'Instagram'|'TikTok'} platform
 * @param {number} count          - 注册数量
 * @param {string[]} proxyPool    - 代理地址数组（轮询使用）
 * @param {number} [concurrency=1] - 并发数
 */
async function batchRegister(platform, count, proxyPool, concurrency = 1) {
  if (!proxyPool || proxyPool.length === 0) throw new Error('proxyPool required');

  const results = [];
  const queue = Array.from({ length: count }, (_, i) => ({
    platform,
    proxyServer: proxyPool[i % proxyPool.length],
  }));

  console.log(`\n[factory] BATCH START: ${count} × ${platform}, ${concurrency} workers\n`);

  async function worker(id) {
    while (queue.length > 0) {
      const task = queue.shift();
      if (!task) break;
      console.log(`\n[worker-${id}] starting task ${results.length + 1}/${count}`);
      const result = await registerAccount(task);
      results.push(result);
      console.log(`[worker-${id}] result: ${result.success ? 'OK' : 'FAIL'} — ${result.botId}`);
      // 冷却
      await new Promise(r => setTimeout(r, 5000 + Math.random() * 10000));
    }
  }

  const workers = Array.from({ length: concurrency }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  const ok = results.filter(r => r.success).length;
  console.log(`\n[factory] BATCH COMPLETE: ${ok}/${count} OK\n`);
  return results;
}

// ══════════════════════════════════════════════════════════
//  CLI
// ══════════════════════════════════════════════════════════

async function main() {
  const args = process.argv.slice(2);
  const get = (k) => { const f = args.find(a => a.startsWith(`--${k}=`)); return f ? f.split('=')[1] : null; };

  const platform = get('platform') || 'X';
  const count = parseInt(get('count') || '1', 10);
  const proxyFile = get('proxy-pool');
  const proxySingle = get('proxy');

  let proxyPool = [];
  if (proxyFile) {
    const raw = await fsp.readFile(proxyFile, 'utf-8');
    proxyPool = JSON.parse(raw);
    if (!Array.isArray(proxyPool)) proxyPool = [proxyPool];
  } else if (proxySingle) {
    proxyPool = [proxySingle];
  } else {
    console.error('ERROR: --proxy=... or --proxy-pool=... required');
    process.exit(1);
  }

  await fsp.mkdir(CFG.profileDir, { recursive: true });
  await fsp.mkdir(CFG.cookieDir, { recursive: true });

  if (count === 1) {
    const result = await registerAccount({ platform, proxyServer: proxyPool[0] });
    console.log('\n' + JSON.stringify(result, null, 2));
  } else {
    await batchRegister(platform, count, proxyPool);
  }
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { registerAccount, batchRegister, TempMail, humanType, humanClick };
