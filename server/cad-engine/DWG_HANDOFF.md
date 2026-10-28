# 原生 DWG → UCD 换机交接（2026-10-27）

交接分支：`wmj`，本次为 Push 304 开发检查点。用户已授权交接后直接推送；没有部署、开放平台 DWG 主图或创建 PR。后续先读本文件，再读 [读取器说明](dwg-reader/README.md) 和 [业务接入计划](../../docs/superpowers/plans/2026-10-27-dwg-native-ucd.md)。

## 先明确当前状态

方向已经确定：**ACadSharp 直接读取 DWG → 独立 DWG 适配器 → 现有 UCD → 现有二维查看器**。不经过 DXF，不调用 DXF 适配器，不再另选转换路线或另起查看器。已有 DXF 收口在 v0.15.0；此次一起保存它和公共 UCD 的未提交基础，保证另一台电脑拉取后具备依赖。不是继续扩展 DXF。

**正式大图曾实际进入现有查看器，但最新版尚未完成同一轮端到端复验。** 旧原型的完整清单通过结构、引用、缓冲及 revision 校验，页面显示约 147.8 万个展开绘制项；产生该清单的进程随后触发 RSS 限制，不能把这次实验记为资源验证通过。新版原生读取已完成，缩短文档内外键、流式清单和新文字排版之后的组装在 300 秒处终止，只有临时清单，不能交给查看器当成功产物。

这台电脑物理内存 8 GiB。换大内存电脑有助于排除系统内存压力，但不会自动解决读取器内存、清单大小、排版或生产沙箱问题。建议用 32 GiB 或以上的开发机继续实验，这是开发便利建议，不是已测得的最低配置或部署预算。

> **2026-10-28 本地补充（未部署）**：查看器已修复非索引 `topology:'lines'` 被当成单点绘制的问题，真实正式图点标记 160,173→844、paint 调用 1,476,219→41,970。用 WSL systemd 复刻生产沙箱（3 GiB、无 swap、1 核、64 tasks、tmpfs 1536/384 MiB、单文件 256 MiB、禁网、只读根）完整跑通真实图：读取 22.6 s、峰值 VmRSS 2274 MiB；组装 93.5 s、峰值 1531 MiB；manifest 253.5 MiB validated，无 OOM。生产 2 GiB RSS 采样会在读取 8.1 s 中止；建议 DWG 读取档 2.5 GiB、组装 2 GiB。12 GiB 测试主机加 CAD 3 GiB 的整机预算仍未决策。沙箱位置：`D:\LibiaoLink-verify\sandbox`，报告：`D:\LibiaoLink-verify\RESULTS.md`。

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

后续遇到问题继续先查这些项目的源码、issue/discussion 和消费者。已见 ACadSharp discussion #975（动态块偏移）、#1003/#1017（属性放置）等相似问题；没有据此宣称本图已修复这些情况。REGION 的 ACIS 原载荷读取不等于具备 ACIS 二维边界求值器。

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
| 引线 / 多重引线 | LEADER 68、MULTILEADER 19，可达 60 / 18 | 普通引线顶点可取得，60 项箭头未还原；多重引线选用原生代理图形，18 项仍有未映射代理原语/样式损失 |
| 填充 / 实心面 | HATCH 567，可达 169；SOLID 1007 | 169 个可达填充中 104 Outer、65 Normal。当前社区 `ExplodePattern` 的 HatchStyle / 多环语义未关闭，重点核对孔洞/外层样式；渐变/部分样式有损失。SOLID 可达计数 519 含 18 个代理箭头派生 |
| REGION / 多线 / 构造线 | REGION 94，可达 20；MLINE / XLINE 各 1 | REGION 保留 ACIS 原载荷，未映射二维边界；MLINE/XLINE 缺显示。这是映射缺口，不能统称三维范围外 |
| 表格 / 未知非图形 | TABLESTYLE 1，未发现 TABLE 实体；有 CELLSTYLEMAP 和文字上下文类 | 未知类仅取得基础记录，不冒充完整专有字段；保留源句柄、通知及原文件 |
| 外参 / 图片 / 底图 / OLE | 本轮原生清点未发现外参路径、IMAGE/底图/OLE 实体 | 这张图不能验证上述资源接入；原字体等配套仍未提供。不得按图纸内任意路径读取本机/网络 |
| Z / 三维 | 独立源清点有 14 条 LINE 的端点 Z 不同，另有大量恒定非零 Z；未发现 3DSOLID/MESH/3DFACE | 原坐标含 Z 保留，当前查看器作俯视二维投影；不能称纯 XY，也不扩展为三维编辑或求解 |

最新版原生通知 33 条（27 Warning、6 None）；其中有未知非图形类、缺 reactor、字体样式引用及动态块通知。映射损失 101 条：引线箭头 60、原生显示不支持 22、代理原语未映射 18、原头颜色无法表示 1。这些记录不覆盖尚未识别的所有视觉偏差，不能据数量反推完整性。全部结果保持 `partial`。

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

获取 `wmj` 本次检查点；若目标目录已有修改，先检查状态，不重置或覆盖。准备 **Python 3.13、.NET 10 SDK**（旧机 SDK 10.0.403）。DWG 的 Python 组装仅使用标准库，不要求安装 DXF 或 OCP 环境。前端/服务端校验另按各自锁文件准备 Node；旧机本次实际使用 Node 22.23.3，仓库 server/shared 的声明为 Node >=24，正式环境仍按项目声明准备。

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

打开 `http://127.0.0.1:8769/`。最新版本机“模型信息 / 本机验证”、源句柄定位与证据保存工具尚未实际浏览器复验，先验证它们自身；不要把工具存在等同功能通过。原型页面计数中的“源几何/展开项”等口径仍有部分面板未统一，优先结合原生账本、实例投影与实际截图核对。

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
