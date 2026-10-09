// 加速报告数据采集：只读，不写任何数据
const http = require('http');
 get(p){return new Promise(r=>{const req=http.get({host:'',port:3002,path:p,timeout:40000},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>{try{r({ok:true,s:res.statusCode,j:JSON.parse(b)})}catch(e){r({ok:false,s:res.statusCode,raw:b.slice(0,300)})}})});req.on('error',e=>r({ok:false,err:e.message}));req.on('timeout',()=>{req.destroy();r({ok:false,err:'timeout'})})})}
(async()=>{
  const out={};
  const ov=await get('/api/v14/data/overview');
  if(ov.ok&&ov.j){
    out.coreStats=ov.j.coreStats;
    out.causalChain=(ov.j.causalChain&&ov.j.causalChain.phases||[]).map(p=>({order:p.order,key:p.key||p.name,status:p.status,count:p.count,rate:p.rate}));
    out.eventBus=ov.j.eventBus;
    out.summaryMeta={totalModules:ov.j.summary&&ov.j.summary.totalModules,totalRecords:ov.j.summary&&ov.j.summary.totalRecords};
  } else out.overviewErr=ov.err||ov.s;
  for(const m of ['content','publish','','tumblr_nurture','traffic_links','_config']){
    const r=await get('/api/v14/data/'+m+'?limit=1');
    out['mod_'+m]=r.ok?{total:r.j.total}:{err:r.err||r.s};
  }
  // 内容按平台/状态分布
  const c=await get('/api/v14/data/content?limit=2000');
  if(c.ok&&c.j&&Array.isArray(c.j.items)){
    const by={},st={};
    for(const it of c.j.items){const p=it.||'(none)';by[p]=(by[p]||0)+1;const s=it.status||it.state||'(none)';st[s]=(st[s]||0)+1;}
    out.contentTotal=c.j.total;out.contentByPlatform=by;out.contentByStatus=st;
    const today=new Date().toISOString().slice(0,10);
    out.contentToday=c.j.items.filter(i=>String(i.createdAt||'').slice(0,10)===today;
    out.contentNostr=(c.j.items.filter(i=>i.==='nostr')||[];
  } else out.contentErr=c.err||c.s;
  // 发布记录分析
  const p=await get('/api/v14/data/publish?limit=2000');
  if(p.ok&&p.j&&Array.isArray(p.j.items)){
    const its=p.j.items;
    out.publishTotal=p.j.total;
    const today=new Date().toISOString().slice(0,10);
    const t=its.filter(i=>String(i.published_at||i.createdAt||'').slice(0,10)===today);
    out.publishToday=t.length;
    out.publishTodaySuccess=t.filter(i=>i.publish_url;
    out.publishTodayByPlatform=(()=>{const b={};for(const i of t){const k=i.||'(none)';b[k]=(b[k]||0)+1;}return b;})();
    // 近12天每日成功发布
    const daily={};
    for(const i of its){const d=String(i.published_at||i.createdAt||'').slice(0,10);if(!d)continue;daily[d]=daily[d]||{n:0,ok:0};daily[d].n++;if(i.publish_url)daily[d].ok++;}
    out.publishDaily=Object.fromEntries(Object.entries(daily).sort().slice(-14));
    // 今日每账号发布数 top
    const byAcc={};for(const i of t){const a=i.account_id||i.accountId||'(none)';byAcc[a]=(byAcc[a]||0)+1;}
    out.publishTodayByAccount=Object.fromEntries(Object.entries(byAcc).sort((a,b)=>b[1]-a[1]).slice(0,20));
  } else out.publishErr=p.err||p.s;
  // 账号
  const a=await get('/api/v14/data/?limit=2000');
  if(a.ok&&a.j&&Array.isArray(a.j.items)){
    const its=a.j.items;out.Total=a.j.total;
    out.SampleKeys=Object.keys(its[0]||{}).slice(0,25);
  } else out.Err=a.err||a.s;
  console.log(JSON.stringify(out,null,1));
})();
