import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/config/env.js";

const PRODUCTION_BASE = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://test/test",
  CASDOOR_CLIENT_ID: "client",
  CASDOOR_CLIENT_SECRET: "secret",
  CASDOOR_ORG_NAME: "org",
  INTERNAL_SYNC_TOKEN: "token",
  S3_ACCESS_KEY: "key",
  S3_SECRET_KEY: "secret",
  ONLYOFFICE_JWT_SECRET: "shared-secret",
  GROUP_ACCESS_ENFORCED: "true",
  GROUP_ACCESS_ADMIN_USER_IDS: "11111111-1111-4111-8111-111111111111",
} as const;

describe("生产环境部门权限开关", () => {
  it("生产缺省或 false 均拒绝启动，避免部门规则静默失效", () => {
    const withoutSwitch: Record<string, string | undefined> = { ...PRODUCTION_BASE };
    delete withoutSwitch.GROUP_ACCESS_ENFORCED;
    expect(() => loadEnv(withoutSwitch)).toThrow(/GROUP_ACCESS_ENFORCED/);
    expect(() => loadEnv({ ...PRODUCTION_BASE, GROUP_ACCESS_ENFORCED: "false" })).toThrow(/GROUP_ACCESS_ENFORCED/);
  });

  it("生产开启且配置管理员时通过；非生产仍可使用本地默认 false", () => {
    expect(loadEnv({ ...PRODUCTION_BASE }).GROUP_ACCESS_ENFORCED).toBe("true");
    expect(loadEnv({ DATABASE_URL: "postgres://test/test" }).GROUP_ACCESS_ENFORCED).toBe("false");
  });
});
