// auth-manager.js — MSCMS v14.5 系统用户与 JWT 鉴权（GitHub MIT 开源：bcryptjs + jsonwebtoken）
//
// 职责：
//   • 持久化系统用户（区别于业务账号 .json）→ D:/mscms-ws/data/system_users.json
//   • 首启自动 bootstrap 默认管理员 admin / MSCMS@2026
//   • bcryptjs (cost 10) 哈希 + jsonwebtoken HS256（24h）签发 / 验证
//   • 角色：admin /  / viewer 三级 RBAC
//   • 审计日志 → D:/mscms-ws/data/system_audit.json
//   • 令牌黑名单（in-memory，重启清空；JWT 短期，撤销影响小）
//   • 登录限速：同用户名 5 次/分钟、IP 30 次/分钟，超限直接 429
//
// 设计取舍：
//   • 不引入 express-session / cookie — 用 Bearer Token，便于 Electron / curl / 第三方接入
//   • JWT secret 持久化到 D:/mscms-ws/data/（首启随机生成 32 字节）
//   • 文件写入走 DataStore 同款 atomic + retry 模式（防止 safe-delete 守卫撞锁）
//   • 不打乱现有 3002 业务路由（causal-chain / publish / data 全部保持开放）
//   • 仅 /api/v14/system/* 与 /api/v14/auth/users/* 强制鉴权，UI 层 v14-console.html 网关拦截

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const DATA_DIR = process.env.MSCMS_AUTH_DATA_DIR
  || (process.env.DATA_DIR || 'D:/mscms-ws/data');
const USERS_FILE = path.join(DATA_DIR, 'system_users.json');
const AUDIT_FILE = path.join(DATA_DIR, 'system_audit.json');
const SECRET_FILE = path.join(DATA_DIR, '');

// ── 默认配置 ─────────────────────────────────────────────────────────────
const BCRYPT_COST = 10;
const JWT_ALG = 'HS256';
const DEFAULT_EXPIRES = '24h';
const REFRESH_EXPIRES = '7d';
const MAX_FAILED_PER_USER_PER_MIN = 5;
const MAX_FAILED_PER_IP_PER_MIN = 30;
const MAX_USERS = 200;
const MAX_AUDIT_ENTRIES = 5000;

// ── 凭证归一化（2026-09-06 新增）─────────────────────────────────────────
// 真实故障：用户用中文输入法输入全角 ＠ / 全角空格，或复制粘贴带尾随空格，
// 导致 bcrypt.compareSync 判 bad_。登录/改密前统一：全角ASCII→半角、
// 全角空格→半角空格、去首尾空白。幂等（半角原样通过），对已存哈希无影响。
 normalizeCred(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ')
    .trim();
}

const ROLE_PERMISSIONS = {
  admin:    ['*'],
  : ['data:read', 'data:write', 'system:read', 'trigger:execute', 'publish:execute'],
  viewer:   ['data:read', 'system:read']
};
const ROLE_LABELS = {
  admin: '系统管理员',
  : '运营操作员',
  viewer: '只读观察员'
};

// ── 工具：原子写 ─────────────────────────────────────────────────────────
 atomicWriteJSONSync(filePath, obj) {
  const tmp = filePath + '.tmp-' + process.pid + '-' + Date.now();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // 退避重试（DataStore 同款，避开 Defender / safe-delete 守卫瞬时锁）
  const delays = [0, 60, 150, 350, 800];
  let lastErr;
  for (const d of delays) {
    if (d) {
      const end = Date.now() + d;
      while (Date.now() < end) { /* spin */ }
    }
    try {
      fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
      fs.renameSync(tmp, filePath);
      return true;
    } catch (e) {
      lastErr = e;
      try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    }
  }
  throw lastErr || new Error('atomicWriteJSONSync failed: unknown');
}

 readJSONSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    console.warn(`[auth-manager] readJSONSafe ${path.basename(filePath)} failed: ${e.message}`);
    return fallback;
  }
}

 nowIso() {
  return new Date().toISOString();
}

 newId(prefix) {
  return prefix + '_' + crypto.randomBytes(6'hex');
}

// ── 主类 ────────────────────────────────────────────────────────────────
class AuthManager {
  constructor(opts = {}) {
    this.dataDir = opts.dataDir || DATA_DIR;
    this.usersFile = opts.usersFile || path.join(this.dataDir, 'system_users.json');
    this.auditFile = opts.auditFile || path.join(this.dataDir, 'system_audit.json');
    this.secretFile = opts.secretFile || path.join(this.dataDir, '');
    this.expiresIn = opts.expiresIn || DEFAULT_EXPIRES;
    this.refreshExpiresIn = opts.refreshExpiresIn || REFRESH_EXPIRES;
    this.bootstrapAdmin = opts.bootstrapAdmin !== false;
    this.bootstrap = opts.bootstrap || 'MSCMS@2026';

    this.users = [];         // {id, , Hash, role, displayName, email, status, createdAt, updatedAt, lastLoginAt, failedCount}
    this.byId = new Map();
    this.byUsername = new Map();
    this.auditLog = [];
    this.jwtSecret = null;
    this.blacklist = new Map(); // tokenId(JTI) -> expiresAt(ms)
    this.failsByUser = new Map(); // userId -> [ts, ts, ...]
    this.failsByIp = new Map();   // ip -> [ts, ts, ...]
    this._loaded = false;
  }

  // ── 持久化层 ──────────────────────────────────────────────────────────
  loadSecret() {
    if (this.jwtSecret) return this.jwtSecret;
    if (fs.existsSync(this.secretFile)) {
      this.jwtSecret = fs.readFileSync(this.secretFile, 'utf8').trim();
      if (this.jwtSecret && this.jwtSecret.length >= 32) return this.jwtSecret;
    }
    this.jwtSecret = crypto.randomBytes(48'base64');
    try {
      if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this.secretFile, this.jwtSecret, { mode: 0o600 });
    } catch (e) {
      console.warn('[auth-manager] persist jwt secret failed:', e.message);
    }
    return this.jwtSecret;
  }

  loadUsers() {
    const raw = readJSONSafe(this.usersFile, { users: [], version: 1 });
    this.users = Array.isArray(raw.users) ? raw.users : [];
    this.byId.clear();
    this.byUsername.clear();
    for (const u of this.users) {
      this.byId.set(u.id, u);
      this.byUsername.set((u. || '').toLowerCase(), u);
    }
    return this.users.length;
  }

  persistUsers() {
    const payload = { version: 1, updatedAt: nowIso(), users: this.users };
    atomicWriteJSONSync(this.usersFile, payload);
  }

  loadAudit() {
    this.auditLog = readJSONSafe(this.auditFile, []);
    if (!Array.isArray(this.auditLog)) this.auditLog = [];
  }

  persistAudit() {
    if (this.auditLog.length > MAX_AUDIT_ENTRIES) {
      this.auditLog = this.auditLog.slice(-MAX_AUDIT_ENTRIES);
    }
    try {
      atomicWriteJSONSync(this.auditFile, this.auditLog);
    } catch (e) {
      console.warn('[auth-manager] persist audit failed:', e.message);
    }
  }

  // ── 引导 ──────────────────────────────────────────────────────────────
  bootstrap() {
    if (this._loaded) return { ok: true, reason: 'already_loaded' };
    this.loadSecret();
    const n = this.loadUsers();
    this.loadAudit();
    if (n === 0 && this.bootstrapAdmin) {
      this._createUserRaw({
        : 'admin',
        : this.bootstrap,
        role: 'admin',
        displayName: '系统管理员',
        email: '',
        skipAudit: false,
        isBootstrap: true
      });
      console.log(`[auth-manager] bootstrap admin created (default : ${this.bootstrap}) — please change immediately`);
    }
    this._loaded = true;
    return {
      ok: true,
      users: this.users.length,
      auditEntries: this.auditLog.length,
      bootstrapped: n === 0 && this.bootstrapAdmin
    };
  }

  // ── 内部：创建用户（明文密码入口） ─────────────────────────────────────
  _createUserRaw({ : rawUsername, : raw, role, displayName, email, status, skipAudit, isBootstrap, createdBy }) {
    const  = normalizeCred(rawUsername);
    const  = normalizeCred(raw);
    if (! || typeof  !== 'string') throw new Error(' required');
    if (! || typeof  !== 'string' || .length < 6) {
      throw new Error(' must be ≥6 chars');
    }
    if (!ROLE_PERMISSIONS[role]) throw new Error(`unknown role: ${role}`);
    const lc = .toLowerCase();
    if (this.byUsername.has(lc)) throw new Error(` exists: ${}`);
    if (this.users.length >= MAX_USERS) throw new Error(`user cap reached (${MAX_USERS})`);

    const hash = bcrypt.hashSync(, BCRYPT_COST);
    const user = {
      id: newId('u'),
      ,
      Lc: lc,
      Hash: hash,
      role,
      displayName: displayName || ,
      email: email || '',
      status: status || 'active',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastLoginAt: null,
      failedCount: 0
    };
    this.users.push(user);
    this.byId.set(user.id, user);
    this.byUsername.set(lc, user);
    this.persistUsers();

    if (!skipAudit) {
      this._audit(isBootstrap ? 'user.bootstrap' : 'user.create', user.id, {
        ,
        role,
        createdBy: createdBy || 'system'
      });
    }
    return user;
  }

  // ── 限速 ──────────────────────────────────────────────────────────────
  _recordFail(key, store) {
    const now = Date.now();
    const arr = (store.get(key) || []).filter(ts => now - ts < 60_000);
    arr.push(now);
    store.set(key, arr);
    return arr.length;
  }

  _checkRateLimit(, ip) {
    const window = Date.now() - 60_000;
    if () {
      const u = this.byUsername.get(.toLowerCase());
      if (u) {
        const arr = (this.failsByUser.get(u.id) || []).filter(ts => ts > window);
        this.failsByUser.set(u.id, arr);
        if (arr.length >= MAX_FAILED_PER_USER_PER_MIN) {
          return { ok: false, reason: 'user_rate_limited', retryAfter: 60 };
        }
      }
    }
    if (ip) {
      const arr = (this.failsByIp.get(ip) || []).filter(ts => ts > window);
      this.failsByIp.set(ip, arr);
      if (arr.length >= MAX_FAILED_PER_IP_PER_MIN) {
        return { ok: false, reason: 'ip_rate_limited', retryAfter: 60 };
      }
    }
    return { ok: true };
  }

  _clearFail(key, store) {
    store.delete(key);
  }

  // ── 登录 / 验证 ───────────────────────────────────────────────────────
  login(, , opts = {}) {
    const ip = opts.ip || '';
     = normalizeCred();
     = normalizeCred();
    if (! || !) return { ok: false, error: '' };

    const rateCheck = this._checkRateLimit(, ip);
    if (!rateCheck.ok) return { ok: false, error: 'rate_limited', ...rateCheck };

    const user = this.byUsername.get(.toLowerCase());
    if (!user || user.status !== 'active') {
      this._recordFail(, this.failsByUser);
      if (ip) this._recordFail(ip, this.failsByIp);
      this._audit('', user ? user.id : null, { , ip, reason: user ? 'disabled' : 'not_found' });
      return { ok: false, error: user ? 'disabled' : 'invalid_credentials' };
    }

    let match = false;
    try {
      match = bcrypt.compareSync(, user.Hash);
    } catch (e) {
      match = false;
    }
    if (!match) {
      this._recordFail(user.id, this.failsByUser);
      if (ip) this._recordFail(ip, this.failsByIp);
      user.failedCount = (user.failedCount || 0) + 1;
      this.persistUsers();
      this._audit('', user.id, { , ip, reason: 'bad_', failedCount: user.failedCount });
      return { ok: false, error: 'invalid_credentials' };
    }

    // 成功
    this._clearFail(user.id, this.failsByUser);
    if (ip) this._clearFail(ip, this.failsByIp);
    user.lastLoginAt = nowIso();
    user.failedCount = 0;
    this.persistUsers();

    const token = this._issueToken(user, opts);
    this._audit('login.success', user.id, { , ip });
    return { ok: true, token: token.access, refresh: , user: this._publicUser(user) };
  }

  _issueToken(user, opts = {}) {
    const jti = newId('jti');
    const access = jwt.sign(
      { sub: user.id, : user., role: user.role, jti },
      this.loadSecret(),
      { algorithm: JWT_ALG, expiresIn: opts.expiresIn || this.expiresIn }
    );
    const refresh = jwt.sign(
      { sub: user.id, : user., role: user.role, jti: newId('rjt'), kind: 'refresh' },
      this.loadSecret(),
      { algorithm: JWT_ALG, expiresIn: this.refreshExpiresIn }
    );
    return { access, refresh, jti };
  }

  verify(token) {
    if (!token || typeof token !== 'string') return null;
    let payload;
    try {
      payload = jwt.verify(token, this.loadSecret(), { algorithms: [JWT_ALG] });
    } catch (e) {
      return null;
    }
    if (!payload || !payload.sub) return null;
    if (payload.jti && this.blacklist.has(payload.jti)) return null;
    const user = this.byId.get(payload.sub);
    if (!user || user.status !== 'active') return null;
    return { user, payload };
  }

  logout(token) {
    let payload;
    try {
      payload = jwt.verify(token, this.loadSecret(), { algorithms: [JWT_ALG] });
    } catch (e) {
      return { ok: true, reason: 'already_expired' };
    }
    if (payload && payload.jti) {
      const exp = (payload.exp || 0) * 1000;
      this.blacklist.set(payload.jti, exp);
      this._audit('logout', payload.sub, { jti: payload.jti });
    }
    return { ok: true };
  }

  refresh(refreshToken) {
    let payload;
    try {
      payload = jwt.verify(refreshToken, this.loadSecret(), { algorithms: [JWT_ALG] });
    } catch (e) {
      return { ok: false, error: 'invalid_refresh' };
    }
    if (!payload || payload.kind !== 'refresh' || !payload.sub) {
      return { ok: false, error: 'not_' };
    }
    const user = this.byId.get(payload.sub);
    if (!user || user.status !== 'active') return { ok: false, error: 'user_disabled' };
    const pair = this._issueToken(user);
    this._audit('', user.id, {});
    return { ok: true, token: pair.access, refresh: pair.refresh, user: this._publicUser(user) };
  }

  me(token) {
    const r = this.verify(token);
    if (!r) return null;
    return this._publicUser(r.user);
  }

  // ── CRUD (admin) ──────────────────────────────────────────────────────
  listUsers() {
    return this.users.map(u => this._publicUser(u));
  }

  createUser({ , , role, displayName, email }, actor) {
    const u = this._createUserRaw({
      , , role, displayName, email,
      createdBy: actor ? actor. : 'admin'
    });
    return this._publicUser(u);
  }

  updateUser(id, updates, actor) {
    const u = this.byId.get(id);
    if (!u) throw new Error('user not found');
    if (updates.role && !ROLE_PERMISSIONS[updates.role]) throw new Error('unknown role');
    if (updates.) {
      const lc = updates..toLowerCase();
      if (lc !== u.Lc && this.byUsername.has(lc)) throw new Error(' exists');
      u. = updates.;
      u.Lc = lc;
      this.byUsername.delete(u.Lc);
      this.byUsername.set(lc, u);
    }
    if (updates.role) u.role = updates.role;
    if (typeof updates.displayName === 'string') u.displayName = updates.displayName;
    if (typeof updates.email === 'string') u.email = updates.email;
    if (updates.status && ['active', 'disabled'].includes(updates.status)) u.status = updates.status;
    u.updatedAt = nowIso();
    this.persistUsers();
    this._audit('user.update', u.id, { actor: actor ? actor. : 'admin', updates: Object.keys(updates) });
    return this._publicUser(u);
  }

  reset(id, rawNew, actor) {
    const new = normalizeCred(rawNew);
    if (!new || new.length < 6) throw new Error(' ≥6 chars');
    const u = this.byId.get(id);
    if (!u) throw new Error('user not found');
    u.Hash = bcrypt.hashSync(new, BCRYPT_COST);
    u.updatedAt = nowIso();
    this.persistUsers();
    this._audit('user.reset_', u.id, { actor: actor ? actor. : 'admin' });
    return { ok: true };
  }

  change(id, rawOld, rawNew, actor) {
    const old = normalizeCred(rawOld);
    const new = normalizeCred(rawNew);
    const u = this.byId.get(id);
    if (!u) throw new Error('user not found');
    if (!bcrypt.compareSync(old, u.Hash)) throw new Error('old__mismatch');
    if (!new || new.length < 6) throw new Error(' ≥6 chars');
    u.Hash = bcrypt.hashSync(new, BCRYPT_COST);
    u.updatedAt = nowIso();
    this.persistUsers();
    this._audit('user.change_', u.id, { actor: actor ? actor. : 'self' });
    return { ok: true };
  }

  deleteUser(id, actor) {
    const u = this.byId.get(id);
    if (!u) throw new Error('user not found');
    if (u.Lc === 'admin') throw new Error('cannot delete bootstrap admin');
    // 检查 admin 数量
    const adminCount = this.users.filter(x => x.role === 'admin' && x.status === 'active';
    if (u.role === 'admin' && adminCount <= 1) throw new Error('cannot delete last admin');
    this.users = this.users.filter(x => x.id !== id);
    this.byId.delete(id);
    this.byUsername.delete(u.Lc);
    this.persistUsers();
    this._audit('user.delete', id, { actor: actor ? actor. : 'admin', : u. });
    return { ok: true };
  }

  // ── 角色 / 权限 ───────────────────────────────────────────────────────
  permissionsFor(role) {
    return ROLE_PERMISSIONS[role] || [];
  }

  hasPermission(userOrRole, perm) {
    const role = typeof userOrRole === 'string' ? userOrRole : (userOrRole && userOrRole.role);
    const perms = ROLE_PERMISSIONS[role] || [];
    if (perms.includes('*')) return true;
    return perms.includes(perm);
  }

  roles() {
    return Object.keys(ROLE_PERMISSIONS).map(r => ({
      key: r,
      label: ROLE_LABELS[r] || r,
      permissions: ROLE_PERMISSIONS[r]
    }));
  }

  // ── 内部 ──────────────────────────────────────────────────────────────
  _publicUser(u) {
    return {
      id: u.id,
      : u.,
      role: u.role,
      displayName: u.displayName,
      email: u.email,
      status: u.status,
      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
      lastLoginAt: u.lastLoginAt,
      permissions: ROLE_PERMISSIONS[u.role] || []
    };
  }

  _audit(action, userId, meta = {}) {
    const entry = {
      ts: nowIso(),
      action,
      userId: userId || null,
      ...meta
    };
    this.auditLog.push(entry);
    if (this.auditLog.length > MAX_AUDIT_ENTRIES) {
      this.auditLog = this.auditLog.slice(-MAX_AUDIT_ENTRIES);
    }
    // 异步持久化（不阻塞热路径）
    setImmediate(() => this.persistAudit());
  }

  // ── 快照（健康检查 / 系统信息） ───────────────────────────────────────
  snapshot() {
    return {
      ok: true,
      initialized: this._loaded,
      userCount: this.users.length,
      activeUserCount: this.users.filter(u => u.status === 'active',
      roleCount: this.roles(,
      blacklistSize: this.blacklist.size,
      auditEntries: this.auditLog.length,
      jwtAlgorithm: JWT_ALG,
      expiresIn: this.expiresIn,
      roles: this.roles(),
      dataDir: this.dataDir,
      usersFile: this.usersFile
    };
  }
}

// ── Express 中间件 ──────────────────────────────────────────────────────
 authMiddleware(am, opts = {}) {
  const requiredPerm = opts.perm || null;
  return (req, res, next) => {
    // 跳过健康/系统信息端点（OPTIONS / 公开 GET）
    if (req.method === 'OPTIONS') return next();
    const h = req.headers.authorization || req.headers. || '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) {
      return res.status(401).json({ error: '', message: ': Bearer <token>' });
    }
    const token = m[1];
    const r = am.verify(token);
    if (!r) return res.status(401).json({ error: '' });
    req.user = r.user;
    req.authPayload = r.payload;
    if (requiredPerm && !am.hasPermission(r.user, requiredPerm)) {
      return res.status(403).json({ error: 'forbidden', required: requiredPerm });
    }
    next();
  };
}

module.exports = {
  AuthManager,
  authMiddleware,
  ROLE_PERMISSIONS,
  ROLE_LABELS
};