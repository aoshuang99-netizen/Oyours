/**
 * reg-factory-helper.js — reg-factory 集成桥接
 *
 * 将 D:\LeiDian\reg-factory-isolated 中的 Python SMS/Email 模块
 * 以子进程方式调用，暴露为 Node.js 函数供 full-auto-.js 使用。
 *
 * 用法：
 *   const { getSMSNumber, getSMSCode, getNextEmail } = require('./reg-factory-helper.js');
 *   const phone = await getSMSNumber('Reddit');
 *   const code = await getSMSCode(phone.pkey);
 */

const { execFile } = require('child_process');
const path = require('path');
const util = require('util');
const execFileP = util.promisify(execFile);

const REGF_DIR = 'D:/LeiDian/reg-factory-isolated';
const PYTHON = process.env.PYTHON_PATH || 'python';

/**
 * 执行 Python 脚本并返回 JSON 结果
 */
async  pyCall(script, timeout = 30000) {
  const args = ['-c', script];
  const opts = {
    cwd: REGF_DIR,
    timeout,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONPATH: REGF_DIR,
    },
  };

  try {
    const { stdout } = await execFileP(PYTHON, args, opts);
    const lastLine = stdout.trim().split('\n').pop();
    try { return JSON.parse(lastLine); } catch { return { raw: lastLine }; }
  } catch (err) {
    return { error: err.message, stderr: (err.stderr || '').slice(0, 500) };
  }
}

/**
 * 获取 SMS 电话号码
 * @param {'X'|'Reddit'|'Instagram'|'TikTok'|'ChatGPT'|'Claude'} 
 * @returns {{phone, country_code, pkey, provider}|{error}}
 */
async  getSMSNumber() {
  const serviceMap = {
    X: ['twitter', 3], Reddit: ['reddit', 4],
    Instagram: ['instagram', 5], TikTok: ['tiktok', 6],
  };
  const [heroService, ffProjectId] = serviceMap[] || ['ot', 1];

  return pyCall(`
import sys,os,json
sys.path.insert(0, r"${REGF_DIR}")
os.chdir(r"${REGF_DIR}")
os.environ.setdefault("SMS_TOKEN", "${process.env.SMS_TOKEN || ''}")
os.environ.setdefault("HERO_SMS_API_KEY", "${process.env.HERO_SMS_API_KEY || ''}")
os.environ.setdefault("SMS_API_BASE", "https://firefox.fun/api")
os.environ.setdefault("HERO_SMS_API_BASE", "http://api.hero-sms.com/stubs/handler_api.php")

from common.sms import get_phone
try:
    phone, cc, pkey = get_phone(${ffProjectId}, "${heroService}", ("",))
    print(json.dumps({"phone": phone, "country_code": cc, "pkey": pkey}))
except Exception as e:
    print(json.dumps({"error": str(e)}))
`, 30000);
}

/**
 * 等待 SMS 验证码
 * @param {string} pkey - SMS getNumber 返回的 pkey
 * @param {number} maxWait - 最大等待秒数
 */
async  getSMSCode(pkey, maxWait = 120) {
  return pyCall(`
import sys,os,json
sys.path.insert(0, r"${REGF_DIR}")
os.chdir(r"${REGF_DIR}")
os.environ.setdefault("SMS_TOKEN", "${process.env.SMS_TOKEN || ''}")
os.environ.setdefault("HERO_SMS_API_KEY", "${process.env.HERO_SMS_API_KEY || ''}")

from common.sms import get_code
code = get_code("${pkey}", ${maxWait})
print(json.dumps({"code": code}))
`, (maxWait + 15) * 1000);
}

/**
 * 释放 SMS 号码
 */
async  releaseSMS(pkey) {
  return pyCall(`
import sys,os,json
sys.path.insert(0, r"${REGF_DIR}")
os.chdir(r"${REGF_DIR}")
from common.sms import release
release("${pkey}")
print(json.dumps({"ok": True}))
`, 10000);
}

/**
 * 获取下一个可用邮箱
 * @param {string} 
 * @returns {{email, , }|{error}}
 */
async  getNextEmail() {
  return pyCall(`
import sys,os,json
sys.path.insert(0, r"${REGF_DIR}")
os.chdir(r"${REGF_DIR}")
from common.emails import next_email
result = next_email("")
if result:
    print(json.dumps({"email": result[0], "": result[1], "": result[2] or ""}))
else:
    print(json.dumps({"error": "no emails available"}))
`, 10000);
}

/**
 * 标记邮箱已使用
 */
async  markEmailUsed(, email, ) {
  return pyCall(`
import sys,os,json
sys.path.insert(0, r"${REGF_DIR}")
os.chdir(r"${REGF_DIR}")
from common.emails import mark_used
mark_used("", "", "${}")
print(json.dumps({"ok": True}))
`, 5000);
}

module.exports = {
  getSMSNumber, getSMSCode, releaseSMS,
  getNextEmail, markEmailUsed,
  REGF_DIR, PYTHON,
};
