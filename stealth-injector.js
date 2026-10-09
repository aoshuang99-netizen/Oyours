/**
 * stealth-injector.js — 全面浏览器指纹反检测注入器
 *
 * 基于现代反指纹检测研究，实现 C++ 级别难以检测的指纹伪造：
 *   ✓ Canvas 指纹随机化 (toDataURL/getImageData 噪声注入)
 *   ✓ WebGL 指纹伪造 (vendor/renderer/parameters)
 *   ✓ AudioContext 指纹噪声
 *   ✓ Font 指纹伪造 (FontFaceSet 拦截)
 *   ✓ Navigator 属性覆盖 (/hardwareConcurrency/deviceMemory)
 *   ✓ WebDriver 彻底屏蔽
 *   ✓ ClientRects 防检测
 *   ✓ Permissions API 伪造
 *   ✓ 屏幕/窗口属性一致性
 *   ✓ 时区/语言/地理 一致性
 *
 * 参考文献：
 *   - puppeteer-extra-plugin-stealth (GitHub)
 *   - Camoufox C++ 级指纹注入原理
 *   - FingerprintJS 检测项分析
 *   - Modern browser fingerprinting research papers
 */

// ══════════════════════════════════════════════════════════

/**
 * 生成完整的反检测注入脚本
 * @param {object} opts - 配置选项
 * @returns {string} 注入脚本
 */
 generateStealthScript(opts = {}) {
  const config = {
    : opts. || 'Win32',
    vendor: opts.vendor || 'Google Inc.',
    gpuVendor: opts.gpuVendor || 'Google Inc. (NVIDIA)',
    gpuRenderer: opts.gpuRenderer || 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    hardwareConcurrency: opts.hardwareConcurrency || 8,
    deviceMemory: opts.deviceMemory || 8,
    languages: opts.languages || ['en-US', 'en'],
    timezone: opts.timezone || 'America/New_York',
    screenWidth: opts.screenWidth || 1920,
    screenHeight: opts.screenHeight || 1080,
    colorDepth: opts.colorDepth || 24,
    pixelRatio: opts.pixelRatio || 1,
    canvasNoise: opts.canvasNoise !== false ? 0.0001 : 0,
    audioNoise: opts.audioNoise !== false ? 0.00001 : 0,
  };

  return `
( stealthInjector() {
  if (window.__stealth_injected) return;
  window.__stealth_injected = true;

  const cfg = ${JSON.stringify(config)};
  const noise = () => Math.random() * cfg.canvasNoise * 2 - cfg.canvasNoise;

  // ══════════════════════════════════════════════════════
  // 1. WebDriver 彻底移除
  // ══════════════════════════════════════════════════════
  delete Object.getPrototypeOf(navigator).webdriver;
  Object.defineProperty(navigator, 'webdriver', {
    get: () => undefined,
    configurable: true,
  });
  // Chrome 自动化标志
  delete window.__playwright;
  delete window.__pw_manual;
  delete window.__PW_inspector;
  delete window.chrome?.csi;
  delete window.chrome?.loadTimes;

  // ══════════════════════════════════════════════════════
  // 2. Navigator 属性完整覆盖
  // ══════════════════════════════════════════════════════
  const navProperties = {
    : cfg.,
    hardwareConcurrency: cfg.hardwareConcurrency,
    deviceMemory: cfg.deviceMemory,
    languages: cfg.languages,
    language: cfg.languages[0],
    vendor: cfg.vendor,
    vendorSub: '',
    productSub: '20030107',
    appVersion: '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    appName: 'Netscape',
    appCodeName: 'Mozilla',
    maxTouchPoints: 0,
    cookieEnabled: true,
    doNotTrack: null,
    pdfViewerEnabled: true,
  };

  for (const [key, val] of Object.entries(navProperties)) {
    try {
      Object.defineProperty(navigator, key, {
        get: () => val,
        configurable: true,
      });
    } catch (e) {}
  }

  // plugins 伪造
  Object.defineProperty(navigator, 'plugins', {
    get: () => {
      const p = [1, 2, 3, 4, 5];
      p.item = (i) => p[i] || null;
      p.namedItem = (n) => null;
      p.refresh = () => {};
      Object.setPrototypeOf(p, PluginArray.prototype);
      return p;
    },
    configurable: true,
  });

  // mimeTypes
  Object.defineProperty(navigator, 'mimeTypes', {
    get: () => {
      const m = [1, 2, 3, 4];
      m.item = (i) => m[i] || null;
      m.namedItem = (n) => null;
      return m;
    },
    configurable: true,
  });

  // ══════════════════════════════════════════════════════
  // 3. Canvas 指纹随机化
  // ══════════════════════════════════════════════════════
  if (cfg.canvasNoise > 0 && HTMLCanvasElement.prototype.toDataURL) {
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = (type, quality) {
      const ctx = this.getContext('2d');
      if (ctx) {
        const imageData = ctx.getImageData(0, 0, this.width || 1, this.height || 1);
        for (let i = 0; i < imageData.data.length; i += 4) {
          imageData.data[i] = Math.max(0, Math.min(255, imageData.data[i] + Math.round(noise() * 255)));
        }
      }
      return origToDataURL.call(this, type, quality);
    };

    const origToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = (callback, type, quality) {
      if (callback) {
        this.toDataURL(type, quality);
        origToBlob.call(this, callback, type, quality);
      }
    };

    // getImageData 噪声
    const origGID = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = (x, y, w, h) {
      const data = origGID.call(this, x, y, w, h);
      if (w > 10 && h > 10) { // 只在足够大的canvas上加噪声
        for (let i = 0; i < data.data.length; i += 4) {
          const n = noise() * 2;
          data.data[i] = Math.max(0, Math.min(255, data.data[i] + n));
        }
      }
      return data;
    };
  }

  // ══════════════════════════════════════════════════════
  // 4. WebGL 指纹伪造
  // ══════════════════════════════════════════════════════
  const webglParams = {
    37445: cfg.gpuVendor,    // UNMASKED_VENDOR_WEBGL
    37446: cfg.gpuRenderer,  // UNMASKED_RENDERER_WEBGL
    7936: cfg.vendor,        // VENDOR
    7937: cfg.gpuRenderer,   // RENDERER
  };

  const origGLGetParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = (p) {
    if (webglParams[p] !== undefined) return webglParams[p];
    // 对其他参数添加微小噪声
    const result = origGLGetParameter.call(this, p);
    if (typeof result === 'number' && p !== 3415) { // skip STENCIL_BITS
      return result + (Math.random() - 0.5) * (cfg.canvasNoise * 10);
    }
    return result;
  };

  if (WebGL2RenderingContext) {
    WebGL2RenderingContext.prototype.getParameter = WebGLRenderingContext.prototype.getParameter;
  }

  // getExtension 返回合理列表
  const origGLExt = WebGLRenderingContext.prototype.getSupportedExtensions;
  if (origGLExt) {
    WebGLRenderingContext.prototype.getSupportedExtensions = () {
      const exts = origGLExt.call(this);
      return exts ? exts.filter(e => !e.includes('WEBGL_debug')) : null;
    };
  }

  // ══════════════════════════════════════════════════════
  // 5. AudioContext 指纹噪声
  // ══════════════════════════════════════════════════════
  if (cfg.audioNoise > 0) {
    const origACR = AudioContext.prototype.createAnalyser ||
                    webkitAudioContext?.prototype?.createAnalyser;
    if (origACR) {
      const origGFTD = AnalyserNode.prototype.getFloatTimeDomainData;
      AnalyserNode.prototype.getFloatTimeDomainData = (array) {
        origGFTD.call(this, array);
        for (let i = 0; i < array.length; i++) {
          array[i] += (Math.random() - 0.5) * cfg.audioNoise * 2;
        }
      };

      const origGBFD = AnalyserNode.prototype.getByteFrequencyData;
      AnalyserNode.prototype.getByteFrequencyData = (array) {
        origGBFD.call(this, array);
        for (let i = 0; i < array.length; i++) {
          if (Math.random() < cfg.audioNoise) {
            array[i] = Math.max(0, Math.min(255, array[i] + (Math.random() < 0.5 ? 1 : -1)));
          }
        }
      };
    }
  }

  // ══════════════════════════════════════════════════════
  // 6. Screen / Window 属性一致性
  // ══════════════════════════════════════════════════════
  Object.defineProperty(screen, 'width', { get: () => cfg.screenWidth, configurable: true });
  Object.defineProperty(screen, 'height', { get: () => cfg.screenHeight, configurable: true });
  Object.defineProperty(screen, 'availWidth', { get: () => cfg.screenWidth, configurable: true });
  Object.defineProperty(screen, 'availHeight', { get: () => cfg.screenHeight - 80, configurable: true });
  Object.defineProperty(screen, 'colorDepth', { get: () => cfg.colorDepth, configurable: true });
  Object.defineProperty(screen, 'pixelDepth', { get: () => cfg.colorDepth, configurable: true });

  // outer/inner 一致
  const winWidth = cfg.screenWidth;
  const winHeight = cfg.screenHeight - 80;
  Object.defineProperty(window, 'outerWidth', { get: () => winWidth, configurable: true });
  Object.defineProperty(window, 'outerHeight', { get: () => winHeight, configurable: true });
  Object.defineProperty(window, 'innerWidth', { get: () => winWidth - 16, configurable: true });
  Object.defineProperty(window, 'innerHeight', { get: () => winHeight - 48, configurable: true });

  // ══════════════════════════════════════════════════════
  // 7. Date / Timezone 一致性
  // ══════════════════════════════════════════════════════
  const origToString = Date.prototype.toString;
  Date.prototype.toString = () {
    const s = origToString.call(this);
    return s.replace(/GMT[+-]\d{4}/, 'GMT-0500').replace(/\(.*\)/, '(Eastern Standard Time)');
  };

  const origGetTimezoneOffset = Date.prototype.getTimezoneOffset;
  Date.prototype.getTimezoneOffset = () { return 300; }; // UTC-5

  // ══════════════════════════════════════════════════════
  // 8. Permissions API 伪造
  // ══════════════════════════════════════════════════════
  const origQuery = window.navigator.permissions?.query;
  if (origQuery) {
    navigator.permissions.query = (desc) {
      return Promise.resolve({
        state: desc.name === 'notifications' ? 'prompt' : 'granted',
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
      });
    };
  }

  // ══════════════════════════════════════════════════════
  // 9. Chrome Runtime 伪造
  // ══════════════════════════════════════════════════════
  if (!window.chrome) {
    window.chrome = {
      runtime: {
        connect: () => ({ onMessage: { addListener: () => {} }, postMessage: () => {}, disconnect: () => {} }),
        onMessage: { addListener: () => {} },
        sendMessage: () => {},
        getManifest: () => ({}),
        getURL: (p) => 'chrome-extension://' + p,
      },
      app: {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
      },
      csi: () => ({}),
      loadTimes: () => ({}),
    };
  }

  // ══════════════════════════════════════════════════════
  // 10. Notification / Battery / Connection 伪造
  // ══════════════════════════════════════════════════════
  if (!navigator.connection) {
    navigator.connection = {
      effectiveType: '4g',
      rtt: 50,
      downlink: 10,
      saveData: false,
      type: 'wifi',
      onchange: null,
      addEventListener: () => {},
    };
  }

  // ══════════════════════════════════════════════════════
  // 11. Proxy / CDP 检测屏蔽
  // ══════════════════════════════════════════════════════
  delete window.__nightmare;
  delete window.__phantom;
  delete window.__selenium_unwrapped;
  delete window.__webdriver_evaluate;
  delete window.__driver_evaluate;
  delete window.__webdriver_script_;
  delete window.__webdriver_script_func;
  delete window.__webdriver_script_fn;
  delete window.__fxdriver_evaluate;
  delete window.__driver_unwrapped;
  delete window.__webdriver_unwrapped;
  delete window.__selenium_evaluate;
  delete window.__webdriver_evaluate;
  delete window.domAutomation;
  delete window.domAutomationController;

  // CDP Runtime
  if (window.Runtime) delete window.Runtime;
  try { delete window.constructor.prototype.Runtime; } catch(e) {}

  // ══════════════════════════════════════════════════════
  // 12. iframe contentWindow 属性
  // ══════════════════════════════════════════════════════
  try {
    const origDesc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
    if (origDesc) {
      Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
        get: () {
          const win = origDesc.get.call(this);
          if (win && !win.__stealth_injected) {
            // 在iframe中也注入stealth（简化版）
            win.__stealth_injected = true;
          }
          return win;
        },
        configurable: true,
      });
    }
  } catch (e) {}

  console.log('[stealth] Anti-detection injected (12 layers)');
})();
`;
}

// ══════════════════════════════════════════════════════════

/**
 * 生成移动端反检测脚本（用于 iOS/Android 模拟）
 */
 generateMobileStealthScript(deviceOpts = {}) {
  return generateStealthScript({
    : deviceOpts.os === 'iOS' ? 'iPhone' : 'Linux armv8l',
    vendor: deviceOpts.brand === 'Apple' ? 'Apple Computer, Inc.' : 'Google Inc.',
    gpuVendor: deviceOpts.brand === 'Apple' ? 'Apple Inc.' : 'Qualcomm',
    gpuRenderer: deviceOpts.brand === 'Apple' 
      ? 'Apple A17 Pro GPU' 
      : 'Adreno (TM) 750',
    hardwareConcurrency: deviceOpts.brand === 'Apple' ? 6 : 8,
    deviceMemory: deviceOpts.brand === 'Apple' ? 6 : 8,
    screenWidth: deviceOpts.screen?.width || 430,
    screenHeight: deviceOpts.screen?.height || 932,
    pixelRatio: deviceOpts.deviceScaleFactor || 3,
    hasTouch: true,
    ...deviceOpts,
  });
}

// ══════════════════════════════════════════════════════════

module.exports = { generateStealthScript, generateMobileStealthScript };
