// 加速报告：直读权威数据文件做全量分析（只读）
const fs=require('fs');
const D='D:/mscms-ws/data/';
const rd=n=>{try{return JSON.parse(fs.readFileSync(D+n,'utf8'))}catch(e){return null}};
const day=s=>String(s||'').slice(0,10);
const now=new Date(); const today=new Date(now.getTime()+8*3600e3).toISOString().slice(0,10); // 北京时间日界
const P=rd('publish.json')||[]; const C=rd('content.json')||[]; const A=rd('.json')||[];
const N=rd('tumblr_nurture.json'); const TK=rd('.json'); const L=rd('traffic_links.json')||[];
const o={today,totalP:P.length,totalC:C.length,totalA:A.length,linkTotal:L.length};
// ---- 发布：近14天 ----
const pd={};
for(const r of P){const d=day(r.published_at||r.createdAt);if(!d)continue;pd[d]=pd[d]||{n:0,ok:0,pf:{}};pd[d].n++;if(r.publish_url){pd[d].ok++;const k=r.||'?';pd[d].pf[k]=(pd[d].pf[k]||0)+1;}}
o.publishDaily=Object.fromEntries(Object.entries(pd).sort().slice(-16));
// ---- 发布：状态分布 ----
const pst={};for(const r of P){const s=r.status||'(none)';pst[s]=(pst[s]||0)+1;}o.publishStatus=pst;
// ---- 今日发布账号 top ----
const pa={};for(const r of P){if(day(r.published_at||r.createdAt)!==today)continue;const a=r.account_id||r.accountId||'?';pa[a]=(pa[a]||0)+1;}
o.publishTodayByAccount=Object.fromEntries(Object.entries(pa).sort((a,b)=>b[1]-a[1]));
o.publishTodayTotal=Object.values(pa).reduce((s,v)=>s+v,0);
// ---- 内容：平台/状态/日期 ----
const cp={},cs={},cd={};
for(const r of C){const p=r.||'(none)';cp[p]=(cp[p]||0)+1;const s=r.status||r.state||'(none)';cs[s]=(cs[s]||0)+1;const d=day(r.createdAt||r.);if(d)cd[d]=(cd[d]||0)+1;}
o.contentByPlatform=cp;o.contentByStatus=cs;o.contentDaily=Object.fromEntries(Object.entries(cd).sort().slice(-16));
// nostr 明细
const nost=C.filter(r=>r.==='nostr');
o.nostr={total:nost.length,byStatus:(()=>{const b={};for(const r of nost){const s=r.status||r.state||'?';b[s]=(b[s]||0)+1;}return b;})(),
  recent:nost.slice().sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))).slice(0,12).map(r=>({id:r.id,st:r.status||r.state,len:(r.body||'',at:day(r.createdAt),url:r.publish_url?String(r.publish_url).slice(0,42):null,acc:r.queued_account_id||r.account_id||null}))};
// ---- 内容：缺口（空正文 / 重复）----
let empty=0,short=0;for(const r of C){const b=(r.body||'');if(!b||b.length<30)empty++;else if(b.length<100)short++;}
o.contentEmptyBody=empty;o.contentShortBody=short;
// 指纹重复
const fp={};let dup=0;for(const r of C){const k=String(r.body||'').trim().slice(0,120);if(!k)continue;fp[k]=(fp[k]||0)+1;}
for(const k in fp)if(fp[k]>1)dup+=fp[k]-1;o.contentDupRows=dup;o.contentDupRate=(dup/Math.max(1,C.length)*100).toFixed(1)+'%';
// ---- 账号：状态/可发布性 ----
const tkIds=TK?Object.keys(TK):[];
const bySt={};for(const r of A){const s=r.status||'?';bySt[s]=(bySt[s]||0)+1;}o.accountByStatus=bySt;
o.tokenCount=tkIds.length;
const inter=A.filter(r=>tkIds.includes(r.account_id||r.id));o.WithToken=inter.length;
o.publishable=inter.filter(r=>r.status&&r.status!=='';
// ---- 养号：近14天动作 ----
if(N&&N.daily){o.nurtureDaily=Object.fromEntries(Object.entries(N.daily).sort().slice(-16));}
o.nurtureRecords=Array.isArray(N)?N.length:(N?Object.keys(N:0);
// ---- 流量链接 ----
const bySrc={};let clicks=0;for(const l of L){const s=l.source||l.channel||l.||'?';bySrc[s]=(bySrc[s]||0)+1;clicks+=(l.clicks||l.visits||0);}
o.linkBySource=bySrc;o.linkClicks=clicks;
console.log(JSON.stringify(o,null,1));
