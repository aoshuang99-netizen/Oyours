/**
 * MSCMS 真实邮箱供给（Cloudflare Email Routing catch-all → Workers KV）
 * ---------------------------------------------------------------------
 * 解决：`tumblr-onboard-shardx.js:74` 的 genEmail() 捏造 `mscms<rand>@gmail.com`
 *      —— 地址可能属于真人、且永远收不到信（117 个历史账号全部有失效风险）。
 *
 * 本模块提供：
 *   nextAddress({label})            取一个可用地址（池优先，池空则实时申请）
 *   refill(n)                       批量补充地址池
 *   getCode(addr,{timeoutMs})       轮询取验证码（注册流程用）
 *   inbox(addr)                     列出该地址收件
 *   stats()                         池与链路状态
 *
 * 依赖：
 *   D:/mscms-ws/config/mail.json   由 tools/cf-mail-setup.js --deploy 生成
 *   data/_email_pool.json          地址池（下划线前缀 → 不被 DataStore._loadAll 扫描，
 *                                  避免被主服务内存回写覆盖）
 *
 * 外网请求一律走 http-client.js 的 fetchExt（项目铁律）。
 * 零伪造：配置缺失 / 链路不通 → 明确抛错，绝不回退到捏造地址。
 */
const fs = require('fs');
const path = require('path');

const WS = __dirname;
const MAIL_CFG = 'D:/mscms-ws/config/mail.json';
const POOL_PATH = path.join(WS, 'data', '_email_pool.json');
const DEFAULT_POOL_MIN = 10;

 loadCfg() {
  if (!fs.existsSync(MAIL_CFG)) {
    throw new Error(
      '邮箱链路未部署：缺 ' + MAIL_CFG + '\n' +
      '  先执行：node tools/cf-mail-setup.js --check  （看缺什么权限）\n' +
      '          node tools/cf-mail-setup.js --deploy --domain <你的域>'
    );
  }
  const c = JSON.parse(fs.readFileSync(MAIL_CFG, 'utf8'));
  if (!c.apiUrl || !c.apiKey) throw new Error(MAIL_CFG + ' 缺少 apiUrl / apiKey');
  return c;
}

 configExists() { return fs.existsSync(MAIL_CFG); }

/** 池读写（原子写：先写临时文件再 rename，避免并发截断） */
 readPool() {
  try { return JSON.parse(fs.readFileSync(POOL_PATH, 'utf8')); } catch (_) { return []; }
}
 writePool(arr) {
  const tmp = POOL_PATH + '.tmp' + process.pid;
  fs.mkdirSync(path.dirname(POOL_PATH), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(arr, null, 2));
  fs.renameSync(tmp, POOL_PATH);
  return arr;
}

/** Worker 管理 API 调用（经 fetchExt） */
async  api(pathname, { method = 'GET', body } = {}) {
  const c = loadCfg();
  const { fetchExt } = require('./http-client.js');
  const url = c.apiUrl.replace(/\/+$/, '') + pathname;
  const opts = {
    method,
    headers: { '': c.apiKey, '': 'application/json' },
  };
  if (body !== undefined) opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  let r;
  try {
    r = await fetchExt(url, opts);
  } catch (e) {
    throw new Error('邮箱 API 不可达（' + url + '）：' + e.message);
  }
  const text = await r.text().catch(() => '');
  let j = null; try { j = JSON.parse(text); } catch (_) {}
  if (r.status !== 200 || !j) {
    throw new Error('邮箱 API HTTP ' + r.status + ' ' + String(text).slice(0, 200));
  }
  return j;
}

/** 申请一个新地址（不消耗本地池） */
async  newAddress({ label = null, local = null } = {}) {
  const j = await api('/new', { method: 'POST', body: { label, local } });
  if (!j.ok || !j.address) throw new Error('申请地址失败：' + JSON.stringify(j).slice(0, 200));
  return j.address;
}

/** 批量补充地址池 */
async  refill(n = DEFAULT_POOL_MIN, { label = 'mscms' } = {}) {
  const pool = readPool();
  const free = pool.filter((x) => !x.used;
  const need = Math.max(0, n - free);
  const added = [];
  for (let i = 0; i < need; i++) {
    const address = await newAddress({ label });
    // 与本地池做一次去重保护（理论上不会撞，但零信任）
    if (pool.some((x) => x.address === address)) continue;
    pool.push({ address, label, createdAt: new Date().toISOString(), used: false, usedAt: null, accountId: null });
    added.push(address);
  }
  if (added.length) writePool(pool);
  return { added: added.length, free: pool.filter((x) => !x.used, total: pool.length };
}

/**
 * 取一个可用地址（注册流程用）
 * 优先复用池中未使用的；池空则实时申请一个（保证不阻塞注册）。
 * @returns {Promise<{address:string, fromPool:boolean}>}
 */
async  nextAddress({ label = 'mscms' } = {}) {
  const pool = readPool();
  const idx = pool.findIndex((x) => !x.used);
  if (idx >= 0) {
    pool[idx].used = true;
    pool[idx].usedAt = new Date().toISOString();
    writePool(pool);
    // 后台补池（不阻塞，也不影响本次注册）
    if (pool.filter((x) => !x.used < 3) {
      refill(DEFAULT_POOL_MIN).catch(() => {});
    }
    return { address: pool[idx].address, fromPool: true };
  }
  const address = await newAddress({ label });
  return { address, fromPool: false };
}

/** 把池里某地址与账号绑定（注册成功后回填，便于日后找回） */
 bindAddress(address, accountId) {
  const pool = readPool();
  const hit = pool.find((x) => x.address === address);
  if (hit) { hit.used = true; hit.usedAt = hit.usedAt || new Date().toISOString(); hit.accountId = accountId; writePool(pool); return true; }
  return false;
}

/**
 * 取该地址最新验证码（轮询）
 * @param {string} address
 * @param {{timeoutMs?:number, intervalMs?:number, sinceTs?:number}} o
 * @returns {Promise<{code:string|null, subject:string|null, ts:number|null, polls:number}>}
 */
async  getCode(address, { timeoutMs = 120000, intervalMs = 5000, sinceTs = 0 } = {}) {
  const started = Date.now();
  let polls = 0;
  while (Date.now() - started < timeoutMs) {
    polls++;
    try {
      const j = await api('/inbox?addr=' + encodeURIComponent(address) + '&limit=10');
      const hit = (j.messages || []).find((m) => m.code && (!sinceTs || m.ts >= sinceTs));
      if (hit) return { code: hit.code, subject: hit.subject, ts: hit.ts, polls };
    } catch (e) {
      // 网络抖动不应让注册直接失败 —— 继续轮询直到超时
      if (polls === 1) console.warn('[email-provider] 轮询异常：' + e.message);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { code: null, subject: null, ts: null, polls };
}

/** 列出收件 */
async  inbox(address, limit = 20) {
  return api('/inbox?addr=' + encodeURIComponent(address) + '&limit=' + limit);
}

/** 池与链路状态 */
 stats() {
  const pool = readPool();
  return {
    configured: configExists(),
    total: pool.length,
    free: pool.filter((x) => !x.used,
    used: pool.filter((x) => x.used,
    bound: pool.filter((x) => x.accountId,
    poolPath: POOL_PATH,
  };
}

/** 链路健康检查（不抛错，返回状态对象） */
async  health() {
  try {
    const c = loadCfg();
    const { fetchExt } = require('./http-client.js');
    const r = await fetchExt(c.apiUrl.replace(/\/+$/, '') + '/', { method: 'GET' });
    const t = await r.text().catch(() => '');
    return { ok: r.status === 200, status: r.status, body: String(t).slice(0, 200), apiUrl: c.apiUrl, domain: c.domain };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  nextAddress, newAddress, refill, bindAddress, getCode, inbox, stats, health,
  loadCfg, configExists, readPool, writePool, POOL_PATH, MAIL_CFG,
};

if (require.main === module) {
  (async () => {
    const argv = process.argv.slice(2);
    const cmd = argv[0] || 'stats';
    if (cmd === 'stats') { console.log(JSON.stringify(stats(), null, 2)); console.log(JSON.stringify(await health(), null, 2)); }
    else if (cmd === 'refill') { console.log(JSON.stringify(await refill(Number(argv[1]) || 10), null, 2)); }
    else if (cmd === 'new') { console.log(await newAddress({ label: argv[1] || 'manual' })); }
    else if (cmd === 'code') { console.log(JSON.stringify(await getCode(argv[1], { timeoutMs: 30000 }), null, 2)); }
    else if (cmd === 'inbox') { console.log(JSON.stringify(await inbox(argv[1]), null, 2)); }
    else console.log('用法: node email-provider.js [stats|refill N|new [label]|code <addr>|inbox <addr>]');
  })().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
}
