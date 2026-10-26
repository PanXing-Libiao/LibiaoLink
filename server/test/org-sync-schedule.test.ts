import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/config/env.js";

describe("组织目录自动同步配置", () => {
  it("默认每 5 分钟同步一轮", () => {
    expect(loadEnv({ DATABASE_URL: "postgres://test/test" }).ORG_SYNC_INTERVAL_MS).toBe(300_000);
  });

  it("同步周期不得低于 60 秒，避免持续轰炸 Casdoor", () => {
    expect(() => loadEnv({ DATABASE_URL: "postgres://test/test", ORG_SYNC_INTERVAL_MS: "59999" })).toThrow(
      /ORG_SYNC_INTERVAL_MS/,
    );
    expect(loadEnv({ DATABASE_URL: "postgres://test/test", ORG_SYNC_INTERVAL_MS: "60000" }).ORG_SYNC_INTERVAL_MS).toBe(
      60_000,
    );
  });
});
