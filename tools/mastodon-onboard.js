#!/usr/bin/env node
/**
 * Mastodon 账号自动注册 + 授权（.social）
 * ---------------------------------------------------------------------
 * 依据实测（2026-09-21）：
 *   - .social：注册开放、免审批、**无任何验证码**（hCaptcha/Turnstile/CF  全无）
 *   - 注册流程 3 步：Accept rules(/auth/acceptance) → Your details → Confirm email
 *   - 邮箱走自有 catch-all：lokfeel.com + mail-api.lokfeel.com（已实测可开地址/读信/抽码）
 *   - 换 token 走官方 （OOB redirect ⇒ 授权后页面直接给 code）
 *
 * 站规合规（.social 第 6 条）：**使用生成式 AI 必须披露** ⇒ 用 --mark-bot 会把账号
 *   标记为 bot 并在简介写明 AI 生成，避免因未披露被处置。
 *
 * 用法：
 *   node tools/-onboard.js --dry                    仅自检（不注册）
 *   node tools/-onboard.js --user=mscms_xxx --yes   真正执行全流程
 * 可选：--email=<addr> --=<pw> --mark-bot --keep-browser
 * ---------------------------------------------------------------------
 * 零伪造：任一步失败即中止并如实报错，不做「假装成功」。
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { fetchExt } = require(path.join(__dirname, '..', 'http-client.js'));

const WS = path.join(__dirname, '..');
const INST = 'https://.social';
const PROXY = process.env.MSCMS_PROBE_PROXY || 'http://:10808';
const API = process.env.MSCMS_API || 'http://:3002';

const argv = process.argv.slice(2);
const has = (n) => argv.includes('--' + n);
const opt = (n, d) => { const h = argv.find((a) => a.startsWith('--' + n + '=')); return h ? h.slice(h.indexOf('=') + 1) : d; };
const DRY = has('dry');
const USER = String(opt('user', ''));
const PASS = String(opt('', 'Mscms!' + Math.random(36).slice(2, 10) + 'A9'));
const MARK_BOT = has('mark-bot');

const log = (...a) => console.log(...a);
const step = (n, t) => log(`\n──────── ${n}. ${t} ────────`);

// ── 邮箱 Worker（自有基建） ───────────────────────────
const mailCfg = JSON.parse(fs.readFileSync('D:/mscms-ws/config/mail.json', 'utf8'));
const MH = { '': mailCfg.apiKey, '': 'application/json' };
const MURL = mailCfg.apiUrl.replace(/\/+$/, '');
const mailApi = async (p, method = 'GET', body) => {
  const o = { method, headers: MH, signal: AbortSignal.timeout(20000) };
  if (body) o.body = JSON.stringify(body);
  const r = await fetch(MURL + p, o);
  return r.json();
};
async  newAddress(local) {
  const j = await mailApi('/new', 'POST', { local, label: '-onboard' });
  if (!j.ok || !j.address) throw new Error('开邮箱失败: ' + JSON.stringify(j));
  return j.address;
}
async  waitForMail(addr, { timeoutMs = 180000, match = /|confirm/i } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const j = await mailApi('/inbox?addr=' + encodeURIComponent(addr) + '&limit=20');
    const hit = (j.messages || []).find((m) => match.test(String(m.subject || '') + ' ' + String(m.from || '')));
    if (hit) {
      const full = await mailApi('/msg?id=' + encodeURIComponent(hit.id));
      return { head: hit, body: String((full.message && (full.message.text || full.message.html)) || '') };
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  throw new Error('等确认信超时（' + Math.round(timeoutMs / 1000) + 's）');
}
 pickLink(text, re) {
  const norm = String(text).replace(/&amp;/g, '&').replace(/=\r?\n/g, '');
  const m = norm.match(re);
  return m ? m[0] : null;
}

// ── 本地服务（写入配置） ─────────────────────────────
async  localApi(p, method = 'GET', body) {
  const o = { method, headers: {}, signal: AbortSignal.timeout(45000) };
  if (body) { o.body = JSON.stringify(body); o.headers[''] = 'application/json'; }
  const r = await fetch(API + p, o);
  return { status: r.status, txt: await r.text() };
}

// ════════════════════════════════════════════════════════════
(async () => {
  log('========================================');
  log(' Mastodon 自动注册 / 授权');
  log(' 模式: ' + (DRY ? 'DRY（自检，不注册）' : '正式执行'));
  log(' 实例: ' + INST + '   出口: ' + PROXY);
  log('========================================');

  const browser = await chromium.launch({
    headless: !has('keep-browser'),
    proxy: { server: PROXY },
  });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 950 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-US',
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(45000);
  const jsErr = [];
  page.on('pageerror', (e) => jsErr.push(String(e.message).split('\n')[0]));

  try {
    step(1, '打开注册页（经代理）');
    const t0 = Date.now();
    const resp = await page.goto(INST + '/auth/sign_up', { waitUntil: 'domcontentloaded', timeout: 60000 });
    log(`  HTTP ${resp && resp.status()}   ${Date.now() - t0}ms   title="${await page.title()}"`);

    // 注意：.social 第 1 步【不是勾选框】，而是一个 name=accept 的提交按钮
    //   <button name="accept" type="submit" class="button" value="<nonce>">Accept</button>
    // 早期误判为  → DRY 自检直接暴露（这正是保留 --dry 的价值）。
    const accBtn = await page.locator('button[name=accept]').count();
    const accChk = await page.locator('accept]').count();
    const submit = await page.locator('form button[type=submit], form submit]').count();
    const rulesN = await page.locator('.rules-list__text').count();
    log(`  规则条数=${rulesN}   接受按钮=${accBtn}   接受勾选框=${accChk}   提交按钮=${submit}`);
    if (!accBtn && !accChk) throw new Error('注册页结构不符（accept 控件未命中），中止以免盲提交');

    const bodyTxt = (await page.innerText('body')).slice(0, 400).replace(/\s+/g, ' ');
    log(`  页面首段: ${bodyTxt.slice(0, 200)}…`);

    if (DRY) {
      log('\n  ✅ DRY 自检通过：浏览器可经代理访问注册页，选择器命中正常。');
      log('  （未勾选、未提交、未创建任何账号）');
      await page.screenshot({ path: path.join(WS, 'reports', 'shots', '-signup-dry.png'), fullPage: false }).catch(() => {});
      return;
    }

    // ── 正式流程 ──
    if (!USER) throw new Error('缺少 --user=<用户名>（正式执行必须显式指定，避免生成不可控身份）');
    if (!has('yes')) throw new Error('正式执行需显式加 --yes 确认（会在第三方站点创建真实账号）');

    step(2, '准备专属邮箱');
    const email = String(opt('email', '')) || await newAddress(('mscms-' + USER).toLowerCase().slice(0, 40));
    log('  使用地址: ' + email);

    step(3, '接受站规');
    if (accBtn) {
      await page.click('button[name=accept]'); // 提交按钮自带 nonce value，点击即提交
      log('  已点击 Accept 按钮（name=accept，type=submit）');
    } else {
      await page.check('accept]');
      await page.click('form button[type=submit], form submit]');
      log('  已勾选并提交（ 形态）');
    }
    await page.waitForLoadState('domcontentloaded');
    log('  已提交，URL=' + page.url());

    step(4, '填写账号信息');
    const cands = [
      ['#user_account_', '"user[account_attributes][]"]', ']'],
      ['#user_account_email', '"user[email]"]', 'email]'],
      ['#user_account_', '"user[]"]', ']'],
    ];
    const vals = [USER, email, PASS];
    for (let i = 0; i < cands.length; i++) {
      let done = false;
      for (const sel of cands[i]) {
        if (await page.locator(sel).count()) { await page.fill(sel, vals[i]); done = true; break; }
      }
      if (!done) log(`  ⚠️ 未找到第 ${i + 1} 个字段的选择器`);
    }
    // 若有二次确认密码
    const pw2 = await page.locator('#user_account__confirmation, "user[_confirmation]"]').count();
    if (pw2) { await page.fill('#user_account__confirmation, "user[_confirmation]"]', PASS); }
    log(`  =${USER}  email=  =${PASS.length} 字符  二次确认=${pw2 ? '有' : '无'}`);

    await page.click('form button[type=submit], form submit]');
    await page.waitForLoadState('domcontentloaded');
    log('  已提交，URL=' + page.url());
    const afterTxt = (await page.innerText('body')).slice(0, 300).replace(/\s+/g, ' ');
    log('  页面提示: ' + afterTxt.slice(0, 200));

    step(5, '等待并点击邮箱确认链接');
    const mail = await waitForMail(email, { timeoutMs: 240000 });
    log('  收到: ' + mail.head.subject);
    const link = pickLink(mail.body, /https:\/\/[^\s"'<>]*\/auth\/confirmation[^\s"'<>]*/)
      || pickLink(mail.body, /https:\/\/[^\s"'<>]*confirm[^\s"'<>]*/);
    if (!link) throw new Error('确认信里未找到确认链接；正文前 300 字：' + mail.body.slice(0, 300));
    log('  确认链接: ' + link.slice(0, 110) + '…');
    await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60000 });
    log('  确认后 URL=' + page.url());

    step(6, '走  授权拿 code');
    const c = JSON.parse(fs.readFileSync(path.join(WS, '-creds.json'), 'utf8'));
    const authUrl = INST + '/oauth/authorize?' + new URLSearchParams({
      : c., : c., response_type: 'code', scope: 'read write push',
    });
    await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    log('  授权页 URL=' + page.url());
    // 若跳登录页则登录
    if (/\/auth\/sign_in/.test(page.url())) {
      log('  检测到登录页，执行登录');
      for (const sel of ['#user_email', '"user[email]"]', 'email]']) {
        if (await page.locator(sel).count()) { await page.fill(sel, email); break; }
      }
      for (const sel of ['#user_', '"user[]"]', ']']) {
        if (await page.locator(sel).count()) { await page.fill(sel, PASS); break; }
      }
      await page.click('button[type=submit], submit]');
      await page.waitForLoadState('domcontentloaded');
      if (/\/auth\/sign_in/.test(page.url())) throw new Error('登录后仍停在登录页（凭据或人机校验问题）');
      await page.goto(authUrl, { waitUntil: 'domcontentloaded' });
      log('  重新进入授权页: ' + page.url());
    }
    // 点授权
    for (const sel of ['button[type=submit]', 'form button', '.button--primary']) {
      if (await page.locator(sel).count()) { await page.click(sel); break; }
    }
    await page.waitForLoadState('domcontentloaded');
    const pageTxt = await page.innerText('body');
    const code = (pageTxt.match(/\b([A-Za-z0-9_-]{40,})\b/) || [])[1];
    if (!code) throw new Error('未从授权页取到 code；正文前 300 字：' + pageTxt.replace(/\s+/g, ' ').slice(0, 300));
    log('  取得 authorization code: ' + code.slice(0, 8) + '…(' + code.length + '字符)');

    step(7, '换 token 并实测');
    const tr = await fetchExt(INST + '/oauth/token', {
      method: 'POST',
      headers: { '': 'application/x-www-form-urlencoded', '': 'MSCMS/1.0' },
      body: new URLSearchParams({
        : '', : c., : c.,
        : c., code, scope: 'read write push',
      }),
      timeout: 30000,
    }, PROXY);
    const tj = await tr.json();
    if (tr.status !== 200 || !tj.) throw new Error('换 token 失败: HTTP ' + tr.status + ' ' + JSON.stringify(tj).slice(0, 200));
    const token = tj.;
    log('  ✅ token: ' + token.slice(0, 6) + '…(' + token.length + '字符)  scope=' + tj.scope);

    const vr = await fetchExt(INST + '/api/v1//verify_credentials', {
      method: 'GET', headers: { : 'Bearer ' + token, '': 'MSCMS/1.0' }, timeout: 25000,
    }, PROXY);
    const me = await vr.json();
    log('  verify_credentials HTTP ' + vr.status + '  acct=' + (me.acct || '?'));
    if (vr.status !== 200) throw new Error('token 实测不可用，拒绝写入: ' + JSON.stringify(me).slice(0, 200));

    step(8, '（可选）标记为 bot + AI 披露');
    if (MARK_BOT) {
      const pr = await fetchExt(INST + '/api/v1//update_credentials', {
        method: 'PATCH',
        headers: { : 'Bearer ' + token, '': 'application/x-www-form-urlencoded', '': 'MSCMS/1.0' },
        body: new URLSearchParams({ bot: 'true', note: 'Automated account. Content is generated with the assistance of AI tools and reviewed before posting.' }),
        timeout: 25000,
      }, PROXY);
      log('  update_credentials HTTP ' + pr.status + '  ' + (await pr.text()).slice(0, 120));
    } else {
      log('  （未指定 --mark-bot；建议加上以符合站规第 6 条「生成式 AI 须披露」）');
    }

    step(9, '写入服务配置（免重启）');
    const w = await localApi('', 'POST', { instance: INST, accessToken: token });
    log('  HTTP ' + w.status + '  ' + w.txt.slice(0, 180));
    if (w.status !== 200) throw new Error('写入失败');

    const pv = await localApi('/api/v14/mixpost/providers');
    try {
      const list = JSON.parse(pv.txt);
      const m = (Array.isArray(list) ? list : Object.values(list)).find((x) => String(x. || x.identifier) === '') || {};
      log(`  复核 : configured=${m.configured} format=${m.format} authorized=${m.authorized}`);
    } catch (_) {}

    log('\n════════ 完成 ════════');
    log('  账号     ' + USER + '@.social');
    log('  邮箱     ' + email);
    log('  密码     ' + PASS + '   ← 请立即存入密码库');
    log('  凭据     ' + WS + '\\-creds.json（app）+ dataStore(_config/main)（token）');
  } catch (e) {
    log('\n❌ 中止: ' + (e && e.message));
    if (jsErr.length) log('  页面 JS 错误: ' + jsErr.slice(0, 3).join(' | '));
    await page.screenshot({ path: path.join(WS, 'reports', 'shots', '-onboard-fail.png'), fullPage: true }).catch(() => {});
    log('  已存失败截图 reports/shots/-onboard-fail.png');
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((e) => { console.error('FATAL', (e && e.stack) || e); process.exit(1); });
