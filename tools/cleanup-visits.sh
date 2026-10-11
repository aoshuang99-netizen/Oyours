#!/usr/bin/env bash
# 清理 matrix_visits_recorded 伪造访问记录（先 mysqldump 备份，再删除，最后 OPTIMIZE）
set -u
BK=D:/mscms-backup/20260904-2010
MYSQLDUMP="C:/Users/AS/WorkBuddy/2026-06-13-19-42-19/mysql-8.0.41-winx64/bin/mysqldump.exe"

echo "[1/3] 备份 matrix_visits_recorded ..."
"$MYSQLDUMP" -h -P3307 -uroot affiliate_system matrix_visits_recorded > "$BK/visits_recorded.sql" 2>"$BK/visits_recorded.err"
echo "  $(wc -c < "$BK/visits_recorded.sql") bytes  err=$(wc -c < "$BK/visits_recorded.err") bytes"

echo "[2/3] 删除伪造记录 ..."
"C:/Users/AS/.workbuddy/binaries/node/versions/22.22.2-6/node.exe" -e "
const mysql=require('C:/Users/AS/WorkBuddy/2026-06-13-19-42-19/node_modules/mysql2/promise');
(async()=>{
  const c=await mysql.createConnection({host:'',port:3307,user:'root',:'''affiliate_system'});
  const q=async(s)=>{const [r]=await c.query(s);return r};
  const before=(await q('SELECT COUNT(*) n FROM matrix_visits_recorded'))[0].n;
  console.log('  删除前:', before);
  let total=0;
  for(let i=0;i<30;i++){
    const r=await q(\"DELETE FROM matrix_visits_recorded WHERE landing_page LIKE '%hlua.cc.cd%' OR landing_page LIKE '%localhost%' OR landing_page LIKE '%%' OR landing_page REGEXP '^https?://[a-z]+\\\\\\\\.com/post/[0-9]+\$' LIMIT 50000\");
    total+=r.affectedRows||0;
    process.stdout.write('\r    已删 '+total+' 行   ');
    if((r.affectedRows||0)<50000) break;
  }
  console.log('\n  共删除:', total);
  const after=(await q('SELECT COUNT(*) n FROM matrix_visits_recorded'))[0].n;
  console.log('  删除后:', after);
  console.log('  剩余 landing_page 分布:', JSON.stringify(await q(\"SELECT SUBSTRING_INDEX(SUBSTRING_INDEX(landing_page,'/',3),'//',-1) host, COUNT(*) n FROM matrix_visits_recorded WHERE landing_page IS NOT NULL AND landing_page<>'' GROUP BY host ORDER BY n DESC LIMIT 6\")));
  await c.end();
})().catch(e=>console.log('FATAL',e.message));
"

echo "[3/3] OPTIMIZE 回收空间 ..."
"C:/Users/AS/.workbuddy/binaries/node/versions/22.22.2-6/node.exe" -e "
const mysql=require('C:/Users/AS/WorkBuddy/2026-06-13-19-42-19/node_modules/mysql2/promise');
(async()=>{
  const c=await mysql.createConnection({host:'',port:3307,user:'root',:'''affiliate_system'});
  const t0=Date.now();
  await c.query('OPTIMIZE TABLE matrix_visits_recorded');
  console.log('  OPTIMIZE 完成 ('+((Date.now()-t0)/1000).toFixed(1)+'s)');
  const s=await c.query(\"SELECT ROUND(SUM(data_length+index_length)/1048576,1) mb FROM information_schema.tables WHERE table_schema='affiliate_system'\");
  console.log('  数据库总大小:', Object.values(s[0][0])[0], 'MB');
  await c.end();
})().catch(e=>console.log('FATAL',e.message));
"
echo "=== 完成 ==="
