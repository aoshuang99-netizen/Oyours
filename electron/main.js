// MSCMS v14.2 Desktop Application - Electron Main Process
// 2026-07-08 — ConversionEngine hydrate + 前端修复

const electron = require('electron');
const app = electron.app;
const BrowserWindow = electron.BrowserWindow;
const Tray = electron.Tray;
const Menu = electron.Menu;
const nativeImage = electron.nativeImage;
const dialog = electron.dialog;
const shell = electron.shell;

const path = require('path');
const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const fs = require('fs');

// Debug: verify electron module loaded correctly
if (!app) {
  console.error('[FATAL] electron.app is undefined! electron keys:', Object.keys(electron));
  process.exit(1);
}
console.log('[MSCMS] Electron app loaded successfully');

// ─── 配置 ───────────────────────────────────────────
const PROJECT_ROOT = path.join(__dirname, '..');
const MANAGED_NODE = path.join(
  process.env.USERPROFILE || process.env.HOME,
  '.workbuddy', 'binaries', 'node', 'versions', '22.22.2', 'node.exe'
);

const CONFIG = {
  serverPort: 3002,
  consolePath: '/v14',
  serverScript: path.join(PROJECT_ROOT, 'server.js'),
  projectRoot: PROJECT_ROOT,
  iconPath: path.join(__dirname, 'assets', 'icon.png'),
  windowWidth: 1400,
  windowHeight: 900,
  minWidth: 1024,
  minHeight: 680,
  serverStartTimeout: 30000,
  healthCheckInterval: 3000,
  loadingHtml: path.join(__dirname, 'loading.html'),
};

let mainWindow = null;
let tray = null;
let serverProcess = null;
let isQuitting = false;

// ─── 服务器管理 ──────────────────────────────────────

function isPortOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(2000);
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => { sock.destroy(); resolve(false); });
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
    sock.connect(port, host);
  });
}

async function waitForServer(timeout = CONFIG.serverStartTimeout) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    if (await isPortOpen(CONFIG.serverPort)) {
      // Double-check with HTTP request
      const ok = await healthCheck();
      if (ok) return true;
    }
    await new Promise(r => setTimeout(r, CONFIG.healthCheckInterval));
  }
  return false;
}

function healthCheck() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${CONFIG.serverPort}/api/v14/dashboard`, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(3000, () => { req.destroy(); resolve(false); });
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    console.log('[MSCMS] 正在启动后端服务器...');

    // Use managed Node.js binary, fallback to system node
    let nodeExe = 'node';
    if (fs.existsSync(MANAGED_NODE)) {
      nodeExe = MANAGED_NODE;
      console.log(`[MSCMS] 使用 Node.js: ${nodeExe}`);
    } else {
      console.log('[MSCMS] 使用系统 Node.js');
    }

    serverProcess = spawn(nodeExe, [CONFIG.serverScript], {
      cwd: CONFIG.projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        MSCMS_DESKTOP: '1',
        // Ensure server modules can be resolved from project root
        NODE_PATH: CONFIG.projectRoot,
      },
    });

    serverProcess.stdout.on('data', (data) => {
      console.log(`[Server] ${data.toString().trim()}`);
    });

    serverProcess.stderr.on('data', (data) => {
      console.error(`[Server:err] ${data.toString().trim()}`);
    });

    serverProcess.on('error', (err) => {
      console.error('[MSCMS] 服务器启动失败:', err.message);
      reject(err);
    });

    serverProcess.on('exit', (code) => {
      if (!isQuitting) {
        console.error(`[MSCMS] 服务器异常退出 (code: ${code})`);
      }
      serverProcess = null;
    });

    // Wait for server to be ready
    resolve();
  });
}

function stopServer() {
  if (serverProcess) {
    console.log('[MSCMS] 正在停止服务器...');
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', serverProcess.pid.toString(), '/f', '/t']);
    } else {
      serverProcess.kill('SIGTERM');
    }
    serverProcess = null;
  }
}

// ─── 窗口管理 ────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: CONFIG.windowWidth,
    height: CONFIG.windowHeight,
    minWidth: CONFIG.minWidth,
    minHeight: CONFIG.minHeight,
    title: 'MSCMS v14.2 — 全链路因果闭环 · 引流转化修复',
    icon: CONFIG.iconPath,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    backgroundColor: '#0a1628',
  });

  // Remove default menu
  Menu.setApplicationMenu(null);

  // Show loading page first
  if (fs.existsSync(CONFIG.loadingHtml)) {
    mainWindow.loadFile(CONFIG.loadingHtml);
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function navigateToConsole() {
  if (!mainWindow) return;
  const url = `http://127.0.0.1:${CONFIG.serverPort}${CONFIG.consolePath}`;
  console.log(`[MSCMS] 服务器就绪，导航至: ${url}`);
  mainWindow.loadURL(url);
}

// ─── 系统托盘 ────────────────────────────────────────

function createTray() {
  // Create a simple 16x16 icon programmatically if icon file doesn't exist
  let trayIcon;
  try {
    trayIcon = nativeImage.createFromPath(CONFIG.iconPath);
    if (trayIcon.isEmpty()) throw new Error('Icon empty');
  } catch {
    // Fallback: create from built-in app icon
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon.resize({ width: 16, height: 16 }));
  tray.setToolTip('MSCMS v14.2 — 全链路因果闭环');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: '打开控制台 (浏览器)',
      click: () => {
        shell.openExternal(`http://127.0.0.1:${CONFIG.serverPort}/v14`);
      },
    },
    { type: 'separator' },
    {
      label: '服务器状态',
      enabled: false,
    },
    {
      label: '重启服务器',
      click: async () => {
        stopServer();
        await new Promise(r => setTimeout(r, 1000));
        await startServer();
        const ready = await waitForServer();
        if (ready) {
          dialog.showMessageBox(mainWindow || null, {
            type: 'info',
            title: 'MSCMS v14',
            message: '服务器已重启',
          });
        }
      },
    },
    { type: 'separator' },
    {
      label: '完全退出',
      click: () => {
        isQuitting = true;
        stopServer();
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ─── 应用生命周期 ────────────────────────────────────

app.on('ready', async () => {
  console.log('[MSCMS] 桌面应用启动中...');

  try {
    // Check if server is already running
    const alreadyRunning = await isPortOpen(CONFIG.serverPort);
    if (alreadyRunning) {
      console.log('[MSCMS] 检测到服务器已在运行，直接连接...');
    } else {
      await startServer();
      const ready = await waitForServer();
      if (!ready) {
        dialog.showErrorBox(
          '启动失败',
          `服务器未能启动 (端口 ${CONFIG.serverPort})。\n请检查 Node.js 环境和端口占用。`
        );
        app.quit();
        return;
      }
    }

    console.log('[MSCMS] 服务器就绪，创建窗口...');
    createTray();
    createWindow();

    // Navigate to console once server is confirmed
    if (alreadyRunning) {
      // Server already running, navigate immediately after window shows
      setTimeout(() => navigateToConsole(), 1000);
    } else {
      navigateToConsole();
    }

  } catch (err) {
    dialog.showErrorBox('启动失败', err.message);
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  stopServer();
});

app.on('window-all-closed', () => {
  // Don't quit on window close — stay in tray
});

app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
});
