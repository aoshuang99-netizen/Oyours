const mysql = require('mysql2/promise');

(async () => {
  const pool = await mysql.createPool({
    host: '127.0.0.1', user: 'root', password: '', database: 'affiliate_system',
    port: 3307, waitForConnections: true, connectionLimit: 3
  });

  // 1) 备份整表（可恢复）
  const bak = 'matrix_posts_published_bak_20260824';
  await pool.query(`CREATE TABLE IF NOT EXISTS \`${bak}\` LIKE matrix_posts_published`);
  await pool.query(`INSERT INTO \`${bak}\` SELECT * FROM matrix_posts_published`);
  console.log('[1] 备份完成 ->', bak);

  // 2) 清理前统计
  const [before] = await pool.query('SELECT COUNT(*) AS c FROM matrix_posts_published WHERE post_url LIKE "%hlua.cc.cd/content%"');
  console.log('[2] 清理前伪造 post_url 数:', before[0].c);

  // 3) 诚实清理：置空伪造 URL + 标记 fake_removed（保留行可审计，不删数据）
  const [upd] = await pool.query(
    "UPDATE matrix_posts_published SET post_url = NULL, status = 'fake_removed', emitted_at = NOW() WHERE post_url LIKE '%hlua.cc.cd/content%'"
  );
  console.log('[3] 已更新行数:', upd.affectedRows);

  // 4) 验证
  const [after] = await pool.query('SELECT COUNT(*) AS c FROM matrix_posts_published WHERE post_url LIKE "%hlua.cc.cd/content%"');
  console.log('[4] 清理后伪造 post_url 数:', after[0].c);

  await pool.end();
  console.log(after[0].c === 0 ? 'MySQL 伪造清理完成 ✅' : '仍有残留 ⚠️');
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
