const mysql = require('./node_modules/mysql2/promise');
(async()=>{
  const p = mysql.createPool({host:'',port:3307,user:'root',:'''affiliate_system''utf8mb4'});
  try{
    const [t]=await p.query('SHOW TABLES');
    console.log('TABLES:', t.map(x=>Object.values(x)[0]).join(', '));
    for(const name of ['matrix_posts_published','traffic_','managed_','matrix_','affiliate_']){
      try{ const [c]=await p.query(`SELECT COUNT(*) c FROM ${name}`); console.log(name, JSON.stringify(c)); }catch(e){ console.log(name,'ERR',e.message); }
    }
    const [fake]=await p.query("SELECT status, COUNT(*) c FROM matrix_posts_published GROUP BY status");
    console.log('post status:', JSON.stringify(fake));
  }catch(e){console.log('ERR',e.message);} finally{ await p.end(); }
})();
