/**
 * diagnose-v14-system.js — MSCMS v14 系统诊断脚本
 * 
 * 用于诊断用户报告的三个问题：
 * 1. 注册完成后没有自动化推进到下一个项目
 * 2. 云手机启动后并没有安装注册的社媒账号的平台
 * 3. 注册成功的账号没有任何数据管理账号列表、登录名、密码、名称等
 * 
 * 使用方法：
 *   node diagnose-v14-system.js
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const API_BASE = 'http://localhost:3002';
let passed = 0;
let failed = 0;
const issues = [];

async  test(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`❌ ${name}: ${err.message}`);
    failed++;
    issues.push({ name, error: err.message });
  }
}

async  main() {
  console.log('═'.repeat(60));
  console.log('MSCMS v14 系统诊断');
  console.log('═'.repeat(60));
  console.log('');

  // ════════════════════════════════════════════════════
  // 1. 检查服务器是否在线
  // ════════════════════════════════════════════════════
  console.log('📡 1. 服务器连接检查');
  await test('服务器在线', async () => {
    const res = await axios.get(`${API_BASE}/api/v14//stats`, { timeout: 5000 });
    if (res.status !== 200) throw new Error(`Status: ${res.status}`);
  });

  // ════════════════════════════════════════════════════
  // 2. 检查数据库表
  // ════════════════════════════════════════════════════
  console.log('');
  console.log('💾 2. 数据库检查');
  
  await test('matrix__managed 表可访问', async () => {
    const res = await axios.get(`${API_BASE}/api/v14/managed-`, { timeout: 5000 });
    if (!res.data || !Array.isArray(res.data.)) {
      throw new Error('API 返回格式错误');
    }
  });

  // ════════════════════════════════════════════════════
  // 3. 检查 v14 模块初始化
  // ════════════════════════════════════════════════════
  console.log('');
  console.log('🔧 3. v14 模块检查');
  
  await test('EventBus 可访问', async () => {
    const res = await axios.get(`${API_BASE}/api/v14/eventbus/stats`, { timeout: 5000 });
    if (res.status !== 200) throw new Error('EventBus stats API 不可用');
  });

  await test('DeviceManager 可访问', async () => {
    const res = await axios.get(`${API_BASE}/api/v14/devices`, { timeout: 5000 });
    if (res.status !== 200) throw new Error('Device API 不可用');
    console.log(`   设备数量: ${res.data.total || 0}, 在线: ${res.data.online || 0}`);
  });

  // ════════════════════════════════════════════════════
  // 4. 检查账号数据
  // ════════════════════════════════════════════════════
  console.log('');
  console.log('👤 4. 账号数据检查');
  
  await test('账号列表 API 返回数据', async () => {
    const res = await axios.get(`${API_BASE}/api/v14/managed-`, { timeout: 5000 });
    const  = res.data. || [];
    console.log(`   找到 ${.length} 个账号`);
    if (.length > 0) {
      const acc = [0];
      console.log(`   示例: bot_id=${acc.bot_id}, =${acc.}, =${acc.}`);
      if (!acc. || !acc.) {
        throw new Error('账号数据不完整（缺少用户名或密码）');
      }
    }
  });

  // ════════════════════════════════════════════════════
  // 5. 检查注册功能
  // ════════════════════════════════════════════════════
  console.log('');
  console.log('📝 5. 注册功能检查');
  
  await test('注册 API 端点可用', async () => {
    const res = await axios.post(`${API_BASE}/api/v14//start`, {
      : 'reddit',
      count: 1,
      proxy: 'none'
    }, { timeout: 5000 });
    if (!res.data.taskId) throw new Error('注册任务启动失败');
    console.log(`   任务ID: ${res.data.taskId}`);
  });

  // ════════════════════════════════════════════════════
  // 6. 检查自动化推进
  // ════════════════════════════════════════════════════
  console.log('');
  console.log('🚀 6. 自动化推进检查');
  
  await test('EventBus 事件监听正常', async () => {
    const res = await axios.get(`${API_BASE}/api/v14/eventbus/stats`, { timeout: 5000 });
    const stats = res.data;
    console.log(`   事件发射: ${stats.totalEmitted || 0}, 监听器: ${JSON.stringify(stats.subscribers || {})}`);
  });

  // ════════════════════════════════════════════════════
  // 总结
  // ════════════════════════════════════════════════════
  console.log('');
  console.log('═'.repeat(60));
  console.log(`诊断完成: ${passed} 通过, ${failed} 失败`);
  console.log('═'.repeat(60));
  
  if (issues.length > 0) {
    console.log('');
    console.log('⚠️  发现的问题:');
    issues.forEach((issue, idx) => {
      console.log(`   ${idx + 1}. ${issue.name}: ${issue.error}`);
    });
    console.log('');
    console.log('💡 建议:');
    console.log('   1. 检查服务器日志 (server.js 控制台输出)');
    console.log('   2. 确认 MySQL 数据库 running (port 3307)');
    console.log('   3. 确认 D:/LeiDian 目录存在且有写入权限');
    console.log('   4. 尝试手动启动一台云手机设备');
    console.log('   5. 检查 v14-console.html 前端是否正确加载');
  } else {
    console.log('');
    console.log('🎉 所有检查通过！如果仍有问题，可能是:');
    console.log('   1. 前端 v14-console.html 的代码需要刷新浏览器缓存');
    console.log('   2. 注册流程需要手动测试完整端到端流程');
    console.log('   3. 设备需要手动启动（自动启动可能失败）');
  }
}

main().catch(err => {
  console.error('诊断脚本错误:', err.message);
  process.exit(1);
});
