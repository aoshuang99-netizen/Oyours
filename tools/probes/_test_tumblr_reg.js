const { chromium } = require('playwright-core');
const { execFile } = require('child_process');
const util = require('util');
const execFileP = util.promisify(execFile);

const PY = 'C:/Users/AS/.workbuddy/binaries/python/versions/3.14.3/python.exe';
const WORKSPACE = 'C:/Users/AS/WorkBuddy/2026-06-13-19-42-19';

function pyWorkspace() { return WORKSPACE.replace(/\\/g, '/'); }

async function createMailTM() {
  const script = "import sys; sys.path.insert(0, '" + pyWorkspace() + "'); from mailtm import MailTM; m = MailTM(); print(m.address); print(m.password)";
  const { stdout } = await execFileP(PY, ['-c', script], { encoding: 'utf8', timeout: 30000 });
  const [addr, pwd] = stdout.trim().split('\n');
  return { address: (addr || '').trim(), password: (pwd || '').trim() };
}

async function waitTumblrVerify(email, password) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const script = "import sys; sys.path.insert(0, '" + pyWorkspace() + "'); from mailtm import MailTM; m = MailTM('" + email.trim() + "', '" + password.trim() + "'); link = m.wait_for_link('tumblr.com', timeout=20, subject_filter='verify'); print(link or '')";
    const { stdout } = await execFileP(PY, ['-c', script], { encoding: 'utf8', timeout: 30000 });
    const link = (stdout || '').trim();
    if (link && link.startsWith('http')) return link;
    await new Promise(r => setTimeout(r, 5000));
  }
  return null;
}

(async () => {
  const mb = await createMailTM();
  console.log('邮箱:', mb.address);
  const browser = await chromium.launch({
    headless: true,
    proxy: { server: 'http://127.0.0.1:10808' },
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await page.goto('https://www.tumblr.com/register', { waitUntil: 'networkidle', timeout: 30000 });
    await page.fill('input[name="email"]', mb.address);
    await page.fill('input[name="password"]', mb.password);
    console.log('点击 Sign up...');
    await page.click('button[type="submit"]');
    await page.waitForTimeout(5000);
    console.log('提交后 URL:', page.url());

    console.log('填写生日...');
    await page.selectOption('select[name="month"]', '1');
    await page.selectOption('select[name="day"]', '15');
    await page.selectOption('select[name="year"]', '1995');
    await page.click('button:has-text("Next")');
    await page.waitForTimeout(6000);
    const url = page.url();
    console.log('生日后 URL:', url);
    const body = await page.evaluate(() => document.body.innerText.slice(0, 500));
    console.log('页面文字:', body);

    await page.screenshot({ path: '_test_reg_after_birthday.png', fullPage: false });

    console.log('等待验证邮件...');
    const link = await waitTumblrVerify(mb.address, mb.password);
    console.log('验证链接:', link);
    if (link) {
      const vp = await context.newPage();
      await vp.goto(link, { waitUntil: 'networkidle', timeout: 30000 });
      console.log('验证后 URL:', vp.url());
      await vp.screenshot({ path: '_test_reg_verify_clicked.png', fullPage: false });
      await vp.close();
    } else {
      console.log('未收到验证邮件');
    }
  } catch (e) { console.log('ERR', e.message); }
  await browser.close();
})().catch(e => { console.log('FATAL', e.message); process.exit(1); });
