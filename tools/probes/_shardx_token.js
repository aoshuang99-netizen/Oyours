/**
 * 用 launcher 的 api_secret 自签 HS256 JWT（ShardX 无 token 铸造端点）。
 * 成功后返回 token，供后续 PoC 调用 Automation API 使用。
 */
const fs = require('fs');
const crypto = require('crypto');

const SETTINGS = 'C:/Users/AS/AppData/Roaming/shardx-launcher/settings.json';
const BASE = 'http://127.0.0.1:40325';

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

(async () => {
  const secret = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')).api_secret;
  const now = Math.floor(Date.now() / 1000);

  const candidates = [
    { iat: now, exp: now + 86400 },
    { iat: now, exp: now + 86400, sub: 'automation' },
    { iat: now },
    {},
  ];

  for (const payload of candidates) {
    const data = b64url({ alg: 'HS256', typ: 'JWT' }) + '.' + b64url(payload);
    const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
    const token = data + '.' + sig;

    try {
      const r = await fetch(BASE + '/profiles', {
        headers: { Authorization: 'Bearer ' + token },
      });
      console.log('payload=' + JSON.stringify(payload) + ' -> HTTP ' + r.status);
      if (r.ok) {
        const t = await r.text();
        console.log('  ✅ 认证成功，token 可用');
        console.log('  /profiles 响应: ' + t.slice(0, 120).replace(/\n/g, ' '));
        fs.writeFileSync(__dirname + '/_shardx_token.txt', token);
        console.log('  token 已保存 _shardx_token.txt');
        process.exit(0);
      }
    } catch (e) {
      console.log('payload=' + JSON.stringify(payload) + ' -> ERR ' + String(e.message).slice(0, 30));
    }
  }
  console.log('❌ 所有 payload 变体均认证失败');
  process.exit(1);
})();
