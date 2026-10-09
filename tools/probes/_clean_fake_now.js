const mysql = require('mysql2/promise');

(async () => {
  const c = await mysql.createConnection({
    host: '', port: 3307, user: 'root', : '',
    database: 'affiliate_system', connectTimeout: 15000,
  });

  const FAKE_RE = "^https://(tiktok|twitter|reddit|instagram|x)\\.com/post/";

  // 1) 计数
  const [cnt] = await c.query(
    'SELECT COUNT(*) c FROM matrix_posts_published WHERE post_url REGEXP ?', [FAKE_RE]
  );
  console.log('待清理伪造记录 = ' + cnt[0].c);

  if (cnt[0].c === 0) {
    console.log('无需清理');
    await c.end();
    return;
  }

  // 2) 备份到 bak 表
  const bak = 'matrix_posts_published_bak_fake_' + Date.now();
  await c.query('CREATE TABLE ' + bak + ' AS SELECT * FROM matrix_posts_published WHERE post_url REGEXP ?', [FAKE_RE]);
  const [bk] = await c.query('SELECT COUNT(*) c FROM ' + bak);
  console.log('已备份到 ' + bak + ' (' + bk[0].c + ' 行)');

  // 3) 清理：置空假链接并标记
  const [upd] = await c.query(
    "UPDATE matrix_posts_published SET post_url = NULL, status = 'fake_removed', note_count = 0 WHERE post_url REGEXP ?",
    [FAKE_RE]
  );
  console.log('已清理 ' + upd.affectedRows + ' 行');

  // 4) 复核
  const [left] = await c.query(
    'SELECT COUNT(*) c FROM matrix_posts_published WHERE post_url REGEXP ?', [FAKE_RE]
  );
  console.log('清理后剩余伪造 = ' + left[0].c);

  const [remain] = await c.query(
    "SELECT COUNT(*) c FROM matrix_posts_published WHERE post_url IS NOT NULL AND post_url <> ''"
  );
  console.log('表中仍保留的有效 URL 行 = ' + remain[0].c);

  await c.end();
})();
