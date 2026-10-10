'use strict';
/**
 * content-media-bridge.js — 因果链 S3(content.generated) ↔ content-gen(:3010) 媒体桥接
 *
 * 设计原则（保守接入，零风险）：
 *  1. 不改现有 S3/S4 主流程：只旁路补生成媒体，不介入事件流转与发布队列。
 *  2. 语义隔离：媒体路径写独立列 media_path / media_type / media_status / media_at，
 *     不占用 preview_url（该字段被 saveContentToFile() 写入存档 JSON 路径，语义已混用）。
 *  3. 绝不阻塞因果链：任何失败仅记日志，事件流转不受影响。
 *  4. 零伪造：生成失败则 media_path 保持为空，绝不写入虚构路径。
 *
 * ── 数据源选择（重要）─────────────────────────────────────────────
 * S4 发布阶段从 **DataStore 'content' 模块** 取 status='ready' 的内容入队
 * （见 server.js chainGate.registerExecutor('post.published')），
 * 而 matrix_content_generated 只是并行写入的影子表。
 * 因此桥接以 **DataStore 为主数据源** 扫描并回写，MySQL 作为影子同步
 * （当 content key 为数字时，它恰好等于 matrix_content_generated.id）。
 *
 * ── 触发机制 ─────────────────────────────────────────────────────
 *  · DataStore 扫描器（主）：每 20s 扫一批 status='ready' 且无媒体的内容，
 *    覆盖绝大多数"生成后直接入队、不 emit 事件"的内容。
 *  · MySQL 扫描器（影子）：同步补写影子表，供报表/查询使用。
 *  · content.generated 事件（补充）：覆盖 S3 从影子表读出来 emit 的旧内容。
 *
 * 生成耗时（实测）：图片 ~30s/张；视频 ~5min/条（脚本已截断到 ~28 秒）。
 * 默认只生图（mode=image）；视频需显式开启并设合理 ratio，否则会拖垮吞吐。
 *
 * 用法：
 *   const { ContentMediaBridge } = require('./content-media-bridge.js');
 *   v14Modules.mediaBridge = new ContentMediaBridge({ eventBus, pool, dataStore });
 *   v14Modules.mediaBridge.start();
 */

const http = require('http');

const CONTENT_GEN = {
  host: process.env.CONTENT_GEN_HOST || '127.0.0.1',
  port: Number(process.env.CONTENT_GEN_PORT || 3010),
};

const DEFAULTS = {
  mode: process.env.MSCMS_MEDIA_MODE || 'image',        // 'image' | 'video' | 'off'
  concurrency: Number(process.env.MSCMS_MEDIA_CONCURRENCY || 3),
  // ── 吞吐约束（关键）───────────────────────────────────────────
  // 实测：单张图 ~42s，concurrency=3 → 生成吞吐仅约 4.3 张/分钟；
  //       而内容生成速度约 17 条/分钟（id 708299→708549 用时 15 分钟）。
  // 生成速度远超配图能力，不可能给每条内容都配图 —— 因此：
  //   1) 只扫「最新」的一小批（S4 也是按 created_at desc 取前 N 条发布），
  //      保证有限产能优先服务于最可能被发布的内容；
  //   2) 队列保持较小（16），积压时丢弃新任务而非无限堆积，避免排队过久全部超时。
  // 队列刻意保持小（8）：生成吞吐 4.3 张/分钟，队列越长，队首任务等待越久，
  // 等生成完时 S4 早已取走更新的内容发布 → 队列宜短、宜新。
  maxQueue: Number(process.env.MSCMS_MEDIA_MAX_QUEUE || 8),
  videoRatio: Number(process.env.MSCMS_MEDIA_VIDEO_RATIO || 0), // 0 = 不生成视频
  minQuality: Number(process.env.MSCMS_MEDIA_MIN_QUALITY || 0),
  // 单图实测 42s，但并发排队时可能达数分钟；放宽到 5 分钟避免误杀在途任务
  imageTimeoutMs: Number(process.env.MSCMS_MEDIA_IMG_TIMEOUT || 300000),  // 5 min
  videoTimeoutMs: Number(process.env.MSCMS_MEDIA_VID_TIMEOUT || 1800000), // 30 min

  // ── 扫描器 ──
  scanEnabled: process.env.MSCMS_MEDIA_SCAN !== '0',
  scanIntervalMs: Number(process.env.MSCMS_MEDIA_SCAN_MS || 20000),
  scanBatch: Number(process.env.MSCMS_MEDIA_SCAN_BATCH || 2),           // DataStore 每轮取多少条
  dbScanBatch: Number(process.env.MSCMS_MEDIA_DB_SCAN_BATCH || 2),      // MySQL 每轮取多少条
  dbScanWindowHours: Number(process.env.MSCMS_MEDIA_DB_SCAN_H || 24),
};

/** 路径规范化：统一为正斜杠，便于下游 fs.existsSync 与 LIKE 匹配一致 */
function normPath(p) {
  return String(p || '').replace(/\\/g, '/');
}

/**
 * 调用 content-gen(:3010) /api/generate
 * @returns {Promise<Object>} 解析后的 JSON（{ok, asset} 或 {ok:false, error}）
 */
function generateAsset(type, prompt, timeoutMs) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ type, prompt });
    const req = http.request(
      {
        hostname: CONTENT_GEN.host,
        port: CONTENT_GEN.port,
        path: '/api/generate',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => { d += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('bad JSON: ' + d.slice(0, 200))); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`content-gen timeout ${timeoutMs}ms`)));
    req.write(body);
    req.end();
  });
}

class ContentMediaBridge {
  /**
   * @param {object} deps
   * @param {object} deps.eventBus 事件总线（可选）
   * @param {object} deps.pool     MySQL 连接池（可选）
   * @param {object} deps.dataStore DataStore（主数据源，强烈建议注入）
   * @param {object} opts 覆盖 DEFAULTS
   */
  constructor(deps = {}, opts = {}) {
    this.eventBus = deps.eventBus || null;
    this.pool = deps.pool || null;
    this.dataStore = deps.dataStore || null;
    this.cfg = Object.assign({}, DEFAULTS, opts);
    this.queue = [];
    this.active = 0;
    this.running = false;
    this._scanTimer = null;
    this.stats = {
      attempted: 0, ok: 0, failed: 0, skipped: 0, dropped: 0,
      dsScanned: 0, dbScanned: 0, scanRounds: 0, eventIn: 0,
    };
  }

  start() {
    if (this.running) return this;
    if (!this.pool && !this.dataStore) {
      console.warn('[media-bridge] 无 MySQL 连接池且无 DataStore，未启用');
      return this;
    }
    this.running = true;

    // 触发源 1：S3 emit 事件（覆盖从影子表读出来 emit 的旧内容）
    if (this.eventBus && typeof this.eventBus.on === 'function') {
      this.eventBus.on('content.generated', 'content-media-bridge', (data) => {
        this.stats.eventIn += 1;
        this.enqueue({ content_id: data && data.content_id, source: 'event' });
      });
    }

    // 触发源 2 + 3：扫描器
    if (this.cfg.scanEnabled) this._startScanner();

    console.log(
      `[media-bridge] attached — mode=${this.cfg.mode} concurrency=${this.cfg.concurrency} ` +
      `videoRatio=${this.cfg.videoRatio} scan=${this.cfg.scanEnabled ? this.cfg.scanIntervalMs + 'ms' : 'off'} ` +
      `dataStore=${!!this.dataStore} pool=${!!this.pool} → ${CONTENT_GEN.host}:${CONTENT_GEN.port}`
    );
    return this;
  }

  stop() {
    this.running = false;
    if (this._scanTimer) { clearTimeout(this._scanTimer); this._scanTimer = null; }
    return this;
  }

  // ────────────────────────────────────────────────
  // 扫描器
  // ────────────────────────────────────────────────

  _startScanner() {
    const tick = async () => {
      if (!this.running) return;
      try {
        await this.scanDataStore();
        await this.scanDatabase();
      } catch (e) {
        if (this.stats.scanRounds < 3) console.warn(`[media-bridge] scan error: ${e.message}`);
      }
      if (this.running) this._scanTimer = setTimeout(tick, this.cfg.scanIntervalMs);
    };
    // 首轮延迟 20s，避开服务启动期的密集初始化
    this._scanTimer = setTimeout(tick, 20000);
  }

  /**
   * 主扫描：DataStore 'content'（S4 的读取源）
   * 取最近 status='ready' 的内容，挑出尚无媒体的入队。
   */
  async scanDataStore() {
    if (this.cfg.mode === 'off' || !this.dataStore) return 0;
    if (this.queue.length >= this.cfg.maxQueue) return 0;
    this.stats.scanRounds += 1;

    const take = Math.max(0, this.cfg.scanBatch - this.queue.length);
    if (take === 0) return 0;

    let items = [];
    try {
      // 只取最新 20 条：S4 同样按 created_at desc 取前 N 条发布，
      // 产能有限时必须优先服务「最可能被发布」的内容，而不是泛泛地补历史数据。
      const res = this.dataStore.list('content', { filter: { status: 'ready' }, limit: 20, sort: 'created_at', order: 'desc' });
      items = (res && res.items) ? res.items : (Array.isArray(res) ? res : []);
    } catch (e) {
      return 0;
    }
    if (!items.length) return 0;

    let claimed = 0;
    for (const c of items) {
      if (claimed >= take) break;
      if (!c || !c.id) continue;
      if (c.media_path) continue;                       // 已有媒体
      if (c.media_status === 'failed' || c.media_status === 'skipped') continue; // 不再重试
      if (c.media_status === 'pending') continue;       // 已在处理

      // 乐观占位：先标 pending，避免扫描器/事件重复处理同一条
      try {
        this.dataStore.update('content', c.id, { media_status: 'pending' });
      } catch (_) { continue; }
      claimed += 1;
      this.enqueue({ content_id: c.id, source: 'ds-scan', row: c });
    }
    if (claimed) this.stats.dsScanned += claimed;
    return claimed;
  }

  /**
   * 影子扫描：matrix_content_generated（供报表/查询使用）
   * 只处理 DataStore 扫描覆盖不到的历史数据（created_at 在窗口内、无媒体、未标记）。
   */
  async scanDatabase() {
    if (this.cfg.mode === 'off' || !this.pool) return 0;
    if (this.queue.length >= this.cfg.maxQueue) return 0;

    const take = Math.max(0, this.cfg.dbScanBatch - this.queue.length);
    if (take === 0) return 0;

    let rows = [];
    try {
      const [r] = await this.pool.query(
        `SELECT id, title, platform, quality_score
           FROM matrix_content_generated
          WHERE media_status IS NULL
            AND (media_path IS NULL OR media_path = '')
            AND created_at >= NOW() - INTERVAL ? HOUR
          ORDER BY id DESC
          LIMIT ?`,
        [this.cfg.dbScanWindowHours, take]
      );
      rows = r || [];
    } catch (_) { return 0; }
    if (!rows.length) return 0;

    let claimed = 0;
    for (const row of rows) {
      try {
        const [res] = await this.pool.query(
          `UPDATE matrix_content_generated SET media_status = 'pending'
            WHERE id = ? AND media_status IS NULL`,
          [row.id]
        );
        if (res && res.affectedRows > 0) {
          claimed += 1;
          this.enqueue({ content_id: row.id, source: 'db-scan' });
        }
      } catch (_) { /* 单行失败不影响其余 */ }
    }
    if (claimed) this.stats.dbScanned += claimed;
    return claimed;
  }

  // ────────────────────────────────────────────────
  // 队列
  // ────────────────────────────────────────────────

  enqueue(data) {
    if (this.cfg.mode === 'off') return;
    if (!data || data.content_id === undefined || data.content_id === null) return;

    // 队列满 → 丢弃「最旧」任务而非新任务。
    // 原因：S4 按 created_at desc 取最新内容发布，最新内容的配图价值远高于
    //       已在队尾排队数分钟的旧内容。若丢弃新任务，最新内容将永远无图。
    // 被丢弃的旧任务复位为未处理，后续扫描窗口覆盖到时会重新入队。
    if (this.queue.length >= this.cfg.maxQueue) {
      const dropped = this.queue.shift();
      this.stats.dropped += 1;
      this._resetPending(dropped && dropped.content_id);
    }
    this.queue.push(data);
    this.pump();
  }

  /** 复位「已认领但未完成」的标记，使其可被后续扫描重新拾取 */
  _resetPending(contentId) {
    if (!contentId) return;
    if (this.dataStore) {
      try {
        const rec = this.dataStore.get('content', contentId);
        if (rec && rec.media_status === 'pending' && !rec.media_path) {
          this.dataStore.update('content', contentId, { media_status: null });
        }
      } catch (_) { /* ignore */ }
    }
    if (this.pool && /^\d+$/.test(String(contentId))) {
      this.pool.query(
        `UPDATE matrix_content_generated SET media_status = NULL
          WHERE id = ? AND media_status = 'pending' AND (media_path IS NULL OR media_path = '')`,
        [contentId]
      ).catch(() => {});
    }
  }

  pump() {
    while (this.active < this.cfg.concurrency && this.queue.length > 0) {
      const item = this.queue.shift();
      this.active += 1;
      this.process(item)
        .catch(() => { /* 已在 process 内捕获，这里只兜底 */ })
        .finally(() => { this.active -= 1; this.pump(); });
    }
  }

  /** 取内容记录：优先 DataStore，回退 MySQL */
  async _loadRow(contentId) {
    if (this.dataStore) {
      try {
        const rec = this.dataStore.get('content', contentId);
        if (rec) return { rec, src: 'ds' };
      } catch (_) { /* fall through */ }
    }
    if (this.pool && /^\d+$/.test(String(contentId))) {
      try {
        const [rows] = await this.pool.query(
          'SELECT id, title, platform, quality_score, media_path, media_status FROM matrix_content_generated WHERE id = ?',
          [contentId]
        );
        if (rows && rows[0]) return { rec: rows[0], src: 'db' };
      } catch (_) { /* ignore */ }
    }
    return { rec: null, src: null };
  }

  /** 用内容标题作生图 prompt，标题缺失时降级为平台占位描述 */
  buildPrompt(row) {
    const title = (row.title || '').trim();
    if (title) return title.slice(0, 300);
    return `${row.platform || 'social'} content visual`;
  }

  async process(data) {
    const contentId = data && data.content_id;
    try {
      const { rec: row } = data.row ? { rec: data.row } : await this._loadRow(contentId);
      if (!row) return;

      // 幂等：已有媒体的不再生成
      if (row.media_path && String(row.media_path).trim()) { this.stats.skipped += 1; return; }
      // 质量门槛（0 = 不过滤）
      if (this.cfg.minQuality > 0 && Number(row.quality_score || 0) < this.cfg.minQuality) {
        this.stats.skipped += 1;
        await this._writeResult(contentId, null, 'skipped');
        return;
      }

      const useVideo = this.cfg.mode === 'video'
        || (this.cfg.videoRatio > 0 && Math.random() < this.cfg.videoRatio);
      const type = useVideo ? 'video' : 'image';
      const prompt = this.buildPrompt(row);

      this.stats.attempted += 1;
      const res = await generateAsset(
        type, prompt,
        type === 'video' ? this.cfg.videoTimeoutMs : this.cfg.imageTimeoutMs
      );

      // 零伪造：只有真实落盘路径才回写
      const localPath = res && res.ok && res.asset && res.asset.localPath;
      if (!localPath) {
        this.stats.failed += 1;
        await this._writeResult(contentId, null, 'failed');
        console.warn(`[media-bridge] content ${contentId} 生成失败: ${(res && res.error) || 'no localPath'}`);
        return;
      }

      const p = normPath(localPath);
      await this._writeResult(contentId, p, 'ready', type);
      this.stats.ok += 1;
      console.log(`[media-bridge] content ${contentId} ← ${type} ${p}`);
    } catch (e) {
      this.stats.failed += 1;
      try { await this._writeResult(contentId, null, 'failed'); } catch (_) {}
      console.warn(`[media-bridge] content ${contentId} error: ${e.message}`);
    }
  }

  /**
   * 回写结果：DataStore（主，供 S4 读取）+ MySQL（影子，供报表查询）。
   * 两侧任一侧失败都不影响另一侧，也不影响主链路。
   */
  async _writeResult(contentId, mediaPath, status, mediaType) {
    const patch = {
      media_status: status,
      media_at: new Date().toISOString(),
    };
    if (mediaPath) {
      patch.media_path = mediaPath;
      patch.media_type = mediaType || (/\.mp4$/i.test(mediaPath) ? 'video' : 'image');
    }

    // DataStore（主数据源）
    if (this.dataStore) {
      try { this.dataStore.update('content', contentId, patch); } catch (_) {}
    }
    // MySQL 影子表（仅当 key 为数字时匹配 id）
    if (this.pool && /^\d+$/.test(String(contentId))) {
      try {
        await this.pool.query(
          `UPDATE matrix_content_generated
              SET media_status = ?, media_at = NOW()
                  ${mediaPath ? ', media_path = ?, media_type = ?' : ''}
            WHERE id = ?`,
          mediaPath ? [status, mediaPath, patch.media_type, contentId] : [status, contentId]
        );
      } catch (_) {}
    }
  }

  // ────────────────────────────────────────────────
  // 供发布器调用：发布前等待媒体就绪
  // ────────────────────────────────────────────────

  /**
   * 等待指定内容的媒体就绪（轮询 DataStore + MySQL）。
   * 发布器在执行前调用；超时返回 null，调用方据此降级为纯文本发布，绝不阻塞链路。
   *
   * @param {string|number} contentId DataStore content key（数字时等于 matrix 表 id）
   * @param {number} timeoutMs 最长等待（默认 60s）
   * @returns {Promise<{path:string,type:string}|null>}
   */
  async waitForMedia(contentId, timeoutMs = 60000) {
    if (contentId === undefined || contentId === null) return null;
    const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
    // do-while：timeoutMs=0 时仍执行一次查询（供发布器做「只查一次、不等待」用）
    do {
      try {
        const { rec } = await this._loadRow(contentId);
        if (rec) {
          if (rec.media_path) {
            const p = normPath(rec.media_path);
            return { path: p, type: rec.media_type || (/\.mp4$/i.test(p) ? 'video' : 'image') };
          }
          // 已判定失败/跳过 → 不再等待
          if (rec.media_status === 'failed' || rec.media_status === 'skipped') return null;
        }
      } catch (_) { /* 查询失败则继续重试直到超时 */ }
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 2000));
    } while (Date.now() < deadline);
    return null;
  }

  status() {
    return {
      enabled: this.cfg.mode !== 'off' && (!!this.pool || !!this.dataStore),
      mode: this.cfg.mode,
      queue: this.queue.length,
      active: this.active,
      scanning: !!this._scanTimer,
      sources: { dataStore: !!this.dataStore, mysql: !!this.pool },
      stats: Object.assign({}, this.stats),
      cfg: {
        concurrency: this.cfg.concurrency,
        videoRatio: this.cfg.videoRatio,
        scanIntervalMs: this.cfg.scanIntervalMs,
        scanBatch: this.cfg.scanBatch,
      },
      contentGen: `http://${CONTENT_GEN.host}:${CONTENT_GEN.port}`,
    };
  }
}

module.exports = { ContentMediaBridge, generateAsset, normPath, DEFAULTS, CONTENT_GEN };
