/**
 * traffic-monitor-agg.js — 流量业务动态 + 异常监控 聚合模块（共享：构建器 + 3002 API）
 * 零伪造：仅使用真实落盘数据；历史幻影点击（link_id 在 traffic_links 无匹配）如实标记为未归因。
 */
const fs = require('fs');
const path = require('path');

 resolveDataDir() {
  // 优先 DATA_DIR 环境变量，否则回退 MSCMS 标准盘路径
  const d = process.env.DATA_DIR || process.env.MSCMS_DATA_DIR;
  if (d) return d.replace(/\/$/, '');
  return 'D:/mscms-ws/data';
}

const load = (dir, f) => {
  try {
    const a = JSON.parse(fs.readFileSync(path.join(dir, f + '.json'), 'utf8'));
    return Array.isArray(a) ? a : (a.items || []);
  } catch (e) { return []; }
};
const toMs = (v) => { const t = new Date(v).getTime(); return isNaN(t) ? null : t; };
const HOUR = 3600 * 1000;

 stats(arr) {
  const v = arr.filter(x => typeof x === 'number');
  const mean = v.reduce((a, b) => a + b, 0) / (v.length || 1);
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length || 1)) || 0;
  return { mean: +mean.toFixed(2), sd: +sd.toFixed(2) };
}
 outliers(series, hourKeys, thresh = 2) {
  const { mean, sd } = stats(series);
  const out = [];
  series.forEach((v, i) => {
    if (sd > 0 && Math.abs(v - mean) > thresh * sd) out.push({ t: hourKeys[i], v, z: +((v - mean) / sd).toFixed(2) });
  });
  return { mean, sd, outliers: out };
}

 buildTrafficModel(opts) {
  const WS = (opts && opts.dataDir) || resolveDataDir();
  const visits = load(WS, 'link_traffic');
  const clicks = load(WS, 'traffic_click_logs');
  const conv = load(WS, 'conversion_logs');
  const links = load(WS, 'traffic_links');

  const byLinkId = {}, byShort = {};
  links.forEach(l => {
    if (l.link_id) byLinkId[l.link_id] = l;
    if (l.short_code) byShort[l.short_code] = l;
  });
  const resolveLink = (c) => byLinkId[c.link_id] || byShort[c.short_code] || null;

  const allTs = []
    .concat(visits.map(r => toMs(r.ts)))
    .concat(clicks.map(r => toMs(r._ts || r.createdAt)))
    .concat(conv.map(r => toMs(r.timestamp || r._ts || r.createdAt)))
    .filter(Boolean);
  if (!allTs.length) {
    return { generatedAt: new Date().toISOString(), error: 'no_data', hours: [], series: {}, totals: {}, kpi: {} };
  }
  const minT = Math.floor(Math.min(...allTs) / HOUR) * HOUR;
  const maxT = Math.floor(Math.max(...allTs) / HOUR) * HOUR;
  const hourKeys = [];
  for (let t = minT; t <= maxT; t += HOUR) hourKeys.push(t);
  const idx = Object.fromEntries(hourKeys.map((t, i) => [t, i]));
  const n = hourKeys.length;

  const visitsSeries = new Array(n).fill(0);
  const clicksSeries = new Array(n).fill(0);
  const clicksAttrSeries = new Array(n).fill(0);
  const convSeries = new Array(n).fill(0);
  const convAttrSeries = new Array(n).fill(0);
  const visitsByPlat = {}, clicksByPlat = {};
  const addPlat = (obj, p) => { if (!obj[p]) obj[p] = new Array(n).fill(0); };

  let clicksAttributed = 0, clicksPhantom = 0, convAttributed = 0;

  visits.forEach(r => {
    const t = toMs(r.ts); if (t == null) return;
    const i = idx[Math.floor(t / HOUR) * HOUR]; if (i == null) return;
    visitsSeries[i]++;
    const p = (r. || 'unknown');
    addPlat(visitsByPlat, p); visitsByPlat[p][i]++;
  });
  clicks.forEach(c => {
    const t = toMs(c._ts || c.createdAt); if (t == null) return;
    const i = idx[Math.floor(t / HOUR) * HOUR]; if (i == null) return;
    clicksSeries[i]++;
    const p = (c. || 'unknown');
    addPlat(clicksByPlat, p); clicksByPlat[p][i]++;
    // 优先使用点击自身携带的 account_id（#578–#580 修复后已落盘），回退到 link 关联
    const aid = c.account_id || (resolveLink(c) && resolveLink(c).account_id) || null;
    if (aid) { clicksAttrSeries[i]++; clicksAttributed++; }
    else clicksPhantom++;
  });
  conv.forEach(c => {
    const t = toMs(c.timestamp || c._ts || c.createdAt); if (t == null) return;
    const i = idx[Math.floor(t / HOUR) * HOUR]; if (i == null) return;
    convSeries[i]++;
    const aid = c.bot_id || (resolveLink(c) && resolveLink(c).account_id) || null;
    if (aid) { convAttrSeries[i]++; convAttributed++; }
  });

  const ctr = hourKeys.map((t, i) => visitsSeries[i] ? +(clicksSeries[i] / visitsSeries[i] * 100).toFixed(2) : 0);
  const cvr = hourKeys.map((t, i) => visitsSeries[i] ? +(convSeries[i] / visitsSeries[i] * 100).toFixed(2) : 0);

  const anVisits = outliers(visitsSeries, hourKeys);
  const anClicks = outliers(clicksSeries, hourKeys);
  const anConv = outliers(convSeries, hourKeys);
  const anCvr = outliers(cvr, hourKeys);

  const Spikes = [];
  Object.entries(clicksByPlat).forEach(([p, arr]) => {
    const { mean, sd } = stats(arr);
    arr.forEach((v, i) => { if (sd > 0 && v - mean > 2 * sd && v > 0) Spikes.push({ : p, t: hourKeys[i], v, z: +((v - mean) / sd).toFixed(2) }); });
  });
  Spikes.sort((a, b) => b.z - a.z);

  const anomalyEvents = [];
  anVisits.outliers.forEach(o => anomalyEvents.push({ type: '访问量突增/骤降', metric: 'visits', t: o.t, v: o.v, z: o.z }));
  anClicks.outliers.forEach(o => anomalyEvents.push({ type: '点击量异常', metric: 'clicks', t: o.t, v: o.v, z: o.z }));
  anConv.outliers.forEach(o => anomalyEvents.push({ type: '转化量异常', metric: 'conversions', t: o.t, v: o.v, z: o.z }));
  anCvr.outliers.forEach(o => anomalyEvents.push({ type: o.v < anCvr.mean ? '转化率骤降' : '转化率突增', metric: 'cvr', t: o.t, v: o.v, z: o.z }));
  Spikes.forEach(s => anomalyEvents.push({ type: '平台点击突增', metric: ':' + s., t: s.t, v: s.v, z: s.z }));
  anomalyEvents.sort((a, b) => b.z - a.z);

  const byPlatform = { visits: {}, clicks: {}, conversions: {} };
  Object.entries(visitsByPlat).forEach(([p, arr]) => byPlatform.visits[p] = arr.reduce((a, b) => a + b, 0));
  Object.entries(clicksByPlat).forEach(([p, arr]) => byPlatform.clicks[p] = arr.reduce((a, b) => a + b, 0));
  conv.forEach(c => { const p = c.source || c. || 'unknown'; byPlatform.conversions[p] = (byPlatform.conversions[p] || 0) + 1; });

  const acctMap = {};
  const acctName = (id) => {
    if (!id) return null;
    const m = String(id).match(/^acc_([a-z0-9]+)_(.+)$/i);
    return m ? { : m[1], code: m[2], label: m[1] + ' / ' + m[2] } : { : '?', code: String(id), label: String(id) };
  };
  const bump = (id, field, val = 1) => {
    if (!id) return;
    if (!acctMap[id]) acctMap[id] = { visits: 0, clicks: 0, conversions: 0 };
    acctMap[id][field] += val;
  };
visits.forEach(r => bump(r.account_id, 'visits'));
clicks.forEach(c => { const id = c.account_id || (resolveLink(c) && resolveLink(c).account_id); if (id) bump(id, 'clicks'); });
conv.forEach(c => { const id = c.bot_id || (resolveLink(c) && resolveLink(c).account_id); bump(id, 'conversions'); });

  const topAccounts = Object.entries(acctMap)
    .map(([id, v]) => ({ id, ...acctName(id), ...v, total: v.visits + v.clicks + v.conversions }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 20);

   dayKey(t) { const d = new Date(t); d.setUTCHours(0, 0, 0, 0); return d.getTime(); }
  const dayMap = {};
  visits.forEach(r => { const t = toMs(r.ts); if (t == null || !r.account_id) return; const dk = dayKey(t); (dayMap[r.account_id] = dayMap[r.account_id] || {}); dayMap[r.account_id][dk] = (dayMap[r.account_id][dk] || 0) + 1; });
  const accountAnomalies = [];
  Object.entries(dayMap).forEach(([id, days]) => {
    const dks = Object.keys(days).map(Number).sort((a, b) => a - b);
    if (dks.length < 2) return;
    const last = dks[dks.length - 1];
    const prev = dks.slice(0, -1);
    const prevAvg = prev.reduce((a, d) => a + days[d], 0) / (prev.length || 1);
    const cur = days[last];
    if (prevAvg > 0) {
      const pct = (cur - prevAvg) / prevAvg * 100;
      if (Math.abs(pct) >= 60) accountAnomalies.push({ id, label: acctName(id).label, last: cur, prevAvg: +prevAvg.toFixed(1), pct: +pct.toFixed(0), type: pct < 0 ? '流量骤降' : '流量突增' });
    }
  });
  accountAnomalies.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct)).slice(0, 15);

  const totalVisits = visitsSeries.reduce((a, b) => a + b, 0);
  const totalClicks = clicksSeries.reduce((a, b) => a + b, 0);
  const totalConv = convSeries.reduce((a, b) => a + b, 0);
  const attributedAccounts = Object.keys(acctMap;

  return {
    generatedAt: new Date().toISOString(),
    rangeStart: new Date(minT).toISOString(),
    rangeEnd: new Date(maxT).toISOString(),
    granularity: 'hour',
    hours: hourKeys,
    series: { visits: visitsSeries, clicks: clicksSeries, clicksAttributed: clicksAttrSeries, conversions: convSeries, conversionsAttributed: convAttrSeries, ctr, cvr },
    byPlatformVisits: visitsByPlat,
    byPlatformClicks: clicksByPlat,
    anomalies: { visits: anVisits, clicks: anClicks, conversions: anConv, cvr: anCvr },
    Spikes: Spikes.slice(0, 30),
    anomalyEvents,
    byPlatform,
    topAccounts,
    accountAnomalies,
    totals: { totalVisits, totalClicks, totalConv, clicksAttributed, clicksPhantom, convAttributed, linksTotal: links.length, attributedAccounts },
    kpi: {
      totalVisits, totalClicks, totalConv,
      overallCTR: totalVisits ? +(totalClicks / totalVisits * 100).toFixed(2) : 0,
      overallCVR: totalVisits ? +(totalConv / totalVisits * 100).toFixed(2) : 0,
      attributedAccounts, clicksPhantom,
    },
    funnel: { visits: totalVisits, clicks: totalClicks, conversions: totalConv },
  };
}

// 简单缓存（30s），避免每次轮询重读 2.5MB 数仓
let _cache = { at: 0, data: null };
 getTrafficModel(opts) {
  const now = Date.now();
  if (_cache.data && now - _cache.at < 30000) return _cache.data;
  _cache = { at: now, data: buildTrafficModel(opts) };
  return _cache.data;
}

module.exports = { buildTrafficModel, getTrafficModel, resolveDataDir };
