const mysql = require('./node_modules/mysql2/promise');
(async()=>{
  const p = mysql.createPool({host:'127.0.0.1',port:3307,  user:'root',password:'',database:'affiliate_system',charset:'utf8mb4'});
  try{
    const q=async s=>{const [r]=await p.query(s);return r;};
    console.log('blog/view real:', JSON.stringify(await q("SELECT COUNT(*) c FROM matrix_posts_published WHERE status='published' AND post_url LIKE '%/blog/view/%'")));
    console.log('tumblr.com/post/ fake:', JSON.stringify(await q("SELECT COUNT(*) c FROM matrix_posts_published WHERE status='published' AND post_url LIKE '%tumblr.com/post/%'")));
    console.log('.tumblr.com/post:', JSON.stringify(await q("SELECT COUNT(*) c FROM matrix_posts_published WHERE status='published' AND post_url LIKE '%.tumblr.com/post/%'")));
    console.log('other/odd:', JSON.stringify(await q("SELECT COUNT(*) c FROM matrix_posts_published WHERE status='published' AND post_url NOT LIKE '%/blog/view/%' AND post_url NOT LIKE '%.tumblr.com/post/%' AND post_url NOT LIKE '%tumblr.com/post/%'")));
    console.log('sample published odd urls:', JSON.stringify(await q("SELECT id,post_url FROM matrix_posts_published WHERE status='published' AND post_url NOT LIKE '%/blog/view/%' AND post_url NOT LIKE '%.tumblr.com/post/%' LIMIT 3")));
    console.log('--- traffic_accounts sample ---');
    console.log(JSON.stringify(await q("SELECT * FROM traffic_accounts LIMIT 2"),null,1));
    console.log('traffic_accounts valid/invalid:', JSON.stringify(await q("SELECT status,COUNT(*) c FROM traffic_accounts GROUP BY status")));
  }catch(e){console.log('ERR',e.message);} finally{ await p.end(); }
})();
