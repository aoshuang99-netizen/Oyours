#!/usr/bin/env node
/**
 * real-dau.js —— 真实 DAU 统计（唯一口径：剔除一切自驱流量）
 *
 * 背景（2026-09-24 实测）：
 *   D:/mscms-ws/data/analytics.json 全量 1130 条 ip 字段【全部】为 'self_direct'；
 *   link_traffic.json / traffic_click_logs.json 亦如此；dau_log.json 历史 realDAU 峰值 = 0。
 *   ⇒ 站点上「看起来的访问」100% 是系统自驱（模拟/回放），真实人类访客为 0。
 *
 * 本脚本的价值：把「真实」这件事变成可复算的断言，让日报无法把自驱流量算成成绩。
 *
 * 真实访客判据（三条同时成立）:
 *   1) ip 字段非空
 *   2) ip 不匹配 SELF_RE（self_ 系 / system 系 / unknown / local 系 / test 系 / 回环 / 内网段）
 *   3) country 字段不为 self_direct / system / unknown / 空
 *
 * 数据源:
 *   · analytics.json          站点访问（含 source/landing_page/content_id）
 *   · link_traffic.json       短链点击
 *   · traffic_click_logs.json 短链点击（老表）
 *   · dau_log.json            历史 DAU 序列（realDAU vs systemDAU）
 *   · :8001 /api/v1/admin/stats  kkmatch 真实注册用户（若服务在线）
 *
 * 用法:
 *   node tools/real-dau.js                 # 今天
 *   node tools/real-dau.js --date 2026-09-23
 *   node tools/real-dau.js --days 7        # 近 7 天趋势
 *   node tools/real-dau.js --json          # 只输出 JSON
 *   node tools/real-dau.js --out reports/  # 同时落盘 md + json
 */
const fs = require('fs');
const path = require('path');

const DATA = process.env.DATA_DIR || 'D:/mscms-ws/data';
const KKM = 'http://:8001';

const SELF_RE = /^(self|system|unknown|local|test|internal|none|null|undefined|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|0\.0\.0\.0)/i;

 arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}
const has = (n) => process.argv.includes('--' + n);

 readJson(f) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch (e) { return null; }
}
 toArr(j) {
  if (!j) return [];
  if (Array.isArray(j)) return j;
  return Object.values(j);
}
 dayKey(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v).slice(0, 10);
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}
 isReal(rec) {
  const ip = rec.ip;
  if (ip === undefined || ip === null || String(ip).trim() === '') return false;
  if (SELF_RE.test(String(ip).trim())) return false;
  const c = String(rec.country || '').trim();
  if (!c || /^(self|system|unknown|none|null)$/i.test(c)) return false;
  return true;
}

 todayStr() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

 summarize(records, tsField, date) {
  const inDay = records.filter((r) => dayKey(r[tsField]) === date);
  const real = inDay.filter(isReal);
  const uniq = new Set(real.map((r) => String(r.ip)));
  const bySource = {};
  const byLanding = {};
  real.forEach((r) => {
    const s = r.source || r. || '(direct)';
    bySource[s] = (bySource[s] || 0) + 1;
    if (r.landing_page) byLanding[r.landing_page] = (byLanding[r.landing_page] || 0) + 1;
  });
  return {
    total_records: inDay.length,
    real_records: real.length,
    real_unique_visitors: uniq.size,
    self_records: inDay.length - real.length,
    self_ratio: inDay.length ? +(1 - real.length / inDay.length).toFixed(4) : 0,
    by_source: bySource,
    top_landing: Object.entries(byLanding).sort((a, b) => b[1] - a[1]).slice(0, 10),
  };
}

async  kkmatchStats() {
  try {
    const r = await fetch(KKM + '/api/v1/admin/stats', { signal: AbortSignal.timeout(5000) });
    return await r.json();
  } catch (e) { return null; }
}

(async () => {
  const date = String(arg('date', todayStr()));
  const days = parseInt(arg('days', '7'), 10) || 7;
  const onlyJson = has('json');
  const outDir = arg('out', null);

  const analytics = toArr(readJson('analytics.json'));
  const linkTraffic = toArr(readJson('link_traffic.json'));
  const clickLogs = toArr(readJson('traffic_click_logs.json'));
  const dauLog = toArr(readJson('dau_log.json'));

  const A = summarize(analytics, 'createdAt', date);
  const L = summarize(linkTraffic, 'ts', date);
  const C = summarize(clickLogs, 'createdAt', date);

  // 近 N 天趋势（真实 UV）
  const trend = [];
  const base = new Date(date + 'T00:00:00');
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(base.getTime() - i * 86400000);
    const k = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    const a = summarize(analytics, 'createdAt', k);
    const l = summarize(linkTraffic, 'ts', k);
    trend.push({ date: k, site_real_uv: a.real_unique_visitors, site_total: a.total_records, click_real_uv: l.real_unique_visitors, click_total: l.total_records });
  }

  // dau_log 真实序列：dau_log.json 是混合 schema 的时间序列（老记录没有 realDAU），
  // 必须【回溯】取最近一条真正带 realDAU 的记录，不能盲取最后一条。
  let lastDau = null;
  for (let i = dauLog.length - 1; i >= 0; i--) {
    if (dauLog[i] && Object.prototype.hasOwnProperty.call(dauLog[i], 'realDAU')) { lastDau = dauLog[i]; break; }
  }
  const realPeak = dauLog.length ? Math.max(0, ...dauLog.map((x) => Number(x && x.realDAU) || 0)) : 0;

  const kk = await kkmatchStats();

  const result = {
    generated_at: new Date().toISOString(),
    date,
    verdict: (A.real_unique_visitors + L.real_unique_visitors + C.real_unique_visitors) > 0 ? 'REAL_TRAFFIC_PRESENT' : 'NO_REAL_TRAFFIC',
    site: A,
    shortlink: L,
    click_logs: C,
    trend,
    dau_log_latest: lastDau,
    dau_log_real_peak: realPeak,
    kkmatch_backend: kk,
    note: 'real = ip 非空 且 非 self/system/unknown/local/test/内网 且 country 非 self_direct/system',
  };

  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, `real-dau-${date}.json`), JSON.stringify(result, null, 2), 'utf8');
  }

  if (onlyJson) { console.log(JSON.stringify(result, null, 2)); return; }

  const md = [];
  md.push(`# 真实 DAU 口径核对 · ${date}`);
  md.push('');
  md.push(`**结论：${result.verdict}**  ·  生成于 ${result.generated_at}`);
  md.push('');
  md.push('## 1. 站点访问');
  md.push('');
  md.push('| 指标 | 数值 |');
  md.push('|---|---|');
  md.push(`| 当日总记录 | ${A.total_records} |`);
  md.push(`| **真实访客(去重 IP)** | **${A.real_unique_visitors}** |`);
  md.push(`| 真实记录数 | ${A.real_records} |`);
  md.push(`| 自驱记录数 | ${A.self_records} |`);
  md.push(`| 自驱占比 | ${(A.self_ratio * 100).toFixed(2)}% |`);
  md.push('');
  md.push('## 2. 短链点击');
  md.push('');
  md.push('| 指标 | link_traffic | traffic_click_logs |');
  md.push('|---|---|---|');
  md.push(`| 总记录 | ${L.total_records} | ${C.total_records} |`);
  md.push(`| **真实访客** | **${L.real_unique_visitors}** | **${C.real_unique_visitors}** |`);
  md.push(`| 自驱占比 | ${(L.self_ratio * 100).toFixed(2)}% | ${(C.self_ratio * 100).toFixed(2)}% |`);
  md.push('');
  md.push(`## 3. 近 ${days} 天趋势`);
  md.push('');
  md.push('| 日期 | 站点真实UV | 站点总记录 | 点击真实UV | 点击总记录 |');
  md.push('|---|---|---|---|---|');
  trend.forEach((t) => md.push(`| ${t.date} | ${t.site_real_uv} | ${t.site_total} | ${t.click_real_uv} | ${t.click_total} |`));
  md.push('');
  md.push('## 4. dau_log 系统口径');
  md.push('');
  if (lastDau) {
    md.push(`- 最新一期：realDAU=${lastDau.realDAU} · systemDAU=${lastDau.systemDAU} · target=${lastDau.targetDAU}`);
    md.push(`- 目标值来源：\`${lastDau.targetSource || '-'}\``);
    md.push(`- 口径来源：\`${lastDau.dauSource || '-'}\``);
  } else { md.push('- 无 dau_log 记录'); }
  md.push(`- **历史 realDAU 峰值 = ${realPeak}**（>0 才算出现过真实流量）`);
  md.push('');
  md.push('## 5. kkmatch 后端真实注册');
  md.push('');
  if (kk) {
    md.push(`- total_users=${kk.total_users} · daily_active=${kk.daily_active} · total_events=${kk.total_events} · total_matches=${kk.total_matches}`);
  } else { md.push('- :8001 未响应（后端未在线）'); }
  md.push('');
  md.push('> 口径说明：real = `ip` 非空 且 不匹配 `self/system/unknown/local/test/内网段` 且 `country` 非 `self_direct/system`。');
  md.push('> 任何把 self_direct 计入成绩的日报都是假达标。');

  const text = md.join('\n');
  if (outDir) {
    fs.writeFileSync(path.join(outDir, `real-dau-${date}.md`), text, 'utf8');
    console.log(`[real-dau] 已写出 ${path.join(outDir, `real-dau-${date}.md`)}`);
  }
  console.log(text);
})();
