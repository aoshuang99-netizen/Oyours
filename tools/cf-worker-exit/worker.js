/**
 * Cloudflare Workers 出口节点（vless + websocket + TLS over 443）
 *
 * 工作原理：
 *   本地 mihomo(vless/ws/tls)  ->  https://<name>.workers.dev  ->  Worker
 *   Worker 解析 vless 头后用 cloudflare:sockets 的 connect() 直连目标 TCP
 *   出口 IP = Cloudflare 边缘数据中心 IP（海量、与机房 IP 无关）
 *
 * 依赖：无外部包；需要 compatibility_date >= 2023-08-01（cloudflare:sockets）
 * 环境变量：UUID（可选，留空则不校验）
 */
import { connect } from 'cloudflare:sockets';

const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;

function hexToBytes(hexStr) {
  const out = new Uint8Array(hexStr.length / 2);
  for (let i = 0; i < hexStr.length; i += 2) out[i / 2] = parseInt(hexStr.slice(i, i + 2), 16);
  return out;
}

function base64ToArrayBuffer(b64) {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  const buf = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) buf[i] = s.charCodeAt(i);
  return buf.buffer;
}

function parseAddress(buf, offset, type) {
  if (type === 1) {
    const v = new Uint8Array(buf.slice(offset, offset + 4));
    return { value: Array.from(v).join('.'), len: 4 };
  }
  if (type === 2) {
    const len = new Uint8Array(buf.slice(offset, offset + 1))[0];
    return { value: new TextDecoder().decode(buf.slice(offset + 1, offset + 1 + len)), len: len + 1 };
  }
  if (type === 3) {
    const v = new Uint16Array(buf.slice(offset, offset + 16));
    return { value: Array.from(v).map((x) => x.toString(16)).join(':'), len: 16 };
  }
  return { value: '', len: 0, bad: true };
}

/** 解析 vless 头：|ver(1)|uuid(16)|addonLen(1)|addon|cmd(1)|port(2)|atype(1)|addr|payload| */
function parseVlessHeader(buf, uuid) {
  if (buf.byteLength < 24) return { hasError: true, message: 'data too short' };
  const ver = new Uint8Array(buf.slice(0, 1))[0];
  if (ver !== 0) return { hasError: true, message: `unsupported version ${ver}` };
  if (uuid) {
    const want = hexToBytes(uuid.replace(/-/g, ''));
    const got = new Uint8Array(buf.slice(1, 17));
    let ok = want.length === 16;
    for (let i = 0; ok && i < 16; i++) if (want[i] !== got[i]) ok = false;
    if (!ok) return { hasError: true, message: 'invalid user' };
  }
  const optLen = new Uint8Array(buf.slice(17, 18))[0];
  const cmd = new Uint8Array(buf.slice(18 + optLen, 19 + optLen))[0];
  if (cmd !== 1 && cmd !== 2) return { hasError: true, message: `command ${cmd} unsupported` };
  const portIdx = 19 + optLen;
  const portRemote = new DataView(buf.slice(portIdx, portIdx + 2)).getUint16(0);
  const atypeIdx = portIdx + 2;
  const addressType = new Uint8Array(buf.slice(atypeIdx, atypeIdx + 1))[0];
  const a = parseAddress(buf, atypeIdx + 1, addressType);
  if (a.bad) return { hasError: true, message: `invalid addressType ${addressType}` };
  const dataIdx = atypeIdx + 1 + a.len;
  return {
    hasError: false,
    addressRemote: a.value,
    addressType,
    portRemote,
    rawDataIndex: dataIdx,
    rawClientData: buf.slice(dataIdx),
    isUDP: cmd === 2,
  };
}

function makeReadableWebSocketStream(ws, earlyDataHeader) {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      ws.addEventListener('message', (e) => {
        if (cancelled) return;
        controller.enqueue(e.data);
      });
      ws.addEventListener('error', (e) => {
        if (cancelled) return;
        controller.error(e);
      });
      ws.addEventListener('close', () => {
        if (cancelled) return;
        try { controller.close(); } catch (_) {}
      });
      if (earlyDataHeader) {
        try { controller.enqueue(base64ToArrayBuffer(earlyDataHeader)); } catch (_) {}
      }
    },
    pull() {},
    cancel() { cancelled = true; },
  });
  return stream;
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const upgrade = request.headers.get('Upgrade');

      // 非 WebSocket：诊断端点（供出口 IP 探测 / 健康检查）
      if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
        if (url.pathname === '/ip') {
          try {
            const r = await fetch('https://api.ipify.org?format=json', { cf: { cacheTtl: 0 } });
            const t = await r.text();
            return new Response(t, { status: 200, headers: { 'content-type': 'application/json' } });
          } catch (e) {
            return new Response(JSON.stringify({ error: String(e) }), {
              status: 500, headers: { 'content-type': 'application/json' },
            });
          }
        }
        return new Response('mscms-exit', { status: 200 });
      }

      const uuid = env.UUID || '';
      const [client, ws] = Object.values(new WebSocketPair());
      ws.accept();

      let remoteSocket = null;
      let mode = null; // 'vless' | 'raw'
      const earlyData = request.headers.get('sec-websocket-protocol') || '';
      const readable = makeReadableWebSocketStream(ws, earlyData);

      const send = (d) => {
        if (ws.readyState !== WS_READY_STATE_OPEN) return;
        if (d instanceof ArrayBuffer) ws.send(d);
        else if (d && d.buffer) ws.send(d.buffer.slice(d.byteOffset || 0, (d.byteOffset || 0) + d.byteLength));
        else ws.send(d);
      };
      const pumpRemote = () => {
        remoteSocket.readable
          .pipeTo(
            new WritableStream({
              write(d) { send(d); },
              close() { setTimeout(() => safeClose(ws), 1000); },
              abort() { setTimeout(() => safeClose(ws), 1000); },
            })
          )
          .catch(() => safeClose(ws));
      };
      const writeRemote = async (data) => {
        const w = remoteSocket.writable.getWriter();
        await w.write(data);
        w.releaseLock();
      };
      const dial = (host, port) => { remoteSocket = connect({ hostname: host, port }); pumpRemote(); };

      readable
        .pipeTo(
          new WritableStream({
            async write(chunk) {
              // 第一帧决定协议：文本 = 自有轻量协议("host:port")，二进制 = vless
              if (!mode) {
                if (typeof chunk === 'string') {
                  const idx = chunk.lastIndexOf(':');
                  if (idx < 0) throw new Error('bad raw target: ' + chunk);
                  const host = chunk.slice(0, idx).trim();
                  const port = parseInt(chunk.slice(idx + 1), 10);
                  if (!host || !port) throw new Error('bad raw target: ' + chunk);
                  mode = 'raw';
                  dial(host, port);
                  return;
                }
                mode = 'vless';
                const buf = chunk instanceof ArrayBuffer ? chunk : (chunk && chunk.buffer ? chunk.buffer : null);
                if (!buf) throw new Error('unsupported first frame');
                const h = parseVlessHeader(buf, uuid);
                if (h.hasError) throw new Error(h.message);
                if (h.isUDP) throw new Error('udp not supported by this exit');
                dial(h.addressRemote, h.portRemote);
                if (h.rawClientData && h.rawClientData.byteLength) await writeRemote(h.rawClientData);
                return;
              }
              if (!remoteSocket) throw new Error('no remote socket');
              await writeRemote(chunk);
            },
            close() { safeClose(ws); },
            abort() { safeClose(ws); },
          })
        )
        .catch((e) => { console.log('[exit] err: ' + e); safeClose(ws); });

      return new Response(null, { status: 101, webSocket: client });
    } catch (err) {
      return new Response(String(err && err.stack ? err.stack : err), { status: 500 });
    }
  },
};

function safeClose(ws) {
  try {
    if (ws.readyState === WS_READY_STATE_OPEN || ws.readyState === WS_READY_STATE_CLOSING) ws.close();
  } catch (_) {}
}
