#!/usr/bin/env node
/**
 * _start-kkmatch-backend.js — 启动 KK Match 后端 API（:8001），detached 常驻 + 零弹窗
 *
 * 为什么不用 wscript/schtasks：本机安全策略拦截 LOLBin（wscript/cscript/schtasks），
 * 故改用 node 原生 detached spawn + pythonw（GUI 子系统，不建控制台窗口）。
 *
 * 用法: node tools/_start-kkmatch-backend.js
 */
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');

const BASE = 'D:\\kk-match-backend';
const PY = path.join(BASE, '.venv', 'Scripts', 'pythonw.exe');
const ENTRY = path.join(BASE, 'backend', 'main.py');
const LOG = 'D:\\_kkmatch_backend.log';
const PORT = 8001;

function probe(port, timeout = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(timeout, () => { s.destroy(); resolve(false); });
  });
}

(async () => {
  if (await probe(PORT)) {
    console.log(`[kkmatch] 端口 ${PORT} 已在监听，跳过启动`);
    return;
  }
  if (!fs.existsSync(PY)) throw new Error(`pythonw 不存在: ${PY}`);
  if (!fs.existsSync(ENTRY)) throw new Error(`入口不存在: ${ENTRY}`);
  const logDir = path.dirname(LOG);
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const fd = fs.openSync(LOG, 'a');
  const child = spawn(PY, [ENTRY], {
    cwd: BASE,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
  });
  child.unref();
  console.log(`[kkmatch] 已拉起 PID=${child.pid} 日志=${LOG}`);
  // 等待监听
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 700));
    if (await probe(PORT)) { console.log(`[kkmatch] ✅ 端口 ${PORT} 已监听（第${i + 1}次探测）`); return; }
  }
  console.log(`[kkmatch] ⚠️ 20 次探测后端口 ${PORT} 仍未监听，请查看日志`);
  process.exitCode = 2;
})();
