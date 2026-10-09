#!/usr/bin/env node
/**
 * tumblr_oauth1_local.js  ——  免 reCAPTCHA 获取 Tumblr WRITE token（用户自有 App）
 * ---------------------------------------------------------------------------
 * 这是真正能发布的前提：MSCMS 的 TumblrPublisher 需要「写权限」的 OAuth1 token。
 *
 * 为什么用它而不是 TumblThree：
 *   TumblThree 是下载器，它的 App 多半是「只读」scope —— 提取出的 token 能读、发不了帖。
 *   本脚本让用户用【自己注册的写权限 App】（consumer key/secret）走标准 OAuth1 握手，
 *   拿到的是带 write 的 token，MSCMS 立刻能发帖。
 *
 * 为什么绕过 reCAPTCHA：
 *   脚本把 callback 设成 http://localhost:<port>/callback，然后直接用你【已经登录的
 *   真实浏览器】打开授权页。你只需点一下 "Allow"，Tumblr 重定向回 localhost，脚本
 *   捕获  换 。全程在已登录态下，没有账号注册/登录的
 *   reCAPTCHA 拦截（那是 headless 才过不去的墙）。
 *
 * 前置（一次性，必须由你做，因为要账号持有者操作）：
 *   1. 打开 https://www.tumblr.com/oauth/apps  （已登录）
 *   2. 新建 Application，在 "Default permissions" 选允许发帖（write）
 *   3. 复制 Consumer Key / Consumer Secret
 *
 * 用法：
 *   node tumblr_oauth1_local.js --consumer-key <K> -- <S>
 *   node tumblr_oauth1_local.js --consumer-key <K> -- <S> --port 3122
 *   node tumblr_oauth1_local.js --consumer-key <K> -- <S> --probe-write
 *   node tumblr_oauth1_local.js --consumer-key <K> -- <S> --verifier "<VERIFIER>"  # 回调没收到的兜底
 *
 * 完成后会把 token 写入 data/.json + data/.json，
 * 重启 MSCMS 服务端即可用 TumblrPublisher 真实发布。
 * ---------------------------------------------------------------------------
 */
'use strict';
const http = require('http');
const { exec } = require('child_process');
const { DataStore } = require('./data-store');
const { TumblrPublisher } = require('./tumblr-publisher');

// ---- 参数解析 ----
const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    const val = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true;
    args.set(key, val);
  }
}
const  = args.get('consumer-key');
const  = args.get('');
const PORT = parseInt(args.get('port') || '3122', 10);
const CALLBACK = `http://localhost:${PORT}/callback`;
const probeWrite = args.has('probe-write');
const noOpen = args.has('no-open');

if (! || !) {
  console.error('❌ 用法: node tumblr_oauth1_local.js --consumer-key <K> -- <S> [--port 3122] [--probe-write]');
  console.error('   这两个值来自你在 https://www.tumblr.com/oauth/apps 自建的（写权限）App。');
  process.exit(2);
}

process.env.MSCMS_DATASTORE_WRITE_MODULES = process.env.MSCMS_DATASTORE_WRITE_MODULES || '*,-content';
// [2026-09-12] 本脚本不是 content 属主：显式声明写入范围，防止与主服务抢写（多写者覆盖）
const dataStore = new DataStore(require('path').join(__dirname, 'data'));
const publisher = new TumblrPublisher(dataStore, { callback: CALLBACK });

 openBrowser(url) {
  const cmd = process. === 'win32'
    ? `start "" "${url}"`
    : process. === 'darwin'
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  try { exec(cmd); } catch (e) { /* 忽略，手动打开即可 */ }
}

async  probeWriteOnce(blogName) {
  if (!blogName) { console.log('   ⚠️  无 blogName，跳过写探测'); return; }
  console.log('\n✍️  写探测：发一条测试文本帖（随后删除）…');
  const url = `https://api.tumblr.com/v2/blog/${encodeURIComponent(blogName)}/post`;
  const { oauthToken, oauthTokenSecret } = publisher._getToken();
  const cfg = publisher._getConfig();
  const oauth = publisher._baseOauthParams(cfg.);
  oauth. = oauthToken;
  const extra = { type: 'text', body: 'MSCMS v14 write-scope probe — ' + new Date().toISOString(), tags: 'mscms-test', format: 'json' };
  const sig = publisher._sign('POST', url, oauth, extra, cfg., oauthTokenSecret);
  const r = await require('./http-client').fetchExt(url, {
    method: 'POST',
    headers: { : publisher._authHeader(oauth, sig), '': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(extra)
  });
  const json = await r.json().catch(() => ({}));
  if (r.status === 201 && json.response && json.response.id) {
    const postId = json.response.id;
    console.log(`   ✅ 写权限正常！测试帖 id=${postId}`);
    const delUrl = `https://api.tumblr.com/v2/blog/${encodeURIComponent(blogName)}/post/delete`;
    const o2 = publisher._baseOauthParams(cfg.); o2. = oauthToken;
    const sig2 = publisher._sign('POST', delUrl, o2, { id: postId }, cfg., oauthTokenSecret);
    await require('./http-client').fetchExt(delUrl, { method: 'POST', headers: { : publisher._authHeader(o2, sig2), '': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ id: String(postId) }) });
    console.log('   🧹 已删除测试帖');
  } else {
    console.error(`   ❌ 写被拒 ${r.status}: ${JSON.stringify(json).slice(0, 200)}`);
    console.error('   请确认 App 的 Default permissions 勾选了允许发帖（write）。');
  }
}

(async () => {
  publisher.setConsumerKey(, );
  const verifierArg = args.get('verifier');

  let result;
  if (verifierArg) {
    // 手动模式：用上次 beginAuth 存下的 request token + 用户提供的 verifier 完成握手
    console.log('🔄 手动模式：用已存储的 request token + 提供的 verifier 完成授权…');
    result = await publisher.completeAuth(verifierArg);
  } else {
    console.log('📡 申请 request_token…');
    const { authorizeUrl } = await publisher.beginAuth();
    console.log('   授权页:', authorizeUrl);

    // 启动本地回调服务器
    const server = http.createServer(async (req, res) => {
      try {
        const u = new URL(req.url, `http://localhost:${PORT}`);
        if (u.pathname === '/callback') {
          const verifier = u.searchParams.get('');
          if (!verifier) {
            res.writeHead(400, { '': 'text/html; charset=utf-8' });
            res.end('<h2>❌ 缺少 </h2>');
            server.emit('verifier', null);
            return;
          }
          res.writeHead(200, { '': 'text/html; charset=utf-8' });
          res.end('<h2>✅ Tumblr 授权成功！</h2><p>可以关闭此页面，回到终端查看结果。</p>');
          server.emit('verifier', verifier);
        } else {
          res.writeHead(404); res.end('not found');
        }
      } catch (e) {
        res.writeHead(500); res.end('error');
        server.emit('verifier', null);
      }
    });

    await new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(PORT, resolve);
    });
    console.log(`\n🌐 本地回调服务器已启动: ${CALLBACK}`);
    console.log('   正在用你的默认浏览器打开授权页…（请确保你已在浏览器里登录 Tumblr）');
    if (!noOpen) openBrowser(authorizeUrl);

    console.log('\n👉 请在浏览器里点击 "Allow"，Tumblr 会自动跳回本机完成授权。');
    console.log('   （如果浏览器没自动打开，请手动访问上面的授权页 URL）\n');

    const verifier = await new Promise((resolve) => {
      const timer = setTimeout(() => { resolve(null); }, 600000);
      server.on('verifier', (v) => { clearTimeout(timer); resolve(v); });
    });
    server.close();

    if (!verifier) {
      console.error('\n⏰ 120 秒内未收到回调。若 Tumblr 未重定向回本机，请手动复制浏览器地址栏里的');
      console.error('    值，然后重新运行：');
      console.error(`   node tumblr_oauth1_local.js --consumer-key <K> -- <S> --verifier "<VERIFIER>"`);
      process.exit(3);
    }
    console.log('\n🔄 用 verifier 换取 …');
    result = await publisher.completeAuth(verifier);
  }
  console.log('   ✅ 授权完成。blogName =', result.blogName || '(未获取到，发布时会用默认博客)');

  // 显式落盘（DataStore 默认 5s 定时器刷盘，成功路径立即 flush 确保不丢）
  try { dataStore._flush(); } catch (e) { /* ignore */ }

  if (probeWrite) {
    await probeWriteOnce(result.blogName);
  } else {
    console.log('\n💡 未做写探测。建议重启 MSCMS 后用一条真实内容验证发布（带 write 权限的 App 应能成功）。');
  }

  console.log('\n' + '='.repeat(60));
  console.log('🎉 凭证已写入 MSCMS DataStore：');
  console.log('   data/.json  (consumer key/secret)');
  console.log('   data/.json   (access token + blogName)');
  console.log('   现在【重启 MSCMS 服务端】，TumblrPublisher 即可真实发布视频到 Tumblr。');
  console.log('='.repeat(60));
})().catch((e) => {
  console.error('\n❌ 流程失败:', e.message);
  process.exit(1);
});
