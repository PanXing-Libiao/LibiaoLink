# CAD 二维显示结构治理：阶段 A 基线与阶段 B 裁剪切片

- 日期：2026-10-28
- 负责人：wmj
- 范围：二维 CAD 从源数据、上下文解析、执行计划到查看器显示与拾取；三维 STEP 不在本文件范围内。
- 方案： [CAD 二维显示结构治理方案](CAD二维显示结构治理方案.md)；方案检查基线 `a7c9ffe`，本文件基线为当前 `wmj` 工作树（含 `498b0f6`、`1c6de5e`、`fff7428` 及本次治理提交）。
- 部署状态：仅本地 `wmj`，未推送、未部署；测试机 STEP 与生产均不受影响。

## 1. 执行路径盘点

| 路径 | 入口 | 选择条件 | 颜色/样式来源 | 当前状态 |
| --- | --- | --- | --- | --- |
| 普通投影 | `projectDrawing` → `mountDrawingViewer.rebuild` → `draw()` | 非保留实例的 model/layout；块预览也走普通投影 | 投影层解析继承与可见性，查看器绘制 | 仓库主路径 |
| 保留实例 | `projectInstances` → 同一 `rebuild` → `drawInstances()` | model/layout 且 `estimateDrawingDraws > 400000`，或调试参数 `?instances=1`；block-preview 不进入 | 同一 `projectDrawing` 样式解析，实例组复用 | 本地 `wmj`，未部署 |
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
| 文字：简单、替换字体 | 已验证 | 已验证 | 注释局部 → 模型 → 屏幕 | SHX presentation 样本普通/实例逐像素 0 差异；DWG 为替代字体 |
| 竖排、镜像、堆叠、MTEXT 分栏 | 部分 | 未验证 | 适配器排版 + part 局部 | Python 适配器测试存在；保留实例没有同场景契约测试 |
| 实心/渐变/图案 hatch | 已验证 | 部分 | 实体局部 / fill rings | `semantics-fixture`、`gradient-only`、真实图 A–D；复杂图案相位未验证 |
| 复杂线型/相位 | 部分 | 未验证 | 样式编译 + 描边 | 适配器有编译与 presentation 测试；保留实例只消费已展开 part，没有相位差分 |
| 图片/PDF/DWF/DGN/OLE | 部分 | 部分 | 实体局部 + 裁剪 | 图片 model/layout 普通/实例样本通过；PDF/DWF/DGN 只有普通路径测试，保留实例未验证 |
| 布局/视口/纸面 | 已验证（样本） | 已验证（样本） | 模型 → `modelToPaper` → 纸面 | 11 视口 + 5 图片样本；真实图两个布局为空，不能代表全部布局 |
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

## 6. 待决与兼容事项

1. 显示派生与执行计划是否持久化、是否随 UCD schema 版本升级；旧产物如何读取/重投影/失效。
2. 保留实例下打印样式、复杂线型相位、PDF/DWF/DGN、文字竖排/分栏的完整证据。
3. 统一诊断契约：适配器 loss、投影失败、查看器 `plotErrors` 与浏览器告警的边界。
4. 大图资源预算与路径阈值是否随真实图纸调整；阈值调整必须同时更新本文件和测试。
5. GPU 原型不在仓库、不参与契约；若未来接入，必须消费同一执行计划，不能另定义语义。
6. **版本耦合（部署前必须决策）**：`build-release.py` 把 `engineFiles`、`runtimeFiles` 和 `browserFiles` 一起算入 `releaseDigest`/`engineVersion`。本次二维引擎与浏览器改动已重新生成 `source.json`，`engineVersion` 因此变化；按当前缓存键，部署会使 STEP 已完成产物按新版本重建。需要拆分引擎/浏览器/格式版本，或明确接受一次 STEP 重建；在此之前不部署。

## 7. 阶段 B 裁剪纵向切片

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

## 8. 验证记录

| 检查 | 结果 |
| --- | --- |
| `node tests/check_drawing_instances.mjs` | PASS（普通/保留投影一致；799,999 项保留 3 个源叶） |
| `node tests/check_retained_clip_slice.mjs` | PASS（裁剪、顺序、变换、身份、可见性） |
| `node --test tests/drawing-instances.test.mjs` | 7/7 |
| `node --test tests/drawing-clipping.test.mjs tests/drawing-display.test.mjs` | 11/11（既有） |
| 浏览器样本（仓库外，仅参考） | SHX 文本逐像素 0 差异；wipeout/渐变 0.024%；布局图片 0.17%（仅文字抗锯齿）；真实图 fit 0.25% |
| `npm run typecheck` / `npm run build` | 通过（2026-10-28，本次治理提交前） |

浏览器样本不是 CI 契约测试；矩阵中未列为“已验证”的组合仍按“部分/未验证”处理。

## 9. 后续阶段

- C：按文本 → 裁剪 → 图案 → 媒体/布局迁移，逐项补契约测试与矩阵状态；优先处理保留实例下未验证的文字竖排、复杂线型相位、打印样式。
- D：移除被替代分支、更新独立工程能力矩阵与 `source.json` 指纹、同步 `前端功能需求.md`/字段文档，并按仓库规则部署。
