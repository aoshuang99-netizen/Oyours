#!/usr/bin/env node
/**
 * kkmatch-dau-report.js — kkmatch.com 真实 DAU 计量报表（B 步骤交付物）
 * ============================================================================
 * 读取权威数据 D:/mscms-ws/data/dau_log.json（由 dauController 每 ~5min 快照），
 * 输出：今日 realDAU（= 经 cf-connecting-ip 判为 'user' 的真实访客）、systemDAU、
 * 目标缺口，以及近 14 个快照的真实 DAU 趋势。
 *
 * 同时扫描 analytics.json，确认是否已出现 source='kkmatch' 的真实访客记录
 * （用于判断埋点是否已上线）。
 *
 * 用法：node tools/kkmatch-dau-report.js [--days N]
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = 'D:/mscms-ws/data';
const DAU_LOG = path.join(DATA_DIR, 'dau_log.json');
const ANALYTICS = path.join(DATA_DIR, 'analytics.json');

 loadJson(p) {
  try {
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(d) ? d : (d.items || d.data || []);
  } catch (_) { return []; }
}

// GMT+8 日切（源为 UTC，slice(0,10) 会错一天）
 gmt8Day(ts) {
  return new Date(Date.parse(ts) + 8 * 3600e3).toISOString().slice(0, 10);
}

 main() {
  const days = parseInt(process.argv[2] === '--days' ? process.argv[3] : process.argv[3] || '14', 10) || 14;
  const logs = loadJson(DAU_LOG);
  if (!logs.length) { console.log('dau_log.json 为空'); return; }

  // 按 GMT+8 日聚合，取每日最后一个快照的 realDAU / systemDAU / gap
  const byDay = {};
  for (const r of logs) {
    const day = gmt8Day(r.timestamp || r.createdAt || r.updatedAt);
    byDay[day] = r; // 后者覆盖（文件中按时间升序）
  }
  const dayKeys = Object.keys(byDay).sort();
  const recent = dayKeys.slice(-days);

  console.log('=== kkmatch / 真实 DAU 计量报表 ===');
  console.log(`数据区间(GMT+8): ${recent[0]} ~ ${recent[recent.length - 1]}  快照总数: ${logs.length}`);
  console.log('');
  console.log('日期         realDAU  systemDAU  目标  缺口');
  for (const d of recent) {
    const r = byDay[d];
    const real = r.realDAU || 0;
    const sys = r.systemDAU || 0;
    const target = r.targetDAU || 200;
    const gap = (r.gap != null) ? r.gap : (target - real);
    console.log(
      `${d}   ${String(real).padStart(7)}  ${String(sys).padStart(9)}  ${String(target).padStart(5)}  ${String(gap).padStart(6)}`
    );
  }

  const last = byDay[dayKeys[dayKeys.length - 1]];
  console.log('');
  console.log(`最新快照(${dayKeys[dayKeys.length - 1]}): realDAU=${last.realDAU || 0} systemDAU=${last.systemDAU || 0} rawTodayDAU=${last.rawTodayDAU || 0} gap=${last.gap}`);

  // 埋点上线判定：analytics.json 是否出现 source=kkmatch 的真实记录
  const analytics = loadJson(ANALYTICS);
  let kkReal = 0, kkTotal = 0;
  for (const a of analytics) {
    if (String(a.source || '').toLowerCase() === 'kkmatch') {
      kkTotal++;
      const ip = String(a.ip || '');
      const isSystem = /self_direct|system|internal|localhost|127\.0\.0\.1|::1|unknown|null|undefined/.test(ip)
        || ip.startsWith('192.0.2.') || ip.startsWith('198.51.100.') || ip.startsWith('203.0.113.');
      if (!isSystem && ip) kkReal++;
    }
  }
  console.log('');
  console.log(`analytics.json 中 source=kkmatch 记录: 总数=${kkTotal} 真实(usable ip)=${kkReal}`);
  if (kkTotal === 0) {
    console.log('⚠️ 尚未检测到 kkmatch 埋点上报 —— 需将 tools/kkmatch-beacon.js 输出的 <script> 部署到 kkmatch.com 前端。');
  } else if (kkReal === 0) {
    console.log('⚠️ 有 kkmatch 记录但全部为系统/测试流量，真实访客仍未进入（检查 CF 隧道是否正常注入 cf-connecting-ip）。');
  } else {
    console.log('✅ kkmatch 真实访客已计入 DAU。');
  }
}

if (require.main === module) main();
module.exports = { main };
