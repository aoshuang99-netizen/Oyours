#!/usr/bin/env node
/**
 * probe-proxy-exits.js — 代理出口可用性与真实出口 IP 探测（零伪造）
 *
 * 背景（2026-09-08 P2 实测）：
 *   proxy-pool.json 存了 37 条代理，但 enabled:true 只有 2 条，
 *   且这 2 条的真实出口 IP 完全相同（104.36.71.219）→ 实际有效出口 = 1 个。
 *   109 个 Tumblr 账号共用 1 个出口 IP，Tumblr 必然 429 Limit Exceeded。
 *
 * 本脚本逐条探测：连通性 + 真实出口 IP + Tumblr 可达性，输出可用于决策的报告。
 *
 * 安全：只请求公开端点（ipify 拿出口 IP / tumblr 首页），不携带任何 OAuth token，
 *       即使代理运营方做 MITM 也不会泄露凭据。
 *
 * 用法：
 *   node tools/probe-proxy-exits.js            # 探测并输出报告（不修改任何文件）
 *   node tools/probe-proxy-exits.js --enable   # 将可用且出口唯一的代理置为 enabled:true
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { fetchExt } = require('../http-client.js');

const POOL_FILE = path.join(__dirname, '..', 'proxy-pool.json');
const ENABLE = process.argv.includes('--enable');
const TIMEOUT = 10000;
const CONCURRENCY = 6;

const IP_URL = 'https://api.ipify.org?format=json';
const TUMBLR_URL = 'https://www.tumblr.com/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';

function loadPool() {
  const j = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8'));
  const arr = Array.isArray(j) ? j : (j.proxies || j.items || []);
  return { raw: j, arr };
}

async function probeOne(p, idx) {
  const url = p.url || p.proxy || '';
  const scheme = String(url).split('://')[0] || '';
  if (!/^https?$/i.test(scheme)) {
    return { idx, name: p.name || url, url, skip: 'non-http scheme (' + scheme + ')' };
  }
  const t0 = Date.now();
  const out = { idx, name: p.name || url, url, enabled: p.enabled !== false, exitIp: null, latencyMs: 0, tumblr: null };
  try {
    const r = await fetchExt(IP_URL, { headers: { 'User-Agent': UA, Accept: 'application/json' }, timeout: TIMEOUT }, url);
    const txt = await r.text();
    out.ipHttpStatus = r.status;
    out.latencyMs = Date.now() - t0;
    if (r.status === 200) {
      try { out.exitIp = (JSON.parse(txt).ip || '').trim(); } catch (e) {
        const m = txt.match(/\d{1,3}(\.\d{1,3}){3}/);
        out.exitIp = m ? m[0] : null;
      }
    } else {
      out.error = 'ipify HTTP ' + r.status;
    }
  } catch (e) {
    out.latencyMs = Date.now() - t0;
    out.error = String(e && e.message || e).slice(0, 80);
    return out;
  }
  // Tumblr 可达性（只要能拿到 HTTP 响应即算可达，401/403 都说明链路通）
  try {
    const t1 = Date.now();
    const r2 = await fetchExt(TUMBLR_URL, { headers: { 'User-Agent': UA }, timeout: TIMEOUT }, url);
    out.tumblr = { status: r2.status, ms: Date.now() - t1 };
  } catch (e) {
    out.tumblr = { status: 0, error: String(e && e.message || e).slice(0, 60) };
  }
  return out;
}

async function main() {
  const { raw, arr } = loadPool();
  console.log(`代理池文件: ${POOL_FILE}`);
  console.log(`总条目: ${arr.length}  当前 enabled: ${arr.filter(p => p.enabled !== false).length}\n`);

  const results = [];
  for (let i = 0; i < arr.length; i += CONCURRENCY) {
    const batch = arr.slice(i, i + CONCURRENCY);
    const rs = await Promise.all(batch.map((p, k) => probeOne(p, i + k)));
    results.push(...rs);
  }

  const ok = results.filter(r => !r.skip && r.exitIp);
  const bad = results.filter(r => !r.skip && !r.exitIp);
  const skipped = results.filter(r => r.skip);

  console.log('── 可用代理（拿到真实出口 IP）──');
  const byIp = new Map();
  for (const r of ok) {
    console.log(`  [${String(r.idx).padStart(2)}] ${r.exitIp.padEnd(16)} ${String(r.latencyMs + 'ms').padEnd(8)} tumblr=${r.tumblr ? r.tumblr.status : '-'}  ${r.name}`);
    if (!byIp.has(r.exitIp)) byIp.set(r.exitIp, []);
    byIp.get(r.exitIp).push(r);
  }
  console.log(`\n可用: ${ok.length} / ${arr.length}   失败: ${bad.length}   跳过(非http): ${skipped.length}`);
  console.log(`唯一出口 IP 数: ${byIp.size}`);
  console.log('出口 IP 分布: ' + JSON.stringify(Array.from(byIp.entries()).map(([ip, v]) => ip + '×' + v.length)));

  if (bad.length) {
    console.log('\n── 不可用 ──');
    bad.slice(0, 12).forEach(r => console.log(`  [${String(r.idx).padStart(2)}] ${r.name} -> ${r.error || 'unreachable'}`));
  }
  if (skipped.length) {
    console.log('\n── 跳过（非 http 协议）──');
    skipped.slice(0, 6).forEach(r => console.log(`  [${String(r.idx).padStart(2)}] ${r.name} (${r.skip})`));
  }

  if (ENABLE) {
    // 每个出口 IP 只保留最快的一条，避免同 IP 重复分流
    const picked = [];
    for (const [, v] of byIp) {
      v.sort((a, b) => a.latencyMs - b.latencyMs);
      picked.push(v[0]);
    }
    let changed = 0;
    for (const r of picked) {
      if (arr[r.idx].enabled === false) { arr[r.idx].enabled = true; changed++; }
      arr[r.idx].exitIp = r.exitIp;
      arr[r.idx].lastCheckedAt = new Date().toISOString();
    }
    fs.writeFileSync(POOL_FILE, JSON.stringify(raw, null, 2), 'utf8');
    console.log(`\n[--enable] 已启用 ${picked.length} 条唯一出口代理（本次新改动 ${changed} 条）`);
    console.log(`  当前 enabled 总数: ${arr.filter(p => p.enabled !== false).length}`);
  } else {
    console.log('\n（只读探测，未修改文件。确认后加 --enable 启用唯一出口代理）');
  }
}

main().then(() => process.exit(0), e => { console.error('FATAL', e); process.exit(1); });
