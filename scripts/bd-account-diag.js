'use strict';
/**
 * bd-account-diag.js — Bright Data 账户激活诊断 + 自动修复探针
 *
 * 目标：
 *  1. 用 API key 查询账户真实状态（是否仍被暂停 / 暂停原因 / 余额）
 *  2. 列举 zone，确认 resi_tumblr Web Unlocker zone 是否可用
 *  3. 实测 Web Unlocker REST 桥能否真正连 Tumblr（返回真实状态码）
 *
 * 出口：经本机 10808 全局代理出网（与 http-client.js 一致）
 */
const { ProxyAgent, fetch: undiciFetch } = require('undici');

const API_KEY = process.env.BD_API_KEY || 'b08e187b-7921-44a1-8b28-d36137ca0076';
const ZONE = process.env.BD_ZONE || 'resi_tumblr';
const PROXY = process.env.HTTPS_PROXY || 'http://127.0.0.1:10808';
const dispatcher = new ProxyAgent(PROXY);

const BD_API = 'https://api.brightdata.com';
const TUMBLR_TEST = 'https://api.tumblr.com/v2/user/info';

const T = (label) => {
  const t0 = Date.now();
  return (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(2)}s] ${label}`, ...a);
};

async function apiGet(path) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await undiciFetch(BD_API + path, {
      method: 'GET',
      headers: { Authorization: `Bearer ${API_KEY}` },
      dispatcher,
      signal: ctrl.signal,
    });
    const txt = await r.text();
    let json = null;
    try { json = JSON.parse(txt); } catch (_) {}
    return { status: r.status, json, text: txt.slice(0, 800) };
  } finally {
    clearTimeout(timer);
  }
}

async function testUnlocker() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await undiciFetch(BD_API + '/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ zone: ZONE, url: TUMBLR_TEST, method: 'GET', format: 'raw' }),
      dispatcher,
      signal: ctrl.signal,
    });
    const raw = await r.text();
    const realStatus = r.headers.get('x-brd-status-code');
    return { bdStatus: r.status, realStatus, bodyHead: raw.slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  console.log('=== Bright Data Account Diagnostic ===');
  console.log('API_KEY=', API_KEY.slice(0, 8) + '...', 'ZONE=', ZONE, 'PROXY=', PROXY);

  console.log('\n--- [1] Account status (/api/account) ---');
  const acct = await apiGet('/api/account');
  console.log('HTTP', acct.status);
  if (acct.json) {
    const j = acct.json;
    console.log(JSON.stringify({
      account_id: j.account_id,
      status: j.status,
      account_type: j.account_type,
      billing: j.billing,
      balance: j.balance,
      plan: j.plan,
      suspended: j.suspended,
      payment_status: j.payment_status,
    }, null, 2));
  } else {
    console.log(acct.text);
  }

  console.log('\n--- [2] Zones (/api/zones) ---');
  const zones = await apiGet('/api/zones');
  console.log('HTTP', zones.status);
  if (zones.json) {
    const list = Array.isArray(zones.json) ? zones.json : (zones.json.zones || []);
    list.forEach((z) => console.log(`  - ${z.zone || z.name} | type=${z.type || z.zone_type} | status=${z.status || z.active}`));
    const target = list.find((z) => (z.zone || z.name) === ZONE);
    console.log('TARGET ZONE', ZONE, target ? 'FOUND -> ' + JSON.stringify(target).slice(0, 200) : 'NOT FOUND');
  } else {
    console.log(zones.text);
  }

  console.log('\n--- [3] Web Unlocker bridge live test (Tumblr) ---');
  try {
    const t = await testUnlocker();
    console.log('BD HTTP', t.bdStatus, '| real Tumblr status=', t.realStatus);
    console.log('body:', t.bodyHead);
  } catch (e) {
    console.log('BRIDGE ERROR:', e.name, e.message);
  }

  console.log('\n=== Done ===');
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
