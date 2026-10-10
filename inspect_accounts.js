// 只读核查：复制接口 isReal 逻辑，列出 matrix_accounts_managed 中真实/假账户，并交叉验证
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

const FAKE_EMAIL = /@mscms\.mail$/i;
const TEMP_EMAIL = /guerrillamail|guerrillamailblock|mailinator|10minutemail|tempmail|throwaway|dispostable|trashmail|temp-mail|fake|sharklasers|getnada|yopmail/i;

function loadTokenIds() {
  try {
    const p = path.join(__dirname, 'data', 'tumblr_token.json');
    const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
    const ids = new Set();
    for (const t of arr) {
      if (t && (t.id || t.oauthToken)) ids.add(t.id);
    }
    return ids;
  } catch (e) {
    console.warn('[warn] 读取 tumblr_token.json 失败:', e.message);
    return new Set();
  }
}

function isReal(a, tokenIds) {
  const hasCreds = !!(a.email && a.password);
  const hasApiToken = tokenIds.has(a.id);
  const suspiciousEmail = FAKE_EMAIL.test(a.email || '') || TEMP_EMAIL.test(a.email || '');
  return (hasCreds && !suspiciousEmail) || (a.platform === 'tumblr' && hasApiToken);
}

(async () => {
  try {
    const tokenIds = loadTokenIds();
    console.log('tokenIds size =', tokenIds.size);

    const [desc] = await pool.query('DESCRIBE matrix_accounts_managed');
    console.log('\n=== 表结构 (matrix_accounts_managed) ===');
    for (const c of desc) console.log(`  ${c.Field} ${c.Type} ${c.Key === 'PRI' ? '[PK]' : ''} ${c.Null === 'NO' ? 'NOT NULL' : ''}`);

    const [rows] = await pool.query(
      `SELECT id, bot_id, platform, username, email, password, status, is_valid, created_at
       FROM matrix_accounts_managed`
    );
    console.log('\nDB 总行数 =', rows.length);

    const real = [], fake = [];
    for (const r of rows) {
      (isReal(r, tokenIds) ? real : fake).push(r);
    }
    console.log('真实 =', real.length, ' 假 =', fake.length);

    console.log('\n--- 真实账户 (id / platform / username / email) ---');
    for (const r of real) console.log(`  ${r.id} | ${r.platform} | ${r.username} | ${r.email} | is_valid=${r.is_valid}`);

    console.log('\n--- 假账户统计 (按 platform+邮箱特征) ---');
    const byPlat = {};
    for (const r of fake) {
      const key = (r.platform || '-') + (FAKE_EMAIL.test(r.email||'') ? '[mscms.mail]' : TEMP_EMAIL.test(r.email||'') ? '[temp]' : (r.email ? '[other]' : '[no-email]'));
      byPlat[key] = (byPlat[key] || 0) + 1;
    }
    for (const k of Object.keys(byPlat).sort()) console.log(`  ${k}: ${byPlat[k]}`);

    console.log('\n--- 假账户样例 (前 15) ---');
    for (const r of fake.slice(0, 15)) console.log(`  ${r.id} | ${r.platform} | ${r.username} | ${r.email || '(无)'}`);

    // 交叉验证：accounts.json 中 isReal 的账号是否都在 DB
    const ap = path.join(__dirname, 'data', 'accounts.json');
    const accts = JSON.parse(fs.readFileSync(ap, 'utf8'));
    const realAcctIds = new Set(accts.filter(a => isReal(a, tokenIds)).map(a => a.id));
    const dbIds = new Set(rows.map(r => r.id));
    const missing = [...realAcctIds].filter(id => !dbIds.has(id));
    console.log('\n=== 交叉验证 ===');
    console.log('accounts.json 中真实账号数 =', realAcctIds.size);
    console.log('DB 中真实账号数 =', real.length);
    console.log('accounts.json 真号但不在 DB 中的 id (孤儿, 需保留) =', missing.length ? missing : '无');

    await pool.end();
    process.exit(0);
  } catch (e) {
    console.error('ERR:', e.message);
    process.exit(1);
  }
})();
