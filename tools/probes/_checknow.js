const https = require('http');
 get(u){return new Promise((res,rej)=>{const r=https.request(u,{},x=>{let b='';x.on('data',d=>b+=d);x.on('end',()=>{try{res(JSON.parse(b))}catch(e){res({raw:b})}})});r.on('error',rej);r.end();});}
(async()=>{
  const base='http://localhost:3005';
  const status = await get(base+'/api/status').catch(e=>({err:e.message}));
  const daily = await get(base+'/api/summary/daily').catch(e=>({err:e.message}));
  const logs = await get(base+'/api/logs?limit=15').catch(e=>({err:e.message}));
  console.log('=== STATUS ===');
  console.log('running:', status.running, '| :', status.totalAccounts, '| cooldownUntil:', status.apiCooldownUntil, '| now:', new Date().toISOString());
  console.log('device:', status.device && (status.device.browserUp?'up':'down'), 'browsers:', status.device&&status.device.browserCount, 'contexts:', status.device&&status.device.contextCount);
  console.log('\n=== DAILY 2026-08-20 ===');
  if(daily.actions) console.log('actions:', JSON.stringify(daily.actions));
  if(daily.accountCountByPhase) console.log('phases:', JSON.stringify(daily.accountCountByPhase));
  if(daily.newRegistrations!==undefined) console.log('newRegistrations:', daily.newRegistrations);
  if(daily.taggedNormal!==undefined) console.log('taggedNormal:', daily.taggedNormal);
  console.log('\n=== LAST 15 LOGS ===');
  (logs.logs||[]).forEach(l=>console.log(`${l.at}  ${l.accountId}  ${l.type}  ${l.ok?'OK':'FAIL'}  ${(l.detail||'').slice(0,70)}`));
  process.exit(0);
})();
