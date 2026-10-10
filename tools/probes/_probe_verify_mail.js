'use strict';
/** 探针：注册 Tumblr 到提交，验证 mail.tm 能否收到验证邮件 */
const { chromium } = require('playwright-core');
const { execFile } = require('child_process');
const util = require('util');
const execFileP = util.promisify(execFile);
const PY = 'C:/Users/AS/.workbuddy/binaries/python/versions/3.14.3/python.exe';
const WS = 'C:/Users/AS/WorkBuddy/2026-06-13-19-42-19';
const PROXY = 'http://127.0.0.1:10808';

function log(m) { console.log(`[${new Date().toLocaleTimeString()}] ${m}`, { flush: true }); }

async function createMailTM() {
  const script = [
    "import sys; sys.path.insert(0, '" + WS.replace(/\\/g, '/') + "')",
    "from mailtm import MailTM",
    "m = MailTM()",
    "print('ADDR:' + m.address)",
    "print('PASS:' + m.password)",
  ].join('\n');
  const { stdout } = await execFileP(PY, ['-c', script], { encoding: 'utf8', timeout: 30000 });
  return {
    address: ((stdout.match(/ADDR:(.*)/) || [])[1] || '').trim(),
    password: ((stdout.match(/PASS:(.*)/) || [])[1] || '').trim()
  };
}

async function getInbox(address, password) {
  const script = [
    "import sys, json; sys.path.insert(0, '" + WS.replace(/\\/g, '/') + "')",
    "from mailtm import MailTM",
    "m = MailTM('" + address + "', '" + password + "')",
    "msgs = m.get_messages() or []",
    "print('INBOX:' + json.dumps([{'id': x.get('id'), 'from': (x.get('from') or {}).get('address',''), 'subj': x.get('subject','')} for x in msgs[:10]], ensure_ascii=False))",
  ].join('\n');
  try {
    const { stdout } = await execFileP(PY, ['-c', script], { encoding: 'utf8', timeout: 30000 });
    const m = stdout.match(/INBOX:(.*)/s);
    return m ? JSON.parse(m[1]) : [];
  } catch (e) { return [{ error: e.message.slice(0, 100) }]; }
}

async function setReactSelect(page, name, val) {
  await page.evaluate((a) => {
    const sel = document.querySelector('select[name=' + a.name + ']');
    if (!sel) return;
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    nativeSetter.call(sel, a.val);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    sel.dispatchEvent(new Event('input', { bubbles: true }));
  }, { name, val });
}

(async () => {
  const mb = await createMailTM();
  log('邮箱: ' + mb.address);
  const pw = 'Aa1' + Math.random().toString(36).slice(2, 10) + '!';

  const browser = await chromium.launch({ headless: true, proxy: { server: PROXY }, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  try {
    await page.goto('https://www.tumblr.com/register', { waitUntil: 'networkidle', timeout: 30000 });
    await page.fill('input[name=email]', mb.address);
    await page.fill('input[name=password]', pw);
    await page.click('button[type=submit]');
    await page.waitForTimeout(4000);
    await setReactSelect(page, 'month', '0');
    await setReactSelect(page, 'day', '15');
    await setReactSelect(page, 'year', '1995');
    await page.waitForTimeout(800);
    await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Next'); if (b) b.click(); });
    await page.waitForTimeout(5000);
    // blog name 页，直接点 Sign up（reCAPTCHA 可能拦，但先试看邮箱是否发）
    const blogName = 'mscms' + Math.random().toString(36).slice(2, 9);
    await page.fill('input[name=blogName]', blogName).catch(() => {});
    await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => /sign up/i.test(x.textContent)); if (b) b.click(); }).catch(() => {});
    await page.waitForTimeout(6000);
    log('提交后URL: ' + page.url());

    // 轮询 mail.tm
    for (let i = 0; i < 12; i++) {
      const inbox = await getInbox(mb.address, mb.password);
      log('轮询' + (i + 1) + ': ' + JSON.stringify(inbox).slice(0, 200));
      if (inbox.length && !inbox[0].error) {
        const tumblr = inbox.find(m => /tumblr/i.test((m.subj || '') + (m.from || '')));
        if (tumblr) { log('✅ 收到 Tumblr 邮件! ' + JSON.stringify(tumblr), '🎉 '); break; }
      }
      await new Promise(r => setTimeout(r, 5000));
    }
  } catch (e) { log('ERR: ' + e.message); }
  await browser.close();
  process.exit(0);
})();
