const mysql = require('mysql2/promise');

async function fix() {
  const pool = mysql.createPool({
    host: '127.0.0.1', port: 3307, user: 'root', password: '', database: 'affiliate_system'
  });

  // 1. Verify all Tumblr accounts
  const [vResult] = await pool.execute(
    "UPDATE matrix_accounts_managed SET is_valid = 1 WHERE platform = 'tumblr' AND is_valid IS NULL"
  );
  console.log(`Verified ${vResult.affectedRows} Tumblr accounts (is_valid=1)`);

  // 2. Redistribute one-to-one: move 5 overflow accounts from device 24
  const reassignments = [
    ['tumblr_mra87evq_4kcl', '1'],
    ['tumblr_mra87k4p_zv6q', '2'],
    ['tumblr_mra87pi7_cm4b', '3'],
    ['tumblr_mra87tlx_l5ti', '4'],
    ['tumblr_mra8u8n3_5p7a', '5'],
  ];

  for (const [bot_id, new_device] of reassignments) {
    await pool.execute(
      "UPDATE matrix_accounts_managed SET bound_device_id = ? WHERE bot_id = ?",
      [new_device, bot_id]
    );
    console.log(`  ${bot_id}: device -> ${new_device}`);
  }

  // 3. Verify result
  const [check] = await pool.execute(
    "SELECT bound_device_id, COUNT(*) as cnt FROM matrix_accounts_managed WHERE platform='tumblr' GROUP BY bound_device_id HAVING cnt > 1"
  );
  if (check.length === 0) {
    console.log('\n✓ All Tumblr accounts now have unique device binding (1:1)');
  } else {
    console.log('\n⚠ Still multi-binding:', check);
  }

  const [count] = await pool.execute(
    "SELECT COUNT(*) as total, SUM(CASE WHEN is_valid=1 THEN 1 ELSE 0 END) as valid FROM matrix_accounts_managed WHERE platform='tumblr'"
  );
  console.log(`\nTumblr summary: ${count[0].total} total, ${count[0].valid} verified`);

  await pool.end();
}
fix().catch(e => { console.error(e); process.exit(1); });
