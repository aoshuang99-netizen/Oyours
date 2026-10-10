/**
 * proxy-v2ray-manager.js — V2Ray/SS/SSR 节点转换为本地代理
 *
 * 集成 freefq/free 仓库节点，使用 sing-box 转换为本地代理。
 *
 * 两种 inbound 模式（均与现有 http-client 的 undici ProxyAgent 兼容）：
 *   - socks5 : socks5://127.0.0.1:{port}   （Playwright 浏览器用）
 *   - http  : http://127.0.0.1:{port}      （Node fetchExt 用，解决 429 多出口核心）
 *
 * 架构：
 *   freefq 仓库 → vmess/ss 节点 → sing-box → (socks5|http)://127.0.0.1:{port}
 *
 * 用法：
 *   const mgr = getProxyV2RayManager();
 *   await mgr.init();
 *   const sock = await mgr.startRandomNode();              // socks5://127.0.0.1:1081
 *   const httpProxies = await mgr.startDistinctHttp(12);   // [{url:'http://127.0.0.1:1081', ...}]
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');

// ══════════════════════════════════════════════════════════

const SING_BOX = 'D:/LeiDian/sing-box/sing-box-1.13.13-windows-amd64/sing-box.exe';
const FREEFQ_V2 = 'D:/LeiDian/freefq-proxy/v2';
const BASE_PORT = 1081;

class ProxyV2RayManager {
  constructor() {
    this.nodes = [];
    // port → { process, pid, node, type, url, configPath }
    this.activeProxies = new Map();
    this.nextPort = BASE_PORT;
  }

  /**
   * 初始化：解析 freefq 节点
   */
  async init() {
    console.log('[v2ray-mgr] Parsing freefq nodes...');
    this.nodes = this._parseFreefqNodes();
    console.log(`[v2ray-mgr] Parsed ${this.nodes.length} nodes (${this.nodes.filter(n=>n.type==='vmess').length} vmess, ${this.nodes.filter(n=>n.type==='ss').length} ss)`);
    return this.nodes.length;
  }

  /**
   * 启动一个随机节点作为本地 SOCKS5 代理（向后兼容：浏览器/旧用法）
   */
  async startRandomNode() {
    if (this.nodes.length === 0) await this.init();
    const node = this.nodes[Math.floor(Math.random() * this.nodes.length)];
    return this.startNode(node, 'socks');
  }

  /**
   * 启动指定节点，产出 HTTP 或 SOCKS5 本地代理。
   * 返回 { port, url, pid, type, node }；失败抛错。
   * 进程 detached + windowsHide，独立于 activator 脚本存活。
   */
  async startNode(node, inboundType = 'socks') {
    if (this.nodes.length === 0) await this.init();
    const port = this.nextPort++;
    const config = this._buildConfig(node, port, inboundType);
    const configPath = path.join(__dirname, `.singbox-${port}.json`);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    const scheme = inboundType === 'http' ? 'http' : 'socks5';
    const url = `${scheme}://127.0.0.1:${port}`;

    return new Promise((resolve, reject) => {
      let proc;
      try {
        proc = spawn(SING_BOX, ['run', '-c', configPath], {
          stdio: 'ignore',
          detached: true,    // 脱离父进程，脚本退出后仍常驻（代理需长期在线）
          windowsHide: true, // 不弹控制台窗口
        });
        proc.unref();
      } catch (e) {
        reject(new Error(`sing-box spawn failed: ${e.message}`));
        return;
      }

      proc.on('error', (err) => {
        reject(new Error(`sing-box failed: ${err.message}`));
      });

      // 等待端口打开
      let attempts = 0;
      const check = setInterval(() => {
        attempts++;
        const sock = new net.Socket();
        sock.setTimeout(1000);
        sock.on('connect', () => {
          sock.destroy();
          clearInterval(check);
          this.activeProxies.set(port, { process: proc, pid: proc.pid, node, type: inboundType, url, configPath });
          console.log(`[v2ray-mgr] ✅ ${inboundType.toUpperCase()} ready: ${url}`);
          resolve({ port, url, pid: proc.pid, type: inboundType, node });
        });
        sock.on('error', () => {
          sock.destroy();
          if (attempts > 15) {
            clearInterval(check);
            try { proc.kill(); } catch {}
            try { fs.unlinkSync(configPath); } catch {}
            reject(new Error(`sing-box port ${port} not responding`));
          }
        });
        sock.connect(port, '127.0.0.1');
      }, 1000);
    });
  }

  /**
   * 启动至多 n 个「出口 IP 互不相同」的节点，全部产出 HTTP 本地代理。
   * 429 根因缓解核心：每个账号按确定性哈希分到不同出口 IP，分散 Tumblr 限流。
   * 返回成功启动的代理数组（失败节点被跳过）。
   */
  async startDistinctHttp(n) {
    if (this.nodes.length === 0) await this.init();
    const nodes = this._distinctNodes(n);
    const results = [];
    for (const node of nodes) {
      try {
        const r = await this.startNode(node, 'http');
        results.push(r);
        console.log(`[v2ray-mgr] 节点 ${node.host} → ${r.url} (出口 ${node.host}:${node.port})`);
      } catch (e) {
        console.error(`[v2ray-mgr] 节点 ${node.host} 启动失败: ${e.message}`);
      }
    }
    return results;
  }

  /** 取出口 IP 互异的节点（按 host 去重，最大化独立出口数量） */
  _distinctNodes(maxN) {
    const seen = new Set();
    const out = [];
    for (const n of this.nodes) {
      if (seen.has(n.host)) continue;
      seen.add(n.host);
      out.push(n);
      if (out.length >= maxN) break;
    }
    // 节点数不足 maxN 时，允许同 host 不同端口的节点补齐（次优，但仍多一个出口可能）
    if (out.length < maxN) {
      for (const n of this.nodes) {
        if (out.length >= maxN) break;
        if (out.includes(n)) continue;
        out.push(n);
      }
    }
    return out;
  }

  /** 让 nextPort 跳过已占用（之前运行遗留）的端口，避免 bind 冲突 */
  seedNextPort(usedPorts) {
    const max = usedPorts.reduce((m, p) => Math.max(m, p), BASE_PORT - 1);
    this.nextPort = max + 1;
  }

  /**
   * 停止所有代理
   */
  stopAll() {
    for (const [port, info] of this.activeProxies) {
      try { if (info.pid) process.kill(info.pid); } catch {}
      try { info.process && info.process.kill(); } catch {}
      try { fs.unlinkSync(info.configPath); } catch {}
      console.log(`[v2ray-mgr] Stopped ${info.type}://127.0.0.1:${port}`);
    }
    this.activeProxies.clear();
    this.nextPort = BASE_PORT;
  }

  /**
   * 获取活跃代理列表
   */
  getActiveProxies() {
    return [...this.activeProxies.values()].map(p => p.url);
  }

  // ═══ Internal ═══

  // 合法 host：域名或 IPv4（过滤 freefq 的「使用前记得更新订阅」等中文占位死节点）
  _validHost(h) {
    if (!h || /[^\x00-\x7F]/.test(h)) return false; // 含非 ASCII（中文）直接淘汰
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(h)) return true; // IPv4
    return /^([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}$/.test(h); // 域名
  }

  _parseFreefqNodes() {
    const nodes = [];
    try {
      const raw = fs.readFileSync(FREEFQ_V2, 'utf-8');
      const decoded = Buffer.from(raw, 'base64').toString('utf-8');
      const lines = decoded.split('\n').filter(l => l.trim());

      for (const line of lines) {
        try {
          if (line.startsWith('vmess://')) {
            const json = JSON.parse(Buffer.from(line.slice(8), 'base64').toString('utf-8'));
            const host = json.add;
            if (!this._validHost(host)) continue; // 跳过占位/无效节点
            nodes.push({
              type: 'vmess',
              host,
              port: parseInt(json.port) || 443,
              uuid: json.id,
              security: json.scy || 'auto',
              alterId: parseInt(json.aid) || 0, // sing-box 要求 int，不可传字符串
              network: json.net || 'tcp',
              path: json.path || '/',
              host_header: json.host || null,
              name: json.ps || 'vmess-node',
              raw: line,
            });
          } else if (line.startsWith('ss://')) {
            // ss://BASE64(method:password)@host:port#name
            const withoutPrefix = line.slice(5);
            const atIdx = withoutPrefix.indexOf('@');
            const hashIdx = withoutPrefix.indexOf('#');
            if (atIdx > 0) {
              const userInfoB64 = withoutPrefix.slice(0, atIdx);
              const userInfo = Buffer.from(userInfoB64, 'base64').toString('utf-8');
              const [method, password] = userInfo.split(':');
              const hostPortPart = hashIdx > 0 ? withoutPrefix.slice(atIdx + 1, hashIdx) : withoutPrefix.slice(atIdx + 1);
              const [host, port] = hostPortPart.split(':');
              if (!this._validHost(host)) continue;
              nodes.push({
                type: 'ss',
                host,
                port: parseInt(port) || 8388,
                method: method || 'aes-256-gcm',
                password: password || '',
                name: hashIdx > 0 ? decodeURIComponent(withoutPrefix.slice(hashIdx + 1)).slice(0, 50) : 'ss-node',
                raw: line,
              });
            }
          }
        } catch (e) {
          // skip invalid node
        }
      }
    } catch (e) {
      console.error('[v2ray-mgr] Failed to parse nodes:', e.message);
    }
    return nodes;
  }

  _buildConfig(node, localPort, inboundType = 'socks') {
    const tag = inboundType === 'http' ? 'http-in' : 'socks-in';
    const config = {
      log: { level: 'error' },
      inbounds: [{
        type: inboundType,
        tag,
        listen: '127.0.0.1',
        listen_port: localPort,
      }],
      outbounds: [],
    };

    if (node.type === 'vmess') {
      config.outbounds.push({
        type: 'vmess',
        tag: 'vmess-out',
        server: node.host,
        server_port: node.port,
        uuid: node.uuid,
        security: node.security,
        alter_id: parseInt(node.alterId) || 0,
        transport: node.network === 'ws' ? {
          type: 'ws',
          path: node.path || '/',
          headers: node.host_header ? { Host: node.host_header } : {},
        } : {},
      });
    } else if (node.type === 'ss') {
      config.outbounds.push({
        type: 'shadowsocks',
        tag: 'ss-out',
        server: node.host,
        server_port: node.port,
        method: node.method,
        password: node.password,
      });
    }

    // Direct fallback
    config.outbounds.push({
      type: 'direct',
      tag: 'direct',
    });

    config.route = {
      rules: [{
        inbound: [tag],
        outbound: node.type === 'vmess' ? 'vmess-out' : 'ss-out',
      }],
      final: 'direct',
    };

    return config;
  }
}

// 单例
let _instance = null;
function getProxyV2RayManager() {
  if (!_instance) _instance = new ProxyV2RayManager();
  return _instance;
}

// ══════════════════════════════════════════════════════════

module.exports = { ProxyV2RayManager, getProxyV2RayManager };
