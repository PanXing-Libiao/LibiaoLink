# CAD 二维显示结构治理：阶段 A 基线与阶段 B 裁剪切片

- 日期：2026-10-28（性能更新 2026-11-03；交互收尾 2026-11-03；首开预取 2026-11-03）
- 负责人：wmj
- 范围：二维 CAD 从源数据、上下文解析、执行计划到查看器显示与拾取；三维 STEP 不在本文件范围内。
- 方案： [CAD 二维显示结构治理方案](CAD二维显示结构治理方案.md)；方案检查基线 `a7c9ffe`，本文件基线为当前 `wmj` 工作树（含 `498b0f6`、`1c6de5e`、`fff7428` 及本次治理提交）。
- 部署状态：二维查看器首开性能补丁与并行资源预取已部署公司测试机（`test-20261103-1850-cad-entry-prefetch-fc4a4d60`），正式生产未部署；测试机 STEP 与生产业务未受影响。

## 1. 执行路径盘点

| 路径 | 入口 | 选择条件 | 颜色/样式来源 | 当前状态 |
| --- | --- | --- | --- | --- |
| 普通投影 | `projectDrawing` → `mountDrawingViewer.rebuild` → `draw()` | 非保留实例的 model/layout；块预览也走普通投影 | 投影层解析继承与可见性，查看器绘制 | 仓库主路径 |
| 保留实例 | `projectInstances` → 同一 `rebuild` → `drawInstances()` | model/layout 且 `estimateDrawingDraws > 400000`，或调试参数 `?instances=1`；block-preview 不进入 | 同一 `projectDrawing` 样式解析，实例组复用 | 测试机已部署，正式生产未部署 |
| 块预览 | `projectBlock` → 普通投影 | 模型为空且存在恢复块时由 `setSpace` 选择 | 普通投影 | 仓库既有路径 |
| GPU 原型 | `D:\LibiaoLink-verify\gpu-phase2\hybrid-full.*` | **不在仓库内，也没有被仓库代码引用** | 原型自有实现 | 未接入；不纳入本次契约 |
| STEP 三维 | `app.js` → `unified-viewer.js` / three.js | envelope 为 STEP 3D 时 | 3D 网格 | 线上测试机路径，不受二维语义影响 |

说明：`app.js` 静态导入 `mountDrawingViewer`，所以二维模块的语法/加载错误会影响 STEP 查看器页面；本次只改二维运行时语义，模块已通过语法与构建检查。

## 2. 能力 × 路径 × 空间/上下文矩阵

图例：**已验证** = 有定向测试或可复现浏览器证据；**部分** = 有实现/测试但未覆盖全部组合；**未验证** = 无定向证据；**不支持** = 明确拒绝或保持 partial。

| 能力 | 普通投影 + `draw()` | 保留实例 + `drawInstances()` | 空间/上下文 | 证据与边界 |
| --- | --- | --- | --- | --- |
| 基础线、弧、圆、样条、点 | 已验证 | 已验证 | 源局部 → 模型 → 屏幕 | `drawing-display.test.mjs`、`check_drawing_instances.mjs`；真实图计数一致 |
| 块、阵列、嵌套块 | 已验证 | 已验证 | 块局部 → 所属空间 → 模型 | `check_drawing_instances.mjs` 799,999 项保留 3 个源叶；阵列复制不展开 |
| 图层颜色、线宽、透明度、打印 | 已验证（投影） | 已验证（投影） | 所属空间 + 图层/视口覆盖 | 投影测试覆盖 by-layer/by-block/opacity；打印预览仅普通路径有浏览器证据 |
| 块/视口/part/图片/wipeout 裁剪 | 已验证 | 已验证 | 块/所属空间、纸面、part 局部 | `drawing-clipping.test.mjs`、`check_retained_clip_slice.mjs`、图片 layout 样本 |
| 反向/嵌套/孔洞裁剪 | 已验证 | 部分 | 同一裁剪栈 | 普通路径有区域代数测试；保留实例有反向/嵌套单元夹具，未做浏览器差分 |
| 文字：简单、替换字体 | 已验证 | 已验证 | 注释局部 → 模型 → 屏幕 | `drawing-text.test.mjs`、`check_retained_text_slice.mjs`；SHX presentation 与原始文字样本普通/实例画布逐像素 0 差异 |
| 文字：竖排、镜像、堆叠、MTEXT 分栏 | 部分 | 部分 | 适配器排版 + part 局部 | 竖排/分栏由适配器生成 presentation parts；原始文字回退明确标 `substituted-font`/`canvas-text-layout`；保留实例没有同场景浏览器差分 |
| 实心/渐变/图案 hatch | 已验证 | 已验证 | 实体局部 / fill rings | `drawing-pattern.test.mjs`、`check_retained_pattern_slice.mjs`；`semantics-fixture` 与真实图样本；图案相位仍部分 |
| 复杂线型/相位 | 部分 | 部分 | 样式编译 + 描边 | 适配器有编译与 presentation 测试；`drawing-pattern.js` 统一 dash 解析，复杂相位仍无浏览器差分 |
| 图片/PDF/DWF/DGN/OLE | 已验证（图片） | 已验证（图片） | 实体局部 + 裁剪 | `drawing-media.test.mjs`、`check_retained_media_layout_slice.mjs`；图片 model/layout 普通/实例样本通过；PDF/DWF/DGN 仍只有普通路径测试 |
| 布局/视口/纸面 | 已验证（样本） | 已验证（样本） | 模型 → `modelToPaper` → 纸面 | `drawing-layout.test.mjs`、11 视口 + 5 图片样本；真实图两个布局为空，不能代表全部布局 |
| 打印样式预览 | 已验证 | 部分 | 纸面/图层 + pen | 普通路径有 `dxf-plot-styles`；`drawInstances` 未完整覆盖 pen 填充图案 |
| 拾取、选择、定位、适应视图 | 已验证 | 部分 | 屏幕/世界 + 裁剪可见区域 | 普通路径有浏览器回放；保留实例有代码与单元测试，缺正式浏览器回放 |
| 路径阈值 | 已验证 | 已验证 | 与空间无关 | 399999/400000 普通，400001 保留；`INSTANCE_DRAW_THRESHOLD=400000` |
| 诊断/partial/缺失报告 | 部分 | 部分 | 适配器覆盖 + 查看器错误 | 有 coverage/loss 与 `plotErrors`；保留实例的诊断没有统一契约测试 |

矩阵中的“已验证”只对列出的组合和证据版本成立；不能外推为任意 DWG/DXF 的完整支持。未做浏览器差分的组合保持“部分/未验证”。

## 3. 语义与字段归属

| 信息 | 权威层 | 当前载体 | 消费者 | 待决 |
| --- | --- | --- | --- | --- |
| 源图元、图层、线型、块/实例、布局/视口、注释、媒体引用 | 源适配（`dxf_adapter.py` / `dwg_adapter.py`） | UCD `drawing` 表、`sources` | 投影、查看器、测试 | 无 |
| 继承、图层/视口覆盖、透明度、可见性 | 源适配记录 + 投影规则 | `style-inheritance/1` + 投影 `effectiveLayer`/`resolve` | 投影、查看器 | 规则分散在两处，需后续固化 |
| 注释比例与可见性 | 源适配记录 + 投影选择 | `annotation-presentation/1`、`dxf-annotation-contexts/1` | 投影、查看器 | 变体选择是否可持久化 |
| 显示派生（glyph parts、fill rings、media buffer） | 源适配 | `annotation-presentation/1`、`fill/1`、`dxf-media/1`、representation | 查看器 | 派生身份/版本契约待定 |
| 执行计划（组、实例矩阵、保留几何、裁剪） | `drawing-instances.js` | 运行时 `groups/roots/draws` | `drawInstances`、拾取、统计 | 是否需要持久化待定 |
| 屏幕记录（records、textEntry、fillPath、clipRegion） | 查看器 `rebuild` | 运行时 | `draw`、命中、适应视图 | 是否把文字测量上移待定 |
| 原始文字回退（测量、行框、对齐、包围盒） | `drawing-text.js` | 运行时 run + `approximations` | `rebuild`、`drawText`、`drawInstances`、`texts()` | 竖排/分栏仍由适配器 presentation parts 负责 |
| 图案（hatch 种类、填充几何、dash、图案线段） | `drawing-pattern.js` | 运行时 fill/stroke 结果 + bbox | `rebuild`、`drawInstances` | 复杂线型相位/打印样式仍有部分边界 |
| 布局与视口枚举 | `drawing-layout.js` | `layoutSpacePlan`（纸面 + enabled viewports） | `projectDrawing`、`estimateDrawingDraws` | 视口裁剪仍由裁剪契约执行 |
| 图片位置与资源身份 | `drawing-media.js` | `imagePlacement` / `rasterRecord`（corners、bbox、opacity、media status） | `rebuild`、raster 绘制/命中选择 | 源侧裁剪已烘焙进 PNG；PDF/DWF/DGN 仍部分 |
| 诊断与损失 | 源适配 + 查看器 | coverage/loss、`plotErrors`、控制台告警 | UI、测试 | 统一诊断契约待定 |

## 4. 空间与矩阵契约

- 矩阵为 16 元素列主序（`[m0..m15]`）；`multiply(a,b)` 计算 `a*b`，即先应用 `b` 再应用 `a`。二维点通过 `transformPoint(m,x,y)` 得到 `[m0*x+m4*y+m12, m1*x+m5*y+m13]`。裁剪点云与拾取点使用同一约定。
- 空间链：图元局部 → 所属空间（`localFromOwner`）→ 块/实例所属空间（`localFromBlock`、阵列偏移）→ 模型空间 → 纸面/视口（`modelToPaper`）→ 屏幕（`scale`、`tx`、`ty`、y 翻转）。
- 裁剪输入空间：块裁剪在所属空间（`blockClips`），视口裁剪在纸面空间，part 裁剪在注释局部空间，图片/wipeout 裁剪在实体局部空间；保留实例把它们逆变换到保留组的空间局部坐标。
- 逆变换：`inverse2D` 行列式接近零返回 `null`。保留实例遇到非空裁剪且变换不可逆时抛出 `instanced-projection-clip-transform-not-invertible`，不静默取消裁剪；普通路径仍由 `compileClips` 处理，非法边界/超预算的报告仍是待办。
- 非交换验证：`check_retained_clip_slice.mjs` 使用 90° 旋转 + 非等比缩放 `(2, 0.5)` + 平移 + 阵列 + 块裁剪，逐项比较普通与保留实例的身份、绘制顺序、`localToSpace`、裁剪边界和 `compileClips` 成员关系，并验证逆矩阵往返。

## 5. 阈值与路径选择证据

- `INSTANCE_DRAW_THRESHOLD = 400000`；`shouldProjectInstances(target,count,force)` 只在 `count > 400000` 或显式 `force` 时返回真；`block-preview` 永远走普通投影。
- 399,999 / 400,000 → 普通路径；400,001 → 保留实例；`?instances=1` 仅用于小样本回归。
- `drawing-projection.js` 的 `MAX=400000` 是**单次普通投影的绘制上限**，与保留实例阈值同值但语义不同，不能混用。
- 真实正式图：`1,478,078` 个展开绘制项，查看器 `1,476,219 / 1,478,078` 可见；走保留实例路径。旧基线对大图注释派生/块裁剪明确拒绝；本地 `fff7428` 已解除，改为使用同一 presentation/裁剪契约。

### 大图资源基线（真实正式图）

- 生产等价沙箱（3 GiB cgroup、无 swap、1 核、禁网）：读取 22.6 s / 峰值 VmRSS 2274 MiB；组装 93.5 s / 峰值 1531 MiB；manifest 253.5 MiB 通过校验。2 GiB RSS 采样会在读取阶段中止，资源档位仍待决策。
- 查看器：`1,476,219 / 1,478,078` 可见绘制项；保留实例组与唯一源绘制项计数见 `REPORT`/阶段 A 证据；本文件不把该结果扩展为任意更大图纸的预算承诺。

### 浏览器大图性能（2026-11-02，合成阵列基准）

- 目的：隔离验证“保留实例投影 + 分帧绘制 + 按需命中索引”对主线程停顿的影响，不代表真实 DWG 的绝对耗时。临时基准页只用于本地采集，不进入提交。
- 12 万展开绘制项：修复前首屏同步约 0.76 s、完整画面约 1.64 s、最大主线程间隔约 0.75 s；修复后约 0.19 s、0.53 s、0.18 s。
- 148 万展开绘制项：修复前首屏同步约 3.96 s、完整画面约 8.79 s、最大主线程间隔约 3.97 s；后台 Worker 交互路径超过 25 s 未完成。修复后首屏同步约 1.2 s、完整分帧约 5.5 s；含缩放/适应窗口约 6.3 s，分片最大约 15 ms，首次点选构建命中索引约 0.18 s。
- 路径边界：`INSTANCE_WORKER_PAINT_LIMIT = 200000` 以内优先使用后台 Worker 完整首帧；2026-11-03 起首次打开不再因为尚无可用预览强制走主线程，Worker 启动、字体或提交失败才回退主线程分帧。超过阈值仍使用主线程分帧画布。`ready` 等待实际首帧发布；命中索引仍按需构建。
- 验证：`node --experimental-loader ./tests/three-loader.mjs --test tests/*.test.mjs` 82/82；`check_drawing_instances.mjs` 仍为 799,999 项、3 个唯一源叶；`npm run typecheck`、`npm run build` 与 `build-release.py --check` 通过。当时真实 34 MB / 76 MB 文件仍待在测试机或生产样本复测，不能把合成基准外推为任意大图承诺；34 MB 已在 14:13 轮补测，76 MB 源样本仍缺。
- 测试机部署（2026-11-02 11:29）：`test-20261102-cad-viewer-async-3c622411-1125`，`viewer-aa5e22d1…`、`releaseDigest 987c6311…`；CAD 与 API 的 `engineVersion` 均为 `step-0.3.3/f15a40f5…/gateway-1`，10 / 10 容器 healthy，DWG 既有 API 烟测为 `partial`、manifest 69,197,685 B。正式生产未部署，真实浏览器大图验收仍未执行。
- 测试机真实浏览器回归（2026-11-02 14:13）：34,385,320 B 业务 DWG 在真实 Chromium 中显示 1,476,332 / 1,478,198 项（partial）；3D 打开 147–177 ms、返回二维 81–98 ms；模型 / 布局往返 110–378 ms；首次显示离散化 → 按屏幕重建 4.3–4.6 s，重复切换 214–249 ms，analytic 下模型 / 布局往返 126–224 ms；页面 error 0、console error 0。首次 analytic 长任务仍在，且 JS heap 约 1.40 GB；测试库无 76 MB 源 DWG，不能把本轮结果外推为大图零缺损。
- 测试机交互回归（2026-11-03 15:12）：`test-20261103-1512-cad-preview-controls-38e9b001`；34,385,320 B 业务 DWG 的预览背景滚动锁定 / 恢复、提示条约 1,925 ms 自动关闭、按钮关闭约 42 ms、iframe 悬停提示移除均已验证。原生全屏进入 / 退出和 Esc 防误关仍需真实 Chrome 人工点按确认；全屏自动化会立即释放原生全屏焦点，不能以脚本结果代替人工验收。测试库仍无 76 MB 源 DWG。

- 测试机首开优化（2026-11-03 16:38）：`test-20261103-1638-cad-first-paint-f790edd4`；显示行复用 `representationId`，同一真实 Manifest 的 Node 投影 1,443 → 727 ms（163,000 draws / 453 groups / 1,478,198 展开项）。首帧 `Path2D` 改为按需创建，去掉 163,000 个 draw 的重复 `sort`；真实 34 MB 业务 DWG 的 Worker 首绘成功，14 个分块内部合计 1,038 ms、6,732 次 stroke / 37,565 段，无 `workerError`。复测标签页处于最小化 Chrome 窗口，后台 rAF 节流值 14.1 s / 25.5 s 不作为前台耗时；前台复测仍待完成。

- 测试机首开并行资源预取（2026-11-03 18:50）：`test-20261103-1850-cad-entry-prefetch-fc4a4d60`。完成态任务状态发布 lease、buffer sha256/byteLength（最多 256 项，不含对象存储 key）；真实 34,385,320 B 业务 DWG 的 7,604,739 B br manifest 与 9,199,128 B br 几何 buffer 在 300 ms 内并行发起，API 响应 1,511 ms / 1,815 ms，浏览器解包后到 `buffersHydrated` 为 291–338 ms（旧链路约 1,069 ms）。预取命中仍校验 manifest 引用、长度与 SHA-256，失败或取消回退并释放 lease。两次前台复测 `readyPaint` 为 11.3 s / 15.3 s，仍由 1,478,198 绘制项主导，不作为固定 SLA。

## 6. 待决与兼容事项

1. 显示派生与执行计划是否持久化、是否随 UCD schema 版本升级；旧产物如何读取/重投影/失效。
2. 保留实例下打印样式、复杂线型相位、PDF/DWF/DGN、文字竖排/分栏的完整证据。
3. 统一诊断契约：适配器 loss、投影失败、查看器 `plotErrors` 与浏览器告警的边界。
4. 大图资源预算与路径阈值是否随真实图纸调整；阈值调整必须同时更新本文件和测试。
5. GPU 原型不在仓库、不参与契约；若未来接入，必须消费同一执行计划，不能另定义语义。
6. **版本拆分（已实施，ADR-041）**：`engineVersion` 只含服务器引擎/运行时，`formatVersion` 按 STEP/DXF 独立计算并作为 `cad_artifacts` 缓存键，`viewerVersion` 记录浏览器文件。迁移 `0078` 回填旧产物后首次访问会重建一次；之后浏览器或单一格式改动不再触发另一格式重建。部署仍需 API/worker/CAD 镜像与静态资源同批发布。

## 7. 阶段 B 裁剪纵向切片与阶段 C 文本切片

### 裁剪切片

产物：`server/cad-engine/core/tests/check_retained_clip_slice.mjs`。

场景：一个源块内图元、两行阵列、非交换变换、块裁剪。验证：

- 普通投影展开 2 个绘制项；保留实例只有 1 个唯一源绘制项、`count=2`，不把阵列展开成两个源叶。
- 两条路径的身份（`identity('drawing-draw', ...)`）、绘制顺序、`localToSpace`、裁剪边界（允许 `1e-9` 相对误差）一致。
- `compileClips` 对同一世界点的可见性判断一致，外部点一致排除。
- `inverse2D` 往返验证；不可逆裁剪由定向测试抛出明确错误。

运行结果：

```text
PASS: retained clipping slice keeps identity, order, transform and visible membership for both array copies.
PASS: projection parity and 799,999 instance draws retain three unique source leaves.
```

### 文本切片

产物：`frontend/public/cad-viewer/core/drawing-text.js`、`drawing-text.test.mjs`、`check_retained_text_slice.mjs`。

- 文字提取、高度/方向、对齐/附着点、1.25 行框、DWG `cadTextEm`/`cadLineHeight`/`rectangleWidth` 换行、世界包围盒和诊断统一由 `drawing-text.js` 负责；普通与保留实例共用同一个 `layoutAnnotationText`。
- 原始文字明确输出 `approximations: ['substituted-font', 'canvas-text-layout' | 'cad-em-layout']` 和 `layout`；缺少字体测量回调直接报 `text-measure-required`，不回退为零宽。
- `check_retained_text_slice.mjs` 用块阵列中的原始注释验证：普通投影 2 个绘制项、保留实例 1 个唯一源绘制项，两条路径的锚点、角度、字号、宽度、行框和包围盒在 `1e-9` 内一致。
- 视觉回归：文本样本与图片样本的普通/实例画布与迁移前逐像素 `0` 差异。
- 竖排/镜像/堆叠/MTEXT 分栏仍由适配器生成 presentation parts；本次没有把这些排版算法上移，状态保持“部分”。

### 图案切片

产物：`frontend/public/cad-viewer/core/drawing-pattern.js`、`drawing-pattern.test.mjs`、`check_retained_pattern_slice.mjs`。

- `hatchFillKind` 统一模式判断（图案优先于渐变、渐变优先于实心），`fillGeometryFor` 统一返回 rings/triangles 与 bbox，`strokeSegmentsForRepresentation` 统一图案 hatch 和普通显示几何的索引/非索引线段、点、非法 range 与未知拓扑，`lineDashFor` 统一编译线型、item scale 与 dash 结果；普通与图案路径不再各自实现线段提取。
- 查看器不再自己决定图案 hatch 分支、填充 triangles/rings 或 dash 解析；Path2D 仅由后端根据契约结果构建。
- `check_retained_pattern_slice.mjs` 用块阵列中的实心/渐变/图案 hatch 验证：普通 6 个绘制项、保留实例 3 个唯一源绘制项；两条路径的 rings、triangles、pattern segments、bbox 在 `1e-9` 内一致。
- 视觉回归：wipeout/渐变样本与文本样本普通/实例画布与迁移前逐像素 `0` 差异。
- 复杂线型相位、打印样式 pen 填充 tiles、非等比块缩放的图案相位仍标“部分”；没有因为本切片通过就宣称全部图案能力完成。

### 媒体/布局切片

产物：`frontend/public/cad-viewer/core/drawing-layout.js`、`drawing-media.js`、`drawing-layout.test.mjs`、`drawing-media.test.mjs`、`check_retained_media_layout_slice.mjs`。

- `layoutViewports`/`layoutSpacePlan` 统一 enabled 视口过滤、源顺序、纸面空间和 `modelToPaper`；`projectDrawing` 与 `estimateDrawingDraws` 共用，不再各自遍历 `viewportIds`。
- `imagePlacement`/`rasterRecord` 统一 `imageToEntity × localToSpace` 的四角、bbox、像素尺寸、resourceId、透明度与 media 状态；查看器不再自己读 `geometry.imageToEntity`。源侧图片裁剪由 `dxf_media` 烘焙进 PNG，运行时只保留位置变换。
- `check_retained_media_layout_slice.mjs`：纸面图片 + 视口内图片，布局目标下普通/保留实例的图片四角、bbox、透明度、media 状态和视口裁剪边界在 `1e-9` 内一致；保留实例只有 2 个唯一源绘制项、`count=2`。
- 视觉回归：`image_viewports_full` 的布局图片样本普通/实例画布与迁移前逐像素 `0` 差异。
- PDF/DWF/DGN/OLE 仍只有普通路径测试；布局真实图两个布局为空，不能代表所有纸面/视口组合。

## 8. 验证记录

| 检查 | 结果 |
| --- | --- |
| `node tests/check_drawing_instances.mjs` | PASS（普通/保留投影一致；799,999 项保留 3 个源叶） |
| `node tests/check_retained_clip_slice.mjs` | PASS（裁剪、顺序、变换、身份、可见性） |
| `node tests/check_retained_text_slice.mjs` | PASS（文字锚点、角度、字号、行框、包围盒） |
| `node tests/check_retained_pattern_slice.mjs` | PASS（实心/渐变 rings、图案线段、bbox） |
| `node tests/check_retained_media_layout_slice.mjs` | PASS（纸面/视口图片、裁剪、透明度） |
| `node --test tests/drawing-instances.test.mjs` | 21/21 |
| `python3 server/test/dwg-infinite-line.test.py` | 2/2 |
| `node --test tests/drawing-text.test.mjs` | 6/6 |
| `node --test tests/drawing-pattern.test.mjs` | 5/5 |
| `node --test tests/drawing-layout.test.mjs tests/drawing-media.test.mjs` | 5/5 |
| `node --test tests/drawing-clipping.test.mjs tests/drawing-display.test.mjs` | 11/11（既有） |
| 浏览器样本（仓库外，仅参考） | 文本/图片/wipeout 渐变/布局图片样本普通/实例与迁移前逐像素 0 差异；真实图 fit 仍仅文字抗锯齿 0.25% |
| `npm run typecheck` / `npm run build` | 通过（2026-11-03，首开预取：shared / server / frontend） |
| 资源预取 / 二维定向回归 | 通过（2026-11-03：prefetch 3/3、clipping、instances、packed transport） |

浏览器样本不是 CI 契约测试；矩阵中未列为“已验证”的组合仍按“部分/未验证”处理。

## 9. 后续阶段

- C 已完成文本、图案、媒体/布局切片：文本原始回退收口到 `drawing-text.js`，图案收口到 `drawing-pattern.js`，布局/图片收口到 `drawing-layout.js`/`drawing-media.js`，裁剪切片此前已完成。竖排/镜像/堆叠/MTEXT 分栏、复杂线型相位、打印样式 pen、PDF/DWF/DGN 仍保持“部分”，需要单独证据后才能标为双路径已验证。
- D 宿主侧已完成：移除普通/图案重复线段分支、统一 fill/media/layout 入口，并完成交付检查；版本拆分/缓存策略、目标设备与真实账号验收、部署仍待办。详见 [阶段 D 交付检查](CAD二维显示结构治理-阶段D交付检查.md)。
