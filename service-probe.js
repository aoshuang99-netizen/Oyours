'use strict';
/**
 * service-probe.js — 真实服务探活（TCP / HTTP），零伪造
 *
 * B4 大盘 L0「健康总览」的数据源。
 * 设计要点：
 *   1. **可注入** tcpProbe / httpProbe / now ⇒ 单测可完全脱网运行。
 *   2. **并发探测 + 整体超时**：11 项服务串行最坏 8s×11 = 88s，必须并发。
 *   3. **不做任何"配置存在即视为在线"的推断** —— 探不通就是 up:false。
 *   4. **永不抛异常**：单项探测失败即该项 up:false，不影响其余项。
 */

const net = require('net');
const http = require('http');
const registry = require('./services-registry.js');

/* ─────────────── 默认探测实现 ─────────────── */

/** TCP 连接探测（不握手、不读数据，能连上即算通） */
function defaultTcpProbe(port, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = new net.Socket();
    let settled = false;
    const done = (up, error) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch (_) {}
      resolve({ up, latencyMs: Date.now() - started, error: error || null });
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true, null));
    sock.once('timeout', () => done(false, 'ETIMEDOUT'));
    sock.once('error', (e) => done(false, e.code || e.message));
    try { sock.connect(port, '127.0.0.1'); }
    catch (e) { done(false, e.code || e.message); }
  });
}

/** HTTP 探测：任何 <500 的响应都算「服务在跑」（401/403 也证明进程活着） */
function defaultHttpProbe(port, pathname, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const done = (up, status, error) => {
      if (settled) return;
      settled = true;
      resolve({ up, httpStatus: status == null ? null : status, latencyMs: Date.now() - started, error: error || null });
    };
    let req;
    try {
      req = http.request(
        { host: '127.0.0.1', port, path: pathname || '/', method: 'GET', timeout: timeoutMs },
        (res) => {
          res.resume(); // 丢弃 body，只要状态码
          done(res.statusCode < 500, res.statusCode, res.statusCode >= 500 ? 'HTTP_' + res.statusCode : null);
        }
      );
    } catch (e) { return done(false, null, e.code || e.message); }
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} done(false, null, 'ETIMEDOUT'); });
    req.on('error', (e) => done(false, null, e.code || e.message));
    req.end();
  });
}

/* ─────────────── 探测器工厂 ─────────────── */

/**
 * @param {object} deps
 * @param {function} deps.tcpProbe   (port, timeoutMs) => {up, latencyMs, error}
 * @param {function} deps.httpProbe  (port, path, timeoutMs) => {up, httpStatus, latencyMs, error}
 * @param {function} deps.now        () => ms
 */
function createProber(deps) {
  const d = deps || {};
  const tcpProbe = typeof d.tcpProbe === 'function' ? d.tcpProbe : defaultTcpProbe;
  const httpProbe = typeof d.httpProbe === 'function' ? d.httpProbe : defaultHttpProbe;
  const now = typeof d.now === 'function' ? d.now : () => Date.now();

  /** 探测单个服务 —— 永不抛 */
  async function probeOne(svc) {
    const base = {
      id: svc.id, name: svc.name, port: svc.port, kind: svc.kind,
      managed: !!svc.managed, optional: !!svc.optional, role: svc.role || '',
    };
    try {
      const r = svc.kind === registry.KIND.TCP
        ? await tcpProbe(svc.port, svc.probeTimeoutMs || 3000)
        : await httpProbe(svc.port, svc.probe, svc.probeTimeoutMs || 8000);
      return { ...base, up: r.up === true, latencyMs: r.latencyMs, httpStatus: r.httpStatus == null ? null : r.httpStatus, error: r.error || null };
    } catch (e) {
      return { ...base, up: false, latencyMs: null, httpStatus: null, error: e && e.message ? e.message : 'PROBE_THREW' };
    }
  }

  /** 并发探测全部（默认 registry.SERVICES）—— 永不抛 */
  async function probeAll(opts) {
    const o = opts || {};
    const list = Array.isArray(o.services) ? o.services : registry.SERVICES;
    const started = now();
    const results = await Promise.all(list.map((s) => probeOne(s)));
    return {
      results,
      summary: registry.summarize(results),
      probedAt: new Date().toISOString(),
      elapsedMs: now() - started,
      source: 'services-registry.js (11 项真实探活)',
    };
  }

  return { probeOne, probeAll };
}

/** 模块级单例（server.js 用），惰性创建 */
let _default = null;
function getProber() {
  if (!_default) _default = createProber({});
  return _default;
}

module.exports = { createProber, getProber, defaultTcpProbe, defaultHttpProbe };
