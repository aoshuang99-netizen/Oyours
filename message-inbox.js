'use strict';

/**
 * message-inbox.js — 账号消息 / 指令 统一收件箱核心模块（Phase 5 / #529）
 * =========================================================================
 * 把「消息 + 指令」收敛到一个真实、可审计、零伪造的中心：
 *   - inbox 读写：基于 DataStore `inbox` 模块（持久化 + 已读状态）
 *   - 真实同步：把 Tumblr 官方通知/帖子 upsert 进收件箱（按稳定 extId 去重，
 *     保留已读状态，绝不伪造）
 *   - 未读计数：每次变更重算 account.inbox_unread + 通过 event-bus 推送 `inbox.update`
 *   - 指令下发：sendCommand 严格零伪造 —— 只创建人工待审草稿（tumblr_interaction_draft），
 *     真实发送必须回到 Tumblr 网页由人手确认，并写入 tumblr_interaction_audit 审计。
 *
 * 依赖注入：{ dataStore, eventBus, tumblrPublisher? }
 * 无任何自动发送、无任何假数据；所有「发送」动作都落到「人工网页确认」这一关卡。
 * =========================================================================
 */

const crypto = require('crypto');

// inbox 模块名（已在 data-store._pruneConfig 注册，maxKeep 5000）
const INBOX_MODULE = 'inbox';
// 草稿模块（与 server.js 现有草稿系统复用同一 schema，保证 open-web 兼容）
const DRAFT_MODULE = 'tumblr_interaction_draft';
// 审计模块
const AUDIT_MODULE = 'tumblr_interaction_audit';

// 仅这些类型计入「未读」
const UNREAD_TYPES = new Set(['notification', 'command', 'system']);

function _genId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
}

// 从 Tumblr 通知对象抽取稳定去重键
function _notifKey(n) {
  if (n && n.id) return 'ntf_' + String(n.id);
  const ts = n && (n.timestamp || n.updated) ? n.timestamp || n.updated : Date.now();
  const type = (n && n.type) || 'notification';
  const who = n && n.blog ? (n.blog.name || n.blog.uuid || '') : (n && n.from ? (n.from.name || '') : '');
  const summary = n && n.summary ? (n.summary.text || n.summary || '') : '';
  const h = crypto.createHash('md5').update(`${type}|${ts}|${who}|${summary}`).digest('hex').slice(0, 12);
  return `ntf_${type}_${ts}_${h}`;
}

function _postKey(p) {
  if (p && p.id) return 'post_' + String(p.id);
  const ts = p && p.timestamp ? p.timestamp : Date.now();
  return `post_${ts}_${crypto.createHash('md5').update(JSON.stringify(p || {})).digest('hex').slice(0, 8)}`;
}

// 从 Tumblr 通知对象抽取展示字段
function _notifFields(n) {
  const type = (n && n.type) || 'notification';
  const blog = n && n.blog ? (n.blog.name || n.blog.title || '') : '';
  const summary = n && n.summary ? (n.summary.text || n.summary || '') : '';
  const title = blog ? `${type} · ${blog}` : type;
  const body = summary || (n && n.body ? String(n.body).slice(0, 280) : '');
  const url = n && n.post ? (n.post.url || (n.post.blog && n.post.blog.url ? n.post.blog.url : '')) : '';
  return { title, body, from: blog, url };
}

// 从 Tumblr 帖子对象抽取展示字段（自身帖子活动）
function _postFields(p) {
  const id = p && p.id ? String(p.id) : '';
  const title = (p && p.summary) ? String(p.summary).slice(0, 80) : (p && p.type ? `${p.type} 帖子` : '帖子');
  const body = (p && p.body) ? String(p.body).replace(/<[^>]+>/g, ' ').slice(0, 280) : '';
  const url = (p && p.post_url) || (p && p.url) || '';
  return { title, body, from: (p && p.blog_name) || '', url, extId: _postKey(p) };
}

class MessageInbox {
  constructor({ dataStore, eventBus, tumblrPublisher } = {}) {
    this.dataStore = dataStore;
    this.eventBus = eventBus;
    this.tumblrPublisher = tumblrPublisher;
    this._ready = false;
  }

  init() {
    // 目前无需订阅外部事件；变更由内部方法 emit `inbox.update` 实现推送。
    this._ready = true;
    if (this.eventBus) {
      this.eventBus.emit('inbox.ready', { module: 'message-inbox', at: new Date().toISOString() }, 'message-inbox');
    }
    return this;
  }

  _acctId(d) {
    if (!d) return null;
    return d.accountId || d.account_id || d.id ||
      (d.data && (d.data.accountId || d.data.account_id || d.data.id)) || null;
  }

  // ── 真实同步：Tumblr 通知 + 帖子 upsert 进收件箱 ────────────────────────
  /**
   * @param {string} accountId
   * @param {{notifications?:Array, posts?:Array}} payload 真实拉取结果（来自 tumblrPublisher）
   * @returns {Promise<{synced:number, newUnread:number, unread:number}>}
   */
  async syncFromTumblr(accountId, { notifications = [], posts = [] } = {}) {
    if (!this.dataStore) return { synced: 0, newUnread: 0, unread: 0 };
    let synced = 0;
    let newUnread = 0;

    const upsert = (extId, type, fields) => {
      const existing = this._findByExt(accountId, extId);
      if (existing) {
        // 已存在：保留已读状态，仅刷新可能变化的展示字段
        this.dataStore.update(INBOX_MODULE, existing.id, {
          title: fields.title, body: fields.body, from: fields.from, url: fields.url,
          updatedAt: new Date().toISOString(),
        });
        return;
      }
      const isUnreadType = UNREAD_TYPES.has(type);
      this.dataStore.create(INBOX_MODULE, {
        id: _genId('inb'),
        extId,
        accountId,
        type,
        channel: 'tumblr',
        title: fields.title,
        body: fields.body,
        from: fields.from || '',
        url: fields.url || '',
        read: !isUnreadType, // 自身帖子活动默认已读；通知/指令默认未读
        receivedAt: fields.receivedAt || new Date().toISOString(),
        createdAt: new Date().toISOString(),
      });
      synced++;
      if (isUnreadType) newUnread++;
    };

    for (const n of (notifications || [])) {
      const fields = _notifFields(n);
      upsert(_notifKey(n), 'notification', fields);
    }
    for (const p of (posts || [])) {
      const f = _postFields(p);
      upsert(f.extId, 'post_activity', f);
    }

    const unread = this._recomputeUnread(accountId);
    this._emitUpdate(accountId, unread);
    return { synced, newUnread, unread };
  }

  // 系统/自主决策产生的消息（例如「某账号内容已发布」提示，不伪造互动）
  addMessage(accountId, msg = {}) {
    if (!this.dataStore) return null;
    const type = ['notification', 'command', 'system', 'post_activity'].includes(msg.type) ? msg.type : 'system';
    const id = this.dataStore.create(INBOX_MODULE, {
      id: _genId('inb'),
      extId: 'sys_' + _genId('e'),
      accountId,
      type,
      channel: msg.channel || 'system',
      title: String(msg.title || '系统消息').slice(0, 200),
      body: String(msg.body || '').slice(0, 2000),
      from: msg.from || 'system',
      url: msg.url || '',
      read: false,
      receivedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });
    const unread = this._recomputeUnread(accountId);
    this._emitUpdate(accountId, unread);
    return id;
  }

  // ── 读取 ──────────────────────────────────────────────────────────────
  listInbox(accountId, opts = {}) {
    if (!this.dataStore) return { items: [], total: 0, returned: 0, unread: 0 };
    const filter = { accountId };
    if (opts.type) filter.type = opts.type;
    if (opts.unreadOnly) filter.read = false;
    const list = this.dataStore.list(INBOX_MODULE, {
      filter,
      sort: 'receivedAt',
      order: 'desc',
      limit: opts.limit || 100,
      offset: opts.offset || 0,
    });
    return {
      accountId,
      items: list.items,
      total: list.total,
      returned: list.returned,
      unread: this.getUnreadCount(accountId),
    };
  }

  getUnreadCount(accountId) {
    if (!this.dataStore) return 0;
    const all = (this.dataStore.list(INBOX_MODULE, { filter: { accountId }, limit: 1e9 }).items) || [];
    return all.filter((x) => UNREAD_TYPES.has(x.type) && !x.read).length;
  }

  // ── 已读 ──────────────────────────────────────────────────────────────
  markRead(accountId, ids) {
    if (!this.dataStore) return { marked: 0, unread: 0 };
    const set = new Set((ids || []).map(String));
    let marked = 0;
    if (set.size) {
      for (const id of set) {
        const rec = this.dataStore.get(INBOX_MODULE, id);
        if (rec && String(rec.accountId) === String(accountId) && !rec.read) {
          this.dataStore.update(INBOX_MODULE, id, { read: true, readAt: new Date().toISOString() });
          marked++;
        }
      }
    }
    const unread = this._recomputeUnread(accountId);
    this._emitUpdate(accountId, unread);
    return { marked, unread };
  }

  markAllRead(accountId) {
    if (!this.dataStore) return { marked: 0, unread: 0 };
    const all = (this.dataStore.list(INBOX_MODULE, { filter: { accountId }, limit: 1e9 }).items) || [];
    let marked = 0;
    for (const rec of all) {
      if (UNREAD_TYPES.has(rec.type) && !rec.read) {
        this.dataStore.update(INBOX_MODULE, rec.id, { read: true, readAt: new Date().toISOString() });
        marked++;
      }
    }
    const unread = this._recomputeUnread(accountId);
    this._emitUpdate(accountId, unread);
    return { marked, unread };
  }

  // ── 指令下发（零伪造：只建人工待审草稿，真实发送须回网页手动确认）──────────
  /**
   * @param {string} accountId
   * @param {{kind?:'direct_message'|'comment_reply', body:string, recipient?:string,
   *          postId?:string, targetUrl?:string, command?:string}} command
   * @returns {{ok:boolean, draft?:object, openWebPath?:string, requiresManualWebSend:true, error?:string}}
   */
  sendCommand(accountId, command = {}) {
    if (!this.dataStore) return { ok: false, requiresManualWebSend: true, error: 'dataStore 未初始化' };
    const kind = String(command.kind || 'direct_message');
    if (!['direct_message', 'comment_reply'].includes(kind)) {
      return { ok: false, requiresManualWebSend: true, error: 'kind 必须为 direct_message 或 comment_reply' };
    }
    const body = String(command.body || '').trim();
    const recipient = String(command.recipient || '').trim().slice(0, 200);
    const postId = String(command.postId || '').trim().slice(0, 100);
    if (!body || body.length > 5000) {
      return { ok: false, requiresManualWebSend: true, error: '指令正文不能为空且不能超过 5000 字符' };
    }
    const fallback = kind === 'direct_message' ? 'https://www.tumblr.com/messaging' : 'https://www.tumblr.com/dashboard';
    const targetUrl = this._normalizeTumblrTarget(command.targetUrl, fallback);
    // 把指令语义并入草稿正文（便于人工在网页核对），但不自动发送
    const fullBody = command.command ? `[指令:${String(command.command).slice(0, 80)}]\n${body}` : body;

    const draft = this.dataStore.create(DRAFT_MODULE, {
      id: 'tid_' + crypto.randomUUID(),
      accountId,
      kind,
      recipient,
      postId,
      targetUrl,
      body: fullBody,
      status: 'draft',
      requiresManualWebSend: true,
      createdAt: new Date().toISOString(),
    });
    this._audit(accountId, 'command-created', {
      draftId: draft.id, kind, recipient, postId, targetUrl, bodyLength: fullBody.length,
      command: command.command || null,
    });
    // 在收件箱留一条「指令已建（待人工网页确认发送）」记录，便于统一呈现
    this.addMessage(accountId, {
      type: 'command',
      title: `待发送指令 · ${kind === 'direct_message' ? '私信' : '评论回复'}`,
      body: `${recipient ? '致 ' + recipient + '：' : ''}${fullBody.slice(0, 140)}（需回网页手动确认发送）`,
      url: this._openWebPath(accountId, draft.id),
    });
    return {
      ok: true,
      draft: {
        id: draft.id, accountId, kind, recipient, postId, targetUrl,
        body: fullBody, status: draft.status, requiresManualWebSend: true,
        createdAt: draft.createdAt,
      },
      openWebPath: this._openWebPath(accountId, draft.id),
      requiresManualWebSend: true,
      note: '指令已生成为人工待审草稿；真实发送必须回到 Tumblr 网页由人手点击确认。',
    };
  }

  // ── 汇总 ──────────────────────────────────────────────────────────────
  getSummary() {
    let total = 0;
    let unreadTotal = 0;
    const byAccount = {};
    if (this.dataStore) {
      const all = (this.dataStore.list(INBOX_MODULE, { limit: 1e9 }).items) || [];
      total = all.length;
      for (const x of all) {
        byAccount[x.accountId] = byAccount[x.accountId] || { total: 0, unread: 0 };
        byAccount[x.accountId].total++;
        if (UNREAD_TYPES.has(x.type) && !x.read) {
          byAccount[x.accountId].unread++;
          unreadTotal++;
        }
      }
    }
    return { total, unreadTotal, byAccount };
  }

  // ── 内部工具 ──────────────────────────────────────────────────────────
  _findByExt(accountId, extId) {
    const all = (this.dataStore.list(INBOX_MODULE, { filter: { accountId }, limit: 1e9 }).items) || [];
    return all.find((x) => x.extId === extId) || null;
  }

  _recomputeUnread(accountId) {
    const unread = this.getUnreadCount(accountId);
    // 同步到 accounts 模块 inbox_unread 字段（account-manager 已暴露该字段）
    try {
      const acc = this.dataStore.get('accounts', accountId);
      if (acc) this.dataStore.update('accounts', accountId, { inbox_unread: unread, inbox_updatedAt: new Date().toISOString() });
    } catch (_) { /* 账号不存在或字段不可写不阻塞 */ }
    return unread;
  }

  _emitUpdate(accountId, unread) {
    if (!this.eventBus) return;
    this.eventBus.emit('inbox.update', {
      accountId,
      unread,
      at: new Date().toISOString(),
    }, 'message-inbox');
  }

  _audit(accountId, action, extra = {}) {
    if (!this.dataStore) return;
    try {
      this.dataStore.create(AUDIT_MODULE, Object.assign({
        id: 'tia_' + crypto.randomUUID(), accountId, action, source: 'message-inbox',
      }, extra));
    } catch (_) {}
  }

  _normalizeTumblrTarget(input, fallback) {
    try {
      const target = new URL(input || fallback);
      const host = target.hostname.toLowerCase();
      if (target.protocol === 'https:' && (host === 'tumblr.com' || host.endsWith('.tumblr.com'))) {
        return target.toString();
      }
    } catch (_) {}
    return fallback;
  }

  _openWebPath(accountId, draftId) {
    return `/api/v14/tumblr/accounts/${encodeURIComponent(accountId)}/drafts/${encodeURIComponent(draftId)}/open-web`;
  }
}

module.exports = { MessageInbox, INBOX_MODULE, DRAFT_MODULE, AUDIT_MODULE, UNREAD_TYPES };
