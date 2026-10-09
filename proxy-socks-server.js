/**
 * proxy-socks-server.js — 本地 SOCKS5 代理服务器
 *
 * 通过 Cloudflare Tunnel + 现有域名创建美国原生出口节点。
 * Playwright 浏览器直接连接 localhost:{port} 通过 SOCKS5 协议代理流量。
 *
 * 架构：
 *   浏览器 → socks5://:{port} → Cloudflare网络 → 目标站点
 *   (配合 Cloudflare Tunnel，流量通过 Cloudflare 美国边缘节点出口)
 *
 * 用法：
 *   node proxy-socks-server.js --port=1080
 *   或通过 proxy-creator.js 自动启动
 */

const net = require('net');
const dns = require('dns');
const fs = require('fs');
const path = require('path');

// ══════════════════════════════════════════════════════════

// SOCKS5 协议常量
const SOCKS_VERSION = 0x05;
const AUTH_NONE = 0x00;
const AUTH_USER_PASS = 0x02;
const CMD_CONNECT = 0x01;
const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;
const REP_SUCCESS = 0x00;
const REP_GENERAL_FAILURE = 0x01;
const REP_CONNECTION_REFUSED = 0x05;
const REP_HOST_UNREACHABLE = 0x04;

class Socks5Server {
  constructor(opts = {}) {
    this.port = opts.port || 1080;
    this.host = opts.host || '';
    this.auth = opts.auth || null; // {, }
    this.server = null;
    this._connections = new Set();
    this._running = false;
    this._stats = { connections: 0, bytesIn: 0, bytesOut: 0, errors: 0 };
    this._upstreamProxy = opts.upstreamProxy || null; // 上游代理(如WARP)
  }

  /**
   * 启动 SOCKS5 服务器
   */
  async start() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this._handleConnection(socket);
      });

      this.server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          this._running = true; // 已在运行
          resolve({ port: this.port, reused: true });
        } else {
          reject(err);
        }
      });

      this.server.listen(this.port, this.host, () => {
        this._running = true;
        console.log(`[socks5] Server started on ${this.host}:${this.port}`);
        if (this._upstreamProxy) {
          console.log(`[socks5] Upstream: ${this._upstreamProxy}`);
        }
        resolve({ port: this.port, host: this.host });
      });
    });
  }

  /**
   * 停止 SOCKS5 服务器
   */
  async stop() {
    this._running = false;
    for (const conn of this._connections) {
      try { conn.destroy(); } catch {}
    }
    this._connections.clear();
    if (this.server) {
      return new Promise((resolve) => {
        this.server.close(() => resolve());
      });
    }
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return { ...this._stats, connections: this._connections.size, running: this._running };
  }

  /**
   * 获取代理 URL
   */
  getProxyUrl() {
    if (this.auth) {
      return `socks5://${this.auth.}:${this.auth.}@${this.host}:${this.port}`;
    }
    return `socks5://${this.host}:${this.port}`;
  }

  // ═══ Internal: SOCKS5 Protocol Handler ═══

  _handleConnection(clientSocket) {
    this._connections.add(clientSocket);
    this._stats.connections++;

    let handshakeDone = false;
    let targetSocket = null;

    const cleanup = () => {
      this._connections.delete(clientSocket);
      try { clientSocket.destroy(); } catch {}
      if (targetSocket) try { targetSocket.destroy(); } catch {}
    };

    // Step 1: 握手 — 认证协商
    clientSocket.once('data', (data) => {
      if (data[0] !== SOCKS_VERSION) {
        this._stats.errors++;
        clientSocket.end();
        return;
      }

      const authMethods = [];
      for (let i = 2; i < 2 + data[1]; i++) {
        authMethods.push(data[i]);
      }

      // 选择认证方式
      let chosenAuth = AUTH_NONE;
      if (this.auth && authMethods.includes(AUTH_USER_PASS)) {
        chosenAuth = AUTH_USER_PASS;
      }

      // 发送认证选择
      const response = Buffer.from([SOCKS_VERSION, chosenAuth]);
      clientSocket.write(response);

      if (chosenAuth === AUTH_USER_PASS) {
        // 用户名密码认证
        clientSocket.once('data', (authData) => {
          if (authData[0] !== 0x01) {
            clientSocket.write(Buffer.from([0x01, 0x01])); // failure
            cleanup();
            return;
          }
          const ulen = authData[1];
          const  = authData.slice(2, 2 + ulen);
          const plen = authData[2 + ulen];
          const  = authData.slice(3 + ulen, 3 + ulen + plen);

          if ( === this.auth. &&  === this.auth.) {
            clientSocket.write(Buffer.from([0x01, 0x00])); // success
            _handleRequest();
          } else {
            clientSocket.write(Buffer.from([0x01, 0x01]));
            cleanup();
          }
        });
      } else {
        _handleRequest();
      }
    });

     _handleRequest() {
      clientSocket.once('data', (reqData) => {
        if (reqData[0] !== SOCKS_VERSION || reqData[1] !== CMD_CONNECT) {
          // 不支持的命令
          const reply = _buildReply(0x07); // Command not supported
          clientSocket.write(reply);
          cleanup();
          return;
        }

        // 解析目标地址
        const atyp = reqData[3];
        let targetHost, targetPort, headerLen;

        if (atyp === ATYP_IPV4) {
          targetHost = `${reqData[4]}.${reqData[5]}.${reqData[6]}.${reqData[7]}`;
          targetPort = reqData.readUInt16BE(8);
          headerLen = 10;
        } else if (atyp === ATYP_DOMAIN) {
          const domainLen = reqData[4];
          targetHost = reqData.slice(5, 5 + domainLen);
          targetPort = reqData.readUInt16BE(5 + domainLen);
          headerLen = 5 + domainLen + 2;
        } else if (atyp === ATYP_IPV6) {
          targetHost = reqData.slice(4, 20'hex');
          targetPort = reqData.readUInt16BE(20);
          headerLen = 22;
        } else {
          const reply = _buildReply(REP_GENERAL_FAILURE);
          clientSocket.write(reply);
          cleanup();
          return;
        }

        // 记录日志
        // console.log(`[socks5] → ${targetHost}:${targetPort}`);

        // 创建到目标的连接（或通过上游代理）
        if (this._upstreamProxy) {
          _connectViaUpstream(targetHost, targetPort, clientSocket);
        } else {
          _connectDirect(targetHost, targetPort, clientSocket);
        }

        // 双向管道
         _connectDirect(host, port, clientSock) {
          targetSocket = new net.Socket();
          targetSocket.connect(port, host, () => {
            const reply = _buildReply(REP_SUCCESS);
            clientSock.write(reply);

            // 双向转发
            clientSock.pipe(targetSocket);
            targetSocket.pipe(clientSock);

            clientSock.on('data', (d) => { const s = Socks5Server._instance; if (s) s._stats.bytesOut += d.length; });
            targetSocket.on('data', (d) => { const s = Socks5Server._instance; if (s) s._stats.bytesIn += d.length; });
          });

          targetSocket.on('error', (err) => {
            let repCode = REP_GENERAL_FAILURE;
            if (err.code === 'ECONNREFUSED') repCode = REP_CONNECTION_REFUSED;
            else if (err.code === 'ENOTFOUND' || err.code === 'EHOSTUNREACH') repCode = REP_HOST_UNREACHABLE;

            const reply = _buildReply(repCode);
            try { clientSock.write(reply); } catch {}
            cleanup();
          });

          targetSocket.on('close', () => cleanup());
          clientSock.on('error', () => cleanup());
          clientSock.on('close', () => {
            if (targetSocket) targetSocket.end();
            cleanup();
          });
        }
      });
    }

     _buildReply(repCode) {
      const reply = Buffer.alloc(10);
      reply[0] = SOCKS_VERSION;
      reply[1] = repCode;
      reply[2] = 0x00; // RSV
      reply[3] = ATYP_IPV4;
      reply[4] = 0; reply[5] = 0; reply[6] = 0; reply[7] = 0; // bind.addr
      reply[8] = 0; reply[9] = 0; // bind.port
      return reply;
    }

    clientSocket.on('error', () => cleanup());
    clientSocket.on('close', () => cleanup());
  }
}

// 单例
let _instance = null;

/**
 * 获取或创建 SOCKS5 服务器实例
 */
 getSocks5Server(port = 1080) {
  if (!_instance) {
    _instance = new Socks5Server({ port });
    Socks5Server._instance = _instance;
  }
  return _instance;
}

// ══════════════════════════════════════════════════════════
// CLI
// ══════════════════════════════════════════════════════════

if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (k) => { const f = args.find(a => a.startsWith(`--${k}=`)); return f ? f.split('=')[1] : null; };
  const port = parseInt(get('port') || '1080', 10);

  const server = new Socks5Server({ port });
  server.start().then((info) => {
    console.log(`SOCKS5 proxy ready: ${server.getProxyUrl()}`);
    console.log(`Use with Playwright: --proxy-server="${server.getProxyUrl()}"`);

    // 保持运行
    process.on('SIGINT', async () => {
      console.log('\nShutting down...');
      await server.stop();
      process.exit(0);
    });
  }).catch(err => {
    console.error('Failed to start:', err.message);
    process.exit(1);
  });
}

module.exports = { Socks5Server, getSocks5Server };
