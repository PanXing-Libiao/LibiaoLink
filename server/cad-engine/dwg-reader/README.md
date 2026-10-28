# 原生 DWG → UCD（本机验证）

此目录负责固定 ACadSharp 读取依赖、原生 DWG 头字段适配和 UCD 记录输出。Python 组装入口是 `../core/dwg_convert.py`，适配器是 `../core/unified/dwg_adapter.py`。不调用格式转换器，不经过 DXF，不依赖 DXF 适配器；显示复用平台现有 `mountDrawingViewer`。

当前为 `0.1.0-local`，未开放平台 DWG 主图上传、任务、缓存、部署或生产格式开关。已有上传版本绑定和权限边界不变。

换机续接与最后一次实验状态以 [DWG_HANDOFF.md](../DWG_HANDOFF.md) 为准。公开样本本机复验为 `partial`（865 源句柄、11 未找回、45 项损失、3 个布局视口未映射，布局无可见内容）；XLINE/RAY 已按无限线契约映射，默认 LEADER 箭头已按 `ArrowSize`/方向填充，未显示原生对象为 22。正式大图已在当前查看器再次打开约 147.8 万个绘制项，图层开关与句柄 `13EB13` 定位通过，布局仍为空。阶段 A 发现的默认视图问题已修复：读取器保留 `$EXTMIN/$EXTMAX`，查看器默认按模型源范围适应视图，主体恢复可读；`fitAll` 仍可查看含 x≈2.44M 远处对象的全图。状态表和证据见交接文档。

## 固定依赖

- ACadSharp 3.8.30，提交 `760bd909c384b8f1a47c29acd1777ea8e3fe7cfe`；CSUtilities 子模块也固定提交和归档 SHA-256。见 [dependency.json](dependency.json)。
- 运行时为 .NET 10；构建产物、源码解包、正式样本和验证产物全部放在忽略目录。
- 上游 `DwgHeaderReader` 把 `INTERSECTIONCOLOR` 的 BS 短整数和 `INTERFERECOLOR` 的 CMC 颜色写入同一属性。构建脚本只修正这个字段边界，读写分别存储；负数原值保留，不夹取成某个颜色，不启用 failsafe。
- 读取使用 `Failsafe=false`，保留未知实体、未知非图形对象和原生代理图形。未知内容仍可能只有基础元数据，原 DWG 才是权威源。
- 选择性复用 ACadSharp 的曲线、样条、填充图案、存储标注块和 SORTENTSTABLE。大块的排序句柄建立一次索引，避免上游逐实体线性查询。
- ACadSharp 3.8.30 对控制多边形远离原点的周期 SPLINE 可能把首顶点求值为 `(0,0,0)`，显示时形成一条原点至样条的假线。读取器只在该首点为零且控制多边形不在原点时丢弃它；`--self-test` 同时覆盖零起点和合法原点起点，避免误删真实的原点样条。
- 原生 XLINE/RAY 保留参数 `origin/direction` 和源句柄，不再记为未显示对象；适配器输出 `org.cad-preview.annotation-presentation/1` 的 `role:'infinite'` part，查看器按当前视图裁剪、排除出有限 fit 范围。零方向明确失败，不伪造有限线段。适配器单元测试见 `server/test/dwg-infinite-line.test.py`。
- LEADER 的默认箭头（`LeaderArrow=None`、`ArrowHeadEnabled=True`）按 `ArrowSize` 和首段方向生成闭合填充三角（长=size、半宽=size/6），作为 leader 的派生 polyline+fill，源引用仍指回 leader；自定义箭头块、无第二顶点或零尺寸保留 `leader-arrow-presentation` 损失。自检覆盖默认形状和零尺寸拒绝。
- 文字转义与换行选择性采用 MIT 的 ACadSharp.Image 方法；见 `CommunityText.cs`、前端 `vendor/cad-text-layout.js` 及随附许可。只复用相关代码，不包含该应用或 SixLabors 栅格依赖。原配套字体缺失、行内富文本格式等仍有明确限制。

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
- 原有 UCD 结构、引用、二进制与 revision 校验全部执行。清单用标准 JSON 编码器流式写入；字节口径仍为 `ucd-json-python-sorted/1`。临时文件通过大小检查后才发布。
- 当前结果明确为 `partial`。解码警告、未支持对象、字体替代及其他呈现缺口不会变成完整空图；REGION 不因使用 ACIS 就自动归为二维范围之外。

## 已验证范围与资源门槛

正式原图原生读取保留 902,137 个源句柄；模型、布局及标注存储图形涉及 430 个可达块。现有查看器已实际打开约 147.8 万个展开绘制项，采用保留实例、Path2D 连续笔画批绘和 ISC 的 Flatbush 索引，避免逐实例复制全部几何。此观察不代表任意文件覆盖率。

原生读取的默认托管堆提交约 3 GiB；本机 1.5 GiB 和 1.75 GiB GC 堆硬上限实验均内存不足。现有容器是 3 GiB cgroup 硬限额、禁 swap，worker 另有 2 GiB RSS 采样阈值；两者不是同一个限制。macOS 压缩后的 RSS 不能作为 Linux 达标证据，GC 堆上限实验也不能替代容器实测。当前不改变生产资源政策，也不宣称 Linux 沙箱验证通过。需先取得社区读取器的内存改进，或在另行确认的主图资源政策下验证，再开放平台主图任务。

REGION/ACIS 边界、多线、构造线、引线箭头和部分代理样式仍有缺口；多行文字使用社区纯文本换行与替代字体，尚不等价于原字体富文本排版。具体逐类结果以本机正式样本的原始记录和视觉核验为准。
