const { chromium } = require('playwright-core');
(async () => {
  const browser = await chromium.launch({
    headless: true,
    proxy: { server: 'http://127.0.0.1:10808' },
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  const logs = [];
  page.on('console', m => logs.push('[console] ' + m.text()));
  page.on('requestfailed', r => logs.push('[reqfail] ' + r.url().slice(0,80)));
  try {
    await page.goto('https://www.tumblr.com/register', { waitUntil: 'networkidle', timeout: 30000 });
  } catch (e) { console.log('GOTO ERR', e.message); }
  const url = page.url();
  console.log('FINAL URL:', url);
  // 提取表单字段
  const fields = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('input, button, iframe').forEach(el => {
      const t = el.tagName.toLowerCase();
      out.push(t + ':' + (el.name||el.id||el.type||el.getAttribute('data-sitekey')||''));
    });
    return out.slice(0, 40);
  });
  console.log('FIELDS:', JSON.stringify(fields));
  // 检测验证码
  const cap = await page.evaluate(() => {
    const found = [];
    document.querySelectorAll('iframe').forEach(f => {
      const s = f.src || '';
      if (/recaptcha|hcaptcha|funcaptcha|arkose/i.test(s)) found.push(s.slice(0,60));
    });
    document.querySelectorAll('[data-sitekey]').forEach(f => found.push('sitekey:'+f.getAttribute('data-sitekey').slice(0,30)));
    return found;
  });
  console.log('CAPTCHA:', JSON.stringify(cap));
  await page.screenshot({ path: '_probe_reg.png', fullPage: false });
  console.log('LOGS:', logs.slice(0,15).join(' | '));
  await browser.close();
})().catch(e => { console.log('FATAL', e.message); process.exit(1); });
