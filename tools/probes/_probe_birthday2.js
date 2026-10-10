const { chromium } = require('playwright-core');
(async () => {
  const browser = await chromium.launch({ headless: true, proxy: { server: 'http://127.0.0.1:10808' }, args: ['--no-sandbox','--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.goto('https://www.tumblr.com/register', { waitUntil: 'networkidle', timeout: 30000 });
  const axios = require('axios');
  const { data } = await axios.get('https://api.guerrillamail.com/ajax.php', { params: { f:'get_email_address', ip:'127.0.0.1', agent:'Mozilla/5.0' }, timeout: 10000 });
  const email = data.email_addr;
  const pw = 'Aa1' + Math.random().toString(36).slice(2,10) + '!';
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', pw);
  await page.click('button[type=submit]');
  await page.waitForTimeout(4000);

  async function setSelect(name, val) {
    await page.evaluate((a) => {
      const sel = document.querySelector('select[name=' + a.name + ']');
      const proto = Object.getPrototypeOf(sel);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(sel, a.val);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      sel.dispatchEvent(new Event('input', { bubbles: true }));
    }, { name, val });
  }
  await setSelect('month','0');
  await setSelect('day','15');
  await setSelect('year','1995');
  await page.waitForTimeout(800);

  const dump = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')].map(b => ({ t: b.textContent.trim(), type: b.type, dis: b.disabled, html: b.outerHTML.slice(0,200) }));
    const forms = [...document.querySelectorAll('form')].map(f => ({ action: f.action, method: f.method }));
    return { btns, forms };
  });
  console.log('BUTTONS:', JSON.stringify(dump.btns, null, 2));
  console.log('FORMS:', JSON.stringify(dump.forms));

  // 尝试用真正的 Next 按钮点击
  const nextBtn = dump.btns.find(b => b.t === 'Next');
  if (nextBtn) {
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Next');
      b.click();
    });
    await page.waitForTimeout(6000);
    console.log('点击Next后URL:', page.url());
    console.log('文本:', (await page.evaluate(()=>document.body.innerText)).replace(/\n+/g,' ').slice(0,200));
  }
  await browser.close();
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
