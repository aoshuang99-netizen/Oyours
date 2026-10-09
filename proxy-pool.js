'use strict';
/**
 * proxy-pool.js — 多出口代理池（缓解 Tumblr 429 限流的根因之一）
 *
 * 背景：
 *  - Tumblr 对【共享 OAuth app-key + 单一代理出口 IP】返回 429 Limit Exceeded。
 *  - 彻底解除 429 需要：① 每账号/小组独立出口 IP；② 多个 OAuth App 分散 key。
 *  - 本模块提供「代理池」基础设施：账号/浏览器按确定性哈希分配到不同出口 IP，
 *    用户只需在 proxy-pool.json 里补充更多代理 URL，账号即自动分散到多 IP，无需改代码。
 *
 * proxy-pool.json 格式（数组，enabled=false 的会被忽略）：
 *   [
 *     { "url": "http://:10808", "name": "default-relay", "weight": 1, "enabled": true },
 *     { "url": "http://user:pass@1.2.3.4:8080", "name": "relay-2", "weight": 1, "enabled": true }
 *   ]
 *
 * 若文件不存在或为空，则回退到环境变量 HTTP(S)_PROXY（单出口，与原行为一致）。
 */

const fs = require('fs');
const path = require('path');

// 与 tumblr-nurture-device.js 保持一致的确定性哈希
 hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** 冷却阶梯：连续失败次数越多，冷却越久（秒） */
const COOLDOWN_LADDER = [0, 60, 120, 300, 600, 900];
const RATE_LIMIT_COOLDOWN = 300; // 429/503 立即冷却 5 分钟（限流是出口级，换出口才有意义）

/**
 * 出口健康表放在模块级：本机多个进程/实例（3002 主服务、3005 养号）各自 new ProxyPool()
 * 时也必须共享同一份冷却状态，否则「A 实例冷却了、B 实例还在往死出口打」。
 */
const HEALTH = new Map();

class ProxyPool {
  constructor(file) {
    this.file = file || path.join(__dirname, 'proxy-pool.json');
    this.proxies = [];
    /** @type {Map<string,{fails:number,ok:number,cooldownUntil:number,lastErr:string,lastOkAt:number}>} */
    this.health = HEALTH;
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      // 【2026-09-09 出口用途隔离】usage === 'scrape' 的出口（如 IPRoyal 采购 IP，
      // 对 Tumblr 返回 407/ECONNRESET）只在抓取链路使用，必须排除在「发布/养号」
      // 调度池之外 —— 否则网页端一启用，它们就会被分给 Tumblr 发布，表现为全站失败。
      if (Array.isArray(raw)) {
        this.proxies = raw.filter((p) => p && p.url && p.enabled !== false && (p.usage || 'post') !== 'scrape'
          // bdunlocker:// 不是标准 HTTP 代理（是 BD Web Unlocker 的 REST 桥，只对 GET 有效，
          // 由 http-client 单独识别处理）。绝不能被当普通代理分给 POST 发布请求。
          && !String(p.url'bdunlocker://'));
      }
    } catch (e) {
      this.proxies = [];
    }
    if (!this.proxies.length) {
      const env = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || null;
      if (env) this.proxies = [{ url: env, name: 'env-default', weight: 1, enabled: true }];
    }
    this._prewarmAlive();
    return this.proxies;
  }

  /**
   * 启动期存活预筛（2026-10-09）。
   *
   * 背景：出口池里可能整批失效（实测 44 个 :202xx 段 CF 出口**全部** http=000，
   *   只有全局中继 10808 可用）。此时若照常分配，每个账号会拿到一个死出口，
   *   每次请求都要耗满超时才失败；而熔断器只能逐个追（20203→20204→…），
   *   表现为「每次调用慢 15s 且 fetched 恒为 0」，极难看出是池子整体失效。
   *
   * 处置：构造时并发探测一小批样本（默认 6 个），若**全部**不可用，
   *   就判定「整池失效」，直接把池收缩为全局中继（若可用）——让业务立刻恢复，
   *   而不是让熔断器一条条去发现。若样本里还有活的，则只把死样本剔除。
   *
   * 探测目标用 Tumblr 的轻量端点，401 视作「可达」（鉴权问题≠网络不通）。
   */
  _prewarmAlive() {
    if (this._prewarmed) return;
    this._prewarmed = true;
    // 【2026-10-09 修正】原实现只抽样 6 个。实测池里 90 条（44 个 CF 出口全死），
    // 抽样剔除 6 个后仍留下 38 个死出口 ⇒ 熔断器要逐个追 38 轮才能收敛，
    // 而每轮要耗 10s 超时。改为「全池并发探测」：并发 20、每条 6s 超时，
    // 90 条 ≈ 3~4 批 ≈ 20s 内完成，换来的是池在服务可用前就已干净。
    const probe = (u) => new Promise((resolve) => {
      // 用 fetchExt 探测而非 spawn curl：3002 是长驻服务，内部已大量 spawn 过
      // curl，实测会出现 spawnSync EBUSY / 0.8s 内返回 0 达标的假阴性，
      // 导致「整池失效」误判。fetchExt 走 undici，无进程依赖。
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      let timer = null;
      let fetcher = null;
      try {
        fetcher = require('./http-client.js').fetchExt;
      } catch (_) { fetcher = null; }
      if (!fetcher) { finish(false); return; }
      timer = setTimeout(() => finish(false), 7000);
      fetcher('https://api.tumblr.com/v2/tumblr.info', { method: 'GET', timeout: 6000 }, u)
        .then((r) => finish(!!r && r.status !== 0))
        .catch(() => finish(false));
    });
    const all = this.proxies.slice();
    const CONC = 20;
    const t0 = Date.now();
    const runAll = async () => {
      const results = new Array(all.length);
      for (let i = 0; i < all.length; i += CONC) {
        const idx = all.slice(i, i + CONC).map((_, k) => i + k);
        const rs = await Promise.all(idx.map(j => probe(all[j].url)));
        rs.forEach((v, k) => { results[idx[k]] = v; });
      }
      return results;
    };
    runAll().then((results) => {
      const aliveN = results.filter(Boolean;
      const kept = all.filter((_, i) => results[i]);
      console.log(`[proxy-pool] 出口预筛：${aliveN}/${all.length} 可达（耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);
      if (aliveN === 0) {
        const env = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || null;
        console.warn(
          `[proxy-pool] ⚠️ 整池失效（全部 ${all.length} 个出口不可达）` +
          (env ? ` → 收缩为全局中继 ${env}` : ' → 无全局中继可用，请求将直连（预计失败）')
        );
        if (env) this.proxies = [{ url: env, name: 'env-fallback', weight: 1, enabled: true }];
      } else if (aliveN < all.length) {
        this.proxies = kept;
        console.warn(`[proxy-pool] 已剔除 ${all.length - aliveN} 个不可达出口，剩 ${kept.length} 个可用`);
      } else {
        console.log('[proxy-pool] 预筛通过：全部出口可达');
      }
    }).catch(() => {});
  }

  /** 可用代理数量（1 = 单出口，与原行为一致） */
  count() { return this.proxies.length; }

  /** 按索引取代理 URL（用于浏览器分组，index 越界则取模） */
  get(i) {
    if (!this.proxies.length) return null;
    return this.proxies[((i % this.proxies.length) + this.proxies.length) % this.proxies.length].url;
  }

  /**
   * 按账号确定性分配出口 IP（重启一致，避免同一账号频繁换 IP 被关联）。
   * 增强：若首选出口处于冷却（429 / 连续失败），则顺延到下一个健康出口 —— 这是
   * 「空转」的关键修复：过去账号被哈希钉死在一个 429 的出口上，会永久失败且无任何产出。
   */
  forAccount(accountId) {
    if (!this.proxies.length) return null;
    const base = hashStr(String(accountId)) % this.proxies.length;
    if (this.proxies.length === 1) return this.proxies[0].url;

    // 首选未冷却 → 保持粘性（同账号尽量同 IP，防关联）
    if (!this._isCooling(this.proxies[base].url)) return this.proxies[base].url;

    // 顺延找第一个未冷却的
    for (let k = 1; k < this.proxies.length; k++) {
      const p = this.proxies[(base + k) % this.proxies.length];
      if (!this._isCooling(p.url)) return p.url;
    }
    // 全冷却 → 取最快解封的（避免直接放弃导致空转）
    let best = this.proxies[base], bestUntil = Infinity;
    for (const p of this.proxies) {
      const h = this.health.get(p.url);
      const until = h ? h.cooldownUntil : 0;
      if (until < bestUntil) { bestUntil = until; best = p; }
    }
    return best.url;
  }

  _isCooling(url) {
    const h = this.health.get(url);
    return !!(h && h.cooldownUntil > Date.now());
  }

  /**
   * 上报一次请求结果，驱动冷却与故障转移。
   * @param {string|null} url 出口代理 URL
   * @param {{ok:boolean,status?:number,err?:string}} r
   */
  report(url, r) {
    if (!url) return;
    // 出口 IP 相同的多条代理（如 10808 与 7890 都是 ）视为同一出口：
    // 只冷却其中一个没有意义（切过去照样 429），必须整组冷却。
    const self = this.proxies.find((p) => p.url === url);
    if (self && self.exitIp) {
      for (const p of this.proxies) if (p.exitIp === self.exitIp) this._reportOne(p.url, r);
      return;
    }
    this._reportOne(url, r);
  }

  _reportOne(url, r) {
    const h = this.health.get(url) || { fails: 0, ok: 0, cooldownUntil: 0, lastErr: '', lastOkAt: 0 };
    if (r && r.ok) {
      h.ok++; h.fails = 0; h.cooldownUntil = 0; h.lastOkAt = Date.now();
    } else {
      h.fails++;
      const rateLimited = r && (r.status === 429 || r.status === 503);
      const sec = rateLimited ? RATE_LIMIT_COOLDOWN : (COOLDOWN_LADDER[Math.min(h.fails, COOLDOWN_LADDER.length - 1)] || 60);
      h.cooldownUntil = Date.now() + sec * 1000;
      h.lastErr = (r && (r.err || ('http_' + r.status))) || 'unknown';
      console.warn(`[proxy-pool] 出口 ${url} 失败(${h.lastErr}) 冷却 ${sec}s，账号将自动切到其它出口`);
    }
    this.health.set(url, h);
  }

  /** 健康快照（供看板/日报） */
  healthSnapshot() {
    return this.proxies.map((p) => {
      const h = this.health.get(p.url) || {};
      return {
        name: p.name || p.url, url: p.url, exitIp: p.exitIp || null,
        ok: h.ok || 0, fails: h.fails || 0,
        cooling: this._isCooling(p.url),
        cooldownLeftSec: h.cooldownUntil ? Math.max(0, Math.round((h.cooldownUntil - Date.now()) / 1000)) : 0,
        lastErr: h.lastErr || '',
      };
    });
  }

  /** 返回只读列表（供看板/接口展示） */
  list() {
    return this.proxies.map((p) => ({ name: p.name || p.url, url: p.url, weight: p.weight || 1, enabled: p.enabled !== false }));
  }
}

module.exports = { ProxyPool, hashStr };
