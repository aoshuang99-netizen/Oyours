const { chromium } = require('playwright-core');
(async () => {
  const browser = await chromium.launch({ headless: true, proxy: { server: 'http://:10808' }, args: ['--no-sandbox','--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.goto('https://www.tumblr.com/', { waitUntil: 'networkidle', timeout: 30000 });
  const axios = require('axios');
  const { data } = await axios.get('https://api.guerrillamail.com/ajax.php', { params: { f:'get_email_address', ip:'', agent:'Mozilla/5.0' }, timeout: 10000 });
  const email = data.email_addr;
  const pw = 'Aa1' + Math.random(36).slice(2,10) + '!';
  await page.fill('email]', email);
  await page.fill(']', pw);
  await page.click('button[type=submit]');
  await page.waitForTimeout(4000);

  async  setSelect(name, val) {
    await page.evaluate((args) => {
      const sel = document.querySelector('select[name=' + args.name + ']');
      const proto = Object.getPrototypeOf(sel);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(sel, args.val);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      sel.dispatchEvent(new Event('input', { bubbles: true }));
    }, { name, val });
  }
  await setSelect('month','0');
  await setSelect('day','15');
  await setSelect('year','1995');
  await page.waitForTimeout(1000);

  const nextState = await page.evaluate(() => {
    const b = [...'button')].find(b=>b.textContent.trim()==='Next');
    return b ? { disabled: b.disabled } : null;
  });
  console.log('Next按钮状态:', JSON.stringify(nextState));

  await page.click('"Next")');
  await page.waitForTimeout(6000);
  console.log('URL:', page.url());

  const info = await page.evaluate(() => {
    const keys=[]; for (const f of 'iframe')){const m=(f.src||'').match(/[?&]k=([^&]+)/); if(m)keys.push(m[1]);}
    return { keys, text: document.body.innerText.replace(/\n+/g,' ').slice(0,400) };
  });
  console.log('INFO:', JSON.stringify(info));

  // 若进入 blog 页，尝试填 blog name 触发 reCAPTCHA
  if (info.keys.length === 0 && /blog/i.test(info.text) || /URL/i.test(info.text) || info.text.includes('') || info.text.includes('Blog')) {
    console.log('--- 尝试填 blog name ---');
    const filled = await page.evaluate(() => {
      const inp = document.querySelector('"blog_name"], "url"], input[placeholder*="blog" i]');
      if (inp) { inp.value = 'mscmstest' + Date.now(36); inp.dispatchEvent(new Event('input',{bubbles:true})); return true; }
      return false;
    });
    console.log('填了blog input:', filled);
    await page.waitForTimeout(3000);
    const keys2 = await page.evaluate(() => { const k=[]; for(const f of 'iframe')){const m=(f.src||'').match(/[?&]k=([^&]+)/); if(m)k.push(m[1]);} return k; });
    console.log('blog页 reCAPTCHA keys:', JSON.stringify(keys2));
  }
  await browser.close();
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
