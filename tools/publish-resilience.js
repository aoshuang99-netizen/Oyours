#!/usr/bin/env node
'use strict';
/*
 * OYours / MSCMS v14 — P1.3a 发布韧性层（自包含实现）
 * ----------------------------------------------------------------------------
 * V15-plan P1.3 要求：发布器加重试 + 退避 + 限流自适应，失败分类 429/401/网络。
 * 原意图是给 free-platform-publisher.js / cloud-publisher.js 加韧性，但那些文件在
 * C: 快照中语法破损（function 关键字被剥离）。本模块**自包含**，提供可被任意发布器
 * 复用的韧性原语：错误分类、指数退避重试、自适应令牌桶限流。
 *
 * 导出：
 *   classifyError(err, statusCode) -> 'rate_limit'|'auth'|'network'|'server'|'client'|'unknown'
 *   withRetry(fn, opts)            -> Promise（带指数退避 + 抖动；auth 错误立即放弃）
 *   AdaptiveLimiter                -> 令牌桶，按近期 429 动态降速
 */

// ---------------------------------------------------------------------------
// 错误分类：区分「可重试」与「不可重试」
// ---------------------------------------------------------------------------
function classifyError(err, statusCode) {
  if (typeof statusCode === 'number') {
    if (statusCode === 429) return 'rate_limit';
    if (statusCode === 401 || statusCode === 403) return 'auth';
    if (statusCode >= 500) return 'server';
    if (statusCode >= 400) return 'client';
  }
  if (!err) return 'unknown';
  const msg = String(err.message || err).toLowerCase();
  const code = String(err.code || '').toLowerCase();
  if (/econnreset|econnrefused|etimedout|timeout|socket|network|enotfound|eai_/i.test(msg + ' ' + code)) {
    return 'network';
  }
  if (/401|unauthorized|forbidden|auth/i.test(msg)) return 'auth';
  if (/429|rate.?limit|too many requests/i.test(msg)) return 'rate_limit';
  if (/5\d\d|bad gateway|gateway timeout|service unavailable/i.test(msg)) return 'server';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// 指数退避重试（带全抖动）
// ---------------------------------------------------------------------------
async function withRetry(fn, opts = {}) {
  const {
    maxAttempts = 5,
    baseDelayMs = 1000,
    maxDelayMs = 60000,
    factor = 2,
    onAttempt = null, // (attempt, err, kind) => void
    signal = null,
  } = opts;
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (signal && signal.aborted) throw new Error('aborted');
    attempt++;
    try {
      return await fn(attempt);
    } catch (err) {
      const kind = classifyError(err, err && err.statusCode);
      const retryable = kind === 'rate_limit' || kind === 'network' || kind === 'server';
      if (!retryable || attempt >= maxAttempts) {
        if (onAttempt) onAttempt(attempt, err, kind, { gaveUp: true });
        const e = new Error(`withRetry 放弃：kind=${kind} attempts=${attempt} :: ${err && err.message}`);
        e.kind = kind;
        e.attempts = attempt;
        throw e;
      }
      // auth/client 错误理论上不会到这里（retryable=false），但保险
      if (kind === 'auth' || kind === 'client') {
        if (onAttempt) onAttempt(attempt, err, kind, { gaveUp: true });
        const e = new Error(`withRetry 放弃（不可重试）：kind=${kind} :: ${err && err.message}`);
        e.kind = kind;
        throw e;
      }
      const delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(factor, attempt - 1));
      const jitter = Math.random() * delay * 0.3; // 0~30% 抖动，避免惊群
      const wait = Math.round(delay + jitter);
      if (onAttempt) onAttempt(attempt, err, kind, { retryAfterMs: wait });
      if (signal && signal.aborted) throw new Error('aborted');
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

// ---------------------------------------------------------------------------
// 自适应令牌桶：近期 429 越多，发放速率越低
// ---------------------------------------------------------------------------
class AdaptiveLimiter {
  constructor({ capacity = 30, refillPerSec = 1, minCapacity = 5 } = {}) {
    this.capacity = capacity;
    this.maxCapacity = capacity;
    this.minCapacity = minCapacity;
    this.refillPerSec = refillPerSec;
    this.tokens = capacity;
    this.last = Date.now();
    this.consecutive429 = 0;
  }
  _refill() {
    const now = Date.now();
    const dt = (now - this.last) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + dt * this.refillPerSec);
    this.last = now;
  }
  tryAcquire(n = 1) {
    this._refill();
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }
  registerResult(success, kind) {
    if (!success && kind === 'rate_limit') {
      this.consecutive429++;
      // 每遇到一次 429，容量降 20%（下限 minCapacity），实现自适应降速
      this.capacity = Math.max(this.minCapacity, Math.round(this.capacity * 0.8));
    } else if (success) {
      this.consecutive429 = 0;
      // 连续成功则缓慢恢复容量（上限 maxCapacity）
      if (this.capacity < this.maxCapacity) {
        this.capacity = Math.min(this.maxCapacity, this.capacity + 1);
      }
    }
    return this.capacity;
  }
  snapshot() {
    return { tokens: Math.round(this.tokens * 100) / 100, capacity: this.capacity, consecutive429: this.consecutive429 };
  }
}

// ---------------------------------------------------------------------------
// CLI 自检：模拟一个偶发失败的发布函数
// ---------------------------------------------------------------------------
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    if (!args.includes('--self-test')) {
      console.log('用法: node tools/publish-resilience.js --self-test');
      console.log('导出: classifyError, withRetry, AdaptiveLimiter');
      process.exit(0);
    }
    const limiter = new AdaptiveLimiter({ capacity: 10, refillPerSec: 5 });
    let calls = 0;
    const flaky = async () => {
      calls++;
      if (calls < 3) {
        const e = new Error('429 Too Many Requests');
        e.statusCode = 429;
        throw e;
      }
      return { ok: true, calls };
    };
    try {
      const res = await withRetry(flaky, {
        maxAttempts: 6,
        onAttempt: (a, err, kind, info) => {
          limiter.registerResult(kind !== 'rate_limit', kind);
          console.log(`  attempt ${a} -> ${kind}${info.retryAfterMs ? ' 重试@' + info.retryAfterMs + 'ms' : ''}`);
        },
      });
      console.log('自检通过:', JSON.stringify(res), 'limiter=', JSON.stringify(limiter.snapshot()));
    } catch (e) {
      console.error('自检失败:', e.message);
      process.exit(1);
    }
  })();
}

module.exports = { classifyError, withRetry, AdaptiveLimiter };
