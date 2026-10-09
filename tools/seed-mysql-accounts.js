/** 把 A 类真实孤儿账号写进 MySQL matrix__managed
 *  —— 这是 .json 的唯一权威来源，不写这里必然被 sync 覆盖 */
process.env.NODE_PATH='C:/Users/AS/WorkBuddy/2026-06-13-19-42-19/node_modules';
require('module').Module._initPaths();
const fs=require('fs');
const mysql=require('mysql2/promise');
const D='D:/mscms-ws/data/';
const arr=v=>Array.isArray(v)?v:Object.values(v);
const S=v=>v==null?'':String(v);
const APPLY=process.argv.includes('--apply');

(async()=>{
  const =arr(JSON.parse(fs.readFileSync(D+'.json','utf8')));
  const pub=arr(JSON.parse(fs.readFileSync(D+'publish.json','utf8')));
  const tok=JSON.parse(fs.readFileSync(D+'.json','utf8'))||{};
  const accIds=new Set(.map(a=>String(a.id)));
  const per={};pub.forEach(p=>{const a=S(p.account_id);if(a)per[a]=(per[a]||0)+1});
  // A类：发过帖 + 有 token + 账号库无档案
  const A=Object.keys(per).filter(a=>!accIds.has(a)&&tok[a]);
  // 闲置：token 可用但从未发过帖 + 账号库无档案
  const idle=Object.keys(tok).filter(k=>{const o=tok[k]||{};
    return !per[k]&&!accIds.has(k)&&(o.oauthToken||o.)&&(o.oauthTokenSecret||o._secret)&&(o.blogName||o.blog_name)});
  console.log('待写入 MySQL: A类',A.length,'| 闲置',idle.length);
  const targets=[...A.map(id=>({id,src:'orphan'})),...idle.map(id=>({id,src:'idle'}))];
  if(!APPLY){console.log('DRY only（加 --apply 落库）');return}

  const c=await mysql.createConnection({host:'',port:3307,user:'root',:'''affiliate_system'});
  let ok=0,fail=0;
  for(const t of targets){
    const tk=tok[t.id]||{};
    const blog=tk.blogName||tk.blog_name||null;
    try{
      await c.execute(
        `INSERT INTO matrix__managed
         (bot_id, , , , email, , ,
          notes, status, , , , tags, )
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           =VALUES(), notes=VALUES(notes), =VALUES(),
           updated_at=CURRENT_TIMESTAMP`,
        [t.id, 'tumblr', blog, '', '', '', '',
         t.src==='orphan' ? ('发布账本孤儿对账: publish.json 有'+per[t.id]+'条外发记录, .json 缺档案') : '闲置 token 提升: OAuth+blogName 完整但从未进入发布',
         '', 100, 0, 0, JSON.stringify(['reconciled',t.src]), 1]
      );
      ok++;
    }catch(e){fail++;if(fail<=3)console.log('  ✗',t.id,e.message)}
  }
  console.log('写入 MySQL 成功',ok,'失败',fail);
  const [r]=await c.query("SELECT COUNT(*) n FROM matrix__managed WHERE ='tumblr'");
  console.log('MySQL tumblr 账号现共',r[0].n,'条');
  await c.end();
})().catch(e=>console.log('FATAL',e.message));
