/**
 * tumblr-oauth2.js — Tumblr API v2 OAuth2 授权助手（端到端拿真实 access_token）
 *
 * 依据官方文档: https://www.tumblr.com/docs/en/api/v2#oauth2authorize---authorization-request
 *   授权端点:  GET  https://www.tumblr.com/oauth2/authorize
 *   令牌端点:  POST https://api.tumblr.com/v2/oauth2/token
 *   scope:     basic write offline_access  (offline_access 才会返回 refresh_token)
 *   发帖(NPF): POST https://api.tumblr.com/v2/blog/{blog}/posts  (Authorization: Bearer)
 *
 * 前置(你做一次):
 *   1) 打开 https://www.tumblr.com/oauth/apps → Register application
 *   2) 拿到 OAuth Consumer Key(=client_id) 与 Consumer Secret(=client_secret)
 *   3) 在该 App 的设置里，把 "OAuth2 redirect URLs" 填入:
 *        http://localhost:3111/callback
 *   4) 把 key/secret 填入 credentials-input.json 的 tumblr_client_id / tumblr_client_secret
 *      (或用命令行 --client-id / --client-secret，或环境变量 TUMBLR_CLIENT_ID/SECRET)
 *
 * 用法:
 *   node tumblr-oauth2.js authorize     # 跑授权流，拿 token 并写入 .n8n-env + tumblr-creds.json
 *   node tumblr-oauth2.js refresh       # 用 refresh_token 刷新 access_token
 *   node tumblr-oauth2.js blogs         # 列出当前 token 可用的博客
 *   node tumblr-oauth2.js test          # 发一条真实测试帖验证(NPF)
 *
 * 铁律: 只写真实拿到的 token；任何失败都如实报错，绝不伪造。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const ROOT = __dirname;
const ENV_FILE = path.join(ROOT, '.n8n-env');
const INPUT_FILE = path.join(ROOT, 'credentials-input.json');
const CREDS_FILE = path.join(ROOT, 'tumblr-creds.json');

const REDIRECT_PORT = 3111;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;
const AUTHORIZE_URL = 'https://www.tumblr.com/oauth2/authorize';
const TOKEN_URL = 'https://api.tumblr.com/v2/oauth2/token';
const SCOPE = 'basic write offline_access';

// ---- 代理支持 (Node fetch 默认不读 HTTP_PROXY) ----
let dispatcher = null;
(function setupProxy() {
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (!proxy) return;
  try {
    const { ProxyAgent } = require('undici');
    dispatcher = new ProxyAgent(proxy);
    console.log(`[proxy] 经 ${proxy} 出网`);
  } catch (e) {
    console.log('[proxy] 未能加载 undici ProxyAgent，直连:', e.message);
  }
})();

function doFetch(url, opts = {}) {
  if (dispatcher) opts.dispatcher = dispatcher;
  return fetch(url, opts);
}

// ---- 参数读取: 命令行 > 环境变量 > credentials-input.json ----
function argVal(name) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function readInput() {
  try { return JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8')); } catch { return {}; }
}

function getClientCreds() {
  const input = readInput();
  const clientId = argVal('client-id') || process.env.TUMBLR_CLIENT_ID || input.tumblr_client_id;
  const clientSecret = argVal('client-secret') || process.env.TUMBLR_CLIENT_SECRET || input.tumblr_client_secret;
  if (!clientId || !clientSecret) {
    console.error('\n缺少 client_id / client_secret。');
    console.error('请在 https://www.tumblr.com/oauth/apps 注册应用后，把 Consumer Key/Secret 填入');
    console.error('credentials-input.json 的 tumblr_client_id / tumblr_client_secret，或用');
    console.error('  node tumblr-oauth2.js authorize --client-id XXX --client-secret YYY\n');
    process.exit(1);
  }
  return { clientId, clientSecret };
}

function loadCreds() {
  try { return JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8')); } catch { return {}; }
}

function saveCreds(obj) {
  fs.writeFileSync(CREDS_FILE, JSON.stringify(obj, null, 2));
  console.log(`[creds] 已保存 ${path.basename(CREDS_FILE)}`);
}

// ---- 写入 .n8n-env (只覆盖已存在的键，保留注释结构) ----
function writeEnv(updates) {
  if (!fs.existsSync(ENV_FILE)) return;
  const lines = fs.readFileSync(ENV_FILE, 'utf8').split('\n');
  const remaining = { ...updates };
  const out = lines.map((line) => {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (m && remaining[m[1]] !== undefined) {
      const key = m[1];
      const v = remaining[key];
      delete remaining[key];
      return `${key}=${v}`;
    }
    return line;
  });
  // 若 .n8n-env 里还没有这些键，追加到末尾
  for (const [k, v] of Object.entries(remaining)) {
    out.push(`${k}=${v}`);
  }
  fs.writeFileSync(ENV_FILE, out.join('\n'));
  console.log(`[env] 已写入 ${Object.keys(updates).join(', ')} 到 .n8n-env`);
}

// ---- 令牌交换 ----
async function exchangeToken(params) {
  const body = new URLSearchParams(params).toString();
  const res = await doFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok || !json.access_token) {
    throw new Error(`令牌交换失败 HTTP ${res.status}: ${text}`);
  }
  return json;
}

async function persistToken(tok, clientCreds) {
  const now = Date.now();
  const creds = {
    ...loadCreds(),
    client_id: clientCreds.clientId,
    client_secret: clientCreds.clientSecret,
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || loadCreds().refresh_token || null,
    token_type: tok.token_type || 'bearer',
    scope: tok.scope || SCOPE,
    expires_in: tok.expires_in,
    obtained_at: now,
    expires_at: tok.expires_in ? now + tok.expires_in * 1000 : null,
  };
  // 拿主博客名
  try {
    const blog = await getPrimaryBlog(tok.access_token);
    if (blog) creds.blog = blog;
  } catch (e) {
    console.log('[blog] 获取主博客失败(不影响 token):', e.message);
  }
  saveCreds(creds);
  const envUpdates = { TUMBLR_TOKEN: creds.access_token };
  if (creds.blog) envUpdates.TUMBLR_BLOG = creds.blog;
  writeEnv(envUpdates);
  return creds;
}

async function getPrimaryBlog(accessToken) {
  const res = await doFetch('https://api.tumblr.com/v2/user/info', {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });
  const json = await res.json();
  const blogs = json && json.response && json.response.user && json.response.user.blogs;
  if (!blogs || !blogs.length) return null;
  const primary = blogs.find((b) => b.primary) || blogs[0];
  // 用 hostname (yourblog.tumblr.com) 作 blog-identifier
  return primary.name ? `${primary.name}.tumblr.com` : null;
}

// ---- 命令: authorize ----
async function cmdAuthorize() {
  const clientCreds = getClientCreds();
  const state = crypto.randomBytes(16).toString('hex');
  const authUrl = `${AUTHORIZE_URL}?` + new URLSearchParams({
    client_id: clientCreds.clientId,
    response_type: 'code',
    scope: SCOPE,
    state,
    redirect_uri: REDIRECT_URI,
  }).toString();

  console.log('\n════════════════════════════════════════════════════════');
  console.log('第 1 步：在浏览器打开下面的授权链接并点击「允许」：\n');
  console.log(authUrl);
  console.log('\n(若浏览器提示 redirect 不匹配，请确认你的 App 设置里 OAuth2 redirect URLs');
  console.log(` 已填: ${REDIRECT_URI})`);
  console.log('════════════════════════════════════════════════════════\n');
  console.log(`等待授权回调 http://localhost:${REDIRECT_PORT}/callback ...`);

  const code = await waitForCallback(state);
  console.log('\n[callback] 收到授权码，正在交换 access_token ...');

  const tok = await exchangeToken({
    grant_type: 'authorization_code',
    code,
    client_id: clientCreds.clientId,
    client_secret: clientCreds.clientSecret,
    redirect_uri: REDIRECT_URI,
  });

  const creds = await persistToken(tok, clientCreds);
  console.log('\n✅ 授权成功！');
  console.log(`   access_token : ${creds.access_token.slice(0, 12)}...`);
  console.log(`   refresh_token: ${creds.refresh_token ? creds.refresh_token.slice(0, 12) + '...' : '(无, 未含 offline_access)'}`);
  console.log(`   有效期       : ${creds.expires_in ? Math.round(creds.expires_in / 3600) + ' 小时' : '未知'}`);
  console.log(`   主博客       : ${creds.blog || '(未取到)'}`);
  console.log('\n下一步: 运行  node tumblr-oauth2.js test   发一条真实测试帖验证；');
  console.log('        然后重启 n8n 让 Tumblr 扇出节点读取新 token。');
  process.exit(0);
}

function waitForCallback(expectedState) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url.startsWith('/callback')) {
        res.writeHead(404); res.end('not found'); return;
      }
      const u = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
      const err = u.searchParams.get('error');
      const code = u.searchParams.get('code');
      const state = u.searchParams.get('state');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (err) {
        res.end(`<h2>授权失败: ${err}</h2><p>可关闭本页返回终端。</p>`);
        server.close(); return reject(new Error(`授权被拒绝/失败: ${err}`));
      }
      if (state !== expectedState) {
        res.end('<h2>state 校验失败(可能的 CSRF)</h2>');
        server.close(); return reject(new Error('state 不匹配'));
      }
      res.end('<h2>授权成功 ✅</h2><p>可以关闭本页，返回终端查看结果。</p>');
      server.close();
      resolve(code);
    });
    server.on('error', reject);
    server.listen(REDIRECT_PORT);
  });
}

// ---- 命令: refresh ----
async function cmdRefresh() {
  const creds = loadCreds();
  if (!creds.refresh_token) {
    console.error('无 refresh_token，请先 authorize（scope 含 offline_access）。');
    process.exit(1);
  }
  const tok = await exchangeToken({
    grant_type: 'refresh_token',
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    refresh_token: creds.refresh_token,
  });
  const updated = await persistToken(tok, { clientId: creds.client_id, clientSecret: creds.client_secret });
  console.log('\n✅ 已刷新 access_token');
  console.log(`   新 token 有效期: ${updated.expires_in ? Math.round(updated.expires_in / 3600) + ' 小时' : '未知'}`);
  process.exit(0);
}

// ---- 命令: blogs ----
async function cmdBlogs() {
  const creds = loadCreds();
  if (!creds.access_token) { console.error('无 access_token，请先 authorize。'); process.exit(1); }
  const res = await doFetch('https://api.tumblr.com/v2/user/info', {
    headers: { 'Authorization': `Bearer ${creds.access_token}` },
  });
  const json = await res.json();
  if (!res.ok) { console.error('HTTP', res.status, JSON.stringify(json)); process.exit(1); }
  const blogs = json.response.user.blogs || [];
  console.log(`\n用户 ${json.response.user.name} 的博客(${blogs.length}):`);
  blogs.forEach((b) => console.log(`  - ${b.name}.tumblr.com${b.primary ? '  (primary)' : ''}  posts=${b.posts}`));
  process.exit(0);
}

// ---- 命令: test (NPF 发帖) ----
async function cmdTest() {
  const creds = loadCreds();
  if (!creds.access_token) { console.error('无 access_token，请先 authorize。'); process.exit(1); }
  const blog = creds.blog || argVal('blog');
  if (!blog) { console.error('无 blog identifier，请先 authorize 或用 --blog yourblog.tumblr.com'); process.exit(1); }
  const url = `https://api.tumblr.com/v2/blog/${blog}/posts`;
  const bodyObj = {
    content: [{ type: 'text', text: `MSCMS v14 OAuth2 自测 — ${new Date().toISOString()}` }],
    state: 'published',
    tags: 'mscms,automation',
  };
  const res = await doFetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${creds.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyObj),
  });
  const json = await res.json();
  if (res.status === 201 && json.response && json.response.id) {
    console.log(`\n✅ 真实发帖成功! post id = ${json.response.id}`);
    console.log(`   查看: https://${blog}/post/${json.response.id}`);
    process.exit(0);
  }
  console.error(`\n❌ 发帖失败 HTTP ${res.status}:`, JSON.stringify(json));
  process.exit(1);
}

// ---- 入口 ----
(async () => {
  const cmd = process.argv[2] || 'authorize';
  try {
    if (cmd === 'authorize') await cmdAuthorize();
    else if (cmd === 'refresh') await cmdRefresh();
    else if (cmd === 'blogs') await cmdBlogs();
    else if (cmd === 'test') await cmdTest();
    else { console.error('未知命令:', cmd, '\n可用: authorize | refresh | blogs | test'); process.exit(1); }
  } catch (e) {
    console.error('\n错误:', e.message);
    process.exit(1);
  }
})();
