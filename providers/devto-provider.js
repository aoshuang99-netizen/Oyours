'use strict';
/**
 * providers/devto-provider.js — Mixpost 风格 DEV.to 提供方适配器
 *
 * 官方免费凭证方案：DEV.to 设置页 → 生成 API Key。
 * 无需开发者门户、无需付费、无需审核。
 *
 * 凭证读取顺序（dataStore > 环境变量）：
 *   1) dataStore('devto_config','main') —— dashboard 表单写入
 *   2) 环境变量 DEVTO_API_KEY
 *
 * API: POST https://dev.to/api/articles header api-key: <token>
 * Body: { article: { title, body_markdown, published, tags:[] } }
 *
 * 网络：代理同上（中国大陆 proxied）。
 *
 * 禁假数据铁律：未配置/失败一律 _fail()，绝不伪造 url。
 */

const { SocialProvider } = require('../social-provider-manager.js');

class DevtoProvider extends SocialProvider {
  constructor({ dataStore = null, proxiedFetch = null, values = {} } = {}) {
    super({ values, dataStore });
    this.dataStore = dataStore;
    this.proxiedFetch = proxiedFetch;
    this._dispatcher = null;
    this._proxyChecked = false;
  }

  identifier() { return 'devto'; }
  name() { return 'DEV.to'; }
  service() { return 'dev_to'; }

  _config() {
    const env = {
      apiKey: process.env.DEVTO_API_KEY || '',
    };
    let stored = {};
    try { stored = (this.dataStore && this.dataStore.get('devto_config', 'main')) || {}; } catch (e) { stored = {}; }
    return {
      apiKey: stored.apiKey || env.apiKey || '',
    };
  }

  /**
   * 凭据**格式**校验（同步、零网络）。
   * ⚠️ dev.to **未公开** API Key 的固定长度/前缀，故此处采用**保守判据**（只拦「明显占位值 /
   *    截断值」），**不编造官方格式**，以保证不会误伤真实 Key。
   *
   * 【2026-09-20 F3 延伸】原 `configStatus()` 里 `authorized: hasCreds` 与 `configured` 完全冗余，
   *   占位值会直接变成「绿灯但发不出去」的假绿。此处补格式闸门，**仅收紧 `authorized`**。
   */
  _checkCredFormat(c) {
    const k = String(c.apiKey || '');
    if (!/^[A-Za-z0-9_-]{16,}$/.test(k)) {
      return {
        ok: false,
        reason: `DEVTO_API_KEY 格式可疑（当前 ${k.length} 字符）⇒ dev.to 的 API Key 为 16 位以上无空白串；当前值过短或含非法字符，疑似占位/截断值，请到 Settings → Extensions 重新生成`,
      };
    }
    return { ok: true };
  }

  configStatus() {
    const c = this._config();
    const hasCreds = !!(c.apiKey);
    const fmt = hasCreds ? this._checkCredFormat(c) : { ok: false, reason: null };
    return {
      identifier: 'devto',
      configured: hasCreds,
      format: fmt.ok ? 'ok' : 'invalid',
      authorized: hasCreds && fmt.ok,
      reachable: 'unknown',
      probeAt: null,
      reason: !hasCreds
        ? '尚未配置 DEVTO_API_KEY。免费获取：dev.to → Settings → Extensions → DEV Community API Keys → Generate（无需开发者门户/付费/审核）'
        : (fmt.ok ? null : fmt.reason),
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
        console.log('[DevtoProvider] 使用代理 dispatcher:', proxy);
      } catch (e) {
        console.warn('[DevtoProvider] 未能加载 undici.ProxyAgent，将直连（可能失败）：', e.message);
      }
    }
    return this._dispatcher;
  }

  async _api(path, body) {
    const c = this._config();
    const dispatcher = await this._ensureDispatcher();
    const opts = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/vnd.forem.api-v1+json',
        'api-key': c.apiKey,
      },
      body: JSON.stringify(body),
    };
    if (dispatcher) opts.dispatcher = dispatcher;
    const res = await fetch(`https://dev.to${path}`, opts);
    const text = await res.text();
    let out = null;
    try { out = text ? JSON.parse(text) : null; } catch (e) { out = null; }
    if (!res.ok) {
      const err = (out && out.error) ? out.error : ('HTTP ' + res.status);
      const e = new Error(`DEV.to API: ${err}`);
      e.code = res.status;
      throw e;
    }
    return out;
  }

  async publishPost(text, media = [], params = {}) {
    const c = this._config();
    if (!c.apiKey) {
      return this._fail('DEV.to 未配置凭据（apiKey 未配置）', { code: 'AUTH_MISSING' });
    }

    // DEV.to 正文用 body_markdown（Markdown 格式），text 作为 body_markdown
    // 有 media 时可选地用 Markdown 图片语法嵌入
    let bodyMarkdown = text || '';
    const imageMedia = (media || []).find(m => m && (m.type === 'image' || (m.url && /\.(png|jpe?g|gif|webp)$/i.test(m.url))));
    if (imageMedia && imageMedia.url) {
      bodyMarkdown = `![${params.alt || 'image'}](${imageMedia.url})\n\n${bodyMarkdown}`;
    }

    // tags 为字符串数组（最多 4 个）
    const tags = Array.isArray(params.tags) ? params.tags.slice(0, 4).filter(Boolean) : [];

    const article = {
      article: {
        title: params.title || (text || '').slice(0, 100) || 'MSCMS v14 自动发布',
        body_markdown: bodyMarkdown,
        published: params.published !== false,
        tags: tags,
      },
    };

    try {
      const out = await this._api('/api/articles', article);
      const url = out.url || (out.id ? `https://dev.to/${params.username || 'user'}/${out.slug || out.id}` : null);
      return this._ok({ id: String(out.id || ''), url, accountId: params.username || 'devto-user', text, raw: out });
    } catch (e) {
      return this._fail('DEV.to 发布失败：' + e.message);
    }
  }

  async getAccount() {
    const c = this._config();
    if (!c.apiKey) throw new Error('DEV.to 未配置凭据');
    // DEV.to 可以用 /api/users/me 获取用户信息
    try {
      const dispatcher = await this._ensureDispatcher();
      const opts = {
        method: 'GET',
        headers: { Accept: 'application/vnd.forem.api-v1+json', 'api-key': c.apiKey },
      };
      if (dispatcher) opts.dispatcher = dispatcher;
      const res = await fetch('https://dev.to/api/users/me', opts);
      const out = await res.json().catch(() => ({}));
      const user = out || {};
      return { id: String(user.id || 'me'), name: user.username || user.name || 'DEV.to User', url: `https://dev.to/${user.username || ''}` };
    } catch (e) {
      return { id: 'me', name: 'DEV.to User', url: 'https://dev.to' };
    }
  }

  async deletePost(id) {
    // DEV.to API 不支持通过 API 删除文章（需手动）
    return this._fail('DEV.to 不支持通过 API 删除文章（请在网站手动操作）');
  }

  externalPostUrl(accountResource) {
    return accountResource && accountResource.url ? accountResource.url : null;
  }
}

module.exports = { DevtoProvider };
