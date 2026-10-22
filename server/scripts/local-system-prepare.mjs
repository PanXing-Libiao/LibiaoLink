// Creates only dedicated local resources. No remote database, SSO or business data is read.
import "./local-source-loader.mjs";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const directory = resolve("cad-engine/.runtime/local-system");
const configPath = join(directory, "private.json");
const cadSocket = process.env.CAD_ENGINE_SOCKET || "", cadUrl = process.env.CAD_ENGINE_URL || "";
if (!cadSocket && !cadUrl) throw new Error("Start the CAD sandbox and set CAD_ENGINE_SOCKET or CAD_ENGINE_URL");
await mkdir(directory, { recursive: true, mode: 0o700 });
let config;
if (existsSync(configPath)) config = JSON.parse(await readFile(configPath, "utf8"));
else {
  const secret = () => randomBytes(24).toString("hex");
  const postgres = secret(), api = secret(), s3User = "local" + randomBytes(8).toString("hex"), s3Password = secret();
  config = {
    postgres, migrator: secret(),
    localUser: { name: "localviewer", password: secret(), id: randomUUID() },
    api: {
      NODE_ENV: "development", PORT: "3001", LOG_LEVEL: "warn",
      DATABASE_URL: `postgres://libiaolink_api:${api}@127.0.0.1:5433/libiaolink_local`,
      CASDOOR_ISSUER: "http://localhost:8000", CASDOOR_ORG_NAME: "libiaolink-local",
      CASDOOR_CLIENT_ID: "libiaolink-local-cad", CASDOOR_CLIENT_SECRET: secret(),
      CASDOOR_REDIRECT_URI: "http://localhost:3000/auth/callback",
      SESSION_COOKIE_SECURE: "false",
      S3_ENDPOINT: "http://127.0.0.1:9000", S3_REGION: "us-east-1", S3_BUCKET: "libiaolink-local",
      S3_ACCESS_KEY: s3User, S3_SECRET_KEY: s3Password,
      CAD_ENGINE_SOCKET: cadSocket, CAD_ENGINE_URL: cadUrl, CAD_MAX_INPUT_MIB: "64",
    },
  };
  await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600, flag: "wx" });
}
// Migrate only the dedicated local runner configuration; never retain the stdio fallback.
delete config.api.CAD_ENGINE_PYTHON;
delete config.api.CAD_MESHER_PYTHON;
delete config.api.CAD_CACHE_DIR;
config.api.CAD_ENGINE_SOCKET = cadSocket;
config.api.CAD_ENGINE_URL = cadUrl;
await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
if (!config.migrator) {
  config.migrator = randomBytes(24).toString("hex");
  await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
}
if (![config.postgres, config.migrator, new URL(config.api.DATABASE_URL).password].every(value => /^[a-f0-9]{48}$/.test(value))) throw new Error("Local bootstrap credentials must be generated hexadecimal values");

const docker = (...args) => {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error("Docker operation failed; check the dedicated local container");
  return result.stdout.trim();
};
const container = "libiaolink-local-pg";
const present = docker("ps", "-a", "--filter", `name=^/${container}$`, "--format", "{{.Names}}");
if (!present) {
  if (!process.env.LOCAL_PG_IMAGE) throw new Error("Set LOCAL_PG_IMAGE to a verified PostgreSQL 18 image");
  const postgresFile = join(directory, "postgres.env");
  await writeFile(postgresFile, `POSTGRES_PASSWORD=${config.postgres}\nPOSTGRES_DB=libiaolink_local\n`, { mode: 0o600 });
  docker("run", "-d", "--name", container, "--env-file", postgresFile, "-p", "127.0.0.1:5433:5432", "--mount", "type=volume,source=libiaolink-local-pg,target=/var/lib/postgresql", process.env.LOCAL_PG_IMAGE);
} else docker("start", container);

const adminUrl = `postgres://postgres:${config.postgres}@127.0.0.1:5433/libiaolink_local`;
let admin;
for (let attempt = 0; attempt < 30; attempt += 1) {
  const candidate = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 1000 });
  try { await candidate.connect(); admin = candidate; break; } catch { await candidate.end().catch(() => {}); await new Promise(resolve => setTimeout(resolve, 500)); }
}
if (!admin) throw new Error("Local PostgreSQL did not become ready");
try {
  const version = await admin.query("show server_version_num");
  if (Number(version.rows[0].server_version_num) < 180000) throw new Error("PostgreSQL 18 is required");
  await admin.query(await readFile(new URL("../../database/roles/0001_roles.sql", import.meta.url), "utf8"));
  // Generated password contains only hexadecimal characters; it never enters logs or argv.
  await admin.query(`alter role libiaolink_api password '${new URL(config.api.DATABASE_URL).password}'`);
  await admin.query(`alter role libiaolink_migrator password '${config.migrator}'`);
  const authDb = await admin.query("select 1 from pg_database where datname='casdoor_local'");
  if (!authDb.rowCount) await admin.query("create database casdoor_local");
} finally { await admin.end(); }

const migratorUrl = `postgres://libiaolink_migrator:${config.migrator}@127.0.0.1:5433/libiaolink_local`;
const migration = spawnSync(process.execPath, ["--import", fileURLToPath(new URL("./local-source-loader.mjs", import.meta.url)), fileURLToPath(new URL("../../database/scripts/migrate.mjs", import.meta.url))], { encoding: "utf8", env: { ...process.env, DATABASE_URL: migratorUrl } });
if (migration.status !== 0) throw new Error("Local database migration failed: " + migration.stderr);
console.log(migration.stdout.trim().split("\n").at(-1));
const { Client } = pg;
const seedClient = new Client({ connectionString: migratorUrl });
await seedClient.connect();
try {
  for (const name of ["dicts", "roles", "role-permissions", "blueprint", "task-nodes", "task-templates", "automation-rules"]) {
    const seed = await import(`../../database/seeds/${name}.mjs`);
    await seedClient.query("begin");
    try { await seed.run(seedClient); await seedClient.query("commit"); } catch (error) { await seedClient.query("rollback"); throw error; }
  }
} finally { await seedClient.end(); }
const grants = new Client({ connectionString: adminUrl });
await grants.connect();
try { await grants.query(await readFile(new URL("../../database/roles/0001_roles.sql", import.meta.url), "utf8")); }
finally { await grants.end(); }

const origin = "http://localhost:8000";
await mkdir(join(directory, "casdoor/conf"), { recursive: true });
await writeFile(join(directory, "casdoor/conf/app.conf"), [
  "appname = casdoor", "httpaddr = 127.0.0.1", "httpport = 8000", "runmode = prod", "copyrequestbody = true",
  "driverName = postgres", `dataSourceName = user=postgres password=${config.postgres} host=127.0.0.1 port=5433 sslmode=disable dbname=casdoor_local`,
  "dbName = casdoor_local", "showSql = false", `origin = ${origin}`, `originFrontend = ${origin}`,
  "defaultLanguage = zh", "defaultApplication = libiaolink-local", "logPostOnly = true", "enableGzip = true", "frontendBaseDir = web/build", "initDataNewOnly = true", "initDataFile = ./init_data.json",
].join("\n") + "\n", { mode: 0o600 });
const organization = "libiaolink-local";
await writeFile(join(directory, "casdoor/init_data.json"), JSON.stringify({
  organizations: [{ owner: "admin", name: organization, displayName: "LibiaoLink 本地测试", passwordType: "bcrypt", passwordOptions: ["AtLeast6"], defaultApplication: "libiaolink-local", defaultTokenFormat: "JWT-Custom", defaultTokenFields: ["Name", "Owner", "Id", "DisplayName", "Email"], languages: ["zh", "en"], countryCodes: ["CN"] }],
  applications: [{ owner: "admin", name: "libiaolink-local", displayName: "LibiaoLink 本地测试", organization, cert: "cert-built-in", clientId: config.api.CASDOOR_CLIENT_ID, clientSecret: config.api.CASDOOR_CLIENT_SECRET, homepageUrl: "http://localhost:3000", redirectUris: [config.api.CASDOOR_REDIRECT_URI], grantTypes: ["authorization_code"], tokenFormat: "JWT-Custom", tokenFields: ["Name", "Owner", "Id", "DisplayName", "Email"], enablePassword: true, enableSignUp: false, signinMethods: [{ name: "Password", displayName: "密码", rule: "All" }], expireInHours: 12 }],
  users: [{ owner: organization, name: config.localUser.name, id: config.localUser.id, displayName: "本地测试", type: "normal-user", password: config.localUser.password, isAdmin: false, signupApplication: "libiaolink-local" }],
}), { mode: 0o600 });
console.log("Independent local database and OIDC configuration prepared; private settings remain in the ignored runtime directory.");
