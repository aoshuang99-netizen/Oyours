'use strict';
/**
 * providers/tumblr-provider.js — Mixpost 风格 Tumblr 提供方适配器
 *
 * 委托已有的 `TumblrPublisher`（手搓 HMAC-SHA1 OAuth1.0a）完成真实发布，
 * 同时实现 Mixpost 的 `SocialProvider` 契约，使 MSCMS 内容运营/发布模块可以
 * 通过统一的 SocialProviderManager 调用，而无需关心平台细节。
 *
 * 同样遵守禁假数据铁律：未授权 / 未配置时 publishPost 返回 status='failed'
 * 并附带真实错误信息，绝不返回伪造的 post_url。
 */
const { SocialProvider } = require('../social-provider-manager.js');

class TumblrProvider extends SocialProvider {
  constructor({ tumblrPublisher, dataStore, proxiedFetch, values = {} } = {}) {
    super({ values, dataStore });
    this.tumblrPublisher = tumblrPublisher;
    this.proxiedFetch = proxiedFetch;
    if (!this.tumblrPublisher) throw new Error('TumblrProvider 需要 tumblrPublisher 实例');
  }

  identifier() { return 'tumblr'; }
  name() { return 'Tumblr'; }
  service() { return 'tumblr'; }

  /** 配置状态（驱动 dashboard） */
  configStatus() {
    const s = this.tumblrPublisher.getStatus();
    if (!s.hasConsumerKey) {
      return { identifier: 'tumblr', configured: false, authorized: false, blogName: '', reason: '尚未配置 consumer_key/secret' };
    }
    if (!s.authorized) {
      return { identifier: 'tumblr', configured: false, authorized: false, blogName: '', reason: '已配置 Key，但 OAuth 授权未完成' };
    }
    return { identifier: 'tumblr', configured: true, authorized: true, blogName: s.blogName, reason: null };
  }

  /**
   * 构造授权 URL：触发 request_token 并返回用户授权页
   * 注意：Tumblr OAuth1.0a 是两步握手，beginAuth 返回 authorizeUrl，
   * 用户在浏览器中登录授权后把 oauth_verifier 交给 requestAccessToken。
   */
  async getAuthUrl() {
    const r = await this.tumblrPublisher.beginAuth();
    this._tmpToken = r.oauthToken;
    return r.authorizeUrl;
  }

  /** 用 verifier 完成握手，返回 { token, account } */
  async requestAccessToken(params = {}) {
    const verifier = params.verifier || params.oauth_verifier;
    if (!verifier) throw new Error('缺少 oauth_verifier');
    const r = await this.tumblrPublisher.completeAuth(verifier);
    const s = this.tumblrPublisher.getStatus();
    this.useAccessToken(s.oauthToken);
    return { token: s.oauthToken, account: { id: s.blogName, name: s.blogName, url: `https://${s.blogName}.tumblr.com` } };
  }

  /** 当前授权账号资料 */
  async getAccount() {
    const s = this.tumblrPublisher.getStatus();
    if (!s.authorized) throw new Error('Tumblr 未授权');
    return { id: s.blogName, name: s.blogName, url: `https://${s.blogName}.tumblr.com` };
  }

  /**
   * 发布一条内容（Mixpost 契约：publishPost(text, media, params)）
   * @param {string} text   文案（caption）
   * @param {Array}  media  媒体数组，元素 { type:'video', filePath } | { type:'image', url }
   * @param {object} params { tags:[], title }
   * @returns {SocialProviderResponse}
   */
  async publishPost(text, media = [], params = {}) {
    const status = this.tumblrPublisher.getStatus();
    if (!status.authorized) {
      return this._fail('Tumblr 未授权，无法发布。请先完成 OAuth 授权流程。');
    }
    // 选取首个视频媒体
    const videoMedia = (media || []).find(m => m && (m.type === 'video' || m.filePath));
    const filePath = (videoMedia && videoMedia.filePath) || params.filePath || null;
    if (!filePath) {
      return this._fail('Tumblr 视频发布需要 media 中至少一个 {type:"video", filePath}');
    }
    const tags = Array.isArray(params.tags) ? params.tags : [];
    try {
      const r = await this.tumblrPublisher.publishVideo({
        filePath,
        caption: text || params.title || '',
        title: params.title,
        tags,
      });
      return this._ok({
        id: r.postId,
        url: r.postUrl,
        accountId: status.blogName,
        text,
        raw: r,
      });
    } catch (e) {
      return this._fail(e.message, { accountId: status.blogName });
    }
  }

  async deletePost(id) {
    // Tumblr API 需额外实现；当前诚实返回未实现
    return this._fail('Tumblr 帖子删除尚未实现（OAuth1.0a delete 端点待补）');
  }

  externalPostUrl(accountResource) {
    return accountResource && accountResource.url ? accountResource.url : null;
  }
}

module.exports = { TumblrProvider };
