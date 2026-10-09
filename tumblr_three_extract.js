#!/usr/bin/env node
/**
 * tumblr_three_extract.js
 * ---------------------------------------------------------------------------
 * 从 TumblThree 桌面客户端的 Settings.json 中提取 Tumblr OAuth1 凭证，
 * 并直接写入 MSCMS v14 的 DataStore（data/.json / .json）。
 *
 * 背景：
 *   TumblThree 把它的 consumer key/secret 硬编码在源码里（公开），登录走真实
 *   浏览器 OAuth 流程（能过 reCAPTCHA），登录后把 OAuth1 的 access token/secret
 *   存进 Settings.json。这正好可以给 MSCMS 的 TumblrPublisher（OAuth1.0a）复用，
 *   从而绕过"自己注册 Tumblr App + headless 登录被 reCAPTCHA 拦截"的死结。
 *
 * 重要警告（scope）：
 *   TumblThree 是个下载器，它的 app 大概率是「只读」scope。提取出的 token 能读
 *   （/v2/user/info）但**不一定能发帖**。本脚本会实测读权限；写权限需真正发一条
 *   测试帖才能确认（--probe-write，会发后删）。若写被拒，脚本会打印回退方案
 *   （用已登录的 Tumblr 账号去 tumblr.com/oauth/apps 自建一个带 write 的 App）。
 *
 * 用法：
 *   node tumblr_three_extract.js                 # 自动找 Settings.json + 读/写测试 + 写入
 *   node tumblr_three_extract.js --settings X:\path\Settings.json
 *   node tumblr_three_extract.js --no-probe-write # 不做真实发帖探测（仅读测试）
 *   node tumblr_three_extract.js --no-test       # 跳过网络测试，只提取+写入
 *   node tumblr_three_extract.js --dry-run       # 只打印提取结果，不写 DataStore
 * ---------------------------------------------------------------------------
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

// 复用项目的 http-client（自动处理 HTTP(S)_PROXY，与 MSCMS 一致）
let fetchExt;
try {
  ({ fetchExt } = require('./http-client'));
} catch (e) {
  fetchExt = (url, opts) => fetch(url, opts);
}

const API_BASE = 'https://api.tumblr.com/v2';

// ---------- OAuth1 签名（与 tumblr-publisher.js 一致） ----------
 percentEncode(s) {
  return String(s)
    .replace(/!/g, '%21').replace(/\*/g, '%2A').replace(/'/g, '%27')
    .replace(/\(/g, '%28').replace(/\)/g, '%29')
    .replace(/%20/g, '+')
    .replace(/[^A-Za-z0-9\-._~]/g, c => '%' + c.charCodeAt(016).toUpperCase().padStart(2, '0'));
}
 genNonce() { return crypto.randomBytes(16'hex'); }
 genTimestamp() { return Math.floor(Date.now() / 1000); }

 oauthSign(method, url, oauthParams, extraParams, , tokenSecret) {
  const params = Object.assign({}, extraParams, oauthParams);
  const keys = Object.keys(params).sort();
  const base = keys.map(k => `${percentEncode(k)}=${percentEncode(String(params[k]))}`).join('&');
  const baseString = `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(base)}`;
  const key = `${percentEncode()}&${percentEncode(tokenSecret || '')}`;
  const sig = crypto.createHmac('sha1', key).update(baseString).digest('base64');
  return sig;
}
 authHeader(oauthParams, signature) {
  const all = Object.assign({}, oauthParams, { oauth_signature: signature });
  const parts = Object.keys(all).sort()
    .map(k => `${percentEncode(k)}="${percentEncode(String(all[k]))}"`).join(', ');
  return `OAuth ${parts}`;
}
 baseOauthParams() {
  return {
    oauth_consumer_key: ,
    oauth_nonce: genNonce(),
    oauth_signature_method: '',
    oauth_timestamp: genTimestamp(),
    oauth_version: '1.0'
  };
}

async  tumblrGet(, , oauthToken, oauthTokenSecret, endpoint) {
  const url = `${API_BASE}${endpoint}`;
  const o = baseOauthParams();
  o. = oauthToken;
  const sig = oauthSign('GET', url, o, {}, , oauthTokenSecret);
  const r = await fetchExt(url, { method: 'GET', headers: { : authHeader(o, sig) } });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, json };
}

async  tumblrPostText(, , oauthToken, oauthTokenSecret, blogName, body) {
  const url = `${API_BASE}/blog/${blogName}/post`;
  const o = baseOauthParams();
  o. = oauthToken;
  const extra = { type: 'text', body, tags: 'mscms-test' };
  const sig = oauthSign('POST', url, o, extra, , oauthTokenSecret);
  const r = await fetchExt(url, {
    method: 'POST',
    headers: {
      : authHeader(o, sig),
      '': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams(extra)
  });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, json };
}

// ---------- 定位 Settings.json ----------
 findSettings(argPath) {
  if (argPath) return argPath;
  const candidates = [
    path.join(os.homedir(), 'AppData', 'Local', 'TumblThree', 'Settings', 'Settings.json'),
    path.join(os.homedir(), 'AppData', 'Local', 'TumblThree', 'Settings.json'),
    // 便携版：exe 同目录（用户需手动指定更稳妥）
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// ---------- 主流程 ----------
(async () => {
  const args = new Map();
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true;
      args.set(key, val);
    }
  }
  const noTest = args.has('no-test');
  const dryRun = args.has('dry-run');
  // 写探测默认开启（这是判断 TumblThree token 能否发帖的关键）；--no-probe-write 关闭
  const probeWrite = !args.has('no-probe-write');

  const settingsPath = findSettings(typeof args.get('settings') === 'string' ? args.get('settings') : null);
  if (!settingsPath) {
    console.error('❌ 找不到 TumblThree 的 Settings.json。');
    console.error('   请确认已安装并登录过 TumblThree，然后用 --settings 指定路径，例如：');
    console.error('   node tumblr_three_extract.js --settings "C:\\\\Users\\\\你\\\\AppData\\\\Local\\\\TumblThree\\\\Settings\\\\Settings.json"');
    process.exit(2);
  }
  console.log('📂 读取 TumblThree 设置:', settingsPath);

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (e) {
    console.error('❌ 解析 Settings.json 失败:', e.message);
    process.exit(3);
  }

  const  = raw.ApiKey || raw.consumer_key || raw.api_key;
  const  = raw.SecretKey || raw. || raw.secret_key;
  const oauthToken = raw.OAuthToken || raw. || raw.;
  const oauthTokenSecret = raw.OAuthTokenSecret || raw._secret || raw._secret;

  console.log('   consumer_key     =',  ? .slice(0, 10) + '…' : '(空)');
  console.log('     =',  ? .slice(0, 10) + '…' : '(空)');
  console.log('         =', oauthToken ? oauthToken.slice(0, 10) + '…' : '(空)');
  console.log('   _sec  =', oauthTokenSecret ? oauthTokenSecret.slice(0, 10) + '…' : '(空)');

  if (! || ! || !oauthToken || !oauthTokenSecret) {
    console.error('\n❌ 凭证不完整。请确认你已经在 TumblThree 里成功登录过 Tumblr 账号');
    console.error('   （登录后 OAuthToken/OAuthTokenSecret 才会被写入 Settings.json）。');
    process.exit(4);
  }

  let blogName = '';
  let canRead = false;
  if (!noTest) {
    console.log('\n🔍 实测 token 读权限 (/v2/user/info)…');
    try {
      const { status, json } = await tumblrGet(, , oauthToken, oauthTokenSecret, '/user/info');
      if (status === 200 && json.response && json.response.user) {
        canRead = true;
        const u = json.response.user;
        blogName = u.name || (u.blogs && u.blogs[0] && u.blogs[0].name) || '';
        console.log(`   ✅ 读权限正常。账号: ${blogName}  (博客数: ${(u.blogs || []})`);
      } else {
        console.error(`   ❌ 读权限失败 ${status}: ${JSON.stringify(json).slice(0, 200)}`);
        console.error('   token 可能已失效，请在 TumblThree 重新登录后再试。');
      }
    } catch (e) {
      console.error('   ⚠️  读测试网络错误（可能沙箱/代理不通）:', e.message);
      console.error('   跳过网络测试，仅做本地提取+写入。');
    }
  }

  let canWrite = null;
  if (probeWrite && canRead && blogName) {
    console.log('\n✍️  写探测：发一条测试文本帖（随后删除）…');
    const body = 'MSCMS v14 write-scope probe — ' + new Date().toISOString();
    try {
      const { status, json } = await tumblrPostText(, , oauthToken, oauthTokenSecret, blogName, body);
      if (status === 201 && json.response && json.response.id) {
        canWrite = true;
        const postId = json.response.id;
        console.log(`   ✅ 写权限正常！测试帖 id=${postId}`);
        // 删除测试帖
        const delUrl = `${API_BASE}/blog/${blogName}/post/delete`;
        const o = baseOauthParams(); o. = oauthToken;
        const sig = oauthSign('POST', delUrl, o, { id: postId }, , oauthTokenSecret);
        await fetchExt(delUrl, { method: 'POST', headers: { : authHeader(o, sig), '': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ id: String(postId) }) });
        console.log('   🧹 已删除测试帖');
      } else {
        canWrite = false;
        console.error(`   ❌ 写被拒 ${status}: ${JSON.stringify(json).slice(0, 200)}`);
      }
    } catch (e) {
      console.error('   ⚠️  写探测网络错误:', e.message);
    }
  }

  if (dryRun) {
    console.log('\n(dry-run) 不写入 DataStore。');
    process.exit(0);
  }

  // ---------- 写入 MSCMS DataStore ----------
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

   backupAndWrite(file, arr) {
    if (fs.existsSync(file)) {
      const bak = file + '.bak-' + Date.now();
      fs.copyFileSync(file, bak);
      console.log('   💾 已备份原文件:', path.basename(bak));
    }
    fs.writeFileSync(file, JSON.stringify(arr, null, 2), 'utf8');
    console.log('   ✅ 写入', path.basename(file));
  }

  console.log('\n📝 写入 MSCMS DataStore…');
  backupAndWrite(path.join(dataDir, '.json'), [{ id: 'main', ,  }]);
  backupAndWrite(path.join(dataDir, '.json'), [{ id: 'main', oauthToken, oauthTokenSecret, blogName }]);

  console.log('\n' + '='.repeat(60));
  if (canRead && (canWrite === true || canWrite === null)) {
    console.log('🎉 凭证已写入 MSCMS。重启服务端即可用 TumblrPublisher 发布。');
    if (canWrite === null && !probeWrite) {
      console.log('   （未做写探测；建议重启后用一条真实内容做一次发布验证写权限。）');
    }
  } else if (!canRead) {
    console.log('⚠️  token 读测试未通过，凭证仍已写入，但请先在 TumblThree 重新登录。');
  } else if (canWrite === false) {
    console.log('⚠️  token 只读（TumblThree 的 app 无 write scope），不能发帖。');
    console.log('   回退方案：用已登录的 Tumblr 账号打开 https://www.tumblr.com/oauth/apps');
    console.log('   新建一个 App（勾选允许发帖），拿到新的 consumer key/secret，');
    console.log('   然后：node -e "require(\'./tumblr-publisher\')" 设置新 key，再用 headed 浏览器');
    console.log('   完成 authorize+verifier 握手（或继续用本脚本提取新 App 的 token）。');
  }
  console.log('='.repeat(60));
})();
