"""Development-only loopback relay across Docker Desktop's Unix socket boundary."""
import select
import socket
import socketserver
import threading
import time

SLOTS = threading.BoundedSemaphore(8)
LIMIT = 513 * 1024 * 1024


class Relay(socketserver.BaseRequestHandler):
    def handle(self):
        if not SLOTS.acquire(blocking=False):
            return
        try:
            with socket.socket(socket.AF_UNIX) as upstream:
                upstream.settimeout(5)
                upstream.connect('/run/cad/engine.sock')
                self.request.settimeout(5)
                deadline, counts = time.monotonic() + 90, {self.request: 0, upstream: 0}
                while time.monotonic() < deadline:
                    readable, _, _ = select.select([self.request, upstream], [], [], 1)
                    for source in readable:
                        data = source.recv(64 * 1024)
                        if not data:
                            return
                        counts[source] += len(data)
                        if counts[source] > LIMIT:
                            return
                        (upstream if source is self.request else self.request).sendall(data)
        except OSError:
            pass
        finally:
            SLOTS.release()


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == '__main__':
    with Server(('0.0.0.0', 9910), Relay) as server:
        server.serve_forever()
