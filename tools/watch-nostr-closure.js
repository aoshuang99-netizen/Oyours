#!/usr/bin/env node
/**
 * nostr 闭环监控（只读）
 * 每 8s 采样：publish.json 中 platform='nostr' 的记录数 + 3002 日志增量关键行。
 * 命中（出现真实 nostr 发布记录）或超时即退出。
 *
 * 用法：node tools/watch-nostr-closure.js [--max=360]
 */
const fs = require('fs');
const path = require('path');

const WS = path.join(__dirname, '..');
const LOGDIR = 'D:/mscms-ws/logs';
const MAX = (Number((process.argv.find((a) => a.startsWith('--max=')) || '--max=360').split('=')[1]) || 360) * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function latestLog() {
  try {
    const files = fs.readdirSync(LOGDIR).filter((f) => /^server-3002-.*\.log$/.test(f))
      .map((f) => ({ f, m: fs.statSync(path.join(LOGDIR, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    return files.length ? path.join(LOGDIR, files[0].f) : null;
  } catch (e) { return null; }
}

function rd(f) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(WS, 'data', f), 'utf8'));
    if (Array.isArray(raw)) return raw;
    if (raw && raw['0'] && typeof raw['0'] === 'object') return Object.values(raw['0']);
    return Object.values(raw).filter((x) => x && typeof x === 'object');
  } catch (e) { return []; }
}

(async () => {
  const t0 = Date.now();
  let logPath = latestLog();
  let offset = logPath ? fs.statSync(logPath).size : 0;
  const KEY = /nostr|provider 通道|逐通道选取|入队 \d+ 条内容|Unsupported platform|新通道保底配额/i;

  // ⚠️ 必须用「增量」而非「存在」作为退出条件：脚本可能是重启后运行的，
  // 此时 publish.json 里已有上一轮的历史 nostr 记录 ⇒ 用 `length > 0` 会**立刻误报成功**。
  const baseline = rd('publish.json').filter((p) => String(p.platform || '').toLowerCase() === 'nostr').length;
  console.log(`监控开始 ${new Date().toLocaleTimeString()} | 日志 ${logPath ? path.basename(logPath) : 'N/A'} | 基线 nostr 记录=${baseline}`);

  while (Date.now() - t0 < MAX) {
    await sleep(8000);

    // 日志增量（实例重启会切文件，故每轮重取）
    const cur = latestLog();
    if (cur && cur !== logPath) { logPath = cur; offset = 0; console.log(`  ↪ 日志切换 → ${path.basename(cur)}`); }
    if (logPath && fs.existsSync(logPath)) {
      const size = fs.statSync(logPath).size;
      if (size > offset) {
        const fd = fs.openSync(logPath, 'r');
        const buf = Buffer.alloc(size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        fs.closeSync(fd);
        offset = size;
        for (const l of buf.toString('utf8').split('\n')) {
          if (KEY.test(l)) console.log(`  [LOG ${new Date().toLocaleTimeString()}] ${l.trim().slice(0, 260)}`);
        }
      }
    }

    const pub = rd('publish.json').filter((p) => String(p.platform || '').toLowerCase() === 'nostr');
    const tot = rd('publish.json').length;
    console.log(`[${new Date().toLocaleTimeString()}] publish 总数=${tot} | nostr 记录=${pub.length}（基线 ${baseline}）`);

    if (pub.length > baseline) {
      console.log(`\n✅✅ 检测到**新增** ${pub.length - baseline} 条 nostr 真实发布记录：`);
      for (const p of pub.slice(baseline)) console.log('   ', JSON.stringify({ id: p.id, account: p.account_id, url: p.publish_url, at: p.published_at || p.publishedAt }));
      fs.writeFileSync(path.join(WS, 'reports', '_nostr-closure-result.json'),
        JSON.stringify({ at: new Date().toISOString(), ok: true, baseline, total: pub.length, records: pub }, null, 2), 'utf8');
      process.exit(0);
    }
  }
  console.log('\n⏱ 监控超时（未出现 nostr 发布记录）');
  process.exit(2);
})();
