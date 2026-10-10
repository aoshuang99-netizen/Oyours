/**
 * 多出口 IP 池探测：批量测试 proxy-pool.json 中各代理对 Tumblr API 的真实连通性。
 *
 * 重要：必须使用 http-client.js 的 fetchExt —— 它内置代理处理与超时；
 * 直接用「全局 fetch + undici ProxyAgent」在本环境会立即失败（1~6ms），
 * 结果会误判为"所有代理不可用"。
 * 零伪造：只上报真正连通的出口。
 */
const fs = require('fs');
const path = require('path');
const { fetchExt } = require('./http-client.js');

const FILE = path.join(__dirname, 'proxy-pool.json');
const TARGET = 'https://api.tumblr.com/v2/user/info';

async function testProxy(url) {
  if (!/^https?:\/\//.test(url || '')) return { ok: false, why: '非 HTTP 代理' };
  const t0 = Date.now();
  try {
    const r = await fetchExt(TARGET, { method: 'GET' }, url);
    // 401 = 连通但未授权（对 Tumblr 而言即"可用"）；200 = 已授权
    const usable = r.status === 401 || r.status === 200;
    return { ok: usable, why: `HTTP ${r.status}`, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, why: String(e.message || e).slice(0, 34), ms: Date.now() - t0 };
  }
}

(async () => {
  const list = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const results = [];

  for (const p of list) {
    const r = await testProxy(p.url);
    results.push({ name: p.name, url: p.url, ...r });
    console.log(`${r.ok ? '✅' : '❌'} ${String(p.name).padEnd(32)} ${String(r.why).padEnd(24)} ${r.ms}ms`);
  }

  const ok = results.filter((r) => r.ok);
  console.log(`\n===== 可用代理 ${ok.length} / ${results.length} =====`);
  ok.forEach((r) => console.log('  ' + r.name.padEnd(30) + r.url + `  (${r.ms}ms)`));

  fs.writeFileSync(
    path.join(__dirname, '_proxy_probe_result.json'),
    JSON.stringify({ probedAt: new Date().toISOString(), ok: ok.map((r) => ({ name: r.name, url: r.url, ms: r.ms })) }, null, 2)
  );
  process.exit(0);
})();
