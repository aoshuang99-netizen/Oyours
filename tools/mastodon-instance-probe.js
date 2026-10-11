#!/usr/bin/env node
/**
 * Mastodon 实例开放注册状态巡检 + 官方 authorization_code 文档抓取
 * 目的：为「换一个实例 / 重建账号」提供真实依据（注册是否开放、是否需审批）。
 * 只读，不写盘。
 */
const path = require('path');
const { fetchExt } = require(path.join(__dirname, '..', 'http-client.js'));
const PROXY = process.env.MSCMS_PROBE_PROXY || 'http://127.0.0.1:10808';
const UA = { 'User-Agent': 'MSCMS/1.0 (+https://mscms.cc.cd)' };

async function get(url, timeout = 22000) {
  const t0 = Date.now();
  try {
    const r = await fetchExt(url, { method: 'GET', headers: UA, timeout }, PROXY);
    const txt = await r.text();
    return { status: r.status, txt, ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, txt: 'NETWORK: ' + e.message, ms: Date.now() - t0 };
  }
}

const INSTANCES = [
  'mastodon.social',
  'mstdn.social',
  'mas.to',
  'fosstodon.org',
  'hachyderm.io',
  'techhub.social',
  'mastodon.world',
  'infosec.exchange',
];

(async () => {
  console.log('════════ 实例开放注册巡检（GET /api/v2/instance） ════════');
  console.log('  实例'.padEnd(22) + 'HTTP  ' + '注册开放'.padEnd(9) + '需审批'.padEnd(8) + '版本'.padEnd(14) + '域名后缀/备注');
  for (const h of INSTANCES) {
    const r = await get(`https://${h}/api/v2/instance`);
    if (r.status !== 200) {
      console.log('  ' + h.padEnd(22) + String(r.status).padEnd(6) + (r.status === 0 ? String(r.txt).slice(0, 46) : ''));
      continue;
    }
    let j = {};
    try { j = JSON.parse(r.txt); } catch (_) {}
    const reg = (j.registrations && typeof j.registrations === 'object') ? j.registrations : {};
    const enabled = reg.enabled;
    const approval = reg.approval_required;
    const ver = (j.version || '?').split('+')[0].split('.').slice(0, 2).join('.');
    const lim = reg.reason || '';
    console.log(
      '  ' + h.padEnd(22) +
      String(r.status).padEnd(6) +
      String(enabled).padEnd(9) +
      String(approval).padEnd(8) +
      String(ver).padEnd(14) +
      String(lim).slice(0, 30)
    );
  }

  console.log('\n════════ mastodon.social 注册页可达性 ════════');
  const au = await get('https://mastodon.social/auth/sign_up');
  console.log(`  GET /auth/sign_up  =>  HTTP ${au.status}  ${au.ms}ms  len=${au.txt.length}`);
  if (au.status === 200) {
    const m = au.txt.match(/registration[^"]{0,80}/i);
    console.log(`  页面片段: ${String(m && m[0]).slice(0, 90)}`);
  }

  console.log('\n════════ 官方 authorization_code 文档（/client/authorized/） ════════');
  const dr = await get('https://docs.joinmastodon.org/client/authorized/', 30000);
  if (dr.status !== 200) {
    console.log(`  ❌ HTTP ${dr.status}  ${String(dr.txt).slice(0, 120)}`);
  } else {
    const text = dr.txt
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&rsquo;/g, "'")
      .replace(/\s+/g, ' ');
    const idx = text.indexOf('authorization_code');
    if (idx >= 0) {
      console.log('  ── 授权码换 token 片段 ──');
      console.log('  ' + text.slice(Math.max(0, idx - 700), idx + 700).trim());
    } else {
      console.log('  （未找到 authorization_code 关键字，打印含 oauth/token 片段）');
      const i2 = text.indexOf('/oauth/token');
      console.log('  ' + text.slice(Math.max(0, i2 - 400), i2 + 600).trim());
    }
  }
  console.log('\n（只读脚本，未修改任何文件）');
})().catch((e) => { console.error('FATAL', (e && e.stack) || e); process.exit(1); });
