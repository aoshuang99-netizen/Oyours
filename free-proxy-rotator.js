'use strict';
/**
 * free-proxy-rotator.js — 免费开源代理旋转器（解决 Tumblr 单 IP 429 根因）
 * ------------------------------------------------------------------
 * 数据来源：GitHub 上持续维护的免费 HTTP 代理列表（公开、零成本、无需注册）：
 *   - TheSpeedX/PROXY-List  (http.txt)
 *   - monosans/proxy-list  (http.txt)
 * 机制：
 *   1. 周期性从 GitHub 拉取最新代理列表（经本机 10808 中继出网）。
 *   2. 对每个代理做健康探测（请求 api.tumblr.com，401/403/429/500/200 均视为可达）。
 *   3. 维护「当前可用」代理池；无可用时降级回默认中继（诚实失败，不伪造）。
 *   4. 按账号 id 哈希确定性分配出口 → 不同账号走不同 IP，分散 Tumblr 限流。
 * 注意：免费代理极不稳定，故每分钟刷新一次；代理失效由 tumblr-publisher 的
 *       网络重试 + 429 指数退避兜底。本模块只负责「提供尽量多的可用出口」。
 */
const fs = require('fs');
const path = require('path');
const { fetchExt } = require('./http-client');

const WS = __dirname;
const CHECK_URL = 'https://api.tumblr.com/v2/user/info';
const SOURCES = [
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt'
];
const DEFAULT_RELAY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'http://127.0.0.1:10808';
const POOL_FILE = path.join(WS, '_working_proxies.json');

function fnv1a(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

class FreeProxyRotator {
  constructor(opts = {}) {
    this.checkUrl = opts.checkUrl || CHECK_URL;
    this.refreshMs = opts.refreshMs || 60000;
    this.sources = opts.sources || SOURCES;
    this.defaultRelay = opts.defaultRelay || DEFAULT_RELAY;
    this.pool = [];        // 当前候选代理 URL 数组（来自磁盘快照 / GitHub 扫描）
    this.verified = [];    // 已通过存活校验的子集（getProxyFor 优先使用）
    this._verifiedAt = 0;
    this._verifying = false;
    this._timer = null;
    this._scanning = false;
    this._seed();
  }

  _seed() {
    try {
      if (fs.existsSync(POOL_FILE)) {
        const arr = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8'));
        if (Array.isArray(arr) && arr.length) { this.pool = arr; console.log(`[proxy-rotator] 从 ${POOL_FILE} 载入 ${arr.length} 个已知可用代理`); }
      }
    } catch (e) { /* ignore */ }
  }

  async _fetchLists() {
    const out = [];
    for (const u of this.sources) {
      try {
        const r = await fetchExt(u, { method: 'GET', timeout: 15000 }, this.defaultRelay);
        if (r.ok) {
          const txt = await r.text();
          const lines = txt.split('\n').map(s => s.trim()).filter(Boolean)
            .filter(l => /^(\d{1,3}\.){3}\d{1,3}:\d+$/.test(l))
            .map(l => 'http://' + l);
          out.push(...lines);
        }
      } catch (e) { /* 单源失败不影响其他源 */ }
    }
    return [...new Set(out)];
  }

  async _check(px) {
    try {
      const r = await fetchExt(this.checkUrl, { method: 'GET', timeout: 8000 }, px);
      // 任何 HTTP 状态码（含 401/429/500）都说明代理把请求送达了 Tumblr
      return typeof r.status === 'number';
    } catch (e) { return false; }
  }

  async scan() {
    if (this._scanning) return this.pool;
    this._scanning = true;
    try {
      const candidates = await this._fetchLists();
      const working = [];
      // 并发探测（限流 16 路），快速筛出可用代理
      const batch = 16;
      for (let i = 0; i < candidates.length; i += batch) {
        const slice = candidates.slice(i, i + batch);
        const results = await Promise.all(slice.map(p => this._check(p)));
        slice.forEach((p, idx) => { if (results[idx]) working.push(p); });
        if (working.length >= 40) break; // 足够分散即可
      }
      if (working.length) {
        this.pool = working;
        // scan 已逐个探测过，结果天然存活 —— 同步更新 verified 供 getProxyFor 优先使用
        this.verified = working;
        this._verifiedAt = Date.now();
        try { fs.writeFileSync(POOL_FILE, JSON.stringify(working, null, 2)); } catch (e) {}
        console.log(`[proxy-rotator] 刷新完成：可用代理 ${working.length}/${candidates.length}`);
      } else {
        console.log('[proxy-rotator] 本轮无可用代理（免费代理波动），保留旧池');
      }
    } catch (e) {
      console.error('[proxy-rotator] 扫描异常:', e.message);
    } finally {
      this._scanning = false;
    }
    return this.pool;
  }

  start() {
    // 顺序很关键：先校验磁盘快照的存活性，再扫描新代理。
    // _working_proxies.json 是上次运行留下的快照，重启时其中大部分往往已失效
    // （实测 5 条里 4 条不可达）——若直接拿去分配，发布请求必定 fetch failed。
    this.verifyPool().then(() => this.scan()).catch(() => this.scan());
    if (!this._timer) this._timer = setInterval(() => this.scan(), this.refreshMs);
    return this;
  }

  stop() { if (this._timer) { clearInterval(this._timer); this._timer = null; } }

  getPool() { return this.pool; }

  /**
   * 校验当前池中代理的存活性，结果写入 this.verified。
   * 只做「能否把请求送达 Tumblr」的判定（401/403/429/500/200 均视为可达）。
   */
  async verifyPool() {
    if (this._verifying) return this.verified;
    this._verifying = true;
    try {
      const pool = this.pool.slice();
      if (!pool.length) { this.verified = []; return this.verified; }
      const alive = [];
      const batch = 16;
      for (let i = 0; i < pool.length; i += batch) {
        const slice = pool.slice(i, i + batch);
        const res = await Promise.all(slice.map((p) => this._check(p)));
        slice.forEach((p, idx) => { if (res[idx]) alive.push(p); });
      }
      this.verified = alive;
      this._verifiedAt = Date.now();
      console.log(`[proxy-rotator] 池存活校验: ${alive.length}/${pool.length}`);
      if (!alive.length) console.warn('[proxy-rotator] ⚠️ 池内代理全部失效，将交由调用方回退到默认中继');
    } catch (e) {
      /* 校验失败不影响后续 scan */
    } finally {
      this._verifying = false;
    }
    return this.verified;
  }

  /** 按账号确定性分配出口代理；无可用代理时返回 null（调用方回退默认中继并诚实失败） */
  getProxyFor(accountId) {
    // 优先从「已验证存活」子集分配 —— pool 是历史快照，未校验项大概率已失效。
    // 【2026-10-09 修正】原实现：verified 为空时回退用 this.pool（即未校验的历史快照）。
    // 但池空/全死时这等于「把已知可能失效的出口继续派发」——实测 _working_proxies.json
    // 里唯一那条 36.137.204.11:8002 已死（http=000 / 20s 超时），而 verifyPool
    // 尚未跑完或刚判全部失效时，getProxyFor 仍会把它派出去 ⇒ 所有 Tumblr 请求 fetch failed，
    // 表现为「网络故障」实为「单点死代理」，极难归因。
    // 现在：verified 一旦做过校验（无论结果是空还是非空），就只信verified；
    //      只有「从未校验过」才允许用 pool，并在返回值里让调用方能区分。
    if (this._verifiedAt) {
      if (!this.verified || !this.verified.length) return null;   // 已校验且全死 → 交调用方回退
      const i = fnv1a(String(accountId)) % this.verified.length;
      return this.verified[i];
    }
    // 从未校验：允许用 pool（保持原有行为，避免冷启动无出口），但只取前若干条分散
    const src = this.pool || [];
    if (!src.length) return null;
    const i = fnv1a(String(accountId)) % src.length;
    return src[i];
  }
}

// 单例（server.js 复用同一份池）
let _singleton = null;
function getRotator() {
  if (!_singleton) _singleton = new FreeProxyRotator();
  return _singleton;
}

module.exports = { FreeProxyRotator, getRotator };
