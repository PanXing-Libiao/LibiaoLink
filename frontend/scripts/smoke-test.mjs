/**
 * LibiaoLink 前端 SSO 链路冒烟测试（无需浏览器）
 *
 * 前置：
 *   1. 本地 Casdoor 已启动（deploy/casdoor，docker compose up -d）
 *   2. 后端 api 已启动：server/ 下 npm run start:api（server/.env 指向本地沙箱；PORT=3001 与前端错开）
 *   3. npm run dev 已在 3000 端口运行（/auth/* 经 Vite 代理到后端）
 *   4. Casdoor 应用 libiaolink 的 Redirect URLs 含 http://localhost:3000/auth/callback
 *
 * 用法：node scripts/smoke-test.mjs（或 npm run smoke）
 * 账号口令取自 .env.local（frontend/ 或 deploy/casdoor/，均不入库）；可用环境变量覆盖：
 *   FRONTEND_BASE / TEST_USERNAME / TEST_PASSWORD / CASDOOR_APPLICATION / CASDOOR_ORGANIZATION
 */

import fs from "node:fs";

// 本地沙箱账号口令从 gitignore 的 .env.local 读取（仓库不存明文；已存在的环境变量优先）
function loadEnvFile(file) {
  if (!fs.existsSync(file)) {
    return;
  }
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    const key = match[1];
    const value = match[2].replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(new URL("../.env.local", import.meta.url));
loadEnvFile(new URL("../../deploy/casdoor/.env.local", import.meta.url));

const FRONTEND = process.env.FRONTEND_BASE ?? "http://localhost:3000";
const APP_NAME = process.env.CASDOOR_APPLICATION ?? "libiaolink";
const ORG_NAME = process.env.CASDOOR_ORGANIZATION ?? "libiaorobot";
const USERNAME = process.env.TEST_USERNAME ?? "zhangsan";
const PASSWORD = process.env.TEST_PASSWORD ?? "";
if (PASSWORD === "") {
  console.error("缺少本地测试口令：请在 frontend/.env.local 或 deploy/casdoor/.env.local 设 TEST_USERNAME / TEST_PASSWORD（仓库不存明文）");
  process.exit(2);
}

const jar = new Map();
const cookieRaw = new Map();
let failures = 0;

function storeCookies(response) {
  for (const raw of response.headers.getSetCookie()) {
    const pair = raw.split(";")[0];
    const index = pair.indexOf("=");
    if (index === -1) {
      continue;
    }
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (value === "") {
      jar.delete(name);
      cookieRaw.delete(name);
    } else {
      jar.set(name, value);
      cookieRaw.set(name, raw);
    }
  }
}

function cookieHeader() {
  const parts = [];
  for (const entry of jar.entries()) {
    parts.push(entry[0] + "=" + entry[1]);
  }
  return parts.join("; ");
}

function check(name, ok, detail) {
  if (ok) {
    console.log("  [PASS] " + name);
  } else {
    failures += 1;
    console.log("  [FAIL] " + name + (detail === undefined ? "" : "  -> " + detail));
  }
}

async function main() {
  console.log("== 0. 后端就绪（/readyz，经前端代理）==");
  const readyResponse = await fetch(FRONTEND + "/readyz");
  const readyText = await readyResponse.text();
  check("后端 readyz 200（PG 连通、核心表可达）", readyResponse.status === 200, String(readyResponse.status) + " " + readyText.slice(0, 120));

  console.log("== 1. 首页 ==");
  const rootResponse = await fetch(FRONTEND + "/", { redirect: "manual" });
  const rootHtml = await rootResponse.text();
  check("首页可访问（200）", rootResponse.status === 200, String(rootResponse.status));
  check("首页返回 SPA 壳", rootHtml.includes("id=\"root\""), "未找到 #root");

  console.log("== 2. 登录入口（/auth/login）==");
  const loginResponse = await fetch(FRONTEND + "/auth/login", { redirect: "manual" });
  storeCookies(loginResponse);
  const authorizeUrl = loginResponse.headers.get("location") ?? "";
  check("302 到 Casdoor 授权页", loginResponse.status === 302 && authorizeUrl.includes("/login/oauth/authorize"), String(loginResponse.status) + " " + authorizeUrl);
  const authUrl = new URL(authorizeUrl);
  const state = authUrl.searchParams.get("state") ?? "";
  const redirectUri = authUrl.searchParams.get("redirect_uri") ?? "";
  check("带 PKCE（S256）", authUrl.searchParams.get("code_challenge_method") === "S256" && (authUrl.searchParams.get("code_challenge") ?? "") !== "");
  check("redirect_uri = " + FRONTEND + "/auth/callback", redirectUri === FRONTEND + "/auth/callback", redirectUri);
  check("已种下登录会话 Cookie（ll_oidc）", jar.has("ll_oidc"));

  console.log("== 3. 在 Casdoor 登录，建立 SSO 会话（模拟用户在登录页输入账号口令）==");
  const issuer = authUrl.origin;
  const casdoorLoginUrl = new URL(issuer + "/api/login");
  const loginParams = [
    ["clientId", "client_id"],
    ["responseType", "response_type"],
    ["redirectUri", "redirect_uri"],
    ["scope", "scope"],
    ["state", "state"],
    ["code_challenge", "code_challenge"],
    ["code_challenge_method", "code_challenge_method"],
  ];
  for (const [target, source] of loginParams) {
    const value = authUrl.searchParams.get(source);
    if (value !== null) {
      casdoorLoginUrl.searchParams.set(target, value);
    }
  }
  const casdoorResponse = await fetch(casdoorLoginUrl, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      application: APP_NAME,
      organization: ORG_NAME,
      username: USERNAME,
      password: PASSWORD,
      autoLogin: true,
      type: "login",
    }),
  });
  storeCookies(casdoorResponse);
  const casdoorJson = await casdoorResponse.json();
  check("Casdoor 接受账号口令（status=ok）", casdoorJson.status === "ok", JSON.stringify(casdoorJson.msg ?? casdoorJson));
  check("已建立 SSO 会话（casdoor_session_id）", jar.has("casdoor_session_id"), String(casdoorJson.status));

  console.log("== 4. 已有 SSO 会话 + enableAutoSignin：自动签发（免二次点击）==");
  // 登录页 JS（loginAsCurrentAccount）在已有会话时发的就是下面这个请求：只带会话 Cookie，不带账号口令。
  const autoLoginUrl = new URL(issuer + "/api/login");
  for (const [target, source] of loginParams) {
    const value = authUrl.searchParams.get(source);
    if (value !== null) {
      autoLoginUrl.searchParams.set(target, value);
    }
  }
  const autoResponse = await fetch(autoLoginUrl, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/json", Cookie: cookieHeader() },
    body: JSON.stringify({ application: APP_NAME, organization: ORG_NAME, language: "zh", type: "code" }),
  });
  const autoJson = await autoResponse.json();
  check("凭已有会话静默换取授权码", autoJson.status === "ok", JSON.stringify(autoJson.msg ?? autoJson));
  let code = "";
  if (typeof autoJson.data === "string" && autoJson.data !== "") {
    code = autoJson.data.includes("code=") ? (new URL(autoJson.data).searchParams.get("code") ?? "") : autoJson.data;
  }
  check("拿到授权码", code !== "");

  console.log("== 5. 回调换令牌（/auth/callback）==");
  const callbackResponse = await fetch(FRONTEND + "/auth/callback?code=" + encodeURIComponent(code) + "&state=" + encodeURIComponent(state), {
    redirect: "manual",
    headers: { Cookie: cookieHeader() },
  });
  if (callbackResponse.status !== 302) {
    console.log("     回调响应: " + (await callbackResponse.text()));
  }
  storeCookies(callbackResponse);
  check("回调 302 回首页", callbackResponse.status === 302 && callbackResponse.headers.get("location") === "/", String(callbackResponse.status));
  check("已建立本地会话（ll_sid）", jar.has("ll_sid"));
  check("ll_sid 为 HttpOnly", (cookieRaw.get("ll_sid") ?? "").toLowerCase().includes("httponly"));
  check("ll_csrf 可读（非 HttpOnly，供 X-CSRF-Token）", jar.has("ll_csrf") && !(cookieRaw.get("ll_csrf") ?? "").toLowerCase().includes("httponly"));
  check("旧的令牌 Cookie 已移除（ll_at / ll_idt）", !jar.has("ll_at") && !jar.has("ll_idt"));

  console.log("== 6. 取用户信息（/auth/me）==");
  const meResponse = await fetch(FRONTEND + "/auth/me", { headers: { Cookie: cookieHeader() } });
  const me = await meResponse.json();
  check("/auth/me 200", meResponse.status === 200, String(meResponse.status));
  const user = me.user ?? {};
  check("Name = " + USERNAME, user.name === USERNAME, String(user.name));
  check("DisplayName 非空", typeof user.displayName === "string" && user.displayName !== "", String(user.displayName));
  check("Email 非空", typeof user.email === "string" && user.email.includes("@"), String(user.email));
  check("Id 非空", typeof user.id === "string" && user.id !== "", String(user.id));
  check("Owner 非空", typeof user.owner === "string" && user.owner !== "", String(user.owner));
  check("id_token 通过 JWKS 验签（claims 可读）", typeof me.claims === "object" && me.claims !== null && me.claims.name !== undefined);
  check("expiresAt 为 Unix 秒", typeof me.expiresAt === "number" && me.expiresAt > 0, String(me.expiresAt));

  console.log("== 7. 登出（/auth/logout）==");
  const logoutResponse = await fetch(FRONTEND + "/auth/logout", { redirect: "manual", headers: { Cookie: cookieHeader() } });
  storeCookies(logoutResponse);
  check("登出 302", logoutResponse.status === 302, String(logoutResponse.status));
  const logoutLocation = logoutResponse.headers.get("location") ?? "";
  check("登出跳 Casdoor 单点登出（带 id_token_hint）", logoutLocation.includes("/api/logout") && logoutLocation.includes("id_token_hint="), logoutLocation.slice(0, 100));
  const logoutRedirectUri = new URL(logoutLocation).searchParams.get("post_logout_redirect_uri") ?? "";
  check("登出回跳复用已登记回调地址（= 登录 redirect_uri）", logoutRedirectUri === redirectUri, logoutRedirectUri);
  const landingResponse = await fetch(FRONTEND + "/auth/callback", { redirect: "manual" });
  check("无参数 /auth/callback（单点登出回跳）302 回首页", landingResponse.status === 302 && landingResponse.headers.get("location") === "/", String(landingResponse.status) + " " + (landingResponse.headers.get("location") ?? ""));
  check("登出清理会话 Cookie（ll_sid / ll_csrf）", !jar.has("ll_sid") && !jar.has("ll_csrf"));
  const afterLogout = await fetch(FRONTEND + "/auth/me", { headers: { Cookie: cookieHeader() } });
  check("登出后 /auth/me 401", afterLogout.status === 401, String(afterLogout.status));

  console.log("== 8. 登录回跳 returnTo（白名单）==");
  async function loginWithReturnTo(returnTo) {
    const loginResponse2 = await fetch(FRONTEND + "/auth/login?returnTo=" + encodeURIComponent(returnTo), { redirect: "manual" });
    storeCookies(loginResponse2);
    const authUrl2 = new URL(loginResponse2.headers.get("location") ?? "");
    const loginUrl2 = new URL(authUrl2.origin + "/api/login");
    for (const [target, source] of loginParams) {
      const value = authUrl2.searchParams.get(source);
      if (value !== null) {
        loginUrl2.searchParams.set(target, value);
      }
    }
    const auto2 = await fetch(loginUrl2, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/json", Cookie: cookieHeader() }, body: JSON.stringify({ application: APP_NAME, organization: ORG_NAME, language: "zh", type: "code" }) });
    const autoJson2 = await auto2.json();
    let code2 = "";
    if (typeof autoJson2.data === "string" && autoJson2.data !== "") {
      code2 = autoJson2.data.includes("code=") ? (new URL(autoJson2.data).searchParams.get("code") ?? "") : autoJson2.data;
    }
    const callback2 = await fetch(FRONTEND + "/auth/callback?code=" + encodeURIComponent(code2) + "&state=" + encodeURIComponent(authUrl2.searchParams.get("state") ?? ""), { redirect: "manual", headers: { Cookie: cookieHeader() } });
    storeCookies(callback2);
    return callback2;
  }

  const legitCallback = await loginWithReturnTo("/#/project/3");
  check("回调按 returnTo 回跳（/#/project/3）", legitCallback.status === 302 && legitCallback.headers.get("location") === "/#/project/3", String(legitCallback.status) + " " + (legitCallback.headers.get("location") ?? ""));
  const evilCallback = await loginWithReturnTo("//evil.example/x");
  check("非法 returnTo 回退到 /", evilCallback.status === 302 && evilCallback.headers.get("location") === "/", String(evilCallback.status) + " " + (evilCallback.headers.get("location") ?? ""));
  const logoutFinal = await fetch(FRONTEND + "/auth/logout", { redirect: "manual", headers: { Cookie: cookieHeader() } });
  check("收尾登出 302", logoutFinal.status === 302, String(logoutFinal.status));

  console.log("");
  if (failures === 0) {
    console.log("全部通过：SSO 链路完整可用");
  } else {
    console.log("失败项：" + String(failures));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("冒烟测试异常：", error);
  process.exitCode = 1;
});
