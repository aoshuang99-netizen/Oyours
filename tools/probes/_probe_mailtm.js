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

(async () => {
  const mb = await createMailTM();
  console.log('mail.tm 邮箱:', mb.address, '域名:', mb.address.split('@')[1]);
  const browser = await chromium.launch({ headless: true, proxy: { server: 'http://127.0.0.1:10808' }, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  page.on('response', async (r) => {
    if (r.url().includes('/api/v2/user/validate')) { try { const j = await r.json(); console.log('  [VALIDATE]', r.status(), JSON.stringify(j.response && j.response.userErrors)); } catch (e) {} }
  });
  await page.goto('https://www.tumblr.com/register', { waitUntil: 'networkidle', timeout: 30000 });
  await page.fill('input[name=email]', mb.address);
  await page.fill('input[name=password]', 'Aa1' + Math.random().toString(36).slice(2, 10) + '!');
  await page.click('button[type=submit]');
  await page.waitForTimeout(5000);
  console.log('提交后URL:', page.url());
  console.log('提交后文本:', (await page.evaluate(() => document.body.innerText)).replace(/\n+/g, ' ').slice(0, 200));
  await browser.close();
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
