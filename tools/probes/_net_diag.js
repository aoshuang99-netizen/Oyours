'use strict';
// 网络出网能力诊断（带全局硬截止，绝不挂死）
const fs = require('fs');
const path = require('path');
const { ProxyAgent, fetch: ufetch } = require('undici');

const WS = 'C:/Users/AS/WorkBuddy/2026-06-13-19-42-19';
const TUMBLR = 'https://api.tumblr.com/v2/user/info';
const GH = 'https://raw.githubusercontent.com/TheSpeedX/proxy-scraper-list/master/http.txt';

 withTimeout(p, ms, tag) {
  return Promise.race([
    p,
    new Promise((res) => setTimeout(() => res({ _timeout: true, tag }), ms)),
  ]);
}

async  fetchVia(, url, ms) {
  const agent = new ProxyAgent();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    const r = await ufetch(url, {
      method: 'GET',
      agent,
      signal: ctrl.signal,
      headers: { '': 'Mozilla/5.0' },
    });
    clearTimeout(t);
    return { status: r.status };
  } catch (e) {
    return { status: 'ERR', msg: String(e.message || e).slice(0, 50) };
  }
}

const GLOBAL_DEADLINE = Date.now() + 150000; // 2.5 分钟硬截止

(async () => {
  console.log('=== [1] 10808 出网测试 (GitHub) ===');
  const r1 = await withTimeout(fetchVia('http://:10808', GH, 15000), 16000, '10808');
  console.log('10808 -> GitHub:', JSON.stringify(r1));

  console.log('\n=== [2] 直连外部代理 IP 测试 ===');
  // 之前返回过 500 的两个（证明沙箱能直连外部 IP）
  for (const ip of ['45.56.73.134:8080', '8.210.17.35:31281']) {
    const r = await withTimeout(fetchVia('http://' + ip, TUMBLR, 8000), 9000, ip);
    console.log(`直连 ${ip} -> Tumblr:`, JSON.stringify(r));
  }

  if (r1.status === 200) {
    console.log('\n=== [3] 拉取 GitHub 代理列表 ===');
    let list = '';
    try {
      const agent = new ProxyAgent('http://:10808');
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const resp = await ufetch(GH, { agent, signal: ctrl.signal });
      clearTimeout(t);
      list = await resp.text();
    } catch (e) {
      console.log('列表拉取失败:', e.message);
    }
    const lines = list.split('\n').map((s) => s.trim()).filter(Boolean);
    console.log('代理总数:', lines.length);

    console.log('\n=== [4] 批量探测可达 Tumblr 的代理（并发20，收集前12，硬截止保护）===');
    const working = [];
    const batch = 20;
    outer: for (let i = 0; i < lines.length; i += batch) {
      if (Date.now() > GLOBAL_DEADLINE) { console.log('触达全局截止，停止'); break; }
      const slice = lines.slice(i, i + batch);
      const tasks = slice.map((px) =>
        withTimeout(fetchVia('http://' + px, TUMBLR, 7000), 8000, px).then((r) => ({ px, r }))
      );
      const results = await Promise.all(tasks);
      for (const { px, r } of results) {
        // 任何 HTTP 状态（含 401/403/500）都表示代理把请求送达了 Tumblr = 可达
        if (r.status && r.status !== 'ERR' && !r._timeout) {
          working.push({ px, status: r.status });
          console.log(`  ✅ ${px} -> ${r.status}`);
          if (working.length >= 12) break outer;
        }
      }
      console.log(`  扫描至 ${Math.min(i + batch, lines.length)}/${lines.length}, 已找到 ${working.length}`);
    }
    console.log(`\n可达 Tumblr 的代理数: ${working.length}`);
    if (working.length) {
      fs.writeFileSync(path.join(WS, '_working_proxies.json'), JSON.stringify(working, null, 2));
      console.log('已保存 _working_proxies.json');
    }
  }
  console.log('\n=== 诊断完成 ===');
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
