'use strict';
/**
 * providers/mastodon-provider.js — Mixpost 风格 Mastodon 提供方适配器
 *
 * 移植自 https://github.com/09ashishkapoor/karaya-autopost 的「免费社媒」思路，
 * 原生接入 MSCMS v14 的 Mixpost SocialProvider 契约。
 *
 * 为何选 Mastodon 作为第 2 个免费渠道（接 Bluesky 之后）：
 *  - 任意 Mastodon 实例（mastodon.social / 自建）账号 → 设置 → 开发 → 个人访问令牌
 *    ❌ 不需要开发者门户审批   ❌ 没有付费 tier   ❌ 没有应用审查
 *    ✅ 免费、自助生成 access token → 立即真实发帖。
 *
 * 凭证读取顺序（dataStore > 环境变量 > 默认实例）：
 *   1) dataStore('mastodon_config','main') —— dashboard 表单写入
 *   2) 环境变量 MASTODON_INSTANCE / MASTODON_ACCESS_TOKEN
 *   3) 实例默认 https://mastodon.social
 *
 * 网络：中国大陆需走 HTTP_PROXY 代理；Node 22 全局 fetch(undici) 默认忽略 HTTP_PROXY，
 * 故用 undici.ProxyAgent 显式路由（兼容 ESM-only undici）。
 *
 * 禁假数据铁律：未配置 / 登录失败 / 发布失败一律返回 _fail()（status='failed'），
 * 绝不伪造 uri / 帖子链接；凭证缺失时不触碰网络。
 */

const fs = require('fs');
const { SocialProvider } = require('../social-provider-manager.js');

class MastodonProvider extends SocialProvider {
  constructor({ dataStore = null, proxiedFetch = null, values = {} } = {}) {
    super({ values, dataStore });
    this.dataStore = dataStore;
    this.proxiedFetch = proxiedFetch;
    this._dispatcher = null;
    this._proxyChecked = false;
  }

  identifier() { return 'mastodon'; }
  name() { return 'Mastodon'; }
  service() { return 'mastodon'; }

  /** 合并凭证：dataStore > 环境变量 > 默认实例 */
  _config() {
    const env = {
      instance: (process.env.MASTODON_INSTANCE || 'https://mastodon.social').replace(/\/+$/, ''),
      accessToken: process.env.MASTODON_ACCESS_TOKEN || '',
    };
    let stored = {};
    try {
      stored = (this.dataStore && this.dataStore.get('mastodon_config', 'main')) || {};
    } catch (e) { stored = {}; }
    return {
      instance: (stored.instance || env.instance || 'https://mastodon.social').replace(/\/+$/, ''),
      accessToken: stored.accessToken || env.accessToken || '',
    };
  }

  /** 配置状态（驱动 dashboard + 决定桥接是否推进 S4） */
  configStatus() {
    const c = this._config();
    const hasCreds = !!(c.instance && c.accessToken);
    return {
      identifier: 'mastodon',
      configured: hasCreds,
      authorized: hasCreds,
      instance: c.instance,
      reason: hasCreds
        ? null
        : '尚未配置 MASTODON_INSTANCE / MASTODON_ACCESS_TOKEN。免费获取：注册 Mastodon 账号 → 设置 → 开发 → 新建应用/个人访问令牌（无需开发者门户/付费/审核）',
    };
  }

  /** 懒加载 ProxyAgent：仅当存在 HTTP(S)_PROXY 时启用（兼容 ESM-only 的 undici） */
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
        console.log('[MastodonProvider] 使用代理 dispatcher:', proxy);
      } catch (e) {
        console.warn('[MastodonProvider] 未能加载 undici.ProxyAgent，将直连（可能失败）：', e.message);
      }
    }
    return this._dispatcher;
  }

  async _api(method, path, { json, form, raw } = {}) {
    const c = this._config();
    const dispatcher = await this._ensureDispatcher();
    const url = `${c.instance}${path}`;
    const headers = { Accept: 'application/json', Authorization: `Bearer ${c.accessToken}` };
    const opts = { method, headers };
    if (json) { headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(json); }
    if (form) {
      // form: { file: Buffer, field:'file', mime, name }
      const boundary = '----MSCMSmast' + Date.now().toString(16);
      headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
      let body = '';
      for (const [k, v] of Object.entries(form.fields || {})) body += `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
      if (form.file != null) {
        const bin = form.file.toString('binary');
        body += `--${boundary}\r\nContent-Disposition: form-data; name="${form.field}"`;
        if (form.name) body += `; filename="${form.name}"`;
        body += `\r\nContent-Type: ${form.mime}\r\n\r\n${bin}\r\n`;
      }
      body += `--${boundary}--\r\n`;
      opts.body = Buffer.from(body, 'binary');
    }
    if (raw) { Object.assign(opts, raw); delete opts.body; }
    if (dispatcher) opts.dispatcher = dispatcher;
    const res = await fetch(url, opts);
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
    if (!res.ok) {
      const err = (body && (body.error || body.message))
        ? `${body.error || ''}`.trim() || `HTTP ${res.status}`
        : `HTTP ${res.status}`;
      const e = new Error(`Mastodon API ${res.status}: ${err}`);
      e.code = res.status;
      throw e;
    }
    return body;
  }

  /** 上传本地图片到 Mastodon 媒体端点，返回 media_id */
  async _uploadMedia(filePath) {
    const data = fs.readFileSync(filePath);
    const ext = (filePath.split('.').pop() || '').toLowerCase();
    const mime = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4' })[ext] || 'application/octet-stream';
    const out = await this._api('POST', '/api/v2/media', {
      form: { file: data, field: 'file', mime, name: `media.${ext}`, fields: {} },
    });
    return out.id;
  }

  /**
   * 发布一条内容（Mixpost 契约：publishPost(text, media, params)）
   * @param {string} text   文案
   * @param {Array}  media  [{ type:'image'|'video', filePath }] —— 可选，本地文件
   * @param {object} params { spoilerText, visibility }
   */
  async publishPost(text, media = [], params = {}) {
    const c = this._config();
    if (!c.instance || !c.accessToken) {
      return this._fail('Mastodon 未配置凭据（instance/accessToken 均未配置）', { code: 'AUTH_MISSING' });
    }

    // 可选：上传媒体 -> media_ids[]
    const mediaIds = [];
    for (const m of (media || [])) {
      if (m && m.filePath && fs.existsSync(m.filePath)) {
        try {
          const id = await this._uploadMedia(m.filePath);
          if (id) mediaIds.push(id);
        } catch (e) {
          console.warn('[MastodonProvider] 媒体上传失败，跳过该媒体：', e.message);
        }
      }
    }

    try {
      const payload = {
        status: text || '',
        media_ids: mediaIds.length ? mediaIds : undefined,
        visibility: params.visibility || 'public',
      };
      if (params.spoilerText) payload.spoiler_text = params.spoilerText;
      const r = await this._api('POST', '/api/v1/statuses', { json: payload });
      return this._ok({
        id: r.id,
        url: r.url || `${c.instance}/@me/${r.id}`,
        accountId: c.instance,
        text,
        raw: r,
      });
    } catch (e) {
      return this._fail('Mastodon 发布失败：' + e.message, { instance: c.instance });
    }
  }

  async getAccount() {
    const c = this._config();
    if (!c.instance || !c.accessToken) throw new Error('Mastodon 未配置凭据');
    let me = null;
    try { me = await this._api('GET', '/api/v1/accounts/verify_credentials'); } catch (e) { me = null; }
    const handle = me && me.username ? `@${me.username}@${c.instance.replace(/^https?:\/\//, '')}` : c.instance;
    return { id: c.instance, name: handle, url: c.instance };
  }

  async deletePost(id) {
    if (!id) return this._fail('Mastodon 删除需要 post id');
    try {
      await this._api('DELETE', `/api/v1/statuses/${id}`);
      return this._ok({ id, deleted: true });
    } catch (e) {
      return this._fail('Mastodon 删除失败：' + e.message);
    }
  }

  externalPostUrl(accountResource) {
    return accountResource && accountResource.url ? accountResource.url : null;
  }
}

module.exports = { MastodonProvider };
