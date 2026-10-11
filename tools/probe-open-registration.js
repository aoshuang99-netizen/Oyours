#!/usr/bin/env node
/**
 * 开放注册实例探测（只读，不注册）
 *
 * 目的：给出「哪些平台/实例当前真实开放注册（免审批、免邀请）」的实证清单，
 *       而不是凭记忆推荐。
 *
 * 三类联邦宇宙（ActivityPub）实例的判据：
 *   · Mastodon  GET  /api/v1/instance  → registrations(true=开放) / approval_required
 *   · Misskey   POST /api/meta         → disableRegistration(true=关闭)
 *   · Lemmy     GET  /api/v3/site      → site_view.local_site.registration_mode
 *
 * 网络：全部走本地代理。
 * 用法：node tools/probe-open-registration.js
 */
const { ProxyAgent, fetch } = require('undici');

const PROXY = process.env.MSCMS_PROBE_PROXY || 'http://127.0.0.1:10808';
const dispatcher = new ProxyAgent(PROXY);

const TARGETS = [
  // ── Mastodon 系 ──
  { name: 'mastodon.social', type: 'mastodon', base: 'https://mastodon.social' },
  { name: 'mstdn.social', type: 'mastodon', base: 'https://mstdn.social' },
  { name: 'fosstodon.org', type: 'mastodon', base: 'https://fosstodon.org' },
  { name: 'mas.to', type: 'mastodon', base: 'https://mas.to' },
  { name: 'mastodon.online', type: 'mastodon', base: 'https://mastodon.online' },
  // ── Misskey 系（Misskey / Sharkey / Firefish 同为 Misskey API） ──
  { name: 'misskey.io', type: 'misskey', base: 'https://misskey.io' },
  { name: 'misskey.design', type: 'misskey', base: 'https://misskey.design' },
  { name: 'sushi.ski', type: 'misskey', base: 'https://sushi.ski' },
  // ── Lemmy 系 ──
  { name: 'lemmy.world', type: 'lemmy', base: 'https://lemmy.world' },
  { name: 'lemmy.ml', type: 'lemmy', base: 'https://lemmy.ml' },
];

async function call(method, url, body) {
  try {
    const r = await fetch(url, {
      method, dispatcher,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    const txt = await r.text();
    return { status: r.status, body: txt };
  } catch (e) {
    return { status: 0, body: `ERR ${e.message}${e.cause ? ' | ' + (e.cause.code || e.cause.message) : ''}` };
  }
}

function J(s) { try { return JSON.parse(s); } catch (e) { return null; } }

(async () => {
  console.log(`=== 开放注册实例探测（代理 ${PROXY}）===\n`);
  const rows = [];

  for (const t of TARGETS) {
    let r;
    let open = null, approval = null, note = '';

    if (t.type === 'mastodon') {
      r = await call('GET', `${t.base}/api/v1/instance`);
      const j = J(r.body);
      if (r.status === 200 && j) {
        open = j.registrations === true;
        approval = j.approval_required === true;
        note = `users=${j.stats?.user_count ?? '?'} 版本=${String(j.version || '').slice(0, 24)}`;
      }
    } else if (t.type === 'misskey') {
      r = await call('POST', `${t.base}/api/meta`, {});
      const j = J(r.body);
      if (r.status === 200 && j) {
        open = j.disableRegistration !== true;
        approval = j.emailRequiredForSignup === true ? null : null;
        note = `维护中=${j.maintenance === true} 邮箱必填=${j.emailRequiredForSignup === true}`;
      }
    } else if (t.type === 'lemmy') {
      r = await call('GET', `${t.base}/api/v3/site`);
      const j = J(r.body);
      if (r.status === 200 && j) {
        const ls = j.site_view?.local_site || {};
        open = ls.registration_mode === 'Open';
        approval = ls.registration_mode === 'RequireApplication';
        note = `mode=${ls.registration_mode} 邮箱验证=${ls.require_email_verification === true}`;
      }
    }

    const verdict = r.status === 0 ? '🔌 不可达'
      : open === true ? (approval ? '⚠️ 开放但需审批' : '✅ 开放注册')
        : open === false ? '❌ 已关闭' : '❓ 未判定';

    console.log(`${t.name.padEnd(20)} [${t.type.padEnd(8)}] HTTP=${String(r.status).padEnd(4)} ${verdict}  ${note}`);
    if (r.status === 0) console.log(`    ${r.body.slice(0, 120)}`);
    rows.push({ ...t, http: r.status, open, approval, note, verdict });
  }

  const okList = rows.filter((r) => r.open === true && !r.approval);
  console.log(`\n=== 汇总：当前免审批开放注册 ${okList.length} / ${rows.length} ===`);
  okList.forEach((r) => console.log(`  ✅ ${r.name}（${r.type}）`));

  require('fs').writeFileSync(
    require('path').join(__dirname, '..', 'reports', '_open-registration-probe.json'),
    JSON.stringify({ at: new Date().toISOString(), proxy: PROXY, rows }, null, 2), 'utf8');
  console.log('\n落盘 → reports/_open-registration-probe.json');
})();
