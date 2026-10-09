/**
 * ShardX PoC 第一步：生成指纹 → 创建 profile（内联绑定 VPS 代理）→ 启动并取 CDP URL。
 * 零伪造：每一步都输出真实响应，失败即如实报错。
 */
const fs = require('fs');
const path = require('path');
const BASE = 'http://:40325';
const TOKEN = fs.readFileSync(path.join(__dirname, '..', '_shardx_token.txt'), 'utf8').trim();
const H = { : 'Bearer ' + TOKEN, '': 'application/json' };
const PROXY = process.env.SHARDX_PROXY || 'http://:10808';

async  call(method, p, body) {
  const r = await fetch(BASE + p, {
    method, headers: H, body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  return { status: r.status, text: t, json: (() => { try { return JSON.parse(t); } catch (_) { return null; } })() };
}

(async () => {
  // 1) 生成 Windows 指纹
  const fp = await call('GET', '/fingerprint/new/windows-x64');
  console.log('1) /fingerprint/new/windows-x64 -> HTTP ' + fp.status);
  if (!fp.json) { console.log('   响应: ' + fp.text.slice(0, 200)); process.exit(1); }
  const fingerprint = fp.json;
  console.log('   指纹名: ' + (fingerprint.name || fingerprint.id || '(未知)'));
  console.log('   UA: ' + String((fingerprint.navigator && fingerprint.navigator.user_agent) || '').slice(0, 90));

  // 2) 创建 profile（内联绑定代理）
  const name = 'mscms-poc-' + Date.now();
  const created = await call('POST', '/profiles', {
    name, fingerprint, proxy: PROXY,
  });
  console.log('\n2) POST /profiles -> HTTP ' + created.status);
  console.log('   ' + created.text.slice(0, 250));
  if (!created.json) process.exit(1);
  const pid = created.json.id || created.json.profile_id || created.json.name;
  console.log('   profile id = ' + pid);

  // 3) 启动并取 CDP
  const started = await call('POST', '/profiles/' + encodeURIComponent(pid) + '/start?cdp=true&headless=false');
  console.log('\n3) POST /profiles/' + pid + '/start -> HTTP ' + started.status);
  const txt = started.text.slice(0, 400);
  console.log('   ' + txt);

  // 响应结构：{ cdp: { http_url, port, web_socket_debugger_url }, pid, profile_id, headless }
  const cdpObj = started.json && started.json.cdp;
  const cdp = (cdpObj && (cdpObj.web_socket_debugger_url || cdpObj.ws_url))
    || (started.json && (started.json.cdp_url || started.json.cdpUrl)) || null;
  if (cdp) {
    fs.writeFileSync(path.join(__dirname, '..', '_shardx_cdp.txt'), cdp);
    console.log('\n✅ CDP URL: ' + cdp);
    console.log('   已保存 _shardx_cdp.txt');
  } else {
    console.log('\n⚠️ 未拿到 CDP URL');
  }
  process.exit(0);
})();
