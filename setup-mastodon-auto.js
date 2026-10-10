/**
 * setup-mastodon-auto.js
 * Fully-automated Mastodon onboarding using a mail.tm disposable inbox
 * (so email confirmation is done by us, no human step):
 *   1) create mail.tm inbox (API)
 *   2) create Mastodon app + account with that inbox
 *   3) poll inbox for the confirmation mail, click the link
 *   4) post a real toot to verify
 * Saves creds to mastodon-creds.json.
 */
const { ProxyAgent, setGlobalDispatcher } = require('undici');
setGlobalDispatcher(new ProxyAgent('http://127.0.0.1:10808'));
const fs = require('fs');
const path = require('path');

const INSTANCE = 'https://mastodon.social';
const APP_FILE = path.join(__dirname, 'mastodon-creds.json');
const MAILTM = 'https://api.mail.tm';

const USERNAME = 'mscms_v14_' + Math.random().toString(36).slice(2, 6);
const PASSWORD = 'Kuaile1314@Ms' + Math.random().toString(36).slice(2, 8);
const DOB = '1990-05-15';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function jpost(url, body, headers) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(headers || {}) }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
}
function jget(url, headers) {
  return fetch(url, { headers: headers || {} })
    .then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
}
function formPost(url, params) {
  const b = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) b.append(k, v);
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: b })
    .then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
}

(async () => {
  // 1) mail.tm inbox
  const domains = await jget(`${MAILTM}/domains`);
  const domain = domains.json['hydra:member'] && domains.json['hydra:member'][0] && domains.json['hydra:member'][0].domain;
  if (!domain) { console.log('[mail.tm] no domain'); process.exit(1); }
  const address = `${USERNAME}@${domain}`;
  const mailPass = PASSWORD;
  const created = await jpost(`${MAILTM}/accounts`, { address, password: mailPass });
  if (created.status < 200 || created.status >= 300) { console.log('[mail.tm] create FAIL', created.status, JSON.stringify(created.json)); process.exit(1); }
  console.log('[mail.tm] inbox', address);
  const tok = await jpost(`${MAILTM}/token`, { address, password: mailPass });
  const mailToken = tok.json.token;
  if (!mailToken) { console.log('[mail.tm] token FAIL', JSON.stringify(tok.json)); process.exit(1); }
  console.log('[mail.tm] token ok');

  // 2) Mastodon app
  let app;
  if (fs.existsSync(APP_FILE)) { app = JSON.parse(fs.readFileSync(APP_FILE, 'utf8')); }
  if (!app || !app.client_id) {
    const a = await formPost(`${INSTANCE}/api/v1/apps`, {
      client_name: 'MSCMS-v14-AutoPublisher', redirect_uris: 'urn:ietf:wg:oauth:2.0:oob',
      scopes: 'read write push', website: 'https://mscms.cc.cd',
    });
    app = a.json; fs.writeFileSync(APP_FILE, JSON.stringify(app, null, 2));
  }
  const ct = await formPost(`${INSTANCE}/oauth/token`, {
    grant_type: 'client_credentials', client_id: app.client_id, client_secret: app.client_secret,
    redirect_uri: 'urn:ietf:wg:oauth:2.0:oob', scope: 'read write push',
  });
  const appToken = ct.json.access_token;

  // 3) create account
  const acc = await formPost(`${INSTANCE}/api/v1/accounts`, {
    username: USERNAME, email: address, password: PASSWORD, agreement: 'true',
    locale: 'en', date_of_birth: DOB, client_id: app.client_id, client_secret: app.client_secret,
    redirect_uris: 'urn:ietf:wg:oauth:2.0:oob',
  });
  // retry with app Bearer if 401
  let accJson = acc.json, accStatus = acc.status;
  if (accStatus === 401) {
    const r2 = await fetch(`${INSTANCE}/api/v1/accounts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + appToken },
      body: JSON.stringify({ username: USERNAME, email: address, password: PASSWORD, agreement: true, locale: 'en', date_of_birth: DOB, client_id: app.client_id, client_secret: app.client_secret, redirect_uris: 'urn:ietf:wg:oauth:2.0:oob' }),
    }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
    accStatus = r2.status; accJson = r2.json;
  }
  if (accStatus < 200 || accStatus >= 300 || !accJson.access_token) {
    console.log('[masto] account FAIL', accStatus, JSON.stringify(accJson).slice(0, 300));
    process.exit(1);
  }
  const userToken = accJson.access_token;
  console.log('[masto] account created, user token ✅');

  // 4) poll mail.tm for confirmation link
  let confirmUrl = null;
  for (let i = 0; i < 20; i++) {
    await sleep(5000);
    const box = await jget(`${MAILTM}/messages`, { Authorization: 'Bearer ' + mailToken });
    const msgs = (box.json['hydra:member'] || []);
    for (const m of msgs) {
      if (/mastodon|confirm/i.test(m.subject || '') || /mastodon/i.test(m.from && m.from.address || '')) {
        const full = await jget(`${MAILTM}/messages/${m.id}`, { Authorization: 'Bearer ' + mailToken });
        const text = full.json.text || full.json.content || '';
        const match = text.match(/https?:\/\/[^\s"'<>]+confirm[^\s"'<>]*/i) || text.match(/https?:\/\/mastodon\.social[^\s"'<>]*/i);
        if (match) { confirmUrl = match[0]; break; }
      }
    }
    if (confirmUrl) break;
    console.log(`[mail.tm] poll ${i + 1}: no confirmation yet`);
  }
  if (!confirmUrl) { console.log('[mail.tm] no confirmation email found'); process.exit(1); }
  console.log('[confirm] link:', confirmUrl);
  const conf = await fetch(confirmUrl, { redirect: 'follow' });
  console.log('[confirm] clicked, status', conf.status);

  // 5) verify + post
  await sleep(3000);
  const post = await fetch(`${INSTANCE}/api/v1/statuses`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + userToken },
    body: JSON.stringify({ status: '🤖 MSCMS v14 auto-publish test — Mastodon channel online (fully automated onboarding via mail.tm).' }),
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
  console.log('[post] status', post.status, post.json.url ? '-> ' + post.json.url : JSON.stringify(post.json).slice(0, 150));
  if (post.status >= 200 && post.status < 300) {
    const out = { ...app, access_token: userToken, username: USERNAME, email: address, instance: INSTANCE, created_at: new Date().toISOString() };
    fs.writeFileSync(APP_FILE, JSON.stringify(out, null, 2));
    console.log('MASTODON_TOKEN=' + userToken);
    console.log('MASTODON_INSTANCE=' + INSTANCE);
    console.log('RESULT=SUCCESS');
  } else {
    console.log('RESULT=POST_FAILED (email may still be pending)');
  }
})().catch((e) => { console.log('FATAL', e.message); process.exit(1); });
