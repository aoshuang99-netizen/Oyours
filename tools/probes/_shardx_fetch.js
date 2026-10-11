/**
 * 下载 ShardX Launcher（Windows portable）到 D 盘。
 * 走 http-client 的 fetchExt（自带代理与超时），避免用原生 fetch 踩坑。
 */
const fs = require('fs');
const path = require('path');
const { fetchExt } = require('./http-client.js');

const DEST_DIR = 'D:\\ShardX';
const DEST = path.join(DEST_DIR, 'ShardX-Launcher-portable-win-x64.exe');
const PROXY = 'http://127.0.0.1:10808';

(async () => {
  if (!fs.existsSync(DEST_DIR)) fs.mkdirSync(DEST_DIR, { recursive: true });

  const api = 'https://api.github.com/repos/ProxyShard/ShardBrowser/releases/latest';
  const r = await fetchExt(api, { method: 'GET' }, PROXY);
  const j = await r.json();
  const asset = (j.assets || []).find((a) => /portable-win-x64\.exe$/i.test(a.name))
    || (j.assets || []).find((a) => /win.*\.exe$/i.test(a.name));

  if (!asset) { console.log('未找到 Windows 资产'); process.exit(1); }
  console.log('版本: ' + j.tag_name);
  console.log('资产: ' + asset.name + '  ' + (asset.size / 1048576).toFixed(1) + ' MB');

  const t0 = Date.now();
  const res = await fetchExt(asset.browser_download_url, { method: 'GET' }, PROXY);
  if (!res.ok) { console.log('下载失败 HTTP ' + res.status); process.exit(1); }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(DEST, buf);
  const mb = (buf.length / 1048576).toFixed(1);
  console.log('已下载 ' + mb + ' MB，用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  console.log('路径: ' + DEST);
  process.exit(0);
})();
