const https = require('http');
 post(u, body, ms){return new Promise((res,rej)=>{const data=JSON.stringify(body||{});const r=https.request(u,{method:'POST''':'application/json','Content-Length':Buffer.byteLength(data)}},x=>{let b='';x.on('data',d=>b+=d);x.on('end',()=>{try{res(JSON.parse(b))}catch(e){res({raw:b})}})});r.on('error',rej);r.write(data);r.end();const t=setTimeout(()=>{r.destroy();rej(new Error('HTTP_TIMEOUT'))},ms||75000);r.on('close',()=>clearTimeout(t));});}
(async()=>{
  const base='http://localhost:3005';
  const id='tumblr_cpzzo2sx';
  const t0=Date.now();
  try {
    const r = await post(base+'/api/run-one', { accountId:id, phase:'P2' }, 75000);
    console.log(`(${((Date.now()-t0)/1000).toFixed(1)}s)`, JSON.stringify(r.result||r).slice(0,500));
  } catch(e){ console.log(`(${((Date.now()-t0)/1000).toFixed(1)}s) ERR`, e.message); }
  process.exit(0);
})();
