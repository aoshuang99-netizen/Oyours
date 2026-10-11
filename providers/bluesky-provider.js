'use strict';
/**
 * providers/bluesky-provider.js — Mixpost 风格 Bluesky (AT 协议) 提供方适配器
 *
 * 移植自 https://github.com/09ashishkapoor/karaya-autopost (post_next_bluesky.py) 的
 * 零依赖 AT 协议发帖实现，原生接入 MSCMS v14 的 Mixpost SocialProvider 契约。
 *
 * 为何选 Bluesky 而非 Tumblr：
 *  - Tumblr 仍需注册 App 拿 client_id/secret（非免费、需人工审批）。
 *  - Bluesky 用「账号 + 设置里【自生成】的 App Password」即可发帖：
 *    ❌ 不需要开发者门户   ❌ 不需要注册 App   ❌ 没有付费 tier
 *    ✅ 免费、2 分钟拿到凭据 → 这是真正「免费的 key/secret」路径。
 *
 * 凭证读取顺序（与 karaya-autopost 的 BLUESKY_IDENTIFIER/BLUESKY_APP_PASSWORD 约定一致）：
 *   1) dataStore('bluesky_config','main') —— dashboard 表单写入
 *   2) 环境变量 BLUESKY_IDENTIFIER / BLUESKY_APP_PASSWORD / BLUESKY_PDS_HOST
 *   3) PDS 默认 https://bsky.social
 *
 * 网络：本机位于中国大陆，Bluesky 为国外域名，必须走 HTTP_PROXY 代理。
 * Node 22 的全局 fetch(undici) 默认忽略 HTTP_PROXY，故用 undici.ProxyAgent 显式路由。
 *
 * 禁假数据铁律：未配置 / 登录失败 / 发布失败一律返回 _fail()（status='failed'），
 * 绝不伪造 uri / 帖子链接；凭证缺失时不触碰网络。
 */

const fs = require('fs');
const { SocialProvider } = require('../social-provider-manager.js');

class BlueskyProvider extends SocialProvider {
  constructor({ dataStore = null, proxiedFetch = null, values = {} } = {}) {
    super({ values, dataStore });
    this.dataStore = dataStore;
    this.proxiedFetch = proxiedFetch;
    this._dispatcher = null;
    this._proxyChecked = false;
  }

  identifier() { return 'bluesky'; }
  name() { return 'Bluesky'; }
  service() { return 'bluesky'; }

  /** 合并凭证：dataStore > 环境变量 > 默认 PDS */
  _config() {
    const env = {
      identifier: process.env.BLUESKY_IDENTIFIER || '',
      appPassword: process.env.BLUESKY_APP_PASSWORD || '',
      pdsHost: (process.env.BLUESKY_PDS_HOST || 'https://bsky.social').replace(/\/+$/, ''),
    };
    let stored = {};
    try {
      stored = (this.dataStore && this.dataStore.get('bluesky_config', 'main')) || {};
    } catch (e) { stored = {}; }
    return {
      identifier: stored.identifier || env.identifier || '',
      appPassword: stored.appPassword || env.appPassword || '',
      pdsHost: (stored.pdsHost || env.pdsHost || 'https://bsky.social').replace(/\/+$/, ''),
    };
  }

  /**
   * 凭据**格式**校验（同步、零网络）。
   * Bluesky App Password 固定形如 `abcd-efgh-ijkl-mnop`（4 组 4 位小写字母数字，共 19 字符）。
   */
  _checkCredFormat(c) {
    const pw = String(c.appPassword || '');
    if (!/^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/i.test(pw)) {
      return {
        ok: false,
        reason: `BLUESKY_APP_PASSWORD 格式无效（当前 ${pw.length} 字符，正确格式为 abcd-efgh-ijkl-mnop 共 19 字符）⇒ 该凭据无法通过登录，请到 Bluesky「设置 → App Passwords」重新生成后填入`,
      };
    }
    const id = String(c.identifier || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id) && !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(id)) {
      return { ok: false, reason: `BLUESKY_IDENTIFIER 格式无效（应为邮箱或 handle，当前「${id.slice(0, 24)}」）` };
    }
    return { ok: true };
  }

  /**
   * 配置状态（驱动 dashboard + 决定桥接是否推进 S4）。
   *
   * 【2026-09-20 F3 修复】原实现 `authorized: hasCreds`(仅判字段非空)，
   *   导致 9 字节占位值 `12233556…` 也被报成「已授权」——实测 createSession 返回 401，
   *   仪表盘出现「绿灯但一条都发不出去」的**假绿**（4 个绿灯里 2 个是假的）。
   *   现改为三态：configured(字段非空) / format(格式是否合法) / reachable(真实探针结果)。
   *   ⚠️ `configured` 语义**保持不变**（发布路径 cloud-publisher.js:1097 依赖它），
   *      只收紧 `authorized` —— 该字段此前只用于展示，不参与发布判定。
   */
  configStatus() {
    const c = this._config();
    const hasCreds = !!(c.identifier && c.appPassword);
    const fmt = hasCreds ? this._checkCredFormat(c) : { ok: false, reason: null };
    const probe = this._probeCache || null;
    return {
      identifier: 'bluesky',
      configured: hasCreds,
      format: fmt.ok ? 'ok' : 'invalid',
      authorized: hasCreds && fmt.ok && (!probe || probe.ok === true),
      reachable: probe ? (probe.ok ? 'ok' : 'fail') : 'unknown',
      probeAt: probe ? probe.at : null,
      pdsHost: c.pdsHost,
      reason: !hasCreds
        ? '尚未配置 BLUESKY_IDENTIFIER / BLUESKY_APP_PASSWORD。免费获取：注册 Bluesky 账号 → 设置 → App Passwords → 生成（无需开发者门户/App 注册/付费）'
        : (fmt.ok ? null : fmt.reason),
    };
  }

  /**
   * **真实探针**：调用 createSession 验证凭据是否真的可用（结果缓存 10 分钟）。
   * 不抛异常，返回结构化结果；用于让「格式对但认证失败」这类隐性失效可见。
   */
  async verifyCredentials({ force = false } = {}) {
    const now = Date.now();
    if (!force && this._probeCache && now - this._probeCache.at < 10 * 60 * 1000) {
      return this._probeCache;
    }
    const c = this._config();
    let out;
    try {
      const s = await this._createSession();
      out = { ok: true, at: now, handle: s.handle, did: s.did };
    } catch (e) {
      out = { ok: false, at: now, error: String((e && e.message) || e).slice(0, 200) };
    }
    this._probeCache = out;
    return out;
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
        console.log('[BlueskyProvider] 使用代理 dispatcher:', proxy);
      } catch (e) {
        console.warn('[BlueskyProvider] 未能加载 undici.ProxyAgent，将直连（可能失败）：', e.message);
      }
    }
    return this._dispatcher;
  }

  async _fetchJson(url, payload, headers) {
    const dispatcher = await this._ensureDispatcher();
    const opts = {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', Accept: 'application/json' }, headers || {}),
      body: JSON.stringify(payload),
    };
    if (dispatcher) opts.dispatcher = dispatcher;
    const res = await fetch(url, opts);
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
    if (!res.ok) {
      const err = (body && (body.message || body.error))
        ? `${body.error ? body.error + ' - ' : ''}${body.message}`.trim()
        : `HTTP ${res.status}`;
      const e = new Error(`Bluesky API ${res.status}: ${err}`);
      e.code = res.status;
      throw e;
    }
    return body;
  }

  /** createSession：identifier + appPassword → { did, handle, accessJwt } */
  async _createSession() {
    const c = this._config();
    if (!c.identifier || !c.appPassword) {
      const e = new Error('缺少 Bluesky 凭据（identifier/appPassword 均未配置）');
      e.code = 'AUTH_MISSING';
      throw e;
    }
    const r = await this._fetchJson(`${c.pdsHost}/xrpc/com.atproto.server.createSession`, {
      identifier: c.identifier,
      password: c.appPassword,
    });
    return { pdsHost: c.pdsHost, did: r.did, handle: r.handle, accessJwt: r.accessJwt };
  }

  /** uploadBlob：本地图片 → AT 协议 blob 引用 */
  async _uploadBlob(filePath, accessJwt, pdsHost) {
    const data = fs.readFileSync(filePath);
    const ext = (filePath.split('.').pop() || '').toLowerCase();
    const mime = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' })[ext] || 'application/octet-stream';
    const dispatcher = await this._ensureDispatcher();
    const opts = {
      method: 'POST',
      headers: { 'Content-Type': mime, Authorization: `Bearer ${accessJwt}` },
      body: data,
    };
    if (dispatcher) opts.dispatcher = dispatcher;
    const res = await fetch(`${pdsHost}/xrpc/com.atproto.repo.uploadBlob`, opts);
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error('blob 上传失败: ' + (out.message || res.status));
    return out.blob; // { $type:'blob', ref, mimeType, size }
  }

  /**
   * 发布一条内容（Mixpost 契约：publishPost(text, media, params)）
   * @param {string} text   文案
   * @param {Array}  media  [{ type:'image', filePath }] —— 可选，本地图片
   * @param {object} params { langs, alt }
   */
  async publishPost(text, media = [], params = {}) {
    let session;
    try {
      session = await this._createSession();
    } catch (e) {
      if (e.code === 'AUTH_MISSING') return this._fail('Bluesky 未配置凭据：' + e.message);
      return this._fail('Bluesky 登录失败：' + e.message);
    }

    const record = {
      $type: 'app.bsky.feed.post',
      text: text || '',
      createdAt: new Date().toISOString(),
      langs: Array.isArray(params.langs) && params.langs.length ? params.langs : ['en'],
    };

    // 可选：本地图片 blob 嵌入（不支持视频，仅文本 + 图片）
    const imageMedia = (media || []).find(m =>
      m && (m.type === 'image' ||
        (m.filePath && /\.(png|jpe?g|gif|webp)$/i.test(m.filePath))));
    if (imageMedia && imageMedia.filePath && fs.existsSync(imageMedia.filePath)) {
      try {
        const blob = await this._uploadBlob(imageMedia.filePath, session.accessJwt, session.pdsHost);
        record.embed = {
          $type: 'app.bsky.embed.images',
          images: [{ image: blob, alt: (params.alt || (text || '').slice(0, 80)) }],
        };
      } catch (e) {
        // 图片嵌入失败：仍允许纯文本发布（Bluesky 文本为本位内容），记录降级
        console.warn('[BlueskyProvider] 图片嵌入失败，改为纯文本发布：', e.message);
      }
    }

    try {
      const r = await this._fetchJson(
        `${session.pdsHost}/xrpc/com.atproto.repo.createRecord`,
        { repo: session.did, collection: 'app.bsky.feed.post', record },
        { Authorization: `Bearer ${session.accessJwt}` });
      const uri = r.uri || '';
      const rkey = uri.split('/').pop();
      const webUrl = `https://bsky.app/profile/${session.handle}/post/${rkey}`;
      return this._ok({ id: rkey, url: webUrl, accountId: session.handle, text, raw: r });
    } catch (e) {
      return this._fail('Bluesky 发布失败：' + e.message, { accountId: session.handle });
    }
  }

  async getAccount() {
    const c = this._config();
    if (!c.identifier || !c.appPassword) throw new Error('Bluesky 未配置凭据');
    return { id: c.identifier, name: c.identifier, url: `https://bsky.app/profile/${c.identifier}` };
  }

  async deletePost(id) {
    // AT 协议删除需 com.atproto.repo.deleteRecord，暂诚实返回未实现
    return this._fail('Bluesky 帖子删除尚未实现（deleteRecord 端点待补）');
  }

  externalPostUrl(accountResource) {
    return accountResource && accountResource.url ? accountResource.url : null;
  }
}

module.exports = { BlueskyProvider };
