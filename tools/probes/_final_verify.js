const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

const DIR = 'D:\\mscms-ws\\data2';

(async () => {
  // 1) MySQL 伪造链接核查
  try {
    const c = await mysql.createConnection({
      host: '127.0.0.1', port: 3307, user: 'root', password: '',
      database: 'affiliate_system', connectTimeout: 10000,
    });
    const [a] = await c.query("SELECT COUNT(*) c FROM matrix_posts_published");
    const [b] = await c.query("SELECT COUNT(*) c FROM matrix_posts_published WHERE post_url IS NOT NULL AND post_url<>''");
    const [d] = await c.query("SELECT COUNT(*) c FROM matrix_posts_published WHERE status='not_published'");
    const [e] = await c.query("SELECT COUNT(*) c FROM matrix_posts_published WHERE post_url LIKE 'https://%tumblr.com%'");
    const [f] = await c.query("SELECT COUNT(*) c FROM matrix_posts_published WHERE post_url REGEXP '^https://(tiktok|twitter|reddit|instagram|x)\\\\.com/post/'");
    console.log('=== MySQL matrix_posts_published ===');
    console.log('  总行数            = ' + a[0].c);
    console.log('  有 URL 的行       = ' + b[0].c);
    console.log('  标记未发布的行     = ' + d[0].c);
    console.log('  真实 tumblr 链接  = ' + e[0].c);
    console.log('  疑似伪造(平台/post)= ' + f[0].c);
    const [g] = await c.query("SELECT post_url, platform, status FROM matrix_posts_published WHERE post_url IS NOT NULL AND post_url<>'' ORDER BY id DESC LIMIT 3");
    console.log('  最近 3 条:');
    g.forEach((r) => console.log('    [' + r.platform + '] ' + r.status + '  ' + r.post_url));
    await c.end();
  } catch (e) { console.log('MySQL ERR ' + e.code + ' ' + e.message.slice(0, 100)); }

  // 2) JSON 侧 publish_url 核查
  try {
    const p = JSON.parse(fs.readFileSync(path.join(DIR, 'publish.json'), 'utf8'));
    const withUrl = p.filter((x) => x.publish_url);
    const real = withUrl.filter((x) => /^https?:\/\//i.test(String(x.publish_url)));
    console.log('\n=== JSON publish ===');
    console.log('  总数        = ' + p.length);
    console.log('  带 publish_url = ' + withUrl.length);
    console.log('  真实 http(s)   = ' + real.length);
    real.slice(-3).forEach((x) => console.log('    [' + x.platform + '] ' + x.publish_url));
  } catch (e) { console.log('publish ERR ' + e.message); }

  // 3) 数据文件体积
  console.log('\n=== 大文件 TOP5 ===');
  const rows = [];
  for (const f of fs.readdirSync(DIR)) {
    if (!f.endsWith('.json')) continue;
    rows.push({ f, s: fs.statSync(path.join(DIR, f)).size });
  }
  rows.sort((a, b) => b.s - a.s).slice(0, 5)
    .forEach((r) => console.log('  ' + (r.s / 1048576).toFixed(2) + ' MB  ' + r.f));
})();
