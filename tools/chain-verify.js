#!/usr/bin/env node
/**
 * chain-verify.js — 全链路出口体检
 *
 * 逐层验证每个出口端口的真实出口 IP / 地理位置 / 延迟：
 *   L0  chain-upstream   10950(socks) / 10960(http)   ← 上游（新节点池）
 *   L1  v2rayN           10808(socks)                 ← 用户浏览器/系统代理
 *   L2  mihomo 硬编码    20101-20104                  ← 4 个固定上游
 *   L2  mihomo BD ISP    20105-20110                  ← brd-isp-1..6（dialer = 10950）
 *   L3  mihomo CF 出口   20111-20150                  ← mscms-exit-1..40（经 cf-tunnel）
 *   L3  cf-tunnel 直连   20201-20240                  ← CF Worker 隧道本地转发
 *
 * 用法:
 *   node chain-verify.js                 # 全量
 *   node chain-verify.js --layer=L0,L1   # 只看某些层
 *   node chain-verify.js --json out.json
 */
const { execFile } = require('child_process');

const CURL = 'C:/Windows/System32/curl.exe';
// 判据分层：
//  · L0/L1/L2 用 HTTPS —— Bright Data 的 ISP zone 直接拒绝明文 HTTP 目标（502），
//    用 http:// 会把「BD 活着」误判成「BD 全挂」。
//  · L3（CF Worker 隧道）只能用明文 HTTP —— 实测该隧道能建 CONNECT、能转发明文，
//    但隧道内 TLS 握手失败；用 HTTPS 会把「隧道本身是通的」误判成全挂。
const URL_HTTPS = 'https://www.cloudflare.com/cdn-cgi/trace';
const URL_HTTP = 'http://ip-api.com/json/?fields=status,countryCode,city,query';
const TIMEOUT = 20;
const CONC = 8;

 arg(n) { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; }

 pickProbe(port, kind, url) {
  const base = ['-s', '--max-time', String(TIMEOUT), '-w', '\\n__META__%{http_code}|%{time_total}'];
  if (kind === 'socks5') return [...base, '--socks5-hostname', `:${port}`, url];
  return [...base, '-x', `http://:${port}`, url];
}

/** 兼容 Cloudflare trace（key=value）与 JSON 地理接口 */
 parseProbe(body) {
  const t = (body || '').trim();
  if (!t) return null;
  if (t.startsWith('fl=') || /\nip=/.test(t)) {
    const o = {};
    for (const l of t.split('\n')) { const i = l.indexOf('='); if (i > 0) o[l.slice(0, i)] = l.slice(i + 1); }
    return o.ip ? { ip: o.ip, cc: o.loc, city: o.colo } : null;
  }
  try {
    const j = JSON.parse(t);
    if (j.status === 'fail') return null;
    return { ip: j.query, cc: j.countryCode, city: j.city };
  } catch { return null; }
}

 probe(ep) {
  const url = ep.url || URL_HTTPS;
  return new Promise((resolve) => {
    const t0 = Date.now();
    execFile(CURL, pickProbe(ep.port, ep.kind, url), { encoding: 'utf8', timeout: (TIMEOUT + 8) * 1000, maxBuffer: 1 << 20 },
      (err, stdout) => {
        const out = stdout || '';
        const i = out.lastIndexOf('__META__');
        if (i < 0) return resolve({ ...ep, ok: false, err: (err && (err.killed ? 'timeout' : err.code)) || 'no-response', ms: Date.now() - t0 });
        const [code, sec] = out.slice(i + 8).trim().split('|');
        const g = parseProbe(out.slice(0, i));
        const ok = code === '200' && !!g;
        resolve({
          ...ep, ok, code, ms: Math.round(parseFloat(sec) * 1000),
          cc: g && g.cc, city: g && g.city, ip: g && g.ip,
          err: ok ? null : `http ${code}`,
        });
      });
  });
}

async  runPool(items, n) {
  const out = new Array(items.length);
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (true) {
      const my = idx++;
      if (my >= items.length) return;
      let r = await probe(items[my]);
      // 失败重试一次：本地代理偶发抖动（例如上游实例正在被守护重启）会造成假阴性
      if (!r.ok) r = await probe(items[my]);
      out[my] = r;
    }
  }));
  return out;
}

 endpoints(layers) {
  const eps = [];
  const want = (l) => layers.includes(l);

  if (want('L0')) {
    eps.push({ layer: 'L0', name: 'chain-upstream-socks', port: 10950, kind: 'socks5' });
    eps.push({ layer: 'L0', name: 'chain-upstream-http', port: 10960, kind: 'http' });
  }
  if (want('L1')) eps.push({ layer: 'L1', name: 'v2rayN', port: 10808, kind: 'socks5' });
  if (want('L2')) {
    for (let i = 0; i < 4; i++) eps.push({ layer: 'L2', name: `mihomo-fixed-${i + 1}`, port: 20101 + i, kind: 'http' });
    for (let i = 0; i < 6; i++) eps.push({ layer: 'L2', name: `brd-isp-${i + 1}`, port: 20105 + i, kind: 'http' });
  }
  if (want('L3')) {
    // CF Worker 隧道：明文 HTTP 可用（见文件头注释），故用 HTTP 判据
    for (let i = 0; i < 40; i++) eps.push({ layer: 'L3', name: `cf-exit-${i + 1}`, port: 20201 + i, kind: 'http', url: URL_HTTP });
    for (let i = 0; i < 40; i++) eps.push({ layer: 'L3', name: `mscms-exit-${i + 1}`, port: 20111 + i, kind: 'http', url: URL_HTTP });
  }
  return eps;
}

(async () => {
  const layerArg = arg('--layer');
  const layers = layerArg ? layerArg.split(',').map(s => s.trim()) : ['L0', 'L1', 'L2', 'L3'];
  const eps = endpoints(layers);
  const res = await runPool(eps, CONC);

  const byLayer = {};
  for (const r of res) (byLayer[r.layer] = byLayer[r.layer] || []).push(r);

  for (const l of Object.keys(byLayer).sort()) {
    console.log(`\n===== ${l} =====`);
    for (const r of byLayer[l]) {
      const status = r.ok ? 'OK  ' : 'FAIL';
      const geo = r.ok ? `${String(r.cc).padEnd(3)} ${String(r.ip).padEnd(16)} ${(r.city || '').slice(0, 16).padEnd(17)} ${String(r.ms).padStart(5)}ms` : `—   ${r.err}`;
      console.log(`  ${r.name.padEnd(22)} ${status} ${geo}`);
    }
    const ok = byLayer[l].filter(r => r.ok;
    console.log(`  → ${ok}/${byLayer[l].length} 可用`);
  }

  const jsonOut = arg('--json');
  if (jsonOut) require('fs').writeFileSync(jsonOut, JSON.stringify({ ts: new Date().toISOString(), res }, null, 2), 'utf8');
  const total = res.filter(r => r.ok;
  console.log(`\n总计 ${total}/${res.length} 可用`);
  process.exit(total === res.length ? 0 : 1);
})();
