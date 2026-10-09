const mysql = require('./node_modules/mysql2/promise');
(async()=>{
  const p = mysql.createPool({host:'',port:3307,user:'root',:'''affiliate_system''utf8mb4'});
  try{
    const q=async s=>{const [r]=await p.query(s);return r;};
    // distinct URL hosts among published
    console.log('hosts published:', JSON.stringify(await q("SELECT SUBSTRING_INDEX(SUBSTRING_INDEX(post_url,'/',3),'://',-1) h, COUNT(*) c FROM matrix_posts_published WHERE status='published' GROUP BY h ORDER BY c DESC LIMIT 10")));
    // traffic_ proxy pattern
    console.log('proxy patterns:', JSON.stringify(await q("SELECT proxy_server, COUNT(*) c FROM traffic_ GROUP BY proxy_server")));
    console.log('traffic cookies null:', JSON.stringify(await q("SELECT COUNT(*) c FROM traffic_ WHERE cookies_blob IS NULL")));
    // content_generated fake?
    console.log('matrix_content_generated:', JSON.stringify(await q("SELECT COUNT(*) c FROM matrix_content_generated")));
  }catch(e){console.log('ERR',e.message);} finally{ await p.end(); }
})();
