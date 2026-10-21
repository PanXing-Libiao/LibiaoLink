# ADR-035 CAD 接入独立能力工程，移除旧浏览器解析链

- 日期：2026-10-21。
- 状态：用户已授权接入；STEP 本地接口/浏览器联调完成，公司环境部署待验收，仓库合并仍按非作者评审执行。
- 主责：wmj；lan 协办共享 file/preview/outbox，px 协办通用 UI 与部署。
- 替代：ADR-008、ADR-031、ADR-032 及其 CAD-0～CAD-5 实施任务；ADR-007/030 中 CAD 子口径以本文为准，Office 和下载契约不变。

## 决定

以独立 `CAD逆向` 工程的能力矩阵、格式规则和 ViewerSession 为唯一 CAD 实现基线，STEP v0.3.3 几何基线 `0911573`，宿主适配源码固定 `38135e6`。LibiaoLink 负责文件版本、权限、任务与资源接入，不继续维护旧浏览器解析及网格测量分支。

本轮删除旧查看器、OCCT WASM、专用依赖与 CAD 原对象图片直签。配置运行环境后 STEP 使用独立任务/ViewerSession，其余 CAD 或未配置环境保持提示与下载；不把后缀识别、原文件签名或独立工程测试写成平台支持。

## 方案比较

| 方案 | 代价与判断 |
| --- | --- |
| 继续修补旧浏览器解析器 | 与独立工程形成两套规则和缺面/身份口径，用户已要求删除，不采用 |
| 在平台重建一套几何服务与测量模型 | 重复既有工作，且旧测量提案不代表已验证能力，不采用 |
| 适配独立 CAD 工程 | 复用已验证模型、修复与操作；集中处理平台版本/权限/资源边界，采用 |

## 宿主实现

平台适配采用私有 Python stdio gateway，复用独立源码与任务存储，不另开 HTTP 服务。相比独立公开服务，可直接沿用当前 file/version 的鉴权、对象存储和同源 UI；代价是本阶段 native runtime 需与 API 的机器/容器环境一同准备，隔离与资源预算须在正式部署时验证。直接嵌入独立 localhost 页面不能满足平台资源权限，未采用。

宿主对子进程只传最小运行环境和本地已核对的文件，不传数据库/S3 凭据。任务按 actor/file/version/SHA/view 隔离；manifest 与二进制资源逐请求授权。iframe 只复用原模型/会话，postMessage 同时核对 origin 与窗口来源。缺失/修复/检查记录经宿主复核文件版本权限后下载，原记录内容不重算。

## 接入约束

1. 沿用 UCD 文档/快照、manifest、二进制 buffers、身份字典及压缩；几何资源不伪装成 `image/pdf`。
2. file/version/source SHA 与 CAD 原有 source/product/occurrence/draw/face/material 身份可追溯；缓存纳入内核、规则、参数与协议版本。
3. repaired、nonMeshableFaces、missing 与 Partial 分别展示；较大真实缺面不能按微面政策放行。
4. 每份模型资源与诊断均绑定文件版本权限；保留受限任务、取消/超时和关闭清理。
5. EASM 行为继续执行原生逆向证据门槛；其他格式按标准、官方解析器及独立验证登记。旧文件扩展名列表不授予支持资格。
6. 工程测量、PMI、公差与批准尺寸依据不纳入本轮。删除宿主专用 Three/OCCT 依赖不限制独立查看器使用其已验证依赖。

## 实施与验证

任务、既有能力边界及逐项验收见 [CAD 平台接入基线与迁移任务](../CAD平台接入基线与迁移任务.md)。本轮实际 HTTP/native 与旧预览/下载 52 项通过，W01/N02/N03 完整操作通过，S03 外部依赖明确失败；见 [逐文件结果](../cad-platform-integration/RESULTS.md)。采用定向测试与浏览器检查，不做全量构建。历史发布记录保留用于追溯，不代表旧能力继续生效。

工程参考：[NestJS StreamableFile](https://docs.nestjs.com/techniques/streaming-files)、[MDN postMessage](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage)、[npm uninstall](https://docs.npmjs.com/cli/v11/commands/npm-uninstall/)、[OWASP Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)。这些只支持加载、清理与权限工程，不作为 CAD 格式语义来源。
