// 监视 data/.json 的变化，记录每次改动的时间与条目数
const fs = require('fs');
const path = require('path');
const f = path.join(__dirname, 'data', '.json');
const log = path.join(__dirname, '_watch.log');
 count() {
  try { const a = JSON.parse(fs.readFileSync(f, 'utf8')); return Array.isArray(a) ? a.length : 'non-array'; }
  catch (e) { return 'ERR:' + e.message; }
}
fs.writeFileSync(log, `start count=${count()} @ ${new Date().toISOString()}\n`);
try {
  const w = fs.watch(f, () => {
    fs.appendFileSync(log, `CHANGE count=${count()} @ ${new Date().toISOString()}\n`);
  });
  setTimeout(() => { w.close(); fs.appendFileSync(log, `end count=${count()} @ ${new Date().toISOString()}\n`); process.exit(0); }, 20000);
} catch (e) {
  fs.appendFileSync(log, `watch-error: ${e.message}\n`);
  process.exit(1);
}
