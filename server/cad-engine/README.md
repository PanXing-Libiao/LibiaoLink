# STEP 平台运行与源码更新

原本地联调已跑通文件版本 → SHA/bytes 核对 → 任务 → 完整产物 → 鉴权 manifest/buffers → ViewerSession。当前运行方式按 ADR-036 改为独立沙箱；历史 stdio 结果见 [逐文件表](../../docs/cad-platform-integration/RESULTS.md)，不冒充本次隔离验收。固定源码见 `source.json`，STEP v0.3.3 几何基线仍为 `0911573`，宿主适配为 `f103d1c`；不改解析、补面或接收政策。

## 准备运行环境

CAD 解析已迁移到独立 Linux 容器，不再由 API 启动 Python。先按 [CAD 沙箱部署手册](../../deploy/cad/README.md) 仅构建 CAD 镜像并启动沙箱；macOS 本地使用开发中继，生产 API 直接连接 Unix socket。

| API 参数 | 含义 |
| --- | --- |
| `CAD_ENGINE_SOCKET` | 生产 Unix socket 绝对路径；与 CAD 容器只共享限容通信目录 |
| `CAD_ENGINE_URL` | 仅开发环境允许 `http://127.0.0.1:9910` 中继；生产拒绝 TCP 回退 |
| `CAD_MAX_INPUT_MIB` | 默认 64，显式可配至 256；同时配置沙箱输入上限，大小不是完成保证 |

旧 `CAD_ENGINE_PYTHON` / `CAD_MESHER_PYTHON` / `CAD_CACHE_DIR` 不再启用 API 内 native 解析。API 无 Python/native 依赖，不接收 CAD 返回的本机路径；沙箱只接收核对过 SHA/bytes 的输入字节，产物以有界流返回。

沙箱强制 3 GiB 内存、1 核 CPU、64 进程/线程、禁 swap；单文件 256 MiB、FD 128、core 0。转换数据、临时目录、通信目录分别限容 1536 / 384 / 1 MiB，根目录只读、capabilities 全部丢弃、禁止提权、seccomp、禁网。启动读取内核实际状态，限制缺失或 cgroup v2 不可用则拒绝运行。原 worker 2 GiB RSS 采样阈值不是硬限额；cgroup 覆盖 gateway、OCP、Gmsh 全部后代。固定任务预算仍为并发 1、排队 8、worker 600 秒、队列 900 秒，PID 1 watchdog 对超期未退出的主 worker 终止整个 CAD namespace。

CAD 内部临时缓存仍受限于 tmpfs 和 24 小时保留；已完成的模型另按 [ADR-037](../../docs/adr/ADR-037-CAD产物持久化与上传预解析.md) 持久化：数据库保存队列、状态、窗口和产物索引，私有对象存储保存完整 manifest / buffers。API/worker/CAD 重启后直接读取完成产物，无需 native 重算；新版本、固定引擎版本或名称编码分别生成，缺失/损坏撤销完成态并排队重建。缓存先按文件版本隔离，不能把上传声明的 SHA 当作跨文件复用的可信凭据。沙箱仍禁网且不持有存储凭据，不增加持久宿主挂载。

浏览器使用 HTTPS，本地 loopback 可验证 Web Crypto。生产镜像、server/shared 和同版本 `/cad-viewer/` 静态资源须按部署流程同步；API 的原内存预算与 CAD 独立核算。本次持久化与预解析变更仍待部署验收。运行边界与研究依据见 [ADR-036](../../docs/adr/ADR-036-CAD解析沙箱与资源硬限额.md)。

名称默认使用 OCCT GB 中文旧编码，不自动猜编码；需要标准编码时，在“模型信息”切换 UTF8 并重新读取。选择在当前标签页按文件版本记忆，并传入任务参数 `nameCodepage`；不同码页隔离缓存，检查记录保留本次选择。源文件无需修改。

查看器已同步相机范围修复：定位小零件后，缩放仍保留整机范围，裁切面随镜头更新。详见独立工程 `docs/step-0.3/focus-camera/README.md`；几何与解析策略沿用此前版本。

定位、淡化、隐藏、仅显示四个操作可再次点击取消，启用时显示按下状态。取消定位恢复此前视角，取消仅显示恢复原用户隔离范围，已有隐藏及隔离期间的显隐修改保留。清空选择后仍能取消已启用模式；适应视图/摆正、全部显示、恢复初始同步更新对应模式状态。

## 持久化与静默预解析

先通过现有迁移器执行 `database/migrations/0064_cad_artifacts.sql`，再更新 API 和 worker。仅启动 CAD 容器不会消费后台任务；生产 worker 须叠加 `deploy/prod/docker-compose.cad.yml`，与 API 一样只读挂载 Unix socket，数据库/对象存储凭据仅留在平台进程。

上传完成的事务为 STEP 登记 GB 队列行，不等待 native。worker 独立轮询专用队列，不占用通知 outbox 的串行循环；租约、claim token 和有界重试防止崩溃后的重复发布。已有未归档版本在首次打开时幂等补投；已存在且可校验的同版本沙箱结果可直接归档。

数据库完成态仅在所有 SHA 产物成功写入后发布；随后回收没有其他窗口/alias 使用的自有沙箱临时任务，腾出限容 tmpfs，失败或借用别人的 native 结果不回收。须更新至含该回收行为的 CAD 镜像（本地 1.0.1，生产使用审核后的 digest）。窗口各自绑定任务、取消状态和五分钟资源租期；关闭窗口不取消后台工作。产物长期保留，对象位于 `projects/{projectId}/files/{fileId}/cad/`，彻底删除文件或项目时按对应前缀清理。新 worker 成功发布重建代后清理上一代；崩溃中断可能遗留未引用代，文件彻底删除会清除完整前缀。数据库与私有对象需共同备份。

模型清单持久化预算 64 MiB，单 buffer 256 MiB，总产物 512 MiB；超过预算明确失败，不发布残缺结果。API 读取产物时走有界校验流，不将全部几何载入内存。测试及实际边界见 [持久化验证记录](../../docs/cad-platform-integration/PERSISTENCE_RESULTS.md)。

## 本地完整系统

无需先合入 main。`local-system.mjs` 直接运行当前分支的实际 `AppModule` 与完整前端，登录走本地 Casdoor 的 authorization code + PKCE；项目、任务、文件版本写入独立 PostgreSQL 18，文件经原有分片上传链路写入私有 MinIO。它不注册试用夹具的登录/导入接口，不连接公司数据。

复用已有 Node 24、PostgreSQL 18 Docker 镜像与单独启动的 CAD 沙箱。官方本地程序放在被忽略的 `server/cad-engine/.runtime/`：MinIO `RELEASE.2025-09-07T16-13-09Z` 的 macOS arm64 二进制保存为 `.runtime/minio`；Casdoor `v4.4.0` macOS arm64 发行包解压至 `.runtime/local-system/casdoor/`，保留 `casdoor`、`web/build` 与 `conf/`。下载后按官方 release 的 SHA-256 校验，不复制或重建 CAD native 环境。

在 `server/` 运行：

```sh
CAD_ENGINE_URL=http://127.0.0.1:9910 \
LOCAL_PG_IMAGE=your-existing-postgresql-18-image \
node scripts/local-system-prepare.mjs

LOCAL_SYSTEM_CONFIG="$PWD/cad-engine/.runtime/local-system/private.json" \
node scripts/local-system.mjs
```

打开 `http://localhost:3000`。准备脚本只创建专用 `libiaolink-local-pg` 容器、`libiaolink_local` 业务库、`casdoor_local` 登录库，执行已有迁移与基础字典/模板种子；不填充公司数据或 100 个演示项目。迁移角色与 API 角色分离；重复准备保留已有项目和文件。随机凭据与登录初始化数据只存于忽略目录且权限为 0600，不在控制台输出。

页面为完整项目系统；创建项目、添加任务后，从任务“文件”列上传 STEP。账号菜单的“文件库”能查询并预览同一文件。正常 OIDC 登录完成后，现有浏览器即可直接试用。本地 runner 另起独立 CAD 后台 worker 子进程；停止本地运行进程会关闭该 worker、前端、API、Casdoor、MinIO；PostgreSQL 专用容器保留数据，可单独停止 `libiaolink-local-pg`，重启时再次运行上述命令。

端口只绑定本机：前端 3000、API 3001、Casdoor 8000、MinIO 9000/9001、专用 PostgreSQL 5433。源码仅按需转译，保留 Nest 注入元数据，无需全量构建或静态检查。此启动方式服务于 STEP 的完整业务流程；Office 文档服务、外部翻译与通知通道未在这套本地环境配置。

实现依据：[Vite 开发服务与代理](https://vite.dev/config/server-options)、[Node 模块加载钩子](https://nodejs.org/docs/latest-v24.x/api/module.html#moduleregisterhooksoptions)、[Casdoor 本地运行](https://casdoor.org/docs/basic/server-installation/)与[初始化数据](https://casdoor.org/docs/deployment/data-initialization/)。

## 独立试用页面

在安装现有 server/frontend/shared Node 依赖后，在 `server` 执行。输入清单是本地 JSON 数组，每一项为 STEP 文件的绝对路径，不上传原文件到外部服务；清单不要提交到仓库：

```sh
CAD_SMOKE_INVENTORY=/path/to/local-step-inputs.json \
CAD_ENGINE_URL=http://127.0.0.1:9910 \
node scripts/cad-browser-smoke.mjs
```

打开 `http://127.0.0.1:3013/tools/cad-platform.html`，点击“导入 STEP 文件”选择本机非空 `.step` / `.stp`，单文件上限 64 MiB；下方保留输入清单的预置示例。该进程只监听 loopback；页面明确标识测试身份/文件记录/存储。使用实际守卫、PreviewReadService、CAD 控制器、native 转换和实际浮层，不依赖全量构建。

本地导入只注册于 browser 测试夹具，使用 Session/CSRF 守卫、已有有界读流、SHA-256 和临时文件版本记录；生产模块不包含这些登录/导入路由，也不写公司文件库。相同内容复用原路径，否则写入本地专用缓存，正常停止服务后仅删除本进程创建的导入副本，不删除用户原文件。导入件的下载来自浏览器持有的原 File，已比对 SHA；预置示例仍只验证下载回调。公司业务下载的权限链由既有下载服务测试覆盖，此页不能替代公司环境验收。

定向接口测试在 `server` 执行：

```sh
CAD_TEST_ENDPOINT=http://127.0.0.1:9910 CAD_TEST_CONTAINER=libiaolink-cad-cad-1 npm exec -- vitest run \
  --config test/cad.vitest.config.ts \
  test/cad-platform.test.ts test/preview-read.test.ts test/file-download.test.ts
```

没有设置 `CAD_TEST_ENDPOINT` 时 native 测试会跳过；跳过不算通过。原 stdio 的 52 项历史结果不代表沙箱验收；本轮证据见沙箱部署手册。

## 更新独立源码

```sh
python3 server/cad-engine/sync-source.py /path/to/CAD-source EXACT_COMMIT
```

从 LibiaoLink 根目录运行。只复制 Git 中固定提交的源码、schema、固定依赖清单与 Three.js MIT 许可证，生成 `source.json` 和 `cad-release.ts`；不复制样本、图像、运行环境或缓存。正式更新仍先在独立工程完成 CAD 规则修改与验证，随后同步整组文件。

## 部署边界

本次持久化与预解析尚未部署；既有 STEP 接入的部署状态见[接入基线](../../docs/CAD平台接入基线与迁移任务.md)。native runtime 已从 API 移到独立 glibc CAD 镜像，API 的 768 MiB 预算不包含 CAD；启用须叠加独立沙箱部署件并取得实际镜像 digest。API 无受限外的 Python 回退；测试与迁移见 [部署手册](../../deploy/cad/README.md)。

仅开放 STEP；外部引用、多文件资源解析、EASM/DXF 平台入口与工程测量不在本轮范围。S03 继续明确失败。大文件耗时沿用实测口径，P01 既有独立结果约 71.8 秒，不能称为秒开，本轮未重复测量它。
