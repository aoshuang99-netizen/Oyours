'use strict';
/**
 * social-publishing.js — Mixpost 风格内容运营核心服务（每平台 Post Versioning + 调度 + 标签组）
 *
 * 移植自 Mixpost 的核心内容模型：
 *  - `mixpost_post`            ≈ Mixpost `Post`：一个活动/草稿，带 scheduled_at + 状态机
 *                               (draft / scheduled / published / failed / trash)，绑定多账号
 *  - `mixpost_post_version`    ≈ Mixpost `PostVersion`：一个 Post → 每个账号/平台一份定制的
 *                               内容版本（content + media），这是 Mixpost 的招牌特性
 *  - `mixpost_hashtag_group`   ≈ Mixpost `Tag`（hashtag groups）
 *  - scheduler                 ≈ Mixpost 的调度器：到点把 scheduled 帖子推到各平台真实发布
 *
 * 与 MSCMS 已有能力联动：
 *  - 内容文案可由 `trend-intel` 热点 + `video-render` 渲染的视频驱动
 *  - 发布通过 `SocialProviderManager` 走真实平台适配器（当前 tumblr 真实，其余诚实脚手架）
 */
const { EventEmitter } = require('events');

const POST_STATUS = {
  DRAFT: 'draft',
  SCHEDULED: 'scheduled',
  PUBLISHED: 'published',
  FAILED: 'failed',
  TRASH: 'trash',
};

class MixpostService extends EventEmitter {
  constructor({ dataStore, providerManager } = {}) {
    super();
    this.dataStore = dataStore;
    this.providerManager = providerManager;
    this._timer = null;
  }

  // ── Post（活动）────────────────────────────────
  createPost(data = {}) {
    const now = new Date().toISOString();
    const  = Array.isArray(data.) ? data. : [];
    const scheduledAt = data.scheduledAt || null;
    let status = data.status || POST_STATUS.DRAFT;
    if (scheduledAt && status === POST_STATUS.DRAFT) status = POST_STATUS.SCHEDULED;

    const post = this.dataStore.create('mixpost_post', {
      title: data.title || null,
      text: data.text || '',
      ,
      media: Array.isArray(data.media) ? data.media : [],
      tagIds: Array.isArray(data.tagIds) ? data.tagIds : [],
      sourceTrendId: data.sourceTrendId || null,
      videoRenderId: data.videoRenderId || null,
      scheduledAt,
      status,
      publishedAt: null,
      createdBy: data.createdBy || 'mscms',
    });
    // 为每个账号预建空版本（Mixpost 的 per- versioning）
    post..forEach(acc => this._ensureVersion(post.id, acc));
    return post;
  }

  _ensureVersion(postId, acc) {
    const existing = this.dataStore.list('mixpost_post_version', {
      filter: { postId, accountId: String(acc.id) }, limit: 1,
    });
    if (existing.items && existing.items.length) return existing.items[0];
    return this.dataStore.create('mixpost_post_version', {
      postId,
      accountId: String(acc.id),
      : acc. || 'unknown',
      content: '',
      media: [],
      status: 'pending',
    });
  }

  listPosts(opts = {}) {
    const r = this.dataStore.list('mixpost_post', {
      filter: opts.filter, search: opts.search, sort: opts.sort || 'createdAt',
      order: opts.order || 'desc', page: opts.page || 1, limit: opts.limit || 20,
    });
    return r;
  }

  getPost(id) {
    const post = this.dataStore.get('mixpost_post', id);
    if (!post) return null;
    const versions = this.dataStore.list('mixpost_post_version', { filter: { postId: id }, limit: 1000 }).items || [];
    const hashtags = (post.tagIds || []).map(tid => this.dataStore.get('mixpost_hashtag_group', tid)).filter(Boolean);
    return Object.assign({}, post, { versions, hashtags });
  }

  updatePost(id, patch = {}) {
    const post = this.dataStore.get('mixpost_post', id);
    if (!post) return null;
    const np = this.dataStore.update('mixpost_post', id, patch);
    if (patch.status === POST_STATUS.SCHEDULED && patch.scheduledAt) {
      np..forEach(acc => this._ensureVersion(id, acc));
    }
    return np;
  }

  deletePost(id) {
    this.dataStore.delete('mixpost_post', id);
    const vers = this.dataStore.list('mixpost_post_version', { filter: { postId: id }, limit: 1000 }).items || [];
    vers.forEach(v => this.dataStore.delete('mixpost_post_version', v.id));
    return true;
  }

  // 为某版本定制文案/媒体（Mixpost 每平台版本化）
  updateVersion(versionId, patch = {}) {
    return this.dataStore.update('mixpost_post_version', versionId, patch);
  }

  /** 获取某个 Post 的所有版本 */
  listVersions(postId) {
    return this.dataStore.list('mixpost_post_version', { filter: { postId }, limit: 1000 }).items || [];
  }

  // ── Hashtag groups（标签组）────────────────────
  createHashtagGroup({ name, tags = [] }) {
    if (!name) throw new Error('hashtag group 需要 name');
    return this.dataStore.create('mixpost_hashtag_group', {
      name,
      tags: Array.isArray(tags) ? tags.map(t => String(t).replace(/^#/, '').trim()).filter(Boolean) : [],
    });
  }
  listHashtagGroups() { return this.dataStore.list('mixpost_hashtag_group', { limit: 1000 }).items || []; }
  deleteHashtagGroup(id) { return this.dataStore.delete('mixpost_hashtag_group', id); }

  // ── 调度器 ────────────────────────────────────
  start(intervalMs = 15000) {
    if (this._timer) return;
    this._timer = setInterval(() => this.tick().catch(e => console.error('[Mixpost] scheduler tick error:', e.message)), intervalMs);
    console.log('[Mixpost] scheduler started');
  }
  stop() { if (this._timer) { clearInterval(this._timer); this._timer = null; } }

  /** 扫描到期 scheduled 帖子并真实发布 */
  async tick() {
    const due = this.dataStore.list('mixpost_post', {
      filter: { status: POST_STATUS.SCHEDULED }, limit: 1000,
    }).items || [];
    const now = Date.now();
    for (const post of due) {
      const when = post.scheduledAt ? new Date(post.scheduledAt).getTime() : 0;
      if (when > now) continue;
      await this.publishPost(post.id);
    }
  }

  /**
   * 立即把某 Post 推到所有绑定账号（真实发布）
   */
  async publishPost(postId) {
    const post = this.dataStore.get('mixpost_post', postId);
    if (!post) throw new Error('post not found: ' + postId);
    this.dataStore.update('mixpost_post', postId, { status: POST_STATUS.SCHEDULED, publishedAt: null });

    const results = [];
    for (const acc of post.) {
      const version = this._ensureVersion(postId, acc);
      let resp;
      try {
        const provider = this.providerManager.connect(acc., {});
        const versionContent = version.content || post.text;
        const tags = (post.tagIds || []).map(tid => this.dataStore.get('mixpost_hashtag_group', tid))
          .flatMap(g => g ? g.tags : []);
        resp = await provider.publishPost(versionContent, post.media, {
          tags: tags.length ? tags : (post.media && post.media[0] && post.media[0].tags) || [],
          title: post.text,
        });
      } catch (e) {
        resp = { provider: acc., status: 'failed', error: e.message };
      }
      const updated = this.dataStore.update('mixpost_post_version', version.id, {
        status: resp.status === 'success' ? 'published' : 'failed',
        content: version.content || post.text,
        media: post.media,
        publishedUrl: resp.url || null,
        publishedAt: resp.status === 'success' ? new Date().toISOString() : null,
        providerResponse: resp.toJSON ? resp.toJSON() : resp,
        error: resp.error || null,
      });
      results.push(updated);
      this.emit('version:published', { postId, account: acc, result: updated });
    }

    const allOk = results.every(r => r.status === 'published');
    const anyOk = results.some(r => r.status === 'published');
    const finalStatus = allOk ? POST_STATUS.PUBLISHED : (anyOk ? POST_STATUS.PUBLISHED : POST_STATUS.FAILED);
    this.dataStore.update('mixpost_post', postId, {
      status: finalStatus,
      publishedAt: anyOk ? new Date().toISOString() : null,
    });
    this.emit('post:published', { postId, status: finalStatus, results });
    return { postId, status: finalStatus, results };
  }

  getProviders() { return this.providerManager.providers(); }
}

module.exports = { MixpostService, POST_STATUS };
