#!/usr/bin/env node
// Minimal SOCKS5 client + nested CONNECT test through the VPS SOCKS5 proxy.
// Verifies: local -> SOCKS5(10950) -> VPS egress -> BD superproxy -> target  works
// (byte-transparent SOCKS5 should avoid the xray HTTP-CONNECT nesting hang).
const net = require('net');
const SOCKS_HOST = process.env.SOCKS_HOST || '127.0.0.1';
const SOCKS_PORT = parseInt(process.env.SOCKS_PORT || '10950', 10);
const BD_HOST = 'brd.superproxy.io';
const BD_PORT = parseInt(process.env.BD_PORT || '44445', 10); // ISP
const BD_USER = 'brd-customer-hl_ac0f9818-zone-isp_proxy1';
const BD_PASS = 'd2ream9zn4am';
const BD_AUTH = 'Basic ' + Buffer.from(`${BD_USER}:${BD_PASS}`).toString('base64');
const TARGET_HOST = process.env.TARGET_HOST || 'httpbin.org';
const TARGET_PORT = parseInt(process.env.TARGET_PORT || '443', 10);

function socksConnect(host, port) {
  return new Promise((resolve, reject) => {
    const s = net.connect(SOCKS_PORT, SOCKS_HOST, () => {
      // greeting: SOCKS5, 1 method, no auth
      s.write(Buffer.from([0x05, 0x01, 0x00]));
    });
    let phase = 0, buf = Buffer.alloc(0);
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (phase === 0) {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05 || buf[1] !== 0x00) return reject(new Error('SOCKS greeting rejected: ' + buf.toString('hex')));
        // CONNECT: ver, cmd=1, rsv, atyp=3(domain)
        const h = Buffer.from(host, 'utf8');
        const req = Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, h.length]), h, Buffer.from([(port >> 8) & 0xff, port & 0xff])]);
        buf = Buffer.alloc(0); phase = 1; s.write(req);
      } else if (phase === 1) {
        if (buf.length < 10) return;
        if (buf[1] !== 0x00) return reject(new Error('SOCKS CONNECT failed rep=' + buf[1]));
        phase = 2; resolve(s);
      }
    });
    s.on('error', reject);
    setTimeout(() => reject(new Error('SOCKS timeout')), 20000);
  });
}

(async () => {
  const t0 = Date.now();
  console.log(`[test] SOCKS5 ${SOCKS_HOST}:${SOCKS_PORT} -> BD ${BD_HOST}:${BD_PORT}`);
  const sock = await socksConnect(BD_HOST, BD_PORT);
  console.log(`[test] SOCKS tunnel to BD established in ${Date.now() - t0}ms`);
  // inner CONNECT to target through BD
  sock.write(`CONNECT ${TARGET_HOST}:${TARGET_PORT} HTTP/1.1\r\nHost: ${TARGET_HOST}\r\nProxy-Authorization: ${BD_AUTH}\r\n\r\n`);
  let buf = '';
  const onData = (d) => {
    buf += d.toString();
    const i = buf.indexOf('\r\n\r\n');
    if (i >= 0) {
      const first = buf.slice(0, i).split('\r\n')[0];
      console.log(`[test] inner CONNECT reply: ${first}  (total ${Date.now() - t0}ms)`);
      if (/ 200 /.test(first)) {
        console.log('[test] SUCCESS: nested CONNECT via SOCKS5 -> BD -> target works!');
        // try a TLS-ish GET to confirm byte pipe
        sock.write(`GET /ip HTTP/1.1\r\nHost: ${TARGET_HOST}\r\nConnection: close\r\n\r\n`);
      } else {
        console.log('[test] FAILED inner CONNECT');
        process.exit(1);
      }
      sock.removeListener('data', onData);
    }
  };
  sock.on('data', onData);
  sock.on('error', (e) => { console.log('[test] sock error', e.message); process.exit(1); });
  setTimeout(() => { console.log('[test] done window'); process.exit(0); }, 15000);
})().catch((e) => { console.log('[test] ERROR', e.message); process.exit(1); });
