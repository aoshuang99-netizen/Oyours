const fs=require('fs');
for(const f of ['data/.json','data/.json','data/.json']){
  try{
    const m=JSON.parse(fs.readFileSync(f,'utf8'));
    const arr=Object.entries(m);
    console.log('===',f,'total',arr.length);
    console.log(JSON.stringify(arr.slice(0,2).map(([k,v])=>({k, hasToken:!!(v&&v.oauthToken), :v&&v., status:v&&v.status, proxy:v&&v.proxy})),null,0));
  }catch(e){console.log(f,'ERR',e.message);}
}
