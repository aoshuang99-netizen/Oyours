/**
 * mpt-bridge.js — MoneyPrinterTurbo ↔ content-gen 子系统桥接
 *
 * 职责：
 * 1. 将 MSCMS content-gen 的 generate 请求路由到 MPT（:8081）
 * 2. MPT 生成完成后下载视频到 D:/mscms-content/videos/
 * 3. 将产物登记进 registry.json（通过 /api/import）
 *
 * MPT API（:8081）：
 *   POST /api/v1/scripts     - 生成视频脚本（LLM）
 *   POST /api/v1/terms       - 提取视频关键词
 *   POST /api/v1/videos      - 生成短视频
 *   GET  /api/v1/tasks/{id}  - 查询任务状态
 *
 * content-gen 现有 API（:3010）：
 *   POST /api/generate       - 图文生成（直接走 Agnes REST）
 *   POST /api/import         - 导入已存在文件到注册表
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const { fetchExt } = require('../http-client');

const MPT_HOST = '127.0.0.1';
const MPT_PORT = 8080;
const CONTENT_GEN_HOST = '127.0.0.1';
const CONTENT_GEN_PORT = 3010;
const CONTENT_ROOT = process.env.MSCMS_CONTENT_ROOT || 'D:/mscms-content';
// MPT 落盘根目录：生成完的视频直接在此，无需走 HTTP download（该 API 实测 404）
const MPT_STORAGE = process.env.MPT_STORAGE_ROOT || 'D:/MoneyPrinterTurbo/storage';

/**
 * HTTP POST to MPT
 */
async function mptPost(endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = {
      hostname: MPT_HOST,
      port: MPT_PORT,
      path: endpoint,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };

    const req = http.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { resolve({ _raw: d }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(300000, () => { req.destroy(new Error('MPT timeout')); reject(new Error('MPT timeout')); });
    req.write(data);
    req.end();
  });
}

/**
 * HTTP GET from MPT
 */
async function mptGet(endpoint) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: MPT_HOST,
      port: MPT_PORT,
      path: endpoint,
      method: 'GET',
    };

    const req = http.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { resolve({ _raw: d }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(new Error('MPT GET timeout')); reject(new Error('MPT GET timeout')); });
    req.end();
  });
}

/**
 * Download file from URL to local path（仅兜底用）
 * 注意：MPT 的 /download /stream 端点实测返回 404（82 字节 JSON），
 * 因此主路径走 locateTaskVideo() 直接读 MPT storage 目录，本函数仅在目录缺失时兜底。
 */
async function downloadFile(url, destPath) {
  const resp = await fetchExt(url, { method: 'GET' }, 'http://127.0.0.1:10808');
  const buffer = Buffer.from(await resp.arrayBuffer());
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buffer);
  return { bytes: buffer.length, path: destPath };
}

/**
 * 在 MPT storage 目录中定位任务产物视频（本地直读，不走 HTTP）。
 * MPT 合成完成后固定产出 storage/tasks/{taskId}/final-1.mp4（combined-1.mp4 为无字幕版本）。
 * @returns {?string} 绝对路径，未找到返回 null
 */
function locateTaskVideo(taskId) {
  const dir = path.join(MPT_STORAGE, 'tasks', String(taskId));
  if (!fs.existsSync(dir)) return null;
  // 优先 final-1.mp4（含字幕），回退 combined-1.mp4
  for (const name of ['final-1.mp4', 'combined-1.mp4']) {
    const p = path.join(dir, name);
    if (fs.existsSync(p) && fs.statSync(p).size > 1024) return p;
  }
  // 兜底：扫描目录下任何 .mp4（排除素材片段）
  try {
    const mp4s = fs.readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.mp4'))
      .map((f) => ({ f, p: path.join(dir, f), s: fs.statSync(path.join(dir, f)).size }))
      .filter((x) => x.s > 1024)
      .sort((a, b) => b.s - a.s);
    if (mp4s.length) return mp4s[0].p;
  } catch (_) { /* ignore */ }
  return null;
}

/**
 * 按语言挑选默认 TTS 语音。
 * 必须返回非空语音名——MPT 的 TTS 在 voice_name 为空时直接抛 Invalid voice ''。
 * 这些语音实测可用（zh/en 均无需 Azure key）。
 */
function defaultVoiceFor(language) {
  const lang = String(language || '').toLowerCase();
  if (lang.startsWith('zh')) return 'zh-CN-XiaoxiaoNeural';
  if (lang.startsWith('en')) return 'en-US-AndrewMultilingualNeural';
  if (lang.startsWith('ja')) return 'ja-JP-NanamiNeural';
  if (lang.startsWith('ko')) return 'ko-KR-SunHiNeural';
  return 'zh-CN-XiaoxiaoNeural';
}

/**
 * 按句末标点把脚本截断到 maxChars 字以内。
 *
 * 必要性：脚本长度直接决定 TTS 音频时长，而 MPT 的字幕渲染是 CPU 软渲染，
 * 耗时随视频长度非线性增长——实测 13s 音频约 2~3 分钟完成，45s 音频要 15 分钟以上，
 * 会拖垮整条 S3 链路。短视频（Tumblr）场景控制在 ~20s 即可。
 */
function truncateScript(script, maxChars = 220) {
  const s = String(script || '').trim();
  if (s.length <= maxChars) return s;
  const cut = s.slice(0, maxChars);
  // 在句中/句末标点后断开，避免截在半句
  const m = cut.match(/^[\s\S]+[。！？!?.;；]/);
  return (m ? m[0] : cut).trim();
}

/**
 * Generate video script using MPT's LLM
 */
async function generateScript(subject, language = 'zh-CN', paragraphs = 1) {
  const result = await mptPost('/api/v1/scripts', {
    video_subject: subject,
    video_language: language,
    paragraph_number: paragraphs,
  });
  if (!result.data || !result.data.video_script) {
    throw new Error('MPT script generation failed: ' + JSON.stringify(result));
  }
  return result.data.video_script;
}

/**
 * Extract video terms from script
 */
async function generateTerms(script, amount = 5) {
  const result = await mptPost('/api/v1/terms', {
    video_script: script,
    amount,
  });
  if (!result.data || !result.data.video_terms) {
    throw new Error('MPT terms generation failed: ' + JSON.stringify(result));
  }
  return result.data.video_terms;
}

/**
 * Generate video via MPT
 * @param {Object} opts
 * @param {string} opts.subject - video subject
 * @param {string} [opts.script] - optional script (if not provided, will be generated)
 * @param {string} [opts.terms] - optional terms (if not provided, will be generated)
 * @param {string} [opts.aspect='9:16'] - video aspect ratio
 * @param {string} [opts.language='zh-CN'] - language for script/TTS
 * @returns {Promise<{taskId:string, videoPath:string}>}
 */
async function generateVideo(opts = {}) {
  const {
    subject,
    script: providedScript,
    terms: providedTerms,
    aspect = '9:16',
    language = 'zh-CN',
    voiceName = null,
    maxChars = 220,
  } = opts;

  if (!subject) throw new Error('subject required');

  // 关键：MPT 的 TTS 在 voice_name 为空时直接失败（Invalid voice ''）。
  // 实测传 zh-CN-XiaoxiaoNeural 可成功合成（无需 Azure key）。
  const voice = voiceName || defaultVoiceFor(language);

  // Step 1: Generate script if not provided
  let script = providedScript;
  if (!script) {
    script = await generateScript(subject, language);
  }
  // 控制音频时长：过长脚本会让 ffmpeg 字幕渲染从分钟级涨到十几分钟（见 truncateScript 注释）
  script = truncateScript(script, maxChars);
  console.log(`[MPT] script chars=${script.length}`);

  // Step 2: Generate terms if not provided
  let terms = providedTerms;
  if (!terms) {
    const termsResult = await generateTerms(script, 5);
    terms = Array.isArray(termsResult) ? termsResult : termsResult.video_terms;
  }

  // Step 3: Create video generation task
  const taskResult = await mptPost('/api/v1/videos', {
    video_subject: subject,
    video_script: script,
    video_terms: terms,
    video_aspect: aspect,
    video_source: 'openai_image',  // Use Agnes for images
    video_language: language,
    voice_name: voice,             // 必填：空值会导致 TTS 阶段 Invalid voice '' 而整单失败
    subtitle_enabled: true,
  });

  if (!taskResult.data || !taskResult.data.task_id) {
    throw new Error('MPT video generation failed: ' + JSON.stringify(taskResult));
  }

  const taskId = taskResult.data.task_id;
  console.log(`[MPT] Video generation started: taskId=${taskId}`);

  // Step 4: Poll for completion
  let status;
  let attempts = 0;
  const maxAttempts = 360; // 30 minutes at 5s intervals（长视频字幕渲染实测可超 15 分钟）

  while (attempts < maxAttempts) {
    await new Promise(r => setTimeout(r, 5000));
    attempts++;

    status = await mptGet(`/api/v1/tasks/${taskId}`);

    if (status.data) {
      const progress = status.data.progress || 0;
      const state = status.data.state;

      if (state === 1 && progress >= 100) {
        console.log(`[MPT] Video completed: ${taskId}`);
        // 主路径：直接从 MPT storage 目录本地复制（HTTP download 端点实测 404）
        const src = locateTaskVideo(taskId);
        if (src) {
          const safeName = String(subject).replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 60);
          const videoPath = path.join(CONTENT_ROOT, 'videos', `mpt_${safeName}_${taskId.slice(0, 8)}.mp4`);
          fs.mkdirSync(path.dirname(videoPath), { recursive: true });
          fs.copyFileSync(src, videoPath);
          console.log(`[MPT] Copied ${src} -> ${videoPath}`);
          return { taskId, videoPath, bytes: fs.statSync(videoPath).size };
        }
        // 兜底：仅在本地目录确实无产物时才尝试 URL
        if (status.data.videos && status.data.videos.length > 0) {
          const videoUrl = status.data.videos[0];
          const videoPath = path.join(CONTENT_ROOT, 'videos', `mpt_${taskId.slice(0, 8)}.mp4`);
          await downloadFile(videoUrl, videoPath);
          return { taskId, videoPath, bytes: fs.statSync(videoPath).size };
        }
        throw new Error(`MPT video completed but no artifact found (taskId=${taskId}, dir=${path.join(MPT_STORAGE, 'tasks', taskId)})`);
      }

      if (state === -1) {
        throw new Error(`MPT video failed: ${status.data.error || 'unknown error'}`);
      }

      if (attempts % 6 === 0) console.log(`[MPT] Progress: ${progress}%`);
    }
  }

  throw new Error(`MPT video timeout after ${maxAttempts * 5}s`);
}

// 注意：图片不再由此处转发。MPT 无独立生图端点，图片统一走 providers.generateTextImage
// （agnes 分支）。此处若 require('./providers') 会与 providers→mpt-bridge 形成循环依赖，故移除。

/**
 * Import a local file into the content-gen registry
 */
async function importFile(localPath, prompt = null, provider = 'mpt') {
  const data = JSON.stringify({ localPath, prompt, provider });
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: CONTENT_GEN_HOST,
      port: CONTENT_GEN_PORT,
      path: '/api/import',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };

    const req = http.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { reject(new Error('Invalid response: ' + d)); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

module.exports = {
  MPT_HOST,
  MPT_PORT,
  CONTENT_GEN_HOST,
  CONTENT_GEN_PORT,
  CONTENT_ROOT,
  MPT_STORAGE,
  mptPost,
  mptGet,
  downloadFile,
  locateTaskVideo,
  defaultVoiceFor,
  truncateScript,
  generateScript,
  generateTerms,
  generateVideo,
  importFile,
};
