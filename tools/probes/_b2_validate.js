'use strict';
// B2 验证脚本（隔离，不碰真实账号）：
// 1) 插入一条伪造平台的测试账号 (active)
// 2) PUT /api/v1/managed-/:id {status:'suspended'} 触发封号自愈闭环
// 3) 轮询确认账号自动变 'replaced'（mark-replaced 在 re 监听器内、外部注册之前执行）
// 4) 清理测试账号
const mysql = require('mysql2/promise');
const http = require('http');

const TEST_ID = 99001;
const TEST_BOT = 'b2_validate_test';

 putStatus(id, status) {
  return new Promise((res) => {
    const body = JSON.stringify({ status });
    const req = http.request({
      host: '', port: 3002, path: '/api/v1/managed-/' + id, method: 'PUT',
      headers: { '': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { res({ code: r.statusCode, body: d }); }); });
    req.on('error', e => res({ code: 'ERR', body: e.message }));
    req.write(body); req.end();
  });
}

(async () => {
  const pool = await mysql.createPool({ host: '', port: 3307, user: 'root', : '', database: 'affiliate_system', waitForConnections: true });
  try {
    await pool.execute('DELETE FROM matrix__managed WHERE id=? OR bot_id=?', [TEST_ID, TEST_BOT]);
    await pool.execute(
      'INSERT INTO matrix__managed (id, bot_id, , , , email, status, , updated_at) VALUES (?,?,?,?,?,?,?,NOW(),NOW())',
      [TEST_ID, TEST_BOT, 'b2test', 'b2_validate', 'b2testpass', 'b2_validate@test.com', 'active']
    );
    console.log('[1] 已插入测试账号 id=' + TEST_ID + ' status=active');

    const before = await pool.execute('SELECT id,status,notes FROM matrix__managed WHERE id=?', [TEST_ID]);
    console.log('[2] PUT suspended 前:', JSON.stringify(before[0][0]));

    const put = await putStatus(TEST_ID, 'suspended');
    console.log('[3] PUT 响应:', put.code, put.body);

    let validated = false;
    for (let i = 0; i < 12; i++) {
      await new Promise(s => setTimeout(s, 1000));
      const [rows] = await pool.execute('SELECT id,status,notes FROM matrix__managed WHERE id=?', [TEST_ID]);
      const row = rows[0];
      console.log(`[4] 轮询 ${i}:`, JSON.stringify(row));
      if (row && row.status === 'replaced') { validated = true; break; }
    }
    console.log(validated ? '✅ B2 验证通过：封号账号自动变 replaced（闭环完成）' : '❌ B2 未验证：账号未变 replaced');
  } catch (e) {
    console.error('验证脚本异常:', e.message);
  } finally {
    await pool.execute('DELETE FROM matrix__managed WHERE id=? OR bot_id=?', [TEST_ID, TEST_BOT]).catch(() => {});
    console.log('[5] 已清理测试账号');
    await pool.end();
  }
})();
