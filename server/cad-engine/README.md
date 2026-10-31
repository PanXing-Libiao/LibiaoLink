# CAD 平台运行与源码更新

DWG 面/网格预览（2026-11-01，本地未部署）：原生读取器将平面 3DFACE、细分级别 0 且各面为平面三角形/四边形的 MESH 映射为带源归属的三角面和原始边，保留隐藏边标记；不生成平滑曲面或新增拟合点。不共面、退化、未支持面型及超限对象写入 native-mesh-unmapped 诊断。现有 annotation-presentation 表示供二维显示与可旋转三维视图复用，字体路径不变；ACIS 转换试验未接入，也未新增运行依赖。三维视图暂不显示带二维裁剪的实例，界面明确提示。每对象上限为 20 万三角面、20 万线段，继续受既有进程资源限制及产物校验约束。

2026-10-31 本地首次解析优化：规范 JSON 摘要与写出改为有界子树编码，小片段使用 Python 标准编码器的原生路径，大容器继续流式输出。组合结构的分支已经完成子项检查且外层无其他约束时，不再重复遍历同一数据。保持现有排序、浮点、Unicode、负零及非法值拒绝规则，产物字节格式不变；结构、引用、几何、二进制摘要及跨进程完整校验均保留。字体、几何精度和查看器未改。发布身份同步更新；同图 Linux 完整转换及显示数据对比通过，规范编码、结构约束、传输和字体/外参定向回归通过；性能明细和真实图只留本机，未部署。

换机续接原生 DWG 工作先读 [DWG_HANDOFF.md](DWG_HANDOFF.md)：列出已跑通的原型、最新版未通过项、正式图身份、私有证据迁移和逐步复现命令。

二维 DXF v0.15.0 已接到同一平台任务和查看器，代码仍在本地，未部署。先停止旧 API/worker，再执行数据库迁移 `0077`、`0078`、`0079`，随后同步更新 CAD 镜像、API 与 worker；只设置旧环境变量或只更新浏览器不构成接入。`0069` 把产物缓存键从 `engine_version` 拆到格式独立的 `format_version`（ADR-041）；旧产物第一次访问会按新格式版本重建，之后浏览器或单一格式改动不再触发另一格式重建。STEP 继续要求完整产物，DXF 可发布带覆盖证据的 `partial`，DWG 平台路径已加入但由 `CAD_DWG_ENABLED` 默认关闭，尚未在目标沙箱调度或部署（2026-10-29 本机完整系统已跑通公开样本与正式 34 MB 大图的上传 → 任务 → 产物 → 查看器；DWG 平台默认使用 `ucd-dwg-packed/1` 无损 packed manifest，正式图 manifest 25.97%、artifact 42.4%，引擎父进程校验前解包、查看器 `core/dwg-packed-transport.js` 解包，见 [DWG_HANDOFF.md](DWG_HANDOFF.md)；本机 harness 未施加生产 cgroup，目标 Linux 沙箱未验证）；空白/损坏文件不得伪装成成功结果。

DXF 上传后可静默预解析主图；查看器中的“配套文件”选择同项目文件的具体版本，并指定资源包内路径，例如主图 `drawings/main.dxf`、外参 `drawings/refs/detail.dxf`。系统只使用明确选择的版本，不猜测同名文件，不访问源文件路径、系统字体目录或网络。支持资源类型 `.dxf/.dwg/.shx/.shp/.ttf/.otf/.dgn/.dwf/.dwfx/.ctb/.stb`、常见位图与 PDF；DWG 外参由固定 LibreDWG CLI 独立解码，原件身份和嵌套相对路径保留；缺少解码器或文件损坏时明确未加载，解码警告保留为部分结果。主图加配套最多 128 份、合计 64 MiB。补齐、调整路径或选择新版本会创建独立产物身份；原来的部分结果不会被当成完整结果复用。每次状态、清单、资源和释放请求均检查主图及配套的实时可见性，配套被回收时拒绝读取，彻底删除时清除相关派生产物。

Docker 内在 `/opt/dxf` 正常安装仓内 ezdxf 1.4.2 fork，并验证安装的 Python 源文件与仓内源码一致；本机开发保持 editable。转换进程限时 60 秒，与 OCP/Gmsh 解释器隔离；PDFium 仅在此独立进程执行。已有容器内存/CPU/进程数/禁网和临时存储硬限额继续生效。MTEXT 三项回归与五份合成反例位于 `core/tests/dxf/test_mtext_regressions.py`；公司图纸和历史研究材料不进入公共夹具。

原本地联调已跑通文件版本 → SHA/bytes 核对 → 任务 → 完整产物 → 鉴权 manifest/buffers → ViewerSession。当前运行方式按 ADR-036 改为独立沙箱；历史 stdio 结果见 [逐文件表](../../docs/cad-platform-integration/RESULTS.md)，不冒充本次隔离验收。源码、依赖及浏览器模块的内容指纹见 `source.json`；STEP v0.3.3 已包含颜色查找与 UV 分类缓存优化，完整产物接收政策保持原有规则。

## 准备运行环境

CAD 解析已迁移到独立 Linux 容器，不再由 API 启动 Python。先按 [CAD 沙箱部署手册](../../deploy/cad/README.md) 仅构建 CAD 镜像并启动沙箱；macOS 与 Windows/WSL2 的本地 API 使用开发中继，生产 API 直接连接 Unix socket。

| API 参数 | 含义 |
| --- | --- |
| `CAD_ENGINE_SOCKET` | 生产 Unix socket 绝对路径；与 CAD 容器只共享限容通信目录 |
| `CAD_ENGINE_URL` | 仅开发环境允许 `http://127.0.0.1:9910` 中继；生产拒绝 TCP 回退 |
| `CAD_MAX_INPUT_MIB` | 默认 64，显式可配至 256；同时配置沙箱输入上限，大小不是完成保证 |

旧 `CAD_ENGINE_PYTHON` / `CAD_MESHER_PYTHON` / `CAD_CACHE_DIR` 不再启用 API 内 native 解析。API 无 Python/native 依赖，不接收 CAD 返回的本机路径；沙箱只接收核对过 SHA/bytes 的输入字节，产物以有界流返回。

沙箱强制 3 GiB 内存、1 核 CPU、64 进程/线程、禁 swap；单文件 256 MiB、FD 128、core 0。转换数据、临时目录、通信目录分别限容 1536 / 384 / 1 MiB，根目录只读、capabilities 全部丢弃、禁止提权、seccomp、禁网。启动读取内核实际状态，限制缺失或 cgroup v2 不可用则拒绝运行。原 worker 2 GiB RSS 采样阈值不是硬限额；cgroup 覆盖 gateway、OCP、Gmsh 全部后代。固定任务预算仍为并发 1、排队 8、worker 600 秒、队列 900 秒，PID 1 watchdog 对超期未退出的主 worker 终止整个 CAD namespace。

CAD 内部临时缓存仍受限于 tmpfs 和 24 小时保留；已完成的模型另按 [ADR-037](../../docs/adr/ADR-037-CAD产物持久化与上传预解析.md) 持久化：数据库保存队列、状态、窗口和产物索引，私有对象存储保存完整 manifest / buffers。API/worker/CAD 重启后直接读取完成产物，无需 native 重算；新版本、固定引擎版本或名称编码分别生成，缺失/损坏撤销完成态并排队重建。缓存先按文件版本隔离，不能把上传声明的 SHA 当作跨文件复用的可信凭据。沙箱仍禁网且不持有存储凭据，不增加持久宿主挂载。

浏览器使用 HTTPS，本地 loopback 可验证 Web Crypto。生产镜像、server/shared 和同版本 `/cad-viewer/` 静态资源须按部署流程同步；API 的原内存预算与 CAD 独立核算。持久化与预解析已在公司测试机和正式生产部署；正式生产首轮打开、产品树与真实文件转换已验收。运行边界与研究依据见 [ADR-036](../../docs/adr/ADR-036-CAD解析沙箱与资源硬限额.md)。

名称默认使用 OCCT GB 中文旧编码，不自动猜编码；需要标准编码时，在“模型信息”切换 UTF8 并重新读取。选择在当前标签页按文件版本记忆，并传入任务参数 `nameCodepage`；不同码页隔离缓存，检查记录保留本次选择。源文件无需修改。

查看器已同步相机范围修复：定位小零件后，缩放仍保留整机范围，裁切面随镜头更新。详见CAD 平台 `docs/step-0.3/focus-camera/README.md`；几何与解析策略沿用此前版本。

定位、淡化、隐藏、仅显示四个操作可再次点击取消，启用时显示按下状态。取消定位恢复此前视角，取消仅显示恢复原用户隔离范围，已有隐藏及隔离期间的显隐修改保留。清空选择后仍能取消已启用模式；适应视图/摆正、全部显示、恢复初始同步更新对应模式状态。

## 持久化与静默预解析

先通过现有迁移器执行 `database/migrations/0064_cad_artifacts.sql`，再更新 API 和 worker。仅启动 CAD 容器不会消费后台任务；生产 worker 须叠加 `deploy/prod/docker-compose.cad.yml`，与 API 一样只读挂载 Unix socket，数据库/对象存储凭据仅留在平台进程。

上传完成的事务为 STEP 登记 GB 队列行，不等待 native。worker 独立轮询专用队列，不占用通知 outbox 的串行循环；租约、claim token 和有界重试防止崩溃后的重复发布。已有未归档版本在首次打开时幂等补投；已存在且可校验的同版本沙箱结果可直接归档。

数据库完成态仅在所有 SHA 产物成功写入后发布；随后回收没有其他窗口/alias 使用的自有沙箱临时任务，腾出限容 tmpfs，失败或借用别人的 native 结果不回收。须更新至含该回收行为的 CAD 镜像（本地 1.0.1，生产使用审核后的 digest）。窗口各自绑定任务、取消状态和五分钟资源租期；关闭窗口不取消后台工作。产物长期保留，对象位于 `projects/{projectId}/files/{fileId}/cad/`，彻底删除文件或项目时按对应前缀清理。新 worker 成功发布重建代后清理上一代；崩溃中断可能遗留未引用代，文件彻底删除会清除完整前缀。数据库与私有对象需共同备份。

模型清单持久化预算 64 MiB，单 buffer 256 MiB，总产物 512 MiB；超过预算明确失败，不发布残缺结果。API 读取产物时走有界校验流，不将全部几何载入内存。测试及实际边界见 [持久化验证记录](../../docs/cad-platform-integration/PERSISTENCE_RESULTS.md)。

## 本地完整系统

无需先合入 main。`local-system.mjs` 直接运行当前分支的实际 `AppModule` 与完整前端，登录走本地 Casdoor 的 authorization code + PKCE；项目、任务、文件版本写入独立 PostgreSQL 18，文件经原有分片上传链路写入私有 MinIO。它不注册试用夹具的登录/导入接口，不连接公司数据。

复用已有 Node 24、PostgreSQL 18 Docker 镜像与单独启动的 CAD 沙箱。官方本地程序放在被忽略的 `server/cad-engine/.runtime/`：MinIO `RELEASE.2025-09-07T16-13-09Z` 按开发机平台选择 Linux amd64 或 macOS arm64 二进制，保存为 `.runtime/minio`；Casdoor `v4.4.0` 选择 `casdoor_Linux_x86_64.tar.gz` 或 macOS arm64 发行包，解压至 `.runtime/local-system/casdoor/`，保留 `casdoor`、`web/build` 与 `conf/`。下载后按官方 release 的 SHA-256 校验，并在 Linux/WSL 执行 `chmod 700 server/cad-engine/.runtime/minio server/cad-engine/.runtime/local-system/casdoor/casdoor`；不复制或重建 CAD native 环境。

> **Windows 开发机**：公司不允许 Docker Desktop。先按 [WSL2 + Docker Engine 安装说明](../../docs/本地开发环境(Windows-WSL2-Docker).md) 把仓库和全部运行命令放进 WSL Ubuntu；本地 Casdoor/MinIO 使用上面的 Linux amd64 程序，不要下载 Windows `.exe`。

在 `server/` 运行：

```sh
CAD_ENGINE_URL=http://127.0.0.1:9910 \
LOCAL_PG_IMAGE=your-existing-postgresql-18-image \
node scripts/local-system-prepare.mjs

LOCAL_SYSTEM_CONFIG="$PWD/cad-engine/.runtime/local-system/private.json" \
node scripts/local-system.mjs
```

打开 `http://localhost:3000`。准备脚本只创建专用 `libiaolink-local-pg` 容器、`libiaolink_local` 业务库、`casdoor_local` 登录库，执行已有迁移与基础字典/模板种子；不填充公司数据或 100 个演示项目。迁移角色与 API 角色分离；重复准备保留已有项目和文件。随机凭据与登录初始化数据只存于忽略目录且权限为 0600，不在控制台输出。

页面为完整项目系统；创建项目、添加任务后，从任务“文件”列上传 STEP。账号菜单的“文件库”能查询并预览同一文件。正常 OIDC 登录完成后，现有浏览器即可直接试用。本地 runner 另起独立 CAD 后台 worker 子进程；停止本地运行进程会关闭该 worker、前端、API、Casdoor、MinIO；PostgreSQL 专用容器保留数据，可单独停止 `libiaolink-local-pg`，重启时再次运行上述命令。

端口只绑定本机：前端 3000、API 3001、Casdoor 8000、MinIO 9000/9001、专用 PostgreSQL 5433。源码仅按需转译，保留 Nest 注入元数据，无需全量构建或静态检查。此启动方式服务于 STEP 的完整业务流程；Office 文档服务、外部翻译与通知通道未在这套本地环境配置。

实现依据：[Vite 开发服务与代理](https://vite.dev/config/server-options)、[Node 模块加载钩子](https://nodejs.org/docs/latest-v24.x/api/module.html#moduleregisterhooksoptions)、[Casdoor 本地运行](https://casdoor.org/docs/basic/server-installation/)与[初始化数据](https://casdoor.org/docs/deployment/data-initialization/)。

## 独立试用页面

在安装现有 server/frontend/shared Node 依赖后，在 `server` 执行。输入清单是本地 JSON 数组，每一项为 STEP 文件的绝对路径，不上传原文件到外部服务；清单不要提交到仓库：

```sh
CAD_SMOKE_INVENTORY=/path/to/local-step-inputs.json \
CAD_ENGINE_URL=http://127.0.0.1:9910 \
node scripts/cad-browser-smoke.mjs
```

打开 `http://127.0.0.1:3013/tools/cad-platform.html`，点击“导入 STEP 文件”选择本机非空 `.step` / `.stp`，单文件上限 64 MiB；下方保留输入清单的预置示例。该进程只监听 loopback；页面明确标识测试身份/文件记录/存储。使用实际守卫、PreviewReadService、CAD 控制器、native 转换和实际浮层，不依赖全量构建。

本地导入只注册于 browser 测试夹具，使用 Session/CSRF 守卫、已有有界读流、SHA-256 和临时文件版本记录；生产模块不包含这些登录/导入路由，也不写公司文件库。相同内容复用原路径，否则写入本地专用缓存，正常停止服务后仅删除本进程创建的导入副本，不删除用户原文件。导入件的下载来自浏览器持有的原 File，已比对 SHA；预置示例仍只验证下载回调。公司业务下载的权限链由既有下载服务测试覆盖，此页不能替代公司环境验收。

定向接口测试在 `server` 执行：

```sh
CAD_TEST_ENDPOINT=http://127.0.0.1:9910 CAD_TEST_CONTAINER=libiaolink-cad-cad-1 npm exec -- vitest run \
  --config test/cad.vitest.config.ts \
  test/cad-platform.test.ts test/preview-read.test.ts test/file-download.test.ts
```

没有设置 `CAD_TEST_ENDPOINT` 时 native 测试会跳过；跳过不算通过。原 stdio 的 52 项历史结果不代表沙箱验收；本轮证据见沙箱部署手册。

## 更新独立源码

```sh
python3 server/cad-engine/build-release.py
python3 server/cad-engine/build-release.py --check
```

从 LibiaoLink 根目录运行。Python 唯一源码位于 `core/`，浏览器唯一源码位于 `frontend/public/cad-viewer/core/`；直接在本仓修改并验证，随后生成 `source.json` 与 `cad-release.ts`。源提交只作导入来源记录，发布版本按实际源码、固定依赖及网关内容生成；修改后必须重新生成，`--check` 检查漂移。`source.json` 现在分别记录 `engineDigest`（服务器引擎/运行时）、`viewerDigest`（浏览器）和 `formatVersions.STEP/DXF`；`cad_artifacts.format_version` 只随对应格式的共享/专属源码及依赖变化，浏览器改动不会使任何产物缓存失效。DXF 外参解码读取的 `core/unified/dwg-reader.json` 属于 DXF 格式身份；原生 DWG 适配器 `dwg_adapter.py` 只进入 `engineDigest`。

本机多格式工作台同样使用上述源码：

```sh
sh server/cad-engine/dev/setup-runtime.sh
sh server/cad-engine/dev/run.sh --check
sh server/cad-engine/dev/run.sh
```

默认地址为 `http://127.0.0.1:8795`，只监听回环地址。要求 Python 3.13；`CAD_SETUP_PYTHON` 可指定解释器。OCP、Gmsh、DXF 分别安装在 `.cad-work/` 下的独立环境；DXF 以 editable 方式加载仓内 ezdxf 1.4.2。工作台的本机样本位于 `.cad-work/research/viewer/samples/`，通过文件选择也可打开其他输入；样本、历史证据、运行缓存与环境不属于公共源码。

定向回归位于 `core/tests/`。STEP 网格测试需设置 `CAD_STEP_MESHER_PYTHON` 指向 mesher 解释器，DXF 回归使用 DXF 解释器；涉及真实文件的检查需要本机样本。DXF v0.14.0 已包含资源、字体、图片/PDF、布局及外参裁剪；无宽度 tab、未用右停靠及字面 `%<` 三项 MTEXT 回归已修复。EASM 继续使用严格统一模型入口，不扩大配置/显示状态的验收范围。


DXF v0.15.0 当前能力如下：

- 字体配套支持 SHX/SHP、TTF/OTF，使用原文件字形及内容摘要；字体族名称只有在输入集合中唯一时才解析。常规/扩展 Big Font 由图纸声明码页选字，支持双字节及显式转义配对；SHX 竖排 TEXT 使用字体声明的双向指令，支持沿竖列的居中、右对齐、Middle、FIT/ALIGNED 以及旋转、镜像；组 73 不按横排规则平移。TrueType/OpenType 竖排样式保留水平字形并使用列对齐规则，列下降量读取 OS/2 typo descender，不用字母 p 的轮廓代替。TTF/OTF 样式附带的 SHX Big Font 按源 CAD 规则忽略，不强制要求上传无用的大字体。SHX/SHP 单份上限 8 MiB，TTF/OTF 单份上限 32 MiB，整组仍为 64 MiB。缺字、缺字体和替代预览均保持 partial。旧式 `gbcbig` 仅在字体内部声明名称与 `0,64,2,0` 头匹配时采用已测的 8 单位高度，未知零高度头不套用该比例。MTEXT 按显式 flow_direction 或 By-style 选择方向；基础顶左竖列保留段落、字号/字宽、倾斜、颜色和 tracking，TTF/OTF 的 flow 3 保留同基线字形及段间距。复杂竖排现复用有界段落/制表字段/分数排版单元，生成九种附着点、分栏与强制换栏、背景/边框、三种分数和装饰线的派生几何；只改变排版轴，不再次旋转已含竖向指令的 SHX 字形。列顺序在 flow 3 下向下推进，反向时向上；TTF/OTF 保留水平字形与同基线段落行为。SHX 与 TTF/OTF 基础段均可混入另一类原字体；复杂布局、混排和固定流宽均记录为待原 CAD 对照的 partial 预览。缺字/解析失败仍拒绝整段派生，不能把半段文字或单独背景当成功。
- 编译 SHX 容器支持 shapes 1.0/1.1、unifont 1.0 的 CRLF/LF 头，按目录边界读取字体定义，度量记录不进入绘图指令解释器；保留原名称、above/below/mode 和 Unicode 编码/嵌入元数据。普通 shapes 的 EOF 尾标可省略；截断、重复编号、多余字节或未声明高度不转换为默认字体。Big Font 的非标准零高度头仍只开放上述已核实的 gbcbig 特例，没有原字体证据时不猜高度。
- 布局使用源闭合多段线、圆、椭圆、样条等裁剪边界，显示离散化与按屏幕重建共用绘制/拾取裁剪链；缺失或非法边界不能退回未裁剪矩形。视口颜色、线型、线宽、透明度遵守 BYLAYER/BYBLOCK 与显式属性规则。
- 普通 INSERT 和上传 DXF/DWG 外参支持多边形、反向及嵌套 XCLIP，保留每个实例变换；宿主 `参照名|图层名` 的图层覆盖继续生效。选定配套版本替换旧缓存内容；缺少配套时保留源缓存并明确未加载。DWG 外参只解码选定原件，源格式/摘要与原句柄保持为 DWG；原生读入和写出报告分别校验，非致命损失不能被成功的 DXF 写出清空。中间 DXF 的失效 HANDSEED 仅推进分配游标，不重编号源对象。DWG 主图、非俯视/透视视口、三维前后裁剪面仍未开放，不使用同名 DXF 替代 DWG。

### 二维补全与源事实（v0.15.0）

源语义通过 `dxf-source-facts/1` 保存原对象属性、源尺寸/样式覆盖、XDATA、字典/关联图、表格/公差原标签、当前动态块状态与文档自定义属性；查看器可按原句柄查看。原 HEADER 和实体属性从同一份已验摘要的源标签解码，底层库修改的创建时间/GUID、图层出图标志及管理字典不当作源声明；匿名句柄、读取修复和标签预算损失明确记录。源事实降级独立于几何覆盖，并进入快照 partial/诊断。源记录、显示派生和工程求解分开。常用 FIELD 的文档属性、已声明变量、对象属性和算术公式采用有界只读求值，源缓存优先并报告冲突；TEXT/ATTRIB/ATTDEF/MTEXT 共用。自定义/应用/时钟相关求值器需源缓存，不执行任意代码或动态块编辑。

MSLTSCALE 与 CANNOSCALE 从原变量字典读取，保存的视口注释比例不由几何缩放冒充。TEXT/MTEXT 使用原注释上下文位置、大小和分栏生成独立派生，并沿 Python/浏览器相同规则选择及处理 ANNOALLVISIBLE；其他上下文类型保留原标签，明确部分支持。代理流补上复合矩阵、表名/表索引、二维裁剪和外参显示迁移，以及字距、装饰和原字体标志。源 TEXT 的 `%%u/%%o/%%k` 按实际范围绘制。

平面 REGION 以 ezdxf 低层 SAT/SAB 图读取全部边及内环，仅开放直线、椭圆、可取得显式控制/权重/结点的样条；非平面、未知程序曲线或不可达边使整项派生失败，不用端点弦或控制多边形替代。渐变的 SHIFT=0/1 采用锁定 truedxf 的连续颜色场。ACAD_TABLE 保存块按原方向、平面与基点放置；没有保存块时不伪造表格。

CTB/STB 经既有 acadctb 解析上传字节，按源页面或手动选择进行屏幕打印预览，支持源 ACI/命名样式、BYLAYER/BYBLOCK/视口颜色继承、颜色/灰度/筛选、纸面线型、线宽及栅格设备填充纹理。源显示所需样式缺失进入 partial；仅用于可选打印预览的缺件不改变普通几何覆盖。该预览不是 PC3/实际打印驱动，菱形端点/连接及设备抖色仍需原 CAD 标定。所有选择仍定位同一源对象。

media 共用放置、透明度、裁剪与拾取：图片亮度/对比度/淡入使用已注明的 ezdxf 屏幕近似；底图支持裁剪、单色及 HLS 对比/淡入。OLE 仅读取一个已存 CF_DIB 内容缓存，不运行 Office。DWF/DWFx 采用锁定 ezdwf 小型读取器，SVG 只作内部派生并由 resvg 栅格化；实际嵌入字形或上传原 TTF/OTF 才可显示，修正社区预览将 Gouraud 简化为平均色及文字边界被裁掉的问题。DGN 仅开放经测试的 V7 二维线、形状、弧/椭圆及开放显式样条；V8、RSC 字体、共享单元、未还原的原生曲线和自定义线型明确缺失。DGN/DWF 读取器尚属早期版本，不把文件读取或支持前缀当完整格式覆盖。配套单份 16 MiB、每幅栅格 8M 像素、整图 32M 像素，仍受输入集合/进程总预算限制。原声明路径不触发磁盘/网络读取，解析器也直接使用已验摘要的同一份主图字节。

新增依赖锁定于 `requirements-dxf.txt`：olefile 0.47、ezdgn 0.3.0、ezdwf 0.0.9、resvg-py 0.5.0；它们不带入社区应用。许可和选择性适配来源见 `core/vendor/underlay-readers/NOTICE`、`core/vendor/truedxf-display/NOTICE`。原 CAD 精度、缺原字体/底图与未覆盖专有程序曲线需要相应源资源/对照证据，不能靠标记 complete 消除。

### 宽多段线、复杂线型与代理图形（v0.14.0）

按本项目 UCD 和输入集合契约使用已锁定 ezdxf 的 TraceBuilder，未整体引入社区应用或新增依赖。源多段线保留每段起止宽度，恒宽/变宽、闭合及 bulge 圆弧的派生宽带与零宽线段复用已有显示、拾取、块变换和裁剪链路；相交宽带按非零绕组填充，显示离散化与按屏幕重建均使用同一份有界面片。派生顶点计入既有一百万顶点预算，失败时整项明确缺失，不退回中心线后标为完整。TRACE 接入 SOLID 填充路径，两者使用库提供的原顶点顺序及 OCS 高度，不把源 Z 清零。

非连续宽带按源段的实际弧长切分、插值宽度，复用 TraceBuilder 处理跨顶点的连接；PLINEGEN 决定相位是否跨顶点。选择性改写 truedxf 锁定版本的 A 型端点拟合、短段连续、闭合周期、元素末端定位和直立文字规则，来源与 MIT 许可见 `core/vendor/truedxf-display/NOTICE`。块缩放只改变源几何宽度，不直接缩放虚线周期或文字/形状；非等比缩放曲线采用有界弧长度量。PSLTSCALE=1 按纸面长度生成视口变体，=0 保留模型长度。最终 BYLAYER/BYBLOCK/视口覆盖解析后，两个投影器选择同一份有界线型变体，源实例身份和拾取关系保持不变。复杂线型读取原 LTYPE 文字/形状、比例、偏移及组 50 的度数旋转及直立文字标志；文字和编号形状复用上传 SHX/SHP/TTF/OTF 字形，未使用的线型不请求资源。缺少原字体或派生失败仅拒绝对应线型变体，记录 `linetype-presentation-failed`，不会将虚线画成实心带。

ACAD_PROXY_ENTITY 使用仓内 ProxyGraphic 解码已有显示指令，生成共享派生图元并保留原对象身份。解码前核对全部指令的边界、类型、矩阵栈及数量；缺失代理流、未知指令或解码器无实现的指令使整项显示缺失，不发布有效前缀。代理流只是原应用储存的显示内容，不恢复其领域语义。三维视口和工程尺寸依据仍按既有范围。回归入口为 `test_wide_polylines.py`、`test_linetype_presentations.py`、`test_proxy_graphics.py`；合成回归及浏览器检查不能替代原 CAD 对照。

### 二维归属与可见范围（v0.12.0）

属性文字的源坐标已位于所属 INSERT 的 owner-space，但仍归属于该实例。UCD 2.0 通过 `Annotation.ownerBlockInstanceId` 保留此关系；两个投影器按实例一起展开块内容和属性，属性仅追加阵列偏移及外层变换，不再次乘所属块的 `localFromBlock`。BYBLOCK、父块隐藏、父层开关、视口和逐阵列裁剪沿同一继承链解析，替代原先零散的属性图层/裁剪提示。阵列偏移先在 OCS 中旋转，再进入 owner-space，不应用块缩放；零间距维度仅绘制一个位置。

普通、恢复和外参读取统一在源标签边界拒绝非有限数字，文本中的字面 NaN 不受影响；无效配套数据保留外参失败说明，主图不生成伪造坐标。浏览器用同一裁剪区域产生可见线段、凸填充片段和轮廓范围，绘制继续对原路径施加该区域以保留虚线相位；拾取、适应视图与定位选中使用可见结果，不再用包围盒相交代替实际裁剪。孔洞、非凸、反向及嵌套区域沿此规则处理；有普通裁剪边界的无限线也获得有限可见范围。三维裁剪仍拒绝。

回归入口：`core/tests/dxf/test_ownership.py`、`core/tests/drawing-clipping.test.mjs`，与原字体/布局/外参测试一起运行。合成几何与浏览器检查验证这些规则，不替代原 CAD 或公司原件验收；反向 XCLIP 的 ezdxf 合成文件含上游兼容警告，只用于查看器契约验证。原有复杂竖排依旧保留 partial 口径。

## 部署边界

持久化与预解析已在公司测试机和正式生产部署，正式生产于 2026-10-26 完成 API/worker Unix socket 接线；完整部署状态见[接入基线](../../docs/CAD平台接入基线与迁移任务.md) §10。native runtime 已从 API 移到独立 glibc CAD 镜像，API 的 768 MiB 预算不包含 CAD；启用须叠加独立沙箱部署件并取得实际镜像 digest。API 无受限外的 Python 回退；测试与迁移见 [部署手册](../../deploy/cad/README.md)。

既有公司环境开放 STEP；本地已接入 DXF 平台入口和上传配套资源，需协调部署后才能扩大公司环境范围。EASM 平台入口与工程测量不在本轮范围。S03 继续明确失败。大文件耗时沿用实测口径，P01 既有独立结果约 71.8 秒，不能称为秒开，本轮未重复测量它。


二维合成回归单独使用 DXF 环境，避免 OCP 单测发现时误加载另一套原生依赖：

```sh
.cad-work/dxf/bin/python -m unittest discover -s server/cad-engine/core/tests/dxf -p 'test_*.py'
```

它覆盖 MTEXT 三项回归、真实隔离作业的部分产物/缓存完整性与空白图纸拒绝；外参、字体和媒体的原始样本验证需要本机研究输入，可用 `CAD_TEST_DATA` 指向专用验证副本，避免覆盖冻结证据。

### DWG 外参运行依赖

独立 CLI 固定为 GNU LibreDWG **0.13.3**，来源与 SHA256 见 `core/unified/dwg-reader.json`。使用已安装并验证的本机版本，未随功能开发升级依赖；长期授权 SDK 路线未据此撤回。原生任务以 `CAD_DWG_READER` 配置可执行文件，未配置时查找 `dwgread`；版本不符或缺失时保留明确的未加载原因，普通 DXF 不要求该 CLI。每份 DWG 解码共用 15 秒上限，中间 DXF 上限 128 MiB，单份诊断上限 8 MiB，并受外层 60 秒作业及既有容器硬限额约束；取消仍终止整个工作进程组。

CLI 是独立 GPL-3.0-or-later 程序，未链接进 Python 解释器。镜像构建阶段校验固定源码包并编译，运行层同时携带 COPYING、对应源码包和构建脚本；不携带编译器。不能用本机装有 CLI 代替目标镜像更新，也不表示公司环境已支持 DWG 外参。

竖排对齐和已知 `gbcbig` 度量采用[固定 truedxf 上游的 AutoCAD 探针记录](https://github.com/tth05/truedxf/blob/019c2e504738965c17818a5780097fef0e7a52f4/research/notes/04-text-fonts.md#11-autocad-2027-plot-findings-for-text--mtext--attrib-2026-09-30)；MTEXT 方向、附着点定义按 [Autodesk DXF 说明](https://help.autodesk.com/cloudhelp/2026/ENU/AutoCAD-DXF/files/GUID-5E5DB93B-F8D3-4433-ADF7-E92E250D2BAB.htm)。这些资料不等于本项目已做原 AutoCAD 像素验收。

编译容器差异参考[固定 truedxf SHX 解析器](https://github.com/tth05/truedxf/blob/019c2e504738965c17818a5780097fef0e7a52f4/packages/fonts/src/shx/parse.ts)；flow 3 的分栏推进方向参考 [Autodesk setColumnFlowReversed](https://help.autodesk.com/cloudhelp/2019/ENU/OARX-RefGuide/files/OREF-AcDbMText__setColumnFlowReversed_bool.html)。复杂竖排的单元测试和浏览器检查验证本项目排版/显示契约，不能替代源 CAD 对照，因此 `org.cad-preview.dxf-mtext/1` v1.1 独立记录 `verticalLayout`、`layoutWarnings` 与 `approximateLayouts`。


## DWG 主图原生接入（2026-10-28 第一片）

原生 ACadSharp → UCD 链路已加入平台代码：shared 格式 `DWG`、迁移 `0070`、API 输入/预览/任务/仓库和 `core/dwg_platform_convert.py` 已接线，但 `CAD_DWG_ENABLED` 默认关闭，当前只在本机完成 worker 样本验证，未在 Linux 沙箱调度、未部署公司测试机或生产。DWG 没有配套文件/主图相对路径，结果始终是带明确损失说明的 `partial`；需要 `CAD_DWG_PYTHON`、`CAD_DWG_READER`、`CAD_DWG_DOTNET` 和固定 ACadSharp 读取器，缺少时明确失败，不回退 DXF。构建、读取协议、源账本及已知限制见 [dwg-reader/README.md](dwg-reader/README.md)，交接状态见 [DWG_HANDOFF.md](DWG_HANDOFF.md)。正式大图的约 2.7 GiB 托管内存和约 266 MB manifest 尚未在目标沙箱验证；首版平台预算为 3 GiB worker RSS / 512 MiB 产物，不构成生产容量承诺。

### 二维混合绘制与后台重绘（2026-10-31）

查看器统一采用混合方案，不向用户提供原版切换，旧 renderer 参数不再控制绘制方式。具备后台绘制能力的浏览器在保留实例路径中使用 WebGL2 实线绘制与 Worker/OffscreenCanvas 清晰重绘，其余复杂对象继续执行现有 Canvas 指令；浏览器能力不足时自动使用兼容流程。

字体、字形、文字排版、布局、裁剪、图层和拾取规则仍由同一查看器生成。新操作会取消旧视角任务；清晰帧生成期间保留可交互预览，完成后一次替换。初次载入、显式同步重绘和普通小图路径不扩大优化承诺。图层重建或查看器销毁时释放后台资源。

后台文件位于 core/gpu/，Worker 使用相对模块 URL；主线程与 Worker 共用 GPU 实线实现，不依赖本机实验目录。开发入口 dev/dwg-local.py 同时提供 /core/、/fonts/、/platform.css 和 /import-assembly.svg，避免缺失字体样式或加载图标触发页面资源异常。

本机已完成真实图交互、字体/显示样本和移除切换后的运行验证；详细性能记录、截图及原始图纸只保存在本机，不随代码提交。既有 partial 能力与抗锯齿/图片采样差异保持，未进行部署。引擎及格式版本不变，仅更新查看器身份。

### DWG 结构校验加速（本地接入，未部署）

DWG 的 UCD 2.0 envelope 使用固定 `jsonschema-rs==0.60.3` 编译校验；工作进程和网关发布进程均需安装该依赖，分别由 `requirements-dxf.txt` / `requirements-dwg.txt` 与 `requirements-step.txt` 固定。DXF 继续使用原校验入口。STEP 的大模型（至少 2048 个绘制项）复用同一原生结构校验；小模型保留原路径，避免原生库首次加载成本超过校验收益。该结构校验优化不改变网格精度、装配树、颜色、名称解码及缺面拒绝规则；本次 OCCT 升级与曲面修补策略见下节。原生校验仅解析内置 schema，并禁用外部引用获取；保留严格整数、Python 正则、未知事实及扩展数据非有限数规则，拒绝输入时沿用原错误定位。几何、引用、缓冲区完整性、canonical 摘要、进程及容器资源限制均继续执行，字体和绘制代码未改变。性能与真实图纸对照明细仅保存在本机。

### STEP 圆锥曲面修补与任务内复用（本地接入，未部署）

修补策略升级为 `step-combined-repair/3`。独立网格器产生的圆锥面采用逐三角形连续参数图处理周期接缝和尖点，验证等价参数不移动源点；用 OCCT 的缝合边/退化边标记及源顶点拓扑识别真实边界环，不把参数缝当作外轮廓，不按坐标近似合并孔洞。其余曲面沿用原有校验。双向边界、裁剪域、绕序、Float32 和双精度面积、逐三角形采样误差检查继续执行，0.08mm 门槛和原有微小面策略不变；这些仍是显示采样约束，不构成加工精度证明。

每个转换任务最多缓存 16MiB 已接受的原始网格 JSON；键包含固定网格引擎、修补策略、源 BRep 摘要、尺寸和算法。同一任务重复曲面可复用原始网格，但每次仍核验源摘要/引擎并对当前面完整检查。失败结果不缓存，不跨任务复用，文档时间预算和子进程资源限制不放宽。带孔、裁剪、反向/位移和缓存预算拒绝路径纳入专项回归；真实图纸、截图及性能明细只保留本机。


### STEP 曲面修补尺寸与内核升级

STEP 固定使用 cadquery-ocp 7.9.3.1.1、同版本 proxy 和 vtk 9.6.2；运行时同时核验包版本和 OCP 绑定版本 7.9.3.1，网关发布身份与缓存版本同步更新。该内核包含退化环面缺失接缝导致导入区域反向的上游修复（OCCT #699）。独立 Gmsh 进程继续使用固定版本，不与 OCP 混装。

非微小修补面先按源面积选择候选边长，再细化，失败仍尝试原有尺寸。候选边长与显示误差上限分开：0.08mm 原面/网格采样、边界、裁剪、绕序及面积规则不放宽；微小面策略、16MiB 任务内缓存、进程内存/时间和文档预算不变。直接分片候选未通过校验，未接入。

升级验证使用本机真实文件集和带孔、偏置、反向等控制样本，包含名称编码、颜色透明度、装配关系及查看器操作对照；原始文件、截图、性能明细和研究记录不进入仓库。此变更不授权部署。

### DWG 校验内存峰值

对仅包含对象类型和逐条记录约束的大表，结构校验按最多 1024 条分批执行；完整 envelope 结构与跨表引用、摘要、几何和资源预算仍检查原始文档。分批仅适用于无全表约束的 schema，不拆分数组或带其他约束的对象。DWG 几何缓冲区完成构造后固定为只读 bytes，校验和发布复用同一份内容；顶点和索引检查使用共享类型视图，避免整块复制。未调整进程/容器配额、字体或绘制逻辑；真实图纸和性能对照仅保留本机。

### DWG 块定位、填充与渐变

固定 ACadSharp 版本保持不变；INSERT 在本地映射时按 OCS × 平移 × 旋转 × 缩放 × 负块基点组合，避免非零块基点在旋转或非等比缩放后错位。嵌套与镜像沿用实例矩阵组合，属性文字仍按原有所属空间映射。

HATCH 边界和图案线应用源法向及标高；实心、图案与渐变按 Normal / Outer / Ignore 的轮廓嵌套规则选择填充区域。渐变复用现有九种 Canvas 渐变场和裁剪能力，使用源文件两端颜色、角度、SHIFT 与 OCS 基底；不支持的参数仍记入损失账本，不宣称完整 CAD 渲染等价。边界离散精度、字体处理、混合绘制及资源配额保持原状。

读取器专项自测覆盖非零基点、旋转、非等比缩放、镜像、嵌套、反向法向、填充孔洞与九种渐变；同批真实文件、页面对照及性能明细仅存本机。未部署。
