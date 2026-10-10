// T4-3 契约自检脚本：加载 routes.json，做约定校验 + 对 GET 路由只读冒烟。
// 安全铁律：绝不自动触发 POST/PUT/DELETE（避免误写/假数据）；冒烟仅用 node http 直连 127.0.0.1:3002（绕过 HTTP_PROXY）。
// 用法: node tools/routes_contract.js [--smoke]
const fs = require('fs');
const path = require('path');
const http = require('http');

process.on('unhandledRejection', e => { console.error('unhandledRejection:', e && e.message); });

const WS = path.resolve(__dirname, '..');
const routesPath = path.join(__dirname, 'routes.json');
const outPath = path.join(__dirname, 'contract_report.json');
const doSmoke = process.argv.includes('--smoke');
const HOST = '127.0.0.1';
const PORT = 3002;

const data = JSON.parse(fs.readFileSync(routesPath, 'utf8'));
const routes = data.routes;

// ---- 约定校验 ----
const unversioned = [];
const legacyV1 = [];
const namingViolations = [];

for (const r of routes) {
  const p = r.path;
  if (p.startsWith('/api/')) {
    if (!/^\/api\/v\d+\//.test(p)) unversioned.push(`${r.method} ${p}`);
    else if (/^\/api\/v1\//.test(p)) legacyV1.push(`${r.method} ${p}`);
  }
  if (/\s/.test(p)) namingViolations.push(`空格: ${r.method} ${p}`);
  if (p.length > 1 && p.endsWith('/')) namingViolations.push(`尾斜杠: ${r.method} ${p}`);
  if (/[A-Z]/.test(p.split('?')[0])) namingViolations.push(`大写: ${r.method} ${p}`);
}

const dupMap = new Map();
for (const r of routes) {
  const k = `${r.method} ${r.path}`;
  dupMap.set(k, (dupMap.get(k) || 0) + 1);
}
const duplicates = [...dupMap.entries()].filter(([, n]) => n > 1).map(([k]) => k);

// ---- GET 只读冒烟（带 done 守卫，绝不悬空）----
function smokeGet(route) {
  return new Promise(resolve => {
    if (route.path.includes(':')) {
      return resolve({ route: `${route.method} ${route.path}`, status: 'SKIP_PARAM', cls: 'skip' });
    }
    let done = false;
    const finish = o => { if (!done) { done = true; resolve(o); } };
    const req = http.get({ host: HOST, port: PORT, path: route.path, timeout: 4000 }, res => {
      let size = 0;
      res.on('data', c => {
        size += c.length;
        if (size > 200000) { try { req.destroy(); } catch (_) {} }
      });
      res.on('end', () => {
        let cls = 'ok';
        if (res.statusCode >= 500) cls = 'server_error';
        else if (res.statusCode === 404) cls = 'not_found';
        else if (res.statusCode === 401 || res.statusCode === 403) cls = 'auth';
        else if (res.statusCode >= 400) cls = 'client_err';
        finish({ route: `${route.method} ${route.path}`, status: res.statusCode, cls });
      });
      res.on('close', () => finish({ route: `${route.method} ${route.path}`, status: res.statusCode || 'CLOSED', cls: 'ok' }));
    });
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} finish({ route: `${route.method} ${route.path}`, status: 'TIMEOUT', cls: 'timeout' }); });
    req.on('error', e => finish({ route: `${route.method} ${route.path}`, status: e.code || 'ERR', cls: 'conn_err' }));
  });
}

async function run() {
  const smokeResults = [];
  if (doSmoke) {
    const getRoutes = routes.filter(r => r.method === 'GET');
    const CONC = 10;
    for (let i = 0; i < getRoutes.length; i += CONC) {
      const batch = getRoutes.slice(i, i + CONC);
      const res = await Promise.all(batch.map(smokeGet));
      smokeResults.push(...res);
      process.stdout.write(`\r  GET 冒烟 ${Math.min(i + CONC, getRoutes.length)}/${getRoutes.length}`);
    }
    process.stdout.write('\n');
  }

  const clsCount = {};
  for (const s of smokeResults) clsCount[s.cls] = (clsCount[s.cls] || 0) + 1;

  const report = {
    generatedAt: new Date().toISOString(),
    convention: {
      total: routes.length,
      unversionedCount: unversioned.length,
      legacyV1Count: legacyV1.length,
      namingViolations,
      duplicates,
    },
    unversionedRoutes: unversioned,
    legacyV1Routes: legacyV1,
    smoke: doSmoke ? { total: smokeResults.length, byClass: clsCount, results: smokeResults } : null,
  };
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log('\n==== T4-3 契约自检结果 ====');
  console.log('路由总数:', routes.length);
  console.log('未版本化(/api 无 vN):', unversioned.length);
  console.log('遗留 v1 路由:', legacyV1.length);
  console.log('命名违规:', namingViolations.length, namingViolations.slice(0, 5));
  console.log('重复路由:', duplicates.length);
  if (doSmoke) {
    console.log('GET 冒烟分类:', JSON.stringify(clsCount));
    const bad = smokeResults.filter(s => s.cls === 'server_error' || s.cls === 'not_found' || s.cls === 'conn_err' || s.cls === 'timeout');
    console.log('需关注(5xx/404/连接/超时):', bad.length);
    bad.slice(0, 15).forEach(b => console.log('  -', b.route, b.status));
  } else {
    console.log('(未执行冒烟，加 --smoke 可对 GET 路由只读探测)');
  }
  console.log('报告:', outPath);
}

run().catch(e => { console.error('run error:', e && e.message); process.exit(1); });
