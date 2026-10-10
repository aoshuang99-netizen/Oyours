/**
 * ffmpeg-processor.js — 多渠道音视频分发引擎 · 视频处理模块 (v2 优化版)
 *
 * 职责：
 *   1. TikTok / Instagram → 横屏转 9:16 竖屏（高斯模糊背景，无黑边）
 *   2. X / Reddit        → 轻微裁剪 + 对比度微调
 *   3. 所有平台           → atempo / asetrate 微调音频语速
 *   4. 所有平台           → 尾部追加随机 crypto 脏字节，改变 MD5 指纹
 *   5. [NEW] 硬件加速       → 自动检测 NVENC/QSV 并切换编码器
 *   6. [NEW] 批量处理       → processBatch() 并发队列
 *   7. [NEW] botId 指纹     → 基于 botId 计算独特性参数
 */

const { execFile, spawn } = require('child_process');
const { randomBytes } = require('crypto');
const { readFile, writeFile } = require('fs/promises');
const { existsSync, mkdirSync } = require('fs');
const path = require('path');

// ── 可调参数 ──────────────────────────────────────────────
const CONFIG = {
  vertical: { width: 1080, height: 1920, blurSigma: 20 },
  horizontal: { cropMargin: 0.02, contrastGain: 1.08, brightnessDelta: 0.02 },
  audio: { tempoShift: 0.98, sampleRateShift: 44150 },
  dirtyBytes: { min: 64, max: 512 },
  // 编码参数
  encode: {
    preset: process.env.FFMPEG_PRESET || 'ultrafast',   // DD.txt: ultrafast
    crf: 23,                                             // DD.txt: 23
    audioBitrate: '128k',
    pixelFormat: 'yuv420p',
    movFlags: '+faststart',
  },
};

// ── FFmpeg 路径 ───────────────────────────────────────────
const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE_BIN = process.env.FFPROBE_PATH || 'ffprobe';

// ── 硬件加速检测缓存 ──────────────────────────────────────
let _hwCodec = null;

/**
 * 检测可用的硬件加速编码器
 * @returns {Promise<'h264_nvenc'|'h264_qsv'|'libx264'>}
 */
async function detectHardwareCodec() {
  if (_hwCodec) return _hwCodec;

  try {
    const { execFile: ef } = require('child_process');
    const { promisify } = require('util');
    const execP = promisify(ef);

    // 检测 NVIDIA
    const { stdout: nvenc } = await execP(`${FFMPEG_BIN} -hide_banner -encoders 2>&1 | findstr h264_nvenc`, { shell: 'bash' });
    if (nvenc.includes('h264_nvenc')) {
      _hwCodec = 'h264_nvenc';
      console.log('[ffmpeg] NVENC hardware encoder detected');
      return _hwCodec;
    }
  } catch {
    try {
      // 检测 Intel QSV
      const { stdout: qsv } = await execP(`${FFMPEG_BIN} -hide_banner -encoders 2>&1 | findstr h264_qsv`, { shell: 'bash' });
      if (qsv.includes('h264_qsv')) {
        _hwCodec = 'h264_qsv';
        console.log('[ffmpeg] QSV hardware encoder detected');
        return _hwCodec;
      }
    } catch {
      // fall through
    }
  }

  _hwCodec = 'libx264';
  console.log('[ffmpeg] Software encoder (libx264)');
  return _hwCodec;
}

// ── 工具函数 ─────────────────────────────────────────────

/**
 * 基于 botId 计算动态参数种子（DD.txt 算法）
 */
function seedFromBotId(botId) {
  let seed = 0;
  for (let i = 0; i < botId.length; i++) {
    seed += botId.charCodeAt(i);
  }
  return seed;
}

/**
 * 为指定 botId 生成独特性参数
 */
function botUniqueParams(botId) {
  const seed = seedFromBotId(botId);
  return {
    contrast: (0.985 + (seed % 30) / 1000).toFixed(3),
    brightness: ((seed % 10 - 5) / 200).toFixed(3),
    tempoShift: (0.997 + (seed % 7) / 1000).toFixed(4),
    noiseOffset: seed % 64,
  };
}

/**
 * 执行 FFmpeg（带进度回调）
 * @param {string[]} args
 * @param {function} [onProgress] - ({frame, fps, time}) => void
 */
function ffmpegWithProgress(args, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_BIN, [
      '-progress', 'pipe:1',
      '-nostats',
      ...args,
    ]);

    let stderr = '';
    let lastProgress = {};

    child.stdout.on('data', (d) => {
      const lines = d.toString().split('\n');
      for (const line of lines) {
        const [key, val] = line.split('=');
        if (key && val) lastProgress[key.trim()] = val.trim();
      }
      if (lastProgress.frame && onProgress) {
        onProgress({
          frame: parseInt(lastProgress.frame, 10) || 0,
          fps: parseFloat(lastProgress.fps) || 0,
          time: lastProgress.time || '00:00:00',
          speed: lastProgress.speed || '0x',
        });
      }
    });

    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', (code) => {
      if (code === 0) resolve(lastProgress);
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-500)}`));
    });

    child.on('error', reject);
  });
}

/**
 * 简单执行（无进度）
 */
function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = execFile(FFMPEG_BIN, args, { maxBuffer: 64 * 1024 * 1024 });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      if (code === 0) resolve(stdout || stderr);
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-500)}`));
    });
    child.on('error', reject);
  });
}

/**
 * 视频探针
 */
async function probe(inputPath) {
  return new Promise((resolve, reject) => {
    execFile(FFPROBE_BIN, [
      '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', inputPath,
    ], { maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(JSON.parse(stdout));
    });
  });
}

/**
 * 尾部追加随机脏字节，改变 MD5 指纹
 */
async function appendDirtyBytes(filePath) {
  const count = CONFIG.dirtyBytes.min +
    Math.floor(Math.random() * (CONFIG.dirtyBytes.max - CONFIG.dirtyBytes.min));
  const junk = randomBytes(count);
  const existing = await readFile(filePath);
  const marker = Buffer.from(`\n<!-- dirty:${randomBytes(8).toString('hex')} -->\n`);
  await writeFile(filePath, Buffer.concat([existing, marker, junk]));
  return marker.length + junk.length;
}

// ── 核心处理函数 ──────────────────────────────────────────

/**
 * 构建音频微调滤镜链
 */
function buildAudioFilter(tempoOverride) {
  const tempo = tempoOverride || CONFIG.audio.tempoShift;
  const rate = CONFIG.audio.sampleRateShift;
  return `asetrate=${rate},aresample=44100,atempo=${tempo}`;
}

/**
 * TikTok / Instagram：横屏 → 9:16 竖屏（高斯模糊背景）
 * @param {object} opts - { inputPath, outputPath, contrast, brightness, onProgress }
 */
async function verticalBlur(inputPath, outputPath, opts = {}) {
  const { width: tw, height: th, blurSigma } = CONFIG.vertical;
  const { contrast = CONFIG.horizontal.contrastGain, brightness = CONFIG.horizontal.brightnessDelta } = opts;

  const filter = [
    '[0:v]split[original][bg]',
    `[bg]scale=${tw}:${th}:force_original_aspect_ratio=increase,crop=${tw}:${th},gblur=sigma=${blurSigma}[blurred]`,
    `[original]scale=${tw}:-2[scaled]`,
    `[blurred][scaled]overlay=(W-w)/2:(H-h)/2,eq=contrast=${contrast}:brightness=${brightness},setsar=1`,
  ].join(';');

  const audioFilter = buildAudioFilter(opts.tempoShift);
  const codec = await detectHardwareCodec();
  const codecArgs = codec === 'libx264'
    ? ['-c:v', 'libx264', '-preset', CONFIG.encode.preset, '-crf', String(CONFIG.encode.crf)]
    : ['-c:v', codec, '-preset', 'p1', '-cq', String(CONFIG.encode.crf)];  // NVENC p1=fastest

  const args = [
    '-i', inputPath,
    '-filter_complex', filter,
    '-af', audioFilter,
    ...codecArgs,
    '-c:a', 'aac', '-b:a', CONFIG.encode.audioBitrate,
    '-pix_fmt', CONFIG.encode.pixelFormat,
    '-movflags', CONFIG.encode.movFlags,
    '-y', outputPath,
  ];

  if (opts.onProgress) {
    await ffmpegWithProgress(args, opts.onProgress);
  } else {
    await ffmpeg(args);
  }

  await appendDirtyBytes(outputPath);
}

/**
 * X / Reddit：轻微裁剪 + 对比度微调
 */
async function horizontalAdjust(inputPath, outputPath, opts = {}) {
  const { cropMargin, contrastGain, brightnessDelta } = CONFIG.horizontal;
  const { contrast = contrastGain, brightness = brightnessDelta } = opts;

  const info = await probe(inputPath);
  const vStream = info.streams.find((s) => s.codec_type === 'video');
  const ow = vStream?.width || 1920;
  const oh = vStream?.height || 1080;

  const cropW = Math.floor(ow * (1 - cropMargin * 2));
  const cropH = Math.floor(oh * (1 - cropMargin * 2));
  const cropX = Math.floor((ow - cropW) / 2);
  const cropY = Math.floor((oh - cropH) / 2);

  const videoFilter = [
    `scale=iw*1.012:ih*1.012`,
    `crop=${cropW}:${cropH}:${cropX}:${cropY}`,
    `eq=contrast=${contrast}:brightness=${brightness},setsar=1`,
  ].join(',');

  const audioFilter = buildAudioFilter(opts.tempoShift);
  const codec = await detectHardwareCodec();
  const codecArgs = codec === 'libx264'
    ? ['-c:v', 'libx264', '-preset', CONFIG.encode.preset, '-crf', String(CONFIG.encode.crf)]
    : ['-c:v', codec, '-preset', 'p1', '-cq', String(CONFIG.encode.crf)];

  const args = [
    '-i', inputPath,
    '-vf', videoFilter,
    '-af', audioFilter,
    ...codecArgs,
    '-c:a', 'aac', '-b:a', CONFIG.encode.audioBitrate,
    '-pix_fmt', CONFIG.encode.pixelFormat,
    '-movflags', CONFIG.encode.movFlags,
    '-y', outputPath,
  ];

  if (opts.onProgress) {
    await ffmpegWithProgress(args, opts.onProgress);
  } else {
    await ffmpeg(args);
  }

  await appendDirtyBytes(outputPath);
}

// ── 公开接口 ──────────────────────────────────────────────

/**
 * 按平台处理视频（含 botId 独特性参数）
 *
 * @param {string}  inputPath
 * @param {string}  outputPath
 * @param {'X'|'Reddit'|'Instagram'|'TikTok'} platform
 * @param {object} [opts]
 * @param {string} [opts.botId]     - DD.txt: 基于 botId 计算独特性指纹参数
 * @param {function} [opts.onProgress]
 */
async function processForPlatform(inputPath, outputPath, platform, opts = {}) {
  const normalized = platform?.toLowerCase();

  // DD.txt: 基于 botId 生成独特性参数
  if (opts.botId) {
    const unique = botUniqueParams(opts.botId);
    opts.contrast = opts.contrast || unique.contrast;
    opts.brightness = opts.brightness || unique.brightness;
    opts.tempoShift = opts.tempoShift || unique.tempoShift;
  }

  if (normalized === 'tiktok' || normalized === 'instagram') {
    await verticalBlur(inputPath, outputPath, opts);
  } else {
    await horizontalAdjust(inputPath, outputPath, opts);
  }

  return { outputPath, platform };
}

/**
 * 批量处理（并发队列）
 * @param {Array<{inputPath, outputPath, platform, botId}>} tasks
 * @param {number} [concurrency=2]
 * @param {function} [onTaskComplete]
 */
async function processBatch(tasks, concurrency = 2, onTaskComplete) {
  const results = [];
  const queue = [...tasks];

  async function worker(workerId) {
    while (queue.length > 0) {
      const task = queue.shift();
      if (!task) break;
      const result = await processForPlatform(task.inputPath, task.outputPath, task.platform, { botId: task.botId });
      results.push({ ...result, success: true });
      if (onTaskComplete) onTaskComplete({ ...result, workerId });
    }
  }

  const workers = Array.from({ length: concurrency }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  return results;
}

/**
 * 仅重新打指纹
 */
async function reFingerprint(filePath) {
  await appendDirtyBytes(filePath);
  return { filePath };
}

/**
 * DD.txt 兼容别名：processAndWashVideo
 */
const processAndWashVideo = processForPlatform;

module.exports = {
  processForPlatform,
  processAndWashVideo,       // DD.txt 兼容
  processBatch,
  verticalBlur,
  horizontalAdjust,
  reFingerprint,
  appendDirtyBytes,
  probe,
  detectHardwareCodec,
  botUniqueParams,
  CONFIG,
};
