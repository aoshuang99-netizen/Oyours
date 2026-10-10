#!/usr/bin/env node
/** MySQL 表体积 / 备份表时间范围 / 空 URL 发布记录分布（只读） */
'use strict';
const path = require('path');
const mysql = require(path.join(process.cwd(), 'node_modules', 'mysql2', 'promise'));

(async () => {
  const conn = await mysql.createConnection({ host: '127.0.0.1', port: 3307, user: 'root', password: '', database: 'affiliate_system' });
  const q = async (sql, args) => { try { const [r] = await conn.query(sql, args || []); return r; } catch (e) { return { ERR: e.code || e.message }; } };

  console.log('=== 表体积 (information_schema) ===');
  // 注意: information_schema 返回的列名是大写 (TABLE_NAME/TABLE_ROWS)
  const sizes = await q(`SELECT table_name, table_rows,
      ROUND((data_length+index_length)/1048576,1) AS mb,
      ROUND(data_free/1048576,1) AS free_mb, engine
    FROM information_schema.tables WHERE table_schema='affiliate_system'
    ORDER BY (data_length+index_length) DESC`);
  let totalMb = 0, bakMb = 0;
  for (const s of sizes) {
    const name = s.TABLE_NAME || s.table_name;
    const rows = s.TABLE_ROWS || s.table_rows;
    const mb = Number(s.mb) || 0;
    totalMb += mb;
    if (/(_bak|backup)/i.test(String(name))) bakMb += mb;
    console.log(`  ${String(name).padEnd(48)} rows=${String(rows).padStart(8)}  ${String(mb).padStart(8)} MB  free=${s.free_mb}  ${s.engine}`);
  }
  console.log('  合计: ' + totalMb.toFixed(1) + ' MB，其中备份表 ' + bakMb.toFixed(1) + ' MB');

  console.log('\n=== matrix_posts_published: 按 published_at 分布（该表无 created_at）===');
  const dist = await q(`SELECT DATE(published_at) AS d, COUNT(*) AS n,
      SUM(post_url IS NULL OR post_url='') AS empty_url,
      SUM(status='published') AS st_pub,
      SUM(status='failed') AS st_fail,
      SUM(status='fake_removed') AS st_fake
    FROM matrix_posts_published GROUP BY DATE(published_at) ORDER BY d DESC LIMIT 14`);
  if (!Array.isArray(dist)) { console.log('  ' + JSON.stringify(dist)); }
  else for (const r of dist) console.log('  ' + r.d + '  总=' + r.n + '  空URL=' + r.empty_url + '  published=' + r.st_pub + '  failed=' + r.st_fail + '  fake_removed=' + r.st_fake);

  const st = await q(`SELECT status, COUNT(*) AS n FROM matrix_posts_published GROUP BY status ORDER BY n DESC`);
  console.log('\n  status 全量分布: ' + st.map((r) => `${r.status || '(null)'} = ${r.n}`).join(' | '));

  console.log('\n=== content 表时间分布 ===');
  const cd = await q(`SELECT DATE(created_at) AS d, COUNT(*) AS n,
      SUM(emitted_at IS NULL) AS not_emitted,
      SUM(media_path IS NOT NULL AND media_path<>'') AS with_media
    FROM matrix_content_generated GROUP BY DATE(created_at) ORDER BY d DESC LIMIT 10`);
  for (const r of cd) console.log('  ' + r.d + '  总=' + r.n + '  未emit=' + r.not_emitted + '  带媒体=' + r.with_media);

  console.log('\n=== 备份表时间范围 ===');
  for (const t of ['matrix_posts_published_bak_20260824', 'matrix_posts_published_bak_tumblrpost', 'matrix_posts_published_bak_fake_1787994821167', 'matrix_accounts_managed_bak_20260815_174618']) {
    const exists = await q(`SELECT COUNT(*) AS n FROM \`${t}\``);
    if (exists.ERR) { console.log('  ' + t + ': ' + JSON.stringify(exists)); continue; }
    let rng = '(no time col)';
    const cols = await q(`SHOW COLUMNS FROM \`${t}\``);
    const names = Array.isArray(cols) ? cols.map((c) => c.Field) : [];
    const timeCol = names.includes('created_at') ? 'created_at' : (names.includes('published_at') ? 'published_at' : null);
    if (timeCol) {
      const r = await q(`SELECT MIN(\`${timeCol}\`) a, MAX(\`${timeCol}\`) b FROM \`${t}\``);
      rng = timeCol + ': ' + r[0].a + ' ~ ' + r[0].b;
    }
    let fake = 'n/a';
    if (names.includes('post_url')) {
      const f = await q(`SELECT COUNT(*) AS n FROM \`${t}\` WHERE post_url LIKE '%hlua.cc.cd/content%'`);
      fake = f[0].n + ' 条伪造';
    }
    console.log('  ' + t.padEnd(46) + ' rows=' + exists[0].n + '  ' + rng + '  ' + fake);
  }

  console.log('\n=== 外键/引用检查：代码是否引用备份表 ===');
  await conn.end();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
