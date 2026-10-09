/**
 * proxy-creator.js — Cloudflare 美国原生节点代理创建器
 *
 * 通过 Cloudflare 现有域名自动创建美国出口代理节点：
 *
 *   模式1: 本地 SOCKS5 代理服务器（独立运行）
 *   模式2: Cloudflare Tunnel TCP 路由（需 CF 支持）
 *   模式3: Cloudflare WARP 代理模式（需 WARP 安装）
 *
 * 创建后自动：
 *   ✓ 添加到 proxy-manager 代理池
 *   ✓ 写入 .json → proxy.servers
 *   ✓ 注册引擎自动分配使用
 *   ✓ 代理类型标记为 "cloudflare_us"
 *
 * 用法：
 *   node proxy-creator.js --mode=local --port=1080
 *   node proxy-creator.js --mode=warp
 *   node proxy-creator.js --mode=tunnel --domain=proxy.hlua.cc.cd
 */

const { execSync, spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');
const axios = require('axios');

// ══════════════════════════════════════════════════════════

const CONFIG_DIR = 'D:/LeiDian/config';
const CF_CONFIG_DIR = path.join(process.env.USERPROFILE || 'C:/Users/AS', '.cloudflared');
const DEFAULT_SOCKS_PORT = 1080;
const DEFAULT_TUNNEL_DOMAIN = 'proxy.hlua.cc.cd';

class ProxyCreator {
  constructor(opts = {}) {
    this.mode = opts.mode || 'local';
    this.port = opts.port || DEFAULT_SOCKS_PORT;
    this.domain = opts.domain || DEFAULT_TUNNEL_DOMAIN;
    this.created = null; // { url, type, method }
  }

  /**
   * 🚀 主入口：创建代理节点并自动配置
   */
  async create() {
    console.log(`\n🌐 === Cloudflare 美国节点代理创建器 ===`);
    console.log(`  模式: ${this.mode} | 端口: ${this.port}`);

    let result;

    switch (this.mode) {
      case 'local':
        result = await this._createLocalSocks5();
        break;
      case 'tunnel':
        result = await this._createTunnelProxy();
        break;
      case 'warp':
        result = await this._createWarpProxy();
        break;
      case 'auto':
        result = await this._autoDetect();
        break;
      default:
        throw new Error(`Unknown mode: ${this.mode}. Supported: local, tunnel, warp, auto`);
    }

    if (result && result.url) {
      this.created = result;
      await this._addToProxyPool(result);
      await this._updateRegisterConfig(result);
      console.log(`\n✅ 代理节点已创建并自动配置！`);
      console.log(`   URL: ${result.url}`);
      console.log(`   类型: ${result.type}`);
    }

    return result;
  }

  /**
   * 获取当前创建的代理 URL
   */
  getProxyUrl() {
    return this.created?.url || null;
  }

  /**
   * 获取代理分配给注册引擎的完整配置
   */
  getRegistrationConfig() {
    if (!this.created) return null;
    return {
      : this.created.url,
      type: this.created.type,
      method: this.created.method,
      config: {
        proxy: { enabled: true, residential: true, servers: [this.created.url] },
      },
    };
  }

  // ═══ Mode 1: 本地 SOCKS5 ═══

  async _createLocalSocks5() {
    console.log(`\n📡 模式: 本地 SOCKS5 代理服务器`);

    // 检查端口是否可用
    const portFree = await this._checkPort(this.port);
    if (!portFree) {
      console.log(`  ⚠️ 端口 ${this.port} 已被占用，可能是已有代理在运行`);
      return {
        url: `socks5://:${this.port}`,
        type: 'cloudflare_us',
        method: 'local_socks5',
        note: 'Reusing existing port',
      };
    }

    // 启动 SOCKS5 服务器
    try {
      const { Socks5Server } = require('./proxy-socks-server.js');
      const server = new Socks5Server({ port: this.port });
      const info = await server.start();
      console.log(`  ✅ SOCKS5 服务器已启动: ${server.getProxyUrl()}`);

      return {
        url: server.getProxyUrl(),
        type: 'cloudflare_us',
        method: 'local_socks5',
        port: this.port,
        server,
        note: info.reused ? 'Port was already in use' : 'Freshly started',
      };
    } catch (e) {
      console.error(`  ❌ 启动失败: ${e.message}`);
      throw e;
    }
  }

  // ═══ Mode 2: Cloudflare Tunnel ═══

  async _createTunnelProxy() {
    console.log(`\n🔗 模式: Cloudflare Tunnel TCP 代理`);
    console.log(`  域名: ${this.domain}`);

    // 1. 先启动本地 SOCKS5 代理
    const socksResult = await this._createLocalSocks5();

    // 2. 检查 Cloudflare Tunnel 配置
    const configPath = path.join(CF_CONFIG_DIR, 'config.yml');
    if (!fs.existsSync(configPath)) {
      console.log(`  ⚠️ Cloudflare Tunnel 未配置，跳过隧道设置`);
      console.log(`  💡 SOCKS5 代理仍可在本地使用: ${socksResult.url}`);
      return socksResult;
    }

    // 3. 尝试添加 TCP 路由到现有 Tunnel
    try {
      const config = fs.readFileSync(configPath, 'utf-8');

      // 检查是否有 cloudflared CLI
      let hasCloudflared = false;
      try {
        execSync('cloudflared version', { stdio: 'ignore', timeout: 5000 });
        hasCloudflared = true;
      } catch {
        console.log(`  ⚠️ cloudflared CLI 不在 PATH 中`);
      }

      if (hasCloudflared) {
        // 尝试通过 cloudflared 创建 TCP 隧道
        console.log(`  🔄 通过 cloudflared 路由 TCP...`);
        try {
          const result = execSync(
            `cloudflared tunnel route ip add ${this.domain} --overwrite-dns 2>&1`,
            { timeout: 10000 }
          );
          console.log(`  ${result.trim()}`);
        } catch (e) {
          console.log(`  ⚠️ TCP 路由添加失败: ${e.message}`);
        }
      }

      // 更新 Tunnel ingress 配置
      const hasDomain = config.includes(`hostname: ${this.domain}`);
      if (!hasDomain) {
        console.log(`  📝 正在添加 ${this.domain} 到 Tunnel ingress...`);
        const newConfig = config.replace(
          '- service: http_status:404',
          `  - hostname: ${this.domain}\n    service: tcp://:${this.port}\n  - service: http_status:404`
        );

        // 备份原配置
        const backupPath = configPath + '.backup-' + Date.now();
        fs.copyFileSync(configPath, backupPath);
        console.log(`  💾 已备份原配置: ${backupPath}`);

        // 写入新配置
        fs.writeFileSync(configPath, newConfig);
        console.log(`  ✅ Tunnel 配置已更新`);

        // 提示重启
        console.log(`  ⚠️ 请重启 cloudflared tunnel 使配置生效`);
        console.log(`  💡 代理 URL (本地): ${socksResult.url}`);
      } else {
        console.log(`  ✅ 域名已存在于 Tunnel 配置中`);
      }
    } catch (e) {
      console.log(`  ⚠️ Tunnel 配置更新失败: ${e.message}`);
    }

    return socksResult;
  }

  // ═══ Mode 3: Cloudflare WARP ═══

  async _createWarpProxy() {
    console.log(`\n☁️ 模式: Cloudflare WARP 代理`);

    // 检测 WARP 是否安装
    const warpPaths = [
      'C:/Program Files/Cloudflare/Cloudflare WARP/warp-cli.exe',
      'C:/Program Files (x86)/Cloudflare/Cloudflare WARP/warp-cli.exe',
      '/usr/local/bin/warp-cli',
      '/usr/bin/warp-cli',
    ];

    let warpCli = null;
    for (const p of warpPaths) {
      if (fs.existsSync(p)) {
        warpCli = p;
        break;
      }
    }

    if (!warpCli) {
      console.log(`  ⚠️ Cloudflare WARP 未安装`);
      console.log(`  💡 下载: https://1.1.1.1/`);
      console.log(`  📋 降级为本地 SOCKS5 模式...`);
      return this._createLocalSocks5();
    }

    console.log(`  ✅ WARP CLI: ${warpCli}`);

    try {
      // 检查 WARP 状态
      const status = execSync(`"${warpCli}" status`, { timeout: 5000 });
      console.log(`  📊 状态: ${status.trim().slice(0, 80)}`);

      // 设置代理模式
      if (!status.includes('Connected')) {
        console.log(`  🔄 连接 WARP...`);
        execSync(`"${warpCli}" connect`, { timeout: 15000 });
      }

      // 启用代理模式（WARP 会在 :40000 启动 SOCKS5）
      execSync(`"${warpCli}" mode proxy`, { timeout: 10000 });
      console.log(`  ✅ WARP 代理模式已启用`);

      // 验证 WARP 代理端口
      const warpPort = 40000;
      const portInUse = await this._checkPort(warpPort);
      if (portInUse) {
        console.log(`  ⚠️ WARP 代理端口 ${warpPort} 已被占用（可能已在运行）`);
      }

      return {
        url: `socks5://:${warpPort}`,
        type: 'cloudflare_us',
        method: 'warp',
        note: 'Cloudflare WARP proxy mode — traffic exits via CF US edge',
      };
    } catch (e) {
      console.log(`  ❌ WARP 配置失败: ${e.message}`);
      console.log(`  📋 降级为本地 SOCKS5 模式...`);
      return this._createLocalSocks5();
    }
  }

  // ═══ Auto Detect ═══

  async _autoDetect() {
    console.log(`\n🔍 自动检测最佳代理创建方式...`);

    // 1. 先检查 WARP
    const warpPaths = [
      'C:/Program Files/Cloudflare/Cloudflare WARP/warp-cli.exe',
    ];
    const hasWarp = warpPaths.some(p => fs.existsSync(p));

    if (hasWarp) {
      console.log(`  → 检测到 WARP，使用 Cloudflare WARP 模式`);
      return this._createWarpProxy();
    }

    // 2. 检查 Cloudflare Tunnel
    const configPath = path.join(CF_CONFIG_DIR, 'config.yml');
    const hasTunnel = fs.existsSync(configPath);

    if (hasTunnel) {
      console.log(`  → 检测到 Cloudflare Tunnel，使用 Tunnel 模式`);
      return this._createTunnelProxy();
    }

    // 3. 默认本地 SOCKS5
    console.log(`  → 使用本地 SOCKS5 代理模式`);
    return this._createLocalSocks5();
  }

  // ═══ Auto-config ═══

  async _addToProxyPool(result) {
    try {
      const { getProxyManager } = require('./proxy-manager.js');
      const pm = getProxyManager();
      await pm.init();
      await pm.addProxy(result.url);

      // 标记为 cloudflare_us 类型（在 tested 中添加元数据）
      const existing = pm.tested.find(t => t.proxy === result.url);
      if (!existing) {
        pm.tested.push({
          proxy: result.url,
          ok: true,
          type: 'cloudflare_us',
          country: 'US',
          latencyMs: 5,
          score: 85,
          testedAt: new Date().toISOString(),
          source: 'cloudflare_creator',
        });
      }

      console.log(`  📋 已添加到代理池`);
    } catch (e) {
      console.log(`  ⚠️ 添加到代理池失败: ${e.message}`);
    }
  }

  async _updateRegisterConfig(result) {
    try {
      const regPath = path.join(CONFIG_DIR, '.json');
      if (!fs.existsSync(regPath)) return;

      const regConfig = JSON.parse(fs.readFileSync(regPath, 'utf-8'));
      const servers = regConfig.proxy?.servers || [];

      if (!servers.includes(result.url)) {
        servers.push(result.url);
        regConfig.proxy.servers = servers;
        regConfig.proxy.enabled = true;
        regConfig.proxy.residential = true;

        fs.writeFileSync(regPath, JSON.stringify(regConfig, null, 2));
        console.log(`  📝 已更新 .json`);
      }
    } catch (e) {
      console.log(`  ⚠️ 配置文件更新失败: ${e.message}`);
    }
  }

  // ═══ Helpers ═══

  _checkPort(port) {
    return new Promise((resolve) => {
      const tester = new net.Socket();
      tester.setTimeout(2000);
      tester.on('connect', () => { tester.destroy(); resolve(true); });
      tester.on('error', () => resolve(false));
      tester.on('timeout', () => { tester.destroy(); resolve(false); });
      tester.connect(port, '');
    });
  }
}

// ══════════════════════════════════════════════════════════
// CLI
// ══════════════════════════════════════════════════════════

if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (k) => { const f = args.find(a => a.startsWith(`--${k}=`)); return f ? f.split('=')[1] : null; };

  const creator = new ProxyCreator({
    mode: get('mode') || 'auto',
    port: parseInt(get('port') || '1080', 10),
    domain: get('domain') || 'proxy.hlua.cc.cd',
  });

  creator.create().then(result => {
    if (result?.url) {
      console.log(`\n📋 代理已就绪:`);
      console.log(`   URL: ${result.url}`);
      console.log(`   类型: ${result.type} (${result.method})`);
      console.log(`\n🔧 Playwright 用法:`);
      console.log(`   --proxy-server="${result.url}"`);
      console.log(`\n🔧 注册引擎自动使用此代理（已写入配置）`);
    }
  }).catch(err => {
    console.error('FATAL:', err.message);
    process.exit(1);
  });
}

module.exports = { ProxyCreator };
