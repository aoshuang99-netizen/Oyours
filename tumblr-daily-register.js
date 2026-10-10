'use strict';
/**
 * tumblr-daily-register.js — 每日新增注册 N 个 Tumblr 账号并入养号（供计划任务/自动化调用）
 *
 * 链路：
 *   Windows 计划任务 MSCMS_TumblrDailyRegister（每日 03:00）
 *     → _daily_register.bat
 *       → 本脚本
 *         → tumblr-onboard-shardx.js（ShardX 真实指纹浏览器注册 + OAuth 授权 + 写 accounts.json）
 *           → POST http://127.0.0.1:3005/api/reload（让养号引擎感知新账号）
 *
 * 【2026-09-11 改造】
 *   1. 注册器由 `tumblr-onboard.js`（无头 chromium.launch，被 Tumblr blackbox 判 bot，
 *      /api/v2/user/validate 恒 400 → 实测恒 0/10）切换为 `tumblr-onboard-shardx.js`
 *      （ShardX Launcher 真实指纹引擎 + connectOverCDP）。
 *   2. **ShardX 前置自检**（三重，任一不过 → 直接 STOPPED，不 spawn 注册器）：
 *      a. Launcher 存活：`GET /health`（唯一免认证端点）
 *      b. **认证有效性**：`GET /running` 带 Bearer —— 光看 /health 会在 token 过期时误判为"就绪"，
 *         然后白白跑一轮全 401。
 *      c. **JWT 自动续签**：ShardX 无 token 铸造端点，JWT 是 HS256 用本地
 *         `settings.json.api_secret` 自签、payload 必须含 `sub:"automation"`。
 *         本地过期即自动重签写回 `_shardx_token.txt`（原 token 2026-08-31 已过期，是隐藏的第三个断点）。
 *   3. node 可执行文件改为**自动探测**（原硬编码 versions/22.22.2 已失效）。
 *   4. 退出码真实化：0=正常 / 1=崩溃 / 2=环境未就绪主动停止（原来是假绿 0）。
 *   5. 每次执行写 `_daily_register_report_<本地日期>.md`（用本地日期，避免凌晨 03:00 跑时 UTC 跨天覆盖）。
 *
 * 用法（自动化/手动）：
 *   node tumblr-daily-register.js
 *   DAILY_COUNT=3 node tumblr-daily-register.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { logFile } = require('./storage-paths.js');

const WS = 'C:/Users/AS/WorkBuddy/2026-06-13-19-42-19';
const NODE_PATH = path.join(WS, 'node_modules');
const LOG = logFile('_onboard_daily.log');            // 日志落 D 盘（C 盘已满，禁止新增 C 盘写入）
const COUNT = parseInt(process.env.DAILY_COUNT || '10', 10);

const ONBOARD = 'tumblr-onboard-shardx.js';           // 指纹版注册器
const SHX_API_PORT = process.env.SHARDX_API_PORT || '40325';
const SHX_TOKEN_FILE = path.join(WS, '_shardx_token.txt');
const SHX_SETTINGS = process.env.SHARDX_SETTINGS
  || 'C:/Users/AS/AppData/Roaming/shardx-launcher/settings.json';

// 本地日期（不能用 toISOString：计划任务在本地 03:00 跑 = UTC 前一天 19:00，
// 用 UTC 会让相邻两天的报告互相覆盖）
function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const REPORT = path.join(WS, `_daily_register_report_${localDate()}.md`);

// ── node 自动探测：优先带后缀的真身，其次版本号最大的 ──
function resolveNode() {
  const base = 'C:/Users/AS/.workbuddy/binaries/node/versions';
  if (process.env.MSCMS_NODE_EXE && fs.existsSync(process.env.MSCMS_NODE_EXE)) return process.env.MSCMS_NODE_EXE;
  let dirs = [];
  try { dirs = fs.readdirSync(base).filter((d) => !d.includes('installing') && !d.includes('temp')); } catch (_) {}
  const cands = dirs
    .filter((d) => fs.existsSync(path.join(base, d, 'node.exe')))
    .sort((a, b) => {
      const ap = a.includes('-') ? 1 : 0, bp = b.includes('-') ? 1 : 0;   // 带 -N 真身优先
      if (ap !== bp) return bp - ap;
      return b.localeCompare(a, undefined, { numeric: true });
    });
  return cands.length ? path.join(base, cands[0], 'node.exe').replace(/\//g, '\\') : null;
}

const NODE = resolveNode();

function log(m) { const l = `[${new Date().toISOString()}] ${m}`; try { fs.appendFileSync(LOG, l + '\n'); } catch (_) {} console.log(l); }

/** 极简 http（显式 http.request，绕开 HTTP_PROXY 环境变量，避免 localhost 被代理） */
function req(method, urlStr, headers, body, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return resolve({ status: 0, body: 'bad url: ' + e.message, error: true }); }
    const payload = body == null ? null : JSON.stringify(body);
    const r = http.request({
      host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method,
      headers: Object.assign({}, headers || {},
        payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
    }, (res) => {
      let b = ''; res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    r.on('error', (e) => resolve({ status: 0, body: e.message, error: true }));
    r.setTimeout(timeoutMs || 10000, () => { r.destroy(); resolve({ status: 0, body: 'timeout(' + (timeoutMs || 10000) + 'ms)', error: true }); });
    if (payload) r.write(payload);
    r.end();
  });
}

// ── ShardX JWT：本地自签（无铸造端点）─────────────────────────
function b64u(b) { return Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

function jwtPayload(tok) {
  try {
    const p = String(tok || '').split('.')[1];
    if (!p) return null;
    return JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch (_) { return null; }
}

function shardxSecret() {
  try { const s = JSON.parse(fs.readFileSync(SHX_SETTINGS, 'utf8')); return String(s.api_secret || '') || null; } catch (_) { return null; }
}

/** HS256 JWT；payload 必须含 sub:"automation"（只带 iat/exp 会 401） */
function mintShardXToken(secret, ttlSec) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ sub: 'automation', iat: now, exp: now + (ttlSec || 30 * 24 * 3600) }));
  const data = head + '.' + body;
  return data + '.' + b64u(crypto.createHmac('sha256', secret).update(data).digest());
}

/** 返回 { token, note }；token 过期/缺失则自动重签并写回 */
function ensureToken() {
  let cur = '';
  try { cur = fs.readFileSync(SHX_TOKEN_FILE, 'utf8').trim(); } catch (_) {}
  const pl = cur ? jwtPayload(cur) : null;
  const now = Math.floor(Date.now() / 1000);
  if (pl && pl.sub === 'automation' && pl.exp && pl.exp > now + 3600) {
    return { token: cur, note: `本地 JWT 有效至 ${new Date(pl.exp * 1000).toISOString()}` };
  }
  const secret = shardxSecret();
  if (!secret) {
    return { token: cur, note: pl
      ? `本地 JWT 已过期（${new Date(pl.exp * 1000).toISOString()}）且读不到 api_secret，无法自签`
      : '本地 JWT 缺失且读不到 api_secret，无法自签' };
  }
  const fresh = mintShardXToken(secret);
  try {
    if (cur) { try { fs.writeFileSync(SHX_TOKEN_FILE + '.expired.bak', cur, 'utf8'); } catch (_) {} }
    fs.writeFileSync(SHX_TOKEN_FILE, fresh, 'utf8');
    return { token: fresh, note: `已用本地 api_secret 自签新 JWT（30 天）${pl ? '，旧 token 过期于 ' + new Date(pl.exp * 1000).toISOString() : ''}` };
  } catch (e) {
    return { token: fresh, note: '已自签新 JWT 但写回失败: ' + e.message };
  }
}

/** ShardX 三重前置自检 */
async function checkShardX() {
  const tk = ensureToken();

  const h = await req('GET', `http://127.0.0.1:${SHX_API_PORT}/health`, null, null, 8000);
  if (h.error) {
    return { ok: false, why: `ShardX Launcher API :${SHX_API_PORT} 不可达（${h.body}）`, tokenNote: tk.note };
  }
  if (h.status !== 200) {
    return { ok: false, why: `ShardX /health 返回 HTTP ${h.status} ${String(h.body).slice(0, 120)}`, tokenNote: tk.note };
  }
  let info = {}; try { info = JSON.parse(h.body); } catch (_) {}

  // /health 免认证，必须再打一个带认证的端点才能确认 token 真的可用
  const r = await req('GET', `http://127.0.0.1:${SHX_API_PORT}/running`, { Authorization: 'Bearer ' + tk.token }, null, 12000);
  if (r.status === 401 || r.status === 403) {
    return { ok: false, why: `Launcher 已启动但 token 认证失败（HTTP ${r.status}）—— 需核对 settings.json 的 api_secret`, tokenNote: tk.note, info };
  }
  if (r.error || r.status !== 200) {
    return { ok: false, why: `/running 异常：${r.error ? r.body : 'HTTP ' + r.status}`, tokenNote: tk.note, info };
  }
  let running = []; try { const j = JSON.parse(r.body); running = Array.isArray(j) ? j : (j.items || []); } catch (_) {}
  return {
    ok: true,
    why: `${info.name || 'ShardX'} v${info.version || '?'} 认证通过 · running profiles=${running.length}`,
    tokenNote: tk.note, info,
  };
}

function postReload() {
  return req('POST', `http://127.0.0.1:${parseInt(process.env.TUMBLR_NURTURE_PORT || '3005', 10)}/api/reload`, null, {}, 15000)
    .then((r) => log('RELOAD resp: ' + String(r.body).slice(0, 220)));
}

function writeReport(status, rows, tailText) {
  const t = new Date();
  const md = [
    `# Tumblr 每日注册 — 执行报告（${localDate()}）`,
    '',
    `## 结论：${status}`,
    '',
    '| 项 | 值 |',
    '|---|---|',
    ...rows.map(([k, v]) => `| ${k} | ${v} |`),
    '',
    tailText ? '```\n' + String(tailText).slice(-3000) + '\n```\n' : '',
    `> 由 \`tumblr-daily-register.js\` 于 ${t.toISOString()} 自动生成。零假数据：未执行的步骤不做任何成功声称。`,
    '',
  ].join('\n');
  try { fs.writeFileSync(REPORT, md, 'utf8'); log('报告已写入 ' + path.basename(REPORT)); } catch (e) { log('报告写入失败: ' + e.message); }
}

(async () => {
  log(`=== daily register start (count=${COUNT}, reg=${ONBOARD}) ===`);

  if (!NODE) {
    const why = '未找到可用的 node.exe（versions/*/node.exe 全缺失）';
    log('STOPPED: ' + why);
    writeReport('STOPPED（node 缺失）', [['计划注册数', COUNT], ['实际尝试', 0], ['成功', 0], ['失败', 0], ['阻塞原因', why]]);
    return process.exit(2);
  }
  log('node = ' + NODE);

  const shx = await checkShardX();
  if (shx.tokenNote) log('token: ' + shx.tokenNote);

  if (!shx.ok) {
    log('STOPPED: ShardX 未就绪 → ' + shx.why + '（按"不盲目重试"条款，不启动注册器）');
    writeReport('STOPPED（ShardX 指纹环境未就绪）', [
      ['计划注册数', COUNT], ['实际尝试', 0], ['成功', 0], ['失败', 0],
      ['阻塞原因', shx.why],
      ['token', shx.tokenNote || '-'],
      ['node', NODE],
      ['恢复前提', `在 D:\\ShardX 启动 ShardX-Launcher-portable-win-x64.exe（Automation API :${SHX_API_PORT}）后，本链路下次自动继续，无需再改代码`],
    ]);
    return process.exit(2);
  }

  log('ShardX 就绪: ' + shx.why + ' → 启动注册器 ' + ONBOARD);
  const child = spawn(NODE, [ONBOARD, String(COUNT)], {
    cwd: WS,
    env: Object.assign({}, process.env, { TUMBLR_PROXY: 'http://127.0.0.1:10808', NODE_PATH }),
  });

  let tail = [];
  const keep = (d) => {
    try { fs.appendFileSync(LOG, d); } catch (_) {}
    tail.push(d.toString());
    if (tail.length > 500) tail = tail.slice(-500);
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);

  const startedAt = Date.now();
  child.on('close', async (code) => {
    const mins = ((Date.now() - startedAt) / 60000).toFixed(1);
    const text = tail.join('');
    const dm = text.match(/完成：成功 (\d+)\/(\d+)/);
    const okN = dm ? Number(dm[1]) : null;
    const totN = dm ? Number(dm[2]) : COUNT;
    log(`onboard exited code=${code} 耗时 ${mins} 分钟；成功 ${okN === null ? '(未解析)' : okN + '/' + totN}`);

    await postReload();

    const summary = text.split('\n').filter((l) => /✅|❌/.test(l)).slice(-40).join('\n');
    writeReport(
      dm ? (okN > 0 ? 'DONE' : 'FAILED（0 成功）') : `UNKNOWN（未解析到结果，exit=${code}）`,
      [
        ['计划注册数', COUNT], ['实际尝试', totN], ['成功', okN === null ? '(未解析)' : okN],
        ['失败', okN === null ? '(未解析)' : totN - okN],
        ['耗时', mins + ' 分钟'], ['退出码', code],
        ['ShardX', shx.why], ['token', shx.tokenNote || '-'], ['注册器', ONBOARD],
      ],
      summary,
    );
    log('=== daily register done ===');
    process.exit(0);
  });

  child.on('error', async (e) => {
    log('spawn err: ' + e.message);
    await postReload();
    writeReport('FAILED（注册器无法启动）', [['计划注册数', COUNT], ['实际尝试', 0], ['成功', 0], ['失败', 0], ['错误', e.message], ['注册器', ONBOARD]]);
    process.exit(1);
  });
})().catch((e) => { log('FATAL: ' + e.message); process.exit(1); });
