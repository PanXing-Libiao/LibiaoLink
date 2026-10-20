# ADR-035 CAD 接入独立能力工程，移除旧浏览器解析链

- 日期：2026-10-21。
- 状态：接入准备已获用户授权；新 CAD 平台联调待实施，仓库合并仍按非作者评审执行。
- 主责：wmj；lan 协办共享 file/preview/outbox，px 协办通用 UI 与部署。
- 替代：ADR-008、ADR-031、ADR-032 及其 CAD-0～CAD-5 实施任务；ADR-007/030 中 CAD 子口径以本文为准，Office 和下载契约不变。

## 决定

以独立 `CAD逆向` 工程的能力矩阵、格式规则和 ViewerSession 为唯一 CAD 实现基线，当前登记提交 `0911573`（STEP v0.3.3）。LibiaoLink 负责文件版本、权限、任务与资源接入，不继续维护旧浏览器解析及网格测量分支。

本轮删除旧查看器、OCCT WASM、专用依赖与 CAD 原对象图片直签。过渡期间 CAD 明确暂不可预览，保留有权限的原文件下载；不把后缀识别、原文件签名或独立工程测试写成平台支持。

## 方案比较

| 方案 | 代价与判断 |
| --- | --- |
| 继续修补旧浏览器解析器 | 与独立工程形成两套规则和缺面/身份口径，用户已要求删除，不采用 |
| 在平台重建一套几何服务与测量模型 | 重复既有工作，且旧测量提案不代表已验证能力，不采用 |
| 适配独立 CAD 工程 | 复用已验证模型、修复与操作；集中处理平台版本/权限/资源边界，采用 |

## 接入约束

1. 沿用 UCD 文档/快照、manifest、二进制 buffers、身份字典及压缩；几何资源不伪装成 `image/pdf`。
2. file/version/source SHA 与 CAD 原有 source/product/occurrence/draw/face/material 身份可追溯；缓存纳入内核、规则、参数与协议版本。
3. repaired、nonMeshableFaces、missing 与 Partial 分别展示；较大真实缺面不能按微面政策放行。
4. 每份模型资源与诊断均绑定文件版本权限；保留受限任务、取消/超时和关闭清理。
5. EASM 行为继续执行原生逆向证据门槛；其他格式按标准、官方解析器及独立验证登记。旧文件扩展名列表不授予支持资格。
6. 工程测量、PMI、公差与批准尺寸依据不纳入本轮。删除宿主专用 Three/OCCT 依赖不限制独立查看器使用其已验证依赖。

## 实施与验证

任务、既有能力边界及逐项验收见 [CAD 平台接入基线与迁移任务](../CAD平台接入基线与迁移任务.md)。本轮采用实际预览/下载服务的定向测试与浏览器检查，不做全量构建。历史发布记录保留用于追溯，不代表旧能力继续生效。

工程参考：[React lazy](https://react.dev/reference/react/lazy)、[npm uninstall](https://docs.npmjs.com/cli/v11/commands/npm-uninstall/)、[OWASP Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)。这些只支持加载、清理与权限工程，不作为 CAD 格式语义来源。
