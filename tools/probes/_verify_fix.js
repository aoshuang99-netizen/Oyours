const https = require('http');
const fs = require('fs');
 get(u,ms){return new Promise((res,rej)=>{const r=https.request(u,{},x=>{let b='';x.on('data',d=>b+=d);x.on('end',()=>{try{res(JSON.parse(b))}catch(e){res({raw:b})}})});r.on('error',rej);r.end();const t=setTimeout(()=>{r.destroy();rej(new Error('HTTP_TIMEOUT'))},ms||30000);r.on('close',()=>clearTimeout(t));});}
 proxyEst(){try{return require('child_process').execSync('netstat -ano | findstr ":10808" | findstr "ESTABLISHED"').trim().split('\n').filter(Boolean;}catch(e){return -1;}}
(async()=>{
  const base='http://localhost:3005';
  const m1 = fs.statSync('data/tumblr_action_log.json').mtimeMs;
  console.log('t=0  proxyEST:', proxyEst(), '| actionlog mtime:', new Date(m1).toISOString());
  // 等 3 分钟让首跑错峰的设备会话 + API 动作跑起来
  await new Promise(r=>setTimeout(r, 3*60*1000));
  const m2 = fs.statSync('data/tumblr_action_log.json').mtimeMs;
  const st = await get(base+'/api/status',30000).catch(e=>({err:e.message}));
  const daily = await get(base+'/api/summary/daily',30000).catch(e=>({err:e.message}));
  console.log('\nt=', ((Date.now()-(m1))/1000).toFixed(0)+'s', 'proxyEST:', proxyEst(), '| actionlog changed:', m2!==m1);
  console.log('running:', st.running, '| cooldownUntil:', st.apiCooldownUntil, '| device contexts(ua):', st.device&&st.device.contextCount, '| browserUp:', st.device&&st.device.browserUp);
  console.log('DAILY actions:', daily.actions?JSON.stringify(daily.actions):'(none)');
  console.log('phases:', daily.accountCountByPhase?JSON.stringify(daily.accountCountByPhase):'n/a');
  process.exit(0);
})();
