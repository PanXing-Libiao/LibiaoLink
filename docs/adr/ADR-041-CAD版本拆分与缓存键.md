# ADR-041：CAD 引擎、格式与浏览器版本分离

- 日期：2026-10-28
- 状态：草案；本地实现，未推送或部署
- 主责：wmj；补充 ADR-035、ADR-037、ADR-040

## 问题

`build-release.py` 原来把全部 Python 引擎、运行时和浏览器文件一起算入 `releaseDigest`/`engineVersion`。结果是改一个二维查看器文件，或只改 DXF 适配器，也会改变 STEP 产物的缓存键，迫使 STEP 重新解析。二维显示治理阶段 D 已要求版本、缓存与回滚可追溯，因此需要把“服务器引擎”“格式语义”“浏览器查看器”拆成不同身份。

## 决策

- **engineVersion**：服务器引擎 bundle，只由引擎文件（`core/`）和运行时文件、`stepRelease`/`dxfRelease`/网关协议计算，**不含浏览器文件**。继续作为 CAD 服务 `X-CAD-Engine-Version` 和 `cad_artifacts.engine_version` 的部署/审计身份。
- **formatVersion**：每个格式独立，由共享引擎/运行时 + 该格式专属文件计算：
  - STEP：`parser/`、`unified/step_*`、`vendor/cadcraft-display/`、STEP 入口与依赖；
  - DXF：`unified/dxf_*`、`vendor/ezdxf/`、DXF 入口与依赖，以及 `unified/dwg-reader.json`（DXF 外参解码读取其版本/来源描述，属于 DXF 输出身份）；`unified/dwg_adapter.py` 仍只进入 engineDigest，未开放的原生 DWG 不生成格式版本；
  - 共享文件（validation/canonical/schema/transport/queue 等）变化会同时改变两个格式版本，这是保守且有意的。
  `cad_artifacts.format_version` 成为产物唯一键的一部分；`engine_version` 只保留部署/审计含义，不再参与唯一键。
- **viewerVersion**：只由 `frontend/public/cad-viewer/core/` 计算，写入 `source.json`/`cad-release.ts`，用于部署追溯与静态资源版本核对；不进入引擎或格式缓存键。当前不改 `CadViewer` API 契约；如后续需要浏览器灰度，再单独增加可选字段。
- `bridge.py` 的本地任务恢复摘要改用 `engineDigest`，浏览器改动不再影响 CAD 任务缓存。
- `0078_cad_format_version.sql` 增加 `format_version`，旧行回填为旧 `engine_version`，并把唯一键改为 `(version_id, format_version, name_codepage, resource_set_hash)`。旧产物不会被伪装成新格式产物；首次访问新格式版本时重建。之后：
  - 浏览器-only 改动：engineVersion/formatVersion 不变，STEP/DXF 产物都复用；
  - DXF-only 改动：仅 DXF formatVersion 变化，STEP 产物复用；
  - STEP-only 改动：仅 STEP formatVersion 变化，DXF 产物复用；
  - 共享/运行时改动：相关格式按依赖变化重建。

## 影响与约束

- 首次部署本拆分后，旧 `cad_artifacts` 的 `format_version` 是旧 bundle 字符串，与新格式版本不匹配，STEP/DXF 各重建一次；这是一次性迁移成本，不能通过伪造格式版本规避。若旧 STEP 产物与当前 STEP 引擎不一致，重建也是正确行为。
- API、worker、CAD 镜像、`source.json`、`cad-release.ts` 和浏览器静态资源必须同批发布；迁移 0069 前停止 API/worker，避免旧二进制仍使用旧唯一键。
- `formatVersion` 只覆盖当前已启用的 STEP/DXF；DWG 未开放，其文件变化仍进入 engineDigest，但不生成格式版本，等开放时再登记。
- 回滚：停 API/worker，移除新唯一键并恢复 `engine_version` 唯一键，删除 `format_version` 列，再回退镜像与源指纹。旧产物可复用旧格式键；新格式产物保留但不会被旧 API 读取。

## 验证

- `server/test/cad-release.test.py`：浏览器改动只改 viewerVersion/releaseDigest；STEP-only 改动只改 STEP formatVersion；DXF-only 改动只改 DXF formatVersion；STEP/DXF 依赖分别只影响各自格式；`dwg-reader.json` 变化只改 DXF formatVersion；共享运行时改动影响全部。
- `cad-archive-*` 定向测试、服务端 typecheck、`build-release.py --check`。
- 迁移 0069 的回填/唯一键行为需在测试库执行后再部署；当前没有生产数据变更。
