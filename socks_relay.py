# -*- coding: utf-8 -*-
"""
socks_relay.py — SOCKS5-to-HTTP proxy relay for LokiProxy

Accept HTTP connections locally, tunnel through LokiProxy SOCKS5 to internet.
"""

import asyncio, socket, struct, sys, time
from datetime import datetime

LOKIPROXY = ("198.44.171.80", 10000)
LOKI_USER = b"hellowen1"
LOKI_PASS = b"zdd1234"
RELAY_PORT = 8089

def log(msg): print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)

async def socks5_connect(host: str, port: int) -> tuple:
    """Connect through LokiProxy SOCKS5 to target host:port"""
    reader, writer = await asyncio.open_connection(*LOKIPROXY)
    
    # SOCKS5 handshake with auth
    writer.write(b'\x05\x02\x00\x02')
    await writer.drain()
    resp = await reader.readexactly(2)
    if resp != b'\x05\x02':
        writer.close(); return None, None
    
    # Auth
    auth = b'\x01' + bytes([len(LOKI_USER)]) + LOKI_USER + bytes([len(LOKI_PASS)]) + LOKI_PASS
    writer.write(auth)
    await writer.drain()
    resp2 = await reader.readexactly(2)
    if resp2 != b'\x01\x00':
        writer.close(); return None, None
    
    # CONNECT request
    target_bytes = host.encode()
    connect = b'\x05\x01\x00\x03' + bytes([len(target_bytes)]) + target_bytes + struct.pack('>H', port)
    writer.write(connect)
    await writer.drain()
    
    resp3 = await reader.readexactly(10)
    if resp3[1] != 0:
        codes = {0:'OK',1:'General failure',2:'Not allowed',3:'Net unreachable',
                 4:'Host unreachable',5:'Refused',6:'TTL expired',7:'Cmd unsupported',8:'Addr type'}
        err = codes.get(resp3[1], f'code {resp3[1]}')
        log(f"  SOCKS5 CONNECT {host}:{port} → {err}")
        writer.close()
        return None, None
    
    return reader, writer

async def handle_http(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
    """Handle HTTP proxy request"""
    try:
        # Read request line
        request_line = await asyncio.wait_for(reader.readline(), timeout=30)
        if not request_line: writer.close(); return
        
        # Read headers
        headers = []
        while True:
            line = await asyncio.wait_for(reader.readline(), timeout=10)
            if line == b'\r\n' or not line.strip(): break
            headers.append(line)
        
        # Parse: GET http://target.com/path HTTP/1.1 or CONNECT target:port
        parts = request_line.split()
        if len(parts) < 2: writer.close(); return
        
        method = parts[0]
        url = parts[1].decode()
        
        if method == b'CONNECT':
            # HTTPS — tunnel
            target = url.split(':')
            host, port = target[0], int(target[1]) if len(target) > 1 else 443
            
            sr, sw = await socks5_connect(host, port)
            if not sr:
                writer.write(b'HTTP/1.1 502 Bad Gateway\r\n\r\n')
                await writer.drain(); writer.close(); return
            
            writer.write(b'HTTP/1.1 200 Connection established\r\n\r\n')
            await writer.drain()
            
            # Bidirectional relay
            async def pipe(src_r, src_w, dst_r, dst_w):
                try:
                    while True:
                        data = await asyncio.wait_for(src_r.read(65536), timeout=120)
                        if not data: break
                        dst_w.write(data)
                        await dst_w.drain()
                except: pass
            
            t1 = asyncio.create_task(pipe(reader, writer, sw, sw))
            t2 = asyncio.create_task(pipe(sr, sw, writer, writer))
            done, pending = await asyncio.wait([t1, t2], return_when=asyncio.FIRST_COMPLETED)
            for t in pending: t.cancel()
            sw.close()
        else:
            # HTTP — proxy request
            if url.startswith('http://'):
                url_stripped = url[7:]
            else:
                # Relative URL, get host from headers
                host_header = None
                for h in headers:
                    if h.lower().startswith(b'host:'):
                        host_header = h[5:].strip().decode()
                        break
                url_stripped = f"{host_header}{url}" if host_header else url
            
            if '/' in url_stripped:
                host_part = url_stripped.split('/', 1)[0]
                path = '/' + url_stripped.split('/', 1)[1]
            else:
                host_part = url_stripped
                path = '/'
            
            target_host = host_part
            target_port = 80
            if ':' in target_host:
                target_host, ps = target_host.split(':', 1)
                target_port = int(ps)
            
            sr, sw = await socks5_connect(target_host, target_port)
            if not sr:
                writer.write(b'HTTP/1.1 502 Bad Gateway\r\n\r\n')
                await writer.drain(); writer.close(); return
            
            # Forward the HTTP request
            req = f'{method.decode()} {path} HTTP/1.1\r\n'
            for h in headers:
                hd = h.decode()
                if hd.lower().startswith('proxy-'): continue
                req += hd
            req += '\r\n'
            sw.write(req.encode())
            await sw.drain()
            
            # Relay response
            while True:
                try:
                    data = await asyncio.wait_for(sr.read(65536), timeout=30)
                    if not data: break
                    writer.write(data)
                    await writer.drain()
                except: break
            
            sw.close()
            writer.close()
    except Exception as e:
        log(f"  Error: {e}")
    finally:
        try: writer.close()
        except: pass

async def main():
    log(f"SOCKS5 Relay: localhost:{RELAY_PORT} → LokiProxy SOCKS5")
    server = await asyncio.start_server(handle_http, "", RELAY_PORT)
    log(f"Listening on :{RELAY_PORT}")
    async with server:
        await server.serve_forever()

if __name__ == "__main__":
    asyncio.run(main())
