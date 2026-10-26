# Windows 本地开发环境（WSL2 + Docker Engine）

> 生效日期：2026-10-26。公司不允许使用 Docker Desktop；Windows 开发机统一采用 **WSL2 + Ubuntu + 原生 Docker Engine（docker-ce）**。本文是 Windows 环境的唯一安装与排障口径；其他文档中的 Docker 命令在 Windows 开发机上一律在 WSL Ubuntu 终端执行。
>
> 历史实测记录中出现的 Docker Desktop 仅说明当时的执行环境，不改写为其他运行方式；新环境和新增记录一律使用本文方案。

## 一、边界与原则

- Windows 上只安装和使用 WSL2 中的 Linux Docker Engine，不安装、不启动 Docker Desktop。
- 容器、Compose、Node、npm、迁移和回放命令全部在 WSL Ubuntu 内执行；Windows 只负责浏览器、IDE 和 SSH。
- 不在 Windows PowerShell 中调用 `docker.exe` 或 `docker compose`。PowerShell 只用来安装 / 管理 WSL。
- WSL2 x86_64 原生运行 `linux/amd64` 镜像，不需要 Docker Desktop 的跨平台集成。
- Docker socket 等同 root 权限。不要把 `/var/run/docker.sock` 挂给业务容器，也不要提交任何本地凭据。

## 二、安装 WSL2 与 Ubuntu

在 **Windows PowerShell（管理员）** 中执行：

```powershell
wsl --install -d Ubuntu-26.04
wsl --set-default-version 2
wsl --update
```

若提示重启 Windows，先重启再继续。首次启动 Ubuntu 时设置 Linux 用户名和口令。若机器已有 Ubuntu，改用 `wsl -l -v` 查看实际发行版名称，再将它设为默认：

```powershell
wsl -l -v
wsl --set-default Ubuntu-26.04
```

版本列必须是 `2`。示例使用 Ubuntu 26.04 LTS，与公司测试机同版；Docker 官方 apt 源已提供该版本对应的 `resolute` 仓库。

### 启用 systemd

在 Ubuntu 终端执行：

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

回到 PowerShell 完整重启 WSL，然后重新打开 Ubuntu：

```powershell
wsl --shutdown
```

确认 PID 1 是 systemd：

```bash
ps -p 1 -o comm=
# 应输出 systemd
```

## 三、在 Ubuntu 内安装 docker-ce

使用 Docker 官方 apt 源安装 Engine、Buildx 和 Compose 插件：

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
```

`docker` 组等价于 root 权限，仅用于受控的开发机。让用户组生效：退出并重开 Ubuntu 终端，或执行 `newgrp docker`。然后验收：

```bash
docker version
docker compose version
docker info --format 'Cgroup={{.CgroupVersion}} Driver={{.Driver}} Arch={{.Architecture}}'
docker run --rm hello-world
```

`docker version` 的 Server 端必须来自 Ubuntu 内的 Linux daemon；`Cgroup` 应为 `2`。若命令不存在，先确认当前终端确实是 Ubuntu，而不是 PowerShell。

### Node 24

仓库的 server / frontend / shared 需要 Node 24。仍在 Ubuntu 内执行：

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # 应为 v24.x
npm --version
```

## 四、将仓库放在 WSL 文件系统

推荐把工作副本放在 WSL 的 ext4 文件系统，而不是 `/mnt/d`。这样 Docker 构建上下文、bind mount、文件权限和热更新都与 Linux 服务器一致，性能也明显更好。

```bash
cd ~
git clone https://github.com/PanXing-Libiao/LibiaoLink.git
cd LibiaoLink
```

Windows 侧可通过 `\\wsl.localhost\Ubuntu-26.04\home\<Linux用户名>\LibiaoLink` 访问；进入该目录也可用：

```powershell
wsl -d Ubuntu-26.04 --cd '~/LibiaoLink'
```

已有 `D:\LibiaoLink` 可以临时这样进入：

```bash
cd /mnt/d/LibiaoLink
```

但 `/mnt/d` 下的 bind mount 可能遇到权限映射和性能问题，不作为长期开发目录。迁移时先确认 WSL 工作副本的当前分支与未提交改动，再切换。

## 五、清理 Docker Desktop 残留

完成上述安装后，在 Ubuntu 中确认没有连到 Desktop 的 context 或命名管道：

```bash
which docker                  # 应为 /usr/bin/docker
dpkg -S "$(command -v docker)" # 应显示 docker-ce-cli 包
echo "${DOCKER_HOST:-}"       # 应为空
docker context use default
docker context show            # 应为 default
docker context ls
```

`docker context ls` 的当前项应为 `default`。若看到 `desktop-linux`、`npipe` 或 `DOCKER_HOST` 指向 Docker Desktop，先切回默认 context 并清除当前 shell 中的 `DOCKER_HOST`。

Docker Desktop 的卸载由 IT / 管理员按公司软件流程处理。卸载前确认默认 WSL 发行版是 Ubuntu，而不是 Docker Desktop 自带的 `docker-desktop`：

```powershell
wsl --set-default Ubuntu-26.04
```

本文不自动卸载软件，也不删除 WSL 发行版或数据卷。

## 六、项目内启动方式

以下命令均在 Ubuntu 终端的仓库根目录执行。Windows 浏览器继续访问 `http://localhost:3000`、`http://localhost:8000` 等 loopback 地址；WSL2 会把本机回环端口转发到 Windows。

本地 Casdoor 沙箱：

```bash
cd ~/LibiaoLink/deploy/casdoor
cp .env.example .env
# 按 .env.example 的变量名填写本地配置；不要提交 .env
docker compose up -d
docker compose ps
```

CAD 独立沙箱与开发中继：

```bash
cd ~/LibiaoLink
docker build --platform linux/amd64 -f deploy/cad/Dockerfile -t libiaolink/cad-sandbox:1.0.1 .
docker compose -f deploy/cad/docker-compose.yml --profile dev up -d
```

开发 API 仍配置 `CAD_ENGINE_URL=http://127.0.0.1:9910`；生产容器直接挂载 Unix socket，不使用中继。完整 STEP 流程见 [本地完整系统说明](../server/cad-engine/README.md#本地完整系统)。

原生 Docker 不会像 Docker Desktop 那样自动提供 `host.docker.internal`。本仓库 `deploy/onlyoffice/docker-compose.yml` 已用 `host.docker.internal:host-gateway` 显式映射；若自建容器需要回调宿主 API，也要加同一映射，并确认 API 监听非 loopback 地址（`npm run start:api` 默认满足，`local-system` 的 loopback 模式不配置 Office）。

## 七、常见问题

| 现象 | 排查 |
|---|---|
| `docker: command not found` | 当前是 PowerShell 或旧 shell；打开 Ubuntu 终端，必要时重开 WSL |
| `Cannot connect to the Docker daemon` | 执行 `systemctl status docker`；没有 systemd 时回查 `/etc/wsl.conf`，然后 `wsl --shutdown` 重启 |
| `permission denied ... docker.sock` | 执行 `sudo usermod -aG docker "$USER"` 后退出并重开 Ubuntu，或 `newgrp docker` |
| 报 `npipe://` / `desktop-linux` | 仍在使用 Docker Desktop context；`docker context use default`，确认 `DOCKER_HOST` 为空 |
| 构建或挂载报 UID / 权限错误 | 工作副本仍位于 `/mnt/d`；按第四节迁移到 WSL ext4 |
| 端口被占用 | 在 WSL 中执行 `ss -ltnp | grep -E '3000|3001|5433|8000|9000|9001|9910'`，先停冲突服务 |
| WSL 重启后 Docker 未启动 | `sudo systemctl enable --now docker`；确认 `/etc/wsl.conf` 的 `systemd=true` 仍存在 |
| Windows 浏览器打不开 localhost | 确认服务绑定 `127.0.0.1` / `localhost` 且运行在 WSL；先用 `curl` 在 WSL 内验证，再检查 Windows 代理或端口转发 |

## 八、交付前检查

- [ ] `wsl -l -v` 中 Ubuntu 为 `VERSION 2`，且默认发行版不是 `docker-desktop`
- [ ] Ubuntu 内 `ps -p 1 -o comm=` 输出 `systemd`
- [ ] `which docker` 为 `/usr/bin/docker` 且 `dpkg -S` 显示 `docker-ce-cli`；`DOCKER_HOST` 为空，context 为 `default`
- [ ] `docker compose version` 可用，`docker info` 显示 cgroup v2
- [ ] `docker run --rm hello-world` 通过
- [ ] `node --version` 为 `v24.x`，`npm --version` 可用
- [ ] 仓库位于 WSL ext4，不依赖 `/mnt/d` 做长期构建
- [ ] 所有 Docker / npm / 迁移命令均在 WSL Ubuntu 内执行
