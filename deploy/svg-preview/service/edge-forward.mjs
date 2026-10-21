import { connect, createServer } from "node:net";

const LISTEN_HOST = process.env.EDGE_LISTEN_HOST ?? "0.0.0.0";
const LISTEN_PORT = integer("EDGE_LISTEN_PORT", 9900);
const UPSTREAM_HOST = process.env.EDGE_UPSTREAM_HOST ?? "converter";
const UPSTREAM_PORT = integer("EDGE_UPSTREAM_PORT", 9900);
let accepted = 0;
let active = 0;

function integer(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

const server = createServer((client) => {
  accepted += 1;
  active += 1;
  const upstream = connect(UPSTREAM_PORT, UPSTREAM_HOST);
  const teardown = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on("error", teardown);
  upstream.on("error", teardown);
  client.pipe(upstream);
  upstream.pipe(client);
  client.on("close", () => {
    upstream.destroy();
    active = Math.max(0, active - 1);
  });
  upstream.on("close", () => client.destroy());
  client.setNoDelay(true);
  upstream.setNoDelay(true);
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  process.stdout.write(JSON.stringify({ at: new Date().toISOString(), event: "listening", listen: `${LISTEN_HOST}:${LISTEN_PORT}`, upstream: `${UPSTREAM_HOST}:${UPSTREAM_PORT}` }) + "\n");
});

setInterval(() => {
  if (active > 0) process.stdout.write(JSON.stringify({ at: new Date().toISOString(), event: "stats", accepted, active }) + "\n");
}, 60_000).unref();

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3_000).unref();
  });
}