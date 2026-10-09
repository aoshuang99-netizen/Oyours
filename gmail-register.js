/**
 * gmail-.js — Gmail 全自动注册引擎 v2
 *
 * v2 升级：使用 5sim.net 付费接码替代 quackr.io
 *
 * 完整的 Gmail 注册流程：
 *   1. 生成随机姓名
 *   2. 填写用户名 → 检查可用性
 *   3. 设置密码
 *   4. 手机验证（5sim.net 付费接码）
 *   5. CAPTCHA 求解（2captcha）
 *   6. 邮箱创建完成
 *
 * 用法:
 *   const { Gmail } = require('./gmail-.js');
 *   const result = await Gmail(page);
 *   // → { email: 'xxx@gmail.com', : 'xxx', phone: '+1xxx', success: true }
 *
 * 依赖:
 *   - 5sim-sms.js (付费接码)
 *   - captcha-solver.js (2captcha)
 *   - Playwright / CloakBrowser
 */

const axios = require('axios');
const { FiveSim } = require('./5sim-sms.js');

// ══════════════════════════════════════════════════════════
//  工具函数
// ══════════════════════════════════════════════════════════

async  typeSlow(page, selector, text) {
  try {
    const el = await page.waitForSelector(selector, { timeout: 10000 });
    await el.click({ delay: 80 + Math.random() * 200 });
    await page.waitForTimeout(200);
    for (const ch of text) {
      await page.keyboard.type(ch, { delay: 50 + Math.random() * 150 });
      if (Math.random() < 0.04) await page.waitForTimeout(200 + Math.random() * 500);
    }
    return true;
  } catch { return false; }
}

async  clickSlow(page, selector) {
  try {
    const el = await page.waitForSelector(selector, { timeout: 8000 });
    const box = await el.boundingBox();
    if (box) await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4, { steps: 10 });
    await page.waitForTimeout(150 + Math.random() * 300);
    await el.click();
    return true;
  } catch { return false; }
}

 randomDelay(min, max) {
  return Math.floor(min + Math.random() * (max - min));
}

// ══════════════════════════════════════════════════════════
//  姓名生成
// ══════════════════════════════════════════════════════════

const FIRST_NAMES = ['James','John','Robert','Michael','William','David','Richard','Joseph','Thomas','Charles',
  'Mary','Patricia','Jennifer','Linda','Barbara','Elizabeth','Susan','Jessica','Sarah','Karen'];
const LAST_NAMES = ['Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Rodriguez','Martinez',
  'Anderson','Taylor','Thomas','Moore','Jackson','Martin','Lee','Thompson','White','Harris'];

 generateIdentity() {
  const first = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
  const last = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
  const  = (first + last + Math.floor(Math.random() * 9000 + 1000)).toLowerCase();
  return { first, last, , fullName: first + ' ' + last };
}

 generate() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#';
  let p = '';
  for (let i = 0; i < 12; i++) p += chars[Math.floor(Math.random() * chars.length)];
  return p + '@A1';
}

// ══════════════════════════════════════════════════════════
//  SMS 接码（5sim.net 付费）
// ══════════════════════════════════════════════════════════

let _5sim = null;
 get5sim() {
  if (!_5sim) _5sim = new FiveSim();
  return _5sim;
}

// ══════════════════════════════════════════════════════════
//  主注册流程
// ══════════════════════════════════════════════════════════

async  Gmail(page) {
  const log = msg => console.log(`  [Gmail] ${msg}`);
  const identity = generateIdentity();
  const  = generate();

  log(`创建账号: ${identity.}@gmail.com`);

  try {
    // Step 1: 导航到注册页
    log('导航到注册页...');
    await page.goto('https://.google.com/signup/v2/webcreateaccount?flowName=GlifWebSignIn&flowEntry=SignUp', {
      waitUntil: 'domcontentloaded', timeout: 30000
    });
    await page.waitForTimeout(randomDelay(3000, 5000));

    // Step 2: 填写姓名
    log(`姓名: ${identity.first} ${identity.last}`);
    const firstNameInput = page.locator('"firstName"]').first();
    const lastNameInput = page.locator('"lastName"]').first();

    if (await firstNameInput.count() > 0) {
      await firstNameInput.click({ delay: randomDelay(100, 300) });
      await page.waitForTimeout(300);
      await firstNameInput.fill(identity.first);
      await page.waitForTimeout(randomDelay(500, 1000));
      await lastNameInput.fill(identity.last);
      await page.waitForTimeout(randomDelay(500, 1000));
    } else {
      // Alternative: single name field
      const nameInput = page.locator('"name"], "name"]').first();
      if (await nameInput.count() > 0) {
        await nameInput.fill(identity.fullName);
        await page.waitForTimeout(800);
      }
    }

    // Click Next
    const nextBtn = page.locator('"Next"), button[jsname], #accountDetailsNext, button span:has-text("Next")').first();
    if (await nextBtn.count() > 0) {
      await nextBtn.click();
      log('→ Next');
    }
    await page.waitForTimeout(randomDelay(3000, 5000));

    // Step 3: 生日和性别
    const monthSelect = page.locator('select[id="month"]').first();
    if (await monthSelect.count() > 0) {
      log('填写生日...');
      await monthSelect.selectOption(String(Math.floor(Math.random() * 12) + 1));
      await page.waitForTimeout(300);
      await page.locator('"day"], "day"], select[id="day"]').first()
        .fill(String(Math.floor(Math.random() * 28) + 1));
      await page.waitForTimeout(300);
      await page.locator('"year"], select[id="year"]').first()
        .fill('1995');
      await page.waitForTimeout(300);

      await page.locator('select[id="gender"]').first()
        .selectOption(Math.random() > 0.5 ? '1' : '2');
      await page.waitForTimeout(500);
      
      await clickSlow(page, '"Next"), #Next');
      await page.waitForTimeout(randomDelay(3000, 5000));
    }

    // Step 4: 创建 Gmail 地址（选择"创建自己的 Gmail 地址"）
    log('设置 Gmail 地址...');
    const createOwn = page.locator('text=Create your own Gmail').or(page.locator('text=创建自己的 Gmail'));
    if (await createOwn.count() > 0) {
      await createOwn.first().click({ delay: randomDelay(100, 300) });
      await page.waitForTimeout(2000);
    }

    const Input = page.locator('"Username"], "email"]').first();
    if (await Input.count() > 0) {
      await Input.fill(identity.);
      await page.waitForTimeout(randomDelay(1500, 3000));
    }

    await clickSlow(page, '"Next")');
    await page.waitForTimeout(randomDelay(3000, 5000));

    // 检查用户名是否可用/已被占用
    let pageText = await page.textContent('body').catch(() => '');
    if (pageText.includes('taken') || pageText.includes('already') || pageText.includes('exists')) {
      log('⚠️ 用户名已被占用，重试...');
      const altUser = identity. + Math.floor(Math.random() * 100);
      await Input.fill(altUser);
      await page.waitForTimeout(1500);
      await clickSlow(page, '"Next")');
      await page.waitForTimeout(3000);
      identity. = altUser;
    }

    // Step 5: 密码
    log('设置密码...');
    const passInput = page.locator('"Passwd"], ""]').first();
    const confirmInput = page.locator('"PasswdAgain"], ""]').nth(1);

    if (await passInput.count() > 0) {
      await passInput.fill();
      await page.waitForTimeout(randomDelay(500, 1000));
    }
    if (await confirmInput.count() > 0) {
      await confirmInput.fill();
      await page.waitForTimeout(randomDelay(500, 1000));
    }

    await clickSlow(page, '"Next")');
    await page.waitForTimeout(randomDelay(3000, 5000));

    // Step 6: 手机验证 (5sim.net)
    pageText = await page.textContent('body').catch(() => '');
    if (pageText.includes('phone') || pageText.includes('Phone') || pageText.includes('number')) {
      log('需要手机验证，使用 5sim.net...');
      
      let smsOrderId = null;
      try {
        const fivesim = get5sim();
        
        // 先查余额
        const profile = await fivesim.getBalance();
        log(`5sim 余额: ${profile.balance} RUB`);
        
        // 购买美国号码用于 Google
        log('购买美国手机号...');
        const order = await fivesim.buyNumber('usa', 'any', 'google');
        smsOrderId = order.id;
        const phoneNumber = order.phone;
        log(`获取号码: ${phoneNumber} (订单 ${smsOrderId}, ${order.price} RUB)`);

        // 填写手机号
        const cleanNumber = phoneNumber.replace(/^\+1/, '');
        const phoneInput = page.locator('"tel"], "phoneNumber"], "phoneNumberId"]').first();
        if (await phoneInput.count() > 0) {
          await phoneInput.fill(cleanNumber);
          await page.waitForTimeout(1500);
        }
        
        // 点击发送验证码
        await clickSlow(page, '"Next"), "Send"), "发送")');
        await page.waitForTimeout(3000);
        log('已发送验证码...');

        // 等待5sim收到短信
        const code = await fivesim.waitForCode(smsOrderId, 180000);
        if (code) {
          const codeInput = page.locator('"tel"], "code"], input[aria-label*="code"]').first();
          if (await codeInput.count() > 0) {
            await codeInput.fill(String(code));
            await page.waitForTimeout(1000);
          }
          await clickSlow(page, '"Verify"), "Next"), "验证")');
          await page.waitForTimeout(5000);
          
          // 完成订单
          await fivesim.finishOrder(smsOrderId).catch(() => {});
        } else {
          log('⚠️ 未收到验证码');
          await fivesim.cancelOrder(smsOrderId).catch(() => {});
        }
      } catch (e) {
        log(`⚠️ 5sim 错误: ${e.message.slice(0, 80)}`);
        if (smsOrderId) await get5sim().cancelOrder(smsOrderId).catch(() => {});
      }
    }

    // Step 7: 检查结果
    const url = page.url();
    pageText = await page.textContent('body').catch(() => '');

    if (url.includes('') || url.includes('SignUpComplete') || pageText.includes('Welcome') || pageText.includes('welcome')) {
      log(`✅ Gmail 注册成功！${identity.}@gmail.com`);
      return {
        success: true,
        email: `${identity.}@gmail.com`,
        ,
        recoveryEmail: null,
        phone: sms?.number || null,
        identity,
      };
    }

    if (pageText.includes('verify') || url.includes('')) {
      log('⚠️ 需要额外验证');
      return {
        success: true,
        email: `${identity.}@gmail.com`,
        ,
        note: 'May need additional verification',
      };
    }

    log(`状态: ${url}`);
    return {
      success: true,
      email: `${identity.}@gmail.com`,
      ,
      note: 'Registration completed, verify manually',
    };
  } catch (err) {
    log(`❌ Error: ${err.message.slice(0, 80)}`);
    return {
      success: false,
      email: `${identity.}@gmail.com`,
      ,
      error: err.message,
    };
  }
}

// ══════════════════════════════════════════════════════════
//  Gmail 收件箱验证链接提取（用于 Reddit 邮件验证）
// ══════════════════════════════════════════════════════════

async  waitForRedditVerificationGmail(page, timeoutMs = 120000) {
  const log = msg => console.log(`  [Gmail-Inbox] ${msg}`);
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      await page.goto('https://mail.google.com/mail/u/0/#inbox', {
        waitUntil: 'domcontentloaded', timeout: 15000
      });
      await page.waitForTimeout(3000);

      // Search for Reddit email
      const bodyText = await page.textContent('body').catch(() => '');
      if (bodyText.includes('Reddit') || bodyText.includes('welcome') || bodyText.includes('verify')) {
        // Find and open the verification email
        const redditEmail = page.locator('tr:has-text("Reddit"), tr:has-text("welcome"), tr:has-text("verify")').first();
        if (await redditEmail.count() > 0) {
          await redditEmail.click({ delay: randomDelay(100, 300) });
          await page.waitForTimeout(3000);

          // Extract all links
          const links = await page.evaluate(() => {
            return Array.from('a[href*="reddit"]'))
              .map(a => a.href)
              .filter(h => h.includes('verify') || h.includes('confirm'));
          });

          if (links.length > 0) {
            log(`✅ 找到验证链接: ${links[0].slice(0, 60)}...`);
            return links[0];
          }
        }
      }
    } catch {}
    await new Promise(r => setTimeout(r, 8000));
  }
  log('⚠️ 未找到 Reddit 验证邮件');
  return null;
}

module.exports = {
  Gmail,
  waitForRedditVerificationGmail,
  generateIdentity,
};
