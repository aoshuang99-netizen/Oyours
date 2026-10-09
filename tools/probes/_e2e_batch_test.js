'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { ProxyAgent, fetch: ufetch } = require('undici');
const BASE = 'http://:3002';

(async () => {
  // 1) pick a rendered video
  const vidR = await fetch(BASE + '/api/v14/video-render/list?limit=10');
  const vidD = await vidR.json();
  const vids = (vidD.items || []).filter(v => v && v.filePath);
  if (!vids.length) { console.log('NO_VIDEO'); process.exit(1); }
  const videoId = vids[0].id;
  console.log('VIDEO:', videoId, vids[0].filePath, 'exists=', fs.existsSync(vids[0].filePath));

  // 2) pick a few 
  const accR = await fetch(BASE + '/api/v14/tumblr/');
  const accD = await accR.json();
  const accs = (accD. || []).slice(0, 4);
  console.log('ACCOUNTS:', accs.map(a => a.id).join(', '));

  // 3) start batch (concurrency=2, batchSize=2, delay=1000)
  const startR = await fetch(BASE + '/api/v14/tumblr/batch-publish', {
    method: 'POST', headers: { '': 'application/json' },
    body: JSON.stringify({ videoId, accountIds: accs.map(a => a.id), concurrency: 2, batchSize: 2, batchDelayMs: 1000, caption: 'MSCMS 批量发布测试' })
  });
  const startD = await startR.json();
  console.log('START:', JSON.stringify(startD));
  const taskId = startD.taskId;

  // 4) poll
  let task;
  for (let i = 0; i < 40; i++) {
    const tr = await fetch(BASE + '/api/v14/tumblr/batch-publish/' + taskId);
    task = await tr.json();
    console.log(`[poll ${i}] status=${task.status} done=${task.done}/${task.total} ok=${task.success} fail=${task.fail}`);
    if (task.status === 'done' || task.status === 'failed') break;
    await new Promise(r => setTimeout(r, 2000));
  }

  // 5) verify folder + excel + zip
  console.log('\n=== TASK RESULT ===');
  console.log('folder:', task.folder, 'exists=', task.folder && fs.existsSync(task.folder));
  console.log('excel:', task.excel, 'exists=', task.excel && fs.existsSync(task.excel));
  console.log('zip:', task.zip, 'exists=', task.zip && fs.existsSync(task.zip));
  if (task.folder && fs.existsSync(task.folder)) {
    console.log('folder files:', fs.readdirSync(task.folder));
  }
  if (task.excel && fs.existsSync(task.excel)) {
    const buf = fs.readFileSync(task.excel);
    // verify zip valid
    const eocd = buf.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06]));
    console.log('excel zip valid=', eocd > 0, 'bytes=', buf.length);
    // extract sheet1 to confirm real postUrls present
    const cdOff = buf.readUInt32LE(eocd + 16);
    let p = cdOff; const n = buf.readUInt16LE(eocd + 10);
    for (let i = 0; i < n; i++) {
      const nameLen = buf.readUInt16LE(p + 28);
      const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
      if (name === 'xl/worksheets/sheet1.xml') {
        const comp = buf.readUInt32LE(p + 20);
        const lo = buf.readUInt32LE(p + 42);
        const lName = buf.readUInt16LE(lo + 26);
        const lExtra = buf.readUInt16LE(lo + 28);
        const raw = buf.slice(lo + 30 + lName + lExtra, lo + 30 + lName + lExtra + comp);
        const xml = zlib.inflateRawSync(raw'utf8');
        const urls = (xml.match(/tumblr\.com\/blog\/view\/[^\s<]+/g) || []);
        console.log('excel sheet postUrls found:', urls.length);
        urls.slice(0, 3).forEach(u => console.log('   ', u));
      }
      p += 46 + buf.readUInt16LE(p + 28) + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    }
  }

  // 6) spot-check one real postUrl via residential proxy
  const okRes = (task.results || []).find(r => r.status === 'success');
  if (okRes && okRes.postUrl) {
    try {
      const agent = new ProxyAgent('http://:10809');
      const pr = await ufetch(okRes.postUrl, { dispatcher: agent, redirect: 'follow' });
      const txt = await pr.text();
      console.log('\nSPOT-CHECK', okRes.postUrl, '=> HTTP', pr.status, 'live=', txt.includes('tumblr') || txt.includes('Tumblr'));
    } catch (e) { console.log('SPOT-CHECK ERR', e.message); }
  }

  console.log('\nSUMMARY ok=' + task.success + ' fail=' + task.fail + ' total=' + task.total);
})().catch(e => { console.log('TEST ERROR', e.message); process.exit(1); });
