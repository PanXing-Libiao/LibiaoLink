// Dedicated local background process; never performs native CAD parsing outside the sandbox.
import "./local-source-loader.mjs";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";

// Install source hooks before loading decorated TypeScript modules.
const { WorkerModule } = await import("../src/worker.module.ts");
const { loadEnv } = await import("../src/config/env.ts");
const { CadArchiveWorker } = await import("../src/modules/file/index.ts");

const env = loadEnv();
if (env.NODE_ENV === "production") throw new Error("local-cad-worker is development only");
const database = new URL(env.DATABASE_URL), storage = new URL(env.S3_ENDPOINT);
if (!["127.0.0.1", "localhost", "[::1]"].includes(database.hostname)
  || !/^\/libiaolink_(local|cad_test)/.test(database.pathname)
  || !["127.0.0.1", "localhost", "[::1]"].includes(storage.hostname)) {
  throw new Error("Dedicated local database and object storage required");
}
const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(env), { logger: false });
const cad = app.get(CadArchiveWorker);
const drain = () => { void cad.drainOnce().catch(() => console.error("Local CAD queue unavailable; retrying next poll.")); };
const timer = setInterval(drain, 2000);
drain();
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  await cad.onApplicationShutdown();
  await app.close();
};
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
