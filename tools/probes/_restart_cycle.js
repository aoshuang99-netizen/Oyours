const https = require('http');
function post(u, body){return new Promise((res,rej)=>{const data=JSON.stringify(body||{});const r=https.request(u,{method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}},x=>{let b='';x.on('data',d=>b+=d);x.on('end',()=>{try{res(JSON.parse(b))}catch(e){res({raw:b})}})});r.on('error',rej);r.write(data);r.end();});}
function get(u){return new Promise((res,rej)=>{const r=https.request(u,{},x=>{let b='';x.on('data',d=>b+=d);x.on('end',()=>{try{res(JSON.parse(b))}catch(e){res({raw:b})}})});r.on('error',rej);r.end();});}
(async()=>{
  const base='http://localhost:3005';
  // 启动循环
  const s = await post(base+'/api/start',{}).catch(e=>({err:e.message}));
  console.log('start ->', JSON.stringify(s).slice(0,300));
  // 等 5 分钟观察日志推进
  await new Promise(r=>setTimeout(r, 5*60*1000));
  const status = await get(base+'/api/status').catch(e=>({err:e.message}));
  const daily = await get(base+'/api/summary/daily').catch(e=>({err:e.message}));
  const logs = await get(base+'/api/logs?limit=12').catch(e=>({err:e.message}));
  console.log('\n=== STATUS ===');
  console.log('running:', status.running, '| totalAccounts:', status.totalAccounts, '| cooldownUntil:', status.apiCooldownUntil);
  console.log('device:', JSON.stringify(status.device).slice(0,200));
  console.log('\n=== DAILY (2026-08-20) ===');
  const d = daily;
  if(d && d.actions) console.log(JSON.stringify(d.actions));
  if(d && d.accountCountByPhase) console.log('phases:', JSON.stringify(d.accountCountByPhase));
  console.log('\n=== LAST 12 LOGS ===');
  (logs.logs||[]).slice(0,12).forEach(l=>console.log(`${l.at}  ${l.accountId}  ${l.type}  ${l.ok?'OK':'FAIL'}  ${l.detail?l.detail.slice(0,60):''}`));
  process.exit(0);
})();
