/**
 * b1-nostr-probe.js — B1 平台扩容：Nostr 通道可用性探针（只读，不发帖）
 *
 * 目的：在把 nostr 接入 cloud-publisher 分派之前，先验证
 *   1. 凭据可解析（nsec → hex → pubkey）
 *   2. @noble/curves 签名库就绪
 *   3. relay WebSocket 在本机网络下可达
 *
 * ⚠️ 本脚本**不发布任何内容**。真实发布由 b1-nostr-publish.js 单独执行。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CFG_PATH = 'D:/mscms-ws/data/nostr_config.json';

let cfg;
try {
  const raw = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  cfg = Array.isArray(raw) ? raw[0] : raw;
} catch (e) {
  console.log('❌ 无法读取 nostr_config.json: ' + e.message);
  process.exit(1);
}

if (!cfg || !cfg.privateKey) {
  console.log('❌ nostr_config.json 中没有 privateKey');
  process.exit(1);
}

// 用内存 stub 模拟 dataStore，避免把 nsec 复制到别处
const fakeDS = {
  get(mod, id) {
    if (mod === 'nostr_config' && (id === 'main' || !id)) return cfg;
    return null;
  },
};

const { NostrProvider } = require('../providers/nostr-provider.js');

(async () => {
  console.log('══════ Nostr 通道探针 ══════\n');

  const p = new NostrProvider({ dataStore: fakeDS });

  // 1) 配置状态
  const st = p.configStatus();
  console.log('  1) configStatus:');
  console.log('     configured =', st.configured);
  console.log('     authorized =', st.authorized);
  console.log('     reason     =', st.reason || '(无)');
  if (!st.configured) {
    console.log('\n  ❌ 凭据不可用，终止');
    process.exit(1);
  }

  // 2) 密钥解析（不出网）
  try {
    const keys = p._resolveKeys();
    console.log('\n  2) 密钥解析:');
    console.log('     pubkey(hex) =', keys.pubHex);
    console.log('     私钥长度    =', keys.privHex.length, '（应为 64）');
    console.log('     ✅ nsec 解码 + schnorr 派生成功');
  } catch (e) {
    console.log('\n  ❌ 密钥解析失败: ' + e.message);
    process.exit(1);
  }

  // 3) relay 列表
  const relays = p._defaultRelays();
  console.log('\n  3) relays (' + relays.length + '):');
  for (const r of relays) console.log('     - ' + r);

  // 4) relay 连通性（WebSocket 握手）—— 支持走代理（与 provider 的 newProxiedWebSocket 同策略）
  const proxy = process.env.HTTP_PROXY || process.env.http_proxy || process.env.HTTPS_PROXY || '';
  console.log('\n  4) relay 连通性' + (proxy ? `（经代理 ${proxy}）` : '（直连）') + ':');
  let okCount = 0;
  let _dispatcher = null;
  if (proxy) {
    try {
      const undici = require('undici');
      _dispatcher = new undici.ProxyAgent(proxy);
    } catch (e) {
      console.log('     ⚠️ ProxyAgent 构造失败: ' + e.message);
    }
  }

  await Promise.all(relays.map((url) => new Promise((resolve) => {
    let ws;
    let done = false;
    const finish = (ok, note) => {
      if (done) return;
      done = true;
      try { if (ws) ws.close(); } catch (e) {}
      if (ok) okCount++;
      console.log(`     ${ok ? '✅' : '❌'} ${url}  ${note}`);
      resolve();
    };
    const timer = setTimeout(() => finish(false, '超时 15s'), 15000);
    try {
      if (_dispatcher) {
        const undici = require('undici');
        ws = new undici.WebSocket(url, { dispatcher: _dispatcher });
      } else {
        const WS = (typeof globalThis.WebSocket === 'function') ? globalThis.WebSocket : require('ws');
        ws = new WS(url);
      }
      ws.onopen = () => { clearTimeout(timer); finish(true, '握手成功'); };
      ws.onerror = (e) => { clearTimeout(timer); finish(false, 'ERR ' + ((e && e.message) || 'non-101')); };
    } catch (e) {
      clearTimeout(timer);
      finish(false, '构造失败 ' + e.message);
    }
  })));

  console.log('\n  ══ 小结 ══');
  console.log('     relay 可达: ' + okCount + '/' + relays.length);
  console.log('     结论: ' + (okCount > 0 ? '✅ 通道可用，可进入真实发布验证' : '❌ 全部 relay 不可达 —— 需走代理'));
  process.exit(okCount > 0 ? 0 : 2);
})();
