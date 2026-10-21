import { APP_FILTER } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { createServer, type Server } from "node:http";
import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import request, { type Response as SupertestResponse } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiErrorFilter } from "../src/common/errors/api-error.filter.js";
import { AppConfigModule } from "../src/config/config.module.js";
import { loadEnv } from "../src/config/env.js";
import { IdentityModule } from "../src/modules/identity/index.js";
import { DepartmentRepository } from "../src/modules/identity/department.repository.js";
import { DepartmentService } from "../src/modules/identity/department.service.js";
import { OrgSyncService } from "../src/modules/identity/org-sync.service.js";
import { RoleRepository } from "../src/modules/identity/role.repository.js";
import { RoleService } from "../src/modules/identity/role.service.js";
import { SessionRepository, type SessionRow, type SessionWithUser } from "../src/modules/identity/session.repository.js";
import { UserRepository, type SsoProfile, type UserRow } from "../src/modules/identity/user.repository.js";
import { UserPreferenceRepository } from "../src/modules/identity/user-preference.repository.js";
import { InternalUserService } from "../src/modules/identity/index.js";
import { AuditRepository } from "../src/modules/audit/audit.repository.js";
import { AuditService } from "../src/modules/audit/audit.service.js";
import { CsrfGuard } from "../src/modules/identity/csrf.guard.js";
import type { ExecutionContext } from "@nestjs/common";

// ---------- 桩 IdP（本地 OIDC：discovery / JWKS / 换令牌） ----------

const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = { ...keyPair.publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };
const CLIENT_ID = "test-client";
const CLIENT_SECRET = "test-secret";
const REDIRECT_URI = "http://127.0.0.1:3999/auth/callback";

function signIdToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signed = encode({ alg: "RS256", kid: "test-key", typ: "JWT" }) + "." + encode(claims);
  const signature = createSign("RSA-SHA256").update(signed).sign(keyPair.privateKey).toString("base64url");
  return signed + "." + signature;
}

interface StubIdp {
  issuer: string;
  codes: Map<string, Record<string, unknown>>;
  lastTokenQuery: Record<string, string> | null;
  createCode(claims: Record<string, unknown>): string;
  close(): Promise<void>;
}

async function startStubIdp(): Promise<StubIdp> {
  const codes = new Map<string, Record<string, unknown>>();
  const state: { lastTokenQuery: Record<string, string> | null } = { lastTokenQuery: null };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/.well-known/openid-configuration") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ issuer: "http://127.0.0.1", jwks_uri: "http://127.0.0.1:" + String(port) + "/.well-known/jwks" }));
      return;
    }
    if (url.pathname === "/.well-known/jwks") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ keys: [publicJwk] }));
      return;
    }
    if (url.pathname === "/api/login/oauth/access_token") {
      state.lastTokenQuery = Object.fromEntries(url.searchParams.entries());
      const code = url.searchParams.get("code") ?? "";
      const claims = codes.get(code);
      if (claims === undefined) {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      const now = Math.floor(Date.now() / 1000);
      const idToken = signIdToken({ iss: issuer, aud: CLIENT_ID, iat: now, exp: now + 3600, ...claims });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ access_token: "stub-access", token_type: "Bearer", expires_in: 3600, id_token: idToken }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  let port = 0;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  const issuer = "http://127.0.0.1:" + String(port);
  return {
    issuer,
    codes,
    get lastTokenQuery() {
      return state.lastTokenQuery;
    },
    createCode(claims: Record<string, unknown>): string {
      const code = "code-" + randomUUID();
      codes.set(code, claims);
      return code;
    },
    close(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

let idp: StubIdp;

beforeAll(async () => {
  idp = await startStubIdp();
});

afterAll(async () => {
  await idp.close();
});

// ---------- 内存替身（DB-free；契约测试不依赖 PostgreSQL） ----------

class FakeUserRepository {
  private readonly byId = new Map<string, UserRow>();
  private readonly idByCasdoor = new Map<string, string>();

  async upsert(profile: SsoProfile): Promise<UserRow> {
    const existingId = this.idByCasdoor.get(profile.casdoorId);
    const existing = existingId === undefined ? undefined : this.byId.get(existingId);
    const id = existingId ?? randomUUID();
    const row: UserRow = {
      id,
      casdoorId: profile.casdoorId,
      username: profile.username,
      displayName: profile.displayName,
      email: profile.email,
      owner: profile.owner,
      status: existing?.status ?? "active",
      removedAt: existing?.removedAt ?? null,
      createdAt: existing?.createdAt ?? new Date(),
      updatedAt: new Date(),
    };
    this.byId.set(id, row);
    this.idByCasdoor.set(profile.casdoorId, id);
    return row;
  }

  async findById(id: string): Promise<UserRow | null> {
    return this.byId.get(id) ?? null;
  }

  setStatus(casdoorId: string, status: string): void {
    const id = this.idByCasdoor.get(casdoorId);
    if (id === undefined) {
      throw new Error("用户不存在：" + casdoorId);
    }
    const row = this.byId.get(id);
    if (row !== undefined) {
      row.status = status;
    }
  }
}

class FakeSessionRepository {
  private readonly byHash = new Map<string, SessionRow>();

  constructor(private readonly users: FakeUserRepository) {}

  async insert(input: { tokenHash: string; userId: string; idToken: string; expiresAt: Date }): Promise<SessionRow> {
    const row: SessionRow = {
      id: randomUUID(),
      tokenHash: input.tokenHash,
      userId: input.userId,
      idToken: input.idToken,
      createdAt: new Date(),
      lastSeenAt: new Date(),
      expiresAt: input.expiresAt,
      revokedAt: null,
    };
    this.byHash.set(input.tokenHash, row);
    return row;
  }

  async findWithUserByHash(tokenHash: string): Promise<SessionWithUser | null> {
    const row = this.byHash.get(tokenHash);
    if (row === undefined) {
      return null;
    }
    const user = await this.users.findById(row.userId);
    return user === null ? null : { session: row, user };
  }

  async touch(id: string, at: Date): Promise<void> {
    for (const row of this.byHash.values()) {
      if (row.id === id) {
        row.lastSeenAt = at;
      }
    }
  }

  async revokeById(id: string, at: Date): Promise<void> {
    for (const row of this.byHash.values()) {
      if (row.id === id && row.revokedAt === null) {
        row.revokedAt = at;
      }
    }
  }

  async revokeAllForUser(userId: string, at: Date): Promise<number> {
    let count = 0;
    for (const row of this.byHash.values()) {
      if (row.userId === userId && row.revokedAt === null) {
        row.revokedAt = at;
        count += 1;
      }
    }
    return count;
  }

  ageAll(milliseconds: number): void {
    for (const row of this.byHash.values()) {
      row.lastSeenAt = new Date(row.lastSeenAt.getTime() - milliseconds);
    }
  }

  all(): SessionRow[] {
    return [...this.byHash.values()];
  }
}

// ---------- 应用装配 ----------

interface TestContext {
  agent: ReturnType<typeof request>;
  fakeUsers: FakeUserRepository;
  fakeSessions: FakeSessionRepository;
  close(): Promise<void>;
}

async function createApp(idleMinutes: number): Promise<TestContext> {
  const env = loadEnv({
    NODE_ENV: "test",
    PORT: "3000",
    DATABASE_URL: "postgres://test@127.0.0.1:1/test",
    LOG_LEVEL: "silent",
    CASDOOR_ISSUER: idp.issuer,
    CASDOOR_CLIENT_ID: CLIENT_ID,
    CASDOOR_CLIENT_SECRET: CLIENT_SECRET,
    CASDOOR_REDIRECT_URI: REDIRECT_URI,
    SESSION_IDLE_MINUTES: String(idleMinutes),
  });
  const fakeUsers = new FakeUserRepository();
  const fakeSessions = new FakeSessionRepository(fakeUsers);
  const moduleRef = await Test.createTestingModule({
    imports: [AppConfigModule.forRoot(env), IdentityModule],
    providers: [{ provide: APP_FILTER, useClass: ApiErrorFilter }],
  })
    .overrideProvider(UserRepository)
    .useValue(fakeUsers)
    .overrideProvider(SessionRepository)
    .useValue(fakeSessions)
    // h1 新增的组织 / 角色 provider 与 /auth/* 无关：以空对象替身避免测试依赖真实数据库
    .overrideProvider(DepartmentRepository)
    .useValue({})
    .overrideProvider(DepartmentService)
    .useValue({})
    .overrideProvider(RoleRepository)
    .useValue({})
    .overrideProvider(RoleService)
    .useValue({})
    .overrideProvider(OrgSyncService)
    .useValue({})
    // A24 偏好仓储也在 IdentityModule 里（Push 169）：本用例只跑 /auth/*，给个空替身避免去连库
    .overrideProvider(UserPreferenceRepository)
    .useValue({ find: async (): Promise<null> => null, upsert: async (): Promise<never> => { throw new Error("auth e2e：偏好写入未接线"); } })
    // Push 173：审计出口迁入 identity 依赖图（离职回收 / 组织同步用）—— /auth/* 不写审计，给替身避免连库
    .overrideProvider(AuditRepository)
    .useValue({})
    .overrideProvider(AuditService)
    .useValue({
      record: async (): Promise<never> => { throw new Error("auth e2e：审计写入未接线"); },
      recordDenied: async (): Promise<never> => { throw new Error("auth e2e：越权留痕未接线"); },
      list: async (): Promise<never> => { throw new Error("auth e2e：审计查询未接线"); },
    })
    .overrideProvider(InternalUserService)
    .useValue({})
    .compile();
  const app = moduleRef.createNestApplication();
  app.useLogger(false);
  await app.init();
  return {
    agent: request(app.getHttpServer()),
    fakeUsers,
    fakeSessions,
    close: () => app.close(),
  };
}

// ---------- Cookie 工具 ----------

function setCookiesOf(response: SupertestResponse): string[] {
  const value: unknown = response.headers["set-cookie"];
  if (Array.isArray(value)) {
    return value as string[];
  }
  return typeof value === "string" ? [value] : [];
}

function cookieValue(setCookies: string[], name: string): string | null {
  for (const cookie of setCookies) {
    const pair = cookie.split(";")[0] ?? "";
    const index = pair.indexOf("=");
    if (index > 0 && pair.slice(0, index) === name) {
      return decodeURIComponent(pair.slice(index + 1));
    }
  }
  return null;
}

function cookieHeader(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([name, value]) => name + "=" + encodeURIComponent(value))
    .join("; ");
}

/** 走一遍 /auth/login，返回 state 与转场 Cookie。 */
async function startLogin(context: TestContext, query = ""): Promise<{ state: string; transient: string; location: string }> {
  const response = await context.agent.get("/auth/login" + query).expect(302);
  const location = String(response.headers["location"]);
  const state = new URL(location).searchParams.get("state");
  const transient = cookieValue(setCookiesOf(response), "ll_oidc");
  if (state === null || transient === null) {
    throw new Error("登录跳转缺少 state / ll_oidc");
  }
  return { state, transient, location };
}

const defaultClaims = {
  sub: "user-1",
  id: "casdoor-user-1",
  name: "A0001",
  displayName: "张三",
  email: "zhangsan@libiaorobot.com",
  owner: "libiaorobot.com",
};

/** 完成回调，返回会话 Cookie 与响应。 */
async function completeLogin(
  context: TestContext,
  claims: Record<string, unknown> = defaultClaims,
  query = "",
): Promise<{ session: string; csrf: string; response: SupertestResponse }> {
  const { state, transient } = await startLogin(context, query);
  const code = idp.createCode(claims);
  const response = await context.agent
    .get("/auth/callback")
    .query({ code, state })
    .set("Cookie", cookieHeader({ ll_oidc: transient }))
    .expect(302);
  const cookies = setCookiesOf(response);
  const session = cookieValue(cookies, "ll_sid");
  const csrf = cookieValue(cookies, "ll_csrf");
  if (session === null || csrf === null) {
    throw new Error("回调未下发会话 / CSRF Cookie");
  }
  return { session, csrf, response };
}

// ---------- 用例 ----------

describe("会话后端化 /auth/*（g6 验收：可登录 / 可登出 / 超时符合标准）", () => {
  it("GET /auth/login 302 到 Casdoor 授权页并携带 PKCE 参数 + 转场 Cookie", async () => {
    const context = await createApp(30);
    const { location } = await startLogin(context, "?returnTo=/projects/1");
    const url = new URL(location);
    expect(url.pathname).toBe("/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect((url.searchParams.get("code_challenge") ?? "").length).toBeGreaterThan(20);
    await context.close();
  });

  it("完整链路：回调建会话（用户 upsert + Cookie + 只存哈希）→ /auth/me 返回用户", async () => {
    const context = await createApp(30);
    const { session, csrf, response } = await completeLogin(context);
    expect(String(response.headers["location"])).toBe("/");
    const cookies = setCookiesOf(response);
    expect(cookies.some((cookie) => cookie.startsWith("ll_sid=") && cookie.includes("HttpOnly"))).toBe(true);
    expect(cookies.some((cookie) => cookie.startsWith("ll_csrf=") && !cookie.includes("HttpOnly"))).toBe(true);
    expect(cookies.some((cookie) => cookie.startsWith("ll_oidc=") && cookie.includes("Max-Age=0"))).toBe(true);
    expect(idp.lastTokenQuery?.code_verifier).toBeTruthy();
    expect(idp.lastTokenQuery?.client_secret).toBe(CLIENT_SECRET);
    expect(idp.lastTokenQuery?.redirect_uri).toBe(REDIRECT_URI);

    const rows = context.fakeSessions.all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash).not.toBe(session);
    expect(rows[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/);

    const me = await context.agent.get("/auth/me").set("Cookie", cookieHeader({ ll_sid: session })).expect(200);
    expect(csrf.length).toBeGreaterThan(10);
    expect(me.body.user).toEqual({
      id: "casdoor-user-1",
      name: "A0001",
      displayName: "张三",
      email: "zhangsan@libiaorobot.com",
      owner: "libiaorobot.com",
    });
    expect(me.body.claims.id).toBe("casdoor-user-1");
    expect(typeof me.body.expiresAt).toBe("number");
    await context.close();
  });

  it("returnTo 开放重定向被拒：仅同源相对路径生效", async () => {
    const context = await createApp(30);
    const { response } = await completeLogin(context, defaultClaims, "?returnTo=https://evil.example.com/phish");
    expect(String(response.headers["location"])).toBe("/");
    await context.close();
  });

  it("未登录 /auth/me 返回 401 统一信封", async () => {
    const context = await createApp(30);
    const response = await context.agent.get("/auth/me").expect(401);
    expect(response.body.code).toBe("AUTH_REQUIRED");
    expect(response.body.details).toEqual([]);
    expect(typeof response.body.traceId).toBe("string");
    await context.close();
  });

  it("回调 state 不符 / 缺少转场 Cookie 返回 400 AUTH_CALLBACK_FAILED", async () => {
    const context = await createApp(30);
    const { transient } = await startLogin(context);
    const code = idp.createCode(defaultClaims);
    const mismatch = await context.agent
      .get("/auth/callback")
      .query({ code, state: "wrong-state" })
      .set("Cookie", cookieHeader({ ll_oidc: transient }))
      .expect(400);
    expect(mismatch.body.code).toBe("AUTH_CALLBACK_FAILED");
    const missing = await context.agent.get("/auth/callback").query({ code, state: "whatever" }).expect(400);
    expect(missing.body.code).toBe("AUTH_CALLBACK_FAILED");
    await context.close();
  });

  it("ID Token 受众不匹配 / 已过期都会被拒", async () => {
    const context = await createApp(30);
    const { state, transient } = await startLogin(context);
    const code = idp.createCode({ ...defaultClaims, aud: "other-client" });
    const wrongAudience = await context.agent
      .get("/auth/callback")
      .query({ code, state })
      .set("Cookie", cookieHeader({ ll_oidc: transient }))
      .expect(400);
    expect(wrongAudience.body.code).toBe("AUTH_CALLBACK_FAILED");

    const login2 = await startLogin(context);
    const expired = idp.createCode({ ...defaultClaims, exp: Math.floor(Date.now() / 1000) - 10 });
    const expiredResponse = await context.agent
      .get("/auth/callback")
      .query({ code: expired, state: login2.state })
      .set("Cookie", cookieHeader({ ll_oidc: login2.transient }))
      .expect(400);
    expect(expiredResponse.body.code).toBe("AUTH_CALLBACK_FAILED");
    await context.close();
  });

  it("空闲超时：超过 SESSION_IDLE_MINUTES 后 /auth/me 401 且会话被撤销", async () => {
    const context = await createApp(30);
    const { session } = await completeLogin(context);
    context.fakeSessions.ageAll(31 * 60 * 1000);
    const response = await context.agent.get("/auth/me").set("Cookie", cookieHeader({ ll_sid: session })).expect(401);
    expect(response.body.code).toBe("AUTH_REQUIRED");
    expect(context.fakeSessions.all()[0]?.revokedAt).not.toBeNull();
    await context.close();
  });

  it("登出：撤销本地会话并 302 Casdoor 单点登出（携 id_token_hint + 已登记回跳地址），旧 Cookie 失效", async () => {
    const context = await createApp(30);
    const { session } = await completeLogin(context);
    const response = await context.agent.get("/auth/logout").set("Cookie", cookieHeader({ ll_sid: session })).expect(302);
    const location = new URL(String(response.headers["location"]));
    expect(location.pathname).toBe("/api/logout");
    expect(location.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(location.searchParams.get("post_logout_redirect_uri")).toBe(REDIRECT_URI);
    expect((location.searchParams.get("id_token_hint") ?? "").split(".")).toHaveLength(3);
    expect(setCookiesOf(response).some((cookie) => cookie.startsWith("ll_sid=") && cookie.includes("Max-Age=0"))).toBe(true);
    const me = await context.agent.get("/auth/me").set("Cookie", cookieHeader({ ll_sid: session })).expect(401);
    expect(me.body.code).toBe("AUTH_REQUIRED");
    await context.close();
  });

  it("登出回跳：/auth/callback 无 code / state / error 时 302 回站点首页（/）", async () => {
    const context = await createApp(30);
    const response = await context.agent.get("/auth/callback").expect(302);
    expect(response.headers["location"]).toBe("/");
    await context.close();
  });

  it("禁用账号：登录回调 403；已登录会话在 /auth/me 被踢（401）", async () => {
    const context = await createApp(30);
    const { session } = await completeLogin(context);
    context.fakeUsers.setStatus("casdoor-user-1", "disabled");
    const me = await context.agent.get("/auth/me").set("Cookie", cookieHeader({ ll_sid: session })).expect(401);
    expect(me.body.code).toBe("AUTH_REQUIRED");

    const { state, transient } = await startLogin(context);
    const code = idp.createCode(defaultClaims);
    const callback = await context.agent
      .get("/auth/callback")
      .query({ code, state })
      .set("Cookie", cookieHeader({ ll_oidc: transient }))
      .expect(403);
    expect(callback.body.code).toBe("FORBIDDEN");
    await context.close();
  });

  it("CsrfGuard：写方法需 X-CSRF-Token 与 ll_csrf 一致", () => {
    const guard = new CsrfGuard();
    const contextOf = (method: string, headers: Record<string, unknown>): ExecutionContext =>
      ({ switchToHttp: () => ({ getRequest: () => ({ method, headers }) }) }) as unknown as ExecutionContext;
    expect(guard.canActivate(contextOf("GET", {}))).toBe(true);
    expect(() => guard.canActivate(contextOf("POST", { cookie: "ll_csrf=abc" }))).toThrowError();
    expect(guard.canActivate(contextOf("POST", { cookie: "ll_csrf=abc", "x-csrf-token": "abc" }))).toBe(true);
  });
});
