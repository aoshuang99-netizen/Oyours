#!/usr/bin/env node
/**
 * .social 注册页可行性勘察（决定能否自动化注册）
 * 检查：表单字段、是否含 captcha / 人机验证 / 注册理由必填项
 * 只读（GET），不提交任何表单。
 */
const path = require('path');
const { fetchExt } = require(path.join(__dirname, '..', 'http-client.js'));
const PROXY = 'http://:10808';

(async () => {
  const url = 'https://.social/auth/sign_up';
  const t0 = Date.now();
  let html = '';
  try {
    const r = await fetchExt(url, { method: 'GET', headers: { '': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) MSCMS/1.0', Accept: 'text/html' }, timeout: 25000 }, PROXY);
    html = await r.text();
    console.log(`GET ${url}  =>  HTTP ${r.status}  ${Date.now() - t0}ms  len=${html.length}`);
    const setC = r.headers && r.headers.get && r.headers.get('set-cookie');
    if (setC) console.log('set-cookie 前缀:', String(setC).slice(0, 60) + '…');
  } catch (e) {
    console.log('❌ 抓取失败:', e.message);
    process.exit(1);
  }

  console.log('\n════ 表单字段（<input>/<select>/<> 的 name） ════');
  const names = [...html.matchAll(/<(input|select|)\b[^>]*>/gi)].map((m) => m[0]);
  const seen = new Map();
  for (const tag of names) {
    const n = (tag.match(/name="([^"]+)"/) || [])[1];
    const t = (tag.match(/type="([^"]+)"/) || [])[1] || tag.match(/^<(\w+)/)[1];
    if (n) seen.set(n, t);
  }
  [...seen.entries()].forEach(([n, t]) => console.log(`  ${n.padEnd(28)} type=${t}`));
  if (!seen.size) console.log('  （未解析到；可能是 JS 渲染的 SPA）');

  console.log('\n════ 人机验证 / 反自动化指标 ════');
  const marks = [
    ['', //i], ['recaptcha', /recaptcha/i], ['turnstile', /turnstile/i],
    ['cf-', /cf-|s\.cloudflare/i], ['captcha(通用)', /captcha/i],
    ['proof_of_work', /proof[_ -]?of[_ -]?work|pow_/i],
    ['registration_', //i],
    ['需要注册理由', /registration_reason|invite_code|reason/i],
    ['邮箱确认字样', /confirm.{0,20}email|email.{0,20}confirm/i],
    ['approval 字样', /approval|awaiting.{0,20}review/i],
  ];
  for (const [label, re] of marks) {
    const m = html.match(re);
    console.log(`  ${re.test(html) ? '⚠️ 命中' : '— 无  '} ${label.padEnd(24)} ${m ? String(m[0]).slice(0, 60) : ''}`);
  }

  console.log('\n════ <form> 标签 ════');
  for (const m of html.matchAll(/<form\b[^>]*>/gi)) console.log('  ' + m[0].slice(0, 180));

  console.log('\n════ 是否含服务端渲染的表单提交地址 ════');
  const act = html.match(/action="([^"]*)"/g);
  console.log('  action 列表:', act ? act.slice(0, 6).join(' | ') : '(无)');
  console.log('\n（只读脚本，未提交任何表单、未修改任何文件）');
})().catch((e) => { console.error('FATAL', (e && e.stack) || e); process.exit(1); });
