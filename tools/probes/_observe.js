const https = require('http');
function get(u){return new Promise((res,rej)=>{const r=https.request(u,{},x=>{let b='';x.on('data',d=>b+=d);x.on('end',()=>{try{res(JSON.parse(b))}catch(e){res({raw:b})}})});r.on('error',rej);r.end();});}
(async()=>{
  const base='http://localhost:3005';
  const before = await get(base+'/api/summary/daily').catch(e=>({err:e.message}));
  console.log('BEFORE apiOk:', before.actions && before.actions.okActions, '| devSessions:', before.actions && before.actions.deviceSessions, '| errors:', before.actions && before.actions.errors);
  // 观测 5 分钟（首跑错峰在 0~25 分钟内分散，设备会话并发上限 4）
  await new Promise(r=>setTimeout(r, 5*60*1000));
  const status = await get(base+'/api/status').catch(e=>({err:e.message}));
  const daily = await get(base+'/api/summary/daily').catch(e=>({err:e.message}));
  const logs = await get(base+'/api/logs?limit=20').catch(e=>({err:e.message}));
  console.log('\n=== STATUS ===');
  console.log('running:', status.running, '| accounts:', status.totalAccounts, '| cooldownUntil:', status.apiCooldownUntil);
  console.log('device up:', status.device && status.device.browserUp, '| browsers:', status.device&&status.device.browserCount, '| contexts:', status.device&&status.device.contextCount);
  console.log('\n=== DAILY 2026-08-20 (delta) ===');
  if(daily.actions) console.log('actions:', JSON.stringify(daily.actions));
  if(daily.accountCountByPhase) console.log('phases:', JSON.stringify(daily.accountCountByPhase));
  console.log('\n=== LAST 20 LOGS ===');
  (logs.logs||[]).forEach(l=>console.log(`${l.at}  ${l.accountId}  ${l.type||''}  ${l.ok?'OK':'FAIL'}  ${(l.detail||'').slice(0,60)}`));
  process.exit(0);
})();
