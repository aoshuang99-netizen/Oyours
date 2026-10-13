'use strict';
/**
 * 闸门回归验证（live）：真实 http-client.js + 真实出网闸门(10809)。
 * 判据：闸门拦截时，fetchExt 抛出的 message 必须含可被
 *   cloud-publisher.js:1513 限流正则识别的标记 ⇒ 任务会走【推迟】而非【判死】。
 */
process.env.DATA_DIR = process.env.DATA_DIR || 'D:/mscms-ws/data';
const net = require('net');
const RE = /8023|daily\s*post\s*limit|rate\s*limit|quota|too\s*many\s*requests|\b429\b/i;
const { fetchExt } = require('./http-client');

function rawConnect(port, host, p2, timeout = 8000) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    let buf = '', done = false;
    const fin = (v) => { if (done) return; done = true; try { s.destroy(); } catch (_) {} resolve(v); };
    s.setTimeout(timeout, () => fin(buf || '(超时)'));
    s.on('connect', () => s.write(`CONNECT ${host}:${p2} HTTP/1.1\r\nHost: ${host}:${p2}\r\n\r\n`));
    s.on('data', (d) => { buf += d.toString('latin1'); if (buf.includes('\r\n\r\n')) fin(buf.split('\r\n\r\n')[0]); });
    s.on('error', (e) => fin('ERR ' + e.message));
  });
}

(async () => {
  console.log('=== ① 闸门原始应答（应恢复为 429 Too Many Requests）===');
  console.log(await rawConnect(10809, 'api.tumblr.com', 443));

  console.log('\n=== ② 真实 fetchExt 经闸门请求 api.tumblr.com（关键判据）===');
  try {
    const r = await fetchExt('https://api.tumblr.com/v2/user/info',
      { method: 'POST', body: 'x', bypassCircuit: true, timeout: 8000 }, 'http://127.0.0.1:10809');
    console.log('意外拿到响应 HTTP ' + r.status + ' ⇒ 闸门未拦截');
  } catch (e) {
    const msg = String(e.message || '');
    console.log('message  =', msg);
    console.log('status   =', e.status, ' isRateLimited =', e.isRateLimited);
    const wrapped = `Tumblr /blog/x/post ${msg}`;   // 复现 tumblr-publisher.js:651
    console.log('包装后(front80) =', wrapped.slice(0, 80));
    console.log('★ 限流正则命中 =', RE.test(wrapped) ? '✅ 是 ⇒ 任务被【推迟】，内容不丢' : '❌ 否 ⇒ 仍会判死');
  }

  console.log('\n=== ③ 对照：非 tumblr 目标应仍可正常出网 ===');
  try {
    const r = await fetchExt('https://api.ipify.org/?format=json',
      { method: 'GET', bypassCircuit: true, timeout: 15000 }, 'http://127.0.0.1:10809');
    console.log('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 80));
  } catch (e) { console.log('对照失败: ' + e.message); }

  process.exit(0);
})().catch((e) => { console.error('fatal', e); process.exit(1); });
