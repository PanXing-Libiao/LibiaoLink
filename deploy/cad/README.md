# CAD 独立沙箱

> **本地 Linux 接线修复（2026-10-31，未部署）**：镜像现在构建固定 ACadSharp 3.8.30 读取器并携带 .NET 10.0.14，DXF/DWG 共用已安装并校验的 Python 显示依赖。DXF 的 DWG 外参只使用 `CAD_DXF_DWG_READER=/opt/dwg/bin/dwgread`，原生 DWG 使用 `CAD_DWG_READER=/opt/dwg-native/LibiaoLink.DwgReader.dll` 与 `CAD_DWG_DOTNET=/opt/dotnet/dotnet`，不再共用同一读取器变量。容器仍为 3 GiB / 1 CPU / 64 PIDs / 禁网；STEP、DXF 的任务进程树 RSS 阈值为 2 GiB，DWG 为 2.5 GiB，容器 memory.current 达 2.75 GiB 提前终止当前 worker。临时文件位于受限数据 tmpfs，每任务 scratch 512 MiB；单文件硬上限与最大 DWG 产物预算统一为 512 MiB。内存采样含原生后代；这些限额不是任意图纸可成功的承诺。验证结论以本机真实图与隔离探针结果为准，不等于公司环境验收。



> 二维 DXF 接入需先停止旧 API/worker，再应用迁移 `0077_cad_dxf_input_sets.sql`、`0078_cad_format_version.sql` 与 `0079_cad_dwg_format.sql`，再用当前源码构建 CAD 镜像，并与 API/worker 同步更新。`0069` 按 ADR-041 把产物缓存键拆为格式独立的 `format_version`；旧产物首次访问重建一次。镜像新增独立 `/opt/dxf`，正常构建并验证仓内 ezdxf fork；DXF v0.10.0 的 DWG 外参还需 `/opt/dwg/bin/dwgread`（固定 LibreDWG 0.13.3），由独立构建阶段校验源码并编译，运行层携带许可、对应源码与构建脚本。当前镜像已携带原生 DWG 的 ACadSharp 读取器 DLL、.NET 运行时，Python 依赖复用 `/opt/dxf`，通过 `CAD_DWG_PYTHON`、`CAD_DWG_READER`、`CAD_DWG_DOTNET` 配置；API 的 `CAD_DWG_ENABLED` 默认关闭，仍需目标环境启用和验收。原有 `3 GiB / 1 CPU / 64 pids / 禁网` 边界保持，DWG 任务预算为 2.5 GiB 进程树 RSS / 512 MiB 产物。DXF 的 `partial` 是带缺失说明的有效部分产物，STEP 仍须 `completed`；旧镜像不能只靠新 API 打开 DXF。当前仅完成本机验证，未发布到公司测试机或生产。

API → Unix socket → 独立 CAD 容器 → 固定 OCP/Gmsh。解析容器完全禁网，API 只传字节与来源摘要，不共享文件目录、业务凭据或 Docker socket。决策与三种方案比较见 [ADR-036](../../docs/adr/ADR-036-CAD解析沙箱与资源硬限额.md)。

ADR-037 增加上传静默预解析与持久产物：平台 worker 通过同一 socket 提交，数据库保存队列/索引，私有对象存储保存完整模型。持久发布后回收没有其他窗口/alias 使用的自有临时任务，避免上传积累填满 tmpfs；沙箱不获得存储凭据或持久目录，原硬限额不变；验证见[持久化记录](../../docs/cad-platform-integration/PERSISTENCE_RESULTS.md)。

## 限额

| 项目 | 强制方式 / 上限 |
| --- | --- |
| 内存、交换空间 | cgroup：3 GiB；不允许 swap |
| CPU | cgroup：整个容器最多 1 核配额 |
| 进程/线程 | cgroup：整个容器最多 64 |
| 单文件、FD、core | rlimit：512 MiB、128、0 |
| 转换数据、临时目录、通信目录、共享内存 | 限容 tmpfs：1536 MiB、384 MiB、1 MiB、8 MiB |
| 输入、队列、转换 | 单文件默认 64 MiB（显式最大 256）、并发 1、活动任务合计 8（包含运行中）、STEP/DWG worker 600 秒、DXF worker 60 秒、排队 900 秒 |

tmpfs 用量计入同一容器的内存预算，各项上限不能理解为可同时全部占满的额外容量。STEP/DXF 进程树 RSS 2 GiB、DWG 2.5 GiB 采样停止阈值作为提前止损；容器总占用超过 2.75 GiB 时停止当前 worker，给主服务留出余量；内核 memory.max 覆盖所有解析后代，不依赖该采样。另有 PID 1 watchdog，在主 worker 超过约 605 秒仍未退出时退出整个 PID namespace；对主 worker 结束后残留、脱离进程组的孤儿进程，PID 1 检测后终止整个 namespace 并回收孤儿僵尸。无活动的非 loopback 链路和出站路由；运行身份 1000:1000、根目录只读、capabilities 全部丢弃、禁止提权、默认 seccomp。服务启动检查实际 cgroup v2、挂载和进程状态，缺项拒绝运行；禁止用不受限 Python 替代。

原生包保持固定版本，OCP 与 Gmsh 安装在不同 Python 环境，发布身份由 CAD core/source.json 与 API 常量同步生成。固定 OCP/Gmsh 的 Linux wheel 为 x86_64，因此当前镜像明确使用 linux/amd64；arm64 开发机通过已有仿真运行，不能将该耗时当作公司 x86 服务器性能。OCP 的 vtk 依赖通过既有 cadquery-vtk 分发提供；使用 --no-deps 避免混装没有 cp313 wheel 的 vtk==9.3.1。镜像构建必须实际验证两套 native import。

## 本地运行

### Windows 开发机（WSL2）

公司不允许 Docker Desktop。Windows 必须先按 [Windows 本地开发环境](../../docs/本地开发环境(Windows-WSL2-Docker).md) 安装 WSL2 Ubuntu 与原生 Docker Engine；仓库放在 WSL 文件系统，以下命令全部在该 Ubuntu 终端执行，PowerShell 不参与 Docker 操作。WSL2 x86_64 原生运行本镜像的 linux/amd64，不经过 Desktop 的跨平台层。

从仓库根目录运行，仅构建 CAD 镜像：

```sh
docker build --platform linux/amd64 -f deploy/cad/Dockerfile -t libiaolink/cad-sandbox:1.0.1 .
docker compose -f deploy/cad/docker-compose.yml --profile dev up -d
```

开发 API 配置 CAD_ENGINE_URL=http://127.0.0.1:9910。该端口来自单独的无状态中继，仅绑定宿主 loopback；中继只持有 CAD socket 的只读挂载，不加载 native 解析器。CAD 解析容器仍为 network_mode=none。Linux 容器内的 API 应直接使用 Unix socket，不启用中继。

本地停止：docker compose -f deploy/cad/docker-compose.yml --profile dev down。只处理本项目的 CAD/中继，不影响数据库或其他服务。

## 生产接入与迁移

1. 原来的 CAD_ENGINE_PYTHON、CAD_MESHER_PYTHON、CAD_CACHE_DIR 从 API 配置移除。仅保留旧 Python 参数不会开放 STEP；未配置沙箱的环境继续提示并保留下载。
2. 在构建/发布环境生成并评审镜像，发布后取得真实 digest，设置 CAD_SANDBOX_IMAGE 为 tag@sha256:digest。不得用本地 image ID 冒充 registry manifest digest，也不允许浮动镜像代替。
3. 先由现有迁移器执行新增 `0064_cad_artifacts.sql`，再同步同版 API / worker。使用 deploy/prod/docker-compose.cad.yml 叠加现有部署件，为 API 与 worker 增加 CAD socket 的只读挂载和健康依赖，不改服务器业务代码。执行前按仓库流程经常驻分支、PR、非作者评审。

```sh
docker compose -f deploy/prod/docker-compose.yml -f deploy/prod/docker-compose.cad.yml --profile app up -d cad api worker
```

该覆盖文件不允许现场 build；使用支持 !reset 的 Compose（本地验证版本 v5.1.4）。API 生产配置只接受 CAD_ENGINE_SOCKET=/run/cad/engine.sock；CAD_ENGINE_URL 在 production 中直接报配置错误。CAD 容器没有 server.env/secrets、源文件目录或公司网络。API 的现有 768 MiB 预算与 CAD 的 3 GiB 独立计量；部署前确认测试机总预算可容纳其他服务。cgroup v1 或资源控制器未启用时，CAD 拒绝启动。

沙箱内部缓存仍使用限容 tmpfs，重启会清除；平台已完成的持久产物不依赖它。上传提交事务只登记 GB 后台任务，worker 独立轮询，不与通知 outbox 串行等待 native；关闭预览仅取消当前窗口。成功产物跨 API/worker/CAD 重启复用，无需 native 重算；新文件版本/引擎/编码或损坏时重建。对象与数据库需一并备份，彻底删除文件或项目会清理 CAD 前缀。迁移与生命周期见 [ADR-037](../../docs/adr/ADR-037-CAD产物持久化与上传预解析.md)。

## 定向验收

2026-10-31 本地 Linux 验证：固定依赖的 CAD 镜像构建及原生导入成功；9 项实际容器隔离探针、38 项字体/布局/外参回归通过。真实 DXF/DWG 均经隔离服务完成转换；同输入及字体的 DXF 旧新画面对比一致。已验证损坏输入、摘要不匹配、路径越界、跨 namespace 读取、队列饱和、取消和降低预算后的真实 DWG 内存止损；失败后可继续处理有效 DXF。原字体处理和混合绘制未修改，DWG 仍明确为 partial。私有图纸、性能数字和截图仅保留本机，不属于部署验收；本次未部署。


在 server/ 运行（下例使用本地 Compose 默认容器名；自定义项目名时同步调整）：

```sh
CAD_TEST_ENDPOINT=http://127.0.0.1:9910 CAD_TEST_CONTAINER=libiaolink-cad-cad-1 \
  npm exec -- vitest run --config test/cad.vitest.config.ts \
  test/cad-engine-client.test.ts test/cad-platform.test.ts test/preview-read.test.ts test/file-download.test.ts

CAD_TEST_ENDPOINT=http://127.0.0.1:9910 CAD_TEST_CONTAINER=libiaolink-cad-cad-1 \
  python3 test/cad-sandbox.test.py
```

第一组使用真实沙箱解析受控 STEP，检查权限、SHA、清单/资源、缓存、取消和 API 重连；未设置 CAD_TEST_ENDPOINT 时 native 组跳过，不能算通过。第二组仅针对本机独立 CAD，验证内核限额、禁网、只读根目录、缺限额拒绝启动、独立 OOM 探针和 namespace watchdog；会创建并删除 libiaolink-cad-probe-* 临时容器，不能指向公司环境。

2026-10-21 本地最终验证：69 项接口/真实 STEP 测试与 9 项容器探针全部通过；OCP wheel 完整性和两套 native 导入通过，生产 Compose 合并配置已核对。完整证据、已修复的磁盘/镜像故障及实际边界见 [本地验证记录](../../docs/cad-platform-integration/SANDBOX_RESULTS.md)。

2026-10-26 正式生产接线：`https://pm.libiaorobot.com` 已存在上述 CAD 镜像与 `0064` 迁移，但 API/worker 未加载 overlay、`CAD_ENGINE_SOCKET` 为空，预览降级为 `cadPending`。未改源码 / 镜像 / DDL，备份配置和数据库后以 `docker-compose.cad.yml` 强制重建 API/worker，只读 socket 接入 `/run/cad/engine.sock`；七个容器 healthy，真实账号 Chrome 打开 STEP 首帧 `data-cad-ready-ms=2977`、零件 64 项、console error 0。完整发布、备份与回滚见 [deploy/prod/README.md](../prod/README.md) 顶部记录。

**2026-10-28 正式生产复现与修复（强制门禁）**：移动端预览修复发布时，`api/worker` 再次仅以基础 compose 重建，overlay 丢失后 `CAD_ENGINE_SOCKET` 为空且 `cad_socket` 未挂载，真实 `.STEP` 返回「CAD 在线预览正在升级」。以 `docker-compose.yml + docker-compose.cad.yml` 重建后 socket 恢复；该文件已有 `completed` 持久产物（25,132,925 B），无需重算。**正式机以后任何 api / worker 重建都必须叠加本 overlay**，并用 `docker exec <container> printenv CAD_ENGINE_SOCKET`、只读 `/run/cad` 挂载检查与 socket `/healthz` 三检收口；仅看容器 healthy 不够。

2026-10-23 公司测试机部署：`main` 代码基线 `c18b417e`（PR [#553](https://github.com/PanXing-Libiao/LibiaoLink/pull/553) / [#555](https://github.com/PanXing-Libiao/LibiaoLink/pull/555) / [#557](https://github.com/PanXing-Libiao/LibiaoLink/pull/557)）已部署到 `test-pm.libiaorobot.com`；当时生产未部署。镜像 `libiaolink/cad-sandbox:1.0.1-c18b417e@sha256:aeee8b4b072eca1aaf0b2db0d65b972f341e3da07a413aaec07d259d03a9879c`（linux/amd64，服务器解压后 1,437,769,016 B），发布件 `/srv/data/deploy-cad-c18b-20261023-0943/cad-sandbox-1.0.1-c18b417e.tar`（330,915,328 B · SHA-256 `3d3c64a61ddb4379e5c0dc592087f18e23ca158ad3d0756fac23909e4b6eb333`）。`api`、`worker`、`cad`、`web`、`postgres`、`minio`、`svg-preview` 七容器 healthy；数据库迁移 `0064_cad_artifacts.sql` 已登记（71 ms），`cad_artifacts` / `cad_views` 表存在。

运行容器实测 `memory=3 GiB`、`memory.swap.max=0`、`nanoCpus=1`、`pids=64`、`network=none`、根目录只读、capabilities 全部丢弃、用户 `1000:1000`；`/tmp` 384 MiB、`/var/lib/cad` 1536 MiB、`/run/cad` 1 MiB 均为限容 tmpfs。引擎版本 `step-0.3.3/f103d1c40812b24c3864ae90a91ea707f734dfb5/gateway-1` 与 API 一致；受控箱体 UTF8 / GB 冒烟均 `completed`，另从对象存储读取真实 `限流环.STEP`（315,166 B · SHA-256 `36866774a174db2d3dc0de800f3b1b74f0c083bfb18fbe08674521d02550c228`）完成转换，manifest 37,303 B、完整性 `complete`、worker 峰值 RSS 333,180,928 B；第二次同源提交 `reused=true` 且任务 ID 相同。

公网站点、`/healthz`、`/readyz`、`/cad-viewer/platform-entry.js` 均 200，缺失查看器资源 404；API / worker / CAD 近 20 分钟无 `ERROR` / `FATAL` / `Unhandled` / 模块加载错误。真实公司账号的浏览器打开、首帧、产品树、拾取、显隐/隔离/恢复仍未验收；上传预解析、持久产物与鉴权资源链路的认证后业务走查待补。部署与回滚证据见 [deploy/prod/README.md](../prod/README.md)。
