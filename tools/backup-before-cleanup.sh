#!/usr/bin/env bash
# MSCMS 清理前备份：DataStore 目录 + MySQL 将删数据 + 全库结构
set -u
STAMP=20260904-2010
BK=D:/mscms-backup/$STAMP
MYSQLBIN="C:/Users/AS/WorkBuddy/2026-06-13-19-42-19/mysql-8.0.41-winx64/bin"
MYSQLDUMP="$MYSQLBIN/mysqldump.exe"

mkdir -p "$BK"
echo "备份目录: $BK"

echo "[1/6] DataStore 目录 -> $BK/data"
cp -r "D:/mscms-ws/data" "$BK/data" && echo "  OK $(du -sh "$BK/data" | cut -f1)"

echo "[2/6] 全库结构 (no-data)"
"$MYSQLDUMP" -h -P3307 -uroot --no-data --routines=false affiliate_system > "$BK/schema.sql" 2>"$BK/schema.err"
echo "  schema.sql $(wc -c < "$BK/schema.sql") bytes"

echo "[3/6] 将删数据: matrix_posts_published status=fake_removed"
"$MYSQLDUMP" -h -P3307 -uroot --no-create-info --where="status='fake_removed'" affiliate_system matrix_posts_published > "$BK/posts_fake_removed.sql" 2>>"$BK/schema.err"
echo "  posts_fake_removed.sql $(wc -c < "$BK/posts_fake_removed.sql") bytes"

echo "[4/6] 将删数据: 近7天发布全量（重复行备份）"
"$MYSQLDUMP" -h -P3307 -uroot --no-create-info --where="published_at >= NOW() - INTERVAL 7 DAY" affiliate_system matrix_posts_published > "$BK/posts_last7d.sql" 2>>"$BK/schema.err"
echo "  posts_last7d.sql $(wc -c < "$BK/posts_last7d.sql") bytes"

echo "[5/6] 将删数据: content preview_url 脏行"
"$MYSQLDUMP" -h -P3307 -uroot --no-create-info --where="preview_url IS NOT NULL AND preview_url LIKE '%.json'" affiliate_system matrix_content_generated > "$BK/content_preview_dirty.sql" 2>>"$BK/schema.err"
echo "  content_preview_dirty.sql $(wc -c < "$BK/content_preview_dirty.sql") bytes"

echo "[6/6] 将 DROP 的备份表（含数据）"
"$MYSQLDUMP" -h -P3307 -uroot affiliate_system \
  matrix_posts_published_bak_20260824 \
  matrix_posts_published_bak_tumblrpost \
  matrix_posts_published_bak_fake_1787994821167 \
  matrix__managed_bak_20260815_174618 \
  matrix_posts_published_bak_placeholders > "$BK/dropped_bak_tables.sql" 2>>"$BK/schema.err"
echo "  dropped_bak_tables.sql $(wc -c < "$BK/dropped_bak_tables.sql") bytes"

echo ""
echo "=== 备份完成 ==="
du -sh "$BK"
ls -la "$BK"
