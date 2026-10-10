/**
 * orchestrator.js — Matrix-Link 2026 系统编排启动器
 *
 * 职责：
 *   1. 确保 MySQL 进程存活（若未运行则启动）
 *   2. 确保数据库 / 表已创建（自动执行 schema.sql）
 *   3. 启动 Express 网关 server.js
 *   4. 输出完整的接入地址、Postback URL、健康检查端点
 *   5. 优雅退出（SIGINT/SIGTERM 清理所有子进程）
 *
 * 用法：
 *   node orchestrator.js
 *   MYSQL_HOST=127.0.0.1 MYSQL_PORT=3307 PORT=3000 node orchestrator.js
 */

const { spawn, execSync } = require('child_process');
const { existsSync, readFileSync } = require('fs');
const path = require('path');
const net = require('net');

// ── 配置 ─────────────────────────────────────────────────
const ROOT = __dirname;

const CFG = {
  mysql: {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: parseInt(process.env.MYSQL_PORT || '3307', 10),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DB || 'affiliate_system',
    dataDir: process.env.MYSQL_DATA_DIR || path.join(ROOT, 'mysql-data'),
    baseDir: process.env.MYSQL_BASE_DIR || path.join(ROOT, 'mysql-8.0.41-winx64'),
  },
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
    script: path.join(ROOT, 'server.js'),
  },
  nginx: {
    enabled: process.env.NGINX_ENABLED !== '0',
    baseDir: path.join(ROOT, 'nginx-runtime', 'nginx-1.26.2'),
  },
  checks: {
    interval: 30000,  // MySQL 健康检查间隔 (ms)
  },
};

// ── 工具 ─────────────────────────────────────────────────
const log = (tag, msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] [${tag}] ${msg}`);

function checkPort(port) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(2000);
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
    sock.connect(port, '127.0.0.1');
  });
}

async function waitForPort(port, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await checkPort(port)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

// ══════════════════════════════════════════════════════════
//  1. MySQL 生命周期管理
// ══════════════════════════════════════════════════════════

let mysqlProcess = null;

async function ensureMySQL() {
  const mysqlRunning = await checkPort(CFG.mysql.port);

  if (mysqlRunning) {
    log('mysql', `already running on :${CFG.mysql.port}`);
    return true;
  }

  // 尝试启动本地 MySQL
  const mysqldPath = path.join(CFG.mysql.baseDir, 'bin', 'mysqld.exe');
  const mysqldExe = existsSync(mysqldPath) ? mysqldPath : 'mysqld';

  if (!existsSync(CFG.mysql.dataDir)) {
    log('mysql', 'data dir missing, cannot auto-start. Please start MySQL manually.');
    log('mysql', `Expected: ${mysqldPath}`);
    return false;
  }

  log('mysql', `starting on :${CFG.mysql.port}...`);

  mysqlProcess = spawn(mysqldExe, [
    `--datadir=${CFG.mysql.dataDir}`,
    `--basedir=${CFG.mysql.baseDir}`,
    `--port=${CFG.mysql.port}`,
  ], {
    detached: true,
    stdio: 'ignore',
  });

  mysqlProcess.unref();

  const ready = await waitForPort(CFG.mysql.port, 30000);
  if (ready) {
    log('mysql', `ready on :${CFG.mysql.port}`);
    return true;
  }

  log('mysql', 'FAILED to start within 30s');
  return false;
}

// ══════════════════════════════════════════════════════════
//  2. 数据库 Schema 初始化
// ══════════════════════════════════════════════════════════

async function ensureSchema() {
  const schemaPath = path.join(ROOT, 'schema.sql');
  if (!existsSync(schemaPath)) {
    log('schema', 'schema.sql not found, skipping auto-init');
    return true;
  }

  const mysqlBin = path.join(CFG.mysql.baseDir, 'bin', 'mysql.exe');
  const mysqlExe = existsSync(mysqlBin) ? mysqlBin : 'mysql';

  const schema = readFileSync(schemaPath, 'utf-8');
  // 替换数据库名称以匹配配置
  const adapted = schema.replace(/affiliate_system/g, CFG.mysql.database);

  const tmpFile = path.join(ROOT, '.schema-tmp.sql');
  require('fs').writeFileSync(tmpFile, adapted, 'utf-8');

  try {
    execSync(
      `"${mysqlExe}" -u ${CFG.mysql.user} -P ${CFG.mysql.port} --protocol=tcp < "${tmpFile}"`,
      { stdio: 'pipe', timeout: 15000 }
    );
    log('schema', `database "${CFG.mysql.database}" initialized`);
  } catch (err) {
    log('schema', `init failed (may already exist): ${err.message.slice(0, 100)}`);
  }

  try { require('fs').unlinkSync(tmpFile); } catch {}
  return true;
}

// ══════════════════════════════════════════════════════════
//  3. Express 网关启动
// ══════════════════════════════════════════════════════════

let serverProcess = null;

function startServer() {
  return new Promise((resolve, reject) => {
    if (!existsSync(CFG.server.script)) {
      return reject(new Error(`server.js not found: ${CFG.server.script}`));
    }

    serverProcess = spawn('node', [CFG.server.script], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(CFG.server.port),
        MYSQL_HOST: CFG.mysql.host,
        MYSQL_PORT: String(CFG.mysql.port),
        MYSQL_USER: CFG.mysql.user,
        MYSQL_PASSWORD: CFG.mysql.password,
        MYSQL_DB: CFG.mysql.database,
      },
      stdio: 'pipe',
    });

    let started = false;

    serverProcess.stdout.on('data', (d) => {
      const msg = d.toString();
      process.stdout.write(`[server] ${msg}`);
      if (msg.includes('listening') && !started) {
        started = true;
        resolve(true);
      }
    });

    serverProcess.stderr.on('data', (d) => {
      process.stderr.write(`[server:err] ${d}`);
    });

    serverProcess.on('error', reject);
    serverProcess.on('exit', (code) => {
      if (!started) reject(new Error(`server exited with code ${code}`));
    });

    // 超时回退
    setTimeout(() => {
      if (!started) {
        started = true;
        log('server', 'no "listening" message, assuming started');
        resolve(true);
      }
    }, 5000);
  });
}

// ══════════════════════════════════════════════════════════
//  4. 优雅退出
// ══════════════════════════════════════════════════════════

function setupGracefulShutdown() {
  const cleanup = () => {
    log('orch', 'shutting down...');
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      setTimeout(() => { try { serverProcess.kill('SIGKILL'); } catch {} }, 5000);
    }
    if (mysqlProcess) {
      try { process.kill(-mysqlProcess.pid, 'SIGTERM'); } catch {}
    }
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('uncaughtException', (err) => {
    console.error('[orch] uncaught:', err.message);
    cleanup();
  });
}

// ══════════════════════════════════════════════════════════
//  5. 主流程
// ══════════════════════════════════════════════════════════

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  Matrix-Link 2026 — System Orchestrator     ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  setupGracefulShutdown();

  // Step 1: MySQL
  log('orch', 'Step 1/3 — Ensuring MySQL...');
  const mysqlOk = await ensureMySQL();
  if (!mysqlOk) {
    log('orch', 'MySQL not available — starting server anyway (will work if MySQL becomes available)');
  }

  // Step 2: Schema
  log('orch', 'Step 2/3 — Ensuring schema...');
  await ensureSchema();

  // Step 3: Express
  log('orch', 'Step 3/3 — Starting Express gateway...');
  await startServer();

  // ── 输出接入信息 ──────────────────────────────────────
  const serverHost = `http://localhost:${CFG.server.port}`;
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  Matrix-Link 2026 — Running                 ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  Gateway:        ${serverHost}/gateway`);
  console.log(`║  Route (DD.txt): ${serverHost}/route`);
  console.log(`║  Postback (POST):${serverHost}/api/v1/postback`);
  console.log(`║  Postback (GET): ${serverHost}/api/v1/postback?sub1=BOT&sub2=CLICK&payout=1.00`);
  console.log(`║  Health:         ${serverHost}/health`);
  console.log(`║  MySQL:          ${CFG.mysql.host}:${CFG.mysql.port}/${CFG.mysql.database}`);
  console.log('╚══════════════════════════════════════════════╝\n');

  // ── 周期性健康检查 ──────────────────────────────────────
  setInterval(async () => {
    const dbOk = await checkPort(CFG.mysql.port);
    const srvOk = await checkPort(CFG.server.port);
    if (!dbOk) log('health', '⚠ MySQL port not responding');
    if (!srvOk) log('health', '⚠ Server port not responding');
  }, CFG.checks.interval);
}

main().catch((err) => {
  console.error('[orch] FATAL:', err.message);
  process.exit(1);
});
