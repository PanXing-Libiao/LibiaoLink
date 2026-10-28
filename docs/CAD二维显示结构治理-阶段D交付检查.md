# CAD 二维显示结构治理：阶段 D 交付检查

- 日期：2026-10-28
- 负责人：wmj
- 分支：`wmj`
- 阶段基线：[阶段 A 基线与裁剪切片](CAD二维显示结构治理-阶段A基线.md)；方案：[治理方案](CAD二维显示结构治理方案.md)
- 本文件所在提交为阶段 D 收敛提交；阶段 C 最后提交 `d22685d`。§1.1、§1.2 为同日两轮评审修复，仍在本地 `wmj`，未推送、未部署。

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

## 1.1 评审修复（2026-10-28）

| 问题 | 修复 | 证据 |
| --- | --- | --- |
| 嵌套块的继承裁剪被重复变换：保留实例进入子组时重置局部变换，却仍把外层坐标的裁剪交给子组矩阵求逆 | `projectDrawing.walk` 的 visitor 回调改为把 visitor 换算后的空间局部裁剪传给 `visit`；视口 paper 边界只在所属源空间引入一次，再作为继承裁剪向下传递 | `drawing-instances.test.mjs` 的嵌套块裁剪用例（外层平移 100、内层平移 3，普通/保留均为 `[100,110]`）与嵌套视口用例 |
| 保留实例丢失按具体实例生成的 `drawVariants`：visitor 把实例路径清空，投影用空路径查表 | visitor 保留完整实例路径用于 draw id；组节点只保存相对父组的路径，阵列复制仍共用同一组 | `drawing-instances.test.mjs` 的 per-instance variant 用例 |
| 无限线进入保留实例路径时索引读取不存在的 `visibleGeometry` | 新增 `recordVisibleBounds`：有裁剪窗口时用 `navigationBounds`，无窗口的无限线标记为 unbounded，按帧裁剪绘制；适应视图保留无限线锚点回退 | `drawing-instances.test.mjs` 的 `recordVisibleBounds` 用例；§1.2 的浏览器夹具 |
| DXF 格式缓存键遗漏 DWG 外参解码器描述：`dwg-reader.json` 被归入不生成格式版本的 DWG 集合 | `build-release.py` 把 `unified/dwg-reader.json` 归入 DXF 身份（`dxf_dwg.py` 读取它解码 DXF 外参）；`dwg_adapter.py` 仍只在 engineDigest | `cad-release.test.py` 新增 DXF-only 变化断言 |
| 单个超过 40 万项的阵列被普通投影上限拒绝，即使估算器已选择保留实例路径 | 普通投影保留 `maxDraws`；visitor 模式跳过单阵列上限，仅保留安全整数检查 | `drawing-instances.test.mjs` 的阵列预算用例 |

评审修复后的已知边界：保留实例中的无裁剪无限线不进入 Flatbush 索引（可绘制，但本帧拾取不命中）；适配器端的 `MAX_PROJECTION_DRAWS` 仍会拒绝转换期展开超过 40 万项的单个阵列。

## 1.2 第二轮评审修复（2026-10-28）

| 问题 | 修复 | 证据 |
| --- | --- | --- |
| 块属性在保留路径丢失所属块裁剪：`draw()` 用当前组的裁剪覆盖了属性自带的 child clips | `projectInstances.draw` 只在绘制项没有自己的裁剪时回退到组裁剪；属性继续使用继承裁剪 + 块裁剪 | `drawing-instances.test.mjs` 的属性裁剪用例；浏览器夹具外围文字非白像素 9→0 |
| 阵列副本共用首个实例的变体状态：首个副本 ready、第二项 missing 时保留路径两项都 ready | 含 `drawVariants` 的空间按完整实例路径分组；`plotVariants` 同样参与路径键（即使预览关闭，查看器可无重新投影地开启）；不敏感空间仍共享组 | `drawing-instances.test.mjs` 的逐副本变体与打印变体用例；浏览器夹具 availability `["ready","unsupported"]` |
| 带裁剪的无限线在保留路径画到裁剪范围外 | 保留绘制分支在描边前应用 `clipRegion`，与普通路径一致；索引仍用裁剪后的可见区间 | 浏览器夹具裁剪外 `(10,0)/(90,0)` 由蓝变白 |
| 保留路径没有应用打印样式：组前缀键查不到 `plotStyles.resolved` | 用完整实例路径重建普通 draw id 查打印样式，并把同一 ID 传给 `plotParts` | 浏览器夹具打印线由黑变红；`plan.identity(draw, draw.blockPath)` 与普通 draw id 对齐的测试 |
| 逐副本拆组后，保留路径仍用普通 `maxDraws` 对唯一源绘制项计数，达到上限直接失败 | `addDraw` 只在普通路径执行展开绘制预算；保留路径由实例计数和最终一致性检查约束，普通路径的 `maxDraws` 不变 | `drawing-instances.test.mjs`：`maxDraws=2`、3 个带变体阵列副本时普通路径报错、保留路径生成 3 个源绘制项 |

第二轮后的已知取舍：命中逐副本变体（线型 `drawVariants` 或 `plotVariants`）的阵列不再跨副本复用同一组几何；这是为避免把首个副本的派生结果套用到全部副本，未命中变体的空间仍保留原阵列复用。保留路径不再执行普通投影的 `maxDraws` 展开预算，资源约束转为实例总数；浏览器夹具与前后对照见仓库外 `D:\LibiaoLink-verify\cad-samples\review\RESULTS.md`。

## 2. 交付检查

```text
node --test server/cad-engine/core/tests/drawing-*.test.mjs
# 50/50 pass

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
  - `engineVersion = step-0.3.3/4cc8fc50a196831a9ec1cd76aac5fb22c673898d077b59745dcb337561e65de3/gateway-1`（DWG 适配器平面 REGION 映射后更新）
  - `viewerVersion = viewer-5c952e5df6aeb78cda85a404e9a28164706a54e1c6d22c0374adbd4814e3c571`（原生文字排版与显示避让后更新）
  - `formatVersions.STEP = step-0.3.3/59b471708acfac401d9c7381a8ef32b4856f0def5ea7df74045d8f0a2f8dd4a9/gateway-1`（未变）
  - `formatVersions.DXF = dxf-0.15.0/556c616e28de73ad28a22386b4cb8bae923752df8cfd082cbfd59c47e801e542/gateway-1`（未变）
  - `releaseDigest = 27d946614487cafe101bed4614b4355445e841d87cd322ce08bfaf9730e1b23f`
  迁移 `0069` 为旧产物回填旧 `engine_version` 作为 `format_version`，首次访问新格式版本时重建一次；之后浏览器或单一格式改动不会触发另一格式重建。本轮只改 DWG 适配器和读取器/本机工具，engineVersion 变化，STEP/DXF 格式键不变；读取器仍不进入 engineDigest。平面 REGION 的 ezdxf 导入依赖见 `requirements-dwg.txt`，未改 `dxf_region.py`，因此 DXF 格式键不因 ACIS 解析而变化。原生多行文字排版修复和显示级注释避让只改浏览器 `drawing-text.js`/`cad-text-layout.js`/`drawing-text-avoidance.js`，`viewerVersion` 与 `releaseDigest` 更新，engineVersion、STEP/DXF 不变。
- 迁移 `0069` 改变唯一键，必须先停止 API/worker 再迁移并整体升级；不能只回退镜像。
- 回滚：本批提交未推送、未部署；本地回滚到 `8e7b6a4` 可回到平面 REGION 修复前，回滚到 `b5b24fd` 可回到 XLINE/RAY 修复前，回滚到 `5c980c0` 可回到默认视图修复前，回滚到 `8fe3784` 可回到评审修复前（版本拆分已包含在该提交），阶段 C 前为 `fff7428`。若已部署，需停 API/worker，恢复 `engine_version` 唯一键、移除 `format_version`，再回退 API/worker/CAD 镜像与 `/cad-viewer/` 静态资源；不要只回滚前端，避免 manifest/引擎版本不一致。
- 未执行：真实公司账号浏览器验收、生产部署、独立 `CAD逆向` 工程能力矩阵同步（该工程不在本仓库）。

## 5. 未完成与后续任务

1. 独立工程登记：阶段 A/B/C/D 的能力矩阵、提交和证据需在 `CAD逆向` 工程同步；本仓库只记录宿主基线与指纹。
2. 版本拆分/缓存策略：已完成（ADR-039）；本次评审修复再次变更 DXF 格式键，部署时 DXF 产物重建一次。
3. 剩余能力：竖排/镜像/堆叠、复杂线型相位、打印样式 pen、PDF/DWF/DGN 的双路径证据；无裁剪无限线在保留路径可绘制但暂不进入空间索引；适配器转换期仍拒绝展开后超过 40 万项的单个阵列；逐副本变体空间按路径分组，牺牲该子树的跨副本保留；保留路径不再套用普通 `maxDraws`，资源约束由实例总数承担。
4. 目标设备/WebView 实测与真实公司账号验收。
5. 部署窗口：迁移、API、worker、CAD 镜像、静态资源、source.json 必须同批发布，并先跑 STEP 冒烟。
