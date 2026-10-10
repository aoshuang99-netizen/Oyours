'use strict';
/**
 * providers/hashnode-provider.js — Mixpost 风格 Hashnode 提供方适配器
 *
 * 官方免费凭证方案：Hashnode 设置 → 生成 Personal Access Token (PAT)。
 * 无需开发者门户、无需付费、无需审核。
 *
 * 凭证读取顺序（dataStore > 环境变量）：
 *   1) dataStore('hashnode_config','main') —— dashboard 表单写入
 *   2) 环境变量 HASHNODE_TOKEN / HASHNODE_PUBLICATION_ID
 *
 * API: GraphQL https://gql.hashnode.com
 *   发表两步走：createDraft(input) → publishDraft(input)
 *   tags 必须是 [{ name, slug }] 对象数组，不能为字符串。
 *
 * 网络：代理同上（中国大陆 proxied）。
 *
 * 禁假数据铁律：未配置/失败一律 _fail()，绝不伪造 url。
 */

const { SocialProvider } = require('../social-provider-manager.js');

class HashnodeProvider extends SocialProvider {
  constructor({ dataStore = null, proxiedFetch = null, values = {} } = {}) {
    super({ values, dataStore });
    this.dataStore = dataStore;
    this.proxiedFetch = proxiedFetch;
    this._dispatcher = null;
    this._proxyChecked = false;
  }

  identifier() { return 'hashnode'; }
  name() { return 'Hashnode'; }
  service() { return 'hashnode'; }

  _config() {
    const env = {
      token: process.env.HASHNODE_TOKEN || '',
      publicationId: process.env.HASHNODE_PUBLICATION_ID || '',
    };
    let stored = {};
    try { stored = (this.dataStore && this.dataStore.get('hashnode_config', 'main')) || {}; } catch (e) { stored = {}; }
    return {
      token: stored.token || env.token || '',
      publicationId: stored.publicationId || env.publicationId || '',
    };
  }

  configStatus() {
    const c = this._config();
    // Hashnode 文章必须归属某个 publication，故需 token + publicationId
    const hasCreds = !!(c.token && c.publicationId);
    return {
      identifier: 'hashnode',
      configured: hasCreds,
      authorized: hasCreds,
      reason: hasCreds
        ? null
        : '尚未配置 HASHNODE_TOKEN / HASHNODE_PUBLICATION_ID。免费获取：Hashnode → Dashboard → Settings → Developer → Generate Token；Publication ID 见 出版物设置 URL',
    };
  }

  async _ensureDispatcher() {
    if (this._proxyChecked) return this._dispatcher;
    this._proxyChecked = true;
    const proxy = process.env.HTTP_PROXY || process.env.http_proxy || process.env.HTTPS_PROXY;
    if (proxy) {
      try {
        let undici = null;
        try { undici = require('undici'); } catch (e) { undici = await import('undici'); }
        const ProxyAgent = undici.ProxyAgent || (undici.default && undici.default.ProxyAgent);
        if (!ProxyAgent) throw new Error('undici 未导出 ProxyAgent');
        this._dispatcher = new ProxyAgent(proxy);
        console.log('[HashnodeProvider] 使用代理 dispatcher:', proxy);
      } catch (e) {
        console.warn('[HashnodeProvider] 未能加载 undici.ProxyAgent，将直连（可能失败）：', e.message);
      }
    }
    return this._dispatcher;
  }

  async _gql(query, variables) {
    const c = this._config();
    const dispatcher = await this._ensureDispatcher();
    const opts = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${c.token}`,
      },
      body: JSON.stringify({ query, variables: variables || {} }),
    };
    if (dispatcher) opts.dispatcher = dispatcher;
    const res = await fetch('https://gql.hashnode.com', opts);
    const out = await res.json().catch(() => ({}));
    if (out.errors && out.errors.length) {
      const e = new Error('Hashnode GraphQL: ' + out.errors.map(x => x.message).join('; '));
      e.code = res.status;
      throw e;
    }
    return out.data;
  }

  async publishPost(text, media = [], params = {}) {
    const c = this._config();
    if (!c.token || !c.publicationId) {
      return this._fail('Hashnode 未配置凭据（token/publicationId 未配置）', { code: 'AUTH_MISSING' });
    }

    // tags 必须是 [{ name, slug }] 对象数组，不能为字符串数组
    let tags = Array.isArray(params.tags)
      ? params.tags.filter(Boolean).map(t => {
        const name = (typeof t === 'string') ? t : (t.name || '');
        return { name, slug: (typeof t === 'string' ? t : (t.slug || name)).toLowerCase().replace(/\s+/g, '-') };
      })
      : [];

    // 富文本封面图（可选）
    const coverMedia = (media || []).find(m => m && (m.type === 'image' || (m.url && /\.(png|jpe?g|gif|webp)$/i.test(m.url))));

    const baseInput = {
      title: params.title || (text || '').slice(0, 100) || 'MSCMS v14 自动发布',
      contentMarkdown: text || '',
      publicationId: c.publicationId,
      tags: tags,
    };
    if (coverMedia && coverMedia.url) baseInput.coverImageOptions = { coverImageURL: coverMedia.url };

    try {
      // Step 1: createDraft
      const created = await this._gql(
        `mutation($input: CreateDraftInput!) { createDraft(input: $input) { id } }`,
        { input: baseInput });
      const draftId = created && created.createDraft && created.createDraft.id;
      if (!draftId) return this._fail('Hashnode 草稿创建失败（无 draftId 返回）');

      // Step 2: publishDraft
      const published = await this._gql(
        `mutation($input: PublishDraftInput!) { publishDraft(input: $input) { post { id slug url } } }`,
        { input: { id: draftId, publicationId: c.publicationId, subtitle: params.subtitle || '', disableComments: false } });

      const post = (published && published.publishDraft && published.publishDraft.post) || {};
      const url = post.url || `https://hashnode.blog/${post.slug || ''}`;
      return this._ok({ id: String(post.id || draftId), url, accountId: 'hashnode', text, raw: published });
    } catch (e) {
      return this._fail('Hashnode 发布失败：' + e.message);
    }
  }

  async getAccount() {
    const c = this._config();
    if (!c.token) throw new Error('Hashnode 未配置凭据');
    return { id: c.publicationId || 'hashnode', name: 'Hashnode Publication', url: 'https://hashnode.com/dashboard' };
  }

  async deletePost(id) {
    // Hashnode API 不支持删除已发布文章（需手动）
    return this._fail('Hashnode 不支持通过 API 删除文章（请在网站手动操作）');
  }

  externalPostUrl(accountResource) {
    return accountResource && accountResource.url ? accountResource.url : null;
  }
}

module.exports = { HashnodeProvider };
