'use strict';
// 测试：用 GitHub 免费代理作为 fetchExt 出口，能否到达 api.tumblr.com
// 同时测试「直连」与「经 10808 链式」两种可达性
const fs = require('fs');
const path = require('path');
const { fetchExt } = require('./http-client');

const WS = __dirname;
const TUMBLR = 'https://api.tumblr.com/v2/user/info';

async function tryProxy(px, label) {
  const t0 = Date.now();
  try {
    // 不带任何认证，仅探测 Tumblr 是否可达（401=代理通且Tumblr可达；fetch failed=代理不可达）
    const r = await fetchExt(TUMBLR, { method: 'GET', timeout: 10000 }, px || undefined);
    return { px, label, status: r.status, ms: Date.now() - t0, ok: true };
  } catch (e) {
    return { px, label, status: 'ERR', ms: Date.now() - t0, ok: false, err: e.message.slice(0, 60) };
  }
}

(async () => {
  // 重新拉取一批新鲜代理（经 10808）
  let proxies = [];
  const sources = [
    'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
    'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt'
  ];
  for (const u of sources) {
    try {
      const r = await fetchExt(u, { method: 'GET', timeout: 15000 }, 'http://127.0.0.1:10808');
      if (r.ok) {
        const txt = await r.text();
        const lines = txt.split('\n').map(s => s.trim()).filter(Boolean).filter(l => /^(\d{1,3}\.){3}\d{1,3}:\d+$/.test(l));
        proxies.push(...lines);
        console.log(`[拉取] ${u} -> ${lines.length} 条`);
      }
    } catch (e) { console.log(`[拉取失败] ${u}: ${e.message.slice(0, 50)}`); }
  }
  // 去重，取前 40 条测试
  proxies = [...new Set(proxies)].slice(0, 40);
  console.log(`\n测试 ${proxies.length} 个代理对 api.tumblr.com 的可达性（直连）:\n`);

  let reachable = 0;
  for (const p of proxies) {
    const res = await tryProxy('http://' + p, 'direct');
    const tag = res.ok ? '✅可达' : '❌';
    if (res.ok) reachable++;
    console.log(`  ${tag} ${p.padEnd(24)} ${String(res.status).padEnd(5)} ${res.ms}ms ${res.err || ''}`);
    if (reachable >= 5) { console.log('\n已找到足够可达代理，停止'); break; }
  }
  console.log(`\n直连可达 Tumblr 的代理数: ${reachable} / ${proxies.length}`);
  if (reachable === 0) console.log('结论：沙箱无法直连外部代理 IP（仅能经 10808 出网），外部代理不可用。');
})();
