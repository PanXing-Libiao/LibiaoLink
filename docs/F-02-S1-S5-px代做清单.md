# F-02 S1～S5 px 代做清单

> 执行人：px（在其工作机通过 SSH 访问测试机）｜交接：lan｜基线：`origin/main@777c725a`（PR [#596](https://github.com/PanXing-Libiao/LibiaoLink/pull/596)）
> 关联：`docs/F-02-MinIO最小权限与暴露面整改方案.md`、`deploy/prod/README.md` §9.1～§9.4
> 状态：待执行。本文只整理代做项、证据和边界，不修改 F-02 验收表，不把未执行项写成通过；F-02 仍保持开放。

## 1. 总边界

- 只在测试机 `10.1.104.44` 执行，生产不动；先记录当前部署版本、容器镜像和启动时间。
- 不将任何 Secret、access key、secret key、预签名 URL 或完整日志粘贴到聊天、PR、工单。
- 不把 `9000` / `9443` 改回 `0.0.0.0`，不把 api / worker 改回 root 凭据。
- 不对生产桶执行 `mc rb --force libiaolink`；不手工删除 `/run/libiaolink-f02-s5`。
- 本轮不重新执行 `rotate`，不执行 `recover` / `finalize`；故障注入等待隔离方案。
- 任何命令出现非预期成功或 `AccessDenied` 以外的错误，立即停止并回报，不自行放宽策略。
- Secret 只通过受控文件、stdin 或一次性环境目录传递；证据只保留文件名、状态码、退出码和脱敏摘要。

## 2. P0：低风险执行与取证（可先执行）

### 2.1 基线、证据目录和现状

在测试机 root shell 执行：

```bash
ssh root@10.1.104.44
cd /opt/libiaolink/deploy/prod
set +o history 2>/dev/null || true

E=/srv/data/backups/f02-acceptance-$(date -u +%Y%m%dT%H%M%SZ)
install -d -m 700 "$E"
for n in 1 2 3 4 5; do
  install -d -m 700 "/srv/data/backups/f02-s${n}-evidence"
done

{
  date -u
  docker compose --profile app ps
  docker inspect libiaolink-api libiaolink-worker \
    --format '{{.Name}} image={{.Config.Image}} started={{.State.StartedAt}} restarts={{.RestartCount}}'
} | tee "$E/baseline.txt"

find /srv/data/backups -maxdepth 3 -type f -path '*/f02-*-evidence/*' \
  -printf '%m %s %p\n' | sort | tee "$E/evidence-inventory.txt"
```

证据：`$E/baseline.txt`、`$E/evidence-inventory.txt`。

### 2.2 S1：宿主端口与服务器本机健康检查

```bash
sudo ss -lntp | tee "$E/s1-ss.txt"
grep -E ':(9000|9001|9443)\b' "$E/s1-ss.txt" | tee "$E/s1-ports.txt" || true

curl -fsS https://test-pm.libiaorobot.com/healthz | tee "$E/s1-healthz.txt"
curl -fsS https://test-pm.libiaorobot.com/readyz | tee "$E/s1-readyz.txt"
curl -sS -o /dev/null -w '%{http_code}\n' \
  https://test-pm.libiaorobot.com/libiaolink/ | tee "$E/s1-object-facade.txt"
```

预期：`9000` 无宿主监听；`9001` / `9443` 只出现 `127.0.0.1`；`/healthz`、`/readyz` 为 200；`/libiaolink/` 为预期的 400 / 403 / 404，不是连接失败。

### 2.3 S1：SSH 隧道正向复核

在 px 电脑 PowerShell 中保持隧道：

```powershell
ssh -N -L 19001:127.0.0.1:9001 -L 19443:127.0.0.1:9443 root@10.1.104.44
```

另开一个终端：

```powershell
curl.exe -sS -o NUL -w "console=%{http_code}`n" http://127.0.0.1:19001/
curl.exe -ksS -o NUL -w "backup=%{http_code}`n" https://127.0.0.1:19443/
```

预期：控制台返回登录页或重定向；9443 返回预期的 400 / 403 / 404，不能超时。截图只保留状态码和页面类型，不保留完整签名 URL。

### 2.4 S1 / S2：外部网络探活

在 px 电脑办公网执行一次，再用手机热点或独立公网主机执行一次：

```powershell
foreach ($p in 9000,9001,9443,80,443) {
  $ok = Test-NetConnection test-pm.libiaorobot.com -Port $p -InformationLevel Quiet
  "port=$p reachable=$ok"
}
```

预期：`9000/9001/9443` 全部 `False`；`80/443` 为 `True`。两份结果分别保存为 `s1-s2-office.txt`、`s1-s2-public.txt`。

### 2.5 S2：DOCKER-USER 只读复核

```bash
sudo iptables -S DOCKER-USER | tee "$E/s2-iptables.txt"
sudo ip6tables -S DOCKER-USER | tee "$E/s2-ip6tables.txt"
bash scripts/docker-user-firewall.sh --check; echo "check_rc=$?" | tee "$E/s2-firewall-check.txt"
systemctl is-enabled libiaolink-docker-user-firewall.service | tee "$E/s2-unit-enabled.txt"
systemctl is-active libiaolink-docker-user-firewall.service | tee "$E/s2-unit-active.txt"
```

预期：`--check` 退出码为 0；unit 为 `enabled/active`；规则只包含 `libiaolink-f02-s2` 标记，不 flush 整条链。

### 2.6 S3：身份正向证据

```bash
export MC_BIN=/usr/local/bin/mc
export MC_SOURCE='github.com/minio/mc@RELEASE.2025-08-13T08-35-41Z:mc.linux-amd64.RELEASE.2025-08-13T08-35-41Z;sha256=01f866e9c5f9b87c2b09116fa5d7c06695b106242d829a8bb32990c00312e891'

bash scripts/minio-identity.sh check | tee "$E/s3-identity-check.txt"
stat -c '%a %U:%G %n' secrets/s3_access_key secrets/s3_secret_key \
  secrets/s3_bootstrap_access_key secrets/s3_bootstrap_secret_key | tee "$E/s3-secrets-stat.txt"
stat -c '%a %U:%G %s %n' /srv/data/backups/f02-s3-evidence/mc-toolchain.txt | tee "$E/s3-toolchain-stat.txt"
cat /srv/data/backups/f02-s3-evidence/mc-toolchain.txt | tee "$E/s3-toolchain.txt"
```

预期：`check` 退出码为 0；四个 Secret 文件为 `600`；`mc-toolchain.txt` 为 `600` 且来源 / SHA-256 / `--help` 记录完整。

### 2.7 S3-T6 / T7：负向权限和 sentinel 桶

使用临时 `/run` 目录和 stdin 承接凭据，不把 Secret 放进命令行：

```bash
E3=/srv/data/backups/f02-s3-evidence
tmp_app=$(mktemp -d /run/f02-s3-app.XXXXXX)
tmp_boot=$(mktemp -d /run/f02-s3-boot.XXXXXX)
tmp_root=$(mktemp -d /run/f02-s3-root.XXXXXX)
chmod 700 "$tmp_app" "$tmp_boot" "$tmp_root"

mcapp()  { MC_CONFIG_DIR="$tmp_app"  /usr/local/bin/mc --insecure "$@"; }
mcboot() { MC_CONFIG_DIR="$tmp_boot" /usr/local/bin/mc --insecure "$@"; }
mcroot() { MC_CONFIG_DIR="$tmp_root" /usr/local/bin/mc --insecure "$@"; }

printf '%s\n%s\n' \
  "$(cat secrets/s3_access_key)" \
  "$(cat secrets/s3_secret_key)" \
  | mcapp alias set f02app https://127.0.0.1:9443 >/dev/null

printf '%s\n%s\n' \
  "$(cat secrets/s3_bootstrap_access_key)" \
  "$(cat secrets/s3_bootstrap_secret_key)" \
  | mcboot alias set f02boot https://127.0.0.1:9443 >/dev/null

printf '%s\n%s\n' \
  "$(cat secrets/minio_root_user)" \
  "$(cat secrets/minio_root_password)" \
  | mcroot alias set f02root https://127.0.0.1:9443 >/dev/null

sentinel="f02-sentinel-$(date -u +%Y%m%d%H%M%S)"
probe_key="_f02_probe_${sentinel}/probe.txt"
printf 'f02 sentinel\n' > "/tmp/$sentinel.txt"

mcroot mb "f02root/$sentinel" >/dev/null
mcroot cp "/tmp/$sentinel.txt" "f02root/$sentinel/probe.txt" >/dev/null
mcroot cp "/tmp/$sentinel.txt" "f02root/libiaolink/$probe_key" >/dev/null

set +e
neg() {
  local name="$1"; shift
  "$@" >"$E3/neg-$name.txt" 2>&1
  local rc=$?
  printf '%s rc=%s\n' "$name" "$rc" | tee -a "$E3/neg-summary.txt"
}

neg app_admin_info       mcapp admin info f02app
neg app_policy_info      mcapp admin policy info f02app libiaolink-app-rw
neg app_make_bucket      mcapp mb "f02app/f02-denied-$sentinel"
neg app_list_sentinel    mcapp ls "f02app/$sentinel"
neg app_read_sentinel    mcapp cat "f02app/$sentinel/probe.txt"
neg app_write_sentinel   mcapp cp "/tmp/$sentinel.txt" "f02app/$sentinel/app.txt"
neg app_delete_sentinel  mcapp rm "f02app/$sentinel/probe.txt"

neg boot_read_object     mcboot cat "f02boot/libiaolink/$probe_key"
neg boot_write_object    mcboot cp "/tmp/$sentinel.txt" "f02boot/libiaolink/$probe_key"
neg boot_make_bucket     mcboot mb "f02boot/$sentinel"
neg boot_delete_bucket   mcboot rb "f02boot/$sentinel"
```

预期：上述负向命令均非零，日志含 `AccessDenied` / HTTP 403；若出现任何 `rc=0`，立即停止。

清理：

```bash
mcroot rm "f02root/$sentinel/probe.txt" "f02root/libiaolink/$probe_key" >/dev/null 2>&1 || true
mcroot rb --force "f02root/$sentinel" >/dev/null 2>&1 || true
mcroot rb --force "f02root/f02-denied-$sentinel" >/dev/null 2>&1 || true
rm -f "/tmp/$sentinel.txt"
rm -rf "$tmp_app" "$tmp_boot" "$tmp_root"
```

生产桶删除项先不要交给 px 直接执行。当前策略 JSON 已确认应用策略没有 `s3:DeleteBucket`，但“对真实生产桶发 DeleteBucket”仍属高风险；若必须做运行态补证，由 lan 在确认桶非空后用不带 `--force` 的命令另发，出现非 403 立即停止。

### 2.8 S3-T9：运行时未切换事实

```bash
{
  echo "当前容器启动时间不等于 S3 时点，仅作现状记录"
  docker inspect libiaolink-api libiaolink-worker \
    --format '{{.Name}} {{.State.StartedAt}} restarts={{.RestartCount}}'
  docker compose --profile app ps
} | tee "$E/s3-runtime-history.txt"
```

如果拿不到 2026-10-23 S3 完成时的原始 `StartedAt` 或部署顺序记录，登记为“历史时点无法原位复核”，不要写通过。

### 2.9 S4-T1 / T2：挂载与运行时边界

按 `deploy/prod/README.md` §9.3 执行，并保存：

```bash
docker compose --profile app config > "$E/s4-compose-app.yml"
docker compose --profile tools config > "$E/s4-compose-tools.yml"

for c in libiaolink-api libiaolink-worker; do
  docker exec "$c" sh -c 'ls -1 /run/secrets | sort' > "$E/s4-$c-secrets.txt"
  docker exec "$c" sh -c 'test ! -e /opt/libiaolink/secrets'
  docker exec "$c" sh -c 'grep -E "^(Uid|Gid):" /proc/1/status' > "$E/s4-$c-uid.txt"
done

docker inspect libiaolink-api libiaolink-worker \
  --format '{{.Name}} {{range .Mounts}}{{.Type}} {{.Source}} -> {{.Destination}};{{end}}' \
  | tee "$E/s4-mounts.txt"
```

预期：api / worker 只挂载白名单单文件 Secret；无 `./secrets` 整目录；无 root / superuser / migrator Secret；进程 UID/GID 为 1000。

### 2.10 S4-T3：缺失必需 Secret fail closed

```bash
img=$(docker inspect -f '{{.Config.Image}}' libiaolink-api)
set +e
docker run --rm --network none --entrypoint node \
  -v /opt/libiaolink/deploy/prod/scripts/service-entrypoint.cjs:/entry.cjs:ro \
  "$img" /entry.cjs -e 'process.exit(0)' \
  > "$E/s4-fail-closed.txt" 2>&1
echo "exit=$?" | tee -a "$E/s4-fail-closed.txt"
set -e
```

预期：退出码为 `70`，日志明确缺少首个必需 Secret，且没有启动目标子进程。

### 2.11 S4-T4：可选 Secret 空值 unset

使用同一镜像的临时 `/run/secrets` 目录，不重启真实 worker。只打印变量是否存在，不打印值。验证：

- 空的 `translate_api_key` / `wecom_app_secret` / `wecom_bot_secret` 对应变量不存在。
- 给 `wecom_app_secret` / `wecom_bot_secret` 写临时占位值后，子进程只能看到对应变量。
- Compose 挂载矩阵中，`translate_api_key` 只在 api，`wecom_*` 只在 worker。

这是隔离容器证据；若 F-02 表要求严格在实际 api / worker 重放，需另排维护窗口，写入测试占位值并只重建目标容器，验收后恢复空占位。

### 2.12 S4-T5 / T7 / T8：健康与存储回放

```bash
curl -fsS https://test-pm.libiaorobot.com/healthz | tee "$E/s4-healthz.txt"
curl -fsS https://test-pm.libiaorobot.com/readyz | tee "$E/s4-readyz.txt"
bash scripts/storage.sh init --check | tee "$E/s4-storage-init-check.txt"
bash scripts/storage.sh it | tee "$E/s4-storage-it.txt"
```

### 2.13 S4-T6：tools 只读迁移 / 种子

```bash
docker compose --profile tools run --rm tools sh -c 'ls -1 /run/secrets' \
  | tee "$E/s4-tools-secrets.txt"
bash scripts/db-migrate.sh --dry-run | tee "$E/s4-db-migrate-dry-run.txt"
bash scripts/db-seed.sh --dry-run | tee "$E/s4-db-seed-dry-run.txt"
```

预期：tools 只看到 `pg_migrator_password`；两个 dry-run 成功且不改库。

### 2.14 S4-T10：Secret 泄漏扫描

生成 `docker top`、近期容器日志和待扫描文本后，按 `secrets/*` 逐一扫描；只记录 Secret 文件名和命中数量，不输出命中内容：

```bash
docker top libiaolink-api > "$E/s4-docker-top-api.txt"
docker top libiaolink-worker > "$E/s4-docker-top-worker.txt"
docker logs --since 24h libiaolink-api > "$E/s4-api.log" 2>&1
docker logs --since 24h libiaolink-worker > "$E/s4-worker.log" 2>&1

: > "$E/s4-leak-scan.txt"
for secret_file in secrets/*; do
  [ -s "$secret_file" ] || continue
  hits=$(grep -R -I -F -l -f "$secret_file" \
    --exclude-dir=secrets \
    "$E" /opt/libiaolink/deploy/prod /root/.bash_history \
    /home /tmp /var/tmp 2>/dev/null | wc -l)
  printf '%s hits=%s\n' "$(basename "$secret_file")" "$hits" \
    | tee -a "$E/s4-leak-scan.txt"
done
```

预期：每个当前 Secret 均 `hits=0`。压缩包、tar、镜像和二进制文件不能按文本扫描结论写成“未包含”。

### 2.15 S5-T1 / T7：备份与敏感二进制登记

```bash
find /srv/data/backups -maxdepth 3 -type f \
  \( -name '*.tar' -o -name '*.tar.gz' -o -name '*.tgz' \
     -o -name '*.zip' -o -name '*.gz' -o -name '*.sql.gz' \) \
  -printf '%m %s %p\n' | sort | tee "$E/s5-sensitive-backup-inventory.txt"

du -sb /srv/data/backups/minio-before-f02-s5-20261023-1647 \
  | tee "$E/s5-minio-backup-size.txt"
find /srv/data/backups/minio-before-f02-s5-20261023-1647 -type f \
  | wc -l | tee "$E/s5-minio-backup-files.txt"
```

将 MinIO/PG 备份、tar、镜像和压缩包登记为敏感资产，确认目录 / 文件仅 root 可读；记录处置结论，不要把“文本 grep 0 命中”写成“压缩备份未包含 Secret”。

另在 `$E/s5-maintenance.txt` 记录轮换窗口、操作人、影响面、回滚联系人、备份路径与证据路径；记录不得包含 Secret。

### 2.16 S5-T2 / T4 / T5 / T10：不改配置的复核

```bash
export MC_BIN=/usr/local/bin/mc
export MC_SOURCE='github.com/minio/mc@RELEASE.2025-08-13T08-35-41Z:mc.linux-amd64.RELEASE.2025-08-13T08-35-41Z;sha256=01f866e9c5f9b87c2b09116fa5d7c06695b106242d829a8bb32990c00312e891'

bash scripts/minio-root-rotate.sh plan | tee "$E/s5-plan.txt"
bash scripts/minio-root-rotate.sh check | tee "$E/s5-check.txt"

test ! -e /run/libiaolink-f02-s5
stat -c '%a %n' secrets/minio_root_user secrets/minio_root_password | tee "$E/s5-root-stat.txt"
find secrets -maxdepth 1 -name '*.f02-s5.*' -print | tee "$E/s5-temp-residue.txt"
```

同时复核：当前 root 与 api / worker 的 S3 access key 不相同；api / worker 未使用 root；9000/9001/9443 仍不可外部访问；`f02_status=open`。

注意：这里的 `plan` / `check` 只能证明当前状态；轮换前的 `plan.txt` / `check.txt`、service account 前后基线和端口前后记录必须从已有 `f02-s5-evidence` / `f02-s1-evidence` / `f02-s2-evidence` 中查找。找不到就登记为 `evidence-missing`，不能事后补写成轮换前通过。

### 2.17 S5-T3：旧预签名 / 历史应用凭据

先查是否已有轮换前样本：

```bash
find /srv/data/backups/f02-s5-evidence -type f \
  \( -iname '*presign*' -o -iname '*url*' -o -iname '*history*' \) \
  -printf '%p\n'
```

如果不存在轮换前生成的旧预签名 URL 或历史应用凭据样本，登记为“已过原时点，不可补做”；不要把当前 root 失效误写成旧预签名 URL 验证通过。若仍要取得该证据，需要另排一次受控轮换，并在轮换前保存样本。

## 3. P1：需要登录态（等测试账号）

- 使用专用测试账号和临时测试项目，不使用真实业务项目。
- 在 443 浏览器完成：登录 → 小文件上传 → 触发分片的大文件上传（记录分片数）→ 列表 → 预览 → 下载并核对 SHA-256 → 服务端复制 → 普通删除 → 回收站彻底删除。
- 记录对象清理结果、API / worker 的 S3 请求来源为应用 service account、无 root 值；不记录签名 URL。
- 补跑 H1 443 B1～B7，9443 仅通过 SSH 隧道；保留脱敏 `summary.json`、截图和失败日志。

注意：`S4-T9` 原应在 S5 轮换前执行；现在补做只能覆盖轮换后的 `S5-T5`。若要求严格证明轮换前时序，需另做一次受控环境重放。

## 4. P2：维护窗口（另行批准后执行）

- `S2`：执行 `sudo systemctl restart docker`，等待容器恢复后重跑端口、DOCKER-USER、`/readyz` 和外部探活；该操作会重启全部容器。
- `S2`：主机重启演练单独排窗口，记录 boot id、unit 状态、端口、防火墙和健康检查。
- `S5-T8 / T9`：暂不在现网测试机执行回滚、`recover`、`finalize` 故障注入；等待 lan 提供隔离故障注入方案或在独立 MinIO 栈执行，禁止在真实数据上制造锁死状态。

## 5. 回传格式

请 px 回传：

- `$E` 路径、`evidence-inventory.txt`、`evidence-sha256.txt`。
- 每个测试编号的 `pass / fail / not-executed / evidence-missing` 结论。
- 所有异常退出码、失败日志和截图；不要回传任何 Secret 或完整签名 URL。
- 明确说明哪些项因原时点已过或缺少样本而无法补测。

建议结果表：

| 测试项 | 结论 | 证据路径 | 执行时间 | 备注 |
|---|---|---|---|---|
| S1 |  |  |  |  |
| S2 |  |  |  |  |
| S3-T1～T9 |  |  |  |  |
| S4-T1～T10 |  |  |  |  |
| S5-T1～T10 |  |  |  |  |

本清单未改变 F-02 的验收状态；执行后仍需由 lan / wmj 复核，按 F-02 S7 统一回填，不能以本清单勾选代替证据。
