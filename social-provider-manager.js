'use strict';
/**
 * social-provider-manager.js — Mixpost 风格的多平台发布器注册表 / 工厂
 *
 * 这是把 https://github.com/inovector/mixpost 的【社交提供方抽象层】原生移植进
 * MSCMS v14 内容运营与发布模块的核心。本机无 PHP / MySQL / Docker，故采用 Node 原生移植。
 *
 * 移植自 Mixpost 的关键架构：
 *  - `SocialProvider`           ≈ Mixpost `Abstracts/SocialProvider` + `Contracts/SocialProvider`
 *                               提供统一契约：identifier / name / service / getAuthUrl /
 *                               requestAccessToken / useAccessToken / getAccount /
 *                               publishPost(text, media, params) / deletePost / externalPostUrl
 *  - `SocialProviderResponse`   ≈ Mixpost `UsesSocialProviderResponse` 的统一返回结构
 *  - `SocialProviderManager`    ≈ Mixpost `SocialProviderManager`
 *                               `connect(name, values)` → `connect{Studly}Provider()` 动态分发
 *                               `providers()` 返回已注册提供方清单
 *
 * 当前真实可用：tumblr（委托已有 TumblrPublisher 走真实 OAuth1.0a 发布，回真实 post_url）
 * 其余平台（twitter /  / facebook_page / instagram）：诚实脚手架，未配置时
 * 一律返回 { configured:false }，绝不伪造 token 或发布链接（禁假数据铁律）。
 */

// ── 统一发布响应（对齐 Mixpost SocialProviderResponse）──────────
class SocialProviderResponse {
  constructor(data = {}) {
    this.id = data.id || null;            // 平台帖子 id
    this.url = data.url || null;          // 平台上的帖子外链
    this.provider = data.provider || null;
    this.accountId = data.accountId || null;
    this.status = data.status || 'success'; // success | failed | 
    this.text = data.text || null;
    this.error = data.error || null;
    this.raw = data.raw || null;
  }
  isSuccess() { return this.status === 'success'; }
  toJSON() {
    return {
      id: this.id, url: this.url, provider: this.provider,
      accountId: this.accountId, status: this.status, text: this.text, error: this.error,
    };
  }
}

// ── 抽象社交提供方基类（对齐 Mixpost Abstracts/SocialProvider）──
class SocialProvider {
  constructor({ clientId, clientSecret, redirectUrl, values = {}, dataStore = null } = {}) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUrl = redirectUrl;
    this.values = values || {};
    this.dataStore = dataStore;
    this.accessToken = null;
  }

  /** 唯一标识，如 'tumblr' / 'twitter' */
  identifier() { throw new Error('SocialProvider.identifier() 未实现'); }

  /** 展示名，如 'Tumblr' */
  name() { return this.identifier(); }

  /** 服务类型，通常与 identifier 相同 */
  service() { return this.identifier(); }

  /** 构造 OAuth 授权 URL（如需） */
  getAuthUrl() { throw new Error(`${this.identifier()} 未实现 getAuthUrl`); }

  /** 用 verifier 换取 access token，返回 { token, account } */
  async requestAccessToken(params = {}) { throw new Error(`${this.identifier()} 未实现 requestAccessToken`); }

  /** 注入已持有的 access token */
  useAccessToken(token) { this.accessToken = token; return this; }

  /** 拉取授权账号资料 */
  async getAccount() { throw new Error(`${this.identifier()} 未实现 getAccount`); }

  /**
   * 发布一条内容
   * @param {string} text    文案
   * @param {Array}  media   媒体数组，元素形如 { type:'video', filePath } / { type:'image', url }
   * @param {object} params  平台特定参数（tags/title/...)
   * @returns {SocialProviderResponse}
   */
  async publishPost(text, media = [], params = {}) { throw new Error(`${this.identifier()} 未实现 publishPost`); }

  /** 删除一条帖子 */
  async deletePost(id) { throw new Error(`${this.identifier()} 未实现 deletePost`); }

  /** 由账号资源算外链 */
  externalPostUrl(accountResource) {
    return accountResource && accountResource.url ? accountResource.url : null;
  }

  /** 配置状态（供 dashboard 展示），子类可覆盖 */
  configStatus() {
    const ready = !!(this.clientId && this.clientSecret);
    return { identifier: this.identifier(), configured: ready, reason: ready ? null : '缺少 clientId/clientSecret' };
  }

  /** 便捷构造响应 */
  _ok(data) { return new SocialProviderResponse(Object.assign({ provider: this.identifier() }, data)); }
  _fail(msg, extra = {}) { return new SocialProviderResponse(Object.assign({ provider: this.identifier(), status: 'failed', error: msg }, extra)); }
}

// ── 诚实脚手架：未实现的平台（禁假数据）────────────────────
class StubProvider extends SocialProvider {
  constructor(opts = {}) {
    super(opts);
    this._displayName = opts.displayName || opts.identifier || 'Unknown';
    this._identifier = opts.identifier || 'unknown';
  }
  identifier() { return this._identifier; }
  name() { return this._displayName; }
  configStatus() {
    return {
      identifier: this.identifier(), configured: false,
      reason: `尚未移植实现：${this._displayName} 提供方当前为诚实脚手架，未配置 clientId/clientSecret，不伪造 token 或发布链接`,
    };
  }
  getAuthUrl() { throw new Error(`${this._displayName} 提供方未实现（诚实脚手架）`); }
  async requestAccessToken() { throw new Error(`${this._displayName} 提供方未实现（诚实脚手架）`); }
  async getAccount() { throw new Error(`${this._displayName} 提供方未实现（诚实脚手架）`); }
  async publishPost() {
    return this._fail(`${this._displayName} 提供方尚未实现，无法发布。请先完成该平台的 OAuth 移植。`);
  }
}

// ── 提供方管理器（对齐 Mixpost SocialProviderManager）──────────
class SocialProviderManager {
  constructor({ dataStore = null, tumblrPublisher = null, proxiedFetch = null } = {}) {
    this.dataStore = dataStore;
    this.tumblrPublisher = tumblrPublisher;
    this.proxiedFetch = proxiedFetch;

    // 提供方注册表：name -> 创建器。connect(name) 会映射到 connect{Studly}Provider()
    this._supports = {
      bluesky: 'Bluesky（AT 协议 · 免费 App  发帖，无需开发者门户/App 注册）',
      tumblr: 'Tumblr（真实 OAuth1.0a 视频发布，需注册 App 拿 key）',
      : 'Mastodon（免费 access token 发帖，无需开发者门户/付费/审核）',
      twitter: 'X / Twitter',
      facebook_page: 'Facebook Page',
      instagram: 'Instagram',
      // ── 第三方官方免费凭证渠道（无需开发者门户/付费/审核）──
      : 'Telegram（@BotFather /newbot 即时下发 bot token，频道 chat_id 用 getUpdates 取）',
      discord: 'Discord（服务器设置 → 集成 → Webhooks 生成 Webhook URL，官方免费、无审核）',
      devto: 'DEV.to（设置页生成 API Key，POST /api/articles 发技术文章）',
      : 'Hashnode（设置页生成 Personal Access Token，GraphQL 两步发布）',
      nostr: 'Nostr（本地生成 secp256k1 密钥，去中心化中继发布，零账号/零第三方/免费）',
      // ── GitHub：官方免费凭证（PAT 即时生成·零手机/零审核）真实发布到 Gist/仓库 ──
      github: 'GitHub（官方 PAT 即时生成·零手机/零审核·Gist/仓库真实发布，是全部渠道里最易获取凭证的免费官方通道）',
    };

    // 动态加载真实适配器（推迟 require 以避免循环依赖问题）
    try {
      this._TumblrProvider = require('./providers/tumblr-provider.js').TumblrProvider;
    } catch (e) {
      console.warn('[SocialProviderManager] 未能加载 tumblr-provider，Tumblr 将不可用：', e.message);
      this._TumblrProvider = null;
    }
    try {
      this._BlueskyProvider = require('./providers/bluesky-provider.js').BlueskyProvider;
    } catch (e) {
      console.warn('[SocialProviderManager] 未能加载 bluesky-provider，Bluesky 将不可用：', e.message);
      this._BlueskyProvider = null;
    }
    try {
      this._MastodonProvider = require('./providers/-provider.js').MastodonProvider;
    } catch (e) {
      console.warn('[SocialProviderManager] 未能加载 -provider，Mastodon 将不可用：', e.message);
      this._MastodonProvider = null;
    }
    try {
      this._ = require('./providers/-provider.js').;
    } catch (e) {
      console.warn('[SocialProviderManager] 未能加载 -provider，Telegram 将不可用：', e.message);
      this._ = null;
    }
    try {
      this._DiscordProvider = require('./providers/discord-provider.js').DiscordProvider;
    } catch (e) {
      console.warn('[SocialProviderManager] 未能加载 discord-provider，Discord 将不可用：', e.message);
      this._DiscordProvider = null;
    }
    try {
      this._ = require('./providers/devto-provider.js').;
    } catch (e) {
      console.warn('[SocialProviderManager] 未能加载 devto-provider，DEV.to 将不可用：', e.message);
      this._ = null;
    }
    try {
      this._ = require('./providers/-provider.js').;
    } catch (e) {
      console.warn('[SocialProviderManager] 未能加载 -provider，Hashnode 将不可用：', e.message);
      this._ = null;
    }
    try {
      this._NostrProvider = require('./providers/nostr-provider.js').NostrProvider;
    } catch (e) {
      console.warn('[SocialProviderManager] 未能加载 nostr-provider，Nostr 将不可用：', e.message);
      this._NostrProvider = null;
    }
    try {
      this._ = require('./providers/github-provider.js').;
    } catch (e) {
      console.warn('[SocialProviderManager] 未能加载 github-provider，GitHub 将不可用：', e.message);
      this._ = null;
    }
  }

  /** 已注册平台清单 */
  supported() { return Object.keys(this._supports); }

  _studly(name) {
    return name.split(/[_\-]/).map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('');
  }

  /**
   * 工厂入口（对齐 Mixpost connect()）
   * connect('tumblr', values) → connectTumblrProvider(values)
   */
  connect(name, values = {}) {
    const method = `connect${this._studly(name)}Provider`;
    if (typeof this[method] === '') {
      const instance = this[method](values);
      if (!(instance instanceof SocialProvider)) {
        throw new Error(`${name} 提供方必须继承 SocialProvider`);
      }
      return instance;
    }
    throw new Error(`不支持的社交提供方: ${name}`);
  }

  connectTumblrProvider(values = {}) {
    if (!this._TumblrProvider) throw new Error('Tumblr 适配器未加载');
    return new this._TumblrProvider({
      clientId: values.clientId,
      clientSecret: values.clientSecret,
      redirectUrl: values.redirectUrl,
      values,
      dataStore: this.dataStore,
      tumblrPublisher: this.tumblrPublisher,
      proxiedFetch: this.proxiedFetch,
    });
  }

  connectBlueskyProvider(values = {}) {
    if (!this._BlueskyProvider) throw new Error('Bluesky 适配器未加载');
    return new this._BlueskyProvider({
      values,
      dataStore: this.dataStore,
      proxiedFetch: this.proxiedFetch,
    });
  }

  connectTwitterProvider(values = {}) {
    return new StubProvider(Object.assign({ identifier: 'twitter', displayName: 'X (Twitter)' }, values));
  }
  connectMastodonProvider(values = {}) {
    if (!this._MastodonProvider) throw new Error('Mastodon 适配器未加载');
    return new this._MastodonProvider({
      values,
      dataStore: this.dataStore,
      proxiedFetch: this.proxiedFetch,
    });
  }
  connectFacebookPageProvider(values = {}) {
    return new StubProvider(Object.assign({ identifier: 'facebook_page', displayName: 'Facebook Page' }, values));
  }
  connectInstagramProvider(values = {}) {
    return new StubProvider(Object.assign({ identifier: 'instagram', displayName: 'Instagram' }, values));
  }
  connect(values = {}) {
    if (!this._) throw new Error('Telegram 适配器未加载');
    return new this._({
      values,
      dataStore: this.dataStore,
      proxiedFetch: this.proxiedFetch,
    });
  }
  connectDiscordProvider(values = {}) {
    if (!this._DiscordProvider) throw new Error('Discord 适配器未加载');
    return new this._DiscordProvider({
      values,
      dataStore: this.dataStore,
      proxiedFetch: this.proxiedFetch,
    });
  }
  connect(values = {}) {
    if (!this._) throw new Error('DEV.to 适配器未加载');
    return new this._({
      values,
      dataStore: this.dataStore,
      proxiedFetch: this.proxiedFetch,
    });
  }
  connect(values = {}) {
    if (!this._) throw new Error('Hashnode 适配器未加载');
    return new this._({
      values,
      dataStore: this.dataStore,
      proxiedFetch: this.proxiedFetch,
    });
  }
  connectNostrProvider(values = {}) {
    if (!this._NostrProvider) throw new Error('Nostr 适配器未加载');
    return new this._NostrProvider({
      values,
      dataStore: this.dataStore,
      proxiedFetch: this.proxiedFetch,
    });
  }
  connect(values = {}) {
    if (!this._) throw new Error('GitHub 适配器未加载');
    return new this._({
      values,
      dataStore: this.dataStore,
      proxiedFetch: this.proxiedFetch,
    });
  }

  /** 取得某平台实例（用于查询配置状态） */
  getProvider(name) {
    try { return this.connect(name, {}); } catch (e) { return null; }
  }

  /**
   * 提供方清单（含配置状态），供 dashboard 渲染「Mixpost 发布台」
   */
  providers() {
    return this.supported().map((name) => {
      const p = this.getProvider(name);
      const status = p ? p.configStatus() : { configured: false, reason: '实例创建失败' };
      return Object.assign({
        name,
        identifier: name,
        displayName: p ? p.name() : name,
        service: p ? p.service() : name,
        description: this._supports[name] || '',
      }, status);
    });
  }
}

module.exports = { SocialProviderManager, SocialProvider, SocialProviderResponse, StubProvider };
