// 菜单重构 v2（幂等）：
//  1) 7组42页 -> 8组43页：拆分「系统与AI」为「系统运维」+「AI 智能」；恢复被误合并的「平台闭环」
//  2) 新增「⚡ 常用」智能区：按访问频次记忆，自动置顶最常看的页面
const fs = require('fs');
const FILE = 'v14-dash.html';
let s = fs.readFileSync(FILE, 'utf8');
const before = s;
let stats = {};

/* ---------- 1. MENUS ---------- */
const NEW_MENUS = `const MENUS=[
 {id:'ov',ic:'📊',label:'运营总览',desc:'全链路健康 · 因果链闭环',
  tabs:[
   {id:'compass', label:'核心指标罗盘',   render:renderAnalCompass},
   {id:'causal',  label:'7 阶段漏斗',     render:renderAnalCausal},
   {id:'timeline',label:'周期时间线',     render:renderChainTimeline},
   {id:'guard',   label:'停滞守卫·转化率',render:renderChainGuard},
  ]},
 {id:'acct',ic:'🔐',label:'账号与设备',desc:'账号资产 · 云手机 · 指纹 · 代理',
  tabs:[
   {id:'overview',  label:'账号全景',    render:renderAcctOverview},
   {id:'s', label:'平台分布',    render:renderAcctPlatforms},
   {id:'',  label:'注册工厂',    render:renderAcctRegister},
   {id:'nurture',   label:'养号监控',    render:renderAcctNurture},
   {id:'closedloop',label:'闭环一致性',  render:renderAcctClosedLoop},
   {id:'fleet',     label:'云手机舰队',  render:renderDevFleet},
   {id:'finger',    label:'指纹反检测',  render:renderDevFinger},
   {id:'proxy',     label:'代理健康',    render:renderDevProxy},
   {id:'keepalive', label:'保活自愈',    render:renderDevKeepAlive},
  ]},
 {id:'content',ic:'📝',label:'内容与发布',desc:'生产 · 编辑 · 闭环 · 分发',
  tabs:[
   {id:'factory',  label:'内容工厂',        render:renderContentFactory},
   {id:'editor',   label:'内容编辑',        render:renderContentEditor},
   {id:'funnel',   label:'发布漏斗',        render:renderContentFunnel},
   {id:'loop',     label:'平台闭环',        render:renderContentLoop},
   {id:'inspire',  label:'热点灵感·视频工厂',render:renderTrendInspire},
   {id:'tumblr',   label:'Tumblr 发布台',   render:renderTumblrHub},
   {id:'providers',label:'Mixpost 提供方',  render:renderMixpostProviders},
   {id:'posts',    label:'版本化发布',      render:renderMixpostPosts},
   {id:'hashtags', label:'标签组',          render:renderMixpostHashtags},
  ]},
 {id:'traffic',ic:'🎯',label:'引流与流量',desc:'短链 · 点击 · DAU · 私域',
  tabs:[
   {id:'overview',label:'引流总览',  render:renderLinksOverview},
   {id:'matrix',  label:'链接矩阵',  render:renderLinksMatrix},
   {id:'trend',   label:'流量趋势',  render:renderLinksTrend},
   {id:'dau',     label:'DAU 监控',  render:renderLinksDau},
   {id:'scrm',    label:'SCRM 私域', render:renderLinksScrm},
  ]},
 {id:'conv',ic:'📈',label:'转化与优化',desc:'漏斗 · 实验 · 归因 · 风控',
  tabs:[
   {id:'funnel',label:'转化漏斗',    render:renderConvFunnel},
   {id:'ab',    label:'A-B 实验',    render:renderConvAb},
   {id:'attr',  label:'归因模型',    render:renderConvAttr},
   {id:'cloak', label:'Cloaking 风控',render:renderConvCloak},
   {id:'alerts',label:'告警中心',    render:renderConvAlerts},
  ]},
 {id:'mkt',ic:'📢',label:'营销活动',desc:'活动编排 · 触达 · 快速任务',
  tabs:[
   {id:'overview', label:'营销总览',render:renderMktOverview},
   {id:'campaigns',label:'活动编排',render:renderMktCampaigns},
   {id:'quick',    label:'快速任务',render:renderMktQuick},
  ]},
 {id:'sysops',ic:'⚙️',label:'系统运维',desc:'健康 · 编排 · 事件 · 决策',
  tabs:[
   {id:'health',  label:'系统健康',  render:renderSysHealth},
   {id:'dag',     label:'DAG 拓扑',  render:renderSysDag},
   {id:'bus',     label:'事件总线',  render:renderSysBus},
   {id:'decision',label:'决策引擎',  render:renderAnalDecision},
  ]},
 {id:'ai',ic:'🤖',label:'AI 智能',desc:'洞察 · 问答 · 报告 · 根因',
  tabs:[
   {id:'insight',label:'AI 洞察',  render:renderAnalAI},
   {id:'nlq',    label:'AI 问答',  render:renderAiNlq},
   {id:'report', label:'周报月报',  render:renderAiReport},
   {id:'root',   label:'根因建议',  render:renderAiRoot},
  ]},
];`;
{
  const i = s.indexOf('const MENUS=[');
  if (i < 0) throw new Error('MENUS not found');
  const j = s.indexOf('\n];', i);
  s = s.slice(0, i) + NEW_MENUS + s.slice(j + 3);
  stats.MENUS = 1;
}

/* ---------- 2. 徽标映射：组 id 变更 ---------- */
{
  const oldMap = "const map={ov:chainCount,acct:acctCount,content:contentCount,traffic:linkCount,conv:convCount,mkt:mktCount,sys:devCount};";
  const newMap = "const map={ov:chainCount,acct:acctCount,content:contentCount,traffic:linkCount,conv:convCount,mkt:mktCount,sysops:devCount,ai:''};";
  if (s.includes(oldMap)) { s = s.replace(oldMap, newMap); stats.badgeMap = 1; }
  else if (s.includes("sysops:devCount")) { stats.badgeMap = 'already'; }
  else { console.warn('⚠ 徽标映射未匹配，请人工检查 updateBadges'); }
}

/* ---------- 3. CSS：常用区 ---------- */
if (!s.includes('.freqbar{')) {
  const css = `\n.freqbar{display:flex;flex-wrap:wrap;gap:4px;padding:7px 10px 9px;border-bottom:1px solid var(--bord)}\n.fq-t{;font-size:10px;color:var(--mut2);letter-spacing:.08em;margin-bottom:3px}\n.fq{display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:3px 8px;border-radius:20px;background:var(--bg3);color:var(--mut);cursor:pointer;border:1px solid transparent;white-space:nowrap;max-}\n.fq:hover{border-color:var(--acc);color:var(--txt)}\n.fq .n{color:var(--mut2);font-size:10px}\n</style>`;
  const k = s.indexOf('</style>');
  if (k < 0) throw new Error('</style> not found');
  s = s.slice(0, k) + css + s.slice(k + 8);
  stats.css = 1;
} else stats.css = 'already';

/* ---------- 4. 常用区逻辑 ---------- */
if (!s.includes(' renderFreq()')) {
  const fn = `
/* ---- ⚡ 常用页面：按访问频次记忆，自动置顶（智能化） ---- */
const FREQ_KEY='mscms-dash-freq-v1';
 recordVisit(mid,tid){
  try{ const f=JSON.parse(localStorage.getItem(FREQ_KEY)||'{}'); const k=mid+'/'+tid;
    f[k]=(f[k]||0)+1; localStorage.setItem(FREQ_KEY,JSON.stringify(f)); }catch(e){}
}
 topPages(n=6){
  try{
    const f=JSON.parse(localStorage.getItem(FREQ_KEY)||'{}');
    return Object.entries(f).sort((a,b)=>b[1]-a[1]).slice(0,n).map(([k,c])=>{
      const p=k.split('/'); const m=MENUS.find(x=>x.id===p[0]); if(!m) return null;
      const t=m.tabs.find(x=>x.id===p[1]); if(!t) return null;
      return {mid:p[0],tid:p[1],ic:m.ic,label:t.label,n:c};
    }).filter(Boolean);
  }catch(e){ return []; }
}
 renderFreq(){
  const box=$('#freqbar'); if(!box) return;
  const list=topPages(6);
  if(!list.length){ box.style.display='none'; return; }
  box.style.display='flex';
  box.innerHTML='<div class="fq-t">⚡ 常用</div>'+list.map(p=>\`<span class="fq" onclick="gotoPage('\${p.mid}','\${p.tid}')" title="\${esc(p.label)} · 访问 \${p.n} 次">\${p.ic} \${esc(p.label)}</span>\`).join('');
}
`;
  const anchor = ' buildSide(){';
  const k = s.indexOf(anchor);
  if (k < 0) throw new Error('buildSide not found');
  s = s.slice(0, k) + fn + '\n' + s.slice(k);
  stats.freqFn = 1;
} else stats.freqFn = 'already';

/* ---------- 5. buildSide 插入容器 + 首次渲染 ---------- */
{
  const oldHtml = `'<div class="msearch"><input id="mqi" placeholder="搜索页面…  (Ctrl+K)" autocomplete="off"><span id="mqx" title="清除">×</span></div>';`;
  const newHtml = `'<div class="msearch"><input id="mqi" placeholder="搜索页面…  (Ctrl+K)" autocomplete="off"><span id="mqx" title="清除">×</span></div>'+\n    '<div id="freqbar" class="freqbar" style="display:none"></div>';`;
  if (s.includes(oldHtml)) { s = s.replace(oldHtml, newHtml); stats.freqBox = 1; }
  else if (s.includes('id="freqbar"')) stats.freqBox = 'already';
  else console.warn('⚠ 未找到 msearch 锚点');
}
{
  // buildSide 末尾调用 renderFreq()
  const anchor = `    if(e.key==='Escape'&&document.activeElement===qi){ qi.value=''; filterMenu(''); qi.blur(); }\n  });\n}`;
  if (s.includes(anchor) && !s.includes('renderFreq();\n}')) {
    s = s.replace(anchor, anchor.slice(0, -1) + '  renderFreq();\n}');
    stats.freqInit = 1;
  } else stats.freqInit = 'already';
}

/* ---------- 6. selectTab 记录访问 ---------- */
{
  const oldSel = ` selectTab(mid,tid){ const m=MENUS.find(x=>x.id===mid); CURRENT={menu:mid,tab:tid};`;
  const newSel = ` selectTab(mid,tid){ const m=MENUS.find(x=>x.id===mid); CURRENT={menu:mid,tab:tid}; recordVisit(mid,tid); renderFreq();`;
  if (s.includes(oldSel)) { s = s.replace(oldSel, newSel); stats.record = 1; }
  else if (s.includes('recordVisit(mid,tid)')) stats.record = 'already';
  else console.warn('⚠ 未找到 selectTab 锚点');
}

fs.writeFileSync(FILE, s);
console.log('重构完成，各项状态：', JSON.stringify(stats));
console.log('大小 ' + before.length + ' -> ' + s.length);
const menus = (s.match(/\{id:'(ov|acct|content|traffic|conv|mkt|sysops|ai)',ic:/g) || [];
const tabs = (s.match(/render:render\w+/g) || [];
console.log('分组数 ' + menus + ' | 页面数 ' + tabs);
