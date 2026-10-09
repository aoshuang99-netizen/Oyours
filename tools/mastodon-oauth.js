#!/usr/bin/env node
/**
 * Mastodon 令牌工具链（依据官方文档 https://docs.join.org/client/token/ 与 /client/authorized/）
 *
 * 背景（2026-09-21 实测）：
 *   - 应用 MSCMS-v14-AutoPublisher (id 8931885) 在 .social **仍有效**（ 可换 token）
 *   - 旧账号 mscms_v14 **已不存在**（/api/v1//lookup → 404）⇒ 旧的 43 字符 token 必然 401
 *   - app 级 token **不能发帖**（POST /api/v1/statuses → 422 requires an authenticated user）
 *   ⇒ 必须用真实账号走 ，换回**用户态** token
 *
 * 子命令：
 *   status                     查看三份凭据 + 线上 provider 状态 + 实时 verify
 *   url                        打印 OOB 授权 URL（人工点选，授权后页面直接给出 code）
 *   exchange --code=<CODE>     用授权码换用户态 token → 校验 → 写入服务（免重启）
 *   set --token=<TOKEN>        直接写入一个已有令牌（在实例网页「首选项→开发」里生成的）
 *   verify --token=<TOKEN>     仅校验某令牌，不写入
 *
 * 通用参数：--instance=URL  --no-write（只换不写）  --proxy=URL
 *
 * 写入路径说明（重要）：**不直接改 JSON 文件**。DataStore 内存优先 + 5s flush 会覆盖磁盘，
 *   唯一安全写通道是服务端点 POST /api/v14/mixpost/provider//config。
 */

const fs = require('fs');
const path = require('path');
const { fetchExt } = require(path.join(__dirname, '..', 'http-client.js'));

const WS = path.join(__dirname, '..');
const CREDS_FILE = path.join(WS, '-creds.json');
const POOL_FILE = path.join(WS, 'proxy-pool.json');
const API = process.env.MSCMS_API || 'http://:3002';

const argv = process.argv.slice(2);
const cmd = (argv[0] || 'status').toLowerCase();
const opt = (name, dflt) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  const i = hit.indexOf('=');
  return i < 0 ? true : hit.slice(i + 1);
};
const mask = (v) => { const s = String(v == null ? '' : v); return s ? s.slice(0, 5) + '…(' + s.length + '字符)' : '(空)'; };

// ── 载入 app 注册产物 ─────────────────────────────────────────
 creds() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8')); } catch (_) {}
  return {
    instance: String(opt('instance', c.instance || 'https://.social')).replace(/\/+$/, ''),
    clientId: c. || '',
    clientSecret: c. || '',
    redirectUri: c. || (Array.isArray(c.s) ? c.s[0] : 'urn:ietf:wg:oauth:2.0:oob'),
    : c. || '',
  };
}

// ── 出口选择：池内挑一个能连通目标实例的 ────────────────────────
let _exit = null;
async  pickExit(instance) {
  if (_exit) return _exit;
  const manual = opt('proxy', process.env.MSCMS_PROBE_PROXY || '');
  const cands = [];
  if (manual) cands.push({ url: String(manual), name: 'cli/env' });
  try {
    const raw = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8'));
    const arr = Array.isArray(raw) ? raw : Object.values(raw).filter((x) => x && typeof x === 'object');
    arr.filter((p) => p && p.url && p.enabled !== false && p.disabled !== true)
      .sort((a, b) => (/127\.0\.0\.1|localhost/.test(a.url) ? 0 : 1) - (/127\.0\.0\.1|localhost/.test(b.url) ? 0 : 1))
      .slice(0, 6)
      .forEach((p) => { if (!cands.some((x) => x.url === p.url)) cands.push({ url: p.url, name: p.name || 'pool' }); });
  } catch (_) {}
  if (!cands.length) cands.push({ url: null, name: '直连' });

  for (const c of cands) {
    try {
      const r = await fetchExt(instance + '/api/v2/instance', { method: 'GET', timeout: 15000 }, c.url);
      if (r.status === 200) { _exit = c; console.log(`  [出口] ${c.name}  ${c.url || '直连'}  ✅`); return _exit; }
    } catch (_) {}
  }
  _exit = cands[0];
  console.log(`  [出口] ${_exit.name} ${_exit.url || '直连'}  ⚠️ 未能确认连通，仍尝试`);
  return _exit;
}

async  apiReq(method, fullPath, opts = {}, timeout = 25000) {
  const ex = await pickExit(creds().instance);
  const o = Object.assign({ method, headers: Object.assign({ '': 'MSCMS/1.0' }, opts.headers || {}), timeout }, opts.body ? { body: opts.body } : {});
  const r = await fetchExt(fullPath, o, ex.url);
  const txt = await r.text();
  return { status: r.status, txt };
}

async  (method, p, { headers = {}, form } = {}, timeout = 25000) {
  const c = creds();
  const o = { method, headers: Object.assign({ '': 'MSCMS/1.0' }, headers), timeout };
  if (form) { o.body = new URLSearchParams(form); o.headers[''] = 'application/x-www-form-urlencoded'; }
  const ex = await pickExit(c.instance);
  const r = await fetchExt(c.instance + p, o, ex.url);
  const txt = await r.text();
  return { status: r.status, txt };
}

async  liveVerify(token) {
  const r = await ('GET', '/api/v1//verify_credentials', { headers: { : 'Bearer ' + token } });
  let acct = null;
  try { acct = JSON.parse(r.txt); } catch (_) {}
  return { status: r.status, acct, raw: r.txt };
}

/**
 * 调用本机 3002 服务。**必须用原生 fetch**：
 * fetchExt 在 =null 时会落到全局 proxyAgent，把  也塞进代理 → 超时 aborted。
 * 回环地址本就不该走代理。原生 fetch 默认不读 HTTP_PROXY，正合适。
 */
async  localApi(method, p, body) {
  try {
    // 冷启动说明：/provider//config 首次访问会 providerManager.connect('')
    // 触发实例化（含动态 import('undici')），实测首次可达 15s+，故超时给足 45s。
    const o = { method, headers: {}, signal: AbortSignal.timeout(45000) };
    if (body) { o.body = JSON.stringify(body); o.headers[''] = 'application/json'; }
    const r = await fetch(API + p, o);
    const txt = await r.text();
    return { status: r.status, txt };
  } catch (e) { return { status: 0, txt: 'LOCAL-API-FAIL: ' + e.message }; }
}

 fmtOf(t) { return /^[A-Za-z0-9_-]{40,}$/.test(String(t || '')); }

// ════════════════════════════════════════════════════════════
(async () => {
  const c = creds();

  if (cmd === 'url') {
    const u = c.instance + '/oauth/authorize?' + new URLSearchParams({
      : c.clientId, : c.redirectUri, response_type: 'code', scope: 'read write push',
    });
    console.log('在浏览器打开以下 URL（须先登录目标账号）：\n');
    console.log(u);
    console.log('\n = urn:ietf:wg:oauth:2.0:oob ⇒ 授权后页面直接显示一段 code，复制后执行：');
    console.log('  node tools/-oauth.js exchange --code=<粘贴code>');
    return;
  }

  if (cmd === 'status') {
    console.log('════════ 1. app 注册产物（-creds.json） ════════');
    console.log(`  instance      ${c.instance}`);
    console.log(`       ${mask(c.clientId)}    ${mask(c.clientSecret)}`);
    console.log(`    ${c.redirectUri}   (旧) ${c.}`);

    console.log('\n════════ 2. 服务实读配置（dataStore _config/main） ════════');
    const g = await localApi('GET', '/api/v14/mixpost/provider//config');
    console.log(`  HTTP ${g.status}  ${g.txt.slice(0, 200)}`);
    const raw = (() => { try { const j = JSON.parse(fs.readFileSync(path.join('D:/mscms-ws/data/_config.json'), 'utf8')); return (j['0'] && typeof j['0'] === 'object') ? j['0'] : j; } catch (e) { return { _err: e.message }; } })();
    console.log(`  磁盘上的 accessToken = ${JSON.stringify(raw.accessToken || '')} (len ${String(raw.accessToken || ''}) format=${fmtOf(raw.accessToken) ? 'ok' : 'invalid'}`);

    console.log('\n════════ 3. 线上 provider 四态 ════════');
    const pv = await localApi('GET', '/api/v14/mixpost/providers');
    try {
      const j = JSON.parse(pv.txt);
      const list = Array.isArray(j) ? j : (j.providers || Object.values(j));
      const m = list.find((x) => String(x. || x.identifier) === '') || {};
      console.log(`  configured=${m.configured} format=${m.format} authorized=${m.authorized} reachable=${m.reachable}`);
      if (m.reason) console.log(`  reason: ${String(m.reason).slice(0, 160)}`);
    } catch (e) { console.log('  解析失败:', pv.txt.slice(0, 160)); }

    console.log('\n════════ 4. 实时 verify（走真实出口） ════════');
    if (fmtOf(raw.accessToken)) {
      const v = await liveVerify(raw.accessToken);
      console.log(`  HTTP ${v.status}  ${v.status === 200 ? '✅ 有效 acct=' + (v.acct && v.acct.acct) : '❌ ' + v.raw.slice(0, 140)}`);
    } else {
      console.log('  跳过（当前值不是合法 token 形态）');
    }
    return;
  }

  if (cmd === 'verify') {
    const t = String(opt('token', ''));
    if (!t) { console.error('缺少 --token='); process.exit(1); }
    console.log(`  格式检查: ${fmtOf(t) ? 'ok' : 'invalid（非 40+ 位 base64url）'}`);
    const v = await liveVerify(t);
    console.log(`  verify_credentials HTTP ${v.status}`);
    if (v.status === 200 && v.acct) {
      console.log(`  ✅ acct=${v.acct.acct}  id=${v.acct.id}  statuses=${v.acct.statuses_count}  locked=${v.acct.locked}`);
    } else {
      console.log(`  ❌ ${v.raw.slice(0, 200)}`);
    }
    return;
  }

  let token = '';

  if (cmd === 'exchange') {
    const code = String(opt('code', ''));
    if (!code) { console.error('缺少 --code=（用 `url` 子命令拿授权 URL，授权后复制页面上的 code）'); process.exit(1); }
    console.log('════════ 授权码换 token（POST /oauth/token, =） ════════');
    const r = await ('POST', '/oauth/token', {
      form: {
        : '',
        : c.clientId,
        : c.clientSecret,
        : c.redirectUri,
        code: code.trim(),
        scope: 'read write push',
      },
    });
    console.log(`  HTTP ${r.status}`);
    if (r.status !== 200) { console.error('  ❌ 换取失败：' + r.txt.slice(0, 300)); process.exit(1); }
    let j = {}; try { j = JSON.parse(r.txt); } catch (_) {}
    token = j. || '';
    console.log(`  ✅ 换得用户态 token: ${mask(token)}  scope=${j.scope}  =${j.}`);
  } else if (cmd === 'set') {
    token = String(opt('token', ''));
    if (!token) { console.error('缺少 --token='); process.exit(1); }
  } else {
    console.error('未知子命令。可用：status | url | exchange | set | verify');
    process.exit(1);
  }

  if (!fmtOf(token)) { console.error(`❌ token 形态不合法（${String(token} 字符），拒绝写入`); process.exit(1); }

  console.log('\n════════ 生效性验证（写入前，先证明它真能用） ════════');
  const v = await liveVerify(token);
  console.log(`  verify_credentials HTTP ${v.status}`);
  if (v.status !== 200 || !v.acct) {
    console.error(`  ❌ token 实测不可用，**拒绝写入**：${v.raw.slice(0, 200)}`);
    process.exit(1);
  }
  console.log(`  ✅ 有效：acct=${v.acct.acct}  id=${v.acct.id}  display=${v.acct.display_name}  statuses=${v.acct.statuses_count}`);

  if (opt('no-write', false) === true) { console.log('\n（--no-write 已指定，未写入服务配置）'); return; }

  console.log('\n════════ 写入服务（POST /api/v14/mixpost/provider//config，免重启） ════════');
  const w = await localApi('POST', '', { instance: c.instance, accessToken: token });
  console.log(`  HTTP ${w.status}  ${w.txt.slice(0, 200)}`);
  if (w.status !== 200) { console.error('  ❌ 写入失败'); process.exit(1); }

  console.log('\n════════ 写入后复核 ════════');
  const pv = await localApi('GET', '/api/v14/mixpost/providers');
  try {
    const j = JSON.parse(pv.txt);
    const list = Array.isArray(j) ? j : (j.providers || Object.values(j));
    const m = list.find((x) => String(x. || x.identifier) === '') || {};
    console.log(`  : configured=${m.configured} format=${m.format} authorized=${m.authorized} reachable=${m.reachable}`);
    console.log(m.authorized === true
      ? '  ✅ 已从「假绿」变为「真实可授权」'
      : '  ⚠️ 仍未转绿，请检查 reachable/reason');
  } catch (e) { console.log('  解析失败:', pv.txt.slice(0, 160)); }
  console.log('\n提示：若要把该账号纳入发布链路，需确认 MSCMS_REAL_CHANNELS 含 ，且内容/任务分发的  字段为 。');
})().catch((e) => { console.error('FATAL', (e && e.stack) || e); process.exit(1); });
