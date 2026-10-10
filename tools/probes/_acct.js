const fs=require('fs');
const m=JSON.parse(fs.readFileSync('data/accounts.json','utf8'));
let real=0,fake=0,sampleFake=[];
for(const [k,v] of Object.entries(m)){
  const hasEmail = !!(v&&v.email&&!/@mscms\.mail$|guerrillamail|mailinator|tempmail|fake|trash/i.test(v.email||''));
  const hasTok = !!(v&&v.oauthToken);
  if(hasEmail){real++;} else {fake++; if(sampleFake.length<3) sampleFake.push({k,email:v&&v.email,plat:v&&v.platform,tok:hasTok});}
}
console.log('accounts.json total', Object.keys(m).length, 'withEmail', real, 'noEmail', fake);
console.log('fake samples', JSON.stringify(sampleFake));
