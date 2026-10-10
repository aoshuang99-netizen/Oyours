'use strict';
const http = require('http');
const https = require('https');
const tls = require('tls');
const crypto = require('crypto');
const fs = require('fs');

const WS = 'C:/Users/AS/WorkBuddy/2026-06-13-19-42-19';
const PROXY = { host: '127.0.0.1', port: 10808 };

function connectTunnel(targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: PROXY.host, port: PROXY.port, method: 'CONNECT', path: `${targetHost}:${targetPort}` });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { reject(new Error('CONNECT failed: ' + res.statusCode)); return; }
      resolve(socket);
    });
    req.on('error', reject);
    req.on('timeout', () => reject(new Error('CONNECT timeout')));
    req.setTimeout(10000);
    req.end();
  });
}

function oauthHeader(ck, cs, tk, tks, method, url, extraParams) {
  const oauth = {
    oauth_consumer_key: ck,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000),
    oauth_token: tk,
    oauth_version: '1.0'
  };
  const params = Object.assign({}, extraParams, oauth);
  const keys = Object.keys(params).sort();
  const paramStr = keys.map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
  const baseStr = `${method}&${encodeURIComponent(url)}&${encodeURIComponent(paramStr)}`;
  const key = `${encodeURIComponent(cs)}&${encodeURIComponent(tks)}`;
  const sig = crypto.createHmac('sha1', key).update(baseStr).digest('base64');
  oauth.oauth_signature = sig;
  return 'OAuth ' + Object.keys(oauth).map(k => `${encodeURIComponent(k)}="${encodeURIComponent(oauth[k])}"`).join(', ');
}

function tumblrGet(token, consumer) {
  const url = 'https://api.tumblr.com/v2/user/info';
  return connectTunnel('api.tumblr.com', 443).then(socket => new Promise((resolve, reject) => {
    const tlsSock = tls.connect({ socket, servername: 'api.tumblr.com' }, () => {
      const hdr = oauthHeader(consumer.consumerKey, consumer.consumerSecret, token.oauthToken, token.oauthTokenSecret, 'GET', url, {});
      const req = https.request({
        host: 'api.tumblr.com', servername: 'api.tumblr.com', socket: tlsSock, agent: false,
        method: 'GET', path: '/v2/user/info', headers: { Authorization: hdr }
      }, r => {
        let d = ''; r.on('data', c => d += c); r.on('end', () => resolve({ status: r.statusCode, body: d }));
      });
      req.on('error', reject);
      req.setTimeout(15000, () => req.destroy(new Error('request timeout')));
      req.end();
    });
    tlsSock.on('error', reject);
  }));
}

(async () => {
  const cfgRaw = JSON.parse(fs.readFileSync(WS + '/data/tumblr_config.json', 'utf8'));
  const tokRaw = JSON.parse(fs.readFileSync(WS + '/data/tumblr_token.json', 'utf8'));
  const consumers = cfgRaw
    .filter(a => a.consumerKey && a.consumerSecret)
    .map(a => ({ consumerKey: a.consumerKey, consumerSecret: a.consumerSecret }));
  const tokenIds = Object.keys(tokRaw).filter(id => tokRaw[id].oauthToken && tokRaw[id].oauthTokenSecret);
  console.log(`consumer keys: ${consumers.length}, tokens: ${tokenIds.length}`);

  let tested = 0;
  for (const id of tokenIds.slice(0, 6)) {
    const token = tokRaw[id];
    for (const c of consumers) {
      try {
        const r = await tumblrGet(token, c);
        tested++;
        let parsed = null; try { parsed = JSON.parse(r.body); } catch (e) {}
        const ok = r.status === 200 && parsed && parsed.response && parsed.response.user;
        console.log(`[${id}] consumer=${c.consumerKey.slice(0, 8)} -> HTTP ${r.status} ${ok ? 'VALID ✅' : 'invalid'} ${r.body.slice(0, 120)}`);
        if (ok) { console.log('   user:', JSON.stringify(parsed.response.user).slice(0, 200)); process.exit(0); }
      } catch (e) {
        console.log(`[${id}] consumer=${c.consumerKey.slice(0, 8)} -> ERR ${e.message}`);
      }
    }
  }
  console.log('tested', tested, 'combos, none valid');
})();
