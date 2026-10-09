/**
 * 把 Bright Data ISP session 代理并入 proxy-pool.json，构建真正的多出口池。
 *
 * 2026-08-30 实测：
 *  - VPS 链路(10808 直连 / 7890 Clash / 10950 xray) 出口 IP 均为 
 *  - BD isp_proxy1(44445 与 22225) 出口 IP 为 185.97.0.157 —— 与 VPS 不同
 *  - BD 12 个 session 全部可用（session 只影响连接复用，不换 IP，但可分散并发）
 *  - BD isp_proxy2 两个端口均不可用（该 zone 未激活）
 * 因此合并后共 2 个不同出口 IP、14 条链路，发布时轮换以分散限流并具备故障自愈能力。
 */
const fs = require('fs');
const path = require('path');

const POOL = path.join(__dirname, 'proxy-pool.json');
const TRUSTED = path.join(__dirname, 'trusted-exits.json');

const pool = JSON.parse(fs.readFileSync(POOL, 'utf8'));
const trusted = JSON.parse(fs.readFileSync(TRUSTED, 'utf8'));

// 已有 URL 集合，避免重复写入
const existing = new Set(pool.map((p) => p.url));
let added = 0;

for (const t of trusted) {
  if (existing.has(t.url)) continue;
  pool.push({
    url: t.url,
    name: t.name,
    weight: 1,
    enabled: true,
    exitIp: '185.97.0.157',
    provider: 'brightdata-isp',
    note: '2026-08-30 实测可用（出口 IP 185.97.0.157，与 VPS  不同）。session 用于分散并发连接。',
  });
  added++;
}

// 备份后写入
const bak = path.join(__dirname, 'proxy-pool.bak.' + Date.now() + '.json');
fs.writeFileSync(bak, JSON.stringify(JSON.parse(fs.readFileSync(POOL, 'utf8')), null, 2));
fs.writeFileSync(POOL, JSON.stringify(pool, null, 2));

const enabled = pool.filter((p) => p.enabled !== false);
const ips = new Set(enabled.map((p) => p.exitIp).filter(Boolean));
console.log('新增代理 = ' + added);
console.log('代理池总数 = ' + pool.length + '，启用 = ' + enabled.length);
console.log('不同出口 IP 数 = ' + ips.size + ' -> ' + Array.from(ips).join(', '));
console.log('备份 -> ' + path.basename(bak));
