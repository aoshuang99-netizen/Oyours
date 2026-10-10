const fs=require('fs');
for(const f of ['data/accounts.json','data/tumblr_config.json','data/tumblr_token.json']){
  try{
    const m=JSON.parse(fs.readFileSync(f,'utf8'));
    const arr=Object.entries(m);
    console.log('===',f,'total',arr.length);
    console.log(JSON.stringify(arr.slice(0,2).map(([k,v])=>({k, hasToken:!!(v&&v.oauthToken), platform:v&&v.platform, status:v&&v.status, proxy:v&&v.proxy})),null,0));
  }catch(e){console.log(f,'ERR',e.message);}
}
