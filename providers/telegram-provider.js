'use strict';
/**
 * providers/telegram-provider.js — Mixpost 风格 Telegram 提供方适配器
 *
 * 官方免费凭证方案：BotFather 即时下发 bot token，无需开发者门户/付费/审核。
 * 获取方式：@BotFather → /newbot → 填写 bot 名 → 获得 bot token（形如 123:ABC）。
 * 频道 chat_id：把 bot 拉入频道并发送消息，调用 getUpdates 取 chat.id（带负号 -100xxx）。
 *
 * 凭证读取顺序（dataStore > 环境变量）：
 *   1) dataStore('telegram_config','main') —— dashboard 表单写入
 *   2) 环境变量 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID
 *
 * 网络：代理同上（中国大陆 proxied）。
 *
 * 禁假数据铁律：未配置/失败一律 _fail()，绝不伪造 url。
 */

const { SocialProvider } = require('../social-provider-manager.js');

class TelegramProvider extends SocialProvider {
  constructor({ dataStore = null, proxiedFetch = null, values = {} } = {}) {
    super({ values, dataStore });
    this.dataStore = dataStore;
    this.proxiedFetch = proxiedFetch;
    this._dispatcher = null;
    this._proxyChecked = false;
  }

  identifier() { return 'telegram'; }
  name() { return 'Telegram'; }
  service() { return 'telegram'; }

  _config() {
    const env = {
      botToken: process.env.TELEGRAM_BOT_TOKEN || '',
      chatId: process.env.TELEGRAM_CHAT_ID || '',
    };
    let stored = {};
    try { stored = (this.dataStore && this.dataStore.get('telegram_config', 'main')) || {}; } catch (e) { stored = {}; }
    return {
      botToken: stored.botToken || env.botToken || '',
      chatId: stored.chatId || env.chatId || '',
    };
  }

  /**
   * 凭据**格式**校验（同步、零网络）。
   * Telegram Bot Token 固定形如 `<bot_id>:<密钥>`（bot_id 为 6~12 位数字，密钥约 35 位）。
   *
   * 【2026-09-20 F3 延伸】原 `configStatus()` 里 `authorized: hasCreds` —— 与 `configured`
   *   完全冗余，一旦填入占位值（如 "test"）就会立刻变成「绿灯但发不出去」的假绿。
   *   此处补格式闸门，**仅收紧 `authorized`**；`configured`（发布路径判据）语义不变。
   */
  _checkCredFormat(c) {
    const tk = String(c.botToken || '');
    if (!/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(tk)) {
      return {
        ok: false,
        reason: `TELEGRAM_BOT_TOKEN 格式无效（当前 ${tk.length} 字符，正确格式为 <bot_id>:<密钥>，形如 123456789:AAH...）⇒ 请到 @BotFather → /newbot 重新获取后填入`,
      };
    }
    const cid = String(c.chatId || '');
    if (!/^(-?\d{5,}|@[A-Za-z0-9_]{4,})$/.test(cid)) {
      return { ok: false, reason: `TELEGRAM_CHAT_ID 格式无效（应为数字 id 或 @channelusername，当前「${cid.slice(0, 24)}」）` };
    }
    return { ok: true };
  }

  configStatus() {
    const c = this._config();
    const hasCreds = !!(c.botToken && c.chatId);
    const fmt = hasCreds ? this._checkCredFormat(c) : { ok: false, reason: null };
    return {
      identifier: 'telegram',
      configured: hasCreds,
      format: fmt.ok ? 'ok' : 'invalid',
      authorized: hasCreds && fmt.ok,
      reachable: 'unknown',
      probeAt: null,
      reason: !hasCreds
        ? '尚未配置 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID。免费获取：@BotFather → /newbot → 获得 bot token；频道 chat_id 用 getUpdates 取（无需开发者门户/付费/审核）'
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
        console.log('[TelegramProvider] 使用代理 dispatcher:', proxy);
      } catch (e) {
        console.warn('[TelegramProvider] 未能加载 undici.ProxyAgent，将直连（可能失败）：', e.message);
      }
    }
    return this._dispatcher;
  }

  async _api(method, body) {
    const c = this._config();
    const dispatcher = await this._ensureDispatcher();
    const url = `https://api.telegram.org/bot${c.botToken}/${method}`;
    const opts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body || {}),
    };
    if (dispatcher) opts.dispatcher = dispatcher;
    const res = await fetch(url, opts);
    const text = await res.text();
    let out = null;
    try { out = text ? JSON.parse(text) : null; } catch (e) { out = null; }
    if (!res.ok || (out && !out.ok)) {
      const err = (out && out.description) ? out.description : ('HTTP ' + res.status);
      const e = new Error(`Telegram API: ${err}`);
      e.code = res.status;
      throw e;
    }
    return out;
  }

  async publishPost(text, media = [], params = {}) {
    const c = this._config();
    if (!c.botToken || !c.chatId) {
      return this._fail('Telegram 未配置凭据（botToken/chatId 均未配置）', { code: 'AUTH_MISSING' });
    }

    // Telegram 支持发送图片（通过 filePath 或 URL）
    const imageMedia = (media || []).find(m => m && (m.type === 'image' || (m.filePath && /\.(png|jpe?g|gif|webp)$/i.test(m.filePath))));
    try {
      if (imageMedia && imageMedia.filePath) {
        // sendPhoto 需 multipart/form-data 上传本地文件
        const fs = require('fs');
        const dispatcher = await this._ensureDispatcher();
        const url = `https://api.telegram.org/bot${c.botToken}/sendPhoto`;
        const FormData = require('form-data');
        const form = new FormData();
        form.append('chat_id', c.chatId);
        if (text) form.append('caption', text);
        form.append('photo', fs.createReadStream(imageMedia.filePath));
        const opts = {
          method: 'POST',
          headers: form.getHeaders(),
          body: form,
        };
        if (dispatcher) opts.dispatcher = dispatcher;
        const res = await fetch(url, opts);
        const txt = await res.text();
        let out = null;
        try { out = JSON.parse(txt); } catch (e) { out = null; }
        if (!res.ok || (out && !out.ok)) {
          return this._fail('Telegram 图片发送失败：' + ((out && out.description) || ('HTTP ' + res.status)));
        }
        const msgId = out && out.result && out.result.message_id;
        const link = msgId ? `https://t.me/c/${String(c.chatId).replace(/^-100/, '')}/${msgId}` : null;
        return this._ok({ id: String(msgId || ''), url: link, accountId: c.chatId, text, raw: out });
      }
      // 纯文本：sendMessage
      const out = await this._api('sendMessage', {
        chat_id: c.chatId,
        text: text || 'MSCMS v14 自动发布',
        parse_mode: params.parseMode || 'HTML',
      });
      const msgId = out && out.result && out.result.message_id;
      const link = msgId ? `https://t.me/c/${String(c.chatId).replace(/^-100/, '')}/${msgId}` : null;
      return this._ok({ id: String(msgId || ''), url: link, accountId: c.chatId, text, raw: out });
    } catch (e) {
      return this._fail('Telegram 发布失败：' + e.message);
    }
  }

  async getAccount() {
    const c = this._config();
    if (!c.botToken) throw new Error('Telegram 未配置凭据');
    let me = null;
    try { me = await this._api('getMe', {}); } catch (e) { me = null; }
    const name = (me && me.result && me.result.username) ? '@' + me.result.username : c.chatId;
    return { id: c.chatId, name, url: name.startsWith('@') ? 'https://t.me/' + name.slice(1) : null };
  }

  async deletePost(id) {
    if (!id) return this._fail('Telegram 删除需要 message_id');
    const c = this._config();
    if (!c.botToken || !c.chatId) return this._fail('Telegram 未配置凭据');
    try {
      await this._api('deleteMessage', { chat_id: c.chatId, message_id: Number(id) });
      return this._ok({ id, deleted: true });
    } catch (e) {
      return this._fail('Telegram 删除失败：' + e.message);
    }
  }

  externalPostUrl(accountResource) {
    return accountResource && accountResource.url ? accountResource.url : null;
  }
}

module.exports = { TelegramProvider };
