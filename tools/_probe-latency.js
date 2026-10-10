// 压测 3002 各端点响应延迟，重点看看门狗探活用的 /api/v14/causal-chain/status
const http = require('http');

function once(path, timeout = 70000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = http.request({ host: '127.0.0.1', port: 3002, path, method: 'GET', timeout }, (res) => {
      let n = 0;
      res.on('data', (c) => { n += c.length; });
      res.on('end', () => resolve({ path, status: res.statusCode, bytes: n, ms: Date.now() - t0 }));
    });
    req.on('error', (e) => resolve({ path, status: 'ERR', err: e.code || e.message, ms: Date.now() - t0 }));
    req.on('timeout', () => { req.destroy(); resolve({ path, status: 'TIMEOUT', ms: Date.now() - t0 }); });
    req.end();
  });
}

(async () => {
  const paths = [
    '/api/v14/causal-chain/status',   // 看门狗探活端点
    '/login.html',                     // 静态
    '/v14-console.html',               // 静态
    '/api/v14/exits/list',
    '/api/status',
  ];

  console.log('=== 连续 3 轮，每端点测 3 次（看门狗阈值 8000ms）===');
  for (let round = 1; round <= 3; round++) {
    console.log(`\n--- 第 ${round} 轮 ---`);
    for (const p of paths) {
      const rs = [];
      for (let i = 0; i < 3; i++) rs.push(await once(p));
      const stats = rs.map((r) => `${r.status}@${r.ms}ms/${r.bytes}B`).join('  ');
      const max = Math.max(...rs.map((r) => r.ms));
      const flag = max > 8000 ? '  <<< 超看门狗 8s 阈值!' : '';
      console.log(`${p.padEnd(32)} ${stats}${flag}`);
    }
  }
  console.log('\n=== 并发 5 个探活（模拟看门狗 + 前端同时请求）===');
  const t0 = Date.now();
  const all = await Promise.all(Array.from({ length: 5 }, () => once('/api/v14/causal-chain/status')));
  console.log('总耗时:', Date.now() - t0, 'ms | 各:', all.map((r) => r.status + '@' + r.ms).join(' '));
})();
