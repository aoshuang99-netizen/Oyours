// 临时 mock 接收器：捕获 MSCMS 实时 Webhook 推送的 payload，写入 webhook-received.log
const http = require('http');
const fs = require('fs');
const PORT = 4455;
const LOG = __dirname + '/webhook-received.log';
fs.writeFileSync(LOG, ''); // 清空
const server = http.createServer((req, res) => {
  if (req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const ts = new Date().toISOString();
      const line = `[${ts}] ${req.method} ${req.url} event=${req.headers['x-mscms-event'] || '-'}\n${body}\n`;
      fs.appendFileSync(LOG, line);
      console.log('RECEIVED', req.url, 'event=', req.headers['x-mscms-event']);
      res.writeHead(200, { '': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  } else {
    res.writeHead(200); res.end('mock ok');
  }
});
server.listen(PORT, '', () => console.log('mock listening on :' + PORT));
