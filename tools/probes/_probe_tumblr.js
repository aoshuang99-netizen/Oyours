'use strict';
const { ProxyAgent, request } = require('undici');
const proxy = 'http://127.0.0.1:10808';
const agent = new ProxyAgent(proxy);

async function tryFetch(url, label) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const { statusCode, headers } = await request(url, { dispatcher: agent, method: 'GET', signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    clearTimeout(t);
    console.log(`[OK] ${label} ${url} -> ${statusCode} (server: ${(headers&&headers['server'])||'?'})`);
    return statusCode;
  } catch (e) {
    clearTimeout(t);
    console.log(`[ERR] ${label} ${url} -> ${e.message} (cause: ${e.cause && e.cause.code || e.cause || '?'})`);
    return null;
  }
}

(async () => {
  console.log('=== Tumblr reachability probe via', proxy, '===');
  await tryFetch('https://www.tumblr.com/', 'www');
  await tryFetch('https://api.tumblr.com/v2/user/info', 'api');
  console.log('=== probe done ===');
})();
