#!/usr/bin/env node
/**
 * _cf-dns-check.js —— 只读核查 Cloudflare DNS（不改任何记录）
 * 目的：定位 hlua.cc.cd 公网不可达的根因（是否 CNAME 指向了错误的/失效的隧道）
 * 用法: node tools/_cf-dns-check.js [zoneName=cc.cd] [nameFilter]
 */
const fs = require('fs');

const CFG = 'D:/mscms-ws/config/cloudflare.json';
const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
const TOKEN = cfg.apiToken || cfg.mailToken;
const ACCT = cfg.accountId;
if (!TOKEN) { console.error('缺少 apiToken'); process.exit(1); }

const zoneName = process.argv[2] || 'cc.cd';
const filter = process.argv[3] || '';

async function api(path) {
  const r = await fetch('https://api.cloudflare.com/client/v4' + path, {
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => null);
  return { status: r.status, j };
}

(async () => {
  // 1) token 校验
  const v = await api('/user/tokens/verify');
  console.log('token verify ->', v.status, JSON.stringify(v.j && v.j.result || v.j && v.j.errors || {}).slice(0, 200));
  if (!v.j || !v.j.success) { console.log('⚠️ token 无效或权限不足，后续跳过'); return; }

  // 2) 找 zone
  const z = await api('/zones?per_page=50');
  if (z.j && z.j.success) {
    console.log(`可见 zone 共 ${z.j.result.length} 个:`);
    z.j.result.forEach((r) => console.log(`  ${r.name.padEnd(34)} status=${r.status} id=${r.id}`));
  }
  const target = z.j && z.j.success ? z.j.result.find((r) => r.name === zoneName) : null;
  if (!target) {
    console.log('zone 未找到:', zoneName, '（见上方可见列表）');
    return;
  }
  const zone = target;
  console.log(`\n使用 zone ${zone.name} id=${zone.id} status=${zone.status}`);

  // 3) 列 DNS 记录
  const d = await api(`/zones/${zone.id}/dns_records?per_page=100`);
  if (!d.j || !d.j.success) { console.log('列 DNS 失败', JSON.stringify(d.j && d.j.errors)); return; }
  const rows = d.j.result
    .filter((r) => !filter || r.name.includes(filter) || (r.content || '').includes(filter))
    .map((r) => ({ name: r.name, type: r.type, content: r.content, proxied: r.proxied, ttl: r.ttl }));
  console.log(`DNS 记录 ${rows.length} 条${filter ? '（过滤: ' + filter + '）' : '（全部）'}:`);
  rows.forEach((r) => console.log(`  ${r.name.padEnd(30)} ${r.type.padEnd(6)} ${String(r.content).padEnd(52)} proxied=${r.proxied}`));
})();
