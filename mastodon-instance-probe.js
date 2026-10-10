/**
 * mastodon-instance-probe.js (mail.gw variant)
 * Find an open Mastodon instance that does NOT block disposable emails,
 * so we can fully automate onboarding + email confirmation.
 */
const { ProxyAgent, setGlobalDispatcher } = require('undici');
setGlobalDispatcher(new ProxyAgent('http://127.0.0.1:10808'));
const MAIL = 'https://api.mail.gw';

function formPost(url, params) {
  const b = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) b.append(k, v);
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: b })
    .then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
}
const jpost = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
const jget = (url, h) => fetch(url, { headers: h || {} }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));

(async () => {
  const d = await jget(`${MAIL}/domains`);
  const domain = d.json['hydra:member'][0].domain;
  const address = `probe_${Date.now().toString(36)}@${domain}`;
  const pass = 'Pass' + Math.random().toString(36).slice(2, 10);
  const c = await jpost(`${MAIL}/accounts`, { address, password: pass });
  if (c.status >= 400) { console.log('mail.gw create failed', c.status, JSON.stringify(c.json)); process.exit(1); }
  const tok = await jpost(`${MAIL}/token`, { address, password: pass });
  const mailToken = tok.json.token;
  console.log('[mail.gw] inbox', address);

  const instances = [
    'https://mastodon.xyz',
    'https://mastodon.lol',
    'https://tech.lgbt',
    'https://mstdn.social',
    'https://hachyderm.io',
    'https://indieweb.social',
  ];
  for (const INST of instances) {
    try {
      const info = await jget(`${INST}/api/v1/instance`);
      const open = info.json.registrations && !info.json.approval_required;
      if (!open) { console.log(`${INST} -> closed/approval`); continue; }
      const app = await formPost(`${INST}/api/v1/apps`, { client_name: 'MSCMS-Probe', redirect_uris: 'urn:ietf:wg:oauth:2.0:oob', scopes: 'read write', website: 'https://mscms.cc.cd' });
      const acc = await formPost(`${INST}/api/v1/accounts`, {
        username: 'mscms_p' + Date.now().toString(36).slice(-5),
        email: address, password: pass, agreement: 'true', locale: 'en',
        date_of_birth: '1990-05-15',
        client_id: app.json.client_id, client_secret: app.json.client_secret,
        redirect_uris: 'urn:ietf:wg:oauth:2.0:oob',
      });
      if (acc.status === 200 && acc.json.access_token) {
        console.log(`${INST} -> ✅ ACCEPTS_DISPOSABLE + token granted`);
        // try a post to see if email confirm required
        const p = await fetch(`${INST}/api/v1/statuses`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + acc.json.access_token }, body: JSON.stringify({ status: 'probe' }) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
        console.log(`${INST} -> post test status ${p.status}`);
        process.exit(0);
      } else if (acc.json && acc.json.details && acc.json.details.email) {
        console.log(`${INST} -> blocks email: ${JSON.stringify(acc.json.details.email)}`);
      } else {
        console.log(`${INST} -> account status ${acc.status} ${JSON.stringify(acc.json).slice(0,90)}`);
      }
    } catch (e) {
      console.log(`${INST} -> ERR ${e.message}`);
    }
  }
  console.log('PROBE_DONE');
})().catch((e) => console.log('FATAL', e.message));
