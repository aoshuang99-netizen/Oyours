'use strict';
/**
 * video-scheduler.js — 视频调度器（P3-C2）
 *
 * 职责：按日定额，从内容库挑出「适合做视频」的内容，串行渲染成短视频。
 *      渲染本身交给 video-render.js（ffmpeg 直渲）；落库与内容回写由既有链路完成：
 *        video-render.js  →  写 DataStore 'video_render'（含 P3-C5 质检结果）
 *        server.js:2384   →  订阅 'render:done'，回写 content.content_type='video' / media_path
 *
 * 依据（方案「内容闭环」§6.3 C2 / §6.5 风险提示）：
 *  - 选题：标题/主题/标签命中「视频适合清单」（教程 / 清单 / 对比 / 演示）
 *  - 定额：每日 N 条（env MSCMS_VIDEO_DAILY_QUOTA，默认 12）
 *  - 低峰：仅在 MSCMS_VIDEO_WINDOW（默认 01:00-06:00）内渲染，避免与 3002/3005/MySQL 抢 CPU
 *  - 并发 = 1：video-render.js 内部就是串行队列（_pump），此处顺序 await 即可
 *
 * 为什么默认走 ffmpeg 而不是 MPT（2026-09-17 实测基线）：
 *  - ffmpeg 直渲：9.7s/条、0.7 核、~51KB、写 video_render 记录 → 直接满足 P3 验收
 *  - MPT        ：单是 LLM 脚本生成就要 2.5~57s，成品实测需分钟级，且产物不写 video_render
 *  故 MPT 定位为「人工挑选重点内容的精修路径」，不进日常调度。
 *
 * 环境变量：
 *  MSCMS_VIDEO_ENABLED      默认 1        总开关
 *  MSCMS_VIDEO_DAILY_QUOTA  默认 12       每日定额
 *  MSCMS_VIDEO_WINDOW       默认 01:00-06:00  允许渲染的时间窗（本地时间，支持跨零点如 23:00-06:00）
 *  MSCMS_VIDEO_DURATION     默认 15       单条时长秒（C5 质检要求 5~60）
 *  MSCMS_VIDEO_TICK_MS      默认 900000   调度间隔（15min）
 *  MSCMS_VIDEO_BATCH        默认 4        单次 tick 最多渲染条数
 *  MSCMS_VIDEO_SCAN_LIMIT   默认 800      单次扫描内容库条数
 */
const fs = require('fs');

const DEFAULTS = Object.freeze({
  enabled: true,
  dailyQuota: 12,
  window: '01:00-06:00',
  duration: 15,
  tickMs: 15 * 60 * 1000,
  batch: 4,
  scanLimit: 800,
  maxAttempts: 3,
});

/**
 * 「适合做视频」的选题特征。
 * 只作用于 title / topic / tags —— 不扫 body，否则任何长文都会命中，等于没筛。
 */
const VIDEO_SUITABLE = [
  /\bhow\s+to\b/i, /\bguide\b/i, /\b\b/i, /\bstep[-\s]?by[-\s]?step\b/i,
  /\btips?\b/i, /\bchecklist\b/i, /\blist\b/i, /\btop\s*\d/i, /\bbest\b/i,
  /\bvs\.?\b/i, /\bversus\b/i, /\bcompar/i, /\bdifference\b/i, /\bdiff\b/i,
  /\bdemo\b/i, /\bwalkthrough\b/i, /\bexplain/i, /\bwhat\s+is\b/i, /\bwhy\b/i,
  /\breasons?\b/i, /\bways?\b/i, /\bmistakes?\b/i, /\bbeginner/i, /\bessentials?\b/i,
  /\breview\b/i, /\bbreakdown\b/i, /\branking\b/i, /\bsigns?\b/i, /\brules?\b/i,
];

 localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
 localDateOf(iso) {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : localDate(d);
}

/** 把长句按词边界折行到 width 字符（drawtext 不自动折行，超宽会被裁掉） */
 wrap(text, width = 34, maxLines = 3) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const token = w.length > width ? w.slice(0, width) : w;
    if (!cur) { cur = token; continue; }
    if ((cur + ' ' + token <= width) cur += ' ' + token;
    else {
      lines.push(cur);
      if (lines.length >= maxLines) return lines;
      cur = token;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  return lines;
}

class VideoScheduler {
  constructor({ dataStore, videoRender, logger, opts = {} } = {}) {
    if (!dataStore) throw new Error('VideoScheduler: dataStore required');
    if (!videoRender) throw new Error('VideoScheduler: videoRender required');
    this.ds = dataStore;
    this.vr = videoRender;
    this.log = logger || ((m) => console.log('[VideoScheduler] ' + m));
    this.warn = (m) => console.warn('[VideoScheduler] ' + m);

    const env = process.env;
    this.opts = Object.assign({}, DEFAULTS, {
      enabled: env.MSCMS_VIDEO_ENABLED !== '0' && env.MSCMS_VIDEO_ENABLED !== 'false',
      dailyQuota: parseInt(env.MSCMS_VIDEO_DAILY_QUOTA || '', 10) || DEFAULTS.dailyQuota,
      window: env.MSCMS_VIDEO_WINDOW || DEFAULTS.window,
      duration: parseInt(env.MSCMS_VIDEO_DURATION || '', 10) || DEFAULTS.duration,
      tickMs: parseInt(env.MSCMS_VIDEO_TICK_MS || '', 10) || DEFAULTS.tickMs,
      batch: parseInt(env.MSCMS_VIDEO_BATCH || '', 10) || DEFAULTS.batch,
      scanLimit: parseInt(env.MSCMS_VIDEO_SCAN_LIMIT || '', 10) || DEFAULTS.scanLimit,
    }, opts);

    this._timer = null;
    this._attempts = new Map();   // contentId -> 尝试次数（进程内；重启归零可接受）
    this._lastResult = null;
    this._running = false;
  }

  // ── 时间窗 ────────────────────────────────────────────────
  _inWindow(now = new Date()) {
    const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(this.opts.window).trim());
    if (!m) return true;                      // 配置不合法则不限制，避免整条链路静默停摆
    const cur = now.getHours() * 60 + now.getMinutes();
    const s = (+m[1]) * 60 + (+m[2]);
    const e = (+m[3]) * 60 + (+m[4]);
    return s <= e ? (cur >= s && cur <= e) : (cur >= s || cur <= e);  // 支持跨零点
  }

  _todayDone() {
    const today = localDate();
    let r;
    try { r = this.ds.list('video_render', { limit: 100000 }); } catch (_) { return 0; }
    const items = (r && (r.items || (Array.isArray(r) ? r : []))) || [];
    return items.filter((x) => x && x.status === 'done' && localDateOf(x.createdAt) === today;
  }

  // ── 选题 ──────────────────────────────────────────────────
  _isVideoSuitable(c) {
    const hay = [c.title, c.topic, Array.isArray(c.tags) ? c.tags.join(' ') : ''].filter(Boolean).join(' ');
    if (!hay) return false;
    return VIDEO_SUITABLE.some((re) => re.test(hay));
  }

  /**
   * 选出待渲染内容。
   * 跳过条件（按优先级）：正文过短 / 已是视频 / 已有 done 或 rejected 记录 / error 超次数 / 不适合视频
   */
  selectCandidates(limit = 4) {
    let r;
    try {
      r = this.ds.list('content', { filter: { status: 'ready' }, sort: 'createdAt', order: 'desc', limit: this.opts.scanLimit });
    } catch (e) { this.warn('扫描内容库失败: ' + e.message); return []; }
    const items = (r && (r.items || (Array.isArray(r) ? r : []))) || [];
    const out = [];
    for (const c of items) {
      if (!c || !c.id) continue;
      const body = String(c.body || '').trim();
      if (body.length < 40) continue;
      if (c.content_type === 'video') continue;
      let vr = null;
      try { vr = this.ds.get('video_render', c.id); } catch (_) { /* ignore */ }
      if (vr && (vr.status === 'done' || vr.status === 'rejected')) continue;
      if (vr && vr.status === 'error' && (this._attempts.get(c.id) || 0) >= this.opts.maxAttempts) continue;
      if (!this._isVideoSuitable(c)) continue;
      out.push(c);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** 内容 → drawtext 行（标题 + 正文前几句），已按画面宽度折行 */
  buildLines(c) {
    const out = [];
    const title = String(c.title || '').trim();
    if (title) out.push(...wrap(title, 30, 2));
    const body = String(c.body || '').replace(/\s+/g, ' ').trim();
    const sents = body.split(/(?<=[.!?])\s+/).filter((s) => s.trim( > 8).slice(0, 4);
    for (const s of sents) {
      out.push(...wrap(s, 34, 2));
      if (out.length >= 8) break;
    }
    return out.slice(0, 8);
  }

  // ── 调度 ──────────────────────────────────────────────────
  async tick(opts = {}) {
    if (this._running) return { skipped: 'busy' };
    if (!this.opts.enabled && !opts.force) return { skipped: 'disabled' };
    const now = new Date();
    if (!opts.force && !this._inWindow(now)) return { skipped: 'outside_window', window: this.opts.window };

    const done = this._todayDone();
    const quota = opts.quota || this.opts.dailyQuota;
    if (done >= quota && !opts.force) return { skipped: 'quota_reached', done, quota };

    const limit = opts.limit || Math.min(this.opts.batch, Math.max(1, quota - done));
    const cands = this.selectCandidates(limit);
    if (!cands.length) {
      const res = { skipped: 'no_candidates', done, quota, scanned: this.opts.scanLimit };
      this._lastResult = Object.assign({ at: now.toISOString() }, res);
      return res;
    }

    this._running = true;
    const rendered = [];
    try {
      for (const c of cands) {
        this._attempts.set(c.id, (this._attempts.get(c.id) || 0) + 1);
        try {
          const rec = await this.vr.render({
            id: c.id,
            contentId: c.id,
            title: c.title || '',
            lines: this.buildLines(c),
            duration: opts.duration || this.opts.duration,
          });
          rendered.push({
            id: c.id, status: rec.status, size: rec.size || 0,
            qc: rec.quality ? rec.quality.reason : null,
            title: String(c.title || '').slice(0, 50),
          });
          this.log(`${c.id} → ${rec.status} (${((rec.size || 0) / 1024).toFixed(1)}KB, qc=${rec.quality ? rec.quality.reason : 'n/a'})`);
        } catch (e) {
          rendered.push({ id: c.id, status: 'throw', error: e.message });
          this.warn(`${c.id} 渲染异常: ${e.message}`);
        }
      }
    } finally {
      this._running = false;
    }

    const res = { done, quota, rendered, ok: rendered.filter((x) => x.status === 'done' };
    this._lastResult = Object.assign({ at: new Date().toISOString() }, res);
    return res;
  }

  start() {
    if (this._timer) return this.stats();
    this._timer = setInterval(() => {
      this.tick().catch((e) => this.warn('tick 异常: ' + e.message));
    }, this.opts.tickMs);
    if (this._timer.unref) this._timer.unref();
    this.log(`已启动 · 定额 ${this.opts.dailyQuota}/天 · 时间窗 ${this.opts.window} · 每 ${(this.opts.tickMs / 60000).toFixed(0)}min 检查 · 单次≤${this.opts.batch} 条`);
    return this.stats();
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  stats() {
    return {
      enabled: this.opts.enabled,
      running: !!this._timer,
      window: this.opts.window,
      inWindow: this._inWindow(),
      dailyQuota: this.opts.dailyQuota,
      todayDone: this._todayDone(),
      duration: this.opts.duration,
      tickMs: this.opts.tickMs,
      batch: this.opts.batch,
      attemptsTracked: this._attempts.size,
      lastResult: this._lastResult,
    };
  }
}

module.exports = { VideoScheduler, VIDEO_SUITABLE, wrap, localDate };
