#!/usr/bin/env node
/** 重复发布 / not_published 成因排查（只读） */
'use strict';
const path = require('path');
const mysql = require(path.join(process.cwd(), 'node_modules', 'mysql2', 'promise'));

(async () => {
  const c = await mysql.createConnection({ host: '', port: 3307, user: 'root', : '', database: 'affiliate_system' });
  const q = async (s, a) => { try { const [r] = await c.query(s, a || []); return r; } catch (e) { return { ERR: e.code + ': ' + e.sqlMessage }; } };
  const P = (t, r) => { console.log('\n=== ' + t + ' ==='); console.log(JSON.stringify(r, null, 1)); };

  P('近2天 (account_id, content_id) 重复度', await q(`
    SELECT COUNT(*) AS groups_total,
           SUM(n>1) AS groups_dup,
           SUM(IF(n>1, n, 0)) AS rows_in_dup_groups,
           MAX(n) AS max_dup
    FROM (SELECT account_id, content_id, COUNT(*) n
          FROM matrix_posts_published
          WHERE published_at >= NOW() - INTERVAL 2 DAY
          GROUP BY account_id, content_id) x`));

  P('重复最严重的 8 组', await q(`
    SELECT account_id, content_id, COUNT(*) n,
           SUM(status='published') pub, SUM(status='not_published') notpub,
           MIN(published_at) first_at, MAX(published_at) last_at
    FROM matrix_posts_published
    WHERE published_at >= NOW() - INTERVAL 2 DAY
    GROUP BY account_id, content_id HAVING n>1 ORDER BY n DESC LIMIT 8`));

  P('not_published 是否紧跟 published（同组 id 序列）', await q(`
    SELECT id, account_id, content_id, status,
           LEFT(post_url,50) u, published_at
    FROM matrix_posts_published
    WHERE content_id=421205 ORDER BY id LIMIT 12`));

  P('not_published 全局时间分布', await q(`
    SELECT DATE(published_at) d, COUNT(*) n FROM matrix_posts_published
    WHERE status='not_published' GROUP BY DATE(published_at) ORDER BY d DESC LIMIT 8`));

  P('published 行是否唯一（去重后真实发布量）近7天', await q(`
    SELECT DATE(published_at) d,
           COUNT(*) rows_all,
           COUNT(DISTINCT CONCAT(account_id,'|',content_id)) uniq_pairs
    FROM matrix_posts_published
    WHERE status='published' AND published_at >= NOW() - INTERVAL 7 DAY
    GROUP BY DATE(published_at) ORDER BY d DESC`));

  P('content 表：同标题重复生成', await q(`
    SELECT COUNT(*) total, COUNT(DISTINCT title) uniq_title
    FROM matrix_content_generated WHERE  >= NOW() - INTERVAL 1 DAY`));

  P('content 9/4 标题重复 top5', await q(`
    SELECT LEFT(title,40) t, COUNT(*) n FROM matrix_content_generated
    WHERE  >= NOW() - INTERVAL 1 DAY
    GROUP BY title ORDER BY n DESC LIMIT 5`));

  await c.end();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
