// 快速探测 3002 及各服务的 HTTP 可用性
const http = require('http');

 probe(port, path, host = '', timeout = 12000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = http.request({ host, port, path, method: 'GET', timeout }, (res) => {
      let n = 0;
      res.on('data', (c) => { n += c.length; });
      res.on('end', () => resolve({ port, path, status: res.statusCode, bytes: n, ms: Date.now() - t0 }));
    });
    req.on('error', (e) => resolve({ port, path, status: 'ERR', err: e.code || e.message, ms: Date.now() - t0 }));
    req.on('timeout', () => { req.destroy(); resolve({ port, path, status: 'TIMEOUT', ms: Date.now() - t0 }); });
    req.end();
  });
}

(async () => {
  const jobs = [
    [3002, '/login.html'],
    [3002, '/v14-console.html'],
    [3002, '/api/health'],
    [3002, '/api/v14/dashboard/stats'],
    [3005, '/api/status'],
    [3010, '/api/health'],
    [3012, '/health'],
    [3011, '/health'],
    [3013, '/status'],
    [8080, '/docs'],
    [20779, '/health'],
  ];
  const out = [];
  for (const [p, path] of jobs) out.push(await probe(p, path));
  console.log('port  path                          status     bytes      ms');
  console.log('----  ----------------------------  ---------  ---------  ------');
  for (const r of out) {
    console.log(
      String(r.port).padEnd(6) +
      String(r.path).padEnd(30) +
      String(r.status).padEnd(11) +
      String(r.bytes ?? '-').padEnd(11) +
      String(r.ms) + (r.err ? '  ' + r.err : '')
    );
  }
})();
