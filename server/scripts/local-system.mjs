// Runs the actual application on loopback; no fixture controllers or authentication overrides.
import "./local-source-loader.mjs";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { startLocalServices } from "./local-system-services.mjs";
import { S3Client, HeadBucketCommand, CreateBucketCommand, PutBucketVersioningCommand } from "@aws-sdk/client-s3";

// Private bootstrap output is never served by Vite or committed.
let stopServices = () => {};
let privateConfig;
if (process.env.LOCAL_SYSTEM_CONFIG) {
  privateConfig = JSON.parse(await readFile(process.env.LOCAL_SYSTEM_CONFIG, "utf8"));
  Object.assign(process.env, privateConfig.api);
}
const { AppModule } = await import("../src/app.module.ts");
const { loadEnv } = await import("../src/config/env.ts");
const env = loadEnv();
if (env.NODE_ENV === "production") throw new Error("local-system is development only");
const database = new URL(env.DATABASE_URL);
if (!["localhost", "127.0.0.1", "[::1]"].includes(database.hostname)) throw new Error("Use a local database for local-system");
if (!database.pathname.startsWith("/libiaolink_local")) throw new Error("Use a dedicated libiaolink_local database");
const storage = new URL(env.S3_ENDPOINT);
if (!["localhost", "127.0.0.1", "[::1]"].includes(storage.hostname)) throw new Error("Use local object storage for local-system");
if (env.CASDOOR_CLIENT_ID === "" || env.CASDOOR_CLIENT_SECRET === "") throw new Error("Configure local OIDC before starting local-system");
const issuer = new URL(env.CASDOOR_ISSUER);
if (!["localhost", "127.0.0.1", "[::1]"].includes(issuer.hostname)) throw new Error("Use local OIDC for local-system");
if (privateConfig) stopServices = await startLocalServices(privateConfig, dirname(process.env.LOCAL_SYSTEM_CONFIG));
process.once("exit", () => stopServices());

const s3 = new S3Client({ endpoint: env.S3_ENDPOINT, region: env.S3_REGION, forcePathStyle: true, credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY } });
try {
  try { await s3.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET })); }
  catch (error) { if (error?.$metadata?.httpStatusCode !== 404) throw error; await s3.send(new CreateBucketCommand({ Bucket: env.S3_BUCKET })); }
  await s3.send(new PutBucketVersioningCommand({ Bucket: env.S3_BUCKET, VersioningConfiguration: { Status: "Enabled" } }));
} finally { s3.destroy(); }

const app = await NestFactory.create(AppModule.forRoot(env), { bufferLogs: true });
app.useBodyParser("json", { limit: "4mb" });
app.useLogger(app.get(Logger));
await app.listen(env.PORT, "127.0.0.1");
const cadWorker = spawn(process.execPath, [fileURLToPath(new URL("./local-cad-worker.mjs", import.meta.url))],
  { env: process.env, stdio: ["ignore", "inherit", "inherit"] });

const frontRequire = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { createServer } = await import(frontRequire.resolve("vite"));
const react = (await import(frontRequire.resolve("@vitejs/plugin-react"))).default;
const tailwind = (await import(frontRequire.resolve("@tailwindcss/vite"))).default;
const vite = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("../../frontend", import.meta.url)),
  plugins: [react(), tailwind()],
  cacheDir: fileURLToPath(new URL("../cad-engine/.runtime/local-system/vite-cache", import.meta.url)),
  optimizeDeps: { entries: ["index.html"], include: ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"] },
  server: {
    host: "127.0.0.1", port: 3000, strictPort: true,
    proxy: Object.fromEntries(["/api/v1", "/auth", "/healthz", "/readyz"].map((path) => [path, { target: `http://127.0.0.1:${env.PORT}`, changeOrigin: true }])),
  },
});
await vite.listen();
console.log("Local LibiaoLink ready: http://localhost:3000 — actual API, independent database and object storage.");
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  cadWorker.kill("SIGTERM");
  await new Promise((resolve) => {
    if (cadWorker.exitCode !== null) { resolve(); return; }
    const timer = setTimeout(() => { cadWorker.kill("SIGKILL"); resolve(); }, 5000);
    cadWorker.once("exit", () => { clearTimeout(timer); resolve(); });
  });
  await vite.close();
  await app.close();
  stopServices();
};
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
