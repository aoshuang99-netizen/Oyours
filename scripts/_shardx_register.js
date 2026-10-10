/**
 * ShardX PoC 第二步：通过 CDP 连接 ShardX 修补浏览器，访问 Tumblr 注册页，
 * 验证「引擎级指纹」是否能让注册流程不被风控拦截。
 *
 * history 对照（既有记录）：
 *  - 旧方案用 Playwright/Puppeteer 自带 Chromium：CDP/WebDriver 特征被识别
 *  - Tumblr 注册报 POST /api/v2/user/validate -> HTTP 400（数据中心 IP + headless 指纹）
 * 本 PoC 的浏览器是 ShardX 的修补 Chromium 149，指纹在引擎层伪造。
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const CDP = fs.readFileSync(path.join(__dirname, '..', '_shardx_cdp.txt'), 'utf8').trim();

(async () => {
  console.log('连接 CDP: ' + CDP);
  const browser = await chromium.connectOverCDP(CDP);
  const ctx = browser.contexts()[0] || (await browser.newContext());
  const page = ctx.pages()[0] || (await ctx.newPage());

  // 1) 先看基础指纹（UA / 平台）
  const ua = await page.evaluate(() => navigator.userAgent);
  const plat = await page.evaluate(() => navigator.platform);
  const cores = await page.evaluate(() => navigator.hardwareConcurrency);
  const lang = await page.evaluate(() => navigator.language);
  console.log('\n--- 浏览器指纹 ---');
  console.log('  UA     : ' + ua);
  console.log('  platform: ' + plat + '   cores=' + cores + '   lang=' + lang);

  // 2) WebGL renderer（指纹伪造关键面）
  try {
    const gl = await page.evaluate(() => {
      const c = document.createElement('canvas');
      const g = c.getContext('webgl');
      if (!g) return '(no webgl)';
      const d = g.getExtension('WEBGL_debug_renderer_info');
      return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : '(no debug ext)';
    });
    console.log('  WebGL  : ' + gl);
  } catch (e) { console.log('  WebGL  : 读取失败 ' + e.message.slice(0, 40)); }

  // 3) 访问 Tumblr 注册页
  console.log('\n--- 访问 Tumblr 注册页 ---');
  const failed = [];
  page.on('requestfailed', (r) => failed.push(r.url().slice(0, 70) + ' :: ' + (r.failure() || {}).errorText));
  const validateHits = [];
  page.on('response', (r) => {
    if (r.url().includes('/api/v2/user/validate')) validateHits.push(r.status());
  });

  try {
    const resp = await page.goto('https://www.tumblr.com/register', {
      waitUntil: 'domcontentloaded', timeout: 45000,
    });
    console.log('  HTTP 状态: ' + (resp ? resp.status() : '无响应'));
    console.log('  最终 URL : ' + page.url().slice(0, 90));
    const title = await page.title();
    console.log('  页面标题 : ' + title);
    const hasEmail = await page.locator('input[type="email"], input[name="email"]').count();
    const hasPwd = await page.locator('input[type="password"]').count();
    console.log('  邮箱输入框=' + hasEmail + '  密码输入框=' + hasPwd);
  } catch (e) {
    console.log('  导航失败: ' + String(e.message).slice(0, 120));
  }

  if (failed.length) {
    console.log('\n  失败请求(' + failed.length + '):');
    failed.slice(0, 5).forEach((f) => console.log('    ' + f));
  }
  if (validateHits.length) console.log('\n  /api/v2/user/validate 响应码: ' + validateHits.join(', '));

  await browser.close();
  console.log('\nPoC 浏览器阶段完成');
  process.exit(0);
})();
