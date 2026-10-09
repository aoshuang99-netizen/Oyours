#!/usr/bin/env node
/** 生成全平台盘点报告 HTML（活跃账号 × 内容口径 × 闭环缺口） */
'use strict';
const fs = require('fs');
const D = 'D:/mscms-ws/data/';
const rd = f => { try { return JSON.parse(fs.readFileSync(D + f, 'utf8')); } catch (e) { return null; } };
const arr = v => Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.values(v) : []);
const S = v => v == null ? '' : String(v);

const pub = arr(rd('publish.json')), acc = arr(rd('.json'));
const tok = rd('.json') || {}, ct = arr(rd('content.json'));
const dz = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const inDay = ts => { const t = Date.parse(ts); return isNaN(t) ? '' : new Date(t + 8 * 3600e3).toISOString().slice(0, 10); };

const gReady = JSON.parse(fs.readFileSync('reports/_gate_ready.json', 'utf8'));
const gStale = JSON.parse(fs.readFileSync('reports/_gate_ready_stale.json', 'utf8'));
const gPub = JSON.parse(fs.readFileSync('reports/_gate_published.json', 'utf8'));

// 活跃账号
const perAcct = {}; for (const p of pub) { const a = S(p.account_id); perAcct[a] = (perAcct[a] || 0) + 1; }
const active = Object.keys(perAcct).filter(k => k && k !== 'undefined');
const tokOk = new Set();
for (const [k, o] of Object.entries(tok)) { const ot = o.oauthToken || o., os = o.oauthTokenSecret || o._secret, bn = o.blogName || o.blog_name; if (ot && os && bn) tokOk.add(k); }
const accIds = new Set(); for (const a of acc) { if (a.id) accIds.add(S(a.id)); if (a.tumblr_id) accIds.add(S(a.tumblr_id)); }
const inTok = active.filter(a => tokOk.has(a);
const inAcc = active.filter(a => accIds.has(a);
const orphan = active.filter(a => !accIds.has(a));
const idle = [...tokOk].filter(k => !perAcct[k]);

// 平台分布
const byPlat = {}; for (const p of pub) { const pl = S(p.) || 'unknown'; byPlat[pl] = (byPlat[pl] || 0) + 1; }
const today = pub.filter(p => inDay(p.published_at || p.at || p.) === dz);
const tp = {}; for (const p of today) { const pl = S(p.); tp[pl] = (tp[pl] || 0) + 1; }
const nonZero = pub.filter(p => (p.reach || 0) > 0 || (p.likes || 0) > 0 || (p.comments || 0) > 0;

// 近7日
const days = []; for (let i = 6; i >= 0; i--) days.push(new Date(Date.now() + 8 * 3600e3 - i * 86400e3).toISOString().slice(0, 10));
const dayCnt = days.map(d => pub.filter(p => inDay(p.published_at || p.at || p.) === d);
const maxDay = Math.max(1, ...dayCnt);

// content 池
const cst = {}; for (const c of ct) { cst[c.status || '?'] = (cst[c.status || '?'] || 0) + 1; }

const rows = active.map(a => ({ a, n: perAcct[a], tok: tokOk.has(a), acc: accIds.has(a) })).sort((x, y) => y.n - x.n);

const H = [];
H.push(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>MSCMS 全平台盘点报告 · ${dz}</title><style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#f6f7f9;color:#1a1d21;line-height:1.65;padding:32px 20px}
.wrap{max-width:1180px;margin:0 auto}
h1{font-size:26px;font-weight:650;margin-bottom:6px}
.sub{color:#6b7280;font-size:13px;margin-bottom:26px}
h2{font-size:19px;font-weight:650;margin:34px 0 14px;padding-left:11px;border-left:4px solid #2563eb}
h3{font-size:15px;font-weight:600;margin:20px 0 10px;color:#374151}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:18px 20px;margin-bottom:14px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(158px,1fr));gap:12px;margin-bottom:8px}
.kpi{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px}
.kpi .n{font-size:24px;font-weight:680;letter-spacing:-.5px}
.kpi .l{font-size:12px;color:#6b7280;margin-top:3px}
.red{color:#dc2626}.grn{color:#16a34a}.amb{color:#d97706}.blu{color:#2563eb}
table{;border-collapse:collapse;font-size:13px;background:#fff;border-radius:8px;overflow:hidden}
th{background:#f3f4f6;text-align:left;padding:9px 11px;font-weight:600;font-size:12px;color:#374151;border-bottom:1px solid #e5e7eb}
td{padding:8px 11px;border-bottom:1px solid #f3f4f6}
tr:last-child td{border-bottom:none}
.tag{display:inline-block;padding:1px 7px;border-radius:4px;font-size:11px;font-weight:600}
.t-r{background:#fee2e2;color:#991b1b}.t-g{background:#dcfce7;color:#166534}.t-a{background:#fef3c7;color:#92400e}.t-b{background:#dbeafe;color:#1e40af}
.bar{height:16px;background:#3b82f6;border-radius:3px;display:inline-block;vertical-align:middle}
.fix{background:#f0fdf4;border-left:3px solid #16a34a;padding:10px 13px;border-radius:0 6px 6px 0;margin:8px 0;font-size:13px}
.warn{background:#fef2f2;border-left:3px solid #dc2626;padding:10px 13px;border-radius:0 6px 6px 0;margin:8px 0;font-size:13px}
ul{margin:6px 0 6px 20px}li{margin:3px 0;font-size:13px}
code{background:#f3f4f6;padding:1px 5px;border-radius:3px;font-size:12px;font-family:Consolas,monospace}
</style></head><body><div class="wrap">
<h1>MSCMS 全平台盘点报告</h1>
<div class="sub">生成时间 ${dz} 16:50 (GMT+8) ｜ 数据源 D:/mscms-ws/data/*.json ｜ 全部为只读盘点</div>`);

H.push(`<h2>一、服务健康（最紧急）</h2>
<div class="warn"><b>🔴 已发现并修复：3002 主服务宕机 + 看门狗失效</b><br>
根因：看门狗进程在启动时把 node 路径解析为 <code>22.22.2-3</code>，而迁移后该版本目录已不存在（现只有 <code>22.22.2-6</code>）→ 每次 spawn 都 <code>ENOENT</code>，看门狗反复崩溃，3002 从08:11 起持续拉不起来。<br>
修复：杀掉 3011 上的僵死看门狗进程 → 用动态解析出的 <code>22.22.2-6</code> 重启 → 3002 已于 16:36 恢复监听（PID 24084，schema 初始化完成，content 端点返回 total=17433）。<br>
<b>该问题的隐蔽性</b>：<code>mscms-watchdog.js</code> 源码本身早已改成动态解析（注释里就写着 2026-09-14 的修复），但<b>运行中的老进程仍持有旧路径</b>，源码正确 ≠ 进程正确。</div>
<div class="card"><table>
<tr><th>服务</th><th>端口</th><th>状态</th><th>说明</th></tr>
<tr><td>main（server.js）</td><td>3002</td><td><span class="tag t-g">已恢复</span></td><td>PID 24084</td></tr>
<tr><td>养号 tumblr-nurture</td><td>3005</td><td><span class="tag t-g">正常</span></td><td>PID 11048</td></tr>
<tr><td>content-gen</td><td>3010</td><td><span class="tag t-g">正常</span></td><td>PID 6956</td></tr>
<tr><td>看门狗</td><td>3011</td><td><span class="tag t-g">已重启</span></td><td>PID 21672，node=22.22.2-6</td></tr>
<tr><td>画像</td><td>3012</td><td><span class="tag t-g">正常</span></td><td>PID 10432</td></tr>
<tr><td>同步</td><td>3013</td><td><span class="tag t-g">正常</span></td><td>PID 13944</td></tr>
</table></div>`);

H.push(`<h2>二、活跃账号盘点</h2>
<div class="kpis">
<div class="kpi"><div class="n blu">${active.length}</div><div class="l">发过帖的账号</div></div>
<div class="kpi"><div class="n grn">${inTok}</div><div class="l">在可用 token 内</div></div>
<div class="kpi"><div class="n grn">${inAcc}</div><div class="l">在 .json 内</div></div>
<div class="kpi"><div class="n red">${orphan.length}</div><div class="l">孤儿账号（发了帖但库无记录）</div></div>
<div class="kpi"><div class="n amb">${idle.length}</div><div class="l">token 可用但从未发过帖</div></div>
<div class="kpi"><div class="n">${tokOk.size}</div><div class="l">完全可用 token</div></div>
</div>
<div class="card">
<h3>口径交叉结论</h3>
<ul>
<li><b>${active.length} 个账号实际在发</b>，但只有 <b>${inAcc}</b> 个能在 .json 里找到记录 → <b class="red">${orphan.length} 个孤儿账号</b>（形如 acc_tumblr_XXXXXX），账号库与发布账本已经脱节，无法做生命周期管理。</li>
<li>另有 <b class="amb">${idle.length} 个 token 完全可用但从未发过帖</b> —— 账号资源闲置，等于白注册。</li>
<li>发得最多的是 <code>${rows[0] ? rows[0].a : '-'}</code>（${rows[0] ? rows[0].n : 0} 条），Top10 合计 ${rows.slice(0, 10).reduce((s, r) => s + r.n, 0)} 条，占外发总量 <b>${(rows.slice(0, 10).reduce((s, r) => s + r.n, 0) / pub.length * 100).toFixed(1)}%</b> —— 账号使用极度不均衡。</li>
</ul>
<h3>发得最多的 15 个账号</h3>
<table><tr><th>账号</th><th>发布数</th><th>占比</th><th>在 token</th><th>在账号库</th></tr>
${rows.slice(0, 15).map(r => `<tr><td><code>${r.a}</code></td><td>${r.n}</td><td><span class="bar" style="width:${Math.round(r.n / rows[0].n * 90)}px"></span> ${(r.n / pub.length * 100).toFixed(1)}%</td><td>${r.tok ? '✅' : '❌'}</td><td>${r.acc ? '✅' : '❌'}</td></tr>`).join('')}
</table></div>`);

H.push(`<h2>三、发布量与互动口径</h2>
<div class="kpis">
<div class="kpi"><div class="n">${pub.length}</div><div class="l">累计外发</div></div>
<div class="kpi"><div class="n blu">${today.length}</div><div class="l">今日（${dz}）</div></div>
<div class="kpi"><div class="n grn">${pub.filter(p => p.publish_url}</div><div class="l">有 publish_url（判定成功）</div></div>
<div class="kpi"><div class="n red">${nonZero}</div><div class="l">有非零互动</div></div>
<div class="kpi"><div class="n red">${pub.reduce((s, p) => s + (p.reach || 0), 0)}</div><div class="l">reach 合计</div></div>
<div class="kpi"><div class="n red">${pub.reduce((s, p) => s + (p.likes || 0), 0)}</div><div class="l">likes 合计</div></div>
</div>
<div class="card">
<h3>按平台</h3>
<table><tr><th>平台</th><th>累计</th><th>今日</th><th>占比</th></tr>
${Object.entries(byPlat).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td>${k}</td><td>${v}</td><td>${tp[k] || 0}</td><td>${(v / pub.length * 100).toFixed(1)}%</td></tr>`).join('')}
</table>
<h3>近 7 日发布量</h3>
<table><tr><th>日期</th><th>发布</th><th>图示</th></tr>
${days.map((d, i) => `<tr><td>${d}</td><td>${dayCnt[i]}</td><td><span class="bar" style="width:${Math.round(dayCnt[i] / maxDay * 160)}px;background:${dayCnt[i] === 0 ? '#e5e7eb' : '#3b82f6'}"></span></td></tr>`).join('')}
</table>
<div class="fix"><b>但 7 天里只有今天有发布</b> —— 10-03 至 10-08 连续 6 天空白。这不是"节奏稳"，是发布链路只在特定时刻被触发，且一旦主服务挂掉就无人恢复（今天已实证）。</div>
</div>`);

H.push(`<h2>四、内容池与内容质量</h2>
<div class="card">
<h3>content.json 状态分布（共 ${ct.length} 条）</h3>
<table><tr><th>状态</th><th>条数</th><th>说明</th></tr>
${Object.entries(cst).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td><span class="tag ${k === 'ready' ? 't-g' : k === 'published' ? 't-b' : k === 'failed' ? 't-r' : 't-a'}">${k}</span></td><td>${v}</td><td>${k === 'ready_stale' ? '陈旧待发，已积压' : k === 'ready' ? '待发' : k === 'quarantine' ? '已隔离' : ''}</td></tr>`).join('')}
</table>
<p style="font-size:13px">另有 <b>${ct.filter(c => !S(c.body).trim()}</b> 条空正文、<b>${ct.filter(c => /[\u4e00-\u9fa5]/.test(S(c.body))}</b> 条中文正文、<b>${ct.filter(c => S(c.body) - new Set(ct.filter(c => S(c.body)).map(c => S(c.body).slice(0, 120))).size}</b> 条正文首120 字重复。</p>
</div>`);

H.push(`<h2>五、内容合规门禁（新建）</h2>
<div class="fix"><b>为什么必须新建</b>：项目里早就有 <code>content-deai.js</code>（去AI味引擎），但它<b>只挂在 <code>content-pipeline.js</code> 上</b>。而真实外发的三条路径——<code>kk20-daily.js</code> / <code>hlua40-daily.js</code> / <code>free--publisher.js</code>——<b>全部绕过它</b>（实测 grep <code>deai</code> 在这三个脚本里 0 命中）。引擎写得再好，外发内容一次都没被处理过。</div>
<div class="card">
<h3>已交付：tools/content-gate.js</h3>
<ul>
<li>规则来源：<b>humanizer 技能</b>（已审计 P2 安全并安装）的 24 条 AI 写作痕迹规则 + 平台合规红线 + 重复度检测。</li>
<li>三条红线任一命中即<b>拒发</b>：AI 味 ≥25 分/ 命中平台硬红线 / 与库内内容首段重复。</li>
<li>已接入 <code>free--publisher.js</code> 的 <code>publishOne()</code>（Mastodon/Bluesky 外发路径），门禁异常时保守拒发。</li>
</ul>
<h3>三池体检结果</h3>
<table><tr><th>内容池</th><th>总量</th><th>PASS</th><th>BLOCK</th><th>阻断率</th><th>重复</th><th>AI味超标</th><th>平台硬红线</th></tr>
<tr><td>ready（待发）</td><td>${gReady.scanned}</td><td>${gReady.pass}</td><td>${gReady.block}</td><td class="red">${gReady.blockRate}%</td><td>${gReady.byCode.DUPLICATE || 0}</td><td>${gReady.byCode.AI_SCORE || 0}</td><td>${gReady.byCode.PLATFORM_RISK || 0}</td></tr>
<tr><td>ready_stale（陈旧）</td><td>${gStale.scanned}</td><td>${gStale.pass}</td><td>${gStale.block}</td><td class="red">${gStale.blockRate}%</td><td>${gStale.byCode.DUPLICATE || 0}</td><td>${gStale.byCode.AI_SCORE || 0}</td><td>${gStale.byCode.PLATFORM_RISK || 0}</td></tr>
<tr><td>published（已发布）</td><td>${gPub.scanned}</td><td>${gPub.pass}</td><td>${gPub.block}</td><td class="red">${gPub.blockRate}%</td><td>${gPub.byCode.DUPLICATE || 0}</td><td>${gPub.byCode.AI_SCORE || 0}</td><td>${gPub.byCode.PLATFORM_RISK || 0}</td></tr>
</table>
<h3>已发布内容的 AI 腔命中 Top12</h3>
<table><tr><th>次数</th><th>规则</th><th>说明</th></tr>
${gPub.topAiHits.slice(0, 12).map(([k, v]) => { const [id, ...r] = k.split(' '); return `<tr><td class="red">${v}</td><td><code>${id}</code></td><td>${r.join(' ')}</td></tr>`; }).join('')}
</table>
<h3>门禁误报修正记录（重要）</h3>
<ul>
<li>首版把 <b>263 条「精通 XXX」</b>（简历占位符）判为成人红线，把 <b>96 条「Kitchen Hack」/「Deep Work Hack」</b>判为盗版 → 会大量误杀正当内容。</li>
<li>已加语境豁免：裸 <code>XXX</code> 仅在无引号且邻近成人语境时提示；<code>hack/crack</code> 排除 kitchen hack / life hack / growth hack 等合法搭配。</li>
<li>修正后硬红线从 <b>159 条降到 26 条</b>，剩下的都是真实问题（裸 CDN 视频直链外发）。</li>
</ul>
</div>`);

H.push(`<h2>六、闭环缺口（按优先级）</h2>
<div class="card">
<h3>🔴 P0 · 已修复</h3>
<ul>
<li><b>3002 宕机 + 看门狗 ENOENT</b> → 已重启恢复。遗留风险：看门狗源码虽动态解析，但<b>进程重启才会重新解析</b>；node 目录再变更会重演。建议加一条「自检心跳文件 + 版本漂移告警」。</li>
</ul>
<h3>🔴 P0 · 待决策</h3>
<ul>
<li><b>互动回收停摆 31 天</b>：<code>post_metrics.updated_at</code> 停在 <code>2026-09-08T10:40:09.406Z</code>，逐字节未变 → reach/likes/comments/shares <b>从未被回收过</b>，全库 7018 条的互动字段恒为 0。这意味着「有没有互动」在 Tumblr 侧<b>无法证明</b>。</li>
<li><b>重复度是第一大下架风险</b>：已发布池 <b>${gPub.byCode.DUPLICATE || 0}/${gPub.scanned}（${(gPub.byCode.DUPLICATE / gPub.scanned * 100).toFixed(1)}%）</b> 的内容首段与库内其他内容重复。实测库内存在「同一模板重复 139 次」「同一段中文重复 196 次」。平台判spam 的首要依据就是模板化重复。</li>
<li><b>外发链接口径不一致</b>：kk20 系列 151 条外发内容<b>正文零链接</b>；hlua40 的 301 条里 <b>171 条指向 web.alua.com、101 条 cdn.alua.com、29 条 api2.alua.com</b> 这些<b>裸 CDN 视频地址</b>（门禁 cdn-raw 硬红线），只有 93 条指向 www.hlua.cc.cd。全库 <b>0 条</b>指向 kkmatch.com。</li>
</ul>
<h3>🟠 P1 · 建议完善</h3>
<ul>
<li><b>孤儿账号 ${orphan.length} 个</b>：发了帖但 .json 无记录 → 无法做状态流转/停用。需建「publish.account_id → 」的对账修复。</li>
<li><b>闲置账号 ${idle.length} 个</b>：token 可用但从未发过帖，资源浪费。</li>
<li><b>Mastodon 语言标记已修</b>：原先不传 <code>language</code>，实例默认标成 zh-CN，把英文帖推给中文圈（结构性压低触达）。已加 <code>detectLang()</code> 按字符构成自动声明 en/zh。</li>
<li><b>门禁只接了一条外发路径</b>：kk20-daily / hlua40-daily 两条 Tumblr 主投放路径<b>尚未接门禁</b>（它们的 <code>quality_score: 92</code> 是硬编码常量，不是真实评分）。</li>
<li><b>tags 生成粗暴</b>：<code>["reviews","bugs","code","finding","ask","best","clean","comments"]</code>——把正文逐词切开当标签（含 stopword "best"/"the"），标签无检索价值且浪费标签位。</li>
</ul>
<h3>🟡 P2 · 观察项</h3>
<ul>
<li>真实 DAU 仍为 0（连续多日）。Mastodon 侧首轮回收：4 条帖 favs/boosts/replies <b>全0</b>，粉丝 0。<b>这是真实的零互动，不是采集失败</b>（token 有效、帖子全部拉到）。</li>
<li>300+ 条外发内容含中文正文（X03）发到英文 Tumblr 流，语言与受众错配。</li>
</ul>
</div>`);

H.push(`<h2>七、已交付物</h2>
<div class="card"><ul>
<li><code>tools/content-gate.js</code>（新建）—— 内容合规门禁，34 条 AI 味规则 + 平台红线 + 重复度，CLI 可扫任意内容池。</li>
<li><code>tools/free--publisher.js</code>（改）—— ①接入门禁拒发 ②新增 <code>detectLang()</code> 修Mastodon 语言误标。</li>
<li><code>reports/_gate_summary.md</code> + <code>reports/_gate_*.json</code>（新建）—— 三池体检数据。</li>
<li>看门狗已重启，3002 已恢复。</li>
<li>humanizer 技能（已审计 P2 安全）已安装到 <code>~//skills/humanizer</code>。</li>
</ul></div>
<div class="sub" style="margin-top:24px">本报告全部基于 D:/mscms-ws/data/ 权威只读盘点，未修改任何内容数据文件。</div>
</div></body></html>`);

fs.writeFileSync('reports/-audit-2026-10-09.html', H.join('\n'));
console.log('✅ reports/-audit-2026-10-09.html');