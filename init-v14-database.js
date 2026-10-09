/**
 * init-v14-database.js — 初始化 v14 数据库表结构
 * 
 * 检查并创建必要的数据库表，用于因果链自动触发
 */

const mysql = require('mysql2/promise');

async  initDatabase() {
  let connection;
  
  try {
    // 创建数据库连接
    connection = await mysql.createConnection({
      host: '',
      port: 3307,
      user: 'root',
      : '',
      database: 'affiliate_system'
    });
    
    console.log('✅ Connected to MySQL database');
    
    // 1. 检查并添加 matrix__managed 表的字段
    console.log('\n[1/5] Checking matrix__managed table...');
    const [Columns] = await connection.query(`
      SELECT COLUMN_NAME 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = 'affiliate_system' 
      AND TABLE_NAME = 'matrix__managed'
    `);
    
    const accountColumnNames = Columns.map(c => c.COLUMN_NAME);
    console.log(`  Existing columns: ${accountColumnNames.join(', ')}`);
    
    // 添加缺少的字段
    const requiredAccountFields = [
      { name: '', definition: 'INT DEFAULT 0' },
      { name: '', definition: 'INT DEFAULT 0' },
      { name: '', definition: 'INT DEFAULT 0' },
      { name: '', definition: 'VARCHAR(255) DEFAULT NULL' }
    ];
    
    for (const field of requiredAccountFields) {
      if (!accountColumnNames.includes(field.name)) {
        console.log(`  Adding column: ${field.name}`);
        await connection.query(`
          ALTER TABLE matrix__managed 
          ADD COLUMN ${field.name} ${field.definition}
        `);
      } else {
        console.log(`  ✅ Column already exists: ${field.name}`);
      }
    }
    
    // 2. 检查并创建 matrix_content_generated 表
    console.log('\n[2/5] Checking matrix_content_generated table...');
    const [contentTables] = await connection.query(`
      SELECT TABLE_NAME 
      FROM INFORMATION_SCHEMA.TABLES 
      WHERE TABLE_SCHEMA = 'affiliate_system' 
      AND TABLE_NAME = 'matrix_content_generated'
    `);
    
    if (contentTables.length === 0) {
      console.log('  Creating matrix_content_generated table...');
      await connection.query(`
        CREATE TABLE IF NOT EXISTS matrix_content_generated (
          id VARCHAR(255) PRIMARY KEY,
          account_id VARCHAR(255),
           VARCHAR(50),
          type VARCHAR(50),
          title VARCHAR(500),
          body TEXT,
          quality_score INT DEFAULT 0,
          status VARCHAR(50) DEFAULT 'pending',
          used_count INT DEFAULT 0,
          emitted_at DATETIME DEFAULT NULL,
           DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_status (status),
          INDEX idx_emitted (emitted_at)
        )
      `);
      console.log('  ✅ Table created');
    } else {
      console.log('  ✅ Table already exists');
      
      // 检查并添加 emitted_at 字段
      const [contentColumns] = await connection.query(`
        SELECT COLUMN_NAME 
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = 'affiliate_system' 
        AND TABLE_NAME = 'matrix_content_generated'
      `);
      const contentColumnNames = contentColumns.map(c => c.COLUMN_NAME);
      
      if (!contentColumnNames.includes('emitted_at')) {
        console.log('  Adding column: emitted_at');
        await connection.query(`
          ALTER TABLE matrix_content_generated 
          ADD COLUMN emitted_at DATETIME DEFAULT NULL
        `);
      }
    }
    
    // 3. 检查并创建 matrix_posts_published 表
    console.log('\n[3/5] Checking matrix_posts_published table...');
    const [postsTables] = await connection.query(`
      SELECT TABLE_NAME 
      FROM INFORMATION_SCHEMA.TABLES 
      WHERE TABLE_SCHEMA = 'affiliate_system' 
      AND TABLE_NAME = 'matrix_posts_published'
    `);
    
    if (postsTables.length === 0) {
      console.log('  Creating matrix_posts_published table...');
      await connection.query(`
        CREATE TABLE IF NOT EXISTS matrix_posts_published (
          id VARCHAR(255) PRIMARY KEY,
          account_id VARCHAR(255),
          content_id VARCHAR(255),
           VARCHAR(50),
          status VARCHAR(50) DEFAULT 'pending',
          published_at DATETIME DEFAULT NULL,
          reach INT DEFAULT 0,
          likes INT DEFAULT 0,
          comments INT DEFAULT 0,
          shares INT DEFAULT 0,
          emitted_at DATETIME DEFAULT NULL,
           DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_status (status),
          INDEX idx_emitted (emitted_at)
        )
      `);
      console.log('  ✅ Table created');
    } else {
      console.log('  ✅ Table already exists');
    }
    
    // 4. 检查并创建 matrix_visits_recorded 表
    console.log('\n[4/5] Checking matrix_visits_recorded table...');
    const [visitsTables] = await connection.query(`
      SELECT TABLE_NAME 
      FROM INFORMATION_SCHEMA.TABLES 
      WHERE TABLE_SCHEMA = 'affiliate_system' 
      AND TABLE_NAME = 'matrix_visits_recorded'
    `);
    
    if (visitsTables.length === 0) {
      console.log('  Creating matrix_visits_recorded table...');
      await connection.query(`
        CREATE TABLE IF NOT EXISTS matrix_visits_recorded (
          id VARCHAR(255) PRIMARY KEY,
          post_id VARCHAR(255),
          account_id VARCHAR(255),
          visitor_type VARCHAR(50),
          ip VARCHAR(50),
          ua TEXT,
          referrer TEXT,
          landing_page VARCHAR(500),
          duration INT DEFAULT 0,
          is_unique BOOLEAN DEFAULT FALSE,
          recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          emitted_at DATETIME DEFAULT NULL,
          INDEX idx_emitted (emitted_at)
        )
      `);
      console.log('  ✅ Table created');
    } else {
      console.log('  ✅ Table already exists');
    }
    
    // 5. 检查并创建 matrix_ 表
    console.log('\n[5/5] Checking matrix_ table...');
    const [dauTables] = await connection.query(`
      SELECT TABLE_NAME 
      FROM INFORMATION_SCHEMA.TABLES 
      WHERE TABLE_SCHEMA = 'affiliate_system' 
      AND TABLE_NAME = 'matrix_'
    `);
    
    if (dauTables.length === 0) {
      console.log('  Creating matrix_ table...');
      await connection.query(`
        CREATE TABLE IF NOT EXISTS matrix_ (
          id INT PRIMARY KEY AUTO_INCREMENT,
          date DATE,
           VARCHAR(50),
          dau_count INT DEFAULT 0,
          new_users INT DEFAULT 0,
          returning_users INT DEFAULT 0,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          emitted_at DATETIME DEFAULT NULL,
          UNIQUE KEY idx_date_ (date, ),
          INDEX idx_emitted (emitted_at)
        )
      `);
      console.log('  ✅ Table created');
    } else {
      console.log('  ✅ Table already exists');
    }
    
    console.log('\n' + '='.repeat(60));
    console.log('✅ Database initialization completed successfully!');
    console.log('='.repeat(60));
    console.log('\nNext steps:');
    console.log('1. Start server.js');
    console.log('2. Register a test account');
    console.log('3. Check server logs for "[CHAIN]" messages');
    console.log('4. Verify that causal events are automatically triggered\n');
    
  } catch (err) {
    console.error('\n❌ Database initialization failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

// 运行初始化
if (require.main === module) {
  initDatabase()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('Fatal error:', err);
      process.exit(1);
    });
}

module.exports = { initDatabase };
