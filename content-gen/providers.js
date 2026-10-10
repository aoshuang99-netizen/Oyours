'use strict';
/**
 * providers.js — 生成提供者统一适配层
 *
 * 两种来源：
 *  1) cloud   → Agnes AI（agnes-image-2.1-flash / agnes-video-v2.0），真实出图/出视频。
 *  2) local   → 本地开源模型（ComfyUI / diffusers HTTP 服务）。即插即用适配器：
 *               换一台 ≥8GB VRAM 的机器、部署好权重后，把 LOCAL_INFERENCE_URL 指向它即可启用。
 *
 * 本机硬件约束：NVIDIA GeForce GT 1030 仅 4GB VRAM，开源视频扩散模型（Wan2.1 /
 * HunyuanVideo / CogVideoX / LTX-Video 等普遍需 8–24GB）在本机【不可推理】。
 * 因此 local 路径在本机会快速失败并给出诚实提示 + 启用步骤，绝不伪造输出（零伪造铁律）。
 *
 * 对外暴露：generateTextImage() / generateVideo()，统一返回 storage 资产条目。
 */

const agnes = require('./agnes-client');
const storage = require('./storage');

const LOCAL_BASE = process.env.LOCAL_INFERENCE_URL || 'http://127.0.0.1:7860';
const PROXY = process.env.AGNES_PROXY || 'http://127.0.0.1:10808';

/**
 * 本地推理适配器（骨架）。
 * 约定两种后端：
 *   A) ComfyUI 风格：POST {base}/prompt 提交工作流，轮询 {base}/history/{prompt_id}。
 *   B) OpenAI 兼容 /generate 风格：POST {base}/v1/generate {type,prompt,...} → {url}
 * 这里以「通用 /v1/generate」为主契约，失败时明确提示。
 */
async function localGenerate({ type, prompt, image, width, height, durationSec }) {
  const url = `${LOCAL_BASE}/v1/generate`;
  let resp;
  try {
    resp = await require('../http-client').fetchExt(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, prompt, image, width, height, duration_sec: durationSec }),
      timeout: 600000,
    }, PROXY);
  } catch (e) {
    const err = new Error(
      `LOCAL_INFERENCE_UNAVAILABLE: 无法连接本地推理服务 ${LOCAL_BASE}（${e.message}）。\n` +
      '  启用条件：≥8GB VRAM 的机器 + 已下载开源权重（如 ComfyUI + Wan2.1 / HunyuanVideo）。\n' +
      '  本机 GT 1030 仅 4GB，无法运行视频扩散模型。详见 content-gen/LOCAL_SETUP.md。'
    );
    err.code = 'LOCAL_INFERENCE_UNAVAILABLE';
    throw err;
  }
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`LOCAL_INFERENCE_ERROR HTTP ${resp.status}: ${txt.slice(0, 300)}`);
  }
  const data = await resp.json();
  const outUrl = data.url || (data.data && data.data[0] && data.data[0].url);
  if (!outUrl) throw new Error('LOCAL_INFERENCE_NO_URL: ' + JSON.stringify(data).slice(0, 300));
  return outUrl;
}

async function generateTextImage({ prompt, size = '1K', ratio = '1:1', image = null, provider = 'agnes' } = {}) {
  if (provider === 'local') {
    const outUrl = await localGenerate({ type: 'image', prompt, image, width: 1024, height: 1024 });
    return storage.saveImage({ prompt, provider: 'local', sourceUrl: outUrl });
  }
  // 优先 b64_json：整张图在内存里交付，不产生临时文件、不触发 unlinkSync。
  // （数据目录的 unlinkSync 会被 safe-delete 守卫拦截 → 生图 500）
  try {
    const r = await agnes.generateImage({ prompt, size, ratio, image, responseFormat: 'b64_json' });
    if (r.b64_json) {
      return storage.saveImage({ prompt, provider: 'agnes', sourceUrl: r.url, b64_json: r.b64_json });
    }
  } catch (e) {
    console.warn('[providers] b64_json 生图失败，回退 url 下载:', e.message);
  }
  // 回退：URL 下载（saveImage 已改为纯内存，不会再触发守卫）
  const r2 = await agnes.generateImage({ prompt, size, ratio, image, responseFormat: 'url' });
  return storage.saveImage({ prompt, provider: 'agnes', sourceUrl: r2.url, b64_json: r2.b64_json });
}

async function generateVideo({ prompt, duration = 5, width = 1152, height = 768, fps = 24, image = null, provider = 'mpt' } = {}) {
  if (provider === 'local') {
    const outUrl = await localGenerate({ type: 'video', prompt, image, width, height, durationSec: duration });
    return storage.saveVideo({ prompt, provider: 'local', sourceUrl: outUrl, durationSec: duration });
  }

  // 默认走 MPT：Agnes 公开 REST /v1/videos 在 completed 后不返回可下载 url（已多端点验证），
  // 真实视频改由本地部署的 MoneyPrinterTurbo(:8080) 完整管线产出：
  //   LLM 脚本 → Agnes 素材图 → Edge TTS 配音 → ffmpeg 合成字幕
  // 产物落 D:/mscms-content/videos/ 后经 registerExistingFile 登记（零伪造：只登记磁盘真实文件）。
  if (provider === 'mpt') {
    const mpt = require('./mpt-bridge');
    const res = await mpt.generateVideo({ subject: prompt, aspect: '9:16', language: 'zh-CN' });
    return storage.registerExistingFile({
      localPath: res.videoPath,
      prompt,
      provider: 'mpt',
      durationSec: null,
    });
  }

  // agnes 直连分支（保留：上游若修复 url 返回可直接使用）
  const r = await agnes.generateVideo({ prompt, duration, width, height, fps, image, poll: { maxWait: 420, intervalMs: 4000 } });
  if (!r.url) {
    // 公开 REST /v1/videos 在 completed 后不返回可下载 url（已多端点验证）。
    // 真实视频可由 managed VideoGen 工具产出并经 /api/import 登记；此处诚实报错，不伪造。
    const err = new Error(`AGNES_VIDEO_URL_UNAVAILABLE: 任务已完成(task_id=${r.videoId})但公开 REST 未返回可下载地址；请用 managed VideoGen 工具生成后经 /api/import 登记，或经 Agnes 平台取回`);
    err.code = 'AGNES_VIDEO_URL_UNAVAILABLE';
    throw err;
  }
  return storage.saveVideo({ prompt, provider: 'agnes', sourceUrl: r.url, durationSec: duration });
}

module.exports = { generateTextImage, generateVideo, localGenerate, LOCAL_BASE };
