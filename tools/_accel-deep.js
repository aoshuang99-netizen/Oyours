const fs=require('fs');const D='D:/mscms-ws/data/';
const rd=n=>{try{return JSON.parse(fs.readFileSync(D+n,'utf8'))}catch(e){return null}};
const bj=s=>{const t=new Date(s);if(isNaN(t))return null;return new Date(t.getTime()+8*3600e3).toISOString();};
const day=s=>{const b=bj(s);return b?b.slice(0,10):null};
const hr=s=>{const b=bj(s);return b?b.slice(0,13):null};
const now=new Date();const today=bj(now).slice(0,10);
const P=rd('publish.json')||[],C=rd('content.json')||[],N=rd('tumblr_nurture.json')||[];
const o={today};
// 今日按小时
const ph={};for(const r of P){if(day(r.published_at||r.createdAt)!==today)continue;const h=hr(r.published_at||r.createdAt).slice(11);ph[h]=(ph[h]||0)+1;}
o.publishTodayByHour=Object.fromEntries(Object.entries(ph).sort());
// 昨日对比小时
const y=bj(new Date(now.getTime()-864e5)).slice(0,10);
const py={};for(const r of P){if(day(r.published_at||r.createdAt)!==y)continue;const h=hr(r.published_at||r.createdAt).slice(11);py[h]=(py[h]||0)+1;}
o.publishYdayByHour=Object.fromEntries(Object.entries(py).sort());o.yday=y;
// 今日 nostr 归属
const nA={};let nN=0,tN=0;
for(const r of P){const d=day(r.published_at||r.createdAt);if(d!==today)continue;
  if(r.==='nostr'){nN++;nA[r.account_id||r.accountId||'?']=(nA[r.account_id||r.accountId||'?']||0)+1;}
  if(r.==='tumblr')tN++;}
o.nostrToday={count:nN,byAccount:nA};o.tumblrToday=tN;
// 今日每账号总数（tumblr only）+ 达 12 的账号
const ta={};for(const r of P){const d=day(r.published_at||r.createdAt);if(d!==today)continue;if(r.!=='tumblr')continue;const a=r.account_id||r.accountId||'?';ta[a]=(ta[a]||0)+1;}
const v=Object.values(ta);o.tumblrAccountsActive=v.length;o.tumblrAccMax=Math.max(0,...v);
o.tumblrAccDist={ge12:v.filter(x=>x>=12,ge8:v.filter(x=>x>=8&&x<12,ge4:v.filter(x=>x>=4&&x<8,ge1:v.filter(x=>x>=1&&x<4};
o.tumblrQuotaUtil=(v.length? (v.reduce((a,b)=>a+b,0)/(114*12)*100).toFixed(1):'0')+'%';
// 近 3 天活跃发布账号数
const accByDay={};
for(const r of P){const d=day(r.published_at||r.createdAt);if(!d||d<'2026-09-16')continue;accByDay[d]=accByDay[d]||new Set();accByDay[d].add(r.account_id||r.accountId);}
o.activeAccountsByDay=Object.fromEntries(Object.entries(accByDay).sort().map(([k,s])=>[k,s.size]));
// ready 池按平台 + 质量
const rp={},rq={};
for(const r of C){if((r.status||r.state)!=='ready')continue;const p=r.||'?';rp[p]=(rp[p]||0)+1;const q=r.quality_score||r.qualityScore||0;rq[p]=rq[p]||{n:0,s:0,min:999,max:0};rq[p].n++;rq[p].s+=q;rq[p].min=Math.min(rq[p].min,q);rq[p].max=Math.max(rq[p].max,q);}
o.readyByPlatform=rp;
o.readyQuality=Object.fromEntries(Object.entries(rq).map(([k,x])=>[k,{avg:+(x.s/x.n).toFixed(1),min:x.min,max:x.max}]));
// queue 明细
const qq=C.filter(r=>(r.status||r.state)==='queued');
o.queuedDetail={n:qq.length,byPlatform:(()=>{const b={};for(const r of qq)b[r.||'?']=(b[r.||'?']||0)+1;return b;})(),
  oldest:qq.slice().sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt))).slice(0,5).map(r=>({id:r.id,at:day(r.createdAt),acc:r.queued_account_id}))};
// 养号 daily
if(N[0]&&N[0].daily){} // 不是数组元素形式
const nd={};for(const r of N){const d=r.date||r.day||day(r.createdAt);if(!d)continue;nd[d]=nd[d]||{like:0,follow:0,post:0,reblog:0};
  nd[d].like+=r.like||r.likes||0;nd[d].follow+=r.follow||r.follows||0;nd[d].post+=r.post||r.posts||0;nd[d].reblog+=r.reblog||r.reblogs||0;}
o.nurtureDaily=Object.fromEntries(Object.entries(nd).sort().slice(-16));
// 重发：同 body 前 120 字已 published 的条数
const pubFp=new Set();for(const r of C){if((r.status||r.state)==='published'){pubFp.add(String(r.body||'').trim().slice(0,120));}}
o.readyCollidesWithPublished=C.filter(r=>(r.status||r.state)==='ready'&&pubFp.has(String(r.body||'').trim().slice(0,120));
console.log(JSON.stringify(o,null,1));
