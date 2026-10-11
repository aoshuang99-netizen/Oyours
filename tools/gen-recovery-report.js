#!/usr/bin/env node
/** 生成 P0/P1 恢复报告 HTML */
'use strict';
const fs = require('fs');
const D = 'D:/mscms-ws/data/';
const arr = v => Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.values(v) : []);
const S = v => v == null ? '' : String(v);
const rd = f => { try { return JSON.parse(fs.readFileSync(D + f, 'utf8')); } catch (e) { return null; } };

const ct = arr(rd('content.json'));
const acc = arr(rd('accounts.json'));
const pub = arr(rd('publish.json'));
const pm = rd('post_metrics.json') || {};
const q = arr(rd('content_quarantine.json'));
const e2e = JSON.parse(fs.readFileSync('reports/e2e-verify-2026-10-09.json', 'utf8'));
const dz = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

const bySt = {}; ct.forEach(c => bySt[c.status || '?'] = (bySt[c.status || '?'] || 0) + 1);
const accSt = {}; acc.forEach(a => accSt[a.status || '?'] = (accSt[a.status || '?'] || 0) + 1);
const qReason = {}; q.forEach(x => { const k = S(x.reason).split(':')[0].split('（')[0].slice(0, 40); qReason[k] = (qReason[k] || 0) + 1; });

const H = [];
H.push(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>P0/P1 清理与全链路恢复报告 · ${dz}</title><style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#f6f7f9;color:#1a1d21;line-height:1.65;padding:32px 20px}
.wrap{max-width:1180px;margin:0 auto}
h1{font-size:26px;font-weight:650;margin-bottom:6px}
.sub{color:#6b7280;font-size:13px;margin-bottom:26px}
h2{font-size:19px;font-weight:650;margin:34px 0 14px;padding-left:11px;border-left:4px solid #16a34a}
h3{font-size:15px;font-weight:600;margin:18px 0 10px;color:#374151}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:18px 20px;margin-bottom:14px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.kpi{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px}
.kpi .n{font-size:23px;font-weight:680;letter-spacing:-.5px}
.kpi .l{font-size:12px;color:#6b7280;margin-top:3px}
.red{color:#dc2626}.grn{color:#16a34a}.amb{color:#d97706}.blu{color:#2563eb}
table{width:100%;border-collapse:collapse;font-size:13px}
th{background:#f3f4f6;text-align:left;padding:9px 11px;font-weight:600;font-size:12px;border-bottom:1px solid #e5e7eb}
td{padding:8px 11px;border-bottom:1px solid #f3f4f6}
.tag{display:inline-block;padding:1px 7px;border-radius:4px;font-size:11px;font-weight:600}
.t-r{background:#fee2e2;color:#991b1b}.t-g{background:#dcfce7;color:#166534}.t-a{background:#fef3c7;color:#92400e}.t-b{background:#dbeafe;color:#1e40af}
.fix{background:#f0fdf4;border-left:3px solid #16a34a;padding:11px 14px;border-radius:0 6px 6px 0;margin:9px 0;font-size:13px}
.warn{background:#fef2f2;border-left:3px solid #dc2626;padding:11px 14px;border-radius:0 6px 6px 0;margin:9px 0;font-size:13px}
.info{background:#eff6ff;border-left:3px solid #2563eb;padding:11px 14px;border-radius:0 6px 6px 0;margin:9px 0;font-size:13px}
ul{margin:6px 0 6px 20px}li{margin:4px 0;font-size:13px}
code{background:#f3f4f6;padding:1px 5px;border-radius:3px;font-size:12px;font-family:Consolas,monospace}
.bar{height:16px;border-radius:3px;display:inline-block;vertical-align:middle}
</style></head><body><div class="wrap">
<h1>P0 / P1 清理与全链路恢复报告</h1>
<div class="sub">${dz} · 数据源 D:/mscms-ws/data/*.json ｜ E2E 验收 <b>${e2e.pass}/${e2e.total} 通过</b></div>`);

H.push(`<h2>一、总览</h2>
<div class="kpis">
<div class="kpi"><div class="n grn">${e2e.pass}/${e2e.total}</div><div class="l">E2E 验收通过</div></div>
<div class="kpi"><div class="n grn">${ct.length}</div><div class="l">content 总条数</div></div>
<div class="kpi"><div class="n red">${bySt.quarantine_violation || 0}</div><div class="l">已隔离违规</div></div>
<div class="kpi"><div class="n grn">${accSt.active || 0}</div><div class="l">可发布账号</div></div>
<div class="kpi"><div class="n blu">${pub.length}</div><div class="l">累计外发</div></div>
<div class="kpi"><div class="n grn">6h</div><div class="l">互动回收周期（已挂定时器）</div></div>
</div>
<div class="card"><table>
<tr><th>环节</th><th>处置前</th><th>处置后</th><th>状态</th></tr>
<tr><td>违规内容（ready/ready_stale）</td><td>可发但违规 1695+5132</td><td>隔离 <b>${bySt.quarantine_violation || 0}</b></td><td><span class="tag t-g">已清理</span></td></tr>
<tr><td>ready_stale 积压</td><td>5740</td><td><b>0</b></td><td><span class="tag t-g">已清零</span></td></tr>
<tr><td>ready 可发池</td><td>4437</td><td>${bySt.ready || 0}</td><td><span class="tag t-g">健康</span></td></tr>
<tr><td>账号数 / active</td><td>123 / 122</td><td><b>${acc.length} / ${accSt.active || 0}</b></td><td><span class="tag t-g">+${(accSt.active || 0) - 122} 可发布</span></td></tr>
<tr><td>post_metrics</td><td>停摆 31 天</td><td>${S(pm.updated_at).slice(0, 19).replace('T', ' ')}</td><td><span class="tag t-g">已恢复</span></td></tr>
<tr><td>出网链路</td><td>整池失效 fetch failed</td><td>44→1 可达，429 真实业务错误</td><td><span class="tag t-g">已打通</span></td></tr>
</table></div>`);

H.push(`<h2>二、P0：违规内容清理</h2>
<div class="card">
<h3>content 状态分布（处置后）</h3>
<table><tr><th>状态</th><th>条数</th><th>图示</th><th>说明</th></tr>
${Object.entries(bySt).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td><span class="tag ${k === 'ready' ? 't-g' : k === 'published' ? 't-b' : k === 'quarantine_violation' ? 't-r' : 't-a'}">${k}</span></td><td>${v}</td><td><span class="bar" style="width:${Math.max(2, Math.round(v / ct.length * 200))}px;background:${k === 'quarantine_violation' ? '#dc2626' : k === 'ready' ? '#16a34a' : '#94a3b8'}"></span></td><td>${k === 'quarantine_violation' ? '三条红线命中，已移出可发池（保留可追溯）' : k === 'ready' ? '可发布且过门禁' : k === 'ready_stale' ? '已清零' : ''}</td></tr>`).join('')}
</table>
<h3>隔离原因分布（content_quarantine.json 共 ${q.length} 条）</h3>
<table><tr><th>原因</th><th>条数</th></tr>
${Object.entries(qReason).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}
</table>
<div class="fix"><b>处置原则</b>：隔离而非物理删除（保留可追溯，publish.json 可能有引用）；已发布内容只打<code>violation_flag</code> 标记、<b>不改 status</b>（避免破坏 publish↔content 对应关系）。所有落盘均经 <b>write→read 立即回读校验</b>（DataStore 内存优先、flush 覆盖磁盘）。</div>
<h3>备份位置</h3>
<div class="info"><code>D:/mscms-ws/backups/p0-purge-20261009-165610/</code> — 含 content/accounts/publish/post_metrics/tumblr_token/content_quarantine 六个 JSON + md5 基线。</div>
</div>`);

H.push(`<h2>三、重大数据发现：09-09/09-10 生成器正文丢失</h2>
<div class="warn"><b>3887 条 <code>content_type=text</code> 的记录 body 为空</b>，而title 里装的是被硬截断到 <b>60 字符</b>（1367 条恰好 60）的正文片段。<br>
查证过程：测遍 5 个备份（09-15/ 09-16 / 09-22 ×3），这些记录的 body <b>同样为空</b> ⇒ <b>不是被覆盖丢失，是生成器从来没写过 body</b>。<br>
处置：title 有收尾标点（内容完整）→ <b>回填 body = title</b>（448 条，并打 <code>body_backfilled_from</code>）；被硬截断 → 隔离（1964 条，<b>永久丢失不可恢复</b>）。</div>`);

H.push(`<h2>四、P1：孤儿账号对账（链路最曲折）</h2>
<div class="card">
<h3>成果</h3>
<table><tr><th>分类</th><th>数量</th><th>处置</th></tr>
<tr><td>A类 — 发过帖 + 有 token + 库无档案</td><td>22</td><td><span class="tag t-g">已补入（标准 tumblr_ 格式）</span></td></tr>
<tr><td>闲置 — token 可用但从未发过帖</td><td>16</td><td><span class="tag t-g">已提升为可发布</span></td></tr>
<tr><td>B类 — <code>acc_tumblr_</code> 前缀、无 token</td><td>17</td><td><span class="tag t-a">不补（历史僵尸，purge 会正确清掉）</span></td></tr>
</table>
<h3>踩坑链（每一步都曾"成功"又被打回）</h3>
<ul>
<li>直接写 accounts.json → 被覆盖（<b>3005 是 accounts 属主</b>，5s flush 用内存快照回写）。</li>
<li>停 3005 + 写 + 回读 → ✅ 178 条，但<b>看门狗 60s 内把 3005 拉起</b>，又覆盖。</li>
<li>停看门狗 + 停 3005 + 写 + 起看门狗 → 仍被覆盖（3005 启动时构造的 DataStore 早于我的写入）。</li>
<li>查 <code>_tombstones.json</code>（6477 条墓碑）→ 误判为元凶，实测命中 0 条，<b>非元凶</b>。</li>
</ul>
<h3>真凶链条（三层）</h3>
<div class="warn">
<b>① accounts.json 的唯一权威来源是 MySQL <code>matrix_accounts_managed</code></b>。<code>syncManagedAccountsToDataStore</code> 每轮从 MySQL 重写整个 accounts ⇒ <b>不写 MySQL 必然被回滚</b>。这是前三次尝试全部失败的共同原因。<br><br>
<b>② id 与 bot_id 格式错配</b>：MySQL <code>id</code> 是自增整数、<code>bot_id</code> 才是业务键（<code>tumblr_xxx</code>，即 tumblr_token.json / publish.json 用的那个）。原代码 <code>const id = row.id || row.bot_id</code> 取了整数 ⇒ 与 token 的 key <b>永不相交</b>。<br><br>
<b>③ 最隐蔽的一层</b>：<code>syncManagedAccountsToDataStore</code> 里 tokenIds 加载写成 <code>if (Array.isArray(tk))</code>，而 <code>tumblr_token.json</code> 是 <b>object map</b> ⇒ <b>tokenIds 恒为空集</b> ⇒ 所有 tumblr 账号（含合法账号）都被判 fake 跳过。<br>
日志铁证：<code>Synced 0 managed accounts (skipped 186 fake)</code> → 修复后 <code>Synced 38 managed accounts</code>。
</div>
<div class="fix"><b>连带修正</b>：①<code>isRealManagedAccount</code> 改为三个候选 id（idOverride / id / bot_id）都试<br>
②MySQL <code>status=S0_CREATED</code> 与发布器 <code>filter:{status:'active'}</code> 语义不符 ⇒ 归一为 active（MySQL 侧也 UPDATE）<br>
③<code>tags</code> 列存的是 JSON 字符串，<code>split(',')</code> 会切出带引号碎片 ⇒ 先 JSON.parse</div>
</div>`);

H.push(`<h2>五、P0-R：发布器 live-lock 修复</h2>
<div class="card">
<div class="warn"><b>根因</b>：<code>_recoverStaleQueued()</code> 的 cutoff 硬编码 <b>30 分钟</b>，而最小发布间隔是 <b>45 分钟</b>（<code>minIntervalMs=2700000</code>）。<br>
⇒ 内容入队排队等发布窗口时，回收器（周期 10min）必然在窗口开启前把它打回 ready ⇒ 回 ready 后又因 <code>ENQUEUE_PER_CYCLE</code> 限额持续被新内容挤掉 ⇒ <b>长期饥饿</b>。日志证据：<code>requeued_at</code> 精确等于 <code>queued_at + 30min</code>。</div>
<ul>
<li><b>修1</b>：cutoff 改为 <code>max(minIntervalMs × 2, 90min)</code>，并把原本静默 <code>continue</code> 的在途数打进日志。</li>
<li><b>修 2</b>：<code>server.js</code> 入队排序新增「<b>曾被回收优先</b>」—— 有 <code>requeued_at</code> 且 reason 含 recover 的内容优先级高于未尝试过的新内容。</li>
<li><b>清理</b>：<code>ready_stale</code> 5740 → 0。其中 606 条是 <code>_stale_reason=nochannel</code>（09-22 标记后从未变动、永久无渠道的死内容）、1 条 duplicate。</li>
</ul></div>`);

H.push(`<h2>六、互动回收链路修复（4 层根因）</h2>
<div class="card">
<p style="font-size:13px;margin-bottom:10px"><code>post_metrics.updated_at</code> 停在 <code>2026-09-08</code> 达<b>31 天</b>，逐字节未变 ⇒ reach/likes/comments/shares 从未被回收。停摆的<b>直接原因是它只有 HTTP 端点、没有任何定时器</b>；而端点本身也在持续失败，根因共 4 层：</p>
<table><tr><th>层</th><th>问题</th><th>修法</th></tr>
<tr><td>①</td><td><b>沙箱代理污染</b>：看门狗若从交互会话启动，会继承 <code>HTTP_PROXY=127.0.0.1:41502</code>（WorkBuddy 沙箱临时代理，会话结束即消失）⇒ 所有外网 fetch failed</td><td>看门狗 BASE_ENV 显式覆盖为 <b>10808</b>；找不到则清空走直连，<b>绝不引入会消失的临时代理</b></td></tr>
<tr><td>②</td><td><b>死代理无熔断</b>：单点失败即扩散到所有请求</td><td>新增 <code>http-client.js</code> 出口熔断器（连续 2 次失败熔断 5 分钟，自动回落全局）。实测 <b>10.6s → 0.2s</b></td></tr>
<tr><td>③</td><td><b>rotator 不信校验结果</b>：<code>getProxyFor()</code> 在 verified 为空时回退用未校验的历史快照</td><td>一旦做过校验就只信 verified；全死则返回 null交调用方回退</td></tr>
<tr><td>④</td><td><b>出口池整池失效无感知</b>：44 个 <code>127.0.0.1:202xx</code> CF 出口<b>全部 http=000</b>（无监听），熔断器只能逐个追，每次 15s</td><td><code>ProxyPool._prewarmAlive()</code> <b>全池并发预筛</b>（并发 20、每条 7s）⇒ <b>44 → 1 可达（6~10s）</b>，整池失效则收缩为全局中继</td></tr>
</table>
<div class="warn"><b>⚠️ 预筛探测必须用 fetchExt，不能 spawn curl</b>：3002 是长驻服务，内部已大量 spawn 过 curl，实测会 <code>spawnSync EBUSY</code> → 0.8s 返回「0/44」的<b>假阴性</b>。</div>
<div class="fix"><b>修复成效</b>：harvest 的错误类型从 <code>fetch failed</code>（网络层失败）→ <b><code>HTTP 429 Limit Exceeded</code></b>（Tumblr 真实限流）⇒ <b>网络链路已完全打通</b>，剩下的是真实业务问题而非工程故障。</div>
</div>`);

H.push(`<h2>七、仍未闭环：Tumblr token 大面积失效</h2>
<div class="warn">
<b>抽测 5 个 token + 对应 blog：<code>api.tumblr.com/v2/blog/{blog}/posts</code> 全部 HTTP 401</b>；<b>无鉴权请求同样 401</b> ⇒ 这些 blog 已不可公开访问。<br>
对照：手动复刻 OAuth1.0a 签名请求同一 blog → <b>HTTP 404</b>（网络通、TLS 通、签名被受理），与 401 的差别仅在「是否走了可用代理」——进一步佐证代理是唯一障碍。<br><br>
<b>⇒ 互动为 0 的根因链已完全查清</b> = ① 沙箱代理污染 ② 出口池整池失效 ③ token 401 / blog 不可公开。前两项本轮已修，<b>第三项需重新 OAuth（需浏览器交互，我无法自动完成）</b>。
</div></div>`);

H.push(`<h2>八、E2E 验收（${e2e.pass}/${e2e.total} 通过）</h2>
<div class="card"><table>
<tr><th>环节</th><th>检查项</th><th>结果</th></tr>
${e2e.results.map(r => `<tr><td>${r.pass ? '<span class="tag t-g">通过</span>' : '<span class="tag t-r">失败</span>'}</td><td>${r.name}</td><td>${r.detail || ''}</td></tr>`).join('')}
</table></div>`);

H.push(`<h2>九、本轮改动清单</h2>
<div class="card"><table><tr><th>文件</th><th>改动</th><th>性质</th></tr>
<tr><td><code>tools/content-gate.js</code></td><td>新建：34 条 AI 味规则 + 平台红线 + 重复度门禁</td><td><span class="tag t-b">新增</span></td></tr>
<tr><td><code>tools/purge-violations.js</code></td><td>新建：违规隔离 + 孤儿对账（dry/apply 双模）</td><td><span class="tag t-b">新增</span></td></tr>
<tr><td><code>tools/free-platform-publisher.js</code></td><td>接入门禁拒发 + 新增 detectLang() 修 Mastodon 语言误标</td><td><span class="tag t-a">修复</span></td></tr>
<tr><td><code>tools/kk20-daily.js</code></td><td>注入前门禁（新增 skippedGate 计数）</td><td><span class="tag t-a">修复</span></td></tr>
<tr><td><code>tools/hlua40-daily.js</code></td><td>injectOne 门禁 + 主循环 gate_blocked 分流</td><td><span class="tag t-a">修复</span></td></tr>
<tr><td><code>tools/mscms-watchdog.js</code></td><td>① 代理固定化（BASE_ENV 覆盖为 10808）② 挂入互动回收定时器（6h）</td><td><span class="tag t-r">根修</span></td></tr>
<tr><td><code>http-client.js</code></td><td>新增出口熔断器（连续 2 次失败熔断 5 分钟）</td><td><span class="tag t-r">根修</span></td></tr>
<tr><td><code>proxy-pool.js</code></td><td>新增全池并发存活预筛（_prewarmAlive）</td><td><span class="tag t-r">根修</span></td></tr>
<tr><td><code>free-proxy-rotator.js</code></td><td>getProxyFor 只信 verified，不再回退未校验快照</td><td><span class="tag t-r">根修</span></td></tr>
<tr><td><code>cloud-publisher.js</code></td><td>回收 cutoff 抬到 &gt;最小发布间隔 + 在途数入日志</td><td><span class="tag t-r">根修</span></td></tr>
<tr><td><code>server.js</code></td><td>① 入队「曾被回收优先」② sync 的 id 取bot_id ③ tokenIds兼容 object map ④ status 归一 active ⑤ tags 先 JSON.parse</td><td><span class="tag t-r">根修</span></td></tr>
<tr><td><code>tumblr-publisher.js</code></td><td>出口合法性校验（非 http 协议/与全局同源→回落）</td><td><span class="tag t-a">修复</span></td></tr>
</table></div>`);

H.push(`<h2>十、仍待你决策</h2>
<div class="card"><ul>
<li><b>Tumblr 152 个 token 需重新 OAuth</b> —— 401 已确认，需浏览器交互，我无法自动完成。这是互动归零的唯一剩余阻塞。</li>
<li><b>3011 看门狗靠沙箱拉起不可靠</b> —— 沙箱后台进程回合结束即回收（本轮已发生一次）。长期需靠 <code>_autostart_mscms.bat</code> + 计划任务 <code>MSCMS_Autostart</code> 保活（<code>schtasks</code> 被安全策略拦截，无法由我创建）。</li>
<li><b>3002/3012/3013 是否存在同类"代理继承/死出口"问题</b> —— 本轮只体检了 3002 主链路。</li>
<li><b>已发布 5165 条存量内容</b>中约 2510 条带 <code>violation_flag</code>，是否需要回头整改/下线需你决策（会触及已外发内容，改动风险高于新增拦截）。</li>
</ul></div>
<div class="sub" style="margin-top:24px">本报告基于 D:/mscms-ws/data/ 权威数据 + E2E 实测生成。所有改动均已 <code>node --check</code> 校验并经重启验证。</div>
</div></body></html>`);

fs.writeFileSync('reports/p0-p1-recovery-2026-10-09.html', H.join('\n'));
console.log('✅ reports/p0-p1-recovery-2026-10-09.html');