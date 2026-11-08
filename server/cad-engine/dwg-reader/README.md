# 原生 DWG → UCD（本机验证）

此目录负责固定 ACadSharp 读取依赖、原生 DWG 头字段适配和 UCD 记录输出。Python 组装入口是 `../core/dwg_convert.py`，适配器是 `../core/unified/dwg_adapter.py`。不调用格式转换器，不经过 DXF，不依赖 DXF 适配器；显示复用平台现有 `mountDrawingViewer`。

当前为 `0.1.0-local`，未开放平台 DWG 主图上传、任务、缓存、部署或生产格式开关。已有上传版本绑定和权限边界不变。

换机续接与最后一次实验状态以 [DWG_HANDOFF.md](../DWG_HANDOFF.md) 为准。公开样本本机复验为 `partial`（865 源句柄、11 未找回、29 项损失、3 个布局视口未映射，布局无可见内容）；XLINE/RAY、默认 LEADER 箭头、WIPEOUT、默认 MULTILEADER 子实体和平面 REGION 边界已映射。正式大图已在当前查看器再次打开约 147.8 万个绘制项，图层开关与句柄 `13EB13` 定位通过，布局仍为空；当前正式图 2 条损失（1 MLINE + 1 头字段）。阶段 A 发现的默认视图问题已修复：读取器保留 `$EXTMIN/$EXTMAX`，查看器默认按模型源范围适应视图，主体恢复可读；`fitAll` 仍可查看含 x≈2.44M 远处对象的全图。状态表和证据见交接文档。

## 固定依赖

- ACadSharp 3.8.30，提交 `760bd909c384b8f1a47c29acd1777ea8e3fe7cfe`；CSUtilities 子模块也固定提交和归档 SHA-256。见 [dependency.json](dependency.json)。
- 运行时为 .NET 10；构建产物、源码解包、正式样本和验证产物全部放在忽略目录。
- 上游 `DwgHeaderReader` 把 `INTERSECTIONCOLOR` 的 BS 短整数和 `INTERFERECOLOR` 的 CMC 颜色写入同一属性。构建脚本修正这个字段边界，读写分别存储；负数原值保留，不夹取成某个颜色，不启用 failsafe。
- 内嵌预览 `--preview` 读取 DWG 自带缩略图，只输出 PNG/BMP；构建脚本补丁把上游“取第一张图”改为优先 PNG、其次 BMP、最后 WMF，避免可显示的位图被前置 WMF 遮住。WMF、未知格式和超限图像明确返回不可用，不伪造预览。
- 读取使用 `Failsafe=false`，保留未知实体、未知非图形对象和原生代理图形。未知内容仍可能只有基础元数据，原 DWG 才是权威源。
- 选择性复用 ACadSharp 的曲线、样条、填充图案、存储标注块和 SORTENTSTABLE。大块的排序句柄建立一次索引，避免上游逐实体线性查询。
- ACadSharp 3.8.30 对控制多边形远离原点的周期 SPLINE 可能把首顶点求值为 `(0,0,0)`，显示时形成一条原点至样条的假线。读取器只在该首点为零且控制多边形不在原点时丢弃它；`--self-test` 同时覆盖零起点和合法原点起点，避免误删真实的原点样条。
- 原生 XLINE/RAY 保留参数 `origin/direction` 和源句柄，不再记为未显示对象；适配器输出 `org.cad-preview.annotation-presentation/1` 的 `role:'infinite'` part，查看器按当前视图裁剪、排除出有限 fit 范围。零方向明确失败，不伪造有限线段。适配器单元测试见 `server/test/dwg-infinite-line.test.py`。
- LEADER 的默认箭头（`LeaderArrow=None`、`ArrowHeadEnabled=True`）按 `ArrowSize` 和首段方向生成闭合填充三角（长=size、半宽=size/6），作为 leader 的派生 polyline+fill，源引用仍指回 leader；自定义箭头块、无第二顶点或零尺寸保留 `leader-arrow-presentation` 损失。自检覆盖默认形状和零尺寸拒绝。
- WIPEOUT 按 DXF/ezdxf 的图像边界公式（`insert + u/2 - v/2`，裁剪顶点为像素坐标）生成白色预览遮罩，源句柄保留；这是覆盖绘制而不是查看器 mask part，不拦截拾取。IMAGE/PDFUNDERLAY 仍需要外部资源，不在本映射内。
- MULTILEADER 代理按出现顺序维护 `SubentLayer/SubentLineType/SubentThickness/SubentPlotStyleName` 状态：默认图层/线型/零厚度/ByLayer 打印样式不再误报，具体可解析的索引应用；非零厚度、越界索引或具体打印样式仍保留损失。
- 文字转义与换行选择性采用 MIT 的 ACadSharp.Image 方法；见 `CommunityText.cs`、前端 `vendor/cad-text-layout.js` 及随附许可。只复用相关代码，不包含该应用或 SixLabors 栅格依赖。原配套字体缺失、行内富文本格式等仍有明确限制。

- 共用 OCS 坐标转换：固定版本 CSMath `Matrix4.GetArbitraryAxis` 的 `1 / 64` 被 C# 整数除法算成零；构建补丁改为 `1.0 / 64.0`，使接近正负 Z 轴的法向按原算法选择正确坐标轴。补丁作用于底层共用库，覆盖 INSERT 与原生曲线/填充求值；不修改源法向，不按图纸或句柄特判。`--self-test` 覆盖精确轴、带微小尾差的正负轴、阈值内法向、一般法向及旋转缩放块。旧预览必须重新转换；仅更新查看器不能纠正已生成的错误坐标。本机已通过读取器定向自检、真实原图重新转换及预览契约/二进制校验，并检查全图总览与分散区域；未运行全项目构建，未部署。

## 本机构建与查看

需要调用者提供已固定的 .NET 10 SDK 路径。构建只下载公开依赖源码，SHA-256 不符即停止；也可使用 `--source`、`--csutilities` 提供离线归档。工作目录必须新建，已有源码不会被覆盖。

```sh
python3 server/cad-engine/dwg-reader/build.py \
  --work "$PWD/.cad-work/dwg-build" --dotnet "$CAD_DWG_DOTNET"

"$CAD_DWG_DOTNET" \
  .cad-work/dwg-build/reader/bin/Reader/release/LibiaoLink.DwgReader.dll \
  --self-test "$PWD/.cad-work/dwg-header-test"

python3 server/cad-engine/core/dwg_convert.py "$DWG_SOURCE" \
  --reader "$PWD/.cad-work/dwg-build/reader/bin/Reader/release/LibiaoLink.DwgReader.dll" \
  --dotnet "$CAD_DWG_DOTNET" --output "$PWD/.cad-work/dwg-result"

python3 server/cad-engine/dev/dwg-local.py .cad-work/dwg-result --port 8769
```

这些命令是本机工具，尚未接入生产沙箱调度。正式样本实验另由外层施加禁网、只允许写入验证目录、时间、输出及进程树 RSS 限制。不能把直接执行本机命令当成已满足生产沙箱。

`dwg-local.py` 仅监听回环地址，只提供已验证清单、显示缓冲和现有查看器静态文件，不提供上传接口或原 DWG 下载。它保留现有查看器界面，替换本机加载入口；本机定位与证据保存位于“模型信息 / 本机验证”。页面 HTML 固定按 UTF-8 读取并以 UTF-8 返回，不依赖 Windows 默认代码页；回归见 `server/test/dwg-local-encoding.test.py`。顶部使用“二维部分预览”标准说明，并按损失计数追加具体类型。

## 身份、记录与损失

- 格式从 DWG 字节签名识别，保留保存版本、原文件完整 SHA-256 和字节数；文件扩展名不是格式证据。组装阶段再次核对原文件。
- `native-summary.json` 和 UCD 的 `org.libiaolink.dwg/1.header` 保留 `$EXTMIN/$EXTMAX` 模型/纸面范围。查看器只把有限的模型范围作为默认视图候选，并要求它覆盖至少 50% 可见绘制且不超过计算范围 4 倍；否则回退到几何计算范围。源范围外的对象仍可缩放或通过 `fitAll` 查看。
- SourceRef 的 `objectKey` 为原句柄。代理图形等派生显示零件指回其原对象；合成零件 ID 不冒充原句柄。
- `source-0`、`buffer-0` 为 UCD 文档内的外键；完整源摘要、完整缓冲摘要及绑定全文的 document revision 不截断。短键避免在每个对象中重复七十余字符的摘要。
- `native/source-handles.tsv` 覆盖原生句柄表，保留类型、归属、解压对象区偏移和映射范围。偏移不是原文件字节地址。
- 保留 `notifications.jsonl`、逐句柄 `losses.jsonl`、可取得的 ACIS 原载荷以及原生字段记录。未引用定义仍在原 DWG 和源账本中，不展开进当前场景。
- 平面 REGION：适配器用仓库 `core/vendor/ezdxf/src` 的 ACIS SAT/SAB 读取器解析 `native/opaque-*.bin`，将边界线追加到显示缓冲并生成 `geometry` presentation parts；非平面曲面、未知曲线或缺少依赖时保留原损失。依赖见 `../requirements-dwg.txt`（numpy、typing_extensions、pyparsing、fonttools、Pillow）；这是平面边界读取，不是 ACIS 内核。
- 原有 UCD 结构、引用、二进制与 revision 校验全部执行。清单用标准 JSON 编码器流式写入；字节口径仍为 `ucd-json-python-sorted/1`。临时文件通过大小检查后才发布。
- 当前结果明确为 `partial`。解码警告、未支持对象、字体替代及其他呈现缺口不会变成完整空图；平面 REGION 已按边界映射，非平面/未知曲线仍保留损失，不因使用 ACIS 就自动归为二维范围之外。

## 已验证范围与资源门槛

正式原图原生读取保留 902,137 个源句柄；模型、布局及标注存储图形涉及 430 个可达块。现有查看器已实际打开约 147.8 万个展开绘制项，采用保留实例、Path2D 连续笔画批绘和 ISC 的 Flatbush 索引，避免逐实例复制全部几何。此观察不代表任意文件覆盖率。

原生读取的默认托管堆提交约 3 GiB；本机 1.5 GiB 和 1.75 GiB GC 堆硬上限实验均内存不足。正式生产现有容器是 3 GiB cgroup 硬限额、禁 swap，worker 另有 2 GiB RSS 采样阈值；公司测试机 2026-11-02 已用 5 GiB 容器 / 3.5 GiB DWG worker 档位完成真实 34,385,320 B 文件复验，但不改变正式生产。两者不是同一个限制。macOS 压缩后的 RSS 不能作为 Linux 达标证据，GC 堆上限实验也不能替代容器实测。当前不改变生产资源政策，也不宣称 Linux 沙箱验证通过。需先取得社区读取器的内存改进，或在另行确认的主图资源政策下验证，再开放平台主图任务。

非平面 REGION/ACIS、MLINE、IMAGE/PDF 底图、自定义引线箭头和部分代理样式仍有缺口；多行文字使用社区纯文本换行与替代字体，尚不等价于原字体富文本排版。具体逐类结果以本机正式样本的原始记录和视觉核验为准。

### WIPEOUT 背景遮罩

原生 WIPEOUT 的 `fills` 记录保留 `mask: true`，装配为 `org.cad-preview.fill/1` 的同名字段；查看器按当前黑底或白底绘制遮罩，不套用普通图元的黑白对比色。既有未标记派生产物需要重新转换，不能根据纯白填充猜测其是否为遮罩。

## 重复属性标签的显示规则

同一 INSERT 可以包含标签相同、句柄和位置不同的多个 ATTRIB。读取器按实体分别保留文字、位置、显隐、所属实例及 `semantic.attributeTag`，不把标签当作实体唯一键。`blockInstances.attributes` 是单值摘要：同名标签保留源顺序中的首值，并记录 `duplicate-attribute-tag` 说明摘要歧义；完整值仍在各属性注记中，不能用摘要替代它们。重复标签不再导致整块实例及后续属性映射中断。`--self-test` 覆盖不同值的重复标签、大小写不同标签、Hidden 标志及所属实例；该规则不补齐纸空间视口、动态块求值或缺失字体。


## 实例裁剪、两端对齐与外参归账

原生 SPATIAL_FILTER 的启用状态、边界、逆插入矩阵和支持边界随实例保留。固定 ACadSharp 的 4×3 矩阵读写补丁将行列顺序转换到 CSMath 的 [column,row] 约定，保留旋转和平移。普通 XY 平面的矩形／多边形边界转换到块坐标后，复用平台裁剪链；两点矩形先展开四角再变换，关闭裁剪不生效。反向、前后深度、非默认边界平面变换暂未映射，保留源数据并记明确损失，不能声称此类显示正确。

TEXT/ATTRIB 的 Fit/Aligned 输出经过 OCS 转换的两个基线端点；浏览器替代字体与本地配套字体排版均以源端点距离计算文字长度。Fit 保持字高，Aligned 同比例调整字高。属性标签、源文字及源端点不改写；字体替代仍是部分预览，旧产物需重读后才含端点。

仅由块的 XRef/XRefOverlay 标志认定外参。保留请求路径、来源和块引用关系，明确标记未加载，不能计入“定义有效但无内容”的普通空块。原生 DWG 的外参配套解析尚未接入；不访问图内绝对路径、不因本机存在同名文件就绑定。此项纠正归账与提示，不代表外参几何已经加载。

定向验证包含原生矩阵 DWG 往返、关闭裁剪、矩形／凹多边形、旋转镜像放置、Fit/Aligned 两类字体路径、重复属性及未加载外参归账；真实样本显示证据只保留本机。不以转换校验通过替代整图显示验收。

## 无图形块标注与尺寸约束

不能仅凭 Dimension.Block == null 判断普通尺寸线丢失。原生读取模板中的图形块引用为 0 表示源文件未指定图形块；非零但未解析到 Block 则是引用解析缺口，两者分别保留在 dimensionSemantics.sourcePictureBlockHandle / pictureStatus 中。关联依赖 ACDBASSOCDEPENDENCY 的原始所有者为 ACDBASSOC2DCONSTRAINTGROUP，且源图形块引用为 0 时，分类为 constraint-without-picture；不按图层名、文本表达式、图纸名或句柄值猜测。模板读取依赖当前固定 ACadSharp 版本，与已有源句柄账本一样需要随读取器升级复验。

缺块对象仍保留表达式、定义点、文字点、法向、样式句柄、关联句柄和来源；measurementBasis=native-geometry-derived 明确 measurement 为原生对象按定义几何求得的数值，不冒充文件存储测量值或工程验收值。已有图形块继续复用存储图形，不受约束分类影响。无块的约束保持 DIMENSION_CONSTRAINT 未显示计数和专用诊断，普通缺块与非零引用未解析分别报缺失，不能为了提高覆盖率计入显示成功。当前不实现约束求解或动态交互覆盖层，也不由参数表达式生成箭头、文字或尺寸线。

已用两份独立真实样本核对源零引用和约束组所有者链；含普通存储标注的另一份独立文件用于回归。小型用例覆盖零／非零／未知引用、约束与普通对象、已有图形优先和参数保留。

## 保存的代理显示与多环图案填充

未知／代理实体使用源 DWG 已保存且命令完整的代理图形缓存。按命令顺序保留图层、颜色、线宽、线型及比例；代理线型索引不包含 ByLayer/ByBlock 两个特殊表项，特殊值绑定到当前文档表记录。圆弧与圆的缓存中心按 WCS 处理，转换到原生曲线使用的 OCS 后复用共用几何绘制。已支持折线、圆、普通正向圆弧、不填充多边形及三角填充；缓存缺失、解码命令数不一致、未支持变换／裁剪／文字等命令均保留明确损失，不能忽略状态命令后画出错误片段。原缓存字节、摘要、源身份、解码计数与状态保留在 native 产物及 org.libiaolink.dwg/1.proxyGraphics 中。现有 MULTILEADER 路径未在此项中扩展。

保存的缓存只代表上次保存的显示内容，不恢复专业对象语义，也不求值外部文字。某些 RTEXT 的源缓存只有矩形与叉线；恢复这些线框不能称为文字恢复。无缓存专业对象与专业表格仍可能未显示。查看器单独提示缓存对象数，源对象归账与语义支持程度分开。

固定 ACadSharp 的 HATCH 奇偶判定原先全局合并不同环的重合交点，导致相邻边界的偶数交点变成奇数。补丁只在单个环内去重，再对各环做奇偶组合，适用于相邻、相交、嵌套及重合环的共同规则；不改源边界、图案基点、角度或间距。hatchSemantics.patternLines 保留实际源线族供核对。源间距可能使一个小区域中没有任何纹理线，不据空输出擅自补线。

定向验证覆盖相邻环、嵌套洞、重复环、代理样式及不同法向圆弧。真实机械／建筑／业务图按源原语与边界核对，另有未参与调试的机械样本完成原生及转换验收。浏览器实际检查缓存曲线、RTEXT 线框与图案填充；按句柄定位只选择当前可见绘制，避免选中同源隐藏边界。宽多段线的后续共用修复见下一节；局部验证不代表整图通过。源图、逐对象记录和截图仅保留本机，旧产物需重新转换；部署状态以发布记录为准。

## 宽多段线的自交面片与零宽连接

宽线由源中心线、逐段宽度和凸度生成 OCS 带状面片。短段的接角截面可能相交，宽弧段的径向截面也可能翻转；此类四边形不能直接当作简单 HATCH 环三角化，其有向面积存在相互抵消。共用宽线适配器先检测两组非相邻边的内部交点，将自交面片分成原轮廓的两个三角区域，保持一致绕向后绘制；不填成凸包、不修改源宽度或中心线。已为三角形的面片直接保留顶点，避免通用环索引取整吞并极小三角区域；非自交四边形仍走原三角化和面积校验，未放宽校验容差。

零宽端点本来就位于源中心线站点，不再求两个偏移射线的接角交点。这同时覆盖零宽细杆与起始宽度为零的渐宽箭头，防止浮点尾差把线段误生成为退化填充。规则由 DWG/DXF 共用，原始几何、图层、块变换、源身份和显隐保持。

定向验证包括自交面片双区域面积（区分有向面积与凸包）、绕向/边序/大坐标、零宽箭头端点、宽圆弧及既有箭头/宽度突变/闭合接角/凸度回归。真实问题文件的源实体重读参数一致，相关宽多段线全部生成，转换契约和二进制校验通过；另两份独立文件完成宽线回归。社区曲线仍为采样显示，面积用例核对离散误差范围，不作为工程面积或任意急转角的完整 CAD 保真声明。详细原图、浏览器验证和诊断只留本机。

## 空图案的保守自动判定

原生图案展开为空后，HatchEmptyPattern 才尝试证明：依据已读取线族的方向、基点与偏移，把全部源边界投影到线族法向，计算整数线族 k 的可能区间。仅当所有线族在扩张后的区间内均不存在整数 k，标记 empty-by-read-definition（“按已读取源定义为空”）；该充分条件不证明读取完整、CAD 对象有效或整图无损，不生成或移动任何图案线。边界在 OCS 中解析，判定不依赖块放置、图纸名、句柄或指定坐标。

首批支持精确闭合的直线边界、完整圆／椭圆、闭合多段线及其凸度圆弧。圆弧检查解析极值，完整椭圆使用支撑半径，不以采样多边形或截图证明空白。候选区间按绝对裕量和坐标量级的浮点裕量向外扩张；相切、临界交线、过密／零间距、不可靠数值、缺失定义、未闭合或未支持边界、虚实线族及双重填充均保留 needs-review。即使多个环的奇偶抵消或虚实段间隔最终产生空白，只要此充分条件未成立，也不自动消警。不能放宽条件来提高某一张图的通过数量。

逐对象结果在 org.libiaolink.dwg/1.hatchPatternOutcomes 中保留 status、reason、method、ranges 与 sourceRefs。已证明项只生成 info 诊断 hatch-empty-by-read-definition，不再计入原生损失观察；其他空输出继续保留 empty-native-hatch-pattern warning 和原生记录。查看器解析范围分别列出两类对象数，待核实空输出不混入通用损失摘要。旧产物没有判定证据时仍为待核实，须用新读取器重读后才能获得自动判定。

小型用例覆盖旋转／大坐标、负间距、多线族、圆弧内部极值、完整圆／倾斜椭圆，以及相切、细小开口、奇偶抵消、虚实段、双重填充、非有限值和不支持边界等保守反例；另有构造 DWG 经真实读取及装配验证两类状态与正常可见图案。业务图与独立住宅文件按原生记录及几何字节回归；源图、逐项结果和截图仅留本机。独立住宅图用于非空填充回归，不冒充另一份含已证明空图案的业务样本。


## 源线宽与样式继承

原生 entityState.nativeLineWeight 保留 LineWeightType 的有符号原值。显式非负值仍由 style.lineWeight 以毫米传递，包含 0；-1（ByLayer）和 -2（ByBlock）通过既有 style-inheritance 扩展的 modes.lineWeight 进入共用投影器。几何、块实例和注释均参与；注释的 ByLayer/ByBlock 线型也按 annotationStyles 归一，不能覆盖已保留的线宽模式。0 层和嵌套实例沿用既有有效图层／父实例链规则，缓存代理原语使用缓存已声明的图层和样式，不能一律套用外层专业对象的图层。

Default（-3）保留源标记，并采用带 engineering-defined 证据的 0.25 mm 查看器替代值；其他负值不猜测。LWDEFAULT 是原作者应用的注册表设置，不在 DWG 中，不能从 CELWEIGHT 或默认标记恢复其具体值。默认图层与 Default 实例在继承链中使用该替代值，未绑定的 ByBlock 不随实体所在的粗线层继承。解析后的文字线宽／线型不等于已恢复字体笔画。旧原生产物缺少该字段时不能恢复源线宽模式，须重读原 DWG。该字段是内部显示证据，不改业务 API、数据库或工程尺寸口径。定向验证含构造 DWG 往返、独立真实建筑／机械图和既有业务图；局部样式核对不代表整图无损。


## LWDISPLAY 与默认笔宽源定义

固定读取库的 R2000+ 头标志中，LWDISPLAY 是反向位 `!(flags & 0x0200)`；此前错误地比较为 1，导致恒为 false。构建补丁保留 NativeLineWeightFlags 并修正反向判断；CELWEIGHT 的低 5 位使用既有线宽索引表解码，写入也按同一表编码。CELWEIGHT 仅定义新对象线宽，不能覆盖既有实体，也不是 LWDEFAULT。早于 R2000 无该头标志时，开关和头线宽保持 null／未知。原生输出 nativeLineWeightSettings 与 nativeLayerLineWeights，装配在 DWG 内部扩展中保留原始值、作者默认不可从文件读取的状态和查看器替代笔宽。

模型视图遵守已读取 LWDISPLAY：关闭时笔画为 1 个 CSS 像素的细线；开启时使用现有受限屏幕线宽映射，最小为 1 CSS 像素，显式零笔宽不再被当成缺值。多段线几何宽度／实心填充不受此开关影响，源毫米值和实体属性不因关闭而改写。普通与保留实例绘制共用此规则；旧产物或旧版本没有源开关时继续未知，不按默认 false 处理。查看器显示源开关和默认笔宽替代说明。纸空间／布局的独立打印设置、CTB/STB 的物理输出、原作者的注册表默认值及字体笔画恢复不在该模型规则的保真范围内。

依据：[Autodesk LWDISPLAY](https://help.autodesk.com/cloudhelp/2022/ENU/AutoCAD-Core/files/GUID-18CA6E8F-0008-402E-9F6B-2F9ED8A0A7DD.htm)、[Autodesk LWDEFAULT](https://help.autodesk.com/cloudhelp/2015/ENU/AutoCAD-Core/files/GUID-969FE4A6-C30D-44DE-AFD4-A81B53F175F6.htm)、[ODA DWG 规范](https://www.opendesign.com/files/guestdownloads/OpenDesign_Specification_for_.dwg_files.pdf)。

点显示保留原生 PDMODE/PDSIZE 至 nativePointDisplaySettings。查看器定向接入模式 0 的点状标记和模式 1 的普通点隐藏；Defpoints 点不受该设置影响，保持点状显示。其他普通点模式与尺寸尚未验收；不隐藏所有非打印图层，不改源点位置。

配套字体的常规字形存在但源要求的粗体/斜体变体未提供时，布局仍保守替代，并明确记录 `font-requested-bold-italic-face-not-provided`；不能笼统据此断言整份字体文件未提供，也不以合成字形冒充原字形。

MTEXT 零框宽不自动换行的规则仅按已支持方向排版。未知源方向值（例如0）原样保留，归账 `mtext-drawing-direction-unrecognized`，已有字形仅作可读近似，并在文字记录中标记 `layoutStatus=approximate`。不根据另一查看器的外观猜测竖排，不将原文件缓存外包框当作作者设定框宽。旧版列扩展数据读取仍有边界，不能由`HasColumns=false`泛化为所有源列信息已读完。

旧版 MTEXT（R2018 前）列定义存于 ACAD XData；固定版本库虽保留 XData，却不填充 ColumnData。读取器现在保留相关对象的完整 ACAD 有类型记录、列/链接/定义高度段完整性及解码字段，hasColumns 不再仅依赖库默认值。完整、无链接的单列只按源列宽提供明确近似预览；高度和流向未实现，负高度原样保留。多列、链接列、未知或不完整字段定义不猜测排版，保留数据并归账未显示。只含定义高度的普通 MTEXT 不标记为列；现代列和竖排仍按既有边界处理。

旧版动态单列的负高度仍保留为未完全解释的源值：不得取绝对值当固定列高，不得据负号把 autoHeight 改为 1，也不以存储外包高度或 definedHeight 补造列约束。单列计数不保证不发生续列；正高度约束、自动高度分列与链接列尚未实现。当前单列字形继续明确标为近似，源高度、标志、列宽与锚点分别保留。
