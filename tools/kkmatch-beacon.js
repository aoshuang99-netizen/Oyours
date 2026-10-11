#!/usr/bin/env node
/**
 * kkmatch-beacon.js — kkmatch.com 真实访客计量埋点（B 步骤交付物）
 * ============================================================================
 *
 * 背景（为什么需要它）：
 *   MSCMS v14 的「真实 DAU 北极星」由 server.js 的 /api/v14/analytics/track +
 *   website-analytics.js + dau_log.json 构成。该端点会从 Cloudflare Tunnel 注入的
 *   `cf-connecting-ip` 解析真实访客公网 IP，并据 data-provenance.js 判定为 'user'
 *   （真实访客口径）；本机驱动流量（self_direct / TEST-NET）一律判为 'system'，
 *   绝不污染真实 DAU（零伪造原则）。
 *
 *   但此前 kkmatch.com（独立部署在腾讯云 129.211.8.167）的访客从未上报过任何事件，
 *   导致真实 DAU 结构性恒为 0。本埋点把 kkmatch.com 的真实访客引流进 3002 计量。
 *
 * 部署（唯一需用户执行的动作）：
 *   把下方 SNIPPET 内联进 kkmatch.com 前端 <head>（或任何全站模板）。
 *   端点默认 v14.cc.cd（已在 cloudflared 映射 127.0.0.1:3002，全局 CORS=*）—— 需先补一条
 *   DNS CNAME（v14.cc.cd → <tunnelId>.cfargotunnel.com）使其公开可达。Cloudflare 会在请求上
 *   写入真实访客 cf-connecting-ip，服务端据此判定 provenance='user'（真实 DAU）。
 *   若希望 kkmatch 自记账（不依赖 3002 隧道），可 KKMATCH_TRACK_ENDPOINT 指向 kkmatch 自身
 *   后端的分析端点（需另接 event_receiver 类接收器，当前未部署）。
 *
 * 计量口径：
 *   - source: 'kkmatch'        —— 标识流量来自 kkmatch.com
 *   - url: location.href       —— 落地页（含 kkmatch.com，可溯源）
 *   - visitorId/sessionId      —— localStorage/sessionStorage 稳定去重熵
 *   - 真实 IP 由服务端从 cf-connecting-ip 解析，前端不上报 IP（浏览器也不知道）
 *
 * 运行：
 *   node tools/kkmatch-beacon.js           # 打印可直接粘贴的 <script> 片段
 *   node tools/kkmatch-beacon.js --check   # 自检公网端点可达 + 分类逻辑
 */

'use strict';

// ⚠️ 公网隧道端点：必须绝对地址（不能用相对路径，否则会解析到 kkmatch.com 自身源）
// 2026-10-09 修正：原默认 mscms.lokfeel.com 实测不可达（隧道/DNS 缺失，curl 探测 HTTP 000）。
// 改为 v14.cc.cd —— 已在 cloudflared config.yml 映射 127.0.0.1:3002，仅需补一条 DNS CNAME
// （v14.cc.cd → <tunnelId>.cfargotunnel.com）即可公开可达。mscms.cc.cd 同映射，可作备选。
// 仍可用环境变量 KKMATCH_TRACK_ENDPOINT 覆盖（例如改回 mscms.lokfeel.com 或指向 kkmatch 自身后端）。
const ENDPOINT = process.env.KKMATCH_TRACK_ENDPOINT
  || 'https://v14.cc.cd/api/v14/analytics/track';

const SNIPPET = `<!-- MSCMS v14 Analytics Beacon · kkmatch.com (B-step) -->
<script>
(function(){
  var ENDPOINT = ${JSON.stringify(ENDPOINT)};
  try {
    var vid = localStorage.getItem('kk_vid') || (function(){
      var id='kk_'+Date.now()+'_'+Math.random().toString(36).slice(2);
      localStorage.setItem('kk_vid', id); return id;
    })();
    var sid = sessionStorage.getItem('kk_sid') || (function(){
      var id='ks_'+Date.now()+'_'+Math.random().toString(36).slice(2);
      sessionStorage.setItem('kk_sid', id); return id;
    })();
    function send(type, extra){
      var payload = Object.assign({
        url: location.href,
        referrer: document.referrer || '',
        userAgent: navigator.userAgent,
        visitorId: vid,
        sessionId: sid,
        source: 'kkmatch',
        type: type || 'page_view'
      }, extra || {});
      try {
        if (navigator.sendBeacon) {
          navigator.sendBeacon(ENDPOINT, new Blob([JSON.stringify(payload)], {type:'application/json'}));
        } else {
          var x = new XMLHttpRequest();
          x.open('POST', ENDPOINT, true);
          x.setRequestHeader('Content-Type', 'application/json');
          x.send(JSON.stringify(payload));
        }
      } catch(e){}
    }
    send('page_view');
    document.addEventListener('click', function(e){
      var t = e.target && e.target.closest ? e.target.closest('a,button') : null;
      if (t) send('click', { target: (t.getAttribute('href') || t.textContent || '').slice(0,120) });
    });
    window.addEventListener('beforeunload', function(){ send('session_end'); });
    window.__kkTrack = send;
  } catch(e){}
})();
</script>`;

function printSnippet() {
  console.log(SNIPPET);
}

async function selfCheck() {
  const { classifyTraffic } = require('../data-provenance.js');
  console.log('[check] ENDPOINT =', ENDPOINT);
  // 1) 分类逻辑自检（不触碰线上，纯函数）
  const cases = [
    ['8.8.8.8 (真实公网)', classifyTraffic({ ip: '8.8.8.8' })],
    ['198.51.100.50 (TEST-NET)', classifyTraffic({ ip: '198.51.100.50' })],
    ['self_direct (自驱)', classifyTraffic({ ip: 'self_direct' })],
    ['127.0.0.1 (回环)', classifyTraffic({ ip: '127.0.0.1' })],
  ];
  for (const [label, r] of cases) console.log(`  classifyTraffic(${label}) => ${r}`);

  // 2) 端点可达性（公网，走 --noproxy 避免本机坏代理；超时即不可达）
  try {
    const https = require('https');
    const http = require('http');
    const lib = ENDPOINT.startsWith('https') ? https : http;
    const req = lib.request(ENDPOINT.replace(/^https?:\/\//, ''), { method: 'OPTIONS' }, (res) => {
      console.log(`[check] OPTIONS ${ENDPOINT} => HTTP ${res.statusCode}, ACAO=${res.headers['access-control-allow-origin'] || '(none)'}`);
      res.resume();
    });
    req.setTimeout(8000, () => { req.destroy(); console.log('[check] 端点超时（需确认隧道/域名可达）'); });
    req.on('error', (e) => console.log('[check] 端点错误:', e.message));
    req.end();
  } catch (e) {
    console.log('[check] 端点探测异常:', e.message);
  }
}

if (require.main === module) {
  const arg = process.argv[2];
  if (arg === '--check') selfCheck();
  else printSnippet();
}

module.exports = { SNIPPET, ENDPOINT, selfCheck };
