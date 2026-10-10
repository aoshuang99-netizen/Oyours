const mysql = require('./node_modules/mysql2/promise');
(async()=>{
  const p = mysql.createPool({host:'127.0.0.1',port:3307,user:'root',password:'',database:'affiliate_system',charset:'utf8mb4'});
  let total=0, rounds=0;
  try{
    while(true){
      const [u]=await p.query("UPDATE matrix_posts_published SET status='fake_removed', note_count=0, note_history='[]' WHERE status='published' AND post_url NOT LIKE '%/blog/view/%' AND post_url NOT LIKE '%.tumblr.com/post/%' LIMIT 5000");
      total+=u.affectedRows; rounds++;
      if(u.a, u.affectedRows===0) break;
      if(rounds>200) break;
    }
    console.log('total marked', total, 'rounds', rounds);
  }catch(e){ console.log('ERR', e.message); }
  finally{ const [after]=await p.query("SELECT status,COUNT(*) c FROM matrix_posts_published GROUP BY status"); console.log('after',JSON.stringify(after)); await p.end(); }
})();
