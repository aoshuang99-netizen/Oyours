'use strict';
/**
 * video-render.js — ffmpeg 短视频渲染管线（真渲染 .mp4）
 *
 * 功能：
 *  - 基于真实热点/脚本文本，用 ffmpeg 渲染 <=10s 竖屏短视频（1080x1920）
 *  - 文字叠加（drawtext + CJK 字体），可选背景图 + 缓慢缩放（Ken Burns）
 *  - 异步队列顺序渲染，状态落 DataStore 'video_render'
 *  - 输出到 D:/MSCMS-Content/videos/{id}.mp4，回写 content.video_url
 *
 * 这是“二次自动化编辑”的核心：把真实热点主题渲染成可在 Tumblr 发布的原创短视频。
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function findFfmpeg() {
  const candidates = [
    path.join(process.env.NODE_PATH || '', 'ffmpeg-static', 'ffmpeg.exe'),
    'C:/Users/AS/.workbuddy/binaries/node/workspace/node_modules/ffmpeg-static/ffmpeg.exe'
  ];
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c; } catch (_) {}
  }
  // 最后尝试 require 解析（缺失则降级为系统 ffmpeg，不抛异常以免拖垮整个 v14 初始化）
  try {
    const p = require('ffmpeg-static');
    if (p && fs.existsSync(p)) return p;
  } catch (_) { /* ffmpeg-static 未安装：降级为系统 ffmpeg */ }
  return 'ffmpeg';
}

function findFont() {
  const candidates = [
    'C:/Windows/Fonts/msyh.ttc',
    'C:/Windows/Fonts/simhei.ttf',
    'C:/Windows/Fonts/msyhbd.ttc',
    'C:/Windows/Fonts/arial.ttf'
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'C:/Windows/Fonts/arial.ttf';
}

class VideoRender {
  constructor(dataStore, opts = {}) {
    this.dataStore = dataStore;
    this.ffmpegPath = opts.ffmpegPath || findFfmpeg();
    this.fontPath = opts.fontPath || findFont();
    this.outDir = opts.outDir || 'D:/MSCMS-Content/videos';
    this.bgImageDir = opts.bgImageDir || 'D:/MSCMS-Content/bg';
    if (!fs.existsSync(this.outDir)) fs.mkdirSync(this.outDir, { recursive: true });
    if (!fs.existsSync(this.bgImageDir)) fs.mkdirSync(this.bgImageDir, { recursive: true });
    this._queue = [];
    this._running = false;
    console.log(`[VideoRender] ffmpeg=${this.ffmpegPath} font=${this.fontPath} out=${this.outDir}`);
  }

  _escColon(p) { return String(p).replace(/:/g, '\\:'); }

  _sanitizeText(s) {
    return String(s)
      .replace(/\\/g, '')            // drawtext 把反斜杠当转义
      .replace(/[\r]/g, '')
      .slice(0, 200);
  }

  /**
   * 渲染短视频
   * @param req { id, contentId?, title, lines[], tags[], duration?, bgImage? }
   *  - lines: 文本行（含标题/正文/标签）
   *  - duration: 秒，3~10
   *  - bgImage: 可选背景图绝对路径（竖图），将做缓慢缩放
   */
  render(req) {
    return new Promise((resolve, reject) => {
      this._queue.push({ req, resolve, reject });
      this._pump();
    });
  }

  async _pump() {
    if (this._running) return;
    this._running = true;
    while (this._queue.length) {
      const job = this._queue.shift();
      try {
        const r = await this._renderOne(job.req);
        job.resolve(r);
      } catch (e) {
        job.reject(e);
      }
    }
    this._running = false;
  }

  _renderOne(req) {
    return new Promise((resolve, reject) => {
      const id = req.id || `vid-${Date.now()}`;
      const duration = Math.max(3, Math.min(10, parseInt(req.duration, 10) || 8));
      const lines = Array.isArray(req.lines) && req.lines.length
        ? req.lines.map(l => this._sanitizeText(l))
        : [this._sanitizeText(req.title || '今日热点')];
      const txtPath = path.join(this.outDir, `${id}.txt`);
      fs.writeFileSync(txtPath, lines.join('\n'), 'utf8');
      const outPath = path.join(this.outDir, `${id}.mp4`);

      const font = this._escColon(this.fontPath);
      const tf = this._escColon(txtPath.replace(/\\/g, '/'));

      // 背景：有背景图则用 scale+zoompan 缓慢推近；否则纯色
      let bgInput, preFilter;
      const bgImage = req.bgImage && fs.existsSync(req.bgImage) ? req.bgImage : null;
      if (bgImage) {
        const bg = this._escColon(bgImage.replace(/\\/g, '/'));
        bgInput = ['-i', bgImage];
        preFilter = `[1:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,zoompan=z='min(zoom+0.0005,1.2)':d=${duration * 30}:s=1080x1920:fps=30,format=yuv420p[vbg]`;
      } else {
        bgInput = ['-f', 'lavfi', '-i', `color=c=0x101418:s=1080x1920:d=${duration}`];
        preFilter = null;
      }

      const drawtext = `drawtext=fontfile='${font}':textfile='${tf}':fontcolor=white:fontsize=58:line_spacing=22:box=1:boxcolor=0x000000@0.38:boxborderw=28:x=(w-text_w)/2:y=(h-text_h)/2`;
      const vf = preFilter ? `${preFilter},${drawtext}` : drawtext;

      const args = [
        '-y',
        ...bgInput,
        '-vf', vf,
        '-t', String(duration),
        '-r', '30',
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-preset', 'veryfast',
        '-movflags', '+faststart',
        outPath
      ];

      this._status(id, req.contentId, { status: 'rendering', duration, filePath: outPath });

      const child = execFile(this.ffmpegPath, args, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || '').slice(-800);
          console.error(`[VideoRender] ${id} 失败:`, err.message);
          this._status(id, req.contentId, { status: 'error', error: msg });
          return reject(new Error(msg || err.message));
        }
        const ok = fs.existsSync(outPath);
        const size = ok ? fs.statSync(outPath).size : 0;
        const rec = this._status(id, req.contentId, {
          status: ok ? 'done' : 'error',
          filePath: outPath,
          videoUrl: `/api/v14/media/video/${id}`,
          size,
          error: ok ? '' : 'output missing'
        });
        console.log(`[VideoRender] ${id} 完成 ${size} bytes`);
        resolve(rec);
      });

      // 超时保护
      const to = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (_) {}
      }, 90000);
      child.on('exit', () => clearTimeout(to));
    });
  }

  _status(id, contentId, patch) {
    const now = new Date().toISOString();
    const existing = this.dataStore.get('video_render', id);
    const rec = Object.assign(
      { id, contentId: contentId || '', createdAt: (existing && existing.createdAt) || now, updatedAt: now },
      existing || {},
      patch,
      { updatedAt: now }
    );
    if (existing) this.dataStore.update('video_render', id, rec);
    else this.dataStore.create('video_render', rec);
    return rec;
  }

  getStatus(id) { return this.dataStore.get('video_render', id); }
  list(opts = {}) {
    return this.dataStore.list('video_render', Object.assign({ sort: 'createdAt', order: 'desc', limit: 50 }, opts));
  }
}

module.exports = { VideoRender, findFfmpeg, findFont };
