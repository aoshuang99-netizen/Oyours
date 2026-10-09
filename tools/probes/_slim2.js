const fs = require('fs');
const path = require('path');

const DIR = 'D:\\mscms-ws\\data2';
const FILE = path.join(DIR, 'tumblr_action_log.json');

const LOGS_MAX = Number(process.env.TUMBLR_LOG_MAX || 120);
const LOGS_KEEP_DAYS = Number(process.env.TUMBLR_LOG_KEEP_DAYS || 7);
const cutoff = Date.now() - LOGS_KEEP_DAYS * 86400000;

const before = fs.statSync(FILE).size;
const arr = JSON.parse(fs.readFileSync(FILE, 'utf8'));
console.log('tumblr_action_log: ' + (before / 1048576).toFixed(2) + ' MB, 账号数=' + arr.length);

let trimmed = 0;
let droppedTotal = 0;
for (const rec of arr) {
  if (!Array.isArray(rec.logs)) continue;
  const n0 = rec.logs.length;
  let logs = rec.logs.filter((l) => {
    const t = Date.parse(l.ts || 0);
    return Number.isNaN(t) || t >= cutoff;
  });
  if (logs.length > LOGS_MAX) logs = logs.slice(-LOGS_MAX);
  if (logs.length !== n0) { trimmed++; droppedTotal += (n0 - logs.length); }
  rec.logs = logs;
}

fs.writeFileSync(FILE, JSON.stringify(arr), 'utf8');
const after = fs.statSync(FILE).size;
console.log('裁剪账号数=' + trimmed + ' 丢弃日志条数=' + droppedTotal);
console.log('体积: ' + (before / 1048576).toFixed(2) + ' MB -> ' + (after / 1048576).toFixed(2) + ' MB');
