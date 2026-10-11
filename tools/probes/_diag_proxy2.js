const { ProxyAgent } = (() => { try { return require('undici'); } catch (_) { return {}; } })();

const agents = [
  { name: '10808', d: ProxyAgent ? new ProxyAgent('http://127.0.0.1:10808') : null },
  { name: '7890 ', d: ProxyAgent ? new ProxyAgent('http://127.0.0.1:7890') : null },
];

const ipServices = [
  'https://icanhazip.com',
  'https://ifconfig.me/ip',
  'https://myip.ipip.net',
  'https://api.ipify.org?format=json',
];

(async () => {
  console.log('=== 各代理出口 IP（多出口验证） ===');
  for (const a of agents) {
    if (!a.d) continue;
    let got = null;
    for (const svc of ipServices) {
      try {
        const r = await fetch(svc, { dispatcher: a.d, signal: AbortSignal.timeout(10000) });
        const t = (await r.text()).trim().replace(/\s+/g, ' ').slice(0, 60);
        got = `${svc} => ${t}`;
        break;
      } catch (e) { /* 换下一个 */ }
    }
    console.log(`  ${a.name} : ${got || '全部 IP 服务不可达'}`);
  }

  console.log('\n=== 经各代理访问 Tumblr（连通性） ===');
  for (const a of agents) {
    if (!a.d) continue;
    try {
      const r = await fetch('https://api.tumblr.com/v2/user/info',
        { dispatcher: a.d, signal: AbortSignal.timeout(12000) });
      console.log(`  ${a.name} : HTTP ${r.status} ${r.status === 401 ? '(连通，未授权)' : ''}`);
    } catch (e) {
      console.log(`  ${a.name} : 失败 ${e.message.slice(0, 45)}`);
    }
  }

  console.log('\n=== 公网域名可达性（隧道诊断） ===');
  const urls = ['http://hlua.cc.cd/', 'https://hlua.cc.cd/', 'http://v14.cc.cd/', 'http://127.0.0.1:3002/health'];
  for (const u of urls) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(8000), redirect: 'manual' });
      console.log(`  ${u.padEnd(30)} HTTP ${r.status}`);
    } catch (e) {
      console.log(`  ${u.padEnd(30)} 失败 ${e.message.slice(0, 40)}`);
    }
  }
  process.exit(0);
})();
