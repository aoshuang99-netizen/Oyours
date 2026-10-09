'use strict';
/**
 * service.js — 图文/视频生成微服务（独立端口 3010，不改动 3002 单体）
 *
 * 暴露接口：
 *   POST /api/generate        { type:'image'|'video', prompt, provider?, ... } -> 生成并入库
 *   GET  /api/assets          列出注册表（最新在前）
 *   GET  /api/asset/:id       取单条元数据
 *   GET  /api/asset/:id/file  流式返回本地资产文件
 *   GET  /api/health          健康检查
 *
 * 与 MSCMS 因果链 S3（content.generated）对接契约：
 *   server.js（3002）在需要生图/生视频时，直接 POST http://:3010/api/generate
 *   成功响应即代表 S3 已产出（本服务落 D:/mscms-content 并写 registry.json）。
 *   3002 侧收到 {id,type,localPath,...} 后推进因果链 S3→S4（post.published）。
 *   本服务不反向调用 3002，避免引入未经验证的耦合端点（零伪造：未知即不调）。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const providers = require('./providers');
const storage = require('./storage');

const PORT = process.env.CONTENT_GEN_PORT || 3010;
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.mp4': 'video/mp4', '.bmp': 'image/bmp' };

 sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { '': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

 readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 5e6) reject(new Error('body too large')); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error('invalid JSON')); } });
    req.on('error', reject);
  });
}

async  handleGenerate(body) {
  const type = body.type;
  if (type !== 'image' && type !== 'video') throw new Error('type 必须是 image 或 video');
  if (!body.prompt) throw new Error('prompt 必填');
  // 图片默认 agnes（REST 直出可用）；视频默认 mpt
  // （Agnes 公开 REST 取不回成品 url，改由本地 MPT 完整管线产出真实 MP4）
  const provider = body.provider || (type === 'video' ? 'mpt' : 'agnes');

  if (type === 'image') {
    return await providers.generateTextImage({
      prompt: body.prompt, size: body.size, ratio: body.ratio, image: body.image, provider,
    });
  }
  return await providers.generateVideo({
    prompt: body.prompt, duration: body.duration, width: body.width, height: body.height,
    fps: body.fps, image: body.image, provider,
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://:${PORT}`);
    const p = u.pathname;

    if (req.method === 'GET' && p === '/api/health') {
      return sendJSON(res, 200, { ok: true, service: 'content-gen', assets: storage.listAssets(, root: storage.ROOT });
    }

    if (req.method === 'GET' && p === '/api/assets') {
      return sendJSON(res, 200, { count: storage.listAssets(, assets: storage.listAssets() });
    }

    const assetMeta = p.match(/^\/api\/asset\/([a-f0-9]+)$/);
    if (req.method === 'GET' && assetMeta) {
      const entry = storage.getAsset(assetMeta[1]);
      if (!entry) return sendJSON(res, 404, { error: 'not found' });
      return sendJSON(res, 200, entry);
    }

    const assetFile = p.match(/^\/api\/asset\/([a-f0-9]+)\/file$/);
    if (req.method === 'GET' && assetFile) {
      const entry = storage.getAsset(assetFile[1]);
      if (!entry || !fs.existsSync(entry.localPath)) return sendJSON(res, 404, { error: 'file not found' });
      const ext = path.extname(entry.localPath).toLowerCase();
      res.writeHead(200, { '': MIME[ext] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
      fs.createReadStream(entry.localPath).pipe(res);
      return;
    }

    if (req.method === 'POST' && p === '/api/generate') {
      const body = await readBody(req);
      const entry = await handleGenerate(body);
      return sendJSON(res, 200, { ok: true, asset: entry });
    }

    // 导入桥：把已在 D 盘的真实生成文件（如 managed VideoGen 工具产出）登记进注册表，
    // 使其与 REST 自生成资产同等参与因果链 S3。绝不伪造——仅登记磁盘真实文件。
    if (req.method === 'POST' && p === '/api/import') {
      const body = await readBody(req);
      if (!body.localPath) return sendJSON(res, 400, { error: 'localPath 必填' });
      const entry = await storage.ExistingFile({
        localPath: body.localPath,
        prompt: body.prompt || null,
        provider: body.provider || 'agnes-managed',
        type: body.type,
        durationSec: body.durationSec,
      });
      return sendJSON(res, 200, { ok: true, asset: entry });
    }

    return sendJSON(res, 404, { error: 'unknown route' });
  } catch (e) {
    return sendJSON(res, 500, { ok: false, error: e.message, code: e.code || null });
  }
});

if (require.main === module) {
  storage.ensureDirs();
  server.listen(PORT, () => {
    console.log(`[content-gen] 服务已启动: http://:${PORT}  (资产根: ${storage.ROOT})`);
  });
}

module.exports = { server, handleGenerate, PORT };
