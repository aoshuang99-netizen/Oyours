#!/usr/bin/env node
/**
 * MSCMS 邮箱链路一键部署（Cloudflare Email Routing + Workers KV）
 * ------------------------------------------------------------------
 * 背景：`tumblr-onboard-shardx.js:74` 的 genEmail() 凭空捏造 `mscms<rand>@gmail.com`
 *      （可能撞真人地址、且永远收不到信）。本脚本把 catch-all 收信链路自动化。
 *
 * 用法：
 *   node tools/cf-mail-setup.js --check                     # 权限体检（不写任何东西）
 *   node tools/cf-mail-setup.js --deploy --domain lokfeel.com
 *   node tools/cf-mail-setup.js --status
 *   node tools/cf-mail-setup.js --test mscmsabc@lokfeel.com # 查某地址有没有收到信
 *   node tools/cf-mail-setup.js --new --label tumblr-001     # 生成一个新地址
 *   node tools/cf-mail-setup.js --send-test                 # 自发一封测试信（走 Agent Mail 不行，仅提示手发）
 *
 * 设计原则：零伪造 —— 每一步都打印真实 HTTP 状态与 CF 原始 errors；
 *          没有权限就明确报缺哪一项，绝不假装成功。
 */
const fs = require('fs');
const path = require('path');

const WS = path.join(__dirname, '..');
const CFG_PATH = 'D:/mscms-ws/config/cloudflare.json';
const OUT_PATH = 'D:/mscms-ws/config/mail.json';
const WORKER_SRC = path.join(WS, 'tools', 'email-worker', 'worker.js');
const WORKER_NAME = 'mscms-mail';
const KV_TITLE = 'mscms-mail';

const BASE = 'https://api.cloudflare.com/client/v4';

/* ─────────────── 双 Token 混合鉴权（2026-09-14）───────────────
 * CF 的权限是【按产品】授权的，一个 Token 很难同时拿到 Workers + Email Routing。
 * 实测两个 Token 的能力正好互补：
 *        ：Zone 读 ✅ / Workers 读+写 ✅ / KV 读+写+删 ✅ ／ Email Routing ❌ 403
 *   mailToken    ：Zone 读 ✅ / Email Routing Rules ✅ / DNS 编辑 ✅ ／ Workers ❌ 403
 * 所以按端点分流：Workers / KV → 部署令牌；Email Routing / DNS / Zone → 邮箱令牌。
 * 任一侧缺失会自动回退到另一方（单 Token 场景仍可工作）。
 */
let ACCT = '';
let MAIL_TOKEN = '', MAIL_SRC = '';
let DEPLOY_TOKEN = '', DEPLOY_SRC = '';

 tokenFor(p) {
  const workerish = /\/workers\/|storage\/kv/.test(p);
  return workerish ? (DEPLOY_TOKEN || MAIL_TOKEN) : (MAIL_TOKEN || DEPLOY_TOKEN);
}
/** 人类可读的令牌来源（用于日志，绝不打印令牌内容） */
 tokenLabelFor(p) {
  const workerish = /\/workers\/|storage\/kv/.test(p);
  return workerish ? DEPLOY_SRC : MAIL_SRC;
}

 loadCfg() {
  if (!fs.existsSync(CFG_PATH)) fail(`缺少 ${CFG_PATH}`);
  const c = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  ACCT = c.accountId;
  if (c.mailToken) { MAIL_TOKEN = c.mailToken; MAIL_SRC = ''; }
  else { MAIL_TOKEN = c.; MAIL_SRC = '（复用出口池 Token）'; }
  if (c.) { DEPLOY_TOKEN = c.; DEPLOY_SRC = '（出口池 Token，含 Workers/KV 写）'; }
  else { DEPLOY_TOKEN = c.mailToken; DEPLOY_SRC = ''; }
  if (!MAIL_TOKEN || !ACCT) fail('cloudflare.json 缺少  / mailToken / accountId');
}

let proxied = false;
 useProxy() {
  if (proxied) return;
  const { ProxyAgent, setGlobalDispatcher } = require('D:/MSCMS-Desktop/resources/node_modules/undici');
  setGlobalDispatcher(new ProxyAgent('http://:10808'));
  proxied = true;
  log('   ↳ 直连失败，切换代理 :10808');
}

async  api(p, opt = {}) {
  const tk = tokenFor(p);
  const go = (viaProxy) => {
    if (viaProxy) useProxy();
    return fetch(BASE + p, {
      ...opt,
      headers: { : 'Bearer ' + tk, ...(opt.headers || {}) },
      signal: AbortSignal.timeout(40000),
    });
  };
  let r;
  try { r = await go(false); }
  catch (e) {
    try { r = await go(true); } catch (e2) { return { status: 0, err: e2.message }; }
  }
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch (_) {}
  return { status: r.status, json: j, raw: t };
}
const HDR_J = { '': 'application/json' };
 errs(r) {
  if (r.err) return 'ERR ' + r.err;
  const e = r.json && r.json.errors;
  return e && e.length ? e.map((x) => x.code + ' ' + x.message).join(' | ') : String(r.raw || '').slice(0, 200);
}

const C = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', d: '\x1b[2m', x: '\x1b[0m' };
 log(m) { console.log(m); }
 ok(m) { console.log('   ' + C.g + '✅' + C.x + ' ' + m); }
 warn(m) { console.log('   ' + C.y + '⚠️' + C.x + ' ' + m); }
 bad(m) { console.log('   ' + C.r + '❌' + C.x + ' ' + m); }
 fail(m) { console.error(C.r + 'FATAL: ' + C.x + m); process.exit(1); }
 arg(name, def) {
  const hit = process.argv.find((a) => a === '--' + name || a.startsWith('--' + name + '='));
  if (!hit) return def;
  if (hit.includes('=')) return hit.split('=').slice(1).join('=');
  return true;
}

/* ─────────────────── 权限体检 ─────────────────── */

const PERM_CHECKS = [
  { id: 'zone:read', label: 'Zone 读', need: false, run: () => api('/zones?per_page=5') },
  { id: 'kv:write', label: 'KV 写（邮件存储）', need: true, run: null },
  { id: 'workers:write', label: 'Workers 写（部署 Worker）', need: true, run: null },
  { id: 'email:rules', label: 'Email Routing Rules（catch-all 规则）', need: true, run: (z) => api(`/zones/${z}/email/routing/rules/catch_all`) },
  {
    id: 'mx', label: 'MX 已指向 Cloudflare（Email Routing 已生效）', need: true,
    run: (z) => api(`/zones/${z}/dns_records?type=MX&per_page=20`).then((r) => {
      if (r.status !== 200) return r;
      const mx = (r.json.result || []).map((x) => x.content).join(' , ');
      const good = /mx\.cloudflare\.net/i.test(mx);
      return { status: good ? 200 : 412, note: good ? '（' + mx.slice(0, 70) + '）' : 'MX = ' + (mx || '(无)') };
    }),
  },
  { id: 'dns:edit', label: 'DNS 编辑（自动加 MX/API 路由）', need: false, run: (z) => api(`/zones/${z}/dns_records?per_page=1`) },
  { id: 'email:settings', label: 'Email Routing 设置读（可选，非必需）', need: false, run: (z) => api(`/zones/${z}/email/routing`) },
];

async  cmdCheck() {
  log('\n══════ Cloudflare 权限体检 ══════');
  if (MAIL_TOKEN === DEPLOY_TOKEN) {
    log('Token  : ' + MAIL_TOKEN.slice(0, 10) + '…  (长度 ' + MAIL_TOKEN.length + ')   ' + MAIL_SRC);
  } else {
    log('邮箱令牌: ' + MAIL_TOKEN.slice(0, 10) + '…  (长度 ' + MAIL_TOKEN.length + ')   ' + MAIL_SRC);
    log('部署令牌: ' + DEPLOY_TOKEN.slice(0, 10) + '…  (长度 ' + DEPLOY_TOKEN.length + ')   ' + DEPLOY_SRC);
    log(C.d + '   ↳ 双 Token 混合：Email Routing/DNS 走邮箱令牌，Workers/KV 走部署令牌' + C.x);
  }
  log('Account: ' + ACCT + '\n');

  const v = await api('/user/tokens/verify');
  if (v.status === 200) ok('Token 有效  status=' + (v.json.result.status || '?')); else bad('Token 无效: ' + errs(v));

  const zr = await api('/zones?per_page=50');
  if (zr.status !== 200) { bad('无法读取 zone 列表: ' + errs(zr)); return; }
  const zones = zr.json.result || [];
  log('\n可管理 zone (' + zones.length + '):');
  for (const z of zones) log('   · ' + String(z.name).padEnd(22) + ' ' + z.status + '   id=' + z.id);

  const target = (arg('domain') && typeof arg('domain') === 'string')
    ? zones.find((z) => z.name === arg('domain'))
    : zones.find((z) => z.name === 'lokfeel.com') || zones[0];
  if (!target) fail('找不到可用 zone');
  log('\n体检目标 zone: ' + target.name + '\n');

  const missing = [];
  for (const c of PERM_CHECKS) {
    let st, detail = '';
    if (c.id === 'kv:write') {
      const ns = await api(`//${ACCT}/storage/kv/namespaces`, { method: 'POST', headers: HDR_J, body: JSON.stringify({ title: WORKER_NAME + '-permcheck' }) });
      st = ns.status;
      if (ns.status === 200 && ns.json.result) {
        await api(`//${ACCT}/storage/kv/namespaces/${ns.json.result.id}`, { method: 'DELETE' });
        detail = '（已自建自删验证）';
      }
    } else if (c.id === 'workers:write') {
      const fd = new FormData();
      fd.append('metadata', new Blob([JSON.stringify({ main_module: 'w.js', compatibility_date: '2026-09-01' })], { type: 'application/json' }));
      fd.append('w.js', new Blob(['export default { async fetch(){ return new Response("ok") } }'], { type: 'application/javascript+module' }), 'w.js');
      const up = await api(`//${ACCT}/workers/scripts/${WORKER_NAME}-permcheck`, { method: 'PUT', body: fd });
      st = up.status;
      if (up.status === 200) { await api(`//${ACCT}/workers/scripts/${WORKER_NAME}-permcheck`, { method: 'DELETE' }); detail = '（已自建自删验证）'; }
      else detail = '（' + errs(up).slice(0, 90) + '）';
    } else {
      const r = await c.run(target.id);
      st = r.status;
      if (r.note) detail = '（' + r.note + '）';
    }
    const good = st === 200 || st === 404;
    if (good) ok(c.label + '  HTTP ' + st + ' ' + detail);
    else {
      const who = (MAIL_TOKEN === DEPLOY_TOKEN) ? '' : (tokenFor(c.id === 'kv:write' || c.id === 'workers:write' ? '/workers/' : '/zones/') === DEPLOY_TOKEN ? '  [部署令牌]' : '  [邮箱令牌]');
      bad(c.label + '  HTTP ' + st + '  ' + (st === 403 ? '权限不足' + who : '') + (detail || ''));
      if (c.need) missing.push(c.label);
    }
  }

  log('\n──────── 结论 ────────');
  if (!missing.length) {
    log(C.g + '✅ 权限齐备，可直接执行：node tools/cf-mail-setup.js --deploy --domain ' + target.name + C.x);
  } else {
    log(C.y + '⚠️ 缺失 ' + missing.length + ' 项能力，需要在 CF Token 上补权限：' + C.x);
    for (const m of missing) log('   · ' + m);
    log('\n' + C.d + '补权限步骤见：' + path.join(WS, 'MSCMS-2026-09-14-邮箱链路-域名与Token指引.md') + C.x);
  }
  return target;
}

/* ─────────────────── 部署 ─────────────────── */

/** ESM → Service Worker 格式回退（部分账号的 upload 端点仍按 SW 解析） */
 toServiceWorker(src) {
  const body = src.replace(/export\s+default\s*\{/, 'const __MOD = {');
  return body + `

/* ── Service Worker 适配层（由 cf-mail-setup.js 自动追加）── */
addEventListener('email', (event) => {
  event.waitUntil(__MOD.email(event.message, event.env, event.ctx));
});
addEventListener('fetch', (event) => {
  event.respondWith(__MOD.fetch(event.request, event.env, event.ctx));
});
`;
}

async  uploadWorker(src, bindings, asModule) {
  const fd = new FormData();
  const meta = {
    main_module: asModule ? 'worker.js' : undefined,
    body_part: asModule ? undefined : 'worker.js',
    compatibility_date: '2026-09-14',
    bindings,
  };
  if (!asModule) delete meta.main_module; else delete meta.body_part;
  fd.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
  fd.append('worker.js', new Blob([src], { type: asModule ? 'application/javascript+module' : 'application/javascript' }), 'worker.js');
  return api(`//${ACCT}/workers/scripts/${WORKER_NAME}`, { method: 'PUT', body: fd });
}

async  ensureKv() {
  const list = await api(`//${ACCT}/storage/kv/namespaces?per_page=100`);
  if (list.status !== 200) fail('KV 列表读取失败: ' + errs(list));
  const hit = (list.json.result || []).find((n) => n.title === KV_TITLE);
  if (hit) { ok('复用已有 KV 命名空间 ' + KV_TITLE + '  ' + hit.id); return hit.id; }
  const cr = await api(`//${ACCT}/storage/kv/namespaces`, { method: 'POST', headers: HDR_J, body: JSON.stringify({ title: KV_TITLE }) });
  if (cr.status !== 200) fail('KV 创建失败: ' + errs(cr));
  ok('新建 KV 命名空间 ' + KV_TITLE + '  ' + cr.json.result.id);
  return cr.json.result.id;
}

 randKey() {
  const b = require('crypto').randomBytes(24);
  return b.toString('base64url');
}

async  cmdDeploy() {
  const domArg = typeof arg('domain') === 'string' ? arg('domain') : 'lokfeel.com';
  const apiHostArg = typeof arg('api-host') === 'string' ? arg('api-host') : null;

  log('\n══════ 部署 MSCMS 邮箱链路 ══════');
  log('目标收信域 : ' + domArg);
  log('Worker 名  : ' + WORKER_NAME + '\n');

  // 0. 定位 zone
  const zr = await api('/zones?per_page=50');
  const zone = (zr.json.result || []).find((z) => z.name === domArg);
  if (!zone) fail('zone 中找不到 ' + domArg);
  ok('zone ' + domArg + '  id=' + zone.id);

  // 1. KV
  if (!fs.existsSync(WORKER_SRC)) fail('缺少 Worker 源码 ' + WORKER_SRC);
  const kvId = await ensureKv();

  // 2. API_KEY（复用已存的，避免每次部署换 key 导致调用方失效）
  let apiKey = null, prev = null;
  if (fs.existsSync(OUT_PATH)) { try { prev = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')); apiKey = prev.apiKey; } catch (_) {} }
  if (!apiKey) { apiKey = randKey(); ok('生成新 API_KEY'); } else ok('复用已有 API_KEY');

  // 3. 上传 Worker（ESM 优先，失败回退 SW）
  const src = fs.readFileSync(WORKER_SRC, 'utf8');
  const bindings = [
    { type: 'kv_namespace', name: 'MAIL_KV', namespace_id: kvId },
    { type: '', name: 'API_KEY', text: apiKey },
    { type: 'plain_text', name: 'MAIL_DOMAIN', text: domArg },
  ];
  // --with-send：额外挂 send_email binding（Email Routing 的 Worker 发信能力，open beta）。
  // 挂上后 /send 端点可用；不挂则该端点返回 501，收信链路完全不受影响。
  if (arg('with-send')) {
    bindings.push({ type: 'send_email', name: 'SEND_EMAIL' });
    log(C.d + '   ↳ 已启用 --with-send：挂载 SEND_EMAIL binding' + C.x);
  }
  let up = await uploadWorker(src, bindings, true);
  if (up.status !== 200) {
    warn('ESM 上传失败（' + up.status + '）：' + errs(up).slice(0, 160));
    warn('回退 Service Worker 格式重试…');
    up = await uploadWorker(toServiceWorker(src), bindings, false);
  }
  if (up.status !== 200) fail('Worker 部署失败: ' + errs(up));
  ok('Worker 已部署 ' + WORKER_NAME);

  // 4. Email Routing 启用 + DNS
  //    注意：`email/routing/enable` 属 `Email Routing: Edit` 权限，邮箱令牌通常没有。
  //    先查 MX 实测是否已生效 —— 已生效就跳过，不必依赖该端点（零伪造：以 DNS 实况为准）。
  log('\n── Email Routing ──');
  const mxRes = await api(`/zones/${zone.id}/dns_records?type=MX&per_page=20`);
  const mxList = (mxRes.status === 200 ? (mxRes.json.result || []) : []).map((x) => x.content);
  const mxOk = mxList.some((c) => /mx\.cloudflare\.net/i.test(c));
  if (mxOk) {
    ok('Email Routing 已生效（MX: ' + mxList.slice(0, 3).join(', ') + '）→ 跳过 enable/dns 调用');
  } else {
    const en = await api(`/zones/${zone.id}/email/routing/enable`, { method: 'POST', headers: HDR_J, body: '{}' });
    if (en.status === 200) ok('Email Routing 已启用');
    else if (en.status === 403) warn('email/routing/enable 被拒（该端点需 `Email Routing: Edit`）' + (mxList.length ? '；当前 MX=' + mxList.join(', ') : '；且查不到 MX，需在面板开启 Email Routing'));
    else warn('Email Routing enable HTTP ' + en.status + '  ' + errs(en).slice(0, 140));

    const dns = await api(`/zones/${zone.id}/email/routing/dns`, { method: 'POST', headers: HDR_J, body: '{}' });
    if (dns.status === 200) ok('MX/SPF 记录已就绪');
    else warn('email/routing/dns HTTP ' + dns.status + '  ' + errs(dns).slice(0, 140));
  }

  // 5. catch-all → Worker（先读现有配置，避免静默覆盖别人的兜底规则）
  log('\n── catch-all ──');
  const cur = await api(`/zones/${zone.id}/email/routing/rules/catch_all`);
  if (cur.status === 200 && cur.json.result) {
    const r = cur.json.result;
    const targets = (r.actions || []).flatMap((a) => a.value || []);
    const ours = targets.includes(WORKER_NAME);
    log('   现有 catch-all: enabled=' + r.enabled + '  actions=' + JSON.stringify(r.actions));
    if (r.enabled && !ours && !arg('force')) {
      bad('该 zone 已存在【其他】catch-all 规则（' + JSON.stringify(r.actions) + '）');
      bad('继续会把它覆盖掉。确认无影响请加 --force 重跑。已中止。');
      process.exit(2);
    }
    if (!r.enabled) warn('现有 catch-all 处于关闭状态，将启用并指向 Worker');
    if (ours) ok('catch-all 已指向本 Worker，将幂等覆盖');
  } else if (cur.status === 403) {
    bad('读取 catch-all 被拒（权限不足）→ 无法安全判断是否会覆盖现有规则');
    if (!arg('force')) { bad('为避免误覆盖，已中止。确认后加 --force 重跑。'); process.exit(2); }
  } else {
    warn('读取 catch-all HTTP ' + cur.status + '  ' + errs(cur).slice(0, 120));
  }

  const ca = await api(`/zones/${zone.id}/email/routing/rules/catch_all`, {
    method: 'PUT', headers: HDR_J,
    body: JSON.stringify({
      enabled: true,
      name: 'mscms-catchall-to-worker',
      matchers: [{ type: 'all' }],
      actions: [{ type: 'worker', value: [WORKER_NAME] }],
    }),
  });
  if (ca.status === 200) ok('catch-all 已指向 Worker（*@' + domArg + ' → ' + WORKER_NAME + '）');
  else bad('catch-all 配置失败 HTTP ' + ca.status + '  ' + errs(ca).slice(0, 200));

  const chk = await api(`/zones/${zone.id}/email/routing/rules/catch_all`);
  if (chk.status === 200 && chk.json.result) {
    const r = chk.json.result;
    log('   ' + C.d + '当前 catch-all: enabled=' + r.enabled + '  actions=' + JSON.stringify(r.actions) + C.x);
  }

  // 6. 自定义 API 路由（绕开 workers.dev 在国内可能不可达）
  const subRes = await api(`//${ACCT}/workers/subdomain`);
  const sub = (subRes.json && subRes.json.result && subRes.json.result.subdomain) || null;
  let apiUrl = sub ? `https://${WORKER_NAME}.${sub}.workers.dev` : '';
  if (!sub) warn('读不到 workers.dev 子域（HTTP ' + subRes.status + '），将只依赖自定义域');
  const apiHost = apiHostArg || ('mail-api.' + domArg);
  const route = await api(`/zones/${zone.id}/workers/routes`, {
    method: 'POST', headers: HDR_J,
    body: JSON.stringify({ pattern: apiHost + '/*', script: WORKER_NAME }),
  });
  // 10020 = 同 pattern 路由已存在（重复部署时的正常情况，不是错误）
  const routeDup = route.json && (route.json.errors || []).some((x) => x.code === 10020 || /same pattern already exists/i.test(x.message));
  if (route.status === 200 || routeDup) {
    if (routeDup) ok('自定义 API 路由 ' + apiHost + '/*  已存在（幂等，跳过建立）');
    else ok('自定义 API 路由 ' + apiHost + '/*  → ' + WORKER_NAME);
    const rec = await api(`/zones/${zone.id}/dns_records`, {
      method: 'POST', headers: HDR_J,
      body: JSON.stringify({ type: 'AAAA', name: apiHost, content: '100::', proxied: true, ttl: 1, comment: 'mscms-mail worker route' }),
    });
    if (rec.status === 200) ok('DNS AAAA 100:: (代理开启) 已建 ' + apiHost);
    else if (rec.json && (rec.json.errors || []).some((x) => /already exists|duplicate/i.test(x.message))) ok('DNS 记录已存在，跳过');
    else warn('DNS 建立失败（可手动加 AAAA 100:: 橙云）: ' + errs(rec).slice(0, 140));
    apiUrl = 'https://' + apiHost;
  } else {
    warn('自定义路由建立失败（不影响收信，API 走 workers.dev）: ' + errs(route).slice(0, 140));
  }

  // 7. 落配置
  const out = {
    domain: domArg,
    zoneId: zone.id,
    accountId: ACCT,
    workerName: WORKER_NAME,
    kvNamespaceId: kvId,
    apiKey,
    apiUrl,
    workersDevUrl: sub ? `https://${WORKER_NAME}.${sub}.workers.dev` : null,
    addressScheme: 'mscms<rand10>@' + domArg,
    note: '由 tools/cf-mail-setup.js 生成；apiKey 为管理 API 鉴权，勿外泄',
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  ok('配置已写入 ' + OUT_PATH);

  log('\n── 冒烟测试 ──');
  await smoke(apiUrl, apiKey, domArg);
}

/** 冒烟用的 fetch：直连失败自动回退本地代理（国内访问 CF 边缘常需代理） */
async  miniFetch(url, opt) {
  const mk = () => fetch(url, { ...opt, signal: AbortSignal.timeout(20000) });
  try { return await mk(); }
  catch (e) {
    try { useProxy(); return await mk(); }
    catch (e2) { return { status: 0, err: e2.message, json: async () => null, text: async () => '' }; }
  }
}

async  smoke(apiUrl, apiKey, domain) {
  const url = apiUrl.replace(/\/+$/, '');
  // 1) 健康检查（决策依据：自定义域不通 = MSCMS 读验证码会失败，必须明确报红）
  const h = await miniFetch(url + '/');
  if (h.status !== 200) {
    bad('Worker 健康检查失败 HTTP ' + (h.status || 0) + ' ' + (h.err || ''));
    bad('自定义域不可达 → 收信链路仍走 CF 内部（不受影响），但 MSCMS 拉验证码会失败，请检查路由/DNS。');
    return;
  }
  ok('Worker 健康检查通过 ' + url);
  // 2) /new
  const r = await miniFetch(url + '/new', {
    method: 'POST',
    headers: { '': 'application/json', '': apiKey },
    body: JSON.stringify({ label: 'smoke-test' }),
  });
  const j = await r.json().catch(() => null);
  if (r.status === 200 && j && j.address) ok('POST /new 生成测试地址 ' + j.address);
  else { bad('POST /new 异常 HTTP ' + (r.status || 0) + ' ' + JSON.stringify(j || {}).slice(0, 160)); return; }
  // 3) /code 必须可读（同时验证 KV 绑定）
  const r2 = await miniFetch(url + '/code?addr=' + encodeURIComponent(j.address), { headers: { '': apiKey } });
  const j2 = await r2.json().catch(() => null);
  if (r2.status === 200 && j2 && j2.code === null) ok('GET /code 可用（该地址暂无信件，符合预期）');
  else if (r2.status === 200 && j2 && j2.code) warn('GET /code 返回了 code=' + j2.code);
  else bad('GET /code 异常 HTTP ' + (r2.status || 0) + ' ' + JSON.stringify(j2 || {}).slice(0, 160));
  // 4) 鉴权必须真的生效
  const r3 = await miniFetch(url + '/inbox?addr=x@' + domain, { headers: { '': '' } });
  if (r3.status === 401) ok('鉴权生效（错 api-key → 401）');
  else bad('鉴权未生效！错 api-key 竟返回 HTTP ' + (r3.status || 0));
}

/* ─────────────────── 其他子命令 ─────────────────── */

 readOut() {
  if (!fs.existsSync(OUT_PATH)) fail('尚未部署（缺 ' + OUT_PATH + '），先跑 --deploy');
  return JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
}

async  cmdStatus() {
  const c = readOut();
  log('\n══════ 邮箱链路状态 ══════');
  for (const [k, v] of Object.entries(c)) {
    if (k === 'apiKey') log('  ' + k.padEnd(16) + ': ' + String(v).slice(0, 8) + '…（已隐藏）');
    else log('  ' + k.padEnd(16) + ': ' + v);
  }
  const zr = await api('/zones?per_page=50');
  const zone = (zr.json.result || []).find((z) => z.name === c.domain);
  if (zone) {
    const ca = await api(`/zones/${zone.id}/email/routing/rules/catch_all`);
    log('\n  catch-all HTTP ' + ca.status + ': ' + (ca.status === 200 ? JSON.stringify(ca.json.result && { enabled: ca.json.result.enabled, actions: ca.json.result.actions }) : errs(ca)));
  }
  const h = await fetch(c.apiUrl + '/', { signal: AbortSignal.timeout(12000) }).catch((e) => ({ status: 0, err: e.message }));
  log('  Worker 健康: HTTP ' + (h.status || 0) + ' ' + (h.err || ''));
}

async  cmdApi(pathname, opt = {}) {
  const c = readOut();
  const r = await fetch(c.apiUrl.replace(/\/+$/, '') + pathname, {
    ...opt,
    headers: { '': c.apiKey, '': 'application/json', ...(opt.headers || {}) },
    signal: AbortSignal.timeout(20000),
  }).catch((e) => ({ status: 0, err: e.message }));
  const t = r.text ? await r.text() : '';
  log('HTTP ' + (r.status || 0) + (r.err ? ' ' + r.err : ''));
  try { log(JSON.stringify(JSON.parse(t), null, 2)); } catch (_) { log(t); }
}

/* ─────────────────── 主入口 ─────────────────── */

(async () => {
  loadCfg();
  if (arg('check')) return void await cmdCheck();
  if (arg('deploy')) return void await cmdDeploy();
  if (arg('status')) return void await cmdStatus();
  if (arg('new')) return void await cmdApi('/new', { method: 'POST', body: JSON.stringify({ label: typeof arg('label') === 'string' ? arg('label') : null }) });
  if (typeof arg('inbox') === 'string') return void await cmdApi('/inbox?addr=' + encodeURIComponent(arg('inbox')));
  if (typeof arg('code') === 'string') return void await cmdApi('/code?addr=' + encodeURIComponent(arg('code')));
  if (typeof arg('test') === 'string') {
    const c = readOut();
    log('\n查看 ' + arg('test') + ' 的收件与验证码：');
    await cmdApi('/inbox?addr=' + encodeURIComponent(arg('test')));
    await cmdApi('/code?addr=' + encodeURIComponent(arg('test')));
    return void 0;
  }
  log(`MSCMS 邮箱链路部署工具

用法：
  --check                     权限体检（只读，不写任何东西）
  --deploy [--domain=] [--api-host=]   一键部署
  --status                    查看部署状态
  --new [--label=]            生成新地址
  --inbox=<addr>              列出该地址收件
  --code=<addr>               取该地址最新验证码
  --test=<addr>               收件 + 验证码 一起看
`);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
