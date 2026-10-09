/**
 * setup--full.js
 * Full Mastodon onboarding via API (no browser/CAPTCHA needed):
 *   1) create app  ->  + 
 *   2) create account (/email/) ->  (user)
 *   3) post a test toot -> verify real publishing
 * Saves everything to -creds.json and prints token for .
 */
const { ProxyAgent, setGlobalDispatcher } = require('undici');
setGlobalDispatcher(new ProxyAgent('http://:10808'));

const fs = require('fs');
const path = require('path');
const INSTANCE = 'https://.social';
const APP_FILE = path.join(__dirname, '-creds.json');

const EMAIL = 'aoshuang99@gmail.com';
const USERNAME = 'mscms_v14';
const PASSWORD = 'Kuaile1314@Ms' + Math.random(36).slice(2, 8);

 req(method, url, body, token) {
  const headers = { '': 'application/json' };
  if (token) headers[''] = 'Bearer ' + token;
  return fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => {
    const txt = await r.text();
    let json;
    try { json = JSON.parse(txt); } catch { json = txt; }
    return { status: r.status, json };
  });
}

 form(url, params) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) body.append(k, v);
  return fetch(url, { method: 'POST', headers: { '': 'application/x-www-form-urlencoded' }, body }).then(async (r) => {
    const txt = await r.text();
    let json; try { json = JSON.parse(txt); } catch { json = txt; }
    return { status: r.status, json };
  });
}

(async () => {
  let app;
  if (fs.existsSync(APP_FILE)) {
    app = JSON.parse(fs.readFileSync(APP_FILE, 'utf8'));
    console.log('[app] loaded from cache:', app. ? 'have ' : 'MISSING');
  }
  if (!app || !app.) {
    const r = await form(`${INSTANCE}/api/v1/apps`, {
      client_name: 'MSCMS-v14-AutoPublisher',
      s: 'urn:ietf:wg:oauth:2.0:oob',
      scopes: 'read write push',
      website: 'https://mscms.cc.cd',
    });
    if (r.status < 200 || r.status >= 300) { console.log('[app] FAIL', r.status, JSON.stringify(r.json)); process.exit(1); }
    app = r.json;
    fs.writeFileSync(APP_FILE, JSON.stringify(app, null, 2));
    console.log('[app] created:', app.);
  }

  // get app-level token () — .social requires it for account creation
  const ct = await form(`${INSTANCE}/oauth/token`, {
    : '',
    : app.,
    : app.,
    : 'urn:ietf:wg:oauth:2.0:oob',
    scope: 'read write push',
  });
  if (ct.status < 200 || ct.status >= 300) { console.log('[app-token] FAIL', ct.status, JSON.stringify(ct.json)); process.exit(1); }
  const appToken = ct.json.;
  console.log('[app-token] obtained');

  // create account via API -> returns  directly
  const DOB = '1990-05-15';
  const acc = await form(`${INSTANCE}/api/v1/`, {
    : USERNAME,
    email: EMAIL,
    : PASSWORD,
    agreement: 'true',
    locale: 'en',
    date_of_birth: DOB,
    : app.,
    : app.,
    s: 'urn:ietf:wg:oauth:2.0:oob',
  });
  // some instances require the app token as Bearer
  if (acc.status === 401) {
    console.log('[account] retry with app Bearer...');
    const r2 = await fetch(`${INSTANCE}/api/v1/`, {
      method: 'POST',
      headers: { '': 'application/json', : 'Bearer ' + appToken },
      body: JSON.stringify({
        : USERNAME, email: EMAIL, : PASSWORD,
        agreement: true, locale: 'en', date_of_birth: DOB,
        : app., : app.,
        s: 'urn:ietf:wg:oauth:2.0:oob',
      }),
    }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
    Object.assign(acc, r2);
  }
  console.log('[account] status', acc.status);
  if (acc.status >= 200 && acc.status < 300 && acc.json.) {
    const token = acc.json.;
    console.log('[account]  obtained ✅');
    // test post
    const post = await req('POST', `${INSTANCE}/api/v1/statuses`, { status: '🤖 MSCMS v14 auto-publish test — Mastodon channel online via API onboarding.' }, token);
    console.log('[post] status', post.status, post.json && post.json.url ? '-> ' + post.json.url : JSON.stringify(post.json).slice(0, 120));
    const out = { ...app, : token, : USERNAME, email: EMAIL, instance: INSTANCE, : new Date().toISOString() };
    fs.writeFileSync(APP_FILE, JSON.stringify(out, null, 2));
    console.log('' + token);
    console.log('MASTODON_INSTANCE=' + INSTANCE);
  } else {
    console.log('[account] could not auto-create. Response:', JSON.stringify(acc.json).slice(0, 400));
    if (acc.json && acc.json.error && /email/i.test(acc.json.error)) {
      console.log('[hint] email confirmation may be required; check inbox or use a different email.');
    }
  }
})().catch((e) => { console.log('FATAL', e.message); process.exit(1); });
