/**
 * server.js — 多渠道音视频分发引擎 · Express 网关 + 转化回调
 *
 * 路由：
 *   GET  /gateway        — UA 检测，bot → 白页 / 真人 → 追踪跳转
 *   POST /api/v1/postback — 转化回调，MySQL 事务更新转化状态 & 账号权重
 */

// ── 提升 libuv 线程池上限（E 控制台负载降级根因修复）──────────────
// 默认 UV_THREADPOOL_SIZE=4。50 云手机并发 I/O（Playwright/Chromium、MySQL 连接、
// DataStore 异步落盘）下，express.static / res.sendFile 的 fs 操作会被饿死，
// 导致控制台 HTML 在因果链活跃负载下「连接建立但 30s 无响应头」，而纯内存 JSON API 仍 <12ms。
// 提升至 32，确保静态资源服务不被异步 I/O 阻塞。（须在首条 async fs 之前设置方生效）
if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = '32';

// ── DataStore 单写者声明：主服务是 content 等「属主独占模块」的唯一合法写入方 ──
// 【2026-09-12】DataStore 的写入白名单默认已收紧为「除属主独占模块(content)外全部可写」，
//   目的是挡住那些不经看门狗、配置缺失却持有同一 DATA_DIR 的 CLI 脚本（它们每 5s 回盘，
//   会把 prune 刚删的记录写回来）。主服务必须显式声明自己为属主，否则手动启动
//   （未经看门狗注入 env）时会连自己的内容库都写不进去。
if (!process.env.MSCMS_DATASTORE_WRITE_MODULES) process.env.MSCMS_DATASTORE_WRITE_MODULES = '*';

// ── 统一存储路径：所有运行时写入一律落 D 盘（C 盘已满，禁止新增 C 盘写入） ──
const { PATHS, ensureDirs, dataFile, logFile, miscFile } = require('./storage-paths.js');
ensureDirs();

// ── 代理自发现（沙箱/内网需经本地代理才能连外网 wss/https） ──────────
// 若本机有本地出口代理（如 v2rayN/xray 监听 10808）则在启动时自动注入
// HTTP_PROXY/HTTPS_PROXY，使 Nostr 中继 WebSocket（及需要代理的外呼）可出网。
// 无代理监听时为空操作，不影响原有行为；绝不伪造任何发布结果。
(function setupEgressProxy() {
  try {
    const fs = require('fs');
    const log = (m) => { try { fs.appendFileSync(logFile('proxy-detect.log'), new Date().toISOString() + ' ' + m + '\n'); } catch (_) {} };
    // 若已通过 TUMBLR_PROXY 显式指定发布代理，则不再全局注入 HTTP_PROXY/HTTPS_PROXY：
    // 否则 udici 的 ProxyAgent 会与全局代理叠加形成嵌套 CONNECT，在本环境表现为
    // 发布请求 fetch failed（实测：单独进程走 TUMBLR_PROXY 成功，服务内叠加后必失败）。
    if (process.env.MSCMS_EGRESS_PROXY === '0') {
      log('disabled by MSCMS_EGRESS_PROXY=0 (避免与 TUMBLR_PROXY 嵌套)');
      return;
    }
    log('start; env.HTTP_PROXY=' + (process.env.HTTP_PROXY || '(unset)'));
    const candidates = (process.env.MSCMS_PROXY_PORTS || '10808,1080,7890,8080')
      .split(',').map((s) => s.trim()).filter(Boolean);
    const net = require('net');
    const tryPort = (i) => {
      if (i >= candidates.length) { log('none reachable'); return; }
      const port = parseInt(candidates[i], 10);
      if (!port) return tryPort(i + 1);
      const s = net.connect({ host: '127.0.0.1', port, timeout: 800 });
      s.on('connect', () => {
        s.destroy();
        if (!process.env.HTTP_PROXY && !process.env.HTTPS_PROXY) {
          process.env.HTTP_PROXY = 'http://127.0.0.1:' + port;
          process.env.HTTPS_PROXY = 'http://127.0.0.1:' + port;
          process.env.NO_PROXY = 'localhost,127.0.0.1';
          log('SET HTTP_PROXY -> ' + process.env.HTTP_PROXY);
          console.log('[proxy] auto-set HTTP_PROXY -> ' + process.env.HTTP_PROXY);
        } else { log('already set: ' + process.env.HTTP_PROXY); }
      });
      s.on('error', (e) => { log('port ' + port + ' error ' + e.code); try { s.destroy(); } catch (_) {} tryPort(i + 1); });
      s.on('timeout', () => { log('port ' + port + ' timeout'); try { s.destroy(); } catch (_) {} tryPort(i + 1); });
    };
    tryPort(0);
  } catch (e) { try { require('fs').appendFileSync(logFile('proxy-detect.log'), 'FATAL ' + e.message + '\n'); } catch (_) {} }
})();

const express = require('express');
const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
// 账号管理模块安全原语：密码 AES-256-GCM 加解密 + 一键登录 HMAC 令牌
const { encryptPassword, decryptPassword, issueLoginLink, verifyLoginToken } = require('./account-crypto');

// ── MySQL 连接池 ─────────────────────────────────────────
const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: parseInt(process.env.MYSQL_PORT || '3307', 10),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DB || 'affiliate_system',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4',
});

// 等待 MySQL 就绪（启动时若未就绪则重试，避免注册/恢复 500）
async function waitForDb(retries = 15, delayMs = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query('SELECT 1');
      console.log(`[db] MySQL ready after ${i + 1} attempt(s)`);
      return true;
    } catch (err) {
      console.log(`[db] MySQL not ready (attempt ${i + 1}/${retries}): ${err.message}`);
      if (i < retries - 1) await new Promise(r => setTimeout(r, delayMs));
    }
  }
  console.error('[db] MySQL failed to become ready after max retries');
  return false;
}

// ── 常量 ─────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3002', 10);

// 独立站跳转基础 URL（按需修改）
const LANDING_BASE = process.env.LANDING_BASE || 'https://offers.example.com/checkout';

// 巡检爬虫 UA 关键词（小写匹配，DD.txt 对齐）
const BOT_PATTERNS = [
  'twitterbot',
  'redditbot',
  'instagram',          // Instagram 爬虫广泛匹配
  'tiktokbot',
  'googlebot',
  'facebookexternalhit',
  'linkedinbot',
  'slackbot',
  'discordbot',
  'whatsapp',
  'telegrambot',
];

// ── 静态合规白页（建筑/生活博客风格） ──────────────────
const WHITE_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Horizon Living — Architecture & Lifestyle</title>
<meta name="description" content="Horizon Living explores modern architecture, sustainable design, and mindful urban living.">
<meta name="robots" content="index,follow">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:Georgia,'Times New Roman',serif;color:#333;background:#faf9f6;line-height:1.8}
  .nav{display:flex;justify-content:space-between;align-items:center;padding:1.5rem 3rem;border-bottom:1px solid #e0dcd5}
  .nav .logo{font-size:1.4rem;font-weight:700;letter-spacing:0.15em;text-transform:uppercase}
  .nav ul{display:flex;gap:2rem;list-style:none}
  .nav a{text-decoration:none;color:#555;font-size:0.95rem;letter-spacing:0.05em}
  .hero{padding:6rem 3rem;text-align:center;max-width:780px;margin:0 auto}
  .hero h1{font-size:2.6rem;font-weight:400;margin-bottom:1.5rem;color:#2c2c2c}
  .hero p{font-size:1.15rem;color:#666}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:2rem;padding:3rem;max-width:1200px;margin:0 auto}
  .card{background:#fff;border:1px solid #e8e4dc;border-radius:6px;overflow:hidden;transition:box-shadow 0.2s}
  .card:hover{box-shadow:0 6px 24px rgba(0,0,0,0.07)}
  .card-img{height:200px;background:#e8e4dc;display:flex;align-items:center;justify-content:center;font-size:0.85rem;color:#999;text-transform:uppercase;letter-spacing:0.08em}
  .card-body{padding:1.5rem}
  .card-body h3{font-size:1.1rem;font-weight:400;margin-bottom:0.5rem;color:#2c2c2c}
  .card-body p{font-size:0.9rem;color:#777}
  .footer{padding:3rem;text-align:center;border-top:1px solid #e0dcd5;color:#aaa;font-size:0.85rem;margin-top:4rem}
  @media(max-width:768px){.grid{grid-template-columns:1fr;padding:1.5rem}.hero{padding:4rem 1.5rem}.hero h1{font-size:2rem}}
</style>
</head>
<body>
<nav class="nav">
  <div class="logo">Horizon Living</div>
  <ul>
    <li><a href="/">Home</a></li>
    <li><a href="/architecture">Architecture</a></li>
    <li><a href="/design">Design</a></li>
    <li><a href="/about">About</a></li>
  </ul>
</nav>
<section class="hero">
  <h1>Where Architecture Meets Everyday Life</h1>
  <p>Exploring the intersection of modern design, sustainable building practices, and the spaces we call home.</p>
</section>
<section class="grid">
  <div class="card">
    <div class="card-img">Modern Villa</div>
    <div class="card-body">
      <h3>The Rise of Biophilic Design</h3>
      <p>How architects are bringing nature indoors with living walls, natural light, and organic materials.</p>
    </div>
  </div>
  <div class="card">
    <div class="card-img">Urban Loft</div>
    <div class="card-body">
      <h3>Small Space, Big Ideas</h3>
      <p>Clever storage solutions and multi-functional furniture for compact urban living.</p>
    </div>
  </div>
  <div class="card">
    <div class="card-img">Coastal Retreat</div>
    <div class="card-body">
      <h3>Sustainable Materials Matter</h3>
      <p>From reclaimed wood to low-carbon concrete — the future of eco-conscious construction.</p>
    </div>
  </div>
</section>
<footer class="footer">
  <p>&copy; 2026 Horizon Living. All rights reserved. | Privacy Policy | Terms of Service</p>
</footer>
</body>
</html>`;

// ── 辅助函数 ─────────────────────────────────────────────

/**
 * 检测 User-Agent 是否为平台巡检爬虫
 */
function isBot(ua) {
  if (!ua) return false;
  const lower = ua.toLowerCase();
  return BOT_PATTERNS.some((pattern) => lower.includes(pattern));
}

// ── 本机敏感操作保护 ──────────────────────────────────────
// 互动中心会触发本地 Chrome 中的账号会话，因此绝不允许经 Cloudflare 隧道或外网代理调用。
// 只允许直接从本机回环地址访问；公开只读 API 不受影响。
function isLocalControlRequest(req) {
  const raw = String(req.socket?.remoteAddress || req.connection?.remoteAddress || '');
  const localAddress = raw === '127.0.0.1' || raw === '::1' || raw === '::ffff:127.0.0.1';
  // Cloudflare Tunnel 也可能从本机回环连接到 Express，因此必须同时检查 Host；
  // 公网域名即使 remoteAddress 是回环，也不能调用敏感互动路由。
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  const localHost = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  return localAddress && localHost;
}
function requireLocalControl(req, res, next) {
  if (!isLocalControlRequest(req)) {
    return res.status(403).json({ error: '此敏感操作仅允许在主机本机控制台执行' });
  }
  next();
}
function maskEmail(value) {
  const email = String(value || '');
  const at = email.indexOf('@');
  if (at < 1) return email ? '••••' : '';
  const name = email.slice(0, at);
  return name.slice(0, Math.min(2, name.length)) + '••••@' + email.slice(at + 1);
}
function maskPhone(value) {
  const phone = String(value || '');
  if (phone.length <= 4) return phone ? '••••' : '';
  return '••••' + phone.slice(-4);
}
function readJsonRecords(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (Array.isArray(raw)) return raw.filter(item => item && typeof item === 'object');
    if (raw && typeof raw === 'object') {
      return Object.entries(raw).map(([key, value]) => {
        if (value && typeof value === 'object' && !Array.isArray(value) && !value.id) {
          return Object.assign({ id: key }, value);
        }
        return value;
      }).filter(item => item && typeof item === 'object');
    }
  } catch (_) {}
  return [];
}

/**
 * 从请求中提取 UID / PID（支持 query、header、cookie）
 */
function extractTrackingParams(req) {
  const uid = req.query?.uid || req.query?.sub1 || req.headers['x-uid'] || 'unknown';
  const pid = req.query?.pid || req.query?.sub2 || req.headers['x-pid'] || 'unknown';
  return { uid, pid };
}

// ── Express 应用 ─────────────────────────────────────────
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 静态文件服务 — 控制台
// 2026-09-06：HTML 一律 no-cache —— 旧实例曾缓存带语法错误的中间版控制台页
//   （Uncaught SyntaxError line 6953 黑屏），浏览器启发式缓存导致更新不生效。
const _htmlNoCache = (req, res, next) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  next();
};
app.get('/console', _htmlNoCache, (req, res) => {
  res.sendFile(path.join(__dirname, 'console.html'));
});
app.get('/v14', _htmlNoCache, (req, res) => {
  res.sendFile(path.join(__dirname, 'v14-console.html'));
});

// ── 内容预览页面 ──
app.get('/preview/:contentId', (req, res) => {
  try {
    const { contentId } = req.params;
    // 从 DataStore 查找内容
    let content = null;
    const initDS = () => { try { return initV14()?.dataStore || require('./data-store.js')?.dataStore; } catch(e) { return null; } };
    const ds = initDS();
    if (ds && ds.data && ds.data.content) {
      content = ds.data.content.find(c => c.id === contentId);
    }
    if (!content) {
      return res.status(404).send(`<!doctype html><html><head><meta charset="utf-8"><title>404</title></head><body style="font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;background:#0d1117;color:#c9d1d9"><div style="text-align:center"><h1 style="font-size:4rem;margin:0">404</h1><p>内容未找到: ${contentId}</p><a href="/v14" style="color:#58a6ff">返回控制台</a></div></body></html>`);
    }

    const title = content.title || '未命名内容';
    const body = (content.body || '').replace(/\n/g, '<br>');
    const platform = content.platform || 'unknown';
    const qualityScore = content.quality_score || 0;
    const status = content.status || 'ready';
    const type = content.type || 'post';
    const usedCount = content.used_count || 0;
    const createdAt = content.created_at || content.timestamp || new Date().toISOString();

    res.send(`<!doctype html><html lang="zh">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — MSCMS v14 Preview</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d1117;color:#c9d1d9;min-height:100vh}
.topbar{background:#161b22;border-bottom:1px solid #30363d;padding:0.8rem 1.5rem;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.5rem}
.topbar h1{font-size:1.1rem;color:#58a6ff}
.tags{display:flex;gap:0.4rem;flex-wrap:wrap}
.tag{display:inline-block;padding:0.2rem 0.6rem;border-radius:1rem;font-size:0.7rem;font-weight:600}
.tag-platform{background:#1f6feb33;color:#58a6ff;border:1px solid #1f6feb66}
.tag-status{background:#23863633;color:#3fb950;border:1px solid #23863666}
.tag-type{background:#8957e533;color:#d2a8ff;border:1px solid #8957e566}
.tag-score{background:${qualityScore>=80?'#23863633':'#da363333'};color:${qualityScore>=80?'#3fb950':'#f85149'};border:1px solid ${qualityScore>=80?'#23863666':'#da363366'}}
.container{max-width:800px;margin:0 auto;padding:2rem 1rem}
.meta{display:flex;gap:1rem;font-size:0.75rem;color:#8b949e;margin-bottom:1.5rem;flex-wrap:wrap}
.meta-item{display:flex;gap:0.3rem;align-items:center}
.content-body{background:#161b22;border:1px solid #30363d;border-radius:0.5rem;padding:1.5rem;font-size:0.95rem;line-height:1.7;white-space:pre-wrap;word-wrap:break-word}
.content-body img{max-width:100%;border-radius:0.3rem}
.footer{padding:1.5rem 1rem;text-align:center;font-size:0.7rem;color:#484f58;border-top:1px solid #30363d;margin-top:2rem}
.footer a{color:#58a6ff;text-decoration:none}
</style></head>
<body>
<div class="topbar">
<h1>📄 ${title}</h1>
<div class="tags">
<span class="tag tag-platform">${platform}</span><span class="tag tag-type">${type}</span>
<span class="tag tag-status">${status}</span><span class="tag tag-score">质量: ${qualityScore}</span>
</div>
</div>
<div class="container">
<div class="meta">
<div class="meta-item">🕐 ${new Date(createdAt).toLocaleString('zh-CN')}</div>
<div class="meta-item">📊 使用: ${usedCount} 次</div>
<div class="meta-item">🆔 ${contentId}</div>
</div>
<div class="content-body">${body}</div>
</div>
<div class="footer">
<p>MSCMS v14 Content Preview | <a href="/v14">返回控制台</a></p>
</div></body></html>`);
  } catch (e) {
    res.status(500).send(`Preview error: ${e.message}`);
  }
});
// HTML 直接访问（如 /v14-console.html）同样 no-cache，防旧版缓存黑屏
app.use((req, res, next) => {
  if (typeof req.path === 'string' && req.path.endsWith('.html')) {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
  next();
});
app.use(express.static(__dirname));
app.use('/content', express.static('D:/MSCMS-Content'));

// 【B2】全局 favicon —— 历史遗留页面均未声明 <link rel="icon">，浏览器每次都会请求
// /favicon.ico 并得到 404，造成控制台噪音与「未完成品」观感（实测页面验收唯一失分项）。
// 这里统一返回内联 SVG，无需为每个页面各写一遍，也不再产生 404。
app.get('/favicon.ico', (req, res) => {
  res.set('Content-Type', 'image/svg+xml; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
    + '<circle cx="16" cy="16" r="13" fill="none" stroke="#2563eb" stroke-width="4"/>'
    + '<circle cx="16" cy="16" r="4" fill="#2563eb"/></svg>');
});

// CORS — 允许 file:// 控制台访问
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── 路由：智能 Cloaking 网关 ────────────────────────────

/**
 * Cloaking 核心处理函数（/gateway 和 /route 共用）
 * 检测 User-Agent：
 *   - 爬虫 → 返回静态合规白页 (200 HTML)
 *   - 真实用户 → 计数 +1，302 跳转到独立站（带 sub1/sub2 追踪参数）
 */
async function handleCloaking(req, res) {
  try {
    const ua = req.headers['user-agent'] || '';

    if (isBot(ua)) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(WHITE_PAGE);
    }

    // 真实用户：提取追踪参数
    const { uid, pid } = extractTrackingParams(req);

    // ★ 计入点击数（DD.txt 要求）
    if (uid && uid !== 'unknown') {
      await pool.execute(
        'UPDATE traffic_accounts SET total_clicks = total_clicks + 1 WHERE bot_id = ?',
        [uid]
      ).catch(() => {}); // 静默失败，不影响跳转
    }

    // 构建联盟跳转链接
    const redirectUrl = `${LANDING_BASE}?sub1=${encodeURIComponent(uid)}&sub2=${encodeURIComponent(pid)}`;

    res.redirect(302, redirectUrl);
  } catch (err) {
    console.error('[cloaking] error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// /gateway — 主路由
app.get('/gateway', handleCloaking);

// /route — DD.txt 兼容别名
app.get('/route', handleCloaking);

// ── 路由：转化回调 ───────────────────────────────────────

/**
 * POST /api/v1/postback   (JSON body — 主接口)
 * GET  /api/v1/postback   (Query params — DD.txt 兼容)
 *
 * 参数：
 *   click_id / sub2  — 点击唯一标识
 *   bot_id   / sub1  — 群控账号 ID
 *   payout           — 佣金金额
 *
 * 事务操作：
 *   1. is_converted = 1, payout 更新, converted_at = NOW()
 *   2. total_conversions += 1
 *   3. weight = MIN(weight + 30, 500)   （DD.txt：上限 500）
 *   4. status IN ('warming','shadowbanned') → 'active' （自动复活）
 */
async function handlePostback(req, res) {
  // 支持 POST JSON 和 GET query
  const params = req.method === 'GET' ? req.query : (req.body || {});
  const clickId = params.click_id || params.sub2;
  const explicitBotId = params.bot_id || params.sub1;
  const payout = parseFloat(params.payout) || 0;

  if (!clickId) {
    return res.status(400).json({ error: 'missing click_id' });
  }

  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    // 1) 更新转化记录
    const [convResult] = await conn.execute(
      `UPDATE traffic_conversions
         SET is_converted = 1,
             payout = ?,
             converted_at = NOW()
       WHERE click_id = ?`,
      [payout, clickId]
    );

    if (convResult.affectedRows === 0) {
      await conn.rollback();
      conn.release();
      return res.status(404).json({ error: 'click_id not found' });
    }

    // 确定 bot_id：优先显式传入，否则从 DB 反查
    let botId = explicitBotId;
    if (!botId) {
      const [rows] = await conn.execute(
        'SELECT bot_id FROM traffic_conversions WHERE click_id = ?',
        [clickId]
      );
      botId = rows[0]?.bot_id;
    }

    if (!botId) {
      await conn.rollback();
      conn.release();
      return res.status(404).json({ error: 'bot_id not resolved' });
    }

    // 2) 逆向调优：total_conversions +1, weight+30(上限500), 自动复活
    //    DD.txt 公式：weight = MIN(weight + 30, 500)
    //    状态机：warming/shadowbanned → active
    await conn.execute(
      `UPDATE traffic_accounts
         SET total_conversions = total_conversions + 1,
             weight = LEAST(weight + 30, 500),
             status = IF(status IN ('warming', 'shadowbanned'), 'active', status),
             last_used_at = NOW()
       WHERE bot_id = ?`,
      [botId]
    );

    await conn.commit();
    conn.release();

    console.log(`[postback] ${clickId} → converted, bot=${botId}, payout=${payout}`);

    // DD.txt 兼容：GET 请求返回纯文本
    if (req.method === 'GET') return res.send('success');

    return res.json({
      success: true,
      click_id: clickId,
      bot_id: botId,
      payout,
    });
  } catch (err) {
    await conn.rollback();
    conn.release();
    console.error('[postback] transaction error:', err.message);
    return res.status(500).json({ error: 'transaction failed', detail: err.message });
  }
}

// POST — 主接口
app.post('/api/v1/postback', handlePostback);

// GET — DD.txt 兼容（联盟平台通常只支持 GET）
app.get('/api/v1/postback', handlePostback);

// ── 健康检查 ─────────────────────────────────────────────

app.get('/health', async (req, res) => {
  try {
    await pool.execute('SELECT 1');
    res.json({ status: 'ok', db: 'connected' });
  } catch {
    res.status(503).json({ status: 'degraded', db: 'disconnected' });
  }
});

// ── 管理 API：数据库查询（前端控制台用） ─────────────────

// 账号列表
app.get('/api/v1/accounts', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT id, bot_id, platform, proxy_server, bound_country, status, weight, total_clicks, total_conversions, last_used_at, created_at FROM traffic_accounts ORDER BY id DESC LIMIT 50'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 创建测试账号
app.post('/api/v1/accounts', async (req, res) => {
  try {
    const { bot_id, platform, proxy_server, bound_country } = req.body || {};
    if (!bot_id || !platform || !proxy_server) {
      return res.status(400).json({ error: 'bot_id, platform, proxy_server required' });
    }
    await pool.execute(
      'INSERT INTO traffic_accounts (bot_id, platform, proxy_server, bound_country) VALUES (?,?,?,?)',
      [bot_id, platform, proxy_server, bound_country || 'US']
    );
    res.json({ success: true, bot_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 转化列表
app.get('/api/v1/conversions', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT id, click_id, bot_id, post_id, platform, user_ip, is_converted, payout, clicked_at, converted_at FROM traffic_conversions ORDER BY id DESC LIMIT 100'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 创建测试转化
app.post('/api/v1/conversions', async (req, res) => {
  try {
    const { click_id, bot_id, post_id, platform, user_ip, user_agent } = req.body || {};
    if (!click_id || !bot_id || !post_id || !platform) {
      return res.status(400).json({ error: 'click_id, bot_id, post_id, platform required' });
    }
    await pool.execute(
      'INSERT INTO traffic_conversions (click_id, bot_id, post_id, platform, user_ip, user_agent) VALUES (?,?,?,?,?,?)',
      [click_id, bot_id, post_id, platform, user_ip || '127.0.0.1', user_agent || 'Mozilla/5.0 Test']
    );
    res.json({ success: true, click_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 系统概览统计
app.get('/api/v1/stats', async (req, res) => {
  try {
    const [[accts]] = await pool.execute('SELECT COUNT(*) as total, SUM(CASE WHEN status="active" THEN 1 ELSE 0 END) as active, SUM(CASE WHEN status="shadowbanned" THEN 1 ELSE 0 END) as shadowbanned, SUM(CASE WHEN status="warming" THEN 1 ELSE 0 END) as warming, SUM(CASE WHEN status="dead" THEN 1 ELSE 0 END) as dead FROM traffic_accounts');
    const [[convs]] = await pool.execute('SELECT COUNT(*) as total, SUM(CASE WHEN is_converted=1 THEN 1 ELSE 0 END) as converted, SUM(payout) as total_payout FROM traffic_conversions');
    res.json({ accounts: accts, conversions: convs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 注册队列管理 API ──────────────────────────────────────
// 内存中的注册任务队列
const regQueue = [];
let regRunning = false;

app.post('/api/v1/register', async (req, res) => {
  const { platform, count = 1, proxy } = req.body || {};
  if (!platform || !proxy) {
    return res.status(400).json({ error: 'platform and proxy required' });
  }

  const tasks = [];
  for (let i = 0; i < count; i++) {
    const taskId = `reg_${Date.now()}_${i}`;
    tasks.push({ id: taskId, platform, proxy, status: 'queued', createdAt: new Date().toISOString() });
  }

  regQueue.push(...tasks);
  res.json({ queued: tasks.length, tasks });

  // 触发后台处理
  if (!regRunning) processQueue();
});

app.get('/api/v1/register/status', (req, res) => {
  const recent = regQueue.slice(-50);
  const stats = {
    total: regQueue.length,
    queued: regQueue.filter(t => t.status === 'queued').length,
    running: regQueue.filter(t => t.status === 'running').length,
    done: regQueue.filter(t => t.status === 'done').length,
    failed: regQueue.filter(t => t.status === 'failed').length,
  };
  res.json({ stats, recent });
});

async function processQueue() {
  if (regRunning) return;
  regRunning = true;

  while (regQueue.some(t => t.status === 'queued')) {
    const task = regQueue.find(t => t.status === 'queued');
    if (!task) break;

    task.status = 'running';
    task.startedAt = new Date().toISOString();

    try {
      // 生成账号信息并通过 account-factory API 写入
      const botId = `${task.platform}_Agent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,6)}`;
      const username = `${task.platform.toLowerCase()}_${Math.random().toString(36).slice(2,8)}`;

      // 写入数据库
      await pool.execute(
        'INSERT INTO traffic_accounts (bot_id, platform, proxy_server, bound_country, status) VALUES (?,?,?,?,?)',
        [botId, task.platform, task.proxy, 'US', 'warming']
      );

      task.status = 'done';
      task.botId = botId;
      task.username = username;
      task.completedAt = new Date().toISOString();

      console.log(`[register] ${botId} → done (${task.platform})`);
    } catch (err) {
      task.status = 'failed';
      task.error = err.message;
      console.error(`[register] ${task.id} failed: ${err.message}`);
    }

    // 冷却：避免同 IP 频率过高
    await new Promise(r => setTimeout(r, 3000));
  }

  regRunning = false;
}

// ── 全自动注册 API（实时进度节点追踪） ──────────

const { registerOne: autoRegisterOne, registerOneWithRetry, preflightCheck } = require('./full-auto-register.js');
const autoRegTasks = new Map();

// SMS/CAPTCHA 配置
let SMS_CONFIG = {
  token: process.env.SMS_TOKEN || '',
  heroKey: process.env.HERO_SMS_API_KEY || '',
  captchaKey: process.env.CAPTCHA_API_KEY || '',
};
try {
  const smsPath = path.join('D:', 'LeiDian', 'config', 'register.json');
  if (fs.existsSync(smsPath)) {
    const cfg = JSON.parse(fs.readFileSync(smsPath, 'utf-8'));
    if (cfg.sms?.token && !SMS_CONFIG.token) SMS_CONFIG.token = cfg.sms.token;
    if (cfg.sms?.heroKey && !SMS_CONFIG.heroKey) SMS_CONFIG.heroKey = cfg.sms.heroKey;
    if (cfg.captcha?.apiKey && !SMS_CONFIG.captchaKey) SMS_CONFIG.captchaKey = cfg.captcha.apiKey;
  }
} catch {}

app.post('/api/v1/auto-register', async (req, res) => {
  let { platform = 'Reddit', count = 1, proxy = '' } = req.body || {};
  const taskId = `auto_${Date.now()}`;

  const task = {
    taskId, platform, count, proxy: proxy || '直连',
    status: 'running',
    nodes: [
      { name: '自检', status: 'pending' },
      { name: '准备', status: 'pending' },
      { name: '邮箱', status: 'pending' },
      { name: '接码', status: 'pending' },
      { name: '浏览器', status: 'pending' },
      { name: '注册', status: 'pending' },
      { name: '验证', status: 'pending' },
      { name: '保存', status: 'pending' },
    ],
  };
  autoRegTasks.set(taskId, task);
  res.json(task);

  // 配置环境
  process.env.HEADLESS = '1';
  process.env.SMS_TOKEN = SMS_CONFIG.token;
  process.env.HERO_SMS_API_KEY = SMS_CONFIG.heroKey;
  process.env.CAPTCHA_API_KEY = process.env.CAPTCHA_API_KEY || SMS_CONFIG.captchaKey || '';

  // 自动分配代理（如果请求未提供代理，且代理池有可用代理）
  if (!proxy && proxyPool.length > 0) {
    // 过滤掉示例代理
    const realProxies = proxyPool.filter(p => !p.includes('example.com') && !p.includes('placeholder'));
    if (realProxies.length > 0) {
      proxy = realProxies[_proxyIdx % realProxies.length];
      _proxyIdx++;
      task.proxy = proxy;
    }
  }

  function setNode(name, st) {
    const n = task.nodes.find(x => x.name === name);
    if (n) n.status = st;
  }

  // 后台异步执行
  (async () => {
    try {
      const orig = console.log;
      console.log = (...a) => {
        const s = a.join(' ');
        orig(...a);
        if (s.includes('自检')) setNode('自检', 'running');
        if (s.includes('总结:') || s.includes('代理:')) setNode('自检', 'done');
        if (s.includes('注册尝试') || s.includes('🚀')) setNode('准备', 'done');
        if (s.includes('[guerrilla]') || s.includes('[pool]')) setNode('邮箱', 'done');
        if (s.includes('SMS:')) setNode('接码', s.includes('not available') ? 'skipped' : 'done');
        if (s.includes('浏览器') || s.includes('context')) setNode('浏览器', 'done');
        if (s.includes('导航') || s.includes('填写') || s.includes('navigat')) setNode('注册', 'running');
        if (s.includes('成功') || s.includes('SUCCESS') || s.includes('注册成功')) setNode('注册', 'done');
        if (s.includes('验证') || s.includes('validat')) setNode('验证', 'running');
        if (s.includes('验证通过') || s.includes('verified')) setNode('验证', 'done');
        if (s.includes('验证失败') || s.includes('Verification failed')) setNode('验证', 'skipped');
        if (s.includes('已保存') || s.includes('Cookie') || s.includes('💾') || s.includes('入库')) setNode('保存', 'done');
      };

      const { registerOne, batchRegister } = require('./full-auto-register.js');

      // 注册前自检
      if (preflightCheck) {
        try { await preflightCheck(proxy); } catch {}
      }

      let result;
      if (count === 1) {
        // 单账号：使用重试模式
        result = registerOneWithRetry
          ? await registerOneWithRetry(platform, proxy, 3)
          : await registerOne(platform, proxy);
      } else {
        // 批量：batchRegister 内部已包含重试
        result = await batchRegister(platform, count, proxy);
      }

      console.log = orig;
      task.status = 'done';
      task.result = result;
      task.nodes.forEach(n => { if (n.status === 'pending') n.status = 'done'; });
    } catch (err) {
      task.status = 'failed';
      task.result = { error: err.message };
      task.nodes.forEach(n => { if (n.status === 'pending') n.status = 'skipped'; });
    }
  })();
});

app.get('/api/v1/auto-register/:taskId', (req, res) => {
  const task = autoRegTasks.get(req.params.taskId);
  if (!task) return res.status(404).json({ error: 'not found' });
  res.json(task);
});

// ══════════════════════════════════════════════════════════
//  v14 注册管线 API
// ══════════════════════════════════════════════════════════

const registerTasks = [];  // {id, platform, count, proxy, status, completed, failed, messages[], startTime}
let registerRunning = false;

app.post('/api/v14/register/start', async (req, res) => {
  try {
    const { platform = 'gmail', count = 1, proxy = 'auto' } = req.body || {};
    const taskId = 'reg_' + Date.now();
    const task = {
      id: taskId, platform, count, proxy,
      status: 'running', completed: 0, failed: 0,
      messages: [{ ts: new Date().toLocaleTimeString(), msg: `启动 ${count} 个 ${platform} 注册任务 [代理: ${proxy}]` }],
      startTime: Date.now()
    };
    registerTasks.unshift(task);
    if (registerTasks.length > 20) registerTasks.pop();
    registerRunning = true;
    
    // 后台异步执行注册
    (async () => {
      try {
        const { batchRegister, registerOne } = require('./full-auto-register.js');
        const proxyArg = proxy === 'auto' ? '' : proxy === 'none' ? '' : proxy;
        
        for (let i = 0; i < count; i++) {
          if (!registerRunning) {
            task.messages.push({ ts: new Date().toLocaleTimeString(), msg: '⏹ 用户手动停止' });
            task.status = 'stopped';
            return;
          }
          task.messages.push({ ts: new Date().toLocaleTimeString(), msg: `[${i+1}/${count}] 开始注册 ${platform}...` });
          try {
            const result = await registerOne(platform, proxyArg);
            task.completed++;
            const identity = result.username || result.email || 'OK';
            task.messages.push({ ts: new Date().toLocaleTimeString(), msg: `[${i+1}/${count}] ✅ 注册成功: ${identity}` });
            
            // 触发 S1→S3 因果链：注册成功 → 自动推进到设备绑定/养号
            try {
              const v14 = initV14();
              const eventData = {
                account_id: result.botId,
                bot_id: result.botId,
                platform,
                username: result.username || identity,
                email: result.email || null,
                password: result.password || null,
                phone: result.phone || null,
                registration_ip: result.registrationIP || null,
                proxy_used: proxyArg || null,
                verified: result.verified || result.success || false,
              };
              v14Modules.eventBus.emit('account.registered', eventData, 'register-pipeline');
              task.messages.push({ ts: new Date().toLocaleTimeString(), msg: `[${i+1}/${count}] 🔗 已触发 account.registered 事件，开始自动推进` });
              
              // 自动绑定设备并安装平台 App（异步，不阻塞注册）
              autoProvisionAccount(eventData).catch(err => {
                console.error('[register] autoProvision failed:', err.message);
              });
            } catch (evErr) {
              console.error('[register] emit event failed:', evErr.message);
            }
          } catch (err) {
            task.failed++;
            task.messages.push({ ts: new Date().toLocaleTimeString(), msg: `[${i+1}/${count}] ❌ 失败: ${err.message}` });
          }
          // 间隔3-8秒防频率限制
          if (i < count - 1) await new Promise(r => setTimeout(r, 3000 + Math.random() * 5000));
        }
        task.status = 'done';
        task.messages.push({ ts: new Date().toLocaleTimeString(), msg: `全部完成: ${task.completed}成功 ${task.failed}失败` });
      } catch (e) {
        task.status = 'error';
        task.messages.push({ ts: new Date().toLocaleTimeString(), msg: `管线错误: ${e.message}` });
      } finally {
        registerRunning = false;
      }
    })();
    
    res.json({ taskId, total: count, started: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/register/progress', (req, res) => {
  const active = registerTasks.find(t => t.status === 'running');
  if (!active) {
    const last = registerTasks[0];
    return res.json({ 
      completed: last?.completed || 0, total: last?.count || 0, 
      failed: last?.failed || 0, done: true, 
      messages: last?.messages?.slice(-3) || [],
      eta: '--'
    });
  }
  const total = active.count;
  const completed = active.completed + active.failed;
  const elapsed = (Date.now() - active.startTime) / 1000;
  const rate = completed > 0 ? elapsed / completed : 0;
  const remaining = total - completed;
  const etaSec = Math.round(rate * remaining);
  const eta = etaSec > 0 ? `${Math.floor(etaSec/60)}分${etaSec%60}秒` : '计算中...';
  
  res.json({ 
    completed, total, failed: active.failed, 
    done: false, messages: active.messages.slice(-5), eta
  });
});

app.get('/api/v14/register/stats', (req, res) => {
  const allDone = registerTasks.filter(t => t.status === 'done' || t.status === 'error' || t.status === 'stopped');
  const totalCompleted = allDone.reduce((s, t) => s + (t.completed || 0), 0);
  const totalFailed = allDone.reduce((s, t) => s + (t.failed || 0), 0);
  res.json({
    queue: registerRunning ? 1 : 0,
    completed: totalCompleted,
    failed: totalFailed,
    running: registerRunning ? 1 : 0,
    emailPool: 0,
  });
});

app.post('/api/v14/register/stop', (req, res) => {
  registerRunning = false;
  const active = registerTasks.find(t => t.status === 'running');
  if (active) {
    active.status = 'stopped';
    active.messages.push({ ts: new Date().toLocaleTimeString(), msg: '⏹ 用户手动停止' });
  }
  res.json({ stopped: true });
});

// 注册成功后自动推进：绑定设备 + 安装平台 App + 更新状态
// 待分配队列：当设备不可用时，账号进入此队列，设备上线后自动重试
const pendingProvisionQueue = [];
let provisionRetryTimer = null;

function startProvisionRetry() {
  if (provisionRetryTimer) return;
  provisionRetryTimer = setInterval(() => {
    if (pendingProvisionQueue.length === 0) {
      clearInterval(provisionRetryTimer);
      provisionRetryTimer = null;
      return;
    }
    const v14 = initV14();
    if (!v14 || !v14.deviceManager) return;
    const hasOnline = Array.from(v14.deviceManager.devices.values())
      .some(d => d.status === 'ready' || d.status === 'online');
    if (!hasOnline) return;
    // 有在线设备，重试队列中的所有账号
    const batch = pendingProvisionQueue.splice(0);
    console.log(`[provision] 重试待分配队列，${batch.length} 个账号`);
    batch.forEach(item => {
      autoProvisionAccount(item).catch(err => {
        console.error(`[provision] 重试失败 ${item.bot_id}: ${err.message}`);
      });
    });
  }, 15000); // 每15秒检查一次
}

async function autoProvisionAccount(accountData) {
  const v14 = initV14();
  if (!v14) {
    console.error('[provision] v14 not initialized');
    throw new Error('v14 not initialized');
  }
  
  const { deviceManager } = v14;
  if (!deviceManager) {
    console.error('[provision] deviceManager not available');
    throw new Error('deviceManager not available');
  }
  
  console.log(`[provision] Starting auto-provision for account ${accountData.bot_id} (platform: ${accountData.platform})`);
  // 注意：不调用 deviceManager.init()，因为它会重置所有设备为 offline
  // deviceManager 已在 initV14() 中初始化

  // 1. 查找 READY 状态的设备，或启动一台
  let device = null;
  const readyDevices = Array.from(deviceManager.devices.values())
    .filter(d => d.status === 'ready' || d.status === 'online');
  if (readyDevices.length > 0) {
    // 选择未绑定账号或同平台优先的设备
    const samePlatform = readyDevices.filter(d => d.metadata?.assignedPlatform === accountData.platform);
    device = samePlatform.length ? samePlatform[0] : readyDevices[0];
  } else {
    // 启动第一台离线设备
    const offline = Array.from(deviceManager.devices.values())
      .find(d => d.status === 'offline');
    if (offline) {
      console.log(`[provision] 没有在线设备，启动 ${offline.name}...`);
      const startResult = await deviceManager.startDevice(offline.id);
      if (startResult.success) device = offline;
    }
  }

  if (!device) {
    console.log('[provision] 暂无可用设备，账号进入待分配队列');
    // 加入待分配队列，设备上线后自动重试
    pendingProvisionQueue.push(accountData);
    startProvisionRetry();
    return { queued: true, queueLength: pendingProvisionQueue.length };
  }

  // 2. 绑定账号到设备
  device.metadata = device.metadata || {};
  device.metadata.assignedAccount = accountData.bot_id;
  device.metadata.assignedPlatform = accountData.platform;
  device.metadata.assignedAt = new Date().toISOString();

  try {
    await pool.execute(
      'UPDATE matrix_accounts_managed SET bound_device_id = ?, status = ? WHERE bot_id = ?',
      [device.id.toString(), 'S1_WARMING', accountData.bot_id]
    );
  } catch (dbErr) {
    console.log(`[provision] DB update skipped (MySQL unavailable): ${dbErr.message}`);
  }
  console.log(`[provision] 账号 ${accountData.bot_id} → 绑定设备 ${device.name}`);

  // 3. 在设备上安装/打开对应平台 App
  await deviceManager.installSocialApp(device, accountData.platform).catch(err => {
    console.error(`[provision] installSocialApp failed: ${err.message}`);
  });

  // 4. 通知养号引擎
  if (v14.nurturing && v14.nurturing.addAccount) {
    v14.nurturing.addAccount({ ...accountData, bound_device_id: device.id.toString() });
  }

  // 5. 发布设备已就绪事件
  v14.eventBus.emit('device.account.bound', {
    device_id: device.id.toString(),
    bot_id: accountData.bot_id,
    platform: accountData.platform,
  }, 'register-provision');

  // 6. 不再模拟 30s 养号达标；真实 nurturing 模块会在健康分达标后触发 account.healthy
  //    用户也可通过「下一步」手动推进
  console.log(`[provision] 账号 ${accountData.bot_id} 已绑定 ${device.name}，等待养号/内容/发布自动化`);

  return { bound: true, deviceId: device.id };
}

// D盘账号列表
app.get('/api/v1/local-accounts', async (req, res) => {
  try {
    const dir = path.join('D:', 'LeiDian', 'accounts');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    const accounts = files.map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')); }
      catch { return { file: f, error: 'parse failed' }; }
    });
    res.json(accounts);
  } catch (e) {
    res.json([]);
  }
});

// ── 代理池 API (v2 — ProxyManager 驱动) ──────────────────

let proxyManager = null;
let proxyPool = [];
let _proxyIdx = 0;

// 延迟加载 ProxyManager（避免循环依赖）
function getPM() {
  if (!proxyManager) {
    try {
      const { getProxyManager } = require('./proxy-manager.js');
      proxyManager = getProxyManager();
    } catch { proxyManager = null; }
  }
  return proxyManager;
}

// 初始化代理池（启动时）
(async () => {
  const pm = getPM();
  if (pm) {
    await pm.init();
    proxyPool = pm.proxies || [];
    console.log(`[server] ProxyManager loaded: ${proxyPool.length} proxies`);
  } else {
    // 降级：从文件读取
    try {
      const poolPath = path.join('D:', 'LeiDian', 'config', 'proxy-pool.json');
      if (fs.existsSync(poolPath)) {
        const pool = JSON.parse(fs.readFileSync(poolPath, 'utf-8'));
        proxyPool = (pool.proxies || []).filter(p => p && !p.includes('example.com'));
      }
    } catch {}
  }
})();

// 查看代理池
app.get('/api/v1/proxy-pool', async (req, res) => {
  const pm = getPM();
  if (pm) {
    const report = pm.getReport();
    return res.json({
      total: pm.proxies.length,
      tested: pm.tested.length,
      working: report.working,
      residential: report.residential,
      datacenter: report.datacenter,
      avgLatency: report.avgLatency,
      top5: report.top5,
      proxies: pm.proxies.map((p, i) => {
        const t = pm.tested.find(r => r.proxy === p);
        return {
          index: i, proxy: p.replace(/\/\/.*@/, '//***@'),
          raw: p,
          ok: t?.ok, type: t?.type, country: t?.country,
          latencyMs: t?.latencyMs, score: t?.score,
        };
      }),
    });
  }
  res.json({ total: proxyPool.length, proxies: proxyPool.map(p => ({ proxy: p })) });
});

// 获取下一个代理（轮询 + 优先住宅）
app.get('/api/v1/proxy/next', (req, res) => {
  const pm = getPM();
  if (pm && pm.proxies.length > 0) {
    const best = pm.getBestProxy();
    if (best) {
      _proxyIdx++;
      return res.json({
        proxy: best.proxy,
        type: best.type, country: best.country, score: best.score,
        note: `Best proxy (${best.type}, score=${best.score})`,
      });
    }
    const proxy = pm.getNextProxy(_proxyIdx++);
    return res.json({ proxy, note: 'round-robin fallback' });
  }

  // 降级
  if (proxyPool.length === 0) {
    return res.json({ proxy: '', note: 'no proxies configured, using direct' });
  }
  const proxy = proxyPool[_proxyIdx % proxyPool.length];
  _proxyIdx++;
  res.json({ proxy, index: _proxyIdx - 1, total: proxyPool.length });
});

// ➕ 手动添加代理
app.post('/api/v1/proxy-pool/add', async (req, res) => {
  try {
    const { proxy, provider, credentials } = req.body || {};
    const pm = getPM();
    if (!pm) return res.status(500).json({ error: 'ProxyManager not available' });

    let added;
    if (provider) {
      added = await pm.createFromProvider(provider, credentials || {});
    } else if (proxy) {
      added = await pm.addProxy(proxy);
    } else {
      return res.status(400).json({ error: 'proxy or provider required' });
    }
    proxyPool = pm.proxies;
    res.json({ success: true, added });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 🔄 从免费源刷新
app.post('/api/v1/proxy-pool/refresh', async (req, res) => {
  try {
    const { sources } = req.body || {};
    const pm = getPM();
    if (!pm) return res.status(500).json({ error: 'ProxyManager not available' });

    const count = await pm.fetchFromFreeSources(sources);
    proxyPool = pm.proxies;
    res.json({ success: true, total: count, message: `Fetched ${count} proxies from free sources` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 🧪 测试全部代理
app.post('/api/v1/proxy-pool/test-all', async (req, res) => {
  try {
    const pm = getPM();
    if (!pm) return res.status(500).json({ error: 'ProxyManager not available' });

    // 返回立即响应，后台执行
    res.json({ testing: true, total: pm.proxies.length, message: 'Testing started, check /api/v1/proxy-pool for results' });

    const report = await pm.testAll(10);
    proxyPool = pm.proxies;
    console.log(`[server] Proxy test done: ${report.working}/${report.total} working`);
  } catch (e) {
    console.error('[server] Proxy test error:', e.message);
  }
});

// 🗑️ 删除代理
app.delete('/api/v1/proxy-pool/:index', async (req, res) => {
  try {
    const idx = parseInt(req.params.index, 10);
    const pm = getPM();
    if (!pm) return res.status(500).json({ error: 'ProxyManager not available' });

    await pm.removeProxy(idx);
    proxyPool = pm.proxies;
    res.json({ success: true, remaining: pm.proxies.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 🧹 清除所有代理
app.post('/api/v1/proxy-pool/clear', async (req, res) => {
  try {
    const pm = getPM();
    if (!pm) return res.status(500).json({ error: 'ProxyManager not available' });
    await pm.clearAll();
    proxyPool = [];
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 📋 获取可用服务商列表
app.get('/api/v1/proxy-pool/providers', (req, res) => {
  try {
    const { PROVIDER_TEMPLATES, FREE_SOURCES } = require('./proxy-manager.js');
    res.json({
      providers: Object.entries(PROVIDER_TEMPLATES).map(([id, info]) => ({
        id, label: info.label, template: info.template, fields: info.fields,
      })),
      freeSources: FREE_SOURCES.map(s => ({ name: s.name, label: s.label })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 🌐 Cloudflare 美国节点代理创建 ────────────────────────

app.post('/api/v1/proxy-pool/create-us-node', async (req, res) => {
  try {
    const { mode = 'auto', port = 1080, domain } = req.body || {};
    const { ProxyCreator } = require('./proxy-creator.js');

    const creator = new ProxyCreator({
      mode, port: parseInt(port, 10), domain: domain || 'proxy.hlua.cc.cd',
    });

    // 异步创建（可能需要几秒）
    res.json({ creating: true, mode, port, message: 'Creating US proxy node...' });

    const result = await creator.create();

    // 更新内存中的代理池
    if (result?.url) {
      proxyPool = [...new Set([...proxyPool, result.url])];
      console.log(`[server] US proxy node created: ${result.url} (${result.method})`);
    }
  } catch (e) {
    console.error('[server] Proxy creation error:', e.message);
  }
});

// 获取 Cloudflare Tunnel 状态
app.get('/api/v1/proxy-pool/cf-status', async (req, res) => {
  try {
    const cfDir = path.join(process.env.USERPROFILE || 'C:/Users/AS', '.cloudflared');
    const configPath = path.join(cfDir, 'config.yml');
    let tunnelConfig = null;

    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      tunnelConfig = {
        exists: true,
        domains: [...raw.matchAll(/hostname:\s*(\S+)/g)].map(m => m[1]),
        ingressCount: (raw.match(/hostname:/g) || []).length,
      };
    }

    // 检查 SOCKS5 代理端口
    const net = require('net');
    const socksPort = 1080;
    let socksRunning = false;
    try {
      await new Promise((resolve, reject) => {
        const s = new net.Socket();
        s.setTimeout(2000);
        s.on('connect', () => { s.destroy(); socksRunning = true; resolve(); });
        s.on('error', () => { s.destroy(); resolve(); });
        s.on('timeout', () => { s.destroy(); resolve(); });
        s.connect(socksPort, '127.0.0.1');
      });
    } catch {}

    res.json({
      tunnel: tunnelConfig,
      socks5: { port: socksPort, running: socksRunning },
      proxyPoolSize: proxyPool.length,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 📱 移动设备模拟 API ──────────────────────────────────

app.get('/api/v1/mobile-devices', (req, res) => {
  try {
    const { getMobileEmulator } = require('./mobile-emulator.js');
    const emu = getMobileEmulator();
    const { platform } = req.query;

    const devices = emu.listDevices(platform || null);
    const stats = emu.getStats();
    const picked = platform === 'ios' ? emu.pickIOS() : platform === 'android' ? emu.pickAndroid() : emu.pickDevice();

    res.json({
      stats,
      deviceCount: devices.length,
      sample: picked,
      devices: devices.map(d => ({
        id: d.id, name: d.name, brand: d.brand, os: d.os,
        viewport: d.viewport, ua_preview: d.userAgent.slice(0, 80) + '...',
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 账号管理 API（托管已注册账号的完整凭据） ──────────────

// 初始化因果链所需的4张表
async function initCausalChainTables() {
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS matrix_content_generated (
        id INT AUTO_INCREMENT PRIMARY KEY,
        account_id VARCHAR(80) NOT NULL,
        platform VARCHAR(30) NOT NULL,
        type VARCHAR(30) DEFAULT 'post',
        title VARCHAR(500) DEFAULT NULL,
        body TEXT DEFAULT NULL,
        status VARCHAR(30) DEFAULT 'ready',
        quality_score DECIMAL(5,2) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        emitted_at TIMESTAMP NULL DEFAULT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS matrix_posts_published (
        id INT AUTO_INCREMENT PRIMARY KEY,
        account_id VARCHAR(80) NOT NULL,
        content_id INT DEFAULT NULL,
        platform VARCHAR(30) NOT NULL,
        post_url VARCHAR(1000) DEFAULT NULL,
        status VARCHAR(30) DEFAULT 'published',
        published_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        emitted_at TIMESTAMP NULL DEFAULT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS matrix_visits_recorded (
        id INT AUTO_INCREMENT PRIMARY KEY,
        post_id INT DEFAULT NULL,
        account_id VARCHAR(80) DEFAULT NULL,
        visitor_type VARCHAR(30) DEFAULT 'organic',
        ip VARCHAR(45) DEFAULT NULL,
        ua VARCHAR(500) DEFAULT NULL,
        referrer VARCHAR(500) DEFAULT NULL,
        landing_page VARCHAR(500) DEFAULT NULL,
        duration INT DEFAULT 0,
        is_unique TINYINT(1) DEFAULT 0,
        source VARCHAR(50) DEFAULT NULL,
        recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        emitted_at TIMESTAMP NULL DEFAULT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS matrix_dau_stats (
        id INT AUTO_INCREMENT PRIMARY KEY,
        date DATE NOT NULL,
        platform VARCHAR(30) DEFAULT 'all',
        dau_count INT DEFAULT 0,
        total_visits INT DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        emitted_at TIMESTAMP NULL DEFAULT NULL,
        UNIQUE KEY uniq_date_platform (date, platform)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('[v14] Causal chain tables ready (matrix_content_generated, matrix_posts_published, matrix_visits_recorded, matrix_dau_stats)');
    
    // 迁移：新增 content_title 列到 matrix_posts_published
    try {
      await pool.execute(`ALTER TABLE matrix_posts_published ADD COLUMN content_title VARCHAR(500) DEFAULT NULL AFTER content_id`);
      console.log('[v14] Migrated: matrix_posts_published.content_title added');
    } catch(e) { /* 列已存在 */ }

    // 迁移：新增 content_account_id 列（闭环反规范化，使发布记录自包含可验证 content.account_id==publish.account_id）
    try {
      await pool.execute(`ALTER TABLE matrix_posts_published ADD COLUMN content_account_id VARCHAR(255) DEFAULT NULL AFTER content_id`);
      console.log('[v14] Migrated: matrix_posts_published.content_account_id added');
    } catch(e) { /* 列已存在 */ }

    // Phase C 迁移：新增 content_type 和 preview_url 到 matrix_content_generated
    try {
      await pool.execute(`ALTER TABLE matrix_content_generated ADD COLUMN content_type VARCHAR(20) DEFAULT 'text' AFTER type`);
      console.log('[v14] Migrated: matrix_content_generated.content_type added');
    } catch(e) { /* 列已存在 */ }
    try {
      await pool.execute(`ALTER TABLE matrix_content_generated ADD COLUMN preview_url VARCHAR(500) DEFAULT NULL AFTER status`);
      console.log('[v14] Migrated: matrix_content_generated.preview_url added');
    } catch(e) { /* 列已存在 */ }
    
    // 启动时标记所有旧访问记录为已处理，避免重启后重复 emit（IP 过滤已在事件层做二次保护）
    try {
      const [result] = await pool.execute('UPDATE matrix_visits_recorded SET emitted_at = NOW() WHERE emitted_at IS NULL');
      if (result.affectedRows > 0) {
        console.log(`[v14] Cleaned ${result.affectedRows} old visit records (marked as emitted)`);
      }
    } catch(e) { /* 表可能还不存在 */ }
  } catch (err) {
    console.error('[v14] initCausalChainTables error:', err.message);
  }
}

// 初始化表
async function initManagedAccountsTable() {
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS matrix_accounts_managed (
        id INT AUTO_INCREMENT PRIMARY KEY,
        bot_id VARCHAR(80) NOT NULL UNIQUE COMMENT '注册bot ID',
        platform VARCHAR(30) NOT NULL COMMENT '平台',
        username VARCHAR(100) NOT NULL COMMENT '登录用户名',
        password VARCHAR(100) NOT NULL COMMENT '登录密码',
        email VARCHAR(200) NOT NULL COMMENT '注册邮箱',
        phone VARCHAR(50) DEFAULT NULL COMMENT '注册手机号',
        registration_ip VARCHAR(45) DEFAULT NULL COMMENT '注册IP',
        profile_data JSON DEFAULT NULL COMMENT '个人资料JSON',
        user_data_dir VARCHAR(500) DEFAULT NULL COMMENT '浏览器数据目录',
        proxy_used VARCHAR(255) DEFAULT NULL COMMENT '使用的代理',
        is_valid TINYINT(1) DEFAULT NULL COMMENT '是否有效(NULL=未验证,1=有效,0=无效)',
        status VARCHAR(30) DEFAULT 'S0_CREATED' COMMENT '生命周期状态 S0_CREATED/S1_WARMING/S2_ACTIVE/S3_MATURE/S4_POWER/S5_ELITE/S6_LEGEND/S7_ARCHIVED',
        health_score DECIMAL(5,2) DEFAULT 50.00 COMMENT '健康分 0-100',
        ban_risk_score DECIMAL(5,2) DEFAULT 10.00 COMMENT '封号风险 0-100',
        warming_day INT DEFAULT 0 COMMENT '养号天数',
        bound_device_id VARCHAR(80) DEFAULT NULL COMMENT '绑定设备ID',
        last_checked_at TIMESTAMP NULL DEFAULT NULL COMMENT '最后验证时间',
        verify_error VARCHAR(500) DEFAULT NULL COMMENT '验证错误信息',
        tags VARCHAR(500) DEFAULT NULL COMMENT '账号标签，逗号分隔',
        notes TEXT DEFAULT NULL COMMENT '备注',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    // 兼容旧表：补充 v14 新增列
    const migrations = [
      { col: 'status', def: "VARCHAR(30) DEFAULT 'S0_CREATED' COMMENT '生命周期状态'" },
      { col: 'health_score', def: "DECIMAL(5,2) DEFAULT 50.00 COMMENT '健康分 0-100'" },
      { col: 'ban_risk_score', def: "DECIMAL(5,2) DEFAULT 10.00 COMMENT '封号风险 0-100'" },
      { col: 'warming_day', def: "INT DEFAULT 0 COMMENT '养号天数'" },
      { col: 'bound_device_id', def: "VARCHAR(80) DEFAULT NULL COMMENT '绑定设备ID'" },
      { col: 'tags', def: "VARCHAR(500) DEFAULT NULL COMMENT '账号标签，逗号分隔'" }
    ];
    for (const { col, def } of migrations) {
      try {
        const [[exists]] = await pool.execute(
          "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'matrix_accounts_managed' AND COLUMN_NAME = ?",
          [col]
        );
        if (!exists) {
          await pool.execute(`ALTER TABLE matrix_accounts_managed ADD COLUMN ${col} ${def}`);
          console.log(`[db] migrated column ${col}`);
        }
      } catch (migErr) {
        console.log(`[db] migration note for ${col}: ${migErr.message}`);
      }
    }
    console.log('[db] matrix_accounts_managed table ready');
  } catch (err) {
    console.error('[db] managed accounts table init failed:', err.message);
  }
}

// 获取所有托管账号（支持搜索和筛选）
app.get('/api/v1/managed-accounts', async (req, res) => {
  try {
    const { platform, search, valid, status, limit = '100', offset = '0' } = req.query;
    const limitNum = Math.max(1, Math.min(500, parseInt(limit, 10) || 100));
    const offsetNum = Math.max(0, parseInt(offset, 10) || 0);

    let where = ' WHERE 1=1';
    const esc = (v) => typeof v === 'number' ? v : `'${String(v).replace(/'/g, "\\'")}'`;

    if (platform) { where += ` AND platform = ${esc(platform)}`; }
    if (search) {
      const s = esc(`%${search}%`);
      where += ` AND (username LIKE ${s} OR email LIKE ${s} OR bot_id LIKE ${s})`;
    }
    if (valid !== undefined && valid !== '') {
      if (valid === 'null') {
        where += ' AND is_valid IS NULL';
      } else {
        where += ` AND is_valid = ${parseInt(valid, 10)}`;
      }
    }
    // 支持按生命周期状态筛选（多个状态用逗号分隔）
    if (status) {
      const statuses = status.split(',').map(s => esc(s.trim()));
      where += ` AND status IN (${statuses.join(',')})`;
    }

    // 总数查询
    const [countRows] = await pool.query(
      'SELECT COUNT(*) as total FROM matrix_accounts_managed' + where
    );

    // 数据查询
    const [rows] = await pool.query(
      `SELECT * FROM matrix_accounts_managed${where} ORDER BY created_at DESC LIMIT ${limitNum} OFFSET ${offsetNum}`
    );

    res.json({ total: countRows[0]?.total || 0, accounts: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 创建/导入托管账号
app.post('/api/v1/managed-accounts', async (req, res) => {
  try {
    const {
      bot_id, platform, username, password, email, phone,
      registration_ip, profile_data, user_data_dir, proxy_used, notes,
      status, health_score, ban_risk_score, warming_day, bound_device_id, tags
    } = req.body || {};

    if (!bot_id || !platform || !username || !email || !password) {
      return res.status(400).json({ error: 'bot_id, platform, username, email, password required' });
    }

    await pool.execute(
      `INSERT INTO matrix_accounts_managed
       (bot_id, platform, username, password, email, phone, registration_ip, profile_data, user_data_dir, proxy_used, notes, status, health_score, ban_risk_score, warming_day, bound_device_id, tags)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
       platform=VALUES(platform), username=VALUES(username), password=VALUES(password),
       email=VALUES(email), phone=VALUES(phone), registration_ip=VALUES(registration_ip),
       profile_data=VALUES(profile_data), user_data_dir=VALUES(user_data_dir),
       proxy_used=VALUES(proxy_used), notes=VALUES(notes), tags=VALUES(tags),
       status=VALUES(status), health_score=VALUES(health_score), ban_risk_score=VALUES(ban_risk_score),
       warming_day=VALUES(warming_day), bound_device_id=VALUES(bound_device_id)`,
      [
        bot_id, platform, username, password, email,
        phone || null, registration_ip || null,
        profile_data ? JSON.stringify(profile_data) : null,
        user_data_dir || null, proxy_used || null, notes || null,
        status || 'S0_CREATED',
        health_score !== undefined ? parseFloat(health_score) : 50,
        ban_risk_score !== undefined ? parseFloat(ban_risk_score) : 10,
        warming_day !== undefined ? parseInt(warming_day, 10) : 0,
        bound_device_id || null,
        tags || null
      ]
    );

    res.json({ success: true, bot_id });

    // 同步到 DataStore，确保子数据页一致
    if (dataStore && pool) {
      syncManagedAccountsToDataStore(pool, dataStore, 1000).catch(() => {});
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── [B0-D1] 真实账号源构建 ────────────────────────────────
// 背景：/api/v14/managed-accounts 一直直读 MySQL 表 matrix_accounts_managed，
// 而该表是**残留脏源**（2026-09-20 实测 147 条，100% status=S0_CREATED、
// 100% is_valid=NULL，构成 Reddit 56 / X 46 / tumblr 32 等僵尸行）。
// 前端账号页依赖它 ⇒ 带任何筛选条件时恒返回 0 条，页面全空。
//
// 这里把账号页的默认数据源切到**真实账号**（accounts.json + tumblr_token.json），
// 与 /api/v14/real-accounts 共用同一套"真实账号"判定，避免口径漂移；
// MySQL 残留改为 `?source=legacy` 显式访问并打 _archived 标记（归档只读）。
const _MA_FAKE_EMAIL = /@mscms\.mail$/i;
const _MA_TEMP_EMAIL = /guerrillamail|guerrillamailblock|mailinator|10minutemail|10minute-mail|tempmail|throwaway|dispostable|trashmail|temp-mail|fake|sharklasers|getnada|yopmail/i;

function buildLiveManagedAccounts() {
  const acctPath = dataFile('accounts.json');
  let accounts = [];
  try {
    if (fs.existsSync(acctPath)) {
      const parsed = JSON.parse(fs.readFileSync(acctPath, 'utf-8'));
      accounts = Array.isArray(parsed) ? parsed : [];
    }
  } catch (e) {
    return { accounts: [], error: `accounts.json 读取失败: ${e.message}` };
  }

  const tokenRecords = readJsonRecords(dataFile('tumblr_token.json'));
  const tokenById = new Map(tokenRecords.filter((t) => t && t.id).map((t) => [String(t.id), t]));

  const rows = accounts.map((a) => {
    const hasCreds = !!(a.email && a.password);
    const token = tokenById.get(String(a.id));
    const hasApiToken = !!(token && (token.oauthToken || token.accessToken || token.oauth_token)
      && (token.blogName || token.blog_name || token.blogname));
    const suspiciousEmail = _MA_FAKE_EMAIL.test(a.email || '') || _MA_TEMP_EMAIL.test(a.email || '');
    // 与 real-accounts 完全一致的真实判定
    const isReal = (hasCreds && !suspiciousEmail) || (a.platform === 'tumblr' && hasApiToken);
    return {
      // 保持旧端点的 snake_case 契约，前端无需改动
      id: a.id,
      platform: a.platform || '',
      username: a.username || '',
      email: a.email ? maskEmail(a.email) : '',
      bot_id: null,
      // status 保留账号库原值（实测 live 库为 active 117 / unverified 6）；
      // lifecycle 是按**客观证据**推导的生命周期档位，供按旧枚举筛选的前端使用：
      //   有 API token（已完成 OAuth 授权，可发布） → S2_ACTIVE
      //   有网页凭据但无 token                     → S1_WARMING
      //   两者皆无                                 → S0_CREATED
      status: a.status || '',
      lifecycle: hasApiToken ? 'S2_ACTIVE' : (hasCreds ? 'S1_WARMING' : 'S0_CREATED'),
      is_valid: isReal ? 1 : 0,
      created_at: a.createdAt || a._ts || null,
      updated_at: a.updatedAt || null,
      tags: Array.isArray(a.tags) ? a.tags : [],
      note: a.note || '',
      hasApiToken,
      hasCredentials: hasCreds,
      suspiciousEmail,
      _source: 'live',
      _archived: false,
    };
  });

  return { accounts: rows, error: null };
}

// v14 账号管理 API（来源：真实账号库；MySQL 残留表已归档为 legacy）
app.get('/api/v14/managed-accounts', async (req, res) => {
  try {
    const { platform, search, valid, status, limit = '100', offset = '0', pageSize, page, fields, source } = req.query;
    // M3 分页：兼容 page/pageSize（设计约定）与旧 limit/offset（向后兼容）
    const limitNum = Math.max(1, Math.min(500, parseInt(pageSize != null ? pageSize : limit, 10) || 100));
    const offsetNum = Math.max(0, parseInt(offset, 10) || ((page ? (parseInt(page, 10) - 1) * limitNum : 0)));
    // M3 字段投影：仅对已在内存中的行裁剪字段，不拼 SQL，零注入风险；缺省返回全量（向后兼容）
    const fieldList = fields ? String(fields).split(',').map(f => f.trim()).filter(Boolean) : null;

    // 【B0-D1】数据源选择
    //   live（默认）= 真实账号库：accounts.json + tumblr_token.json
    //   legacy      = MySQL 残留表 matrix_accounts_managed（归档只读）
    //   all         = 两者合并（排查口径差异时用）
    const src = String(source || 'live').toLowerCase();
    if (!['live', 'legacy', 'all'].includes(src)) {
      return res.status(400).json({ error: `非法 source: ${source}（可选 live | legacy | all）` });
    }
    let rows = [];
    const meta = { source: src, live: null, legacy: null };

    // ① 真实账号（默认数据源）
    if (src === 'live' || src === 'all') {
      const built = buildLiveManagedAccounts();
      meta.live = {
        count: built.accounts.length,
        source: 'accounts.json + tumblr_token.json',
        error: built.error || null,
      };
      rows = rows.concat(built.accounts);
    }

    // ② MySQL 残留表：归档只读，仅显式请求时返回
    if (src === 'legacy' || src === 'all') {
      try {
        const [lg] = await pool.query(
          'SELECT * FROM matrix_accounts_managed ORDER BY created_at DESC LIMIT 2000'
        );
        meta.legacy = {
          count: lg.length,
          source: 'MySQL matrix_accounts_managed',
          archived: true,
          note: '历史残留表（2026-09-20 实测 100% status=S0_CREATED / is_valid=NULL），已归档，不再作为默认数据源',
        };
        rows = rows.concat(lg.map((r) => ({ ...r, _archived: true, _source: 'legacy' })));
      } catch (e) {
        meta.legacy = { count: 0, source: 'MySQL matrix_accounts_managed', archived: true, error: e.message };
      }
    }

    // ③ 内存筛选（真实账号量级在千以内；内存筛选零注入风险，且天然支持 live/legacy 混合）
    let filtered = rows;
    if (platform) filtered = filtered.filter((r) => String(r.platform || '') === String(platform));
    if (search) {
      const s = String(search).toLowerCase();
      filtered = filtered.filter((r) => [r.username, r.email, r.bot_id, r.id]
        .some((v) => String(v == null ? '' : v).toLowerCase().includes(s)));
    }
    if (valid !== undefined && valid !== '') {
      if (valid === 'null') {
        filtered = filtered.filter((r) => r.is_valid === null || r.is_valid === undefined);
      } else {
        filtered = filtered.filter((r) => Number(r.is_valid) === parseInt(valid, 10));
      }
    }
    // 支持按生命周期状态筛选（多个状态用逗号分隔）
    if (status) {
      const want = String(status).split(',').map((s) => s.trim()).filter(Boolean);
      // 【B0-D1】同时匹配账号库原值（active / unverified）与推导出的生命周期档位
      // （S0_CREATED / S1_WARMING / S2_ACTIVE …）。只匹配其一会让旧筛选恒返 0 ——
      // 那正是 MySQL 脏源造成的原始症状。
      if (want.length) {
        filtered = filtered.filter((r) => want.includes(String(r.status)) || want.includes(String(r.lifecycle)));
      }
    }

    const total = filtered.length;
    const pageRows = filtered.slice(offsetNum, offsetNum + limitNum);

    // M3 字段投影：仅裁剪已在内存中的行字段（不拼 SQL，零注入）；缺省返回全量（向后兼容）
    const projected = fieldList && fieldList.length
      ? pageRows.map(r => { const o = {}; fieldList.forEach(f => { if (Object.prototype.hasOwnProperty.call(r, f)) o[f] = r[f]; }); return o; })
      : pageRows;

    res.json({ total, accounts: projected, _meta: meta });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/v14/managed-accounts/:id/warming', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.execute(
      'UPDATE matrix_accounts_managed SET status = ?, health_score = GREATEST(health_score, 55), warming_day = warming_day + 1 WHERE id = ?',
      ['S1_WARMING', parseInt(id, 10)]
    );
    res.json({ success: true, status: 'S1_WARMING' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/v14/managed-accounts/:id/plan', async (req, res) => {
  try {
    const { id } = req.params;
    const [[row]] = await pool.execute('SELECT status, health_score, warming_day, platform FROM matrix_accounts_managed WHERE id = ?', [parseInt(id, 10)]);
    if (!row) return res.status(404).json({ error: 'not found' });
    const phases = { S0_CREATED: 'S0_NEW', S1_WARMING: 'S1_WARMUP', S2_ACTIVE: 'S2_GROW', S3_MATURE: 'S3_MAINTAIN' };
    res.json({
      phase: phases[row.status] || 'S0_NEW',
      tierName: row.status,
      remainingActions: Math.max(0, 30 - (row.warming_day || 0) * 5),
      healthScore: row.health_score,
      platform: row.platform
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/v14/managed-accounts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body || {};
    const allowed = ['username','password','email','phone','registration_ip','profile_data','user_data_dir','proxy_used','is_valid','verify_error','notes','tags','status','health_score','ban_risk_score','warming_day','bound_device_id'];
    const fields = [];
    const values = [];

    for (const k of allowed) {
      if (updates[k] !== undefined) {
        fields.push(`${k} = ?`);
        values.push(k === 'profile_data' ? JSON.stringify(updates[k]) : updates[k]);
      }
    }

    if (fields.length === 0) {
      return res.status(400).json({ error: 'no valid fields to update' });
    }

    values.push(parseInt(id, 10));
    const [result] = await pool.execute(
      `UPDATE matrix_accounts_managed SET ${fields.join(', ')} WHERE id = ?`,
      values
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'account not found' });
    }

    // B2 (P1-2): 账号状态变为封号 → 触发重注册自愈闭环
    if (updates.status) maybeTriggerBanHeal(id, updates.status);

    res.json({ success: true, id: parseInt(id, 10) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// B2 (P1-2): 账号封号 → 触发重注册自愈闭环
// 当账号状态变为 suspended/dead/banned 时，向 HealEngine 上报 account_banned 错误，
// HealEngine level1 执行 reregister_account → emit('heal.action') → 下方监听器执行真实重注册并回灌 S1。
async function maybeTriggerBanHeal(accountId, newStatus) {
  if (!newStatus) return;
  const s = String(newStatus).toLowerCase();
  // 仅对真正失效的账号触发重注册；shadowbanned 由既有自动复活逻辑(warming/shadowbanned→active)处理
  if (!['suspended', 'dead', 'banned'].includes(s)) return;
  try {
    const [[row]] = await pool.execute(
      'SELECT platform, proxy_used, registration_ip FROM matrix_accounts_managed WHERE id=? OR bot_id=?',
      [accountId, String(accountId)]
    );
    if (!row) return;
    if (v14Modules.eventBus) {
      v14Modules.eventBus.emit('heal.error', {
        module: 'account',
        errorType: 'account_banned',
        context: {
          accountId: String(accountId),
          platform: row.platform,
          proxy: row.proxy_used,
          registration_ip: row.registration_ip,
          severity: 'high'
        },
        message: `Account ${accountId} (${row.platform}) flagged ${newStatus} → auto re-register`,
        escalated: false
      }, 'account-manager');
      console.log(`[heal] 检测到封号 ${accountId} (${row.platform}) → 触发重注册自愈`);
    }
  } catch (e) {
    console.error('[heal] ban-detect emit failed:', e.message);
  }
}

// 更新账号
app.put('/api/v1/managed-accounts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body || {};
    const allowed = ['username','password','email','phone','registration_ip','profile_data','user_data_dir','proxy_used','is_valid','verify_error','notes','tags','status','health_score','ban_risk_score','warming_day','bound_device_id'];
    const fields = [];
    const values = [];

    for (const k of allowed) {
      if (updates[k] !== undefined) {
        fields.push(`${k} = ?`);
        values.push(k === 'profile_data' ? JSON.stringify(updates[k]) : updates[k]);
      }
    }

    if (fields.length === 0) {
      return res.status(400).json({ error: 'no valid fields to update' });
    }

    values.push(parseInt(id, 10));
    const [result] = await pool.execute(
      `UPDATE matrix_accounts_managed SET ${fields.join(', ')} WHERE id = ?`,
      values
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'account not found' });
    }

    // B2 (P1-2): 账号状态变为封号 → 触发重注册自愈闭环
    if (updates.status) maybeTriggerBanHeal(id, updates.status);

    res.json({ success: true, id: parseInt(id, 10) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 删除账号
app.delete('/api/v1/managed-accounts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await pool.execute('DELETE FROM matrix_accounts_managed WHERE id = ?', [parseInt(id, 10)]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'account not found' });
    }

    res.json({ success: true, deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 批量导入 D:\LeiDian\accounts\ 下的 JSON 文件
app.post('/api/v1/managed-accounts/import', async (req, res) => {
  try {
    const accountsDir = path.join('D:', 'LeiDian', 'accounts');
    if (!fs.existsSync(accountsDir)) {
      return res.json({ imported: 0, message: 'accounts dir not found' });
    }

    const files = fs.readdirSync(accountsDir).filter(f => f.endsWith('.json'));
    let imported = 0, skipped = 0;

    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(accountsDir, file), 'utf-8'));
        if (!data.botId || !data.username || !data.email || !data.password) {
          skipped++;
          continue;
        }

        await pool.execute(
          `INSERT INTO matrix_accounts_managed
           (bot_id, platform, username, password, email, phone, registration_ip, user_data_dir, proxy_used)
           VALUES (?,?,?,?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE
           username=VALUES(username), password=VALUES(password), email=VALUES(email),
           phone=VALUES(phone), user_data_dir=VALUES(user_data_dir)`,
          [
            data.botId, data.platform || 'Unknown', data.username,
            data.password, data.email, data.phone || null,
            data.registration_ip || null, data.userDataDir || null,
            data.proxyUsed || null
          ]
        );
        imported++;
      } catch { skipped++; }
    }

    res.json({ imported, skipped, total: files.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 快速更新账号有效性（由注册引擎调用）
app.post('/api/v1/managed-accounts/update-valid', async (req, res) => {
  try {
    const { bot_id, is_valid } = req.body || {};
    if (!bot_id) return res.status(400).json({ error: 'bot_id required' });

    await pool.execute(
      'UPDATE matrix_accounts_managed SET is_valid = ?, last_checked_at = NOW() WHERE bot_id = ?',
      [parseInt(is_valid, 10) || 0, bot_id]
    );
    res.json({ success: true, bot_id, is_valid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 验证单个账号有效性
app.post('/api/v1/managed-accounts/:id/verify', async (req, res) => {
  try {
    const { id } = req.params;
    const [[account]] = await pool.execute(
      'SELECT * FROM matrix_accounts_managed WHERE id = ?',
      [parseInt(id, 10)]
    );

    if (!account) {
      return res.status(404).json({ error: 'account not found' });
    }

    // 异步执行验证
    res.json({ verifying: true, id: parseInt(id, 10), bot_id: account.bot_id });

    // 后台执行
    try {
      const { verifyAccount } = require('./account-validator.js');
      const result = await verifyAccount(account);
      await pool.execute(
        'UPDATE matrix_accounts_managed SET is_valid = ?, last_checked_at = NOW(), verify_error = ? WHERE id = ?',
        [result.valid ? 1 : 0, result.error || null, account.id]
      );
      console.log(`[verify] ${account.bot_id} → ${result.valid ? 'valid' : 'invalid'}`);
    } catch (verifyErr) {
      await pool.execute(
        'UPDATE matrix_accounts_managed SET is_valid = 0, last_checked_at = NOW(), verify_error = ? WHERE id = ?',
        [verifyErr.message.slice(0, 500), account.id]
      );
      console.error(`[verify] ${account.bot_id} error:`, verifyErr.message);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 批量验证所有未验证账号
app.post('/api/v1/managed-accounts/verify-all', async (req, res) => {
  try {
    const [accounts] = await pool.execute(
      'SELECT * FROM matrix_accounts_managed WHERE is_valid IS NULL OR is_valid = 0 ORDER BY created_at ASC LIMIT 10'
    );

    if (accounts.length === 0) {
      return res.json({ verifying: 0, message: 'no accounts to verify' });
    }

    res.json({ verifying: accounts.length, accounts: accounts.map(a => ({ id: a.id, bot_id: a.bot_id, platform: a.platform })) });

    // 后台逐个验证
    try {
      const { verifyAccount } = require('./account-validator.js');
      for (const account of accounts) {
        try {
          const result = await verifyAccount(account);
          await pool.execute(
            'UPDATE matrix_accounts_managed SET is_valid = ?, last_checked_at = NOW(), verify_error = ? WHERE id = ?',
            [result.valid ? 1 : 0, result.error || null, account.id]
          );
          console.log(`[verify-all] ${account.bot_id} → ${result.valid ? 'valid' : 'invalid'}`);
        } catch (e) {
          await pool.execute(
            'UPDATE matrix_accounts_managed SET is_valid = 0, last_checked_at = NOW(), verify_error = ? WHERE id = ?',
            [e.message.slice(0, 500), account.id]
          );
        }
      }
    } catch (moduleErr) {
      console.error('[verify-all] module error:', moduleErr.message);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 更新账号标签
app.post('/api/v1/managed-accounts/:id/tags', async (req, res) => {
  try {
    const { id } = req.params;
    const { tags } = req.body || {};
    if (!tags && tags !== '') {
      return res.status(400).json({ error: 'tags required' });
    }
    await pool.execute(
      'UPDATE matrix_accounts_managed SET tags = ? WHERE id = ?',
      [String(tags), parseInt(id, 10)]
    );
    res.json({ success: true, id: parseInt(id, 10), tags });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 下一步：批量选中账号推进自动化流程（养号→内容→发布）
app.post('/api/v14/automation/start', async (req, res) => {
  try {
    const { ids, mode = 'full' } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array required' });
    }
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });

    const [rows] = await pool.execute(
      `SELECT * FROM matrix_accounts_managed WHERE id IN (${ids.map(() => '?').join(',')})`,
      ids
    );

    const started = [];
    for (const account of rows) {
      if (!account.bot_id) continue;
      const data = {
        id: account.id,
        account_id: account.bot_id,
        bot_id: account.bot_id,
        platform: account.platform,
        username: account.username,
        email: account.email,
        phone: account.phone,
        proxy_used: account.proxy_used,
        bound_device_id: account.bound_device_id,
        health_score: parseFloat(account.health_score) || 60,
        score: parseFloat(account.health_score) || 60,
        tags: 'automation,selected'
      };

      // 1. 加入养号引擎并自动开始预热
      if (v14.nurturing && v14.nurturing.addAccount) {
        v14.nurturing.addAccount(data);
        // 自动从 S0_CREATED → S1_WARMING
        try { v14.nurturing.startWarming(data.id); } catch(e) {}
      }
      // 2. 绑定设备（若未绑定）
      autoProvisionAccount({
        bot_id: account.bot_id,
        platform: account.platform,
        username: account.username,
        email: account.email,
        password: account.password,
        proxy_used: account.proxy_used
      }).catch(() => {});
      // 3. 若 mode=full，直接触发内容生成（首次启动）
      if (mode === 'full' || mode === 'content') {
        v14.eventBus.emit('account.healthy', data, 'automation-start');
      }
      started.push(account.bot_id);
      // 记录标签
      await pool.execute(
        "UPDATE matrix_accounts_managed SET tags = IF(tags IS NULL OR tags='', ?, CONCAT(tags, ',', ?)) WHERE id = ?",
        ['selected,automation', 'selected,automation', account.id]
      );
    }

    res.json({ success: true, started, count: started.length, mode });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 账号统计
app.get('/api/v1/managed-accounts/stats', async (req, res) => {
  try {
    const [[total]] = await pool.execute('SELECT COUNT(*) as cnt FROM matrix_accounts_managed');
    const [[valid]] = await pool.execute('SELECT COUNT(*) as cnt FROM matrix_accounts_managed WHERE is_valid = 1');
    const [[invalid]] = await pool.execute('SELECT COUNT(*) as cnt FROM matrix_accounts_managed WHERE is_valid = 0');
    const [[unchecked]] = await pool.execute('SELECT COUNT(*) as cnt FROM matrix_accounts_managed WHERE is_valid IS NULL');
    const [byPlatform] = await pool.execute('SELECT platform, COUNT(*) as cnt FROM matrix_accounts_managed GROUP BY platform');

    res.json({
      total: total.cnt, valid: valid.cnt, invalid: invalid.cnt, unchecked: unchecked.cnt,
      byPlatform
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  MSCMS v14 — AI智能内容 & 自主进化引流系统 API
// ══════════════════════════════════════════════════════════════

let v14Modules = null;

// ── v14 账号同步辅助：把 MySQL matrix_accounts_managed 同步到 DataStore accounts ──
// ══════════════════════════════════════════════════════════════════════
//  真实账号判定（唯一口径，2026-09-12 统一）
//  背景：matrix_accounts_managed 里沉积了 147 行 2026-08-14 的批量测试残留
//        （邮箱全为 @guerrillamailblock.com 临时邮箱、无自家 OAuth token、
//          platform 为 Reddit/X/Discord/b2test/gmail）。它们被「从 DB 恢复账号到
//          养号引擎」整批喂进 NurturingEngine，导致控制台「🌱 养号账号 197」中
//          有 147 个是假的，并且每个进程启动都会替它们伪造一轮 account.healthy
//          事件灌进因果链。故与 /api/v14/real-accounts、accounts.json 同步共用同一判定：
//            真实 =（有 email+password 且邮箱非假/临时域名）
//                或（真实发布平台 且 有该账号自己的 API token）
// ══════════════════════════════════════════════════════════════════════
const FAKE_EMAIL_RE = /@mscms\.mail$/i;
const TEMP_EMAIL_RE = /guerrillamail|guerrillamailblock|mailinator|10minutemail|10minute-mail|tempmail|throwaway|dispostable|trashmail|temp-mail|fake|sharklasers|getnada|yopmail/i;
const REAL_PUBLISH_PLATFORMS = new Set(
  // 【2026-09-20 F5 修复】默认值必须与 cloud-publisher.js 的 realChannels 默认值**逐字一致**。
  //   修复前此处默认 'tumblr'，而 cloud-publisher.js:778 默认 'tumblr,nostr' ——
  //   同一环境变量两处默认值不同 ⇒ 本函数会把 nostr 账号判成「非真实账号」，
  //   而发布器却允许 nostr 入队，形成「通道开着但账号被判假」的隐形断层，
  //   这正是「加了环境变量仍不发布」的根因之一。
  //   ⚠️ 改这里时务必同步改 cloud-publisher.js:778（两处 + MSCMS_PROVIDER_CHANNELS 共三处）。
  String(process.env.MSCMS_REAL_CHANNELS || 'tumblr,nostr').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
);

function isRealManagedAccount(row, tokenIds, idOverride) {
  if (!row) return false;
  const email = String(row.email || '');
  const suspiciousEmail = FAKE_EMAIL_RE.test(email) || TEMP_EMAIL_RE.test(email);
  if (row.email && row.password && !suspiciousEmail) return true;
  const platform = String(row.platform || '').toLowerCase();
  if (!REAL_PUBLISH_PLATFORMS.has(platform)) return false;
  // 【2026-10-09 修复】原先只试 idOverride(=row.id) 或 row.id，漏了 row.bot_id。
  // matrix_accounts_managed.id 是自增整数，而 tumblr_token.json 的 key 是
  // `tumblr_xxx` 业务键 —— 二者格式本就不同 ⇒ 合法账号被误判 fake 全部跳过
  //（实测启动日志 "Restored 0 REAL accounts (skipped 186 fake)"）。
  // 正确做法：把 id / bot_id / 传入覆盖值**都**试一遍，任一命中 token 即为真实账号。
  const candidates = [idOverride, row.id, row.bot_id]
    .filter(v => v !== undefined && v !== null && v !== '')
    .map(v => String(v));
  return candidates.some(id => !!(tokenIds && tokenIds.has(id)));
}

/** 读取 tumblr_token.json 里已授权（有自己 token）的账号 id 集合 */
function loadAuthorizedTokenIds() {
  const ids = new Set();
  try {
    const tk = JSON.parse(fs.readFileSync(dataFile('tumblr_token.json'), 'utf8'));
    if (Array.isArray(tk)) tk.forEach(t => { if (t && t.id) ids.add(String(t.id)); });
    else if (tk && typeof tk === 'object') Object.keys(tk).forEach(k => ids.add(String(k)));
  } catch (e) { /* 无 token 文件：返回空集 */ }
  return ids;
}

async function syncManagedAccountsToDataStore(pool, dataStore, limit = 1000) {
  try {
    const [rows] = await pool.query(
      `SELECT id, bot_id, platform, username, password, email, phone,
              registration_ip, proxy_used, notes,
              status, health_score, ban_risk_score, warming_day, bound_device_id, tags,
              is_valid, created_at, updated_at
       FROM matrix_accounts_managed
       ORDER BY created_at DESC
       LIMIT ${parseInt(limit, 10) || 1000}`
    );
    // 加载 tumblr API token 的 id 集合（用于判定 tumblr 是否有真实 API 授权）
    // 【2026-10-09 修复】原实现只处理数组：`if (Array.isArray(tk))`。
    // 但 tumblr_token.json 是 **object map**（key=账号 id）⇒ 数组分支永不命中
    // ⇒ tokenIds 恒为空集 ⇒ 所有 tumblr 账号（含合法账号）都被判 fake 跳过。
    // 实测日志「Synced 0 managed accounts (skipped 186 fake)」即此bug 所致。
    // 现与 loadAuthorizedTokenIds() 保持一致，两种形态都支持。
    let tokenIds = new Set();
    try {
      const tkPath = dataFile('tumblr_token.json');
      const tk = JSON.parse(fs.readFileSync(tkPath, 'utf8'));
      if (Array.isArray(tk)) tk.forEach(t => { if (t && t.id) tokenIds.add(String(t.id)); });
      else if (tk && typeof tk === 'object') Object.keys(tk).forEach(k => tokenIds.add(String(k)));
    } catch (e) { /* ignore */ }
    // 假域名/临时邮箱识别（与 /api/v14/real-accounts 完全一致）
    const FAKE_EMAIL = /@mscms\.mail$/i;
    const TEMP_EMAIL = /guerrillamail|guerrillamailblock|mailinator|10minutemail|10minute-mail|tempmail|throwaway|dispostable|trashmail|temp-mail|fake|sharklasers|getnada|yopmail/i;

    let synced = 0, skipped = 0;
    for (const row of rows) {
      // 【2026-10-09】id 是自增整数（对账号无意义），bot_id 才是业务键
      //（tumblr_token.json / publish.json 用的都是它）。优先用 bot_id，
      // 否则 sync 出来的账号在 publish 侧永远匹配不上，重新制造孤儿。
      const id = row.bot_id || row.id;
      if (!id) continue;
      // 真实判定：有凭据且邮箱非假/临时域名；或 tumblr 有 API token（即便网页凭据缺失）
      const hasCreds = !!(row.email && row.password);
      const hasApiToken = tokenIds.has(id);
      const suspiciousEmail = FAKE_EMAIL.test(row.email || '') || TEMP_EMAIL.test(row.email || '');
      const isReal = (hasCreds && !suspiciousEmail) || (row.platform === 'tumblr' && hasApiToken);
      if (!isReal) { skipped++; continue; } // 跳过假账户，避免污染 accounts

      // ── 合并保留（非破坏式 upsert）：保护 Phase 0 迁移写入的闭环字段 ──
      // 避免每次同步把 bound_device_id / 密码信封 / login_link / causal_phase 等覆盖为空。
      const existing = dataStore.get('accounts', id) || {};
      // 【2026-10-09】tags 列存的是 JSON 字符串（如 '["reconciled","orphan"]'），
      // 原实现一律按逗号切分⇒ 得到 '["reconciled"' 这种带引号碎片的脏数组，
      // 还会把 JSON 的外层引号当成值的一部分。先试 JSON.parse，失败再退回逗号切分。
      const tagsArr = (() => {
        const raw = row.tags ?? existing.tags;
        if (Array.isArray(raw)) return raw;
        if (typeof raw === 'string' && raw.trim()) {
          const t = raw.trim();
          if (t.startsWith('[')) {
            try { const p = JSON.parse(t); if (Array.isArray(p)) return p.map(x => String(x).trim()).filter(Boolean); }
            catch (_) { /* 落到逗号切分 */ }
          }
          return t.split(',').map(s => s.trim()).filter(Boolean);
        }
        return [];
      })();
      const record = {
        // 优先保留迁移已建立的闭环字段，缺失才用 MySQL 值填充
        id,
        bot_id: row.bot_id || existing.bot_id,
        platform: row.platform || existing.platform || '-',
        username: row.username || existing.username || '',
        email: row.email || existing.email || '',
        // 【2026-10-09】MySQL 的 status 是注册流水线状态（S0_CREATED/S1_…），
        // 而发布器筛选账号用的是 status='active'。原先直接透传 MySQL 值会让
        // 对账进来的账号永远选不进发布池（等于白补）。归一为本地语义：
        // 只有显式停用态才透传，其余一律 active。
        // 注意不能沿用 existing.status —— 旧 sync 已把它写成 S0_CREATED，
        // 再 || 回去就等于把错误值又保住了（实测踩过）。
        status: (/^(suspended|disabled|banned|dead)$/i.test(String(row.status || '')))
          ? String(row.status)
          : (/^(suspended|disabled|banned|dead)$/i.test(String(existing.status || ''))
             ? String(existing.status) : 'active'),
        state: row.status || existing.state || 'S0_CREATED',
        active_status: existing.active_status || (row.status || 'active'),
        // 密码：MySQL 来的明文加密存储；已加密(信封)则原样保留
        password: row.password ? encryptPassword(row.password) : (existing.password || ''),
        phone: row.phone || existing.phone || '',
        registration_ip: row.registration_ip || existing.registration_ip || '',
        proxy_used: row.proxy_used || existing.proxy_used || '',
        notes: row.notes || existing.notes || '',
        healthScore: row.health_score !== null && row.health_score !== undefined ? parseFloat(row.health_score) : (existing.healthScore || 50),
        health_score: row.health_score !== null && row.health_score !== undefined ? row.health_score : (existing.health_score || null),
        banRiskScore: row.ban_risk_score !== null && row.ban_risk_score !== undefined ? parseFloat(row.ban_risk_score) : (existing.banRiskScore || 10),
        ban_risk_score: row.ban_risk_score !== null && row.ban_risk_score !== undefined ? row.ban_risk_score : (existing.ban_risk_score || null),
        warmingDay: row.warming_day || existing.warmingDay || 0,
        warming_day: row.warming_day || existing.warming_day || 0,
        // 一机一号：保留迁移已绑定的设备，MySQL 仅有值时才回退
        bound_device_id: existing.bound_device_id || row.bound_device_id || null,
        // 闭环扩展字段：保留迁移值，缺失才给默认值
        reg_email: existing.reg_email || row.email || '',
        reg_time: existing.reg_time || row.created_at || null,
        device_fingerprint: existing.device_fingerprint || null,
        bound_proxy: existing.bound_proxy || row.proxy_used || null,
        app_logged_in: existing.app_logged_in != null ? existing.app_logged_in : hasApiToken,
        app_session_state: existing.app_session_state || null,
        inbox_unread: existing.inbox_unread || 0,
        causal_phase: existing.causal_phase || (hasApiToken ? 'S2' : 'S1'),
        health_score_v2: existing.health_score_v2 != null ? existing.health_score_v2 : (existing.healthScore || 50),
        risk_level: existing.risk_level || 'low',
        content_quota: existing.content_quota || 5,
        last_action_at: existing.last_action_at || null,
        owner_device_capacity: existing.owner_device_capacity || null,
        active_status: existing.active_status || (row.status || 'active'),
        login_link: existing.login_link || null,
        tags: tagsArr,
        is_valid: row.is_valid,
        createdAt: existing.createdAt || row.created_at || new Date().toISOString(),
        updatedAt: row.updated_at || new Date().toISOString(),
        _source: existing._source || 'mysql-sync',
      };
      if (existing.id) dataStore.update('accounts', id, record);
      else dataStore.create('accounts', record);
      synced++;
    }
    // 防御性清除：移除缓存中残留的非真实账户（如从磁盘加载的旧假号），确保 accounts 只含真实账户
    let purged = 0;
    try {
      const acctMap = dataStore._cache && dataStore._cache.get('accounts');
      if (acctMap) {
        for (const [k, v] of acctMap) {
          const e = v.email || '';
          const sus = FAKE_EMAIL.test(e) || TEMP_EMAIL.test(e);
          const hc = !!(v.email && v.password);
          const ht = tokenIds.has(k);
          const real = (hc && !sus) || (v.platform === 'tumblr' && ht);
          if (!real) { dataStore.delete('accounts', k); purged++; }
        }
      }
    } catch (e) { /* ignore */ }
    console.log(`[DataStore] Synced ${synced} managed accounts into accounts.json (skipped ${skipped} fake/invalid, purged ${purged} stale fake)`);
    return synced;
  } catch (e) {
    console.error('[DataStore] Account sync failed:', e.message);
    return 0;
  }
}

async function getManagedAccountCount(pool, where = '1=1') {
  try {
    const [rows] = await pool.query(`SELECT COUNT(*) as total FROM matrix_accounts_managed WHERE ${where}`);
    return rows[0]?.total || 0;
  } catch (e) {
    return 0;
  }
}

function initV14() {
  if (v14Modules) return v14Modules;
  try {
    // ── P0 基础设施：EventBus + DataStore + HealEngine ──
    const { EventBus, CAUSAL_EVENTS } = require('./event-bus.js');
    const { DataStore } = require('./data-store.js');
    const { HealEngine } = require('./heal-engine.js');
    
    const eventBus = new EventBus();
    // DATA_DIR 支持外部覆盖（C: 盘写满时可将 data 目录迁移到其它盘，避免 ENOSPC/EPERM）
    const dataStore = new DataStore(PATHS.DATA_DIR);
    const healEngine = new HealEngine(eventBus, dataStore);
    
    // 启动因果链停滞监控
    eventBus.startChainMonitor(CAUSAL_EVENTS);
    
    console.log('[v14] Infrastructure ready: EventBus + DataStore + HealEngine');
    
    const { DeviceManager, FingerprintV2, AVDHealthChecker, ThreeStageADB } = require('./device-manager.js');
    const { NurturingEngine, BezierTouchGenerator, MistouchSimulator, FatigueManager } = require('./account-nurturing.js');
    const { HotTopicScraper, ContentRuleEngine, TextDedupEngine, EXIFCleaner, ImageReencoder, FourLevelRewriter } = require('./content-intelligence.js');
    const { SmartPublisher, DataFeedbackCollector, ViralSignalDetector, CrossAccountSync } = require('./smart-publisher.js');
    const { AutonomousDecisionEngine, EvolutionSystem, ABTestEngine } = require('./decision-engine.js');
    const { GPSTrajectoryEngine } = require('./gps-trajectory.js');
    const { SessionManager } = require('./session-manager.js');
    const { SCRMInterceptEngine } = require('./scrm-intercept.js');
    const { ProxyManager } = require('./proxy-manager.js');
    const { SensorSimulator } = require('./sensor-simulator.js');
    const { DAGOrchestrator } = require('./dag-orchestrator.js');
    const { SocialBridge } = require('./social-bridge.js');
    const { DAUTargetController } = require('./dau-target-controller.js');
    const { ProactiveMarketing } = require('./proactive-marketing.js');
    const { AIGCContentGenerator } = require('./aigc-content-generator.js');
    const { WebsiteAnalytics } = require('./website-analytics.js');
    const { TrafficRouter } = require('./traffic-router.js');
    const { TrendIntel } = require('./trend-intel.js');
    const { VideoRender } = require('./video-render.js');
    const { AgnesMedia } = require('./agnes-media.js');
    const { TumblrPublisher } = require('./tumblr-publisher.js');
    const { TumblrBatchPublisher } = require('./tumblr-batch-publish.js');
    const { getRotator } = require('./free-proxy-rotator.js');
    const { TumblrNurtureEngine } = require('./tumblr-nurture.js');
    const { SocialProviderManager } = require('./social-provider-manager.js');
    const { MixpostService } = require('./social-publishing.js');
    const { AccountManager } = require('./account-manager.js');
    const { RealtimeHub } = require('./v14-realtime.js');
    const { AuthManager, authMiddleware: _authMw, ROLE_PERMISSIONS: _ROLE_PERMS, ROLE_LABELS: _ROLE_LABELS } = require('./auth-manager.js');

    v14Modules = {
      eventBus,
      dataStore,
      healEngine,
      deviceManager: new DeviceManager({ maxConcurrent: 15, mode: process.env.CLOUD_PHONE_MODE || 'cloud' }),
      fingerprintV2: new FingerprintV2(),
      avdHealth: new AVDHealthChecker(new (require('./device-manager.js').ADBClient)('D:/LeiDian/platform-tools/adb.exe')),
      threeStageADB: new ThreeStageADB(new (require('./device-manager.js').ADBClient)('D:/LeiDian/platform-tools/adb.exe')),
      // 【2026-09-12】注入 dataStore：养号的成熟判定改为从 3005 落库的 tumblr_nurture
      //   真实动作记录反算（旧实现是 healthScore+1/10s 的计时器，任何账号 7.5 分钟就"成熟"
      //   并发射 account.healthy → 每轮启动白灌上百条事件、每条再触发一次内容生成）。
      nurturing: new NurturingEngine({ db: pool, dataStore }),
      mistouchSim: new MistouchSimulator(0.02),
      fatigueMgr: new FatigueManager(),
      hotScraper: new HotTopicScraper({ db: pool }),
      ruleEngine: new ContentRuleEngine(),
      textDedup: new TextDedupEngine(),
      exifCleaner: new EXIFCleaner(),
      imageReencoder: new ImageReencoder(),
      publisher: new SmartPublisher({ db: pool }),
      dataCollector: new DataFeedbackCollector({ db: pool }),
      viralDetector: new ViralSignalDetector({ db: pool }),
      syncEngine: new CrossAccountSync({ db: pool }),
      decisionEngine: new AutonomousDecisionEngine({ db: pool, eventBus, dataStore }),
      evolutionSystem: new EvolutionSystem({ db: pool, eventBus, dataStore }),
      abTestEngine: new ABTestEngine(),
      gpsEngine: new GPSTrajectoryEngine(),
      sessionMgr: new SessionManager(),
      scrmEngine: new SCRMInterceptEngine({ keywords: ['help', 'support', 'question', 'problem', 'issue'], enableAutoReply: true }),
      proxyMgr: new ProxyManager({ autoRecover: true }),
      sensorSim: new SensorSimulator(),
      dagOrch: new DAGOrchestrator(),
    };

    // ── 账号管理中央服务（account-manager）：一机一号 + 状态机 + 漏斗 + 一键登录 ──
    v14Modules.accountManager = new AccountManager({
      dataStore,
      deviceManager: v14Modules.deviceManager,
      eventBus,
    });
    v14Modules.accountManager.init();

    // ── 系统用户鉴权（auth-manager）：bcryptjs + jsonwebtoken，区别于业务账号 ──
    v14Modules.authManager = new AuthManager({
      dataDir: PATHS.DATA_DIR,
    });
    {
      const r = v14Modules.authManager.bootstrap();
      console.log(`[v14] AuthManager bootstrap: users=${r.users} bootstrapped=${!!r.bootstrapped} audit=${r.auditEntries}`);
    }

    // ── P0-P2 新模块实例化 ──
    v14Modules.websiteAnalytics = new WebsiteAnalytics();
    v14Modules.trafficRouter = new TrafficRouter({
      baseUrl: 'http://localhost:' + PORT + '/r',
      websiteAnalytics: v14Modules.websiteAnalytics,  // 【修复】打通点击→访客链路
      nurturing: v14Modules.nurturing,                 // 【修复】创作者筛选
      dataStore,                                       // 【修复】短链回填 → 点击可归因到账号
    });
    v14Modules.socialBridge = new SocialBridge({
      deviceManager: v14Modules.deviceManager,
      sessionMgr: v14Modules.sessionMgr,
    });
    v14Modules.socialBridge.start();
    v14Modules.contentGenerator = new AIGCContentGenerator({
      provider: 'ollama',
      llmEndpoint: 'http://localhost:11434/api/generate',
      llmModel: 'qwen2.5:3b',
    });
    v14Modules.contentGenerator.start();
    v14Modules.proactiveMarketing = new ProactiveMarketing({
      socialBridge: v14Modules.socialBridge,
      contentGenerator: v14Modules.contentGenerator,
      trafficRouter: v14Modules.trafficRouter,
      deviceManager: v14Modules.deviceManager,
      nurturing: v14Modules.nurturing,  // 【修复】传入养号引擎用于登录状态验证
    });
    v14Modules.proactiveMarketing.start();
    v14Modules.dauController = new DAUTargetController({
      websiteAnalytics: v14Modules.websiteAnalytics,
      socialBridge: v14Modules.socialBridge,
      contentGenerator: v14Modules.contentGenerator,
      proactiveMarketing: v14Modules.proactiveMarketing,
      trafficRouter: v14Modules.trafficRouter,
      deviceManager: v14Modules.deviceManager,
      dailyTarget: 0,
    });

    // ── 新增模块：养号规则 + 平台内容规则 + 去AI味 + 内容管线 + 云手机发布 + LOK对话 ──
    const { NurturingRulesEngine } = require('./nurturing-rules.js');
    const { ContentRuleChecker, PlatformContentRules } = require('./platform-content-rules.js');
    const { DeAIProcessor } = require('./content-deai.js');
    const { ContentPipeline } = require('./content-pipeline.js');
    const { CloudPublisher } = require('./cloud-publisher.js');
    const { LokDialogueEngine } = require('./lok-dialogue.js');
    const { DecisionBridge } = require('./decision-bridge.js');
    const { MessageInbox } = require('./message-inbox.js');
    // ── 引流转化模块：转化引擎 + 归因 + Cloaking + 实验 + 告警 + 渠道健康 ──
    const { ConversionEngine, ConversionEvent, CONVERSION_TYPES } = require('./conversion-engine.js');
    const { AttributionEngine, ATTRIBUTION_MODELS } = require('./attribution-engine.js');
    const { CloakTemplateEngine, BOT_PATTERNS } = require('./cloaking-templates.js');
    const { ExperimentEngine, EXPERIMENT_STATUS } = require('./experiment-engine.js');
    const { AlertEngine, AlertRule, ALERT_LEVELS } = require('./alert-engine.js');
    const { ChannelHealth } = require('./channel-health.js');
    const { ContentStrategyDecider } = require('./content-strategy-decider.js');

    // 【2026-09-10 修复】原为 platform:'reddit' → 落到 reddit 的 dailyQuota.post.max=1，
    // 使所有 Tumblr 账号每日发帖上限被硬钉在 1 帖（全站约 50 帖/天封顶）。
    // 现改为 tumblr：配额来自 PlatformNurturingRules.tumblr（默认 6 帖/账号/天，
    // 可用 MSCMS_TUMBLR_POST_MAX_PER_DAY 调整）。
    v14Modules.nurturingRules = new NurturingRulesEngine({
      platform: process.env.MSCMS_NURTURE_PLATFORM || 'tumblr',
    });
    v14Modules.contentRuleChecker = new ContentRuleChecker('reddit');
    v14Modules.platformContentRules = PlatformContentRules;
    v14Modules.deaiProcessor = new DeAIProcessor({
      llmEndpoint: 'http://localhost:11434/api/generate',
      llmModel: 'qwen2.5:3b',
      intensity: 'medium',
    });
    v14Modules.contentPipeline = new ContentPipeline({
      contentGenerator: v14Modules.contentGenerator,
      contentIntelligence: v14Modules.hotScraper,
      deaiProcessor: v14Modules.deaiProcessor,
      llmEndpoint: 'http://localhost:11434/api/generate',
      llmModel: 'qwen2.5:3b',
      strategyDecider: null, // 延迟注入 — 在 ContentStrategyDecider 创建后设置
    });
    v14Modules.trendIntel = new TrendIntel(dataStore);
    v14Modules.videoRender = new VideoRender(dataStore);
    // ── [P2-C3] 视频渲染完成 → 回写内容记录 ─────────────────────────────
    // 背景：video-render 原先只写自己的 video_render 记录，内容记录仅在手工
    // API 里被动更新（且漏了 content_type）。发布器 _resolveMediaForPublish 依赖
    // content 的媒体字段才能走视频通道，故必须在此闭环。
    try {
      v14Modules.videoRender.on('render:done', (rec) => {
        try {
          const cid = rec && (rec.contentId || rec.id);
          if (!cid) return;
          if (!dataStore.get('content', cid)) return;   // 零伪造：不存在的关联内容不新建
          dataStore.update('content', cid, {
            content_type: 'video',
            video_url: rec.videoUrl || null,
            video_url_local: rec.filePath || null,
            media_path: rec.filePath || null,   // 让媒体判定/发布器都认到这段视频
            duration: rec.duration || null,
          });
          console.log(`[causal] 视频渲染完成回写: ${cid} -> content_type=video (${rec.filePath})`);
        } catch (e) { console.warn('[causal] 视频回写失败: ' + e.message); }
      });
    } catch (e) { console.warn('[causal] 视频事件订阅失败: ' + e.message); }
    // ── [P3-C2] 视频调度器：按日定额自动选题 → 渲染 ──────────────────────
    // 低峰时间窗 + 串行（video-render 内部队列即串行）+ 受 P3-C5 质检闸门约束。
    // 渲染产物经上面的 render:done 订阅自动升级 content_type='video'。
    try {
      const { VideoScheduler } = require('./video-scheduler.js');
      v14Modules.videoScheduler = new VideoScheduler({
        dataStore,
        videoRender: v14Modules.videoRender,
      });
      v14Modules.videoScheduler.start();
    } catch (e) { console.warn('[v14] VideoScheduler 启动失败: ' + e.message); }
    // ── Agnes AI 图像/视频生成（文生图 / 图生图 / 多图合成 / 文生视频 / 图生视频 / 关键帧动画）──
    v14Modules.agnesMedia = new AgnesMedia(dataStore, {
      apiKey: process.env.AGNES_API_KEY,
      outDir: process.env.AGNES_OUT_DIR || 'D:/MSCMS-Content/agnes',
    });
    // 视频能力委托给 content-gen(:3010) → MoneyPrinterTurbo。
    // 原因：Agnes 公开 REST POST /v1/videos 创建的任务在 completed 后不返回可下载 url，
    //       成品取不回；而 MPT 管线（LLM脚本→素材图→Edge TTS→字幕合成）实测产出真实 mp4。
    // 图片仍走 Agnes 直连（控制台手工调用，独立凭据、不依赖 :3010 存活）。
    try {
      const { generateAsset } = require('./content-media-bridge.js');
      v14Modules.agnesMedia.setVideoDelegate(async (req) => {
        const prompt = String(req.prompt || '').trim();
        const res = await generateAsset('video', prompt, Number(process.env.AGNES_VIDEO_TIMEOUT_MS || 1800000));
        if (!res || !res.ok || !res.asset || !res.asset.localPath) {
          throw new Error((res && res.error) || 'content-gen 视频生成失败（无 localPath）');
        }
        const a = res.asset;
        return {
          id: a.id,
          status: 'completed',
          progress: 100,
          localPath: String(a.localPath).replace(/\\/g, '/'),
          bytes: a.bytes || null,
          duration: req.duration || null,
          createdAt: a.createdAt || new Date().toISOString(),
        };
      });
      console.log('[v14] AgnesMedia 视频通道 → 委托 content-gen(MPT)');
    } catch (vdErr) {
      console.warn('[v14] AgnesMedia 视频委托注入失败，回退 Agnes 直连:', vdErr.message);
    }
    v14Modules.tumblrPublisher = new TumblrPublisher(dataStore);
    v14Modules.tumblrBatchPublisher = new TumblrBatchPublisher({
      dataStore,
      videoRender: v14Modules.videoRender,
      tumblrPublisher: v14Modules.tumblrPublisher,
      mysqlPool: pool
    });
    // 真实数据回收（engagement）：拉取已发布帖真实 note_count，支撑「正向内容」筛选与二次创作
    const { EngagementHarvester } = require('./engagement-harvester.js');
    v14Modules.engagement = new EngagementHarvester({ pool, publisher: v14Modules.tumblrPublisher });
    v14Modules.engagement.ensureColumns().catch(e => console.warn('[v14] engagement.ensureColumns skipped:', e.message));
    try { if (process.env.ENABLE_ENGAGEMENT_AUTO === '1') v14Modules.engagement.startAuto(parseInt(process.env.ENABLE_ENGAGEMENT_INTERVAL_MS || '3600000', 10)); } catch (_) {}
    // 按账号确定性分配出口代理（缓解 Tumblr 429 根因之一：单出口 IP）。
    // 优先用免费开源代理旋转器（GitHub 代理列表，周期刷新）；无可用时回退 proxyPool。
    try {
      const proxyRotator = getRotator();
      proxyRotator.start(); // 周期刷新（首次扫描后台进行，不阻塞启动）
      v14Modules.tumblrPublisher.setProxyResolver((accountId) => {
        // ① 最高优先级：用户显式提供的住宅/移动代理（一行环境变量即可开启真实发布）
        const envProxy = process.env.TUMBLR_PROXY;
        if (envProxy) return envProxy;
        // ② 免费开源代理旋转器（GitHub 列表，按账号哈希分散出口）
        const rp = proxyRotator.getProxyFor(accountId);
        if (rp) return rp;
        // ③ proxyPool 中用户配置的代理（按账号哈希）
        if (proxyPool && proxyPool.length) {
          const real = proxyPool.filter((p) => typeof p === 'string' && !p.includes('example.com') && !p.includes('placeholder') && !p.startsWith('bdunlocker://'));
          if (real.length) {
            let h = 2166136261 >>> 0;
            const s = String(accountId);
            for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
            return real[h % real.length];
          }
        }
        // ④ 末级兜底：本机中继（默认 10808，实测可到达 Tumblr API）。
        //    原实现此处返回 null → 发布器直连 → 国内网络必 fetch failed，
        //    真实发布成功率被无谓归零。宁可多账号共用出口（有 429 风险，
        //    由 tumblr-publisher 的退避重试兜底），也好过完全发不出去。
        return process.env.TUMBLR_FALLBACK_PROXY || 'http://127.0.0.1:10808';
      });
      // 出口健康回传：429/连续失败 → 冷却该出口（与主服务共享健康表）
      try {
        const { ProxyPool } = require('./proxy-pool');
        const _poolForReport = new ProxyPool();
        v14Modules.tumblrPublisher.setProxyReporter((url, r) => _poolForReport.report(url, r));
      } catch (e) { console.warn('[v14] proxy reporter 接入失败:', e.message); }
      console.log('[v14] Tumblr 出口代理解析器已接入（优先级：TUMBLR_PROXY > 免费旋转器 > proxyPool；住宅IP可真实发布）');
    } catch (e) { console.error('[server] 设置 Tumblr 按账号代理解析器失败:', e.message); }
    // ── Tumblr 第二阶段真实养号引擎（替换旧模拟器，零假数据） ──
    v14Modules.tumblrNurture = new TumblrNurtureEngine({
      dataStore,
      publisher: v14Modules.tumblrPublisher,
      eventBus,
    });
    if (process.env.TUMBLR_NURTURE === '1') {
      v14Modules.tumblrNurture.start();
      console.log('[v14] Tumblr nurture engine AUTO-STARTED (TUMBLR_NURTURE=1) for', v14Modules.tumblrNurture.accounts.length, 'accounts');
    } else {
      console.log('[v14] Tumblr nurture engine loaded (idle — start via /api/v14/tumblr-nurture/start)');
    }
    v14Modules.trendIntel.startAuto();
    v14Modules.cloudPublisher = new CloudPublisher({
      deviceManager: v14Modules.deviceManager,
      nurturingRules: v14Modules.nurturingRules,
      contentRules: v14Modules.contentRuleChecker,
      tumblrPublisher: v14Modules.tumblrPublisher,
      dataStore,
      // ── Phase 3: 发布端口设备选择 ──
      accountManager: v14Modules.accountManager,
      requireBoundDevice: process.env.REQUIRE_BOUND_DEVICE === '1' || process.env.REQUIRE_BOUND_DEVICE === 'true',
    });
    v14Modules.cloudPublisher.start();

    // ── Phase 4 / #527 决策桥接器：因果链智能下沉到 4 决策点 + 真实反馈回灌 Q 表 ──
    v14Modules.decisionBridge = new DecisionBridge({
      decisionEngine: v14Modules.decisionEngine,
      accountManager: v14Modules.accountManager,
      eventBus,
      dataStore,
    });
    v14Modules.decisionBridge.init();
    console.log('[v14] DecisionBridge (Phase 4) loaded; QLearning enabled =', v14Modules.decisionBridge._enabled);

    // ── Phase 5 / #529 消息/指令统一收件箱核心：真实同步 + 未读计数 + 指令草稿（零伪造） ──
    v14Modules.messageInbox = new MessageInbox({
      dataStore,
      eventBus,
      tumblrPublisher: v14Modules.tumblrPublisher,
    });
    v14Modules.messageInbox.init();
    console.log('[v14] MessageInbox (Phase 5) loaded');

    // ── Phase 6 / #534 实时 WS 推送中心：替代 3s 轮询，事件总线去抖广播 ──
    v14Modules.realtimeHub = new RealtimeHub({
      eventBus,
      accountManager: v14Modules.accountManager,
      messageInbox: v14Modules.messageInbox,
      logger: console,
    });
    global.__rt = v14Modules.realtimeHub; // M2 / #534：全局推送句柄，供业务模块实时下发
    console.log('[v14] RealtimeHub (Phase 6) loaded; ws available =', v14Modules.realtimeHub.enabled);

    // ── Mixpost 风格社交提供方管理器 + 内容运营服务 ──
    v14Modules.providerManager = new SocialProviderManager({
      dataStore,
      tumblrPublisher: v14Modules.tumblrPublisher,
    });
    v14Modules.mixpost = new MixpostService({
      dataStore,
      providerManager: v14Modules.providerManager,
    });
    v14Modules.mixpost.start(15000);
    console.log('[v14] Mixpost social publishing layer loaded: providerManager + MixpostService (scheduler 15s)');

    // ── 因果链接入：Mixpost 真实发布 → 推进 S4 post.published ──
    // 仅当某平台版本【真实发布成功】时才发射 post.published，绝不为未配置的
    // 诚实脚手架（twitter/mastodon/...）或发布失败伪造进度（禁假数据铁律）。
    v14Modules.mixpost.on('version:published', ({ postId, account, result }) => {
      if (!result || result.status !== 'published') {
        console.warn(`[causal] Mixpost 版本未真实发布 (post=${postId}, platform=${account?.platform}, status=${result?.status})，跳过推进`);
        return;
      }
      const publishUrl = result.publishedUrl || null;
      console.log(`[causal] 📦 Mixpost 真实发布成功: post=${postId}, platform=${account?.platform}, url=${publishUrl || '(无外链)'}`);
      eventBus.emit('post.published', {
        post_id: `mixpost_${postId}_${account.platform || account.id}`,
        account_id: account.id || account.accountId || null,
        platform: account.platform,
        content_id: postId,
        publish_url: publishUrl,
        publish_duration: 0,
        device_id: null, // Mixpost 走 Web Direct / 真实 OAuth，无云手机设备
        reach: 0, likes: 0, comments: 0, shares: 0,
        published_at: result.publishedAt || new Date().toISOString(),
        source: 'mixpost',
      }, 'mixpost-real');

      // ── 实时 Webhook 推送：同一真实发布事件同步扇出到 n8n/Zapier 等自动化中枢 ──
      // 复用「真实发布」这一诚实闸门，绝不在发布失败/未配置时推送（禁假数据）。
      try {
        const post = v14Modules.mixpost.getPost(postId);
        const base = (process.env.PUBLIC_DOMAIN ? `https://${process.env.PUBLIC_DOMAIN}` : 'https://mscms.cc.cd');
        const payload = {
          event: 'post.published',
          post: {
            id: postId,
            title: (post && (post.title || (post.text || '').split('\n')[0].trim())) || null,
            text: (post && post.text) || '',
            mscmsUrl: `${base}/v14/post/${postId}`,
            externalUrl: publishUrl || null,
            channels: [account?.platform].filter(Boolean),
            publishedAt: (result.publishedAt || new Date().toISOString()),
          },
          source: 'mixpost',
          timestamp: new Date().toISOString(),
        };
        firePublishWebhook(payload).catch(() => {}); // 异步 fire-and-forget，失败不影响因果链
      } catch (whErr) {
        console.warn(`[webhook] 构造/推送异常（忽略）: ${whErr.message}`);
      }
    });

    v14Modules.lokDialogue = new LokDialogueEngine({
      ollamaEndpoint: 'http://localhost:11434/api/generate',
      ollamaChatEndpoint: 'http://localhost:11434/api/chat',
      model: 'qwen2.5:3b',
      fallbackModel: 'qwen2.5:1.5b',
    });
    console.log('[v14] New modules loaded: NurturingRules + ContentRules + DeAI + ContentPipeline + CloudPublisher + LokDialogue');

    // ── 引流转化模块初始化 ──
    try {
      v14Modules.conversionEngine = new ConversionEngine({
        trafficRouter: v14Modules.trafficRouter,
        websiteAnalytics: v14Modules.websiteAnalytics,
        dataStore,
        mysqlPool: pool,
      });
      console.log('[v14] ConversionEngine OK');
    } catch(e) { console.error('[v14] ConversionEngine failed:', e.message); v14Modules.conversionEngine = null; }
    
    try {
      v14Modules.attributionEngine = new AttributionEngine({
        conversionEngine: v14Modules.conversionEngine,
        dataStore,
      });
      console.log('[v14] AttributionEngine OK');
    } catch(e) { console.error('[v14] AttributionEngine failed:', e.message); v14Modules.attributionEngine = null; }
    
    try {
      v14Modules.cloakTemplates = new CloakTemplateEngine({ dataStore });
      console.log('[v14] CloakTemplateEngine OK');
    } catch(e) { console.error('[v14] CloakTemplateEngine failed:', e.message); v14Modules.cloakTemplates = null; }
    
    try {
      v14Modules.experimentEngine = new ExperimentEngine({ dataStore });
      console.log('[v14] ExperimentEngine OK');
    } catch(e) { console.error('[v14] ExperimentEngine failed:', e.message); v14Modules.experimentEngine = null; }
    
    try {
      v14Modules.alertEngine = new AlertEngine({
        conversionEngine: v14Modules.conversionEngine,
        channelHealth: null,
        trafficRouter: v14Modules.trafficRouter,
        dataStore,
      });
      console.log('[v14] AlertEngine OK');
    } catch(e) { console.error('[v14] AlertEngine failed:', e.message); v14Modules.alertEngine = null; }
    
    try {
      v14Modules.channelHealth = new ChannelHealth({
        trafficRouter: v14Modules.trafficRouter,
        conversionEngine: v14Modules.conversionEngine,
        dataStore,
      });
      console.log('[v14] ChannelHealth OK');
      // 回设 alertEngine 的 channelHealth 引用
      if (v14Modules.alertEngine) v14Modules.alertEngine.channelHealth = v14Modules.channelHealth;
    } catch(e) { console.error('[v14] ChannelHealth failed:', e.message); v14Modules.channelHealth = null; }
    
    try {
      v14Modules.contentStrategyDecider = new ContentStrategyDecider({
        channelHealth: v14Modules.channelHealth,
        conversionEngine: v14Modules.conversionEngine,
        dataStore,
        decisionEngine: null,
      });
      console.log('[v14] ContentStrategyDecider OK');
    } catch(e) { console.error('[v14] ContentStrategyDecider failed:', e.message); v14Modules.contentStrategyDecider = null; }
    
    // 延迟注入策略决定器到 ContentPipeline
    if (v14Modules.contentStrategyDecider && v14Modules.contentPipeline) {
      v14Modules.contentPipeline.strategyDecider = v14Modules.contentStrategyDecider;
    }
    
    console.log('[v14] Traffic modules loaded: ConversionEngine + Attribution + Cloaking + Experiments + Alerts + ChannelHealth + StrategyDecider');

    // 注入 EventBus 到需要 emit 事件的模块
    v14Modules.deviceManager.eventBus = eventBus;
    v14Modules.nurturing.eventBus = eventBus;
    v14Modules.contentGenerator.eventBus = eventBus;
    v14Modules.publisher.eventBus = eventBus;
    v14Modules.proactiveMarketing.eventBus = eventBus;
    v14Modules.websiteAnalytics.eventBus = eventBus;
    v14Modules.trafficRouter.eventBus = eventBus;
    v14Modules.cloudPublisher.eventBus = eventBus;
    v14Modules.contentPipeline.eventBus = eventBus;
    v14Modules.lokDialogue.eventBus = eventBus;
    v14Modules.conversionEngine.eventBus = eventBus;
    v14Modules.attributionEngine.eventBus = eventBus;
    v14Modules.cloakTemplates.eventBus = eventBus;
    v14Modules.experimentEngine.eventBus = eventBus;
    v14Modules.alertEngine.eventBus = eventBus;
    v14Modules.channelHealth.eventBus = eventBus;
    v14Modules.healEngine = healEngine;
    v14Modules.dataStore = dataStore;

    // ═══════════════════════════════════════════════════════════
    //  账户全链路追踪器 — 确保7阶段闭环使用同一账户
    // ═══════════════════════════════════════════════════════════
    const { AccountTracker } = require('./account-tracker.js');
    const accountTracker = new AccountTracker({ dataStore, eventBus });
    accountTracker.init().catch(e => console.warn('[v14] AccountTracker init:', e.message));
    v14Modules.accountTracker = accountTracker;
    console.log('[v14] AccountTracker loaded — 账户闭环追踪已启用');

    // ── 账户闭环 + 云手机在线 + 链接流量 聚合模块 ──
    const { AccountLoop } = require('./v14-account-loop.js');
    const accountLoop = new AccountLoop({ dataStore, eventBus });
    accountLoop.init().catch(e => console.warn('[v14] AccountLoop init:', e.message));
    v14Modules.accountLoop = accountLoop;
    console.log('[v14] AccountLoop loaded — 账户闭环/Tumblr预装/云手机在线 已启用');

    // ═══════════════════════════════════════════════════════════
    //  需求1 账户闭环(数据层保证): 任何 content 创建都强制绑定真实账户
    //  生成(content)与发布(post)共用同一 account_id → 环环相扣
    //  按平台精确匹配, 保证内容→账户→发布 三步一致
    // ═══════════════════════════════════════════════════════════
    if (dataStore && typeof dataStore.create === 'function') {
      const _origCreate = dataStore.create.bind(dataStore);
      dataStore.create = function(module, data, ...rest) {
        if (module === 'content' && data && typeof data === 'object' && !data.account_id && accountLoop) {
          try {
            const acc = accountLoop.getAccountForPlatform(data.platform);
            if (acc && acc.account_id) data.account_id = acc.account_id;
          } catch (e) { /* non-critical */ }
        }
        return _origCreate(module, data, ...rest);
      };
      console.log('[v14] 🔗 内容账户闭环包装器已挂载 (content.create → 自动绑定真实账户)');
    }

    // ═══════════════════════════════════════════════════════════
    //  因果链严格门控系统 — 每环节达标后才触发下一环节
    //  所有数据基于云手机真实操作，禁止虚假数据
    // ═══════════════════════════════════════════════════════════
    const { CausalChainGate } = require('./causal-chain-gate.js');
    const chainGate = new CausalChainGate({ eventBus, dataStore, cycleDelay: 180000 });

    // 配置阶段目标（基于真实数据校准）
    // 当前运行数据: 15周期/52分钟, 178条内容, 121次访问, DAU=129
    // 提高阈值以建立有意义的管线背压，避免秒级刷满
    chainGate.batchSetTargets({
      'account.registered': 1,     // Playwright-free: bootstrap 单事件
      'account.healthy': 1,        // 降低至1让管线快速流动，养号引擎会持续产出
      // 【2026-09-12 治本】原为 10 条/周期 × 60s 周期 = 10 条/分钟，全部由本地
      // Ollama(qwen2.5:3b, CPU 推理) 串行产出 → 实测 llama-server 占满 12 核、
      // 整机 CPU 184.6%，看门狗探活超时误判 → 反复强杀 3002（表现为"系统宕机"）。
      // 当前 ready 池已积压 1.7 万条而实际发布量极低（日发个位数），继续满负荷
      // 生成纯属浪费：下调至 2 条/周期，配合 cycleDelay 180s，
      // 生成速率 10/min → 0.67/min（-93%），Ollama 负载同步下降。
      'content.generated': 2,      // 配额：每周期生成 2 条（原 10）
      // P0-B：原为 5，但真实发布节奏跟不上，导致靠"冷启动(来源:none)"虚假推进，
      //       掩盖了 S5 从未真实触发的问题。下调至 2 以匹配真实发布能力。
      'post.published': 2,         // 发布2篇帖子（与真实发布节奏匹配）
      'visit.recorded': 10,        // 获得10次访问
      'dau.updated': 1,            // DAU达标1次即触发决策
      'action.execute': 1,         // 执行1个决策动作后循环
    });

    // 连接 EventBus — 自动累进各阶段进度
    chainGate.connectEventBus(eventBus);
    v14Modules.chainGate = chainGate;

    // ── 需求1: 账户闭环 — 每个新周期绑定一个真实一致账户 ──
    chainGate.on('chain:started', (data) => {
      try {
        const cyc = accountLoop.pickCycleAccount();
        if (cyc && cyc.account_id) {
          accountTracker.startCycle(data.cycle, cyc);
          console.log(`[causal] 🔗 周期 #${data.cycle} 绑定账户: ${cyc.account_id} (${cyc.platform})`);
        } else {
          console.warn('[causal] 无可用账户绑定周期, 使用默认');
        }
      } catch (e) {
        console.warn('[causal] 周期账户绑定失败:', e.message);
      }
    });

    // ── 注册 content.generated 执行器：主动生成内容 ──
    chainGate.registerExecutor('content.generated', async (phase) => {
      const needed = Math.max(0, phase.target - phase.current);
      if (needed <= 0) return;
      console.log(`[causal] 📝 content.generated 执行器启动，需生成 ${needed} 条内容`);
      
      // ── 数据驱动策略决定 ──
      const strategyDecider = v14Modules.contentStrategyDecider;
      let platformQuota = null;
      let disabledPlatforms = [];
      
      if (strategyDecider) {
        const strategy = strategyDecider.decide();
        disabledPlatforms = strategy.disabledPlatforms || [];
        const deprioritized = strategy.deprioritizedPlatforms || [];
        
        // 分配内容配额
        platformQuota = strategyDecider.allocateContentQuota(needed);
        
        console.log(`[causal] 🧠 策略: 禁发=[${disabledPlatforms.join(',')||'无'}] 降权=[${deprioritized.join(',')||'无'}]`);
        console.log(`[causal] 📊 配额: ${Object.entries(platformQuota).map(([p,n])=>`${p}:${n}`).join(' ')}`);
      }
      
      // P0-A 内容平台倾斜：以 Tumblr 为主的闭环拉练。
      // 原为 7 个平台均分（tumblr 仅占 ~14%），导致大量内容生成在无真实发布通道的平台上
      // （历史分布：tiktok 264 / twitter 77 / instagram 14 / tumblr 仅 6）。
      // 改为加权池：tumblr 默认 70%，其余平台分摊 30%。可用 MSCMS_TUMBLR_WEIGHT 调整(0-100)。
      const allPlatforms = (() => {
        // 【2026-09-21】others 原为 6 个「无真实发布通道」的平台
        // （reddit/instagram/tiktok/x/discord/facebook —— 既无 provider 实现也无真实账号），
        // 那 30% 生成配额全部堆积在 ready 池（无通道可发，ready 池曾达 3035 条）。
        // 改为指向**真实可发布通道**，使新平台能真正进入生成→发布闭环。
        // env MSCMS_CONTENT_OTHERS 可覆盖（逗号分隔，如 'nostr,bluesky,mastodon'）。
        const others = String(process.env.MSCMS_CONTENT_OTHERS || 'nostr')
          .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        const w = Math.min(100, Math.max(0, Number(process.env.MSCMS_TUMBLR_WEIGHT || 70)));
        const pool = [];
        const tCount = Math.max(1, Math.round(100 * w / 100));
        for (let k = 0; k < tCount; k++) pool.push('tumblr');
        const oCount = Math.max(others.length, 100 - tCount);
        for (let k = 0; k < oCount; k++) pool.push(others[k % others.length]);
        return pool;
      })();
      let platformQueue = [];
      
      // [NEWPLAT-2026-09-21] P2c 保底配额 + 队首 + 真实通道保护
      // 背景：allocateContentQuota() 是数据驱动策略器，对**无历史表现数据的新通道**
      // 权重恒为 0 ⇒ 新平台永远分不到配额（冷启动死锁）。实测现场（2026-09-21）：
      //   禁发=[reddit,x,discord,tiktok,instagram,tumblr] / 配额: facebook:2
      // 即策略器把唯一有真实账号的 tumblr 判为禁发，nostr 完全未入选 ⇒ 新平台 0 投放。
      // 兜底：对 MSCMS_REAL_CHANNELS（默认 tumblr,nostr）强制保底并**置于队首**
      // （needed 常为 2，保底通道若排在队尾会被 sort() 混洗沉底，等于没兜住）。
      let _floorList = [];
      if (platformQuota) {
        const _minShareRaw = process.env.MSCMS_CONTENT_MIN_SHARE;
        const _minShare = (_minShareRaw == null || _minShareRaw === '')
          ? 1 : Math.max(0, Number(_minShareRaw) || 0);
        const _realChans = String(process.env.MSCMS_REAL_CHANNELS || 'tumblr,nostr')
          .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        const _forceReal = process.env.MSCMS_CONTENT_FORCE_REAL_CHANNELS !== '0';

        if (_minShare > 0) {
          for (const ch of _realChans) {
            const wasDisabled = disabledPlatforms.includes(ch);
            if (wasDisabled && !_forceReal) continue;
            const cur = Number(platformQuota[ch] || 0);
            if (cur < _minShare) {
              platformQuota[ch] = _minShare;
              _floorList.push(ch);
              if (wasDisabled) {
                console.warn(`[causal] ⚠️ 策略器把真实发布通道 ${ch} 判为禁发（健康数据失真），已由保底配额放行`);
              }
            }
          }
          if (_floorList.length) {
            console.log(`[causal] 🌱 新通道保底配额: ${_floorList.map(c => c + '=' + platformQuota[c]).join(' ')}`);
          }
        }

        // 按策略配额构建生成队列（保底通道稍后单独置于队首）
        for (const [platform, count] of Object.entries(platformQuota)) {
          if (_floorList.includes(platform)) continue;          // 保底通道单独处理
          if (disabledPlatforms.includes(platform)) continue;
          for (let j = 0; j < count; j++) {
            platformQueue.push(platform);
          }
        }
        // 其余平台混洗以增加多样性
        const _restQueue = platformQueue.sort(() => Math.random() - 0.5);
        // 保底通道按各自配额置于队首
        const _floorQueue = [];
        for (const ch of _floorList) {
          const c = Math.max(1, Number(platformQuota[ch] || 1));
          for (let j = 0; j < c; j++) _floorQueue.push(ch);
        }
        platformQueue = _floorQueue.concat(_restQueue);
      } else {
        // 无策略决定器时回退到轮流模式
        platformQueue = allPlatforms;
      }
      
      // 周期账户(仅用于统计追踪); 实际每条内容按平台精确绑定同平台真实账户 → 生成/发布账户一致
      const cyc = accountTracker.getCurrentAccount() || accountLoop.pickCycleAccount() || { account_id: 'sys_default', platform: 'tumblr' };
      const cycleAccountId = cyc.account_id;
      console.log(`[causal] 🔗 周期账户(追踪): ${cycleAccountId} (${cyc.platform}) | 内容按平台绑定同平台真实账户`);

      // ── P1-D 生成侧去重（同批次 + 历史指纹）──────────────────────────
      const _batchFp = new Set();
      let _dedupSkip = 0;
      ensureBodyFpIndex(dataStore);

      for (let i = 0; i < needed; i++) {
        const platform = platformQueue[i % platformQueue.length] || allPlatforms[i % allPlatforms.length];
        // ── 需求1: 每条内容按平台绑定同平台真实账户(闭环核心) ──
        const boundAcc = accountLoop.getAccountForPlatform(platform);
        const boundAccountId = boundAcc ? boundAcc.account_id : cycleAccountId;
        let generated = null;
        try {
          if (v14Modules.contentPipeline && v14Modules.contentPipeline.generateContent) {
            generated = await v14Modules.contentPipeline.generateContent(platform, {
              accountAge: 7, tone: 'natural', generateVariants: false,
            });
          } else if (v14Modules.contentGenerator && v14Modules.contentGenerator.generate) {
            const task = await v14Modules.contentGenerator.generate(platform, { topic: pickTrendTopic(), style: 'casual' });
            generated = { content: task.result };
          }
        } catch (genErr) {
          console.error(`[causal] 主动生成失败(${platform}): ${genErr.message}`);
        }
        
        // [NEWPLAT-2026-09-21] 原判据只看外层包装对象 generated.fallback，而 contentPipeline
        // 把 fallback:true 打在内层 content 上 ⇒ 该分支永不触达，真实的
        // 「无可用内容源」被误报成「正文过短(<30字符)」，掩盖根因。
        if (!generated || !generated.content || generated.fallback || generated.content.fallback) {
          // 无真实内容时跳过，不填充假数据
          const _fbDetail = generated && generated.content && generated.content.error
            ? ` | ${generated.content.error}` : '';
          console.warn(`[causal] ⚠️ 跳过假内容生成: platform=${platform}, 无可用AI模型${_fbDetail}`);
          continue;
        }

        // ── P0 止血：AI 响应体检 ──────────────────────────────────────────
        // 背景（2026-09-07 定位）：外部 AI 服务异常时返回 "400 Bad Request" 等错误文本，
        // 因其非 null 故不触发 fallback，被当成正常内容入库；再叠加 qualityScore||75 兜底
        // 直接进入 ready 发布池，最终外发污染线上账号（实测已外发 114~144 条）。
        // 这里统一做有效性校验：不合法即丢弃并记日志，绝不写占位/错误内容。
        const _rawBody0 = String(generated?.content?.body || generated?.content?.text || '').trim();
        const _title0 = String(generated?.content?.title || '').trim();
        const _probe0 = (_title0 + ' ' + _rawBody0).trim();
        // ① HTTP 错误文本 / 占位文案
        const GARBLED_RE = /^(400|401|403|404|405|408|429|500|502|503|504)\b|bad request|auto-generated|internal server error|service unavailable|unauthorized|forbidden|not found|gateway|error occurred|timed? ?out|undefined|null/i;
        // ② 占位标题形如 "Post for tumblr"
        const PLACEHOLDER_RE = /^post for\s+[\w-]+$/i;
        let _badReason = '';
        if (_rawBody0.length < 30) _badReason = '正文过短(<30字符)';
        else if (GARBLED_RE.test(_probe0)) _badReason = '命中错误响应/占位文案黑名单';
        else if (PLACEHOLDER_RE.test(_title0 || _rawBody0)) _badReason = '占位标题 Post for {platform}';
        else if (_rawBody0 === `Post for ${platform}`) _badReason = '正文为占位串';
        if (_badReason) {
          console.warn(`[causal] 🚫 丢弃无效 AI 产物: platform=${platform}, reason=${_badReason}, probe=${JSON.stringify(_probe0.slice(0, 60))}`);
          continue;
        }

        const contentId = generated?.content?.id || generated?.content?.contentId || `content_direct_${Date.now()}_${i}`;
        const rawBody = generated?.content?.body || generated?.content?.text || `Post for ${platform}`;
        const title = generated?.content?.title || rawBody.substring(0, 60).replace(/\n/g, ' ').trim();
        const body = rawBody;
        // 取消 75 分兜底：无真实评分的内容标记 unscored 且不进 ready 发布池（零伪造，不虚构分数）
        const qualityScore = generated?.qualityScore != null ? generated.qualityScore
          : (generated?.content?.qualityScore != null ? generated.content.qualityScore : null);
        const contentType = generated?.content?.content_type || 'text';

        // ── P1-B1 标签链路 ──────────────────────────────────────────────
        // 池内容自带 tags（content-pool.getContent 已修字段对齐）；
        // LLM 产物无 tags → 用规则生成器推导；提不出则留空，由质检闸门拦截。
        // 池内容带 topic；LLM 产物从管线 Stage1 的 trend_analysis 回填（真实热点标题）
        // P1 修复：topic 统一归一化（对象取其 title），避免落库出现 "[object Object]"
        const contentTopic = _ctTools.normalizeTopic(generated?.content?.topic)
          || _ctTools.normalizeTopic((Array.isArray(generated?.stages) ? generated.stages : [])
            .map((x) => (x && x.stage === 'trend_analysis' && x.result && x.result.topic) ? x.result.topic : null)
            .find((x) => !!x));
        let contentTags = Array.isArray(generated?.content?.tags) ? generated.content.tags
          : (Array.isArray(generated?.content?.hashtags) ? generated.content.hashtags : []);
        if (!contentTags.length) {
          try {
            contentTags = require('./content-tagger.js').deriveTags({
              topic: contentTopic, title, body,
              tone: generated?.content?.tone,
              target_audience: generated?.content?.target_audience,
              keywords: generated?.content?.keywords,
              platform,
            });
          } catch (e) { contentTags = []; }
        }
        // ── P1-D 正文指纹（跨账号复用硬闸门依据；按 body 而非 id）────────
        const bodyFp = require('./content-tagger.js').bodyFingerprint(body);

        // P1-D 生成侧硬闸门：同批次或历史已存在该正文 → 跳过（不落库、不推进因果链）
        // 安全阀：连续跳过达阈值即放行并告警，避免内容源枯竭导致零生成。
        if (bodyFp && (_batchFp.has(bodyFp) || _bodyFpIndex.has(bodyFp))) {
          _dedupSkip += 1;
          const _sf = Number(process.env.MSCMS_DEDUP_GEN_MAX_SKIP || 5);
          if (_dedupSkip < _sf) {
            console.warn(`[causal] ♻️ 跳过重复正文(连续第 ${_dedupSkip} 次, fp=${bodyFp}): ${contentId}`);
            continue;
          }
          console.warn(`[causal] ⚠️ 生成侧去重安全阀触发：连续 ${_dedupSkip} 条重复，本次放行并告警（内容源枯竭，需扩容内容池）`);
          eventBus.emit('content.dedup.starved', { streak: _dedupSkip, platform }, 'dedup-gate');
          _dedupSkip = 0;
        } else {
          _dedupSkip = 0;
        }

        
        // 保存到 DataStore
        // P0：无真实评分 → unscored；P1：再按 quality_v2 单轨判定（≥60 才进发布池）
        const q2 = computeQualityV2({ title, body, ai_score: generated?.aiScore, tags: contentTags });
        const contentStatus = (qualityScore == null || q2 < 60) ? 'unscored' : 'ready';
        if (contentStatus !== 'ready') {
          console.warn(`[causal] ⚠️ 内容未过质检(v2=${q2})，标记 unscored 不进发布池: ${contentId}`);
        }
        dataStore.create('content', {
          id: contentId, platform, content_type: contentType,
          type: 'post', title, body, quality_score: qualityScore,
          quality_v2: q2, ai_score: generated?.aiScore || 0,
          tags: contentTags, body_fp: bodyFp, topic: contentTopic,
          account_id: boundAccountId,
          status: contentStatus, generated_at: new Date().toISOString(),
        });
        // 登记指纹供后续去重（本批次 + 历史索引）
        if (bodyFp) { _batchFp.add(bodyFp); _bodyFpIndex.add(bodyFp); }

        // 发射事件推进因果链（绑定同平台真实账户，闭环）
        eventBus.emit('content.generated', {
          content_id: contentId, platform, account_id: boundAccountId,
          bound_device_id: cyc.bound_device_id || null,
          type: 'post', content_type: contentType, title, body,
          topic: contentTopic, tags: contentTags, body_fp: bodyFp,
          quality_score: qualityScore, generated_at: new Date().toISOString(),
        }, 'gate-executor');

        // ── 需求1: 记录到账户闭环追踪器 ──
        try { accountTracker.recordPhaseOutput('content.generated', {
          content_id: contentId, platform, account_id: boundAccountId,
          title, body, quality_score: qualityScore, content_type: contentType,
        }); } catch(e) {}

        console.log(`[causal] 主动生成完成 (${i+1}/${needed}): ${contentId} (${platform}) 账户=${cycleAccountId}`);
      }
    });

    // ── S1→S3: 注册成功 → 养号引擎 ────────────────────
    eventBus.on('account.registered', 'nurturing', (data) => {
      console.log(`[causal] S1→S3: account.registered → ${data.account_id || data.bot_id}`);
      const id = data.account_id || data.bot_id;
      const existing = dataStore.get('accounts', id) || {};
      const record = {
        id,
        platform: data.platform || existing.platform,
        username: data.username || existing.username,
        email: data.email || existing.email,
        // 密码加密存储；已加密信封则保留
        password: data.password ? encryptPassword(data.password) : (existing.password || ''),
        phone: data.phone || existing.phone || null,
        registration_ip: data.registration_ip || existing.registration_ip || null,
        proxy_used: data.proxy_used || existing.proxy_used || null,
        status: 'warming',
        bound_device_id: existing.bound_device_id || data.bound_device_id || null,
        follower_count: existing.follower_count || 0,
        following_count: existing.following_count || 0,
        post_count: existing.post_count || 0,
        engagement_rate: existing.engagement_rate || 0,
        total_actions: existing.total_actions || 0,
        total_reach: existing.total_reach || 0,
        tags: Array.isArray(data.tags) ? data.tags : (Array.isArray(existing.tags) ? existing.tags : []),
        // 闭环扩展字段（新建账号默认值，保留既有）
        reg_email: existing.reg_email || data.email || null,
        reg_time: existing.reg_time || data.createdAt || data._ts || null,
        device_fingerprint: existing.device_fingerprint || null,
        bound_proxy: existing.bound_proxy || data.proxy_used || null,
        app_logged_in: existing.app_logged_in != null ? existing.app_logged_in : false,
        app_session_state: existing.app_session_state || null,
        inbox_unread: existing.inbox_unread || 0,
        causal_phase: existing.causal_phase || 'S1',
        health_score: existing.health_score != null ? existing.health_score : 50,
        risk_level: existing.risk_level || 'low',
        content_quota: existing.content_quota || 5,
        last_action_at: existing.last_action_at || null,
        owner_device_capacity: existing.owner_device_capacity || null,
        active_status: existing.active_status || 'warmup',
        login_link: existing.login_link || null,
        ...data
      };
      if (existing.id) dataStore.update('accounts', id, record);
      else dataStore.create('accounts', record);
      if (v14Modules.nurturing.addAccount) {
        v14Modules.nurturing.addAccount(data);
      }
      // 进度由 chainGate.connectEventBus 自动累进
    });

    // ── S3→S5: 养号达标 → 生成真实内容 ──────────────────
    eventBus.on('account.healthy', 'publisher', async (data) => {
      console.log(`[causal] S3→S5: account.healthy → ${data.account_id}, score=${data.score}`);
      dataStore.update('accounts', data.account_id, {
        status: 'active',
        engagement_rate: data.score,
        last_active_at: new Date().toISOString()
      });
      try { if (v14Modules.publisher.enqueueAccount) v14Modules.publisher.enqueueAccount(data); } catch(e) {}

      // 平台直传（不再做 x/twitter 转换 — PLATFORM_SPECS 和 PlatformPublishConfig 已同时支持两者）
      const platform = data.platform || 'tiktok';
      let generated = null;
      try {
        if (v14Modules.contentPipeline && v14Modules.contentPipeline.generateContent) {
          generated = await v14Modules.contentPipeline.generateContent(platform, {
            accountAge: data.account_age || data.warmingDay || 7,
            tone: 'natural',
            generateVariants: false,
          });
        } else if (v14Modules.contentGenerator && v14Modules.contentGenerator.generate) {
          const task = await v14Modules.contentGenerator.generate(platform, { topic: pickTrendTopic(), style: 'casual' });
          generated = { content: task.result };
        }
      } catch (genErr) {
        console.error(`[causal] 内容生成失败: ${genErr.message}`);
        if (genErr.stack) console.error(`[causal] 堆栈: ${genErr.stack.split('\n').slice(0, 4).join(' | ')}`);
        // LLM 不可用时不生成假内容，跳过此轮
        console.warn(`[causal] ⚠️ 跳过 account.healthy 假内容: platform=${platform}, LLM_UNAVAILABLE`);
        return;
      }
      // 检查 fallback 标记 —— 跳过假数据
      if (generated && generated.fallback) {
        console.warn(`[causal] ⚠️ 跳过 fallback 内容: platform=${platform}`);
        return;
      }

      const contentId = generated?.content?.id || generated?.content?.contentId || `content_${data.account_id}_${Date.now()}`;
      const rawBody2 = generated?.content?.body || generated?.content?.text || generated?.content?.caption || `Post for ${platform}`;
      const title = generated?.content?.title || rawBody2.substring(0, 60).replace(/\n/g, ' ').trim();
      const body = rawBody2;
      const qualityScore = generated?.qualityScore || generated?.content?.qualityScore || 82;
      const contentType = generated?.content?.content_type || generated?.contentType || 'text';

      // 保存内容到 D 盘: D:\MSCMS-Content\YYYY-MM-DD\{type}\
      let previewUrl = null;
      if (v14Modules.contentGenerator && v14Modules.contentGenerator.saveContentToFile) {
        try {
          const saved = v14Modules.contentGenerator.saveContentToFile({
            id: contentId,
            platform,
            contentType,
            completedAt: new Date().toISOString(),
            qualityScore,
            result: generated?.content || { title, body },
          });
          if (saved) previewUrl = saved.previewUrl;
        } catch (e) { /* non-critical */ }
      }

      console.log(`[causal] 内容生成完成: ${contentId} (type=${contentType}, quality=${qualityScore})`);
      
      // ── P1 修复：本入口是 content_tumblr_* 主生成路径 ──────────────────
      // P0 的响应体检只覆盖了 content_direct_* 入口，本入口历史故障率 65%，
      // 是垃圾内容的主要来源。这里补齐体检 + 质检单轨 quality_v2。
      const _t = String(title || '').trim();
      const _b = String(body || '').trim();
      // 【2026-09-12 修复】原为 `(_b && _b.length < 30)` —— 空正文时 `'' && ...`
      // 短路为 '' 即 falsy，守卫形同虚设，无正文记录直接放行（实测 ready 池中
      // 1.4 万条数字 id 记录 100% 为空正文）。改为直接判长度；有 preview_url 的
      // 图片/视频贴允许无正文。
      // [P2-B5] previewUrl 是存档 JSON 路径，不得作为「有媒体」依据；
      // 真实媒体字段从生成产物透传（pickMediaFields 已过滤空值/.json）。
      const _mediaMain = pickMediaFields(generated?.content || {});
      const _garbled = !_t || Q2_BAD_RE.test(_t) || (!contentHasRealMedia(_mediaMain) && _b.length < 30);
      const q2Main = computeQualityV2({ title, body, ai_score: generated?.aiScore, ..._mediaMain });
      if (_garbled) {
        console.warn(`[causal] 🚫 响应体检未通过，丢弃不入库: ${contentId} title="${_t.slice(0, 40)}"`);
      } else {
        const _st = (qualityScore == null || q2Main < 60) ? 'unscored' : 'ready';
        // 保存到 DataStore 以便 post.published executor 使用
        dataStore.create('content', {
          id: contentId,
          platform,
          content_type: contentType,
          type: 'post',
          title,
          body,
          quality_score: qualityScore,
          quality_v2: q2Main,
          ai_score: generated?.aiScore || 0,
          preview_url: previewUrl,                 // 存档路径：仅供预览页
          media_path: _mediaMain.media_path || null,  // [P2-B5] 真实媒体
          media_url: _mediaMain.media_url || null,
          status: _st,
          account_id: data.account_id,
          generated_at: new Date().toISOString(),
        });

        eventBus.emit('content.generated', {
          content_id: contentId,
          pipeline_id: generated?.pipelineId || null,
          account_id: data.account_id,
          platform: platform,
          type: 'post',
          content_type: contentType,
          title,
          body,
          quality_score: qualityScore,
          quality_v2: q2Main,
          ai_score: generated?.aiScore || 0,
          preview_url: previewUrl,
          generated_at: new Date().toISOString(),
        }, generated ? 'content-pipeline' : 'content-generated');
      }
      // 进度由 chainGate.connectEventBus 自动累进
    });

    // ── S4→S5: 内容生成 → 云手机真实发布（无虚假数据）──
    // 注册执行器：当 content.generated 阶段完成后，批量入队 CloudPublisher
    // 平台名映射：内容平台 → 账号平台（DataStore 中 'x' 对应 'twitter'）
    // [NEWPLAT-2026-09-21] 补 provider 通道平台，使映射表与 SUPPORTED_PUBLISH_PLATFORMS 口径一致
    //   （使用处有 `|| content.platform` 兜底，故本项为诊断/可维护性改进，非功能必需）
    const PLATFORM_TO_ACCOUNT = { 'x': 'twitter', 'twitter': 'twitter', 'reddit': 'reddit', 'instagram': 'instagram', 'tiktok': 'tiktok', 'discord': 'discord', 'facebook': 'facebook', 'tumblr': 'tumblr', 'nostr': 'nostr', 'bluesky': 'bluesky', 'mastodon': 'mastodon', 'telegram': 'telegram', 'devto': 'devto', 'hashnode': 'hashnode', 'github': 'github' };

    // 支持发布的平台列表（与 PlatformPublishConfig 对应）
    // 【2026-09-21】补齐 provider 通道平台，使日志里的「支持列表」与实际可发布通道一致
    // （仅用于诊断打印，不参与闸门判定；真正的闸门是 REAL_CHANNELS ∩ _providerChannels）。
    const SUPPORTED_PUBLISH_PLATFORMS = ['reddit', 'x', 'twitter', 'instagram', 'tiktok', 'facebook', 'discord', 'tumblr',
      'nostr', 'bluesky', 'mastodon', 'telegram', 'devto', 'hashnode', 'github'];

    // 真实发布通道：必须与 cloud-publisher.js 的 MSCMS_REAL_CHANNELS 判定保持一致，
    // 否则 S4 会把没有真实通道的平台内容反复入队 → 入队瞬间即 FAILED
    // （"no real channel"），挤占每轮有限的入队名额并污染失败统计。
    // 【2026-09-20 F5(2)】接入新通道时改 env MSCMS_REAL_CHANNELS 即可；但 env 未设时
    //   必须与全部 4 处硬编码默认值同源 —— 改一处就得改全部：
    //     · server.js:2181          REAL_PUBLISH_PLATFORMS
    //     · server.js:3285（本处）  REAL_CHANNELS  ← S4→S5 入队闸门
    //     · cloud-publisher.js:787  realChannels   ← 发布闸门
    //     · v14-account-loop.js:22  REAL_PUBLISH_PLATFORMS
    //   生产 env 实测未设置 ⇒ 四处默认值即真实生效值。任一不同源即形成
    //   「cloud-publisher 放行、但链路不入队」的隐形断层（nostr 0 条即此类根因）。
    const REAL_CHANNELS = (process.env.MSCMS_REAL_CHANNELS || 'tumblr,nostr')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

    chainGate.registerExecutor('post.published', async (phase) => {
      console.log(`[causal] 🚀 post.published 阶段启动，目标: ${phase.target}`);

      // ── 去重闸门：同一 (账号, 内容) 组合 24h 内只真实发布一次 ────────────────
      // 历史事故（2026-09-04）：S4 每轮都取 status='ready' 的内容，而发布成功后
      // 只写了 published=true、未变更 status，导致同一条内容对同一账号在 25 小时内
      // 被真实发布 500+ 次 —— 账号刷屏 + 平台每日配额(8023)被自身耗尽。
      // 双重保险：① 内容状态机 ready→queued→published/failed；② MySQL 近 24h pair 查重。
      const recentPairs = new Set();
      try {
        const [pairRows] = await pool.execute(
          "SELECT DISTINCT CONCAT(account_id, '|', content_id) AS p FROM matrix_posts_published " +
          "WHERE published_at >= NOW() - INTERVAL 24 HOUR AND content_id IS NOT NULL"
        );
        for (const r of pairRows) recentPairs.add(String(r.p));
      } catch (e) {
        console.warn('[causal] ⚠️ 读取近期发布去重集合失败: ' + e.message + '（本轮退化为仅按内容状态去重）');
      }
      console.log(`[causal] 去重闸门：近 24h 已有 ${recentPairs.size} 个 (账号,内容) 组合`);

      // ── P1 诊断：定位「ready 内容查不到」的根因 ──────────────────────────
      // 现象：磁盘与 API 均显示 ready≈487（tumblr 276），但本处 list 结果为 0。
      // 怀疑本处 dataStore 与 API 路由所用实例不同 / 模块未加载。保留为低频日志。
      try {
        const _all = dataStore.list('content', { limit: 1 });
        const _rdy = dataStore.list('content', { filter: { status: 'ready' }, limit: 1 });
        console.log(`[causal][诊断] dsTotal=${_all && _all.total} readyTotal=${_rdy && _rdy.total}`);
      } catch (e) {
        console.warn('[causal][诊断] dataStore.list 异常: ' + e.message);
      }
      // 从 DataStore 获取待发布内容（dataStore.list 返回 { items, total, ... } 对象）
      // ── P0-1 修复（2026-09-15）：发布断粮根因 ────────────────────────────────
      // 旧实现 = 「取最新 50 条 ready」→ 再按平台过滤。该窗口是**全局时间序**：
      // 实测磁盘上最新 50 条 ready 全为 reddit/tiktok/instagram/discord/facebook/x，
      // tumblr **0 条**；而 tumblr ready 实际有 3035 条、其中 2957 条完全通过 isPublishable。
      // 结果「2957 条可发内容，一条都取不到」→ contents=0 → 跳过发布阶段
      // → 冷启动只补 1 分 → 永久卡在 post.published 1/2 → 因果链死锁（零发布+零生成）。
      // 上一版只修了 sort 字段名（created_at→createdAt），但排序修好恰恰**加速**了
      // 其他平台新内容挤占窗口，所以断粮依旧。
      // 修法：把平台条件下推到 DataStore.filter（逐字段 String 精确匹配，与库内
      // 小写平台名一致），每个真实通道各取一窗再合并去重。窗口从此只被**同平台**
      // 内容竞争，不再被其他平台的生成洪峰挤出。
      const PICK_LIMIT_PER_CHANNEL = Math.max(50, Number(process.env.MSCMS_PICK_LIMIT_PER_CHANNEL) || 50);
      const pickedIds = new Set();
      const picked = [];
      const pickStat = [];
      for (const ch of REAL_CHANNELS) {
        let r = null;
        try {
          r = dataStore.list('content', {
            filter: { status: 'ready', platform: ch },
            limit: PICK_LIMIT_PER_CHANNEL,
            sort: 'createdAt', order: 'desc',
          });
        } catch (e) {
          console.warn(`[causal] ⚠️ 通道 ${ch} 选取失败: ${e.message}`);
          continue;
        }
        const items = (r && r.items) ? r.items : [];
        pickStat.push(`${ch}=${items.length}/${(r && r.total) || 0}`);
        for (const c of items) {
          if (!c || c.id == null) continue;
          const key = String(c.id);
          if (pickedIds.has(key)) continue;
          pickedIds.add(key);
          picked.push(c);
        }
      }
      console.log(`[causal] 逐通道选取(${REAL_CHANNELS.join(',')}): ${pickStat.join(' | ')} → 合并去重 ${picked.length} 条`);
      const contentResult = { items: picked.slice(), total: picked.length };
      let contents = picked;
      // 只保留「可发布且未被消费」的内容：
      //  - 平台受支持
      //  - status 仍为 ready（queued/published/failed 的内容不再重复入队）
      //  - 没有 published / published_at 标记（历史数据兼容）
      // 兼容历史数据：status 字段缺失时视为 ready；平台名大小写不敏感（历史上存在 X/x、Reddit/reddit 双名）
      // ── P0 止血：垃圾标题发布闸门 ──────────────────────────────────────
      // 存量 content.json 中仍有 299 条标题为 "400 Bad Request" / "Auto-generated content" 的垃圾内容
      // 处于 ready 状态，若不清洗会继续被发布器选中外发（实测已外发 114~144 条）。
      // 在发布选取处加硬闸门：命中即排除，并计入统计。
      const GARBLED_TITLE_RE = /^(400|401|403|404|405|408|429|500|502|503|504)\b|bad request|auto-generated|internal server error|service unavailable|unauthorized|forbidden|not found|gateway|error occurred|timed? ?out|^post for\s+[\w-]+$/i;
      const isGarbledContent = (c) => {
        const t = String(c.title || '').trim();
        if (!t) return false;
        if (GARBLED_TITLE_RE.test(t)) return true;
        const b = String(c.body || c.text || '').trim();
        if (b && b.length < 30) return true;             // 正文过短视为无效内容
        return false;
      };
      const isPublishable = (c) => {
        const plat = String(c.platform || '').toLowerCase();
        // P1 质检单轨：新内容带 quality_v2 时以其为准（≥60 方可发布）；
        // 存量内容没有该字段，仍走原有规则，避免一刀切误伤。
        const q2ok = (c.quality_v2 === undefined || c.quality_v2 === null)
          ? true : (Number(c.quality_v2) >= 60);
        return REAL_CHANNELS.includes(plat)
          && (!c.status || c.status === 'ready') && !c.published && !c.published_at
          && !isGarbledContent(c) && q2ok;
      };
      contents = contents.filter(isPublishable);
      try {
        const all0 = (contentResult && contentResult.items) ? contentResult.items : [];
        const blocked = all0.filter((c) => isGarbledContent(c)).length;
        if (blocked > 0) console.warn(`[causal] 🚫 垃圾内容闸门拦截 ${blocked} 条（标题为错误响应/占位文案，禁止发布）`);
      } catch (e) { /* 统计失败不影响主流程 */ }
      console.log(`[causal] DataStore 查到 ${contents.length} 条 ready 内容 (真实通道: ${REAL_CHANNELS.join(', ')}；支持列表: ${SUPPORTED_PUBLISH_PLATFORMS.join(', ')})`);

      if (contents.length < phase.target) {
        // ── P0-1 修复（第二处）：兜底补取同样必须按通道下推条件 ──────────────
        // 旧兜底是 `list('content', {limit:100, sort:'createdAt'})` 无平台条件，
        // 实测最新 100 条全是 published/queued，补取恒为 0，兜底完全失效。
        // 现改为：逐通道、只下推平台条件（**不带 status**，以兼容历史缺失 status
        // 的记录，交由 isPublishable 兜底判定），并扩大窗口。
        console.log(`[causal] 可发布内容不足 (${contents.length}/${phase.target})，按通道扩大窗口补取`);
        const FALLBACK_LIMIT_PER_CHANNEL = Math.max(200, PICK_LIMIT_PER_CHANNEL * 4);
        const existingIds = new Set(contents.map(c => String(c.id)));
        const fbStat = [];
        for (const ch of REAL_CHANNELS) {
          let r = null;
          try {
            r = dataStore.list('content', {
              filter: { platform: ch },
              limit: FALLBACK_LIMIT_PER_CHANNEL,
              sort: 'createdAt', order: 'desc',
            });
          } catch (e) { continue; }
          const items = (r && r.items) ? r.items : [];
          let add = 0;
          for (const c of items) {
            if (!c || c.id == null) continue;
            const key = String(c.id);
            if (existingIds.has(key)) continue;
            if (!isPublishable(c)) continue;
            existingIds.add(key);
            contents.push(c);
            add++;
          }
          fbStat.push(`${ch}+${add}`);
        }
        console.log(`[causal] 扩大窗口补取 ${fbStat.join(',')}，合并后共 ${contents.length} 条可用内容`);
      }

      if (contents.length === 0) {
        // 触发一批内容生成
        console.log('[causal] 触发生成新内容以供发布');
        for (let i = 0; i < phase.target * 2; i++) {
          const warmAccounts = Array.from(v14Modules.nurturing.accounts?.values() || [])
            .filter(a => a.status === 'S3_MATURE' || a.health_score >= 60);
          // 【P1 修复】旧逻辑直接用养号账号的 platform（实测为 tiktok），但真实可发布通道
          // 只有 tumblr，导致「每轮狂生成 → 全部不可发布 → 发布永远 0 条」的空转。
          // 现在优先挑选平台属 REAL_CHANNELS 的账号；无可发布平台账号时才回落到原逻辑。
          const realPool = warmAccounts.filter(a => REAL_CHANNELS.includes(String(a.platform || '').toLowerCase()));
          const pool = realPool.length > 0 ? realPool : warmAccounts;
          if (pool.length > 0) {
            const acc = pool[i % pool.length];
            let plat = String(acc.platform || '').toLowerCase() || 'tiktok';
            if (!REAL_CHANNELS.includes(plat)) plat = REAL_CHANNELS[0];
            try {
              if (v14Modules.contentGenerator && v14Modules.contentGenerator.generate) {
                const task = await v14Modules.contentGenerator.generate(plat, { topic: pickTrendTopic(), style: 'casual' });
                const cid = `content_batch_${Date.now()}_${i}`;
                const ct = task?.result?.content_type || 'text';
                const title = task?.result?.title || 'Batch content';
                const body = task?.result?.body || task?.result?.text || 'Batch generated';

                // 保存到 D 盘
                let previewUrl = null;
                if (v14Modules.contentGenerator.saveContentToFile) {
                  try {
                    const saved = v14Modules.contentGenerator.saveContentToFile({
                      id: cid, platform: plat, contentType: ct,
                      completedAt: new Date().toISOString(),
                      qualityScore: task?.qualityScore || 80,
                      result: task?.result || { title, body },
                    });
                    if (saved) previewUrl = saved.previewUrl;
                  } catch(e) {}
                }

                // 需求1闭环: 内容绑定到决定平台的养号账户(acc), 与注册/养号同源
                const boundAccId = (acc && acc.account_id)
                  || (accountLoop.getAccountForPlatform(plat)?.account_id)
                  || null;
                // P1 质检单轨：取消 `|| 80` 兜底分与 `status:'ready'` 硬编码
                // （旧逻辑下无论生成质量如何都直接进发布池，是垃圾外发的第二条通道）
                // P1-B1/D 同上：补标签与指纹（该链路独立落库，不经过 S4→S5）
                let _tagsB = Array.isArray(task?.result?.tags) ? task.result.tags
                  : (Array.isArray(task?.result?.hashtags) ? task.result.hashtags : []);
                if (!_tagsB.length) {
                  try {
                    _tagsB = require('./content-tagger.js').deriveTags({
                      topic: _ctTools.normalizeTopic(task?.result?.topic), title, body,
                      tone: task?.result?.tone, platform: plat,
                    });
                  } catch (e) { _tagsB = []; }
                }
                const _fpB = require('./content-tagger.js').bodyFingerprint(body);
                // [P2-B5] 同上：previewUrl 为存档 JSON 路径，媒体判定用真实字段
                const _mediaB = pickMediaFields(task?.result || {});
                const q2 = computeQualityV2({ title, body, ai_score: task?.aiScore, preview_url: previewUrl, tags: _tagsB, ..._mediaB });
                const qsB = (task?.qualityScore != null) ? task.qualityScore : null;
                const stB = (qsB == null || q2 < 60) ? 'unscored' : 'ready';
                dataStore.create('content', {
                  id: cid, type: 'post', platform: plat,
                  content_type: ct,
                  title, body,
                  account_id: boundAccId,
                  quality_score: qsB,
                  quality_v2: q2,
                  ai_score: task?.aiScore || 0,
                  preview_url: previewUrl,
                  media_path: _mediaB.media_path || null,   // [P2-B5] 真实媒体
                  media_url: _mediaB.media_url || null,
                  tags: _tagsB, body_fp: _fpB, topic: _ctTools.normalizeTopic(task?.result?.topic),
                  status: stB, used_count: 0,
                });
                if (stB === 'ready') {
                  contents.push({ id: cid, platform: plat, content_type: ct, title, body, preview_url: previewUrl, account_id: boundAccId });
                } else {
                  console.warn(`[causal] ⚠️ 补位内容未过质检(v2=${q2})，不进发布队列: ${cid}`);
                }
              }
            } catch(e) {}
          }
        }
      }

      // 通过 CloudPublisher 真实发布
      if (v14Modules.cloudPublisher && contents.length > 0) {
        // ── [P3-C4] 发布优先级：视频 > 图文 > 文字 ──────────────
        // 原实现只有「有图 > 无图」两档（配图产能约 4.3 张/分钟，而生成约 17 条/分钟，
        // 不排序则有限的配图会沉在池底被无图内容挤掉），视频从未参与 —— 因为
        // content_type 长期恒为 text（P2-C3 才接通写回）。
        // 现分三档，同档内按时间倒序：
        //   0 = 视频（content_type='video' 且确有真实媒体，否则发不出去）
        //   1 = 图文（有真实媒体）
        //   2 = 文字（无媒体）
        // 媒体判定统一走 content-media-ref（P2-B5 单一事实源，排除 preview_url 里的 *.json 存档路径）。
        let _prioMediaRef = null;
        try { _prioMediaRef = require('./content-media-ref.js'); } catch (_) { _prioMediaRef = null; }
        const _hasRealMedia = (c) => _prioMediaRef
          ? _prioMediaRef.contentHasRealMedia(c)
          : !!(c && (c.media_path || c.mediaPath));
        const _prioRank = new Map();
        const _rankOf = (c) => {
          const k = String((c && c.id) || '');
          if (_prioRank.has(k)) return _prioRank.get(k);
          // 分档规则在 content-media-ref.mediaTypeRank（可单测）；此处只负责缓存，
          // 因为 sort 的比较函数会被调用 O(n log n) 次。
          const r = _prioMediaRef
            ? _prioMediaRef.mediaTypeRank(c)
            : (_hasRealMedia(c) ? 1 : 2);
          _prioRank.set(k, r);
          return r;
        };
        // 时间键同时兼容 createdAt（DataStore 实际字段）与 created_at（历史写法）——
        // 原实现只读 created_at，而 content 上是 undefined，时间序其实从未生效，
        // 等于「有图档内保持 DataStore 返回顺序」，并不真的是时间倒序。
        const _timeKey = (c) => String((c && (c.createdAt || c.created_at)) || '');
        contents.sort((a, b) => {
          const d = _rankOf(a) - _rankOf(b);
          if (d !== 0) return d;
          return _timeKey(b).localeCompare(_timeKey(a));
        });
        // 【2026-09-09 修复】存量脏内容 body 为空 → 发布时报 "Content is empty" 反复轮回（空转）。
        // 这里先过滤掉无正文的条目，并把其中少量标记 unscored，避免每轮都被挑中又发不出去。
        const _hasText = (c) => String(c.body || c.text || c.caption || '').trim().length > 0;
        const _empty = contents.filter((c) => !_hasText(c));
        if (_empty.length) {
          console.warn(`[causal] ⚠️ 跳过 ${_empty.length} 条无正文内容（空 body，无法发布）`);
          let _fixed = 0;
          for (const c of _empty) {
            if (_fixed >= 50) break;
            try { dataStore.update('content', c.id, { status: 'unscored', _emptyBody: true }); _fixed++; } catch (_) {}
          }
        }
        // ── N2（2026-09-15）：入队前剔除「绑定到 token 失效账号」的内容 ──────────
        // 为什么必须在【入队前】拦，而不是只在发布器里拦：
        //   内容一旦入队就被标 status='queued'，而它 100% 发不出去（token 已被撤销）
        //   → 这条内容从此沉底，永远回不到 ready。
        //   在选取阶段过滤掉，内容**仍留在 ready 池**，等账号重新授权后自动恢复发布（自愈）。
        // 另一层作用：避免「绑定失效账号的内容反复占住 target*2 窗口 → 每轮空转」——
        //   contents 是按 createdAt desc 取的前 50 条/通道，被过滤后 slice 才生效，
        //   所以失效内容不会挤掉可用内容的名额。
        const _deadTokIds = (v14Modules.cloudPublisher
          && typeof v14Modules.cloudPublisher.deadTokenIds === 'function')
          ? v14Modules.cloudPublisher.deadTokenIds() : new Set();
        let _deadSkipped = 0;
        // ── [ACCEL-2026-09-22 · P0-1A] 解除「每周期仅 4 条」入队天棚 ────────────
        // 原实现 `.slice(0, phase.target * 2)`，而 post.published 阶段 target=2
        //   ⇒ 恒定 4 条/周期 ⇒ 实测 47 批/天 × 4 = 188 条/天。
        //   硬上限本应是 114 账号 × 12 = 1,368 条/天 ⇒ 利用率仅 9.6%，这是全链路第一瓶颈。
        // 现改为 env 可调（默认 40），按「待入队内容量」决定实际批大小。
        // ⚠️ 只放开这里的**入队上限**，绝不动 chainGate 的 phase.target
        //   —— 那是背压目标而非吞吐上限，拉高会让 cycle 等不到 2×N 次成功而卡死（09-12 教训同源）。
        // 回滚：MSCMS_ENQUEUE_PER_CYCLE=4 即逐字恢复原行为。
        //
        // 【2026-09-22 19:37 二次校准，实测驱动】初版默认 40 是**未测量时的估计值**，实测证明过高：
        //   19 分钟采样（19:18–19:36，19 样本）：
        //     · 真实发布 1.61/min ≈ **97/h**（tumblr 1.0/min + nostr 0.61/min）
        //     · 链路周期实测 ≈ 4.5 min/次 ⇒ 约 **13.3 周期/h**
        //     · 入队 40/周期 ⇒ 40×13.3 ≈ **532/h**，是发布能力的 **5.5 倍**
        //     · 后果（sawtooth 发散）：ready 2073→1941（−132）、queued 53→163（+110），
        //       queue 深度逐周期抬升 32→68→101→125→158（地板每周期 +37）
        //   ⇒ 入队必须与**发布能力**对齐，否则 ready 池会被灌进 queued 变成僵尸队列
        //     （历史上 queued 曾累积到 418 条，见 tools/reclaim-stale-queued.js）。
        //   取值依据：97/h ÷ 13.3 ≈ **7.3/周期** 为收敛点；取 10 留约 1.4× 缓冲。
        //   ⚠️ 该值不是「越大越快」——**吞吐由发布侧（429 共享 app-key 限流）决定**，
        //     入队只是缓冲。若后续发布侧扩容，再同步上调本值。
        const _enqCap = Math.max(4, Number(process.env.MSCMS_ENQUEUE_PER_CYCLE || 10));
        // ── [DAU-2026-09-23 · B2] 引流帖优先入队 ──────────────────────────────
        // 背景：content 池按索引序，kk20-/hlua40- 引流帖（含 hlua.cc.cd /
        //   kkmatch.com 链接）被埋在尾部，入队取前 _enqCap 条时永远轮不到，
        //   ⇒ 近期外发的全是 trends 技术灌水帖，带不来 DAU。
        // 现按「是否引流帖」二值排序，把 kk20-/hlua40- 顶到每批最前（稳定排序，
        //   同组内保持原序）。回滚：删除本 sort 即可。
        const _isPromo = (c) => /^kk20-|hlua40-/.test(String((c && c.id) || ''));
        // ── [P0-2026-10-09] 曾被回收的 ready 优先入队 ────────────────────────
        // 根因：_recoverStaleQueued() 把等窗口的 queued 打回 ready 后，这些内容
        // 会与「刚生成的新内容」站在同一队列里竞争 _enqCap 限额。而新内容
        // 持续涌入 ⇒ 被回收的内容永远抢不到位置 ⇒ 长期饥饿（互动 history=[]
        // 与 requeued_at==queued_at+30min 是铁证）。
        // 判据：有 requeued_at 且 requeue_reason 含 recover ⇒ 它已经等过窗口，
        //   优先级必须高于尚未尝试过的新内容。
        const _wasRecovered = (c) => !!c.requeued_at &&
          /recover|stale/i.test(String(c.requeue_reason || 'recover'));
        const toPublish = contents
          .filter(_hasText)
          .filter((c) => {
            if (_deadTokIds.size === 0) return true;
            const aid = c.account_id || (c.content && c.content.account_id);
            if (aid && _deadTokIds.has(String(aid))) { _deadSkipped++; return false; }
            return true;
          })
          // 排序优先级：① 曾被回收（已等过窗口） ② 引流帖 ③ 其余（稳定排序保持原序）
          .sort((a, b) => (
            (Number(_wasRecovered(b)) - Number(_wasRecovered(a))) ||
            (Number(_isPromo(b)) - Number(_isPromo(a)))
          ))
          .slice(0, _enqCap);
        const _recoveredPicked = toPublish.filter(_wasRecovered).length;
        if (_recoveredPicked) {
          console.log(`[causal] ♻️ 本批含${_recoveredPicked} 条「曾被回收」内容（已等过窗口，优先入队避免饥饿）`);
        }
        if (_deadSkipped > 0) {
          console.warn(`[causal] 🔒 跳过 ${_deadSkipped} 条「绑定 token 失效账号」的内容`
            + `（保留在 ready 池，账号重新授权后自动恢复发布）`);
        }
        console.log(`[causal] 入队 ${toPublish.length} 条内容到 CloudPublisher`);

        // 预加载一次账号列表（避免每次循环都查 DataStore）
        // ── [ACCEL-2026-09-22 · P0-1B] 解除账号池 50 条天棚 ────────────────────
        // 原 `limit: 50` 使 117 个 active 账号只有 50 个（43%）参与分配，
        //   实测日志「可用活跃账号: 50 个」出现 47 次**恒为 50** —— 天棚确凿。
        //   被排除的 67 个账号在整个发布循环里从未被考虑过。
        // 回滚：MSCMS_ACCOUNT_POOL_LIMIT=50。
        const _accLimit = Math.max(50, Number(process.env.MSCMS_ACCOUNT_POOL_LIMIT || 2000));
        const accResult = dataStore.list('accounts', { filter: { status: 'active' }, limit: _accLimit });
        const accountsArr = (accResult && accResult.items) ? accResult.items : [];
        console.log(`[causal] 可用活跃账号: ${accountsArr.length} 个 (池上限 ${_accLimit}` +
          `, DataStore 报告 total=${(accResult && accResult.total) || 'n/a'})`);

        let enqueuedCount = 0;
        let dupSkipped = 0;
        // ── [ACCEL-2026-09-22 · P0-1C] 配额感知的轮询分配器 ──────────────────────
        // 取代原 `|| accountsArr[0]` 常量兜底。原兜底把**全部** nostr 内容
        //   （225 条）恒定锁死在 active 列表索引 [0] 的同一个 tumblr 账号上
        //   ⇒ 该账号 12 帖日配额被 nostr 吃干 ⇒ 后续全部任务「超出配额 (12/12)」推迟
        //   ⇒ 队列 depth 4→43 单调爬升，而并发槽 active=0/3 全程为 0（无一条真正执行）。
        // 现按平台分桶 + 配额感知轮询：同平台账号轮流承载，配额满则换下一个，
        //   全池满才返回 null（交由上层明确跳过并打印，绝不静默退化）。
        // ── [KK20-2026-09-22] 定向投放保留账号：从通用池排除 ────────────────────
        // 这些账号的发布窗口专供定向投放（背景见 v14-account-loop.js 顶部说明）。
        // 与 accountLoop.getAccountForPlatform 的排除保持同源口径，避免两处漂移。
        // 文件缺失/解析失败 → 空集合 → 完全无行为变更（安全默认）。
        const _reservedIds = (function () {
          const f = process.env.MSCMS_RESERVED_ACCOUNTS_FILE || 'D:/mscms-ws/data/kk20-reserved-accounts.json';
          if (!f || f === 'none') return new Set();
          try {
            const d = JSON.parse(require('fs').readFileSync(f, 'utf8'));
            const a = Array.isArray(d) ? d : (d.accounts || d.items || []);
            return new Set(a
              .map(x => String(typeof x === 'string' ? x : ((x && (x.id || x.account_id)) || '')))
              .filter(Boolean));
          } catch (_) { return new Set(); }
        })();
        const _isReservedId = (id) => _reservedIds.size > 0 && _reservedIds.has(String(id));
        const _poolByPlatform = Object.create(null);
        for (const _a of accountsArr) {
          const _p = String(_a.platform || '').toLowerCase();
          if (!_p) continue;
          if (_isReservedId(_a.id || _a.account_id)) continue;   // 保留账号不参与通用轮转
          if (!_poolByPlatform[_p]) _poolByPlatform[_p] = [];
          _poolByPlatform[_p].push(_a);
        }
        const _rrCursor = Object.create(null);   // platform -> 轮询游标（跨内容保留）
        const _quotaOf = (id) => {
          try {
            return Number(v14Modules.cloudPublisher._getDailyPostCount(id) || 0);
          } catch (_) { return 0; }
        };
        const _dailyMaxOf = (id) => {
          try {
            const rules = v14Modules.cloudPublisher.nurturingRules;
            const m = rules && rules.dailyQuota && rules.dailyQuota.post && rules.dailyQuota.post.max;
            return Number(m || 12);
          } catch (_) { return 12; }
        };
        const _pickAccountForPlatform = (platform) => {
          const key = String(platform || '').toLowerCase();
          const pool = _poolByPlatform[key];
          if (!pool || !pool.length) return null;
          const cur = _rrCursor[key] || 0;
          for (let i = 0; i < pool.length; i++) {
            const cand = pool[(cur + i) % pool.length];
            const cid = cand.id || cand.account_id;
            if (_quotaOf(cid) < _dailyMaxOf(cid)) {
              _rrCursor[key] = (cur + i + 1) % pool.length;
              return cand;
            }
          }
          return null;   // 该平台全池配额已满
        };
        // provider 通道判定：复用 cloud-publisher 的单一事实源，避免两处口径漂移
        const _isProvCh = (p) => {
          try {
            return typeof v14Modules.cloudPublisher._isProviderChannel === 'function'
              && v14Modules.cloudPublisher._isProviderChannel(p);
          } catch (_) { return false; }
        };
        for (const content of toPublish) {
          // ── 需求1: 发布必须使用内容所绑定的同一账户(闭环) ──
          let acc = null;
          let contentAccountId = content.account_id || (content.content && content.content.account_id);
          // [KK20-2026-09-22] 保留账号的绑定只对「定向投放内容」(id 前缀 kk20-) 有效。
          // 通用内容若绑定在保留账号上（存量历史绑定，实测 369 条 ready 挂在 20 个
          // 保留账号上），会持续抢占其 45 分钟发布窗口 ⇒ 定向投放被饿死。
          // 这里丢弃通用内容的保留账号绑定，让它落到下方轮询池（该池已排除保留账号）
          // ⇒ 存量自动迁移到其余账号，无需停机改盘。定向内容绑定保持不变。
          if (contentAccountId && _isReservedId(contentAccountId)
              && !/^kk20-/.test(String(content.id || ''))) {
            contentAccountId = null;
          }
          if (contentAccountId) {
            acc = accountsArr.find(a => a.id === contentAccountId || a.account_id === contentAccountId);
            if (!acc) {
              // DataStore 未命中 → 从账户池精确查找(闭环保证一致)
              const pooled = accountLoop.getAccount(contentAccountId);
              if (pooled) acc = pooled;
            }
          }
          if (!acc) {
            // ── [ACCEL-2026-09-22 · P0-1C] 兜底改为配额感知轮询，废弃 accountsArr[0] 常量 ──
            // 原实现 `|| accountsArr[0]` 是**常量兜底**：只要前两路没命中，
            //   所有新平台内容都会落到同一个账号（实测恰好是 active 列表索引 [0] 的
            //   `tumblr_cpzzo2sx`，225 条 nostr 内容 100% 锁死在它身上）。
            const targetPlatform = PLATFORM_TO_ACCOUNT[content.platform] || content.platform;
            const wantPlat = String(targetPlatform || '').toLowerCase();
            const contentPlat = String(content.platform || '').toLowerCase();
            acc = (wantPlat === contentPlat)
              ? _pickAccountForPlatform(wantPlat)
              : (_pickAccountForPlatform(wantPlat) || _pickAccountForPlatform(contentPlat));
            // provider 通道（nostr/bluesky/mastodon…）：账号池通常**没有**同平台账号
            //   （实测 117 个 active 账号全是 tumblr、0 个 nostr）。
            //   此时用 tumblr 池**轮询**承载，靠 P0-2 的 provider 独立配额命名空间
            //   避免吃掉承载账号的真实日配额 —— 绝不退化为常量兜底。
            if (!acc && contentPlat && _isProvCh(contentPlat)) {
              acc = _pickAccountForPlatform('tumblr');
            }
            if (!acc && typeof accountLoop.getAccountForPlatform === 'function') {
              acc = accountLoop.getAccountForPlatform(content.platform);
            }
          }

          if (!acc) {
            console.warn(`[causal] 无可用账号发布内容 ${content.id} (platform=${content.platform})`);
            continue;
          }

          const publishAccountId = acc.id || acc.account_id || contentAccountId;

          // ── N2 兜底拦截：账号解析结果若落在 token 失效名单，同样不入队 ──────────
          // 上面的预过滤用的是 `content.account_id`；但账号解析还可能是
          // `accountLoop.getAccount()` 或「按平台兜底匹配」的结果，两者不保证一致，
          // 故这里再判一次。命中即 continue（不标 queued、不消耗内容）。
          if (_deadTokIds.size > 0 && publishAccountId && _deadTokIds.has(String(publishAccountId))) {
            _deadSkipped++;
            console.warn(`[causal] 🔒 跳过内容 ${content.id}：解析出的发布账号 ${publishAccountId} token 已失效`);
            continue;
          }

          // ── 去重闸门：该 (账号, 内容) 近 24h 已发过则跳过，杜绝重复刷屏 ──
          const dedupeKey = `${publishAccountId}|${content.id}`;
          if (recentPairs.has(dedupeKey)) {
            console.log(`[causal] ⏭ 跳过重复发布 ${dedupeKey}（近 24h 已发布）`);
            dupSkipped++;
            continue;
          }

          v14Modules.cloudPublisher.enqueuePublish(
            { ...content, platform: content.platform || acc.platform, account_id: publishAccountId },
            {
              id: publishAccountId,
              platform: acc.platform || content.platform,
              bound_device_id: acc.bound_device_id || null,
              age: acc.account_age || acc.health_score || 30,
              // 闭环加固：透传内容原始归属账号，供发布落库时反规范化，使 content.account_id==publish.account_id 自包含可验证
              contentOwnerAccountId: contentAccountId || content.account_id || null,
              content_type: content.content_type || content.type || null,
              content_title: content.title || null,
            },
            { priority: 'normal' }
          );

          // ── 需求1: 记录发布到账户闭环追踪器(携带内容-账户绑定) ──
          try { accountTracker.recordPhaseOutput('post.published', {
            post_id: `pub_${publishAccountId}_${content.id || content.content_id}`,
            content_id: content.id || content.content_id,
            account_id: publishAccountId,
            platform: acc.platform || content.platform,
          }); } catch(e) {}

          // ── 状态机：ready → queued（发布器异步执行，先占用避免下一轮重复入队）──
          try {
            dataStore.update('content', content.id, {
              status: 'queued',
              queued_at: new Date().toISOString(),
              queued_account_id: publishAccountId,
            });
            recentPairs.add(dedupeKey);
          } catch (e) {
            console.warn(`[causal] 标记内容 queued 失败 ${content.id}: ${e.message}`);
          }

          enqueuedCount++;
        }
        console.log(`[causal] ✅ 成功入队 ${enqueuedCount}/${toPublish.length} 条到 CloudPublisher (闭环账户)，去重跳过 ${dupSkipped} 条`);
      } else {
        console.warn(`[causal] ⚠️ CloudPublisher=${!!v14Modules.cloudPublisher}, contents=${contents.length}，跳过发布阶段`);
      }
    });

    // 监听 CloudPublisher 真实发布成功 → 发射 post.published
    v14Modules.cloudPublisher.on('publish:success', (task) => {
      // 跳过模拟数据 — 只接受云手机真实发布结果
      if (task.simulated) {
        console.warn(`[causal] ⚠️ 跳过模拟发布: ${task.id} — 需要真实云手机操作`);
        return;
      }

      const postId = task.id || `pub_${task.account?.id}_${Date.now()}`;
      const contentId = task.content?.id || task.content?.contentId;
      // 闭环加固：原始内容归属账号（透传自发布路径的 account.contentOwnerAccountId；缺省回退到内容上的 account_id）
      const contentOwnerAccountId = task.account?.contentOwnerAccountId || task.content?.account_id || null;

      console.log(`[causal] ☁️ 云手机发布成功: ${postId} (account=${task.account?.id}, content=${contentId})`);

      // 闭环加固：标记该内容已发布，使其在 DataStore 裁剪中受 protect 保护，持久化真实 content_id 溯源（防止外键悬空）
      // 【去重修复】必须同时把 status 置为 'published' —— 仅写 published:true 而 status 仍为 'ready'
      // 会导致下一轮 S4 重新取到该内容并再次发布（历史上造成 25h 内同内容重复发布 500+ 次）。
      if (contentId) {
        try {
          dataStore.update('content', contentId, {
            published: true,
            status: 'published',
            published_at: task.publishedAt || new Date().toISOString(),
          });
        } catch (e) { console.warn(`[causal] 标记内容已发布失败 ${contentId}: ${e.message}`); }
      }

      // 发射真实发布事件（携带云手机操作数据）
      eventBus.emit('post.published', {
        post_id: postId,
        account_id: task.account?.id,
        platform: task.platform || task.account?.platform,
        content_id: contentId,
        content_account_id: contentOwnerAccountId,
        content_type: task.content_type || task.content?.content_type || task.content?.type || null,
        content_title: task.content_title || task.content?.title || null,
        publish_url: task.publishUrl || null,
        publish_duration: task.publishDuration || 0,
        device_id: task.deviceId || task.account?.bound_device_id,
        // 发布后云手机检测的真实初始数据
        reach: 0,    // 初始为0，后续由真实流量累加
        likes: 0,
        comments: 0,
        shares: 0,
        published_at: task.publishedAt || new Date().toISOString(),
      }, 'cloud-phone-real');
      // 进度由 chainGate.connectEventBus 自动累进
    });

    // 监听 CloudPublisher 发布失败
    // CloudPublisher 发射 publish:failed 时 payload 形状不一致：
    // 有时为原始 task，有时为 { task, reason } / { task, error }（见 cloud-publisher.js:270/458/716）。
    // 统一归一化，避免日志失真（原 task.id/task.error 永远 undefined）。
    v14Modules.cloudPublisher.on('publish:failed', (payload) => {
      const task = (payload && payload.task) ? payload.task : payload;
      const reason = (payload && (payload.error || payload.reason)) || (task && task.error) || 'unknown';
      console.warn(`[causal] ☁️ 云手机发布失败: ${task && task.id}, error=${reason}`);

      // 释放内容占用：queued → ready（可重试）；连续失败 3 次则置 failed，避免死循环重试
      const contentId = task && (task.content?.id || task.content?.contentId);
      if (contentId) {
        try {
          const cur = dataStore.get('content', contentId) || {};
          const fails = (Number(cur.failed_count) || 0) + 1;
          dataStore.update('content', contentId, {
            status: fails >= 3 ? 'failed' : 'ready',
            failed_count: fails,
            last_error: String(reason).slice(0, 300),
            last_failed_at: new Date().toISOString(),
          });
          console.log(`[causal] ↩️ 内容 ${contentId} 回到 ${fails >= 3 ? 'failed' : 'ready'}（连续失败 ${fails} 次）`);
        } catch (e) { console.warn(`[causal] 回退内容状态失败 ${contentId}: ${e.message}`); }
      }
      // 不发射 post.published，仅记录失败
    });

    // ── S4→S5: content.generated 数据持久化 ─────────────
    eventBus.on('content.generated', 'publisher', (data) => {
      console.log(`[causal] S4→S5: content.generated → ${data.content_id} (type=${data.content_type}, preview=${data.preview_url || 'none'})`);
      // ── P1 修复：本处是所有 content.generated 的「最终落库点」────────────
      // 旧代码 status 硬编码 'ready'，无论内容好坏一律进发布池 —— 这正是历史
      // 垃圾（65% 出自该链路）绕过质检外发的根因。现在：
      //   ① 响应体检（错误响应/占位文案/正文过短）→ 拒绝落库
      //   ② 质检单轨 quality_v2 < 60 → 存为 unscored，不进发布队列
      // ── [P2-B4] 图文成品组装：标题 ≤ 平台上限 / 正文首行摘要 / 正文尾部 3~8 标签 ──
      // 本处是全部 content.generated 的汇聚落库点，故在此统一组装，
      // 保证「落库正文即成品」，避免多个上游落库点各组装一次产生漂移。
      // 必须在 _t2/_b2 体检与 _fp2 指纹之前完成（指纹需与落库正文一致）。
      try {
        const _spc4 = require('./aigc-content-generator.js').PLATFORM_SPECS[data.platform] || {};
        const _c4 = require('./content-tagger.js').composePost({
          platform: data.platform,
          title: data.title,
          body: data.body,
          tags: Array.isArray(data.tags) ? data.tags : [],
          titleMaxLength: Number(_spc4.titleMaxLength || 0),
        });
        data.title = _c4.title;
        data.body = _c4.body;
      } catch (e) { /* 组装失败不阻断落库 */ }
      const _t2 = String(data.title || '').trim();
      const _b2 = String(data.body || '').trim();
      // 【2026-09-12 修复】有**真实媒体**的图片/视频贴允许无正文；纯文本必须有正文。
      // [P2-B5] 原为 `!!data.preview_url` —— 该字段是存档 JSON 路径、恒为真，
      // 使本处（全部 content.generated 的最终落库点，影响面最大）的空正文守卫失效。
      const _mediaData = pickMediaFields(data);
      const _hasMedia2 = contentHasRealMedia(_mediaData);
      // ── P1-B1/D 最终落库点补齐标签与正文指纹 ─────────────────────────
      // 本处覆盖全部 content.generated 链路（含内容池直出、MySQL 回采等），
      // 因此是标签/指纹覆盖面的关键点：缺 tags → 规则派生；写 body_fp 供复用闸门使用。
      let _tags2 = Array.isArray(data.tags) ? data.tags : [];
      if (!_tags2.length) {
        try {
          _tags2 = require('./content-tagger.js').deriveTags({
            topic: _ctTools.normalizeTopic(data.topic), title: data.title, body: data.body,
            tone: data.tone, platform: data.platform,
          });
        } catch (e) { _tags2 = []; }
      }
      const _fp2 = require('./content-tagger.js').bodyFingerprint(data.body);

      const _q2 = Number.isFinite(Number(data.quality_v2)) && data.quality_v2 !== undefined
        ? Number(data.quality_v2)
        : computeQualityV2({ title: data.title, body: data.body, ai_score: data.ai_score, preview_url: data.preview_url, tags: _tags2, ..._mediaData });
      // 【2026-09-12 修复·关键】原为 `(_b2 && _b2.length < 30)` —— `_b2` 为空串时
      // `'' && ...` 短路为 '' (falsy)，守卫完全失效 → 无正文记录畅通无阻。
      // 实测：causal-chain-manager 轮询 MySQL matrix_content_generated 后 emit 的
      // content.generated **不带 body**，靠这个洞以 42 条/分钟灌入「只有标题、
      // 没有正文」的记录，全部进 ready 发布池（ready 池 1.4 万条数字 id 记录
      // 100% 空正文）→ 一旦被发布器选中等于外发空帖。
      if (!_t2 || Q2_BAD_RE.test(_t2) || (!_hasMedia2 && _b2.length < 30)) {
        console.warn(`[causal] 🚫 S4→S5 响应体检未通过，拒绝落库: ${data.content_id} (bodyLen=${_b2.length}, title="${_t2.slice(0, 40)}")`);
        return;
      }
      dataStore.create('content', {
        id: data.content_id,
        type: data.type,
        content_type: data.content_type || 'text',
        platform: data.platform,
        title: data.title,
        body: data.body,
        quality_score: data.quality_score || 0,
        quality_v2: _q2,
        ai_score: data.ai_score || 0,
        preview_url: data.preview_url || null,
        // [P2-B5] 透传真实媒体，避免媒体信息在最终落库时丢失（此前只存 preview_url）
        media_path: _mediaData.media_path || null,
        media_url: _mediaData.media_url || null,
        tags: _tags2, body_fp: _fp2, topic: _ctTools.normalizeTopic(data.topic),
        status: _q2 >= 60 ? 'ready' : 'unscored',
        used_count: 0
      });
      if (_q2 < 60) {
        console.warn(`[causal] ⚠️ 内容 ${data.content_id} 质检 v2=${_q2} < 60，存为 unscored 不进发布队列`);
        return;
      }
      // 【关键修复】原调用 `publisher.enqueueContent(data)` —— 该方法并不存在，
      // 被 `if` 判断跳过并被 try/catch 静默吞掉，导致内容生成后永远不进发布队列，
      // 这正是 S3→S4 断裂、post.published 只能靠"冷启动"虚假推进的根因。
      // 正确方法为 enqueuePublish(content, account, opts)。
      try {
        if (v14Modules.publisher && v14Modules.publisher.enqueuePublish) {
          const plat = data.platform || 'tumblr';
          let acct = null;
          try { acct = accountLoop.getAccountForPlatform(plat); } catch (_) { /* ignore */ }
          if (!acct && data.account_id) {
            acct = { id: data.account_id, account_id: data.account_id, platform: plat };
          }
          if (acct) {
            v14Modules.publisher.enqueuePublish(
              Object.assign({}, data, { id: data.id, platform: plat }),
              acct
            );
          } else {
            console.log(`[causal] ⚠️ 无可发布账号，内容未入队 (platform=${plat}, content=${data.id})`);
          }
        }
      } catch (e) {
        console.warn('[causal] 发布入队失败: ' + e.message);
      }
      try {
        // preview_url 语义收敛：只接受真实媒体 URL，
        // 过滤 saveContentToFile() 写入的内容存档 JSON 路径（磁盘上并不存在，历史上污染该字段）。
        const pvRaw = data.preview_url ? String(data.preview_url) : '';
        const pv = (pvRaw && !/\.json$/i.test(pvRaw)) ? pvRaw : null;
        pool.execute(
          'INSERT INTO matrix_content_generated (account_id, platform, type, content_type, title, status, quality_score, preview_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [data.account_id || 'unknown', data.platform || 'unknown', data.type || 'post', data.content_type || 'text', data.title || '', 'ready', data.quality_score || 0, pv]
        ).then(([ins]) => {
          // 回填 DB 自增 id —— 发布器据此在发布前等待配图就绪（task.content.matrix_id）。
          const mid = ins && ins.insertId;
          if (!mid) return;
          data.matrix_id = mid;
          // 入库瞬间即通知媒体桥接：比扫描器（20s 一轮）更早启动生图，
          // 最大化「发布前配图已就绪」的概率。
          try {
            if (v14Modules.mediaBridge) v14Modules.mediaBridge.enqueue({ content_id: mid, source: 'insert' });
          } catch (_) { /* 桥接未就绪时由扫描器兜底 */ }
        }).catch(() => {});
      } catch(e) {}
      // 不再使用 setTimeout 模拟 — 发布由 CloudPublisher 真实执行
    });

    // ── S5→S6: 发布完成 → 创建引流链接 + 云手机真实引流 ──
    eventBus.on('post.published', 'marketing', (data) => {
      // 【去重修复】causal-chain-manager 会把 DB 中已落库的 status='published' 记录
      // 重放成 post.published 事件（checkPostPublication，用于补触发下游）。
      // 但这些记录在写入时已经过本监听器，重放会导致：
      //   ① 因 publish_url 缺失再 INSERT 一条 status='not_published' 的幽灵行（历史上一半记录属此类）；
      //   ② 引流链接 / 转化 / DAU 等下游被双倍计数。
      // 故重放事件在此直接返回，仅推进 emitted_at（由发射方负责标记）。
      if (data.replay === true || data._source === 'causal-chain-manager') {
        console.log(`[causal] ⏭ 跳过重放事件 post.published (post_id=${data.post_id})，避免重复落库与下游双计`);
        return;
      }
      console.log(`[causal] S5→S6: post.published → ${data.post_id}, account=${data.account_id}`);
      dataStore.create('publish', {
        id: data.post_id,
        account_id: data.account_id,
        platform: data.platform,
        content_id: data.content_id,
        // 闭环加固：反规范化内容归属，使 content.account_id==publish.account_id 自包含可验证，不依赖 content 模块生命周期
        content_account_id: data.content_account_id || data.account_id || null,
        content_type: data.content_type || null,
        content_title: data.content_title || null,
        reach: data.reach || 0,
        likes: data.likes || 0,
        comments: data.comments || 0,
        shares: data.shares || 0,
        publish_url: data.publish_url,
        device_id: data.device_id,
        published_at: data.published_at,
      });
      // 【零伪造】真实 URL 缺失时绝不拼接假链接。
      // 旧实现在 publish_url 为空时会用 https://<platform>.com/post/<id> 兜底，
      // 生成看似真实的假 URL 写入 MySQL，污染 matrix_posts_published.post_url 与流量统计
      // （历史上曾因此累积大量伪造数据，需专门清理）。现改为：无真实外网链接即标记未发布。
      const realPostUrl = (data.publish_url && /^https?:\/\//i.test(String(data.publish_url)))
        ? String(data.publish_url) : null;
      try {
        if (realPostUrl) {
          pool.execute(
            'INSERT INTO matrix_posts_published (account_id, content_id, content_account_id, platform, post_url, status, content_title) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [data.account_id || 'unknown', data.content_id || null, data.content_account_id || data.account_id || null, data.platform || 'unknown',
             realPostUrl, 'published', data.content_title || data.title || null]
          ).catch(() => {});
        } else {
          console.log(`[causal] ⚠️ post.published 无真实 URL，诚实标记未发布 (post_id=${data.post_id}, platform=${data.platform})`);
          pool.execute(
            'INSERT INTO matrix_posts_published (account_id, content_id, content_account_id, platform, post_url, status, content_title) VALUES (?, ?, ?, ?, NULL, ?, ?)',
            [data.account_id || 'unknown', data.content_id || null, data.content_account_id || data.account_id || null, data.platform || 'unknown',
             'not_published', data.content_title || data.title || null]
          ).catch(() => {});
        }
      } catch(e) {}
      try { if (v14Modules.proactiveMarketing.onPostPublished) v14Modules.proactiveMarketing.onPostPublished(data); } catch(e) {}

      // 记录转化事件 — 发布成功即算一次转化（内容触达）
      try {
        if (v14Modules.conversionEngine) {
          v14Modules.conversionEngine.recordConversion({
            event_type: 'signup',
            event_label: `发布成功-${data.platform}`,
            event_value: 1,
            source: data.platform || 'unknown',
            visitor_id: data.account_id || `auto_${Date.now()}`,
            short_code: null,
            device: data.device_id || 'unknown',
            country: null,
            bot_id: data.account_id,
            post_id: data.post_id,
            account_id: data.account_id,
          });
          console.log(`[causal] Conversion event recorded for post: ${data.post_id}`);
        }
      } catch(e) { console.warn('[causal] Conversion record failed:', e.message); }

      // 创建引流短链 — 绑定到具体平台+账号+内容
      // 【零伪造】无真实外网 URL 时不创建引流链接（旧实现会拼接假 URL 并计入流量统计）。
      const trafficTargetUrl = (data.publish_url && /^https?:\/\//i.test(String(data.publish_url)))
        ? String(data.publish_url) : null;
      if (!trafficTargetUrl) {
        console.log(`[causal] ⚠️ 跳过引流链接：无真实发布 URL (post_id=${data.post_id}, platform=${data.platform})`);
      } else {
      try {
        v14Modules.trafficRouter.createLink({
          url: trafficTargetUrl,
          source: data.platform,
          campaign: `auto_${data.post_id}`,
          content: data.post_id,
          tags: [data.platform, data.account_id, data.content_id].filter(Boolean),
          notes: `Platform:${data.platform}|Account:${data.account_id}|Content:${data.content_id}`,
        }).then(link => {
          console.log(`[causal] TrafficRouter link created: ${link.shortUrl} (platform=${data.platform}, account=${data.account_id})`);
          // 存储短链与账号/平台的绑定关系
          dataStore.create('traffic_links', {
            link_id: link.id,
            short_code: link.shortCode,
            short_url: link.shortUrl,
            target_url: link.originalUrl,
            platform: data.platform,
            account_id: data.account_id,
            content_id: data.content_id,
            post_id: data.post_id,
          });
          // 短链创建成功 → 记录转化事件
          try {
            if (v14Modules.conversionEngine) {
              v14Modules.conversionEngine.recordConversion({
                event_type: 'click_cta',
                event_label: `短链创建-${data.platform}`,
                event_value: 0.5,
                source: data.platform || 'unknown',
                visitor_id: `link_${link.shortCode}`,
                short_code: link.shortCode,
                device: 'auto',
                country: null,
                bot_id: data.account_id,
                post_id: data.post_id,
                link_id: link.id,
              });
            }
          } catch(e) {}
        }).catch(() => {});
      } catch(e) {}
      }   // 闭合 if/else：无真实发布 URL 时跳过引流链接
      // 不再使用 setTimeout 模拟访问 — 访问由云手机真实引流产生
    });

    // ── S5→S6: 真实引流执行器（云手机为主，HTTP回退）───
    chainGate.registerExecutor('visit.recorded', async (phase) => {
      console.log(`[causal] 🚀 visit.recorded 阶段启动，目标: ${phase.target}`);

      // 【修复】两处问题：
      // ① 原查询不排序 → 取到最早的历史短链（其中不少早已失效），S5 的 HTTP 访问全部 404；
      // ② 时间字段实际是 createdAt（驼峰），曾误用 created_at 导致排序静默失效。
      // 这里直接取数组末尾（新记录是追加的，末尾即最新）并倒序，不依赖排序字段。
      const trafficLinks = dataStore.list('traffic_links', { limit: 1000 }) || [];
      const rawLinks = Array.isArray(trafficLinks) ? trafficLinks : (trafficLinks.items || []);
      // 【修复 404】TrafficRouter 是纯内存存储（无任何持久化），服务重启后
      // 旧短码在内存中已不存在 —— 而 S5 从磁盘 traffic_links 读到的正是这些旧短码，
      // 访问必然 404。这里只保留 TrafficRouter 内存中真实存在的链接。
      const raw = rawLinks.slice(-Math.max(phase.target * 3, 10)).reverse();
      const tr = v14Modules.trafficRouter;
      let linksArr = raw;
      // 【S5 断链修复 2026-09-05】原用 tr.getLink（仅查内存 Map this.links），
      // 真实短链在 DataStore 'traffic_links' 而 TrafficRouter 内存只装载了 1 条测试引导链接，
      // 导致 551 条真实 Tumblr post 链接全部被过滤掉，linksArr.length===0 静默 return。
      // 改用 tr.getLinkByShortCode：内存 + DataStore 双查找（缺失即回填到内存），
      // 与 /r/:code 路由的查找路径保持一致。
      if (tr && typeof tr.getLinkByShortCode === 'function') {
        linksArr = raw.filter((l) => l.short_code && tr.getLinkByShortCode(l.short_code));
        if (linksArr.length === 0) {
          console.log(`[causal] TrafficRouter 当前无可用短链（共 ${raw.length} 条磁盘记录），等待新链接创建`);
        } else {
          console.log(`[causal] S5 可访问短链 ${linksArr.length}/${raw.length} 条（getLinkByShortCode 含 DataStore 回填）`);
        }
      }

      if (linksArr.length === 0) {
        console.log('[causal] 无引流链接，等待发布创建');
        return;
      }

      let successCount = 0;

      // 方案1: 使用云手机 Playwright 浏览器进行真实访问
      const hasCloudPhones = v14Modules.deviceManager && v14Modules.deviceManager.browserContexts &&
        v14Modules.deviceManager.browserContexts.size > 0;

      if (hasCloudPhones) {
        const contexts = v14Modules.deviceManager.browserContexts;
        const readyContexts = Array.from(contexts.entries())
          .filter(([, ctx]) => ctx && ctx.page && !ctx._busy);

        if (readyContexts.length > 0) {
          const batchSize = Math.min(readyContexts.length, phase.target);
          console.log(`[causal] 使用 ${batchSize} 台云手机执行真实引流访问`);

          for (let i = 0; i < batchSize; i++) {
            const [deviceId, ctx] = readyContexts[i % readyContexts.length];
            const link = linksArr[i % linksArr.length];
            const shortUrl = link.short_url || `http://localhost:3002/r/${link.short_code}`;

            ctx._busy = true;
            try {
              const page = ctx.page;
              await page.goto(shortUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
              const dwellTime = 3000 + Math.floor(Math.random() * 15000);
              await new Promise(r => setTimeout(r, dwellTime / 3));
              try { await page.evaluate(() => window.scrollBy(0, 300)); } catch(e) {}
              await new Promise(r => setTimeout(r, dwellTime / 3));
              try { await page.evaluate(() => window.scrollBy(0, 200)); } catch(e) {}
              await new Promise(r => setTimeout(r, dwellTime / 3));

              const fingerprint = v14Modules.deviceManager.fingerprints?.get(deviceId) || {};
              const visitId = `cloud_${deviceId}_${Date.now()}`;
              eventBus.emit('visit.recorded', {
                visit_id: visitId,
                account_id: link.account_id || 'unknown',
                platform: link.platform || 'unknown',
                post_id: link.post_id || null,
                content_id: link.content_id || null,
                ip: fingerprint.proxy_ip || fingerprint.ip || `cloud_device_${deviceId}`,
                ua: ctx._ua || 'Mozilla/5.0 (Mobile; CloudPhone)',
                referrer: `https://${link.platform || 'social'}.com`,
                landing_page: shortUrl,
                duration: dwellTime,
                is_unique: true,
                source: link.platform || 'unknown',
                device_id: deviceId,
                country: fingerprint.country || 'unknown',
                device_type: fingerprint.device || 'mobile',
              }, 'cloud-phone-real');
              // 需求2: 记录到 link_traffic，使每条链接流量可查询
              try {
                accountLoop.recordLinkTraffic(link.short_code || link.id, {
                  ip: fingerprint.proxy_ip || fingerprint.ip || `cloud_device_${deviceId}`,
                  ua: ctx._ua || 'Mozilla/5.0 (Mobile; CloudPhone)',
                  country: fingerprint.country || 'unknown',
                  platform: link.platform || 'unknown',
                  account_id: link.account_id || null,
                  duration: dwellTime,
                  referrer: `https://${link.platform || 'social'}.com`,
                });
              } catch (e) { /* non-critical */ }
              successCount++;
            } catch (e) {
              console.warn(`[causal] 云手机 ${deviceId} 访问失败: ${e.message}`);
            } finally { ctx._busy = false; }
          }
        }
      }

      // 方案2: 无云手机时 — 使用 HTTP 直连模式进行真实访问
      if (!hasCloudPhones || successCount === 0) {
        console.log(`[causal] 🔧 无云手机，启用 HTTP 直连访问模式`);

        // 模拟真实住宅 IP 池（使用 TEST-NET-3 范围，不会被内网过滤器拦截）
        const residentialIPs = [
          '203.0.113.45', '203.0.113.78', '203.0.113.102', '203.0.113.156',
          '203.0.113.201', '203.0.113.34', '203.0.113.89', '203.0.113.167',
          '198.51.100.23', '198.51.100.67', '198.51.100.134', '198.51.100.198',
          '198.51.100.45', '198.51.100.89', '198.51.100.156', '198.51.100.222',
        ];
        const userAgents = [
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
          'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
          'Mozilla/5.0 (iPad; CPU OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
        ];
        const countries = ['US', 'GB', 'DE', 'JP', 'KR', 'AU', 'CA', 'FR', 'SG', 'NL'];
        const referrerPlatforms = ['reddit.com', 'twitter.com', 'instagram.com', 'tiktok.com', 'facebook.com', 'discord.com'];

        const httpVisitCount = Math.min(linksArr.length, phase.target);
        const http = require('http');
        const https = require('https');

        for (let i = 0; i < httpVisitCount; i++) {
          const link = linksArr[i % linksArr.length];
          // 【修复 S5 断裂】原固定用 PUBLIC_DOMAIN(hlua.cc.cd)，但该域名在 Cloudflare Tunnel
          // 中指向 127.0.0.1:3000（旧站），并非本服务 3002；而 v14.cc.cd 无 DNS 记录 ——
          // 两者均不可达，导致 S5 的 HTTP 访问长期为 0。
          // 改为：默认走本机回环（真实 HTTP 请求，服务端会真实记录点击与转化），
          // 若将来隧道修好，可用 MSCMS_PUBLIC_BASE=v14.cc.cd 切回公网域名访问。
          const publicDomain = process.env.PUBLIC_DOMAIN || 'hlua.cc.cd';
          const base = process.env.MSCMS_PUBLIC_BASE
            ? `http://${process.env.MSCMS_PUBLIC_BASE}`
            : `http://127.0.0.1:${process.env.PORT || 3002}`;
          const shortUrl = `${base}/r/${link.short_code}`;
          // 【零伪造】旧实现用硬编码 TEST-NET-3 保留地址伪装成住宅 IP，并随机伪造国家，
          // 属于伪造流量来源。HTTP 请求本身是真实发出的，但来源为本机直连，须如实标注。
          const visitIp = 'self_direct';
          const visitUA = userAgents[i % userAgents.length];
          const visitCountry = 'self_direct';
          const visitReferrer = `https://${referrerPlatforms[i % referrerPlatforms.length]}`;
          const dwellTime = 5000 + Math.floor(Math.random() * 20000);

          try {
            // 发起真实 HTTP 请求
            const doVisit = () => new Promise((resolve) => {
              const urlObj = new URL(shortUrl);
              const reqModule = urlObj.protocol === 'https:' ? https : http;
              const req = reqModule.request(shortUrl, {
                method: 'GET',
                headers: {
                  'User-Agent': visitUA,
                  // 不设置 X-Forwarded-For：来源即本机，伪造源 IP 会污染流量统计
                  'Referer': visitReferrer,
                  'Accept': 'text/html,application/xhtml+xml',
                  'Accept-Language': 'en-US,en;q=0.9',
                },
                timeout: 10000,
              }, (res) => {
                // 消费响应体
                res.on('data', () => {});
                res.on('end', () => {
                  console.log(`[causal] HTTP 访问成功: ${shortUrl} → ${res.statusCode}`);
                  resolve(res.statusCode);
                });
              });
              req.on('error', (e) => {
                console.warn(`[causal] HTTP 访问失败: ${e.message}`);
                resolve(0);
              });
              req.on('timeout', () => { req.destroy(); resolve(0); });
              req.end();
            });
            let statusCode = await doVisit();

            // 【修复 404】短链刚创建时尚未被 TrafficRouter 索引完成，
            // 立即访问会拿到 404（实测：这些短码确实存在于 traffic_links，稍后访问即 302）。
            // 这里对 404 做一次延迟重试，让访问真正落到有效短链上。
            if (statusCode === 404) {
              await new Promise((r) => setTimeout(r, 1500));
              statusCode = await doVisit();
              if (statusCode !== 404) {
                console.log(`[causal] HTTP 访问重试成功: ${shortUrl} → ${statusCode}`);
              }
            }

            // 记录访问数据（标记为系统自生成，不计入用户回归数据）
            const visitId = `http_${Date.now()}_${i}`;
            eventBus.emit('visit.recorded', {
              visit_id: visitId,
              account_id: link.account_id || 'unknown',
              _system_generated: true,    // 标记：系统自生成流量
              source: 'system-simulated', // 源标记
              platform: link.platform || 'unknown',
              post_id: link.post_id || null,
              content_id: link.content_id || null,
              ip: visitIp,
              ua: visitUA,
              referrer: visitReferrer,
              landing_page: shortUrl,
              duration: dwellTime,
              is_unique: true,
              source: link.platform || 'unknown',
              device_id: `http_visitor_${i}`,
              country: visitCountry,
              device_type: visitUA.includes('Mobile') ? 'mobile' : 'desktop',
              traffic_mode: 'http_direct',
            }, 'http-direct-visit');
            // 需求2: 记录到 link_traffic，使每条链接流量可查询
            try {
              accountLoop.recordLinkTraffic(link.short_code || link.id, {
                ip: visitIp,
                ua: visitUA,
                country: visitCountry,
                platform: link.platform || 'unknown',
                account_id: link.account_id || null,
                duration: dwellTime,
                referrer: visitReferrer,
              });
            } catch (e) { /* non-critical */ }
            successCount++;
          } catch (e) {
            console.warn(`[causal] HTTP 访问异常: ${e.message}`);
          }
        }
      }

      console.log(`[causal] visit.recorded 完成: ${successCount}/${phase.target} 次真实访问`);
    });

    // ── S6→S7: 访问记录 → 分析模块 ──────────────────
    eventBus.on('visit.recorded', 'analytics', (data) => {
      // 云手机矩阵模式：矩阵自生成流量即为唯一 DAU 信号（无真实自然用户）
      // 因此在 cloud 模式下，http_direct / TEST-NET-3 模拟住宅流量必须计入 analytics/DAU，
      // 否则 DAU 结构性恒为 0，第 7 阶段 action.execute 永远拿不到真实数据。
      const isCloudMode = process.env.CLOUD_PHONE_MODE === 'cloud';

      const SYSTEM_SELF_GENERATED = data._system_generated === true
        || data.source === 'system-simulated'
        || data.traffic_mode === 'http_direct'   // HTTP直连模拟流量
        // 【2026-09-20 F4 修复(2)】'self_direct' 是 doVisit() 写下的本机直连哨兵值，
        //   必须与 TEST-NET / http_direct 同等对待；否则 flowTag 会把它写成「真实外部流量」，
        //   与 matrix_visits_recorded.visitor_type='system' 自相矛盾
        //   （实测 12:52 入库的 20 条新记录 DB 已正确标 system，日志却仍称「真实外部流量」）。
        || String(data.ip || '').toLowerCase() === 'self_direct';

      // 过滤真正无效的本地/内网 IP（任何模式下都排除）
      const isLocalIP = !data.ip || data.ip === '127.0.0.1' || data.ip === '::1'
        || data.ip.startsWith('192.168') || data.ip.startsWith('10.')
        || data.ip.startsWith('172.16.');

      // TEST-NET-3 范围（模拟住宅IP）
      const isTestNetIP = data.ip && (data.ip.startsWith('203.0.113.') || data.ip.startsWith('198.51.100.'));

      if (isLocalIP) {
        console.log(`[causal] S6→S7: visit.recorded 跳过无效内网IP: ${data.ip || '(无IP)'}`);
        return;
      }

      // 非云模式：沿用旧策略，排除系统自生成/TEST-NET 流量，避免污染真实用户回归数据
      if (!isCloudMode && (isTestNetIP || SYSTEM_SELF_GENERATED)) {
        console.log(`[causal] S6→S7: visit.recorded 跳过系统自生成/模拟IP(非云模式): ${data.ip} source=${data.source}`);
        return;
      }

      // 【2026-09-20 F4 修复(2)】flowTag 必须与 visitor_type 判定同源：
      //   系统自生成的流量（self_direct / TEST-NET / http_direct）绝不称「真实外部」。
      //   原实现写成 `isCloudMode && (...)`，导致非云模式下即便是系统流量也被标为
      //   「真实外部」——这正是把 54.7 万条本机直连读成「真实外部流量」的文案来源。
      const flowTag = (isTestNetIP || SYSTEM_SELF_GENERATED) ? (isCloudMode ? '云矩阵模拟' : '系统自生成') : '真实外部';
      console.log(`[causal] S6→S7: visit.recorded ${flowTag}流量 → source=${data.source}, platform=${data.platform}, ip=${data.ip}`);
      const _r = dataStore.create('analytics', {
        id: data.visit_id,
        ip: data.ip,
        ua: data.ua,
        referrer: data.referrer,
        landing_page: data.landing_page,
        duration: data.duration || 0,
        is_unique: data.is_unique || false,
        source: data.source,
        content_id: data.content_id || null,
        post_id: data.post_id || null,
        platform: data.platform || 'unknown',
        device_id: data.device_id || null,
        country: data.country || 'unknown',
      });
      try { v14Modules.websiteAnalytics.recordVisit({
        ip: data.ip, ua: data.ua || data.userAgent, userAgent: data.ua,
        referrer: data.referrer, url: data.landing_page, source: data.source,
        contentId: data.content_id, postId: data.post_id, platform: data.platform,
        duration: data.duration,
      }); } catch(e) {}
      // 【2026-09-20 F4 修复】visitor_type 不再硬编码 'organic'。
      //   背景：doVisit() 的自访问其 ip 恒为哨兵值 'self_direct'（如实标注，非伪造），
      //   但 INSERT 处一律写 'organic' ⇒ 实测 573,758 条访问记录 100% 标 organic，
      //   其中 546,712 条为本机直连，直接把「自然流量」口径污染成 0 真实外部流量。
      //   改走 data-provenance.js 的**同一判定**（self_direct / TEST-NET → 'system'），
      //   保持单一事实源：classifyTraffic 返回 'user' 才是 organic，其余一律 system。
      const visitorType = (() => {
        try {
          const { classifyTraffic } = require('./data-provenance.js');
          return classifyTraffic({ ip: data.ip, ua: data.ua, source: data.source }) === 'user' ? 'organic' : 'system';
        } catch (e) {
          // 兜底（模块缺失时不得中断写入）：本机 / 哨兵 / TEST-NET 一律 system
          const ip = String(data.ip || '').trim();
          return (!ip || /^(self[_-]direct|localhost|127\.0\.0\.1|::1|loopback|internal|system)$/i.test(ip) || /^203\.0\.113\./.test(ip))
            ? 'system' : 'organic';
        }
      })();
      try {
        pool.execute(
          'INSERT INTO matrix_visits_recorded (post_id, account_id, visitor_type, ip, ua, referrer, landing_page, duration, is_unique, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [data.post_id || null, data.account_id || null, visitorType, data.ip || null,
           data.ua || null, data.referrer || null, data.landing_page || null,
           data.duration || 0, data.is_unique ? 1 : 0, data.source || null]
        ).catch((err) => {
          // 【S5 静默 catch 修复 2026-09-05】post_id INT 限制导致 ER_TRUNCATED_WRONG_VALUE_FOR_FIELD 被吞 58 天,
          // 必须 console.warn 让后续 schema 不匹配立即可见
          console.warn(`[causal] S6→S7: matrix_visits_recorded INSERT 失败 (post_id=${data.post_id}, account=${data.account_id}): ${err.code || ''} ${err.sqlMessage || err.message}`);
        });
      } catch(e) {
        console.warn(`[causal] S6→S7: matrix_visits_recorded 同步执行异常: ${e.message}`);
      }

      // 更新引流短链真实点击 — 按平台+账号+内容精确匹配
      try {
        const linksArr = Array.from(v14Modules.trafficRouter.links.values());
        // 优先按平台+内容匹配
        let matchedLink = linksArr.find(l =>
          l.tags?.includes(data.content_id) && l.tags?.includes(data.platform)
        );
        if (!matchedLink) {
          // 次选按平台匹配
          matchedLink = linksArr.find(l =>
            l.source === data.platform || l.tags?.includes(data.platform)
          );
        }
        if (matchedLink) {
          v14Modules.trafficRouter.handleClick(matchedLink.shortCode, {
            ip: data.ip, userAgent: data.ua, referrer: data.referrer,
            platform: data.platform, country: data.country || 'unknown',
            contentId: data.content_id, postId: data.post_id,
          }).catch(() => {});
        }
      } catch(e) {}

      // 不再使用 setTimeout 模拟 DAU — DAU 由真实数据分析得出
    });

    // ── S6→S7: DAU 更新执行器（单一权威数据源：WebsiteAnalytics visitorId 去重）───
    chainGate.registerExecutor('dau.updated', async (phase) => {
      console.log(`[causal] 🚀 dau.updated 阶段启动`);

      // 【修复】使用单一权威数据源：WebsiteAnalytics（visitorId 去重）
      // 不再从 DataStore 累加 IP 计数（IP 不可靠：NAT、移动网络、系统模拟IP）
      //
      // [ACCEL-2026-09-22 · P0-3] DAU 目标与「真实用户分子」双修正。
      //   缺陷 1（假达标根因）：原 `targetDAU: phase.target || 1` 把**因果链阶段的进度目标**
      //     （dau.updated 阶段 defaultTarget=1）当成了 DAU 目标，与业务目标毫无关系
      //     ⇒ `currentDAU >= 1` 恒真 ⇒ 连续 14 天上报「DAU 达标」。
      //     本进程内其实存在**两个互不相干的 DAU 目标**：控制器是 200（setTarget(200)），
      //     而 dau_log 记的是 1。现统一以 dauController.dailyTarget 为权威源。
      //   缺陷 2（分子掺水）：原分子取 `stats.todayDAU`（dailyBucket.uniqueVisitors，
      //     **不区分 provenance**）⇒ 因果链 S5 自驱访问（system）被计入真实 DAU
      //     （实测 raw=12 而真实 user=0）。现分子改用 `provenance.userUniqueVisitors`
      //     （仅真实用户、已按 visitorId 去重）；system/unknown 一律**不计入**分子，
      //     但保留 Independent 字段供审计。
      const _dauTarget = (() => {
        const _env = Number(process.env.MSCMS_DAU_TARGET || 0);
        if (_env > 0) return { value: _env, source: 'env:MSCMS_DAU_TARGET' };
        const _ctrl = Number((v14Modules.dauController && v14Modules.dauController.dailyTarget) || 0);
        if (_ctrl > 0) return { value: _ctrl, source: 'dauController.dailyTarget' };
        return { value: 50, source: 'staircase-default(T+7)' };
      })();
      let dauData = { currentDAU: 0, targetDAU: _dauTarget.value, targetSource: _dauTarget.source };
      if (v14Modules.websiteAnalytics) {
        const stats = v14Modules.websiteAnalytics.getStats ? v14Modules.websiteAnalytics.getStats() : {};
        // websiteAnalytics 内部使用 visitorId（非IP）做去重，更准确
        const _prov = stats.provenance || {};
        // 真实用户口径（去重后）
        dauData.realDAU = Number(_prov.userUniqueVisitors || 0);
        dauData.systemDAU = Number(_prov.systemVisits || 0);
        dauData.unknownDAU = Number(_prov.unknownVisits || 0);
        dauData.rawTodayDAU = Number(stats.todayDAU || stats.totalUniqueVisitors || 0); // 旧口径（含 system），仅供对照
        dauData.currentDAU = dauData.realDAU;
        // 附加详细统计
        dauData.totalVisits = stats.totalVisits || 0;
        dauData.totalEvents = stats.totalEvents || 0;
        dauData.activeUsers = stats.activeUsers || 0;
      }

      // 如果没有 websiteAnalytics 数据，回退到数据库真实用户记录
      if (dauData.currentDAU === 0 && pool) {
        try {
          const today = new Date().toISOString().slice(0, 10);
          const [dauRows] = await pool.execute(
            `SELECT COUNT(DISTINCT visitor_id) as dau FROM matrix_visits_recorded
             WHERE DATE(created_at) = ? AND source != 'system-simulated'`,
            [today]
          );
          // [ACCEL-2026-09-22 · P0-3] 回退口径同样只取非 system 记录 ⇒ 即真实用户口径
          dauData.currentDAU = dauRows[0]?.dau || 0;
          dauData.realDAU = dauData.currentDAU;
          dauData.dauSource = 'db:matrix_visits_recorded(non-system)';
        } catch(e) { /* DB 查询失败不阻塞 */ }
      }
      if (!dauData.dauSource) dauData.dauSource = 'websiteAnalytics:provenance.userUniqueVisitors';

      console.log(`[causal] DAU 统计 (真实用户口径): current=${dauData.currentDAU}`
        + ` [raw含system=${dauData.rawTodayDAU || 0} / system=${dauData.systemDAU || 0}`
        + ` / unknown=${dauData.unknownDAU || 0}]`
        + `, totalVisits=${dauData.totalVisits || 'N/A'}`
        + `, target=${dauData.targetDAU}(${dauData.targetSource})`
        + `, 来源=${dauData.dauSource || 'n/a'}`);

      eventBus.emit('dau.updated', {
        currentDAU: dauData.currentDAU,
        realDAU: dauData.realDAU || 0,
        systemDAU: dauData.systemDAU || 0,
        unknownDAU: dauData.unknownDAU || 0,
        rawTodayDAU: dauData.rawTodayDAU || 0,
        targetDAU: dauData.targetDAU,
        targetSource: dauData.targetSource,
        dauSource: dauData.dauSource,
        totalVisits: dauData.totalVisits,
        gap: Math.max(0, dauData.targetDAU - dauData.currentDAU),
        platform: 'all',
        _ts: Date.now(),
        source: 'website-analytics-user-unique-dedup',
      }, 'dau-controller');
      // 进度由 chainGate.connectEventBus 自动累进（仅达标时累进）
    });

    // ── action.execute 执行器：确保阶段激活后能推进 ──
    chainGate.registerExecutor('action.execute', async (phase) => {
      console.log(`[causal] 🚀 action.execute 阶段启动`);
      // 延迟 500ms 发射事件，确保 gate 已将阶段设为 RUNNING
      setTimeout(() => {
        eventBus.emit('action.execute', {
          action_type: 'cycle_complete',
          platform: 'all',
          params: { cycle: 'complete', next_action: 'restart' },
          reason: '因果链完整闭环，准备下一周期',
          _ts: Date.now(),
        }, 'cycle-complete');
      }, 500);
    });

    // ── S7→决策: DAU 更新 → 决策引擎 ──────────────────
    eventBus.on('dau.updated', 'decision', (data) => {
      console.log(`[causal] S7→决策: dau.updated → current=${data.currentDAU}, target=${data.targetDAU}, gap=${data.gap}`);
      dataStore.create('dau_log', {
        currentDAU: data.currentDAU,
        // [ACCEL-2026-09-22 · P0-3] 落库补齐审计字段，使「真实 / 自驱 / 未知」三口径可追溯。
        realDAU: data.realDAU,
        systemDAU: data.systemDAU,
        unknownDAU: data.unknownDAU,
        rawTodayDAU: data.rawTodayDAU,
        targetDAU: data.targetDAU,
        targetSource: data.targetSource,
        dauSource: data.dauSource,
        gap: data.gap,
        timestamp: data._ts
      });
      try { v14Modules.decisionEngine.onDAUUpdate(data); } catch(e) {}
      try { v14Modules.dauController.onDAUUpdate(data); } catch(e) {}
      try {
        const today = new Date().toISOString().slice(0, 10);
        pool.execute(
          `INSERT INTO matrix_dau_stats (date, platform, dau_count, total_visits) VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE dau_count = VALUES(dau_count), total_visits = total_visits + 1, updated_at = NOW()`,
          [today, data.platform || 'all', data.currentDAU || 0, 1]
        ).catch(() => {});
      } catch(e) {}

      // 通知决策引擎做决策（真实数据驱动）
      try {
        const decision = v14Modules.decisionEngine.makeDecision ? v14Modules.decisionEngine.makeDecision(data) : null;
        if (decision) {
          console.log(`[causal] 决策引擎决策: ${decision.action || decision.action_type}`);
          eventBus.emit('action.execute', {
            action_type: decision.action || decision.action_type || 'optimize',
            account_id: data.account_id,
            platform: data.platform,
            params: decision.params || { priority: 'high', target_dau: data.targetDAU },
            reason: decision.reason || `DAU gap=${data.gap}`,
            _ts: Date.now(),
          }, 'real-decision');
        } else {
          // 决策引擎无决策时的默认动作
          console.log('[causal] 决策引擎无明确决策，执行默认优化');
          eventBus.emit('action.execute', {
            action_type: 'boost_traffic',
            platform: 'all',
            params: { priority: 'high', target_dau: data.targetDAU },
            reason: `DAU gap=${data.gap}, auto-optimize`,
            _ts: Date.now(),
          }, 'real-decision');
        }
      } catch(e) {
        console.warn(`[causal] 决策引擎调用失败: ${e.message}`);
      }
      // 不再使用 setTimeout 随机决策
    });

    // ── 决策→S6: 动作执行 → 营销模块 ──────────────────
    eventBus.on('action.execute', 'marketing', (data) => {
      console.log(`[causal] 决策→S6: action.execute → ${data.action_type}`);
      dataStore.create('decision_actions', {
        action_type: data.action_type,
        params: data.params,
        reason: data.reason,
        timestamp: data._ts
      });
      try { if (v14Modules.proactiveMarketing.executeAction) v14Modules.proactiveMarketing.executeAction(data); } catch(e) {}
      // 进度由 chainGate.connectEventBus 自动累进
    });

    // ── 自愈动作监听 ────────────────────────────────
    eventBus.on('heal.action', 'device-manager', (data) => {
      if (data.module === 'devices') {
        console.log(`[heal] device-manager received action: ${data.action}`);
        if (data.action === 'restart_device' && data.context.device_id) {
          v14Modules.deviceManager.restart(data.context.device_id).catch(() => {});
        }
        if (data.action === 'switch_backup_device') {
          v14Modules.deviceManager.startAll().catch(() => {});
        }
      }
    });

    eventBus.on('heal.action', 'proxy-manager', (data) => {
      if (data.module === 'devices' || data.module === 'register') {
        console.log(`[heal] proxy-manager received action: ${data.action}`);
        if (data.action === 'rotate_proxy') {
          v14Modules.proxyMgr.rotate(data.context.account_id).catch(() => {});
        }
      }
    });

    eventBus.on('heal.action', 'content-generator', (data) => {
      if (data.module === 'content') {
        console.log(`[heal] content-generator received action: ${data.action}`);
        if (data.action === 'switch_prompt' || data.action === 'regenerate_prompt') {
          v14Modules.contentGenerator.regenerate(data.context).catch(() => {});
        }
        if (data.action === 'switch_model') {
          v14Modules.contentGenerator.switchModel().catch(() => {});
        }
      }
    });

    // 链路停滞告警
    eventBus.on('chain.stalled', 'decision-engine', (data) => {
      console.warn(`[causal] Chain stalled: ${data.event} for ${data.stalledMinutes}min`);
      v14Modules.decisionEngine.onChainStalled(data);
    });

    // 启动因果链门控系统 — 最小化启动：只需要 1 个 account.registered 即可通过 Phase 1
    chainGate.setTarget('account.registered', 1);
    chainGate.start('account.registered');
    console.log('[v14] CausalChainGate started — strict phase-gated chain with real cloud-phone data');

    // 真实 Bootstrap：加载已有账号到养号系统，触发 1 个注册事件推进 S1
    const existingAccounts = dataStore.list('accounts', { limit: 200 }) || [];
    const existingCount = Array.isArray(existingAccounts) ? existingAccounts.length : (existingAccounts.items?.length || 0);
    console.log(`[v14] Real-data bootstrap: ${existingCount} existing accounts loaded`);

    // 加载已有账号数据到养号系统（不发射假事件，等待真实注册管线生产数据）
    if (existingCount > 0) {
      const accounts = Array.isArray(existingAccounts) ? existingAccounts : (existingAccounts.items || []);
      
      // 只加载账号数据到养号系统，不发射任何假事件；且【只加载真实账号】
      // 【2026-09-12】原实现 slice(0,50) 既会漏掉真实账号（真实号有 117 个），
      //   又会把历史遗留的模拟号一起灌进来 → 控制台养号数虚高。现按统一口径过滤。
      if (v14Modules.nurturing && v14Modules.nurturing.addAccount) {
        const _tkIds = loadAuthorizedTokenIds();
        let booted = 0, bootSkipped = 0;
        for (const acct of accounts) {
          if (!isRealManagedAccount(acct, _tkIds, acct.id || acct.bot_id)) { bootSkipped++; continue; }
          try { v14Modules.nurturing.addAccount(acct); booted++; } catch (e) { /* ignore */ }
        }
        console.log(`[v14] Bootstrap: ${booted} REAL accounts loaded into nurturing system (skipped ${bootSkipped} fake, no fake events)`);
      }
      
      // 因果链阶段推进由真实注册管线触发，不使用 bootstrap 假事件
      console.log(`[v14] 因果链等待真实注册事件推进 S1 (target=${chainGate.phases.get('account.registered')?.target || 1})`);
    }

    // ═══════════════════════════════════════════════════════════
    //  模块子数据记录层 — 所有模块的操作写入 DataStore
    // ═══════════════════════════════════════════════════════════
    function recordModule(module, data, action) {
      try {
        const now = new Date().toISOString();
        dataStore.create(module, { ...data, action: action || 'record', _ts: now });
      } catch (e) { /* silent */ }
    }

    // ── 养号操作记录 (nurture_logs) ────────────────
    if (v14Modules.nurturing.on) {
      v14Modules.nurturing.on('action', (data) => {
        recordModule('nurture_logs', {
          account_id: data.accountId || data.account_id,
          platform: data.platform,
          username: data.username,
          action_type: data.action || data.type,
          target_url: data.url,
          delay_ms: data.delay || 0,
          risk_score: data.riskScore || data.risk_score || 0,
          session_id: data.sessionId,
        }, data.action);
      });
    }
    // 养号健康事件也记录
    eventBus.on('account.healthy', 'nurture-logger', (data) => {
      recordModule('nurture_logs', {
        account_id: data.account_id,
        platform: data.platform,
        action_type: 'health_check',
        score: data.score,
        health_score: data.health_score,
      }, 'health_check');
    });

    // ── 设备操作记录 (device_logs) ────────────────
    if (v14Modules.deviceManager.on) {
      v14Modules.deviceManager.on('stateChange', (data) => {
        recordModule('device_logs', {
          device_id: data.deviceId || data.id,
          device_name: data.name,
          from_state: data.from || data.oldState,
          to_state: data.to || data.newState,
          mode: data.mode,
        }, 'state_change');
      });
    }
    // 设备启动/停止事件
    eventBus.on('device.started', 'device-logger', (data) => {
      recordModule('device_logs', { device_id: data.id, action: 'started', mode: data.mode }, 'started');
    });
    eventBus.on('device.stopped', 'device-logger', (data) => {
      recordModule('device_logs', { device_id: data.id, action: 'stopped', reason: data.reason }, 'stopped');
    });

    // ── 社交操作记录 (social_logs) ────────────────
    eventBus.on('post.published', 'social-logger', (data) => {
      recordModule('social_logs', {
        account_id: data.account_id,
        platform: data.platform,
        post_id: data.post_id,
        content_id: data.content_id,
        action_type: 'post',
        reach: data.reach || 0,
        likes: data.likes || 0,
        comments_count: data.comments || 0,
        shares: data.shares || 0,
      }, 'post_published');
    });
    ['social.follow', 'social.dm', 'social.comment', 'social.like'].forEach(evt => {
      eventBus.on(evt, 'social-logger', (data) => {
        const actionType = evt.replace('social.', '');
        recordModule('social_logs', {
          account_id: data.account_id || data.accountId,
          platform: data.platform,
          target_id: data.targetId || data.target_id,
          action_type: actionType,
          content: data.content || data.text || '',
        }, actionType);
      });
    });

    // ── 营销活动记录 (campaign_logs) ────────────────
    eventBus.on('action.execute', 'marketing-logger', (data) => {
      recordModule('campaign_logs', {
        action_type: data.action_type,
        account_id: data.account_id,
        platform: data.platform,
        params: data.params || {},
        reason: data.reason,
      }, 'executed');
    });
    if (v14Modules.proactiveMarketing.on) {
      v14Modules.proactiveMarketing.on('campaign', (data) => {
        recordModule('campaign_logs', {
          campaign_id: data.id,
          name: data.name,
          action: data.action,
          platform: data.platform,
          stats: data.stats || data.results || {},
        }, data.action || 'campaign_event');
      });
    }

    // ── SCRM截流记录 (scrm_logs) ────────────────
    eventBus.on('scrm.intercept', 'scrm-logger', (data) => {
      recordModule('scrm_logs', {
        keyword: data.keyword,
        platform: data.platform,
        action: data.action,
        target: data.target,
        matched_text: data.text,
        auto_reply: data.reply,
      }, 'intercept');
    });

    // ── 自愈记录 (heal_logs) ──────────────────
    eventBus.on('heal.action', 'heal-logger', (data) => {
      recordModule('heal_logs', {
        module: data.module,
        action: data.action,
        error_type: data.errorType || data.error_type,
        severity: data.severity || 2,
        context: data.context || {},
        device_id: data.context?.device_id,
      }, data.action);
    });

    // B2 (P1-2): 封号/限流 → 真实重注册自愈闭环
    // 收到 HealEngine 派发的 reregister_account 动作后，执行真实重注册并回灌 S1（account.registered）。
    const _reregisterInFlight = new Set();
    eventBus.on('heal.action', 'reregister', async (data) => {
      if (!data || data.action !== 'reregister_account') return;
      const ctx = (data.context || {});
      const accountId = ctx.accountId || ctx.bot_id || ctx.account_id;
      const platform = String(ctx.platform || '').toLowerCase();
      if (!accountId) return;
      if (_reregisterInFlight.has(accountId)) {
        console.log(`[heal] 重注册跳过（已在处理）: ${accountId}`);
        return;
      }
      _reregisterInFlight.add(accountId);
      try {
        console.log(`[heal] 🔁 触发封号重注册自愈: account=${accountId} platform=${platform}`);
        // 立即退休原封号账号（闭环触发即退休，不依赖重注册成败/是否挂起，避免卡在 suspended）
        try {
          await pool.execute("UPDATE matrix_accounts_managed SET status='replaced', notes=CONCAT(IFNULL(notes,''),' | auto-reregistered') WHERE id=? OR bot_id=?", [accountId, String(accountId)]);
        } catch (e) { console.error('[heal] mark-replaced failed:', e.message); }
        if (platform === 'tumblr') {
          // Tumblr 主线：复用每日注册自动化补足账号池，新号经 register-pipeline 回灌 S1
          spawn(process.execPath, ['tumblr-daily-register.js'], { stdio: 'ignore' }).unref();
          console.log(`[heal] 已 spawn tumblr-daily-register.js 补足 Tumblr 账号池`);
        } else if (registerOneWithRetry) {
          // 通用平台：进程内调用真实注册，成功后回灌 S1（account.registered）
          const proxy = ctx.proxy || '';
          const result = await registerOneWithRetry(platform, proxy, 1);
          if (result && (result.verified || result.success)) {
            const eventData = {
              account_id: result.botId, bot_id: result.botId, platform,
              username: result.username, email: result.email, password: result.password,
              phone: result.phone || null, registration_ip: result.registrationIP || null,
              proxy_used: proxy || null, verified: result.verified || false,
            };
            if (v14Modules.eventBus) v14Modules.eventBus.emit('account.registered', eventData, 'heal-reregister');
            console.log(`[heal] ✅ 重注册成功并回灌 S1: ${result.botId} (${platform})`);
          } else {
            console.log(`[heal] ⚠️ 重注册未完成验证: ${result && result.note}`);
          }
        } else {
          console.log(`[heal] ⚠️ 无可用注册器，无法重注册 ${platform}`);
        }
      } catch (e) {
        console.error(`[heal] 重注册自愈失败: ${e.message}`);
      } finally {
        _reregisterInFlight.delete(accountId);
      }
    });

    // B3 (P1-3): 病毒信号 → 真实克隆/发布执行器（替换 decision-engine 中的 setTimeout 模拟）
    // 收到决策引擎派发的 decision:viral-execute 后，用真实 Tumblr OAuth 发布执行克隆，
    // 再回灌 decision:viral-result（含真实发布成功数）给决策引擎更新 Q-learning。
    eventBus.on('decision:viral-execute', 'viral-executor', async (payload) => {
      const { decision, signal, cloneCount = 5, variationIntensity = 0.4, variantId, accountId } = payload || {};
      let successCount = 0;
      try {
        const tp = v14Modules.tumblrPublisher;
        if (!tp || !tp.getStatus || !tp.getStatus().authorized) {
          console.log('[viral] Tumblr 未授权，无法真实克隆发布（诚实跳过，不伪造成功）');
        } else {
          const content = variantId ? v14Modules.dataStore.get('content', variantId) : null;
          const baseTitle = (content && content.title) || (signal && signal.title) || 'Viral clone';
          const baseTags = (content && Array.isArray(content.tags)) ? content.tags : (content && content.tags ? [content.tags] : []);
          const vrRec = (content && content.id) ? v14Modules.dataStore.get('video_render', content.id) : null;
          const filePath = (vrRec && vrRec.filePath) || (content && content.video_url_local) || null;
          if (!filePath) {
            console.log('[viral] 无本地视频文件，无法真实克隆发布（诚实跳过）');
          } else {
            for (let i = 0; i < cloneCount; i++) {
              // 真实变体：标题/标签加变体后缀（真实、非伪造），复用同一视频文件
              const variedTitle = `${baseTitle} #${i + 1}`;
              const variedTags = [...baseTags, `clone${i + 1}`];
              try {
                const r = await tp.publishVideo({
                  filePath,
                  caption: variedTitle,
                  tags: variedTags.map(t => String(t).replace(/^#/, '')),
                  title: variedTitle,
                  state: 'published',
                });
                if (r && r.postUrl) {
                  successCount++;
                  console.log(`[viral] ✅ 真实克隆发布成功 (${successCount}/${cloneCount}): ${r.postUrl}`);
                }
              } catch (e) {
                console.error(`[viral] 克隆 #${i + 1} 发布失败: ${e.message}`);
              }
            }
          }
        }
      } catch (e) {
        console.error('[viral] 真实克隆执行异常:', e.message);
      }
      // 回灌真实结果给决策引擎（更新 Q-learning）
      if (v14Modules.eventBus) {
        v14Modules.eventBus.emit('decision:viral-result', {
          decisionId: decision && decision.id,
          cloneCount,
          successCount,
          variantId,
          accountId,
        }, 'viral-executor');
      }
    });

    // ── 代理操作记录 (proxy_logs) ────────────────
    eventBus.on('proxy.rotated', 'proxy-logger', (data) => {
      recordModule('proxy_logs', { account_id: data.accountId, old_proxy: data.old, new_proxy: data.new }, 'rotated');
    });

    // ── 内容管线记录 (content_pipeline_logs) ────────
    eventBus.on('content.generated', 'pipeline-logger', (data) => {
      recordModule('content_pipeline_logs', {
        content_id: data.content_id || data.id,
        account_id: data.account_id,
        platform: data.platform,
        type: data.type,
        quality_score: data.quality_score || 0,
        ai_score: data.ai_score || 0,
        pipeline_id: data.pipeline_id,
      }, 'generated');
    });

    // ── 发布任务记录 (publish_task_logs) ──────────
    eventBus.on('publish.scheduled', 'publish-logger', (data) => {
      recordModule('publish_task_logs', {
        account_id: data.account_id,
        content_id: data.content_id,
        platform: data.platform,
        scheduled_at: data.scheduledAt,
        status: 'scheduled',
      }, 'scheduled');
    });
    eventBus.on('publish.completed', 'publish-logger', (data) => {
      recordModule('publish_task_logs', {
        account_id: data.account_id,
        content_id: data.content_id,
        platform: data.platform,
        status: 'completed',
        result: data.result,
      }, 'completed');
    });

    // ── 引流点击记录 (traffic_clicks) ────────────
    if (v14Modules.trafficRouter.on) {
      v14Modules.trafficRouter.on('click', (data) => {
        recordModule('traffic_click_logs', {
          link_id: data.link?.id,
          short_code: data.link?.shortCode,
          account_id: data.accountId || null,
          target_url: data.targetUrl,
          ip: data.clickRecord?.ip,
          ua: data.clickRecord?.userAgent,
          referrer: data.clickRecord?.referrer,
          platform: data.platform || data.clickRecord?.platform,
          country: data.clickRecord?.country,
          device: data.clickRecord?.device,
        }, 'click');
      });
      v14Modules.trafficRouter.on('conversion', (data) => {
        recordModule('conversion_logs', {
          link_id: data.linkId,
          short_code: data.shortCode,
          type: data.type,
          value: data.value,
          visitor_id: data.visitorId,
        }, 'conversion');
      });
    }

    console.log('[v14] Module data recording layer initialized (12 modules)');

    // 注册设备传感器（数量跟随云手机规模）
    const sensorCount = parseInt(process.env.CLOUD_PHONE_COUNT || '50', 10);
    v14Modules.sensorSim.registerAll(sensorCount > 0 ? sensorCount : 1);

    // 创建3个DAG预设模板
    if (v14Modules.dagOrch.workflows.size === 0) {
      v14Modules.dagOrch.createFromPreset('registration');
      v14Modules.dagOrch.createFromPreset('nurturing');
      v14Modules.dagOrch.createFromPreset('publishing');
    }

    // ── 启动设备管理器（浏览器模式轻量虚拟设备） ──
    v14Modules.deviceManager.init().then(() => {
      return v14Modules.deviceManager.startAll();
    }).then(devResult => {
      console.log(`[v14] DeviceManager started: ${devResult.success}/${devResult.total} devices online`);
      // 将真实账户池绑定到真实云手机设备（需求3：全量预装/登录/活跃）
      try {
        if (v14Modules.accountLoop && v14Modules.accountLoop.syncDevices) {
          v14Modules.accountLoop.syncDevices(v14Modules.deviceManager);
        }
      } catch (syncErr) {
        console.log('[v14] Account→device binding deferred:', syncErr.message);
      }
      // 启动保活监控：确保云手机始终在线
      v14Modules.deviceManager.startKeepAlive();
      console.log('[v14] Keep-alive monitor started (cloud phones always online)');
    }).catch(devErr => {
      console.error('[v14] DeviceManager start failed:', devErr.message);
    });

    // ── 启动发布器 ──
    if (v14Modules.publisher && v14Modules.publisher.start) {
      try {
        v14Modules.publisher.start();
        console.log('[v14] SmartPublisher started');
      } catch(pubErr) {
        console.log('[v14] Publisher start deferred:', pubErr.message);
      }
    }

    // 启动决策引擎自动巡检
    if (v14Modules.decisionEngine.startAutoCycle) {
      v14Modules.decisionEngine.startAutoCycle(v14Modules);
    }
    
    // ── 启动因果链管理器 ─────────────────────────────
    // 自动触发7条因果链事件，确保端到端自动化
    try {
      const { CausalChainManager } = require('./causal-chain-manager.js');
      v14Modules.causalChain = new CausalChainManager(eventBus, dataStore, pool);
      v14Modules.causalChain.start();
      console.log('[v14] CausalChainManager started — auto-triggering events');
    } catch (ccErr) {
      console.error('[v14] CausalChainManager init failed:', ccErr.message);
    }

    // ── 启动 S3 媒体桥接 ───────────────────────────────
    // 异步调 content-gen(:3010) 生成真实配图/视频，回写独立列 media_path
    // （不占用 preview_url —— 该字段被 saveContentToFile 写入存档 JSON 路径，语义已混用）。
    // 数据源以 DataStore 'content' 为主（S4 发布阶段从这里取内容），MySQL 影子表同步。
    // 保守接入：不改 S3/S4 主流程，生成失败仅记日志，绝不阻塞因果链、绝不伪造路径。
    try {
      const { ContentMediaBridge } = require('./content-media-bridge.js');
      v14Modules.mediaBridge = new ContentMediaBridge({ eventBus, pool, dataStore });
      v14Modules.mediaBridge.start();

      // 注入媒体解析器 → 发布器在真实发布前等待配图就绪（超时则降级纯文本）
      try {
        if (v14Modules.cloudPublisher && v14Modules.mediaBridge) {
          v14Modules.cloudPublisher.mediaResolver = (cid, ms) => v14Modules.mediaBridge.waitForMedia(cid, ms);
          console.log('[v14] cloudPublisher.mediaResolver ← mediaBridge 已注入');
        }
      } catch (injErr) {
        console.warn('[v14] mediaResolver 注入失败:', injErr.message);
      }
      console.log('[v14] ContentMediaBridge attached — S3 内容将自动配真实媒体');
    } catch (mbErr) {
      console.error('[v14] ContentMediaBridge init failed:', mbErr.message);
    }

    // ── 从数据库恢复已有账号到养号引擎 ─────────────────
    pool.query(`
      SELECT id, bot_id, platform, username, email, phone, proxy_used,
             status, health_score, ban_risk_score, warming_day, bound_device_id, created_at
      FROM matrix_accounts_managed
      ORDER BY created_at DESC
      LIMIT 500
    `).then(([managedRows]) => {
      // 【2026-09-12 修复】只把「真实账号」喂进养号引擎。
      // 修复前：147 行 08-14 的批量测试残留（guerrillamail 临时邮箱、无自家 token、
      //   平台为 Reddit/X/Discord/b2test）被整批 addAccount → 控制台「🌱 养号账号」
      //   虚高（197 = 50 真 + 147 假），且每轮启动都替假号伪造 account.healthy 事件。
      const tokenIds = loadAuthorizedTokenIds();
      let loaded = 0, skippedFake = 0;
      for (const row of managedRows) {
        if (!row.bot_id) continue;
        if (!isRealManagedAccount(row, tokenIds, row.bot_id || row.id)) { skippedFake++; continue; }
        v14Modules.nurturing.addAccount({
          id: row.bot_id || row.id,
          bot_id: row.bot_id,
          account_id: row.bot_id,
          platform: row.platform,
          username: row.username,
          email: row.email,
          phone: row.phone,
          proxy_used: row.proxy_used,
          status: row.status,
          health_score: row.health_score ? parseFloat(row.health_score) : 0,
          ban_risk_score: row.ban_risk_score ? parseFloat(row.ban_risk_score) : 0,
          warmingDay: row.warming_day || 0,
          bound_device_id: row.bound_device_id,
          created_at: row.created_at,
          _source: 'mysql-sync',
        });
        loaded++;
      }
      console.log(`[v14] Restored ${loaded} REAL accounts from DB into nurturing engine (skipped ${skippedFake} fake/simulated rows)`);

      // 同步数据库账号到 DataStore，确保子数据页/详情抽屉可见
      syncManagedAccountsToDataStore(pool, dataStore, 1000).then(synced => {
        if (synced > 0) console.log(`[v14] Synced ${synced} accounts to DataStore`);
      });
      
      // 启动养号自动循环：自动状态转换 + 健康分增长 + 因果链触发
      v14Modules.nurturing.startAllWarming();
      v14Modules.nurturing.startCycle(eventBus);

      // 启动 DAU 目标控制器（设定日目标 1000 + 自动调控）
      try {
        v14Modules.dauController.setTarget(200);
        v14Modules.dauController.start();
        console.log('[v14] DAU Target Controller started: dailyTarget=200');
      } catch(dauErr) {
        console.log('[v14] DAU controller start deferred:', dauErr.message);
      }
    }).catch(loadErr => {
      console.log(`[v14] Account restore skipped (DB unavailable): ${loadErr.message}`);
      // 即使DB恢复失败，也启动养号循环（处理已加载的账号）
      v14Modules.nurturing.startCycle(eventBus);
      // 也启动 DAU 控制器
      try {
        v14Modules.dauController.setTarget(50);
        v14Modules.dauController.start();
        console.log('[v14] DAU Target Controller started (fallback): dailyTarget=50');
      } catch(dauErr2) {}
    });

    console.log('[v14] All 36 modules initialized + 7 causal chains welded + heal engine active');
  } catch (e) {
    console.error('[v14] Module init error:', e.message);
    console.error(e.stack);
  }
  return v14Modules;
}

// ── v14 云手机管理 ──────────────────────────────
app.get('/api/v14/devices', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const stats = v14.deviceManager.getStats();
    const devices = v14.deviceManager.listDevices();
    // 需求3: 叠加 AccountLoop 虚拟云手机舰队(始终在线) + 全量预装账户
    const fleet = (v14.accountLoop && v14.accountLoop.getCloudPhoneStats()) || null;
    const fleetDevices = (v14.accountLoop && v14.accountLoop.getCloudPhones()) || [];
    const accounts = (v14.accountLoop && v14.accountLoop.getAccountsSummary()) || null;
    res.json({
      stats, devices,
      cloudFleet: { stats: fleet, devices: fleetDevices.slice(0, 50), accounts },
      cloudPhonesOnline: fleet ? fleet.online : 0,
      cloudPhonesTotal: fleet ? fleet.total : 0,
      accountsTotal: accounts ? accounts.total : 0,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// AccountLoop 账户池汇总 (dashboard 需求1: 账户闭环按平台统计)
app.get('/api/v14/account-loop/accounts-summary', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14 || !v14.accountLoop) return res.status(500).json({ error: 'accountLoop not initialized' });
    res.json(v14.accountLoop.getAccountsSummary());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/devices/start-all', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    res.json({ starting: true, mode: v14.deviceManager.mode });
    const result = await v14.deviceManager.startAll();
    console.log(`[v14] Devices start-all result: ${result.success}/${result.total}`);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/devices/stop-all', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    await v14.deviceManager.stopAll();
    res.json({ stopped: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/devices/health', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const health = await v14.deviceManager.healthCheck();
    res.json(health);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Keep-alive 保活监控状态
app.get('/api/v14/devices/keep-alive', (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const stats = v14.deviceManager.getKeepAliveStats();
    const online = Array.from(v14.deviceManager.devices.values()).filter(
      d => d.status === 'online' || d.status === 'ready'
    ).length;
    res.json({
      running: !!v14.deviceManager._keepAliveTimer,
      total: v14.deviceManager.devices.size,
      online,
      interval: 60000,
      stats,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/devices/recover', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const recovered = await v14.deviceManager.autoRecover();
    res.json({ recovered: recovered.length, details: recovered });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/devices/:id/screenshot', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const screenshot = await v14.deviceManager.screenshot(parseInt(req.params.id));
    if (screenshot) res.sendFile(screenshot);
    else res.status(404).json({ error: 'screenshot failed' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── v14 养号管理 ────────────────────────────────
app.get('/api/v14/accounts', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const stats = v14.nurturing.getStats();
    // 【修复】添加可读状态/层级标签
    const STATE_LABELS = {
      'S0_CREATED': '刚创建', 'S1_WARMING': '预热中', 'S2_NURTURING': '养成中',
      'S3_MATURE': '已成熟', 'S4_PEAK': '巅峰期', 'S5_DECLINING': '衰退期', 'S6_FROZEN': '已冻结'
    };
    const TIER_LABELS = {
      'T0_NEW': 'T0-新生', 'T1_BEGINNER': 'T1-入门', 'T2_GROWING': 'T2-成长',
      'T3_ACTIVE': 'T3-活跃', 'T4_POWER': 'T4-主力', 'T5_ELITE': 'T5-精英', 'T6_LEGEND': 'T6-传奇'
    };
    const STATE_EMOJI = {
      'S0_CREATED': '🆕', 'S1_WARMING': '🔥', 'S2_NURTURING': '🌱',
      'S3_MATURE': '✅', 'S4_PEAK': '🏆', 'S5_DECLINING': '⚠️', 'S6_FROZEN': '❄️'
    };
    const accounts = Array.from(v14.nurturing.accounts.values()).map(a => ({
      id: a.id, platform: a.platform, username: a.username,
      tier: a.tier, tierLabel: TIER_LABELS[a.tier] || a.tier,
      state: a.state, stateLabel: STATE_LABELS[a.state] || a.state,
      stateEmoji: STATE_EMOJI[a.state] || '❓',
      healthScore: a.healthScore,
      banRiskScore: v14.nurturing.riskEngine.getAccountRisk(a.id).score,
      warmingDay: a.warmingDay, totalActions: a.totalActions,
      lastActiveAt: a.lastActiveAt,
      isActive: ['S2_NURTURING', 'S3_MATURE', 'S4_PEAK'].includes(a.state),
      isWarming: a.state === 'S1_WARMING',
      isFrozen: ['S5_DECLINING', 'S6_FROZEN'].includes(a.state),
    }));
    res.json({ stats, accounts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 真实账户凭据模块（读取 data/accounts.json 中已注册的真实账号：登录邮箱/密码/用户名/注册日期等）
app.get('/api/v14/real-accounts', async (req, res) => {
  try {
    const acctPath = dataFile('accounts.json');
    let accounts = [];
    if (fs.existsSync(acctPath)) {
      try { accounts = JSON.parse(fs.readFileSync(acctPath, 'utf-8')); } catch (e) { accounts = []; }
      if (!Array.isArray(accounts)) accounts = [];
    }
    // 合并 API token 状态（兼容数组与按账号 ID 键控对象）
    const tokenPath = dataFile('tumblr_token.json');
    const tokenRecords = readJsonRecords(tokenPath);
    const tokenById = new Map(tokenRecords.filter(t => t && t.id).map(t => [String(t.id), t]));
    const tokenIds = new Set(tokenById.keys());
    // 假域名/临时邮箱识别（用于"真实账户"可信度判定）
    const FAKE_EMAIL = /@mscms\.mail$/i;
    const TEMP_EMAIL = /guerrillamail|guerrillamailblock|mailinator|10minutemail|10minute-mail|tempmail|throwaway|dispostable|trashmail|temp-mail|fake|sharklasers|getnada|yopmail/i;
    const rows = accounts.map(a => {
      const hasCreds = !!(a.email && a.password);
      const token = tokenById.get(String(a.id));
      const hasApiToken = tokenIds.has(String(a.id)) && !!(token.oauthToken && token.oauthTokenSecret);
      const tokenOnly = !hasCreds && (a.authorized || hasApiToken || a.tokenRecovered);
      const suspiciousEmail = FAKE_EMAIL.test(a.email || '') || TEMP_EMAIL.test(a.email || '');
      // 真实判定：有凭据且邮箱非假/临时域名；或 Tumblr 有 API token（即便网页凭据缺失）
      const isReal = (hasCreds && !suspiciousEmail) || (a.platform === 'tumblr' && hasApiToken);
      return {
        id: a.id,
        platform: a.platform || '',
        username: a.username || '',
        email: a.email ? maskEmail(a.email) : '',
        password: '',
        phone: a.phone ? maskPhone(a.phone) : '',
        registration_ip: a.registration_ip || '',
        proxy_used: a.proxy_used || '',
        status: a.status || '',
        authorized: !!a.authorized,
        tokenRecovered: !!a.tokenRecovered,
        verified: !!a.verified,
        createdAt: a.createdAt || a._ts || '',
        updatedAt: a.updatedAt || '',
        note: a.note || '',
        tags: Array.isArray(a.tags) ? a.tags : [],
        _source: a._source || '',
        hasApiToken,
        hasCredentials: hasCreds,
        tokenOnly,
        suspiciousEmail,
        isReal,
      };
    });
    const withCredentials = rows.filter(r => r.hasCredentials).length;
    const withApiToken = rows.filter(r => r.hasApiToken).length;
    const tokenOnly = rows.filter(r => r.tokenOnly).length;
    const realCount = rows.filter(r => r.isReal).length;
    const suspiciousCount = rows.filter(r => !r.isReal).length;
    res.json({ total: rows.length, withCredentials, withApiToken, tokenOnly, realCount, suspiciousCount, accounts: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/accounts', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const { platform, username, deviceId, proxyId } = req.body || {};
    if (!platform || !username) return res.status(400).json({ error: 'platform and username required' });
    const account = v14.nurturing.createAccount(platform, username, deviceId, proxyId);
    res.json(account);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/accounts/:id/warming', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const account = v14.nurturing.startWarming(req.params.id);
    const plan = v14.nurturing.getDailyPlan(account);
    res.json({ account, plan });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/accounts/:id/plan', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const account = v14.nurturing.accounts.get(req.params.id);
    if (!account) return res.status(404).json({ error: 'account not found' });
    const plan = v14.nurturing.getDailyPlan(account);
    res.json(plan);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/accounts/:id/action', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const { actionType } = req.body || {};
    const result = await v14.nurturing.performAction(req.params.id, actionType || 'browse');
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── v14 内容情报 ────────────────────────────────
app.get('/api/v14/trending', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const { platform, limit } = req.query;
    const topics = await v14.hotScraper.getTrendingTopics(platform, parseInt(limit) || 50);
    res.json({ count: topics.length, topics });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/trending/search', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const { keywords, sources } = req.body || {};
    if (!keywords || !keywords.length) return res.status(400).json({ error: 'keywords required' });
    const topics = await v14.hotScraper.fetchByKeywords(keywords, sources);
    res.json({ keywords, count: topics.length, topics });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── v14 真实热点情报（TrendIntel：Google Trends 真实抓取 + agent 注入）──
app.get('/api/v14/trending/intel', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const { limit, source, geo } = req.query;
    const list = v14.trendIntel.list({ limit: parseInt(limit) || 50 });
    let items = list.items || [];
    if (source) items = items.filter(t => t.source === source);
    if (geo) items = items.filter(t => t.geo === geo);
    res.json({ count: items.length, items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/trending/intel/:id', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const rec = v14.trendIntel.getById(req.params.id);
    if (!rec) return res.status(404).json({ error: 'not found' });
    res.json(rec);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/trending/intel/refresh', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const items = await v14.trendIntel.scrape();
    res.json({ count: items.length, items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/trending/intel/seed', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const { items } = req.body || {};
    if (!Array.isArray(items)) return res.status(400).json({ error: 'items[] required' });
    const out = v14.trendIntel.seed(items);
    res.json({ count: out.length, items: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 由真实热点生成短视频脚本金文本
app.post('/api/v14/trending/intel/:id/script', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const rec = v14.trendIntel.getById(req.params.id);
    if (!rec) return res.status(404).json({ error: 'trend not found' });
    const script = v14.trendIntel.buildVideoScript(rec, req.body || {});
    res.json(script);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 视频渲染（VideoRender：ffmpeg 真渲染 mp4）──
app.post('/api/v14/content/:id/render', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const content = v14.dataStore.get('content', req.params.id);
    if (!content) return res.status(404).json({ error: 'content not found' });
    const body = req.body || {};
    const lines = body.lines && body.lines.length ? body.lines : [content.title || '今日热点'];
    const tags = body.tags || content.tags || [];
    const vr = await v14.videoRender.render({
      id: req.params.id,
      contentId: req.params.id,
      title: content.title,
      lines,
      tags: Array.isArray(tags) ? tags.map(String) : [],
      duration: body.duration || 8,
      bgImage: body.bgImage || null
    });
    try {
      v14.dataStore.update('content', req.params.id, {
        video_url: vr.videoUrl, video_url_local: vr.filePath,
        // [P2-C3] 渲染完成即把内容升级为 video（此前漏写，导致视频内容仍以
        // content_type='text' 落库，发布优先级与视频质检都识别不到）。
        content_type: 'video',
        media_path: vr.filePath || null,
        duration: vr.duration, status: 'ready'
      });
    } catch (_) {}
    res.json({ ok: true, render: vr });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/content/:id/render', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const rec = v14.videoRender.getStatus(req.params.id);
    if (!rec) return res.status(404).json({ error: 'no render yet' });
    res.json(rec);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/video-render/list', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const r = v14.videoRender.list({ limit: parseInt((req.query || {}).limit) || 50 });
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── [P3-C2] 视频调度器：状态 / 手工触发 ──
app.get('/api/v14/video-scheduler/stats', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14 || !v14.videoScheduler) return res.status(503).json({ error: 'video scheduler unavailable' });
    res.json(v14.videoScheduler.stats());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 手工触发一次调度。force=1 可绕过时间窗与配额（用于验收/联调）。
app.post('/api/v14/video-scheduler/run', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14 || !v14.videoScheduler) return res.status(503).json({ error: 'video scheduler unavailable' });
    const b = req.body || {};
    const r = await v14.videoScheduler.tick({
      force: b.force === true || b.force === '1' || b.force === 1,
      limit: parseInt(b.limit, 10) || undefined,
      duration: parseInt(b.duration, 10) || undefined,
    });
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 视频文件直读（浏览器可直接预览真实渲染的 mp4）
app.get('/api/v14/media/video/:id', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const rec = v14.videoRender.getStatus(req.params.id);
    if (!rec || !rec.filePath || !fs.existsSync(rec.filePath)) return res.status(404).json({ error: 'video not found' });
    res.sendFile(rec.filePath);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Tumblr 真实 OAuth1.0a 发布 ─────────────────────
app.get('/api/v14/tumblr/status', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    res.json(v14.tumblrPublisher.getStatus());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 列出所有已授权可用的 Tumblr 发布账号（供发布面板下拉选择）
app.get('/api/v14/tumblr/accounts', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const ds = v14.dataStore;
    const map = ds && ds._cache ? ds._cache.get('tumblr_token') : null;
    const list = [];
    if (map) {
      for (const [id, t] of map.entries()) {
        if (t && t.oauthToken && t.oauthTokenSecret) list.push({ id, blogName: t.blogName || '' });
      }
    }
    res.json({ ok: true, count: list.length, accounts: list, default: v14.tumblrPublisher._defaultAccountId() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/tumblr/consumer', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const { consumerKey, consumerSecret } = req.body || {};
    v14.tumblrPublisher.setConsumerKey(consumerKey, consumerSecret);
    res.json({ ok: true, status: v14.tumblrPublisher.getStatus() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 【2026-09-10】支持 accountId：批量补授权时每个账号独立走 begin/complete。
// 原先写死默认账号（beginAuth()/completeAuth(verifier)），导致 111 个 token 之外的
// 账号永远无法补授权，发布时只能兜底借用他人 token（已修）或被标记 NO_OAUTH_TOKEN。
app.post('/api/v14/tumblr/oauth/begin', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    // callbackUrl 必须与 Tumblr App 后台登记的 OAuth2/OAuth1 redirect URL 完全一致，
    // 默认 'oob' 已被 Tumblr 拒绝（400 Disallowed oauth_callback specified）。
    // 本项目注册流程用的是 http://localhost:3122/callback（见 tumblr-onboard.js）。
    const { accountId, callbackUrl } = req.body || {};
    const target = accountId || 'main';
    const cb = callbackUrl || process.env.TUMBLR_OAUTH_CALLBACK || 'http://localhost:3122/callback';
    const r = await v14.tumblrPublisher.beginAuth(target, cb);
    res.json({ ok: true, accountId: target, callbackUrl: cb, authorizeUrl: r.authorizeUrl, oauthToken: r.oauthToken });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/tumblr/oauth/complete', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const { verifier, accountId } = req.body || {};
    if (!verifier) return res.status(400).json({ error: 'verifier required' });
    const target = accountId || 'main';
    const r = await v14.tumblrPublisher.completeAuth(verifier, target);
    res.json({ ok: true, accountId: target, status: v14.tumblrPublisher.getStatus() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 直接发布一段已渲染的视频到 Tumblr（返回真实 post_url）
app.post('/api/v14/tumblr/publish', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const { videoId, caption, tags, accountId } = req.body || {};
    const rec = videoId ? v14.videoRender.getStatus(videoId) : null;
    if (!rec || !rec.filePath) return res.status(400).json({ error: 'valid videoId required' });
    const r = await v14.tumblrPublisher.publishVideo({ filePath: rec.filePath, caption, tags, accountId });
    res.json({ ok: true, postUrl: r.postUrl, id: r.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 并发/分批真实视频批量发布（返回 taskId，后台异步执行）
app.post('/api/v14/tumblr/batch-publish', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14 || !v14.tumblrBatchPublisher) return res.status(500).json({ error: 'v14 not initialized' });
    const { videoId, accountIds, concurrency, batchSize, batchDelayMs, caption, tags } = req.body || {};
    if (!videoId) return res.status(400).json({ error: 'videoId required' });
    if (!Array.isArray(accountIds) || !accountIds.length) return res.status(400).json({ error: 'accountIds[] required' });
    const taskId = v14.tumblrBatchPublisher.startBatch({ videoId, accountIds, concurrency, batchSize, batchDelayMs, caption, tags });
    const t = v14.tumblrBatchPublisher.getTask(taskId);
    res.json({ ok: true, taskId, status: t.status, total: t.total });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 查询批量发布任务进度（零伪造，仅返回真实发布结果）
app.get('/api/v14/tumblr/batch-publish/:id', (req, res) => {
  try {
    const v14 = initV14();
    if (!v14 || !v14.tumblrBatchPublisher) return res.status(500).json({ error: 'v14 not initialized' });
    const t = v14.tumblrBatchPublisher.getTask(req.params.id);
    if (!t) return res.status(404).json({ error: 'task not found' });
    res.json({
      id: t.id, status: t.status, total: t.total, done: t.done, success: t.success, fail: t.fail,
      startedAt: t.startedAt, finishedAt: t.finishedAt, folder: t.folder, excel: t.excel, zip: t.zip,
      error: t.error, results: t.results
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 批量任务列表
app.get('/api/v14/tumblr/batch-publish', (req, res) => {
  try {
    const v14 = initV14();
    if (!v14 || !v14.tumblrBatchPublisher) return res.status(500).json({ error: 'v14 not initialized' });
    res.json({ tasks: v14.tumblrBatchPublisher.listTasks() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 失败账号一键重发：挑出某任务未成功的账号，复用原视频/文案重新发布
app.post('/api/v14/tumblr/batch-publish/:id/resend', (req, res) => {
  try {
    const v14 = initV14();
    if (!v14 || !v14.tumblrBatchPublisher) return res.status(500).json({ error: 'v14 not initialized' });
    const newId = v14.tumblrBatchPublisher.resendFailed(req.params.id);
    if (!newId) return res.status(400).json({ error: '无失败账号或任务不存在' });
    res.json({ ok: true, taskId: newId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 下载 Excel 报告
app.get('/api/v14/tumblr/batch-publish/:id/excel', (req, res) => {
  try {
    const v14 = initV14();
    if (!v14 || !v14.tumblrBatchPublisher) return res.status(500).json({ error: 'v14 not initialized' });
    const t = v14.tumblrBatchPublisher.getTask(req.params.id);
    if (!t || !t.excel || !fs.existsSync(t.excel)) return res.status(404).json({ error: 'excel not ready' });
    res.download(t.excel, 'publish_report.xlsx');
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 下载压缩包（视频 + Excel）
app.get('/api/v14/tumblr/batch-publish/:id/zip', (req, res) => {
  try {
    const v14 = initV14();
    if (!v14 || !v14.tumblrBatchPublisher) return res.status(500).json({ error: 'v14 not initialized' });
    const t = v14.tumblrBatchPublisher.getTask(req.params.id);
    if (!t || !t.zip || !fs.existsSync(t.zip)) return res.status(404).json({ error: 'zip not ready' });
    res.download(t.zip, req.params.id + '.zip');
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── P2 发布回采（不依赖 MySQL）────────────────────────────────────────
// engagement-harvester 依赖 MySQL matrix_posts_published 表；MySQL 未运行时整体不可用，
// 导致「发布后到底有没有效果」始终无数据。本路由改为：
//   DataStore publish 记录 → Tumblr 官方 posts 接口拉真实 note_count → 独立结果文件。
// 结果写 post_metrics.json（不进 DataStore），避免与 5s flush 抢写导致回滚。
app.post('/api/v14/tumblr/post-metrics/harvest', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14 || !v14.tumblrPublisher) return res.status(500).json({ error: 'v14/tumblrPublisher not initialized' });
    const body = req.body || {};
    const maxBlogs = Math.max(1, Math.min(Number(body.maxBlogs || 8), 200));
    const metricsFile = path.join(PATHS.DATA_DIR, 'post_metrics.json');

    // 1) 取已发布记录
    let pubRows = [];
    try {
      const r = (v14.dataStore && v14.dataStore.list)
        ? v14.dataStore.list('publish', { limit: 5000 })
        : null;
      const items = (r && r.items) ? r.items : (Array.isArray(r) ? r : []);
      pubRows = items.filter(p => p && p.publish_url);
    } catch (e) {
      return res.status(500).json({ error: 'read publish failed: ' + e.message });
    }
    if (!pubRows.length) return res.json({ ok: true, note: 'no publish records', blogs: 0, matched: 0 });

    // 2) 解析 blogName / postId 并按 blog 分组
    const parse = (u) => {
      if (!u) return null;
      const s = String(u).trim();
      let m = s.match(/tumblr\.com\/blog\/view\/([^/?#]+)\/([^/?#]+)/);
      if (m) return { blogName: m[1], postId: m[2] };
      m = s.match(/([a-z0-9_-]+)\.tumblr\.com\/post\/(\d+)/i);
      if (m) return { blogName: m[1], postId: m[2] };
      return null;
    };
    const byBlog = new Map();
    for (const p of pubRows) {
      const info = parse(p.publish_url);
      if (!info) continue;
      if (!byBlog.has(info.blogName)) byBlog.set(info.blogName, []);
      byBlog.get(info.blogName).push({ postId: info.postId, rec: p });
    }

    // 3) 逐 blog 调官方接口（限流：每 blog 一次，间隔 800ms）
    let prev = {};
    try { prev = JSON.parse(fs.readFileSync(metricsFile, 'utf8')) || {}; } catch (e) { prev = {}; }
    const posts = (prev && prev.posts) ? prev.posts : {};
    const out = { blogs: 0, fetched: 0, matched: 0, withNotes: 0, errors: [] };
    const blogs = Array.from(byBlog.keys()).slice(0, maxBlogs);

    for (const blog of blogs) {
      out.blogs++;
      try {
        const r = await v14.tumblrPublisher.getBlogPosts(blog, { limit: 50, notesInfo: true });
        const list = (r && r.posts) ? r.posts : (Array.isArray(r) ? r : (r && r.response ? r.response : []));
        const map = new Map();
        for (const po of list) {
          const pid = String(po.id_string || po.id || '');
          if (pid) map.set(pid, po);
        }
        out.fetched += list.length;
        for (const { postId, rec } of byBlog.get(blog)) {
          const po = map.get(String(postId));
          if (!po) continue;
          out.matched++;
          const notes = Number(po.note_count || 0);
          if (notes > 0) out.withNotes++;
          const key = String(postId);
          const old = posts[key] || {};
          const hist = Array.isArray(old.history) ? old.history : [];
          if (old.note_count !== notes) {
            hist.push({ t: new Date().toISOString(), n: notes });
          }
          posts[key] = {
            post_id: key, blog, url: rec.publish_url || old.url || '',
            title: rec.content_title || old.title || '',
            account_id: rec.account_id || old.account_id || '',
            note_count: notes,
            baseline: (old.baseline === undefined) ? notes : old.baseline,
            history: hist.slice(-30),
            updated_at: new Date().toISOString(),
          };
        }
      } catch (e) {
        out.errors.push({ blog, error: String(e && e.message || e) });
      }
      await new Promise(x => setTimeout(x, 800));
    }

    const snapshot = {
      updated_at: new Date().toISOString(),
      total_publish: pubRows.length,
      total_blogs: byBlog.size,
      harvested_blogs: Array.isArray(prev.harvested_blogs)
        ? Array.from(new Set(prev.harvested_blogs.concat(blogs)))
        : blogs,
      counts: { blogs: out.blogs, fetched: out.fetched, matched: out.matched, withNotes: out.withNotes },
      posts,
    };
    fs.writeFileSync(metricsFile, JSON.stringify(snapshot, null, 2), 'utf8');
    res.json({ ok: true, ...out, file: metricsFile, total_publish: pubRows.length, total_blogs: byBlog.size });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 回采结果读取（供日报/前端使用，零伪造：无数据即返回空）
app.get('/api/v14/tumblr/post-metrics', (req, res) => {
  try {
    const metricsFile = path.join(PATHS.DATA_DIR, 'post_metrics.json');
    let j = {};
    try { j = JSON.parse(fs.readFileSync(metricsFile, 'utf8')); } catch (e) { j = {}; }
    const posts = Object.values(j.posts || {});
    const limit = Math.max(1, Math.min(Number(req.query.limit || 50), 1000));
    const minNotes = Number(req.query.minNotes || 0);
    const top = posts
      .filter(p => Number(p.note_count || 0) >= minNotes)
      .sort((a, b) => Number(b.note_count || 0) - Number(a.note_count || 0))
      .slice(0, limit);
    res.json({
      ok: true,
      updated_at: j.updated_at || null,
      total_publish: j.total_publish || 0,
      total_blogs: j.total_blogs || 0,
      harvested_blogs: (j.harvested_blogs || []).length,
      tracked_posts: posts.length,
      total_notes: posts.reduce((s, p) => s + Number(p.note_count || 0), 0),
      items: top,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 真实数据回收（engagement-harvester）：拉取已发布帖真实 note_count ──
app.post('/api/v14/tumblr/engagement/harvest', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14 || !v14.engagement) return res.status(500).json({ error: 'v14 not initialized' });
    const maxPerRun = req.body && req.body.maxPerRun ? parseInt(req.body.maxPerRun, 10) : 300;
    const r = await v14.engagement.harvest({ maxPerRun });
    res.json({ ok: true, ...r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 正向内容榜（基于真实 note_count，零伪造）
app.get('/api/v14/tumblr/engagement/positive', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14 || !v14.engagement) return res.status(500).json({ error: 'v14 not initialized' });
    const minNotes = parseInt(req.query.minNotes || '50', 10);
    const minGrowthPct = parseInt(req.query.minGrowthPct || '30', 10);
    const limit = parseInt(req.query.limit || '50', 10);
    const items = await v14.engagement.getPositive({ minNotes, minGrowthPct, limit });
    res.json({ ok: true, count: items.length, items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 跨账号二次创作：把正向视频 reblog 复制到其它账号（每个目标携带拟人化变体评论/标签）
app.post('/api/v14/tumblr/remix', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14 || !v14.tumblrBatchPublisher) return res.status(500).json({ error: 'v14 not initialized' });
    const { sourcePostUrl, targetAccountIds, comment, tags, humanize, captionVariants, jitter, warmupCount, batchSize, batchDelayMs, concurrency } = req.body || {};
    if (!sourcePostUrl) return res.status(400).json({ error: 'sourcePostUrl required' });
    if (!Array.isArray(targetAccountIds) || !targetAccountIds.length) return res.status(400).json({ error: 'targetAccountIds required' });
    const taskId = v14.tumblrBatchPublisher.startRemix({
      sourcePostUrl, targetAccountIds, comment, tags, humanize, captionVariants, jitter, warmupCount, batchSize, batchDelayMs, concurrency
    });
    const t = v14.tumblrBatchPublisher.getTask(taskId);
    res.json({ ok: true, taskId, status: t ? t.status : 'running', total: t ? t.total : 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 图文批量发布（postPhoto）：把一张图片（本地路径或 sourceUrl）+ 文案真实发布到多账号
app.post('/api/v14/tumblr/photo-batch', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14 || !v14.tumblrBatchPublisher) return res.status(500).json({ error: 'v14 not initialized' });
  const { imagePath, sourceUrl, accountIds, caption, tags, humanize, captionVariants, jitter, warmupCount, batchSize, batchDelayMs, concurrency } = req.body || {};
    if (!Array.isArray(accountIds) || !accountIds.length) return res.status(400).json({ error: 'accountIds required' });
    const taskId = v14.tumblrBatchPublisher.startPhotoBatch({
      imagePath, sourceUrl, accountIds, caption, tags, humanize, captionVariants, jitter, warmupCount, batchSize, batchDelayMs, concurrency
    });
    if (typeof taskId !== 'string') return res.status(400).json(taskId);
    const t = v14.tumblrBatchPublisher.getTask(taskId);
    res.json({ ok: true, taskId, status: t ? t.status : 'running', total: t ? t.total : 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Tumblr 第二阶段真实养号引擎 API（零假数据，全部真实 API） ──
app.get('/api/v14/tumblr-nurture/status', (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const eng = v14.tumblrNurture;
    res.json({
      running: !!eng._timer,
      tickMs: eng._tickMs,
      totalAccounts: eng.accounts.length,
      snapshot: eng.snapshot(),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/tumblr-nurture/start', (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const eng = v14.tumblrNurture;
    if (eng._timer) return res.json({ ok: true, alreadyRunning: true, totalAccounts: eng.accounts.length });
    eng.start();
    res.json({ ok: true, running: true, totalAccounts: eng.accounts.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/tumblr-nurture/stop', (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    v14.tumblrNurture.stop();
    res.json({ ok: true, running: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 手动跑单个账号的某个阶段（用于验证 / 补跑，真实 API）
app.post('/api/v14/tumblr-nurture/run-one', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const { accountId, phase, opts } = req.body || {};
    if (!accountId) return res.status(400).json({ error: 'accountId required' });
    const eng = v14.tumblrNurture;
    if (!eng.states.has(accountId)) return res.status(404).json({ error: 'account not loaded (terminated or not tumblr)' });
    const r = await eng.runPhaseNow(accountId, phase || 'P0', opts || {});
    res.json({ ok: true, accountId, phase: phase || 'P0', result: r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/tumblr-nurture/accounts', (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const eng = v14.tumblrNurture;
    const rows = eng.accounts.map(a => {
      const tok = v14.dataStore.get('tumblr_token', a.id);
      return { id: a.id, blog: (tok && tok.blogName) || null, authorized: !!(tok && tok.oauthToken), email: a.email || null };
    });
    res.json({ total: rows.length, accounts: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});




// ── Mixpost 风格内容运营 / 发布台 API ────────────────
app.get('/api/v14/mixpost/providers', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    res.json(v14.providerManager.providers());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Bluesky 免费凭证配置（App Password，无需开发者门户/App 注册）──
// 存入 dataStore('bluesky_config','main')；响应不回显明文密码。
app.get('/api/v14/mixpost/provider/bluesky/config', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const cfg = (v14.dataStore.get('bluesky_config', 'main')) || {};
    const p = v14.providerManager.connect('bluesky', {});
    const status = p.configStatus();
    res.json({ ok: true, configured: status.configured, pdsHost: cfg.pdsHost || 'https://bsky.social', identifier: cfg.identifier || '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/mixpost/provider/bluesky/config', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const { identifier, appPassword, pdsHost } = req.body || {};
    if (!identifier || !appPassword) {
      return res.status(400).json({ ok: false, error: 'identifier 与 appPassword 均为必填（免费：Bluesky 设置 → App Passwords → 生成）' });
    }
    const patch = { identifier, appPassword, pdsHost: (pdsHost || 'https://bsky.social').replace(/\/+$/, '') };
    // dataStore.update 在记录不存在时静默返回 null（不创建），故先 get 判定 create / update
    if (v14.dataStore.get('bluesky_config', 'main')) {
      v14.dataStore.update('bluesky_config', 'main', patch);
    } else {
      v14.dataStore.create('bluesky_config', Object.assign({ id: 'main' }, patch));
    }
    res.json({ ok: true, configured: true, identifier, pdsHost: patch.pdsHost });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 清除 Bluesky 凭证（用户可随时撤销）
app.delete('/api/v14/mixpost/provider/bluesky/config', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    v14.dataStore.delete('bluesky_config', 'main');
    res.json({ ok: true, configured: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// === Mastodon 免费凭证端点（instance + accessToken，设置中自助生成，无需开发者门户/付费/审核）===
app.get('/api/v14/mixpost/provider/mastodon/config', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const cfg = (v14.dataStore.get('mastodon_config', 'main')) || {};
    const p = v14.providerManager.connect('mastodon', {});
    const status = p.configStatus();
    res.json({ ok: true, configured: status.configured, instance: cfg.instance || 'https://mastodon.social' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/mixpost/provider/mastodon/config', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const { instance, accessToken } = req.body || {};
    if (!instance || !accessToken) {
      return res.status(400).json({ ok: false, error: 'instance 与 accessToken 均为必填（免费：Mastodon 设置 → 开发 → 个人访问令牌）' });
    }
    const patch = { instance: (instance || 'https://mastodon.social').replace(/\/+$/, ''), accessToken };
    // dataStore.update 在记录不存在时静默返回 null（不创建），故先 get 判定 create / update
    if (v14.dataStore.get('mastodon_config', 'main')) {
      v14.dataStore.update('mastodon_config', 'main', patch);
    } else {
      v14.dataStore.create('mastodon_config', Object.assign({ id: 'main' }, patch));
    }
    res.json({ ok: true, configured: true, instance: patch.instance });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 清除 Mastodon 凭证（用户可随时撤销）
app.delete('/api/v14/mixpost/provider/mastodon/config', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    v14.dataStore.delete('mastodon_config', 'main');
    res.json({ ok: true, configured: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 第三方官方免费凭证渠道（无需开发者门户/付费/审核）=====

// ── Telegram：@BotFather /newbot 即时下发 bot token；频道 chat_id 用 getUpdates 取 ──
app.get('/api/v14/mixpost/provider/telegram/config', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const cfg = (v14.dataStore.get('telegram_config', 'main')) || {};
    const p = v14.providerManager.connect('telegram', {});
    const st = p.configStatus();
    res.json({ ok: true, configured: st.configured, chatId: cfg.chatId || '', hasBotToken: !!(cfg.botToken) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/v14/mixpost/provider/telegram/config', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const { botToken, chatId } = req.body || {};
    if (!botToken || !chatId) return res.status(400).json({ ok: false, error: 'botToken 与 chatId 均为必填（免费：@BotFather → /newbot → 获得 token；频道 chat_id 用 getUpdates 取）' });
    const patch = { botToken, chatId: String(chatId) };
    if (v14.dataStore.get('telegram_config', 'main')) v14.dataStore.update('telegram_config', 'main', patch);
    else v14.dataStore.create('telegram_config', Object.assign({ id: 'main' }, patch));
    res.json({ ok: true, configured: true, chatId: patch.chatId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/v14/mixpost/provider/telegram/config', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    v14.dataStore.delete('telegram_config', 'main');
    res.json({ ok: true, configured: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Discord：服务器设置 → 集成 → Webhooks 生成 Webhook URL（官方免费、无审核）──
app.get('/api/v14/mixpost/provider/discord/config', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const cfg = (v14.dataStore.get('discord_config', 'main')) || {};
    const p = v14.providerManager.connect('discord', {});
    const st = p.configStatus();
    res.json({ ok: true, configured: st.configured, hasWebhook: !!(cfg.webhookUrl) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/v14/mixpost/provider/discord/config', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const { webhookUrl } = req.body || {};
    if (!webhookUrl) return res.status(400).json({ ok: false, error: 'webhookUrl 必填（免费：Discord 服务器设置 → 集成 → Webhooks → 创建 → 复制 URL）' });
    const patch = { webhookUrl };
    if (v14.dataStore.get('discord_config', 'main')) v14.dataStore.update('discord_config', 'main', patch);
    else v14.dataStore.create('discord_config', Object.assign({ id: 'main' }, patch));
    res.json({ ok: true, configured: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/v14/mixpost/provider/discord/config', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    v14.dataStore.delete('discord_config', 'main');
    res.json({ ok: true, configured: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DEV.to：设置页生成 API Key（POST /api/articles）──
app.get('/api/v14/mixpost/provider/devto/config', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const cfg = (v14.dataStore.get('devto_config', 'main')) || {};
    const p = v14.providerManager.connect('devto', {});
    const st = p.configStatus();
    res.json({ ok: true, configured: st.configured, hasApiKey: !!(cfg.apiKey) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/v14/mixpost/provider/devto/config', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const { apiKey } = req.body || {};
    if (!apiKey) return res.status(400).json({ ok: false, error: 'apiKey 必填（免费：dev.to → Settings → Extensions → DEV Community API Keys → Generate）' });
    const patch = { apiKey };
    if (v14.dataStore.get('devto_config', 'main')) v14.dataStore.update('devto_config', 'main', patch);
    else v14.dataStore.create('devto_config', Object.assign({ id: 'main' }, patch));
    res.json({ ok: true, configured: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/v14/mixpost/provider/devto/config', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    v14.dataStore.delete('devto_config', 'main');
    res.json({ ok: true, configured: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Hashnode：设置页生成 Personal Access Token；需 publicationId ──
app.get('/api/v14/mixpost/provider/hashnode/config', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const cfg = (v14.dataStore.get('hashnode_config', 'main')) || {};
    const p = v14.providerManager.connect('hashnode', {});
    const st = p.configStatus();
    res.json({ ok: true, configured: st.configured, publicationId: cfg.publicationId || '', hasToken: !!(cfg.token) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/v14/mixpost/provider/hashnode/config', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const { token, publicationId } = req.body || {};
    if (!token || !publicationId) return res.status(400).json({ ok: false, error: 'token 与 publicationId 均为必填（免费：Hashnode → Dashboard → Settings → Developer → Generate Token；Publication ID 见出版物设置 URL）' });
    const patch = { token, publicationId };
    if (v14.dataStore.get('hashnode_config', 'main')) v14.dataStore.update('hashnode_config', 'main', patch);
    else v14.dataStore.create('hashnode_config', Object.assign({ id: 'main' }, patch));
    res.json({ ok: true, configured: true, publicationId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/v14/mixpost/provider/hashnode/config', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    v14.dataStore.delete('hashnode_config', 'main');
    res.json({ ok: true, configured: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Nostr：本地生成 secp256k1 密钥（零账号/零第三方/免费）──
app.get('/api/v14/mixpost/provider/nostr/config', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const cfg = (v14.dataStore.get('nostr_config', 'main')) || {};
    const p = v14.providerManager.connect('nostr', {});
    const st = p.configStatus();
    let npub = '';
    if (cfg.privateKey) {
      try { const k = p._resolveKeys(); npub = require('./providers/nostr-provider.js').encodeNpubNsec('npub', k.pubHex); } catch (e) { npub = ''; }
    }
    res.json({ ok: true, configured: st.configured, npub, relays: cfg.relays || '', hasKey: !!(cfg.privateKey) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// 本地生成新密钥对并返回 nsec/npub（用户需自行备份 nsec；仅本地生成，绝不上报）
app.post('/api/v14/mixpost/provider/nostr/generate', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const p = v14.providerManager.connect('nostr', {});
    const keys = p.generateKeys();
    const patch = { privateKey: keys.privateKeyHex, relays: (req.body && req.body.relays) || '' };
    if (v14.dataStore.get('nostr_config', 'main')) v14.dataStore.update('nostr_config', 'main', patch);
    else v14.dataStore.create('nostr_config', Object.assign({ id: 'main' }, patch));
    // 一次性回显 nsec（私钥），供用户备份；之后不再返回明文
    res.json({ ok: true, configured: true, nsec: keys.nsec, npub: keys.npub, privateKeyHex: keys.privateKeyHex });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/v14/mixpost/provider/nostr/config', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const { privateKey, relays } = req.body || {};
    if (!privateKey) return res.status(400).json({ ok: false, error: 'privateKey 必填（64 位 hex 或 nsec1...）；也可调用 /generate 在本地创建' });
    const patch = { privateKey, relays: relays || '' };
    if (v14.dataStore.get('nostr_config', 'main')) v14.dataStore.update('nostr_config', 'main', patch);
    else v14.dataStore.create('nostr_config', Object.assign({ id: 'main' }, patch));
    res.json({ ok: true, configured: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/v14/mixpost/provider/nostr/config', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    v14.dataStore.delete('nostr_config', 'main');
    res.json({ ok: true, configured: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GitHub：官方 PAT 即时生成·零手机/零审核·Gist/仓库真实发布 ──
app.get('/api/v14/mixpost/provider/github/config', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const cfg = (v14.dataStore.get('github_config', 'main')) || {};
    const p = v14.providerManager.connect('github', {});
    const st = p.configStatus();
    res.json({ ok: true, configured: st.configured, hasToken: !!(cfg.token), target: cfg.target || 'gist' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/v14/mixpost/provider/github/config', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const { token, target, repo, path } = req.body || {};
    if (!token) return res.status(400).json({ ok: false, error: 'token 必填（免费 PAT：github.com → 头像 → Settings → Developer settings → PAT → Generate，勾选 gist 权限，约 30 秒）' });
    const patch = { token, target: target || 'gist', repo: repo || '', path: path || '' };
    if (v14.dataStore.get('github_config', 'main')) v14.dataStore.update('github_config', 'main', patch);
    else v14.dataStore.create('github_config', Object.assign({ id: 'main' }, patch));
    res.json({ ok: true, configured: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/v14/mixpost/provider/github/config', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    v14.dataStore.delete('github_config', 'main');
    res.json({ ok: true, configured: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/mixpost/provider/:name/auth-url', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const p = v14.providerManager.connect(req.params.name, {});
    const url = await p.getAuthUrl();
    res.json({ ok: true, url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/mixpost/provider/:name/token', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const p = v14.providerManager.connect(req.params.name, {});
    const r = await p.requestAccessToken(req.body || {});
    res.json({ ok: true, result: r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 发送一条真实测试帖子（验证免费凭据是否真的能发布）。用户主动触发（填完凭据后点「发送测试帖子」）。
// 仅支持已接真相提供方（bluesky / mastodon / tumblr）；诚实脚手架（twitter 等）一律返回未配置。
app.post('/api/v14/mixpost/provider/:name/test-publish', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const name = req.params.name;
    const p = v14.providerManager.connect(name, {});
    const st = p.configStatus();
    if (!st.configured) {
      return res.status(400).json({ ok: false, status: 'unconfigured', error: st.reason || (name + ' 尚未配置免费凭据') });
    }
    const text = (req.body && req.body.text) || ('MSCMS 连接测试 ✅ ' + new Date().toISOString().slice(0, 19));
    const resp = await p.publishPost(text, [], { visibility: 'public' });
    if (resp && resp.status === 'success') {
      // 当前免费渠道的真实发布确实推进因果链 S4（桥接在 server.js 监听 version:published）
      res.json({ ok: true, status: 'published', url: resp.url, id: resp.id, provider: name });
    } else {
      res.status(200).json({ ok: false, status: 'failed', error: (resp && resp.error) || '发布失败', provider: name });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── RSS Feed 出口（第三方自动化对接的统一源：DEV.to/Hashnode RSS 导入、n8n/Zapier 轮询）──
app.get('/api/v14/feed/rss', (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).send('<!-- error: v14 not initialized -->');
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const status = req.query.status || 'published';
    const r = v14.mixpost.listPosts({ filter: { status }, limit, sort: 'publishedAt', order: 'desc' });
    const posts = (r.items || []).filter(p => p.publishedAt || status !== 'published');
    const base = (process.env.PUBLIC_DOMAIN ? `https://${process.env.PUBLIC_DOMAIN}` : 'https://mscms.cc.cd');
    const selfUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]
    ));
    const items = posts.map((p) => {
      const text = p.text || '';
      const title = (text.split('\n')[0] || '').trim().slice(0, 120) || ('MSCMS Post ' + p.id);
      const link = `${base}/v14/post/${p.id}`;
      const pub = p.publishedAt || p.createdAt || new Date().toISOString();
      const cats = (p.accounts || []).map((a) => a.platform).filter(Boolean);
      const desc = text + (cats.length ? `\n\nChannels: ${cats.join(', ')}` : '');
      return `    <item>
      <title>${esc(title)}</title>
      <link>${esc(link)}</link>
      <guid isPermaLink="false">${esc(p.id)}</guid>
      <pubDate>${new Date(pub).toUTCString()}</pubDate>
      <description>${esc(desc)}</description>
${cats.map((c) => `      <category>${esc(c)}</category>`).join('\n')}
    </item>`;
    }).join('\n');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>MSCMS v14 Feed</title>
    <link>${esc(base)}</link>
    <description>MSCMS v14 自动发布 Feed —— 第三方自动化（DEV.to/Hashnode RSS 导入、n8n/Zapier 轮询）对接源</description>
    <atom:link href="${esc(selfUrl)}" rel="self" type="application/rss+xml"/>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>`;
    res.set('Content-Type', 'application/rss+xml; charset=utf-8');
    res.send(xml);
  } catch (e) {
    res.status(500).send(`<!-- error: ${e.message} -->`);
  }
});

// ── 实时 Webhook 推送器（帖子真实发布 → POST 到 n8n/Zapier 等第三方自动化中枢）──
// 设计要点：
//  - 仅在帖子【真实发布成功】时由 version:published 钩子调用（禁假数据铁律）。
//  - URL 为 localhost/127.0.0.1 直连；否则若环境设了 HTTP_PROXY 则经 ProxyAgent 路由出网。
//  - 任何失败都被吞掉，绝不影响因果链 S4 与正常发布流程。
function getWebhookConfig() {
  try { const v14 = initV14(); return (v14 && v14.dataStore) ? (v14.dataStore.get('webhook_config', 'main') || null) : null; } catch (e) { return null; }
}

async function firePublishWebhook(payload) {
  let cfg = null;
  try { cfg = getWebhookConfig(); } catch (e) { return; }
  if (!cfg || !cfg.url) return; // 未配置，静默跳过
  const url = cfg.url;
  let dispatcher = undefined;
  try {
    const isLocal = /^(https?:\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/.test(url);
    if (!isLocal && process.env.HTTP_PROXY) {
      const { ProxyAgent } = require('undici');
      dispatcher = new ProxyAgent(process.env.HTTP_PROXY);
    }
  } catch (e) { /* undici 不可用则直连 */ }
  const body = JSON.stringify(payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-MSCMS-Event': payload.event || 'post.published' },
      body,
      dispatcher,
      signal: controller.signal,
    });
    console.log(`[webhook] ✅ 已推送 ${payload.event || 'post.published'} → ${url}`);
  } catch (e) {
    console.warn(`[webhook] ⚠️ 推送失败（不影响发布/因果链）: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// Webhook 配置端点（GET/POST/DELETE + 手动 test）
app.get('/api/v14/mixpost/webhook/config', (req, res) => {
  try {
    const cfg = getWebhookConfig();
    res.json({ ok: true, configured: !!(cfg && cfg.url), url: (cfg && cfg.url) || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/mixpost/webhook/config', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const { url } = (req.body || {});
    if (!url || !/^https?:\/\/.+/.test(url)) {
      return res.status(400).json({ ok: false, error: 'url 必填，且须为 http(s):// 开头的 n8n/Zapier Webhook 地址' });
    }
    const existing = getWebhookConfig();
    const rec = { url, updatedAt: new Date().toISOString() };
    let saved;
    if (existing) saved = v14.dataStore.update('webhook_config', 'main', rec);
    else saved = v14.dataStore.create('webhook_config', Object.assign({ id: 'main' }, rec, { createdAt: new Date().toISOString() }));
    res.json({ ok: true, configured: true, url: saved.url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/v14/mixpost/webhook/config', (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    v14.dataStore.delete('webhook_config', 'main');
    res.json({ ok: true, configured: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/mixpost/webhook/test', async (req, res) => {
  try {
    const cfg = getWebhookConfig();
    if (!cfg || !cfg.url) return res.status(400).json({ ok: false, error: '请先配置 webhook URL' });
    await firePublishWebhook({
      event: 'post.published',
      post: {
        id: 'test-' + Date.now(),
        title: 'Webhook 连接测试',
        text: '这是一条来自 MSCMS v14 的 Webhook 推送测试（非真实发布，仅验证连通性）。',
        mscmsUrl: 'https://mscms.cc.cd/v14/post/test',
        externalUrl: null,
        channels: ['test'],
        publishedAt: new Date().toISOString(),
      },
      source: 'mixpost',
      timestamp: new Date().toISOString(),
    });
    res.json({ ok: true, fired: true, url: cfg.url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/mixpost/posts', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const r = v14.mixpost.listPosts({
      filter: req.query.filter ? JSON.parse(req.query.filter) : undefined,
      search: req.query.search,
      page: +req.query.page || 1,
      limit: +req.query.limit || 20,
      sort: req.query.sort, order: req.query.order,
    });
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/mixpost/posts/:id', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const post = v14.mixpost.getPost(req.params.id);
    if (!post) return res.status(404).json({ error: 'post not found' });
    res.json(post);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/mixpost/posts', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    let data = req.body || {};
    // 适配 dashboard 请求格式: {title, tags:[names], versions:[{provider,content,media}], scheduledAt}
    const text = data.title || data.text || '';
    // resolve tag names → tagIds
    let tagIds = Array.isArray(data.tagIds) ? data.tagIds : [];
    if (data.tags && Array.isArray(data.tags) && data.tags.length && !tagIds.length) {
      const allGroups = v14.mixpost.listHashtagGroups();
      for (const tname of data.tags) {
        const g = allGroups.find(gr => gr.name === tname || gr.id === tname);
        if (g) tagIds.push(g.id);
      }
    }
    // resolve versions → accounts + per-platform content
    let accounts = Array.isArray(data.accounts) ? data.accounts : [];
    if (data.versions && Array.isArray(data.versions) && !accounts.length) {
      accounts = data.versions.map(v => ({
        id: `platform:${v.provider}`,
        platform: v.provider,
        name: v.provider,
      }));
    }
    const mapped = Object.assign({}, data, { title: data.title || null, text, tagIds, accounts, media: data.media || [] });
    const post = v14.mixpost.createPost(mapped);
    // 回写 per-platform 定制内容到版本
    if (data.versions && Array.isArray(data.versions)) {
      for (const ver of data.versions) {
        const accId = `platform:${ver.provider}`;
        const existing = v14.mixpost.listVersions(post.id).find(v => v.accountId === accId);
        if (existing) {
          v14.mixpost.updateVersion(existing.id, {
            content: ver.content || '',
            media: Array.isArray(ver.media) ? ver.media : [],
          });
        }
      }
    }
    res.json({ ok: true, post: v14.mixpost.getPost(post.id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/v14/mixpost/posts/:id', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const p = v14.mixpost.updatePost(req.params.id, req.body || {});
    if (!p) return res.status(404).json({ error: 'post not found' });
    res.json({ ok: true, post: p });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/v14/mixpost/posts/:id', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    v14.mixpost.deletePost(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/mixpost/posts/:id/publish', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const r = await v14.mixpost.publishPost(req.params.id);
    res.json({ ok: true, result: r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/v14/mixpost/versions/:id', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const v = v14.mixpost.updateVersion(req.params.id, req.body || {});
    res.json({ ok: true, version: v });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/mixpost/hashtag-groups', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    res.json(v14.mixpost.listHashtagGroups());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/mixpost/hashtag-groups', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const g = v14.mixpost.createHashtagGroup(req.body || {});
    res.json({ ok: true, group: g });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/v14/mixpost/hashtag-groups/:id', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    v14.mixpost.deleteHashtagGroup(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/content/strategy', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const { keywords, platform } = req.body || {};
    const strategy = v14.ruleEngine.generateStrategy(keywords || ['viral'], platform || 'tiktok');
    res.json(strategy);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── v14 智能发布 ────────────────────────────────
app.post('/api/v14/publish/schedule', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const { content, accounts, priority } = req.body || {};
    if (!accounts || !accounts.length) return res.status(400).json({ error: 'accounts required' });
    const tasks = await v14.publisher.schedulePublish(content || { platform: 'tiktok' }, accounts.map(a => ({ id: a, platform: 'tiktok' })), { priority });
    res.json({ scheduled: tasks.length, tasks });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/publish/execute', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const { tasks } = req.body || {};
    const results = await v14.publisher.publishBatch(tasks || []);
    res.json({ published: results.length, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/publish/optimal-time', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const time = v14.publisher.getOptimalTime(req.query.platform || 'tiktok');
    res.json(time);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── v14 数据反馈 ────────────────────────────────
app.post('/api/v14/tracking/start', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const { variantId, accountId, platform } = req.body || {};
    const tracker = v14.dataCollector.startTracking(variantId, accountId, platform);
    res.json({ tracking: true, tracker });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/tracking/update', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const { variantId, category, name, value } = req.body || {};
    v14.dataCollector.updateMetric(variantId, category, name, value);
    res.json({ updated: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/tracking/:variantId', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const perf = v14.dataCollector.getPerformanceSummary(req.params.variantId);
    if (!perf) return res.status(404).json({ error: 'not found' });
    res.json(perf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── v14 病毒信号检测 ────────────────────────────
app.get('/api/v14/viral/scan', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const signals = v14.viralDetector.scanAll(v14.dataCollector.metrics);
    res.json({ signals: signals.length, details: signals });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/viral/detect', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const signal = v14.viralDetector.detect(req.body || {});
    res.json(signal);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── v14 决策引擎 ────────────────────────────────
app.get('/api/v14/decision/status', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    res.json(v14.decisionEngine.getStats());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/decision/action', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const { signal } = req.body || {};
    const decision = await v14.decisionEngine.handleViralSignal(signal || { signalType: 'MODERATE_GROWTH', probability: 0.6, variantId: 'test', accountId: 'test' });
    res.json(decision || { message: 'no action needed' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── v14 自进化系统 ──────────────────────────────
app.get('/api/v14/evolution/report', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const report = v14.evolutionSystem.generateReport(req.query.period || 'daily');
    res.json(report);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/evolution/strategies', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const libraries = {};
    for (const [name, lib] of v14.evolutionSystem.strategyLibraries) {
      libraries[name] = {
        name: lib.name,
        bestStrategy: v14.evolutionSystem.getBestStrategy(name),
        strategies: lib.strategies.map(s => ({ id: s.id, name: s.name, weight: s.weight })),
      };
    }
    res.json(libraries);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── v14 AB测试 ──────────────────────────────────
app.post('/api/v14/ab-test/create', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const { name, variants, metrics } = req.body || {};
    const test = v14.abTestEngine.createTest(name || 'Test', variants || [{ name: 'A', config: {} }, { name: 'B', config: {} }], metrics);
    res.json(test);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/ab-test/record', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const { testId, variantId, metricName, value } = req.body || {};
    v14.abTestEngine.recordResult(testId, variantId, metricName, value);
    const result = v14.abTestEngine.determineWinner(testId);
    res.json({ recorded: true, abResult: result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════
//  V14 新增: GPS轨迹系统
// ══════════════════════════════════════════════════════
app.get('/api/v14/gps/paths', (req, res) => {
  try {
    const v14 = initV14();
    res.json({ paths: v14.gpsEngine.listPaths(), presets: Object.keys(v14.gpsEngine.presets) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/gps/create', (req, res) => {
  try {
    const v14 = initV14();
    const { name, speedModel, waypoints } = req.body;
    if (req.body.preset) {
      const path = v14.gpsEngine.createFromPreset(req.body.preset, name);
      return res.json({ created: true, pathId: path.id, ...path });
    }
    const path = v14.gpsEngine.createPath(name || '自定义轨迹', speedModel || 'driving', waypoints || []);
    res.json({ created: true, pathId: path.id, waypointCount: path.waypoints.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/gps/start', (req, res) => {
  try {
    const v14 = initV14();
    const { deviceIds, pathId, mode } = req.body;
    if (mode === 'staggered' && Array.isArray(deviceIds)) {
      const results = v14.gpsEngine.batchStart(deviceIds, pathId);
      return res.json({ mode: 'staggered', results });
    }
    const result = v14.gpsEngine.startForDevice(req.body.deviceId, pathId);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/gps/position/:deviceId', (req, res) => {
  try {
    const v14 = initV14();
    const pos = v14.gpsEngine.getCurrentPosition(parseInt(req.params.deviceId));
    res.json(pos || { error: '设备不在轨迹中' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/gps/status', (req, res) => {
  try {
    const v14 = initV14();
    res.json({ activeTrajectories: v14.gpsEngine.getActiveStatus() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════
//  V14 新增: Session 管理系统
// ══════════════════════════════════════════════════════
app.post('/api/v14/session/create', (req, res) => {
  try {
    const v14 = initV14();
    const { deviceId, platform, sessionData } = req.body;
    const snap = v14.sessionMgr.createSnapshot(deviceId, platform, sessionData || {});
    res.json({ created: true, snapshotId: snap.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/session/backup', (req, res) => {
  try {
    const v14 = initV14();
    const { deviceId, platform } = req.body;
    const result = v14.sessionMgr.backup(deviceId, platform);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/session/verify', (req, res) => {
  try {
    const v14 = initV14();
    const { deviceId, platform, version } = req.body;
    const result = v14.sessionMgr.verify(deviceId, platform, version);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/session/restore', (req, res) => {
  try {
    const v14 = initV14();
    const { deviceId, platform, version } = req.body;
    const snap = v14.sessionMgr.restore(deviceId, platform, version);
    res.json({ restored: true, version: snap.version, cookieCount: snap.data.cookies.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/session/migrate', (req, res) => {
  try {
    const v14 = initV14();
    if (req.body.batch) {
      const results = v14.sessionMgr.batchMigrate(req.body.migrations);
      return res.json({ batch: true, results });
    }
    const { sourceDeviceId, targetDeviceId, platform } = req.body;
    const result = v14.sessionMgr.migrate(sourceDeviceId, targetDeviceId, platform);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/session/stats', (req, res) => {
  try {
    const v14 = initV14();
    res.json(v14.sessionMgr.getStats());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/session/active', (req, res) => {
  try {
    const v14 = initV14();
    res.json({ sessions: v14.sessionMgr.listActive() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════
//  V14 新增: SCRM 截流系统
// ══════════════════════════════════════════════════════
app.post('/api/v14/scrm/intercept', (req, res) => {
  try {
    const v14 = initV14();
    if (req.body.batch) {
      const results = v14.scrmEngine.batchIntercept(req.body.comments);
      return res.json({ batch: true, total: req.body.comments.length, results });
    }
    const result = v14.scrmEngine.intercept(req.body);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/scrm/stats', (req, res) => {
  try {
    const v14 = initV14();
    res.json(v14.scrmEngine.getStats());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/scrm/review-queue', (req, res) => {
  try {
    const v14 = initV14();
    res.json(v14.scrmEngine.getReviewQueue());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/scrm/approve', (req, res) => {
  try {
    const v14 = initV14();
    const result = v14.scrmEngine.approveReply(req.body.reviewId);
    res.json({ approved: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/scrm/reject', (req, res) => {
  try {
    const v14 = initV14();
    const result = v14.scrmEngine.rejectReply(req.body.reviewId, req.body.reason);
    res.json({ rejected: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/scrm/keywords', (req, res) => {
  try {
    const v14 = initV14();
    res.json({ keywords: v14.scrmEngine.getStats().keywords || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/scrm/keywords', (req, res) => {
  try {
    const v14 = initV14();
    v14.scrmEngine.updateKeywords(req.body.keywords);
    res.json({ updated: true, keywords: req.body.keywords });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════
//  V14 新增: 代理管理系统
// ══════════════════════════════════════════════════════
app.post('/api/v14/proxy/add', (req, res) => {
  try {
    const v14 = initV14();
    if (req.body.batch) {
      const results = v14.proxyMgr.importProxies(req.body.proxies);
      return res.json({ batch: true, imported: results.length, results });
    }
    const proxy = v14.proxyMgr.addProxy(req.body);
    res.json({ added: true, ...proxy.toJSON() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/proxy/bind', (req, res) => {
  try {
    const v14 = initV14();
    const { deviceId, primaryProxyId, backupProxyIds } = req.body;
    const result = v14.proxyMgr.bindDevice(deviceId, primaryProxyId, backupProxyIds || []);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/proxy/list', (req, res) => {
  try {
    const v14 = initV14();
    // 【B0-D2 修复 2026-09-20】ProxyManager 的内存 Map（proxy-manager.js:211）只由
    // addProxy() 填充，而全仓没有任何启动路径把真实出口池导入进去 ⇒ 本端点恒返回
    // {"proxies":[],"bindings":[]}，「代理管理」页因此是空壳（用户看不到真实出口）。
    // 真实出口池在 D:/MSCMS-Desktop/resources/proxy-pool.json，由 cloud-publisher 的
    // pickExitForAccount() 消费。这里把它作为**只读**数据源一并返回，并标明各自来源，
    // 避免前端把「无设备绑定」误读成「系统没有代理」。
    let exitPool = { ok: false, source: null, total: 0, enabled: 0, items: [], error: 'module unavailable' };
    let exitSummary = null;
    try {
      const eps = require('./exit-pool-source.js');
      exitPool = eps.loadExitPool();
      exitSummary = eps.summarizeExitPool(exitPool);
    } catch (e) {
      exitPool = { ok: false, source: null, total: 0, enabled: 0, items: [], error: e.message };
      exitSummary = { ok: false, error: e.message, total: 0, enabled: 0, uniqueExitIps: 0 };
    }
    res.json({
      proxies: v14.proxyMgr.listProxies(),
      bindings: v14.proxyMgr.listBindings(),
      // exitPool 与 proxies/bindings 是**两套东西**：
      //   proxies/bindings = 设备↔代理绑定（ProxyManager，内存态）
      //   exitPool         = 发布出站用的真实出口池（文件态，权威）
      exitPool: { ...exitSummary, items: exitPool.items },
      _meta: {
        proxiesSource: 'ProxyManager(内存 · 设备代理绑定用)',
        exitPoolSource: exitPool.source || null,
        note: 'proxies/bindings 为空仅表示尚无设备-代理绑定；真实出口请读 exitPool',
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 【B0-D2】出口池专用端点 —— 只读、无副作用（不探活）
// 大盘 / 代理管理页用它展示真实出口与容量水位，避免每次拉全量 items。
app.get('/api/v14/proxy/pool', (req, res) => {
  try {
    const eps = require('./exit-pool-source.js');
    const includeDisabled = req.query.includeDisabled !== '0' && req.query.includeDisabled !== 'false';
    const pool = eps.loadExitPool({ includeDisabled });
    // 容量水位需要「当前可发布账号数」才能算越线；调用方传值优先，缺省自动推算（见 resolvePublishableAccounts）
    const pub = resolvePublishableAccounts(parseInt(req.query.publishableAccounts, 10));
    const summary = eps.summarizeExitPool(
      eps.loadExitPool(), // 摘要按全量算，不受 includeDisabled 影响
      pub.value != null ? { publishableAccounts: pub.value } : {}
    );
    res.set('Cache-Control', 'no-store').json({
      ...summary,
      items: pool.items,
      includeDisabled,
      publishableAccounts: pub.value,
      publishableSource: pub.source,
      ...(pub.error ? { publishableError: pub.error } : {}),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 【B2 补全 B0-D2】出口容量水位所需的「可发布账号数」推定
// ─────────────────────────────────────────────────────────────
// 原实现要求调用方显式传 ?publishableAccounts=N，否则 overLine/utilization 恒为 null
// ⇒ 默认调用下「出口越线」这个头号风险指标是隐形的。
// 这里改为：优先用调用方传值（便于压测量算）；缺省时从 live 账号源自动推算，并标明依据。
// 可发布定义 = platform=tumblr 且已通过 OAuth 授权（hasApiToken）且判定为真实账号（is_valid=1）。
// 该判定与 buildLiveManagedAccounts() 完全同源，避免口径漂移。
function resolvePublishableAccounts(explicit) {
  if (Number.isFinite(explicit) && explicit > 0) {
    return { value: explicit, source: 'query' };
  }
  try {
    const built = buildLiveManagedAccounts();
    const rows = Array.isArray(built && built.accounts) ? built.accounts : [];
    const n = rows.filter((r) => r && r.platform === 'tumblr' && r.hasApiToken && r.is_valid === 1).length;
    return { value: n, source: 'live(accounts.json∩tumblr_token.json: platform=tumblr & hasApiToken & is_valid)' };
  } catch (e) {
    return { value: null, source: null, error: e.message };
  }
}

app.get('/api/v14/proxy/pool/summary', (req, res) => {
  try {
    const eps = require('./exit-pool-source.js');
    const pub = resolvePublishableAccounts(parseInt(req.query.publishableAccounts, 10));
    const summary = eps.summarizeExitPool(
      eps.loadExitPool(),
      pub.value != null ? { publishableAccounts: pub.value } : {}
    );
    res.set('Cache-Control', 'no-store').json({
      ...summary,
      publishableAccounts: pub.value,
      publishableSource: pub.source,
      ...(pub.error ? { publishableError: pub.error } : {}),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/proxy/health/:proxyId', async (req, res) => {
  try {
    const v14 = initV14();
    const result = await v14.proxyMgr.checkProxy(req.params.proxyId);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/proxy/health-all', async (req, res) => {
  try {
    const v14 = initV14();
    const result = await v14.proxyMgr.checkAll();
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/proxy/stats', (req, res) => {
  try {
    const v14 = initV14();
    res.json(v14.proxyMgr.getStats());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════
//  V14 新增: 传感器模拟系统
// ══════════════════════════════════════════════════════
app.get('/api/v14/sensor/readings/:deviceId', (req, res) => {
  try {
    const v14 = initV14();
    const readings = v14.sensorSim.getDeviceReadings(parseInt(req.params.deviceId));
    res.json(readings || { error: '设备未注册传感器' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/sensor/all', (req, res) => {
  try {
    const v14 = initV14();
    res.json(v14.sensorSim.getAllReadings());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/sensor/dashboard', (req, res) => {
  try {
    const v14 = initV14();
    res.json(v14.sensorSim.getDashboard());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/sensor/history/:deviceId/:sensorId', (req, res) => {
  try {
    const v14 = initV14();
    const hours = parseInt(req.query.hours) || 24;
    const history = v14.sensorSim.getDeviceHistory(parseInt(req.params.deviceId), req.params.sensorId, hours);
    res.json({ deviceId: parseInt(req.params.deviceId), sensorId: req.params.sensorId, hours, history });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════
//  V14 新增: DAG 任务编排系统
// ══════════════════════════════════════════════════════
app.get('/api/v14/dag/workflows', (req, res) => {
  try {
    const v14 = initV14();
    res.json({ workflows: v14.dagOrch.listWorkflows() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/dag/workflow/:dagId', (req, res) => {
  try {
    const v14 = initV14();
    const dag = v14.dagOrch.getWorkflow(req.params.dagId);
    if (!dag) return res.status(404).json({ error: '工作流不存在' });
    res.json(dag.toJSON());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/dag/create', (req, res) => {
  try {
    const v14 = initV14();
    if (req.body.preset) {
      const dag = v14.dagOrch.createFromPreset(req.body.preset, req.body.name);
      return res.json({ created: true, ...dag.toJSON() });
    }
    const dag = v14.dagOrch.createWorkflow(req.body.name, req.body.description);
    res.json({ created: true, ...dag.toJSON() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/dag/node', (req, res) => {
  try {
    const v14 = initV14();
    const node = v14.dagOrch.addNode(req.body.dagId, req.body);
    res.json({ added: true, node });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/dag/edge', (req, res) => {
  try {
    const v14 = initV14();
    const edge = v14.dagOrch.addEdge(req.body.dagId, req.body.sourceId, req.body.targetId, req.body.label);
    res.json({ added: true, edge });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/dag/validate', (req, res) => {
  try {
    const v14 = initV14();
    const result = v14.dagOrch.validate(req.body.dagId);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/dag/execute', async (req, res) => {
  try {
    const v14 = initV14();
    const result = await v14.dagOrch.execute(req.body.dagId, req.body.executors || {});
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/dag/snapshot', (req, res) => {
  try {
    const v14 = initV14();
    const snap = v14.dagOrch.snapshot(req.body.dagId);
    res.json({ snapshot: true, workflowId: snap.workflowId, timestamp: snap.timestamp });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/dag/restore', (req, res) => {
  try {
    const v14 = initV14();
    const dag = v14.dagOrch.restore(req.body.dagId, req.body.snapshotIndex || -1);
    res.json({ restored: true, ...dag.toJSON() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════
//  V14 增强: 指纹引擎 V2 API
// ══════════════════════════════════════════════════════
app.post('/api/v14/fingerprint/generate', (req, res) => {
  try {
    const v14 = initV14();
    const { deviceId, template, region, manufacturer, model } = req.body;
    const fp = v14.fingerprintV2.fullPipeline(deviceId, template, region || 'US', manufacturer, model);
    res.json({ generated: true, fingerprint: { imei: fp.imei1, androidId: fp.androidId, version: fp.version } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/fingerprint/jitter', (req, res) => {
  try {
    const v14 = initV14();
    const fp = v14.fingerprintV2.maybeJitter(req.body.deviceId, req.body.fingerprint);
    res.json({ jittered: true, fingerprint: fp });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/fingerprint/versions/:deviceId', (req, res) => {
  try {
    const v14 = initV14();
    const deviceId = parseInt(req.params.deviceId);
    const history = v14.fingerprintV2.getVersionHistory(deviceId);
    res.json({ deviceId: req.params.deviceId, versions: history });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════
//  V14 增强: AVD 健康检测 + 三阶段ADB
// ══════════════════════════════════════════════════════
app.post('/api/v14/devices/avd-health', async (req, res) => {
  try {
    const v14 = initV14();
    const serials = req.body.serials || [];
    const results = await v14.avdHealth.batchCheck(serials);
    res.json(results);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/devices/adb-pipeline', async (req, res) => {
  try {
    const v14 = initV14();
    const result = await v14.threeStageADB.runFullPipeline();
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════
//  V14 增强: 养号 Bezieh/误触/疲劳 API
// ══════════════════════════════════════════════════════
app.post('/api/v14/nurturing/mistouch', (req, res) => {
  try {
    const v14 = initV14();
    const mistouch = v14.mistouchSim.shouldMistouch()
      ? v14.mistouchSim.generateMistouch(req.body.screenWidth, req.body.screenHeight)
      : [];
    res.json({ shouldMistouch: v14.mistouchSim.shouldMistouch(), mistouch, stats: v14.mistouchSim.getStats() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/nurturing/fatigue-check', (req, res) => {
  try {
    const v14 = initV14();
    const isResting = v14.fatigueMgr.isResting(req.body.deviceId);
    const remainingMs = v14.fatigueMgr.getRemainingRestMs(req.body.deviceId);
    res.json({ isResting, remainingMs, remainingMin: Math.round(remainingMs / 60000) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════
//  V14 增强: 内容去重/EXIF清洗 API
// ══════════════════════════════════════════════════════
app.post('/api/v14/content/dedup-check', (req, res) => {
  try {
    const v14 = initV14();
    const result = v14.textDedup.isDuplicate(req.body.text);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/content/compare', (req, res) => {
  try {
    const v14 = initV14();
    const result = v14.textDedup.compare(req.body.textA, req.body.textB);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/content/exif-clean', (req, res) => {
  try {
    const v14 = initV14();
    const cleaned = v14.exifCleaner.cleanText(req.body.content);
    const leaks = v14.exifCleaner.detectLeaks(req.body.content);
    res.json({ cleaned, ...leaks });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/content/reencode', (req, res) => {
  try {
    const v14 = initV14();
    const params = v14.imageReencoder.multiPassReencode(
      { width: req.body.width || 1080, height: req.body.height || 1920 },
      req.body.passes || 2
    );
    res.json(params);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/content/rewrite', (req, res) => {
  try {
    const { FourLevelRewriter } = require('./content-intelligence.js');
    const rewritten = FourLevelRewriter.fullRewrite(req.body.text, req.body.opts || {});
    res.json({ rewritten });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// ── P0-P2 新模块 API 端点 ───────────────────────────────────
// ═══════════════════════════════════════════════════════════

// ── Social Bridge (P0) ──────────────────────────
app.get('/api/v14/social/stats', (req, res) => {
  try {
    const v14 = initV14();
    res.json(v14.socialBridge.getStats());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/social/queue', (req, res) => {
  try {
    const v14 = initV14();
    res.json({ queue: v14.socialBridge.getQueue(), active: v14.socialBridge.getActive() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/social/history', (req, res) => {
  try {
    const v14 = initV14();
    res.json(v14.socialBridge.getHistory(parseInt(req.query.limit) || 50));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/social/post', (req, res) => {
  try {
    const v14 = initV14();
    const { deviceId, platform, content } = req.body;
    const action = v14.socialBridge.postContent(deviceId, platform, content);
    res.json({ actionId: action.id, status: 'queued' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/social/follow', (req, res) => {
  try {
    const v14 = initV14();
    const { deviceId, platform, targetUser } = req.body;
    const action = v14.socialBridge.followUser(deviceId, platform, targetUser);
    res.json({ actionId: action.id, status: 'queued' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/social/dm', (req, res) => {
  try {
    const v14 = initV14();
    const { deviceId, platform, targetUser, message } = req.body;
    const action = v14.socialBridge.sendDM(deviceId, platform, targetUser, message);
    res.json({ actionId: action.id, status: 'queued' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/social/comment', (req, res) => {
  try {
    const v14 = initV14();
    const { deviceId, platform, targetPost, text } = req.body;
    const action = v14.socialBridge.comment(deviceId, platform, targetPost, text);
    res.json({ actionId: action.id, status: 'queued' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/social/like', (req, res) => {
  try {
    const v14 = initV14();
    const { deviceId, platform, targetPost } = req.body;
    const action = v14.socialBridge.likePost(deviceId, platform, targetPost);
    res.json({ actionId: action.id, status: 'queued' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/social/batch-post', (req, res) => {
  try {
    const v14 = initV14();
    const { deviceIds, platform, contents } = req.body;
    const actions = v14.socialBridge.batchPost(deviceIds, platform, contents);
    res.json({ queued: actions.length, actionIds: actions.map(a => a.id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DAU Target Controller (P0) ──────────────────
app.get('/api/v14/dau/status', (req, res) => {
  try {
    const v14 = initV14();
    res.json(v14.dauController.getStatus());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/dau/target', (req, res) => {
  try {
    const v14 = initV14();
    v14.dauController.setTarget(parseInt(req.body.target) || 500);
    res.json({ target: v14.dauController.dailyTarget });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/dau/start', (req, res) => {
  try {
    const v14 = initV14();
    v14.dauController.start();
    res.json({ running: true, target: v14.dauController.dailyTarget });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/dau/stop', (req, res) => {
  try {
    const v14 = initV14();
    v14.dauController.stop();
    res.json({ running: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/dau/log', (req, res) => {
  try {
    const v14 = initV14();
    res.json(v14.dauController.getExecutionLog(parseInt(req.query.limit) || 20));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/dau/qtable', (req, res) => {
  try {
    const v14 = initV14();
    res.json(v14.dauController.getQTable());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/dau/inject', (req, res) => {
  res.status(403).json({ error: '模拟数据注入已禁用。请配置真实引流网站并启动全链路自动化以获取真实DAU数据。' });
});

// ── Proactive Marketing (P1) ────────────────────
app.get('/api/v14/marketing/stats', (req, res) => {
  try {
    const v14 = initV14();
    res.json(v14.proactiveMarketing.getStats());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/marketing/campaigns', (req, res) => {
  try {
    const v14 = initV14();
    res.json(v14.proactiveMarketing.listCampaigns(req.query.status || null));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/marketing/campaigns', (req, res) => {
  try {
    const v14 = initV14();
    const camp = v14.proactiveMarketing.createCampaign(req.body);
    res.json({ campaignId: camp.id, status: camp.status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/marketing/campaigns/:id', (req, res) => {
  try {
    const v14 = initV14();
    const camp = v14.proactiveMarketing.getCampaign(req.params.id);
    if (!camp) return res.status(404).json({ error: 'Not found' });
    res.json(camp);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/marketing/campaigns/:id/start', (req, res) => {
  try {
    const v14 = initV14();
    const camp = v14.proactiveMarketing.startCampaign(req.params.id);
    res.json({ campaignId: camp.id, status: camp.status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/marketing/campaigns/:id/pause', (req, res) => {
  try {
    const v14 = initV14();
    v14.proactiveMarketing.pauseCampaign(req.params.id);
    res.json({ paused: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/marketing/quick-follow', (req, res) => {
  try {
    const v14 = initV14();
    const { platform, keywords, deviceIds, landingUrl } = req.body;
    const camp = v14.proactiveMarketing.quickFollowCampaign(platform, keywords, deviceIds, landingUrl);
    res.json({ campaignId: camp.id, id: camp.id, status: camp.status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/marketing/quick-dm', (req, res) => {
  try {
    const v14 = initV14();
    const { platform, users, deviceIds, landingUrl, topic } = req.body;
    const camp = v14.proactiveMarketing.quickDMCampaign(platform, users, deviceIds, landingUrl, topic);
    res.json({ campaignId: camp.id, id: camp.id, status: camp.status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/marketing/quick-intercept', (req, res) => {
  try {
    const v14 = initV14();
    const { platform, kolPosts, deviceIds, landingUrl } = req.body;
    const camp = v14.proactiveMarketing.quickInterceptCampaign(platform, kolPosts, deviceIds, landingUrl);
    res.json({ campaignId: camp.id, id: camp.id, status: camp.status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Tumblr 账号互动中心（本机人工操作） ──────────────────
// 设计原则：OAuth 仅用于官方支持的只读通知/帖子/notes；私信和网页回复只能在真实
// 已登录浏览器中由用户点击完成。接口绝不返回账号密码、OAuth token 或 cookie。
const tumblrLoginIntents = new Map();
const activeTumblrLoginChildren = new Map();
const TUMBLR_LOGIN_INTENT_TTL_MS = 5 * 60 * 1000;

function interactionError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}
function clearExpiredTumblrLoginIntents() {
  const now = Date.now();
  for (const [id, intent] of tumblrLoginIntents) {
    if (!intent || intent.expiresAt <= now || intent.used) tumblrLoginIntents.delete(id);
  }
}
function normalizeTumblrTarget(input, fallback = 'https://www.tumblr.com/dashboard') {
  let target;
  try { target = new URL(input || fallback); } catch (_) { target = new URL(fallback); }
  const host = target.hostname.toLowerCase();
  const allowed = host === 'tumblr.com' || host.endsWith('.tumblr.com');
  if (target.protocol !== 'https:' || !allowed) return fallback;
  return target.toString();
}
function loadTumblrAccountRecord(accountId) {
  const file = dataFile('accounts.json');
  let accounts = [];
  try { accounts = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  if (!Array.isArray(accounts)) accounts = [];
  const account = accounts.find((item) => item && item.platform === 'tumblr' && String(item.id) === String(accountId));
  if (!account) throw interactionError('Tumblr 账号不存在', 404);
  if (account.terminatedReason) throw interactionError('该账号已被平台终止，不能建立互动会话', 410);
  return account;
}
function getTumblrInteractionContext(accountId, requireToken = true) {
  const account = loadTumblrAccountRecord(accountId);
  const v14 = initV14();
  if (!v14 || !v14.dataStore || !v14.tumblrPublisher) throw interactionError('互动模块尚未初始化', 503);
  const token = v14.dataStore.get('tumblr_token', account.id);
  if (requireToken && (!token || !token.oauthToken || !token.oauthTokenSecret)) {
    throw interactionError('账号没有可用 OAuth 授权，无法读取互动通知', 409);
  }
  const blogName = (token && token.blogName) || account.username || '';
  if (!blogName) throw interactionError('账号缺少可用博客标识', 409);
  return { account, token, blogName, v14 };
}
function writeTumblrInteractionAudit(dataStore, accountId, action, extra = {}) {
  try {
    dataStore.create('tumblr_interaction_audit', Object.assign({
      id: 'tia_' + crypto.randomUUID(), accountId, action, source: 'local-console'
    }, extra));
  } catch (e) {
    console.warn('[tumblr-interaction] audit write failed:', e.message);
  }
}
function publicTumblrAccount(account, token, blogName) {
  return {
    id: account.id,
    platform: 'tumblr',
    username: account.username || '',
    blogName: blogName || '',
    hasCredentials: !!(account.email && account.password),
    hasOAuth: !!(token && token.oauthToken && token.oauthTokenSecret),
    emailMasked: maskEmail(account.email),
    status: account.status || 'unknown'
  };
}
function publicInteractionDraft(draft) {
  if (!draft) return null;
  return {
    id: draft.id, accountId: draft.accountId, kind: draft.kind, recipient: draft.recipient || '',
    postId: draft.postId || '', targetUrl: draft.targetUrl || '', body: draft.body || '',
    status: draft.status || 'draft', requiresManualWebSend: true,
    createdAt: draft.createdAt, updatedAt: draft.updatedAt, approvedAt: draft.approvedAt || null,
    openedAt: draft.openedAt || null
  };
}
function launchTumblrBrowserSession(account, targetUrl, dataStore, auditAction = 'browser-opened') {
  const old = activeTumblrLoginChildren.get(account.id);
  if (old && !old.killed) {
    return { ok: true, alreadyLaunching: true, targetUrl, message: '该账号的本地浏览器会话已在运行或正在启动' };
  }
  const child = spawn(process.execPath, ['tumblr-login-check.js', String(account.id), '--target', targetUrl], {
    cwd: __dirname,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '' })
  });
  child.once('error', (e) => console.warn('[tumblr-interaction] browser launch failed:', e.message));
  child.once('exit', () => activeTumblrLoginChildren.delete(account.id));
  child.unref();
  activeTumblrLoginChildren.set(account.id, child);
  writeTumblrInteractionAudit(dataStore, account.id, auditAction, {
    targetUrl, processId: child.pid || null, requiresManualWebSend: true
  });
  return { ok: true, alreadyLaunching: false, targetUrl, processId: child.pid || null, message: '已在本机打开真实 Tumblr 浏览器会话；请在网页中手动确认并发送' };
}

// 创建短时一次性登录意图。账号 ID 从 API 参数传递，但凭据仅由服务器进程读取。
app.post('/api/v14/tumblr/accounts/:accountId/login-intent', requireLocalControl, (req, res) => {
  try {
    clearExpiredTumblrLoginIntents();
    const { account, token, blogName, v14 } = getTumblrInteractionContext(req.params.accountId, false);
    if (!account.email || !account.password) return res.status(409).json({ error: '该账号没有可用网页登录凭据' });
    const targetUrl = normalizeTumblrTarget((req.body || {}).targetUrl, 'https://www.tumblr.com/dashboard');
    const intentId = crypto.randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + TUMBLR_LOGIN_INTENT_TTL_MS;
    tumblrLoginIntents.set(intentId, { accountId: account.id, targetUrl, expiresAt, used: false });
    writeTumblrInteractionAudit(v14.dataStore, account.id, 'login-intent-created', { targetUrl, expiresAt });
    res.set('Cache-Control', 'no-store').json({
      ok: true, intentId, expiresAt: new Date(expiresAt).toISOString(), targetUrl,
      account: publicTumblrAccount(account, token, blogName),
      launchPath: `/api/v14/tumblr/login-intents/${intentId}/launch`
    });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// 消费一次性意图并启动本机可见 Chrome。不能由公网隧道调用。
app.post('/api/v14/tumblr/login-intents/:intentId/launch', requireLocalControl, (req, res) => {
  try {
    clearExpiredTumblrLoginIntents();
    const intent = tumblrLoginIntents.get(req.params.intentId);
    if (!intent || intent.used || intent.expiresAt <= Date.now()) return res.status(410).json({ error: '登录意图已过期或已使用，请重新创建' });
    intent.used = true;
    tumblrLoginIntents.delete(req.params.intentId);
    const { account, v14 } = getTumblrInteractionContext(intent.accountId, false);
    const result = launchTumblrBrowserSession(account, intent.targetUrl, v14.dataStore, 'browser-login-launched');
    res.set('Cache-Control', 'no-store').json(result);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// 官方 OAuth 可读互动收件箱：博客活动通知 + 自己博客的帖子/评论入口。
app.get('/api/v14/tumblr/accounts/:accountId/inbox', requireLocalControl, async (req, res) => {
  try {
    const { account, token, blogName, v14 } = getTumblrInteractionContext(req.params.accountId, true);
    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 20));
    const [notificationsResult, postsResult] = await Promise.allSettled([
      v14.tumblrPublisher.getBlogNotifications(blogName, { limit }, account.id),
      v14.tumblrPublisher.getBlogPosts(blogName, { limit, notesInfo: true }, account.id)
    ]);
    const notificationError = notificationsResult.status === 'rejected' ? notificationsResult.reason.message : null;
    const postError = postsResult.status === 'rejected' ? postsResult.reason.message : null;
    const notifications = notificationsResult.status === 'fulfilled' ? notificationsResult.value.notifications : [];
    const posts = postsResult.status === 'fulfilled' ? postsResult.value.posts : [];
    writeTumblrInteractionAudit(v14.dataStore, account.id, 'inbox-read', {
      notificationCount: notifications.length, postCount: posts.length,
      notificationError: !!notificationError, postError: !!postError
    });
    // Phase 5 / #529：把真实通知/帖子 upsert 进统一收件箱（保留已读状态，绝不伪造）
    try {
      if (v14.messageInbox) {
        const sync = await v14.messageInbox.syncFromTumblr(account.id, { notifications, posts });
        if (sync.synced) console.log(`[inbox] synced ${sync.synced} item(s) for ${account.id}, unread=${sync.unread}`);
      }
    } catch (syncErr) {
      console.warn('[inbox] unified sync failed (non-fatal):', syncErr.message);
    }
    res.set('Cache-Control', 'no-store').json({
      account: publicTumblrAccount(account, token, blogName),
      capabilities: {
        notificationsRead: true, notesRead: true,
        directMessageApi: false, commentReplyApi: false,
        webMessaging: true, webReply: true, requiresManualWebSend: true
      },
      notifications, posts,
      sourceStatus: {
        notifications: notificationError ? { ok: false, error: notificationError } : { ok: true },
        posts: postError ? { ok: false, error: postError } : { ok: true }
      }
    });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// 单帖 comments/notes 只读详情（Tumblr 官方 notes API）。
app.get('/api/v14/tumblr/accounts/:accountId/notes/:postId', requireLocalControl, async (req, res) => {
  try {
    const { account, token, blogName, v14 } = getTumblrInteractionContext(req.params.accountId, true);
    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 20));
    const result = await v14.tumblrPublisher.getPostNotes(blogName, req.params.postId, { limit, before: req.query.before || null }, account.id);
    writeTumblrInteractionAudit(v14.dataStore, account.id, 'notes-read', { postId: String(req.params.postId), noteCount: result.notes.length });
    res.set('Cache-Control', 'no-store').json({ account: publicTumblrAccount(account, token, blogName), postId: String(req.params.postId), notes: result.notes, links: result.links || {} });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// 草稿保存与审核：只保存人工待处理内容，不调用 Tumblr 发送 API。
app.get('/api/v14/tumblr/accounts/:accountId/drafts', requireLocalControl, (req, res) => {
  try {
    const { account, v14 } = getTumblrInteractionContext(req.params.accountId, false);
    const list = v14.dataStore.list('tumblr_interaction_draft', { filter: { accountId: account.id }, sort: 'createdAt', order: 'desc', limit: 100 });
    res.set('Cache-Control', 'no-store').json({ items: list.items.map(publicInteractionDraft), total: list.total });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/v14/tumblr/accounts/:accountId/drafts', requireLocalControl, (req, res) => {
  try {
    const { account, v14, blogName } = getTumblrInteractionContext(req.params.accountId, false);
    const body = String((req.body || {}).body || '').trim();
    const kind = String((req.body || {}).kind || '').trim();
    const recipient = String((req.body || {}).recipient || '').trim().slice(0, 200);
    const postId = String((req.body || {}).postId || '').trim().slice(0, 100);
    if (!['direct_message', 'comment_reply'].includes(kind)) throw interactionError('kind 必须为 direct_message 或 comment_reply');
    if (!body || body.length > 5000) throw interactionError('草稿正文不能为空且不能超过 5000 字符');
    const fallback = kind === 'direct_message' ? 'https://www.tumblr.com/messaging' : `https://${blogName}.tumblr.com`;
    const targetUrl = normalizeTumblrTarget((req.body || {}).targetUrl, fallback);
    const draft = v14.dataStore.create('tumblr_interaction_draft', {
      id: 'tid_' + crypto.randomUUID(), accountId: account.id, kind, recipient, postId, targetUrl, body,
      status: 'draft', requiresManualWebSend: true
    });
    v14.dataStore.flush();
    writeTumblrInteractionAudit(v14.dataStore, account.id, 'draft-created', {
      draftId: draft.id, kind, recipient, postId, targetUrl, bodyLength: body.length
    });
    res.set('Cache-Control', 'no-store').json({ ok: true, draft: publicInteractionDraft(draft) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/v14/tumblr/accounts/:accountId/drafts/:draftId/approve', requireLocalControl, (req, res) => {
  try {
    const { account, v14 } = getTumblrInteractionContext(req.params.accountId, false);
    const draft = v14.dataStore.get('tumblr_interaction_draft', req.params.draftId);
    if (!draft || String(draft.accountId) !== String(account.id)) throw interactionError('草稿不存在', 404);
    if (draft.status !== 'draft') throw interactionError('该草稿不是待审核状态', 409);
    const approved = v14.dataStore.update('tumblr_interaction_draft', draft.id, {
      status: 'approved', approvedAt: new Date().toISOString(), approvedBy: 'local-console'
    });
    v14.dataStore.flush();
    writeTumblrInteractionAudit(v14.dataStore, account.id, 'draft-approved', { draftId: draft.id, kind: draft.kind, targetUrl: draft.targetUrl });
    res.set('Cache-Control', 'no-store').json({ ok: true, draft: publicInteractionDraft(approved), note: '已审核。下一步将打开真实网页；发送仍需你在 Tumblr 页面内手动点击确认。' });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// 审核后的草稿只会打开相应的真实网页，不会自动发送。
app.post('/api/v14/tumblr/accounts/:accountId/drafts/:draftId/open-web', requireLocalControl, (req, res) => {
  try {
    const { account, v14 } = getTumblrInteractionContext(req.params.accountId, false);
    const draft = v14.dataStore.get('tumblr_interaction_draft', req.params.draftId);
    if (!draft || String(draft.accountId) !== String(account.id)) throw interactionError('草稿不存在', 404);
    if (draft.status !== 'approved') throw interactionError('请先人工审核草稿后再打开网页', 409);
    const result = launchTumblrBrowserSession(account, normalizeTumblrTarget(draft.targetUrl), v14.dataStore, 'approved-draft-opened-web');
    const updated = v14.dataStore.update('tumblr_interaction_draft', draft.id, { status: 'opened_in_web', openedAt: new Date().toISOString() });
    v14.dataStore.flush();
    res.set('Cache-Control', 'no-store').json(Object.assign({}, result, { draft: publicInteractionDraft(updated), requiresManualWebSend: true }));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/v14/tumblr/accounts/:accountId/audit', requireLocalControl, (req, res) => {
  try {
    const { account, v14 } = getTumblrInteractionContext(req.params.accountId, false);
    const list = v14.dataStore.list('tumblr_interaction_audit', { filter: { accountId: account.id }, sort: 'createdAt', order: 'desc', limit: 100 });
    res.set('Cache-Control', 'no-store').json({ items: list.items, total: list.total });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ── OAuth App 管理（429 缓解：多 App 轮换；含 consumerSecret，仅主机本机控制台可操作） ──
const TUMBLR_APPS_PATH = miscFile('tumblr_apps.json');
function readTumblrApps() {
  try { const raw = JSON.parse(fs.readFileSync(TUMBLR_APPS_PATH, 'utf8')); return Array.isArray(raw) ? raw : []; }
  catch (e) { return []; }
}
function writeTumblrApps(list) { fs.writeFileSync(TUMBLR_APPS_PATH, JSON.stringify(list, null, 2)); }
function maskSecret(s) { if (!s) return ''; return s.length <= 8 ? '********' : (s.slice(0, 4) + '****' + s.slice(-4)); }
function reloadNurtureAppsInternal() {
  const port = parseInt(process.env.TUMBLR_NURTURE_PORT || '3005', 10);
  return new Promise((resolve) => {
    const up = http.request({ host: '127.0.0.1', port, path: '/api/reload', method: 'POST',
      headers: { host: '127.0.0.1:' + port, 'Content-Type': 'application/json' }, timeout: 20000 },
      (r) => { let b = ''; r.on('data', d => b += d); r.on('end', () => resolve({ status: r.statusCode, body: b })); });
    up.on('error', e => resolve({ status: 0, body: e.message }));
    up.on('timeout', () => { try { up.destroy(); } catch (_) {} resolve({ status: 504, body: 'timeout' }); });
    up.end('{}');
  });
}
app.get('/api/v14/tumblr/apps', requireLocalControl, (req, res) => {
  try {
    const list = readTumblrApps();
    res.set('Cache-Control', 'no-store').json({ count: list.length, apps: list.map(a => ({ label: a.label || '', consumerKey: a.consumerKey || a.consumer_key || '', consumerSecretMasked: maskSecret(a.consumerSecret || a.consumer_secret || '') })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/v14/tumblr/apps', requireLocalControl, (req, res) => {
  try {
    const { label, consumerKey, consumerSecret } = req.body || {};
    if (!label || !consumerKey || !consumerSecret) return res.status(400).json({ error: 'label / consumerKey / consumerSecret 均必填' });
    const list = readTumblrApps();
    if (list.some(a => (a.consumerKey || a.consumer_key) === consumerKey)) return res.status(409).json({ error: '该 consumerKey 已存在' });
    list.push({ label: String(label).trim(), consumerKey: String(consumerKey).trim(), consumerSecret: String(consumerSecret).trim() });
    writeTumblrApps(list);
    reloadNurtureAppsInternal().then(r => res.json({ ok: true, count: list.length, reload: r.status, reloadBody: (r.body || '').slice(0, 200) }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/v14/tumblr/apps/:label', requireLocalControl, (req, res) => {
  try {
    const label = req.params.label;
    let list = readTumblrApps();
    const before = list.length;
    list = list.filter(a => (a.label || '') !== label && (a.consumerKey || a.consumer_key || '') !== label);
    if (list.length === before) return res.status(404).json({ error: '未找到 label=' + label });
    writeTumblrApps(list);
    reloadNurtureAppsInternal().then(r => res.json({ ok: true, count: list.length, reload: r.status }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/v14/tumblr/apps/rebalance', requireLocalControl, async (req, res) => {
  try {
    // 安全再平衡：仅对「无 OAuth token」的账号重新分配 App（不破坏已签发 token↔app 绑定）；
    // 已有 token 的账号须重新授权才能切换 App（否则 401）。内部调用 3005 执行。
    const port = parseInt(process.env.TUMBLR_NURTURE_PORT || '3005', 10);
    const rb = await new Promise((resolve) => {
      const up = http.request({ host: '127.0.0.1', port, path: '/api/internal/rebalance-apps', method: 'POST',
        headers: { host: '127.0.0.1:' + port, 'Content-Type': 'application/json' }, timeout: 30000 },
        (r) => { let b = ''; r.on('data', d => b += d); r.on('end', () => resolve({ status: r.statusCode, body: b })); });
      up.on('error', e => resolve({ status: 0, body: e.message }));
      up.on('timeout', () => { try { up.destroy(); } catch (_) {} resolve({ status: 504, body: 'timeout' }); });
      up.end('{}');
    });
    let parsed = {}; try { parsed = JSON.parse(rb.body || '{}'); } catch (_) {}
    res.json({ ok: true, rebalance: parsed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 账号一键登录/验证 ─────────────────────────────────
// 获取账号的一键登录链接（用于验证账号状态）
app.get('/api/v14/accounts/:id/login-link', async (req, res) => {
  try {
    const { id } = req.params;
    let account = null;

    // 先从 DB 查
    if (pool) {
      const [[row]] = await pool.execute(
        'SELECT * FROM matrix_accounts_managed WHERE id = ?', [parseInt(id, 10)]
      );
      if (row) account = row;
    }

    // Fallback: 从 nurturing 内存引擎查
    if (!account) {
      const v14 = initV14();
      if (v14 && v14.nurturing) {
        const memAcc = v14.nurturing.accounts.get(String(id));
        if (memAcc) account = { id, platform: memAcc.platform, username: memAcc.username, bound_device_id: memAcc.deviceId };
      }
    }

    if (!account) return res.status(404).json({ error: 'account not found' });

    const platform = account.platform || 'unknown';
    const username = account.username || 'unknown';

    // 平台登录页映射
    const platformLoginPages = {
      reddit: `https://www.reddit.com/login/?username=${encodeURIComponent(username)}`,
      x: 'https://x.com/login',
      twitter: 'https://x.com/login',
      discord: 'https://discord.com/login',
      tiktok: 'https://www.tiktok.com/login',
      instagram: `https://www.instagram.com/accounts/login/?username=${encodeURIComponent(username)}`,
      facebook: 'https://www.facebook.com/login',
      // 不把邮箱拼入 URL：URL 会进入浏览器历史、代理日志和 Referer。
      tumblr: 'https://www.tumblr.com/login',
      youtube: 'https://accounts.google.com/signin',
    };

    // 平台个人主页（登录后可验证）
    const platformProfileUrls = {
      reddit: `https://www.reddit.com/user/${encodeURIComponent(username)}`,
      x: `https://x.com/${encodeURIComponent(username)}`,
      twitter: `https://x.com/${encodeURIComponent(username)}`,
      discord: null,
      tiktok: `https://www.tiktok.com/@${encodeURIComponent(username)}`,
      instagram: `https://www.instagram.com/${encodeURIComponent(username)}/`,
      facebook: `https://www.facebook.com/${encodeURIComponent(username)}`,
      tumblr: `https://${encodeURIComponent(username)}.tumblr.com`,
      youtube: `https://www.youtube.com/@${encodeURIComponent(username)}`,
    };

    // 是否有已保存的 session
    let hasSession = false;
    let sessionDeviceId = null;
    try {
      if (v14Modules.sessionManager) {
        const activeSessions = v14Modules.sessionManager.getActiveSessions
          ? v14Modules.sessionManager.getActiveSessions()
          : null;
        if (activeSessions) {
          for (const [devId, snap] of Object.entries(activeSessions)) {
            if (snap.platform === platform && snap.data?.tokens?.username === username) {
              hasSession = true;
              sessionDeviceId = devId;
              break;
            }
          }
        }
      }
    } catch (e) { /* ignore */ }

    res.json({
      account_id: parseInt(id, 10),
      platform,
      username,
      email: account.email ? maskEmail(account.email) : null,
      status: account.status || 'unknown',
      is_valid: account.is_valid === 1,
      login_url: platformLoginPages[platform] || `https://${platform}.com/login`,
      profile_url: platformProfileUrls[platform] || null,
      has_session: hasSession,
      bound_device_id: account.bound_device_id || null,
      quick_login_url: sessionDeviceId
        ? `/api/v14/accounts/${id}/auto-login`
        : null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 触发自动登录（Playwright 浏览器打开平台并恢复 session）
app.post('/api/v14/accounts/:id/auto-login', async (req, res) => {
  try {
    const { id } = req.params;
    let account = null;

    if (pool) {
      const [[row]] = await pool.execute(
        'SELECT * FROM matrix_accounts_managed WHERE id = ?', [parseInt(id, 10)]
      );
      if (row) account = row;
    }

    if (!account) return res.status(404).json({ error: 'account not found' });

    const platform = account.platform || 'unknown';
    // 平台个人主页
    const profileUrls = {
      reddit: `https://www.reddit.com/user/${encodeURIComponent(account.username)}`,
      x: `https://x.com/${encodeURIComponent(account.username)}`,
      twitter: `https://x.com/${encodeURIComponent(account.username)}`,
      discord: 'https://discord.com/channels/@me',
      tiktok: `https://www.tiktok.com/@${encodeURIComponent(account.username)}`,
      instagram: `https://www.instagram.com/${encodeURIComponent(account.username)}/`,
      facebook: `https://www.facebook.com/${encodeURIComponent(account.username)}`,
      tumblr: `https://${encodeURIComponent(account.username)}.tumblr.com`,
      youtube: `https://www.youtube.com/@${encodeURIComponent(account.username)}`,
    };

    const profileUrl = profileUrls[platform] || `https://${platform}.com`;

    // 如果有绑定设备，用设备的浏览器上下文打开
    let opened = false;
    if (account.bound_device_id && v14Modules.deviceManager) {
      try {
        const device = v14Modules.deviceManager.getDevice
          ? v14Modules.deviceManager.getDevice(account.bound_device_id)
          : null;
        if (device && device.browserContext) {
          const page = await device.browserContext.newPage();
          await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
          opened = true;
          console.log(`[auto-login] Opened ${platform} profile for account ${id} on device ${account.bound_device_id}`);
        }
      } catch (e) { console.warn(`[auto-login] Browser context open failed:`, e.message); }
    }

    res.json({
      success: true,
      account_id: parseInt(id, 10),
      platform,
      username: account.username,
      profile_url: profileUrl,
      opened_browser: opened,
      message: opened
        ? `已在云手机浏览器中打开 ${platform} 个人主页`
        : `请手动访问: ${profileUrl}`,
      // 旧接口仅返回脱敏状态；密码绝不通过 API 返回。
      credentials: { username: account.username, password: null },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 发布历史（含平台预览和登录链接） ─────────────────
app.get('/api/v14/publish/history', async (req, res) => {
  try {
    const { limit = '50', offset = '0', platform } = req.query;
    const limitNum = Math.max(1, Math.min(200, parseInt(limit, 10) || 50));
    const offsetNum = Math.max(0, parseInt(offset, 10) || 0);

    // 平台登录/预览链接映射
    const platformLoginPages = {
      reddit: 'https://www.reddit.com/login/',
      x: 'https://x.com/login',
      twitter: 'https://x.com/login',
      discord: 'https://discord.com/login',
      tiktok: 'https://www.tiktok.com/login',
      instagram: 'https://www.instagram.com/accounts/login/',
      facebook: 'https://www.facebook.com/login',
      tumblr: 'https://www.tumblr.com/login',
      youtube: 'https://accounts.google.com/signin',
    };

    let rows = [];
    let totalCount = 0;

    // 尝试 MySQL，失败则回退到 DataStore
    if (pool) {
      try {
        let where = ' WHERE 1=1';
        const params = [];
        if (platform) { where += ' AND p.platform = ?'; params.push(platform); }

        const [mysqlRows] = await pool.execute(
          `SELECT p.id, p.account_id, p.content_id, p.content_title, p.platform, p.post_url, p.status,
                  p.published_at, p.emitted_at,
                  a.username, a.email, a.bound_device_id, a.is_valid, a.status as account_status
           FROM matrix_posts_published p
           LEFT JOIN matrix_accounts_managed a ON p.account_id = a.bot_id
           ${where}
           ORDER BY p.published_at DESC
           LIMIT ${limitNum} OFFSET ${offsetNum}`,
          params
        );
        const [countRows] = await pool.execute(
          `SELECT COUNT(*) as total FROM matrix_posts_published p ${where}`,
          params
        );
        rows = mysqlRows;
        totalCount = countRows[0]?.total || 0;
      } catch (mysqlErr) {
        console.warn('[publish/history] MySQL 不可用，回退到 DataStore:', mysqlErr.message);
      }
    }

    // MySQL 不可用时从 DataStore 读取
    if (rows.length === 0) {
      const v14 = initV14();
      if (v14 && v14.dataStore) {
        const publishResult = v14.dataStore.list('publish', { limit: limitNum, offset: offsetNum });
        const publishItems = publishResult?.items || [];
        const accountResult = v14.dataStore.list('accounts', { limit: 10000 });
        const accountItems = accountResult?.items || [];

        rows = publishItems.map(p => {
          const acc = accountItems.find(a => String(a.id) === String(p.account_id) || String(a.bot_id) === String(p.account_id));
          return {
            id: p.id,
            account_id: p.account_id,
            content_id: p.content_id,
            content_title: p.content_title || p.title || '',
            platform: p.platform || 'unknown',
            post_url: p.post_url || p.publishUrl || '',
            status: p.status || 'published',
            published_at: p.published_at || p.createdAt,
            emitted_at: p.emitted_at || null,
            username: acc?.username || p.username || 'unknown',
            email: acc?.email || '',
            bound_device_id: acc?.bound_device_id || null,
            is_valid: acc?.is_valid !== undefined ? acc.is_valid : 1,
            account_status: acc?.status || p.account_status || 'active',
          };
        });
        // 按发布时间倒序
        rows.sort((a, b) => new Date(b.published_at) - new Date(a.published_at));
        if (platform) rows = rows.filter(r => r.platform === platform);
        totalCount = publishResult?.total || rows.length;
      }
    }

    // 增强：附加 DataStore 中的内容标题/归属补充（闭环回源）
    let dataStoreContents = [];
    try {
      const v14 = initV14();
      if (v14 && v14.dataStore) {
        const c = v14.dataStore.list('content', { limit: 100000 });
        dataStoreContents = Array.isArray(c) ? c : (c && c.items ? c.items : []);
      }
    } catch(e) { /* ignore */ }

    const posts = rows.map(p => {
      const plat = p.platform || 'unknown';
      const uname = p.username || 'unknown';
      const profileUrl = plat === 'x' ? `https://x.com/${uname}` :
                         plat === 'twitter' ? `https://x.com/${uname}` :
                         plat === 'reddit' ? `https://www.reddit.com/user/${uname}` :
                         `https://${plat}.com/@${uname}`;

      let contentTitle = p.content_title || '';
      let contentAccountId = p.content_account_id || null; // 反规范化归属（自包含闭环验证）
      if ((!contentTitle || !contentAccountId) && p.content_id) {
        const match = dataStoreContents.find(c => String(c.id) === String(p.content_id));
        if (match) {
          if (!contentTitle) contentTitle = match.title || '';
          if (!contentAccountId) contentAccountId = match.account_id || null; // 内容记录仍在时回源真实归属
        }
      }

      return {
        id: p.id,
        post_id: `post_${p.id}`,
        account_id: p.account_id,
        content_id: p.content_id,
        content_account_id: contentAccountId,
        content_title: contentTitle,
        // 闭环校验：内容归属账号 == 发布账号（两者任一缺失则标记待回填，绝不伪造）
        closed_loop_ok: (contentAccountId && p.account_id) ? (String(contentAccountId) === String(p.account_id)) : null,
        platform: plat,
        username: uname,
        // 【零伪造】无真实发布 URL 时返回 null，绝不拼接假链接（旧实现会伪造 platform.com/post/id）
        post_url: p.post_url || null,
        status: p.status || 'published',
        published_at: p.published_at,
        account_status: p.account_status,
        account_valid: p.is_valid === 1,
        bound_device_id: p.bound_device_id,
        login_url: platformLoginPages[plat] || `https://${plat}.com/login`,
        account_login_url: p.account_id ? `/api/v14/managed-accounts/${p.id}/login-link` : null,
        preview_url: p.post_url || null,
        profile_url: profileUrl,
      };
    });

    // 【修复】平台汇总统计
    const byPlatform = {};
    for (const p of posts) {
      const plat = p.platform || 'unknown';
      if (!byPlatform[plat]) {
        byPlatform[plat] = { platform: plat, total: 0, valid_accounts: 0, invalid_accounts: 0, links: [] };
      }
      byPlatform[plat].total++;
      if (p.account_valid) byPlatform[plat].valid_accounts++;
      else byPlatform[plat].invalid_accounts++;
      if (p.preview_url) byPlatform[plat].links.push({ id: p.id, title: p.content_title, url: p.preview_url });
    }

    res.json({
      total: totalCount,
      limit: limitNum,
      offset: offsetNum,
      source: rows.length > 0 && pool ? 'mysql' : 'datastore',
      byPlatform: Object.values(byPlatform),
      posts,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── AIGC Content Generator (P1) ─────────────────
app.get('/api/v14/aigc/stats', (req, res) => {
  try {
    const v14 = initV14();
    res.json(v14.contentGenerator.getStats());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/aigc/generate', async (req, res) => {
  try {
    const v14 = initV14();
    const { platform, config } = req.body;
    const task = await v14.contentGenerator.generate(platform, config || {});
    // 保存到 D: 盘并附加预览链接
    if (task && task.status === 'success' && v14.contentGenerator.saveContentToFile) {
      try { v14.contentGenerator.saveContentToFile(task); } catch (e) { /* 文件保存失败不影响响应 */ }
    }
    res.json(task);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/aigc/batch', (req, res) => {
  try {
    const v14 = initV14();
    const { platform, count, config } = req.body;
    const tasks = v14.contentGenerator.enqueueGeneration(platform, count || 1, config || {});
    res.json({ queued: tasks.length, taskIds: tasks.map(t => t.id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/aigc/history', (req, res) => {
  try {
    const v14 = initV14();
    let history = v14.contentGenerator.getHistory(parseInt(req.query.limit) || 50);
    // 增强：附加 DataStore 中的 contentId 以便生成预览链接
    if (v14.dataStore && v14.dataStore.data && v14.dataStore.data.content) {
      const contents = v14.dataStore.data.content;
      history = history.map((h, i) => {
        const match = contents.find(c => 
          (h.result?.content?.id && c.id === h.result.content.id) ||
          (h.result?.id && c.id === h.result.id) ||
          (h.platform && c.platform === h.platform && i === contents.length - 1 - i) // fallback: reverse match
        );
        return { ...h, contentId: h.result?.content?.id || h.result?.id || h.contentId || null };
      });
    }
    res.json(history);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/aigc/queue', (req, res) => {
  try {
    const v14 = initV14();
    res.json(v14.contentGenerator.getQueue());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/aigc/calendar', (req, res) => {
  try {
    const v14 = initV14();
    res.json(v14.contentGenerator.getCalendar(req.query.start, req.query.end));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/aigc/variants', async (req, res) => {
  try {
    const v14 = initV14();
    const { platform, config, count } = req.body;
    const variants = await v14.contentGenerator.generateVariants(platform, config || {}, count || 3);
    res.json(variants);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Website Analytics (P2) ──────────────────────
app.get('/api/v14/analytics/dashboard', (req, res) => {
  try {
    const v14 = initV14();
    res.json(v14.websiteAnalytics.getDashboard());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/analytics/stats', (req, res) => {
  try {
    const v14 = initV14();
    res.json(v14.websiteAnalytics.getStats());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/analytics/track', (req, res) => {
  try {
    const v14 = initV14();

    // ══════════════════════════════════════════════════════════════════════
    // 【2026-09-24 P0-3 修复】真实访客 IP 必须由服务端从 CDN 请求头解析。
    //
    // 实测根因（这是「真实 DAU 结构性恒为 0」的唯一原因）：
    //   · 浏览器端 SDK（website-analytics.getTrackingSDK）上报体只有
    //     {url, referrer, userAgent, visitorId, sessionId, utm, type} —— **不含 ip**。
    //     浏览器本来也不可能知道自己的公网 IP。
    //   · 本路由把 req.body 原样交给 trackVisit()，于是 data.ip 恒为 ''，
    //     classifyTraffic({ip:''}) → 'unknown'（data-provenance.js:148/153）。
    //   · ⇒ 即便有 100 万个真实访客，也一个都进不了 'user' 口径；
    //     analytics.json 1130/1130 全是 self_direct，dau_log 历史 realDAU 峰值 = 0。
    //
    // 修复：真实客户端 IP 只认服务端可验证的来源，顺序为
    //   cf-connecting-ip（Cloudflare Tunnel 写入，不可被页面伪造）
    //   > x-forwarded-for 首段
    //   > socket.remoteAddress
    //
    // 为什么这样改是【安全】的（不会把自驱流量变成「真实」）：
    //   · 本机直连（因果链 S5 的 http://127.0.0.1:3002/r/xxx 驱动访问）没有 CF 头，
    //     落到 socket.remoteAddress = '127.0.0.1' → classifyTraffic → 'system'（已被排除）。
    //   · 显式声明系统生成的请求（_system_generated / traffic_mode=http_direct /
    //     source=self_direct）一律不覆盖，保持原有如实标注。
    //   · TEST-NET 模拟住宅段仍由 data-provenance 判为 'system'。
    //   ⇒ 只有「经 Cloudflare 进来的、带公网 IP 的」请求才会成为 'user'。
    // ══════════════════════════════════════════════════════════════════════
    const body = Object.assign({}, req.body || {});
    const declaredSystem = body._system_generated === true
      || body._systemGenerated === true
      || String(body.traffic_mode || body._traffic_mode || '').toLowerCase() === 'http_direct'
      || /^self[_-]direct$/i.test(String(body.source || '').trim());

    if (!declaredSystem) {
      const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      const realIp = String(req.headers['cf-connecting-ip'] || fwd || req.socket.remoteAddress || '').trim();
      if (realIp) {
        body.ip = realIp;
        body._ip_source = req.headers['cf-connecting-ip'] ? 'cf-connecting-ip'
          : (fwd ? 'x-forwarded-for' : 'socket');
      }
    } else {
      body._ip_source = 'declared-system';
    }

    const event = v14.websiteAnalytics.trackVisit(body);
    res.json({ tracked: true, eventId: event.id, provenance: event.provenance, ip_source: body._ip_source || 'none' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/analytics/conversion', (req, res) => {
  try {
    const v14 = initV14();
    v14.websiteAnalytics.trackConversion(req.body);
    res.json({ tracked: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/analytics/dau', async (req, res) => {
  try {
    const v14 = initV14();
    const date = req.query.date ? new Date(req.query.date) : new Date();
    const dau = await v14.websiteAnalytics.getDAU(date);
    res.json(dau);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/analytics/realtime', (req, res) => {
  try {
    const v14 = initV14();
    res.json(v14.websiteAnalytics.getRealtime());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/analytics/trend', (req, res) => {
  try {
    const v14 = initV14();
    const days = parseInt(req.query.days) || 7;
    res.json(v14.websiteAnalytics.getTrend(days));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/analytics/funnel', (req, res) => {
  try {
    const v14 = initV14();
    res.json(v14.websiteAnalytics.getFunnel());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/analytics/sdk', (req, res) => {
  try {
    const v14 = initV14();
    res.type('text/javascript').send(v14.websiteAnalytics.getTrackingSDK());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/analytics/simulate', (req, res) => {
  res.status(403).json({ error: '模拟数据生成已禁用。请部署追踪SDK到真实引流网站以收集真实访问数据。' });
});

// ── 访问者行为追踪（按内容/帖子查询） ────────────
app.get('/api/v14/visitor-behavior/:contentId', (req, res) => {
  try {
    const v14 = initV14();
    const { contentId } = req.params;
    const opts = { limit: parseInt(req.query.limit) || 100 };

    // 从 WebsiteAnalytics 获取访问记录
    let webData = { totalVisits: 0, visits: [], byDevice: {}, byCountry: {}, bySource: {} };
    try {
      if (v14.websiteAnalytics && v14.websiteAnalytics.getVisitorBehaviorByContent) {
        webData = v14.websiteAnalytics.getVisitorBehaviorByContent(contentId, opts);
      }
    } catch(e) { /* module may not have the method */ }

    // 从 TrafficRouter 获取点击记录
    let trafficData = { totalClicks: 0, clicks: [], byCountry: {}, byPlatform: {} };
    try {
      if (v14.trafficRouter && v14.trafficRouter.getClickBehaviorByContent) {
        trafficData = v14.trafficRouter.getClickBehaviorByContent(contentId, opts);
      }
    } catch(e) { /* module may not have the method */ }

    // 从 DataStore 获取 analytics 记录（持久化的访问数据）
    let persistentVisits = [];
    try {
      if (dataStore.data && dataStore.data.analytics) {
        persistentVisits = dataStore.data.analytics
          .filter(r => r.content_id === contentId || r.post_id === contentId)
          .slice(-opts.limit)
          .map(r => ({
            id: r.id || r.evt_id,
            timestamp: r.timestamp || r.created_at,
            ip: r.ip,
            ua: r.user_agent || r.ua,
            referrer: r.referrer,
            platform: r.platform,
            country: r.country,
            device: r.device,
            dwellTime: r.dwell_time,
            clickPath: r.click_path,
          }));
      }
    } catch(e) { /* ignore */ }

    // 从 DataStore 获取 traffic_click_logs（短链点击记录）
    let trafficLogs = [];
    try {
      if (dataStore.data && dataStore.data.traffic_click_logs) {
        trafficLogs = dataStore.data.traffic_click_logs
          .filter(r => r.contentId === contentId || r.postId === contentId || r.content_id === contentId)
          .slice(-opts.limit)
          .map(r => ({
            id: r.id,
            timestamp: r.timestamp || r.created_at,
            shortCode: r.shortCode || r.short_code,
            linkId: r.linkId || r.link_id,
            ip: r.ip,
            ua: r.userAgent || r.ua,
            referrer: r.referrer,
            platform: r.platform,
            country: r.country,
          }));
      }
    } catch(e) { /* ignore */ }

    res.json({
      contentId,
      summary: {
        totalVisits: webData.totalVisits + persistentVisits.length,
        totalClicks: trafficData.totalClicks + trafficLogs.length,
        uniqueIps: new Set([
          ...(webData.visits || []).map(v => v.ip),
          ...persistentVisits.map(v => v.ip),
          ...(trafficData.clicks || []).map(c => c.ip),
          ...trafficLogs.map(c => c.ip),
        ].filter(Boolean)).size,
      },
      webVisits: { ...webData, visits: (webData.visits || []).slice(0, 20) },
      persistentVisits: persistentVisits.slice(0, 20),
      trafficClicks: { ...trafficData, clicks: (trafficData.clicks || []).slice(0, 20) },
      trafficLogs: trafficLogs.slice(0, 20),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Traffic Router (P2) ─────────────────────────
app.get('/api/v14/traffic/stats', (req, res) => {
  try {
    const v14 = initV14();
    // 优先使用 TrafficRouter 内存统计，如果为空则从 DataStore 聚合
    const memStats = v14.trafficRouter.getStats();
    
    // 如果内存中有数据，直接返回
    if (memStats && memStats.totalClicks > 0) {
      return res.json(memStats);
    }
    
    // 从 DataStore 持久化数据聚合
    const links = v14.dataStore.list('traffic_links') || [];
    const clicks = v14.dataStore.list('traffic_click_logs') || [];
    const linksArr = Array.isArray(links) ? links : (links.items || []);
    const clicksArr = Array.isArray(clicks) ? clicks : (clicks.items || []);
    
    // 按平台分组
    const byPlatform = {};
    clicksArr.forEach(c => {
      const p = c.platform || 'unknown';
      byPlatform[p] = (byPlatform[p] || 0) + 1;
    });
    
    res.json({
      ...memStats,
      totalLinks: linksArr.length,
      activeLinks: linksArr.filter(l => l.active !== false).length,
      totalClicks: clicksArr.length,
      totalUniqueClicks: new Set(clicksArr.map(c => c.ip)).size,
      byPlatform,
      bySource: memStats.bySource || {},
      byCountry: memStats.byCountry || {},
      byDevice: memStats.byDevice || {},
      byHour: memStats.byHour || {},
      conversionRate: '0%',
      _source: 'datastore (memory was empty after restart)'
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 【新增】获取爆款创作者引流链接（按健康分+点击量筛选） ──
app.get('/api/v14/traffic/top-creator-links', (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const limit = parseInt(req.query.limit || 10);
    const platform = req.query.platform || null;
    res.json(v14.trafficRouter.getTopCreatorLinks(limit, platform));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/traffic/links', async (req, res) => {
  try {
    const v14 = initV14();
    const link = await v14.trafficRouter.createLink(req.body);
    res.json(link);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/traffic/links/batch', async (req, res) => {
  try {
    const v14 = initV14();
    const { baseConfig, count } = req.body;
    const links = await v14.trafficRouter.batchCreate(baseConfig, count);
    res.json({ created: links.length, links });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/traffic/links', (req, res) => {
  try {
    const v14 = initV14();
    // 优先 TrafficRouter 内存数据
    const memLinks = v14.trafficRouter.listLinks(req.query);
    const memArr = Array.isArray(memLinks) ? memLinks : (memLinks?.items || memLinks?.links || []);
    
    if (memArr.length > 0) {
      return res.json(memLinks);
    }
    
    // 从 DataStore 加载持久化链接并映射字段名（前端模板期望 camelCase）
    const dsLinks = v14.dataStore.list('traffic_links') || [];
    const dsArr = Array.isArray(dsLinks) ? dsLinks : (dsLinks.items || []);
    const clicks = v14.dataStore.list('traffic_click_logs') || [];
    const clicksArr = Array.isArray(clicks) ? clicks : (clicks.items || []);
    const links = dsArr.map(l => {
      const linkClicks = clicksArr.filter(c => c.short_code === l.short_code || c.link_id === l.link_id);
      const uniqueIps = new Set(linkClicks.map(c => c.ip).filter(Boolean));
      return {
        id: l.link_id || l.id,
        shortCode: l.short_code || l.shortCode,
        shortUrl: l.short_url || `http://localhost:3002/s/${l.short_code}`,
        originalUrl: l.target_url || l.originalUrl || '',
        source: l.platform || l.source || 'unknown',
        medium: l.medium || '',
        campaign: l.campaign || `auto_${l.post_id || l.id}`,
        content: l.content_id || l.content,
        active: true,
        clicks: linkClicks.length,
        uniqueClicks: uniqueIps.size,
        platform: l.platform,
        account_id: l.account_id,
        content_id: l.content_id,
        post_id: l.post_id,
        createdAt: l.createdAt || l.created_at,
        _source: 'datastore'
      };
    });
    res.json(links);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/traffic/links/:code', (req, res) => {
  try {
    const v14 = initV14();
    const link = v14.trafficRouter.getLink(req.params.code);
    if (!link) return res.status(404).json({ error: 'Not found' });
    res.json(link);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/traffic/links/:code/clicks', (req, res) => {
  try {
    const v14 = initV14();
    const history = v14.trafficRouter.getClickHistory(req.params.code, parseInt(req.query.limit) || 50);
    res.json(history);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/traffic/links/:code/deactivate', (req, res) => {
  try {
    const v14 = initV14();
    v14.trafficRouter.deactivateLink(req.params.code);
    res.json({ deactivated: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/traffic/links/:code/activate', (req, res) => {
  try {
    const v14 = initV14();
    v14.trafficRouter.activateLink(req.params.code);
    res.json({ activated: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/traffic/conversions', (req, res) => {
  try {
    const v14 = initV14();
    res.json(v14.trafficRouter.getRecentConversions(parseInt(req.query.limit) || 50));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 短链重定向端点
app.get('/r/:code', async (req, res) => {
  try {
    const v14 = initV14();
    const result = await v14.trafficRouter.handleClick(req.params.code, {
      ip: req.ip,
      userAgent: req.get('user-agent'),
      referrer: req.get('referrer'),
    });
    if (result.error) return res.status(result.status).json(result);
    res.redirect(302, result.redirectUrl);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/traffic/simulate', async (req, res) => {
  res.status(403).json({ error: '模拟点击数据已禁用。引流链接将在真实社媒内容发布后自动收集真实点击数据。' });
});

// ═══════════════════════════════════════════════════════════
//  流量业务动态 + 异常监控 时间序列 API（看板「打开即自动刷新」数据源）
//  GET /api/v14/traffic/monitor-timeseries  (只读聚合数仓四表)
//  与 traffic-monitor-agg.js / build_traffic_monitor.js 共享同一聚合逻辑
// ═══════════════════════════════════════════════════════════
let _trafficAgg = null;
try { _trafficAgg = require('./traffic-monitor-agg.js'); } catch (e) { _trafficAgg = null; }
app.get('/api/v14/traffic/monitor-timeseries', (req, res) => {
  try {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (!_trafficAgg) return res.status(500).json({ error: 'aggregator module unavailable' });
    const data = _trafficAgg.getTrafficModel();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.options('/api/v14/traffic/monitor-timeseries', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.status(204).end();
});

// ═══════════════════════════════════════════════════════════
//  需求2: 发布内容预览页 — 确保每一条发布链接真实可点击、有内容、无黑屏
//  路由: GET /content/:platform/:id  (由 cloud-publisher publishUrl 指向)
// ═══════════════════════════════════════════════════════════
app.get('/content/:platform/:id', async (req, res) => {
  try {
    const v14 = initV14();
    const { platform, id } = req.params;
    const dataStore = v14.dataStore;

    // 优先从 DataStore 读取内容(携带 account_id, 闭环可溯源)
    let content = null;
    try { content = dataStore.get('content', id); } catch (e) {}
    // 回退: 从 publish 表读取(内容可能被剪枝, 但发布记录常驻)
    let publish = null;
    if (!content) { try { publish = dataStore.get('publish', `pub_${id}`) || dataStore.get('publish', id); } catch (e) {} }

    const title = (content && content.title) || (publish && publish.title) || `MSCMS 内容预览 · ${platform}`;
    const body = (content && content.body) || (publish && publish.body) || `这条内容已通过 MSCMS v14 因果链真实发布到 ${platform}。`;
    // 反查发布表(按 content_id)以拿到真实发布账户 — 确保流量统计归属闭环账户
    if ((!content || !content.account_id) && !publish) {
      try {
        const pubRes = dataStore.list('publish', { filter: { content_id: id }, limit: 1 });
        const pubHit = (pubRes && pubRes.items && pubRes.items[0]) || null;
        if (pubHit) publish = pubHit;
      } catch (e) {}
    }
    const accountId = (content && content.account_id) || (publish && publish.account_id) || 'mscms-system';
    const contentType = (content && content.content_type) || 'text';
    const quality = (content && content.quality_score) || 0;
    const publishedAt = (publish && publish.published_at) || (content && content.generated_at) || new Date().toISOString();

    const platformLabel = (platform || '').toUpperCase();
    const brandColor = {
      tumblr: '#36465d', reddit: '#ff4500', instagram: '#e1306c',
      tiktok: '#010101', x: '#1d9bf0', twitter: '#1d9bf0',
      discord: '#5865f2', facebook: '#1877f2',
    }[platform] || '#6c5ce7';

    const html = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · ${platformLabel}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;
         background:${brandColor}; color:#fff; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px; }
  .card { background:rgba(255,255,255,0.08); backdrop-filter:blur(12px); border:1px solid rgba(255,255,255,0.18);
          border-radius:18px; max-width:680px; width:100%; padding:32px; box-shadow:0 20px 60px rgba(0,0,0,0.35); }
  .badge { display:inline-block; background:rgba(255,255,255,0.2); padding:6px 14px; border-radius:999px;
           font-size:13px; font-weight:700; letter-spacing:.5px; margin-bottom:18px; }
  h1 { font-size:24px; line-height:1.4; margin-bottom:16px; word-break:break-word; }
  .body { font-size:16px; line-height:1.7; opacity:.92; white-space:pre-wrap; word-break:break-word; }
  .meta { margin-top:24px; padding-top:18px; border-top:1px solid rgba(255,255,255,0.18);
          display:flex; flex-wrap:wrap; gap:18px; font-size:13px; opacity:.85; }
  .meta b { font-weight:700; }
  .foot { margin-top:18px; font-size:12px; opacity:.7; }
  .ok { color:#7CFFB2; font-weight:700; }
</style>
</head>
<body>
  <div class="card">
    <span class="badge">${platformLabel} · MSCMS 真实发布</span>
    <h1>${escapeHtml(title)}</h1>
    <div class="body">${escapeHtml(body)}</div>
    <div class="meta">
      <span>账户: <b>${escapeHtml(String(accountId))}</b></span>
      <span>类型: <b>${escapeHtml(contentType)}</b></span>
      <span>质量分: <b>${quality}</b></span>
      <span>发布时间: <b>${escapeHtml(new Date(publishedAt).toLocaleString())}</b></span>
    </div>
    <div class="foot">✅ 此链接由 MSCMS v14 因果链闭环生成 · 账户 ${escapeHtml(String(accountId))} 一致发布 · <span class="ok">链接有效可访问</span></div>
  </div>
</body>
</html>`;

    // 需求2: 真实点击即记录流量 — 每条公开链接可查询其访问量(防止黑屏/死链无数据)
    try {
      if (v14.accountLoop && v14.accountLoop.recordLinkTraffic) {
        v14.accountLoop.recordLinkTraffic(id, {
          ip: (req.headers['x-forwarded-for'] || req.ip || 'direct').toString().split(',')[0].trim(),
          platform,
          account_id: accountId,
          userAgent: req.get('user-agent') || 'browser',
          referer: req.get('referer') || '',
          source: 'preview_page_view',
        });
      }
    } catch (trackErr) { /* 非关键, 不影响渲染 */ }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(html);
  } catch (e) {
    res.status(500).send(`<h1>预览加载失败</h1><p>${escapeHtml(e.message)}</p>`);
  }
});

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// ── 需求2: 每条链接流量查询 API ──
app.get('/api/v14/traffic/link/:linkId', (req, res) => {
  try {
    const v14 = initV14();
    const linkId = req.params.linkId;
    const traffic = v14.accountLoop.getLinkTraffic(linkId);
    res.json({ link_id: linkId, ...traffic });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════
// P1 抓取链路：热点采集（trends-scraper.js 落盘 → 服务侧直读磁盘）
// 说明：刻意不进 DataStore —— DataStore 是「内存优先 + 5s flush」，
//       外部脚本写入会被内存旧数据覆盖（已在 P0 隔离时踩过此坑）。
// ══════════════════════════════════════════════════════════════════════
// 惰性求值：initV14() 内部也会调用，避免顶层 const 的 TDZ 问题
function trendsFile() { return path.join(PATHS.DATA_DIR, 'trends.json'); }
function readTrends() {
  try { return JSON.parse(fs.readFileSync(trendsFile(), 'utf8')); } catch (e) { return []; }
}
/** 按业务相关性挑一个真实热点作为生成 topic；无数据则回落 'trending'（不伪造） */
function pickTrendTopic() {
  try {
    const arr = readTrends();
    const rel = arr.filter((x) => (x.relevance || 0) > 0)
      .sort((a, b) => (b.relevance || 0) - (a.relevance || 0));
    if (!rel.length) return 'trending';
    const pool = rel.slice(0, 20);
    return String(pool[Math.floor(Math.random() * pool.length)].title).slice(0, 120);
  } catch (e) { return 'trending'; }
}

// ── P1 质检单轨 ──────────────────────────────────────────────────────
// 旧 quality_score 是本地模板分（实测恒 75~95，连 "400 Bad Request" 都能拿 80 分），
// 对质量毫无区分度 → 质检闸门形同虚设。新内容改用 quality_v2，发布准入以它为准。
// 维度：有效性 40 + 完整性 20 + 业务相关性 20 + AI 味 20 = 100，≥60 才进 ready 池。
const Q2_BAD_RE = /^(400|401|403|404|405|408|429|500|502|503|504)\b|bad request|auto-generated|internal server error|service unavailable|unauthorized|forbidden|not found|gateway|error occurred|timed? ?out|^post for\s+[\w-]+$|^\s*(undefined|null)\s*$/i;
// ── P1-D 正文指纹索引（生成侧去重；按 body 而非 id）──────────────────
// 禁用 id 查重的原因：内容池产物落库时 id 曾被 `content_direct_<ts>_<i>` 兜底，
// 每次生成都不同 → 查重恒 miss（实测重复率 65.3% 却从未被拦下）。
const _ctTools = require('./content-tagger.js');
// [P2-B5] 真实媒体判定（单一事实源）：preview_url 是内容存档 JSON 路径，不是媒体。
// 详见 content-media-ref.js 头部注释（实测 1,340 条 preview_url 100% 为 .json）。
const _mediaRef = require('./content-media-ref.js');
const contentHasRealMedia = _mediaRef.contentHasRealMedia;
const pickMediaFields = _mediaRef.pickMediaFields;

const _bodyFpIndex = new Set();
let _bodyFpIndexLoaded = false;
function ensureBodyFpIndex(ds) {
  if (_bodyFpIndexLoaded) return;
  _bodyFpIndexLoaded = true;
  try {
    // DataStore.list() 返回分页对象 { items, total, page, limit, pages }（非数组）
    const _res = ds.list('content', { limit: 50000 });
    const rows = Array.isArray(_res) ? _res : (_res && Array.isArray(_res.items) ? _res.items : []);
    let n = 0;
    for (const c of rows) { if (c && c.body_fp) { _bodyFpIndex.add(c.body_fp); n++; } }
    console.log(`[dedup] 正文指纹索引已加载: ${n} 条（存量无 body_fp 属正常，随新内容逐步积累）`);
  } catch (e) { console.warn('[dedup] 指纹索引加载失败: ' + e.message); }
}

function computeQualityV2(c) {
  const t = String(c.title || '').trim();
  const b = String(c.body || c.text || '').trim();
  // [P2-B5 2026-09-16] 媒体判定纠正：原为 `!!(c.preview_url || c.previewUrl)`，
  // 而本库 preview_url 实测 100% 是 saveContentToFile() 写入的内容存档 JSON 路径
  // （1,340 条全为 `/content/.../<id>.json`），真媒体在 media_path（7,262 条）。
  // 只看 preview_url 会双向误判：假的算「有图」(放宽完整性 + 豁免空正文封顶)，
  // 真的反而不算「有图」。故统一走 contentHasRealMedia()。
  const hasMedia = contentHasRealMedia(c);
  let s = 0;
  if (t && !Q2_BAD_RE.test(t)) s += 40;                              // ① 有效性
  // ② 完整性 —— 只认正文长度。原实现为 `b.length || t.length`，即正文为空时
  //    回退用标题长度计分，使「只有标题、没有正文」的记录也能拿 12~20 分，
  //    叠加阈值 60 后仍能达标 → 实测 ready 池 78% 为空正文。零伪造：不让空
  //    正文蹭完整性分。
  const len = hasMedia ? Math.max(b.length, 80) : b.length;
  if (len >= 80) s += 20; else if (len >= 30) s += 12; else if (len >= 15) s += 6;
  let rel = 0;                                                       // ③ 业务相关性
  try { rel = require('./tools/trends-scraper.js').relevanceOf(t + ' ' + b); } catch (e) { rel = 0; }
  if (rel >= 6) s += 20; else if (rel >= 3) s += 14; else if (rel >= 1) s += 8;
  const ai = Number(c.ai_score);                                     // ④ AI 味（越低越像人写）
  if (!Number.isFinite(ai) || ai <= 0) s += 10;                      //    无 AI 评分不给满分
  else if (ai < 20) s += 20; else if (ai < 40) s += 14; else if (ai < 60) s += 8;
  // ⑤ 纯文本但正文不足 30 字 → 封顶 40，永不达标（≥60 才进 ready 发布池）
  if (!hasMedia && b.length < 30) s = Math.min(s, 40);
  // ⑥ P1-B2 标签闸门：无标签不得进 ready 池（裸发到平台等于浪费一次发布配额）。
  //    仅在调用方「显式传入 tags 键」时生效 —— 新生成路径会传，
  //    存量内容（12,608 条无 tags）与发布侧旧判定不受影响，避免回溯拦空导致发布归零。
  if (Object.prototype.hasOwnProperty.call(c, 'tags')) {
    const tagList = Array.isArray(c.tags) ? c.tags.filter((x) => x && String(x).trim()) : [];
    if (tagList.length === 0) s = Math.min(s, 40);
  }
  return Math.max(0, Math.min(100, s));
}

/**
 * 出口（公网 IP）健康总览 —— 2026-09-08
 * 业务价值：Tumblr 429 = 出口 IP 被限流 = 系统「空转」。此处把每个出口的
 *   成功/失败次数、是否冷却中、剩余冷却秒数暴露出来，让「系统为什么没产出」可诊断。
 */
app.get('/api/v14/exits/health', (req, res) => {
  try {
    const { ProxyPool } = require('./proxy-pool');
    const pool = new ProxyPool();
    const exits = pool.healthSnapshot();
    const uniqueIps = new Set(exits.map((e) => e.exitIp).filter(Boolean)).size;
    const cooling = exits.filter((e) => e.cooling).length;
    res.json({
      ok: true,
      exits,
      summary: {
        total: exits.length,
        uniqueExitIps: uniqueIps,
        cooling,
        healthy: exits.length - cooling,
        // 唯一出口 IP ≤1 且正在冷却 → 必然空转（所有账号都打不出去）
        atRisk: uniqueIps <= 1 || cooling >= exits.length,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =====================================================================
   出口（公网 IP）调度中心 —— 2026-09-09
   ---------------------------------------------------------------------
   为什么要有这套接口：
     - IPRoyal 采购的 5 个静态 IP 走 Tumblr 全部 ECONNRESET（IP 段被拒），
       但抓取 / 注册等非 Tumblr 链路完全可用。此前只能改 JSON 落盘，网页端
       完全看不见 → 运维无法判断「花钱买的 IP 到底在不在干活」，这就是需求
       「这 5 个 IP 要通过网页端用起来」的由来。
     - 出口用途分三类：post（发布/养号，走 Tumblr）、scrape（抓取/回采）、
       off（停用）。scrape 用途会实时同步给 tools/trends-scraper.js 读的
       配置，改完下次抓取即生效（无需重启主服务）；post 用途需重启 3002/3005。
   ===================================================================== */
const EXIT_FS = require('fs');
const EXIT_PATH = require('path');
const EXIT_POOL_FILE = EXIT_PATH.join(__dirname, 'proxy-pool.json');
const EXIT_POOL_MIRROR = 'C:/Users/AS/WorkBuddy/2026-06-13-19-42-19/proxy-pool.json';
const IPR_FILE = 'D:/mscms-ws/config/iproyal.json';

function exitReadPool() {
  try {
    const a = JSON.parse(EXIT_FS.readFileSync(EXIT_POOL_FILE, 'utf8'));
    return Array.isArray(a) ? a : [];
  } catch (e) { return []; }
}
function exitWritePool(list) {
  EXIT_FS.writeFileSync(EXIT_POOL_FILE, JSON.stringify(list, null, 2), 'utf8');
  try { EXIT_FS.writeFileSync(EXIT_POOL_MIRROR, JSON.stringify(list, null, 2), 'utf8'); } catch (e) { /* 镜像可选 */ }
}
function exitUsage(p) {
  if (p.usage === 'post' || p.usage === 'scrape' || p.usage === 'off') return p.usage;
  if (p.enabled === false) return 'off';
  return p.src === 'iproyal' ? 'scrape' : 'post';
}
function exitMask(u) {
  return String(u || '').replace(/^(\w+:\/\/)([^:@/]+):([^@/]*)@/, '$1$2:***@');
}
function exitGroup(p) {
  if (p.src === 'iproyal') return 'IPRoyal 采购';
  if (p.src === 'cf-worker') return 'Cloudflare Workers';
  if (/^gh-/.test(p.name || '')) return 'GitHub 免费代理';
  if (/brd|bright/i.test(p.name || '')) return 'Bright Data';
  return '本机中继';
}
/** 把「抓取用途且启用」的采购 IP 同步给抓取器配置（trends-scraper 每次运行读盘） */
function exitSyncScrape(list) {
  const use = list.filter((p) => p.src === 'iproyal' && p.enabled !== false && exitUsage(p) === 'scrape');
  let base = {};
  try { base = JSON.parse(EXIT_FS.readFileSync(IPR_FILE, 'utf8')); } catch (e) { base = {}; }
  const next = Object.assign({}, base, {
    updatedAt: new Date().toISOString(),
    source: 'proxy-pool(web)',
    proxies: use.map((p) => ({ name: p.name, url: p.url, exitIp: p.exitIp })),
  });
  try { EXIT_FS.writeFileSync(IPR_FILE, JSON.stringify(next, null, 2), 'utf8'); return use.length; }
  catch (e) { return -1; }
}
/** 实时体检一条出口：探测真实出网 IP + Tumblr 是否可达 */
async function exitProbe(url) {
  const out = { exitIp: null, http: null, tumblr: '未测', ms: 0, err: '' };
  const t0 = Date.now();
  try {
    const { fetchExt } = require('./http-client');
    for (const u of ['https://api.ipify.org?format=json', 'https://ifconfig.me/all.json', 'http://api.ipify.org?format=json']) {
      try {
        const r = await fetchExt(u, { timeout: 12000 }, url);
        if (r.ok) {
          const t = await r.text();
          let ip = null;
          try { const j = JSON.parse(t); ip = j.ip || j.ip_addr || null; } catch (e) { ip = (t.match(/\d+\.\d+\.\d+\.\d+/) || [null])[0]; }
          if (ip) { out.exitIp = ip; out.http = r.status; break; }
        }
        out.http = r.status;
      } catch (e) { out.err = String(e.message || e).slice(0, 60); }
    }
    // ⚠️ 必须绕开 http-client 的 BD Unlocker 自动路由：*.tumblr.com 的 GET 会被
    // 自动转给 Bright Data 桥（该账户已停用，桥内部还抛 ReferenceError），
    // 那样测的是桥的出口、不是本条出口，结论完全失真。故此处原生直连被测代理。
    try {
      const { ProxyAgent, fetch: undiciFetch } = require('undici');
      const agent = new ProxyAgent(url);
      const ctl = new AbortController();
      const to = setTimeout(() => { try { ctl.abort(); } catch (e) { /* noop */ } }, 12000);
      let r2 = null;
      try {
        r2 = await undiciFetch('https://www.tumblr.com/', {
          dispatcher: agent, signal: ctl.signal,
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        });
      } finally { clearTimeout(to); }
      const st = r2.status;
      if (st === 407) out.tumblr = '代理拒绝 407';
      else if (st === 429) out.tumblr = '限流 429';
      else if (r2.ok || [401, 403, 404].indexOf(st) >= 0) out.tumblr = '可达 ' + st;
      else out.tumblr = 'HTTP ' + st;
    } catch (e) { out.tumblr = '被拒 ' + String(e.message || e).slice(0, 28); }
  } catch (e) { out.err = String(e.message || e).slice(0, 80); }
  out.ms = Date.now() - t0;
  return out;
}

/** 全量出口清单（含停用），供网页端展示与调度 */
app.get('/api/v14/exits/list', (req, res) => {
  try {
    const list = exitReadPool();
    const items = list.map((p) => ({
      name: p.name || p.url,
      url: exitMask(p.url),
      exitIp: p.exitIp || null,
      src: p.src || null,
      group: exitGroup(p),
      usage: exitUsage(p),
      enabled: p.enabled !== false,
      weight: p.weight || 1,
      note: p._note || '',
      lastCheck: p._lastCheck || null,
    }));
    const byUsage = items.reduce((a, x) => { a[x.usage] = (a[x.usage] || 0) + 1; return a; }, {});
    const ipr = items.filter((x) => x.src === 'iproyal');
    let scrapeFile = { count: 0, updatedAt: null };
    try {
      const j = JSON.parse(EXIT_FS.readFileSync(IPR_FILE, 'utf8'));
      scrapeFile = { count: (j.proxies || []).length, updatedAt: j.updatedAt || null };
    } catch (e) { /* 文件不存在则显示 0 */ }
    res.json({
      ok: true,
      items,
      summary: {
        total: items.length,
        byUsage,
        uniqueExitIps: new Set(items.filter((x) => x.enabled).map((x) => x.exitIp).filter(Boolean)).size,
        iproyal: {
          total: ipr.length,
          active: ipr.filter((x) => x.enabled).length,
          scrape: ipr.filter((x) => x.usage === 'scrape' && x.enabled).length,
          post: ipr.filter((x) => x.usage === 'post' && x.enabled).length,
        },
        scrapeFile,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** 设置出口用途：post（发布/养号）| scrape（抓取）| off（停用） */
app.post('/api/v14/exits/set', (req, res) => {
  try {
    const { name, usage } = req.body || {};
    if (!name || !usage) return res.status(400).json({ ok: false, error: 'name / usage 必填' });
    if (['post', 'scrape', 'off'].indexOf(usage) < 0) return res.status(400).json({ ok: false, error: 'usage 只能是 post | scrape | off' });
    const list = exitReadPool();
    const p = list.find((x) => (x.name || x.url) === name);
    if (!p) return res.status(404).json({ ok: false, error: '未找到出口 ' + name });
    p.usage = usage;
    p.enabled = usage !== 'off';
    // cloud-publisher 自带一轮池过滤（只认 tumblr 字段），与 usage 保持同步，
    // 避免「网页端设成抓取、发布器却仍按 tumblr:true 取用」的两套语义打架。
    p.tumblr = usage === 'post';
    exitWritePool(list);
    const n = exitSyncScrape(list);
    res.json({
      ok: true, name, usage, enabled: p.enabled, scrapeSynced: n,
      needRestart: usage === 'post',
      tip: usage === 'scrape'
        ? `已同步给抓取器（${n} 条），下次抓取自动使用，无需重启`
        : (usage === 'post' ? '已启用为发布出口，需重启 3002 / 3005 才会被 ProxyPool 加载' : '已停用，下轮调度不再使用'),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** 实时体检：name 为空则体检全部启用中的出口（上限 12 条，避免长时间阻塞） */
app.post('/api/v14/exits/test', async (req, res) => {
  try {
    const { name } = req.body || {};
    const list = exitReadPool();
    const targets = name ? list.filter((x) => (x.name || x.url) === name) : list.filter((x) => x.enabled !== false);
    if (!targets.length) return res.status(404).json({ ok: false, error: '没有可体检的出口' });
    // 上限提高到 60（出口已扩到 20+，原 12 条上限会导致新出口永远体检不到）；
    // 小并发 4 提速——串行 26 条要 2 分钟以上，容易被前端当超时。
    const MAX = 60;
    const picked = targets.slice(0, MAX);
    const out = new Array(picked.length);
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, picked.length) }, async () => {
        while (cursor < picked.length) {
          const i = cursor++;
          const p = picked[i];
          const r = await exitProbe(p.url);
          out[i] = {
            name: p.name || p.url, group: exitGroup(p), usage: exitUsage(p),
            declaredIp: p.exitIp || null, realIp: r.exitIp || null,
            http: r.http, tumblr: r.tumblr, ms: r.ms, err: r.err,
          };
          // 回写体检结论：网页端「上次体检」列直接显示真实结果，不再显示落盘时的静态备注
          p._lastCheck = { at: new Date().toISOString(), realIp: r.exitIp || null, http: r.http, tumblr: r.tumblr, ms: r.ms };
          // 实测 IP 与声明不符时以实测为准：出口 IP 会漂移（CF 边缘按 PoP 分配），
          // 而 proxy-pool 按 exitIp 分组冷却，IP 记错会导致健康出口被一起误冷却。
          if (r.exitIp && r.exitIp !== p.exitIp) { p.exitIp = r.exitIp; }
        }
      })
    );
    const results = out.filter(Boolean);
    exitWritePool(list);
    res.json({ ok: true, results, checkedAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** 立即跑一次抓取（验证采购 IP 是否真在干活） */
app.post('/api/v14/exits/scrape-now', (req, res) => {
  try {
    const { spawn } = require('child_process');
    const ws = 'C:/Users/AS/WorkBuddy/2026-06-13-19-42-19';
    const child = spawn(process.execPath, ['tools/trends-scraper.js', '--run'], {
      cwd: ws, detached: true, stdio: ['ignore', 'ignore', 'ignore'],
      env: Object.assign({}, process.env, { NODE_PATH: ws + '/node_modules' }),
    });
    child.unref();
    res.json({ ok: true, pid: child.pid, tip: '已在后台执行一次抓取，约 1–2 分钟后看「热点灵感」面板' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/v14/trends/status', (req, res) => {
  const arr = readTrends();
  const by = {};
  arr.forEach((x) => { by[x.source] = (by[x.source] || 0) + 1; });
  res.json({
    total: arr.length, bySource: by,
    lastFetchedAt: arr.length ? arr[arr.length - 1].fetchedAt : null,
    file: trendsFile(), scraper: 'tools/trends-scraper.js',
  });
});

app.get('/api/v14/trends/hot', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 200);
  const minRel = Number(req.query.minRel) || 0;
  const arr = readTrends()
    .filter((x) => (x.relevance || 0) >= minRel)
    .sort((a, b) => ((b.relevance || 0) - (a.relevance || 0)) || ((b.score || 0) - (a.score || 0)));
  res.json({ total: arr.length, items: arr.slice(0, limit) });
});

app.get('/api/v14/scrape/status', (req, res) => {
  const arr = readTrends();
  const by = {};
  arr.forEach((x) => { by[x.source] = (by[x.source] || 0) + 1; });
  res.json({
    enabled: true,
    sources: ['google_trends', 'devto', 'hackernews', 'medium', 'lobsters'],
    excluded: { reddit: 'HTTP 403 反爬（需 OAuth）', tumblr_api: 'HTTP 401（需 api_key）' },
    total: arr.length, bySource: by,
  });
});

app.post('/api/v14/scrape/run', async (req, res) => {
  try {
    const { scrapeAll } = require('./tools/trends-scraper.js');
    const r = await scrapeAll();
    res.json({ ok: true, added: r.added, dup: r.dup, sources: r.sources, total: r.totalOnDisk });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/v14/traffic/link-summary', (req, res) => {
  try {
    const v14 = initV14();
    let summary = {};
    try { summary = v14.accountLoop.getAllLinkTrafficSummary() || {}; } catch (e) { summary = {}; }
    let source = 'accountLoop';
    // ── P0 度量修复：accountLoop 内存为空时回落到 DataStore 的 traffic_links ──
    // 背景：DataStore 有 695 条真实短链，但本接口长期返回 total_links:0（引流数据完全不可见）。
    if (!Object.keys(summary).length) {
      try {
        const ds = v14 && v14.dataStore;
        if (!ds) throw new Error('v14.dataStore 不可用');
        const rows = ds.list('traffic_links', { limit: 5000 });
        const items = (rows && rows.items) ? rows.items : (Array.isArray(rows) ? rows : []);
        items.forEach((l) => {
          const code = l.short_code || l.link_id || l.id;
          if (code) summary[code] = l;
        });
        source = 'datastore:traffic_links';
        console.log(`[traffic] link-summary 回落 DataStore，读到 ${items.length} 条短链`);
      } catch (e) {
        console.warn('[traffic] link-summary 回落 DataStore 失败: ' + e.message);
      }
    }
    res.json({ total_links: Object.keys(summary).length, links: summary, source });
  } catch (e) { res.status(500).json({ error: e.message }); }
});



// ═══════════════════════════════════════════════════════════
//  引流转化模块 v2.0 API — 转化引擎
// ═══════════════════════════════════════════════════════════

// ── 记录转化事件 ──
app.post('/api/v14/conversion/event', (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const event = v14.conversionEngine.recordConversion(req.body);
    res.json({ success: true, event_id: event.event_id, event_type: event.event_type, level: event.level });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 批量转化 ──
app.post('/api/v14/conversion/batch', (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const events = v14.conversionEngine.batchRecord(req.body.events || []);
    res.json({ success: true, count: events.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 转化事件列表 ──
app.get('/api/v14/conversion/events', (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const { source, event_type, visitor_id, short_code, page, limit, startDate, endDate } = req.query;
    const result = v14.conversionEngine.getEvents({
      source, event_type, visitor_id, short_code,
      offset: parseInt(page || 0) * parseInt(limit || 50),
      limit: parseInt(limit || 50),
      startDate, endDate
    });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 转化漏斗 ──
app.get('/api/v14/conversion/funnel', (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    res.json(v14.conversionEngine.getFunnel());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 来源归因 ──
app.get('/api/v14/conversion/attribution', (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const days = parseInt(req.query.days || 30);
    const model = req.query.model || 'last_click';
    res.json(v14.conversionEngine.getSourceAttribution(days, model));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 转化统计 ──
app.get('/api/v14/conversion/stats', (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const stats = v14.conversionEngine.getStats() || {};
    // ── P0 数据可信度闸门（2026-09-07）─────────────────────────────
    // 实测：本接口报 457 次点击 / 228 次注册，但 publish 表真实 reach 仅 6。
    // 转化数远大于曝光数，违反漏斗基本逻辑 → 该数据不可用于业务决策。
    // 这里不篡改任何数字，只附加可信度标记，让前端/日报能明确告警。
    const clicks = Number(stats.totalEvents || 0);
    const conversions = Number(stats.totalConversions || 0);
    let realReach = null;
    try {
      const ds = v14 && v14.dataStore;
      if (!ds) throw new Error('v14.dataStore 不可用');
      const pr = ds.list('publish', { limit: 10000 });
      const items = (pr && pr.items) ? pr.items : (Array.isArray(pr) ? pr : []);
      realReach = items.reduce((s, p) => s + (Number(p.reach) || 0), 0);
    } catch (e) {
      console.warn('[conversion] 读取真实 reach 失败: ' + e.message);
      realReach = null;
    }
    const suspicious = realReach != null && clicks > realReach * 10;
    res.json({
      ...stats,
      dataQuality: {
        verified: false,
        suspicious,
        real_reach_total: realReach,
        note: suspicious
          ? `转化事件(${clicks})远大于真实曝光(${realReach})，疑为模拟/自填充数据，禁止用于业务决策`
          : '未经真实点击回传验证，仅供参考',
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 【新增】转化概览仪表盘 ──
app.get('/api/v14/conversion/overview', (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const days = parseInt(req.query.days || 30);
    // 【修复】每次请求自动加载历史数据防止丢失
    res.json(v14.conversionEngine.getOverview(days));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 导出CSV ──
app.get('/api/v14/conversion/export', (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const csv = v14.conversionEngine.exportCSV(req.query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="conversions.csv"');
    res.send(csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
//  引流转化模块 v2.0 API — Postback 多级回传
// ═══════════════════════════════════════════════════════════

app.post('/api/v14/postback/event', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const { click_id, event_type, event_value, visitor_id, source, short_code } = req.body;

    // 记录到统一转化引擎
    const event = v14.conversionEngine.recordConversion({
      event_type: event_type || 'signup',
      event_value: event_value || 0,
      visitor_id,
      source: source || 'direct',
      short_code,
      timestamp: new Date().toISOString()
    });

    // 更新 MySQL 转化表
    if (click_id && pool) {
      try {
        await pool.execute(
          `UPDATE traffic_conversions SET is_converted=1, payout=?, converted_at=NOW() WHERE click_id=? AND is_converted=0`,
          [event_value || 0, click_id]
        );

        // DD.txt 动态权重调优
        const gain = v14.conversionEngine.calculateWeightGain(event);
        const [rows] = await pool.execute(
          `SELECT bot_id, status, total_conversions FROM traffic_accounts WHERE bot_id = (SELECT bot_id FROM traffic_conversions WHERE click_id=?)`,
          [click_id]
        );
        if (rows.length > 0) {
          const account = rows[0];
          const newWeight = Math.min((account.weight || 100) + gain, 500);
          await pool.execute(
            `UPDATE traffic_accounts SET weight=?, total_conversions=total_conversions+1, last_used_at=NOW(), status=IF(status IN ('warming','shadowbanned'),'active',status) WHERE bot_id=?`,
            [newWeight, account.bot_id]
          );
        }
      } catch (dbErr) { /* DB 不可用时不影响主流程 */ }
    }

    res.json({ success: true, event_id: event.event_id, weight_gain: v14.conversionEngine.calculateWeightGain(event) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/postback/event', async (req, res) => {
  // DD.txt GET兼容
  try {
    const v14 = initV14();
    const { click_id, event_type, event_value, visitor_id, source } = req.query;
    const event = v14.conversionEngine.recordConversion({
      event_type: event_type || 'signup',
      event_value: parseFloat(event_value) || 0,
      visitor_id,
      source: source || 'direct',
      timestamp: new Date().toISOString()
    });
    res.json({ success: true, event_id: event.event_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 转化像素 (1x1 GIF)
app.get('/api/v14/postback/pixel/:campaignId', (req, res) => {
  try {
    const v14 = initV14();
    const { campaignId } = req.params;
    const { sc, vid, src } = req.query;

    v14.conversionEngine.recordConversion({
      event_type: 'page_view',
      visitor_id: vid || 'anon',
      source: src || 'pixel',
      short_code: sc || null,
      campaign_id: campaignId,
      timestamp: new Date().toISOString()
    });

    // 返回1x1透明GIF
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Cache-Control', 'no-cache, no-store');
    res.send(gif);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
//  引流转化模块 v2.0 API — 归因引擎
// ═══════════════════════════════════════════════════════════

app.post('/api/v14/attribution/touch', (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const { visitor_id, channel, touch_type, url, short_code } = req.body;
    v14.attributionEngine.recordTouch(visitor_id, { channel, touch_type, url, short_code });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/attribution/overview', (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const days = parseInt(req.query.days || 30);
    // 【修复】每次请求自动加载历史数据，防止"每次打开后台历史数据不加载"
    res.json(v14.attributionEngine.getOverview(days));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/attribution/roi', (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const days = parseInt(req.query.days || 30);
    const model = req.query.model || 'last_click';
    res.json(v14.attributionEngine.getChannelROI(days, model));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/attribution/models', (req, res) => {
  const { ATTRIBUTION_MODELS } = require('./attribution-engine.js');
  res.json(Object.values(ATTRIBUTION_MODELS));
});

app.get('/api/v14/attribution/path/:visitorId', (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    res.json(v14.attributionEngine.getTouchPath(req.params.visitorId));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/attribution/stats', (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    res.json(v14.attributionEngine.getStats());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
//  引流转化模块 v2.0 API — Cloaking 多模板
// ═══════════════════════════════════════════════════════════

app.get('/api/v14/cloaking/templates', (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    res.json(v14.cloakTemplates.getTemplates());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/cloaking/templates/:id', (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const tmpl = v14.cloakTemplates.getTemplate(req.params.id);
    if (!tmpl) return res.status(404).json({ error: 'Template not found' });
    res.json(tmpl);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/cloaking/preview/:id', (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).send('v14 not initialized');
    const html = v14.cloakTemplates.render(req.params.id, { dynamic: req.query.dynamic !== 'false' });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) { res.status(500).send(`Error: ${e.message}`); }
});

app.get('/api/v14/cloaking/test', (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const ua = req.query.ua || req.headers['user-agent'] || '';
    const ip = req.ip || '';
    const result = v14.cloakTemplates.detectBot(ua, ip, req.headers);
    res.json({ ...result, ua: ua.slice(0, 200) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/cloaking/stats', (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    res.json(v14.cloakTemplates.getStats());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
//  引流转化模块 v2.0 API — A/B实验
// ═══════════════════════════════════════════════════════════

app.get('/api/v14/experiments', (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const status = req.query.status || null;
    res.json(v14.experimentEngine.listExperiments(status));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/experiments', (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const exp = v14.experimentEngine.createExperiment(req.body);
    res.json({ success: true, id: exp.id, name: exp.name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/experiments/:id', (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const exp = v14.experimentEngine.getExperiment(req.params.id);
    if (!exp) return res.status(404).json({ error: 'Experiment not found' });
    res.json(exp);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/experiments/:id/start', (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const exp = v14.experimentEngine.startExperiment(req.params.id);
    if (!exp) return res.status(400).json({ error: 'Cannot start experiment' });
    res.json({ success: true, status: exp.status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/experiments/:id/pause', (req, res) => {
  try {
    const v14 = initV14();
    const exp = v14.experimentEngine.pauseExperiment(req.params.id);
    if (!exp) return res.status(400).json({ error: 'Cannot pause' });
    res.json({ success: true, status: exp.status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/experiments/:id/stop', (req, res) => {
  try {
    const v14 = initV14();
    const exp = v14.experimentEngine.stopExperiment(req.params.id, req.body.winnerId);
    if (!exp) return res.status(400).json({ error: 'Cannot stop' });
    res.json({ success: true, status: exp.status, winnerId: exp.winnerVariantId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/experiments/:id/impression', (req, res) => {
  try {
    const v14 = initV14();
    v14.experimentEngine.recordImpression(req.params.id, req.body.variantId);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/experiments/:id/conversion', (req, res) => {
  try {
    const v14 = initV14();
    const { variantId, eventType, value } = req.body;
    v14.experimentEngine.recordConversion(req.params.id, variantId, eventType, value || 0);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
//  引流转化模块 v2.0 API — 告警系统
// ═══════════════════════════════════════════════════════════

app.get('/api/v14/alerts', (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const { level, channel, page, limit } = req.query;
    res.json(v14.alertEngine.getAlerts({ level, channel, offset: parseInt(page || 0) * 20, limit: parseInt(limit || 20) }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/alerts/:id/acknowledge', (req, res) => {
  try {
    const v14 = initV14();
    const alert = v14.alertEngine.acknowledgeAlert(req.params.id);
    if (!alert) return res.status(404).json({ error: 'Alert not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/alerts/:id/resolve', (req, res) => {
  try {
    const v14 = initV14();
    const alert = v14.alertEngine.resolveAlert(req.params.id);
    if (!alert) return res.status(404).json({ error: 'Alert not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/alerts/rules', (req, res) => {
  try {
    const v14 = initV14();
    res.json(v14.alertEngine.getRules());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/alerts/stats', (req, res) => {
  try {
    const v14 = initV14();
    res.json({ ...v14.alertEngine.getStats(), activeCount: v14.alertEngine.getActiveAlertCount() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
//  引流转化模块 v2.0 API — 渠道健康
// ═══════════════════════════════════════════════════════════

// ── [B0-D3] tumblr 渠道健康：注入真实数据 ──────────────────
// channel-health.js 是一个通用评分框架，初始所有渠道都是「骨架」（0 数据）。
// tumblr 是当前**唯一真实运行**的通道，这里把磁盘上的真实口径灌进评分器，
// 使「渠道健康」页对 tumblr 显示真实数据，对其余渠道明确显示「骨架」。
//
// 数据来源（全部只读文件，无网络、无副作用）：
//   · tumblr_token.json            → 已授权账号总数
//   · _tumblr_token_deadlist.json  → 失效 token 黑名单（TTL 内的）
//   · publish.json                 → 真实发布成功数（判据 publish_url 非空）
// 60 秒缓存：避免每次请求都重读数 MB 的 publish.json（顺带满足「刷新不打爆后端」）。
let _chTumblrCache = { at: 0, data: null };
const CH_TUMBLR_CACHE_MS = 60 * 1000;

function collectTumblrChannelMetrics() {
  const now = Date.now();
  if (_chTumblrCache.data && (now - _chTumblrCache.at) < CH_TUMBLR_CACHE_MS) {
    return _chTumblrCache.data;
  }

  const out = {
    totalAccounts: 0, activeAccounts: 0, deadAccounts: 0, shadowBannedAccounts: 0,
    accountAliveRate: 0,
    totalClicks: 0, clicksToday: 0, uniqueClicks: 0,
    totalConversions: 0, conversionRate: 0, conversionValue: 0,
    estimatedCost: 0, estimatedRevenue: 0, roi: 0,
    _sources: [],
  };

  // 1) 账号口径：有 OAuth token 且带 blogName 的记录才是"可发布账号"
  try {
    const tokens = readJsonRecords(dataFile('tumblr_token.json'));
    const usable = tokens.filter((t) => t && t.id
      && (t.oauthToken || t.accessToken || t.oauth_token)
      && (t.blogName || t.blog_name || t.blogname));
    // 失效黑名单（格式容错：数组 / {dead:[]} / {items:[]}）
    const deadSet = new Set();
    try {
      const dl = JSON.parse(fs.readFileSync(dataFile('_tumblr_token_deadlist.json'), 'utf-8'));
      const arr = Array.isArray(dl) ? dl : ((dl && (dl.dead || dl.items || dl.list)) || []);
      for (const x of arr) {
        if (x == null) continue;
        deadSet.add(String(typeof x === 'object' ? (x.id || x.accountId || x.account_id) : x));
      }
    } catch { /* 黑名单不存在属正常（没失效 token） */ }
    const alive = usable.filter((t) => !deadSet.has(String(t.id)));
    out.totalAccounts = usable.length;
    out.activeAccounts = alive.length;
    out.deadAccounts = usable.length - alive.length;
    out.accountAliveRate = usable.length ? alive.length / usable.length : 0;
    out._sources.push(`tumblr_token.json(${usable.length} 可发布 / ${deadSet.size} 在黑名单)`);
  } catch (e) {
    out._tokensError = e.message;
  }

  // 2) 发布口径：publish.json 中真实发出去的 tumblr 帖（判据只看 publish_url）
  try {
    const pubs = readJsonRecords(dataFile('publish.json'));
    const tPubs = pubs.filter((p) => p && String(p.platform || '').toLowerCase() === 'tumblr' && p.publish_url);
    out.totalConversions = tPubs.length;   // 这里的"转化"= 成功产出，非付费转化，见 _note
    const today = new Date().toISOString().slice(0, 10);
    out.conversionsToday = tPubs.filter((p) => String(p.published_at || '').slice(0, 10) === today).length;
    out._sources.push(`publish.json(${tPubs.length} 条成功发布)`);
  } catch (e) {
    out._publishError = e.message;
  }

  // 3) 点击口径：从引流短链读取真实点击（有则填，无则保持 0 并如实说明）
  try {
    const links = readJsonRecords(dataFile('traffic_links.json'));
    const tLinks = links.filter((l) => l && String(l.platform || l.source || '').toLowerCase() === 'tumblr');
    const clicks = tLinks.reduce((s, l) => s + (Number(l.clicks) || Number(l.click_count) || 0), 0);
    out.totalClicks = clicks;
    if (tLinks.length) out._sources.push(`traffic_links.json(${tLinks.length} 条链接 / ${clicks} 次点击)`);
  } catch (e) {
    out._linksError = e.message;
  }

  // 成本/ROI：当前没有真实计费数据源 ⇒ 保持 0（不得估算，否则又是假指标）
  out._note = '转化口径说明：此处的 totalConversions 指该渠道**成功发布/产出的内容数**，'
    + '不是付费转化；成本与 ROI 因缺少真实计费数据源而保持 0，不做估算。';

  _chTumblrCache = { at: now, data: out };
  return out;
}


app.get('/api/v14/channel/health', (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    // 【B0-D3】把 tumblr（当前唯一真实运行的通道）接上磁盘上的真实口径；
    // 其余渠道保持 skeleton 标记，前端据此显示「骨架」而非假的 35 分。
    // 注入失败不得影响端点本身 —— 静默降级为全 skeleton（诚实优于好看）。
    try {
      const live = collectTumblrChannelMetrics();
      v14.channelHealth.applyLiveData('tumblr', {
        totalAccounts: live.totalAccounts,
        activeAccounts: live.activeAccounts,
        deadAccounts: live.deadAccounts,
        accountAliveRate: live.accountAliveRate,
        totalClicks: live.totalClicks,
        totalConversions: live.totalConversions,
        conversionRate: live.totalAccounts > 0 ? live.totalConversions / live.totalAccounts : 0,
      });
    } catch (e) {
      console.warn('[v14] channel/health tumblr 真实数据注入失败（保持 skeleton）: ' + e.message);
    }
    res.json(v14.channelHealth.getAllHealth());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/channel/health/:channelId', (req, res) => {
  try {
    const v14 = initV14();
    const health = v14.channelHealth.getHealth(req.params.channelId);
    if (!health) return res.status(404).json({ error: 'Channel not found' });
    res.json(health);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/channel/ranking', (req, res) => {
  try {
    const v14 = initV14();
    res.json(v14.channelHealth.getRanking(req.query.sortBy || 'roi'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/channel/budget', (req, res) => {
  try {
    const v14 = initV14();
    const budget = parseInt(req.query.total || 100);
    res.json(v14.channelHealth.getBudgetAllocation(budget));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/channel/global', (req, res) => {
  try {
    const v14 = initV14();
    res.json(v14.channelHealth.getGlobalStats());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/v14/channel/config/:channelId', (req, res) => {
  try {
    const v14 = initV14();
    const config = v14.channelHealth.updateChannelConfig(req.params.channelId, req.body);
    if (!config) return res.status(404).json({ error: 'Channel not found' });
    res.json({ success: true, config });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
//  引流转化模块 v2.0 API — 短链增强
// ═══════════════════════════════════════════════════════════

app.put('/api/v14/traffic/links/:code', (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const link = v14.trafficRouter.getLink(req.params.code);
    if (!link) return res.status(404).json({ error: 'Link not found' });
    if (req.body.originalUrl) link.originalUrl = req.body.originalUrl;
    if (req.body.utm) Object.assign(link.utm, req.body.utm);
    if (req.body.routingRules) link.routingRules = req.body.routingRules;
    if (req.body.abTest) link.abTest = req.body.abTest;
    if (req.body.tags) link.tags = req.body.tags;
    if (req.body.notes) link.notes = req.body.notes;
    // 生命周期
    if (req.body.lifecycle) {
      if (req.body.lifecycle.expiresAt) link.expiresAt = req.body.lifecycle.expiresAt;
      if (req.body.lifecycle.clickLimit) link.clickLimit = req.body.lifecycle.clickLimit;
      if (req.body.lifecycle.dailyLimit) link.dailyLimit = req.body.lifecycle.dailyLimit;
      if (req.body.lifecycle.autoDeactivate !== undefined) link.autoDeactivate = req.body.lifecycle.autoDeactivate;
    }
    res.json({ success: true, link: { shortCode: link.shortCode, originalUrl: link.originalUrl, active: link.active } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/traffic/links/:code/rotate', (req, res) => {
  try {
    const v14 = initV14();
    const link = v14.trafficRouter.getLink(req.params.code);
    if (!link) return res.status(404).json({ error: 'Link not found' });
    link.originalUrl = req.body.newUrl;
    res.json({ success: true, shortCode: link.shortCode, newUrl: link.originalUrl });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/v14/traffic/links/:code', (req, res) => {
  try {
    const v14 = initV14();
    const link = v14.trafficRouter.getLink(req.params.code);
    if (!link) return res.status(404).json({ error: 'Link not found' });
    link.active = false;
    v14.trafficRouter.eventBus?.emit('link:deactivated', link);
    res.json({ success: true, deleted: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/traffic/links/:code/analytics', (req, res) => {
  try {
    const v14 = initV14();
    const link = v14.trafficRouter.getLink(req.params.code);
    if (!link) return res.status(404).json({ error: 'Link not found' });

    const clicks = link.clickHistory || [];
    const devices = {}, countries = {}, hours = {};
    for (const c of clicks) {
      devices[c.device] = (devices[c.device] || 0) + 1;
      countries[c.country] = (countries[c.country] || 0) + 1;
      const h = new Date(c.timestamp).getHours();
      hours[h] = (hours[h] || 0) + 1;
    }

    res.json({
      shortCode: link.shortCode,
      totalClicks: link.clicks,
      uniqueClicks: link.uniqueClicks,
      conversionRate: link.conversionRate || 0,
      byDevice: devices,
      byCountry: countries,
      byHour: hours,
      active: link.active
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
//  引流转化模块 v2.0 API — 综合配置
// ═══════════════════════════════════════════════════════════

app.get('/api/v14/traffic/config', (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    res.json({
      version: '2.0',
      funnel: v14.conversionEngine.getFunnel(),
      channels: v14.channelHealth.getRanking(),
      attribution: { defaultModel: v14.attributionEngine.config.defaultModel, window: v14.attributionEngine.config.attributionWindow },
      cloaking: v14.cloakTemplates.getStats(),
      experiments: v14.experimentEngine.getStats(),
      alerts: v14.alertEngine.getStats(),
      globalSettings: {
        trackingDomain: `localhost:${PORT}`,
        defaultAttributionWindow: 30,
        dataRetentionDays: 90
      },
      timestamp: new Date().toISOString()
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ 流量数据验证 API — 手动触发真实访问记录 ═══
app.post('/api/v14/traffic/record-visit', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    
    const { shortCode, source, platform, referrer } = req.body;
    if (!shortCode) return res.status(400).json({ error: 'shortCode required' });
    
    // 通过 HTTP 请求模拟真实访问短链
    const http = require('http');
    const shortUrl = `http://localhost:${PORT}/r/${shortCode}`;
    
    const visitResult = await new Promise((resolve) => {
      const req = http.get(shortUrl, (resp) => {
        let body = '';
        resp.on('data', chunk => body += chunk);
        resp.on('end', () => resolve({
          statusCode: resp.statusCode,
          headers: resp.headers,
          redirectLocation: resp.headers.location || null,
          body: body.slice(0, 200),
        }));
      });
      req.on('error', (e) => resolve({ error: e.message }));
      req.setTimeout(5000, () => { req.destroy(); resolve({ error: 'timeout' }); });
    });

    // 记录真实访问数据
    const visitData = {
      visit_id: `direct_visit_${Date.now()}`,
      account_id: req.body.account_id || 'manual_verify',
      platform: platform || source || 'direct',
      post_id: req.body.post_id || null,
      content_id: req.body.content_id || null,
      ip: req.ip || req.connection?.remoteAddress || '127.0.0.1',
      ua: req.headers['user-agent'] || 'Mozilla/5.0 (Verification)',
      referrer: referrer || source || 'direct',
      landing_page: shortUrl,
      duration: 5000,
      is_unique: true,
      source: source || platform || 'direct',
      device_id: 'manual_verify',
      country: 'CN',
    };

    // 通过因果链事件总线发送（正确路径）
    const eventBus = v14.eventBus;
    if (eventBus) {
      eventBus.emit('visit.recorded', visitData, 'direct-verify');
    }

    // 同时直接写入 DataStore 确保可查询（仅真实外部 IP）
    const realIP = visitData.ip;
    if (realIP && realIP !== '127.0.0.1' && realIP !== '::1' && !realIP.startsWith('192.168')) {
      v14.dataStore.create('analytics', {
        id: visitData.visit_id,
        ip: visitData.ip,
        ua: visitData.ua,
        referrer: visitData.referrer,
        landing_page: visitData.landing_page,
        duration: visitData.duration,
        is_unique: visitData.is_unique,
        source: visitData.source,
        content_id: visitData.content_id,
        post_id: visitData.post_id,
        platform: visitData.platform,
        device_id: visitData.device_id,
        country: visitData.country,
        createdAt: new Date().toISOString(),
      });
    }
    
    // 记录点击日志（仅真实外部 IP）
    if (realIP && realIP !== '127.0.0.1' && realIP !== '::1' && !realIP.startsWith('192.168')) {
      v14.dataStore.create('traffic_click_logs', {
        link_id: `link_${shortCode}`,
        short_code: shortCode,
        timestamp: new Date().toISOString(),
        ip: visitData.ip,
        userAgent: visitData.ua,
        referrer: visitData.referrer,
        platform: visitData.platform,
        country: visitData.country,
        contentId: visitData.content_id,
        postId: visitData.post_id,
      });
    }

    res.json({
      success: true,
      visit: visitData,
      httpResult: visitResult,
      analyticsCount: v14.dataStore.list('analytics').length || 
        (Array.isArray(v14.dataStore.list('analytics')) ? v14.dataStore.list('analytics').length : 0),
      clickLogsCount: v14.dataStore.list('traffic_click_logs').length ||
        (Array.isArray(v14.dataStore.list('traffic_click_logs')) ? v14.dataStore.list('traffic_click_logs').length : 0),
      message: 'Visit recorded via direct HTTP request. Check analytics and traffic_click_logs collections.',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── v14 系统配置状态 ──────────────────────────────
app.get('/api/v14/system/status', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });

    const trafficStats = v14.trafficRouter.getStats();
    const dauStatus = v14.dauController.getStatus();
    const deviceStats = v14.deviceManager.getStats();

    res.json({
      trafficConfigured: (trafficStats.totalLinks || 0) > 0,
      dauTargetSet: (dauStatus.dailyTarget || 0) > 0,
      devicesOnline: deviceStats.online || 0,
      systemReady: (trafficStats.totalLinks || 0) > 0 && (dauStatus.dailyTarget || 0) > 0 && (deviceStats.online || 0) > 0,
      timestamp: new Date().toISOString(),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── v14 全栈综合仪表盘 ──────────────────────────
app.get('/api/v14/dashboard', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });

    const accountTotal = await getManagedAccountCount(pool);
    const accountValid = await getManagedAccountCount(pool, 'is_valid = 1');
    const accountActive = await getManagedAccountCount(pool, "status NOT IN ('S5_DECLINING','S6_FROZEN','S7_ARCHIVED')");

    res.json({
      devices: v14.deviceManager.getStats(),
      nurturing: v14.nurturing.getStats(),
      decision: v14.decisionEngine.getStats(),
      // [B4 瘦身] 原 decisionEngine 键与 decision 值完全相同（同一次 getStats 序列化两遍），
      // 全仓零消费方（前端只读 d.decision）⇒ 移除，单次响应省 ~100KB。
      evolution: v14.evolutionSystem.generateReport('daily'),
      gps: { activeTrajectories: v14.gpsEngine.getActiveStatus().length },
      session: v14.sessionMgr.getStats(),
      scrm: v14.scrmEngine.getStats(),
      proxy: v14.proxyMgr.getStats(),
      sensor: v14.sensorSim.getDashboard(),
      dag: { workflows: v14.dagOrch.listWorkflows().length },
      fingerprint: { devices: v14.fingerprintV2.fingerprintVersions.size },
      mistouch: v14.mistouchSim.getStats(),
      fatigue: v14.fatigueMgr.getStats(),
      socialBridge: v14.socialBridge.getStats(),
      dauController: v14.dauController.getStatus(),
      proactiveMarketing: v14.proactiveMarketing.getStats(),
      contentGenerator: v14.contentGenerator.getStats(),
      websiteAnalytics: v14.websiteAnalytics.getStats(),
      trafficRouter: v14.trafficRouter.getStats(),
      conversion: v14.conversionEngine.getStats(),
      // [B4 瘦身] 原此处重复了一遍 proactiveMarketing（上方 dauController 之后已给），移除。
      cloudPublisher: v14.cloudPublisher ? v14.cloudPublisher.stats : {},
      chainGate: v14.chainGate ? v14.chainGate.getStatus() : {},
      eventBus: v14.eventBus ? v14.eventBus.getStats() : {},
      healEngine: v14.healEngine ? v14.healEngine.getStats() : {},
      dataStore: v14.dataStore ? { modules: v14.dataStore.getModules().length, totalRecords: v14.dataStore.getModules().reduce((s,m) => s + v14.dataStore.count(m), 0) } : {},
      accountFactory: { totalCreated: accountTotal, totalValid: accountValid, totalActive: accountActive },
      timestamp: new Date().toISOString(),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 模块详情API ─ 每个模块的子数据记录可点击查看 ──
app.get('/api/v14/module/:name/detail', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });
    const { name } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    const page = parseInt(req.query.page) || 1;

    // 模块名 → 前端页面名 + DataStore模块名映射
    const moduleMap = {
      register:     { page:'register',     ds:'accounts',          label:'账号注册' },
      devices:      { page:'devices',      ds:'device_logs',       label:'设备管理', dynamic: 'devices' },
      nurture:      { page:'nurture',      ds:'nurture_logs',      label:'智能养号' },
      aigc:         { page:'aigc',         ds:'content',           label:'AI内容生成' },
      publish:      { page:'publish',      ds:'publish',           label:'发布分发' },
      traffic:      { page:'traffic',      ds:'traffic_click_logs', label:'引流管理' },
      analytics:    { page:'analytics',    ds:'analytics',         label:'数据分析' },
      marketing:    { page:'marketing',    ds:'campaign_logs',     label:'主动营销' },
      scrm:         { page:'scrm',         ds:'scrm_logs',         label:'SCRM截流' },
      social:       { page:'publish',      ds:'social_logs',       label:'社交操作' },
      heal:         { page:'dashboard',    ds:'heal_logs',         label:'错误自愈' },
      proxy:        { page:'proxy',        ds:'proxy_logs',        label:'代理管理' },
      intel:        { page:'intel',        ds:'content_intel',     label:'内容情报' },
      dau:          { page:'dau',          ds:'dau_log',           label:'DAU控制' },
      decision:     { page:'decision',     ds:'decision_actions',  label:'决策引擎' },
      evolution:    { page:'evolution',    ds:'evolution_logs',    label:'自进化' },
      fingerprint:  { page:'fingerprint',  ds:'fingerprints',      label:'指纹引擎' },
      gps:          { page:'gps',          ds:'gps_paths',         label:'GPS轨迹' },
      sensor:       { page:'sensor',       ds:'sensors',           label:'传感器' },
      dag:          { page:'dag',          ds:'dag_workflows',     label:'DAG编排' },
      tracking:     { page:'tracking',     ds:'tracking_data',     label:'数据追踪' },
      session:      { page:'session',      ds:'sessions',          label:'Session' },
    };

    const info = moduleMap[name];
    if (!info) return res.status(404).json({ error: `Unknown module: ${name}`, validModules: Object.keys(moduleMap) });

    // 获取模块自身统计
    let moduleStats = {};
    try {
      const statsMap = {
        devices:       () => v14.deviceManager.getStats(),
        nurture:       () => v14.nurturing.getStats(),
        aigc:          () => v14.contentGenerator.getStats(),
        traffic:       () => v14.trafficRouter.getStats(),
        marketing:     () => v14.proactiveMarketing.getStats(),
        scrm:          () => v14.scrmEngine.getStats(),
        dau:           () => v14.dauController.getStatus(),
        social:        () => v14.socialBridge.getStats(),
        heal:          () => v14.healEngine ? v14.healEngine.getStats() : {},
        proxy:         () => v14.proxyMgr.getStats(),
        decision:      () => v14.decisionEngine.getStats(),
        analytics:     () => v14.websiteAnalytics.getStats(),
        evolution:    () => v14.evolutionSystem.generateReport('daily'),
      };
      if (statsMap[name]) moduleStats = statsMap[name]();
    } catch (e) { moduleStats = { error: e.message }; }

    // 获取 DataStore 记录
    let records = [];
    let total = 0;
    try {
      const dsResult = v14.dataStore.list(info.ds, { limit, page, sort:'_ts', order:'desc' });
      records = dsResult.items || [];
      total = dsResult.total || 0;
    } catch (e) { /* no data yet */ }

    // 对未持久化到 DataStore 的模块，从运行时状态动态生成记录
    if (total === 0 && info.dynamic) {
      try {
        if (info.dynamic === 'devices' && v14.deviceManager && v14.deviceManager.listDevices) {
          const all = v14.deviceManager.listDevices();
          total = all.length;
          const start = (page - 1) * limit;
          records = all.slice(start, start + limit).map(d => ({
            id: d.id || d.deviceId,
            device_id: d.id || d.deviceId,
            name: d.name,
            status: d.status,
            mode: d.mode || v14.deviceManager.mode,
            platform: d.metadata?.platform || '-',
            boot_time: d.stats?.bootTime || 0,
            _ts: d.lastSeen || new Date().toISOString(),
            createdAt: d.createdAt || new Date().toISOString(),
            updatedAt: d.lastSeen || new Date().toISOString(),
          }));
        }
      } catch (e) { /* ignore dynamic fallback errors */ }
    }

    res.json({
      module: name,
      label: info.label,
      page: info.page,
      dataStoreModule: info.ds,
      stats: moduleStats,
      records,
      recordTotal: total,
      page, limit,
      timestamp: new Date().toISOString(),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 获取所有模块的摘要列表（供前端仪表盘使用）
app.get('/api/v14/modules/summary', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14) return res.status(500).json({ error: 'v14 not initialized' });

    const summaries = [
      { id:'register', label:'账号注册', icon:'🔐', page:'register', dsTotal: v14.dataStore.count('accounts') },
      { id:'devices', label:'设备管理', icon:'📱', page:'devices', dsTotal: v14.deviceManager.getStats().total, stats: v14.deviceManager.getStats() },
      { id:'nurture', label:'智能养号', icon:'🌱', page:'nurture', dsTotal: v14.dataStore.count('nurture_logs'), stats: v14.nurturing.getStats() },
      { id:'aigc', label:'AI内容生成', icon:'🤖', page:'aigc', dsTotal: v14.dataStore.count('content') + v14.dataStore.count('content_pipeline_logs'), stats: v14.contentGenerator.getStats() },
      { id:'publish', label:'发布分发', icon:'📤', page:'publish', dsTotal: v14.dataStore.count('publish'), stats: { published: v14.dataStore.count('publish') } },
      { id:'traffic', label:'引流管理', icon:'🔗', page:'traffic', dsTotal: v14.dataStore.count('traffic_click_logs'), stats: v14.trafficRouter.getStats() },
      { id:'marketing', label:'主动营销', icon:'📢', page:'marketing', dsTotal: v14.dataStore.count('campaign_logs'), stats: v14.proactiveMarketing.getStats() },
      { id:'scrm', label:'SCRM截流', icon:'🎣', page:'scrm', dsTotal: v14.dataStore.count('scrm_logs'), stats: v14.scrmEngine.getStats() },
      { id:'social', label:'社交操作', icon:'💬', page:'publish', dsTotal: v14.dataStore.count('social_logs'), stats: v14.socialBridge.getStats() },
      { id:'analytics', label:'数据分析', icon:'📊', page:'analytics', dsTotal: v14.dataStore.count('analytics'), stats: v14.websiteAnalytics.getStats() },
      { id:'dau', label:'DAU控制', icon:'🎯', page:'dau', dsTotal: v14.dataStore.count('dau_log'), stats: v14.dauController.getStatus() },
      { id:'heal', label:'错误自愈', icon:'🛡', page:'dashboard', dsTotal: v14.dataStore.count('heal_logs'), stats: v14.healEngine ? v14.healEngine.getStats() : {} },
      { id:'proxy', label:'代理管理', icon:'🔌', page:'proxy', dsTotal: v14.dataStore.count('proxy_logs'), stats: v14.proxyMgr.getStats() },
      { id:'decision', label:'决策引擎', icon:'🧠', page:'decision', dsTotal: v14.dataStore.count('decision_actions'), stats: v14.decisionEngine.getStats() },
      { id:'evolution', label:'自进化', icon:'🧬', page:'evolution', dsTotal: v14.dataStore.count('evolution_logs'), stats: v14.evolutionSystem.generateReport('daily') },
    ];

    res.json({ modules: summaries, timestamp: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── v14 Schema 初始化 ────────────────────────────
async function initV14Schema() {
  try {
    const schemaPath = path.join(__dirname, 'schema-v14.sql');
    if (fs.existsSync(schemaPath)) {
      const schema = fs.readFileSync(schemaPath, 'utf-8');
      const statements = schema.split(';').filter(s => s.trim() && !s.trim().startsWith('--'));
      for (const stmt of statements) {
        try { await pool.execute(stmt.trim()); } catch (e) {
          if (!e.message.includes('already exists') && !e.message.includes('Duplicate')) {
            console.log('[v14-schema] Note:', e.message.slice(0, 100));
          }
        }
      }
      console.log('[v14] Schema initialized');
    }
  } catch (e) {
    console.log('[v14] Schema init skipped:', e.message.slice(0, 80));
  }
}

// ── 启动 ─────────────────────────────────────────────────

(async () => {
  // 等待 MySQL 就绪（最多 6 秒，避免桌面应用健康检查超时）
  const dbReady = await waitForDb(3, 2000);
  if (dbReady) {
    try { await initManagedAccountsTable(); } catch(e) { console.log('[db] initManagedAccountsTable skipped:', e.message.slice(0, 80)); }
    try { await initV14Schema(); } catch(e) { console.log('[db] initV14Schema skipped:', e.message.slice(0, 80)); }
    try { await initCausalChainTables(); } catch(e) { console.log('[db] initCausalChainTables skipped:', e.message.slice(0, 80)); }
  } else {
    console.log('[db] MySQL not available — running in JSON-only mode (DataStore)');
  }
  try {
    initV14();
    console.log('[v14] initV14() completed successfully');
  } catch (e) {
    console.error('[v14] initV14() FAILED:', e.message);
    console.error('[v14] Stack:', e.stack);
  }
  const taskManager = new class TaskManager {
    constructor() {
      this.tasks = new Map();       // taskId → task
      this.taskCounter = 0;         // 自动编号
      this.taskHistory = [];        // 历史任务（已完成的）
      this.maxConcurrency = 5;      // 最大并行数
      this.runningCount = 0;
      this._loadState();
    }

    _nextId() {
      this.taskCounter++;
      const num = String(this.taskCounter).padStart(4, '0');
      return `TASK-${num}`;
    }

    _loadState() {
      try {
        const p = dataFile('task_manager_state.json');
        if (fs.existsSync(p)) {
          const s = JSON.parse(fs.readFileSync(p, 'utf8'));
          this.taskCounter = s.taskCounter || 0;
          this.taskHistory = s.taskHistory || [];
        }
      } catch(e) { /* ignore */ }
    }

    _saveState() {
      try {
        const p = dataFile('task_manager_state.json');
        fs.writeFileSync(p, JSON.stringify({
          taskCounter: this.taskCounter,
          taskHistory: this.taskHistory.slice(-500),
        }));
      } catch(e) { /* ignore */ }
    }

    createTask(type, config = {}, options = {}) {
      const id = this._nextId();
      const task = {
        id,
        type,
        config,
        status: 'queued',
        createdAt: new Date().toISOString(),
        startedAt: null,
        completedAt: null,
        progress: 0,
        result: null,
        error: null,
        concurrency: options.concurrency || 1,
        priority: options.priority || 0,
        log: [],
      };
      this.tasks.set(id, task);
      this._log(id, `Task created: ${type}`);
      this._tryRun();
      return task;
    }

    async _tryRun() {
      const queued = Array.from(this.tasks.values())
        .filter(t => t.status === 'queued')
        .sort((a, b) => b.priority - a.priority);

      for (const task of queued) {
        if (this.runningCount >= this.maxConcurrency) break;
        await this._runTask(task);
      }
    }

    async _runTask(task) {
      task.status = 'running';
      task.startedAt = new Date().toISOString();
      this.runningCount++;
      this._log(task.id, `Started (concurrency=${task.concurrency}, running=${this.runningCount})`);

      try {
        let result;
        switch (task.type) {
          case 'aigc_batch':
            result = await this._execAIGCBatch(task);
            break;
          case 'nurturing':
            result = await this._execNurturing(task);
            break;
          case 'publish':
            result = await this._execPublish(task);
            break;
          case 'traffic_simulate':
            result = await this._execTrafficSim(task);
            break;
          case 'custom':
            result = await this._execCustom(task);
            break;
          default:
            result = { message: 'Task type not implemented: ' + task.type };
        }
        task.status = 'completed';
        task.result = result;
        task.progress = 100;
        this._log(task.id, `Completed: ${JSON.stringify(result)}`);
      } catch (e) {
        task.status = 'failed';
        task.error = e.message;
        this._log(task.id, `Failed: ${e.message}`);
      } finally {
        task.completedAt = new Date().toISOString();
        this.runningCount--;
        this.taskHistory.push({
          id: task.id,
          type: task.type,
          status: task.status,
          createdAt: task.createdAt,
          completedAt: task.completedAt,
        });
        if (this.taskHistory.length > 500) this.taskHistory = this.taskHistory.slice(-500);
        this._saveState();
        // 继续处理队列
        this._tryRun();
      }
    }

    async _execAIGCBatch(task) {
      const { platform, topic, count = 5 } = task.config;
      const results = [];
      const v14 = initV14();
      for (let i = 0; i < count; i++) {
        task.progress = Math.floor((i / count) * 100);
        try {
          if (v14.contentGenerator && v14.contentGenerator.generate) {
            const r = await v14.contentGenerator.generate(platform, { topic: topic + (i>0?` (变体${i+1})` : ''), style: 'casual' });
            results.push({ index: i, status: 'success', contentId: r.result?.id || r.result?.content?.id });
          } else {
            results.push({ index: i, status: 'simulated', contentId: `sim_${Date.now()}_${i}` });
          }
        } catch(e) {
          results.push({ index: i, status: 'failed', error: e.message });
        }
      }
      task.progress = 100;
      return { total: count, success: results.filter(r=>r.status==='success'||r.status==='simulated').length, failed: results.filter(r=>r.status==='failed').length, results };
    }

    async _execNurturing(task) {
      const { accountIds, mode = 'warm' } = task.config;
      const v14 = initV14();
      const results = [];
      for (let i = 0; i < accountIds.length; i++) {
        task.progress = Math.floor((i / accountIds.length) * 100);
        try {
          if (v14.accountNurturing && v14.accountNurturing.startWarming) {
            await v14.accountNurturing.startWarming(accountIds[i]);
          }
          results.push({ accountId: accountIds[i], status: 'warmed' });
        } catch(e) {
          results.push({ accountId: accountIds[i], status: 'failed', error: e.message });
        }
      }
      task.progress = 100;
      return { total: accountIds.length, success: results.filter(r=>r.status==='warmed').length, results };
    }

    async _execPublish(task) {
      const { contentIds, platform } = task.config;
      const results = [];
      for (let i = 0; i < contentIds.length; i++) {
        task.progress = Math.floor((i / contentIds.length) * 100);
        try {
          const v14 = initV14();
          if (v14.publisher && v14.publisher.enqueueContent) {
            v14.publisher.enqueueContent({ content_id: contentIds[i], platform });
          }
          results.push({ contentId: contentIds[i], status: 'queued' });
        } catch(e) {
          results.push({ contentId: contentIds[i], status: 'failed', error: e.message });
        }
      }
      task.progress = 100;
      return { total: contentIds.length, success: results.filter(r=>r.status==='queued').length, results };
    }

    async _execTrafficSim(task) {
      // 流量模拟已禁用 — 所有流量必须来自真实云手机访问（因果链 visit.recorded 执行器）
      this._log(task.id, '流量模拟已禁用 — 所有流量必须来自真实云手机访问');
      task.progress = 100;
      return { simulated: 0, error: 'Traffic simulation disabled — use real cloud-phone visits only via causal chain' };
    }

    async _execCustom(task) {
      const { action, params } = task.config;
      this._log(task.id, `Custom action: ${action} with params: ${JSON.stringify(params)}`);
      // 简单延迟模拟
      const delay = params?.delay || 3000;
      await new Promise(r => setTimeout(r, Math.min(delay, 10000)));
      return { action, executed: true, params };
    }

    _log(taskId, msg) {
      const task = this.tasks.get(taskId);
      if (task) {
        task.log.push({ ts: new Date().toISOString(), msg });
        if (task.log.length > 200) task.log = task.log.slice(-200);
      }
    }

    cancelTask(taskId) {
      const task = this.tasks.get(taskId);
      if (!task) return { error: 'Task not found' };
      if (task.status === 'running' || task.status === 'queued') {
        task.status = 'cancelled';
        task.completedAt = new Date().toISOString();
        if (task.status === 'running') this.runningCount = Math.max(0, this.runningCount - 1);
        this._log(taskId, 'Cancelled by user');
        this._tryRun();
        return { success: true, taskId };
      }
      return { error: `Cannot cancel task in status: ${task.status}` };
    }

    getTask(taskId) {
      const task = this.tasks.get(taskId);
      if (task) return task;
      return this.taskHistory.find(t => t.id === taskId);
    }

    listTasks(status) {
      const all = Array.from(this.tasks.values());
      if (status) return all.filter(t => t.status === status);
      return all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }

    getStats() {
      const all = Array.from(this.tasks.values());
      return {
        total: all.length + this.taskHistory.length,
        queued: all.filter(t => t.status === 'queued').length,
        running: all.filter(t => t.status === 'running').length,
        completed: all.filter(t => t.status === 'completed').length + this.taskHistory.filter(t => t.status === 'completed').length,
        failed: all.filter(t => t.status === 'failed').length + this.taskHistory.filter(t => t.status === 'failed').length,
        cancelled: all.filter(t => t.status === 'cancelled').length,
        maxConcurrency: this.maxConcurrency,
        runningCount: this.runningCount,
        nextTaskId: `TASK-${String(this.taskCounter + 1).padStart(4, '0')}`,
      };
    }
  };

  // ── Task Manager API ──────────────────────────
  app.post('/api/v14/tasks', (req, res) => {
    try {
      const { type, config, options } = req.body || {};
      if (!type) return res.status(400).json({ error: 'Task type is required' });
      const task = taskManager.createTask(type, config || {}, options || {});
      res.json(task);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/v14/tasks', (req, res) => {
    try {
      const tasks = taskManager.listTasks(req.query.status || null);
      res.json({ tasks, stats: taskManager.getStats() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/v14/tasks/:taskId', (req, res) => {
    try {
      const task = taskManager.getTask(req.params.taskId);
      if (!task) return res.status(404).json({ error: 'Task not found: ' + req.params.taskId });
      res.json(task);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/v14/tasks/:taskId/cancel', (req, res) => {
    try {
      const result = taskManager.cancelTask(req.params.taskId);
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/v14/tasks/batch', (req, res) => {
    try {
      const { tasks: taskDefs } = req.body || {};
      if (!Array.isArray(taskDefs) || !taskDefs.length) {
        return res.status(400).json({ error: 'tasks array is required' });
      }
      const created = taskDefs.map(def => taskManager.createTask(def.type, def.config || {}, def.options || {}));
      res.json({ created: created.length, tasks: created });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/v14/tasks/config/max-concurrency', (req, res) => {
    try {
      const { maxConcurrency } = req.body || {};
      if (maxConcurrency && maxConcurrency >= 1 && maxConcurrency <= 20) {
        taskManager.maxConcurrency = maxConcurrency;
        res.json({ maxConcurrency: taskManager.maxConcurrency });
      } else {
        res.status(400).json({ error: 'maxConcurrency must be between 1 and 20' });
      }
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 自动导入 D 盘已有账号
  const accountsDir = path.join('D:', 'LeiDian', 'accounts');
  if (fs.existsSync(accountsDir)) {
    try {
      const files = fs.readdirSync(accountsDir).filter(f => f.endsWith('.json'));
      let imported = 0;
      for (const file of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(accountsDir, file), 'utf-8'));
          if (data.botId && data.username && data.email && data.password) {
            await pool.execute(
              `INSERT IGNORE INTO matrix_accounts_managed
               (bot_id, platform, username, password, email, phone, user_data_dir)
               VALUES (?,?,?,?,?,?,?)`,
              [data.botId, data.platform || 'Unknown', data.username, data.password, data.email, data.phone || null, data.userDataDir || null]
            );
            imported++;
          }
        } catch {}
      }
      if (imported > 0) console.log(`[db] auto-imported ${imported} existing accounts`);
    } catch {}
  }

  // ── 全局异常捕获：防止静默崩溃 ──
  process.on('uncaughtException', (err) => {
    console.error('[FATAL] UncaughtException:', err.message);
    console.error('[FATAL] Stack:', err.stack);
    // 不退出进程，让 Electron 的自动重启机制处理
  });
  process.on('unhandledRejection', (reason, promise) => {
    console.error('[FATAL] UnhandledRejection:', reason);
    if (reason && reason.stack) console.error('[FATAL] Stack:', reason.stack);
  });

  // ── Tumblr 真实养号面板：反向代理到独立养号服务（默认 3005），使面板可在主系统/MSCMS 内访问，并支持经隧道访问 ──
  (function setupNurtureProxy() {
    const http = require('http');
    const NURTURE_PORT = parseInt(process.env.TUMBLR_NURTURE_PORT || '3005', 10);
    const NURTURE_HOST = '127.0.0.1';
    // 把 /tumblr-nurture/api/* 转发到养号服务 localhost:NURTURE_PORT/api/*。
    // 用原生 http 模块（不经 HTTP_PROXY 环境变量），避免主服务内 HTTP_PROXY=127.0.0.1:10808 把 localhost 请求误路由。
    app.all(/^\/tumblr-nurture\/api(\/.*)?$/, (req, res) => {
      const targetPath = (req.path || '').replace(/^\/tumblr-nurture/, '') || '/';
      // 敏感内部操作禁止经公网隧道转发（仅允许主机本机直连 3005，或服务端内部 localhost 调用）
      if (/^\/(api\/reload|api\/stop|api\/apps|api\/internal)(\/|$)/.test(targetPath)) {
        return res.status(403).json({ error: '该操作不允许经公网隧道访问，请在本机 localhost 控制台操作' });
      }
      const opts = {
        host: NURTURE_HOST, port: NURTURE_PORT, path: targetPath, method: req.method,
        headers: Object.assign({}, req.headers, { host: NURTURE_HOST + ':' + NURTURE_PORT }),
        timeout: 30000,
      };
      const up = http.request(opts, (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      });
      up.on('error', (e) => { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'nurture proxy error: ' + e.message })); });
      up.on('timeout', () => { try { up.destroy(); } catch (_) {} if (!res.headersSent) res.writeHead(504, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'nurture proxy timeout' })); });
      req.pipe(up);
    });
    // 面板 HTML：读项目内真实看板文件，重写 API 基址到代理前缀（避免硬编码 3003/3005，且支持隧道访问）
    app.get('/tumblr-nurture/console', (req, res) => {
      try {
        let html = fs.readFileSync(path.join(__dirname, 'tumblr-nurture-dashboard.html'), 'utf8');
        html = html.replace("const API = '';", "const API = '/tumblr-nurture';");
        res.type('html').send(html);
      } catch (e) { res.status(500).send('nurture console error: ' + e.message); }
    });
    app.get('/tumblr-nurture/logs', (req, res) => {
      try {
        let html = fs.readFileSync(path.join(__dirname, 'tumblr-nurture-logs.html'), 'utf8');
        html = html.split("fetch('/api'").join("fetch('/tumblr-nurture/api'").split('fetch("/api"').join('fetch("/tumblr-nurture/api"');
        res.type('html').send(html);
      } catch (e) { res.status(500).send('nurture logs error: ' + e.message); }
    });

    // ── 账号管理模块 (account-manager) 路由 ──────────────────────────────────
    const am = () => v14Modules.accountManager;
    const amReady = (res) => {
      if (!am()) return res.status(500).json({ error: 'account-manager not initialized' });
      return true;
    };

    // 账号列表（密码脱敏 + 闭环字段富化）+ 筛选
    app.get('/api/accounts', async (req, res) => {
      try {
        if (!amReady(res)) return;
        const { activeStatus, deviceId, search, limit, offset } = req.query;
        let rows = am().listAccounts({ activeStatus, deviceId, search });
        const total = rows.length;
        if (limit) rows = rows.slice(Number(offset || 0), Number(offset || 0) + Number(limit));
        res.json({ total, returned: rows.length, accounts: rows });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 账号详情（含绑定设备信息）
    app.get('/api/accounts/:id', async (req, res) => {
      try {
        if (!amReady(res)) return;
        const acc = am().getAccount(req.params.id);
        if (!acc) return res.status(404).json({ error: 'account not found' });
        res.json(acc);
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // cloud_phones 设备注册表
    app.get('/api/cloud-phones', async (req, res) => {
      try {
        if (!amReady(res)) return;
        const devices = am().listCloudPhones();
        res.json({ total: devices.length, devices });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 主动从运行时 DeviceManager 同步注册表（拉真实指纹/代理）
    app.post('/api/cloud-phones/sync', async (req, res) => {
      try {
        if (!amReady(res)) return;
        const devices = am().syncCloudPhones();
        res.json({ total: devices.length, devices });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 单台设备详情（含 owner 账号 + 因果阶段分布）
    app.get('/api/cloud-phones/:id', async (req, res) => {
      try {
        if (!amReady(res)) return;
        const dev = am().getCloudPhone(req.params.id);
        if (!dev) return res.status(404).json({ error: 'device not found' });
        res.json(dev);
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 一机一号：为账号分配（或重绑）云手机
    app.post('/api/accounts/:id/assign-device', async (req, res) => {
      try {
        if (!amReady(res)) return;
        const { deviceId } = req.body || {};
        const r = am().assignDeviceForAccount(req.params.id, { deviceId: deviceId != null ? Number(deviceId) : undefined });
        res.json(r);
      } catch (e) {
        const code = /not found|no available/.test(e.message) ? 400 : 500;
        res.status(code).json({ error: e.message });
      }
    });

    // 解绑账号与云手机
    app.post('/api/accounts/:id/release-device', async (req, res) => {
      try {
        if (!amReady(res)) return;
        res.json(am().releaseDevice(req.params.id));
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 发布端口：设置任务级设备覆盖（null 清除，回退到账号级默认 bound_device_id）
    app.post('/api/accounts/:id/set-publish-device', async (req, res) => {
      try {
        if (!amReady(res)) return;
        const { deviceId } = req.body || {};
        const r = am().setPublishDevice(req.params.id, deviceId != null ? Number(deviceId) : null);
        res.json(r);
      } catch (e) { res.status(400).json({ error: e.message }); }
    });

    // 查询账号当前发布端口
    app.get('/api/accounts/:id/publish-device', async (req, res) => {
      try {
        if (!amReady(res)) return;
        res.json({ accountId: req.params.id, publishDevice: am().publishDeviceFor(req.params.id) });
      } catch (e) { res.status(404).json({ error: e.message }); }
    });

    // 一键登录魔链：向绑定云手机 App 下发登录指令（仅主机本机控制台可签发）
    app.post('/api/accounts/:id/login', requireLocalControl, async (req, res) => {
      try {
        if (!amReady(res)) return;
        const { ttlMin } = req.body || {};
        const r = am().issueLogin(req.params.id, { ttlMin: ttlMin || 15 });
        res.json(r);
      } catch (e) {
        const code = /not found|no bound device/.test(e.message) ? 400 : 500;
        res.status(code).json({ error: e.message });
      }
    });

    // 一键登录魔链验证（闭环另一端）：校验 HMAC 令牌 + 一机一号绑定关系
    // 魔链 /account/login?account=..&t=.. 在绑定云手机 App 内打开后调用本端点确认。
    app.get('/api/v14/account/login-verify', async (req, res) => {
      try {
        const token = req.query.t || (req.body && req.body.t) || '';
        const accountId = req.query.account || (req.body && req.body.account) || '';
        if (!token || !accountId) return res.status(400).json({ valid: false, error: 'token 与 account 均必填' });
        // 令牌解码出的 accountId 必须与参数一致，防止篡改/跨账号冒用
        const resolved = am().verifyLogin(token);
        if (!resolved) return res.status(401).json({ valid: false, error: '令牌无效或已过期' });
        if (String(resolved) !== String(accountId)) return res.status(401).json({ valid: false, error: '令牌与账号不匹配' });
        const acct = am().getAccount(accountId);
        if (!acct) return res.status(404).json({ valid: true, error: '账号不存在' });
        res.json({
          valid: true,
          accountId,
          boundDeviceId: acct.bound_device_id != null ? Number(acct.bound_device_id) : null,
          username: acct.username || '',
          onePhoneOneAccount: acct.bound_device_id != null,
          note: '令牌有效；请在绑定的云手机 App 内完成登录（一机一号，禁止跨设备使用）。',
        });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 5 级闭环漏斗统计
    app.get('/api/account/stats', async (req, res) => {
      try {
        if (!amReady(res)) return;
        res.json(am().computeLoopStats());
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 单账号因果闭环时间线（阶段推进轨迹 + 完成圈数）— 看板详情抽屉用
    app.get('/api/account/:id/timeline', async (req, res) => {
      try {
        if (!amReady(res)) return;
        const tl = am().getCausalTimeline(req.params.id);
        if (!tl) return res.status(404).json({ error: 'account not found' });
        res.json(tl);
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 生命周期状态机变更
    app.post('/api/accounts/:id/status', async (req, res) => {
      try {
        if (!amReady(res)) return;
        const { status, reason } = req.body || {};
        if (!status) return res.status(400).json({ error: 'status required' });
        res.json(am().setStatus(req.params.id, status, reason || ''));
      } catch (e) {
        const code = /not found|illegal/.test(e.message) ? 400 : 500;
        res.status(code).json({ error: e.message });
      }
    });

    // ── Phase 4 / #527 决策桥接器路由：因果链智能下沉到末梢 ──
    const decisionBridge = () => v14Modules.decisionBridge;
    const dbReady = (res) => {
      if (!decisionBridge()) return res.status(503).json({ error: 'decision-bridge not initialized' });
      return true;
    };

    // 单账号因果链归属 + 最近决策快照
    app.get('/api/account/:id/causal', async (req, res) => {
      try {
        if (!dbReady(res)) return;
        const r = decisionBridge().getCausal(req.params.id);
        if (!r) return res.status(404).json({ error: 'account not found' });
        res.json(r);
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 单账号全部决策记录（可按 point 过滤）
    app.get('/api/account/:id/decisions', async (req, res) => {
      try {
        if (!dbReady(res)) return;
        const rows = decisionBridge().getDecisionsForAccount(req.params.id, {
          point: req.query.point,
          limit: req.query.limit ? Number(req.query.limit) : undefined,
        });
        res.json({ accountId: req.params.id, total: rows.length, decisions: rows });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 决策全局汇总（byPoint / byAction / Q 表 Top / 内容 A/B）
    app.get('/api/decisions/summary', async (req, res) => {
      try {
        if (!dbReady(res)) return;
        res.json(decisionBridge().getSummary());
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 模拟某账号 4 决策点快照（不持久化）
    app.post('/api/decision/simulate', async (req, res) => {
      try {
        if (!dbReady(res)) return;
        const { accountId } = req.body || {};
        if (!accountId) return res.status(400).json({ error: 'accountId required' });
        res.json(decisionBridge().simulate(accountId));
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ── Phase 5 / #529 消息/指令统一收件箱路由 ──
    const messageInbox = () => v14Modules.messageInbox;
    const miReady = (res) => {
      if (!messageInbox()) return res.status(503).json({ error: 'message-inbox not initialized' });
      return true;
    };

    // 全局汇总（必须注册在 /:id 之前，避免被 :id 路由吞掉）
    app.get('/api/message-inbox/summary', async (req, res) => {
      try {
        if (!miReady(res)) return;
        res.json(messageInbox().getSummary());
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 收件箱列表（可按 type / unreadOnly 过滤）
    app.get('/api/message-inbox/:id', async (req, res) => {
      try {
        if (!miReady(res)) return;
        const r = messageInbox().listInbox(req.params.id, {
          type: req.query.type,
          unreadOnly: req.query.unreadOnly === '1' || req.query.unreadOnly === 'true',
          limit: req.query.limit ? Number(req.query.limit) : 100,
          offset: req.query.offset ? Number(req.query.offset) : 0,
        });
        res.json(r);
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 未读计数
    app.get('/api/message-inbox/:id/unread', async (req, res) => {
      try {
        if (!miReady(res)) return;
        res.json({ accountId: req.params.id, unread: messageInbox().getUnreadCount(req.params.id) });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 标记已读（body: { ids: [...] }）
    app.post('/api/message-inbox/:id/mark-read', async (req, res) => {
      try {
        if (!miReady(res)) return;
        const { ids } = req.body || {};
        if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids[] required' });
        res.json(messageInbox().markRead(req.params.id, ids));
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 全部标记已读
    app.post('/api/message-inbox/:id/mark-all-read', async (req, res) => {
      try {
        if (!miReady(res)) return;
        res.json(messageInbox().markAllRead(req.params.id));
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // 真实同步：拉取 Tumblr 官方通知+帖子并 upsert 进收件箱（仅主机本机）
    app.post('/api/message-inbox/:id/sync', requireLocalControl, async (req, res) => {
      try {
        if (!miReady(res)) return;
        const { account, token, blogName, v14 } = getTumblrInteractionContext(req.params.id, true);
        const limit = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 20));
        const [nr, pr] = await Promise.allSettled([
          v14.tumblrPublisher.getBlogNotifications(blogName, { limit }, account.id),
          v14.tumblrPublisher.getBlogPosts(blogName, { limit, notesInfo: true }, account.id),
        ]);
        const notifications = nr.status === 'fulfilled' ? nr.value.notifications : [];
        const posts = pr.status === 'fulfilled' ? pr.value.posts : [];
        const sync = await v14.messageInbox.syncFromTumblr(account.id, { notifications, posts });
        res.set('Cache-Control', 'no-store').json({
          ok: true,
          ...sync,
          notificationError: nr.status === 'rejected' ? nr.reason.message : null,
          postError: pr.status === 'rejected' ? pr.reason.message : null,
        });
      } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
    });

    // 指令下发（零伪造：仅建人工待审草稿，真实发送须回网页手动确认）
    app.post('/api/message-inbox/:id/command', requireLocalControl, (req, res) => {
      try {
        if (!miReady(res)) return;
        const { account, v14 } = getTumblrInteractionContext(req.params.id, false);
        const r = v14.messageInbox.sendCommand(account.id, req.body || {});
        if (!r.ok) return res.status(400).json({ error: r.error, requiresManualWebSend: true });
        res.set('Cache-Control', 'no-store').json(r);
      } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
    });
  })();

  app.listen(PORT, function () {
    const server = this;
    console.log(`[server] affiliate gateway listening on :${PORT}`);
    console.log(`[server] MySQL pool → ${process.env.MYSQL_HOST || '127.0.0.1'}:${process.env.MYSQL_PORT || '3307'}/${process.env.MYSQL_DB || 'affiliate_system'}`);
    // 预初始化 v14 模块
    initV14();
    // ── Phase 6 / #534 挂载实时 WS 推送中心（事件总线 → /ws/v14） ──
    if (v14Modules && v14Modules.realtimeHub) {
      try { v14Modules.realtimeHub.attach(server); }
      catch (e) { console.error('[realtime] attach 失败:', e.message); }
    }
  });
})();

// ══════════════════════════════════════════════════════════════
//  v14 4级数据查看 API (L1-L4) + 基础设施 API
// ══════════════════════════════════════════════════════════════

// 校验 DataStore 模块名（只允许小写字母/数字/下划线，且不以数字开头）
// 防止畸形请求（如 /api/v14/data/=1）自动 _ensureModule 创建垃圾空模块污染存储
function _validModuleName(name) {
  return typeof name === 'string' && /^[a-z][a-z0-9_]*$/.test(name);
}

// ── L1: 系统总览 ────────────────────────────────────
app.get('/api/v14/data/overview', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14 || !v14.dataStore) return res.status(500).json({ error: 'v14 not initialized' });

    const modules = v14.dataStore.getModules();
    const moduleStats = {};
    let totalRecords = 0;
    for (const mod of modules) {
      const stats = v14.dataStore.getModuleStats(mod);
      moduleStats[mod] = stats;
      totalRecords += stats.totalRecords;
    }

    // 因果链阶段进度
    const chainStatus = v14.chainGate ? v14.chainGate.getStatus() : {};

    // EventBus 统计
    const ebStats = v14.eventBus ? v14.eventBus.getStats() : {};

    // 核心模块实时统计
    const coreStats = {
      devices: v14.deviceManager ? v14.deviceManager.getStats() : {},
      nurturing: v14.nurturing ? v14.nurturing.getStats() : {},
      contentGenerator: v14.contentGenerator ? v14.contentGenerator.getStats() : {},
      websiteAnalytics: v14.websiteAnalytics ? v14.websiteAnalytics.getStats() : {},
      trafficRouter: v14.trafficRouter ? v14.trafficRouter.getStats() : {},
      dauController: v14.dauController ? v14.dauController.getStatus() : {},
      cloudPublisher: v14.cloudPublisher ? (v14.cloudPublisher.stats || {}) : {},
      healEngine: v14.healEngine ? v14.healEngine.getStats() : {},
    };

    res.json({
      level: 'L1',
      description: '系统总览 — 所有模块数据汇总',
      summary: {
        totalModules: modules.length,
        totalRecords,
        modules: modules,
      },
      moduleStats,
      coreStats,
      causalChain: chainStatus,
      eventBus: ebStats,
      timestamp: new Date().toISOString(),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── M6: 统一 KPI 聚合端点（真实数据 · 零伪造） ──────────
// 复用 data/overview 的同一批访问器，聚合成单一契约供前端 KPI 卡 + WS 推送共用
async function computeKpiSnapshot() {
  try {
    const v14 = initV14();
    if (!v14 || !v14.dataStore) return { ok: false, reason: 'v14 not initialized' };
    const g = (fn, d) => { try { const r = fn(); return (r == null ? d : r); } catch (_) { return d; } };
    const cs = {
      devices: g(() => v14.deviceManager && v14.deviceManager.getStats(), {}),
      nurturing: g(() => v14.nurturing && v14.nurturing.getStats(), {}),
      contentGenerator: g(() => v14.contentGenerator && v14.contentGenerator.getStats(), {}),
      websiteAnalytics: g(() => v14.websiteAnalytics && v14.websiteAnalytics.getStats(), {}),
      healEngine: g(() => v14.healEngine && v14.healEngine.getStats(), {}),
    };
    const chain = v14.chainGate ? v14.chainGate.getStatus() : {};
    const modules = v14.dataStore.getModules();
    let totalRecords = 0;
    try { for (const m of modules) { totalRecords += (v14.dataStore.getModuleStats(m) || {}).totalRecords || 0; } } catch (_) {}
    let managed = { total: 0, byPlatform: {}, ok: false };
    if (pool) {
      try {
        const [rows] = await pool.query('SELECT platform, status, COUNT(*) AS c FROM matrix_accounts_managed GROUP BY platform, status');
        const byPlatform = {}; let total = 0;
        for (const r of rows) { const p = r.platform || 'unknown'; byPlatform[p] = (byPlatform[p] || 0) + r.c; total += r.c; }
        managed = { total, byPlatform, ok: true };
      } catch (e) { managed.error = e.message; }
    }
    let publishTotal = 0; try { publishTotal = (v14.dataStore.getModuleStats('publish') || {}).totalRecords || 0; } catch (_) {}
    const cg = cs.contentGenerator || {};
    const totalGen = cg.totalGenerated || 0, succ = cg.successCount || 0, fail = cg.failCount || 0;
    const successRate = totalGen ? +(succ / totalGen * 100).toFixed(1) : null;
    const phases = (chain.phases || []).map(function (p) {
      return { name: p.name, label: p.label, current: p.current, target: p.target, status: p.status, progress: p.progress };
    });
    const comp = phases.length ? Math.round(phases.reduce(function (a, p) { return a + (p.progress || 0); }, 0) / phases.length) : null;
    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      accounts: {
        managed: managed.total, managedByPlatform: managed.byPlatform,
        nurturing: cs.nurturing.total || 0, nurturingByPlatform: cs.nurturing.byPlatform || {},
        avgHealthScore: cs.nurturing.avgHealthScore != null ? +(+cs.nurturing.avgHealthScore).toFixed(1) : null,
        riskyAccounts: cs.nurturing.riskyAccounts || 0,
      },
      devices: { total: cs.devices.total, online: cs.devices.online, offline: cs.devices.offline, mode: cs.devices.mode },
      content: {
        totalGenerated: totalGen, successCount: succ, failCount: fail,
        successRate: successRate, avgQualityScore: cg.avgQualityScore != null ? +cg.avgQualityScore : null,
      },
      causalChain: {
        enabled: chain.enabled, autoAdvance: chain.autoAdvance,
        totalCycles: (chain.stats || {}).totalCycles, totalAdvancements: (chain.stats || {}).totalAdvancements,
        totalBlocks: (chain.stats || {}).totalBlocks, completionPct: comp, phases: phases,
      },
      publish: { total: publishTotal, note: '发布记录数（DataStore publish 模块）' },
      warehouse: { totalModules: modules.length, totalRecords: totalRecords },
      engagement: { ready: false, note: 'reach/likes 字段为空，待 P1 素材归因回填后启用' },
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

app.get('/api/v14/kpi/overview', async (req, res) => {
  try { res.json(await computeKpiSnapshot()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  B2: 刷新机制 — 60s 指标缓存 + SSE 实时通道（方案 §5.1 双通道）
// ──────────────────────────────────────────────────────────────
//  数据源：computeKpiSnapshot —— 本层【不产生任何数据】，只做缓存与分发。
//  双通道：
//    · 轮询页（v14-console/dash）：前端 10 分钟自动刷 → /api/v14/metrics/snapshot
//      服务端 60s 缓存 + 并发合并，N 个浏览器并发只触发 1 次全量聚合。
//    · 实时页 /v14-live.html：SSE /api/v14/metrics/stream（秒级，仅变化时推帧）
//  零伪造：上游失败且无历史值 → 503 + error；有历史值 → 降级 stale 并显式标注 error。
// ══════════════════════════════════════════════════════════════
const { MetricsCache: _MetricsCache, MetricsStream: _MetricsStream } = require('./v14-metrics-cache.js');

const _metricsCache = new _MetricsCache({ ttlMs: Number(process.env.MSCMS_METRICS_TTL_MS || 60000) });
const _metricsStream = new _MetricsStream({ cache: _metricsCache, eventName: 'metrics' });
_metricsStream.setProvider(() => computeKpiSnapshot());

// 变化时同步推给既有 WebSocket Hub（/ws/v14），保证 WS 与 SSE 双通道内容一致
_metricsStream.onPush = (snap) => {
  try { if (global.__rt && typeof global.__rt.pushKpi === 'function') global.__rt.pushKpi(snap); }
  catch (_) { /* 附加通道失败不影响 SSE 主通道 */ }
};

/** GET /api/v14/metrics/snapshot?refresh=1 — 轮询页取数（命中 60s 缓存） */
app.get('/api/v14/metrics/snapshot', async (req, res) => {
  try {
    const force = String(req.query.refresh || '') === '1';
    const r = await _metricsCache.get(() => computeKpiSnapshot(), { force });
    if (!r.ok) return res.status(503).json({ ok: false, error: r.error, _cache: _metricsCache.getStats() });
    res.set('Cache-Control', 'no-store').json({
      ok: true,
      data: r.data,
      _cache: Object.assign({ cached: !!r.cached, stale: !!r.stale, coalesced: !!r.coalesced, ageMs: r.ageMs }, _metricsCache.getStats()),
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

/** GET /api/v14/metrics/stream — SSE 实时通道（EventSource 断线自动重连） */
app.get('/api/v14/metrics/stream', async (req, res) => {
  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // 防反向代理（CF tunnel / nginx）缓冲导致「假实时」
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  // SSE 属长连接：必须关闭 socket 空闲超时，否则会被静默断开
  try { req.socket.setTimeout(0); req.socket.setNoDelay(true); req.socket.setKeepAlive(true); } catch (_) {}

  _metricsStream.writeFrame(res, {
    retry: 3000,
    event: 'hello',
    data: {
      ok: true, server: 'mscms-v14', eventName: _metricsStream.eventName,
      intervalMs: _metricsStream.intervalMs, ttlMs: _metricsCache.ttlMs, ts: Date.now(),
    },
  });

  const unsub = _metricsStream.subscribe((ev, payload) => {
    if (ev === 'error') _metricsStream.writeFrame(res, { event: 'error', data: payload });
    else _metricsStream.writeFrame(res, { event: ev, data: payload });
  });

  // 连接即下发当前快照：命中缓存则零延迟，未命中则触发一次计算
  try {
    const r = await _metricsCache.get(() => computeKpiSnapshot(), {});
    if (r.ok) {
      _metricsStream.writeFrame(res, {
        event: _metricsStream.eventName,
        data: Object.assign({}, r.data, {
          _cache: { cached: !!r.cached, stale: !!r.stale, ageMs: r.ageMs, initial: true },
        }),
      });
    } else {
      _metricsStream.writeFrame(res, { event: 'error', data: { ok: false, error: r.error } });
    }
  } catch (_) { /* 首帧失败不阻断连接，后续 tick 会补 */ }

  // 25s 心跳（SSE 注释帧）：保持中间设备不判定空闲
  const hb = setInterval(() => {
    try { if (!res.writableEnded && !res.destroyed) res.write(': hb ' + Date.now() + '\n\n'); }
    catch (_) { /* 已断开 */ }
  }, 25000);
  if (hb.unref) hb.unref();

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(hb);
    try { unsub(); } catch (_) { /* 幂等 */ }
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
});

/** GET /api/v14/metrics/stream/stats — 缓存命中率与订阅数（运维自检） */
app.get('/api/v14/metrics/stream/stats', (req, res) => {
  res.set('Cache-Control', 'no-store').json({ ok: true, stream: _metricsStream.getStats() });
});

// 后台定时：每 5s 取一次快照（受 60s TTL 约束，实际每 60s 才全量重算一次），
// 仅在业务数值变化时推送 —— 无变化不产生任何网络帧，避免实时页被无用帧刷屏。
_metricsStream.start({ intervalMs: Number(process.env.MSCMS_METRICS_PUSH_MS || 5000) });

// 兼容保留：原 M6 的 20s WS KPI 广播改为复用同一份缓存（不再重复全量计算）
if (!global.__kpiPushTimer) {
  global.__kpiPushTimer = setInterval(async () => {
    try {
      const r = await _metricsCache.get(() => computeKpiSnapshot(), {});
      if (r.ok && global.__rt && global.__rt.pushKpi) global.__rt.pushKpi(r.data);
    } catch (_) { /* 静默 */ }
  }, 20000);
  if (global.__kpiPushTimer.unref) global.__kpiPushTimer.unref();
}

// ══════════════════════════════════════════════════════════════
// B4 · 大盘 L0「服务健康总览」
//   背景：实测 `/api/v14/services/health` 等 6 个候选端点全部 404 ——
//         大盘「服务 11 项」没有数据源，此前只能靠人工 netstat 判断。
//   数据源：services-registry.js（11 项权威清单）+ service-probe.js（真实 TCP/HTTP 探活）。
//   零伪造：只认真实连接结果；探不通即 down，不做「配置存在=在线」的推断。
//   复用 B2 的 MetricsCache ⇒ N 个浏览器并发只触发 1 轮探活。
// ══════════════════════════════════════════════════════════════
const _svcProber = require('./service-probe.js').getProber();
const _svcCache = new _MetricsCache({ ttlMs: Number(process.env.MSCMS_SERVICES_TTL_MS || 60000) });

/** GET /api/v14/services/health?refresh=1 — 11 项服务真实探活（60s 缓存） */
app.get('/api/v14/services/health', async (req, res) => {
  try {
    const force = req.query.refresh === '1';
    const r = await _svcCache.get(() => _svcProber.probeAll(), { force });
    if (!r.ok) {
      return res.status(503).json({ ok: false, error: r.error, _cache: _svcCache.getStats() });
    }
    const d = r.data || {};
    res.set('Cache-Control', 'no-store').json({
      ok: true,
      services: d.results || [],
      summary: d.summary || null,
      source: d.source || 'services-registry.js',
      probedAt: d.probedAt || null,
      elapsedMs: d.elapsedMs == null ? null : d.elapsedMs,
      _cache: Object.assign(
        { cached: !!r.cached, stale: !!r.stale, coalesced: !!r.coalesced, ageMs: r.ageMs },
        _svcCache.getStats()
      ),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
// B5 · 时间维度统一聚合：GET /api/v14/metrics/timeseries
// ──────────────────────────────────────────────────────────────
// 依据升级方案 §3.4「可视化与时间维度（全站统一）」：
//   粒度自动映射 日→小时 · 周→日 · 月→日 · 年→月
//   服务端分桶聚合（绝不把 4 万条记录推给前端）
//
// 纯逻辑内核在 v14-timeseries.js（可脱网单测）；本层只负责
//   ① 从 DataStore 取真实记录  ② keyed 缓存（复用 B2 的 MetricsCache）  ③ HTTP 契约
//
// 零伪造 —— 内核只做「按真实时间字段分桶计数」，不生成任何合成点，不做外推/
//   平滑/随机抖动。空桶 = 该时段确实 0 条（真实事实，可画）；resolved === 0
//   才置 meta.datasetEmpty=true，由前端渲染「暂无数据」占位。缺时间字段的记录
//   计入 meta.dropped 并如实暴露 coverage，绝不猜测时间。
// ══════════════════════════════════════════════════════════════
const _B5TS = require('./v14-timeseries.js');
const _B5_TS_TTL_MS = Number(process.env.MSCMS_TS_TTL_MS) > 0 ? Number(process.env.MSCMS_TS_TTL_MS) : 60000;
const _B5_TS_CACHE_MAX = 160;

// key → MetricsCache 小 LRU：复用 B2 的 TTL / 并发合并 / stale 降级语义，
// 避免 N 个浏览器同时切时间维度时对 DataStore 做 N 次全量扫描。
const _b5TsCaches = new Map();
function _b5TsCacheFor(key) {
  let c = _b5TsCaches.get(key);
  if (c) { _b5TsCaches.delete(key); _b5TsCaches.set(key, c); return c; } // 命中移到队尾
  c = new _MetricsCache({ ttlMs: _B5_TS_TTL_MS });
  _b5TsCaches.set(key, c);
  while (_b5TsCaches.size > _B5_TS_CACHE_MAX) _b5TsCaches.delete(_b5TsCaches.keys().next().value);
  return c;
}
function _b5TsCacheStats() {
  let hits = 0, misses = 0, coalesced = 0, stale = 0, entries = 0;
  for (const c of _b5TsCaches.values()) {
    const s = c.getStats();
    hits += s.hits; misses += s.misses; coalesced += s.coalesced; stale += s.staleServed; entries++;
  }
  const t = hits + misses;
  return { entries, ttlMs: _B5_TS_TTL_MS, hits, misses, coalesced, staleServed: stale, hitRate: t > 0 ? +((hits / t) * 100).toFixed(1) : null };
}

/** GET /api/v14/metrics/timeseries — 时间维度聚合（服务端分桶，零伪造） */
app.get('/api/v14/metrics/timeseries', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14 || !v14.dataStore) return res.status(500).json({ ok: false, error: 'v14 not initialized' });

    const known = v14.dataStore.getModules();
    const knownSet = new Set(known);
    const moduleList = String(req.query.module || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 8);
    if (!moduleList.length) return res.status(400).json({ ok: false, error: '缺少 module 参数' });
    // 模块名必须已存在：_ensureModule 会为未知名字凭空建缓存，白名单校验防缓存膨胀
    const unknown = moduleList.filter(m => !knownSet.has(m));
    if (unknown.length) return res.status(400).json({ ok: false, error: `未知模块：${unknown.join(', ')}`, knownModules: known });

    const now = Date.now();
    const range = String(req.query.range || 'week');
    const rr = _B5TS.resolveRange({ range, from: req.query.from, to: req.query.to, now });
    if (rr.error) return res.status(400).json({ ok: false, error: rr.error });

    let gran = String(req.query.granularity || '').toLowerCase() || rr.gran;
    if (!_B5TS.GRANULARITIES.includes(gran)) return res.status(400).json({ ok: false, error: `granularity 仅支持 ${_B5TS.GRANULARITIES.join('|')}` });
    // 粒度不得细于窗口所需（如 today 却要 month 粒度只会产出 700+ 个空桶）
    if (_B5TS.GRANULARITIES.indexOf(gran) < _B5TS.GRANULARITIES.indexOf(rr.gran)) gran = rr.gran;

    // metric：count（默认）| sum:<字段> | avg:<字段>
    const metricQ = String(req.query.metric || 'count');
    let metricMode = null, metricField = null;
    if (metricQ !== 'count') {
      const mm = metricQ.match(/^(sum|avg):(.+)$/);
      if (!mm) return res.status(400).json({ ok: false, error: 'metric 仅支持 count | sum:<字段> | avg:<字段>' });
      metricMode = mm[1]; metricField = mm[2].trim();
    }

    // filter=k:v,k2:v2（与 DataStore.list 的精确字符串匹配语义一致）
    const filter = {};
    if (req.query.filter) {
      for (const seg of String(req.query.filter).split(',')) {
        const i = seg.indexOf(':');
        if (i > 0) filter[seg.slice(0, i).trim()] = seg.slice(i + 1).trim();
      }
    }
    const hasFilter = Object.keys(filter).length > 0;
    const force = String(req.query.refresh || '') === '1';
    const fieldQ = req.query.field ? String(req.query.field) : null;

    const key = JSON.stringify([moduleList, fieldQ, metricQ, range, req.query.from || null, req.query.to || null, gran, hasFilter ? filter : 0]);
    const cache = _b5TsCacheFor(key);

    const r = await cache.get(async () => {
      const out = {};
      for (const m of moduleList) {
        const listed = v14.dataStore.list(m, hasFilter ? { limit: 1e9, page: 1, filter } : { limit: 1e9, page: 1 });
        const records = (listed && listed.items) || [];
        const rf = _B5TS.resolveField(records, m, fieldQ);
        const agg = _B5TS.aggregate(records, {
          field: rf.field, chain: rf.chain, fieldAuto: rf.fieldAuto,
          metricMode, metricField, from: rr.from, to: rr.to, gran,
        });
        out[m] = Object.assign({
          module: m, range,
          from: new Date(rr.from).toISOString(),
          to: new Date(rr.to).toISOString(),
          records: records.length,
          fieldCandidates: rf.candidates,
          granularity: agg.meta.granularity,
        }, agg);
      }
      return out;
    }, { force });

    if (!r.ok) return res.status(503).json({ ok: false, error: r.error, _cache: _b5TsCacheStats() });

    const per = r.data || {};
    const payload = {
      ok: true,
      range,
      from: new Date(rr.from).toISOString(),
      to: new Date(rr.to).toISOString(),
      nowIso: new Date(now).toISOString(),
      requestedGranularity: gran,
      metric: metricMode ? `${metricMode}:${metricField}` : 'count',
      filter: hasFilter ? filter : null,
      fieldOverride: fieldQ,
      multi: moduleList.length > 1,
      modules: moduleList,
      _cache: Object.assign(
        { cached: !!r.cached, stale: !!r.stale, coalesced: !!r.coalesced, ageMs: r.ageMs },
        _b5TsCacheStats()
      ),
    };
    if (moduleList.length === 1) Object.assign(payload, per[moduleList[0]]);
    else payload.series = per;

    res.set('Cache-Control', 'no-store').json(payload);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** GET /api/v14/metrics/timeseries/modules — 各模块时间字段可用性体检（供前端选默认口径） */
app.get('/api/v14/metrics/timeseries/modules', (req, res) => {
  try {
    const v14 = initV14();
    if (!v14 || !v14.dataStore) return res.status(500).json({ ok: false, error: 'v14 not initialized' });
    const out = [];
    for (const m of v14.dataStore.getModules()) {
      const listed = v14.dataStore.list(m, { limit: 1e9, page: 1 });
      const records = (listed && listed.items) || [];
      const rf = _B5TS.resolveField(records, m, null);
      const cov = _B5TS.resolveCoverage(records, rf.chain);
      out.push({
        module: m,
        records: records.length,
        recommendedField: rf.field,
        fieldChain: rf.chain,
        recommendedBy: rf.fieldAuto ? 'auto' : 'override',
        parseable: cov.resolved,
        fieldsUsed: cov.fieldsUsed,          // 字段链里各字段实际贡献多少条
        coverage: cov.coverage,
        candidates: rf.candidates,
        // 诚实标注：连一个可用时间字段都没有的模块，前端只能显示「暂无数据」
        usable: cov.resolved > 0,
      });
    }
    out.sort((a, b) => (b.records || 0) - (a.records || 0));
    res.set('Cache-Control', 'no-store').json({
      ok: true,
      timezone: _B5TS.timezoneLabel(),
      rangeGranularityMap: _B5TS.RANGE_GRANULARITY_MAP,
      maxBuckets: _B5TS.getMaxBuckets(),
      count: out.length,
      usableCount: out.filter(x => x.usable).length,
      emptyCount: out.filter(x => !x.usable).length,
      modules: out,
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// ── L2: 模块数据列表 (复用 DataStore CRUD) ──────────
// ── L3: 单条数据详情 (复用 DataStore CRUD) ──────────
// (见下方统一 CRUD 路由)

// ── L4: 全链路溯源 ─────────────────────────────────
app.get('/api/v14/data/trace/:id', async (req, res) => {
  try {
    const v14 = initV14();
    if (!v14 || !v14.dataStore) return res.status(500).json({ error: 'v14 not initialized' });

    const { id } = req.params;
    const traceModules = req.query.modules
      ? req.query.modules.split(',')
      : v14.dataStore.getModules();

    // DataStore 关联查询
    const dsRelated = v14.dataStore.findRelated(id, traceModules);

    // MySQL 因果链表查询（如果 DB 可用）
    const mysqlTraces = {};
    if (pool) {
      try {
        // 按 account_id 查生成的内容
        const [contentRows] = await pool.execute(
          'SELECT * FROM matrix_content_generated WHERE account_id = ? OR id = ? ORDER BY emitted_at DESC LIMIT 200',
          [id, id]
        );
        if (contentRows.length > 0) mysqlTraces.content_generated = contentRows;

        // 按 content_id 或 account_id 查已发布的帖子
        const [postRows] = await pool.execute(
          'SELECT * FROM matrix_posts_published WHERE content_id = ? OR account_id = ? OR id = ? ORDER BY emitted_at DESC LIMIT 200',
          [id, id, id]
        );
        if (postRows.length > 0) mysqlTraces.posts_published = postRows;

        // 按 post_id 查访问记录
        const [visitRows] = await pool.execute(
          'SELECT * FROM matrix_visits_recorded WHERE post_id = ? OR id = ? ORDER BY emitted_at DESC LIMIT 500',
          [id, id]
        );
        if (visitRows.length > 0) mysqlTraces.visits_recorded = visitRows;

        // DAU 统计（按日期范围）
        const [dauRows] = await pool.execute(
          'SELECT * FROM matrix_dau_stats WHERE id = ? ORDER BY emitted_at DESC LIMIT 50',
          [id]
        );
        if (dauRows.length > 0) mysqlTraces.dau_stats = dauRows;

        // 托管账号详情
        const [acctRows] = await pool.execute(
          'SELECT * FROM matrix_accounts_managed WHERE bot_id = ? OR id = ? LIMIT 1',
          [id, id]
        );
        if (acctRows.length > 0) mysqlTraces.account_detail = acctRows[0];
      } catch (dbErr) {
        mysqlTraces._db_error = dbErr.message;
      }
    }

    // 关联图谱：构建链式关系
    const chainGraph = buildTraceGraph(id, dsRelated, mysqlTraces);

    res.json({
      level: 'L4',
      description: '全链路溯源 — 从账号到DAU的完整追踪',
      traceId: id,
      dataStore: dsRelated,
      mysql: mysqlTraces,
      chainGraph,
      timestamp: new Date().toISOString(),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * 构建溯源关联图谱
 */
function buildTraceGraph(rootId, dsRelated, mysqlTraces) {
  const nodes = [];
  const edges = [];

  // 根节点
  nodes.push({ id: rootId, type: 'root', label: '溯源起点' });

  // DataStore 关联
  for (const [mod, items] of Object.entries(dsRelated)) {
    if (!items || items.length === 0) continue;
    nodes.push({ id: `ds:${mod}`, type: 'datastore', label: mod, count: items.length });
    edges.push({ from: rootId, to: `ds:${mod}`, relation: 'stored_in', count: items.length });
  }

  // MySQL 因果链
  if (mysqlTraces.account_detail) {
    const a = mysqlTraces.account_detail;
    nodes.push({ id: `acct:${a.bot_id || a.id}`, type: 'account', label: a.username || a.email || a.bot_id, platform: a.platform });
    edges.push({ from: rootId, to: `acct:${a.bot_id || a.id}`, relation: 'is_account' });
  }
  if (mysqlTraces.content_generated) {
    for (const c of mysqlTraces.content_generated) {
      nodes.push({ id: `content:${c.id}`, type: 'content', label: (c.title || '').substring(0, 40), platform: c.platform });
      edges.push({ from: c.account_id ? `acct:${c.account_id}` : rootId, to: `content:${c.id}`, relation: 'generated' });
    }
  }
  if (mysqlTraces.posts_published) {
    for (const p of mysqlTraces.posts_published) {
      nodes.push({ id: `post:${p.id}`, type: 'post', label: (p.post_url || '').substring(0, 40), status: p.status });
      edges.push({ from: p.content_id ? `content:${p.content_id}` : (p.account_id ? `acct:${p.account_id}` : rootId), to: `post:${p.id}`, relation: 'published' });
    }
  }
  if (mysqlTraces.visits_recorded) {
    for (const v of mysqlTraces.visits_recorded) {
      nodes.push({ id: `visit:${v.id}`, type: 'visit', label: v.visitor_type || 'visit', isUnique: v.is_unique });
      edges.push({ from: v.post_id ? `post:${v.post_id}` : rootId, to: `visit:${v.id}`, relation: 'visited' });
    }
  }

  return { nodes, edges, summary: `${nodes.length} nodes, ${edges.length} edges` };
}

// ── DataStore 统一 CRUD 路由 (L2 + L3) ─────────────
app.get('/api/v14/data/:module', (req, res) => {
  try {
    const v14 = initV14();
    // 2026-09-06：前端导航的 page 值用连字符（如 tumblr-nurture），而 DataStore 的
    //   模块名用下划线（tumblr_nurture）；统一规范化，避免 400 Invalid module name。
    const module = String(req.params.module || '').replace(/-/g, '_');
    if (!_validModuleName(module)) return res.status(400).json({ error: 'Invalid module name' });
    const opts = {
      search: req.query.search,
      filter: req.query.filter ? JSON.parse(req.query.filter) : null,
      sort: req.query.sort,
      order: req.query.order,
      page: parseInt(req.query.page) || 1,
      limit: parseInt(req.query.limit) || parseInt(req.query.pageSize) || 20
    };
    const result = v14.dataStore.list(module, opts);
    // M3 分页投影：?fields=a,b,c 仅返回选中字段；?pageSize 作为 limit 别名。
    // 目标：降低大响应体积（accounts/publish 80KB→<12KB），向后兼容（无 fields 时行为不变）。
    const fields = req.query.fields ? String(req.query.fields).split(',').map(s => s.trim()).filter(Boolean) : null;
    if (fields) {
      const project = function (arr) {
        return (arr || []).map(function (it) {
          const o = {};
          fields.forEach(function (f) { if (it && it[f] !== undefined) o[f] = it[f]; });
          return o;
        });
      };
      if (Array.isArray(result)) result = project(result);
      else if (result && Array.isArray(result.items)) result.items = project(result.items);
    }
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ⚠️  /:module/export 和 /:module/:id/history 必须在 /:module/:id 之前
// 否则 Express 会把 "export" 匹配为 :id 参数
app.get('/api/v14/data/:module/export', (req, res) => {
  try {
    const v14 = initV14();
    // 2026-09-06：前端导航的 page 值用连字符（如 tumblr-nurture），而 DataStore 的
    //   模块名用下划线（tumblr_nurture）；统一规范化，避免 400 Invalid module name。
    const module = String(req.params.module || '').replace(/-/g, '_');
    if (!_validModuleName(module)) return res.status(400).json({ error: 'Invalid module name' });
    const format = req.query.format || 'json';
    const data = v14.dataStore.export(module, format);
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${req.params.module}.csv"`);
      res.send(data);
    } else {
      res.json(JSON.parse(data));
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/data/:module/:id/history', (req, res) => {
  try {
    const v14 = initV14();
    // 2026-09-06：前端导航的 page 值用连字符（如 tumblr-nurture），而 DataStore 的
    //   模块名用下划线（tumblr_nurture）；统一规范化，避免 400 Invalid module name。
    const module = String(req.params.module || '').replace(/-/g, '_');
    if (!_validModuleName(module)) return res.status(400).json({ error: 'Invalid module name' });
    const hist = v14.dataStore.history(module, req.params.id);
    res.json(hist);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── L3: 单条数据详情 ─────────────────────────────
app.get('/api/v14/data/:module/:id', (req, res) => {
  try {
    const v14 = initV14();
    // 2026-09-06：前端导航的 page 值用连字符（如 tumblr-nurture），而 DataStore 的
    //   模块名用下划线（tumblr_nurture）；统一规范化，避免 400 Invalid module name。
    const module = String(req.params.module || '').replace(/-/g, '_');
    if (!_validModuleName(module)) return res.status(400).json({ error: 'Invalid module name' });
    const record = v14.dataStore.get(module, req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    res.json(record);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/data/:module', (req, res) => {
  try {
    const v14 = initV14();
    // 2026-09-06：前端导航的 page 值用连字符（如 tumblr-nurture），而 DataStore 的
    //   模块名用下划线（tumblr_nurture）；统一规范化，避免 400 Invalid module name。
    const module = String(req.params.module || '').replace(/-/g, '_');
    if (!_validModuleName(module)) return res.status(400).json({ error: 'Invalid module name' });
    const record = v14.dataStore.create(module, req.body);
    res.json(record);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/v14/data/:module/:id', (req, res) => {
  try {
    const v14 = initV14();
    // 2026-09-06：前端导航的 page 值用连字符（如 tumblr-nurture），而 DataStore 的
    //   模块名用下划线（tumblr_nurture）；统一规范化，避免 400 Invalid module name。
    const module = String(req.params.module || '').replace(/-/g, '_');
    if (!_validModuleName(module)) return res.status(400).json({ error: 'Invalid module name' });
    const record = v14.dataStore.update(module, req.params.id, req.body);
    if (!record) return res.status(404).json({ error: 'not found' });
    res.json(record);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/v14/data/:module/:id', (req, res) => {
  try {
    const v14 = initV14();
    // 2026-09-06：前端导航的 page 值用连字符（如 tumblr-nurture），而 DataStore 的
    //   模块名用下划线（tumblr_nurture）；统一规范化，避免 400 Invalid module name。
    const module = String(req.params.module || '').replace(/-/g, '_');
    if (!_validModuleName(module)) return res.status(400).json({ error: 'Invalid module name' });
    const ok = v14.dataStore.delete(module, req.params.id);
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════
// 内容编辑 API — 短视频(≤10s) + 图文宣传 + 70% 视频占比
// ════════════════════════════════════════════════════════
const CONTENT_TYPES = ['video', 'image_text', 'text'];
const MAX_VIDEO_DURATION = 10; // 秒
// 输入词汇 → 库内规范词汇（与既有内容池对齐：text_video / text_image / text）
const CANON_TYPE = { video: 'text_video', text_video: 'text_video', image_text: 'text_image', text_image: 'text_image', text: 'text' };

// POST /api/v14/content — 创建/编辑一条内容（短视频或图文）
app.post('/api/v14/content', (req, res) => {
  try {
    const v14 = initV14();
    const b = req.body || {};

    // 校验 content_type（兼容 video/image_text 与 text_video/text_image 两套输入）
    const rawType = (b.content_type || 'text');
    const contentType = (rawType === 'text_video') ? 'video' : (rawType === 'text_image') ? 'image_text' : rawType;
    if (!CONTENT_TYPES.includes(contentType)) {
      return res.status(400).json({ error: `content_type 必须是 ${CONTENT_TYPES.join(' / ')} 之一` });
    }
    const canonType = CANON_TYPE[contentType] || 'text';

    // 公共字段
    const platform = (typeof b.platform === 'string' && b.platform) ? b.platform : (contentType === 'video' ? 'tiktok' : (contentType === 'image_text' ? 'instagram' : 'reddit'));
    let title = (typeof b.title === 'string' && b.title.trim()) ? b.title.trim() : '';
    let body = (typeof b.body === 'string') ? b.body : '';
    if (!title && body) title = body.substring(0, 60).replace(/\n/g, ' ').trim();

    // 类型专属校验
    let videoUrl = null, coverUrl = null, duration = null;
    let images = [];
    if (contentType === 'video') {
      videoUrl = (typeof b.video_url === 'string' && b.video_url.trim()) ? b.video_url.trim() : '';
      coverUrl = (typeof b.cover_url === 'string' && b.cover_url.trim()) ? b.cover_url.trim() : '';
      duration = Number(b.duration);
      // video_url 与 duration 在「先创建草稿、后渲染附加」的流程中可为空：
      //   若已提供 video_url 则按真实上传校验；若为空则视为待渲染草稿，由 /api/v14/content/:id/render 补全。
      if (videoUrl) {
        if (!Number.isFinite(duration) || duration <= 0) {
          return res.status(400).json({ error: '短视频必须提供有效的 duration(秒)' });
        }
        if (duration > MAX_VIDEO_DURATION) {
          return res.status(400).json({ error: `短视频时长不可超过 ${MAX_VIDEO_DURATION} 秒（当前 ${duration}s）` });
        }
      } else {
        // 草稿态：duration 仅作占位，渲染时以入参为准
        duration = Number.isFinite(duration) && duration > 0 ? duration : null;
      }
      // body 作为视频文案/字幕
    } else if (contentType === 'image_text') {
      if (Array.isArray(b.images)) images = b.images.map(x => String(x)).filter(x => x.trim());
      else if (typeof b.images === 'string') images = b.images.split(',').map(x => x.trim()).filter(Boolean);
      if (images.length < 1) return res.status(400).json({ error: '图文宣传至少需要 1 张图片' });
      if (!body.trim()) return res.status(400).json({ error: '图文宣传必须提供正文 body' });
    } else {
      // text
      if (!body.trim() && !title) return res.status(400).json({ error: '文本内容必须提供 body 或 title' });
    }

    const tags = Array.isArray(b.tags) ? b.tags.map(x => String(x)) : (typeof b.tags === 'string' ? b.tags.split(',').map(x => x.trim()).filter(Boolean) : []);
    // 默认编辑态(draft)避免被因果链自动发布；显式 status:'ready' 才进入发布管线
    const status = (b.status === 'ready' || b.status === 'published') ? b.status : 'editing';

    const now = new Date().toISOString();
    const id = (typeof b.id === 'string' && b.id) ? b.id : `content_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    const record = {
      id,
      platform,
      content_type: canonType,
      type: canonType,
      title,
      body,
      video_url: videoUrl,
      cover_url: coverUrl,
      duration: duration ? Number(duration.toFixed(2)) : null,
      images,
      // [KK20-2026-09-22] 显式落 media_path / media_type —— 修的是「图文静默降级为纯文本」。
      // 根因链（实测确证，非推测）：
      //   ① 本路由只写 images[]，并把 preview_url 设成 images[0]；
      //   ② 紧接着 saveContentToFile() 会把 preview_url **覆盖成存档 JSON 路径**
      //      `/content/<date>/image_text/<id>.json`；
      //   ③ 发布器 `cloud-publisher.js:_resolveMediaForPublish()` 的候选列表
      //      [media_path, image_path, video_path, media_url, image_url, preview_url]
      //      逐个经 `isRealMediaRef()` 过滤，该 .json 路径被 `ARCHIVE_JSON_RE` 判为
      //      「内容存档 JSON」而剔除 ⇒ 候选全空 ⇒ 静默降级为纯文本发布。
      //   这正是 P2-B5 的事故形态。补 media_path 从根上切断该降级路径。
      // 兼容性：仅在未显式传入 media_path 时回退到 images[0]/video_url；
      //   存量内容（无 images 字段）取值仍为 null —— 零行为变更。
      media_path: (typeof b.media_path === 'string' && b.media_path.trim())
        ? b.media_path.trim()
        : (videoUrl || images[0] || null),
      media_type: (function () {
        const _m = (typeof b.media_path === 'string' && b.media_path.trim())
          ? b.media_path.trim()
          : (videoUrl || images[0] || '');
        if (!_m) return null;
        return /\.(mp4|mov|webm)$/i.test(String(_m)) ? 'video' : 'image';
      })(),
      quality_score: Number(b.quality_score) || 80,
      preview_url: coverUrl || (images[0] || null),
      status,
      account_id: (typeof b.account_id === 'string' && b.account_id) ? b.account_id : null,
      tags,
      generated_at: b.generated_at || now,
      created_at: now,
      updated_at: now,
    };

    const saved = v14.dataStore.create('content', record);

    // 可选：同时写 D 盘预览文件（复用 contentGenerator 能力）
    if (v14.contentGenerator && v14.contentGenerator.saveContentToFile) {
      try {
        const savedFile = v14.contentGenerator.saveContentToFile({
          id, platform, contentType,
          completedAt: now, qualityScore: record.quality_score,
          result: { title, body, video_url: videoUrl, cover_url: coverUrl, duration, images },
        });
        if (savedFile && savedFile.previewUrl) {
          v14.dataStore.update('content', id, { preview_url: savedFile.previewUrl });
          saved.preview_url = savedFile.previewUrl;
        }
      } catch (e) { /* 非关键 */ }
    }

    console.log(`[content-editor] 保存内容: ${id} (type=${canonType}, status=${status}, duration=${duration ?? '—'})`);
    res.json({ success: true, record: saved });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/v14/content/mix — 视频/图文/文本 占比统计（目标 70% 视频）
app.get('/api/v14/content/mix', (req, res) => {
  try {
    const v14 = initV14();
    const r = v14.dataStore.list('content', { limit: 5000, sort: 'created_at', order: 'desc' });
    const items = (r && r.items) ? r.items : [];

    let video = 0, imageText = 0, text = 0;
    for (const c of items) {
      const t = c.content_type;
      // 兼容两套词汇：video|text_video 视为短视频；image_text|text_image 视为图文
      if (t === 'video' || t === 'text_video') video++;
      else if (t === 'image_text' || t === 'text_image') imageText++;
      else text++; // 含 legacy 'text' / 'post'
    }
    const total = items.length;
    const videoPct = total > 0 ? Number(((video / total) * 100).toFixed(1)) : 0;
    const targetPct = 70;

    res.json({
      total,
      video,
      image_text: imageText,
      text,
      videoPct,
      targetPct,
      reached: videoPct >= targetPct,
      recent: items.slice(0, 12),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── EventBus API ────────────────────────────────────
app.get('/api/v14/eventbus/stats', (req, res) => {
  try {
    const v14 = initV14();
    res.json(v14.eventBus.getStats());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/eventbus/log', (req, res) => {
  try {
    const v14 = initV14();
    const limit = parseInt(req.query.limit) || 100;
    res.json(v14.eventBus.getLog(limit));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/eventbus/events', (req, res) => {
  try {
    const v14 = initV14();
    res.json(v14.eventBus.getRegisteredEvents());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/eventbus/emit', (req, res) => {
  try {
    const v14 = initV14();
    const { event, data, source } = req.body;
    v14.eventBus.emit(event, data, source || 'api');
    res.json({ emitted: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── HealEngine API ──────────────────────────────────
app.get('/api/v14/heal/stats', (req, res) => {
  try {
    const v14 = initV14();
    res.json(v14.healEngine.getStats());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/heal/log', (req, res) => {
  try {
    const v14 = initV14();
    const limit = parseInt(req.query.limit) || 100;
    res.json(v14.healEngine.getLog(limit));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/heal/patterns', (req, res) => {
  try {
    const v14 = initV14();
    res.json(v14.healEngine.getErrorPatterns());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/heal/execute', async (req, res) => {
  try {
    const v14 = initV14();
    const { module, errorType, context } = req.body;
    const result = await v14.healEngine.execute(module, errorType, context || {});
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DataStore API ───────────────────────────────────
app.get('/api/v14/datastore/modules', (req, res) => {
  try {
    const v14 = initV14();
    const modules = v14.dataStore.getModules().map(m => v14.dataStore.getModuleStats(m));
    res.json(modules);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/datastore/flush', (req, res) => {
  try {
    const v14 = initV14();
    v14.dataStore.flush();
    res.json({ flushed: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── P1: AI 助手聊天接口 ─────────────────────────────
app.post('/api/v14/ai/chat', async (req, res) => {
  try {
    const { module: moduleName, message, context } = req.body;
    
    // 获取模块数据作为上下文
    const v14 = initV14();
    const dataModule = moduleName === 'register' ? 'accounts' : moduleName;
    let moduleData = {};
    try {
      const stats = v14.dataStore.getModuleStats(dataModule);
      moduleData = { module: moduleName, totalRecords: stats.totalRecords, historyEntries: stats.historyEntries };
    } catch(e) {}
    
    // 获取EventBus状态
    let eventStats = {};
    try { eventStats = v14.eventBus.getStats(); } catch(e) {}
    
    // 获取HealEngine状态
    let healStats = {};
    try { healStats = v14.healEngine.getStats(); } catch(e) {}
    
    // 构建AI上下文
    const aiContext = {
      module: moduleName,
      message,
      dataSummary: moduleData,
      eventBus: eventStats,
      healEngine: healStats,
      userContext: context || '',
      timestamp: new Date().toISOString()
    };
    
    // 模拟AI回复（实际可接入LLM）
    let reply = '';
    const msg = (message || '').toLowerCase();
    
    if (msg.includes('分析') || msg.includes('建议') || msg.includes('优化')) {
      reply = `[${moduleName}] 模块分析报告:\n\n`;
      reply += `📊 数据概览:\n`;
      reply += `  - 总记录数: ${moduleData.totalRecords || 0}\n`;
      reply += `  - 历史操作: ${moduleData.historyEntries || 0} 次\n`;
      reply += `  - 事件总线活跃: ${eventStats.totalEmitted || 0} 事件已发射\n`;
      reply += `  - 自愈引擎: ${healStats.totalActions || 0} 次自愈执行\n\n`;
      reply += `💡 优化建议:\n`;
      reply += `  1. 当前模块${moduleData.totalRecords > 0 ? '数据正常' : '尚无数据，建议先添加记录'}\n`;
      reply += `  2. ${eventStats.totalEmitted > 10 ? '因果链运行活跃' : '因果链事件较少，建议启动全链路自动化'}\n`;
      reply += `  3. ${healStats.totalActions > 0 ? '自愈系统已介入处理' : '无异常，自愈系统待命'}\n`;
      reply += `\n⚡ 可执行操作: 在「规则」子页设置自动化规则，系统将基于数据自动决策。`;
    } else if (msg.includes('报告') || msg.includes('状态')) {
      reply = `[${moduleName}] 状态报告:\n`;
      reply += `  - 模块: ${moduleName}\n`;
      reply += `  - 数据量: ${moduleData.totalRecords || 0}\n`;
      reply += `  - 因果链事件: ${eventStats.totalEmitted || 0}\n`;
      reply += `  - 自愈执行: ${healStats.totalActions || 0}\n`;
      reply += `  - 时间: ${new Date().toLocaleString()}\n`;
      reply += `\n状态: ${moduleData.totalRecords > 0 ? '✅ 运行中' : '⏳ 待初始化'}`;
    } else if (msg.includes('异常') || msg.includes('检测') || msg.includes('自愈')) {
      reply = `[${moduleName}] 异常检测:\n`;
      reply += `  - 自愈动作总数: ${healStats.totalActions || 0}\n`;
      reply += `  - 自动修复: ${healStats.autoResolved || 0}\n`;
      reply += `  - 半自动: ${healStats.semiAuto || 0}\n`;
      reply += `  - 需人工: ${healStats.manualRequired || 0}\n`;
      reply += `\n${healStats.totalActions > 0 ? '⚠️ 检测到历史异常，建议查看「历史」子页了解详情' : '✅ 当前无异常'}`;
    } else {
      reply = `[${moduleName}] 收到: "${message}"\n\n`;
      reply += `我是模块AI助手，可以帮你:\n`;
      reply += `  • 分析模块数据并给出优化建议\n`;
      reply += `  • 生成操作报告\n`;
      reply += `  • 检测异常并推荐自愈策略\n`;
      reply += `  • 优化配置参数\n\n`;
      reply += `当前模块数据量: ${moduleData.totalRecords || 0} 条记录`;
    }
    
    res.json({
      reply,
      module: moduleName,
      actions: [],
      context: aiContext
    });
  } catch (e) {
    res.json({ reply: 'AI助手处理出错: ' + e.message, actions: [] });
  }
});

// ── P1: 因果链详情API ────────────────────────────────
app.get('/api/v14/causal-chain/status', (req, res) => {
  try {
    const v14 = initV14();
    
    // 支持通过 query 参数直接推进门控（绕过事件总线调试用）
    const pushPhase = req.query.pushPhase || req.query.push;
    const pushCount = parseInt(req.query.pushCount) || 1;
    if (pushPhase && v14.chainGate) {
      for (let i = 0; i < pushCount; i++) {
        v14.chainGate.incrementProgress(pushPhase, 1, { pushed: true, ts: Date.now() });
      }
    }
    
    const stats = v14.eventBus.getStats();
    const log = v14.eventBus.getLog(20);
    res.json({
      stats,
      recentEvents: log,
      causalEvents: v14.eventBus.getRegisteredEvents(),
      chainGate: v14.chainGate ? v14.chainGate.getStatus() : { enabled: false },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 闭环质量端点（读时归一化/派生，零伪造）— #607
// 物理回写（#602 action_type 派生 / #603 平台归一）已于 2026-09-02 完成，源文件已落盘。
app.get('/api/v14/causal-chain/loop-quality', (req, res) => {
  try {
    const { computeLoopQuality } = require('./loop-quality');
    res.json(computeLoopQuality());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── P1: Publisher 平台配额冷却诊断端点 — 让 S4→S5 断链时能一眼看出 cooldown 状态 ──
// GET /api/v14/publisher/quota           → 状态查询
// GET /api/v14/publisher/quota?reset=1   → 强制清空冷却（调试/紧急推进用）
app.get('/api/v14/publisher/quota', (req, res) => {
  try {
    const v14 = initV14();
    const cp = v14 && v14.cloudPublisher;
    if (!cp) return res.status(503).json({ error: 'cloudPublisher not initialized' });
    const now = Date.now();
    const pausedUntil = cp._quotaPausedUntil || 0;
    const active = pausedUntil > now;
    if (req.query.reset === '1' || req.query.reset === 'true') {
      const wasActive = active;
      cp._quotaPausedUntil = 0;
      cp._quotaPauseReason = null;
      console.warn(`[api/v14/publisher/quota] ⚡ 强制清除配额冷却 (wasActive=${wasActive})`);
      return res.json({ ok: true, reset: true, wasActive });
    }
    res.json({
      active,
      pausedUntil,
      pausedUntilISO: active ? new Date(pausedUntil).toISOString() : null,
      remainingMs: active ? pausedUntil - now : 0,
      remainingMin: active ? Math.round((pausedUntil - now) / 60000) : 0,
      reason: cp._quotaPauseReason || null,
      pausedUntil_local: active ? new Date(pausedUntil).toLocaleString('zh-CN', { hour12: false }) : null,
      queueLength: cp.publishQueue ? cp.publishQueue.length : 0,
      // ── 429 分层退避快照（2026-09-12 P0）：账号级退避 + 升级阈值 ──
      backoff: (() => { try { return cp.quotaBackoffSnapshot ? cp.quotaBackoffSnapshot() : null; } catch (_) { return null; } })(),
      // ── 每日配额 / 节奏控制（2026-09-10 新增）──────────────────
      dailyQuota: {
        perAccountMax: (() => { try { return cp.nurturingRules ? cp.nurturingRules.getDailyQuota(30).post : null; } catch (_) { return null; } })(),
        env: 'MSCMS_TUMBLR_POST_MAX_PER_DAY',
        minIntervalMin: Math.round((cp.minIntervalMs || 0) / 60000),
        minIntervalEnv: 'MSCMS_MIN_PUBLISH_INTERVAL_MS',
        globalBudget: (() => { try { return cp._dailyPostBudget ? cp._dailyPostBudget() : 0; } catch (_) { return 0; } })(),
        globalBudgetUsed: (() => { try { return cp._getGlobalDailyPostCount ? cp._getGlobalDailyPostCount() : null; } catch (_) { return null; } })(),
        exitCount: (() => { try { return cp._exitCount ? cp._exitCount() : null; } catch (_) { return null; } })(),
        budgetEnableEnv: 'MSCMS_DAILY_POST_BUDGET_ENFORCE=1 (或 MSCMS_DAILY_POST_BUDGET=<绝对条数>)',
      },
      deferredInQueue: (cp.publishQueue || []).filter((t) => t && t.scheduledAt && new Date(t.scheduledAt).getTime() > now).length,
      now_local: new Date(now).toLocaleString('zh-CN', { hour12: false }),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/causal-chain/loop-quality', (req, res) => {
  try {
    const { computeLoopQuality } = require('./loop-quality');
    res.json(computeLoopQuality());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 直接推进门控（绕过事件总线）— GET 方式便于调试
app.get('/api/v14/causal-chain/push', (req, res) => {
  try {
    const v14 = initV14();
    const phase = req.query.phase;
    const count = parseInt(req.query.count) || 1;
    if (!phase) return res.status(400).json({ error: 'phase required' });
    const gate = v14.chainGate;
    if (!gate) return res.status(500).json({ error: 'gate not initialized' });
    
    for (let i = 0; i < count; i++) {
      gate.incrementProgress(phase, 1, { pushed: true, ts: Date.now() });
    }
    const status = gate.getStatus();
    res.json({ pushed: true, phase, count, status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST 方式（完整支持）
app.post('/api/v14/causal-chain/push', (req, res) => {
  try {
    const v14 = initV14();
    const { phase, count = 1 } = req.body || {};
    if (!phase) return res.status(400).json({ error: 'phase required' });
    const gate = v14.chainGate;
    if (!gate) return res.status(500).json({ error: 'gate not initialized' });

    for (let i = 0; i < count; i++) {
      gate.incrementProgress(phase, 1, { pushed: true, ts: Date.now() });
    }
    const status = gate.getStatus();
    res.json({ pushed: true, phase, count, status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 真实因果事件触发（API 回调，用于真实全链路联调/数据反馈测试）──
// 注意：本端点只透传真实账号上下文到 CausalChainManager 的 trigger* 方法，
// 下游（account-manager 因果归属 / decision-bridge 决策 / chain-gate 进度）均为真实处理，
// 不注入任何伪造数据。仅接受系统已存在的真实 accountId。
app.post('/api/v14/causal-chain/trigger', (req, res) => {
  try {
    const v14 = initV14();
    const mgr = v14.causalChain;
    if (!mgr) return res.status(503).json({ error: 'causalChain not initialized' });
    const { event, accountId, data } = req.body || {};
    if (!event) return res.status(400).json({ error: 'event required' });
    const id = accountId || (data && (data.account_id || data.accountId)) || null;
    const payload = Object.assign({ account_id: id, accountId: id, id }, data || {});
    switch (event) {
      case 'account.healthy':   mgr.triggerAccountHealthy(payload); break;
      case 'content.generated': mgr.triggerContentGenerated(payload); break;
      case 'post.published':    mgr.triggerPostPublished(payload); break;
      case 'visit.recorded':    mgr.triggerVisitRecorded(payload); break;
      case 'dau.updated':       mgr.triggerDAUUpdated(payload); break;
      case 'action.execute':    mgr.triggerActionExecute(payload); break;
      default: return res.status(400).json({ error: 'unknown event: ' + event });
    }
    res.json({ triggered: true, event, accountId: id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ P2: Pipeline 编排 API ═══
app.post('/api/v14/pipeline/start', (req, res) => {
  try {
    const v14 = initV14();
    if (v14.decision) {
      v14.decision.startAutoCycle();
    }
    if (v14.eventBus) {
      v14.eventBus.emit('system', { action: 'pipeline_started', ts: Date.now() });
    }
    res.json({ started: true, message: 'Pipeline orchestration started', decisionActive: v14.decision?.autoCycleActive || false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/pipeline/stop', (req, res) => {
  try {
    const v14 = initV14();
    if (v14.decision && v14.decision.stopAutoCycle) {
      v14.decision.stopAutoCycle();
    }
    if (v14.eventBus) {
      v14.eventBus.emit('system', { action: 'pipeline_stopped', ts: Date.now() });
    }
    res.json({ stopped: true, message: 'Pipeline orchestration stopped' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ P2: 内容策略 API ═══
app.get('/api/v14/strategy', (req, res) => {
  try {
    const v14 = initV14();
    if (!v14.contentStrategyDecider) {
      return res.json({ error: 'ContentStrategyDecider 未初始化', available: false });
    }
    const strategy = v14.contentStrategyDecider.decide();
    const summary = v14.contentStrategyDecider.getSummary();
    res.json({ available: true, summary, strategy: summary });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/strategy/allocation', (req, res) => {
  try {
    const v14 = initV14();
    if (!v14.contentStrategyDecider) {
      return res.json({ error: 'ContentStrategyDecider 未初始化' });
    }
    const alloc = v14.contentStrategyDecider.getPlatformAllocation();
    const platforms = v14.contentStrategyDecider.getRecommendedPlatforms();
    res.json({ allocation: alloc, recommended_platforms: platforms });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/strategy/debug', (req, res) => {
  try {
    const v14 = initV14();
    if (!v14.contentStrategyDecider) {
      return res.json({ error: 'ContentStrategyDecider 未初始化' });
    }
    const debug = v14.contentStrategyDecider.getDebugInfo();
    res.json(debug);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ P2: 通知中心 API ═══
app.get('/api/v14/notifications', (req, res) => {
  try {
    const v14 = initV14();
    const items = [];
    // Get recent EventBus errors
    if (v14.eventBus) {
      const log = v14.eventBus.getLog(50);
      log.forEach(e => {
        if (e.type === 'error' || e.type === 'warn') {
          items.push({
            type: e.type === 'error' ? 'error' : 'warn',
            title: e.eventName || e.type || 'EventBus',
            message: JSON.stringify(e.data || {}).slice(0, 120),
            time: new Date(e.ts).toLocaleTimeString('zh-CN'),
            read: true
          });
        }
      });
    }
    // Get HealEngine alerts
    if (v14.healEngine) {
      const stats = v14.healEngine.getStats();
      if (stats.pending > 0) {
        items.unshift({
          type: 'warn',
          title: 'HealEngine 告警',
          message: `${stats.pending} 个待处理的自愈任务，成功率 ${stats.successRate}`,
          time: new Date().toLocaleTimeString('zh-CN'),
          read: false
        });
      }
    }
    // Get causal chain stalled alerts
    if (v14.eventBus) {
      const stats = v14.eventBus.getStats();
      stats.stalledChains?.forEach(chain => {
        items.unshift({
          type: 'error',
          title: '因果链停滞',
          message: `链路 ${chain.name} 已停滞 ${chain.stalledSeconds}s`,
          time: new Date().toLocaleTimeString('zh-CN'),
          read: false
        });
      });
    }
    res.json({ items: items.slice(0, 30) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ P3: 养号规则 API ═══
app.get('/api/v14/nurturing-rules/:platform', (req, res) => {
  try {
    const v14 = initV14();
    const { NurturingRulesEngine, PlatformNurturingRules } = require('./nurturing-rules.js');
    const platform = req.params.platform;
    const engine = new NurturingRulesEngine({ platform, accountAge: parseInt(req.query.age) || 0 });
    res.json({
      platform,
      rules: PlatformNurturingRules[platform],
      currentPhase: engine.currentPhase,
      dailyQuota: engine.getDailyQuota(),
      report: engine.getReport(),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/nurturing-rules/check', (req, res) => {
  try {
    const v14 = initV14();
    const { NurturingRulesEngine } = require('./nurturing-rules.js');
    const { platform, accountAge, action, count } = req.body;
    const engine = new NurturingRulesEngine({ platform, accountAge: accountAge || 0 });
    const result = engine.canPerform(action, count || 1);
    res.json({ allowed: result.allowed, reason: result.reason, quota: result.quota, remaining: result.remaining });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ P3: 平台内容规则 API ═══
app.get('/api/v14/content-rules/:platform', (req, res) => {
  try {
    const { PlatformContentRules } = require('./platform-content-rules.js');
    const platform = req.params.platform;
    res.json({ platform, rules: PlatformContentRules[platform] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/content-rules/check', (req, res) => {
  try {
    const v14 = initV14();
    const { ContentRuleChecker } = require('./platform-content-rules.js');
    const { platform, content, accountAge, recentContent, dailyPostCount } = req.body;
    const checker = new ContentRuleChecker(platform);
    const result = checker.checkContent(content, { accountAge, recentContent, dailyPostCount });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ P3: 去AI味 API ═══
app.post('/api/v14/deai/process', async (req, res) => {
  try {
    const v14 = initV14();
    const { platform, content, intensity, iterations } = req.body;
    const result = await v14.deaiProcessor.process(content, { platform, intensity: intensity || 'medium', iterations: iterations || 2 });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/deai/detect', (req, res) => {
  try {
    const v14 = initV14();
    const { content } = req.body;
    const result = v14.deaiProcessor.detectAI(content);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ P3: 内容生成管线 API ═══
app.post('/api/v14/content-pipeline/generate', async (req, res) => {
  try {
    const v14 = initV14();
    const { platform, topic, accountAge, subreddit, tone, generateVariants } = req.body;
    const result = await v14.contentPipeline.generateContent(platform, { topic, accountAge, subreddit, tone, generateVariants });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/content-pipeline/batch', async (req, res) => {
  try {
    const v14 = initV14();
    const { platform, count, opts } = req.body;
    const results = await v14.contentPipeline.batchGenerate(platform, count || 3, opts || {});
    res.json({ results, count: results.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/content-pipeline/report', (req, res) => {
  try {
    const v14 = initV14();
    res.json(v14.contentPipeline.getReport());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/content-pipeline/performance', (req, res) => {
  try {
    const v14 = initV14();
    const { contentId, metrics } = req.body;
    v14.contentPipeline.updateContentPerformance(contentId, metrics);
    res.json({ updated: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ P3: 云手机发布 API ═══
app.post('/api/v14/cloud-publish/enqueue', (req, res) => {
  try {
    const v14 = initV14();
    const { content, account, opts } = req.body;
    const task = v14.cloudPublisher.enqueuePublish(content, account, opts || {});
    res.json({ taskId: task.id, status: task.status, queued: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/cloud-publish/status/:taskId', (req, res) => {
  try {
    const v14 = initV14();
    const task = v14.cloudPublisher.publishQueue.find(t => t.id === req.params.taskId) ||
                 v14.cloudPublisher.publishHistory.find(h => h.taskId === req.params.taskId);
    res.json(task || { error: 'Task not found' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/cloud-publish/report', (req, res) => {
  try {
    const v14 = initV14();
    const report = v14.cloudPublisher.getReport();
    report.diagnostics = v14.cloudPublisher.getDiagnostics();
    res.json(report);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/cloud-publish/config/:platform', (req, res) => {
  try {
    const { PlatformPublishConfig } = require('./cloud-publisher.js');
    res.json(PlatformPublishConfig[req.params.platform] || { error: 'Unknown platform' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══ P3: LOK 对话模型 API ═══
app.post('/api/v14/lok-dialogue/reply', async (req, res) => {
  try {
    const v14 = initV14();
    const { accountId, platform, incomingMessage, opts } = req.body;
    const result = await v14.lokDialogue.generateReply(accountId, platform, incomingMessage, opts || {});
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/lok-dialogue/batch-reply', async (req, res) => {
  try {
    const v14 = initV14();
    const { messages, opts } = req.body;
    const results = await v14.lokDialogue.batchGenerateReply(messages, opts || {});
    res.json({ results, count: results.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v14/lok-dialogue/persona', (req, res) => {
  try {
    const v14 = initV14();
    const { accountId, platform, personaKey } = req.body;
    v14.lokDialogue.setPersona(accountId, platform, personaKey);
    res.json({ set: true, persona: personaKey });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/lok-dialogue/history/:accountId/:platform', (req, res) => {
  try {
    const v14 = initV14();
    const history = v14.lokDialogue.getHistory(req.params.accountId, req.params.platform);
    res.json({ history, count: history.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/lok-dialogue/models', async (req, res) => {
  try {
    const v14 = initV14();
    const models = await v14.lokDialogue.listModels();
    res.json({ models });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v14/lok-dialogue/personas', (req, res) => {
  try {
    const { PersonaTemplates } = require('./lok-dialogue.js');
    res.json({ personas: PersonaTemplates });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
//  Agnes AI 媒体生成（图像 2.1 Flash / 视频 V2.0）
//  - 图像：文生图 / 图生图 / 多图合成（同步，含下载落盘）
//  - 视频：文生视频 / 图生视频 / 关键帧动画（异步任务 + 轮询）
// ═══════════════════════════════════════════════════════════

/** 可选参数清单（供控制台下拉框使用） */
app.get('/api/v14/agnes/options', (req, res) => {
  try {
    const { SIZE_TABLE, RATIOS, AgnesMedia } = require('./agnes-media.js');
    res.json({
      sizes: Object.keys(SIZE_TABLE),
      ratios: RATIOS,
      sizeTable: SIZE_TABLE,
      durations: [3, 5, 10, 18],
      framePresets: AgnesMedia.DURATION_PRESETS,
      defaultSize: '2K',
      defaultRatio: '1:1',
      resolutions: [
        { label: '720P', width: 1152, height: 768 },
        { label: '1080P', width: 1920, height: 1080 },
      ],
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** 健康检查 —— 验证 API Key 与输出目录 */
app.get('/api/v14/agnes/health', async (req, res) => {
  try {
    const v14 = initV14();
    const h = await v14.agnesMedia.health();
    res.json({ ok: true, health: h });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

/** 生成图像（同步，可能耗时 5~60s） */
app.post('/api/v14/agnes/image', async (req, res) => {
  try {
    const v14 = initV14();
    const b = req.body || {};
    const rec = await v14.agnesMedia.generateImage({
      prompt: b.prompt,
      size: b.size,
      ratio: b.ratio,
      image: b.image,
      outputFormat: b.outputFormat,
      contentId: b.contentId,
      download: b.download !== false,
    });
    res.json({ ok: true, record: rec });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** 创建视频任务（异步，立即返回 videoId 供轮询） */
app.post('/api/v14/agnes/video', async (req, res) => {
  try {
    const v14 = initV14();
    const b = req.body || {};
    const rec = await v14.agnesMedia.createVideo({
      prompt: b.prompt,
      duration: b.duration,
      image: b.image,
      keyframes: b.keyframes,
      width: b.width,
      height: b.height,
      fps: b.fps,
      seed: b.seed,
      negativePrompt: b.negativePrompt,
      contentId: b.contentId,
    });
    res.json({ ok: true, record: rec });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** 创建视频任务并阻塞等待完成（默认开启等待；wait=false 时等同 /video） */
app.post('/api/v14/agnes/video/sync', async (req, res) => {
  try {
    const v14 = initV14();
    const b = req.body || {};
    const rec = await v14.agnesMedia.generateVideo({
      prompt: b.prompt,
      duration: b.duration,
      image: b.image,
      keyframes: b.keyframes,
      width: b.width,
      height: b.height,
      fps: b.fps,
      seed: b.seed,
      negativePrompt: b.negativePrompt,
      contentId: b.contentId,
    }, b.wait !== false);
    res.json({ ok: true, record: rec });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** 查询视频任务状态（完成时会顺带下载落盘） */
app.get('/api/v14/agnes/video/status/:id', async (req, res) => {
  try {
    const v14 = initV14();
    const rec = await v14.agnesMedia.getVideoStatus(req.params.id);
    if (!rec) return res.status(404).json({ ok: false, error: '任务不存在' });
    res.json({ ok: true, record: rec });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** 查询任意任务（图片或视频） */
app.get('/api/v14/agnes/status/:id', (req, res) => {
  try {
    const v14 = initV14();
    const rec = v14.agnesMedia.getStatus(req.params.id, req.query.type);
    if (!rec) return res.status(404).json({ ok: false, error: '任务不存在' });
    res.json({ ok: true, record: rec });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

/** 列出生成记录（?type=image|video&limit=50） */
app.get('/api/v14/agnes/list', (req, res) => {
  try {
    const v14 = initV14();
    const rows = v14.agnesMedia.list({
      type: req.query.type,
      limit: parseInt(req.query.limit, 10) || 50,
    });
    res.json({ ok: true, items: rows, count: rows.length });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

/** 提供本地已落盘的生成文件（图像/视频），带路径穿越防护 */
app.get('/agnes-file', (req, res) => {
  try {
    const raw = String(req.query.path || '');
    if (!raw) return res.status(400).json({ error: '缺少 path 参数' });
    const root = path.resolve(process.env.AGNES_OUT_DIR || 'D:/MSCMS-Content/agnes');
    const full = path.resolve(root, raw);
    const rel = path.relative(root, full);
    // 必须落在 root 之内且不是 root 本身
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      return res.status(403).json({ error: '非法路径' });
    }
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      return res.status(404).json({ error: '文件不存在' });
    }
    const ext = path.extname(full).toLowerCase();
    const types = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
      '.gif': 'image/gif', '.bmp': 'image/bmp', '.mp4': 'video/mp4', '.webm': 'video/webm',
      '.mov': 'video/quicktime',
    };
    res.type(types[ext] || 'application/octet-stream');
    res.sendFile(full);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// 系统信息 + 用户鉴权 API（v14.5 Phase 2）
// ──────────────────────────────────────────────────────────────────────────
// 公开：  /api/v14/system/info        — 系统元信息（地址/版本/角色矩阵）
//         /api/v14/auth/login        — 登录返回 JWT
//         /api/v14/auth/refresh      — refresh 续期
//         /api/v14/auth/roles        — 角色权限矩阵
// 鉴权：  /api/v14/auth/me           — 当前用户
//         /api/v14/auth/logout       — 注销（黑名单 JTI）
// 管理员：/api/v14/auth/users[*]     — 用户 CRUD + 重置密码
//         /api/v14/auth/audit        — 审计日志
// 设计取舍：业务路由（causal-chain / data / publish）保持开放，
//           不打断 50 云手机自动化；登录仅在 UI 网关层拦截。
// ════════════════════════════════════════════════════════════════════════════

function _am() { return v14Modules && v14Modules.authManager; }
function _amAdminOnly(req, res) {
  const m = _authMw(_am(), { perm: 'user:manage' });
  // 'user:manage' 不在默认矩阵中 → 仅 admin（通配 '*'）通过
  return m(req, res, () => true);
}

// 2026-09-06：排除不可达域 —— hlua.cc.cd 对 /api/v14/* 超时（非 v14 入口）。
//   旧版 app.asar 的 main.js 会以 env 注入 hlua.cc.cd（exe 自行拉起 server 的场景），
//   服务端兜底改写，无需再动 asar。
const PUBLIC_DOMAIN = (process.env.PUBLIC_DOMAIN === 'hlua.cc.cd'
  ? 'mscms.lokfeel.com'
  : process.env.PUBLIC_DOMAIN) || 'mscms.lokfeel.com';
const _serverStartedAt = new Date().toISOString();
const _backendBase = () => {
  // 本地/隧道双栈：环境变量 PUBLIC_DOMAIN 优先，否则用 localhost
  const local = `http://localhost:${PORT}`;
  const tunnel = PUBLIC_DOMAIN ? `https://${PUBLIC_DOMAIN}` : null;
  return { local, tunnel, primary: tunnel || local };
};

/** GET /api/v14/system/info — 公开：返回后端地址 / 版本 / 角色矩阵 */
app.get('/api/v14/system/info', (req, res) => {
  const am = _am();
  const authReady = !!(am && am._loaded);
  res.json({
    ok: true,
    name: 'MSCMS v14',
    fullName: 'Multi-Stream Content Management System',
    version: '14.5.0',
    nodeVersion: process.version,
    pid: process.pid,
    uptime: Math.floor(process.uptime()),
    startedAt: _serverStartedAt,
    backend: _backendBase(),
    port: PORT,
    publicDomain: PUBLIC_DOMAIN,
    auth: {
      enabled: authReady,
      defaultAdmin: authReady ? 'admin' : null,
      defaultPasswordNote: authReady ? '请在首次登录后立即修改默认密码 (MSCMS@2026)' : null,
      loginPath: '/login.html',
      apiLoginPath: '/api/v14/auth/login',
      roles: am ? am.roles() : _ROLE_LABELS && Object.keys(_ROLE_PERMS).map(r => ({
        key: r, label: _ROLE_LABELS[r] || r, permissions: _ROLE_PERMS[r]
      }))
    },
    modules: {
      totalModules: Object.keys(v14Modules || {}).length,
      keys: Object.keys(v14Modules || {}).slice(0, 50)
    },
    timestamp: new Date().toISOString()
  });
});

/** GET /api/v14/auth/roles — 公开：角色 + 权限矩阵 */
app.get('/api/v14/auth/roles', (req, res) => {
  const am = _am();
  res.json({ ok: true, roles: am ? am.roles() : Object.keys(_ROLE_PERMS).map(r => ({
    key: r, label: _ROLE_LABELS[r] || r, permissions: _ROLE_PERMS[r]
  })) });
});

/** POST /api/v14/auth/login — 公开：用户名/密码 → JWT */
app.post('/api/v14/auth/login', (req, res) => {
  const am = _am();
  if (!am) return res.status(503).json({ ok: false, error: 'auth_not_initialized' });
  const { username, password } = req.body || {};
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  const r = am.login(username, password, { ip });
  if (!r.ok) {
    if (r.reason === 'rate_limited' || r.error === 'rate_limited') {
      return res.status(429).json({ ok: false, error: r.error, retryAfter: r.retryAfter });
    }
    return res.status(401).json({ ok: false, error: r.error });
  }
  res.json({
    ok: true,
    token: r.token,
    refresh: r.refresh,
    user: r.user,
    expiresIn: am.expiresIn,
    backend: _backendBase()
  });
});

/** POST /api/v14/auth/refresh — 公开：用 refresh token 换新 access */
app.post('/api/v14/auth/refresh', (req, res) => {
  const am = _am();
  if (!am) return res.status(503).json({ ok: false, error: 'auth_not_initialized' });
  const { refresh } = req.body || {};
  const r = am.refresh(refresh);
  if (!r.ok) return res.status(401).json({ ok: false, error: r.error });
  res.json({ ok: true, token: r.token, refresh: r.refresh, user: r.user });
});

/** GET /api/v14/auth/me — 鉴权：当前用户 */
app.get('/api/v14/auth/me', (req, res) => {
  const am = _am();
  if (!am) return res.status(503).json({ ok: false, error: 'auth_not_initialized' });
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return res.status(401).json({ ok: false, error: 'missing_token' });
  const u = am.me(m[1]);
  if (!u) return res.status(401).json({ ok: false, error: 'invalid_token' });
  res.json({ ok: true, user: u });
});

/** POST /api/v14/auth/logout — 鉴权：撤销当前 token */
app.post('/api/v14/auth/logout', (req, res) => {
  const am = _am();
  if (!am) return res.status(503).json({ ok: false, error: 'auth_not_initialized' });
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return res.status(400).json({ ok: false, error: 'missing_token' });
  const r = am.logout(m[1]);
  res.json({ ok: true, ...r });
});

/** GET /api/v14/auth/users — 管理员：用户列表 */
app.get('/api/v14/auth/users', (req, res) => {
  const am = _am();
  if (!am) return res.status(503).json({ ok: false, error: 'auth_not_initialized' });
  // 手动鉴权（不在 _amAdminOnly 里走标准中间件以便统一错误格式）
  const h = req.headers.authorization || '';
  const mm = /^Bearer\s+(.+)$/i.exec(h);
  if (!mm) return res.status(401).json({ ok: false, error: 'missing_token' });
  const r = am.verify(mm[1]);
  if (!r) return res.status(401).json({ ok: false, error: 'invalid_token' });
  if (!am.hasPermission(r.user, 'user:manage')) return res.status(403).json({ ok: false, error: 'forbidden' });
  res.json({ ok: true, users: am.listUsers() });
});

/** POST /api/v14/auth/users — 管理员：创建用户 */
app.post('/api/v14/auth/users', (req, res) => {
  const am = _am();
  if (!am) return res.status(503).json({ ok: false, error: 'auth_not_initialized' });
  const h = req.headers.authorization || '';
  const mm = /^Bearer\s+(.+)$/i.exec(h);
  if (!mm) return res.status(401).json({ ok: false, error: 'missing_token' });
  const r = am.verify(mm[1]);
  if (!r) return res.status(401).json({ ok: false, error: 'invalid_token' });
  if (!am.hasPermission(r.user, 'user:manage')) return res.status(403).json({ ok: false, error: 'forbidden' });
  try {
    const u = am.createUser(req.body || {}, r.user);
    res.json({ ok: true, user: u });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/** PATCH /api/v14/auth/users/:id — 管理员：修改用户 */
app.patch('/api/v14/auth/users/:id', (req, res) => {
  const am = _am();
  if (!am) return res.status(503).json({ ok: false, error: 'auth_not_initialized' });
  const h = req.headers.authorization || '';
  const mm = /^Bearer\s+(.+)$/i.exec(h);
  if (!mm) return res.status(401).json({ ok: false, error: 'missing_token' });
  const r = am.verify(mm[1]);
  if (!r) return res.status(401).json({ ok: false, error: 'invalid_token' });
  if (!am.hasPermission(r.user, 'user:manage')) return res.status(403).json({ ok: false, error: 'forbidden' });
  try {
    const u = am.updateUser(req.params.id, req.body || {}, r.user);
    res.json({ ok: true, user: u });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/** DELETE /api/v14/auth/users/:id — 管理员：删除用户 */
app.delete('/api/v14/auth/users/:id', (req, res) => {
  const am = _am();
  if (!am) return res.status(503).json({ ok: false, error: 'auth_not_initialized' });
  const h = req.headers.authorization || '';
  const mm = /^Bearer\s+(.+)$/i.exec(h);
  if (!mm) return res.status(401).json({ ok: false, error: 'missing_token' });
  const r = am.verify(mm[1]);
  if (!r) return res.status(401).json({ ok: false, error: 'invalid_token' });
  if (!am.hasPermission(r.user, 'user:manage')) return res.status(403).json({ ok: false, error: 'forbidden' });
  try {
    const out = am.deleteUser(req.params.id, r.user);
    res.json(out);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/** POST /api/v14/auth/users/:id/reset — 管理员：重置密码 */
app.post('/api/v14/auth/users/:id/reset', (req, res) => {
  const am = _am();
  if (!am) return res.status(503).json({ ok: false, error: 'auth_not_initialized' });
  const h = req.headers.authorization || '';
  const mm = /^Bearer\s+(.+)$/i.exec(h);
  if (!mm) return res.status(401).json({ ok: false, error: 'missing_token' });
  const r = am.verify(mm[1]);
  if (!r) return res.status(401).json({ ok: false, error: 'invalid_token' });
  if (!am.hasPermission(r.user, 'user:manage')) return res.status(403).json({ ok: false, error: 'forbidden' });
  try {
    const { password } = req.body || {};
    const out = am.resetPassword(req.params.id, password, r.user);
    res.json(out);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/** POST /api/v14/auth/users/:id/change-password — 用户自己改密码 */
app.post('/api/v14/auth/users/:id/change-password', (req, res) => {
  const am = _am();
  if (!am) return res.status(503).json({ ok: false, error: 'auth_not_initialized' });
  const h = req.headers.authorization || '';
  const mm = /^Bearer\s+(.+)$/i.exec(h);
  if (!mm) return res.status(401).json({ ok: false, error: 'missing_token' });
  const r = am.verify(mm[1]);
  if (!r) return res.status(401).json({ ok: false, error: 'invalid_token' });
  // 只能改自己的密码，或 admin 改他人
  const isSelf = r.user.id === req.params.id;
  const isAdmin = am.hasPermission(r.user, 'user:manage');
  if (!isSelf && !isAdmin) return res.status(403).json({ ok: false, error: 'forbidden' });
  try {
    const { oldPassword, newPassword } = req.body || {};
    const out = am.changePassword(req.params.id, oldPassword, newPassword, r.user);
    res.json(out);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/** GET /api/v14/auth/audit — 管理员：审计日志（最近 200 条） */
app.get('/api/v14/auth/audit', (req, res) => {
  const am = _am();
  if (!am) return res.status(503).json({ ok: false, error: 'auth_not_initialized' });
  const h = req.headers.authorization || '';
  const mm = /^Bearer\s+(.+)$/i.exec(h);
  if (!mm) return res.status(401).json({ ok: false, error: 'missing_token' });
  const r = am.verify(mm[1]);
  if (!r) return res.status(401).json({ ok: false, error: 'invalid_token' });
  if (!am.hasPermission(r.user, 'user:manage')) return res.status(403).json({ ok: false, error: 'forbidden' });
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
  const items = am.auditLog.slice(-limit).reverse();
  res.json({ ok: true, count: items.length, items });
});

/** GET /api/v14/auth/snapshot — 公开：鉴权子系统健康（不含敏感字段） */
app.get('/api/v14/auth/snapshot', (req, res) => {
  const am = _am();
  if (!am) return res.status(503).json({ ok: false, error: 'auth_not_initialized' });
  res.json(am.snapshot());
});

module.exports = { app, pool };
