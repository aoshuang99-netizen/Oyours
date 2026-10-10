'use strict';
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const WS = 'C:/Users/AS/WorkBuddy/2026-06-13-19-42-19';
const { DataStore } = require('./data-store.js');
const { TumblrPublisher } = require('./tumblr-publisher.js');

function makePng(size, r, g, b) {
  // 生成 size x size 纯色 RGBA PNG
  const raw = Buffer.alloc(size * (1 + size * 4));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter
    for (let x = 0; x < size; x++) {
      raw[o++] = r; raw[o++] = g; raw[o++] = b; raw[o++] = 255;
    }
  }
  const idat = zlib.deflateSync(raw);
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    const c = require('zlib'); // not used; crc computed below
    return Buffer.concat([len, t, data, crc32(type, data)]);
  }
  function crc32(type, data) {
    const buf = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    let crc = ~0;
    for (let i = 0; i < buf.length; i++) {
      crc ^= buf[i];
      for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
    }
    const out = Buffer.alloc(4); out.writeUInt32BE((~crc) >>> 0, 0); return out;
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

async function main() {
  const id = process.argv[2] || 'tumblr_md4p5xij';
  process.env.MSCMS_DATASTORE_WRITE_MODULES = process.env.MSCMS_DATASTORE_WRITE_MODULES || '*,-content';
  // [2026-09-12] 本脚本不是 content 属主：显式声明写入范围，防止与主服务抢写（多写者覆盖）
  const dataStore = new DataStore(path.join(WS, 'data'));
  const p = new TumblrPublisher(dataStore);
  const tok = dataStore.get('tumblr_token', id);
  const blog = tok.blogName;

  const png = makePng(256, 120, 90, 200);
  fs.writeFileSync('_tmp_avatar.png', png);
  console.log('png bytes:', png.length);
  const av = await p.updateAvatar(blog, '_tmp_avatar.png', id).then(x => ({ ok: true, status: x.status })).catch(e => ({ ok: false, e: e.message.slice(0, 110) }));
  console.log('AVATAR(256):', JSON.stringify(av));
  fs.unlinkSync('_tmp_avatar.png');
  process.exit(0);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
