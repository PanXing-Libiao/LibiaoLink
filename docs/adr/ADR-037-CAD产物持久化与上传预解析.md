# ADR-037：CAD 产物持久化与上传预解析

日期：2026-10-22。状态：已实现并完成本地验证，待评审与部署。主责 wmj，file/storage 由 lan 协办。

## 需求与依据

首次成功解析后长期复用；上传完成即静默排队；名称默认使用现有 OCCT GB 选项，保留 UTF8 手动切换。持久化不改变固定 CAD core、完整性接收规则或 ADR-036 的独立禁网沙箱。

调研比较三种方式：

| 方案 | 结论 |
| --- | --- |
| PostgreSQL bytea / Large Object 存全部几何 | 技术上可行，但增加业务数据库、备份和大对象生命周期负担；本仓已有私有对象存储，不引入第二条大文件存储链 |
| 给 CAD tmpfs 换持久目录 | 仍需硬磁盘配额、恢复校验与可信任务索引；不能用无配额宿主挂载削弱 ADR-036 |
| PostgreSQL 元数据/队列 + 私有对象存储产物 | 采纳，沿用现有存储端口。数据库只在所有对象完整写入并核对后发布 completed；浏览器逐请求检查文件版本权限 |

来源：[PostgreSQL Large Objects](https://www.postgresql.org/docs/18/largeobjects.html)、[PostgreSQL SKIP LOCKED](https://www.postgresql.org/docs/18/sql-select.html)、[S3 单对象原子性与一致性](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html#ConsistencyModel)。部署使用 S3 兼容端口，仍以实际适配器的写入/读取与 SHA 校验为准。

## 决策

- 缓存键包含文件版本、源 SHA/大小、固定引擎版本、名称码页。先按版本隔离；上传声明的 SHA 并非服务端全文核验，不能直接跨文件授权复用。
- 上传完成事务内登记 GB 后台任务，不等待 native 解析。独立 worker 轮询专用持久队列，使用 SKIP LOCKED、租约及 claim token 防止并发重复发布；CAD 长任务不阻塞现有串行 outbox 通知。
- worker 核对原件全文 SHA/bytes，经原有 Unix HTTP 沙箱提交；仅保存完整 verified manifest 与其列举的 SHA buffers。先写带 claim token 的不可变对象前缀，最后以租约 fencing 更新数据库；半成品不发布。持久发布且释放归档 lease 后，回收没有其他 lease/alias 使用的自有沙箱临时结果，避免逐文件累积耗尽 tmpfs；借用旧窗口产物时不越权回收。
- 查看窗口只绑定持久任务。关闭/取消仅撤销该窗口加载与资源访问，不取消共享后台工作。资源 lease 的授权键是窗口与 token 的组合，释放互不影响；数据库保存窗口状态及租期。
- API 从私有对象存储流式读取已完成产物，保留原 packet 与二进制协议；原 manifest 的不透明资源 token 仅作产物索引，实际授权仍由当前 actor/file/version/view 与独立租期共同决定。
- 成功产物不因 CAD/API/worker 重启失效，不设短期自动过期。新版本、引擎或编码另建缓存；对象缺失/损坏时撤销完成态并排队重建。后台失败不影响上传成功，失败可见于预览，显式重试重新排队。
- 产物放在 `projects/{projectId}/files/{fileId}/cad/`；文件或项目彻底删除时清理对应对象前缀与级联元数据。原件下载、权限与沙箱 CPU/内存/PID/tmpfs 限额保持原值。

## 验证与部署

新增迁移由现有迁移器执行，应用不在启动时改结构。需验证上传即入队、并发幂等、完成前不发布、重启后零 native 提交复用、窗口取消/权限撤销、损坏重建及 GB 默认。仅执行定向运行测试与隔离数据库迁移，不做全仓静态审计或全量构建。数据库和对象存储需共同备份；上线与回滚须随迁移说明评审。
