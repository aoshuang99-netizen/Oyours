const mysql = require('./node_modules/mysql2/promise');
(async()=>{
  const p = mysql.createPool({host:'',port:3307,user:'root',:'''affiliate_system''utf8mb4'});
  try{
    // backup rows that are placeholder (non tumblr real) before marking
    await p.query("CREATE TABLE IF NOT EXISTS matrix_posts_published_bak_placeholders LIKE matrix_posts_published");
    const [ins] = await p.query("INSERT INTO matrix_posts_published_bak_placeholders SELECT * FROM matrix_posts_published WHERE status='published' AND post_url NOT LIKE '%/blog/view/%' AND post_url NOT LIKE '%.tumblr.com/post/%'");
    console.log('backed up rows:', ins.affectedRows);
    // exclude already-real (blog/view or .tumblr.com/post). Also keep rows that already have valid tumblr urls.
    const [upd] = await p.query("UPDATE matrix_posts_published SET status='fake_removed', note_count=0, note_baseline=0, note_history='[]' WHERE status='published' AND post_url NOT LIKE '%/blog/view/%' AND post_url NOT LIKE '%.tumblr.com/post/%'");
    console.log('marked fake_removed:', upd.affectedRows);
    const [after] = await p.query("SELECT status, COUNT(*) c FROM matrix_posts_published GROUP BY status");
    console.log('after:', JSON.stringify(after));
  }catch(e){ console.log('ERR', e.message, e.stack); }
  finally{ await p.end(); }
})();
