#!/usr/bin/env node
/**
 * 用 Node 原生 TLS（OpenSSL）经指定 HTTP 代理请求 HTTPS 目标，
 * 用来区分「隧道本身不支持 TLS 中继」与「curl 的 schannel 侧问题」。
 *
 * 用法: node tls-via-proxy.cjs <代理端口> [url]
 */
const { ProxyAgent, fetch } = require('undici');

const port = process.argv[2] || '20201';
const url = process.argv[3] || 'https://www.cloudflare.com/cdn-cgi/trace';

const agent = new ProxyAgent(`http://:${port}`);
const t0 = Date.now();

fetch(url, { dispatcher: agent, signal: AbortSignal.timeout(25000) })
  .then(async (r) => {
    const text = (await r.text()).trim();
    console.log(`[${port}] OK status=${r.status} ${Date.now() - t0}ms`);
    console.log(text.split('\n').slice(0, 8).map(l => '   ' + l).join('\n'));
  })
  .catch((e) => {
    console.log(`[${port}] FAIL ${Date.now() - t0}ms :: ${e.name}: ${e.message}${e.cause ? ' | cause=' + (e.cause.message || e.cause) : ''}`);
  });
