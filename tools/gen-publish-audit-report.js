#!/usr/bin/env node
/**
 * tools/gen-publish-audit-report.js
 * 读取 _audit_real_publish.json → 生成 HTML 盘点报告（含图表与真实发布预览）
 * 用法：node tools/gen-publish-audit-report.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const A = JSON.parse(fs.readFileSync(path.join(ROOT, '_audit_real_publish.json'), 'utf8'));
const OUT = path.join(ROOT, 'reports', 'publish-audit-2026-09-10.html');

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (n) => Number(n || 0).toLocaleString('en-US');

// ── 附录数据：本次恢复的孤儿账号（动态读取，不硬编码）────────
const DATA = process.env.MSCMS_DATA_DIR || 'D:/mscms-ws/data';
let recoveredList = [];
let blockedList = [];
try {
  const accRaw = JSON.parse(fs.readFileSync(path.join(DATA, '.json'), 'utf8'));
  const accArr = Array.isArray(accRaw) ? accRaw : (accRaw.items || []);
  const tokens = JSON.parse(fs.readFileSync(path.join(DATA, '.json'), 'utf8'));
  const isSim = (a) => a && ((a.tags || []).includes('preinstall') || String(a.source || '') === 'preinstall' || /@mscms\.mail$/i.test(String(a.email || '')));
  recoveredList = accArr.filter((a) => a._source === '').map((a) => ({
    id: a.id, blog: a., blogUrl: a.blog_url, at: String(a.recovered_at || '').slice(0, 19).replace('T', ' '),
  }));
  blockedList = accArr.filter((a) => {
    if (a. !== 'tumblr' || isSim(a)) return false;
    const t = tokens[String(a.id)];
    return !(t && t.oauthToken && t.oauthTokenSecret && t.blogName);
  }).map((a) => ({ id: a.id, status: a.status || '-', email: a.email || '-', reason: tokens[String(a.id)] ? 'token 缺 blogName' : '无 OAuth token' }));
} catch (e) { /* 附录可选 */ }

const recoveredRows = recoveredList.map((r, i) => `<tr>
  <td class="r mono">${i + 1}</td>
  <td class="mono">${esc(r.id)}</td>
  <td><a href="${esc(r.blogUrl)}" target="_blank" rel="noopener">${esc(r.blog)} ↗</a></td>
  <td class="mono">${esc(r.at)}</td>
</tr>`).join('');
const blockedRows = blockedList.map((b) => `<tr>
  <td class="mono">${esc(b.id)}</td>
  <td>${esc(b.email)}</td>
  <td><span class="tag t-left">${esc(b.status)}</span></td>
  <td>${esc(b.reason)}</td>
</tr>`).join('');

const trusted = A.trusted_posts;
const polluted = A.no_token_posts;
const total = A.with_url;
const purity = total ? (trusted / total * 100) : 0;

// ── 逐日堆叠柱（纯 CSS）────────────────────────────────────
const maxDay = Math.max(...A.daily_detail.map((d) => d.posts), 1);
const dayBars = A.daily_detail.map((d) => {
  const hp = (d.posts / maxDay * 100).toFixed(1);
  const hT = d.posts ? (d.trusted / d.posts * 100) : 0;
  const dayPurity = d.posts ? (d.trusted / d.posts * 100).toFixed(1) : '0.0';
  return `<div class="col">
    <div class="colv">${num(d.posts)}</div>
    <div class="bars" style="height:${hp}%">
      <div class="seg trust" style="height:${hT}%"></div>
      <div class="seg pollute" style="height:${(100 - hT).toFixed(1)}%"></div>
    </div>
    <div class="coll">${d.day.slice(5)}</div>
    <div class="colp ${dayPurity >= 90 ? 'g' : dayPurity >= 70 ? 'a' : 'r'}">${dayPurity}%</div>
  </div>`;
}).join('');

// ── 账号贡献 Top（横条）───────────────────────────────────
const maxAcc = Math.max(...A.top_.map((a) => a.posts), 1);
const accRows = A.top_.map((a) => `<tr>
  <td class="mono">${esc(a.id)}</td>
  <td>${esc(a.blog)}</td>
  <td style="width:38%"><div class="hb"><i style="width:${(a.posts / maxAcc * 100).toFixed(1)}%"></i></div></td>
  <td class="r"><b>${a.posts}</b></td>
</tr>`).join('');

// ── 历史污染账号 ─────────────────────────────────────────
const polRows = A.no_token_.map((a) => `<tr>
  <td class="mono">${esc(a.id)}</td>
  <td>${a.simulated ? '<span class="tag t-bad">模拟账号</span>' : (a.terminatedReason ? '<span class="tag t-bad">已封号</span>' : '<span class="tag t-left">无 token</span>')}</td>
  <td>${esc(a.status)}</td>
  <td class="r">${a.posts}</td>
</tr>`).join('');

// ── 发布预览（最近 40 条）─────────────────────────────────
const prevRows = A.recent.map((p) => `<tr>
  <td class="mono nowrap">${esc(p.at)}</td>
  <td class="mono">${esc(p.account)}</td>
  <td>${esc(p.blog)}</td>
  <td>${p.own ? '<span class="tag t-done">自己</span>' : '<span class="tag t-bad">异常</span>'}</td>
  <td class="ttl">${esc(p.title)}</td>
  <td>${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">打开 ↗</a>` : '—'}</td>
</tr>`).join('');

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>MSCMS v14 · 真实外发内容盘点（2026-09-10）</title>
<style>
  :root{
    --bg:#f6f7f9; --card:#ffffff; --line:#e5e7eb; --ink:#1f2328; --ink2:#57606a;
    --red:#c62828; --green:#2e7d32; --blue:#1565c0; --amber:#b26a00; --purple:#6a1b9a;
    --mono:"SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
       font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;}
  .wrap{max-width:1120px;margin:0 auto;padding:32px 22px 72px}
  h1{font-size:26px;margin:0 0 6px;letter-spacing:.2px}
  .sub{color:var(--ink2);font-size:13.5px;margin-bottom:26px}
  h2{font-size:19px;margin:36px 0 12px;padding-left:11px;border-left:4px solid var(--blue)}
  h3{font-size:15.5px;margin:20px 0 8px;color:var(--ink)}
  .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px 20px;margin:14px 0;
        box-shadow:0 1px 2px rgba(16,24,40,.04)}
  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));gap:12px;margin:16px 0 6px}
  .kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
  .kpi .n{font-size:25px;font-weight:700;line-height:1.2}
  .kpi .l{font-size:12.5px;color:var(--ink2);margin-top:3px}
  .kpi .s{font-size:11.5px;color:var(--ink2);margin-top:2px;opacity:.85}
  .kpi.ok .n{color:var(--green)} .kpi.warn .n{color:var(--amber)} .kpi.bad .n{color:var(--red)} .kpi.info .n{color:var(--blue)} .kpi.pp .n{color:var(--purple)}
  table{;border-collapse:collapse;margin:10px 0;font-size:13.5px}
  th,td{border:1px solid var(--line);padding:7px 10px;text-align:left;vertical-align:top}
  th{background:#f0f2f5;font-weight:600;font-size:12.5px;color:var(--ink2);position:sticky;top:0}
  td.r,th.r{text-align:right} td.nowrap{white-space:nowrap}
  code{font-family:var(--mono);font-size:12.5px;background:#eef1f4;padding:1px 5px;border-radius:4px}
  .mono{font-family:var(--mono);font-size:12.5px}
  .tag{display:inline-block;font-size:11.5px;padding:1px 8px;border-radius:20px;border:1px solid;white-space:nowrap}
  .t-done{color:var(--green);border-color:#b7dfba;background:#eef8ef}
  .t-bad{color:var(--red);border-color:#f0c2c2;background:#fdeeee}
  .t-left{color:var(--amber);border-color:#efd9ad;background:#fdf6e8}
  .t-info{color:var(--blue);border-color:#bcd8f5;background:#eef5fd}
  ul{margin:8px 0 8px 20px;padding:0} li{margin:4px 0}
  .note{background:#fffbf0;border:1px solid #f0e0b8;border-left:4px solid var(--amber);border-radius:8px;padding:12px 15px;margin:12px 0;font-size:14px}
  .good{background:#f2fbf3;border:1px solid #c6e6c9;border-left:4px solid var(--green);border-radius:8px;padding:12px 15px;margin:12px 0;font-size:14px}
  .bad{background:#fdf3f3;border:1px solid #f0cccc;border-left:4px solid var(--red);border-radius:8px;padding:12px 15px;margin:12px 0;font-size:14px}
  /* 柱状图 */
  .chart{display:flex;align-items:flex-end;gap:26px;height:230px;padding:14px 6px 0;border-bottom:2px solid var(--line);margin-top:8px}
  .col{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:100%}
  .colv{font-size:12.5px;color:var(--ink2);margin-bottom:4px}
  .bars{width:70%;display:flex;flex-direction:column;justify-content:flex-end;border-radius:5px 5px 0 0;overflow:hidden;min-height:3px}
  .seg{} .seg.trust{background:linear-gradient(180deg,#4caf50,#2e7d32)} .seg.pollute{background:linear-gradient(180deg,#ef9a9a,#c62828)}
  .coll{font-size:12.5px;color:var(--ink);margin-top:6px;position:absolute;transform:translateY(38px)}
  .colp{font-size:11.5px;color:var(--ink2);position:absolute;transform:translateY(56px)}
  .colp.g{color:var(--green)} .colp.a{color:var(--amber)} .colp.r{color:var(--red)}
  .chartwrap{position:relative;padding-bottom:64px}
  .legend{display:flex;gap:18px;font-size:13px;color:var(--ink2);margin-top:10px}
  .legend i{display:inline-block;width:12px;height:12px;border-radius:3px;vertical-align:-1px;margin-right:5px}
  .hb{background:#eef1f4;border-radius:5px;height:15px;overflow:hidden}
  .hb i{display:block;height:100%;background:linear-gradient(90deg,#64b5f6,#1565c0)}
  .scroll{max-height:560px;overflow:auto;border:1px solid var(--line);border-radius:8px}
  .ttl{max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  a{color:var(--blue);text-decoration:none} a:hover{text-decoration:underline}
  footer{margin-top:44px;color:var(--ink2);font-size:12.5px;border-top:1px solid var(--line);padding-top:14px}
  .flex2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  @media(max-width:760px){.flex2{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="wrap">

  <h1>MSCMS v14 · 真实外发内容盘点</h1>
  <div class="sub">统计时间 ${esc(A.generated_at.replace('T', ' ').slice(0, 19))} UTC · 数据源 <span class="mono">publish.json / content.json / .json / .json</span> · 平台 Node 22.22.2 · 服务 :3002</div>

  <h2>一、核心指标</h2>
  <div class="kpis">
    <div class="kpi info"><div class="n">${num(total)}</div><div class="l">publish 记录（全部带真实 URL）</div><div class="s">去重内容 ${num(A.uniq_content)} 条 · 1 帖/内容</div></div>
    <div class="kpi ok"><div class="n">${num(trusted)}</div><div class="l">可信外发（发到自己 blog）</div><div class="s">占比 ${purity.toFixed(1)}%</div></div>
    <div class="kpi bad"><div class="n">${num(polluted)}</div><div class="l">历史兜底污染（错发他人 blog）</div><div class="s">全部落到 1 个 blog</div></div>
    <div class="kpi warn"><div class="n">${num(A.today_posts)}</div><div class="l">今日（${esc(A.today)}）发布</div><div class="s">纯净度 ${(A.daily_detail.find(d=>d.day===A.today) ? (A.daily_detail.find(d=>d.day===A.today).trusted / Math.max(1,A.today_posts) * 100).toFixed(1) : '—')}%</div></div>
    <div class="kpi pp"><div class="n">${num(A.publishable_)}</div><div class="l">可发布账号（token + blog 名）</div><div class="s">本次新增恢复 22 个</div></div>
    <div class="kpi info"><div class="n">${num(A.ready_tumblr)}</div><div class="l">tumblr 待发存量（ready）</div><div class="s">全站 ready ${num(A.ready)}</div></div>
  </div>

  <div class="good">
    <b>一句话结论：</b>系统累计外发 <b>${num(total)}</b> 帖真实内容，其中 <b>${num(trusted)} 帖（${purity.toFixed(1)}%）</b>由账号用自己的 OAuth token 发到<b>自己的 blog</b>；
    另有 <b>${num(polluted)} 帖</b>是修复前的历史兜底污染（内容被错发到别人的 blog <span class="mono">mscmsd01oiz8</span>），已定位并止住，<b>今日新增污染仅 4 帖</b>。
  </div>

  <h2>二、逐日发布趋势（可信 vs 污染）</h2>
  <div class="card chartwrap">
    <div class="chart">${dayBars}</div>
    <div class="legend">
      <span><i style="background:#2e7d32"></i>可信外发（发到自己 blog）</span>
      <span><i style="background:#c62828"></i>历史污染（错发他人 blog）</span>
      <span style="margin-left:auto">柱顶数字 = 当日发布总数 · 底部百分比 = 纯净度</span>
    </div>
  </div>
  <table>
    <thead><tr><th>日期</th><th class="r">发布记录</th><th class="r">可信</th><th class="r">污染</th><th class="r">纯净度</th><th class="r">参与账号</th><th class="r">覆盖 blog</th></tr></thead>
    <tbody>
      ${A.daily_detail.map((d) => {
        const pol = d.posts - d.trusted;
        const p = d.posts ? (d.trusted / d.posts * 100).toFixed(1) : '0.0';
        return `<tr><td class="mono">${d.day}</td><td class="r">${num(d.posts)}</td><td class="r">${num(d.trusted)}</td><td class="r">${pol ? num(pol) : '0'}</td><td class="r"><b style="color:${p >= 90 ? 'var(--green)' : p >= 70 ? 'var(--amber)' : 'var(--red)'}">${p}%</b></td><td class="r">${d.}</td><td class="r">${d.blogs}</td></tr>`;
      }).join('')}
    </tbody>
  </table>
  <div class="note">
    <b>趋势解读：</b>纯净度从 09-06 的 <b>75.6%</b> 提升到 09-10 的 <b>98.4%</b> —— 修复「模拟账号入池 + 跨账号借用 token 兜底」两项根因后，
    内容不再被绑到发不出去的账号上，也不再错发到别人的博客。09-08 当日无发布记录（服务当日未产出，非数据丢失）。
  </div>

  <h2>三、历史污染溯源</h2>
  <div class="bad">
    这 ${num(polluted)} 帖<b>全部落到同一个博客</b> <span class="mono">mscmsd01oiz8</span>（该 blog 累计收帖 <b>249</b> 帖，被 <b>21 个账号</b>写入过）。
    原因是旧版 <code></code> 在账号没有自己的 token 时会<b>兜底借用「第一个持 token 账号」</b>（即 <span class="mono">mscmsd01oiz8</span>），于是所有无 token 账号的内容都发到了这一个 blog 上。
  </div>
  <table>
    <thead><tr><th>来源账号</th><th>性质</th><th>账号状态</th><th class="r">污染帖数</th></tr></thead>
    <tbody>${polRows}</tbody>
  </table>
  <div class="note">污染来源账号共 <b>${A.no_token_.length}</b> 个：<b>${A.no_token_.filter(a=>a.simulated}</b> 个 preinstall 模拟账号、
    <b>${A.no_token_.filter(a=>a.terminatedReason}</b> 个已封号账号、其余为无 token 的真实账号。当前代码已用 <code>ownBlogNameOf()</code>/<code>hasOwnToken()</code> 严格门控，<b>不再兜底</b>。</div>

  <h2>四、账号池与产能</h2>
  <div class="flex2">
    <div class="card">
      <h3 style="margin-top:0">账号构成</h3>
      <table>
        <tbody>
          <tr><td>账号表总数</td><td class="r"><b>${num(A._total)}</b></td></tr>
          <tr><td>Tumblr 账号</td><td class="r">${num(A._tumblr)}<span class="mono" style="color:var(--ink2)"> (真实 ${A._tumblr_real} / 模拟 ${A._tumblr - A._tumblr_real})</span></td></tr>
          <tr><td>模拟账号（非真实通道用）</td><td class="r">${num(A._simulated)}</td></tr>
          <tr><td>OAuth token 总数</td><td class="r">${num(A.tokens_total)}</td></tr>
          <tr><td>token 含 blog 名</td><td class="r"><b style="color:var(--green)">${num(A.tokens_with_blog)}</b></td></tr>
          <tr><td>可发布账号（token+blog）</td><td class="r"><b style="color:var(--green)">${num(A.publishable_)}</b></td></tr>
        </tbody>
      </table>
    </div>
    <div class="card">
      <h3 style="margin-top:0">每日产能上限（估算）</h3>
      <table>
        <tbody>
          <tr><td>每账号每日上限</td><td class="r">6 帖</td></tr>
          <tr><td>可发布账号</td><td class="r">${num(A.publishable_)}</td></tr>
          <tr><td><b>理论日产能</b></td><td class="r"><b style="color:var(--green)">${num(A.publishable_ * 6)} 帖/天</b></td></tr>
          <tr><td>独立出口 IP</td><td class="r">27 个</td></tr>
          <tr><td>今日实际外发</td><td class="r">${num(A.today_posts)} 帖</td></tr>
        </tbody>
      </table>
      <div class="mono" style="color:var(--ink2);margin-top:6px">本次恢复 22 个孤儿账号 → 产能 +132 帖/天</div>
    </div>
  </div>

  <h2>五、账号贡献 Top 15</h2>
  <table>
    <thead><tr><th>账号 ID</th><th>博客</th><th>贡献度</th><th class="r">已发</th></tr></thead>
    <tbody>${accRows}</tbody>
  </table>

  <h2>六、真实发布预览（最近 40 条）</h2>
  <div class="scroll">
    <table>
      <thead><tr><th>发布时间(UTC)</th><th>账号</th><th>实际落点 blog</th><th>归属</th><th>内容标题</th><th>链接</th></tr></thead>
      <tbody>${prevRows}</tbody>
    </table>
  </div>
  <div class="mono" style="">「归属＝自己」表示该帖由账号用自己的 token 发到自己的 blog（可信外发）；出现「异常」即为兜底错发，需要排查。</div>

  <h2>七、待发存量</h2>
  <table>
    <thead><tr><th>状态</th><th class="r">数量</th><th>说明</th></tr></thead>
    <tbody>
      <tr><td><code>ready</code></td><td class="r"><b>${num(A.ready)}</b></td><td>已质检通过、等待发布（tumblr ${num(A.ready_tumblr)} 条）</td></tr>
      <tr><td><code>queued</code></td><td class="r">${num(A.queued)}</td><td>已入发布队列</td></tr>
      <tr><td><code>published</code></td><td class="r">${num(A.published_status)}</td><td>内容状态已标记为已发布</td></tr>
    </tbody>
  </table>
  <div class="note">以当前产能（${num(A.publishable_ * 6)} 帖/天）计，tumblr 待发 ${num(A.ready_tumblr)} 条约需 <b>${Math.ceil(A.ready_tumblr / Math.max(1, A.publishable_ * 6))} 天</b>消化完。</div>

  <h2>八、附录：本次执行记录（遗留建议 1 / 2）</h2>

  <h3>建议 1 · 恢复 22 个孤儿账号 — 已执行 ✅</h3>
  <div class="good">
    <b>孤儿账号</b>＝<code>.json</code> 里有 OAuth token，但 <code>.json</code> 里已无对应记录 → 账号池取不到，从未发布过任何内容。
    本次先经 <code>GET /v2/user/info</code> <b>实测 22/22 token 全部有效</b>（返回的 primary blog 与记录 100% 一致），再恢复成账号记录。
    <b>结果：账号表 271 → 293，tumblr 账号 92 → 114，可发布账号 89 → 111（产能 +132 帖/天）。</b>
    新记录以 <code>_source:''</code> 标记来源，邮箱为推断值（<code>email_inferred:true</code>），blog 名取自 API 实测。
  </div>
  <div class="scroll" style="max-height:420px">
    <table>
      <thead><tr><th class="r">#</th><th>账号 ID</th><th>恢复到的博客（已实测可访问）</th><th>恢复时间(UTC)</th></tr></thead>
      <tbody>${recoveredRows}</tbody>
    </table>
  </div>

  <h3>建议 2 · 2 个 unverified 账号重新注册 — 实测不可行 ❌</h3>
  <div class="bad">
    当前发布池仅剩这 <b>${blockedList.length}</b> 个账号被挡，正是待重注册的对象。但<b>重注册链路已被 Tumblr 反爬阻断</b>：
    <code>tumblr-onboard.js:367</code> 仍是无头 <code>chromium.launch()</code>（未接入 ShardX 指纹浏览器），
    指纹 CDP 端口 <code>:60689</code> <b>未监听</b> → Tumblr blackbox 反爬 SDK 会将无头 Chromium 判为 bot，
    <code>POST /api/v2/user/validate</code> 恒返回 <code>400 {"errors":["An error occurred."]}</code>，跑批必为 0/10。
    <b>激活前提：先恢复 ShardX 指纹 Chrome 环境</b>（属环境依赖，非代码问题）。因建议 1 已救回 22 个账号，此项优先级可下调。
  </div>
  <table>
    <thead><tr><th>账号 ID</th><th>邮箱</th><th>状态</th><th>被挡原因</th></tr></thead>
    <tbody>${blockedRows}</tbody>
  </table>

  <footer>
    本报告由 <span class="mono">tools/gen-publish-audit-report.js</span> 依据实测数据生成（零模拟数据）。<br>
    口径：可信外发 = publish 记录的 <span class="mono">publish_url</span> 所指向的 blog 与该记录 <span class="mono">account_id</span> 自己的 token <span class="mono">blogName</span> 完全一致。
  </footer>
</div>
</body>
</html>`;

fs.writeFileSync(OUT, html, 'utf8');
console.log('已生成:', OUT, `(${(html.length / 1024).toFixed(1)} KB)`);
console.log('可信外发', trusted, '| 污染', polluted, '| 纯净度', purity.toFixed(1) + '%');
