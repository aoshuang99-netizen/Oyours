"""
HTTP Proxy Relay: Per-connection chain -> US V2Ray -> LokiProxy Residential
Each CONNECT gets dedicated SOCKS5 chain for IP consistency within connection.
"""
import socket
import struct
import threading
import logging
import select
import time

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
log = logging.getLogger('http-relay')

LISTEN_HOST = ''
LISTEN_PORT = 8090
US_PROXY_HOST = ''
US_PROXY_PORT = 10808
LOKIPROXY_HOST = '198.44.171.80'
LOKIPROXY_PORT = 10000
LOKIPROXY_USER = 'hellowen1'
LOKIPROXY_PASS = 'zdd1234'


def chain_connect(dst_host, dst_port, timeout=20):
    """Start a new SOCKS5 chain per tunnel. Each gets dedicated connection."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(timeout)
    
    # Connect to US proxy
    s.connect((US_PROXY_HOST, US_PROXY_PORT))
    
    # US SOCKS5 handshake
    s.sendall(b'\x05\x01\x00')
    if _recv(s, 2) != b'\x05\x00':
        raise Exception("US fail")
    
    # CONNECT to LokiProxy
    addr_b = LOKIPROXY_HOST.encode()
    req = b'\x05\x01\x00\x03' + bytes([len(addr_b)]) + addr_b + LOKIPROXY_PORT.to_bytes(2, 'big')
    s.sendall(req)
    resp = _recv(s, 10)
    if not resp or resp[1] != 0:
        raise Exception("US->Loki fail")
    
    # Loki SOCKS5 auth
    s.sendall(b'\x05\x02\x00\x02')
    if _recv(s, 2) != b'\x05\x02':
        raise Exception("Loki hs fail")
    
    user_b = LOKIPROXY_USER.encode()
    pass_b = LOKIPROXY_PASS.encode()
    auth = b'\x01' + bytes([len(user_b)]) + user_b + bytes([len(pass_b)]) + pass_b
    s.sendall(auth)
    if _recv(s, 2) != b'\x01\x00':
        raise Exception("Loki auth fail")
    
    # CONNECT to target
    target_b = dst_host.encode()
    req = b'\x05\x01\x00\x03' + bytes([len(target_b)]) + target_b + dst_port.to_bytes(2, 'big')
    s.sendall(req)
    resp = _recv(s, 10, timeout=timeout)
    if not resp or resp[1] != 0:
        raise Exception(f"CONNECT {dst_host}:{dst_port} failed")
    
    return s


def _recv(sock, n, timeout=10):
    """Receive exactly n bytes."""
    sock.settimeout(timeout)
    data = b''
    while len(data) < n:
        chunk = sock.recv(n - len(data))
        if not chunk:
            return None
        data += chunk
    return data


def _read_until(sock, delimiter, max_size=65536, timeout=10):
    """Read until delimiter found."""
    sock.settimeout(timeout)
    data = b''
    while len(data) < max_size:
        try:
            chunk = sock.recv(1)
            if not chunk:
                break
            data += chunk
            if data.endswith(delimiter):
                break
        except socket.timeout:
            break
    return data


def relay(src, dst, stop_event, direction):
    """Relay data between two sockets."""
    try:
        bytes_count = 0
        while not stop_event.is_set():
            try:
                readable, _, _ = select.select([src], [], [], 0.5)
                if stop_event.is_set():
                    break
                if src in readable:
                    data = src.recv(65536)
                    if not data:
                        break
                    dst.sendall(data)
                    bytes_count += len(data)
            except socket.timeout:
                continue
            except:
                break
    except:
        pass
    finally:
        stop_event.set()


def handle_client(client_sock, addr):
    """Handle one HTTP proxy client session."""
    conn_id = threading.get_ident()
    log.info(f"[{conn_id}] Client: {addr}")
    active_tunnels = []
    
    try:
        while True:
            client_sock.settimeout(300)
            
            # Read HTTP request
            request = _read_until(client_sock, b'\r\n\r\n', timeout=60)
            if not request:
                break
            
            request_line = request.decode(errors='replace').split('\r\n')[0]
            log.info(f"[{conn_id}] {request_line}")
            
            parts = request_line.split()
            if len(parts) < 2:
                client_sock.sendall(b'HTTP/1.1 400 Bad Request\r\n\r\n')
                continue
            
            method, target = parts[0], parts[1]
            
            if method != 'CONNECT':
                client_sock.sendall(b'HTTP/1.1 405 Method Not Allowed\r\n\r\n')
                continue
            
            if ':' in target:
                host, port = target.split(':')
                port = int(port)
            else:
                host, port = target, 443
            
            try:
                remote_sock = chain_connect(host, port, timeout=25)
                # Send 200 to client
                client_sock.sendall(b'HTTP/1.1 200 Connection Established\r\n\r\n')
                
                # Relay in background thread
                stop = threading.Event()
                t1 = threading.Thread(target=relay, args=(client_sock, remote_sock, stop, 'c->r'), daemon=True)
                t2 = threading.Thread(target=relay, args=(remote_sock, client_sock, stop, 'r->c'), daemon=True)
                t1.start()
                t2.start()
                active_tunnels.append((t1, t2, stop))
                
                # Wait for tunnels to finish (browser closes connection)
                t1.join(timeout=300)
                t2.join(timeout=300)
                stop.set()
                break  # Done with this client
                
            except Exception as e:
                log.error(f"[{conn_id}] Chain error: {e}")
                client_sock.sendall(b'HTTP/1.1 502 Bad Gateway\r\n\r\n')
        
    except Exception as e:
        log.debug(f"[{conn_id}] Session ended: {e}")
    finally:
        for t1, t2, stop in active_tunnels:
            stop.set()
        try:
            client_sock.close()
        except:
            pass


def main():
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((LISTEN_HOST, LISTEN_PORT))
    server.listen(50)
    
    log.info("=" * 60)
    log.info(f"HTTP Proxy Relay v2 (Persistent Chain) on {LISTEN_HOST}:{LISTEN_PORT}")
    log.info(f"Single chain: US V2Ray -> LokiProxy ({LOKIPROXY_HOST}:{LOKIPROXY_PORT})")
    log.info(f"All connections from one browser SHARE the same residential IP")
    log.info("=" * 60)
    
    while True:
        try:
            client, addr = server.accept()
            t = threading.Thread(target=handle_client, args=(client, addr), daemon=True)
            t.start()
        except KeyboardInterrupt:
            break
        except Exception as e:
            log.error(f"Accept error: {e}")
    
    server.close()


if __name__ == '__main__':
    main()
