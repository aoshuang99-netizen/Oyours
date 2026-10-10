'use strict';
// 扫描 GitHub 免费代理，找出能到达 Tumblr 的出口；并用真实 OAuth token 验证可发请求
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fetchExt } = require('./http-client');

const WS = __dirname;
const TUMBLR = 'https://api.tumblr.com/v2/user/info';

function percentEncode(s){return encodeURIComponent(s).replace(/[!*'()]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());}
function genNonce(){return crypto.randomBytes(16).toString('hex');}
function genTimestamp(){return Math.floor(Date.now()/1000);}
function sign(m,u,o,e,cs,ts){const p=Object.assign({},e,o);const k=Object.keys(p).sort();const b=k.map(x=>`${percentEncode(x)}=${percentEncode(String(p[x]))}`).join('&');const bs=`${m.toUpperCase()}&${percentEncode(u)}&${percentEncode(b)}`;const key=`${percentEncode(cs)}&${percentEncode(ts||'')}`;return crypto.createHmac('sha1',key).update(bs).digest('base64');}
function authH(o,s){const a=Object.assign({},o,{oauth_signature:s});return 'OAuth '+Object.keys(a).sort().map(x=>`${percentEncode(x)}="${percentEncode(String(a[x]))}"`).join(', ');}

function loadConfig(){const a=JSON.parse(fs.readFileSync(path.join(WS,'data/tumblr_config.json'),'utf8'));const m={};for(const e of a)m[e.id]=e;return m;}
function loadTokens(){const r=JSON.parse(fs.readFileSync(path.join(WS,'data/tumblr_token.json'),'utf8'));return r&&typeof r==='object'?Object.values(r):[];}

async function tumblrStatusVia(px){
  // 裸 GET（无认证），仅看代理能否把请求送到 Tumblr（401/403/429/500=送到；fetch failed=代理不可达）
  try{
    const r=await fetchExt(TUMBLR,{method:'GET',timeout:8000},px);
    return {status:r.status, ok:true};
  }catch(e){return {status:'ERR', ok:false, err:e.message.slice(0,50)};}
}

async function realOAuthVia(px, cfg, tok){
  const url=TUMBLR;
  const o={oauth_consumer_key:cfg.consumerKey,oauth_nonce:genNonce(),oauth_signature_method:'HMAC-SHA1',oauth_timestamp:genTimestamp(),oauth_version:'1.0',oauth_token:tok.oauthToken};
  const s=sign('GET',url,o,{},cfg.consumerSecret,tok.oauthTokenSecret);
  const h=authH(o,s);
  try{
    const r=await fetchExt(url,{method:'GET',headers:{Authorization:h,'User-Agent':'MSCMS/1.0'},timeout:12000},px);
    const t=await r.text();
    return {status:r.status, body:t.slice(0,160)};
  }catch(e){return {status:'ERR', err:e.message.slice(0,80)};}
}

(async()=>{
  // 拉取代理
  let proxies=[];
  for(const u of ['https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt','https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt']){
    try{const r=await fetchExt(u,{method:'GET',timeout:15000},'http://127.0.0.1:10808');if(r.ok){const txt=await r.text();const lines=txt.split('\n').map(s=>s.trim()).filter(Boolean).filter(l=>/^(\d{1,3}\.){3}\d{1,3}:\d+$/.test(l));proxies.push(...lines);}}catch(e){}
  }
  proxies=[...new Set(proxies)];
  console.log(`候选代理总数: ${proxies.length}`);

  // 扫描前 400 个，收集所有「能到达 Tumblr」的代理（free 代理极不稳定，多收集）
  const working=[];
  const scanN=Math.min(150,proxies.length);
  for(let i=0;i<scanN;i++){
    const p='http://'+proxies[i];
    const res=await tumblrStatusVia(p);
    if(res.ok && res.status!=='ERR'){working.push({proxy:p,status:res.status});}
  }
  console.log(`扫描 ${scanN} 个，能到达 Tumblr 的代理: ${working.length}`);
  working.slice(0,15).forEach(w=>console.log(`  ${w.proxy} -> ${w.status}`));

  if(working.length===0){console.log('无可用代理，终止');return;}

  // 对每个可用代理做真实 OAuth 验证（最多 15 个），找出能真正发请求的出口
  const cfgMap=loadConfig();const tokens=loadTokens();
  const oauthOk=[];
  for(const w of working.slice(0,15)){
    for(const tok of tokens){
      if(!tok.oauthToken)continue;
      const cfg=cfgMap[tok.id]||cfgMap['main'];
      if(!cfg||!cfg.consumerKey)continue;
      const r=await realOAuthVia(w.proxy,cfg,tok);
      console.log(`\n[代理 ${w.proxy}] token ${tok.id}: status=${r.status} body=${r.body||r.err||''}`);
      if(r.status===200){console.log('  🎉 真实 OAuth 成功！Tumblr 可达且 token 有效');oauthOk.push(w.proxy);break;}
      if(r.status===401){console.log('  ✅ 代理可达 Tumblr（401=鉴权，证明出口有效）');oauthOk.push(w.proxy);break;}
    }
  }
  console.log(`\nOAuth 验证可用代理数: ${oauthOk.length}`);
  // 保存可用代理池（OAuth 验证过的优先，否则用可达的）
  const saveList = oauthOk.length ? oauthOk : working.map(w=>w.proxy);
  if(saveList.length){
    fs.writeFileSync(path.join(WS,'_working_proxies.json'),JSON.stringify(saveList,null,2));
    console.log(`\n已保存 ${saveList.length} 个可用代理到 _working_proxies.json`);
  }
})();
