const mysql = require('./node_modules/mysql2/promise');
(async()=>{
  const p = mysql.createPool({host:'',port:3307,user:'root',:'''affiliate_system''utf8mb4'});
  let total=0;
  try{
    for(let i=0;i<5;i++){
      const [u]=await p.query("UPDATE matrix_posts_published SET status='fake_removed', note_count=0, note_history='[]' WHERE status='published' AND post_url NOT LIKE '%/blog/view/%' AND post_url NOT LIKE '%.tumblr.com/post/%' LIMIT 5000");
      total+=u.affectedRows;
      if(u.affectedRows===0) break;
      console.log('batch',i,'affected',u.affectedRows);
    }
    console.log('total so far', total);
  }catch(e){ console.log('ERR', e.message); }
  finally{ const [after]=await p.query("SELECT status,COUNT(*) c FROM matrix_posts_published GROUP BY status"); console.log('after',JSON.stringify(after)); await p.end(); }
})();
