const https = require('http');
const fs = require('fs');
function post(u, body, ms){return new Promise((res,rej)=>{const data=JSON.stringify(body||{});const r=https.request(u,{method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}},x=>{let b='';x.on('data',d=>b+=d);x.on('end',()=>{try{res(JSON.parse(b))}catch(e){res({raw:b})}})});r.on('error',rej);r.write(data);r.end();const t=setTimeout(()=>{r.destroy();rej(new Error('HTTP_TIMEOUT'))},ms||120000);r.on('close',()=>clearTimeout(t));});}
(async()=>{
  const base='http://localhost:3005';
  // 1) 记录 action-log mtime
  const m1 = fs.statSync('data/tumblr_action_log.json').mtimeMs;
  const t1 = Date.now();
  // 2) 强制一个 P2 账号跑一次（已知 P2: tumblr_cpzzo2sx）
  const id = 'tumblr_cpzzo2sx';
  console.log('forcing run-one P2', id, '...');
  const t0=Date.now();
  try {
    const r = await post(base+'/api/run-one', { accountId:id, phase:'P2' }, 120000);
    console.log(`(${((Date.now()-t0)/1000).toFixed(1)}s)`, JSON.stringify(r.result||r).slice(0,500));
  } catch(e){ console.log(`(${((Date.now()-t0)/1000).toFixed(1)}s) ERR`, e.message); }
  // 3) 再看 mtime 是否变化
  await new Promise(r=>setTimeout(r,2000));
  const m2 = fs.statSync('data/tumblr_action_log.json').mtimeMs;
  console.log(`action-log mtime: ${m1} -> ${m2} (changed: ${m2!==m1}, elapsed ${((Date.now()-t1)/1000).toFixed(0)}s)`);
  process.exit(0);
})();
