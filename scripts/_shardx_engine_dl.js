/**
 * 后台下载 ShardX 引擎（ShardX-Windows.zip ~200MB）到 D:\ShardX\runtime。
 * 直连 R2 即可（实测 HTTP 200，无需代理）。
 */
const fs = require('fs');
const { fetchExt } = require('../http-client.js');

const URL = 'https://pub-e57a7c60f6934eb09a6600bf2fc59cdc.r2.dev/ShardX-Windows.zip';
const OUT = 'D:\\ShardX\\runtime\\ShardX-Windows.zip';

(async () => {
  try {
    const t0 = Date.now();
    const r = await fetchExt(URL, { method: 'GET' });
    if (!r.ok) { console.log('ERR HTTP ' + r.status); process.exit(1); }
    const b = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(OUT, b);
    console.log('[ok] ' + (b.length / 1048576).toFixed(1) + 'MB 用时 ' + ((Date.now() - t0) / 1000).toFixed(0) + 's');
  } catch (e) {
    console.log('ERR ' + (e.message || e));
  }
  process.exit(0);
})();
