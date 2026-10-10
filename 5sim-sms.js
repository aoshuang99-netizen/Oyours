'use strict';
/**
 * 5sim-sms.js — 5sim.net 付费接码平台集成（代理感知版）
 *
 * 与旧版的区别：
 *   - 旧版用 axios 且【未走代理】，在本机（无直连外网，必须走 10808 中继）会超时失败。
 *   - 本版改用 http-client.fetchExt（自动经本地中继 10808 出网），在本机可达。
 *   - 新增 buyAndWait() 一站式：购号 → 轮询短信 → 返回验证码，省去调用方拼装。
 *
 * API 端点（5sim v1）：
 *   GET /user/profile                       — 查余额（无需购号，用于验证资源可用性）
 *   GET /guest/products/$country/$op        — 查某国支持的产品
 *   GET /guest/prices?country=$c&product=$p — 查某产品在某国的价格
 *   GET /user/buy/activation/$c/$o/$p        — 购买激活号码
 *   GET /user/check/$id                      — 轮询短信/状态
 *   GET /user/finish/$id                     — 完成订单（确认号码已用）
 *   GET /user/cancel/$id                     — 取消订单（退款，号码不可用/超时）
 *
 * 用法：
 *   const { FiveSim, buyAndWait } = require('./5sim-sms.js');
 *   const sms = new FiveSim();                 // token 走 FIVESIM_TOKEN 或内置
 *   const bal = await sms.getBalance();        // 不花钱
 *   const { id, phone, code } = await buyAndWait({ country:'usa', operator:'any', product:'tumblr' });
 *   await sms.finishOrder(id);                 // 用完确认
 */

const { fetchExt } = require('./http-client');

const BASE = 'https://5sim.net/v1';

// 出网代理：本机无直连外网，5sim 必须经本地中继 10808（或自定义）。
const RELAY =
  process.env.FIVESIM_PROXY ||
  process.env.TUMBLR_PROXY ||
  process.env.HTTPS_PROXY ||
  process.env.HTTP_PROXY ||
  'http://127.0.0.1:10808';

// 内置 token（exp 2027-06-17，仍有效）。可用环境变量 FIVESIM_TOKEN 覆盖。
const DEFAULT_TOKEN =
  'eyJhbGciOiJSUzUxMiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE4MTMyMTI2MzQsImlhdCI6MTc4MTY3NjYzNCwicmF5IjoiNjIxMWY0MjAyNmM2YjZkNDMxMjMxYjY0MDkwMzg3MDYiLCJzdWIiOjQyMjIwNTB9.JZytzKxUJzVIgYL0W__HHMzqnvf2ADcUuGgioXt1WwyiGpWF_wisbPmfe6YwcN-LGLkBl8V50leStN0q3OiRjvpA-G7MC3jt7M0jn8JabNeJPyoBYJm-nqqZbd7_0Zk6vArpVs-csSgfpIrOBAKsjq8It8xac-Fj5T2oij3CdwOTi0mhGpoe7963FKxqePCRsxAY24AgPmyrbmFTr0lilGYHTzE0B5Sh4mTpDhJDp9vp0RwNlxBybSdx656z4OjtH_eqHxD-admC1Iesa0LtGFroUqzwyo4zEn0R-ox9MoPB8HMtVGY-355hiRVg12E3FiWFOYxzyESxrF3fn1mGSA';

function getToken() {
  return process.env.FIVESIM_TOKEN || DEFAULT_TOKEN;
}

/**
 * 底层 API 调用：自动带 Bearer token + 经中继出网。
 * @param {string} p 路径（不含 BASE）
 * @param {object} opts { method, headers, timeout }
 * @returns {Promise<any>} 解析后的 JSON（或原始 text）
 */
async function api(p, opts = {}) {
  const headers = Object.assign(
    {
      Authorization: `Bearer ${getToken()}`,
      Accept: 'application/json',
    },
    opts.headers || {}
  );
  const r = await fetchExt(
    BASE + p,
    {
      method: opts.method || 'GET',
      headers,
      timeout: opts.timeout || 15000,
    },
    RELAY
  );
  const text = await r.text().catch(() => '');
  let data = text;
  try {
    data = JSON.parse(text);
  } catch (_) {
    /* 可能返回纯文本（如 "no free phones"） */
  }
  if (!r.ok) {
    const err = new Error('5sim API ' + r.status + ': ' + String(text).slice(0, 200));
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return data;
}

class FiveSim {
  constructor(token) {
    this.token = token || null; // getToken() 会在 api() 内读取，token 仅作记录
    this._overrideToken = token || null;
  }

  async getBalance() {
    const data = await api('/user/profile');
    console.log(`  [5sim] 余额: ${data.balance} ${data.currency || 'RUB'} | 评分: ${data.rating}`);
    return data;
  }

  async getProducts(country = 'usa', operator = 'any') {
    return await api(`/guest/products/${country}/${operator}`);
  }

  async getPrices(country = 'usa', product = 'tumblr') {
    return await api(`/guest/prices?country=${encodeURIComponent(country)}&product=${encodeURIComponent(product)}`);
  }

  async buyNumber(country = 'usa', operator = 'any', product = 'tumblr') {
    try {
      const data = await api(`/user/buy/activation/${country}/${operator}/${product}`, { timeout: 30000 });
      console.log(`  [5sim] 购买号码: ${data.phone} (订单 ${data.id}) — ${data.price} RUB`);
      return data;
    } catch (e) {
      // 友好提示常见业务错误
      const t = typeof e.data === 'string' ? e.data : (e.data && JSON.stringify(e.data)) || '';
      if (/no free phones/i.test(t)) console.log('  [5sim] ⚠️ 该国/运营商当前无可用号码');
      else if (/not enough/i.test(t)) console.log('  [5sim] ⚠️ 余额不足');
      throw e;
    }
  }

  async checkOrder(id) {
    return await api(`/user/check/${id}`);
  }

  async finishOrder(id) {
    const data = await api(`/user/finish/${id}`);
    console.log(`  [5sim] 订单 ${id} 已确认完成`);
    return data;
  }

  async cancelOrder(id) {
    try {
      const data = await api(`/user/cancel/${id}`);
      console.log(`  [5sim] 订单 ${id} 已取消（退款）`);
      return data;
    } catch (e) {
      console.log(`  [5sim] 取消订单 ${id} 失败: ${e.message}`);
      return null;
    }
  }

  /**
   * 轮询等待短信验证码。
   * @param {string|number} id 订单 id
   * @param {number} timeoutMs 总超时（默认 180s）
   * @param {number} pollMs 轮询间隔（默认 5s）
   * @returns {Promise<string|null>} 验证码，超时/取消/封禁返回 null
   */
  async waitForCode(id, timeoutMs = 180000, pollMs = 5000) {
    const start = Date.now();
    console.log(`  [5sim] 等待验证码 (订单 ${id})...`);
    while (Date.now() - start < timeoutMs) {
      try {
        const data = await this.checkOrder(id);
        if (data && Array.isArray(data.sms) && data.sms.length > 0) {
          const sms = data.sms[0];
          console.log(`  [5sim] ✅ 收到短信: ${sms.text} | 验证码: ${sms.code}`);
          return String(sms.code);
        }
        if (data && ['CANCELED', 'TIMEOUT', 'BANNED'].includes(data.status)) {
          console.log(`  [5sim] ❌ 订单状态: ${data.status}`);
          return null;
        }
      } catch (e) {
        /* 轮询中的瞬时错误忽略，继续 */
      }
      process.stdout.write('.');
      await new Promise((r) => setTimeout(r, pollMs));
    }
    console.log(`\n  [5sim] ⏰ 等待验证码超时 (${Math.round(timeoutMs / 1000)}s)`);
    return null;
  }
}

/**
 * 一站式购号+等码（不自动 finish，由调用方决定是否确认）。
 * @param {object} o { country, operator, product, timeoutMs }
 * @returns {Promise<{id:string,phone:string,code:string|null}>}
 */
async function buyAndWait(o = {}) {
  const country = o.country || 'usa';
  const operator = o.operator || 'any';
  const product = o.product || 'tumblr';
  const timeoutMs = o.timeoutMs || 180000;
  const sms = new FiveSim(o.token);
  const order = await sms.buyNumber(country, operator, product);
  const code = await sms.waitForCode(order.id, timeoutMs);
  return { id: order.id, phone: order.phone, code, _sms: sms };
}

// 兼容旧版导出；新增 buyAndWait / api / RELAY
module.exports = { FiveSim, TOKEN: DEFAULT_TOKEN, buyAndWait, api, RELAY };
