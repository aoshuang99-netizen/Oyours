/**
 * auto-.js — 一键全自动社媒账号注册
 *
 * 功能：
 *   1. 自动配置临时邮箱 (guerrillamail.com)
 *   2. 启动 Playwright 浏览器 + 代理隔离
 *   3. 执行平台注册流程 + 人机模拟
 *   4. 自动获取验证码 / 确认链接
 *   5. 保存 Cookie + Profile + 写入数据库
 *
 * 用法：
 *   node auto-.js --=X --proxy=http://user:pass@ip:port
 *   node auto-.js --=Reddit --count=3 --proxy=http://proxy:8080
 */

const { chromium } = require('playwright-core');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

// ══════════════════════════════════════════════════════════
const CFG = {
  apiBase: 'http://localhost:3002',
  profileDir: path.resolve('./profiles'),
  cookieDir: path.resolve('./cookies'),
  headless: process.env.HEADLESS === '1',
};

// ══════════════════════════════════════════════════════════
//  1. GuerrillaMail 临时邮箱
// ══════════════════════════════════════════════════════════

class TempMail {
  constructor() {
    this.sid = null;
    this.email = null;
  }

  async init() {
    const { data } = await axios.get('https://api.guerrillamail.com/ajax.php', {
      params: { f: 'get_email_address', ip: '', agent: 'Mozilla/5.0' },
      timeout: 10000,
    });
    this.email = data.email_addr;
    this.sid = data.sid_token;
    console.log(`  📧 临时邮箱: ${this.email}`);
    return this.email;
  }

  async waitForCode(timeoutMs = 120000, pollMs = 5000) {
    const start = Date.now();
    console.log(`  ⏳ 等待验证邮件... (最多 ${timeoutMs/1000}s)`);

    while (Date.now() - start < timeoutMs) {
      try {
        const { data } = await axios.get('https://api.guerrillamail.com/ajax.php', {
          params: { f: '', sid_token: this.sid, seq: 0 },
          timeout: 8000,
        });

        const msgs = data.list || [];
        for (const msg of msgs) {
          // 获取完整邮件
          const { data: body } = await axios.get('https://api.guerrillamail.com/ajax.php', {
            params: { f: '', sid_token: this.sid, email_id: msg.mail_id },
            timeout: 8000,
          });

          const text = (body.mail_body || '').replace(/<[^>]+>/g, ' ');

          // 提取验证码 (4-8位数字)
          const codeMatch = text.match(/\b(\d{4,8})\b/);
          if (codeMatch) {
            console.log(`  ✅ 获取验证码: ${codeMatch[1]}`);
            return codeMatch[1];
          }

          // 提取确认链接
          const linkMatch = text.match(/https?:\/\/[^\s"'>]*?(?:verify|confirm|activate|email_verification)[^\s"'>]*/i);
          if (linkMatch) {
            console.log(`  ✅ 获取确认链接: ${linkMatch[0].slice(0, 80)}...`);
            return linkMatch[0];
          }
        }
      } catch (e) {
        // 继续重试
      }

      await new Promise(r => setTimeout(r, pollMs));
      process.stdout.write('.');
    }

    console.log('\n  ⚠ 验证码超时，请手动输入');
    return null;
  }
}

// ══════════════════════════════════════════════════════════
//  2. 人类行为模拟
// ══════════════════════════════════════════════════════════

async  typeHuman(page, selector, text) {
  try {
    const el = await page.waitForSelector(selector, { timeout: 10000 });
    await el.click({ delay: 80 + Math.random() * 150 });
    for (const ch of text) {
      await page.keyboard.type(ch, { delay: 30 + Math.random() * 100 });
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
      await page.mouse.move(
        box.x + box.width * 0.4 + Math.random() * box.width * 0.2,
        box.y + box.height * 0.4 + Math.random() * box.height * 0.2,
        { steps: 4 + Math.floor(Math.random() * 6) }
      );
    }
    await page.waitForTimeout(80 + Math.random() * 200);
    await el.click();
    return true;
  } catch { return false; }
}

// ══════════════════════════════════════════════════════════
//  3. 核心注册函数
// ══════════════════════════════════════════════════════════

async  Account(, proxyServer) {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`🚀 开始注册  账号`);
  console.log(`${'='.repeat(50)}\n`);

  // ── Step 1: 创建临时邮箱 ──
  console.log('[1/5] 创建临时邮箱...');
  const mail = new TempMail();
  const email = await mail.init();

  // ── Step 2: 生成凭据 ──
  console.log('[2/5] 生成账号凭据...');
  const ts = Date.now(36);
  const  = (.toLowerCase() + '_' + crypto.randomBytes(5'hex')).slice(0, 15);
  const  = crypto.randomBytes(8'hex') + '@A1';
  const botId = `_${ts}_${crypto.randomBytes(2'hex')}`;
  console.log(`  👤 Username: ${}`);
  console.log(`  🔑 : ${}`);
  console.log(`  🤖 Bot ID:   ${botId}`);

  // ── Step 3: 启动浏览器 ──
  console.log('[3/5] 启动浏览器...');
  const userDataDir = path.join(CFG.profileDir, `_${botId}`);
  await fsp.mkdir(userDataDir, { recursive: true });

  const isMobile =  === 'Instagram' ||  === 'TikTok';
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: CFG.headless,
    viewport: isMobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    userAgent: isMobile
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/New_York',
    geolocation: { latitude: 40.7128, longitude: -74.006 },
    permissions: ['geolocation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-webrtc',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    ],
    ignoreDefaultArgs: ['--enable-'],
    proxy: proxyServer ? (() => {
      const u = new URL(proxyServer);
      return {
        server: `${u.protocol}//${u.hostname}:${u.port}`,
        : u. || undefined,
        : u. || undefined,
      };
    })() : undefined,
  });

  // 注入反检测
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = { runtime: {}, app: {} };
  });

  const page = await context.newPage();
  let result = { success: false, , botId, , email,  };

  try {
    // ── Step 4: 执行注册 ──
    console.log(`[4/5] 执行  注册流程...`);

    if ( === 'X') {
      result = await X(page, { , email, , botId, mail });
    } else if ( === 'Reddit') {
      result = await Reddit(page, { , email, , botId, mail });
    } else {
      console.log(`  ⚠  全自动注册受限（强反爬），执行半自动流程...`);
      result = { success: true, , botId, , email, , needsManual: true };
    }

    // ── Step 5: 保存 + 入库 ──
    console.log('[5/5] 保存数据...');

    // 保存 Cookie
    const cookies = await context.cookies();
    const cookieFile = path.join(CFG.cookieDir, `${botId}.json`);
    await fsp.mkdir(path.dirname(cookieFile), { recursive: true });
    await fsp.writeFile(cookieFile, JSON.stringify(cookies, null, 2));
    console.log(`  🍪 Cookie: ${cookieFile} (${cookies.length} 条)`);

    // 写入数据库
    try {
      await axios.post(`${CFG.apiBase}/api/v1/`, {
        bot_id: botId, , proxy_server: proxyServer || 'direct',
        bound_country: 'US',
      }, { timeout: 5000 });
      console.log(`  💾 数据库: 已入库`);
    } catch (e) {
      console.log(`  ⚠ 数据库写入失败: ${e.message}`);
    }

    // 保存凭据文件
    const credFile = path.join(CFG.profileDir, `_${botId}`, 'credentials.json');
    await fsp.writeFile(credFile, JSON.stringify({ , email, , botId, , createdAt: new Date().toISOString() }, null, 2));

  } catch (err) {
    console.error(`  ❌ 错误: ${err.message}`);
    result.error = err.message;
  }

  await context.close();
  return result;
}

// ══════════════════════════════════════════════════════════
//  4. X (Twitter) 注册
// ══════════════════════════════════════════════════════════

async  X(page, { , email, , botId, mail }) {
  console.log('  → 打开 x.com/signup...');
  await page.goto('https://x.com/i/flow/signup', { waitUntil: 'domcontentloaded', timeout: 30000 });

  // 使用 "改用电子邮件" 选项（X 默认要求手机号）
  await page.waitForTimeout(2000);
  const useEmailBtn = page.locator('text=改用电子邮件').or(page.locator('text=Use email'));
  if (await useEmailBtn.count() > 0) {
    console.log('  → 点击"改用电子邮件"...');
    await useEmailBtn.first().click();
    await page.waitForTimeout(1500);
  }

  // 填写名称
  const nameInput = page.locator('"name"]');
  if (await nameInput.count() > 0) {
    const displayName = .replace(/[^a-zA-Z]/g, '').slice(0, 12) || 'User';
    console.log(`  → 填写名称: ${displayName}`);
    await typeHuman(page, '"name"]', displayName);
  }

  // 点击下一步
  await page.waitForTimeout(800);
  await clickHuman(page, 'div[role="button"]:has-text("Next")');
  await page.waitForTimeout(2000);

  // 填写邮箱
  console.log(`  → 填写邮箱: `);
  const emailInput = page.locator('"email"]');
  if (await emailInput.count() > 0) {
    await typeHuman(page, '"email"]', email);
  }

  // 下一步
  await clickHuman(page, 'div[role="button"]:has-text("Next")');
  await page.waitForTimeout(2000);

  // 填写生日
  const selects = page.locator('select');
  const selectCount = await selects.count();
  if (selectCount >= 3) {
    console.log('  → 填写生日...');
    await selects.nth(0).selectOption('1');
    await selects.nth(1).selectOption('15');
    await selects.nth(2).selectOption('1995');
  }

  await page.waitForTimeout(1000);
  await clickHuman(page, 'div[role="button"]:has-text("Next")');
  await page.waitForTimeout(3000);

  // 等待验证码输入框
  console.log('  → 等待验证邮件...');
  const codeInput = page.locator('input[data-testid="ocfEnterTextTextInput"], "verification_code"]');
  const codeInputCount = await codeInput.count();

  if (codeInputCount > 0) {
    // 从临时邮箱获取验证码
    const code = await mail.waitForCode(120000, 5000);
    if (code) {
      console.log(`  → 输入验证码: ${code}`);
      await typeHuman(page, 'input[data-testid="ocfEnterTextTextInput"], "verification_code"]', code);
      await page.waitForTimeout(3000);
    } else {
      console.log('  ⚠ 需要手动输入验证码');
      await page.waitForTimeout(60000);
    }
  }

  // 设置密码
  const passInput = page.locator('""]');
  if (await passInput.count() > 0) {
    console.log(`  → 设置密码...`);
    await typeHuman(page, '""]', );
    await page.waitForTimeout(1000);
    await clickHuman(page, 'div[role="button"]:has-text("Next"), div[role="button"]:has-text("Sign up")');
    await page.waitForTimeout(5000);
  }

  // 检查结果
  const url = page.url();
  if (url.includes('home') || url.includes('/x.com/home')) {
    console.log('  ✅ X 注册成功！');
    return { success: true, : 'X', botId, , email,  };
  }

  console.log(`  🔄 当前页面: ${url}`);
  return { success: true, : 'X', botId, , email, , needsFollowup: true };
}

// ══════════════════════════════════════════════════════════
//  5. Reddit 注册
// ══════════════════════════════════════════════════════════

async  Reddit(page, { , email, , botId, mail }) {
  console.log('  → 打开 reddit.com/...');
  await page.goto('https://www.reddit.com//', { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Email
  const emailField = page.locator('"email"]');
  if (await emailField.count() > 0) {
    console.log(`  → 填写邮箱: `);
    await typeHuman(page, '"email"]', email);
  }

  await page.waitForTimeout(1500);
  await clickHuman(page, '"Continue")');
  await page.waitForTimeout(2500);

  // Username + 
  console.log(`  → 填写用户名和密码...`);
  const userField = page.locator('""]');
  if (await userField.count() > 0) {
    await typeHuman(page, '""]', );
  }
  const passField = page.locator('""]');
  if (await passField.count() > 0) {
    await typeHuman(page, '""]', );
  }

  await page.waitForTimeout(1500);
  await clickHuman(page, 'button[type="submit"], "Sign Up"), "Create Account")');
  await page.waitForTimeout(8000);

  const url = page.url();
  if (!url.includes('')) {
    console.log('  ✅ Reddit 注册成功！');
    return { success: true, : 'Reddit', botId, , email,  };
  }

  console.log(`  🔄 当前页面: ${url} (可能需要 CAPTCHA)`);
  return { success: true, : 'Reddit', botId, , email, , needsFollowup: true };
}

// ══════════════════════════════════════════════════════════
//  6. 批量注册
// ══════════════════════════════════════════════════════════

async  batchRegister(, count, proxyServer) {
  console.log(`\n🔥 批量注册: ${count} × `);
  const results = [];

  for (let i = 0; i < count; i++) {
    console.log(`\n📌 任务 ${i+1}/${count}`);
    const result = await Account(, proxyServer);
    results.push(result);

    if (i < count - 1) {
      console.log('\n⏸  冷却 5秒...');
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  const ok = results.filter(r => r.success;
  console.log(`\n${'='.repeat(50)}`);
  console.log(`✅ 批量完成: ${ok}/${count} 成功`);
  console.log(`${'='.repeat(50)}`);

  return results;
}

// ══════════════════════════════════════════════════════════
//  CLI
// ══════════════════════════════════════════════════════════

async  main() {
  const args = process.argv.slice(2);
  const get = k => { const f = args.find(a => a.startsWith(`--${k}=`)); return f ? f.split('=')[1] : null; };

  const  = get('') || 'X';
  const count = parseInt(get('count') || '1', 10);
  const proxy = get('proxy') || null;

  if (!proxy) {
    console.log('⚠ 未指定代理，将直连注册（不推荐）');
    console.log('用法: node auto-.js --=X --proxy=http://user:pass@ip:port');
  }

  await fsp.mkdir(CFG.profileDir, { recursive: true });
  await fsp.mkdir(CFG.cookieDir, { recursive: true });

  if (count === 1) {
    const result = await Account(, proxy);
    console.log('\n📋 最终结果:');
    console.log(JSON.stringify(result, null, 2));
  } else {
    const results = await batchRegister(, count, proxy);
    // 保存批量结果
    const reportFile = path.join(CFG.profileDir, `batch_${Date.now()}.json`);
    await fsp.writeFile(reportFile, JSON.stringify(results, null, 2));
    console.log(`\n📄 报告: ${reportFile}`);
  }
}

if (require.main === module) {
  main().catch(e => { console.error('FATAL:', e); process.exit(1); });
}

module.exports = { Account, batchRegister, TempMail };
