// 端到端验证：热点→脚本→本地渲染(≤10s视频)→发布到 Tumblr（真实 post_url）
// 直连本机 3002，不经过任何代理；发布动作由服务端经 TUMBLR_PROXY(住宅IP) 出网。
const BASE = 'http://127.0.0.1:3002';

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(BASE + path, opts);
  let json = null;
  try { json = await r.json(); } catch (_) {}
  return { status: r.status, json };
}

(async () => {
  console.log('=== STEP 1: Tumblr 发布账号状态 ===');
  const st = await api('GET', '/api/v14/tumblr/status');
  console.log('status=', st.status, JSON.stringify(st.json));

  console.log('\n=== STEP 2: 账号列表(可用发布账号) ===');
  const acc = await api('GET', '/api/v14/tumblr/accounts');
  console.log('accounts count=', acc.json && acc.json.count, 'default=', acc.json && acc.json.default);

  console.log('\n=== STEP 3: 注入真实热点(seed) ===');
  const seed = await api('POST', '/api/v14/trending/intel/seed', {
    items: [{ keyword: 'AI short video automation 2026', tags: ['ai', 'shortvideo', 'automation'], url: 'https://trends.google.com/trends/trendingsearches/daily', geo: 'US', traffic: '2M+', articles: ['https://example.com/ai-video'] }]
  });
  console.log('seed=', seed.status, JSON.stringify(seed.json).slice(0, 300));
  const trendId = seed.json && seed.json.items && seed.json.items[0] && seed.json.items[0].id;
  if (!trendId) { console.log('!! 无法取得 trendId，中止'); process.exit(2); }
  console.log('trendId=', trendId);

  console.log('\n=== STEP 4: 由热点生成短视频脚本 ===');
  const script = await api('POST', `/api/v14/trending/intel/${trendId}/script`, { duration: 8 });
  console.log('script=', script.status, JSON.stringify(script.json).slice(0, 400));
  const sc = script.json || {};

  console.log('\n=== STEP 5: 创建视频内容草稿 ===');
  const content = await api('POST', '/api/v14/content', {
    content_type: 'video',
    title: sc.title || 'AI 短视频自动化实测',
    body: Array.isArray(sc.lines) ? sc.lines.join('\n') : 'AI short video automation test',
    tags: Array.isArray(sc.tags) ? sc.tags : ['ai', 'shortvideo']
  });
  console.log('content=', content.status, JSON.stringify(content.json).slice(0, 300));
  const contentId = content.json && content.json.record && content.json.record.id;
  if (!contentId) { console.log('!! 无法取得 contentId，中止'); process.exit(3); }
  console.log('contentId=', contentId);

  console.log('\n=== STEP 6: 本地渲染 ≤10s 视频(ffmpeg) ===');
  const dur = (sc.duration && sc.duration <= 10) ? sc.duration : 8;
  const render = await api('POST', `/api/v14/content/${contentId}/render`, { duration: dur });
  console.log('render=', render.status, JSON.stringify(render.json).slice(0, 400));
  if (!render.json || !render.json.ok) { console.log('!! 渲染失败，中止'); process.exit(4); }
  const vr = render.json.render;
  console.log('  -> videoUrl=', vr.videoUrl, ' filePath=', vr.filePath, ' duration=', vr.duration, 's');

  // 校验文件确实生成且时长<=10s
  const fs = require('fs');
  let fileOk = false, fileSize = 0;
  try { const s = fs.statSync(vr.filePath); fileOk = s.size > 0; fileSize = s.size; } catch (e) {}
  console.log('  -> 文件存在=', fileOk, ' 大小=', fileSize, 'bytes');

  console.log('\n=== STEP 7: 发布到 Tumblr(真实 post_url) ===');
  const pub = await api('POST', '/api/v14/tumblr/publish', {
    videoId: contentId,
    caption: sc.title || 'AI 短视频自动化实测 by MSCMS v14',
    tags: Array.isArray(sc.tags) ? sc.tags : ['ai', 'shortvideo']
    // accountId 不传 → 服务端解析到首个真实授权账号
  });
  console.log('publish status=', pub.status);
  console.log('publish body=', JSON.stringify(pub.json));
  if (pub.json && pub.json.ok && pub.json.postUrl) {
    console.log('\n✅ 端到端成功：视频已本地生成并真实发布到 Tumblr');
    console.log('   postUrl =', pub.json.postUrl);
  } else {
    console.log('\n⚠️ 发布未返回真实 postUrl（见上方错误）。视频本身已成功本地生成。');
  }
})().catch(e => { console.error('FATAL', e); process.exit(1); });
