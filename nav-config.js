'use strict';
/**
 * nav-config.js — B4 导航结构「单一事实源」
 *
 * 方案 §3.2 要求导航 36 → 24 主项，且「明细下放、大盘只做汇总」。
 * 本文件是导航结构的**权威定义**（分组 / 主项 / 子页 / 四态徽标），
 * v14-console.html 的导航区必须与之保持一致，一致性由
 * test-nav-config.js 守住（解析 HTML 导航项数 = 本文件主项数）。
 *
 * 四态判据（详见 tools/nav-availability-probe.js 与 reports/nav-availability.json）：
 *   live        🟢 端点 200 且有真实运行数据
 *   degraded    🟡 有数据但口径存疑 / 仅有历史残留
 *   dormant     ⚪ 端点 200 但恒空（含「有配置无运行」）
 *   unsupported 🔴 端点 404 / 5xx
 *
 * 徽标数据的来源与时间：2026-09-20 实测（reports/nav-availability.json）。
 * ⚠️ 徽标是**快照**，不随运行时变化；重新实测请跑
 *    `node tools/nav-availability-probe.js` 并同步本文件。
 *    故意不在前端做实时拉取 —— 导航是核心 UI，不能依赖运行时请求成功。
 */

const STATE_META = {
  live: { icon: '🟢', label: '真实运行', cls: 'ok' },
  degraded: { icon: '🟡', label: '降级运行', cls: 'warn' },
  dormant: { icon: '⚪', label: '未启用', cls: 'idle' },
  unsupported: { icon: '🔴', label: '不可用', cls: 'err' },
};

/**
 * 24 主项（`items` 里每项算 1 个主项；`subs` 是降级下来的子页，不计入主项数）。
 */
const GROUPS = [
  {
    id: 'home',
    label: '',
    items: [
      {
        nav: 'dashboard', icon: '📡', label: '全域监控大盘', page: 'dashboard',
        state: 'live',
        note: '唯一首页。L0 服务健康（11 项）+ 7 域汇总卡；明细点卡片进各域页',
        subs: [
          { nav: 'dash-full', icon: '🖥', label: '全屏六级监控', href: '/v14-dash.html', state: 'live', blank: true,
            note: '原 iframe 内嵌改为独立全屏页（消除嵌套加载，首屏省 ~183KB）' },
        ],
      },
    ],
  },
  {
    id: 'account',
    label: '🔐 账号管理',
    items: [
      { nav: '', icon: '🔑', label: '账号注册', page: '', state: 'degraded',
        note: 'stats 为会话内存计数器（重启归零），未读 registration-ledger.jsonl 台账', subs: [] },
      {
        nav: 'nurture', icon: '🌱', label: '拟人化养号', page: 'nurture', state: 'live',
        note: '真实养号数据（module/nurture/detail: total=123, simulated=0）',
        subs: [
          { nav: 'tumblr-nurture', icon: '📈', label: '真实养号进度', page: 'tumblr-nurture', state: 'live',
            note: 'Tumblr 二阶段养号实时进度' },
        ],
      },
      {
        nav: 'accboard', icon: '📊', label: '账号看板', page: 'accboard', state: 'live',
        note: '真实账号凭据与状态（real-）',
        subs: [
          { nav: 'realinfo', icon: '📋', label: '真实账户信息', page: 'realinfo', state: 'degraded',
            note: '读 MySQL 残留表口径（与 live 源不一致，已标 _archived）' },
          { nav: 'session', icon: '💾', label: 'Session 管理', page: 'session', state: 'dormant',
            note: 'totalBackups/activeSessions 全 0，从未产生过备份' },
        ],
      },
      { nav: 'msgcenter', icon: '💬', label: '消息 / 指令', page: 'msgcenter', state: 'live',
        note: 'notifications 有真实告警条目', subs: [] },
      { nav: 'remix', icon: '🔁', label: '二次创作分发', page: 'remix', state: 'degraded',
        note: 'stats.totalActions=0 但 records 非空，口径不一致待核', subs: [] },
    ],
  },
  {
    id: 'device',
    label: '📱 设备与基础设施',
    items: [
      { nav: 'devices', icon: '📱', label: '设备启动', page: 'devices', state: 'live',
        note: '50 台云手机', subs: [] },
      {
        nav: 'fingerprint', icon: '🛡', label: '指纹与传感模拟', page: 'fingerprint', state: 'dormant',
        note: '指纹版本数 0；同组内 sensor 有真实数据（50 设备 × 6 传感器）',
        subs: [
          { nav: 'gps', icon: '📍', label: 'GPS 轨迹', page: 'gps', state: 'dormant', note: 'activeTrajectories=[]' },
          { nav: 'sensor', icon: '📡', label: '传感器模拟', page: 'sensor', state: 'live',
            note: '300 个活跃传感器（50×6）' },
        ],
      },
      { nav: 'proxy', icon: '🔌', label: '代理管理', page: 'proxy', state: 'live',
        note: '出口池 89 条 / 独立 IP 46 / 水位 24.8%（B0-D2 已修）', subs: [] },
    ],
  },
  {
    id: 'content',
    label: '📝 内容运营',
    items: [
      { nav: 'intel', icon: '🔥', label: '内容情报', page: 'intel', state: 'live',
        note: 'trending/intel 50 条真实热点', subs: [] },
      {
        nav: 'aigc', icon: '🤖', label: 'AI 内容生成', page: 'aigc', state: 'live',
        note: '14 条已生成 / 均质 91.5',
        subs: [
          { nav: 'agnes', icon: '🎨', label: 'AI 媒体生成', page: 'agnes', state: 'degraded',
            note: '无专属统计端点，以 intel 模块详情近似代表' },
        ],
      },
      { nav: 'publish', icon: '📤', label: '智能发布', page: 'publish', state: 'live',
        note: '50 条发布记录', subs: [] },
    ],
  },
  {
    id: 'marketing',
    label: '🎯 营销引流',
    items: [
      { nav: 'scrm', icon: '🎯', label: 'SCRM 截流', page: 'scrm', state: 'dormant',
        note: 'totalIntercepted=0，从未拦截过消息（仅有关键词配置）', subs: [] },
      { nav: 'marketing', icon: '📢', label: '主动营销', page: 'marketing', state: 'degraded',
        note: 'stats 全 0 但 records 50 条，口径不一致待核', subs: [] },
      { nav: 'dau', icon: '🎯', label: 'DAU 控制', page: 'dau', state: 'live',
        note: 'currentDAU=12 / 目标 200 / running=true', subs: [] },
    ],
  },
  {
    id: 'conversion',
    label: '📊 转化与增长',
    items: [
      {
        nav: 'conv-analysis', icon: '📊', label: '转化与实验', page: 'traffic-conversion', subPage: 'overview',
        state: 'live',
        note: '漏斗有真实数字（click_cta=177, signup=167）；全部 7 个子视图在同一页内切换',
        subs: [
          { nav: 'conv-links', icon: '🔗', label: '短链管理', page: 'traffic-conversion', subPage: 'links', state: 'live' },
          { nav: 'conv-conversions', icon: '📋', label: '转化明细', page: 'traffic-conversion', subPage: 'conversions', state: 'live' },
          { nav: 'conv-experiments', icon: '🧪', label: 'A/B 实验', page: 'traffic-conversion', subPage: 'experiments', state: 'dormant',
            note: '空数组，未创建过实验' },
          { nav: 'conv-attribution', icon: '📈', label: '归因分析', page: 'traffic-conversion', subPage: 'attribution', state: 'live',
            note: '5 个归因模型可选（配置型端点）' },
        ],
      },
      {
        nav: 'conv-risk', icon: '🚨', label: '风控与告警', page: 'traffic-conversion', subPage: 'cloaking',
        state: 'dormant',
        note: 'cloaking 零请求（仅 4 模板）、alerts 零事件（仅 6 规则）',
        subs: [
          { nav: 'conv-alerts', icon: '🚨', label: '告警规则', page: 'traffic-conversion', subPage: 'alerts', state: 'dormant' },
        ],
      },
      { nav: 'traffic', icon: '🔗', label: '引流管理', page: 'traffic', state: 'live',
        note: 'traffic/links 有真实数据（响应 1.4MB，B6 将做游标分页）', subs: [] },
    ],
  },
  {
    id: 'analytics',
    label: '📈 数据分析',
    items: [
      {
        nav: 'analytics', icon: '📈', label: '流量与转化分析', page: 'analytics', state: 'degraded',
        note: '原 tracking + analytics 合并；历史上混入过模拟访问（D4 已加 provenance 分列）',
        subs: [
          { nav: 'tracking', icon: '📈', label: '数据追踪', page: 'tracking', state: 'dormant',
            note: 'viral/scan signals=0' },
        ],
      },
      { nav: 'decision', icon: '🧠', label: '决策引擎', page: 'decision', state: 'live', subs: [] },
      { nav: 'tasks', icon: '⚡', label: '任务管理', page: 'tasks', state: 'degraded',
        note: '队列长期为空，仅 1 条历史任务', subs: [] },
      { nav: 'evolution', icon: '🔄', label: '自进化', page: 'evolution', state: 'live',
        note: '5 大策略库', subs: [] },
    ],
  },
  {
    id: 'system',
    label: '⚙️ 系统编排',
    items: [
      { nav: 'dag', icon: '⚙️', label: 'DAG 编排', page: 'dag', state: 'live', subs: [] },
      { nav: 'users', icon: '👥', label: '系统用户管理', href: '/user-manager.html', state: 'live',
        note: 'RBAC 权限模块将在 B6 扩展', subs: [] },
    ],
  },
];

/** 全部主项（不含子页） */
 function allItems() {
  const out = [];
  for (const g of GROUPS) for (const it of g.items) out.push({ ...it, group: g.id, groupLabel: g.label });
  return out;
}

/** 主项计数（B4 验收判据：必须 = 24） */
 function countMainItems() {
  return GROUPS.reduce((n, g) => n + g.items.length, 0);
}

/** 子页计数 */
 function countSubItems() {
  return GROUPS.reduce((n, g) => n + g.items.reduce((m, it) => m + (it.subs ? it.subs.length : 0), 0), 0);
}

/** 统计各四态数量（按主项） */
 function tallyStates() {
  const t = { live: 0, degraded: 0, dormant: 0, unsupported: 0 };
  for (const it of allItems()) if (t[it.state] != null) t[it.state]++;
  return t;
}

/** 按 nav id 查主项 */
 function findItem(nav) {
  return allItems().find((i) => i.nav === nav) || null;
}

module.exports = { STATE_META, GROUPS, allItems, countMainItems, countSubItems, tallyStates, findItem };
