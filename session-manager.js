/**
 * session-manager.js — MSCMS v14 Session 管理系统
 *
 * 核心能力：
 *   1. 定时自动备份（cookies/localStorage/sessionStorage/IndexedDB）
 *   2. SHA256 哈希完整性验证
 *   3. 版本控制（保留最近5个备份版本）
 *   4. 批量跨设备 Session 迁移
 *   5. 一键恢复与回滚
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');
const { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync, copyFileSync } = require('fs');
const path = require('path');
const { PATHS } = require('./storage-paths.js');

// ── 配置 ──────────────────────────────────────────
const DEFAULT_CFG = {
  backupDir: path.join(PATHS.DATA_DIR, 'sessions'),
  maxVersions: 5,
  autoBackupIntervalMin: 30,
  hashAlgorithm: 'sha256',
  platforms: ['tiktok', 'instagram', 'facebook', 'twitter', 'youtube'],
};

// ── Session 快照 ─────────────────────────────────
class SessionSnapshot {
  constructor(deviceId, platform) {
    this.id = `sess_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    this.deviceId = deviceId;
    this.platform = platform;
    this.version = 1;
    this.createdAt = new Date().toISOString();
    this.data = {
      cookies: [],
      localStorage: {},
      sessionStorage: {},
      indexedDB: {},
      browserFingerprint: null,
      headers: {},
      tokens: {},
    };
    this.metadata = {
      deviceName: null,
      browserVersion: null,
      osInfo: null,
      userAgent: null,
      screenResolution: null,
    };
    this.hash = null;
  }

  computeHash() {
    const payload = JSON.stringify({
      cookies: this.data.cookies,
      localStorage: this.data.localStorage,
      sessionStorage: this.data.sessionStorage,
      tokens: this.data.tokens,
    });
    this.hash = crypto.createHash('sha256').update(payload).digest('hex');
    return this.hash;
  }

  verify() {
    const oldHash = this.hash;
    const newHash = this.computeHash();
    return { valid: oldHash === newHash, oldHash, newHash };
  }
}

// ── 备份存储引擎 ─────────────────────────────────
class BackupStore {
  constructor(baseDir = path.join(PATHS.DATA_DIR, 'sessions')) {
    this.baseDir = baseDir;
    this._ensureDir();
  }

  _ensureDir() {
    try { mkdirSync(this.baseDir, { recursive: true }); } catch {}
  }

  _deviceDir(deviceId) {
    const dir = path.join(this.baseDir, String(deviceId));
    try { mkdirSync(dir, { recursive: true }); } catch {}
    return dir;
  }

  /**
   * 保存备份
   */
  save(snapshot) {
    const deviceDir = this._deviceDir(snapshot.deviceId);
    const filename = `${snapshot.platform}_v${String(snapshot.version).padStart(3, '0')}_${snapshot.id}.json`;
    const filepath = path.join(deviceDir, filename);

    snapshot.computeHash();
    writeFileSync(filepath, JSON.stringify(snapshot, null, 2), 'utf-8');

    return { filepath, filename, size: JSON.stringify(snapshot).length };
  }

  /**
   * 加载最新备份
   */
  loadLatest(deviceId, platform) {
    const versions = this.listVersions(deviceId, platform);
    if (versions.length === 0) return null;

    const latest = versions[versions.length - 1];
    return this._loadFile(latest.path);
  }

  /**
   * 加载指定版本
   */
  loadVersion(deviceId, platform, version) {
    const deviceDir = this._deviceDir(deviceId);
    if (!existsSync(deviceDir)) return null;

    const files = readdirSync(deviceDir)
      .filter(f => f.startsWith(`${platform}_v`) && f.endsWith('.json'))
      .sort();

    for (const f of files) {
      if (f.includes(`_v${String(version).padStart(3, '0')}_`)) {
        return this._loadFile(path.join(deviceDir, f));
      }
    }
    return null;
  }

  _loadFile(filepath) {
    try {
      const raw = readFileSync(filepath, 'utf-8');
      const data = JSON.parse(raw);
      // 恢复为 SessionSnapshot 实例
      const snap = new SessionSnapshot(data.deviceId, data.platform);
      Object.assign(snap, data);
      return snap;
    } catch (e) {
      return null;
    }
  }

  /**
   * 列出版本历史
   */
  listVersions(deviceId, platform) {
    const deviceDir = path.join(this.baseDir, String(deviceId));
    if (!existsSync(deviceDir)) return [];

    const files = readdirSync(deviceDir)
      .filter(f => f.startsWith(`${platform}_v`) && f.endsWith('.json'))
      .sort();

    return files.map(f => {
      const fullPath = path.join(deviceDir, f);
      const verMatch = f.match(/_v(\d+)_/);
      return {
        version: verMatch ? parseInt(verMatch[1]) : 0,
        filename: f,
        path: fullPath,
        size: statSync(fullPath).size,
        modifiedAt: statSync(fullPath).mtime.toISOString(),
      };
    });
  }

  /**
   * 清理旧版本（仅保留最近maxVersions个）
   */
  cleanup(deviceId, platform, maxVersions = 5) {
    const versions = this.listVersions(deviceId, platform);
    if (versions.length <= maxVersions) return { deleted: 0 };

    const toDelete = versions.slice(0, versions.length - maxVersions);
    for (const v of toDelete) {
      try { unlinkSync(v.path); } catch {}
    }
    return { deleted: toDelete.length, kept: maxVersions };
  }
}

// ── Session 管理引擎 ────────────────────────────
class SessionManager extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.cfg = { ...DEFAULT_CFG, ...opts };
    this.store = new BackupStore(this.cfg.backupDir);
    this.activeSnapshots = new Map(); // key: `${deviceId}_${platform}`
    this.autoBackupTimer = null;
    this.backupHistory = [];
  }

  /**
   * 创建新 Session 快照
   */
  createSnapshot(deviceId, platform, sessionData = {}) {
    const snap = new SessionSnapshot(deviceId, platform);

    // 填充数据
    if (sessionData.cookies) snap.data.cookies = sessionData.cookies;
    if (sessionData.localStorage) snap.data.localStorage = sessionData.localStorage;
    if (sessionData.sessionStorage) snap.data.sessionStorage = sessionData.sessionStorage;
    if (sessionData.indexedDB) snap.data.indexedDB = sessionData.indexedDB;
    if (sessionData.tokens) snap.data.tokens = sessionData.tokens;
    if (sessionData.headers) snap.data.headers = sessionData.headers;
    if (sessionData.userAgent) snap.metadata.userAgent = sessionData.userAgent;
    if (sessionData.screenResolution) snap.metadata.screenResolution = sessionData.screenResolution;

    snap.version = 1;
    const key = `${deviceId}_${platform}`;
    this.activeSnapshots.set(key, snap);
    this.emit('snapshotCreated', { deviceId, platform, snapshotId: snap.id });
    return snap;
  }

  /**
   * 保存备份
   */
  backup(deviceId, platform) {
    const key = `${deviceId}_${platform}`;
    const snap = this.activeSnapshots.get(key);
    if (!snap) throw new Error(`无活跃Session: device=${deviceId} platform=${platform}`);

    snap.version = (this.store.listVersions(deviceId, platform).length || 0) + 1;
    const result = this.store.save(snap);
    this.store.cleanup(deviceId, platform, this.cfg.maxVersions);

    this.backupHistory.push({
      snapshotId: snap.id,
      deviceId,
      platform,
      version: snap.version,
      filepath: result.filepath,
      hash: snap.hash,
      timestamp: new Date().toISOString(),
    });

    this.emit('backupCompleted', { deviceId, platform, version: snap.version, hash: snap.hash });
    return { version: snap.version, hash: snap.hash, filepath: result.filepath };
  }

  /**
   * 验证备份完整性
   */
  verify(deviceId, platform, version = null) {
    let snap;
    if (version) {
      snap = this.store.loadVersion(deviceId, platform, version);
    } else {
      snap = this.store.loadLatest(deviceId, platform);
    }

    if (!snap) {
      return { valid: false, error: '备份不存在' };
    }

    const result = snap.verify();
    this.emit('verificationCompleted', { deviceId, platform, ...result });
    return result;
  }

  /**
   * 恢复 Session
   */
  restore(deviceId, platform, version = null) {
    const snap = version
      ? this.store.loadVersion(deviceId, platform, version)
      : this.store.loadLatest(deviceId, platform);

    if (!snap) throw new Error(`备份不存在: ${deviceId}/${platform}`);

    const key = `${deviceId}_${platform}`;
    this.activeSnapshots.set(key, snap);

    this.emit('sessionRestored', { deviceId, platform, version: snap.version });
    return snap;
  }

  /**
   * 跨设备迁移 Session
   */
  migrate(sourceDeviceId, targetDeviceId, platform) {
    const snap = this.store.loadLatest(sourceDeviceId, platform);
    if (!snap) throw new Error(`源设备Session不存在: ${sourceDeviceId}/${platform}`);

    // 修改设备ID
    snap.deviceId = targetDeviceId;
    snap.version = 1;
    snap.id = `sess_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    // 保存到目标设备
    const key = `${targetDeviceId}_${platform}`;
    this.activeSnapshots.set(key, snap);
    const result = this.store.save(snap);

    this.emit('sessionMigrated', {
      sourceDeviceId, targetDeviceId, platform,
      snapshotId: snap.id, version: snap.version,
    });

    return { ...result, snapshotId: snap.id };
  }

  /**
   * 批量迁移
   */
  batchMigrate(migrationList) {
    const results = [];
    for (const m of migrationList) {
      try {
        const r = this.migrate(m.sourceDeviceId, m.targetDeviceId, m.platform);
        results.push({ ...m, success: true, ...r });
      } catch (e) {
        results.push({ ...m, success: false, error: e.message });
      }
    }
    this.emit('batchMigrationCompleted', { total: migrationList.length, results });
    return results;
  }

  /**
   * 启动自动备份
   */
  startAutoBackup() {
    if (this.autoBackupTimer) return;

    this.autoBackupTimer = setInterval(() => {
      for (const [key, snap] of this.activeSnapshots) {
        try {
          const [deviceId, platform] = key.split('_');
          this.backup(Number(deviceId), platform);
        } catch (e) {
          this.emit('autoBackupError', { key: key, error: e.message });
        }
      }
    }, this.cfg.autoBackupIntervalMin * 60 * 1000);

    this.emit('autoBackupStarted', { intervalMin: this.cfg.autoBackupIntervalMin });
  }

  /**
   * 停止自动备份
   */
  stopAutoBackup() {
    if (this.autoBackupTimer) {
      clearInterval(this.autoBackupTimer);
      this.autoBackupTimer = null;
      this.emit('autoBackupStopped');
    }
  }

  /**
   * 获取备份统计
   */
  getStats() {
    const allDevices = new Set();
    const platformStats = {};

    for (const entry of this.backupHistory) {
      allDevices.add(entry.deviceId);
      if (!platformStats[entry.platform]) {
        platformStats[entry.platform] = { count: 0, latestVersion: 0, lastBackup: null };
      }
      platformStats[entry.platform].count++;
      platformStats[entry.platform].latestVersion = Math.max(
        platformStats[entry.platform].latestVersion, entry.version
      );
      platformStats[entry.platform].lastBackup = entry.timestamp;
    }

    return {
      totalBackups: this.backupHistory.length,
      activeSessions: this.activeSnapshots.size,
      totalDevices: allDevices.size,
      byPlatform: platformStats,
      autoBackupActive: this.autoBackupTimer !== null,
    };
  }

  /**
   * 列出所有活跃 Session
   */
  listActive() {
    const sessions = [];
    for (const [key, snap] of this.activeSnapshots) {
      const [deviceId, platform] = key.split('_');
      sessions.push({
        deviceId: Number(deviceId),
        platform,
        snapshotId: snap.id,
        version: snap.version,
        cookieCount: snap.data.cookies.length,
        hasTokens: Object.keys(snap.data.tokens).length > 0,
        createdAt: snap.createdAt,
      });
    }
    return sessions;
  }
}

module.exports = { SessionManager, SessionSnapshot, BackupStore };
