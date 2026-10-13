'use strict';
/**
 * 确定性 harness：本地 mock 代理复现「闸门回 429」时 undici 的错误形态。
 * 目的：判定 cloud-publisher.js:1513 的限流正则（用的是 err.message 单层）能否命中。
 * 不依赖真实 Tumblr / 真实闸门 ⇒ 秒级、可复现、无随机性。
 */
const http = require('http');
const { ProxyAgent, fetch: ufetch } = require('./node_modules/undici');

// 与 cloud-publisher.js:1513 / :1739 完全同一条
const RE = /8023|daily\s*post\s*limit|rate\s*limit|quota|too\s*many\s*requests|\b429\b/i;

function chainTexts(e, max = 6) {
  const out = [];
  let cur = e, i = 0;
  while (cur && i < max) {
    out.push({
      lvl: i,
      name: (cur.name || (cur.constructor && cur.constructor.name) || '?'),
      message: String(cur.message || ''),
      code: cur.code || null,
    });
    cur = cur.cause; i++;
  }
  return out;
}

const MODES = {
  // A = 当前转发器行为：write 429 后立刻 end()
  'A_429_CL0_close_end': (s) => s.end(
    'HTTP/1.1 429 Too Many Requests\r\nRetry-After: 60\r\n'
    + 'X-MSCMS-Gate: bd-relay-cooldown\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'),
  // B = 429 但不断开（keep-alive）
  'B_429_keepalive': (s) => s.write(
    'HTTP/1.1 429 Too Many Requests\r\nRetry-After: 60\r\n'
    + 'X-MSCMS-Gate: bd-relay-cooldown\r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n'),
  // C = 旧转发器行为（伪装 200 后立刻销毁）—— 对照组，预期不命中
  'C_200_then_destroy': (s) => { s.write('HTTP/1.1 200 Connection established\r\n\r\n'); setTimeout(() => s.destroy(), 30); },
  // D = 407
  'D_407': (s) => s.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'),
};

async function run(name, fn) {
  const srv = http.createServer();
  srv.on('connect', (req, cli) => { cli.on('error', () => {}); try { fn(cli); } catch (_) {} });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const agent = new ProxyAgent(`http://127.0.0.1:${port}`);
  let err = null;
  try {
    await ufetch('https://api.tumblr.com/v2/blog/staff.tumblr.com/info?api_key=x',
      { dispatcher: agent, signal: AbortSignal.timeout(8000) });
  } catch (e) { err = e; }

  console.log(`\n--- ${name} ---`);
  if (!err) { console.log('  ⚠️ 竟然没报错'); }
  else {
    const ch = chainTexts(err);
    for (const c of ch) console.log(`  L${c.lvl} ${c.name} [${c.code || '-'}] ${c.message}`);
    const top = ch[0].message;
    const joined = ch.map((c) => c.message).join(' | ');
    // 复现 tumblr-publisher.js:651 的包装（只取 e.message）
    const wrapped = `Tumblr /blog/x/post ${top}`;
    console.log(`  ★ cloud-publisher 拿到的 errMsg = "${wrapped}"`);
    console.log(`  ★ 仅 err.message 命中正则 : ${RE.test(top) ? '✅ 是' : '❌ 否'}`);
    console.log(`  ★ 全链文本命中正则       : ${RE.test(joined) ? '✅ 是' : '❌ 否'}`);
    console.log(`  ★ 包装后(现状)命中正则   : ${RE.test(wrapped) ? '✅ 是' : '❌ 否'}`);
  }
  try { await agent.close(); } catch (_) {}
  await new Promise((r) => srv.close(r));
}

(async () => {
  console.log('undici =', require('./node_modules/undici/package.json').version);
  for (const [n, f] of Object.entries(MODES)) await run(n, f);
})().catch((e) => { console.error('fatal', e); process.exit(1); });
