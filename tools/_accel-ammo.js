// 计算"真正可用弹药"：ready 池中 正文充足 且 未与已发布内容重复 的部分
const fs=require('fs');const D='D:/mscms-ws/data/';
const C=JSON.parse(fs.readFileSync(D+'content.json','utf8'));
const fp=s=>String(s||'').replace(/\s+/g,'').trim().slice(0,120);
const pub=new Set(),pubTopic=new Set();
for(const r of C){const st=r.status||r.state;if(st==='published'){pub.add(fp(r.body));if(r.title)pubTopic.add(String(r.title).trim());}}
const ready=C.filter(r=>(r.status||r.state)==='ready');
const g={};
for(const r of ready){const p=r.||'?';g[p]=g[p]||{ready:0,bodyOk:0,uniq:0,ammo:0};
  g[p].ready++;const b=(r.body||'';if(b>=100)g[p].bodyOk++;
  const isDup=pub.has(fp(r.body))||(r.title&&pubTopic.has(String(r.title).trim()));
  if(!isDup)g[p].uniq++;
  if(b>=100&&!isDup)g[p].ammo++;}
// 全局
const tot={ready:ready.length,bodyOk:0,uniq:0,ammo:0};
for(const k in g){tot.bodyOk+=g[k].bodyOk;tot.uniq+=g[k].uniq;tot.ammo+=g[k].ammo;}
console.log('按平台:',JSON.stringify(g,null,1));
console.log('合计:',JSON.stringify(tot));
// 可发布通道（tumblr/nostr）的弹药
console.log('可发布通道弹药(tumblr+nostr):',g.tumblr.ammo+g.nostr.ammo);
// ready 池创建时间分布（近7天）
const bj=s=>{const t=new Date(s);return isNaN(t)?null:new Date(t.getTime()+8*3600e3).toISOString().slice(0,10)};
const byd={};for(const r of ready){const d=bj(r.createdAt||r.);if(d)byd[d]=(byd[d]||0)+1;}
console.log('ready池按天:',JSON.stringify(Object.fromEntries(Object.entries(byd).sort().slice(-10))));
// 可发布通道按天
const byd2={};for(const r of ready){if(!/tumblr|nostr/.test(r.||''))continue;const d=bj(r.createdAt||r.);if(d)byd2[d]=(byd2[d]||0)+1;}
console.log('tumblr+nostr ready 按天:',JSON.stringify(Object.fromEntries(Object.entries(byd2).sort().slice(-10))));
