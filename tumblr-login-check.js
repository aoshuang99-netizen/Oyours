'use strict';
/**
 * tumblr-login-check.js — 用真实 Google Chrome 验证 Tumblr 账号「正常网页登录」
 *
 * 用途：
 *   1. 证明注册的真实账号能通过 email+ 在 tumblr.com/login 正常登录（不只是 API 发帖）。
 *   2. 用真实 Chrome + 持久化 userDataDir 登录，登录后窗口保持打开，方便用户在浏览器里直接检查。
 *
 * 用法：
 *   node tumblr-login-check.js                 # 登录第 1 个真实账号，可见模式，保持打开
 *   node tumblr-login-check.js tumblr_xxxx     # 登录指定 id
 *   node tumblr-login-check.js --all --headless # 无头模式批量验证所有真实账号（验证完关闭）
 *   node tumblr-login-check.js tumblr_xxxx --headless # 无头验证单个（关闭）
 *   node tumblr-login-check.js tumblr_xxxx --target https://www.tumblr.com/messaging # 登录后打开指定 Tumblr 页面
 */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
// 解密 .json 中 AES-256-GCM 信封化的密码（落盘无明文）
const { decrypt } = require('./account-crypto');

const WS = 'C:/Users/AS/WorkBuddy/2026-06-13-19-42-19';
const PROXY = process.env.TUMBLR_PROXY || 'http://:10808';
const CHROME = 'C:\\Users\\AS\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';

 log(m, tag = '') { console.log(`[${new Date().toLocaleTimeString()}] ${tag}${m}`, { flush: true }); }

 loadRealAccounts() {
  const acc = JSON.parse(fs.readFileSync(path.join(WS, 'data', '.json'), 'utf8'));
  // 网页登录验证：只取「有真实邮箱+密码」的 tumblr 账号（含有 token 的和 token 丢失的真实 gmail 号）
  // 孤儿 token（email=null）无法网页登录，改用 API 校验，不在此列
  return acc.filter(a => a && a. === 'tumblr' && a.email && a.);
}

// 登录单个账号（page 已建好），返回是否成功登录
async  loginOnePage(page, account) {
  let result = { ok: false, stage: 'start', url: '' };
  try {
    await page.goto('https://www.tumblr.com/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2500);
    // 填 email
    const emailSel = 'email], email], input#email';
    await page.waitForSelector(emailSel, { timeout: 15000 }).catch(() => {});
    await page.fill(emailSel, account.email).catch(e => { result.stage = 'fill-email:' + e.message; });
    await page.waitForTimeout(800);
    // 可能先点 continue 再出 
    const continueBtn = await page.evaluate(() => {
      const b = [...'button')].find(x => /continue|next|下一步|继续/i.test(x.textContent));
      if (b) { b.click(); return true; }
      return false;
    });
    if (continueBtn) { await page.waitForTimeout(2000); }
    // 填 
    const pwSel = '], ], input#';
    await page.waitForSelector(pwSel, { timeout: 15000 }).catch(() => {});
    await page.fill(pwSel, decrypt(account.)).catch(e => { result.stage = '' + e.message; });
    await page.waitForTimeout(800);
    // 点登录
    const loginBtn = await page.evaluate(() => {
      const b = [...'button')].find(x => /log ?in|sign ?in|登录|登入/i.test(x.textContent));
      if (b) { b.click(); return true; }
      return false;
    });
    if (!loginBtn) { result.stage = 'no-login-btn'; return { result, page }; }
    // 等待跳转
    await page.waitForTimeout(6000);
    const url = page.url();
    result.url = url;
    // 判断是否登录成功：URL 含 dashboard 或页面出现已登录特征
    const loggedIn = await page.evaluate(() => {
      const u = location.href;
      if (u.includes('/dashboard') || u.includes('/timeline')) return true;
      // 存在登出/账号菜单等特征
      const txt = document.body.innerText.toLowerCase();
      if (txt.includes('log out') || txt.includes('your blog') || txt.includes('dashboard')) return true;
      return false;
    });
    result.ok = loggedIn;
    result.stage = loggedIn ? 'logged-in' : 'unknown-state';
    return { result, page };
  } catch (e) {
    result.stage = 'err:' + e.message;
    return { result, page };
  }
}

(async () => {
  const args = process.argv.slice(2);
  const headless = args.includes('--headless');
  const all = args.includes('--all');
  const idArg = args.find(a => a.startsWith('tumblr_'));
  const targetIndex = args.indexOf('--target');
  const targetUrl = targetIndex >= 0 && args[targetIndex + 1]
    ? String(args[targetIndex + 1])
    : null;

  const  = loadRealAccounts();
  if (!.length) { log('没有真实 tumblr 账号（无 token）', '❌ '); process.exit(1); }

  const targets = all ?  : (.filter(a => a.id === idArg ? .filter(a => a.id === idArg) : [[0]]);
  log(`目标账号 ${targets.length} 个，headless=${headless}`, '🚀 ');

  let browser;
  const contexts = [];
  for (const account of targets) {
    const profileDir = path.join(WS, 'chrome_profiles', account.id);
    fs.mkdirSync(profileDir, { recursive: true });
    const opts = {
      executablePath: CHROME,
      headless,
      proxy: { server: PROXY, bypass: '' },
      args: ['--no-sandbox', '--disable-dev-shm-usage']
    };
    const context = await chromium.launchPersistentContext(profileDir, opts);
    contexts.push(context);
    browser = context.browser();
    log(`[${account.id}] 登录中 email=${account.email}`, '🔐 ');
    // loginOne 接收 page，这里用 persistent context 直接 newPage
    const page = await context.newPage();
    const { result } = await loginOnePage(page, account);
    log(`[${account.id}] 结果: ok=${result.ok} stage=${result.stage} url=${result.url.slice(0, 70)}`, result.ok ? '✅ ' : '⚠️ ');
    if (result.ok && targetUrl) {
      try {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2500);
        log(`[${account.id}] 已打开目标页面: ${targetUrl}`, '👉 ');
      } catch (e) {
        log(`[${account.id}] 目标页面打开失败: ${e.message}`, '⚠️ ');
      }
    }
    if (!headless) {
      log(`[${account.id}] 已用真实 Chrome 登录并保持打开，配置目录: ${profileDir} —— 你可直接在窗口里检查`, '👉 ');
      // 保持打开：不关闭 context，脚本继续活着
    } else {
      await context.close();
    }
  }

  if (!headless) {
    log('所有账号窗口已保持打开，按 Ctrl+C 或关闭浏览器窗口结束。', '📌 ');
    // 保持进程存活
    setInterval(() => {}, 1 << 30);
  } else {
    process.exit(0);
  }
})().catch(e => { log('FATAL: ' + e.message, '❌ '); process.exit(1); });
