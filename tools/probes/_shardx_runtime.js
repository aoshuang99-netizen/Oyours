/**
 * 从 Cloudflare R2 下载 ShardX 运行时资源（指纹库 / Widevine / 引擎），
 * 解压到 launcher 期望的目录，使其可用于自动化。
 * 引擎较大（~200MB），故脚本支持后台运行并写进度文件。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { fetchExt } = require('./http-client.js');

const BASE = 'https://pub-e57a7c60f6934eb09a6600bf2fc59cdc.r2.dev/';
const DL = 'D:\\ShardX\\runtime';
const APP = 'C:\\Users\\AS\\AppData\\Roaming\\shardx-launcher';

if (!fs.existsSync(DL)) fs.mkdirSync(DL, { recursive: true });

function unzip(zipPath, destDir) {
  // 极简 ZIP 解压（store/deflate），无第三方依赖
  const buf = fs.readFileSync(zipPath);
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  let count = 0;
  let i = 0;
  // 从尾部定位 EOCD
  let eocd = -1;
  for (let k = buf.length - 22; k >= 0; k--) {
    if (buf.readUInt32LE(k) === 0x06054b50) { eocd = k; break; }
  }
  if (eocd < 0) throw new Error('未找到 EOCD');
  const entries = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < entries; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const data = buf.slice(dataStart, dataStart + compSize);
    const target = path.join(destDir, name);
    if (name.endsWith('/')) {
      fs.mkdirSync(target, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      let out = data;
      if (method === 8) out = zlib.inflateRawSync(data);
      fs.writeFileSync(target, out);
      count++;
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return count;
}

async function get(name, destDir, label) {
  const zipPath = path.join(DL, name);
  if (fs.existsSync(zipPath) && fs.statSync(zipPath).size > 100000) {
    console.log(`[skip] ${name} 已存在`);
  } else {
    const t0 = Date.now();
    const r = await fetchExt(BASE + name, { method: 'GET' });
    if (!r.ok) throw new Error(name + ' HTTP ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(zipPath, buf);
    console.log(`[ok] ${name} ${(buf.length / 1048576).toFixed(1)}MB 用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  if (destDir) {
    const n = unzip(zipPath, destDir);
    console.log(`[unzip] ${name} -> ${destDir} (${n} 个文件)`);
  }
}

(async () => {
  const only = process.argv[2];
  try {
    if (only !== 'engine') {
      await get('ShardX-Fingerprints.zip', path.join(APP, 'fingerprints'), '指纹库');
    }
    if (only !== 'fp') {
      await get('ShardX-Widevine-Win.zip', path.join(APP, 'runtime'), 'Widevine');
      await get('ShardX-Windows.zip', path.join(APP, 'runtime'), '引擎');
    }
    console.log('ALL_DONE');
  } catch (e) {
    console.log('ERR ' + (e.message || e));
  }
  process.exit(0);
})();
