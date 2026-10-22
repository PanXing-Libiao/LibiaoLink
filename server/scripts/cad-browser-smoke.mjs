// Local source runner; no full build and no production authentication changes.
import { createServer } from "vite";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const endpoint = process.env.CAD_ENGINE_SOCKET || process.env.CAD_ENGINE_URL;
if (!process.env.CAD_SMOKE_INVENTORY || !endpoint) throw new Error("Set CAD_SMOKE_INVENTORY and CAD_ENGINE_SOCKET or CAD_ENGINE_URL for the isolated sandbox");
const paths = JSON.parse(await readFile(process.env.CAD_SMOKE_INVENTORY, "utf8"));
const frontRequire = createRequire(new URL("../../frontend/package.json", import.meta.url));
const react = (await import(frontRequire.resolve("@vitejs/plugin-react"))).default;
const tailwind = (await import(frontRequire.resolve("@tailwindcss/vite"))).default;
const vite = await createServer({ configFile: false, cacheDir: resolve("var/cad-browser-smoke/vite-cache"), root: fileURLToPath(new URL("../../frontend", import.meta.url)), plugins: [react(), tailwind()], server: { middlewareMode: true },
  optimizeDeps: { entries: ["tools/cad-platform.html"] },
  resolve: { alias: { "@libiaolink/contracts": fileURLToPath(new URL("../../shared/src/index.ts", import.meta.url)) } } });
const { createCadFixture } = await vite.ssrLoadModule(fileURLToPath(new URL("../test/cad-http.fixture.ts", import.meta.url)));
const middleware = (req, res, next) => req.url.startsWith("/api/") || req.url.startsWith("/__cad-smoke") ? next() : vite.middlewares(req, res, next);
const fixture = await createCadFixture(paths, resolve("var/cad-browser-smoke"), endpoint, true, middleware);
await fixture.app.listen(3013, "127.0.0.1");
console.log("Local CAD integration fixture ready on 127.0.0.1:3013; test identity/storage, real conversion and viewer.");
const stop = async () => { await fixture.close(); await vite.close(); process.exit(0); };
process.once("SIGTERM", stop); process.once("SIGINT", stop);
