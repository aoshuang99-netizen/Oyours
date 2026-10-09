#!/usr/bin/env node
// 只读检查 Cloudflare 凭据是否可用（输出脱敏），不修改任何东西
const fs = require('fs');
const P = 'D:/mscms-ws/config/cloudflare.json';
if (!fs.existsSync(P)) { console.log('MISSING ' + P); process.exit(1); }
const j = JSON.parse(fs.readFileSync(P, 'utf8'));
const red = (v) => (typeof v === 'string' && v.length > 8 ? v.slice(0, 6) + '…(len ' + v.length + ')' : v);
const out = {};
for (const k of Object.keys(j)) out[k] = /token|key|secret/i.test(k) ? red(j[k]) : j[k];
console.log(JSON.stringify(out, null, 1));
