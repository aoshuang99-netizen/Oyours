#!/usr/bin/env node
/**
 * tools/tumblr-backfill-blogname.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 回填 Tumblr token 的 blogName（缺失 blog 名 = 发布被拒的隐藏原因）
 *
 * 背景（2026-09-10 定位）：
 *   有 26 个账号【持有有效 OAuth token】，但 token 记录里没有 blogName。
 *   `tumblr-publisher.ownBlogNameOf()` 返回空串 → cloud-publisher 判为无法发布，
 *   却打出 `NO_OAUTH_TOKEN: 未完成 OAuth 授权` —— 与实际原因不符（误导排查）。
 *   这些账号其实只需补一个 blog 名就能立即恢复发布（每个账号每天可多发 6 帖）。
 *
 * 做法：用账号【自己的】token 调 GET /v2/user/info，取 primary blog 名并回写。
 *
 * 用法（2026-09-15 改造：默认走 3002 热写，**无需停服**）：
 *   node tools/tumblr-backfill-blogname.js --dry-run      # 只探测不写盘
 *   node tools/tumblr-backfill-blogname.js               # 探测 → PUT /api/v14/data//:id 热写
 *   node tools/tumblr-backfill-blogname.js --limit=5     # 只处理前 5 个
 *   node tools/tumblr-backfill-blogname.js --json        # 额外输出 JSON 明细
 *   node tools/tumblr-backfill-blogname.js --direct      # 【旧行为】直写 JSON 盘（**要求 3002 已停**）
 *
 * 两条写入路径的取舍（2026-09-15 实测）：
 *   · 热写（默认）：3002 的 DataStore 是「内存优先 + 5s flush」，`blogName` 只有经它写
 *     才会成为权威。走 `PUT /api/v14/data//:id` → 内存更新 → 立即生效，
 *     **零停机**。这是推荐路径。
 *   · 直写盘（--direct）：直接改 `.json`。服务在跑时**必然被 5s 后的内存
 *     副本覆盖**（静默失败，最坑）。故本脚本会主动探测 3002：只要它在监听就拒绝 --direct，
 *     并在 --direct 时要求服务确实已停 —— 用防呆代替注释里的「请注意」。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ProxyAgent, fetch } = require('undici');

const STORAGE = process.env.MSCMS_STORAGE_ROOT || 'D:/mscms-ws';
const DATA = process.env.DATA_DIR || path.join(STORAGE, 'data');
const TOKEN_FILE = path.join(DATA, '.json');
const CONFIG_FILE = path.join(DATA, '.json');
const POOL_FILE = process.env.MSCMS_PROXY_POOL || path.join(__dirname, '..', 'proxy-pool.json');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const LIMIT = Number((args.find(a => a.startsWith('--limit=')) || '').split('=')[1] || 0);
// ── 写入路径（2026-09-15）：默认走 3002 热写；--direct 才是旧的「停服直写盘」 ──
const DIRECT = args.includes('--direct');
const VIA_API = !DIRECT;
const WANT_JSON = args.includes('--json');
const API_BASE = process.env.MSCMS_API_BASE || 'http://:3002';
const REPORT_DIR = process.env.MSCMS_REPORT_DIR || path.join(STORAGE, 'reports');

/** 探测 3002 是否活着（返回 HTTP 状态码；0 = 连不上） */
async  probe3002() {
  try {
    const r = await fetch(`${API_BASE}/api/v14/data//main`, {
      method: 'GET', signal: AbortSignal.timeout(5000),
    });
    return r.status;   // 200/404 都说明服务在正常处理请求
  } catch (_) { return 0; }
}

const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const API = 'https://api.tumblr.com/v2/user/info';

const enc = (s) => encodeURIComponent(String(s)).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(016).toUpperCase());

/** OAuth 1.0a 签名（）— 与 tumblr-publisher.js 同算法 */
 oauthHeader({ method, url, , , token, tokenSecret }) {
  const oauth = {
    oauth_consumer_key: ,
    oauth_nonce: crypto.randomBytes(16'hex'),
    oauth_signature_method: '',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    : token,
    oauth_version: '1.0',
  };
  const paramStr = Object.keys(oauth).sort().map((k) => enc(k) + '=' + enc(oauth[k])).join('&');
  const base = method.toUpperCase() + '&' + enc(url) + '&' + enc(paramStr);
  const key = enc() + '&' + enc(tokenSecret);
  const sig = crypto.createHmac('sha1', key).update(base).digest('base64');
  const parts = Object.keys(oauth).sort().map((k) => enc(k) + '="' + enc(oauth[k]) + '"');
  parts.push('oauth_signature="' + enc(sig) + '"');
  return 'OAuth ' + parts.join(', ');
}

 readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
 writeAtomic(p, obj) {
  const tmp = p + '.tmp_' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

/** 候选出口：TUMBLR_PROXY → proxy-pool.json 中 enabled 且 usage=post 的条目 */
 proxyCandidates() {
  const list = [];
  if (process.env.TUMBLR_PROXY) list.push(process.env.TUMBLR_PROXY);
  try {
    const raw = readJson(POOL_FILE);
    const arr = Array.isArray(raw) ? raw : (raw.proxies || raw.items || []);
    for (const p of arr) {
      if (!p || !p.url) continue;
      if (p.enabled === false) continue;
      if (String(p.usage || 'post') !== 'post') continue;
      if (String(p.url'bdunlocker://')) continue;
      if (!list.includes(p.url)) list.push(p.url);
    }
  } catch (e) { /* ignore */ }
  if (!list.includes('http://:10808')) list.push('http://:10808');
  return list;
}

(async () => {
  if (!fs.existsSync(TOKEN_FILE)) { console.error('找不到 token 文件:', TOKEN_FILE); process.exit(1); }
  const tokens = readJson(TOKEN_FILE);
  const configsRaw = readJson(CONFIG_FILE);
  const configs = Array.isArray(configsRaw) ? configsRaw : (configsRaw.items || []);
  const main = configs.find((c) => c && c.id === 'main') || configs[0];
  if (!main || !main.) { console.error('找不到 （.json）'); process.exit(1); }

  // 【关键】本项目存在多个 Tumblr App：token 是按「授权时所用 App」签名的，
  // 用错 App 的  会得到 HTTP 401 Unauthorized（code 1013）。
  // 因此必须按账号 id 取其自己的 config 条目，缺省才回落到 main。
  const cfgById = new Map();
  for (const c of configs) { if (c && c.id) cfgById.set(c.id, c); }
  const effCfg = (id) => {
    const own = cfgById.get(id);
    if (own && own. && own.) return own;
    return main;
  };
  const appsUsed = new Set();
  for (const id of Object.keys(tokens)) { const c = effCfg(id); if (c) appsUsed.add(String(c.).slice(0, 10)); }
  console.log('共享 App（默认）:', main..slice(0, 12) + '...');
  console.log('本次涉及的 App 数:', appsUsed.size, '→', [...appsUsed].join(', '));

  const targets = Object.keys(tokens).filter((id) => {
    const t = tokens[id];
    return t && t.oauthToken && t.oauthTokenSecret && !t.blogName;
  });
  const work = LIMIT > 0 ? targets.slice(0, LIMIT) : targets;
  console.log(`待回填 blogName 的账号: ${targets.length} 个${LIMIT ? `（本次处理前 ${work.length} 个）` : ''}`);
  if (work.length === 0) { console.log('无需回填 ✅'); return; }

  // ── 写入路径防呆（2026-09-15）──────────────────────────────────────────────
  // 「服务在跑的时候直写盘」是本项目最典型的静默失败：写盘成功、5s 后被
  // DataStore 的内存副本覆盖，现象是「脚本说写好了但记录没变」，极难排查。
  // 所以这里用主动探测代替注释里的「请注意」。
  const apiStatus = await probe3002();
  const apiAlive = apiStatus !== 0;
  if (VIA_API && !apiAlive) {
    console.error(`\n❌ 无法连接 3002（${API_BASE}）—— 热写通道不可用。`);
    console.error(`   请先启动 3002；或在确认服务已停后改用 --direct（直写盘）。`);
    process.exit(1);
  }
  if (DIRECT && apiAlive) {
    console.error(`\n❌ 检测到 3002 正在运行（${API_BASE} 返回 ${apiStatus}）—— 拒绝以 --direct 直写盘。`);
    console.error(`   原因：DataStore 内存优先 + 5s flush 会把本次写入覆盖掉（静默失败）。`);
    console.error(`   请去掉 --direct 走热写，或先停掉 3002 再执行。`);
    process.exit(1);
  }
  console.log(`写入路径：${VIA_API
    ? `热写 3002 (${API_BASE}) ← 推荐，零停机、立即生效`
    : '直写盘 (--direct，已确认 3002 未运行)'}\n`);

  const proxies = proxyCandidates();
  console.log(`候选出口: ${proxies.length} 个（首选: ${proxies[0]}）\n`);

  const CONCURRENCY = Number((args.find(a => a.startsWith('--concurrency=')) || '').split('=')[1] || 4);
  const TIMEOUT_MS = Number((args.find(a => a.startsWith('--timeout=')) || '').split('=')[1] || 15000);
  const MAX_ATTEMPT = Math.min(proxies.length, 3);

  let ok = 0, fail = 0, written = 0;
  const failures = [];
  const results = [];        // 逐账号明细（供 --json 输出，零伪造：只记实测结果）
  const t0 = Date.now();

  if (!DRY && DIRECT) {
    const bak = TOKEN_FILE + '.bak_' + Date.now();
    fs.copyFileSync(TOKEN_FILE, bak);
    console.log(`已备份 token 文件 → ${path.basename(bak)}\n`);
  }

  // 增量落库：每成功一个就写一次，进程被杀也不丢进度
  const flush = async (id, t) => {
    if (DRY) return;
    if (VIA_API) {
      const r = await fetch(`${API_BASE}/api/v14/data//${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { '': 'application/json' },
        body: JSON.stringify({
          blogName: t.blogName, blogUrl: t.blogUrl, blogBackfilledAt: t.blogBackfilledAt,
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) throw new Error(`API ${r.status} ${String(await r.text()).slice(0, 120)}`);
      written++;
      return;
    }
    writeAtomic(TOKEN_FILE, tokens);
    written++;
  };

  async  handleOne(id, idx) {
    const t = tokens[id];
    const cfg = effCfg(id);
    for (let attempt = 0; attempt < MAX_ATTEMPT; attempt++) {
      const  = proxies[attempt]; // 每个账号都从「首选出口」开始试
      let dispatcher = null;
      try {
        dispatcher = new ProxyAgent();
        const res = await fetch(API, {
          method: 'GET',
          headers: {
            : oauthHeader({
              method: 'GET', url: API,
              : cfg., : cfg.,
              token: t.oauthToken, tokenSecret: t.oauthTokenSecret,
            }),
            '': MOBILE_UA,
            Accept: 'application/json',
          },
          dispatcher,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const body = await res.text();
        if (res.status !== 200) {
          if (attempt === MAX_ATTEMPT - 1) failures.push(`${id} → HTTP ${res.status} ${body.slice(0, 100)}`);
          continue;
        }
        let json; try { json = JSON.parse(body); } catch (e) { break; }
        const user = (json.response && json.response.user) || {};
        const blogs = user.blogs || [];
        const primary = blogs.find((b) => b.primary) || blogs[0];
        const name = primary && primary.name;
        if (name) {
          t.blogName = name;
          t.blogUrl = primary.url || `https://${name}.tumblr.com`;
          t.blogBackfilledAt = new Date().toISOString();
          // 探测成功 != 落库成功。分开计数，避免「日志说回填了、库里其实没变」这种假成功。
          try {
            await flush(id, t);
            ok++;
            results.push({ id, blog: name, status: 'BACKFILLED', via: VIA_API ? 'api' : 'direct', tumblrName: user.name || null });
            console.log(`  [${ok + fail}/${work.length}] ✅ ${id} → blog=${name}  (${.replace(/^http:\/\/127\.0\.0\.1:/, 'port')}, ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
          } catch (e) {
            fail++;
            failures.push(`${id} → 探测到 blog=${name}，但写回落库失败: ${e.message}`);
            results.push({ id, blog: name, status: 'WRITE_FAILED', via: VIA_API ? 'api' : 'direct', error: e.message });
            console.log(`  [${ok + fail}/${work.length}] ⚠️ ${id} → 探测成功(${name}) 但写回失败: ${e.message}`);
          }
          return;
        }
        failures.push(`${id} → 200 但无 blog（blogs=${blogs.length}）`);
        break;
      } catch (e) {
        if (attempt === MAX_ATTEMPT - 1) failures.push(`${id} → ${e.message}`);
      } finally {
        try { if (dispatcher) dispatcher.destroy(); } catch (e) { /* ignore */ }
      }
    }
    fail++;
    results.push({ id, blog: '', status: 'FAILED', via: VIA_API ? 'api' : 'direct' });
    console.log(`  [${ok + fail}/${work.length}] ❌ ${id} 失败`);
  }

  // 简单并发池
  let cursor = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, work.length) }, async () => {
    while (cursor < work.length) {
      const idx = cursor++;
      await handleOne(work[idx], idx);
    }
  });
  await Promise.all(workers);

  console.log(`\n结果：成功 ${ok} / 失败 ${fail} / 共 ${work.length} | 耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (failures.length) { console.log('失败明细（前 15 条）:'); failures.slice(0, 15).forEach((f) => console.log('  -', f)); }

  if (DRY) {
    console.log('\n[dry-run] 未写入任何位置（仅在线探测；探测结果见上方日志）');
  } else if (ok > 0) {
    console.log(VIA_API
      ? `已热写 3002 共 ${written} 次（PUT /api/v14/data//:id）—— 内存态立即生效，无需重启`
      : `已直写 ${TOKEN_FILE}（${written} 次；服务已停，不会被覆盖）`);
    const remain = Object.keys(tokens).filter((id) => tokens[id].oauthToken && !tokens[id].blogName;
    console.log(`本地 token 文件中仍缺 blogName: ${remain} 个`);
  } else {
    console.log('无成功项，未写入');
  }

  if (WANT_JSON) {
    try {
      fs.mkdirSync(REPORT_DIR, { recursive: true });
      const out = path.join(REPORT_DIR, `blogname-backfill-${new Date().toISOString().slice(0, 10)}.json`);
      fs.writeFileSync(out, JSON.stringify({
        generatedAt: new Date().toISOString(),
        via: DRY ? 'dry-run' : (VIA_API ? 'api' : 'direct'),
        apiBase: VIA_API ? API_BASE : null,
        total: work.length, ok, fail, written,
        rows: results,
        failures: failures.slice(0, 50),
      }, null, 2));
      console.log(`JSON 报告 → ${out}`);
    } catch (e) {
      console.log(`⚠️ JSON 报告写入失败: ${e.message}`);
    }
  }
})().catch((e) => { console.error('执行异常:', e); process.exit(1); });
