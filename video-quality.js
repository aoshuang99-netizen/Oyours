'use strict';
/**
 * video-quality.js — 短视频质检（P3-C5）
 *
 * 判据（方案「内容闭环」§6.3 C5）：
 *   1) 时长        5 ~ 60 秒
 *   2) 分辨率      宽 ≥ 640 且 高 ≥ 360（竖屏 1080x1920 天然满足）
 *   3) 单文件体积  ≤ 平台上限（默认 100MB，Tumblr 保守值）
 *   4) 首帧非黑    首帧最亮像素 YMAX ≥ minYmax（默认 100/255）
 *
 * 实现要点：
 *  - 只用 ffmpeg。ffmpeg-static 不含 ffprobe，元信息从 `ffmpeg -i` 的 stderr 解析。
 *  - 首帧亮度：`select=eq(n\,0),scale=1:1` + `-pix_fmt gray` 把首帧压成 **1 个像素**，
 *    该字节值即全帧平均亮度。比逐像素统计快几个数量级，且不依赖任何外部图像库。
 *  - 本模块 **不 require video-render.js**（否则形成循环依赖：video-render → video-quality → video-render）。
 *
 * 降级语义（重要，勿混淆）：
 *  - `degraded: true` 表示「质检工具本身不可用（ffmpeg 缺失/解析失败）」，**不代表视频不合格**。
 *    调用方应区别对待：degraded 可放行并标记，真实不达标才拒绝。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_LIMITS = Object.freeze({
  minDuration: 5,          // 秒
  maxDuration: 60,         // 秒
  minWidth: 640,
  minHeight: 360,
  maxBytes: 100 * 1024 * 1024,  // Tumblr 视频上限保守值
  // 阈值标定（2026-09-17 实测，勿凭直觉改；判据用 YMAX，不用平均值）
  //   ⚠️ 曾用「平均亮度」判黑屏，实测不可靠：平均值与文字行数成正比 ——
  //      同一模板下 8 行字 YAVG=36、5 行字 YAVG=34，而纯黑帧 YAVG=16，
  //      区间贴近，阈值取哪都会误杀或漏报（实测已误杀过 5 行字的正常产物）。
  //   改用 signalstats 的 YMAX（最亮像素），区分度极干净：
  //      纯黑（ffmpeg color=black，limited range）  = 16
  //      纯深色背景 0x101418、文字未渲染上           = 33
  //      深色背景 + 白色 drawtext（正常产物）        = 253~255
  //   取 100：只要画面里真渲染出了亮部就算通过。
  minYmax: 100,            // 0~255，用于「首帧非黑」（画面必须有亮部）
});

 function findFfmpeg() {
  const candidates = [
    path.join(process.env.NODE_PATH || '', 'ffmpeg-static', 'ffmpeg.exe'),
    'C:/Users/AS//binaries/node/workspace/node_modules/ffmpeg-static/ffmpeg.exe',
  ];
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c; } catch (_) { /* ignore */ }
  }
  try {
    const p = require('ffmpeg-static');
    if (p && fs.existsSync(p)) return p;
  } catch (_) { /* ffmpeg-static 未安装：降级为系统 ffmpeg */ }
  return 'ffmpeg';
}

/** 从 `ffmpeg -i` 的 stderr 解析元信息 */
 function probeMeta(file, ffmpegPath) {
  let stderr = '';
  try {
    execFileSync(ffmpegPath, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    stderr = String((e && e.stderr) || '');
  }
  const dm = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  const duration = dm ? (+dm[1]) * 3600 + (+dm[2]) * 60 + parseFloat(dm[3]) : null;
  const vm = stderr.match(/Video:.*?,\s*(\d{2,5})x(\d{2,5})/);
  const bm = stderr.match(/bitrate:\s*([\d.]+\s*kb\/s)/);
  return {
    duration,
    width: vm ? +vm[1] : 0,
    height: vm ? +vm[2] : 0,
    bitrate: bm ? bm[1] : null,
    hasVideoStream: !!vm,
    raw: stderr ? stderr.slice(-400) : '',
  };
}

/**
 * 首帧像素统计（YMIN/YAVG/YMAX，0~255）；无法取得返回 null。
 *
 * 用 `signalstats` + `metadata=print:file=-` 把统计值打到 stdout，
 * 比 `scale=1:1` 取平均值可靠得多（平均值会被画面明暗比例稀释，见 DEFAULT_LIMITS 标定说明）。
 * 判定「非黑」一律用 **YMAX**。
 */
 function firstFrameStats(file, ffmpegPath) {
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-i', file,
    '-vf', 'select=eq(n\\,0),signalstats,metadata=print:file=-',
    '-frames:v', '1',
    '-f', 'null', '-',
  ];
  let out = '';
  try {
    out = String(execFileSync(ffmpegPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 16 }) || '');
  } catch (e) {
    out = String((e && e.stdout) || '');
  }
  const num = (k) => {
    const m = out.match(new RegExp('signalstats\\.' + k + '=([\\d.]+)'));
    return m ? parseFloat(m[1]) : null;
  };
  const ymax = num('YMAX');
  if (ymax == null) return null;
  return { ymin: num('YMIN'), yavg: num('YAVG'), ymax };
}

/**
 * 质检一条视频
 * @param {string} file 视频绝对路径
 * @param {object} [opts] 覆盖 limits / ffmpegPath
 * @returns {{ok:boolean, reason:string, checks:Array, meta:object, luma:?number, degraded:boolean}}
 */
 function checkVideo(file, opts = {}) {
  const limits = Object.assign({}, DEFAULT_LIMITS, opts.limits || {});
  const ff = opts.ffmpegPath || findFfmpeg();

  if (!file || !fs.existsSync(file)) {
    return { ok: false, reason: 'file_missing', checks: [], meta: null, luma: null, degraded: false, detail: '文件不存在' };
  }
  let size = 0;
  try { size = fs.statSync(file).size; } catch (_) { /* ignore */ }
  if (size <= 0) {
    return { ok: false, reason: 'empty_file', checks: [], meta: { size }, luma: null, degraded: false, detail: '文件为空' };
  }

  const meta = probeMeta(file, ff);
  meta.size = size;

  // ffmpeg 不可用 / 无法解析出视频流 → 降级（不算视频不合格）
  if (!meta.hasVideoStream && meta.duration == null) {
    return { ok: false, reason: 'probe_unavailable', checks: [], meta, luma: null, degraded: true, detail: '质检工具不可用或无法解析视频流' };
  }

  const checks = [];
  const push = (name, ok, detail) => checks.push({ name, ok, detail });

  // 1) 时长
  if (meta.duration == null) push('duration', false, '无法解析时长');
  else if (meta.duration < limits.minDuration) push('duration', false, `${meta.duration.toFixed(2)}s < ${limits.minDuration}s`);
  else if (meta.duration > limits.maxDuration) push('duration', false, `${meta.duration.toFixed(2)}s > ${limits.maxDuration}s`);
  else push('duration', true, `${meta.duration.toFixed(2)}s`);

  // 2) 分辨率（竖屏/横屏都按「宽≥minWidth 且 高≥minHeight」判定）
  if (!meta.width || !meta.height) push('re', false, '无法解析分辨率');
  else if (meta.width < limits.minWidth || meta.height < limits.minHeight) {
    push('re', false, `${meta.width}x${meta.height} < ${limits.minWidth}x${limits.minHeight}`);
  } else push('re', true, `${meta.width}x${meta.height}`);

  // 3) 体积
  if (size > limits.maxBytes) push('size', false, `${(size / 1048576).toFixed(1)}MB > ${(limits.maxBytes / 1048576).toFixed(0)}MB`);
  else push('size', true, `${(size / 1024).toFixed(1)}KB`);

  // 4) 首帧非黑 —— 判据是 YMAX（最亮像素），不是平均值
  const stats = firstFrameStats(file, ff);
  const luma = stats ? stats.yavg : null;   // 仅作参考值，不参与判定
  if (!stats) push('first_frame', false, '首帧统计取样失败');
  else if (stats.ymax < limits.minYmax) push('first_frame', false, `YMAX=${stats.ymax} < ${limits.minYmax}（疑似黑屏或空壳）`);
  else push('first_frame', true, `YMAX=${stats.ymax} YAVG=${stats.yavg}`);

  const failed = checks.filter(c => !c.ok);
  return {
    ok: failed.length === 0,
    reason: failed.length ? failed.map(c => c.name).join(',') : 'ok',
    checks,
    meta,
    luma,
    stats,
    degraded: false,
    detail: failed.length ? failed.map(c => `${c.name}:${c.detail}`).join('; ') : '全部通过',
  };
}

module.exports = { checkVideo, probeMeta, firstFrameStats, findFfmpeg, DEFAULT_LIMITS };
