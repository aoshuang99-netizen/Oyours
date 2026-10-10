// 对指定页面截图取证（正常数据）
const { chromium } = require('playwright-core');
const fs = require('fs'), path = require('path');
function findChromium() {
  const base = 'C:/Users/AS/AppData/Local/ms-playwright';
  if (!fs.existsSync(base)) return null;
  for (const d of fs.readdirSync(base)) { const p = path.join(base, d, 'chrome-win64', 'chrome.exe'); if (fs.existsSync(p)) return p; }
  return null;
}
const SHOTS = [
  ['ov', 'compass', '.tmp/shot-compass.png', '运营总览·核心指标罗盘'],
  ['content', 'factory', '.tmp/shot-factory.png', '内容与发布·内容工厂（原崩溃页）'],
  ['traffic', 'trend', '.tmp/shot-trend.png', '引流与流量·流量趋势'],
  ['acct', 'overview', '.tmp/shot-accounts.png', '账号与设备·账号全景']
];
(async () => {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto('http://127.0.0.1:3002/v14-dash.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof MENUS !== 'undefined', { timeout: 20000 });
  for (const [m, t, out, desc] of SHOTS) {
    await page.evaluate(([m, t]) => { selectMenu(m); selectTab(m, t); }, [m, t]);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: out, fullPage: false });
    console.log('shot ' + out + '  <- ' + desc);
  }
  await browser.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
