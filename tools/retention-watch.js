#!/usr/bin/env node
'use strict';
/*
 * OYours / MSCMS v14 — P1.3b 留存巡检（自包含实现）
 * ----------------------------------------------------------------------------
 * V15-plan P1.3 要求：每日扫各平台已发帖，检测被删 / 被标违规 / shadowban，告警入栈。
 * 原意图接入 content-gate.js 的 incidents 入栈，但 content-gate.js 在 C: 快照中语法破损，
 * 故本模块**自包含**：直接读权威 publish.json，做三类检测，告警追加写
 * D:/mscms-ws/data/incidents.jsonl（level=warn/critical）。
 *
 * 检测维度：
 *   1. 缺失 publish_url         -> critical（发布本身失败，判成败只看 publish_url）
 *   2. content_title 异常标记    -> critical（如 "400 Bad Request" 等错误页标题）
 *   3. 可疑 shadowban           -> warn（url 存在但 reach/likes 恒为 0，且无任何回收记录）
 *   4. --verify 联网核验         -> 实际 GET publish_url，404/410/403 => 已删/被封
 *
 * 用法：
 *   node tools/retention-watch.js --dry
 *   node tools/retention-watch.js --apply
 *   node tools/retention-watch.js --apply --verify          # 联网核验（需可达网络）
 *   node tools/retention-watch.js --apply --platform=tumblr
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.MSCMS_DATA_DIR || 'D:/mscms-ws/data';
const PUBLISH_FILE = path.join(DATA_DIR, 'publish.json');
const INCIDENTS_FILE = path.join(DATA_DIR, 'incidents.jsonl');

const SUSPICIOUS_TITLES = /400 bad request|401|403|404|500|error|undefined|null|NaN/i;

function loadPublish(file) {
  if (!fs.existsSync(file)) {
    console.error(`[retention-watch] 发布账本不存在: ${file}`);
    process.exit(2);
  }
  const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(arr) ? arr : [];
}

function detect(entry, { verifyResult }) {
  const incidents = [];
  const pid = entry.id;
  const platform = entry.platform;
  const account = entry.account_id;

  // 1. 缺失 publish_url
  if (!entry.publish_url || !/^https?:\/\//i.test(entry.publish_url)) {
    incidents.push({
      level: 'critical', kind: 'missing_publish_url',
      detail: `发布账本条目无有效 publish_url（判成败只看 publish_url）`,
    });
    return incidents; // 无 url 后续核验无意义
  }

  // 2. content_title 异常
  if (entry.content_title && SUSPICIOUS_TITLES.test(String(entry.content_title))) {
    incidents.push({
      level: 'critical', kind: 'error_title',
      detail: `content_title 疑似错误页: "${entry.content_title}"`,
    });
  }

  // 3. 可疑 shadowban：reach/likes 恒 0 且从未回收
  const reach = Number(entry.reach) || 0;
  const likes = Number(entry.likes) || 0;
  const recycled = entry.metrics_recycled_at && entry.metrics_recycled_at !== null;
  if (reach === 0 && likes === 0 && !recycled) {
    incidents.push({
      level: 'warn', kind: 'suspect_shadowban',
      detail: `url 存在但 reach/likes 恒为 0 且无回收记录，疑似 shadowban/零触达`,
    });
  }

  // 4. 联网核验结果
  if (verifyResult) {
    if (verifyResult.status === 'deleted') {
      incidents.push({ level: 'critical', kind: 'post_deleted', detail: `核验返回 ${verifyResult.code}，疑似已删除/被封` });
    } else if (verifyResult.status === 'forbidden') {
      incidents.push({ level: 'critical', kind: 'post_forbidden', detail: `核验返回 ${verifyResult.code}，疑似被封/需鉴权` });
    } else if (verifyResult.status === 'error') {
      incidents.push({ level: 'warn', kind: 'verify_error', detail: `核验失败: ${verifyResult.err}` });
    }
  }
  return incidents;
}

async function verifyUrl(url) {
  // 最佳努力 GET；超时 4s。注意：本机出口经 10808 单点可能不稳，失败只记 warn。
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: ctrl.signal });
    clearTimeout(t);
    if (res.status === 404 || res.status === 410) return { status: 'deleted', code: res.status };
    if (res.status === 401 || res.status === 403) return { status: 'forbidden', code: res.status };
    if (res.status >= 500) return { status: 'error', code: res.status, err: 'server_error' };
    return { status: 'ok', code: res.status };
  } catch (e) {
    clearTimeout(t);
    return { status: 'error', code: 0, err: String(e.message || e) };
  }
}

async function run({ dry, apply, verify, platform }) {
  const arr = loadPublish(PUBLISH_FILE);
  let scanned = 0, flagged = 0, critical = 0, warn = 0;
  const buffer = [];
  for (const e of arr) {
    if (platform && platform !== 'all' && e.platform !== platform) continue;
    scanned++;
    const verifyResult = verify ? await verifyUrl(e.publish_url) : null;
    const inc = detect(e, { verifyResult });
    for (const it of inc) {
      flagged++;
      if (it.level === 'critical') critical++;
      else warn++;
      const rec = {
        ts: new Date().toISOString(),
        tool: 'retention-watch',
        level: it.level,
        kind: it.kind,
        platform: e.platform,
        account_id: e.account_id,
        publish_id: e.id,
        publish_url: e.publish_url || null,
        detail: it.detail,
      };
      buffer.push(rec);
    }
  }
  const summary = { scanned, flagged, critical, warn, mode: dry ? 'dry' : 'apply', verify: !!verify, platform: platform || 'all' };
  console.log('[retention-watch]', JSON.stringify(summary));

  if (dry) {
    if (flagged) console.log('[retention-watch] --dry 命中样例:', JSON.stringify(buffer.slice(0, 3), null, 2));
    console.log('[retention-watch] --dry：未写 incidents.jsonl');
    return summary;
  }
  // apply：追加写 incidents.jsonl
  if (buffer.length) {
    const line = buffer.map((r) => JSON.stringify(r)).join('\n') + '\n';
    fs.appendFileSync(INCIDENTS_FILE, line);
    console.log(`[retention-watch] 已追加 ${buffer.length} 条告警 -> ${INCIDENTS_FILE}`);
  } else {
    console.log('[retention-watch] 无新增告警');
  }
  return summary;
}

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const dry = args.includes('--dry');
    const apply = args.includes('--apply');
    const verify = args.includes('--verify');
    const pArg = args.find((a) => a.startsWith('--platform='));
    const platform = pArg ? pArg.split('=')[1] : 'all';
    if (!dry && !apply) {
      console.error('用法: node tools/retention-watch.js --dry | --apply [--verify] [--platform=tumblr|all]');
      process.exit(1);
    }
    await run({ dry, apply, verify, platform });
  })();
}

module.exports = { detect, verifyUrl, loadPublish, run };
