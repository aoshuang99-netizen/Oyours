'use strict';
/**
 * engagement-harvester.js — 真实数据回收（零伪造）
 *
 * 解决「发布后真实数据增长」这一最大缺口：
 *  - Tumblr 官方 /blog/{blog}/posts 接口（带 notes_info）能拿到每条帖子的真实 note_count
 *    （notes = likes + reblogs + replies，是 Tumblr 公开的互动聚合指标）。
 *  - 本模块定时/手动拉取已发布帖的真实 note_count，写入 MySQL matrix_posts_published，
 *    并记录时间序列便于计算「增长 / 加速度」。
 *  - 基于真实指标筛选「正向内容」用于二次创作与跨账号复制。
 *
 * 全部读取走已授权账号的 OAuth token + 该账号出口代理，绝不伪造任何数字。
 */
class EngagementHarvester {
  constructor({ pool, publisher }) {
    this.pool = pool;
    this.publisher = publisher;
    this._timer = null;
    this._running = false;
  }

  /** 幂等建列：note_count / note_baseline（基线，首次观测值）/ note_history（时间序列）/ note_updated_at */
  async ensureColumns() {
    const cols = [
      'ALTER TABLE matrix_posts_published ADD COLUMN note_count INT DEFAULT 0',
      'ALTER TABLE matrix_posts_published ADD COLUMN note_baseline INT DEFAULT 0',
      'ALTER TABLE matrix_posts_published ADD COLUMN note_history JSON DEFAULT NULL',
      'ALTER TABLE matrix_posts_published ADD COLUMN note_updated_at TIMESTAMP NULL DEFAULT NULL'
    ];
    for (const sql of cols) {
      try { await this.pool.query(sql); } catch (e) { /* 已存在则忽略 */ }
    }
  }

  /** 从 post_url 解析 { blogName, postId }（兼容 blog/view 与 legacy 两种格式） */
  _parseUrl(postUrl) {
    if (!postUrl) return null;
    const u = String(postUrl).trim();
    let m = u.match(/tumblr\.com\/blog\/view\/([^/?#]+)\/([^/?#]+)/);
    if (m) return { blogName: m[1], postId: m[2] };
    m = u.match(/([a-z0-9_-]+)\.tumblr\.com\/post\/(\d+)/i);
    if (m) return { blogName: m[1], postId: m[2] };
    m = u.match(/tumblr\.com\/([a-z0-9_-]+)\/post\/(\d+)/i);
    if (m)  return { blogName: m[1], postId: m[2] };
    return null;
  }

  /**
   * 执行一次回收：按 blog 分组，对每个博客调用一次 getBlogPosts（≤50 帖），
   * 将匹配到的本系统帖子 note_count 写回 MySQL。
   * @param {object} opts { maxPerRun }
   * @returns {object} { fetched, updated, errors, blogCalls }
   */
  async harvest({ maxPerRun = 300 } = {}) {
    if (this._running) return { skipped: true, reason: 'already-running' };
    this._running = true;
    const out = { fetched: 0, updated: 0, errors: 0, blogCalls: 0 };
    try {
      const [rows] = await this.pool.query(
        `SELECT id, account_id, post_url, note_count, note_history
         FROM matrix_posts_published
         WHERE ='tumblr' AND post_url IS NOT NULL AND status='published'
         LIMIT ?`,
        [Math.max(1, parseInt(maxPerRun, 10) || 300)]
      );
      // 内存侧优先处理「从未回收过」的帖（note_updated_at 为空），再按时间
      rows.sort((a, b) => (a.note_updated_at ? 1 : 0) - (b.note_updated_at ? 1 : 0));
      // 按博客分组，减少 API 调用
      const byBlog = new Map();
      for (const r of rows) {
        const p = this._parseUrl(r.post_url);
        if (!p) continue;
        if (!byBlog.has(p.blogName)) byBlog.set(p.blogName, []);
        byBlog.get(p.blogName).push({ id: r.id, postId: p.postId, history: r.note_history });
      }
      // 需要一个已授权账号来发起读取（OAuth token 必填）
      const acting = this.publisher._defaultAccountId ? this.publisher._defaultAccountId() : 'main';

      for (const [blogName, items] of byBlog) {
        try {
          const res = await this.publisher.getBlogPosts(blogName, { limit: 50, notesInfo: true }, acting);
          out.blogCalls++;
          const posts = res.posts || [];
          const postMap = new Map();
          for (const p of posts) {
            const idStr = String(p.id_string || p.id);
            postMap.set(idStr, p);
          }
          for (const it of items) {
            const tp = postMap.get(String(it.postId));
            if (!tp) continue;
            let nc = parseInt(tp.note_count, 10);
            if (isNaN(nc)) nc = (tp.notes && tp.notes.count) ? parseInt(tp.notes.count, 10) : 0;
            let hist = [];
            try { hist = JSON.parse(it.history || '[]'); } catch (_) {}
            hist.push({ t: new Date().toISOString().slice(0, 19).replace('T', ' '), n: nc });
            if (hist.length > 60) hist = hist.slice(-60);
            const baseline = hist.length ? hist[0].n : 0;
            await this.pool.query(
              `UPDATE matrix_posts_published SET note_count=?, note_baseline=?, note_history=?, note_updated_at=NOW() WHERE id=?`,
              [nc, baseline, JSON.stringify(hist), it.id]
            );
            out.updated++;
          }
          out.fetched += items.length;
        } catch (e) {
          out.errors++;
          out.lastError = e.message;
        }
        // 博客间轻微间隔，避免 API 速率触发（429 退避已在 _oauthRequest 内处理）
        await new Promise(r => setTimeout(r, 800));
      }
    } catch (e) {
      out.error = e.message;
      out.errorStack = (e && e.stack) || '';
    } finally {
      this._running = false;
    }
    return out;
  }

  /**
   * 基于真实指标筛选「正向内容」（零伪造，全部来自已回收的 note_count）。
   * 正向定义（可配）：
   *  - note_count >= minNotes （绝对热度）
   *  - 或 相对基线增长率 >= minGrowthPct （增长势能）
   * @returns {Array} 排序后的正向内容（按增长绝对值降序）
   */
  async getPositive({ minNotes = 50, minGrowthPct = 30, limit = 50 } = {}) {
    const [rows] = await this.pool.query(
      `SELECT id, account_id, post_url, content_title, note_count, note_baseline, note_history, published_at
       FROM matrix_posts_published
       WHERE ='tumblr' AND status='published' AND note_count >= ?
       ORDER BY note_count DESC LIMIT ?`,
      [Math.max(0, parseInt(minNotes, 10) || 0), Math.max(1, parseInt(limit, 10) || 50)]
    );
    const out = [];
    for (const r of rows) {
      let hist = [];
      try { hist = JSON.parse(r.note_history || '[]'); } catch (_) {}
      const base = Number(r.note_baseline) || 0;
      const growthAbs = (r.note_count || 0) - base;
      const growthPct = base > 0 ? (growthAbs / base * 100) : (r.note_count || 0) * 10; // 基线为0时按绝热度近似
      if (growthPct >= minGrowthPct || (r.note_count || 0) >= minNotes) {
        out.push({
          id: r.id,
          accountId: r.account_id,
          postUrl: r.post_url,
          title: r.content_title || '',
          noteCount: r.note_count || 0,
          baseline: base,
          growthAbs,
          growthPct: Math.round(growthPct),
          publishedAt: r.published_at,
          history: hist
        });
      }
    }
    out.sort((a, b) => b.growthAbs - a.growthAbs);
    return out;
  }

  /** 周期性自动回收（默认关闭，由环境变量 ENABLE_ENGAGEMENT_AUTO=1 开启） */
  startAuto(intervalMs = 3600000) {
    if (this._timer) return;
    const loop = async () => {
      try { await this.harvest(); } catch (_) {}
    };
    this._timer = setInterval(loop, Math.max(600000, intervalMs));
    loop();
  }
  stopAuto() { if (this._timer) { clearInterval(this._timer); this._timer = null; } }
}

module.exports = { EngagementHarvester };
