# -*- coding: utf-8 -*-
"""
proxy_relay_v2.py — Full HTTP proxy relay through US proxy → LokiProxy

Handles both CONNECT tunneling and standard HTTP proxy requests.
"""

import asyncio, sys, time, re
from datetime import datetime

US_PROXY = ("", 10808)
RELAY_PORT = 8080

def get_lokiproxy():
    import requests
    try:
        r = requests.get("http://gen.lokiproxy.com/gen?ptype=1&count=1&proto=http&stype=text&split=rn", timeout=10)
        host = r.text.strip()
        h, p = host.split(":")
        return h, int(p)
    except Exception as e:
        print(f"[GEN] Failed: {e}")
        return None

async def do_connect(lp_host, lp_port, reader, writer):
    """Establish tunnel: local → US proxy → LokiProxy → target"""
    us_r, us_w = await asyncio.open_connection(*US_PROXY)
    connect = f"CONNECT {lp_host}:{lp_port} HTTP/1.1\r\nHost: {lp_host}:{lp_port}\r\n\r\n"
    us_w.write(connect.encode()); await us_w.drain()
    
    resp = await us_r.readline()
    if b"200" not in resp:
        us_w.close(); return None, None
    
    # Skip headers
    while True:
        l = await us_r.readline()
        if l == b"\r\n" or not l.strip(): break
    
    return us_r, us_w

async def handle_http_request(request_line, headers, reader, writer):
    """Handle HTTP proxy request: GET http://target.com/path HTTP/1.1"""
    parsed = request_line.decode().split()
    if len(parsed) < 2: return
    method, url = parsed[0], parsed[1]
    
    # Extract host from URL
    if url.startswith("http://"):
        rest = url[7:]
        if "/" in rest:
            idx = rest.index("/")
            host_part, path = rest[:idx], rest[idx:]
        else:
            host_part, path = rest, "/"
    else:
        # Relative URL
        host_part = None
        for h in headers:
            if h.lower().startswith(b"host:"):
                host_part = h[5:].strip().decode()
        path = url
    
    if not host_part:
        writer.close(); return
    
    target_host = host_part
    target_port = 80
    if ":" in target_host:
        target_host, port_s = target_host.split(":")
        target_port = int(port_s)
    
    print(f"    HTTP {method} {target_host}:{target_port}{path}")
    
    # Get fresh LokiProxy
    lp = get_lokiproxy()
    if not lp:
        writer.write(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
        await writer.drain(); writer.close(); return
    lp_host, lp_port = lp
    
    # Build tunnel through US proxy → LokiProxy → target
    us_r, us_w = await asyncio.open_connection(*US_PROXY)
    connect = f"CONNECT {lp_host}:{lp_port} HTTP/1.1\r\nHost: {lp_host}:{lp_port}\r\n\r\n"
    us_w.write(connect.encode()); await us_w.drain()
    
    resp = await us_r.readline()
    if b"200" not in resp:
        writer.write(b"HTTP/1.1 502 Bad Gateway\r\n\r\nProxy unreachable.\r\n")
        await writer.drain(); writer.close(); us_w.close(); return
    
    while True:
        l = await us_r.readline()
        if l == b"\r\n" or not l.strip(): break
    
    # Now send the actual HTTP request through the tunnel to LokiProxy
    # LokiProxy is an HTTP proxy, so we send proxy-format request
    req_lines = [f"{method} http://{target_host}:{target_port}{path} HTTP/1.1".encode()]
    for h in headers:
        h_decoded = h.decode()
        if h_decoded.lower().startswith("proxy-"): continue
        req_lines.append(h)
    req_lines.append(b"")
    us_w.write(b"\r\n".join(req_lines) + b"\r\n")
    await us_w.drain()
    
    # Forward response back to client
    while True:
        try:
            data = await asyncio.wait_for(us_r.read(65536), timeout=30)
            if not data: break
            writer.write(data)
            await writer.drain()
        except: break
    
    us_w.close()
    writer.close()

async def handle_client(reader, writer):
    addr = writer.get_extra_info('peername')
    print(f"[{datetime.now():%H:%M:%S}] CLIENT: {addr}")
    try:
        # Read request line
        request_line = await asyncio.wait_for(reader.readline(), timeout=30)
        if not request_line: writer.close(); return
        
        # Read headers
        headers = []
        while True:
            line = await asyncio.wait_for(reader.readline(), timeout=10)
            if line == b"\r\n" or not line.strip():
                break
            headers.append(line)
        
        if request_line.startswith(b"CONNECT"):
            # CONNECT tunnel
            target = request_line.split(b" ")[1].decode()
            host, port = target.split(":")
            port = int(port)
            lp = get_lokiproxy()
            if not lp: writer.close(); return
            
            # Tunnel: local → US → LokiProxy
            us_r, us_w = await asyncio.open_connection(*US_PROXY)
            c1 = f"CONNECT {lp[0]}:{lp[1]} HTTP/1.1\r\nHost: {lp[0]}:{lp[1]}\r\n\r\n"
            us_w.write(c1.encode()); await us_w.drain()
            resp = await us_r.readline()
            if b"200" not in resp: us_w.close(); writer.close(); return
            while True:
                l = await us_r.readline()
                if l == b"\r\n" or not l.strip(): break
            
            # LokiProxy is HTTP proxy — send CONNECT to target through it
            # (This is for HTTPS which needs tunneling)
            c2 = f"CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n\r\n"
            us_w.write(c2.encode()); await us_w.drain()
            
            # For CONNECT requests (HTTPS), LokiProxy responds with 200 if target reachable
            proxy_resp = await us_r.readline()
            writer.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
            await writer.drain()
            
            # Bi-directional relay
            async def fwd(src, dst):
                try:
                    while True:
                        d = await asyncio.wait_for(src.read(65536), timeout=120)
                        if not d: break
                        dst.write(d); await dst.drain()
                except: pass
            
            t1 = asyncio.create_task(fwd(reader, us_w))
            t2 = asyncio.create_task(fwd(us_r, writer))
            await asyncio.wait([t1, t2], return_when=asyncio.FIRST_COMPLETED)
            us_w.close()
        else:
            await handle_http_request(request_line, headers, reader, writer)
    except Exception as e:
        print(f"    Error: {e}")
    finally:
        try: writer.close()
        except: pass

async def main():
    print(f"\n{'='*50}")
    print(f"PROXY RELAY v2: localhost:{RELAY_PORT} → US proxy → LokiProxy → target")
    print(f"{'='*50}\n")
    server = await asyncio.start_server(handle_client, "", RELAY_PORT)
    print(f"Listening on :{RELAY_PORT}\n")
    async with server:
        await server.serve_forever()

if __name__ == "__main__":
    asyncio.run(main())
