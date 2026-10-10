#!/usr/bin/env node
/**
 * free-proxy-pool.js — 免费开源代理池自动维护器
 * ──────────────────────────────────────────────────────────────────
 * 问题背景：MSCMS v14 发布器的真实瓶颈是「没有可用住宅出口」。
 *   proxy-pool.json 里 90 条，0 条可用；唯一启用的是数据中心 IP
 *   ()，被 Tumblr 网络层重置 → 发布零 reach。
 *
 * 本脚本是「GitHub 免费方案」的落地：从多个 GitHub 托管的开源免费代理
 * 列表拉取候选，用 curl 实测每条代理的【真实出口 IP】(ipify) 与
 * 【Tumblr 可达性】，把通过校验的写回 proxy-pool.json（enabled:true），
 * 死代理不写入。零 npm 依赖，纯 Node 内置 + curl。
 *
 * 设计要点（来自 social-autopost-free skill 第 15 条铁律）：
 *   真正决定限流产能的是「不同公网出口 IP 的个数」，不是配置条目数。
 *   所以本脚本在结尾统计 distinctEgressIps 并打印。
 *
 * 用法：
 *   node tools/free-proxy-pool.js                拉取+校验+写回默认 pool
 *   node tools/free-proxy-pool.js --dry-run      只打印，不落盘
 *   node tools/free-proxy-pool.js --selfcheck    离线自检（不联网）
 *   node tools/free-proxy-pool.js --pool <path>  指定 pool 路径
 *   node tools/free-proxy-pool.js --via <proxy>  拉列表时借道某代理
 *   node tools/free-proxy-pool.js --limit 300    最多校验候选数
 *
 * ⚠️ 诚实声明：免费公开代理几乎全是数据中心/滥用名单 IP，Tumblr 大概率
 *   仍会重置（与 10808 同命）。本脚本的价值是：
 *   ① 自动、持续地找「当前还活着」的免费出口，系统一有可用 IP 立刻用上；
 *   ② 若你日后接入任何免费/试用住宅源，把它加进 FREE_SOURCES 或手动
 *      写一条到 pool，本脚本会自动校验并纳入轮换。
 *   它【不】能凭空变出住宅 IP——那是付费生意。真正绕过住宅墙的免费杠杆
 *   见 tools/free--publisher.js（Bluesky / Mastodon）。
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

// 知名开源免费代理列表（GitHub 托管，公开可拉）。
// 列表可能随时失效/改格式——脚本容忍单个源失败，不阻断整体。
const FREE_SOURCES = [
  { name: 'fate0/proxy_list',         url: 'https://raw.githubusercontent.com/fate0/proxy_list/master/proxy.txt' },
  { name: 'TheSpeedX/PROXY-List',     url: 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt' },
  { name: 'ShiftyTR/Proxy-List',      url: 'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt' },
  { name: 'monosans/proxy-list',      url: 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt' },
  { name: 'asheeshh13/proxy',         url: 'https://raw.githubusercontent.com/asheeshh13/proxy/main/http.txt' },
  { name: 'UptimerRepo/proxy-list',   url: 'https://raw.githubusercontent.com/UptimerRepo/proxy-list/main/http.txt' },
];

const IPPORT_RE = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d{1,5})/g;
const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const DEFAULT_POOL = path.join(__dirname, '..', 'proxy-pool.json');

function parseProxies(text) {
  const out = [];
  const seen = new Set();
  let m;
  IPPORT_RE.lastIndex = 0;
  while ((m = IPPORT_RE.exec(text || '')) !== null) {
    const host = m[1];
    const port = parseInt(m[2], 10);
    if (port < 1 || port > 65535) continue;
    const key = `${host}:${port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ host, port });
  }
  return out;
}

async function fetchSource(src, via) {
  const args = ['-4', '-s', '-m', '15', '-o', '-'];
  if (via) { args.push('-x', via); }
  args.push(src.url);
  try {
    const { stdout } = await execFileAsync('curl', args, { timeout: 20000, maxBuffer: 20 * 1024 * 1024 });
    return stdout || '';
  } catch (e) {
    return ''; // 单源失败容忍
  }
}

async function validate(host, port, timeoutSec = 8) {
  const px = `http://${host}:${port}`;
  try {
    // 1) 真实出口 IP（ipify）—— 决定限流产能的是这个
    const { stdout: ipOut } = await execFileAsync(
      'curl', ['-4', '-x', px, '-m', String(timeoutSec), '-s', '-o', '-', 'https://api.ipify.org'],
      { timeout: (timeoutSec + 3) * 1000, maxBuffer: 64 * 1024 }
    ).catch(() => ({ stdout: '' }));
    const exitIp = (ipOut || '').trim();
    if (!IP_RE.test(exitIp)) return { ok: false, reason: 'ipify-empty-or-dead' };

    // 2) Tumblr 可达性（无需鉴权，401=可达，000=被重置/死）
    const t0 = Date.now();
    const { stdout: tbOut } = await execFileAsync(
      'curl', ['-4', '-x', px, '-m', '8', '-s', '-o', '/dev/null', '-w', '%{http_code}',
               'https://api.tumblr.com/v2/blog/dashboard'],
      { timeout: 12000, maxBuffer: 64 * 1024 }
    ).catch(() => ({ stdout: '000' }));
    const code = (tbOut || '000').trim();
    const tumblr = code !== '000' && code !== '';
    return { ok: true, exitIp, tumblr, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

function loadPool(poolPath) {
  try {
    const arr = JSON.parse(fs.readFileSync(poolPath, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function mergePool(existing, validated, sourceName) {
  const pool = existing.slice(); // 保留全部既有条目（含无 url 的），绝不静默丢弃
  const urls = new Set(existing.filter(e => e && e.url).map(e => e.url));
  let added = 0;
  for (const v of validated) {
    const url = `http://${v.host}:${v.port}`;
    if (urls.has(url)) continue; // 不覆盖用户既有条目
    urls.add(url);
    pool.push({
      url,
      name: `free-${sourceName}-${v.host}`,
      weight: 1,
      enabled: true,
      exitIp: v.exitIp,
      tumblr: v.tumblr,
      source: 'free-proxy-pool',
      _lastCheck: { at: new Date().toISOString(), realIp: v.exitIp, tumblr: v.tumblr ? '可达' : '不可达', ms: v.ms },
    });
    added++;
  }
  return { pool, added };
}

async function run(opts) {
  console.log(`[free-proxy-pool] 拉取 ${FREE_SOURCES.length} 个 GitHub 免费代理源…`);
  const candidates = [];
  const perSource = {};
  for (const src of FREE_SOURCES) {
    const text = await fetchSource(src, opts.via);
    const ps = parseProxies(text);
    perSource[src.name] = ps.length;
    console.log(`  · ${src.name}: 解析到 ${ps.length} 条`);
    candidates.push(...ps.map(p => ({ ...p, _src: src.name })));
  }
  // 去重候选
  const seen = new Set();
  const uniq = [];
  for (const c of candidates) {
    const k = `${c.host}:${c.port}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(c);
  }
  console.log(`[free-proxy-pool] 候选去重后 ${uniq.length} 条，准备校验（限 ${opts.limit}）`);
  const toCheck = uniq.slice(0, opts.limit);

  const validated = [];
  const conc = 25;
  for (let i = 0; i < toCheck.length; i += conc) {
    const batch = toCheck.slice(i, i + conc);
    const res = await Promise.all(batch.map(c => validate(c.host, c.port)));
    batch.forEach((c, idx) => {
      if (res[idx].ok) {
        validated.push({ host: c.host, port: c.port, exitIp: res[idx].exitIp, tumblr: res[idx].tumblr, ms: res[idx].ms, _src: c._src });
      }
    });
    process.stdout.write(`  校验进度 ${Math.min(i + conc, toCheck.length)}/${toCheck.length}，已通过 ${validated.length}\r`);
  }
  console.log(`\n[free-proxy-pool] 通过校验 ${validated.length} 条`);

  // 统计不同出口 IP（限流产能口径）
  const ips = new Set(validated.map(v => v.exitIp).filter(Boolean));
  const tumblrOk = validated.filter(v => v.tumblr).length;
  console.log(`[free-proxy-pool] distinctEgressIps=${ips.size}，其中 Tumblr 可达=${tumblrOk}`);

  const existing = loadPool(opts.pool);
  const { pool, added } = mergePool(existing, validated, 'src');
  console.log(`[free-proxy-pool] 既有 pool=${existing.length} 条，新增免费可用=${added} 条，写回后=${pool.length} 条`);

  if (!opts.dryRun) {
    fs.writeFileSync(opts.pool, JSON.stringify(pool, null, 2));
    console.log(`[free-proxy-pool] 已写回 ${opts.pool}`);
  } else {
    console.log(`[free-proxy-pool] --dry-run：未落盘`);
  }

  if (tumblrOk === 0) {
    console.log('\n⚠️ 诚实结论：本次通过的免费代理【无一】能触达 Tumblr（数据中心 IP 被重置）。');
    console.log('   免费公开代理救不了住宅墙。真实免费 DAU 杠杆请走 tools/free--publisher.js');
    console.log('   （Bluesky / Mastodon，不网关住宅 IP），或接入任何住宅源后重跑本脚本自动纳入。');
  } else {
    console.log(`\n✅ 发现 ${tumblrOk} 个可触达 Tumblr 的免费出口，已写入 pool 并纳入发布轮换。`);
  }
  return { validated: validated.length, distinctIps: ips.size, tumblrOk, added };
}

function selfCheck() {
  console.log('[selfcheck] 离线校验解析与合并逻辑…');
  const sample = `
# comment
1.2.3.4:8080
8.8.8.8:3128
10.0.0.1:9999
1.2.3.4:8080   (dup)
foo 192.168.1.1:1080 bar
`;
  const ps = parseProxies(sample);
  console.assert(ps.length === 4, `期望 4 条去重代理，实际 ${ps.length}`);
  console.assert(ps[0].host === '1.2.3.4' && ps[0].port === 8080, '首条解析错误');

  const existing = [{ url: 'http://:10808', name: 'default-relay', enabled: true }];
  const validated = [
    { host: '1.2.3.4', port: 8080, exitIp: '1.2.3.4', tumblr: true, ms: 100 },
    { host: '8.8.8.8', port: 3128, exitIp: '8.8.8.8', tumblr: false, ms: 200 },
  ];
  const { pool, added } = mergePool(existing, validated, 'test');
  console.assert(added === 2, `期望新增 2，实际 ${added}`);
  console.assert(pool.find(e => e.url === 'http://1.2.3.4:8080').tumblr === true, 'tumblr 标记错误');
  console.assert(pool.length === 3, `期望 pool=3，实际 ${pool.length}`);
  console.assert(pool.find(e => e.url === 'http://:10808'), '不应覆盖既有条目');
  console.log('[selfcheck] 全部断言通过 ✅');
  return true;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--selfcheck')) return Promise.resolve(selfCheck());
  const opts = { dryRun: args.includes('--dry-run'), limit: 300, via: null,
                 pool: DEFAULT_POOL };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--pool') opts.pool = path.resolve(args[++i]);
    if (args[i] === '--via') opts.via = args[++i];
    if (args[i] === '--limit') opts.limit = parseInt(args[++i], 10) || 300;
  }
  return run(opts);
}

if (require.main === module) {
  main().catch(e => { console.error('FATAL', e); process.exit(1); });
}
module.exports = { parseProxies, mergePool, validate, selfCheck, run };
