'use strict';
/**
 * 实测 P0-R2 补丁：真实 http-client.js 的 fetchExt 经「回 429 的代理」时，
 * 抛出的错误文案能否被 cloud-publisher.js:1513 的限流正则识别。
 * 对照组：代理放行但目标不可达（应表现为网络错误，且**不**被限流正则命中）。
 */
process.env.DATA_DIR = process.env.DATA_DIR || 'D:/mscms-ws/data';
const http = require('http');
const RE = /8023|daily\s*post\s*limit|rate\s*limit|quota|too\s*many\s*requests|\b429\b/i;

const { fetchExt } = require('./http-client');

function startMock(reply) {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.on('connect', (req, cli) => { cli.on('error', () => {}); try { reply(cli); } catch (_) {} });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

async function probe(label, reply, target) {
  const { srv, port } = await startMock(reply);
  const px = `http://127.0.0.1:${port}`;
  const out = { label };
  try {
    const r = await fetchExt(target, { method: 'POST', body: 'x', bypassCircuit: true, timeout: 8000 }, px);
    out.http = r.status;
  } catch (e) {
    out.message = String(e.message || '');
    out.status = e.status;
    out.isRateLimited = e.isRateLimited;
    out.code = e.code;
    out.matched = RE.test(out.message);
    // 复现 tumblr-publisher.js:651 的包装（只取 e.message）
    out.wrapped = `Tumblr /blog/x/post ${out.message}`;
    out.wrapped80 = out.wrapped.slice(0, 80);
    out.matchedAfterWrap = RE.test(out.wrapped);
    out.statusAfterWrap = e.status;   // 注意 651 会显式覆盖为 0，这里仅记录 fetchExt 层
  }
  await new Promise((r) => srv.close(r));
  return out;
}

(async () => {
  const T = 'https://api.tumblr.com/v2/blog/x.tumblr.com/posts';

  console.log('=== ① 代理回 429（闸门 cooldown 的等价形态）===');
  console.log(JSON.stringify(await probe('429', (s) => s.end(
    'HTTP/1.1 429 Too Many Requests\r\nRetry-After: 21713\r\nX-MSCMS-Gate: bd-relay-cooldown\r\n'
    + 'Content-Length: 0\r\nConnection: close\r\n\r\n'), T), null, 2));

  console.log('\n=== ② 代理回 502（BD 上游不可用，非限流）===');
  console.log(JSON.stringify(await probe('502', (s) => s.end(
    'HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'), T), null, 2));

  console.log('\n=== ③ 对照组：代理放行但目标不存在（纯网络错误，不应被限流正则命中）===');
  console.log(JSON.stringify(await probe('200+dead', (s) => {
    s.write('HTTP/1.1 200 Connection established\r\n\r\n');
    setTimeout(() => s.destroy(), 20);
  }, 'https://127.0.0.1:1/x'), null, 2));

  process.exit(0);
})().catch((e) => { console.error('fatal', e); process.exit(1); });
