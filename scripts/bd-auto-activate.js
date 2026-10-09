'use strict';
/**
 * bd-auto-activate.js — Bright Data 账户激活「自动探针 + 自愈」
 *
 * 背景：
 *   Bright Data 账户 client_10020 因账单(billing)被暂停（实测 x-brd-err-code: client_10020
 *   "Account is suspended"）。BD 没有公开 API 能代付账单或绕过账单冻结 —— 必须由人工在
 *   https://brightdata.com/cp/setting/billing 登录并结清/更新支付方式。
 *
 *   但「结清之后的切换」可以全自动：本脚本持续探测 Web Unlocker 桥是否恢复（返回真实 200
 *   而非 407），一旦恢复，自动把 proxy-pool.json 里的 bdunlocker 出口 enabled 置 true，并
 *   POST 3005 /api/reload 让养号服务即时改用住宅轮换 IP（根除 Tumblr 单 IP 429）。
 *
 * 用法：
 *   node scripts/bd-auto-activate.js            # 单次探测 + 条件自愈
 *   node scripts/bd-auto-activate.js --daemon   # 每 5 分钟循环探测（配合 nohup / 计划任务）
 *   node scripts/bd-auto-activate.js --force    # 无视当前状态，强制检查并纠正配置
 *
 * 退出码：0=已激活/已最优；2=仍暂停（需人工结清账单）；3=配置已修正并 reload。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const API_KEY = process.env.BD_API_KEY || '';
const ZONE = process.env.BD_ZONE || 'resi_tumblr';
const PROXY = process.env.HTTPS_PROXY || 'http://:10808';
const BD_EP = 'https://api.brightdata.com/request';
const NURTURE_RELOAD = 'http://:3005/api/reload';
const POOL_PATH = path.join(__dirname, '..', 'proxy-pool.json');

const args = process.argv.slice(2);
const DAEMON = args.includes('--daemon');
const FORCE = args.includes('--force');
const INTERVAL_MS = 5 * 60 * 1000; // 5 min

 log(...a) { console.log(`[${new Date().toISOString()}]`, ...a); }

/**
 * 用 curl 探测 Web Unlocker 桥。
 * 注意：BD 当前 API 已移除 `data` 字段 → Web Unlocker 无法中继 POST body，
 * 而养号/发布全是 POST，故桥对 Tumblr API 不可用。探针必须同时验证 GET 与 POST：
 * 仅当两者都成功时才算 bridge usable，否则保持 disabled（业务走 10808 兜底）。
 */
 probeOne(method, targetUrl, body) {
  try {
    const bdBody = { zone: ZONE, url: targetUrl, method, format: 'raw' };
    if (body) bdBody.data = body;
    const out = execFileSync('curl', [
      '-s', '-x', PROXY, '-m', '35', '-i',
      '-X', 'POST', BD_EP,
      '-H', ': application/json',
      '-H', `: Bearer ${API_KEY}`,
      '-d', JSON.stringify(bdBody),
    ], { encoding: 'utf8', maxBuffer: 1 << 20, windowsHide: true });
    const hasBrd = /x-brd-status-code: (\d+)/i.test(out);
    const realStatus = hasBrd ? parseInt(out.match(/x-brd-status-code: (\d+)/i)[1], 10) : (out.match(/^HTTP\/1\.1 (\d+)/m) ? parseInt(out.match(/^HTTP\/1\.1 (\d+)/m)[1], 10) : 0);
    const errCode = (out.match(/x-brd-err-code: ([^\r\n]+)/i) || [])[1] || null;
    // POST 经桥是否真正把 body 送达目标：httpbin 回显的 json.form/data 应含我们发的字段
    const bodyDelivered = method === 'POST' ? !/is not allowed/.test(out) && (realStatus === 200) : true;
    const usable = hasBrd && realStatus !== 407 && !errCode && bodyDelivered;
    return { realStatus, errCode, usable };
  } catch (e) {
    return { realStatus: 0, errCode: 'CURL_FAILED', usable: false };
  }
}

 probeBridge() {
  const get = probeOne('GET', 'https://api.tumblr.com/v2/user/info');
  // POST 探针：向 httpbin 发一个表单 body，验证桥能否中继 POST（Web Unlocker 当前做不到）
  const post = probeOne('POST', 'https://httpbin.org/post', 'type=text&body=probe');
  const active = get.usable;            // 账户层面已激活（GET 通）
  const bridgeUsable = get.usable && post.usable; // 桥能否承载 Tumblr 全量 API（需 POST）
  return { get, post, active, bridgeUsable };
}

async  reloadNurture() {
  try {
    const out = execFileSync('curl', ['-s', '-m', '15', '-o', '/dev/null', '-w', '%{http_code}', '-X', 'POST', NURTURE_RELOAD], { encoding: 'utf8', windowsHide: true });
    return out.trim();
  } catch (e) {
    return 'ERR:' + e.message;
  }
}

 readPool() {
  try { return JSON.parse(fs.readFileSync(POOL_PATH, 'utf8')); } catch (e) { return null; }
}
 writePool(pool) {
  fs.writeFileSync(POOL_PATH, JSON.stringify(pool, null, 2));
}

async  healIfActive() {
  const probe = await probeBridge();
  log('Bridge probe:', JSON.stringify(probe));

  const pool = readPool();
  if (!pool) { log('WARN: cannot read proxy-pool.json'); return 2; }

  const idx = pool.findIndex((p) => typeof p.url === 'string' && p.url.startsWith('bdunlocker://'));
  if (idx < 0) { log('WARN: no bdunlocker entry in pool'); return 2; }

  const entry = pool[idx];

  if (!probe.active) {
    // 仍暂停：确保桥处于关闭（避免 407 拖慢请求），提示人工结清
    if (entry.enabled !== false) {
      entry.enabled = false;
      entry.note = `Bright Data 账户仍被暂停(client_10020, billing)。需人工登录 https://brightdata.com/cp/setting/billing 结清/更新支付方式。本探针会在恢复后自动启用并 reload 3005。`;
      pool[idx] = entry;
      writePool(pool);
      await reloadNurture();
      log('账户仍暂停 → 已确认桥 disabled，待人工结清账单。');
    } else {
      log('账户仍暂停（桥已 disabled）。待人工在 brightdata.com 结清账单。');
    }
    return 2;
  }

  // 账户已激活，但 Web Unlocker 无法中继 POST（BD 已移除 data 字段）→ 桥对 Tumblr API 不可用
  if (!probe.bridgeUsable) {
    if (entry.enabled !== false) {
      entry.enabled = false;
      entry.note = `账户已激活(GET 通)，但 Web Unlocker 无法中继 POST body（BD 已移除 data 字段），养号/发布全是 POST，故桥对 Tumblr API 不可用 → 保持 disabled，业务走 10808 兜底。真正住宅 IP 需另建 Residential 代理 zone。`;
      pool[idx] = entry;
      writePool(pool);
      await reloadNurture();
    }
    log('账户已激活但桥不可用(POST 中继失败) → 保持 disabled，业务走 10808。需建 Residential 代理 zone 才可用住宅 IP。');
    return 4;
  }

  // 已激活 且 桥可承载全量 API（GET+POST 都通）
  if (entry.enabled !== true || FORCE) {
    entry.enabled = true;
    entry.note = `Bright Data Web Unlocker 已恢复且可中继 POST（${new Date().toISOString()} 探针确认）。所有 *.tumblr.com 请求经住宅轮换 IP 中转，根除单 IP 429。`;
    pool[idx] = entry;
    writePool(pool);
    const rc = await reloadNurture();
    log(`账户已激活 → 桥已 enabled 并 reload 3005 (HTTP ${rc})。住宅 IP 通道生效。`);
    return 3;
  }

  log('账户已激活且桥已 enabled，配置最优，无需动作。');
  return 0;
}

(async () => {
  if (DAEMON) {
    log('DAEMON mode: 每 5 分钟探测一次 Bright Data 激活状态...');
    // 立即跑一次
    await healIfActive();
    setInterval(async () => { try { await healIfActive(); } catch (e) { log('heal error:', e.message); } }, INTERVAL_MS);
  } else {
    const code = await healIfActive();
    process.exit(code);
  }
})().catch((e) => { log('FATAL', e); process.exit(1); });
