/**
 * proxy-pool-activator.js — 多出口代理池激活器（消除 Tumblr 429 根因之一）
 *
 * 做什么：
 *   1. 读取 freefq 节点，经 sing-box 转成多个「本地 HTTP 代理」（http://127.0.0.1:1081+）
 *      —— HTTP 代理与现有 http-client 的 undici ProxyAgent 完全兼容（SOCKS5 不兼容）。
 *   2. 对每个本地代理用 ipify 探测真实出口 IP，按出口 IP 去重（同一节点/同一 IP 只留一个）。
 *   3. 把去重后的出口（永远保留原 10808 中继作兜底）写入 proxy-pool.json。
 *   4. 持久化 sing-box 进程 PID 到 .proxy-v2ray-pids.json，便于清理与幂等重启。
 *
 * 幂等：已运行且健康的代理不会重复拉起；崩溃/重启后重跑会复用存活进程并补充不足数量。
 *
 * 用法：
 *   node proxy-pool-activator.js            # 默认尝试 12 个独立出口
 *   node proxy-pool-activator.js 8          # 指定目标数量
 *   node proxy-pool-activator.js --check    # 仅校验/重写现有池，不新增
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { getProxyV2RayManager } = require('./proxy-v2ray-manager.js');
const { fetchExt } = require('./http-client.js');

const PID_FILE = path.join(__dirname, '.proxy-v2ray-pids.json');
const POOL_FILE = path.join(__dirname, 'proxy-pool.json');
// 永远保留原中继作兜底（单出口场景不会更差），新出口在其后追加
const RELAY = { url: 'http://127.0.0.1:10808', name: 'default-relay', weight: 1, enabled: true };
// 额外静态转发代理候选（如本机 Clash 7890）：仅当可达且出口 IP 与已有不重复时才加入池。
// 用途：在 freefq 不可达的受限网络下，把养号流量分散到本机已有的其它可用出口，缓解单 IP 429。
const STATIC_EXTRA_PROXIES = ['http://127.0.0.1:7890'];
const HEALTH_TIMEOUT = 15000;

// 探测本地代理的真实公网出口 IP（走该代理访问 ipify）。返回 IP 或 null。
async function getExitIp(proxyUrl) {
  const endpoints = [
    'https://api.ipify.org?format=json',
    'https://ifconfig.me/ip',
    'https://myexternalip.com/raw',
  ];
  for (const ep of endpoints) {
    try {
      const r = await fetchExt(ep, { method: 'GET', timeout: HEALTH_TIMEOUT }, proxyUrl);
      if (!r.ok) continue;
      const txt = (await r.text()).trim();
      const ip = (txt.match(/(\d{1,3}\.){3}\d{1,3}/) || [])[0];
      if (ip) return ip;
    } catch (_) {}
  }
  return null;
}

function loadPidFile() {
  try { return JSON.parse(fs.readFileSync(PID_FILE, 'utf8')); } catch { return []; }
}

function isPidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function activate(opts = {}) {
  const desired = opts.desired || 12;
  const checkOnly = !!opts.checkOnly;

  const mgr = getProxyV2RayManager();
  const nodeCount = await mgr.init();
  console.log(`[activator] freefq 解析到 ${nodeCount} 个节点`);
  if (nodeCount === 0) {
    console.error('[activator] ❌ 无可用节点（freefq 文件缺失或为空），仅保留 10808 中继');
    writePool([RELAY], []);
    return { poolSize: 1, distinctIp: 0, nodes: nodeCount };
  }

  // 恢复上一轮存活的代理
  let running = loadPidFile().filter(p => isPidAlive(p.pid));
  if (running.length) {
    console.log(`[activator] 复用 ${running.length} 个存活代理`);
    mgr.seedNextPort(running.map(p => p.port));
  }

  // 补足到目标数量
  const need = checkOnly ? 0 : Math.max(0, desired - running.length);
  if (need > 0) {
    console.log(`[activator] 启动 ${need} 个新 HTTP 代理...`);
    const fresh = await mgr.startDistinctHttp(need);
    running = running.concat(fresh);
  }
  if (running.length === 0) {
    console.error('[activator] ❌ 没有任何代理成功启动，仅保留 10808 中继');
    writePool([RELAY], []);
    return { poolSize: 1, distinctIp: 0, nodes: nodeCount };
  }

  // 出口 IP 健康检查 + 去重：兜底中继(10808) → 额外静态转发代理(如 7890 Clash) → freefq 动态出口
  console.log(`[activator] 探测出口 IP（中继+静态+freefq 共 ${running.length + 1 + STATIC_EXTRA_PROXIES.length} 个候选）...`);
  const seenIp = new Set();
  const liveEntries = [];   // 仅 freefq 受管进程（带 PID）
  const poolEntries = [];

  // 1) 兜底中继 10808（永远保留，即使探测失败也不致池为空）
  const relayExit = await getExitIp(RELAY.url);
  if (relayExit) seenIp.add(relayExit);
  poolEntries.push({ url: RELAY.url, name: 'default-relay', weight: 1, enabled: true, exitIp: relayExit || null });
  console.log(`[activator] 中继 10808 → 出口 ${relayExit || '(探测失败)'}`);

  // 2) 额外静态转发代理（如 7890 Clash），按出口 IP 去重后加入
  for (const sp of STATIC_EXTRA_PROXIES) {
    const ex = await getExitIp(sp);
    if (!ex) { console.warn(`[activator] ⚠️ 静态代理 ${sp} 不可用，跳过`); continue; }
    if (seenIp.has(ex)) { console.warn(`[activator] ⚠️ 静态代理 ${sp} 出口 ${ex} 与已有重复，跳过`); continue; }
    seenIp.add(ex);
    poolEntries.push({ url: sp, name: `static-${ex}`, weight: 1, enabled: true, exitIp: ex });
    console.log(`[activator] ✅ 静态代理 ${sp} → 出口 ${ex}`);
  }

  // 3) freefq 动态出口（已启动的本地 HTTP 代理）
  for (const p of running) {
    const exitIp = await getExitIp(p.url);
    if (!exitIp) {
      console.warn(`[activator] ⚠️ 代理 ${p.url} 不健康（出口探测失败），清理 PID ${p.pid}`);
      try { process.kill(p.pid); } catch {}
      continue;
    }
    if (seenIp.has(exitIp)) {
      console.warn(`[activator] ⚠️ 代理 ${p.url} 出口 ${exitIp} 与已有重复，跳过`);
      try { process.kill(p.pid); } catch {}
      continue;
    }
    seenIp.add(exitIp);
    poolEntries.push({ url: p.url, name: `v2ray-${exitIp}`, weight: 1, enabled: true, exitIp });
    liveEntries.push(p);
    console.log(`[activator] ✅ ${p.url} → 出口 ${exitIp}`);
  }

  writePool(poolEntries, liveEntries);
  console.log(`[activator] 完成：共 ${poolEntries.length} 个出口（含 10808 兜底），${seenIp.size} 个独立公网 IP`);
  return { poolSize: poolEntries.length, distinctIp: seenIp.size, nodes: nodeCount, exits: [...seenIp] };
}

// 命令行独立运行入口
async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const desiredArg = args.find(a => /^\d+$/.test(a));
  const desired = desiredArg ? parseInt(desiredArg, 10) : 12;
  await activate({ desired, checkOnly });
}

function writePool(poolEntries, liveEntries) {
  fs.writeFileSync(POOL_FILE, JSON.stringify(poolEntries, null, 2));
  fs.writeFileSync(PID_FILE, JSON.stringify(liveEntries, null, 2));
  console.log(`[activator] 写入 ${POOL_FILE} 和 ${PID_FILE}`);
}

module.exports = { activate, getExitIp, PID_FILE, POOL_FILE, RELAY };

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => { console.error('[activator] 致命错误:', e); process.exit(1); });
}
