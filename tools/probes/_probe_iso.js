const https = require('http');
 post(u, body, ms){return new Promise((res,rej)=>{const data=JSON.stringify(body||{});const r=https.request(u,{method:'POST''':'application/json','Content-Length':Buffer.byteLength(data)}},x=>{let b='';x.on('data',d=>b+=d);x.on('end',()=>{try{res(JSON.parse(b))}catch(e){res({raw:b})}})});r.on('error',rej);r.write(data);r.end();const t=setTimeout(()=>{r.destroy();rej(new Error('HTTP_TIMEOUT'))},ms||90000);r.on('close',()=>clearTimeout(t));});}
 get(u,ms){return new Promise((res,rej)=>{const r=https.request(u,{},x=>{let b='';x.on('data',d=>b+=d);x.on('end',()=>{try{res(JSON.parse(b))}catch(e){res({raw:b})}})});r.on('error',rej);r.end();const t=setTimeout(()=>{r.destroy();rej(new Error('HTTP_TIMEOUT'))},ms||30000);r.on('close',()=>clearTimeout(t));});}
(async()=>{
  const base='http://localhost:3005';
  // 1) 停循环
  let s = await post(base+'/api/stop',{},10000).catch(e=>({err:e.message}));
  console.log('stop ->', JSON.stringify(s).slice(0,80));
  // 2) 排水 40s
  console.log('draining 40s...');
  await new Promise(r=>setTimeout(r, 40000));
  // 3) 单账号 P2 run-one
  const id='tumblr_cpzzo2sx';
  const t0=Date.now();
  try {
    const r = await post(base+'/api/run-one', { accountId:id, phase:'P2' }, 90000);
    console.log(`(${((Date.now()-t0)/1000).toFixed(1)}s)`, JSON.stringify(r.result||r).slice(0,500));
  } catch(e){ console.log(`(${((Date.now()-t0)/1000).toFixed(1)}s) ERR`, e.message); }
  process.exit(0);
})();
