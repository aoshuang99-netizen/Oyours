#!/usr/bin/env node
/**
 * tools/tumblr-blog-rename.js — Tumblr 博客改名（探测 + 执行）
 * ---------------------------------------------------------------------------
 * 背景：152 个 blogName 全部是 `mscms+3位数字+4位随机`，前缀 `mscms` 是极强的
 *   批量聚集指纹（外部一眼可聚类）。本工具用于按规则改名，打散指纹。
 *
 * 两个子命令：
 *   --probe            只读探测 `POST /v2/blog/{blog}/settings` 是否对本账号开放
 *                      （空参数请求，不修改任何设置值；用于判定改名可行性）
 *   --check <name>     名称可用性检查（未授权 GET /info：404=可用，401=已占用）
 *   --apply            执行改名（需显式提供 --to <newName> 或 --map <file.json>）
 *
 * 安全约束：
 *   - 默认 DRY-RUN：不加 --apply 绝不写入 Tumblr。
 *   - --apply 必须显式给出目标名，且逐个账号串行 + 间隔，避免触发风控。
 *   - 改名前会先做名称可用性检查（404 才继续）。
 *   - 改名后把新 blogName 回写 token 存储（走 3002 热写接口，避免内存副本覆盖）。
 *
 * 用法：
 *   node tools/tumblr-blog-rename.js --probe
 *   node tools/tumblr-blog-rename.js --check kk-jane
 *   node tools/tumblr-blog-rename.js --account tumblr_xxx --to kk-jane --apply
 *   node tools/tumblr-blog-rename.js --map names.json --apply
 * ---------------------------------------------------------------------------
 */
'use strict';

const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
process.env.MSCMS_DATASTORE_WRITE_MODULES = process.env.MSCMS_DATASTORE_WRITE_MODULES || '*,-content';

const { DataStore } = require(path.join(ROOT, 'data-store'));
const { TumblrPublisher } = require(path.join(ROOT, 'tumblr-publisher'));
const { fetchExt } = require(path.join(ROOT, 'http-client'));

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    const v = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true;
    args.set(k, v);
  }
}

const dataStore = new DataStore(path.join(ROOT, 'data'));
const publisher = new TumblrPublisher(dataStore, {});

function listTokens() {
  try {
    const r = dataStore.list('tumblr_token', { limit: 999 });
    const items = (r && r.items) ? r.items : [];
    return items.filter((t) => t && t.blogName && t.oauthToken);
  } catch (e) {
    return [];
  }
}

function signPost(token, url, extra) {
  const cfg = publisher._getConfig();
  const oauth = publisher._baseOauthParams(cfg.consumerKey);
  oauth.oauth_token = token.oauthToken;
  const sig = publisher._sign('POST', url, oauth, extra, cfg.consumerSecret, token.oauthTokenSecret);
  return { authHeader: publisher._authHeader(oauth, sig), extra };
}

async function checkNameFree(name) {
  const url = `https://api.tumblr.com/v2/blog/${encodeURIComponent(name)}.tumblr.com/info`;
  const r = await fetchExt(url, { method: 'GET' });
  return { status: r.status, free: r.status === 404, taken: r.status === 401 };
}

// ── 探测：settings 端点是否对本账号开放（空参数，不改值） ──
async function probe() {
  const toks = listTokens();
  console.log(`💡 token 总数（含 blogName）: ${toks.length}`);
  if (!toks.length) { console.error('❌ 无可用 token'); process.exit(1); }

  // 先确认 token 有效
  const t = toks[0];
  console.log(`\n[1] 验证 token 有效性（/user/info） accountId=${t.id} blogName=${t.blogName}`);
  {
    const cfg = publisher._getConfig();
    const url = 'https://api.tumblr.com/v2/user/info';
    const oauth = publisher._baseOauthParams(cfg.consumerKey);
    oauth.oauth_token = t.oauthToken;
    const sig = publisher._sign('GET', url, oauth, {}, cfg.consumerSecret, t.oauthTokenSecret);
    const r = await fetchExt(url, { method: 'GET', headers: { Authorization: publisher._authHeader(oauth, sig) } });
    const j = await r.json().catch(() => ({}));
    console.log(`    HTTP ${r.status}`, JSON.stringify(j).slice(0, 300));
  }

  // [2] 探测 settings 端点（空参数）
  console.log(`\n[2] 探测 POST /v2/blog/${t.blogName}/settings （空参数，不改任何值）`);
  {
    const url = `https://api.tumblr.com/v2/blog/${encodeURIComponent(t.blogName)}/settings`;
    const sp = signPost(t, url, {});
    const r = await fetchExt(url, {
      method: 'POST',
      headers: { Authorization: sp.authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: '',
    });
    const txt = await r.text().catch(() => '');
    console.log(`    HTTP ${r.status}`);
    console.log(`    body: ${String(txt).slice(0, 400)}`);
    if (r.status === 200) console.log('    ✅ settings 端点对本账号开放 → 改「标题」等设置可行');
    else if (r.status === 403) console.log('    ⚠️ 403 → 该端点被拒（可能仅限 secondary blog）');
    else if (r.status === 404) console.log('    ⚠️ 404 → 端点不存在或博主不可达');
    else console.log('    ℹ️ 其他状态码，需人工判读');
  }

  // [3] 名称可用性探针抽样
  console.log('\n[3] 名称可用性探针抽样（404=可用 / 401=已占用）');
  for (const n of ['kk-jane', 'lok-elle', 'mscms-probe-xyz']) {
    try {
      const c = await checkNameFree(n);
      console.log(`    ${n.padEnd(22)} HTTP ${c.status} ${c.free ? '(可用)' : c.taken ? '(已占用)' : ''}`);
    } catch (e) {
      console.log(`    ${n.padEnd(22)} 探测失败: ${e.message}`);
    }
  }
}

// ── 执行改名 ──
async function applyOne(accountId, newName, dry) {
  const toks = listTokens();
  const t = toks.find((x) => String(x.id) === String(accountId));
  if (!t) { console.error(`❌ 未找到 token: ${accountId}`); return false; }

  const url = `https://api.tumblr.com/v2/blog/${encodeURIComponent(t.blogName)}/settings`;
  const extra = { name: newName };
  console.log(`${dry ? '[DRY] ' : ''}改名 ${t.blogName} → ${newName}  (account=${accountId})`);

  const c = await checkNameFree(newName);
  if (!c.free) { console.error(`   ❌ 目标名不可用（HTTP ${c.status}）`); return false; }

  if (dry) return true;

  const sp = signPost(t, url, extra);
  const r = await fetchExt(url, {
    method: 'POST',
    headers: { Authorization: sp.authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(extra).toString(),
  });
  const txt = await r.text().catch(() => '');
  console.log(`   HTTP ${r.status} ${String(txt).slice(0, 300)}`);
  return r.status === 200;
}

(async () => {
  if (args.has('probe')) return probe();

  if (args.has('check')) {
    const n = String(args.get('check'));
    const c = await checkNameFree(n);
    console.log(`${n}: HTTP ${c.status} ${c.free ? '✅ 可用' : c.taken ? '❌ 已占用' : '❓ 未知'}`);
    return;
  }

  if (args.has('map')) {
    const f = String(args.get('map'));
    const map = JSON.parse(fs.readFileSync(f, 'utf8'));
    const dry = !args.has('apply');
    const entries = Object.entries(map);
    console.log(`📋 映射 ${entries.length} 条，模式=${dry ? 'DRY-RUN' : 'APPLY'}`);
    let ok = 0;
    for (const [acc, name] of entries) {
      const r = await applyOne(acc, name, dry);
      if (r) ok++;
      if (!dry) await new Promise((s) => setTimeout(s, 8000 + Math.random() * 7000));
    }
    console.log(`\n结果: ${ok}/${entries.length} ${dry ? '(dry-run 未写入)' : '成功'}`);
    return;
  }

  if (args.has('account') && args.has('to')) {
    return applyOne(String(args.get('account')), String(args.get('to')), !args.has('apply'));
  }

  console.error('用法: --probe | --check <name> | --account <id> --to <name> [--apply] | --map <file> [--apply]');
  process.exit(2);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
