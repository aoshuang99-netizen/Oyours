const { chromium } = require('playwright-core');
(async () => {
  const browser = await chromium.launch({ headless: true, proxy: { server: 'http://127.0.0.1:10808' }, args: ['--no-sandbox','--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  page.on('response', async (r) => {
    if (r.url().includes('/api/v2/user/validate')) {
      try { const j = await r.json(); console.log('  [VALIDATE]', r.status(), JSON.stringify(j).slice(0,300)); } catch(e){}
    }
  });
  await page.goto('https://www.tumblr.com/register', { waitUntil: 'networkidle', timeout: 30000 });
  const axios = require('axios');
  const { data } = await axios.get('https://api.guerrillamail.com/ajax.php', { params: { f:'get_email_address', ip:'127.0.0.1', agent:'Mozilla/5.0' }, timeout: 10000 });
  const email = data.email_addr;
  const pw = 'Aa1' + Math.random().toString(36).slice(2,10) + '!';
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', pw);
  await page.click('button[type=submit]');
  await page.waitForTimeout(4000);

  async function setReactSelect(name, val) {
    await page.evaluate((a) => {
      const sel = document.querySelector('select[name=' + a.name + ']');
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      nativeSetter.call(sel, a.val);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }, { name, val });
  }
  await setReactSelect('month','0');
  await setReactSelect('day','15');
  await setReactSelect('year','1995');
  await page.waitForTimeout(800);

  // dump 所有 checkbox / label
  const extra = await page.evaluate(() => {
    const checks = [...document.querySelectorAll('input[type=checkbox], input[type=radio]')].map(c => ({ name: c.name, id: c.id, cls: c.className }));
    const labels = [...document.querySelectorAll('label, a')].map(l => l.textContent.trim()).filter(t => /term|privacy|agree|18|old/i.test(t)).slice(0,10);
    return { checks, labels };
  });
  console.log('CHECKBOXES:', JSON.stringify(extra.checks));
  console.log('TERM LINKS:', JSON.stringify(extra.labels));

  await page.evaluate(() => { [...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Next').click(); });
  await page.waitForTimeout(4000);
  await browser.close();
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
