# ADR-036 CAD 解析沙箱与资源硬限额

- 日期：2026-10-21。
- 状态：用户已授权实现；公司环境发布、非作者评审和现场验收仍待完成。
- 主责：wmj（CAD）；px 协办部署评审，lan 协办共享 file/preview 边界。
- 补充 ADR-035 的宿主运行方式；固定 CAD 源码、几何规则与公开 CAD API 不变。

## 问题与调研

API 内启动 stdio Python 只隔离协议和显式传入的环境变量。同一容器内的 native 解析仍能访问 API 的运行边界；RSS 轮询无法阻止瞬时内存分配，也不覆盖完整进程树。

| 方案 | 判断 |
| --- | --- |
| 独立 Docker 容器 + cgroup v2 + Unix socket | 采用。适配现有 Compose；内核限制整个容器，API 无需 Docker 权限；解析容器可完全断网 |
| systemd 独立用户服务 + MemoryMax/TasksMax/CPUQuota | 可行，但当前 API 使用 Compose，新增宿主服务、文件权限和部署管理路径；不作为本次默认方案 |
| gVisor/runsc | 可进一步缩小宿主内核暴露面，但需要额外 runtime 安装及固定 OCP/Gmsh 兼容性、性能验证；本次不声称已验证 |

官方依据：[Compose 服务配置](https://docs.docker.com/reference/compose-file/services/)、[Docker 硬内存/CPU 限制](https://docs.docker.com/engine/containers/resource_constraints/)、[none 网络](https://docs.docker.com/engine/network/drivers/none/)、[cgroup v2 继承与控制器](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html)、[systemd 资源控制](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html)、[gVisor 安全模型](https://gvisor.dev/docs/architecture_guide/security/)。

## 决定与信任边界

1. API 只负责现有会话/CSRF、文件版本权限、来源 SHA/bytes 校验。通过 Unix HTTP socket 传原始文件字节和限定元数据；返回 JSON 或有大小上限的产物流。不传本机文件路径、数据库/S3 凭据、源对象 URL，不将 CAD 返回值用作 API 本地路径。
2. CAD 使用独立 PID/网络/挂载命名空间，UID/GID 1000、只读 rootfs、cap_drop ALL、no-new-privileges 和 Docker 默认 seccomp。network_mode=none，仅挂独立限容通信卷；不挂载仓库、业务目录、secrets 或 Docker socket。
3. 3 GiB memory.max、1 核 cpu.max、64 pids.max 覆盖 gateway、OCP、Gmsh 及后代；memory.swap.max=0。RLIMIT_FSIZE=256 MiB、RLIMIT_NOFILE=128、RLIMIT_CORE=0。转换存储 tmpfs 1536 MiB，临时目录 384 MiB，通信卷 1 MiB，共享内存 8 MiB；文件空间不依赖 Python 累加配额保证。
4. 服务启动读取 /proc 与 /sys/fs/cgroup，校验 PID 1、非 root、capabilities、seccomp、NoNewPrivs、禁网、只读根目录、限容 tmpfs、内核 CPU/内存/进程数、交换空间及 rlimit。缺失或不支持时拒绝启动。没有 API 内 Python 或不受限本地进程回退。
5. 保留原任务并发 1、排队 8、worker 600 秒、排队 900 秒、RSS 采样和取消。PID 1 中另有独立 watchdog：主 worker 超过约 605 秒仍未退出时终止整个 CAD PID namespace，内核清除包括变更进程组的后代，容器按策略重启。PID 1 同时监测主 worker 结束后被收养的残留子进程，持续约 2 秒仍存活时终止整个 namespace，并回收孤儿僵尸，避免脱离进程组后逃过取消/超时清理。600 秒应用层超时与 cgroup 硬限额分别描述，不把轮询称为硬限额。

PID namespace init 退出会导致内核杀死该 namespace 全部进程，参见 [Linux pid_namespaces](https://man7.org/linux/man-pages/man7/pid_namespaces.7.html)。

## 缓存与兼容性

公开 CAD 路径、权限、lease、名称码页和几何接收规则保持原义。旧 CAD_ENGINE_PYTHON/CAD_MESHER_PYTHON/CAD_CACHE_DIR 不再启用 API 内解析；生产改配 CAD_ENGINE_SOCKET。开发的 CAD_ENGINE_URL 只允许 127.0.0.1 中继，生产拒绝该配置。

限容 tmpfs 不保存跨 CAD 容器重启的任务/产物：容器重启或重建后，旧 job/lease 失效，重新打开或提交重新转换；原平台文件不受影响。仅 API 重启、重连不清除 CAD 容器中的任务与缓存。原 24 小时保留期是存活容器内的最大缓存窗口，不是重启持久性保证。若需要持久化，必须另行设计带文件系统硬配额的专用存储，不能直接换成无限制宿主目录。

运行、迁移和定向验收见 [部署手册](../../deploy/cad/README.md)。本机实际执行的验证与限制写入该手册；历史本地 stdio 测试结果不冒充本次隔离验收。
