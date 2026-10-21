# translate 模块（内容译文库 · §6.16 ㉕ ㉖ · Push 301 / 309 · px）

| 项 | 口径 |
|---|---|
| 类型 | 横切模块（crosscut；已登记 `server/scripts/check-boundaries.mjs` 的 `CROSSCUT_MODULES`） |
| 契约 | `shared/src/modules/translate.ts`（POST /api/v1/translate · POST /api/v1/translate/batch） |
| 数据 | `content_translations`（迁移 0047；键 = source_lang + target_lang + sha256(source_text)，source_text = 原文） |
| 通道 | `TRANSLATE_PROVIDER=openai` = OpenAI 兼容 API（`TRANSLATE_API_BASE_URL` / `TRANSLATE_API_MODEL` / `TRANSLATE_API_KEY`，公司 New API 网关；Push 309 起默认接入）；`local` = 本地 / 内网引擎（`TRANSLATE_ORIGIN`，默认 `http://127.0.0.1:5008`）；`TRANSLATE_FALLBACK_ORIGIN`（可选）= 主通道失败时的本地兜底 |
| 文本加工 | `translate.text.ts`：术语保护 / 回换（11 条词表）+ 整句全大写规整 + 句首大写规整（Push 311：小写开头 → 首字母大写；iPhone / eBay / pH 类品牌词形态不误伤）—— 原前端 translateApi.ts 逻辑内聚到服务端 |
| 前端 | `frontend/src/translateApi.ts`（会话缓存 L1；服务端译文库 L2；单条 L3）+ 保存链路预热挂点（task / project 控制器） |

## 行为

- **单条**：库命中直出；未命中调翻译通道 → 规整 + 术语回换 → upsert 落库 → 返回最终英文（通道不可用 = 500 INTERNAL，前端静默降级跳过）。
- **批量**：只读查库（不调通道），一次拿整页已存译文（英文界面切页提速）；未命中条目由前端走单条通道。
- **预热（保存即后台翻译）**：任务（中文标题 / 进展描述 note）与项目（名称 / 描述 / 客户）写入成功后被丢进 `warmup`；
  后台去重（同文本 5 分钟窗口）+ 并发 2 静默翻好落库，从不抛错、不阻塞保存响应。

## 通道（Push 309/310 · provider 可插拔）

- **openai（API 主通道）**：`POST {TRANSLATE_API_BASE_URL}/chat/completions`，`temperature=0`，system prompt 约束「只出译文、占位符 / 数字 / 专名原样」；回包取 `choices[0].message.content`（去首尾成对引号）。
- **主模型 → 备用模型接力（Push 310）**：`TRANSLATE_API_MODEL`（主，如 `deepseek-v4-flash-vision-exp`）失败（网络 / HTTP / 解析）时，`TRANSLATE_API_MODEL_FALLBACK` 非空且与主不同名 → warn 日志 + 自动改调备用模型（如 `gemini-3.8-flash`）；落库 engine 按**实际产出模型**标记（`api:<模型>`，换模型可批量重翻）。
- **local（本地引擎）**：LibreTranslate 兼容 `POST {TRANSLATE_ORIGIN}/translate`；本机验证形态 = HY-MT1.5-1.8B（llama.cpp + 薄壳 5008）。**方案保留、暂不部署**。
- **兜底**：`TRANSLATE_FALLBACK_ORIGIN` 非空时，openai 通道（主 + 备用两跳皆败）失败自动改调该本地引擎（落库 engine 标记按实际产出通道：`api:<模型>` / `hy-mt-1.5-1.8b`）。
- 密钥纪律：`TRANSLATE_API_KEY` 由 `deploy/prod/secrets/translate_api_key` 经入口注入（不进仓库 / 不进 .env；CONTRIBUTING §12）。

## 键口径（重要）

- `q` = **原文**（所有通路统一：前端单条 / 批量查库 / 保存链路预热）—— 术语保护 / 回换 / 规整只在服务端做一次；
- 换引擎 / 提质量：按 engine 列可批量重翻（切 API 后存量行仍是旧 engine 标记，可按需重翻，旧行自然被覆盖）。

## 与前端旧口径的差异（Push 301 内变更）

- 旧：前端把术语换成 Xq…Y 占位符后 q 发引擎，落库键 = sha256(占位符文本)；开发环境 Vite 特例代理直连 5008。
- 新：q 一律原文、键 = sha256(原文)；前端只与 /api/v1/translate（服务端）对话（Vite 特例代理已删除）。
- 原因：保存链路预热在服务端进行、不经过前端 —— 保护留在前端会出现「同一原文两种键互相命中不了」且预热译文漏保护。

## 验证

- `server/test/translate.test.ts`（单测 22 例：库优先短路 / 未命中落库 / 术语保护与回换 / 引擎失败 INTERNAL / 批量只读 / 预热去重与静默 / Push 309：openai 通道落库 + 兜底回落 + 未配置 INTERNAL / Push 310：主模型失败接力备用（落库 engine 按实际产出模型）+ 主成功不接力 + 两跳皆败 INTERNAL + 备用留空或同名不接力 + 两跳皆败回落本地引擎 / Push 311：小写开头 → 句首大写（品牌词不误伤 / 幂等 / 占位符小写化仍回换））；
- 真机：`node node_modules/vitest/vitest.mjs run` 全绿（73 文件 / 1058 例）+ `npm run typecheck` / `npm run build` + `check:boundaries` 全绿（247 文件 / 1087 依赖 / 0 违规）。
