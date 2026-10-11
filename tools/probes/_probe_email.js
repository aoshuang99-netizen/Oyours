const { chromium } = require('playwright-core');
(async () => {
  const browser = await chromium.launch({ headless: true, proxy: { server: 'http://127.0.0.1:10808' }, args: ['--no-sandbox','--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  page.on('response', async (r) => {
    if (r.url().includes('/api/v2/user/validate')) {
      try { const j = await r.json(); console.log('  [VALIDATE]', r.status(), JSON.stringify(j.response && j.response.userErrors)); } catch(e){}
    }
  });
  await page.goto('https://www.tumblr.com/register', { waitUntil: 'networkidle', timeout: 30000 });
  // 测 guerrillamail 普通域名（非 block）
  const axios = require('axios');
  const { data } = await axios.get('https://api.guerrillamail.com/ajax.php', { params: { f:'get_email_address', ip:'127.0.0.1', agent:'Mozilla/5.0' }, timeout: 10000 });
  console.log('guerrilla email:', data.email_addr);
  // 试一个伪造 gmail
  for (const testEmail of ['testuser12345@gmail.com', data.email_addr, 'testuser12345@outlook.com']) {
    await page.fill('input[name=email]', testEmail);
    await page.evaluate(() => { const i=document.querySelector('input[name=email]'); i.dispatchEvent(new Event('input',{bubbles:true})); });
    await page.waitForTimeout(1500);
    console.log('测试邮箱:', testEmail);
    await page.waitForTimeout(1500);
  }
  await browser.close();
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
