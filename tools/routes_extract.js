// T4-1 路由盘点脚本：从 server.js 静态提取全部 Express 路由 → tools/routes.json
// 用法: node tools/routes_extract.js
// 只读分析，不启动/不修改 server，对运行中的服务零影响。
const fs = require('fs');
const path = require('path');

const WS = path.resolve(__dirname, '..');
const serverPath = path.join(WS, 'server.js');
const outPath = path.join(__dirname, 'routes.json');

const src = fs.readFileSync(serverPath, 'utf8');
const lines = src.split('\n');

const METHODS = ['get', 'post', 'put', 'delete', 'patch'];
const routes = [];
const dynamic = []; // 非字面量路径（变量拼接），需人工复核

// 匹配 app.METHOD( 'path' 或 "path" 或 `path`
const reLiteral = /\bapp\.(get|post|put|delete|patch)\s*\(\s*(['"`])([^'"`]+)\2/g;
// 匹配 app.METHOD( 但路径不是字面量（形如 app.get(SOME_VAR ...)）
const reAny = /\bapp\.(get|post|put|delete|patch)\s*\(\s*([^'"`\s])/g;

let m;
while ((m = reLiteral.exec(src)) !== null) {
  const method = m[1].toUpperCase();
  const p = m[3];
  const line = src.slice(0, m.index).split('\n';
  const params = (p.match(/:[A-Za-z0-9_]+/g) || []).map(s => s.slice(1));
  // 模块归类
  const parts = p.split('/').filter(Boolean);
  let mod;
  if (parts[0] === 'api' && /^v\d+$/.test(parts[1] || '')) mod = parts[2] || 'api';
  else if (parts[0] === 'api') mod = parts[1] || 'api';
  else mod = parts[0] || 'root';
  routes.push({ method, path: p, module: mod, params, line });
}

// 找出非字面量声明（避免漏报）
const literalSet = new Set(routes.map(r => `${r.method}:${r.path}`));
while ((m = reAny.exec(src)) !== null) {
  const key = `${m[1].toUpperCase()}:<dynamic>`;
  // 仅记录未在 literal 命中的（粗略）
  dynamic.push({ method: m[1].toUpperCase(), line: src.slice(0, m.index).split('\n', hint: m[2] });
}

// 去重 + 重复检测
const seen = new Map();
const duplicates = [];
for (const r of routes) {
  const k = `${r.method} ${r.path}`;
  if (seen.has(k)) duplicates.push(k);
  else seen.set(k, r);
}

// 按模块聚合计数
const byModule = {};
for (const r of routes) byModule[r.module] = (byModule[r.module] || 0) + 1;

const summary = {
  total: routes.length,
  byMethod: METHODS.reduce((a, me) => ((a[me] = routes.filter(r => r.method === me.toUpperCase()), a), {}),
  byModule: Object.fromEntries(Object.entries(byModule).sort((a, b) => b[1] - a[1])),
  duplicates,
  dynamicCount: dynamic.length,
};

const out = {
  generatedAt: new Date().toISOString(),
  source: 'server.js (static analysis)',
  summary,
  routes: routes.sort((a, b) => a.module.localeCompare(b.module) || a.path.localeCompare(b.path)),
  dynamicUnresolved: dynamic,
};

fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log('提取路由数:', routes.length, '(目标 423)');
console.log('各 METHOD:', JSON.stringify(summary.byMethod));
console.log('重复路由:', duplicates.length, duplicates.slice(0, 5));
console.log('非字面量声明(需复核):', dynamic.length);
console.log('输出:', outPath);
