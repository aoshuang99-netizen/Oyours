'use strict';
/**
 * providers/discord-provider.js — Mixpost 风格 Discord 提供方适配器
 *
 * 官方免费凭证方案：服务器设置 → 集成 → Webhooks → 生成 Webhook URL。
 * 无需开发者门户、无需付费、无需审核。
 *
 * 凭证读取顺序（dataStore > 环境变量）：
 *   1) dataStore('discord_config','main') —— dashboard 表单写入
 *   2) 环境变量 DISCORD_WEBHOOK_URL
 *
 * 网络：代理同上（中国大陆 proxied）。
 *
 * 禁假数据铁律：未配置/失败一律 _fail()，绝不伪造 url。
 */

const { SocialProvider } = require('../social-provider-manager.js');

class DiscordProvider extends SocialProvider {
  constructor({ dataStore = null, proxiedFetch = null, values = {} } = {}) {
    super({ values, dataStore });
    this.dataStore = dataStore;
    this.proxiedFetch = proxiedFetch;
    this._dispatcher = null;
    this._proxyChecked = false;
  }

  identifier() { return 'discord'; }
  name() { return 'Discord'; }
  service() { return 'discord'; }

  _config() {
    const env = {
      webhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
    };
    let stored = {};
    try { stored = (this.dataStore && this.dataStore.get('discord_config', 'main')) || {}; } catch (e) { stored = {}; }
    return {
      webhookUrl: stored.webhookUrl || env.webhookUrl || '',
    };
  }

  /**
   * 凭据**格式**校验（同步、零网络）。
   * Discord Webhook URL 固定形如
   * `https://discord.com/api/webhooks/<id>/<token>`（旧版域名 discordapp.com 亦受理）。
   *
   * 【2026-09-20 F3 延伸】原 `configStatus()` 里 `authorized: hasCreds` 与 `configured` 冗余，
   *   占位值会直接假绿。此处补格式闸门，**仅收紧 `authorized`**。
   */
  _checkCredFormat(c) {
    const u = String(c.webhookUrl || '');
    if (!/^https:\/\/(?:discord|discordapp)\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+$/.test(u)) {
      return {
        ok: false,
        reason: `DISCORD_WEBHOOK_URL 格式无效（当前 ${u.length} 字符，正确形如 https://discord.com/api/webhooks/<id>/<token>）⇒ 请到 Discord 服务器设置 → 集成 → Webhooks 重新复制`,
      };
    }
    return { ok: true };
  }

  configStatus() {
    const c = this._config();
    const hasCreds = !!(c.webhookUrl);
    const fmt = hasCreds ? this._checkCredFormat(c) : { ok: false, reason: null };
    return {
      identifier: 'discord',
      configured: hasCreds,
      format: fmt.ok ? 'ok' : 'invalid',
      authorized: hasCreds && fmt.ok,
      reachable: 'unknown',
      probeAt: null,
      reason: !hasCreds
        ? '尚未配置 DISCORD_WEBHOOK_URL。免费获取：Discord 服务器设置 → 集成 → Webhooks → 创建 Webhook → 复制 URL（无需开发者门户/付费/审核）'
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
        console.log('[DiscordProvider] 使用代理 dispatcher:', proxy);
      } catch (e) {
        console.warn('[DiscordProvider] 未能加载 undici.ProxyAgent，将直连（可能失败）：', e.message);
      }
    }
    return this._dispatcher;
  }

  async publishPost(text, media = [], params = {}) {
    const c = this._config();
    if (!c.webhookUrl) {
      return this._fail('Discord 未配置凭据（webhookUrl 未配置）', { code: 'AUTH_MISSING' });
    }

    // Discord Webhook：POST JSON {content, username, embeds:[]}
    const payload = {
      content: text || 'MSCMS v14 自动发布',
      username: params.username || 'MSCMS v14 Bot',
    };

    // 可选：embeds（富文本卡片）
    if (params.embedTitle || params.embedUrl) {
      payload.embeds = [{
        title: params.embedTitle || '',
        url: params.embedUrl || undefined,
        description: params.embedDescription || text || undefined,
        color: 0x5865F2, // Discord blurple
      }];
    }

    try {
      const dispatcher = await this._ensureDispatcher();
      const opts = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      };
      if (dispatcher) opts.dispatcher = dispatcher;
      const res = await fetch(c.webhookUrl, opts);
      const txt = await res.text();
      if (!res.ok) {
        let err = 'HTTP ' + res.status;
        try { const j = JSON.parse(txt); err = j.message || j.retry_after || err; } catch (e) { }
        return this._fail('Discord 发布失败：' + err);
      }
      // Webhook 成功时返回 204 No Content 或 {id, channel_id, ...}
      let id = '';
      let out = {};
      try { out = JSON.parse(txt); id = out.id || ''; } catch (e) { id = ''; }
      return this._ok({
        id: String(id || 'sent'),
        url: id ? `https://discord.com/channels/@me/${out.channel_id || ''}/${id}` : null,
        accountId: 'webhook',
        text,
        raw: out,
      });
    } catch (e) {
      return this._fail('Discord 发布失败：' + e.message);
    }
  }

  async getAccount() {
    const c = this._config();
    if (!c.webhookUrl) throw new Error('Discord 未配置凭据');
    // Webhook 模式下无法查询账户信息，返回 URL 摘要
    const masked = c.webhookUrl.replace(/\/webhooks\/[^/]+\/[^/]+/, '/webhooks/***/***');
    return { id: 'webhook', name: 'Discord Webhook', url: masked };
  }

  async deletePost(id) {
    // Discord Webhook 不支持删除消息（需要 Bot Token + channel ID + application ID）
    return this._fail('Discord Webhook 不支持删除消息（需升级为 Bot Token 模式）');
  }

  externalPostUrl(accountResource) {
    return accountResource && accountResource.url ? accountResource.url : null;
  }
}

module.exports = { DiscordProvider };
