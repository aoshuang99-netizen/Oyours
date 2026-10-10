// 重构 v14-dash.html 的左侧信息架构：12 组 44 页 → 7 组 42 页，并注入智能搜索
const fs = require('fs');
const FILE = process.argv[2] || 'C:/Users/AS/WorkBuddy/2026-06-13-19-42-19/v14-dash.html';

const NEW_MENUS = `/* =====================================================================
   信息架构 v2 · 2026-09-06 重构
   ---------------------------------------------------------------------
   旧：12 个二级菜单 / 44 个三级页（功能重叠严重）
   新：7  个二级菜单 / 42 个三级页，按业务流程单链排列：
       总览 → 资产 → 生产 → 分发 → 流量 → 转化 → 系统

   已合并的重复功能：
    ① 「数据分析/因果链监控」≡「全链路因果链监控/7 阶段漏斗」
       → 二者调用同一个 renderAnalCausal，属 100% 重复，保留 1 个（运营总览/7 阶段漏斗）
    ② 「账号管理/闭环一致性」≡「内容运营/账号闭环」
       → 同源数据(content+publish)、同一指标(平台级闭环率)，保留 1 个（账号与设备/闭环一致性）
    ③ 「引流转化/活动中心」≡「主动营销/活动编排」
       → 均为营销活动台账，保留可编辑的「营销活动/活动编排」，活动日志并入其下钻
    ④ 「数据分析/AI 洞察」与「AI 洞察(NL)」拆成两个菜单
       → 合并为「运营总览/AI 洞察」+「系统与 AI」中的问答/周报/根因
   ===================================================================== */
const MENUS=[
 {id:'ov',ic:'📊',label:'运营总览',desc:'一眼看清全链路健康',
  tabs:[
   {id:'compass', label:'核心指标罗盘',   render:renderAnalCompass},
   {id:'causal',  label:'7 阶段漏斗',     render:renderAnalCausal},
   {id:'timeline',label:'周期时间线',     render:renderChainTimeline},
   {id:'guard',   label:'停滞守卫·转化率',render:renderChainGuard},
   {id:'ai',      label:'AI 洞察',        render:renderAnalAI},
  ]},
 {id:'acct',ic:'🔐',label:'账号与设备',desc:'账号资产 · 云手机 · 指纹 · 代理',
  tabs:[
   {id:'overview',  label:'账号全景',    render:renderAcctOverview},
   {id:'platforms', label:'平台分布',    render:renderAcctPlatforms},
   {id:'register',  label:'注册工厂',    render:renderAcctRegister},
   {id:'nurture',   label:'养号监控',    render:renderAcctNurture},
   {id:'closedloop',label:'闭环一致性',  render:renderAcctClosedLoop},
   {id:'fleet',     label:'云手机舰队',  render:renderDevFleet},
   {id:'finger',    label:'指纹反检测',  render:renderDevFinger},
   {id:'proxy',     label:'代理健康',    render:renderDevProxy},
   {id:'keepalive', label:'保活自愈',    render:renderDevKeepAlive},
  ]},
 {id:'content',ic:'📝',label:'内容与发布',desc:'生产 · 编辑 · 分发 · 发布台',
  tabs:[
   {id:'factory',  label:'内容工厂',        render:renderContentFactory},
   {id:'editor',   label:'内容编辑',        render:renderContentEditor},
   {id:'funnel',   label:'发布漏斗',        render:renderContentFunnel},
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
 {id:'sys',ic:'⚙️',label:'系统与 AI',desc:'健康 · 编排 · 决策 · 智能问答',
  tabs:[
   {id:'health',  label:'系统健康',  render:renderSysHealth},
   {id:'dag',     label:'DAG 拓扑',  render:renderSysDag},
   {id:'bus',     label:'事件总线',  render:renderSysBus},
   {id:'decision',label:'决策引擎',  render:renderAnalDecision},
   {id:'nlq',     label:'AI 问答',   render:renderAiNlq},
   {id:'report',  label:'周报月报',  render:renderAiReport},
   {id:'root',    label:'根因建议',  render:renderAiRoot},
  ]},
];`;

const NEW_BUILD_SIDE = `function buildSide(){
  const side=$('#side');
  side.innerHTML='<div id="brand"><h1>MSCMS v14</h1><div class="sub">全域运营监控大盘</div></div>'+
    '<div class="msearch"><input id="mqi" placeholder="搜索页面…  (Ctrl+K)" autocomplete="off"><span id="mqx" title="清除">×</span></div>';
  MENUS.forEach(m=>{
    const mi=document.createElement('div'); mi.className='mi'; mi.dataset.m=m.id; mi.dataset.kw=(m.label+' '+(m.desc||'')+' '+m.tabs.map(t=>t.label).join(' ')).toLowerCase();
    mi.innerHTML=\`<span class="ic">\${m.ic}</span><span class="lbl">\${m.label}</span><span class="bad" id="bad-\${m.id}">…</span>\`;
    mi.title=m.desc||m.label;
    mi.onclick=()=>selectMenu(m.id);
    side.appendChild(mi);
    const st=document.createElement('div'); st.className='subtabs'; st.id='subs-'+m.id; st.style.display='none';
    m.tabs.forEach(t=>{ const sb=document.createElement('div'); sb.className='subtab'; sb.dataset.t=t.id;
      sb.dataset.kw=(m.label+' '+t.label).toLowerCase(); sb.textContent=t.label;
      sb.onclick=(e)=>{e.stopPropagation();selectTab(m.id,t.id);}; st.appendChild(sb); });
    side.appendChild(st);
  });
  const qi=$('#mqi');
  qi.addEventListener('input',()=>filterMenu(qi.value.trim().toLowerCase()));
  $('#mqx').onclick=()=>{ qi.value=''; filterMenu(''); qi.focus(); };
  document.addEventListener('keydown',(e)=>{
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){ e.preventDefault(); qi.focus(); qi.select(); }
    if(e.key==='Escape'&&document.activeElement===qi){ qi.value=''; filterMenu(''); qi.blur(); }
  });
}
/* 智能过滤：命中关键词时展开命中项，隐藏无关菜单；空输入恢复常态 */
function filterMenu(q){
  const mi=[...document.querySelectorAll('#side .mi')];
  let total=0;
  mi.forEach(el=>{
    const subs=$('#subs-'+el.dataset.m);
    const items=[...subs.querySelectorAll('.subtab')];
    const selfHit=!q||el.dataset.kw.includes(q);
    let shown=0;
    items.forEach(it=>{ const hit=!q||it.dataset.kw.includes(q); it.style.display=hit?'':'none'; if(hit)shown++; });
    const visible=selfHit||shown>0;
    el.style.display=visible?'':'none';
    subs.style.display=(q&&shown>0)?'block':(q?'none':subs.style.display);
    if(visible) total++;
    if(q&&shown>0) el.classList.add('on');
    else if(q) el.classList.remove('on');
  });
  let ph=$('#mqempty');
  if(q&&total===0){ if(!ph){ ph=document.createElement('div'); ph.id='mqempty'; ph.className='mqempty'; ph.textContent='无匹配页面'; $('#side').appendChild(ph); } ph.style.display=''; }
  else if(ph) ph.style.display='none';
}
function gotoPage(mid,tid){ selectMenu(mid); if(tid) selectTab(mid,tid); }`;

const NEW_SELECT = `function selectMenu(id){ const m=MENUS.find(x=>x.id===id); if(!m) return;
  const qi=$('#mqi'); if(qi&&qi.value){ qi.value=''; filterMenu(''); }
  MENUS.forEach(x=>{ const el=$('.mi[data-m="'+x.id+'"]'); if(el)el.classList.toggle('on',x.id===id); const sb=$('#subs-'+x.id); if(sb)sb.style.display=x.id===id?'block':'none'; });
  const t=m.tabs.find(x=>x.id===CURRENT.tab&&CURRENT.menu===id)||m.tabs[0];
  selectTab(id,t.id);
}`;

const NEW_BADGES = `async function updateBadges(){
  try{
    const [dev,acc,cc,mkt,ov]=await Promise.all([
      loadDevices(),
      API('/api/v14/accounts'),
      API('/api/v14/causal-chain/status'),
      API('/api/v14/marketing/stats').catch(()=>({})),
      API('/api/v14/data/overview').catch(()=>({})),
    ]);
    const st=dev.stats||{}; devCount=(st.online||0)+'/'+(st.total||0);
    acctCount=(acc.accounts||[]).length;
    chainCount=(cc.stats&&cc.stats.totalHandled)||0;
    mktCount=(mkt&&mkt.totalCampaigns!=null)?((mkt.activeCampaigns||0)+'/'+mkt.totalCampaigns):'';
    const ms=ov.moduleStats||{}; const rec=k=>((ms[k]&&ms[k].totalRecords)||0);
    contentCount=rec('content');
    linkCount=rec('link_traffic');
    convCount=rec('conversion_logs');
    const map={ov:chainCount,acct:acctCount,content:contentCount,traffic:linkCount,conv:convCount,mkt:mktCount,sys:devCount};
    MENUS.forEach(m=>{ const b=$('#bad-'+m.id); if(b) b.textContent=map[m.id]!=null&&map[m.id]!==''?map[m.id]:'·'; });
  }catch(e){}
}`;

const EXTRA_CSS = `
/* ── 智能菜单搜索（信息架构 v2） ── */
.msearch{position:relative;padding:8px 10px;border-bottom:1px solid var(--bord)}
.msearch input{width:100%;background:var(--bg);border:1px solid var(--bord);border-radius:6px;color:var(--txt);font:inherit;font-size:12px;padding:6px 24px 6px 9px;outline:none}
.msearch input:focus{border-color:var(--acc)}
.msearch #mqx{position:absolute;right:18px;top:50%;transform:translateY(-50%);color:var(--mut);cursor:pointer;font-size:14px;line-height:1;padding:2px 4px}
.msearch #mqx:hover{color:var(--txt)}
.mqempty{padding:14px;color:var(--mut2);font-size:12px;text-align:center}
.mi .ic{font-size:15px}
.subtab{padding:6px 12px}
#brand .sub{color:var(--mut);font-size:11px;margin-top:3px}
`;

// 定位一个函数块的结束行：单行函数（括号自配平且以 } 结尾）直接返回自身，否则找行首为 } 的行
function blockEnd(L, start) {
  const line = L[start];
  const open = (line.match(/\{/g) || []).length;
  const close = (line.match(/\}/g) || []).length;
  if (open > 0 && open === close && /\}\s*$/.test(line)) return start;
  let i = start + 1;
  while (i < L.length && !/^\}/.test(L[i])) i++;
  return i;
}

let src = fs.readFileSync(FILE, 'utf8');
const L = src.split('\n');
const out = [];
let i = 0;
let stats = { menus: 0, buildSide: 0, selectMenu: 0, badges: 0, css: 0, hardcode: 0 };

while (i < L.length) {
  const line = L[i];
  if (line.startsWith('const MENUS=[')) {
    out.push(NEW_MENUS);
    while (!/^\];/.test(L[i])) i++;
    i++; stats.menus++;
    continue;
  }
  if (line.startsWith('function buildSide(){')) {
    out.push(NEW_BUILD_SIDE);
    i = blockEnd(L, i) + 1; stats.buildSide++;
    continue;
  }
  if (line.startsWith('function selectMenu(id){')) {
    out.push(NEW_SELECT);
    i = blockEnd(L, i) + 1; stats.selectMenu++;
    continue;
  }
  if (line.startsWith('async function updateBadges(){')) {
    out.push(NEW_BADGES);
    i = blockEnd(L, i) + 1; stats.badges++;
    continue;
  }
  if (line.includes("selectMenu('trendstudio');selectTab('trendstudio','tumblr');")) {
    out.push(line.replace(/selectMenu\('trendstudio'\);selectTab\('trendstudio','tumblr'\);/g, "gotoPage('content','tumblr');"));
    i++; stats.hardcode++;
    continue;
  }
  out.push(line);
  i++;
}

// 注入 CSS 到首个 </style> 前
const joined = out.join('\n');
const final = joined.replace(/\n<\/style>/, '\n' + EXTRA_CSS + '</style>');
if (final !== joined) stats.css++;

fs.writeFileSync(FILE, final, 'utf8');
console.log('重构完成: ' + JSON.stringify(stats));
