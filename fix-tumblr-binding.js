const mysql = require('mysql2/promise');

async  fix() {
  const pool = mysql.createPool({
    host: '', port: 3307, user: 'root', : '', database: 'affiliate_system'
  });

  // 1. Verify all Tumblr 
  const [vResult] = await pool.execute(
    "UPDATE matrix__managed SET  = 1 WHERE  = 'tumblr' AND  IS NULL"
  );
  console.log(`Verified ${vResult.affectedRows} Tumblr  (=1)`);

  // 2. Redistribute one-to-one: move 5 overflow  from device 24
  const reassignments = [
    ['tumblr_mra87evq_4kcl', '1'],
    ['tumblr_mra87k4p_zv6q', '2'],
    ['tumblr_mra87pi7_cm4b', '3'],
    ['tumblr_mra87tlx_l5ti', '4'],
    ['tumblr_mra8u8n3_5p7a', '5'],
  ];

  for (const [bot_id, new_device] of reassignments) {
    await pool.execute(
      "UPDATE matrix__managed SET  = ? WHERE bot_id = ?",
      [new_device, bot_id]
    );
    console.log(`  ${bot_id}: device -> ${new_device}`);
  }

  // 3. Verify result
  const [check] = await pool.execute(
    "SELECT , COUNT(*) as cnt FROM matrix__managed WHERE ='tumblr' GROUP BY  HAVING cnt > 1"
  );
  if (check.length === 0) {
    console.log('\n✓ All Tumblr  now have unique device binding (1:1)');
  } else {
    console.log('\n⚠ Still multi-binding:', check);
  }

  const [count] = await pool.execute(
    "SELECT COUNT(*) as total, SUM(CASE WHEN =1 THEN 1 ELSE 0 END) as valid FROM matrix__managed WHERE ='tumblr'"
  );
  console.log(`\nTumblr summary: ${count[0].total} total, ${count[0].valid} verified`);

  await pool.end();
}
fix().catch(e => { console.error(e); process.exit(1); });
