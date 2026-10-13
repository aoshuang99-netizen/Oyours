// _key_affinity_audit.js —— 只读诊断：账号↔consumerKey 亲和性 + 今日发布分布在两个 key 上的分布
// 用途：为「key 分流」决策提供事实依据。不写任何文件，不改任何状态。
const fs = require('fs');
const path = require('path');

const DATA = process.env.MSCMS_DATA_DIR || 'D:/mscms-ws/data';
const R = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));

const apps = JSON.parse(fs.readFileSync(path.join(__dirname, 'tumblr_apps.json'), 'utf8'));
const K = apps.map((a) => ({ label: a.label, key: a.consumerKey }));
const keyName = (k) => {
  const i = K.findIndex((x) => x.key === k);
  return i < 0 ? '(unknown ' + String(k || '').slice(0, 8) + ')' : `key[${i}] ${K[i].label}`;
};

const cfgArr = R('tumblr_config.json');
const cfg = new Map();
cfgArr.forEach((c) => cfg.set(c.id, c));

const token = R('tumblr_token.json');
const tokenIds = Object.keys(token);
const okToken = tokenIds.filter((id) => {
  const t = token[id] || {};
  return t.oauthToken && t.oauthTokenSecret && t.blogName;
});

const accounts = R('accounts.json');
const accArr = Array.isArray(accounts) ? accounts : (accounts.items || []);
const activeIds = accArr.filter((a) => a && a.status === 'active').map((a) => a.id);

console.log('=== 1. 账号面 ===');
console.log('accounts 总数 =', accArr.length, ' active =', activeIds.length);
console.log('token 总数 =', tokenIds.length, ' 可发布(含 blogName) =', okToken.length);
console.log('tumblr_config 条数 =', cfgArr.length, '（含 main）');

console.log('\n=== 2. 可发布账号的 key 亲和性 ===');
let viaOwn = 0, viaMain = 0, noCfg = 0;
const bucket = {};
const missing = [];
for (const id of okToken) {
  const own = cfg.get(id);
  let key, src;
  if (own && own.consumerKey) { key = own.consumerKey; src = 'own'; viaOwn++; }
  else {
    const m = cfg.get('main');
    key = m && m.consumerKey; src = 'main兜底'; viaMain++;
    if (!own) { noCfg++; missing.push(id); }
  }
  const kn = keyName(key);
  bucket[kn] = bucket[kn] || { own: 0, mainFb: 0, total: 0 };
  bucket[kn].total++;
  if (src === 'own') bucket[kn].own++; else bucket[kn].mainFb++;
}
Object.entries(bucket).sort().forEach(([k, v]) => {
  console.log(`  ${k}: 共 ${v.total} 个可发布账号（自有 config ${v.own} / 兜底 main ${v.mainFb}）`);
});
console.log('  有自有 config =', viaOwn, ' 无 config 走 main 兜底 =', viaMain);
if (missing.length) console.log('  无 config 的账号(前 10):', missing.slice(0, 10).join(','));

console.log('\n=== 3. 今日发布分布（publish.json 中 ts >= 今日 00:00 GMT+8）===');
const now = Date.now();
const dayStartUtc8 = new Date(new Date(Date.parse('2026-10-13T00:00:00+08:00')).getTime()).getTime();
const pub = R('publish.json');
const items = Array.isArray(pub) ? pub : (pub.items || []);
const tsOf = (p) => {
  const m = String(p.id || '').match(/pub_(\d{10,})_/);
  if (m) return Number(m[1]);
  const t = p.createdAt || p.created_at || p.published_at;
  return t ? Date.parse(t) : 0;
};
const today = items.filter((p) => tsOf(p) >= dayStartUtc8);
const byAcct = {};
today.forEach((p) => { const a = p.account_id || p.accountId || '?'; byAcct[a] = (byAcct[a] || 0) + 1; });
const acctKeyDist = {};
Object.entries(byAcct).forEach(([a, n]) => {
  const own = cfg.get(a);
  const key = (own && own.consumerKey) || (cfg.get('main') || {}).consumerKey;
  const kn = keyName(key);
  acctKeyDist[kn] = (acctKeyDist[kn] || 0) + n;
});
console.log('  今日 publish 条目 =', today.length, '/ 全量', items.length);
console.log('  按账号所属 key 汇总发布量:');
Object.entries(acctKeyDist).forEach(([k, n]) => console.log(`    ${k}: ${n} 条`));
const top = Object.entries(byAcct).sort((a, b) => b[1] - a[1]).slice(0, 8);
console.log('  发布量 TOP8 账号:');
top.forEach(([a, n]) => {
  const own = cfg.get(a);
  const key = (own && own.consumerKey) || (cfg.get('main') || {}).consumerKey;
  console.log(`    ${a}: ${n} 条  → ${keyName(key)}`);
});

console.log('\n=== 4. 汇总判据 ===');
const allAccKeys = {};
okToken.forEach((id) => {
  const own = cfg.get(id);
  const key = (own && own.consumerKey) || (cfg.get('main') || {}).consumerKey;
  allAccKeys[keyName(key)] = (allAccKeys[keyName(key)] || 0) + 1;
});
console.log('  可发布账号 key 分布:', JSON.stringify(allAccKeys, null, 1));
console.log('  ⚠️ 无 config 的账号会全部压到 main(=key[0])：', viaMain, ' 个');
