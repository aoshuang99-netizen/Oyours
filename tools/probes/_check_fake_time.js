const mysql = require('mysql2/promise');

(async () => {
  const c = await mysql.createConnection({
    host: '', port: 3307, user: 'root', : '',
    database: 'affiliate_system', connectTimeout: 10000,
  });

  const [t] = await c.query(
    "SELECT MIN(id) minId, MAX(id) maxId, COUNT(*) c FROM matrix_posts_published WHERE post_url REGEXP '^https://(tiktok|twitter|reddit|instagram|x)\\.com/post/'"
  );
  console.log('=== 伪造记录 id 分布 ===');
  console.log('  数量 = ' + t[0].c + '  id 范围 = ' + t[0].minId + ' ~ ' + t[0].maxId);

  const [real] = await c.query(
    "SELECT MIN(id) minId, MAX(id) maxId, COUNT(*) c FROM matrix_posts_published WHERE post_url LIKE '%tumblr.com/blog/view/%'"
  );
  console.log('=== 真实 tumblr 记录 id 分布 ===');
  console.log('  数量 = ' + real[0].c + '  id 范围 = ' + real[0].minId + ' ~ ' + real[0].maxId);

  const [maxAll] = await c.query('SELECT MAX(id) m FROM matrix_posts_published');
  console.log('  全表最大 id = ' + maxAll[0].m);

  // 最大 id 附近的最近 5 条，看是真是假
  const [last] = await c.query(
    'SELECT id, , post_url, status FROM matrix_posts_published ORDER BY id DESC LIMIT 5'
  );
  console.log('  最近 5 条记录:');
  last.forEach((r) => console.log('    id=' + r.id + ' [' + r. + '] ' + r.status + '  ' + (r.post_url || '(NULL)')));

  await c.end();
})();
