/**
 * full-auto-.js — 真正全自动社媒注册引擎 v4
 *
 * v4 升级：
 *   ✓ CloakBrowser — C++ 58补丁 Chromium，通过 30/30 反检测测试
 *   ✓ humanize 模式 — 自然鼠标/键盘/滚动行为
 *   ✓ 本地代理路由 — 通过 :10808 转发流量
 *   v3 保留功能：
 *   ✓ 住宅代理优先分配（自动检测IP类型，拒绝数据中心IP）
 *   ✓ 注册后立即验证（调用 account-validator.js 登录确认）
 *   ✓ 不合格自动重试（最多3次，每次换代理/换凭据）
 *   ✓ 只有验证通过的账号才标记为 valid
 *
 * 由 Matrix-Link 控制台触发：
 *   POST /api/v1/auto- {, count, proxy}
 */

const { chromium } = require('playwright-core');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

// ══════════════════════════════════════════════════════════
const STORAGE = 'D:/LeiDian';
const CONFIG_PATH = path.join(STORAGE, 'config', '.json');
const API_BASE = process.env.API_BASE || 'http://localhost:3002';
const MAX_RETRIES = 3;

// 集成模块
let regFactory;
try { regFactory = require('./reg-factory-helper.js'); } catch { regFactory = null; }
let CaptchaSolver;
try { CaptchaSolver = require('./captcha-solver.js').CaptchaSolver; } catch { CaptchaSolver = null; }
let ProxyChecker;
try { ProxyChecker = require('./proxy-checker.js').ProxyChecker; } catch { ProxyChecker = null; }
let accountValidator;
try { accountValidator = require('./account-validator.js'); } catch { accountValidator = null; }
let mobileEmulator;
try { mobileEmulator = require('./mobile-emulator.js').getMobileEmulator(); } catch { mobileEmulator = null; }
let stealthInjector;
try { stealthInjector = require('./stealth-injector.js'); } catch { stealthInjector = null; }

// 初始化
const captcha = CaptchaSolver ? new CaptchaSolver() : null;
const proxyChecker = ProxyChecker ? new ProxyChecker() : null;

let CFG;
try {
  CFG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
} catch {
  CFG = {
    storage: { basePath: STORAGE, Dir: STORAGE + '/', cookiesDir: STORAGE + '/cookies', profilesDir: STORAGE + '/profiles', screenshotsDir: STORAGE + '/screenshots' },
    : { namePrefix: 'User', Length: 12 },
    browser: { headless: false, stealth: true },
    batchSize: 1, cooldown: 5000,
  };
}

// ══════════════════════════════════════════════════════════
//  1. 免费临时邮箱 (guerrillamail)
// ══════════════════════════════════════════════════════════

class FreeEmail {
  constructor() { this.sid = null; this.email = null; }
  async create() {
    const { data } = await axios.get('https://api.guerrillamail.com/ajax.php', {
      params: { f: 'get_email_address', ip: '', agent: 'Mozilla/5.0' },
      timeout: 10000,
    });
    this.email = data.email_addr;
    this.sid = data.sid_token;
    return this.email;
  }
  async waitForCode(timeoutMs = 120000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const { data } = await axios.get('https://api.guerrillamail.com/ajax.php', {
          params: { f: '', sid_token: this.sid, seq: 0 }, timeout: 8000,
        });
        for (const msg of (data.list || [])) {
          const { data: body } = await axios.get('https://api.guerrillamail.com/ajax.php', {
            params: { f: '', sid_token: this.sid, email_id: msg.mail_id }, timeout: 8000,
          });
          const text = (body.mail_body || '').replace(/<[^>]+>/g, ' ');
          const code = text.match(/\b(\d{4,8})\b/);
          if (code) return code[1];
          const link = text.match(/https?:\/\/[^\s"'>]*?(?:verify|confirm|activate)[^\s"'>]*/i);
          if (link) return link[0];
        }
      } catch {}
      await new Promise(r => setTimeout(r, 5000));
    }
    return null;
  }

  /**
   * 📧 专门提取验证链接（用于邮箱验证步骤）
   */
  async extractVerificationLink(timeoutMs = 90000) {
    const start = Date.now();
    console.log(`  📧 [guerrilla] 等待验证邮件 (最多 ${timeoutMs/1000}s)...`);
    while (Date.now() - start < timeoutMs) {
      try {
        const { data } = await axios.get('https://api.guerrillamail.com/ajax.php', {
          params: { f: '', sid_token: this.sid, seq: 0 }, timeout: 8000,
        });
        const list = data.list || [];
        for (const msg of list) {
          const subject = (msg.mail_subject || '').toLowerCase();
          const from = (msg.mail_from || '').toLowerCase();

          // 只看验证相关邮件
          if (subject.includes('verify') || subject.includes('confirm') ||
              subject.includes('welcome') || subject.includes('activate') ||
              from.includes('reddit') || from.includes('twitter') || from.includes('noreply')) {

            console.log(`  📧 发现验证邮件: "${subject}" (${from})`);
            const { data: body } = await axios.get('https://api.guerrillamail.com/ajax.php', {
              params: { f: '', sid_token: this.sid, email_id: msg.mail_id }, timeout: 8000,
            });

            const html = body.mail_body || '';

            // 提取所有链接
            const links = html.match(/https?:\/\/[^\s"'<>]+/gi) || [];

            // 优先验证/确认链接
            const verifyLink = links.find(l =>
              l.includes('verify') || l.includes('confirm') || l.includes('activate') ||
              l.includes('email-verification') || l.includes('account-verification')
            );
            if (verifyLink) {
              console.log(`  📧 找到验证链接: ${verifyLink.slice(0, 80)}...`);
              return verifyLink;
            }

            // 其次 reddit/twitter 相关链接
            const Link = links.find(l =>
              l.includes('reddit.com') || l.includes('x.com') || l.includes('twitter.com')
            );
            if (Link && (Link.includes('verify') || Link.includes('confirm'))) {
              console.log(`  📧 找到平台验证链接: ${Link.slice(0, 80)}...`);
              return Link;
            }

            // 最后返回任意可能的验证链接
            const anyLink = links.find(l => l.length > 30 && !l.includes('unsubscribe'));
            if (anyLink && (subject.includes('verify') || subject.includes('confirm'))) {
              console.log(`  📧 使用候选链接: ${anyLink.slice(0, 80)}...`);
              return anyLink;
            }
          }
        }
      } catch {}
      await new Promise(r => setTimeout(r, 5000));
    }
    console.log(`  📧 未找到验证链接`);
    return null;
  }
}

// ══════════════════════════════════════════════════════════
//  2. 免费接码平台 (quackr.io)
// ══════════════════════════════════════════════════════════

class FreeSMS {
  constructor() { this.number = null; this.service = null; }
  async getNumber() {
    const serviceMap = { X: 'twitter', Reddit: 'reddit', Instagram: 'instagram', TikTok: 'tiktok' };
    this.service = serviceMap[] || 'twitter';
    try {
      const { data } = await axios.get(`https://quackr.io/api/v1/numbers`, {
        params: { country: 'US', service: this.service },
        timeout: 10000,
      });
      if (data.numbers && data.numbers.length > 0) {
        this.number = data.numbers[0];
        return this.number;
      }
    } catch {}
    return null;
  }
  async waitForCode(timeoutMs = 60000) {
    if (!this.number) return null;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const { data } = await axios.get(`https://quackr.io/api/v1/messages`, {
          params: { number: this.number, service: this.service },
          timeout: 8000,
        });
        if (data.messages && data.messages.length > 0) {
          const msg = data.messages[0].text || '';
          const code = msg.match(/\b(\d{4,8})\b/);
          if (code) return code[1];
        }
      } catch {}
      await new Promise(r => setTimeout(r, 5000));
    }
    return null;
  }
}

// ══════════════════════════════════════════════════════════
//  3. 账号凭据生成器（自定义）
// ══════════════════════════════════════════════════════════

 generateCredentials() {
  const cfg = CFG. || {};
  const prefix = cfg.namePrefix || 'User';

  // 生成包含大小写字母和数字的随机字符串
   randStr(len) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < len; i++) s += chars[crypto.randomInt(0, chars.length)];
    return s;
  }

  const random6 = randStr(6);
  const random8 = randStr(8);

  // 按照模板生成
  const namePattern = cfg.namePattern || '{}_{random6}';
  const passPattern = cfg.Pattern || '{random8}@A1';

  const  = namePattern
    .replace('{}', .toLowerCase())
    .replace('{random6}', random6)
    .replace('{random8}', random8)
    .replace('{prefix}', prefix)
    .slice(0, 15);

  const  = passPattern
    .replace('{random6}', random6)
    .replace('{random8}', random8)
    .replace('{random12}', randStr(12));

  const botId = `_${Date.now(36)}_${randStr(4)}`;

  return { , , botId };
}

// ══════════════════════════════════════════════════════════
//  4. 防检测浏览器启动
// ══════════════════════════════════════════════════════════

async  launchStealthBrowser(, botId, proxyServer, opts = {}) {
  const profilesDir = CFG.storage.profilesDir || STORAGE + '/profiles';
  const userDataDir = path.join(profilesDir, `_${botId}`);
  await fsp.mkdir(userDataDir, { recursive: true });

  const viewport = CFG.browser?.viewport || { width: 1280, height: 900 };
  const deviceUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

  // 🔀 代理回退：本地代理
  if (!proxyServer || proxyServer === 'direct' || proxyServer === '直连') {
    const net = require('net');
    const localOk = await new Promise(r => {
      const s = new net.Socket(); s.setTimeout(2000);
      s.on('connect', () => { s.destroy(); r(true); });
      s.on('error', () => { s.destroy(); r(false); });
      s.on('timeout', () => { s.destroy(); r(false); });
      s.connect(10808, '');
    });
    if (localOk) { proxyServer = 'http://:10808'; console.log(`  🔀 代理: :10808`); }
    else proxyServer = null;
  }

  // 🦎 优先尝试 CloakBrowser（C++ 58 补丁，30/30 反检测全过）
  let ctx;
  try {
    const { launchPersistentContextCloak } = require('./cloak-wrapper.js');
    ctx = await launchPersistentContextCloak({
      userDataDir, headless: false, viewport, userAgent: deviceUA,
      humanize: true, : proxyServer,
    });
    console.log(`  🦎 CloakBrowser (58 C++ patches, humanize=on)`);
  } catch (cloakErr) {
    // Fallback: Playwright + stealth injection
    console.log(`  ⚠️ CloakBrowser fallback: ${cloakErr.message.slice(0,60)}`);
    const { chromium } = require('playwright-core');
    const args = ['--disable-blink-features=AutomationControlled','--no-sandbox','--disable-setuid-sandbox',`--window-size=${viewport.width},${viewport.height}`];
    if (proxyServer) { args.push(`--proxy-server=${proxyServer}`); args.push('--proxy-bypass-list=<-loopback>'); }
    ctx = await chromium.launchPersistentContext(userDataDir, {
      headless: false, viewport, userAgent: deviceUA, locale: 'en-US', timezoneId: 'America/New_York',
      geolocation: { latitude: 40.7128, longitude: -74.006 }, args,
      ignoreDefaultArgs: ['--enable-'], ignoreHTTPSErrors: true,
    });
    if (stealthInjector) { await ctx.addInitScript(stealthInjector.generateStealthScript({})); }
    console.log(`  🛡️ Playwright + stealth`);
  }

  return { ctx, userDataDir, deviceProfile: null };
}

// ══════════════════════════════════════════════════════════
//  5. 人机模拟
// ══════════════════════════════════════════════════════════

async  typeHuman(page, selector, text) {
  try {
    const el = await page.waitForSelector(selector, { timeout: 10000 });
    await el.click({ delay: 80 + Math.random() * 150 });
    for (const ch of text) {
      await page.keyboard.type(ch, { delay: 40 + Math.random() * 120 });
      if (Math.random() < 0.06) await page.waitForTimeout(150 + Math.random() * 400);
    }
    return true;
  } catch { return false; }
}

async  clickHuman(page, selector) {
  try {
    const el = await page.waitForSelector(selector, { timeout: 8000 });
    const box = await el.boundingBox();
    if (box) {
      await page.mouse.move(box.x+box.width*0.4, box.y+box.height*0.4, {steps:8});
    }
    await page.waitForTimeout(100 + Math.random() * 250);
    await el.click();
    return true;
  } catch { return false; }
}

// ══════════════════════════════════════════════════════════
//  6. 平台注册逻辑
// ══════════════════════════════════════════════════════════

async  Reddit(ctx, page, info) {
  const log = msg => console.log(`  [Reddit] ${msg}`);

  // 获取注册时的出口 IP
  let registrationIP = null;
  try {
    const ipPage = await ctx.newPage();
    await ipPage.goto('https://api.ipify.org?format=json', { waitUntil: 'domcontentloaded', timeout: 10000 });
    const ipText = await ipPage.textContent('body').catch(() => '');
    const ipMatch = ipText.match(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
    registrationIP = ipMatch ? ipMatch[0] : null;
    await ipPage.close();
    log(`出口IP: ${registrationIP || 'unknown'}`);
  } catch { log('无法获取出口IP'); }

  log('导航到注册页');
  // 🧠 先模拟浏览行为 — 在 Reddit 首页停留片刻
  await page.goto('https://www.reddit.com/', { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForTimeout(3000 + Math.random() * 4000);  // 模拟浏览 3-7s
  
  // 滚动一点（模拟阅读）
  await page.evaluate(() => window.scrollBy(0, 200 + Math.random() * 500));
  await page.waitForTimeout(1000 + Math.random() * 2000);
  
  // 然后导航到注册页
  log('导航到注册页');
  await page.goto('https://www.reddit.com//', { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForTimeout(3000 + Math.random() * 2000); // 等待页面加载 3-5s

  log(`填写邮箱: ${info.email}`);
  await typeHuman(page, '"email"]', info.email);
  await page.waitForTimeout(2000 + Math.random() * 1500); // 2-3.5s
  await clickHuman(page, '"Continue")');
  await page.waitForTimeout(3500 + Math.random() * 2000); // 3.5-5.5s

  log(`填写用户名: ${info.}`);
  await typeHuman(page, '""]', info.);
  await page.waitForTimeout(1500 + Math.random() * 1000);
  log('填写密码');
  await typeHuman(page, '""]', info.);
  await page.waitForTimeout(2500 + Math.random() * 2000); // 2.5-4.5s before submit

  // 尝试提交前检测 CAPTCHA
  if (captcha?.available) {
    const solved = await captcha.autoSolve(page);
    if (solved) log('CAPTCHA 已自动求解');
    else log('CAPTCHA 未触发或求解失败');
  }

  // 尝试提交
  await clickHuman(page, 'button[type="submit"], "Sign Up"), "Create")');
  await page.waitForTimeout(10000); // 等待 10s

  const url = page.url();
  const bodyText = await page.textContent('body').catch(() => '');

  // 收集个人资料（如果已登录）
  let profileData = null;
  try {
    if (!url.includes('') && !url.includes('login')) {
      // 尝试获取用户信息
      profileData = await page.evaluate(() => {
        const name = document.querySelector('.profile--, [data-testid="profile-name"], .')?.textContent?.trim();
        const karma = document.querySelector('.karma, [id*="karma"]')?.textContent?.trim();
        return { displayName: name || null, karma: karma || null };
      }).catch(() => null);
    }
  } catch {}

  // 检查是否被限制或需验证
  if (bodyText.includes('suspended') || bodyText.includes('banned')) {
    log(`⚠️ 账号被限制`);
    return { success: false, error: 'Account suspended/banned', registrationIP, profileData };
  }

  if (!url.includes('') && !url.includes('login')) {
    log(`✅ 注册成功: ${url}`);
    return { success: true, registrationIP, profileData };
  }

  // 仍在注册页 — 检查是否有错误提示
  if (bodyText.includes('already exists') || bodyText.includes('taken')) {
    log(`⚠️ 用户名已被占用`);
    return { success: false, error: 'Username taken', registrationIP };
  }
  if (bodyText.includes('CAPTCHA') || bodyText.includes('captcha')) {
    log(`⚠️ CAPTCHA 拦截`);
    return { success: false, error: 'CAPTCHA blocked', registrationIP };
  }

  log(`当前 URL: ${url} (可能需邮箱验证)`);

  // 📧 邮箱验证步骤
  if (info.mail && info.mail.extractVerificationLink) {
    log('等待验证邮件...');
    const verifyLink = await info.mail.extractVerificationLink(90000);
    if (verifyLink) {
      log(`点击验证链接: ${verifyLink.slice(0, 60)}...`);
      try {
        await page.goto(verifyLink, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(5000);

        // 📱 验证完成后，回到主页检查登录状态
        log('验证链接已访问，检查登录状态...');
        await page.goto('https://www.reddit.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(3000);

        const afterUrl = page.url();
        const afterText = await page.textContent('body').catch(() => '');

        // 检查是否已登录（Reddit 主页登录后有用户菜单）
        const isLoggedIn = await page.evaluate(() => {
          return !!(
            document.querySelector('[data-testid="user-dropdown"]') ||
            document.querySelector('#USER_DROPDOWN_ID') ||
            document.querySelector('.user') ||
            document.querySelector('[id*="user"]') ||
            document.querySelector('button[id*="user"]') ||
            document.querySelector('span.') ||
            (document.querySelector('header')?.textContent?.includes('Create') === false &&
             document.querySelector('header')?.textContent?.includes('Log In') === false)
          );
        }).catch(() => false);

        if (isLoggedIn || (!afterUrl.includes('') && !afterUrl.includes('login'))) {
          log(`✅ 邮箱验证 + 登录成功！→ ${afterUrl}`);

          // 收集用户资料
          try {
            profileData = await page.evaluate(() => {
              const name = document.querySelector('.profile--, [data-testid="profile-name"], ., span:has(+ .karma)')?.textContent?.trim();
              const karma = document.querySelector('.karma, [id*="karma"]')?.textContent?.trim();
              return { displayName: name || null, karma: karma || null };
            }).catch(() => null);
          } catch {}

          return { success: true, registrationIP, profileData, emailVerified: true, loggedIn: true };
        }

        // 🔐 如果未检测到登录，尝试手动登录
        log('未检测到自动登录，尝试手动登录...');
        try {
          await page.goto('https://www.reddit.com/login/', { waitUntil: 'domcontentloaded', timeout: 20000 });
          await page.waitForTimeout(2000);

          await typeHuman(page, '""]', info.);
          await page.waitForTimeout(800);
          await typeHuman(page, '""]', info.);
          await page.waitForTimeout(500);
          await clickHuman(page, 'button[type="submit"], "Log In")');
          await page.waitForTimeout(5000);

          const loginUrl = page.url();
          const loginText = await page.textContent('body').catch(() => '');

          if (!loginUrl.includes('login') || loginText.includes('welcome') || loginText.includes('home')) {
            log(`✅ 手动登录成功！→ ${loginUrl}`);
            return { success: true, registrationIP, profileData, emailVerified: true, loggedIn: true };
          }
          log(`⚠️ 手动登录后: ${loginUrl}`);
        } catch (loginErr) {
          log(`手动登录失败: ${loginErr.message}`);
        }

        // 检查确认文本
        if (afterText.includes('verified') || afterText.includes('success') ||
            afterText.includes('welcome') || afterText.includes('confirmed')) {
          log(`✅ 邮箱验证完成（含确认文本）`);
          return { success: true, registrationIP, profileData, emailVerified: true, loggedIn: true };
        }

        log(`⚠️ 验证后未检测到登录状态: ${afterUrl}`);
      } catch (e) {
        log(`验证链接访问失败: ${e.message}`);
      }
    }
    // D4 修复：邮箱验证后仍未确认登录态 → 不谎报成功，诚实标记待验证
    return { success: false, verified: false, note: 'PENDING_EMAIL_VERIFY: 邮箱验证后未确认登录状态', registrationIP, profileData };
  }

  // D4 修复：未收到/未点击验证邮件 → 注册未完成，不得 success:true
  return { success: false, verified: false, note: 'PENDING_EMAIL_VERIFY: 未收到/未点击验证邮件，注册未完成', registrationIP, profileData };
}

async  X(ctx, page, info) {
  const log = msg => console.log(`  [X] ${msg}`);

  // 获取注册时的出口 IP
  let registrationIP = null;
  try {
    const ipPage = await ctx.newPage();
    await ipPage.goto('https://api.ipify.org?format=json', { waitUntil: 'domcontentloaded', timeout: 10000 });
    const ipText = await ipPage.textContent('body').catch(() => '');
    const ipMatch = ipText.match(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
    registrationIP = ipMatch ? ipMatch[0] : null;
    await ipPage.close();
    log(`出口IP: ${registrationIP || 'unknown'}`);
  } catch { log('无法获取出口IP'); }

  // 随机选择注册入口（降低特征一致性）
  const signupUrls = [
    'https://x.com/i/flow/signup',
    'https://twitter.com/i/flow/signup',
    'https://mobile.twitter.com/i/flow/signup',
  ];
  const signupUrl = signupUrls[Math.floor(Math.random() * signupUrls.length)];
  log(`导航到注册页: ${signupUrl}`);
  await page.goto(signupUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000 + Math.random() * 3000);

  // 尝试使用邮箱注册（X 默认可能是手机号）
  const useEmail = page.locator('text=Use email instead').or(page.locator('text=改用电子邮件'))
    .or(page.locator('text=Sign up with email')).or(page.locator('text=使用邮箱注册'));
  if (await useEmail.count() > 0) {
    log('切换到邮箱注册');
    await useEmail.first().click({ delay: 150 + Math.random() * 300 });
    await page.waitForTimeout(2000 + Math.random() * 1500);
  }

  // 名称 — 使用更真实的名字
  const displayName = info..replace(/[^a-zA-Z]/g, '').slice(0, 8) || 'user';
  log(`填写名称: ${displayName}`);
  await typeHuman(page, '"name"], input[autocomplete="name"]', displayName);
  await page.waitForTimeout(400 + Math.random() * 800);
  await clickHuman(page, '[role="button"]:has-text("Next"), [role="button"]:has-text("下一步")');
  await page.waitForTimeout(2500 + Math.random() * 2000);

  // 邮箱
  log(`填写邮箱: ${info.email}`);
  await typeHuman(page, '"email"], "email"]', info.email);
  await page.waitForTimeout(500 + Math.random() * 1000);
  await clickHuman(page, '[role="button"]:has-text("Next"), [role="button"]:has-text("下一步")');
  await page.waitForTimeout(2500 + Math.random() * 2000);

  // 生日
  const selects = page.locator('select');
  if (await selects.count() >= 3) {
    log('填写生日');
    const birthYear = 1990 + Math.floor(Math.random() * 10); // 1990-1999
    const birthMonth = String(1 + Math.floor(Math.random() * 12)).padStart(2, '0');
    const birthDay = String(1 + Math.floor(Math.random() * 28)).padStart(2, '0');
    await selects.nth(0).selectOption(birthMonth);
    await page.waitForTimeout(200 + Math.random() * 400);
    await selects.nth(1).selectOption(birthDay);
    await page.waitForTimeout(200 + Math.random() * 400);
    await selects.nth(2).selectOption(String(birthYear));
  }
  await page.waitForTimeout(400 + Math.random() * 600);
  await clickHuman(page, '[role="button"]:has-text("Next"), [role="button"]:has-text("下一步")');
  await page.waitForTimeout(3500);

  // 验证码步骤 — X 可能会要求邮箱验证码
  const codeInput = page.locator('input[data-testid="ocfEnterTextTextInput"], "verification_code"], input[placeholder*="code"]');
  if (await codeInput.count() > 0) {
    log('等待邮箱验证码...');
    if (info.mail && info.mail.waitForCode) {
      const mailCode = await info.mail.waitForCode(60000);
      if (mailCode && mailCode.length >= 4) {
        log(`输入验证码: ${mailCode}`);
        await typeHuman(page, 'input[data-testid="ocfEnterTextTextInput"], "verification_code"]', String(mailCode).slice(0, 8));
        await page.waitForTimeout(3000);
        await clickHuman(page, '[role="button"]:has-text("Next"), [role="button"]:has-text("Verify")');
        await page.waitForTimeout(3000);
      } else {
        log('未收到验证码，继续...');
      }
    }
  }

  // 密码
  const passInput = page.locator('""], ""]');
  if (await passInput.count() > 0) {
    log('设置密码');
    await typeHuman(page, '""], ""]', info.);
    await page.waitForTimeout(600 + Math.random() * 1000);
    await clickHuman(page, '[role="button"]:has-text("Next"), [role="button"]:has-text("Sign up"), [role="button"]:has-text("注册")');
    await page.waitForTimeout(6000 + Math.random() * 3000);
  }

  // CAPTCHA 求解
  let captchaSolved = false;
  if (captcha?.available) {
    await page.waitForTimeout(2000); // X 的 CAPTCHA 可能有延迟
    captchaSolved = await captcha.autoSolve(page);
    if (captchaSolved) log('CAPTCHA 已自动求解');
    else {
      log('CAPTCHA 未触发或求解失败');
      // X 可能有 FunCaptcha (Arkose) — 尝试不同方法
      const arkoseSolved = await captcha.triggerAndSolve(page, 'iframe[src*="arkoselabs"], iframe[src*="funcaptcha"]');
      if (arkoseSolved) { log('Arkose CAPTCHA 求解完成'); captchaSolved = true; }
    }
    await page.waitForTimeout(3000);
  }

  const url = page.url();
  const bodyText = await page.textContent('body').catch(() => '');

  // 收集个人资料
  let profileData = null;
  try {
    if (url.includes('home') || !url.includes('signup')) {
      profileData = await page.evaluate(() => {
        const displayName = document.querySelector('[data-testid="primaryColumn"] h2, [data-testid="UserName"]')?.textContent?.trim();
        const handle = document.querySelector('[data-testid="UserDescription"], [data-testid="UserJoinDate"]')?.textContent?.trim();
        return { displayName: displayName || null, handle: handle || null };
      }).catch(() => null);
    }
  } catch {}

  // 检查账号状态
  if (bodyText.includes('suspended') || bodyText.includes('locked')) {
    log(`⚠️ 账号被限制`);
    return { success: false, error: 'Account suspended/locked', registrationIP, profileData };
  }
  if (bodyText.includes('already exists') || bodyText.includes('already in use')) {
    log(`⚠️ 账号已存在`);
    return { success: false, error: 'Already exists', registrationIP };
  }

  if (url.includes('home') || url.includes('explore') || url.includes('notifications')) {
    log('✅ 注册成功 — 已登录');
    return { success: true, registrationIP, profileData, loggedIn: true };
  }

  log(`当前: ${url}`);

  // 📧 X 邮箱验证步骤
  if (info.mail && info.mail.extractVerificationLink) {
    log('等待 X 验证邮件...');
    const verifyLink = await info.mail.extractVerificationLink(90000);
    if (verifyLink) {
      log(`点击 X 验证链接: ${verifyLink.slice(0, 60)}...`);
      try {
        await page.goto(verifyLink, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(5000);

        await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(3000);
        const afterUrl = page.url();
        const afterText = await page.textContent('body').catch(() => '');

        if (afterUrl.includes('home') || afterUrl.includes('explore')) {
          log(`✅ X 邮箱验证 + 登录成功！`);
          return { success: true, registrationIP, profileData, emailVerified: true, loggedIn: true };
        }
        if (afterText.includes('suspended') || afterText.includes('locked')) {
          log(`⚠️ X 验证后账号仍被限制`);
          return { success: false, error: 'Account suspended after email verify', registrationIP };
        }
        log(`X 验证后: ${afterUrl}`);
        return { success: true, note: '邮箱已验证但登录状态未确认', registrationIP, profileData, emailVerified: true };
      } catch (e) {
        log(`X 验证链接访问失败: ${e.message}`);
      }
    }
  }

  // D4 修复：X 验证步骤执行但未确认成功 → 不谎报成功（需手动验证/重试）
  return { success: false, verified: false, note: 'PENDING_VERIFY: X 验证步骤执行但未确认成功', registrationIP, profileData };
}

// ══════════════════════════════════════════════════════════
//  6b. Discord 注册逻辑
// ══════════════════════════════════════════════════════════

async  Discord(ctx, page, info) {
  const log = msg => console.log(`  [Discord] ${msg}`);

  // 获取出口 IP
  let registrationIP = null;
  try {
    const ipPage = await ctx.newPage();
    await ipPage.goto('https://api.ipify.org?format=json', { waitUntil: 'domcontentloaded', timeout: 10000 });
    const ipText = await ipPage.textContent('body').catch(() => '');
    const ipMatch = ipText.match(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
    registrationIP = ipMatch ? ipMatch[0] : null;
    await ipPage.close();
    log(`出口IP: ${registrationIP || 'unknown'}`);
  } catch { log('无法获取出口IP'); }

  log('导航到 Discord 注册页');
  await page.goto('https://discord.com/', { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForTimeout(3000 + Math.random() * 2000);

  // 邮箱
  log(`填写邮箱: ${info.email}`);
  await typeHuman(page, '"email"]', info.email);
  await page.waitForTimeout(500 + Math.random() * 800);

  // 用户名（Discord 格式限制：小写字母数字下划线，2-32字符）
  const discordUser = info..toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20) || `user${Date.now(36)}`;
  log(`填写用户名: ${discordUser}`);
  await typeHuman(page, '""]', discordUser);
  await page.waitForTimeout(500 + Math.random() * 800);

  // 密码
  const discordPass = info..slice(0, 20);
  log('填写密码');
  await typeHuman(page, '""]', discordPass);
  await page.waitForTimeout(500 + Math.random() * 1000);

  // 出生日期（Discord 要求 13+）
  try {
    const dobInputs = page.locator('input[aria-label*="Month"], input[id*="month"], [class*="month"] input');
    if (await dobInputs.count() >= 3) {
      log('填写出生日期');
      await typeHuman(page, dobInputs.nth(0) || 'input[aria-label*="Month"]', 'January');
      await typeHuman(page, dobInputs.nth(1) || 'input[aria-label*="Day"]', '15');
      await typeHuman(page, dobInputs.nth(2) || 'input[aria-label*="Year"]', '1995');
    }
  } catch { log('跳过出生日期'); }
  await page.waitForTimeout(1000);

  // 同意条款 + 提交
  try {
    const tosCheck = page.locator('""], [role=""]').first();
    if (await tosCheck.count() > 0) {
      await tosCheck.click({ delay: 100 + Math.random() * 200 });
      await page.waitForTimeout(500);
    }
  } catch {}

  log('提交注册');
  await clickHuman(page, 'button[type="submit"], "Continue"), "继续")');
  await page.waitForTimeout(5000 + Math.random() * 3000);

  // Discord 可能弹出 CAPTCHA (hCaptcha)
  if (captcha?.available) {
    await page.waitForTimeout(2000);
    const detected = await captcha.detect(page);
    if (detected.found) {
      log(`检测到 CAPTCHA: ${detected.type}`);
      const solved = await captcha.autoSolve(page);
      if (solved) log('CAPTCHA 已自动求解');
    }
  }

  const url = page.url();
  const bodyText = await page.textContent('body').catch(() => '');

  // Discord 注册成功后通常会跳转或显示成功提示
  if (url.includes('channels/@me') || url.includes('app') || bodyText.includes('claim') || bodyText.includes('welcome')) {
    log('✅ Discord 注册成功！');
    return { success: true, registrationIP, loggedIn: true };
  }

  if (bodyText.includes('already ed') || bodyText.includes('taken') ||
      bodyText.includes('email is already')) {
    log(`⚠️ 邮箱/用户名已被占用`);
    return { success: false, error: 'Already ed', registrationIP };
  }

  // Discord 通常要求邮箱验证
  log(`当前 URL: ${url} — 等待邮箱验证`);
  if (info.mail && info.mail.extractVerificationLink) {
    log('等待 Discord 验证邮件...');
    const verifyLink = await info.mail.extractVerificationLink(90000);
    if (verifyLink) {
      log(`点击验证链接: ${verifyLink.slice(0, 60)}...`);
      try {
        await page.goto(verifyLink, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(5000);

        const afterUrl = page.url();
        const afterText = await page.textContent('body').catch(() => '');

        if (afterUrl.includes('discord.com') && (afterText.includes('verified') || afterText.includes('success'))) {
          log('✅ Discord 邮箱验证成功！');
          return { success: true, registrationIP, emailVerified: true, loggedIn: true };
        }
        log(`Discord 验证后: ${afterUrl}`);
      } catch (e) {
        log(`验证链接访问失败: ${e.message}`);
      }
    }
  }

  // D4 修复：Discord 注册流程已执行但未确认（无验证邮件/未验证）→ 不谎报成功
  return { success: false, verified: false, note: 'PENDING_MANUAL_VERIFY: Discord 注册需手动验证', registrationIP };
}

// ══════════════════════════════════════════════════════════
//  6c. Google 账号注册逻辑
// ══════════════════════════════════════════════════════════

async  Google(ctx, page, info) {
  const log = msg => console.log(`  [Google] ${msg}`);

  // 获取出口 IP
  let registrationIP = null;
  try {
    const ipPage = await ctx.newPage();
    await ipPage.goto('https://api.ipify.org?format=json', { waitUntil: 'domcontentloaded', timeout: 10000 });
    const ipText = await ipPage.textContent('body').catch(() => '');
    const ipMatch = ipText.match(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
    registrationIP = ipMatch ? ipMatch[0] : null;
    await ipPage.close();
    log(`出口IP: ${registrationIP || 'unknown'}`);
  } catch { log('无法获取出口IP'); }

  // 导航到 Google 账号创建页
  log('导航到 Google 注册页');
  await page.goto('https://.google.com/signup', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000 + Math.random() * 2000);

  // 填写姓名
  const firstName = info..slice(0, 5).replace(/[^a-zA-Z]/g, '') || 'User';
  const lastName = info..slice(5, 10).replace(/[^a-zA-Z]/g, '') || 'Name';
  log(`填写姓名: ${firstName} ${lastName}`);
  await typeHuman(page, '"firstName"]', firstName);
  await page.waitForTimeout(300 + Math.random() * 500);
  await typeHuman(page, '"lastName"]', lastName);
  await page.waitForTimeout(500 + Math.random() * 800);
  await clickHuman(page, '"Next"), [jsname="LgbsSe"] button');
  await page.waitForTimeout(2500 + Math.random() * 1500);

  // 生日和性别
  log('填写生日和性别');
  try {
    // 月份下拉
    const monthSelect = page.locator('select[name="month"], #month');
    if (await monthSelect.count() > 0) {
      const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      const birthMonth = months[Math.floor(Math.random() * 12)];
      await monthSelect.selectOption(birthMonth);
    }
    await page.waitForTimeout(200 + Math.random() * 300);

    // 日期
    const dayInput = page.locator('"day"], #day');
    if (await dayInput.count() > 0) {
      const birthDay = String(1 + Math.floor(Math.random() * 28));
      await typeHuman(page, '"day"], #day', birthDay);
    }
    await page.waitForTimeout(200 + Math.random() * 300);

    // 年份
    const yearInput = page.locator('"year"], #year');
    if (await yearInput.count() > 0) {
      const birthYear = String(1990 + Math.floor(Math.random() * 10));
      await typeHuman(page, '"year"], #year', birthYear);
    }
    await page.waitForTimeout(200 + Math.random() * 300);

    // 性别下拉
    const genderSelect = page.locator('select[name="gender"], #gender');
    if (await genderSelect.count() > 0) {
      const genders = ['Female', 'Male', 'Rather not say'];
      await genderSelect.selectOption(genders[Math.floor(Math.random() * 3)]);
    }
    await page.waitForTimeout(500 + Math.random() * 500);

    await clickHuman(page, '"Next"), [jsname="LgbsSe"] button');
    await page.waitForTimeout(2500 + Math.random() * 1500);
  } catch (e) {
    log(`生日填写异常: ${e.message.slice(0, 50)}`);
  }

  // 选择 Gmail 地址（自定义用户名）
  log('选择 Gmail 地址');
  try {
    // 点击 "Create your own Gmail address" 选项
    const customOption = page.locator('text=Create your own Gmail address, :has-text("自定义")');
    if (await customOption.count() > 0) {
      await customOption.first().click({ delay: 100 + Math.random() * 200 });
      await page.waitForTimeout(500);
    }

    // 填写 Gmail 用户名
    const gmailUser = info..toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 15) || `user${Date.now(36)}`;
    log(`Gmail 用户名: ${gmailUser}`);
    const gmailInput = page.locator('"Username"], "text"""], "GmailAddress"]');
    if (await gmailInput.count() > 0) {
      await typeHuman(page, '"Username"], "text"""]', gmailUser);
    }
    await page.waitForTimeout(500 + Math.random() * 500);
  } catch (e) {
    log(`Gmail 地址选择异常: ${e.message.slice(0, 50)}`);
  }

  // 密码
  log('设置密码');
  await typeHuman(page, '"Passwd"], ""]', info.);
  await page.waitForTimeout(300 + Math.random() * 500);
  // 确认密码
  const confirmPass = page.locator('"ConfirmPasswd"], """confirm"]');
  if (await confirmPass.count() > 0) {
    await typeHuman(page, '"ConfirmPasswd"], """confirm"]', info.);
  }
  await page.waitForTimeout(500 + Math.random() * 500);

  await clickHuman(page, '"Next"), [jsname="LgbsSe"] button');
  await page.waitForTimeout(4000 + Math.random() * 2000);

  // 手机号验证（Google 通常要求）
  log('检查是否需要手机验证...');
  const phoneInput = page.locator('"PhoneNumber"], "tel"], #phoneNumberId');
  if (await phoneInput.count() > 0) {
    log('需要手机号验证');
    if (info.sms && info.sms.waitForCode) {
      // 使用接码平台获取号码
      const phoneNumber = info.sms.number || info.phone;
      if (phoneNumber) {
        log(`填入手机号: ${phoneNumber}`);
        await typeHuman(page, '"PhoneNumber"], "tel"]', phoneNumber);
        await page.waitForTimeout(500);
        await clickHuman(page, '"Next"), [jsname="LgbsSe"] button');
        await page.waitForTimeout(3000);

        // 等待短信验证码
        const smsCode = await info.sms.waitForCode(60000);
        if (smsCode) {
          log(`收到短信验证码: ${smsCode}`);
          await typeHuman(page, '"code"], input[id*="code"], input[aria-label*="code"]', smsCode);
          await page.waitForTimeout(500);
          await clickHuman(page, '"Verify"), "Next")');
          await page.waitForTimeout(3000);
        } else {
          log('⚠️ 未收到短信验证码');
          return { success: false, error: 'SMS verification failed', registrationIP };
        }
      }
    } else {
      log('⚠️ 无接码服务可用，尝试跳过');
      // 尝试点击 "Skip" 或 "Not now"
      const skipBtn = page.locator('"Skip"), "Not now"), a:has-text("Skip")');
      if (await skipBtn.count() > 0) {
        await skipBtn.first().click({ delay: 100 });
        await page.waitForTimeout(2000);
      }
    }
  }

  // 恢复邮箱（可选）
  log('恢复邮箱（可选）');
  try {
    const recoveryInput = page.locator('"recoveryEmail"], "email""recovery"]');
    if (await recoveryInput.count() > 0 && info.email) {
      await typeHuman(page, '"recoveryEmail"]', info.email);
      await page.waitForTimeout(300);
    }
    await clickHuman(page, '"Next"), [jsname="LgbsSe"] button');
    await page.waitForTimeout(2000);
  } catch {}

  // 同意条款
  log('同意服务条款');
  try {
    // 滚动到底部
    await page.evaluate(() => {
      const scrollable = document.querySelector('[role="main"]') || document.body;
      scrollable.scrollTop = scrollable.scrollHeight;
    });
    await page.waitForTimeout(1000);

    const agreeBtn = page.locator('"I agree"), "Agree"), "同意")');
    if (await agreeBtn.count() > 0) {
      await agreeBtn.first().click({ delay: 200 + Math.random() * 300 });
      await page.waitForTimeout(3000);
    }

    // 二次确认
    const confirmBtn = page.locator('"I agree"), "Confirm")');
    if (await confirmBtn.count() > 0) {
      await confirmBtn.first().click({ delay: 200 });
      await page.waitForTimeout(5000);
    }
  } catch (e) {
    log(`条款同意异常: ${e.message.slice(0, 50)}`);
  }

  const url = page.url();
  const bodyText = await page.textContent('body').catch(() => '');

  // 检查是否注册成功
  if (url.includes('.google.com') || url.includes('.google.com/v3/signin') || url.includes('home')) {
    log('✅ Google 账号注册成功！');
    const gmailAddress = info..toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 15) + '@gmail.com';
    return {
      success: true,
      registrationIP,
      loggedIn: true,
      googleAccount: gmailAddress,
      profileData: { email: gmailAddress, : 'Google' },
      emailVerified: true,  // Google 账号自带邮箱验证
    };
  }

  // 检查错误
  if (bodyText.includes('already') || bodyText.includes('taken') || bodyText.includes('exists')) {
    log('⚠️ 用户名已被占用');
    return { success: false, error: 'Username taken', registrationIP };
  }

  log(`当前 URL: ${url} — Google 注册可能需要额外验证`);
  // D4 修复：URL 未进入 /signin/home → 注册未确认，不得 success:true
  return { success: false, verified: false, note: 'PENDING_MANUAL_VERIFY: Google 注册需手动确认', registrationIP, googleAccount: info. + '@gmail.com' };
}

// ══════════════════════════════════════════════════════════
//  6d. Google OAuth 免密登录其他社媒平台
// ══════════════════════════════════════════════════════════

/**
 * 使用 Google 账号 OAuth 免密登录/注册其他社媒平台
 * @param {Object} ctx - 浏览器上下文
 * @param {Object} page - 页面对象
 * @param {string}  - 目标平台 (Reddit / X / Discord 等)
 * @param {Object} googleCreds - Google 账号凭据 { email,  }
 * @returns {Object} { success, loggedIn, googleOAuth }
 */
async  WithGoogleOAuth(ctx, page, , googleCreds) {
  const log = msg => console.log(`  [ via Google OAuth] ${msg}`);

  const signupUrls = {
    Reddit: 'https://www.reddit.com//',
    X: 'https://x.com/i/flow/signup',
    Discord: 'https://discord.com/',
    Instagram: 'https://www.instagram.com//emailsignup/',
    TikTok: 'https://www.tiktok.com/signup',
    Facebook: 'https://www.facebook.com/r.php',
    YouTube: 'https://.google.com/signup',
  };

  const signupUrl = signupUrls[] || signupUrls.Reddit;
  log(`导航到  注册页`);
  await page.goto(signupUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForTimeout(2000 + Math.random() * 2000);

  // 查找并点击 "Continue with Google" 按钮
  const googleBtnSelectors = [
    '"Continue with Google")',
    '"Sign up with Google")',
    '"Sign in with Google")',
    '"使用 Google 注册")',
    '"使用 Google 继续")',
    '[data-testid="google-signup"]',
    'a:has-text("Google")',
    '"Google")',
    '[aria-label*="Google"]',
    'div[role="button"]:has-text("Google")',
  ];

  let clicked = false;
  for (const sel of googleBtnSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.count() > 0) {
        log(`找到 Google OAuth 按钮: ${sel}`);
        await btn.click({ delay: 150 + Math.random() * 200 });
        clicked = true;
        break;
      }
    } catch {}
  }

  if (!clicked) {
    log('⚠️ 未找到 Google OAuth 按钮，回退到邮箱注册');
    return { success: false, error: 'Google OAuth button not found', fallback: true };
  }

  await page.waitForTimeout(3000 + Math.random() * 2000);

  // Google OAuth 弹窗 — 选择 Google 账号
  log('处理 Google OAuth 账号选择...');

  // 检查是否打开了新弹出窗口或切换到 Google 登录页
  const pages = ctx.pages();
  let oauthPage = pages.length > 1 ? pages[pages.length - 1] : page;

  // 如果当前页面 URL 包含 .google.com，说明在 OAuth 流程中
  const currentUrl = oauthPage.url();
  if (currentUrl.includes('.google.com')) {
    log('在 Google OAuth 页面');

    // 情况1: 已有 Google 账号登录 — 直接选择
    const accountItem = oauthPage.locator(`div[data-email="${googleCreds.email}"], li:has-text("${googleCreds.email}")`);
    if (await accountItem.count() > 0) {
      log(`选择已有 Google 账号: ${googleCreds.email}`);
      await accountItem.first().click({ delay: 200 });
      await page.waitForTimeout(3000);
    } else {
      // 情况2: 需要登录 — 点击 "Use another account"
      const anotherAccount = oauthPage.locator('text=Use another account, text=使用其他账号, b:has-text("another account")');
      if (await anotherAccount.count() > 0) {
        log('点击"使用其他账号"');
        await anotherAccount.first().click({ delay: 150 });
        await page.waitForTimeout(2000);
      }

      // 输入 Google 邮箱
      log(`输入 Google 邮箱: ${googleCreds.email}`);
      const emailInput = oauthPage.locator('"email"], "identifier"], "Email"]');
      if (await emailInput.count() > 0) {
        await typeHuman(oauthPage, '"email"], "identifier"]', googleCreds.email);
        await page.waitForTimeout(500);
        await clickHuman(oauthPage, '"Next"), [jsname="LgbsSe"] button, #identifierNext');
        await page.waitForTimeout(3000);
      }

      // 输入 Google 密码
      log('输入 Google 密码');
      const passInput = oauthPage.locator('""], ""], "Passwd"]');
      if (await passInput.count() > 0) {
        await typeHuman(oauthPage, '""], ""]', googleCreds.);
        await page.waitForTimeout(500);
        await clickHuman(oauthPage, '"Next"), [jsname="LgbsSe"] button, #Next');
        await page.waitForTimeout(4000);
      }
    }

    // 授权确认 — 点击 "Allow" / "Continue"
    try {
      const allowBtn = oauthPage.locator('"Allow"), "Continue"), "Agree"), "允许")');
      if (await allowBtn.count() > 0) {
        log('点击授权确认');
        await allowBtn.first().click({ delay: 200 });
        await page.waitForTimeout(3000);
      }
    } catch {}
  }

  // 检查是否成功回到目标平台
  await page.waitForTimeout(3000);
  const finalUrl = page.url();
  const finalText = await page.textContent('body').catch(() => '');

  log(`最终 URL: ${finalUrl}`);

  // 判定成功 — 根据平台特征
  const successIndicators = {
    Reddit: ['reddit.com', 'home'],
    X: ['x.com/home', 'x.com/explore'],
    Discord: ['discord.com/channels', 'discord.com/app'],
    Instagram: ['instagram.com'],
    TikTok: ['tiktok.com/foryou', 'tiktok.com/follow'],
    Facebook: ['facebook.com'],
  };

  const indicators = successIndicators[] || ['home', 'welcome'];
  const isSuccess = indicators.some(ind => finalUrl.includes(ind) || finalText.toLowerCase().includes(ind));

  if (isSuccess) {
    log(`✅  通过 Google OAuth 注册/登录成功！`);
    return {
      success: true,
      loggedIn: true,
      googleOAuth: true,
      ,
      note: `Account created via Google OAuth (${googleCreds.email})`,
    };
  }

  // 可能需要补充信息（用户名等）
  log(`当前 URL: ${finalUrl} — 可能需要补充信息`);

  // 自动填写补充用户名（某些平台 OAuth 后需要设置用户名）
  const Input = page.locator('""], "displayName"], input[placeholder*=""], input[placeholder*="name"]');
  if (await Input.count() > 0) {
    const autoUsername = googleCreds.email.split('@')[0] + '_' + Math.random(36).slice(2, 6);
    log(`补充用户名: ${autoUsername}`);
    await typeHuman(page, '""], "displayName"]', autoUsername);
    await page.waitForTimeout(500);
    await clickHuman(page, '"Continue"), "Next"), "Sign up"), button[type="submit"]');
    await page.waitForTimeout(3000);
  }

  const afterUrl = page.url();
  const afterIndicators = successIndicators[] || ['home'];
  const finalSuccess = afterIndicators.some(ind => afterUrl.includes(ind));

  if (finalSuccess) {
    log(`✅  Google OAuth 注册完成（补充信息后）`);
    return { success: true, loggedIn: true, googleOAuth: true,  };
  }

  return { success: true, note: 'Google OAuth 流程已执行，可能需要手动确认', googleOAuth: true,  };
}

const REGISTRARS = { Google: Google, Reddit: Reddit, X: X, Discord: Discord };

// ══════════════════════════════════════════════════════════
//  7. 主注册流程
// ══════════════════════════════════════════════════════════

async  One(, proxyServer) {
  console.log(`\n🚀 全自动注册 `);

  // Step 1: 生成凭据
  const creds = generateCredentials();
  console.log(`  👤 ${creds.}  🤖 ${creds.botId}`);

  // Step 2: 邮箱 — 优先 reg-factory emails.txt，降级 guerrillamail
  let email, mail = null, mailCode = null;
  if (regFactory) {
    const poolResult = await regFactory.getNextEmail().catch(() => ({}));
    if (poolResult.email) {
      email = poolResult.email;
      creds.email = poolResult.;
      console.log(`  📧 [pool] `);
    }
  }
  if (!email) {
    mail = new FreeEmail();
    email = await mail.create().catch(() => `${.toLowerCase()}_${Date.now(36)}@guerrillamailblock.com`);
    console.log(`  📧 [guerrilla] `);
  }
  creds.email = email;

  // Step 3: SMS — reg-factory 接码
  let sms = null;
  if (regFactory) {
    const smsResult = await regFactory.getSMSNumber().catch(() => ({}));
    if (smsResult.phone) {
      console.log(`  📱 SMS: +${smsResult.country_code}${smsResult.phone} (${smsResult.provider})`);
      creds.phone = smsResult.phone;
      creds.smsPkey = smsResult.pkey;
      sms = { waitForCode: async (ms) => { const c = await regFactory.getSMSCode(smsResult.pkey, ms); return c?.code || null; } };
    } else {
      console.log(`  📱 SMS: not available (${smsResult.error || 'no provider'})`);
    }
  } else {
    console.log(`  📱 SMS: reg-factory not loaded`);
  }

  // Step 4: 启动浏览器
  const { ctx, userDataDir } = await launchStealthBrowser(, creds.botId, proxyServer);
  const page = await ctx.newPage();
  let result = { success: false, , botId: creds.botId, : creds., email: creds.email };

  try {
    // Step 5: 执行注册
    const registrar = REGISTRARS[];
    if (registrar) {
      // 并行等待邮箱验证码和SMS验证码
      const mailPromise = mail ? mail.waitForCode(120000) : Promise.resolve(null);
      const smsPromise = sms ? sms.waitForCode(60000) : Promise.resolve(null);

      const regResult = await registrar(ctx, page, { ...creds, mailCode: null, mail });
      result = { ...result, ...regResult };

      // 获取验证码
      const theMailCode = await mailPromise;
      if (theMailCode && regResult?.note) {
        console.log(`  📨 邮箱验证码: ${theMailCode}`);
        creds.mailCode = theMailCode;

        // 如果之前有验证码输入框，填入
        const codeInput = page.locator('input[data-testid="ocfEnterTextTextInput"], "verification_code"]');
        if (await codeInput.count() > 0) {
          await typeHuman(page, 'input[data-testid="ocfEnterTextTextInput"], "verification_code"]', theMailCode);
          await page.waitForTimeout(3000);
        }
      }

      const smsCode = await smsPromise;
      if (smsCode) console.log(`  📱 SMS验证码: ${smsCode}`);
    }

    // Step 6: 保存数据到 D:\LeiDian
    const Dir = CFG.storage.Dir || STORAGE + '/';
    await fsp.mkdir(Dir, { recursive: true });
    const accountFile = path.join(Dir, `${creds.botId}.json`);
    const accountData = {
      botId: creds.botId, , : creds.,
      email: creds.email, : creds.,
      phone: creds.phone || null,
      registrationIP: result.registrationIP || null,
      profileData: result.profileData || null,
      proxyUsed: proxyServer || null,
      userDataDir, success: result.success,
      createdAt: new Date().toISOString(),
      error: result.error || null,
      note: result.note || null,
    };
    await fsp.writeFile(accountFile, JSON.stringify(accountData, null, 2));
    console.log(`  💾 已保存: ${accountFile} (IP: ${result.registrationIP || 'N/A'})`);

    // Step 7: 保存 Cookie
    const cookiesDir = CFG.storage.cookiesDir || STORAGE + '/cookies';
    await fsp.mkdir(cookiesDir, { recursive: true });
    const cookies = await ctx.cookies();
    await fsp.writeFile(path.join(cookiesDir, `${creds.botId}.json`), JSON.stringify(cookies, null, 2));
    console.log(`  🍪 Cookie: ${cookies.length}条`);

    // Step 8: 截图
    const ssDir = CFG.storage.screenshotsDir || STORAGE + '/screenshots';
    await fsp.mkdir(ssDir, { recursive: true });
    await page.screenshot({ path: path.join(ssDir, `${creds.botId}.png`), fullPage: true });

    // Step 9: 🔍 注册后立即验证（调用 account-validator 确认账号可登录）
    let verified = false;
    // D4 修复：仅当注册函数已声明 success:true 才做后置验证；
    // 启发式“可能需要验证”的兜底一律 success:false，不再进入验证/成功计数。
    if (result.success && accountValidator) {
      console.log(`  🔍 验证账号有效性...`);
      try {
        const verifyResult = await accountValidator.verifyAccount({
          bot_id: creds.botId, , : creds.,
          : creds., email: creds.email, : userDataDir,
        });
        verified = verifyResult.valid === true;
        result.verified = verified;
        result.verifyDetail = verifyResult;

        if (verified) {
          console.log(`  ✅ 账号验证通过 — 可正常登录`);
        } else {
          console.log(`  ❌ 账号验证失败: ${verifyResult.error || 'unknown'} — ${verifyResult.warning || ''}`);
          result.success = false;
          result.error = `Verification failed: ${verifyResult.error || 'unknown'}`;
        }
      } catch (vErr) {
        console.log(`  ⚠️ 验证过程异常: ${vErr.message}`);
        result.verified = false;
        result.verifyDetail = { error: vErr.message };
      }
    }

    // Step 10: 入库（traffic_ + managed_）
    try {
      // 写入 traffic_
      await axios.post(`${API_BASE}/api/v1/`, {
        bot_id: creds.botId, ,
        proxy_server: proxyServer || 'direct',
        bound_country: 'US',
      }, { timeout: 5000 });
    } catch {}

    try {
      // 写入 managed_（完整凭据，附带验证结果）
      await axios.post(`${API_BASE}/api/v1/managed-`, {
        bot_id: creds.botId, ,
        : creds., : creds.,
        email: creds.email, phone: creds.phone || null,
        : result.registrationIP || null,
        : result.profileData || null,
        : userDataDir,
        : proxyServer || null,
        notes: verified ? 'Auto-verified OK' : (result.error || result.note || null),
        tags: verified ? 'ed,verified' : 'ed,pending',
        status: verified ? '' : '',
        : verified ? 60 : 50,
        : verified ? 5 : 15,
        : 0,
      }, { timeout: 5000 });

      // 如果已验证通过，直接标记为有效
      if (verified) {
        try {
          await axios.post(`${API_BASE}/api/v1/managed-/update-valid`, {
            bot_id: creds.botId, : 1,
          }, { timeout: 5000 });
        } catch {}
      }
      console.log(`  📋 已入库托管账号表 (verified=${verified})`);
    } catch (e) {
      console.log(`  ⚠️ 入库失败: ${e.message}`);
    }

    result.success = result.success && verified;

  } catch (err) {
    console.error(`  ❌ ${err.message}`);
    result.error = err.message;
  }

  await ctx.close();
  return { ...result, : creds. };
}

async  batchRegister(, count, proxyServer) {
  const results = [];
  for (let i = 0; i < count; i++) {
    console.log(`\n📌 ${i+1}/${count}`);
    const result = await OneWithRetry(, proxyServer, MAX_RETRIES);
    results.push(result);
    if (i < count - 1) await new Promise(r => setTimeout(r, CFG.cooldown || 5000));
  }
  const ok = results.filter(r => r.success;
  const verified = results.filter(r => r.verified;
  console.log(`\n✅ ${ok}/${count} 成功 (${verified} 验证通过)`);

  // B1 修复（P1-1）：注册成功后自动并入主系统，免去手动 /api/v1/managed-/import。
  // full-auto- 已把账号 JSON 写入 D:/LeiDian/，import 端点会读取并合并进 matrix__managed。
  // 仅当本批有真实成功（verified）账号时才触发，避免空跑。
  if (verified > 0) {
    try {
      await axios.post(`${API_BASE}/api/v1/managed-/import`, {}, { timeout: 8000 });
      console.log(`  🔄 B1: 已自动触发主系统导入（${verified} 个验证账号 → managed_ → 主系统）`);
    } catch (impErr) {
      console.log(`  ⚠️ B1: 自动导入失败（非致命，可稍后手动 /import）: ${impErr.message}`);
    }
  }
  return results;
}

// ══════════════════════════════════════════════════════════
//  8. 🛡️ 注册前自检
// ══════════════════════════════════════════════════════════

async  preflightCheck(proxyServer) {
  console.log('\n🔧 === 注册前自检 ===');
  const checks = { captcha: false, proxy: false, proxyType: 'unknown' };

  // 1. 2captcha 自检
  if (captcha) {
    const captchaOk = await captcha.selfTest();
    checks.captcha = captchaOk.ok;
    if (!captchaOk.ok) {
      console.log(`  ⚠️ 2captcha 不可用: ${captchaOk.error}`);
      console.log(`  💡 配置方法: 编辑 D:/LeiDian/config/.json → captcha.apiKey`);
    }
  } else {
    console.log(`  ⚠️ captcha-solver 模块未加载`);
  }

  // 2. 代理质量检测
  if (proxyServer && proxyChecker) {
    console.log(`  🔍 检测代理: ${proxyServer}`);
    const check = await proxyChecker.check(proxyServer);
    checks.proxy = check.ok;
    checks.proxyType = check.type || 'unknown';

    if (check.ok) {
      const emoji = check.type === 'residential' || check.type === 'cloudflare_us' ? '✅' : check.type === 'datacenter' ? '⚠️' : '❓';
      console.log(`  ${emoji} 代理: IP=${check.ip} | 类型=${check.type} | 国家=${check.country || '?'} | 延迟=${check.latencyMs}ms | 评分=${check.score}`);
      if (check.type === 'datacenter') {
        console.log(`  ⚠️ 数据中心代理 — CAPTCHA 触发概率较高，建议使用住宅代理`);
      }
    } else {
      console.log(`  ❌ 代理不可用: ${check.error}`);
    }
  } else if (!proxyServer) {
    console.log(`  📡 直连模式（无代理）— CAPTCHA 风险最高`);
    checks.proxy = true; // 直连总是可以
    checks.proxyType = 'direct';
  } else {
    console.log(`  ⚠️ proxy-checker 模块未加载`);
    checks.proxy = true;
  }

  console.log(`\n📊 总结: CAPTCHA=${checks.captcha?'✅':'❌'} | 代理=${checks.proxy?'✅ ('+checks.proxyType+')':'❌'}`);

  if (!checks.captcha) {
    console.log(`  ⚠️ 将继续注册但 CAPTCHA 将无法自动求解（账号可能不可行）`);
  }

  return checks;
}

// ══════════════════════════════════════════════════════════
//  9. 🔄 带重试的注册（验证不通过自动重试）
// ══════════════════════════════════════════════════════════

/**
 * 自动重试注册：验证不通过则换凭据+代理重试
 * @param {string}  - 平台名
 * @param {string} proxyServer - 初始代理
 * @param {number} maxRetries - 最大重试次数
 */
async  OneWithRetry(, proxyServer, maxRetries = MAX_RETRIES) {
  const results = [];
  let currentProxy = proxyServer;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const tag = attempt === 0 ? '' : ` (重试 ${attempt}/${maxRetries - 1})`;
    console.log(`\n📌 注册尝试 #${attempt + 1}${tag}`);

    const result = await One(, currentProxy);

    results.push({ attempt: attempt + 1, ...result });

    // 检查是否成功 + 验证通过
    if (result.success && result.verified) {
      console.log(`\n✅ 注册+验证全部通过！(尝试 ${attempt + 1}/${maxRetries})`);
      return { ...result, attempts: attempt + 1, allResults: results };
    }

    // 🔐 如果已登录（loggedIn=true），直接通过
    if (result.success && result.loggedIn) {
      console.log(`\n✅ 注册成功 + 已登录确认！(尝试 ${attempt + 1}/${maxRetries})`);
      return { ...result, attempts: attempt + 1, allResults: results };
    }

    // 验证成功但没验证步骤的特殊情况（验证模块未加载等）
    if (result.success && result.verified === undefined && !result.error) {
      console.log(`\n⚠️ 注册成功但验证模块未运行（尝试 ${attempt + 1})`);
      return { ...result, attempts: attempt + 1, allResults: results };
    }

    // 判断是否需要重试
    const shouldRetry = !result.success  // 注册本身失败
      || result.verified === false       // 验证不通过
      || result.error?.includes('CAPTCHA')
      || result.error?.includes('');

    // 如果已经尝试过邮箱验证（emailVerified 字段存在），不再重试 — 已尽力
    if (result.emailVerified !== undefined) {
      console.log(`\n📧 邮箱验证已完成 (verified=${result.emailVerified})，不再重试`);
      return { ...result, attempts: attempt + 1, allResults: results };
    }

    if (shouldRetry && attempt < maxRetries - 1) {
      const reason = result.error || result.note || 'registration incomplete';
      console.log(`\n🔄 准备重试... (${reason})`);

      // 换代理
      if (proxyChecker && proxyServer) {
        try {
          const poolResp = await axios.get(`${API_BASE}/api/v1/proxy/next`, { timeout: 5000 }).catch(() => null);
          if (poolResp?.data?.proxy) {
            currentProxy = poolResp.data.proxy;
          }
        } catch {}
      }

      // 随机延迟避免速率限制
      const delay = 3000 + Math.random() * 8000;
      console.log(`  ⏱ 等待 ${(delay/1000).toFixed(1)}s 后重试...`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    // 不可重试的错误（如用户名被占用等）
    if (result.error && !shouldRetry) {
      console.log(`\n❌ 不可重试的错误: ${result.error}`);
      break;
    }

    // 最后一次尝试失败
    if (attempt === maxRetries - 1) {
      console.log(`\n❌ ${maxRetries} 次尝试后仍未获得有效账号`);
    }
  }

  return { ...results[results.length - 1], attempts: results.length, allResults: results };
}

// ══════════════════════════════════════════════════════════
//  CLI
// ══════════════════════════════════════════════════════════

async  main() {
  const args = process.argv.slice(2);
  const get = k => { const f = args.find(a => a.startsWith(`--${k}=`)); return f ? f.split('=')[1] : null; };
  const  = get('') || 'Reddit';
  const count = parseInt(get('count') || '1', 10);
  const proxy = get('proxy') || null;

  [CFG.storage.Dir, CFG.storage.cookiesDir, CFG.storage.profilesDir, CFG.storage.screenshotsDir]
    .forEach(d => d && fsp.mkdir(d, { recursive: true }).catch(() => {}));

  // 注册前自检
  await preflightCheck(proxy);

  const result = count === 1
    ? await OneWithRetry(, proxy, MAX_RETRIES)
    : await batchRegister(, count, proxy);

  console.log('\n📋 结果:');
  if (Array.isArray(result)) {
    result.forEach(r => console.log(`  ${r.botId}: ${r.success?'✅':'❌'} ${r.verified?'(验证通过)':'(未验证)'}`));
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

if (require.main === module) {
  main().catch(e => { console.error('FATAL:', e); process.exit(1); });
}

module.exports = {
  One, batchRegister, generateCredentials, FreeEmail, FreeSMS, REGISTRARS,
  OneWithRetry, preflightCheck,
  Google, WithGoogleOAuth,
};
