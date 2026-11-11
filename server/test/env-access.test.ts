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
  it("站外深链默认生产域名，本地无需配置", () => {
    expect(loadEnv({ DATABASE_URL: "postgres://test/test" }).PUBLIC_APP_BASE_URL).toBe("https://pm.libiaorobot.com");
    expect(loadEnv({ DATABASE_URL: "postgres://test/test" }).PROJECT_EXPORT_MODE).toBe("auto");
    expect(() => loadEnv({ DATABASE_URL: "postgres://test/test", PROJECT_EXPORT_MODE: "invalid" })).toThrow(/PROJECT_EXPORT_MODE/);
  });

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

describe("企微机器人日报查询开关", () => {
  it("缺省均为关闭，不改变现有单聊与群聊回调", () => {
    const env = loadEnv({ DATABASE_URL: "postgres://test/test" });
    expect(env.WECOM_REPORT_QUERY_DM_ENABLED).toBe("false");
    expect(env.WECOM_REPORT_QUERY_GROUP_ENABLED).toBe("false");
  });

  it("单聊与群聊开关可独立指定 true / false", () => {
    const env = loadEnv({
      DATABASE_URL: "postgres://test/test",
      WECOM_REPORT_QUERY_DM_ENABLED: "true",
      WECOM_REPORT_QUERY_GROUP_ENABLED: "false",
    });
    expect(env.WECOM_REPORT_QUERY_DM_ENABLED).toBe("true");
    expect(env.WECOM_REPORT_QUERY_GROUP_ENABLED).toBe("false");
  });

  it("只接受字符串 true / false，拒绝 0 / 1 等模糊布尔值", () => {
    expect(() =>
      loadEnv({ DATABASE_URL: "postgres://test/test", WECOM_REPORT_QUERY_DM_ENABLED: "1" }),
    ).toThrow(/WECOM_REPORT_QUERY_DM_ENABLED/);
    expect(() =>
      loadEnv({ DATABASE_URL: "postgres://test/test", WECOM_REPORT_QUERY_GROUP_ENABLED: "0" }),
    ).toThrow(/WECOM_REPORT_QUERY_GROUP_ENABLED/);
  });
});
