'use strict';
const http = require('http');
const https = require('https');
const PARENT = { host: '127.0.0.1', port: 10808 };
const TH = 'api.tumblr.com';

function hop1(proxy) {
  return new Promise((resolve) => {
    const parts = proxy.split(':');
    const req = http.request({ host: PARENT.host, port: PARENT.port, method: 'CONNECT', path: parts[0] + ':' + parts[1], timeout: 7000 });
    req.on('connect', (res, socket) => { try { socket.destroy(); } catch (e) {} resolve(res.statusCode); });
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve('H1_TIMEOUT'); });
    req.on('error', (e) => resolve('H1_ERR:' + e.message.slice(0, 30)));
    req.end();
  });
}

function full(proxy) {
  return new Promise((resolve) => {
    const parts = proxy.split(':');
    const req = http.request({ host: PARENT.host, port: PARENT.port, method: 'CONNECT', path: parts[0] + ':' + parts[1], timeout: 7000 });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { try { socket.destroy(); } catch (e) {} resolve({ hop1: res.statusCode }); return; }
      const req2 = http.request({ host: parts[0], port: Number(parts[1]), method: 'CONNECT', path: TH + ':443', timeout: 7000, socket: socket, agent: false });
      req2.on('connect', (res2, socket2) => {
        if (res2.statusCode !== 200) { try { socket2.destroy(); } catch (e) {} resolve({ hop1: 200, hop2: res2.statusCode }); return; }
        const opts = { method: 'GET', path: '/v2/user/info', headers: { Host: TH, 'User-Agent': 'Mozilla/5.0' }, timeout: 9000, socket: socket2, servername: TH };
        const greq = https.request(opts, (gr) => { let d = ''; gr.on('data', (c) => (d += c)); gr.on('end', () => resolve({ hop1: 200, hop2: 200, tumblr: gr.statusCode })); });
        greq.on('timeout', () => { try { greq.destroy(); } catch (e) {} resolve({ hop1: 200, hop2: 200, tumblr: 'TLS_TIMEOUT' }); });
        greq.on('error', (e) => resolve({ hop1: 200, hop2: 200, tumblr: 'TLS_ERR:' + e.message.slice(0, 30) }));
        greq.end();
      });
      req2.on('timeout', () => { try { req2.destroy(); } catch (e) {} resolve({ hop1: 200, hop2: 'H2_TIMEOUT' }); });
      req2.on('error', (e) => resolve({ hop1: 200, hop2: 'H2_ERR:' + e.message.slice(0, 30) }));
      req2.end();
    });
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve({ hop1: 'H1_TIMEOUT' }); });
    req.on('error', (e) => resolve({ hop1: 'H1_ERR:' + e.message.slice(0, 30) }));
    req.end();
  });
}

(async () => {
  const test = ['167.99.124.118:80', '159.65.245.255:80', '45.66.249.187:8080', '162.214.74.29:3128', '52.34.243.150:8080', '8.221.126.184:80', '104.154.186.48:80', '34.43.46.91:80', '172.237.165.228:3128', '13.52.163.143:8082'];
  console.log('=== HOP1 (10808->proxy) ===');
  for (const px of test) console.log('  ' + px + ' => ' + (await hop1(px)));
  console.log('=== full chain -> Tumblr ===');
  for (const px of test) console.log('  ' + px + ' => ' + JSON.stringify(await full(px)));
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
