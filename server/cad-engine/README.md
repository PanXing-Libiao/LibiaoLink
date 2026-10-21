# STEP 平台运行与源码更新

本地已跑通文件版本 → SHA/bytes 核对 → 持久任务 → 完整产物 → 鉴权 manifest/buffers → ViewerSession。固定独立源码见 `source.json`，STEP v0.3.3 几何基线仍为 `0911573`，宿主适配为 `5707e1d`。宿主不重写解析、补面或接收政策。结果见 [逐文件表](../../docs/cad-platform-integration/RESULTS.md)。

## 准备运行环境

本轮验证环境为 macOS arm64、Python 3.13、Node 24。复用已有 OCP/Gmsh 环境即可，不要为每个工作区复制 native 库。新机器可在本目录单独创建两套环境：

```sh
python3.13 -m venv .runtime/ocp
.runtime/ocp/bin/python -m pip install -r requirements-step.txt
python3.13 -m venv .runtime/mesher
.runtime/mesher/bin/python -m pip install -r requirements-step-mesher.txt
```

这两套环境不能混装。OCP 负责原链路，Gmsh 子进程只用于既有失败面路线；完整能力部署应配置两者。虚拟环境、样本和缓存均不进 Git。上述新环境安装本轮没有重复执行，实际测试使用已有的相同固定版本环境。

API 启动前设置以下非敏感运行参数，解释器使用部署机器内的绝对路径：

| 参数 | 含义 |
| --- | --- |
| `CAD_ENGINE_PYTHON` | OCP Python；空值表示不开放 CAD |
| `CAD_MESHER_PYTHON` | 独立 Gmsh Python，保留现有组合补面路线 |
| `CAD_CACHE_DIR` | 可写专用缓存，默认相对 server 工作目录的 `var/cad` |
| `CAD_MAX_INPUT_MIB` | 默认 64，显式可配至 256；大小上限不是完成保证 |

浏览器使用 HTTPS；本地 loopback 也可验证 Web Crypto。生产打包须同时包含 `server/cad-engine/`、新 server/shared 构建产物和同版本 `/cad-viewer/` 静态资源。引擎未启用时，主 API 不读取 native 文件或启动 Python；不要在只更新 server/dist 的旧部署方式中意外启用 CAD。

固定任务预算：1 个转换并发、最多 8 个排队、单 worker 600 秒、队列 900 秒、worker RSS 2 GiB 采样停止阈值、缓存 24 小时。Node 暂时完整读取原对象，gateway/浏览器也有清单开销；worker RSS 不等于整机内存。为 API 加 native runtime 需预留至少 4 GiB 可用内存，再据真实文件实测调整；这不是 128 MiB 文件的完成承诺。

缓存只保存到 `CAD_CACHE_DIR`。转换中的文件不要手工删除；停止 API/gateway 后可以整体删除该目录重建，原平台文件不在其中。几何 CAS 按内容去重，窗口命名空间只控制任务归属。每次新开窗口当前仍会重新转换，尚未实现跨窗口产物复用。

中文零件名乱码时，在“模型信息”把“零件名称编码”切换为“中文旧编码”并重新读取。默认标准 UTF8；旧中文使用 OCCT 官方 GB，不自动猜编码。选择在当前标签页按文件版本记忆，并传入任务参数 `nameCodepage`；不同码页隔离缓存，检查记录保留本次选择。源文件无需修改。

查看器已同步相机范围修复：定位小零件后，缩放仍保留整机范围，裁切面随镜头更新。详见独立工程 `docs/step-0.3/focus-camera/README.md`；几何与解析策略沿用此前版本。

## 本地可复现页面

在安装现有 server/frontend/shared Node 依赖后，在 `server` 执行。输入清单是本地 JSON 数组，每一项为 STEP 文件的绝对路径，不上传原文件到外部服务；清单不要提交到仓库：

```sh
CAD_SMOKE_INVENTORY=/path/to/local-step-inputs.json \
CAD_ENGINE_PYTHON=/path/to/ocp/bin/python \
CAD_MESHER_PYTHON=/path/to/mesher/bin/python \
node scripts/cad-browser-smoke.mjs
```

打开 `http://127.0.0.1:3013/tools/cad-platform.html`，点击“导入 STEP 文件”选择本机非空 `.step` / `.stp`，单文件上限 64 MiB；下方保留输入清单的预置示例。该进程只监听 loopback；页面明确标识测试身份/文件记录/存储。使用实际守卫、PreviewReadService、CAD 控制器、native 转换和实际浮层，不依赖全量构建。

本地导入只注册于 browser 测试夹具，使用 Session/CSRF 守卫、已有有界读流、SHA-256 和临时文件版本记录；生产模块不包含这些登录/导入路由，也不写公司文件库。相同内容复用原路径，否则写入本地专用缓存，正常停止服务后仅删除本进程创建的导入副本，不删除用户原文件。导入件的下载来自浏览器持有的原 File，已比对 SHA；预置示例仍只验证下载回调。公司业务下载的权限链由既有下载服务测试覆盖，此页不能替代公司环境验收。

定向接口测试在 `server` 执行：

```sh
CAD_TEST_PYTHON=/path/to/ocp/bin/python npm exec -- vitest run \
  --config test/cad.vitest.config.ts \
  test/cad-platform.test.ts test/preview-read.test.ts test/file-download.test.ts
```

没有设置 `CAD_TEST_PYTHON` 时 native 测试会跳过；跳过不算通过。本轮设置后 52 项通过。

## 更新独立源码

```sh
python3 server/cad-engine/sync-source.py /path/to/CAD-source EXACT_COMMIT
```

从 LibiaoLink 根目录运行。只复制 Git 中固定提交的源码、schema、固定依赖清单与 Three.js MIT 许可证，生成 `source.json` 和 `cad-release.ts`；不复制样本、图像、运行环境或缓存。正式更新仍先在独立工程完成 CAD 规则修改与验证，随后同步整组文件。

## 部署边界

本轮未部署、未验证公司 SSO/真实数据库/S3 链路。现有生产 Node Alpine 镜像和 768 MiB API 预算尚不具备这里的 Python/native 环境；正式发布需准备兼容 glibc 的 runtime、资源限额及进程隔离，并在公司测试环境验收。stdio 子进程不携带业务凭据，但不是操作系统沙箱。

仅开放 STEP；外部引用、多文件资源解析、EASM/DXF 平台入口与工程测量不在本轮范围。S03 继续明确失败。大文件耗时沿用实测口径，P01 既有独立结果约 71.8 秒，不能称为秒开，本轮未重复测量它。
