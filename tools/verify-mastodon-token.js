#!/usr/bin/env node
/**
 * Mastodon 凭据验证（只读，不写盘、不改服务配置）
 *
 * 目的：判定 -creds.json 里那条 43 字符  是否真实可用。
 * 背景：provider 实读 D:/mscms-ws/data/_config.json，其 accessToken = "kuaile1314@"（11 字符，
 *       形如密码，非 token）⇒ 线上  必然 format=invalid。真正的 token 躺在另一份文件里。
 *
 * 关键约束：本机外网直连不通（.social 直连超时），必须显式传代理给 fetchExt。
 *           fetchExt(url, opts, ) 支持第三参，故不依赖服务进程内的全局代理池。
 *
 * 用法：node tools/verify--token.js
 */

const fs = require('fs');
const path = require('path');
const { fetchExt } = require(path.join(__dirname, '..', 'http-client.js'));

const WS = path.join(__dirname, '..');
const CREDS = path.join(WS, '-creds.json');
const POOL = path.join(WS, 'proxy-pool.json');
const DOC_URL = 'https://docs.join.org/client/token/';

const mask = (v) => {
  const s = String(v == null ? '' : v);
  return s ? s.slice(0, 5) + '…(' + s.length + '字符)' : '(空)';
};

 loadCreds() {
  const c = JSON.parse(fs.readFileSync(CREDS, 'utf8'));
  return {
    instance: String(c.instance || '').replace(/\/+$/, ''),
    token: c. || '',
    clientId: c. || '',
    clientSecret: c. || '',
    redirectUri: c. || (Array.isArray(c.s) ? c.s[0] : ''),
    scopes: c.scopes || [],
    : c. || '',
    appId: c.id || '',
    createdAt: c. || '',
  };
}

 proxyCandidates(limit = 8) {
  const raw = JSON.parse(fs.readFileSync(POOL, 'utf8'));
  const arr = Array.isArray(raw) ? raw : Object.values(raw).filter((x) => x && typeof x === 'object');
  const en = arr.filter((p) => p && p.url && p.enabled !== false && p.disabled !== true);
  // 本机中继优先（10808 是主网关），其余按原顺序
  en.sort((a, b) => {
    const la = /127\.0\.0\.1|localhost/.test(a.url) ? 0 : 1;
    const lb = /127\.0\.0\.1|localhost/.test(b.url) ? 0 : 1;
    return la - lb;
  });
  const seen = new Set();
  const out = [];
  for (const p of en) {
    if (seen.has(p.url)) continue;
    seen.add(p.url);
    out.push({ url: p.url, name: p.name || '?', exitIp: p.exitIp || '?' });
    if (out.length >= limit) break;
  }
  return out;
}

async  probe(label, url, opts, , timeout = 22000) {
  const t0 = Date.now();
  try {
    const r = await fetchExt(url, Object.assign({ method: 'GET', timeout }, opts || {}), );
    const txt = await r.text();
    return { ok: true, status: r.status, txt, ms: Date.now() - t0, label };
  } catch (e) {
    return { ok: false, status: 0, err: e.message, ms: Date.now() - t0, label };
  }
}

/** 找到一个能连通 .social 的出口 */
async  findWorkingExit(instance) {
  const cands = proxyCandidates(10);
  console.log(`  候选出口 ${cands.length} 个（本机中继优先）`);
  for (const c of cands) {
    const r = await probe(
      'reach',
      instance + '/api/v1/instance',
      { headers: { '': 'MSCMS/1.0' } },
      c.url
    );
    const tag = r.ok ? `HTTP ${r.status}` : `FAIL ${String(r.err).slice(0, 60)}`;
    console.log(`    ${r.ok && r.status === 200 ? '✅' : '❌'} ${c.name.padEnd(22)} ${String(r.exitIp).padEnd(16)} ${tag}  ${r.ms}ms`);
    if (r.ok && r.status === 200) {
      let meta = '';
      try {
        const j = JSON.parse(r.txt);
        meta = `domain=${j.domain || j.uri || '?'} reg.enabled=${j.registrations ? j.registrations.enabled : '?'}`;
      } catch (_) {}
      return { proxy: c, meta };
    }
  }
  return null;
}

(async () => {
  console.log('════════ 0. 凭据清点（脱敏） ════════');
  const cr = loadCreds();
  console.log(`  instance      ${cr.instance}`);
  console.log(`    ${mask(cr.token)}`);
  console.log(`       ${mask(cr.clientId)}`);
  console.log(`   ${mask(cr.clientSecret)}`);
  console.log(`    ${cr.redirectUri}`);
  console.log(`  scopes        ${JSON.stringify(cr.scopes)}`);
  console.log(`        ${cr.}   app id=${cr.appId}  created=${cr.createdAt}`);

  console.log('\n════════ 1. 寻找可用出口 ════════');
  const hit = await findWorkingExit(cr.instance);
  if (!hit) {
    console.log('\n❌ 无出口能连通 .social —— 无法判定 token 真实有效性。');
    console.log('   （这不等于 token 失效；是网络层未打通，不能据此下结论）');
    process.exit(2);
  }
  console.log(`\n  ✅ 选定出口：${hit.proxy.name} (${hit.proxy.url}) 出口IP=${hit.proxy.exitIp}`);
  if (hit.meta) console.log(`     实例元数据：${hit.meta}`);

  console.log('\n════════ 2. 用真 token 验证 /api/v1//verify_credentials ════════');
  const rv = await probe(
    'verify',
    cr.instance + '/api/v1//verify_credentials',
    { headers: { : 'Bearer ' + cr.token, '': 'MSCMS/1.0' } },
    hit.proxy.url
  );
  if (!rv.ok) {
    console.log(`  ❌ 请求失败（网络层）：${rv.err}`);
  } else if (rv.status === 200) {
    let a = {};
    try { a = JSON.parse(rv.txt); } catch (_) {}
    console.log(`  ✅ HTTP 200 —— token 真实有效`);
    console.log(`     acct=${a.acct}  display_name=${a.display_name}  id=${a.id}`);
    console.log(`     statuses=${a.statuses_count}  followers=${a.followers_count}  =${a.}`);
    console.log(`     note长度=${String(a.note || ''}  locked=${a.locked}  bot=${a.bot}`);
  } else {
    console.log(`  ⚠️ HTTP ${rv.status} —— token 可能失效/被撤销`);
    console.log(`     响应：${rv.txt.slice(0, 300)}`);
  }

  console.log('\n════════ 3. 对照：config 里那条 auth=format 检查 ════════');
  const cfgRaw = JSON.parse(fs.readFileSync('D:/mscms-ws/data/_config.json', 'utf8'));
  const cfg = (cfgRaw['0'] && typeof cfgRaw['0'] === 'object') ? cfgRaw['0'] : cfgRaw;
  const cfgTok = String(cfg.accessToken || '');
  const fmtOk = /^[A-Za-z0-9_-]{40,}$/.test(cfgTok);
  console.log(`  config.accessToken = ${JSON.stringify(cfgTok)} (len ${cfgTok.length})`);
  console.log(`  F3 格式判据 /^[A-Za-z0-9_-]{40,}$/ => ${fmtOk ? 'ok' : 'invalid'}（线上显示 invalid 与此一致）`);
  if (cfgTok) {
    const r2 = await probe('cfg', cr.instance + '/api/v1//verify_credentials',
      { headers: { : 'Bearer ' + cfgTok, '': 'MSCMS/1.0' } }, hit.proxy.url);
    console.log(`  用 config 值请求 => ${r2.ok ? 'HTTP ' + r2.status : '网络失败 ' + r2.err}`);
  }
  console.log(`  ⇒ 结论：两份文件指向不同值；provider 读的那份${fmtOk ? '' : '不是合法 token'}。`);

  console.log('\n════════ 4. 抓取官方 token flow 文档（走同一出口） ════════');
  const rd = await probe('doc', DOC_URL, { headers: { '': 'Mozilla/5.0 MSCMS/1.0' } }, hit.proxy.url, 30000);
  if (!rd.ok) {
    console.log(`  ❌ 文档抓取失败：${rd.err}`);
  } else {
    console.log(`  ✅ HTTP ${rd.status}  长度 ${rd.txt.length}`);
    const text = rd.txt
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ');
    const want = ['/oauth/authorize', '/oauth/token', '/api/v1/apps', '',
      '', 'urn:ietf:wg:oauth:2.0:oob', 'verify_credentials', '', 'scope'];
    console.log('  ── 关键片段 ──');
    for (const kw of want) {
      const i = text.indexOf(kw);
      if (i >= 0) {
        console.log(`  [${kw}] …${text.slice(Math.max(0, i - 150), i + 260).trim()}…`);
      } else {
        console.log(`  [${kw}] (未在该页出现)`);
      }
    }
  }
  console.log('\n（本脚本只读：未修改任何文件、未触碰服务配置）');
})().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(1); });
