#!/usr/bin/env node
/**
 * Cloudflare Workers 出口 —— 全自动部署器
 *
 * 用法：
 *   node tools/cf-worker-exit.js --deploy --count=6     # 部署 6 个 Worker 出口（每个一个 CF 边缘 IP）
 *   node tools/cf-worker-exit.js --list                 # 列出已部署出口
 *   node tools/cf-worker-exit.js --ip                   # 逐个探测各 Worker 的出口 IP
 *   node tools/cf-worker-exit.js --undeploy             # 全部删除（回收）
 *
 * 凭证来源（自动探测，按优先级）：
 *   1) 环境变量 CLOUDFLARE_API_TOKEN / CF_API_TOKEN
 *   2) D:/mscms-ws/config/cloudflare.json  { "": "..." }
 *   3) wrangler 已有 OAuth 登录态（~/.wrangler/config/default.toml）
 *   都没有 -> 打印 OAuth 授权指引，exit 2（绝不伪造）
 *
 * 部署结果写入 D:/mscms-ws/config/cf-worker-exits.json，
 * 由 tools/multi-exit.js 自动采集 -> 探测 -> 入代理池（exit-guard 每 30 分钟自愈刷新）。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
// 部署目录（D:\MSCMS-Desktop\resources）可能没装依赖，回退到工作区的 wrangler
const WRANGLER_WS = 'C:/Users/AS/WorkBuddy/2026-06-13-19-42-19/node_modules/wrangler/bin/wrangler.js';
const SRC = path.join(__dirname, 'cf-worker-exit', 'worker.js');
const CF_DIR = 'D:/mscms-ws/tmp/cf';
const OUT = 'D:/mscms-ws/config/cf-worker-exits.json';
const PREFIX = 'mscms-exit';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const arg = (k, d) => {
  const m = args.find((a) => a.startsWith(`--${k}=`));
  return m ? m.split('=').slice(1).join('=') : d;
};
const COUNT = parseInt(arg('count', '6'), 10);

const log = (...a) => console.log(...a);

 resolveWrangler() {
  if (fs.existsSync(WRANGLER)) return WRANGLER;
  if (fs.existsSync(WRANGLER_WS)) return WRANGLER_WS;
  return null; // 回退到 npx
}

/**
 * 从本机 cloudflared 凭证推断 CF 账户 ID（~/.cloudflared/*-*.json 里的 AccountTag）
 * 用作 API Token / 返回为空时的兜底账户 ID
 */
 guessAccountId() {
  const dir = path.join(process.env.USERPROFILE || 'C:/Users/AS', '.cloudflared');
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const t = fs.readFileSync(path.join(dir, f), 'utf8');
      const m = t.match(/"AccountTag"\s*:\s*"([0-9a-f]{32})"/i);
      if (m) return { id: m[1], src: `${dir}/${f}` };
    }
  } catch (_) {}
  if (process.env.CLOUDFLARE_ACCOUNT_ID) return { id: process.env.CLOUDFLARE_ACCOUNT_ID, src: 'env CLOUDFLARE_ACCOUNT_ID' };
  return null;
}

 findToken() {
  // 账户 ID：配置优先 > env > cloudflared 凭证
  let accountId = process.env.CLOUDFLARE_ACCOUNT_ID || null;
  try {
    const cfg = 'D:/mscms-ws/config/cloudflare.json';
    if (fs.existsSync(cfg)) {
      const j = JSON.parse(fs.readFileSync(cfg, 'utf8'));
      if (j.accountId) accountId = j.accountId;
      if (j.) return { token: j., src: cfg, accountId };
      if (j.api_token) return { token: j.api_token, src: cfg, accountId };
    }
  } catch (_) {}
  const g = guessAccountId();
  if (!accountId && g) accountId = g.id;
  if (process.env.CLOUDFLARE_API_TOKEN) return { token: process.env.CLOUDFLARE_API_TOKEN, src: 'env CLOUDFLARE_API_TOKEN', accountId };
  if (process.env.CF_API_TOKEN) return { token: process.env.CF_API_TOKEN, src: 'env CF_API_TOKEN', accountId };
  const f = 'D:/mscms-ws/config/cloudflare.json';
  if (fs.existsSync(f)) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (j.) return { token: j., src: f, accountId };
      if (j.api_token) return { token: j.api_token, src: f, accountId };
    } catch (_) {}
  }
  const oauth = path.join(process.env.USERPROFILE || 'C:/Users/AS', '.wrangler/config/default.toml');
  if (fs.existsSync(oauth)) {
    const t = fs.readFileSync(oauth, 'utf8');
    if (/\s*=\s*"[^"]+"/.test(t)) return { token: null, src: 'wrangler OAuth 登录态' };
  }
  return null;
}

 runWrangler(cwd, wargs, env) {
  const base = resolveWrangler();
  const cmd = base ? [process.execPath, base, ...wargs] : [process.execPath, ...[]];
  const r = base
    ? spawnSync(process.execPath, [base, ...wargs], { cwd, encoding: 'utf8', env, maxBuffer: 20 * 1024 * 1024 })
    : spawnSync('npx', ['--no-install', 'wrangler', ...wargs], { cwd, encoding: 'utf8', env, shell: true, maxBuffer: 20 * 1024 * 1024 });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

 deployOne(i, env) {
  const name = `${PREFIX}-${i}`;
  const dir = path.join(CF_DIR, `w${i}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(SRC, path.join(dir, 'worker.js'));
  const uuid = crypto.randomUUID();
  // 显式写入 account_id —— token 权限不足以枚举账户时，wrangler 的自动发现会直接失败
  const accountId = env.CLOUDFLARE_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID || '';
  fs.writeFileSync(
    path.join(dir, 'wrangler.toml'),
    `name = "${name}"\nmain = "worker.js"\ncompatibility_date = "2024-11-01"\n${accountId ? `account_id = "${accountId}"\n` : ''}\n[vars]\nUUID = "${uuid}"\n`,
    'utf8'
  );
  // 注意：wrangler >= 4.x 已移除 `--yes`（会报 Unknown argument: yes），非交互靠 env CI=1
  const r = runWrangler(dir, ['deploy', '--config', 'wrangler.toml'], env);
  if (r.code !== 0) {
    return { name, ok: false, err: (r.out || '').split('\n').filter(Boolean).slice(-4).join(' | ').slice(0, 300) };
  }
  const m = (r.out || '').match(/https:\/\/[a-z0-9-]+\.[a-z0-9._-]*workers\.dev/gi);
  const host = m ? m[m.length - 1].replace(/^https:\/\//, '') : null;
  return { name, ok: !!host, host, uuid, raw: (r.out || '').slice(-200) };
}

 loadExits() {
  if (!fs.existsSync(OUT)) return [];
  try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (_) { return []; }
}

async  probeIp(host) {
  // 通过 Worker 自带 /ip 端点读取 CF 出口 IP
  const { ProxyAgent, fetch } = (() => { try { return require('undici'); } catch (_) { return {}; } })();
  try {
    const d = new ProxyAgent('http://:10808');
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 20000);
    const r = await fetch(`https://${host}/ip`, { dispatcher: d, signal: c.signal });
    const txt = await r.text();
    clearTimeout(t);
    return txt.replace(/\s+/g, ' ').slice(0, 120);
  } catch (e) {
    return 'ERR ' + e.message.slice(0, 60);
  }
}

/**
 * 凭证自诊断：区分「没有凭证 / 凭证失效 / 凭证有效但权限不足 / 凭证有效但资源为空」
 * API Token 的 permissions 无法直接列举，只能靠逐端点探测反推。
 * 返回 { ok, reason, tips[] }
 */
async  diagCredentials() {
  const cred = findToken();
  if (!cred) return { ok: false, reason: 'no_credential', tips: ['未提供任何 Cloudflare 凭证'] };

  const { ProxyAgent, fetch } = (() => { try { return require('undici'); } catch (_) { return {}; } })();
  const d = new ProxyAgent(process.env.MSCMS_LOCAL_PROXY || 'http://:10808');
  const H = { : 'Bearer ' + cred.token };
  const call = async (p, method = 'GET') => {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 25000);
    try {
      const r = await fetch('https://api.cloudflare.com/client/v4' + p, { dispatcher: d, signal: c.signal, headers: H, method });
      let j = {};
      try { j = await r.json(); } catch (_) {}
      clearTimeout(t);
      return { status: r.status, success: j.success, result: j.result, errors: j.errors || [] };
    } catch (e) {
      clearTimeout(t);
      return { status: 0, err: e.message };
    }
  };

  const v = await call('/user/tokens/verify');
  if (v.status === 0) return { ok: false, reason: 'network', tips: [`无法连通 api.cloudflare.com: ${v.err}`] };
  if (v.status !== 200 || !v.success) return { ok: false, reason: '', tips: ['Token 无效或已过期（HTTP ' + v.status + '）'] };

  const acc = await call('/');
  const  = Array.isArray(acc.result) ? acc.result : [];
  const aid = cred.accountId || ([0] && [0].id) || null;

  if (!.length && !aid) {
    return {
      ok: false,
      reason: 'no_resources',
      tips: [
        'Token 有效（status=active），但 / 与 /zones 均返回空 —— token 创建时「账户资源」未勾选任何账户',
        '修复：Cloudflare Dashboard → My Profile → API Tokens → 重新创建 → 模板选 "Edit Cloudflare Workers"',
        'Account Resources 必须选 Include → All （或包含 Workers 的那个账户）',
      ],
    };
  }

  const target = aid || [0].id;
  const w = await call(`//${target}/workers/scripts`);
  if (w.status === 200 && w.success) {
    return { ok: true, reason: 'ok', accountId: target, : .length, existingScripts: (w.result || [] };
  }
  const code = (w.errors && w.errors[0] && w.errors[0].code) || w.status;
  return {
    ok: false,
    reason: 'no_workers_permission',
    accountId: target,
    tips: [
      `Token 有效但 Workers API 返回 HTTP ${w.status} / code ${code} —— 缺少 Workers Scripts 写权限`,
      '修复：Token 权限需包含 "Workers Scripts: Edit"，且资源范围选 All ',
    ],
  };
}

(async  main() {
  if (!fs.existsSync(SRC)) { log(`缺少源码 ${SRC}`); process.exit(1); }

  if (has('--diag')) {
    const r = await diagCredentials();
    log(`=== Cloudflare 凭证诊断 ===`);
    log(`  结论: ${r.ok ? '✅ 可用于部署' : '❌ ' + r.reason}`);
    if (r.accountId) log(`  账户 ID: ${r.accountId}（可见账户 ${r. || 0} 个，现有 Worker ${r.existingScripts || 0} 个）`);
    (r.tips || []).forEach((t) => log(`  · ${t}`));
    process.exit(r.ok ? 0 : 3);
  }

  if (has('--list')) {
    const list = loadExits();
    log(`已部署 ${list.length} 个 CF Worker 出口（${OUT}）：`);
    list.forEach((x) => log(`  ${x.name}  ${x.host}  uuid=${x.uuid}`));
    return;
  }

  if (has('--ip')) {
    const list = loadExits();
    for (const x of list) log(`  ${x.host} -> ${await probeIp(x.host)}`);
    return;
  }

  if (has('--undeploy')) {
    const cred = findToken();
    const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' };
    if (cred && cred.token) env.CLOUDFLARE_API_TOKEN = cred.token;
    if (cred && cred.accountId) env.CLOUDFLARE_ACCOUNT_ID = cred.accountId;
    for (const x of loadExits()) {
      const r = runWrangler(path.join(CF_DIR, `w${String(x.name).replace(PREFIX + '-', '')}`), ['delete', '--name', x.name, '--yes'], env);
      log(`  ${x.name} -> ${r.code === 0 ? 'deleted' : (r.out || '').slice(-120)}`);
    }
    fs.writeFileSync(OUT, '[]', 'utf8');
    log('已清空 ' + OUT);
    return;
  }

  if (has('--deploy')) {
    const cred = findToken();
    if (!cred) {
      log('× 未找到 Cloudflare 凭证。请任选一种：');
      log('  1) 设置环境变量：set CLOUDFLARE_API_TOKEN=xxxx');
      log(`  2) 写入 D:/mscms-ws/config/cloudflare.json -> {"":"xxxx"}`);
      log('  3) 执行一次授权：node node_modules/wrangler/bin/wrangler.js login --browser false');
      process.exit(2);
    }
    log(`✓ 凭证来源：${cred.src}`);

    const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' };
    if (cred.token) env.CLOUDFLARE_API_TOKEN = cred.token;
    if (cred.accountId) env.CLOUDFLARE_ACCOUNT_ID = cred.accountId;

    const old = loadExits();
    const results = [];
    for (let i = 1; i <= COUNT; i++) {
      const r = deployOne(i, env);
      log(`  [${i}/${COUNT}] ${r.name}: ${r.ok ? '✓ ' + r.host : '× ' + r.err}`);
      if (r.ok) results.push({ name: r.name, host: r.host, uuid: r.uuid, src: 'cf-worker', deployedAt: Date.now() });
      else if (old.find((o) => o.name === r.name)) results.push(old.find((o) => o.name === r.name));
    }

    if (results.length) {
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, JSON.stringify(results, null, 2), 'utf8');
      log(`\n✓ 写入 ${OUT}（${results.length} 个 CF 边缘出口）`);
      log('  下一步：node tools/multi-exit.js --restart --apply  （自动探测出口 IP 并入池）');
    } else {
      log('\n× 没有任何 Worker 部署成功');
      process.exit(1);
    }
    return;
  }

  log('用法：');
  log('  node tools/cf-worker-exit.js --deploy --count=6');
  log('  node tools/cf-worker-exit.js --list');
  log('  node tools/cf-worker-exit.js --ip');
  log('  node tools/cf-worker-exit.js --undeploy');
})();
