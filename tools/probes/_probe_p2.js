const https = require('http');
function post(u, body, ms){return new Promise((res,rej)=>{const data=JSON.stringify(body||{});const r=https.request(u,{method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}},x=>{let b='';x.on('data',d=>b+=d);x.on('end',()=>{try{res(JSON.parse(b))}catch(e){res({raw:b})}})});r.on('error',rej);r.write(data);r.end();const t=setTimeout(()=>{r.destroy();rej(new Error('HTTP_TIMEOUT'))},ms||90000);r.on('close',()=>clearTimeout(t));});}
(async()=>{
  const base='http://localhost:3005';
  // 找一个有 phase P2 的账号
  const st = await post(base+'/api/status',{},90000).catch(e=>({err:e.message}));
  const acc = (st.snapshot&&st.snapshot.accounts||[]).find(a=>a.phase==='P2');
  const id = acc && acc.id;
  console.log('P2 account:', id, 'phase map:', JSON.stringify(st.snapshot&&st.snapshot.accountCountByPhase));
  if(!id){ console.log('no P2 account found'); process.exit(0); }
  const t0=Date.now();
  try {
    const r = await post(base+'/api/run-one', { accountId:id, phase:'P2' }, 90000);
    console.log(`(${((Date.now()-t0)/1000).toFixed(1)}s) run-one result:`, JSON.stringify(r.result||r).slice(0,400));
  } catch(e){ console.log(`(${((Date.now()-t0)/1000).toFixed(1)}s) ERR`, e.message); }
  process.exit(0);
})();
