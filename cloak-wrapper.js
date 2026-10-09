/**
 * cloak-wrapper.js — CloakBrowser CommonJS 包装器
 *
 * CloakBrowser 是 ESM-only 模块，我们的项目使用 CommonJS。
 * 此包装器通过动态 import() 加载 CloakBrowser，并导出 CommonJS 接口。
 *
 * 功能：
 *   - launch() — 启动隐形 Chromium（替代 playwright chromium.launch）
 *   - launchPersistentContext() — 启动持久化上下文
 *   - launchContext() — 快速创建 browser+context
 *   - 自动下载二进制（首次运行）
 */

let _cloakbrowser = null;

async  getCloak() {
  if (!_cloakbrowser) {
    _cloakbrowser = await import('cloakbrowser');
  }
  return _cloakbrowser;
}

/**
 * 启动隐形 Chromium 浏览器
 * 替代: const browser = await chromium.launch()
 */
async  launchCloak(opts = {}) {
  const cb = await getCloak();

  // 确保二进制已下载
  try {
    await cb.ensureBinary();
  } catch (e) {
    console.log('[cloak] Binary download:', e.message.slice(0, 80));
  }

  const launchOpts = {
    headless: opts.headless !== undefined ? opts.headless : false,
    // 🔀 通过本地代理路由
    proxy: null, // CloakBrowser 通过 args 传代理更稳定
    args: [
      ...(opts.args || []),
    ],
    timezone: opts.timezone || 'America/New_York',
    locale: opts.locale || 'en-US',
    humanize: opts.humanize !== undefined ? opts.humanize : true, // 🧠 人类行为模拟
    geoip: opts.geoip !== undefined ? opts.geoip : false,
    ...opts,
  };

  // 代理配置
  if (opts.) {
    launchOpts.args.push(`--proxy-server=${opts.}`);
  }

  console.log(`[cloak] Launching (humanize=${launchOpts.humanize}, headless=${launchOpts.headless})`);
  const browser = await cb.launch(launchOpts);
  return browser;
}

/**
 * 启动持久化浏览器上下文
 * 替代: const ctx = await chromium.launchPersistentContext(userDataDir, opts)
 */
async  launchPersistentContextCloak(opts = {}) {
  const cb = await getCloak();

  try {
    await cb.ensureBinary();
  } catch (e) {}

  const ctxOpts = {
    headless: opts.headless !== undefined ? opts.headless : false,
    viewport: opts.viewport || { width: 1280, height: 900 },
    userAgent: opts.userAgent,
    locale: opts.locale || 'en-US',
    timezone: opts.timezone || 'America/New_York',
    humanize: opts.humanize !== undefined ? opts.humanize : true,
    geoip: opts.geoip !== undefined ? opts.geoip : false,
    args: [
      ...(opts.args || []),
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ],
    ignoreDefaultArgs: opts.ignoreDefaultArgs || ['--enable-'],
    ...opts,
  };

  // 代理
  if (opts.) {
    ctxOpts.args.push(`--proxy-server=${opts.}`);
  }

  if (opts.userDataDir) {
    console.log(`[cloak] Launching persistent context (${opts.userDataDir})`);
    return await cb.launchPersistentContext(opts.userDataDir, ctxOpts);
  } else {
    console.log('[cloak] Launching fresh context');
    return await cb.launchContext(ctxOpts);
  }
}

/**
 * 快速启动 browser + context
 */
async  launchContextCloak(opts = {}) {
  const cb = await getCloak();
  try { await cb.ensureBinary(); } catch (e) {}
  return await cb.launchContext({
    headless: false,
    humanize: true,
    ...opts,
  });
}

module.exports = {
  launchCloak,
  launchPersistentContextCloak,
  launchContextCloak,
  getCloak,
};
