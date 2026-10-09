/**
 * account-validator.js — 账号有效性验证引擎
 *
 * 使用 Playwright 自动化登录各平台账号，确认：
 *   1. 账号能否正常登录
 *   2. 是否被封禁/限制
 *   3. 个人资料是否完整
 *
 * 支持：Reddit, X (Twitter)
 */

const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
// 解密 .json 中 AES-256-GCM 信封化的密码（落盘无明文）
const { decrypt } = require('./account-crypto');

// ══════════════════════════════════════════════════════════

/**
 * 尝试登录 Reddit 并验证账号状态
 */
async  verifyReddit(page, account) {
  const log = msg => console.log(`    [Reddit-verify] ${msg}`);

  try {
    // 导航到登录页（优先 old.reddit.com — 更少反 bot）
    log('navigating to login...');
    await page.goto('https://old.reddit.com/login/', {
      waitUntil: 'domcontentloaded',
      timeout: 25000
    });
    await page.waitForTimeout(3000);

    // 填写用户名
    const userField = page.locator('""]');
    if (await userField.count() > 0) {
      log(`filling : ${account.}`);
      await userField.fill(account.);
      await page.waitForTimeout(500);
    } else {
      // Reddit 新版可能用其他选择器
      await page.fill('"login-"], input[autocomplete=""]', account.).catch(() => {});
      await page.waitForTimeout(500);
    }

    // 填写密码
    const passField = page.locator('""]');
    if (await passField.count() > 0) {
      log('filling ...');
      await passField.fill(decrypt(account.));
      await page.waitForTimeout(800);
    } else {
      await page.fill('"login-"], input[autocomplete="current-"]', decrypt(account.)).catch(() => {});
      await page.waitForTimeout(800);
    }

    // 点击登录按钮
    const submitBtn = page.locator('button[type="submit"], "Log In"), "Sign In")');
    if (await submitBtn.count() > 0) {
      await submitBtn.first().click();
    } else {
      await page.keyboard.press('Enter');
    }

    await page.waitForTimeout(8000);

    // 检查结果
    const url = page.url();
    const title = await page.title().catch(() => '');
    const bodyText = await page.textContent('body').catch(() => '');

    // 成功登录的标志
    if (url.includes('/submit') || url.includes('reddit.com') && !url.includes('/login')) {
      // 检查是否有封禁提示
      if (bodyText.includes('suspended') || bodyText.includes('banned') || bodyText.includes('Your account has been')) {
        log('ACCOUNT SUSPENDED/BANNED');
        return { valid: false, error: 'Account suspended or banned', url };
      }

      // 是否要求重置密码
      if (bodyText.includes('reset your ') || bodyText.includes(' has been')) {
        log(' reset required');
        return { valid: false, error: ' reset required', url };
      }

      // 是否需要邮件验证
      if (bodyText.includes('verify your email') || url.includes('verification')) {
        log('email verification pending');
        return { valid: true, warning: 'Email not verified', url };
      }

      log('LOGIN SUCCESS');
      return { valid: true, url };
    }

    // 登录失败
    if (bodyText.includes(' ') || bodyText.includes(' ') ||
        bodyText.includes('Wrong ') || bodyText.includes('invalid credentials')) {
      log('WRONG CREDENTIALS');
      return { valid: false, error: 'Incorrect  or ', url };
    }

    // 被限流
    if (bodyText.includes('too many requests') || bodyText.includes('rate limit')) {
      log('RATE LIMITED');
      return { valid: true, warning: 'Rate limited, retry later', url };
    }

    // 仍在登录页 - 可能登录失败
    if (url.includes('/login')) {
      log('still on login page - likely failed');
      return { valid: false, error: 'Login failed, remained on login page', url };
    }

    log(`unexpected: url=${url}`);
    return { valid: true, warning: 'Unknown state after login attempt', url };
  } catch (err) {
    log(`error: ${err.message}`);
    return { valid: false, error: err.message };
  }
}

/**
 * 尝试登录 X (Twitter) 并验证账号状态
 */
async  verifyX(page, account) {
  const log = msg => console.log(`    [X-verify] ${msg}`);

  try {
    // 导航到登录页
    log('navigating to login...');
    await page.goto('https://x.com/i/flow/login', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await page.waitForTimeout(3000);

    // Step 1: 输入用户名/邮箱
    const userInput = page.locator('input[autocomplete=""], "text"]');
    if (await userInput.count() > 0) {
      log(`entering /email: ${account.}`);
      await userInput.first().fill(account.);
      await page.waitForTimeout(800);

      // 点击 Next
      const nextBtn = page.locator('div[role="button"]:has-text("Next"), div[role="button"] span:has-text("Next")');
      if (await nextBtn.count() > 0) {
        await nextBtn.first().click();
        await page.waitForTimeout(3000);
      }
    }

    // X 有时会要求输入邮箱确认
    const confirmInput = page.locator('input[data-testid="ocfEnterTextTextInput"], "text"]');
    if (await confirmInput.count() > 0) {
      const confirmLabel = await page.textContent('body').catch(() => '');
      if (confirmLabel.includes('email') || confirmLabel.includes('phone')) {
        log('email/phone confirmation required, entering email...');
        await confirmInput.first().fill(account.email);
        await page.waitForTimeout(500);
        const nextBtn2 = page.locator('div[role="button"]:has-text("Next")');
        if (await nextBtn2.count() > 0) {
          await nextBtn2.first().click();
          await page.waitForTimeout(3000);
        }
      }
    }

    // Step 2: 输入密码
    const passInput = page.locator('""]');
    if (await passInput.count() > 0) {
      log('entering ...');
      await passInput.fill(decrypt(account.));
      await page.waitForTimeout(800);

      // 点击 Log in
      const loginBtn = page.locator('div[role="button"]:has-text("Log in"), div[role="button"]:has-text("Sign in")');
      if (await loginBtn.count() > 0) {
        await loginBtn.first().click();
      } else {
        await page.keyboard.press('Enter');
      }
      await page.waitForTimeout(10000);
    }

    // 检查结果
    const url = page.url();
    const bodyText = await page.textContent('body').catch(() => '');

    // 成功登录：跳转到首页或时间线
    if (url.includes('x.com/home') || url.includes('twitter.com/home')) {
      log('LOGIN SUCCESS - on home page');
      return { valid: true, url };
    }

    // 账号被锁定/限制
    if (bodyText.includes('suspended') || bodyText.includes('locked') ||
        bodyText.includes('Your account has been')) {
      log('ACCOUNT SUSPENDED/LOCKED');
      return { valid: false, error: 'Account suspended or locked', url };
    }

    // 密码错误
    if (bodyText.includes('Wrong ') || bodyText.includes('')) {
      log('WRONG PASSWORD');
      return { valid: false, error: 'Wrong ', url };
    }

    // 账号不存在
    if (bodyText.includes('doesn\'t exist') || bodyText.includes('no account')) {
      log('ACCOUNT DOES NOT EXIST');
      return { valid: false, error: 'Account does not exist', url };
    }

    // 需要额外验证 (captcha/phone/email)
    if (bodyText.includes('verify') || bodyText.includes('') ||
        bodyText.includes('unusual activity') || bodyText.includes('security')) {
      log('ADDITIONAL VERIFICATION REQUIRED');
      return { valid: true, warning: 'Additional verification required (captcha/phone)', url };
    }

    // 限流
    if (bodyText.includes('too many') || bodyText.includes('rate limited') || bodyText.includes('try again')) {
      log('RATE LIMITED');
      return { valid: true, warning: 'Rate limited, retry later', url };
    }

    log(`unexpected state: url=${url}`);
    return { valid: true, warning: 'Unknown state after login attempt', url };
  } catch (err) {
    log(`error: ${err.message}`);
    return { valid: false, error: err.message };
  }
}

// ══════════════════════════════════════════════════════════

/**
 * 验证 Discord 账号
 */
async  verifyDiscord(page, account) {
  const log = msg => console.log(`    [Discord-verify] ${msg}`);

  try {
    log('navigating to login...');
    await page.goto('https://discord.com/login', {
      waitUntil: 'networkidle',
      timeout: 30000
    });
    await page.waitForTimeout(4000);

    // 处理可能出现的语言选择/CAPTCHA
    const bodyText = await page.textContent('body').catch(() => '');

    // 填写邮箱 — 直接等待 "email"] 出现
    log(`looking for email field...`);
    try {
      await page.waitForSelector('"email"]', { timeout: 10000 });
    } catch {
      log('email field not found, checking for CAPTCHA...');
      if (bodyText.includes('captcha') || bodyText.includes('verify')) {
        return { valid: true, warning: 'CAPTCHA wall — cannot verify in headless', url: page.url() };
      }
      return { valid: false, error: 'Could not find email input (possible bot detection)' };
    }

    log(`filling email: ${account.email}`);
    await page.fill('"email"]', account.email);
    await page.waitForTimeout(600);

    // 填写密码
    log('filling ...');
    await page.fill('""]', decrypt(account.));
    await page.waitForTimeout(800);

    // 点击登录
    log('clicking login...');
    await page.click('button[type="submit"]');
    await page.waitForTimeout(10000);

    const url = page.url();
    const afterText = await page.textContent('body').catch(() => '');

    // Discord 登录成功 → 通常跳转到 /channels/@me 或 /app
    if (url.includes('/channels/@me') || url.includes('/app')) {
      log('LOGIN SUCCESS');
      return { valid: true, url };
    }

    // 检查是否还在登录页但有错误提示
    if (url.includes('/login')) {
      if (afterText.includes('Login or  is invalid') ||
          afterText.includes('Invalid') || afterText.includes('')) {
        log('WRONG CREDENTIALS');
        return { valid: false, error: 'Incorrect login or ', url };
      }
      if (afterText.includes('verify') || afterText.includes('captcha')) {
        log('CAPTCHA on login');
        return { valid: true, warning: 'CAPTCHA required for login', url };
      }
      if (afterText.includes('new login location') || afterText.includes('check your email')) {
        log('email verification / new location check');
        return { valid: true, warning: 'Email verification or new location check required', url };
      }
    }

    // 其他状态
    if (afterText.includes('disabled') || afterText.includes('terminated') ||
        afterText.includes('violation') || afterText.includes('suspended')) {
      log('ACCOUNT DISABLED');
      return { valid: false, error: 'Account disabled', url };
    }

    log(`unexpected: url=${url}`);
    return { valid: true, warning: 'Unknown state — possible success', url };
  } catch (err) {
    log(`ERROR: ${err.message}`);
    return { valid: false, error: `Browser error: ${err.message}` };
  }
}

const VALIDATORS = {
  Reddit: verifyReddit,
  X: verifyX,
  Discord: verifyDiscord,
};

/**
 * 主入口：验证单个账号
 * @param {object} account - 从 DB 读取的账号对象，包含 , , email, , 
 * @returns {{ valid: boolean, error?: string, warning?: string, url?: string }}
 */
async  verifyAccount(account) {
  const  = account.;
  const validator = VALIDATORS[];

  if (!validator) {
    console.log(`  [verify] ${account.bot_id}:  "" not supported`);
    return { valid: false, error: `Platform "" verification not implemented` };
  }

  console.log(`\n🔍 验证 ${account.bot_id} () ...`);

  const profilesDir = path.join('D:', 'LeiDian', 'profiles');
  let userDataDir = account.;

  // 如果 DB 中没存 ，尝试从文件推断
  if (!userDataDir || !fs.existsSync(userDataDir)) {
    const guessed = path.join(profilesDir, `_${account.bot_id}`);
    if (fs.existsSync(guessed)) {
      userDataDir = guessed;
    } else {
      // 搜索 profiles 目录
      if (fs.existsSync(profilesDir)) {
        const dirs = fs.readdirSync(profilesDir, { withFileTypes: true })
          .filter(d => d.isDirectory() && d.name.includes(account.bot_id));
        if (dirs.length > 0) {
          userDataDir = path.join(profilesDir, dirs[0].name);
        }
      }
    }
  }

  console.log(`  userDataDir: ${userDataDir || 'new session'}`);

  let ctx;
  try {
    const browserOpts = {
      headless: false, // 关键：不用 headless 避免 Reddit 反 bot 检测
      viewport: { width: 1280, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'America/New_York',
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--proxy-server=http://:10808',  // 🔀 路由至本地代理
        '--proxy-bypass-list=<-loopback>',
      ],
      ignoreDefaultArgs: ['--enable-'],
    };

    if (userDataDir && fs.existsSync(userDataDir)) {
      // 使用已有的浏览器数据目录（包含 Cookie）
      ctx = await chromium.launchPersistentContext(userDataDir, browserOpts);
      console.log(`  using existing profile`);
    } else {
      ctx = await chromium.launch(browserOpts);
      await ctx.newPage();
      console.log(`  using fresh browser`);
    }

    const pages = ctx.pages();
    const page = pages.length > 0 ? pages[0] : await ctx.newPage();

    // 🛡️ 注入全面反指纹
    try {
      const { generateStealthScript } = require('./stealth-injector.js');
      await page.addInitScript(generateStealthScript({}));
    } catch {}

    const result = await validator(page, account);

    // 截图保存
    const ssDir = path.join('D:', 'LeiDian', 'verification_screenshots');
    await fs.promises.mkdir(ssDir, { recursive: true });
    try {
      await page.screenshot({
        path: path.join(ssDir, `${account.bot_id}_${Date.now(36)}.png`),
        fullPage: false,
      });
    } catch {}

    await ctx.close();
    return result;
  } catch (err) {
    if (ctx) {
      try { await ctx.close(); } catch {}
    }
    return { valid: false, error: `Browser error: ${err.message}` };
  }
}

/**
 * 批量验证
 */
async  verifyAccounts() {
  const results = [];
  for (const account of ) {
    try {
      const result = await verifyAccount(account);
      results.push({ bot_id: account.bot_id, ...result });
    } catch (err) {
      results.push({ bot_id: account.bot_id, valid: false, error: err.message });
    }
    // 冷却
    await new Promise(r => setTimeout(r, 3000));
  }
  return results;
}

// ══════════════════════════════════════════════════════════

module.exports = { verifyAccount, verifyAccounts, VALIDATORS };
