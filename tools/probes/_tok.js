const fs=require('fs');
for(const f of ['data/tumblr_token.json','data/tumblr_account.json','data/accounts.json','data/tumblr_config.json']){
  try{ const m=JSON.parse(fs.readFileSync(f,'utf8')); const n=Object.keys(m).length; const keys=Object.keys(m).slice(0,3); console.log(f,'keys=',n,'sample=',JSON.stringify(keys)); }
  catch(e){ console.log(f,'ERR',e.message); }
}
