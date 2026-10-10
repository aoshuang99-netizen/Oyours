const fs = require('fs');
const path = require('path');

const DIR = 'D:\\mscms-ws\\data2';
const load = (name) => {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, name + '.json'), 'utf8')); }
  catch (e) { return null; }
};

(async () => {
  // 1) 因果链阶段统计
  try {
    const r = await fetch('http://127.0.0.1:3002/api/v14/causal-chain/status');
    const j = await r.json();
    console.log('=== 因果链 ===');
    console.log('  ' + JSON.stringify(j.stats).slice(0, 200));
    if (j.phases) console.log('  phases: ' + JSON.stringify(j.phases).slice(0, 300));
  } catch (e) { console.log('causal ERR ' + e.message); }

  // 2) publish 真实性
  const publish = load('publish');
  if (Array.isArray(publish)) {
    let real = 0; let fake = 0; let none = 0;
    for (const p of publish) {
      const u = p.postUrl || p.post_url || p.url || '';
      if (!u) { none++; continue; }
      if (/hlua\.cc\.cd\/content|localhost|127\.0\.0\.1/.test(u)) fake++;
      else real++;
    }
    console.log('\n=== publish 真实性 (total=' + publish.length + ') ===');
    console.log('  真实外网 URL : ' + real);
    console.log('  本地/伪造 URL: ' + fake);
    console.log('  无 URL       : ' + none);
    const sample = publish.filter((p) => p.postUrl && !/hlua|localhost|127\./.test(p.postUrl)).slice(0, 2);
    sample.forEach((s) => console.log('  样例: ' + s.postUrl));
  }

  // 3) visits 内容
  const visits = load('visits');
  console.log('\n=== visits ===');
  if (Array.isArray(visits)) {
    console.log('  条数=' + visits.length);
    console.log('  ' + JSON.stringify(visits[0] || {}).slice(0, 300));
  } else if (visits && typeof visits === 'object') {
    const k = Object.keys(visits);
    console.log('  object keys=' + k.length + '  ' + JSON.stringify(visits[k[0]] || {}).slice(0, 250));
  }

  // 4) tumblr_action_log 单条体积
  const tal = load('tumblr_action_log');
  if (Array.isArray(tal) && tal.length) {
    const size = fs.statSync(path.join(DIR, 'tumblr_action_log.json')).size;
    console.log('\n=== tumblr_action_log ===');
    console.log('  条数=' + tal.length + '  文件=' + (size / 1048576).toFixed(2) + 'MB  平均每条=' + (size / tal.length / 1024).toFixed(0) + 'KB');
    const biggest = tal.map((t) => ({ id: t.id, len: JSON.stringify(t).length })).sort((a, b) => b.len - a.len)[0];
    console.log('  最大单条 id=' + biggest.id + ' 长度=' + (biggest.len / 1024).toFixed(0) + 'KB');
    const one = tal.find((t) => t.id === biggest.id);
    if (one) console.log('  字段: ' + Object.keys(one).join(', ').slice(0, 200));
  }

  // 5) 孤儿账号（有账号无 token）
  const accounts = load('accounts');
  const token = load('tumblr_token');
  if (Array.isArray(accounts) && token) {
    const tokenIds = new Set(Object.keys(token));
    const tumblrAccs = accounts.filter((a) => String(a.platform || '').toLowerCase() === 'tumblr');
    const orphan = tumblrAccs.filter((a) => !tokenIds.has(String(a.id)));
    console.log('\n=== 孤儿账号 ===');
    console.log('  总账号=' + accounts.length + '  tumblr账号=' + tumblrAccs.length + '  token=' + tokenIds.size +
      '  缺token的tumblr账号=' + orphan.length);
  }
})();
