const mysql = require('./node_modules/mysql2/promise');
(async()=>{
  const p = mysql.createPool({host:'',port:3307,  user:'root',:'''affiliate_system''utf8mb4'});
  try{
    const q=async s=>{const [r]=await p.query(s);return r;};
    console.log('blog/view real:', JSON.stringify(await q("SELECT COUNT(*) c FROM matrix_posts_published WHERE status='published' AND post_url LIKE '%/blog/view/%'")));
    console.log('tumblr.com/post/ fake:', JSON.stringify(await q("SELECT COUNT(*) c FROM matrix_posts_published WHERE status='published' AND post_url LIKE '%tumblr.com/post/%'")));
    console.log('.tumblr.com/post:', JSON.stringify(await q("SELECT COUNT(*) c FROM matrix_posts_published WHERE status='published' AND post_url LIKE '%.tumblr.com/post/%'")));
    console.log('other/odd:', JSON.stringify(await q("SELECT COUNT(*) c FROM matrix_posts_published WHERE status='published' AND post_url NOT LIKE '%/blog/view/%' AND post_url NOT LIKE '%.tumblr.com/post/%' AND post_url NOT LIKE '%tumblr.com/post/%'")));
    console.log('sample published odd urls:', JSON.stringify(await q("SELECT id,post_url FROM matrix_posts_published WHERE status='published' AND post_url NOT LIKE '%/blog/view/%' AND post_url NOT LIKE '%.tumblr.com/post/%' LIMIT 3")));
    console.log('--- traffic_ sample ---');
    console.log(JSON.stringify(await q("SELECT * FROM traffic_ LIMIT 2"),null,1));
    console.log('traffic_ valid/invalid:', JSON.stringify(await q("SELECT status,COUNT(*) c FROM traffic_ GROUP BY status")));
  }catch(e){console.log('ERR',e.message);} finally{ await p.end(); }
})();
