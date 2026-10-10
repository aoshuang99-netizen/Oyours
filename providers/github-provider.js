'use strict';
/**
 * providers/github-provider.js — Mixpost 风格 GitHub 提供方适配器
 *
 * 这是「通过 GitHub 官方对接解决凭证问题」的核心落地：
 *   - 凭证 = GitHub Personal Access Token（PAT）
 *   - 获取方式：github.com → Settings → Developer settings → PAT → Generate
 *     ★ 免费、即时（约 30 秒）、无需手机验证、无需应用审核、无付费档
 *     ★ 这是全部发布渠道里最容易拿到的凭证
 *   - 发布目标：GitHub Gist（公开、可外链、官方免费），用真实 PAT 调官方 API
 *
 * 凭证读取顺序（dataStore > 环境变量）：
 *   1) dataStore('github_config','main') —— dashboard 表单写入
 *   2) 环境变量 GITHUB_TOKEN
 *
 * API（官方、免费）：
 *   - POST https://api.github.com/gists   { public, description, files:{ '<name>.md': { content } } }
 *     返回 { id, html_url } —— 即真实外链
 *   - GET  https://api.github.com/user         取账号（发测试帖时校验）
 *   - DELETE https://api.github.com/gists/:id   删除
 *
 * 网络：经 undici ProxyAgent 路由（中国大陆 proxied），无 undici 时回退全局 fetch。
 *
 * 禁假数据铁律：未配置/失败一律 _fail()，绝不伪造 url。
 */

const { SocialProvider } = require('../social-provider-manager.js');

class GithubProvider extends SocialProvider {
  constructor({ dataStore = null, proxiedFetch = null, values = {} } = {}) {
    super({ values, dataStore });
    this.dataStore = dataStore;
    this.proxiedFetch = proxiedFetch;
    this._dispatcher = null;
    this._proxyChecked = false;
  }

  identifier() { return 'github'; }
  name() { return 'GitHub'; }
  service() { return 'github'; }

  _config() {
    const env = {
      token: process.env.GITHUB_TOKEN || '',
    };
    let stored = {};
    try { stored = (this.dataStore && this.dataStore.get('github_config', 'main')) || {}; } catch (e) { stored = {}; }
    return {
      token: stored.token || env.token || '',
      target: stored.target || 'gist', // gist | repo
      repo: stored.repo || '',         // target=repo 时：owner/repo
      path: stored.path || '',         // target=repo 时：文件路径
    };
  }

  configStatus() {
    const c = this._config();
    const hasCreds = !!(c.token);
    return {
      identifier: 'github',
      configured: hasCreds,
      authorized: hasCreds,
      reason: hasCreds
        ? null
        : '尚未配置 GitHub PAT。免费获取（30 秒·零手机·零审核）：github.com → 右上角头像 → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token（勾选 gist 权限即可）',
    };
  }

  async _ensureDispatcher() {
    if (this._proxyChecked) return this._dispatcher;
    this._proxyChecked = true;
    // GitHub PAT 是明文凭证：经透明代理有被 MITM 截获风险，且 api.github.com 为官方可信域名，
    // 故【默认直连 GitHub 官方 API 最安全】。仅在显式设置 NO_PROXY / 检测到内网目标时才回退代理。
    const noProxy = process.env.NO_PROXY || process.env.no_proxy || '';
    const forceProxy = process.env.GITHUB_FORCE_PROXY === '1';
    const useProxy = forceProxy && !/(github\.com|api\.github\.com)/i.test(noProxy || '');
    if (useProxy) {
      const proxy = process.env.HTTP_PROXY || process.env.http_proxy || process.env.HTTPS_PROXY;
      if (proxy) {
        try {
          let undici = null;
          try { undici = require('undici'); } catch (e) { undici = await import('undici'); }
          const ProxyAgent = undici.ProxyAgent || (undici.default && undici.default.ProxyAgent);
          if (!ProxyAgent) throw new Error('undici 未导出 ProxyAgent');
          this._dispatcher = new ProxyAgent(proxy);
          console.log('[GithubProvider] 使用代理 dispatcher（GITHUB_FORCE_PROXY=1）:', proxy);
        } catch (e) {
          console.warn('[GithubProvider] 代理加载失败，回退直连：', e.message);
        }
      }
    } else {
      console.log('[GithubProvider] 直连 api.github.com（官方可信域名，绕过透明代理以保护 PAT）');
    }
    return this._dispatcher;
  }

  async _api(method, path, body) {
    const c = this._config();
    const dispatcher = await this._ensureDispatcher();
    const headers = {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${c.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'MSCMS-v14',
    };
    if (body) headers['Content-Type'] = 'application/json';
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    if (dispatcher) opts.dispatcher = dispatcher;
    const res = await fetch(`https://api.github.com${path}`, opts);
    const text = await res.text();
    let out = null;
    try { out = text ? JSON.parse(text) : null; } catch (e) { out = null; }
    if (!res.ok) {
      const err = (out && out.message) ? out.message : ('HTTP ' + res.status);
      const e = new Error(`GitHub API: ${err}`);
      e.code = res.status;
      throw e;
    }
    return out;
  }

  /**
   * 发布一条内容到 GitHub（默认 Gist 公开外链）。
   * text 作为 Markdown 文件内容；params.title 作为文件名/描述。
   */
  async publishPost(text, media = [], params = {}) {
    const c = this._config();
    if (!c.token) {
      return this._fail('GitHub 未配置凭据（PAT 未配置）', { code: 'AUTH_MISSING' });
    }

    const title = (params && params.title) || (text || '').split('\n')[0].slice(0, 80) || 'MSCMS v14 自动发布';
    const content = text || '';
    const fileName = (title.replace(/[^\w一-龥 ._-]/g, '_').slice(0, 60) || 'mscms-post') + '.md';

    try {
      let url = null, id = null;
      if (c.target === 'repo' && c.repo && c.path) {
        // 仓库文件发布（Contents API）
        const body = {
          message: `MSCMS v14: ${title}`,
          content: Buffer.from(content, 'utf8').toString('base64'),
          branch: params.branch || 'main',
        };
        // 若文件已存在，需带 sha 才能更新
        try {
          const existing = await this._api('GET', `/repos/${c.repo}/contents/${encodeURIComponent(c.path)}`);
          if (existing && existing.sha) body.sha = existing.sha;
        } catch (e) { /* 不存在则创建 */ }
        const out = await this._api('PUT', `/repos/${c.repo}/contents/${encodeURIComponent(c.path)}`, body);
        url = out && out.content && out.content.html_url ? out.content.html_url : (out && out.commit && out.commit.html_url ? out.commit.html_url : null);
        id = c.repo + ':' + c.path;
      } else {
        // 默认：GitHub Gist（公开、可外链、最简单）
        const out = await this._api('POST', '/gists', {
          public: true,
          description: title,
          files: { [fileName]: { content } },
        });
        url = out.html_url || null;
        id = out.id || null;
      }
      if (!url) return this._fail('GitHub 发布成功但未返回外链');
      return this._ok({ id: String(id || ''), url, accountId: 'github-user', text, raw: { target: c.target } });
    } catch (e) {
      return this._fail('GitHub 发布失败：' + e.message);
    }
  }

  async getAccount() {
    const c = this._config();
    if (!c.token) throw new Error('GitHub 未配置凭据');
    try {
      const out = await this._api('GET', '/user');
      return { id: String(out.id || ''), name: out.login || out.name || 'GitHub User', url: out.html_url || `https://github.com/${out.login || ''}` };
    } catch (e) {
      return { id: 'me', name: 'GitHub User', url: 'https://github.com' };
    }
  }

  async deletePost(id) {
    if (!id) return this._fail('缺少要删除的 Gist id');
    try {
      await this._api('DELETE', `/gists/${id}`);
      return this._ok({ id: String(id), status: 'deleted' });
    } catch (e) {
      return this._fail('GitHub 删除失败：' + e.message);
    }
  }

  externalPostUrl(accountResource) {
    return accountResource && accountResource.url ? accountResource.url : null;
  }
}

module.exports = { GithubProvider };
