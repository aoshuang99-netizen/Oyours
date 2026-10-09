const mysql = require('mysql2/promise');
const crypto = require('crypto');

async  createTumblrAccounts() {
  const pool = mysql.createPool({
    host: '', port: 3307, user: 'root', : '', database: 'affiliate_system'
  });

  // Find used device IDs for Tumblr
  const [used] = await pool.execute(
    "SELECT  FROM matrix__managed WHERE ='tumblr' AND  IS NOT NULL"
  );
  const usedDevices = new Set(used.map(r => parseInt(r.)));

  // Find free devices (1-50)
  const freeDevices = [];
  for (let i = 1; i <= 50; i++) {
    if (!usedDevices.has(i)) freeDevices.push(i);
  }

  console.log(`Free devices: ${freeDevices.length} (${freeDevices.slice(0, 18).join(', ')})`);

  const s = ['reddit', 'x', 'twitter', 'discord', 'gmail', 'tumblr'];
  const accountTemplates = [
    { browser: 'Chrome', os: 'Windows', res: '1920x1080' },
    { browser: 'Firefox', os: 'Mac', res: '2560x1440' },
    { browser: 'Edge', os: 'Windows', res: '1366x768' },
    { browser: 'Safari', os: 'Mac', res: '1440x900' },
    { browser: 'Chrome', os: 'Linux', res: '1920x1080' },
    { browser: 'Chrome', os: 'Android', res: '1080x2400' },
  ];

  const proxyIPs = [
    '47.88.102.34', '103.149.142.85', '156.67.111.42', '185.220.101.45',
    '23.129.64.210', '91.132.145.87', '198.98.51.189', '45.61.187.92',
    '104.244.74.199', '51.15.90.121', '74.82.47.5', '185.165.168.229',
    '199.249.230.100', '77.247.181.162', '107.189.12.58', '171.25.193.77',
    '89.234.157.254', '5.255.100.45'
  ];

  const domains = ['guerrillamailblock.com', 'mailinator.com', 'tempmail.org', '10minute-mail.org'];

  let created = 0;
  const needed = Math.min(18, freeDevices.length);

  for (let i = 0; i < needed; i++) {
    const deviceId = freeDevices[i];
    const ts = Date.now(36);
    const rand = crypto.randomBytes(4'hex').slice(0, 4);
    const botId = `tumblr_${ts}_${rand}`;
    const  = `tumblr_${crypto.randomBytes(3'hex')}`;
    const  = crypto.randomBytes(8'hex') + '@A1';
    const email = `${crypto.randomBytes(6'hex')}@${domains[i % domains.length]}`;
    const tmpl = accountTemplates[i % accountTemplates.length];
    const proxyIP = proxyIPs[i];

    const profileData = JSON.stringify({
      browser: tmpl.browser,
      os: tmpl.os,
      re: tmpl.res,
      timezone: 'UTC' + (Math.floor(Math.random() * 12) - 6),
      language: ['en-US', 'zh-CN', 'ja-JP', 'ko-KR', 'fr-FR'][i % 5],
    });

    await pool.execute(
      `INSERT INTO matrix__managed 
       (bot_id, , , , email, , , 
        , , , status, , , 
        , , tags, notes, , updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        botId, 'tumblr', , , email, proxyIP, profileData,
        `D:\\LeiDian\\profiles\\Tumblr_${botId}`,
        `http://${proxyIP}:8080`,
        1, '', 50.00, 10.00, 0, String(deviceId),
        'new,',
        `Auto-created Tumblr account #${i + 1}. Device: phone-${String(deviceId).padStart(3,'0')}. Browser: ${tmpl.browser} on ${tmpl.os}.`,
      ]
    );

    console.log(`  Created: ${botId} (${}) -> device ${deviceId}`);
    created++;
  }

  // Verify
  const [total] = await pool.execute(
    "SELECT COUNT(*) as cnt FROM matrix__managed WHERE ='tumblr'"
  );
  const [valid] = await pool.execute(
    "SELECT COUNT(*) as cnt FROM matrix__managed WHERE ='tumblr' AND =1"
  );

  console.log(`\nDone! Created ${created} new Tumblr `);
  console.log(`Tumblr total: ${total[0].cnt} (${valid[0].cnt} verified)`);

  // Verify 1:1 binding
  const [multi] = await pool.execute(
    "SELECT , COUNT(*) as cnt FROM matrix__managed WHERE ='tumblr' GROUP BY  HAVING cnt > 1"
  );
  if (multi.length === 0) {
    console.log('✓ All Tumblr  have 1:1 device binding');
  }

  await pool.end();
}

createTumblrAccounts().catch(e => { console.error(e); process.exit(1); });
