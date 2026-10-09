'use strict';
/**
 * tools/gray-.js — 出口单元灰度定标编排器（2026-09-12）
 * =====================================================================
 * 目的（回答方案里的「容量到底按 41 IP 还是 9 单元算」）
 * ---------------------------------------------------
 * 出口池 42 条发布可用条目 / 41 个唯一 IP —— 但其中 39 个 IPv6 全落在
 * `2a09:bac5:624d::/48`，只占 7 个 `/64`。若 CF 的配额/信誉按 /64（甚至 /48）计量，
 * 真实独立单元只有：
 *     7 个 CF /64  +  1 个 BWG VPS IPv4()  +  1 个 BD 静态住宅(185.97.0.157)
 *     = 9 个
 * 按 9 单元算（每单元 10 账号安全线）→ 上限 ≈90 账号；
 * 按 41 IP 算 → ≈410 账号。差 4.5 倍，直接决定「要不要继续加 Cloudflare Worker」。
 *
 * 实验设计
 * --------
 *   9 单元 × 3 账号 = 27 个账号，全部打 `gray_cohort` 标记，观察 7 天：
 *   每单元的 存活率 / 发布成功率 / 首个限流出现时间。
 *
 * 轮转顺序（关键）
 * --------------
 *   按【单元轮转】而非「一个单元连打 3 个」：轮1 = 单元1..9，轮2 = 单元1..9，轮3 = 单元1..9。
 *   同一单元的两次注册之间隔着 8 次其他注册（每次约 1~3 分钟），
 *   天然满足「同单元间隔 ≥10 分钟」，无需额外 sleep。
 *
 * 实现说明
 * --------
 *   每个账号用【独立子进程】跑 tumblr-onboard-shardx.js（而不是 require 进本进程）：
 *     · 编排器自身轻量（--plan 秒出）；
 *     · 浏览器/验证码崩溃不会带崩整轮；
 *     · 每个账号有独立 clean 的 process.env / 代理状态。
 *   子进程全部输出落到 logs/gray--<cohort>.log，便于事后取证。
 *
 * 用法
 * ----
 *   node tools/gray-.js --plan                    # 只打印计划（默认，不执行）
 *   node tools/gray-.js --run                     # 执行 9×3
 *   node tools/gray-.js --run --per-unit 2        # 每单元 2 个（共 18）
 *   node tools/gray-.js --run --units <k1,k2>     # 只跑指定单元
 *   node tools/gray-.js --run --cohort my-cohort  # 自定义队列名
 *   node tools/gray-.js --summary                 # 看账本用量
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const RX = require(path.join(__dirname, '..', 'registration-exits.js'));

const WS = path.join(__dirname, '..');
const NODE = process.execPath;
const ONBOARD = path.join(WS, 'tumblr-onboard-shardx.js');
const log = (m) => console.log(m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);

 parseArgs(argv) {
  const o = { plan: !argv.includes('--run'), perUnit: 3, units: null, cohort: null, summary: false };
  if (argv.includes('--summary')) o.summary = true;
  const pi = argv.indexOf('--per-unit');
  if (pi >= 0) o.perUnit = Math.max(1, parseInt(argv[pi + 1] || '3', 10));
  const ui = argv.indexOf('--units');
  if (ui >= 0) o.units = String(argv[ui + 1] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ci = argv.indexOf('--cohort');
  if (ci >= 0) o.cohort = argv[ci + 1] || null;
  o.cohort = o.cohort || ('gray-' + today());
  return o;
}

/** 跑一个账号（独立子进程），返回 {ok, ip, unit, accountId, reason, raw} */
 runOne(unitKey, cohort, logStream) {
  return new Promise((resolve) => {
    const args = [ONBOARD, '1', '--unit', unitKey];
    const child = spawn(NODE, args, {
      cwd: WS,
      env: { ...process.env, MSCMS_GRAY_COHORT: cohort, MSCMS_GRAY_PER_EXIT_DAY: process.env.MSCMS_GRAY_PER_EXIT_DAY || '3' },
      windowsHide: true,
    });
    let buf = '';
    const onChunk = (d) => {
      const s = d.toString();
      buf += s;
      if (logStream) logStream.write(s);
      // 实时回显关键行，避免长轮次"假死"
      for (const line of s.split('\n')) {
        if (/出口单元|实测出口 IP|节流拦截|创建接口|环境:|完成：|✅|❌|⏸|⚠️/.test(line)) log('    │ ' + line.replace(/\s+$/, ''));
      }
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    const killT = setTimeout(() => { try { child.kill(); } catch (_) {} }, 15 * 60000);
    child.on('close', (code) => {
      clearTimeout(killT);
      const tail = buf.split('\n').slice(-14).join('\n');
      const m = tail.match(/([✅❌])\s+(tumblr_\S+)\s+blog=(\S+)\s+unit=(\S*)\s+ip=(\S*)/);
      const ok = !!m && m[1] === '✅';
      const acc = m ? m[2] : null;
      const unit = (m && m[4] && m[4] !== '-') ? m[4] : unitKey;
      const ip = (m && m[5] && m[5] !== '-') ? m[5] : null;
      const throttle = /节流拦截/.test(buf);
      const reason = ok ? null : (throttle ? 'throttled' : 'exit=' + code);
      resolve({ ok, accountId: acc, unit, ip, reason, throttled: throttle && !ok, raw: buf });
    });
    child.on('error', (e) => { clearTimeout(killT); resolve({ ok: false, unit: unitKey, reason: 'spawn:' + e.message, raw: '' }); });
  });
}

(async () => {
  const o = parseArgs(process.argv.slice(2));

  if (o.summary) {
    const s = RX.summary();
    log(`账本: ${s.ledger}`);
    log(`规则: 每单元 ${s.rules.perExitPerDay}/天 | 间隔 ${s.rules.minGapMin} 分钟 | 全局 ${s.rules.totalPerDay}/天`);
    log(`今日 ${s.dayTotal} 条 / 累计 ${s.grandTotal} 条\n`);
    log('单元'.padEnd(28) + '池条目  今日   累计(成功)');
    for (const u of s.units) {
      log('  ' + String(u.unit).padEnd(26) + String(u.poolSize).padEnd(8) + String(u.quota).padEnd(7) + `${u.total}(${u.totalOk})`);
    }
    return process.exit(0);
  }

  const pool = RX.loadPublishExits();
  let units = RX.buildUnits();
  if (o.units && o.units.length) {
    const set = new Set(o.units);
    units = units.filter((u) => set.has(u.unit) || set.has(u.name) || set.has(u.proxy));
    if (!units.length) { log('❌ --units 未命中任何出口单元'); return process.exit(1); }
  }

  log('══════════ 出口单元灰度定标 ══════════');
  log(`池文件        : ${pool.file}`);
  log(`发布可用条目  : ${pool.list.length}`);
  log(`聚合出口单元  : ${units.length} 个（CF /64 ${units.filter((u) => u.cf} + 其他 ${units.filter((u) => !u.cf}）`);
  log(`每单元账号数  : ${o.perUnit}`);
  log(`计划注册总数  : ${units.length * o.perUnit}`);
  log(`队列标记      : ${o.cohort}`);
  log(`账本           : ${RX.LEDGER}`);
  log('');
  log('单元'.padEnd(28) + '池条目  代表代理'.padEnd(28) + '今日用量');
  const ledger = RX.readLedger();
  for (const u of units) {
    const used = ledger.filter((x) => x.unit === u.unit && x.day === today();
    const st = RX.checkThrottle(u.unit);
    log('  ' + String(u.unit).padEnd(26) + String(u.n).padEnd(8) + String(u.proxy).padEnd(28) + `${used}/${RX.RULES().perExitPerDay}` + (st.ok ? '' : `  ⏸ ${st.reason}`));
  }
  log('');

  if (o.plan) {
    log('（这是计划视图。加 --run 才会真正执行。）\n');
    log('轮转顺序：');
    for (let r = 0; r < o.perUnit; r++) {
      log(`  轮${r + 1}: ` + units.map((u) => u.unit.split(':').slice(-1)[0]).join(' → '));
    }
    const k = units.length * o.perUnit;
    log(`  合计 ${k} 次注册，预计耗时 ${Math.round(k * 2)}~${Math.round(k * 3.5)} 分钟`);
    return process.exit(0);
  }

  // ───────────── 执行 ─────────────
  const LOGDIR = path.join(WS, 'logs');
  try { fs.mkdirSync(LOGDIR, { recursive: true }); } catch (_) {}
  const LOGFILE = path.join(LOGDIR, `gray--${o.cohort}.log`);
  const logStream = fs.createWriteStream(LOGFILE, { flags: 'a' });
  logStream.write(`\n\n===== gray- ${o.cohort} @ ${new Date().toISOString()} =====\n`);

  const results = [];
  let idx = 0;
  const total = units.length * o.perUnit;
  for (let round = 0; round < o.perUnit; round++) {
    for (const u of units) {
      idx++;
      log(`\n────────── [${idx}/${total}] 轮${round + 1} · 单元 ${u.unit} · ${u.proxy} ──────────`);
      let r = await runOne(u.unit, o.cohort, logStream);

      if (r.throttled) {
        const t = RX.checkThrottle(u.unit);
        const dailyCap = /已达上限/.test(t.reason || '');
        if (dailyCap) {
          // 每日配额已满 —— 等待无意义（要等到明天 00:00），直接跳过本轮
          log(`  ⏭ 单元 ${u.unit} 今日配额已满（${t.reason}），跳过本轮，不占用时长`);
          results.push(r);
          continue;
        }
        const wait = Math.min(Math.max(t.waitMs || 60000, 30000), 16 * 60000);
        log(`  ⏳ 单元 ${u.unit} 仍在节流，等待 ${(wait / 60000).toFixed(1)} 分钟后重试`);
        await sleep(wait + 5000);
        r = await runOne(u.unit, o.cohort, logStream);
      }
      results.push(r);
      const okN = results.filter((x) => x.ok;
      log(`  → ${r.ok ? '✅ 成功' : '❌ 失败'} ${r.accountId || ''} ip=${r.ip || '-'}  |  进度 ${okN}/${results.length}`);
    }
  }

  logStream.end();

  // ───────────── 汇总 ─────────────
  log('\n══════════ 灰度注册完成 ══════════');
  const byUnit = {};
  for (const r of results) {
    const k = r.unit || 'unknown';
    const g = byUnit[k] = byUnit[k] || { ok: 0, fail: 0, ips: new Set() };
    if (r.ok) g.ok++; else g.fail++;
    if (r.ip) g.ips.add(r.ip);
  }
  log('单元'.padEnd(28) + '成功  失败  实测出口IP');
  for (const [k, v] of Object.entries(byUnit)) {
    log('  ' + k.padEnd(26) + String(v.ok).padEnd(6) + String(v.fail).padEnd(6) + ([...v.ips].join(',') || '-'));
  }
  const ok = results.filter((x) => x.ok;
  log(`\n合计: 成功 ${ok}/${results.length}   队列=${o.cohort}`);
  log(`明细日志: ${LOGFILE}`);
  log(`观测下一跳: node tools/gray-analyze.js --cohort ${o.cohort}`);
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
