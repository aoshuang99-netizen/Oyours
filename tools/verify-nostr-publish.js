#!/usr/bin/env node
/**
 * nostr 端到端发布验证（真实发帖到公网 relay）
 *
 * 用法：
 *   node tools/verify-nostr-publish.js --dry     # 只校验依赖/密钥，不发帖
 *   node tools/verify-nostr-publish.js           # 真实发布一条测试事件
 *
 * 纪律：
 *   · 只读 data/nostr_config.json，绝不写 DataStore（白名单设 none）
 *   · 走本地代理（默认 :10808），因为 relay 的 wss 直连在国内被拦
 *   · 结果落 reports/_nostr-last-publish.json，供闭环验收引用
 */
process.env.MSCMS_DATASTORE_WRITE_MODULES = 'none';
const fs = require('fs');
const path = require('path');

const PROXY = process.env.NOSTR_TEST_PROXY || 'http://:10808';
if (!process.env.HTTP_PROXY && !process.env.http_proxy) process.env.HTTP_PROXY = PROXY;
if (!process.env.HTTPS_PROXY) process.env.HTTPS_PROXY = PROXY;

const WS = path.join(__dirname, '..');
const { NostrProvider } = require(path.join(WS, 'providers', 'nostr-provider.js'));

 pickRow(raw) {
  if (Array.isArray(raw)) return raw[0];
  if (raw && raw['0'] && typeof raw['0'] === 'object') return Object.values(raw['0'])[0];
  return Object.values(raw).filter((x) => x && typeof x === 'object')[0];
}

(async () => {
  const dry = process.argv.includes('--dry');
  const cfgPath = path.join(WS, 'data', 'nostr_config.json');
  const row = pickRow(JSON.parse(fs.readFileSync(cfgPath, 'utf8')));

  console.log('=== nostr 端到端验证 ===');
  console.log('配置来源 :', cfgPath);
  console.log('relays   :', row.relays);
  console.log('代理     :', PROXY, '(HTTP_PROXY=' + process.env.HTTP_PROXY + ')');

  // ⚠️ 坑：NostrProvider._config() 只认 `dataStore.get('nostr_config','main')` 与 env，
  // 完全**忽略构造参数 values**（与其他 provider 不一致）。故这里用 env 传参。
  process.env.NOSTR_PRIVATE_KEY = row.;
  process.env.NOSTR_RELAYS = row.relays;
  const p = new NostrProvider({ values: { : row., relays: row.relays } });

  const st = p.configStatus();
  console.log('configured :', st.configured);
  console.log('format     :', st.format);
  console.log('authorized :', st.authorized);
  console.log('reason     :', st.reason || '(无)');

  let acc = null;
  try { acc = await p.getAccount(); console.log('账户       :', JSON.stringify(acc)); }
  catch (e) { console.log('账户解析失败:', e.message); }

  if (dry) { console.log('\n[dry] 已跳过真实发帖。密钥与依赖自检通过。'); return; }

  const text = `MSCMS v14 · Nostr 通道接入验证 ${new Date().toISOString()}\n本贴由自动化系统真实发布，用于验证去中心化中继可达性。`;
  console.log('\n--- 真实发布中（3 个 relay，单 relay 超时 8s）---');
  const t0 = Date.now();
  const res = await p.publishPost(text, [], { tags: ['mscms', 'nostr', 'connectivity'] });
  const dt = Date.now() - t0;

  console.log('耗时       :', dt, 'ms');
  const ok = !!(res && typeof res.isSuccess === '' && res.isSuccess());
  if (ok) {
    console.log('✅ 真实发布成功');
    console.log('event id   :', res.id);
    console.log('公网查看   :', res.url);
    console.log('relay 命中 :', res.raw && res.raw.relaysOk, '/', res.raw && res.raw.relaysTotal);
    if (res.raw && res.raw.notes && res.raw.notes.length) console.log('失败明细   :', res.raw.notes.join(' | '));
  } else {
    console.log('❌ 发布失败:', (res && res.error) || 'unknown');
    if (res && res.raw && res.raw.notes) console.log('relay 明细 :', res.raw.notes.join(' | '));
  }

  const out = {
    at: new Date().toISOString(), ok, eventId: (res && res.id) || null, url: (res && res.url) || null,
    durationMs: dt, text, npub: acc && acc.id, relays: row.relays,
    relaysOk: (res && res.raw && res.raw.relaysOk) || 0,
    relaysTotal: (res && res.raw && res.raw.relaysTotal) || 0,
    notes: (res && res.raw && res.raw.notes) || [],
    error: ok ? null : ((res && res.error) || 'unknown'),
  };
  fs.mkdirSync(path.join(WS, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(WS, 'reports', '_nostr-last-publish.json'), JSON.stringify(out, null, 2), 'utf8');
  console.log('\n落盘 → reports/_nostr-last-publish.json');
})();
