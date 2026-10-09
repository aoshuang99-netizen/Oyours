const mysql = require('./node_modules/mysql2/promise');
(async()=>{
  const p = mysql.createPool({host:'',port:3307,user:'root',:'''affiliate_system''utf8mb4'});
  try{
    const [upd] = await p.query("UPDATE matrix_posts_published SET status='fake_removed', note_count=0, note_baseline=0, note_history='[]' WHERE status='published' AND post_url NOT LIKE '%/blog/view/%' AND post_url NOT LIKE '%.tumblr.com/post/%'");
    console.log('marked fake_removed:', upd.affectedRows);
    const [after] = await p.query("SELECT status, COUNT(*) c FROM matrix_posts_published GROUP BY status");
    console.log('after:', JSON.stringify(after));
  }catch(e){ console.log('ERR', e.message); }
  finally{ await p.end(); }
})();
