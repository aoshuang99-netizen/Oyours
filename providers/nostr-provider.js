'use strict';
/**
 * providers/nostr-provider.js — Mixpost 风格 Nostr 提供方适配器
 *
 * 真正的「零账号、零第三方、免费」方案：密钥在本地生成（secp256k1 schnorr），
 * 内容直接发布到去中心化中继（relay），无需任何平台注册/审核/付费。
 *
 * 依赖：@noble/curves/secp256k1（已装入托管 node workspace，纯 JS 无原生依赖）。
 *       WebSocket：Node 22 全局自带，无需额外包。
 *
 * 凭证：
 *   - 私钥（hex 或 nsec）。未配置时可通过 dashboard「生成新密钥」按钮本地生成并保存
 *     （绝对不向任何服务器上报私钥）。
 *   - 中继列表（可选，逗号分隔），默认公共中继。
 *
 * 签名：Nostr 事件 id = sha256(序列化 [0, pubkey, created_at, kind, tags, content])，
 *       再用 schnorr.sign(id, privKey) 生成 64 字节签名。完全本地完成。
 *
 * 网络：relay 通常走 wss。若本机设置了 HTTP_PROXY 导致 wss 直连失败，
 *       本适配器会诚实返回 _fail()，绝不伪造已发布结果。
 *
 * 禁假数据铁律：未配置/签名失败/中继拒绝一律 _fail()，绝不伪造 url/事件。
 */

const crypto = require('crypto');
const { SocialProvider } = require('../social-provider-manager.js');

// ---- bech32 编解码（Nostr npub/nsec 用标准 bech32） ----
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function bech32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (let p = 0; p < values.length; ++p) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ values[p];
    for (let i = 0; i < 5; ++i) {
      if ((top >> i) & 1) chk ^= GEN[i];
    }
  }
  return chk;
}
function bech32HrpExpand(hrp) {
  const ret = [];
  for (let p = 0; p < hrp.length; ++p) ret.push(hrp.charCodeAt(p) >> 5);
  ret.push(0);
  for (let p = 0; p < hrp.length; ++p) ret.push(hrp.charCodeAt(p) & 31);
  return ret;
}
function bech32CreateChecksum(hrp, data) {
  const values = bech32HrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
  const mod = bech32Polymod(values) ^ 1;
  const ret = [];
  for (let p = 0; p < 6; ++p) ret.push((mod >> (5 * (5 - p))) & 31);
  return ret;
}
function bech32Encode(hrp, data) {
  const combined = data.concat(bech32CreateChecksum(hrp, data));
  let ret = hrp + '1';
  for (let p = 0; p < combined.length; ++p) ret += BECH32_CHARSET.charAt(combined[p]);
  return ret;
}
function bech32Decode(str) {
  let hasLower = false, hasUpper = false;
  for (let p = 0; p < str.length; ++p) {
    if (str.charCodeAt(p) >= 97 && str.charCodeAt(p) <= 122) hasLower = true;
    if (str.charCodeAt(p) >= 65 && str.charCodeAt(p) <= 90) hasUpper = true;
  }
  if (hasLower && hasUpper) return null;
  str = str.toLowerCase();
  const pos = str.lastIndexOf('1');
  if (pos < 1 || pos + 7 > str.length) return null;
  const hrp = str.substring(0, pos);
  const data = [];
  for (let p = pos + 1; p < str.length; ++p) {
    const d = BECH32_CHARSET.indexOf(str.charAt(p));
    if (d === -1) return null;
    data.push(d);
  }
  // 校验
  const checksum = data.slice(data.length - 6);
  const body = data.slice(0, data.length - 6);
  const expected = bech32CreateChecksum(hrp, body);
  if (JSON.stringify(checksum) !== JSON.stringify(expected)) return null;
  return { hrp, data: body };
}
function convertBits(data, fromBits, toBits, pad) {
  let acc = 0, bits = 0;
  const ret = [];
  const maxv = (1 << toBits) - 1;
  for (let p = 0; p < data.length; ++p) {
    acc = (acc << fromBits) | data[p];
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      ret.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) ret.push((acc << (toBits - bits)) & maxv);
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv) !== 0) {
    return null;
  }
  return ret;
}
function hexToBytes(hex) {
  const out = [];
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.substr(i, 2), 16));
  return new Uint8Array(out);
}
function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
function encodeNpubNsec(prefix, hexKey) {
  const data5 = convertBits(Array.from(hexToBytes(hexKey)), 8, 5, true);
  return bech32Encode(prefix, data5);
}
function decodeNpubNsec(str) {
  const dec = bech32Decode(str);
  if (!dec) return null;
  const data8 = convertBits(dec.data, 5, 8, false);
  if (!data8) return null;
  return bytesToHex(data8);
}
// 解析 nprofile（TLV：0=pubkey, 1=relay, 2=deprecated）=> { pubkeyHex, relays[] }
function decodeNprofile(str) {
  const dec = bech32Decode(str);
  if (!dec || dec.hrp !== 'nprofile') return null;
  const data8 = convertBits(dec.data, 5, 8, false);
  if (!data8) return null;
  const buf = Buffer.from(data8);
  const out = { pubkeyHex: null, relays: [] };
  let i = 0;
  while (i + 1 < buf.length) {
    const t = buf[i];
    const len = buf[i + 1];
    const v = buf.slice(i + 2, i + 2 + len);
    i += 2 + len;
    if (t === 0) out.pubkeyHex = bytesToHex(v);
    else if (t === 1) out.relays.push(v.toString('utf8'));
  }
  return out;
}

// ---- 懒加载 schnorr 签名库 ----
let _schnorr = null;
function loadSchnorr() {
  if (_schnorr) return _schnorr;
  try {
    const mod = require('@noble/curves/secp256k1');
    _schnorr = mod.schnorr || (mod.default && mod.default.schnorr);
    if (!_schnorr) throw new Error('@noble/curves/secp256k1 未导出 schnorr');
  } catch (e) {
    _schnorr = null;
    console.warn('[NostrProvider] 未能加载 @noble/curves/secp256k1：', e.message);
  }
  return _schnorr;
}

// ---- 代理感知的 WebSocket 构造（让 Nostr 中继在需代理的网络下也能出网） ----
// 沙箱/内网常需经 HTTP_PROXY 才能连 wss；Node 全局 WebSocket 直连会被拦。
// 优先用 undici.WebSocket + ProxyAgent（懒加载，避免无 undici 时崩溃），
// 无代理或 undici 不可用时回退全局 WebSocket。
//
// 【2026-09-21 P0 修复】生产环境实测 `HTTP_PROXY`/`HTTPS_PROXY` **均为空**
// （`_autostart_mscms.bat` 与 `tools/mscms-watchdog.js` 的 BASE_ENV 都没设），
// 而 relay 的 wss 在国内直连必被 GFW 拦 ⇒ **relay 恒失败 ⇒ nostr 通道凭据就绪却 0 投放**。
// 实测：显式注入 `HTTP_PROXY=http://127.0.0.1:10808` 后 3/3 relay 全部 OK。
// 故改为**兜底解析链**，不再要求调用方必须先设标准 env：
//   MSCMS_NOSTR_PROXY（显式，值 off/none/direct/- 表示强制直连）
//   → HTTP_PROXY / http_proxy / HTTPS_PROXY（标准）
//   → TUMBLR_PROXY（项目既有出口变量）
//   → http://127.0.0.1:10808（本项目默认本地出口，由 exit-guard 守护）
const DEFAULT_NOSTR_PROXY = 'http://127.0.0.1:10808';
let _wsDispatcher = null;
let _wsProxyResolved = null;
function resolveWsProxy() {
  if (_wsProxyResolved !== null) return _wsProxyResolved;
  const explicit = String(process.env.MSCMS_NOSTR_PROXY || '').trim();
  if (/^(off|none|direct|-)$/i.test(explicit)) { _wsProxyResolved = ''; return ''; }
  _wsProxyResolved = explicit
    || process.env.HTTP_PROXY || process.env.http_proxy || process.env.HTTPS_PROXY
    || process.env.TUMBLR_PROXY
    || DEFAULT_NOSTR_PROXY;
  return _wsProxyResolved;
}
function getWsDispatcher() {
  if (_wsDispatcher !== null) return _wsDispatcher;
  const proxy = resolveWsProxy();
  if (!proxy) { _wsDispatcher = null; return null; }
  try {
    const undici = require('undici');
    _wsDispatcher = new undici.ProxyAgent(proxy);
    console.log(`[NostrProvider] relay 出口代理 = ${proxy}（来源: ${process.env.MSCMS_NOSTR_PROXY ? 'MSCMS_NOSTR_PROXY' : (process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.TUMBLR_PROXY) ? 'env' : '默认 10808'}）`);
  } catch (e) {
    console.warn('[NostrProvider] 未能加载 undici ProxyAgent，WebSocket 将直连：', e.message);
    _wsDispatcher = null;
  }
  return _wsDispatcher;
}
function newProxiedWebSocket(url) {
  const dispatcher = getWsDispatcher();
  if (dispatcher) {
    try {
      const undici = require('undici');
      return new undici.WebSocket(url, { dispatcher });
    } catch (e) { /* fall through */ }
  }
  if (typeof WebSocket !== 'undefined') return new WebSocket(url);
  throw new Error('无可用 WebSocket 实现（需 Node 22 全局 WebSocket 或 undici）');
}

class NostrProvider extends SocialProvider {
  constructor({ dataStore = null, proxiedFetch = null, values = {} } = {}) {
    super({ values, dataStore });
    this.dataStore = dataStore;
    this.proxiedFetch = proxiedFetch;
  }

  identifier() { return 'nostr'; }
  name() { return 'Nostr'; }
  service() { return 'nostr'; }

  _config() {
    const env = {
      privateKey: process.env.NOSTR_PRIVATE_KEY || '',
      relays: process.env.NOSTR_RELAYS || '',
    };
    let stored = {};
    try { stored = (this.dataStore && this.dataStore.get('nostr_config', 'main')) || {}; } catch (e) { stored = {}; }
    return {
      privateKey: stored.privateKey || env.privateKey || '',
      relays: stored.relays || env.relays || '',
    };
  }

  /** 本地生成新密钥对（绝不外发），返回 { nsec, npub, privateKeyHex, publicKeyHex } */
  generateKeys() {
    if (!loadSchnorr()) throw new Error('缺少 @noble/curves/secp256k1，无法本地生成密钥');
    const priv = crypto.randomBytes(32);
    const privHex = bytesToHex(priv);
    const pub = _schnorr.getPublicKey(privHex);
    const pubHex = bytesToHex(pub);
    return {
      privateKeyHex: privHex,
      publicKeyHex: pubHex,
      nsec: encodeNpubNsec('nsec', privHex),
      npub: encodeNpubNsec('npub', pubHex),
    };
  }

  /** 凭据**格式**校验（同步、零网络）：私钥须为 nsec1… 或 64 位 hex */
  _checkCredFormat() {
    try {
      this._resolveKeys();
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e).slice(0, 160) };
    }
  }

  /**
   * 配置状态。
   * 【2026-09-20 F3】与 bluesky / mastodon 对齐三态口径（configured / format / reachable）。
   *   nostr 原本就比其他两个严格（额外检查 schnorrOk 依赖），此处再补密钥格式与签名自检。
   */
  configStatus() {
    const c = this._config();
    const schnorrOk = !!loadSchnorr();
    const hasCreds = !!(c.privateKey && schnorrOk);
    const fmt = hasCreds ? this._checkCredFormat() : { ok: false, reason: null };
    const probe = this._probeCache || null;
    return {
      identifier: 'nostr',
      configured: hasCreds,
      format: fmt.ok ? 'ok' : 'invalid',
      authorized: hasCreds && fmt.ok && (!probe || probe.ok === true),
      reachable: probe ? (probe.ok ? 'ok' : 'fail') : 'unknown',
      probeAt: probe ? probe.at : null,
      relays: c.relays || null,
      reason: !hasCreds
        ? '尚未配置 NOSTR_PRIVATE_KEY（nsec 或 64 位 hex）。可点击「生成新密钥」在本地创建（零账号/零第三方/免费）。需 @noble/curves 签库：' + (schnorrOk ? '已就绪' : '缺失')
        : (fmt.ok ? null : fmt.reason),
    };
  }

  /**
   * **真实探针（零网络）**：本地做一次密钥解析 + 公钥派生自检。
   * 仅证明**密钥可用**；relay 连通性属出口问题，不在此判定（不伪造「已连通」结论）。
   */
  async verifyCredentials({ force = false } = {}) {
    const now = Date.now();
    if (!force && this._probeCache && now - this._probeCache.at < 10 * 60 * 1000) return this._probeCache;
    let out;
    try {
      const { pubHex } = this._resolveKeys();
      out = { ok: true, at: now, pubkey: pubHex, npub: encodeNpubNsec('npub', pubHex) };
    } catch (e) {
      out = { ok: false, at: now, error: String((e && e.message) || e).slice(0, 200) };
    }
    this._probeCache = out;
    return out;
  }

  _resolveKeys() {
    const c = this._config();
    let privHex = c.privateKey;
    if (privHex.startsWith('nsec1')) {
      privHex = decodeNpubNsec(privHex);
      if (!privHex) throw new Error('nsec 解码失败（格式错误）');
    }
    if (!/^[0-9a-fA-F]{64}$/.test(privHex)) throw new Error('私钥格式错误（需 64 位 hex 或 nsec1...）');
    const pubHex = bytesToHex(_schnorr.getPublicKey(privHex));
    return { privHex, pubHex };
  }

  _defaultRelays() {
    const c = this._config();
    const fromCfg = (c.relays || '').split(',').map(s => s.trim()).filter(Boolean);
    const defaults = ['wss://relay.damus.io', 'wss://relay.primal.net', 'wss://nos.lol'];
    return fromCfg.length ? fromCfg : defaults;
  }

  /** 发布到单个中继，返回 Promise<boolean> */
  _publishToOneRelay(relayUrl, event, timeoutMs = 8000) {
    return new Promise((resolve) => {
      let ws;
      let done = false;
      const finish = (ok, note) => {
        if (done) return;
        done = true;
        try { if (ws && ws.readyState === 1) ws.close(); } catch (e) {}
        clearTimeout(timer);
        resolve({ ok, note });
      };
      let timer;
      try {
        ws = newProxiedWebSocket(relayUrl);
      } catch (e) {
        return finish(false, 'WS 构造失败：' + e.message);
      }
      timer = setTimeout(() => finish(false, '中继超时'), timeoutMs);
      ws.onopen = () => {
        try { ws.send(JSON.stringify(['EVENT', event])); }
        catch (e) { finish(false, '发送失败：' + e.message); }
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (Array.isArray(msg) && msg[0] === 'OK' && msg[1] === event.id) {
            finish(!!msg[2], msg[3] || '');
          }
        } catch (e) {}
      };
      ws.onerror = (err) => finish(false, 'WS 错误');
      ws.onclose = () => finish(false, 'WS 关闭');
    });
  }

  async publishPost(text, media = [], params = {}) {
    if (!loadSchnorr()) {
      return this._fail('Nostr 缺少签名库 @noble/curves/secp256k1（请装入托管 node workspace）', { code: 'DEPS_MISSING' });
    }
    const c = this._config();
    if (!c.privateKey) {
      return this._fail('Nostr 未配置私钥（privateKey 未配置）', { code: 'AUTH_MISSING' });
    }

    let keys;
    try { keys = this._resolveKeys(); }
    catch (e) { return this._fail('Nostr 密钥解析失败：' + e.message); }

    const content = text || 'MSCMS v14 自动发布';
    const createdAt = Math.floor(Date.now() / 1000);
    const tags = Array.isArray(params.tags) ? params.tags.map(t => ['t', String(t)]) : [];

    // 事件 id：sha256(序列化)
    const serialized = JSON.stringify([0, keys.pubHex, createdAt, 1, tags, content]);
    const idHex = crypto.createHash('sha256').update(Buffer.from(serialized, 'utf8')).digest('hex');

    let sigHex;
    try { sigHex = bytesToHex(_schnorr.sign(hexToBytes(idHex), keys.privHex)); }
    catch (e) { return this._fail('Nostr 签名失败：' + e.message); }

    const event = {
      id: idHex,
      pubkey: keys.pubHex,
      created_at: createdAt,
      kind: 1,
      tags,
      content,
      sig: sigHex,
    };

    const relays = this._defaultRelays();
    let okCount = 0;
    const notes = [];
    for (const relay of relays) {
      try {
        const r = await this._publishToOneRelay(relay, event);
        if (r.ok) okCount++;
        else notes.push(`${relay}: ${r.note}`);
      } catch (e) {
        notes.push(`${relay}: ${e.message}`);
      }
    }

    if (okCount === 0) {
      return this._fail('Nostr 发布失败：所有中继均拒绝（' + notes.join(' | ') + '）。若本机设置了 HTTP_PROXY 可能阻断 wss，请直连或配置代理可达的中继');
    }

    // njump.me 是公开的 Nostr note 查看器，用事件 id 即可定位真实内容
    const url = `https://njump.me/${event.id}`;
    return this._ok({
      id: event.id,
      url,
      accountId: encodeNpubNsec('npub', keys.pubHex),
      text: content,
      raw: { relaysOk: okCount, relaysTotal: relays.length, notes },
    });
  }

  async getAccount() {
    const c = this._config();
    if (!c.privateKey) throw new Error('Nostr 未配置私钥');
    let keys;
    try { keys = this._resolveKeys(); }
    catch (e) { throw e; }
    const npub = encodeNpubNsec('npub', keys.pubHex);
    return { id: keys.pubHex, name: npub, url: `https://njump.me/${npub}` };
  }

  async deletePost(id) {
    // Nostr 删除用 kind 5 事件；此处诚实返回未实现（需要原始事件 id 与 relay 列表）
    return this._fail('Nostr 删除需 kind 5 删除事件（待实现）');
  }

  externalPostUrl(accountResource) {
    return accountResource && accountResource.url ? accountResource.url : null;
  }
}

module.exports = { NostrProvider, encodeNpubNsec, decodeNpubNsec, decodeNprofile, hexToBytes, bytesToHex };
