# CAD 持久化与上传预解析验证

日期：2026-10-22。测试基线为已合入 PR #553 的本地 wmj `1650587`；交付同步主干 `ac244e2`（仅文档变化），本次未部署。PR、提交和 CI 交付记录见同批 `开发日志.md` Push 294。设计与方案比较见 [ADR-037](../adr/ADR-037-CAD产物持久化与上传预解析.md)。

## 行为

- STEP 上传完成的版本事务内登记 GB 后台任务，上传响应不等待 native 解析；worker 通过原 Unix HTTP 沙箱转换，不与通知 outbox 串行等待。未启用 CAD 的环境与其他格式保留原行为。
- `cad_artifacts` 保存按文件版本/源摘要、固定引擎、名称码页隔离的队列、状态及产物索引；`cad_views` 保存 actor/window 绑定、取消与资源租期。完整 manifest/buffers 写入私有对象存储后，数据库才发布 completed。
- 成功产物跨 API/worker/CAD 重启复用。窗口取消不取消后台工作；权限撤销、lease 释放仍立即拒绝资源读取。损坏或缺失时撤销完成态并重建，新文件版本/引擎/编码另行生成。
- 产物位于 `projects/{projectId}/files/{fileId}/cad/`，沿用项目与文件清理范围。持久发布后释放归档 lease，再回收没有其他 lease/alias 使用的自有沙箱临时任务；保留原禁网、只读根目录及内核资源限额。

## 最终验证

环境：Node 24.19.0；独立 PostgreSQL 18.6；本地 MinIO 官方二进制；Docker 中的 CAD `1.0.1`（Linux amd64 仿真，固定 OCP/Gmsh 版本不变）。输入为仓库 `controlled-box.step`（15,416 bytes），无公司账号、业务文件或服务器写操作。

| 验证 | 结果 | 范围 |
| --- | --- | --- |
| 接口与上传定向回归 | 5 文件、170 项通过，28.15 秒 | CAD HTTP、权限/CSRF、默认 GB/显式 UTF8、缓存与取消、预览读取、原件下载、上传完成事务内登记；不修改生产鉴权 |
| 持久化实测 | 10 项通过，34.56 秒 | PostgreSQL + MinIO + 真实 native 沙箱；上传事务回滚/幂等；并发 worker 只提交一次；完整发布；自有 native 临时 job 回收；实际 CAD 容器重启及新 API/worker 实例零次 native 提交复用；独立窗口/权限/租期；编码隔离；丢失/同大小损坏重建；保存失败不发布；过期 claim fencing；原件 SHA 错误不启动 native；清理与数据库约束 |
| 内核硬限额 | 9 项通过 | 新 CAD 镜像上的 CPU 节流、PID 拒绝、真实独立 OOM/137、文件 EFBIG、tmpfs ENOSPC、只读/禁网、缺限制拒绝启动及 namespace 清理 |
| 数据库迁移 | 63 个迁移（含新 0064）成功，复跑无漂移 | 独立数据库运行真实迁移器与 migrator 角色，应用角色能访问新表；不在应用启动时改结构 |
| 实际 worker 启动 | 通过 | Node 24 运行实际 WorkerModule，以应用角色领取空队列并正常关闭；独立本地 worker 子进程启动、轮询和 SIGTERM 关闭通过，未运行 outbox 或公司任务 |
| 生产 Compose 合并 | 通过 | API / worker 均只读挂载 CAD socket；CAD `network_mode=none`、3 GiB / 禁 swap / 1 CPU / 64 PID。使用 no-env-resolution / no-interpolate 核对，未读取 secrets |
| 内置浏览器 | 通过 | 受控模型已就绪；默认选中中文旧编码，手动 UTF8 重新读取成功，关闭重开仍携带 UTF8 选择；这部分使用本地测试身份/存储的查看器夹具，不冒充公司完整上传 E2E |
| 契约生成 | 已执行 shared `npm run generate` | 同步默认编码与持久任务说明，未新增公开 HTTP 字段或 URL |

定向命令（`server/`，使用 Node 24）：

```sh
CAD_TEST_ENDPOINT=http://127.0.0.1:9910 CAD_TEST_CONTAINER=libiaolink-cad-cad-1 \
  node node_modules/vitest/vitest.mjs run --config test/cad.vitest.config.ts \
  test/cad-engine-client.test.ts test/cad-platform.test.ts test/preview-read.test.ts \
  test/file-download.test.ts test/file-service.test.ts

CAD_TEST_ENDPOINT=http://127.0.0.1:9910 CAD_TEST_CONTAINER=libiaolink-cad-cad-1 \
CAD_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5544/libiaolink_cad_test \
  node node_modules/vitest/vitest.mjs run --config test/cad.vitest.config.ts test/cad-archive.integration.test.ts

CAD_TEST_ENDPOINT=http://127.0.0.1:9910 CAD_TEST_CONTAINER=libiaolink-cad-cad-1 \
  python3 test/cad-sandbox.test.py
```

上述测试组须顺序执行，故障与持久化测试会重启本地指定的 CAD 测试容器。先准备专用 PostgreSQL 18（loopback 5544、库名 libiaolink_cad_test）及 `server/cad-engine/.runtime/minio` 可执行文件。

持久化测试拒绝非 loopback 或非专用库名，在专用库内另建随机 schema；MinIO 使用新临时目录、随机凭据和独立 loopback 端口，结束后清理。没有配置 endpoint/专用数据库/MinIO 可执行文件时会跳过，跳过不算通过。本轮配置完整，未跳过上述项。

## 调试与未覆盖边界

首轮持久化联测在 CAD 容器重启后过早开始下一项 native 请求，导致后续四项失败；补齐健康就绪等待后通过。Node 24 的一次组合回归出现未定位的夹具 401，native 单独 13 项复跑未重现；夹具改为单次绑定 loopback 端口后，组合 170 项通过，生产会话/CSRF 未改。浏览器启动时两次临时清单格式/路径错误已修正，最终浏览器验证通过。本地独立 worker 首次进程启动暴露 ESM 静态导入先于源码钩子执行的问题，已改为钩子加载后的动态导入，并通过实际子进程启停验证。失败迭代没有记作通过。

没有运行全量构建、typecheck、lint 或全仓审计；仅重建 CAD 专用镜像并运行以上定向验证。未重复独立 CAD 全样本矩阵，不扩展格式范围或承诺任意 STEP 成功率。缓存按文件版本隔离，不承诺跨文件、跨版本只解析一次；受支持的同一版本完成后可长期复用。

上线需迁移 0064、同步 API/worker 与含临时回收行为的 CAD 镜像，生产镜像必须取得审核后的 registry digest；本地镜像 ID 不作生产发布凭据。回滚应用时停止后台 worker，保留新表与私有对象可再次启用；旧应用不会读取持久缓存。数据库和对象存储需共同备份。崩溃留下的未引用对象代由文件/项目前缀清理兜底；公司测试机与真实账号验收尚未执行。
