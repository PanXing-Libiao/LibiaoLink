# CAD 沙箱本地验证记录

日期：2026-10-21。本地验证基线为 codex/cad-integration-prep 的 8d6aaf5；交付转入常驻分支 wmj，推送记录见[开发日志](../../开发日志.md) Push 291。本次隔离修复尚未部署公司测试机，既有 STEP 接入的部署记录保留。决策见 [ADR-036](../adr/ADR-036-CAD解析沙箱与资源硬限额.md)，运行方式见 [部署手册](../../deploy/cad/README.md)。

## 环境与固定输入

- macOS arm64，Docker Engine 29.5.3，Compose v5.1.4，Linux cgroup v2；CAD 镜像使用 linux/amd64 仿真。
- Python 3.13.13；固定 cadquery-ocp 7.8.1.1 / cadquery-vtk 9.3.1，独立 Gmsh 4.15.2 / NumPy 2.5.4。没有升级 CAD core/source.json 的固定源码和几何规则。
- 受控工程夹具：server/test/fixtures/cad/controlled-box.step，15,416 bytes，SHA-256 999db9efebc076bf2528db1860b6bf50f63600f1e953f115743d38d22826c157。测试只读该夹具和替代业务记录/存储，不接触公司数据。
- 服务实际报告：memory.max=3221225472，cpu.max=100000/100000，pids.max=64，memory.swap.max=0，RLIMIT_FSIZE=268435456；数据 tmpfs 1610612736 bytes。只读 rootfs、UID 1000、capabilities 全部丢弃、NoNewPrivs 和 seccomp 均通过启动校验。

## 已通过

在 server/ 执行：

```sh
CAD_TEST_ENDPOINT=http://127.0.0.1:9910 CAD_TEST_CONTAINER=libiaolink-cad-cad-1 \
  npm exec -- vitest run --config test/cad.vitest.config.ts \
  test/cad-engine-client.test.ts test/cad-platform.test.ts test/preview-read.test.ts test/file-download.test.ts

CAD_TEST_ENDPOINT=http://127.0.0.1:9910 CAD_TEST_CONTAINER=libiaolink-cad-cad-1 \
  python3 test/cad-sandbox.test.py
```

| 验证 | 结果 | 覆盖 |
| --- | --- | --- |
| 定向接口与真实转换 | 4 文件、69 项通过，约 29.21 秒 | 生产 Unix socket 客户端；旧 Python 配置不能开启解析；生产拒绝 TCP；字节传输；有界响应；断连恢复；实际 STEP→任务→manifest/buffers；权限/CSRF、SHA、名称码页、缓存损坏重算、窗口 lease、取消、API 重连 |
| CAD 故障恢复 | 包含在上述 69 项内 | CAD 停止时普通预览 API 仍响应，CAD 请求返回受控 503；CAD 重启后旧 job 返回 404，重新提交可完成转换 |
| 内核限额探针 | 9 项通过，约 11.85 秒 | CPU 配额产生实际节流；PID 上限拒绝继续派生；单文件超限 EFBIG；tmpfs 总量超限 ENOSPC；独立探针容器实际 OOM/退出 137，同时 CAD 服务保持可用；禁网；只读 rootfs；缺少限制拒绝启动 |
| 超时/取消后的进程清理 | 包含在上述 9 项内 | watchdog 到期导致 PID namespace 退出 124；父进程退出后，另起进程组的孤儿子进程也触发整个 namespace 清理 |
| 原生库完整性 | 通过 | OCP 动态库 SHA 与 wheel RECORD 一致；OCP.STEPCAFControl 和独立 Gmsh 均实际导入成功 |
| 生产 Compose 合并 | 通过 | 使用 --no-env-resolution / --no-interpolate 核对，无需读取 server.env/secrets；CAD 独立限额、禁网、无现场 build，API 仅只读挂载通信目录 |
| 契约同步 | 已执行 npm run generate | 仅同步 CadJob 的缓存保留说明，公开字段与 URL 未变 |

CPU、OOM、PID、文件和 tmpfs 探针均有上限，只创建并删除本轮 libiaolink-cad-probe-* 临时容器；没有向公司测试机施压。

交付前常驻分支同步 main `7b101fc`，上述四文件接口回归再次 69 项通过，22.57 秒；资源限额、namespace 清理及探针代码与此前 9 项实测版本一致。文档保留 main 中既有 STEP 接入的测试机部署记录，本次隔离修复尚未部署。

## 调试发现与边界

最初构建后本机磁盘耗尽，Docker 解包出现 I/O 错误。恢复空间后，旧镜像的 OCP 动态库 SHA 与 wheel RECORD 不符，实际导入触发 SIGBUS，导致一轮 native 测试失败。随后绕过 native 构建缓存、重新下载相同固定版本依赖；完整性和导入恢复正常，上述最终两组测试均在修复后的镜像完成。失败没有记作通过。

Docker 内核在 network_mode=none 下仍枚举 DOWN 状态的隧道设备。因此校验实际活动链路、路由、capabilities 和出站连接行为，不单凭接口数量；不能启用任何非 loopback 链路。

缓存位于限容 tmpfs：API 重连保留，CAD 容器重启/重建后 job/lease 失效，原文件仍在平台对象存储中，重新打开重新提交。不将 24 小时保留期描述为跨容器持久化。

未执行全量构建、typecheck、lint 或全仓审计；只构建 CAD 专用镜像、生成受影响契约说明并运行上述定向测试。未重跑独立 CAD 全样本能力矩阵，不据此承诺任意 STEP 成功率或大文件耗时。公司环境部署、真实镜像发布 digest、非作者评审及现场验收仍待按仓库流程完成。
