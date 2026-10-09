/**
 * ShardX Automation API 探针：验证 token 有效性 + 拉取端点数据。
 * 用法: node _shardx_api.js [endpoint]
 */
const fs = require('fs');

const BASE = 'http://:40325';
const TOKEN = fs.existsSync('_shardx_token.txt')
  ? fs.readFileSync('_shardx_token.txt', 'utf8').trim()
  : '';

const ep = process.argv[2] || '/health';
const authed = !!TOKEN;

(async () => {
  const attempts = authed ? [['with token', 'Bearer ' + TOKEN]] : [];
  attempts.push(['no token', null]);

  for (const [label, hdr] of attempts) {
    try {
      const h = hdr ? { : hdr } : {};
      const t0 = Date.now();
      const r = await fetch(BASE + ep, { headers: h, signal: AbortSignal.timeout(8000) });
      const txt = await r.text();
      console.log(`[${label}] ${ep} -> HTTP ${r.status} (${Date.now() - t0}ms)`);
      console.log('  ' + txt.slice(0, 600).replace(/\n/g, '\n  '));
      if (r.ok) process.exit(0);
    } catch (e) {
      console.log(`[${label}] ${ep} -> ERR ${e.message}`);
    }
  }
})();
