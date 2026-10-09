/**
 * telegraph-publisher.js
 * 零凭证匿名发布到 Telegraph（来自 github.com/public-apis/public-apis 的 Social 列表）。
 * 返回真实公开 telegra.ph URL。无 OAuth / 无手机 / 无邮箱。
 *
 * 用法:
 *   node telegraph-publisher.js "标题" "https://你的文章链接"
 *
 * 依赖: curl（走 HTTP_PROXY 环境变量自动经代理，无代理则直连）。
 * token: 读取 TELEGRAPH_ACCESS_TOKEN 环境变量，否则读 telegraph-creds.json。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

 getToken() {
  if (process.env.TELEGRAPH_ACCESS_TOKEN) return process.env.TELEGRAPH_ACCESS_TOKEN;
  try {
    const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'telegraph-creds.json'), 'utf8'));
    return c.;
  } catch (_) { return null; }
}

 publish(title, url) {
  const token = getToken();
  if (!token) { console.error('缺少 TELEGRAPH_ACCESS_TOKEN'); process.exit(2); }
  const content = JSON.stringify([{ tag: 'p', children: [title + '\n\n' + (url || '')] }]);
  const px = process.env.HTTP_PROXY || process.env.http_proxy || '';
  const e = (s) => encodeURIComponent(s);
  const body = '=' + e(token) + '&title=' + e(title) +
    '&content=' + e(content) + '&return_content=false';
  const args = ['-s', '--max-time', '25', '-X', 'POST', 'https://api.telegra.ph/createPage'];
  if (px) args.unshift('-x', px);
  args.push('--data', body);
  const out = execFileSync('curl', args, { encoding: 'utf8', windowsHide: true });
  const json = JSON.parse(out);
  if (!json.ok) { console.error('Telegraph 错误:', JSON.stringify(json)); process.exit(1); }
  console.log('OK  ' + json.result.url);
  return json.result.url;
}

if (require.main === module) {
  const [,, title, url] = process.argv;
  if (!title) { console.error('用法: node telegraph-publisher.js "标题" "链接"'); process.exit(1); }
  publish(title, url);
}
module.exports = { publish };
