'use strict';
/** 批量测试多个邮箱服务对 Tumblr 注册的接受度（只看创建是否 400） */
const path = require('path');
const { chromium } = require('playwright-core');
const { execFile } = require('child_process');
const util = require('util');
const execFileP = util.promisify(execFile);
const PY = 'C:/Users/AS//binaries/python/versions/3.14.3/python.exe';
const WS = 'C:/Users/AS/WorkBuddy/2026-06-13-19-42-19';
const PROXY = 'http://:10808';
const SITEKEY = '6LeYrbYqAAAAAF9Hyb1luPFtcSylK688Hk22La0B';

 log(m) { console.log(`[${new Date().toLocaleTimeString()}] ${m}`, { flush: true }); }

async  setReactSelect(page, name, val) {
  await page.evaluate((a) => {
    const sel = document.querySelector('select[name=' + a.name + ']');
    if (!sel) return;
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    nativeSetter.call(sel, a.val);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    sel.dispatchEvent(new Event('input', { bubbles: true }));
  }, { name, val });
}

// 各邮箱服务的 bridge 脚本
const SERVICES = {
  '1secmail': path.join(WS, 'mail_1secmail.py'),
  'mailtm': path.join(WS, ''),
};

(async () => {
  const browser = await chromium.launch({ headless: true, proxy: { server: PROXY }, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  let created = false;
  page.on('response', async (r) => {
    const u = r.url();
    if (u.includes('tumblr.com/api') && r.request().method() === 'POST' && u.split('/').pop() === 'nrksaaknsdzc') {
      try { const j = await r.json(); log('  创建请求 -> ' + r.status() + ' ' + (j.response || j.meta && j.meta.msg)); if (r.status() === 200) created = true; } catch (e) {}
    }
  });

  for (const [name, script] of Object.entries(SERVICES)) {
    try {
      const { stdout: mbOut } = await execFileP(PY, [script, 'create'], { encoding: 'utf8', timeout: 30000 });
      const email = (mbOut.match(/ADDR=(.*)/) || [])[1].trim();
      const pw = 'Aa1' + Math.random(36).slice(2, 10) + '!';
      log('=== 测试服务: ' + name + ' | ' + email + ' ===');
      await page.goto('https://www.tumblr.com/', { waitUntil: 'networkidle', timeout: 30000 });
      await page.fill('email]', email);
      await page.fill(']', pw);
      await page.click('button[type=submit]');
      await page.waitForTimeout(4000);
      await setReactSelect(page, 'month', '0');
      await setReactSelect(page, 'day', '15');
      await setReactSelect(page, 'year', '1995');
      await page.waitForTimeout(800);
      await page.evaluate(() => { const b = [...'button')].find(x => x.textContent.trim() === 'Next'); if (b) b.click(); });
      await page.waitForTimeout(5000);
      const blogName = 'mscms' + Date.now(36) + Math.random(36).slice(2, 4);
      await page.fill('blogName]', blogName);
      await page.waitForTimeout(3000);
      const token = await page.evaluate(async (sk) => {
        return await new Promise((resolve) => {
          try { window.grecaptcha.enterprise.ready(async () => { try { const t = await window.grecaptcha.enterprise.execute(sk, { action: '' }); resolve(t); } catch (e) { resolve('ERR'); } }); }
          catch (e) { resolve('ERR'); }
        });
      }, SITEKEY);
      if (token && !token.startsWith('ERR')) {
        await page.evaluate((t) => {
          let el = document.getElementById('');
          if (!el) { el = document.createElement(''); el.id = ''; el.name = ''; el.style.display = 'none'; document.body.appendChild(el); }
          el.value = t; el.dispatchEvent(new Event('input', { bubbles: true }));
        }, token);
        await page.waitForTimeout(1000);
        await page.evaluate(() => { const b = [...'button')].find(x => /sign up/i.test(x.textContent)); if (b) b.click(); });
        await page.waitForTimeout(4000);
        log('  ' + (created ? '✅ 创建成功!' : '❌ 创建失败(400)'));
        if (created) break;
      }
    } catch (e) { log('  错误: ' + e.message); }
  }
  await browser.close();
  process.exit(0);
})().catch(e => { log('ERR: ' + e.message); process.exit(1); });
