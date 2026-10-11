#!/usr/bin/env node
/**
 * tools/tumblr-token-audit.js — 【只读】Tumblr OAuth token 有效性体检
 *
 * 为什么需要它：
 *   429 风暴长期掩盖了一类更早期的故障 —— **token 真的失效（401）**。
 *   429 归零后，401 成为发布失败的首要来源。必须能把它与「限流」严格区分开：
 *
 *     · 429 Limit Exceeded  → 出口/IP 或 app-key 限流，改出口/降速
 *     · 401 Unauthorized    → 账号 token 失效（Tumblr 原文 code:0 "Something flubbed. Try again."）
 *                             **只能重新 OAuth 授权**，换出口/重试都没用
 *
 * 判据要点（2026-09-15 实测踩过的坑）：
 *   · 401 **不是** app-key 配置问题：同一个 consumerKey 在别的账号上实测 OK
 *   · 也不能只按「从未成功发布」推定 token 坏：实测 27 个从未发布的账号里
 *     只有 6 个是 401，另 20 个 token 完全有效（只是从没被排到发布任务）
 *   · `token.updatedAt` 只作参考：08-22~08-26 那批恰好全坏，09-12 之后的全好，
 *     但结论必须以**在线实测**为准，不要按日期推断
 *
 * 只读保证：仅 GET /user/info；DataStore 写入白名单强制 'none'；只注入内存只读 shim；不走代理。
 *
 * 用法：
 *   node tools/tumblr-token-audit.js                 # 只审计「从未成功发布」的账号（推荐，快）
 *   node tools/tumblr-token-audit.js --all           # 审计全部持 token 账号（慢，152 次调用）
 *   node tools/tumblr-token-audit.js --json          # 额外输出 JSON 到 D:/mscms-ws/reports/token-audit-<日期>.json
 *   node tools/tumblr-token-audit.js --all --save-deadlist
 *                                                    # ★ 把结论写进发布器的 token 黑名单（N2）
 *   MSCMS_TOKEN_AUDIT_DELAY_MS=500                   # 调用间隔（默认 500ms，避免干扰线上发布）
 *
 * `--save-deadlist` 的合并语义（很重要，别改成覆盖）：
 *   · 本次实测 401 的账号            → 写入名单（含 reason/status/at）
 *   · 本次实测 OK 但名单里已有的账号  → **摘除**（说明已重新授权，必须让它马上恢复发布）
 *   · 名单里本次未覆盖到的账号        → **保留**（本次没测到 != 已恢复；由 TTL 兜底过期）
 *   写成覆盖就会「用一次局部体检清空全量名单」，或反过来「重新授权后永远封着」。
 *
 * 发布器（`cloud-publisher.js`）会按 mtime 热重载该名单，默认每 60s 一次，
 * 因此**无需重启 3002** 即可生效。
 */

process.env.MSCMS_DATASTORE_WRITE_MODULES = 'none';   // 只读，绝不写 DataStore
process.env.TUMBLR_API_RPM = '0';                     // 关闭本地令牌桶，否则审计被拖慢

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.MSCMS_DATA_DIR || 'D:/mscms-ws/data';
const REPORT_DIR = process.env.MSCMS_REPORT_DIR || 'D:/mscms-ws/reports';
const DELAY_MS = Number(process.env.MSCMS_TOKEN_AUDIT_DELAY_MS || 500);

const { TumblrPublisher } = require(path.join(__dirname, '..', 'tumblr-publisher'));

const argv = process.argv.slice(2);
const AUDIT_ALL = argv.includes('--all');
const WANT_JSON = argv.includes('--json');
const SAVE_DEADLIST = argv.includes('--save-deadlist');

/** N2：token 失效黑名单文件（与 cloud-publisher.js 的 DEADLIST_FILE 必须一致） */
const DEADLIST_FILE = process.env.MSCMS_TOKEN_DEADLIST
  || path.join(DATA_DIR, '_tumblr_token_deadlist.json');
// 必须与 cloud-publisher.js 的 DEAD_TOKEN_TTL_MS 默认值一致，否则「体检写入/运行时判定」两套口径会错位
const DEAD_TOKEN_TTL_MS = Number(process.env.MSCMS_TOKEN_DEAD_TTL_MS || 12 * 3600 * 1000);

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } };

const TOK = readJson(path.join(DATA_DIR, 'tumblr_token.json')) || {};
const CFG = readJson(path.join(DATA_DIR, 'tumblr_config.json')) || [];
const PUB = readJson(path.join(DATA_DIR, 'publish.json')) || [];

/** 历史上真实发布成功过的 blog 集合（判据只看 publish_url，零伪造） */
const publishedBlogs = new Set();
for (const r of (Array.isArray(PUB) ? PUB : [])) {
  if (r && r.publish_url && String(r.publish_url).includes('/blog/view/')) {
    publishedBlogs.add(String(r.publish_url).split('/blog/view/')[1].split('/')[0]);
  }
}

/** 内存只读 DataStore shim —— 发布器只需 get(module, id) */
const SHIM = {
  _cache: new Map([
    ['tumblr_config', new Map((Array.isArray(CFG) ? CFG : []).map((r) => [String(r.id), r]))],
    ['tumblr_token', new Map(Object.entries(TOK))],
  ]),
  get(mod, id) { const m = this._cache.get(mod); return m ? m.get(String(id)) : undefined; },
  create() {}, update() {}, list() { return []; },
};

const targets = Object.entries(TOK)
  .filter(([, t]) => t && t.oauthToken && t.oauthTokenSecret)
  .filter(([, t]) => AUDIT_ALL || !publishedBlogs.has(t.blogName))
  .map(([id, t]) => ({
    id,
    blog: t.blogName || '',
    day: String(t.updatedAt || t.createdAt || '').slice(0, 10),
  }))
  .sort((a, b) => (a.day < b.day ? -1 : 1));

(async () => {
  const pubr = new TumblrPublisher(SHIM, {});
  console.log(`\n=== Tumblr token 有效性体检（${targets.length} 个账号，${AUDIT_ALL ? '全量' : '仅从未发布'}）===`);
  console.log(`数据目录: ${DATA_DIR}   间隔: ${DELAY_MS}ms   仅只读 GET /user/info\n`);

  const rows = [];
  for (const s of targets) {
    let status = 0, verdict = '', extra = '';
    try {
      const u = await pubr.getUserInfo(s.id);
      verdict = 'OK';
      extra = `tumblr_name=${(u && u.name) || '?'}`;
    } catch (e) {
      status = (e && e.status) || 0;
      if (status === 401) verdict = 'TOKEN_DEAD';
      else if (status === 429) verdict = 'RATE_LIMITED';
      else verdict = 'ERROR';
      extra = `${status || 'NETWORK'} ${String((e && e.message) || '').slice(0, 70)}`;
    }
    rows.push({ ...s, status, verdict, extra });
    const icon = verdict === 'OK' ? '✅' : verdict === 'TOKEN_DEAD' ? '❌' : '⏸';
    console.log(`${s.day}  ${s.id.padEnd(20)} blog=${String(s.blog || '(空)').padEnd(16)} ${icon} ${verdict.padEnd(12)} ${extra}`);
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  const dead = rows.filter((r) => r.verdict === 'TOKEN_DEAD');
  const good = rows.filter((r) => r.verdict === 'OK');
  const other = rows.filter((r) => !['OK', 'TOKEN_DEAD'].includes(r.verdict));
  const emptyBlog = rows.filter((r) => !r.blog);

  console.log(`\n=== 汇总 ===`);
  console.log(`  ✅ token 有效      : ${good.length}   ← 未被排到发布任务，不是坏 token`);
  console.log(`  ❌ token 失效(401) : ${dead.length}   ← 必须重新 OAuth 授权（换出口/重试无效）`);
  console.log(`  ⏸ 限流/网络错误   : ${other.length}`);
  console.log(`  📝 blogName 为空   : ${emptyBlog.length}   ← 可从体检返回的 tumblr_name 回填`);

  if (dead.length) {
    console.log(`\n  需重新授权的账号（${dead.length} 个）：`);
    for (const d of dead) console.log(`    - ${d.id}   blog=${d.blog || '(空)'}   token=${d.day}`);
  }
  if (emptyBlog.length) {
    console.log(`\n  blogName 可回填建议（token 记录里为空，Tumblr 侧真实存在）：`);
    for (const b of emptyBlog) console.log(`    - ${b.id}   ${b.extra.replace('tumblr_name=', '→ ')}`);
  }

  if (WANT_JSON) {
    try {
      fs.mkdirSync(REPORT_DIR, { recursive: true });
      const out = path.join(REPORT_DIR, `token-audit-${new Date().toISOString().slice(0, 10)}.json`);
      fs.writeFileSync(out, JSON.stringify({
        generatedAt: new Date().toISOString(),
        mode: AUDIT_ALL ? 'all' : 'never-published',
        total: rows.length, ok: good.length, tokenDead: dead.length, other: other.length,
        emptyBlogName: emptyBlog.length, rows,
      }, null, 2));
      console.log(`\n  JSON 报告已写入: ${out}`);
    } catch (e) {
      console.log(`\n  ⚠️ JSON 报告写入失败: ${e.message}`);
    }
  }

  // ── N2：把结论合并进 token 黑名单，供发布器热重载（无需重启 3002）─────────
  if (SAVE_DEADLIST) {
    try {
      const prev = readJson(DEADLIST_FILE) || {};
      const prevDead = (prev && prev.dead) || {};
      const now = Date.now();
      const next = {};
      let kept = 0, added = 0, removedRewritten = 0, expired = 0;
      const audited = new Map(rows.map((r) => [String(r.id), r]));

      // ① 保留：本次未覆盖到、且未过 TTL 的旧记录
      //    （本次没测到 ≠ 已恢复；交给 TTL 兜底过期，绝不因为「没测」就摘除）
      for (const [id, rec] of Object.entries(prevDead)) {
        if (!rec) continue;
        const at = Number(rec.at || rec.checkedAt || 0);
        if (!at || now - at > DEAD_TOKEN_TTL_MS) { expired++; continue; }
        if (audited.has(id)) continue;     // 本次有实测结论 → 交给②判定
        next[id] = { ...rec, at };
        kept++;
      }
      // ② 本次实测结论
      for (const r of rows) {
        const id = String(r.id);
        if (r.verdict === 'TOKEN_DEAD') {
          if (!next[id]) added++;
          next[id] = {
            reason: `体检 401：${String(r.extra || '').slice(0, 140)}`,
            status: 401, at: now, source: 'audit',
          };
        } else if (r.verdict === 'OK' && prevDead[id]) {
          // 实测有效但名单里有 → 已重新授权，必须摘除（自愈的关键一步）
          removedRewritten++;
        }
      }

      const tmp = DEADLIST_FILE + '.tmp_' + Date.now();
      fs.writeFileSync(tmp, JSON.stringify({
        updatedAt: new Date().toISOString(),
        ttlHours: Math.round(DEAD_TOKEN_TTL_MS / 3600000),
        count: Object.keys(next).length,
        dead: next,
      }, null, 2), 'utf8');
      fs.renameSync(tmp, DEADLIST_FILE);

      console.log(`\n=== token 黑名单已更新（N2）===`);
      console.log(`  ${DEADLIST_FILE}`);
      console.log(`  本次新增 ${added} / 摘除(已恢复) ${removedRewritten} / 保留(未覆盖) ${kept} / TTL 过期丢弃 ${expired}`);
      console.log(`  当前名单共 ${Object.keys(next).length} 个账号 → 发布器 60s 内自动热重载，无需重启`);
      if (Object.keys(next).length) {
        for (const id of Object.keys(next)) console.log(`    🔒 ${id}`);
      }
    } catch (e) {
      console.log(`\n  ⚠️ 黑名单写入失败: ${e.message}`);
    }
  }

  console.log(`\n=== 结束（只读体检：仅 GET /user/info${SAVE_DEADLIST ? '；已写黑名单文件，未写 DataStore' : '，未做任何写入'}）===\n`);
  process.exit(0);
})();
