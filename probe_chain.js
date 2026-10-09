const BASE='http://localhost:3002';
const get=async(u)=>{try{const r=await fetch(BASE+u);return await r.json();}catch(e){return{__err__:e.message};}};
(async()=>{
  // 1. devices
  const d=await get('/api/v14/devices');
  const devs=(d&&d.devices)?d.devices:[];
  const byStatus={};
  devs.forEach(x=>{const s=x.status||'unknown';byStatus[s]=(byStatus[s]||0)+1;});
  console.log('DEVICE total:',devs.length,'byStatus:',JSON.stringify(byStatus));
  if(devs.length){const f=Object.keys(devs[0]).filter(k=>/ctx|browser|context|online|ready|status/i.test(k));console.log('  ctx/status fields:',f.join(','));}

  // 2. publish
  const p=await get('/api/v14/data/publish?limit=6&sort=&order=desc');
  const pi=(p&&p.items)?p.items:[];
  console.log('PUBLISH total='+(p&&p.total)+' items='+pi.length);
  pi.slice(0,6).forEach(x=>console.log('  ',(String(x.||x.published_at||'?')).substring(0,19),'|',x.,'|',x.status,'| src='+x.source,'| sim='+x.simulated));

  // 3. visits
  const v=await get('/api/v14/data/visits?limit=6&sort=&order=desc');
  const vi=(v&&v.items)?v.items:[];
  console.log('VISITS total='+(v&&v.total)+' items='+vi.length);
  vi.slice(0,6).forEach(x=>console.log('  ',(String(x.||'?')).substring(0,19),'|',x.,'| src='+x.source));

  // 4. dau
  const dl=await get('/api/v14/data/dau_log?limit=4&sort=&order=desc');
  const di=(dl&&dl.items)?dl.items:[];
  console.log('DAU_LOG total='+(dl&&dl.total)+' items='+di.length);
  di.slice(0,4).forEach(x=>console.log('  ','dau='+(x.currentDAU!=null?x.currentDAU:x.current_dau),'target='+(x.targetDAU!=null?x.targetDAU:x.target_dau)));

  // 5. chain status
  const cc=await get('/api/v14/causal-chain/status');
  const ph=cc.phases||(cc.chainGate&&cc.chainGate.phases)||[];
  console.log('CHAIN phases:');
  ph.forEach(p=>console.log('  ',p.name,'| target='+p.target,'cur='+p.current,'| status='+p.status,'| running='+(p.running!=null?p.running:'?')));
})().catch(e=>{console.error('FATAL',e);process.exit(1);});
