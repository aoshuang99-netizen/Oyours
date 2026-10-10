const https = require('http');
function get(u,ms){return new Promise((res,rej)=>{const r=https.request(u,{},x=>{let b='';x.on('data',d=>b+=d);x.on('end',()=>{try{res(JSON.parse(b))}catch(e){res({raw:b})}})});r.on('error',rej);r.end();const t=setTimeout(()=>{r.destroy();rej(new Error('HTTP_TIMEOUT'))},ms||30000);r.on('close',()=>clearTimeout(t));});}
(async()=>{
  const base='http://localhost:3005';
  const st = await get(base+'/api/status',30000).catch(e=>({err:e.message}));
  console.log('running:', st.running, '| totalAccounts:', st.totalAccounts);
  const snap = st.snapshot||{};
  console.log('snapshot keys:', Object.keys(snap).join(','));
  if(Array.isArray(snap.accounts)) {
    const phases={}; snap.accounts.forEach(a=>{phases[a.phase]=(phases[a.phase]||0)+1;});
    console.log('phases:', JSON.stringify(phases), 'sample:', JSON.stringify(snap.accounts.slice(0,2)));
  } else {
    console.log('snapshot.accounts is', typeof snap.accounts, '| raw snapshot:', JSON.stringify(snap).slice(0,300));
  }
  // 看 lastTickAt 是否推进：读日志文件 mtime + 最新条时间
  process.exit(0);
})();
