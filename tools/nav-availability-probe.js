'use strict';
/**
 * nav-availability-probe.js — B4 导航四态徽标「实测依据」生成器
 *
 * 用途：对导航每一项的**主数据端点**做真实请求，据结果判定四态：
 *   🟢 live        200 且响应含非空真实数据
 *   🟡 degraded    200 有数据，但口径存疑（如读 MySQL 残留 / 混入模拟）
 *   ⚪ dormant     200 但恒空（空数组 / 全零 / 无支撑数据）
 *   🔴 unsupported 404 / 5xx（端点不存在或报错）
 *
 * 零伪造：只认 HTTP 状态 + 响应体实测，**不**从「配置存在」推断可用性。
 * 输出：reports/nav-availability.json（供报告审计）+ 控制台表格
 *
 * 用法：node tools/nav-availability-probe.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.MSCMS_PORT || 3002);
const TIMEOUT = Number(process.env.MSCMS_PROBE_TIMEOUT || 15000);
const OUT = path.join(__dirname, '..', 'reports', 'nav-availability.json');

/** 每个导航项 1 个主端点（后端视角的可用性代表） */
const PROBES = [
  { nav: 'dashboard',      label: '全域监控大盘',   ep: '/api/v14/dashboard' },
  { nav: '',       label: '账号注册',       ep: '/api/v14//stats' },
  { nav: 'nurture',        label: '拟人化养号',     ep: '/api/v14/tumblr/' },
  { nav: 'nurture.sub',    label: '真实养号进度',   ep: '/api/v14/module/nurture/detail' },
  { nav: 'accboard',       label: '账号看板',       ep: '/api/v14/real-' },
  { nav: 'accboard.sub1',  label: '真实账户信息',   ep: '/api/v14/managed-?source=live' },
  { nav: 'accboard.sub2',  label: 'Session管理',    ep: '/api/v14/session/stats' },
  { nav: 'msgcenter',      label: '消息/指令',      ep: '/api/v14/notifications' },
  { nav: 'remix',          label: '二次创作分发',   ep: '/api/v14/module/social/detail' },
  { nav: 'devices',        label: '设备启动',       ep: '/api/v14/devices' },
  { nav: 'devicefx.fp',    label: '指纹引擎',       ep: '/api/v14/module/fingerprint/detail' },
  { nav: 'devicefx.gps',   label: 'GPS轨迹',        ep: '/api/v14/gps/status' },
  { nav: 'devicefx.sensor',label: '传感器模拟',     ep: '/api/v14/sensor/dashboard' },
  { nav: 'proxy',          label: '代理管理',       ep: '/api/v14/proxy/list' },
  // 注意：/trending/search 是 POST-only，GET 用 /trending/intel（实测 50 条真数据）
  { nav: 'aifactory.intel',label: '内容情报',       ep: '/api/v14/trending/intel' },
  { nav: 'aifactory.aigc', label: 'AI内容生成',     ep: '/api/v14/module/aigc/detail' },
  { nav: 'aifactory.agnes',label: 'AI媒体生成',     ep: '/api/v14/module/intel/detail' },
  { nav: 'publish',        label: '智能发布',       ep: '/api/v14/module/publish/detail' },
  { nav: 'scrm',           label: 'SCRM截流',       ep: '/api/v14/scrm/stats' },
  { nav: 'marketing',      label: '主动营销',       ep: '/api/v14/module/marketing/detail' },
  // 注意：/dau/target 是 POST-only，GET 用 /dau/status（实测 currentDAU=12 running=true）
  { nav: 'dau',            label: 'DAU控制',        ep: '/api/v14/dau/status' },
  { nav: 'conv.overview',  label: '转化总览',       ep: '/api/v14/conversion/funnel' },
  { nav: 'conv.links',     label: '引流与短链',     ep: '/api/v14/traffic/links' },
  { nav: 'conv.detail',    label: '转化明细',       ep: '/api/v14/module/traffic/detail' },
  { nav: 'conv.experiments',label:'A/B实验',        ep: '/api/v14/experiments' },
  { nav: 'conv.attribution',label:'归因分析',       ep: '/api/v14/attribution/models' },
  { nav: 'conv.cloaking',  label: 'Cloaking',       ep: '/api/v14/cloaking/stats' },
  { nav: 'conv.alerts',    label: '告警规则',       ep: '/api/v14/alerts/stats' },
  { nav: 'insight.tracking',label:'数据追踪',       ep: '/api/v14/viral/scan' },
  { nav: 'insight.analytics',label:'网站分析',      ep: '/api/v14/analytics/stats' },
  { nav: 'decision',       label: '决策引擎',       ep: '/api/v14/decision/status' },
  { nav: 'tasks',          label: '任务管理',       ep: '/api/v14/tasks' },
  { nav: 'evolution',      label: '自进化',         ep: '/api/v14/evolution/strategies' },
  { nav: 'dag',            label: 'DAG编排',        ep: '/api/v14/dag/workflows' },
  { nav: 'users',          label: '系统用户管理',   ep: '/user-manager.html', isStatic: true },
];

/** 已知口径存疑项（有数据但不可全信）—— 标注为 degraded，理由写清 */
const DEGRADED_REASONS = {
  'accboard.sub1': '读 MySQL 残留表口径（与账号页 live 源 123 条不一致，已标 _archived）',
  'insight.analytics': '历史上混入过模拟访问（D4）；已加 provenance 分列，仍需观察',
  'aifactory.agnes': '以 intel 模块详情近似代表，非专属端点',
};

/**
 * 人工复核覆盖表 —— 探针启发式的**显式修正**。
 *
 * 为什么需要它：实测发现「有配置 ≠ 有运行数据」。端点可以返回
 * `rulesCount:6`（规则模板）或 `templatesCount:4` 却是零业务量，
 * 仅靠启发式会把「功能骨架」误判成「真实运行」。
 * 每一项都必须写明依据，禁止无理由覆盖。
 */
const STATE_OVERRIDES = {
  'accboard.sub2': {
    state: 'dormant',
    reason: 'totalBackups/activeSessions/totalDevices 全 0（实测 95B 全零响应），备份功能未产生过数据',
  },
  'conv.experiments': { state: 'dormant', reason: '空数组，未创建过任何 A/B 实验' },
  'conv.cloaking': { state: 'dormant', reason: 'totalRequests=0，仅有 4 个模板，从未接管过真实流量' },
  'conv.alerts': { state: 'dormant', reason: '告警事件 total=0（仅 6 条规则配置），从未触发过告警' },
  'insight.tracking': { state: 'dormant', reason: 'signals=0 / details=[]，病毒信号扫描无产出' },
  'devicefx.gps': { state: 'dormant', reason: 'activeTrajectories=[]，无活跃轨迹' },
  'devicefx.fp': {
    state: 'dormant',
    reason: '指纹版本数 0（/dashboard 的 fingerprint.devices=0），module/fingerprint/detail 亦为空',
  },
  'scrm': { state: 'dormant', reason: 'totalIntercepted=0，从未拦截过消息（仅有关键词等配置）' },
  'tasks': { state: 'degraded', reason: '队列长期为空，仅 1 条历史完成任务（功能可用但无运行量）' },
  '': {
    state: 'degraded',
    reason: 'stats 为会话内存计数器（重启即归零），未读 registration-ledger.jsonl（36 条真实台账）⇒ 页面显示 0 会误导',
  },
  'remix': {
    state: 'degraded',
    reason: 'stats.totalActions=0 却返回非空 records（19KB）—— stats 与 records 口径不一致，待核',
  },
  'marketing': {
    state: 'degraded',
    reason: 'totalCampaigns 等全 0，但 module detail 返回 50 条记录 —— 口径不一致，待核',
  },
  'conv.attribution': {
    state: 'live',
    reason: '返回 5 个归因模型定义（配置型端点：模型可选即功能可用；无运行数据不适用）',
  },
};

 get(pathname) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve({ ...r, ms: Date.now() - started }); } };
    let req;
    try {
      req = http.request({ host: '', port: PORT, path: pathname, method: 'GET', timeout: TIMEOUT }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { if (body.length < 400000) body += c; });
        res.on('end', () => done({ status: res.statusCode, body }));
      });
    } catch (e) { return done({ status: 0, body: '', err: e.code || e.message }); }
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} done({ status: 0, body: '', err: 'ETIMEDOUT' }); });
    req.on('error', (e) => done({ status: 0, body: '', err: e.code || e.message }));
    req.end();
  });
}

/**
 * 「配置型字段」黑名单 —— 它们的值反映「功能骨架已就绪」，**不是**运行数据。
 * 例：alerts/stats 的 rulesCount=6（6 条规则模板）却是 total=0（零告警事件）。
 * 若把配置计入证据，「有骨架无运行」会被误判成「真实运行」。
 */
const CONFIG_KEYS = new Set([
  'rulesCount', 'rulesEnabled', 'templatesCount', 'customPatterns', 'maxConcurrency',
  'nextTaskId', 'byTemplate', 'byLevel', 'byChannel', 'byType', 'byPlatform',
  'modules', 'keys', 'version', 'schema', 'config', 'settings', 'Weights',
  'keywords', 'enableAutoReply', 'Weights', 'hours', 'sensorIds',
]);

/**
 * 「元数据键」—— 它们的值只描述响应自身（模块名、标签、分页页号），
 * 与业务运行量无关。若不排除，一个空模块的 `label:"指纹引擎"` 会被
 * 当成"有内容"，把空页误判为真实运行（实测 fingerprint 即此情况）。
 */
const META_KEYS = new Set([
  'module', 'label', 'page', 'dataStoreModule', 'source', 'ts', 'timestamp',
  'probedAt', 'generatedAt', 'updatedAt', 'running', 'success',
]);

/** 判定「响应是否含真实运行数据」—— 全零 / 全空数组 / 仅配置项 都视为无内容 */
 hasContent(status, body) {
  if (status !== 200) return { content: false, reason: 'HTTP ' + status };
  if (!body) return { content: false, reason: '空响应体' };
  // HTML 静态页：有字节即算有内容
  if (/^\s*<!DOCTYPE|<html/i.test(body)) return { content: body.length > 500, reason: body.length > 500 ? '' : 'HTML 过短' };
  let j;
  try { j = JSON.parse(body); } catch (_) { return { content: body.length > 20, reason: '' }; }
  if (j == null) return { content: false, reason: 'null' };
  if (Array.isArray(j)) return { content: j.length > 0, reason: j.length ? '' : '空数组' };
  if (typeof j !== 'object') return { content: true, reason: '' };

  let numSum = 0, hasNonEmptyArray = false, scalarKeys = 0, configOnly = 0, errField = null;
  for (const [k, v] of Object.entries(j)) {
    if (v == null) continue;
    if (k === 'error' && v) errField = String(v);
    if (CONFIG_KEYS.has(k)) { configOnly++; continue; }          // 配置项不计入证据
    if (META_KEYS.has(k)) continue;                              // 元数据不计入证据
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      // records/rows/details 等可能是「历史留存」，仍算有数据；空数组不算
      hasNonEmptyArray = true; continue;
    }
    if (typeof v === 'number') {
      numSum += Math.abs(v);
      if (v !== 0) scalarKeys++;                                  // ← 零值不算证据（原缺陷）
      continue;
    }
    if (typeof v === 'boolean') continue;                         // 布尔不构成运行证据
    if (typeof v === 'string') { if (v.length > 0) scalarKeys++; continue; }
    if (typeof v === 'object') { if (Object.keys(v > 0) scalarKeys++; }
  }
  if (errField) return { content: false, reason: 'error: ' + errField.slice(0, 60) };
  const content = hasNonEmptyArray || numSum > 0 || scalarKeys > 0;
  if (!content && configOnly > 0) return { content: false, reason: '仅有 ' + configOnly + ' 项配置，无运行数据' };
  return { content, reason: content ? '' : '全零 / 全空' };
}

 classify(r) {
  if (r.status === 404 || r.status === 0 || r.status >= 500) {
    return { state: 'unsupported', icon: '🔴', label: '不可用', reason: r.err || ('HTTP ' + r.status) };
  }
  const hc = hasContent(r.status, r.body);
  if (!hc.content) return { state: 'dormant', icon: '⚪', label: '未启用', reason: hc.reason };
  return { state: 'live', icon: '🟢', label: '真实运行', reason: '' };
}

(async () => {
  const out = [];
  for (const p of PROBES) {
    const r = await get(p.ep);
    const c = classify(r);
    const probeState = c.state;                 // 原始探针结论（留档供审计）
    const probeReason = c.reason;
    let state = c.state, reason = c.reason, overridden = false;

    // 优先级：人工复核覆盖 > 已知降级理由 > 探针启发式
    const ov = STATE_OVERRIDES[p.nav];
    const dg = DEGRADED_REASONS[p.nav];
    if (ov) { state = ov.state; reason = ov.reason; overridden = true; }
    else if (state === 'live' && dg) { state = 'degraded'; reason = dg; }

    const ICON = { live: '🟢', degraded: '🟡', dormant: '⚪', unsupported: '🔴' };
    const LBL = { live: '真实运行', degraded: '降级运行', dormant: '未启用', unsupported: '不可用' };
    out.push({
      nav: p.nav, label: p.label, endpoint: p.ep,
      httpStatus: r.status, ms: r.ms, bytes: r.body ? r.body.length : 0,
      state, icon: ICON[state], stateLabel: LBL[state], reason,
      probeState, probeReason, overridden,
    });
    console.log(
      '  ' + ICON[state] + ' ' + p.nav.padEnd(22) + String(r.status).padEnd(5) +
      (r.ms + 'ms').padEnd(8) + (LBL[state]).padEnd(10) +
      (overridden ? '[复核] ' : '') + (reason || p.ep)
    );
  }

  const tally = out.reduce((a, x) => { a[x.state] = (a[x.state] || 0) + 1; return a; }, {});
  const summary = {
    probedAt: new Date().toISOString(),
    port: PORT,
    total: out.length,
    tally: {
      live: tally.live || 0, degraded: tally.degraded || 0,
      dormant: tally.dormant || 0, unsupported: tally.unsupported || 0,
    },
    items: out,
  };
  try {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(summary, null, 2), 'utf8');
  } catch (e) { console.log('  [warn] 写文件失败: ' + e.message); }

  console.log('\n  === 汇总 ===');
  console.log('  🟢 真实运行 ' + summary.tally.live);
  console.log('  🟡 降级运行 ' + summary.tally.degraded);
  console.log('  ⚪ 未启用   ' + summary.tally.dormant);
  console.log('  🔴 不可用   ' + summary.tally.unsupported);
  console.log('  产物: ' + OUT);
})();
