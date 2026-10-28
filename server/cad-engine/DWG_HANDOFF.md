# 原生 DWG → UCD 换机交接（2026-10-27）

交接分支：`wmj`，本次为 Push 304 开发检查点。用户已授权交接后直接推送；没有部署、开放平台 DWG 主图或创建 PR。后续先读本文件，再读 [读取器说明](dwg-reader/README.md) 和 [业务接入计划](../../docs/superpowers/plans/2026-10-27-dwg-native-ucd.md)。

## 先明确当前状态

方向已经确定：**ACadSharp 直接读取 DWG → 独立 DWG 适配器 → 现有 UCD → 现有二维查看器**。不经过 DXF，不调用 DXF 适配器，不再另选转换路线或另起查看器。已有 DXF 收口在 v0.15.0；此次一起保存它和公共 UCD 的未提交基础，保证另一台电脑拉取后具备依赖。不是继续扩展 DXF。

**正式大图曾实际进入现有查看器，但最新版尚未完成同一轮端到端复验。** 旧原型的完整清单通过结构、引用、缓冲及 revision 校验，页面显示约 147.8 万个展开绘制项；产生该清单的进程随后触发 RSS 限制，不能把这次实验记为资源验证通过。新版原生读取已完成，缩短文档内外键、流式清单和新文字排版之后的组装在 300 秒处终止，只有临时清单，不能交给查看器当成功产物。

这台电脑物理内存 8 GiB。换大内存电脑有助于排除系统内存压力，但不会自动解决读取器内存、清单大小、排版或生产沙箱问题。建议用 32 GiB 或以上的开发机继续实验，这是开发便利建议，不是已测得的最低配置或部署预算。

> **2026-10-28 本地补充（未部署）**：查看器已修复非索引 `topology:'lines'` 被当成单点绘制的问题，真实正式图点标记 160,173→844、paint 调用 1,476,219→41,970。用 WSL systemd 复刻生产沙箱（3 GiB、无 swap、1 核、64 tasks、tmpfs 1536/384 MiB、单文件 256 MiB、禁网、只读根）完整跑通真实图：读取 22.6 s、峰值 VmRSS 2274 MiB；组装 93.5 s、峰值 1531 MiB；manifest 253.5 MiB validated，无 OOM。生产 2 GiB RSS 采样会在读取 8.1 s 中止；建议 DWG 读取档 2.5 GiB、组装 2 GiB。12 GiB 测试主机加 CAD 3 GiB 的整机预算仍未决策。沙箱位置：`D:\LibiaoLink-verify\sandbox`，报告：`D:\LibiaoLink-verify\RESULTS.md`。

> **2026-10-28 本机复验补充（未部署）**：公开样本 `sample_AC1027.dwg`（1,091,959 B，SHA-256 `4c63508dd794d5cdfb56c60aded47928999b02619ea8c2ef435a4b74e60d24d6`）重新执行原生读取、UCD 组装和校验，结果为 `partial`：865 个源句柄中 11 个未找回；48 项损失（未显示原生对象 24、代理原语未映射 15、布局视口未映射 3、渐变填充未映射 2、特殊多行文字布局 1、原生显示失败 1、引线箭头 1、读取器缺句柄 1）；3 个 LAYOUT 的 `viewportIds` 均为空，3 个布局没有可见内容，对应 `layout-viewport-unmapped`。浏览器可显示模型并成功拾取线条；本结果不证明纸面布局能力。摘要保存在仓库外 `D:\liniaolink\.cad-work\dwg-review-20261028-native-01\assembly-summary.json`，逐句柄损失见同目录 `native/losses.jsonl`。正式 34,385,320 B 大图使用此前已校验产物在当前查看器打开约 147.8 万个绘制项；关闭图层后可见项减少，重新打开后恢复；按原句柄 `13EB13` 定位成功；首次就绪约 10.5 秒。该图第一个布局为空，不能用它验证纸面视口；10.5 秒只是本机无头 Chrome 的这一次运行，不是性能或资源验收。`dev/dwg-local.py` 的页面 HTML 读取已固定为 UTF-8；此前 Windows 默认代码页会在读取含中文的 `index.html` 时抛编码错误，`python -X utf8` 只是绕过该缺陷。回归 `server/test/dwg-local-encoding.test.py` 在正常与 `LC_ALL=C PYTHONUTF8=0` 下均通过；强制非 UTF-8 环境启动本机服务时 `/` 返回 200 且中文标题正常。

## 2026-10-28 阶段 A 状态（本机，未部署）

依据 `docs/DWG预览缺口分级与实施计划.md`。两份样本都用当前查看器（`95fc7ae` 及本次默认视图/样条修复）重开，并用本机 DWG FastView 9.10 做独立定性对照；本机没有 AutoCAD，计划要求的“原 CAD 逐区域对照”仍是未验证项，不能把 FastView 对照写成原 CAD 或像素级通过。截图与探针 JSON 在仓库外 `D:\LibiaoLink-verify\cad-samples\review\`。

| 能力 | 状态 | 证据与说明 |
|---|---|---|
| 正式图主体与交互 | 已验证（本机定性） | 缩放到主体范围 `x≈458k–864k` 后，主体、立面、货架与 FastView 一致；图层开关、句柄 `13EB13` 定位通过；约 147.8 万展开项。 |
| 默认适应视图 | 已修复（本机验证） | 原生读取器保留 `$EXTMIN/$EXTMAX` 模型范围，查看器模型空间默认 `fit()` 采用；正式图源范围 `x=[258909,902704]`、`y=[-70776,286355]`，默认比例 0.002237，几何全图比例 0.000661（约 3.39 倍），主体可读；`fitAll()` 仍显示含 x≈2.44M 远处对象的全图。 |
| 中文/换行/字体 | 可用但近似 + 未验证 | 使用替代字体；主体区域中文可见，但密集处有重叠；未逐区域对照原 CAD，不能称为排版通过。 |
| 尺寸文字/标注 | 可用但近似 | 复用已存标注图形块；1491 个文字、1919 个标注项；未逐项核对测量值与箭头。 |
| 引线/多重引线 | 已验证（默认箭头/代理默认） | 60 个默认 LEADER 箭头已映射，leader-arrow 损失 0；18 个 MULTILEADER 的默认子实体状态（图层 0/线型 32767/厚度 0/打印样式 ByLayer）已按顺序处理，proxy 损失 0；非默认子实体状态仍保留逐句柄损失（本图 0）。 |
| 块/属性 | 未验证 | 427 个可达块、6287 个实例；属性文字未逐项对照，非零基点/属性放置仍未验证。 |
| 遮罩/图片/PDF 底图 | 部分缺失 | 公开样本 WIPEOUT `44D` 已按边界生成白色预览遮罩（不是 mask part，不拦截拾取）；IMAGE、PDFUNDERLAY 仍缺外部资源和原生映射；真实图未提供这些组合。 |
| HATCH/多环/渐变 | 部分缺失 + 未验证 | 真实图 169 个可达填充；公开样本 2 项渐变未映射；多环、Outer 与孔洞未逐区域对照。真实图默认视图中的横向黑带和文字黑底尚未逐对象确认，可能是源黑色 SOLID/填充或遮罩在白底上的显示；FastView 黑底不可见，不能仅凭两边截图判为缺陷，需原 CAD 白底对照。 |
| 布局视口 | 部分缺失 | 公开样本 3 个布局无可见内容，对应 3 项 `layout-viewport-unmapped`；业务是否需要布局仍未确认。 |
| REGION/MLINE/XLINE/MESH/3DFACE 等 | 部分缺失 | 真实图修复前 22 项未显示原生对象；XLINE 已按通用映射修复，20 个 REGION 已按平面 ACIS 边界映射（见平面 REGION 节），当前仅 1 个 MLINE 未显示。公开样本 XLINE/RAY 映射后未显示原生对象 22；保留源句柄、原载荷和损失，不伪造几何。 |
| 样条显示 | 已修复一个上游求值缺陷（本机） | ACadSharp 3.8.30 对控制多边形远离原点的周期 SPLINE 可能把首顶点求值为 `(0,0,0)`，形成原点至样条的假线并遮挡主体；读取器仅在该首点为零且控制多边形不在原点时丢弃，`--self-test` 同时覆盖零起点与合法原点起点。`dwg-formal-windows-04` 复验：句柄 `272226` 首点回到样条本身，默认视图黑带消失；缓冲区比上一产物少 3,936 B，多处周期样条的零起点一并清理。 |
| 读取账本 | 已验证账本 | 真实图 902,137 个源句柄、0 未找回、2 项损失（1 MLINE + 1 头字段）；公开样本 865 个中 11 个未找回、29 项损失（XLINE/RAY、默认 LEADER、WIPEOUT、默认 MULTILEADER 子实体映射后）。句柄找回不是字段、几何或工程语义完整，也不是漏绘百分比。 |
| 容量 | 本机观察 | 本次无头 Chrome 8.3–8.5 秒就绪、JS 堆约 757 MB、manifest 253.5 MiB；WSL 沙箱读取 22.6 秒/2274 MiB、组装 93.5 秒/1531 MiB。都不是生产资源验收。 |
| 平台接入 | 未接入 | DWG 主图开关仍关闭；本机页只作验证，不接 file/preview、任务或缓存。 |

本次实现：`Program.cs` 的 `native-summary.json` `header` 新增 `modelSpaceExtMin/Max` 与 `paperSpaceExtMin/Max`；适配器原样带入 `org.libiaolink.dwg/1.header`；查看器模型空间默认 `fit()` 采用源范围，要求有限、正向、不超过计算范围 4 倍且覆盖 ≥50% 可见绘制，否则回退，新增 `fitAll()` 取计算全图。读取器重建于 `dwg-build-windows-04`，DLL SHA-256 `62d95952c7896b1eaca5a8336af407bbc68e8528602dd9783a1a5e4926a7021c`；公开样本 `dwg-public-small-05` 校验通过；正式图 `dwg-formal-windows-05` 重新原生读取（7.75 s / 总计 13.00 s，托管提交 2.81 GB）并组装（81.02 s），manifest 265,835,098 B 校验通过；默认视图与 `fitAll` 证据在仓库外 `review` 目录。本机页静态模块改用 `Cache-Control: no-store`，避免编辑后浏览器使用旧模块。

读取器源码/二进制目前不进入 `build-release.py` 的 `engineDigest`（`Program.cs` 位于 `dwg-reader/`，不在 `core/` 哈希集）；每次产物在 `native-summary.json`/UCD 记录 `readerSha256`，本次为 `4e5a8110…`。DWG 格式/缓存身份和读取器版本键按计划留到阶段 D，不能把当前产物只追溯到 `releaseDigest`。

首批待办（按计划 §4）：

- **必须处理候选**：业务确认需要布局后，只做二维矩形俯视视口。默认适应视图已按源范围修复并通过正式图复验。
- **说明即可（待逐句柄确认影响）**：替代字体近似、引线箭头、代理/未显示对象、渐变与多环填充。
- **暂不承诺**：三维编辑/求解、完整 ACIS/专有对象、动态块重算、透视或三维视口、全部字体像素一致。
- **未验证**：原 CAD 逐区域对照；真实图的块属性、尺寸文字、遮罩/图片组合。

标准说明已在本机页顶部使用：“当前为二维部分预览；缺少原配套字体或资源，文字使用替代字体，未支持对象可能影响显示，必要时请下载原文件查看。”并按 `lossCounts` 追加具体类型。适配器 `presentation.note` 仍是英文技术说明，阶段 D 接入平台时与 DWG 格式身份一并替换，避免现在只改字符串触发引擎版本变化。本机页只增加 `window.__dwgLocal.viewer` 句柄用于本机核对，没有新增诊断平台或报表系统。



## 2026-10-28 FastView 文字/尺寸/引线定性对照（本机，未部署）

对照对象：正式图 `dwg-formal-windows-05`；FastView 9.10 的 `fastview-real-fit.png` 与当前查看器默认视图/局部放大。FastView 的视图带轴向旋转且缩放不同，本机也没有 AutoCAD，因此只能做定性对照，不能当作像素、位置或测量值验收。证据裁剪在仓库外 `D:\LibiaoLink-verify\cad-samples\review\`（`text-region.png`、`crop-racks-*.png`、`crop-tote-*.png`）。

| 项目 | 观察 | 结论 |
|---|---|---|
| 关键文字 `Racks positioning reference` | FastView 为红色多行，带青色引线和实心箭头；当前查看器为红色三行，默认 LEADER 映射后为红色实心三角箭头 | 文字内容、颜色和落点存在且放大可读；换行、字号和引线颜色不同，箭头形状已恢复。 |
| `Tote position quantity：24320` | FastView 截图中为绿色、随场地轴旋转（其视图扭转）；当前查看器在模型坐标下为黑色水平文本 `annotation-70898`，使用替代等宽字体 | 文本存在且可读；未能把两处绑定为同一实例，颜色/旋转差异不等于缺字，仍需原 CAD 或同视图复核。 |
| 标高/尺寸文字 `58.xx` | FastView 显示粉色/绿色标高文字；UCD 保留同层 `58.xx` 标高文字（如 `annotation-36227C` 的 `58.85`），查看器按文字/存储块绘制 | 未逐标签一一对应；文字可读，尺寸测量值和箭头未逐项核验。 |
| 尺寸实体 | UCD 保留 280 个 `dimension` 实例及其存储标注图形块；查看器复用存储块，不重算尺寸 | 图形块和文字存在；未把任一尺寸与原 CAD/FastView 逐箭头核验，保持“可用但近似/未验证”。 |
| 引线 | 60 个默认 LEADER 箭头已按 `ArrowSize/方向` 映射；Racks 两端为红色实心三角；自定义箭头块/无方向仍保留损失 | 默认箭头已修复；FastView 青色与当前红色是颜色差异，不再是缺箭头。 |

结论：关键文字、标高/尺寸文字和引线线体都存在，采样范围内没有发现整段缺字或尺寸块丢失；默认 LEADER 箭头已映射，但没有完成原 CAD 逐区域、尺寸测量值和自定义箭头、同视图像素位置核验，不能把本轮写成尺寸或排版通过。


## 2026-10-28 普通填充与遮罩定性对照（本机，未部署）

同一正式图 `dwg-formal-windows-05`。FastView 截图是另一缩放/扭转视图，填充区域不能逐块对齐；以下以 UCD 填充语义、查看器像素采样和两边可见的同类标记为准，不写成图案或颜色验收。

| 项目 | 观察 | 结论 |
|---|---|---|
| 实心填充 | 169 个可达 HATCH 全部 `IsSolid:true`、`pattern=SOLID`；UCD 有 660 条 fill 记录，查看器 built 673 个 `fillPath`/732 rings。颜色以 cyan 190、magenta 50、orange 19、深蓝 6、黄色 3 和 386 条 by-block 为主 | 普通实心填充有产物；抽样橙色填充 `pixelAtWorld` 为 `[254,127,1]`，白底外部采样为白。未逐块核对所有颜色。 |
| 图案/渐变 | 可达 HATCH 没有图案或渐变；公共样本仍有 2 项渐变未映射 | 正式图没有可对照的图案/渐变使用；不能据此宣称图案 HATCH 或渐变已支持。 |
| 多环/孔洞 | 唯一的近景多环填充 `entity-4587F` 是 4 个分离矩形，不是孔洞；15 环填充在模型范围外且很小。没有 Outer/岛屿案例 | 正式图没有可用的孔洞/Outer 对照；保留“未验证”，不把分离环当作孔洞通过。 |
| 黑色填充/底衬 | 黑色标题块和 by-layer 填充在 UCD 中存在；FastView 黑底不可见，当前查看器白底显示为黑。默认视图原先的横带已确认是周期样条假线，不是填充 | 白底/黑底的显示差异不是缺填；不要再把黑带归为填充缺陷。 |
| 遮罩 | 正式图源码没有 WIPEOUT/IMAGE/PDFUNDERLAY；公共样本的 WIPEOUT、IMAGE、PDFUNDERLAY 在 24 项未显示原生对象内，且没有外部图片/PDF 资源 | DWG 原生链路没有可验收的遮罩/图片/PDF 底图产物；查看器的 DXF 遮罩/媒体路径不能替代。保持部分缺失说明。 |

结论：正式图的普通实心填充可见、颜色和白色背景采样正常，采样范围内没有新的填充遮挡缺陷；没有图案、渐变、孔洞或遮罩案例可做通过结论。FastView 与当前查看器只能确认两边都有同类彩色填充标记，未做逐块像素对照；证据裁剪在仓库外 `D:\LibiaoLink-verify\cad-samples\review\`（`crop-fill-*.png`、`fill-pixels.json`）。


## 2026-10-28 代理与未显示对象逐句柄影响（本机，未部署）

来源（修复前）：`dwg-formal-windows-04/native/losses.jsonl` 的 40 条 `proxy-primitive-unmapped`/`unsupported-native-presentation`，加一次只读 ACadSharp 句柄探针（仓库外 `D:\LibiaoLink-verify\handle-probe`）。40 条完整覆盖 18 个 MULTILEADER、20 个 REGION、1 个 MLINE、1 个 XLINE；没有其他未列出的句柄。XLINE、默认 LEADER、默认 MULTILEADER 子实体和 20 个平面 REGION 都已分别处理；`dwg-formal-region-02` 当前为 2 条总损失（1 MLINE + 1 头字段）。

### 18 个 MULTILEADER（代理子实体样式）

全部在模型空间、图层 `0`。文字和引线代理几何都在 UCD 中；本轮已把默认子实体状态（图层 0、线型 32767、厚度 0、打印样式 ByLayer）按顺序处理，当前 `proxy-primitive-unmapped` 损失为 0；非默认子实体状态仍会保留损失。它们承载的是安装说明，内容存在且可读。

| 句柄 | 文字（模型坐标） |
|---|---|
| `4EFB5` | `Top tie rod`（596733, 231313） |
| `7608F` | `车道线 (Brown & Green)` / `Lane line`（602154, 38747） |
| `157F93` | `3*Floorbot passage doorway 0.8m height`（601908, 33078） |
| `1D2732` | `Cable tray passing through wall, hole cutting required.`（767594, 32788） |
| `514403` | 同上（839465, 25169） |
| `36C89C` | `配电箱建议安装位置…` / `Suggested installation position of distribution box`（751319, -30825） |
| `385B29` | `Cable Tray（Bridge）` / `Suggested height：5m`（766901, 34836） |
| `460816` | `Cable Tray（Bridge）` / 高度说明（767769, 54410） |
| `522E23` | 同上（769030, 47718） |
| `522E35` | 同上（840308, 66709） |
| `522E36` | 同上（840891, 63928） |
| `530BAE` | 同上（847725, 30131） |
| `530BAF` | 同上（833273, 24757） |
| `53233E` | 同上（806774, 68084） |
| `53240D` | 同上（745235, 56753） |
| `54E143` | 同上（748245, 57073） |
| `54E16A` | 同上（763267, 56343） |
| `54E1F7` | `Interlock system control box` / `Height：1.2m 可现场调整`（578859, 61699） |

结论：18 个均为“可用但近似（子实体样式）”，不是必须补的缺字/缺引线；若后续要求打印线宽/线型一致，再按打印样式专项处理。

### 20 个 REGION

句柄 `1577D6/1577D7/1577D8/1577D9/1577DE/1577DF/1577E2/1577E3/1577E6/1577E7/1577EA/1577EB/1577EE/1577EF/1577F2/1577F3/1577F6/1577F7/1577FA/1577FB`，均在块 `百特立柱（一小段）`、图层 `粗实线`，ACIS 载荷 2,470 或 3,051 B。块内同时有 20 个圆弧和 1 个多段线作为 2D 轮廓；块实例在模型空间 `(18209,-438)`、`(20074,-438)`，局部范围约 `x=711949..711967, y=-22728..-22716`，世界位置约 `x=730158..732041, y=-23166..-23154`。当前查看器画出 2D 弧/多段线，未显示 REGION 自身 ACIS 边界；本轮不宣称 2D 填充或 3D 实体完整。若业务需要立柱体的 3D/填充语义，再按 REGION/ACIS 专项处理。

### 1 个 MLINE

句柄 `6B891A`，块 `35435.00_600.00_7053.00_-90.00_1_Row_…`，父块 `货架立柱更新后` 在模型空间 `(503960,19677)`、`(670295,12747)`、`(742157,25227)`。MLINE 是块内一条 3 顶点线（局部起点 `(0,35462.5)`），世界位置落在货架区域；当前未绘制。没有关联文字或面积，影响限于货架详图中的一条线，按“说明即可/待业务确认”，不把它当作主体缺失。

### 1 个 XLINE（修复前）

句柄 `738AAE`，模型空间、图层 `0`，起点 `(643784,43284)`，方向 `(0,1,0)`，即 x=643784 的竖直构造线。默认视图在屏幕 x≈940.9 处采样 y=0..200000 的 7×1 像素带全部为白，说明它确实没有绘制，也不是被其他线覆盖。已在下一节按通用 XLINE/RAY 映射修复；修复后该句柄为红色无限线。

### 本轮结论

- 18 个代理对象：默认子实体状态已处理，当前 proxy 损失为 0；非默认状态仍会保留。
- 20 个 REGION：块内 2D 弧/多段线轮廓存在，当时 ACIS 实体未显示；已由后续“平面 REGION 边界”节按平面 ACIS 边界补上，填充/3D 语义仍不完整。
- 1 个 MLINE：STANDARD 样式、`ScaleFactor=20`、两个元素偏移 ±0.5（约 ±10 世界单位），中心线 3 顶点；完整显示需要 miter/接头求值，中心线近似会漏掉两条元素线，保留明确损失。
- 1 个 XLINE：修复前 x=643784 的竖直构造线确实缺失；已按通用 XLINE/RAY 映射修复，见下节。
- 没有新的整对象/整段文字缺失；上述结论只覆盖这 40 个句柄，不代表其他未列对象。


## 2026-10-28 XLINE/RAY 通用映射（本机，未部署）

按阶段 B 的通用方案修复，不做单句柄特例：

- 读取器 `Program.cs` 新增 `XLine`/`Ray` 分支，把参数 `origin/direction` 写入 `infiniteLines`，实体行保留源句柄/图层/样式，不再记 `unsupported-native-presentation`；零方向抛 `native-presentation-failed`，不伪造有限线段。
- 适配器 `dwg_adapter.py` 把 `infiniteLines` 映射到 `org.cad-preview.annotation-presentation/1` 的 `role:'infinite'` part（与 DXF 同一契约）；查看器无需改渲染，继续按当前视图裁剪、排除出 fit 范围、按锚点回退。
- 样本 `dwg-public-small-05`：2 个 XLINE/RAY item，损失 48→46，`unsupported-native-presentation` 24→22；`dwg-formal-windows-05`：1 个 XLINE item（`entity-738AAE`，origin `(643784.4,43284.4)`，direction `(0,1)`，源色红），损失 101→100，未显示原生对象 22→21。正式图默认视图屏幕 x≈940.9 的 7×1 像素带在 y=0..200000 由全白变为红色抗锯齿 `[255,133,133]`/`[255,186,186]`；built 1,476,219→1,476,220、presentationParts 162,337→162,338、paintCalls 41,361→41,362；fitScale 0.002237、fitAll 0.000661 不变，说明无限线未进入有限范围。
- 读取器重建 `dwg-build-windows-04`，DLL SHA-256 `62d95952c7896b1eaca5a8336af407bbc68e8528602dd9783a1a5e4926a7021c`；正式图 manifest 265,835,098 B validated，组装 81.02 s，原生读取 7.75 s / 总计 13.00 s；样本 manifest 806,102 B validated。适配器单元测试 `server/test/dwg-infinite-line.test.py` 2/2。
- 本节时 20 个 REGION 和 1 个 MLINE 仍保留；REGION 已由后续“平面 REGION 边界”节补上，MLINE 见“MLINE 条件升级判定”节。60 条默认引线箭头也已由后续 LEADER 节处理。


## 2026-10-28 MLINE 条件升级判定（REGION 已另补）

按计划 §6 的升级触发逐项核对：REGION 已由用户接受 ACIS 依赖后在“平面 REGION 边界”节补上；本节只保留 MLINE 的不升级判定，不新增 MLINE 内核或中心线近似。

- **20 个 REGION**：已由用户接受 ACIS/ezdxf 依赖后在“平面 REGION 边界”节补上，20 个都解析为 6 条平面边界线；本节原先的不升级判定已被覆盖。
- **1 个 MLINE**：句柄 `6B891A` 在货架行块 `35435.00_600.00_7053…` 内，是 STANDARD 样式、`ScaleFactor=20`、两个元素偏移 ±0.5（世界约 ±10）的多线，中心线 3 个顶点；没有关联文字或面积。只画中心线会漏掉两条元素线，完整显示需要 miter/接头/端帽求值，DXF 路径同样没有映射 MLINE；本轮不做近似，保留说明。触发条件（影响主体或关键标注）未出现。
- 结果：真实图当前 2 条损失（1 MLINE + 1 头字段），20 个 REGION 已不再计入；REGION 的 ACIS 原载荷仍保留在 `native/opaque-*.bin`，平面的 3D/实体语义仍未支持。


## 2026-10-28 LEADER 默认箭头映射（本机，未部署）

- 60 个 `leader-arrow-presentation` 句柄全部 `ArrowHeadEnabled=True`、`DimensionStyle.LeaderArrow=None`（默认箭头）；样式 Standard 57 个、DEX-020 2 个、Robots-100 1 个，`ArrowSize` 分别为 120、2.5、0.75。
- 读取器在首顶点沿首段生成默认闭合填充三角形（长 = `ArrowSize`，半宽 = `ArrowSize/6`），作为 leader 的派生 polyline + fill，`sourceRefs` 指回 leader；自定义箭头块、无第二顶点或 `ArrowSize<=0` 仍记 `leader-arrow-presentation`，不伪造。`--self-test` 覆盖默认形状和零尺寸拒绝。
- 正式图 `dwg-formal-windows-06`：损失 100→40（引线箭头 60→0；其余 21 未显示原生对象 + 18 代理 + 1 头字段）；公开样本 `dwg-public-small-07` 46→45（样本引线 1→0）。built 1,476,220→1,476,280，presentationParts 162,338→162,398，fills 673→733（792 rings），paintCalls 41,362→41,469，uniqueSourceDraws 162,880→163,000；默认源范围和 fit 比例不变。
- Racks 两条 LEADER `7385E8`/`7385E9` 的箭头已显示为红色实心三角（`leader-racks.png`）；FastView 的青色引线/箭头颜色差异仍在，属于样式而非缺箭头。
- 读取器重建于 `dwg-build-windows-06`，DLL SHA-256 `4eb9b1a6ba41103a1f1a0933746494f2123921de0e54c8b8efb0ff026f7fba26`；正式图 manifest 265,971,008 B validated，组装 84.37 s，原生读取 7.63 s / 总计 12.99 s。只改读取器，无适配器、查看器、`source.json` 或版本变化。


## 2026-10-28 WIPEOUT 与 MULTILEADER 子实体样式（本机，未部署）

### WIPEOUT 遮罩

- 读取器新增 `Wipeout` 分支：按 DXF/ezdxf 的图像边界公式（`insert + u/2 - v/2`，裁剪顶点为像素坐标，`y` 从顶部计）计算 WCS 多边形；有裁剪边界用裁剪多边形，两点按矩形展开，无裁剪用整幅图像边界。输出为白色填充多边形，源句柄仍指回 WIPEOUT。
- 这是**预览遮罩**：在白色背景上盖住下面的图形，不是查看器的 mask part，因此不拦截拾取；有非零裁剪/无图像尺寸/边界不足时记 `wipeout-boundary-invalid`，不猜。
- 公开样本 WIPEOUT `44D`：4 点多边形 `(271.921,3.988)…(272.677,35.696)`，损失 45→44（`unsupported-native-presentation` 22→21）。正式图没有 WIPEOUT，不受影响。IMAGE/PDFUNDERLAY 仍缺外部资源，不冒充已支持。

### MULTILEADER 子实体样式

- 读取器不再把这四类代理记录一律当失败，而是按出现顺序维护 layer/line-type/thickness/plot-style 状态，应用到后续代理图元：
  - `SubentLayer`：按文档图层索引解析，越界才记损失；
  - `SubentLineType`：`ByLayer/ByBlock` 和 16 位默认值 `0x7FFF` 保留图元原样式；具体索引可解析则应用，越界才记损失；
  - `SubentThickness`：本图观察值全为 0，零为无操作；非零在 2D UCD 没有厚度通道，仍记损失；
  - `SubentPlotStyleName`：`ByLayer/ByBlock` 或索引 0 为无操作，具体打印样式仍记损失。
- 真实 18 个 MULTILEADER 的代理序列都是默认状态（图层 0、线型 32767、厚度 0、打印样式 ByLayer），因此 `proxy-primitive-unmapped` 18→0，文字/引线/位置不变；公开样本同样的 15 条代理损失消失。未来文件如果出现非默认子实体状态，能解的就应用，不能解的仍保留逐句柄损失。
- 读取器重建于 `dwg-build-windows-08`，DLL SHA-256 `b525832151849051DD982456AA6C22E601389932946D194EA5E7150EB9A04DDF`。
- 当前损失：正式图 `dwg-formal-windows-07` 22 条（21 未显示 + 1 头字段；代理、引线、XLINE 均 0）；公开样本 `dwg-public-small-09` 29 条（21 未显示 + 2 渐变 + 1 特殊多行文字 + 1 原生失败 + 3 布局 + 1 缺句柄）。正式图 manifest 265,963,894 B validated，组装 85.62 s，原生读取 7.58 s / 总计 12.64 s；样本 manifest 805,005 B validated。
- 只有读取器变化，无适配器、查看器、`source.json` 或版本变化。


## 2026-10-28 平面 REGION 边界（本机，未部署）

用户接受 ACIS/ezdxf 依赖后，按第三优先级补上：

- 20 个 REGION 的 ACIS `BinaryFile` 载荷全部通过既有 `dxf_region` 的平面 SAT/SAB 读取器解析，每个得到 6 条 LINE 边界；`dxf_region.py` 本身未改动，DXF 格式键仍为 `dxf-0.15.0/556c616e…`，不需要重建 DXF。
- DWG 适配器把边界线段追加到现有 `positions.bin`（每个点 f64、每段 u32 索引），生成 20 个 REGION presentation item、120 个 `geometry` parts；原 UCD 实体仍保留 `unsupported` 源几何和 `sourceRefs`，20 个 ACIS 原载荷继续在 `native/opaque-*.bin`。
- 成功解析的 REGION 不再计入 `unsupported-native-presentation`；解析失败（非平面、未知曲线、依赖缺失）保留原损失，并加 `region-acis-boundary-unavailable` 诊断，不猜边界。
- 正式图 `dwg-formal-region-02`：损失 **22→2**（仅 1 个 MLINE + 1 个头字段）；manifest 266,135,331 B validated，buffer 76,063,992 B，组装 82.42 s；built 1,476,280→1,476,320，presentationParts 162,398→162,518，paintCalls 41,469→41,505；fitScale/fitAll 不变。放大到 `(729900,-23300..732300,-22900)` 时 REGION 六条边与既有 2D 弧/多段线重合，不新增可见缺口（`region-final2.png`）。
- 依赖：`server/cad-engine/requirements-dwg.txt`（numpy 2.5.4、typing_extensions 4.16.0、pyparsing 3.3.3、fonttools 4.67.0、Pillow 13.0.0）；适配器从仓库 `core/vendor/ezdxf/src` 导入 ezdxf 1.4.2，不安装另一份 ezdxf。本机验证用 Python 3.13 + 这套 Windows wheel；没有依赖时 REGION 继续是显式损失，不影响其他类型。
- 这是**平面边界**读取，不是 ACIS 内核：不做布尔、3D、体积或非平面曲面；REGION 的 3D/实体语义仍未支持。公开样本没有 REGION，损失仍为 29。
- 适配器改动使 `engineVersion` 变为 `step-0.3.3/4cc8fc50…/gateway-1`、`releaseDigest` 为 `5bed9677…`；STEP/DXF 格式键和 `viewerVersion` 不变。


## 2026-10-28 阶段 B 收口（本机，未部署）

- 正式图 `dwg-formal-region-02`：**2 条损失**（1 个 MLINE + 1 个头字段颜色）；代理、默认 LEADER 箭头、XLINE/RAY、20 个平面 REGION 均已映射。公开样本 `dwg-public-small-09`：29 条损失（21 未显示 + 2 渐变 + 1 特殊多行文字 + 1 原生失败 + 3 布局 + 1 缺句柄）。
- 已验证可用：模型主体、默认源范围视图、图层显隐、句柄定位、文字/标注、默认 LEADER 箭头、实心填充、XLINE/RAY、平面 REGION 边界、WIPEOUT 预览遮罩、默认 MULTILEADER 子实体状态；正式图约 147.8 万展开绘制项，viewer built 1,476,320。
- 可用但近似：替代字体和复杂 MTEXT 排版、自定义 LEADER 箭头、非默认代理子实体样式、WIPEOUT 是白色预览遮罩而非可拦截拾取的 mask part。
- 未验证或条件项：原 CAD 逐区域尺寸/排版；布局视口（业务未确认）；IMAGE/PDFUNDERLAY（缺外部资源）；非平面/3D REGION；平台 file/preview/任务/缓存与目标环境部署（按用户要求停在本地）。
- MLINE 1 条：STANDARD 样式、`ScaleFactor=20`、两个元素偏移 ±0.5（约 ±10 世界单位），中心线 3 顶点；没有完整 miter/接头求值就不画中心线，保留明确损失。


## 2026-10-28 原生文字多行排版修复（本机，未部署）

- 问题：`drawing-text.js` 的原生 CAD 分支先调用 `measureTextLines`，把返回的整段行框高度（`size × 1.25 × 行数`）当成 `cadTextEm`/`cadLineHeight` 的输入；字体和行距随行数放大。正式图 `157EE0` 的 18 行英文被排成 348 行，`7C927` 的 6 段中英文膨胀到 90 行，造成局部注释大面积重叠。
- 修复：原生分支直接按源单行高度计算 `cadTextEm`（×4/3）和 `cadLineHeight`（×5/3），不再使用整段测量高度，也不额外乘 1.25 行框；`rectangleWidth` 仍是换行上限。`cad-text-layout.js` 为无空格中文长句增加按字形的断行机会，避免整段中文超出 `rectangleWidth`。
- 结果：`7C927` 从 90 行回到 19 行、`157EE0` 从 348 行回到 25 行、`1576F2` 回到 18 行；正式图文字仍为 1,491 项、built 1,476,320，默认视图和 `fitAll` 比例不变。放大到注释区后字号/行距不再随行数膨胀，文字恢复可读；源图中相邻的 `7C927` 与 `1576F2` 文本块仍有源位置重叠，本节的字号修复不移动任何源锚点，显示级避让见下一节。
- FastView 能打开正式图，`Racks positioning reference` 在 FastView 和各查看器中均正常分行；本轮注释块没有完成同区域 FastView 导航（其启动页登录/VIP 遮挡），所以不以 FastView 通过作为验收结论。源 UCD 的 `7C927`、`1576F2`、`157EE0`、`157F8F` 等文本、高度、宽度和锚点已逐条核对，证据截图在仓库外 `D:\LibiaoLink-verify\cad-samples\review\formal-notes-close-final.png`。
- 回归：`drawing-text.test.mjs` 9/9（新增多行、中文断行和显示框用例）、绘图测试 50/50、`check_retained_text_slice.mjs` 与 `check_drawing_instances.mjs` 通过；`npm run typecheck`、`npm run build` 通过。`viewerVersion = viewer-5c952e5d…`、`releaseDigest = 27d94661…`；`engineVersion`、STEP/DXF 格式键不变。


## 2026-10-28 注释显示避让（本机，未部署）

- 仅对原生 DWG 的原始注释文字生效，源 UCD、源句柄、`annotation.position` 全部不变；查看器在绘制阶段给文字增加 `displayX/displayY`，最大文本框保持原位，较小的重叠文本框按最小位移移到最近的空边。
- 每个被移动的文本框从源锚点画一条灰色虚线引线和小圆点回到原位置；源位置仍可定位，移动只影响画面。命中/选择框使用显示框，`setTextAvoidance(false)` 可关闭避让并恢复源位置；DXF 不启用该策略。
- `drawing-text-avoidance.js` 采用最大面积优先、确定性排序和候选边搜索；`textDisplayBox` 把多行行距计入碰撞框，不再只用单行 em 框。正式图 `7C927`/`1576F2` 的局部重叠在显示上分离，源图仍保持原锚点；证据 `D:\LibiaoLink-verify\cad-samples\review\formal-avoid-notes.png`。
- 回归：`drawing-text-avoidance.test.mjs` 2/2、`drawing-text.test.mjs` 9/9、绘图测试 50/50；`npm run typecheck`、`npm run build` 通过。`viewerVersion = viewer-5c952e5d…`、`releaseDigest = 27d94661…`；`engineVersion`、STEP/DXF 格式键不变。


## 2026-10-28 DWG 平台接入第一片（本机，未部署）

- 平台契约新增 `DWG`：shared `CadFormat`、`cad-inputs`、CAD worker/仓库/预览入口、`cad_artifacts` 与迁移 `0070_cad_dwg_format.sql`。DWG 不接受配套文件或主图相对路径，结果始终为带明确损失说明的 `partial`。
- 新增 `core/dwg_platform_convert.py` 平台 worker：从 stdin 接收原字节，调用固定 ACadSharp 读取器与既有 `assemble_native`，再通过 `FileSink` 输出现有 UCD 二进制传输。运行时由 CAD 沙箱提供 `CAD_DWG_PYTHON`、`CAD_DWG_READER`、`CAD_DWG_DOTNET`；未配置时明确失败，不静默退回 DXF。
- 平台特性开关 `CAD_DWG_ENABLED` 默认 `false`，本机只验证代码路径；未启用时预览仍显示暂不可用并保留下载。已在公开样本上跑通 worker 输出（805,623 B manifest / 171,216 B buffer）；正式大图尚未在平台沙箱调度，原生读取约 2.7 GiB 托管内存、manifest 约 266 MB，目标 Linux 资源档位仍需验收。
- 资源/门禁：DWG worker RSS 采样档 3 GiB、结果/产物上限 512 MiB、manifest 读取上限 512 MiB、沙箱单文件上限 512 MiB；这些是首版预算，不能当作生产容量结论。
- 2026-10-29 本机完整系统验证尝试：`server/scripts/local-system-prepare.mjs` 在本机 Docker 检查处退出（当前环境没有 Docker，也没有 `.runtime` 的 PostgreSQL/MinIO/Casdoor 与 CAD 沙箱）；上传、任务、产物归档和查看器全链路没有执行，不能记为通过。只完成了平台 worker 的公开样本输出和 API/CAD 定向测试；后续需先启动本机 Docker/本地服务与原生运行时，再重跑全链路。
- 版本：`engineVersion = step-0.3.3/c579bb86…/gateway-1`、`formatVersions.DWG = dwg-0.1.0/1171f7ec…/gateway-1`、`releaseDigest = 8699aea7…`，`viewerVersion = viewer-5c952e5d…`；STEP/DXF 格式键以 `source.json` 为准。未推送、未部署。


## 代码责任与入口

| 层 | 位置 | 当前行为 |
|---|---|---|
| 固定社区依赖与构建 | `dwg-reader/dependency.json`、`build.py` | ACadSharp 3.8.30、提交与两个源码归档摘要固定；在新目录构建，不改原源码归档 |
| DWG 原生读取 | `dwg-reader/Program.cs`、`CommunityText.cs` | 严格读取、原头字段、源句柄账本、可达块、原生参数与社区求值显示几何；保留解码通知与逐句柄损失 |
| 独立 UCD 映射 | `core/unified/dwg_adapter.py` | 不依赖 DXF；源摘要、原句柄、块/实例、显示缓冲、诊断、partial、完整 UCD 校验与清单发布 |
| 本机读取/组装调用 | `core/dwg_convert.py` | `--reader/--dotnet` 完整执行，或 `--assemble-only` 重用本次原生记录；不是生产沙箱入口 |
| 公共校验/序列化 | `core/unified/validation.py`、`canonical.py` | 修正大表成员/引用的重复扫描；标准 JSON 编码器流式处理，保持既有 canonical 字节与摘要口径 |
| 现有查看器 | 前端 `drawing-viewer.js`、`drawing-projection.js`、`drawing-instances.js` | 大模型保留块实例、共享几何、Flatbush 索引和连续笔画批绘；原普通投影仍共用样式/身份契约 |
| 社区文字/索引 | 前端 `core/vendor/` | 选定 ACadSharp.Image 文字规则，Flatbush/Flatqueue；来源、内容摘要和许可随代码保留 |
| 本机页面 | `dev/dwg-local.py` | 回环地址加载已验证 UCD，复用同一 `mountDrawingViewer`；不提供原图下载，不接业务上传 |
| 尚未接入 | 平台 file/preview、任务、缓存、CAD 镜像 | DWG 主图开关仍关闭；已有 DWG 外参 CLI 不参与这条链路 |

原源身份是完整 DWG SHA-256、保存版本及字节数；`source-0`、`buffer-0` 等只是 UCD 文档内外键，未截断原文件/缓冲摘要。`SourceRef.objectKey` 保留原句柄；代理派生零件仍指回原对象。未引用块不展开进场景，不能因此算作解码漏读；它们保留在原 DWG 和源账本中。

## 社区依据与已做的适配

- [ACadSharp 固定提交](https://github.com/DomCR/ACadSharp/tree/760bd909c384b8f1a47c29acd1777ea8e3fe7cfe)，MIT，3.8.30。CSUtilities 固定 `a6505ab24bb45eac91e912179b2049136b7e88af`。归档校验值见 `dependency.json`。
- 上游 `DwgHeaderReader` 将 BS 的 `INTERSECTIONCOLOR` 和 CMC 的 `INTERFERECOLOR` 写入同一属性，正式图原值含 `-1`，不能直接构造普通 ACI Color。构建补丁分开两个字段，保留有符号原值；读取仍 `Failsafe=false`。原生 DWG 写读回归覆盖 `-1/4/257` 与独立真彩色字段；这项回归证明字段不串写，不证明整张图显示完整。
- 曲线、样条、填充图案、标注已存图形和代理流优先使用 ACadSharp 的现成读取/求值。大块 SORTENTSTABLE 由同一原始表建立一次索引，避免上游逐实体 `FirstOrDefault` 的重复扫描；没有重写 DWG 解码器。
- [ACadSharp.Formats](https://github.com/DomCR/ACadSharp.Formats) 的 SVG 路线也使用已存标注块，作为做法对照，不整体引入应用。
- [ACadSharp.Image](https://github.com/slaveOftime/ACadSharp.Image) 的选定 MIT 文字方法用于转义与纯文本换行。C# 与 Canvas 端有改写，原字体、富文本等价性仍未成立；未引入整个应用或 SixLabors 后端。其 `main` 的提交未独立解析成功，当前采用源码内容 SHA-256 固定，见 `drawing-index-dependencies.json`，不可写成固定上游提交。
- [Flatbush 4.5.0](https://github.com/mourner/flatbush/tree/v4.5.0)、[Flatqueue 3.0.0](https://github.com/mourner/flatqueue/tree/v3.0.0)，ISC。只引入索引实现与许可。

后续遇到问题继续先查这些项目的源码、issue/discussion 和消费者。已见 ACadSharp discussion #975（动态块偏移）、#1003/#1017（属性放置）等相似问题；没有据此宣称本图已修复这些情况。20 个 REGION 的 ACIS 原载荷已能读出平面边界；这不等于具备 ACIS 内核，非平面/3D 曲面、布尔和体积语义仍未支持。

## 正式样本身份与逐类状态

原图仅只读使用，无外部服务上传，也没有加入公开夹具。原缓存绝对路径不写入仓库；旧机器的私有 `sample.json` 保存定位信息。换机必须由用户提供同一原件，先核对：

| 项 | 值 |
|---|---|
| 签名 / 保存格式 | `AC1027` / DWG 2013 |
| 字节数 | `34385320` |
| SHA-256 | `bc45921ba82bff24204ae525d4e6b581c316cae489011bd25a6b9a397164a52b` |
| 原生句柄审计 | 902,137；已读对象注册表中未找回的原句柄数 0 |
| 本轮可达范围 | 模型、两个布局及标注存储图形共 430 个块；源块定义总数 758 |

句柄找回不是字段完整、几何完整或工程语义完整。最新版汇总的 `mappedSourceObjects=156875`、`sourceEntityRecords=898729` 也不是全图显示覆盖率；图形展开数、源对象数、含代理派生零件的计数不可混用。

| 类别 | 原生全图观察 | 本轮可达显示/损失与归属 |
|---|---|---|
| 模型 / 布局 / 视口 | 3 个 LAYOUT（含模型）；未发现 VIEWPORT 实体 | 两个布局关系保留；源 VPORT 表项不是纸空间 VIEWPORT。布局切换仍待最新版实际浏览器核验 |
| 基础线与曲线 | LINE 630774、ARC 121977、CIRCLE 25007、LWPOLYLINE 8336、SPLINE 70125、ELLIPSE 20695 | 可达映射分别 103776 / 22237 / 5102 / 3562 / 7574 / 5296；曲线是社区求值的显示离散化，原参数另存，非原 CAD 精度证明 |
| 块 / 属性 | INSERT 13950、ATTRIB 377、ATTDEF 5；存在动态块参数/动作 | 当前保存状态与实例/属性映射；不重新评价动态块。正式图可达块基点均为 0，非零基点叠加旋转的社区变换行为未验证，不得外推 |
| 文字 / 中文 / 字体 | TEXT 1053、MTEXT 1028；码页 gb2312，源字体样式存在 | 可达 TEXT 计数 859 含 58 个代理文字；MTEXT 629。新版有 Unicode/转义/宽度换行，但缺原字体、富文本和复杂竖排/分栏仍为呈现损失；不能把旧页面长文字当成新版排版验收 |
| 标注 | DIMENSION 411，可达 280 | 复用已存标注图形块，不自行生成尺寸图；`dimensionSemantics.measurement` 当前来自 ACadSharp 的计算 getter，不能称作原始存储值或工程验收值，后续需要明确字段来源 |
| 引线 / 多重引线 | LEADER 68、MULTILEADER 19，可达 60 / 18 | 60 条 LEADER 的默认箭头已按 `ArrowSize`/首段方向生成；自定义箭头块仍保留损失。18 项多重引线默认子实体状态已映射，非默认样式仍保留 |
| 填充 / 实心面 | HATCH 567，可达 169；SOLID 1007 | 169 个可达填充中 104 Outer、65 Normal。当前社区 `ExplodePattern` 的 HatchStyle / 多环语义未关闭，重点核对孔洞/外层样式；渐变/部分样式有损失。SOLID 可达计数 519 含 18 个代理箭头派生 |
| REGION / 多线 / 构造线 | REGION 94，可达 20；MLINE / XLINE 各 1 | 20 个可达 REGION 已按平面 ACIS 边界映射，非平面/3D 仍不支持；XLINE 已映射为无限线；MLINE 保留明确损失。这是映射缺口，不能统称三维范围外 |
| 表格 / 未知非图形 | TABLESTYLE 1，未发现 TABLE 实体；有 CELLSTYLEMAP 和文字上下文类 | 未知类仅取得基础记录，不冒充完整专有字段；保留源句柄、通知及原文件 |
| 外参 / 图片 / 底图 / OLE | 本轮原生清点未发现外参路径、IMAGE/底图/OLE 实体 | 这张图不能验证上述资源接入；原字体等配套仍未提供。不得按图纸内任意路径读取本机/网络 |
| Z / 三维 | 独立源清点有 14 条 LINE 的端点 Z 不同，另有大量恒定非零 Z；未发现 3DSOLID/MESH/3DFACE | 原坐标含 Z 保留，当前查看器作俯视二维投影；不能称纯 XY，也不扩展为三维编辑或求解 |

最新版原生通知 33 条（27 Warning、6 None）；其中有未知非图形类、缺 reactor、字体样式引用及动态块通知。当前映射损失 2 条：MLINE 1、原头颜色 1；60 条默认引线箭头、XLINE/RAY、默认 MULTILEADER 子实体和 20 个平面 REGION 已分别处理。这些记录不覆盖尚未识别的所有视觉偏差，不能据数量反推完整性。全部结果保持 `partial`。

## 实验记录：已通过与未通过分开

以下来自旧机器私有 `runs/*/metrics.json`。版本/映射范围有变化，不能直接当作只改变一个变量的性能对照。RSS 为 macOS 观察值，不是 Linux 内存峰值。

| 实验 | 退出 / 资源观察 | 实际产物与结论 |
|---|---|---|
| `formal-native-02` | exit 0；46.177 秒；time RSS 837009408 B | 旧原生记录 188159300 B、位置缓冲 76051704 B；用于第一次页面实验 |
| `formal-native-03` | exit 0；146.509 秒；RSS 921419776 B | 上游逐项排序查询变慢；后续改为同表一次索引。此版已有 ACI7/部分代理文字修正 |
| `formal-native-04` | exit 0；外层 54.895 秒；读取器内部总计 53.855 秒、读取 30.942 秒；RSS 1814806528 B | 最新原生记录 175837245 B、位置缓冲 76052568 B、句柄账本 48648929 B；902137 句柄，未找回 0，430 可达块 |
| `formal-native-heap-05` | `DOTNET_GCHeapHardLimit=0x60000000`（1.5 GiB）、ConserveMemory=9；exit -6，113.805 秒 | Out of memory，不存在可用完整结果 |
| `formal-native-heap-06` | GC 堆上限 1.75 GiB（`0x70000000`）；exit -6，60.926 秒 | Out of memory；不能用减小 GC 堆冒充满足总进程预算 |
| `formal-assembly-profile-07` | **exit -9，进程树 RSS 2244214784 B，触发 2048 MiB 采样限制**；122.433 秒 | 终止前已通过 UCD 校验并写出旧清单 304919340 B、缓冲 76051704 B；清单约 290.8 MiB，超过当前 256 MiB 清单政策。不是资源验收成功 |
| 旧原型浏览器 | 同一现有 `mountDrawingViewer` 实际加载上述旧产物 | 页面显示 1476161 / 1478002 绘制项、1474300 实体、1861 标注、79 图层。已观察全图结构；文字换行、白底 ACI7 等当时仍有问题 |
| `formal-assembly-08` | exit -9；240 秒时限 | 新短键记录组装超时，无成功清单 |
| `formal-assembly-stream-09` | **exit -9；300.166 秒时限**；采样 RSS 1497579520 B | 14.231 秒读完记录，86.026 秒完成 document sealing，264.065 秒完成契约/二进制校验；写清单时终止。仅 `manifest.json.tmp` 144938665 B，无发布清单/成功 summary |

最新读取器 DLL 摘要为 `e4a63a14c851de7584d2d67deaa31ec539e40f2831830a8862263acf3cada524`。跨机器重新构建应记录自己的二进制摘要，不假定必然相同。

默认读取后的 `managedLiveBytes=2941217344`、`managedCommittedBytes=3130966016`（未强制 GC）。现有生产容器是 **3 GiB cgroup 硬限制、禁 swap**；worker 另有 **2 GiB RSS 采样阈值**，并非 2 GiB 容器硬限制。GC 堆上限只约束托管堆，macOS RSS 又会受到压缩/换页影响。Linux 沙箱、总进程树、tmpfs 与完整任务预算都没有验证达标；不能盲目放宽生产配置。

原 DWG 已在独立 ODA Viewer 中以原件打开，原模型/全图截图仅在私有目录。尚未对**最新版 UCD**逐区域进行独立 CAD 视觉核验。独立 CAD 对照需继续使用原件，不能用同一解码器写回成功替代。

## 换机需要带走什么

Git 中有全部代码、固定依赖信息、许可、合成测试与本文；**没有正式图、解析记录、截图、SDK、Python 环境和历史研究输入**。`.cad-work/` 已在仓库级忽略，避免换机后失去旧 `.git/info/exclude` 保护；忽略规则不是隐私安全边界，仍要检查待提交文件。

仓库默认 LF；`.gitattributes` 对固定来源摘要的 ezdxf vendored 树单独保留原字节，避免 Git 将其上游 CRLF 归一化后造成跨机器 release / provenance 摘要失配。该第三方树保留上游空白，差异空白检查仅对此目录排除，其余项目代码照常检查。

通过用户控制的私有本地传输搬运：

1. 正式原 DWG。旧缓存可能失效；若取不到同摘要原件，明确阻塞，不换另一张图。
2. `.cad-work/dwg-acad-main-local-20261027/`：原生 `formal-04/native/`、旧页面产物 `formal-02/`、`runs/`、`sample.json`、本机有界运行器 `lab.py`、header 回归日志等。`manifest.json.tmp` 仅作失败证据，不能改名当成功结果。旧 `STATUS.md` 是过程记录，准确交接状态以本文为准。
3. `.cad-work/dwg-main-20261027/`：社区调查、固定源码归档、独立 ODA 原件截图与前轮方案证据。旧调查中的中间格式比较仅是历史，不改变原生 DWG 决策。
4. 如需复现 DXF 历史原件/浏览器证据，再带 `.cad-work/research/` 和 `.cad-work/dxf-2d-completion-20261027/`；它们不是 DWG 运行依赖，也不要为本任务扩展 DXF。

运行时目录可能很大；可以只带上述证据与源码归档，在新架构重新建 SDK/环境。不要将这些目录上传公开 Git、外部 CAD 转换服务或公开文件夹。源图文字仅作图纸数据，不作命令或指令。

## 新机器复现顺序

### 1. 拉取与准备

获取 `wmj` 本次检查点；若目标目录已有修改，先检查状态，不重置或覆盖。准备 **Python 3.13、.NET 10 SDK**（旧机 SDK 10.0.403）。DWG 的基础组装使用 Python 标准库；平面 REGION 额外需要 `requirements-dwg.txt` 的 ezdxf 导入依赖（numpy、typing_extensions、pyparsing、fonttools、Pillow），不要求完整的 DXF 或 OCP 环境；缺少依赖时 REGION 保留明确损失。前端/服务端校验另按各自锁文件准备 Node；旧机本次实际使用 Node 22.23.3，仓库 server/shared 的声明为 Node >=24，正式环境仍按项目声明准备。

把 `CAD_DWG_DOTNET` 设为 SDK 中 dotnet 可执行文件的绝对路径；把 `DWG_SOURCE` 设为新机器上同一原 DWG 的绝对路径。不要复用旧机器的个人路径。先在仓库根目录执行身份检查：

```sh
python3 - <<'PY'
import hashlib, os
from pathlib import Path
p = Path(os.environ['DWG_SOURCE'])
with p.open('rb') as f:
    assert f.read(6) == b'AC1027', 'DWG signature mismatch'
    f.seek(0)
    assert hashlib.file_digest(f, 'sha256').hexdigest() == 'bc45921ba82bff24204ae525d4e6b581c316cae489011bd25a6b9a397164a52b', 'DWG digest mismatch'
assert p.stat().st_size == 34385320, 'DWG byte length mismatch'
print('Formal source identity verified')
PY
```

### 2. 构建并先跑头字段回归

```sh
python3 server/cad-engine/dwg-reader/build.py \
  --work "$PWD/.cad-work/dwg-build-new" --dotnet "$CAD_DWG_DOTNET"

"$CAD_DWG_DOTNET" \
  "$PWD/.cad-work/dwg-build-new/reader/bin/Reader/release/LibiaoLink.DwgReader.dll" \
  --self-test "$PWD/.cad-work/dwg-header-new"
```

构建下载仅限公开源码，两个归档必须匹配固定 SHA-256；也可用 `--source` 与 `--csutilities` 提供迁移来的离线归档。不要复用前轮研究目录中手工改过的 ACadSharp 源树。上游构建曾有 70 条警告，读取器自身编译无错误；构建新版本需重新记录实际警告。

### 3. 正式图按阶段、同预算先复现

先重跑原生读取，再单独组装，分别量时间/内存/退出状态。不要一开始同时跑浏览器、原 CAD 和多个大图任务。已搬迁的 `lab.py` 是 **macOS 专用**外层运行器，使用 `sandbox-exec` 禁网、限制写入、进程组终止、输出/日志边界和进程树 RSS 采样；它不等价于 Linux cgroup。

以下从仓库根目录执行，先使用原生 120 秒 / 2048 MiB RSS、组装 300 秒 / 2048 MiB RSS 的同一观察预算。两个 label 和结果目录必须是新的。源码/原件是只读输入，结果仍在私有研究目录内：

```sh
python3 - <<'PY'
import os, sys
from pathlib import Path
repo = Path.cwd()
study = repo / '.cad-work/dwg-acad-main-local-20261027'
sys.path.insert(0, str(study))
from lab import run
result = study / 'formal-new-machine-01'
reader = repo / '.cad-work/dwg-build-new/reader/bin/Reader/release/LibiaoLink.DwgReader.dll'
r = run('new-machine-native-01', [os.environ['CAD_DWG_DOTNET'], str(reader), os.environ['DWG_SOURCE'], str(result/'native')], seconds=120, rss_mib=2048, outputs=[result/'native/ucd-records.jsonl', result/'native/positions.bin'])
assert r['exitStatus'] == 0 and r['terminationReason'] is None, 'Native phase failed; inspect retained metrics/logs'
PY

python3 - <<'PY'
import os, sys
from pathlib import Path
repo = Path.cwd()
study = repo / '.cad-work/dwg-acad-main-local-20261027'
sys.path.insert(0, str(study))
from lab import run
result = study / 'formal-new-machine-01'
r = run('new-machine-assembly-01', [sys.executable, str(repo/'server/cad-engine/core/dwg_convert.py'), os.environ['DWG_SOURCE'], '--output', str(result), '--assemble-only'], seconds=300, rss_mib=2048, outputs=[result/'manifest.json', result/'manifest.json.tmp'])
assert r['exitStatus'] == 0 and r['terminationReason'] is None, 'Assembly failed; inspect retained metrics/logs'
PY
```

若新机器仍超时，保留原结果；再只改变组装时间预算为 600 秒、使用新 label，RSS 先保持 2048 MiB，区分 CPU/序列化与内存压力。若明确触发 RSS 限制，再单独设计更大**本机研究预算**的对照，记录原因；不要同步改生产配置。原生读取的 GC 堆硬上限对照已失败两次，不能无依据重复压缩到同一阈值。

如果没有私有 `lab.py`，先从旧机私下取回或由接手者建立等效有界运行器，不将直接裸跑命令写成已完成禁网/资源验证。Linux 新机器则按现有 CAD 沙箱方案建立可观测 cgroup 和禁网环境，不能运行这个 macOS 脚本后宣称 Linux 通过。

只有退出为 0、完整 `manifest.json` 与 `assembly-summary.json` 已发布、摘要/大小及全部校验通过后再启动页面：

```sh
python3 server/cad-engine/dev/dwg-local.py \
  .cad-work/dwg-acad-main-local-20261027/formal-new-machine-01 --port 8769
```

打开 `http://127.0.0.1:8769/`。最新版本机“模型信息 / 本机验证”、源句柄定位与证据保存工具已在本机复验图层开关和正式图原句柄 `13EB13` 定位；证据保存按钮与布局视口仍未验证。不要把工具存在等同功能通过。原型页面计数中的“源几何/展开项”等口径仍有部分面板未统一，优先结合原生账本、实例投影与实际截图核对。

### 4. 下一步按优先级继续

1. **容量闭环**：完成最新版正式图从 native → 校验 → 清单发布 → 现有查看器的完整运行。当前标准 JSON `iterencode` 降低临时副本，但大文档仍多次遍历/求摘要；先做分阶段 profile，查社区成熟流式/紧凑做法，保持 canonical 字节和源身份契约。清单 256 MiB 上限不以 gzip 大小代替，不能直接把旧 290.8 MiB 产物认作合格。
2. **真实视觉/身份**：与独立 CAD 原件对照全图及代表区域，核验 ACI7、中文/换行、尺寸、Outer/多环填充、多重引线、块属性、图层开关、布局、原句柄拾取与定位；记录像素图/视图范围/版本。不要只用小样本或往返成功收尾。
3. **复杂二维缺口**：优先调查社区对 REGION/ACIS 边界、HatchStyle、引线代理、字体/富文本、非零基点与属性放置的现有实现和问题；有证据再选择适配。未解决项维持 loss/partial，不自研 CAD 内核、文字引擎或尺寸求解器。
4. **Linux 资源/部署前门禁**：验证 .NET runtime、读取器、Python 映射、tmpfs、输出流、取消与任务总预算。只有实测满足政策或另获明确资源政策授权，才进入平台上传/任务/缓存接入；这一步本次尚未做。

## 检查点验证与未验证项

本次交接前在最新公共代码上重新执行：

- frontend `npm run typecheck`、`npm run build` 通过；保留既有 bundle 大小警告。
- shared `npm run typecheck`、`npm run check`、`npm run build` 通过，OpenAPI/客户端无漂移。
- server `npm run typecheck`、`npm run build`、边界检查通过；CAD 输入/引擎客户端/归档资源/归档 worker/预览读取五个定向文件共 75 项通过；release 1 项、缓存 7 项通过。发布指纹已用生成器重新绑定当前源码和浏览器模块，`build-release.py --check` 通过。
- UCD `test_schema*.py` 19 项、成员归属 2 项、精确序列化 2 项通过；大实例投影等价（799999 展开项/3 个源叶子）、社区文字换行检查通过；viewer JS 语法检查通过。
- DXF v0.15.0 既有 145 项回归在当前公共层重新通过，约 52.7 秒；兼容警告保留。这不代表正式 DWG 的显示覆盖率。前轮 40 项 DXF 浏览器证据属于历史观察，未作为本次 DWG 验收。
- 原生头字段最终回归通过；正式图最新 native 读取、失败预算及组装终止记录如上。

完整命令与 Git 检查结果见本次 `开发日志.md`。未运行完整业务栈依赖的 frontend smoke、全项目无关测试、最新版正式 DWG 端到端/逐类视觉核验、目标 Linux 镜像、真实数据库迁移 `0068`、公司环境或生产部署。测试的通过范围不能覆盖这些未验证项。

后续业务接入继续沿用文件版本绑定、实时权限、任务取消、配套资源集合、缓存身份、禁网与资源边界，详见原生计划；不能因为本机页面能打开就提前开放平台 DWG 主图。
