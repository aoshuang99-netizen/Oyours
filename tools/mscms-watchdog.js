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
const NODE = 'C:\\Users\\AS\\.workbuddy\\binaries\\node\\versions\\22.22.2-2\\node.exe';
const PY_MPT = 'C:\\Users\\AS\\.workbuddy\\binaries\\python\\envs\\mpt\\Scripts\\python.exe';
const LOCK_PORT = 3011;
const CHECK_INTERVAL_MS = Number(process.env.MSCMS_WATCHDOG_INTERVAL_MS || 60000);
const LOG = (process.env.LOG_DIR || 'D:/mscms-ws/logs') + '/watchdog.log';

// 公共环境：一切写入落 D 盘（C 盘曾写满导致 DataStore ENOSPC）
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
});

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
  'accounts',          // 养号会回写账号状态（tumblr-nurture.js）
  'tumblr_nurture',    // 养号进度（属主就是 3005）
  'tumblr_persona',    // 人格层（属主 3005）
  'tumblr_device',     // 设备池会话（属主 3005）
  'tumblr_action_log',      // 养号动作日志（属主 3005）
  'tumblr_daily_summary',   // 养号日报（属主 3005）
  'nurture_logs',           // 养号操作流水
  'tumblr_config',     // 应用凭证回填
  'tumblr_token', 'tumblr_reqtoken',   // OAuth 刷新
].join(',');
const WRITE_MODULES_VISITOR = ['tumblr_config', 'tumblr_token', 'tumblr_reqtoken'].join(',');

const SERVICES = [
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
    env: { CLOUD_PHONE_COUNT: '50', CLOUD_PHONE_MODE: 'cloud', PUBLIC_DOMAIN: 'mscms.lokfeel.com', PORT: '3002', TUMBLR_API_RPM: '25', MSCMS_DATASTORE_WRITE_MODULES: WRITE_MODULES_MAIN, MSCMS_TUMBLR_POST_MAX_PER_DAY: '12' },
    logName: 'server-3002',
  },
  {
    name: 'nurture:3005', port: 3005, probe: '/api/status',
    bootGraceMs: 90 * 1000, maxFailStreak: 5,
    cmd: NODE, args: ['tumblr-nurture-server.js'], cwd: WS,
    env: { TUMBLR_NURTURE_PORT: '3005', TUMBLR_NURTURE_DEVICE: '1', TUMBLR_NURTURE_AUTO: '1', TUMBLR_PROXY: 'http://127.0.0.1:10808', TUMBLR_API_RPM: '25', MSCMS_DATASTORE_WRITE_MODULES: WRITE_MODULES_NURTURE },
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
    //   .account_secret 等启动期配置），并在 /status 暴露"需重启才生效"清单。
    name: 'sync:3013', port: 3013, probe: '/health',
    bootGraceMs: 20 * 1000, maxFailStreak: 5,
    cmd: NODE, args: ['tools/sync-desktop.js'], cwd: WS,
    env: { MSCMS_SYNC_PORT: '3013' },
    logName: 'desktop-sync',
  },
  {
    name: 'mpt:8080', port: 8080, probe: '/docs',
    bootGraceMs: 120 * 1000, maxFailStreak: 5,
    cmd: PY_MPT, args: ['-m', 'uvicorn', 'app.asgi:app', '--app-dir', '.', '--host', '127.0.0.1', '--port', '8080', '--log-level', 'warning'],
    cwd: 'D:\\MoneyPrinterTurbo',
    env: {},
    logName: 'mpt-8080',
  },
];

const state = new Map();

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try { fs.appendFileSync(LOG, line + '\n'); } catch (_) {}
  console.log(line);
}

function portOpen(port, timeout = 2000) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const finish = (v) => { if (!done) { done = true; s.destroy(); resolve(v); } };
    s.setTimeout(timeout);
    s.once('connect', () => finish(true));
    s.once('timeout', () => finish(false));
    s.once('error', () => finish(false));
    s.connect(port, '127.0.0.1');
  });
}

// 2026-09-12：探活超时 8s → 25s。
//  起因：本机 12 核被 Ollama CPU 推理占满（实测单进程 108%），3002 事件循环被饿死，
//  8s 探活必然超时 → 连续 3 次 → 误判"假死"强杀 → 冷启又抢不到 CPU → 每 20~45 分钟死一次。
//  真死仍由 portOpen()（2s TCP，见 check()）立即发现并拉起，本阈值只影响"假死"判定。
function httpOk(port, pathName, timeout = 25000) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathName, timeout }, (res) => {
      res.resume();
      resolve({ ok: res.statusCode < 500, status: res.statusCode });
    });
    req.once('error', () => resolve({ ok: false, status: 0 }));
    req.once('timeout', () => { req.destroy(); resolve({ ok: false, status: 0 }); });
  });
}

function launch(svc) {
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

async function check(svc) {
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
        const out = execSync(`netstat -ano -p TCP | findstr ":${svc.port}" | findstr LISTENING`, { shell: 'cmd.exe' }).toString();
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
  const tick = async () => {
    for (const svc of SERVICES) {
      try { await check(svc); } catch (e) { log(`check ${svc.name} 异常: ${e.message}`); }
    }
    setTimeout(tick, CHECK_INTERVAL_MS);
  };
  tick();
});
lock.listen(LOCK_PORT, '127.0.0.1');

process.on('uncaughtException', (e) => log('uncaughtException: ' + e.message));
process.on('unhandledRejection', (e) => log('unhandledRejection: ' + (e && e.message)));
