const { chromium } = require('playwright-core');
(async () => {
  const browser = await chromium.launch({ headless: true, proxy: { server: 'http://127.0.0.1:10808' }, args: ['--no-sandbox','--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  // 监听网络
  page.on('response', r => { if (r.url().includes('tumblr.com') && (r.status()>=400 || r.url().includes('/register') || r.url().includes('api'))) console.log('  [NET]', r.status(), r.url().slice(0,90)); });
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

  const vals = await page.evaluate(() => ['month','day','year'].map(n => { const s=document.querySelector('select[name='+n+']'); return n+'='+s.value; }));
  console.log('select值:', vals.join(', '));

  await page.evaluate(() => { [...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Next').click(); });
  await page.waitForTimeout(5000);
  console.log('URL:', page.url());
  console.log('文本:', (await page.evaluate(()=>document.body.innerText)).replace(/\n+/g,' ').slice(0,300));
  await browser.close();
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
