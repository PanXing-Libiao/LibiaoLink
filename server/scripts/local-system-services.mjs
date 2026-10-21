import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { join } from "node:path";

// Official native services, bound to loopback, using the bootstrap's private configuration.
export async function startLocalServices(config, directory) {
  const children = [];
  const start = async (name, executable, args, cwd, env) => {
    const output = await open(join(directory, `${name}.log`), "a", 0o600);
    const child = spawn(executable, args, { cwd, env, stdio: ["ignore", output.fd, output.fd] });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    children.push(child);
    await output.close();
    return child;
  };
  const stop = () => { for (const child of children) if (child.exitCode === null) child.kill("SIGTERM"); };
  try {
    const storage = await start("minio", join(directory, "../minio"), ["server", join(directory, "objects"), "--address", "127.0.0.1:9000", "--console-address", "127.0.0.1:9001"], directory, {
      ...process.env,
      MINIO_ROOT_USER: config.api.S3_ACCESS_KEY, MINIO_ROOT_PASSWORD: config.api.S3_SECRET_KEY,
      MINIO_API_CORS_ALLOW_ORIGIN: "http://localhost:3000,http://127.0.0.1:3000",
    });
    const identity = await start("casdoor", join(directory, "casdoor/casdoor"), [], join(directory, "casdoor"), process.env);
    for (const [child, url, name] of [[storage, "http://127.0.0.1:9000/minio/health/live", "MinIO"], [identity, "http://127.0.0.1:8000/.well-known/openid-configuration", "Casdoor"]]) {
      let ready = false;
      for (let attempt = 0; attempt < 90; attempt += 1) {
        if (child.exitCode !== null) throw new Error(`${name} exited; inspect its local service log`);
        try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch { /* Startup may take a few seconds. */ }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      if (!ready) throw new Error(`${name} did not become ready`);
    }
    console.log("Local Casdoor and MinIO ready on loopback.");
    return stop;
  } catch (error) { stop(); throw error; }
}
