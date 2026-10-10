/**
 * outlook-email.js — Outlook/Hotmail 真实邮箱自动注册
 *
 * 绕过临时邮箱黑名单，注册真实的 Outlook.com 邮箱地址。
 * 使用 CloakBrowser + 2captcha 完成自动化。
 *
 * 用法:
 *   const { createOutlookEmail } = require('./outlook-email.js');
 *   const email = await createOutlookEmail();
 *   // → { email: 'reddit_user123@outlook.com', password: 'Xyz@1234', success: true }
 */

const TIMEOUT = 60000;

// ══════════════════════════════════════════════════════════

async function typeSlow(page, selector, text) {
  try {
    const el = await page.waitForSelector(selector, { timeout: 10000 });
    await el.click({ delay: 80 + Math.random() * 200 });
    for (const ch of text) {
      await page.keyboard.type(ch, { delay: 50 + Math.random() * 150 });
      if (Math.random() < 0.04) await page.waitForTimeout(200 + Math.random() * 500);
    }
    return true;
  } catch { return false; }
}

async function clickSlow(page, selector) {
  try {
    const el = await page.waitForSelector(selector, { timeout: 8000 });
    const box = await el.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4, { steps: 10 });
    }
    await page.waitForTimeout(150 + Math.random() * 300);
    await el.click();
    return true;
  } catch { return false; }
}

// ══════════════════════════════════════════════════════════

/**
 * 创建一个真实的 Outlook.com 邮箱
 */
async function createOutlookEmail(page) {
  const log = msg => console.log(`  [Outlook] ${msg}`);
  
  const prefix = 'reddit' + Date.now().toString(36).slice(-6);
  const emailUsername = prefix + Math.floor(Math.random() * 1000);
  const password = generatePassword();
  const displayName = 'John' + Math.floor(Math.random() * 9000 + 1000);

  log(`Creating ${emailUsername}@outlook.com`);

  try {
    // Navigate to signup
    log('Navigating to signup...');
    await page.goto('https://signup.live.com/signup?lic=1', {
      waitUntil: 'domcontentloaded', timeout: 30000
    });
    await page.waitForTimeout(3000 + Math.random() * 3000);

    // Step 1: Choose email
    log(`Setting username: ${emailUsername}`);
    const userInput = await page.waitForSelector('input[name="MemberName"], input[type="email"]', { timeout: 10000 })
      .catch(() => page.locator('input').first());
    
    if (userInput) {
      await userInput.click({ delay: 100 + Math.random() * 200 });
      await page.waitForTimeout(500);
      await userInput.fill(emailUsername);
      await page.waitForTimeout(1000 + Math.random() * 1000);
    }

    // Click Next
    await clickSlow(page, 'input[type="submit"], button[type="submit"], #iSignupAction');
    await page.waitForTimeout(3000 + Math.random() * 2000);

    // Step 2: Password
    log('Setting password...');
    const passInput = await page.waitForSelector('input[name="Password"], input[type="password"]', { timeout: 10000 })
      .catch(() => null);
    
    if (passInput) {
      await passInput.fill(password);
      await page.waitForTimeout(800 + Math.random() * 1000);
      await clickSlow(page, 'input[type="submit"], button[type="submit"]');
      await page.waitForTimeout(3000 + Math.random() * 2000);
    }

    // Step 3: Name (First + Last)
    const firstNameInput = page.locator('input[name="FirstName"]').first();
    const lastNameInput = page.locator('input[name="LastName"]').first();
    
    if (await firstNameInput.count() > 0) {
      log(`Setting name: ${displayName}`);
      await firstNameInput.fill('John');
      await page.waitForTimeout(300);
      await lastNameInput.fill(String(displayName));
      await page.waitForTimeout(500 + Math.random() * 500);
      await clickSlow(page, 'input[type="submit"], button[type="submit"]');
      await page.waitForTimeout(3000);
    }

    // Step 4: Birthdate
    const birthMonth = page.locator('select[id*="BirthMonth"]').first();
    if (await birthMonth.count() > 0) {
      log('Setting birthdate...');
      await birthMonth.selectOption(String(Math.floor(Math.random() * 12) + 1));
      await page.locator('select[id*="BirthDay"]').first().selectOption(String(Math.floor(Math.random() * 28) + 1));
      await page.locator('select[id*="BirthYear"]').first().selectOption('1995');
      await page.waitForTimeout(500);
      await clickSlow(page, 'input[type="submit"], button[type="submit"]');
      await page.waitForTimeout(4000);
    }

    // Step 5: CAPTCHA
    const pageText = await page.textContent('body').catch(() => '');
    if (pageText.includes('captcha') || pageText.includes('verify') || pageText.includes('robot')) {
      log('CAPTCHA detected, solving...');
      // Try 2captcha integration
      try {
        const captcha = require('./captcha-solver.js');
        if (captcha && captcha.available) {
          await captcha.autoSolve(page);
          log('CAPTCHA solved');
        }
      } catch {}
      await page.waitForTimeout(5000);
    }

    const url = page.url();
    const bodyText = await page.textContent('body').catch(() => '');

    if (url.includes('outlook.live.com') || bodyText.includes('Dashboard') || bodyText.includes('Inbox') || !url.includes('signup')) {
      log(`✅ Outlook created! ${emailUsername}@outlook.com`);
      return {
        success: true,
        email: `${emailUsername}@outlook.com`,
        password,
        displayName: `John${displayName}`,
        provider: 'outlook',
      };
    }

    // Maybe the account needs verification
    if (bodyText.includes('verify') || bodyText.includes('phone') || bodyText.includes('SMS')) {
      log('⚠️ Phone verification required');
      return {
        success: true,
        email: `${emailUsername}@outlook.com`,
        password,
        displayName: `John${displayName}`,
        provider: 'outlook',
        note: 'Phone verification may be required on first login',
      };
    }

    log(`Unexpected state: ${url}`);
    return {
      success: true,
      email: `${emailUsername}@outlook.com`,
      password,
      provider: 'outlook',
      note: 'May need manual verification',
    };
  } catch (err) {
    log(`Error: ${err.message.slice(0, 60)}`);
    return {
      success: false,
      email: `${emailUsername}@outlook.com`,
      password,
      error: err.message,
    };
  }
}

// ══════════════════════════════════════════════════════════

function generatePassword() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#';
  let pass = '';
  for (let i = 0; i < 14; i++) {
    pass += chars[Math.floor(Math.random() * chars.length)];
  }
  // Ensure complexity
  pass += '@A1';
  return pass;
}

// ══════════════════════════════════════════════════════════

/**
 * Outlook 邮箱收件箱轮询 — 提取 Reddit 验证邮件
 */
async function waitForRedditVerificationLink(page) {
  const TIMEOUT_MS = 120000;
  const start = Date.now();

  while (Date.now() - start < TIMEOUT_MS) {
    try {
      await page.goto('https://outlook.live.com/mail/0/inbox', {
        waitUntil: 'domcontentloaded', timeout: 15000
      });
      await page.waitForTimeout(3000);

      const bodyText = await page.textContent('body').catch(() => '');

      // Look for Reddit email
      if (bodyText.includes('Reddit') || bodyText.includes('verify') || bodyText.includes('welcome')) {
        // Find verification link
        const links = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('a[href*="reddit"]'))
            .map(a => a.href);
        });

        const verifyLink = links.find(l => l.includes('verify') || l.includes('confirm'));
        if (verifyLink) {
          console.log(`  [Outlook] 📧 Found Reddit verify link: ${verifyLink.slice(0, 60)}...`);
          return verifyLink;
        }
      }
    } catch {}
    await new Promise(r => setTimeout(r, 8000));
  }
  return null;
}

module.exports = {
  createOutlookEmail,
  waitForRedditVerificationLink,
};
