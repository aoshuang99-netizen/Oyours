/**
 * tools/b1-nostr-publish.js — B1 平台扩容：Nostr **真实发布**验收
 *
 * 运行：node tools/b1-nostr-publish.js
 *
 * 这是方案 §7 B1 的验收动作：「各平台首次真实发布成功 + publish_url 落库」。
 * ⚠️ 该操作为**不可撤销的公开广播**（写入 3 个公共 relay）。
 *    内容明确标注为「通道验证」，不冒充业务内容 —— 符合零伪造原则。
 */
'use strict';

// 必须在 provider 首次构造 WebSocket 之前设置：
// nostr-provider.getWsDispatcher() 是 lazy 且只读一次 env。
// 实测（2026-09-20）：10808 直连 relay 3/3 可达，20201 仅 1/3，20777 为 0/3。
process.env.HTTP_PROXY = process.env.NOSTR_TEST_PROXY || 'http://127.0.0.1:10808';

const fs = require('fs');

const CFG_PATH = 'D:/mscms-ws/data/nostr_config.json';
const { NostrProvider } = require('../providers/nostr-provider.js');

let cfg;
try {
  const raw = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  cfg = Array.isArray(raw) ? raw[0] : raw;
} catch (e) {
  console.log('❌ 无法读取 nostr_config.json: ' + e.message);
  process.exit(1);
}

// 内存 stub，避免把 nsec 复制到其它文件
const fakeDS = { get: (mod, id) => (mod === 'nostr_config' && (id === 'main' || !id)) ? cfg : null };

const TEXT = [
  'MSCMS v14 · channel verification',
  '',
  'multi-platform publishing channel expansion (batch B1) — this post confirms the',
  'Nostr relay channel works end-to-end. Content pipeline: generate → quality gate → publish.',
  '',
  '2026-09-20',
].join('\n');

(async () => {
  console.log('══════ Nostr 真实发布 ══════\n');
  console.log('  代理     : ' + process.env.HTTP_PROXY);
  console.log('  relays   : ' + (cfg.relays || '(默认)'));
  console.log('  内容前 40: ' + TEXT.slice(0, 40).replace(/\n/g, ' / '));
  console.log('');

  const p = new NostrProvider({ dataStore: fakeDS });
  const t0 = Date.now();

  let res;
  try {
    res = await p.publishPost(TEXT, []);
  } catch (e) {
    console.log('  ❌ 抛异常: ' + e.message);
    process.exit(1);
  }

  const ms = Date.now() - t0;
  console.log('  耗时     : ' + ms + 'ms');
  console.log('  isSuccess: ' + (res && typeof res.isSuccess === 'function' ? res.isSuccess() : '?'));
  console.log('  status   : ' + (res && res.status));
  console.log('  error    : ' + ((res && res.error) || '(无)'));
  console.log('');
  console.log('  ── 完整返回 ──');
  console.log('  ' + JSON.stringify(res, null, 2).replace(/\n/g, '\n  '));

  // 提取可用的外部 URL
  let url = null;
  try { url = p.externalPostUrl(res); } catch (e) { /* 可能未实现 */ }
  console.log('');
  console.log('  externalPostUrl: ' + (url || '(空)'));

  const out = {
    at: new Date().toISOString(),
    platform: 'nostr',
    proxy: process.env.HTTP_PROXY,
    durationMs: ms,
    ok: !!(res && typeof res.isSuccess === 'function' && res.isSuccess()),
    status: (res && res.status) || null,
    error: (res && res.error) || null,
    postId: (res && (res.postId || res.id || (res.data && res.data.id))) || null,
    url,
    raw: res,
  };
  fs.writeFileSync('D:/mscms-tmp/b1-nostr-result.json', JSON.stringify(out, null, 2));
  console.log('\n  结果已写入 D:/mscms-tmp/b1-nostr-result.json');
  process.exit(out.ok ? 0 : 1);
})();
