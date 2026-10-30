# 本地维护的 ezdxf 1.4.2

本目录保存官方源码发行包的运行源码，供本项目直接使用和二次开发。

- 上游：[mozman/ezdxf](https://github.com/mozman/ezdxf/tree/v1.4.2)。
- 发行包：[ezdxf-1.4.2.tar.gz](https://files.pythonhosted.org/packages/64/11/eb27e779a550033972ece48de313be6cff8f537963dfce04778b25543788/ezdxf-1.4.2.tar.gz)。
- 发行包 SHA256：`1fb8edf5bc10dbd83f61f56f2058af4296cd8d817307dae2cbd7be9d665bf726`，与 [PyPI 1.4.2 文件页](https://pypi.org/project/ezdxf/1.4.2/#files) 核对。
- 许可：原始 [LICENSE](LICENSE)，MIT；各源码文件的版权与许可说明保留。

## 导入范围

保留完整 `src/ezdxf`：Python 模块、Cython 源码、类型标记、头文件和资源图片；同时保留上游 README、setup、pyproject、MANIFEST、requirements。运行源码 371 个文件，共 5,172,395 bytes。

没有导入上游 tests、integration_tests、数据样例、生成的 PKG-INFO/egg-info，也不保存 Git 历史。Cython 自动生成的 `.c`、本机 `.so/.pyd`、构建目录和 Python 缓存不进版本库；加速模块由本机从已保存的 `.pyx` 构建。

初始导入没有改动任何 `src/ezdxf` 文件。唯一上游文件修改是 `pyproject.toml` 的许可证文件名：`LICENCE` 改为发行包实际携带的 `LICENSE`，使本地安装能找到许可证。后续修改上游代码时，在本节登记修改及对应回归；项目适配逻辑仍放在 `unified/`。

## 安装和加载

在仓库根目录执行：

```sh
sh server/cad-engine/dev/setup-runtime.sh dxf
sh server/cad-engine/dev/run.sh --check
sh server/cad-engine/dev/run.sh
```

脚本安装固定构建工具和本目录的可编辑依赖，不安装 Qt、Matplotlib 等桌面绘图附加组件。Python 代码从 `src/ezdxf` 直接加载；修改 Python 后重启服务即可生效。修改 Cython 源码后需重新运行安装脚本，再重启服务。C 扩展需要本机 C/C++ 编译器；上游允许缺少扩展时使用 Python 实现，是否启用会在安装检查中显示。

DXF adapter 会检查实际导入路径，避免误用另一份同版本 pip 包。源码摘要进入产物规则哈希和服务缓存身份；服务与导入模块一样，在进程启动后固定该摘要，改源码后必须重启。

当前导入不等于新增显示能力。引线、尺寸与文字的后续接入，按 [开源复用计划](../../../docs/dxf-open-source-reuse/RESULTS.md) 执行。

## 2026-10-26 排版修复

`tools/text_layout.py` 的 Paragraph 新增默认关闭的 `align_tab_fields`；CAD MTEXT 适配器启用后，在当前行实际选择停靠点，再对中/右字段整体定位。左字段沿用逐词换行，未命中的其他停靠点不改变它的语义。对应回归为 `core/tests/dxf/test_mtext_regressions.py` 的五个最小反例与坐标/换行检查。上游原许可和来源保留。
