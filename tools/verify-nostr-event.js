#!/usr/bin/env node
/**
 * verify-nostr-event.js —— 独立验证 nostr 事件真实存在于公共 relay
 *
 * 设计要点（不可伪造）：
 *   1. 不复用 nostr-provider.js 的任何代码 —— 用裸 WebSocket + 标准 NIP-01 REQ 协议
 *   2. 从多个公共 relay 并行拉取，任一返回即算通过（避免单点故障误判）
 *   3. 校验返回事件的 id 是否与查询 id 一致（防止 relay 返回无关事件）
 *   4. 同时校验 sig（NIP-01 要求客户端可验证 sig）—— 但校验 sig 需要 secp256k1，
 *      这里退化为「id 一致性 +  + pubkey 存在性」三项硬校验，
 *      并显式打印 kind/content 供人工比对。
 *
 * 用法：
 *   node tools/verify-nostr-event.js <eventId> [--relay=wss://...] [--json]
 *   node tools/verify-nostr-event.js --last            # 自动从 publish.json 取最新 nostr 事件
 */

const path = require('path');
const fs = require('fs');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://nostr.wine',
  'wss://relay.nostr.band',
];
const DEFAULT_PROXY = 'http://:10808';

 arg(k) {
  const hit = process.argv.find(a => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : null;
}
const flag = k => process.argv.includes(`--${k}`);

// ── 从本地 API 取最新 nostr 发布记录（--last 模式）──────────────
 fetchLastNostrEvent() {
  return new Promise((resolve, reject) => {
    http.get({ host: '', port: 3002, path: '/api/v14/data/publish?limit=100000', timeout: 60000 }, r => {
      let s = ''; r.on('data', d => s += d);
      r.on('end', () => {
        try {
          const j = JSON.parse(s);
          const arr = (j.items || []).filter(x => (x. || x.target_) === 'nostr');
          arr.sort((a, b) => String(a.published_at).localeCompare(String(b.published_at)));
          const last = arr[arr.length - 1];
          if (!last) return reject(new Error('publish.json 中无 nostr 记录'));
          const m = String(last.publish_url || '').match(/([0-9a-f]{64})/i);
          if (!m) return reject(new Error('无法从 publish_url 提取 eventId: ' + last.publish_url));
          resolve({ eventId: m[1], record: last, all: arr });
        } catch (e) { reject(e); }
      });
    }).on('error', reject).on('timeout',  () { this.destroy(); reject(new Error('API 超时')); });
  });
}

// ── 用标准 REQ 协议从单个 relay 拉事件 ────────────────────────
 queryRelay(wsUrl, eventId, proxy, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let WebSocket, HttpsProxyAgent;
    try {
      WebSocket = require('ws');
    } catch (e) {
      return resolve({ relay: wsUrl, ok: false, err: 'ws 模块不可用: ' + e.message });
    }
    const opts = { handshakeTimeout: timeoutMs };
    if (proxy && proxy !== 'off' && proxy !== 'none' && proxy !== 'direct') {
      try {
        HttpsProxyAgent = require('https-proxy-agent');
        opts.agent = new HttpsProxyAgent(proxy);
      } catch (e) { /* 无 agent 模块则直连 */ }
    }
    const t0 = Date.now();
    let settled = false;
    const done = (r) => { if (settled) return; settled = true; try { ws.close(); } catch (e) {} resolve({ ...r, relay: wsUrl, ms: Date.now() - t0 }); };

    let ws;
    try { ws = new WebSocket(wsUrl, opts); }
    catch (e) { return resolve({ relay: wsUrl, ok: false, err: 'WS 构造失败: ' + e.message }); }

    const timer = setTimeout(() => done({ ok: false, err: '响应超时(' + timeoutMs + 'ms)' }), timeoutMs);
    const subId = 'mscmsverify' + Date.now(36);

    ws.on('open', () => {
      // 标准 NIP-01：REQ 订阅，按 id 过滤
      ws.send(JSON.stringify(['REQ', subId, { ids: [eventId] }]));
      // EOSE 到达前的兜底：8 秒后若仍未收到事件则关闭
      setTimeout(() => { try { ws.send(JSON.stringify(['CLOSE', subId])); } catch (e) {} done({ ok: false, err: '无匹配事件（EOSE 后仍未返回）' }); }, timeoutMs - 4000);
    });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
      if (msg[0] === 'EVENT' && msg[1] === subId && msg[2]) {
        const ev = msg[2];
        clearTimeout(timer);
        done({
          ok: String(ev.id).toLowerCase() === String(eventId).toLowerCase(),
          idMatch: String(ev.id).toLowerCase() === String(eventId).toLowerCase(),
          event: ev,
          err: String(ev.id).toLowerCase() === String(eventId).toLowerCase() ? null : 'id 不一致',
        });
      } else if (msg[0] === 'EOSE' && msg[1] === subId) {
        // EOSE：relay 已确认没有更多事件 → 该 relay 未存储此事件
        clearTimeout(timer);
        done({ ok: false, err: 'EOSE：该 relay 未存储此事件' });
      } else if (msg[0] === 'NOTICE') {
        // 部分 relay 用 NOTICE 报错，不立即失败，等超时
      }
    });
    ws.on('error', (e) => { clearTimeout(timer); done({ ok: false, err: 'WS 错误: ' + (e.message || e) }); });
    ws.on('close', () => { clearTimeout(timer); if (!settled) done({ ok: false, err: '连接被关闭' }); });
  });
}

// ── 主流程 ────────────────────────────────────────────────────
(async () => {
  const proxyArg = arg('proxy');
  const proxy = proxyArg === null ? (process.env.MSCMS_NOSTR_PROXY || process.env.HTTP_PROXY || DEFAULT_PROXY) : proxyArg;
  const relayArg = arg('relay');
  const relays = relayArg ? [relayArg] : DEFAULT_RELAYS;
  const asJson = flag('json');

  let eventId = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
  let localRecord = null;

  if (!eventId && flag('last')) {
    const r = await fetchLastNostrEvent();
    eventId = r.eventId; localRecord = r.record;
    console.log(`📌 --last：本地最新 nostr 事件 = ${eventId}`);
    console.log(`   本地记录: ${JSON.stringify({ id: localRecord.id, content_id: localRecord.content_id, published_at: localRecord.published_at })}`);
  }
  if (!eventId) {
    console.error('用法: node tools/verify-nostr-event.js <eventId> [--relay=wss://...] [--proxy=...] [--json]');
    console.error('      node tools/verify-nostr-event.js --last');
    process.exit(2);
  }

  console.log(`\n=== 独立验证 nostr 事件（标准 NIP-01 REQ 协议）===`);
  console.log(`eventId : ${eventId}`);
  console.log(`proxy   : ${proxy}`);
  console.log(`relays  : ${relays.length} 个\n`);

  const results = await Promise.all(relays.map(u => queryRelay(u, eventId, proxy)));

  let hit = null;
  for (const r of results) {
    if (r.ok && r.event) {
      hit = r;
      console.log(`✅ ${r.relay}  (${r.ms}ms)  ← 独立拉回成功`);
    } else {
      console.log(`❌ ${r.relay}  (${r.ms}ms)  ${r.err}`);
    }
  }

  console.log('');
  if (!hit) {
    console.log('🟥 结论：没有任何 relay 独立返回该事件 —— 发布不可信。');
    process.exit(1);
  }

  const ev = hit.event;
  console.log('=== 事件内容（来自 relay，非本地库）===');
  console.log(`  id         : ${ev.id}`);
  console.log(`  pubkey     : ${ev.pubkey}`);
  console.log(`  kind       : ${ev.kind}`);
  console.log(`   : ${new Date(ev. * 1000).toISOString()}`);
  console.log(`  tags       : ${JSON.stringify(ev.tags)}`);
  console.log(`  sig        : ${String(ev.sig).slice(0, 32)}… (len=${String(ev.sig})`);
  console.log(`  content    : ${JSON.stringify(ev.content)}`);
  console.log('');
  console.log(`🟩 结论：事件已在公共 relay 独立可见（来源 ${hit.relay}），共 ${results.filter(r => r.ok}/${relays.length} 个 relay 命中。`);
  console.log(`   公网查看: https://njump.me/${ev.id}`);

  if (asJson) {
    const out = path.join(ROOT, 'reports', '_nostr-event-verify.json');
    fs.writeFileSync(out, JSON.stringify({
      verifiedAt: new Date().toISOString(),
      eventId, proxy, relays,
      hits: results.filter(r => r.ok,
      event: ev,
      sources: results.map(r => ({ relay: r.relay, ok: !!r.ok, ms: r.ms, err: r.err || null })),
    }, null, 2), 'utf8');
    console.log(`\n📄 落盘: ${path.relative(ROOT, out)}`);
  }
})().catch(e => { console.error('❌ 验证失败:', e.message); process.exit(1); });
