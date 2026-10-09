'use strict';
/**
 * tumblr-publisher.js — Tumblr 真实 OAuth1.0a 发布器
 *
 * 为什么需要它：用户对 Tumblr 发布的硬性要求 = “发布成功后要有真实发布链接”。
 * 只有走 Tumblr 官方 OAuth1.0a 上传视频，才能拿回真实的 post_url。
 *
 * 凭证策略（“自动化解决API凭证”）：
 *  - 用户只做【一件事】：在 https://www.tumblr.com/oauth/apps 注册一个应用，拿到
 *    consumer_key /  并粘贴进来（这是法律要求必须由账号持有者完成的动作）。
 *  - 之后的 OAuth 握手（request_token → authorize → ）全部由本模块自动化完成。
 *  - 授权一次后， 持久化在 DataStore，后续发布无需再次登录。
 *
 * 接口：
 *  - setConsumerKey(key, secret)
 *  - beginAuth()                     -> { authorizeUrl }
 *  - completeAuth(verifier)          -> { blogName }
 *  - getStatus()                     -> { hasConsumerKey, authorized, blogName }
 *  - publishVideo({ filePath, caption, tags, title }) -> { postUrl, postId }
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { fetchExt } = require('./http-client');
const { MOBILE_DEVICES } = require('./mobile-emulator.js');
const { hashStr } = require('./proxy-pool'); // 与 proxy-pool.js 一致的确定性哈希（按账号分散 App/IP）

// 移动端 UA 池（与 mobile-emulator 设备库一致），供养号引擎按账号绑定移动指纹，
// 使 OAuth API 足迹与移动网页浏览指纹完全对齐（反关联 / 真实移动端养号）。
const MOBILE_UA_POOL = Object.values(MOBILE_DEVICES).map((d) => d.userAgent);

const REQUEST_TOKEN_URL = 'https://www.tumblr.com/oauth/request_token';
const ACCESS_TOKEN_URL = 'https://www.tumblr.com/oauth/';
const AUTHORIZE_URL = 'https://www.tumblr.com/oauth/authorize';
const API_BASE = 'https://api.tumblr.com/v2';

/**
 * 主动限流令牌桶（缓解 429，无需多出口 IP 也能降低触发率）。
 * 默认关闭（rpm<=0）。开启后按「每个 OAuth App」+「全局」双维度平滑请求速率，
 * 使单 IP + 单 app-key 下的聚合请求速率稳定低于 Tumblr 限流阈值，从而少触发/不触发 429。
 * 仅增加等待，绝不抛错或丢弃请求（安全可控，可随时通过环境变量开关）。
 */
class _TokenBucket {
  constructor(rpm) {
    this.refillPerMs = (rpm || 0) / 60000;                                   // 每毫秒补充的令牌数
    this.capacity = this.refillPerMs > 0 ? Math.max(1, Math.ceil(rpm / 6)) : 0; // 突发容量≈10s 额度
    this.tokens = this.capacity;
    this.last = Date.now();
  }
  async take() {
    if (this.refillPerMs <= 0) return;                                       // 关闭
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) * this.refillPerMs);
    this.last = now;
    if (this.tokens >= 1) { this.tokens -= 1; return; }
    const wait = Math.min((1 - this.tokens) / this.refillPerMs, 8000);       // 单次最多等 8s
    await new Promise((r) => setTimeout(r, wait));
    this.tokens = 0; this.last = Date.now();
  }
}

// RFC 5849 / Twitter-Tumblr 兼容的百分号编码（与 oauth-1.0a 库一致）
 percentEncode(str) {
  return encodeURIComponent(str).replace(/[!*'()]/g, c => '%' + c.charCodeAt(016).toUpperCase());
}

 genNonce() { return crypto.randomBytes(16'hex'); }
 genTimestamp() { return Math.floor(Date.now() / 1000); }

/**
 * 手工构造 multipart/form-data body（显式 boundary）。
 * 注意：undici 的 FormData + Blob + ProxyAgent dispatcher 在上传二进制时
 * 会丢失文件内容，导致 Tumblr 收不到 data 而返回 401/code 1016。
 * 手工拼装 Buffer 可绕过该问题，且与代理 dispatcher 完全兼容。
 * @param fields 参与签名的文本字段对象
 * @param file   { name, data(Buffer) } 视频二进制
 */
 buildMultipartBody(fields, file) {
  const boundary = '----MSCMS' + crypto.randomBytes(8'hex');
  const chunks = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="data"; filename="${file.name}"\r\n: video/mp4\r\n\r\n`));
  chunks.push(file.data);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

class TumblrPublisher {
  constructor(dataStore, opts = {}) {
    this.dataStore = dataStore;
    this.callback = opts.callback || 'oob'; // 桌面/手动授权场景用 oob
    this._uaMap = new Map(); // accountId -> 移动端 （养号移动指纹对齐）
    this._proxyResolver = null; // accountId -> 出口代理 URL（由养号引擎按代理池设置，缓解 429）
    this._appList = []; // 多 OAuth App 列表（tumblr_apps.json），用于按账号分散 app-key 缓解 429
    // 主动限流（缓解 429，无需多出口 IP）：按 App + 全局令牌桶，默认关闭（env=0）
    this._rpmPerApp = parseInt(process.env.TUMBLR_API_RPM || '0', 10) || 0;
    this._rpmGlobal = parseInt(process.env.TUMBLR_API_GLOBAL_RPM || '0', 10) || 0;
    this._appBuckets = new Map();   //  -> _TokenBucket
    this._globalBucket = this._rpmGlobal > 0 ? new _TokenBucket(this._rpmGlobal) : null;
    this._defaultTokenId = null; // 缓存第一个持有效 token 的真实账号 id（用于 'main' 兜底）
    this.reloadApps();
  }

  /**
   * 设置「按账号分配出口代理」的解析器（429 限流根因缓解：让不同账号走不同出口 IP）。
   * @param {(string):string|null} fn (accountId) =>  | null
   */
  setProxyResolver(fn) { if (typeof fn === '') this._proxyResolver = fn; }
  /**
   * 设置出口健康上报回调（由代理池提供）。
   * 作用：某出口 429/连续失败时自动冷却并让账号切到其它出口 —— 修复「账号被钉死在
   * 一个限流出口上永久空转」的缺陷（2026-09-08）。
   */
  setProxyReporter(fn) { if (typeof fn === '') this._proxyReporter = fn; }

  /**
   * 重新读取 tumblr_apps.json（多 OAuth App 注册列表）。
   * 格式：[{ "":"...", "":"...", "label":"app-1" }, ...]
   * 空数组或缺失文件 → 回退到单 main app（原行为，不破坏现有 44 账号）。
   */
  reloadApps() {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'tumblr_apps.json'), 'utf8'));
      this._appList = Array.isArray(raw)
        ? raw.filter((a) => (a. || a.consumer_key) && (a. || a.))
        : [];
    } catch (e) {
      this._appList = [];
    }
    return this._appList.length;
  }

  /** 按账号确定性分配一个 OAuth App（hash 稳定，重启一致），缓解单 app-key 429 */
  /**
   * 主动限流闸门（缓解 429）：按 App（）+ 全局双维度令牌桶。
   * 默认关闭（TUMBLR_API_RPM / TUMBLR_API_GLOBAL_RPM 均为 0）。仅增加等待，不抛错、不丢请求。
   */
  async _acquireRateLimit(accountId, ) {
    if (this._rpmPerApp > 0) {
      let b = this._appBuckets.get();
      if (!b) { b = new _TokenBucket(this._rpmPerApp); this._appBuckets.set(, b); }
      await b.take();
    }
    if (this._globalBucket) await this._globalBucket.take();
  }

  _appForAccount(accountId) {
    if (!this._appList.length) return null;
    const idx = hashStr(String(accountId)) % this._appList.length;
    const a = this._appList[idx];
    return { : a. || a.consumer_key, : a. || a., label: a.label || ('app#' + idx) };
  }

  /**
   * 解析「默认发布账号」：返回第一个持有效 oauthToken 的 token id。
   * 历史调用约定默认 accountId='main'，但 token 实际存于真实账号 id（如 tumblr_md4p5xij），
   * 无 'main' token → 必须兜底到真实账号才能完成发布。结果缓存避免每次枚举。
   */
  _defaultAccountId() {
    if (this._defaultTokenId) return this._defaultTokenId;
    const map = this.dataStore && this.dataStore._cache ? this.dataStore._cache.get('') : null;
    if (map && map.size) {
      for (const [id, t] of map.entries()) {
        if (t && t.oauthToken && t.oauthTokenSecret) { this._defaultTokenId = id; return id; }
      }
    }
    // 回退：直接读磁盘 token 文件（缓存未就绪时）
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', '.json'), 'utf8'));
      for (const [id, t] of Object.entries(raw)) {
        if (t && t.oauthToken && t.oauthTokenSecret) { this._defaultTokenId = id; return id; }
      }
    } catch (e) {}
    return 'main';
  }

  /**
   * 账号解析：'main'/缺省/该 slot 无 token 时，回退到第一个持有效 token 的真实账号 id。
   * 保证视频/帖子发布等入口（历史默认 accountId='main'）能落到真实授权的账号。
   */
  _resolveAccount(accountId) {
    if (accountId && accountId !== 'main') {
      const t = this.dataStore.get('', accountId);
      if (t && t.oauthToken && t.oauthTokenSecret) return accountId;
    }
    return this._defaultAccountId();
  }

  /**
   * 绑定某账号的移动端 UA，使该账号所有 OAuth API 请求携带与移动网页一致的 UA。
   * @param {string} id accountId
   * @param {string} ua 移动端  字符串
   */
  setAccountUA(id, ua) { if (id && ua) this._uaMap.set(id, ua); }
  getAccountUA(id) { return this._uaMap.get(id) || null; }
  /** 从移动设备池里随机挑一个移动 UA（可选传入确定性 rng 以按账号稳定） */
  pickMobileUA(rng) {
    const i = Math.floor((rng ? rng() : Math.random()) * MOBILE_UA_POOL.length);
    return MOBILE_UA_POOL[Math.max(0, Math.min(MOBILE_UA_POOL.length - 1, i))];
  }

  /** 公开：取某账号的博客名（reblog 跨账号复制时需要目标 blog） */
  blogNameOf(accountId) {
    const id = this._resolveAccount(accountId);
    return (this._getToken(id) || {}).blogName || '';
  }

  /**
   * 【2026-09-10 新增】该账号是否持有【自己的】OAuth token（不做跨账号兜底）。
   *
   * 背景：`` 在账号无 token 时会回退到第一个持 token 的账号，
   * 这在发布场景会造成【数据错位】—— 无 token 账号的内容会用别人的 token
   * 发到别人的 blog 上（记录却是该账号发布），流量与归属全错。
   *
   * 因此发布路径必须先用本方法做严格判定：false → 诚实标记未发布（NO_OAUTH_TOKEN），
   * 而不是借用他人 token。补授权后再自然恢复。
   */
  hasOwnToken(accountId) {
    if (!accountId || accountId === 'main') return false;
    const t = this._getToken(accountId);
    return !!(t && t.oauthToken && t.oauthTokenSecret);
  }

  /** 公开：该账号【自己】的 blog 名；无 token 时返回空串（不兜底到他人账号） */
  ownBlogNameOf(accountId) {
    if (!this.hasOwnToken(accountId)) return '';
    return (this._getToken(accountId) || {}).blogName || '';
  }

  _getConfig(id = 'main') {
    return this.dataStore.get('', id) || {};
  }
  /** 多账号 slot 的 config 若没有 consumer_key/secret，fallback 到 main 的（所有账号共享同一 App） */
  _getEffectiveConfig(id = 'main') {
    const own = this._getConfig(id);
    if (own. && own.) return own;
    const main = this._getConfig('main');
    return Object.assign({}, main, own);
  }
  _setConfig(id, patch) {
    if (typeof id === 'object') { patch = id; id = 'main'; }
    const cur = this._getConfig(id) || {};
    const merged = Object.assign({ id }, cur, patch);
    if (!this.dataStore.get('', id)) {
      this.dataStore.create('', merged);
    } else {
      this.dataStore.update('', id, merged);
    }
  }
  _getToken(id = 'main') {
    return this.dataStore.get('', id) || {};
  }
  _setToken(id, patch) {
    if (typeof id === 'object') { patch = id; id = 'main'; }
    const cur = this._getToken(id) || {};
    const merged = Object.assign({ id }, cur, patch);
    if (!this.dataStore.get('', id)) {
      this.dataStore.create('', merged);
    } else {
      this.dataStore.update('', id, merged);
    }
  }
  _getReqTmp(id = 'main') {
    return this.dataStore.get('', id) || {};
  }
  _setReqTmp(id, patch) {
    if (typeof id === 'object') { patch = id; id = 'main'; }
    const cur = this._getReqTmp(id) || {};
    const merged = Object.assign({ id }, cur, patch);
    if (!this.dataStore.get('', id)) {
      this.dataStore.create('', merged);
    } else {
      this.dataStore.update('', id, merged);
    }
  }

  setConsumerKey(key, secret, id = 'main') {
    if (!key || !secret) throw new Error('consumer_key 与  均必填');
    this._setConfig(id, { : key, : secret });
    return { ok: true };
  }

  getStatus() {
    const id = this.;
    const cfg = this._getEffectiveConfig(id);
    const tok = this._getToken(id);
    return {
      hasConsumerKey: !!(cfg. && cfg.),
      authorized: !!(tok.oauthToken && tok.oauthTokenSecret),
      blogName: tok.blogName || '',
      accountId: id
    };
  }

  /**
   * 构造 OAuth 签名
   * @param method GET/POST
   * @param url 资源 URL（不含 query）
   * @param oauthParams oauth_* 参数对象
   * @param extraParams 其他参与签名的 API 参数（不含二进制文件）
   * @param 
   * @param tokenSecret
   */
  _sign(method, url, oauthParams, extraParams, , tokenSecret) {
    const params = Object.assign({}, extraParams, oauthParams);
    const keys = Object.keys(params).sort();
    const base = keys
      .map(k => `${percentEncode(k)}=${percentEncode(String(params[k]))}`)
      .join('&');
    const baseString = `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(base)}`;
    const key = `${percentEncode()}&${percentEncode(tokenSecret || '')}`;
    const sig = crypto.createHmac('sha1', key).update(baseString).digest('base64');
    return sig;
  }

  _authHeader(oauthParams, signature) {
    const all = Object.assign({}, oauthParams, { oauth_signature: signature });
    const parts = Object.keys(all)
      .sort()
      .map(k => `${percentEncode(k)}="${percentEncode(String(all[k]))}"`)
      .join(', ');
    return `OAuth ${parts}`;
  }

  _baseOauthParams() {
    return {
      oauth_consumer_key: ,
      oauth_nonce: genNonce(),
      oauth_signature_method: '',
      oauth_timestamp: genTimestamp(),
      oauth_version: '1.0'
    };
  }

  /**
   * 步骤1：获取 request_token，返回授权 URL（用户在其中登录并授权）
   * @param accountId 多账号 slot 标识（默认 main）
   * @param callbackUrl 自定义回调（自动化场景用本地端口）
   */
  async beginAuth(accountId = 'main', callbackUrl) {
    // 若该账号无专属  且存在多 App 列表，则确定性分配一个 App 并持久化，
    // 使该账号后续的  与 App 绑定一致（缓解单 app-key 429；不影响已有 token 的账号）。
    if (accountId && accountId !== 'main') {
      const own = this._getConfig(accountId);
      if (!own. || !own.) {
        const app = this._appForAccount(accountId);
        if (app) this._setConfig(accountId, { : app., : app. });
      }
    }
    const cfg = this._getEffectiveConfig(accountId);
    if (!cfg. || !cfg.) {
      throw new Error('尚未配置 consumer_key/secret，无法开始授权');
    }
    const url = REQUEST_TOKEN_URL;
    const oauth = this._baseOauthParams(cfg.);
    oauth.oauth_callback = callbackUrl || this.callback;
    const sig = this._sign('POST', url, oauth, {}, cfg., '');
    const header = this._authHeader(oauth, sig);
    // ⚠️【2026-09-11 修复】OAuth 握手原先【不指定出口代理】，完全依赖 http-client 的全局路由，
    //   而后者只读 HTTP_PROXY/HTTPS_PROXY。本机这两个变量为空（外网仅能经本地出口代理 10808），
    //   于是 request_token 变成直连 → undici 抛 `fetch failed` →
    //   账号已被 Tumblr 真实创建（返回 "User and Tumblelog Created"）却拿不到 ，
    //   落库为 status=unverified / token=MISSING，永远无法发布。
    //   现与 _oauthRequest / publishVideo 保持同一兜底顺序：账号专属出口 → TUMBLR_PROXY。
    const px = (this._proxyResolver ? this._proxyResolver(accountId) : null) || process.env.TUMBLR_PROXY || null;
    const r = await fetchExt(url, {
      method: 'POST',
      headers: { '': header, '': 'application/x-www-form-urlencoded' },
      body: ''
    }, px);
    const text = await r.text();
    if (!r.ok) {
      throw new Error(`request_token 失败 ${r.status}: ${text.slice(0, 200)}`);
    }
    const parsed = new URLSearchParams(text);
    const oauthToken = parsed.get('');
    const oauthTokenSecret = parsed.get('_secret');
    if (!oauthToken) throw new Error('request_token 未返回 : ' + text);
    this._setReqTmp(accountId, { oauthToken, oauthTokenSecret });
    const authorizeUrl = `${AUTHORIZE_URL}?=${encodeURIComponent(oauthToken)}`;
    return { authorizeUrl, oauthToken, accountId };
  }

  /**
   * 步骤2：用用户提供的 verifier 换取 ，并查询 blog
   * @param verifier 
   * @param accountId 多账号 slot 标识
   */
  async completeAuth(verifier, accountId = 'main') {
    const cfg = this._getEffectiveConfig(accountId);
    const tmp = this._getReqTmp(accountId);
    if (!tmp.oauthToken) throw new Error('请先调用 beginAuth()');
    if (!verifier) throw new Error('缺少 ');
    const url = ACCESS_TOKEN_URL;
    const oauth = this._baseOauthParams(cfg.);
    oauth. = tmp.oauthToken;
    oauth. = verifier;
    const sig = this._sign('POST', url, oauth, {}, cfg., tmp.oauthTokenSecret || '');
    const header = this._authHeader(oauth, sig);
    // 同 beginAuth：换  这一步同样必须走出口代理，否则直连 → fetch failed
    const px = (this._proxyResolver ? this._proxyResolver(accountId) : null) || process.env.TUMBLR_PROXY || null;
    const r = await fetchExt(url, {
      method: 'POST',
      headers: { '': header, '': 'application/x-www-form-urlencoded' },
      body: ''
    }, px);
    const text = await r.text();
    if (!r.ok) throw new Error(` 失败 ${r.status}: ${text.slice(0, 200)}`);
    const parsed = new URLSearchParams(text);
    const oauthToken = parsed.get('');
    const oauthTokenSecret = parsed.get('_secret');
    if (!oauthToken) throw new Error(' 未返回 token: ' + text);
    this._setToken(accountId, { oauthToken, oauthTokenSecret });
    // 查询默认 blog
    try {
      const info = await this._userInfo(oauthToken, oauthTokenSecret, accountId);
      const blog = info && info.blogs && info.blogs[0] && (info.blogs[0].name || (info.blogs[0].url || '').replace(/^https?:\/\//,'').replace(/\.tumblr\.com\/?$/,''));
      if (blog) this._setToken(accountId, { blogName: blog });
      return { ok: true, blogName: blog || '', accountId };
    } catch (e) {
      return { ok: true, blogName: '', warn: e.message, accountId };
    }
  }

  async _userInfo(oauthToken, oauthTokenSecret, accountId) {
    const cfg = this._getEffectiveConfig(accountId);
    const url = `${API_BASE}/user/info`;
    const oauth = this._baseOauthParams(cfg.);
    oauth. = oauthToken;
    const sig = this._sign('GET', url, oauth, {}, cfg., oauthTokenSecret);
    const header = this._authHeader(oauth, sig);
    // 【2026-09-11 修复】user/info 也必须走账号出口代理，否则直连 → fetch failed →
    //   completeAuth 取不到 blogName → token 落库但缺 blogName → 发布被判 BLOG_NAME_UNKNOWN。
    //   与 beginAuth/completeAuth 同款兜底顺序：账号专属出口 → TUMBLR_PROXY。
    const px = (this._proxyResolver ? this._proxyResolver(accountId) : null) || process.env.TUMBLR_PROXY || null;
    const r = await fetchExt(url, { method: 'GET', headers: { '': header } }, px);
    const json = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`user/info ${r.status}: ${JSON.stringify(json).slice(0, 200)}`);
    return (json.response && json.response.user) || {};
  }

  /**
   * 真实发布视频到 Tumblr，返回真实 post_url
   * @param opts { filePath, caption, tags[], title, blogName? }
   */
  async publishVideo(opts) {
    const accountId = this._resolveAccount(opts.accountId);
    const cfg = this._getEffectiveConfig(accountId);
    const tok = this._getToken(accountId);
    if (!cfg. || !cfg.) throw new Error('Tumblr 未配置 consumer_key/secret');
    if (!tok.oauthToken || !tok.oauthTokenSecret) {
      throw new Error('Tumblr 未授权，请先完成 OAuth 授权流程');
    }
    // 主动限流（缓解 429）：与 _oauthRequest 同源，统一在请求前平滑速率
    await this._acquireRateLimit(accountId, cfg.);
    const blog = opts.blogName || tok.blogName;
    if (!blog) throw new Error('未知 blog，请先完成授权以获取 blog 名称');
    if (!opts.filePath || !fs.existsSync(opts.filePath)) {
      throw new Error('视频文件不存在: ' + opts.filePath);
    }

    const tags = Array.isArray(opts.tags)
      ? opts.tags.map(t => String(t).replace(/^#/, '').trim()).filter(Boolean).join(', ')
      : '';
    const caption = opts.caption || opts.title || 'MSCMS auto post';

    // Tumblr 当前视频上传必须用 NPF（Neue Post Format）：
    //  - JSON body 第一个 multipart part（name="json"）描述 content 块
    //  - 视频二进制作为第二个 part，其字段名必须与 content[].media.identifier 匹配
    //  - 旧式 type=video + data 字段已被 Tumblr 废弃，会降级成文本帖
    const buf = fs.readFileSync(opts.filePath);
    const identifier = 'vid-' + crypto.randomBytes(6'hex');
    const npf = {
      content: [{ type: 'video', media: { type: 'video/mp4', identifier, width: 640, height: 360 } }],
      state: 'published',
      tags
    };
    if (caption) npf.caption = caption;

    const url = `${API_BASE}/blog/${encodeURIComponent(blog)}/posts`;
    const oauth = this._baseOauthParams(cfg.);
    oauth. = tok.oauthToken;

    // 手工构造 multipart：part1 name=json(application/json)，part2 name=identifier(视频二进制)
    const boundary = '----MSCMS' + crypto.randomBytes(8'hex');
    const chunks = [];
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="json"\r\n: application/json\r\n\r\n${JSON.stringify(npf)}\r\n`));
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${identifier}"; filename="${path.basename(opts.filePath) || 'video.mp4'}"\r\n: video/mp4\r\n\r\n`));
    chunks.push(buf);
    chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const body = Buffer.concat(chunks);
    const contentType = `multipart/form-data; boundary=${boundary}`;

    const sig = this._sign('POST', url, oauth, {}, cfg., tok.oauthTokenSecret);
    const header = this._authHeader(oauth, sig);

    // 拟人化：账号专属移动 UA（与移动网页浏览指纹一致），缺省回退到全局代理出口
    const ua = opts.userAgent || this.getAccountUA(accountId) || null;
    const px = opts.proxy || (this._proxyResolver ? this._proxyResolver(accountId) : null) || process.env.TUMBLR_PROXY || null;

    // 视频上传同样受 429 限流影响：尊重 Retry-After 的指数退避（最多 5 次）
    let r, json, rateAttempt = 0;
    while (true) {
      const headers = { '': header, '': contentType };
      if (ua) headers[''] = ua;
      r = await fetchExt(url, {
        method: 'POST',
        headers,
        body
      }, px);
      json = await r.json().catch(() => ({}));
      if (r.status === 429 && rateAttempt < 5) {
        if (this._proxyReporter && px) this._proxyReporter(px, { ok: false, status: 429, err: 'rate_limited' });
        let wait = Math.min(60000, 1000 * Math.pow(2, rateAttempt));
        const ra = r.headers && r.headers.get && r.headers.get('retry-after');
        if (ra) { const n = parseInt(ra, 10); if (!isNaN(n)) wait = Math.max(wait, n * 1000); }
        await new Promise((res) => setTimeout(res, wait));
        rateAttempt++;
        continue;
      }
      break;
    }
    if (!r.ok || (json.meta && json.meta.status >= 400)) {
      throw new Error(`Tumblr 发布失败 ${r.status}: ${JSON.stringify(json).slice(0, 300)}`);
    }
    const post = (json.response && json.response.id) ? json.response : {};
    // 优先用 API 返回的规范 post_url；
    // 缺失时用 id_string（注意不是数字 id，末尾几位不同）拼新域名格式。
    // 旧格式 https://{blog}.tumblr.com/post/{数字id} 已被 Tumblr 废弃 → 返回 403 打不开。
    let postUrl = (json.response && json.response.post_url) || '';
    if (!postUrl) {
      const idStr = (json.response && json.response.id_string) || post.id;
      postUrl = `https://www.tumblr.com/blog/view/${blog}/${idStr}`;
    }
    return { ok: true, postUrl, postId: post.id, blogName: blog };
  }

  // ─────────────────────────────────────────────────────────
  //  养号真实 API 方法（第二阶段养号）
  //  全部复用本类的 OAuth1.0a 签名 + http-client 代理 + 429 退避
  // ─────────────────────────────────────────────────────────

  /**
   * 统一 OAuth 请求执行器
   * @param opts { accountId, method, path, params, formBody, jsonBody, multipart, contentType }
   *  - formBody: application/x-www-form-urlencoded 字段（参与签名）
   *  - jsonBody: JSON body（NPF 格式，不参与签名，=application/json）
   *  - multipart: { fields, file:{name,data,contentType} }（二进制不签，手工拼边界）
   */
  async _oauthRequest(opts) {
    const accountId = this._resolveAccount(opts.accountId);
    const cfg = this._getEffectiveConfig(accountId);
    const tok = this._getToken(accountId);
    if (!cfg. || !cfg.) throw new Error('Tumblr 未配置 consumer_key/secret');
    if (!tok.oauthToken || !tok.oauthTokenSecret) throw new Error('Tumblr 未授权，请先完成 OAuth 授权流程');

    // 主动限流（缓解 429）：发起请求前按 App + 全局平滑速率；默认关闭不影响现有行为
    await this._acquireRateLimit(accountId, cfg.);

    const url = `${API_BASE}${opts.path}`;
    const oauth = this._baseOauthParams(cfg.);
    oauth. = tok.oauthToken;

    let body = undefined, contentType = undefined;

    if (opts.multipart) {
      // 手工拼 multipart（与 publishVideo 同策略，绕过 undici 二进制丢失）
      const boundary = '----MSCMS' + crypto.randomBytes(8'hex');
      const chunks = [];
      for (const [k, v] of Object.entries(opts.multipart.fields || {})) {
        const ct = (k === 'json') ? '; : application/json' : '';
        chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"${ct}\r\n\r\n${v}\r\n`));
      }
      if (opts.multipart.file) {
        const f = opts.multipart.file;
        chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"; filename="${f.filename || 'file'}"\r\n: ${f.contentType}\r\n\r\n`));
        chunks.push(f.data);
        chunks.push(Buffer.from(`\r\n`));
      }
      chunks.push(Buffer.from(`--${boundary}--\r\n`));
      body = Buffer.concat(chunks);
      contentType = `multipart/form-data; boundary=${boundary}`;
    } else if (opts.jsonBody) {
      body = JSON.stringify(opts.jsonBody);
      contentType = 'application/json';
    } else if (opts.formBody) {
      body = new URLSearchParams(opts.formBody);
      contentType = 'application/x-www-form-urlencoded';
    } else if (opts.rawBody) {
      body = opts.rawBody;
      contentType = opts.contentType || 'application/x-www-form-urlencoded';
    }

    // 参与签名的参数：query params + form body 字段（二进制/NFP-JSON 不签）
    const signParams = Object.assign({}, opts.params || {}, opts.formBody || {});
    const sig = this._sign(opts.method, url, oauth, signParams, cfg., tok.oauthTokenSecret);
    const header = this._authHeader(oauth, sig);
    const headers = { '': header };
    if (contentType) headers[''] = contentType;
    // 移动指纹对齐：若该账号已绑定移动 UA，则所有 API 请求携带它（与移动网页浏览一致）
    const ua = this._uaMap.get(accountId);
    if (ua) headers[''] = ua;

    const fullUrl = url + (opts.params && Object.keys(opts.params ? '?' + new URLSearchParams(opts.params) : '');

    // 按账号出口代理（代理池分配；不传则走全局代理）
    // ⚠️【2026-09-08 P2 的旧逻辑，已于 2026-09-10 撤销】：
    //   原实现「只读请求(GET)不指定账号代理，交还 http-client 自动路由」——当时的理由是
    //   109 个账号共用 1 个出口 IP 会 429，于是把 tumblr.com 的 GET 导给
    //   Bright Data Unlocker 住宅 IP 桥（bdunlocker://）。
    //   但 BD 账户其后停用/欠费，桥恒返回 **407 Proxy Authentication Required**，
    //   直接后果是 `getPostStats('/blog/{blog}/posts/{id}')` 全部 407 →
    //   发出去的帖子 reach/likes/reblogs 永远回收不到（publish 记录互动数恒 0）。
    //   【修复】出口池已扩到 27 个独立出口 IP，GET 与 POST 一样按账号走自己的出口即可，
    //   既恢复互动回采，又保持「同账号同 IP」的防关联一致性。
    //   仅在确实解析不到出口时（px=null）才退回全局路由。
    const px = (this._proxyResolver && accountId) ? this._proxyResolver(accountId) : null;
    // ── 出口合法性校验（2026-10-09）────────────────────────────────────
    // 只做一件事：拦住**协议层面就不是 HTTP 代理**的值。
    // 已死的代理（如当前全部 20xxx CF 出口实测 http=000）不在这里管 ——
    // 它们是合法代理，只是不可用，应交给 http-client 的熔断器按失败次数
    // 自动降级到全局中继；提前一刀切会把"代理类型合法但暂时不通"
    // 和"压根不是代理"混为一谈，反而掩盖问题。
    const _globalPx = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || null;
    let _pxFinal = px;
    if (_pxFinal && !/^https?:\/\//i.test(String(_pxFinal))) _pxFinal = null;  // 非 http 协议
    if (_pxFinal && _globalPx && _pxFinal === _globalPx) _pxFinal = null;      // 与全局同源则交回全局
    // 外层：吸收单代理高并发下的偶发隧道重置（fetch failed / conn reset）——重试 2 次，每次间隔 1.5s
    // 内层：429 指数退避（最多 5 次，尊重 Retry-After）
    let netAttempt = 0;
    let rateAttempt = 0;
    while (true) {
      if (netAttempt >= 2) {
        const err = new Error(`Tumblr ${opts.path} network-failed after ${netAttempt} attempts (proxy=${px || 'none'})`);
        err.status = 0; err.isNetworkError = true;
        throw err;
      }
      let r;
      try {
        r = await fetchExt(fullUrl, { method: opts.method, headers, body }, _pxFinal);
      } catch (e) {
        // 隧道抖动（fetch failed / ECONNRESET 等）—— 重试一次再放弃
        if (this._proxyReporter && px) this._proxyReporter(px, { ok: false, status: 0, err: String(e.message || e).slice(0, 80) });
        netAttempt++;
        if (netAttempt < 2) { await new Promise(res => setTimeout(res, 1500)); continue; }
        const err = new Error(`Tumblr ${opts.path} ${e.message}`);
        err.status = 0; err.isNetworkError = true; err.cause = e;
        throw err;
      }
      if (r.status === 429 && rateAttempt < 5) {
        if (this._proxyReporter && px) this._proxyReporter(px, { ok: false, status: 429, err: 'rate_limited' });
        let wait = Math.min(60000, 1000 * Math.pow(2, rateAttempt));
        const ra = r.headers && r.headers.get && r.headers.get('retry-after');
        if (ra) { const n = parseInt(ra, 10); if (!isNaN(n)) wait = Math.max(wait, n * 1000); }
        await new Promise(res => setTimeout(res, wait));
        rateAttempt++;
        continue;
      }
      const text = await r.text();
      let json = {};
      try { json = JSON.parse(text); } catch (_) {}
      if (!r.ok) {
        // 【2026-09-15 N2 伴生修复】401/403 是「账号 token / 权限」问题，**与出口 IP 无关**。
        // 原实现把它一并上报为出口失败 → 白白冷却一条完全健康的出口
        // （实测：一次 401 让 2 条出口各冷却 60~120s，而出口容量正是本系统最紧张的资源）。
        // 现在只上报真正的出口相关失败：429（限流）/ 网络错误 / 5xx。
        const proxyRelated = !(r.status === 401 || r.status === 403);
        if (this._proxyReporter && px && proxyRelated) {
          this._proxyReporter(px, { ok: false, status: r.status, err: 'http_' + r.status });
        }
        const err = new Error(`Tumblr ${opts.path} ${r.status}: ${text.slice(0, 300)}`);
        err.status = r.status; err.body = json; err.isRateLimited = (r.status === 429);
        throw err;
      }
      if (this._proxyReporter && px) this._proxyReporter(px, { ok: true, status: r.status });
      return { status: r.status, json, raw: text };
    }
  }

  /** user/info 公开包装（拿 blogs/关注数等） */
  async getUserInfo(accountId = 'main') {
    const res = await this._oauthRequest({ accountId, method: 'GET', path: '/user/info' });
    return (res.json.response && res.json.response.user) || {};
  }

  /**
   * P0-D：回收单条帖子的真实互动数据（note_count / likes / reblogs / replies）。
   * 背景：publish 记录的 reach/likes/comments/shares 此前恒为 0（从未回收），
   *       导致"内容数据分析"无米下锅 —— 这是内容效能分析的前置条件。
   * 注意：刻意使用不带 query 的单帖端点，避免破坏 OAuth1 签名。
   * 零伪造：取不到就如实返回 ok:false，绝不编造数字。
   */
  async getPostStats(blogName, postId, accountId = 'main') {
    try {
      const blog = String(blogName || '').replace(/\.tumblr\.com$/i, '').trim();
      const pid = String(postId || '').trim();
      if (!blog || !pid) return { ok: false, error: 'MISSING_BLOG_OR_POST_ID' };

      const res = await this._oauthRequest({
        accountId, method: 'GET', path: `/blog/${blog}/posts/${pid}`,
      });
      // 注意：单帖端点的 response 本身就是 post 对象（object_type:"post"），
      // 并非 { post: {...} } 或 { posts: [...] } 嵌套结构 —— 早期按嵌套解析导致 POST_NOT_FOUND。
      const resp = res?.json?.response || {};
      const post = (resp.object_type === 'post')
        ? resp
        : (resp.post || (Array.isArray(resp.posts) ? resp.posts[0] : null));
      if (!post) return { ok: false, error: 'POST_NOT_FOUND' };

      // 有 notes 明细时精确拆分；否则只给总数，不做任何估算（避免编造）
      let likeCount = 0; let reblogCount = 0; let replyCount = 0;
      const notes = Array.isArray(post.notes) ? post.notes : [];
      if (notes.length) {
        for (const n of notes) {
          if (n.type === 'like') likeCount++;
          else if (n.type === 'reblog') reblogCount++;
          else if (n.type === 'reply') replyCount++;
        }
      }
      return {
        ok: true,
        postId: pid,
        postUrl: post.post_url || null,
        noteCount: post.note_count || 0,
        likeCount, reblogCount, replyCount,
        notesDetailed: notes.length > 0,
      };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }

  /** 关注一个博客（url 可为 name.tumblr.com 或 https://name.tumblr.com） */
  async followBlog(url, accountId = 'main') {
    const res = await this._oauthRequest({ accountId, method: 'POST', path: '/user/follow', formBody: { url: this._normBlogUrl(url) } });
    return { ok: true, status: res.status };
  }

  /** 取消关注 */
  async unfollowBlog(url, accountId = 'main') {
    const res = await this._oauthRequest({ accountId, method: 'POST', path: '/user/unfollow', formBody: { url: this._normBlogUrl(url) } });
    return { ok: true, status: res.status };
  }

  /** 点赞（id 为数字 post id，reblogKey 为帖子 reblog_key） */
  async likePost(id, reblogKey, accountId = 'main') {
    const res = await this._oauthRequest({ accountId, method: 'POST', path: '/user/like', formBody: { id: String(id), reblog_key: reblogKey } });
    return { ok: true, status: res.status };
  }

  /** 取消点赞 */
  async unlikePost(id, reblogKey, accountId = 'main') {
    const res = await this._oauthRequest({ accountId, method: 'POST', path: '/user/unlike', formBody: { id: String(id), reblog_key: reblogKey } });
    return { ok: true, status: res.status };
  }

  /** 转发（reblog）一条帖子，可带 commentary。返回新 post id/url */
  async reblogPost(blogName, { id, reblogKey, comment, tags }, accountId = 'main') {
    const form = { id: String(id), reblog_key: reblogKey };
    if (comment) form.comment = comment;
    if (tags && tags.length) form.tags = tags.map(t => String(t).replace(/^#/, '').trim()).filter(Boolean).join(', ');
    const res = await this._oauthRequest({ accountId, method: 'POST', path: `/blog/${encodeURIComponent(blogName)}/post/reblog`, formBody: form });
    const np = (res.json.response && res.json.response.id) ? res.json.response : {};
    let postUrl = (res.json.response && res.json.response.post_url) || '';
    if (!postUrl) { const idStr = (res.json.response && res.json.response.id_string) || np.id; postUrl = `https://www.tumblr.com/blog/view/${blogName}/${idStr}`; }
    return { ok: true, postId: np.id, postUrl };
  }

  /** 发纯文本帖（type=text） */
  async postText(blogName, { title, body, tags, state }, accountId = 'main') {
    const form = { type: 'text', body: body || '' };
    if (title) form.title = title;
    if (tags && tags.length) form.tags = tags.map(t => String(t).replace(/^#/, '').trim()).filter(Boolean).join(', ');
    if (state) form.state = state; else form.state = 'published';
    const res = await this._oauthRequest({ accountId, method: 'POST', path: `/blog/${encodeURIComponent(blogName)}/post`, formBody: form });
    const np = (res.json.response && res.json.response.id) ? res.json.response : {};
    let postUrl = (res.json.response && res.json.response.post_url) || '';
    if (!postUrl) { const idStr = (res.json.response && res.json.response.id_string) || np.id; postUrl = `https://www.tumblr.com/blog/view/${blogName}/${idStr}`; }
    return { ok: true, postId: np.id, postUrl };
  }

  /** 发图文帖（NPF + 手工 multipart，绕过二进制丢失）。filePath 可选，缺省用 source_url */
  async postPhoto(blogName, { caption, tags, filePath, sourceUrl, state }, accountId = 'main') {
    if (!filePath && !sourceUrl) throw new Error('postPhoto 需要 filePath 或 sourceUrl');
    if (filePath && !fs.existsSync(filePath)) throw new Error('图片文件不存在: ' + filePath);
    const tagStr = (tags && tags.length) ? tags.map(t => String(t).replace(/^#/, '').trim()).filter(Boolean).join(', ') : '';
    if (sourceUrl) {
      const form = { type: 'photo', caption: caption || '', tags: tagStr, source_url: sourceUrl };
      if (state) form.state = state; else form.state = 'published';
      const res = await this._oauthRequest({ accountId, method: 'POST', path: `/blog/${encodeURIComponent(blogName)}/post`, formBody: form });
      const np = (res.json.response && res.json.response.id) ? res.json.response : {};
      let postUrl = (res.json.response && res.json.response.post_url) || '';
      if (!postUrl) { const idStr = (res.json.response && res.json.response.id_string) || np.id; postUrl = `https://www.tumblr.com/blog/view/${blogName}/${idStr}`; }
      return { ok: true, postId: np.id, postUrl };
    }
    // 本地文件 → NPF JSON + 二进制 part
    const buf = fs.readFileSync(filePath);
    const ext = (path.extname(filePath) || '.jpg').toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    const identifier = 'img-' + crypto.randomBytes(6'hex');
    const npf = { content: [{ type: 'image', media: { type: mime, identifier } }], state: state || 'published', tags: tagStr };
    if (caption) npf.caption = caption;
    const file = { name: identifier, filename: path.basename(filePath), data: buf, contentType: mime };
    const res = await this._oauthRequest({ accountId, method: 'POST', path: `/blog/${encodeURIComponent(blogName)}/posts`, multipart: { fields: { json: JSON.stringify(npf) }, file } });
    const np = (res.json.response && res.json.response.id) ? res.json.response : {};
    let postUrl = (res.json.response && res.json.response.post_url) || '';
    if (!postUrl) { const idStr = (res.json.response && res.json.response.id_string) || np.id; postUrl = `https://www.tumblr.com/blog/view/${blogName}/${idStr}`; }
    return { ok: true, postId: np.id, postUrl };
  }

  /** 设置博客标题/简介（P0 资料完善） */
  async editBlog(blogName, { title, description }, accountId = 'main') {
    const form = {};
    if (title !== undefined) form.title = title;
    if (description !== undefined) form.description = description;
    const res = await this._oauthRequest({ accountId, method: 'POST', path: `/blog/${encodeURIComponent(blogName)}/edit`, formBody: form });
    return { ok: true, status: res.status };
  }

  /** 上传头像（P0 资料完善） */
  async updateAvatar(blogName, filePath, accountId = 'main') {
    if (!filePath || !fs.existsSync(filePath)) throw new Error('头像文件不存在: ' + filePath);
    const buf = fs.readFileSync(filePath);
    const ext = (path.extname(filePath) || '.jpg').toLowerCase();
    const mime = ext === '.png' ? 'image/png' : (ext === '.gif' ? 'image/gif' : 'image/jpeg');
    const file = { name: 'data', filename: path.basename(filePath), data: buf, contentType: mime };
    const res = await this._oauthRequest({ accountId, method: 'POST', path: `/blog/${encodeURIComponent(blogName)}/avatar`, multipart: { file } });
    return { ok: true, status: res.status };
  }

  /** 拉取用户 dashboard（消费/发现用） */
  async getDashboard({ limit = 20, offset = 0, reblogInfo = true, notesInfo = true } = {}, accountId = 'main') {
    const res = await this._oauthRequest({
      accountId, method: 'GET', path: '/user/dashboard',
      params: { limit: String(limit), offset: String(offset), reblog_info: reblogInfo ? 'true' : 'false', notes_info: notesInfo ? 'true' : 'false' }
    });
    return (res.json.response && res.json.response.posts) || [];
  }

  /**
   * 读取指定博客的已发布帖子（含 notes 摘要），用于互动中心选择需要查看评论的帖子。
   * 只读；不修改帖子或互动状态。
   */
  async getBlogPosts(blogName, { limit = 20, offset = 0, notesInfo = true } = {}, accountId = 'main') {
    if (!blogName) throw new Error('blogName required');
    const res = await this._oauthRequest({
      accountId,
      method: 'GET',
      path: `/blog/${encodeURIComponent(blogName)}/posts`,
      params: {
        limit: String(Math.max(1, Math.min(50, Number(limit) || 20))),
        offset: String(Math.max(0, Number(offset) || 0)),
        notes_info: notesInfo ? 'true' : 'false',
        api_key: this._getEffectiveConfig(accountId). || ''
      }
    });
    const response = res.json.response || {};
    return {
      posts: Array.isArray(response.posts) ? response.posts : [],
      totalPosts: Number(response.total_posts || 0),
      links: response._links || {}
    };
  }

  /**
   * 读取博客活动通知（官方 OAuth 端点）。
   * 不会将通知内容写回 Tumblr；只供人工审核与进入网页会话处理。
   */
  async getBlogNotifications(blogName, { limit = 20, before = null, types = null } = {}, accountId = 'main') {
    if (!blogName) throw new Error('blogName required');
    const params = { limit: String(Math.max(1, Math.min(50, Number(limit) || 20))) };
    if (before) params.before = String(before);
    if (Array.isArray(types) && types.length) params.types = types.join(',');
    const res = await this._oauthRequest({
      accountId,
      method: 'GET',
      path: `/blog/${encodeURIComponent(blogName)}/notifications`,
      params
    });
    const response = res.json.response || {};
    return {
      notifications: Array.isArray(response.notifications)
        ? response.notifications
        : (Array.isArray(response) ? response : []),
      links: response._links || {}
    };
  }

  /**
   * 读取某帖子 notes（官方只读端点）。官方文档要求 API key；它仅在服务端请求中附带，
   * 不会返回给控制台或写入 URL。
   */
  async getPostNotes(blogName, postId, { limit = 20, before = null } = {}, accountId = 'main') {
    if (!blogName || !postId) throw new Error('blogName and postId required');
    const cfg = this._getEffectiveConfig(accountId);
    const params = {
      id: String(postId),
      limit: String(Math.max(1, Math.min(50, Number(limit) || 20))),
      api_key: cfg.
    };
    if (before) params.before = String(before);
    const res = await this._oauthRequest({
      accountId,
      method: 'GET',
      path: `/blog/${encodeURIComponent(blogName)}/notes`,
      params
    });
    const response = res.json.response || {};
    return {
      notes: Array.isArray(response.notes) ? response.notes : (Array.isArray(response) ? response : []),
      links: response._links || {}
    };
  }

  /** 按 tag 拉取公开帖子（发现 dating/relationship 内容 & 博主） */
  async taggedPosts(tag, { limit = 20, before = null, filter = 'text' } = {}, accountId = 'main') {
    const params = { tag: tag, limit: String(limit) };
    if (before) params.before = String(before);
    if (filter) params.filter = filter;
    const res = await this._oauthRequest({ accountId, method: 'GET', path: '/tagged', params });
    return (res.json.response || []);
  }

  /** 博客信息（关注数/帖子数等，用于筛选值得关注的博主） */
  async blogInfo(blogName, accountId = 'main') {
    const res = await this._oauthRequest({ accountId, method: 'GET', path: `/blog/${encodeURIComponent(blogName)}/info` });
    return (res.json.response && res.json.response.blog) || {};
  }

  _normBlogUrl(url) {
    if (!url) return url;
    let u = String(url).trim();
    // 已是完整 http(s) URL：仅去掉结尾斜杠
    if (/^https?:\/\//i.test(u)) return u.replace(/\/+$/, '');
    // 裸博客名（不含点，如 doFollowDating 传入的 p.blog_name）→ 规范化为 https://{name}.tumblr.com
    if (!/\./.test(u)) u = u + '.tumblr.com';
    return 'https://' + u.replace(/\/+$/, '');
  }
}

module.exports = { TumblrPublisher };
