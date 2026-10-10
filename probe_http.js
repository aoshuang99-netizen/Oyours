const http = require('http');
const paths = ['/api/v14/devices', '/api/v14/causal-chain/status', '/api/v14/data/dau_log?limit=1', '/api/v14/data/analytics?limit=1'];
function probe(p){
  return new Promise((resolve)=>{
    const req = http.get({host:'localhost',port:3002,path:p,timeout:5000},(res)=>{
      let body='';
      res.on('data',d=>body+=d);
      res.on('end',()=>{ try{ const j=JSON.parse(body); resolve({p,ok:true,code:res.statusCode,out:j}); }catch(e){ resolve({p,ok:true,code:res.statusCode,out:body.slice(0,200)}); } });
    });
    req.on('timeout',()=>{ req.destroy(); resolve({p,ok:false,err:'TIMEOUT'}); });
    req.on('error',(e)=>resolve({p,ok:false,err:e.message}));
  });
}
(async()=>{
  console.log('PID 23208 WS ram check skipped; testing HTTP layer...');
  for(const p of paths){
    const r = await probe(p);
    if(r.ok){
      if(p.includes('devices')) console.log(`devices online=${r.out.stats.online} error=${r.out.stats.error}`);
      else if(p.includes('causal-chain')) console.log(`chain phase=${r.out.chainGate.currentPhase} cycles=${r.out.chainGate.stats.totalCycles}`);
      else if(p.includes('dau_log')) console.log(`dau_log total=${r.out.total} cur=${r.out.items && r.out.items[0]?r.out.items[0].currentDAU:'?'}`);
      else if(p.includes('analytics')) console.log(`analytics total=${r.out.total}`);
    } else {
      console.log(`FAIL ${p} -> ${r.err}`);
    }
  }
  console.log('DONE');
})();
