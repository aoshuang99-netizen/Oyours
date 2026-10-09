#!/usr/bin/env node
/**
 * Bluesky 注册可行性探测（只读，不创建账号）
 *
 * 目的：确认「Bluesky 是否可以不经开发者门户/审批，直接程序化注册并拿到可发布凭据」。
 * 依据：AT Protocol 公开 XRPC 端点
 *   · com.atproto.server.describeServer        服务可用性
 *   · com.atproto.identity.resolveHandle       handle 占用判定（404/400 = 可用）
 *   · com.atproto.server.createAccount        注册（本脚本**不调用**）
 *
 * 网络：必须走本地代理（国内直连 bsky.social 会失败）。
 * 用法：node tools/probe-bluesky-signup.js
 */
const { ProxyAgent, fetch } = require('undici');   // ⚠️ 必须从 undici 解构，不能用全局 fetch + 外部 ProxyAgent

const PROXY = process.env.MSCMS_BLUESKY_PROXY || 'http://:10808';
const dispatcher = new ProxyAgent(PROXY);
const PDS = 'https://bsky.social';

async  call(method, path, { body = null, headers = {} } = {}) {
  const url = method === 'GET' ? `${PDS}/xrpc/${path}` : `${PDS}/xrpc/${path}`;
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      method,
      dispatcher,
      headers: { ...(body ? { '': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    const txt = await r.text();
    return { status: r.status, body: txt, ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, body: `ERR ${e.message}${e.cause ? ' | ' + (e.cause.code || e.cause.message) : ''}`, ms: Date.now() - t0 };
  }
}

(async () => {
  console.log('=== Bluesky 注册可行性探测 ===');
  console.log('代理:', PROXY);

  if (process.argv.includes('--direct')) {
    console.log('（--direct 模式：直连对照）');
  }

  // 1) 服务可用性
  const desc = await call('GET', 'com.atproto.server.describeServer');
  console.log(`\n[1] describeServer HTTP=${desc.status} (${desc.ms}ms)`);
  if (desc.status === 200) {
    try {
      const j = JSON.parse(desc.body);
      console.log('    可用邀请码要求 inviteCodeRequired =', j.inviteCodeRequired === true ? '**是**(需邀请)' : '否(开放注册)');
      console.log('    可选字段:', JSON.stringify(Object.keys(j)));
      if (j.links) console.log('    政策链接:', JSON.stringify(j.links));
    } catch (e) { console.log('    解析失败:', desc.body.slice(0, 200)); }
  } else {
    console.log('    响应:', desc.body.slice(0, 200));
  }

  // 2) handle 占用判定（决定候选 handle 是否可用）
  const candidates = (process.env.MSCMS_BSKY_HANDLES || 'mscms-v14-verify,mscms-lokfeel,mscmsv14test').split(',');
  console.log('\n[2] handle 可用性（404/400=未占用 → 可注册）');
  for (const h of candidates) {
    const r = await call('GET', `com.atproto.identity.resolveHandle?handle=${encodeURIComponent(h)}.bsky.social`);
    const free = (r.status === 400 || r.status === 404);
    let note = '';
    if (r.status === 200) { try { note = 'did=' + JSON.parse(r.body).did; } catch (_) {} }
    console.log(`    ${h}.bsky.social → HTTP ${r.status} ${free ? '✅ 可用' : '❌ 已占用'} ${note}`);
  }

  // 3) 注册端点存在性（用故意缺参的方式探测，不创建账号）
  const create = await call('POST', 'com.atproto.server.createAccount', { body: {} });
  console.log(`\n[3] createAccount 端点探测（空 body，预期 400 参数错）HTTP=${create.status}`);
  console.log('    ', create.body.slice(0, 300));
  const paramErr = /InvalidRequest|Error|invalid/i.test(create.body);
  console.log(paramErr
    ? '    ⇒ 端点存在且可达（只是参数不合法），注册链路可用 ✅'
    : '    ⇒ ⚠️ 响应异常，需人工确认');

  console.log('\n结论口径：describeServer 200 + createAccount 400(参数错) ⇒ 可程序化注册；inviteCodeRequired 必须为 false。');
})();
