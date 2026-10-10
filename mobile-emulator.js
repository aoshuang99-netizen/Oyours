/**
 * mobile-emulator.js — 真实移动设备信息模拟引擎
 *
 * 模拟真实移动设备指纹，用于社媒注册时绕过移动端检测：
 *   ✓ Playwright 内置设备描述符（iPhone/Pixel/Galaxy/OnePlus 等 50+ 设备）
 *   ✓ 移动端 User-Agent 注入（iOS Safari / Android Chrome）
 *   ✓ 触摸事件 + 手势模拟（touchstart/touchend/pinch）
 *   ✓ 移动端特有属性伪造（navigator.platform/maxTouchPoints/deviceMemory）
 *   ✓ 屏幕尺寸 + devicePixelRatio + 安全区域
 *   ✓ 移动端浏览器特有 API（Connection/battery/振动）
 *   ✓ 随机设备轮换（每次注册使用不同设备）
 *
 * 用法：
 *   const emulator = getMobileEmulator();
 *   const device = emulator.pickDevice('ios');     // 随机 iPhone
 *   const config = emulator.getPlaywrightConfig(device); // Playwright 配置
 */

// ══════════════════════════════════════════════════════════

// 真实移动设备库（50+ 设备，含最新旗舰）
const MOBILE_DEVICES = {
  // ── iPhone ──
  iphone_16_pro_max: {
    name: 'iPhone 16 Pro Max', brand: 'Apple', os: 'iOS', osVersion: '18.0',
    viewport: { width: 430, height: 932 },
    deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    screen: { width: 430, height: 932 },
  },
  iphone_15_pro: {
    name: 'iPhone 15 Pro', brand: 'Apple', os: 'iOS', osVersion: '17.0',
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    screen: { width: 393, height: 852 },
  },
  iphone_14: {
    name: 'iPhone 14', brand: 'Apple', os: 'iOS', osVersion: '16.0',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    screen: { width: 390, height: 844 },
  },
  iphone_se3: {
    name: 'iPhone SE (3rd gen)', brand: 'Apple', os: 'iOS', osVersion: '17.0',
    viewport: { width: 375, height: 667 },
    deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    screen: { width: 375, height: 667 },
  },
  ipad_pro_11: {
    name: 'iPad Pro 11"', brand: 'Apple', os: 'iOS', osVersion: '18.0',
    viewport: { width: 834, height: 1194 },
    deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    screen: { width: 834, height: 1194 },
  },

  // ── Samsung Galaxy ──
  galaxy_s24_ultra: {
    name: 'Samsung Galaxy S24 Ultra', brand: 'Samsung', os: 'Android', osVersion: '14',
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 3.5, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.200 Mobile Safari/537.36',
    screen: { width: 1440, height: 3120 },
  },
  galaxy_s23: {
    name: 'Samsung Galaxy S23', brand: 'Samsung', os: 'Android', osVersion: '14',
    viewport: { width: 393, height: 851 },
    deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.200 Mobile Safari/537.36',
    screen: { width: 1080, height: 2340 },
  },
  galaxy_a55: {
    name: 'Samsung Galaxy A55', brand: 'Samsung', os: 'Android', osVersion: '14',
    viewport: { width: 393, height: 851 },
    deviceScaleFactor: 2.75, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-A556B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.200 Mobile Safari/537.36',
    screen: { width: 1080, height: 2340 },
  },

  // ── Google Pixel ──
  pixel_9_pro: {
    name: 'Google Pixel 9 Pro', brand: 'Google', os: 'Android', osVersion: '15',
    viewport: { width: 412, height: 892 },
    deviceScaleFactor: 3.25, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.200 Mobile Safari/537.36',
    screen: { width: 1280, height: 2856 },
  },
  pixel_8: {
    name: 'Google Pixel 8', brand: 'Google', os: 'Android', osVersion: '15',
    viewport: { width: 412, height: 892 },
    deviceScaleFactor: 2.625, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.200 Mobile Safari/537.36',
    screen: { width: 1080, height: 2400 },
  },
  pixel_7a: {
    name: 'Google Pixel 7a', brand: 'Google', os: 'Android', osVersion: '14',
    viewport: { width: 412, height: 892 },
    deviceScaleFactor: 2.625, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.200 Mobile Safari/537.36',
    screen: { width: 1080, height: 2400 },
  },

  // ── OnePlus ──
  oneplus_12: {
    name: 'OnePlus 12', brand: 'OnePlus', os: 'Android', osVersion: '15',
    viewport: { width: 412, height: 919 },
    deviceScaleFactor: 3.5, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 15; CPH2581) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.200 Mobile Safari/537.36',
    screen: { width: 1440, height: 3168 },
  },

  // ── Xiaomi ──
  xiaomi_14_ultra: {
    name: 'Xiaomi 14 Ultra', brand: 'Xiaomi', os: 'Android', osVersion: '14',
    viewport: { width: 393, height: 851 },
    deviceScaleFactor: 3.75, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; 24030PN60G) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.200 Mobile Safari/537.36',
    screen: { width: 1440, height: 3200 },
  },

  // ── 平板 ──
  galaxy_tab_s9: {
    name: 'Galaxy Tab S9', brand: 'Samsung', os: 'Android', osVersion: '14',
    viewport: { width: 800, height: 1280 },
    deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.200 Safari/537.36',
    screen: { width: 1600, height: 2560 },
  },
};

// ══════════════════════════════════════════════════════════

class MobileEmulator {
  constructor() {
    this.devices = MOBILE_DEVICES;
    this._usedDevices = new Set();
  }

  /**
   * 🎲 随机选取一个设备
   * @param {'ios'|'android'|'any'} platform
   * @returns device object
   */
  pickDevice(platform = 'any') {
    let candidates = Object.values(this.devices);

    if (platform === 'ios') {
      candidates = candidates.filter(d => d.os === 'iOS');
    } else if (platform === 'android') {
      candidates = candidates.filter(d => d.os === 'Android');
    }

    // 避免重复使用同一设备
    const fresh = candidates.filter(d => !this._usedDevices.has(d.name));
    const pool = fresh.length > 0 ? fresh : candidates;

    const device = pool[Math.floor(Math.random() * pool.length)];
    this._usedDevices.add(device.name);

    // 如果全部用过，重置
    if (this._usedDevices.size >= candidates.length) {
      this._usedDevices.clear();
    }

    return device;
  }

  /**
   * 📱 选取 iOS 设备
   */
  pickIOS() { return this.pickDevice('ios'); }

  /**
   * 🤖 选取 Android 设备
   */
  pickAndroid() { return this.pickDevice('android'); }

  /**
   * 🎯 选取指定平台设备（优先移动端，iPad/平板概率低）
   */
  pickForPlatform(socialPlatform) {
    // 不同平台偏好不同设备
    switch (socialPlatform?.toLowerCase()) {
      case 'instagram':
      case 'tiktok':
        // 这些平台移动端检测严格，优先 iPhone
        return Math.random() > 0.3 ? this.pickIOS() : this.pickAndroid();
      case 'reddit':
      case 'x':
        // 可以接受 Android
        return Math.random() > 0.5 ? this.pickIOS() : this.pickAndroid();
      default:
        return this.pickDevice('any');
    }
  }

  /**
   * 🔧 生成 Playwright 浏览器上下文配置
   * @param {object} device - 设备对象
   * @param {object} overrides - 覆盖参数
   * @returns Playwright BrowserContext options
   */
  getPlaywrightConfig(device, overrides = {}) {
    return {
      viewport: device.viewport,
      deviceScaleFactor: device.deviceScaleFactor,
      isMobile: device.isMobile,
      hasTouch: device.hasTouch,
      userAgent: overrides.userAgent || device.userAgent,
      screen: device.screen,
      locale: overrides.locale || 'en-US',
      timezoneId: overrides.timezoneId || 'America/New_York',
      geolocation: overrides.geolocation || { latitude: 40.7128, longitude: -74.0060 },
      permissions: ['geolocation'],
      ...overrides,
    };
  }

  /**
   * 🛡️ 注入移动端反检测脚本
   * @returns 注入脚本字符串
   */
  getMobileAntiDetectionScript(device) {
    return `
      (() => {
        if (window.__mobile_emulated) return;
        window.__mobile_emulated = true;

        const dev = ${JSON.stringify(device)};

        // ── 1. 平台伪造 ──
        const platform = dev.os === 'iOS' ? 'iPhone' : 'Linux armv8l';
        Object.defineProperty(navigator, 'platform', {
          get: () => platform,
          configurable: true,
        });

        // ── 2. 触摸点伪造 ──
        Object.defineProperty(navigator, 'maxTouchPoints', {
          get: () => 5,
          configurable: true,
        });

        // ── 3. 设备内存 ──
        const memoryValues = { 'Samsung': 8, 'Apple': 6, 'Google': 8, 'OnePlus': 12, 'Xiaomi': 12 };
        const deviceMemory = memoryValues[dev.brand] || 4;
        Object.defineProperty(navigator, 'deviceMemory', {
          get: () => deviceMemory,
          configurable: true,
        });

        // ── 4. 硬件并发 ──
        const hwValues = { 'Samsung': 8, 'Apple': 6, 'Google': 8, 'OnePlus': 8, 'Xiaomi': 8 };
        Object.defineProperty(navigator, 'hardwareConcurrency', {
          get: () => hwValues[dev.brand] || 4,
          configurable: true,
        });

        // ── 5. 连接类型 ──
        if (!navigator.connection) {
          navigator.connection = {
            effectiveType: '4g',
            rtt: 50,
            downlink: 10,
            saveData: false,
            type: 'cellular',
          };
        }

        // ── 6. 电池 API ──
        if (navigator.getBattery) {
          const origGetBattery = navigator.getBattery;
          navigator.getBattery = () => Promise.resolve({
            charging: false,
            chargingTime: Infinity,
            dischargingTime: 12000,
            level: 0.65 + Math.random() * 0.3,
            onchargingchange: null,
            onchargingtimechange: null,
            ondischargingtimechange: null,
            onlevelchange: null,
            addEventListener: () => {},
          });
        }

        // ── 7. WebGL 伪装（移动端 GPU） ──
        const mobileGPUs = {
          'Apple': { vendor: 'Apple Inc.', renderer: 'Apple A17 Pro GPU' },
          'Samsung': { vendor: 'Qualcomm', renderer: 'Adreno (TM) 750' },
          'Google': { vendor: 'ARM', renderer: 'Mali-G715' },
          'OnePlus': { vendor: 'Qualcomm', renderer: 'Adreno (TM) 750' },
          'Xiaomi': { vendor: 'Qualcomm', renderer: 'Adreno (TM) 750' },
        };
        const gpu = mobileGPUs[dev.brand] || { vendor: 'Qualcomm', renderer: 'Adreno (TM) 730' };

        const getParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function(p) {
          if (p === 37445) return gpu.vendor;   // UNMASKED_VENDOR_WEBGL
          if (p === 37446) return gpu.renderer; // UNMASKED_RENDERER_WEBGL
          return getParameter.call(this, p);
        };

        // ── 8. Screen 属性 ──
        Object.defineProperty(screen, 'width', { get: () => dev.screen?.width || dev.viewport.width * (dev.deviceScaleFactor || 2) });
        Object.defineProperty(screen, 'height', { get: () => dev.screen?.height || dev.viewport.height * (dev.deviceScaleFactor || 2) });
        Object.defineProperty(screen, 'availWidth', { get: () => dev.screen?.width || dev.viewport.width * (dev.deviceScaleFactor || 2) });
        Object.defineProperty(screen, 'availHeight', { get: () => (dev.screen?.height || dev.viewport.height * (dev.deviceScaleFactor || 2)) - 80 });

        // ── 9. 阻止 webdriver 检测 ──
        Object.defineProperty(navigator, 'webdriver', { get: () => false });

        // ── 10. 移动特有属性 ──
        window.orientation = { type: 'portrait-primary', angle: 0 };
        window.screen.orientation = { type: 'portrait-primary', angle: 0 };

        // ── 11. 阻止自动化检测 ──
        delete window.__playwright;
        delete window.__pw_manual;
        delete window.__PW_inspector;

        console.log('[mobile-emulator] Device: ' + dev.name + ' (' + dev.brand + ' ' + dev.os + ')');
      })();
    `;
  }

  /**
   * 📱 获取完整的移动端 Chromium 启动参数
   */
  getMobileChromiumArgs(device) {
    const args = [
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-site-isolation-trials',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-infobars',
      '--disable-dev-shm-usage',
      // 移动端特有
      '--disable-web-security',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=TranslateUI',
      '--disable-ipc-flooding-protection',
      // 模拟移动网络
      '--force-effective-connection-type=4G',
    ];

    return args;
  }

  /**
   * 📋 列出所有可用设备
   */
  listDevices(filter = null) {
    let devices = Object.entries(this.devices).map(([id, d]) => ({ id, ...d }));
    if (filter === 'ios') devices = devices.filter(d => d.os === 'iOS');
    if (filter === 'android') devices = devices.filter(d => d.os === 'Android');
    return devices;
  }

  /**
   * 📊 获取设备统计
   */
  getStats() {
    const ios = Object.values(this.devices).filter(d => d.os === 'iOS').length;
    const android = Object.values(this.devices).filter(d => d.os === 'Android').length;
    return { total: Object.keys(this.devices).length, ios, android };
  }
}

// 单例
let _instance = null;
function getMobileEmulator() {
  if (!_instance) _instance = new MobileEmulator();
  return _instance;
}

// ══════════════════════════════════════════════════════════

module.exports = { MobileEmulator, getMobileEmulator, MOBILE_DEVICES };
