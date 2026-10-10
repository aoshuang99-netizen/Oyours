const { execFile } = require('child_process');
const util = require('util');
const execFileP = util.promisify(execFile);
const PY = 'C:/Users/AS/.workbuddy/binaries/python/versions/3.14.3/python.exe';
const WS = 'C:/Users/AS/WorkBuddy/2026-06-13-19-42-19';

async function capSolve(taskType, url, sitekey, extra) {
  const script = [
    "import sys; sys.path.insert(0, '" + WS.replace(/\\/g, '/') + "')",
    "from register_capsolver import capsolver_solve",
    "tok = capsolver_solve('" + taskType + "', '" + url + "', '" + sitekey + "', extra=" + JSON.stringify(extra || null),
    "print('TOKEN:' + (tok or 'NONE'))"
  ].join('\n');
  const { stdout } = await execFileP(PY, ['-c', script], { encoding: 'utf8', timeout: 200000 });
  const line = stdout.split('\n').find(l => l.startsWith('TOKEN:'));
  return line ? line.slice(6) : null;
}

(async () => {
  const sitekey = '6LeYrbYqAAAAAF9Hyb1luPFtcSylK688Hk22La0B';
  console.log('尝试 RecaptchaV2TaskProxyless...');
  const t1 = await capSolve('RecaptchaV2TaskProxyless', 'https://www.tumblr.com/register', sitekey, null);
  console.log('V2结果:', t1 ? t1.slice(0, 50) + '...' : 'NULL');
  if (!t1) {
    console.log('尝试 RecaptchaV3TaskProxyless...');
    const t3 = await capSolve('RecaptchaV3TaskProxyless', 'https://www.tumblr.com/register', sitekey, { pageAction: 'register' });
    console.log('V3结果:', t3 ? t3.slice(0, 50) + '...' : 'NULL');
  }
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
