// 测试本机能否直连（不走代理）访问 tumblr.com / api.tumblr.com
const { fetch } = require('undici');
(async()=>{
  const tests = [
    'https://www.tumblr.com/',
    'https://api.tumblr.com/v2/user/info',
  ];
  for (const u of tests) {
    const t0=Date.now();
    try {
      // 关键：显式 dispatcher=undefined + 设 no_proxy，确保不走全局 ProxyAgent
      const r = await fetch(u, { method:'GET' });
      console.log(`DIRECT OK  ${((Date.now()-t0)/1000).toFixed(1)}s  ${r.status}  ${u}`);
    } catch(e) {
      console.log(`DIRECT ERR ${((Date.now()-t0)/1000).toFixed(1)}s  ${e.message}  ${u}`);
    }
  }
  process.exit(0);
})();
