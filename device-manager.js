/**
 * device-manager.js — MSCMS v14 云手机批量管理引擎
 * 
 * 职责：
 *   1. 50台云手机的统一生命周期管理（创建/启动/停止/重启/销毁）
 *   2. ADB 通信层（设备发现、属性注入、验证）
 *   3. 分批并发启动（内存感知调度，避免OOM）
 *   4. 健康检查与故障自动恢复
 *   5. 指纹注入与版本管理
 *   6. 代理配置与绑定
 *   7. 截图与实时监控
 *   8. 浏览器上下文模式（轻量级云手机）支持
 *
 * 启动模式：
 *   - EMULATOR: LDPlayer 模拟器实例（真实Android环境）
 *   - BROWSER: Playwright 浏览器上下文 + 移动指纹（轻量级，支持100+台）
 *
 * 用法：
 *   const dm = new DeviceManager({ maxConcurrent: 5 });
 *   await dm.init();
 *   await dm.startAll();
 *   await dm.healthCheck();
 */

const { spawn, execSync, exec } = require('child_process');
const { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const os = require('os');

// ── 配置 ──────────────────────────────────────────
const ROOT = path.join(__dirname);
const STORAGE = process.env.STORAGE_DIR || 'D:/LeiDian';

const CFG = {
  // 云手机根目录
  storage: STORAGE,
  deviceDir: path.join(STORAGE, 'devices'),
  
  // LDPlayer 路径
  ldPlayerDir: process.env.LDPLAYER_DIR || path.join(STORAGE, 'LDPlayer9'),
  
  // ADB 路径
  adbPath: process.env.ADB_PATH || path.join(STORAGE, 'platform-tools', 'adb.exe'),
  
  // 实例配置
  totalDevices: parseInt(process.env.CLOUD_PHONE_COUNT || '50', 10),
  startPort: 5555,        // ADB 起始端口
  emulatorPortBase: 10000, // 模拟器 ADB 起始端口
  
  // 分批启动配置（200台优化：增大批次、缩短冷却）
  batchSize: parseInt(process.env.BATCH_SIZE || '15', 10),
  batchDelayMs: parseInt(process.env.BATCH_DELAY || '15000', 10),
  
  // 启动超时
  bootTimeoutMs: 300000,   // 5分钟总超时
  adbDetectTimeoutMs: 120000, // ADB发现超时
  bootCompletedTimeoutMs: 180000, // boot_completed超时
  
  // 设备资源限制（每台）
  deviceMemoryMB: 1024,     // 每台1GB
  deviceCores: 1,
  
  // Keep-alive 保活配置
  keepAliveIntervalMs: parseInt(process.env.KEEP_ALIVE_INTERVAL || '60000', 10), // 默认60秒健康检查
  keepAliveEnabled: process.env.KEEP_ALIVE_DISABLED !== '1',
  
  // 模式：emulator | browser
  mode: process.env.DEVICE_MODE || 'browser',
  
  // 数据库
  dbEnabled: process.env.DB_ENABLED !== '0',
};

// ── 设备状态枚举 ─────────────────────────────────
const DeviceStatus = {
  OFFLINE: 'offline',
  STARTING: 'starting',
  BOOTING: 'booting',
  ONLINE: 'online',
  READY: 'ready',         // boot_completed + 指纹注入完成
  BUSY: 'busy',
  ERROR: 'error',
  STOPPING: 'stopping',
};

// ── 日志工具 ─────────────────────────────────────
const LOG_FILE = path.join(STORAGE, 'device-manager.log');
function log(level, tag, msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = `[${ts}] [${level}] [${tag}] ${msg}`;
  console.log(line);
  try { mkdirSync(path.dirname(LOG_FILE), { recursive: true }); } catch {}
  try { writeFileSync(LOG_FILE, line + '\n', { flag: 'a' }); } catch {}
}

// ── 内存感知调度器 ───────────────────────────────
class MemoryAwareScheduler {
  constructor(maxConcurrent = 5) {
    this.maxConcurrent = maxConcurrent;
    this.running = 0;
    this.queue = [];
  }

  get availableMemoryMB() {
    const total = os.totalmem() / (1024 * 1024);
    const free = os.freemem() / (1024 * 1024);
    return free;
  }

  get optimalBatchSize() {
    const freeMB = this.availableMemoryMB;
    // Browser 模式下每个 context 仅 ~40MB，远轻于模拟器
    const perDeviceMB = CFG.mode === 'browser' 
      ? (CFG.browserMemoryMB || 80) + 32  // ~80MB browser context + 32MB overhead
      : CFG.deviceMemoryMB + 256;
    const maxByMemory = Math.floor((freeMB - 1024) / perDeviceMB); // 留1GB系统缓存
    return Math.max(1, Math.min(maxByMemory, this.maxConcurrent));
  }

  async schedule(taskFn) {
    while (this.running >= this.optimalBatchSize) {
      await new Promise(r => setTimeout(r, 2000));
    }
    this.running++;
    try {
      return await taskFn();
    } finally {
      this.running--;
    }
  }
}

// ── ADB 通信层 ───────────────────────────────────
class ADBClient {
  constructor(adbPath) {
    this.adb = adbPath;
  }

  get available() {
    return existsSync(this.adb);
  }

  exec(args, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.adb, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { proc.kill(); reject(new Error('ADB timeout')); }, timeout);
      proc.stdout.on('data', d => stdout += d.toString());
      proc.stderr.on('data', d => stderr += d.toString());
      proc.on('close', code => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(stderr.trim() || `ADB exit ${code}`));
      });
      proc.on('error', e => { clearTimeout(timer); reject(e); });
    });
  }

  execOk(args, timeout = 15000) {
    return this.exec(args, timeout).then(() => true).catch(() => false);
  }

  async devices() {
    const out = await this.exec(['devices']).catch(() => '');
    const lines = out.split('\n').slice(1);
    const result = [];
    for (const line of lines) {
      const m = line.match(/^(\S+)\s+(\S+)/);
      if (m) result.push({ serial: m[1], state: m[2] });
    }
    return result;
  }

  async shell(serial, cmd, timeout = 10000) {
    return this.exec(['-s', serial, 'shell', cmd], timeout).catch(() => '');
  }

  async getProp(serial, prop) {
    return this.shell(serial, `getprop ${prop}`).then(s => s.trim());
  }

  /**
   * 返回所有在线（READY/ONLINE）设备的 ID 数组。
   * 供 proactive-marketing 自动 Follow 活动等场景使用；无在线设备时返回空数组。
   */
  getOnlineDeviceIds() {
    try {
      if (!this.devices || !(this.devices instanceof Map)) return [];
      const out = [];
      for (const [id, device] of this.devices) {
        if (device && (device.status === DeviceStatus.ONLINE || device.status === DeviceStatus.READY)) out.push(id);
      }
      return out;
    } catch (e) {
      console.error('[device-manager] getOnlineDeviceIds error:', e.message);
      return [];
    }
  }

  async setProp(serial, prop, value) {
    return this.shell(serial, `setprop ${prop} ${value}`);
  }

  async isBootCompleted(serial) {
    const out = await this.shell(serial, 'getprop sys.boot_completed', 3000);
    return out === '1';
  }

  async waitForBoot(serial, timeoutMs = 180000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        if (await this.isBootCompleted(serial)) return true;
      } catch {}
      await new Promise(r => setTimeout(r, 3000));
    }
    return false;
  }

  async waitForDevice(serial, timeoutMs = 120000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const devs = await this.devices().catch(() => []);
      const found = devs.find(d => d.serial === serial && d.state === 'device');
      if (found) return true;
      await new Promise(r => setTimeout(r, 2000));
    }
    return false;
  }

  async connect(host, port) {
    return this.exec([`connect`, `${host}:${port}`]).catch(() => '');
  }

  async disconnect(serial) {
    return this.exec([`disconnect`, serial]).catch(() => '');
  }

  async reboot(serial) {
    return this.exec(['-s', serial, 'reboot']).catch(() => {});
  }

  async install(serial, apkPath) {
    return this.exec(['-s', serial, 'install', '-r', apkPath], 60000);
  }

  async push(serial, localPath, remotePath) {
    return this.exec(['-s', serial, 'push', localPath, remotePath], 30000);
  }

  async screencap(serial, localPath) {
    await this.exec(['-s', serial, 'shell', 'screencap', '-p', '/sdcard/screen.png'], 10000);
    await this.exec(['-s', serial, 'pull', '/sdcard/screen.png', localPath], 10000);
    return existsSync(localPath) ? localPath : null;
  }

  async inputTap(serial, x, y) {
    return this.shell(serial, `input tap ${x} ${y}`);
  }

  async inputSwipe(serial, x1, y1, x2, y2, duration = 300) {
    return this.shell(serial, `input swipe ${x1} ${y1} ${x2} ${y2} ${duration}`);
  }

  async inputText(serial, text) {
    // 转义特殊字符
    const escaped = text.replace(/\\/g, '\\\\').replace(/ /g, '%s').replace(/"/g, '\\"');
    return this.shell(serial, `input text "${escaped}"`);
  }

  async startServer() {
    return this.exec(['start-server']).catch(() => {});
  }

  async killServer() {
    return this.exec(['kill-server']).catch(() => {});
  }
}

// ── 指纹生成器 ───────────────────────────────────
class FingerprintGenerator {
  constructor() {
    this.usedImeis = new Set();
    this.usedAndroidIds = new Set();
    this.usedMacs = new Set();
  }

  _randHex(len) {
    return crypto.randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len);
  }

  _randDigits(len) {
    return Array.from({ length: len }, () => Math.floor(Math.random() * 10)).join('');
  }

  // IMEI: 14位数字 (不含校验位)
  generateIMEI() {
    let imei;
    do { imei = this._randDigits(14); } while (this.usedImeis.has(imei));
    this.usedImeis.add(imei);
    return imei;
  }

  // Android ID: 16位hex
  generateAndroidId() {
    let id;
    do { id = this._randHex(16); } while (this.usedAndroidIds.has(id));
    this.usedAndroidIds.add(id);
    return id;
  }

  // MAC地址 (厂商前缀随机)
  generateMac() {
    const vendors = ['00:1A:2B', '08:00:27', '52:54:00', '0A:1B:2C', '3C:5A:B4'];
    const vendor = vendors[Math.floor(Math.random() * vendors.length)];
    const suffix = this._randHex(6).match(/.{2}/g).join(':');
    const mac = `${vendor}:${suffix}`;
    this.usedMacs.add(mac);
    return mac;
  }

  generate(country = 'US') {
    const region = REGIONS[country] || REGIONS['US'];
    return {
      imei1: this.generateIMEI(),
      imei2: this.generateIMEI(),
      imsi: `${region.mcc}${region.mnc}${this._randDigits(9)}`,
      androidId: this.generateAndroidId(),
      wifiMac: this.generateMac(),
      btMac: this.generateMac(),
      serial: this._randHex(8),
      simSerial: this._randDigits(20),
      phoneNumber: `+${region.countryCode}${this._randDigits(10)}`,
      // 设备属性
      manufacturer: region.manufacturers[Math.floor(Math.random() * region.manufacturers.length)],
      model: '',  // 由设备模板填充
      buildFingerprint: '',
      timezone: region.timezone,
      language: region.language,
      country: region.countryCode,
    };
  }
}

// ── 地域配置 ─────────────────────────────────────
const REGIONS = {
  US: { countryCode: '1', mcc: '310', mnc: '260', timezone: 'America/New_York', language: 'en-US',
    manufacturers: ['Samsung', 'Google', 'OnePlus', 'Motorola', 'LG'] },
  UK: { countryCode: '44', mcc: '234', mnc: '15', timezone: 'Europe/London', language: 'en-GB',
    manufacturers: ['Samsung', 'Google', 'OnePlus', 'Huawei', 'Xiaomi'] },
  JP: { countryCode: '81', mcc: '440', mnc: '10', timezone: 'Asia/Tokyo', language: 'ja-JP',
    manufacturers: ['Sony', 'Sharp', 'Samsung', 'Google', 'Kyocera'] },
  ID: { countryCode: '62', mcc: '510', mnc: '01', timezone: 'Asia/Jakarta', language: 'id-ID',
    manufacturers: ['Samsung', 'Xiaomi', 'Oppo', 'Vivo', 'Realme'] },
  BR: { countryCode: '55', mcc: '724', mnc: '05', timezone: 'America/Sao_Paulo', language: 'pt-BR',
    manufacturers: ['Samsung', 'Motorola', 'Xiaomi', 'LG', 'Asus'] },
};

// ── 设备模板库 ───────────────────────────────────
const DEVICE_TEMPLATES = {
  'Samsung Galaxy S24 Ultra': {
    manufacturer: 'samsung', brand: 'samsung', model: 'SM-S928B',
    ro_build_fingerprint: 'samsung/e3qxxx/e3q:14/UP1A.231005.007/S928BXXU1AXK4:user/release-keys',
    ro_build_version_sdk: '34', ro_product_cpu_abi: 'arm64-v8a',
    display: '1080x2340', dpi: '480',
  },
  'Samsung Galaxy S23': {
    manufacturer: 'samsung', brand: 'samsung', model: 'SM-S911B',
    ro_build_fingerprint: 'samsung/dm1qxxx/dm1q:14/UP1A.231005.007/S911BXXU3CXH7:user/release-keys',
    ro_build_version_sdk: '34', ro_product_cpu_abi: 'arm64-v8a',
    display: '1080x2340', dpi: '425',
  },
  'Google Pixel 9 Pro': {
    manufacturer: 'Google', brand: 'google', model: 'Pixel 9 Pro',
    ro_build_fingerprint: 'google/caiman/caiman:15/AP4A.250205.002/2025020500:user/release-keys',
    ro_build_version_sdk: '35', ro_product_cpu_abi: 'arm64-v8a',
    display: '1280x2856', dpi: '495',
  },
  'Google Pixel 8': {
    manufacturer: 'Google', brand: 'google', model: 'Pixel 8',
    ro_build_fingerprint: 'google/shiba/shiba:15/AP4A.250205.002/2025020500:user/release-keys',
    ro_build_version_sdk: '35', ro_product_cpu_abi: 'arm64-v8a',
    display: '1080x2400', dpi: '428',
  },
  'OnePlus 12': {
    manufacturer: 'OnePlus', brand: 'OnePlus', model: 'CPH2581',
    ro_build_fingerprint: 'OnePlus/CPH2581/OP594DL1:14/UKQ1.230924.001/T.38e04bb-1:user/release-keys',
    ro_build_version_sdk: '34', ro_product_cpu_abi: 'arm64-v8a',
    display: '1440x3168', dpi: '510',
  },
  'Xiaomi 14 Ultra': {
    manufacturer: 'Xiaomi', brand: 'Xiaomi', model: '24030PN60G',
    ro_build_fingerprint: 'Xiaomi/aurora_global/aurora:14/UKQ1.231003.002/V816.0.6.0.UNAMIXM:user/release-keys',
    ro_build_version_sdk: '34', ro_product_cpu_abi: 'arm64-v8a',
    display: '1440x3200', dpi: '522',
  },
  'iPhone 16 Pro Max': {
    manufacturer: 'Apple', brand: 'Apple', model: 'iPhone 16 Pro Max',
    isApple: true,
    display: '1320x2868', dpi: '460',
  },
  'iPhone 15 Pro': {
    manufacturer: 'Apple', brand: 'Apple', model: 'iPhone 15 Pro',
    isApple: true,
    display: '1179x2556', dpi: '460',
  },
  'Motorola Edge 50': {
    manufacturer: 'motorola', brand: 'motorola', model: 'XT2407-1',
    ro_build_fingerprint: 'motorola/montana_g/montana:14/U1UG34.23-131-1/1:user/release-keys',
    ro_build_version_sdk: '34', ro_product_cpu_abi: 'arm64-v8a',
    display: '1080x2400', dpi: '395',
  },
  'Oppo Find X7': {
    manufacturer: 'OPPO', brand: 'OPPO', model: 'CPH2619',
    ro_build_fingerprint: 'OPPO/CPH2619/OP594DL1:14/UKQ1.230924.001/T.38e04bb-1:user/release-keys',
    ro_build_version_sdk: '34', ro_product_cpu_abi: 'arm64-v8a',
    display: '1080x2412', dpi: '394',
  },
};

// ── 设备实例类 ───────────────────────────────────
class DeviceInstance {
  constructor(id, config) {
    this.id = id;
    this.name = `phone-${String(id).padStart(3, '0')}`;
    this.config = config;
    this.status = DeviceStatus.OFFLINE;
    this.emulatorProcess = null;
    this.adbSerial = null;
    this.fingerprint = null;
    this.proxy = null;
    this.stats = { startedAt: null, bootTime: 0, errors: [], restarts: 0 };
    this.lastScreenshot = null;
    this.metadata = {};
    this.boundAccounts = []; // 绑定的社媒账户
  }

  get deviceDir() {
    return path.join(CFG.deviceDir, this.name);
  }

  toJSON() {
    return {
      id: this.id, name: this.name, status: this.status,
      adbSerial: this.adbSerial, proxy: this.proxy,
      fingerprint: this.fingerprint ? { imei: this.fingerprint.imei1, androidId: this.fingerprint.androidId } : null,
      stats: this.stats, metadata: this.metadata,
      boundAccounts: this.boundAccounts || [],
    };
  }
}

// ══════════════════════════════════════════════════════
//  主引擎: DeviceManager
// ══════════════════════════════════════════════════════
class DeviceManager {
  constructor(opts = {}) {
    this.maxConcurrent = opts.maxConcurrent || CFG.batchSize;
    this.mode = opts.mode || CFG.mode;
    
    this.adb = new ADBClient(CFG.adbPath);
    this.fpGen = new FingerprintGenerator();
    this.scheduler = new MemoryAwareScheduler(this.maxConcurrent);
    this.devices = new Map();
    this.browserContexts = new Map(); // 浏览器模式
    this.db = null;
    this._initialized = false;
  }

  // ════════════════════════════════════════════════
  //  初始化
  // ════════════════════════════════════════════════
  async init() {
    log('INFO', 'INIT', `DeviceManager v14 initializing (mode=${this.mode}, total=${CFG.totalDevices}, batch=${this.maxConcurrent})`);
    
    // 设备数为 0 时跳过全部初始化（Playwright-free 模式）
    if (CFG.totalDevices <= 0) {
      log('INFO', 'INIT', 'Device count is 0 — skipping device initialization (Playwright-free mode)');
      this._initialized = true;
      return this;
    }

    // 创建目录
    mkdirSync(CFG.deviceDir, { recursive: true });
    mkdirSync(path.join(STORAGE, 'screenshots', 'devices'), { recursive: true });
    mkdirSync(path.join(STORAGE, 'fingerprints'), { recursive: true });

    // 初始化 ADB
    if (this.mode === 'emulator') {
      if (!this.adb.available) {
        log('WARN', 'INIT', `ADB not found at ${CFG.adbPath}, falling back to browser mode`);
        this.mode = 'browser';
      } else {
        await this.adb.startServer();
        log('INFO', 'INIT', 'ADB server started');
      }
    }

    // 初始化数据库
    if (CFG.dbEnabled) {
      try {
        const mysql = require('mysql2/promise');
        this.db = await mysql.createPool({
          host: process.env.MYSQL_HOST || '127.0.0.1',
          port: parseInt(process.env.MYSQL_PORT || '3307', 10),
          user: process.env.MYSQL_USER || 'root',
          password: process.env.MYSQL_PASSWORD || '',
          database: process.env.MYSQL_DB || 'affiliate_system',
          waitForConnections: true,
          connectionLimit: 5,
        });
        log('INFO', 'INIT', 'MySQL connected');
      } catch (e) {
        log('WARN', 'INIT', `MySQL not available: ${e.message}`);
        this.db = null;
      }
    }

    // 加载已有设备状态
    await this._loadDeviceStates();

    // 创建50台设备
    if (this.devices.size < CFG.totalDevices) {
      log('INFO', 'INIT', `Creating ${CFG.totalDevices - this.devices.size} new device instances`);
      for (let i = this.devices.size + 1; i <= CFG.totalDevices; i++) {
        await this._createDevice(i);
      }
    }

    this._initialized = true;
    log('INFO', 'INIT', `Ready: ${this.devices.size} devices managed`);
    return this;
  }

  // ════════════════════════════════════════════════
  //  创建单台设备
  // ════════════════════════════════════════════════
  async _createDevice(id) {
    const device = new DeviceInstance(id, {
      adbPort: CFG.emulatorPortBase + id,
      controllerPort: CFG.emulatorPortBase + id + 1000,
    });

    // 生成指纹
    device.fingerprint = this.fpGen.generate('US');
    
    // 分配设备模板（轮转）
    const templates = Object.keys(DEVICE_TEMPLATES);
    const tmplKey = templates[(id - 1) % templates.length];
    const tmpl = DEVICE_TEMPLATES[tmplKey];
    device.fingerprint.manufacturer = tmpl.manufacturer || device.fingerprint.manufacturer;
    device.fingerprint.model = tmpl.model;
    device.fingerprint.buildFingerprint = tmpl.ro_build_fingerprint || '';
    device.fingerprint.deviceTemplate = tmplKey;

    // 创建目录
    mkdirSync(device.deviceDir, { recursive: true });
    
    // 保存指纹
    writeFileSync(
      path.join(device.deviceDir, 'fingerprint.json'),
      JSON.stringify(device.fingerprint, null, 2)
    );

    // 分配代理（轮转）
    device.proxy = await this._allocateProxy(id);

    this.devices.set(id, device);
    
    // 持久化到数据库
    await this._saveDevice(device);

    log('INFO', 'CREATE', `${device.name}: template=${tmplKey}, imei=${device.fingerprint.imei1}`);
    return device;
  }

  // ════════════════════════════════════════════════
  //  分配代理
  // ════════════════════════════════════════════════
  async _allocateProxy(id) {
    const proxyFile = path.join(STORAGE, 'config', 'proxy-pool.json');
    let proxies = [];
    try {
      if (existsSync(proxyFile)) {
        proxies = JSON.parse(readFileSync(proxyFile, 'utf-8'));
      }
    } catch {}

    if (proxies.length === 0) {
      return { host: '127.0.0.1', port: 1080 + (id % 20), type: 'socks5', country: 'US' };
    }

    // 轮转分配
    const proxy = proxies[(id - 1) % proxies.length];
    return { ...proxy, assignedTo: id };
  }

  // ════════════════════════════════════════════════
  //  启动单台设备
  // ════════════════════════════════════════════════
  async startDevice(id) {
    const device = this.devices.get(id);
    if (!device) throw new Error(`Device ${id} not found`);
    
    if (device.status === DeviceStatus.ONLINE || device.status === DeviceStatus.READY) {
      log('INFO', 'START', `${device.name}: already online`);
      return { success: true, status: device.status };
    }

    device.status = DeviceStatus.STARTING;
    device.stats.startedAt = Date.now();
    
    try {
      if (this.mode === 'browser') {
        await this._startBrowserDevice(device);
      } else if (this.mode === 'cloud') {
        // 轻量云手机模式：真实创建设备实例并激活在线，但不启动 Playwright/模拟器
        // 发布走 Web Direct (HTTP) 通道，无需真实浏览器上下文，保证稳定且不卡死
        device.status = DeviceStatus.READY;
        device.adbSerial = `cloud:${device.id}`;
        device.stats.startedAt = Date.now();
        device.stats.bootTime = 0;
        device.stats.errors = [];
        await this._saveDevice(device);
        log('INFO', 'START', `${device.name}: cloud-active (logical device, no browser) — account-bound & online`);
        return { success: true, status: DeviceStatus.READY, bootTime: 0 };
      } else {
        await this._startEmulatorDevice(device);
      }

      // 启动后验证
      await this._postBootSetup(device);
      
      device.status = DeviceStatus.READY;
      device.stats.bootTime = Date.now() - device.stats.startedAt;
      device.stats.errors = [];
      
      await this._saveDevice(device);
      log('INFO', 'START', `${device.name}: READY (boot ${(device.stats.bootTime/1000).toFixed(1)}s)`);
      return { success: true, status: DeviceStatus.READY, bootTime: device.stats.bootTime };

    } catch (err) {
      device.status = DeviceStatus.ERROR;
      device.stats.errors.push({ time: Date.now(), message: err.message });
      await this._saveDevice(device);
      log('ERROR', 'START', `${device.name}: FAILED - ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  // ════════════════════════════════════════════════
  //  模拟器模式：启动LDPlayer实例
  // ════════════════════════════════════════════════
  async _startEmulatorDevice(device) {
    const ldconsole = path.join(CFG.ldPlayerDir, 'ldconsole.exe');
    
    if (!existsSync(ldconsole)) {
      throw new Error(`LDPlayer console not found: ${ldconsole}`);
    }

    // 检查实例是否存在
    const listOut = execSync(`"${ldconsole}" list2`, { encoding: 'utf-8' }).trim();
    const instanceExists = listOut.split('\n').some(l => l.includes(device.name));

    if (!instanceExists) {
      // 克隆基准实例
      log('INFO', 'EMU', `${device.name}: cloning from template...`);
      execSync(`"${ldconsole}" copy -n base_template -name ${device.name}`, { stdio: 'ignore' });
      
      // 修改实例配置
      execSync(`"${ldconsole}" modify --name ${device.name} --resolution 1080,1920,240 --cpu ${CFG.deviceCores} --memory ${CFG.deviceMemoryMB}`, { stdio: 'ignore' });
    }

    // 启动实例
    log('INFO', 'EMU', `${device.name}: launching emulator...`);
    execSync(`"${ldconsole}" launch --name ${device.name}`, { stdio: 'ignore' });

    // 等待ADB发现
    device.status = DeviceStatus.BOOTING;
    const adbPort = device.config.adbPort;
    await new Promise(r => setTimeout(r, 5000));
    
    await this.adb.connect('127.0.0.1', adbPort);
    device.adbSerial = `127.0.0.1:${adbPort}`;

    // 等待设备上线
    const deviceReady = await this.adb.waitForDevice(device.adbSerial, CFG.adbDetectTimeoutMs);
    if (!deviceReady) throw new Error('ADB device not detected in time');

    // 等待boot_completed
    const booted = await this.adb.waitForBoot(device.adbSerial, CFG.bootCompletedTimeoutMs);
    if (!booted) throw new Error('boot_completed timeout');
  }

  // ════════════════════════════════════════════════
  //  浏览器模式：创建Playwright上下文
  // ════════════════════════════════════════════════
  async _startBrowserDevice(device) {
    try {
      const { chromium } = require('playwright-core');
      
      if (!this._browser) {
        this._browser = await chromium.launch({
          headless: true,
          args: [
            '--no-sandbox', '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', '--disable-gpu',
            '--disable-extensions',
          ]
        });
        log('INFO', 'BROWSER', 'Chromium launched');
      }

      const tmpl = DEVICE_TEMPLATES[device.fingerprint.deviceTemplate] || DEVICE_TEMPLATES['Google Pixel 8'];
      
      const context = await this._browser.newContext({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        userAgent: this._buildUserAgent(tmpl),
        locale: device.fingerprint.language || 'en-US',
        timezoneId: device.fingerprint.timezone || 'America/New_York',
        geolocation: { latitude: 40.7128, longitude: -74.0060 },
        permissions: ['geolocation'],
        proxy: device.proxy ? {
          server: `${device.proxy.type}://${device.proxy.host}:${device.proxy.port}`
        } : undefined,
      });

      // 注入反检测脚本
      await context.addInitScript(() => {
        // WebDriver 检测绕过
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        // Chrome runtime
        window.chrome = { runtime: {} };
        // 权限查询
        const origQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (params) => (
          params.name === 'notifications' 
            ? Promise.resolve({ state: Notification.permission })
            : origQuery(params)
        );
      });

      const page = await context.newPage();
      this.browserContexts.set(device.id, { context, page });
      device.adbSerial = `browser:${device.id}`;
      
      log('INFO', 'BROWSER', `${device.name}: context created`);
    } catch (e) {
      throw new Error(`Browser device start failed: ${e.message}`);
    }
  }

  _buildUserAgent(tmpl) {
    const androidVersion = tmpl.ro_build_version_sdk 
      ? { '34': '14', '35': '15', '33': '13' }[tmpl.ro_build_version_sdk] || '14'
      : '14';
    return `Mozilla/5.0 (Linux; Android ${androidVersion}; ${tmpl.model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.102 Mobile Safari/537.36`;
  }

  // ════════════════════════════════════════════════
  //  启动后自动配置
  // ════════════════════════════════════════════════
  async _postBootSetup(device) {
    if (this.mode === 'browser' || this.mode === 'cloud') return; // 浏览器/云手机模式已在前置配置完成

    const serial = device.adbSerial;
    const fp = device.fingerprint;

    // 注入反检测属性（静默，失败不阻塞）
    const props = {
      'ro.product.manufacturer': fp.manufacturer,
      'ro.product.model': fp.model,
      'ro.product.brand': fp.brand || fp.manufacturer,
      'ro.product.name': fp.model.toLowerCase(),
      'ro.product.device': fp.model.toLowerCase(),
      'ro.build.fingerprint': fp.buildFingerprint,
      'ro.serialno': fp.serial,
      'gsm.sim.operator.numeric': `${fp.imsi.slice(0,5)}${fp.imsi.slice(5,10)}`,
      'persist.sys.timezone': fp.timezone,
      'persist.sys.locale': fp.language,
    };

    for (const [prop, value] of Object.entries(props)) {
      try { await this.adb.setProp(serial, prop, value); } catch {}
    }

    // 配置代理
    if (device.proxy && device.proxy.type === 'socks5') {
      try {
        await this.adb.shell(serial, `settings put global http_proxy ${device.proxy.host}:${device.proxy.port}`);
      } catch {}
    }

    // 禁用无关应用
    const bloatware = ['com.android.music', 'com.android.gallery3d', 'com.android.email'];
    for (const pkg of bloatware) {
      try { await this.adb.shell(serial, `pm disable ${pkg}`); } catch {}
    }

    // 验证指纹
    try {
      const mfg = await this.adb.getProp(serial, 'ro.product.manufacturer');
      if (mfg !== fp.manufacturer) {
        log('WARN', 'VERIFY', `${device.name}: manufacturer mismatch: ${mfg} vs ${fp.manufacturer}`);
      }
    } catch {}

    log('INFO', 'SETUP', `${device.name}: post-boot setup complete`);
  }

  // ════════════════════════════════════════════════
  //  安装社媒平台 App（根据账号平台自动安装/打开）
  // ════════════════════════════════════════════════
  async installSocialApp(device, platform) {
    const PLATFORMS = {
      reddit: { name: 'Reddit', url: 'https://www.reddit.com/login', pkg: 'com.reddit.frontpage' },
      x: { name: 'X (Twitter)', url: 'https://x.com/login', pkg: 'com.twitter.android' },
      twitter: { name: 'X (Twitter)', url: 'https://x.com/login', pkg: 'com.twitter.android' },
      instagram: { name: 'Instagram', url: 'https://www.instagram.com/accounts/login/', pkg: 'com.instagram.android' },
      tiktok: { name: 'TikTok', url: 'https://www.tiktok.com/login', pkg: 'com.zhiliaoapp.musically' },
      youtube: { name: 'YouTube', url: 'https://www.youtube.com/login', pkg: 'com.google.android.youtube' },
      linkedin: { name: 'LinkedIn', url: 'https://www.linkedin.com/login', pkg: 'com.linkedin.android' },
      facebook: { name: 'Facebook', url: 'https://www.facebook.com/login', pkg: 'com.facebook.katana' },
      discord: { name: 'Discord', url: 'https://discord.com/login', pkg: 'com.discord' },
      gmail: { name: 'Google', url: 'https://accounts.google.com/signin', pkg: 'com.google.android.gm' },
      google: { name: 'Google', url: 'https://accounts.google.com/signin', pkg: 'com.google.android.gm' },
    };

    const cfg = PLATFORMS[platform.toLowerCase()] || PLATFORMS.reddit;

    if (this.mode === 'browser') {
      // Browser 模式：在对应的 Playwright context 中打开平台登录页
      const ctx = this.browserContexts.get(device.id);
      if (ctx && ctx.page) {
        try {
          await ctx.page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          log('INFO', 'APP', `${device.name}: browser opened ${cfg.name} login page`);
        } catch (e) {
          log('WARN', 'APP', `${device.name}: failed to open ${cfg.url}: ${e.message}`);
          // 重试一次
          try {
            await ctx.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
            log('INFO', 'APP', `${device.name}: retry succeeded`);
          } catch (e2) {
            log('ERROR', 'APP', `${device.name}: retry failed: ${e2.message}`);
          }
        }
      } else {
        log('WARN', 'APP', `${device.name}: no browser context available for browser mode`);
      }
      return { mode: 'browser', opened: cfg.url, hasContext: !!ctx };
    }

    // Emulator 模式：先检查是否已安装，未安装则尝试安装 APK 或打开移动网页
    const serial = device.adbSerial;
    if (!serial) throw new Error('device has no adb serial');

    try {
      const installed = await this.adb.shell(serial, `pm list packages | grep ${cfg.pkg}`);
      if (installed && installed.includes(cfg.pkg)) {
        log('INFO', 'APP', `${device.name}: ${cfg.name} already installed`);
        return { mode: 'emulator', installed: true };
      }
    } catch {}

    // 尝试安装预置 APK（按平台查找）
    const apkPath = path.join(STORAGE, 'apks', `${cfg.pkg}.apk`);
    if (existsSync(apkPath)) {
      try {
        await this.adb.install(serial, apkPath);
        log('INFO', 'APP', `${device.name}: installed ${cfg.name} from ${apkPath}`);
        return { mode: 'emulator', installed: true };
      } catch (e) {
        log('WARN', 'APP', `${device.name}: install failed: ${e.message}`);
      }
    }

    // 降级方案：通过浏览器打开移动网页
    try {
      await this.adb.shell(serial, `am start -a android.intent.action.VIEW -d '${cfg.url}'`);
      log('INFO', 'APP', `${device.name}: opened ${cfg.name} web fallback`);
      return { mode: 'emulator', fallback: cfg.url };
    } catch (e) {
      log('WARN', 'APP', `${device.name}: web fallback failed: ${e.message}`);
    }

    return { mode: 'emulator', installed: false };
  }

  // ════════════════════════════════════════════════
  //  批量启动所有设备（内存感知分批）
  // ════════════════════════════════════════════════
  async startAll() {
    if (!this._initialized) await this.init();

    const allIds = Array.from(this.devices.keys());
    if (allIds.length === 0) {
      log('INFO', 'STARTALL', 'No devices to start (Playwright-free mode)');
      return { success: 0, failed: 0, total: 0 };
    }
    const offlineIds = allIds.filter(id => {
      const d = this.devices.get(id);
      return d.status !== DeviceStatus.ONLINE && d.status !== DeviceStatus.READY;
    });

    log('INFO', 'STARTALL', `Starting ${offlineIds.length} devices (mode=${this.mode})`);
    // Browser 模式使用内存感知动态批次，模拟器模式使用固定批次
    const batchSize = this.mode === 'browser' 
      ? Math.max(5, this.scheduler.optimalBatchSize) 
      : this.maxConcurrent;
    log('INFO', 'STARTALL', `Dynamic batch size: ${batchSize} (max concurrent: ${this.maxConcurrent})`);
    const batches = this._splitBatches(offlineIds, batchSize);
    const results = [];
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      log('INFO', 'STARTALL', `Batch ${i + 1}/${batches.length} (${batch.length} devices)`);

      const batchResults = await Promise.allSettled(
        batch.map(id => this.startDevice(id))
      );

      for (let j = 0; j < batchResults.length; j++) {
        const r = batchResults[j];
        if (r.status === 'fulfilled' && r.value.success) {
          successCount++;
          results.push({ id: batch[j], status: 'online' });
        } else {
          failCount++;
          const err = r.status === 'fulfilled' ? r.value.error : r.reason?.message;
          results.push({ id: batch[j], status: 'failed', error: err });
        }
      }

      // 批次间延迟（资源冷却）
      if (i < batches.length - 1) {
        log('INFO', 'STARTALL', `Batch ${i + 1} done. Cooling ${CFG.batchDelayMs/1000}s...`);
        await new Promise(r => setTimeout(r, CFG.batchDelayMs));
      }
    }

    log('INFO', 'STARTALL', `Complete: ${successCount} online, ${failCount} failed`);
    return { total: offlineIds.length, success: successCount, failed: failCount, results };
  }

  // ════════════════════════════════════════════════
  //  停止单台设备
  // ════════════════════════════════════════════════
  async stopDevice(id) {
    const device = this.devices.get(id);
    if (!device) throw new Error(`Device ${id} not found`);

    device.status = DeviceStatus.STOPPING;

    try {
      if (this.mode === 'browser') {
        const ctx = this.browserContexts.get(id);
        if (ctx) {
          await ctx.context.close().catch(() => {});
          this.browserContexts.delete(id);
        }
      } else if (device.adbSerial) {
        await this.adb.disconnect(device.adbSerial).catch(() => {});
        
        const ldconsole = path.join(CFG.ldPlayerDir, 'ldconsole.exe');
        if (existsSync(ldconsole)) {
          execSync(`"${ldconsole}" quit --name ${device.name}`, { stdio: 'ignore' });
        }
      }

      device.status = DeviceStatus.OFFLINE;
      device.adbSerial = null;
      log('INFO', 'STOP', `${device.name}: stopped`);
      return { success: true };
    } catch (e) {
      device.status = DeviceStatus.ERROR;
      throw e;
    }
  }

  // ════════════════════════════════════════════════
  //  停止所有设备
  // ════════════════════════════════════════════════
  async stopAll() {
    const ids = Array.from(this.devices.keys());
    const results = await Promise.allSettled(ids.map(id => this.stopDevice(id)));
    
    // 关闭浏览器
    if (this._browser) {
      await this._browser.close().catch(() => {});
      this._browser = null;
    }

    return results.map((r, i) => ({ id: ids[i], success: r.status === 'fulfilled' }));
  }

  // ════════════════════════════════════════════════
  //  健康检查
  // ════════════════════════════════════════════════
  async healthCheck() {
    const issues = [];
    const now = Date.now();

    for (const [id, device] of this.devices) {
      if (device.status === DeviceStatus.OFFLINE) continue;

      let healthy = true;

      if (this.mode === 'browser') {
        const ctx = this.browserContexts.get(id);
        if (!ctx) {
          issues.push({ id, name: device.name, issue: 'browser_context_missing' });
          healthy = false;
        } else {
          try {
            await ctx.page.evaluate(() => navigator.userAgent);
          } catch {
            issues.push({ id, name: device.name, issue: 'browser_context_unresponsive' });
            healthy = false;
          }
        }
      } else if (this.mode === 'cloud') {
        // 轻量云手机：逻辑设备，无需真实健康检查（保持在线活跃）
      } else if (device.adbSerial) {
        try {
          const booted = await this.adb.isBootCompleted(device.adbSerial);
          if (!booted) {
            issues.push({ id, name: device.name, issue: 'not_booted' });
            healthy = false;
          }
        } catch {
          issues.push({ id, name: device.name, issue: 'adb_unreachable' });
          healthy = false;
        }
      } else {
        issues.push({ id, name: device.name, issue: 'no_adb_serial' });
        healthy = false;
      }

      // 长时间未活动检测（云手机模式为常驻逻辑设备，长 uptime 属正常，跳过）
      if (this.mode !== 'cloud' && device.stats.startedAt && (now - device.stats.startedAt) > 3600000) {
        issues.push({ id, name: device.name, issue: 'long_uptime', uptime: now - device.stats.startedAt });
      }
    }

    return {
      total: this.devices.size,
      online: Array.from(this.devices.values()).filter(d => d.status === DeviceStatus.READY || d.status === DeviceStatus.ONLINE).length,
      offline: Array.from(this.devices.values()).filter(d => d.status === DeviceStatus.OFFLINE).length,
      error: Array.from(this.devices.values()).filter(d => d.status === DeviceStatus.ERROR).length,
      issues,
      timestamp: now,
    };
  }

  // ════════════════════════════════════════════════
  //  自动恢复故障设备
  // ════════════════════════════════════════════════
  async autoRecover() {
    const health = await this.healthCheck();
    const recovered = [];

    for (const issue of health.issues) {
      log('WARN', 'RECOVER', `${issue.name}: ${issue.issue}, attempting recovery...`);
      
      const device = this.devices.get(issue.id);
      if (!device) continue;

      // 云手机模式：逻辑设备无需真实健康检查/重启，直接保持在线就绪，禁止打成 ERROR
      if (this.mode === 'cloud') {
        device.status = DeviceStatus.READY;
        device.stats.errors = [];
        device.stats.restarts = 0;
        await this._saveDevice(device);
        recovered.push({ id: issue.id, name: issue.name, status: 'cloud-kept-online' });
        log('INFO', 'RECOVER', `${issue.name}: cloud-mode device kept online (issue=${issue.issue} ignored)`);
        continue;
      }

      if (device.stats.restarts >= 5) {
        log('ERROR', 'RECOVER', `${issue.name}: max restarts exceeded, marking as error`);
        device.status = DeviceStatus.ERROR;
        continue;
      }

      try {
        await this.stopDevice(issue.id);
        await new Promise(r => setTimeout(r, 3000));
        const result = await this.startDevice(issue.id);
        if (result.success) {
          device.stats.restarts++;
          recovered.push({ id: issue.id, name: issue.name, status: 'recovered' });
          log('INFO', 'RECOVER', `${issue.name}: recovered (restart #${device.stats.restarts})`);
        }
      } catch (e) {
        log('ERROR', 'RECOVER', `${issue.name}: recovery failed - ${e.message}`);
      }
    }

    return recovered;
  }

  // ════════════════════════════════════════════════
  //  Keep-Alive 保活监控（200台设备始终在线）
  // ════════════════════════════════════════════════
  startKeepAlive() {
    if (this._keepAliveTimer) {
      log('WARN', 'KEEPALIVE', 'Already running');
      return this._keepAliveTimer;
    }
    
    if (!CFG.keepAliveEnabled) {
      log('INFO', 'KEEPALIVE', 'Disabled by KEEP_ALIVE_DISABLED=1');
      return null;
    }

    log('INFO', 'KEEPALIVE', `Starting keep-alive monitor (interval=${CFG.keepAliveIntervalMs}ms)`);
    
    this._keepAliveStats = {
      startedAt: Date.now(),
      checks: 0,
      recoveries: 0,
      restarts: 0,
    };

    this._keepAliveTimer = setInterval(async () => {
      try {
        this._keepAliveStats.checks++;
        
        // 1. 检测下线设备并重新上线
        const offlineDevices = [];
        for (const [id, device] of this.devices) {
          if (device.status === DeviceStatus.OFFLINE || device.status === DeviceStatus.ERROR) {
            offlineDevices.push(id);
          }
        }
        
        if (offlineDevices.length > 0) {
          log('INFO', 'KEEPALIVE', `Found ${offlineDevices.length} offline/error devices, reconnecting...`);
        for (const id of offlineDevices) {
          try {
            const device = this.devices.get(id);
            if (!device) continue;
            if (this.mode === 'cloud') {
              // 云手机：逻辑设备重新上线即置就绪，不走 startDevice 累加 restarts
              device.status = DeviceStatus.READY;
              device.stats.startedAt = Date.now();
              device.stats.restarts = 0;
              device.stats.errors = [];
              await this._saveDevice(device);
              this._keepAliveStats.restarts++;
              log('INFO', 'KEEPALIVE', `Reconnected ${device.name} (cloud-mode, kept online)`);
              continue;
            }
            if (device.stats.restarts < 10) {
              await this.startDevice(id);
              device.stats.restarts = (device.stats.restarts || 0) + 1;
              this._keepAliveStats.restarts++;
              log('INFO', 'KEEPALIVE', `Reconnected ${device.name} (restart #${device.stats.restarts})`);
            }
          } catch (e) {
            log('ERROR', 'KEEPALIVE', `Failed to reconnect device ${id}: ${e.message}`);
          }
        }
        }

        // 2. 健康检查 + 自动恢复在线但异常的
        const health = await this.healthCheck();
        if (health.issues.length > 0) {
          log('WARN', 'KEEPALIVE', `Health issues: ${health.issues.length}, auto-recovering...`);
          const recovered = await this.autoRecover();
          this._keepAliveStats.recoveries += recovered.length;
        }

        // 3. 每10次检查输出汇总统计
        if (this._keepAliveStats.checks % 10 === 0) {
          const online = Array.from(this.devices.values()).filter(
            d => d.status === DeviceStatus.ONLINE || d.status === DeviceStatus.READY
          ).length;
          log('INFO', 'KEEPALIVE', 
            `Stats: ${online}/${this.devices.size} online | ${this._keepAliveStats.checks} checks | ${this._keepAliveStats.restarts} restarts | ${this._keepAliveStats.recoveries} recoveries`
          );
        }
      } catch (e) {
        log('ERROR', 'KEEPALIVE', `Monitor error: ${e.message}`);
      }
    }, CFG.keepAliveIntervalMs);

    return this._keepAliveTimer;
  }

  stopKeepAlive() {
    if (this._keepAliveTimer) {
      clearInterval(this._keepAliveTimer);
      this._keepAliveTimer = null;
      log('INFO', 'KEEPALIVE', 'Monitor stopped');
    }
  }

  getKeepAliveStats() {
    return this._keepAliveStats || { startedAt: 0, checks: 0, recoveries: 0, restarts: 0 };
  }

  // ════════════════════════════════════════════════
  //  获取设备截图
  // ════════════════════════════════════════════════
  async screenshot(id) {
    const device = this.devices.get(id);
    if (!device) throw new Error(`Device ${id} not found`);

    const filename = `${device.name}_${Date.now()}.png`;
    const filepath = path.join(STORAGE, 'screenshots', 'devices', filename);

    if (this.mode === 'browser') {
      const ctx = this.browserContexts.get(id);
      if (ctx) {
        await ctx.page.screenshot({ path: filepath, fullPage: false });
        device.lastScreenshot = filepath;
        return filepath;
      }
    } else if (device.adbSerial) {
      return await this.adb.screencap(device.adbSerial, filepath);
    }

    throw new Error('Device not available for screenshot');
  }

  // ════════════════════════════════════════════════
  //  设备列表
  // ════════════════════════════════════════════════
  listDevices(filter = {}) {
    let devices = Array.from(this.devices.values());
    if (filter.status) devices = devices.filter(d => d.status === filter.status);
    if (filter.platform) {
      devices = devices.filter(d => d.metadata?.platform === filter.platform);
    }
    return devices.map(d => d.toJSON());
  }

  // ════════════════════════════════════════════════
  //  统计
  // ════════════════════════════════════════════════
  getStats() {
    const all = Array.from(this.devices.values());
    return {
      total: all.length,
      online: all.filter(d => d.status === DeviceStatus.READY || d.status === DeviceStatus.ONLINE).length,
      offline: all.filter(d => d.status === DeviceStatus.OFFLINE).length,
      booting: all.filter(d => d.status === DeviceStatus.BOOTING || d.status === DeviceStatus.STARTING).length,
      error: all.filter(d => d.status === DeviceStatus.ERROR).length,
      busy: all.filter(d => d.status === DeviceStatus.BUSY).length,
      mode: this.mode,
      avgBootTime: all.filter(d => d.stats.bootTime > 0).reduce((s, d) => s + d.stats.bootTime, 0) / Math.max(1, all.filter(d => d.stats.bootTime > 0).length),
      memoryMB: this.mode === 'browser' ? null : CFG.deviceMemoryMB * all.filter(d => d.status !== DeviceStatus.OFFLINE).length,
    };
  }

  // ── 内部辅助 ──────────────────────────────────
  _splitBatches(arr, size) {
    const batches = [];
    for (let i = 0; i < arr.length; i += size) {
      batches.push(arr.slice(i, i + size));
    }
    return batches;
  }

  async _loadDeviceStates() {
    if (!existsSync(CFG.deviceDir)) return;
    
    const dirs = readdirSync(CFG.deviceDir).filter(d => {
      const p = path.join(CFG.deviceDir, d);
      return statSync(p).isDirectory() && d.startsWith('phone-');
    });

    // 只加载 CFG.totalDevices 以内的设备，超额的忽略
    let loaded = 0;
    for (const dir of dirs) {
      const id = parseInt(dir.replace('phone-', ''), 10);
      if (id > CFG.totalDevices) continue; // 跳过超额设备
      loaded++;
      const deviceDir = path.join(CFG.deviceDir, dir);
      const fpFile = path.join(deviceDir, 'fingerprint.json');
      
      const device = new DeviceInstance(id, {
        adbPort: CFG.emulatorPortBase + id,
        controllerPort: CFG.emulatorPortBase + id + 1000,
      });

      if (existsSync(fpFile)) {
        try { device.fingerprint = JSON.parse(readFileSync(fpFile, 'utf-8')); } catch {}
      }

      const stateFile = path.join(deviceDir, 'state.json');
      if (existsSync(stateFile)) {
        try {
          const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
          Object.assign(device.stats, state.stats || {});
          device.proxy = state.proxy || null;
          if (this.mode === 'cloud') {
            // 云手机逻辑设备：重启后清掉累积的 restarts，避免被 autoRecover 直接判 ERROR
            device.stats.restarts = 0;
            device.stats.errors = [];
          }
          device.status = DeviceStatus.OFFLINE; // 重启后重置
        } catch {}
      }

      this.devices.set(id, device);
    }

    log('INFO', 'LOAD', `Loaded ${this.devices.size} existing device states`);
  }

  async _saveDevice(device) {
    // 保存状态文件
    const state = {
      name: device.name, id: device.id, status: device.status,
      stats: device.stats, proxy: device.proxy,
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(
      path.join(device.deviceDir, 'state.json'),
      JSON.stringify(state, null, 2)
    );

    // 保存到数据库
    if (this.db) {
      try {
        await this.db.execute(
          `INSERT INTO cloud_devices (idx, avd_name, adb_serial, status, proxy, fingerprinted, last_online, sensor_data)
           VALUES (?, ?, ?, ?, ?, ?, NOW(), ?)
           ON DUPLICATE KEY UPDATE status=?, proxy=?, last_online=NOW()`,
          [
            device.id, device.name, device.adbSerial || '', device.status,
            JSON.stringify(device.proxy || {}), device.fingerprint ? 1 : 0,
            JSON.stringify(device.fingerprint || {}),
            device.status, JSON.stringify(device.proxy || {}),
          ]
        );
      } catch (e) {
        // 表可能不存在，静默失败
      }
    }
  }

  async saveFingerprint(id) {
    const device = this.devices.get(id);
    if (!device || !device.fingerprint) return false;

    const fpFile = path.join(STORAGE, 'fingerprints', `${device.name}.json`);
    writeFileSync(fpFile, JSON.stringify(device.fingerprint, null, 2));

    if (this.db) {
      try {
        await this.db.execute(
          `INSERT INTO fingerprints (device_id, imei1, imei2, android_id, wifi_mac, bt_mac, imsi, version, injected_at, verified)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, NOW(), 1)
           ON DUPLICATE KEY UPDATE imei1=?, imei2=?, android_id=?, injected_at=NOW()`,
          [
            id, device.fingerprint.imei1, device.fingerprint.imei2,
            device.fingerprint.androidId, device.fingerprint.wifiMac,
            device.fingerprint.btMac, device.fingerprint.imsi,
            device.fingerprint.imei1, device.fingerprint.imei2,
            device.fingerprint.androidId,
          ]
        );
      } catch {}
    }
    return true;
  }
}

// ══════════════════════════════════════════════════════
//  V14 增强: AVD 健康检测器
// ══════════════════════════════════════════════════════
class AVDHealthChecker {
  constructor(adbClient) {
    this.adb = adbClient;
    this.healthThresholds = {
      cpuMaxPercent: 80,
      memMaxPercent: 85,
      diskMinMB: 500,
      batteryMinPercent: 5,
      temperatureMaxC: 45,
    };
  }

  /**
   * 全面设备健康检测
   */
  async checkDevice(adbSerial) {
    const results = { checks: {}, score: 100, status: 'healthy', issues: [] };

    try {
      // 1. CPU使用率
      const cpu = await this._safeExec(adbSerial, 'top -n 1 -d 1 | grep -E "^[0-9]+%"');
      results.checks.cpu = { ok: true, value: cpu || 'N/A' };
    } catch (e) { results.checks.cpu = { ok: false, error: e.message }; results.score -= 15; results.issues.push('CPU检测失败'); }

    try {
      // 2. 内存
      const memInfo = await this._safeExec(adbSerial, 'cat /proc/meminfo | grep MemAvailable');
      if (memInfo) {
        const match = memInfo.match(/(\d+)/);
        const memKB = match ? parseInt(match[1]) : 0;
        const memMB = Math.round(memKB / 1024);
        results.checks.memory = { ok: memMB > 256, value: `${memMB}MB`, raw: memInfo };
        if (memMB <= 256) { results.score -= 20; results.issues.push(`内存不足: ${memMB}MB`); }
      }
    } catch {}

    try {
      // 3. 磁盘空间
      const diskInfo = await this._safeExec(adbSerial, 'df /data | tail -1');
      if (diskInfo) {
        const parts = diskInfo.trim().split(/\s+/);
        const availKB = parts[3] ? parseInt(parts[3]) : 0;
        const availMB = Math.round(availKB / 1024);
        results.checks.disk = { ok: availMB > this.healthThresholds.diskMinMB, value: `${availMB}MB` };
        if (availMB <= this.healthThresholds.diskMinMB) { results.score -= 15; results.issues.push(`磁盘不足: ${availMB}MB`); }
      }
    } catch {}

    try {
      // 4. 电池
      const batteryInfo = await this._safeExec(adbSerial, 'dumpsys battery | grep level');
      if (batteryInfo) {
        const match = batteryInfo.match(/(\d+)/);
        const level = match ? parseInt(match[1]) : 0;
        results.checks.battery = { ok: level > this.healthThresholds.batteryMinPercent, value: `${level}%` };
        if (level <= this.healthThresholds.batteryMinPercent) { results.score -= 10; results.issues.push(`电量过低: ${level}%`); }
      }
    } catch {}

    try {
      // 5. 温度（部分设备支持）
      const tempInfo = await this._safeExec(adbSerial, 'dumpsys thermalservice | grep -E "temperature" | head -1');
      if (tempInfo) {
        const match = tempInfo.match(/([\d.]+)/);
        const temp = match ? parseFloat(match[1]) : 0;
        results.checks.temperature = { ok: temp < this.healthThresholds.temperatureMaxC, value: `${temp}°C` };
        if (temp >= this.healthThresholds.temperatureMaxC) { results.score -= 15; results.issues.push(`温度过高: ${temp}°C`); }
      }
    } catch {}

    // 6. 系统服务状态
    try {
      const services = await this._safeExec(adbSerial, 'dumpsys activity services | grep -E "Active\|Running" | head -10');
      results.checks.services = { ok: !!services, value: services ? 'running' : 'stopped' };
    } catch { results.checks.services = { ok: false, error: 'N/A' }; }

    if (results.score < 60) results.status = 'unhealthy';
    else if (results.score < 80) results.status = 'degraded';

    return results;
  }

  async batchCheck(adbSerials) {
    const results = [];
    for (const serial of adbSerials) {
      try {
        const r = await this.checkDevice(serial);
        results.push({ serial, ...r });
      } catch (e) {
        results.push({ serial, score: 0, status: 'error', error: e.message });
      }
    }
    return results;
  }

  async _safeExec(serial, cmd) {
    try {
      return await this.adb.exec(['-s', serial, 'shell', cmd], 5000);
    } catch { return null; }
  }
}

// ══════════════════════════════════════════════════════
//  V14 增强: 三阶段 ADB 接入
// ══════════════════════════════════════════════════════
class ThreeStageADB {
  constructor(adbClient) {
    this.adb = adbClient;
  }

  /**
   * 阶段1: 设备发现
   * 扫描所有ADB设备，返回设备列表
   */
  async stage1_discover() {
    const output = await this.adb.exec(['devices']);
    const lines = output.split('\n').slice(1);
    const devices = [];
    for (const line of lines) {
      const parts = line.trim().split('\t');
      if (parts.length >= 2) {
        devices.push({ serial: parts[0], state: parts[1] });
      }
    }
    return { stage: 'discover', devices, count: devices.length };
  }

  /**
   * 阶段2: 离线设备转在线
   * 重新连接离线设备
   */
  async stage2_online(offlineDevices) {
    const results = [];
    for (const dev of offlineDevices) {
      try {
        // 尝试 TCP 重连
        if (dev.serial.includes(':')) {
          const [host, port] = dev.serial.split(':');
          await this.adb.exec(['connect', `${host}:${port}`], 10000);
        }
        // 等待设备上线
        let retries = 5;
        while (retries-- > 0) {
          await new Promise(r => setTimeout(r, 2000));
          const status = await this._getDeviceState(dev.serial);
          if (status === 'device') {
            results.push({ serial: dev.serial, success: true, state: 'device' });
            break;
          }
        }
        if (retries <= 0) {
          results.push({ serial: dev.serial, success: false, state: 'timeout' });
        }
      } catch (e) {
        results.push({ serial: dev.serial, success: false, error: e.message });
      }
    }
    return { stage: 'online', results };
  }

  /**
   * 阶段3: 等待 boot_completed
   * 验证系统完全启动
   */
  async stage3_bootCompleted(devices) {
    const results = [];
    for (const dev of devices) {
      try {
        let retries = 30; // 最多3分钟
        while (retries-- > 0) {
          const status = await this.adb.exec(['-s', dev.serial, 'shell', 'getprop sys.boot_completed'], 5000)
            .catch(() => '0');
          if (status.trim() === '1') {
            // 额外验证: package manager 已就绪
            const pkg = await this.adb.exec(['-s', dev.serial, 'shell', 'pm path com.android.settings'], 5000)
              .catch(() => null);
            if (pkg) {
              results.push({ serial: dev.serial, success: true, booted: true, pmReady: true });
              break;
            }
          }
          await new Promise(r => setTimeout(r, 6000));
        }
        if (retries <= 0) {
          results.push({ serial: dev.serial, success: false, booted: false, error: 'boot_completed timeout' });
        }
      } catch (e) {
        results.push({ serial: dev.serial, success: false, error: e.message });
      }
    }
    return { stage: 'boot_completed', results };
  }

  /**
   * 运行完整三阶段流程
   */
  async runFullPipeline() {
    // Stage 1
    const s1 = await this.stage1_discover();
    if (s1.devices.length === 0) {
      return { success: false, stage: 'discover', error: '未发现ADB设备' };
    }

    // Stage 2: 修复离线设备
    const offlineDevices = s1.devices.filter(d => d.state !== 'device');
    let s2 = { results: [] };
    if (offlineDevices.length > 0) {
      s2 = await this.stage2_online(offlineDevices);
    }

    // Stage 3: 等待所有设备 boot_completed
    const onlineDevices = s1.devices.filter(d => d.state === 'device');
    const repairedDevices = s2.results.filter(r => r.success).map(r => ({ serial: r.serial }));
    const allReady = [...onlineDevices, ...repairedDevices];

    let s3 = { results: [] };
    if (allReady.length > 0) {
      s3 = await this.stage3_bootCompleted(allReady);
    }

    return {
      success: true,
      stage1: s1,
      stage2: s2,
      stage3: s3,
      readyDevices: s3.results.filter(r => r.success).map(r => r.serial),
    };
  }

  async _getDeviceState(serial) {
    try {
      const out = await this.adb.exec(['-s', serial, 'get-state'], 3000);
      return out.trim();
    } catch { return 'unknown'; }
  }
}

// ══════════════════════════════════════════════════════
//  V14 增强: 指纹引擎 v2
//  版本化非破坏修改 + Jitter微调 + SAMFW合并 + 真实设备导入
// ══════════════════════════════════════════════════════
class FingerprintV2 {
  constructor() {
    // 版本化的指纹仓库
    this.fingerprintVersions = new Map(); // deviceId → [{version, fingerprint, timestamp}]
    // SAMFW固件信息库（常见设备真实固件指纹）
    this.samfwLibrary = this._initSAMFWLibrary();
    // 导入的真实设备指纹库
    this.realDeviceLibrary = [];
    // Jitter配置
    this.jitterSchedule = new Map(); // deviceId → lastJitterTime
    this.jitterIntervalMs = 3600000; // 默认每小时微调
  }

  _initSAMFWLibrary() {
    return {
      samsung: {
        'SM-S928B': {
          pda: 'S928BXXU1AXCB', csc: 'S928BOXM1AXCB',
          baseband: 'S928BXXU1AXCB', bootloader: 'S928BXXU1AXCB',
          buildNumber: 'UP1A.231005.007.S928BXXU1AXCB',
          securityPatch: '2024-03-01',
        },
        'SM-S911B': {
          pda: 'S911BXXU2CXCF', csc: 'S911BOXM2CXCF',
          baseband: 'S911BXXU2CXCF', bootloader: 'S911BXXU2CXCF',
          buildNumber: 'UP1A.231005.007.S911BXXU2CXCF',
          securityPatch: '2024-03-01',
        },
      },
      xiaomi: {
        '24030PN60G': {
          miuiVersion: 'HyperOS 1.0.6.0.UNAMIXM',
          androidVersion: '14', securityPatch: '2024-04-01',
          incrementalVersion: 'V816.0.6.0.UNAMIXM',
        },
      },
      oneplus: {
        'CPH2581': {
          oxygenVersion: 'OxygenOS 14.0.0.604',
          androidVersion: '14', securityPatch: '2024-04-05',
          incrementalVersion: 'CPH2581_14.0.0.604(EX01)',
        },
      },
      google: {
        'caiman': {
          buildId: 'AP4A.250205.002',
          securityPatch: '2025-02-05',
          androidVersion: '15',
        },
      },
    };
  }

  /**
   * 版本化指纹创建：新版本不覆盖旧版本，保留历史
   */
  createVersioned(deviceId, template, region = 'US') {
    if (!this.fingerprintVersions.has(deviceId)) {
      this.fingerprintVersions.set(deviceId, []);
    }
    const versions = this.fingerprintVersions.get(deviceId);
    const version = versions.length + 1;

    const fp = this._generateFull(template, region);
    fp.version = version;

    versions.push({
      version,
      fingerprint: fp,
      timestamp: new Date().toISOString(),
    });

    return fp;
  }

  /**
   * 回滚到指定版本
   */
  rollback(deviceId, version) {
    const versions = this.fingerprintVersions.get(deviceId);
    if (!versions) throw new Error(`设备 ${deviceId} 无版本历史`);

    const target = versions.find(v => v.version === version);
    if (!target) throw new Error(`版本 ${version} 不存在`);

    return target.fingerprint;
  }

  /**
   * 获取版本历史
   */
  getVersionHistory(deviceId) {
    const versions = this.fingerprintVersions.get(deviceId);
    if (!versions) return [];
    return versions.map(v => ({
      version: v.version,
      imei: v.fingerprint.imei1,
      androidId: v.fingerprint.androidId,
      timestamp: v.timestamp,
    }));
  }

  /**
   * 周期性 Jitter 微调：小幅随机抖动属性防止指纹锁定
   */
  jitter(deviceId, currentFingerprint) {
    const fp = { ...currentFingerprint };

    // 微小随机抖动（不改变设备本质属性）
    const jitterFactor = 0.001; // 0.1% 抖动

    // WiFi MAC: 最后一位随机变
    if (fp.wifiMac) {
      const lastByte = parseInt(fp.wifiMac.split(':')[5], 16);
      const jittered = (lastByte + Math.floor((Math.random() - 0.5) * 4)) & 0xFF;
      const parts = fp.wifiMac.split(':');
      parts[5] = jittered.toString(16).padStart(2, '0').toUpperCase();
      fp.wifiMac = parts.join(':');
    }

    // Bluetooth MAC: 同理
    if (fp.btMac) {
      const lastByte = parseInt(fp.btMac.split(':')[5], 16);
      const jittered = (lastByte + Math.floor((Math.random() - 0.5) * 4)) & 0xFF;
      const parts = fp.btMac.split(':');
      parts[5] = jittered.toString(16).padStart(2, '0').toUpperCase();
      fp.btMac = parts.join(':');
    }

    // 屏幕 DPI 微小抖动
    if (fp.dpi) {
      fp.dpi = Math.round(parseInt(fp.dpi) + (Math.random() - 0.5) * 10);
    }

    // 更新时间
    this.jitterSchedule.set(deviceId, Date.now());

    return fp;
  }

  /**
   * SAMFW 固件信息合并：将真实固件信息注入指纹
   */
  mergeSAMFW(deviceId, fingerprint, manufacturer, model) {
    const mfr = manufacturer?.toLowerCase();
    const mfrData = this.samfwLibrary[mfr];
    if (!mfrData) return fingerprint;

    const deviceData = mfrData[model] || Object.values(mfrData)[0];
    if (!deviceData) return fingerprint;

    const fp = { ...fingerprint };
    fp.samfw = {
      merged: true,
      mergedAt: new Date().toISOString(),
      ...deviceData,
    };

    // 注入真实固件属性
    if (deviceData.buildNumber) fp.buildNumber = deviceData.buildNumber;
    if (deviceData.securityPatch) fp.securityPatch = deviceData.securityPatch;
    if (deviceData.androidVersion) fp.androidVersion = deviceData.androidVersion;
    if (fp.ro_build_fingerprint) {
      fp.ro_build_fingerprint = fp.ro_build_fingerprint.replace(
        /UP1A\.\d+\.\d+\.\d+/,
        deviceData.buildNumber || 'UP1A.231005.007'
      );
    }

    return fp;
  }

  /**
   * 导入真实设备指纹（从JSON批量导入）
   */
  importRealDevices(realDevices) {
    for (const dev of realDevices) {
      this.realDeviceLibrary.push({
        ...dev,
        importedAt: new Date().toISOString(),
      });
    }
    return { imported: realDevices.length, total: this.realDeviceLibrary.length };
  }

  /**
   * 从真实设备库中随机抽取指纹模板
   */
  sampleReal(template = {}) {
    if (this.realDeviceLibrary.length === 0) return null;
    const idx = Math.floor(Math.random() * this.realDeviceLibrary.length);
    return { ...this.realDeviceLibrary[idx], ...template };
  }

  /**
   * 完整生成+版本化+Jitter+合并流程
   */
  fullPipeline(deviceId, template, region, manufacturer, model) {
    // 1. 基础生成
    let fp = this._generateFull(template, region);

    // 2. 如果有真实设备可用，优先使用
    const realFp = this.sampleReal();
    if (realFp) {
      fp = { ...fp, ...realFp };
    }

    // 3. 合并 SAMFW 固件
    if (manufacturer && model) {
      fp = this.mergeSAMFW(deviceId, fp, manufacturer, model);
    }

    // 4. 版本化存储
    fp = this.createVersioned(deviceId, fp, region);

    // 5. 初始化 Jitter 调度
    this.jitterSchedule.set(deviceId, Date.now());

    return fp;
  }

  /**
   * 检查是否需要 Jitter（超过间隔则执行）
   */
  maybeJitter(deviceId, currentFp) {
    const lastJitter = this.jitterSchedule.get(deviceId);
    if (!lastJitter || (Date.now() - lastJitter) > this.jitterIntervalMs) {
      return this.jitter(deviceId, currentFp);
    }
    return currentFp;
  }

  _generateFull(template, region) {
    const fp = {};
    // 基础Android属性
    fp.androidId = crypto.randomBytes(8).toString('hex');
    fp.imei1 = '35' + Array.from({length: 12}, () => Math.floor(Math.random() * 10)).join('');
    fp.imei2 = '35' + Array.from({length: 12}, () => Math.floor(Math.random() * 10)).join('');
    fp.imsi = '310' + Array.from({length: 12}, () => Math.floor(Math.random() * 10)).join('');
    fp.serialNo = Array.from({length: 10}, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 36)]).join('');
    fp.wifiMac = Array.from({length: 6}, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0').toUpperCase()).join(':');
    fp.btMac = Array.from({length: 6}, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0').toUpperCase()).join(':');

    // 模板属性覆盖
    if (template) {
      Object.assign(fp, template);
    }

    // 版本号
    fp.version = 1;
    fp.createdAt = new Date().toISOString();

    return fp;
  }
}

// ── 导出 ─────────────────────────────────────────
module.exports = {
  DeviceManager,
  DeviceStatus,
  FingerprintGenerator,
  FingerprintV2,
  AVDHealthChecker,
  ThreeStageADB,
  ADBClient,
  DEVICE_TEMPLATES,
  REGIONS,
  CFG,
};

// ── CLI 入口 ─────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0] || 'start';
  const dm = new DeviceManager({
    maxConcurrent: parseInt(args[1] || '5', 10),
    mode: args[2] || 'browser',
  });

  (async () => {
    await dm.init();

    switch (command) {
      case 'start':
        console.log('Starting all cloud phones...');
        const result = await dm.startAll();
        console.log(JSON.stringify(result, null, 2));
        break;
      case 'stop':
        await dm.stopAll();
        console.log('All devices stopped');
        break;
      case 'health':
        const health = await dm.healthCheck();
        console.log(JSON.stringify(health, null, 2));
        break;
      case 'stats':
        console.log(JSON.stringify(dm.getStats(), null, 2));
        break;
      case 'recover':
        console.log('Running auto-recovery...');
        const recovered = await dm.autoRecover();
        console.log(JSON.stringify(recovered, null, 2));
        break;
      case 'list':
        const filter = { status: args[1] };
        console.log(JSON.stringify(dm.listDevices(filter), null, 2));
        break;
      default:
        console.log('Usage: node device-manager.js [start|stop|health|stats|recover|list] [batchSize] [mode]');
    }

    process.exit(0);
  })().catch(err => {
    console.error('FATAL:', err.message);
    process.exit(1);
  });
}
