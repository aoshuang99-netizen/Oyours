'use strict';
/**
 * services-registry.js — MSCMS v14 服务清单「单一事实源」(Single Source of Truth)
 *
 * 背景（B4）：
 *   方案 §3.1 要求大盘 L0「健康总览」展示「服务 11 项」，但实测
 *   `/api/v14/services/health` 等 6 个候选端点**全部 404** —— 即大盘根本没有
 *   服务健康数据源。services-registry 补上这一层，且必须与真实进程清单一致。
 *
 * 与 tools/mscms-watchdog.js 的关系：
 *   watchdog 的 SERVICES 是「看门狗负责拉起的服务」（8 项），本清单是
 *   「大盘要展示健康度的服务」（11 项 = 8 受管 + 3 非受管）。
 *   本文件是**只读清单**，不参与拉起决策 —— 误改本文件不会导致服务被杀。
 *   一致性由 test-services-registry.js 守住（对比 watchdog 源码的端口集合），
 *   避免两份定义漂移。
 *
 * 探测原则（零伪造）：
 *   - 只做真实 TCP 连接 / HTTP 请求，**绝不**用「配置存在」推断「服务在跑」。
 *   - 探不通就是 down，不允许回退成「未知=绿」。
 *   - 需要凭据/按需启动的服务标 optional，其 down 不计入故障数（但仍如实展示）。
 */

/** 服务种类 */
const KIND = { TCP: 'tcp', HTTP: 'http' };

/**
 * 11 项服务。
 * managed  : 是否由 tools/mscms-watchdog.js 拉起（false = 需人工/按需启动）
 * optional : down 时是否不计入「异常」计数（按需服务）
 */
const SERVICES = [
  {
    id: 'mysql', name: 'MySQL', port: 3307, kind: KIND.TCP, managed: true,
    role: 'Tumblr 24h (账号,内容) 去重闸门数据源',
    probeTimeoutMs: 3000,
  },
  {
    id: 'main', name: '主服务', port: 3002, kind: KIND.HTTP,
    probe: '/api/v14/causal-chain/status', managed: true,
    role: 'v14 控制台 / 发布器 / 全部 API',
    probeTimeoutMs: 8000,
  },
  {
    id: 'nurture', name: '养号服务', port: 3005, kind: KIND.HTTP,
    probe: '/api/status', managed: true,
    role: 'Tumblr 二阶段养号',
    probeTimeoutMs: 8000,
  },
  {
    id: 'contentgen', name: '内容生成', port: 3010, kind: KIND.HTTP,
    probe: '/api/assets', managed: true,
    role: 'content-gen 微服务（图文/视频素材）',
    probeTimeoutMs: 8000,
  },
  {
    id: 'visitor', name: '访客画像', port: 3012, kind: KIND.HTTP,
    probe: '/api/status', managed: true,
    role: 'Aliens_eye OSINT 画像扫描',
    probeTimeoutMs: 8000,
  },
  {
    id: 'sync', name: '桌面同步', port: 3013, kind: KIND.HTTP,
    probe: '/health', managed: true,
    role: '工作区 → D:\\MSCMS-Desktop\\resources 实时同步',
    probeTimeoutMs: 8000,
  },
  {
    id: 'exitguard', name: '出口守护', port: 20779, kind: KIND.HTTP,
    probe: '/health', managed: true,
    role: '保活 VPS 隧道 + mihomo 多出口，定期刷新出口池',
    probeTimeoutMs: 8000,
  },
  {
    id: 'mpt', name: 'MoneyPrinterTurbo', port: 8080, kind: KIND.HTTP,
    probe: '/docs', managed: true,
    role: '视频渲染（P3 硬前置，历史上常无响应）',
    probeTimeoutMs: 8000,
  },
  {
    id: 'watchdog', name: '看门狗', port: 3011, kind: KIND.TCP, managed: false,
    role: '全部受管服务的唯一拉起者（3011 为其单实例锁端口）',
    probeTimeoutMs: 3000,
  },
  {
    id: 'tunnel', name: 'CF 隧道健康', port: 20880, kind: KIND.HTTP,
    probe: '/health', managed: false,
    role: 'cf-tunnel.js 健康端点（出口池 20201+ 的管理面）',
    probeTimeoutMs: 8000,
  },
  {
    id: 'oauth', name: 'Tumblr OAuth', port: 3122, kind: KIND.TCP, managed: false,
    role: 'OAuth 1.0a 回调服务，仅授权时启动', optional: true,
    probeTimeoutMs: 3000,
  },
];

/** 出口隧道端口区间（附加信息，非独立服务） */
const TUNNEL_EXIT_PORT_RANGE = { from: 20201, to: 20209 };

const byId = new Map(SERVICES.map((s) => [s.id, s]));

/** 按 id / 端口查询 */
function getService(idOrPort) {
  if (byId.has(idOrPort)) return byId.get(idOrPort);
  const p = Number(idOrPort);
  return SERVICES.find((s) => s.port === p) || null;
}

/** 受管服务（看门狗职责范围） */
function managedServices() { return SERVICES.filter((s) => s.managed); }

/** 非受管服务（大盘仍展示，但不属看门狗） */
function unmanagedServices() { return SERVICES.filter((s) => !s.managed); }

/** 计算健康汇总（纯函数，可单测） */
function summarize(results) {
  const list = Array.isArray(results) ? results : [];
  const up = list.filter((r) => r && r.up === true);
  const down = list.filter((r) => r && r.up !== true);
  // optional 服务不计入故障
  const downCritical = down.filter((r) => !r.optional);
  return {
    total: list.length,
    up: up.length,
    down: down.length,
    downCritical: downCritical.length,
    downOptional: down.length - downCritical.length,
    // 全部非 optional 服务在线才算 healthy
    status: downCritical.length === 0 ? 'healthy' : (downCritical.length <= 2 ? 'degraded' : 'critical'),
    downIds: downCritical.map((r) => r.id),
    downOptionalIds: down.filter((r) => r.optional).map((r) => r.id),
  };
}

module.exports = {
  KIND,
  SERVICES,
  TUNNEL_EXIT_PORT_RANGE,
  getService,
  managedServices,
  unmanagedServices,
  summarize,
};
