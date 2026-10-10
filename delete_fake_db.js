// 备份并清空 matrix_accounts_managed 中的假账户（整表均为临时邮箱假号/种子）
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: parseInt(process.env.MYSQL_PORT || '3307', 10),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DB || 'affiliate_system',
  charset: 'utf8mb4',
});

function ts() {
  const d = new Date(); const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

(async () => {
  try {
    const [[{ cnt }]] = await pool.query('SELECT COUNT(*) cnt FROM matrix_accounts_managed');
    console.log('删除前总行数 =', cnt);
    if (cnt === 0) { console.log('表已空，无需操作'); await pool.end(); process.exit(0); }

    // 备份整表
    const bak = `matrix_accounts_managed_bak_${ts()}`;
    await pool.query(`CREATE TABLE IF NOT EXISTS \`${bak}\` LIKE matrix_accounts_managed`);
    await pool.query(`INSERT INTO \`${bak}\` SELECT * FROM matrix_accounts_managed`);
    console.log('已备份到表 ->', bak);

    // 按"非真实"口径统计将被删除的（临时邮箱 / 无凭据 / 非 tumblr-token）
    const FAKE_EMAIL = /@mscms\.mail$/i;
    const TEMP_EMAIL = /guerrillamail|guerrillamailblock|mailinator|10minutemail|10minute-mail|tempmail|throwaway|dispostable|trashmail|temp-mail|fake|sharklasers|getnada|yopmail/i;
    const [rows] = await pool.query('SELECT id, email, platform FROM matrix_accounts_managed');
    const fakeCount = rows.filter(r => FAKE_EMAIL.test(r.email||'') || TEMP_EMAIL.test(r.email||'')).length;
    console.log('其中临时/假邮箱账户 =', fakeCount, ' 其它(无邮箱等) =', rows.length - fakeCount);

    // 清空整表（全部为垃圾种子/临时邮箱假号，无真实可登录账户）
    const [r] = await pool.query('DELETE FROM matrix_accounts_managed');
    console.log('已删除行数 =', r.affectedRows);

    const [[{ cnt2 }]] = await pool.query('SELECT COUNT(*) cnt2 FROM matrix_accounts_managed');
    console.log('删除后总行数 =', cnt2);

    await pool.end();
    console.log('DONE');
    process.exit(0);
  } catch (e) {
    console.error('ERR:', e.message);
    process.exit(1);
  }
})();
