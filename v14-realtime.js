'use strict';

/**
 * v14-realtime.js — MSCMS v14 实时推送中心（Phase 6 / #534）
 * =========================================================================
 * 用 WebSocket 替代前端 3s 轮询：订阅事件总线（account.* / inbox.* /
 * 7 条因果链事件 / heal.error），去抖(1.5s)重算并广播全量同步快照；
 * 新连接即下发 snapshot；30s 心跳保活。
 *
 * 设计要点：
 *   - 基于 ws 的 WebSocketServer(noServer)，挂主 http server 的 /ws/v14 upgrade。
 *   - 依赖托管 workspace 的 ws（NODE_PATH 已含）；缺失则降级禁用，不影响主服务。
 *   - 事件 → 立即转发原始事件(前端高亮) + 去抖重算 stats/accounts/cloudPhones/inbox。
 *   - 全量 sync 广播（61 账号 + 50 设备体量极小），前端直接替换状态，彻底去除轮询。
 * =========================================================================
 */

const { CAUSAL_EVENTS } = require('./event-bus.js');

// ── ws 解析：优先 NODE_PATH，缺失回退到托管 workspace 绝对路径；再缺失则禁用 ──
function _loadWs() {
  const candidates = [];
  try { candidates.push(require.resolve('ws')); } catch (_) { /* NODE_PATH 未含 ws */ }
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (home) candidates.push(home + '/.workbuddy/binaries/node/workspace/node_modules/ws');
  for (const c of candidates) {
    try { return require(c); } catch (_) { /* 尝试下一个 */ }
  }
  return null;
}
const WebSocket = _loadWs();

const ACCOUNT_EVENTS = [
  'account.device.bound',
  'account.login.issued',
  'account.status.changed',
];
const INBOX_EVENTS = ['inbox.update', 'inbox.ready'];
const WATCHED_EVENTS = [...CAUSAL_EVENTS, 'heal.error', ...ACCOUNT_EVENTS, ...INBOX_EVENTS];

class RealtimeHub {
  constructor({ eventBus, accountManager, messageInbox, logger } = {}) {
    this.bus = eventBus;
    this.am = accountManager;
    this.inbox = messageInbox;
    this.log = logger || console;
    this.wss = null;
    this._clients = new Set();
    this._debounceTimer = null;
    this._heartbeatTimer = null;
    this._subscribed = false;
  }

  get enabled() { return !!WebSocket; }

  /**
   * 挂载到主 http server 的 upgrade 事件（/ws/v14）。
   * @param {http.Server} server
   */
  attach(server) {
    if (!WebSocket) {
      this.log.warn('[realtime] ws 模块不可用，实时推送已禁用（其余功能正常）');
      return false;
    }
    if (!server || typeof server.on !== 'function') {
      this.log.warn('[realtime] 无效的 http server，实时推送未挂载');
      return false;
    }

    this.wss = new WebSocket.Server({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
      const url = (req.url || '');
      if (url.startsWith('/ws/v14')) {
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.wss.emit('connection', ws, req);
        });
      } else {
        // 非本中心 upgrade：直接关闭，避免 socket 挂起
        socket.destroy();
      }
    });

    this._setupConnection();
    this._subscribe();
    this._startHeartbeat();
    // 全局暴露推送句柄，供业务模块在发布/监听/竞品/KPI/系统事件发生时调用（M2 / #534）
    try { global.__rt = this; } catch (_) { /* 极端环境忽略 */ }
    this.log.log('[realtime] WebSocket 推送中心已挂载于 /ws/v14（监听事件 ' + WATCHED_EVENTS.length + ' 种，已暴露 global.__rt）');
    return true;
  }

  _setupConnection() {
    this.wss.on('connection', (ws) => {
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg && msg.type === 'ping') this._send(ws, { type: 'pong', ts: Date.now() });
        } catch (_) { /* 忽略非 JSON 控制帧 */ }
      });
      ws.on('close', () => this._clients.delete(ws));
      ws.on('error', () => this._clients.delete(ws));
      this._clients.add(ws);
      // 连接即下发快照（前端无需初始轮询）
      this._sendSnapshot(ws);
    });
  }

  _subscribe() {
    if (!this.bus || this._subscribed) return;
    for (const ev of WATCHED_EVENTS) {
      this.bus.on(ev, 'realtime-hub', (data) => {
        // 立即转发原始事件（前端可即时高亮/乐观更新）
        this._broadcast({ type: 'event', event: ev, data, ts: Date.now() });
        // 去抖重算并下发全量同步
        this._scheduleSync();
      });
    }
    this._subscribed = true;
  }

  _scheduleSync() {
    if (this._debounceTimer) return;
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      this._broadcastSync();
    }, 1500);
  }

  _snapshot() {
    let stats = null;
    let accounts = [];
    let cloudPhones = [];
    let inbox = null;
    try {
      if (this.am) {
        stats = this.am.computeLoopStats();
        accounts = this.am.listAccounts({});
        cloudPhones = this.am.listCloudPhones();
      }
    } catch (_) { /* 数据层临时不可用，留空 */ }
    try {
      if (this.inbox && typeof this.inbox.getSummary === 'function') inbox = this.inbox.getSummary();
    } catch (_) { /* 收件箱不可用，留空 */ }
    return { stats, accounts, cloudPhones, inbox };
  }

  _sendSnapshot(ws) {
    const snap = this._snapshot();
    this._send(ws, { type: 'snapshot', ...snap, ts: Date.now(), clients: this._clients.size });
  }

  _broadcastSync() {
    const snap = this._snapshot();
    this._broadcast({ type: 'sync', ...snap, ts: Date.now(), clients: this._clients.size });
  }

  _broadcast(obj) {
    if (!this.wss) return;
    const payload = JSON.stringify(obj);
    for (const ws of this._clients) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(payload); } catch (_) { this._clients.delete(ws); }
      }
    }
  }

  /**
   * 通用 topic 推送（M2 / #534 扩展）
   * ───────────────────────────────────────────────────────────────────
   * 供后续模块（发布/监听/竞品/KPI/系统）在自身业务发生时调用，
   * 实时下发到已订阅的前端（workbench.html 等），替代 3s 轮询。
   * 调用方式（任意模块）：
   *   global.__rt && global.__rt.push('publish', { id, url, ts });
   *   global.__rt && global.__rt.pushKpi({ replyRate, latencyMs, ... });
   *   global.__rt && global.__rt.pushSystem({ level:'info', msg:'...' });
   * 前端按 msg.type === topic 分流处理。
   * @param {string} topic  - 'publish'|'monitor'|'competitor'|'kpi'|'system'|'causal'|自定义
   * @param {*}      data   - 任意 JSON 可序列化负载
   */
  push(topic, data) {
    if (!topic) return;
    this._broadcast({ type: 'topic', topic: String(topic), data: data == null ? {} : data, ts: Date.now() });
  }

  /** KPI 指标实时推送（统一 KPI 卡使用） */
  pushKpi(snapshot) {
    this._broadcast({ type: 'kpi', data: snapshot == null ? {} : snapshot, ts: Date.now() });
  }

  /** 系统级通知（后台无感弹窗/状态栏使用，对应方案 ④ 桌面实时打通） */
  pushSystem(payload) {
    const lvl = (payload && payload.level) || 'info';
    this._broadcast({ type: 'system', level: lvl, data: payload == null ? {} : payload, ts: Date.now() });
  }

  _send(ws, obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(obj)); } catch (_) { /* 发送失败忽略 */ }
    }
  }

  _startHeartbeat() {
    this._heartbeatTimer = setInterval(() => {
      for (const ws of this._clients) {
        if (ws.isAlive === false) {
          try { ws.terminate(); } catch (_) { /* 已关闭 */ }
          this._clients.delete(ws);
          continue;
        }
        ws.isAlive = false;
        try { ws.ping(); } catch (_) { /* 忽略 */ }
      }
    }, 30000);
    if (this._heartbeatTimer.unref) this._heartbeatTimer.unref();
  }

  stop() {
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    if (this.wss) { try { this.wss.close(); } catch (_) { /* 已关闭 */ } }
    this._clients.clear();
  }
}

module.exports = { RealtimeHub, WATCHED_EVENTS };
