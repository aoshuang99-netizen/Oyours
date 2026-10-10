const net = require('net');

// 1) 端口探测
const ports = [10808, 7890, 9090, 10809, 1080, 20171];
function probe(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port, timeout: 1500 });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => { try { s.destroy(); } catch (_) {} resolve(false); });
    s.on('timeout', () => { s.destroy(); resolve(false); });
  });
}

(async () => {
  console.log('=== 本机代理端口探测 ===');
  for (const p of ports) {
    const ok = await probe(p);
    console.log(`  ${String(p).padEnd(8)} ${ok ? '监听 ✅' : '未监听'}`);
  }

  // 2) Clash External Controller API (9090)
  console.log('\n=== Clash API (9090) ===');
  try {
    const r = await fetch('http://127.0.0.1:9090/proxies', { signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    const names = Object.keys(j.proxies || {});
    console.log('  Clash API 可用 ✅  节点数 = ' + names.length);
    console.log('  前 12 个节点: ' + names.slice(0, 12).join(', '));
  } catch (e) {
    console.log('  Clash API 不可用: ' + e.message.slice(0, 60));
  }

  // 3) 出口 IP 对比（10808 vs 7890）
  console.log('\n=== 出口 IP 对比 ===');
  const { ProxyAgent } = (() => { try { return require('undici'); } catch (_) { return {}; } })();
  const targets = [
    { name: '直连  ', dispatcher: undefined },
    { name: '10808 ', dispatcher: ProxyAgent ? new ProxyAgent('http://127.0.0.1:10808') : undefined },
    { name: '7890  ', dispatcher: ProxyAgent ? new ProxyAgent('http://127.0.0.1:7890') : undefined },
  ];
  for (const t of targets) {
    if (!t.dispatcher && t.name !== '直连  ') continue;
    try {
      const opts = { signal: AbortSignal.timeout(12000) };
      if (t.dispatcher) opts.dispatcher = t.dispatcher;
      const r = await fetch('https://api.ipify.org?format=json', opts);
      const j = await r.json();
      console.log(`  ${t.name} 出口 IP = ${j.ip}`);
    } catch (e) {
      console.log(`  ${t.name} 失败: ${e.message.slice(0, 50)}`);
    }
  }

  // 4) hlua.cc.cd 可达性
  console.log('\n=== 公网域名 hlua.cc.cd ===');
  for (const path of ['http://hlua.cc.cd/r/4H8FHd', 'http://127.0.0.1:3002/r/4H8FHd']) {
    try {
      const r = await fetch(path, { signal: AbortSignal.timeout(8000), redirect: 'manual' });
      console.log(`  ${path} -> HTTP ${r.status}`);
    } catch (e) {
      console.log(`  ${path} -> 失败 ${e.message.slice(0, 50)}`);
    }
  }
  process.exit(0);
})();
