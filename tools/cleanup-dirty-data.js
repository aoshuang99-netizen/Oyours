#!/usr/bin/env node
/**
 * MSCMS 脏数据清理（默认 dry-run，加 --apply 才真正执行）
 *
 * 清理项：
 *  1) matrix_posts_published: status='fake_removed' 的历史占位行（post_url 已置 NULL，无业务价值）
 *  2) matrix_posts_published: 近 7 天 (account_id, content_id) 重复行，每组保留最早 2 条
 *  3) matrix_content_generated: preview_url 为存档 JSON 路径的脏值 → NULL
 *  4) DROP 历史备份表（已 mysqldump 到 D:/mscms-backup/20260904-2010/dropped_bak_tables.sql）
 *  5) 删除完成后 OPTIMIZE 回收磁盘
 *
 * 前提：已备份（tools/backup-before-cleanup.sh），主服务 :3002 已停止。
 */
'use strict';
const path = require('path');
const mysql = require(path.join(process.cwd(), 'node_modules', 'mysql2', 'promise'));

const APPLY = process.argv.includes('--apply');
const DUP_WINDOW_DAYS = 7;
const DUP_KEEP = 2;

const BAK_TABLES = [
  'matrix_posts_published_bak_20260824',
  'matrix_posts_published_bak_tumblrpost',
  'matrix_posts_published_bak_fake_1787994821167',
  'matrix_accounts_managed_bak_20260815_174618',
  'matrix_posts_published_bak_placeholders',
];

(async () => {
  const c = await mysql.createConnection({ host: '127.0.0.1', port: 3307, user: 'root', password: '', database: 'affiliate_system' });
  const q = async (s, a) => { const [r] = await c.query(s, a || []); return r; };
  const num = async (s) => { const r = await q(s); return Number(Object.values(r[0])[0]); };

  console.log(APPLY ? '=== 执行模式 (--apply) ===' : '=== DRY-RUN 模式（加 --apply 才会真正删除）===');

  // ---------- before ----------
  const before = {
    rows: await num('SELECT COUNT(*) FROM matrix_posts_published'),
    fake: await num("SELECT COUNT(*) FROM matrix_posts_published WHERE status='fake_removed'"),
    dup: await num(`SELECT COUNT(*) FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY account_id, content_id ORDER BY id) rn
        FROM matrix_posts_published WHERE published_at >= NOW() - INTERVAL ${DUP_WINDOW_DAYS} DAY) x WHERE x.rn > ${DUP_KEEP}`),
    dirtyPreview: await num("SELECT COUNT(*) FROM matrix_content_generated WHERE preview_url LIKE '%.json'"),
  };
  console.log('\n--- 清理前 ---');
  console.log(JSON.stringify(before, null, 1));

  if (!APPLY) {
    console.log('\n将删除: fake_removed ' + before.fake + ' 行, 近7天重复 ' + before.dup + ' 行');
    console.log('将更新: preview_url 脏值 ' + before.dirtyPreview + ' 行 → NULL');
    console.log('将 DROP: ' + BAK_TABLES.join(', '));
    await c.end();
    return;
  }

  const t0 = Date.now();
  // ---------- 1) fake_removed 分批删 ----------
  let deletedFake = 0;
  for (let i = 0; i < 40; i++) {
    const r = await q("DELETE FROM matrix_posts_published WHERE status='fake_removed' LIMIT 50000");
    const n = r.affectedRows || 0;
    deletedFake += n;
    process.stdout.write(`\r  [1/5] 删除 fake_removed: ${deletedFake} 行   `);
    if (n < 50000) break;
  }
  console.log(`\n  [1/5] 完成，共删除 ${deletedFake} 行 (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  // ---------- 2) 重复行 ----------
  const r2 = await q(`DELETE t FROM matrix_posts_published t
    JOIN (SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY account_id, content_id ORDER BY id) rn
        FROM matrix_posts_published WHERE published_at >= NOW() - INTERVAL ${DUP_WINDOW_DAYS} DAY) x
      WHERE x.rn > ${DUP_KEEP}) d ON t.id = d.id`);
  console.log(`  [2/5] 删除近${DUP_WINDOW_DAYS}天重复行 ${r2.affectedRows} 行（每组保留最早 ${DUP_KEEP} 条）`);

  // ---------- 3) preview_url 脏值 ----------
  const r3 = await q("UPDATE matrix_content_generated SET preview_url=NULL WHERE preview_url LIKE '%.json'");
  console.log(`  [3/5] preview_url 脏值置 NULL: ${r3.affectedRows} 行`);

  // ---------- 4) DROP 备份表 ----------
  for (const t of BAK_TABLES) {
    try {
      const n = await num(`SELECT COUNT(*) FROM \`${t}\``);
      await q(`DROP TABLE IF EXISTS \`${t}\``);
      console.log(`  [4/5] DROP ${t} (原 ${n} 行)`);
    } catch (e) {
      console.log(`  [4/5] DROP ${t} 失败/不存在: ${e.code || e.message}`);
    }
  }

  // ---------- 5) OPTIMIZE ----------
  const tables = (await q("SELECT TABLE_NAME FROM information_schema.tables WHERE table_schema='affiliate_system' AND ENGINE='InnoDB'"))
    .map((r) => r.TABLE_NAME);
  for (const t of tables) {
    try {
      const t1 = Date.now();
      await q(`OPTIMIZE TABLE \`${t}\``);
      console.log(`  [5/5] OPTIMIZE ${t} (${((Date.now() - t1) / 1000).toFixed(1)}s)`);
    } catch (e) { console.log(`  [5/5] OPTIMIZE ${t} 跳过: ${e.code || e.message}`); }
  }

  // ---------- after ----------
  const after = {
    rows: await num('SELECT COUNT(*) FROM matrix_posts_published'),
    fake: await num("SELECT COUNT(*) FROM matrix_posts_published WHERE status='fake_removed'"),
    dup: await num(`SELECT COUNT(*) FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY account_id, content_id ORDER BY id) rn
        FROM matrix_posts_published WHERE published_at >= NOW() - INTERVAL ${DUP_WINDOW_DAYS} DAY) x WHERE x.rn > ${DUP_KEEP}`),
    dirtyPreview: await num("SELECT COUNT(*) FROM matrix_content_generated WHERE preview_url LIKE '%.json'"),
  };
  const sizes = await q(`SELECT ROUND(SUM(data_length+index_length)/1048576,1) mb FROM information_schema.tables WHERE table_schema='affiliate_system'`);
  console.log('\n--- 清理后 ---');
  console.log(JSON.stringify(after, null, 1));
  console.log('数据库总大小: ' + (Object.values(sizes[0])[0] || 0) + ' MB');
  console.log('总耗时: ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');

  await c.end();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
