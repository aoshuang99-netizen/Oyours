'use strict';
/** 测试 guerrillamail 各域名是否被 Tumblr 注册接受 */
const { chromium } = require('playwright-core');
const PROXY = 'http://127.0.0.1:10808';

function log(m) { console.log(`[${new Date().toLocaleTimeString()}] ${m}`, { flush: true }); }

async function getGuerrillaEmail(sid, domain) {
  const axios = require('axios');
  const r = await axios.get('https://api.guerrillamail.com/ajax.php', {
    params: { f: 'get_email_address', ip: '127.0.0.1', agent: 'Mozilla/5.0', domain: domain },
    timeout: 10000
  });
  return r.data.email_addr;
}

(async () => {
  const domains = ['guerrillamail.com', 'guerrillamail.net', 'guerrillamail.de', 'sharklasers.com', 'spam4.me', 'grr.la'];
  const browser = await chromium.launch({ headless: true, proxy: { server: PROXY }, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  page.on('response', async (r) => {
    if (r.url().includes('/api/v2/user/validate')) {
      try { const j = await r.json(); if (j.response && j.response.userErrors) log('  拒绝: ' + JSON.stringify(j.response.userErrors)); } catch (e) {}
    }
  });

  for (const domain of domains) {
    try {
      const email = await getGuerrillaEmail(null, domain);
      log('测试域名: ' + domain + ' -> ' + email);
      await page.goto('https://www.tumblr.com/register', { waitUntil: 'networkidle', timeout: 30000 });
      await page.fill('input[name=email]', email);
      await page.fill('input[name=password]', 'Aa1' + Math.random().toString(36).slice(2, 10) + '!');
      await page.click('button[type=submit]');
      await page.waitForTimeout(4000);
      const url = page.url();
      const txt = (await page.evaluate(() => document.body.innerText)).slice(0, 150);
      // 看是否进入生日页（说明邮箱被接受）
      const accepted = url.includes('/register') && txt.includes('When');
      log('  结果: ' + (accepted ? '✅ 接受' : '❌ 拒绝') + ' | url=' + url);
      if (accepted) { log('  >>> 可用域名: ' + domain); break; }
    } catch (e) {
      log('  错误: ' + e.message);
    }
  }
  await browser.close();
  process.exit(0);
})().catch(e => { log('ERR: ' + e.message); process.exit(1); });
