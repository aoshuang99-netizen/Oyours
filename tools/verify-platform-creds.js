#!/usr/bin/env node
/**
 * 三平台凭据真实性验证（只读，不写任何数据）
 *
 * 背景：线上 provider 报 mastodon/bluesky format=invalid。但工作区 mastodon-creds.json
 *       里存有一条 43 字符的 access_token（格式合法），而 provider 只读
 *       dataStore('mastodon_config') 里的 11 字符占位值。本脚本用于**实测**该 token 是否真的有效，
 *       避免把「格式合法」误当成「可用」。
 *
 * 铁律：只做 verify / createSession 这类只读或只建会话的调用，不发帖、不改配置。
 *       token 一律脱敏输出，不落入任何文件。
 */
const fs = require('fs');
const path = require('path');
const { fetchExt } = require('../http-client.js');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.MSCMS_DATA_DIR || 'D:/mscms-ws/data';

const mask = (v) => {
  const s = String(v == null ? '' : v);
  return s ? s.slice(0, 6) + '…(' + s.length + '字符)' : '(空)';
};
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };
const unwrap = (o) => (o && o['0'] && typeof o['0'] === 'object') ? o['0'] : o;

const results = [];
const rec = (platform, field, verdict, detail) => {
  results.push({ platform, field, verdict, detail });
  const badge = verdict === 'ok' ? '✅ 有效' : verdict === 'invalid' ? '❌ 无效' : verdict === 'format' ? '⚠️ 格式错' : '⚪ 未配';
  console.log('  ' + badge.padEnd(10) + platform.padEnd(10) + (detail || ''));
};

(async () => {
  console.log('══════════ 1. Mastodon ══════════');
  const creds = readJson(path.join(ROOT, 'mastodon-creds.json'));
  const live = unwrap(readJson(path.join(DATA, 'mastodon_config.json')));

  if (!creds) {
    console.log('  工作区 mastodon-creds.json 不存在，跳过');
  } else {
    console.log('  工作区 app 产物: instance=' + creds.instance + ' username=' + creds.username);
    console.log('  工作区 access_token: ' + mask(creds.access_token) + '  ← 待验证');
    console.log('  provider 实读 accessToken: ' + mask(live && live.accessToken) + '  ← 线上生效值');
    console.log('  两者是否相同:', creds.access_token === (live && live.accessToken) ? '是' : '否（关键！）');
    console.log('  实测 verify_credentials …');

    const inst = String(creds.instance || 'https://mastodon.social').replace(/\/+$/, '');
    try {
      const r = await fetchExt(inst + '/api/v1/accounts/verify_credentials', {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + creds.access_token, 'User-Agent': 'MSCMS/1.0' },
        timeout: 30000,
      });
      const txt = await r.text();
      let j = null; try { j = JSON.parse(txt); } catch (e) {}
      if (r.status === 200 && j) {
        rec('mastodon', 'access_token（工作区）', 'ok',
          'HTTP 200 · @' + (j.acct || j.username) + ' · 发帖 ' + (j.statuses_count != null ? j.statuses_count : '?') +
          ' · 关注 ' + (j.following_count != null ? j.following_count : '?'));
      } else {
        rec('mastodon', 'access_token（工作区）', 'invalid',
          'HTTP ' + r.status + ' · ' + String(txt).replace(/\s+/g, ' ').slice(0, 120));
      }
    } catch (e) {
      rec('mastodon', 'access_token（工作区）', 'unknown', '请求异常: ' + e.message.slice(0, 120));
    }

    // 对照：provider 实读的那个占位值
    if (live && live.accessToken && live.accessToken !== creds.access_token) {
      try {
        const r2 = await fetchExt(inst + '/api/v1/accounts/verify_credentials', {
          method: 'GET',
          headers: { Authorization: 'Bearer ' + live.accessToken, 'User-Agent': 'MSCMS/1.0' },
          timeout: 25000,
        });
        rec('mastodon', 'accessToken（provider 读的）', r2.status === 200 ? 'ok' : 'invalid',
          'HTTP ' + r2.status + ' ' + mask(live.accessToken));
      } catch (e) {
        rec('mastodon', 'accessToken（provider 读的）', 'invalid', 'HTTP 异常/401 · ' + mask(live.accessToken));
      }
    }
  }

  console.log('\n══════════ 2. Bluesky ══════════');
  const bs = unwrap(readJson(path.join(DATA, 'bluesky_config.json')));
  if (!bs) {
    console.log('  bluesky_config.json 不存在');
  } else {
    console.log('  identifier: ' + bs.identifier);
    console.log('  appPassword: ' + mask(bs.appPassword) + '   ← 正确格式为 abcd-efgh-ijkl-mnop 共 19 字符');
    const fmtOk = /^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/i.test(String(bs.appPassword || ''));
    if (!fmtOk) {
      rec('bluesky', 'appPassword', 'format',
        '格式不符（' + String(bs.appPassword || '').length + ' 字符），未发起网络请求 —— 占位值无需验证');
    } else {
      try {
        const r = await fetchExt('https://bsky.social/xrpc/com.atproto.server.createSession', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'MSCMS/1.0' },
          body: JSON.stringify({ identifier: bs.identifier, password: bs.appPassword }),
          timeout: 30000,
        });
        const txt = await r.text();
        rec('bluesky', 'appPassword', r.status === 200 ? 'ok' : 'invalid', 'HTTP ' + r.status + ' · ' + String(txt).slice(0, 140));
      } catch (e) {
        rec('bluesky', 'appPassword', 'unknown', '请求异常: ' + e.message.slice(0, 120));
      }
    }
  }

  console.log('\n══════════ 3. Nostr ══════════');
  const ns = unwrap(readJson(path.join(DATA, 'nostr_config.json')));
  if (!ns) console.log('  nostr_config.json 不存在');
  else {
    const pk = String(ns.privateKey || '');
    const isNsec = /^nsec1[a-z0-9]{58}$/i.test(pk);
    console.log('  privateKey: ' + mask(pk) + '  (nsec 规范长度 63)');
    rec('nostr', 'privateKey', isNsec ? 'ok' : 'format', isNsec ? 'bech32 nsec 格式合法' : '格式不符');
    let keys = null;
    try { keys = require('../providers/nostr-provider.js'); } catch (e) {}
    try {
      const { schnorr } = require('@noble/curves/secp256k1');
      // 不做签名，只确认依赖可加载（真实签名验证由 provider 的 verifyCredentials 负责）
      rec('nostr', 'schnorr 依赖', schnorr && typeof schnorr.sign === 'function' ? 'ok' : 'invalid',
        'secp256k1 schnorr ' + (schnorr ? '可用' : '不可用'));
    } catch (e) {
      rec('nostr', 'schnorr 依赖', 'invalid', e.message.slice(0, 100));
    }
    console.log('  relays: ' + String(ns.relays || '').slice(0, 70));
  }

  console.log('\n══════════ 汇总 ══════════');
  const ok = results.filter((r) => r.verdict === 'ok').length;
  console.log('  有效 ' + ok + ' / 共 ' + results.length + ' 项');
  results.forEach((r) => console.log('   [' + r.verdict + '] ' + r.platform + ' · ' + r.field + ' — ' + r.detail));
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
