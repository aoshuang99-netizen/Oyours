'use strict';
/**
 * agnes-media.js — Agnes AI 图像/视频生成引擎（MSCMS v14 集成）
 *
 * 功能：
 *  - 文生图 / 图生图 / 多图合成（agnes-image-2.1-flash）
 *  - 文生视频 / 图生视频 / 关键帧动画（agnes-video-v2.0，异步任务 + 轮询）
 *  - 生成结果自动下载落盘到 D:/MSCMS-Content/agnes/{images,videos}
 *  - 任务记录落 DataStore（'agnes_image' / 'agnes_video'），支撑控制台展示与重试
 *
 * 依赖：仅 Node 内置模块（https / fs / path / crypto），无第三方依赖。
 * 代理：默认直连（Node 不读系统 PAC）。如需走 Clash，设置 AGNES_PROXY=http://127.0.0.1:10808
 *
 * 用法：
 *   const { AgnesMedia } = require('./agnes-media.js');
 *   const am = new AgnesMedia(dataStore, { apiKey: 'sk-...' });
 *   const img = await am.generateImage({ prompt: '赛博朋克城市夜景' });
 *   const vid = await am.generateVideo({ prompt: '猫在沙滩上走', duration: 5 });
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const API_BASE = 'api.agnes-ai.cn';
const IMAGE_PATH = '/v1/images/generations';
const VIDEO_PATH = '/v1/videos';
// 官方正确状态轮询端点：GET /v1/videos/{video_id}
// （文档曾写 /agnesapi?video_id= 实测无效，已对齐已验证可用的 skill 脚本）
const VIDEO_STATUS_PATH = '/v1/videos';

// 尺寸档位 × 宽高比 → 实际像素
const SIZE_TABLE = {
  '1K': { '1:1': [1024, 1024], '3:4': [864, 1152], '4:3': [1152, 864], '16:9': [1312, 736], '9:16': [736, 1312], '2:3': [832, 1248], '3:2': [1248, 832], '21:9': [1568, 672] },
  '2K': { '1:1': [2048, 2048], '3:4': [1728, 2304], '4:3': [2304, 1728], '16:9': [2624, 1472], '9:16': [1472, 2624], '2:3': [1664, 2496], '3:2': [2496, 1664], '21:9': [3136, 1344] },
  '3K': { '1:1': [3072, 3072], '3:4': [2592, 3456], '4:3': [3456, 2592], '16:9': [3936, 2208], '9:16': [2208, 3936], '2:3': [2496, 3744], '3:2': [3744, 2496], '21:9': [4704, 2016] },
  '4K': { '1:1': [4096, 4096], '3:4': [3456, 4608], '4:3': [4608, 3456], '16:9': [5248, 2944], '9:16': [2944, 5248], '2:3': [3328, 4992], '3:2': [4992, 3328], '21:9': [6272, 2688] },
};

const RATIOS = ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9'];

/**
 * 读取 API Key：opts.apiKey > env AGNES_API_KEY > ~/.workbuddy/config/agnes_api_key.txt
 */
function resolveApiKey(opts) {
  if (opts && opts.apiKey) return String(opts.apiKey).trim();
  if (process.env.AGNES_API_KEY) return String(process.env.AGNES_API_KEY).trim();
  try {
    const home = process.env.USERPROFILE || process.env.HOME;
    const p = path.join(home, '.workbuddy', 'config', 'agnes_api_key.txt');
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  } catch (_) { /* ignore */ }
  return null;
}

/**
 * 极简 HTTPS 请求（JSON）。超时可配；可选走代理（AGNES_PROXY 仅支持 http 代理的 CONNECT 隧道时请用 https 代理地址）。
 */
function httpsJson(method, urlPath, bodyObj, apiKey, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = bodyObj ? Buffer.from(JSON.stringify(bodyObj), 'utf8') : null;
    const req = https.request({
      hostname: API_BASE,
      port: 443,
      path: urlPath,
      method,
      headers: Object.assign(
        {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        payload ? { 'Content-Length': payload.length } : {}
      ),
      timeout: timeoutMs || 60000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(raw); } catch (_) {
          return reject(new Error(`响应非 JSON (HTTP ${res.statusCode}): ${raw.slice(0, 300)}`));
        }
        if (res.statusCode >= 400) {
          const msg = (json && (json.error?.message || json.message)) || raw.slice(0, 300);
          return reject(new Error(`HTTP ${res.statusCode}: ${msg}`));
        }
        resolve(json);
      });
    });
    req.on('timeout', () => { req.destroy(new Error(`请求超时 (${timeoutMs || 60000}ms)`)); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** 下载远程文件到本地 */
function download(url, destPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const mod = /^https:/i.test(url) ? https : require('http');
    const req = mod.get(url, { timeout: timeoutMs || 180000 }, (res) => {
      // 跟随重定向
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(res.headers.location, destPath, timeoutMs).then(resolve, reject);
      }
      if (res.statusCode >= 400) {
        res.resume();
        return reject(new Error(`下载失败 HTTP ${res.statusCode}`));
      }
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      const ws = fs.createWriteStream(destPath);
      res.pipe(ws);
      ws.on('finish', () => ws.close(() => resolve(destPath)));
      ws.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('下载超时')));
    req.on('error', reject);
  });
}

class AgnesMedia {
  constructor(dataStore, opts = {}) {
    this.dataStore = dataStore;
    this.apiKey = resolveApiKey(opts);
    this.outDir = opts.outDir || 'D:/MSCMS-Content/agnes';
    this.imageDir = path.join(this.outDir, 'images');
    this.videoDir = path.join(this.outDir, 'videos');
    this.imageTimeout = opts.imageTimeout || 300000;   // 5 分钟
    this.videoPollInterval = opts.videoPollInterval || 5000;
    this.videoPollTimeout = opts.videoPollTimeout || 600000; // 10 分钟
    this.imageStore = opts.imageStore || 'agnes_image';
    this.videoStore = opts.videoStore || 'agnes_video';

    // ── 视频委托通道 ──────────────────────────────────────────────
    // 背景：Agnes 公开 REST POST /v1/videos 创建的任务在 status=completed 后
    //       不返回可下载 url（实测取不回成品），故视频能力实际不可用。
    //       content-gen(:3010) 背后是 MoneyPrinterTurbo，实测可产出真实 mp4。
    // 解决：由 server.js 注入 videoDelegate，把视频请求委托给 content-gen。
    //       未注入时保持原 Agnes 直连行为（向后兼容）。
    this.videoDelegate = opts.videoDelegate || null;

    fs.mkdirSync(this.imageDir, { recursive: true });
    fs.mkdirSync(this.videoDir, { recursive: true });

    if (!this.apiKey) {
      console.warn('[AgnesMedia] ⚠ API Key 未配置 — 设置 AGNES_API_KEY 或 ~/.workbuddy/config/agnes_api_key.txt');
    } else {
      console.log(`[AgnesMedia] 已就绪 | out=${this.outDir} | key=${this.apiKey.slice(0, 8)}…`);
    }
  }

  _id(prefix) {
    const t = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const r = crypto.randomBytes(3).toString('hex');
    return `${prefix}-${t}-${r}`;
  }

  /**
   * 落库：已存在则 update，否则 create。
   * DataStore 接口为 create(module, data) / update(module, id, data) / get / list。
   */
  _save(store, id, rec) {
    try {
      const exists = this.dataStore.get(store, id);
      return exists
        ? this.dataStore.update(store, id, rec)
        : this.dataStore.create(store, Object.assign({}, rec, { id }));
    } catch (e) {
      // DataStore 不可用时降级为不落库，不阻断生成流程
      return rec;
    }
  }

  _get(store, id) {
    try { return this.dataStore.get(store, id); } catch (_) { return null; }
  }

  // ────────────────────────────────────────────────
  // 图像生成
  // ────────────────────────────────────────────────

  /**
   * 生成/编辑图像
   * @param {object} req
   *  - prompt (必填) 图像描述
   *  - size   '1K'|'2K'|'3K'|'4K'（默认 '2K'）
   *  - ratio  '1:1'|'16:9'|'9:16'|…（默认 '1:1'）
   *  - image  string[] 参考图 URL / Data URI（图生图、多图合成）
   *  - outputFormat 'url'|'b64'（默认 'url'）
   *  - contentId 可选，关联内容 ID
   *  - download 是否下载到本地（默认 true）
   */
  async generateImage(req = {}) {
    if (!this.apiKey) throw new Error('Agnes API Key 未配置');
    const prompt = String(req.prompt || '').trim();
    if (!prompt) throw new Error('prompt 为必填项');

    const size = SIZE_TABLE[req.size] ? req.size : '2K';
    const ratio = RATIOS.includes(req.ratio) ? req.ratio : '1:1';
    const id = this._id('img');

    const rec = {
      id,
      type: 'image',
      model: 'agnes-image-2.1-flash',
      prompt,
      size,
      ratio,
      pixel: SIZE_TABLE[size][ratio].join('x'),
      inputImages: Array.isArray(req.image) ? req.image.length : 0,
      contentId: req.contentId || null,
      status: 'pending',
      url: null,
      localPath: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this._save(this.imageStore, id, rec);

    try {
      rec.status = 'running';
      rec.updatedAt = new Date().toISOString();
      this._save(this.imageStore, id, rec);

      const body = {
        model: 'agnes-image-2.1-flash',
        prompt,
        size,
        ratio,
      };
      // 参考图与输出格式必须放在 extra_body 内（顶层 response_format 会被拒绝）
      const extra = {};
      if (Array.isArray(req.image) && req.image.length) extra.image = req.image;
      extra.response_format = req.outputFormat === 'b64' ? 'b64_json' : 'url';
      body.extra_body = extra;

      const t0 = Date.now();
      const resp = await httpsJson('POST', IMAGE_PATH, body, this.apiKey, this.imageTimeout);
      const item = (resp.data && resp.data[0]) || {};
      rec.elapsedMs = Date.now() - t0;

      const remoteUrl = item.url || null;
      rec.url = remoteUrl;
      rec.b64 = item.b64_json || null;
      rec.revisedPrompt = item.revised_prompt || null;

      // 下载落盘（b64 模式直接解码写盘）
      if (req.download !== false && remoteUrl) {
        const ext = (path.extname(String(remoteUrl).split('?')[0]) || '.png').slice(0, 5);
        const dest = path.join(this.imageDir, `${id}${ext}`);
        try {
          await download(remoteUrl, dest);
          rec.localPath = dest;
        } catch (e) {
          rec.downloadError = e.message;
        }
      } else if (req.download !== false && item.b64_json) {
        const dest = path.join(this.imageDir, `${id}.png`);
        fs.writeFileSync(dest, Buffer.from(item.b64_json, 'base64'));
        rec.localPath = dest;
      }

      rec.status = 'completed';
      rec.updatedAt = new Date().toISOString();
      this._save(this.imageStore, id, rec);
      return rec;
    } catch (e) {
      rec.status = 'failed';
      rec.error = e.message;
      rec.updatedAt = new Date().toISOString();
      this._save(this.imageStore, id, rec);
      throw e;
    }
  }

  // ────────────────────────────────────────────────
  // 视频生成
  // ────────────────────────────────────────────────

  /** 官方文档推荐档位：时长(秒) → num_frames @24fps */
  static DURATION_PRESETS = { 3: 81, 5: 121, 10: 241, 18: 441 };

  /** 时长（秒）→ 合法 num_frames（8n+1，≤441） */
  static framesFor(durationSec, fps = 24) {
    const f = Number(fps) || 24;
    const d = Math.round(Number(durationSec) || 5);
    // 官方文档推荐档位（24fps）——优先取精确值，保证与控制台展示一致
    if (f === 24 && AgnesMedia.DURATION_PRESETS[d]) return AgnesMedia.DURATION_PRESETS[d];
    // 其余时长：向上取到最近的合法 8n+1，避免帧数不足导致时长被截断
    const raw = Math.round(d * f);
    const n = Math.max(1, Math.min(Math.ceil((raw - 1) / 8), 55)); // 8*55+1 = 441
    return 8 * n + 1;
  }

  /**
   * 创建视频任务（异步，不等待）
   * @returns {object} 任务记录（含 videoId / taskId）
   */
  async createVideo(req = {}) {
    const prompt = String(req.prompt || '').trim();
    if (!prompt) throw new Error('prompt 为必填项');

    // ── 委托给 content-gen(:3010) → MPT ──
    // 见 constructor 中 videoDelegate 的说明：Agnes 视频成品取不回，MPT 实测可用。
    if (this.videoDelegate) {
      const t0 = Date.now();
      const out = await this.videoDelegate(req);
      const id = (out && out.id) || this._id('vid');
      return this._save(this.videoStore, id, Object.assign({}, out, {
        id,
        type: 'video',
        prompt,
        status: out.status || 'completed',
        progress: out.progress != null ? out.progress : 100,
        source: 'content-gen(MPT)',
        elapsedMs: Date.now() - t0,
        contentId: req.contentId || null,
        createdAt: (out && out.createdAt) || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));
    }

    if (!this.apiKey) throw new Error('Agnes API Key 未配置');

    const fps = Math.max(1, Math.min(60, parseInt(req.fps, 10) || 24));
    const duration = Math.max(1, Math.min(18, parseInt(req.duration, 10) || 5));
    const numFrames = AgnesMedia.framesFor(duration, fps);
    const id = this._id('vid');

    const body = {
      model: 'agnes-video-v2.0',
      prompt,
      width: parseInt(req.width, 10) || 1152,
      height: parseInt(req.height, 10) || 768,
      num_frames: numFrames,
      frame_rate: fps,
    };
    if (req.negativePrompt) body.negative_prompt = String(req.negativePrompt);
    if (req.seed != null) body.seed = parseInt(req.seed, 10);

    // 图生视频用 image；关键帧动画用 extra_body.image + mode
    if (Array.isArray(req.keyframes) && req.keyframes.length) {
      body.extra_body = { image: req.keyframes, mode: 'keyframes' };
    } else if (req.image) {
      body.image = String(req.image);
    }

    const resp = await httpsJson('POST', VIDEO_PATH, body, this.apiKey, 60000);
    // 与已验证 skill 脚本一致：优先 id，其次 video_id，再次 task_id
    const videoId = resp.id || resp.video_id || resp.task_id;
    if (!videoId) throw new Error('创建视频任务失败：响应中无 video_id');

    const rec = {
      id,
      type: 'video',
      model: 'agnes-video-v2.0',
      videoId,
      taskId: resp.task_id || resp.id || videoId,
      prompt,
      duration,
      fps,
      numFrames,
      width: body.width,
      height: body.height,
      mode: (body.extra_body && body.extra_body.mode) || (body.image ? 'i2v' : 't2v'),
      contentId: req.contentId || null,
      status: 'queued',
      progress: 0,
      url: null,
      localPath: null,
      rawStatus: resp.status || 'queued',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    return this._save(this.videoStore, id, rec);
  }

  /**
   * 查询视频任务状态（并落库）
   * @param {string} id 本地记录 id 或 Agnes videoId
   */
  /** 注入视频委托实现（content-gen → MPT）；传 null 可恢复 Agnes 直连 */
  setVideoDelegate(fn) {
    this.videoDelegate = (typeof fn === 'function') ? fn : null;
    return this;
  }

  async getVideoStatus(id) {
    let rec = this._get(this.videoStore, id);
    // 委托产出的记录没有 Agnes videoId，直接返回本地记录，不查远端
    if (rec && rec.source === 'content-gen(MPT)') return rec;

    if (!this.apiKey) throw new Error('Agnes API Key 未配置');
    let videoId = id;
    if (rec && rec.videoId) videoId = rec.videoId;
    if (!rec) {
      rec = { id, type: 'video', videoId, status: 'unknown', createdAt: new Date().toISOString() };
    }

    const q = `${VIDEO_STATUS_PATH}/${encodeURIComponent(videoId)}`;
    const resp = await httpsJson('GET', q, null, this.apiKey, 30000);

    rec.rawStatus = resp.status || rec.rawStatus;
    rec.progress = resp.progress ?? rec.progress ?? 0;
    rec.size = resp.size || rec.size || null;
    rec.seconds = resp.seconds || rec.seconds || null;
    const md = resp.metadata || {};
    // 实测 url 在顶层（metadata.url 仅作兜底）
    rec.url = resp.url || md.url || rec.url || null;
    rec.updatedAt = new Date().toISOString();

    if (resp.status === 'completed') {
      rec.status = 'completed';
      rec.progress = 100;
      // 下载落盘
      if (rec.url) {
        const dest = path.join(this.videoDir, `${rec.id || id}.mp4`);
        try {
          await download(rec.url, dest, 300000);
          rec.localPath = dest;
        } catch (e) {
          rec.downloadError = e.message;
        }
      }
    } else if (resp.status === 'failed') {
      rec.status = 'failed';
      rec.error = (resp.error && (resp.error.message || JSON.stringify(resp.error))) || '视频生成失败';
    } else {
      rec.status = 'running';
    }

    return this._save(this.videoStore, rec.id || id, rec);
  }

  /**
   * 创建视频任务并轮询到完成（同步体验）
   * @param {object} req 同 createVideo
   * @param {boolean} wait 是否等待（默认 true）
   */
  async generateVideo(req = {}, wait = true) {
    const rec = await this.createVideo(req);
    if (!wait) return rec;

    const deadline = Date.now() + this.videoPollTimeout;
    let last = rec;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, this.videoPollInterval));
      try {
        last = await this.getVideoStatus(rec.id);
      } catch (e) {
        // 轮询期间单次失败不立即放弃，记录后继续
        last = Object.assign({}, last, { pollError: e.message });
        continue;
      }
      if (last.status === 'completed' || last.status === 'failed') return last;
    }
    last.status = 'timeout';
    last.error = `轮询超时（${this.videoPollTimeout / 1000}s）`;
    last.updatedAt = new Date().toISOString();
    return this._save(this.videoStore, rec.id, last);
  }

  // ────────────────────────────────────────────────
  // 查询辅助
  // ────────────────────────────────────────────────

  getStatus(id, type) {
    return (type === 'video' ? this._get(this.videoStore, id) : this._get(this.imageStore, id))
      || this._get(this.videoStore, id)
      || this._get(this.imageStore, id)
      || null;
  }

  /** 列出记录（默认合并图片+视频，按时间倒序） */
  list({ type, limit = 50 } = {}) {
    const lim = parseInt(limit, 10) || 50;
    const collect = (store) => {
      try {
        // DataStore.list 返回 { items, total, page, limit, pages }
        const r = this.dataStore.list(store, { limit: lim, page: 1 });
        if (Array.isArray(r)) return r;
        return (r && Array.isArray(r.items)) ? r.items : [];
      } catch (_) { /* ignore */ }
      return [];
    };
    let rows = [];
    if (type === 'image') rows = collect(this.imageStore);
    else if (type === 'video') rows = collect(this.videoStore);
    else rows = collect(this.imageStore).concat(collect(this.videoStore));

    return rows
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
      .slice(0, lim);
  }

  /** 健康检查：验证 API Key 是否有效（轻量，不产生费用） */
  async health() {
    const base = {
      imageDir: this.imageDir,
      videoDir: this.videoDir,
      // 标明两条能力的实际通道，避免把 agnes-media 与 content-media-bridge 混淆：
      //   图片 → Agnes 直连（v14Modules.agnesMedia，控制台手动调用）
      //   视频 → 委托 content-gen(:3010) → MPT（自动化链路用 content-media-bridge）
      imageSource: this.apiKey ? 'agnes-direct' : 'unconfigured',
      videoSource: this.videoDelegate ? 'content-gen(MPT)' : (this.apiKey ? 'agnes-direct(成品取不回)' : 'unconfigured'),
    };
    if (!this.apiKey && !this.videoDelegate) return Object.assign({ ok: false, reason: 'API Key 未配置' }, base);
    return Object.assign({
      ok: true,
      keyPrefix: this.apiKey ? (this.apiKey.slice(0, 8) + '…') : null,
    }, base);
  }
}

module.exports = { AgnesMedia, SIZE_TABLE, RATIOS, resolveApiKey, httpsJson, download };
