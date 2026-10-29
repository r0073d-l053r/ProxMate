# TCP relay: lets containers reach the sandbox egress proxy (which only listens on 127.0.0.1).
# usage: python3 -I relay.py <listen port> <proxy port> [bind address, default 172.17.0.1 (docker0)]
#   bring-up.sh runs it as relay.py 3128 <port of $HTTPS_PROXY>; Docker's config.json points builds at 172.17.0.1:3128.
import socket, sys, threading
lport, rport = int(sys.argv[1]), int(sys.argv[2])
bind = sys.argv[3] if len(sys.argv) > 3 else '172.17.0.1'
def pipe(a, b):
    try:
        while True:
            d = a.recv(65536)
            if not d: break
            b.sendall(d)
    except Exception: pass
    finally:
        for s in (a, b):
            try: s.shutdown(socket.SHUT_RDWR)
            except Exception: pass
srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); srv.bind((bind, lport)); srv.listen(128)
while True:
    c, _ = srv.accept(); u = socket.create_connection(('127.0.0.1', rport))
    threading.Thread(target=pipe, args=(c, u), daemon=True).start(); threading.Thread(target=pipe, args=(u, c), daemon=True).start()
