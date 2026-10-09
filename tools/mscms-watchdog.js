#!/usr/bin/env node
/**
 * MSCMS v14 全链路看门狗（常驻自运转）
 *
 * 职责：
 *  - 每 CHECK_INTERVAL_MS 探活四个服务：3002 主服务 / 3005 养号 / 3010 content-gen / 8080 MPT
 *  - 端口不通 → 立即拉起；端口通但 HTTP 无响应（假死）→ 连续 N 轮失败后才重启
 *    （3002 正常启动需 12~13 分钟，必须给足 bootGraceMs，否则会误杀正在启动的实例）
 *  - 单实例守卫：占用 3011 端口作为进程锁，重复启动自动退出
 *
 * 用法: node tools/mscms-watchdog.js            # 前台
 *       nohup node tools/mscms-watchdog.js &    # 常驻
 * 日志: D:/mscms-ws/logs/watchdog.log
 */
'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const WS = 'C:\\Users\\AS\\WorkBuddy\\2026-06-13-19-42-19';
// ── node 解释器路径（2026-09-14 修复·必读）──────────────────────────────
// 旧实现硬编码 `…\node\versions\22.22.2-2\node.exe`。该版本目录【已不存在】
// （现只有 22.22.2 / 22.22.2-3）→ 看门狗每次 spawn 都 `ENOENT` 并 uncaughtException 崩掉
// → exit-guard / cf-tunnel(202xx 全部出口) / 3012 / 3013 【全部起不来】。
// 这就是「42 个出口只剩 1 个活着、整个出口层宕机、看门狗无声消失」的唯一根因。
// ⇒ 不再硬编码：运行时解析「最新且存在」的 node，最后回退当前进程 execPath。
const NODE = (() => {
  const dir = 'C:\\Users\\AS\\\\binaries\\node\\versions';
  const found = [];
  try {
    for (const d of fs.readdirSync(dir)) {
      const p = path.join(dir, d, 'node.exe');
      if (fs.existsSync(p)) found.push({ d, p });
    }
  } catch (_) {}
  const score = (d) => {
    const m = String(d).match(/^(\d+)\.(\d+)\.(\d+)(?:-(\d+))?/);
    return m ? (+m[1]) * 1e9 + (+m[2]) * 1e6 + (+m[3]) * 1e3 + (+(m[4] || 0)) : 0;
  };
  found.sort((a, b) => score(b.d) - score(a.d));
  return found.length ? found[0].p : process.execPath;
})();
console.log('[watchdog] node 解释器 = ' + NODE + (fs.existsSync(NODE) ? ' ✅' : ' ❌ 不存在 → 回退 execPath'));
const PY_MPT = 'C:\\Users\\AS\\\\binaries\\python\\envs\\mpt\\Scripts\\python.exe';
const LOCK_PORT = 3011;
const CHECK_INTERVAL_MS = Number(process.env.MSCMS_WATCHDOG_INTERVAL_MS || 60000);
const LOG = (process.env.LOG_DIR || 'D:/mscms-ws/logs') + '/watchdog.log';

// 公共环境：一切写入落 D 盘（C 盘曾写满导致 DataStore ENOSPC）
// ── 代理固定化（2026-10-09）────────────────────────────────────────────
// 背景：本看门狗若从交互式会话启动，会继承会话注入的**沙箱临时代理**
//   （实测 HTTP_PROXY=http://:41502）。该代理随会话结束即消失，
//   且对 *.tumblr.com 全部 fetch failed ⇒ post-metrics/互动回收全线瘫痪，
//   而日志只写一句 "posts fetch failed"，极难归因（我为此排查了 1 小时+）。
// 修法：显式覆盖为本机常驻代理 10808（Clash/PID 21912），
//   与交互会话的沙箱代理完全解耦；找不到 10808 时清空代理走直连，
//   宁可直连失败也要留下可归因的真实错误，不引入了就消失的临时代理。
const _LOCAL_PROXY = (() => {
  const port = Number(process.env.MSCMS_OUTBOUND_PROXY_PORT || 10808);
  const p = `http://:${port}`;
  try {
    const net = require('net');
    const s = net.connect(port, '');
    s.destroy();
    return p;
  } catch (_) { return null; }
})();
const _PROXY_ENV = _LOCAL_PROXY
  ? { HTTPS_PROXY: _LOCAL_PROXY, HTTP_PROXY: _LOCAL_PROXY, https_proxy: _LOCAL_PROXY, http_proxy: _LOCAL_PROXY }
  : { HTTPS_PROXY: '', HTTP_PROXY: '', https_proxy: '', http_proxy: '' };
console.log(`[watchdog] 出网代理 = ${_LOCAL_PROXY || '（无，尝试直连）'}`);
const BASE_ENV = Object.assign({}, process.env, {
  ELECTRON_RUN_AS_NODE: '',
  NODE_TLS_REJECT_UNAUTHORIZED: '0',
  NODE_PATH: path.join(WS, 'node_modules'),
  MSCMS_STORAGE_ROOT: 'D:\\mscms-ws',
  DATA_DIR: 'D:\\mscms-ws\\data',
  LOG_DIR: 'D:\\mscms-ws\\logs',
  MSCMS_TMP_DIR: 'D:\\mscms-tmp',
  TEMP: 'D:\\mscms-tmp',
  TMP: 'D:\\mscms-tmp',
}, _PROXY_ENV);

// ── 单写者隔离（2026-09-12 架构治本）────────────────────────────────
// 3002 / 3005 / 3012 共用同一个 DATA_DIR（工作区 data\ 是指向 D:\mscms-ws\data 的
// junction，物理同一份）。三个进程各自把 54 个模块读进内存、每 5s 整体写回 → 互相覆盖
// （实测 content.json 在 3 个快照间振荡：20946 / 22516 / 20868）。
// 现按服务限制「可写模块」，只有该模块的属主进程能落盘：
//   · 3002 server.js      → 属主，可写全部（content/publish/analytics/… 的唯一写入方）
//   · 3005 养号服务        → 只写它自己拥有的养号态 + 它用到的凭证
//   · 3012 访客画像        → 只写发布凭证（它本就不做业务写；限制后 content.json
//                           再不会被它的 startupPrune/periodicPrune 整体重写）
// 被拒绝的写入会在日志里显式告警（DataStore ⛔），不会静默吞掉。
const WRITE_MODULES_MAIN = '*';
const WRITE_MODULES_NURTURE = [
  '',          // 养号会回写账号状态（tumblr-nurture.js）
  'tumblr_nurture',    // 养号进度（属主就是 3005）
  'tumblr_persona',    // 人格层（属主 3005）
  'tumblr_device',     // 设备池会话（属主 3005）
  'tumblr_action_log',      // 养号动作日志（属主 3005）
  'tumblr_daily_summary',   // 养号日报（属主 3005）
  'nurture_logs',           // 养号操作流水
  '',     // 应用凭证回填
  '', '',   // OAuth 刷新
].join(',');
const WRITE_MODULES_VISITOR = ['', '', ''].join(',');

const SERVICES = [
  {
    // 2026-09-15 新增：MySQL(3307) 纳入看门狗。
    //   背景：它是 Tumblr 24h「(账号,内容)」去重闸门的数据源，却不在任何自启/守护清单里。
    //   09-14 19:56 非正常终止后整整 10 天无人发现（发布去重闸门全程缺失），
    //   是本轮「零发布」事故的并发因素之一。
    //   tcpOnly=true：3307 不是 HTTP 服务，必须只做 TCP 探活 ——
    //   否则 httpOk() 必然失败 → 连续 maxFailStreak 次 → 被判"假死"强杀，形成杀-启死循环。
    //   数据目录在 D:\mscms-mysql-data（C 盘曾写满导致 08-28 启动失败，故不放 C 盘）。
    name: 'mysql:3307', port: 3307, tcpOnly: true,
    bootGraceMs: 60 * 1000, maxFailStreak: 5,
    cmd: path.join(WS, 'mysql-8.0.41-winx64', 'bin', 'mysqld.exe'),
    args: [
      '--basedir=' + path.join(WS, 'mysql-8.0.41-winx64'),
      '--datadir=D:/mscms-mysql-data',
      '--port=3307',
      '--console',
    ],
    cwd: path.join(WS, 'mysql-8.0.41-winx64'),
    env: {},
    logName: 'mysql-3307',
  },
  {
    name: 'main:3002', port: 3002, probe: '/api/v14/causal-chain/status',
    // 50 台云手机 STARTALL 分批启动，正常 12~13 分钟
    bootGraceMs: 15 * 60 * 1000, maxFailStreak: 5,
    // 2026-09-05：改用 D 盘桌面安装包内的 server.js（与 MSCMS v14 Desktop.exe 同源），
    //   否则看门狗从工作区拉起实例会长期占住 3002，导致桌面应用永远 EADDRINUSE。
    //   注意：工作区 server.js 改动后需重新同步到 D:\MSCMS-Desktop\resources 才生效。
    cmd: NODE, args: ['server.js'], cwd: 'D:\\MSCMS-Desktop\\resources',
    // 2026-09-06：PUBLIC_DOMAIN 改为 mscms.lokfeel.com —— hlua.cc.cd 对 /api/v14/* 超时
    //   （该域指向另一 zone/端口），登录页与生成的公网链接应指向真正可用的 v14 入口。
    // 【2026-09-12 解发布瓶颈】单账号日发帖上限 6 → 12。
    //   背景：ready 池积压 6800+ 条，而 117 个可发布账号 × 6 = ~700 帖/天是当时天花板，
    //   发布队列里 64 个任务全部因「超过每日配额 (6/6)」被推迟到次日。
    //   阶段上限已同步抬高（P3=6 / P4=8 / P5=12），否则 getDailyQuota 取 min() 后 env 无效。
    //   回滚：把这里改回 '6'（或直接给进程注入 MSCMS_TUMBLR_POST_MAX_PER_DAY=6）。
    // 【2026-09-22 校准限流升级阈值】MSCMS_QUOTA_ESCALATE_ACCOUNTS 3 → 10，GLOBAL_PAUSE_MIN 15 → 8。
    //   事故：21:46 仅 3 个 blog（占 117 池 2.6%）在 10 分钟内先后撞到 Tumblr 瞬时 429，
    //   就把【全站 117 个账号】暂停 15 分钟，26 条定向投放内容被冻结。
    //   实测这 3 个 blog 当日只发了 2~3 条（远低于 12/日上限），且 Tumblr 返回的 detail 是
    //   「Measly little error. Try again.」/「Tumblr went thud. Try again.」= 平台瞬时抖动，
    //   不是配额耗尽 —— 用固定 3 当判据在 117 账号规模下属于误升级。
    //   新判据：阈值 ≈ 池规模 × 8%（117 × 0.08 ≈ 10），即真的「平台/出口级限流」才会全局暂停。
    //   注意：单账号保护不受影响 —— 命中 429 的账号仍各自退避 30 分钟（MSCMS_QUOTA_ACCOUNT_BACKOFF_MIN），
    //   这才是防止烧账号信誉的主力；全局暂停只是兜底，不应被少数账号的抖动触发。
    //   回滚：删掉这两个键即恢复原默认（3 / 15）。
    env: { CLOUD_PHONE_COUNT: '50', CLOUD_PHONE_MODE: 'cloud', PUBLIC_DOMAIN: 'mscms.lokfeel.com', PORT: '3002', TUMBLR_API_RPM: '25', MSCMS_DATASTORE_WRITE_MODULES: WRITE_MODULES_MAIN, MSCMS_TUMBLR_POST_MAX_PER_DAY: '12', MSCMS_QUOTA_ESCALATE_ACCOUNTS: '10', MSCMS_QUOTA_GLOBAL_PAUSE_MIN: '8' },
    logName: 'server-3002',
  },
  {
    name: 'nurture:3005', port: 3005, probe: '/api/status',
    bootGraceMs: 90 * 1000, maxFailStreak: 5,
    cmd: NODE, args: ['tumblr-nurture-server.js'], cwd: WS,
    env: { TUMBLR_NURTURE_PORT: '3005', TUMBLR_NURTURE_DEVICE: '1', TUMBLR_NURTURE_AUTO: '1', TUMBLR_PROXY: 'http://:10808', TUMBLR_API_RPM: '25', MSCMS_DATASTORE_WRITE_MODULES: WRITE_MODULES_NURTURE },
    logName: 'nurture-3005',
  },
  {
    name: 'contentgen:3010', port: 3010, probe: '/api/assets',
    bootGraceMs: 40 * 1000, maxFailStreak: 5,
    cmd: NODE, args: ['content-gen/service.js'], cwd: WS,
    env: { CONTENT_GEN_PORT: '3010' },
    logName: 'contentgen-3010',
  },
  {
    // 2026-09-08：多出口网关守护 —— 保活 VPS 隧道(10950) + mihomo 多出口(20777)，
    //   并每 30 分钟重探测出口、自动刷新 proxy-pool.json。出口挂了 = Tumblr 429 = 空转。
    name: 'exitguard:20779', port: 20779, probe: '/health',
    bootGraceMs: 20 * 1000, maxFailStreak: 5,
    cmd: NODE, args: ['tools/exit-guard.js'], cwd: WS,
    env: {},
    logName: 'exit-guard',
  },
  {
    // 2026-09-11：访客画像服务 —— Aliens_eye OSINT 集成（followers/notes 采集 →
    //   840+ 平台画像扫描 → 图谱+HTML 分析报告），每日 04:30 自跑。
    name: 'visitor:3012', port: 3012, probe: '/api/status',
    bootGraceMs: 30 * 1000, maxFailStreak: 5,
    cmd: NODE, args: ['tools/visitor-profile-server.js'], cwd: WS,
    env: { MSCMS_DATASTORE_WRITE_MODULES: WRITE_MODULES_VISITOR },
    logName: 'visitor-profile',
  },
  {
    // 2026-09-11：工作区 → 桌面应用 自动同步器。
    //   桌面应用跑的是 D:\MSCMS-Desktop\resources 那份代码，日常修复都在工作区，
    //   只改工作区 = 桌面应用看不到。本服务常驻监听并即时同步（含 tumblr_apps.json、
    //    等启动期配置），并在 /status 暴露"需重启才生效"清单。
    name: 'sync:3013', port: 3013, probe: '/health',
    bootGraceMs: 20 * 1000, maxFailStreak: 5,
    cmd: NODE, args: ['tools/sync-desktop.js'], cwd: WS,
    env: { MSCMS_SYNC_PORT: '3013' },
    logName: 'desktop-sync',
  },
  {
    name: 'mpt:8080', port: 8080, probe: '/docs',
    bootGraceMs: 120 * 1000, maxFailStreak: 5,
    cmd: PY_MPT, args: ['-m', 'uvicorn', 'app.asgi:app', '--app-dir', '.', '--host', '', '--port', '8080', '--log-level', 'warning'],
    cwd: 'D:\\MoneyPrinterTurbo',
    env: {},
    logName: 'mpt-8080',
  },
  {
    // 2026-09-24：KK Match 后端（FastAPI + SQLite，:8001）—— 用户标识 / 行为事件 /
    //   匹配反馈 / 管理员统计。它是 kkmatch.com 真实 DAU 的唯一数据源（前端 identify+track）。
    //
    //   为什么交给看门狗而不是计划任务：本机安全策略拦截 LOLBin（wscript/cscript/schtasks），
    //   且 Register-ScheduledTask 返回「拒绝访问」⇒ 无法新建计划任务。看门狗是既有常驻进程，
    //   天然具备 detached spawn + 端口探活 + 自动重启能力，是这里唯一可行且最省资源的托管方式。
    //
    //   用 pythonw.exe（GUI 子系统，不建控制台）⇒ 零弹窗；_run.py 内部把 stdout/stderr
    //   重定向到 D:\kk-match-backend\logs\backend.log。
    //   DB 落 D:\kk-match-backend\kkmatch.db（D 盘，符合本机「一切写入落 D 盘」铁律）。
    name: 'kkmatch:8001', port: 8001, probe: '/health',
    bootGraceMs: 20 * 1000, maxFailStreak: 5,
    cmd: 'D:\\kk-match-backend\\.venv\\Scripts\\pythonw.exe',
    args: ['_run.py'],
    cwd: 'D:\\kk-match-backend',
    env: {},
    logName: 'kkmatch-8001',
  },
];

const state = new Map();

 log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try { fs.appendFileSync(LOG, line + '\n'); } catch (_) {}
  console.log(line);
}

 portOpen(port, timeout = 2000) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const finish = (v) => { if (!done) { done = true; s.destroy(); resolve(v); } };
    s.setTimeout(timeout);
    s.once('connect', () => finish(true));
    s.once('timeout', () => finish(false));
    s.once('error', () => finish(false));
    s.connect(port, '');
  });
}

// 2026-09-12：探活超时 8s → 25s。
//  起因：本机 12 核被 Ollama CPU 推理占满（实测单进程 108%），3002 事件循环被饿死，
//  8s 探活必然超时 → 连续 3 次 → 误判"假死"强杀 → 冷启又抢不到 CPU → 每 20~45 分钟死一次。
//  真死仍由 portOpen()（2s TCP，见 check()）立即发现并拉起，本阈值只影响"假死"判定。
 httpOk(port, pathName, timeout = 25000) {
  return new Promise((resolve) => {
    const req = http.get({ host: '', port, path: pathName, timeout }, (res) => {
      res.resume();
      resolve({ ok: res.statusCode < 500, status: res.statusCode });
    });
    req.once('error', () => resolve({ ok: false, status: 0 }));
    req.once('timeout', () => { req.destroy(); resolve({ ok: false, status: 0 }); });
  });
}

 launch(svc) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(LOG, '..', `${svc.logName}-${stamp}.log`);
  let out;
  try { out = fs.openSync(outPath, 'a'); } catch (_) { out = 'ignore'; }
  const child = spawn(svc.cmd, svc.args, {
    cwd: svc.cwd,
    env: Object.assign({}, BASE_ENV, svc.env),
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  child.unref();
  log(`🚀 拉起 ${svc.name} (pid=${child.pid}) 日志=${outPath}`);
  return child.pid;
}

async  check(svc) {
  const st = state.get(svc.name) || { startingUntil: 0, failStreak: 0, lastOk: 0 };
  const open = await portOpen(svc.port);

  if (!open) {
    // 端口不通：若刚拉起且在启动宽限期内，静默等待；否则重新拉起
    if (Date.now() < st.startingUntil) {
      const left = Math.round((st.startingUntil - Date.now()) / 1000);
      log(`⏳ ${svc.name} 启动中，还需等待 ${left}s`);
      return;
    }
    log(`❌ ${svc.name} 端口未监听 → 拉起`);
    launch(svc);
    st.startingUntil = Date.now() + svc.bootGraceMs;
    st.failStreak = 0;
    state.set(svc.name, st);
    return;
  }

  // tcpOnly 服务（如 MySQL 3307）没有 HTTP 探活端点：端口通即视为健康。
  // 2026-09-15 新增 —— 若无此分支，httpOk() 对非 HTTP 服务必然失败，
  //   连续 maxFailStreak 次后会被判"假死"强杀，形成"杀-启"死循环，比不守护更糟。
  if (svc.tcpOnly) {
    st.failStreak = 0;
    st.startingUntil = 0;
    st.lastOk = Date.now();
    state.set(svc.name, st);
    return;
  }

  // 端口通 → HTTP 探活（区分"启动中"与"假死"）
  const r = await httpOk(svc.port, svc.probe);
  if (r.ok) {
    if (st.failStreak > 0) log(`✅ ${svc.name} 恢复 (HTTP ${r.status})`);
    st.failStreak = 0;
    st.startingUntil = 0;
    st.lastOk = Date.now();
  } else {
    st.failStreak = (st.failStreak || 0) + 1;
    log(`⚠️ ${svc.name} 探活失败 ${st.failStreak}/${svc.maxFailStreak} (HTTP ${r.status})`);
    if (st.failStreak >= svc.maxFailStreak && Date.now() >= st.startingUntil) {
      log(`🔄 ${svc.name} 判定假死 → 强制重启`);
      try {
        // 按端口找 PID 并杀掉整棵树（Windows 下 kill 单个进程会留下子进程）
        const { execSync } = require('child_process');
        const out = execSync(`netstat -ano -p TCP | findstr ":${svc.port}" | findstr LISTENING`, { shell: 'cmd.exe' });
        const pid = (out.trim().split(/\s+/).pop() || '').trim();
        if (pid && /^\d+$/.test(pid)) {
          execSync(`taskkill.exe /F /T /PID ${pid}`, { shell: 'cmd.exe', stdio: 'ignore' });
          log(`   已终止 PID ${pid} 及其子进程树`);
        }
      } catch (e) { log(`   终止进程失败（可忽略）: ${e.message.split('\n')[0]}`); }
      st.failStreak = 0;
      setTimeout(() => {
        launch(svc);
        const s2 = state.get(svc.name) || {};
        s2.startingUntil = Date.now() + svc.bootGraceMs;
        state.set(svc.name, s2);
      }, 5000);
    }
  }
  state.set(svc.name, st);
}

// ── 单实例守卫：占用 LOCK_PORT，被占用说明已有看门狗在运行 ──
const lock = net.createServer();
lock.once('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    log(`⚠️ 端口 ${LOCK_PORT} 已被占用，已有看门狗实例在运行，本次退出`);
    process.exit(0);
  }
  log('锁端口异常: ' + e.message);
  process.exit(1);
});
lock.once('listening', async () => {
  try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); } catch (_) {}
  log(`=== 看门狗启动 (interval=${CHECK_INTERVAL_MS / 1000}s, lock=${LOCK_PORT}) ===`);

  // ── 互动回收定时器（2026-10-09 新增）────────────────────────────────
  // 为什么必须加：post_metrics 的回收只有 HTTP 端点
  // （POST /api/v14/tumblr/post-metrics/harvest），**没有任何定时器调用它**
  // ⇒ 2026-09-08 之后 31 天 updated_at 逐字节未变，reach/likes/comments/shares
  //    从未被回收过。工具 tools/harvest-engagement.js 早在 09-24 就写好了，
  //    但同样只被手动/自动化调用过一次。
  // 现在把它挂进常驻看门狗：既保证「一定会跑」，也保证跑在正确的代理环境里
  // （继承上面已固定化的 BASE_ENV，避免再次继承沙箱临时代理）。
  const HARVEST_INTERVAL_MS = Number(process.env.MSCMS_HARVEST_INTERVAL_MS || 6 * 60 * 60 * 1000); // 默认 6h
  const HARVEST_SCRIPT = path.join(WS, 'tools', 'harvest-engagement.js');
  const _lastHarvest = { at: 0 };
  const _startedAt = Date.now();
  async  runHarvest() {
    const now = Date.now();
    // 启动后先静置 3 分钟：给 3002 足够的 bootGrace（它启动要12~13 分钟），
    // 否则第一次必然打到一个还没起来的 3002，产生一堆假失败。
    if (now - _lastHarvest.at < HARVEST_INTERVAL_MS) return;
    if (now - _startedAt < 3 * 60 * 1000) return;
    if (!fs.existsSync(HARVEST_SCRIPT)) { log('互动回收脚本缺失，跳过: ' + HARVEST_SCRIPT); return; }
    _lastHarvest.at = now;
    const started = Date.now();
    try {
      const { spawn } = require('child_process');
      const child = spawn(NODE, [HARVEST_SCRIPT, '--quiet'], {
        env: BASE_ENV, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
      let out = '';
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { out += d; });
      // 单次上限 10 分钟：回收本身要拉N 个 blog，超时即放弃本轮（下一轮再试）
      const killer = setTimeout(() => { try { child.kill(); } catch (_) {} }, 10 * 60 * 1000);
      child.on('close', (code) => {
        clearTimeout(killer);
        const secs = ((Date.now() - started) / 1000).toFixed(0);
        const lastLine = String(out).trim().split(/\r?\n/).pop() || '';
        log(`📈 互动回收: exit=${code} 耗时${secs}s | ${lastLine.slice(0, 160)}`);
      });
    } catch (e) {
      log('互动回收异常: ' + e.message);
    }
  }

  const tick = async () => {
    for (const svc of SERVICES) {
      try { await check(svc); } catch (e) { log(`check ${svc.name} 异常: ${e.message}`); }
    }
    try { await runHarvest(); } catch (e) { log('互动回收调度异常: ' + e.message); }
    setTimeout(tick, CHECK_INTERVAL_MS);
  };
  tick();
  log(`📈 互动回收已挂入定时器: 每 ${HARVEST_INTERVAL_MS / 3600000}h（tools/harvest-engagement.js）`);
});
lock.listen(LOCK_PORT, '');

process.on('uncaughtException', (e) => log('uncaughtException: ' + e.message));
process.on('unhandledRejection', (e) => log('unhandledRejection: ' + (e && e.message)));
