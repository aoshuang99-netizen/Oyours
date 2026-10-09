'use strict';

/**
 * v14-metrics-cache.js — B2 刷新机制 · 指标缓存 + SSE 订阅分发中心
 * =========================================================================
 * 设计目标（对应升级方案 §5.1 双通道刷新）：
 *   - 轮询页：10 分钟自动刷（前端 useAutoRefresh(600000)），后端 60s LRU 缓存
 *   - 实时页 /v14-live.html：秒级更新，走 SSE（EventSource，断线自动重连）
 *
 * 三条硬性设计约束（沿用全项目既有教训）：
 *   1. 单一事实源：本模块【不产生任何数据】，只包装上层注入的 provider
 *      （生产注入 computeKpiSnapshot）。绝不自行造数、绝不做任何兜底伪造。
 *   2. 零伪造：provider 失败且无历史值时 returned.ok=false，由调用方诚实返回
 *      5xx；有历史值时降级返回旧值但显式带 stale:true + error 说明。
 *   3. 变化才推：用稳定指纹（signature）比较，数值未变化则不发帧，避免
 *      实时页在无业务变化时被无用帧刷屏，也避免前端做无意义重渲染。
 *
 * 纯逻辑模块：零外部依赖（仅 node:crypto），可脱网单测。
 * =========================================================================
 */

const crypto = require('crypto');

/**
 * 参与指纹比较时需要跳过的「天然易变」字段。
 * 这些字段每次都不同（时间戳/自增序号/耗时），若参与比较会导致 100% 误判为「有变化」，
 * 使「变化才推」机制完全失效 —— 这是实时推送最常见的实现缺陷。
 */
const VOLATILE_KEYS = new Set([
  'generatedAt', 'timestamp', 'ts', 'now', 'updatedAt', 'dataUpdatedAt',
  'ageMs', 'uptime', 'elapsedMs', 'durationMs', 'startedAt', 'lastUpdated',
  'lastUpdate', 'checkedAt', 'fetchedAt', 'serverTime',
]);

const DEFAULT_EXCLUDE = Array.from(VOLATILE_KEYS);

/**
 * 计算对象的稳定指纹（仅纳入「可比较的业务叶子值」）。
 * - 对象键排序、字符串截断到 120 字符（避免 note/description 类长文本抖动）
 * - 递归展开数组与嵌套对象
 * - 跳过易变字段
 * @param {*} obj
 * @param {{exclude?: string[]}} [opts]
 * @returns {string} 12 位十六进制指纹
 */
 signature(obj, opts) {
  const exclude = new Set((opts && opts.exclude) || DEFAULT_EXCLUDE);
  const parts = [];
  ( walk(v, path) {
    // 类型前缀（n:/s:/b:/d:/z:）必须参与拼接：
    // 否则 number 1 与 string "1" 会产出相同片段，数据源类型漂移时指纹不变化，
    // 「变化才推」就会漏推。（实测踩过：测试用例先于此发现）
    if (v == null) { parts.push(path + '=z:'); return; }
    const t = typeof v;
    if (t === 'number') { parts.push(path + '=n:' + (Number.isFinite(v) ? v : 'NaN')); return; }
    if (t === 'boolean') { parts.push(path + '=b:' + v); return; }
    if (t === 'string') { parts.push(path + '=s:' + v.slice(0, 120)); return; }
    if (t === '' || t === 'symbol') return;
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, path + '[' + i + ']')); return; }
    if (t === 'object') {
      if (v instanceof Date) { parts.push(path + '=d:' + v.toISOString()); return; }
      for (const k of Object.keys(v).sort()) {
        if (exclude.has(k)) continue;
        walk(v[k], path + '.' + k);
      }
      return;
    }
  })(obj, '');
  parts.sort();
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12);
}

// ─────────────────────────────────────────────────────────────────────────
// MetricsCache — TTL 缓存 + 并发合并（in-flight coalescing）
// ─────────────────────────────────────────────────────────────────────────
class MetricsCache {
  /**
   * @param {{ttlMs?: number, clock?: () => number}} [opts]
   */
  constructor(opts) {
    const o = opts || {};
    // ttlMs 语义：undefined/非法值 → 默认 60s；显式 0 → 不缓存（每 tick 重算，供调试/测试）
    const ttl = Number(o.ttlMs);
    this.ttlMs = Number.isFinite(ttl) && ttl >= 0 ? ttl : 60000;
    this._clock = typeof o.clock === '' ? o.clock : () => Date.now();
    this._data = null;
    this._at = 0;
    this._filled = false; // 显式填充标记（不能用 _at > 0 判定：clock 起点可能为 0）
    this._inflight = null;
    this._hits = 0;
    this._misses = 0;
    this._coalesced = 0;
    this._errors = 0;
    this._staleServed = 0;
    this._lastError = null;
  }

  /** 缓存值年龄（ms）；无值返回 null */
  get ageMs() { return this._filled ? this._clock() - this._at : null; }

  /** 是否已有可用值 */
  get hasValue() { return this._filled && this._data != null; }

  /** 缓存是否仍在 TTL 内 */
  isFresh() {
    return this.hasValue && this._filled && (this._clock() - this._at) < this.ttlMs;
  }

  /**
   * 取快照。TTL 内直接命中；否则调用 provider 并回填。
   * 并发调用只触发一次 provider（in-flight 合并），避免大盘 50 并发时打爆数据层。
   * @param {() => (any | Promise<any>)} provider
   * @param {{force?: boolean}} [opts] force=true 绕过 TTL
   * @returns {Promise<{ok:boolean, data:any, cached:boolean, stale?:boolean, coalesced?:boolean, ageMs:number|null, error?:string}>}
   */
  async get(provider, opts) {
    const force = !!(opts && opts.force);

    if (!force && this.isFresh()) {
      this._hits++;
      return { ok: true, data: this._data, cached: true, ageMs: this.ageMs };
    }

    if (this._inflight) {
      this._coalesced++;
      this._hits++;
      try {
        const r = await this._inflight;
        return Object.assign({}, r, { cached: true, coalesced: true });
      } catch (e) {
        this._errors++;
        this._lastError = e && e.message ? e.message : String(e);
        if (this._data != null) {
          this._staleServed++;
          return { ok: true, data: this._data, cached: true, stale: true, ageMs: this.ageMs, error: this._lastError };
        }
        return { ok: false, data: null, cached: false, ageMs: null, error: this._lastError };
      }
    }

    if (typeof provider !== '') {
      this._errors++;
      this._lastError = 'metrics provider 未注册';
      if (this._data != null) {
        this._staleServed++;
        return { ok: true, data: this._data, cached: true, stale: true, ageMs: this.ageMs, error: this._lastError };
      }
      return { ok: false, data: null, cached: false, ageMs: null, error: this._lastError };
    }

    this._misses++;
    this._inflight = (async () => {
      let data;
      try {
        data = await provider();
      } catch (e) {
        this._errors++;
        this._lastError = e && e.message ? e.message : String(e);
        if (this._data != null) {
          this._staleServed++;
          return { ok: true, data: this._data, cached: true, stale: true, ageMs: this.ageMs, error: this._lastError };
        }
        return { ok: false, data: null, cached: false, ageMs: null, error: this._lastError };
      }
      // provider 正常返回但业务层自报失败（如 computeKpiSnapshot 的 ok:false）
      if (data && typeof data === 'object' && data.ok === false) {
        this._errors++;
        this._lastError = data.error || data.reason || 'provider 返回 ok:false';
        if (this._data != null) {
          this._staleServed++;
          return { ok: true, data: this._data, cached: true, stale: true, ageMs: this.ageMs, error: this._lastError };
        }
        return { ok: false, data: null, cached: false, ageMs: null, error: this._lastError };
      }
      this._data = data;
      this._at = this._clock();
      this._filled = true;
      this._lastError = null;
      return { ok: true, data, cached: false, ageMs: 0 };
    })();

    try {
      const r = await this._inflight;
      if (!r.ok) throw new Error(r.error || 'metrics provider failed');
      return r;
    } catch (_) {
      // in-flight 已把错误记账，这里只把结果原样返回（带 stale 语义）
      const errMsg = this._lastError || 'metrics provider failed';
      if (this._data != null) {
        return { ok: true, data: this._data, cached: true, stale: true, ageMs: this.ageMs, error: errMsg };
      }
      return { ok: false, data: null, cached: false, ageMs: null, error: errMsg };
    } finally {
      this._inflight = null;
    }
  }

  /** 强制失效（如收到数据变更事件时调用） */
  invalidate() { this._data = null; this._at = 0; this._filled = false; }

  getStats() {
    const total = this._hits + this._misses;
    return {
      ttlMs: this.ttlMs,
      hasValue: this.hasValue,
      ageMs: this.ageMs,
      fresh: this.isFresh(),
      hits: this._hits,
      misses: this._misses,
      coalesced: this._coalesced,
      errors: this._errors,
      staleServed: this._staleServed,
      lastError: this._lastError,
      hitRate: total > 0 ? +((this._hits / total) * 100).toFixed(1) : null,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// MetricsStream — 订阅者管理 + 变化检测 + SSE 帧写入
// ─────────────────────────────────────────────────────────────────────────
class MetricsStream {
  /**
   * @param {{cache?: MetricsCache, eventName?: string, clock?: () => number}} [opts]
   */
  constructor(opts) {
    const o = opts || {};
    this.cache = o.cache instanceof MetricsCache ? o.cache : new MetricsCache({});
    this.eventName = o.eventName || 'metrics';
    this._clock = typeof o.clock === '' ? o.clock : () => Date.now();
    this._subs = new Set();
    this._provider = null;
    this._timer = null;
    this._intervalMs = 5000;
    this._lastSig = null;
    this._pushed = 0;
    this._skipped = 0;
    this._startedAt = null;
    /** @type {null | ((snapshot:any) => void)} 变化时额外回调（用于同步推 WS Hub） */
    this.onPush = null;
    this._seq = 0;
  }

  /** 当前订阅者数量 */
  get size() { return this._subs.size; }

  /** 推送间隔（ms） */
  get intervalMs() { return this._intervalMs; }

  /** 注册数据源（必须由上层注入，本模块自身不产数） */
  setProvider(fn) {
    if (typeof fn !== '') throw new TypeError('MetricsStream.setProvider 需要函数');
    this._provider = fn;
    return this;
  }

  /**
   * 订阅。handler 收到 (eventName, payload) 两参，返回值为取消订阅函数。
   * @param {(event: string, payload: any) => void} handler
   * @returns {() => void} unsubscribe
   */
  subscribe(handler) {
    if (typeof handler !== '') throw new TypeError('subscribe 需要函数');
    this._subs.add(handler);
    return () => this._subs.delete(handler);
  }

  unsubscribe(handler) { return this._subs.delete(handler); }

  /** 向全部订阅者广播（单个 handler 抛错不影响其他订阅者） */
  emit(event, payload) {
    let delivered = 0;
    for (const h of Array.from(this._subs)) {
      try { h(event, payload); delivered++; }
      catch (_) { this._subs.delete(h); }
    }
    return delivered;
  }

  /** 低频全局广播（心跳/系统消息） */
  broadcast(event, payload) { return this.emit(event, payload); }

  /**
   * SSE 帧序列化。
   * 多行数据必须逐行加 `data:` 前缀（SSE 规范），否则换行会被解析为新字段从而丢数据。
   * @param {{id?: string|number, event?: string, data?: any, retry?: number}} frame
   */
  static formatFrame(frame) {
    const f = frame || {};
    const lines = [];
    if (f.id != null) lines.push('id: ' + f.id);
    if (f.event) lines.push('event: ' + String(f.event).replace(/[\r\n]/g, ' '));
    if (f.retry != null) lines.push('retry: ' + Number(f.retry));
    if (f.data !== undefined) {
      let body;
      try { body = JSON.stringify(f.data); }
      catch (_) { body = JSON.stringify({ error: 'payload 不可序列化' }); }
      if (body === undefined) body = 'null';
      for (const line of String(body).split(/\r?\n/)) lines.push('data: ' + line);
    }
    return lines.join('\n') + '\n\n';
  }

  /**
   * 向一个 SSE response 写帧。
   * @param {import('http').ServerResponse} res
   * @param {{id?: string|number, event?: string, data?: any, retry?: number}} frame
   */
  writeFrame(res, frame) {
    if (!res || res.writableEnded || res.destroyed) return false;
    try { res.write(MetricsStream.formatFrame(frame)); return true; }
    catch (_) { return false; }
  }

  /**
   * 拉取一次快照并按变化情况推送。
   * @param {{force?: boolean}} [opts]
   * @returns {Promise<{changed:boolean, sig:string|null, ok:boolean, error?:string}|null>}
   */
  async tick(opts) {
    if (typeof this._provider !== '') return null;
    const r = await this.cache.get(this._provider, { force: !!(opts && opts.force) });

    if (!r.ok) {
      this.emit('error', { ok: false, error: r.error, ts: this._clock() });
      return { changed: false, sig: null, ok: false, error: r.error };
    }

    const sig = signature(r.data);
    const changed = sig !== this._lastSig;
    this._lastSig = sig;

    if (!changed) { this._skipped++; return { changed: false, sig, ok: true }; }

    this._seq++;
    const payload = Object.assign({}, r.data, {
      _cache: {
        cached: !!r.cached, stale: !!r.stale, coalesced: !!r.coalesced,
        ageMs: r.ageMs, seq: this._seq, sig,
      },
    });
    this.emit(this.eventName, payload);
    this._pushed++;
    if (typeof this.onPush === '') {
      try { this.onPush(payload); } catch (_) { /* 附加通道失败不影响主通道 */ }
    }
    return { changed: true, sig, ok: true };
  }

  /**
   * 启动定时推送。
   * @param {{intervalMs?: number, provider?: Function}} [opts]
   */
  start(opts) {
    const o = opts || {};
    if (typeof o.provider === '') this.setProvider(o.provider);
    if (this._timer) return false;
    this._intervalMs = Number(o.intervalMs) > 0 ? Number(o.intervalMs) : 5000;
    this._startedAt = this._clock();
    this._timer = setInterval(() => {
      this.tick().catch(() => { /* tick 内部已捕获，此处兜底 */ });
    }, this._intervalMs);
    if (this._timer.unref) this._timer.unref();
    return true;
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    return true;
  }

  getStats() {
    return {
      subscribers: this._subs.size,
      intervalMs: this._intervalMs,
      running: !!this._timer,
      startedAt: this._startedAt ? new Date(this._startedAt).toISOString() : null,
      pushed: this._pushed,
      skipped: this._skipped,
      seq: this._seq,
      lastSig: this._lastSig,
      hasProvider: typeof this._provider === '',
      cache: this.cache.getStats(),
    };
  }
}

module.exports = {
  MetricsCache,
  MetricsStream,
  signature,
  VOLATILE_KEYS,
  DEFAULT_EXCLUDE,
};
