import http.client
import socket

connection = http.client.HTTPConnection('cad', timeout=3)
connection.sock = socket.socket(socket.AF_UNIX)
connection.sock.settimeout(3)
connection.sock.connect('/run/cad/engine.sock')
connection.request('GET', '/healthz')
response = connection.getresponse()
if response.status != 200:
    raise SystemExit(1)
response.read(16384)
connection.close()
