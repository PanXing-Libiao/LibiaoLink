# CAD 独立沙箱

API → Unix socket → 独立 CAD 容器 → 固定 OCP/Gmsh。解析容器完全禁网，API 只传字节与来源摘要，不共享文件目录、业务凭据或 Docker socket。决策与三种方案比较见 [ADR-036](../../docs/adr/ADR-036-CAD解析沙箱与资源硬限额.md)。

ADR-037 增加上传静默预解析与持久产物：平台 worker 通过同一 socket 提交，数据库保存队列/索引，私有对象存储保存完整模型。持久发布后回收没有其他窗口/alias 使用的自有临时任务，避免上传积累填满 tmpfs；沙箱不获得存储凭据或持久目录，原硬限额不变；验证见[持久化记录](../../docs/cad-platform-integration/PERSISTENCE_RESULTS.md)。

## 限额

| 项目 | 强制方式 / 上限 |
| --- | --- |
| 内存、交换空间 | cgroup：3 GiB；不允许 swap |
| CPU | cgroup：整个容器最多 1 核配额 |
| 进程/线程 | cgroup：整个容器最多 64 |
| 单文件、FD、core | rlimit：256 MiB、128、0 |
| 转换数据、临时目录、通信目录、共享内存 | 限容 tmpfs：1536 MiB、384 MiB、1 MiB、8 MiB |
| 输入、队列、转换 | 单文件默认 64 MiB（显式最大 256）、并发 1、排队 8、worker 600 秒、排队 900 秒 |

tmpfs 用量计入同一容器的内存预算，各项上限不能理解为可同时全部占满的额外容量。RSS 2 GiB 采样停止阈值仍保留作为提前止损；内核 memory.max 覆盖所有解析后代，不依赖该采样。另有 PID 1 watchdog，在主 worker 超过约 605 秒仍未退出时退出整个 PID namespace；对主 worker 结束后残留、脱离进程组的孤儿进程，PID 1 检测后终止整个 namespace 并回收孤儿僵尸。无活动的非 loopback 链路和出站路由；运行身份 1000:1000、根目录只读、capabilities 全部丢弃、禁止提权、默认 seccomp。服务启动检查实际 cgroup v2、挂载和进程状态，缺项拒绝运行；禁止用不受限 Python 替代。

原生包保持固定版本，OCP 与 Gmsh 安装在不同 Python 环境，不改 CAD core/source.json。固定 OCP/Gmsh 的 Linux wheel 为 x86_64，因此当前镜像明确使用 linux/amd64；arm64 Docker Desktop 通过已有仿真运行，不能将该耗时当作公司 x86 服务器性能。OCP 的 vtk 依赖通过既有 cadquery-vtk 分发提供；使用 --no-deps 避免混装没有 cp313 wheel 的 vtk==9.3.1。镜像构建必须实际验证两套 native import。

## 本地运行

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

在 server/ 运行（下例使用本地 Compose 默认容器名；自定义项目名时同步调整）：

```sh
CAD_TEST_ENDPOINT=http://127.0.0.1:9910 CAD_TEST_CONTAINER=libiaolink-cad-cad-1 \
  npm exec -- vitest run --config test/cad.vitest.config.ts \
  test/cad-engine-client.test.ts test/cad-platform.test.ts test/preview-read.test.ts test/file-download.test.ts

CAD_TEST_ENDPOINT=http://127.0.0.1:9910 CAD_TEST_CONTAINER=libiaolink-cad-cad-1 \
  python3 test/cad-sandbox.test.py
```

第一组使用真实沙箱解析受控 STEP，检查权限、SHA、清单/资源、缓存、取消和 API 重连；未设置 CAD_TEST_ENDPOINT 时 native 组跳过，不能算通过。第二组仅针对本机独立 CAD，验证内核限额、禁网、只读根目录、缺限额拒绝启动、独立 OOM 探针和 namespace watchdog；会创建并删除 libiaolink-cad-probe-* 临时容器，不能指向公司环境。

2026-10-21 本地最终验证：69 项接口/真实 STEP 测试与 9 项容器探针全部通过；OCP wheel 完整性和两套 native 导入通过，生产 Compose 合并配置已核对。完整证据、已修复的磁盘/镜像故障及实际边界见 [本地验证记录](../../docs/cad-platform-integration/SANDBOX_RESULTS.md)。未运行全量构建或静态测试，公司测试环境本轮尚未部署。
