const { chromium } = require('playwright-core');
const { execFile } = require('child_process');
const util = require('util');
const execFileP = util.promisify(execFile);
const PY = 'C:/Users/AS/.workbuddy/binaries/python/versions/3.14.3/python.exe';
const WS = 'C:/Users/AS/WorkBuddy/2026-06-13-19-42-19';

async function createMailTM() {
  const script = "import sys; sys.path.insert(0, '" + WS.replace(/\\/g, '/') + "'); from mailtm import MailTM; m=MailTM(); print(m.address); print(m.password)";
  const { stdout } = await execFileP(PY, ['-c', script], { encoding: 'utf8', timeout: 30000 });
  const lines = stdout.trim().split('\n');
  return { address: (lines[0] || '').trim(), password: (lines[1] || '').trim() };
}
async function setReactSelect(page, name, val) {
  await page.evaluate((a) => {
    const sel = document.querySelector('select[name=' + a.name + ']');
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    nativeSetter.call(sel, a.val);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, { name, val });
}

(async () => {
  const mb = await createMailTM();
  const email = mb.address;
  const pw = 'Aa1' + Math.random().toString(36).slice(2, 10) + '!';
  console.log('邮箱:', email);

  const browser = await chromium.launch({ headless: true, proxy: { server: 'http://127.0.0.1:10808' }, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.goto('https://www.tumblr.com/register', { waitUntil: 'networkidle', timeout: 30000 });
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', pw);
  await page.click('button[type=submit]');
  await page.waitForTimeout(5000);
  await setReactSelect(page, 'month', '0');
  await setReactSelect(page, 'day', '15');
  await setReactSelect(page, 'year', '1995');
  await page.waitForTimeout(800);
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Next'); if (b) b.click(); });
  await page.waitForTimeout(8000);

  // 等 reCAPTCHA iframe
  let keys = [];
  for (let i = 0; i < 6; i++) {
    keys = await page.evaluate(() => { const k = []; for (const f of document.querySelectorAll('iframe')) { const m = (f.src || '').match(/[?&]k=([^&]+)/); if (m) k.push(m[1]); } return k; });
    if (keys.length) break;
    await page.waitForTimeout(3000);
  }
  console.log('reCAPTCHA sitekeys:', JSON.stringify(keys));

  // dump blog name input + signup button
  const dump = await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('input')].map(i => ({ name: i.name, id: i.id, ph: i.placeholder, type: i.type })).filter(x => x.name || x.id || x.ph);
    const btns = [...document.querySelectorAll('button')].map(b => b.textContent.trim()).filter(Boolean);
    return { inputs: inputs.slice(0, 8), btns };
  });
  console.log('INPUTS:', JSON.stringify(dump.inputs));
  console.log('BUTTONS:', JSON.stringify(dump.btns));
  await browser.close();
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
