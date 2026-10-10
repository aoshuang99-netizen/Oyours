// 清理 data/accounts.json 中的假账户（与 /api/v14/real-accounts 的 isReal 逻辑完全一致）
// 仅保留 isReal === true 的账户，其余删除。操作前自动备份原文件。
const fs = require('fs');
const path = require('path');

const ACC = path.join(__dirname, 'data', 'accounts.json');
const TOK = path.join(__dirname, 'data', 'tumblr_token.json');

const FAKE_EMAIL = /@mscms\.mail$/i;
const TEMP_EMAIL = /guerrillamail|guerrillamailblock|mailinator|10minutemail|tempmail|throwaway|dispostable|trashmail|temp-mail|fake|sharklasers|getnada|yopmail/i;

function loadTokenIds() {
  try {
    const arr = JSON.parse(fs.readFileSync(TOK, 'utf8'));
    const ids = new Set();
    for (const t of arr) if (t && (t.id || t.oauthToken)) ids.add(t.id);
    return ids;
  } catch (e) { return new Set(); }
}

function isReal(a, tokenIds) {
  const hasCreds = !!(a.email && a.password);
  const hasApiToken = tokenIds.has(a.id);
  const suspiciousEmail = FAKE_EMAIL.test(a.email || '') || TEMP_EMAIL.test(a.email || '');
  return (hasCreds && !suspiciousEmail) || (a.platform === 'tumblr' && hasApiToken);
}

function ts() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

(async () => {
  const tokenIds = loadTokenIds();
  const accounts = JSON.parse(fs.readFileSync(ACC, 'utf8'));
  console.log('清理前总数 =', accounts.length, ' tokenIds =', tokenIds.size);

  const kept = [], removed = [];
  for (const a of accounts) (isReal(a, tokenIds) ? kept : removed).push(a);

  // 备份
  const bak = path.join(__dirname, 'data', `accounts.json.bak_${ts()}`);
  fs.writeFileSync(bak, JSON.stringify(accounts, null, 2));
  console.log('已备份原文件 ->', bak);

  // 统计被删的按平台
  const byPlat = {};
  for (const r of removed) {
    const k = (r.platform || '-') + (FAKE_EMAIL.test(r.email||'') ? '[mscms.mail]' : TEMP_EMAIL.test(r.email||'') ? '[temp]' : (r.email ? '[other]' : '[no-email]'));
    byPlat[k] = (byPlat[k] || 0) + 1;
  }
  console.log('\n=== 将被删除 (假) 账户 =', removed.length, '===');
  for (const k of Object.keys(byPlat).sort()) console.log(`  ${k}: ${byPlat[k]}`);
  console.log('\n=== 将保留 (真实) 账户 =', kept.length, '===');
  for (const a of kept) console.log(`  ${a.id} | ${a.platform} | ${a.username} | ${a.email || '(无邮箱)'}`);

  fs.writeFileSync(ACC, JSON.stringify(kept, null, 2));
  console.log('\n已写入干净 accounts.json (保留', kept.length, ', 删除', removed.length, ')');
})();
