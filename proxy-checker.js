/**
 * proxy-checker.js — 代理质量检测 + 住宅代理池管理 v2
 *
 * 功能：
 *   ✓ 检测代理出口 IP 归属（住宅 vs 数据中心）
 *   ✓ ASN/IP 段反查
 *   ✓ 代理连通性 + 延迟测试
 *   ✓ 质量评分（0-100）
 *   ✓ 自动选择最优代理
 *   ✓ 支持 ipinfo.io / ip-api.com / ipwhois.io
 *
 * 用法：
 *   const checker = new ProxyChecker();
 *   const result = await checker.check(proxyUrl);
 *   const best = await checker.pickBest(pool);
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ══════════════════════════════════════════════════════════

// 已知数据中心 ASN 名单（常见云服务商）
const DATACENTER_ASNS = new Set([
  // AWS
  '16509', '14618',
  // Google Cloud
  '15169', '396982',
  // Azure
  '8075', '8068', '8069',
  // DigitalOcean
  '14061',
  // Linode
  '63949',
  // Vultr
  '20473',
  // Hetzner
  '24940',
  // OVH
  '16276',
  // Oracle Cloud
  '31898',
  // Alibaba Cloud
  '45102', '37963',
  // Tencent Cloud
  '45090', '132203',
  // 其他常见
  '36352', '35916', '53667', '18779', '62563', '54290',
  '46562', '8100', '20278', '137951', '40676',
]);

// 已知数据中心主机名关键词
const DC_HOSTNAME_PATTERNS = [
  /aws/i, /ec2/i, /compute\.amazon/i,
  /google/i, /gcp/i, /googlecloud/i,
  /azure/i, /microsoft/i,
  /digitalocean/i, /linode/i, /vultr/i, /hetzner/i, /ovh/i,
  /oracle/i, /alibaba/i, /tencent/i, /aliyun/i,
  /server/i, /hosting/i, /vps/i, /vm/i, /cloud/i,
  /colo/i, /colo-crossing/i,
];

class ProxyChecker {
  constructor() {
    this.cache = new Map();   // proxy url → result
    this.ipCache = new Map();  // ip → type
    this.tested = 0;
  }

  /**
   * 🔍 检测单个代理
   * @returns {{ ok: boolean, ip?: string, type?: 'residential'|'datacenter'|'unknown', country?: string, isp?: string, latencyMs?: number, score?: number, error?: string }}
   */
  async check(proxyUrl, timeout = 15000) {
    if (this.cache.has(proxyUrl)) return this.cache.get(proxyUrl);

    const start = Date.now();
    const agent = this._parseProxy(proxyUrl);
    const result = { ok: false, proxy: proxyUrl, proxyType: agent?.type || 'direct', timestamp: Date.now() };

    try {
      // Step 1: 通过代理查询出口 IP
      const { data } = await axios.get('https://api.ipify.org?format=json', {
        httpAgent: agent?.http,
        httpsAgent: agent?.https,
        timeout,
      });

      result.ip = data.ip || (typeof data === 'string' ? data.trim() : null);
      if (!result.ip) throw new Error('no IP returned');

      result.latencyMs = Date.now() - start;

      // Step 2: IP 归属查询 (ip-api.com — 免费，45请求/分钟)
      result.type = await this._classifyIP(result.ip);

      // Step 3: 补充地理信息
      try {
        const geo = await axios.get(`http://ip-api.com/json/${result.ip}?fields=country,countryCode,city,isp,org,as`, { timeout: 8000 });
        result.country = geo.data.country || null;
        result.countryCode = geo.data.countryCode || null;
        result.city = geo.data.city || null;
        result.isp = geo.data.isp || null;
        result.org = geo.data.org || null;
        result.asn = geo.data.as || null;

        // 如果 ASN 在数据中心名单里，标记为 datacenter
        if (result.asn) {
          const asnNum = result.asn.match(/AS(\d+)/i)?.[1];
          if (asnNum && DATACENTER_ASNS.has(asnNum)) {
            result.type = 'datacenter';
          }
        }

        // 如果 ISP/Org 匹配数据中心特征
        if (result.type !== 'datacenter' && result.isp) {
          for (const pat of DC_HOSTNAME_PATTERNS) {
            if (pat.test(result.isp) || pat.test(result.org || '')) {
              result.type = 'datacenter';
              break;
            }
          }
        }
      } catch {}

      // Step 4: 评分
      result.score = this._score(result);
      result.ok = true;

    } catch (e) {
      result.error = e.message;
      result.score = 0;
    }

    this.cache.set(proxyUrl, result);
    this.tested++;
    return result;
  }

  /**
   * 🏆 从代理池中挑选最佳代理
   * 优先级：已验证 residential > 未知类型 > datacenter
   * 如果全是 datacenter，至少选最低延迟的
   */
  async pickBest(proxyList, opts = {}) {
    const { minScore = 40, requireResidential = true, timeout = 10000 } = opts;

    if (!proxyList || proxyList.length === 0) return null;

    const results = [];

    for (const proxy of proxyList) {
      const r = await this.check(proxy, timeout);
      results.push(r);

      // 找到好的住宅代理就立即返回
      if (r.ok && r.type === 'residential' && r.score >= minScore) {
        console.log(`  [proxy] ✅ Best: ${r.ip} (${r.type}, ${r.country}, ${r.latencyMs}ms, score=${r.score})`);
        return r;
      }
    }

    // 降级：接受 unknown 类型
    if (requireResidential) {
      const unknown = results.find(r => r.ok && r.type === 'unknown' && r.score >= minScore);
      if (unknown) {
        console.log(`  [proxy] ⚠️ Fallback unknown: ${unknown.ip} (${unknown.country}, ${unknown.latencyMs}ms)`);
        return unknown;
      }
    }

    // 再降级：接受 datacenter（至少能用）
    const dc = results.find(r => r.ok && r.score >= 20);
    if (dc) {
      console.log(`  [proxy] ⚠️ Fallback datacenter: ${dc.ip} (${dc.country}, ${dc.latencyMs}ms) — CAPTCHA risk higher`);
      return dc;
    }

    // 全挂了
    console.log(`  [proxy] ❌ No working proxy found (tested ${results.length})`);
    return null;
  }

  /**
   * 检测当前直连（非代理）IP 类型
   */
  async checkDirect() {
    try {
      const { data } = await axios.get('https://api.ipify.org?format=json', { timeout: 10000 });
      const ip = data.ip || (typeof data === 'string' ? data.trim() : null);
      if (!ip) return { ok: false, type: 'unknown', error: 'no ip' };

      const type = await this._classifyIP(ip);
      let geo = {};
      try {
        const g = await axios.get(`http://ip-api.com/json/${ip}?fields=country,countryCode,city,isp`, { timeout: 8000 });
        geo = g.data;
      } catch {}

      return { ok: true, ip, type, ...geo };
    } catch (e) {
      return { ok: false, type: 'unknown', error: e.message };
    }
  }

  /**
   * 批量检测并生成质量报告
   */
  async batchReport(proxyList) {
    const results = [];
    for (const p of proxyList) {
      results.push(await this.check(p, 8000));
      await new Promise(r => setTimeout(r, 500)); // rate limit
    }

    const residential = results.filter(r => r.type === 'residential');
    const datacenter = results.filter(r => r.type === 'datacenter');
    const dead = results.filter(r => !r.ok);

    return {
      total: results.length,
      working: results.filter(r => r.ok).length,
      residential: residential.length,
      datacenter: datacenter.length,
      best: residential[0] || results.find(r => r.ok) || null,
      dead: dead.length,
      results,
    };
  }

  // ═══ Internal ═══

  async _classifyIP(ip) {
    if (this.ipCache.has(ip)) return this.ipCache.get(ip);

    try {
      // 使用 ip-api.com 的 ISP 信息判断
      const { data } = await axios.get(`http://ip-api.com/json/${ip}?fields=isp,org,as`, { timeout: 8000 });

      const isp = (data.isp || '').toLowerCase();
      const org = (data.org || '').toLowerCase();
      const asn = (data.as || '');

      // 检查 ASN
      const asnNum = asn.match(/AS(\d+)/i)?.[1];
      if (asnNum && DATACENTER_ASNS.has(asnNum)) {
        this.ipCache.set(ip, 'datacenter');
        return 'datacenter';
      }

      // 检查 ISP/Org 关键词
      const combined = `${isp} ${org} ${asn}`;
      for (const pat of DC_HOSTNAME_PATTERNS) {
        if (pat.test(combined)) {
          this.ipCache.set(ip, 'datacenter');
          return 'datacenter';
        }
      }

      // ISP 名称包含常见住宅 ISP → residential
      const residentialKeywords = [
        'comcast', 'att', 'verizon', 'spectrum', 'cox', 'centurylink',
        'frontier', 'windstream', 't-mobile', 'sprint', 'rogers', 'bell',
        'telus', 'shaw', 'videotron', 'bt', 'sky', 'virgin', 'talktalk',
        'vodafone', 'orange', 'deutsche telekom', 'telefonica', 'movistar',
        'telenor', 'telia', 'dtac', 'ais', 'ntt', 'softbank', 'kddi',
        'optus', 'telstra', 'charter', 'mediacom', 'altice', 'cox',
        'cable', 'fiber', 'dsl', 'broadband',
      ];

      for (const kw of residentialKeywords) {
        if (combined.includes(kw)) {
          this.ipCache.set(ip, 'residential');
          return 'residential';
        }
      }

      this.ipCache.set(ip, 'unknown');
      return 'unknown';
    } catch {
      this.ipCache.set(ip, 'unknown');
      return 'unknown';
    }
  }

  _score(result) {
    if (!result.ok) return 0;
    let score = 50;

    // 类型加分
    if (result.type === 'residential') score += 30;
    else if (result.type === 'datacenter') score -= 20;

    // 延迟加分（越低越好）
    if (result.latencyMs < 300) score += 15;
    else if (result.latencyMs < 1000) score += 5;
    else score -= 10;

    // 地理加分（US/CA/UK 等英语国家）
    const preferredCC = ['US', 'CA', 'GB', 'AU', 'NZ', 'IE'];
    if (result.countryCode && preferredCC.includes(result.countryCode)) score += 5;

    return Math.max(0, Math.min(100, score));
  }

  _parseProxy(proxyUrl) {
    if (!proxyUrl || proxyUrl === 'direct') return null;

    try {
      const u = new URL(proxyUrl);
      const { HttpsProxyAgent } = require('https-proxy-agent');
      const { HttpProxyAgent } = require('http-proxy-agent');
      return {
        type: u.protocol.replace(':', ''),
        http: new HttpProxyAgent(proxyUrl),
        https: new HttpsProxyAgent(proxyUrl),
      };
    } catch {
      return null;
    }
  }
}

module.exports = { ProxyChecker };
