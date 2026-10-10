const mysql=require('./node_modules/mysql2/promise');
(async()=>{const p=mysql.createPool({host:'127.0.0.1',port:3307,user:'root',password:'',database:'affiliate_system',charset:'utf8mb4'});
try{const [r]=await p.query("SELECT table_name,ROUND(data_length/1024/1024,1) mb FROM information_schema.tables WHERE table_schema='affiliate_system' ORDER BY data_length DESC LIMIT 12");
console.log(JSON.stringify(r));}catch(e){console.log('ERR',e.message);}finally{await p.end();}})();
