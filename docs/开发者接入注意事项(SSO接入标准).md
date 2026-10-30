# 开发者接入注意事项（SSO / Casdoor 标准）

> 适用：所有需要接入公司统一登录（SSO）的业务系统
> 正式 SSO：https://auth.libiaorobot.com（公网）｜ 测试 SSO：https://authtest.libiaorobot.com（仅内网）
> 业务组织：`libiaorobot.com`（**应用与用户都必须建在这里**）｜ 本地参考实现：Docker 自建（组织 `libiaorobot` / 应用 `libiaolink`）
> 章节对应公司《SSO 接入注意事项》第二 ~ 第六部分；标注"实测"的内容均已在 Casdoor v4.4.0 验证
> **用户字段口径（已定）**：`Name` = 拼音全名（如 `zhangsan`，全小写无分隔符）｜ `DisplayName` = 中文姓名（`张三`）｜ `Email` = 企业邮箱（`zhangsan@libiaorobot.com`）—— 详见下文「附录 A」（第六节）

---

### 环境信息（官方）

| 环境 | 用户入口 | 管理员入口 | 公网访问 |
|---|---|---|---|
| 正式 | `https://auth.libiaorobot.com` | `https://auth.libiaorobot.com/login/built-in` | ✅ 开放 |
| 测试 | `https://authtest.libiaorobot.com` | `https://authtest.libiaorobot.com/login/built-in`（`admintest`） | ❌ 仅内网 |

**组织（测试环境共 3 个）**：

| 组织 | 用途 | 注意 |
|---|---|---|
| `built-in` | 管理员组织 | ⚠️ 不要在该组织里改任何参数 |
| `libiaorobot.com` | 立镖业务组织 | **所有应用和用户都必须建在这里**；只有同组织的用户才能登录绑在该组织下的应用 |
| `casbin` | 测试组织 | 复现 Bug 用，提交给 Casdoor 团队 |

**测试环境与正式环境的差别**：

1. 测试环境**没有提供商**：没有短信、邮箱验证码，也没有企业微信登录。
2. 测试环境**没有正式员工用户**：要自己创建与正式环境**一致的用户名和邮箱**，再验证登录。
3. 两个环境**域名互不相通**，测试环境不开放公网访问。

---

## 一、开发者接入注意事项（对应公司规范第二部分）

| # | 规则 | 配置位置 | 参考实现值 |
|---|---|---|---|
| 1 | **只用标准 OIDC 协议**，不要用 Casdoor 集成的 SDK | 接入方代码 | 只需 `Client ID` + `Client Secret` |
| 2 | **配好 Redirect URLs**（测试环境先填测试域名，正式环境引用同一套地址规则） | Applications → Redirect URLs | `http://localhost:8000/account`（本地沙箱） |
| 3 | **Grant types 只用 Authorization Code** | Applications → Grant Types | 只勾 `authorization_code` |
| 4 | **Token format 用 `JWT-Custom`**，Token fields 默认只开放 5 个字段；需要按 Casdoor 群组控制页面 / 项目时额外勾选 `Groups` | Applications → Token Format / Token Fields | `Name`、`Owner`、`Id`、`DisplayName`、`Email`；群组权限另加 `Groups` |
| 5 | **提供应用图标**：必须是能代表该应用的 SVG（可用 AI 生成） | Applications → Logo / LogoDark | `assets/libiaolink-logo.svg`（浅色）/ `assets/libiaolink-logo-dark.svg`（深色） |

为什么用标准 OIDC 而不用 SDK：SDK 会把接入方和 Casdoor 的版本绑死，标准 OIDC 让**任何语言、任何框架**都能接，将来换 IdP 时改动最小。业务系统只需要会三件事：跳授权、换令牌、验签。

---

### 控制台配置步骤

进入 `Applications` → 选中你的应用：

1. **Redirect URLs**：填业务系统的回调地址，一行一个。必须**精确匹配**（协议、域名、端口、路径都要一致）。
   过渡期可以同时登记测试和正式两个地址，上线后再删掉测试地址。
2. **Grant Types**：只勾 `Authorization Code`。
3. **Token Format**：选 `JWT-Custom`。
4. **Token Fields**：只选 `Name`、`Owner`、`Id`、`DisplayName`、`Email`；业务确实需要的再加，**不要图省事全开**。LibiaoLink 群组权限必须额外勾选 `Groups`，否则令牌中没有 `groups` 声明。
5. 保存后复制 **Client ID / Client Secret** 给业务系统（Secret 只走密钥渠道，不要贴群里）。

> **建测试用户时的坑（实测）**：不要用 API 复制现成用户来建号——`ldap` 字段会被一起复制过去，
> 登录时报 `password or code is incorrect`（密码其实是对的，Casdoor 转去走 LDAP 了；`signinWrongTimes` 不会增长）。
> 只传必要字段，或建好后把 `ldap` 清空。另外，公司组织 `libiaorobot.com` 的**组织级默认值是空的**，
> 新建应用**不会自动继承** `JWT-Custom` 与那 5 个字段，需要逐个应用手工勾。

**建议**：在 `Organizations` → 组织设置里把 `Default Token Format` 设为 `JWT-Custom`、
`Default Token Fields` 设为上面 5 个字段。这样**新建应用会自动继承公司标准**，不依赖每个人记得去勾。

---

## 二、会话超时设置（对应公司规范第三部分）

**SSO 侧**：单点登录 Cookie 有效期默认 **168 小时（7 天）**。这 7 天内员工访问 auth.libiaorobot.com 下的所有内网应用都不需要重新登录。
**测试时请用无痕窗口或另一个浏览器**，否则会一直被已有会话自动登录，测不出未登录场景。

**应用侧**：应用自身的会话超时必须自己控制。会话过期后，用户回到应用会被再次引导去 SSO 取 Token
（SSO 会话通常还在，所以体验上是**无感重新认证**，用户不会看到登录页）。

### 推荐超时时间

| 应用场景 | 推荐超时 | 主要原因 |
|---|---|---|
| 金融、支付、管理后台 | **15 分钟**或更短 | 涉及敏感信息或资金操作，缩短有效期以降低风险 |
| 电商、SaaS、企业内部系统 | **30 分钟** | 最通用，在体验与服务器资源之间平衡 |
| 高并发、资源敏感型应用 | **10 分钟**或更短 | 显著降低内存占用（实测 30 分钟减至 10 分钟可降约 40%） |
| 内容展示型网站、博客 | **1 小时**或更长 | 以浏览为主、交互少，较长超时体验更好 |

### 各技术栈怎么落地

| 技术栈 | 做法 |
|---|---|
| Java Web | `web.xml` 的 `<session-config><session-timeout>30</session-timeout></session-config>`，或代码 `session.setMaxInactiveInterval(30 * 60)` |
| Spring Boot | `server.servlet.session.timeout=30m` |
| Node / Express | Cookie 设 `maxAge`，服务端再按 `lastSeenAt` 做空闲校验（空闲时长放环境变量，如 `SESSION_IDLE_MINUTES`） |
| Django | `SESSION_COOKIE_AGE` + `SESSION_SAVE_EVERY_REQUEST=True` |
| Go | 自建 `lastSeenAt` 空闲判定，到点清除会话 |

> ⚠️ 不要用"记住我 30 天"之类的开关绕过超时，那等于把 SSO 的安全边界作废。

**实测（本地沙箱 + 临时示例应用，示例已移除）**：临时把超时改成 3 秒 —— 登录后立刻访问 `/me` 返回 200；空闲 5.5 秒后再访问返回 **401**；
此时打开主页会自动 302 回 SSO 重新取 Token，即"超时后重新认证"的正确行为。

---

## 三、登录页面要求（对应公司规范第四部分）

**目标**：用户打开应用主页 → 直接进入单点登录认证页 → 认证成功回到应用。
**尽可能不要让用户看到应用自己的用户名密码界面。**

实现要点：

1. 未登录时**直接 302 跳转**到 SSO 授权地址，不要先渲染一个"请登录"按钮页再让用户点。
2. 本地账号入口只给超级管理员用，放在**隐藏路径**里，页面上**不放任何链接**指向它
   （参考形式：域名 + 后缀，如 `/index.php/login?noredir=1`）。
3. 回调成功后回到用户原本想访问的地址（把原始 URL 记在 state 或参数里），不要一律回首页。
4. 退出登录要同时清掉应用会话 **和** SSO 会话（单点登出），否则用户会立刻被自动登录回来。

**要点**：应用主页（`/`）未登录时直接 302 到 SSO 授权页，不显示本地用户名密码界面；
本地管理员入口放在「域名 + 后缀」的隐藏路径上（全站不放链接），只给超级管理员用。


### 登录页 Logo 尺寸（实测：Casdoor 默认只给 40px 高）

Casdoor v4.4.0 的登录页把应用 Logo 的高度**写死为 40px**（组件里是 `h-10 max-w-full object-contain`），再大的图也会被压扁。这是「logo 显示太小」的根因，不是图标文件本身有问题。

覆盖方式（`login-logo-box` 是 Casdoor 为兼容自定义 CSS 而官方保留的类名，大版本升级也不会失效）：

| 字段 | 值 |
|---|---|
| `Custom CSS`（`formCss`） | `.login-logo-box img{height:140px!important}` |
| `Custom CSS Mobile`（`formCssMobile`） | `.login-logo-box img{height:96px!important}` |

- 位置：控制台 `Applications` → 选中应用 → **UI Customization** 页签 → `Custom CSS` / `Custom CSS Mobile`（CSS 代码框）。保存即生效，**不需要重启** Casdoor；实测 `/api/get-app-login` 立刻能读到新值。
- 高度按需调；宽度由 `object-contain` 等比缩放，不会变形。移动端单独一档，避免小屏把表单挤下去。
- 补充：`formCss` 会被 Casdoor 顺带用来推断登录面板底色（扫描 `.login-panel` 的 background），只写 logo 规则没有副作用。

**图标文件本身也别留白**：Logo SVG 的 `viewBox` 要紧贴图形，否则画布里的空白会被一起压进那 40px。本仓库图标原画布是 `0 0 1535 1024`，而图形只占 `1133 × 698`（左 15%、右 11%、上 15%、下 17% 都是空白），已收紧为 `221.9 142.6 1149 713.8`，同样显示高度下图形放大约 45%。重新导出图标后建议同样处理：按路径控制点求包围盒，再留 6~8px 边距——控制点一定包住贝塞尔曲线，这样算出的框只会偏大、绝不会裁到图形。

---

## 四、权限开通（对应公司规范第五部分）

公司提供两种模式：

- **宽松**：按组开放权限，应用上线时**默认按部门开通**登录权限。
- **严格**：走企业微信审批（直属领导审批 → 权限管理人审批），审批通过后由代码**自动下发**应用权限，并发短信 + 邮件通知。

开发者需要注意：

1. **默认令牌里没有角色、权限和群组**。公司标准是 `JWT-Custom` + 5 个字段；LibiaoLink 若按群组限制页面 / 项目，应用必须额外开放 `Groups`。`roles` / `permissions` 不在其中。
   如果应用要按角色或部门放行，二选一：
   - 在该应用的 **Token Fields** 里额外勾上 `Roles`（令牌自解释，接入最简单）；
   - 保持令牌精简，改用 `/api/userinfo` 或权限接口**实时查询**（令牌更小，但要考虑调用开销与缓存）。
2. **组织隔离**：判断用户时用 `owner + name`，不要只用 `name`（不同组织可能有同名用户）。
3. **不要硬编码角色名**，走配置或映射表，方便 HR 调整组织架构后不用改代码。
4. 权限判断要放在**服务端**。前端读到的角色只用于展示，不能作为放行依据。

---

## 五、权限回收（对应公司规范第六部分）

员工离职或企业微信人员被删除后，Casdoor 里对应用户会被同步删除。
**应用侧必须提供"删除或禁用用户"的 API**，供自动化代码下发，形成完整闭环（成功后由企业微信 Webhook 发送通知）。

### 接口约定（建议）

| 项 | 约定 |
|---|---|
| 路径 | `POST /internal/users/disable`（禁用）、`/enable`（恢复）、`/delete`（删除） |
| 鉴权 | 固定请求头，如 `X-Internal-Token: <密钥>`；密钥走密钥管理，不要写死在代码或仓库里 |
| 入参 | `{"name":"zhangsan","email":"..."}`（以 `name` 为准，邮箱做兜底匹配） |
| 幂等 | 重复调用同一操作必须成功返回（自动化可能重试） |
| 副作用 | **必须同时踢掉该用户的在线会话**，否则他靠旧会话还能继续访问 |
| 返回 | `{"ok":true,"name":"zhangsan","action":"disable","affectedSessions":1}` |
| 禁用 vs 删除 | 建议默认**禁用**（可审计、可恢复）；确认无数据留存要求后再真删除 |
| 失败处理 | 返回非 2xx 并带原因，让自动化能重试与告警，不要静默失败 |

**实测结果（本地沙箱验证）**：

| 场景 | 结果 |
|---|---|
| 无凭证调用 | 401 |
| 带正确凭证禁用 | 200，`affectedSessions: 1` |
| 禁用后原会话访问 | 401（会话被立即清除） |
| 禁用后重新登录 | 403，提示"账号已停用" |
| 调用 enable 恢复 | 200，随后可正常登录 |
| 删除不存在的用户 | 200（幂等，不报错） |

---

## 六、附录 A：令牌与字段（JWT-Custom 实测）

`JWT-Custom` = 标准声明 + 你勾选的业务字段，**不会**把整个用户对象塞进令牌。

| 分类 | 内容 |
|---|---|
| 固定带上的标准声明 | `iss`、`sub`、`aud`、`exp`、`nbf`、`iat`、`jti`、`tokenType`、`azp`、`nonce`、`scope` |
| 勾选的业务字段 | `name`、`owner`、`id`、`displayName`、`email`（LibiaoLink 群组权限另加 `groups`） |
| 不带的内容 | 密码、密码盐、手机号、角色、权限等一律不出现（除非显式勾选） |

### 以「张三」为例（实测结果；姓名、邮箱为示例值，正式用户以 HR 员工数据为准）

| Casdoor 用户字段 | 令牌 claim | 值 |
|---|---|---|
| Name（登录名，拼音全名） | `name` | `zhangsan` |
| DisplayName（显示名） | `displayName` | `张三` |
| Email（企业邮箱） | `email` | `zhangsan@libiaorobot.com` |
| Owner（所属组织） | `owner` | `libiaorobot`（本地演示环境；公司测试/正式环境为 `libiaorobot.com`） |
| Id（Casdoor 内部 UUID） | `id` | `0a57d918-bb5f-49ce-b62a-bcbacb9b0481` |

> ⚠️ **不要拿 `Id` 当登录名**。`Id` 是 Casdoor 内部 UUID，重建数据后会变；
> 业务系统的用户唯一标识应该用 `owner + name`（若 `name` 全公司唯一，也可以直接用 `name`）。

### Name 里放什么（正式环境口径已定：拼音全名）

**结论：`Name` = 拼音全名（如 `zhangsan`），全小写、无分隔符；邮箱只放在 `email` 字段。**

| 用户字段 | 放什么 | 示例 | 典型来源 |
|---|---|---|---|
| `Name` | 拼音全名（登录名） | `zhangsan` | HR 员工数据 / AD 的 sAMAccountName |
| `DisplayName` | 中文姓名 | `张三` | HR 姓名 / AD displayName |
| `Email` | 企业邮箱 | `zhangsan@libiaorobot.com` | HR 邮箱 / AD mail |
| `Owner` | 所属组织 | `libiaorobot.com` | 建用户时归属的组织（**所有应用与用户都建在这个组织下**） |

选拼音全名的理由：

- 员工生命周期内**稳定**；邮箱会因改名、部门调整、域名迁移而变化。
- 全公司唯一（重名由 SSO 管理员用后缀区分）；邮箱可能一人多个（别名/组邮箱）。
- **人可读、可口头传**：张三 → `zhangsan`，员工自己就能想起来；纯数字工号做不到。
- 员工容易记住登录名，能减少找 IT 重置的次数。

什么时候用邮箱：业务系统要**给用户发通知**时直接读 `email` 字段，但不要拿它当主键。

> ⚠️ 如果某个老系统历史上用邮箱做主键：让它在接入时按 `email` 做**一次性映射**到本地账号，
> **不要**为了兼容它把 `Name` 改成邮箱 —— 否则将来邮箱一变，全链路都要跟着改。

### 登录名口径的执行细则（已定：拼音全名）

1. **全小写、无分隔符**：`zhangsan`，不要 `ZhangSan`、`zhang.san`、`zhang-san`。
   Casdoor 默认区分大小写（`Zhangsan` 与 `zhangsan` 是两个账号），组织里开 `isUsernameLowered` 做兜底。
2. **不用数字工号做登录名**：工号（`1001`、`000123` 这类）跨系统会出现补位、前导零、可读性问题；
   工号如确实要用，作为**自定义字段**按需加进令牌，不要占 `Name`。
3. **离职后不把登录名回收给别人**：回收会让同一个 `name` 先后对应两个人，历史日志、审计、令牌全部串味。
   重名（两个张三）时由 SSO 管理员用后缀区分（如 `zhangsan2`），**应用侧不要自己编规则**。
4. **应用侧不要解析 `name` 的格式**：只把它当「全生命周期稳定的唯一登录名」用；
   任何格式假设都会在遇到外籍员工、复姓、重名时翻车。

### 从 AD / HR 同步用户时的映射

把**拼音全名映射到 `name`**、姓名→`displayName`、邮箱→`email`。

> ⚠️ `name` 在 Casdoor 里是**主键的一部分**（`owner + name`）。用户一旦用它登录过，
> 后期改名代价很高（会变成新账号）。**同步前务必先把登录名口径定死**（本规范已定为拼音全名）。

---

## 七、附录 B：两个接口的字段命名不一样（最容易踩）

同一个「登录名」，在两个地方叫两个名字；同一个 name 字段，在两处的含义还不一样：

| 含义 | 令牌里（JWT-Custom） | /api/userinfo 返回 |
|---|---|---|
| 登录名（拼音全名） | `name` | `preferred_username` |
| 显示名 | `displayName` | `name` |
| 邮箱 | `email` | `email` |
| 用户唯一标识 | `id` / `sub` | `sub` |
| 组织 | `owner` | 无 |

原因：/api/userinfo 遵循 OIDC 标准命名（`preferred_username` 才是登录名，`name` 表示显示名），
而令牌里的 claim 直接来自 Casdoor 的用户字段。**接入时务必做一次归一化**，例如：

```js
const user = {
  loginName:   claims.preferred_username || claims.name || '',
  displayName: claims.name || claims.preferred_username || '',
  email:       claims.email || '',
  sub:         claims.sub || '',
};
```

**注意**：ID Token 与 `/api/userinfo` 的字段命名不同（`name` / `preferred_username`、`displayName` / `name`），接入方要统一映射后再用。

实测中 `/api/userinfo` 对张三的返回：

```json
{
  "sub": "0a57d918-bb5f-49ce-b62a-bcbacb9b0481",
  "iss": "http://localhost:8000",
  "aud": "libiaolink-a195b721bb30a7d4",
  "preferred_username": "zhangsan",
  "name": "张三",
  "email": "zhangsan@libiaorobot.com",
  "email_verified": true
}
```

---

## 八、附录 C：实测结论与边界

| 结论 | 说明 |
|---|---|
| Token fields 收敛有效 | 配好后令牌里只有勾选的业务字段（公司标准 5 个；LibiaoLink 群组权限另加 `groups`），其余用户字段全部消失 |
| **Grant Types 拦不住 refresh_token** | 即使只勾 `authorization_code`，授权码流程**仍会返回 refresh_token，且刷新接口可用**（实测 HTTP 200）。要限制长期会话只能靠缩短 Refresh expire，不能指望这个开关 |
| 标准声明不可裁剪 | `iss`/`sub`/`aud`/`exp` 始终存在，这是 OIDC 规范要求，业务侧必须校验 |
| `email_verified` | userinfo 里固定返回 `true`（Casdoor 不校验邮箱域名归属） |
| 字段缺失不报错 | 没勾的字段直接不出现，接入方不要假设某字段一定存在 |

### 建议的令牌有效期

| 项 | 建议值 | 理由 |
|---|---|---|
| Token expire | 1~2 小时 | 令牌泄露的窗口要短 |
| Refresh expire | 7 天（内部系统可更长） | 兼顾体验与安全 |

---

## 九、接入自测清单

- [ ] 只用标准 OIDC，未引入 Casdoor SDK
- [ ] 回调地址与 Casdoor 里登记的一字不差
- [ ] 校验了 `state`（防 CSRF）；SPA 建议同时启用 PKCE
- [ ] 用 `/.well-known/jwks` 公钥**本地验签**，而不是每次请求都打 userinfo
- [ ] 校验了 `iss`、`aud`、`exp`
- [ ] 处理了 userinfo 与令牌的字段命名差异
- [ ] 用户唯一标识用 `owner + name`，没有误用 `id`(UUID)
- [ ] 若按 Casdoor 群组控制页面 / 项目，应用 Token Fields 已勾选 `Groups`，且重新登录后令牌含 `groups`
- [ ] Client Secret 放在服务端配置或密钥管理里，没有进前端代码或 Git
- [ ] 会话空闲超时已按应用类型设置（见第二节），且超时后会重新走 SSO 认证
- [ ] 未登录访问主页直接跳 SSO，看不到本地登录界面；本地管理员入口是隐藏路径且全站无链接
- [ ] 应用图标为 SVG，并已填到 Casdoor 应用的 Logo / LogoDark
- [ ] 提供了离职用户的禁用/删除 API，且调用时会同时踢掉在线会话（见第五节）

---

## 十、本地参考实现（当前 WSL2 + Docker 环境）

完整配置快照、常用命令与常见问题见 **[本地沙箱说明](./本地沙箱(LibiaoLink%20演练环境).md)**。三条登录路径：

> Windows 本地必须使用 WSL2 Ubuntu 内的原生 Docker Engine，不使用 Docker Desktop；安装与验收见 [Windows 本地开发环境](本地开发环境(Windows-WSL2-Docker).md)。

| 路径 | 入口 | 账号 |
|---|---|---|
| 本地账号 | 登录页的 `密码（本地）` | 用户名 `zhangsan`，口令见本地 `deploy/casdoor/.env.local` |
| 公司账号 | 登录页的「公司统一登录（测试环境）」 | 测试环境组织 `libiaorobot.com` 下的账号（如 `yicaonan`） |
| Casdoor 管理员 | `http://localhost:8000/login/built-in` | 账号口令见本地 `deploy/casdoor/.env.local`（**上线前必须改**） |

应用 `libiaolink`：Client ID `libiaolink-a195b721bb30a7d4`，Redirect URLs = `http://localhost:8000/account`，Logo 由 Casdoor 自托管（`http://localhost:8000/files/brand/...`，源文件在仓库 `assets/`）。

公司环境不需要你从零搭：测试 `https://authtest.libiaorobot.com`（仅内网，管理员 `admintest`）、正式 `https://auth.libiaorobot.com`。接入时在组织 `libiaorobot.com` 下建应用，把 Redirect URL 换成对应环境域名，再把 Client ID / Client Secret 发给业务系统。
