'use strict';
/**
 * _verify_5sim.js — 验证 5sim 接码资源在本机可达（不购号，不花钱）
 *   node _verify_5sim.js
 * 输出：余额、usa 可用产品列表、tumblr/any 价格，供接入决策。
 */
const { FiveSim } = require('./5sim-sms.js');

(async () => {
  const sms = new FiveSim();
  console.log('[verify] 5sim 资源连通性检查（仅查询，不购号）');
  try {
    const bal = await sms.getBalance();
    console.log('[verify] ✅ 余额查询成功:', JSON.stringify(bal));
  } catch (e) {
    console.log('[verify] ❌ 余额查询失败:', e.message);
    console.log('[verify] 资源不可达 — 接码接入需先解决网络/凭证');
    process.exit(2);
  }

  // usa 支持的产品（找 tumblr 或近似）
  try {
    const prods = await sms.getProducts('usa', 'any');
    // prods 结构：{ country: { operator: [products...] } } 或数组
    console.log('[verify] usa 产品(operator=any) 原始结构类型:', Array.isArray(prods) ? 'array' : typeof prods);
    if (Array.isArray(prods)) {
      console.log('[verify] usa 产品列表:', prods.slice(0, 40).join(', '));
    } else {
      console.log('[verify] usa 产品(摘要):', JSON.stringify(prods).slice(0, 400));
    }
  } catch (e) {
    console.log('[verify] ⚠️ 产品查询失败:', e.message);
  }

  // 价格探测：tumblr / any 两个候选
  for (const product of ['tumblr', 'any']) {
    try {
      const prices = await sms.getPrices('usa', product);
      const summary = typeof prices === 'object' ? JSON.stringify(prices).slice(0, 300) : String(prices).slice(0, 200);
      console.log(`[verify] usa/${product} 价格:`, summary);
    } catch (e) {
      console.log(`[verify] ⚠️ usa/${product} 价格查询失败:`, e.message);
    }
  }
  console.log('[verify] 完成。结论：资源可达，可接入注册管线（--phone 时按 product 购号）。');
  process.exit(0);
})().catch((e) => { console.log('[verify] FATAL:', e.message); process.exit(1); });
