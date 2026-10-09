'use strict';
/**
 * agnes-client.js — Agnes AI 云生成客户端（图片 / 视频）
 *
 * 设计要点：
 *  - 直接对接 https://api.agnes-ai.cn（与 WorkBuddy 内置 ImageGen/VideoGen 同一后端）。
 *  - 所有外部请求一律经 ../http-client 的 fetchExt，由 VPS 代理 10808 中转（铁律）。
 *  - API key 读取优先级：~//config/agnes_api_key.txt → 环境变量 AGNES_API_KEY。
 *  - 不伪造任何返回：Agnes 真实返回 URL 或 b64_json；若上游失败则抛错透传。
 *
 * 接口还原自：
 *  - ~//skills/agnes-image-gen/scripts/agnes_image.py
 *  - ~//skills/agnes-video-gen/scripts/agnes_video.py
 */

const fs = require('fs');
const path = require('path');
const { fetchExt } = require('../http-client');

const AGNES_BASE = 'https://api.agnes-ai.cn';
const PROXY = process.env.AGNES_PROXY || 'http://:10808';

 getApiKey() {
  const candidates = [
    path.join(process.env.USERPROFILE || process.env.HOME || '', '', 'config', 'agnes_api_key.txt'),
  ];
  for (const f of candidates) {
    try {
      if (fs.existsSync(f)) {
        const k = fs.readFileSync(f, 'utf8').trim();
        if (k) return k;
      }
    } catch (_) { /* ignore */ }
  }
  if (process.env.AGNES_API_KEY) return process.env.AGNES_API_KEY;
  return null;
}

async  _postJSON(endpoint, payload, apiKey) {
  const resp = await fetchExt(`${AGNES_BASE}${endpoint}`, {
    method: 'POST',
    headers: {
      '': `Bearer ${apiKey}`,
      '': 'application/json',
    },
    body: JSON.stringify(payload),
    timeout: 360000,
  }, PROXY);
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = { _raw: text }; }
  if (!resp.ok) {
    const msg = (data && (data.error || data.message)) || text || `HTTP ${resp.status}`;
    throw new Error(`Agnes API ${endpoint} failed (${resp.status}): ${msg}`);
  }
  return data;
}

async  _getJSON(endpoint, apiKey) {
  const resp = await fetchExt(`${AGNES_BASE}${endpoint}`, {
    method: 'GET',
    headers: { '': `Bearer ${apiKey}` },
    timeout: 360000,
  }, PROXY);
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = { _raw: text }; }
  if (!resp.ok) {
    const msg = (data && (data.error || data.message)) || text || `HTTP ${resp.status}`;
    throw new Error(`Agnes API ${endpoint} failed (${resp.status}): ${msg}`);
  }
  return data;
}

/**
 * 生成图片（文本 / 图生图）
 * @param {Object} opts
 * @param {string} opts.prompt
 * @param {'1K'|'2K'|'3K'|'4K'|'1024x768'|'768x1024'} [opts.size='1K']
 * @param {string} [opts.ratio='1:1']
 * @param {string|string[]} [opts.image] 图生图输入 URL（可多个）
 * @param {'url'|'b64_json'} [opts.responseFormat='url']
 * @returns {Promise<{url:?string, b64_json:?string, raw:Object}>}
 */
async  generateImage(opts = {}) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error(': 未配置 Agnes key（~//config/agnes_api_key.txt 或 AGNES_API_KEY）');
  const { prompt, size = '1K', ratio = '1:1', image = null, responseFormat = 'url' } = opts;
  if (!prompt) throw new Error('prompt required');

  const payload = { model: 'agnes-image-2.1-flash', prompt, size };
  if (ratio && ratio !== '1:1') payload.ratio = ratio;
  const extra_body = {};
  if (image) extra_body.image = Array.isArray(image) ? image : [image];
  if (responseFormat === 'b64_json') extra_body.response_format = 'b64_json';
  if (Object.keys(extra_body) payload.extra_body = extra_body;

  const data = await _postJSON('/v1/images/generations', payload, apiKey);
  if (!data.data || !data.data[0]) {
    throw new Error('AGNES_NO_IMAGE_DATA: ' + JSON.stringify(data).slice(0, 500));
  }
  const item = data.data[0];
  return { url: item.url || null, b64_json: item.b64_json || null, raw: data };
}

/**
 * 视频帧数换算（24fps，8n+1 规则，最大 441）
 */
 framesForDuration(seconds) {
  const fps = 24;
  const raw = Math.round(seconds * fps);
  let n = Math.round((raw - 1) / 8);
  n = Math.max(1, Math.min(n, 55));
  return 8 * n + 1;
}

/**
 * 创建视频生成任务（文本 / 图生视频 / 关键帧）
 * @returns {Promise<{videoId:string, status:string}>}
 */
async  createVideo(opts = {}) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('');
  const {
    prompt, duration = 5, width = 1152, height = 768, fps = 24,
    image = null, keyframes = null, seed = null, negativePrompt = null,
  } = opts;
  if (!prompt) throw new Error('prompt required');

  const payload = {
    model: 'agnes-video-v2.0',
    prompt,
    height, width,
    num_frames: framesForDuration(duration),
    frame_rate: fps,
  };
  if (seed != null) payload.seed = seed;
  if (negativePrompt) payload.negative_prompt = negativePrompt;

  if (keyframes) {
    payload.extra_body = { image: Array.isArray(keyframes) ? keyframes : [keyframes], mode: 'keyframes' };
  } else if (image) {
    payload.image = image;
  }

  const data = await _postJSON('/v1/videos', payload, apiKey);
  const videoId = data.id || data.video_id || data.task_id;
  if (!videoId) throw new Error('AGNES_NO_VIDEO_ID: ' + JSON.stringify(data).slice(0, 500));
  return { videoId, status: data.status || 'pending' };
}

/**
 * 轮询视频任务直到完成 / 失败 / 超时
 * @returns {Promise<{videoId:string, url:?string, status:string, raw:Object}>}
 */
async  pollVideo(videoId, { maxWait = 420, intervalMs = 4000 } = {}) {
  const apiKey = getApiKey();
  const deadline = Date.now() + maxWait * 1000;
  let last = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const data = await _getJSON(`/v1/videos/${videoId}`, apiKey);
    last = data;
    const status = (data.status || '').toLowerCase();
    if (status === 'completed') {
      // 实测 url 在顶层，部分端点放 video_url / metadata.url；优先取真实可下载地址
      const url = data.url || data.video_url || (data.metadata && (data.metadata.url || data.metadata.video_url)) || null;
      return { videoId, url, status: 'completed', raw: data };
    }
    if (status === 'failed') {
      throw new Error('AGNES_VIDEO_FAILED: ' + JSON.stringify(data).slice(0, 500));
    }
  }
  throw new Error(`AGNES_VIDEO_TIMEOUT: 超过 ${maxWait}s 未完成 (last=${JSON.stringify(last).slice(0, 300)})`);
}

/**
 * 端到端生成短视频（创建 + 轮询）
 */
async  generateVideo(opts = {}) {
  const { videoId } = await createVideo(opts);
  return pollVideo(videoId, opts.poll || {});
}

module.exports = {
  AGNES_BASE,
  getApiKey,
  generateImage,
  createVideo,
  pollVideo,
  generateVideo,
  framesForDuration,
};
