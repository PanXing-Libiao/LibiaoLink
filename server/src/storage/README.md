# storage/ · 对象存储接入（S3 协议）

| 字段 | 内容 |
|---|---|
| 类型 | 基础设施层（与 `common/` / `db/` / `config/` 同级） |
| 职责 | 对象存储端口与 S3 适配器：分片会话、预签名直传 / 下载、ListParts、合并 / 中止、HEAD、对象前缀读取、服务端复制、按版本彻底删除 |
| 主责 | lan（团队分工.md §2 后端平台） |
| 依据 | ADR-006（S3 协议抽象 + 可替换实现；2026-09-21 阶段 0 修订，沙箱 MinIO pinned）；技术设计v0.2 §5.1；契约 `shared/src/modules/files.ts` |

## 文件

```text
object-storage.ts     # 端口：ObjectStorage 抽象类 + StorageError + toApiError（错误码映射）
s3-object-storage.ts  # 实现：S3 适配器（唯一处配置协议细节）+ createS3Client / createS3ObjectStorage
object-key.ts         # 对象键构造与校验（片段严格校验，防路径穿越）
part-plan.ts          # 分片计划（S3 协议约束）+ 缺片计算
storage.module.ts     # DI 装配（@Global 导出 ObjectStorage 端口）
index.ts              # 唯一公开出口
```

## 约定

- **只依赖 S3 协议**：换实现（MinIO / SeaweedFS / 云 OSS）只改 `createS3Client` 的 endpoint 与凭据，调用方代码不动。
- **本层不得依赖 `modules/`**：已纳入 `npm run check:boundaries` 规则 3（`common` / `db` / `config` / `storage` 不得依赖业务模块）。
- **分片状态不落表**：以对象存储 ListParts 为唯一真相（2026-09-18 评审定案）；`upload_sessions` 只登记元数据。
- **定档不覆盖物理对象**：版本与内容哈希进键（`object-key.ts`），历史对象天然不可变。
- **键形态（ADR-006 定案 2026-09-21）**：会话先写暂存键 `…/staging/{sessionId}`，complete 时 `copyObject` 一次复制到契约键 `…/v{seq}/{contentHash}.{ext}`，再 `purgeObject` 清理暂存；落库 `file_versions.object_key` 始终是契约形态。单对象 > 5 GiB 需 UploadPartCopy —— 一期由 `UPLOAD_MAX_SIZE_MB`（默认 2048，启动校验 ≤ 5120）挡在 5 GiB 以内。
- **彻底删除按版本删**：桶开启版本控制后，不带 `versionId` 的 `DeleteObject` 只写 delete marker、数据版本永不回收（lifecycle 已不作为清理手段）→ 一律走 `purgeObject`（`ListObjectVersions` + 批量 `DeleteObjects` 带 `VersionId`）；暂存清理与 M4-02 回收站同口径。
- **前缀清理兼容未开版本控制**：`purgePrefix` 先按 `ListObjectVersions` 清全部版本；若 S3 实现（本地 MinIO 实测）对未开版本控制的桶返回空集，则回退 `ListObjectsV2` 按当前对象键普通删除 —— 空桶仍返回 0，绝不把“没列到”误报成“已删掉”。
- **api 不代理大文件流量**：分片与下载都走预签名 URL（短时）。
- **原对象响应类型由服务端签名覆盖**：原文件一律以 `application/octet-stream` 保存；下载固定 `application/octet-stream` + attachment；安全位图预览必须显式签入精确图片 MIME + inline，不能沿用对象元数据。SVG / HTML / 未知类型不得进入 inline 签名分支（H1 · S2）。
- **上传实际字节核验**：完成分片合并后通过 `getObjectStream()` 流式计算完整 SHA-256 并校验实际长度，只保留 64 KiB 文件头用于扩展名 / MIME / 魔数裁决；哈希不符不复制、不落版本、不投任务，不把大文件整块读入内存。`readObjectPrefix()` 保留为需要 Range 读取的存储端口。

## 错误映射（`toApiError`）

| 存储侧 | `StorageError.code` | 契约错误码 | HTTP |
|---|---|---|---|
| `NoSuchUpload`（会话已中止 / 已清理） | `upload_not_found` | `UPLOAD_SESSION_EXPIRED` | 410 |
| `InvalidPart` / `InvalidPartOrder` / `EntityTooSmall` / `EntityTooLarge` | `part_conflict` | `UPLOAD_INCOMPLETE` | 409 |
| `NoSuchKey` / 404 | `object_not_found` | `NOT_FOUND` | 404 |
| 源对象超过单次复制上限（5 GiB） | `object_too_large` | `INTERNAL` | 500 |
| 网络 / 凭据 / 桶配置 / 其它 | `unavailable` | `INTERNAL` | 500 |

客户端只拿到统一信封；原始 S3 错误留在服务端日志，且经 `scrub()` 脱敏（预签名 URL、访问密钥、签名值不进日志，CONTRIBUTING §12）。

## 兼容性要点（真机验证过）

1. **预签名 PUT 只签 `host`**：SDK 新版默认给请求带 CRC32 校验和，会写进预签名查询串并要求浏览器额外带头。已按 `requestChecksumCalculation: "WHEN_REQUIRED"` 关闭 —— 真机验证 URL 干净、浏览器可裸 PUT。
2. **寻址方式**：`S3_FORCE_PATH_STYLE=auto` 时非 AWS 端点自动走 path-style（MinIO / SeaweedFS 必需）。
3. **`entityTooSmall` 是协议约束不是 bug**：非末片必须 ≥ 5 MiB，服务端分片计划（`planUpload`）负责保证。

## 实现选型（ADR-006 阶段 0 修订 · 定案 Push 126）

MinIO 社区版上游已归档、官方下载渠道 410、Docker Hub 镜像下架；本版本实测 `PutBucketCors` 返回 `NotImplemented`、lifecycle 规则被拒 —— ADR-006 自写的切换触发条件已触发，wmj 已定案（[PR #96](https://github.com/256-code/LibiaoLink/pull/96) / Push 126，评审 lan / px）。F-02 最小权限改造下，锁定版本的 IAM 动作列表也不提供 `GetBucketCORS` / `PutBucketCORS`，bootstrap 会得到 `AccessDenied`；`storage-init` 仅在该 CORS 路径把 `AccessDenied` 记为能力告警，lifecycle、版本控制等其它路径的 `AccessDenied` 仍失败（测试机部署后验证）：

- **接口层不变**：本目录的 S3 协议抽象继续有效（「能退得回去」的兑现），换实现只改 `createS3Client` 的 endpoint 与凭据。
- **一期实现 = 可替换绑定**：沙箱继续用 pinned 的 `RELEASE.2025-09-07T16-13-09Z`（**仅沙箱，不代表生产选型**）；生产按候选顺序 ① 公司内网既有对象存储 / 既有 MinIO 集群 → ② SeaweedFS 等自建 S3 兼容 → ③ 云 OSS（待云策略结论）。
- **关闭责任与时点**：px（运维）+ lan（平台），M8 生产部署形态验证前关闭；关闭验收 = `storage:init -- --check` + `storage:it` 在目标实现上全绿。
- **任何替代实现都必须满足的行为面**：CORS 不得只依赖存储 API（走服务端配置 / 反向代理补响应头）；清理不依赖 lifecycle 规则（未完成分片由存储侧兜底，如内置 `stale_uploads_expiry`；草稿 30 天走 `files.purge_after` → worker）。

阶段 0 证据（许可 / 版本 / 镜像 / 官方下载 / 上游仓库 / 功能缺口）见 `deploy/minio/README.md`。
