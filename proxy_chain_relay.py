"""
Proxy Chain Relay v2: Local SOCKS5 -> US V2Ray -> LokiProxy Residential
Thread-based bidirectional relay for reliability.
"""
import asyncio
import socket
import struct
import sys
import time
import threading
import logging

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
log = logging.getLogger('chain-relay')

LISTEN_HOST = ''
LISTEN_PORT = 8090
US_PROXY_HOST = ''
US_PROXY_PORT = 10808
LOKIPROXY_USER = 'hellowen1'
LOKIPROXY_PASS = 'zdd1234'
LOKIPROXY_HOST = '198.44.171.80'
LOKIPROXY_PORT = 10000

total_connections = 0
active_connections = 0


def chain_connect(target_host, target_port, timeout=20):
    """
    Create a socket chained through US proxy -> LokiProxy -> target.
    Returns the connected socket on success, None on failure.
    """
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(timeout)
    
    l_host = LOKIPROXY_HOST
    l_port = LOKIPROXY_PORT
    
    try:
        # Step 1: Connect to US proxy
        s.connect((US_PROXY_HOST, US_PROXY_PORT))
        
        # Step 2: SOCKS5 handshake with US proxy (no auth)
        s.sendall(b'\x05\x01\x00')
        resp = _recv_exact(s, 2)
        if resp != b'\x05\x00':
            log.error(f"US proxy handshake failed: {resp.hex() if resp else 'empty'}")
            s.close()
            return None
        
        # Step 3: CONNECT to LokiProxy through US proxy
        loki_addr = l_host.encode()
        req = b'\x05\x01\x00\x03' + bytes([len(loki_addr)]) + loki_addr + l_port.to_bytes(2, 'big')
        s.sendall(req)
        resp = _recv_exact(s, 10)
        if not resp or resp[1] != 0:
            log.error(f"US proxy -> LokiProxy CONNECT failed: {resp.hex() if resp else 'empty'}")
            s.close()
            return None
        
        # Step 4: SOCKS5 handshake with LokiProxy
        s.sendall(b'\x05\x02\x00\x02')
        resp = _recv_exact(s, 2)
        if resp != b'\x05\x02':
            log.error(f"LokiProxy handshake failed: {resp.hex() if resp else 'empty'}")
            s.close()
            return None
        
        # Step 5: Auth with LokiProxy
        user_bytes = LOKIPROXY_USER.encode()
        pass_bytes = LOKIPROXY_PASS.encode()
        auth = b'\x01' + bytes([len(user_bytes)]) + user_bytes + bytes([len(pass_bytes)]) + pass_bytes
        s.sendall(auth)
        resp = _recv_exact(s, 2)
        if resp != b'\x01\x00':
            log.error(f"LokiProxy auth failed: {resp.hex() if resp else 'empty'}")
            s.close()
            return None
        
        # Step 6: CONNECT to target through LokiProxy
        target_addr = target_host.encode()
        req = b'\x05\x01\x00\x03' + bytes([len(target_addr)]) + target_addr + target_port.to_bytes(2, 'big')
        s.sendall(req)
        resp = _recv_exact(s, 10)
        if not resp or resp[1] != 0:
            log.error(f"LokiProxy -> {target_host}:{target_port} CONNECT failed: {resp.hex() if resp else 'empty'}")
            s.close()
            return None
        
        log.info(f"Chain established: -> US -> LokiProxy -> {target_host}:{target_port}")
        return s
        
    except Exception as e:
        log.error(f"Chain connect error: {e}")
        try:
            s.close()
        except:
            pass
        return None


def _recv_exact(sock, n):
    """Receive exactly n bytes from socket."""
    data = b''
    while len(data) < n:
        try:
            chunk = sock.recv(n - len(data))
            if not chunk:
                return None
            data += chunk
        except socket.timeout:
            return None
    return data


def relay_thread(src_sock, dst_sock, direction_name, stop_event):
    """Thread : relay data from src to dst."""
    try:
        src_sock.settimeout(0.5)
        bytes_transferred = 0
        while not stop_event.is_set():
            try:
                data = src_sock.recv(65536)
                if not data:
                    break
                dst_sock.sendall(data)
                bytes_transferred += len(data)
            except socket.timeout:
                continue
            except Exception:
                break
        log.debug(f"Relay {direction_name}: {bytes_transferred} bytes transferred")
    except Exception as e:
        log.debug(f"Relay {direction_name} error: {e}")
    finally:
        stop_event.set()


def do_relay(client_sock, remote_sock, timeout=300):
    """Bidirectional relay between client and remote socket using threads."""
    stop_event = threading.Event()
    
    t1 = threading.Thread(target=relay_thread, args=(client_sock, remote_sock, 'C->R', stop_event), daemon=True)
    t2 = threading.Thread(target=relay_thread, args=(remote_sock, client_sock, 'R->C', stop_event), daemon=True)
    
    t1.start()
    t2.start()
    
    # Wait with timeout
    t1.join(timeout=timeout)
    t2.join(timeout=timeout)
    
    stop_event.set()


def handle_client_sync(client_sock, client_addr):
    """Synchronous handler for one client connection."""
    global total_connections, active_connections
    total_connections += 1
    active_connections += 1
    conn_id = total_connections
    
    log.info(f"[#{conn_id}] Client connected: {client_addr}")
    remote_sock = None
    
    try:
        client_sock.settimeout(15)
        
        # Step 1: SOCKS5 handshake
        data = _recv_exact(client_sock, 2)
        if not data or data[0] != 5:
            log.warning(f"[#{conn_id}] Invalid SOCKS5 version")
            return
        
        nmethods = data[1]
        methods = _recv_exact(client_sock, nmethods)
        if methods is None:
            return
        
        # Accept no-auth
        client_sock.sendall(b'\x05\x00')
        
        # Step 2: Read CONNECT request
        data = _recv_exact(client_sock, 4)
        if not data:
            return
        
        ver, cmd, rsv, atyp = data[0], data[1], data[2], data[3]
        if ver != 5 or cmd != 1:
            client_sock.sendall(b'\x05\x07\x00\x01\x00\x00\x00\x00\x00\x00')  # Command not supported
            return
        
        # Read target address
        target_host = None
        if atyp == 1:  # IPv4
            addr_data = _recv_exact(client_sock, 4)
            if addr_data:
                target_host = '.'.join(str(b) for b in addr_data)
        elif atyp == 3:  # Domain
            len_data = _recv_exact(client_sock, 1)
            if len_data:
                addr_data = _recv_exact(client_sock, len_data[0])
                if addr_data:
                    target_host = addr_data.decode()
        elif atyp == 4:  # IPv6
            addr_data = _recv_exact(client_sock, 16)
            if addr_data:
                target_host = socket.inet_ntop(socket.AF_INET6, addr_data)
        
        if not target_host:
            client_sock.sendall(b'\x05\x08\x00\x01\x00\x00\x00\x00\x00\x00')  # Address type not supported
            return
        
        port_data = _recv_exact(client_sock, 2)
        if not port_data:
            return
        target_port = struct.unpack('>H', port_data)[0]
        
        log.info(f"[#{conn_id}] CONNECT: {target_host}:{target_port}")
        
        # Step 3: Create chain connection
        remote_sock = chain_connect(target_host, target_port, timeout=25)
        
        if remote_sock is None:
            log.error(f"[#{conn_id}] Chain connection failed")
            client_sock.sendall(b'\x05\x01\x00\x01\x00\x00\x00\x00\x00\x00')  # General failure
            return
        
        # Step 4: Send success
        client_sock.sendall(b'\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00')
        
        # Step 5: Bidirectional relay
        log.info(f"[#{conn_id}] Relay started: C->R->remote")
        do_relay(client_sock, remote_sock, timeout=300)
        log.info(f"[#{conn_id}] Relay finished")
        
    except Exception as e:
        log.error(f"[#{conn_id}] Error: {e}")
    finally:
        try:
            client_sock.close()
        except:
            pass
        if remote_sock:
            try:
                remote_sock.close()
            except:
                pass
        active_connections -= 1


class ProxyRelayServer:
    """SOCKS5 proxy relay server."""
    
    def __init__(self):
        self.server_sock = None
        self.running = False
    
    def start(self):
        self.server_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.server_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.server_sock.bind((LISTEN_HOST, LISTEN_PORT))
        self.server_sock.listen(50)
        self.server_sock.settimeout(1.0)
        
        log.info("=" * 60)
        log.info(f"Proxy Chain Relay v2 on {LISTEN_HOST}:{LISTEN_PORT}")
        log.info(f"Chain: local -> US V2Ray -> LokiProxy ({LOKIPROXY_HOST}:{LOKIPROXY_PORT}) -> Target")
        log.info(f"Connections: {total_connections} total, {active_connections} active")
        log.info("=" * 60)
        
        self.running = True
        
        # Accept loop
        while self.running:
            try:
                client_sock, client_addr = self.server_sock.accept()
                t = threading.Thread(target=handle_client_sync, args=(client_sock, client_addr), daemon=True)
                t.start()
            except socket.timeout:
                continue
            except Exception as e:
                if self.running:
                    log.error(f"Accept error: {e}")
        
        self.server_sock.close()
    
    def stop(self):
        self.running = False
        if self.server_sock:
            try:
                self.server_sock.close()
            except:
                pass


def main():
    server = ProxyRelayServer()
    try:
        server.start()
    except KeyboardInterrupt:
        log.info("Shutting down...")
        server.stop()


if __name__ == '__main__':
    main()
