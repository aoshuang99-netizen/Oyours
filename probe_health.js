const http = require('http');
function get(p){
  return new Promise((resolve)=>{
    const req = http.get({host:'localhost',port:3002,path:p,timeout:6000},(res)=>{
      let b=''; res.on('data',d=>b+=d); res.on('end',()=>{ try{resolve(JSON.parse(b));}catch(e){resolve({_raw:b.slice(0,300)});} });
    });
    req.on('timeout',()=>{req.destroy();resolve({_err:'TIMEOUT '+p});});
    req.on('error',e=>resolve({_err:e.message+' '+p}));
  });
}
(async()=>{
  const cc = await get('/api/v14/causal-chain/status');
  const gate = cc.chainGate || cc;
  console.log('=== CHAIN GATE ===');
  console.log('currentPhase:', gate.currentPhase);
  console.log('totalCycles:', gate.stats && gate.stats.totalCycles);
  const ph = gate.phases || [];
  ph.forEach(p=>{
    const st = p.stalledSeconds!=null? p.stalledSeconds : (p.stalled!=null? p.stalled : '?');
    console.log(`  [${p.id||p.phase}] cur=${p.current}/${p.target} state=${p.state} stalled=${st}s progress@=${p.lastProgressAt?new Date(p.lastProgressAt).toISOString():'?'}`);
  });

  console.log('\n=== MODULE TOTALS ===');
  const mods = await get('/api/v14/datastore/modules');
  (mods.items||mods||[]).forEach(m=>{
    console.log(`  ${m.module}: ${m.totalRecords!=null?m.totalRecords:m.total}`);
  });

  // dau source distribution from latest dau_log
  console.log('\n=== DAU LATEST ===');
  const dl = await get('/api/v14/data/dau_log?limit=1');
  if(dl.items && dl.items[0]){
    const it = dl.items[0];
    console.log('currentDAU=', it.currentDAU, 'timestamp=', it.timestamp);
    if(it.sources) console.log('sources=', JSON.stringify(it.sources));
  }
  console.log('\nDONE');
})();
