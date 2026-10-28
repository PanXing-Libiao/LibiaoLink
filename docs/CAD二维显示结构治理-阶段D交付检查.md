# CAD 二维显示结构治理：阶段 D 交付检查

- 日期：2026-10-28
- 负责人：wmj
- 分支：`wmj`
- 阶段基线：[阶段 A 基线与裁剪切片](CAD二维显示结构治理-阶段A基线.md)；方案：[治理方案](CAD二维显示结构治理方案.md)
- 本文件所在提交为阶段 D 收敛提交；阶段 C 最后提交 `d22685d`。

## 1. 已收敛的分支

| 原分支/重复实现 | 收敛后 | 证据 |
| --- | --- | --- |
| `drawing-viewer` 图案 hatch 与普通显示几何各写一份索引/非索引线段提取 | 统一 `strokeSegmentsForRepresentation`（`drawing-pattern.js`），图案与普通 display 路径共用 | `drawing-pattern.test.mjs`、`check_retained_pattern_slice.mjs`、文本/wipeout/布局样本逐像素 0 差异 |
| `drawing-viewer` 自己读 `fill/1` 判断渐变/图案/实心 | 统一 `hatchFillKind` + `fillEntryFor`；填充几何统一 `fillGeometryFor` | 同上；`semantics-fixture` 与真实图回归 |
| `drawing-viewer` 自己读 `imageToEntity`、拼四角、算 bbox | 统一 `imagePlacement` / `rasterRecord`（`drawing-media.js`） | `drawing-media.test.mjs`、`check_retained_media_layout_slice.mjs` |
| `projectDrawing` 与 `estimateDrawingDraws` 各自遍历 layout 的 viewportIds/enabled | 统一 `layoutViewports` / `layoutSpacePlan`（`drawing-layout.js`） | `drawing-layout.test.mjs`、布局媒体切片 |
| `drawing-viewer` 的 `measureText`/`textOffsets`/`textWorldBox`/DWG 原生排版分支 | 统一 `layoutAnnotationText`（`drawing-text.js`） | `drawing-text.test.mjs`、`check_retained_text_slice.mjs` |
| `patternStrokeSegments` 只服务图案 | 同一 `strokeSegmentsForRepresentation` 也服务普通 display 几何 | 普通/图案样本逐像素 0 差异 |

仍保留的差异是**渲染后端**而非语义：普通路径在屏幕坐标绘制文字，保留实例在局部矩阵下绘制文字；两者共用 `drawing-text.js` 的排版结果。GPU 原型仍在仓库外，未接入，不参与本轮收敛。

## 2. 交付检查

```text
node --test server/cad-engine/core/tests/drawing-*.test.mjs
# 34/34 pass

node server/cad-engine/core/tests/check_drawing_instances.mjs
node server/cad-engine/core/tests/check_retained_clip_slice.mjs
node server/cad-engine/core/tests/check_retained_text_slice.mjs
node server/cad-engine/core/tests/check_retained_pattern_slice.mjs
node server/cad-engine/core/tests/check_retained_media_layout_slice.mjs
# 全部 PASS

cd frontend && npm run typecheck && npm run build
# 通过

python3 server/cad-engine/build-release.py --check
# Checked CAD release <本次 releaseDigest>

cd server && python3 test/cad-release.test.py
# Ran 1 test, OK
```

浏览器回归（仓库外 harness，仅作参考）：文本、图片、wipeout/渐变、布局图片样本在普通/实例两条路径下与阶段 C 迁移前逐像素 0 差异；布局图片普通/实例之间仍是已登记的 0.17% 文字抗锯齿差异；真实图 fit 仍仅文字亚像素抗锯齿 0.25%。

## 3. 能力状态

- 双路径已验证：基础线/曲线/点、块阵列/嵌套、图层/透明度、裁剪（块/视口/part/图片）、简单文字、实心/渐变/图案 hatch、图片、布局/视口、图案 dash 解析。
- 部分/未验证：竖排/镜像/堆叠/MTEXT 分栏、复杂线型相位、打印样式 pen 填充 tiles、PDF/DWF/DGN/OLE 的保留实例路径、真实布局组合。
- 真实图两个布局为空，不能以该图证明所有纸面/视口组合。

## 4. 版本、缓存与回滚

- 已按 [ADR-039](adr/ADR-039-CAD版本拆分与缓存键.md) 拆分版本：`engineVersion` 只含服务器引擎/运行时，`formatVersion` 按 STEP/DXF 独立计算并作为 `cad_artifacts` 缓存键，`viewerVersion` 记录浏览器文件；`bridge.py` 的本地任务恢复摘要改用 `engineDigest`。
- 本文件所在提交的 `source.json`/`cad-release.ts` 记录 `engineDigest`、`viewerDigest`、`formatVersions` 和 `viewerVersion`；当前值为：
  - `engineVersion = step-0.3.3/be95badeb7e489afc0d9fb7d8b2c6d3ccab8a5b9e28fea962d1d493b96c68941/gateway-1`
  - `viewerVersion = viewer-2dad7eb8d44cb5e614e54a0b42410272be80d8e9996e65f8276f17d9ff36b45f`
  - `formatVersions.STEP = step-0.3.3/59b471708acfac401d9c7381a8ef32b4856f0def5ea7df74045d8f0a2f8dd4a9/gateway-1`
  - `formatVersions.DXF = dxf-0.15.0/cada2ab45c53d1857908bea15b2873535b278320f4cdb3f8bb16ea2fb645b8e0/gateway-1`
  迁移 `0069` 为旧产物回填旧 `engine_version` 作为 `format_version`，首次访问新格式版本时重建一次；之后浏览器或单一格式改动不会触发另一格式重建。
- 迁移 `0069` 改变唯一键，必须先停止 API/worker 再迁移并整体升级；不能只回退镜像。
- 回滚：本批提交未推送、未部署；本地回滚到 `fff7428` 即可恢复阶段 C 前的二维行为。若已部署，需停 API/worker，恢复 `engine_version` 唯一键、移除 `format_version`，再回退 API/worker/CAD 镜像与 `/cad-viewer/` 静态资源；不要只回滚前端，避免 manifest/引擎版本不一致。
- 未执行：真实公司账号浏览器验收、生产部署、独立 `CAD逆向` 工程能力矩阵同步（该工程不在本仓库）。

## 5. 未完成与后续任务

1. 独立工程登记：阶段 A/B/C/D 的能力矩阵、提交和证据需在 `CAD逆向` 工程同步；本仓库只记录宿主基线与指纹。
2. 版本拆分/缓存策略：把引擎、浏览器、格式版本拆开，避免二维改动触发 STEP 重建。
3. 剩余能力：竖排/镜像/堆叠、复杂线型相位、打印样式 pen、PDF/DWF/DGN 的双路径证据。
4. 目标设备/WebView 实测与真实公司账号验收。
5. 部署窗口：迁移、API、worker、CAD 镜像、静态资源、source.json 必须同批发布，并先跑 STEP 冒烟。
