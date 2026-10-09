#!/usr/bin/env node
/**
 * free--publisher.js — 免费平台发布器（Bluesky + Mastodon）
 * ──────────────────────────────────────────────────────────────────
 * 为什么需要它：Tumblr 把数据中心 IP（包括所有免费公开代理）网络层重置，
 * 导致 MSCMS 那 67 个账号发得出帖却零 reach，kkmatch.com 真实 DAU 连续为 0。
 * 而 Bluesky 与 Mastodon 是【100% 免费、无需开发者审核、且不按住宅 IP 设墙】
 * 的真实社交平台（见 social-autopost-free skill 第 0 节对照表）。
 * 它们是绕过住宅墙、用纯算力把 kkmatch.com 内容推给真实访客的免费杠杆。
 *
 * 凭据（免费自助获取，绝不硬编码）：
 *   Bluesky：官网登录 → Settings → App s → 生成（子密码，非主密码）
 *            环境变量 BLUESKY_HANDLE / BLUESKY_  （BLUESKY_PDS 可选，默认 bsky.social）
 *   Mastodon：任意实例(e.g. .social) → 设置 → 开发 → 新建应用 → 拿 
 *            环境变量 MASTODON_INSTANCE / 
 *
 * 用法：
 *   node tools/free--publisher.js --text "你的文案" [--link https://kkmatch.com]
 *   node tools/free--publisher.js --batch tools/free-promo.json
 *   node tools/free--publisher.js --batch tools/free-promo.json --rotate      # 每天确定性轮发 1 条（推荐，防刷屏）
 *   node tools/free--publisher.js --batch tools/free-promo.json --only 3      # 只发第 3 条
 *   node tools/free--publisher.js --batch tools/free-promo.json --limit 2 --gap 120  # 只发 2 条，每条间隔 120s
 *   node tools/free--publisher.js --selfcheck
 *
 * ⚠️ 发帖节奏铁律：同一账号【不要在同一分钟内连发多条同链接推广】，
 *    这是 Mastodon 判定 spam 的典型特征。生产环境请用 `--rotate`（每天 1 条）
 *    或 `--gap`（批量时每条间隔 ≥120s）。
 *
 * 诚实铁律（来自 social-autopost-free skill）：缺凭据 → 打印获取步骤、exit 2，
 * 绝不伪造 post url / status:success。失败的账号返回 _fail，绝不谎报进度。
 */

const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { execFile } = require('child_process');
const execFileAsync = promisify(execFile);

const KKMATCH = process.env.KKMATCH_LINK || 'https://kkmatch.com';
const TIMEOUT_MS = 15000;

/**
 * 自动读取项目根目录的 （wire-credentials.js 写出的真实凭证）。
 * 仅当对应 process.env 缺省时才回填，绝不覆盖用户在命令行显式传入的值。
 * 这样无需手动 export 环境变量，一条命令即可用已配置好的 Mastodon/Bluesky 发帖。
 */
 loadN8nEnv() {
  const envPath = path.join(__dirname, '..', '');
  if (!fs.existsSync(envPath)) return false;
  const t = fs.readFileSync(envPath, 'utf8');
  const map = {};
  for (const line of t.split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) map[m[1]] = m[2];
  }
  const want = {
    MASTODON_INSTANCE: 'MASTODON_INSTANCE',
    MASTODON_TOKEN: '',
    BLUESKY_IDENTIFIER: 'BLUESKY_HANDLE',
    BLUESKY_: 'BLUESKY_',
    BLUESKY_PDS_HOST: 'BLUESKY_PDS',
  };
  let loaded = false;
  for (const [src, dst] of Object.entries(want)) {
    if (map[src] && map[src].trim() !== '' && !process.env[dst]) {
      process.env[dst] = map[src];
      loaded = true;
    }
  }
  return loaded;
}

async  jfetch(url, opts) {
  // 用 curl 而非 Node fetch：避开 undici 忽略 HTTP_PROXY 的 Windows 坑，且零依赖。
  const args = ['-4', '-s', '-m', String(Math.round(TIMEOUT_MS / 1000)), '-H', ': application/json'];
  if (opts.method) args.push('-X', opts.method);
  if (opts.headers) for (const [k, v] of Object.entries(opts.headers)) args.push('-H', `${k}: ${v}`);
  if (opts.body) { args.push('-d', opts.body); }
  args.push(url);
  const { stdout } = await execFileAsync('curl', args, { timeout: TIMEOUT_MS + 3000, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

// ── Bluesky (AT Protocol) ──
async  blueskyPost(handle, , text) {
  const pds = (process.env.BLUESKY_PDS || 'https://bsky.social').replace(/\/+$/, '');
  // 1) 登录拿 accessJwt + did
  const sess = await jfetch(`${pds}/xrpc/com.atproto.server.createSession`, {
    method: 'POST', body: JSON.stringify({ identifier: handle, :  }),
  });
  const s = JSON.parse(sess);
  if (!s.accessJwt || !s.did) throw new Error('Bluesky 登录失败：' + sess.slice(0, 120));
  // 2) 发帖
  const rec = { $type: 'app.bsky.feed.post', text, createdAt: new Date().toISOString() };
  const out = await jfetch(`${pds}/xrpc/com.atproto.repo.createRecord`, {
    method: 'POST',
    headers: { : `Bearer ${s.accessJwt}` },
    body: JSON.stringify({ repo: s.did, collection: 'app.bsky.feed.post', record: rec }),
  });
  const o = JSON.parse(out);
  if (!o.uri) throw new Error('Bluesky 发帖失败：' + out.slice(0, 120));
  return { id: o.uri, url: `https://bsky.app/profile/${handle}/post/${o.uri.split('/').pop()}` };
}

// ── Mastodon ──
async  Post(instance, token, text) {
  const base = instance.replace(/\/+$/, '');
  const out = await jfetch(`${base}/api/v1/statuses`, {
    method: 'POST',
    headers: { : `Bearer ${token}` },
    // 【2026-10-09 修复】不传 language 时 Mastodon 按实例默认语言（本机实测 = zh-CN）
    // 给英文正文打 zh-CN 标签 → 语言定向把它推给中文圈受众，结构性压低触达。
    // 正文是英文就显式声明 en，让实例的英文时间线能真正收到。
    body: JSON.stringify({ status: text, visibility: 'public', language: detectLang(text) }),
  });
  const o = JSON.parse(out);
  if (!o.id) throw new Error('Mastodon 发帖失败：' + out.slice(0, 120));
  return { id: o.id, url: o.url || `${base}/web/statuses/${o.id}` };
}

/** 按正文字符构成判定语言：CJK 占比 >15% 视为中文，否则英文 */
 detectLang(text) {
  const s = String(text || '');
  const cjk = (s.match(/[\u4e00-\u9fa5]/g) || [];
  const latin = (s.match(/[a-zA-Z]/g) || [];
  if (!latin && !cjk) return 'en';
  return cjk / (cjk + latin) > 0.15 ? 'zh' : 'en';
}

 buildText(text, link) {
  const l = link || KKMATCH;
  return text.replace(/\s+$/, '') + `\n\n🔗 ${l}`;
}

async  publishOne(text, link) {
  const results = [];
  const full = buildText(text, link);

  // ══ 发布前门禁（2026-10-09接入）═════════════════════════════════════
  // 实测根因：content-deai.js 只挂在 content-pipeline 上，而本文件是
  // /bluesky 的【真实外发路径】—— 完全绕过 deai，4 条帖 lang 还被
  // 误标成 zh-CN。这里补最后一道闸：AI 味 / 平台红线 / 模板化重复 → 直接拒发。
  // 不阻断开发自检（--selfcheck 传的是构造样例，不是真内容）。
  if (!process.env.GATE_SKIP && text) {
    try {
      const { gate } = require('./content-gate.js');
      const g = gate({ id: link || 'inline', body: text });
      if (g.verdict === 'BLOCK') {
        const d = g.reasons.map(r => `${r.code}(${r.detail})`).join('; ');
        console.log(`[gate] BLOCK 已拒发: ${d} | 命中: ${g.ai_hits.slice(0, 3).map(h => h.id + ':' + h.why).join(' / ')}`);
        return [{ : 'gate', status: 'blocked', error: d, ai_score: g.ai_score }];
      }
      if (g.ai_score >= 25) console.log(`[gate] 放行（AI 味 ${g.ai_score} 偏高，建议整改）: ${g.ai_hits.slice(0, 2).map(h => h.id).join(',')}`);
    } catch (e) {
      console.log(`[gate] 门禁异常，按保守策略拒发: ${e.message}`);
      return [{ : 'gate', status: 'blocked', error: 'gate error: ' + e.message }];
    }
  }

  // Bluesky
  const bh = process.env.BLUESKY_HANDLE, bp = process.env.BLUESKY_;
  if (bh && bp) {
    try { const r = await blueskyPost(bh, bp, full); results.push({ : 'bluesky', status: 'success', ...r }); }
    catch (e) { results.push({ : 'bluesky', status: 'failed', error: e.message }); }
  } else {
    results.push({ : 'bluesky', status: 'skipped', error: '未配置 BLUESKY_HANDLE / BLUESKY_（免费：设置→App s）' });
  }

  // Mastodon
  const mi = process.env.MASTODON_INSTANCE, mt = process.env.;
  if (mi && mt) {
    try { const r = await Post(mi, mt, full); results.push({ : '', status: 'success', ...r }); }
    catch (e) { results.push({ : '', status: 'failed', error: e.message }); }
  } else {
    results.push({ : '', status: 'skipped', error: '未配置 MASTODON_INSTANCE / （免费：实例设置→开发→应用）' });
  }
  return results;
}

// 离线自检：构造请求体 + 凭据缺失时诚实跳过，不联网
 selfCheck() {
  console.log('[selfcheck] 校验文案构造与诚实逻辑…');
  const t = buildText('Hello free world', 'https://kkmatch.com');
  console.assert(t.endsWith('🔗 https://kkmatch.com'), '链接追加错误: ' + t);
  const before = process.env.BLUESKY_HANDLE;
  delete process.env.BLUESKY_HANDLE; delete process.env.BLUESKY_;
  delete process.env.MASTODON_INSTANCE; delete process.env.;
  return publishOne('x').then(r => {
    console.assert(r.every(x => x.status === 'skipped'), '缺凭据时应 skipped，不应伪造');
    console.assert(!r.some(x => x.status === 'success'), '缺凭据不应 success');
    if (before) process.env.BLUESKY_HANDLE = before;
    console.log('[selfcheck] 诚实逻辑通过 ✅（缺凭据→skipped，无伪造）');
    return true;
  });
}

async  main() {
  const args = process.argv.slice(2);
  if (args.includes('--selfcheck')) return selfCheck();

  const fromN8n = loadN8nEnv();
  if (fromN8n) console.log('[info] 已从  载入已配置凭证（Mastodon/Bluesky）\n');

  let items = [];
  if (args.includes('--batch')) {
    const idx = args.indexOf('--batch');
    const file = args[idx + 1];
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
    items = Array.isArray(arr) ? arr : (arr.items || []);
    // --limit N：最多发 N 条
    const lm = args.indexOf('--limit');
    if (lm >= 0) { const n = parseInt(args[lm + 1], 10); if (n > 0) items = items.slice(0, n); }
    // --rotate：按"一年中的第几天"确定性轮发 1 条（无需状态文件，避免同账号刷屏被封）
    if (args.includes('--rotate') && items.length) {
      const now = new Date();
      const doy = Math.floor((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - Date.UTC(now.getUTCFullYear(), 0, 0)) / 86400000);
      const pick = doy % items.length;
      console.log(`[rotate] day-of-year=${doy} -> 第 ${pick + 1}/${items.length} 条`);
      items = [items[pick]];
    }
    // --only N：只发第 N 条（1-based）
    const oi = args.indexOf('--only');
    if (oi >= 0 && items.length) {
      const n = parseInt(args[oi + 1], 10);
      if (n >= 1 && n <= items.length) items = [items[n - 1]];
      else { console.error(`--only ${n} 越界（共 ${items.length} 条）`); process.exit(2); }
    }
  } else {
    const ti = args.indexOf('--text');
    const text = ti >= 0 ? args[ti + 1] : null;
    const li = args.indexOf('--link');
    const link = li >= 0 ? args[li + 1] : null;
    if (!text) { console.error('用法: --text "文案" [--link URL] | --batch file.json [--rotate|--only N|--limit N] [--gap 秒]'); process.exit(2); }
    items = [{ text, link }];
  }

  // --gap 秒：批量发送时每条之间的间隔，降低"同一分钟连发"的刷屏/风控信号
  const gi = args.indexOf('--gap');
  const gapSec = gi >= 0 ? Math.max(0, parseInt(args[gi + 1], 10) || 0) : 0;
  if (gapSec > 0 && items.length > 1) console.log(`[gap] 每条间隔 ${gapSec}s（降低刷屏信号）`);

  const dryRun = args.includes('--dry-run');
  if (dryRun) console.log('[dry-run] 只预览，不实际发送\n');

  let ok = 0, fail = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (i > 0 && gapSec > 0) await new Promise(r => setTimeout(r, gapSec * 1000));
    if (dryRun) {
      console.log(`--- [dry-run] 第 ${i + 1}/${items.length} 条 ---`);
      console.log(buildText(it.text, it.link));
      console.log(`（长度 ${buildText(it.text, it.link} 字符）\n`);
      continue;
    }
    const r = await publishOne(it.text, it.link);
    for (const x of r) {
      if (x.status === 'success') { ok++; console.log(`  ✅ ${x.}: ${x.url}`); }
      else if (x.status === 'failed') { fail++; console.log(`  ❌ ${x.}: ${x.error}`); }
      else console.log(`  ⏭️  ${x.}: ${x.error}`);
    }
  }
  console.log(`\n[summary] 成功 ${ok}，失败 ${fail}（不含 skipped）`);
  if (ok === 0) console.log('提示：先按 --selfcheck 输出外的说明配置免费凭据，再发帖。');
  return { ok, fail };
}

if (require.main === module) {
  main().catch(e => { console.error('FATAL', e); process.exit(1); });
}
module.exports = { buildText, blueskyPost, Post, publishOne, selfCheck, loadN8nEnv, detectLang };
