# H1 SVG 预览整改回放证据（S6）

> 状态（2026-10-21）：S6 已随 PR [#539](https://github.com/PanXing-Libiao/LibiaoLink/pull/539) 合并 main `336b66fd`；测试机 10.1.104.44 已完成 S2 ～ S6 同批部署与 B1 ～ B6 21/21、B7 浏览器 2/4 回放，9443 由服务器本机 curl 复核；生产尚未部署。回放发现 443 /libiaolink/ 与 9443 各回传两次 HSTS，PR [#542](https://github.com/PanXing-Libiao/LibiaoLink/pull/542) 修复后待部署复测；不能据此宣布 H1 闭环。
>
> 基线：S5 已随 PR #534 合并 main `660cc80`；S6 自动化实现提交 = `lan` `3e63597`，PR CI `39540053943` 全绿；本文件落档前已同步 main `4fa7175`（PR #536 / #537）与 `5bc5c12`（PR #538）；测试部署基线 = main `336b66fd`。
>
> 证据纪律：只保留 origin + pathname、状态、错误码与脱敏摘要；不记录 session token、Cookie、签名 URL query 或生产数据。CI artifact 保留 7 天。

## 1. 范围与入口

| 项 | 内容 |
|---|---|
| 浏览器脚本 | `frontend/scripts/h1-svg-preview-e2e.mjs` |
| npm 入口 | `cd frontend && npm run preview:svg-e2e` |
| CI job | `.github/workflows/ci.yml` → `svg-preview-e2e`（独立 job，超时 35 分钟） |
| CI artifact | `h1-svg-preview-e2e-${{ github.run_id }}` |
| Nginx 派生 | `frontend/scripts/h1-nginx-ci-config.mjs` 从生产 `deploy/prod/nginx/libiaolink.conf` 派生；只替换运行位置，不另写安全头 |
| ONLYOFFICE 桩 | `frontend/scripts/h1-onlyoffice-stub.mjs`；只打通 `api.js → DocEditor → onDocumentReady` 外壳生命周期 |

这是一条真实主栈链路，不是接口 mock：PostgreSQL 迁移 / 种子 → 上传 API → MinIO → `preview.job` → worker → `deploy/svg-preview` → 生产 Nginx 派生配置（HTTPS）→ Headless Chrome / CDP。ONLYOFFICE DocServer 是唯一被桩替代的外部渲染服务。

## 2. CI 前置与隔离

1. 安装并构建 shared / server / frontend / svg-preview；应用数据库角色、迁移与种子。
2. 启动 PostgreSQL 18 service；下载固定版本 MinIO 并校验 SHA-256；生成本地 TLS 证书。
3. 启动 ONLYOFFICE `api.js` 桩、SVG 转换器、由生产配置派生的 Nginx、MinIO、api 与 worker。
4. 浏览器脚本创建一次性 admin 用户、项目、任务和测试文件；结束时清理本次数据库行与 `projects/`、`previews/` 对象。
5. 所有服务仅绑定 CI 回环地址；测试凭证为一次性值，不进入 artifact。
6. 失败时保留 `failure.png`、脱敏 `summary.json`，并收集 api / worker / Nginx / MinIO / ONLYOFFICE / converter 日志；所有日志再经签名 query、Cookie 与 Bearer token 脱敏后上传。

## 3. B1 ～ B7 自动断言

| 组 | 自动覆盖 | 通过条件 |
|---|---|---|
| B1 正常 SVG | 上传中文 SVG；等 `ready`；抽屉缩略图、图片浮层、`ImageZoomViewer` 缩放 | 预览 URL 仅指向 `previews/{64 位哈希}/2.0.0/image`；响应 `image/png` 且 PNG 魔数正确；缩略图 / 浮层自然尺寸有效且 URL 一致；缩放值增加 |
| B2 恶意 SVG | 带 `onload`、`<script>`、Cookie 读取和 `/api/v1/projects` POST 的 SVG；应用内点击、作为 `<img>`、顶层预览、顶层下载 | 无异常 / dialog / 脚本标记 / CSP violation / Cookie 读取 / 非预期 API 写；SPA 自身的背景翻译 `translate` / `translate/batch` POST 不计入异常写，恶意夹具对 `/api/v1/projects` 的写仍必须为 0；预览只可以是 PNG，或确定性 `failed + url=null`；顶层预览最终 `document.contentType=image/png` |
| B3 MIME / 改名 | `image/svg+xml; charset=utf-8`、大写扩展名、双扩展名；扩展名 / MIME / 文件头冲突；改名后历史版本 | 合规输入最终只能是 PNG 或 fail closed；冲突上传按统一错误模型返回 400 `VALIDATION_FAILED` + `mime_mismatch` / `content_mismatch`，且不生成版本行；历史版本仍按版本扩展名裁决且无 `.svg` 直链 |
| B4 原 SVG 下载 | 签名下载恶意 SVG 原对象 | 文件名保留 `.svg`；`attachment` + `application/octet-stream`；字节与上传一致；SHA-256 与上传声明一致 |
| B5 位图回归 | PNG / JPEG / GIF / WebP 上传、缩略图、浮层 | 预览 ready；`target=image`、无 viewer / pipeline；URL 不经 `/previews/`；缩略图与浮层自然尺寸有效 |
| B6 PDF / Office / CAD | PDF、DOCX、STL 上传与浮层 | PDF / DOCX 进入 ONLYOFFICE viewer，不进入转换产物；STL 经抽屉预览按钮进入 `cad3d`，等待 WebGL canvas 与解析终态，无 `.text-red-400`，不进入 PNG 产物 |
| B7 响应头 / CSP | 443 SPA、443 `/libiaolink/` 探针、9443 探针；SPA 控制台 | 三路径均有 HSTS、`nosniff`、XFO `DENY`；SPA CSP 含 `default-src 'self'` / `frame-ancestors 'none'` / `object-src 'none'`；对象门面 CSP 含 `sandbox` / `script-src 'none'` / `default-src 'none'`；SPA 无 `securitypolicyviolation` 或安全日志 |

浏览器同时监听 `Runtime.exceptionThrown`、console、dialog、网络请求与 `securitypolicyviolation`。远程图片、远程字体、动画和交互 SVG 按 ADR-034 不保留；正常预览是静态 PNG。

## 4. 摘要与 artifact

`summary.json` 固定包含：schema、suite、生成时间、status、base origin、浏览器版本、是否强制响应头、B1 ～ B7 明细、失败截图文件名、脱敏错误、部署边界与人工剩余项。明细只记录 `PASS / SKIP / FAIL`、用例名和脱敏说明，不落 Cookie、token 或签名 URL。

失败截图只在用例失败时产生。服务日志和 summary 上传前执行 query / Cookie / Bearer 脱敏；Nginx access log 的 `log_format` 主动不记录 query string，避免预签名参数进入证据。

## 5. 本切片已执行

- `node --check`：`frontend/scripts/*.mjs` 全部通过。
- `tsc -p tsconfig.json` 与 `tsc -p tsconfig.node.json`：通过。
- `vite build`：通过（仅有既有大 chunk 警告）。
- Nginx 派生脚本：本地执行成功，生产 upstream、证书、SPA root 与安全头片段按预期替换。
- `git diff --check` 与 workflow YAML 解析：通过，`svg-preview-e2e` job 可正常读取。
- PR CI [39540053943](https://github.com/PanXing-Libiao/LibiaoLink/actions/runs/39540053943)：5 / 5 job 全绿；`svg-preview-e2e` job `119025492395` 通过，artifact `h1-svg-preview-e2e-39540053943` 的 `summary.json` 为 `passed`。
- 自动矩阵 = **25 / 25 PASS**：B1 3、B2 4、B3 6、B4 1、B5 4、B6 3、B7 4；浏览器 Chrome/155.0.8059.84。
- B6 实际结果：PDF / DOCX 为 ONLYOFFICE 外壳 `ready`，STL 为 `cad3d` 且 WebGL canvas 已挂载；三者均未进入 PNG 产物通道。
- B7 实际结果：443 SPA、443 对象存储门面、9443 备用门面均命中 HSTS / CSP / `nosniff` / XFO；SPA 无 CSP violation 或安全日志。

**边界**：完整 S6 E2E 需要 Linux PostgreSQL / MinIO / Nginx / Chrome 组合，本次已由 PR CI 与测试机分别执行；本地 Windows 未复跑全栈。测试机已完成 B1 ～ B6 与 B7 主体回放，生产仍未部署；`main` 连续 3 次全绿、分支保护、完整 B7 与旧签名过期复测均尚未完成。

## 6. 测试机部署回放（2026-10-21）

| 项 | 结果 |
|---|---|
| 目标机 | `10.1.104.44` / `https://test-pm.libiaorobot.com` |
| 部署基线 | `main@336b66fd4ee5c202828bd0480031702b5b692799` |
| 部署前备份 | `/srv/data/backups/h1-svg-before-20261021-124249/deploy-state.tar.gz`；SHA-256 `d6008c0924c6ac1b2ed14d78af6999d40263bafb7e37ebce3219c4073b46b6ce` |
| 发布件目录 | `/srv/data/backups/h1-svg-336b66fd` |
| 应用包 | `app-h1-s2-s6-336b66fd.tar.gz`；SHA-256 `b012ee256af7ddeb762133fd453049ed564b5e77ff26eeaa4574c7abaef47802` |
| 前端包 | `frontend-h1-s6-336b66fd.tar.gz`；SHA-256 `3ae615e65c9823ea7f4d6d07c1b00b84d5c5e588ad729139c408abf76f8888db` |
| converter 归档 | `svg-preview-2.0.0-linux-amd64.tar`；SHA-256 `23bfb7e3b93077ef4248790de299707a1155752b2cde73d80b20cd73af504a7d` |
| converter 镜像 | `libiaolink/svg-preview:2.0.0@sha256:eaee947e1e6a9e4b3ea7e7057e76e4ac45ac6209fb470593c46686ec7a474282` |
| 容器 | 6/6 healthy，含 internal-only `libiaolink-prod-svg-preview` |
| 健康检查 | `/healthz` 200、`/readyz` 200 |
| converter 自检 | 40 PASS / 0 FAIL / 0 SKIP |
| 浏览器回归 | B1 3、B2 4、B3 6、B4 1、B5 4、B6 3、B7 浏览器 2；ONLYOFFICE / WebGL / fail-closed / 下载 / MIME 断言通过 |
| 9443 边界 | 开发机网络不可达；服务器本机 curl 返回 403，HSTS / CSP / nosniff / XFO 完整 |
| 清理 | `users=0`、`projects=0`、`previewArtifacts=0`、测试 `outbox=0` |
| 发现与处置 | 443 `/libiaolink/` 与 9443 各回传两次相同 HSTS（上游 MinIO）；PR [#542](https://github.com/PanXing-Libiao/LibiaoLink/pull/542) 已加 `proxy_hide_header Strict-Transport-Security`，部署后复测单头 |
| 本地未跟踪证据 | `tmp/h1-deploy/deployment-evidence.json`；浏览器 artifacts `tmp/h1-deploy/e2e-test-server/` 与 `tmp/h1-deploy/e2e-test-server-real-docx/`（不提交） |


## 7. 自动与人工边界

自动覆盖可在一个 CI 作业内复现的安全 / 回归矩阵；以下仍必须在发布窗口人工验收：

1. 真实 ONLYOFFICE DocServer 的 PDF / Office 文档渲染、打印与真实账号会话；测试机已用真实 PDF / DOCX 抽查，打印与生产账号会话仍未覆盖。
2. 真实 CAD 生产样本（STEP / STL / 3MF 及实际尺寸、解析与 WebGL 表现）；测试机已用 STL 抽查 WebGL，生产样本与尺寸场景仍未覆盖。
3. 生产部署后的 TLS、HSTS、CSP、XFO、`nosniff` 三条路径复测；测试机已完成 SPA / 443 与 9443 本机 curl，重复 HSTS 修复待部署。
4. 等待旧预览签名至少 `PREVIEW_URL_TTL_SECONDS` 过期后，复测顶层打开无脚本。
5. 发布后抽样真实 SVG、位图、PDF、Office、CAD 下载；检查 `2.0.0` 产物命中与失败降级。

## 8. 关闭条件（当前未满足）

- [x] S6 PR 已随 PR [#539](https://github.com/PanXing-Libiao/LibiaoLink/pull/539) 合并 main `336b66fd`（PR CI `39540053943` 5 / 5，矩阵 25 / 25）。
- [x] 测试机 10.1.104.44 完成 S2 ～ S6 同批部署与 B1 ～ B6 回放（2026-10-21）。
- [ ] `main` 连续 3 次全绿后，由 px 将 `svg-preview-e2e` 加入分支保护必需检查。
- [ ] 生产完成同批部署与 B7 复测；测试机已完成 B7 主体回放，9443 仅本机 curl，重复 HSTS 修复待部署。
- [ ] 真实 ONLYOFFICE、真实 CAD 生产样本与旧签名过期复测完成。
- [ ] H1 关闭评审完成；此前不得写“H1 已闭环”。
